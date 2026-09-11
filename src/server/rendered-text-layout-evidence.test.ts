import { describe, expect, it } from 'vitest'
import { normalizeRenderedTextLayout, renderedTextLayoutFindings, renderedTextLayoutViolations, type RenderedTextLayout } from './rendered-text-layout.js'

describe('text layout evidence boundaries', () => {
  const pair = { left: 'slide>div.footer>span', right: 'slide>div.hero>p', widthRatio: 0.4, heightRatio: 0.6 }
  const layout: RenderedTextLayout = { version: 2, complete: true, collisions: [pair] }

  it('round-trips independent immutable observations without storing text content', () => {
    const raw = { ...layout, secret: 'not a layout field' }
    const normalized = normalizeRenderedTextLayout(raw)
    expect(normalized).toEqual(layout)
    expect(normalized).not.toBe(raw)
    expect(normalized.collisions[0]).not.toBe(pair)
    expect(raw.secret).toBe('not a layout field')
  })

  it.each([
    null, [], { ...layout, version: 3 }, { ...layout, version: '2' }, { ...layout, complete: 1 },
    { ...layout, collisions: Array(129).fill(pair) },
    { ...layout, collisions: [pair, pair] },
    ...[NaN, Infinity, -0.1, 0, 1.1, '0.5'].map((widthRatio) => ({ ...layout, collisions: [{ ...pair, widthRatio }] })),
    { ...layout, collisions: [{ ...pair, left: 'article <script>' }] },
    { ...layout, collisions: [{ ...pair, left: pair.right }] },
    { ...layout, collisions: [{ ...pair, left: 'a'.repeat(241) }] },
  ])('rejects invalid or oversized evidence %#', (value) => {
    expect(() => normalizeRenderedTextLayout(value)).toThrow(/invalid|bounded/u)
  })

  it('never treats an incomplete observation as an overlap-free page', () => {
    expect(renderedTextLayoutViolations(layout, undefined)).toEqual([expect.stringContaining('completely measured')])
    expect(renderedTextLayoutViolations(layout, { version: 2, complete: false, collisions: [] })).toHaveLength(1)
    expect(renderedTextLayoutViolations({ ...layout, complete: false }, layout)).toHaveLength(1)
  })

  it('retains typed observation gaps without accepting arbitrary diagnostics or erasing known collisions', () => {
    const raw = { ...layout, complete: false, observationGaps: ['ink_geometry_unavailable'] }
    expect(normalizeRenderedTextLayout(raw)).toEqual(raw)
    expect(normalizeRenderedTextLayout(raw).observationGaps).not.toBe(raw.observationGaps)
    for (const observationGaps of [['PRIVATE_TEXT'], ['observation_limit', 'observation_limit'], 'ink_geometry_unavailable']) {
      expect(() => normalizeRenderedTextLayout({ ...raw, observationGaps })).toThrow()
    }
    expect(() => normalizeRenderedTextLayout({ ...raw, complete: true })).toThrow()
  })

  it('allows measured source overlap but rejects new or materially enlarged intersections', () => {
    expect(renderedTextLayoutViolations(layout, layout)).toEqual([])
    expect(renderedTextLayoutViolations(layout, { ...layout, collisions: [{ ...pair, heightRatio: 0.9 }] }))
      .toEqual([expect.stringContaining('larger than the source')])
    expect(renderedTextLayoutViolations({ ...layout, collisions: [] }, layout))
      .toEqual([expect.stringContaining('absent from the source')])
  })

  it('retains a positively measured new collision despite unrelated incomplete candidate observations', () => {
    const findings = renderedTextLayoutFindings({ ...layout, collisions: [] }, { ...layout, complete: false })
    expect(findings.defects).toEqual([expect.stringContaining('absent from the source')])
    expect(findings.observationGaps).toEqual([expect.stringContaining('completely measured')])
    expect(renderedTextLayoutViolations({ ...layout, collisions: [] }, { ...layout, complete: false }))
      .toEqual([...findings.defects, ...findings.observationGaps])
  })

  it('does not infer source absence from a partial baseline but can prove enlargement of a measured pair', () => {
    expect(renderedTextLayoutFindings({ ...layout, complete: false, collisions: [] }, layout)).toMatchObject({
      defects: [], observationGaps: [expect.stringContaining('completely measured'), expect.stringContaining('no measured source baseline')],
    })
    const findings = renderedTextLayoutFindings({ ...layout, complete: false }, {
      ...layout, complete: false, collisions: [{ ...pair, heightRatio: 0.9 }],
    })
    expect(findings.defects).toEqual([expect.stringContaining('larger than the source')])
    expect(findings.observationGaps).toHaveLength(1)
  })

  it('does not fabricate an intentional-overlap allowance for a legacy profile', () => {
    expect(renderedTextLayoutViolations(undefined, { ...layout, collisions: [] })).toEqual([])
    expect(renderedTextLayoutViolations(undefined, layout)).toEqual([expect.stringContaining('no measured source baseline')])
  })

  it('retains old font-box evidence as history, never reuses it as current ink measurements', () => {
    const legacy = normalizeRenderedTextLayout({ ...layout, version: 1 })
    expect(legacy.version).toBe(1)
    expect(renderedTextLayoutViolations(legacy, layout)).toEqual([expect.stringContaining('recapture')])
    expect(renderedTextLayoutViolations(layout, legacy)).toEqual([expect.stringContaining('recapture')])
  })
})
