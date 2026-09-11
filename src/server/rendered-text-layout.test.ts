import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { BrowserManager } from './browser-manager.js'
import { extractReferenceStyleSourceProfile, type ReferenceStyleContract } from './reference-style.js'
import { createReferenceProfileFixtureCache } from './test-support/reference-profile-cache.js'
import { verificationAssessment } from './verification-assessment.js'

const managers: BrowserManager[] = []
const servers: Server[] = []
// Reuse only immutable source observations in this file, not an idle renderer.
// Each cache miss owns its source manager and finishes disposal before the
// profile is published. Candidates retain separate managers/contexts, and the
// invalid-source capture below remains uncached. Nothing is stored cross-run.
const sourceProfiles = createReferenceProfileFixtureCache(async ({ html, sourceProfile, evidenceSha256, viewport }) => {
  const sourceManager = new BrowserManager()
  try {
    return await sourceManager.captureReferenceRenderProfile(html, sourceProfile, evidenceSha256, viewport)
  } finally {
    await sourceManager.shutdown()
  }
})
afterAll(() => {
  sourceProfiles.clear()
})
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))))
})

const contract: ReferenceStyleContract = {
  sourceUrl: 'https://example.com/text-fit.html', strictness: 'exact',
  colors: ['#111111', '#fdfae7'], fonts: ['Arial'],
  layout: ['centered intrinsic content with fixed shared chrome'],
  components: ['runner', 'footer', 'hero'], requiredMarkers: ['.slide', '.runner', '.footer', '.hero'],
  signature: 'Content fits between the running header and footer.', avoid: ['text collisions'],
  viewport: { width: 800, height: 600 },
}

function deck(lines = 2, overlappingSource = false): string {
  return `<!doctype html><html><head><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111111;color:#fdfae7;font-family:Arial,sans-serif}
    .slide{position:absolute;inset:0;width:800px;height:600px;display:none;overflow:hidden}.slide.active{display:block}
    .runner,.footer{position:absolute;left:20px;right:20px;display:flex;justify-content:space-between;font-size:20px;line-height:24px}
    .runner{top:24px}.footer{bottom:24px}
    .hero{position:absolute;left:20px;right:20px;top:50%;transform:translateY(-50%)}
    .hero .kicker{font-size:24px;line-height:30px}
    h1{margin:0;font-size:60px;line-height:70px;font-weight:400}
    ${overlappingSource ? '.runner{top:215px}' : ''}
  </style></head><body>${['cover', 'content', 'closing'].map((phase, index) => `
    <section class="slide s-${phase}${index === 0 ? ' active' : ''}">
      <div class="runner"><span>FIELD REPORT</span><span>VOLUME 01</span></div>
      <div class="hero"><div class="kicker">ENTERTAINMENT WEEKLY</div><h1>${Array.from({ length: lines }, () => 'NEWS').join('<br>')}</h1></div>
      <div class="footer"><span>SOURCE NOTES</span><span>${index + 1} / 3</span></div>
    </section>`).join('')}
    <script>const slides=[...document.querySelectorAll('.slide')];let active=0;addEventListener('keydown',event=>{if(event.key==='End')active=2;else if(event.key==='ArrowRight')active=Math.min(2,active+1);slides.forEach((slide,index)=>slide.classList.toggle('active',index===active))})</script>
  </body></html>`
}

async function fixture(source: string, candidate: string) {
  const manager = new BrowserManager()
  managers.push(manager)
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(request.url === '/reference' ? source : candidate)
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const profile = await sourceProfiles.get({
    html: source,
    sourceProfile: extractReferenceStyleSourceProfile(source, contract)!,
    evidenceSha256: 'e'.repeat(64),
    viewport: contract.viewport,
  })
  await manager.setViewport('text-fit', contract.viewport.width, contract.viewport.height)
  await manager.open('text-fit', `http://127.0.0.1:${(server.address() as AddressInfo).port}/candidate`)
  return { manager, profile }
}

