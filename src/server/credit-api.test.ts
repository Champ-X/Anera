import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'

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

async function waitForCompleted(created: Awaited<ReturnType<typeof createApp>>, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await created.store.get(sessionId)).summary.status === 'completed') return
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  throw new Error(`Session ${sessionId} did not complete`)
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

  it('keeps Message, Continue, and New Chat available after the reference balance reaches zero', async () => {
    const stream = vi.fn(async (options: { onContent: (delta: string) => void }) => {
      options.onContent('Completed without a local credit gate.')
      return {
        content: 'Completed without a local credit gate.',
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
    const messageSession = await created.store.create()
    const resumeSession = await created.store.create()
    await created.store.update(resumeSession.summary.id, (state) => {
      state.summary.status = 'failed'
      state.messages.push({ role: 'user', content: 'Persisted task to continue.' })
    })
    await created.credits.settle(messageSession.summary.id, 1)
    const base = await listen(created.app)
    try {
      const messageResponse = await postJson(base, `/api/sessions/${messageSession.summary.id}/messages`, {
        content: 'Start another turn.', attachments: [],
      })
      expect(messageResponse.status).toBe(202)
      await waitForCompleted(created, messageSession.summary.id)

      const resumeResponse = await postJson(base, `/api/sessions/${resumeSession.summary.id}/resume`, {})
      expect(resumeResponse.status).toBe(202)
      await waitForCompleted(created, resumeSession.summary.id)

      const newChat = await postJson(base, '/api/sessions', {})
      expect(newChat.status).toBe(201)
      const newSession = await newChat.json() as { session: { id: string; isFreeSession: boolean } }
      expect(newSession.session.isFreeSession).toBe(false)
      const newChatResponse = await postJson(base, `/api/sessions/${newSession.session.id}/messages`, {
        content: 'A new chat remains available at zero.',
        attachments: [],
      })
      expect(newChatResponse.status).toBe(202)
      await waitForCompleted(created, newSession.session.id)

      expect((await created.store.events(messageSession.summary.id)).filter((event) => event.type === 'turn.started')).toHaveLength(1)
      expect((await created.store.events(resumeSession.summary.id)).filter((event) => event.type === 'run.resumed')).toHaveLength(1)
      expect((await created.store.events(newSession.session.id)).filter((event) => event.type === 'turn.started')).toHaveLength(1)
      expect(stream).toHaveBeenCalledTimes(3)
      expect(await created.credits.balance()).toMatchObject({ creditsRemaining: 0 })
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

  it('keeps later normal turns available after usage consumes the last reference credit', async () => {
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
        content: 'This later turn must remain available.',
        attachments: [],
      })
      expect(nextTurn.status).toBe(202)
      await waitForCompleted(created, session.summary.id)
      expect((await created.store.events(session.summary.id)).filter((event) => event.type === 'turn.started')).toHaveLength(2)
      expect(stream).toHaveBeenCalledTimes(2)
    } finally {
      await created.agent.shutdown()
    }
  })
})
