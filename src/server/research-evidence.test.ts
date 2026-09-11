import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage, SessionEvent } from '../shared/types.js'
import {
  AgentService,
  compactHistoricalToolPayloads,
  recoverActiveTaskResearchEvidence,
  recoverActiveTaskRequestText,
  researchArtifactSourceRepairPhase,
  visualWebArtifactCompletionGap,
  visualWebArtifactPhaseInstruction,
  webResearchArtifactCitationGap,
  webResearchCitationGap,
  visualResearchHtmlWriteVerificationGap,
} from './agent-service.js'
import { SessionStore } from './session-store.js'
import { normalizeResearchPageReads, researchPageReadFromResult, researchPageReadProgress } from './research-evidence.js'

const sourceUrl = 'https://news.example/article'
const request: ModelMessage = { role: 'user', content: '研究本周娱乐新闻，制作 HTML Slides。' }
const call = { id: 'read-article', name: 'fetch_page', arguments: { url: sourceUrl, format: 'markdown' } }
const body = (extra: Record<string, unknown> = {}) => ({
  status: 'success', url: sourceUrl, title: 'News article', content: 'An attributed, dated article body.',
  chunkIndex: 0, hasMore: false, totalChunks: 1, ...extra,
})
const messages = (name: string, payload: Record<string, unknown>): ModelMessage[] => [request, {
  role: 'assistant', content: null,
  tool_calls: [{ id: call.id, type: 'function', function: { name, arguments: JSON.stringify(call.arguments) } }],
}, {
  role: 'tool', tool_call_id: call.id, tool_result_status: 'succeeded', content: JSON.stringify(payload),
}]

