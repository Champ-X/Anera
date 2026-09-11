import { describe, expect, it, vi } from 'vitest'
import type { WebProviderRequestMetering } from '../shared/types.js'
import { dispatchWebProviderRequest, ToolRequestNotDispatchedError } from './tool-transport.js'

const attempt = (calls = 1): WebProviderRequestMetering => ({
  provider: 'direct', operation: 'fetch', calls, responseBytes: 0, outcome: 'error',
})

describe('tool transport dispatch provenance', () => {
  it('records proven non-dispatch without swallowing the capability error', async () => {
    const record = attempt()
    const error = new ToolRequestNotDispatchedError('unpriced_route')
    const transport = vi.fn<typeof fetch>(async () => { throw error })
    await expect(dispatchWebProviderRequest(record, transport, 'https://example.org')).rejects.toBe(error)
    expect(record).toMatchObject({ calls: 0, responseBytes: 0, outcome: 'not_dispatched' })
    expect(transport).toHaveBeenCalledOnce()
  })

  it.each([
    new Error('Tool-provider capability is unavailable before dispatch; use another available capability'),
    Object.assign(new Error('unknown'), { name: 'ToolRequestNotDispatchedError' }),
    Object.assign(new Error('unknown'), { notDispatched: true }),
    new DOMException('timeout', 'TimeoutError'),
    new DOMException('cancelled', 'AbortError'),
  ])('never refunds an unknown transport outcome based on words or untrusted fields %#', async (error) => {
    const record = attempt()
    await expect(dispatchWebProviderRequest(record, async () => { throw error }, 'https://example.org')).rejects.toBe(error)
    expect(record).toEqual(attempt())
  })

  it('does not erase earlier redirects or received bytes on a later local rejection', async () => {
    const record = { ...attempt(3), responseBytes: 17 }
    await expect(dispatchWebProviderRequest(record, async () => { throw new ToolRequestNotDispatchedError() },
      'https://example.org/redirect')).rejects.toThrow('before dispatch')
    expect(record).toMatchObject({ calls: 2, responseBytes: 17, outcome: 'error' })
  })

  it.each([200, 401, 429, 503])('leaves HTTP %s dispatch accounted and the response untouched', async (status) => {
    const record = attempt()
    const response = new Response('upstream body', { status })
    expect(await dispatchWebProviderRequest(record, async () => response, 'https://example.org')).toBe(response)
    expect(record).toEqual(attempt())
    expect(await response.text()).toBe('upstream body')
  })

  it('does not alter concurrent sibling accounting', async () => {
    const unavailable = attempt()
    const sibling = attempt()
    const results = await Promise.allSettled([
      dispatchWebProviderRequest(unavailable, async () => { throw new ToolRequestNotDispatchedError() }, 'https://a.example'),
      dispatchWebProviderRequest(sibling, async () => new Response('evidence'), 'https://b.example'),
    ])
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled'])
    expect(unavailable.calls).toBe(0)
    expect(sibling).toEqual(attempt())
  })
})
