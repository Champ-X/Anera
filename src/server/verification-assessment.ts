/** A check failure and a demonstrated artifact defect are not synonymous.
 * Counts cover the full check set, even when human-readable findings truncate.
 * This classification routes recovery only; it never grants acceptance.
 */
export interface VerificationAssessment {
  schemaVersion: 1
  status: 'pass' | 'fail' | 'inconclusive'
  failedChecks: number
  observationGaps: number
}

export function verificationAssessment(checked: number, matched: number, observationGaps = 0): VerificationAssessment {
  if (![checked, matched, observationGaps].every((value) => Number.isSafeInteger(value) && value >= 0)
    || matched > checked || observationGaps > checked - matched) throw new Error('Invalid verification assessment counts')
  const failedChecks = checked - matched
  return { schemaVersion: 1, status: failedChecks > observationGaps ? 'fail'
    : observationGaps > 0 || checked === 0 ? 'inconclusive' : 'pass', failedChecks, observationGaps }
}

/** Legacy, malformed or contradictory metadata cannot suppress defect repair. */
export function inconclusiveVerificationAssessment(value: unknown, checked: unknown, matched: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof checked !== 'number' || typeof matched !== 'number') return false
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1 || typeof raw.observationGaps !== 'number') return false
  try {
    const assessment = verificationAssessment(checked, matched, raw.observationGaps)
    return assessment.status === 'inconclusive' && assessment.observationGaps > 0
      && raw.status === assessment.status && raw.failedChecks === assessment.failedChecks
  } catch { return false }
}
