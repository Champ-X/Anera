import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../shared/types.js'
import { researchPageReadFromResult } from './research-evidence.js'
import { createResearchBrief, missingResearchBriefLinks, normalizeResearchBrief, parseResearchBriefMembershipMessage,
  researchBriefMatchesReads, researchBriefMembershipIssue, researchBriefMembershipMessage, researchNumericTokens,
  researchSnapshotsFromEvents, researchSourceDiscoveryReason } from './research-brief.js'

const url = 'https://reporting.example/2026/09/07/article'
const content = '2026年9月7日报道：这次访谈长107分钟，活动票房为1.49亿元。报道明确注明这是当日的新进展。'
const sha256 = createHash('sha256').update(content).digest('hex')
const snapshot = { url, requestedUrl: url, title: '访谈活动报道', content, sha256 }
const args = () => ({
  scope: '2026年9月1日至7日的娱乐新闻', limitations: ['尚未取得活动主办方完整统计表；不使用聚合页面的热度估计。'],
  items: [{ title: '访谈活动新进展', summary: '本次访谈长107分钟，活动票房为1.49亿元。', date_note: '9月7日报道当日新进展。',
    sources: [{ url, role: 'reporting', quality_note: '具体文章包含记者报道与明确日期，非频道首页。', excerpt: content }] }],
})

function pageEvent(index: number, chunk: string, total = 1, snapshotSha256 = sha256): SessionEvent {
  return {
    id: `event-${index}`, seq: index + 1, sessionId: 'ses_research', at: '2026-09-07T00:00:00Z', type: 'tool.completed',
    data: { call: { id: `call-${index}`, name: 'fetch_page', arguments: { url, format: 'markdown', chunkIndex: index } },
      result: JSON.stringify({ status: 'success', url, title: snapshot.title, content: chunk, chunkIndex: index,
        totalChunks: total, hasMore: index + 1 < total, snapshot_sha256: snapshotSha256 }) },
  }
}

const readFor = (event: SessionEvent) => researchPageReadFromResult(event.data.call as never, JSON.parse(event.data.result as string))!

