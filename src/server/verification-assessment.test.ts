import { describe, expect, it } from 'vitest'
import { inconclusiveVerificationAssessment, verificationAssessment } from './verification-assessment.js'

describe('verification outcome classification', () => {
  it.each([
    [0, 0, 0, 'inconclusive'], [4, 4, 0, 'pass'], [4, 3, 0, 'fail'],
    [4, 3, 1, 'inconclusive'], [100, 10, 90, 'inconclusive'], [100, 10, 89, 'fail'],
  ] as const)('classifies %i checked, %i matched, %i gaps as %s', (checked, matched, gaps, status) => {
    const assessment = verificationAssessment(checked, matched, gaps)
    expect(assessment).toEqual({ schemaVersion: 1, status, failedChecks: checked - matched, observationGaps: gaps })
    expect(inconclusiveVerificationAssessment(assessment, checked, matched)).toBe(status === 'inconclusive' && gaps > 0)
  })

  it.each([[1, 2, 0], [2, 1, 2], [-1, 0, 0], [1.5, 0, 0], [2, 1, NaN], [Infinity, 0, 0]])(
    'rejects impossible counts %j', (checked, matched, gaps) => {
      expect(() => verificationAssessment(checked, matched, gaps)).toThrow('Invalid verification')
    })

  it('does not suppress repair on legacy or contradictory metadata', () => {
    const valid = verificationAssessment(3, 2, 1)
    for (const value of [undefined, null, [], {}, { ...valid, schemaVersion: 2 }, { ...valid, status: 'pass' },
      { ...valid, failedChecks: 0 }, { ...valid, observationGaps: 2 }, { ...valid, observationGaps: '1' }]) {
      expect(inconclusiveVerificationAssessment(value, 3, 2)).toBe(false)
    }
    expect(inconclusiveVerificationAssessment(valid, '3', 2)).toBe(false)
    expect(inconclusiveVerificationAssessment(valid, 4, 2)).toBe(false)
    expect(inconclusiveVerificationAssessment(valid, 3, -1)).toBe(false)
  })
})
