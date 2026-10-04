import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionStore, type DurablePendingTerminal } from './session-store.js'
import { AgentService } from './agent-service.js'
import { SteeringPendingError } from './steering.js'
import { activeTaskRequestEvents } from './task-context.js'
import type { DeepSeekClient } from './deepseek.js'
import type { ToolCallRecord } from '../shared/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-steering-'))
  roots.push(root)
  const store = new SessionStore(root, 'offline-model')
  await store.initialize()
  const id = (await store.create()).summary.id
  await store.update(id, (state) => { state.summary.status = 'running'; state.messages = [{ role: 'user', content: 'Original task' }] })
  await store.append(id, 'turn.started', { content: 'Original task' }, { turnId: 'turn_initial' })
  return { root, store, id }
}
function terminal(): DurablePendingTerminal {
  return { turnId: 'turn_initial', stepId: 'step_final', createdAt: new Date().toISOString(), status: 'completed', events: [], workspacePersistenceEvents: [] }
}
const result = (content: string, calls: Array<{ name: string; args: Record<string, unknown> }> = []) => ({ content,
  reasoningContent: '', finishReason: calls.length ? 'tool_calls' : 'stop',
  toolCalls: calls.map((call, index) => ({ id: `call_${index}_${content.length}`, type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.args) } })),
  usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cachedPromptTokens: 0 }, modelCallCount: 1 })
async function finish(agent: AgentService, id: string) {
  for (let attempt = 0; attempt < 1000 && agent.isRunning(id); attempt++) await new Promise((done) => setTimeout(done, 5))
  expect(agent.isRunning(id)).toBe(false)
}

