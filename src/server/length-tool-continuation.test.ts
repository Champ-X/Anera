import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage, ToolDefinition } from '../shared/types.js'
import { DeepSeekClient, ModelStreamBudgetExceededError, type ModelToolChoice, type ModelTransportEvent } from './deepseek.js'

const compose: ToolDefinition = {
  type: 'function',
  function: { name: 'compose_reference_html', description: 'Compose from the accepted template.', parameters: { type: 'object', properties: {} } },
}
const inspect: ToolDefinition = { ...compose, function: { ...compose.function, name: 'inspect_image' } }
const unavailable: ToolDefinition = { ...compose, function: { ...compose.function, name: 'write_file' } }

function response(options: { content?: string; reasoning?: string; arguments?: string; finish: 'length' | 'tool_calls' | 'stop' }) {
  const delta = {
    ...(options.content !== undefined ? { content: options.content } : {}),
    ...(options.reasoning ? { reasoning_content: options.reasoning } : {}),
    ...(options.arguments !== undefined ? { tool_calls: [{ index: 0, id: 'compose-call', function: {
      name: 'compose_reference_html', arguments: options.arguments,
    } }] } : {}),
  }
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: options.finish }], usage: {
      prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_cache_hit_tokens: 2,
    } })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''), { headers: { 'content-type': 'text/event-stream' } })
}

type RequestBody = { tools?: ToolDefinition[]; tool_choice?: ModelToolChoice; messages: ModelMessage[]; max_tokens: number }

