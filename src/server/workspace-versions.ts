import { constants } from 'node:fs'
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { Express } from 'express'
import type {
  WorkspaceVersionChange, WorkspaceVersionDiff, WorkspaceVersionFileInfo, WorkspaceVersionList,
  WorkspaceVersionRestoreResult, WorkspaceVersionScope, WorkspaceVersionSummary,
} from '../shared/workspace-versions.js'
import { isWorkspaceSnapshotExcludedPath } from '../shared/workspace-snapshot-policy.js'
import { createId } from './ids.js'
import { findSensitiveValues } from './redaction.js'
import type { SessionStore } from './session-store.js'
import { withWorkspaceMaintenance } from './workspace-maintenance.js'
import { assertNoSymlinkTraversal, resolveWorkspacePath } from './workspace.js'

export const WORKSPACE_VERSION_SCOPE: WorkspaceVersionScope = {
  files: 'saved-workspace',
  excludedPaths: 'dependencies-caches-builds-and-private-runtime-files',
  conversationReverted: false,
  externalSideEffectsReverted: false,
}

interface FileRecord extends WorkspaceVersionFileInfo { path: string }
interface Manifest { format: 1; summary: WorkspaceVersionSummary; files: FileRecord[]; directories: string[] }
interface RestoreJournal { format: 1; restoreId: string; versionId: string; phase: 'prepared' | 'installed' | 'settled' }
export interface CaptureWorkspaceVersionOptions {
  reason: WorkspaceVersionSummary['reason']
  label?: string
  turnId?: string
  /** Exact workspace identity persisted with the accepted terminal outcome. */
  expectedSha256?: string
}
export interface WorkspaceVersionAgent {
  withWorkspaceVersionLock<T>(sessionId: string, operation: () => Promise<T>, options?: { stopProcesses?: boolean }): Promise<T>
  stopWorkspaceResources(sessionId: string): Promise<void>
  workspaceVersionRestored(sessionId: string, version: WorkspaceVersionSummary, restoreId: string): Promise<void>
}
export interface WorkspaceVersionServiceOptions {
  /** Fault-injection boundary used by real-filesystem crash/recovery tests. */
  onRestorePhase?: (phase: 'prepared' | 'workspace_moved' | 'installed' | 'settled') => Promise<void>
  onCapturePhase?: (phase: 'snapshot_installed') => Promise<void>
}

const VERSION_ID = /^wsv_[a-f0-9]{20}$/u
const RESTORE_ID = /^wsr_[a-f0-9]{20}$/u
const HASH = /^[a-f0-9]{64}$/u
const BUSY = new Set(['queued', 'running', 'awaiting_approval', 'awaiting_user', 'cancelling'])
const MAX_TEXT_BYTES = 32_768
const MAX_DIFF_TEXT_BYTES = 262_144

