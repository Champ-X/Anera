import type { Browser, BrowserContext, ConsoleMessage, Page } from 'playwright-core'
import { chromium } from 'playwright-core'
import { findBrowserExecutable } from './browser-executable.js'
import { config } from './config.js'
import { REFERENCE_FONT_MAX_FILES, REFERENCE_RENDER_FONT_CSS_MAX_BYTES } from './reference-fonts.js'
import {
  normalizeRenderedReferenceStyleProfile,
  type ReferenceRenderGeometryPolicy,
  type ReferenceRenderPhase,
  type ReferenceStyleSourceProfile,
  type RenderedReferenceAnchorProfile,
  type RenderedReferenceInteriorAttestation,
  type RenderedReferenceLayoutVariantProfile,
  type RenderedReferencePhaseProfile,
  type RenderedReferenceStyleProfile,
  type RenderedReferenceStyleVerification,
  type RenderedReferenceTypographyProbe,
} from './reference-style.js'

interface BrowserSession {
  browser: Browser
  context: BrowserContext
  page: Page
  logs: BrowserLog[]
  allowedOrigin: string
  pageEpoch: number
}

interface BrowserLog {
  level: string
  text: string
  at: string
}

export type BrowserRenderedReferenceStyleVerification = RenderedReferenceStyleVerification & {
  /** Monotonic identity of the successfully opened page verified by the server. */
  pageEpoch: number
}

export interface RenderedReferenceStyleScreenshotVerification {
  verification: BrowserRenderedReferenceStyleVerification
  screenshot: Buffer
}

export interface ReferenceRenderFontOptions {
  /** Trusted, already-vetted @font-face CSS. BrowserManager never fetches it. */
  fontCss?: string
  /** Every named family must expose at least one successfully loaded face. */
  expectedFontFamilies?: readonly string[]
}

export interface CaptureReferenceRenderBundleOptions extends ReferenceRenderFontOptions {
  signal?: AbortSignal
}

export interface ReferenceRenderCaptureBundle {
  profile: RenderedReferenceStyleProfile
  screenshots: Record<ReferenceRenderPhase, Buffer>
}

// Playwright serializes page callbacks with Function#toString before running
// them in the browser. `tsx`/esbuild's keepNames transform injects a Node-side
// `__name` helper into nested callbacks, but that helper does not exist in the
// page realm. Keep every non-trivial page program as literal JavaScript so the
// development runtime cannot rewrite it during TypeScript transpilation.
const INTERACTIVE_SNAPSHOT_SCRIPT = String.raw`(allElements) => {
  const rendered = (element) => {
    for (let current = element; current; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false
      const opacity = Number.parseFloat(style.opacity)
      if (Number.isFinite(opacity) && opacity <= 0.01) return false
    }
    const bounds = element.getBoundingClientRect()
    return bounds.width > 0 && bounds.height > 0
  }
  const elements = allElements.filter(rendered).slice(0, 120)
  let next = allElements.reduce((highest, element) => {
    const match = element.getAttribute('data-anera-ref')?.match(/^e(\d+)$/)
    return Math.max(highest, match ? Number.parseInt(match[1], 10) : 0)
  }, 0) + 1
  return elements.map((element) => {
    let ref = element.getAttribute('data-anera-ref')
    if (!ref) {
      ref = 'e' + next
      next += 1
      element.setAttribute('data-anera-ref', ref)
    }
    const control = element
    return {
      ref,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role'),
      type: element.getAttribute('type'),
      text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      ariaLabel: element.getAttribute('aria-label'),
      placeholder: element.getAttribute('placeholder'),
      value: 'value' in control ? control.value : undefined,
      checked: 'checked' in control ? control.checked : undefined,
      disabled: control.disabled || undefined,
    }
  })
}`

const VISIBLE_TEXT_SNAPSHOT_SCRIPT = String.raw`() => {
  const tokens = []
  const rendered = (element) => {
    for (let current = element; current; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false
      const opacity = Number.parseFloat(style.opacity)
      if (Number.isFinite(opacity) && opacity <= 0.01) return false
    }
    return true
  }
  const generated = (element, pseudo) => {
    const value = getComputedStyle(element, pseudo).content
    if (!value || value === 'none' || value === 'normal' || value === '""' || value === "''") return ''
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1).replace(/\\([\\"'])/g, '$1')
    }
    return ''
  }
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue?.replace(/\s+/g, ' ').trim()
      if (value) tokens.push(value)
      return
    }
    if (!(node instanceof Element) || !rendered(node)) return
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(node.tagName)) return
    const display = getComputedStyle(node).display
    const block = /^(?:block|flex|grid|table|list-item)/.test(display) || /^H[1-6]$/.test(node.tagName)
    if (block) tokens.push('\n')
    const before = generated(node, '::before')
    if (before) tokens.push(before)
    for (const child of node.childNodes) visit(child)
    const after = generated(node, '::after')
    if (after) tokens.push(after)
    if (block) tokens.push('\n')
  }
  visit(document.body)
  return tokens.join(' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}`

const REFERENCE_RENDER_SNAPSHOT_SCRIPT = String.raw`(payload) => {
  const specs = payload.specs || []
  const typographySpecs = payload.typographySpecs || []
  const rendered = (element) => {
    for (let current = element; current; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      const style = getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
      const opacity = Number.parseFloat(style.opacity)
      if (Number.isFinite(opacity) && opacity <= 0.01) return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0.5 && rect.height > 0.5
      && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
  }
  const occlusionRatio = (element, rect) => {
    const left = Math.max(0, rect.left)
    const right = Math.min(innerWidth, rect.right)
    const top = Math.max(0, rect.top)
    const bottom = Math.min(innerHeight, rect.bottom)
    if (right <= left || bottom <= top) return 0
    const points = [
      [0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8],
    ]
    let owned = 0
    for (const [xRatio, yRatio] of points) {
      const x = Math.min(innerWidth - 0.5, Math.max(0.5, left + (right - left) * xRatio))
      const y = Math.min(innerHeight - 0.5, Math.max(0.5, top + (bottom - top) * yRatio))
      const topmost = document.elementFromPoint(x, y)
      if (topmost && (topmost === element || element.contains(topmost))) owned += 1
    }
    return owned / points.length
  }
  const rounded = (value) => Math.round(value * 10000) / 10000
  const anchors = []
  for (const spec of specs) {
    let candidates
    try { candidates = [...document.querySelectorAll(spec.querySelector)] } catch { continue }
    const visible = candidates.filter((element) => {
      if (!rendered(element)) return false
      if (!spec.pseudo) return true
      const pseudoStyle = getComputedStyle(element, spec.pseudo)
      return pseudoStyle.display !== 'none'
        && pseudoStyle.visibility !== 'hidden'
        && pseudoStyle.content !== 'none'
        && pseudoStyle.content !== 'normal'
    })
    if (visible.length === 0) continue
    const samples = visible.slice(0, 12).map((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element, spec.pseudo || null)
      const styles = {}
      for (const property of spec.properties) {
        const value = style.getPropertyValue(property).replace(/\s+/g, ' ').trim().toLowerCase()
        if (value) styles[property] = value.slice(0, 240)
      }
      return {
        rect: {
          x: rounded(rect.x / innerWidth),
          y: rounded(rect.y / innerHeight),
          width: rounded(rect.width / innerWidth),
          height: rounded(rect.height / innerHeight),
        },
        styles,
        occlusion: Math.round(occlusionRatio(element, rect) * 100) / 100,
        position: getComputedStyle(element).position,
      }
    })
    const layoutRoot = /^\s*\.layout-[a-z0-9-]+(?:\:[-\w()]+)?\s*$/i.test(spec.selector)
    const strictGeometry = layoutRoot
      || /(?:^|[-_.#])(?:slide(?:\.active)?|slide-header|decoration|dots?|nav-controls|progress|counter|keyboard|hint)(?:$|[-_.:# ])/i.test(spec.selector)
      || samples.some((sample) => sample.position === 'fixed' || sample.position === 'absolute')
    anchors.push({
      selector: spec.selector,
      count: visible.length,
      geometry: strictGeometry ? 'strict' : spec.geometry || 'size',
      rects: samples.map((sample) => sample.rect),
      styles: samples.map((sample) => sample.styles),
      occlusion: samples.map((sample) => sample.occlusion),
    })
  }
  const viewportArea = Math.max(1, innerWidth * innerHeight)
  const normalizedColor = (style) => style.backgroundColor.replace(/\s+/g, ' ').trim().toLowerCase()
  const backgroundAlpha = (backgroundColor) => {
    const alphaMatch = backgroundColor.match(/rgba?\([^)]*(?:[,/]\s*([\d.]+%?))\s*\)$/)
    return backgroundColor === 'transparent'
      ? 0
      : alphaMatch?.[1]?.endsWith('%')
        ? Number.parseFloat(alphaMatch[1]) / 100
        : alphaMatch?.[1]
          ? Number.parseFloat(alphaMatch[1])
          : 1
  }
  const painted = (style, tag) => {
    const media = ['canvas', 'svg', 'video', 'img', 'picture'].includes(tag)
    return media
      || backgroundAlpha(normalizedColor(style)) > 0.01
      || style.backgroundImage !== 'none'
      || style.boxShadow !== 'none'
      || style.filter !== 'none'
  }
  const surfaceProbe = (tag, coverage, style, order) => ({
    order,
    tag,
    coverage: rounded(coverage),
    position: style.position.toLowerCase(),
    backgroundColor: normalizedColor(style),
    backgroundImage: style.backgroundImage.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 240),
    opacity: style.opacity.toLowerCase(),
    zIndex: style.zIndex.toLowerCase(),
  })
  const elementSurfaces = [document.documentElement, document.body, ...document.querySelectorAll('body *')]
    .filter(Boolean)
    .flatMap((element, order) => {
    if (!rendered(element)) return []
    const rect = element.getBoundingClientRect()
    const intersectionWidth = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left))
    const intersectionHeight = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top))
    const coverage = intersectionWidth * intersectionHeight / viewportArea
    if (coverage < 0.5) return []
    const style = getComputedStyle(element)
    const tag = element.tagName.toLowerCase()
    return painted(style, tag) ? [surfaceProbe(tag, coverage, style, order * 4)] : []
  })
  const pixel = (value) => {
    const match = String(value || '').trim().match(/^(-?[\d.]+)px$/)
    return match ? Number.parseFloat(match[1]) : String(value || '').trim() === '0' ? 0 : Number.NaN
  }
  const pseudoCoverage = (element, style) => {
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return 0
    if (style.content === 'none' || style.content === 'normal') return 0
    const opacity = Number.parseFloat(style.opacity)
    if (Number.isFinite(opacity) && opacity <= 0.01) return 0
    const elementRect = element.getBoundingClientRect()
    const fixed = style.position === 'fixed'
    const baseLeft = fixed ? 0 : elementRect.left
    const baseTop = fixed ? 0 : elementRect.top
    const baseWidth = fixed ? innerWidth : elementRect.width
    const baseHeight = fixed ? innerHeight : elementRect.height
    const left = pixel(style.left)
    const right = pixel(style.right)
    const top = pixel(style.top)
    const bottom = pixel(style.bottom)
    let width = pixel(style.width)
    let height = pixel(style.height)
    if (!Number.isFinite(width) && Number.isFinite(left) && Number.isFinite(right)) width = baseWidth - left - right
    if (!Number.isFinite(height) && Number.isFinite(top) && Number.isFinite(bottom)) height = baseHeight - top - bottom
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0
    const x = Number.isFinite(left) ? baseLeft + left : Number.isFinite(right) ? baseLeft + baseWidth - right - width : baseLeft
    const y = Number.isFinite(top) ? baseTop + top : Number.isFinite(bottom) ? baseTop + baseHeight - bottom - height : baseTop
    const intersectionWidth = Math.max(0, Math.min(innerWidth, x + width) - Math.max(0, x))
    const intersectionHeight = Math.max(0, Math.min(innerHeight, y + height) - Math.max(0, y))
    return intersectionWidth * intersectionHeight / viewportArea
  }
  const rootPseudoSurfaces = [document.documentElement, document.body].flatMap((element, elementIndex) => {
    if (!element || !rendered(element)) return []
    return ['::before', '::after'].flatMap((pseudo, pseudoIndex) => {
      const style = getComputedStyle(element, pseudo)
      const coverage = pseudoCoverage(element, style)
      const tag = element.tagName.toLowerCase() + pseudo
      if (coverage < 0.5 || !painted(style, tag)) return []
      return [surfaceProbe(tag, coverage, style, elementIndex * 4 + pseudoIndex + 1)]
    })
  })
  const overlayProbes = [...elementSurfaces, ...rootPseudoSurfaces]
    .sort((left, right) => right.coverage - left.coverage || left.order - right.order)
    .slice(0, 12)
    .map(({ order: _order, ...probe }) => probe)
  const activeSlide = document.querySelector('.slide.active') || document.querySelector('.slide') || document.body
  const typographyProbes = typographySpecs.flatMap((spec) => {
    let target
    try { target = [...activeSlide.querySelectorAll(spec.selector)].find(rendered) } catch { return [] }
    let synthetic
    if (!target) {
      if (spec.existingOnly) return []
      const tag = spec.selector === '.tag' ? 'span' : spec.selector
      if (!/^(?:span|h[1-6]|p|li)$/.test(tag)) return []
      synthetic = document.createElement(tag)
      if (spec.selector === '.tag') synthetic.className = 'tag'
      synthetic.setAttribute('data-anera-typography-probe', spec.selector)
      synthetic.textContent = 'M'
      synthetic.style.cssText = 'position:fixed!important;left:-100000px!important;top:0!important;pointer-events:none!important;'
      const parent = spec.selector === '.tag' ? activeSlide.querySelector('.slide-header') || activeSlide : activeSlide
      parent.appendChild(synthetic)
      target = synthetic
    }
    const style = getComputedStyle(target)
    const styles = {}
    for (const property of spec.properties) {
      const value = style.getPropertyValue(property).replace(/\s+/g, ' ').trim().toLowerCase()
      if (value) styles[property] = value.slice(0, 240)
    }
    synthetic?.remove()
    return [{ selector: spec.selector, styles }]
  })
  return { anchors, overlayProbes, typographyProbes }
}`