describe('durable running instructions', () => {
  it('serializes concurrent receipt, deduplicates retries and applies every instruction once', async () => {
    const { store, id } = await fixture()
    const receipts = await Promise.all(['one', 'two', 'three'].map((content) => store.receiveSteering(id, { content, clientMessageId: content })))
    expect(receipts.map((entry) => entry.sequence)).toEqual([1, 2, 3])
    expect((await store.get(id)).messages).toHaveLength(1)
    await expect(store.receiveSteering(id, { content: 'changed', clientMessageId: 'one' })).rejects.toMatchObject({ code: 'steering_id_conflict' })
    const applied = await store.applyPendingSteering(id, 'turn_initial', 'step_next')
    expect(applied.map((entry) => entry.content)).toEqual(['one', 'two', 'three'])
    expect(applied.every((entry) => entry.status === 'applied')).toBe(true)
    expect(await store.applyPendingSteering(id, 'turn_initial', 'step_again')).toEqual([])
    await store.setStatus(id, 'completed')
    expect(await store.receiveSteering(id, { content: 'one', clientMessageId: 'one' })).toMatchObject({ id: receipts[0].id, status: 'applied' })
    expect((await store.get(id)).messages).toHaveLength(4)
    const events = await store.events(id)
    expect(events.filter((event) => event.type === 'user.steering.received')).toHaveLength(3)
    expect(events.filter((event) => event.type === 'user.steering.applied')).toHaveLength(3)
  })

  it.each(['received', 'applied'] as const)('reconciles crash after the %s checkpoint without duplicate model input', async (phase) => {
    const { root, store, id } = await fixture()
    const internal = store as unknown as { appendUnqueued: (...args: unknown[]) => Promise<unknown> }
    const append = internal.appendUnqueued.bind(internal)
    let injected = false
    vi.spyOn(internal, 'appendUnqueued').mockImplementation(async (...args) => {
      if (args[1] === `user.steering.${phase}` && !injected) { injected = true; throw new Error('injected crash before event publication') }
      return await append(...args)
    })
    if (phase === 'received') await expect(store.receiveSteering(id, { content: 'Keep the tables', clientMessageId: 'retry' })).rejects.toThrow('injected crash')
    else {
      await store.receiveSteering(id, { content: 'Keep the tables', clientMessageId: 'retry' })
      await expect(store.applyPendingSteering(id, 'turn_initial', 'step_next')).rejects.toThrow('injected crash')
    }
    const restarted = new SessionStore(root, 'offline-model')
    await restarted.initialize()
    expect((await restarted.get(id)).summary.status).toBe('interrupted')
    await restarted.setStatus(id, 'running')
    await restarted.applyPendingSteering(id, 'turn_resumed', 'step_resumed')
    await restarted.applyPendingSteering(id, 'turn_resumed', 'step_duplicate')
    expect((await restarted.get(id)).messages.filter((message) => message.content?.includes('Keep the tables'))).toHaveLength(1)
    const events = await restarted.events(id)
    expect(events.filter((event) => event.type === 'user.steering.received')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'user.steering.applied')).toHaveLength(1)
  })

  it('keeps cancelled work queued and linearizes instruction receipt against completion and tool admission', async () => {
    const { store, id } = await fixture()
    const call: ToolCallRecord = { id: 'call_work', name: 'bash', arguments: { command: 'echo old' } }
    expect(await store.recordSteerableToolStart(id, call, 0, { turnId: 'turn_initial' })).toBe(true)
    await store.receiveSteering(id, { content: 'Use the revised data', clientMessageId: 'new' })
    expect(await store.recordSteerableToolStart(id, call, 1, { turnId: 'turn_initial' })).toBe(false)
    await expect(store.stageRunTerminal(id, terminal())).rejects.toBeInstanceOf(SteeringPendingError)
    await store.setStatus(id, 'cancelled')
    expect(await store.applyPendingSteering(id, 'turn_initial', 'step_cancelled')).toEqual([])
    expect(await store.hasPendingSteering(id)).toBe(true)
    await store.setStatus(id, 'running')
    await store.applyPendingSteering(id, 'turn_resume', 'step_resume')
    await store.stageRunTerminal(id, terminal())
    await expect(store.receiveSteering(id, { content: 'Too late', clientMessageId: 'late' })).rejects.toMatchObject({ code: 'steering_session_not_active' })
  })

  it('refuses insertion into an unresolved tool frame', async () => {
    const { store, id } = await fixture()
    await store.receiveSteering(id, { content: 'Wait for the running operation', clientMessageId: 'new' })
    await store.update(id, (state) => state.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'running', type: 'function', function: { name: 'bash', arguments: '{}' } }] }))
    await expect(store.applyPendingSteering(id, 'turn_initial', 'step_next')).rejects.toThrow('tool result frame')
    expect(await store.hasPendingSteering(id)).toBe(true)
  })

  it('places cancelled queued instructions before a newer normal follow-up and includes both in undo scope', async () => {
    const { store, id } = await fixture()
    await store.receiveSteering(id, { content: 'Earlier correction', clientMessageId: 'earlier' })
    await store.setStatus(id, 'cancelled')
    await store.stageRunStart(id, { kind: 'submit', turnId: 'turn_later', eventId: 'evt_later',
      eventData: { content: 'Newer correction' }, createdAt: '2026-09-26T10:00:00Z' }, (state) => {
      state.turnMessageStarts ??= {}
      state.turnMessageStarts.turn_later = state.messages.length
      state.messages.push({ role: 'user', content: 'Newer correction' })
    })
    const state = await store.get(id)
    expect(state.messages.map((message) => message.content)).toEqual(['Original task', expect.stringContaining('Earlier correction'), 'Newer correction'])
    expect(state.turnMessageStarts?.turn_later).toBe(1)
    expect(state.steering?.[0]).toMatchObject({ status: 'applied', appliedTurnId: 'turn_later' })
    expect((await store.events(id)).filter((event) => event.type === 'user.steering.applied')).toHaveLength(1)
    await store.append(id, 'turn.started', { content: 'Newer correction' }, { turnId: 'turn_later', eventId: 'evt_later' })
    expect(activeTaskRequestEvents(await store.events(id), () => false).map((event) => event.data.content))
      .toEqual(['Earlier correction', 'Newer correction'])
  })

  it.each(['resume', 'submit'] as const)('repairs applied event publication before %s without requiring a server restart', async (kind) => {
    const { store, id } = await fixture()
    await store.receiveSteering(id, { content: 'Keep this correction in the task requirements.', clientMessageId: 'recover' })
    const internal = store as unknown as { appendUnqueued: (...args: unknown[]) => Promise<unknown> }
    const append = internal.appendUnqueued.bind(internal)
    let injected = false
    vi.spyOn(internal, 'appendUnqueued').mockImplementation(async (...args) => {
      if (args[1] === 'user.steering.applied' && !injected) { injected = true; throw new Error('publication failed') }
      return append(...args)
    })
    await expect(store.applyPendingSteering(id, 'turn_initial', 'step_original')).rejects.toThrow('publication failed')
    await store.setStatus(id, 'failed')
    await store.stageRunStart(id, { kind, turnId: 'turn_resumed', eventId: 'evt_resumed',
      eventData: { content: 'A separate task.' }, createdAt: new Date().toISOString() }, (state) => {
      if (kind === 'submit') state.messages.push({ role: 'user', content: 'A separate task.' })
    })
    await store.append(id, kind === 'submit' ? 'turn.started' : 'run.resumed', { content: 'A separate task.' },
      { turnId: 'turn_resumed', eventId: 'evt_resumed' })
    // Agent.run reads the journal before its first applyPendingSteering call.
    expect(activeTaskRequestEvents(await store.events(id), () => false).map((event) => event.data.content))
      .toEqual(kind === 'submit' ? ['A separate task.'] : ['Original task', 'Keep this correction in the task requirements.'])
    await store.commitRunStart(id, 'turn_resumed')
    await store.setStatus(id, 'running')
    await store.applyPendingSteering(id, 'turn_resumed', 'step_resumed')
    const applied = (await store.events(id)).filter((event) => event.type === 'user.steering.applied')
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ turnId: 'turn_initial', stepId: 'step_original' })
    expect((await store.get(id)).messages.filter((message) => message.content?.includes('Keep this correction'))).toHaveLength(1)
  })

  it('durably archives unapplied instructions on restore and preserves idempotent receipts after restart', async () => {
    const { root, store, id } = await fixture()
    const input = { content: 'Do not revive this pre-restore instruction.', clientMessageId: 'archived' }
    await store.receiveSteering(id, input)
    await store.setStatus(id, 'cancelled')
    const internal = store as unknown as { appendUnqueued: (...args: unknown[]) => Promise<unknown> }
    const append = internal.appendUnqueued.bind(internal)
    let injected = false
    vi.spyOn(internal, 'appendUnqueued').mockImplementation(async (...args) => {
      if (args[1] === 'user.steering.archived' && !injected) { injected = true; throw new Error('archive publication failed') }
      return append(...args)
    })
    await expect(store.archivePendingSteering(id, 'restore_1')).rejects.toThrow('archive publication failed')
    expect(await store.hasPendingSteering(id)).toBe(false)
    const restarted = new SessionStore(root, 'offline-model')
    await restarted.initialize()
    await restarted.archivePendingSteering(id, 'restore_1')
    const receipt = await restarted.receiveSteering(id, input)
    expect(receipt).toMatchObject({ status: 'archived', archiveReason: 'workspace_restored', restoreId: 'restore_1' })
    expect(receipt).not.toHaveProperty('archivedEventId')
    await restarted.setStatus(id, 'running')
    expect(await restarted.applyPendingSteering(id, 'turn_new', 'step_new')).toEqual([])
    expect((await restarted.get(id)).messages).toHaveLength(1)
    const events = await restarted.events(id)
    expect(events.filter((entry) => entry.type === 'user.steering.archived')).toHaveLength(1)
    expect(events.filter((entry) => entry.type === 'user.steering.applied')).toHaveLength(0)
    expect(events.find((entry) => entry.type === 'user.steering.received')!.data).not.toHaveProperty('restoreId')
  })

  it('keeps correction precedence when retrying a later receipt after batch publication fails', async () => {
    const { store, id } = await fixture()
    const earlier = { content: 'Use CSV.', clientMessageId: 'earlier' }
    const later = { content: 'Use JSON instead.', clientMessageId: 'later' }
    await store.receiveSteering(id, earlier)
    await store.receiveSteering(id, later)
    const internal = store as unknown as { appendUnqueued: (...args: unknown[]) => Promise<unknown> }
    const append = internal.appendUnqueued.bind(internal)
    let injected = false
    vi.spyOn(internal, 'appendUnqueued').mockImplementation(async (...args) => {
      if (args[1] === 'user.steering.applied' && !injected) { injected = true; throw new Error('batch publication failed') }
      return append(...args)
    })
    await expect(store.applyPendingSteering(id, 'turn_initial', 'step_apply')).rejects.toThrow('batch publication failed')
    expect(await store.receiveSteering(id, later)).toMatchObject({ status: 'applied' })
    expect(activeTaskRequestEvents(await store.events(id), () => false).map((event) => event.data.content))
      .toEqual(['Original task', 'Use CSV.', 'Use JSON instead.'])
    expect((await store.get(id)).messages).toHaveLength(3)
  })

  it('discards an old model proposal after accepting a correction, then completes with the new context', async () => {
    const { store, id } = await fixture()
    await store.setStatus(id, 'idle')
    let requests = 0
    const executed: string[] = []
    let agent: AgentService
    const stream: DeepSeekClient['stream'] = async (options) => {
      await options.beforeRequest?.()
      requests++
      if (requests === 1) {
        await agent.steer(id, { content: 'Change the answer to 42.', clientMessageId: 'fix' })
        return result('', [{ name: 'bash', args: { command: 'echo stale' } }])
      }
      expect(options.messages.some((message) => message.role === 'user' && message.content?.includes('Change the answer to 42.'))).toBe(true)
      return result('42')
    }
    agent = new AgentService(store, { verificationMode: 'legacy', client: { stream } as never,
      tools: { execute: async (call: ToolCallRecord) => { executed.push(call.name); return { content: '{}', isError: false } } } as never })
    try {
      await agent.submit(id, { content: 'What is the answer?' })
      await finish(agent, id)
      expect(executed).toEqual([])
      const events = await store.events(id)
      expect(events.filter((event) => event.type === 'assistant.final').map((event) => event.data.content)).toEqual(['42'])
      expect((await store.get(id)).steering?.[0].status).toBe('applied')
    } finally { await agent.shutdown() }
  })

  it('finishes the running real file mutation, skips the next old operation, then applies correction', async () => {
    const { store, id } = await fixture()
    await store.setStatus(id, 'idle')
    let requests = 0
    const stream: DeepSeekClient['stream'] = async (options) => {
      await options.beforeRequest?.()
      requests++
      if (requests === 1) return result('', [
        { name: 'write_file', args: { path: 'kept.txt', content: 'valid prior work' } },
        { name: 'write_file', args: { path: 'stale.txt', content: 'stale proposal' } },
      ])
      expect(options.messages.some((message) => message.content?.includes('Preserve the first file and skip the second.'))).toBe(true)
      return result('The first file is preserved; the second was not created.')
    }
    const agent = new AgentService(store, { verificationMode: 'legacy', client: { stream } as never })
    let receipt: Promise<unknown> | undefined
    const unsubscribe = store.subscribe(id, (event) => {
      if (event.type === 'file.changed' && event.data.path === 'kept.txt') receipt = agent.steer(id, {
        content: 'Preserve the first file and skip the second.', clientMessageId: 'file-correction',
      })
    })
    try {
      await agent.submit(id, { content: 'Carry out a two-step demonstration.' })
      await finish(agent, id)
      await receipt
      expect(await readFile(resolve(store.workspaceDir(id), 'kept.txt'), 'utf8')).toBe('valid prior work')
      await expect(readFile(resolve(store.workspaceDir(id), 'stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      const state = await store.get(id)
      expect(state.summary.status, JSON.stringify((await store.events(id)).filter((event) => event.type === 'error'))).toBe('completed')
      expect(state.messages.some((message) => message.role === 'tool' && message.content?.includes('user_steering_pending'))).toBe(true)
      expect(state.steering?.[0].status).toBe('applied')
    } finally { unsubscribe(); await agent.shutdown() }
  })
})
