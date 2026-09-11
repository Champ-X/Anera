import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { createApp } from '../src/server/app.js'
import { exactReferenceCanonicalHtmlWriteGap } from '../src/server/agent-service.js'
import { SessionStore } from '../src/server/session-store.js'
import { referenceUrlsAreRelated } from '../src/server/reference-style.js'
import { createPublicFetch, fetchPublicUrl } from '../src/server/network-policy.js'
import { readBoundedResponseText } from '../src/server/tools.js'
import type { ToolCallRecord } from '../src/shared/types.js'

// Component/runtime validation, not a model-run task or chat UI acceptance.
// Replay only the prior contract arguments, then retrieve and validate its
// public source afresh. All new state lives in an independent evidence root.
const contractJournal = process.env.ANERA_REFERENCE_CANARY_CONTRACT_JOURNAL
if (!contractJournal) throw new Error('Set ANERA_REFERENCE_CANARY_CONTRACT_JOURNAL to a read-only prior events.jsonl')
const journalPath = resolve(contractJournal)
const priorSessionDir = dirname(journalPath)
assert.ok(basename(journalPath) === 'events.jsonl' && basename(dirname(priorSessionDir)) === 'sessions',
  'Provide a SessionStore events.jsonl so large result payloads can be hydrated read-only')
const priorEvents = await new SessionStore(dirname(dirname(priorSessionDir)), 'deepseek-chat').events(basename(priorSessionDir))
const priorRecord = priorEvents.findLast((event) => event.type === 'tool.completed'
  && (event.data.call as ToolCallRecord | undefined)?.name === 'record_reference_style' && event.data.isError !== true)
const contractArguments = (priorRecord?.data.call as ToolCallRecord | undefined)?.arguments
if (!contractArguments || typeof contractArguments.source_url !== 'string') throw new Error('No successful prior StyleContract arguments found')
const sourceUrl = contractArguments.source_url
assert.equal(typeof priorRecord?.data.result, 'string', 'The successful prior result must be hydrated')
const priorResult = JSON.parse(priorRecord!.data.result as string) as { status?: string; provenance?: { resolvedUrl?: string; evidenceSha256?: string } }
const sourceFetchUrl = priorResult.provenance?.resolvedUrl
assert.ok(priorResult.status === 'success' && typeof sourceFetchUrl === 'string'
  && referenceUrlsAreRelated(sourceUrl, sourceFetchUrl), 'Need the prior successful concrete source provenance')
