import { referenceUrlsAreRelated } from './reference-style.js'

export const REFERENCE_SOURCE_MAX_CANDIDATES = 8
export const REFERENCE_SOURCE_MAX_ATTEMPTS = 24
export const REFERENCE_SOURCE_MAX_IDENTITIES = 8
export const REFERENCE_SOURCE_MAX_TRANSIENT_ATTEMPTS_PER_CANDIDATE = 3
export const REFERENCE_SOURCE_MAX_URL_CHARACTERS = 2_000
export const REFERENCE_SOURCE_MAX_DETAIL_CHARACTERS = 320

export type ReferenceSourceCandidateOrigin = 'requested' | 'tentative_convention' | 'model'

export type ReferenceSourceCandidateStatus = 'pending' | 'fetching' | 'rejected' | 'bound'

export type ReferenceSourceRejectionReason =
  | 'http_not_found'
  | 'http_gone'
  | 'not_concrete_style_evidence'
  | 'malformed_fetch_result'
  | 'transient_attempts_exhausted'

export type ReferenceSourceAttemptOutcome =
  | 'continuation'
  | 'transient_failure'
  | 'rejected'
  | 'bound'

export interface DurableReferenceSourceCandidate {
  url: string
  origin: ReferenceSourceCandidateOrigin
  status: ReferenceSourceCandidateStatus
}

export interface DurableReferenceSourceAttempt {
  url: string
  callId: string
  chunkIndex: number
  outcome: ReferenceSourceAttemptOutcome
}

export interface DurableReferenceSourceRejection {
  url: string
  callId: string
  reason: ReferenceSourceRejectionReason
  detail?: string
}

export interface DurableReferenceSourceBinding {
  requestedUrl: string
  resolvedUrl: string
  evidenceSha256: string
  evidenceBytes: number
  callIds: string[]
}

export interface DurableReferenceSourceResolution {
  schemaVersion: 1
  /** Primary identity retained for backwards-compatible diagnostics. */
  identityUrl: string
  /** Complete bounded set of user-authorized reference identities. */
  identityUrls: string[]
  candidates: DurableReferenceSourceCandidate[]
  attempts: DurableReferenceSourceAttempt[]
  /** Saturating lifetime count; retained even when the bounded attempt tail rolls over. */
  totalAttempts: number
  rejected: DurableReferenceSourceRejection[]
  bound?: DurableReferenceSourceBinding
  /** A malformed persisted projection is never silently reset into fresh retry authority. */
  failureReason?: 'malformed_durable_state'
}

export interface ReferenceSourceAttemptObservation {
  candidateUrl: string
  origin: ReferenceSourceCandidateOrigin
  callId: string
  chunkIndex: number
  outcome:
    | { kind: 'continuation' }
    | { kind: 'transient_failure' }
    | { kind: 'rejected'; reason: ReferenceSourceRejectionReason; detail?: string }
    | { kind: 'bound'; binding: DurableReferenceSourceBinding }
}

export interface AdvanceReferenceSourceResolutionResult {
  state: DurableReferenceSourceResolution
  changed: boolean
  candidateAccepted: boolean
}

export class ReferenceSourceUnresolvedError extends Error {
  readonly code = 'reference_source_unresolved'

  constructor(
    readonly identityUrl: string,
    readonly reason: 'candidate_budget_exhausted' | 'attempt_budget_exhausted' | 'malformed_durable_state' | 'rejected_candidate_reused' | 'candidate_out_of_scope',
    readonly rejectedCandidates: ReadonlyArray<Pick<DurableReferenceSourceRejection, 'url' | 'reason'>>,
    readonly candidateUrl?: string,
  ) {
    const rejected = rejectedCandidates.length > 0
      ? ` Rejected candidates: ${rejectedCandidates.map((entry) => `${entry.url} (${entry.reason})`).join(', ')}.`
      : ''
    const candidate = candidateUrl ? ` Candidate: ${candidateUrl}.` : ''
    super(`The concrete visual reference source could not be resolved within the bounded source-resolution workflow (${reason}).${candidate}${rejected}`)
    this.name = 'ReferenceSourceUnresolvedError'
  }
}

