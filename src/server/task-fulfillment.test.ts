import { describe, expect, it } from 'vitest'
import { createTaskFulfillmentReceipt, parseTaskFulfillmentAssessment, taskFulfillmentReceiptMatches, taskRequirementProgressKeys,
  TASK_FULFILLMENT_POLICY, type TaskRequirementIssue } from './task-fulfillment.js'
import { systemPromptForTools } from './agent-service.js'
import { visualArtifactReviewMessages, parseVisualFinalReview, runVisualFinalReview } from './visual-final-review.js'
import { createArtifactContentReviewReceipt, artifactContentReviewReceiptMatches, createArtifactReviewRepair,
  artifactReviewRepairGap, artifactReviewProgressIdentity, artifactReviewRepairExhaustion } from './visual-artifact-review.js'

const context = JSON.stringify({ artifact: { status: 'hash_verified', path: 'report.html', sha256: 'a'.repeat(43),
  sourceBytes: 100, sections: [{ sourceSlide: 1, text: 'A selected subset.', textTruncated: false }] }, researchPlan: { items: [] } })
const satisfied = { status: 'satisfied', issues: [] }
const request = 'Include risks and mitigations in the report.'
const issue: TaskRequirementIssue = { requirement: 'risks and mitigations', status: 'unmet', reason: 'Only the sequence is present; required risk analysis is absent.' }
const pending = { status: 'needs_work', issues: [issue] }
const result = (payload: unknown) => ({ content: JSON.stringify(payload), finishReason: 'stop', toolCalls: [] })

