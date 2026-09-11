import { describe, expect, it } from 'vitest'
import { researchClaimIssues, researchHtmlClaimGap, type ResearchClaimItem } from './research-claim-integrity.js'

const url = 'https://example.org/article'
const item = (excerpt: string, id = 'n1'): ResearchClaimItem => ({ id, sources: [{ url, role: 'reporting', excerpt }] })
const planned = '新专辑《夏日手记》将于9月7日下午6时发行。'

describe('narrow source-claim integrity boundaries', () => {
  it.each(['70%', '约70%', '近70%'])('preserves the lower bound when converting 超七成 to a percent: %s', (claim) => {
    expect(researchClaimIssues([item('国产影片票房占比超七成。')], claim)).toEqual([
      { code: 'quantity_qualification', itemId: 'n1', claim, sourceQuote: '超七成', sourceUrl: url },
    ])
  })

  it('checks the number and explicit percentage label inside the same source-style statistic card', () => {
    const sources = [item('国产影片票房占比超七成。')]
    const card = (value: string, label: string) => `<div class="stat"><div class="figure">${value}<sup></sup></div><div class="meta"><div class="lab">${label}</div><div class="desc">来源说超七成。</div></div></div>`
    expect(researchHtmlClaimGap(sources, card('70', '国产票房占比(约%)'))).toContain('quantity_qualification')
    expect(researchHtmlClaimGap(sources, card('70', '国产票房占比(%)'))).toContain('quantity_qualification')
    expect(researchHtmlClaimGap(sources, card('70+', '国产票房占比(%)'))).toBeUndefined()
    expect(researchHtmlClaimGap(sources, card('70+', '国产票房占比(约%)'))).toContain('quantity_qualification')
  })

  it.each([
    ['超七成', '超70%'], ['超7成', '70%+'], ['超七成', '>70%'], ['至少七成', '≥70%'],
    ['至少七成', '>=70%'], ['不超过七成', '≤70%'], ['不超过七成', '<=70%'],
    ['不到七成', '<70%'], ['约七成', '≈70%'], ['约七成', '~70%'], ['近七成', '近70%'],
    ['七成以上', '至少70%'], ['七成以下', '至多70%'], ['七成左右', '约70%'], ['十成', '100%'],
  ])('keeps the qualification in an exact whole-成 conversion: %s / %s', (source, claim) => {
    expect(researchClaimIssues([item(`占比${source}。`)], claim)).toEqual([])
  })

  it.each(['七成', '约七成'])('also detects a lost bound when the claim uses 成: %s', (claim) => {
    expect(researchClaimIssues([item('占比超70%。')], claim)).toContainEqual(expect.objectContaining({ claim, sourceQuote: '超70%' }))
  })

  it.each(['超七成功劳', '超七成熟', '超十三成', '超七成五', '新作品《超七成》', '`超七成`'])
    ('does not turn ambiguous compound words, fractions or titles into a percentage: %s', (source) => {
      expect(researchClaimIssues([item(source)], '70% / 30% / 100%')).toEqual([])
    })

  it('keeps fraction provenance isolated across items and Markdown destinations', () => {
    expect(researchClaimIssues([item('超七成。'), item('不到70%。', 'n2')], '70%')).toEqual([])
    expect(researchClaimIssues([item('[七成](https://example.org/超70%)')], '70%')).toEqual([])
    expect(researchClaimIssues([item('**超七成**。')], '70%')[0].sourceQuote).toBe('超七成')
  })

  it('uses only visible inline figure/label content and never another card or description', () => {
    const sources = [item('占比超70%。')]
    const card = (value: string, label: string) => `<div class="stat"><div class="figure">${value}</div><div class="meta"><div class="lab">${label}</div><div class="desc">超70%</div></div></div>`
    expect(researchHtmlClaimGap(sources, card('70', '占比(%)'))).toContain('quantity_qualification')
    expect(researchHtmlClaimGap(sources, card('&gt;70', '占比(%)'))).toBeUndefined()
    expect(researchHtmlClaimGap(sources, card('70', '占比(<span>超</span>%)'))).toBeUndefined()
    expect(researchHtmlClaimGap(sources, card('<span hidden>超</span>70', '占比(%)'))).toContain('quantity_qualification')
    expect(researchHtmlClaimGap(sources, card('70', '占比(<span aria-hidden="true">超</span>%)'))).toContain('quantity_qualification')
    expect(researchHtmlClaimGap(sources, card('70+', '占比(%)') + card('70', '占比(%)'))).toContain('quantity_qualification')
    expect(researchHtmlClaimGap(sources, '<div class="figure">70</div><div class="lab">占比(%)</div>')).toBeUndefined()
    expect(researchHtmlClaimGap(sources, card('70', '占比(%)').replace('class="stat"', 'class="stat" hidden'))).toBeUndefined()
    expect(researchHtmlClaimGap(sources, card('70', '占比(%)').replace('class="lab"', 'class="lab" hidden'))).toBeUndefined()
    expect(researchHtmlClaimGap(sources, card('70', '占比(%)').replace('</div><div class="meta">', '</div><div class="figure">80</div><div class="meta">'))).toBeUndefined()
    expect(researchHtmlClaimGap(sources, card('70', '占比(30%)'))).toBeUndefined()
  })

  it.each([
    ['超57.1%', '超过57.1%'], ['突破182万', '超182万'], ['Nearly 60 million', 'nearly 60 million'],
    ['至少30人', '不少于30人'], ['不超过30人', '至多30人'], ['不到30人', '低于30人'],
    ['大约60万', '约60万'], ['30人以上', '至少30人'], ['30人以下', '至多30人'],
  ])('keeps equivalent explicit qualifications: %s / %s', (source, claim) => {
    expect(researchClaimIssues([item(source)], claim)).toEqual([])
  })

  it.each([
    ['近60万', '超60万'], ['超57.1%', '57.1%'], ['突破182万', '182万'], ['超99%', '99%'],
    ['至少30人', '30人'], ['不超过30人', '30人'], ['不到30人', '30人'], ['大约60万', '60万'],
    ['30人以上', '30人'], ['30人以下', '30人'], ['30人左右', '30人'], ['30人+', '30人'],
  ])('reports changed qualification: %s / %s', (source, claim) => {
    expect(researchClaimIssues([item(source)], claim)).toEqual([{ code: 'quantity_qualification', itemId: 'n1', claim, sourceQuote: source, sourceUrl: url }])
  })

  it('preserves source quotation case/spacing and ignores numeric URL destinations and code', () => {
    expect(researchClaimIssues([item('Attendance was More than 57.1%.')], '57.1%')[0].sourceQuote).toBe('More than 57.1%')
    expect(researchClaimIssues([item('[报道](https://example.org/over57.1% "over 57.1%") `超99%`')], '57.1% / 99%')).toEqual([])
    expect(researchClaimIssues([item('占比[**超57.1%**](https://example.org/57.1)')], '57.1%')).toHaveLength(1)
    expect(researchClaimIssues([item('超57.1%，不是57.1%的精确值。')], '57.1%')).toHaveLength(1)
  })

  it('does not use an unrelated item, an exact ambiguous measurement or missing/aggregation excerpts as negative proof', () => {
    expect(researchClaimIssues([item('甲观众超60万。'), item('乙观众近60万。', 'n2')], '60万')).toEqual([])
    expect(researchClaimIssues([item('甲占比超99%，乙占比99%。')], '乙占比99%')).toEqual([])
    expect(researchClaimIssues([{ ...item(planned), sources: [...item(planned).sources, { url, role: 'reporting' }] }], '《夏日手记》发行')).toEqual([])
    expect(researchClaimIssues([{ id: 'n1', sources: [{ url, role: 'aggregation', excerpt: planned }] }], '《夏日手记》发行')).toEqual([])
  })

  it.each(['《夏日手记》将于9月7日正式发行', '《夏日手记》已确定将于9月7日发行',
    '《夏日手记》发行预告', '《夏日手记》是否发行尚未核实', '《夏日手记》尚未发行',
    '《夏日手记》正式发布曲目列表', '正式发布《夏日手记》的预告片', '《夏日手记》的曲目列表已经发布',
    '《冬日来信》已于9月7日发行'])('does not confuse a plan, promotional object or another work with completed release: %s', (claim) => {
    expect(researchClaimIssues([item(planned)], claim)).toEqual([])
  })

  it.each(['《夏日手记》已发行', '《夏日手记》将于9月7日发行，另已正式推出《夏日手记》',
    '《夏日手记》已于9月7日发行（原稿为发行前预告）'])('does not let a separate disclaimer license a completed assertion: %s', (claim) => {
    expect(researchClaimIssues([item(planned)], claim)).toContainEqual(expect.objectContaining({ code: 'planned_event_status' }))
  })

  it('makes its non-entailment boundary explicit: unnamed/anaphoric assertions still require editorial review', () => {
    expect(researchClaimIssues([item(planned)], '《夏日手记》计划发布，现已发行')).toEqual([])
    expect(researchClaimIssues([item(planned)], '专辑已经发行。')).toEqual([])
  })

  it('recognizes formal future wording and permits an explicitly corroborated completed release without mutating the sources', () => {
    const source = item('《夏日手记》将于9月7日正式发行。')
    expect(researchClaimIssues([source], '《夏日手记》发行')).toHaveLength(1)
    source.sources.push({ url: 'https://example.org/follow-up', role: 'primary', excerpt: '《夏日手记》已于9月7日发行。' })
    const before = JSON.stringify(source)
    expect(researchClaimIssues([source], '《夏日手记》已于9月7日发行')).toEqual([])
    expect(JSON.stringify(source)).toBe(before)
  })

  it('checks each rendered-source block, preserving inline text/units but never borrowing a footer qualification', () => {
    const sources = [item('观众超182万，满意度超99%。' + planned)]
    const bad = '<body><div>182<sup>万</sup></div><div>99<sup>%</sup></div><footer>来源：观众超182万，满意度超99%。</footer><p>已推出专辑《夏日手记》。</p><p>原稿为预告。</p></body>'
    expect(researchHtmlClaimGap(sources, bad)).toMatch(/quantity_qualification.*planned_event_status/u)
    const good = '<body><div>超182<sup>万</sup></div><div>超99<sup>%</sup></div><p>计划推出专辑《夏日手记》。</p></body>'
    expect(researchHtmlClaimGap(sources, good)).toBeUndefined()
    expect(researchHtmlClaimGap(sources, '<body><script>182万</script><style>99%</style><template>99%</template><div hidden>99%</div><svg><text>99%</text></svg>无有关主张</body>')).toBeUndefined()
    expect(researchHtmlClaimGap(sources, '<div>超</div><div>99%</div>')).toContain('quantity_qualification')
    expect(researchHtmlClaimGap(sources, '<p>超<span>99</span><sup>&#37;</sup></p>')).toBeUndefined()
  })

  it('refuses oversized HTML instead of certifying an unexamined suffix', () => {
    expect(researchHtmlClaimGap([item(planned)], '<!--' + 'x'.repeat(2_000_001) + '-->')).toContain('incomplete')
  })
})