export function createReferenceSourceResolution(
  identityUrl: string,
  candidates: readonly { url: string; origin: ReferenceSourceCandidateOrigin }[] = [],
  identityUrls: readonly string[] = [identityUrl],
): DurableReferenceSourceResolution {
  const identity = normalizedReferenceSourceUrl(identityUrl, true)
  if (!identity) {
    return malformedReferenceSourceResolution(String(identityUrl ?? ''))
  }
  const identities = normalizedReferenceSourceIdentityUrls(identity, identityUrls)
  if (!identities) return malformedReferenceSourceResolution(identity)
  const normalizedCandidates = uniqueCandidates(candidates)
  if (normalizedCandidates.some((candidate) => !referenceSourceUrlInScope(identities, candidate.url))) {
    return malformedReferenceSourceResolution(identity, identities)
  }
  return {
    schemaVersion: 1,
    identityUrl: identity,
    identityUrls: identities,
    candidates: normalizedCandidates,
    attempts: [],
    totalAttempts: 0,
    rejected: [],
  }
}

export function normalizeReferenceSourceResolution(
  value: unknown,
  identityUrl: string,
  initialCandidates: readonly { url: string; origin: ReferenceSourceCandidateOrigin }[] = [],
  identityUrls: readonly string[] = [identityUrl],
): DurableReferenceSourceResolution {
  const identity = normalizedReferenceSourceUrl(identityUrl, true)
  if (!identity) return malformedReferenceSourceResolution(String(identityUrl ?? ''))
  const expectedIdentityUrls = normalizedReferenceSourceIdentityUrls(identity, identityUrls)
  if (!expectedIdentityUrls) return malformedReferenceSourceResolution(identity)
  if (value === undefined || value === null) {
    return createReferenceSourceResolution(identity, initialCandidates, expectedIdentityUrls)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformedReferenceSourceResolution(identity)
  const raw = value as Partial<DurableReferenceSourceResolution>
  const persistedIdentity = normalizedReferenceSourceUrl(raw.identityUrl, true)
  const persistedIdentityUrls = raw.identityUrls === undefined
    ? persistedIdentity ? [persistedIdentity] : undefined
    : persistedIdentity && Array.isArray(raw.identityUrls)
      ? normalizedReferenceSourceIdentityUrls(persistedIdentity, raw.identityUrls)
      : undefined
  if (!persistedIdentityUrls || persistedIdentityUrls[0] !== persistedIdentity) {
    return malformedReferenceSourceResolution(identity, expectedIdentityUrls)
  }
  // A different authorized identity set is a different task dependency, not
  // corrupted state. This also upgrades a legacy single-identity projection
  // when a current task explicitly supplies multiple references.
  if (!sameOrderedStrings(persistedIdentityUrls, expectedIdentityUrls)) {
    return createReferenceSourceResolution(identity, initialCandidates, expectedIdentityUrls)
  }
  if (
    raw.schemaVersion !== 1
    || !Array.isArray(raw.candidates)
    || !Array.isArray(raw.attempts)
    || !Array.isArray(raw.rejected)
    || !Number.isInteger(raw.totalAttempts)
    || Number(raw.totalAttempts) < 0
    || Number(raw.totalAttempts) > REFERENCE_SOURCE_MAX_ATTEMPTS
    || raw.candidates.length > REFERENCE_SOURCE_MAX_CANDIDATES
    || raw.attempts.length > REFERENCE_SOURCE_MAX_ATTEMPTS
    || raw.rejected.length > REFERENCE_SOURCE_MAX_CANDIDATES
    || (raw.failureReason !== undefined && raw.failureReason !== 'malformed_durable_state')
  ) return malformedReferenceSourceResolution(identity, expectedIdentityUrls)

  const candidates = normalizeCandidates(raw.candidates)
  const attempts = normalizeAttempts(raw.attempts)
  let rejected = normalizeRejections(raw.rejected)
  const bound = raw.bound === undefined ? undefined : normalizeBinding(raw.bound)
  if (!candidates || !attempts || !rejected || (raw.bound !== undefined && !bound)) {
    return malformedReferenceSourceResolution(identity, expectedIdentityUrls)
  }
  if (Number(raw.totalAttempts) < attempts.length) {
    return malformedReferenceSourceResolution(identity, expectedIdentityUrls)
  }
  const candidateUrls = new Set(candidates.map((candidate) => candidate.url))
  if (
    attempts.some((attempt) => !candidateUrls.has(attempt.url))
    || rejected.some((entry) => !candidateUrls.has(entry.url))
    || candidates.some((candidate) => !referenceSourceUrlInScope(expectedIdentityUrls, candidate.url))
    || (bound && !candidateUrls.has(bound.requestedUrl))
    || (bound && rejected.some((entry) => entry.url === bound.requestedUrl))
    || (bound && !referenceSourceBindingInScope(expectedIdentityUrls, bound))
  ) return malformedReferenceSourceResolution(identity, expectedIdentityUrls)

  // Upgrade ledgers created before the per-candidate transient cap without
  // granting them a fresh retry window after restart.
  for (const candidate of candidates) {
    if (bound?.requestedUrl === candidate.url || rejected.some((entry) => entry.url === candidate.url)) continue
    const transientAttempts = attempts.filter((attempt) => (
      attempt.url === candidate.url && attempt.outcome === 'transient_failure'
    ))
    if (transientAttempts.length < REFERENCE_SOURCE_MAX_TRANSIENT_ATTEMPTS_PER_CANDIDATE) continue
    rejected.push({
      url: candidate.url,
      callId: transientAttempts.at(-1)!.callId,
      reason: 'transient_attempts_exhausted',
      detail: `The candidate reached the bounded transient-failure limit of ${REFERENCE_SOURCE_MAX_TRANSIENT_ATTEMPTS_PER_CANDIDATE}.`,
    })
  }
  rejected = rejected.slice(-REFERENCE_SOURCE_MAX_CANDIDATES)

  const rejectionUrls = new Set(rejected.map((entry) => entry.url))
  if (rejectionUrls.size !== rejected.length) return malformedReferenceSourceResolution(identity, expectedIdentityUrls)
  const boundUrl = bound?.requestedUrl
  const normalizedStatuses = candidates.map((candidate) => ({
    ...candidate,
    status: candidate.url === boundUrl
      ? 'bound' as const
      : rejectionUrls.has(candidate.url)
        ? 'rejected' as const
        : candidate.status === 'bound' || candidate.status === 'rejected'
          ? 'pending' as const
          : candidate.status,
  }))
  const merged = mergeInitialCandidates(normalizedStatuses, initialCandidates)
  if (
    merged.length > REFERENCE_SOURCE_MAX_CANDIDATES
    || merged.some((candidate) => !referenceSourceUrlInScope(expectedIdentityUrls, candidate.url))
  ) {
    return malformedReferenceSourceResolution(identity, expectedIdentityUrls)
  }
  return {
    schemaVersion: 1,
    identityUrl: identity,
    identityUrls: expectedIdentityUrls,
    candidates: merged,
    attempts,
    totalAttempts: Number(raw.totalAttempts),
    rejected,
    ...(bound ? { bound } : {}),
    ...(raw.failureReason === 'malformed_durable_state' ? { failureReason: raw.failureReason } : {}),
  }
}

export function advanceReferenceSourceResolution(
  current: DurableReferenceSourceResolution,
  observation: ReferenceSourceAttemptObservation,
): AdvanceReferenceSourceResolutionResult {
  if (current.failureReason) return { state: current, changed: false, candidateAccepted: false }
  const candidateUrl = normalizedReferenceSourceUrl(observation.candidateUrl, false)
  const callId = boundedIdentifier(observation.callId)
  if (!candidateUrl || !callId || !Number.isInteger(observation.chunkIndex) || observation.chunkIndex < 0) {
    return {
      state: malformedReferenceSourceResolution(current.identityUrl, current.identityUrls),
      changed: true,
      candidateAccepted: false,
    }
  }
  if (!referenceSourceUrlInScope(current.identityUrls, candidateUrl)) {
    return { state: current, changed: false, candidateAccepted: false }
  }
  const existingCandidate = current.candidates.find((candidate) => candidate.url === candidateUrl)
  if (!existingCandidate && current.candidates.length >= REFERENCE_SOURCE_MAX_CANDIDATES) {
    return { state: current, changed: false, candidateAccepted: false }
  }
  const duplicateAttempt = current.attempts.some((attempt) => (
    attempt.url === candidateUrl
    && attempt.callId === callId
    && attempt.chunkIndex === observation.chunkIndex
  ))
  if (duplicateAttempt) return { state: current, changed: false, candidateAccepted: true }
  if (existingCandidate?.status === 'rejected') {
    return { state: current, changed: false, candidateAccepted: false }
  }
  if (current.bound && current.bound.requestedUrl !== candidateUrl) {
    return { state: current, changed: false, candidateAccepted: false }
  }
  if (current.totalAttempts >= REFERENCE_SOURCE_MAX_ATTEMPTS) {
    return { state: current, changed: false, candidateAccepted: false }
  }

  const outcome: ReferenceSourceAttemptOutcome = observation.outcome.kind === 'continuation'
    ? 'continuation'
    : observation.outcome.kind === 'transient_failure'
      ? 'transient_failure'
      : observation.outcome.kind === 'rejected'
        ? 'rejected'
        : 'bound'
  let candidates = existingCandidate
    ? current.candidates.map((candidate) => ({ ...candidate }))
    : [...current.candidates, { url: candidateUrl, origin: observation.origin, status: 'pending' as const }]
  let rejected = current.rejected.map((entry) => ({ ...entry }))
  let bound = current.bound ? { ...current.bound, callIds: [...current.bound.callIds] } : undefined
  const candidateIndex = candidates.findIndex((candidate) => candidate.url === candidateUrl)
  const transientAttempts = current.attempts.filter((attempt) => (
    attempt.url === candidateUrl && attempt.outcome === 'transient_failure'
  )).length + (observation.outcome.kind === 'transient_failure' ? 1 : 0)
  if (observation.outcome.kind === 'rejected') {
    const detail = boundedDetail(observation.outcome.detail)
    const rejection: DurableReferenceSourceRejection = {
      url: candidateUrl,
      callId,
      reason: observation.outcome.reason,
      ...(detail ? { detail } : {}),
    }
    const existingRejectionIndex = rejected.findIndex((entry) => entry.url === candidateUrl)
    if (existingRejectionIndex >= 0) rejected[existingRejectionIndex] = rejection
    else rejected = [...rejected, rejection].slice(-REFERENCE_SOURCE_MAX_CANDIDATES)
    candidates[candidateIndex] = { ...candidates[candidateIndex], status: 'rejected' }
    if (bound?.requestedUrl === candidateUrl) bound = undefined
  } else if (
    observation.outcome.kind === 'transient_failure'
    && transientAttempts >= REFERENCE_SOURCE_MAX_TRANSIENT_ATTEMPTS_PER_CANDIDATE
  ) {
    const rejection: DurableReferenceSourceRejection = {
      url: candidateUrl,
      callId,
      reason: 'transient_attempts_exhausted',
      detail: `The candidate reached the bounded transient-failure limit of ${REFERENCE_SOURCE_MAX_TRANSIENT_ATTEMPTS_PER_CANDIDATE}.`,
    }
    const existingRejectionIndex = rejected.findIndex((entry) => entry.url === candidateUrl)
    if (existingRejectionIndex >= 0) rejected[existingRejectionIndex] = rejection
    else rejected = [...rejected, rejection].slice(-REFERENCE_SOURCE_MAX_CANDIDATES)
    candidates[candidateIndex] = { ...candidates[candidateIndex], status: 'rejected' }
  } else if (observation.outcome.kind === 'bound') {
    const normalized = normalizeBinding(observation.outcome.binding)
    if (
      !normalized
      || normalized.requestedUrl !== candidateUrl
      || !referenceSourceBindingInScope(current.identityUrls, normalized)
    ) {
      return {
        state: malformedReferenceSourceResolution(current.identityUrl, current.identityUrls),
        changed: true,
        candidateAccepted: false,
      }
    }
    rejected = rejected.filter((entry) => entry.url !== candidateUrl)
    candidates[candidateIndex] = { ...candidates[candidateIndex], status: 'bound' }
    bound = normalized
  } else {
    candidates[candidateIndex] = {
      ...candidates[candidateIndex],
      status: observation.outcome.kind === 'continuation' ? 'fetching' : 'pending',
    }
  }
  const attempts = [...current.attempts, {
    url: candidateUrl,
    callId,
    chunkIndex: observation.chunkIndex,
    outcome,
  }].slice(-REFERENCE_SOURCE_MAX_ATTEMPTS)
  return {
    state: {
      ...current,
      candidates,
      attempts,
      totalAttempts: Math.min(REFERENCE_SOURCE_MAX_ATTEMPTS, current.totalAttempts + 1),
      rejected,
      ...(bound ? { bound } : { bound: undefined }),
    },
    changed: true,
    candidateAccepted: true,
  }
}

export function rejectBoundReferenceSource(
  current: DurableReferenceSourceResolution,
  callId: string,
  reason: ReferenceSourceRejectionReason,
  detail?: string,
): DurableReferenceSourceResolution {
  if (!current.bound) return current
  const id = boundedIdentifier(callId)
  if (!id) return malformedReferenceSourceResolution(current.identityUrl, current.identityUrls)
  const candidateUrl = current.bound.requestedUrl
  const rejection: DurableReferenceSourceRejection = {
    url: candidateUrl,
    callId: id,
    reason,
    ...(boundedDetail(detail) ? { detail: boundedDetail(detail) } : {}),
  }
  return {
    ...current,
    candidates: current.candidates.map((candidate) => (
      candidate.url === candidateUrl ? { ...candidate, status: 'rejected' } : candidate
    )),
    rejected: [
      ...current.rejected.filter((entry) => entry.url !== candidateUrl),
      rejection,
    ].slice(-REFERENCE_SOURCE_MAX_CANDIDATES),
    bound: undefined,
  }
}

export function bindReferenceSourceResolution(
  current: DurableReferenceSourceResolution,
  binding: DurableReferenceSourceBinding,
  origin: ReferenceSourceCandidateOrigin = 'model',
): DurableReferenceSourceResolution {
  if (current.failureReason) return current
  const normalized = normalizeBinding(binding)
  if (!normalized || !referenceSourceBindingInScope(current.identityUrls, normalized)) {
    return malformedReferenceSourceResolution(current.identityUrl, current.identityUrls)
  }
  const existing = current.candidates.find((candidate) => candidate.url === normalized.requestedUrl)
  if (!existing && current.candidates.length >= REFERENCE_SOURCE_MAX_CANDIDATES) return current
  return {
    ...current,
    candidates: [
      ...current.candidates
        .filter((candidate) => candidate.url !== normalized.requestedUrl)
        .map((candidate) => ({ ...candidate, status: candidate.status === 'bound' ? 'pending' as const : candidate.status })),
      { url: normalized.requestedUrl, origin: existing?.origin ?? origin, status: 'bound' },
    ],
    rejected: current.rejected.filter((entry) => entry.url !== normalized.requestedUrl),
    bound: normalized,
  }
}

export function nextPendingReferenceSourceCandidate(
  state: DurableReferenceSourceResolution | undefined,
): string | undefined {
  if (!state) return undefined
  const fetching = state.candidates.find((candidate) => candidate.status === 'fetching')
  if (fetching) return fetching.url
  const attemptCounts = new Map<string, number>()
  for (const attempt of state.attempts) {
    attemptCounts.set(attempt.url, (attemptCounts.get(attempt.url) ?? 0) + 1)
  }
  let selected: DurableReferenceSourceCandidate | undefined
  let selectedAttempts = Number.POSITIVE_INFINITY
  for (const candidate of state.candidates) {
    if (candidate.status !== 'pending') continue
    const attempts = attemptCounts.get(candidate.url) ?? 0
    if (attempts >= selectedAttempts) continue
    selected = candidate
    selectedAttempts = attempts
  }
  return selected?.url
}

export function referenceSourceCandidateRejected(
  state: DurableReferenceSourceResolution | undefined,
  rawUrl: string,
): boolean {
  const url = normalizedReferenceSourceUrl(rawUrl, false)
  return Boolean(url && state?.rejected.some((entry) => entry.url === url))
}

export function canonicalReferenceSourceCandidateUrl(rawUrl: string): string | undefined {
  return normalizedReferenceSourceUrl(rawUrl, false)
}

export function referenceSourceResolutionExhaustionReason(
  state: DurableReferenceSourceResolution | undefined,
): ReferenceSourceUnresolvedError['reason'] | undefined {
  if (!state) return undefined
  if (state.failureReason === 'malformed_durable_state') return state.failureReason
  if (state.bound) return undefined
  if (state.totalAttempts >= REFERENCE_SOURCE_MAX_ATTEMPTS) return 'attempt_budget_exhausted'
  if (
    state.candidates.length >= REFERENCE_SOURCE_MAX_CANDIDATES
    && state.candidates.every((candidate) => candidate.status === 'rejected')
  ) return 'candidate_budget_exhausted'
  return undefined
}

export function referenceSourceResolutionError(
  state: DurableReferenceSourceResolution,
  reason = referenceSourceResolutionExhaustionReason(state),
): ReferenceSourceUnresolvedError | undefined {
  if (!reason) return undefined
  return new ReferenceSourceUnresolvedError(
    state.identityUrl,
    reason,
    state.rejected.map(({ url, reason: rejectionReason }) => ({ url, reason: rejectionReason })),
  )
}

function malformedReferenceSourceResolution(
  identityUrl: string,
  identityUrls: readonly string[] = [identityUrl],
): DurableReferenceSourceResolution {
  const identity = normalizedReferenceSourceUrl(identityUrl, true) ?? ''
  return {
    schemaVersion: 1,
    identityUrl: identity,
    identityUrls: normalizedReferenceSourceIdentityUrls(identity, identityUrls) ?? (identity ? [identity] : []),
    candidates: [],
    attempts: [],
    totalAttempts: 0,
    rejected: [],
    failureReason: 'malformed_durable_state',
  }
}

function normalizedReferenceSourceIdentityUrls(
  identityUrl: string,
  values: readonly unknown[],
): string[] | undefined {
  const identities = [identityUrl]
  const seen = new Set(identities)
  for (const value of values) {
    const normalized = normalizedReferenceSourceUrl(value, true)
    if (!normalized) return undefined
    if (seen.has(normalized)) continue
    seen.add(normalized)
    identities.push(normalized)
    if (identities.length > REFERENCE_SOURCE_MAX_IDENTITIES) return undefined
  }
  return identities
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function referenceSourceUrlInScope(identityUrls: readonly string[], url: string): boolean {
  return identityUrls.some((identityUrl) => referenceUrlsAreRelated(identityUrl, url))
}

function referenceSourceBindingInScope(
  identityUrls: readonly string[],
  binding: Pick<DurableReferenceSourceBinding, 'requestedUrl' | 'resolvedUrl'>,
): boolean {
  return identityUrls.some((identityUrl) => (
    referenceUrlsAreRelated(identityUrl, binding.requestedUrl)
    && referenceUrlsAreRelated(identityUrl, binding.resolvedUrl)
  ))
}

function uniqueCandidates(
  values: readonly { url: string; origin: ReferenceSourceCandidateOrigin }[],
): DurableReferenceSourceCandidate[] {
  const candidates: DurableReferenceSourceCandidate[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const url = normalizedReferenceSourceUrl(value.url, false)
    if (!url || seen.has(url)) continue
    seen.add(url)
    candidates.push({ url, origin: value.origin, status: 'pending' })
    if (candidates.length >= REFERENCE_SOURCE_MAX_CANDIDATES) break
  }
  return candidates
}

function mergeInitialCandidates(
  current: DurableReferenceSourceCandidate[],
  initial: readonly { url: string; origin: ReferenceSourceCandidateOrigin }[],
): DurableReferenceSourceCandidate[] {
  const next = current.map((candidate) => ({ ...candidate }))
  const seen = new Set(next.map((candidate) => candidate.url))
  for (const candidate of uniqueCandidates(initial)) {
    if (seen.has(candidate.url) || next.length >= REFERENCE_SOURCE_MAX_CANDIDATES) continue
    seen.add(candidate.url)
    next.push(candidate)
  }
  return next
}

function normalizeCandidates(value: readonly unknown[]): DurableReferenceSourceCandidate[] | undefined {
  const candidates: DurableReferenceSourceCandidate[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const raw = entry as Partial<DurableReferenceSourceCandidate>
    const url = normalizedReferenceSourceUrl(raw.url, false)
    if (
      !url
      || seen.has(url)
      || !['requested', 'tentative_convention', 'model'].includes(String(raw.origin))
      || !['pending', 'fetching', 'rejected', 'bound'].includes(String(raw.status))
    ) return undefined
    seen.add(url)
    candidates.push({
      url,
      origin: raw.origin as ReferenceSourceCandidateOrigin,
      status: raw.status as ReferenceSourceCandidateStatus,
    })
  }
  return candidates
}

function normalizeAttempts(value: readonly unknown[]): DurableReferenceSourceAttempt[] | undefined {
  const attempts: DurableReferenceSourceAttempt[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const raw = entry as Partial<DurableReferenceSourceAttempt>
    const url = normalizedReferenceSourceUrl(raw.url, false)
    const callId = boundedIdentifier(raw.callId)
    if (
      !url
      || !callId
      || !Number.isInteger(raw.chunkIndex)
      || Number(raw.chunkIndex) < 0
      || !['continuation', 'transient_failure', 'rejected', 'bound'].includes(String(raw.outcome))
    ) return undefined
    const key = `${url}\0${callId}\0${raw.chunkIndex}`
    if (seen.has(key)) return undefined
    seen.add(key)
    attempts.push({
      url,
      callId,
      chunkIndex: Number(raw.chunkIndex),
      outcome: raw.outcome as ReferenceSourceAttemptOutcome,
    })
  }
  return attempts
}

function normalizeRejections(value: readonly unknown[]): DurableReferenceSourceRejection[] | undefined {
  const rejected: DurableReferenceSourceRejection[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const raw = entry as Partial<DurableReferenceSourceRejection>
    const url = normalizedReferenceSourceUrl(raw.url, false)
    const callId = boundedIdentifier(raw.callId)
    if (
      !url
      || !callId
      || ![
        'http_not_found',
        'http_gone',
        'not_concrete_style_evidence',
        'malformed_fetch_result',
        'transient_attempts_exhausted',
      ].includes(String(raw.reason))
      || (raw.detail !== undefined && boundedDetail(raw.detail) !== raw.detail)
    ) return undefined
    rejected.push({
      url,
      callId,
      reason: raw.reason as ReferenceSourceRejectionReason,
      ...(raw.detail ? { detail: raw.detail } : {}),
    })
  }
  return rejected
}

function normalizeBinding(value: unknown): DurableReferenceSourceBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Partial<DurableReferenceSourceBinding>
  const requestedUrl = normalizedReferenceSourceUrl(raw.requestedUrl, false)
  const resolvedUrl = normalizedReferenceSourceUrl(raw.resolvedUrl, false)
  const callIds = Array.isArray(raw.callIds)
    ? raw.callIds.map(boundedIdentifier)
    : []
  if (
    !requestedUrl
    || !resolvedUrl
    || !/^[a-f0-9]{64}$/u.test(String(raw.evidenceSha256 ?? ''))
    || !Number.isSafeInteger(raw.evidenceBytes)
    || Number(raw.evidenceBytes) <= 0
    || callIds.length === 0
    || callIds.length > REFERENCE_SOURCE_MAX_ATTEMPTS
    || callIds.some((callId) => !callId)
    || new Set(callIds).size !== callIds.length
  ) return undefined
  return {
    requestedUrl,
    resolvedUrl,
    evidenceSha256: String(raw.evidenceSha256),
    evidenceBytes: Number(raw.evidenceBytes),
    callIds: callIds as string[],
  }
}

function normalizedReferenceSourceUrl(value: unknown, retainFragment: boolean): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > REFERENCE_SOURCE_MAX_URL_CHARACTERS) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    if (!retainFragment) url.hash = ''
    const normalized = url.toString()
    return normalized.length <= REFERENCE_SOURCE_MAX_URL_CHARACTERS ? normalized : undefined
  } catch {
    return undefined
  }
}

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined
}

function boundedDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const compact = value.replace(/\s+/gu, ' ').trim()
  if (!compact) return undefined
  return compact.length <= REFERENCE_SOURCE_MAX_DETAIL_CHARACTERS
    ? compact
    : compact.slice(0, REFERENCE_SOURCE_MAX_DETAIL_CHARACTERS)
}
