import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from './session-store.js'
import { ToolExecutor } from './tools.js'
import { ProcessManager } from './process-manager.js'
import { BrowserManager } from './browser-manager.js'
import { researchPageReadFromResult } from './research-evidence.js'
import { createResearchBrief, parseResearchBriefMembershipMessage } from './research-brief.js'
import { compactHistoricalToolPayloads, convergedAgentToolModelOutput, recoverActiveVisualArtifact, visualWebArtifactRequiredToolNames, visualWebArtifactPhaseInstruction, visualWorkflowCompactionAnchors } from './agent-service.js'
import type { ModelMessage, SessionEvent } from '../shared/types.js'
import { composeReferenceTemplate, materializeReferenceTemplateDependencies, referenceTemplateCatalog } from './reference-template.js'
import { sourceUrl, newsUrl, css, source, script, dependency, catalog, slides, input } from './test-support/reference-template-fixtures.js'

describe('source-bound reference template composition', () => {
  it('executes raw-boundary script bytes under the App script CSP without permitting data scripts', async () => {
    const runtimeSource = source.replace('.slide{background:', '.slide{display:none;background:')
    const runtimeScript = `const boundary="</script>";let i=0;const slides=[...document.querySelectorAll('.slide')];const show=()=>slides.forEach((s,n)=>s.style.display=n===i?'block':'none');show();document.addEventListener('keydown',e=>{if(e.key==='ArrowRight')i=Math.min(i+1,slides.length-1);if(e.key==='End')i=slides.length-1;if(e.key==='Home')i=0;show()});`
    const runtimeDependency = { ...dependency, content: runtimeScript, bytes: Buffer.byteLength(runtimeScript), sha256: createHash('sha256').update(runtimeScript).digest('hex') }
    const result = composeReferenceTemplate({ ...input(), source: runtimeSource,
      sourceSha256: referenceTemplateCatalog(runtimeSource, sourceUrl).sourceSha256, dependencies: [runtimeDependency] })
    const html = result.html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'">`)
    const browser = new BrowserManager()
    try {
      const cover = await browser.open('composition-blob-csp', `data:text/html,${encodeURIComponent(html)}`)
      expect(cover.text).toContain('本周娱乐')
      expect(cover.text).not.toContain('这是来源明确')
      const content = await browser.press('composition-blob-csp', 'ArrowRight')
      expect(content.text).toContain('这是来源明确')
      expect(content.text).not.toContain('本周娱乐')
      const closing = await browser.press('composition-blob-csp', 'End')
      expect(closing.text).toContain('查阅原文')
      expect((await browser.press('composition-blob-csp', 'Home')).text).toBe(cover.text)
      expect(browser.logs('composition-blob-csp').filter((log) => /violates.*script-src/iu.test(log.text))).toEqual([])
    } finally {
      await browser.closeEverything()
    }
  }, 15_000)

  it('executes composition from journal-backed source bytes after context loss, without overwriting an existing file', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-reference-composition-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn(async () => new Response(script))
    const browser = new BrowserManager()
    const processes = new ProcessManager(() => {}, 10_000)
    const tools = new ToolExecutor(store, processes, browser, { inspect: vi.fn() }, async () => false, { fetch: fetchMock as typeof fetch })
    const context = { sessionId: session.summary.id, turnId: 'turn_compose', stepId: 'step_compose', signal: new AbortController().signal }
    try {
      const capturedScripts = await materializeReferenceTemplateDependencies(catalog, sourceUrl, context.signal, fetchMock as typeof fetch)
      const runtimeEvidence = await store.commitReferenceRuntimeEvidence(session.summary.id, catalog.sourceSha256, sourceUrl, capturedScripts)
      const reference = {
        contract: { sourceUrl, strictness: 'exact' as const, colors: ['#120a10', '#ed3d8c'], fonts: ['serif'],
          layout: ['full viewport', 'three layouts'], components: ['slide', 'headline'], requiredMarkers: ['.slide', '.display'],
          signature: 'Pink serif', avoid: ['invented colors'], viewport: { width: 1000, height: 600 } },
        provenance: { resolvedUrl: sourceUrl, evidenceSha256: catalog.sourceSha256, evidenceBytes: Buffer.byteLength(source) },
        templateCatalog: catalog,
        runtimeEvidence,
      }
      await store.append(session.summary.id, 'turn.started', { content: `研究新闻，制作 HTML Slides，风格严格参考 ${sourceUrl}` }, { turnId: context.turnId })
      await store.append(session.summary.id, 'tool.completed', {
        call: { id: 'source-fetch', name: 'fetch_page', arguments: { url: sourceUrl, format: 'raw' } },
        result: JSON.stringify({ status: 'success', url: sourceUrl, content: source, hasMore: false, chunkIndex: 0, totalChunks: 1 }),
      }, { turnId: context.turnId, callId: 'source-fetch' })
      await store.update(session.summary.id, (state) => {
        state.messages = [{ role: 'assistant', content: 'Raw source was compacted.' }]
        state.activeReferenceStyleContract = reference
        state.activeTaskResearchEvidence = { schemaVersion: 1, sourceUrls: [newsUrl], toolCallIds: ['news-read'], pageReads: [
          researchPageReadFromResult({ name: 'fetch_page', arguments: { url: newsUrl } }, { status: 'success', url: newsUrl, content: 'Actual news article.' })!,
        ], brief: createResearchBrief({ scope: 'Fixture news', limitations: [], items: [{ title: 'News', summary: 'Actual news article.',
          date_note: 'Fixture reporting window', sources: [{ url: newsUrl, role: 'reporting', quality_note: 'Fixture article', excerpt: 'Actual news article.' }] }] },
        [{ url: newsUrl, requestedUrl: newsUrl, title: 'News', content: 'Actual news article.', sha256: createHash('sha256').update('Actual news article.').digest('hex') }]) }
      })
      const gap = { missingPhases: ['html_artifact' as const], referenceContract: reference }
      expect([...visualWebArtifactRequiredToolNames(gap)!]).toEqual(['compose_reference_html'])
      expect(visualWebArtifactPhaseInstruction(gap)).toContain('Fill every text slot')
      const call = { id: 'compose', name: 'compose_reference_html', arguments: { path: 'news.html', source_sha256: catalog.sourceSha256, title: '新闻周报', slides } }
      const write = vi.spyOn(store, 'commitWorkspaceWrite')
      const noClosingOrLinks = await tools.execute({ ...call, id: 'missing-closing-and-links', arguments: { ...call.arguments,
        slides: [slides[0], slides[1], slides[1]].map((slide) => ({ ...slide, links: {} })) } }, context)
      expect(noClosingOrLinks.isError).toBe(true)
      const completeGap = JSON.parse(noClosingOrLinks.content).message
      expect(completeGap).toContain('Missing item links: n1')
      expect(completeGap).toContain('last variant "v3"')
      expect(completeGap).toContain('NOT binding keys')
      expect(completeGap).toContain('no file was written')
      expect(write).not.toHaveBeenCalled()
      await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'news.html'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(visualWebArtifactPhaseInstruction(gap)).toContain('first variant "v1"')
      expect(visualWebArtifactPhaseInstruction(gap)).toContain('last variant "v3"')
      const missingLinks = await tools.execute({ ...call, id: 'missing-links', arguments: { ...call.arguments,
        slides: slides.map((slide) => ({ ...slide, links: {} })) } }, context)
      expect(missingLinks.isError).toBe(true)
      expect(missingLinks.content).toContain('Missing item links: n1')
      expect(missingLinks.content).toContain('NOT binding keys')
      expect(JSON.parse(missingLinks.content).message).toContain(`slides[0].links = {"t1":"${newsUrl}"}`)
      const inventedCitationSlot = await tools.execute({ ...call, id: 'invented-citation-slot', arguments: { ...call.arguments,
        slides: [slides[0], { ...slides[1], links: { n1: newsUrl } }, { ...slides[1], links: {} }] } }, context)
      expect(inventedCitationSlot.isError).toBe(true)
      expect(inventedCitationSlot.content).toContain('unknown=n1')
      expect(inventedCitationSlot.content).toContain('Missing item links: n1')
      expect(write).not.toHaveBeenCalled()
      await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'news.html'))).rejects.toMatchObject({ code: 'ENOENT' })
      const unreviewedUrl = 'https://news.example/unreviewed-story'
      await store.update(session.summary.id, (state) => {
        state.activeTaskResearchEvidence!.pageReads!.push(researchPageReadFromResult(
          { name: 'fetch_page', arguments: { url: unreviewedUrl } },
          { status: 'success', url: unreviewedUrl, content: 'A second retrieved story, not part of the accepted brief.' },
        )!)
      })
      const unreviewed = await tools.execute({ ...call, id: 'unreviewed-story', arguments: { ...call.arguments,
        slides: slides.map((slide, index) => index === 1 ? { ...slide, links: { ...slide.links, t1: unreviewedUrl } } : slide) } }, context)
      expect(unreviewed.isError).toBe(true)
      expect(unreviewed.content).toContain('Research-brief membership review required:')
      expect(unreviewed.content).toContain(unreviewedUrl)
      const unreviewedAndClosing = await tools.execute({ ...call, id: 'unreviewed-and-closing', arguments: { ...call.arguments,
        slides: [slides[0], { ...slides[1], links: { t1: unreviewedUrl, t2: newsUrl } }, slides[1]] } }, context)
      const membershipMessage = JSON.parse(unreviewedAndClosing.content).message
      expect(unreviewedAndClosing.isError).toBe(true)
      expect(membershipMessage).toContain('last variant "v3"')
      expect(parseResearchBriefMembershipMessage(membershipMessage)).toEqual({
        briefSha256: (await store.get(session.summary.id)).activeTaskResearchEvidence!.brief!.sha256, urls: [unreviewedUrl],
      })
      expect(write).not.toHaveBeenCalled()
      await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'news.html'))).rejects.toMatchObject({ code: 'ENOENT' })
      await store.update(session.summary.id, (state) => {
        state.activeTaskResearchEvidence!.pageReads!.push(researchPageReadFromResult(
          { name: 'fetch_page', arguments: { url: sourceUrl, format: 'raw' } },
          { status: 'success', url: sourceUrl, content: source },
        )!)
      })
      const referenceCredit = await tools.execute({ ...call, id: 'source-credit', arguments: { ...call.arguments,
        path: 'with-reference-credit.html', slides: slides.map((slide, index) => index === 0
          ? { ...slide, links: { t1: sourceUrl } } : slide) } }, context)
      expect(referenceCredit.isError, referenceCredit.content).toBe(false)
      const result = await tools.execute(call, context)
      expect(result.isError, result.content).toBe(false)
      const actual = await readFile(resolve(store.workspaceDir(session.summary.id), 'news.html'), 'utf8')
      expect(actual).toContain(`<style>${css}</style>`)
      expect(actual).toContain('本周娱乐')
      expect(fetchMock).toHaveBeenCalledOnce()
      const projected = convergedAgentToolModelOutput(call, result, { canonicalHtml: true })
      expect(JSON.parse(projected).template_dependencies[0].sha256).toBe(dependency.sha256)
      const events: SessionEvent[] = [{ id: 'terminal', seq: 1, sessionId: session.summary.id, at: new Date().toISOString(), type: 'tool.completed', data: { call, result: projected } }]
      expect(recoverActiveVisualArtifact(events)?.path).toBe('news.html')
      const history: ModelMessage[] = [
        { role: 'user', content: '制作 HTML Slides。' },
        { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
        { role: 'tool', tool_call_id: call.id, content: projected, tool_result_status: 'succeeded' },
      ]
      expect(visualWorkflowCompactionAnchors(history, 'news.html').has(history[2])).toBe(true)
      const longHistory = structuredClone(history)
      longHistory[1].reasoning_content = 'Retain paired provider reasoning exactly.'
      longHistory[1].tool_calls![0].function.arguments = JSON.stringify({ ...call.arguments, slides: Array.from({ length: 9 }, () => ({ ...slides[1], texts: { t1: 'copy'.repeat(1_000), t2: 'source' } })) })
      longHistory.push({ role: 'assistant', content: 'Continue verification.' })
      const compacted = compactHistoricalToolPayloads(longHistory, { forceResultCompaction: true }).messages
      expect(compacted[1].reasoning_content).toBe(longHistory[1].reasoning_content)
      expect(JSON.parse(compacted[1].tool_calls![0].function.arguments)).toMatchObject({
        path: 'news.html', _historicalMutation: { operation: 'compose_reference_html', sourceSha256: catalog.sourceSha256, slideCount: 9 },
      })
      expect(visualWorkflowCompactionAnchors(compacted, 'news.html').has(compacted[2])).toBe(true)
      const duplicate = await tools.execute({ ...call, id: 'duplicate' }, context)
      expect(duplicate.isError).toBe(true)
      expect(duplicate.content).toContain('already exists')
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(await readFile(resolve(store.workspaceDir(session.summary.id), 'news.html'), 'utf8')).toBe(actual)
    } finally {
      await processes.stopEverything()
      await browser.closeEverything()
      await rm(root, { recursive: true, force: true })
    }
  })
})
