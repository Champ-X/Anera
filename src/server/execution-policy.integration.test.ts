import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import { AgentService, systemPromptForTools } from './agent-service.js'
import { EXECUTION_EVIDENCE_POLICY, HANDOFF_POLICY } from './execution-policy.js'
import { SessionStore } from './session-store.js'
import type { ToolDefinition } from './tools.js'

describe('shared execution policy in the actual agent loop', () => {
  it('does not depend on Bash, task words or a schema subset', () => {
    expect(systemPromptForTools([], { includeHarnessConvergence: true })).toContain(EXECUTION_EVIDENCE_POLICY)
    expect(systemPromptForTools([])).not.toContain(EXECUTION_EVIDENCE_POLICY)
  })

  it.each([
    { request: 'Explain the trade-offs in detail, with citations.', final: Array.from({ length: 30 }, (_, index) => `Option ${index + 1} has a distinct latency/capacity trade-off at load ${index * 17}. [Source ${index + 1}](https://example.org/spec/${index})`).join('\n\n') },
    { request: 'Reply with exactly this JSON: {"ready":true}', final: '{"ready":true}' },
    { request: 'Give a brief status update including any remaining limitation.', final: 'No changes made. The required input is missing.' },
  ])('shares handoff guidance without clipping, rewriting or reviewing: $request', async ({ request, final }) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-handoff-policy-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const stream = vi.fn(async (options: { messages: ModelMessage[] }) => {
      expect(options.messages.some((message) => String(message.content).includes(HANDOFF_POLICY))).toBe(true)
      expect(options.messages).toContainEqual(expect.objectContaining({ role: 'user', content: request }))
      return { content: final, finishReason: 'stop', toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 } }
    })
    const execute = vi.fn()
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never, runTimeoutMs: 5_000 })
    try {
      await agent.submit(session.summary.id, { content: request })
      await vi.waitFor(() => expect(agent.isRunning(session.summary.id)).toBe(false), { timeout: 5_000, interval: 10 })
      const state = await store.get(session.summary.id)
      expect(state.summary.status).toBe('completed')
      expect(state.messages.findLast((message) => message.role === 'assistant')?.content).toBe(final)
      expect(stream).toHaveBeenCalledOnce()
      expect(execute).not.toHaveBeenCalled()
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  })

  it.each([
    { name: 'code', parallel: false, request: 'Inspect parser.ts and parser.test.ts, then fix the parser and verify its error handling.',
      calls: [['read_file', { path: 'parser.ts' }], ['read_file', { path: 'parser.test.ts' }]] },
    { name: 'data', parallel: false, request: 'Compare transactions.csv and adjustments.csv, reconcile the amounts and explain discrepancies.',
      calls: [['read_file', { path: 'transactions.csv' }], ['read_file', { path: 'adjustments.csv' }]] },
    { name: 'research', parallel: false, request: 'Research the latest public storage specifications and cite authoritative sources.',
      calls: [['web_search', { query: 'official storage specification' }], ['fetch_page', { url: 'https://example.org/spec' }]] },
    { name: 'parallel reads', parallel: true, request: 'Compare two configuration files and explain their differences.',
      calls: [['read_file', { path: 'development.json' }], ['read_file', { path: 'production.json' }]] },
  ])('recovers $name observation loops without changing tool authority or task identity', async ({ request, calls, parallel }) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-execution-policy-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const toolSteps = parallel ? 3 : 6
    const requests: Array<{ messages: ModelMessage[]; tools: ToolDefinition[] }> = []
    const stream = vi.fn(async (options: { messages: ModelMessage[]; tools: ToolDefinition[] }) => {
      requests.push(structuredClone({ messages: options.messages, tools: options.tools }))
      if (requests.length === toolSteps + 1) throw new Error('fixture stop after observing recovery request')
      const batch = parallel ? calls : [calls[(requests.length - 1) % calls.length]]
      return { content: '', reasoningContent: `Retained reasoning ${requests.length}`, finishReason: 'tool_calls',
        toolCalls: batch.map(([name, args], index) => ({ id: `call-${requests.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 } }
    })
    const execute = vi.fn(async (call: { name: string }) => ({ isError: false,
      content: JSON.stringify({ status: 'success', text: `Current evidence from ${call.name}` }) }))
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never, runTimeoutMs: 5_000 })
    try {
      await agent.submit(session.summary.id, { content: request })
      await vi.waitFor(() => expect(agent.isRunning(session.summary.id)).toBe(false), { timeout: 5_000, interval: 10 })
      expect(requests).toHaveLength(toolSteps + 1)
      expect(execute).toHaveBeenCalledTimes(6)
      for (const entry of requests) {
        expect(entry.messages.some((message) => String(message.content).includes(EXECUTION_EVIDENCE_POLICY))).toBe(true)
        expect(entry.messages.some((message) => String(message.content).includes('Number.isInteger on that exact field'))).toBe(false)
      }
      const recovery = requests[toolSteps]
      expect(recovery.messages).toContainEqual(expect.objectContaining({ role: 'user', content: request }))
      expect(recovery.messages).toContainEqual(expect.objectContaining({ reasoning_content: 'Retained reasoning 1' }))
      expect(recovery.messages.filter((message) => message.role === 'tool')).toHaveLength(6)
      expect(recovery.messages.some((message) => String(message.content).startsWith('[Harness operator action: Continue] Harness evidence recovery:'))).toBe(true)
      expect(recovery.tools.map((tool) => tool.function.name)).toEqual(requests[toolSteps - 1].tools.map((tool) => tool.function.name))
      const events = await store.events(session.summary.id)
      expect(events.filter((event) => event.type === 'model.tool_call.repair' && event.data.reason === 'unchanged_observation_cycle'))
        .toEqual([expect.objectContaining({ data: expect.objectContaining({ period: parallel ? 1 : 2, occurrences: 3, succeeded: false }) })])
      expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(6)
      expect(events.findLast((event) => event.type === 'error')?.data.message).toContain('fixture stop')
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  })
})
