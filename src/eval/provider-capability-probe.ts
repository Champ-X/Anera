import { DOCUMENTED_FLASH_ROUTES } from './model-route-availability.js'

/** A tiny diagnostic for a documented route that disagrees with the free
 * catalog. Never runs a task, changes routing, certifies quality, or retries.
 * The only caller supplies the same write-ahead metered fetch as paid tests. */
export async function probeDocumentedProvider(options: {
  fetch: typeof fetch
  apiKey: string
  baseUrl: string
  model: string
  visionModel: string
  thinking: 'enabled' | 'disabled'
  reasoningEffort: 'low' | 'high' | 'max'
  imageDataUrl: string
  onResult: (result: ProviderCapabilityObservation) => Promise<void>
}): Promise<ProviderCapabilityObservation[]> {
  const endpoint = new URL(`${options.baseUrl.replace(/\/+$/, '')}/chat/completions`)
  if (endpoint.origin !== 'https://api.deepseek.com' || !['/chat/completions', '/v1/chat/completions'].includes(endpoint.pathname)
    || endpoint.search || endpoint.username || endpoint.password) throw new Error('Unverified capability endpoint')
  if (options.model !== DOCUMENTED_FLASH_ROUTES.text || options.visionModel !== DOCUMENTED_FLASH_ROUTES.image_input) {
    throw new Error('Capability diagnostic is restricted to the currently documented Flash routes')
  }
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(options.imageDataUrl) || options.imageDataUrl.length > 4096) {
    throw new Error('Capability diagnostic requires a small synthetic PNG')
  }
  const observations: ProviderCapabilityObservation[] = []
  for (const capability of ['text', 'image_input'] as const) {
    const model = capability === 'text' ? options.model : options.visionModel
    const content = capability === 'text' ? 'Reply with OK.' : [
      { type: 'text', text: 'Name the color in this small test image in one word.' },
      { type: 'image_url', image_url: { url: options.imageDataUrl } },
    ]
    const response = await options.fetch(endpoint.href, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false,
        // This bounds a connectivity diagnostic, not task generation. The
        // production client's quality and recovery configuration is untouched.
        max_tokens: 128, temperature: 0, thinking: { type: options.thinking },
        ...(options.thinking === 'enabled' ? { reasoning_effort: options.reasoningEffort } : {}) }),
    })
    // Consume the response to EOF so the injected ledger observes real usage.
    // Never store prompts, credentials, model text or arbitrary error messages.
    let payload: any
    try { payload = await response.json() } catch { /* Invalid response remains explicit. */ }
    const first = payload?.choices?.[0]
    const observation: ProviderCapabilityObservation = {
      capability, model, httpStatus: response.status, httpAccepted: response.ok,
      completionEnvelopeObserved: Array.isArray(payload?.choices) && typeof first?.finish_reason === 'string',
      ...(typeof payload?.model === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(payload.model) ? { returnedModel: payload.model } : {}),
      ...(typeof first?.finish_reason === 'string' && /^[a-z_]{1,40}$/.test(first.finish_reason) ? { finishReason: first.finish_reason } : {}),
      ...(typeof payload?.error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(payload.error.code) ? { errorCode: payload.error.code } : {}),
      qualityVerified: false,
    }
    observations.push(observation)
    await options.onResult(observation)
    // Do not spend a second request when the shared text route is unusable.
    if (!observation.httpAccepted || !observation.completionEnvelopeObserved) break
  }
  return observations
}

export interface ProviderCapabilityObservation {
  capability: 'text' | 'image_input'
  model: string
  httpStatus: number
  httpAccepted: boolean
  completionEnvelopeObserved: boolean
  returnedModel?: string
  finishReason?: string
  errorCode?: string
  qualityVerified: false
}
