import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { BrowserManager, type ReferenceRenderCaptureBundle } from './browser-manager.js'
import { revalidateActiveExactReferenceEvidence, visualWebArtifactCompletionGap, webResearchArtifactPresentVerificationGap } from './agent-service.js'
import {
  assertReferenceLanguageFontCoverage, createReferenceLanguageVariant, PINK_SCRIPT_DESIGN_URL,
  PINK_SCRIPT_SOURCE_SHA256, PINK_SCRIPT_SOURCE_URL, referenceLanguageCharacters,
} from './reference-language.js'
import {
  extractReferenceStyleSourceProfile, latestSuccessfulReferenceStyleContract,
  normalizeReferenceStyleContract, projectReferenceStyleToolResultForProvider,
} from './reference-style.js'
import { composeReferenceTemplate, referenceTemplateCatalog, referenceTemplateTextParents } from './reference-template.js'
import { isCompleteReferenceTextView, type ReferenceTextView } from './reference-text-edit.js'
import { SessionStore } from './session-store.js'
import { createResearchBrief } from './research-brief.js'
import { researchPageReadFromResult } from './research-evidence.js'
import { researchHtmlClaimGap } from './research-claim-integrity.js'
import type { ToolCallRecord } from '../shared/types.js'

// Exact public source snapshots. Their full SHA-256 identities are checked by
// the production adapter. Font transport below is deliberately synthetic;
// physical glyph loading remains a separate live component-canary assertion.
const source = readFileSync(new URL('./fixtures/pink-script-template.fixture.html', import.meta.url), 'utf8')
const design = readFileSync(new URL('./fixtures/pink-script-design.fixture.md', import.meta.url), 'utf8')
const args = {
  source_url: PINK_SCRIPT_SOURCE_URL, strictness: 'exact',
  colors: ['#060507', '#ED3D8C', '#F5EDF1'], fonts: ['DM Serif Display', 'Inter', 'JetBrains Mono'],
  layout: ['source slide layouts', 'fixed landscape stage'], components: ['runner', 'footer'],
  required_markers: ['deck-stage>section.slide', '.runner', '.footer', '.s-cover', '.s-toc', '.s-cta'],
  signature: 'Pink Script source typography', avoid: ['invented themes'], viewport: { width: 1920, height: 1080 },
}
const sourceBrowser = new BrowserManager()
const parents = referenceTemplateTextParents(source, PINK_SCRIPT_SOURCE_URL)
const catalog = referenceTemplateCatalog(source, PINK_SCRIPT_SOURCE_URL)
let bundle: ReferenceRenderCaptureBundle
const roots: string[] = []
const apps: Awaited<ReturnType<typeof createApp>>[] = []

beforeAll(async () => {
  // Actual Browser execution with network denied, not a fabricated family
  // array. No external fonts/native script are needed to observe these CSS
  // family declarations; the live canary additionally loads their bytes.
  bundle = await sourceBrowser.captureReferenceRenderBundle(source,
    extractReferenceStyleSourceProfile(source, normalizeReferenceStyleContract(args))!,
    PINK_SCRIPT_SOURCE_SHA256, args.viewport, { textParents: parents })
  expect(bundle.textFontFamilies).toHaveLength(parents.length)
}, 30_000)

afterAll(async () => { await sourceBrowser.closeEverything() })
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.agent.shutdown()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

function language() {
  return createReferenceLanguageVariant(source, PINK_SCRIPT_SOURCE_URL, design, parents, bundle.textFontFamilies!)
}

function slides(ids = ['v1', 'v2', 'v9'], mixed = false) {
  const policy = language()
  return ids.map((id) => {
    const variant = catalog.variants.find((item) => item.id === id)!
    return { variant: id, label: `Typography specimen ${id}`, texts: Object.fromEntries(variant.slots.map((slot) => {
      const role = policy.bindings.find((item) => item.variant === id && item.slot === slot.id)!.role
      return [slot.id, slot.allowEmpty || !/[a-z]/iu.test(slot.sample) ? slot.sample
        : mixed ? 'A 中文 42'
        : role === 'display' ? '中文' : role === 'body' ? '中文正文' : '中文标签']
    })) }
  })
}

async function fixture(request = 'Use only the supplied template and synthetic specimen text for a mechanical typography check.', compose = true, runtime = 'void 0;') {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-language-integration-'))
  roots.push(root)
  const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input))
    let content: string | Uint8Array
    let type: string
    if (url.href === PINK_SCRIPT_DESIGN_URL) { content = design; type = 'text/plain' }
    else if (url.href === new URL('deck-stage.js', PINK_SCRIPT_SOURCE_URL).href) { content = runtime; type = 'application/javascript' }
    else if (url.hostname === 'fonts.gstatic.com') { content = Buffer.from('wOF2integration-fixture'); type = 'font/woff2' }
    else if (url.hostname === 'fonts.googleapis.com') {
      const characters = url.searchParams.get('text')
      const range = characters ? [...characters].map((character) => `U+${character.codePointAt(0)!.toString(16)}`).join(',') : 'U+0000-00FF'
      const names = characters ? ['Noto Serif SC', 'Noto Sans SC'] : args.fonts
      content = names.map((family) => `@font-face{font-family:'${family}';font-style:normal;font-weight:${family === 'Noto Serif SC' ? '400 900' : '400'};src:url(https://fonts.gstatic.com/s/test/v1/fixture.woff2) format('woff2');unicode-range:${range};}`).join('\n')
      type = 'text/css'
    } else throw new Error(`Unexpected fixture request ${url.origin}`)
    const response = new Response(content as BodyInit, { headers: { 'content-type': type } })
    Object.defineProperty(response, 'url', { value: url.href })
    return response
  })
  const created = await createApp({ dataRoot: root, model: 'test-model', agent: {
    client: { stream: async () => { throw new Error('No model is permitted in this integration fixture') } },
    toolExecutorDependencies: { fetch: fetchMock as typeof fetch },
  } })
  apps.push(created)
  const capture = vi.spyOn(created.agent.browser, 'captureReferenceRenderBundle').mockResolvedValue(bundle)
  const session = await created.store.create()
  const id = session.summary.id
  await created.store.update(id, (state) => { state.messages = [{ role: 'user', content: request }] })
  let sequence = 0
  const append = async (call: ToolCallRecord, result: { content: string; isError: boolean }) => {
    await created.store.append(id, result.isError ? 'tool.failed' : 'tool.completed', { call, result: result.content, isError: result.isError })
    await created.store.update(id, (state) => { state.messages.push(
      { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
      { role: 'tool', tool_call_id: call.id, content: result.content, tool_result_status: result.isError ? 'failed' : 'succeeded' },
    ) })
  }
  await append({ id: 'source', name: 'fetch_page', arguments: { url: PINK_SCRIPT_SOURCE_URL, format: 'raw', chunkIndex: 0 } }, {
    content: JSON.stringify({ status: 'success', url: PINK_SCRIPT_SOURCE_URL, content: source, hasMore: false, chunkIndex: 0 }), isError: false,
  })
  const execute = async (name: string, arguments_: Record<string, unknown>) => {
    const call = { id: `language-${++sequence}`, name, arguments: arguments_ }
    const result = await created.agent['tools'].execute(call, { sessionId: id, turnId: 'language', stepId: call.id, callId: call.id, signal: new AbortController().signal })
    await append(call, result)
    return result
  }
  const record = await execute('record_reference_style', { ...args, language: 'zh-CN' })
  expect(record.isError, record.content).toBe(false)
  expect(capture.mock.calls[0][4]?.textParents).toEqual(parents)
  if (compose) {
    const composed = await execute('compose_reference_html', { path: 'sample.html', source_sha256: PINK_SCRIPT_SOURCE_SHA256, title: 'Typography specimen', slides: slides() })
    expect(composed.isError, composed.content).toBe(false)
  }
  const path = resolve(created.store.workspaceDir(id), 'sample.html')
  return { ...created, root, id, record, execute, append, fetchMock, path }
}

