import { describe, expect, it } from 'vitest'
import { verifyHtmlAgainstReferenceStyle, type ReferenceStyleContract } from './reference-style.js'

const contract: ReferenceStyleContract = {
  sourceUrl: 'https://example.com/deck.html', strictness: 'exact',
  colors: ['#1a1218', '#0a0709', '#050306'], fonts: ['Inter'],
  layout: ['fixed slide stage'], components: ['slide'],
  requiredMarkers: ['deck-stage>section.slide'], signature: 'Dark editorial deck',
  avoid: [], viewport: { width: 1920, height: 1080 },
}
const base = 'deck-stage>section.slide{visibility:hidden;opacity:0;background:radial-gradient(ellipse at 30% 30%,#1a1218,#0a0709,#050306)}'
const verify = (css: string, body = '<deck-stage><section class="slide active"><h1>Cover</h1></section></deck-stage>') => (
  verifyHtmlAgainstReferenceStyle(`<html><head><style>body{font-family:Inter}${css}</style></head><body>${body}</body></html>`, contract, undefined, {
    runtimeManagedSlideSelectors: ['deck-stage>section.slide'],
  })
)

describe('runtime slide visibility uses the same DOM instance and CSS cascade', () => {
  it.each(['.slide.active', 'section.slide.active', 'deck-stage > .slide.active'])(
    'accepts a real active slide selected by %s, including the failed session selector',
    (selector) => {
      expect(verify(`${base}${selector}{visibility:visible;opacity:1}`)).toMatchObject({
        fidelity: 'pass', missing: { colors: [], fonts: [], markers: [] },
      })
    },
  )

  it.each([
    '.unrelated.active{visibility:visible;opacity:1}',
    '.slide.active h1{visibility:visible;opacity:1}',
    '.active{visibility:visible;opacity:1}',
    '.slide.active{visibility:visible;opacity:0}',
    '.slide.active:hover{visibility:visible;opacity:1}',
    '.slide.active{visibility:visible;opacity:1}.slide.active{visibility:hidden}',
    '.slide.active{visibility:visible;opacity:1}deck-stage>section.slide.active{display:none}',
  ])('rejects an ineffective activation: %s', (override) => {
    expect(verify(`${base}${override}`).missing.markers).toContain('deck-stage>section.slide')
  })

  it('does not borrow activation from a different element', () => {
    expect(verify(`${base}.slide.active{visibility:visible;opacity:1}`,
      '<section class="slide active">Outside</section><deck-stage><section class="slide">Hidden</section></deck-stage>',
    ).missing.markers).toContain('deck-stage>section.slide')
  })

  it('respects important hiding and important activation', () => {
    const hidden = base.replace('visibility:hidden', 'visibility:hidden!important')
    expect(verify(`${hidden}.slide.active{visibility:visible;opacity:1}`).fidelity).toBe('mismatch')
    expect(verify(`${hidden}.slide.active{visibility:visible!important;opacity:1}`).fidelity).toBe('pass')
  })
})