/** Immutable, hash-verified snapshots; restoring never rewinds external side effects or chat history. */
export class WorkspaceVersionService {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly store: SessionStore, private readonly agent: WorkspaceVersionAgent,
    private readonly options: WorkspaceVersionServiceOptions = {}) {}

  private root(sessionId: string): string { return resolve(this.store.sessionDir(sessionId), 'workspace-versions') }
  private versionDir(sessionId: string, versionId: string): string {
    if (!VERSION_ID.test(versionId)) throw versionError('Invalid workspace version ID', 400)
    return resolve(this.root(sessionId), versionId)
  }

  /** For delivery capture the caller already owns the active run; manual capture uses the admission lock. */
  capture(sessionId: string, options: CaptureWorkspaceVersionOptions): Promise<WorkspaceVersionSummary> {
    return withWorkspaceMaintenance(this.store, sessionId, () => this.serial(sessionId, () => this.captureUnlocked(sessionId, options)))
  }

  async captureManual(sessionId: string, label?: string): Promise<WorkspaceVersionSummary> {
    return this.agent.withWorkspaceVersionLock(sessionId, async () => {
      await this.assertIdle(sessionId)
      return this.capture(sessionId, { reason: 'manual', label })
    })
  }

  private async captureUnlocked(sessionId: string, options: CaptureWorkspaceVersionOptions): Promise<WorkspaceVersionSummary> {
    const state = await this.store.get(sessionId)
    let expectedSha256 = options.expectedSha256
    if (!expectedSha256 && options.reason === 'delivery' && options.turnId) {
      const pending = state.pendingTerminal?.turnId === options.turnId
        ? state.pendingTerminal.workspacePersistenceEvents?.find((event) => event.type === 'workspace.persistence.completed')?.data.workspaceVersion
        : undefined
      const published = pending ?? (await this.store.events(sessionId)).reverse().find((event) => event.type === 'workspace.persistence.completed' && event.turnId === options.turnId)?.data.workspaceVersion
      if (isRecord(published) && typeof published.sha256 === 'string') expectedSha256 = published.sha256
    }
    if (expectedSha256 !== undefined && !HASH.test(expectedSha256)) throw versionError('Invalid expected workspace version identity', 409)
    if (await exists(resolve(this.root(sessionId), 'restore.json'))) throw versionError('A workspace restore requires recovery before saving a version', 409)
    const label = cleanLabel(options.label)
    const root = this.root(sessionId)
    await mkdir(root, { recursive: true })
    await syncDirectory(dirname(root))
    const id = createId('wsv')
    const staged = resolve(root, `.${id}.staging`)
    await mkdir(resolve(staged, 'files'), { recursive: true })
    try {
      const tree = await collectTree(this.store.workspaceDir(sessionId), resolve(staged, 'files'))
      if (expectedSha256 && treeDigest(tree.files, tree.directories) !== expectedSha256) {
        throw versionError('Workspace changed after the accepted delivery; historical version cannot be reconstructed from current files', 409)
      }
      // A background process must not yield a mixed snapshot. Compare a second traversal.
      const current = await collectTree(this.store.workspaceDir(sessionId))
      if (treeDigest(tree.files, tree.directories) !== treeDigest(current.files, current.directories)) {
        throw versionError('Workspace changed while saving the version; retry after writes have finished', 409)
      }
      const summary: WorkspaceVersionSummary = {
        id, createdAt: new Date().toISOString(), label: label ?? (options.reason === 'delivery' ? '交付版本' : options.reason === 'before_restore' ? '恢复前版本' : '手动保存'),
        reason: options.reason, ...(options.turnId ? { turnId: options.turnId } : {}),
        fileCount: tree.files.length, bytes: tree.files.reduce((total, file) => total + file.bytes, 0),
        sha256: treeDigest(tree.files, tree.directories),
      }
      // A retried delivery callback must not create the same version repeatedly.
      if (options.reason === 'delivery' && options.turnId) {
        const duplicate = (await this.list(sessionId)).versions.find((version) => version.reason === 'delivery' && version.turnId === options.turnId && version.sha256 === summary.sha256)
        if (duplicate) {
          await this.verifiedManifest(sessionId, duplicate.id)
          await this.publishCreated(sessionId, duplicate)
          return duplicate
        }
      }
      const manifest: Manifest = { format: 1, summary, files: tree.files, directories: tree.directories }
      await syncTree(resolve(staged, 'files'), false)
      await durableJson(resolve(staged, 'manifest.json'), manifest)
      await rename(staged, this.versionDir(sessionId, id))
      await syncDirectory(root)
      await this.options.onCapturePhase?.('snapshot_installed')
      await this.publishCreated(sessionId, summary)
      return summary
    } finally { await rm(staged, { recursive: true, force: true }) }
  }

  async list(sessionId: string): Promise<WorkspaceVersionList> {
    await this.store.get(sessionId)
    await assertNoSymlinkTraversal(this.store.sessionDir(sessionId), this.root(sessionId))
    const names = await readdir(this.root(sessionId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const versions: WorkspaceVersionSummary[] = []
    for (const name of names.filter((name) => VERSION_ID.test(name))) versions.push((await this.manifest(sessionId, name)).summary)
    versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    return this.store.redactForDisplay(sessionId, { versions, scope: WORKSPACE_VERSION_SCOPE })
  }

  async diff(sessionId: string, versionId: string, against = 'current'): Promise<WorkspaceVersionDiff> {
    await this.store.get(sessionId)
    const source = await this.verifiedManifest(sessionId, versionId)
    const target = against === 'current' ? await collectTree(this.store.workspaceDir(sessionId)) : await this.verifiedManifest(sessionId, against)
    const before = new Map(source.files.map((file) => [file.path, file]))
    const after = new Map(target.files.map((file) => [file.path, file]))
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
    const changes: WorkspaceVersionChange[] = []
    const previews: { change: WorkspaceVersionChange; side: 'beforeText' | 'afterText'; root: string; entry: FileRecord; limit: number }[] = []
    let textBudget = MAX_DIFF_TEXT_BYTES
    for (const path of paths) {
      const prior = before.get(path)
      const next = after.get(path)
      if (prior?.sha256 === next?.sha256 && prior?.mode === next?.mode) continue
      const change: WorkspaceVersionChange = {
        path, kind: !prior ? 'added' : !next ? 'deleted' : 'modified',
        ...(prior ? { before: fileInfo(prior) } : {}), ...(next ? { after: fileInfo(next) } : {}),
      }
      for (const [side, entry, root] of [
        ['before', prior, resolve(this.versionDir(sessionId, versionId), 'files')],
        ['after', next, against === 'current' ? this.store.workspaceDir(sessionId) : resolve(this.versionDir(sessionId, against), 'files')],
      ] as const) {
        if (!entry) continue
        const bytes = await verifiedRead(root, entry)
        if (bytes.includes(0) || !isUtf8(bytes)) continue
        this.store.registerSensitiveValues(sessionId, findSensitiveValues(bytes.toString('utf8')))
        const limit = Math.min(MAX_TEXT_BYTES, textBudget)
        if (limit > 0 || bytes.length === 0) previews.push({ change, side: side === 'before' ? 'beforeText' : 'afterText', root, entry, limit })
        if (bytes.length > limit) change.textTruncated = true
        textBudget -= Math.min(bytes.length, limit)
      }
      changes.push(change)
    }
    // Learn secrets from both sides before rendering either side. Redacting
    // only an already-truncated string can expose the prefix of a credential.
    // Reread bounded-preview files instead of retaining every full file in RAM.
    for (const { change, side, root, entry, limit } of previews) {
      const bytes = await verifiedRead(root, entry)
      const redacted = this.store.redactTextForDisplay(sessionId, bytes.toString('utf8'))
      change[side] = utf8Prefix(Buffer.from(redacted), limit)
    }
    return this.store.redactForDisplay(sessionId, { fromVersionId: versionId, against, changes,
      added: changes.filter((change) => change.kind === 'added').length,
      modified: changes.filter((change) => change.kind === 'modified').length,
      deleted: changes.filter((change) => change.kind === 'deleted').length, scope: WORKSPACE_VERSION_SCOPE })
  }

  async restore(sessionId: string, versionId: string): Promise<WorkspaceVersionRestoreResult> {
    // Admission precedes the queue: waiting for a completing run while holding
    // maintenance would deadlock that run's delivery capture. Stop resources
    // only after acquiring maintenance, so a queued restart cannot slip between
    // process termination and the directory swap.
    return this.agent.withWorkspaceVersionLock(sessionId, () => withWorkspaceMaintenance(this.store, sessionId, () => this.serial(sessionId, async () => {
      await this.assertIdle(sessionId)
      await this.agent.stopWorkspaceResources(sessionId)
      const pending = await this.readJournal(sessionId)
      if (pending) {
        if (pending.versionId !== versionId) throw versionError('Finish the pending restore before choosing another version', 409)
        return this.finishRestore(sessionId, pending)
      }
      const manifest = await this.verifiedManifest(sessionId, versionId)
      // Always retain the exact pre-restore public files, including additions and deletions.
      await this.captureUnlocked(sessionId, { reason: 'before_restore' })
      const restoreId = createId('wsr')
      const transaction = resolve(this.root(sessionId), restoreId)
      const next = resolve(transaction, 'next')
      await mkdir(next, { recursive: true })
      try {
        for (const path of manifest.directories) await mkdir(resolveWorkspacePath(next, path), { recursive: true })
        for (const file of manifest.files) {
          const bytes = await verifiedRead(resolve(this.versionDir(sessionId, versionId), 'files'), file)
          await writeDurableFile(resolveWorkspacePath(next, file.path), bytes, file.mode)
        }
        // Preserve excluded private/runtime content without following symlinks. Public files are restored exactly.
        await preserveExcluded(this.store.workspaceDir(sessionId), next)
        await verifyTree(next, manifest)
        // Copied runtime data will lose its original tree after settlement.
        // Flush it and all directory entries before committing the swap intent.
        await syncTree(next, true)
        await syncDirectory(transaction)
        const journal: RestoreJournal = { format: 1, restoreId, versionId, phase: 'prepared' }
        await durableJson(resolve(this.root(sessionId), 'restore.json'), journal)
        await this.options.onRestorePhase?.('prepared')
        return await this.finishRestore(sessionId, journal)
      } catch (error) {
        if (!await exists(resolve(this.root(sessionId), 'restore.json'))) await rm(transaction, { recursive: true, force: true })
        throw error
      }
    }), { allowPendingRestore: true }))
  }

  /** Run before exposing the app or accepting model work after restart. Idempotent hook replay is required. */
  async recoverAll(): Promise<void> {
    for (const session of await this.store.list()) {
      let phase = 'restore_recovery'
      try {
        await this.recover(session.id)
        phase = 'delivery_snapshot_recovery'
        await this.recoverDeliveries(session.id)
      } catch (error) {
        // One damaged transaction must not prevent opening the app to retry it.
        // Keep its journal intact; Agent admission and workspace maintenance
        // continue to reject mutations until an explicit retry can settle it.
        const message = this.store.redactTextForDisplay(session.id, error instanceof Error ? error.message : 'Could not recover workspace versions')
        await this.store.appendIfAbsent(session.id, 'workspace.version.failed', {
          reason: phase, message,
        }, (event) => event.type === 'workspace.version.failed' && event.data.reason === phase && event.data.message === message)
      }
    }
  }

  /** Reconcile only terminal-bound snapshot intents, never infer an old version from newer files. */
  async recoverDeliveries(sessionId: string): Promise<void> {
    await withWorkspaceMaintenance(this.store, sessionId, () => this.serial(sessionId, async () => {
      const events = await this.store.events(sessionId)
      const intents = events.filter((event) => event.type === 'workspace.persistence.completed' && event.turnId
        && isRecord(event.data.workspaceVersion) && HASH.test(String(event.data.workspaceVersion.sha256)))
      for (const intent of intents) {
        const turnId = intent.turnId!
        const expectedSha256 = String((intent.data.workspaceVersion as Record<string, unknown>).sha256)
        // A published receipt points to an immutable snapshot. No current-workspace read is needed.
        if (events.some((event) => event.type === 'workspace.version.created' && event.turnId === turnId
          && (event.data.version as WorkspaceVersionSummary | undefined)?.sha256 === expectedSha256)) continue
        try {
          const existing = (await this.list(sessionId)).versions.find((version) => version.reason === 'delivery' && version.turnId === turnId && version.sha256 === expectedSha256)
          if (existing) {
            await this.verifiedManifest(sessionId, existing.id)
            await this.publishCreated(sessionId, existing)
          } else await this.captureUnlocked(sessionId, { reason: 'delivery', turnId, expectedSha256 })
        } catch (error) {
          await this.store.appendIfAbsent(sessionId, 'workspace.version.failed', {
            reason: 'delivery_snapshot_recovery', expectedSha256,
            message: this.store.redactTextForDisplay(sessionId, error instanceof Error ? error.message : 'Could not recover the delivery workspace version'),
          }, (event) => event.type === 'workspace.version.failed' && event.turnId === turnId
            && event.data.reason === 'delivery_snapshot_recovery' && event.data.expectedSha256 === expectedSha256, { turnId })
        }
      }
    }))
  }

  async recover(sessionId: string): Promise<WorkspaceVersionRestoreResult | undefined> {
    return withWorkspaceMaintenance(this.store, sessionId, () => this.serial(sessionId, async () => {
      const journal = await this.readJournal(sessionId)
      if (!journal) return undefined
      await this.agent.stopWorkspaceResources(sessionId)
      return this.finishRestore(sessionId, journal)
    }), { allowPendingRestore: true })
  }

  private async readJournal(sessionId: string): Promise<RestoreJournal | undefined> {
    const path = resolve(this.root(sessionId), 'restore.json')
    if (!await exists(path)) return undefined
    await assertNoSymlinkTraversal(this.store.sessionDir(sessionId), path)
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(value) || value.format !== 1 || !RESTORE_ID.test(String(value.restoreId)) || !VERSION_ID.test(String(value.versionId)) || !['prepared', 'installed', 'settled'].includes(String(value.phase))) {
      throw versionError('Invalid workspace restore journal; retained for recovery', 409)
    }
    return value as unknown as RestoreJournal
  }

  private async finishRestore(sessionId: string, journal: RestoreJournal): Promise<WorkspaceVersionRestoreResult> {
    const root = this.root(sessionId)
    const transaction = resolve(root, journal.restoreId)
    const workspace = this.store.workspaceDir(sessionId)
    const next = resolve(transaction, 'next')
    const previous = resolve(transaction, 'previous')
    // A recovery journal is not proof that its transaction tree still lives
    // inside the session. Validate ancestors before any rename or cleanup.
    for (const path of [next, previous, workspace]) await assertNoSymlinkTraversal(this.store.sessionDir(sessionId), path)
    const manifest = await this.verifiedManifest(sessionId, journal.versionId)
    if (await exists(next)) {
      await verifyTree(next, manifest)
      if (await exists(workspace)) {
        if (await exists(previous)) throw versionError('Ambiguous workspace restore state; retained for recovery', 409)
        await rename(workspace, previous)
        await syncDirectory(transaction)
        await syncDirectory(dirname(workspace))
        await this.options.onRestorePhase?.('workspace_moved')
      } else if (!await exists(previous)) throw versionError('Workspace restore is missing its original workspace', 409)
      await rename(next, workspace)
      await syncDirectory(dirname(workspace))
      await syncDirectory(transaction)
    }
    await verifyTree(workspace, manifest)
    if (journal.phase !== 'settled') {
      journal.phase = 'installed'
      await durableJson(resolve(root, 'restore.json'), journal)
      await this.options.onRestorePhase?.('installed')
      await this.agent.workspaceVersionRestored(sessionId, manifest.summary, journal.restoreId)
      journal.phase = 'settled'
      await durableJson(resolve(root, 'restore.json'), journal)
      await this.options.onRestorePhase?.('settled')
    }
    // Keep the journal until the semantic hook is durably settled. A hook failure blocks later work.
    await rm(transaction, { recursive: true, force: true })
    await rm(resolve(root, 'restore.json'))
    await syncDirectory(root)
    return { version: manifest.summary, restoreId: journal.restoreId, workspaceReverted: true, conversationReverted: false, externalSideEffectsReverted: false }
  }

  private async manifest(sessionId: string, versionId: string): Promise<Manifest> {
    const directory = this.versionDir(sessionId, versionId)
    await assertNoSymlinkTraversal(this.store.sessionDir(sessionId), resolve(directory, 'manifest.json'))
    let value: unknown
    try { value = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw versionError('Workspace version does not exist', 404)
      throw versionError('Workspace version manifest is unreadable', 409)
    }
    if (!isRecord(value) || value.format !== 1 || !isRecord(value.summary) || !Array.isArray(value.files) || !Array.isArray(value.directories)) throw versionError('Invalid workspace version manifest', 409)
    const summary = value.summary
    if (summary.id !== versionId || !HASH.test(String(summary.sha256)) || typeof summary.label !== 'string' || typeof summary.createdAt !== 'string' || !['delivery', 'manual', 'before_restore'].includes(String(summary.reason))) throw versionError('Invalid workspace version summary', 409)
    const seen = new Set<string>()
    for (const file of value.files) {
      if (!isRecord(file) || !safePath(file.path) || seen.has(String(file.path)) || !HASH.test(String(file.sha256)) || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || !Number.isInteger(file.mode) || Number(file.mode) < 0 || Number(file.mode) > 0o777) throw versionError('Invalid workspace version file record', 409)
      seen.add(String(file.path))
    }
    if (value.directories.some((path) => !safePath(path) || seen.has(String(path))) || new Set(value.directories).size !== value.directories.length) throw versionError('Invalid workspace version directory record', 409)
    const manifest = value as unknown as Manifest
    if (treeDigest(manifest.files, manifest.directories) !== summary.sha256 || summary.fileCount !== manifest.files.length || summary.bytes !== manifest.files.reduce((sum, file) => sum + file.bytes, 0)) throw versionError('Workspace version manifest integrity check failed', 409)
    return manifest
  }

  private async publishCreated(sessionId: string, version: WorkspaceVersionSummary): Promise<void> {
    await this.store.appendIfAbsent(sessionId, 'workspace.version.created', { version },
      (event) => event.type === 'workspace.version.created' && (event.data.version as WorkspaceVersionSummary | undefined)?.id === version.id,
      version.turnId ? { turnId: version.turnId } : {})
  }

  private async verifiedManifest(sessionId: string, versionId: string): Promise<Manifest> {
    const manifest = await this.manifest(sessionId, versionId)
    await verifyTree(resolve(this.versionDir(sessionId, versionId), 'files'), manifest)
    return manifest
  }

  private async assertIdle(sessionId: string): Promise<void> {
    const state = await this.store.get(sessionId)
    if (BUSY.has(state.summary.status) || state.pendingStart) throw versionError('Stop the active task before changing workspace versions', 409)
  }

  private serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.queues.set(sessionId, next)
    void next.finally(() => { if (this.queues.get(sessionId) === next) this.queues.delete(sessionId) }).catch(() => undefined)
    return next
  }
}

