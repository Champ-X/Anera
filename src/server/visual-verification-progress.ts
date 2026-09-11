/** Liveness only: these observations never authorize tools or satisfy a gate. */
export type VisualVerificationChannel = 'source' | 'render.cover' | 'render.content' | 'render.closing'

export interface VisualVerificationObservation {
  channel: VisualVerificationChannel
  /** Monotonic, server-authored terminal event sequence, not a model call ID. */
  sequence: number
  verdict: 'pass' | 'mismatch'
  defects: string[]
  /** Omission is evidence of resolution only for a complete diagnostic list. */
  complete: boolean
}

export interface DurableVisualVerificationProgress {
  schemaVersion: 1
  /** Task-local path + reference/verifier identity; excludes candidate hashes. */
  scopeDigest: string
  channels: Array<{
    channel: VisualVerificationChannel
    lastSequence: number
    defects: Array<{ family: string; observations: number; recoveries: number }>
  }>
}

export interface VisualVerificationRecurrence {
  channel: VisualVerificationChannel
  defects: string[]
  rounds: number
  recoveryCount: number
}

const CHANNELS: readonly VisualVerificationChannel[] = ['source', 'render.cover', 'render.content', 'render.closing']
const MAX_DEFECTS = 64
const MAX_FAMILY_LENGTH = 600
const ROUNDS_PER_WINDOW = 3
const MAX_RECOVERIES = 3
const isSequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const isFamily = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= MAX_FAMILY_LENGTH
const isCounter = (value: unknown, max: number): value is number => Number.isInteger(value)
  && (value as number) >= 0 && (value as number) <= max

function validState(value: DurableVisualVerificationProgress | undefined): value is DurableVisualVerificationProgress {
  if (!value || value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(value.scopeDigest)
    || !Array.isArray(value.channels) || value.channels.length > CHANNELS.length) return false
  const channels = new Set<string>()
  return value.channels.every((entry) => {
    if (!entry || !CHANNELS.includes(entry.channel) || channels.has(entry.channel)
      || !isSequence(entry.lastSequence) || !Array.isArray(entry.defects) || entry.defects.length > MAX_DEFECTS) return false
    channels.add(entry.channel)
    const families = new Set<string>()
    return entry.defects.every((defect) => {
      if (!defect || !isFamily(defect.family) || families.has(defect.family)
        || !isCounter(defect.observations, ROUNDS_PER_WINDOW)
        || !isCounter(defect.recoveries, MAX_RECOVERIES)) return false
      families.add(defect.family)
      return true
    })
  })
}

/**
 * Independent verifier rounds survive arbitrarily long read/edit/open paths.
 * A pass in one channel cannot erase defects in another. A partial improvement
 * removes only proven-resolved families, not an unrelated persistent defect.
 * The fixed storage bounds do not depend on message history or compaction.
 */
export function advanceVisualVerificationProgress(
  previous: DurableVisualVerificationProgress | undefined,
  scopeDigest: string,
  observations: readonly VisualVerificationObservation[],
): {
  state: DurableVisualVerificationProgress
  action: 'track' | 'recover_phase' | 'fail'
  recurrence?: VisualVerificationRecurrence
} {
  if (!/^[a-f0-9]{64}$/u.test(scopeDigest)) throw new Error('Invalid visual verification scope digest')
  const state: DurableVisualVerificationProgress = validState(previous) && previous.scopeDigest === scopeDigest
    ? { ...previous, channels: previous.channels.map((entry) => ({ ...entry, defects: entry.defects.map((defect) => ({ ...defect })) })) }
    : { schemaVersion: 1, scopeDigest, channels: [] }
  let action: 'track' | 'recover_phase' | 'fail' = 'track'
  let recurrence: VisualVerificationRecurrence | undefined
  for (const observation of [...observations].sort((left, right) => left.sequence - right.sequence)) {
    if (!CHANNELS.includes(observation.channel) || !isSequence(observation.sequence)
      || !['pass', 'mismatch'].includes(observation.verdict) || typeof observation.complete !== 'boolean'
      || !Array.isArray(observation.defects) || !observation.defects.every(isFamily)
      || (observation.verdict === 'pass' && (!observation.complete || observation.defects.length !== 0))
      || (observation.verdict === 'mismatch' && observation.defects.length === 0)) continue
    let channel = state.channels.find((entry) => entry.channel === observation.channel)
    if (channel && observation.sequence <= channel.lastSequence) continue
    if (!channel) {
      channel = { channel: observation.channel, lastSequence: observation.sequence, defects: [] }
      state.channels.push(channel)
    }
    channel.lastSequence = observation.sequence
    if (observation.verdict === 'pass') {
      channel.defects = []
      continue
    }
    const families = new Set(observation.defects)
    // Do not evict an established unresolved defect to admit diagnostic churn.
    // Omitted items in truncated results remain pending, but do not accrue a
    // new observation without positive evidence that they still fail.
    channel.defects = channel.defects.filter((defect) => !observation.complete || families.has(defect.family))
    for (const defect of channel.defects) {
      if (families.has(defect.family)) defect.observations = Math.min(ROUNDS_PER_WINDOW, defect.observations + 1)
    }
    const known = new Set(channel.defects.map((defect) => defect.family))
    for (const family of families) {
      if (channel.defects.length >= MAX_DEFECTS) break
      if (!known.has(family)) {
        channel.defects.push({ family, observations: 1, recoveries: 0 })
        known.add(family)
      }
    }
    const repeated = channel.defects.filter((defect) => defect.observations >= ROUNDS_PER_WINDOW)
    if (!repeated.length) continue
    const exhausted = repeated.some((defect) => defect.recoveries >= MAX_RECOVERIES)
    if (!exhausted) {
      for (const defect of repeated) defect.recoveries += 1
      // Every outstanding family in this channel gets a full fresh round
      // window; another almost-due family cannot cause a one-round deadline.
      for (const defect of channel.defects) defect.observations = 0
    }
    if (action !== 'fail') {
      action = exhausted ? 'fail' : 'recover_phase'
      recurrence = { channel: observation.channel, defects: repeated.slice(0, 6).map((defect) => defect.family),
        rounds: ROUNDS_PER_WINDOW, recoveryCount: Math.max(...repeated.map((defect) => defect.recoveries)) }
    }
  }
  return { state, action, ...(recurrence ? { recurrence } : {}) }
}
