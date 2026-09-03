import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from './browser-manager.js'
import { BLUE_PROFESSIONAL_TEMPLATE_HTML } from './fixtures/blue-professional-template.fixture.js'
import {
  extractReferenceStyleSourceProfile,
  type ReferenceStyleContract,
} from './reference-style.js'

const managers: BrowserManager[] = []
const servers: Server[] = []
const execFileAsync = promisify(execFile)
const BLUE_PROFESSIONAL_SOURCE = 'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/main/templates/blue-professional/template.html'

const RENDER_CONTRACT: ReferenceStyleContract = {
  sourceUrl: 'https://example.com/reference.html',
  strictness: 'exact',
  colors: ['#fdfae7', '#1e2bfa', '#111111'],
  fonts: ['Space Grotesk', 'Inter'],
  layout: ['full viewport slides', 'diagonal cover and fixed navigation'],
  components: ['slide header and content panel', 'progress chrome and circular navigation'],
  requiredMarkers: ['.layout-cover', '.slide-header', '.progress-bar', '.layout-closing'],
  signature: 'Cream and cobalt presentation with diagonal cover geometry.',
  avoid: ['dark gradient cover'],
  viewport: { width: 1440, height: 900 },
}

function referenceDeckHtml(headline: string, totalSlides = 3, keyboardHint = 'Use arrow keys to navigate'): string {
  const contentSlides = Array.from({ length: Math.max(1, totalSlides - 2) }, (_, index) => `
    <section class="slide"><header class="slide-header"><span>Overview ${index + 1}</span><span>Weekly</span></header><div>Replaceable content ${index + 1}</div></section>`).join('')
  return `<!doctype html><html><head><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fdfae7;color:#111111;font-family:Inter,sans-serif}
    .deck{position:relative;width:100vw;height:100vh;overflow:hidden}
    .slide{position:absolute;inset:0;width:100vw;height:100vh;padding:48px 58px 76px;display:flex;flex-direction:column;opacity:0;pointer-events:none;transform:translateX(40px);transition:opacity .1s,transform .1s}
    .slide.active{opacity:1;pointer-events:auto;transform:translateX(0)}
    .layout-cover{justify-content:center;padding-left:115px}
    .layout-cover .cover-decoration{position:absolute;right:0;top:0;width:35vw;height:100vh;background:rgba(30,43,250,.08);clip-path:polygon(30% 0,100% 0,100% 100%,0 100%)}
    .layout-cover h1,.layout-closing h1,.slide-header{font-family:'Space Grotesk',sans-serif}
    .slide-header{display:flex;justify-content:space-between;margin-bottom:24px}
    .layout-closing{align-items:center;justify-content:center}
    .layout-closing .closing-decoration{position:absolute;width:500px;height:500px;border:1px solid rgba(30,43,250,.2);border-radius:50%;opacity:.4}
    .nav-controls{position:fixed;right:43px;bottom:22px;display:flex;gap:12px;z-index:100}
    .nav-btn{width:44px;height:44px;border-radius:50%;border:1px solid rgba(30,43,250,.2);background:#fdfae7;color:#1e2bfa}
    .slide-counter{position:fixed;left:43px;bottom:22px;font:500 12px 'Space Grotesk',sans-serif;letter-spacing:.05em;color:#6b6b6b;z-index:100}
    .keyboard-hint{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);font-size:11px;color:#9a9a9a;opacity:.6;z-index:100}
    .progress-bar{position:fixed;left:0;bottom:0;width:33.333%;height:3px;background:#1e2bfa;z-index:100}
  </style></head><body><main class="deck">
    <section class="slide active layout-cover"><h1>${headline}</h1><div class="cover-decoration"></div></section>
    ${contentSlides}
    <section class="slide layout-closing"><h1>Closing</h1><div class="closing-decoration"></div></section>
  </main><div class="slide-counter">1 / ${totalSlides}</div><div class="keyboard-hint">${keyboardHint}</div><div class="nav-controls"><button class="nav-btn">‹</button><button class="nav-btn">›</button></div><div class="progress-bar"></div>
  <script>
    const slides=[...document.querySelectorAll('.slide')];let current=0;
    const show=(index)=>{current=Math.max(0,Math.min(slides.length-1,index));slides.forEach((slide,i)=>slide.classList.toggle('active',i===current));document.querySelector('.progress-bar').style.width=((current+1)/slides.length*100)+'%';const buttons=[...document.querySelectorAll('.nav-btn')];buttons[0].disabled=current===0;buttons[1].disabled=current===slides.length-1};
    addEventListener('keydown',(event)=>{if(event.key==='ArrowRight')show(current+1);if(event.key==='End')show(slides.length-1)});
    show(0);
  </script></body></html>`
}

function statefulCounterDeckHtml(headline: string, totalSlides = 4): string {
  return referenceDeckHtml(headline, totalSlides)
    .replace(
      `<div class="slide-counter">1 / ${totalSlides}</div>`,
      `<div class="slide-counter"><span id="current">1</span> / <span id="total">${totalSlides}</span></div>`,
    )
    .replace(
      `const slides=[...document.querySelectorAll('.slide')];let current=0;`,
      `const slides=[...document.querySelectorAll('.slide')];let current=0;const currentLabel=document.querySelector('#current');const totalLabel=document.querySelector('#total');`,
    )
    .replace(
      `document.querySelector('.progress-bar').style.width=((current+1)/slides.length*100)+'%';const buttons=`,
      `document.querySelector('.progress-bar').style.width=((current+1)/slides.length*100)+'%';currentLabel.textContent=String(current+1);totalLabel.textContent=String(slides.length);const buttons=`,
    )
    .replace(
      `if(event.key==='ArrowRight')show(current+1);if(event.key==='End')show(slides.length-1)`,
      `if(event.key==='ArrowRight')show(current+1);if(event.key==='ArrowLeft')show(current-1);if(event.key==='End')show(slides.length-1)`,
    )
}

function phaseColorDeckHtml(): string {
  return referenceDeckHtml('Atomic reference capture').replace('</style>', `
    .layout-cover{background:rgb(250,20,30)}
    .slide:nth-of-type(2){background:rgb(20,200,60)}
    .layout-closing{background:rgb(30,70,240)}
  </style>`)
}

function externalControllerDeckHtml(): string {
  return `<!doctype html><html><head><script src="deck-stage.js"></script><style>
    *{box-sizing:border-box;margin:0}html,body{width:100%;height:100%;overflow:hidden;font-family:Inter,sans-serif}
    deck-stage>section.slide{position:relative;width:100vw;height:100vh;padding:64px;color:white}
    .s-cover{background:#9f1239}.s-toc{background:#166534}.s-stats{background:#1d4ed8}.s-cta{background:#6b21a8}
    .runner{position:absolute;left:40px;top:30px}.footer{position:absolute;left:40px;bottom:30px}
    .body{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  </style></head><body><deck-stage>
    <section class="slide s-cover"><div class="runner">Cover</div><h1>After Hours</h1><footer class="footer">01</footer></section>
    <section class="slide s-toc"><div class="runner">Index</div><div class="body"><h2>Index</h2></div><footer class="footer">02</footer></section>
    <section class="slide s-stats"><div class="runner">Stats</div><div class="body"><h2>Stats</h2></div><footer class="footer">03</footer></section>
    <section class="slide s-cta"><div class="runner">Encore</div><h1>Encore</h1><footer class="footer">04</footer></section>
  </deck-stage></body></html>`
}