export function mountWorkspaceVersionRoutes(app: Express, store: SessionStore, agent: WorkspaceVersionAgent, service = new WorkspaceVersionService(store, agent)): WorkspaceVersionService {
  const route = '/api/sessions/:id/workspace-versions'
  app.get(route, async (request, response) => response.json(await service.list(request.params.id)))
  app.post(route, async (request, response) => {
    const label = request.body?.label
    if (label !== undefined && typeof label !== 'string') throw versionError('label must be a string', 400)
    response.status(201).json(store.redactForDisplay(request.params.id, { version: await service.captureManual(request.params.id, label) }))
  })
  app.get(`${route}/:versionId/diff`, async (request, response) => {
    const against = request.query.against ?? 'current'
    if (typeof against !== 'string') throw versionError('against must be a version ID or current', 400)
    response.json(await service.diff(request.params.id, request.params.versionId, against))
  })
  app.post(`${route}/:versionId/restore`, async (request, response) => {
    response.json(store.redactForDisplay(request.params.id, await service.restore(request.params.id, request.params.versionId)))
  })
  return service
}

/** Called before staging a terminal outcome; the stored digest binds later crash recovery to those exact files. */
export async function workspaceVersionFingerprint(workspace: string): Promise<string> {
  const tree = await collectTree(workspace)
  return treeDigest(tree.files, tree.directories)
}