describe('request-bound task fulfillment', () => {
  it.each([
    ['code', 'Keep unknown keys and reject fractional quantities.', 'reject fractional quantities'],
    ['data', 'Reconcile both ledgers in EUR without rounding source values.', 'both ledgers'],
    ['document', request, 'risks and mitigations'],
    ['research', 'Compare public reports from the requested interval.', 'requested interval'],
  ])('represents missing %s work without inventing an artifact claim', (_, task, requirement) => {
    const assessment = { status: 'needs_work', issues: [{ ...issue, requirement }] }
    expect(parseTaskFulfillmentAssessment(assessment, task)).toEqual(assessment)
    expect(() => createTaskFulfillmentReceipt(assessment, task, task, context)).toThrow('unresolved requirements')
  })

  it.each([undefined, {}, { status: 'satisfied' }, { status: 'satisfied', issues: [issue] },
    { status: 'needs_work', issues: [] }, { ...pending, final: 'done' },
    { status: 'needs_work', issues: [{ ...issue, requirement: 'Invented requirement' }] },
    { status: 'needs_work', issues: [{ ...issue, status: 'waived' }] },
    { status: 'needs_work', issues: [{ ...issue, reason: '' }] },
    { status: 'needs_work', issues: Array(7).fill(issue) },
  ])('rejects missing, contradictory, or ungrounded assessments: %j', (value) => {
    expect(() => parseTaskFulfillmentAssessment(value, request)).toThrow('Task fulfillment review:')
  })

  it('binds a distinct completion receipt to task and evidence versions', () => {
    const receipt = createTaskFulfillmentReceipt(satisfied, request, 'task with temporal anchor', context)
    expect(taskFulfillmentReceiptMatches(JSON.parse(JSON.stringify(receipt)), 'task with temporal anchor', context)).toBe(true)
    expect(taskFulfillmentReceiptMatches(receipt, request, context)).toBe(false)
    expect(taskFulfillmentReceiptMatches(receipt, 'task with temporal anchor', context + 'changed')).toBe(false)
    expect(taskFulfillmentReceiptMatches({ ...receipt, reviewerRevision: 'legacy' } as never, 'task with temporal anchor', context)).toBe(false)
    const factualOnly = createArtifactContentReviewReceipt(context, request, { artifactIssues: [] })
    expect(artifactContentReviewReceiptMatches(factualOnly, context, request)).toBe(true)
    expect(artifactContentReviewReceiptMatches(factualOnly, context, request, true)).toBe(false)
    const combined = createArtifactContentReviewReceipt(context, request, { artifactIssues: [] }, { assessment: satisfied, taskRequest: request })
    expect(artifactContentReviewReceiptMatches(combined, context, request, true)).toBe(true)
    expect(() => createArtifactContentReviewReceipt(context, request, { artifactIssues: [] }, { assessment: pending, taskRequest: request })).toThrow()
  })

  it('persists omissions and treats a changed disclaimer as evidence to recheck, not completion or novel requirements', () => {
    let repair = createArtifactReviewRepair(context, request, [], undefined, { taskRequest: request, issues: [issue] })
    expect(artifactReviewRepairGap(JSON.parse(JSON.stringify(repair)), context, request)).toContain('missing work/evidence')
    const identity = artifactReviewProgressIdentity(repair)
    expect(taskRequirementProgressKeys([issue, { ...issue, requirement: ' risks  and mitigations ' }])).toEqual(['risks and mitigations'])
    const changed = context.replace('A selected subset.', 'This is only a limited selection.')
    expect(artifactReviewRepairGap(repair, changed, request)).toBeUndefined()
    for (let i = 0; i < 3; i++) repair = createArtifactReviewRepair(changed, request, [], repair,
      { taskRequest: request, issues: [{ ...issue, status: 'unverified', reason: `Changed explanation ${i}` }] })
    expect(artifactReviewProgressIdentity(repair)).toBe(identity)
    expect(artifactReviewRepairExhaustion(repair)).toBeDefined()
    expect(() => artifactReviewRepairGap(repair, changed, request)).toThrow('exhausted')
    expect(artifactReviewRepairGap(repair, changed, 'A new user task')).toBeUndefined()
  })

  it('uses the same contract for general planning and independent review', () => {
    expect(systemPromptForTools([], { includeHarnessConvergence: true })).toContain(TASK_FULFILLMENT_POLICY)
    const messages = visualArtifactReviewMessages({ taskRequest: request, deliveryContext: context })
    expect(messages[0].content).toContain(TASK_FULFILLMENT_POLICY)
    expect(messages[0].content).toContain('pre-render CONTENT gate')
    expect(JSON.parse(String(messages[1].content)).taskRequest).toBe(request)
    expect(parseVisualFinalReview(result({ artifactIssues: [], taskFulfillment: pending }), '', context, true, request))
      .toMatchObject({ artifactIssues: [], taskFulfillment: pending, final: '' })
    expect(parseVisualFinalReview(result({ artifactIssues: [], taskFulfillment: pending }), '', context, false, request))
      .toMatchObject({ artifactIssues: [], taskFulfillment: pending, final: '' })
    expect(() => parseVisualFinalReview(result({ artifactIssues: [], taskFulfillment: satisfied }), '', context, false, request))
      .toThrow('handoff repair has no unresolved issues')
    expect(() => parseVisualFinalReview(result({ artifactIssues: [] }), '', context, true, request)).toThrow('taskFulfillment required')
  })

  it.each([
    [{ artifactIssues: [] }, 'taskFulfillment required (missing)'],
    [{ artifactIssues: [], taskFulfillment: satisfied, PRIVATE_FIELD: 'PRIVATE_RESPONSE' }, 'unexpected top-level fields: 1'],
    [{ artifactIssues: [], taskFulfillment: null }, 'taskFulfillment must be object; received null'],
  ])('repairs an envelope with actionable safe diagnostics and unchanged evidence: %j', async (payload, diagnostic) => {
    const messages = visualArtifactReviewMessages({ taskRequest: request, deliveryContext: context })
    const original = JSON.stringify(messages)
    let calls = 0
    const diagnostics: string[] = []
    const review = await runVisualFinalReview({ artifactOnly: true, taskRequest: request, deliveryContext: context, messages,
      request: async (current, contract) => {
        calls++
        expect(contract.responseFormat).toEqual({ type: 'json_object' })
        if (calls === 2) {
          expect(current.slice(0, messages.length)).toEqual(messages)
          expect(current.at(-1)?.content).toContain(diagnostic)
          // The exact closed schema is shared, not independently reworded.
          for (const field of ['"required":["artifactIssues","taskFulfillment"]', '"additionalProperties":false']) {
            expect(current[0].content).toContain(field)
            expect(current.at(-1)?.content).toContain(field)
          }
          expect(JSON.stringify(current)).not.toContain('PRIVATE_')
        }
        return { ...result(calls === 1 ? payload : { artifactIssues: [], taskFulfillment: pending }),
          reasoningContent: '', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 } }
      }, onProtocolRepair: async (value) => { diagnostics.push(value) } })
    expect(calls).toBe(2)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain(diagnostic)
    expect(review.taskFulfillment).toEqual(pending)
    expect(JSON.stringify(messages)).toBe(original)
  })

  it('does not buy a format retry when required evidence was never supplied by the caller', async () => {
    let calls = 0
    const diagnostics: string[] = []
    await expect(runVisualFinalReview({ artifactOnly: true, taskRequest: request, deliveryContext: undefined as never,
      messages: visualArtifactReviewMessages({ taskRequest: request, deliveryContext: context }),
      request: async () => { calls++; return { ...result({ artifactIssues: [], taskFulfillment: satisfied }),
        reasoningContent: '', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 } } },
      onProtocolRepair: async (value) => { diagnostics.push(value) },
    })).rejects.toThrow('requires artifact evidence')
    expect(calls).toBe(1)
    expect(diagnostics).toEqual([])
  })

  it('allows one safe protocol repair but never upgrades a missing verdict to satisfied', async () => {
    const diagnostics: string[] = []
    let calls = 0
    const review = await runVisualFinalReview({ artifactOnly: true, taskRequest: request, deliveryContext: context,
      messages: visualArtifactReviewMessages({ taskRequest: request, deliveryContext: context }),
      request: async (messages) => {
        calls++
        if (calls === 2) {
          expect(messages.at(-1)?.content).toContain('taskFulfillment')
          expect(JSON.stringify(messages)).not.toContain('UNTRUSTED_FAKE_REQUIREMENT')
        }
        return { ...result({ artifactIssues: [], taskFulfillment: calls === 1
          ? { status: 'needs_work', issues: [{ ...issue, requirement: 'UNTRUSTED_FAKE_REQUIREMENT' }] } : pending }),
          reasoningContent: '', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 } }
      }, onProtocolRepair: async (diagnostic) => { diagnostics.push(diagnostic) } })
    expect(calls).toBe(2)
    expect(diagnostics).toEqual(['Task fulfillment review: requirement must quote the original task'])
    expect(review.taskFulfillment).toEqual(pending)
  })
})
