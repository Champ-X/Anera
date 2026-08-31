import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { BrowserManager } from '../src/server/browser-manager.js'
import { config } from '../src/server/config.js'
import { isPrivateIp } from '../src/server/network-policy.js'
import { ProcessManager } from '../src/server/process-manager.js'
import { SessionStore } from '../src/server/session-store.js'
import { ToolExecutor, type ToolExecutionResult } from '../src/server/tools.js'

const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/real-smokes')
const pageUrl = 'https://www.rfc-editor.org/rfc/rfc9110.html'
// Keep this a provider-neutral search through Tavily while preferring image
// origins that are reachable from the production runtime. Wikimedia's upload
// origin is intermittently unreachable from this environment; using it would
// turn an image-search canary into an unrelated origin-connectivity probe.
const imageQuery = 'Pexels misty forest landscape JPEG'
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-web-provider-canary-'))
const processManager = new ProcessManager(() => {}, 10_000)

function payload(result: ToolExecutionResult): Record<string, unknown> {
  return JSON.parse(result.content) as Record<string, unknown>
}

function publicMetering(result: ToolExecutionResult) {
  const usage = result.webProviderUsage
  return usage ? {
    schemaVersion: usage.schemaVersion,
    cache: usage.cache,
    ...(usage.cacheProvider ? { cacheProvider: usage.cacheProvider } : {}),
    providerCalls: usage.providerCalls,
    responseBytes: usage.responseBytes,
    requests: usage.requests,
    costUsd: usage.costUsd,
    costStatus: usage.costStatus,
  } : null
}