function localizedIntrinsicDeckHtml(localized = false): string {
  const runnerLeft = localized ? '本周娱乐' : 'ENTERTAINMENT WEEKLY'
  const runnerRight = localized ? '二〇二六年九月' : 'SEPTEMBER 2026'
  const columns = localized
    ? [['范围', '最近七日'], ['电影', '暑期档收官'], ['电视与流媒体', '新作动态'], ['音乐', '演出现场']]
    : [['SCOPE', 'LAST 7 DAYS'], ['FILM', 'BOX OFFICE'], ['TV & STREAMING', 'NEW RELEASES'], ['MUSIC', 'LIVE EVENTS']]
  const sectionHeading = localized ? '国安大剧<br>定档黄金档<br>九月首播' : 'NEW RELEASE'
  const sectionCopy = localized
    ? '这段更长的本地化正文会自然换成多行，但仍应围绕模板定义的百分比中心锚点垂直居中。'
    : 'Short reference copy.'
  return `<!doctype html><html><head><style>
    *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#080508;color:#f5edf1;font-family:Arial,sans-serif}
    .slide{display:none;position:relative;width:100vw;height:100vh;overflow:hidden;padding:60px}.slide.active{display:block}
    .s-cover{background:radial-gradient(circle at 30% 30%,#24141f,#080508 62%)}
    .runner{position:absolute;top:60px;left:60px;right:60px;display:flex;align-items:baseline;justify-content:space-between;font:24px monospace;letter-spacing:.14em;text-transform:uppercase}
    .lower{position:absolute;left:60px;right:60px;bottom:160px;display:flex;align-items:flex-end;justify-content:space-between;gap:32px}
    .col{display:flex;flex-direction:column;gap:6px}.col b{font:700 22px monospace}.col span{font:18px Arial,sans-serif}
    .footer{position:absolute;left:60px;right:60px;bottom:60px;display:flex;align-items:baseline;justify-content:space-between;font:24px monospace;letter-spacing:.14em}
    h1{position:absolute;inset:250px 60px auto;font-size:88px}.s-toc{background:#24141f}.s-section{background:#401328}.s-cta{background:#080508}
    .s-section .right{position:absolute;right:100px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:18px;max-width:380px}.s-section .right h2{font-size:72px;line-height:1.06}.s-section .right p{font-size:24px;line-height:1.55}
  </style></head><body>
    <section class="slide s-cover active"><div class="runner"><span>${runnerLeft}</span><span>${runnerRight}</span></div><h1>${localized ? '一周娱乐' : 'AFTER HOURS'}</h1><div class="lower">${columns.map(([label, value]) => `<div class="col"><b>${label}</b><span>${value}</span></div>`).join('')}</div><footer class="footer"><span>${localized ? '编辑部' : 'EDITORIAL'}</span><span>01 / 04</span></footer></section>
    <section class="slide s-toc"><div class="runner"><span>INDEX</span><span>02</span></div><h1>INDEX</h1><footer class="footer"><span>WEEKLY</span><span>02 / 04</span></footer></section>
    <section class="slide s-section"><div class="runner"><span>NEWS</span><span>03</span></div><div class="right"><h2>${sectionHeading}</h2><p>${sectionCopy}</p></div><footer class="footer"><span>WEEKLY</span><span>03 / 04</span></footer></section>
    <section class="slide s-cta"><div class="runner"><span>END</span><span>04</span></div><h1>ENCORE</h1><footer class="footer"><span>WEEKLY</span><span>04 / 04</span></footer></section>
    <script>const slides=[...document.querySelectorAll('.slide')];let i=0;addEventListener('keydown',e=>{if(e.key==='ArrowRight')i=Math.min(slides.length-1,i+1);if(e.key==='End')i=slides.length-1;slides.forEach((s,n)=>s.classList.toggle('active',n===i))})</script>
  </body></html>`
}

async function pngPixel(png: Buffer, x: number, y: number): Promise<number[]> {
  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  return [...context.getImageData(x, y, 1, 1).data]
}

async function embeddedTestFontOptions() {
  const bytes = await readFile(resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'))
  return {
    fontCss: `
      @font-face {
        font-family: "Anera Embedded Test";
        src: url(data:font/ttf;base64,${bytes.toString('base64')}) format("truetype");
        font-style: normal;
        font-weight: 400;
      }
      html, body, h1, h2, h3, h4, p, li, .slide-header, .slide-counter {
        font-family: "Anera Embedded Test" !important;
        font-weight: 400 !important;
      }
    `,
    expectedFontFamilies: ['Anera Embedded Test'],
  } as const
}

function blueProfessionalGateDeckHtml(headline = 'Market Outlook'): string {
  return `<!doctype html><html><head><style>
    *{box-sizing:border-box}:root{--bg:#fdfae7;--primary:#1e2bfa;--text:#111111;--muted:#6b6b6b;--border:rgba(30,43,250,.2)}
    html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:Inter,sans-serif;background:var(--bg);color:var(--text)}
    h1,h2,h3,h4{font-family:'Space Grotesk',sans-serif;font-weight:600;line-height:1.1;letter-spacing:-.02em}
    h1{font-size:clamp(2.8rem,5vw,4.2rem);font-weight:700}h2{font-size:clamp(1.8rem,3vw,2.6rem)}
    h3{font-size:clamp(1.1rem,1.8vw,1.5rem);font-weight:500;line-height:1.3}h4{font-size:clamp(.85rem,1.2vw,1rem);letter-spacing:.08em;color:var(--primary)}
    p,li{font-size:clamp(.85rem,1.1vw,1.05rem);line-height:1.6;color:var(--muted)}
    .deck{position:relative;width:100vw;height:100vh;overflow:hidden}.slide{position:absolute;inset:0;width:100vw;height:100vh;padding:48px 58px 76px;display:flex;flex-direction:column;opacity:0;pointer-events:none}.slide.active{opacity:1;pointer-events:auto}
    .layout-cover{justify-content:center;padding-left:115px}.layout-cover .cover-decoration{position:absolute;right:0;top:0;width:35vw;height:100vh;background:rgba(30,43,250,.08);clip-path:polygon(30% 0,100% 0,100% 100%,0 100%)}
    .layout-agenda .agenda-grid{display:grid;grid-template-columns:repeat(2,1fr);grid-template-rows:repeat(3,1fr);gap:1rem 3rem;flex:1;min-height:0}.agenda-item{display:flex;gap:1.2rem;align-items:center}.agenda-item h3{font-size:clamp(1rem,1.4vw,1.2rem)}.agenda-item p{font-size:clamp(.8rem,1vw,.95rem);line-height:1.5}
    .slide-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.slide-header .tag{font-family:'Space Grotesk',sans-serif;font-size:.75rem;font-weight:500;color:var(--primary);background:rgba(30,43,250,.2);padding:.35rem .9rem;border-radius:100px}
    .layout-closing{align-items:center;justify-content:center}.layout-closing .closing-decoration{position:absolute;width:500px;height:500px;border:1px solid rgba(30,43,250,.2);border-radius:50%}
    .nav-controls{position:fixed;right:43px;bottom:22px;z-index:100}.nav-btn{width:44px;height:44px;border-radius:50%;border:1px solid var(--border);background:var(--bg);color:var(--primary)}
    .slide-counter{position:fixed;left:43px;bottom:22px;font:500 12px 'Space Grotesk',sans-serif;color:var(--muted);z-index:100}.keyboard-hint{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);font-size:11px;color:var(--muted);z-index:100}.progress-bar{position:fixed;left:0;bottom:0;width:33.333%;height:3px;background:var(--primary);z-index:100}
  </style></head><body><main class="deck">
    <section class="slide active layout-cover"><h1>${headline}</h1><div class="cover-decoration"></div></section>
    <section class="slide layout-agenda"><header class="slide-header"><h4>Table of Contents</h4><span class="tag">Overview</span></header><div class="agenda-grid">${Array.from({ length: 6 }, (_, index) => `<article class="agenda-item"><div><h3>Topic ${index + 1}</h3><p>Replaceable summary ${index + 1}</p></div></article>`).join('')}</div></section>
    <section class="slide layout-closing"><h1>Closing</h1><div class="closing-decoration"></div></section>
  </main><div class="slide-counter">1 / 3</div><div class="keyboard-hint">Use arrows</div><nav class="nav-controls"><button class="nav-btn">‹</button><button class="nav-btn">›</button></nav><div class="progress-bar"></div>
  <script>const slides=[...document.querySelectorAll('.slide')];let current=0;const show=(index)=>{current=Math.max(0,Math.min(slides.length-1,index));slides.forEach((slide,i)=>slide.classList.toggle('active',i===current));document.querySelector('.progress-bar').style.width=((current+1)/slides.length*100)+'%'};addEventListener('keydown',(event)=>{if(event.key==='ArrowRight')show(current+1);if(event.key==='End')show(slides.length-1)});show(0)</script>
  </body></html>`
}

function keepBlueProfessionalSlides(html: string, keptIndexes: readonly number[]): string {
  const kept = new Set(keptIndexes)
  const tokens = [...html.matchAll(/<\/?div\b[^>]*>/giu)]
  const ranges: Array<{ start: number; end: number; slideIndex: number }> = []
  const stack: Array<{ start: number; depth: number; slideIndex: number } | undefined> = []
  let depth = 0
  let slideIndex = 0
  for (const token of tokens) {
    const source = token[0]
    const position = token.index ?? 0
    if (!source.startsWith('</')) {
      depth += 1
      const classValue = source.match(/\bclass\s*=\s*["']([^"']*)["']/iu)?.[1]
      const isSlide = classValue?.split(/\s+/u).includes('slide') === true
      stack.push(isSlide ? { start: position, depth, slideIndex: slideIndex++ } : undefined)
      continue
    }
    const opened = stack.pop()
    if (opened && opened.depth === depth) {
      ranges.push({ start: opened.start, end: position + source.length, slideIndex: opened.slideIndex })
    }
    depth -= 1
  }
  return ranges
    .filter((range) => !kept.has(range.slideIndex))
    .sort((left, right) => right.start - left.start)
    .reduce((result, range) => result.slice(0, range.start) + result.slice(range.end), html)
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeEverything()))
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
}, 30_000)

