import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot, SessionSummary } from '../shared/types.js'
import { createApp } from './app.js'
import { SessionStore } from './session-store.js'

async function withSnapshotApi(run: (context: {
  created: Awaited<ReturnType<typeof createApp>>
  id: string
  root: string
  url: string
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-readonly-snapshot-api-'))
  const disabled = async (): Promise<never> => { throw new Error('No provider calls in snapshot API tests') }
  const created = await createApp({
    dataRoot: root,
    model: 'snapshot-fixture',
    agent: { client: { stream: disabled }, vision: { inspect: disabled, compare: disabled }, tools: { execute: disabled } },
  })
  const server = createServer(created.app)
  try {
    const session = await created.store.create()
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Snapshot API test server did not bind')
    await run({ created, id: session.summary.id, root, url: `http://127.0.0.1:${address.port}/api/sessions/${session.summary.id}` })
  } finally {
    vi.restoreAllMocks()
    await created.agent.shutdown()
    await new Promise<void>((closed) => server.close(() => closed()))
    await rm(root, { recursive: true, force: true })
  }
}

async function durableEvidence(sessionDirectory: string) {
  const statePath = resolve(sessionDirectory, 'state.json')
  const journalPath = resolve(sessionDirectory, 'events.jsonl')
  const [state, journal, metadata] = await Promise.all([
    readFile(statePath), readFile(journalPath), stat(statePath, { bigint: true }),
  ])
  return {
    stateSha256: createHash('sha256').update(state).digest('hex'),
    journalSha256: createHash('sha256').update(journal).digest('hex'),
    updatedAt: (JSON.parse(state.toString('utf8')) as { summary: { updatedAt: string } }).summary.updatedAt,
    stateMtimeNs: metadata.mtimeNs,
  }
}

describe('read-only session snapshot API', () => {
  it('keeps durable bytes and updatedAt unchanged while returning fresh workspace sizes and redacted summaries', async () => {
    await withSnapshotApi(async ({ created, id, url }) => {
      const secret = 'snapshot-secret-fixture-value'
      created.store.registerSensitiveValues(id, [secret])
      await created.store.update(id, (state) => {
        state.summary.title = `Saved ${secret}`
        state.summary.workspaceBytes = 999
      }, { updatedAt: '2026-09-01T00:00:00.000Z' })
      await created.store.append(id, 'assistant.final', { content: 'Stored fixture result.' })
      const baseline = await durableEvidence(created.store.sessionDir(id))
      const file = resolve(created.store.workspaceDir(id), 'notes.txt')
      for (const content of ['initial', '中文 workspace changed outside the session store']) {
        await writeFile(file, content)
        for (let repeat = 0; repeat < 2; repeat += 1) {
          const response = await fetch(url)
          expect(response.status).toBe(200)
          const snapshot = await response.json() as SessionSnapshot
          expect(snapshot.session.workspaceBytes).toBe(Buffer.byteLength(content))
          expect(snapshot.session.updatedAt).toBe(baseline.updatedAt)
          expect(snapshot.session.title).not.toContain(secret)
          expect(snapshot.session.title).toContain('Saved')
          expect(snapshot.events.at(-1)?.data.content).toBe('Stored fixture result.')
          expect(snapshot.workspace).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'notes.txt' })]))
          expect(await durableEvidence(created.store.sessionDir(id))).toEqual(baseline)
        }
      }
      expect((await created.store.get(id)).summary.workspaceBytes).toBe(999)
    })
  })

  it('does not overwrite a concurrent session mutation after reading its snapshot', async () => {
    await withSnapshotApi(async ({ created, id, url }) => {
      const get = created.store.get.bind(created.store)
      let reached!: () => void
      let release!: () => void
      const readReached = new Promise<void>((ready) => { reached = ready })
      const releaseRead = new Promise<void>((ready) => { release = ready })
      let paused = false
      vi.spyOn(created.store, 'get').mockImplementation(async (sessionId) => {
        const state = await get(sessionId)
        if (sessionId === id && !paused) {
          paused = true
          reached()
          await releaseRead
        }
        return state
      })
      const pendingResponse = fetch(url)
      await readReached
      try {
        await created.store.update(id, (state) => {
          state.summary.title = 'Concurrent task update'
          state.summary.status = 'completed'
          state.summary.workspaceBytes = 321
        }, { updatedAt: '2026-09-09T03:30:00.000Z' })
        await created.store.append(id, 'assistant.final', { content: 'Concurrent durable result.' })
        const committed = await durableEvidence(created.store.sessionDir(id))
        release()
        const response = await pendingResponse
        expect(response.status).toBe(200)
        await response.json()
        expect(await durableEvidence(created.store.sessionDir(id))).toEqual(committed)
        expect((await get(id)).summary).toMatchObject({
          title: 'Concurrent task update', status: 'completed', workspaceBytes: 321,
          updatedAt: '2026-09-09T03:30:00.000Z',
        })
        expect((await created.store.events(id)).at(-1)?.data.content).toBe('Concurrent durable result.')
      } finally {
        release()
        await pendingResponse
      }
    })
  })
})