describe('rendered text layout', () => {
  it.each(['covering', 'hidden', 'pointer-through', 'behind', 'shadow'] as const)('checks compact external-control interception without treating every overlapping box as a defect: %s', async (mode) => {
    const rules = `.overlay{display:none}@media(max-width:400px){.overlay{display:block;position:fixed;left:20px;top:20px;width:230px;height:45px;z-index:99}}
      ${mode === 'hidden' ? '.overlay{visibility:hidden}' : mode === 'pointer-through' ? '.overlay{pointer-events:none}' : mode === 'behind' ? '.overlay{z-index:-1!important}' : ''}`
    const markup = mode === 'shadow'
      ? `<display-controls></display-controls><script>customElements.define('display-controls',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML=${JSON.stringify(`<style>${rules}</style><button class="overlay" aria-label="Navigate">Next</button>`)}}})</script>`
      : `<style>${rules}</style><button class="overlay" aria-label="Navigate">Next</button>`
    if (mode === 'shadow') expect(() => new Function(markup.match(/<script>([\s\S]*?)<\/script>/u)![1])).not.toThrow()
    const { manager, profile } = await fixture(deck(), deck().replace('</body>', `${markup}</body>`))
    const result = await manager.verifyRenderedReferenceStyleAndScreenshot('text-fit', profile, 'cover')
    const surface = result.verification.surfaceAttestations![0]
    const blocked = mode === 'covering' || mode === 'shadow'
    expect(result.verification.fidelity).toBe(blocked ? 'mismatch' : 'pass')
    expect(surface).toMatchObject({ checked: 5, matched: blocked ? 4 : 5, restored: true, observationGaps: 0 })
    expect(surface.controlOcclusion?.complete).toBe(true)
    expect(surface.controlOcclusion!.sampledRegions).toBeGreaterThan(0)
    if (blocked) {
      expect(surface.controlOcclusion?.collisions).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'FIELD REPORT', control: 'button Navigate' })]))
      expect(surface.violations.join(' ')).toContain('external controls intercept')
    } else expect(surface.controlOcclusion?.collisions).toEqual([])
    expect(result.screenshot!.readUInt32BE(16)).toBe(800)
    expect((await manager.snapshot('text-fit')).viewport).toEqual(contract.viewport)
  }, 30_000)

  it.each([false, true])('preserves bounded control observations and known defects independently (blocked: %s)', async (blocked) => {
    const extra = `<div class="probe-text">${'<span>extra</span>'.repeat(520)}</div>`
    const candidate = deck().replace('<div class="hero">', `${extra}<div class="hero">`).replace('</style>', `
      .probe-text,.probe-button{display:none}
      @media(max-width:400px){.probe-text{display:block}.probe-button{display:block;position:fixed;left:20px;top:20px;width:230px;height:45px;z-index:99}}
      </style>`).replace('</body>', blocked ? '<button class="probe-button">Next</button></body>' : '</body>')
    const { manager, profile } = await fixture(deck(), candidate)
    const result = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    const surface = result.surfaceAttestations![0]
    expect(surface.controlOcclusion?.complete).toBe(false)
    expect(surface.observationGaps).toBe(1)
    expect(surface.restored).toBe(true)
    expect(surface.controlOcclusion!.collisions.length > 0).toBe(blocked)
    expect(verificationAssessment(result.checked, result.matched, result.observationGapCount).status).toBe(blocked ? 'fail' : 'inconclusive')
  }, 30_000)

  it('retains exact screenshot geometry while attesting compact stage visibility and restoring the page', async () => {
    const { manager, profile } = await fixture(deck(), deck())
    const result = await manager.verifyRenderedReferenceStyleAndScreenshot('text-fit', profile, 'cover')
    expect(result.verification.fidelity).toBe('pass')
    expect(result.verification.surfaceAttestations).toEqual([expect.objectContaining({
      surface: 'compact-stage-v1', viewport: { width: 267, height: 200 }, activeIndex: 0,
      checked: 5, matched: 5, restored: true, violations: [],
    })])
    expect(result.screenshot!.readUInt32BE(16)).toBe(800)
    expect(result.screenshot!.readUInt32BE(20)).toBe(600)
    expect((await manager.snapshot('text-fit')).viewport).toEqual(contract.viewport)
  }, 30_000)

  it('rejects content that passes design-size fidelity but disappears on a compact surface', async () => {
    const candidate = deck().replace('</style>', '@media(max-width:400px){.slide{left:600px;top:500px}}</style>')
    const { manager, profile } = await fixture(deck(), candidate)
    const result = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(result.fidelity).toBe('mismatch')
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toContain('compact surface 267x200')
    expect(result.surfaceAttestations?.[0]).toMatchObject({ matched: 3, checked: 4,
      activeRect: [600, 500, 800, 600], restored: true, observationGaps: 0 })
    expect(verificationAssessment(result.checked, result.matched, result.observationGapCount).status).toBe('fail')
    expect((await manager.snapshot('text-fit')).viewport).toEqual(contract.viewport)
  }, 30_000)

  it('checks every interior slide at the compact surface, not only the representative screenshot', async () => {
    const source = deck()
    const content = source.match(/<section class="slide s-content">[\s\S]*?<\/section>/u)![0]
    const candidate = source.replace('<section class="slide s-closing"', `${content.replace('s-content', 's-content later')}<section class="slide s-closing"`)
      .replace('</style>', '@media(max-width:400px){.later{left:600px;top:500px}}</style>')
    const { manager, profile } = await fixture(source, candidate)
    await manager.press('text-fit', 'ArrowRight')
    const result = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'content')
    expect(result.fidelity).toBe('mismatch')
    expect(result.interiorAttestation).toMatchObject({ candidateSlides: 2, matchedSlides: 1 })
    expect(result.surfaceAttestations).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'content slide 3', activeIndex: 2, checked: 4, matched: 3, restored: true }),
    ]))
    expect(result.violations.join('\n')).toContain('compact surface')
    expect((await manager.snapshot('text-fit')).viewport).toEqual(contract.viewport)
  }, 30_000)

  it('rejects a resize-driven ownership change even when another root is visibly painted', async () => {
    const candidate = deck().replace('</script>', `;addEventListener('resize',()=>{
      if(innerWidth<400){slides[0].classList.remove('active');slides[1].classList.add('active')}
    })</script>`)
    expect(() => new Function(candidate.match(/<script>([\s\S]*?)<\/script>/u)![1])).not.toThrow()
    const { manager, profile } = await fixture(deck(), candidate)
    const result = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(result.fidelity).toBe('mismatch')
    expect(result.surfaceAttestations?.[0].restored).toBe(false)
    expect(result.violations.join('\n')).toContain('changed presentation ownership')
    expect(result.violations.join('\n')).toContain('did not restore')
    expect((await manager.snapshot('text-fit')).viewport).toEqual(contract.viewport)
  }, 30_000)

  it.each([1, 0.5])('distinguishes empty font-box space from real ink intersections at scale %s', async (scale) => {
    const source = deck(1).replaceAll('NEWS', 'Hot').replace('</style>', `
      .slide{transform:scale(${scale});transform-origin:top left}
      .hero{position:absolute;inset:0;transform:none}
      .hero .kicker{position:absolute;top:90px;font-size:24px;line-height:24px}
      .hero h1{position:absolute;top:100px;font-size:280px;line-height:280px}
    </style>`)
    const { manager, profile } = await fixture(source, source.replace('top:90px', 'top:140px'))
    // Independent fixture geometry: Arial's big-font ascent box intersects
    // the label at y=90, but its visible uppercase glyphs start well below it.
    // Moving the label down to y=140 intersects those actual glyph bounds.
    expect(profile.phases.cover.textLayout).toEqual({ version: 2, complete: true, collisions: [] })
    const verification = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(verification.fidelity).toBe('mismatch')
    expect(verification.violations.join('\n')).toContain('text collision')
  }, 30_000)

  it('rejects content-only collisions with fixed chrome while retaining intrinsic source geometry', async () => {
    const { manager, profile } = await fixture(deck(), deck(8))
    const verification = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(verification.fidelity).toBe('mismatch')
    expect(verification.violations.join('\n')).toMatch(/text collision/u)
    expect(verification.violations.join('\n')).toMatch(/runner|footer/u)
  }, 30_000)

  it('allows short localized and inline-linked copy without mistaking enclosing boxes for text', async () => {
    const candidate = deck().replaceAll('ENTERTAINMENT WEEKLY', '<a href="#source"><span>本周</span>娱乐</a>')
      .replaceAll('NEWS', '<span>中文</span><span> A</span>')
    const { manager, profile } = await fixture(deck(), candidate)
    const verification = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(verification.violations).toEqual([])
    expect(verification.fidelity).toBe('pass')
  }, 30_000)

  it('preserves a text overlap already measured in the exact source', async () => {
    const { manager, profile } = await fixture(deck(2, true), deck(2, true))
    expect(profile.phases.cover.textLayout?.complete).toBe(true)
    expect(profile.phases.cover.textLayout?.collisions.length).toBeGreaterThan(0)
    const verification = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(verification.violations).toEqual([])
    expect(verification.fidelity).toBe('pass')
  }, 30_000)

  it('ignores hidden, transparent and completely clipped text', async () => {
    const source = deck().replace('</style>', '.runner{pointer-events:none} .hidden{display:none} .transparent{color:transparent} .clipped{position:absolute;width:2px;height:2px;overflow:hidden;left:0;top:0}.clipped span{position:relative;left:100px}</style>')
    const hidden = '<div class="hidden">SECRET</div><div class="transparent">INVISIBLE</div><div class="clipped"><span>CLIPPED</span></div>'
    const candidate = source.replaceAll('<div class="hero">', `${hidden}<div class="hero">`)
    const { manager, profile } = await fixture(source, candidate)
    const verification = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(verification.violations).toEqual([])
  }, 30_000)

  it('still rejects text collisions on pointer-events:none chrome', async () => {
    // Nine lines intersect the runner's actual glyphs. Eight lines intersected
    // only the kicker's em-box fringe and were not an independent ink oracle.
    const { manager, profile } = await fixture(deck(), deck(9).replace('</style>', '.runner{pointer-events:none}</style>'))
    const verification = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(verification.fidelity).toBe('mismatch')
    expect(verification.violations.join('\n')).toMatch(/text collision[^\n]*runner/u)
  }, 30_000)

  it('measures rotated collisions with affine ink geometry instead of horizontal font metrics', async () => {
    const { manager, profile } = await fixture(deck(), deck(9).replace('</style>', 'h1{transform:rotate(3deg)}</style>'))
    const verification = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(verification.fidelity).toBe('mismatch')
    expect(verification.violations.join('\n')).toContain('text collision')
    expect(verification.violations.join('\n')).not.toContain('completely measured')
  }, 30_000)

  it.each(['rotate(3deg)', 'skewX(8deg)', 'rotate(-4deg) scale(0.85,1.1)'])('captures intentional affine overlap and verifies identical geometry: %s', async (transform) => {
    const source = deck(9).replace('</style>', `h1{transform:${transform}}</style>`)
    const { manager, profile } = await fixture(source, source)
    expect(profile.phases.cover.textLayout?.complete).toBe(true)
    expect(profile.phases.cover.textLayout?.collisions.length).toBeGreaterThan(0)
    const result = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(result.fidelity, result.violations.join('\n')).toBe('pass')
  }, 30_000)

  it.each(['rotate(45deg)', 'perspective(500px) rotateY(20deg)'])('keeps unsupported inverse geometry closed: %s', async (transform) => {
    const source = deck(9).replace('</style>', `h1{transform:${transform}}</style>`)
    const manager = new BrowserManager()
    managers.push(manager)
    await expect(manager.captureReferenceRenderProfile(source,
      extractReferenceStyleSourceProfile(source, contract)!, 'e'.repeat(64), contract.viewport))
      .rejects.toThrow('ink_geometry_unavailable')
  }, 30_000)

  it.each([
    ['sibling fan-out', '<i></i>'.repeat(1100)],
    ['element census', '<div>' + '<i></i>'.repeat(12001) + '</div>'],
    ['class census', `<div class="${Array.from({ length: 65 }, (_, index) => `class-${index}`).join(' ')}">Extra copy</div>`],
  ])('fails closed for an unbounded %s without accepting missing observations', async (_label, extra) => {
    const candidate = deck().replace('<div class="hero">', `${extra}<div class="hero">`)
    const { manager, profile } = await fixture(deck(), candidate)
    const verification = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(verification.fidelity).toBe('mismatch')
    expect(verification.violations.join('\n')).toContain('completely measured')
  }, 30_000)

  it('does not publish an incomplete source baseline as an accepted contract', async () => {
    const source = deck().replace('<div class="hero">', `${'<i></i>'.repeat(1100)}<div class="hero">`)
    const manager = new BrowserManager()
    managers.push(manager)
    await expect(manager.captureReferenceRenderProfile(source,
      extractReferenceStyleSourceProfile(source, contract)!, 'e'.repeat(64), contract.viewport))
      .rejects.toThrow(/source text layout.*observation_limit/iu)
  }, 30_000)

  it.each([2, 8])('keeps measurement gaps distinct from measured collisions with %i text lines', async (lines) => {
    const extra = `<div class="${Array.from({ length: 65 }, (_, index) => `probe-${index}`).join(' ')}">Extra copy</div>`
    const candidate = deck(lines).replace('</body>', `${extra}</body>`)
    const { manager, profile } = await fixture(deck(), candidate)
    const result = await manager.verifyRenderedReferenceStyle('text-fit', profile, 'cover')
    expect(result.fidelity).toBe('mismatch') // Neither partial result can pass.
    expect(result.observationGapCount).toBeGreaterThan(0)
    const assessment = verificationAssessment(result.checked, result.matched, result.observationGapCount)
    expect(assessment.status).toBe(lines === 2 ? 'inconclusive' : 'fail')
    expect(result.violations.some((value) => value.includes('text collision'))).toBe(lines === 8)
  }, 30_000)
})
