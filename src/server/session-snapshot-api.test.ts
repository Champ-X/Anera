import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../shared/types.js'
import { createApp } from './app.js'

async function withSnapshotApi(run: (context: {
  created: Awaited<ReturnType<typeof createApp>>
  id: string
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
    await run({ created, id: session.summary.id, url: `http://127.0.0.1:${address.port}/api/sessions/${session.summary.id}` })
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
