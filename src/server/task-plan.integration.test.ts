import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentService, normalizedDurableResearchEvidence, recoverActiveTaskResearchEvidence, recoverActiveTaskRequestText,
  recoverActiveTaskTemporalControl, visualWebArtifactCompletionGap } from './agent-service.js'
import { createResearchBrief } from './research-brief.js'
import { taskScopeIdentity } from './task-context.js'
import { createTaskPlanBinding, taskPlanBindingMatches } from './task-plan.js'
import { taskPlanBindingFixture } from './test-support/task-plan-fixture.js'
import { SessionStore } from './session-store.js'
import type { DeepSeekClient } from './deepseek.js'
import type { ToolCallRecord } from '../shared/types.js'

const result = (content: string) => ({ content, reasoningContent: '', finishReason: 'stop', toolCalls: [],
  usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 }, modelCallCount: 1 })

describe('AgentService plan scope recovery', () => {
  it.each(['missing', 'different-task', 'different-plan', 'current'] as const)('handles %s bindings without discarding sources or trusting model metadata', async (mode) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-task-plan-'))
    const store = new SessionStore(root, 'offline-model')
    await store.initialize()
    const id = (await store.create()).summary.id
    const request = 'Research the recent public storage specifications and create HTML Slides with cited findings.'
    const url = 'https://reports.example.org/spec'
    const content = 'The proposed storage protocol is under review. It has not yet been released.'
    const source = { url, requestedUrl: url, title: 'Protocol report', content, sha256: createHash('sha256').update(content).digest('hex') }
    const args = { scope: 'Storage protocol findings', limitations: [], items: [{ title: 'Protocol proposal', summary: content,
      date_note: 'Publication date unconfirmed.', sources: [{ url, role: 'reporting', quality_note: 'Attributed report.', excerpt: content }] }] }
    const brief = createResearchBrief(args, [source])
    await store.append(id, 'turn.started', { content: request, requestReceivedAt: '2026-09-07T08:00:00.000Z', timezone: 'Asia/Shanghai' }, { turnId: 'source-task' })
    const binding = await taskPlanBindingFixture(store, id, brief.sha256)
    const append = async (call: ToolCallRecord, payload: unknown, metadata: Record<string, unknown> = {}) => {
      await store.append(id, 'tool.completed', { call, result: JSON.stringify(payload), isError: false, ...metadata }, { turnId: 'source-task' })
      await store.update(id, (state) => { state.messages.push(
        { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
        { role: 'tool', tool_call_id: call.id, content: JSON.stringify(payload), tool_result_status: 'succeeded' }) })
    }
    await store.update(id, (state) => { state.messages = [{ role: 'user', content: request }]; state.summary.status = 'failed' })
    await append({ id: 'source-read', name: 'fetch_page', arguments: { url } }, { status: 'success', url, content, snapshot_sha256: source.sha256 })
    await append({ id: 'old-plan', name: 'record_research_brief', arguments: args }, {
      status: 'success', brief,
      // This model-visible result field must not be promoted to provenance.
      taskPlanBinding: binding,
    }, mode === 'missing' ? {} : { taskPlanBinding: mode === 'different-task'
      ? createTaskPlanBinding('a different original scope', brief.sha256) : mode === 'different-plan' ? { ...binding, planSha256: 'a'.repeat(64) } : binding })
    const taskEvents = await store.events(id)
    const identity = taskScopeIdentity(recoverActiveTaskRequestText(taskEvents)!, recoverActiveTaskTemporalControl(taskEvents, 'UTC'))
    const recovered = recoverActiveTaskResearchEvidence(taskEvents)
    const effective = normalizedDurableResearchEvidence(recovered, identity)
    expect(effective.sourceUrls).toEqual([url])
    expect(effective.pageReads).toEqual(recovered.pageReads)
    expect(effective.brief !== undefined).toBe(mode === 'current')
    expect(recovered.brief?.sha256).toBe(brief.sha256) // History retained even when unsuitable.
    const messages = (await store.get(id)).messages
    const legacyGap = visualWebArtifactCompletionGap(messages, { forceTask: true, requiresResearch: true, requireResearchBrief: true })
    expect(legacyGap?.missingPhases).not.toContain('web_research')
    const currentGap = visualWebArtifactCompletionGap(messages, { forceTask: true, requiresResearch: true, requireResearchBrief: true,
      researchPageReads: effective.pageReads, researchSourceUrls: effective.sourceUrls, researchBrief: effective.brief, researchBriefAuthoritative: true })
    expect(currentGap?.missingPhases.includes('web_research')).toBe(mode !== 'current')
    let calls = 0
    let observedAuthoring = 0
    const executed: string[] = []
    const stream: DeepSeekClient['stream'] = async (options) => {
      calls++
      const names = options.tools.map((tool) => tool.function.name)
      if (mode !== 'current' && calls === 1) {
        expect(names.sort()).toEqual(['fetch_page', 'web_search', 'web_fetch', 'record_research_brief'].sort())
        expect(options.messages[0].content).toContain('no matching server binding')
        expect(JSON.stringify(options.messages)).toContain(content)
        expect(JSON.stringify(options.messages)).toContain('2026-09-07')
        return { ...result(''), finishReason: 'tool_calls', toolCalls: [{ id: 'reassessed-plan', type: 'function',
          function: { name: 'record_research_brief', arguments: JSON.stringify(args) } }] }
      }
      expect(names).toContain('write_file')
      expect(options.messages[0].content).not.toContain('no matching server binding')
      const state = await store.get(id)
      expect(taskPlanBindingMatches(state.activeTaskResearchEvidence?.briefTaskBinding, identity, brief.sha256)).toBe(true)
      observedAuthoring++
      throw new Error('Fixture stops before authoring; no semantic or visual acceptance claimed')
    }
    const agent = new AgentService(store, { client: { stream } as never, now: () => new Date('2026-09-10T08:00:00Z'),
      tools: { execute: async (call: ToolCallRecord) => {
        executed.push(call.name)
        expect(call.name).toBe('record_research_brief')
        return { content: JSON.stringify({ status: 'success', brief: createResearchBrief(call.arguments, [source]) }), isError: false }
      } } as never })
    const settle = async () => { for (let n = 0; n < 1000 && agent.isRunning(id); n++) await new Promise((done) => setTimeout(done, 5)); expect(agent.isRunning(id)).toBe(false) }
    try {
      await agent.resume(id)
      await settle()
      expect(observedAuthoring, JSON.stringify((await store.events(id)).filter((event) => event.type === 'error'))).toBe(1)
      expect(executed).toEqual(mode === 'current' ? [] : ['record_research_brief'])
      if (mode !== 'current') {
        const event = (await store.events(id)).find((event) => event.type === 'tool.completed' && event.callId === 'reassessed-plan')!
        expect(taskPlanBindingMatches(event.data.taskPlanBinding, identity, brief.sha256)).toBe(true)
        expect(JSON.parse(String(event.data.result))).not.toHaveProperty('taskPlanBinding')
      }
      // Simulate lost state projection and a checkpoint omitting the task.
      // The terminal event's original binding, not today's clock, recovers it.
      await store.update(id, (state) => { delete state.activeTaskResearchEvidence
        state.messages = [{ role: 'user', content: 'Historical checkpoint only.' }]; state.timezone = 'America/Los_Angeles' })
      await agent.resume(id)
      await settle()
      expect(observedAuthoring).toBe(2)
      expect(executed).toEqual(mode === 'current' ? [] : ['record_research_brief'])
      await agent.submit(id, { content: 'Continue' })
      await settle()
      expect(observedAuthoring).toBe(3)
      expect(executed).toEqual(mode === 'current' ? [] : ['record_research_brief'])
      expect((await store.events(id)).filter((event) => event.type === 'tool.completed' && (event.data.call as ToolCallRecord).name === 'fetch_page')).toHaveLength(1)
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  }, 10_000)
})
