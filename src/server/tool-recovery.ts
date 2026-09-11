/** Only the implementation owning a mandatory prerequisite may attest this.
 * It is private execution metadata, never parsed from tool/model text. A
 * capability failure cannot be repaired by resubmitting model arguments. */
export interface ToolCapabilityFailure {
  kind: 'required_capability_unavailable'
  code: 'reference_text_observation_unavailable'
  retryAfter: 'capability_change'
}

export class ToolCapabilityUnavailableError extends Error {
  readonly failure: ToolCapabilityFailure = {
    kind: 'required_capability_unavailable', code: 'reference_text_observation_unavailable', retryAfter: 'capability_change',
  }
}

export function requiredCapabilityFailure(value: unknown): ToolCapabilityFailure | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  return item.kind === 'required_capability_unavailable' && item.code === 'reference_text_observation_unavailable'
    && item.retryAfter === 'capability_change' ? { kind: item.kind, code: item.code, retryAfter: item.retryAfter } : undefined
}