try {
  if (!config.tavilyApiKey) throw new Error('TAVILY_API_KEY or TAVILY_API_KRY is required')
  if (!config.firecrawlApiKey) throw new Error('FIRECRAWL_API_KEY is required')

  const store = new SessionStore(dataRoot, 'web-provider-cache-canary')
  await store.initialize()
  const session = await store.create()
  const tools = new ToolExecutor(
    store,
    processManager,
    new BrowserManager(),
    { inspect: async () => { throw new Error('vision is not used by this canary') } },
    async () => false,
    // Exercise the Tavily production fallback even on hosts that also happen
    // to configure Pexels.
    { pexelsApiKey: '' },
  )
  const signal = new AbortController().signal
  const execute = async (
    id: string,
    name: 'web_search' | 'fetch_page' | 'image_search',
    args: Record<string, unknown>,
    turnId: string,
  ) => await tools.execute({ id, name, arguments: args }, {
    sessionId: session.summary.id,
    turnId,
    stepId: `step_${id}`,
    signal,
  })

  const search = await execute(
    'call_provider_search',
    'web_search',
    { query: 'RFC 9110 HTTP semantics', depth: '1' },
    'turn_provider_a',
  )
  const imageSearch = await execute(
    'call_provider_image_search',
    'image_search',
    { query: imageQuery, count: 5 },
    'turn_provider_a',
  )
  const first = await execute(
    'call_provider_fetch_first',
    'fetch_page',
    { url: pageUrl, chunkIndex: 0 },
    'turn_provider_a',
  )
  const repeated = await execute(
    'call_provider_fetch_repeated',
    'fetch_page',
    { url: `${pageUrl}#cache-proof`, chunkIndex: 0 },
    'turn_provider_a',
  )
  const firstPayload = payload(first)
  const continuation = firstPayload.hasMore === true
    ? await execute(
        'call_provider_fetch_continuation',
        'fetch_page',
        { url: pageUrl, chunkIndex: 1 },
        'turn_provider_a',
      )
    : undefined
  const nextTurn = await execute(
    'call_provider_fetch_next_turn',
    'fetch_page',
    { url: pageUrl, chunkIndex: 0 },
    'turn_provider_b',
  )

  const searchPayload = payload(search)
  const imageSearchPayload = payload(imageSearch)
  const searchResultUrls = Array.isArray(searchPayload.results)
    ? searchPayload.results.flatMap((result) => {
        if (!result || typeof result !== 'object' || Array.isArray(result)) return []
        const url = (result as Record<string, unknown>).url
        return typeof url === 'string' ? [url] : []
      })
    : []
  const repeatedPayload = payload(repeated)
  const nextTurnPayload = payload(nextTurn)
  const imageResults = Array.isArray(imageSearchPayload.results)
    ? imageSearchPayload.results.flatMap((result) => (
        result && typeof result === 'object' && !Array.isArray(result)
          ? [result as Record<string, unknown>]
          : []
      ))
    : []
  const imageFilesHaveSupportedMagic = imageResults.length > 0 && (await Promise.all(imageResults.map(async (result) => {
    const path = result.file_path
    if (typeof path !== 'string' || !path.startsWith('images/')) return false
    try {
      const bytes = await readFile(resolve(store.workspaceDir(session.summary.id), path))
      const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      const gif = bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
      const webp = bytes.length >= 12
        && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      return png || jpeg || gif || webp
    } catch {
      return false
    }
  }))).every(Boolean)
  const searchMetering = search.webProviderUsage
  const imageSearchMetering = imageSearch.webProviderUsage
  const firstMetering = first.webProviderUsage
  const repeatedMetering = repeated.webProviderUsage
  const continuationMetering = continuation?.webProviderUsage
  const nextTurnMetering = nextTurn.webProviderUsage
  const results = {
    searchUsesTavilyOnce: !search.isError
      && searchPayload.status === 'success'
      && searchMetering?.providerCalls === 1
      && searchMetering.responseBytes > 0
      && searchMetering.requests.some((request) => request.provider === 'tavily' && request.outcome === 'success'),
    searchResultUrlsAdmitted: searchResultUrls.length > 0
      && new Set(searchResultUrls).size === searchResultUrls.length
      && searchResultUrls.every((raw) => {
        try {
          const url = new URL(raw)
          return ['http:', 'https:'].includes(url.protocol)
            && !url.username
            && !url.password
            && !url.hash
            && url.hostname !== 'localhost'
            && !url.hostname.endsWith('.local')
            && !isPrivateIp(url.hostname)
        } catch {
          return false
        }
      }),
    imageSearchUsesTavilyFallbackOnce: !imageSearch.isError
      && imageSearchPayload.status === 'success'
      && imageResults.length > 0
      && imageSearchMetering?.providerCalls === 1
      && imageSearchMetering.responseBytes > 0
      && imageSearchMetering.requests.some((request) => request.provider === 'tavily' && request.outcome === 'success'),
    imageResultsAreAdmittedAndPersisted: imageFilesHaveSupportedMagic
      && imageResults.every((result) => ['thumbnail_url', 'source_url'].every((field) => {
        const raw = result[field]
        if (typeof raw !== 'string') return false
        try {
          const url = new URL(raw)
          return ['http:', 'https:'].includes(url.protocol)
            && !url.username
            && !url.password
            && !url.hash
            && url.hostname !== 'localhost'
            && !url.hostname.endsWith('.local')
            && !isPrivateIp(url.hostname)
        } catch {
          return false
        }
      })),
    firstFetchUsesFirecrawlOnce: !first.isError
      && firstPayload.status === 'success'
      && firstMetering?.cache === 'miss'
      && firstMetering.providerCalls === 1
      && firstMetering.responseBytes > 0
      && firstMetering.requests.some((request) => request.provider === 'firecrawl' && request.outcome === 'success'),
    repeatedFetchUsesZeroProviders: !repeated.isError
      && repeatedPayload.content === firstPayload.content
      && repeatedMetering?.cache === 'hit'
      && repeatedMetering.cacheProvider === 'firecrawl'
      && repeatedMetering.providerCalls === 0
      && repeatedMetering.responseBytes === 0,
    continuationUsesZeroProviders: continuation === undefined || (
      !continuation.isError
      && continuationMetering?.cache === 'hit'
      && continuationMetering.cacheProvider === 'firecrawl'
      && continuationMetering.providerCalls === 0
    ),
    nextTurnDoesNotReuseSnapshot: !nextTurn.isError
      && nextTurnPayload.status === 'success'
      && nextTurnMetering?.cache === 'miss'
      && nextTurnMetering.providerCalls === 1
      && nextTurnMetering.requests.some((request) => request.provider === 'firecrawl' && request.outcome === 'success'),
    costsRemainExplicitlyUnknown: [search, imageSearch, first, repeated, ...(continuation ? [continuation] : []), nextTurn]
      .every((result) => result.webProviderUsage?.costUsd === null && result.webProviderUsage.costStatus === 'not_available'),
  }
  const generatedAt = new Date().toISOString()
  const report = {
    schemaVersion: 'anera-web-provider-cache-canary/1.2',
    generatedAt,
    execution: 'live Tavily and Firecrawl through production ToolExecutor',
    mobileExcluded: true,
    arenaParityGate: 'paused',
    credentials: { tavilyConfigured: true, firecrawlConfigured: true, pexelsBypassed: true, valuesStored: false },
    page: {
      url: pageUrl,
      totalChunks: firstPayload.totalChunks,
      hasMore: firstPayload.hasMore,
      firstChunkBytes: Buffer.byteLength(String(firstPayload.content ?? '')),
      continuationExercised: continuation !== undefined,
    },
    imageQuery,
    searchResultUrls,
    imageResults: imageResults.map((result) => ({
      file_path: result.file_path,
      hash: result.hash,
      thumbnail_url: result.thumbnail_url,
      title: result.title,
      source_url: result.source_url,
    })),
    metering: {
      search: publicMetering(search),
      imageSearch: publicMetering(imageSearch),
      firstFetch: publicMetering(first),
      repeatedFetch: publicMetering(repeated),
      ...(continuation ? { continuationFetch: publicMetering(continuation) } : {}),
      nextTurnFetch: publicMetering(nextTurn),
    },
    results,
    passed: Object.values(results).every(Boolean),
  }
  await mkdir(reportDirectory, { recursive: true })
  const reportPath = resolve(reportDirectory, `web-provider-cache-${generatedAt.replaceAll(':', '-')}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ reportPath, ...report }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  await processManager.stopEverything().catch(() => undefined)
  await rm(dataRoot, { recursive: true, force: true })
}
