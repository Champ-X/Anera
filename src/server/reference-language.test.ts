import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  assertReferenceLanguageFontCoverage, createReferenceLanguageVariant, fetchReferenceLanguageDesign,
  normalizeReferenceLanguageVariant, PINK_SCRIPT_DESIGN_SHA256, PINK_SCRIPT_DESIGN_URL,
  PINK_SCRIPT_SOURCE_SHA256, PINK_SCRIPT_SOURCE_URL, referenceLanguageCharacters, referenceLanguageFontLink,
  referenceLanguageRole, referenceLanguageRunStyle, referenceLanguageText, verifyReferenceLanguageMarkup,
  type ReferenceLanguageVariant,
} from './reference-language.js'
import { referenceTemplateTextParents } from './reference-template.js'

// Small structural fixtures exercise the markup validator, not provenance of
// a real public template. The production factory separately checks BOTH
// complete source hashes and Browser-observed source paths; the component
// canary covers that positive production path with actual retrieved bytes.
function plan(): ReferenceLanguageVariant {
  const core = {
    version: 1 as const, adapter: 'pink-script-zh-cn-v1' as const, language: 'zh-CN' as const,
    sourceSha256: PINK_SCRIPT_SOURCE_SHA256, designUrl: PINK_SCRIPT_DESIGN_URL, designSha256: PINK_SCRIPT_DESIGN_SHA256,
    layouts: ['cover', 'content', 'closing'].map((name, index) => ({ variant: `v${index + 1}`, classes: `slide ${name}` })),
    bindings: [
      { variant: 'v1', slot: 't1', path: [0], role: 'display' as const },
      { variant: 'v2', slot: 't1', path: [0], role: 'body' as const },
      { variant: 'v3', slot: 't1', path: [0], role: 'label' as const },
    ],
  }
  return { ...core, manifestSha256: createHash('sha256').update(JSON.stringify(core)).digest('hex') }
}

function candidate() {
  const value = plan()
  return `<!doctype html><html><head><title>中文</title></head><body>${value.layouts.map((layout, index) => {
    const binding = value.bindings[index]
    return `<section class="${layout.classes}" data-anera-cjk-variant="${layout.variant}"><p>${referenceLanguageText('NEWS 新闻 2.7237%', binding)}</p></section>`
  }).join('')}</body></html>`
}

