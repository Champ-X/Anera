import { describe, expect, it } from 'vitest'
import {
  REFERENCE_SOURCE_MAX_ATTEMPTS,
  REFERENCE_SOURCE_MAX_CANDIDATES,
  REFERENCE_SOURCE_MAX_TRANSIENT_ATTEMPTS_PER_CANDIDATE,
  advanceReferenceSourceResolution,
  bindReferenceSourceResolution,
  createReferenceSourceResolution,
  nextPendingReferenceSourceCandidate,
  normalizeReferenceSourceResolution,
  referenceSourceCandidateRejected,
  referenceSourceResolutionError,
  rejectBoundReferenceSource,
} from './reference-source-resolution.js'

const IDENTITY = 'https://github.com/example/templates#paper'
const FIRST = 'https://raw.githubusercontent.com/example/templates/HEAD/templates/paper/template.html'
const SECOND = 'https://raw.githubusercontent.com/example/templates/HEAD/templates/paper/design.md'
const SHA = 'a'.repeat(64)
const scopedCandidate = (index: number | 'overflow') => (
  `https://raw.githubusercontent.com/example/templates/HEAD/templates/paper/candidate-${index}.html`
)

describe('durable reference source resolution', () => {
  it('rejects a tentative 404 once, accepts a different candidate, and binds immutable evidence', () => {
    let state = createReferenceSourceResolution(IDENTITY, [{ url: FIRST, origin: 'tentative_convention' }])
    expect(nextPendingReferenceSourceCandidate(state)).toBe(FIRST)

    state = advanceReferenceSourceResolution(state, {
      candidateUrl: FIRST,
      origin: 'tentative_convention',
      callId: 'fetch-first',
      chunkIndex: 0,
      outcome: { kind: 'rejected', reason: 'http_not_found', detail: 'HTTP 404' },
    }).state
    expect(referenceSourceCandidateRejected(state, FIRST)).toBe(true)
    expect(nextPendingReferenceSourceCandidate(state)).toBeUndefined()

    state = advanceReferenceSourceResolution(state, {
      candidateUrl: SECOND,
      origin: 'model',
      callId: 'fetch-second',
      chunkIndex: 0,
      outcome: {
        kind: 'bound',
        binding: {
          requestedUrl: SECOND,
          resolvedUrl: SECOND,
          evidenceSha256: SHA,
          evidenceBytes: 12_345,
          callIds: ['fetch-second'],
        },
      },
    }).state

    expect(state).toMatchObject({
      schemaVersion: 1,
      identityUrl: IDENTITY,
      totalAttempts: 2,
      candidates: [
        { url: FIRST, status: 'rejected' },
        { url: SECOND, status: 'bound' },
      ],
      rejected: [{ url: FIRST, reason: 'http_not_found' }],
      bound: { requestedUrl: SECOND, evidenceSha256: SHA, evidenceBytes: 12_345 },
    })
    expect(normalizeReferenceSourceResolution(
      JSON.parse(JSON.stringify(state)),
      IDENTITY,
      [{ url: FIRST, origin: 'tentative_convention' }],
    )).toEqual(state)
  })

  it('is idempotent for terminal replay and keeps candidate and attempt history strictly bounded', () => {
    let state = createReferenceSourceResolution(IDENTITY)
    const first = {
      candidateUrl: FIRST,
      origin: 'model' as const,
      callId: 'same-call',
      chunkIndex: 0,
      outcome: { kind: 'transient_failure' as const },
    }
    const once = advanceReferenceSourceResolution(state, first)
    const replayed = advanceReferenceSourceResolution(once.state, first)
    expect(replayed).toEqual({ state: once.state, changed: false, candidateAccepted: true })
    state = replayed.state

    for (let index = 1; index < REFERENCE_SOURCE_MAX_CANDIDATES; index += 1) {
      const url = scopedCandidate(index)
      state = advanceReferenceSourceResolution(state, {
        candidateUrl: url,
        origin: 'model',
        callId: `candidate-${index}`,
        chunkIndex: 0,
        outcome: { kind: 'rejected', reason: 'not_concrete_style_evidence' },
      }).state
    }
    expect(state.candidates).toHaveLength(REFERENCE_SOURCE_MAX_CANDIDATES)
    const refused = advanceReferenceSourceResolution(state, {
      candidateUrl: scopedCandidate('overflow'),
      origin: 'model',
      callId: 'overflow',
      chunkIndex: 0,
      outcome: { kind: 'transient_failure' },
    })
    expect(refused.candidateAccepted).toBe(false)
    expect(refused.state.candidates).toHaveLength(REFERENCE_SOURCE_MAX_CANDIDATES)

    // Fill the remaining attempt budget on one existing candidate. The tail
    // and the saturating lifetime counter can never grow past the hard bound.
    for (let index = state.totalAttempts; index < REFERENCE_SOURCE_MAX_ATTEMPTS; index += 1) {
      state = advanceReferenceSourceResolution(state, {
        candidateUrl: FIRST,
        origin: 'model',
        callId: `retry-${index}`,
        chunkIndex: 0,
        outcome: { kind: 'continuation' },
      }).state
    }
    expect(state.attempts).toHaveLength(REFERENCE_SOURCE_MAX_ATTEMPTS)
    expect(state.totalAttempts).toBe(REFERENCE_SOURCE_MAX_ATTEMPTS)
    expect(referenceSourceResolutionError(state)).toMatchObject({
      code: 'reference_source_unresolved',
      reason: 'attempt_budget_exhausted',
      identityUrl: IDENTITY,
    })
  })

  it('reports typed exhaustion when every slot in the candidate budget was rejected', () => {
    let state = createReferenceSourceResolution(IDENTITY)
    for (let index = 0; index < REFERENCE_SOURCE_MAX_CANDIDATES; index += 1) {
      const url = scopedCandidate(index)
      state = advanceReferenceSourceResolution(state, {
        candidateUrl: url,
        origin: 'model',
        callId: `rejected-${index}`,
        chunkIndex: 0,
        outcome: { kind: 'rejected', reason: 'http_not_found' },
      }).state
    }

    expect(referenceSourceResolutionError(state)).toMatchObject({
      code: 'reference_source_unresolved',
      reason: 'candidate_budget_exhausted',
      identityUrl: IDENTITY,
      rejectedCandidates: expect.arrayContaining([
        { url: scopedCandidate(0), reason: 'http_not_found' },
        { url: scopedCandidate(7), reason: 'http_not_found' },
      ]),
    })
  })

  it('rotates after transient failures and caps one candidate before it can starve another', () => {
    const fallbackIdentity = 'https://github.com/example/templates#ink'
    const fallbackCandidate = 'https://raw.githubusercontent.com/example/templates/HEAD/templates/ink/template.html'
    let state = createReferenceSourceResolution(IDENTITY, [{
      url: FIRST,
      origin: 'tentative_convention',
    }, {
      url: fallbackCandidate,
      origin: 'tentative_convention',
    }], [IDENTITY, fallbackIdentity])
    state = advanceReferenceSourceResolution(state, {
      candidateUrl: FIRST,
      origin: 'tentative_convention',
      callId: 'first-transient-1',
      chunkIndex: 0,
      outcome: { kind: 'transient_failure' },
    }).state
    expect(nextPendingReferenceSourceCandidate(state)).toBe(fallbackCandidate)

    state = advanceReferenceSourceResolution(state, {
      candidateUrl: fallbackCandidate,
      origin: 'tentative_convention',
      callId: 'second-transient-1',
      chunkIndex: 0,
      outcome: { kind: 'transient_failure' },
    }).state
    expect(nextPendingReferenceSourceCandidate(state)).toBe(FIRST)

    for (let attempt = 2; attempt <= REFERENCE_SOURCE_MAX_TRANSIENT_ATTEMPTS_PER_CANDIDATE; attempt += 1) {
      state = advanceReferenceSourceResolution(state, {
        candidateUrl: FIRST,
        origin: 'tentative_convention',
        callId: `first-transient-${attempt}`,
        chunkIndex: 0,
        outcome: { kind: 'transient_failure' },
      }).state
    }
    expect(state.candidates[0]).toMatchObject({ url: FIRST, status: 'rejected' })
    expect(state.rejected).toContainEqual(expect.objectContaining({
      url: FIRST,
      reason: 'transient_attempts_exhausted',
    }))
    expect(nextPendingReferenceSourceCandidate(state)).toBe(fallbackCandidate)

    const attemptsBeforeRejectedReuse = state.totalAttempts
    const rejectedReuse = advanceReferenceSourceResolution(state, {
      candidateUrl: FIRST,
      origin: 'tentative_convention',
      callId: 'first-transient-overflow',
      chunkIndex: 0,
      outcome: { kind: 'transient_failure' },
    })
    expect(rejectedReuse.candidateAccepted).toBe(false)
    expect(rejectedReuse.state.totalAttempts).toBe(attemptsBeforeRejectedReuse)
  })

  it('fails closed on malformed persisted state and resets only for a different identity', () => {
    const malformed = normalizeReferenceSourceResolution({
      schemaVersion: 1,
      identityUrl: IDENTITY,
      candidates: [{ url: FIRST, origin: 'model', status: 'rejected' }],
      attempts: [],
      totalAttempts: 0,
      // The rejection is missing its bounded call id.
      rejected: [{ url: FIRST, reason: 'http_not_found' }],
    }, IDENTITY)
    expect(malformed.failureReason).toBe('malformed_durable_state')
    expect(referenceSourceResolutionError(malformed)).toMatchObject({
      code: 'reference_source_unresolved',
      reason: 'malformed_durable_state',
    })

    const undercounted = normalizeReferenceSourceResolution({
      schemaVersion: 1,
      identityUrl: IDENTITY,
      identityUrls: [IDENTITY],
      candidates: [{ url: FIRST, origin: 'model', status: 'pending' }],
      attempts: [{
        url: FIRST,
        callId: 'unaccounted-attempt',
        chunkIndex: 0,
        outcome: 'transient_failure',
      }],
      totalAttempts: 0,
      rejected: [],
    }, IDENTITY)
    expect(undercounted.failureReason).toBe('malformed_durable_state')

    const malformedWithBinding = {
      ...createReferenceSourceResolution(IDENTITY, [{ url: FIRST, origin: 'model' }]),
      failureReason: 'malformed_durable_state' as const,
      candidates: [{ url: FIRST, origin: 'model' as const, status: 'bound' as const }],
      bound: {
        requestedUrl: FIRST,
        resolvedUrl: FIRST,
        evidenceSha256: SHA,
        evidenceBytes: 900,
        callIds: ['legacy-bound'],
      },
    }
    expect(referenceSourceResolutionError(malformedWithBinding)).toMatchObject({
      reason: 'malformed_durable_state',
    })

    const different = normalizeReferenceSourceResolution(malformed, 'https://reference.example/new.html', [{
      url: 'https://reference.example/new.html',
      origin: 'requested',
    }])
    expect(different).toMatchObject({
      identityUrl: 'https://reference.example/new.html',
      candidates: [{ url: 'https://reference.example/new.html', status: 'pending' }],
    })
    expect(different.failureReason).toBeUndefined()
  })

  it('can invalidate a bound source after the exact-contract gate proves it is not concrete HTML', () => {
    const initial = createReferenceSourceResolution(IDENTITY, [{ url: SECOND, origin: 'model' }])
    const bound = bindReferenceSourceResolution(initial, {
      requestedUrl: SECOND,
      resolvedUrl: SECOND,
      evidenceSha256: SHA,
      evidenceBytes: 900,
      callIds: ['fetch-second'],
    })
    const rejected = rejectBoundReferenceSource(
      bound,
      'record-contract',
      'not_concrete_style_evidence',
      'CSS-only source has no usable DOM.',
    )
    expect(rejected.bound).toBeUndefined()
    expect(rejected.candidates).toEqual([{ url: SECOND, origin: 'model', status: 'rejected' }])
    expect(rejected.rejected).toMatchObject([{
      url: SECOND,
      callId: 'record-contract',
      reason: 'not_concrete_style_evidence',
    }])
  })

  it('fails closed when a binding redirects outside every authorized identity', () => {
    const initial = createReferenceSourceResolution(IDENTITY, [{ url: FIRST, origin: 'tentative_convention' }])
    const crossOriginBinding = {
      requestedUrl: FIRST,
      resolvedUrl: 'https://attacker.example/template.html',
      evidenceSha256: SHA,
      evidenceBytes: 900,
      callIds: ['fetch-cross-origin'],
    }
    const rejectedBinding = bindReferenceSourceResolution(initial, crossOriginBinding)
    expect(rejectedBinding.failureReason).toBe('malformed_durable_state')
    expect(rejectedBinding.bound).toBeUndefined()

    const rejectedPersistedBinding = normalizeReferenceSourceResolution({
      ...initial,
      candidates: [{ url: FIRST, origin: 'tentative_convention', status: 'bound' }],
      bound: crossOriginBinding,
    }, IDENTITY, [{ url: FIRST, origin: 'tentative_convention' }])
    expect(rejectedPersistedBinding.failureReason).toBe('malformed_durable_state')
    expect(rejectedPersistedBinding.bound).toBeUndefined()
  })
})
