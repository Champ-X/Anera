import { describe, expect, it } from 'vitest'
import { modelDeclarationManifest } from './evidence-provenance.js'
import { independentArtifactEvidence } from './visual-delivery.js'
import { visualArtifactReviewMessages } from './visual-final-review.js'

describe('model declaration provenance', () => {
  it('distinguishes durable declarations from a smaller handoff projection without claiming their contents are facts', () => {
    const entries = [{ field: 'scope', text: 'PRIVATE_DECLARATION' }]
    const full = modelDeclarationManifest('research_brief', entries)
    const durable = modelDeclarationManifest('research_brief', entries, 0, 'durable_research_brief')
    expect(durable.availableTextLocation).toBe('durable_research_brief')
    expect(durable.snapshotSha256).toBe(full.snapshotSha256)
    expect(JSON.stringify(durable)).not.toContain('PRIVATE_DECLARATION')
    expect(() => modelDeclarationManifest('research_brief', entries, 0, 'unknown' as never)).toThrow('Invalid declaration provenance')
  })
  it.each(['code_test_review', 'document_parse_review', 'research_brief'])(
    'identifies declarations without promoting their asserted outcomes: %s', (source) => {
      const entries = [{ field: 'limitation', text: 'PRIVATE_INTERPRETATION: all earlier problems are fixed.' }]
      const original = structuredClone(entries)
      const manifest = modelDeclarationManifest(source, entries, 1)
      expect(manifest).toMatchObject({ origin: 'model', source, disposition: 'not_revalidated_against_current_evidence',
        availableEntryCount: 1, omittedEntryCount: 1, availableTextLocation: 'full_content_evidence' })
      expect(JSON.stringify(manifest)).not.toContain('PRIVATE_INTERPRETATION')
      expect(modelDeclarationManifest(source, entries, 1)).toEqual(manifest)
      expect(modelDeclarationManifest(source, [{ ...entries[0], text: 'Different declaration.' }], 1).snapshotSha256).not.toBe(manifest.snapshotSha256)
      expect(modelDeclarationManifest(source, entries, 2).snapshotSha256).not.toBe(manifest.snapshotSha256)
      expect(entries).toEqual(original)
    },
  )
})

const snapshot = () => ({ version: 1, artifact: { path: 'result.html', status: 'hash_verified', sha256: 'a'.repeat(43),
  sections: [{ sourceSlide: 1, text: 'The whole project is complete.', textTruncated: false }],
  partialProjection: true, omittedSectionCount: 2 }, researchPlan: { sha256: 'immutable-brief-identity',
  scope: 'PRIVATE_SCOPE: fully verified results.', limitations: ['PRIVATE_REPAIR_STORY: the previous error is gone.'],
  omittedLimitationCount: 1, omittedQualityNoteCount: 2, omittedPlanTitleCount: 3, omittedExcerptCount: 4, omittedItemCount: 5,
  items: [{ id: 'item1', title: 'PRIVATE_TITLE: All complete', dateNote: 'PRIVATE_DATE: must be this week',
    sources: [{ role: 'reporting', url: 'https://example.org/project', qualityNote: 'PRIVATE_QUALITY: trustworthy',
      excerpt: 'The first stage is complete. Work on the second stage continues.', excerptBytes: 70 },
    { role: 'aggregation', url: 'https://example.org/missing', excerptBytes: 90 }] }] } })

describe('independent content evidence', () => {
  it('retains every observation and missing-evidence marker while excluding author interpretations', () => {
    const data = snapshot()
    const original = JSON.stringify(data)
    const projected = independentArtifactEvidence(original)
    expect(independentArtifactEvidence(projected)).toBe(projected)
    const value = JSON.parse(projected)
    expect(value.artifact).toEqual(data.artifact)
    expect(value.researchPlan.sha256).toBe(data.researchPlan.sha256)
    expect(value.researchPlan.items[0]).toEqual({ id: 'item1', sources: data.researchPlan.items[0].sources.map(({ qualityNote: _note, ...source }) => source) })
    expect(value.researchPlan).toMatchObject({ omittedLimitationCount: 1, omittedQualityNoteCount: 2, omittedPlanTitleCount: 3,
      omittedExcerptCount: 4, omittedItemCount: 5 })
    expect(value.modelDeclarations).toMatchObject({ origin: 'model', availableEntryCount: 5, omittedEntryCount: 6 })
    expect(projected).not.toContain('PRIVATE_')
    expect(JSON.stringify(data)).toBe(original)
    expect(projected).toContain('Work on the second stage continues.')
    expect(value.researchPlan.items[0].sources[1]).not.toHaveProperty('excerpt')
    const messages = visualArtifactReviewMessages({ taskRequest: 'Create a report. Include every requested qualification.', deliveryContext: original })
    expect(JSON.parse(String(messages[1].content))).toEqual({ taskRequest: 'Create a report. Include every requested qualification.', deliveryContext: value })
  })

  it.each(['bad_json', 'missing_plan', 'invalid_note', 'invalid_limits', 'invalid_count', 'missing_sources'] as const)(
    'retains original evidence rather than silently narrowing an unknown snapshot: %s', (mode) => {
      const data: any = snapshot()
      if (mode === 'missing_plan') delete data.researchPlan
      if (mode === 'invalid_note') data.researchPlan.items[0].dateNote = { value: 'unknown' }
      if (mode === 'invalid_limits') data.researchPlan.limitations = [null]
      if (mode === 'invalid_count') data.researchPlan.omittedLimitationCount = -1
      if (mode === 'missing_sources') delete data.researchPlan.items[0].sources
      const context = mode === 'bad_json' ? 'not JSON' : JSON.stringify(data)
      expect(independentArtifactEvidence(context)).toBe(context)
    },
  )
})
