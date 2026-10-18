import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type { DeepSeekClient } from './deepseek.js'
import type { CancelRunTarget, SessionEvent } from '../shared/types.js'

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}
const result = { content: 'Done.', reasoningContent: '', toolCalls: [], finishReason: 'stop',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 } }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-targeted-stop-'))
  let completeNext = false
  const modelGates: Array<ReturnType<typeof deferred>> = []
  const stream = vi.fn<DeepSeekClient['stream']>(async (options) => {
    if (completeNext) { completeNext = false; return result }
    const gate = deferred()
    modelGates.push(gate)
    await new Promise<void>((done, reject) => {
      const abort = () => reject(options.signal.reason)
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
      void gate.promise.then(() => { options.signal.removeEventListener('abort', abort); done() })
    })
    return result
  })
  const created = await createApp({ dataRoot: root, model: 'offline-model', agent: {
    verificationMode: 'legacy', client: { stream }, runTimeoutMs: 10_000,
  } })
  const server: Server = createServer(created.app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  const id = (await created.store.create()).summary.id
  cleanups.push(async () => {
    for (const gate of modelGates) gate.resolve()
    await created.agent.shutdown()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(root, { recursive: true, force: true })
  })
  const stop = (body: unknown = {}) => fetch(`http://127.0.0.1:${address.port}/api/sessions/${id}/stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const settled = async () => vi.waitFor(() => expect(created.agent.isRunning(id)).toBe(false), { timeout: 2_000, interval: 5 })
  return { ...created, id, stream, modelGates, stop, settled, completeNext: () => { completeNext = true } }
}

describe('targeted stop ownership', () => {
  it('ignores a delayed old input/turn and requires both supplied identities to match', async () => {
    const f = await fixture()
    f.completeNext()
    const first = await f.agent.submit(f.id, { content: 'First task.', clientMessageId: 'input-first' })
    await f.settled()
    const current = await f.agent.submit(f.id, { content: 'Second task.', clientMessageId: 'input-current' })
    await vi.waitFor(() => expect(f.stream).toHaveBeenCalledTimes(2))
    for (const target of [
      { targetInputId: 'input-first' }, { targetTurnId: first.turnId },
      { targetInputId: 'input-first', targetTurnId: current.turnId },
      { targetInputId: 'input-current', targetTurnId: first.turnId },
    ]) {
      const response = await f.stop(target)
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ ok: true, cancelled: false })
      expect((await f.store.get(f.id)).summary.status).toBe('running')
    }
    expect(await (await f.stop({ targetInputId: 'input-current', targetTurnId: current.turnId })).json())
      .toEqual({ ok: true, cancelled: true })
    await f.settled()
    expect((await f.store.get(f.id)).summary.status).toBe('cancelled')
    expect(await (await f.stop({ targetTurnId: current.turnId })).json()).toEqual({ ok: true, cancelled: false })
    const cancellations = (await f.store.events(f.id)).filter((event) => event.type === 'run.status' && event.data.status === 'cancelling')
    expect(cancellations.map((event) => event.turnId)).toEqual([current.turnId])
  })

  it('validates target identities, keeps targetless compatibility and cancels resumed runs by their new turn', async () => {
    const f = await fixture()
    const started = await f.agent.submit(f.id, { content: 'Stop and resume this task.', clientMessageId: 'input-original' })
    for (const target of [{ targetTurnId: '' }, { targetInputId: 1 }, { targetInputId: null }, { targetTurnId: ' padded ' }, []]) {
      expect((await f.stop(target)).status).toBe(400)
    }
    expect(await (await f.stop()).json()).toEqual({ ok: true, cancelled: true })
    await f.settled()
    const resumed = await f.agent.resume(f.id)
    expect(await (await f.stop({ targetInputId: 'input-original' })).json()).toEqual({ ok: true, cancelled: false })
    expect(await (await f.stop({ targetTurnId: started.turnId })).json()).toEqual({ ok: true, cancelled: false })
    expect(await (await f.stop({ targetTurnId: resumed.turnId })).json()).toEqual({ ok: true, cancelled: true })
    await f.settled()
  })

  it('matches the input before the asynchronous startup filesystem check and never dispatches a provider', async () => {
    const f = await fixture()
    const entered = deferred(), release = deferred()
    const internal = f.agent as unknown as { assertWorkspaceRestoreComplete(id: string): Promise<void> }
    const original = internal.assertWorkspaceRestoreComplete.bind(internal)
    vi.spyOn(internal, 'assertWorkspaceRestoreComplete').mockImplementationOnce(async (id) => {
      entered.resolve(); await release.promise; await original(id)
    })
    const submit = f.agent.submit(f.id, { content: 'Cancel before dispatch.', clientMessageId: 'input-starting' })
    try {
      await entered.promise
      expect(await f.agent.cancel(f.id, { targetInputId: 'input-old' })).toEqual({ cancelled: false })
      expect(await f.agent.cancel(f.id, { targetInputId: 'input-starting' })).toEqual({ cancelled: true })
    } finally { release.resolve() }
    await submit
    await f.settled()
    expect(f.stream).not.toHaveBeenCalled()
    expect((await f.store.get(f.id)).summary.status).toBe('cancelled')
  })

  it('binds the turn while its start event is visible and before activation', async () => {
    const f = await fixture()
    const entered = deferred<SessionEvent>(), release = deferred()
    const append = f.store.append.bind(f.store)
    vi.spyOn(f.store, 'append').mockImplementation(async (...args) => {
      const event = await append(...args)
      if (args[1] === 'turn.started') { entered.resolve(event); await release.promise }
      return event
    })
    const submit = f.agent.submit(f.id, { content: 'Stop after the start event.', clientMessageId: 'input-boundary' })
    try {
      const event = await entered.promise
      expect(await f.agent.cancel(f.id, { targetTurnId: event.turnId })).toEqual({ cancelled: true })
    } finally { release.resolve() }
    await submit
    await f.settled()
    expect(f.stream).not.toHaveBeenCalled()
  })

  it('preserves a matching stop across reservation activation', async () => {
    const f = await fixture()
    const startVisible = deferred(), releaseStart = deferred(), matchEntered = deferred(), releaseMatch = deferred()
    const append = f.store.append.bind(f.store)
    vi.spyOn(f.store, 'append').mockImplementation(async (...args) => {
      const event = await append(...args)
      if (args[1] === 'turn.started') { startVisible.resolve(); await releaseStart.promise }
      return event
    })
    const internal = f.agent as unknown as { matchesCancellationTarget(id: string, owner: unknown, target: CancelRunTarget): Promise<boolean> }
    const match = internal.matchesCancellationTarget.bind(internal)
    vi.spyOn(internal, 'matchesCancellationTarget').mockImplementationOnce(async (...args) => {
      const matched = await match(...args)
      matchEntered.resolve(); await releaseMatch.promise
      return matched
    })
    const submit = f.agent.submit(f.id, { content: 'Cross the activation boundary.', clientMessageId: 'input-activate' })
    await startVisible.promise
    const stopping = f.agent.cancel(f.id, { targetInputId: 'input-activate' })
    try {
      await matchEntered.promise
      releaseStart.resolve()
      await submit
    } finally { releaseStart.resolve(); releaseMatch.resolve() }
    expect(await stopping).toEqual({ cancelled: true })
    await f.settled()
    expect((await f.store.get(f.id)).summary.status).toBe('cancelled')
  })

  it('does not reopen a completed turn while its runtime resources are still closing', async () => {
    const f = await fixture()
    const entered = deferred(), release = deferred()
    const close = f.agent.browser.close.bind(f.agent.browser)
    vi.spyOn(f.agent.browser, 'close').mockImplementationOnce(async (id) => {
      entered.resolve(); await release.promise; await close(id)
    })
    f.completeNext()
    const completed = await f.agent.submit(f.id, { content: 'Complete before stop arrives.', clientMessageId: 'input-completed' })
    try {
      await entered.promise
      expect((await f.store.get(f.id)).summary.status).toBe('completed')
      expect(await (await f.stop({ targetTurnId: completed.turnId })).json()).toEqual({ ok: true, cancelled: false })
      expect((await f.store.get(f.id)).summary.status).toBe('completed')
    } finally { release.resolve() }
    await f.settled()
  })

  it.each(['before', 'after'] as const)('linearizes stop %s the durable terminal commitment', async (boundary) => {
    const f = await fixture()
    const entered = deferred(), release = deferred()
    const stage = f.store.stageRunTerminal.bind(f.store)
    vi.spyOn(f.store, 'stageRunTerminal').mockImplementation(async (...args) => {
      if (args[1].status !== 'completed') return await stage(...args)
      if (boundary === 'before') { entered.resolve(); await release.promise }
      const value = await stage(...args)
      if (boundary === 'after') { entered.resolve(); await release.promise }
      return value
    })
    f.completeNext()
    const current = await f.agent.submit(f.id, { content: 'Race stop against completion.', clientMessageId: 'input-terminal-race' })
    try {
      await entered.promise
      expect(await (await f.stop({ targetTurnId: current.turnId })).json())
        .toEqual({ ok: true, cancelled: boundary === 'before' })
    } finally { release.resolve() }
    await f.settled()
    const events = await f.store.events(f.id)
    expect((await f.store.get(f.id)).summary.status).toBe(boundary === 'before' ? 'cancelled' : 'completed')
    expect(events.some((event) => event.type === 'assistant.final')).toBe(boundary === 'after')
  })

  it('does not let a recovered-input journal lookup cancel a replacement run', async () => {
    const f = await fixture()
    const first = await f.agent.submit(f.id, { content: 'Old recovered run.', clientMessageId: 'input-recovered' })
    await vi.waitFor(() => expect(f.modelGates).toHaveLength(1))
    // A restarted approval/HITL run retains its durable turn but has no copied
    // in-memory input identity; force that legitimate journal lookup path.
    const internal = f.agent as unknown as { active: Map<string, { clientMessageId?: string }> }
    delete internal.active.get(f.id)!.clientMessageId
    const entered = deferred(), release = deferred()
    const events = f.store.events.bind(f.store)
    vi.spyOn(f.store, 'events').mockImplementationOnce(async (...args) => {
      const history = await events(...args)
      entered.resolve(); await release.promise
      return history
    })
    const stopping = f.agent.cancel(f.id, { targetInputId: 'input-recovered', targetTurnId: first.turnId })
    try {
      await entered.promise
      f.modelGates[0].resolve()
      await f.settled()
      await f.agent.submit(f.id, { content: 'Replacement run.', clientMessageId: 'input-replacement' })
    } finally { release.resolve() }
    expect(await stopping).toEqual({ cancelled: false })
    expect((await f.store.get(f.id)).summary.status).toBe('running')
    expect((await events(f.id)).some((event) => event.type === 'run.status' && event.data.status === 'cancelling')).toBe(false)
  })
})
