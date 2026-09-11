import { ModelStreamBudgetExceededError, type DeepSeekClient, type ModelResult, type ModelTransportEvent } from '../server/deepseek.js'
import { parseVisualFinalReview, visualFinalEvidenceIssues, type VisualFinalReview } from '../server/visual-final-review.js'

/** A failed pre-render content review is a valid diagnostic source, not a
 * delivered artifact. Only handoff review needs completed presentation. */
export function assertReviewProbeSource(input: {
  target: string; status: string; reportStatus: string; path?: string; reportPath?: string;
  model: string; requiredModel: string; presented: boolean; missingPhases: unknown;
}): void {
  if (!['artifact', 'handoff'].includes(input.target)
    || !['completed', 'failed', 'cancelled', 'timed_out'].includes(input.status)
    || input.reportStatus !== input.status || !input.path || input.reportPath !== input.path
    || input.model !== input.requiredModel) throw new Error('Review diagnostic requires a matching terminal artifact snapshot')
  if (input.target === 'handoff' && (input.status !== 'completed' || !input.presented
    || !Array.isArray(input.missingPhases) || input.missingPhases.length !== 0)) {
    throw new Error('Handoff diagnostic requires a completed, presented artifact')
  }
}

/** Diagnostic-only collector. Never throws a provider/protocol failure away,
 * and never retains raw provider errors, model reasoning or rejected drafts.
 * A successful protocol result is not independent semantic acceptance.
 */
export async function collectVisualFinalReviewProbe(
  stream: DeepSeekClient['stream'],
  request: Omit<Parameters<DeepSeekClient['stream']>[0], 'onContent' | 'onReasoning' | 'onTransportEvent'>,
  draft: string,
  deliveryContext: string,
) {
  const transport: ModelTransportEvent[] = []
  let omittedTransportEvents = 0
  let result: ModelResult | undefined
  let review: VisualFinalReview | undefined
  let failure: { stage: 'model' | 'protocol'; code: string; detail?: string; budget?: string; used?: number; limit?: number } | undefined
  let accounting: { usage?: ModelResult['usage']; modelCallCount?: number; modelRequestCount?: number } = {}
  try {
    result = await stream({ ...request, onContent: () => {}, onReasoning: () => {},
      onTransportEvent: (event) => { if (transport.length < 64) transport.push(event); else omittedTransportEvents += 1 },
    })
    accounting = { usage: result.usage, modelCallCount: result.modelCallCount, modelRequestCount: result.modelRequestCount }
  } catch (error) {
    failure = error instanceof ModelStreamBudgetExceededError
      ? { stage: 'model', code: error.code, budget: error.budget, used: error.used, limit: error.limit }
      : { stage: 'model', code: request.signal.aborted ? 'aborted' : 'provider_failure' }
    const fields = error as { modelUsage?: Partial<ModelResult['usage']>; modelCallCount?: unknown; modelRequestCount?: unknown } | undefined
    const usage = fields?.modelUsage
    if (usage && [usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.cachedPromptTokens]
      .every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
      accounting.usage = { promptTokens: usage.promptTokens!, completionTokens: usage.completionTokens!,
        totalTokens: usage.totalTokens!, cachedPromptTokens: usage.cachedPromptTokens! }
    }
    for (const key of ['modelCallCount', 'modelRequestCount'] as const) {
      const value = fields?.[key]
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) accounting[key] = value
    }
  }
  if (result) {
    try { review = parseVisualFinalReview(result, draft) }
    // Parser errors are fixed, local diagnostics with no interpolated model
    // content. Retain which contract failed, never a provider's raw error body.
    catch (error) { failure = { stage: 'protocol', code: 'invalid_review', detail: error instanceof Error ? error.message : 'Invalid review' } }
  }
  const remainingEvidenceIssues = review ? visualFinalEvidenceIssues(review.final, deliveryContext) : undefined
  return { failure, review, remainingEvidenceIssues, ...accounting, transport, omittedTransportEvents,
    ...(result ? { finishReason: result.finishReason, contentBytes: Buffer.byteLength(result.content),
      reasoningBytes: Buffer.byteLength(result.reasoningContent), toolCallCount: result.toolCalls.length } : {}),
    protocolPassed: Boolean(review && !failure && remainingEvidenceIssues?.length === 0),
  }
}
