import type { SessionStore } from './session-store.js'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assertNoSymlinkTraversal } from './workspace.js'

// HTTP uploads/restarts do not own an Agent run. Serialize their local workspace
// effects with snapshots/restores without changing whether uploads are allowed
// during a running task. Entries are removed when the queue drains.
const queues = new Map<string, Promise<unknown>>()

export function withWorkspaceMaintenance<T>(
  store: Pick<SessionStore, 'sessionDir'>,
  sessionId: string,
  operation: () => Promise<T>,
  options: { allowPendingRestore?: boolean } = {},
): Promise<T> {
  const key = store.sessionDir(sessionId)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    await assertNoSymlinkTraversal(key, resolve(key, 'workspace-versions', 'restore.json'))
    // A failed restore retains its journal. Queued HTTP work must not create a
    // new workspace in a temporarily missing path or modify an unsettled tree.
    if (!options.allowPendingRestore) {
      try {
        await lstat(resolve(key, 'workspace-versions', 'restore.json'))
        throw Object.assign(new Error('Workspace recovery is pending; finish the restore before changing workspace files or restarting previews.'), { statusCode: 409 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return operation()
  })
  queues.set(key, next)
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => undefined)
  return next
}