describe('source-authorized CJK typography', () => {
  it('leaves Latin text and numbers outside CJK runs and uses the documented weights', () => {
    for (const binding of plan().bindings) {
      const html = referenceLanguageText('CCTV-8 中文，周报 2.7237% <literal>', binding)
      expect(html).toMatch(/^<span data-anera-cjk-text="t1">CCTV-8 <span data-anera-cjk=/)
      expect(html).toContain('</span> 2.7237% &lt;literal&gt;')
      expect(html).toContain(binding.role === 'display' ? 'font-weight:900' : 'font-weight:400')
      expect(html).toContain('font-size:inherit;font-style:normal;font-synthesis:none')
      expect(html).toContain('letter-spacing:0;text-transform:none')
      expect(referenceLanguageText('NEWS 09 / 10', binding)).toBe('NEWS 09 / 10')
    }
    expect(referenceLanguageRunStyle('body')).toContain('line-height:1.8')
    expect(referenceLanguageRunStyle('display')).toContain('line-height:1.2')
    expect(referenceLanguageRunStyle('label')).not.toContain('line-height:')
    expect(referenceLanguageText('！', plan().bindings[2])).toContain('<span')
    expect(referenceLanguageText('中文', plan().bindings[0], 'svg')).toMatch(/^<tspan data-anera-cjk-text="t1"><tspan .*中文<\/tspan><\/tspan>$/)
  })

  it('maps only the actual source primary font, not a fallback name or prose description', () => {
    expect(referenceLanguageRole('"DM Serif Display", serif')).toBe('display')
    expect(referenceLanguageRole('Inter, sans-serif')).toBe('body')
    expect(referenceLanguageRole("'JetBrains Mono', monospace")).toBe('label')
    expect(() => referenceLanguageRole('Arial, Inter')).toThrow(/Unsupported/)
    expect(() => referenceLanguageRole('Noto Serif SC')).toThrow(/Unsupported/)
  })

  it('verifies every marked run and rejects weakened, missing or moved typography', () => {
    const html = candidate()
    expect(verifyReferenceLanguageMarkup(html, plan())).toEqual({ characters: '中文新闻', runCount: 3 })
    expect(() => verifyReferenceLanguageMarkup(html.replace('font-weight:900', 'font-weight:400'), plan())).toThrow(/exact typography/)
    expect(() => verifyReferenceLanguageMarkup(html.replace('data-anera-cjk="display"', 'data-anera-cjk="body"'), plan())).toThrow(/exact typography/)
    expect(() => verifyReferenceLanguageMarkup(html.replace('NEWS <span', '漏字 NEWS <span'), plan())).toThrow(/lacks/)
    expect(() => verifyReferenceLanguageMarkup(html.replace('<p>', '<p><i>').replace('</p>', '</i></p>'), plan())).toThrow(/moved away/)
    expect(() => verifyReferenceLanguageMarkup(html.replace('slide cover', 'slide content'), plan())).toThrow(/layout identity/)
    expect(() => verifyReferenceLanguageMarkup(html.replace('data-anera-cjk-variant="v1"', ''), plan())).toThrow(/layout identity/)
    expect(() => verifyReferenceLanguageMarkup(html.replace('</body>', '<p>外部</p></body>'), plan())).toThrow(/escaped/)
    expect(verifyReferenceLanguageMarkup(html.replace('<p><span', '<p><a href="https://news.example/report" style="color:inherit;text-decoration:inherit"><span')
      .replace('2.7237%</span></p>', '2.7237%</span></a></p>'), plan()).runCount).toBe(3)
  })

  it.each(['Asia/Shanghai', '2026', ' ', '/', '&amp;', '\n'])(
    'diagnoses non-CJK content %j independently of correct source typography', (content) => {
      const binding = plan().bindings[1]
      const valid = referenceLanguageText('新闻', binding)
      const invalid = valid.replace('>新闻</span>', `>新闻${content}</span>`)
      const html = `<section class="slide content" data-anera-cjk-variant="v2"><p>${invalid}</p></section>`
      expect(() => verifyReferenceLanguageMarkup(html, plan())).toThrow(/CJK run v2\.t1 contains non-CJK text/)
      expect(() => verifyReferenceLanguageMarkup(html, plan())).toThrow(/Latin letters, numbers, whitespace and ASCII punctuation outside the inner data-anera-cjk run but inside the same data-anera-cjk-text group/)
      expect(() => verifyReferenceLanguageMarkup(html, plan())).toThrow(/Preserve the source-authorized role and exact typography/)
      const repaired = referenceLanguageText(`新闻${content === '&amp;' ? '&' : content}`, binding)
      expect(verifyReferenceLanguageMarkup(html.replace(invalid, repaired), plan()).runCount).toBe(1)
    },
  )

  it('distinguishes malformed run structure from role, style and script segmentation errors', () => {
    const html = candidate()
    expect(() => verifyReferenceLanguageMarkup(html.replace('>新闻</span>', '><b>新闻</b></span>'), plan()))
      .toThrow(/CJK run v1\.t1 has invalid structure/)
    expect(() => verifyReferenceLanguageMarkup(html.replace('data-anera-cjk="display"', 'data-anera-cjk="display" title="extra"'), plan()))
      .toThrow(/CJK run v1\.t1 has invalid structure/)
    expect(() => verifyReferenceLanguageMarkup(html.replace('>新闻</span>', '></span>'), plan()))
      .toThrow(/CJK run v1\.t1 has invalid structure/)
    expect(() => verifyReferenceLanguageMarkup(html.replace('data-anera-cjk-slot="t1"', 'data-anera-cjk-slot="t2"'), plan()))
      .toThrow(/source-authorized role and exact typography/)
    const withTwoErrors = html.replace('font-weight:900', 'font-weight:400').replace('>新闻</span>', '>新闻Asia/Shanghai</span>')
    expect(() => verifyReferenceLanguageMarkup(withTwoErrors, plan())).toThrow(/differs from its source-authorized role and exact typography/)
  })

  it('extracts decoded final text including CJK punctuation and astral Han, never scripts, CSS or hrefs', () => {
    const chars = referenceLanguageCharacters('<title>中文</title><p>&#x4e2d;文𠀀，</p><a href="https://example/假">中</a><style>伪</style><script>虚</script><template>错</template>')
    expect(chars).toBe('中文，𠀀')
    const link = referenceLanguageFontLink(chars)
    const url = new URL(link.match(/href="([^"]+)"/)![1].replaceAll('&amp;', '&'))
    expect(url.searchParams.get('text')).toBe(chars)
    expect(url.searchParams.getAll('family')).toEqual(['Noto Sans SC:wght@400', 'Noto Serif SC:wght@400;900'])
    expect(() => referenceLanguageFontLink('文字字')).toThrow(/canonical/)
    expect(() => referenceLanguageFontLink('ABC')).toThrow(/canonical/)
    expect(() => referenceLanguageCharacters(`<p>${Array.from({ length: 2_049 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join('')}</p>`)).toThrow(/bounded coverage/)
  })

  it('requires glyph ranges for both CJK families and both documented serif weights', () => {
    const face = (family: string, weight: string, range: string) => `@font-face{font-family:'${family}';font-weight:${weight};unicode-range:${range};}`
    const serif = face('Noto Serif SC', '400 900', 'U+4E00-9FFF')
    const sans = face('Noto Sans SC', '400', 'U+4???')
    expect(() => assertReferenceLanguageFontCoverage(serif + sans, '中文')).toThrow(/Missing/)
    const css = serif + face('Noto Sans SC', '400', 'U+4E00-9FFF')
    expect(() => assertReferenceLanguageFontCoverage(css, '中文')).not.toThrow()
    expect(() => assertReferenceLanguageFontCoverage(css, '𠀀')).toThrow(/U\+20000/)
    expect(() => assertReferenceLanguageFontCoverage(css.replace('400 900', '400'), '中')).toThrow(/900/)
    expect(() => assertReferenceLanguageFontCoverage(css.replaceAll('unicode-range:', 'unknown-range:'), '中')).toThrow(/Missing/)
    expect(() => assertReferenceLanguageFontCoverage(css.replaceAll('font-weight:', 'font-style:italic;font-weight:'), '中')).toThrow(/Missing/)
  })

  it('binds complete identities and rejects invented source authorization or altered manifests', () => {
    expect(normalizeReferenceLanguageVariant(plan())).toEqual(plan())
    for (const patch of [{ sourceSha256: 'a'.repeat(64) }, { designSha256: 'b'.repeat(64) }, { designUrl: 'https://unrelated.example/design.md' }, { manifestSha256: 'c'.repeat(64) }]) {
      expect(() => normalizeReferenceLanguageVariant({ ...plan(), ...patch })).toThrow()
    }
    const changed = plan()
    changed.bindings[0].role = 'body'
    expect(() => normalizeReferenceLanguageVariant(changed)).toThrow(/digest/)
    expect(() => createReferenceLanguageVariant('<html>fake</html>', PINK_SCRIPT_SOURCE_URL, 'Noto Serif SC 900', [], [])).toThrow(/exact source/)
  })

  it('rejects changed, redirected, oversized or interrupted author-document downloads', async () => {
    const fetch = vi.fn(async (_url: unknown) => new Response('Noto Serif SC 900'))
    await expect(fetchReferenceLanguageDesign(new AbortController().signal, fetch as typeof globalThis.fetch)).rejects.toThrow(/changed/)
    expect(fetch.mock.calls[0][0]).toBe(PINK_SCRIPT_DESIGN_URL)
    await expect(fetchReferenceLanguageDesign(new AbortController().signal, (async () => new Response('x'.repeat(256 * 1024 + 1))) as typeof globalThis.fetch)).rejects.toThrow(/bounded/)
    const redirected = new Response('document')
    Object.defineProperty(redirected, 'url', { value: 'https://other.example/design.md' })
    await expect(fetchReferenceLanguageDesign(new AbortController().signal, (async () => redirected) as typeof globalThis.fetch)).rejects.toThrow(/exact original/)
    const abort = new AbortController()
    abort.abort(new Error('fixture abort'))
    await expect(fetchReferenceLanguageDesign(abort.signal, (async () => new Response('body')) as typeof globalThis.fetch)).rejects.toThrow(/fixture abort/)
  })

  it('locates source parents independently of replacement text lengths or optional unit slot IDs', () => {
    const html = '<!doctype html><html><head><title>Demo</title></head><body><main><section class="slide cover"><h1>Title <em>word</em></h1></section><section class="slide content"><p>Body</p><div>42<sup>%</sup></div></section><section class="slide closing"><p>Sources</p></section></main></body></html>'
    expect(referenceTemplateTextParents(html, PINK_SCRIPT_SOURCE_URL)).toEqual([
      { variant: 'v1', slot: 't1', path: [0] }, { variant: 'v1', slot: 't2', path: [0, 0] },
      { variant: 'v2', slot: 't1', path: [0] }, { variant: 'v2', slot: 't2', path: [1] },
      { variant: 'v2', slot: 't3', path: [1, 0] }, { variant: 'v3', slot: 't1', path: [0] },
    ])
  })
})
