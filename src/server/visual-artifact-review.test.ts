import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { artifactContentReviewReceiptMatches, createArtifactContentReviewReceipt, artifactReviewProgressIdentity, artifactReviewRepairExhaustion, artifactReviewRepairGap, createArtifactReviewRepair, parseArtifactReviewIssues, parseArtifactReviewVerdict, type ArtifactReviewIssue } from './visual-artifact-review.js'
import { parseVisualFinalReview, runVisualFinalReview } from './visual-final-review.js'

const task = 'Create a source-grounded report for the requested period.'
const digest = (value: string) => createHash('sha256').update(value).digest('base64url')
const projected = () => ({ artifact: { status: 'hash_verified', path: 'report.html', sha256: digest('original CSS'),
  sourceBytes: 200, slideElementCount: 2, sections: [
    { sourceSlide: 1, text: 'All events occurred this week.', textTruncated: false },
    { sourceSlide: 2, text: 'The project is complete.', textTruncated: false },
  ], sourceLinks: [{ sourceSlide: 2, href: 'https://example.org/report', label: 'Source', labelTruncated: false }],
  omittedSectionCount: 0, omittedLinkCount: 0, partialProjection: false }, researchPlan: { sha256: 'brief-v1',
  items: [{ id: 'n1', sources: [{ role: 'reporting', url: 'https://example.org/report', excerpt: 'The project has completed its first stage; further work remains.' }] }] } })
const context = () => 'Untrusted source data\n' + JSON.stringify(projected())
const issue: ArtifactReviewIssue = { sourceSlide: 2, claim: 'The project is complete.',
  reason: 'Distinguish the completed stage from the entire project.', sourceUrl: 'https://example.org/report',
  sourceQuote: 'The project has completed its first stage; further work remains.' }

