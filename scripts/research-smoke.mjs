import './legacy-live-test-disabled.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_TEST_URL || 'http://127.0.0.1:4174'
const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((response) => response.json())
const id = created.session.id
const rfcUrl = 'https://www.rfc-editor.org/rfc/rfc8297.html'
const mdnUrl = 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/103'
const prompt = `Research HTTP 103 Early Hints. First use web_search exactly once with depth "2" to discover relevant sources. Then independently read both of these authoritative pages with fetch_page using chunkIndex 0:
${rfcUrl}
${mdnUrl}
Give three conclusions they support in common and two implementation or compatibility cautions. Cite the exact source URL beside each claim. Do not treat search snippets as evidence and do not use any other source in the final answer.`
await fetch(`${base}/api/sessions/${id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: prompt, attachments: [] }),
})

const deadline = Date.now() + 180_000
let terminal
while (Date.now() < deadline) {
  const snapshot = await fetch(`${base}/api/sessions/${id}`).then((response) => response.json())
  if (['completed', 'failed', 'cancelled', 'timed_out'].includes(snapshot.session.status)) {
    terminal = snapshot
    break
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
}
const toolStarts = terminal?.events?.filter((event) => event.type === 'tool.started') ?? []
const toolCompleted = terminal?.events?.filter((event) => event.type === 'tool.completed') ?? []
const final = terminal?.events?.findLast((event) => event.type === 'assistant.final')?.data?.content || ''
const searchStarts = toolStarts.filter((event) => event.data.call?.name === 'web_search')
const fetchStarts = toolStarts.filter((event) => event.data.call?.name === 'fetch_page')
const searchCompleted = toolCompleted.filter((event) => event.data.call?.name === 'web_search')
const fetchCompleted = toolCompleted.filter((event) => event.data.call?.name === 'fetch_page')
const providerUsageEvents = terminal?.events?.filter((event) => event.type === 'provider.usage') ?? []
const providerUsageFor = (callId) => providerUsageEvents.find((event) => event.callId === callId)?.data?.metering
const fetchedUrls = fetchCompleted.map((event) => event.data.call.arguments.url)
const parseResult = (event) => {
  try {
    return JSON.parse(event?.data?.result)
  } catch {
    return null
  }
}
const searchResultsValid = searchCompleted.length === 1 && (() => {
  const payload = parseResult(searchCompleted[0])
  return payload?.status === 'success'
    && Array.isArray(payload.results)
    && payload.results.length > 0
    && payload.results.every((result, index) => (
      result.id === index + 1
      && typeof result.title === 'string'
      && typeof result.url === 'string'
      && typeof result.description === 'string'
    ))
})()
const fetchResultsValid = fetchCompleted.length === 2 && fetchCompleted.every((event) => {
  const payload = parseResult(event)
  return payload?.status === 'success'
    && typeof payload.url === 'string'
    && typeof payload.title === 'string'
    && typeof payload.content === 'string'
    && payload.content.length > 0
    && payload.chunkIndex === 0
    && payload.hasMore === false
    && payload.totalChunks === 1
})
const canonicalResponse = await fetch(`${base}/api/sessions/${id}/canonical.jsonl?task_id=W02`)
if (!canonicalResponse.ok) throw new Error(`canonical trace failed: ${canonicalResponse.status}`)
const canonicalEvents = (await canonicalResponse.text())
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((record) => record.recordType === 'event')
  .map((record) => record.event)
const canonicalSearch = canonicalEvents.filter((event) => event.kind === 'tool' && event.action === 'search' && event.status === 'succeeded')
const canonicalFetch = canonicalEvents.filter((event) => event.kind === 'tool' && event.action === 'fetch' && event.status === 'succeeded')
const searchProviderUsage = searchCompleted.length === 1 ? providerUsageFor(searchCompleted[0].callId) : null
const fetchProviderUsage = fetchCompleted.map((event) => providerUsageFor(event.callId))
const providerMeteringValid = providerUsageEvents.length === 3
  && searchProviderUsage?.schemaVersion === 1
  && searchProviderUsage.providerCalls === 1
  && searchProviderUsage.responseBytes > 0
  && searchProviderUsage.costUsd === null
  && searchProviderUsage.costStatus === 'not_available'
  && searchProviderUsage.requests?.some((request) => request.provider === 'tavily' && request.outcome === 'success')
  && fetchProviderUsage.every((usage) => (
    usage?.schemaVersion === 1
    && usage.cache === 'miss'
    && usage.providerCalls === 1
    && usage.responseBytes > 0
    && usage.costUsd === null
    && usage.costStatus === 'not_available'
    && usage.requests?.some((request) => request.provider === 'firecrawl' && request.outcome === 'success')
  ))
const report = {
  schemaVersion: 'anera-active-research-canary/1.1',
  generatedAt: new Date().toISOString(),
  execution: 'real configured DeepSeek provider and live public web',
  mobileExcluded: true,
  arenaParityGate: 'paused',
  sessionId: id,
  status: terminal?.session?.status,
  durationMs: terminal?.session?.usage?.durationMs,
  estimatedCostUsd: terminal?.session?.usage?.estimatedCostUsd,
  promptTokens: terminal?.session?.usage?.promptTokens,
  completionTokens: terminal?.session?.usage?.completionTokens,
  cachedPromptTokens: terminal?.session?.usage?.cachedPromptTokens,
  modelCalls: terminal?.session?.usage?.modelCalls,
  toolCalls: terminal?.session?.usage?.toolCalls,
  startedTools: toolStarts.map((event) => event.data.call?.name),
  fetchedUrls,
  searchResultsValid,
  fetchResultsValid,
  canonicalSearchEvents: canonicalSearch.length,
  canonicalFetchEvents: canonicalFetch.length,
  physicalProviderMetering: {
    valid: providerMeteringValid,
    eventCount: providerUsageEvents.length,
    providerCalls: providerUsageEvents.reduce((total, event) => total + Number(event.data?.metering?.providerCalls || 0), 0),
    responseBytes: providerUsageEvents.reduce((total, event) => total + Number(event.data?.metering?.responseBytes || 0), 0),
    costs: 'not_available',
    requests: providerUsageEvents.flatMap((event) => event.data?.metering?.requests ?? []),
  },
  final,
}
const passed = report.status === 'completed'
  && searchStarts.length === 1
  && searchStarts[0].data.call.arguments.depth === '2'
  && fetchStarts.length === 2
  && fetchStarts.every((event) => event.data.call.arguments.chunkIndex === 0)
  && searchResultsValid
  && fetchResultsValid
  && [rfcUrl, mdnUrl].every((url) => fetchedUrls.includes(url) && final.includes(url))
  && !terminal?.events?.some((event) => event.type === 'tool.failed' && ['web_search', 'fetch_page'].includes(event.data.call?.name))
  && canonicalSearch.length === 1
  && canonicalFetch.length === 2
  && providerMeteringValid
report.passed = passed
const reportRoot = resolve('reports', 'real-smokes')
await mkdir(reportRoot, { recursive: true })
const reportPath = resolve(reportRoot, `active-research-${report.generatedAt.replaceAll(':', '-')}.json`)
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ reportPath, ...report }, null, 2))
if (!passed) process.exitCode = 1