describe('source-backed research brief', () => {
  it('distinguishes fetched citation membership from per-item support without declaring uncited or unread stories false', () => {
    const brief = createResearchBrief(args(), [snapshot])
    const secondUrl = 'https://reporting.example/second?edition=1'
    expect(researchBriefMembershipIssue(brief, [url, `${url}#section`], [url, secondUrl])).toBeUndefined()
    expect(researchBriefMembershipIssue(brief, [url, secondUrl], [url])).toBeUndefined()
    const issue = researchBriefMembershipIssue(brief, [url, `${secondUrl}#story`, secondUrl], [url, secondUrl])!
    expect(issue).toEqual({ briefSha256: brief.sha256, urls: [secondUrl] })
    expect(parseResearchBriefMembershipMessage(researchBriefMembershipMessage(issue))).toEqual(issue)
    const input = args()
    input.items[0].sources.push({ ...input.items[0].sources[0], url: secondUrl, role: 'aggregation' })
    const withBackground = createResearchBrief(input, [snapshot, { ...snapshot, url: secondUrl, requestedUrl: secondUrl }])
    expect(researchBriefMembershipIssue(withBackground, [secondUrl], [url, secondUrl])).toBeUndefined()
    expect(missingResearchBriefLinks(withBackground, [secondUrl])).toEqual(['n1'])
  })

  it.each([
    { briefSha256: 'wrong', urls: [url] },
    { briefSha256: sha256, urls: [] },
    { briefSha256: sha256, urls: ['javascript:alert(1)'] },
    { briefSha256: sha256, urls: ['https://user:password@reporting.example/'] },
    { briefSha256: sha256, urls: [`${url}#noncanonical`] },
    { briefSha256: sha256, urls: [url], injected: 'not a diagnostic field' },
  ])('rejects malformed membership diagnostics %j', (value) => {
    expect(parseResearchBriefMembershipMessage(`Research-brief membership review required: ${JSON.stringify(value)}`)).toBeUndefined()
  })

  it.each([
    ['观演人次近60万，跨城占比超57.1%，想看人数突破182万，正向评价超99%。', '观演人次60万，跨城占比57.1%，想看人数182万，正向评价99%。'],
    ['观演人次近60万。', '观演人次约60万。'],
    ['Album attendance was over 57.1%.', 'Album attendance was 57.1%.'],
  ])('rejects dropped or changed quantity qualifiers, not just changed digits: %s', (source, summary) => {
    const input = args()
    input.items[0].summary = summary
    input.items[0].sources[0].excerpt = source
    const article = { ...snapshot, content: source, sha256: createHash('sha256').update(source).digest('hex') }
    expect(() => createResearchBrief(input, [article])).toThrow(/quantity_qualification/)
    input.items[0].summary = source
    expect(createResearchBrief(input, [article]).items[0].summary).toBe(source)
  })

  it('rejects a released headline or main sentence backed only by a scheduled named release, even with a correct date note', () => {
    const source = '歌手的新专辑《夏日手记》将于9月7日下午6时通过各大音源网站发行。'
    const article = { ...snapshot, content: source, sha256: createHash('sha256').update(source).digest('hex') }
    const input = args()
    input.items[0].sources[0].excerpt = source
    input.items[0].date_note = '原稿为预告，精确报道日期未知。'
    for (const summary of ['歌手推出新专辑《夏日手记》。专辑定于9月7日发行。',
      '《夏日手记》已于9月7日发行。（原稿是发行前预告）', '新专辑《夏日手记》发行。']) {
      input.items[0].summary = summary
      expect(() => createResearchBrief(input, [article])).toThrow(/planned_event_status/)
    }
    input.items[0].summary = source
    input.items[0].title = '新专辑《夏日手记》发行'
    expect(() => createResearchBrief(input, [article])).toThrow(/planned_event_status/)
    input.items[0].title = '新专辑《夏日手记》发行预告'
    expect(createResearchBrief(input, [article]).items[0].title).toBe(input.items[0].title)
  })

  it('records exact supporting excerpts and survives durable normalization without calling them truth proof', () => {
    const brief = createResearchBrief(args(), [snapshot])
    expect(brief.items[0]).toMatchObject({ id: 'n1', summary: args().items[0].summary,
      sources: [{ url, role: 'reporting', snapshotSha256: sha256 }] })
    expect(normalizeResearchBrief(JSON.parse(JSON.stringify(brief)))).toEqual(brief)
    expect(normalizeResearchBrief({ ...brief, scope: 'Changed task' })).toBeUndefined()
    expect(normalizeResearchBrief({ ...brief, items: [] })).toBeUndefined()
    expect(researchBriefMatchesReads(brief, [readFor(pageEvent(0, content))])).toBe(true)
    expect(researchBriefMatchesReads(brief, [])).toBe(false)
    expect(researchBriefMatchesReads(brief, [readFor(pageEvent(0, 'Other article bytes', 1, 'b'.repeat(64)))])).toBe(false)
  })

  it('rejects missing bodies, paraphrased excerpts, tenfold errors and expanded vague quantities', () => {
    expect(() => createResearchBrief(args(), [])).toThrow(/complete.*article body/)
    const changedExcerpt = args()
    changedExcerpt.items[0].sources[0].excerpt = '该访谈持续107分钟。'
    expect(() => createResearchBrief(changedExcerpt, [snapshot])).toThrow(/excerpt.*not present/)
    const tenfold = args()
    tenfold.items[0].summary = '活动票房为14.9亿元。'
    expect(() => createResearchBrief(tenfold, [snapshot])).toThrow(/14.9亿/)
    const vague = args()
    vague.items[0].summary = '话题阅读量为数十亿。'
    vague.items[0].sources[0].excerpt = '话题阅读量为数亿。'
    expect(() => createResearchBrief(vague, [{ ...snapshot, content: '话题阅读量为数亿。', sha256: createHash('sha256').update('话题阅读量为数亿。').digest('hex') }])).toThrow(/数十亿/)
    expect(() => createResearchBrief(args(), [{ ...snapshot, sha256: '0'.repeat(64) }])).toThrow(/content hash/)
    expect(researchNumericTokens('1,000 万元；数亿；14.9亿；12％')).toEqual(['1000万', '数亿', '14.9亿', '12%'])
  })

  describe('calendar date numeric support', () => {
    const dateCase = (body: string, summary: string) => {
      const input = args()
      input.items[0].summary = summary
      input.items[0].sources[0].excerpt = body
      const article = { ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }
      return { input, article }
    }

    it.each([
      ['2025年2月18日，两人同时发微博官宣离婚。', '2025-02-18官宣离婚。'],
      ['2025-02-18，两人同时发微博官宣离婚。', '2025年2月18日官宣离婚。'],
      ['2025年02月08日，活动举行。', '活动于2025-02-08举行。'],
      ['2024年2月29日，活动举行。', '活动于2024-02-29举行。'],
      ['2000年2月29日，活动举行。', '活动于2000-02-29举行。'],
      ['1900年2月28日，活动举行。', '活动于1900-02-28举行。'],
      ['2025年2月18日，活动举行。', '活动于2月18日举行。'],
      ['2025年2月18日开幕，2025年3月19日闭幕。', '活动从2025-02-18至2025-03-19。'],
    ])('accepts equivalent valid dates without rewriting source or proposal: %s', (body, summary) => {
      const { input, article } = dateCase(body, summary)
      const before = JSON.stringify({ input, article })
      const brief = createResearchBrief(input, [article])
      expect(brief.items[0].summary).toBe(summary)
      expect(brief.items[0].sources[0].excerpt).toBe(body)
      expect(normalizeResearchBrief(brief)).toEqual(brief)
      expect(JSON.stringify({ input, article })).toBe(before)
    })

    it('keeps complete dates atomic while preserving amount, scale and percentage tokens', () => {
      expect(researchNumericTokens('2025年2月18日；2025-02-18；107分钟；1,000 万元；数亿；14.9亿；12％'))
        .toEqual(['2025-02-18', '107', '1000万', '数亿', '14.9亿', '12%'])
    })

    it.each([
      '活动于2025-03-18举行。',
      '活动于2025-02-19举行。',
      '活动于2024-02-18举行。',
      '活动于2025年3月19日举行。',
    ])('does not assemble an unsupported date from separately supported numbers: %s', (summary) => {
      const { input, article } = dateCase('2025年2月18日，活动举行。另有2024份档案、3份材料和19名工作人员。', summary)
      expect(() => createResearchBrief(input, [article])).toThrow(/numbers\/scales absent.*202[45]-/)
    })

    it.each(['2025-02-29', '1900-02-29', '2024-04-31', '2025-00-18', '2025-13-18', '2025-02-00', '0000-02-18'])
      ('rejects invalid Gregorian dates even when their individual numbers occur in evidence: %s', (date) => {
        const [year, month, day] = date.split('-')
        const { input, article } = dateCase(`${year}年${month}月${day}日，原文有此错误日期。`, `活动于${date}举行。`)
        expect(() => createResearchBrief(input, [article])).toThrow(/invalid calendar date/)
      })

    it('rejects an invalid CJK calendar date even when the source repeats it literally', () => {
      const body = '2025年2月29日，原文有此错误日期。'
      const { input, article } = dateCase(body, body)
      expect(() => createResearchBrief(input, [article])).toThrow(/invalid calendar date/)
    })

    it.each([
      ['2025年2月18日，现场有2人，票房为2万元。', '现场有02人。'],
      ['2025年2月18日，现场有2人，票房为2万元。', '票房为02万元。'],
      ['2025年2月18日，活动票房为1.49亿元。', '2025-02-18活动票房为14.9亿元。'],
      ['2025年2月18日，话题阅读量为数亿。', '2025-02-18话题阅读量为数十亿。'],
    ])('does not normalize non-date leading zeros or change quantities: %s / %s', (body, summary) => {
      const { input, article } = dateCase(body, summary)
      expect(() => createResearchBrief(input, [article])).toThrow(/numbers\/scales absent/)
    })

    it.each(['ID2025-02-18', '12025-02-18', '2025-002-18', '2025-02-180', '2025-02-18万', '2025-02-18%',
      '2025-02-18元', '2025-02-18人', '2025-02-18分钟', '2025-02-18,000', 'https://reporting.example/2025-02-18',
      'https://reporting.example/article?date=2025-02-18', '02/18/2025'])
      ('does not grant date equivalence to identifiers, malformed fields, quantities or non-year-first forms: %s', (claim) => {
        expect(researchNumericTokens(claim)).not.toContain('2025-02-18')
        const { input, article } = dateCase('2025年2月18日，活动举行。', `报道记为${claim}。`)
        expect(() => createResearchBrief(input, [article])).toThrow(/numbers\/scales absent/)
      })

    it('does not borrow an equivalent date from outside the hash-bound cited passage', () => {
      const excerpt = '2025年2月17日，活动筹备。'
      const { input, article } = dateCase(`${excerpt}\n2025年2月18日，活动举行。`, '活动于2025-02-18举行。')
      const { excerpt: _excerpt, ...source } = input.items[0].sources[0]
      const referenced = { ...input, items: [{ ...input.items[0], sources: [{ ...source,
        passage_ref: { snapshot_sha256: article.sha256, start_byte: 0, end_byte: Buffer.byteLength(excerpt) } }] }] }
      expect(() => createResearchBrief(referenced, [article])).toThrow(/numbers\/scales absent.*2025-02-18/)
    })

    it('does not use an aggregation-only date to support a reporting-backed item', () => {
      const { input, article } = dateCase('2025年2月17日，活动筹备。', '活动于2025-02-18举行。')
      const body = '2025年2月18日，活动举行。'
      const other = { ...article, url: 'https://aggregation.example/digest', requestedUrl: 'https://aggregation.example/digest',
        content: body, sha256: createHash('sha256').update(body).digest('hex') }
      input.items[0].sources.push({ ...input.items[0].sources[0], url: other.url, role: 'aggregation', excerpt: body })
      expect(() => createResearchBrief(input, [article, other])).toThrow(/numbers\/scales absent.*2025-02-18/)
    })
  })

  const referenceArgs = (reference: unknown, sourceUrl = url) => {
    const input = args()
    const { excerpt: _excerpt, ...source } = input.items[0].sources[0]
    return { ...input, items: [{ ...input.items[0], sources: [{ ...source, url: sourceUrl, passage_ref: reference }] }] }
  }
  const wholeReference = { snapshot_sha256: sha256, start_byte: 0, end_byte: Buffer.byteLength(content) }

  it('materializes a hash-bound UTF-8 passage as the same durable literal excerpt without changing input', () => {
    const prefix = '前言👩🏽‍💻\n'
    const body = `${prefix}${content}\n后记`
    const article = { ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }
    const input = referenceArgs({ snapshot_sha256: article.sha256, start_byte: Buffer.byteLength(prefix),
      end_byte: Buffer.byteLength(prefix + content) })
    const before = JSON.stringify(input)
    const brief = createResearchBrief(input, [article])
    expect(brief).toEqual(createResearchBrief(args(), [article]))
    expect(normalizeResearchBrief(brief)).toEqual(brief)
    expect(brief.items[0].sources[0]).not.toHaveProperty('passage_ref')
    expect(JSON.stringify(input)).toBe(before)
    expect(createResearchBrief(referenceArgs({ ...wholeReference }), [snapshot])).toEqual(createResearchBrief(args(), [snapshot]))
  })

  it.each([
    null, [], 'invented', {},
    { ...wholeReference, snapshot_sha256: 'b'.repeat(64) },
    { ...wholeReference, snapshot_sha256: sha256.toUpperCase() },
    { ...wholeReference, start_byte: -1 },
    { ...wholeReference, start_byte: 0.5 },
    { ...wholeReference, end_byte: '10' },
    { ...wholeReference, end_byte: Infinity },
    { ...wholeReference, end_byte: Number.MAX_SAFE_INTEGER + 1 },
    { ...wholeReference, end_byte: 0 },
    { ...wholeReference, start_byte: 12, end_byte: 10 },
    { ...wholeReference, end_byte: Buffer.byteLength(content) + 1 },
    { ...wholeReference, start_byte: 5 }, // inside 年
    { ...wholeReference, end_byte: 6 },
    { ...wholeReference, text: 'invented override' },
  ])('rejects a malformed, stale or non-UTF-8-boundary passage reference: %j', (reference) => {
    expect(() => createResearchBrief(referenceArgs(reference), [snapshot])).toThrow(/passage_ref/)
  })

  it('requires exactly one excerpt representation and never falls back from an invalid reference', () => {
    const source = args().items[0].sources[0]
    for (const entry of [
      { ...source, passage_ref: wholeReference },
      { ...source, passage_ref: { ...wholeReference, snapshot_sha256: 'b'.repeat(64) } },
      { url, role: 'reporting', quality_note: source.quality_note },
    ]) {
      const input = { ...args(), items: [{ ...args().items[0], sources: [entry] }] }
      expect(() => createResearchBrief(input, [snapshot])).toThrow(/exactly one.*excerpt.*passage_ref/)
    }
  })

  it('keeps passage references bound to the chosen source and latest complete snapshot', () => {
    const otherContent = `${content}另一来源保留不同说明。`
    const other = { ...snapshot, url: 'https://other.example/story', requestedUrl: 'https://other.example/story',
      content: otherContent, sha256: createHash('sha256').update(otherContent).digest('hex') }
    expect(() => createResearchBrief(referenceArgs(wholeReference, other.url), [snapshot, other])).toThrow(/passage_ref.*snapshot/)
    expect(() => createResearchBrief(referenceArgs(wholeReference), [snapshot, { ...other, url, requestedUrl: url }])).toThrow(/passage_ref.*snapshot/)
    expect(() => createResearchBrief(referenceArgs(wholeReference), [])).toThrow(/complete.*article body/)
    expect(() => createResearchBrief(referenceArgs(wholeReference), [{ ...snapshot, content: otherContent }])).toThrow(/content hash/)
    const lossy = `Invalid \uD800 source`
    const lossySnapshot = { ...snapshot, content: lossy, sha256: createHash('sha256').update(lossy).digest('hex') }
    expect(() => createResearchBrief(referenceArgs({ snapshot_sha256: lossySnapshot.sha256, start_byte: 0, end_byte: Buffer.byteLength(lossy) }), [lossySnapshot]))
      .toThrow(/passage_ref.*losslessly UTF-8/)
    const alias = 'https://reporting.example/redirect'
    expect(createResearchBrief(referenceArgs(wholeReference, alias), [{ ...snapshot, requestedUrl: alias }])
      .items[0].sources[0].excerpt).toBe(content)
  })

  it('does not let a passage reference bypass quote length, source restrictions or numeric support', () => {
    for (const body of ['x'.repeat(2_401), '文'.repeat(2_401), '🧑'.repeat(1_201), '  \n  ']) {
      const article = { ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }
      expect(() => createResearchBrief(referenceArgs({ snapshot_sha256: article.sha256, start_byte: 0, end_byte: Buffer.byteLength(body) }), [article]))
        .toThrow(/excerpt.*non-empty.*2400/)
    }
    const input = referenceArgs(wholeReference)
    input.items[0].summary = '活动票房为14.9亿元。'
    expect(() => createResearchBrief(input, [snapshot])).toThrow(/numbers\/scales absent.*14.9亿/)
    const body = `${content}\n本文由AI生成，仅供参考。`
    const generated = { ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }
    const discovery = referenceArgs({ ...wholeReference, snapshot_sha256: generated.sha256 })
    expect(() => createResearchBrief(discovery, [generated])).toThrow(/discovery-only/)
    discovery.items[0].sources[0].role = 'aggregation'
    expect(() => createResearchBrief(discovery, [generated])).toThrow(/supported only by aggregation/)
    const linked = '活动票房为[**1.49亿元**](https://reporting.example/1490 "1491")，尚未审计。'
    const linkedArticle = { ...snapshot, content: linked, sha256: createHash('sha256').update(linked).digest('hex') }
    const linkedInput = referenceArgs({ snapshot_sha256: linkedArticle.sha256, start_byte: 0, end_byte: Buffer.byteLength(linked) })
    linkedInput.items[0].summary = '活动票房为1490元。'
    expect(() => createResearchBrief(linkedInput, [linkedArticle])).toThrow(/numbers\/scales absent.*1490/)
  })

  it.each([
    '[郭德纲](https://ent.163.com/keywords/9/e/90ed5fb77eb2/1.html)',
    '[郭德纲](https://reporting.example/name_(person) "人物资料")',
    '[郭德纲][person]\n\n[person]: https://reporting.example/person',
  ])('accepts verbatim contiguous article copy with a Markdown link displayed as its label: %s', (link) => {
    const [inline, definition = ''] = link.split('\n\n')
    const body = `据报道，演员${inline}涉事。\n\n处罚仍以通报为准。\n\n${definition}`
    const input = args()
    input.items[0].summary = '报道转述相关通报。'
    input.items[0].sources[0].excerpt = '据报道，演员郭德纲涉事。处罚仍以通报为准。'
    const article = { ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }
    const brief = createResearchBrief(input, [article])
    expect(brief.items[0].sources[0]).toMatchObject({ excerpt: input.items[0].sources[0].excerpt, snapshotSha256: article.sha256 })
    expect(normalizeResearchBrief(brief)).toEqual(brief)
  })

  it('does not use Markdown destinations or link titles as quantitative support', () => {
    for (const link of ['[访谈](https://reporting.example/107)', '[访谈](https://reporting.example/story "107")',
      '[访谈][interview]\n\n[interview]: https://reporting.example/107']) {
      const [inline, definition = ''] = link.split('\n\n')
      const body = `报道介绍了${inline}，未披露时长。\n\n${definition}`
      const input = args()
      input.items[0].summary = '访谈长107分钟。'
      input.items[0].sources[0].excerpt = body
      expect(() => createResearchBrief(input, [{ ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }]))
        .toThrow(/numbers\/scales absent.*107/)
    }
  })

  it.each([
    '**本次活动已有进展。**\n\n**报道仍保留限制。**',
    '__本次活动已有进展。__\n\n__报道仍保留限制。__',
    '*本次活动已有进展。*\n\n*报道仍保留限制。*',
    '_本次活动已有进展。_\n\n_报道仍保留限制。_',
    '***本次活动已有进展。***\n\n***报道仍保留限制。***',
    '**本次[活动](https://reporting.example/event)已有进展。**\n\n*报道仍保留限制。*',
    '[**本次活动**](https://reporting.example/event)已有进展。\n\n**报道仍保留限制。**',
    '**本次[活动][event]已有进展。**\n\n**报道仍保留限制。**\n\n[event]: https://reporting.example/event',
  ])('accepts contiguous visible text across parsed emphasis while preserving its source snapshot: %s', (body) => {
    const input = args()
    input.items[0].summary = '报道转述活动进展并保留限制。'
    input.items[0].sources[0].excerpt = '本次活动已有进展。报道仍保留限制。'
    const article = { ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }
    const brief = createResearchBrief(input, [article])
    expect(brief.items[0].sources[0]).toMatchObject({ excerpt: input.items[0].sources[0].excerpt, snapshotSha256: article.sha256 })
    expect(normalizeResearchBrief(brief)).toEqual(brief)
  })

  it('accepts the real two-paragraph reporting excerpt separated only by strong-markup boundaries', () => {
    // From the 14:19 fresh task: the two actual adjacent paragraphs were
    // falsely treated as noncontiguous because each was enclosed in **.
    const first = '当地时间9月5日，《给阿嬷的情书》主创首度齐聚威尼斯，将参与第83届威尼斯国际电影节华语电影推广活动，《给阿嬷的情书》在第83届威尼斯国际电影节上迎来高光时刻。导演蓝鸿春、演员李思潼与王晓慧抵达后，海外华侨热情接机，送上青橄榄与橄榄油。王彦桐出任本届华语电影推广活动青年推荐官。'
    const second = '此外，据CCTV国际时讯报道，当地时间9月4日，中国电影《给阿嬷的情书》正式登陆北美院线，在美国、加拿大数十座城市超过160家影院上映。这部讲述老一辈华侨故事的影片深深打动众多前来观影的北美观众。'
    const body = `**${first}**\n\n**${second}**\n\n来源：综合北京时间、CCTV国际时讯`
    const input = args()
    input.items[0].title = '影片北美开画与威尼斯推广报道'
    input.items[0].summary = '据该综合报道，影片9月4日在北美超过160家影院上映，主创9月5日齐聚威尼斯。'
    input.items[0].sources[0].excerpt = `${first}\n\n${second}`
    const article = { ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }
    expect(createResearchBrief(input, [article]).items[0].summary).toBe(input.items[0].summary)
    input.items[0].summary = '影片在1600家影院上映。'
    expect(() => createResearchBrief(input, [article])).toThrow(/numbers\/scales absent.*1600/)
  })

  it('uses visibly contiguous emphasized numeric values without borrowing a link destination or title', () => {
    const body = '活动票房为[**1.49亿元**](https://reporting.example/1490 "1491")，来源仍待独立复核。'
    const input = args()
    input.items[0].summary = '活动票房为1.49亿元。'
    input.items[0].sources[0].excerpt = body
    const article = { ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }
    expect(createResearchBrief(input, [article]).items[0].summary).toBe(input.items[0].summary)
    for (const number of ['14.9亿', '1490', '1491']) {
      input.items[0].summary = `票房为${number}元。`
      expect(() => createResearchBrief(input, [article])).toThrow(/numbers\/scales absent/)
    }
  })

  it.each([
    ['本次**未**确认结果。', '本次确认结果。'],
    ['**已经发布。**另有一段说明。**仍未核实。**', '已经发布。仍未核实。'],
    ['**已经发布。**\n\n![证据图片](https://reporting.example/image.png)\n\n**仍未核实。**', '已经发布。仍未核实。'],
    ['**已经发布。**\n\n[ref]: https://reporting.example/source\n\n**仍未核实。**', '已经发布。仍未核实。'],
    ['**已经发布。**\n\n`**仍未核实。**`', '已经发布。仍未核实。'],
    ['**已经发布。**\n\n<strong>仍未核实。</strong>', '已经发布。仍未核实。'],
    ['本次\\*\\*强调\\*\\*原始文字。', '本次强调原始文字。'],
    ['本次**未闭合标记。', '本次未闭合标记。'],
    ['本次金额为1*49元。', '本次金额为149元。'],
    ['**票数为1**\n\n**000。**', '票数为1000。'],
    ['**报道来自中**\n\n**国。**', '报道来自中国。'],
    ['**The interview ended.**\n\n**Another interview began.**', 'The interview ended.Another interview began.'],
  ])('does not erase literal syntax, evidence or meaningful boundaries while projecting emphasis: %s', (body, excerpt) => {
    const input = args()
    input.items[0].summary = '报道转述相关进展。'
    input.items[0].sources[0].excerpt = excerpt
    expect(() => createResearchBrief(input, [{ ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }]))
      .toThrow(/excerpt.*not present/)
  })

  it('retains a visible numerical link label as evidence while excluding unrelated destination numbers', () => {
    const body = '访谈长[107](https://reporting.example/108 "109")分钟。'
    const input = args()
    input.items[0].summary = '访谈长107分钟。'
    input.items[0].sources[0].excerpt = body
    const article = { ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }
    expect(createResearchBrief(input, [article]).items[0].summary).toBe(input.items[0].summary)
    for (const unsupported of [108, 109]) {
      input.items[0].summary = `访谈长${unsupported}分钟。`
      expect(() => createResearchBrief(input, [article])).toThrow(/numbers\/scales absent/)
    }
  })

  it('preserves punctuation, intervening text and source-link identity instead of admitting paraphrase or stitched passages', () => {
    const body = '据报道，演员[郭德纲](https://reporting.example/person)涉事。另有一段背景。处罚仍以通报为准。'
    const article = { ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }
    for (const excerpt of [
      '据报道；演员郭德纲涉事。',
      '据报道，演员郭德纲涉事。处罚仍以通报为准。',
      '据报道，演员郭德纲涉事。……处罚仍以通报为准。',
      '据报道，演员某人涉事。',
      '据报道，演员[郭德纲](https://invented.example/person)涉事。',
    ]) {
      const input = args()
      input.items[0].summary = '报道转述相关通报。'
      input.items[0].sources[0].excerpt = excerpt
      expect(() => createResearchBrief(input, [article]), excerpt).toThrow(/excerpt.*not present/)
    }
  })

  it('does not normalize link-looking code, image syntax, escaped brackets or unresolved references into article prose', () => {
    for (const inline of [
      '`[郭德纲](https://reporting.example/person)`',
      '![郭德纲](https://reporting.example/person)',
      '\\[郭德纲](https://reporting.example/person)',
      '[郭德纲][missing]',
    ]) {
      const body = `据报道，演员${inline}涉事。`
      const input = args()
      input.items[0].summary = '报道转述相关通报。'
      input.items[0].sources[0].excerpt = '据报道，演员郭德纲涉事。'
      expect(() => createResearchBrief(input, [{ ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }]))
        .toThrow(/excerpt.*not present/)
    }
  })

  it.each([
    ['The interview ended.\n\nAnother interview began.', 'The interview ended.Another interview began.'],
    ['票数为1\n\n000。', '票数为1000。'],
    ['报道来自中\n\n国。', '报道来自中国。'],
  ])('retains meaningful word or number boundaries when comparing excerpts: %s', (body, excerpt) => {
    const input = args()
    input.items[0].summary = '报道转述相关进展。'
    input.items[0].sources[0].excerpt = excerpt
    expect(() => createResearchBrief(input, [{ ...snapshot, content: body, sha256: createHash('sha256').update(body).digest('hex') }]))
      .toThrow(/excerpt.*not present/)
  })

  it('keeps explicit AI disclosures, hourly digests and publisher homepages in discovery', () => {
    for (const source of [
      { ...snapshot, content: `${content}\n以上内容由AI生成，仅供参考。`, sha256: createHash('sha256').update(`${content}\n以上内容由AI生成，仅供参考。`).digest('hex') },
      { ...snapshot, title: '新浪娱乐热点小时报丨2026年09月07日03时' },
      { ...snapshot, url: 'https://reporting.example/', title: '娱乐新闻门户' },
    ]) {
      expect(researchSourceDiscoveryReason(source)).toBeDefined()
      const input = args()
      input.items[0].sources[0].url = source.url
      expect(() => createResearchBrief(input, [source])).toThrow(/discovery-only/)
      input.items[0].sources[0].role = 'aggregation'
      expect(() => createResearchBrief(input, [source])).toThrow(/supported only by aggregation/)
    }
    expect(researchSourceDiscoveryReason({ ...snapshot, content: `${content}\n记者采访了人工智能行业从业者。` })).toBeUndefined()
  })

  it('finds explicit AI disclosures in the middle of long article and recommendation bodies', () => {
    for (const disclosure of ['本文由AI生成，仅供参考。', '**以上内容由人工智能生成**', '本文系AI生成。', 'This article was generated by AI.', '<p>本文由<span>AI</span>生成，仅供参考。</p>']) {
      const middle = `${content}\n${'这是采访正文。\n'.repeat(500)}\n${disclosure}\n相关推荐\n${'更多娱乐新闻和站点链接\n'.repeat(700)}`
      const source = { ...snapshot, content: middle, sha256: createHash('sha256').update(middle).digest('hex') }
      expect(researchSourceDiscoveryReason(source), disclosure).toBe('explicit_ai_generated_disclosure_requires_corroboration')
      expect(() => createResearchBrief(args(), [source])).toThrow(/discovery-only/)
    }
  })

  it('does not mistake quoted disclosures or reporting about AI for the article\'s own disclosure', () => {
    for (const line of [
      '记者介绍了由AI生成视频的制作过程。',
      '本文介绍由AI生成的音乐引发的争议。',
      '本文并非由AI生成。',
      '本文未使用人工智能生成。',
      '> 本文由AI生成，仅供参考。',
      '“本文由AI生成”是平台要求添加的提示。',
      'This article was not generated by AI.',
      'This article discusses content written by AI.',
      '<blockquote><p>本文由AI生成</p></blockquote>',
    ]) expect(researchSourceDiscoveryReason({ ...snapshot, content: `${content}\n${line}` }), line).toBeUndefined()
  })

  it('reports errors in multiple research items together without accepting a partial brief', () => {
    const broken = args()
    broken.items[0].summary = '活动票房为14.9亿元。'
    broken.items.push({ ...args().items[0], sources: [{ ...args().items[0].sources[0], excerpt: '访谈长度约一小时……' }] })
    expect(() => createResearchBrief(broken, [snapshot])).toThrow(/Item 1[\s\S]*14.9亿[\s\S]*Item 2[\s\S]*excerpt[\s\S]*not present/)
  })

  it('treats bodies exceeding the bounded disclosure scan as unreviewed, not clean articles', () => {
    expect(researchSourceDiscoveryReason({ ...snapshot, content: '文'.repeat(2_000_001) })).toBe('source_exceeds_bounded_disclosure_review')
    expect(researchSourceDiscoveryReason({ ...snapshot, content: `<div>${'<span></span>'.repeat(100_001)}</div>` })).toBe('source_exceeds_bounded_disclosure_review')
  })

  it('reassembles only fully read snapshots from hydrated successful journal results', () => {
    const halfway = Math.floor(content.length / 2)
    const events = [pageEvent(0, content.slice(0, halfway), 2), pageEvent(1, content.slice(halfway), 2)]
    const reads = events.map(readFor)
    expect(researchSnapshotsFromEvents(events, reads)).toEqual([snapshot])
    expect(researchSnapshotsFromEvents(events.slice(1), reads)).toEqual([])
    expect(researchSnapshotsFromEvents(events, reads.slice(0, 1))).toEqual([])
    expect(researchSnapshotsFromEvents([{ ...events[0], data: { ...events[0].data, notExecuted: true } }, events[1]], reads)).toEqual([])
    const changed = [events[0], pageEvent(1, content.slice(halfway), 2, 'b'.repeat(64))]
    expect(researchSnapshotsFromEvents(changed, changed.map(readFor))).toEqual([])
    expect(researchSnapshotsFromEvents([{ ...pageEvent(0, content), data: {
      ...pageEvent(0, content).data, call: { id: 'search', name: 'web_search', arguments: { query: 'news' } },
    } }], [readFor(pageEvent(0, content))])).toEqual([])
  })

  it('invalidates an old brief immediately when a newer source snapshot is only partly read', () => {
    const old = pageEvent(0, content)
    const brief = createResearchBrief(args(), [snapshot])
    const updated = `${content} 更新：活动已经结束。`
    const updatedHash = createHash('sha256').update(updated).digest('hex')
    const first = pageEvent(0, updated.slice(0, 20), 2, updatedHash)
    const last = pageEvent(1, updated.slice(20), 2, updatedHash)
    expect(researchBriefMatchesReads(brief, [readFor(old), readFor(first)])).toBe(false)
    expect(researchSnapshotsFromEvents([old, first], [readFor(old), readFor(first)])).toEqual([])
    const reads = [old, first, last].map(readFor)
    expect(researchBriefMatchesReads(brief, reads)).toBe(false)
    const current = researchSnapshotsFromEvents([old, first, last], reads)
    expect(current).toEqual([{ ...snapshot, content: updated, sha256: updatedHash }])
    expect(researchBriefMatchesReads(createResearchBrief(args(), current), reads)).toBe(true)
  })

  it('rehydrates private snapshot identity only when the public returned chunk matches its attestation', () => {
    const original = pageEvent(0, content)
    const privateRead = readFor(original)
    const payload = JSON.parse(String(original.data.result))
    delete payload.snapshot_sha256
    const publicEvent = { ...original, data: { ...original.data, result: JSON.stringify(payload), researchPageRead: privateRead } }
    expect(researchSnapshotsFromEvents([publicEvent], [privateRead])).toEqual([snapshot])
    expect(researchSnapshotsFromEvents([{ ...publicEvent, data: { ...publicEvent.data,
      result: JSON.stringify({ ...payload, content: `${content} altered` }) } }], [privateRead])).toEqual([])
  })
})
