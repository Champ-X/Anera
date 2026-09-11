import { describe, expect, it } from 'vitest'
import { compactResearchEvidence, resolvedResearchEvidenceItems } from './research-evidence-projection.js'
import { artifactContentReviewReceiptMatches, createArtifactContentReviewReceipt, parseArtifactReviewIssues } from './visual-artifact-review.js'
import { visualArtifactClaimIssues, visualArtifactReviewMessages } from './visual-final-review.js'

const source = { url: 'https://example.org/source', role: 'reporting', snapshotSha256: 'a'.repeat(64),
  excerpt: '初期阶段已经结束，后续工作尚未完成。跨城观演占比超57.1%。' + '完整引文。'.repeat(200), excerptBytes: 3200 }
const original = () => ({ researchPlan: { sha256: 'b'.repeat(64), omittedExcerptCount: 0,
  items: ['a', 'b'].map((id) => ({ id, sources: [{ ...source }] })) }, artifact: {
  path: 'report.html', status: 'hash_verified', sha256: 'a'.repeat(43),
  sections: [{ sourceSlide: 1, text: '跨城观演占比为57.1%。', textTruncated: false }] } })

describe('research evidence wire codec', () => {
  it('round-trips every source association and preserves original input and compact identity', () => {
    const input = original()
    const before = JSON.stringify(input)
    const packed = compactResearchEvidence(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThan(Buffer.byteLength(before))
    expect(packed.researchPlan.items[1].sources[0]).toMatchObject({ excerptRef: 0, role: 'reporting' })
    expect(resolvedResearchEvidenceItems(packed.researchPlan)).toEqual(input.researchPlan.items)
    expect(compactResearchEvidence(packed)).toBe(packed)
  })
  it('preserves missing-excerpt markers and legacy inline sources', () => {
    const input: any = original()
    input.researchPlan.omittedExcerptCount = 2
    for (const item of input.researchPlan.items) delete item.sources[0].excerpt
    const packed = compactResearchEvidence(input)
    expect(resolvedResearchEvidenceItems(packed.researchPlan)).toEqual(input.researchPlan.items)
    expect(packed.researchPlan.omittedExcerptCount).toBe(2)
    const legacy: any = original()
    for (const item of legacy.researchPlan.items) delete item.sources[0].snapshotSha256
    expect(compactResearchEvidence(legacy)).toEqual(legacy)
    expect(resolvedResearchEvidenceItems(legacy.researchPlan)).toEqual(legacy.researchPlan.items)
  })
  it('keeps tiny repeated records inline when a pool would grow the request', () => {
    const input = { researchPlan: { items: ['a', 'b'].map((id) => ({ id, sources: [{ url: 'a', role: 'r',
      snapshotSha256: 'a'.repeat(64), excerpt: '' }] })) } }
    const packed = compactResearchEvidence(input)
    expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThanOrEqual(Buffer.byteLength(JSON.stringify(input)))
    expect(resolvedResearchEvidenceItems(packed.researchPlan)).toEqual(input.researchPlan.items)
  })
  it('uses pooled source words for exact issue grounding and deterministic checks', () => {
    const input = original()
    // One identified item with repeated provenance: two separate item IDs
    // intentionally make the numeric checker abstain on ambiguous ownership.
    input.researchPlan.items = [{ id: 'a', sources: [{ ...source }, { ...source }] }]
    const packed = JSON.stringify(compactResearchEvidence(input))
    const issue = { sourceSlide: 1, claim: '跨城观演占比为57.1%', reason: 'Preserve the lower bound.',
      sourceUrl: source.url, sourceQuote: '跨城观演占比超57.1%' }
    expect(parseArtifactReviewIssues([issue], packed)).toEqual([issue])
    expect(() => parseArtifactReviewIssues([{ ...issue, sourceUrl: 'https://other.example/source' }], packed)).toThrow()
    expect(visualArtifactClaimIssues(packed)).toEqual(visualArtifactClaimIssues(JSON.stringify(input)))
    expect(visualArtifactClaimIssues(packed).length).toBeGreaterThan(0)
  })
  it('keeps model input compact while source generation changes invalidate the persisted receipt', () => {
    const input = original()
    const context = JSON.stringify(compactResearchEvidence(input))
    const messages = visualArtifactReviewMessages({ taskRequest: 'Review observations', deliveryContext: context })
    const sent = JSON.parse(String(messages[1].content)).deliveryContext
    expect(sent).toBe(context)
    expect(sent.split(source.excerpt)).toHaveLength(2)
    const receipt = createArtifactContentReviewReceipt(context, 'Review observations', { artifactIssues: [] })
    expect(artifactContentReviewReceiptMatches(JSON.parse(JSON.stringify(receipt)), context, 'Review observations')).toBe(true)
    for (const item of input.researchPlan.items) item.sources[0].snapshotSha256 = 'c'.repeat(64)
    const changed = JSON.stringify(compactResearchEvidence(input))
    expect(artifactContentReviewReceiptMatches(receipt, changed, 'Review observations')).toBe(false)
  })
  it.each(['dangling', 'negative', 'conflicting', 'ambiguous', 'corrupt', 'oversized_items'] as const)('does not approve %s pool evidence even with an empty verdict', (mode) => {
    const packed: any = compactResearchEvidence(original())
    const ref = packed.researchPlan.items[0].sources[0]
    if (mode === 'dangling') ref.excerptRef = 50
    if (mode === 'negative') ref.excerptRef = -1
    if (mode === 'conflicting') ref.url = 'https://wrong.example'
    if (mode === 'ambiguous') ref.excerpt = 'Model substitution'
    if (mode === 'corrupt') packed.researchPlan.sharedExcerpts[0].text = 'Changed'
    if (mode === 'oversized_items') packed.researchPlan.items = Array(17).fill(packed.researchPlan.items[0])
    expect(() => createArtifactContentReviewReceipt(JSON.stringify(packed), 'Review the report', { artifactIssues: [] })).toThrow()
  })
})