async function collectTree(root: string, destination?: string): Promise<{ files: FileRecord[]; directories: string[] }> {
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw versionError('Workspace root must be a real directory', 409)
  const files: FileRecord[] = []
  const directories: string[] = []
  async function walk(path: string): Promise<boolean> {
    const names = await readdir(resolveWorkspacePath(root, path))
    let visible = names.length === 0
    for (const name of names.sort()) {
      const relative = path ? `${path}/${name}` : name
      if (isWorkspaceSnapshotExcludedPath(relative)) continue
      if (!safePath(relative)) throw versionError('Workspace contains an unsupported path', 409)
      const target = resolveWorkspacePath(root, relative)
      await assertNoSymlinkTraversal(root, target)
      const info = await lstat(target)
      if (info.isSymbolicLink()) throw versionError(`Workspace version cannot include a symbolic link: ${relative}`, 409)
      if (info.isDirectory()) {
        if (destination) await mkdir(resolveWorkspacePath(destination, relative), { recursive: true })
        if (await walk(relative)) { directories.push(relative); visible = true }
        else if (destination) await rmdir(resolveWorkspacePath(destination, relative))
      } else if (info.isFile()) {
        visible = true
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
        let bytes: Buffer
        try {
          if (!(await handle.stat()).isFile()) throw versionError(`Workspace path is no longer a regular file: ${relative}`, 409)
          bytes = await handle.readFile()
        } finally { await handle.close() }
        const mode = info.mode & 0o777
        files.push({ path: relative, sha256: hash(bytes), bytes: bytes.length, mode })
        if (destination) await writeDurableFile(resolveWorkspacePath(destination, relative), bytes, mode)
      } else throw versionError(`Workspace version cannot include a special file: ${relative}`, 409)
    }
    return visible
  }
  await walk('')
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), directories: directories.sort() }
}