describe('source-bound artifact review feedback', () => {
  it('tracks changed located review claims across persistence without treating a review as approval', () => {
    const repair = createArtifactReviewRepair(context(), task, [issue])
    const identity = artifactReviewProgressIdentity(repair)
    expect(identity).toMatch(/^[a-f0-9]{64}$/)
    expect(artifactReviewProgressIdentity(JSON.parse(JSON.stringify(repair)))).toBe(identity)
    expect(artifactReviewProgressIdentity(undefined)).toBeUndefined()
    for (const change of [
      { taskSha256: 'a'.repeat(64) }, { path: 'another.html' },
      { issues: [{ ...issue, sourceSlide: 1 }] }, { issues: [{ ...issue, claim: 'Another claim' }] },
    ]) expect(artifactReviewProgressIdentity({ ...repair, ...change })).not.toBe(identity)
    expect(artifactReviewRepairGap(repair, context(), task)).toContain(issue.claim)
  })
  it.each(['artifact', 'content', 'counter', 'reason', 'citation', 'whitespace', 'duplicates'] as const)('does not buy liveness progress with %s churn', (change) => {
    const repair = createArtifactReviewRepair(context(), task, [issue])
    const changed = structuredClone(repair)
    if (change === 'artifact') changed.artifactHash = digest('CSS-only update')
    if (change === 'content') changed.contentSha256 = 'b'.repeat(64)
    if (change === 'counter') changed.attempts = 2
    if (change === 'reason') changed.issues[0].reason = 'A different explanation of the same issue'
    if (change === 'citation') { changed.issues[0].sourceUrl += '?new'; changed.issues[0].sourceQuote = 'Another explanation source' }
    if (change === 'whitespace') changed.issues[0].claim = ' The project   is complete.\n'
    if (change === 'duplicates') changed.issues.push({ ...issue })
    expect(artifactReviewProgressIdentity(changed)).toBe(artifactReviewProgressIdentity(repair))
  })
  it('ignores issue order but distinguishes a resolved subset and rejects malformed state', () => {
    const second = { sourceSlide: 1, claim: 'All events occurred this week.', reason: 'The scope is unsupported.' }
    const repair = createArtifactReviewRepair(context(), task, [issue, second])
    expect(artifactReviewProgressIdentity({ ...repair, issues: [...repair.issues].reverse() })).toBe(artifactReviewProgressIdentity(repair))
    expect(artifactReviewProgressIdentity({ ...repair, issues: [issue] })).not.toBe(artifactReviewProgressIdentity(repair))
    expect(() => artifactReviewProgressIdentity({ ...repair, issues: [] })).toThrow()
    expect(() => artifactReviewProgressIdentity({ ...repair, issues: [{ ...issue, claim: undefined }] } as never)).toThrow()
  })
  it('reuses an explicit verdict after serialization, not an implicit or issue-bearing response', () => {
    const receipt = createArtifactContentReviewReceipt(context(), task, { artifactIssues: [] })
    expect(artifactContentReviewReceiptMatches(JSON.parse(JSON.stringify(receipt)), context(), task)).toBe(true)
    expect(artifactContentReviewReceiptMatches(undefined, context(), task)).toBe(false)
    expect(artifactContentReviewReceiptMatches({ ...receipt, reviewerRevision: 'older' } as never, context(), task)).toBe(false)
    expect(() => createArtifactContentReviewReceipt(context(), task, {})).toThrow()
    expect(() => createArtifactContentReviewReceipt(context(), task, { artifactIssues: [issue] })).toThrow('unresolved')
    expect(() => artifactContentReviewReceiptMatches(receipt, '{}', task)).toThrow()
  })
  it.each(['text', 'link', 'source', 'path', 'task', 'bytes', 'projection'] as const)('invalidates a clean review receipt after a %s change', (change) => {
    const value = projected()
    const original = JSON.stringify(value)
    const receipt = createArtifactContentReviewReceipt(original, task, { artifactIssues: [] })
    if (change === 'text') value.artifact.sections[0].text = 'Changed report'
    if (change === 'link') value.artifact.sourceLinks[0].href += '?new'
    if (change === 'source') value.researchPlan.sha256 = 'different'
    if (change === 'path') value.artifact.path = 'different.html'
    if (change === 'bytes') value.artifact.sha256 = digest('CSS or unprojected text changed')
    if (change === 'projection') value.artifact.partialProjection = true
    expect(artifactContentReviewReceiptMatches(receipt, JSON.stringify(value), change === 'task' ? task + ' New scope' : task)).toBe(false)
  })
  it('requires an explicit evidence-bound artifact verdict, never a handoff substitute', () => {
    expect(parseArtifactReviewVerdict({ artifactIssues: [] }, context())).toEqual([])
    expect(parseVisualFinalReview({ content: '{"artifactIssues":[]}', finishReason: 'stop', toolCalls: [] }, '', context(), true).artifactIssues).toEqual([])
    expect(() => parseArtifactReviewVerdict({ artifactIssues: [] }, '{}')).toThrow()
    expect(() => parseArtifactReviewVerdict({ final: 'Done', corrections: [] }, context())).toThrow('artifactIssues-only')
    expect(() => parseArtifactReviewVerdict({ artifactIssues: [], final: 'Done' }, context())).toThrow('artifactIssues-only')
  })
  it('reports a safe field-level quote diagnostic and allows one grounded protocol correction', async () => {
    const messages = [{ role: 'user' as const, content: 'private fixture evidence' }]
    const diagnostics: string[] = []
    let calls = 0
    const review = await runVisualFinalReview({ messages, draft: 'private draft', deliveryContext: context(),
      request: async (current) => {
        calls += 1
        if (calls === 2) {
          expect(String(current.at(-1)?.content)).toContain('claim is not an exact quote')
          expect(JSON.stringify(current)).not.toContain('PRIVATE_MISQUOTATION')
        }
        return { content: JSON.stringify({ artifactIssues: [{ ...issue, claim: calls === 1 ? 'PRIVATE_MISQUOTATION' : issue.claim }] }),
          finishReason: 'stop', toolCalls: [], reasoningContent: '', modelCallCount: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 } }
      }, onProtocolRepair: async (diagnostic) => { diagnostics.push(diagnostic) },
    })
    expect(calls).toBe(2)
    expect(review.artifactIssues).toEqual([issue])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('issues[0]')
    expect(diagnostics[0]).not.toContain('PRIVATE_MISQUOTATION')
  })

  it('admits only a located repair response and never publishes its JSON or a draft Final', () => {
    const response = { content: JSON.stringify({ artifactIssues: [issue] }), toolCalls: [], finishReason: 'stop' }
    expect(parseVisualFinalReview(response, 'Private draft', context())).toEqual({ final: '', corrections: [], artifactIssues: [issue] })
    expect(() => parseVisualFinalReview(response, 'Private draft')).toThrow()
    expect(() => parseVisualFinalReview({ ...response, content: JSON.stringify({ artifactIssues: [issue], final: 'Still complete' }) }, '', context())).toThrow()
  })

  it('preserves pending content defects through CSS changes and serialized reload', () => {
    const repair = createArtifactReviewRepair(context(), task, [issue])
    const value = projected()
    value.artifact.sha256 = digest('different CSS and runtime')
    value.artifact.sourceBytes = 90_000
    const reloaded = JSON.parse(JSON.stringify(repair))
    expect(artifactReviewRepairGap(reloaded, JSON.stringify(value), task)).toContain(issue.claim)
    expect(artifactReviewRepairGap(reloaded, JSON.stringify(value), task)).toContain('CSS-only edits do not resolve a content issue')
    expect(repair).toEqual(reloaded)
  })

  it.each(['text', 'link', 'source', 'path', 'task'] as const)('does not apply old feedback after a %s change', (change) => {
    const repair = createArtifactReviewRepair(context(), task, [issue])
    const value = projected()
    if (change === 'text') value.artifact.sections[1].text = 'Only the first stage is complete.'
    if (change === 'link') value.artifact.sourceLinks[0].href += '?revised=1'
    if (change === 'source') value.researchPlan.sha256 = 'brief-v2'
    if (change === 'path') value.artifact.path = 'another.html'
    expect(artifactReviewRepairGap(repair, JSON.stringify(value), change === 'task' ? task + ' Changed scope.' : task)).toBeUndefined()
  })

  it('allows unsupported-scope feedback without inventing a positive supporting quotation', () => {
    const scopeIssue = { sourceSlide: 1, claim: 'All events occurred this week.', reason: 'Publication time does not establish every event date.' }
    expect(parseArtifactReviewIssues([scopeIssue], context())).toEqual([scopeIssue])
  })

  it.each([
    { claim: 'Invented text' }, { sourceSlide: 1 }, { sourceSlide: 2.5 }, { sourceSlide: undefined },
    { reason: '' }, { reason: 'x'.repeat(801) }, { sourceUrl: 'https://other.example/report' },
    { sourceQuote: 'The entire project is complete.' }, { sourceUrl: undefined }, { sourceQuote: undefined },
    { command: 'write something' }, { claim: 'x'.repeat(601) },
  ])('rejects malformed or ungrounded issue fields without leaking them: %j', (change) => {
    expect(() => parseArtifactReviewIssues([{ ...issue, ...change }], context())).toThrow('ungrounded artifact repair')
  })

  it.each([[], Array(7).fill(issue), null, {}, [null]])('rejects unsupported issue envelopes', (issues) => {
    expect(() => parseArtifactReviewIssues(issues, context())).toThrow()
  })

  it('does not accept missing, unavailable or unlocated artifact/source evidence', () => {
    for (const broken of ['', 'not JSON', '{}', JSON.stringify({ artifact: { status: 'unavailable' } })]) {
      expect(() => parseArtifactReviewIssues([issue], broken)).toThrow()
    }
    const value = projected()
    value.researchPlan.items[0].sources[0].role = 'aggregation'
    expect(() => parseArtifactReviewIssues([issue], JSON.stringify(value))).toThrow()
    value.researchPlan.items[0].sources[0].role = 'reporting'
    value.artifact.sections = []
    expect(() => parseArtifactReviewIssues([issue], JSON.stringify(value))).toThrow()
  })

  it('keeps three repair opportunities across reload without creating an unbounded reviewer loop', () => {
    let repair = createArtifactReviewRepair(context(), task, [issue])
    for (let attempts = 2; attempts <= 3; attempts += 1) {
      repair = createArtifactReviewRepair(context(), task, [issue], JSON.parse(JSON.stringify(repair)))
      expect(repair.attempts).toBe(attempts)
    }
    const exhausted = createArtifactReviewRepair(context(), task, [issue], repair)
    expect(exhausted.issues).toEqual([issue])
    expect(artifactReviewRepairExhaustion(exhausted)).toContain('three complete repair opportunities')
    expect(() => artifactReviewRepairGap(JSON.parse(JSON.stringify(exhausted)), context(), task)).toThrow('three complete repair opportunities')
    expect(createArtifactReviewRepair(context(), task + ' New task.', [issue], repair).attempts).toBe(1)
    expect(() => artifactReviewRepairGap({ ...repair, attempts: -1 }, context(), task)).toThrow()
  })

  it('allows successive independently located content repairs beyond a total of three reviews', () => {
    let previous: ReturnType<typeof createArtifactReviewRepair> | undefined
    for (let index = 1; index <= 5; index += 1) {
      const value = projected()
      value.artifact.sections[1].text = `Unresolved claim ${index}.`
      previous = createArtifactReviewRepair(JSON.stringify(value), task,
        [{ sourceSlide: 2, claim: value.artifact.sections[1].text, reason: 'Qualify this currently located claim.' }], previous)
      expect(previous.attempts).toBe(index)
      expect(artifactReviewRepairGap(previous, JSON.stringify(value), task)).toContain(value.artifact.sections[1].text)
    }
  })

  it('does not reset the recurring-claim allowance by alternating issue sets', () => {
    let previous: ReturnType<typeof createArtifactReviewRepair> | undefined
    for (let index = 0; index < 7; index += 1) {
      const value = projected()
      value.artifact.sections[1].text = `Claim ${index % 2}.`
      previous = createArtifactReviewRepair(JSON.stringify(value), task,
        [{ sourceSlide: 2, claim: value.artifact.sections[1].text, reason: 'Qualify this claim.' }], previous)
      expect(Boolean(artifactReviewRepairExhaustion(previous))).toBe(index === 6)
    }
  })

  it.each(['reason', 'bytes', 'whitespace'] as const)('does not buy repair opportunities with %s churn', (change) => {
    let previous: ReturnType<typeof createArtifactReviewRepair> | undefined
    for (let index = 0; index < 4; index += 1) {
      const value = projected()
      if (change === 'bytes') value.artifact.sha256 = digest(`CSS revision ${index}`)
      previous = createArtifactReviewRepair(JSON.stringify(value), task,
        [{ ...issue, ...(change === 'reason' ? { reason: `Explanation ${index}` } : {}),
          ...(change === 'whitespace' ? { claim: `${' '.repeat(index)}The project is complete.` } : {}) }], previous)
      expect(Boolean(artifactReviewRepairExhaustion(previous))).toBe(index === 3)
    }
  })

  it('conservatively migrates legacy counters and permits a novel admitted issue', () => {
    const legacy = { ...createArtifactReviewRepair(context(), task, [issue]), attempts: 3 }
    delete legacy.progressHistory
    expect(artifactReviewRepairExhaustion(createArtifactReviewRepair(context(), task, [issue], legacy))).toBeDefined()
    const next = createArtifactReviewRepair(context(), task,
      [{ sourceSlide: 1, claim: 'All events occurred this week.', reason: 'Unsupported scope.' }], legacy)
    expect(next.attempts).toBe(4)
    expect(artifactReviewRepairExhaustion(next)).toBeUndefined()
    expect(next.progressHistory).toHaveLength(4)
  })

  it('bounds persisted history, rejects malformed state, and restarts only for a different task scope', () => {
    let previous: ReturnType<typeof createArtifactReviewRepair> | undefined
    for (let index = 0; index < 20; index += 1) {
      const value = projected()
      value.artifact.sections[1].text = `Claim ${index}.`
      previous = createArtifactReviewRepair(JSON.stringify(value), task,
        [{ sourceSlide: 2, claim: value.artifact.sections[1].text, reason: 'Qualify this claim.' }], previous)
      expect(previous.progressHistory!.length).toBeLessThanOrEqual(13)
    }
    expect(createArtifactReviewRepair(context(), task + ' New task.', [issue], previous).progressHistory).toHaveLength(1)
    expect(() => createArtifactReviewRepair(context(), task, [issue], { ...previous!, progressHistory: ['invalid'] })).toThrow()
  })
})