describe('length continuations in an executable tool phase', () => {
  it.each([
    { thinking: 'enabled' as const, content: '', requireToolCall: false, toolChoice: 'auto' as ModelToolChoice },
    { thinking: 'enabled' as const, content: ' \n', requireToolCall: false, toolChoice: 'auto' as ModelToolChoice },
    { thinking: 'enabled' as const, content: 'The accepted material is ready. ', requireToolCall: true, toolChoice: 'auto' as ModelToolChoice },
    { thinking: 'enabled' as const, content: 'The accepted material is ready. ', requireToolCall: false, toolChoice: { type: 'function', function: { name: 'compose_reference_html' } } as ModelToolChoice },
    { thinking: 'disabled' as const, content: '', requireToolCall: false, toolChoice: 'auto' as ModelToolChoice },
    { thinking: 'disabled' as const, content: 'The accepted material is ready. ', requireToolCall: true, toolChoice: { type: 'function', function: { name: 'compose_reference_html' } } as ModelToolChoice },
  ])('retains tools after a truncated $thinking step ($toolChoice, required=$requireToolCall, content=$content)', async (scenario) => {
    const requests: RequestBody[] = []
    const transport: ModelTransportEvent[] = []
    const order: string[] = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      order.push(`fetch:${requests.length}`)
      return requests.length === 1
        ? response({ reasoning: 'Use the already accepted brief and template.', content: scenario.content, finish: 'length' })
        : response({ reasoning: 'Submit complete bindings now.', arguments: '{"path":"slides.html"}', finish: 'tool_calls' })
    })
    const beforeRequest = vi.fn(async () => { order.push(`reservation:${requests.length + 1}`) })
    const client = new DeepSeekClient({ apiKey: 'fixture', baseUrl: 'https://provider.example', model: 'fixture',
      thinking: scenario.thinking, maxOutputTokens: 32, maxLengthContinuations: 1, fetch })
    const onContent = vi.fn()
    const onReasoning = vi.fn()
    const onToolCallDelta = vi.fn()
    const messages: ModelMessage[] = [{ role: 'user', content: 'Create the requested slides.' }]
    const original = structuredClone(messages)
    const result = await client.stream({ messages, tools: [compose, inspect], providerTools: [compose, inspect, unavailable],
      toolChoice: scenario.toolChoice, requireToolCall: scenario.requireToolCall, maxOutputTokens: 32,
      onTransportEvent: (event) => { transport.push(event) },
      onContent, onReasoning, onToolCallDelta, beforeRequest, signal: new AbortController().signal })

    expect(requests).toHaveLength(2)
    expect(requests[0].tools).toEqual([compose, inspect])
    expect(requests[1].tools).toEqual([compose, inspect])
    expect(requests[1].tool_choice).toEqual(scenario.thinking === 'enabled' ? 'auto' : scenario.toolChoice)
    expect(requests.map((request) => request.max_tokens)).toEqual([32, 32])
    expect(requests[1].messages.at(-1)?.content).toContain('Harness tool-phase continuation')
    expect(requests[1].messages.at(-1)?.content).not.toContain('text-only continuation')
    expect(requests[1].messages.at(-2)).toMatchObject({ role: 'assistant',
      reasoning_content: 'Use the already accepted brief and template.' })
    expect(result).toMatchObject({ finishReason: 'tool_calls', modelRequestCount: 2, modelCallCount: 2,
      reasoningContent: 'Use the already accepted brief and template.Submit complete bindings now.',
      toolCalls: [{ id: 'compose-call', function: { name: 'compose_reference_html', arguments: '{"path":"slides.html"}' } }],
      usage: { promptTokens: 10, completionTokens: 6, totalTokens: 16, cachedPromptTokens: 4 } })
    expect(onContent.mock.calls.flat().join('')).toBe(result.content)
    expect(onReasoning.mock.calls.flat().join('')).toBe(result.reasoningContent)
    expect(onToolCallDelta.mock.calls.map(([delta]) => delta.argumentsDelta ?? '').join('')).toBe('{"path":"slides.html"}')
    expect(order).toEqual(['reservation:1', 'fetch:1', 'reservation:2', 'fetch:2'])
    expect(messages).toEqual(original)
    expect(transport.map((event) => [event.type, event.requestIndex, event.continuation])).toEqual([
      ['request', 1, 'none'], ['response', 1, 'none'], ['request', 2, 'tools'], ['response', 2, 'tools'],
    ])
    expect(transport[2]).toMatchObject({ toolNames: [compose, inspect].map((tool) => tool.function.name),
      omittedToolCount: 0, maxOutputTokens: 32 })
    expect(transport[1]).toMatchObject({ finishReason: 'length', contentBytes: Buffer.byteLength(scenario.content),
      reasoningBytes: Buffer.byteLength('Use the already accepted brief and template.'), toolNames: [], usage: { totalTokens: 8 } })
    expect(transport[3]).toMatchObject({ finishReason: 'tool_calls', toolNames: ['compose_reference_html'] })
    expect(JSON.stringify(transport)).not.toMatch(/slides\.html|accepted brief|fixture|Create the requested/)
  })

  it.each([false, true])('never splices partial tool arguments across responses (after reasoning continuation=$afterReasoning)', async (afterReasoning) => {
    const fetch = vi.fn(async () => {
      if (afterReasoning && fetch.mock.calls.length === 1) return response({ reasoning: 'Prepare a tool call.', finish: 'length' })
      return response({ reasoning: 'Arguments were cut off.', arguments: '{"path":"slide', finish: 'length' })
    })
    const client = new DeepSeekClient({ apiKey: 'fixture', baseUrl: 'https://provider.example', model: 'fixture',
      thinking: 'enabled', maxOutputTokens: 32, maxLengthContinuations: 2, fetch })
    const result = await client.stream({ messages: [{ role: 'user', content: 'Compose.' }], tools: [compose],
      requireToolCall: true, signal: new AbortController().signal, onContent: vi.fn(), onReasoning: vi.fn() })
    expect(fetch).toHaveBeenCalledTimes(afterReasoning ? 2 : 1)
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls[0].function.arguments).toBe('{"path":"slide')
  })

  it.each([
    { allowance: { maxModelRequests: 1, maxTotalTokens: 100 }, budget: 'model_requests' },
    { allowance: { maxModelRequests: 10, maxTotalTokens: 8 }, budget: 'total_tokens' },
  ])('respects the existing $budget allowance before a tool-phase continuation', async ({ allowance, budget }) => {
    const fetch = vi.fn(async () => response({ reasoning: 'No call was emitted yet.', finish: 'length' }))
    const beforeRequest = vi.fn(async () => {})
    const client = new DeepSeekClient({ apiKey: 'fixture', baseUrl: 'https://provider.example', model: 'fixture',
      thinking: 'enabled', maxOutputTokens: 32, fetch })
    const failure = await client.stream({ messages: [{ role: 'user', content: 'Compose.' }], tools: [compose],
      requireToolCall: true, signal: new AbortController().signal, onContent: vi.fn(), onReasoning: vi.fn(),
      beforeRequest, ...allowance }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ModelStreamBudgetExceededError)
    expect(failure).toMatchObject({ budget, modelRequestCount: 1, modelCallCount: 1, modelUsage: { totalTokens: 8 } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(beforeRequest).toHaveBeenCalledOnce()
  })

  it('stops at a failed continuation reservation without retrying or losing usage', async () => {
    const reservationFailure = new TypeError('fetch failed while reserving the continuation')
    const beforeRequest = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(reservationFailure)
    const fetch = vi.fn(async () => response({ reasoning: 'Use compose.', finish: 'length' }))
    const client = new DeepSeekClient({ apiKey: 'fixture', baseUrl: 'https://provider.example', model: 'fixture',
      thinking: 'enabled', maxOutputTokens: 32, retryBaseDelayMs: 0, fetch })
    const failure = await client.stream({ messages: [{ role: 'user', content: 'Compose.' }], tools: [compose],
      requireToolCall: true, signal: new AbortController().signal, onContent: vi.fn(), onReasoning: vi.fn(),
      beforeRequest }).catch((error: unknown) => error)
    expect(failure).toBe(reservationFailure)
    expect(failure).toMatchObject({ modelRequestCount: 1, modelCallCount: 1, modelUsage: { totalTokens: 8 } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(beforeRequest).toHaveBeenCalledTimes(2)
  })

  it('does not silently finish when repeated reasoning exhausts the existing continuation bound', async () => {
    const fetch = vi.fn(async () => response({ reasoning: 'Still preparing the call.', finish: 'length' }))
    const client = new DeepSeekClient({ apiKey: 'fixture', baseUrl: 'https://provider.example', model: 'fixture',
      thinking: 'enabled', maxOutputTokens: 32, maxLengthContinuations: 1, fetch })
    const result = await client.stream({ messages: [{ role: 'user', content: 'Compose.' }], tools: [compose],
      requireToolCall: true, signal: new AbortController().signal, onContent: vi.fn(), onReasoning: vi.fn() })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ finishReason: 'length', content: '', toolCalls: [], modelRequestCount: 2,
      modelCallCount: 2, usage: { totalTokens: 16 } })
  })

  it('keeps diagnostics observational and never reopens tools for a genuine prose suffix', async () => {
    const requests: RequestBody[] = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return requests.length === 1
        ? response({ content: 'A complete prefix. ', finish: 'length' })
        : response({ content: 'And the suffix.', finish: 'stop' })
    })
    const onTransportEvent = vi.fn((_event: ModelTransportEvent) => { throw new Error('The diagnostic consumer failed.') })
    const client = new DeepSeekClient({ apiKey: 'fixture', baseUrl: 'https://provider.example', model: 'fixture',
      thinking: 'enabled', maxOutputTokens: 32, fetch })
    const result = await client.stream({ messages: [{ role: 'user', content: 'Answer.' }], tools: [compose],
      toolChoice: 'auto', signal: new AbortController().signal, onContent: vi.fn(), onReasoning: vi.fn(), onTransportEvent })
    expect(result).toMatchObject({ content: 'A complete prefix. And the suffix.', finishReason: 'stop', modelRequestCount: 2 })
    expect(onTransportEvent).toHaveBeenCalledTimes(4)
    expect(requests[1]).not.toHaveProperty('tools')
    expect(onTransportEvent.mock.calls[2]?.[0]).toMatchObject({ type: 'request', continuation: 'prose', toolNames: [], toolChoice: 'omitted' })
  })

  it('bounds diagnostic tool names without changing the serialized schema surface', async () => {
    const tools = Array.from({ length: 80 }, (_, index) => ({ ...compose, function: { ...compose.function,
      name: index === 0 ? 'UNTRUSTED PRIVATE TEXT\n'.repeat(100) : `tool_${index}` } }))
    const events: ModelTransportEvent[] = []
    const requests: RequestBody[] = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return response({ content: 'Done.', finish: 'stop' })
    })
    const client = new DeepSeekClient({ apiKey: 'fixture', baseUrl: 'https://provider.example', model: 'fixture', maxOutputTokens: 32, fetch })
    await client.stream({ messages: [], tools, signal: new AbortController().signal,
      onContent: vi.fn(), onReasoning: vi.fn(), onTransportEvent: (event) => { events.push(event) } })
    expect(requests[0].tools).toEqual(tools)
    expect(events[0].toolNames).toHaveLength(64)
    expect(events[0]).toMatchObject({ omittedToolCount: 16 })
    expect(events[0].toolNames[0]).toBe('[invalid tool name]')
    expect(JSON.stringify(events)).not.toContain('UNTRUSTED PRIVATE TEXT')
    expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThan(2_000)
  })

  it('does not reserve or dispatch a continuation after cancellation during reasoning', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async () => response({ reasoning: 'Preparing a complete call.', finish: 'length' }))
    const beforeRequest = vi.fn(async () => {})
    const client = new DeepSeekClient({ apiKey: 'fixture', baseUrl: 'https://provider.example', model: 'fixture',
      thinking: 'enabled', maxOutputTokens: 32, fetch })
    await expect(client.stream({ messages: [], tools: [compose], requireToolCall: true, signal: controller.signal,
      beforeRequest, onContent: vi.fn(), onReasoning: () => { controller.abort(new DOMException('Cancelled', 'AbortError')) } }))
      // Usage is in a later SSE event, not observed before the callback
      // cancels. Never keep consuming cancelled output to manufacture it.
      .rejects.toMatchObject({ name: 'AbortError', modelRequestCount: 1, modelCallCount: 0, modelUsage: { totalTokens: 0 } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(beforeRequest).toHaveBeenCalledOnce()
  })
})