async function preserveExcluded(source: string, destination: string): Promise<void> {
  async function walk(path: string): Promise<void> {
    for (const name of await readdir(resolveWorkspacePath(source, path))) {
      const relative = path ? `${path}/${name}` : name
      const original = resolveWorkspacePath(source, relative)
      const info = await lstat(original)
      if (isWorkspaceSnapshotExcludedPath(relative)) {
        const target = resolveWorkspacePath(destination, relative)
        await assertNoSymlinkTraversal(destination, target)
        // A target-version file replacing an ancestor of private runtime data is not safe to merge.
        await mkdir(dirname(target), { recursive: true })
        await cp(original, target, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false, mode: constants.COPYFILE_FICLONE })
      } else if (info.isDirectory() && !info.isSymbolicLink()) await walk(relative)
    }
  }
  await walk('')
}

async function verifiedRead(root: string, record: FileRecord): Promise<Buffer> {
  const target = resolveWorkspacePath(root, record.path)
  await assertNoSymlinkTraversal(root, target)
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const info = await handle.stat()
    if (!info.isFile() || (info.mode & 0o777) !== record.mode) throw versionError('Workspace version file metadata changed', 409)
    bytes = await handle.readFile()
  } finally { await handle.close() }
  if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) throw versionError('Workspace version file integrity check failed', 409)
  return bytes
}

