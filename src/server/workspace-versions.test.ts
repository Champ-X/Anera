import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceVersionSummary } from '../shared/workspace-versions.js'
import { SessionStore } from './session-store.js'
import { mountWorkspaceVersionRoutes, WorkspaceVersionService, type WorkspaceVersionAgent } from './workspace-versions.js'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-workspace-versions-'))
  roots.push(root)
  const store = new SessionStore(root, 'test-model')
  await store.initialize()
  const sessionId = (await store.create()).summary.id
  const workspace = store.workspaceDir(sessionId)
  const applied = new Set<string>()
  const locked = new Set<string>()
  const agent: WorkspaceVersionAgent = {
    async stopWorkspaceResources() {},
    async withWorkspaceVersionLock(id, operation) {
      if (locked.has(id)) throw Object.assign(new Error('Session is busy'), { statusCode: 409 })
      locked.add(id)
      try { return await operation() } finally { locked.delete(id) }
    },
    async workspaceVersionRestored(id, version, restoreId) {
      if (applied.has(restoreId)) return
      await store.appendIfAbsent(id, 'workspace.version.restored', { version, restoreId },
        (event) => event.type === 'workspace.version.restored' && event.data.restoreId === restoreId)
      applied.add(restoreId)
    },
  }
  const service = new WorkspaceVersionService(store, agent)
  return { root, store, sessionId, workspace, service, agent, applied, locked }
}

