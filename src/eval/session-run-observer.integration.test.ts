import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionStore } from '../server/session-store.js'
import { AgentService } from '../server/agent-service.js'
import { observeSessionRun } from './session-run-observer.js'

it('subscribes before run publication and leaves final journal evidence authoritative', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-run-observer-'))
  const store = new SessionStore(root, 'offline-observer-fixture')
  let observation: ReturnType<typeof observeSessionRun> | undefined
  try {
    await store.initialize()
    const { summary: { id } } = await store.create()
    await store.append(id, 'run.status', { status: 'failed' })
    const initial = await store.events(id)
    const initialSeq = initial.at(-1)!.seq
    const historyReads = vi.spyOn(store, 'events')
    const onEvent = vi.fn()
    observation = observeSessionRun({ sessionId: id, afterSeq: initialSeq, deadline: Date.now() + 5_000,
      subscribe: (listener) => store.subscribe(id, listener), onEvent })
    await store.append(id, 'run.status', { status: 'running' })
    await store.append(id, 'assistant.thought.delta', { delta: 'incremental fixture' })
    await store.append(id, 'tool.failed', { result: 'A failed tool is not a terminal run.' })
    expect(observation.stopped).toBe(false)
    const terminal = await store.append(id, 'run.status', { status: 'cancelled' })
    expect(await observation.result).toEqual({ reason: 'terminal', status: 'cancelled', lastSeq: terminal.seq, observedEvents: 4 })
    expect(historyReads).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledTimes(4)
    const cleanup = await store.append(id, 'process.stopped', { reason: 'fixture cleanup' })
    expect(onEvent).toHaveBeenCalledTimes(4)
    const final = await store.events(id, initialSeq)
    expect(final).toHaveLength(5)
    expect(final.at(-1)).toEqual(cleanup)
  } finally {
    observation?.close()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

it('drains terminal publication before reading the final summary without a model rerun', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-run-observer-drain-'))
  const store = new SessionStore(root, 'offline-observer-fixture')
  const stream = vi.fn(async () => ({ content: 'Fixture answer.', reasoningContent: '', toolCalls: [],
    finishReason: 'stop' as const, usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13, cachedPromptTokens: 0 },
    modelCallCount: 1, modelRequestCount: 1 }))
  const agent = new AgentService(store, { client: { stream }, runTimeoutMs: 5_000 })
  let observation: ReturnType<typeof observeSessionRun> | undefined
  let terminalPublished = false
  let release!: () => void
  const gate = new Promise<void>((ready) => { release = ready })
  try {
    await store.initialize()
    const { summary: { id } } = await store.create()
    const update = store.update.bind(store)
    vi.spyOn(store, 'update').mockImplementation(async (...args) => {
      if (terminalPublished) await gate
      return update(...args)
    })
    const initialSeq = (await store.events(id)).at(-1)!.seq
    observation = observeSessionRun({ sessionId: id, afterSeq: initialSeq, deadline: Date.now() + 5_000,
      subscribe: (listener) => store.subscribe(id, listener),
      onEvent: (event) => {
        if (event.type === 'run.status' && event.data.status === 'completed') terminalPublished = true
      },
    })
    await agent.submit(id, { content: 'Answer briefly without tools.' })
    expect(await observation.result).toMatchObject({ reason: 'terminal', status: 'completed' })
    expect((await store.get(id)).summary.status).toBe('running')
    let drained = false
    const shutdown = agent.shutdown().then(() => { drained = true })
    expect(drained).toBe(false)
    release()
    await shutdown
    const final = await store.get(id)
    expect(final.summary.status).toBe('completed')
    expect(final.pendingTerminal).toBeUndefined()
    expect(final.summary.usage).toMatchObject({ modelCalls: 1, modelRequests: 1, totalTokens: 13 })
    const events = await store.events(id)
    expect(events.filter((event) => event.type === 'assistant.final')).toHaveLength(1)
    expect(events.some((event) => event.type === 'tool.started')).toBe(false)
    expect(stream).toHaveBeenCalledTimes(1)
  } finally {
    release()
    observation?.close()
    await agent.shutdown()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})
