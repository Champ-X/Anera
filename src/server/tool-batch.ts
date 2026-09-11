import type { ModelMessage } from '../shared/types.js'

type Call = NonNullable<ModelMessage['tool_calls']>[number]

/** Scheduling only, never execution authority. A capability may allow a
 * bounded batch of independent observations even while an outer workflow is
 * repairing a candidate. Mixed observation/mutation batches retain the
 * ordered limit; their dependencies cannot be inferred from provider order.
 * Keep original calls/ids and the existing exact-argument dedup semantics. */
export function admitToolBatch(calls: readonly Call[], policy: {
  maximumCalls: number
  independent?: { toolNames: ReadonlySet<string>; maximumCalls: number }
}) {
  for (const limit of [policy.maximumCalls, policy.independent?.maximumCalls ?? policy.maximumCalls]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Tool batch requires positive bounded limits')
  }
  const independent = calls.length > 0 && policy.independent
    && calls.every((call) => policy.independent!.toolNames.has(call.function.name))
  const maximumCalls = independent ? policy.independent!.maximumCalls : policy.maximumCalls
  const seen = new Set<string>()
  const admitted = calls.filter((call) => {
    const signature = JSON.stringify([call.function.name, call.function.arguments])
    if (seen.has(signature) || seen.size >= maximumCalls) return false
    seen.add(signature)
    return true
  })
  return { calls: admitted, maximumCalls,
    droppedCallIds: calls.filter((call) => !admitted.includes(call)).map((call) => call.id) }
}
