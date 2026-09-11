import { describe, expect, it, vi } from 'vitest'
import { DeepSeekClient, type ModelResult } from './deepseek.js'

const usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, prompt_cache_hit_tokens: 2 }
const accountedUsage = { promptTokens: 3, completionTokens: 4, totalTokens: 7, cachedPromptTokens: 2 }
const sse = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`
const event = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
  choices: [{ delta, finish_reason }],
})

function client(fetchMock: typeof fetch, overrides: { firstEventTimeoutMs?: number; maxRetries?: number } = {}) {
  return new DeepSeekClient({
    apiKey: 'test', baseUrl: 'https://provider.invalid', model: 'test-model', maxOutputTokens: 8192,
    firstEventTimeoutMs: 0, maxRetries: 2, retryBaseDelayMs: 0, maxLengthContinuations: 2,
    fetch: fetchMock, ...overrides,
  })
}

function options(controller: AbortController) {
  return {
    messages: [{ role: 'user' as const, content: 'Exercise the cancellation boundary.' }],
    tools: [], signal: controller.signal, onContent: vi.fn(), onReasoning: vi.fn(), onToolCallDelta: vi.fn(),
  }
}

function observe(promise: Promise<ModelResult>) {
  return promise.then((result) => ({ status: 'resolved' as const, result }), (error: unknown) => ({ status: 'rejected' as const, error }))
}

async function promptly<T>(promise: Promise<T>): Promise<T | 'still pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<'still pending'>((resolve) => {
      timer = setTimeout(() => resolve('still pending'), 300)
    })])
  } finally {
    clearTimeout(timer)
  }
}

describe('DeepSeek cancellation independent of transport cooperation', () => {
  it.each(['resolved', 'rejected', 'hanging'] as const)('cancels a pending body read even when cleanup is %s', async (cleanup) => {
    const controller = new AbortController()
    const cancel = vi.fn(() => cleanup === 'hanging'
      ? new Promise<void>(() => {})
      : cleanup === 'rejected' ? Promise.reject(new Error('cleanup failed')) : undefined)
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }))
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    const callbacks = options(controller)
    const pending = observe(client(fetchMock).stream(callbacks))
    await vi.waitFor(() => expect(response.body?.locked).toBe(true), { interval: 1 })
    controller.abort(new DOMException('Cancelled during body read', 'AbortError'))

    expect(await promptly(pending)).toMatchObject({
      status: 'rejected', error: { name: 'AbortError', modelRequestCount: 1, modelCallCount: 0,
        modelUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 } },
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(callbacks.onContent).not.toHaveBeenCalled()
  })

  it.each(['content', 'reasoning', 'tool'] as const)('stops within a combined SSE chunk when the %s callback cancels', async (kind) => {
    const controller = new AbortController()
    const delta = {
      ...(kind === 'content' ? { content: 'visible prefix '.repeat(50) } : {}),
      ...(kind !== 'tool' ? { reasoning_content: 'before-cancel' } : {}),
      tool_calls: [
        { index: 0, id: 'call_first', function: { name: 'write_file', arguments: 'x'.repeat(1200) } },
        { index: 1, id: 'call_late', function: { name: 'edit_file', arguments: 'late'.repeat(400) } },
      ],
    }
    const response = new Response([
      sse({ ...event(delta), usage }),
      sse(event({ reasoning_content: 'after-cancel', content: 'late prose' })),
      sse({ ...event({}, 'length'), usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 } }),
    ].join(''))
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    const callbacks = options(controller)
    const cancel = () => controller.abort(new DOMException('Cancelled from callback', 'AbortError'))
    if (kind === 'content') callbacks.onContent.mockImplementationOnce(cancel)
    if (kind === 'reasoning') callbacks.onReasoning.mockImplementationOnce(cancel)
    if (kind === 'tool') callbacks.onToolCallDelta.mockImplementationOnce(cancel)
    const observed = await promptly(observe(client(fetchMock).stream(callbacks)))

    expect(observed).toMatchObject({ status: 'rejected', error: {
      name: 'AbortError', modelRequestCount: 1, modelCallCount: 1, modelUsage: accountedUsage,
    } })
    expect(callbacks.onContent).toHaveBeenCalledTimes(kind === 'content' ? 1 : 0)
    expect(callbacks.onReasoning).toHaveBeenCalledTimes(kind === 'reasoning' ? 1 : 0)
    expect(callbacks.onToolCallDelta).toHaveBeenCalledTimes(kind === 'tool' ? 1 : 0)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it('drops queued sub-threshold tool suffixes instead of flushing them after cancellation', async () => {
    const controller = new AbortController()
    const response = new Response(sse(event({ tool_calls: [
      { index: 0, id: 'call_queued', function: { name: 'write_file', arguments: '{"path":"late.txt"}' } },
    ] })) + sse({ ...event({ reasoning_content: 'cancel here' }), usage }) + sse(event({}, 'tool_calls')))
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    const callbacks = options(controller)
    callbacks.onReasoning.mockImplementationOnce(() => controller.abort())

    expect(await observe(client(fetchMock).stream(callbacks))).toMatchObject({ status: 'rejected', error: {
      modelRequestCount: 1, modelCallCount: 1, modelUsage: accountedUsage,
    } })
    expect(callbacks.onToolCallDelta).not.toHaveBeenCalled()
  })

  it.each(['flush', 'transport observer'] as const)('rejects cancellation at the completed-response %s boundary without losing usage', async (boundary) => {
    const controller = new AbortController()
    const response = new Response(sse({ ...event({ content: 'short buffered answer' }, 'stop'), usage }))
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    const callbacks = options(controller)
    if (boundary === 'flush') callbacks.onContent.mockImplementationOnce(() => controller.abort())
    const pending = client(fetchMock).stream({
      ...callbacks,
      onTransportEvent: (transport) => {
        if (boundary === 'transport observer' && transport.type === 'response') controller.abort()
      },
    })

    expect(await observe(pending)).toMatchObject({ status: 'rejected', error: {
      name: 'AbortError', modelRequestCount: 1, modelCallCount: 1, modelUsage: accountedUsage,
    } })
    expect(callbacks.onContent).toHaveBeenCalledTimes(boundary === 'flush' ? 1 : 0)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('stops after cancellation in a merged continuation and accounts for both responses exactly once', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(sse({ ...event({ content: 'Start. ' }, 'length'), usage })))
      .mockResolvedValueOnce(new Response(sse({ ...event({ content: 'Start. Continue. ' }, 'length'), usage })))
    const callbacks = options(controller)
    callbacks.onContent.mockImplementation((delta: string) => {
      if (delta.includes('Continue')) controller.abort()
    })

    expect(await observe(client(fetchMock).stream(callbacks))).toMatchObject({ status: 'rejected', error: {
      name: 'AbortError', modelRequestCount: 2, modelCallCount: 2,
      modelUsage: { promptTokens: 6, completionTokens: 8, totalTokens: 14, cachedPromptTokens: 4 },
    } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(callbacks.onContent.mock.calls.flat().join('')).toBe('Start. Continue. ')
  })

  it('does not dispatch when cancellation arrives while awaiting the durable reservation', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(sse({ ...event({}, 'stop'), usage })))
    const beforeRequest = vi.fn(async () => { controller.abort() })
    const observed = await observe(client(fetchMock).stream({ ...options(controller), beforeRequest }))

    expect(observed).toMatchObject({ status: 'rejected', error: { name: 'AbortError' } })
    expect(beforeRequest).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([true, false])('preserves earlier continuation usage exactly once when the cancelled attempt has observed usage=%s', async (observedUsage) => {
    const controller = new AbortController()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(sse({ ...event({ content: 'Start. ' }, 'length'), usage })))
      .mockResolvedValueOnce(new Response(sse({ ...event({ reasoning_content: 'cancel second request' }), ...(observedUsage ? { usage } : {}) })))
    const callbacks = options(controller)
    callbacks.onReasoning.mockImplementation(() => controller.abort())

    expect(await observe(client(fetchMock).stream(callbacks))).toMatchObject({ status: 'rejected', error: {
      name: 'AbortError', modelRequestCount: 2, modelCallCount: observedUsage ? 2 : 1,
      modelUsage: observedUsage ? { promptTokens: 6, completionTokens: 8, totalTokens: 14, cachedPromptTokens: 4 } : accountedUsage,
    } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not physically dispatch if a request observer cancels after reservation', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn<typeof fetch>()
    const beforeRequest = vi.fn(async () => {})
    const observed = await observe(client(fetchMock).stream({
      ...options(controller), beforeRequest,
      onTransportEvent: (transport) => { if (transport.type === 'request') controller.abort() },
    }))
    expect(observed).toMatchObject({ status: 'rejected', error: { name: 'AbortError' } })
    expect(beforeRequest).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    if (observed.status === 'rejected') expect(observed.error).not.toHaveProperty('modelRequestCount')
  })

  it('cancels an abort-ignoring pending fetch and disposes any late response without emitting or metering it', async () => {
    const controller = new AbortController()
    let deliver!: (response: Response) => void
    const fetchMock = vi.fn<typeof fetch>(() => new Promise((resolve) => { deliver = resolve }))
    const callbacks = options(controller)
    const pending = observe(client(fetchMock).stream(callbacks))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce(), { interval: 1 })
    controller.abort()
    const result = await promptly(pending)
    const cancel = vi.fn()
    deliver(new Response(new ReadableStream<Uint8Array>({ cancel })))
    await Promise.resolve()
    await Promise.resolve()

    expect(result).toMatchObject({ status: 'rejected', error: { name: 'AbortError', modelRequestCount: 1, modelCallCount: 0 } })
    expect(cancel).toHaveBeenCalledOnce()
    expect(callbacks.onContent).not.toHaveBeenCalled()
    expect(callbacks.onReasoning).not.toHaveBeenCalled()
  })

  it.each([200, 503])('closes a stalled HTTP %i body on the existing first-event deadline even if fetch ignores abort', async (status) => {
    const controller = new AbortController()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    const pending = observe(client(fetchMock, { firstEventTimeoutMs: 10, maxRetries: 0 }).stream(options(controller)))

    expect(await promptly(pending)).toMatchObject({ status: 'rejected', error: {
      code: 'model_first_event_timeout', modelRequestCount: 1, modelCallCount: 0,
    } })
    expect(controller.signal.aborted).toBe(false)
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('cleans up a timed-out body before a bounded pre-output retry and keeps physical requests separate from metered calls', async () => {
    const controller = new AbortController()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const stalled = new Response(new ReadableStream<Uint8Array>({ cancel }))
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(stalled)
      .mockResolvedValueOnce(new Response(sse({ ...event({ content: 'recovered' }, 'stop'), usage })))
    const callbacks = options(controller)
    const pending = observe(client(fetchMock, { firstEventTimeoutMs: 10, maxRetries: 1 }).stream(callbacks))

    expect(await promptly(pending)).toMatchObject({ status: 'resolved', result: {
      content: 'recovered', modelRequestCount: 2, modelCallCount: 1, usage: accountedUsage,
    } })
    expect(stalled.body?.locked).toBe(false)
    expect(cancel).toHaveBeenCalledOnce()
    expect(callbacks.onContent.mock.calls.flat()).toEqual(['recovered'])
  })
})
