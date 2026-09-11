/** Lexicographic half-open cursor: zero-based unit, then byte offset within it.
 * [n + 1, 0] marks the end of unit n. No task semantics live in this reducer.
 */
export type EvidenceCursor = readonly [number, number]
export interface CoverageRequirement {
  subject: string
  revision: string
  totalUnits: number
}
export interface CoverageObservation extends CoverageRequirement {
  from: EvidenceCursor
  to: EvidenceCursor
}
export type CoverageAssessment =
  | { status: 'complete' }
  | { status: 'incomplete'; next: EvidenceCursor }
  | { status: 'unproven'; reason: string }

const compare = (a: EvidenceCursor, b: EvidenceCursor) => a[0] - b[0] || a[1] - b[1]
function cursor(value: unknown, total: number): value is EvidenceCursor {
  return Array.isArray(value) && value.length === 2
    && value.every((part) => Number.isSafeInteger(part) && part >= 0)
    && (value[0] < total || (value[0] === total && value[1] === 0))
}

/** Compute coverage only for the requested representation. Missing prefixes,
 * offset holes, contradictory extents and malformed receipts never prove EOF.
 * Repeated or overlapping evidence is reusable; no repeated read is required.
 */
export function assessEvidenceCoverage(
  required: CoverageRequirement,
  observations: readonly CoverageObservation[],
): CoverageAssessment {
  if (!required.subject || !required.revision || !Number.isSafeInteger(required.totalUnits) || required.totalUnits < 1) {
    return { status: 'unproven', reason: 'missing_scope_identity' }
  }
  const current = observations.filter((item) => item.subject === required.subject && item.revision === required.revision)
  if (current.length > 10_000) return { status: 'unproven', reason: 'observation_limit' }
  if (current.some((item) => item.totalUnits !== required.totalUnits
    || !cursor(item.from, required.totalUnits) || !cursor(item.to, required.totalUnits)
    || compare(item.from, item.to) >= 0)) return { status: 'unproven', reason: 'invalid_or_conflicting_span' }
  const ordered = [...current].sort((a, b) => compare(a.from, b.from) || compare(b.to, a.to))
  let frontier: EvidenceCursor = [0, 0]
  for (const item of ordered) {
    if (compare(item.from, frontier) > 0) break
    if (compare(item.to, frontier) > 0) frontier = item.to
  }
  return frontier[0] === required.totalUnits && frontier[1] === 0
    ? { status: 'complete' } : { status: 'incomplete', next: frontier }
}
