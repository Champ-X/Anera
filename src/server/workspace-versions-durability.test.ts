import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from './session-store.js'
import { WorkspaceVersionService, type WorkspaceVersionAgent } from './workspace-versions.js'

const faults = vi.hoisted(() => ({ syncPathSuffix: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      if (faults.syncPathSuffix && String(args[0]).endsWith(faults.syncPathSuffix)) {
        throw Object.assign(new Error('Injected durability failure'), { code: 'EIO' })
      }
      return sync()
    }
    return handle
  } }
})

const roots: string[] = []
afterEach(async () => {
  faults.syncPathSuffix = ''
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-version-durability-'))
  roots.push(root)
  const store = new SessionStore(root, 'test-model')
  await store.initialize()
  const sessionId = (await store.create()).summary.id
  const agent: WorkspaceVersionAgent = {
    withWorkspaceVersionLock: async (_id, operation) => operation(),
    stopWorkspaceResources: async () => {},
    workspaceVersionRestored: async () => {},
  }
  return { store, sessionId, agent, workspace: store.workspaceDir(sessionId), service: new WorkspaceVersionService(store, agent) }
}

describe('workspace version durability before acknowledgement', () => {
  it('does not publish a snapshot if nested empty directory entries cannot be made durable', async () => {
    const f = await fixture()
    await mkdir(resolve(f.workspace, 'empty/nested'), { recursive: true })
    faults.syncPathSuffix = '/files/empty/nested'
    await expect(f.service.captureManual(f.sessionId)).rejects.toThrow('Injected durability failure')
    expect((await f.service.list(f.sessionId)).versions).toEqual([])
    expect((await f.store.events(f.sessionId)).some((event) => event.type === 'workspace.version.created')).toBe(false)
    expect(await readdir(resolve(f.workspace, 'empty'))).toEqual(['nested'])
  })

  it('does not swap workspaces if a preserved runtime file cannot be made durable', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'report.txt'), 'saved')
    const saved = await f.service.captureManual(f.sessionId)
    await writeFile(resolve(f.workspace, 'report.txt'), 'current')
    await mkdir(resolve(f.workspace, 'node_modules'))
    await writeFile(resolve(f.workspace, 'node_modules/runtime.txt'), 'private live runtime')
    faults.syncPathSuffix = '/next/node_modules/runtime.txt'
    await expect(f.service.restore(f.sessionId, saved.id)).rejects.toThrow('Injected durability failure')
    expect(await readFile(resolve(f.workspace, 'report.txt'), 'utf8')).toBe('current')
    expect(await readFile(resolve(f.workspace, 'node_modules/runtime.txt'), 'utf8')).toBe('private live runtime')
    await expect(readFile(resolve(f.store.sessionDir(f.sessionId), 'workspace-versions/restore.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a recoverable transaction when flushing the original workspace rename fails', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'report.txt'), 'saved')
    const saved = await f.service.captureManual(f.sessionId)
    await writeFile(resolve(f.workspace, 'report.txt'), 'current')
    const journalPath = resolve(f.store.sessionDir(f.sessionId), 'workspace-versions/restore.json')
    const interrupted = new WorkspaceVersionService(f.store, f.agent, {
      onRestorePhase: async (phase) => {
        if (phase === 'prepared') {
          const journal = JSON.parse(await readFile(journalPath, 'utf8'))
          faults.syncPathSuffix = `/${journal.restoreId}`
        }
      },
    })
    await expect(interrupted.restore(f.sessionId, saved.id)).rejects.toThrow('Injected durability failure')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    const transaction = resolve(f.store.sessionDir(f.sessionId), 'workspace-versions', journal.restoreId)
    expect(await readFile(resolve(transaction, 'previous/report.txt'), 'utf8')).toBe('current')
    expect(await readFile(resolve(transaction, 'next/report.txt'), 'utf8')).toBe('saved')
    faults.syncPathSuffix = ''
    await f.service.recover(f.sessionId)
    expect(await readFile(resolve(f.workspace, 'report.txt'), 'utf8')).toBe('saved')
    await expect(readFile(journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
