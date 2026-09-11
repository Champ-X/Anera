import { describe, expect, it } from 'vitest'
import { assessEvidenceCoverage, type CoverageObservation, type EvidenceCursor } from './evidence-coverage.js'

const required = { subject: 'resource', revision: 'revision-a', totalUnits: 3 }
const span = (from: EvidenceCursor, to: EvidenceCursor, extra = {}): CoverageObservation => ({ ...required, from, to, ...extra })

describe('common evidence coverage', () => {
  it.each([
    [[], [0, 0]],
    [[span([2, 0], [3, 0])], [0, 0]],
    [[span([0, 0], [1, 0]), span([2, 0], [3, 0])], [1, 0]],
    [[span([0, 0], [1, 20]), span([1, 21], [3, 0])], [1, 20]],
  ])('reports the exact first missing cursor (%#)', (observations, next) => {
    expect(assessEvidenceCoverage(required, observations as CoverageObservation[])).toEqual({ status: 'incomplete', next })
  })
  it('merges overlapping, duplicate and out-of-order spans without demanding rereads', () => {
    expect(assessEvidenceCoverage(required, [span([1, 10], [3, 0]), span([0, 0], [2, 0]), span([0, 0], [2, 0])])).toEqual({ status: 'complete' })
  })
  it('joins a partial unit only when its exact prefix is covered', () => {
    expect(assessEvidenceCoverage(required, [span([0, 0], [0, 50]), span([0, 50], [3, 0])])).toEqual({ status: 'complete' })
    expect(assessEvidenceCoverage(required, [span([0, 1], [3, 0])])).toEqual({ status: 'incomplete', next: [0, 0] })
  })
  it('never combines unrelated resources or revisions', () => {
    expect(assessEvidenceCoverage(required, [span([0, 0], [2, 0], { revision: 'old' }), span([2, 0], [3, 0])])).toEqual({ status: 'incomplete', next: [0, 0] })
    expect(assessEvidenceCoverage(required, [span([0, 0], [3, 0], { subject: 'other' })])).toEqual({ status: 'incomplete', next: [0, 0] })
  })
  it.each([
    span([0, 0], [3, 0], { totalUnits: 4 }), span([-1, 0], [3, 0]), span([0, 0], [3, 1]),
    span([0, 0.5], [3, 0]), span([2, 0], [1, 0]), span([0, 0], [0, 0]),
  ])('treats malformed or contradictory spans as unproven (%#)', (observation) => {
    expect(assessEvidenceCoverage(required, [observation]).status).toBe('unproven')
  })
  it('requires a known scope and bounds observation work', () => {
    expect(assessEvidenceCoverage({ ...required, revision: '' }, [span([0, 0], [3, 0])]).status).toBe('unproven')
    expect(assessEvidenceCoverage(required, Array(10_001).fill(span([0, 0], [3, 0])))).toEqual({ status: 'unproven', reason: 'observation_limit' })
  })
})