const SET_REFERENCE_RENDER_PHASE_SCRIPT = String.raw`(phase) => {
  const slides = [...document.querySelectorAll('.slide')]
  if (slides.length === 0) return
  const requestedIndex = typeof phase === 'number' ? phase : Number.NaN
  const index = Number.isInteger(requestedIndex)
    ? Math.max(0, Math.min(slides.length - 1, requestedIndex))
    : phase === 'cover' ? 0 : phase === 'closing' ? slides.length - 1 : Math.min(1, slides.length - 1)
  slides.forEach((slide, slideIndex) => {
    slide.classList.toggle('active', slideIndex === index)
    slide.classList.toggle('prev', slideIndex < index)
    slide.setAttribute('aria-hidden', slideIndex === index ? 'false' : 'true')
  })
  const progress = document.querySelector('.progress-bar')
  if (progress instanceof HTMLElement) progress.style.width = ((index + 1) / slides.length * 100) + '%'
  const counter = document.querySelector('.slide-counter')
  if (counter) {
    // Preserve descendant element and Text node identities. Slide runtimes
    // commonly retain references to #current/#total; assigning innerHTML or
    // textContent here would detach those nodes and silently break navigation
    // after deterministic all-interior verification restores the visible DOM.
    const setLeafText = (element, value) => {
      if (!element) return false
      if (element.childNodes.length === 1 && element.firstChild?.nodeType === Node.TEXT_NODE) {
        element.firstChild.nodeValue = value
        return true
      }
      return false
    }
    const current = counter.querySelector('#current, #current-slide, [data-current-slide], [data-slide-current]')
    const total = counter.querySelector('#total, #total-slides, [data-total-slides], [data-slide-total]')
    const currentUpdated = setLeafText(current, String(index + 1))
    const totalUpdated = setLeafText(total, String(slides.length))
    if (!currentUpdated && !totalUpdated && counter.childNodes.length === 1 && counter.firstChild?.nodeType === Node.TEXT_NODE) {
      counter.firstChild.nodeValue = (index + 1) + ' / ' + slides.length
    }
  }
  const buttons = [...document.querySelectorAll('.nav-btn, .nav-controls button')]
  if (buttons[0] instanceof HTMLButtonElement) buttons[0].disabled = index === 0
  if (buttons[1] instanceof HTMLButtonElement) buttons[1].disabled = index === slides.length - 1
}`

const REFERENCE_RENDER_PAGE_STATE_SCRIPT = String.raw`() => {
  const attributes = (element) => ({
    class: element.getAttribute('class'),
    style: element.getAttribute('style'),
    ariaHidden: element.getAttribute('aria-hidden'),
    hidden: element.hasAttribute('hidden'),
    inert: element.hasAttribute('inert'),
  })
  const textNodes = (element) => {
    const values = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) values.push(String(walker.currentNode.nodeValue || ''))
    return values
  }
  const slides = [...document.querySelectorAll('.slide')]
  return {
    slides: slides.map(attributes),
    progress: [...document.querySelectorAll('.progress-bar')].map(attributes),
    counters: [...document.querySelectorAll('.slide-counter')].map((element) => ({
      ...attributes(element),
      textNodes: textNodes(element),
    })),
    buttons: [...document.querySelectorAll('.nav-btn, .nav-controls button')].map((element) => ({
      ...attributes(element),
      disabled: element instanceof HTMLButtonElement ? element.disabled : undefined,
    })),
    activeIndex: slides.findIndex((slide) => slide.classList.contains('active')),
  }
}`

const RESTORE_REFERENCE_RENDER_PAGE_STATE_SCRIPT = String.raw`(state) => {
  const restoreAttributes = (element, snapshot) => {
    for (const [name, value] of [['class', snapshot.class], ['style', snapshot.style], ['aria-hidden', snapshot.ariaHidden]]) {
      if (value === null || value === undefined) element.removeAttribute(name)
      else element.setAttribute(name, value)
    }
    element.toggleAttribute('hidden', snapshot.hidden === true)
    element.toggleAttribute('inert', snapshot.inert === true)
  }
  const restoreList = (selector, snapshots, restoreExtra) => {
    const elements = [...document.querySelectorAll(selector)]
    if (elements.length !== snapshots.length) return false
    let extrasRestored = true
    elements.forEach((element, index) => {
      restoreAttributes(element, snapshots[index])
      if (restoreExtra && restoreExtra(element, snapshots[index]) === false) extrasRestored = false
    })
    return extrasRestored
  }
  const restoreTextNodes = (element, values) => {
    const nodes = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) nodes.push(walker.currentNode)
    if (nodes.length !== values.length) return false
    nodes.forEach((node, index) => { node.nodeValue = values[index] })
    return true
  }
  const slidesRestored = restoreList('.slide', state.slides)
  const progressRestored = restoreList('.progress-bar', state.progress)
  const countersRestored = restoreList('.slide-counter', state.counters, (element, snapshot) => restoreTextNodes(element, snapshot.textNodes))
  const buttonsRestored = restoreList('.nav-btn, .nav-controls button', state.buttons, (element, snapshot) => {
    if (element instanceof HTMLButtonElement && typeof snapshot.disabled === 'boolean') element.disabled = snapshot.disabled
  })
  return slidesRestored && progressRestored && countersRestored && buttonsRestored
}`

