import { describe, expect, it, vi } from 'vitest'
import { probeDocumentedProvider } from './provider-capability-probe.js'

const options = () => ({ apiKey: 'PRIVATE_TEST_KEY', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash',
  visionModel: 'deepseek-v4-flash-vision-exp', thinking: 'enabled' as const, reasoningEffort: 'low' as const,
  imageDataUrl: 'data:image/png;base64,YWJj', onResult: vi.fn(async () => {}) })
const completion = (model: string) => new Response(JSON.stringify({ model, choices: [{ finish_reason: 'stop', message: { content: 'PRIVATE_TEXT' } }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { status: 200 })

describe('documented route capability diagnostic', () => {
  it('makes exactly one request per capability, keeps the configured models, and never reports quality success', async () => {
    const setup = options()
    const fetch = vi.fn().mockResolvedValueOnce(completion(setup.model)).mockResolvedValueOnce(completion(setup.visionModel))
    const result = await probeDocumentedProvider({ ...setup, fetch })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result.map((entry) => entry.capability)).toEqual(['text', 'image_input'])
    expect(result.every((entry) => entry.httpAccepted && entry.completionEnvelopeObserved && !entry.qualityVerified)).toBe(true)
    const requests = fetch.mock.calls.map((args) => JSON.parse(args[1].body))
    expect(requests.map((request) => request.model)).toEqual([setup.model, setup.visionModel])
    expect(requests[1].messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: setup.imageDataUrl } })
    for (const request of requests) expect(request).toMatchObject({ stream: false, max_tokens: 128, thinking: { type: 'enabled' }, reasoning_effort: 'low' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
    expect(setup.onResult).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 403, 404, 429, 500])('records a rejection without retrying or dispatching Vision: HTTP %s', async (status) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'model_not_found', message: 'PRIVATE_TEST_KEY' } }), { status }))
    const result = await probeDocumentedProvider({ ...options(), fetch })
    expect(fetch).toHaveBeenCalledOnce()
    expect(result).toEqual([{ capability: 'text', model: 'deepseek-v4-flash', httpStatus: status,
      httpAccepted: false, completionEnvelopeObserved: false, errorCode: 'model_not_found', qualityVerified: false }])
  })

  it('does not infer a working route from a malformed HTTP 200 body', async () => {
    const fetch = vi.fn(async () => new Response('not JSON'))
    const result = await probeDocumentedProvider({ ...options(), fetch })
    expect(fetch).toHaveBeenCalledOnce()
    expect(result[0]).toMatchObject({ httpAccepted: true, completionEnvelopeObserved: false, qualityVerified: false })
  })

  it.each([{ baseUrl: 'https://example.org' }, { model: 'deepseek-flash' }, { visionModel: 'deepseek-v4-pro' }, { imageDataUrl: 'https://example.org/private.png' }])(
    'rejects a route, model or image substitution before dispatch: %j', async (override) => {
      const fetch = vi.fn()
      await expect(probeDocumentedProvider({ ...options(), ...override, fetch })).rejects.toThrow()
      expect(fetch).not.toHaveBeenCalled()
    },
  )
})
