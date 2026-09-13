import { describe, expect, it } from 'vitest'
import { resolveAgentRequestLimit, resolveDeepSeekModel, resolveDeepSeekVisionPricing, resolveModelTemperature, resolveTavilyApiKey, resolveTestLoopbackDeepSeekProvider } from './config.js'

describe('provider configuration', () => {
  it('disables request stopping by default and accepts explicit finite ceilings', () => {
    for (const input of ['', ' ', '0']) expect(resolveAgentRequestLimit(input)).toBe(0)
    expect(resolveAgentRequestLimit('96')).toBe(96)
    expect(resolveAgentRequestLimit('128')).toBe(128)
    for (const input of ['-1', '1.5', 'Infinity', 'NaN', '9007199254740992']) {
      expect(() => resolveAgentRequestLimit(input)).toThrow('non-negative safe integer')
    }
  })
  it.each([undefined, '', '   ', '\t\n'])('defaults an unset or blank text model (%j) to DeepSeek Flash', (value) => {
    expect(resolveDeepSeekModel(value)).toBe('deepseek-flash')
  })

  it.each([
    ['deepseek-v4-pro', 'deepseek-v4-pro'],
    ['custom-provider-model', 'custom-provider-model'],
    ['  custom-provider-model  ', 'custom-provider-model'],
    ['deepseek-chat', 'deepseek-chat'],
  ])('preserves the explicitly configured text model %s', (value, expected) => {
    expect(resolveDeepSeekModel(value)).toBe(expected)
  })

  it('prefers TAVILY_API_KEY and accepts the existing TAVILY_API_KRY spelling', () => {
    expect(resolveTavilyApiKey((name) => ({
      TAVILY_API_KEY: 'standard-key',
      TAVILY_API_KRY: 'compatibility-key',
    })[name] ?? '')).toBe('standard-key')
    expect(resolveTavilyApiKey((name) => (
      name === 'TAVILY_API_KRY' ? 'compatibility-key' : ''
    ))).toBe('compatibility-key')
  })

  it('uses deterministic sampling by default and accepts only the provider range', () => {
    expect(resolveModelTemperature('')).toBe(0)
    expect(resolveModelTemperature('0.25')).toBe(0.25)
    expect(resolveModelTemperature('-0.1')).toBe(0)
    expect(resolveModelTemperature('2.1')).toBe(0)
    expect(resolveModelTemperature('not-a-number')).toBe(0)
  })

  it('keeps the loopback DeepSeek fixture seam test-only, synthetic, and provider-scoped', () => {
    expect(resolveTestLoopbackDeepSeekProvider({
      enabled: false,
      nodeEnv: 'production',
      apiKey: 'real-key-shape-is-irrelevant-while-disabled',
      baseUrl: 'https://api.deepseek.com',
    })).toBe(false)
    expect(resolveTestLoopbackDeepSeekProvider({
      enabled: true,
      nodeEnv: 'test',
      apiKey: 'synthetic-provider-key',
      baseUrl: 'http://127.0.0.1:43123',
    })).toBe(true)
    expect(resolveTestLoopbackDeepSeekProvider({
      enabled: true,
      nodeEnv: 'test',
      apiKey: 'synthetic-provider-key',
      baseUrl: 'http://[::1]:43123/v1',
    })).toBe(true)

    for (const invalid of [
      { nodeEnv: 'production', apiKey: 'synthetic-provider-key', baseUrl: 'http://127.0.0.1:43123' },
      { nodeEnv: 'test', apiKey: 'provider-key', baseUrl: 'http://127.0.0.1:43123' },
      { nodeEnv: 'test', apiKey: 'synthetic-provider-key', baseUrl: 'http://127.0.0.1' },
      { nodeEnv: 'test', apiKey: 'synthetic-provider-key', baseUrl: 'http://192.168.1.2:43123' },
      { nodeEnv: 'test', apiKey: 'synthetic-provider-key', baseUrl: 'https://127.0.0.1:43123' },
    ]) {
      expect(() => resolveTestLoopbackDeepSeekProvider({ enabled: true, ...invalid })).toThrow()
    }
  })

  it('uses six independent official Vision defaults and never borrows the text cache rate', () => {
    const pricing = resolveDeepSeekVisionPricing((name) => (
      name === 'DEEPSEEK_CACHED_INPUT_COST_PER_MILLION_USD' ? '99' : ''
    ))

    expect(pricing).toEqual({
      offPeak: {
        cacheHitInputPerMillionUsd: 0.007,
        cacheMissInputPerMillionUsd: 0.22,
        outputPerMillionUsd: 0.66,
      },
      peak: {
        cacheHitInputPerMillionUsd: 0.014,
        cacheMissInputPerMillionUsd: 0.44,
        outputPerMillionUsd: 1.32,
      },
    })
  })

  it('allows every Vision period and token bucket to be overridden separately', () => {
    const values: Record<string, string> = {
      DEEPSEEK_VISION_CACHE_HIT_OFF_PEAK_COST_PER_MILLION_USD: '1',
      DEEPSEEK_VISION_CACHE_MISS_OFF_PEAK_COST_PER_MILLION_USD: '2',
      DEEPSEEK_VISION_OUTPUT_OFF_PEAK_COST_PER_MILLION_USD: '3',
      DEEPSEEK_VISION_CACHE_HIT_PEAK_COST_PER_MILLION_USD: '4',
      DEEPSEEK_VISION_CACHE_MISS_PEAK_COST_PER_MILLION_USD: '5',
      DEEPSEEK_VISION_OUTPUT_PEAK_COST_PER_MILLION_USD: '6',
    }

    expect(resolveDeepSeekVisionPricing((name) => values[name] ?? '')).toEqual({
      offPeak: {
        cacheHitInputPerMillionUsd: 1,
        cacheMissInputPerMillionUsd: 2,
        outputPerMillionUsd: 3,
      },
      peak: {
        cacheHitInputPerMillionUsd: 4,
        cacheMissInputPerMillionUsd: 5,
        outputPerMillionUsd: 6,
      },
    })
  })
})
