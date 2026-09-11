import { describe, expect, it } from 'vitest'
import { ModelStreamBudgetExceededError, type DeepSeekClient } from '../server/deepseek.js'
import { assertReviewProbeSource, collectVisualFinalReviewProbe } from './visual-final-review-probe.js'

const usage = { promptTokens: 4521, completionTokens: 4096, totalTokens: 8617, cachedPromptTokens: 0 }
const request = { messages: [], tools: [], toolChoice: 'none' as const, maxModelRequests: 1,
  maxOutputTokens: 4096, signal: new AbortController().signal }

describe('read-only Final review probe failure evidence', () => {
  const source = { target: 'artifact', status: 'failed', reportStatus: 'failed', path: 'report.html', reportPath: 'report.html',
    model: 'test-model', requiredModel: 'test-model', presented: false, missingPhases: ['browser_open', 'present_file'] }
  it.each(['completed', 'failed', 'cancelled', 'timed_out'])('admits a hash-checkable terminal %s artifact without claiming delivery', (status) => {
    expect(() => assertReviewProbeSource({ ...source, status, reportStatus: status })).not.toThrow()
  })
  it.each([
    { status: 'running', reportStatus: 'running' }, { reportStatus: 'completed' }, { path: undefined },
    { reportPath: 'other.html' }, { model: 'another-model' }, { target: 'unknown' }, { target: 'handoff' },
    { target: 'handoff', status: 'completed', reportStatus: 'completed' },
    { target: 'handoff', status: 'completed', reportStatus: 'completed', presented: true },
  ])('rejects live, mismatched, or unpresented handoff sources: %j', (change) => {
    expect(() => assertReviewProbeSource({ ...source, ...change })).toThrow()
  })
  it('keeps handoff diagnosis behind completed presentation and verification', () => {
    expect(() => assertReviewProbeSource({ ...source, target: 'handoff', status: 'completed', reportStatus: 'completed',
      presented: true, missingPhases: [] })).not.toThrow()
  })
  it('does not call valid JSON an admitted Final when it still contradicts a source qualification', async () => {
    const context = JSON.stringify({ researchPlan: { items: [{ id: 'n1', sources: [{ url: 'https://example.org/article', role: 'reporting',
      excerpt: '《夏日手记》将于9月7日发行。' }] }] } })
    const draft = '已交付，覆盖新专辑《夏日手记》发行。'
    const report = await collectVisualFinalReviewProbe(async () => ({ content: JSON.stringify({ final: draft, corrections: [] }),
      reasoningContent: '', finishReason: 'stop', toolCalls: [], usage, modelCallCount: 1, modelRequestCount: 1 }), request, draft, context)
    expect(report.protocolPassed).toBe(false)
    expect(report.remainingEvidenceIssues).toContainEqual(expect.objectContaining({ code: 'planned_event_status' }))
    expect(report.usage).toEqual(usage)
  })
  it('retains authoritative length-boundary usage without rejected model text', async () => {
    const stream: DeepSeekClient['stream'] = async (options) => {
      options.onReasoning('PRIVATE_REASONING')
      options.onContent('PRIVATE_PARTIAL_JSON')
      options.onTransportEvent?.({ type: 'response', requestIndex: 1, continuation: 'none', toolNames: [], omittedToolCount: 0,
        finishReason: 'length', contentBytes: 21, reasoningBytes: 17, usage })
      throw Object.assign(new ModelStreamBudgetExceededError('model_requests', 1, 1), {
        modelUsage: { ...usage, extra: 'PRIVATE_ERROR_BODY' }, modelCallCount: 1, modelRequestCount: 1,
      })
    }
    const report = await collectVisualFinalReviewProbe(stream, request, 'draft', '')
    expect(report).toMatchObject({ protocolPassed: false, usage, modelCallCount: 1, modelRequestCount: 1,
      failure: { stage: 'model', code: 'model_stream_budget_exceeded', budget: 'model_requests', used: 1, limit: 1 } })
    expect(report.transport).toHaveLength(1)
    expect(JSON.stringify(report)).not.toContain('PRIVATE_')
  })

  it('retains completed usage when the review protocol is invalid', async () => {
    const report = await collectVisualFinalReviewProbe(async () => ({ content: 'PRIVATE_INVALID_JSON', reasoningContent: 'PRIVATE_REASONING',
      finishReason: 'stop', toolCalls: [], usage, modelCallCount: 1, modelRequestCount: 1 }), request, 'draft', '')
    expect(report).toMatchObject({ protocolPassed: false, failure: { stage: 'protocol', code: 'invalid_review' }, usage, modelCallCount: 1 })
    expect(JSON.stringify(report)).not.toContain('PRIVATE_')
  })

  it('does not invent authoritative usage for an unmetered provider failure', async () => {
    const report = await collectVisualFinalReviewProbe(async () => { throw new Error('PRIVATE_PROVIDER_BODY') }, request, 'draft', '')
    expect(report).toMatchObject({ protocolPassed: false, failure: { stage: 'model', code: 'provider_failure' } })
    expect(report.usage).toBeUndefined()
    expect(JSON.stringify(report)).not.toContain('PRIVATE_')
  })

  it('returns an admitted review with actual request limits unchanged', async () => {
    const report = await collectVisualFinalReviewProbe(async (options) => {
      expect(options.maxModelRequests).toBe(1)
      expect(options.maxOutputTokens).toBe(4096)
      return { content: JSON.stringify({ final: 'draft', corrections: [] }), reasoningContent: '', finishReason: 'stop',
        toolCalls: [], usage, modelCallCount: 1, modelRequestCount: 1 }
    }, request, 'draft', '')
    expect(report).toMatchObject({ protocolPassed: true, review: { final: 'draft', corrections: [] }, usage })
  })
})
