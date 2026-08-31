import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { DAILY_CREDIT_LIMIT_ERROR_MESSAGE } from './credit-store.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function listen(app: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function temporaryDataRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-credit-api-'))
  roots.push(root)
  return resolve(root, 'data')
}

function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('Arena daily credit API contract', () => {
  it('returns the exact public balance and pulse response shapes', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const base = await listen(created.app)
    try {
      const balance = await fetch(`${base}/api/billing/balance`)
      expect(balance.status).toBe(200)
      expect(await balance.json()).toEqual({
        creditsRemaining: 2_500,
        dailyFreeCredits: 2_500,
        refreshedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/),
      })

      const pulse = await fetch(`${base}/api/me/pulse`)
      expect(pulse.status).toBe(200)
      expect(await pulse.json()).toEqual({
        pulse: 100,
        refreshedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/),
      })
    } finally {
      await created.agent.shutdown()
    }
  })

  it('globally blocks Message and Continue at zero without creating an execution episode', async () => {
    const created = await createApp({
      dataRoot: await temporaryDataRoot(),
      model: 'test-model',
      dailyFreeCredits: 1,
      creditsPerUsd: 1,
    })
    const exhausted = await created.store.create()
    await created.store.update(exhausted.summary.id, (state) => {
      state.summary.status = 'failed'
      state.messages.push({ role: 'user', content: 'Persisted task to continue.' })
    })
    await created.credits.settle(exhausted.summary.id, 1)
    const base = await listen(created.app)
    try {
      for (const request of [
        () => postJson(base, `/api/sessions/${exhausted.summary.id}/messages`, { content: 'Start another turn.', attachments: [] }),
        () => postJson(base, `/api/sessions/${exhausted.summary.id}/resume`, {}),
      ]) {
        const response = await request()
        expect(response.status).toBe(429)
        expect(await response.json()).toEqual({
          error: DAILY_CREDIT_LIMIT_ERROR_MESSAGE,
          code: 'daily_credit_limit',
        })
      }
      const events = await created.store.events(exhausted.summary.id)
      expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(0)
      expect(events.filter((event) => event.type === 'run.resumed')).toHaveLength(0)

      const newChat = await postJson(base, '/api/sessions', {})
      expect(newChat.status).toBe(201)
      const newSession = await newChat.json() as { session: { id: string; isFreeSession: boolean } }
      expect(newSession.session.isFreeSession).toBe(false)
      const blockedNewChat = await postJson(base, `/api/sessions/${newSession.session.id}/messages`, {
        content: 'A new chat does not reset the daily balance.',
        attachments: [],
      })
      expect(blockedNewChat.status).toBe(429)
      expect((await created.store.events(newSession.session.id)).filter((event) => event.type === 'turn.started')).toHaveLength(0)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('lets a free session execute while the global normal-session balance remains zero', async () => {
    const stream = vi.fn(async (options: { onContent: (delta: string) => void }) => {
      options.onContent('Free-session result.')
      return {
        content: 'Free-session result.',
        reasoningContent: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25, cachedPromptTokens: 0 },
      }
    })
    const created = await createApp({
      dataRoot: await temporaryDataRoot(),
      model: 'test-model',
      dailyFreeCredits: 1,
      creditsPerUsd: 1,
      agent: { client: { stream } as never, runTimeoutMs: 1_000 },
    })
    const normal = await created.store.create()
    await created.credits.settle(normal.summary.id, 1)
    const free = await created.store.create({ isFreeSession: true })
    const base = await listen(created.app)
    try {
      const response = await postJson(base, `/api/sessions/${free.summary.id}/messages`, {
        content: 'Run in the free session.',
        attachments: [],
      })
      expect(response.status).toBe(202)
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await created.store.get(free.summary.id)).summary.status === 'completed') break
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect((await created.store.get(free.summary.id)).summary).toMatchObject({
        status: 'completed',
        isFreeSession: true,
      })
      expect(stream).toHaveBeenCalledOnce()
      expect(await created.credits.balance()).toMatchObject({ creditsRemaining: 0 })
      const usage = (await created.store.events(free.summary.id)).find((event) => event.type === 'usage.updated')
      expect(usage).toMatchObject({
        data: { creditSettlement: { chargedCredits: 0 } },
      })
    } finally {
      await created.agent.shutdown()
    }
  })

  it('lets the in-flight normal run finish when its first usage settlement consumes the last credit', async () => {
    const stream = vi.fn(async (options: { onContent: (delta: string) => void }) => {
      options.onContent('The admitted run still finishes.')
      return {
        content: 'The admitted run still finishes.',
        reasoningContent: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25, cachedPromptTokens: 0 },
      }
    })
    const created = await createApp({
      dataRoot: await temporaryDataRoot(),
      model: 'test-model',
      dailyFreeCredits: 1,
      creditsPerUsd: 1,
      agent: { client: { stream } as never, runTimeoutMs: 1_000 },
    })
    const session = await created.store.create()
    const base = await listen(created.app)
    try {
      const admitted = await postJson(base, `/api/sessions/${session.summary.id}/messages`, {
        content: 'Consume the last available credit.',
        attachments: [],
      })
      expect(admitted.status).toBe(202)
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await created.store.get(session.summary.id)).summary.status === 'completed') break
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect((await created.store.get(session.summary.id)).summary).toMatchObject({
        status: 'completed',
        settledCredits: 1,
      })
      expect(await created.credits.balance()).toMatchObject({ creditsRemaining: 0 })
      expect((await created.store.events(session.summary.id)).findLast((event) => event.type === 'assistant.final')).toMatchObject({
        data: { content: 'The admitted run still finishes.' },
      })

      const nextTurn = await postJson(base, `/api/sessions/${session.summary.id}/messages`, {
        content: 'This later turn must be blocked.',
        attachments: [],
      })
      expect(nextTurn.status).toBe(429)
      expect((await created.store.events(session.summary.id)).filter((event) => event.type === 'turn.started')).toHaveLength(1)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('rejects a coding submit before repository resolution, bootstrap, or session creation', async () => {
    const prepare = vi.fn()
    const created = await createApp({
      dataRoot: await temporaryDataRoot(),
      model: 'test-model',
      dailyFreeCredits: 1,
      creditsPerUsd: 1,
      github: { bootstrapper: { prepare } as never },
    })
    const chargingSession = await created.store.create()
    await created.credits.settle(chargingSession.summary.id, 1)
    const sessionsBefore = (await created.store.list()).map((session) => session.id)
    const base = await listen(created.app)
    try {
      const response = await postJson(base, '/api/coding-agent/sessions', {
        repoId: 1,
        repoOwner: 'arena-probe',
        repoName: 'synthetic',
        baseBranch: 'main',
        message: 'Do not bootstrap this repository.',
      })
      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({
        error: DAILY_CREDIT_LIMIT_ERROR_MESSAGE,
        code: 'daily_credit_limit',
      })
      expect(prepare).not.toHaveBeenCalled()
      expect((await created.store.list()).map((session) => session.id)).toEqual(sessionsBefore)
    } finally {
      await created.agent.shutdown()
    }
  })
})