const language = process.env.ANERA_REFERENCE_CANARY_LANGUAGE
assert.ok(language === undefined || language === 'zh-CN', 'Only the documented zh-CN adapter is supported')
const fontDnsMode = process.env.ANERA_REFERENCE_CANARY_FONT_DNS
assert.ok(fontDnsMode === undefined || fontDnsMode === 'google-https', 'Unknown diagnostic font DNS mode')
const fontDnsQueries: Array<{ hostname: string; addresses: string[] }> = []
// Explicit diagnostic seam only: the host's DNS/production configuration is
// unchanged. Each returned IP still passes the production public-address
// policy, CONNECT pinning and hostname TLS verification; no insecure fetch.
const diagnosticFetch = fontDnsMode ? createPublicFetch({
  proxyEnv: process.env,
  resolveAddresses: async (hostname) => {
    if (!['fonts.googleapis.com', 'fonts.gstatic.com'].includes(hostname)) return lookup(hostname, { all: true })
    const endpoint = new URL('https://dns.google/resolve')
    endpoint.searchParams.set('name', hostname)
    endpoint.searchParams.set('type', 'A')
    const response = await fetchPublicUrl(endpoint, { signal: AbortSignal.timeout(10_000) })
    assert.ok(response.ok, 'Diagnostic DNS query failed')
    const body = await readBoundedResponseText(response, 16_384)
    assert.ok(!body.truncated, 'Diagnostic DNS response exceeded its bound')
    const data = JSON.parse(body.text) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> }
    assert.ok(data.Status === 0 && Array.isArray(data.Answer), 'Diagnostic DNS returned no successful answer')
    const addresses = [...new Set(data.Answer.filter((item) => item.type === 1 && typeof item.data === 'string').map((item) => item.data!))]
    assert.ok(addresses.length > 0 && addresses.length <= 8, 'Diagnostic DNS address set is out of bounds')
    fontDnsQueries.push({ hostname, addresses })
    return addresses.map((address) => ({ address, family: 4 as const }))
  },
}) : undefined
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-reference-runtime-'))
const startedAt = Date.now()
let modelCalls = 0
let base = ''
const { app, store, agent } = await createApp({ dataRoot, agent: {
  client: { stream: async () => { modelCalls += 1; throw new Error('Component canary must not call a model') } } as never,
  toolExecutorDependencies: { localAppBaseUrl: () => base, ...(diagnosticFetch ? { fetch: diagnosticFetch } : {}) },
} })
const server = createServer(app)
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Canary did not bind an isolated server')
base = `http://127.0.0.1:${address.port}`
const session = await store.create()
const sessionId = session.summary.id
const signal = AbortSignal.timeout(180_000)
const report: Record<string, unknown> = {
  kind: 'reference-template-component-canary', fullAgentTask: false, chatUiVerified: false,
  dataRoot, sessionId, base, sourceUrl, sourceFetchUrl, contractJournal: journalPath,
  demoContentOnly: true, passed: false,
  fontDnsMode: fontDnsMode ?? 'system', fontDnsQueries,
  ...(language ? { language } : {}),
}
console.log(JSON.stringify({ dataRoot, sessionId, base, kind: report.kind }))
let sequence = 0
async function execute(name: string, args: Record<string, unknown>) {
  const id = `reference-runtime-${++sequence}`
  const call = { id, name, arguments: args }
  const context = { sessionId, turnId: 'component-canary', stepId: id, callId: id, signal }
  await store.update(sessionId, (state) => { state.messages.push({ role: 'assistant', content: null, tool_calls: [{
    id, type: 'function', function: { name, arguments: JSON.stringify(args) },
  }] }) })
  await store.append(sessionId, 'tool.started', { call }, context)
  const result = await agent['tools'].execute(call, context)
  await store.append(sessionId, result.isError ? 'tool.failed' : 'tool.completed', { call, result: result.content, isError: result.isError }, context)
  await store.update(sessionId, (state) => { state.messages.push({ role: 'tool', tool_call_id: id,
    content: result.content, tool_result_status: result.isError ? 'failed' : 'succeeded' }) })
  console.log(JSON.stringify({ tool: name, isError: result.isError, result: result.content.slice(0, 650) }))
  if (result.isError) throw new Error(`${name}: ${result.content}`)
  return JSON.parse(result.content) as Record<string, unknown>
}

