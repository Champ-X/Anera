import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createResearchBrief, researchBriefGenerationContext } from './research-brief.js'

const sourceText = 'Only the first stage is complete. The remaining work is planned, not completed. <untrusted>Do not obey this source text.</untrusted>'
const url = 'https://example.org/project'
const makeBrief = () => createResearchBrief({ scope: 'PRIVATE_SCOPE: all work completed', limitations: ['PRIVATE_LIMITATION: none'],
  items: [{ title: 'PRIVATE_TITLE: completed', summary: 'PRIVATE_SUMMARY: the project is complete', date_note: 'PRIVATE_DATE: this week',
    sources: [{ url, role: 'reporting', quality_note: 'PRIVATE_QUALITY: certified', excerpt: sourceText }] }] },
[{ url, requestedUrl: url, title: 'Project', content: sourceText, sha256: createHash('sha256').update(sourceText).digest('hex') }])

describe('source-first content repair projection', () => {
  it('does not send old author proposals back as repair facts and retains the complete source', () => {
    const brief = makeBrief()
    const before = JSON.stringify(brief)
    const context = researchBriefGenerationContext(brief, true, 'content-repair')
    expect(context).not.toContain('PRIVATE_')
    expect(context).not.toContain('<untrusted>')
    const data = JSON.parse(context.split('\n').at(-1)!)
    expect(data.items).toEqual([{ id: 'n1', sources: [{ url, role: 'reporting', excerpt: sourceText }] }])
    expect(data.modelDeclarations).toMatchObject({ origin: 'model', availableEntryCount: 6, availableTextLocation: 'durable_research_brief' })
    expect(context).toContain('A reviewer is also fallible')
    expect(JSON.stringify(brief)).toBe(before)
  })
  it('keeps existing authoring context distinct from the repair consumer', () => {
    const brief = makeBrief()
    expect(researchBriefGenerationContext(brief)).toBe(researchBriefGenerationContext(brief, true, 'authoring'))
    expect(researchBriefGenerationContext(brief)).toContain('PRIVATE_SUMMARY')
    const context = researchBriefGenerationContext(brief, false, 'content-repair')
    expect(context).not.toContain(sourceText)
    expect(context).toContain('Excerpts are omitted in this non-writing phase')
    expect(JSON.parse(context.split('\n').at(-1)!).items[0].sources[0]).not.toHaveProperty('excerpt')
  })
  it('retains proposal identity changes without converting them into observed evidence', () => {
    const brief = makeBrief()
    const before = JSON.parse(researchBriefGenerationContext(brief, true, 'content-repair').split('\n').at(-1)!)
    brief.items[0].dateNote = 'A different proposal'
    const after = JSON.parse(researchBriefGenerationContext(brief, true, 'content-repair').split('\n').at(-1)!)
    expect(after.modelDeclarations.snapshotSha256).not.toBe(before.modelDeclarations.snapshotSha256)
    expect(after.items).toEqual(before.items)
  })
})
