import { describe, expect, it, vi } from 'vitest'
import { visualDeliveryReceipt, visualDeliveryHandoffOutcome } from './visual-delivery.js'
import { deliveryHandoffProjection, type DeliveryReceipt } from './delivery-receipt.js'
import { runVisualFinalReview, visualFinalReviewMessages } from './visual-final-review.js'

const snapshot = () => ({ artifact: { path: 'report.html', status: 'hash_verified', sha256: 'a'.repeat(43), sha256Encoding: 'base64url',
  sourceBytes: 1200, slideElementCount: 2, partialProjection: false, omittedSectionCount: 0, omittedLinkCount: 0,
  sections: [{ sourceSlide: 1, text: 'PRIVATE_BODY_FIRST', textTruncated: false }, { sourceSlide: 2, text: 'PRIVATE_BODY_SECOND', textTruncated: false }], sourceLinks: [] },
  researchPlan: { scope: 'Selected public reports.', limitations: ['Not exhaustive.'], omittedLimitationCount: 0,
    items: [{ id: 'r1', title: 'PRIVATE_MODEL_TITLE', sources: [{ url: 'https://example.org/article', role: 'reporting', excerpt: 'PRIVATE_SOURCE_BODY' }] }] } })
const request = (taskRequest = 'Create a file; in the final reply explain the findings in detail.') => ({ taskRequest,
  draft: 'PRIVATE_DRAFT', completionControl: 'Local preview and presentation completed.', deliveryContext: JSON.stringify(snapshot()) })
const response = (payload: unknown) => ({ content: JSON.stringify(payload), toolCalls: [], finishReason: 'stop' })