describe('documented language integration', () => {
  it.each(['quantity qualification', 'citation', 'source ledger'] as const)('resumes a real %s admission rejection through the appropriate low-cost repair lane', async (failure) => {
    const f = await fixture('Create one self-contained Chinese HTML report from the supplied synthetic specimen.', false)
    const url = 'https://reporting.example/quantity-fixture'
    const content = '合成测试报道：国产影片票房占比超七成。'
    const sourceUrls = failure === 'source ledger' ? [] : [url]
    const sourceRead = researchPageReadFromResult({ name: 'fetch_page', arguments: { url } }, { status: 'success', url, content })!
    if (sourceUrls.length) {
      await f.append({ id: 'fixture-report', name: 'fetch_page', arguments: { url } }, {
        content: JSON.stringify({ status: 'success', url, content }), isError: false,
      })
      await f.store.update(f.id, (state) => {
        state.activeTaskResearchEvidence = { schemaVersion: 1, sourceUrls, toolCallIds: ['fixture-report'], pageReads: [sourceRead] }
      })
    }
    const selected = slides(['v1', 'v3', 'v9'])
    Object.assign(selected[1].texts, { t8: '70', t9: '国产票房占比(约%)', t26: '' })
    if (failure === 'quantity qualification') Object.assign(selected[1], { links: { t24: url } })
    const composed = await f.execute('compose_reference_html', { path: 'sample.html', source_sha256: PINK_SCRIPT_SOURCE_SHA256,
      title: 'Synthetic quantity report', slides: selected })
    expect(composed.isError, composed.content).toBe(false)
    const before = await readFile(f.path, 'utf8')
    // Seed a recovered canonical identity for the actual composition bytes.
    // Standalone ToolExecutor omits the AgentService canonical_html overlay;
    // this fixture is not claiming a render pass or historical live delivery.
    await f.store.update(f.id, (state) => {
      const result = state.messages.at(-1)!
      expect(result.role).toBe('tool')
      result.content = JSON.stringify({ ...JSON.parse(String(result.content)), canonical_html: true })
    })
    const brief = createResearchBrief({ scope: 'Synthetic quantity fixture', limitations: ['Not real news.'], items: [{
      title: '合成报道', summary: content, date_note: 'Synthetic fixture only.',
      sources: [{ url, role: 'reporting', quality_note: 'Synthetic report.', excerpt: content }],
    }] }, [{ url, requestedUrl: url, title: 'Fixture', content, sha256: createHash('sha256').update(content).digest('hex') }])
    await f.store.update(f.id, (state) => {
      state.summary.status = 'failed'
      if (sourceUrls.length) state.activeTaskResearchEvidence = {
        schemaVersion: 1, sourceUrls, toolCallIds: ['fixture-report'], pageReads: [sourceRead], brief,
      }
    })
    const admissionOptions = { requiresResearch: true, requiresPageBody: true, researchBrief: brief,
      researchPageReads: sourceUrls.length ? [sourceRead] : [] }
    const gap = await webResearchArtifactPresentVerificationGap(f.store.workspaceDir(f.id),
      (await f.store.get(f.id)).messages, 'sample.html', sourceUrls, admissionOptions)
    expect(gap).toContain(failure === 'quantity qualification' ? 'quantity_qualification' : 'Research-source verification failed')
    await f.append({ id: 'rejected-present', name: 'present_file', arguments: { path: 'sample.html' } }, {
      content: JSON.stringify({ status: 'verification_required', not_executed: true, message: gap }), isError: true,
    })
    const surfaces: string[][] = []
    const prompts: string[] = []
    const reads: Record<string, unknown>[] = []
    const edits: Array<{ isError: boolean; content: string }> = []
    let currentView: ReferenceTextView | undefined
    const commit = vi.spyOn(f.store, 'commitWorkspaceWrite')
    const execute = f.agent['tools'].execute.bind(f.agent['tools'])
    vi.spyOn(f.agent['tools'], 'execute').mockImplementation(async (call, context) => {
      const result = await execute(call, context)
      if (call.name === 'read_file') {
        reads.push(call.arguments)
        const payload = JSON.parse(result.content)
        if (isCompleteReferenceTextView(payload)) currentView = payload
      }
      if (call.name === 'edit_file') edits.push(result)
      return result
    })
    vi.spyOn(f.agent['client'], 'stream').mockImplementation(async (options) => {
      surfaces.push((options.tools ?? []).map((tool) => tool.function.name))
      prompts.push(options.messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n'))
      if (failure !== 'quantity qualification' || surfaces.length > 2) throw new Error('fixture stop: no real provider or final delivery')
      const arguments_ = surfaces.length === 1 ? { path: 'sample.html', view: 'reference_text' } : {
        path: 'sample.html', reference_text: { hash: currentView!.hash, language_manifest_sha256: currentView!.language_manifest_sha256,
          edits: ['t8', 't9'].map((slot, index) => ({ slide_index: 2, slot,
            expected_text: currentView!.slots.find((entry) => entry.slide_index === 2 && entry.slot === slot)!.text,
            new_text: index === 0 ? '70+' : '国产票房占比(%)' })),
        },
      }
      return { content: '', reasoningContent: '', finishReason: 'tool_calls' as const,
        toolCalls: [{ id: `qualification-${surfaces.length}`, type: 'function' as const,
          function: { name: surfaces.length === 1 ? 'read_file' : 'edit_file', arguments: JSON.stringify(arguments_) } }],
        usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23, cachedPromptTokens: 0 }, modelCallCount: 1 }
    })
    await f.agent.resume(f.id)
    await vi.waitFor(() => { expect(f.agent.isRunning(f.id)).toBe(false) }, { timeout: 10_000, interval: 20 })
    const errors = (await f.store.events(f.id)).filter((event) => event.type === 'error').map((event) => event.data.message)
    if (failure === 'quantity qualification') {
      expect(surfaces.slice(0, 2), JSON.stringify(errors)).toEqual([['read_file'], ['edit_file', 'read_file']])
      expect(reads).toEqual([{ path: 'sample.html', view: 'reference_text' }])
      expect(edits.map((result) => result.isError), JSON.stringify(edits)).toEqual([false])
      expect(commit).toHaveBeenCalledTimes(1)
      expect(prompts[1]).toContain('one snapshot, one atomic commit')
      expect(prompts[1]).toContain('compare the main numeric value and its label together')
      expect(researchHtmlClaimGap(brief.items, before)).toContain('quantity_qualification')
      expect(await webResearchArtifactPresentVerificationGap(f.store.workspaceDir(f.id),
        (await f.store.get(f.id)).messages, 'sample.html', sourceUrls, admissionOptions)).toBeUndefined()
      const verified = await f.execute('verify_reference_style', { path: 'sample.html' })
      expect(verified.isError, verified.content).toBe(false)
      expect(JSON.parse(verified.content).fidelity).toBe('pass')
    } else {
      expect(surfaces[0], JSON.stringify(errors)).toEqual(failure === 'citation' ? ['read_file'] : ['fetch_page', 'web_search'])
      if (failure === 'citation') expect(prompts[0]).toContain('"offset":1,"limit":5000')
      expect(prompts[0]).not.toContain('"view":"reference_text"')
      expect(commit).not.toHaveBeenCalled()
      expect(await readFile(f.path, 'utf8')).toBe(before)
    }
    expect((await f.store.events(f.id)).some((event) => event.type === 'assistant.final')).toBe(false)
  })

  it('recovers a combined closing/citation rejection in the real main loop before creating the first file', async () => {
    // Synthetic source/transport only: this verifies feedback and durable-write
    // boundaries, not model reliability, rendered news quality or chat UI.
    const runtime = `document.addEventListener('DOMContentLoaded', () => {
      const slides = [...document.querySelectorAll('section.slide')]; let index = 0;
      const show = () => slides.forEach((slide, i) => { slide.style.display = i === index ? 'block' : 'none'; });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight') index = Math.min(index + 1, slides.length - 1);
        if (event.key === 'ArrowLeft') index = Math.max(index - 1, 0);
        if (event.key === 'Home') index = 0;
        if (event.key === 'End') index = slides.length - 1;
        show();
      }); show();
    });`
    const f = await fixture(`制作3页中文本周新闻 HTML Slides，只使用合成报道样本，风格严格参考：${PINK_SCRIPT_SOURCE_URL}`, false, runtime)
    const url = 'https://reporting.example/composition-fixture'
    const content = '这是一条仅用于组合恢复测试的合成报道。'
    const sha256 = createHash('sha256').update(content).digest('hex')
    const read = researchPageReadFromResult({ name: 'fetch_page', arguments: { url } }, { status: 'success', url, content })!
    const briefInput = { scope: 'Synthetic weekly-report fixture', limitations: ['Not actual news.'], items: [{
      title: '合成报道', summary: content, date_note: 'Fixture window only.',
      sources: [{ url, role: 'reporting', quality_note: 'Synthetic fixture source.', excerpt: content }],
    }] }
    const brief = createResearchBrief(briefInput, [{ url, requestedUrl: url, title: 'Synthetic fixture', content, sha256 }])
    await f.append({ id: 'fixture-news', name: 'fetch_page', arguments: { url } }, {
      content: JSON.stringify({ status: 'success', url, content }), isError: false,
    })
    await f.store.update(f.id, (state) => {
      state.summary.status = 'failed'
      state.activeTaskResearchEvidence = { schemaVersion: 1, sourceUrls: [url], toolCallIds: ['fixture-news'], pageReads: [read], brief }
    })
    const recorded = await f.execute('record_research_brief', briefInput)
    expect(recorded.isError, recorded.content).toBe(false)
    const corrected = slides()
    const citation = catalog.variants.find((variant) => variant.id === 'v2')!.slots.find((slot) => slot.linkable !== false && !slot.allowEmpty)!.id
    Object.assign(corrected[1], { links: { [citation]: url } })
    const surfaces: string[][] = []
    const results: Array<{ content: string; isError: boolean }> = []
    const write = vi.spyOn(f.store, 'commitWorkspaceWrite')
    const execute = f.agent['tools'].execute.bind(f.agent['tools'])
    vi.spyOn(f.agent['tools'], 'execute').mockImplementation(async (call, context) => {
      const result = await execute(call, context)
      if (call.name === 'compose_reference_html') results.push(result)
      return result
    })
    vi.spyOn(f.agent['client'], 'stream').mockImplementation(async (options) => {
      surfaces.push((options.tools ?? []).map((tool) => tool.function.name))
      if (surfaces.length > 2) throw new Error('fixture stop: independent source and Browser verification must still run')
      const visible = options.messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n')
      expect(visible.includes('last variant "v9"'), `closing ID absent from phase prompt; tools=${surfaces.at(-1)?.join(',')}`).toBe(true)
      if (surfaces.length === 2) {
        expect(visible).toContain('Missing item links: n1')
        expect(visible).toContain('no file was written')
        expect(write).not.toHaveBeenCalled()
        await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      return { content: '', reasoningContent: '', finishReason: 'tool_calls' as const,
        toolCalls: [{ id: `preflight-compose-${surfaces.length}`, type: 'function' as const, function: {
          name: 'compose_reference_html', arguments: JSON.stringify({ path: 'sample.html', source_sha256: PINK_SCRIPT_SOURCE_SHA256,
            title: '合成报道', slides: surfaces.length === 1 ? slides(['v1', 'v2', 'v2']) : corrected }),
        } }], usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23, cachedPromptTokens: 0 }, modelCallCount: 1 }
    })
    await f.agent.resume(f.id)
    await vi.waitFor(async () => { expect(f.agent.isRunning(f.id)).toBe(false) }, { timeout: 10_000, interval: 20 })
    const errors = (await f.store.events(f.id)).filter((event) => event.type === 'error').map((event) => event.data.message)
    expect(surfaces.slice(0, 3), JSON.stringify({ results, errors })).toEqual([['compose_reference_html'], ['compose_reference_html'], ['verify_reference_style']])
    expect(results.map((result) => result.isError), JSON.stringify(results)).toEqual([true, false])
    expect(write).toHaveBeenCalledTimes(1)
    expect(await readFile(f.path, 'utf8')).toContain(`href="${url}"`)
    const state = await f.store.get(f.id)
    expect(state.summary.status).toBe('failed')
    expect(state.activeTaskResearchEvidence!.brief!.sha256).toBe(brief.sha256)
    expect((await f.store.events(f.id)).some((event) => event.type === 'assistant.final')).toBe(false)
  })

  it.each(['stale hash', 'concurrent write', 'raw fallback', 'atomic batch'] as const)('routes source-bound collision repair through %s with correct tool and evidence boundaries', async (failure) => {
    // A runnable synthetic controller is required for the composition boundary;
    // Browser transport is controlled below, not evidence of real navigation.
    const runtime = `document.addEventListener('DOMContentLoaded', () => {
      const slides = [...document.querySelectorAll('section.slide')]; let index = 0;
      const show = () => slides.forEach((slide, i) => { slide.style.display = i === index ? 'block' : 'none'; });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight') index = Math.min(index + 1, slides.length - 1);
        if (event.key === 'ArrowLeft') index = Math.max(index - 1, 0);
        if (event.key === 'Home') index = 0;
        if (event.key === 'End') index = slides.length - 1;
        show();
      }); show();
    });` + (failure === 'raw fallback' ? `/*${'raw-pagination-fixture '.repeat(4_000)}*/` : '')
    const f = await fixture(`制作3页中文 HTML Slides，内容只使用合成字体样本，风格严格参考：${PINK_SCRIPT_SOURCE_URL}`, false, runtime)
    let before: Buffer | undefined
    let originalFontManifest: string | undefined
    await f.store.update(f.id, (state) => { state.summary.status = 'failed' })
    const canonicalUrl = `http://127.0.0.1:49123/workspace/${f.id}/preview/sample.html`
    const surfaces: string[][] = []
    const phasePrompts: string[] = []
    const rawPages: Array<{ arguments: Record<string, unknown>; result: Record<string, unknown> }> = []
    let currentView: ReferenceTextView | undefined
    const issue = (id: string, name: string, arguments_: Record<string, unknown>) => ({
      content: '', reasoningContent: '', finishReason: 'tool_calls' as const,
      toolCalls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(arguments_) } }],
      usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23, cachedPromptTokens: 0 }, modelCallCount: 1,
    })
    vi.spyOn(f.agent['client'], 'stream').mockImplementation(async (options) => {
      surfaces.push((options.tools ?? []).map((tool) => tool.function.name))
      phasePrompts.push(options.messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n'))
      if (failure === 'raw fallback' && surfaces.length >= 7) {
        if (rawPages.length && rawPages.at(-1)!.result.hasMore === false) throw new Error('fixture stop after complete raw pagination enables ordinary edit')
        return issue(`loop-raw-${surfaces.length}`, 'read_file', { path: 'sample.html' })
      }
      if (failure === 'atomic batch' && surfaces.length >= 9) throw new Error('fixture stop: new Browser evidence is still required')
      switch (surfaces.length) {
        case 1: return issue('loop-compose', 'compose_reference_html', { path: 'sample.html', source_sha256: PINK_SCRIPT_SOURCE_SHA256, title: 'Typography specimen', slides: slides() })
        case 2: return issue('loop-verify', 'verify_reference_style', { path: 'sample.html' })
        case 3: return issue('loop-preview', 'start_process', { command: 'npm run preview' })
        case 4: return issue('loop-open', 'browser', { action: 'open', path: 'sample.html', ...args.viewport })
        case 5: return issue('loop-collision', 'browser', { action: 'screenshot', screenshot_path: 'sample-reference-cover.png' })
        case 8: if (failure === 'atomic batch') return issue('loop-reverify', 'verify_reference_style', { path: 'sample.html' })
        // A failed single-slot edit reopens the current view; a successful
        // atomic batch goes directly to source verification above.
        // falls through
        case 6: return issue(`loop-read-${surfaces.length}`, 'read_file', { path: 'sample.html', view: 'reference_text' })
        case 7: case 9: {
          const slot = currentView!.slots.find((entry) => entry.role === 'body')!
          if (failure === 'atomic batch') {
            const numeric = currentView!.slots.find((entry) => /^\s*\d[\d./\s–-]*\s*$/u.test(entry.text))!
            expect(numeric).toBeDefined()
            return issue('loop-edit-7', 'edit_file', { path: 'sample.html', reference_text: {
              hash: currentView!.hash, language_manifest_sha256: currentView!.language_manifest_sha256,
              edits: [
                { slide_index: numeric.slide_index, slot: numeric.slot, expected_text: numeric.text, new_text: '18' },
                { slide_index: slot.slide_index, slot: slot.slot, expected_text: slot.text, new_text: '  窗口 09/02–09/08（Asia/Shanghai）。  ' },
              ],
            } })
          }
          return issue(`loop-edit-${surfaces.length}`, 'edit_file', { path: 'sample.html', reference_text: {
            hash: surfaces.length === 7 && failure === 'stale hash' ? 'A'.repeat(43) : currentView!.hash,
            language_manifest_sha256: currentView!.language_manifest_sha256,
            slide_index: slot.slide_index, slot: slot.slot, expected_text: slot.text,
          }, new_text: '  窗口 09/02–09/08（Asia/Shanghai）。  ' })
        }
        case 10: return issue('loop-reverify', 'verify_reference_style', { path: 'sample.html' })
        default: throw new Error('fixture stop: new Browser evidence is still required')
      }
    })
    const execute = f.agent['tools'].execute.bind(f.agent['tools'])
    const actualEdits: Array<{ isError: boolean; content: string }> = []
    vi.spyOn(f.agent['tools'], 'execute').mockImplementation(async (call, context) => {
      if (call.name === 'start_process') return { content: JSON.stringify({ status: 'running', process_id: 'fixture-preview' }), isError: false }
      if (call.name === 'browser') return { content: JSON.stringify(call.arguments.action === 'open'
        ? { url: canonicalUrl, text: '1 / 3', pageEpoch: 1 } : { status: 'success', path: 'sample-reference-cover.png' }), isError: false }
      if (call.id === 'loop-edit-7' && failure === 'concurrent write') {
        const commit = f.store.commitWorkspaceWrite.bind(f.store)
        vi.spyOn(f.store, 'commitWorkspaceWrite').mockImplementationOnce(async (id, options) => {
          await writeFile(f.path, Buffer.concat([before!, Buffer.from('\n<!-- concurrent author change -->')]))
          return commit(id, options)
        })
      }
      const result = await execute(call, context)
      if (call.id === 'loop-verify' && !result.isError) {
        before = await readFile(f.path)
        originalFontManifest = (await f.store.get(f.id)).activeReferenceStyleContract!.fontEvidence!.manifestSha256
      }
      if (call.name === 'read_file' && !result.isError) {
        const payload = JSON.parse(result.content)
        if (isCompleteReferenceTextView(payload)) currentView = payload
        if (call.arguments.view === undefined) rawPages.push({ arguments: call.arguments, result: payload })
      }
      if (call.name === 'edit_file') actualEdits.push(result)
      return result
    })
    // Only the render verdict/model transport are controlled. Text reads,
    // atomic edits, font rematerialization and source verification are real.
    vi.spyOn(f.agent.browser, 'verifyRenderedReferenceStyleAndScreenshot').mockResolvedValue({
      verification: { fidelity: 'mismatch', phase: 'cover', checked: 168, matched: 167, score: 99.4,
        violations: ['text collision between body and footer was absent from the source.'],
        url: canonicalUrl, viewport: args.viewport, pageEpoch: 1 },
      screenshot: Buffer.from('controlled collision screenshot, not UI verification'),
    })
    await f.agent.resume(f.id)
    await vi.waitFor(async () => {
      expect(f.agent.isRunning(f.id)).toBe(false)
      expect((await f.store.get(f.id)).summary.status).toBe('failed')
    }, { timeout: 10_000, interval: 20 })
    const loopMessages = (await f.store.get(f.id)).messages.filter((message) => message.role === 'tool' && message.tool_call_id?.startsWith('loop-'))
    const trace = loopMessages.map((message) => ({ id: message.tool_call_id, content: typeof message.content === 'string' ? message.content.slice(0, 200) : message.content }))
    if (failure === 'raw fallback') {
      expect(surfaces.slice(0, 7), JSON.stringify(trace)).toEqual([
        ['compose_reference_html'], ['verify_reference_style'], ['start_process'], ['browser'], ['browser'], ['read_file'], ['edit_file', 'read_file'],
      ])
      expect(rawPages.length).toBeGreaterThan(1)
      expect(surfaces.slice(7, -1)).toEqual(rawPages.slice(1).map(() => ['read_file']))
      expect(surfaces.at(-1)).toEqual(['edit_file'])
      expect(rawPages[0].arguments).toEqual({ path: 'sample.html', offset: 1, limit: 5_000 })
      for (let index = 1; index < rawPages.length; index += 1) {
        const previous = rawPages[index - 1].result
        expect(rawPages[index].arguments).toEqual(previous.nextContentOffset !== undefined
          ? { path: 'sample.html', offset: previous.offset, content_offset: previous.nextContentOffset, limit: 5_000 }
          : { path: 'sample.html', offset: previous.nextOffset, limit: 5_000 })
      }
      expect(rawPages.at(-1)!.result.hasMore).toBe(false)
      const rawMessages = loopMessages.filter((message) => message.tool_call_id?.startsWith('loop-raw-'))
      expect(rawMessages).toHaveLength(rawPages.length)
      for (const message of rawMessages) expect(message.content).not.toContain('Historical tool result compacted')
      expect(phasePrompts[6]).toContain('never shorten an unrelated marked slot')
      expect(actualEdits).toHaveLength(0)
      expect(before).toBeDefined()
      expect(await readFile(f.path)).toEqual(before)
      return
    }
    if (failure === 'atomic batch') {
      expect(surfaces, JSON.stringify(trace)).toEqual([
        ['compose_reference_html'], ['verify_reference_style'], ['start_process'], ['browser'], ['browser'], ['read_file'],
        ['edit_file', 'read_file'], ['verify_reference_style'], ['browser'],
      ])
      expect(actualEdits.map((result) => result.isError)).toEqual([false])
      expect(rawPages).toHaveLength(0)
      expect(await readFile(f.path)).not.toEqual(before)
      const view = JSON.parse((await f.execute('read_file', { path: 'sample.html', view: 'reference_text' })).content)
      expect(view.slots.some((slot: { text: string }) => slot.text === '18')).toBe(true)
      expect(view.slots.some((slot: { text: string }) => slot.text === '  窗口 09/02–09/08（Asia/Shanghai）。  ')).toBe(true)
      expect(phasePrompts[6]).toContain('one snapshot, one atomic commit')
      return
    }
    expect(surfaces, JSON.stringify(trace)).toEqual([
      ['compose_reference_html'], ['verify_reference_style'], ['start_process'], ['browser'], ['browser'], ['read_file'], ['edit_file', 'read_file'],
      ['read_file'], ['edit_file', 'read_file'], ['verify_reference_style'], ['browser'],
    ])
    for (const index of [5, 7]) {
      expect(phasePrompts[index]).toContain('current complete source-bound text view, not full HTML')
      expect(phasePrompts[index]).not.toContain('then continue the deterministic cursor until the terminal page')
    }
    for (const index of [6, 8]) {
      expect(phasePrompts[index]).toContain('Use edit_file.reference_text plus literal new_text')
      expect(phasePrompts[index]).not.toContain('using old_text/new_text for one location or edits for multiple')
    }
    expect(actualEdits.map((result) => result.isError)).toEqual([true, false])
    expect(actualEdits[0].content).toContain(failure === 'stale hash' ? 'current file hash' : 'File changed before edit')
    expect(before).toBeDefined()
    expect(await readFile(f.path)).not.toEqual(before)
    const state = await f.store.get(f.id)
    expect(originalFontManifest).toBeDefined()
    expect(state.activeReferenceStyleContract!.fontEvidence!.manifestSha256).not.toBe(originalFontManifest)
    expect(visualWebArtifactCompletionGap(state.messages, { referenceContract: state.activeReferenceStyleContract })?.missingPhases)
      .toContain('browser_open')
    const view = JSON.parse((await f.execute('read_file', { path: 'sample.html', view: 'reference_text' })).content)
    expect(view.slots.some((slot: { text: string }) => slot.text === '  窗口 09/02–09/08（Asia/Shanghai）。  ')).toBe(true)
  }, 15_000)

  it('reads compact current text and commits only one hash-bound CJK slot through real tool envelopes', async () => {
    const f = await fixture()
    const before = await readFile(f.path)
    const read = await f.execute('read_file', { path: 'sample.html', view: 'reference_text' })
    expect(read.isError, read.content).toBe(false)
    const view = JSON.parse(read.content)
    expect(isCompleteReferenceTextView(view)).toBe(true)
    expect(view.hash).toBe(createHash('sha256').update(before).digest('base64url'))
    expect(Buffer.byteLength(read.content)).toBeLessThan(before.length / 3)
    const slot = view.slots.find((slot: { slide_index: number; role: string }) => slot.slide_index === 3 && slot.role === 'body')
    expect(slot).toBeDefined()
    const reference_text = { hash: view.hash, language_manifest_sha256: view.language_manifest_sha256,
      slide_index: slot.slide_index, slot: slot.slot, expected_text: slot.text }
    const changed = await f.execute('edit_file', { path: 'sample.html', reference_text, new_text: '窗口 09/02–09/08（Asia/Shanghai）。' })
    expect(changed.isError, changed.content).toBe(false)
    const after = await readFile(f.path)
    expect(after.equals(before)).toBe(false)
    expect(JSON.parse(changed.content).hash).toBe(createHash('sha256').update(after).digest('base64url'))
    const refreshed = JSON.parse((await f.execute('read_file', { path: 'sample.html', view: 'reference_text' })).content)
    expect(refreshed.slots.filter((entry: { text: string }, index: number) => entry.text !== view.slots[index].text))
      .toEqual([{ ...slot, text: '窗口 09/02–09/08（Asia/Shanghai）。' }])
    const stale = await f.execute('edit_file', { path: 'sample.html', reference_text, new_text: '旧哈希不得覆盖新文案。' })
    expect(stale.isError).toBe(true)
    expect(stale.content).toContain('current file hash')
    expect(await readFile(f.path)).toEqual(after)
    const verified = await f.execute('verify_reference_style', { path: 'sample.html' })
    expect(verified.isError, verified.content).toBe(false)
    expect(JSON.parse(verified.content).fidelity).toBe('pass')
  })

  it('commits a numeric and mixed-script text batch once, with zero writes for any invalid or stale member', async () => {
    const f = await fixture()
    const before = await readFile(f.path)
    const view = JSON.parse((await f.execute('read_file', { path: 'sample.html', view: 'reference_text' })).content)
    const numeric = view.slots.find((slot: { text: string }) => /^\s*\d[\d./\s–-]*\s*$/u.test(slot.text))
    const body = view.slots.find((slot: { role: string }) => slot.role === 'body')
    expect(numeric).toBeDefined()
    expect(body).toBeDefined()
    const entry = (slot: { slide_index: number; slot: string; text: string }, new_text: string) => ({
      slide_index: slot.slide_index, slot: slot.slot, expected_text: slot.text, new_text,
    })
    const reference_text = { hash: view.hash, language_manifest_sha256: view.language_manifest_sha256,
      edits: [entry(numeric, '18'), entry(body, '合成样本124.98(约)，不是经验证的新闻。')] }
    const commit = vi.spyOn(f.store, 'commitWorkspaceWrite')
    for (const patch of [
      { ...reference_text, edits: [reference_text.edits[0], { ...reference_text.edits[1], expected_text: 'stale' }] },
      { ...reference_text, edits: [reference_text.edits[0], reference_text.edits[0]] },
      { ...reference_text, hash: 'A'.repeat(43) },
    ]) {
      const rejected = await f.execute('edit_file', { path: 'sample.html', reference_text: patch })
      expect(rejected.isError, rejected.content).toBe(true)
      expect(await readFile(f.path)).toEqual(before)
      expect(commit).not.toHaveBeenCalled()
    }
    const edited = await f.execute('edit_file', { path: 'sample.html', reference_text })
    expect(edited.isError, edited.content).toBe(false)
    expect(commit).toHaveBeenCalledOnce()
    const after = JSON.parse((await f.execute('read_file', { path: 'sample.html', view: 'reference_text' })).content)
    expect(after.slots).toEqual(view.slots.map((slot: { slide_index: number; slot: string; text: string }) => ({ ...slot,
      text: reference_text.edits.find((edit) => edit.slide_index === slot.slide_index && edit.slot === slot.slot)?.new_text ?? slot.text,
    })))
    const verified = await f.execute('verify_reference_style', { path: 'sample.html' })
    expect(verified.isError, verified.content).toBe(false)
    expect(JSON.parse(verified.content).fidelity).toBe('pass')
  })

  it('does not overwrite a file changed between the text snapshot and the atomic commit', async () => {
    const f = await fixture()
    const before = await readFile(f.path)
    const view = JSON.parse((await f.execute('read_file', { path: 'sample.html', view: 'reference_text' })).content)
    const slot = view.slots[0]
    const concurrent = Buffer.concat([before, Buffer.from('\n<!-- concurrent author change -->')])
    const commit = f.store.commitWorkspaceWrite.bind(f.store)
    vi.spyOn(f.store, 'commitWorkspaceWrite').mockImplementationOnce(async (id, options) => {
      expect(options.expectedBefore).toEqual(before)
      await writeFile(f.path, concurrent)
      return commit(id, options)
    })
    const result = await f.execute('edit_file', { path: 'sample.html', reference_text: {
      hash: view.hash, language_manifest_sha256: view.language_manifest_sha256,
      slide_index: slot.slide_index, slot: slot.slot, expected_text: slot.text,
    }, new_text: '不能覆盖并发修改' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('File changed before edit')
    expect(await readFile(f.path)).toEqual(concurrent)
  })

  it('rejects mixed edit schemas, invalid bytes and unsupported markup without deleting or rewriting the file', async () => {
    const f = await fixture()
    const before = await readFile(f.path)
    const view = JSON.parse((await f.execute('read_file', { path: 'sample.html', view: 'reference_text' })).content)
    const slot = view.slots[0]
    const reference_text = { hash: view.hash, language_manifest_sha256: view.language_manifest_sha256,
      slide_index: slot.slide_index, slot: slot.slot, expected_text: slot.text }
    const mixed = await f.execute('edit_file', { path: 'sample.html', reference_text, old_text: slot.text, new_text: '文案' })
    expect(mixed.isError).toBe(true)
    expect(mixed.content).toContain('cannot be combined')
    const misspelled = await f.execute('edit_file', { path: 'sample.html', reference_text: { ...reference_text, file_hash: view.hash, hash: undefined }, new_text: '文案' })
    expect(misspelled.isError).toBe(true)
    expect(misspelled.content).toContain('file_hash: additional property')
    const paginated = await f.execute('read_file', { path: 'sample.html', view: 'reference_text', offset: 1 })
    expect(paginated.isError).toBe(true)
    expect(paginated.content).toContain('cannot be combined')
    expect(await readFile(f.path)).toEqual(before)
    const invalid = Buffer.concat([before.subarray(0, 5), Buffer.from([0xc0]), before.subarray(5)])
    await writeFile(f.path, invalid)
    const decoded = await f.execute('read_file', { path: 'sample.html', view: 'reference_text' })
    expect(decoded.isError).toBe(true)
    expect(await readFile(f.path)).toEqual(invalid)
  })

  it('persists source-authorized roles and rematerializes only when final characters change', async () => {
    const f = await fixture()
    const original = (await f.store.get(f.id)).activeReferenceStyleContract!
    expect(original.languageVariant).toEqual(language())
    const projected = JSON.parse(projectReferenceStyleToolResultForProvider(f.record.content))
    expect(projected.language_variant_attestation.manifest_sha256).toBe(language().manifestSha256)
    expect(projected.language_variant).toBeUndefined()
    const verify = async () => {
      const result = await f.execute('verify_reference_style', { path: 'sample.html' })
      expect(result.isError, result.content).toBe(false)
      expect(JSON.parse(result.content)).toMatchObject({ fidelity: 'pass' })
      return (await f.store.get(f.id)).activeReferenceStyleContract!
    }
    const first = await verify()
    expect(first.fontEvidence?.manifestSha256).not.toBe(original.fontEvidence?.manifestSha256)
    const requestCount = f.fetchMock.mock.calls.length
    expect((await verify()).fontEvidence).toEqual(first.fontEvidence)
    expect(f.fetchMock).toHaveBeenCalledTimes(requestCount)
    const html = await readFile(f.path, 'utf8')
    const edited = html.replace('>中文</span>', '>中文娱</span>')
    expect(edited).not.toBe(html)
    await writeFile(f.path, edited)
    const second = await verify()
    expect(second.fontEvidence?.manifestSha256).not.toBe(first.fontEvidence?.manifestSha256)
    const fonts = await f.store.resolveReferenceFontEvidence(f.id, second.fontEvidence!)
    expect(() => assertReferenceLanguageFontCoverage(fonts.fontCss, referenceLanguageCharacters(edited))).not.toThrow()
    const reopened = new SessionStore(f.root, 'test-model')
    const restored = await reopened.get(f.id)
    expect(restored.activeReferenceStyleContract).toEqual(second)
    expect(latestSuccessfulReferenceStyleContract(restored.messages)?.languageVariant).toEqual(language())
    expect((await revalidateActiveExactReferenceEvidence(reopened, f.id)).referenceStyleEvidenceInvalidation).toBeUndefined()
  }, 30_000)

  it('returns a repairable source mismatch for altered runs, and blocks unverified preview/download', async () => {
    const f = await fixture()
    await f.store.update(f.id, (state) => { state.website.entryPath = 'sample.html' })
    const server = createServer(f.app)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture address')
    const base = `http://127.0.0.1:${address.port}`
    const urls = [`${base}/workspace/${f.id}/preview/sample.html`, `${base}/api/sessions/${f.id}/download?path=sample.html`]
    try {
      for (const url of urls) expect((await fetch(url)).ok).toBe(false)
      const verified = await f.execute('verify_reference_style', { path: 'sample.html' })
      expect(JSON.parse(verified.content)).toMatchObject({ fidelity: 'pass' })
      for (const url of urls) {
        const response = await fetch(url)
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('data-anera-reference-fonts')
      }
      const original = await readFile(f.path, 'utf8')
      await writeFile(f.path, original.replace('font-weight:900', 'font-weight:400'))
      const requests = f.fetchMock.mock.calls.length
      const mismatch = await f.execute('verify_reference_style', { path: 'sample.html' })
      expect(mismatch.isError).toBe(false)
      expect(JSON.parse(mismatch.content)).toMatchObject({ fidelity: 'mismatch', violations: { source: [expect.stringContaining('exact typography')] } })
      expect(f.fetchMock).toHaveBeenCalledTimes(requests)
      for (const url of urls) expect((await fetch(url)).ok).toBe(false)
      await writeFile(f.path, original.replace('>中文</span>', '>中文新</span>'))
      for (const url of urls) expect((await fetch(url)).ok).toBe(false)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }, 30_000)

  it('does not publish new font evidence when a changed character subset cannot be downloaded', async () => {
    const f = await fixture()
    const first = await f.execute('verify_reference_style', { path: 'sample.html' })
    expect(JSON.parse(first.content)).toMatchObject({ fidelity: 'pass' })
    const before = await f.store.get(f.id)
    const html = await readFile(f.path, 'utf8')
    await writeFile(f.path, html.replace('>中文</span>', '>中文娱</span>'))
    f.fetchMock.mockImplementation(async () => new Response('offline fixture', { status: 503 }))
    const result = await f.execute('verify_reference_style', { path: 'sample.html' })
    expect(result.isError).toBe(true)
    const after = await f.store.get(f.id)
    expect(after.activeReferenceStyleContract).toEqual(before.activeReferenceStyleContract)
    expect(after.activeReferenceStyleEvidenceGeneration).toBe(before.activeReferenceStyleEvidenceGeneration)
  }, 30_000)

  it('executes computed CJK checks and rejects important overrides on otherwise valid marked text', async () => {
    const policy = language()
    const compiled = composeReferenceTemplate({ source, sourceUrl: PINK_SCRIPT_SOURCE_URL, sourceSha256: PINK_SCRIPT_SOURCE_SHA256, title: 'Typography specimen',
      dependencies: catalog.dependencies.map((url) => ({ url, content: 'void 0;', bytes: 7, sha256: createHash('sha256').update('void 0;').digest('hex') })),
      slides: slides(), allowedSourceUrls: [], languageVariant: policy })
    const activeCover = (html: string) => html.replace('</head>', '<style>section.slide:not(:first-child){display:none}section.slide:first-child{display:block;position:absolute;inset:0}</style></head>')
    const manager = new BrowserManager()
    try {
      for (const [role, override] of [['display', ''], ['display', 'font-weight:400!important'], ['display', 'font-family:Arial!important'], ['display', 'letter-spacing:5px!important'], ['display', 'transform:translateX(50px)!important'], ['display', 'visibility:hidden!important'], ['label', 'line-height:4!important']]) {
        const html = activeCover(compiled.html.replace('</head>', `<style>[data-anera-cjk="${role}"]{${override}}</style></head>`))
        await manager.open('language-css', `data:text/html,${encodeURIComponent(html)}`)
        await manager.setViewport('language-css', args.viewport.width, args.viewport.height)
        const result = await manager.verifyRenderedReferenceStyle('language-css', bundle.profile, 'cover', undefined, { languageVariant: policy })
        if (override) expect(result.violations.join('\n')).toMatch(/render CJK/)
        else expect(result.violations.filter((violation) => violation.includes('CJK'))).toEqual([])
        if (override === 'visibility:hidden!important') {
          expect(result.violations.join('\n')).toMatch(/render CJK run v1\.t\d+ is hidden/)
        }
      }
    } finally { await manager.closeEverything() }
  }, 30_000)

  it('renders cleared source ordinal and magnitude affixes without changing source geometry or hiding ordinary copy', async () => {
    const policy = language()
    const selected = ['v1', 'v3', 'v9'].map((id) => {
      const variant = catalog.variants.find((item) => item.id === id)!
      return { variant: id, label: 'Affix rendering specimen', texts: Object.fromEntries(variant.slots.map((slot) => [slot.id, slot.sample])) }
    })
    selected[0].texts.t11 = '影视 · 文娱'
    selected[0].texts.t12 = ''
    selected[1].texts.t14 = '12'
    selected[1].texts.t15 = ''
    const compiled = composeReferenceTemplate({ source, sourceUrl: PINK_SCRIPT_SOURCE_URL, sourceSha256: PINK_SCRIPT_SOURCE_SHA256,
      title: 'Affix rendering specimen', slides: selected, allowedSourceUrls: [], languageVariant: policy,
      dependencies: catalog.dependencies.map((url) => ({ url, content: 'void 0;', bytes: 7, sha256: createHash('sha256').update('void 0;').digest('hex') })),
    })
    const manager = new BrowserManager()
    try {
      for (const [index, phase] of [[1, 'cover'], [2, 'content']] as const) {
        // The no-op runtime fixture must explicitly identify the active slide,
        // as the real controller does. CSS visibility alone is not its state.
        const active = compiled.html.replace(`class="slide ${index === 1 ? 's-cover' : 's-stats'}"`,
          `class="slide ${index === 1 ? 's-cover' : 's-stats'} active"`)
        expect(active).not.toBe(compiled.html)
        const html = active.replace('</head>', `<style>section.slide:not(:nth-child(${index})){display:none!important}section.slide:nth-child(${index}){display:block;position:absolute;inset:0}</style></head>`)
        await manager.open('language-affix', `data:text/html,${encodeURIComponent(html)}`)
        await manager.setViewport('language-affix', args.viewport.width, args.viewport.height)
        const result = await manager.verifyRenderedReferenceStyle('language-affix', bundle.profile, phase, undefined, { languageVariant: policy })
        expect(result.violations, phase).toEqual([])
        expect(result.fidelity).toBe('pass')
      }
    } finally { await manager.closeEverything() }
  }, 30_000)

  it('identifies offstage source slots when long Chinese copy overflows an intact contents layout', async () => {
    const policy = language()
    const selected = slides()
    const body = policy.bindings.find((binding) => binding.variant === 'v2' && binding.role === 'body')!
    expect(body).toBeDefined()
    selected[1].texts[body.slot] = '过长的目录正文'.repeat(180)
    const compiled = composeReferenceTemplate({ source, sourceUrl: PINK_SCRIPT_SOURCE_URL, sourceSha256: PINK_SCRIPT_SOURCE_SHA256,
      title: 'Overflow specimen', slides: selected, allowedSourceUrls: [], languageVariant: policy,
      dependencies: catalog.dependencies.map((url) => ({ url, content: 'void 0;', bytes: 7, sha256: createHash('sha256').update('void 0;').digest('hex') })),
    })
    // All five original rows are still in the DOM. Only their visibility is
    // lost; a repair must not infer that composition deleted source rows.
    const nodes: DefaultTreeAdapterMap['node'][] = [parse(compiled.html)]
    let rows = 0
    while (nodes.length) {
      const node = nodes.pop()!
      if ('attrs' in node && node.attrs.some((attribute) => attribute.name === 'class'
        && attribute.value.split(/\s+/u).includes('row'))) rows += 1
      if ('childNodes' in node) nodes.push(...node.childNodes)
    }
    expect(rows).toBe(5)
    const html = compiled.html.replace('</head>', '<style>section.slide:not(:nth-child(2)){display:none!important}section.slide:nth-child(2){display:block;position:absolute;inset:0}</style></head>')
    const manager = new BrowserManager()
    try {
      await manager.open('language-overflow', `data:text/html,${encodeURIComponent(html)}`)
      await manager.setViewport('language-overflow', args.viewport.width, args.viewport.height)
      const result = await manager.verifyRenderedReferenceStyle('language-overflow', bundle.profile, 'content', undefined, { languageVariant: policy })
      expect(result.fidelity).toBe('mismatch')
      expect(result.violations.join('\n')).toMatch(/\.s-toc \.row count expected 5.*visible in-viewport matches/)
      expect(result.violations.join('\n')).toMatch(/render CJK text group v2\.t\d+ is hidden/)
    } finally { await manager.closeEverything() }
  }, 30_000)

  it('keeps mixed-script text grouped in every source interior formatting context', async () => {
    const policy = language()
    const manager = new BrowserManager()
    const startedAt = performance.now()
    const timing = (variant: string, stage: string) => {
      if (process.env.ANERA_TEST_RENDER_TIMING === '1') {
        console.info(JSON.stringify({ probe: 'mixed-script-render', variant, stage, elapsedMs: Math.round(performance.now() - startedAt) }))
      }
    }
    try {
      for (const variant of catalog.variants.slice(1, -1)) {
        timing(variant.id, 'start')
        const compiled = composeReferenceTemplate({ source, sourceUrl: PINK_SCRIPT_SOURCE_URL, sourceSha256: PINK_SCRIPT_SOURCE_SHA256,
          title: 'Mixed-script specimen', slides: slides(['v1', variant.id, 'v9'], true), allowedSourceUrls: [], languageVariant: policy,
          dependencies: catalog.dependencies.map((url) => ({ url, content: 'void 0;', bytes: 7, sha256: createHash('sha256').update('void 0;').digest('hex') })),
        })
        const html = compiled.html.replace('</head>', '<style>section.slide:not(:nth-child(2)){display:none!important}section.slide:nth-child(2){display:block;position:absolute;inset:0}</style></head>')
        timing(variant.id, 'composed')
        await manager.open('language-interior', `data:text/html,${encodeURIComponent(html)}`)
        timing(variant.id, 'opened')
        await manager.setViewport('language-interior', args.viewport.width, args.viewport.height)
        timing(variant.id, 'viewport')
        const result = await manager.verifyRenderedReferenceStyle('language-interior', bundle.profile, 'content', undefined, { languageVariant: policy })
        timing(variant.id, 'verified')
        expect(result.violations.filter((violation) => violation.includes('CJK')), variant.id).toEqual([])
      }
    } finally { await manager.closeEverything() }
  }, 60_000)
})