async function verifyTree(root: string, manifest: Manifest): Promise<void> {
  const actual = await collectTree(root)
  if (treeDigest(actual.files, actual.directories) !== manifest.summary.sha256) throw versionError('Workspace version content integrity check failed', 409)
}

function treeDigest(files: FileRecord[], directories: string[]): string { return hash(Buffer.from(JSON.stringify({ files, directories }))) }
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function fileInfo({ sha256, bytes, mode }: FileRecord): WorkspaceVersionFileInfo { return { sha256, bytes, mode } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\') && !/[\u0000-\u001f]/u.test(path) && !path.startsWith('/') && !/^[A-Za-z]:/u.test(path) && path.split('/').every((part) => part && part !== '.' && part !== '..') && !isWorkspaceSnapshotExcludedPath(path)
}
function cleanLabel(label?: string): string | undefined {
  if (label === undefined) return undefined
  if (typeof label !== 'string' || label.length > 160 || /[\u0000-\u001f]/u.test(label)) throw versionError('Version label must be at most 160 characters without control characters', 400)
  return label.trim() || undefined
}
function isUtf8(bytes: Buffer): boolean { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true } catch { return false } }
function utf8Prefix(bytes: Buffer, limit: number): string {
  // Streaming decoding leaves a partial final code point out of the preview.
  return new TextDecoder('utf-8').decode(bytes.subarray(0, limit), { stream: bytes.length > limit })
}
function versionError(message: string, statusCode: number): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }) }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
async function syncTree(root: string, syncFiles: boolean): Promise<void> {
  for (const name of await readdir(root)) {
    const path = resolve(root, name)
    const info = await lstat(path)
    if (info.isDirectory()) await syncTree(path, syncFiles)
    else if (syncFiles && info.isFile()) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await handle.sync() } finally { await handle.close() }
    }
    // Preserved symlinks are durable through their parent's directory entry.
  }
  await syncDirectory(root)
}
async function writeDurableFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'wx', mode)
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync() } finally { await handle.close() }
  await syncDirectory(dirname(path))
}
async function durableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${createId('tmp')}`
  try { await writeDurableFile(temporary, Buffer.from(JSON.stringify(value)), 0o600); await rename(temporary, path); await syncDirectory(dirname(path)) }
  finally { await rm(temporary, { force: true }) }
}
