import { describe, expect, it } from 'vitest'
import { advanceVisualVerificationProgress, type DurableVisualVerificationProgress,
  type VisualVerificationObservation } from './visual-verification-progress.js'

const scope = 'a'.repeat(64)
const mismatch = (sequence: number, defects = ['.heading font-family mismatch']): VisualVerificationObservation => ({
  channel: 'render.cover', sequence, verdict: 'mismatch', defects, complete: true,
})
const round = (state: DurableVisualVerificationProgress | undefined, observation: VisualVerificationObservation) => (
  advanceVisualVerificationProgress(state, scope, [observation])
)

describe('durable visual verification progress', () => {
  it('requires three fresh verification rounds for each of three recoveries, then stops the fourth recurrence', () => {
    let state: DurableVisualVerificationProgress | undefined
    const actions: string[] = []
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      const previous = JSON.stringify(state)
      const result = round(state, mismatch(sequence))
      expect(JSON.stringify(state)).toBe(previous)
      state = JSON.parse(JSON.stringify(result.state)) as DurableVisualVerificationProgress
      actions.push(result.action)
      if (sequence % 3 === 0) expect(result.recurrence).toMatchObject({
        channel: 'render.cover', rounds: 3, recoveryCount: Math.min(sequence / 3, 3),
      })
    }
    expect(actions).toEqual(['track', 'track', 'recover_phase', 'track', 'track', 'recover_phase',
      'track', 'track', 'recover_phase', 'track', 'track', 'fail'])
  })

  it('preserves unresolved render defects across arbitrary non-verifier work and source passes', () => {
    let state = round(undefined, mismatch(1)).state
    for (let sequence = 2; sequence < 100; sequence += 1) {
      state = advanceVisualVerificationProgress(state, scope, []).state
      state = round(state, { ...mismatch(sequence), channel: 'source', verdict: 'pass', defects: [] }).state
    }
    expect(round(state, mismatch(100)).action).toBe('track')
    expect(round(round(state, mismatch(100)).state, mismatch(101)).action).toBe('recover_phase')
  })

  it('removes only resolved families when a complete round makes partial progress', () => {
    const first = round(undefined, mismatch(1, ['persistent', 'resolved']))
    const second = round(first.state, mismatch(2, ['persistent', 'new']))
    expect(second.state.channels[0].defects.map((defect) => defect.family)).toEqual(['persistent', 'new'])
    const third = round(second.state, mismatch(3, ['persistent']))
    expect(third).toMatchObject({ action: 'recover_phase', recurrence: { defects: ['persistent'] } })
  })

  it('does not infer resolution or a recurrence from an omitted truncated diagnostic', () => {
    let state = round(undefined, mismatch(1, ['persistent', 'hidden'])).state
    state = round(state, { ...mismatch(2, ['persistent']), complete: false }).state
    expect(state.channels[0].defects).toEqual([
      { family: 'persistent', observations: 2, recoveries: 0 }, { family: 'hidden', observations: 1, recoveries: 0 },
    ])
    state = round(state, { ...mismatch(3, ['unrelated']), complete: false }).state
    expect(state.channels[0].defects.find((defect) => defect.family === 'persistent')?.observations).toBe(2)
    expect(round(state, { ...mismatch(4, ['persistent']), complete: false }).action).toBe('recover_phase')
  })

  it('clears only the matching verifier on a fresh pass and grants reintroduced defects a new allowance', () => {
    let state = round(undefined, mismatch(1)).state
    state = round(state, mismatch(2)).state
    state = round(state, mismatch(3)).state
    state = round(state, { ...mismatch(4), channel: 'render.closing' }).state
    state = round(state, { ...mismatch(5), verdict: 'pass', defects: [] }).state
    expect(state.channels.find((channel) => channel.channel === 'render.cover')?.defects).toEqual([])
    expect(state.channels.find((channel) => channel.channel === 'render.closing')?.defects).toHaveLength(1)
    expect(round(state, mismatch(6))).toMatchObject({ action: 'track', state: {
      channels: expect.arrayContaining([expect.objectContaining({ channel: 'render.cover',
        defects: [{ family: '.heading font-family mismatch', observations: 1, recoveries: 0 }] })]),
    } })
  })

  it('deduplicates durable receipts after reload and ignores older mismatches and passes', () => {
    const first = round(undefined, mismatch(10)).state
    const reloaded = JSON.parse(JSON.stringify(first)) as DurableVisualVerificationProgress
    const result = advanceVisualVerificationProgress(reloaded, scope, [mismatch(10), mismatch(9),
      { ...mismatch(8), verdict: 'pass', defects: [] }])
    expect(result).toEqual({ state: first, action: 'track' })
  })

  it('processes distinct out-of-order terminal receipts chronologically and duplicates only once', () => {
    expect(advanceVisualVerificationProgress(undefined, scope, [mismatch(3), mismatch(1), mismatch(2), mismatch(3)]))
      .toMatchObject({ action: 'recover_phase', state: { channels: [{ lastSequence: 3,
        defects: [{ observations: 0, recoveries: 1 }] }] } })
  })

  it('gives all pending families a fresh full window after a channel recovery', () => {
    let state = round(undefined, mismatch(1, ['first'])).state
    state = round(state, mismatch(2, ['first', 'second'])).state
    state = round(state, mismatch(3, ['first', 'second'])).state
    expect(round(state, mismatch(4, ['first', 'second'])).action).toBe('track')
    state = round(state, mismatch(4, ['first', 'second'])).state
    expect(round(state, mismatch(5, ['first', 'second'])).action).toBe('track')
  })

  it('resets on changed reference/task-local scope without mutating the old ledger', () => {
    const state = round(round(undefined, mismatch(1)).state, mismatch(2)).state
    expect(advanceVisualVerificationProgress(state, 'b'.repeat(64), [mismatch(3)]))
      .toMatchObject({ action: 'track', state: { scopeDigest: 'b'.repeat(64),
        channels: [{ defects: [{ observations: 1, recoveries: 0 }] }] } })
    expect(state.channels[0].defects[0].observations).toBe(2)
  })

  it.each([
    { sequence: 0 }, { sequence: NaN }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { channel: 'untrusted' }, { verdict: 'unknown' }, { defects: [] }, { defects: [''] },
    { defects: [123] }, { defects: ['x'.repeat(601)] }, { complete: undefined },
    { verdict: 'pass' }, { verdict: 'pass', defects: [], complete: false },
  ])('ignores malformed observations without consuming a sequence: %j', (override) => {
    const state = round(undefined, mismatch(1)).state
    expect(round(state, { ...mismatch(2), ...override } as VisualVerificationObservation)).toEqual({ state, action: 'track' })
  })

  it.each([
    { schemaVersion: 2 }, { scopeDigest: 'invalid' }, { channels: null },
    { channels: [{ channel: 'source', lastSequence: 2, defects: [{ family: 'bad', observations: 99, recoveries: 3 }] }] },
    { channels: [{ channel: 'source', lastSequence: 2, defects: [{ family: 'bad', observations: 2, recoveries: -1 }] }] },
    { channels: [{ channel: 'source', lastSequence: 2, defects: [] }, { channel: 'source', lastSequence: 3, defects: [] }] },
    { channels: [{ channel: 'source', lastSequence: 2, defects: [
      { family: 'same', observations: 2, recoveries: 3 }, { family: 'same', observations: 2, recoveries: 3 },
    ] }] },
  ])('grants a safe fresh window for malformed legacy state: %j', (override) => {
    expect(round({ schemaVersion: 1, scopeDigest: scope, channels: [], ...override } as DurableVisualVerificationProgress,
      mismatch(3))).toMatchObject({ action: 'track', state: { channels: [{ defects: [{ observations: 1, recoveries: 0 }] }] } })
  })

  it('bounds storage and retains established defects when new partial diagnostics overflow', () => {
    const first = round(undefined, mismatch(1, Array.from({ length: 100 }, (_, index) => `defect-${index}`)))
    const second = round(first.state, { ...mismatch(2, ['new', 'defect-0']), complete: false })
    expect(second.state.channels[0].defects).toHaveLength(64)
    expect(second.state.channels[0].defects[0]).toMatchObject({ family: 'defect-0', observations: 2 })
    expect(second.state.channels[0].defects.some((defect) => defect.family === 'new')).toBe(false)
  })
})