describe('session metadata API', () => {
  it('persists rename, archive and restore without changing activity order or deleting content', async () => {
    await withSnapshotApi(async ({ created, id, root, url }) => {
      const newer = await created.store.create()
      await created.store.update(id, (state) => { state.summary.status = 'completed' }, { updatedAt: '2026-09-01T00:00:00.000Z' })
      await created.store.append(id, 'assistant.final', { content: 'Keep this response.' })
      await writeFile(resolve(created.store.workspaceDir(id), 'keep.txt'), 'Keep this workspace file.')
      const journal = await created.store.events(id)
      const before = (await created.store.get(id)).summary
      for (const patch of [{ title: '  中文会话名  ' }, { archived: true }, { archived: false }]) {
        const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        expect(response.status).toBe(200)
        const { session } = await response.json() as { session: SessionSummary }
        expect(session).toMatchObject({ title: '中文会话名', updatedAt: before.updatedAt, status: 'completed' })
        expect(Boolean(session.archivedAt)).toBe('archived' in patch && patch.archived === true)
        const reloaded = await new SessionStore(root, 'snapshot-fixture').get(id)
        expect(reloaded.summary).toEqual(session)
        expect(reloaded.titleCustomized).toBe(true)
        expect(await created.store.events(id)).toEqual(journal)
        expect(await readFile(resolve(created.store.workspaceDir(id), 'keep.txt'), 'utf8')).toBe('Keep this workspace file.')
        expect((await created.store.list()).map((item) => item.id)).toEqual([newer.summary.id, id])
      }
    })
  })

  it('serializes concurrent metadata and run updates without losing either change', async () => {
    await withSnapshotApi(async ({ created, id, url }) => {
      const responses = await Promise.all([
        fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed during run' }) }),
        fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }) }),
        created.store.update(id, (state) => { state.summary.lastMessage = 'Concurrent progress'; state.summary.workspaceBytes = 45 }),
      ])
      expect(responses[0].status).toBe(200)
      expect(responses[1].status).toBe(200)
      expect((await created.store.get(id)).summary).toMatchObject({
        title: 'Renamed during run', archivedAt: expect.any(String), metadataVersion: 2,
        lastMessage: 'Concurrent progress', workspaceBytes: 45,
      })
    })
  })

  it('rejects invalid edits without writing state and returns 404 for a missing session', async () => {
    await withSnapshotApi(async ({ created, id, url }) => {
      const before = await durableEvidence(created.store.sessionDir(id))
      for (const patch of [{}, [], { title: '' }, { title: '  ' }, { title: 12 }, { title: 'a'.repeat(201) }, { title: 'two\nlines' }, { archived: 'true' }, { status: 'running' }, { title: 'valid', archived: null }]) {
        const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        expect(response.status, JSON.stringify(patch)).toBe(400)
        expect(await durableEvidence(created.store.sessionDir(id))).toEqual(before)
      }
      const missing = await fetch(url.replace(id, 'ses_00000000000000000000'), {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }),
      })
      expect(missing.status).toBe(404)
    })
  })
})