const REFERENCE_INTERIOR_LAYOUT_SCRIPT = String.raw`(slideIndex) => {
  const slides = [...document.querySelectorAll('.slide')]
  const slide = slides[slideIndex]
  if (!slide) return { layoutSelectors: [], specs: [] }
  const layoutSelectors = [...slide.classList]
    .filter((className) => /^layout-[a-z0-9-]+$/.test(className) && !['layout-cover', 'layout-closing'].includes(className))
    .map((className) => '.' + className)
    .slice(0, 4)
  if (layoutSelectors.length === 0) return { layoutSelectors, specs: [] }
  const scope = layoutSelectors[0]
  const properties = [
    'display', 'position', 'visibility', 'opacity', 'transform', 'pointer-events',
    'flex-direction', 'align-items', 'justify-content',
    'grid-template-columns', 'grid-template-rows', 'gap', 'row-gap', 'column-gap',
    'width', 'height', 'min-width', 'min-height',
    'overflow', 'background-color', 'background-image', 'border', 'border-radius', 'clip-path',
  ]
  const candidates = [slide, ...slide.querySelectorAll('*')].flatMap((element, order) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const visible = rect.width > 0.5 && rect.height > 0.5
      && style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility)
      && Number.parseFloat(style.opacity || '1') > 0.01
    if (!visible) return []
    const media = ['CANVAS', 'SVG', 'IMG', 'VIDEO', 'PICTURE'].includes(element.tagName)
    const structuralDisplay = ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display)
    const positioned = ['absolute', 'fixed', 'sticky'].includes(style.position)
    const direct = element.parentElement === slide
    if (element !== slide && !media && !structuralDisplay && !positioned && !direct) return []
    const className = [...element.classList].find((value) => /^[a-z][a-z0-9-]{1,80}$/.test(value))
    let selector
    if (element === slide) selector = scope
    else if (className) selector = scope + ' .' + className
    else if (media) selector = scope + ' ' + element.tagName.toLowerCase()
    else return []
    const area = Math.min(1, Math.max(0, rect.width * rect.height / Math.max(1, innerWidth * innerHeight)))
    const score = element === slide ? 100000
      : media ? 90000
        : positioned ? 70000 + area * 1000
          : structuralDisplay ? 50000 + area * 1000
            : 30000 + area * 1000
    return [{ selector, querySelector: selector, properties, score, order }]
  })
  const seen = new Set()
  const specs = candidates
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .filter((candidate) => !seen.has(candidate.selector) && seen.add(candidate.selector))
    .slice(0, 12)
    .map(({ score, order, ...candidate }) => candidate)
  return { layoutSelectors, specs }
}`

const INTERACTIVE_SNAPSHOT_PAGE_FUNCTION = Function(
  `"use strict"; return (${INTERACTIVE_SNAPSHOT_SCRIPT})`,
)() as (elements: Element[]) => Array<Record<string, unknown>>
const VISIBLE_TEXT_SNAPSHOT_PAGE_FUNCTION = Function(
  `"use strict"; return (${VISIBLE_TEXT_SNAPSHOT_SCRIPT})`,
)() as () => string
const REFERENCE_RENDER_SNAPSHOT_PAGE_FUNCTION = Function(
  `"use strict"; return (${REFERENCE_RENDER_SNAPSHOT_SCRIPT})`,
)() as (payload: ReferenceRenderSnapshotSpec) => RenderedReferencePhaseProfile
const SET_REFERENCE_RENDER_PHASE_PAGE_FUNCTION = Function(
  `"use strict"; return (${SET_REFERENCE_RENDER_PHASE_SCRIPT})`,
)() as (phase: string | number) => void
const REFERENCE_RENDER_PAGE_STATE_PAGE_FUNCTION = Function(
  `"use strict"; return (${REFERENCE_RENDER_PAGE_STATE_SCRIPT})`,
)() as () => ReferenceRenderPageState
const RESTORE_REFERENCE_RENDER_PAGE_STATE_PAGE_FUNCTION = Function(
  `"use strict"; return (${RESTORE_REFERENCE_RENDER_PAGE_STATE_SCRIPT})`,
)() as (state: ReferenceRenderPageState) => boolean
const REFERENCE_INTERIOR_LAYOUT_PAGE_FUNCTION = Function(
  `"use strict"; return (${REFERENCE_INTERIOR_LAYOUT_SCRIPT})`,
)() as (slideIndex: number) => ReferenceInteriorLayoutSnapshot

interface ReferenceRenderSelectorSpec {
  selector: string
  querySelector: string
  pseudo?: '::before' | '::after'
  properties: string[]
  geometry?: ReferenceRenderGeometryPolicy
}

interface ReferenceTypographySelectorSpec {
  selector: string
  properties: string[]
  existingOnly?: boolean
}

interface ReferenceRenderSnapshotSpec {
  specs: ReferenceRenderSelectorSpec[]
  typographySpecs: ReferenceTypographySelectorSpec[]
}

interface ReferenceRenderElementState {
  class: string | null
  style: string | null
  ariaHidden: string | null
  hidden: boolean
  inert: boolean
}

interface ReferenceRenderPageState {
  slides: ReferenceRenderElementState[]
  progress: ReferenceRenderElementState[]
  counters: Array<ReferenceRenderElementState & { textNodes: string[] }>
  buttons: Array<ReferenceRenderElementState & { disabled?: boolean }>
  activeIndex: number
}

interface ReferenceInteriorLayoutSnapshot {
  layoutSelectors: string[]
  specs: ReferenceRenderSelectorSpec[]
}

const REFERENCE_TYPOGRAPHY_PROPERTIES = [
  'font-family', 'font-size', 'font-style', 'font-weight',
  'line-height', 'letter-spacing', 'color', 'text-align', 'text-transform',
] as const

const REFERENCE_TYPOGRAPHY_SELECTORS: Record<ReferenceRenderPhase, readonly string[]> = {
  cover: ['h1'],
  content: ['h2', 'h3', 'h4', '.tag', 'p', 'li'],
  closing: ['h1'],
}

