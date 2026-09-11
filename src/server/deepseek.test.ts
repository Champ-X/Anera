import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import { DeepSeekClient, ModelStreamBudgetExceededError, projectProviderMessages } from './deepseek.js'

afterEach(() => vi.unstubAllGlobals())

describe('DeepSeek client', () => {
  it('scopes the JSON syntax contract without changing model quality or ordinary requests', async () => {
    const submitted: Record<string, unknown>[] = []
    const events: unknown[] = []
    const client = new DeepSeekClient({ apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model',
      thinking: 'enabled', reasoningEffort: 'high', maxOutputTokens: 8192,
      fetch: async (_url, init) => { submitted.push(JSON.parse(String(init?.body))); return streamResponse('{"final":"done"}') },
    })
    const common = { messages: [{ role: 'user' as const, content: 'Return JSON: {"final":"answer"}.' }], tools: [],
      signal: new AbortController().signal, onContent: () => {}, onReasoning: () => {}, onTransportEvent: (event: unknown) => { events.push(event) } }
    await client.stream({ ...common, responseFormat: { type: 'json_object' } })
    await client.stream(common)
    expect(submitted[0]).toMatchObject({ response_format: { type: 'json_object' } })
    expect(submitted[1]).not.toHaveProperty('response_format')
    for (const body of submitted) expect(body).toMatchObject({ model: 'test-model', thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 8192 })
    expect(events[0]).toMatchObject({ type: 'request', responseFormat: 'json_object' })
    expect(events[2]).not.toHaveProperty('responseFormat')
  })

  it.each(['transport', 'empty', 'reasoning_length', 'content_length'] as const)('preserves JSON retry/continuation and accounting: %s', async (mode) => {
    const submitted: Record<string, any>[] = []
    const beforeRequest = vi.fn(async () => {})
    const final = '{"final":"done"}'
    const client = new DeepSeekClient({ apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model',
      thinking: 'enabled', reasoningEffort: 'high', maxOutputTokens: 8192, retryBaseDelayMs: 0,
      emptyCompletionRetryBaseDelayMs: 0,
      fetch: async (_url, init) => {
        submitted.push(JSON.parse(String(init?.body)))
        // This is a JSON suffix, deliberately not a standalone JSON object.
        if (submitted.length > 1) return streamResponse(mode === 'content_length' ? '"done"}' : final)
        if (mode === 'transport') return new Response('unavailable', { status: 503 })
        if (mode === 'empty') return emptyCompletionResponse()
        if (mode === 'content_length') return lengthResponse('{"final":')
        return new Response('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'Plan the JSON answer.' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const result = await client.stream({ messages: [{ role: 'user', content: 'Return JSON: {"final":"answer"}.' }], tools: [],
      responseFormat: { type: 'json_object' }, beforeRequest, signal: new AbortController().signal, onContent: () => {}, onReasoning: () => {} })
    expect(JSON.parse(result.content)).toEqual({ final: 'done' })
    expect(result).toMatchObject({ finishReason: 'stop', modelRequestCount: 2, modelCallCount: mode === 'transport' ? 1 : 2 })
    expect(result.usage.totalTokens).toBe(mode === 'transport' ? 12 : mode === 'empty' ? 17 : 20)
    expect(beforeRequest).toHaveBeenCalledTimes(2)
    expect(submitted[0].response_format).toEqual({ type: 'json_object' })
    if (mode === 'content_length') expect(submitted[1]).not.toHaveProperty('response_format')
    else expect(submitted[1].response_format).toEqual({ type: 'json_object' })
    if (mode === 'reasoning_length') {
      expect(submitted[1].messages.at(-1).content).toContain('There is no answer prefix')
      expect(submitted[1].messages.at(-1).content).not.toContain('exact prefix already shown')
      expect(JSON.stringify(submitted[1].messages)).not.toContain('Plan the JSON answer.')
    }
    for (const body of submitted) expect(body).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 8192 })
  })

  it('uses a request-scoped non-thinking checkpoint without changing the main agent mode', async () => {
    const submitted: Record<string, unknown>[] = []
    const client = new DeepSeekClient({ apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model',
      thinking: 'enabled', reasoningEffort: 'high', maxOutputTokens: 8192,
      fetch: async (_url, init) => { submitted.push(JSON.parse(String(init?.body))); return streamResponse('checkpoint') },
    })
    const common = { messages: [{ role: 'user' as const, content: 'Summarize.' }], tools: [],
      signal: new AbortController().signal, onContent: () => {}, onReasoning: () => {} }
    await client.stream({ ...common, thinking: 'disabled', toolChoice: 'none', maxOutputTokens: 1800 })
    await client.stream(common)
    expect(submitted[0]).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 1800 })
    expect(submitted[0]).not.toHaveProperty('reasoning_effort')
    expect(submitted[0]).not.toHaveProperty('tools')
    expect(submitted[1]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 8192 })
  })

  it('retains the per-request thinking policy across retry and continuation with each dispatch reserved', async () => {
    const submitted: Record<string, unknown>[] = []
    const beforeRequest = vi.fn(async () => {})
    const client = new DeepSeekClient({ apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model',
      thinking: 'enabled', reasoningEffort: 'high', maxOutputTokens: 8192, maxRetries: 1,
      retryBaseDelayMs: 0, maxLengthContinuations: 1,
      fetch: async (_url, init) => {
        submitted.push(JSON.parse(String(init?.body)))
        return submitted.length === 1 ? new Response('unavailable', { status: 503 })
          : submitted.length === 2 ? lengthResponse('Earlier work completed.\n\n') : streamResponse('Remaining work is retained.')
      },
    })
    const result = await client.stream({ messages: [{ role: 'user', content: 'Summarize.' }], tools: [], toolChoice: 'none',
      thinking: 'disabled', maxOutputTokens: 1800, maxModelRequests: 3, beforeRequest,
      signal: new AbortController().signal, onContent: () => {}, onReasoning: () => {} })
    expect(result).toMatchObject({ finishReason: 'stop', modelRequestCount: 3, modelCallCount: 2 })
    expect(beforeRequest).toHaveBeenCalledTimes(3)
    for (const body of submitted) {
      expect(body).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 1800 })
      expect(body).not.toHaveProperty('reasoning_effort')
      expect(body).not.toHaveProperty('tools')
    }
  })

  it('supports a tool-free bounded completion for context checkpoints', async () => {
    let submitted: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response([
        'data: {"choices":[{"delta":{"content":"checkpoint"},"finish_reason":null}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }))
    const client = new DeepSeekClient({ apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192 })
    const result = await client.stream({
      messages: [{ role: 'user', content: 'Summarize.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
      maxOutputTokens: 1800,
      model: 'override-model',
    })

    expect(result.content).toBe('checkpoint')
    expect(result.usage.totalTokens).toBe(12)
    expect(submitted?.max_tokens).toBe(1800)
    expect(submitted?.model).toBe('override-model')
    expect(submitted?.temperature).toBe(0)
    expect(submitted).not.toHaveProperty('tools')
    expect(submitted).not.toHaveProperty('tool_choice')
  })

  it('awaits a write-ahead reservation before the initial physical request', async () => {
    const order: string[] = []
    const beforeRequest = vi.fn(async () => {
      order.push('reservation:start')
      await Promise.resolve()
      order.push('reservation:durable')
    })
    const fetchMock = vi.fn(async () => {
      order.push('fetch')
      return streamResponse('reserved')
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Reserve before sending.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
      beforeRequest,
    })

    expect(result.content).toBe('reserved')
    expect(beforeRequest).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(order).toEqual(['reservation:start', 'reservation:durable', 'fetch'])
  })

  it('does not dispatch when the write-ahead reservation callback rejects', async () => {
    // Deliberately resembles a retryable provider failure. Dispatch-gate
    // errors must never be classified by the provider transport policy.
    const reservationFailure = new TypeError('fetch failed while persisting durable reservation')
    const beforeRequest = vi.fn()
      .mockRejectedValueOnce(reservationFailure)
      .mockResolvedValue(undefined)
    const fetchMock = vi.fn().mockResolvedValue(streamResponse('must not be requested'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 2, retryBaseDelayMs: 0,
    })

    const pending = client.stream({
      messages: [{ role: 'user', content: 'Stop if the reservation cannot be persisted.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
      beforeRequest,
    })

    await expect(pending).rejects.toBe(reservationFailure)
    expect(beforeRequest).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([undefined, 'enabled', 'disabled'] as const)('uses executable schemas, never a wider provider override (thinking=%s)', async (thinking) => {
    let submitted: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response([
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }))
    const activeTools = [{
      type: 'function' as const,
      function: { name: 'edit_file', description: 'Edit.', parameters: { type: 'object',
        properties: { path: { type: 'string', enum: ['canonical.txt'] } }, required: ['path'] } },
    }]
    const providerTools = [
      { ...activeTools[0], function: { ...activeTools[0].function, parameters: { type: 'object', properties: {} } } },
      {
        type: 'function' as const,
        function: { name: 'browser', description: 'Browse.', parameters: { type: 'object', properties: {} } },
      },
    ]
    const client = new DeepSeekClient({ apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192, thinking })

    await client.stream({
      messages: [{ role: 'user', content: 'Continue.' }],
      tools: activeTools,
      providerTools,
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
    })

    expect(submitted).toMatchObject({ tools: activeTools, tool_choice: 'auto' })
    await client.stream({ messages: [{ role: 'user', content: 'Finish.' }], tools: [], providerTools,
      toolChoice: 'none', signal: new AbortController().signal, onContent: () => {}, onReasoning: () => {} })
    expect(submitted).not.toHaveProperty('tools')
    expect(submitted).not.toHaveProperty('tool_choice')
  })

  it('parses CRLF SSE blocks and a final event without a blank-line terminator', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"think"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12,"prompt_cache_hit_tokens":4}}',
    ].join('\r\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const onContent = vi.fn()
    const onReasoning = vi.fn()
    const client = new DeepSeekClient({ apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192 })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Parse.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent,
      onReasoning,
    })

    expect(result).toMatchObject({
      content: 'answer',
      reasoningContent: 'think',
      finishReason: 'stop',
      usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12, cachedPromptTokens: 4 },
    })
    expect(onContent).toHaveBeenCalledWith('answer')
    expect(onReasoning).toHaveBeenCalledWith('think')
  })

  it('keeps a successful response without provider usage distinct from an authoritative completed call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"content":"answer without usage"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Answer.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {},
    })

    expect(result).toMatchObject({
      content: 'answer without usage',
      modelRequestCount: 1,
      modelCallCount: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
    })
  })

  it('attaches physical request accounting to an HTTP error without inventing token usage', async () => {
    const fetchMock = vi.fn(async () => new Response('provider unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 0,
    })

    await expect(client.stream({
      messages: [{ role: 'user', content: 'Fail honestly.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {},
    })).rejects.toMatchObject({
      message: expect.stringContaining('503'),
      modelRequestCount: 1,
      modelCallCount: 0,
      modelUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('accounts for the dispatched request when reading a non-2xx response body aborts', async () => {
    const bodyFailure = new Error('aborted')
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(bodyFailure) },
    }), { status: 503 })
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 0,
    })

    await expect(client.stream({
      messages: [{ role: 'user', content: 'Fail while reading the provider error.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
    })).rejects.toMatchObject({
      message: 'aborted',
      modelRequestCount: 1,
      modelCallCount: 0,
      modelUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(response.bodyUsed).toBe(true)
    expect(response.body?.locked).toBe(false)
  })

  it('retries a transport failure only before any visible stream delta', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(streamResponse('recovered'))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test',
      baseUrl: 'https://api.example',
      model: 'test-model',
      maxOutputTokens: 8192,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Recover.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent,
      onReasoning: () => {},
    })

    expect(result.content).toBe('recovered')
    expect(result).toMatchObject({ modelRequestCount: 2, modelCallCount: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onContent).toHaveBeenCalledOnce()
  })

  it('persists a fresh reservation before every transport retry', async () => {
    const order: string[] = []
    let reservation = 0
    let request = 0
    const beforeRequest = vi.fn(async () => {
      reservation += 1
      order.push(`reservation:${reservation}`)
    })
    const fetchMock = vi.fn(async () => {
      request += 1
      order.push(`fetch:${request}`)
      if (request === 1) throw new TypeError('fetch failed')
      return streamResponse('recovered after reservation')
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 1, retryBaseDelayMs: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Retry with durable accounting.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
      beforeRequest,
    })

    expect(result).toMatchObject({ content: 'recovered after reservation', modelRequestCount: 2 })
    expect(beforeRequest).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['reservation:1', 'fetch:1', 'reservation:2', 'fetch:2'])
  })

  it('retries a bare provider aborted failure before any output', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('aborted'))
      .mockResolvedValueOnce(streamResponse('recovered from provider abort'))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 1, retryBaseDelayMs: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Recover from a provider abort.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning: () => {},
    })

    expect(result).toMatchObject({
      content: 'recovered from provider abort',
      modelRequestCount: 2,
      modelCallCount: 1,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onContent.mock.calls.flat().join('')).toBe('recovered from provider abort')
  })

  it('retries a bare stream abort before any visible output', async () => {
    const abortedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('aborted'))
      },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(abortedStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(streamResponse('recovered from stream abort'))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 1, retryBaseDelayMs: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Recover from an early stream abort.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent,
      onReasoning: () => {},
    })

    expect(result).toMatchObject({
      content: 'recovered from stream abort',
      modelRequestCount: 2,
      modelCallCount: 1,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onContent.mock.calls.flat().join('')).toBe('recovered from stream abort')
  })

  it('recognizes nested undici transport aborts through the cause chain', async () => {
    const undiciFailure = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    const nestedFailure = new TypeError('provider request failed', {
      cause: new Error('transport wrapper failed', { cause: undiciFailure }),
    })
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(nestedFailure)
      .mockResolvedValueOnce(streamResponse('recovered from nested abort'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 1, retryBaseDelayMs: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Recover from a nested transport abort.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {},
    })

    expect(result.content).toBe('recovered from nested abort')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('bounds retries for repeated bare provider aborted failures', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('aborted') })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 2, retryBaseDelayMs: 0,
    })

    await expect(client.stream({
      messages: [{ role: 'user', content: 'Fail after the bounded retry budget.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {},
    })).rejects.toMatchObject({
      message: 'aborted',
      modelRequestCount: 3,
      modelCallCount: 0,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry a bare aborted failure caused by the parent signal', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) throw new Error('Missing provider abort signal')
      const abort = () => reject(new Error('aborted'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 2, retryBaseDelayMs: 0,
    })
    const pending = client.stream({
      messages: [{ role: 'user', content: 'Cancel this request.' }], tools: [], signal: controller.signal,
      onContent: () => {}, onReasoning: () => {},
    })
    controller.abort(new DOMException('Cancelled', 'AbortError'))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'Cancelled', modelRequestCount: 1 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not dispatch when the parent signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('Cancelled before dispatch', 'AbortError'))
    const fetchMock = vi.fn().mockResolvedValue(streamResponse('must not be requested'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 2, retryBaseDelayMs: 0,
    })

    await expect(client.stream({
      messages: [{ role: 'user', content: 'This run is already cancelled.' }],
      tools: [],
      signal: controller.signal,
      onContent: () => {},
      onReasoning: () => {},
    })).rejects.toMatchObject({ name: 'AbortError', message: 'Cancelled before dispatch' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bounds each provider attempt until its first SSE event and safely retries a pre-stream stall', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) throw new Error('Missing provider abort signal')
        const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }))
      .mockResolvedValueOnce(streamResponse('recovered after first-event timeout'))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      firstEventTimeoutMs: 10, maxRetries: 1, retryBaseDelayMs: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Recover a stalled request.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning: () => {},
    })

    expect(result).toMatchObject({
      content: 'recovered after first-event timeout',
      modelRequestCount: 2,
      modelCallCount: 1,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onContent.mock.calls.flat().join('')).toBe('recovered after first-event timeout')
  })

  it('clears the first-event deadline after a valid SSE event instead of timing out a quiet continuation', async () => {
    const encoder = new TextEncoder()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"started"},"finish_reason":null}]}\n\n'))
        setTimeout(() => {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":2,"total_tokens":8}}\n\n'))
          controller.close()
        }, 30)
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const fetchMock = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetchMock)
    const onReasoning = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      firstEventTimeoutMs: 10, maxRetries: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Allow silence after streaming starts.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning,
    })

    expect(result).toMatchObject({ content: 'done', reasoningContent: 'started', finishReason: 'stop' })
    expect(onReasoning).toHaveBeenCalledWith('started')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('settles observed usage from a failed hidden stream attempt before retrying', async () => {
    const failedAttempt = new Response([
      'data: {"choices":[{"delta":{},"finish_reason":null}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9,"prompt_cache_hit_tokens":4}}',
      '',
      'data: {"error":{"message":"service unavailable after usage"}}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failedAttempt)
      .mockResolvedValueOnce(streamResponse('recovered after accounted failure'))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 1, retryBaseDelayMs: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Retry and account for both calls.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning: () => {},
    })

    expect(result).toMatchObject({
      content: 'recovered after accounted failure',
      modelCallCount: 2,
      usage: { promptTokens: 17, completionTokens: 4, totalTokens: 21, cachedPromptTokens: 4 },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onContent.mock.calls.flat().join('')).toBe('recovered after accounted failure')
  })

  it('attaches observed usage when a visible partial stream later fails', async () => {
    const partial = `${'visible-part '.repeat(30)}unfinished-tail`
    const fetchMock = vi.fn(async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: partial }, finish_reason: null }] })}`,
      '',
      'data: {"choices":[{"delta":{},"finish_reason":null}],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14,"prompt_cache_hit_tokens":8}}',
      '',
      'data: {"error":{"message":"terminal stream error"}}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 2, retryBaseDelayMs: 0,
    })

    let failure: unknown
    try {
      await client.stream({
        messages: [{ role: 'user', content: 'Do not replay the partial.' }], tools: [], signal: new AbortController().signal,
        onContent, onReasoning: () => {},
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      message: 'terminal stream error',
      modelUsage: { promptTokens: 11, completionTokens: 3, totalTokens: 14, cachedPromptTokens: 8 },
      modelCallCount: 1,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(onContent.mock.calls.flat().join('')).toBe(partial.slice(0, partial.lastIndexOf(' ', partial.length - 257) + 1))
  })

  it('attaches observed usage when the stream closes without a finish reason', async () => {
    const fetchMock = vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{},"finish_reason":null}],"usage":{"prompt_tokens":13,"completion_tokens":1,"total_tokens":14,"prompt_cache_hit_tokens":10}}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 0,
    })

    await expect(client.stream({
      messages: [{ role: 'user', content: 'Account for a missing terminal event.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {},
    })).rejects.toMatchObject({
      message: expect.stringContaining('finish reason'),
      modelUsage: { promptTokens: 13, completionTokens: 1, totalTokens: 14, cachedPromptTokens: 10 },
      modelCallCount: 1,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('retries two zero-output stop completions and accumulates their real usage', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyCompletionResponse())
      .mockResolvedValueOnce(emptyCompletionResponse())
      .mockResolvedValueOnce(streamResponse('recovered from empty completions'))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test',
      baseUrl: 'https://api.example',
      model: 'test-model',
      maxOutputTokens: 8192,
      maxEmptyCompletionRetries: 2,
      emptyCompletionRetryBaseDelayMs: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Recover empty completions.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent,
      onReasoning: () => {},
    })

    expect(result.content).toBe('recovered from empty completions')
    expect(result.modelCallCount).toBe(3)
    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 2,
      totalTokens: 22,
      cachedPromptTokens: 0,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(onContent).toHaveBeenCalledOnce()
    expect(onContent).toHaveBeenCalledWith('recovered from empty completions')
  })

  it('retries a provider protocol sentinel before it becomes visible and preserves its usage', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(providerErrorCompletionResponse())
      .mockResolvedValueOnce(streamResponse('recovered from provider sentinel'))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxEmptyCompletionRetries: 2, emptyCompletionRetryBaseDelayMs: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Recover the provider protocol.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning: () => {},
    })

    expect(result).toMatchObject({
      content: 'recovered from provider sentinel',
      finishReason: 'stop',
      modelCallCount: 2,
      usage: { promptTokens: 15, completionTokens: 19, totalTokens: 34, cachedPromptTokens: 0 },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onContent.mock.calls.flat().join('')).toBe('recovered from provider sentinel')
    expect(onContent.mock.calls.flat().join('')).not.toContain('message with role')
  })

  it('fails honestly after the provider protocol sentinel exhausts its hidden retry budget', async () => {
    const fetchMock = vi.fn(async () => providerErrorCompletionResponse())
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxEmptyCompletionRetries: 2, emptyCompletionRetryBaseDelayMs: 0,
    })

    await expect(client.stream({
      messages: [{ role: 'user', content: 'Do not publish provider errors.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning: () => {},
    })).rejects.toMatchObject({
      message: expect.stringContaining('DeepSeek provider completion error'),
      modelUsage: { promptTokens: 15, completionTokens: 51, totalTokens: 66, cachedPromptTokens: 0 },
      modelCallCount: 3,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(onContent).not.toHaveBeenCalled()
  })

  it('returns the final empty completion after the bounded retry budget is exhausted', async () => {
    const fetchMock = vi.fn(async () => emptyCompletionResponse())
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test',
      baseUrl: 'https://api.example',
      model: 'test-model',
      maxOutputTokens: 8192,
      maxEmptyCompletionRetries: 2,
      emptyCompletionRetryBaseDelayMs: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Bound empty retries.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
    })

    expect(result).toMatchObject({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop', modelCallCount: 3 })
    expect(result.usage).toEqual({ promptTokens: 15, completionTokens: 0, totalTokens: 15, cachedPromptTokens: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('attaches completed empty-response usage when a later attempt fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(emptyCompletionResponse())
      .mockResolvedValueOnce(new Response('invalid request after retry', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxEmptyCompletionRetries: 2, emptyCompletionRetryBaseDelayMs: 0,
    })

    let failure: unknown
    try {
      await client.stream({
        messages: [{ role: 'user', content: 'Preserve failed retry usage.' }], tools: [], signal: new AbortController().signal,
        onContent: () => {}, onReasoning: () => {},
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      message: expect.stringContaining('400'),
      modelUsage: { promptTokens: 5, completionTokens: 0, totalTokens: 5, cachedPromptTokens: 0 },
      modelCallCount: 1,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('attaches completed empty-response usage when cancellation aborts retry backoff', async () => {
    const fetchMock = vi.fn(async () => emptyCompletionResponse())
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxEmptyCompletionRetries: 2, emptyCompletionRetryBaseDelayMs: 5_000,
    })
    const pending = client.stream({
      messages: [{ role: 'user', content: 'Cancel during empty retry wait.' }], tools: [], signal: controller.signal,
      onContent: () => {}, onReasoning: () => {},
    })
    for (let attempt = 0; attempt < 100 && fetchMock.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1))
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    controller.abort(new DOMException('Cancelled', 'AbortError'))

    let failure: unknown
    try {
      await pending
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      name: 'AbortError',
      modelUsage: { promptTokens: 5, completionTokens: 0, totalTokens: 5, cachedPromptTokens: 0 },
      modelCallCount: 1,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('never retries a completion after visible reasoning has been emitted', async () => {
    const fetchMock = vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"visible thought"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    const onReasoning = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxEmptyCompletionRetries: 2, emptyCompletionRetryBaseDelayMs: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Do not replay visible reasoning.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning,
    })

    expect(result.reasoningContent).toBe('visible thought')
    expect(result.modelCallCount).toBe(1)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(onReasoning).toHaveBeenCalledOnce()
  })

  it('removes private tool-result and Arena system-part provenance from provider messages', async () => {
    let submitted: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body)) as Record<string, unknown>
      return streamResponse('Recovered.')
    }))
    const client = new DeepSeekClient({ apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192 })
    await client.stream({
      messages: [
        {
          role: 'user',
          content: '<arena-system-message>\nThe next message part will be the user providing feedback about the previous message.\n</arena-system-message>\n\nCorrect it.\n\n<arena-system-message>\nUploaded workspace files:\n- uploads/a.txt\n</arena-system-message>',
          arena_system_messages: [
            { kind: 'custom_feedback', position: 'leading', reviewedNodeId: 'evt_reviewed' },
            { kind: 'attachments', position: 'trailing' },
          ],
        },
        {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"status":"success"}', tool_result_status: 'succeeded' },
      ],
      tools: [], signal: new AbortController().signal, onContent: () => {}, onReasoning: () => {},
    })

    const messages = submitted?.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({
      role: 'user',
      content: '<arena-system-message>\nThe next message part will be the user providing feedback about the previous message.\n</arena-system-message>\n\nCorrect it.\n\n<arena-system-message>\nUploaded workspace files:\n- uploads/a.txt\n</arena-system-message>',
    })
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"status":"success"}' })
    expect(JSON.stringify(submitted)).not.toContain('tool_result_status')
    expect(JSON.stringify(submitted)).not.toContain('arena_system_messages')
  })

  it('projects only record_reference_style results in the actual deterministic provider request', async () => {
    const durableReferenceResult = referenceStyleToolResultContent()
    const sameShapeFromAnotherTool = referenceStyleToolResultContent()
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Follow the exact linked reference.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'reference-call',
            type: 'function',
            function: { name: 'record_reference_style', arguments: '{}' },
          },
          {
            id: 'unrelated-call',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool', tool_call_id: 'reference-call', content: durableReferenceResult,
        tool_result_status: 'succeeded',
      },
      {
        role: 'tool', tool_call_id: 'unrelated-call', content: sameShapeFromAnotherTool,
        tool_result_status: 'succeeded',
      },
    ]
    const durableSnapshot = structuredClone(messages)
    const submitted: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      submitted.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return streamResponse('Reference projection accepted.')
    }))
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await client.stream({
        messages, tools: [], signal: new AbortController().signal,
        onContent: () => {}, onReasoning: () => {},
      })
    }

    const firstProviderMessages = submitted[0].messages as Array<Record<string, unknown>>
    const secondProviderMessages = submitted[1].messages as Array<Record<string, unknown>>
    const projectedPayload = JSON.parse(String(firstProviderMessages[2].content)) as Record<string, unknown>
    expect(projectedPayload).not.toHaveProperty('source_profile')
    expect(projectedPayload).not.toHaveProperty('render_profile')
    expect(projectedPayload).toMatchObject({
      source_profile_attestation: {
        version: 1,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      render_profile_attestation: {
        version: 1,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        evidenceSha256: 'a'.repeat(64),
        viewport: { width: 1440, height: 900 },
      },
    })
    expect(firstProviderMessages[2].content).toBe(secondProviderMessages[2].content)
    expect(firstProviderMessages[2].content).toBe(projectProviderMessages(messages)[2].content)
    expect(firstProviderMessages[3].content).toBe(sameShapeFromAnotherTool)
    expect(JSON.parse(String(firstProviderMessages[3].content))).toHaveProperty('source_profile')
    expect(JSON.parse(String(firstProviderMessages[3].content))).toHaveProperty('render_profile')
    expect(messages).toEqual(durableSnapshot)
  })

  it('translates Arena image-data tool results into provider multimodal content', async () => {
    let submitted: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body)) as Record<string, unknown>
      return streamResponse('Image inspected.')
    }))
    const client = new DeepSeekClient({ apiKey: 'test', baseUrl: 'https://api.example', model: 'vision-model', maxOutputTokens: 8192 })
    await client.stream({
      messages: [
        { role: 'user', content: 'Read the image.' },
        {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_image', type: 'function', function: { name: 'read_file', arguments: '{"path":"image.png"}' } }],
        },
        {
          role: 'tool', tool_call_id: 'call_image', content: '{"kind":"image","mediaType":"image/png"}',
          tool_result_status: 'succeeded',
          tool_content_parts: [{ type: 'image-data', data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
        },
      ],
      tools: [], signal: new AbortController().signal, onContent: () => {}, onReasoning: () => {},
    })

    const messages = submitted?.messages as Array<Record<string, unknown>>
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_image',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }],
    })
    expect(JSON.stringify(submitted)).not.toContain('tool_content_parts')
  })

  it('does not replay a failed stream after a visible delta was emitted', async () => {
    const partial = `${'visible-word '.repeat(30)}unfinished-tail`
    const fetchMock = vi.fn(async () => failingAfterDeltaResponse(partial))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test',
      baseUrl: 'https://api.example',
      model: 'test-model',
      maxOutputTokens: 8192,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    })

    await expect(client.stream({
      messages: [{ role: 'user', content: 'Do not duplicate.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent,
      onReasoning: () => {},
    })).rejects.toMatchObject({
      message: expect.stringContaining('fetch failed after streaming'),
      modelRequestCount: 1,
      modelCallCount: 0,
      modelUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(onContent).toHaveBeenCalledOnce()
    expect(onContent.mock.calls.flat().join('')).toBe(partial.slice(0, partial.lastIndexOf(' ', partial.length - 257) + 1))
  })

  it('does not retry a provider aborted stream after visible output was emitted', async () => {
    const partial = `${'visible-word '.repeat(30)}unfinished-tail`
    const fetchMock = vi.fn(async () => failingAfterDeltaResponse(partial, new Error('aborted')))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 2, retryBaseDelayMs: 0,
    })

    await expect(client.stream({
      messages: [{ role: 'user', content: 'Do not replay after provider abort.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning: () => {},
    })).rejects.toMatchObject({ message: 'aborted', modelRequestCount: 1 })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(onContent).toHaveBeenCalledOnce()
  })

  it('rejects a gracefully truncated stream after visible content without replaying it', async () => {
    const partial = `${'visible-word '.repeat(30)}unfinished-tail`
    const fetchMock = vi.fn(async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: partial }, finish_reason: null }] })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test',
      baseUrl: 'https://api.example',
      model: 'test-model',
      maxOutputTokens: 8192,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    })

    await expect(client.stream({
      messages: [{ role: 'user', content: 'Do not accept a partial answer.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent,
      onReasoning: () => {},
    })).rejects.toThrow(/ended before a finish reason/)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(onContent).toHaveBeenCalledOnce()
    expect(onContent.mock.calls.flat().join('').length).toBeGreaterThan(0)
  })

  it('retries a gracefully truncated stream when no visible delta was emitted', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"partial","function":{"name":"read_file","arguments":"{\\\""}}]},"finish_reason":null}]}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ))
      .mockResolvedValueOnce(streamResponse('recovered'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test',
      baseUrl: 'https://api.example',
      model: 'test-model',
      maxOutputTokens: 8192,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Retry before exposing anything.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.content).toBe('recovered')
    expect(result.toolCalls).toEqual([])
  })

  it('coalesces streamed tool arguments into visible deltas and preserves their exact text', async () => {
    const argumentsText = JSON.stringify({ path: 'slides.html', content: `${'<section>你好</section>\n'.repeat(140)}` })
    const fragments = Array.from({ length: Math.ceil(argumentsText.length / 700) }, (_, index) => (
      argumentsText.slice(index * 700, (index + 1) * 700)
    ))
    const blocks = fragments.map((fragment, index) => `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            ...(index === 0 ? { id: 'call_write' } : {}),
            function: {
              ...(index === 0 ? { name: 'write_file' } : {}),
              arguments: fragment,
            },
          }],
        },
        finish_reason: null,
      }],
    })}\n\n`)
    blocks.push(`data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 12, completion_tokens: 42, total_tokens: 54 },
    })}\n\n`)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(blocks.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })))
    const onToolCallDelta = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Create slides.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {}, onToolCallDelta,
    })

    expect(onToolCallDelta.mock.calls.length).toBeGreaterThan(1)
    expect(onToolCallDelta.mock.calls.map(([delta]) => delta.idDelta ?? '').join('')).toBe('call_write')
    expect(onToolCallDelta.mock.calls.map(([delta]) => delta.nameDelta ?? '').join('')).toBe('write_file')
    expect(onToolCallDelta.mock.calls.map(([delta]) => delta.argumentsDelta ?? '').join('')).toBe(argumentsText)
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call_write',
      function: { name: 'write_file', arguments: argumentsText },
    })
  })

  it('does not replay a truncated provider stream after a tool draft became visible', async () => {
    const longArguments = JSON.stringify({ path: 'draft.html', content: 'x'.repeat(2_000) })
    const first = new Response(`data: ${JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call_visible', function: { name: 'write_file', arguments: longArguments } }] },
        finish_reason: null,
      }],
    })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(streamResponse('must not replay'))
    vi.stubGlobal('fetch', fetchMock)
    const onToolCallDelta = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 2, retryBaseDelayMs: 1,
    })

    await expect(client.stream({
      messages: [{ role: 'user', content: 'Create a visible draft.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {}, onToolCallDelta,
    })).rejects.toThrow(/ended before a finish reason/)
    expect(onToolCallDelta).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('synthesizes collision-free ids for id-less streamed tool calls and preserves provider duplicate ids', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{}"}},{"index":1,"function":{"name":"read_file","arguments":"{}"}},{"index":2,"id":"duplicate","function":{"name":"read_file","arguments":"{}"}},{"index":3,"id":"duplicate","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Call tools.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
    })

    expect(result.toolCalls.map((call) => call.id)).toEqual([
      'call_1',
      'call_1_generated_1',
      'duplicate',
      'duplicate',
    ])
  })

  it('continues a tool-free output-length completion without replaying visible text and accumulates usage', async () => {
    const submitted: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      submitted.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return submitted.length === 1
        ? lengthResponse('Part one ')
        : streamResponse('part two.')
    })
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 32,
      maxLengthContinuations: 2,
    })
    const tools = [{
      type: 'function' as const,
      function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } },
    }]

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Write a complete answer.' }], tools, signal: new AbortController().signal,
      toolChoice: 'auto',
      onContent, onReasoning: () => {},
    })

    expect(result).toMatchObject({
      content: 'Part one part two.',
      finishReason: 'stop',
      modelCallCount: 2,
      usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20, cachedPromptTokens: 0 },
    })
    expect(onContent.mock.calls.map(([delta]) => delta)).toEqual(['Part one ', 'part two.'])
    expect(submitted[0]).toMatchObject({
      tools,
      tool_choice: 'auto',
    })
    expect(submitted[1]).toMatchObject({ tools, tool_choice: 'none' })
    expect(submitted[1].messages).toEqual([
      { role: 'user', content: 'Write a complete answer.' },
      { role: 'assistant', content: 'Part one ' },
      {
        role: 'user',
        content: expect.stringContaining('output only the missing suffix'),
      },
    ])
  })

  it('persists a fresh reservation before every output-length continuation', async () => {
    const order: string[] = []
    let reservation = 0
    let request = 0
    const beforeRequest = vi.fn(async () => {
      reservation += 1
      order.push(`reservation:${reservation}`)
    })
    const fetchMock = vi.fn(async () => {
      request += 1
      order.push(`fetch:${request}`)
      return request === 1
        ? lengthResponse('Reserved prefix. ')
        : streamResponse('Reserved suffix.')
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 32,
      maxLengthContinuations: 1,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Complete this across requests.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
      beforeRequest,
    })

    expect(result).toMatchObject({
      content: 'Reserved prefix. Reserved suffix.',
      modelCallCount: 2,
      modelRequestCount: 2,
    })
    expect(beforeRequest).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['reservation:1', 'fetch:1', 'reservation:2', 'fetch:2'])
  })

  it('does not dispatch a continuation when its reservation fails and preserves prior accounting', async () => {
    const reservationFailure = Object.assign(new Error('reservation backend unavailable'), { status: 503 })
    const beforeRequest = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(reservationFailure)
      .mockResolvedValue(undefined)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse('Already dispatched prefix.'))
      .mockResolvedValueOnce(streamResponse('must not be requested'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 32,
      maxRetries: 2, retryBaseDelayMs: 0, maxLengthContinuations: 1,
    })

    const failure = await client.stream({
      messages: [{ role: 'user', content: 'Stop before an unreserved continuation.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
      beforeRequest,
    }).catch((error: unknown) => error)

    expect(failure).toBe(reservationFailure)
    expect(failure).toMatchObject({
      message: 'reservation backend unavailable',
      modelCallCount: 1,
      modelRequestCount: 1,
      modelUsage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, cachedPromptTokens: 0 },
    })
    expect(beforeRequest).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'physical requests',
      allowance: { maxModelRequests: 1, maxTotalTokens: 100 },
      expected: { budget: 'model_requests', used: 1, limit: 1 },
    },
    {
      name: 'provider tokens',
      allowance: { maxModelRequests: 10, maxTotalTokens: 8 },
      expected: { budget: 'total_tokens', used: 8, limit: 8 },
    },
  ])('does not dispatch a length continuation after the $name allowance is spent', async ({ allowance, expected }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse('Budgeted prefix.'))
      .mockResolvedValueOnce(streamResponse('must not be requested'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 32,
      maxLengthContinuations: 2,
    })

    const failure = await client.stream({
      messages: [{ role: 'user', content: 'Write a complete answer.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
      ...allowance,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ModelStreamBudgetExceededError)
    expect(failure).toMatchObject({
      name: 'ModelStreamBudgetExceededError',
      code: 'model_stream_budget_exceeded',
      ...expected,
      modelCallCount: 1,
      modelRequestCount: 1,
      modelUsage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, cachedPromptTokens: 0 },
    })
    await expect(client.stream({
      messages: [], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {}, maxModelRequests: 0,
    })).rejects.toThrow('maxModelRequests must be a positive integer')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('preserves a delimiter-free visible prefix when continuing a long single token', async () => {
    // The emoji straddles the buffer's initial 344-code-unit commit limit, so
    // this also proves the fallback never publishes a split surrogate pair.
    let seed = 0x5eed1234
    const randomToken = (length: number) => Array.from({ length }, () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[seed % 36]
    }).join('')
    const prefix = `${randomToken(343)}😀${randomToken(255)}`
    const regeneratedTail = prefix.slice(-64)
    const suffix = randomToken(40)
    const submitted: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      submitted.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return submitted.length === 1
        ? lengthResponse(prefix)
        : streamResponse(`${regeneratedTail}${suffix}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 32,
      maxLengthContinuations: 1,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Return one exact long marker without separators.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent,
      onReasoning: () => {},
    })

    expect(result).toMatchObject({
      content: `${prefix}${suffix}`,
      finishReason: 'stop',
      modelCallCount: 2,
    })
    expect(onContent.mock.calls.flat().join('')).toBe(`${prefix}${suffix}`)
    for (const [delta] of onContent.mock.calls as Array<[string]>) {
      expect(delta).not.toMatch(/[\uD800-\uDBFF]$/u)
      expect(delta).not.toMatch(/^[\uDC00-\uDFFF]/u)
    }
    expect(submitted[1].messages).toEqual([
      { role: 'user', content: 'Return one exact long marker without separators.' },
      { role: 'assistant', content: prefix },
      { role: 'user', content: expect.stringContaining(JSON.stringify(regeneratedTail)) },
    ])
  })

  it('returns an honest length finish after the bounded continuation budget is exhausted', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse('Part A '))
      .mockResolvedValueOnce(lengthResponse('Part B '))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 16,
      maxLengthContinuations: 1,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Keep going.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {},
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ content: 'Part A Part B ', finishReason: 'length', modelCallCount: 2 })
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 6, totalTokens: 16, cachedPromptTokens: 0 })
  })

  it('stops continuation immediately when a length response is trapped in exact repetition', async () => {
    const repeatedParagraph = 'Let me try the same browser action again even though it has already failed and no new evidence is available.'
    const repeated = Array.from({ length: 40 }, () => repeatedParagraph).join('\n\n')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse(repeated))
      .mockResolvedValueOnce(streamResponse('must not spend another provider call'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxLengthContinuations: 5,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Use the browser once, then finish.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent: () => {},
      onReasoning: () => {},
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      content: repeated,
      finishReason: 'length',
      modelCallCount: 1,
      modelRequestCount: 1,
      degenerateRepetition: true,
    })
  })

  it('keeps a partial answer truncated when bounded continuation attempts end in empty stops', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse('Partial prefix.'))
      .mockResolvedValueOnce(emptyCompletionResponse())
      .mockResolvedValueOnce(emptyCompletionResponse())
      .mockResolvedValueOnce(emptyCompletionResponse())
      .mockResolvedValueOnce(emptyCompletionResponse())
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 16,
      maxLengthContinuations: 2, maxEmptyCompletionRetries: 2, emptyCompletionRetryBaseDelayMs: 0,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Complete this.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning: () => {},
    })

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(onContent.mock.calls.map(([delta]) => delta)).toEqual(['Partial prefix.'])
    expect(result).toMatchObject({ content: 'Partial prefix.', finishReason: 'length', modelCallCount: 5 })
    expect(result.usage).toEqual({ promptTokens: 25, completionTokens: 3, totalTokens: 28, cachedPromptTokens: 0 })
  })

  it('keeps a partial answer truncated when a continuation stops after reasoning without a suffix', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse('Partial prefix.'))
      .mockResolvedValueOnce(reasoningOnlyResponse('I have not produced the missing suffix.'))
      .mockResolvedValueOnce(reasoningOnlyResponse('I still have not produced the missing suffix.'))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const onReasoning = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 16,
      maxLengthContinuations: 2,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Complete this.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning,
    })

    expect(result).toMatchObject({ content: 'Partial prefix.', finishReason: 'length', modelCallCount: 3 })
    expect(onContent.mock.calls.map(([delta]) => delta)).toEqual(['Partial prefix.'])
    expect(onReasoning).toHaveBeenCalledWith('I have not produced the missing suffix.')
    expect(onReasoning).toHaveBeenCalledWith('I still have not produced the missing suffix.')
  })

  it('suppresses restarted continuation prefixes and emits only the novel suffix', async () => {
    const first = Array.from({ length: 20 }, (_, index) => String(index + 1).padStart(2, '0')).join(',')
    const shorterRestart = Array.from({ length: 15 }, (_, index) => String(index + 1).padStart(2, '0')).join(',')
    const completed = Array.from({ length: 25 }, (_, index) => String(index + 1).padStart(2, '0')).join(',')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse(first))
      .mockResolvedValueOnce(lengthResponse(`I will continue.\n\n${shorterRestart}`))
      .mockResolvedValueOnce(streamResponse(completed))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 16,
      maxLengthContinuations: 2,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Count.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning: () => {},
    })

    expect(result.content).toBe(completed)
    expect(result.modelCallCount).toBe(3)
    expect(onContent.mock.calls.flat().join('')).toBe(completed)
    expect(onContent.mock.calls.flat().join('')).not.toContain(`${shorterRestart}${shorterRestart}`)
  })

  it('never replaces an already-visible prefix with a longer divergent restart', async () => {
    const first = Array.from({ length: 30 }, (_, index) => String(index + 1).padStart(2, '0')).join(',')
    const divergent = `I will continue.\n${first.slice(0, 40)}CORRUPTED-${'x'.repeat(120)}`
    const completed = `${first},31,32,33,34,35`
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse(first))
      .mockResolvedValueOnce(lengthResponse(divergent))
      .mockResolvedValueOnce(streamResponse(completed))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 16,
      maxLengthContinuations: 2,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Count without replacing visible text.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning: () => {},
    })

    expect(result.content).toBe(completed)
    expect(result.modelCallCount).toBe(3)
    expect(onContent.mock.calls.flat().join('')).toBe(completed)
  })

  it('drops an uncommitted partial line before appending a continued complete line', async () => {
    const firstComplete = '0001|ANERA-LONG-FINAL-V1\n'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse(`${firstComplete}0002|AN`))
      .mockResolvedValueOnce(streamResponse('0002|ANERA-LONG-FINAL-V1\n0003|ANERA-LONG-FINAL-V1'))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 16,
      maxLengthContinuations: 1,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Write three exact lines.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning: () => {},
    })

    const expected = `${firstComplete}0002|ANERA-LONG-FINAL-V1\n0003|ANERA-LONG-FINAL-V1`
    expect(result).toMatchObject({ content: expected, finishReason: 'stop', modelCallCount: 2 })
    expect(onContent.mock.calls.flat().join('')).toBe(expected)
    expect(result.content).not.toContain('0002|AN0002|')
  })

  it('retries an overlap-only stop while continuation budget remains', async () => {
    const prefix = 'AlreadyVisibleDelimiterFreePrefix731'
    const suffix = 'MissingSuffix947'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse(prefix))
      .mockResolvedValueOnce(streamResponse(prefix))
      .mockResolvedValueOnce(streamResponse(`${prefix}${suffix}`))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 16,
      maxLengthContinuations: 2,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Complete the exact token.' }],
      tools: [],
      signal: new AbortController().signal,
      onContent,
      onReasoning: () => {},
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({
      content: `${prefix}${suffix}`,
      finishReason: 'stop',
      modelCallCount: 3,
    })
    expect(onContent.mock.calls.flat().join('')).toBe(`${prefix}${suffix}`)
  })

  it('reports an exact-prefix-only stop continuation as unresolved instead of completed', async () => {
    const first = 'Already visible partial answer.'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lengthResponse(first))
      .mockResolvedValueOnce(streamResponse(`Preamble\n${first}`))
    vi.stubGlobal('fetch', fetchMock)
    const onContent = vi.fn()
    const client = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 16,
      maxLengthContinuations: 1,
    })

    const result = await client.stream({
      messages: [{ role: 'user', content: 'Complete the answer.' }], tools: [], signal: new AbortController().signal,
      onContent, onReasoning: () => {},
    })

    expect(result).toMatchObject({ content: first, finishReason: 'length', modelCallCount: 2 })
    expect(onContent.mock.calls.map(([delta]) => delta)).toEqual([first])
  })

  it('honors provider retry directives and rejects excessive server delays', async () => {
    const neverRetry = vi.fn(async () => new Response('busy', {
      status: 503,
      headers: { 'x-should-retry': 'false' },
    }))
    vi.stubGlobal('fetch', neverRetry)
    const noRetryClient = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 2, retryBaseDelayMs: 1,
    })
    await expect(noRetryClient.stream({
      messages: [{ role: 'user', content: 'No retry.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {},
    })).rejects.toThrow(/503/)
    expect(neverRetry).toHaveBeenCalledOnce()

    const forcedRetry = vi.fn()
      .mockResolvedValueOnce(new Response('retry this', {
        status: 400,
        headers: { 'x-should-retry': 'true', 'retry-after-ms': '0' },
      }))
      .mockResolvedValueOnce(streamResponse('directed recovery'))
    vi.stubGlobal('fetch', forcedRetry)
    const directedClient = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 2, retryBaseDelayMs: 1,
    })
    expect((await directedClient.stream({
      messages: [{ role: 'user', content: 'Honor the directive.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {},
    })).content).toBe('directed recovery')
    expect(forcedRetry).toHaveBeenCalledTimes(2)

    const excessiveDelay = vi.fn(async () => new Response('slow down', {
      status: 429,
      headers: { 'retry-after-ms': '500' },
    }))
    vi.stubGlobal('fetch', excessiveDelay)
    const boundedClient = new DeepSeekClient({
      apiKey: 'test', baseUrl: 'https://api.example', model: 'test-model', maxOutputTokens: 8192,
      maxRetries: 2, retryBaseDelayMs: 1, maxRetryDelayMs: 10,
    })
    await expect(boundedClient.stream({
      messages: [{ role: 'user', content: 'Bound delays.' }], tools: [], signal: new AbortController().signal,
      onContent: () => {}, onReasoning: () => {},
    })).rejects.toThrow(/exceeding the 1s harness limit/)
    expect(excessiveDelay).toHaveBeenCalledOnce()
  })
})

function streamResponse(content: string): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}`,
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function referenceStyleToolResultContent(): string {
  const evidenceSha256 = 'a'.repeat(64)
  const anchor = (selector: string) => ({
    selector,
    count: 1,
    geometry: 'strict',
    rects: [{ x: 0, y: 0, width: 1, height: 1 }],
    styles: [{ display: 'block', position: 'relative', opacity: '1' }],
    occlusion: [1],
  })
  const phase = (selector: string) => ({
    anchors: [anchor(selector), anchor('.nav-controls')],
    overlayProbes: [],
  })
  return JSON.stringify({
    status: 'success',
    contract: {
      source_url: 'https://example.com/reference/template.html',
      strictness: 'exact',
      colors: ['#fdfae7', '#1e2bfa', '#111111'],
      fonts: ['Inter'],
      layout: ['cream canvas', 'diagonal cover geometry'],
      components: ['circular navigation', 'fixed progress indicator'],
      required_markers: ['.layout-cover', '.nav-controls'],
      signature: 'Warm cream canvas with restrained cobalt geometry.',
      avoid: ['dark gradient cover'],
      viewport: { width: 1440, height: 900 },
    },
    provenance: {
      resolvedUrl: 'https://example.com/reference/template.html',
      evidenceSha256,
      evidenceBytes: 4_096,
    },
    source_profile: {
      version: 1,
      rules: [{
        selector: '.layout-cover',
        declarations: [
          { property: 'display', value: 'grid' },
          { property: 'background', value: '#fdfae7' },
        ],
        requiredInDom: true,
      }],
      dom: [{ className: 'layout-cover', occurrences: 1, required: true }],
    },
    render_profile: {
      version: 1,
      evidenceSha256,
      viewport: { width: 1440, height: 900 },
      phases: {
        cover: phase('.layout-cover'),
        content: phase('.layout-content'),
        closing: phase('.layout-closing'),
      },
    },
  })
}

function emptyCompletionResponse(): Response {
  return new Response([
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":0,"total_tokens":5}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function providerErrorCompletionResponse(): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "✋ Error: A message with role 'tool' found without preceding user message." }, finish_reason: null }] })}`,
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":17,"total_tokens":22}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function lengthResponse(content: string): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}`,
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function reasoningOnlyResponse(reasoning: string): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] })}`,
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function failingAfterDeltaResponse(content = 'partial', failure: Error = new TypeError('fetch failed after streaming')): Response {
  let pullCount = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      pullCount += 1
      if (pullCount === 1) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`))
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
      controller.error(failure)
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
