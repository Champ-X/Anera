import { describe, expect, it } from 'vitest'
import { evidenceTextEviction, evidenceTextId, evidenceTextResolver, sharedEvidenceTexts } from './evidence-text-pool.js'

const sample = { sourceId: 'source://local/input', sourceRevision: 'a'.repeat(64), text: 'Exact observation.\nNot a complete outcome.' }
describe('request-local evidence text pooling', () => {
  it('pools exact repeated triples without mutating or normalizing observations', () => {
    const entries = [sample, { ...sample }, { ...sample, text: sample.text.replace('\n', ' ') }]
    const before = structuredClone(entries)
    const pool = sharedEvidenceTexts(entries)
    expect(pool).toEqual([{ ...sample, id: evidenceTextId(sample) }])
    expect(evidenceTextResolver(pool)(pool[0].id, sample.sourceId, sample.sourceRevision)).toBe(sample.text)
    expect(entries).toEqual(before)
  })
  it('never merges different sources or revisions with identical text', () => {
    expect(sharedEvidenceTexts([sample, { ...sample, sourceId: 'source://other' }, { ...sample, sourceRevision: 'b'.repeat(64) }])).toEqual([])
  })
  it('keeps unavailable text distinct from a present empty string', () => {
    const missing = { ...sample, text: null }
    const empty = { ...sample, text: '' }
    const pool = sharedEvidenceTexts([missing, missing, empty, empty])
    const resolve = evidenceTextResolver(pool)
    expect(pool).toHaveLength(2)
    expect(resolve(evidenceTextId(missing), missing.sourceId, missing.sourceRevision)).toBeNull()
    expect(resolve(evidenceTextId(empty), empty.sourceId, empty.sourceRevision)).toBe('')
  })
  it('rejects corrupted tables, duplicate keys, and cross-source references', () => {
    const pool = sharedEvidenceTexts([sample, sample])
    for (const value of [null, {}, [...pool, ...pool], [{ ...pool[0], text: 'changed' }], [{ ...pool[0], extra: true }]]) {
      expect(() => evidenceTextResolver(value)).toThrow()
    }
    const resolve = evidenceTextResolver(pool)
    expect(() => resolve('missing', sample.sourceId, sample.sourceRevision)).toThrow()
    expect(() => resolve(pool[0].id, 'other', sample.sourceRevision)).toThrow()
    expect(() => resolve(pool[0].id, sample.sourceId, 'b'.repeat(64))).toThrow()
    pool[0].text = 'Changed after indexing'
    expect(resolve(pool[0].id, sample.sourceId, sample.sourceRevision)).toBe(sample.text)
  })
  it('enforces entry and payload bounds', () => {
    for (const entries of [Array(65).fill(sample), [{ ...sample, text: 'x'.repeat(32_001) }], [{ ...sample, sourceRevision: 'unknown' }]]) {
      expect(() => sharedEvidenceTexts(entries)).toThrow()
    }
    expect(() => evidenceTextEviction([{ ...sample, text: null }], new Set())).toThrow()
  })
  it('evicts unrelated payloads, then extra source passages before last dependency evidence', () => {
    const a = { ...sample, text: 'a'.repeat(3000) }
    const b = { ...sample, sourceId: 'source://b', text: 'b'.repeat(2000) }
    const extra = { ...b, text: 'extra' }
    const irrelevant = { ...sample, sourceId: 'source://irrelevant', text: 'short' }
    const relevant = new Set([a.sourceId, b.sourceId])
    expect(evidenceTextEviction([a, b, b, extra, irrelevant], relevant)).toEqual([4])
    expect(evidenceTextEviction([a, b, b, extra], relevant)).toEqual([1, 2])
    expect(evidenceTextEviction([a, extra], relevant)).toEqual([0])
    expect(evidenceTextEviction([], relevant)).toEqual([])
  })
  it('does not count a different snapshot as redundant coverage of the same source', () => {
    const revised = { ...sample, sourceRevision: 'b'.repeat(64), text: 'short' }
    expect(evidenceTextEviction([sample, revised], new Set([sample.sourceId]))).toEqual([0])
  })
})