describe('browser manager', () => {
  it('atomically captures viewport-sized screenshots for the cover, content, and closing phases', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = phaseColorDeckHtml()
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    const viewport = { width: 800, height: 600 }
    const bundle = await manager.captureReferenceRenderBundle(
      source,
      sourceProfile,
      '7'.repeat(64),
      viewport,
    )

    expect(bundle.profile.phases).toMatchObject({
      cover: { anchors: expect.arrayContaining([expect.objectContaining({ selector: '.layout-cover' })]) },
      content: { anchors: expect.arrayContaining([expect.objectContaining({ selector: '.slide-header' })]) },
      closing: { anchors: expect.arrayContaining([expect.objectContaining({ selector: '.layout-closing' })]) },
    })
    for (const screenshot of Object.values(bundle.screenshots)) {
      expect(screenshot.subarray(1, 4).toString()).toBe('PNG')
      expect({ width: screenshot.readUInt32BE(16), height: screenshot.readUInt32BE(20) }).toEqual(viewport)
    }
    expect(new Set(Object.values(bundle.screenshots).map((png) => createHash('sha256').update(png).digest('hex'))).size).toBe(3)
    await expect(Promise.all([
      pngPixel(bundle.screenshots.cover, 12, 12),
      pngPixel(bundle.screenshots.content, 12, 12),
      pngPixel(bundle.screenshots.closing, 12, 12),
    ])).resolves.toEqual([
      [250, 20, 30, 255],
      [20, 200, 60, 255],
      [30, 70, 240, 255],
    ])
  }, 20_000)

  it('captures script-controlled custom-element decks without executing their external controller', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = externalControllerDeckHtml()
    const contract: ReferenceStyleContract = {
      ...RENDER_CONTRACT,
      colors: ['#9f1239', '#166534', '#1d4ed8', '#6b21a8'],
      fonts: ['Inter'],
      requiredMarkers: [
        'deck-stage', '.runner', '.footer', '.s-cover', '.s-toc', '.s-stats', '.s-cta',
      ],
    }
    const sourceProfile = extractReferenceStyleSourceProfile(source, contract)!
    const bundle = await manager.captureReferenceRenderBundle(
      source,
      sourceProfile,
      '9'.repeat(64),
      contract.viewport,
    )
    expect(bundle.screenshots.cover.equals(bundle.screenshots.content)).toBe(false)
    expect(bundle.screenshots.cover.equals(bundle.screenshots.closing)).toBe(false)
    expect(bundle.screenshots.content.equals(bundle.screenshots.closing)).toBe(false)
    expect(bundle.profile.interiorVariants?.map((variant) => variant.layoutSelector)).toEqual([
      '.s-toc', '.s-stats',
    ])
    for (const phase of ['cover', 'content', 'closing'] as const) {
      expect(bundle.profile.phases[phase].anchors).toEqual(expect.arrayContaining([
        expect.objectContaining({ selector: '.runner' }),
        expect.objectContaining({ selector: '.footer' }),
      ]))
    }
  }, 20_000)

  it('treats localized intrinsic text sizing as content while retaining fixed template geometry', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = localizedIntrinsicDeckHtml(false)
    const contract: ReferenceStyleContract = {
      ...RENDER_CONTRACT,
      colors: ['#080508', '#24141f', '#401328', '#f5edf1'],
      fonts: ['Arial', 'monospace'],
      requiredMarkers: ['.s-cover', '.runner', '.lower', '.col', '.footer'],
    }
    const sourceProfile = extractReferenceStyleSourceProfile(source, contract)!
    const renderProfile = await manager.captureReferenceRenderProfile(
      source,
      sourceProfile,
      '8'.repeat(64),
      contract.viewport,
    )
    expect(renderProfile.phases.cover.anchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ selector: '.runner', geometry: 'intrinsic-block' }),
      expect.objectContaining({ selector: '.s-cover .col', geometry: 'intrinsic-size' }),
    ]))
    expect(renderProfile.interiorVariants?.find((variant) => variant.layoutSelector === '.s-section')?.profile.anchors)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ selector: '.s-section .right', geometry: 'intrinsic-block-center' }),
      ]))

    await manager.open('localized-intrinsic-copy', `data:text/html,${encodeURIComponent(localizedIntrinsicDeckHtml(true))}`)
    const localized = await manager.verifyRenderedReferenceStyle('localized-intrinsic-copy', renderProfile, 'cover')
    expect(localized, localized.violations.join('\n')).toMatchObject({ fidelity: 'pass', score: 100 })
    await manager.press('localized-intrinsic-copy', 'ArrowRight')
    await manager.press('localized-intrinsic-copy', 'ArrowRight')
    const legacyRenderProfile = structuredClone(renderProfile)
    const legacyCenteredAnchor = legacyRenderProfile.interiorVariants
      ?.find((variant) => variant.layoutSelector === '.s-section')
      ?.profile.anchors.find((anchor) => anchor.selector === '.s-section .right')
    if (!legacyCenteredAnchor) throw new Error('fixture lacks the centered section anchor')
    legacyCenteredAnchor.geometry = 'strict'
    const legacyLocalizedContent = await manager.verifyRenderedReferenceStyle(
      'localized-intrinsic-copy',
      legacyRenderProfile,
      'content',
    )
    expect(legacyLocalizedContent, legacyLocalizedContent.violations.join('\n'))
      .toMatchObject({ fidelity: 'pass', score: 100 })

    const geometryDrift = localizedIntrinsicDeckHtml(true).replace(
      'right:100px;top:50%;',
      'right:140px;top:60%;',
    )
    await manager.open('localized-intrinsic-drift', `data:text/html,${encodeURIComponent(geometryDrift)}`)
    await manager.press('localized-intrinsic-drift', 'ArrowRight')
    await manager.press('localized-intrinsic-drift', 'ArrowRight')
    const drift = await manager.verifyRenderedReferenceStyle('localized-intrinsic-drift', legacyRenderProfile, 'content')
    expect(drift.fidelity).toBe('mismatch')
    expect(drift.violations.join('\n')).toMatch(/\.s-section \.right.*(?:position|top|right)/iu)
  }, 35_000)

  it('rejects opacity-only vertical-flow slides and accepts a single in-stage active slide', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = localizedIntrinsicDeckHtml(false)
    const contract: ReferenceStyleContract = {
      ...RENDER_CONTRACT,
      colors: ['#080508', '#24141f', '#401328', '#f5edf1'],
      fonts: ['Arial', 'monospace'],
      requiredMarkers: ['.s-cover', '.s-toc', '.s-section', '.s-cta', '.runner', '.footer'],
    }
    const sourceProfile = extractReferenceStyleSourceProfile(source, contract)!
    const renderProfile = await manager.captureReferenceRenderProfile(
      source,
      sourceProfile,
      '7'.repeat(64),
      contract.viewport,
    )
    const opacityOnly = source
      .replace('.slide{display:none;position:relative;', '.slide{position:relative;')
      .replace('.slide.active{display:block}', '.slide{opacity:0;pointer-events:none}.slide.active{opacity:1;pointer-events:auto}')
    const opened = await manager.open('opacity-flow-deck', `data:text/html,${encodeURIComponent(opacityOnly)}`)
    const navigated = await manager.press('opacity-flow-deck', 'ArrowRight')
    expect(navigated.stateDigest).not.toBe(opened.stateDigest)
    const blankContent = await manager.verifyRenderedReferenceStyle('opacity-flow-deck', renderProfile, 'content')
    expect(blankContent.fidelity).toBe('mismatch')
    expect(blankContent.violations[0]).toMatch(/active slide 2 is outside the viewport.*inactive predecessor slide.*normal vertical flow/iu)
    expect(blankContent.violations[0]).toContain('.slide:not(.active){display:none}')
    expect(blankContent.violations[0]).toContain('preserve the reference base slide rule')
    expect(blankContent.interiorAttestation).toBeUndefined()

    await manager.open('single-stage-deck', `data:text/html,${encodeURIComponent(source)}`)
    await manager.press('single-stage-deck', 'ArrowRight')
    const content = await manager.verifyRenderedReferenceStyle('single-stage-deck', renderProfile, 'content')
    expect(content, content.violations.join('\n')).toMatchObject({ fidelity: 'pass', score: 100 })
  }, 30_000)

  it('waits for trusted embedded font faces and fails closed when capture or candidate faces are missing', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = referenceDeckHtml('Embedded font reference')
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    const fontOptions = await embeddedTestFontOptions()
    const bundle = await manager.captureReferenceRenderBundle(
      source,
      sourceProfile,
      '8'.repeat(64),
      RENDER_CONTRACT.viewport,
      fontOptions,
    )
    expect(bundle.profile.phases.cover.typographyProbes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        selector: 'h1',
        styles: expect.objectContaining({ 'font-family': '"anera embedded test"' }),
      }),
    ]))

    await manager.open('font-candidate', `data:text/html,${encodeURIComponent(source)}`)
    await expect(manager.verifyRenderedReferenceStyleAndScreenshot(
      'font-candidate',
      bundle.profile,
      'cover',
      undefined,
      fontOptions,
    )).resolves.toMatchObject({ verification: { fidelity: 'pass' }, screenshot: expect.any(Buffer) })

    const missingFont = {
      fontCss: '@font-face{font-family:"Never Loaded";src:url(data:font/ttf;base64,AA==) format("truetype")}',
      expectedFontFamilies: ['Never Loaded'],
    }
    await expect(manager.captureReferenceRenderBundle(
      source,
      sourceProfile,
      '8'.repeat(64),
      RENDER_CONTRACT.viewport,
      missingFont,
    )).rejects.toThrow(/fonts failed to load.*never loaded/iu)
    await expect(manager.verifyRenderedReferenceStyleAndScreenshot(
      'font-candidate',
      bundle.profile,
      'cover',
      undefined,
      missingFont,
    )).rejects.toThrow(/fonts failed to load.*never loaded/iu)
    await expect(manager.captureReferenceRenderBundle(
      source,
      sourceProfile,
      '8'.repeat(64),
      RENDER_CONTRACT.viewport,
      { fontCss: fontOptions.fontCss },
    )).rejects.toThrow(/require both fontCss and expectedFontFamilies/iu)
  }, 30_000)

  it('captures a bounded three-phase render profile and accepts content-only substitutions', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = referenceDeckHtml('Reference headline').replace(
      '</body>',
      `<script>document.querySelector('.cover-decoration').style.width='80vw'</script><iframe srcdoc="<style>body{background:red}</style>"></iframe><svg style="display:none"><animate attributeName="opacity" values="0;1" dur="1ms"></animate><set attributeName="display" to="block"></set></svg></body>`,
    )
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)
    expect(sourceProfile).toBeDefined()
    const renderProfile = await manager.captureReferenceRenderProfile(
      source,
      sourceProfile!,
      'a'.repeat(64),
      RENDER_CONTRACT.viewport,
    )
    expect(renderProfile).toMatchObject({
      version: 1,
      evidenceSha256: 'a'.repeat(64),
      viewport: RENDER_CONTRACT.viewport,
      phases: {
        cover: { anchors: expect.arrayContaining([expect.objectContaining({ selector: '.layout-cover', geometry: 'strict' })]), overlayProbes: expect.any(Array) },
        content: { anchors: expect.arrayContaining([expect.objectContaining({ selector: '.slide-header', geometry: 'strict' })]), overlayProbes: expect.any(Array) },
        closing: { anchors: expect.arrayContaining([expect.objectContaining({ selector: '.layout-closing', geometry: 'strict' })]), overlayProbes: expect.any(Array) },
      },
    })

    const opened = await manager.open('render-copy', `data:text/html,${encodeURIComponent(referenceDeckHtml('Completely different weekly AI headline'))}`)
    const atomicCover = await manager.verifyRenderedReferenceStyleAndScreenshot('render-copy', renderProfile, 'cover')
    expect(atomicCover.verification).toMatchObject({
      fidelity: 'pass',
      url: expect.stringMatching(/^data:text\/html/),
      viewport: RENDER_CONTRACT.viewport,
      pageEpoch: opened.pageEpoch,
    })
    expect({
      width: atomicCover.screenshot.readUInt32BE(16),
      height: atomicCover.screenshot.readUInt32BE(20),
    }).toEqual(RENDER_CONTRACT.viewport)
    await manager.press('render-copy', 'ArrowRight')
    await expect(manager.verifyRenderedReferenceStyle('render-copy', renderProfile, 'content')).resolves.toMatchObject({ fidelity: 'pass' })
    await manager.press('render-copy', 'End')
    await expect(manager.verifyRenderedReferenceStyle('render-copy', renderProfile, 'closing')).resolves.toMatchObject({ fidelity: 'pass' })
  }, 20_000)

  it('preserves stateful counter node identities while attesting every interior slide', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = statefulCounterDeckHtml('Stateful counter reference')
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    const renderProfile = await manager.captureReferenceRenderProfile(
      source,
      sourceProfile,
      '2'.repeat(64),
      RENDER_CONTRACT.viewport,
    )

    await manager.open('stateful-counter', `data:text/html,${encodeURIComponent(source)}`)
    expect((await manager.press('stateful-counter', 'ArrowRight')).text).toContain('2 / 4')
    await expect(manager.verifyRenderedReferenceStyleAndScreenshot(
      'stateful-counter',
      renderProfile,
      'content',
    )).resolves.toMatchObject({ verification: { fidelity: 'pass', violations: [] } })

    const closing = await manager.press('stateful-counter', 'End')
    expect(closing.text).toContain('Closing')
    expect(closing.text).toContain('4 / 4')
    expect((await manager.press('stateful-counter', 'ArrowLeft')).text).toContain('3 / 4')
  }, 20_000)

  it('neutralizes pointer hover and focus before deterministic candidate capture', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = referenceDeckHtml('Hover-state reference').replace(
      '.slide-counter{',
      '.nav-btn:hover{background:#1e2bfa;color:#fdfae7;border-color:#1e2bfa}.nav-btn:focus{outline:4px solid #1e2bfa}.slide-counter{',
    )
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    const renderProfile = await manager.captureReferenceRenderProfile(
      source,
      sourceProfile,
      'f'.repeat(64),
      RENDER_CONTRACT.viewport,
    )
    const opened = await manager.open('render-hover-neutral', `data:text/html,${encodeURIComponent(source)}`)
    const nextButton = (opened.interactive as Array<{ ref: string; tag: string }> | undefined)
      ?.filter((control) => control.tag === 'button')
      .at(-1)
    expect(nextButton?.ref).toMatch(/^e\d+$/u)
    await manager.press('render-hover-neutral', 'ArrowRight')
    await manager.click('render-hover-neutral', { ref: nextButton!.ref })

    await expect(manager.verifyRenderedReferenceStyleAndScreenshot(
      'render-hover-neutral',
      renderProfile,
      'content',
    )).resolves.toMatchObject({
      verification: { fidelity: 'pass', violations: [] },
      screenshot: expect.any(Buffer),
    })
  }, 20_000)

  it('rejects blue-professional root, pseudo, typography, and agenda-grid takeovers while allowing copy changes', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = blueProfessionalGateDeckHtml()
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    const renderProfile = await manager.captureReferenceRenderProfile(
      source,
      sourceProfile,
      '9'.repeat(64),
      RENDER_CONTRACT.viewport,
    )
    expect(renderProfile.phases.cover.overlayProbes.map((probe) => probe.tag)).toEqual(expect.arrayContaining(['html', 'body']))
    expect(renderProfile.phases.cover.typographyProbes).toEqual(expect.arrayContaining([
      expect.objectContaining({ selector: 'h1', styles: expect.objectContaining({ 'font-size': '67.2px', 'font-weight': '700', 'text-align': 'start' }) }),
    ]))
    expect(renderProfile.phases.content.typographyProbes?.map((probe) => probe.selector)).toEqual(['h2', 'h3', 'h4', '.tag', 'p', 'li'])
    expect(renderProfile.phases.content.anchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ selector: '.layout-agenda .agenda-grid', styles: expect.arrayContaining([expect.objectContaining({ display: 'grid' })]) }),
    ]))

    const copyOnly = blueProfessionalGateDeckHtml('本周人工智能热点').replace(/Replaceable summary/gu, '新闻摘要')
    await manager.open('blue-copy', `data:text/html,${encodeURIComponent(copyOnly)}`)
    await expect(manager.verifyRenderedReferenceStyle('blue-copy', renderProfile, 'cover')).resolves.toMatchObject({ fidelity: 'pass' })
    await manager.press('blue-copy', 'ArrowRight')
    await expect(manager.verifyRenderedReferenceStyle('blue-copy', renderProfile, 'content')).resolves.toMatchObject({ fidelity: 'pass' })
    await manager.press('blue-copy', 'End')
    await expect(manager.verifyRenderedReferenceStyle('blue-copy', renderProfile, 'closing')).resolves.toMatchObject({ fidelity: 'pass' })

    const rootDrift = source.replace('background:var(--bg);color:var(--text)', 'background:var(--primary);color:var(--text)')
    await manager.open('blue-root', `data:text/html,${encodeURIComponent(rootDrift)}`)
    const rootVerification = await manager.verifyRenderedReferenceStyle('blue-root', renderProfile, 'cover')
    expect(rootVerification.fidelity).toBe('mismatch')
    expect(rootVerification.violations.join('\n')).toMatch(/painted surface.*backgroundcolor/iu)

    const typographyDrift = source.replace('</head>', '<style>html body .layout-cover h1{font-size:1rem!important}</style></head>')
    await manager.open('blue-type', `data:text/html,${encodeURIComponent(typographyDrift)}`)
    const typographyVerification = await manager.verifyRenderedReferenceStyle('blue-type', renderProfile, 'cover')
    expect(typographyVerification.fidelity).toBe('mismatch')
    expect(typographyVerification.violations.join('\n')).toMatch(/typography h1 font-size/iu)

    const alignmentDrift = source.replace('</head>', '<style>html body .layout-cover h1{text-align:center!important}</style></head>')
    await manager.open('blue-align', `data:text/html,${encodeURIComponent(alignmentDrift)}`)
    const alignmentVerification = await manager.verifyRenderedReferenceStyle('blue-align', renderProfile, 'cover')
    expect(alignmentVerification.fidelity).toBe('mismatch')
    expect(alignmentVerification.violations.join('\n')).toMatch(/typography h1 text-align/iu)

    const gridDrift = source.replace('</head>', '<style>html body .layout-agenda .agenda-grid{display:block!important}</style></head>')
    await manager.open('blue-grid', `data:text/html,${encodeURIComponent(gridDrift)}`)
    await manager.press('blue-grid', 'ArrowRight')
    const gridVerification = await manager.verifyRenderedReferenceStyle('blue-grid', renderProfile, 'content')
    expect(gridVerification.fidelity).toBe('mismatch')
    expect(gridVerification.violations.join('\n')).toMatch(/layout-agenda \.agenda-grid.*(?:display|size|position)/iu)

    const missingLayoutClass = source.replace('slide layout-agenda', 'slide')
    await manager.open('blue-no-layout', `data:text/html,${encodeURIComponent(missingLayoutClass)}`)
    await manager.press('blue-no-layout', 'ArrowRight')
    const noLayoutVerification = await manager.verifyRenderedReferenceStyle('blue-no-layout', renderProfile, 'content')
    expect(noLayoutVerification.fidelity).toBe('mismatch')
    expect(noLayoutVerification.violations.join('\n')).toMatch(/content slide 2 has no real reference variant class/iu)

    const pseudoDrift = source.replace(
      '</head>',
      '<style>body::before{content:"";position:fixed;inset:0;background:var(--primary);z-index:99999}</style></head>',
    )
    await manager.open('blue-pseudo', `data:text/html,${encodeURIComponent(pseudoDrift)}`)
    const pseudoVerification = await manager.verifyRenderedReferenceStyle('blue-pseudo', renderProfile, 'cover')
    expect(pseudoVerification.fidelity).toBe('mismatch')
    expect(pseudoVerification.violations.join('\n')).toMatch(/viewport-covering painted surfaces|body::before/iu)
  }, 30_000)

  it('attests every interior slide against a real blue-professional layout variant', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = BLUE_PROFESSIONAL_TEMPLATE_HTML
    expect(Buffer.byteLength(source)).toBe(43_370)
    expect(createHash('sha256').update(source).digest('hex'))
      .toBe('5376e910203970ac69bc954e35a39626070b3fc48051ce1408aae7619e4caefa')
    const sourceProfile = extractReferenceStyleSourceProfile(source, {
      ...RENDER_CONTRACT,
      sourceUrl: BLUE_PROFESSIONAL_SOURCE,
      requiredMarkers: ['.layout-cover', '.layout-agenda', '.layout-metrics', '.layout-dashboard', '.layout-closing'],
    })!
    const renderProfile = await manager.captureReferenceRenderProfile(
      source,
      sourceProfile,
      '5'.repeat(64),
      RENDER_CONTRACT.viewport,
    )
    expect(renderProfile.interiorVariants?.map((variant) => variant.layoutSelector)).toEqual([
      '.layout-agenda', '.layout-metrics', '.layout-dashboard', '.layout-split',
      '.layout-bars', '.layout-quote', '.layout-timeline', '.layout-detail',
    ])
    expect(renderProfile.interiorVariants?.find((variant) => variant.layoutSelector === '.layout-dashboard')?.profile.anchors)
      .toEqual(expect.arrayContaining([expect.objectContaining({ selector: '.layout-dashboard .stats-grid' })]))
    expect(renderProfile.interiorVariants?.find((variant) => variant.layoutSelector === '.layout-bars')?.profile.anchors)
      .toEqual(expect.arrayContaining([expect.objectContaining({ selector: '.layout-bars .bars-container' })]))

    // Keep the same four real layout variants used by the AI-weekly-news
    // regression. Copy is deliberately collapsed to tiny localized strings so
    // content-owned natural block height cannot masquerade as style drift.
    // The last metric also changes from negative to positive: Chromium folds
    // currentColor into the computed value of an invisible `border: none`,
    // which must not create a false mismatch.
    const validSix = keepBlueProfessionalSlides(source, [0, 1, 2, 4, 7, 9])
      .replace(/(<h2>)[\s\S]*?(<\/h2>)/gu, '$1短标题$2')
      .replace(/(<div class="metric-(?:label|desc)">)[\s\S]*?(<\/div>)/gu, '$1短$2')
      .replace(/(<li>)[\s\S]*?(<\/li>)/gu, '$1短$2')
      .replace(/(<div class="step-(?:title|desc)">)[\s\S]*?(<\/div>)/gu, '$1短$2')
      .replace('metric-change negative', 'metric-change positive')
    await manager.open('blue-real-six', `data:text/html,${encodeURIComponent(validSix)}`)
    await manager.press('blue-real-six', 'ArrowRight')
    const valid = await manager.verifyRenderedReferenceStyle('blue-real-six', renderProfile, 'content')
    expect(valid, valid.violations.join('\n')).toMatchObject({
      fidelity: 'pass',
      score: 100,
      interiorAttestation: {
        candidateSlides: 4,
        matchedSlides: 4,
        referenceVariants: 8,
        slides: [
          { slideIndex: 1, matchedVariant: '.layout-agenda', fidelity: 'pass' },
          { slideIndex: 2, matchedVariant: '.layout-metrics', fidelity: 'pass' },
          { slideIndex: 3, matchedVariant: '.layout-split', fidelity: 'pass' },
          { slideIndex: 4, matchedVariant: '.layout-timeline', fidelity: 'pass' },
        ],
      },
    })
    expect(valid.violations).toEqual([])

    const driftedThirdPage = validSix.replace(
      '</head>',
      '<style>html body .layout-metrics .metrics-row{display:block!important}</style></head>',
    )
    await manager.open('blue-real-drift', `data:text/html,${encodeURIComponent(driftedThirdPage)}`)
    await manager.press('blue-real-drift', 'ArrowRight')
    const drift = await manager.verifyRenderedReferenceStyle('blue-real-drift', renderProfile, 'content')
    expect(drift.fidelity).toBe('mismatch')
    expect(drift.interiorAttestation).toMatchObject({ candidateSlides: 4, matchedSlides: 3 })
    expect(drift.violations.join('\n')).toMatch(/content slide 3.*layout-metrics.*(?:display|size|position)/iu)
  }, 75_000)

  it('preserves exact visual chrome when a ten-slide reference is reduced to six slides', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = referenceDeckHtml('Ten-page reference', 10)
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    const renderProfile = await manager.captureReferenceRenderProfile(source, sourceProfile, 'd'.repeat(64), RENDER_CONTRACT.viewport)
    const localizedSixPageDeck = referenceDeckHtml('Six-page implementation', 6, '使用方向键翻页')
      .replace(/Overview/gu, '本周议程')
    await manager.open('render-six', `data:text/html,${encodeURIComponent(localizedSixPageDeck)}`)
    const coverVerification = await manager.verifyRenderedReferenceStyle('render-six', renderProfile, 'cover')
    expect(coverVerification.violations).toEqual([])
    expect(coverVerification.fidelity).toBe('pass')
    await manager.press('render-six', 'ArrowRight')
    await expect(manager.verifyRenderedReferenceStyle('render-six', renderProfile, 'content')).resolves.toMatchObject({ fidelity: 'pass' })
    await manager.press('render-six', 'End')
    await expect(manager.verifyRenderedReferenceStyle('render-six', renderProfile, 'closing')).resolves.toMatchObject({ fidelity: 'pass' })
  }, 25_000)

  it('still rejects semantic counter/hint anchor drift while allowing localized intrinsic text', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = referenceDeckHtml('Reference', 10)
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    const renderProfile = await manager.captureReferenceRenderProfile(source, sourceProfile, 'e'.repeat(64), RENDER_CONTRACT.viewport)
    const localized = referenceDeckHtml('Candidate', 6, '使用方向键翻页')
    await manager.open('render-localized-chrome', `data:text/html,${encodeURIComponent(localized)}`)
    const localizedVerification = await manager.verifyRenderedReferenceStyle('render-localized-chrome', renderProfile, 'cover')
    expect(localizedVerification.violations).toEqual([])
    expect(localizedVerification.fidelity).toBe('pass')

    const drifted = localized.replace(
      '.keyboard-hint{',
      '.keyboard-hint{top:20px!important;bottom:auto!important;',
    )
    await manager.open('render-drifted-chrome', `data:text/html,${encodeURIComponent(drifted)}`)
    const verification = await manager.verifyRenderedReferenceStyle('render-drifted-chrome', renderProfile, 'cover')
    expect(verification.fidelity).toBe('mismatch')
    expect(verification.violations.join('\n')).toMatch(/keyboard-hint.*position/iu)
  }, 20_000)

  it('rejects high-specificity scaling and a fixed overlay even when the source CSS remains intact', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = referenceDeckHtml('Reference headline')
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    const renderProfile = await manager.captureReferenceRenderProfile(source, sourceProfile, 'b'.repeat(64), RENDER_CONTRACT.viewport)
    const override = `<style>
      html body .slide.active { transform:scale(.25) rotate(15deg)!important; width:30%!important; height:30%!important; left:35%!important; top:35%!important }
      html body::before { content:""; position:fixed; inset:0; background:#1e2bfa; z-index:99999 }
    </style>`
    await manager.open('render-overlay', `data:text/html,${encodeURIComponent(source.replace('</head>', `${override}</head>`))}`)
    const verification = await manager.verifyRenderedReferenceStyle('render-overlay', renderProfile, 'cover')
    expect(verification.fidelity).toBe('mismatch')
    expect(verification.violations.join('\n')).toMatch(/slide|occluded|size|position/iu)
  }, 15_000)

  it('rejects a delayed JavaScript re-skin from the final computed render', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = referenceDeckHtml('Reference headline')
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    const renderProfile = await manager.captureReferenceRenderProfile(source, sourceProfile, 'c'.repeat(64), RENDER_CONTRACT.viewport)
    const delayedSkin = `<style>.late-skin{position:fixed;inset:0;background:#1e2bfa;z-index:99999}</style>
      <script>setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<div class="late-skin"></div>'),900)</script>`
    await manager.open('render-js-skin', `data:text/html,${encodeURIComponent(source.replace('</body>', `${delayedSkin}</body>`))}`)
    const verification = await manager.verifyRenderedReferenceStyle('render-js-skin', renderProfile, 'cover')
    expect(verification).toMatchObject({ fidelity: 'mismatch' })
    expect(verification.violations.join('\n')).toMatch(/unstable/iu)
  }, 15_000)

  it('rejects a render that changes immediately after its atomic screenshot', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = referenceDeckHtml('Reference headline')
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    const renderProfile = await manager.captureReferenceRenderProfile(source, sourceProfile, '1'.repeat(64), RENDER_CONTRACT.viewport)
    const afterCaptureSkin = `<style>.after-capture-skin{position:fixed;inset:0;background:#1e2bfa;z-index:99999}</style>
      <script>addEventListener('keydown',(event)=>{if(event.key==='F8')setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<div class="after-capture-skin"></div>'),1450)})</script>`
    await manager.open('render-after-capture', `data:text/html,${encodeURIComponent(source.replace('</body>', `${afterCaptureSkin}</body>`))}`)
    await manager.press('render-after-capture', 'F8')
    const result = await manager.verifyRenderedReferenceStyleAndScreenshot('render-after-capture', renderProfile, 'cover')
    expect(result.screenshot.subarray(1, 4).toString()).toBe('PNG')
    expect(result.verification.fidelity).toBe('mismatch')
    expect(result.verification.violations.join('\n')).toMatch(/changed after screenshot capture/iu)
  }, 15_000)

  it('rejects a viewport-covering canvas nested inside the active structural anchor', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = referenceDeckHtml('Reference headline')
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    const renderProfile = await manager.captureReferenceRenderProfile(source, sourceProfile, 'e'.repeat(64), RENDER_CONTRACT.viewport)
    const nestedCanvas = '<canvas class="takeover" width="1440" height="900"></canvas>'
    const override = '<style>.takeover{position:fixed;inset:0;width:100vw;height:100vh;z-index:99999}</style>'
    const candidate = source.replace('</head>', `${override}</head>`).replace('</section>', `${nestedCanvas}</section>`)
    await manager.open('render-nested-overlay', `data:text/html,${encodeURIComponent(candidate)}`)
    const verification = await manager.verifyRenderedReferenceStyle('render-nested-overlay', renderProfile, 'cover')
    expect(verification.fidelity).toBe('mismatch')
    expect(verification.violations.join('\n')).toMatch(/painted surface|viewport-covering/iu)
  }, 15_000)

  it('fails closed when an exact reference cannot form distinct slide phases', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const source = referenceDeckHtml('Reference headline').replace(/class="slide/g, 'class="page')
    const sourceProfile = extractReferenceStyleSourceProfile(source, RENDER_CONTRACT)!
    await expect(manager.captureReferenceRenderProfile(
      source,
      sourceProfile,
      'f'.repeat(64),
      RENDER_CONTRACT.viewport,
    )).rejects.toThrow(/at least three \.slide/iu)
  }, 15_000)

  it('opens, snapshots stable refs, operates form controls, scrolls, resizes, and reads console output', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const html = `<title>Anera Browser Test</title>
      <label>Name <input aria-label="Name"></label>
      <label>Enabled <input type="checkbox" aria-label="Enabled"></label>
      <select aria-label="Mode"><option value="slow">Slow</option><option value="fast">Fast</option></select>
      <button onclick="this.textContent='Clicked'; console.log('CLICK_OK')">Increment</button>
      <div style="height:1800px">Scrollable content</div>`
    const opened = await manager.open('session', `data:text/html,${encodeURIComponent(html)}`)
    expect(opened.title).toBe('Anera Browser Test')
    expect(opened.pageEpoch).toEqual(expect.any(Number))
    const controls = opened.interactive as Array<{ ref: string; ariaLabel?: string; text?: string }>
    const ref = (label: string) => controls.find((control) => control.ariaLabel === label || control.text === label)?.ref || ''
    const filled = await manager.fill('session', ref('Name'), 'Arena')
    expect(filled.pageEpoch).toBe(opened.pageEpoch)
    expect((filled.interactive as Array<{ ariaLabel?: string; value?: string }>).find((item) => item.ariaLabel === 'Name')?.value).toBe('Arena')
    const checked = await manager.check('session', ref('Enabled'), true)
    expect((checked.interactive as Array<{ ariaLabel?: string; checked?: boolean }>).find((item) => item.ariaLabel === 'Enabled')?.checked).toBe(true)
    const selected = await manager.select('session', ref('Mode'), 'fast')
    expect((selected.interactive as Array<{ ariaLabel?: string; value?: string }>).find((item) => item.ariaLabel === 'Mode')?.value).toBe('fast')
    await manager.press('session', 'Tab', ref('Name'))
    const clicked = await manager.click('session', { ref: ref('Increment') })
    expect(clicked.text).toContain('Clicked')
    const scrolled = await manager.scroll('session', 500)
    expect(scrolled.scrollY).toBeGreaterThan(0)
    const resized = await manager.setViewport('session', 375, 700)
    expect(resized.viewport).toEqual({ width: 375, height: 700 })
    const screenshot = await manager.screenshot('session')
    expect({
      width: screenshot.readUInt32BE(16),
      height: screenshot.readUInt32BE(20),
    }).toEqual({ width: 375, height: 700 })
    expect(manager.logs('session').some((entry) => entry.text === 'CLICK_OK')).toBe(true)
  }, 15_000)

  it('increments the page epoch only when a new open succeeds and preserves it across descriptions', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const first = await manager.open('page-epoch', 'data:text/html,<title>First epoch</title><button>Keep epoch</button>')
    const firstSnapshot = await manager.snapshot('page-epoch')
    expect(first.pageEpoch).toEqual(expect.any(Number))
    expect(firstSnapshot.pageEpoch).toBe(first.pageEpoch)

    const second = await manager.open('page-epoch', 'data:text/html,<title>Second epoch</title><button>Keep epoch</button>')
    expect(Number(second.pageEpoch)).toBeGreaterThan(Number(first.pageEpoch))
    const controls = second.interactive as Array<{ ref: string; text?: string }>
    const clicked = await manager.click('page-epoch', { ref: controls[0]?.ref })
    expect(clicked.pageEpoch).toBe(second.pageEpoch)
  }, 15_000)

  it('projects visually rendered text by excluding transparent content and including CSS generated status', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const html = `<style>
        .hidden { opacity: 0; pointer-events: none; }
        #status::after { content: "Unacknowledged"; }
        #status.ack::after { content: "Acknowledged"; }
      </style>
      <button onclick="document.querySelector('#card').classList.add('hidden'); document.querySelector('#status').classList.add('ack')">Apply</button>
      <article id="card">Web Degraded</article>
      <span id="status"></span>`
    const opened = await manager.open('visual-text', `data:text/html,${encodeURIComponent(html)}`)
    expect(opened.text).toContain('Web Degraded')
    expect(opened.text).toContain('Unacknowledged')
    const button = (opened.interactive as Array<{ ref: string; text?: string }>).find((item) => item.text === 'Apply')
    const clicked = await manager.click('visual-text', { ref: button?.ref })
    expect(clicked.text).not.toContain('Web Degraded')
    expect(clicked.text).toContain('Acknowledged')
    expect(clicked.text).not.toContain('Unacknowledged')
  })

  it('only exposes rendered interactive refs and rejects a ref as soon as its control becomes hidden', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const html = `<style>.gone { display: none }</style>
      <button id="first" onclick="this.classList.add('gone'); document.querySelector('#second').classList.remove('gone')">First action</button>
      <button id="second" class="gone">Second action</button>
      <div aria-hidden="true"><button>ARIA hidden action</button></div>
      <button style="opacity:0">Transparent action</button>`
    const opened = await manager.open('rendered-controls', `data:text/html,${encodeURIComponent(html)}`)
    const openedControls = opened.interactive as Array<{ ref: string; text?: string }>
    expect(openedControls.map((item) => item.text)).toEqual(['First action'])
    const firstRef = openedControls[0]?.ref || ''

    const clicked = await manager.click('rendered-controls', { ref: firstRef })
    expect((clicked.interactive as Array<{ text?: string }>).map((item) => item.text)).toEqual(['Second action'])
    await expect(manager.click('rendered-controls', { ref: firstRef })).rejects.toThrow(`Browser ref is no longer visible: ${firstRef}`)
  })

  it('restricts preview navigation, HTTP requests, and WebSockets to the opened loopback origin', async () => {
    let allowedRequests = 0
    let blockedRequests = 0
    let blockedUpgrades = 0
    const blocked = await listen(createServer((_request, response) => {
      blockedRequests += 1
      response.end('must not be reached')
    }).on('upgrade', (request, socket) => {
      blockedUpgrades += 1
      socket.destroy()
    }))
    const blockedPort = (blocked.address() as AddressInfo).port
    const allowed = await listen(createServer((request, response) => {
      if (request.url === '/same-origin') {
        allowedRequests += 1
        response.end('ok')
        return
      }
      response.setHeader('content-type', 'text/html')
      response.end(`<title>Origin boundary</title>
        <a href="http://127.0.0.1:${blockedPort}/navigation">Leave preview</a>
        <script>
          fetch('/same-origin').catch(() => undefined)
          fetch('http://127.0.0.1:${blockedPort}/fetch').catch(() => undefined)
          new WebSocket('ws://127.0.0.1:${blockedPort}/socket')
        </script>`)
    }))
    const allowedPort = (allowed.address() as AddressInfo).port
    const manager = new BrowserManager()
    managers.push(manager)

    const opened = await manager.open('isolated', `http://127.0.0.1:${allowedPort}/`)
    expect(opened.title).toBe('Origin boundary')
    await waitFor(() => allowedRequests === 1)
    expect(blockedRequests).toBe(0)
    expect(blockedUpgrades).toBe(0)
    expect(manager.logs('isolated').filter((entry) => entry.level === 'networkblocked').length).toBeGreaterThanOrEqual(2)

    const link = (opened.interactive as Array<{ ref: string; text?: string }>).find((item) => item.text === 'Leave preview')
    expect(link?.ref).toBeTruthy()
    await manager.click('isolated', { ref: link?.ref }).catch(() => undefined)
    expect(blockedRequests).toBe(0)
    expect((await manager.snapshot('isolated')).url).toBe(`http://127.0.0.1:${allowedPort}/`)

    await expect(manager.open('public', 'https://example.com/')).rejects.toThrow('local loopback URL')
  })

  it('closes the browser on abort so a timed-out action cannot perform a late same-origin side effect', async () => {
    let clickedRequests = 0
    let lateRequests = 0
    const server = await listen(createServer((request, response) => {
      if (request.url === '/clicked') {
        clickedRequests += 1
        response.end('clicked')
        return
      }
      if (request.url === '/late') {
        lateRequests += 1
        response.end('late')
        return
      }
      response.setHeader('content-type', 'text/html')
      response.end(`<title>Abort boundary</title>
        <button onclick="fetch('/clicked'); setTimeout(() => fetch('/late'), 150)">Start delayed effect</button>`)
    }))
    const port = (server.address() as AddressInfo).port
    const manager = new BrowserManager()
    managers.push(manager)
    const opened = await manager.open('abortable', `http://127.0.0.1:${port}/`)
    const button = (opened.interactive as Array<{ ref: string; text?: string }>).find((item) => item.text === 'Start delayed effect')
    expect(button?.ref).toBeTruthy()

    const controller = new AbortController()
    const clicking = manager.click('abortable', { ref: button?.ref }, controller.signal)
    await waitFor(() => clickedRequests === 1)
    controller.abort(new DOMException('fixture timeout', 'TimeoutError'))
    await expect(clicking).rejects.toMatchObject({ name: 'TimeoutError' })
    await new Promise((resolve) => setTimeout(resolve, 225))
    expect(lateRequests).toBe(0)

    const reopened = await manager.open('abortable', `http://127.0.0.1:${port}/`)
    expect(reopened.title).toBe('Abort boundary')
  })

  it('coalesces concurrent startup into one Chromium while isolating and independently closing session contexts', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const oneHtml = `<title>Session One</title><input aria-label="Value" value="one">`
    const twoHtml = `<title>Session Two</title><input aria-label="Value" value="two">`
    const [one, two, racedA, racedB] = await Promise.all([
      manager.open('one', `data:text/html,${encodeURIComponent(oneHtml)}`),
      manager.open('two', `data:text/html,${encodeURIComponent(twoHtml)}`),
      manager.snapshot('raced'),
      manager.snapshot('raced'),
    ])

    expect(one.title).toBe('Session One')
    expect(two.title).toBe('Session Two')
    expect(racedA.url).toBe('about:blank')
    expect(racedB.url).toBe('about:blank')
    expect(manager.diagnostics()).toEqual({ browserInstances: 1, sessionContexts: 3, pendingSessionContexts: 0 })

    const oneRef = (one.interactive as Array<{ ref: string; ariaLabel?: string }>).find((item) => item.ariaLabel === 'Value')?.ref
    expect(oneRef).toBeTruthy()
    await manager.fill('one', oneRef || '', 'changed-one')
    const twoValue = ((await manager.snapshot('two')).interactive as Array<{ ariaLabel?: string; value?: string }>)
      .find((item) => item.ariaLabel === 'Value')?.value
    expect(twoValue).toBe('two')

    await manager.close('one')
    expect(manager.diagnostics()).toEqual({ browserInstances: 1, sessionContexts: 2, pendingSessionContexts: 0 })
    expect((await manager.snapshot('two')).title).toBe('Session Two')
    const rehydratedOne = await manager.snapshot('one')
    expect(rehydratedOne.title).toBe('Session One')
    expect((rehydratedOne.interactive as Array<{ ariaLabel?: string; value?: string }>).find((item) => item.ariaLabel === 'Value')?.value).toBe('one')
    expect(manager.diagnostics()).toEqual({ browserInstances: 1, sessionContexts: 3, pendingSessionContexts: 0 })

    await manager.closeEverything()
    expect(manager.diagnostics()).toEqual({ browserInstances: 0, sessionContexts: 0, pendingSessionContexts: 0 })
    expect((await manager.open('two', `data:text/html,${encodeURIComponent(twoHtml)}`)).title).toBe('Session Two')
    expect(manager.diagnostics()).toEqual({ browserInstances: 1, sessionContexts: 1, pendingSessionContexts: 0 })

    const sharedBrowser = (manager as unknown as { browser?: { close(): Promise<void> } }).browser
    expect(sharedBrowser).toBeTruthy()
    await sharedBrowser?.close()
    await waitFor(() => manager.diagnostics().browserInstances === 0 && manager.diagnostics().sessionContexts === 0)
    expect((await manager.snapshot('two')).title).toBe('Session Two')
    expect(manager.diagnostics()).toEqual({ browserInstances: 1, sessionContexts: 1, pendingSessionContexts: 0 })
  })

  it('closes the Browser transport before Context drain and rejects work throughout idempotent shutdown', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    await manager.open('existing', 'data:text/html,<title>Existing</title>')
    const internal = manager as unknown as {
      sessions: Map<string, { context: { close(): Promise<void> } }>
      browser?: { close(): Promise<void> }
    }
    const context = internal.sessions.get('existing')?.context
    const browser = internal.browser
    expect(context).toBeTruthy()
    expect(browser).toBeTruthy()
    const originalClose = context?.close.bind(context)
    const originalBrowserClose = browser?.close.bind(browser)
    const closeOrder: string[] = []
    vi.spyOn(context as { close(): Promise<void> }, 'close').mockImplementationOnce(async () => {
      closeOrder.push('context')
      await originalClose?.()
    })
    let signalBrowserCloseStarted = () => {}
    const browserCloseStarted = new Promise<void>((resolveStarted) => { signalBrowserCloseStarted = resolveStarted })
    let releaseBrowserClose = () => {}
    const browserCloseGate = new Promise<void>((resolveClose) => { releaseBrowserClose = resolveClose })
    vi.spyOn(browser as { close(): Promise<void> }, 'close').mockImplementationOnce(async () => {
      closeOrder.push('browser')
      signalBrowserCloseStarted()
      await browserCloseGate
      await originalBrowserClose?.()
    })

    const firstShutdown = manager.shutdown()
    const secondShutdown = manager.shutdown()
    await browserCloseStarted
    await expect(manager.open('late', 'data:text/html,<title>Late</title>')).rejects.toThrow('Browser manager is shutting down')
    await expect(manager.snapshot('late')).rejects.toThrow('Browser manager is shutting down')
    expect(closeOrder).toEqual(['browser'])

    releaseBrowserClose()
    await Promise.all([firstShutdown, secondShutdown])
    expect(closeOrder).toEqual(['browser', 'context'])
    expect(manager.diagnostics()).toEqual({ browserInstances: 0, sessionContexts: 0, pendingSessionContexts: 0 })
    await expect(manager.open('after', 'data:text/html,<title>After</title>')).rejects.toThrow('Browser manager is shutting down')
  })

  it('returns DOM snapshots when loaded through the tsx keepNames development transform', async () => {
    const moduleUrl = pathToFileURL(resolve('src/server/browser-manager.ts')).href
    const script = `
      import { BrowserManager } from ${JSON.stringify(moduleUrl)}
      const manager = new BrowserManager()
      try {
        const html = '<style>button::after{content:"!"}</style><button>Open</button>'
        const result = await manager.open('tsx-regression', 'data:text/html,' + encodeURIComponent(html))
        process.stdout.write(JSON.stringify(result))
      } finally {
        await manager.closeEverything()
      }
    `
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', script,
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toMatchObject({
      text: 'Open !',
      interactive: [{ ref: 'e1', tag: 'button', text: 'Open' }],
    })
  }, 20_000)
})

async function listen(server: Server): Promise<Server> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for browser fixture')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
