import { describe, expect, it, vi } from 'vitest'
import { DeepSeekClient } from './deepseek.js'
import { resolveModelReasoningEffort, resolveModelThinking } from './config.js'
import type { ModelMessage } from '../shared/types.js'

describe('thinking mode with phase-constrained tools', () => {
  it('uses supported automatic choice, replays reasoning, and omits tools for the final', async () => {
    const requests: Record<string, any>[] = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      const first = requests.length === 1
      const chunks = [
        { choices: [{ delta: { reasoning_content: first ? 'Read the value.' : 'Now add one.' }, finish_reason: null }] },
        { choices: [{ delta: first ? { tool_calls: [{ index: 0, id: 'call_value', function: { name: 'get_value', arguments: '{}' } }] } : { content: '42' }, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]
      return new Response(`${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    const tool = { type: 'function' as const, function: { name: 'get_value', description: 'Get a test integer.', parameters: { type: 'object', properties: {} } } }
    const unrelated = { ...tool, function: { ...tool.function, name: 'unavailable_future_write' } }
    const client = new DeepSeekClient({ apiKey: 'synthetic-test', baseUrl: 'https://example.com', model: 'deepseek-chat', thinking: 'enabled', reasoningEffort: 'high', maxOutputTokens: 16384, fetch })
    const messages: ModelMessage[] = [{ role: 'user', content: 'Read the value and add one.' }]
    const onReasoning = vi.fn()
    const callbacks = { signal: new AbortController().signal, onContent: vi.fn(), onReasoning }
    const first = await client.stream({ messages, tools: [tool], providerTools: [tool, unrelated], toolChoice: { type: 'function', function: { name: 'get_value' } }, ...callbacks })
    messages.push({ role: 'assistant', content: first.content, reasoning_content: first.reasoningContent, tool_calls: first.toolCalls }, { role: 'tool', tool_call_id: 'call_value', content: '41' })
    const final = await client.stream({ messages, providerTools: [tool], tools: [], toolChoice: 'none', ...callbacks })
    expect(requests[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high', tool_choice: 'auto' })
    expect(requests[0].tools).toEqual([tool])
    expect(requests[1]).not.toHaveProperty('tools')
    expect(requests[1]).not.toHaveProperty('tool_choice')
    expect(requests[1].messages[1]).toMatchObject({ reasoning_content: 'Read the value.', tool_calls: first.toolCalls })
    expect(final.content).toBe('42')
    expect(onReasoning.mock.calls).toEqual([['Read the value.'], ['Now add one.']])
  })

  it('validates explicit configuration without silently accepting typos', () => {
    expect(resolveModelThinking('enabled')).toBe('enabled')
    expect(resolveModelThinking('false')).toBe('disabled')
    expect(resolveModelThinking('auto')).toBeUndefined()
    expect(() => resolveModelThinking('enabledd')).toThrow('DEEPSEEK_THINKING')
    expect(resolveModelReasoningEffort('high')).toBe('high')
    expect(() => resolveModelReasoningEffort('extreme')).toThrow('DEEPSEEK_REASONING_EFFORT')
  })
})
