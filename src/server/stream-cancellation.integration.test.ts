import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent-service.js'
import { DeepSeekClient, type ModelResult } from './deepseek.js'
import { SessionStore } from './session-store.js'

const usage = { promptTokens: 3, completionTokens: 4, totalTokens: 7, cachedPromptTokens: 2 }

async function awaitThought(store: SessionStore, id: string) {
  await vi.waitFor(async () => {
    const events = await store.events(id)
    expect(events.filter((event) => event.type === 'assistant.thought.delta').map((event) => event.data.delta).join('')).toBe('before-cancel')
  }, { timeout: 1_000, interval: 5 })
}

async function assertCancelled(store: SessionStore, id: string) {
  await vi.waitFor(async () => {
    expect((await store.get(id)).summary.status).toBe('cancelled')
  }, { timeout: 500, interval: 5 })
  const state = await store.get(id)
  const events = await store.events(id)
  expect(state.summary.usage).toMatchObject({ ...usage, modelCalls: 1, modelRequests: 1 })
  expect(Object.values(state.usageSettlements ?? {})).toHaveLength(1)
  expect(events.filter((event) => event.type === 'run.status').map((event) => event.data.status)).toEqual(['running', 'cancelling', 'cancelled'])
  expect(events.some((event) => event.type === 'tool.started' || event.type === 'assistant.final')).toBe(false)
  expect(events.filter((event) => event.type === 'assistant.thought.delta').map((event) => event.data.delta).join('')).toBe('before-cancel')
  expect(JSON.stringify(events)).not.toContain('after-cancel')
  expect(JSON.stringify(state.messages)).not.toContain('after-cancel')
}

describe('AgentService cancellation streaming boundary', () => {
  it('reaches cancelled promptly through the real client/store when the provider body and cleanup ignore abort', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-cancel-real-client-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    let source!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: 'before-cancel' }, finish_reason: null }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, prompt_cache_hit_tokens: 2 },
        })}\n\n`))
      },
      cancel,
    }))
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    const client = new DeepSeekClient({ apiKey: 'test', baseUrl: 'https://provider.invalid', model: 'test-model',
      maxOutputTokens: 8192, maxRetries: 2, fetch: fetchMock })
    const agent = new AgentService(store, { client, runTimeoutMs: 2_000 })
    try {
      await agent.submit(session.summary.id, { content: 'Answer briefly without tools.' })
      await awaitThought(store, session.summary.id)
      await agent.cancel(session.summary.id)
      await assertCancelled(store, session.summary.id)
      expect(cancel).toHaveBeenCalledOnce()
      expect(response.body?.locked).toBe(false)
      expect(() => source.enqueue(new TextEncoder().encode('after-cancel'))).toThrow()
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      await agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { prompt: 'Answer briefly without tools.', returnDuringTransition: false },
    { prompt: 'Answer briefly without tools.', returnDuringTransition: true },
    { prompt: '做一份介绍数据可视化的 HTML Slides。', returnDuringTransition: false },
    { prompt: '做一份介绍数据可视化的 HTML Slides。', returnDuringTransition: true },
  ])('ignores late callbacks for $prompt (return during transition=$returnDuringTransition)', async ({ prompt, returnDuringTransition }) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-cancel-callback-gate-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    let callbacks!: Parameters<DeepSeekClient['stream']>[0]
    const stream = vi.fn(async (options: Parameters<DeepSeekClient['stream']>[0]): Promise<ModelResult> => {
      callbacks = options
      options.onReasoning('before-cancel')
      await gate
      return {
        content: 'after-cancel', reasoningContent: 'before-cancel after-cancel',
        toolCalls: [{ id: 'late-call', type: 'function', function: { name: 'write_file',
          arguments: JSON.stringify({ path: 'after-cancel.txt', content: 'not allowed' }) } }],
        finishReason: 'tool_calls', usage, modelCallCount: 1, modelRequestCount: 1,
      }
    })
    const agent = new AgentService(store, { client: { stream } as unknown as DeepSeekClient, runTimeoutMs: 2_000 })
    const emitLate = () => {
      callbacks.onReasoning('after-cancel')
      callbacks.onContent('after-cancel')
      callbacks.onToolCallDelta?.({ index: 0, nameDelta: 'write_file', argumentsDelta: 'after-cancel' })
    }
    try {
      await agent.submit(session.summary.id, { content: prompt })
      await awaitThought(store, session.summary.id)
      const cancellation = agent.cancel(session.summary.id)
      emitLate()
      if (returnDuringTransition) release()
      await cancellation
      expect(callbacks.signal.aborted).toBe(true)
      emitLate()
      release()
      await assertCancelled(store, session.summary.id)
      expect(stream).toHaveBeenCalledOnce()
    } finally {
      release()
      await agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })
})
