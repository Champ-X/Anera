import { describe, expect, it } from 'vitest'
import { deepSeekVisionCostUsd, deepSeekVisionRatesAt, isDeepSeekVisionPeak } from './vision-pricing.js'

// Independent oracle transcribed from DeepSeek's official pricing table on
// 2026-08-31. Deliberately do not import production defaults/config here.
const OFFICIAL_VISION_ORACLE = {
  offPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
  peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
} as const

describe('DeepSeek official Vision pricing oracle', () => {
  it.each([
    ['Monday before first peak', '2026-08-31T00:59:59.999Z', false],
    ['Monday first peak opens', '2026-08-31T01:00:00.000Z', true],
    ['Monday first peak closes', '2026-08-31T04:00:00.000Z', false],
    ['Monday second peak opens', '2026-08-31T06:00:00.000Z', true],
    ['Monday second peak closes', '2026-08-31T10:00:00.000Z', false],
    ['Friday peak', '2026-09-04T09:59:59.999Z', true],
    ['Saturday same hour', '2026-09-05T09:00:00.000Z', false],
    ['Sunday same hour', '2026-08-30T02:00:00.000Z', false],
  ])('selects the official period at %s', (_name, iso, expectedPeak) => {
    expect(isDeepSeekVisionPeak(new Date(iso))).toBe(expectedPeak)
  })

  it('matches all six published rates without consulting application config', () => {
    const offPeak = deepSeekVisionRatesAt(new Date('2026-08-31T04:30:00.000Z'))
    const peak = deepSeekVisionRatesAt(new Date('2026-08-31T06:30:00.000Z'))

    expect(offPeak).toEqual({
      cacheHitInputPerMillionUsd: OFFICIAL_VISION_ORACLE.offPeak.cacheHit,
      cacheMissInputPerMillionUsd: OFFICIAL_VISION_ORACLE.offPeak.cacheMiss,
      outputPerMillionUsd: OFFICIAL_VISION_ORACLE.offPeak.output,
    })
    expect(peak).toEqual({
      cacheHitInputPerMillionUsd: OFFICIAL_VISION_ORACLE.peak.cacheHit,
      cacheMissInputPerMillionUsd: OFFICIAL_VISION_ORACLE.peak.cacheMiss,
      outputPerMillionUsd: OFFICIAL_VISION_ORACLE.peak.output,
    })
  })

  it('prices cache hits, cache misses, and output as independent buckets', () => {
    const rates = deepSeekVisionRatesAt(new Date('2026-08-31T01:30:00.000Z'))
    expect(deepSeekVisionCostUsd({
      cacheHitInputTokens: 1_000_000,
      cacheMissInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, rates)).toBe(
      OFFICIAL_VISION_ORACLE.peak.cacheHit
      + OFFICIAL_VISION_ORACLE.peak.cacheMiss
      + OFFICIAL_VISION_ORACLE.peak.output,
    )
  })
})
