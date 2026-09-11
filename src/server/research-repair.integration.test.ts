import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentService } from './agent-service.js'
import { SessionStore } from './session-store.js'
import { createResearchBrief, researchBriefMatchesReads } from './research-brief.js'
import type { DeepSeekClient } from './deepseek.js'
import type { ToolCallRecord } from '../shared/types.js'

const hash = (text: string) => createHash('sha256').update(text).digest('base64url')
const snapshot = (url: string, content: string) => ({ url, requestedUrl: url, title: 'Source report', content,
  sha256: createHash('sha256').update(content).digest('hex') })
const result = (content: string) => ({ content, reasoningContent: '', finishReason: 'stop', toolCalls: [],
  usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 }, modelCallCount: 1 })

describe('AgentService upstream evidence repair', () => {
  it.each(['read', 'edit'] as const)('reopens sources from the %s repair state without blessing unchanged output', async (repairState) => {
    const topic = 'engineering rollout'
    const root = await mkdtemp(resolve(tmpdir(), 'anera-upstream-repair-'))
    const store = new SessionStore(root, 'offline-model')
    await store.initialize()
    const id = (await store.create()).summary.id
    const url = 'https://reports.example.org/source'
    let source = snapshot(url, 'The project has started. Full completion is not confirmed.')
    const briefArgs = () => ({ scope: topic, limitations: [], items: [{ title: 'Project report',
      summary: source.content, date_note: 'No publication date confirmed.',
      sources: [{ url, role: 'reporting', quality_note: 'Original report.', excerpt: source.content }] }] })
    let html = `<!doctype html><html><body><section class="slide">${topic}</section><section class="slide">The project is complete.<a href="${url}">Report</a></section><button>Next</button></body></html>`
    const original = html
    const readCall = { id: 'repair-read', name: 'read_file', arguments: { path: 'report.html', offset: 1, limit: 5000 } }
    const calls: ToolCallRecord[] = [
      { id: 'search', name: 'web_search', arguments: { query: `${topic} project report` } },
      { id: 'fetch', name: 'fetch_page', arguments: { url } },
      { id: 'brief', name: 'record_research_brief', arguments: {} },
      { id: 'write', name: 'write_file', arguments: { path: 'report.html', content: html } },
      ...(repairState === 'edit' ? [readCall] : []),
      { id: 'repair-fetch', name: 'fetch_page', arguments: { url } },
      { id: 'repair-brief', name: 'record_research_brief', arguments: {} },
      ...(repairState === 'read' ? [readCall] : []),
      { id: 'reject-other-path', name: 'edit_file', arguments: { path: 'unrelated.html', old_text: 'x', new_text: 'y' } },
      { id: 'repair-edit', name: 'edit_file', arguments: { path: 'report.html', old_text: 'The project is complete.', new_text: 'Only the initial phase is complete.' } },
    ]
    let cursor = 0
    let reviews = 0
    let previewReached = false
    const executed: string[] = []
    let previousBrief: string | undefined
    const repairDiscovery = ['related source', 'additional evidence'].map((query, index) => ({
      id: `repair-discovery-${index}`, name: 'web_search', arguments: { query },
    }))
    const stream: DeepSeekClient['stream'] = async (options) => {
      await options.beforeRequest?.()
      const state = await store.get(id)
      if (String(options.messages[0]?.content).startsWith('You are an artifact-content reviewer')) {
        reviews++
        expect(options.tools).toEqual([])
        const payload = JSON.parse(String(options.messages[1].content))
        expect(payload.deliveryContext.artifact.sha256).toBe(hash(html))
        if (reviews <= 2) {
          expect(html).toBe(original)
          expect(cursor).toBe(reviews === 1 ? 4 : repairState === 'edit' ? 7 : 6)
          if (reviews === 2) {
            expect(state.activeTaskResearchEvidence?.brief?.sha256).not.toBe(previousBrief)
            expect(JSON.stringify(payload.deliveryContext.researchPlan)).toContain('Only the initial phase is complete.')
          }
          return result(JSON.stringify({ taskFulfillment: { status: 'satisfied', issues: [] }, artifactIssues: [{ sourceSlide: 2, claim: 'The project is complete.',
            reason: 'The cited report does not support full completion.', sourceUrl: url, sourceQuote: source.content }] }))
        }
        expect(reviews).toBe(3)
        expect(html).not.toBe(original)
        return result(JSON.stringify({ artifactIssues: [], taskFulfillment: { status: 'satisfied', issues: [] } }))
      }
      const call = calls[cursor]
      if (!call) {
        expect(reviews).toBe(3)
        expect(options.tools.map((tool) => tool.function.name)).toContain('start_process')
        expect(state.activeArtifactContentReviewReceipt?.schemaVersion).toBe(1)
        previewReached = true
        // Deliberate boundary: this fixture tests real orchestration/storage,
        // not browser rendering or end-to-end visual acceptance.
        throw new Error('Fixture stopped at ordinary preview gate')
      }
      if (call.id.startsWith('repair-') || call.id === 'reject-other-path') {
        expect(state.activeArtifactContentReviewReceipt).toBeUndefined()
        expect(executed).not.toContain('start_process')
        if (call.id !== 'repair-brief') {
          const candidate = ['repair-edit', 'reject-other-path'].includes(call.id)
            || call.id === 'repair-fetch' && repairState === 'edit' ? 'edit_file' : 'read_file'
          expect(options.tools.map((tool) => tool.function.name).sort()).toEqual([
            candidate, 'web_search', 'web_fetch', 'fetch_page', 'record_research_brief',
          ].sort())
        } else {
          const evidence = state.activeTaskResearchEvidence!
          expect(researchBriefMatchesReads(evidence.brief, evidence.pageReads ?? [])).toBe(false)
          expect(options.tools.map((tool) => tool.function.name)).toContain('record_research_brief')
        }
        if (call.id === 'repair-fetch') previousBrief = state.activeTaskResearchEvidence?.brief?.sha256
        if (call.id === 'repair-edit') {
          const last = state.messages.findLast((message) => message.role === 'tool')!
          expect(last.tool_result_status).toBe('failed')
          expect(last.content).toContain('not enabled for this task')
        }
      }
      cursor++
      if (call.name === 'record_research_brief') call.arguments = briefArgs()
      const batch = call.id === 'repair-fetch' ? [call, ...repairDiscovery] : [call]
      return { ...result(''), finishReason: 'tool_calls', toolCalls: batch.map((entry) => ({ id: entry.id, type: 'function',
        function: { name: entry.name, arguments: JSON.stringify(entry.arguments) } })) }
    }
    const agent = new AgentService(store, { client: { stream } as never,
      tools: { execute: async (call: ToolCallRecord) => {
        executed.push(call.id)
        let payload: Record<string, unknown>
        if (call.name === 'web_search') payload = { status: 'success', results: [{ url, title: 'Source report', snippet: source.content }] }
        else if (call.name === 'fetch_page') {
          if (call.id === 'repair-fetch') source = snapshot(url, 'Only the initial phase is complete. Further work remains.')
          payload = { status: 'success', url, content: source.content, snapshot_sha256: source.sha256, hasMore: false, chunkIndex: 0, totalChunks: 1 }
        } else if (call.name === 'record_research_brief') payload = { status: 'success', brief: createResearchBrief(call.arguments, [source]) }
        else if (call.name === 'read_file') payload = { kind: 'text', content: html, hasMore: false }
        else {
          expect(['write_file', 'edit_file']).toContain(call.name)
          expect(call.arguments.path).toBe('report.html')
          if (call.name === 'edit_file') html = html.replace(String(call.arguments.old_text), String(call.arguments.new_text))
          await writeFile(resolve(store.workspaceDir(id), 'report.html'), html)
          payload = { status: 'success', path: 'report.html', hash: hash(html), canonical_html: true }
        }
        return { content: JSON.stringify(payload), isError: false }
      } } as never })
    try {
      await agent.submit(id, { content: `Research ${topic} using web sources and create two HTML Slides in report.html. Verify and present the result.` })
      for (let attempt = 0; attempt < 1000 && agent.isRunning(id); attempt++) await new Promise((done) => setTimeout(done, 5))
      await agent.shutdown()
      const events = await store.events(id)
      const errors = JSON.stringify(events.filter((event) => ['error', 'tool.failed'].includes(event.type)))
      expect(previewReached, errors).toBe(true)
      expect(executed).toEqual(calls.filter((call) => call.id !== 'reject-other-path')
        .flatMap((call) => call.id === 'repair-fetch' ? [call.id, ...repairDiscovery.map((entry) => entry.id)] : [call.id]))
      expect(events.filter((event) => event.type === 'assistant.final')).toEqual([])
      expect(await readFile(resolve(store.workspaceDir(id), 'report.html'), 'utf8')).toBe(html)
      expect(events.some((event) => event.type === 'model.tool_call.repair' && event.data.reason === 'canonical_diagnostic_read')).toBe(false)
    } finally {
      await agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})