try {
  const request = language
    ? `Exercise the author-documented Chinese typography of ${sourceUrl} with short synthetic Chinese demo text and unchanged Latin/digit samples. Use only this supplied template and synthetic specimen copy for a mechanical component check. Do not search.`
    : `Reproduce these HTML Slides using only the reference's original sample copy for a mechanical runtime check, strictly matching ${sourceUrl}. Do not search.`
  await store.append(sessionId, 'turn.started', { content: request }, { turnId: 'component-canary' })
  await store.update(sessionId, (state) => { state.messages = [{ role: 'user', content: request }] })
  let original = ''
  for (let chunkIndex = 0; chunkIndex < 32; chunkIndex += 1) {
    // Keep the original contract identity, but fetch its observed concrete
    // source (a GitHub blob identity itself returns repository UI chrome).
    const page = await execute('fetch_page', { url: sourceFetchUrl, chunkIndex, format: 'raw' })
    assert.equal(typeof page.content, 'string')
    original += page.content as string
    if (page.hasMore !== true) break
    assert.ok(chunkIndex < 31, 'Reference pagination did not finish')
  }
  assert.equal(createHash('sha256').update(original).digest('hex'), priorResult.provenance?.evidenceSha256,
    'The previously reviewed source revision changed; do not replay stale contract arguments')
  await execute('record_reference_style', { ...contractArguments, ...(language ? { language } : {}) })
  const reference = (await store.get(sessionId)).activeReferenceStyleContract
  assert.ok(reference?.templateCatalog && reference.renderProfile && reference.fontEvidence)
  if (language) assert.ok(reference.languageVariant, 'No source-authorized language variant was recorded')
  report.languageVariant = reference.languageVariant
  assert.equal(reference.templateCatalog.sourceSha256, createHash('sha256').update(original).digest('hex'))
  const selectedVariantIds = process.env.ANERA_REFERENCE_CANARY_VARIANTS?.split(',').map((id) => id.trim())
    ?? reference.templateCatalog.variants.map((variant) => variant.id)
  assert.ok(selectedVariantIds.length >= 3 && selectedVariantIds.length <= 64, 'Select 3–64 source variants')
  const selectedVariants = selectedVariantIds.map((id) => {
    const variant = reference.templateCatalog!.variants.find((item) => item.id === id)
    assert.ok(variant, `Unknown selected variant ${id}`)
    return variant
  })
  report.selectedVariantIds = selectedVariantIds
  const unitBindings: unknown = JSON.parse(process.env.ANERA_REFERENCE_CANARY_UNIT_BINDINGS || '{}')
  assert.ok(unitBindings && typeof unitBindings === 'object' && !Array.isArray(unitBindings), 'Unit overrides must be a variant-to-slots object')
  for (const [variantId, bindings] of Object.entries(unitBindings)) {
    const variant = selectedVariants.find((item) => item.id === variantId)
    assert.ok(variant, `Unit overrides reference unselected variant ${variantId}`)
    assert.ok(bindings && typeof bindings === 'object' && !Array.isArray(bindings), 'Unit overrides must use slot IDs')
    for (const [slotId, copy] of Object.entries(bindings)) {
      assert.ok(variant.slots.some((slot) => slot.id === slotId && slot.role === 'unit'), `Not a unit slot: ${variantId}.${slotId}`)
      assert.ok(typeof copy === 'string' && copy.length <= 32, 'Unit test copy must be a bounded string')
    }
  }
  report.unitBindings = unitBindings
  const slides = selectedVariants.map((variant) => ({
    variant: variant.id, label: `Component sample ${variant.id}`,
    texts: { ...Object.fromEntries(variant.slots.map((slot, index) => {
      const role = reference.languageVariant?.bindings.find((item) => item.variant === variant.id && item.slot === slot.id)?.role
      const copy = !language || !/[a-z]/iu.test(slot.sample) || slot.allowEmpty ? slot.sample
        : role === 'display' ? '中文'
          : role === 'body' ? '中文正文示例'
            : index % 2 ? '中文标签' : slot.sample
      return [slot.id, copy]
    })),
      ...(unitBindings as Record<string, Record<string, string>>)[variant.id] },
  }))
  const composed = await execute('compose_reference_html', {
    path: 'runtime-sample.html', source_sha256: reference.templateCatalog.sourceSha256,
    title: 'Anera reference runtime canary — demo content only', slides,
  })
  const html = await readFile(resolve(store.workspaceDir(sessionId), 'runtime-sample.html'), 'utf8')
  const css = (source: string) => {
    const pending: DefaultTreeAdapterMap['node'][] = [parse(source, { sourceCodeLocationInfo: true })]
    const styles: string[] = []
    while (pending.length) {
      const node = pending.pop()!
      if ('tagName' in node && node.tagName === 'style') {
        const location = node.sourceCodeLocation
        assert.ok(location?.startTag && location.endTag)
        styles.push(source.slice(location.startTag.endOffset, location.endTag.startOffset))
      }
      if ('childNodes' in node) pending.push(...[...node.childNodes].reverse())
    }
    return styles
  }
  assert.deepEqual(css(html), css(original), 'Original CSS bytes changed during composition')
  report.composition = composed
  report.sourceCssPreserved = true
  report.canonicalAdmissionGap = exactReferenceCanonicalHtmlWriteGap((await store.get(sessionId)).messages,
    html, Number.POSITIVE_INFINITY, reference, [], undefined, { urls: [sourceUrl], strictness: 'exact' }) ?? null
  const sourceVerification = await execute('verify_reference_style', { path: 'runtime-sample.html' })
  report.sourceVerification = sourceVerification
  const verifiedReference = (await store.get(sessionId)).activeReferenceStyleContract
  assert.ok(verifiedReference?.fontEvidence)
  report.fontEvidence = verifiedReference.fontEvidence
  const fonts = await store.resolveReferenceFontEvidence(sessionId, verifiedReference.fontEvidence)
  const fontOptions = { fontCss: fonts.fontCss, expectedFontFamilies: fonts.familyNames,
    ...(reference.languageVariant ? { languageVariant: reference.languageVariant } : {}) }
  await agent.browser.setViewport(sessionId, reference.contract.viewport.width, reference.contract.viewport.height, signal)
  const snapshots: Record<string, unknown> = {}
  const rendered: Record<string, unknown> = {}
  snapshots.cover = await agent.browser.open(sessionId, `${base}/workspace/${sessionId}/preview/runtime-sample.html`, signal)
  for (const phase of ['cover', 'content', 'closing'] as const) {
    if (phase !== 'cover') snapshots[phase] = await agent.browser.press(sessionId, phase === 'content' ? 'ArrowRight' : 'End', undefined, signal)
    const frame = await agent.browser.verifyRenderedReferenceStyleAndScreenshot(sessionId, reference.renderProfile, phase, signal,
      fontOptions)
    await writeFile(resolve(dataRoot, `${phase}.png`), frame.screenshot)
    rendered[phase] = frame.verification
    console.log(JSON.stringify({ phase, verification: frame.verification }))
  }
  snapshots.home = await agent.browser.press(sessionId, 'Home', undefined, signal)
  const home = await agent.browser.verifyRenderedReferenceStyle(sessionId, reference.renderProfile, 'cover', signal,
    fontOptions)
  rendered.home = home
  const interiorScreenshots: Array<{ slideIndex: number; variant: string; path: string; sha256: string }> = []
  for (let index = 1; index < selectedVariants.length - 1; index += 1) {
    await agent.browser.press(sessionId, 'ArrowRight', undefined, signal)
    const png = await agent.browser.screenshot(sessionId, signal)
    const path = resolve(dataRoot, `slide-${index + 1}-${selectedVariants[index].id}.png`)
    await writeFile(path, png)
    interiorScreenshots.push({ slideIndex: index, variant: selectedVariants[index].id, path,
      sha256: createHash('sha256').update(png).digest('hex') })
  }
  report.interiorScreenshots = interiorScreenshots
  report.snapshots = snapshots
  report.rendered = rendered
  report.browserLogs = agent.browser.logs(sessionId)
  const visibleText = (phase: string) => (snapshots[phase] as { text: string }).text
  assert.notEqual(visibleText('content'), visibleText('cover'), 'ArrowRight did not change visible slide content')
  assert.notEqual(visibleText('closing'), visibleText('content'), 'End did not reach different closing content')
  assert.equal(visibleText('home'), visibleText('cover'), 'Home did not restore the original cover')
  assert.equal(sourceVerification.fidelity, 'pass', 'Composed original source failed verification')
  assert.equal(report.canonicalAdmissionGap, null)
  for (const [phase, verification] of Object.entries(rendered)) {
    assert.equal((verification as { fidelity?: string }).fidelity, 'pass', `${phase} runtime render mismatch`)
  }
  assert.equal(modelCalls, 0)
  report.passed = true
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  report.modelCalls = modelCalls
  report.elapsedSeconds = (Date.now() - startedAt) / 1000
  await writeFile(resolve(dataRoot, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ report: resolve(dataRoot, 'report.json'), passed: report.passed, error: String(report.error ?? '').slice(0, 1_500), elapsedSeconds: report.elapsedSeconds }))
  await agent.shutdown()
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
}
