import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent-service.js'
import { SessionStore } from './session-store.js'
import type { DeepSeekClient } from './deepseek.js'
import { createArtifactReviewRepair } from './visual-artifact-review.js'
import { createResearchBrief } from './research-brief.js'
import { researchPageReadFromResult } from './research-evidence.js'
import { taskScopeIdentity } from './task-context.js'

const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 }
const html = '<!doctype html><html><body><section class="slide">Cover</section><section class="slide">Story</section><button>Next</button></body></html>'
const artifactHash = createHash('sha256').update(html).digest('base64url')
const draft = 'UNSUPPORTED_DRAFT: 所有事实都通过无损认证，every-page-qr.png 可以下载。'
const corrected = '已交付 `slides.html`，包括封面和内容页；预览仅在本地运行。'
const modelResult = (content: string) => ({ content, reasoningContent: '', finishReason: 'stop', toolCalls: [], usage, modelCallCount: 1 })
const assessedContent = (artifactIssues: unknown[]) => modelResult(JSON.stringify({ artifactIssues,
  taskFulfillment: { status: 'satisfied', issues: [] } }))
const deferred = () => { let resolvePromise!: () => void; const promise = new Promise<void>((done) => { resolvePromise = done }); return { promise, resolve: resolvePromise } }

describe('visual Final review publication boundary', () => {
  it.each(['corrected', 'metadata_missing', 'content_expansion', 'protocol_repair', 'artifact_repair', 'pending_deliverable', 'forced_checkpoint', 'publication_failure', 'invalid_json', 'quoted_label', 'universal_links', 'changed_file', 'cancelled', 'timed_out', 'tool_attempt', 'truncated', 'exhausted_budget', 'exact_format', 'content_changed_file', 'content_cancelled', 'content_invalid_json', 'receipt_resume', 'receipt_continue', 'content_progress', 'content_exhausted', 'content_budget'] as const)('settles review usage and publishes only an admitted Final (%s)', async (mode) => {
    const receiptRecovery = mode === 'receipt_resume' || mode === 'receipt_continue'
    const earlyFailure = ['content_changed_file', 'content_cancelled', 'content_invalid_json', 'content_exhausted'].includes(mode)
    const root = await mkdtemp(resolve(tmpdir(), 'anera-final-review-integration-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    if (mode === 'publication_failure') {
      const append = store.append.bind(store)
      vi.spyOn(store, 'append').mockImplementation(async (...args) => {
        const event = await append(...args)
        if (args[1] === 'assistant.final.delta') throw new Error('Fixture publication failure after admitted delta')
        return event
      })
    }
    const enteredReview = deferred()
    const releaseReview = deferred()
    let cursor = 0
    let reviewCalls = 0
    let artifactReviewCalls = 0
    let draftCalls = 0
    let stoppedForResume = false
    let currentHtml = html
    let currentHash = artifactHash
    const sources = Array.from({ length: 4 }, (_, index) => ({
      url: `https://example.org/report-${index}`, requestedUrl: `https://example.org/report-${index}`, title: 'Source',
      content: `Only the first stage is complete. ${'Supporting words. '.repeat(65)}The qualification remains.`, sha256: '',
    })).map((source) => ({ ...source, sha256: createHash('sha256').update(source.content).digest('hex') }))
    const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [
      { id: 'write', name: 'write_file', arguments: { path: 'slides.html', content: html } },
      { id: 'preview', name: 'start_process', arguments: { command: 'npm run preview' } },
      { id: 'open', name: 'browser', arguments: { action: 'open', path: 'slides.html' } },
      { id: 'next', name: 'browser', arguments: { action: 'press', key: 'ArrowRight' } },
      { id: 'screenshot', name: 'browser', arguments: { action: 'screenshot', screenshot_path: 'slides.png' } },
      { id: 'inspect', name: 'inspect_image', arguments: { path: 'slides.png', prompt: 'Return NO DEFECTS or concrete defects.' } },
      { id: 'present', name: 'present_file', arguments: { path: 'slides.html' } },
    ]
    const stream = async (options: Parameters<DeepSeekClient['stream']>[0]) => {
      await options.beforeRequest?.()
      if (String(options.messages[0]?.content).startsWith('You are an artifact-content reviewer')) {
        artifactReviewCalls += 1
        const temporalControl = options.messages.find((message) => String(message.content).startsWith('Harness task temporal context'))?.content
        expect(temporalControl).toBeDefined()
        expect(String(temporalControl)).toContain('"localDate":"2026-09-07"')
        expect(options.maxOutputTokens).toBeUndefined() // inherit configured reasoning + output budget
        expect(options.responseFormat).toEqual({ type: 'json_object' })
        expect(options.tools).toEqual([])
        expect(options.toolChoice).toBe('none')
        expect(JSON.parse(String(options.messages[1].content))).not.toHaveProperty('draft')
        expect(JSON.stringify(options.messages)).not.toContain('UNSUPPORTED_DRAFT')
        if (mode === 'content_budget') {
          const context = JSON.parse(String(options.messages[1].content)).deliveryContext
          expect(context.researchPlan.omittedExcerptCount).toBe(0)
          expect(context.researchPlan.items.map((item: { sources: Array<{ excerpt: string }> }) => item.sources[0].excerpt)).toEqual(sources.map((source) => source.content))
          expect(context.modelDeclarations.availableTextLocation).toBe('durable_research_brief')
          expect(JSON.stringify(options.messages)).not.toContain('模型备注')
        }
        if (mode === 'content_changed_file') await writeFile(resolve(store.workspaceDir(session.summary.id), 'slides.html'), '<html>Changed while reviewing content</html>')
        if (mode === 'content_cancelled') { enteredReview.resolve(); await releaseReview.promise }
        if (mode === 'content_invalid_json') return modelResult('UNREVIEWED_LEAK')
        if (mode === 'content_exhausted') {
          const input = JSON.parse(String(options.messages[1].content))
          const issue = { sourceSlide: 2, claim: 'Story', reason: 'The same located issue still needs repair.' }
          const prior = createArtifactReviewRepair(JSON.stringify(input.deliveryContext), taskScopeIdentity(input.taskRequest, String(temporalControl)), [issue])
          prior.attempts = 3
          delete prior.progressHistory // actual legacy migration boundary
          await store.update(session.summary.id, (next) => { next.activeArtifactReviewRepair = prior })
          return assessedContent([issue])
        }
        if (['artifact_repair', 'content_budget'].includes(mode) && artifactReviewCalls === 1 || mode === 'content_progress' && artifactReviewCalls <= 4) {
          // The content gate must repair before the first preview/browser/
          // Vision call, not replay these expensive phases after publication.
          expect(cursor).toBe(mode === 'content_progress' ? 1 + (artifactReviewCalls - 1) * 2 : 1)
          const claim = artifactReviewCalls === 1 ? 'Story' : `Supported story ${artifactReviewCalls - 1}`
          calls.splice(cursor, 0,
            { id: 'repair-read', name: 'read_file', arguments: { path: 'slides.html', offset: 1, limit: 5000 } },
            { id: 'repair-edit', name: 'edit_file', arguments: { path: 'slides.html', old_text: claim, new_text: `Supported story ${artifactReviewCalls}` } },
          )
          return assessedContent([{ sourceSlide: 2, claim, reason: 'Use the supported topic label in the document itself.',
            ...(mode === 'content_budget' ? { sourceUrl: sources[0].url, sourceQuote: 'Only the first stage is complete.' } : {}) }])
        }
        return assessedContent([])
      }
      if (String(options.messages[0]?.content).startsWith('You are a final-delivery reviewer')) {
        reviewCalls += 1
        expect(String(options.messages[0]?.content)).toContain('Harness task temporal context')
        expect(String(options.messages[0]?.content)).toContain('"localDate":"2026-09-07"')
        expect(options.maxOutputTokens).toBeUndefined()
        expect(options.responseFormat).toEqual({ type: 'json_object' })
        enteredReview.resolve()
        expect(options.tools).toEqual([])
        expect(options.toolChoice).toBe('none')
        const input = JSON.parse(String(options.messages[1]?.content))
        expect(input).not.toHaveProperty('draft')
        expect(JSON.stringify(options.messages)).not.toContain('UNSUPPORTED_DRAFT')
        // The writer's default view is not the publication receipt. The
        // controller still checks currentHash before publishing below.
        if (input.deliveryReceipt) {
          expect(input.completionControl).toMatchObject({ kind: 'delivery_outcome', artifactDelivery: 'completed', availability: 'local',
            verification: expect.arrayContaining([{ scope: 'local rendering and navigation', outcome: 'pass' }]) })
          expect(input.deliveryReceipt.kind).toBe('delivery_handoff')
          expect(input.deliveryReceipt.artifacts).toEqual([{ path: 'slides.html' }])
          expect(JSON.stringify(input)).not.toContain(currentHash)
          expect(input).not.toHaveProperty('linkCoverage')
        } else expect(JSON.stringify(input)).toContain(currentHash)
        expect(input.taskRequest).toContain('Create HTML Slides')
        if (mode === 'content_expansion') {
          if (reviewCalls === 1) {
            expect(input).toHaveProperty('deliveryReceipt')
            expect(input).not.toHaveProperty('deliveryContext')
            return modelResult(JSON.stringify({ needsContentEvidence: true }))
          }
          expect(input.deliveryContext.artifact.sections.some((section: { text: string }) => section.text.includes('Story'))).toBe(true)
          expect(input).not.toHaveProperty('deliveryReceipt')
        }
        if (mode === 'cancelled') await releaseReview.promise
        if (mode === 'timed_out') await new Promise<void>((done) => options.signal.addEventListener('abort', () => setTimeout(done, 10), { once: true }))
        if (mode === 'changed_file') await writeFile(resolve(store.workspaceDir(session.summary.id), 'slides.html'), '<html>Changed outside the run</html>')
        if (mode === 'protocol_repair' && reviewCalls === 1) return modelResult(JSON.stringify({ final: 'UNREVIEWED_LEAK', unknown: true }))
        if (mode === 'protocol_repair' && reviewCalls === 2) {
          expect(String(options.messages.at(-1)?.content)).toContain('only protocol correction attempt')
          expect(JSON.stringify(options.messages)).not.toContain('UNREVIEWED_LEAK')
        }
        const content = mode === 'invalid_json' ? 'UNREVIEWED_LEAK' : JSON.stringify({ final: mode === 'quoted_label' ? 'The cover reads "Invented label".'
          : mode === 'universal_links' ? 'Every slide has a source link.' : corrected,
          corrections: ['metadata_missing', 'quoted_label', 'universal_links', 'changed_file', 'cancelled', 'timed_out'].includes(mode) ? []
            : [{ category: 'overstated_verification', reason: 'Render inspection does not certify all facts.' }] })
        options.onContent(content)
        options.onReasoning('PRIVATE_REVIEW_THOUGHT')
        return { ...modelResult(content),
          ...(mode === 'truncated' ? { finishReason: 'length' } : {}),
          ...(mode === 'tool_attempt' ? { toolCalls: [{ id: 'unauthorized-review-write', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"evil.html","content":"evil"}' } }] } : {}) }
      }
      const call = calls[cursor]
      if (call) {
        if (receiptRecovery && call.id === 'preview' && !stoppedForResume) {
          stoppedForResume = true
          throw Object.assign(new Error('Fixture provider failure after durable content review'), {
            modelUsage: usage, modelCallCount: 1, modelRequestCount: 1,
          })
        }
        if (call.id === 'preview' && mode !== 'exact_format') {
          expect(artifactReviewCalls).toBe(mode === 'content_progress' ? 5 : ['artifact_repair', 'content_budget'].includes(mode) ? 2 : 1)
          const reloaded = await new SessionStore(root, 'test-model').get(session.summary.id)
          expect(reloaded.activeArtifactContentReviewReceipt?.schemaVersion).toBe(1)
          expect(reloaded.activeArtifactContentReviewReceipt?.taskFulfillment?.reviewerRevision).toBe('task-fulfillment-v1')
        }
        cursor += 1
        if (call.id === 'repair-read' || call.id === 'repair-edit') {
          expect(String(options.messages[0]?.content)).toContain('"localDate":"2026-09-07"')
          expect(options.tools.map((tool) => tool.function.name).sort()).toEqual((mode === 'content_budget'
            ? [call.name, 'web_search', 'web_fetch', 'fetch_page', 'record_research_brief'] : [call.name]).sort())
          const reloaded = await new SessionStore(root, 'test-model').get(session.summary.id)
          expect(reloaded.activeArtifactReviewRepair?.issues[0].claim).toBe(artifactReviewCalls > 1 ? `Supported story ${artifactReviewCalls - 1}` : 'Story')
          expect(options.messages.map((message) => message.content).join('\n')).toContain('separate model review')
          if (mode === 'content_budget' && call.id === 'repair-edit') {
            const control = String(options.messages.at(-1)?.content)
            expect(control).toContain('Content-repair source evidence, not a new authoring plan')
            expect(control).not.toContain('模型备注')
            expect(control).toContain('Only the first stage is complete.')
            expect(control).not.toContain("accepted brief's supported facts")
          }
        }
        return { ...modelResult(''), finishReason: 'tool_calls', toolCalls: [{ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      }
      draftCalls += 1
      const content = mode === 'exact_format' ? 'MARKER-731' : mode === 'pending_deliverable' ? 'The notes file is not yet written.' : draft
      options.onContent(content)
      return modelResult(content)
    }
    const agent = new AgentService(store, {
      client: { stream } as never,
      now: () => new Date('2026-09-07T08:22:48.835Z'),
      runTimeoutMs: mode === 'timed_out' ? 300 : undefined,
      maxAgentModelRequestsPerTurn: mode === 'exhausted_budget' ? calls.length + 1 : undefined,
      tools: { execute: async (call: { name: string; arguments: Record<string, unknown> }) => {
        if (call.name === 'write_file') {
          await writeFile(resolve(store.workspaceDir(session.summary.id), 'slides.html'), html)
          if (mode === 'content_budget') {
            const brief = createResearchBrief({ scope: 'Selected reports', limitations: Array.from({ length: 12 }, () => '模型备注。'.repeat(100)),
              items: sources.map((source) => ({ title: 'Stage report', summary: 'Only the first stage is complete.', date_note: 'Publication date unconfirmed',
                sources: [{ url: source.url, role: 'reporting', quality_note: 'Model interpretation', excerpt: source.content }] })) }, sources)
            await store.update(session.summary.id, (next) => { next.activeTaskResearchEvidence = {
              schemaVersion: 1, sourceUrls: sources.map((source) => source.url), toolCallIds: [], brief,
              pageReads: sources.map((source) => researchPageReadFromResult({ name: 'fetch_page', arguments: { url: source.url } },
                { status: 'success', url: source.url, content: source.content, snapshot_sha256: source.sha256 })!),
            } })
          }
          return { content: JSON.stringify({ status: 'success', path: 'slides.html', hash: artifactHash, canonical_html: true }), isError: false }
        }
        if (call.name === 'read_file') return { content: JSON.stringify({ kind: 'text', content: currentHtml, hasMore: false }), isError: false }
        if (call.name === 'edit_file') {
          currentHtml = currentHtml.replace(String(call.arguments.old_text), String(call.arguments.new_text))
          currentHash = createHash('sha256').update(currentHtml).digest('base64url')
          await writeFile(resolve(store.workspaceDir(session.summary.id), 'slides.html'), currentHtml)
          return { content: JSON.stringify({ status: 'success', path: 'slides.html', hash: currentHash, canonical_html: true }), isError: false }
        }
        if (call.name === 'browser') {
          const action = call.arguments.action
          return { content: JSON.stringify(action === 'screenshot' ? { status: 'success', path: 'slides.png' } : {
            url: 'http://127.0.0.1:49123/workspace/ses_fixture/preview/slides.html' + (action === 'press' ? '#slide-2' : ''),
            text: action === 'press' ? '2 / 2' : '1 / 2',
          }), isError: false }
        }
        if (call.name === 'inspect_image') return { content: 'Visual inspection:\nNO DEFECTS', isError: false }
        if (mode === 'forced_checkpoint' && call.name === 'present_file') {
          await store.update(session.summary.id, (next) => { next.forceCompactionRequested = {
            turnId: 'fixture-turn', stepId: 'fixture-step', callId: 'requested-checkpoint',
          } })
        }
        return { content: JSON.stringify({ status: 'success', path: call.arguments.path, artifact_hash: currentHash }), isError: false }
      } } as never,
    })
    const prepareContext = vi.spyOn(agent as any, 'prepareContext')
    try {
      await agent.submit(session.summary.id, { content: 'Create HTML Slides with two slides, preview and verify the result, and present slides.html.'
        + (mode === 'exact_format' ? ' Output exactly MARKER-731 and nothing else.' : mode === 'pending_deliverable' ? ' Also write notes.txt.' : '') })
      if (mode === 'cancelled' || mode === 'content_cancelled') {
        await Promise.race([enteredReview.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('review not reached')), 3_000))])
        await agent.cancel(session.summary.id)
        releaseReview.resolve()
      }
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (['completed', 'failed', 'cancelled', 'timed_out'].includes((await store.get(session.summary.id)).summary.status)) break
        await new Promise((done) => setTimeout(done, 5))
      }
      if (receiptRecovery) {
        const reloaded = await new SessionStore(root, 'test-model').get(session.summary.id)
        expect(reloaded.summary.status).toBe('failed')
        expect(reloaded.activeArtifactContentReviewReceipt?.schemaVersion).toBe(1)
        expect(artifactReviewCalls).toBe(1)
        if (mode === 'receipt_continue') await agent.submit(session.summary.id, { content: 'Continue' })
        else await agent.resume(session.summary.id)
        for (let attempt = 0; attempt < 500 && agent.isRunning(session.summary.id); attempt += 1) await new Promise((done) => setTimeout(done, 5))
      }
      if (mode === 'content_exhausted') {
        const reloaded = await new SessionStore(root, 'test-model').get(session.summary.id)
        expect(reloaded.summary.status).toBe('failed')
        expect(reloaded.activeArtifactReviewRepair?.attempts).toBe(4)
        expect(reloaded.activeArtifactReviewRepair?.issues[0].reason).toBe('The same located issue still needs repair.')
        const beforeResume = artifactReviewCalls
        await agent.resume(session.summary.id)
        for (let attempt = 0; attempt < 500 && agent.isRunning(session.summary.id); attempt += 1) await new Promise((done) => setTimeout(done, 5))
        expect(artifactReviewCalls).toBe(beforeResume)
      }
      await agent.shutdown()
      const state = await store.get(session.summary.id)
      const events = await store.events(session.summary.id)
      const diagnostic = JSON.stringify(events.filter((event) => ['error', 'model.final.repair', 'tool.failed'].includes(event.type)))
      // No disposable execution draft precedes independent delivery. Exact
      // user-format requests retain their existing main-model path.
      if (mode === 'pending_deliverable') expect(draftCalls, diagnostic).toBeGreaterThan(0)
      else expect(draftCalls, diagnostic).toBe(mode === 'exact_format' ? 1 : 0)
      expect(artifactReviewCalls, diagnostic).toBe(mode === 'exact_format' ? 0 : mode === 'content_progress' ? 5 : ['artifact_repair', 'content_invalid_json', 'content_budget'].includes(mode) ? 2 : 1)
      expect(reviewCalls, diagnostic).toBe(earlyFailure || ['exhausted_budget', 'exact_format', 'pending_deliverable'].includes(mode) ? 0 : ['content_expansion', 'protocol_repair', 'invalid_json'].includes(mode) ? 2 : 1)
      const successful = ['corrected', 'metadata_missing', 'content_expansion', 'protocol_repair', 'artifact_repair', 'forced_checkpoint', 'exact_format', 'receipt_resume', 'receipt_continue', 'content_progress', 'content_budget'].includes(mode)
      expect(state.summary.status, diagnostic).toBe(successful ? 'completed' : ['cancelled', 'content_cancelled'].includes(mode) ? 'cancelled' : mode === 'timed_out' ? 'timed_out' : 'failed')
      expect(events.filter((event) => event.type === 'assistant.final.delta').map((event) => event.data.delta)).toEqual(successful || mode === 'publication_failure' ? [mode === 'exact_format' ? 'MARKER-731' : corrected] : [])
      expect(events.filter((event) => event.type === 'assistant.final')).toHaveLength(successful ? 1 : 0)
      expect(JSON.stringify(state.messages)).not.toMatch(/UNSUPPORTED_DRAFT|UNREVIEWED_LEAK|PRIVATE_REVIEW_THOUGHT/)
      expect(JSON.stringify(events)).not.toMatch(/UNSUPPORTED_DRAFT|UNREVIEWED_LEAK|PRIVATE_REVIEW_THOUGHT/)
      expect(state.summary.usage.modelCalls).toBe(cursor + draftCalls + artifactReviewCalls + reviewCalls + Number(stoppedForResume))
      expect(state.summary.usage.totalTokens).toBe((cursor + draftCalls + artifactReviewCalls + reviewCalls + Number(stoppedForResume)) * usage.totalTokens)
      if (earlyFailure) {
        expect(cursor).toBe(1)
        expect(state.activeArtifactContentReviewReceipt).toBeUndefined()
        expect(events.some((event) => event.type === 'tool.completed' && (event.data.call as any)?.name === 'browser')).toBe(false)
      }
      if (mode === 'publication_failure') {
        expect(events.find((event) => event.type === 'error')?.data.partialResponsePersisted).toBe(true)
        expect(state.messages.at(-1)?.content).toBe(corrected)
      }
      expect(prepareContext).toHaveBeenCalledTimes(cursor + draftCalls + (mode === 'forced_checkpoint' ? 1 : 0) + Number(stoppedForResume))
      if (mode === 'forced_checkpoint') {
        expect(prepareContext.mock.calls.at(-1)?.[9]).toMatchObject({ force: true, reason: 'tool_request' })
        expect(state.forceCompactionRequested).toBeUndefined()
      }
      if (mode === 'content_expansion') expect(events.filter((event) => event.type === 'model.final.evidence.expanded')).toHaveLength(1)
      if (mode === 'metadata_missing') {
        expect(events.find((event) => event.type === 'model.final.repair' && event.data.reason === 'visual_delivery_review')?.data)
          .toMatchObject({ generationMode: 'independent', correctionCount: 0 })
        expect(events.some((event) => event.type === 'model.final.repair' && event.data.reason === 'visual_review_protocol')).toBe(false)
      }
      if (successful && mode !== 'exact_format') {
        const delivery = events.find((event) => event.type === 'model.final.repair' && event.data.reason === 'visual_delivery_review')?.data
        expect(delivery).toMatchObject({ generationMode: 'independent' })
        expect(delivery).not.toHaveProperty('draftSha256')
        expect(delivery).not.toHaveProperty('textChanged')
        expect(state.messages.filter((message) => message.role === 'assistant').at(-1)).not.toHaveProperty('reasoning_content')
      }
      if (!['changed_file', 'content_changed_file'].includes(mode)) expect(await readFile(resolve(store.workspaceDir(session.summary.id), 'slides.html'), 'utf8')).toBe(currentHtml)
      if (mode === 'artifact_repair') {
        expect(events.filter((event) => event.type === 'model.final.repair' && event.data.reason === 'visual_artifact_content_review' && event.data.succeeded === false)).toHaveLength(1)
        expect(events.filter((event) => event.type === 'tool.completed' && (event.data.call as any)?.name === 'inspect_image')).toHaveLength(1)
        expect(state.activeArtifactReviewRepair?.attempts).toBe(1)
      }
      if (mode === 'content_progress') {
        expect(state.activeArtifactReviewRepair?.attempts).toBe(4)
        expect(events.filter((event) => event.type === 'model.tool_call.repair' && event.data.reason === 'visual_no_progress_phase_recovery')).toHaveLength(0)
      }
      if (mode === 'content_exhausted') {
        expect(events.filter((event) => event.type === 'model.final.repair' && event.data.recoveryExhausted === true)).toHaveLength(1)
        expect(events.filter((event) => event.type === 'error')).toHaveLength(2)
      }
    } finally {
      releaseReview.resolve()
      await agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})
