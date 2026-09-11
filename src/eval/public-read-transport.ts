import { ToolRequestNotDispatchedError } from '../server/tool-transport.js'

/** Test transport capability boundary, independent of the model's budget and
 * run cancellation. An unavailable optional provider must remain a tool-local
 * failure so the executor can use a safe fallback. No request details (which
 * may contain credentials) belong in the rejection.
 *
 * GET/HEAD is the existing public-read canary policy, not a claim that all GET
 * APIs are free. The injected public transport still enforces network policy.
 */
export function publicReadTransport(options: {
  publicFetch: typeof fetch
  localFetch: typeof fetch
  localBaseUrl: () => string
}): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    if (!['GET', 'HEAD'].includes(request.method)) {
      throw new ToolRequestNotDispatchedError('unpriced_route')
    }
    const base = options.localBaseUrl()
    if (base && request.url === `${base}/` && request.method === 'GET') {
      return options.localFetch(request)
    }
    return options.publicFetch(request)
  }
}