describe('page-body research evidence', () => {
  it('does not promote search snippets, empty pages, errors or legacy URL summaries to a page read', () => {
    expect(researchPageReadFromResult({ ...call, name: 'web_search' }, body())).toBeUndefined()
    for (const payload of [body({ content: ' ' }), body({ status: 'error' }), body({ truncated: true }),
      body({ notExecuted: true }), body({ not_executed: true }),
      body({ content: 'Some article text\n[Content truncated]' }),
      { status: 'success', historical_result_compacted: true, source_urls: [sourceUrl], summary_head: 'article' },
    ]) expect(researchPageReadFromResult(call, payload)).toBeUndefined()
  })

  it('requires each chunk of the same immutable snapshot, and never infers chunk zero from EOF', () => {
    const chunk = (chunkIndex: number, snapshot = 'a'.repeat(64)) => researchPageReadFromResult(call, body({
      chunkIndex, hasMore: chunkIndex < 2, totalChunks: 3, snapshot_sha256: snapshot,
      content: `Article body chunk ${chunkIndex}`,
    }))!
    expect(researchPageReadProgress([chunk(2)]).pending[0].chunkIndex).toBe(0)
    expect(researchPageReadProgress([chunk(0), chunk(2)]).pending[0].chunkIndex).toBe(1)
    expect(researchPageReadProgress([chunk(0), chunk(1), chunk(2, 'b'.repeat(64))]).sourceUrls).toEqual([])
    expect(researchPageReadProgress([chunk(0), chunk(1), chunk(2)])).toEqual({ sourceUrls: [sourceUrl], pending: [] })
  })

  it('keeps private snapshot evidence authoritative over public legacy-shaped chunks', () => {
    const privateRead = researchPageReadFromResult(call, body({
      hasMore: true, totalChunks: 2, snapshot_sha256: 'a'.repeat(64),
    }))!
    const publicRead = researchPageReadFromResult(call, body({ hasMore: true, totalChunks: 2 }))!
    expect(researchPageReadProgress([privateRead, publicRead]).pending).toEqual([
      { url: sourceUrl, format: 'markdown', chunkIndex: 1, totalChunks: 2 },
    ])
    expect(normalizeResearchPageReads([privateRead, privateRead])).toHaveLength(1)
    expect(normalizeResearchPageReads([{ ...privateRead, contentSha256: 'invented' }])).toEqual([])
  })

  it('does not let an old complete snapshot hide a newer pending version, even through a redirect alias', () => {
    const old = researchPageReadFromResult(call, body({ snapshot_sha256: 'a'.repeat(64) }))!
    const next = researchPageReadFromResult({ ...call, arguments: { url: 'https://news.example/redirect' } }, body({
      snapshot_sha256: 'b'.repeat(64), hasMore: true, totalChunks: 2,
    }))!
    expect(researchPageReadProgress([old, next])).toEqual({ sourceUrls: [], pending: [
      { url: 'https://news.example/redirect', format: 'markdown', chunkIndex: 1, totalChunks: 2 },
    ] })
    const changed = researchPageReadFromResult(call, body({ content: 'A newly read representation.' }))!
    expect(researchPageReadProgress([old, changed]).sourceUrls).toEqual([sourceUrl])
    // Re-reading the original bytes is another observation, not a stale Map position.
    expect(normalizeResearchPageReads([old, changed, old])).toEqual([changed, old])
  })

  it('keeps discovery in the research phase and selects body retrieval as the next concrete action', () => {
    const gap = visualWebArtifactCompletionGap(messages('web_search', {
      status: 'success', results: [{ url: sourceUrl, description: 'A search snippet is not an article read.' }],
    }))
    expect(gap?.missingPhases).toContain('web_research')
    expect(visualWebArtifactPhaseInstruction(gap)).toContain('read the actual bodies')
    expect(visualWebArtifactPhaseInstruction(gap)).toContain(sourceUrl)
    expect(visualWebArtifactCompletionGap(messages('fetch_page', body()))?.missingPhases).not.toContain('web_research')
  })

  it('retains completed reads through provider compaction without claiming fact verification', () => {
    const original = messages('fetch_page', body({ content: 'Dated article detail. '.repeat(800) }))
    original.push({ role: 'assistant', content: 'Read the article; continue with the reference.' })
    const compacted = compactHistoricalToolPayloads(original, { forceResultCompaction: true }).messages
    expect(compacted[2].content).toContain('research_page_read')
    expect(visualWebArtifactCompletionGap(compacted)?.missingPhases).not.toContain('web_research')
    expect(webResearchArtifactCitationGap(compacted, `<a href="${sourceUrl}">Article</a>`)).toBeUndefined()
  })

  it('can replace an unavailable partial source without accepting its incomplete bytes as citations', () => {
    const partial = researchPageReadFromResult(call, body({
      hasMore: true, totalChunks: 2, snapshot_sha256: 'a'.repeat(64),
    }))!
    const alternative = 'https://news.example/alternative'
    const read = researchPageReadFromResult({ ...call, arguments: { url: alternative } }, body({ url: alternative }))!
    const progress = researchPageReadProgress([partial, read], [sourceUrl])
    expect(progress).toEqual({ sourceUrls: [alternative], pending: [] })
    expect(visualWebArtifactCompletionGap([request], {
      researchPageReads: [partial, read], researchUnavailableSourceUrls: [sourceUrl],
    })?.missingPhases).not.toContain('web_research')
  })

  it('persists failed continuation evidence and clears that failure only after new returned bytes', () => {
    const read = researchPageReadFromResult(call, body({
      hasMore: true, totalChunks: 2, snapshot_sha256: 'a'.repeat(64),
    }))!
    const base = { sessionId: 'ses_unavailable', at: '2026-09-07T00:00:00.000Z', turnId: 'turn_research' }
    const events: SessionEvent[] = [{
      ...base, id: 'e1', seq: 1, type: 'turn.started', data: { content: request.content },
    }, {
      ...base, id: 'e2', seq: 2, type: 'tool.completed', callId: call.id,
      data: { call, result: JSON.stringify(body({ hasMore: true, totalChunks: 2 })), researchPageRead: read },
    }, {
      ...base, id: 'e3', seq: 3, type: 'tool.failed', callId: 'continue-failed',
      data: { call: { ...call, id: 'continue-failed' }, result: '{"status":"error","error":"HTTP 403"}', isError: true },
    }]
    const recovered = recoverActiveTaskResearchEvidence(events)
    expect(recovered.unavailableSourceUrls).toEqual([sourceUrl])
    expect(visualWebArtifactCompletionGap([request], {
      researchSourceUrls: recovered.sourceUrls, researchPageReads: recovered.pageReads,
      researchUnavailableSourceUrls: recovered.unavailableSourceUrls,
    })?.research).toMatchObject({ sourceUrls: [], pending: [], discoveredUrls: [] })
    expect(recoverActiveTaskResearchEvidence([...events, {
      ...base, id: 'e4', seq: 4, type: 'tool.completed', callId: 'retry',
      data: { call: { ...call, id: 'retry' }, result: JSON.stringify(body()) },
    }]).unavailableSourceUrls).toBeUndefined()
  })

  it('rejects a discovered but unread citation even when another article has been read', () => {
    const unread = 'https://news.example/unread'
    const history = messages('fetch_page', body())
    history.push({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'search-unread', type: 'function', function: { name: 'web_search', arguments: '{"query":"more news"}' } }],
    }, {
      role: 'tool', tool_call_id: 'search-unread', tool_result_status: 'succeeded',
      content: JSON.stringify({ status: 'success', results: [{ url: unread }] }),
    })
    expect(webResearchArtifactCitationGap(history, `<a href="${sourceUrl}">Read</a><a href="${unread}">Unread</a>`))
      .toMatchObject({ citedSourceUrls: [sourceUrl], unsupportedCitationUrls: [unread] })
  })

  it('does not parse a quoted bare URL scheme as an invented source', () => {
    expect(webResearchCitationGap(messages('fetch_page', body()),
      `来源：${sourceUrl}。引用保留完整的 \`https://\`，不要只写站点名称。`)).toBeUndefined()
  })

  it('keeps trusted legacy research intent and template exclusions without treating summaries as article reads', () => {
    const template = 'https://reference.example/template.html'
    const legacy = messages('web_search', { status: 'success', results: [{ url: sourceUrl }] }).slice(1)
    const options = { requiresResearch: true, requiresPageBody: true, referenceUrls: [template] }
    expect(webResearchArtifactCitationGap(legacy, sourceUrl, [], options))
      .toMatchObject({ sourceUrls: [], unsupportedCitationUrls: [sourceUrl] })
    expect(webResearchArtifactCitationGap(legacy, template, [template], options)?.sourceUrls).toEqual([])
    expect(visualResearchHtmlWriteVerificationGap(legacy, '<html>No source</html>', [], options))
      .toContain('cannot be written before a successful Web source')
    expect(webResearchCitationGap(legacy, 'An unsupported claim.', [], options)?.sourceUrls).toEqual([])
    expect(webResearchArtifactCitationGap(legacy, sourceUrl, [sourceUrl], options)).toBeUndefined()
    expect(webResearchArtifactCitationGap([
      ...legacy, { role: 'user', content: 'Make a local clock. No web research is needed.' },
    ], 'Local clock')).toBeUndefined()
    expect(visualWebArtifactCompletionGap([{
      role: 'user', content: 'Create HTML Slides about the current incident using only the attached reports. No web research is needed.',
    }])?.missingPhases).not.toContain('web_research')
    expect(visualWebArtifactCompletionGap([{
      role: 'user', content: 'Research ancient Rome and create source-backed HTML Slides.',
    }])?.missingPhases).toContain('web_research')
  })

  it('keeps every outstanding citation in the repair phase, prioritizes cited URLs, and can replace unavailable ones', () => {
    const unread = 'https://news.example/unread'
    const another = 'https://news.example/another-unread'
    const unrelated = 'https://news.example/discovered-but-not-cited'
    const failure: ModelMessage[] = [{
      role: 'assistant', content: null,
      tool_calls: [{ id: 'present-blocked', type: 'function', function: { name: 'present_file', arguments: '{"path":"deck.html"}' } }],
    }, {
      role: 'tool', tool_call_id: 'present-blocked', tool_result_status: 'succeeded',
      content: JSON.stringify({ status: 'verification_required', not_executed: true,
        message: `Research-source verification failed for deck.html. Add at least one exact retrieved source URL to the deliverable. Remove or replace unsupported external URLs: ${unread}, ${another}. Retrieved source URLs: ${sourceUrl}` }),
    }]
    const history = [request, ...failure]
    const discoveries = [sourceUrl, unread, another, unrelated]
    const options = { requiresPageBody: true, discoveredSourceUrls: discoveries }
    expect(researchArtifactSourceRepairPhase(history, 'deck.html', [sourceUrl, unread], options)).toBe('search')
    expect(researchArtifactSourceRepairPhase(history, 'deck.html', [sourceUrl, unread, another], options)).toBeUndefined()
    expect(researchArtifactSourceRepairPhase(history, 'deck.html', [sourceUrl, unread], {
      ...options, unavailableSourceUrls: [another],
    })).toBe('read')
    const gap = visualWebArtifactCompletionGap(history, {
      canonicalPath: 'deck.html', researchSourceUrls: discoveries,
      researchPageReads: [researchPageReadFromResult(call, body())!],
    })
    expect(gap?.research?.citationUrls).toEqual([unread, another])
    expect(visualWebArtifactPhaseInstruction(gap)).toContain(unread)
    expect(visualWebArtifactPhaseInstruction(gap)).not.toContain(unrelated)
    expect(researchArtifactSourceRepairPhase([
      ...history, { role: 'user', content: 'Explain TCP congestion control.' },
    ], 'deck.html', [], options)).toBeUndefined()
  })

  it('recovers private reads from the event journal, excludes template reads, and respects undo/new tasks', () => {
    const template = 'https://reference.example/template.html'
    const base = { sessionId: 'ses_research', at: '2026-09-07T00:00:00.000Z', turnId: 'turn_research' }
    const read = researchPageReadFromResult(call, body())!
    const events: SessionEvent[] = [{
      ...base, id: 'e1', seq: 1, type: 'turn.started', data: { content: `${request.content} 风格严格参考 ${template}` },
    }, {
      ...base, id: 'e2', seq: 2, type: 'tool.completed', callId: call.id,
      data: { call, result: JSON.stringify(body()), researchPageRead: read },
    }, {
      ...base, id: 'e3', seq: 3, type: 'tool.completed', callId: 'template',
      data: { call: { ...call, id: 'template', arguments: { url: template } }, result: JSON.stringify(body({ url: template })) },
    }]
    const recovered = recoverActiveTaskResearchEvidence(events)
    expect(recovered.pageReads).toEqual([read])
    expect(recoverActiveTaskRequestText(events)).toContain(String(request.content))
    expect(read.contentSha256).toBe(createHash('sha256').update(String(body().content)).digest('hex'))
    expect(visualWebArtifactCompletionGap([request], { researchPageReads: recovered.pageReads })?.missingPhases)
      .not.toContain('web_research')
    expect(recoverActiveTaskResearchEvidence([...events, {
      ...base, id: 'undo', seq: 4, type: 'turn.undone', data: { targetTurnIds: ['turn_research'] },
    }]).pageReads).toBeUndefined()
    expect(recoverActiveTaskResearchEvidence([...events, {
      ...base, id: 'new', seq: 4, type: 'turn.started', data: { content: '新任务：做一个本地时钟。' },
    }]).pageReads).toBeUndefined()
    expect(recoverActiveTaskRequestText([...events, {
      ...base, id: 'continue', seq: 4, type: 'turn.started', data: { content: 'Continue the unfinished task.' },
    }])).toContain(String(request.content))
    expect(recoverActiveTaskRequestText([...events, {
      ...base, id: 'undo', seq: 4, type: 'turn.undone', data: { targetTurnIds: ['turn_research'] },
    }])).toBeUndefined()
    expect(recoverActiveTaskRequestText([...events, {
      ...base, id: 'new', seq: 4, type: 'turn.started', data: { content: '新任务：做一个本地时钟。' },
    }])).toBe('新任务：做一个本地时钟。')
  })

  it('recovers research routing after a real service restart with no original prompt or useful checkpoint left in messages', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-research-intent-restart-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const original = new AgentService(store, {
      client: { stream: vi.fn(async () => { throw new Error('fixture interruption before legacy checkpoint') }) } as never,
    })
    let resumed: AgentService | undefined
    let observed = false
    try {
      await original.submit(session.summary.id, { content: '研究本周娱乐新闻，制作中文 HTML Slides。' })
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!original.isRunning(session.summary.id)) break
        await new Promise((done) => setTimeout(done, 5))
      }
      expect((await store.get(session.summary.id)).summary.status).toBe('failed')
      await original.shutdown()
      await store.update(session.summary.id, (state) => {
        state.messages = [{ role: 'assistant', content: 'Earlier work was compacted.' }]
        delete state.activeVisualWebSlidePlan
      })
      const restartedStore = new SessionStore(root, 'test-model')
      await restartedStore.initialize()
      resumed = new AgentService(restartedStore, {
        client: { stream: vi.fn(async (options: { messages: ModelMessage[]; tools: Array<{ function: { name: string } }> }) => {
          const names = options.tools.map((tool) => tool.function.name)
          expect(names).toContain('web_search')
          expect(names).toContain('fetch_page')
          expect(names).not.toContain('write_file')
          expect(names).not.toContain('present_file')
          expect(options.messages.some((message) => String(message.content).includes('研究本周娱乐新闻，制作中文 HTML Slides。'))).toBe(true)
          observed = true
          throw new Error('fixture stop after verified journal-backed routing')
        }) } as never,
      })
      await resumed.resume(session.summary.id)
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!resumed.isRunning(session.summary.id)) break
        await new Promise((done) => setTimeout(done, 5))
      }
      expect(observed).toBe(true)
      const errors = (await restartedStore.events(session.summary.id)).filter((event) => event.type === 'error')
      expect(errors.at(-1)?.data.message).toBe('fixture stop after verified journal-backed routing')
    } finally {
      await original.shutdown()
      await resumed?.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })
})