describe('delivery receipt and bounded content access', () => {
  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])('projects only completed evidence scopes while preserving detailed control on expansion (%s, %s)', (requiresResearch, hasStyleReference) => {
    const handoffOutcome = visualDeliveryHandoffOutcome({ requiresResearch, hasStyleReference })
    expect(handoffOutcome).toEqual({ kind: 'delivery_outcome', artifactDelivery: 'completed', availability: 'local',
      verification: [
        { scope: 'local rendering and navigation', outcome: 'pass' },
        ...(hasStyleReference ? [{ scope: 'source and rendered reference comparison', outcome: 'pass' }] : []),
        ...(requiresResearch ? [{ scope: 'source retrieval, not independent factual verification', outcome: 'performed' }] : []),
      ] })
    const input = { ...request(), completionControl: 'PRIVATE_AUDIT_TOOL_TRANSCRIPT', handoffOutcome }
    const narrow = JSON.parse(String(visualFinalReviewMessages(input)[1].content))
    expect(narrow.completionControl).toEqual(handoffOutcome)
    expect(JSON.stringify(narrow)).not.toContain('PRIVATE_AUDIT_TOOL_TRANSCRIPT')
    const full = JSON.parse(String(visualFinalReviewMessages(input, { includeContentEvidence: true })[1].content))
    expect(full.completionControl).toBe(input.completionControl)
    expect(input.handoffOutcome).toBe(handoffOutcome)
  })

  it('projects locations without rewriting internal identity or inferring outcomes from artifact types', () => {
    const receipt: DeliveryReceipt = { kind: 'delivery_receipt', artifacts: [
      { path: 'output/report.pdf', revision: 'pdf-revision', bytes: 1200, units: { count: 2, kind: 'pages' } },
      { path: 'src/parser.ts', revision: 'code-revision', bytes: 750 },
    ], evidenceLimitations: ['No public deployment is established.'], contentEvidenceAvailable: true }
    const before = JSON.stringify(receipt)
    const view = deliveryHandoffProjection(receipt)
    expect(view).toEqual({ kind: 'delivery_handoff', artifacts: [{ path: 'output/report.pdf' }, { path: 'src/parser.ts' }],
      evidenceScope: ['No public deployment is established.'], contentEvidenceAvailable: true })
    view.artifacts[0].path = 'changed'
    view.evidenceScope.push('changed')
    expect(JSON.stringify(receipt)).toBe(before)
  })

  it('reserves internal identity and link census for explicit evidence expansion, not default handoff', () => {
    const input = request('Include the exact checksum, file size and per-page citation audit in the final report.')
    const before = input.deliveryContext
    const narrow = JSON.parse(String(visualFinalReviewMessages(input)[1].content))
    expect(narrow.taskRequest).toBe(input.taskRequest)
    expect(narrow.deliveryReceipt).toMatchObject({ kind: 'delivery_handoff', artifacts: [{ path: 'report.html' }] })
    expect(narrow.deliveryReceipt.artifacts[0]).toEqual({ path: 'report.html' })
    expect(narrow.deliveryReceipt).not.toHaveProperty('modelDeclarations')
    expect(narrow).not.toHaveProperty('linkCoverage')
    expect(JSON.stringify(narrow)).not.toContain('a'.repeat(43))
    const full = JSON.parse(String(visualFinalReviewMessages(input, { includeContentEvidence: true })[1].content))
    expect(full.deliveryContext).toBe(before)
    expect(full.linkCoverage).toEqual({ slidesWithExternalLinks: [], slidesWithoutExternalLinks: [1, 2] })
    expect(visualDeliveryReceipt(before)?.artifacts[0]).toMatchObject({ bytes: 1200, revision: 'a'.repeat(43), units: { count: 2 } })
    expect(input.deliveryContext).toBe(before)
  })

  it('keeps identity separate from indexed model declarations without erasing the full evidence', () => {
    const data = snapshot()
    const original = JSON.stringify(data)
    const receipt = visualDeliveryReceipt(original)!
    expect(receipt).toMatchObject({ kind: 'delivery_receipt', artifacts: [{ path: 'report.html', bytes: 1200, revision: 'a'.repeat(43), units: { count: 2 } }],
      modelDeclarations: { origin: 'model', source: 'research_brief_scope', availableEntryCount: 2, omittedEntryCount: 0,
        disposition: 'not_revalidated_against_current_evidence', availableTextLocation: 'full_content_evidence' }, contentEvidenceAvailable: true })
    expect(receipt.modelDeclarations?.snapshotSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(receipt).not.toHaveProperty('reportedScope')
    expect(receipt).not.toHaveProperty('reportedLimitations')
    expect(JSON.stringify(receipt)).not.toContain('Not exhaustive.')
    expect(JSON.stringify(visualFinalReviewMessages({ ...request(), deliveryContext: original }, { includeContentEvidence: true }))).toContain('Not exhaustive.')
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_')
    expect(receipt.evidenceLimitations.join(' ')).toContain('not establish independent factual verification')
    expect(JSON.stringify(data)).toBe(original)
    data.artifact.partialProjection = true
    data.researchPlan.omittedLimitationCount = 1
    expect(visualDeliveryReceipt(JSON.stringify(data))?.evidenceLimitations).toHaveLength(4)
  })

  it.each(['missing_identity', 'unavailable', 'unknown_size', 'invalid_count', 'invalid_limits', 'missing_projection'] as const)('uses full evidence when a receipt cannot be safely projected: %s', (mode) => {
    const data: any = snapshot()
    if (mode === 'missing_identity') delete data.artifact.sha256
    if (mode === 'unavailable') data.artifact.status = 'unavailable'
    if (mode === 'unknown_size') data.artifact.sourceBytes = -1
    if (mode === 'invalid_count') data.artifact.slideElementCount = 0
    if (mode === 'invalid_limits') data.researchPlan.limitations = [null]
    if (mode === 'missing_projection') delete data.artifact.partialProjection
    const deliveryContext = JSON.stringify(data)
    expect(visualDeliveryReceipt(deliveryContext)).toBeUndefined()
    expect(JSON.parse(String(visualFinalReviewMessages({ ...request(), deliveryContext })[1].content)).deliveryContext).toBe(deliveryContext)
  })

  it('does not classify tasks or remove detailed user requirements; only the evidence view changes', () => {
    for (const task of ['Explain findings in detail after creating the report.', '创建详细的文件，最后简短交付。', 'Respond in JSON with the findings and limitations.']) {
      const input = request(task)
      const narrow = visualFinalReviewMessages(input)
      const full = visualFinalReviewMessages(input, { includeContentEvidence: true })
      const projected = JSON.parse(String(narrow[1].content))
      expect(projected.taskRequest).toBe(task)
      expect(projected.deliveryReceipt.contentEvidenceAvailable).toBe(true)
      expect(projected).not.toHaveProperty('deliveryContext')
      expect(JSON.stringify(narrow)).not.toContain('PRIVATE_')
      expect(JSON.stringify(full)).toContain('PRIVATE_SOURCE_BODY')
      expect(JSON.stringify(full)).toContain('Not exhaustive.')
      expect(JSON.stringify(full)).not.toContain('PRIVATE_DRAFT')
    }
  })

  it.each(['before', 'after'] as const)('allows one evidence expansion plus one protocol repair (%s expansion)', async (order) => {
    const input = request()
    const messages = visualFinalReviewMessages(input)
    const contentMessages = visualFinalReviewMessages(input, { includeContentEvidence: true })
    const invalid = response({ unexpected: 'PRIVATE_REJECTED_BODY' })
    const expand = response({ needsContentEvidence: true })
    const answers = order === 'before' ? [expand, invalid] : [invalid, expand]
    const call = vi.fn().mockResolvedValueOnce(answers[0]).mockResolvedValueOnce(answers[1]).mockResolvedValueOnce(response({ final: 'Detailed supported explanation.' }))
    const onProtocolRepair = vi.fn(async () => {})
    const onContentExpansion = vi.fn(async () => {})
    const result = await runVisualFinalReview({ ...input, messages, contentMessages, request: call, onProtocolRepair, onContentExpansion })
    expect(result.final).toBe('Detailed supported explanation.')
    expect(call).toHaveBeenCalledTimes(3)
    for (const args of call.mock.calls) expect(args[1]).toEqual({ responseFormat: { type: 'json_object' } })
    expect(onContentExpansion).toHaveBeenCalledOnce()
    expect(onProtocolRepair).toHaveBeenCalledOnce()
    expect(JSON.stringify(call.mock.calls[2][0])).toContain('PRIVATE_SOURCE_BODY')
    expect(JSON.stringify(call.mock.calls[2][0])).toContain('Not exhaustive.')
    expect(JSON.stringify(call.mock.calls)).not.toContain('PRIVATE_REJECTED_BODY')
  })

  it.each(['repeat', 'unavailable', 'already_full'] as const)('does not loop evidence requests: %s', async (mode) => {
    const input = request()
    const full = visualFinalReviewMessages(input, { includeContentEvidence: true })
    const messages = mode === 'already_full' ? full : visualFinalReviewMessages(input)
    const call = vi.fn().mockResolvedValue(response({ needsContentEvidence: true }))
    await expect(runVisualFinalReview({ ...input, messages, ...(mode !== 'unavailable' ? { contentMessages: full } : {}),
      request: call, onProtocolRepair: async () => {} })).rejects.toThrow('unavailable or already supplied')
    expect(call).toHaveBeenCalledTimes(mode === 'repeat' ? 2 : 1)
  })
})
