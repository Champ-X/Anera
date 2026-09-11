import http from 'node:http'
import https from 'node:https'
import { describe, expect, it, vi } from 'vitest'
import { applyOfflineTestEnvironment, assertOfflineProviderRequest, installOfflineProviderGuard } from './offline-test-environment.js'

describe('offline test provider boundary', () => {
  it('replaces inherited credentials with nonempty sentinels without tuning the model', () => {
    const environment = {
      DEEPSEEK_API_KEY: 'production-secret', OPENAI_API_KEY: 'production-image-secret',
      ANERA_IMAGE_API_KEY: '', TAVILY_API_KRY: 'production-search-secret',
      DEEPSEEK_MODEL: 'chosen-model', DEEPSEEK_THINKING: 'enabled', ANERA_MAX_OUTPUT_TOKENS: '8192',
    }
    applyOfflineTestEnvironment(environment)
    expect(environment).toMatchObject({
      DEEPSEEK_API_KEY: 'synthetic-offline-test-key', OPENAI_API_KEY: 'synthetic-offline-test-key',
      ANERA_IMAGE_API_KEY: 'synthetic-offline-test-key', TAVILY_API_KRY: 'synthetic-offline-test-key',
      DEEPSEEK_MODEL: 'chosen-model', DEEPSEEK_THINKING: 'enabled', ANERA_MAX_OUTPUT_TOKENS: '8192',
      DEEPSEEK_BASE_URL: 'https://offline-provider.invalid', ANERA_TEST_LOOPBACK_DEEPSEEK_PROVIDER: 'false',
    })
  })

  it.each([
    'https://api.deepseek.com/chat/completions',
    new URL('https://api.openai.com/v1/images/generations'),
    new Request('https://api.tavily.com/search'),
    { hostname: 'api.firecrawl.dev', path: '/v1/scrape' },
    { host: 'API.PEXELS.COM:443' },
    { host: '127.0.0.1', method: 'CONNECT', path: 'api.deepseek.com:443' },
    { hostname: '93.184.216.34', servername: 'api.deepseek.com' },
    'https://offline-provider.invalid',
  ])('refuses a real/configured provider before dispatch: %j', (input) => {
    expect(() => assertOfflineProviderRequest(input)).toThrow('Offline test blocked')
  })

  it('checks Node URL+options overrides as well as the original URL', () => {
    expect(() => assertOfflineProviderRequest('https://public.test', { hostname: 'api.deepseek.com' })).toThrow('Offline test blocked')
  })

  it.each([
    'http://127.0.0.1:43123/chat/completions', 'http://[::1]:43123',
    'https://public.test/fixture', { hostname: 'localhost', port: 43123 },
  ])('leaves local and injected network-policy fixture routes usable: %j', (input) => {
    expect(() => assertOfflineProviderRequest(input)).not.toThrow()
  })

  it('wraps global fetch and Node request/get while keeping injected transports usable', async () => {
    const previousFetch = globalThis.fetch
    const fakeFetch = vi.fn<typeof fetch>(async () => Response.json({ fixture: true }))
    globalThis.fetch = fakeFetch
    const restore = installOfflineProviderGuard()
    try {
      await expect(fetch('https://api.deepseek.com/chat/completions')).rejects.toThrow('Offline test blocked')
      expect(() => https.request('https://api.openai.com/v1/audio/speech')).toThrow('Offline test blocked')
      expect(() => http.get({ host: 'api.deepseek.com' })).toThrow('Offline test blocked')
      expect(() => http.request({ host: '127.0.0.1', method: 'CONNECT', path: 'api.deepseek.com:443' })).toThrow('Offline test blocked')
      expect(fakeFetch).not.toHaveBeenCalled()
      expect(await (await fetch('http://127.0.0.1:43123/fixture')).json()).toEqual({ fixture: true })
      expect(fakeFetch).toHaveBeenCalledTimes(1)
      expect(await (await fakeFetch('https://api.deepseek.com/chat/completions')).json()).toEqual({ fixture: true })
    } finally {
      restore()
      globalThis.fetch = previousFetch
    }
  })
})
