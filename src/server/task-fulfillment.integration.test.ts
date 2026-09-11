import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentService } from './agent-service.js'
import { SessionStore } from './session-store.js'
import { artifactReviewProgressIdentity } from './visual-artifact-review.js'
import type { DeepSeekClient } from './deepseek.js'
import type { ToolCallRecord } from '../shared/types.js'

const modelResult = (payload: unknown) => ({ content: JSON.stringify(payload), reasoningContent: '', finishReason: 'stop', toolCalls: [],
  usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 }, modelCallCount: 1 })
const hash = (html: string) => createHash('sha256').update(html).digest('base64url')
const request = 'Create two HTML Slides about a deployment plan. Include risks and mitigations. Verify and present report.html.'
const requirementIssue = { requirement: 'Include risks and mitigations.', status: 'unmet', reason: 'The sequence is present but the required risks and mitigations are absent.' }

describe('AgentService task fulfillment admission', () => {
  it.each(['missing', 'extra'] as const)('recovers %s envelope fields once through the actual persisted controller', async (mode) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-review-envelope-'))
    const store = new SessionStore(root, 'offline-model')
    await store.initialize()
    const id = (await store.create()).summary.id
    const html = '<!doctype html><html><body><section class="slide">Deployment plan</section><section class="slide">Risk: incompatible config. Mitigation: staging and rollback.</section></body></html>'
    let wrote = false
    let reviews = 0
    let previewReached = false
    let evidenceInput: string | undefined
    const stream: DeepSeekClient['stream'] = async (options) => {
      await options.beforeRequest?.()
      if (String(options.messages[0]?.content).startsWith('You are an artifact-content reviewer')) {
        reviews++
        expect(options.responseFormat).toEqual({ type: 'json_object' })
        expect(options.tools).toEqual([])
        evidenceInput ??= String(options.messages[1].content)
        expect(options.messages[1].content).toBe(evidenceInput)
        const verdict = { artifactIssues: [], taskFulfillment: { status: 'satisfied', issues: [] } }
        if (reviews === 1) return modelResult(mode === 'missing' ? { artifactIssues: [] } : { ...verdict, PRIVATE_FIELD: 'PRIVATE_RESPONSE' })
        expect(options.messages.at(-1)?.content).toContain(mode === 'missing' ? 'taskFulfillment required (missing)' : 'unexpected top-level fields: 1')
        expect(JSON.stringify(options.messages)).not.toContain('PRIVATE_')
        expect((await store.get(id)).activeArtifactContentReviewReceipt).toBeUndefined()
        return modelResult(verdict)
      }
      if (wrote) {
        expect(reviews).toBe(2)
        expect((await store.get(id)).activeArtifactContentReviewReceipt?.taskFulfillment).toBeDefined()
        expect(options.tools.map((tool) => tool.function.name)).toContain('start_process')
        previewReached = true
        throw new Error('Fixture boundary: normal downstream verification still required')
      }
      wrote = true
      return { ...modelResult(''), content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'write', type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'report.html', content: html }) } }] }
    }
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute: async (call: ToolCallRecord) => {
      expect(call.name).toBe('write_file')
      await writeFile(resolve(store.workspaceDir(id), 'report.html'), html)
      return { content: JSON.stringify({ status: 'success', path: 'report.html', hash: hash(html), canonical_html: true }), isError: false }
    } } as never })
    try {
      await agent.submit(id, { content: request })
      for (let attempt = 0; attempt < 1000 && agent.isRunning(id); attempt++) await new Promise((done) => setTimeout(done, 5))
      expect(agent.isRunning(id)).toBe(false)
      const events = await store.events(id)
      expect(previewReached, JSON.stringify(events.filter((event) => event.type === 'error'))).toBe(true)
      const repairs = events.filter((event) => event.type === 'model.final.repair' && event.data.reason === 'visual_review_protocol')
      expect(repairs).toHaveLength(1)
      expect(JSON.stringify(repairs)).not.toContain('PRIVATE_')
      expect(events.filter((event) => event.type === 'usage.updated' && event.data.source === 'agent')).toHaveLength(3)
      expect(events.filter((event) => event.type === 'assistant.final')).toEqual([])
      expect((await new SessionStore(root, 'offline-model').get(id)).activeArtifactContentReviewReceipt?.taskFulfillment).toBeDefined()
      expect(await readFile(resolve(store.workspaceDir(id), 'report.html'), 'utf8')).toBe(html)
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  }, 10_000)

  it.each(['repair', 'missing-verdict', 'invented-requirement'] as const)('handles %s without substituting a factual pass for task completion', async (mode) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-task-fulfillment-'))
    const store = new SessionStore(root, 'offline-model')
    await store.initialize()
    const id = (await store.create()).summary.id
    let html = '<!doctype html><html><body><section class="slide">Deployment plan</section><section class="slide">Stage then deploy.</section><button>Next</button></body></html>'
    const calls: ToolCallRecord[] = [
      { id: 'write', name: 'write_file', arguments: { path: 'report.html', content: html } },
      { id: 'read-before-disclaimer', name: 'read_file', arguments: { path: 'report.html', offset: 1, limit: 5000 } },
      { id: 'disclaimer', name: 'edit_file', arguments: { path: 'report.html', old_text: 'Stage then deploy.', new_text: 'Stage then deploy. This is only a limited selection.' } },
      { id: 'read-before-repair', name: 'read_file', arguments: { path: 'report.html', offset: 1, limit: 5000 } },
      { id: 'repair', name: 'edit_file', arguments: { path: 'report.html', old_text: 'This is only a limited selection.',
        new_text: 'Risk: incompatible configuration. Mitigation: validate in staging and retain a rollback configuration.' } },
    ]
    const executed: string[] = []
    let cursor = 0
    let reviews = 0
    let interruptedOnce = false
    let previewReached = false
    let firstIdentity: string | undefined
    const stream: DeepSeekClient['stream'] = async (options) => {
      await options.beforeRequest?.()
      const state = await store.get(id)
      if (String(options.messages[0]?.content).startsWith('You are an artifact-content reviewer')) {
        reviews++
        expect(options.tools).toEqual([])
        const input = JSON.parse(String(options.messages[1].content))
        expect(input.taskRequest).toBe(request)
        expect(input.deliveryContext.artifact.sha256).toBe(hash(html))
        if (mode === 'missing-verdict') return modelResult({ artifactIssues: [] })
        if (mode === 'invented-requirement') return modelResult({ artifactIssues: [], taskFulfillment: {
          status: 'needs_work', issues: [{ ...requirementIssue, requirement: 'Deploy to a public production site.' }],
        } })
        expect(cursor).toBe(reviews === 1 ? 1 : reviews === 2 ? 3 : 5)
        // Every existing sentence is accurate, but the task is still unmet.
        return modelResult({ artifactIssues: [], taskFulfillment: reviews < 3
          ? { status: 'needs_work', issues: [requirementIssue] } : { status: 'satisfied', issues: [] } })
      }
      if (cursor > 0 && cursor < calls.length) {
        expect(state.activeArtifactContentReviewReceipt).toBeUndefined()
        expect(state.activeArtifactReviewRepair?.issues).toEqual([])
        expect(state.activeArtifactReviewRepair?.requirementIssues).toEqual([requirementIssue])
        const identity = artifactReviewProgressIdentity(state.activeArtifactReviewRepair)
        firstIdentity ??= identity
        expect(identity).toBe(firstIdentity)
        if (!interruptedOnce) {
          interruptedOnce = true
          throw new Error('Fixture interrupt after durable unmet requirement')
        }
        expect(reviews).toBe(cursor <= 2 ? 1 : 2) // Resume did not buy a duplicate review.
        expect(options.tools.map((tool) => tool.function.name)).toEqual([calls[cursor].name])
        expect(JSON.stringify(options.messages)).toContain('Unresolved original task requirements')
      }
      if (cursor === calls.length) {
        expect(reviews).toBe(3)
        expect(state.activeArtifactContentReviewReceipt?.taskFulfillment?.reviewerRevision).toBe('task-fulfillment-v1')
        expect(options.tools.map((tool) => tool.function.name)).toContain('start_process')
        previewReached = true
        throw new Error('Fixture boundary: ordinary preview, not visual acceptance')
      }
      const call = calls[cursor++]
      return { ...modelResult(''), content: '', finishReason: 'tool_calls', toolCalls: [{ id: call.id, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
    }
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute: async (call: ToolCallRecord) => {
      executed.push(call.id)
      if (call.name === 'read_file') return { content: JSON.stringify({ kind: 'text', content: html, hasMore: false }), isError: false }
      expect(['write_file', 'edit_file']).toContain(call.name)
      expect(call.arguments.path).toBe('report.html')
      if (call.name === 'edit_file') html = html.replace(String(call.arguments.old_text), String(call.arguments.new_text))
      await writeFile(resolve(store.workspaceDir(id), 'report.html'), html)
      return { content: JSON.stringify({ status: 'success', path: 'report.html', hash: hash(html), canonical_html: true }), isError: false }
    } } as never })
    const settle = async () => {
      for (let attempt = 0; attempt < 1000 && agent.isRunning(id); attempt++) await new Promise((done) => setTimeout(done, 5))
      expect(agent.isRunning(id)).toBe(false)
    }
    try {
      await agent.submit(id, { content: request })
      await settle()
      if (mode === 'repair') {
        const stored = await new SessionStore(root, 'offline-model').get(id)
        expect(stored.activeArtifactReviewRepair?.requirementIssues).toEqual([requirementIssue])
        expect(stored.activeArtifactContentReviewReceipt).toBeUndefined()
        await agent.resume(id)
        await settle()
      }
      const state = await store.get(id)
      const events = await store.events(id)
      const errors = JSON.stringify(events.filter((event) => event.type === 'error'))
      expect(previewReached, errors).toBe(mode === 'repair')
      expect(executed).toEqual(mode === 'repair' ? calls.map((call) => call.id) : ['write'])
      expect(events.filter((event) => event.type === 'assistant.final')).toEqual([])
      if (mode !== 'repair') {
        expect(reviews).toBe(2)
        expect(state.activeArtifactContentReviewReceipt).toBeUndefined()
        expect(state.activeArtifactReviewRepair).toBeUndefined()
        expect(errors).toContain(mode === 'missing-verdict' ? 'taskFulfillment required' : 'quote the original task')
      } else {
        expect(state.activeArtifactReviewRepair?.attempts).toBe(2)
        expect(state.activeArtifactContentReviewReceipt?.taskFulfillment).toBeDefined()
      }
      expect(await readFile(resolve(store.workspaceDir(id), 'report.html'), 'utf8')).toBe(html)
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  }, 10_000)
})
