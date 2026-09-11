import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from './session-store.js'
import { PINK_SCRIPT_SOURCE_SHA256, PINK_SCRIPT_SOURCE_URL } from './reference-language.js'
import { latestSuccessfulReferenceStyleContract } from './reference-style.js'
import { visualWebArtifactRequiredToolNames, visualWebArtifactPhaseInstruction } from './agent-service.js'
import type { ModelMessage } from '../shared/types.js'
import {
  composeReferenceTemplate,
  materializeReferenceTemplateDependencies,
  normalizeReferenceTemplateCatalog,
  referenceTemplateBindingReview,
  referenceTemplateCatalog,
  referenceTemplateRuntimeEvidence,
  REFERENCE_TEMPLATE_MAX_SCRIPT_BYTES,
} from './reference-template.js'

import { sourceUrl, newsUrl, css, source, script, dependency, catalog, slides, input } from './test-support/reference-template-fixtures.js'

describe('source-bound reference template composition', () => {
  it('exposes actual text slots and preserves every CSS byte and original runtime dependency', () => {
    expect(catalog.variants[1].slots[0]).toMatchObject({ id: 't1', sample: 'Demo claim & data', element: 'p' })
    const result = composeReferenceTemplate(input())
    expect(result.html).toContain(`<style>${css}</style>`)
    expect(result.html).toContain('<title>中文周报</title>')
    expect(result.html).toContain('这是来源明确的内容 &lt;不是 HTML&gt;')
    expect(result.html).toContain(`href="${newsUrl}"`)
    expect(result.html).not.toContain('Demo claim')
    expect(result.html).not.toContain('Old cover')
    expect(result.html).not.toContain('src="data:text/javascript')
    const encoded = result.html.match(/atob\("([^"]+)"\)/)![1]
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(script)
    expect(result.dependencies).toEqual([{ url: dependency.url, sha256: dependency.sha256, bytes: dependency.bytes }])
    expect(result.slideCount).toBe(3)
  })

  it('selects and repeats real interior layouts without imposing the source demo page count', () => {
    const result = composeReferenceTemplate({ ...input(), slides: [slides[0], ...Array.from({ length: 7 }, () => slides[1]), slides[2]] })
    expect(result.slideCount).toBe(9)
    expect(result.html.match(/class="slide quote"/g)).toHaveLength(7)
    expect(result.html).toContain(`<style>${css}</style>`)
  })

  it('fails closed on omitted, invented, or invalid content bindings instead of copying demo facts', () => {
    const invalidBindings: Array<Record<string, string>> = [{ t1: 'New claim' }, { t1: 'New claim', t2: '', t3: 'Unknown' }]
    for (const texts of invalidBindings) {
      expect(() => composeReferenceTemplate({ ...input(), slides: [slides[0], { ...slides[1], texts }, slides[2]] }))
        .toThrow(/binding gap/)
    }
    expect(() => composeReferenceTemplate({ ...input(), sourceSha256: 'a'.repeat(64) })).toThrow(/SHA-256/)
    expect(() => composeReferenceTemplate({ ...input(), dependencies: [{ ...dependency, content: 'tampered' }] })).toThrow(/corrupted/)
    expect(() => composeReferenceTemplate({ ...input(), allowedSourceUrls: [] })).toThrow(/no allowed retrieved source/)
    expect(() => composeReferenceTemplate({ ...input(), slides: [slides[1], slides[0], slides[2]] })).toThrow(/cover and closing/)
  })

  it('reports independent order, slot and citation gaps together before materializing a deck', () => {
    const invalid = [slides[0], { ...slides[1], texts: { t1: 'New claim', n1: 'not a slot' },
      links: { t1: 'https://news.example/unread' } }, slides[1]]
    const before = JSON.stringify(invalid)
    let message = ''
    try { composeReferenceTemplate({ ...input(), slides: invalid }) } catch (error) { message = (error as Error).message }
    expect(message).toContain('cover and closing')
    expect(message).toContain('Slide 2 binding gap: missing=t2; unknown=n1')
    expect(message).toContain('Slide 2 citation t1 has no allowed retrieved source URL')
    expect(message).toContain('last variant "v3"')
    expect(JSON.stringify(invalid)).toBe(before)
  })

  it.each([
    { texts: { t1: 'Claim', t2: 'Source' }, links: { n1: newsUrl } },
    { texts: { t1: 'Claim', t2: '' }, links: { t2: newsUrl } },
    { texts: { t1: 'Claim' }, links: { t2: newsUrl } },
    { texts: { t1: 'Claim', t2: 'Source' }, links: { t2: 'javascript:alert(1)' } },
    { texts: { t1: 'Claim', t2: 'Source' }, links: { t2: 'https://user:secret@news.example/article' } },
    { texts: { t1: 'Claim', t2: 'Source' }, links: { t2: 'https://news.example/unread' } },
  ])('never counts an unusable citation binding as news coverage: %j', (bindings) => {
    const review = referenceTemplateBindingReview(catalog, [slides[0], { ...slides[1], ...bindings }, slides[2]], [newsUrl])
    expect(review.issues.length).toBeGreaterThan(0)
    expect(review.citationUrls).toEqual([])
  })

  it('keeps valid citation evidence while reporting unrelated closing gaps, normalizing only URL fragments', () => {
    const review = referenceTemplateBindingReview(catalog, [slides[0], slides[1], {
      ...slides[1], links: { t2: `${newsUrl}#section` },
    }], [newsUrl])
    expect(review.issues.join('\n')).toContain('last variant "v3"')
    expect(review.citationUrls).toEqual([newsUrl])
    const query = referenceTemplateBindingReview(catalog, [slides[0], { ...slides[1], links: { t2: `${newsUrl}?other=1` } }, slides[2]], [newsUrl])
    expect(query.citationUrls).toEqual([])
  })

  it('bounds diagnostics while examining every allowed slide and labels omitted issues honestly', () => {
    const invalid = [slides[0], ...Array.from({ length: 62 }, () => ({ ...slides[1], label: '', texts: {} })), slides[2]]
    const review = referenceTemplateBindingReview(catalog, invalid, [newsUrl])
    expect(review.issues.length).toBeLessThanOrEqual(18)
    expect(review.issues.join('\n')).toContain('additional binding issues remain')
    expect(review.citationUrls).toEqual([])
  })

  it.each([null, {}, [], [null, null, null], [slides[0], { variant: 'v999' }, slides[2]]])
    ('reports malformed binding input without throwing or inventing citation coverage: %j', (candidate) => {
      const review = referenceTemplateBindingReview(catalog, candidate, [newsUrl])
      expect(review.issues.length).toBeGreaterThan(0)
      expect(review.citationUrls).toEqual([])
    })

  it('binds symbol-only units without shifting existing text IDs or changing the source DOM/CSS', () => {
    const statsSource = source.replace('<p>Demo claim &amp; data</p>', '<div class="figure">85<sup>%</sup></div><div class="figure">12<sup>×</sup></div><div class="figure">9<sup>分</sup></div><span class="decoration">→</span>')
    const stats = referenceTemplateCatalog(statsSource, sourceUrl)
    expect(stats.version).toBe(3)
    expect(stats.variants[1].slots).toEqual([
      { id: 't1', element: 'div.figure', sample: '85' },
      { id: 't2', element: 'div.figure', sample: '12' },
      { id: 't3', element: 'div.figure', sample: '9' },
      { id: 't4', element: 'sup', sample: '分', role: 'unit', allowEmpty: true, linkable: false },
      { id: 't5', element: 'cite', sample: 'Demo source' },
      { id: 't6', element: 'sup', sample: '%', role: 'unit', allowEmpty: true, linkable: false },
      { id: 't7', element: 'sup', sample: '×', role: 'unit', allowEmpty: true, linkable: false },
    ])
    const statsSlide = { variant: 'v2', label: '有来源的统计', texts: { t1: '2', t2: '54', t3: '8.4', t4: '分', t5: '报道', t6: '', t7: '国/地区' }, links: { t5: newsUrl } }
    const statsInput = { ...input(), source: statsSource, sourceSha256: stats.sourceSha256, slides: [slides[0], statsSlide, slides[2]] }
    const result = composeReferenceTemplate(statsInput)
    expect(result.html).toContain('<div class="figure">2<sup></sup></div>')
    expect(result.html).toContain('<div class="figure">54<sup>国/地区</sup></div>')
    expect(result.html).toContain('<div class="figure">8.4<sup>分</sup></div>')
    expect(result.html).toContain('<span class="decoration">→</span>')
    expect(result.html).toContain(`<style>${css}</style>`)
    const missingUnit = structuredClone(statsInput)
    delete (missingUnit.slides[1].texts as Record<string, string>).t6
    expect(() => composeReferenceTemplate(missingUnit)).toThrow(/missing=t6/)
    const emptyCopy = structuredClone(statsInput)
    emptyCopy.slides[1].texts.t1 = ''
    expect(() => composeReferenceTemplate(emptyCopy)).toThrow(/missing=t1/)
    const linkedUnit = structuredClone(statsInput)
    linkedUnit.slides[1].links = { t6: newsUrl }
    expect(() => composeReferenceTemplate(linkedUnit)).toThrow(/cannot contain/)
  })

  it('does not treat arbitrary superscript annotations or decorative symbols as optional units', () => {
    const annotated = source.replace('<p>Demo claim &amp; data</p>', '<p>Demo claim<sup>note</sup></p><span>%</span><span>→</span>')
    const annotatedCatalog = referenceTemplateCatalog(annotated, sourceUrl)
    expect(annotatedCatalog.variants[1].slots.map((slot) => slot.sample)).toEqual(['Demo claim', 'note', 'Demo source', '%'])
    expect(annotatedCatalog.variants[1].slots.every((slot) => !slot.allowEmpty)).toBe(true)
  })

  it('recognizes magnitude units beside currency-prefixed values without accepting currency-containing prose', () => {
    const currencySource = source.replace('<p>Demo claim &amp; data</p>', '<div>€1.4<sup>M</sup></div><div>about €1.4<sup>M</sup></div><div>Claim 2<sup>e</sup></div>')
    const variants = referenceTemplateCatalog(currencySource, sourceUrl).variants
    const magnitudes = variants[1].slots.filter((slot) => slot.sample === 'M')
    expect(magnitudes[0]).toMatchObject({ role: 'unit', allowEmpty: true, linkable: false })
    expect(magnitudes[1].allowEmpty).toBeUndefined()
    expect(variants[1].slots.find((slot) => slot.sample === 'e')?.allowEmpty).toBeUndefined()
  })

  it('marks only the reviewed source ordinal as optional while keeping the real source text IDs and CSS', async () => {
    const original = await readFile(new URL('./fixtures/pink-script-template.fixture.html', import.meta.url), 'utf8')
    const actual = referenceTemplateCatalog(original, PINK_SCRIPT_SOURCE_URL)
    expect(actual.sourceSha256).toBe(PINK_SCRIPT_SOURCE_SHA256)
    expect(actual.version).toBe(3)
    expect(actual.variants[0].slots.find((slot) => slot.id === 't12')).toEqual({
      id: 't12', element: 'sup', sample: 'e', role: 'ordinal', allowEmpty: true, linkable: false,
    })
    expect(actual.variants[2].slots.find((slot) => slot.id === 't15')).toEqual({
      id: 't15', element: 'sup', sample: 'M', role: 'unit', allowEmpty: true, linkable: false,
    })
    const selected = ['v1', 'v3', 'v9'].map((id) => {
      const variant = actual.variants.find((item) => item.id === id)!
      return { variant: id, label: 'Synthetic affix specimen', texts: Object.fromEntries(variant.slots.map((slot) => [slot.id, slot.allowEmpty ? '' : slot.sample])) }
    })
    selected[0].texts.t11 = '影视 · 相声 · 文娱'
    const compiled = composeReferenceTemplate({ source: original, sourceUrl: PINK_SCRIPT_SOURCE_URL,
      sourceSha256: actual.sourceSha256, title: 'Affix specimen', slides: selected, allowedSourceUrls: [],
      dependencies: [{ ...dependency, url: new URL('deck-stage.js', PINK_SCRIPT_SOURCE_URL).href }],
    })
    expect(compiled.html).toContain('影视 · 相声 · 文娱<sup style="font-size:.5em"></sup>')
    expect(compiled.html).toContain('€1.4<sup></sup>')
    for (const style of original.match(/<style\b[^>]*>[\s\S]*?<\/style>/gu) ?? []) expect(compiled.html).toContain(style)
    const changed = referenceTemplateCatalog(original.replace('Paris · 11', 'Claim 11'), PINK_SCRIPT_SOURCE_URL)
    expect(changed.variants[0].slots.find((slot) => slot.id === 't12')?.allowEmpty).toBeUndefined()
    delete selected[0].texts.t12
    expect(() => composeReferenceTemplate({ source: original, sourceUrl: PINK_SCRIPT_SOURCE_URL,
      sourceSha256: actual.sourceSha256, title: 'Missing ordinal', slides: selected, allowedSourceUrls: [],
      dependencies: [{ ...dependency, url: new URL('deck-stage.js', PINK_SCRIPT_SOURCE_URL).href }],
    })).toThrow(/missing=t12/)
  })

  it('aggregates binding gaps across slides before creating any output', () => {
    expect(() => composeReferenceTemplate({ ...input(), slides: [
      { ...slides[0], texts: {} }, { ...slides[1], texts: { t1: 'Claim' } }, { ...slides[2], texts: {} },
    ] })).toThrow(/Slide 1 binding gap: missing=t1[\s\S]*Slide 2 binding gap: missing=t2[\s\S]*Slide 3 binding gap: missing=t1/)
  })

  it('keeps legacy catalog identity for explicit upgrade and rejects forged optional-slot metadata', () => {
    const forged = structuredClone(catalog)
    Object.assign(forged.variants[1].slots[0], { allowEmpty: true })
    expect(() => normalizeReferenceTemplateCatalog(forged, catalog.sourceSha256, sourceUrl)).toThrow(/content slot/)
    for (const version of [1, 2] as const) {
      const legacy = { ...catalog, version }
      expect(normalizeReferenceTemplateCatalog(legacy, catalog.sourceSha256, sourceUrl).version).toBe(version)
      const legacyGap = { missingPhases: ['html_artifact' as const], referenceContract: {
        templateCatalog: legacy,
      } } as Parameters<typeof visualWebArtifactRequiredToolNames>[0]
      expect([...visualWebArtifactRequiredToolNames(legacyGap)!]).toEqual(['record_reference_style'])
      expect(visualWebArtifactPhaseInstruction(legacyGap)).toMatch(new RegExp(`catalog.*v${version}[\\s\\S]*record_reference_style[\\s\\S]*unit`, 'i'))
      const oldOrdinal = structuredClone(legacy)
      Object.assign(oldOrdinal.variants[1].slots[0], { role: 'ordinal', allowEmpty: true, linkable: false })
      expect(() => normalizeReferenceTemplateCatalog(oldOrdinal, catalog.sourceSha256, sourceUrl)).toThrow(/content slot/)
    }
  })

  it('rejects escaping dependency paths, module graphs, or script blocks inside repeatable content', () => {
    for (const path of ['../other.js', 'https://other.example/x.js', 'file:///tmp/source.js', '//other.example/x.js']) {
      expect(() => referenceTemplateCatalog(source.replace('deck-stage.js', path), sourceUrl)).toThrow(/same source directory/)
    }
    expect(() => referenceTemplateCatalog(source.replace('<script src=', '<script type="module" src='), sourceUrl)).toThrow(/classic/)
    expect(() => referenceTemplateCatalog(source.replace('<p>', '<script>alert(1)</script><p>'), sourceUrl)).toThrow(/executable/)
  })

  it('downloads only declared script bytes with a bounded stream and records their digest', async () => {
    const fetch = vi.fn(async () => new Response(script, { headers: { 'Content-Type': 'text/javascript' } }))
    await expect(materializeReferenceTemplateDependencies(catalog, sourceUrl, new AbortController().signal, fetch as typeof globalThis.fetch))
      .resolves.toEqual([dependency])
    expect(fetch).toHaveBeenCalledOnce()
    for (const payload of ['<!doctype html><html>error</html>', 'x'.repeat(REFERENCE_TEMPLATE_MAX_SCRIPT_BYTES + 1)]) {
      await expect(materializeReferenceTemplateDependencies(catalog, sourceUrl, new AbortController().signal,
        (async () => new Response(payload)) as typeof globalThis.fetch)).rejects.toThrow(/JavaScript|bounded/)
    }
    const abort = new AbortController()
    abort.abort()
    await expect(materializeReferenceTemplateDependencies(catalog, sourceUrl, abort.signal, fetch as typeof globalThis.fetch)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects unbound demo attributes, nested links, excessive structure and excessive expanded output', () => {
    for (const attribute of ['title="Demo description"', 'aria-label="Demo label"', 'href="https://demo.example"']) {
      expect(() => referenceTemplateCatalog(source.replace('<p>', `<p ${attribute}>`), sourceUrl)).toThrow(/attributes require explicit bindings/)
    }
    const buttonSource = source.replace('<cite>', '<button>').replace('</cite>', '</button>')
    const buttonCatalog = referenceTemplateCatalog(buttonSource, sourceUrl)
    expect(buttonCatalog.variants[1].slots[1].linkable).toBe(false)
    expect(() => composeReferenceTemplate({ ...input(), source: buttonSource, sourceSha256: buttonCatalog.sourceSha256 }))
      .toThrow(/nested or non-HTML/)
    const deep = source.replace('<p>', `${'<div>'.repeat(150)}<p>`).replace('</p>', `</p>${'</div>'.repeat(150)}`)
    expect(() => referenceTemplateCatalog(deep, sourceUrl)).toThrow(/node count or depth/)
    const wide = source.replace('<p>', `${'<i></i>'.repeat(16_000)}<p>`)
    expect(() => referenceTemplateCatalog(wide, sourceUrl)).toThrow(/node count or depth/)
    expect(() => composeReferenceTemplate({ ...input(), slides: [slides[0], ...Array.from({ length: 62 }, () => ({
      ...slides[1], texts: { t1: '&'.repeat(2_000), t2: '&'.repeat(2_000) },
    })), slides[2]] })).toThrow(/bounded output size/)
  })

  it('replaces original speaker notes with task labels without a raw-text injection boundary', () => {
    const withNotes = source.replace('</body>', '<script type="application/json" id="speaker-notes">["Old demo narration"]</script></body>')
    const noteSlides = slides.map((slide) => ({ ...slide, label: `${slide.label}</script><script>untrusted` }))
    const result = composeReferenceTemplate({ ...input(), source: withNotes,
      sourceSha256: referenceTemplateCatalog(withNotes, sourceUrl).sourceSha256, slides: noteSlides })
    expect(result.html).not.toContain('Old demo narration')
    const json = result.html.match(/id="speaker-notes">([\s\S]*?)<\/script>/)![1]
    expect(json).not.toContain('<script>')
    expect(JSON.parse(json)).toEqual(noteSlides.map((slide) => slide.label))
  })

  it('preserves word boundaries around source inline emphasis and citation wrappers', () => {
    const emphasized = source.replace('Demo claim &amp; data', 'Before <em>demo</em> after')
    const result = composeReferenceTemplate({ ...input(), source: emphasized,
      sourceSha256: referenceTemplateCatalog(emphasized, sourceUrl).sourceSha256,
      slides: [slides[0], { variant: 'v2', label: '正文', texts: { t1: 'New', t2: 'quoted', t3: 'claim', t4: 'Source' }, links: { t3: newsUrl } }, slides[2]] })
    expect(result.html).toContain(`New <em>quoted</em> <a href="${newsUrl}" style="color:inherit;text-decoration:inherit">claim</a>`)
  })

  it('preserves BOM script bytes and cancels an outstanding dependency body read', async () => {
    const bomScript = `\uFEFF${script}`
    const fetched = await materializeReferenceTemplateDependencies(catalog, sourceUrl, new AbortController().signal,
      (async () => new Response(bomScript)) as typeof fetch)
    expect(fetched[0].content).toBe(bomScript)
    expect(fetched[0].bytes).toBe(Buffer.byteLength(bomScript))
    const controller = new AbortController()
    const cancel = vi.fn()
    const pending = materializeReferenceTemplateDependencies(catalog, sourceUrl, controller.signal,
      (async () => new Response(new ReadableStream({ pull() { controller.abort(new Error('cancel stalled dependency')) }, cancel }))) as typeof fetch)
    await expect(pending).rejects.toThrow('cancel stalled dependency')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('recovers the bounded catalog from a durable record and discards only malformed optional metadata', () => {
    const contract = { source_url: sourceUrl, strictness: 'exact', colors: ['#120a10', '#ed3d8c'], fonts: ['Inter'],
      layout: ['full viewport', 'three layouts'], components: ['slide', 'headline'], required_markers: ['.cover', '.display'],
      signature: 'Pink serif', avoid: ['invented colors'], viewport: { width: 1000, height: 600 } }
    const payload = { status: 'success', contract,
      provenance: { resolvedUrl: sourceUrl, evidenceSha256: catalog.sourceSha256, evidenceBytes: Buffer.byteLength(source) },
      composition_template: catalog, runtime_evidence: referenceTemplateRuntimeEvidence(catalog.sourceSha256, sourceUrl, [dependency]) }
    const messages = (composition: unknown): ModelMessage[] => [{ role: 'assistant', content: null, tool_calls: [{
      id: 'record', type: 'function', function: { name: 'record_reference_style', arguments: JSON.stringify(contract) },
    }] }, { role: 'tool', tool_call_id: 'record', tool_result_status: 'succeeded', content: JSON.stringify({ ...payload, composition_template: composition }) }]
    expect(latestSuccessfulReferenceStyleContract(messages(catalog))?.templateCatalog).toEqual(catalog)
    expect(latestSuccessfulReferenceStyleContract(messages(catalog))?.runtimeEvidence).toEqual(payload.runtime_evidence)
    const stale = latestSuccessfulReferenceStyleContract(messages({ ...catalog, sourceSha256: 'a'.repeat(64) }))
    expect(stale?.provenance.evidenceSha256).toBe(catalog.sourceSha256)
    expect(stale?.templateCatalog).toBeUndefined()
  })

  it('keeps runtime bytes private and immutable across restart, and rejects corruption or symlink replacement', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-runtime-evidence-'))
    try {
      const store = new SessionStore(root, 'test-model')
      await store.initialize()
      const session = await store.create()
      const manifest = await store.commitReferenceRuntimeEvidence(session.summary.id, catalog.sourceSha256, sourceUrl, [dependency])
      expect(JSON.stringify(manifest)).not.toContain(dependency.content)
      const restarted = new SessionStore(root, 'test-model')
      await restarted.initialize()
      await expect(restarted.resolveReferenceRuntimeEvidence(session.summary.id, manifest)).resolves.toEqual([dependency])
      const path = resolve(root, 'sessions', session.summary.id, 'reference-style', 'runtime', 'v1', manifest.manifestSha256, `${dependency.sha256}.js`)
      expect(await readFile(path, 'utf8')).toBe(script)
      await writeFile(path, script.replace('define', 'broken'))
      await expect(restarted.resolveReferenceRuntimeEvidence(session.summary.id, manifest)).rejects.toThrow(/corrupted/)
      await expect(restarted.commitReferenceRuntimeEvidence(session.summary.id, catalog.sourceSha256, sourceUrl, [dependency])).rejects.toThrow(/corrupted/)
      await rm(path)
      await symlink(resolve(root, 'sessions', session.summary.id, 'state.json'), path)
      await expect(restarted.resolveReferenceRuntimeEvidence(session.summary.id, manifest)).rejects.toThrow(/metadata mismatch/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

})
