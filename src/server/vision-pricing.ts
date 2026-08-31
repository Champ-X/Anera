export interface DeepSeekVisionRateSet {
  cacheHitInputPerMillionUsd: number
  cacheMissInputPerMillionUsd: number
  outputPerMillionUsd: number
}

export interface DeepSeekVisionPricing {
  offPeak: DeepSeekVisionRateSet
  peak: DeepSeekVisionRateSet
}

/**
 * DeepSeek's published deepseek-v4-flash-vision-exp prices, in USD per one
 * million tokens. Keep the schedule selection separate from text-model rates:
 * Vision has its own cache-hit, cache-miss, and output price in both periods.
 *
 * Source (checked 2026-08-31):
 * https://api-docs.deepseek.com/quick_start/pricing
 */
export const DEFAULT_DEEPSEEK_VISION_PRICING: Readonly<DeepSeekVisionPricing> = Object.freeze({
  offPeak: Object.freeze({
    cacheHitInputPerMillionUsd: 0.007,
    cacheMissInputPerMillionUsd: 0.22,
    outputPerMillionUsd: 0.66,
  }),
  peak: Object.freeze({
    cacheHitInputPerMillionUsd: 0.014,
    cacheMissInputPerMillionUsd: 0.44,
    outputPerMillionUsd: 1.32,
  }),
})

/** Peak is weekdays only, in the half-open UTC windows 01:00-04:00 and 06:00-10:00. */
export function isDeepSeekVisionPeak(instant: Date): boolean {
  if (!Number.isFinite(instant.getTime())) throw new Error('Vision pricing requires a valid request timestamp')
  const weekday = instant.getUTCDay()
  if (weekday < 1 || weekday > 5) return false
  const hour = instant.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

export function deepSeekVisionRatesAt(
  instant: Date,
  pricing: DeepSeekVisionPricing = DEFAULT_DEEPSEEK_VISION_PRICING,
): DeepSeekVisionRateSet {
  return isDeepSeekVisionPeak(instant) ? pricing.peak : pricing.offPeak
}

export function deepSeekVisionCostUsd(
  usage: { cacheHitInputTokens: number; cacheMissInputTokens: number; outputTokens: number },
  rates: DeepSeekVisionRateSet,
): number {
  return (
    usage.cacheHitInputTokens * rates.cacheHitInputPerMillionUsd
    + usage.cacheMissInputTokens * rates.cacheMissInputPerMillionUsd
    + usage.outputTokens * rates.outputPerMillionUsd
  ) / 1_000_000
}