const REFERENCE_RENDER_FREEZE_CSS = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`

const INSTALL_AND_AWAIT_REFERENCE_FONTS_SCRIPT = String.raw`async (payload) => {
  const normalizeFamily = (value) => String(value || '')
    .trim()
    .replace(/^(?:["'])(.*)(?:["'])$/, '$1')
    .replace(/\s+/g, ' ')
    .toLowerCase()
  let style = document.getElementById('anera-trusted-reference-fonts')
  if (!(style instanceof HTMLStyleElement)) {
    style = document.createElement('style')
    style.id = 'anera-trusted-reference-fonts'
    ;(document.head || document.documentElement).appendChild(style)
  }
  if (style.textContent !== payload.fontCss) style.textContent = payload.fontCss
  if (!document.fonts) {
    return { ok: false, loadedFamilies: [], missingFamilies: payload.expectedFontFamilies, error: 'FontFaceSet is unavailable' }
  }
  const load = async () => {
    await document.fonts.ready
    const results = await Promise.allSettled(payload.expectedFontFamilies.map((family) => (
      document.fonts.load('16px ' + JSON.stringify(family), 'BESbswy0123456789')
    )))
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected) throw rejected.reason
    await document.fonts.ready
  }
  let timer
  const outcome = await Promise.race([
    load().then(
      () => ({ kind: 'ready' }),
      (error) => ({ kind: 'error', error: error instanceof Error ? error.message : String(error) }),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), payload.timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (outcome.kind !== 'ready') {
    return {
      ok: false,
      loadedFamilies: [],
      missingFamilies: payload.expectedFontFamilies,
      error: outcome.kind === 'timeout' ? 'timed out waiting for document.fonts.ready' : outcome.error,
    }
  }
  const loadedFamilies = [...document.fonts]
    .filter((face) => face.status === 'loaded')
    .map((face) => String(face.family || '').trim())
  const normalizedLoaded = new Set(loadedFamilies.map(normalizeFamily))
  const missingFamilies = payload.expectedFontFamilies.filter((family) => !normalizedLoaded.has(normalizeFamily(family)))
  return {
    ok: missingFamilies.length === 0,
    loadedFamilies,
    missingFamilies,
    ...(missingFamilies.length > 0 ? { error: 'expected font faces did not reach loaded state' } : {}),
  }
}`

interface ReferenceFontLoadPayload {
  fontCss: string
  expectedFontFamilies: string[]
  timeoutMs: number
}

interface ReferenceFontLoadResult {
  ok: boolean
  loadedFamilies: string[]
  missingFamilies: string[]
  error?: string
}

const INSTALL_AND_AWAIT_REFERENCE_FONTS_PAGE_FUNCTION = Function(
  `"use strict"; return (${INSTALL_AND_AWAIT_REFERENCE_FONTS_SCRIPT})`,
)() as (payload: ReferenceFontLoadPayload) => Promise<ReferenceFontLoadResult>

export class BrowserManager {
  private readonly sessions = new Map<string, BrowserSession>()
  private readonly sessionCreations = new Map<string, Promise<BrowserSession>>()
  private readonly lastOpenedUrls = new Map<string, string>()
  private nextPageEpoch = 1
  private browser: Browser | undefined
  private browserLaunch: Promise<Browser> | undefined
  private shuttingDown = false
  private shutdownWork?: Promise<void>

  async open(sessionId: string, url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.assertAcceptingWork()
    const allowedOrigin = previewOrigin(url)
    if (signal?.aborted) throw abortReason(signal)
    const current = this.sessions.get(sessionId)
    if (current?.allowedOrigin && current.allowedOrigin !== allowedOrigin) await this.close(sessionId)
    return await this.runAbortable(sessionId, signal, async (session) => {
      session.allowedOrigin = allowedOrigin
      await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      await session.page.waitForTimeout(150)
      this.lastOpenedUrls.set(sessionId, url)
      this.establishPageEpoch(session)
      return await this.describe(session)
    }, { rehydrate: false })
  }

  async snapshot(sessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => await this.describe(session))
  }

  async click(sessionId: string, target: { ref?: string; text?: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      const locator = target.ref
        ? this.refLocator(session.page, target.ref)
        : session.page.getByText(target.text || '', { exact: true }).first()
      if (await locator.count() === 0) throw new Error(target.ref ? `No element with browser ref: ${target.ref}` : `No visible element with exact text: ${target.text}`)
      if (!await locator.isVisible()) throw new Error(target.ref ? `Browser ref is no longer visible: ${target.ref}` : `No visible element with exact text: ${target.text}`)
      const href = await locator.getAttribute('href')
      if (href) {
        const targetUrl = new URL(href, session.page.url()).toString()
        if (!browserRequestAllowed(targetUrl, session.allowedOrigin)) {
          throw new Error('Browser navigation outside the preview origin is blocked')
        }
      }
      await locator.click({ timeout: 8_000 })
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async fill(sessionId: string, ref: string, value: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      await this.refLocator(session.page, ref).fill(value, { timeout: 8_000 })
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async select(sessionId: string, ref: string, value: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      await this.refLocator(session.page, ref).selectOption(value, { timeout: 8_000 })
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async check(sessionId: string, ref: string, checked: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      await this.refLocator(session.page, ref).setChecked(checked, { timeout: 8_000 })
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async press(sessionId: string, key: string, ref?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      if (ref) await this.refLocator(session.page, ref).focus()
      await session.page.keyboard.press(key)
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async scroll(sessionId: string, deltaY: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      await session.page.evaluate((amount) => window.scrollBy({ top: amount, behavior: 'instant' }), deltaY)
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async setViewport(sessionId: string, width: number, height: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (width < 240 || width > 2400 || height < 240 || height > 2400) throw new Error('Viewport must be between 240 and 2400 pixels')
    return await this.runAbortable(sessionId, signal, async (session) => {
      await session.page.setViewportSize({ width, height })
      return await this.describe(session)
    })
  }

  async screenshot(sessionId: string, signal?: AbortSignal): Promise<Buffer> {
    return await this.runAbortable(sessionId, signal, async (session) => await session.page.screenshot({ fullPage: false, type: 'png' }))
  }

  async captureReferenceRenderProfile(
    html: string,
    sourceProfile: ReferenceStyleSourceProfile,
    evidenceSha256: string,
    viewport: { width: number; height: number },
    signal?: AbortSignal,
    fontOptions?: ReferenceRenderFontOptions,
  ): Promise<RenderedReferenceStyleProfile> {
    return (await this.captureReferenceRenderBundle(html, sourceProfile, evidenceSha256, viewport, {
      ...fontOptions,
      signal,
    })).profile
  }

  async captureReferenceRenderBundle(
    html: string,
    sourceProfile: ReferenceStyleSourceProfile,
    evidenceSha256: string,
    viewport: { width: number; height: number },
    options: CaptureReferenceRenderBundleOptions = {},
  ): Promise<ReferenceRenderCaptureBundle> {
    this.assertAcceptingWork()
    const signal = options.signal
    if (signal?.aborted) throw abortReason(signal)
    const trustedFonts = normalizeReferenceRenderFontOptions(options)
    const specs = referenceRenderSelectorSpecs(sourceProfile)
    if (specs.length === 0) throw new Error('Reference source profile contains no required render anchors')
    const browser = await this.getBrowser()
    const context = await browser.newContext({
      viewport,
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    })
    try {
      await context.route('**/*', async (route) => await route.abort('blockedbyclient'))
      const page = await context.newPage()
      await page.setContent(sanitizeReferenceRenderHtml(html, Boolean(trustedFonts)), { waitUntil: 'domcontentloaded', timeout: 20_000 })
      const slideCount = await page.locator('.slide').count()
      if (slideCount < 3) {
        throw new Error('Exact rendered reference requires at least three .slide elements for distinct cover, content, and closing phases')
      }
      await installAndAwaitReferenceFonts(page, trustedFonts)
      await page.addStyleTag({ content: REFERENCE_RENDER_FREEZE_CSS })
      await page.evaluate(SET_REFERENCE_RENDER_PHASE_PAGE_FUNCTION, 'cover')
      await settleReferenceRender(page)
      const phases: Record<ReferenceRenderPhase, RenderedReferencePhaseProfile> = {
        cover: await captureReferencePhase(page, specs, 'cover'),
        content: { anchors: [], overlayProbes: [], typographyProbes: [] },
        closing: { anchors: [], overlayProbes: [], typographyProbes: [] },
      }
      const screenshots: Record<ReferenceRenderPhase, Buffer> = {
        cover: await captureReferenceViewportScreenshot(page, viewport, 'cover'),
        content: Buffer.alloc(0),
        closing: Buffer.alloc(0),
      }
      await page.evaluate(SET_REFERENCE_RENDER_PHASE_PAGE_FUNCTION, 'content')
      await settleReferenceRender(page)
      phases.content = await captureReferencePhase(page, specs, 'content')
      screenshots.content = await captureReferenceViewportScreenshot(page, viewport, 'content')
      const interiorVariants: RenderedReferenceLayoutVariantProfile[] = []
      const capturedLayoutSelectors = new Set<string>()
      const persistentChromeSpecs = specs.filter((spec) => (
        /(?:^|[-_.#])(?:nav|progress|counter|keyboard|hint|chrome)(?:$|[-_.:# ])/iu.test(spec.selector)
      )).slice(0, 6)
      for (let slideIndex = 1; slideIndex < slideCount - 1; slideIndex += 1) {
        await page.evaluate(SET_REFERENCE_RENDER_PHASE_PAGE_FUNCTION, slideIndex)
        await settleReferenceRender(page)
        const layout = await page.evaluate(REFERENCE_INTERIOR_LAYOUT_PAGE_FUNCTION, slideIndex)
        const layoutSelector = layout.layoutSelectors[0]
        if (!layoutSelector || capturedLayoutSelectors.has(layoutSelector)) continue
        if (interiorVariants.length >= 16) {
          throw new Error('Exact rendered reference contains more than 16 distinct interior .layout-* variants')
        }
        const layoutSourceSpecs = specs.filter((spec) => (
          spec.selector === layoutSelector || spec.selector.startsWith(`${layoutSelector} `)
        )).slice(0, 2)
        const variantSpecs = [...layout.specs, ...layoutSourceSpecs, ...persistentChromeSpecs]
          .filter((spec, index, all) => all.findIndex((candidate) => candidate.selector === spec.selector) === index)
          .slice(0, 20)
          .map((spec) => ({
            ...spec,
            ...referenceRenderIntrinsicBlockGeometry(sourceProfile, spec.selector),
          }))
        const variantProfile = await captureReferencePhase(page, variantSpecs, 'content', undefined, true)
        if (!variantProfile.anchors.some((anchor) => anchor.selector === layoutSelector)) {
          throw new Error(`Exact rendered reference variant ${layoutSelector} has no visible structural root`)
        }
        capturedLayoutSelectors.add(layoutSelector)
        interiorVariants.push({ layoutSelector, profile: variantProfile })
      }
      await page.evaluate(SET_REFERENCE_RENDER_PHASE_PAGE_FUNCTION, 'closing')
      await settleReferenceRender(page)
      phases.closing = await captureReferencePhase(page, specs, 'closing')
      screenshots.closing = await captureReferenceViewportScreenshot(page, viewport, 'closing')
      if (signal?.aborted) throw abortReason(signal)
      if (
        screenshots.cover.equals(screenshots.content)
        || screenshots.cover.equals(screenshots.closing)
        || screenshots.content.equals(screenshots.closing)
      ) {
        throw new Error('Exact rendered reference phases did not produce three distinct viewport screenshots')
      }
      const profile = normalizeRenderedReferenceStyleProfile({
        version: 1,
        evidenceSha256,
        viewport,
        phases,
        ...(interiorVariants.length > 0 ? { interiorVariants } : {}),
      }, { evidenceSha256, viewport })
      return { profile, screenshots }
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  async verifyRenderedReferenceStyle(
    sessionId: string,
    profile: RenderedReferenceStyleProfile,
    phase: ReferenceRenderPhase,
    signal?: AbortSignal,
    fontOptions?: ReferenceRenderFontOptions,
  ): Promise<BrowserRenderedReferenceStyleVerification> {
    const normalized = normalizeRenderedReferenceStyleProfile(profile)
    return await this.runAbortable(sessionId, signal, async (session) => (
      await verifyRenderedReferenceStyleInSession(session, normalized, phase, false, fontOptions)
    ).verification)
  }

  async verifyRenderedReferenceStyleAndScreenshot(
    sessionId: string,
    profile: RenderedReferenceStyleProfile,
    phase: ReferenceRenderPhase,
    signal?: AbortSignal,
    fontOptions?: ReferenceRenderFontOptions,
  ): Promise<RenderedReferenceStyleScreenshotVerification> {
    const normalized = normalizeRenderedReferenceStyleProfile(profile)
    return await this.runAbortable(sessionId, signal, async (session) => {
      const result = await verifyRenderedReferenceStyleInSession(session, normalized, phase, true, fontOptions)
      if (!result.screenshot) throw new Error('Atomic rendered-reference verification did not produce a screenshot')
      return { verification: result.verification, screenshot: result.screenshot }
    })
  }

  logs(sessionId: string): BrowserLog[] {
    return [...(this.sessions.get(sessionId)?.logs ?? [])]
  }

  diagnostics(): { browserInstances: number; sessionContexts: number; pendingSessionContexts: number } {
    return {
      browserInstances: this.browser?.isConnected() ? 1 : 0,
      sessionContexts: this.sessions.size,
      pendingSessionContexts: this.sessionCreations.size,
    }
  }

  async close(sessionId: string): Promise<void> {
    const pending = this.sessionCreations.get(sessionId)
    const session = this.sessions.get(sessionId) ?? (pending ? await pending.catch(() => undefined) : undefined)
    if (!session) return
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
    await session.context.close()
  }

  async closeEverything(): Promise<void> {
    await Promise.allSettled([...this.sessionCreations.values()])
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(sessions.map(async (session) => await session.context.close()))
    const launching = this.browserLaunch
    if (launching) await launching.catch(() => undefined)
    const browser = this.browser
    this.browser = undefined
    try {
      if (browser?.isConnected()) await browser.close()
    } finally {
      this.lastOpenedUrls.clear()
    }
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownWork) {
      // Flip admission before the shutdown drain snapshots pending Contexts and
      // Browser launches. Any operation that crossed this boundary has already
      // registered its creation promise and is therefore included in the drain.
      this.shuttingDown = true
      this.shutdownWork = this.drainForShutdown()
    }
    await this.shutdownWork
  }

  private async drainForShutdown(): Promise<void> {
    await Promise.allSettled([...this.sessionCreations.values()])
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    const launching = this.browserLaunch
    if (launching) await launching.catch(() => undefined)
    const browser = this.browser
    this.browser = undefined
    try {
      // A stuck per-Context teardown must not prevent service shutdown. Close
      // the shared transport first; Playwright then releases every outstanding
      // page operation and Context close before the final per-session drain.
      if (browser?.isConnected()) await browser.close()
    } finally {
      await Promise.allSettled(sessions.map(async (session) => await session.context.close()))
      this.lastOpenedUrls.clear()
    }
  }

  private async get(sessionId: string): Promise<BrowserSession> {
    this.assertAcceptingWork()
    const current = this.sessions.get(sessionId)
    if (current?.browser.isConnected()) return current
    if (current) {
      this.sessions.delete(sessionId)
      await current.context.close().catch(() => undefined)
    }
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return await pending
    let creation: Promise<BrowserSession>
    creation = this.createSession(sessionId).finally(() => {
      if (this.sessionCreations.get(sessionId) === creation) this.sessionCreations.delete(sessionId)
    })
    this.sessionCreations.set(sessionId, creation)
    return await creation
  }

  private async createSession(sessionId: string): Promise<BrowserSession> {
    const browser = await this.getBrowser()
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    })
    const page = await context.newPage()
    const logs: BrowserLog[] = []
    const session: BrowserSession = { browser, context, page, logs, allowedOrigin: '', pageEpoch: 0 }
    const appendLog = (entry: BrowserLog) => {
      logs.push(entry)
      if (logs.length > 200) logs.splice(0, logs.length - 200)
    }
    const capture = (message: ConsoleMessage) => {
      appendLog({ level: message.type(), text: message.text(), at: new Date().toISOString() })
    }
    page.on('console', capture)
    page.on('pageerror', (error) => capture({ type: () => 'error', text: () => error.message } as ConsoleMessage))
    page.on('requestfailed', (request) => {
      appendLog({ level: 'requestfailed', text: `${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}`, at: new Date().toISOString() })
    })
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (browserRequestAllowed(url, session.allowedOrigin)) {
        await route.continue()
        return
      }
      appendLog({ level: 'networkblocked', text: `Blocked ${route.request().method()} ${url}: outside preview origin`, at: new Date().toISOString() })
      await route.abort('blockedbyclient')
    })
    await context.routeWebSocket(/.*/, async (socket) => {
      if (browserRequestAllowed(socket.url(), session.allowedOrigin)) {
        socket.connectToServer()
        return
      }
      appendLog({ level: 'networkblocked', text: `Blocked WebSocket ${socket.url()}: outside preview origin`, at: new Date().toISOString() })
      await socket.close({ code: 1008, reason: 'Outside preview origin' })
    })
    if (!browser.isConnected()) {
      await context.close().catch(() => undefined)
      throw new Error('Browser disconnected while creating an isolated session context')
    }
    this.sessions.set(sessionId, session)
    return session
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser
    if (this.browserLaunch) return await this.browserLaunch
    const executablePath = findBrowserExecutable(config.browserExecutablePath)
    let launch: Promise<Browser>
    launch = chromium.launch({ executablePath, headless: true, args: ['--disable-dev-shm-usage'] }).then((browser) => {
      this.browser = browser
      browser.on('disconnected', () => {
        if (this.browser === browser) this.browser = undefined
        for (const [sessionId, session] of this.sessions) {
          if (session.browser === browser) this.sessions.delete(sessionId)
        }
      })
      return browser
    }).finally(() => {
      if (this.browserLaunch === launch) this.browserLaunch = undefined
    })
    this.browserLaunch = launch
    return await launch
  }

  private async runAbortable<T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    operation: (session: BrowserSession) => Promise<T>,
    options: { rehydrate?: boolean } = {},
  ): Promise<T> {
    this.assertAcceptingWork()
    let aborted = signal?.aborted === true
    const abort = () => {
      aborted = true
      void this.close(sessionId).catch(() => undefined)
    }
    if (!aborted) signal?.addEventListener('abort', abort, { once: true })
    try {
      if (aborted) throw abortReason(signal)
      const session = await this.get(sessionId)
      if (aborted || signal?.aborted) {
        await this.close(sessionId).catch(() => undefined)
        throw abortReason(signal)
      }
      if (options.rehydrate !== false && session.page.url() === 'about:blank') {
        await this.rehydrate(sessionId, session)
      }
      const result = await operation(session)
      if (aborted || signal?.aborted) throw abortReason(signal)
      return result
    } catch (error) {
      if (aborted || signal?.aborted) throw abortReason(signal)
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  private assertAcceptingWork(): void {
    if (this.shuttingDown) throw new Error('Browser manager is shutting down')
  }

  private async rehydrate(sessionId: string, session: BrowserSession): Promise<void> {
    const url = this.lastOpenedUrls.get(sessionId)
    if (!url) return
    session.allowedOrigin = previewOrigin(url)
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await session.page.waitForTimeout(150)
    this.establishPageEpoch(session)
    // Reassign deterministic refs before a resumed turn tries to reuse the
    // latest snapshot's eN target after its prior Context was released.
    await this.describe(session)
  }

  private establishPageEpoch(session: BrowserSession): void {
    session.pageEpoch = this.nextPageEpoch
    this.nextPageEpoch += 1
  }

  private refLocator(page: Page, ref: string) {
    if (!/^e\d+$/.test(ref)) throw new Error('Browser ref must look like e1')
    return page.locator(`[data-anera-ref="${ref}"]`).first()
  }

  private async describe(session: BrowserSession): Promise<Record<string, unknown>> {
    const page = session.page
    const interactive = await page
      .locator('a,button,input,textarea,select,[role="button"],[role="checkbox"],[contenteditable="true"]')
      .evaluateAll(INTERACTIVE_SNAPSHOT_PAGE_FUNCTION)
    const visibleText = await page.evaluate(VISIBLE_TEXT_SNAPSHOT_PAGE_FUNCTION)
    return {
      url: page.url(),
      pageEpoch: session.pageEpoch,
      title: await page.title(),
      viewport: page.viewportSize(),
      scrollY: await page.evaluate(() => window.scrollY),
      text: visibleText.slice(0, 20_000),
      interactive,
    }
  }
}

const REFERENCE_RENDER_BASE_PROPERTIES = [
  'display', 'position', 'visibility', 'opacity', 'transform', 'pointer-events',
] as const

function sanitizeReferenceRenderHtml(html: string, allowInlineFontData = false): string {
  const sanitized = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, ' ')
    .replace(/<script\b[^>]*\/?\s*>/giu, ' ')
    .replace(/<(?:iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed)\s*>/giu, ' ')
    .replace(/<(?:iframe|object|embed)\b[^>]*\/?\s*>/giu, ' ')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*(?:["']?refresh["']?)[^>]*>/giu, ' ')
    .replace(/<base\b[^>]*>/giu, ' ')
    .replace(/<(?:animate|set|animatetransform|animatemotion)\b[^>]*>[\s\S]*?<\/(?:animate|set|animatetransform|animatemotion)\s*>/giu, ' ')
    .replace(/<(?:animate|set|animatetransform|animatemotion)\b[^>]*\/?\s*>/giu, ' ')
    .replace(/\s+on[a-z][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, ' ')
    .replace(/\s+(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/giu, ' ')
  const fontSource = allowInlineFontData ? 'data:' : "'none'"
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src ${fontSource}; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'">`
  if (/<head\b[^>]*>/iu.test(sanitized)) return sanitized.replace(/<head\b[^>]*>/iu, (head) => `${head}${policy}`)
  if (/<html\b[^>]*>/iu.test(sanitized)) return sanitized.replace(/<html\b[^>]*>/iu, (root) => `${root}<head>${policy}</head>`)
  return `<head>${policy}</head>${sanitized}`
}

function referenceRenderSelectorSpecs(sourceProfile: ReferenceStyleSourceProfile): ReferenceRenderSelectorSpec[] {
  return sourceProfile.rules
    .filter((rule) => {
      // Root/type selectors have dedicated canvas and typography probes. Keep
      // ordinary text replacement out of geometry checks, while admitting
      // visible interior grid/flex/component structure from the reference.
      if (!/[.#][-\w]+/u.test(rule.selector)) return false
      if (/(?:^|[\s>+~])(?:h[1-6]|p|li)(?::[-\w()]+)?$/iu.test(rule.selector)) return false
      if (rule.requiredInDom) return true
      return rule.declarations.some((entry) => [
        'align-items', 'background', 'background-color', 'border', 'border-radius',
        'clip-path', 'column-gap', 'display', 'gap', 'grid-template-columns',
        'grid-template-rows', 'height', 'justify-content', 'position', 'row-gap',
        'width',
      ].includes(entry.property))
    })
    .slice(0, 48)
    .map((rule) => {
      const pseudoMatch = rule.selector.match(/::(?:before|after)\b/iu)?.[0].toLowerCase() as '::before' | '::after' | undefined
      const querySelector = pseudoMatch ? rule.selector.replace(/::(?:before|after)\b/giu, '') : rule.selector
      const properties = [...new Set([
        ...REFERENCE_RENDER_BASE_PROPERTIES,
        ...rule.declarations.map((entry) => entry.property),
        ...(rule.effectiveFontFamily ? ['font-family'] : []),
      ])].slice(0, 24)
      return {
        selector: rule.selector,
        querySelector,
        ...(pseudoMatch ? { pseudo: pseudoMatch } : {}),
        properties,
        ...referenceRenderIntrinsicBlockGeometry(sourceProfile, rule.selector),
      }
    })
}

/**
 * Localized presentation copy legitimately changes the natural block height
 * of layout descendants even when the reference's grid/flex grammar is
 * copied exactly. Keep those blocks distinct from fixed controls and
 * decoration so rendered evidence does not reward filler copy or invented
 * height overrides merely to reproduce the demo text's pixel metrics.
 */
function referenceRenderIntrinsicBlockGeometry(
  sourceProfile: ReferenceStyleSourceProfile,
  selector: string,
): { geometry: 'intrinsic-block' } | Record<string, never> {
  if (!/^\s*\.layout-[a-z0-9-]+\s+/iu.test(selector)) return {}
  const terminal = selector.match(/(\.[a-z][a-z0-9-]*)(?::[-\w()]+)?\s*$/iu)?.[1]?.toLowerCase()
  if (!terminal) return {}
  if (/(?:circle|dots?|decoration|accent-line|nav-btn|bar-track|bar-fill|progress|icon|badge)$/iu.test(terminal)) {
    return {}
  }
  const normalized = selector.replace(/\s+/gu, ' ').trim().toLowerCase()
  const sourceRule = sourceProfile.rules.find((rule) => {
    const candidate = rule.selector.replace(/\s+/gu, ' ').trim().toLowerCase()
    return candidate === normalized || candidate === terminal
  })
  const explicitVerticalSize = sourceRule?.declarations.some(({ property, value }) => (
    property === 'height'
    || property === 'max-height'
    || (property === 'min-height' && !/^(?:0(?:px|rem|em|%)?|auto)$/iu.test(value.trim()))
  )) === true
  return explicitVerticalSize ? {} : { geometry: 'intrinsic-block' }
}

function referenceRenderSelectorSpecFromAnchor(anchor: RenderedReferenceAnchorProfile): ReferenceRenderSelectorSpec {
  const pseudoMatch = anchor.selector.match(/::(?:before|after)\b/iu)?.[0].toLowerCase() as '::before' | '::after' | undefined
  return {
    selector: anchor.selector,
    querySelector: pseudoMatch ? anchor.selector.replace(/::(?:before|after)\b/giu, '') : anchor.selector,
    ...(pseudoMatch ? { pseudo: pseudoMatch } : {}),
    properties: [...new Set(anchor.styles.flatMap((styles) => Object.keys(styles)))].slice(0, 24),
    geometry: anchor.geometry,
  }
}

async function settleReferenceRender(page: Page): Promise<void> {
  // Playwright's out-of-page timer also works in the CSP-locked reference
  // document and leaves enough time for layout and font fallback to settle.
  await page.waitForTimeout(550)
}

function normalizeReferenceRenderFontOptions(
  options: ReferenceRenderFontOptions | undefined,
): Required<ReferenceRenderFontOptions> | undefined {
  const hasCss = options?.fontCss !== undefined
  const hasFamilies = options?.expectedFontFamilies !== undefined
  if (!hasCss && !hasFamilies) return undefined
  if (!hasCss || !hasFamilies) {
    throw new Error('Trusted reference fonts require both fontCss and expectedFontFamilies')
  }
  const fontCss = options.fontCss ?? ''
  if (!fontCss.trim()) throw new Error('Trusted reference fontCss must not be empty')
  if (Buffer.byteLength(fontCss, 'utf8') > REFERENCE_RENDER_FONT_CSS_MAX_BYTES) {
    throw new Error('Trusted reference fontCss exceeds the 16 MiB limit')
  }
  const expectedFontFamilies = [...new Set((options.expectedFontFamilies ?? []).map((family) => family.trim()))]
  if (expectedFontFamilies.length === 0 || expectedFontFamilies.length > REFERENCE_FONT_MAX_FILES) {
    throw new Error(`Trusted reference expectedFontFamilies must contain between 1 and ${REFERENCE_FONT_MAX_FILES} families`)
  }
  for (const family of expectedFontFamilies) {
    if (!family || family.length > 128 || /[\u0000-\u001f\u007f]/u.test(family)) {
      throw new Error('Trusted reference expectedFontFamilies contains an invalid family name')
    }
  }
  return { fontCss, expectedFontFamilies }
}

async function installAndAwaitReferenceFonts(
  page: Page,
  options: ReferenceRenderFontOptions | undefined,
): Promise<void> {
  const normalized = normalizeReferenceRenderFontOptions(options)
  if (!normalized) return
  const result = await page.evaluate(INSTALL_AND_AWAIT_REFERENCE_FONTS_PAGE_FUNCTION, {
    fontCss: normalized.fontCss,
    expectedFontFamilies: [...normalized.expectedFontFamilies],
    timeoutMs: 8_000,
  })
  if (!result.ok) {
    const missing = result.missingFamilies.length > 0 ? `; missing: ${result.missingFamilies.join(', ')}` : ''
    throw new Error(`Trusted reference fonts failed to load${missing}${result.error ? `; ${result.error}` : ''}`)
  }
}

async function captureReferenceViewportScreenshot(
  page: Page,
  viewport: { width: number; height: number },
  phase: ReferenceRenderPhase,
): Promise<Buffer> {
  const actualViewport = page.viewportSize()
  if (!renderedViewportsEqual(actualViewport, viewport)) {
    throw new Error(`Reference ${phase} screenshot viewport expected ${viewport.width}x${viewport.height} but found ${actualViewport?.width ?? 0}x${actualViewport?.height ?? 0}`)
  }
  const screenshot = await page.screenshot({ fullPage: false, type: 'png' })
  const isPng = screenshot.length >= 24 && screenshot.subarray(1, 4).toString('ascii') === 'PNG'
  const width = isPng ? screenshot.readUInt32BE(16) : 0
  const height = isPng ? screenshot.readUInt32BE(20) : 0
  if (!isPng || width !== viewport.width || height !== viewport.height) {
    throw new Error(`Reference ${phase} screenshot was not a ${viewport.width}x${viewport.height} viewport PNG`)
  }
  return screenshot
}

async function captureReferencePhase(
  page: Page,
  specs: ReferenceRenderSelectorSpec[],
  phase: ReferenceRenderPhase,
  typographyProbes?: readonly RenderedReferenceTypographyProbe[],
  typographyExistingOnly = false,
): Promise<RenderedReferencePhaseProfile> {
  const selectors = typographyProbes?.map((probe) => probe.selector) ?? REFERENCE_TYPOGRAPHY_SELECTORS[phase]
  const propertiesBySelector = new Map(typographyProbes?.map((probe) => [probe.selector, Object.keys(probe.styles)]))
  const typographySpecs = selectors.map((selector) => ({
    selector,
    properties: propertiesBySelector.get(selector) ?? [...REFERENCE_TYPOGRAPHY_PROPERTIES],
    ...(typographyExistingOnly ? { existingOnly: true } : {}),
  }))
  return await page.evaluate(REFERENCE_RENDER_SNAPSHOT_PAGE_FUNCTION, { specs, typographySpecs })
}

async function verifyRenderedReferenceStyleInSession(
  session: BrowserSession,
  profile: RenderedReferenceStyleProfile,
  phase: ReferenceRenderPhase,
  captureScreenshot = false,
  fontOptions?: ReferenceRenderFontOptions,
): Promise<{
  verification: BrowserRenderedReferenceStyleVerification
  screenshot?: Buffer
}> {
  const page = session.page
  const interiorVariants = phase === 'content' ? profile.interiorVariants ?? [] : []
  const startingState = phase === 'content'
    ? await page.evaluate(REFERENCE_RENDER_PAGE_STATE_PAGE_FUNCTION)
    : undefined
  const currentLayout = startingState
    ? await page.evaluate(REFERENCE_INTERIOR_LAYOUT_PAGE_FUNCTION, startingState.activeIndex)
    : undefined
  const currentVariant = interiorVariants.find((variant) => currentLayout?.layoutSelectors.includes(variant.layoutSelector))
  const expected = currentVariant?.profile ?? profile.phases[phase]
  const specs = expected.anchors.map(referenceRenderSelectorSpecFromAnchor)
  const startingEpoch = session.pageEpoch
  const startingUrl = page.url()
  const startingViewport = page.viewportSize()
  // Deterministic evidence must describe the page, not the residue of the
  // previous automation gesture. In particular, Playwright leaves the mouse
  // over a clicked navigation button and the reference template intentionally
  // inverts that button under :hover. Move to a neutral corner and clear focus
  // before freezing transitions so candidate and reference are sampled in the
  // same resting interaction state.
  await page.mouse.move(0, 0)
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await installAndAwaitReferenceFonts(page, fontOptions)
  // Apply the same reduced-motion/frozen-cascade policy used while profiling
  // the reference. Legitimate template transitions therefore cannot create a
  // false, permanently unstable mismatch in the candidate lane.
  await page.addStyleTag({ content: REFERENCE_RENDER_FREEZE_CSS })
  await settleReferenceRender(page)
  const first = await captureReferencePhase(page, specs, phase, expected.typographyProbes, Boolean(currentVariant))
  await page.waitForTimeout(700)
  const second = await captureReferencePhase(page, specs, phase, expected.typographyProbes, Boolean(currentVariant))

  let screenshot: Buffer | undefined
  let evidenceEpoch = session.pageEpoch
  let evidenceUrl = page.url()
  let evidenceViewport = page.viewportSize()
  let third: RenderedReferencePhaseProfile | undefined
  if (captureScreenshot) {
    screenshot = await page.screenshot({ fullPage: false, type: 'png' })
    evidenceEpoch = session.pageEpoch
    evidenceUrl = page.url()
    evidenceViewport = page.viewportSize()
    // Deliberately keep a short post-capture observation window. A candidate
    // must not pass by showing the expected state only for the screenshot.
    await page.waitForTimeout(300)
    third = await captureReferencePhase(page, specs, phase, expected.typographyProbes, Boolean(currentVariant))
  }

  const verification = compareRenderedReferencePhase(
    phase,
    profile.viewport,
    evidenceViewport,
    evidenceUrl,
    evidenceEpoch,
    expected,
    second,
    { allowMissingTypography: Boolean(currentVariant) },
  )
  if (!renderedPhaseSnapshotsEqual(first, second)) {
    addRenderedReferenceViolation(
      verification,
      `render ${phase} remained unstable across the verification window`,
    )
  }
  if (third && !renderedPhaseSnapshotsEqual(second, third)) {
    addRenderedReferenceViolation(
      verification,
      `render ${phase} changed after screenshot capture`,
    )
  }
  if (phase === 'content' && startingState) {
    const interior = await verifyAllInteriorReferenceVariants(
      session,
      profile,
      startingState,
      startingUrl,
      startingViewport,
      startingEpoch,
    )
    verification.interiorAttestation = interior.attestation
    verification.checked += interior.checked
    verification.matched += interior.matched
    for (const violation of interior.violations) {
      if (verification.violations.length < 64) verification.violations.push(violation)
    }
    verification.score = verification.checked > 0
      ? Math.round((verification.matched / verification.checked) * 1_000) / 10
      : 0
    if (interior.violations.length > 0) verification.fidelity = 'mismatch'
  }
  const finalViewport = page.viewportSize()
  if (
    session.pageEpoch !== startingEpoch
    || session.pageEpoch !== evidenceEpoch
    || page.url() !== startingUrl
    || page.url() !== evidenceUrl
    || !renderedViewportsEqual(startingViewport, evidenceViewport)
    || !renderedViewportsEqual(evidenceViewport, finalViewport)
  ) {
    addRenderedReferenceViolation(
      verification,
      `render ${phase} page identity changed during verification`,
    )
  }
  return { verification, ...(screenshot ? { screenshot } : {}) }
}

async function verifyAllInteriorReferenceVariants(
  session: BrowserSession,
  profile: RenderedReferenceStyleProfile,
  startingState: ReferenceRenderPageState,
  startingUrl: string,
  startingViewport: { width: number; height: number } | null,
  startingEpoch: number,
): Promise<{
  attestation: RenderedReferenceInteriorAttestation
  checked: number
  matched: number
  violations: string[]
}> {
  const page = session.page
  const variants = profile.interiorVariants ?? []
  const candidateSlides = Math.max(0, startingState.slides.length - 2)
  const slides: RenderedReferenceInteriorAttestation['slides'] = []
  const violations: string[] = []
  let checked = 0
  let matched = 0
  let matchedSlides = 0
  if (candidateSlides > 32) {
    return {
      attestation: {
        candidateSlides,
        matchedSlides: 0,
        referenceVariants: variants.length,
        slides: [],
      },
      checked: 1,
      matched: 0,
      violations: [`content deck has ${candidateSlides} interior slides; deterministic all-interior verification is bounded to 32`],
    }
  }

  let restorationFailed = false
  try {
    for (let slideIndex = 1; slideIndex < startingState.slides.length - 1; slideIndex += 1) {
      await page.evaluate(SET_REFERENCE_RENDER_PHASE_PAGE_FUNCTION, slideIndex)
      await settleReferenceRender(page)
      const layout = await page.evaluate(REFERENCE_INTERIOR_LAYOUT_PAGE_FUNCTION, slideIndex)
      const layoutSelector = layout.layoutSelectors[0]
      // Historical render profiles predate layout libraries. Keep them safe by
      // enumerating every interior page against the legacy content fingerprint
      // instead of falling back to the former "only page 2" behavior.
      const candidates: RenderedReferenceLayoutVariantProfile[] = variants.length > 0
        ? variants.filter((variant) => layout.layoutSelectors.includes(variant.layoutSelector))
        : [{ layoutSelector: layoutSelector ?? '.slide', profile: profile.phases.content }]
      if (candidates.length === 0) {
        checked += 1
        slides.push({ slideIndex, ...(layoutSelector ? { layoutSelector } : {}), fidelity: 'mismatch', score: 0 })
        if (violations.length < 64) {
          violations.push(layoutSelector
            ? `content slide ${slideIndex + 1} uses ${layoutSelector}, which is not a real reference layout variant`
            : `content slide ${slideIndex + 1} has no real reference .layout-* variant class`)
        }
        continue
      }

      let best: BrowserRenderedReferenceStyleVerification | undefined
      let bestVariant: RenderedReferenceLayoutVariantProfile | undefined
      for (const variant of candidates) {
        const specs = variant.profile.anchors.map(referenceRenderSelectorSpecFromAnchor)
        const first = await captureReferencePhase(page, specs, 'content', variant.profile.typographyProbes, variants.length > 0)
        // Use the same delayed-mutation observation window as the atomic
        // representative content screenshot. Later candidate pages must not
        // get a weaker stability policy merely because they are attested in
        // the internal all-interior pass.
        await page.waitForTimeout(700)
        const second = await captureReferencePhase(page, specs, 'content', variant.profile.typographyProbes, variants.length > 0)
        const verification = compareRenderedReferencePhase(
          'content',
          profile.viewport,
          page.viewportSize(),
          page.url(),
          session.pageEpoch,
          variant.profile,
          second,
          { allowMissingTypography: true },
        )
        if (!renderedPhaseSnapshotsEqual(first, second)) {
          addRenderedReferenceViolation(
            verification,
            `content slide ${slideIndex + 1} (${variant.layoutSelector}) remained unstable across the verification window`,
          )
        }
        if (!best || verification.score > best.score) {
          best = verification
          bestVariant = variant
        }
        if (verification.fidelity === 'pass') break
      }

      if (!best || !bestVariant) {
        checked += 1
        slides.push({ slideIndex, layoutSelector, fidelity: 'mismatch', score: 0 })
        if (violations.length < 64) violations.push(`content slide ${slideIndex + 1} could not be compared with its reference layout variant`)
        continue
      }
      checked += best.checked
      matched += best.matched
      const passed = best.fidelity === 'pass'
      if (passed) matchedSlides += 1
      slides.push({
        slideIndex,
        layoutSelector,
        ...(passed ? { matchedVariant: bestVariant.layoutSelector } : {}),
        fidelity: passed ? 'pass' : 'mismatch',
        score: best.score,
      })
      if (!passed) {
        const details = best.violations.slice(0, 3)
        if (details.length === 0 && violations.length < 64) {
          violations.push(`content slide ${slideIndex + 1} does not match ${bestVariant.layoutSelector}`)
        }
        for (const detail of details) {
          if (violations.length < 64) violations.push(`content slide ${slideIndex + 1} (${bestVariant.layoutSelector}): ${detail}`)
        }
      }
      if (
        session.pageEpoch !== startingEpoch
        || page.url() !== startingUrl
        || !renderedViewportsEqual(page.viewportSize(), startingViewport)
      ) {
        if (violations.length < 64) violations.push(`content slide ${slideIndex + 1} page identity changed during all-interior verification`)
      }
    }
  } finally {
    const restored = await page.evaluate(RESTORE_REFERENCE_RENDER_PAGE_STATE_PAGE_FUNCTION, startingState).catch(() => false)
    // Observe the restored state for the same delayed-mutation window. A page
    // cannot pass by scheduling a re-skin from the verifier's own activation
    // mutations and applying it immediately after restoration.
    await page.waitForTimeout(700)
    const restoredState = restored
      ? await page.evaluate(REFERENCE_RENDER_PAGE_STATE_PAGE_FUNCTION).catch(() => undefined)
      : undefined
    restorationFailed = !restored || JSON.stringify(restoredState) !== JSON.stringify(startingState)
  }

  if (restorationFailed) {
    checked += 1
    if (violations.length < 64) violations.push('content all-interior verification could not restore the original rendered slide state')
  } else {
    checked += 1
    matched += 1
  }
  if (session.pageEpoch !== startingEpoch || page.url() !== startingUrl || !renderedViewportsEqual(page.viewportSize(), startingViewport)) {
    checked += 1
    if (violations.length < 64) violations.push('content page identity changed during all-interior verification')
  } else {
    checked += 1
    matched += 1
  }
  return {
    attestation: {
      candidateSlides,
      matchedSlides,
      referenceVariants: variants.length,
      slides,
    },
    checked,
    matched,
    violations,
  }
}

function compareRenderedReferencePhase(
  phase: ReferenceRenderPhase,
  expectedViewport: { width: number; height: number },
  actualViewport: { width: number; height: number } | null,
  url: string,
  pageEpoch: number,
  expectedPhase: RenderedReferencePhaseProfile,
  actualPhase: RenderedReferencePhaseProfile,
  options: { allowMissingTypography?: boolean } = {},
): BrowserRenderedReferenceStyleVerification {
  const expectedAnchors = expectedPhase.anchors
  const actualAnchors = actualPhase.anchors
  const actualBySelector = new Map(actualAnchors.map((anchor) => [anchor.selector, anchor]))
  const violations: string[] = []
  let checked = 0
  let matched = 0
  const check = (passes: boolean, violation: string) => {
    checked += 1
    if (passes) matched += 1
    else if (violations.length < 64) violations.push(violation)
  }
  check(
    actualViewport?.width === expectedViewport.width && actualViewport?.height === expectedViewport.height,
    `render viewport expected ${expectedViewport.width}x${expectedViewport.height} but found ${actualViewport?.width ?? 0}x${actualViewport?.height ?? 0}`,
  )
  for (const expected of expectedAnchors) {
    const actual = actualBySelector.get(expected.selector)
    check(Boolean(actual), `render ${phase} is missing visible anchor ${expected.selector}`)
    if (!actual) continue
    check(actual.count === expected.count, `render ${phase} ${expected.selector} count expected ${expected.count} but found ${actual.count}`)
    const samples = Math.min(expected.rects.length, actual.rects.length)
    const variableProgressFill = phase !== 'closing' && /(?:^|[-_.#])progress(?:$|[-_.:# ])/iu.test(expected.selector)
    const intrinsicContentHeader = /(?:^|[-_.#])slide-header(?:$|[-_.:# ])/iu.test(expected.selector)
    const intrinsicContentBlock = phase === 'content' && expected.geometry === 'intrinsic-block'
    // Counter totals and localized keyboard hints are task content, not
    // reference geometry. Their CSS anchoring must remain exact, but their
    // intrinsic text width/height may legitimately change (for example
    // `1 / 10` -> `1 / 6`, or an English hint -> Chinese). Compare the fixed
    // edge/center that the template controls instead of the text box itself.
    const intrinsicTextChrome = /(?:^|[-_.#])(?:slide-counter|keyboard-hint)(?:$|[-_.:# ])/iu.test(expected.selector)
    const centeredIntrinsicTextChrome = /(?:^|[-_.#])keyboard-hint(?:$|[-_.:# ])/iu.test(expected.selector)
    for (let index = 0; index < samples; index += 1) {
      const expectedRect = expected.rects[index]
      const actualRect = actual.rects[index]
      const widthTolerance = Math.max(2 / expectedViewport.width, expectedRect.width * 0.05)
      const heightTolerance = intrinsicContentHeader
        ? Math.max(4 / expectedViewport.height, expectedRect.height * 0.15)
        : Math.max(2 / expectedViewport.height, expectedRect.height * 0.05)
      check(
        intrinsicTextChrome || (
          (variableProgressFill || Math.abs(actualRect.width - expectedRect.width) <= widthTolerance)
            && (intrinsicContentBlock || Math.abs(actualRect.height - expectedRect.height) <= heightTolerance)
        ),
        `render ${phase} ${expected.selector}[${index}] size expected ${renderedRectSummary(expectedRect)} but found ${renderedRectSummary(actualRect)}`,
      )
      if (expected.geometry === 'strict') {
        const expectedBottom = expectedRect.y + expectedRect.height
        const actualBottom = actualRect.y + actualRect.height
        const expectedCenterX = expectedRect.x + expectedRect.width / 2
        const actualCenterX = actualRect.x + actualRect.width / 2
        const anchoredIntrinsicPosition = intrinsicTextChrome
          && Math.abs(actualBottom - expectedBottom) <= Math.max(4 / expectedViewport.height, 0.01)
          && (
            centeredIntrinsicTextChrome
              ? Math.abs(actualCenterX - expectedCenterX) <= Math.max(4 / expectedViewport.width, 0.01)
              : Math.abs(actualRect.x - expectedRect.x) <= Math.max(4 / expectedViewport.width, 0.01)
          )
        check(
          anchoredIntrinsicPosition || (
            !intrinsicTextChrome
            && Math.abs(actualRect.x - expectedRect.x) <= Math.max(4 / expectedViewport.width, 0.01)
            && Math.abs(actualRect.y - expectedRect.y) <= Math.max(4 / expectedViewport.height, 0.01)
          ),
          `render ${phase} ${expected.selector}[${index}] position expected ${renderedRectSummary(expectedRect)} but found ${renderedRectSummary(actualRect)}`,
        )
      } else if (intrinsicContentBlock) {
        check(
          Math.abs(actualRect.x - expectedRect.x) <= Math.max(4 / expectedViewport.width, 0.01),
          `render ${phase} ${expected.selector}[${index}] horizontal position expected ${renderedRectSummary(expectedRect)} but found ${renderedRectSummary(actualRect)}`,
        )
      }
      const expectedStyles = expected.styles[index] ?? {}
      const actualStyles = actual.styles[index] ?? {}
      for (const [property, expectedValue] of Object.entries(expectedStyles)) {
        if (variableProgressFill && property === 'width') continue
        if (intrinsicContentBlock && ['height', 'min-height', 'max-height', 'grid-template-rows'].includes(property)) continue
        // `translateX(-50%)` is serialized by computed style as a pixel
        // matrix derived from the element's intrinsic text width. Static
        // source verification already proves the declaration is unchanged;
        // the center/bottom anchor check above proves the rendered effect.
        if (intrinsicTextChrome && property === 'transform') continue
        const actualValue = actualStyles[property]
        // Chromium serializes a zero-width `border: none` with currentColor.
        // Its trailing color cannot paint and may legitimately differ when
        // content switches a semantic positive/negative class.
        const nonPaintingBorder = property === 'border'
          && /^0px none\b/u.test(expectedValue)
          && /^0px none\b/u.test(actualValue ?? '')
        const passes = nonPaintingBorder || (property === 'opacity'
          ? Math.abs(Number(actualValue) - Number(expectedValue)) <= 0.02
          : actualValue === expectedValue)
        check(passes, `render ${phase} ${expected.selector}[${index}] ${property} expected "${expectedValue}" but found "${actualValue ?? 'missing'}"`)
      }
      const expectedOcclusion = expected.occlusion[index] ?? 0
      const actualOcclusion = actual.occlusion[index] ?? 0
      if (expectedOcclusion >= 0.4) {
        check(
          actualOcclusion >= Math.max(0.2, expectedOcclusion - 0.25),
          `render ${phase} ${expected.selector}[${index}] is occluded (${actualOcclusion.toFixed(2)}; reference ${expectedOcclusion.toFixed(2)})`,
        )
      }
    }
  }
  const actualTypographyBySelector = new Map(
    (actualPhase.typographyProbes ?? []).map((probe) => [probe.selector, probe]),
  )
  for (const expected of expectedPhase.typographyProbes ?? []) {
    const actual = actualTypographyBySelector.get(expected.selector)
    if (!actual && options.allowMissingTypography) continue
    check(Boolean(actual), `render ${phase} is missing typography probe ${expected.selector}`)
    if (!actual) continue
    for (const [property, expectedValue] of Object.entries(expected.styles)) {
      const actualValue = actual.styles[property]
      check(
        actualValue === expectedValue,
        `render ${phase} typography ${expected.selector} ${property} expected "${expectedValue}" but found "${actualValue ?? 'missing'}"`,
      )
    }
  }
  check(
    actualPhase.overlayProbes.length === expectedPhase.overlayProbes.length,
    `render ${phase} viewport-covering painted surfaces expected ${expectedPhase.overlayProbes.length} but found ${actualPhase.overlayProbes.length}`,
  )
  const overlaySamples = Math.min(expectedPhase.overlayProbes.length, actualPhase.overlayProbes.length)
  for (let index = 0; index < overlaySamples; index += 1) {
    const expected = expectedPhase.overlayProbes[index]
    const actual = actualPhase.overlayProbes[index]
    check(actual.tag === expected.tag, `render ${phase} painted surface[${index}] tag expected ${expected.tag} but found ${actual.tag}`)
    check(Math.abs(actual.coverage - expected.coverage) <= 0.02, `render ${phase} painted surface[${index}] coverage expected ${expected.coverage} but found ${actual.coverage}`)
    for (const property of ['position', 'backgroundColor', 'backgroundImage', 'opacity', 'zIndex'] as const) {
      check(actual[property] === expected[property], `render ${phase} painted surface[${index}] ${property} expected "${expected[property]}" but found "${actual[property]}"`)
    }
  }
  const score = checked > 0 ? Math.round((matched / checked) * 1_000) / 10 : 0
  return {
    fidelity: violations.length === 0 ? 'pass' : 'mismatch',
    phase,
    checked,
    matched,
    score,
    violations,
    url,
    viewport: actualViewport,
    pageEpoch,
  }
}

function addRenderedReferenceViolation(
  verification: BrowserRenderedReferenceStyleVerification,
  violation: string,
): void {
  verification.checked += 1
  verification.score = Math.round((verification.matched / verification.checked) * 1_000) / 10
  verification.fidelity = 'mismatch'
  if (verification.violations.length < 64) verification.violations.push(violation)
}

function renderedViewportsEqual(
  left: { width: number; height: number } | null,
  right: { width: number; height: number } | null,
): boolean {
  return left?.width === right?.width && left?.height === right?.height
}

function renderedPhaseSnapshotsEqual(
  first: RenderedReferencePhaseProfile,
  second: RenderedReferencePhaseProfile,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}

function renderedRectSummary(rect: { x: number; y: number; width: number; height: number }): string {
  return `[${rect.x.toFixed(4)},${rect.y.toFixed(4)},${rect.width.toFixed(4)},${rect.height.toFixed(4)}]`
}

function previewOrigin(rawUrl: string): string {
  const url = new URL(rawUrl)
  if (url.protocol === 'data:') return 'data:'
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser preview only supports local HTTP(S) or data URLs')
  if (url.username || url.password) throw new Error('Browser preview URLs cannot contain credentials')
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
    throw new Error('Browser preview must use a local loopback URL')
  }
  return url.origin
}

function browserRequestAllowed(rawUrl: string, allowedOrigin: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (['data:', 'blob:', 'about:'].includes(url.protocol)) return true
  if (!allowedOrigin || allowedOrigin === 'data:') return false
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin === allowedOrigin
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    const origin = new URL(allowedOrigin)
    const expectedProtocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.protocol === expectedProtocol && url.hostname === origin.hostname && effectivePort(url) === effectivePort(origin)
  }
  return false
}

function effectivePort(url: URL): string {
  if (url.port) return url.port
  return url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80'
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('Browser action aborted', 'AbortError')
}