describe('workspace versions on real files', () => {
  it('restores modified, removed, added and binary files plus empty directories and executable permissions', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'note.txt'), 'old\n')
    await writeFile(resolve(f.workspace, 'deleted.txt'), 'bring back')
    await writeFile(resolve(f.workspace, 'image.bin'), Buffer.from([0, 1, 255]))
    await writeFile(resolve(f.workspace, 'run.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(resolve(f.workspace, 'run.sh'), 0o755)
    await mkdir(resolve(f.workspace, 'empty'))
    await mkdir(resolve(f.workspace, 'node_modules'))
    await writeFile(resolve(f.workspace, 'node_modules', 'runtime.txt'), 'current dependency')
    await mkdir(resolve(f.workspace, '.git'))
    await writeFile(resolve(f.workspace, '.git', 'config'), 'private live metadata')
    const version = await f.service.captureManual(f.sessionId, 'first')
    await writeFile(resolve(f.workspace, 'note.txt'), 'new\n')
    await rm(resolve(f.workspace, 'deleted.txt'))
    await rm(resolve(f.workspace, 'empty'), { recursive: true })
    await writeFile(resolve(f.workspace, 'new.txt'), 'remove this')
    await writeFile(resolve(f.workspace, 'image.bin'), Buffer.from([0, 9, 254]))
    await chmod(resolve(f.workspace, 'run.sh'), 0o644)
    const diff = await f.service.diff(f.sessionId, version.id)
    expect(diff).toMatchObject({ added: 1, deleted: 1, modified: 3 })
    expect(diff.changes.find((change) => change.path === 'note.txt')).toMatchObject({ beforeText: 'old\n', afterText: 'new\n' })
    expect(diff.changes.find((change) => change.path === 'image.bin')).not.toHaveProperty('beforeText')
    const restored = await f.service.restore(f.sessionId, version.id)
    expect(restored).toMatchObject({ workspaceReverted: true, conversationReverted: false, externalSideEffectsReverted: false })
    expect(await readFile(resolve(f.workspace, 'note.txt'), 'utf8')).toBe('old\n')
    expect(await readFile(resolve(f.workspace, 'deleted.txt'), 'utf8')).toBe('bring back')
    expect(await readFile(resolve(f.workspace, 'image.bin'))).toEqual(Buffer.from([0, 1, 255]))
    expect((await lstat(resolve(f.workspace, 'run.sh'))).mode & 0o777).toBe(0o755)
    expect((await lstat(resolve(f.workspace, 'empty'))).isDirectory()).toBe(true)
    await expect(lstat(resolve(f.workspace, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(resolve(f.workspace, 'node_modules/runtime.txt'), 'utf8')).toBe('current dependency')
    expect(await readFile(resolve(f.workspace, '.git/config'), 'utf8')).toBe('private live metadata')
    expect((await f.service.diff(f.sessionId, version.id)).changes).toHaveLength(0)
    const backup = (await f.service.list(f.sessionId)).versions.find((entry) => entry.reason === 'before_restore')!
    expect((await f.service.diff(f.sessionId, version.id, backup.id)).changes).toHaveLength(5)
    expect(f.applied.size).toBe(1)
  })

  it('restores an empty saved workspace, and retains a before-restore version', async () => {
    const f = await fixture()
    const empty = await f.service.capture(f.sessionId, { reason: 'delivery', turnId: 'turn_empty' })
    await writeFile(resolve(f.workspace, 'later.txt'), 'later')
    await f.service.restore(f.sessionId, empty.id)
    expect(await readdir(f.workspace)).toEqual([])
    const versions = await f.service.list(f.sessionId)
    expect(versions.versions.find((version) => version.reason === 'before_restore')).toMatchObject({ fileCount: 1 })
  })

  it.each(['prepared', 'workspace_moved', 'installed', 'settled'] as const)('recovers across a process restart at the %s boundary', async (boundary) => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'result.txt'), 'first')
    const first = await f.service.captureManual(f.sessionId)
    await writeFile(resolve(f.workspace, 'result.txt'), 'second')
    const crashing = new WorkspaceVersionService(f.store, f.agent, {
      onRestorePhase: async (phase) => { if (phase === boundary) throw new Error('simulated process loss') },
    })
    await expect(crashing.restore(f.sessionId, first.id)).rejects.toThrow('simulated process loss')
    const restartedStore = new SessionStore(f.root, 'test-model')
    await restartedStore.initialize()
    const restarted = new WorkspaceVersionService(restartedStore, f.agent)
    await restarted.recoverAll()
    expect(await readFile(resolve(f.workspace, 'result.txt'), 'utf8')).toBe('first')
    expect(await restarted.recover(f.sessionId)).toBeUndefined()
    expect((await restartedStore.events(f.sessionId)).filter((event) => event.type === 'workspace.version.restored')).toHaveLength(1)
    await expect(lstat(resolve(f.store.sessionDir(f.sessionId), 'workspace-versions/restore.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a failed semantic hook pending and replays it instead of recopying files', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'result.txt'), 'first')
    const first = await f.service.captureManual(f.sessionId)
    await writeFile(resolve(f.workspace, 'result.txt'), 'second')
    const failed = new WorkspaceVersionService(f.store, { ...f.agent, workspaceVersionRestored: async () => { throw new Error('state unavailable') } })
    await expect(failed.restore(f.sessionId, first.id)).rejects.toThrow('state unavailable')
    expect(await readFile(resolve(f.workspace, 'result.txt'), 'utf8')).toBe('first')
    await expect(f.service.captureManual(f.sessionId)).rejects.toThrow('Workspace recovery is pending')
    // Retrying the same restore from the UI settles the durable operation, without a server restart.
    await f.service.restore(f.sessionId, first.id)
    expect(f.applied.size).toBe(1)
  })

  it('rejects corrupted bytes, malicious manifests and public symlinks without mutating current files', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'result.txt'), 'first')
    const first = await f.service.captureManual(f.sessionId)
    const snapshot = resolve(f.store.sessionDir(f.sessionId), 'workspace-versions', first.id)
    await writeFile(resolve(f.workspace, 'result.txt'), 'second')
    await writeFile(resolve(snapshot, 'files/result.txt'), 'corrupt')
    await expect(f.service.restore(f.sessionId, first.id)).rejects.toThrow('integrity')
    expect(await readFile(resolve(f.workspace, 'result.txt'), 'utf8')).toBe('second')
    const manifest = JSON.parse(await readFile(resolve(snapshot, 'manifest.json'), 'utf8'))
    manifest.files[0].path = '../../outside'
    await writeFile(resolve(snapshot, 'manifest.json'), JSON.stringify(manifest))
    await expect(f.service.diff(f.sessionId, first.id)).rejects.toThrow('Invalid workspace version file record')
    await symlink(resolve(f.root, 'outside'), resolve(f.workspace, 'link'))
    await expect(f.service.captureManual(f.sessionId)).rejects.toThrow(/symlink|symbolic link/i)
    await expect(f.service.restore(f.sessionId, '../bad')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('deduplicates delivery capture and bounds text comparison payloads', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'large.txt'), 'a'.repeat(60_000))
    const first = await f.service.capture(f.sessionId, { reason: 'delivery', turnId: 'turn_a' })
    const again = await f.service.capture(f.sessionId, { reason: 'delivery', turnId: 'turn_a' })
    expect(again.id).toBe(first.id)
    await writeFile(resolve(f.workspace, 'large.txt'), 'b'.repeat(60_000))
    const change = (await f.service.diff(f.sessionId, first.id)).changes[0]
    expect(change.textTruncated).toBe(true)
    expect(change.beforeText?.length).toBe(32_768)
    expect((await f.service.list(f.sessionId)).versions).toHaveLength(1)
  })

  it('does not publish a successful delivery retry for a corrupted existing snapshot', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'report.txt'), 'accepted delivery')
    const saved = await f.service.capture(f.sessionId, { reason: 'delivery', turnId: 'turn_retry' })
    await writeFile(resolve(f.store.sessionDir(f.sessionId), 'workspace-versions', saved.id, 'files/report.txt'), 'corrupted snapshot')
    await expect(f.service.capture(f.sessionId, { reason: 'delivery', turnId: 'turn_retry' })).rejects.toThrow('integrity')
    expect(await readFile(resolve(f.workspace, 'report.txt'), 'utf8')).toBe('accepted delivery')
  })

  it('redacts secrets in text comparisons while restoring the original local file bytes', async () => {
    const f = await fixture()
    const original = 'SERVICE_API_KEY=api_original_example_secret\n'
    await writeFile(resolve(f.workspace, '.env'), original)
    const first = await f.service.captureManual(f.sessionId)
    await writeFile(resolve(f.workspace, '.env'), 'SERVICE_API_KEY=api_replacement_example_secret\n')
    const diff = await f.service.diff(f.sessionId, first.id)
    expect(diff.changes[0].beforeText).toContain('[REDACTED_SECRET]')
    expect(diff.changes[0].afterText).toContain('[REDACTED_SECRET]')
    expect(JSON.stringify(diff)).not.toContain('api_original_example_secret')
    await f.service.restore(f.sessionId, first.id)
    expect(await readFile(resolve(f.workspace, '.env'), 'utf8')).toBe(original)
  })

  it('redacts a secret before a text preview boundary can expose its prefix', async () => {
    const f = await fixture()
    const secret = 'api_original_example_secret_that_crosses_the_preview_boundary'
    const prefix = `${'x'.repeat(32_768 - 35)}\nSERVICE_API_KEY=`
    await writeFile(resolve(f.workspace, '.env'), `${prefix}${secret}\n`)
    const saved = await f.service.captureManual(f.sessionId)
    await writeFile(resolve(f.workspace, '.env'), 'changed')
    const diff = await f.service.diff(f.sessionId, saved.id)
    expect(diff.changes[0].beforeText).not.toContain('api_original')
    expect(diff.changes[0].beforeText).toContain('[REDACTED_SECRET]')
    expect(diff.changes[0].textTruncated).toBe(true)
  })

  it('uses secrets discovered in later comparison files before truncating earlier previews', async () => {
    const f = await fixture()
    const secret = 'A_UNIQUE_CREDENTIAL_WITH_NO_SELF_IDENTIFYING_PREFIX'
    await writeFile(resolve(f.workspace, 'a.txt'), `${'x'.repeat(32_768 - 20)}\n${secret}`)
    const saved = await f.service.captureManual(f.sessionId)
    await writeFile(resolve(f.workspace, 'a.txt'), 'changed')
    await writeFile(resolve(f.workspace, 'z.env'), `SERVICE_API_KEY=${secret}`)
    const change = (await f.service.diff(f.sessionId, saved.id)).changes.find((entry) => entry.path === 'a.txt')!
    expect(change.beforeText?.includes('A_UNIQUE')).toBe(false)
    expect(change.beforeText).toContain('[REDACTED_SECRET]')
  })

  it('does not corrupt a multibyte character at the text preview byte limit', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'report.txt'), '汉'.repeat(11_000))
    const saved = await f.service.captureManual(f.sessionId)
    await writeFile(resolve(f.workspace, 'report.txt'), 'changed')
    const change = (await f.service.diff(f.sessionId, saved.id)).changes[0]
    expect(change.beforeText?.includes('\uFFFD')).toBe(false)
    expect(Buffer.byteLength(change.beforeText!)).toBeLessThanOrEqual(32_768)
    expect(change.textTruncated).toBe(true)
  })

  it('rejects a symlinked version storage root before writing any snapshots outside the session', async () => {
    const f = await fixture()
    const outside = resolve(f.root, 'outside')
    await mkdir(outside)
    await writeFile(resolve(f.workspace, 'private.txt'), 'saved workspace bytes')
    await symlink(outside, resolve(f.store.sessionDir(f.sessionId), 'workspace-versions'))
    await expect(f.service.captureManual(f.sessionId)).rejects.toThrow(/symlink|symbolic link/i)
    expect(await readdir(outside)).toEqual([])
  })

  it('rejects a symlinked restore transaction before moving either the current or external workspace', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'report.txt'), 'saved')
    const saved = await f.service.captureManual(f.sessionId)
    await writeFile(resolve(f.workspace, 'report.txt'), 'current')
    const interrupted = new WorkspaceVersionService(f.store, f.agent, {
      onRestorePhase: async (phase) => { if (phase === 'prepared') throw new Error('Interrupted') },
    })
    await expect(interrupted.restore(f.sessionId, saved.id)).rejects.toThrow('Interrupted')
    const root = resolve(f.store.sessionDir(f.sessionId), 'workspace-versions')
    const journal = JSON.parse(await readFile(resolve(root, 'restore.json'), 'utf8'))
    const transaction = resolve(root, journal.restoreId)
    const outside = resolve(f.root, 'outside-transaction')
    await rename(transaction, outside)
    await symlink(outside, transaction)
    await expect(f.service.recover(f.sessionId)).rejects.toThrow(/symlink|symbolic link/i)
    expect(await readFile(resolve(f.workspace, 'report.txt'), 'utf8')).toBe('current')
    expect(await readFile(resolve(outside, 'next/report.txt'), 'utf8')).toBe('saved')
    expect(await readdir(outside)).toEqual(['next'])
    expect(f.applied.size).toBe(0)
  })

  it('rejects restore and manual save for active sessions and preserves ignored nested runtime directories', async () => {
    const f = await fixture()
    const first = await f.service.captureManual(f.sessionId)
    await mkdir(resolve(f.workspace, 'nested/node_modules'), { recursive: true })
    await writeFile(resolve(f.workspace, 'nested/node_modules/keep'), 'runtime')
    await f.store.update(f.sessionId, (state) => { state.summary.status = 'running' })
    await expect(f.service.restore(f.sessionId, first.id)).rejects.toMatchObject({ statusCode: 409 })
    await expect(f.service.captureManual(f.sessionId)).rejects.toMatchObject({ statusCode: 409 })
    await f.store.update(f.sessionId, (state) => { state.summary.status = 'completed' })
    await f.service.restore(f.sessionId, first.id)
    expect(await readFile(resolve(f.workspace, 'nested/node_modules/keep'), 'utf8')).toBe('runtime')
    expect((await f.service.diff(f.sessionId, first.id)).changes).toEqual([])
  })

  it('exposes usable list, capture, text diff and restore HTTP endpoints', async () => {
    const f = await fixture()
    const app = express()
    app.use(express.json())
    mountWorkspaceVersionRoutes(app, f.store, f.agent, f.service)
    app.use((error: Error & { statusCode?: number }, _request: express.Request, response: express.Response, _next: express.NextFunction) => { response.status(error.statusCode ?? 500).json({ error: error.message }) })
    const server = createServer(app)
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No HTTP address')
    const base = `http://127.0.0.1:${address.port}/api/sessions/${f.sessionId}/workspace-versions`
    await writeFile(resolve(f.workspace, 'result.txt'), 'one')
    const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Named' }) })
    expect(response.status).toBe(201)
    const { version } = await response.json() as { version: WorkspaceVersionSummary }
    expect(await (await fetch(base)).json()).toMatchObject({ versions: [{ id: version.id, label: 'Named' }] })
    await writeFile(resolve(f.workspace, 'result.txt'), 'two')
    expect(await (await fetch(`${base}/${version.id}/diff`)).json()).toMatchObject({ modified: 1, changes: [{ beforeText: 'one', afterText: 'two' }] })
    const restored = await fetch(`${base}/${version.id}/restore`, { method: 'POST' })
    expect(restored.status).toBe(200)
    expect(await readFile(resolve(f.workspace, 'result.txt'), 'utf8')).toBe('one')
  })
})
