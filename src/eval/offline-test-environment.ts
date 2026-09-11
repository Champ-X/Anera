import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

const providerKeys = [
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANERA_IMAGE_API_KEY',
  'TAVILY_API_KEY', 'TAVILY_API_KRY', 'FIRECRAWL_API_KEY', 'PEXELS_API_KEY',
] as const
const providerUrls = [
  'DEEPSEEK_BASE_URL', 'ANERA_IMAGE_BASE_URL', 'ANERA_TAVILY_BASE_URL', 'ANERA_FIRECRAWL_BASE_URL',
] as const
const knownProviderHosts = new Set([
  'api.deepseek.com', 'api.openai.com', 'api.tavily.com', 'api.firecrawl.dev', 'api.pexels.com',
  'offline-provider.invalid',
])

/** Nonempty sentinels prevent config's empty-env -> .env fallback. This changes
 * only provider credentials/routes, not model selection, thinking, or limits. */
export function applyOfflineTestEnvironment(environment: NodeJS.ProcessEnv) {
  for (const key of providerKeys) environment[key] = 'synthetic-offline-test-key'
  for (const key of providerUrls) environment[key] = 'https://offline-provider.invalid'
  environment.ANERA_TEST_LOOPBACK_DEEPSEEK_PROVIDER = 'false'
}

function isProviderHost(host: string) {
  return knownProviderHosts.has(host.toLowerCase().replace(/:\d+$/, ''))
}

export function assertOfflineProviderRequest(input: unknown, options?: unknown): void {
  if (typeof input === 'string' || input instanceof URL || input instanceof Request) {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (isProviderHost(url.hostname)) throw new Error('Offline test blocked a real provider transport; inject a fixture or use the budgeted live runner')
  }
  // Cover Node's URL+options and options-only overloads, including CONNECT
  // tunnels and pinned HTTPS requests. Injected fake transports never get here.
  for (const value of [input, options]) {
    if (!value || typeof value !== 'object') continue
    const request = value as { hostname?: unknown; host?: unknown; servername?: unknown; method?: unknown; path?: unknown }
    const hosts = [request.hostname, request.host, request.servername,
      request.method === 'CONNECT' ? request.path : undefined]
    if (hosts.some((host) => typeof host === 'string' && isProviderHost(host))) {
      throw new Error('Offline test blocked a real provider transport; inject a fixture or use the budgeted live runner')
    }
  }
}

/** An accident barrier, not a general network sandbox: real provider transports
 * are denied before dispatch; loopback and network-policy fixture tests remain
 * usable. Test-owned injected transports are intentionally unaffected. */
export function installOfflineProviderGuard(): () => void {
  const originalFetch = globalThis.fetch
  const originals = { httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get }
  globalThis.fetch = async (input, init) => {
    assertOfflineProviderRequest(input)
    return originalFetch(input, init)
  }
  for (const module of [http, https]) {
    for (const method of ['request', 'get'] as const) {
      module[method] = new Proxy(module[method], {
        apply(target, receiver, args) {
          assertOfflineProviderRequest(args[0], args[1])
          return Reflect.apply(target, receiver, args)
        },
      })
    }
  }
  syncBuiltinESMExports()
  return () => {
    globalThis.fetch = originalFetch
    http.request = originals.httpRequest
    http.get = originals.httpGet
    https.request = originals.httpsRequest
    https.get = originals.httpsGet
    syncBuiltinESMExports()
  }
}
