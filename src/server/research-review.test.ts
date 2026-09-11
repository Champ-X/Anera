import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { researchReviewContext, researchReviewSource, RESEARCH_REVIEW_MAX_BYTES, RESEARCH_REVIEW_SOURCE_BYTES } from './research-review.js'
import { createResearchBrief } from './research-brief.js'

const snapshot = (content: string, url = 'https://reporting.example/story') => ({
  url, requestedUrl: url, title: '金晨直播回应：诉讼进展与律师声明', content,
  sha256: createHash('sha256').update(content).digest('hex'),
})
const nav = '- [更多娱乐新闻](https://reporting.example/navigation)\n'.repeat(140)
const report = '9月5日，金晨在直播中回应相关传闻。律师声明仅说明案件已经受理，尚无生效判决，不能称为胜诉。'

describe('journal-backed bounded research reading context', () => {
  it('retains middle reporting and its qualifications instead of navigation-heavy head/tail', () => {
    const original = snapshot(`${nav}\n${report.repeat(12)}\n${nav}`)
    const projected = researchReviewSource(original)!
    expect(projected.partialProjection).toBe(true)
    expect(projected.retainedBytes).toBeLessThanOrEqual(RESEARCH_REVIEW_SOURCE_BYTES)
    expect(projected.passages.some((passage) => passage.text.includes(report))).toBe(true)
    const bytes = Buffer.from(original.content)
    for (const passage of projected.passages) {
      expect(bytes.subarray(passage.startByte, passage.endByte).toString('utf8')).toBe(passage.text)
      expect(passage.text).not.toContain('\uFFFD')
    }
  })

  it('keeps small sources complete and distinguishes selected ranges from the full source', () => {
    const original = snapshot(report)
    expect(researchReviewSource(original)).toMatchObject({ sourceBytes: Buffer.byteLength(report), partialProjection: false,
      passages: [{ startByte: 0, endByte: Buffer.byteLength(report), text: report }] })
    expect(researchReviewContext([original])).toContain('UNTRUSTED SOURCE DATA')
    expect(researchReviewContext([original])).toContain('not search snippets or generated summaries')
  })

  it.each(['x'.repeat(7_999), '文'.repeat(2_666), `${'a'.repeat(2_399)}🧑🏽‍💻${'b'.repeat(3_000)}`])(
    'issues bounded literal references without losing bytes when a retained range exceeds the quote limit', (body) => {
      const original = snapshot(body)
      const projected = researchReviewSource(original)!
      const before = JSON.stringify(original)
      expect(projected.partialProjection).toBe(false)
      expect(projected.passages.length).toBeGreaterThan(1)
      expect(projected.passages.map((passage) => passage.text).join('')).toBe(body)
      expect(projected.retainedBytes).toBe(Buffer.byteLength(body))
      for (const passage of projected.passages) {
        expect(passage.text.length).toBeLessThanOrEqual(2_400)
        expect(passage.text).not.toContain('\uFFFD')
        expect(passage).toMatchObject({ passage_ref: { snapshot_sha256: original.sha256,
          start_byte: passage.startByte, end_byte: passage.endByte } })
        const reference = passage.passage_ref
        const brief = createResearchBrief({ scope: 'Source range boundary fixture', limitations: [], items: [{
          title: 'Source review', summary: 'The source passage is preserved.', date_note: 'Date is not established.',
          sources: [{ url: original.url, role: 'reporting', quality_note: 'Boundary fixture only.', passage_ref: reference }],
        }] }, [original])
        expect(brief.items[0].sources[0].excerpt).toBe(passage.text.trim())
      }
      expect(JSON.stringify(original)).toBe(before)
    },
  )

  it('preserves blank separators without issuing unusable quotes and rejects lossy UTF-8 snapshots', () => {
    const body = `${' '.repeat(2_400)}${report}`
    const projected = researchReviewSource(snapshot(body))!
    expect(projected.passages.map((passage) => passage.text).join('')).toBe(body)
    expect(projected.partialProjection).toBe(false)
    expect(projected.passages[0]).not.toHaveProperty('passage_ref')
    expect(projected.passages[1]).toHaveProperty('passage_ref')
    expect(researchReviewSource(snapshot(`Invalid \uD800 source`))).toBeUndefined()
  })

  it('bounds the full encoded context and does not pin arbitrarily many fetched bodies', () => {
    const context = researchReviewContext(Array.from({ length: 30 }, (_, index) => snapshot(
      `${nav}${report.repeat(120)}${nav}`, `https://reporting.example/story-${index}`)))
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(RESEARCH_REVIEW_MAX_BYTES)
    const payload = JSON.parse(context.slice(context.indexOf('\n') + 1))
    expect(payload.sources.length).toBeLessThanOrEqual(6)
    expect(payload.sources.length + payload.omittedSourceCount).toBe(30)
  })

  it('never reconstructs a corrupted source and carries disclosure restrictions into the projection', () => {
    expect(researchReviewSource({ ...snapshot(report), sha256: 'a'.repeat(64) })).toBeUndefined()
    const generated = snapshot(`${nav}${report}\n本文由AI生成，仅供参考。\n${nav}`)
    expect(researchReviewSource(generated)?.discoveryOnlyReason).toBe('explicit_ai_generated_disclosure_requires_corroboration')
    expect(researchReviewSource(snapshot('文'.repeat(2_000_001)))).toBeUndefined()
  })

  it('uses source-specific review focus without interpreting source text as instructions', () => {
    const original = snapshot(`${nav}${'这是演出现场的其他报道。'.repeat(600)}\n独立数据：活动票房为1.49亿元，尚未审计。\n${nav}`)
    const context = researchReviewContext([original], [{ url: original.url, text: '活动票房为1.49亿元，尚未审计。' }])
    expect(context).toContain('活动票房为1.49亿元，尚未审计。')
    expect(context).toContain(original.sha256)
  })
})
