import type { WebProviderRequestMetering } from '../shared/types.js'

/** Only an owning transport may attest that no request was dispatched.
 * Never infer this from an upstream status, exception text, timeout or model
 * declaration. Fixed messages contain no URL, body or authentication data.
 */
export class ToolRequestNotDispatchedError extends Error {
  constructor(reason: 'unpriced_route' | 'capability_disabled' = 'capability_disabled') {
    super(reason === 'unpriced_route'
      ? 'Unpriced tool-provider route unavailable in this canary; use an available public-read capability'
      : 'Tool-provider capability is unavailable before dispatch; use another available capability')
    this.name = 'ToolRequestNotDispatchedError'
  }
}

/** Observe the actual transport boundary, not a proposed tool operation.
 * Callers reserve one attempt immediately before each transport invocation.
 * A proven local rejection removes only THAT invocation, never an earlier
 * redirect, sibling, model request, unknown outcome or historical reservation.
 * Ordinary failures remain conservatively counted: they may have been sent.
 */
export async function dispatchWebProviderRequest(
  attempt: WebProviderRequestMetering,
  transport: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  try {
    return await transport(input, init)
  } catch (error) {
    if (error instanceof ToolRequestNotDispatchedError) {
      attempt.calls = Math.max(0, attempt.calls - 1)
      if (attempt.calls === 0) attempt.outcome = 'not_dispatched'
    }
    throw error
  }
}
