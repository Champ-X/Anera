import { createHash } from 'node:crypto'
import { ToolCapabilityUnavailableError } from './tool-recovery.js'
import type { Browser, BrowserContext, ConsoleMessage, Page } from 'playwright-core'
import { chromium } from 'playwright-core'
import { findBrowserExecutable } from './browser-executable.js'
import { config } from './config.js'
import { REFERENCE_FONT_MAX_FILES, REFERENCE_RENDER_FONT_CSS_MAX_BYTES } from './reference-fonts.js'
import { assertReferenceTemplateDependency, REFERENCE_TEMPLATE_MAX_DEPENDENCIES, type ReferenceTemplateDependency, type ReferenceTemplateTextParent } from './reference-template.js'
import { normalizeReferenceLanguageVariant, REFERENCE_LANGUAGE_ROLES, type ReferenceLanguageVariant } from './reference-language.js'
import { RENDERED_TEXT_LAYOUT_SCRIPT, renderedTextLayoutFindings } from './rendered-text-layout.js'
import { PRESENTATION_ACTIVE_STATE_SCRIPT, compactPresentationViewport, presentationActiveState, presentationStageViolations, type PresentationStateSnapshot } from './presentation-state.js'
import { RENDERED_CONTROL_OCCLUSION_SCRIPT, type RenderedControlOcclusion } from './rendered-control-occlusion.js'
import {
  normalizeRenderedReferenceStyleProfile,
  renderedReferenceRuntimeManagedSlideSelectors,
  type ReferenceRenderGeometryPolicy,
  type ReferenceRenderPhase,
  type ReferenceStyleSourceProfile,
  type RenderedReferenceAnchorProfile,
  type RenderedReferenceContainingBlockOffsetProfile,
  type RenderedReferenceInteriorAttestation,
  type RenderedReferenceLayoutVariantProfile,
  type RenderedReferencePhaseProfile,
  type RenderedReferenceStyleProfile,
  type RenderedReferenceStyleVerification,
  type RenderedReferenceSurfaceAttestation,
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
  languageVariant?: ReferenceLanguageVariant
}

export interface CaptureReferenceRenderBundleOptions extends ReferenceRenderFontOptions {
  signal?: AbortSignal
  /** Private, source-declared snapshots; executed only in a fresh network-denied context. */
  runtimeScripts?: readonly ReferenceTemplateDependency[]
  /** Source-derived text-parent paths, used only by documented language adapters. */
  textParents?: readonly ReferenceTemplateTextParent[]
}

export interface ReferenceRenderCaptureBundle {
  profile: RenderedReferenceStyleProfile
  screenshots: Record<ReferenceRenderPhase, Buffer>
  textFontFamilies?: string[]
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
      // aria-hidden/inert affect accessibility and interaction, not paint.
      if (current.hasAttribute('hidden')) return false
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

// Exact references are not required to use Anera's generated `.slide` class.
// Several real templates use a custom <deck-stage> whose direct <section>
// children are the slide roots. Keep discovery deliberately bounded and
// structural: explicit slide semantics win, then labelled sibling roots, then
// direct section/article children of a custom element. Ordinary main>section
// documents remain ineligible, so a generic page cannot masquerade as a deck.
const REFERENCE_SLIDE_ELEMENTS_SCRIPT = String.raw`() => {
  const bounded = (values) => values.length >= 3 ? values.slice(0, 64) : undefined
  const explicit = bounded([...document.querySelectorAll(
    '.slide,[role="tabpanel"],[aria-roledescription="slide"]'
  )])
  if (explicit) return explicit

  const labelled = [...document.querySelectorAll('[data-screen-label],[data-slide]')].slice(0, 256)
  const labelledParents = [...new Set(labelled.map((element) => element.parentElement).filter(Boolean))].slice(0, 32)
  for (const parent of labelledParents) {
    const siblings = bounded([...parent.children].filter((element) => (
      element.matches('[data-screen-label],[data-slide]')
    )))
    if (siblings) return siblings
  }

  const customRoots = [...document.querySelectorAll('body *')]
    .filter((element) => element.localName.includes('-'))
    .slice(0, 32)
  for (const root of customRoots) {
    const children = bounded([...root.children].filter((element) => element.matches('section,article')))
    if (children) return children
  }
  return []
}`

const PRESENTATION_STATE_SNAPSHOT_SCRIPT = String.raw`() => {
  const candidates = (${REFERENCE_SLIDE_ELEMENTS_SCRIPT})()
  return candidates.map((element, index) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const opacity = Number.parseFloat(style.opacity)
    const rendered = style.display !== 'none'
      && !['hidden', 'collapse'].includes(style.visibility)
      && (!Number.isFinite(opacity) || opacity > 0.01)
      && !element.hasAttribute('hidden')
      && element.getAttribute('aria-hidden') !== 'true'
      && !element.hasAttribute('inert')
    const intersectsViewport = rendered
      && rect.width > 0.5
      && rect.height > 0.5
      && rect.right > 0
      && rect.bottom > 0
      && rect.left < innerWidth
      && rect.top < innerHeight
    return {
      index,
      className: element.getAttribute('class') || '',
      deckActive: element.hasAttribute('data-deck-active'),
      ariaHidden: element.getAttribute('aria-hidden'),
      hidden: element.hasAttribute('hidden'),
      inert: element.hasAttribute('inert'),
      display: style.display,
      position: style.position,
      visibility: style.visibility,
      opacity: style.opacity,
      intersectsViewport,
      rect: [
        Math.round(rect.x * 10) / 10,
        Math.round(rect.y * 10) / 10,
        Math.round(rect.width * 10) / 10,
        Math.round(rect.height * 10) / 10,
      ],
    }
  })
}`

const REFERENCE_RENDER_SNAPSHOT_SCRIPT = String.raw`(payload) => {
  const specs = payload.specs || []
  const typographySpecs = payload.typographySpecs || []
  const rendered = (element) => {
    for (let current = element; current; current = current.parentElement) {
      // Phase-inactive slides are hidden by the injected
      // data-anera-reference-phase-hidden rule. aria-hidden/inert decorations
      // still paint and therefore belong in visual reference evidence.
      if (current.hasAttribute('hidden')) return false
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
      const hostStyle = getComputedStyle(element)
      const style = getComputedStyle(element, spec.pseudo || null)
      const styles = {}
      for (const property of spec.properties) {
        const authored = spec.authoredBox && ['top','right','bottom','left','width','height','grid-template-columns'].includes(property)
          ? element.computedStyleMap?.().get(property) : undefined
        if (spec.authoredBox && ['top','right','bottom','left','width','height'].includes(property) && authored === undefined) throw new Error('Source-authored box evidence requires CSS Typed OM');
        const value = String(authored ?? style.getPropertyValue(property)).replace(/\s+/g, ' ').trim().toLowerCase()
        if (value) styles[property] = value.slice(0, 240)
      }
      return {
        rect: {
          x: rounded(rect.x / innerWidth),
          y: rounded(rect.y / innerHeight),
          width: rounded(rect.width / innerWidth),
          height: rounded(rect.height / innerHeight),
        },
        containingBlockOffset: (() => {
          if (spec.pseudo || !['absolute', 'fixed', 'sticky'].includes(hostStyle.position)) return null
          const offsetParent = element.offsetParent
          const containingRect = hostStyle.position === 'fixed' || !offsetParent
            ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
            : offsetParent.getBoundingClientRect()
          return {
            left: rounded((rect.left - containingRect.left) / innerWidth),
            top: rounded((rect.top - containingRect.top) / innerHeight),
            right: rounded((containingRect.right - rect.right) / innerWidth),
            bottom: rounded((containingRect.bottom - rect.bottom) / innerHeight),
          }
        })(),
        styles,
        occlusion: Math.round(occlusionRatio(element, rect) * 100) / 100,
        position: hostStyle.position,
        inlineFlowIntrinsic: (() => {
          const parentStyle = element.parentElement ? getComputedStyle(element.parentElement) : null
          return Boolean(
            parentStyle
            && parentStyle.display === 'flex'
            && !String(parentStyle.flexDirection || 'row').startsWith('column')
            && ['space-between', 'space-around', 'space-evenly'].includes(parentStyle.justifyContent)
            && style.flexBasis === 'auto'
            && style.maxWidth === 'none'
          )
        })(),
      }
    })
    const layoutRoot = /^\s*\.layout-[a-z0-9-]+(?:\:[-\w()]+)?\s*$/i.test(spec.selector)
    const strictGeometry = layoutRoot
      || /(?:^|[-_.#])(?:slide(?:\.active)?|slide-header|decoration|dots?|nav-controls|progress|counter|keyboard|hint)(?:$|[-_.:# ])/i.test(spec.selector)
      || samples.some((sample) => sample.position === 'fixed' || sample.position === 'absolute')
    const widths = samples.map((sample) => sample.rect.width)
    const maximumWidth = widths.length > 0 ? Math.max(...widths) : 0
    const heterogeneousIntrinsicInline = samples.length > 1
      && samples.every((sample) => sample.inlineFlowIntrinsic)
      && maximumWidth - Math.min(...widths) > Math.max(2 / innerWidth, maximumWidth * 0.05)
    anchors.push({
      selector: spec.selector,
      count: visible.length,
      geometry: spec.geometry || (heterogeneousIntrinsicInline ? 'intrinsic-size' : strictGeometry ? 'strict' : 'size'),
      ...(spec.authoredBox ? { authoredBox: true } : {}),
      rects: samples.map((sample) => sample.rect),
      ...(samples.some((sample) => sample.containingBlockOffset !== null)
        ? { containingBlockOffsets: samples.map((sample) => sample.containingBlockOffset) }
        : {}),
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
  const presentationSlides = (${REFERENCE_SLIDE_ELEMENTS_SCRIPT})()
  const activeState = (${PRESENTATION_ACTIVE_STATE_SCRIPT})((${PRESENTATION_STATE_SNAPSHOT_SCRIPT})())
  const activeSlide = presentationSlides[activeState.indices[0]] || document.body
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
  const textLayout = (${RENDERED_TEXT_LAYOUT_SCRIPT})(activeSlide)
  return { anchors, overlayProbes, typographyProbes, textLayout }
}`

const SET_REFERENCE_RENDER_PHASE_SCRIPT = String.raw`(phase) => {
  const slides = (${REFERENCE_SLIDE_ELEMENTS_SCRIPT})()
  if (slides.length === 0) return
  const requestedIndex = typeof phase === 'number' ? phase : Number.NaN
  const index = Number.isInteger(requestedIndex)
    ? Math.max(0, Math.min(slides.length - 1, requestedIndex))
    : phase === 'cover' ? 0 : phase === 'closing' ? slides.length - 1 : Math.min(1, slides.length - 1)
  const nativeActive = slides.some((slide) => slide.hasAttribute('data-deck-active'))
  slides.forEach((slide, slideIndex) => {
    if (nativeActive) slide.toggleAttribute('data-deck-active', slideIndex === index)
    slide.classList.toggle('active', slideIndex === index)
    slide.classList.toggle('prev', slideIndex < index)
    slide.setAttribute('aria-hidden', slideIndex === index ? 'false' : 'true')
    slide.toggleAttribute('data-anera-reference-phase-hidden', slideIndex !== index)
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
    phaseHidden: element.getAttribute('data-anera-reference-phase-hidden'),
    deckActive: element.getAttribute('data-deck-active'),
  })
  const textNodes = (element) => {
    const values = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) values.push(String(walker.currentNode.nodeValue || ''))
    return values
  }
  const slides = (${REFERENCE_SLIDE_ELEMENTS_SCRIPT})()
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
    activeIndex: (${PRESENTATION_ACTIVE_STATE_SCRIPT})((${PRESENTATION_STATE_SNAPSHOT_SCRIPT})()).indices[0] ?? -1,
  }
}`

const RESTORE_REFERENCE_RENDER_PAGE_STATE_SCRIPT = String.raw`(state) => {
  const restoreAttributes = (element, snapshot) => {
    for (const [name, value] of [
      ['class', snapshot.class],
      ['style', snapshot.style],
      ['aria-hidden', snapshot.ariaHidden],
      ['data-anera-reference-phase-hidden', snapshot.phaseHidden],
      ['data-deck-active', snapshot.deckActive],
    ]) {
      if (value === null || value === undefined) element.removeAttribute(name)
      else element.setAttribute(name, value)
    }
    element.toggleAttribute('hidden', snapshot.hidden === true)
    element.toggleAttribute('inert', snapshot.inert === true)
  }
  const restoreElements = (elements, snapshots, restoreExtra) => {
    if (elements.length !== snapshots.length) return false
    let extrasRestored = true
    elements.forEach((element, index) => {
      restoreAttributes(element, snapshots[index])
      if (restoreExtra && restoreExtra(element, snapshots[index]) === false) extrasRestored = false
    })
    return extrasRestored
  }
  const restoreList = (selector, snapshots, restoreExtra) => (
    restoreElements([...document.querySelectorAll(selector)], snapshots, restoreExtra)
  )
  const restoreTextNodes = (element, values) => {
    const nodes = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) nodes.push(walker.currentNode)
    if (nodes.length !== values.length) return false
    nodes.forEach((node, index) => { node.nodeValue = values[index] })
    return true
  }
  const slidesRestored = restoreElements((${REFERENCE_SLIDE_ELEMENTS_SCRIPT})(), state.slides)
  const progressRestored = restoreList('.progress-bar', state.progress)
  const countersRestored = restoreList('.slide-counter', state.counters, (element, snapshot) => restoreTextNodes(element, snapshot.textNodes))
  const buttonsRestored = restoreList('.nav-btn, .nav-controls button', state.buttons, (element, snapshot) => {
    if (element instanceof HTMLButtonElement && typeof snapshot.disabled === 'boolean') element.disabled = snapshot.disabled
  })
  return slidesRestored && progressRestored && countersRestored && buttonsRestored
}`

const REFERENCE_INTERIOR_LAYOUT_SCRIPT = String.raw`(slideIndex) => {
  const slides = (${REFERENCE_SLIDE_ELEMENTS_SCRIPT})()
  const slide = slides[slideIndex]
  if (!slide) return { layoutSelectors: [], specs: [] }
  const stateClasses = new Set(['slide', 'active', 'prev', 'current', 'visible', 'hidden', 'entering', 'leaving'])
  const classCounts = new Map()
  slides.forEach((candidate) => [...candidate.classList].forEach((className) => {
    classCounts.set(className, (classCounts.get(className) || 0) + 1)
  }))
  const layoutSelectors = [...slide.classList]
    .map((className, order) => ({ className, order, count: classCounts.get(className) || slides.length }))
    .filter(({ className }) => /^[a-z_][a-z0-9_-]{1,80}$/.test(className) && !stateClasses.has(className))
    .sort((left, right) => left.count - right.count || left.order - right.order)
    .map(({ className }) => '.' + className)
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
  // Positioned text boxes are frequently shrink-to-fit and inherit UA
  // margins from the chosen semantic tag. Capture their actual anchors and
  // box-model defaults instead of treating localized text width/height as
  // fixed template geometry. Keep this list bounded to the durable profile's
  // existing 24-property limit.
  const intrinsicTextProperties = [
    'display', 'position', 'visibility', 'opacity', 'transform', 'pointer-events',
    'top', 'right', 'bottom', 'left', 'inset', 'margin',
    'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform',
  ]
  const authoredBoxProperties = [
    'display','position','opacity','transform','top','right','bottom','left',
    'width','height','max-width','max-height','min-width','min-height',
    'flex-direction','align-items','justify-content','gap','row-gap','column-gap',
    'grid-template-columns','overflow','background-color','border',
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
    const authoredHeight = (() => {
      try { return String(element.computedStyleMap?.().get('height') || '').trim().toLowerCase() }
      catch { return '' }
    })()
    const parentStyle = element.parentElement ? getComputedStyle(element.parentElement) : null
    const intrinsicInlineFlowChild = Boolean(
      parentStyle
      && parentStyle.display === 'flex'
      && !String(parentStyle.flexDirection || 'row').startsWith('column')
      && ['space-between', 'space-around', 'space-evenly'].includes(parentStyle.justifyContent)
      && style.flexBasis === 'auto'
      && style.maxWidth === 'none'
    )
    const intrinsicStructuralBlock = structuralDisplay
      && !positioned
      && ['auto', 'min-content', 'max-content', 'fit-content'].includes(authoredHeight)
    const authored = (property) => {
      try { return String(element.computedStyleMap?.().get(property) || '').trim().toLowerCase() }
      catch { return '' }
    }
    const specified = (property) => Boolean(authored(property) && authored(property) !== 'auto')
    const authoredAutoPositionedText = element !== slide && positioned && structuralDisplay && !media
      && String(element.textContent || '').trim().length > 0
      && !element.querySelector('canvas,svg,img,video,picture,iframe')
      && authoredHeight === 'auto' && !(specified('top') && specified('bottom'))
      && ['top','right','bottom','left','width'].every((property) => authored(property))
    const shrinkToFitWidth = authoredAutoPositionedText && authored('width') === 'auto'
      && !(specified('left') && specified('right'))
    const direct = element.parentElement === slide
    if (element !== slide && !media && !structuralDisplay && !positioned && !direct) return []
    const className = [...element.classList].find((value) => /^[a-z][a-z0-9-]{1,80}$/.test(value))
    let selector
    if (element === slide) selector = scope
    else if (className) selector = scope + ' .' + className
    else if (media) selector = scope + ' ' + element.tagName.toLowerCase()
    else return []
    const text = String(element.textContent || '').trim()
    const textLeaf = text.length > 0 && [...element.children].every((child) => (
      String(child.textContent || '').trim().length === 0
    ))
    // Paint does not make an auto-sized text label structural. Kicker chips,
    // pills, badges, and similar reference components commonly carry a
    // background/border while their used width still comes entirely from the
    // copy plus padding. The source-backed geometry policy below overrides
    // this runtime inference when the template authored fixed dimensions.
    const intrinsicPositionedText = positioned && !media && !structuralDisplay && textLeaf
    const area = Math.min(1, Math.max(0, rect.width * rect.height / Math.max(1, innerWidth * innerHeight)))
    const score = element === slide ? 100000
      : media ? 90000
        : positioned ? 70000 + area * 1000
          : structuralDisplay ? 50000 + area * 1000
            : 30000 + area * 1000
    return [{
      selector,
      querySelector: selector,
      properties: authoredAutoPositionedText ? authoredBoxProperties : intrinsicPositionedText ? intrinsicTextProperties : properties,
      ...(authoredAutoPositionedText ? { authoredBox: true } : {}),
      ...(element === slide
        ? { geometry: 'strict' }
        : authoredAutoPositionedText
          ? { geometry: shrinkToFitWidth ? 'intrinsic-size' : 'intrinsic-block' }
        : intrinsicPositionedText
          ? { geometry: 'intrinsic-size' }
          : intrinsicInlineFlowChild
            ? { geometry: 'intrinsic-size' }
          : intrinsicStructuralBlock
            ? { geometry: 'intrinsic-block' }
          : {}),
      score,
      order,
    }]
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

const PRESENTATION_STATE_SNAPSHOT_PAGE_FUNCTION = Function(
  `"use strict"; return (${PRESENTATION_STATE_SNAPSHOT_SCRIPT})`,
)() as () => PresentationStateSnapshot[]
const REFERENCE_RENDER_SNAPSHOT_PAGE_FUNCTION = Function(
  `"use strict"; return (${REFERENCE_RENDER_SNAPSHOT_SCRIPT})`,
)() as (payload: ReferenceRenderSnapshotSpec) => RenderedReferencePhaseProfile
const SET_REFERENCE_RENDER_PHASE_PAGE_FUNCTION = Function(
  `"use strict"; return (${SET_REFERENCE_RENDER_PHASE_SCRIPT})`,
)() as (phase: string | number) => void
const REFERENCE_SLIDE_COUNT_PAGE_FUNCTION = Function(
  `"use strict"; return () => ((${REFERENCE_SLIDE_ELEMENTS_SCRIPT})()).length`,
)() as () => number
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
  authoredBox?: true
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
  phaseHidden: string | null
  deckActive: string | null
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
  [data-anera-reference-phase-hidden] {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
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

const SOURCE_TEXT_FONT_FAMILIES_PAGE_FUNCTION = Function('"use strict"; return (' + String.raw`(parents) => {
  if (parents.length > 10240) throw new Error('Source typography probe exceeds the slot bound');
  const slides = [...document.querySelectorAll('.slide')];
  return parents.map((parent) => {
    let element = slides[Number(parent.variant.slice(1)) - 1];
    for (const index of parent.path) element = element?.children[index];
    if (!element) throw new Error('The native runtime changed a source text-parent path');
    return getComputedStyle(element).fontFamily;
  });
}` + ')')() as (parents: readonly ReferenceTemplateTextParent[]) => string[]

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
    const runtimeScripts = options.runtimeScripts ?? []
    if (runtimeScripts.length > REFERENCE_TEMPLATE_MAX_DEPENDENCIES) throw new Error('Reference runtime script count exceeds the bounded limit')
    for (const script of runtimeScripts) assertReferenceTemplateDependency(script)
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
      await page.setContent(sanitizeReferenceRenderHtml(html, Boolean(trustedFonts), runtimeScripts), { waitUntil: 'domcontentloaded', timeout: 20_000 })
      // HTML scripts, event handlers, frames and remote requests remain
      // stripped/blocked. Only these source-directory-scoped, hash-checked
      // snapshots run; this is never a user browser or an authenticated page.
      for (const script of runtimeScripts) {
        signal?.throwIfAborted()
        await page.addScriptTag({ content: script.content })
      }
      const slideCount = await page.evaluate(REFERENCE_SLIDE_COUNT_PAGE_FUNCTION)
      if (slideCount < 3) {
        throw new Error('Exact rendered reference requires at least three identifiable slide roots for distinct cover, content, and closing phases (.slide, ARIA slide semantics, labelled siblings, or direct section/article children of a custom deck element)')
      }
      await installAndAwaitReferenceFonts(page, trustedFonts)
      const textFontFamilies = options.textParents
        ? await page.evaluate(SOURCE_TEXT_FONT_FAMILIES_PAGE_FUNCTION, options.textParents) : undefined
      await page.addStyleTag({ content: REFERENCE_RENDER_FREEZE_CSS })
      await page.evaluate(SET_REFERENCE_RENDER_PHASE_PAGE_FUNCTION, 'cover')
      await settleReferenceRender(page)
      const coverLayout = await page.evaluate(REFERENCE_INTERIOR_LAYOUT_PAGE_FUNCTION, 0)
      const phases: Record<ReferenceRenderPhase, RenderedReferencePhaseProfile> = {
        cover: await captureReferencePhase(
          page,
          mergeReferenceRenderPhaseSpecs(coverLayout.specs, specs),
          'cover',
        ),
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
      const contentLayout = await page.evaluate(REFERENCE_INTERIOR_LAYOUT_PAGE_FUNCTION, Math.min(1, slideCount - 1))
      phases.content = await captureReferencePhase(
        page,
        mergeReferenceRenderPhaseSpecs(contentLayout.specs, specs),
        'content',
      )
      screenshots.content = await captureReferenceViewportScreenshot(page, viewport, 'content')
      await page.evaluate(SET_REFERENCE_RENDER_PHASE_PAGE_FUNCTION, 'closing')
      await settleReferenceRender(page)
      const closingLayout = await page.evaluate(REFERENCE_INTERIOR_LAYOUT_PAGE_FUNCTION, slideCount - 1)
      phases.closing = await captureReferencePhase(
        page,
        mergeReferenceRenderPhaseSpecs(closingLayout.specs, specs),
        'closing',
      )
      screenshots.closing = await captureReferenceViewportScreenshot(page, viewport, 'closing')

      // Shared chrome is a property of the rendered reference, not of its
      // class names. Some decks repeat a footer or navigation rail on every
      // slide; others intentionally use only phase-local editorial layouts.
      // Derive candidates from selectors actually visible in all three
      // sampled phases, then retain only those also visible in every interior
      // layout below.
      const sharedAnchorSpecs = sharedReferenceRenderSpecs(phases, specs)
      const interiorVariants: RenderedReferenceLayoutVariantProfile[] = []
      const capturedLayoutSelectors = new Set<string>()
      for (let slideIndex = 1; slideIndex < slideCount - 1; slideIndex += 1) {
        await page.evaluate(SET_REFERENCE_RENDER_PHASE_PAGE_FUNCTION, slideIndex)
        await settleReferenceRender(page)
        const layout = await page.evaluate(REFERENCE_INTERIOR_LAYOUT_PAGE_FUNCTION, slideIndex)
        const layoutSelector = layout.layoutSelectors[0]
        if (!layoutSelector || capturedLayoutSelectors.has(layoutSelector)) continue
        if (interiorVariants.length >= 16) {
          throw new Error('Exact rendered reference contains more than 16 distinct interior slide variants')
        }
        const layoutSourceSpecs = specs.filter((spec) => (
          spec.selector === layoutSelector || spec.selector.startsWith(`${layoutSelector} `)
        )).slice(0, 2)
        const variantSpecs = [...layout.specs, ...sharedAnchorSpecs, ...layoutSourceSpecs]
          .filter((spec, index, all) => all.findIndex((candidate) => candidate.selector === spec.selector) === index)
          .slice(0, 20)
          .map((spec) => {
            const inferredGeometry = referenceRenderIntrinsicBlockGeometry(sourceProfile, spec.selector)
            const geometry = spec.selector === layoutSelector
              ? { geometry: 'strict' as const }
              : spec.authoredBox ? { geometry: spec.geometry } : inferredGeometry
            return {
              ...spec,
              ...geometry,
              properties: referenceRenderPropertiesForGeometry(spec.properties, geometry.geometry ?? spec.geometry),
            }
          })
        const variantProfile = await captureReferencePhase(page, variantSpecs, 'content', undefined, true)
        if (!variantProfile.anchors.some((anchor) => anchor.selector === layoutSelector)) {
          throw new Error(`Exact rendered reference variant ${layoutSelector} has no visible structural root`)
        }
        capturedLayoutSelectors.add(layoutSelector)
        interiorVariants.push({ layoutSelector, profile: variantProfile })
      }
      const sharedAnchorSelectors = sharedAnchorSpecs
        .filter((spec) => interiorVariants.every((variant) => (
          variant.profile.anchors.some((anchor) => anchor.selector === spec.selector)
        )))
        .map((spec) => spec.selector)
      if (signal?.aborted) throw abortReason(signal)
      if ([...Object.values(phases), ...interiorVariants.map((variant) => variant.profile)]
        .some((phase) => !phase.textLayout?.complete)) {
        const gaps = [...new Set([...Object.values(phases), ...interiorVariants.map((variant) => variant.profile)]
          .filter((phase) => !phase.textLayout?.complete).flatMap((phase) => phase.textLayout?.observationGaps ?? ['unknown_observation_gap']))]
        throw new ToolCapabilityUnavailableError(`Exact reference source text layout observation unavailable (${gaps.join(', ')}); no rendered baseline was established. Changing style arguments cannot repair an unsupported observation capability.`)
      }
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
        ...(sharedAnchorSelectors.length > 0 ? { sharedAnchorSelectors } : {}),
        ...(interiorVariants.length > 0 ? { interiorVariants } : {}),
      }, { evidenceSha256, viewport })
      return { profile, screenshots, ...(textFontFamilies ? { textFontFamilies } : {}) }
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
    // A reusable reset needs the same transport-first drain as shutdown.
    // Waiting for Context.close first can stall after every render check has
    // finished. Do not flip the permanent shutdown admission flag here.
    await this.drainBrowserResources()
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownWork) {
      // Flip admission before the shutdown drain snapshots pending Contexts and
      // Browser launches. Any operation that crossed this boundary has already
      // registered its creation promise and is therefore included in the drain.
      this.shuttingDown = true
      this.shutdownWork = this.drainBrowserResources()
    }
    await this.shutdownWork
  }

  private async drainBrowserResources(): Promise<void> {
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
    const presentationState = await page.evaluate(PRESENTATION_STATE_SNAPSHOT_PAGE_FUNCTION)
    const url = page.url()
    const title = await page.title()
    const scrollY = await page.evaluate(() => window.scrollY)
    // Browser navigation evidence must remain meaningful even when two slides
    // happen to contain identical text. Bind the rendered slide classes,
    // visibility and viewport intersection into a compact digest instead of
    // exposing another large snapshot to the model.
    const stateDigest = createHash('sha256').update(JSON.stringify({
      url,
      title,
      scrollY,
      text: visibleText,
      interactive,
      presentationState,
    })).digest('hex')
    return {
      url,
      pageEpoch: session.pageEpoch,
      title,
      viewport: page.viewportSize(),
      scrollY,
      stateDigest,
      text: visibleText.slice(0, 20_000),
      interactive,
    }
  }
}

const REFERENCE_RENDER_BASE_PROPERTIES = [
  'display', 'position', 'visibility', 'opacity', 'transform', 'pointer-events',
] as const
const REFERENCE_RENDER_MAX_SHARED_ANCHORS = 8
const REFERENCE_CHROME_SELECTOR_PATTERN = /(?:^|[-_.#])(?:nav|progress|counter|keyboard|hint|chrome|runner|footer|topbar|top-bar|slide-meta)(?:$|[-_.:# ])/iu

function sanitizeReferenceRenderHtml(html: string, allowInlineFontData = false, runtimeScripts: readonly ReferenceTemplateDependency[] = []): string {
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
  // Static captures remain script-src none. Native captures authorize only
  // the exact hash-checked dependency bodies, not arbitrary inline code,
  // external scripts, blob loaders, eval, or event handlers.
  const scriptSources = runtimeScripts.length
    ? runtimeScripts.map((script) => `'sha256-${Buffer.from(script.sha256, 'hex').toString('base64')}'`).join(' ')
    : "'none'"
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSources}; style-src 'unsafe-inline'; img-src 'none'; font-src ${fontSource}; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'">`
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
      const geometry = referenceRenderIntrinsicBlockGeometry(sourceProfile, rule.selector)
      const properties = referenceRenderPropertiesForGeometry([
        ...REFERENCE_RENDER_BASE_PROPERTIES,
        ...rule.declarations.map((entry) => entry.property),
        ...(rule.effectiveFontFamily ? ['font-family'] : []),
      ], geometry.geometry)
      return {
        selector: rule.selector,
        querySelector,
        ...(pseudoMatch ? { pseudo: pseudoMatch } : {}),
        properties,
        ...geometry,
      }
    })
}

function referenceRenderPropertiesForGeometry(
  properties: readonly string[],
  geometry?: ReferenceRenderGeometryPolicy,
): string[] {
  if (geometry !== 'flow-size') return [...new Set(properties)].slice(0, 24)
  // A fixed-size component may move with an intrinsic-height parent, but a
  // newly injected relative/absolute offset is still real style drift. Keep
  // the authored positioning and margin surface in the bounded fingerprint;
  // rect geometry independently verifies its fixed width and height.
  const usedSizeProperties = new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height'])
  return [...new Set([
    ...REFERENCE_RENDER_BASE_PROPERTIES,
    'top', 'right', 'bottom', 'left', 'inset', 'margin',
    ...properties.filter((property) => !usedSizeProperties.has(property)),
  ])].slice(0, 24)
}

function mergeReferenceRenderPhaseSpecs(
  phaseSpecs: readonly ReferenceRenderSelectorSpec[],
  sourceSpecs: readonly ReferenceRenderSelectorSpec[],
): ReferenceRenderSelectorSpec[] {
  const nonDuplicatePhaseSpecs = phaseSpecs.filter((phaseSpec) => !sourceSpecs.some((sourceSpec) => (
    REFERENCE_CHROME_SELECTOR_PATTERN.test(sourceSpec.selector)
    && phaseSpec.selector.endsWith(` ${sourceSpec.selector}`)
    && phaseSpec.pseudo === sourceSpec.pseudo
  )))
  const sourceBySelector = new Map(sourceSpecs.map((spec) => [spec.selector, spec]))
  const mergedPhaseSpecs = nonDuplicatePhaseSpecs.map((phaseSpec) => {
    const exactSourceSpec = sourceBySelector.get(phaseSpec.selector)
    const inheritedSourceSpec = exactSourceSpec ?? sourceSpecs.find((sourceSpec) => (
      /^[.#][-\w]+$/u.test(sourceSpec.selector)
      && phaseSpec.selector.endsWith(` ${sourceSpec.selector}`)
      && sourceSpec.pseudo === phaseSpec.pseudo
      && sourceSpec.geometry !== undefined
    ))
    const sourceSpec = inheritedSourceSpec
    if (!sourceSpec) return phaseSpec
    if (exactSourceSpec) sourceBySelector.delete(phaseSpec.selector)
    const intrinsicPhaseText = phaseSpec.geometry === 'intrinsic-inline'
      || phaseSpec.geometry === 'intrinsic-size'
    const phaseRootGeometry = phaseSpec.geometry === 'strict'
      && /^[.#][-_a-z][\w-]*$/iu.test(phaseSpec.selector)
    return {
      ...sourceSpec,
      ...phaseSpec,
      properties: phaseSpec.authoredBox ? phaseSpec.properties : [...new Set([
        ...sourceSpec.properties,
        ...(intrinsicPhaseText ? ['margin'] : phaseSpec.properties),
      ])].slice(0, 24),
      // A source-backed geometry policy knows whether width/height were
      // authored. Prefer it over the runtime text heuristic; the latter is
      // only authoritative for low-salience phase anchors omitted from the
      // bounded source profile. A Browser-identified slide root is always a
      // fixed stage anchor even when its source rule contains padding that
      // would make an ordinary descendant look like an intrinsic text chip.
      geometry: phaseRootGeometry ? 'strict' : phaseSpec.authoredBox ? phaseSpec.geometry : sourceSpec.geometry ?? phaseSpec.geometry,
    }
  })
  return [...mergedPhaseSpecs, ...sourceSpecs.filter((spec) => sourceBySelector.has(spec.selector))]
    .slice(0, 48)
}

/**
 * Find selectors whose rendered anchors exist in every canonical phase.
 * Familiar chrome names receive ordering priority, but they are neither
 * required nor sufficient: visibility in the captured Browser evidence is
 * what makes a selector shared. This keeps the profile compatible with
 * editorial decks that intentionally have no global navigation/footer DOM.
 */
function sharedReferenceRenderSpecs(
  phases: Record<ReferenceRenderPhase, RenderedReferencePhaseProfile>,
  sourceSpecs: readonly ReferenceRenderSelectorSpec[],
): ReferenceRenderSelectorSpec[] {
  const phaseSelectors = (['cover', 'content', 'closing'] as const).map((phase) => (
    new Set(phases[phase].anchors.map((anchor) => anchor.selector))
  ))
  const sourceBySelector = new Map(sourceSpecs.map((spec) => [spec.selector, spec]))
  return phases.cover.anchors
    .filter((anchor, index, anchors) => (
      anchors.findIndex((candidate) => candidate.selector === anchor.selector) === index
      && phaseSelectors.every((selectors) => selectors.has(anchor.selector))
    ))
    .map((anchor, order) => ({
      anchor,
      order,
      spec: sourceBySelector.get(anchor.selector) ?? referenceRenderSelectorSpecFromAnchor(anchor),
    }))
    .sort((left, right) => (
      Number(REFERENCE_CHROME_SELECTOR_PATTERN.test(right.anchor.selector))
      - Number(REFERENCE_CHROME_SELECTOR_PATTERN.test(left.anchor.selector))
      || Number(right.anchor.geometry === 'strict') - Number(left.anchor.geometry === 'strict')
      || right.anchor.occlusion.reduce((total, ratio) => total + ratio, 0)
        - left.anchor.occlusion.reduce((total, ratio) => total + ratio, 0)
      || left.order - right.order
    ))
    .slice(0, REFERENCE_RENDER_MAX_SHARED_ANCHORS)
    .map(({ spec }) => spec)
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
): { geometry?: ReferenceRenderGeometryPolicy } {
  const terminal = selector.match(/(\.[a-z][a-z0-9-]*)(?::[-\w()]+)?\s*$/iu)?.[1]?.toLowerCase()
  if (!terminal) return {}
  const normalized = selector.replace(/\s+/gu, ' ').trim().toLowerCase()
  // A layout-* selector used as the whole phase root fills the slide stage
  // through the shared `.slide` rule. Its local rule may contain only
  // alignment/text declarations, which must not let the intrinsic-copy
  // heuristic downgrade the page-sized structural geometry.
  if (/^\.layout-[a-z0-9-]+(?::[-\w()]+)?$/iu.test(normalized)) {
    return { geometry: 'strict' }
  }
  const sourceRule = sourceProfile.rules.find((rule) => {
    const candidate = rule.selector.replace(/\s+/gu, ' ').trim().toLowerCase()
    return candidate === normalized || candidate === terminal
  })
  const declarationValue = (property: string) => sourceRule?.declarations
    .find((declaration) => declaration.property === property)?.value.trim()
  const positioned = sourceRule?.declarations.some(({ property, value }) => (
    property === 'position' && /^(?:absolute|fixed|sticky)$/iu.test(value.trim())
  )) === true
  const explicitVerticalSize = sourceRule?.declarations.some(({ property, value }) => (
    property === 'height'
    || property === 'max-height'
    || (property === 'min-height' && !/^(?:0(?:px|rem|em|%)?|auto)$/iu.test(value.trim()))
  )) === true || Boolean(
    positioned
    && declarationValue('top')
    && declarationValue('top') !== 'auto'
    && declarationValue('bottom')
    && declarationValue('bottom') !== 'auto',
  )
  const explicitHorizontalSize = sourceRule?.declarations.some(({ property, value }) => (
    property === 'width' && value.trim() !== 'auto'
  )) === true || Boolean(
    positioned
    && declarationValue('left')
    && declarationValue('left') !== 'auto'
    && declarationValue('right')
    && declarationValue('right') !== 'auto',
  )
  const fixedDecoration = /(?:circle|dots?|decoration|accent-line|nav-btn|bar-track|bar-fill|progress|icon)$/iu.test(terminal)
  if (fixedDecoration || (explicitHorizontalSize && explicitVerticalSize)) {
    // Fixed-size components inside a content-flow layout retain their own
    // dimensions and horizontal alignment, but their viewport Y coordinate
    // legitimately follows an intrinsic-height parent when copy changes.
    // This also applies to an absolutely positioned axis/dot whose containing
    // block is itself in content flow. Static source verification protects its
    // authored offsets; viewport Y must not be frozen to the demo copy.
    if (normalized.includes(' ') && (fixedDecoration || !positioned)) return { geometry: 'flow-size' }
    return { geometry: 'strict' }
  }
  const intrinsicInline = positioned && !explicitHorizontalSize
  // A phase-derived selector can be absent from the bounded source profile.
  // Do not overwrite the Browser's stronger intrinsic-text inference merely
  // because that selector happens to contain a descendant combinator.
  const descendantBlock = Boolean(sourceRule) && !explicitVerticalSize && /^\s*\.[a-z_][a-z0-9_-]*\s+/iu.test(selector)
  const anchoredAutoBlock = positioned && !explicitVerticalSize
    && sourceRule?.declarations.some(({ property }) => property === 'top' || property === 'bottom') === true
  const verticallyCenteredAutoBlock = anchoredAutoBlock
    && sourceRule?.declarations.some(({ property, value }) => (
      property === 'top' && /^50(?:\.0+)?%$/u.test(value.trim())
    )) === true
    && sourceRule?.declarations.some(({ property, value }) => (
      property === 'transform' && /translatey\(\s*-50(?:\.0+)?%\s*\)/iu.test(value)
    )) === true
  const structuralDisplay = sourceRule?.declarations.some(({ property, value }) => (
    property === 'display' && /^(?:flex|inline-flex|grid|inline-grid)$/iu.test(value.trim())
  )) === true
  const inlineStructuralDisplay = sourceRule?.declarations.some(({ property, value }) => (
    property === 'display' && /^(?:inline-flex|inline-grid)$/iu.test(value.trim())
  )) === true
  const semanticTextLabel = /(?:^|[-_.#])(?:badge|caption|chip|copy|eyebrow|footnote|kicker|label|note|pill|strap|tag|tagline)(?:$|[-_.:# ])/iu.test(selector)
  const autoSizedTextLabel = !explicitHorizontalSize
    && !explicitVerticalSize
    // `inline-flex` is how pill/badge labels align their contents; it does not
    // turn their copy-owned used width or flex-wrap row into fixed geometry.
    && (!structuralDisplay || (inlineStructuralDisplay && semanticTextLabel))
    && (
      semanticTextLabel
      || sourceRule?.declarations.some(({ property }) => (
        property.startsWith('font-')
        || property.startsWith('text-')
        || property === 'letter-spacing'
        || property === 'line-height'
        || property === 'white-space'
        || property === 'padding'
        || property.startsWith('padding-')
      )) === true
    )
  if (autoSizedTextLabel) return { geometry: 'intrinsic-size' }
  if (verticallyCenteredAutoBlock) return { geometry: 'intrinsic-block-center' }
  if (intrinsicInline && (descendantBlock || anchoredAutoBlock)) return { geometry: 'intrinsic-size' }
  if (intrinsicInline) return { geometry: 'intrinsic-inline' }
  return verticallyCenteredAutoBlock
    ? { geometry: 'intrinsic-block-center' }
    : descendantBlock || anchoredAutoBlock ? { geometry: 'intrinsic-block' } : {}
}

function referenceRenderSelectorSpecFromAnchor(anchor: RenderedReferenceAnchorProfile): ReferenceRenderSelectorSpec {
  const pseudoMatch = anchor.selector.match(/::(?:before|after)\b/iu)?.[0].toLowerCase() as '::before' | '::after' | undefined
  return {
    selector: anchor.selector,
    querySelector: pseudoMatch ? anchor.selector.replace(/::(?:before|after)\b/giu, '') : anchor.selector,
    ...(pseudoMatch ? { pseudo: pseudoMatch } : {}),
    properties: [...new Set(anchor.styles.flatMap((styles) => Object.keys(styles)))].slice(0, 24),
    geometry: anchor.geometry,
    ...(anchor.authoredBox ? { authoredBox: true } : {}),
  }
}

async function settleReferenceRender(page: Page): Promise<void> {
  // Playwright's out-of-page timer also works in the CSP-locked reference
  // document and leaves enough time for layout and font fallback to settle.
  await page.waitForTimeout(550)
}

function normalizeReferenceRenderFontOptions(
  options: ReferenceRenderFontOptions | undefined,
): Required<Pick<ReferenceRenderFontOptions, 'fontCss' | 'expectedFontFamilies'>> | undefined {
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

const REFERENCE_LANGUAGE_RENDER_PAGE_FUNCTION = Function('"use strict"; return (' + String.raw`({ language, roles }) => {
    const violations = [];
    const add = (message) => { if (violations.length < 20 && !violations.includes(message)) violations.push(message); };
    const family = (value) => value.toLowerCase().replace(/["'\s]/g, '');
    const cjk = /[\p{Script=Han}\u3000-\u303f\uff01-\uff60]/u;
    const visible = (element) => {
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0.01) return false;
      }
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight;
    };
    for (const root of document.querySelectorAll('.slide')) {
      if (!visible(root)) continue;
      const variant = root.getAttribute('data-anera-cjk-variant');
      for (const group of root.querySelectorAll('[data-anera-cjk-text]')) {
        if (!visible(group)) { add('render CJK text group ' + String(variant).slice(0, 8) + '.' + String(group.getAttribute('data-anera-cjk-text')).slice(0, 8) + ' is hidden or outside the visible source slide; inspect overlong copy in this source layout without changing its typography'); continue; }
        const actual = getComputedStyle(group);
        const parent = getComputedStyle(group.parentElement);
        const display = ['flex','inline-flex','grid','inline-grid'].includes(parent.display) ? 'block' : 'inline';
        if (actual.display !== display || actual.position !== 'static' || actual.transform !== 'none' || actual.filter !== 'none' || Number(actual.opacity) !== 1
          || ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','textTransform','color','textShadow'].some((key) => actual[key] !== parent[key])) add('render CJK text group must retain the original mixed-script formatting context');
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!cjk.test(node.textContent || '') || !node.parentElement || !visible(node.parentElement)) continue;
        if (!node.parentElement.hasAttribute('data-anera-cjk')) add('render CJK copy lost its documented typography run');
      }
      for (const run of root.querySelectorAll('[data-anera-cjk]')) {
        if (!visible(run)) { add('render CJK run ' + String(variant).slice(0, 8) + '.' + String(run.getAttribute('data-anera-cjk-slot')).slice(0, 8) + ' is hidden or outside the visible source slide'); continue; }
        const binding = language.bindings.find((item) => item.variant === variant && item.slot === run.getAttribute('data-anera-cjk-slot'));
        if (!binding || run.getAttribute('data-anera-cjk') !== binding.role) { add('render CJK run changed its source role'); continue; }
        let parent = root;
        for (const index of binding.path) parent = parent && [...parent.children].filter((child) => !child.hasAttribute('data-anera-cjk') && !child.hasAttribute('data-anera-cjk-text') && !(child.tagName.toLowerCase() === 'a' && child.getAttribute('style') === 'color:inherit;text-decoration:inherit'))[index];
        let actualParent = run.parentElement;
        if (!actualParent?.hasAttribute('data-anera-cjk-text') || actualParent.getAttribute('data-anera-cjk-text') !== binding.slot) { add('render CJK run lost its original literal-text group'); continue; }
        actualParent = actualParent.parentElement;
        if (actualParent?.tagName.toLowerCase() === 'a' && actualParent.getAttribute('style') === 'color:inherit;text-decoration:inherit') actualParent = actualParent.parentElement;
        if (!parent || actualParent !== parent) { add('render CJK run moved away from its source text parent'); continue; }
        const rule = roles[binding.role];
        const actual = getComputedStyle(run);
        const inherited = getComputedStyle(parent);
        const size = Number.parseFloat(inherited.fontSize);
        const prefix = 'render CJK ' + variant + '.' + binding.slot + ' ';
        if (family(actual.fontFamily) !== family(rule.family)) add(prefix + 'font-family differs from the documented pairing');
        if (actual.fontWeight !== String(rule.weight)) add(prefix + 'font-weight expected ' + rule.weight + ' but found ' + actual.fontWeight);
        if (actual.fontSize !== inherited.fontSize) add(prefix + 'font-size must inherit the original text slot');
        if (actual.fontStyle !== 'normal' || actual.fontSynthesis !== 'none') add(prefix + 'must not synthesize bold/italic glyphs');
        if (actual.display !== 'inline' || actual.position !== 'static' || actual.transform !== 'none' || actual.filter !== 'none'
          || Number(actual.opacity) !== 1 || actual.color !== inherited.color || actual.textShadow !== inherited.textShadow
          || ['marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some((key) => Number.parseFloat(actual[key]) !== 0)) add(prefix + 'must preserve the source inline layout, color and glow');
        if (!['normal', '0px'].includes(actual.letterSpacing) || actual.textTransform !== 'none') add(prefix + 'requires zero tracking and no uppercase transformation');
        if ('lineHeight' in rule && Math.abs(Number.parseFloat(actual.lineHeight) - size * rule.lineHeight) > 0.05) add(prefix + 'line-height differs from the documented role');
        if (!('lineHeight' in rule) && actual.lineHeight !== inherited.lineHeight) add(prefix + 'line-height must inherit the original label slot');
      }
    }
    return violations;
  }` + ')')() as (payload: { language: ReferenceLanguageVariant; roles: typeof REFERENCE_LANGUAGE_ROLES }) => string[]

async function referenceLanguageRenderViolations(page: Page, value: ReferenceLanguageVariant | undefined, sourceSha256: string): Promise<string[]> {
  if (!value) return []
  const language = normalizeReferenceLanguageVariant(value)
  if (language.sourceSha256 !== sourceSha256) throw new Error('Rendered CJK policy is bound to another reference source')
  return await page.evaluate(REFERENCE_LANGUAGE_RENDER_PAGE_FUNCTION, { language, roles: REFERENCE_LANGUAGE_ROLES })
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
  const runtimeManagedSlideSelectors = new Set(
    renderedReferenceRuntimeManagedSlideSelectors(profile),
  )
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
  const presentationState = await page.evaluate(PRESENTATION_STATE_SNAPSHOT_PAGE_FUNCTION)
  const first = await captureReferencePhase(page, specs, phase, expected.typographyProbes, Boolean(currentVariant))
  const firstLanguageViolations = await referenceLanguageRenderViolations(page, fontOptions?.languageVariant, profile.evidenceSha256)
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
    {
      allowMissingTypography: Boolean(currentVariant),
      runtimeManagedSlideSelectors,
    },
  )
  const stageViolations = presentationStageViolations(phase, presentationState)
  for (const violation of [...firstLanguageViolations, ...await referenceLanguageRenderViolations(page, fontOptions?.languageVariant, profile.evidenceSha256)]) {
    if (!verification.violations.includes(violation)) addRenderedReferenceViolation(verification, violation)
  }
  applyRenderedPresentationStageViolations(verification, stageViolations)
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
  // Inspect the real selected state before the all-interior activator can
  // hide sibling roots. Compact visibility supplements, never replaces, the
  // exact design-viewport screenshot and fidelity checks above.
  if (verification.fidelity === 'pass' && presentationState.length > 0 && startingViewport) {
    const surface = await verifyCompactPresentationSurface(session, phase, startingViewport)
    applyRenderedSurfaceAttestation(verification, surface)
    if (surface.restored && !renderedPhaseSnapshotsEqual(second,
      await captureReferencePhase(page, specs, phase, expected.typographyProbes, Boolean(currentVariant)))) {
      addRenderedReferenceViolation(verification, `render ${phase} changed design-viewport evidence after compact surface restoration`)
    }
  }
  // Do not manufacture reassuring per-slide scores after the actual active
  // slide has already failed the shared-stage invariant. The forced
  // all-interior activator deliberately hides sibling slides so it can audit
  // each layout in isolation; running it after a vertical-flow failure masks
  // the root cause and sends the repair model toward unrelated pixel tweaks.
  if (phase === 'content' && startingState && stageViolations.length === 0
    && !verification.surfaceAttestations?.some(surface => surface.checked !== surface.matched)) {
    const interior = await verifyAllInteriorReferenceVariants(
      session,
      profile,
      startingState,
      startingUrl,
      startingViewport,
      startingEpoch,
      runtimeManagedSlideSelectors,
      fontOptions?.languageVariant,
    )
    verification.interiorAttestation = interior.attestation
    verification.checked += interior.checked
    verification.matched += interior.matched
    verification.observationGapCount = (verification.observationGapCount ?? 0) + interior.observationGapCount
    verification.surfaceAttestations = [...verification.surfaceAttestations ?? [], ...interior.surfaceAttestations]
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

async function verifyCompactPresentationSurface(
  session: BrowserSession, phase: string, designViewport: { width: number; height: number },
): Promise<RenderedReferenceSurfaceAttestation> {
  const page = session.page
  const originalViewport = page.viewportSize()
  const originalUrl = page.url()
  const originalEpoch = session.pageEpoch
  const originalState = await page.evaluate(REFERENCE_RENDER_PAGE_STATE_PAGE_FUNCTION)
  const viewport = compactPresentationViewport(designViewport)
  const result: RenderedReferenceSurfaceAttestation = { surface: 'compact-stage-v1', phase, viewport,
    activeIndex: originalState.activeIndex, checked: 0, matched: 0, observationGaps: 0, restored: false, violations: [] }
  const check = (passed: boolean, violation: string) => {
    result.checked += 1
    if (passed) result.matched += 1
    else result.violations.push(violation)
  }
  try {
    await page.setViewportSize(viewport)
    await settleReferenceRender(page)
    const slides = await page.evaluate(PRESENTATION_STATE_SNAPSHOT_PAGE_FUNCTION)
    const active = presentationActiveState(slides)
    result.activeRect = slides.find(slide => slide.index === originalState.activeIndex)?.rect
    const prefix = `render ${phase} compact surface ${viewport.width}x${viewport.height}`
    check(slides.length === originalState.slides.length && active.indices.length === 1
      && active.indices[0] === originalState.activeIndex, `${prefix} changed presentation ownership or root count during resize`)
    const violations = presentationStageViolations(phase, slides)
    check(slides.length > 0 && violations.length === 0,
      `${prefix}: ${violations.join(' ') || 'no observable presentation roots'}. Active root bounds=${JSON.stringify(result.activeRect)}. Inspect the authored host/containing block together with runtime scaling; design-viewport visibility does not prove compact visibility.`)
    if (active.indices.length === 1 && violations.length === 0) {
      const observe = Function(`"use strict"; return (index) => (${RENDERED_CONTROL_OCCLUSION_SCRIPT})((${REFERENCE_SLIDE_ELEMENTS_SCRIPT})()[index])`)() as
        (index: number) => RenderedControlOcclusion
      const occlusion = await page.evaluate(observe, active.indices[0])
      result.controlOcclusion = occlusion
      check(occlusion.collisions.length === 0,
        `${prefix} external controls intercept visible content text regions: ${JSON.stringify(occlusion.collisions)}. Keep navigation usable without covering content; inspect stacking, placement and redundant controls. This is hit-tested region evidence, not a full ink-occlusion measurement.`)
      if (!occlusion.complete) {
        result.checked += 1
        result.observationGaps += 1
        result.violations.push(`${prefix} control-occlusion observation reached its bounded sampling limit`)
      }
    }
    // A compact probe cannot replace the document and still certify it.
    check(page.url() === originalUrl && session.pageEpoch === originalEpoch,
      `${prefix} changed page identity during observation`)
  } catch (error) {
    result.checked += 1
    result.observationGaps += 1
    result.violations.push(`render ${phase} compact surface could not be observed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (originalViewport) {
      try {
        await page.setViewportSize(originalViewport)
        await settleReferenceRender(page)
        const state = await page.evaluate(REFERENCE_RENDER_PAGE_STATE_PAGE_FUNCTION)
        result.restored = JSON.stringify(state) === JSON.stringify(originalState)
          && page.url() === originalUrl && session.pageEpoch === originalEpoch
          && renderedViewportsEqual(page.viewportSize(), originalViewport)
        // Do not silently rewrite controller state or relabel a mutation as
        // clean. The main gate rejects any non-restoring resize transition.
      } catch { result.restored = false }
    }
    check(result.restored, `render ${phase} compact surface probe did not restore its original page state and viewport`)
  }
  return result
}

function applyRenderedSurfaceAttestation(
  verification: BrowserRenderedReferenceStyleVerification, surface: RenderedReferenceSurfaceAttestation,
): void {
  verification.surfaceAttestations = [...verification.surfaceAttestations ?? [], surface]
  verification.checked += surface.checked
  verification.matched += surface.matched
  verification.observationGapCount = (verification.observationGapCount ?? 0) + surface.observationGaps
  verification.score = Math.round(verification.matched / verification.checked * 1_000) / 10
  if (surface.checked !== surface.matched) verification.fidelity = 'mismatch'
  for (const violation of surface.violations) if (verification.violations.length < 64) verification.violations.push(violation)
}

async function verifyAllInteriorReferenceVariants(
  session: BrowserSession,
  profile: RenderedReferenceStyleProfile,
  startingState: ReferenceRenderPageState,
  startingUrl: string,
  startingViewport: { width: number; height: number } | null,
  startingEpoch: number,
  runtimeManagedSlideSelectors: ReadonlySet<string>,
  languageVariant?: ReferenceLanguageVariant,
): Promise<{
  attestation: RenderedReferenceInteriorAttestation
  checked: number
  matched: number
  violations: string[]
  observationGapCount: number
  surfaceAttestations: RenderedReferenceSurfaceAttestation[]
}> {
  const page = session.page
  const variants = profile.interiorVariants ?? []
  const candidateSlides = Math.max(0, startingState.slides.length - 2)
  const slides: RenderedReferenceInteriorAttestation['slides'] = []
  const violations: string[] = []
  const surfaceAttestations: RenderedReferenceSurfaceAttestation[] = []
  let checked = 0
  let matched = 0
  let matchedSlides = 0
  let observationGapCount = 0
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
      observationGapCount: 1,
      surfaceAttestations,
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
      const matchingVariants = variants.filter((variant) => layout.layoutSelectors.includes(variant.layoutSelector))
      // A variant library is exclusive per page. Picking whichever stacked
      // class scores best would let conflicting layout rules pass whenever a
      // compound override visually cancels one of them.
      if (variants.length > 0 && matchingVariants.length !== 1) {
        checked += 1
        slides.push({ slideIndex, ...(layoutSelector ? { layoutSelector } : {}), fidelity: 'mismatch', score: 0 })
        if (violations.length < 64) {
          violations.push(matchingVariants.length === 0
            ? `content slide ${slideIndex + 1} has no real reference variant class`
            : `content slide ${slideIndex + 1} stacks alternative reference layout variants ${matchingVariants.map((variant) => variant.layoutSelector).join(', ')}; use exactly one variant root class`)
        }
        continue
      }
      const candidates: RenderedReferenceLayoutVariantProfile[] = variants.length > 0
        ? matchingVariants
        : [{ layoutSelector: layoutSelector ?? '.slide', profile: profile.phases.content }]
      if (candidates.length === 0) {
        checked += 1
        slides.push({ slideIndex, ...(layoutSelector ? { layoutSelector } : {}), fidelity: 'mismatch', score: 0 })
        if (violations.length < 64) {
          violations.push(layoutSelector
            ? `content slide ${slideIndex + 1} uses ${layoutSelector}, which is not a real reference layout variant`
            : `content slide ${slideIndex + 1} has no real reference variant class`)
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
          { allowMissingTypography: true, runtimeManagedSlideSelectors },
        )
        for (const violation of await referenceLanguageRenderViolations(page, languageVariant, profile.evidenceSha256)) {
          addRenderedReferenceViolation(verification, violation)
        }
        if (!renderedPhaseSnapshotsEqual(first, second)) {
          addRenderedReferenceViolation(
            verification,
            `content slide ${slideIndex + 1} (${variant.layoutSelector}) remained unstable across the verification window`,
          )
        }
        if (verification.fidelity === 'pass' && startingViewport) {
          const surface = await verifyCompactPresentationSurface(session, `content slide ${slideIndex + 1}`, startingViewport)
          surfaceAttestations.push(surface)
          applyRenderedSurfaceAttestation(verification, surface)
          if (surface.restored && !renderedPhaseSnapshotsEqual(second,
            await captureReferencePhase(page, specs, 'content', variant.profile.typographyProbes, variants.length > 0))) {
            addRenderedReferenceViolation(verification, `content slide ${slideIndex + 1} changed after compact surface restoration`)
          }
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
      observationGapCount += best.observationGapCount ?? 0
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
    observationGapCount,
    surfaceAttestations,
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
  options: {
    allowMissingTypography?: boolean
    runtimeManagedSlideSelectors?: ReadonlySet<string>
  } = {},
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
    const directlyRuntimeManagedSlideRoot = options.runtimeManagedSlideSelectors?.has(expected.selector) === true
    // The same slide-root element is commonly captured twice: once through
    // its structural selector (`deck-stage>section.slide`) and once through
    // its phase/layout class (`.s-cover`, `.s-toc`, ...). Computed `position`
    // changes on both aliases when an external controller's relative-flow
    // root becomes a self-contained absolute stack. Treat the alias as the
    // same runtime surface only after Browser proves both snapshots still own
    // the exact full viewport; size and position checks below remain strict.
    const runtimeManagedSlideRoot = directlyRuntimeManagedSlideRoot || Boolean(
      actual
      && (options.runtimeManagedSlideSelectors?.size ?? 0) > 0
      && expected.geometry === 'strict'
      && expected.rects.length > 0
      && actual.rects.length === expected.rects.length
      && expected.rects.every((rect) => (
        Math.abs(rect.x) <= 0.01
        && Math.abs(rect.y) <= 0.01
        && rect.width >= 0.98
        && rect.height >= 0.98
      ))
      && actual.rects.every((rect) => (
        Math.abs(rect.x) <= 0.01
        && Math.abs(rect.y) <= 0.01
        && rect.width >= 0.98
        && rect.height >= 0.98
      )),
    )
    check(Boolean(actual), `render ${phase} is missing visible anchor ${expected.selector}`)
    if (!actual) continue
    check(actual.count === expected.count, `render ${phase} ${expected.selector} count expected ${expected.count} but found ${actual.count}. This counts visible in-viewport matches, not all DOM nodes. Check whether source elements are missing, hidden, or pushed outside the viewport by overlong copy before changing their count; preserve the source geometry and typography.`)
    const samples = Math.min(expected.rects.length, actual.rects.length)
    // getBoundingClientRect() on a pseudo selector measures its host element,
    // not the generated ::before/::after box. Retain pseudo count and computed
    // style evidence, but never turn the host's content-sized geometry or hit
    // testing into a pseudo-element fidelity defect.
    const pseudoGeometryUnavailable = /::(?:before|after)\b/iu.test(expected.selector)
    const variableProgressFill = phase !== 'closing' && /(?:^|[-_.#])progress(?:$|[-_.:# ])/iu.test(expected.selector)
    const intrinsicContentHeader = /(?:^|[-_.#])slide-header(?:$|[-_.:# ])/iu.test(expected.selector)
    // Repeated flex children whose reference samples already have materially
    // different widths are demonstrably content-sized. Localized copy may
    // change those widths and the space-between positions without changing a
    // single template declaration. This inference keeps profiles captured by
    // older versions usable after the explicit intrinsic-inline policy was
    // introduced.
    const referenceWidths = expected.rects.map((rect) => rect.width)
    const maximumReferenceWidth = referenceWidths.length > 0 ? Math.max(...referenceWidths) : 0
    const heterogeneousRepeatedInlineSize = expected.count > 1
      && referenceWidths.length > 1
      && maximumReferenceWidth - Math.min(...referenceWidths) > Math.max(
        2 / expectedViewport.width,
        maximumReferenceWidth * 0.05,
      )
      && expected.styles.every((style) => ['flex', 'inline-flex', 'inline', 'inline-block'].includes(style.display ?? ''))
    // Counters, keyboard hints, runners, and footers carry task/localized
    // text inside fixed template chrome. Preserve the source-controlled
    // horizontal span and top/bottom edge while allowing natural line-box
    // height. Counters and hints may also change intrinsic width.
    const intrinsicTextChrome = /(?:^|[-_.#])(?:slide-counter|keyboard-hint|runner|footer)(?:$|[-_.:# ])/iu.test(expected.selector)
    const fullyIntrinsicTextChrome = /(?:^|[-_.#])(?:slide-counter|keyboard-hint)(?:$|[-_.:# ])/iu.test(expected.selector)
    const centeredIntrinsicTextChrome = /(?:^|[-_.#])keyboard-hint(?:$|[-_.:# ])/iu.test(expected.selector)
    const bottomAnchoredTextChrome = /(?:^|[-_.#])(?:slide-counter|keyboard-hint|footer)(?:$|[-_.:# ])/iu.test(expected.selector)
    // Profiles captured before auto-sized label inference marked painted
    // kicker chips, pills, and badges as strict or vertical-only merely
    // because they had a background/border. Preserve those durable contracts
    // across upgrades while keeping structural flex/grid panels strict.
    const legacyTerminalClass = expected.selector
      .match(/\.([a-z][a-z0-9-]*)(?::[-\w()]+)?\s*$/iu)?.[1]?.toLowerCase()
    const legacyIntrinsicAutoSizedText = ['strict', 'intrinsic-block'].includes(expected.geometry)
      && /^(?:badge|caption|chip|copy|eyebrow|footnote|kicker|label|note|pill|strap|tag|tagline)$/u.test(legacyTerminalClass ?? '')
      && expected.styles.every((style) => !['flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display ?? ''))
    // Early v1 profiles represented unpositioned descendant text such as
    // `.s-cover .title .l2` as `intrinsic-block` and omitted directional
    // padding from their bounded style surface. Its width is owned by the
    // replacement glyphs (and can change across languages), not by template
    // geometry. Recognize that old shape without weakening structural flex,
    // grid, media, fixed-size, or positioned anchors. Newly captured profiles
    // carry padding-left/right explicitly and classify the same node as
    // intrinsic-size, so authored spacing drift remains directly testable.
    const legacyIntrinsicDescendantText = expected.geometry === 'intrinsic-block'
      && expected.selector.includes(' ')
      && expected.styles.length > 0
      && expected.styles.every((style) => (
        ['block', 'inline', 'inline-block'].includes(style.display ?? '')
        && !['absolute', 'fixed', 'sticky'].includes(style.position ?? '')
        && typeof style['font-family'] === 'string'
        && !['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height']
          .some((property) => property in style)
      ))
    // Older persisted profiles classified absolutely positioned vertical
    // stacks of pills/tags as strict merely because the wrapper itself is a
    // flex container. Its horizontal used size still comes from replacement
    // copy in the children. Preserve the authored top/right edge and the
    // stack's fixed vertical geometry, but do not force localized labels to
    // reproduce the reference demo text's aggregate width/left coordinate.
    const legacyIntrinsicInlineTextCollection = ['strict', 'intrinsic-block'].includes(expected.geometry)
      && /(?:^|-)(?:(?:badges?|chips?|kickers?|labels?|pills?|straps?|tags?)|(?:badge|chip|kicker|label|pill|strap|tag)-(?:cluster|group|list|stack|wrap|wrapper))$/u.test(legacyTerminalClass ?? '')
      && expected.styles.every((style) => (
        ['absolute', 'fixed', 'sticky'].includes(style.position ?? '')
        && ['flex', 'inline-flex'].includes(style.display ?? '')
        && String(style['flex-direction'] ?? '').startsWith('column')
      ))
    const fullyIntrinsicSize = expected.geometry === 'intrinsic-size'
      || legacyIntrinsicAutoSizedText
      || legacyIntrinsicDescendantText
    // Profiles captured before intrinsic-block-center existed serialized
    // translateY(-50%) as a matrix whose Y translation is exactly half the
    // element's used height. Recover that authored centering relationship so
    // persisted Sessions do not turn localized copy into false template drift.
    const centeredIntrinsicBlock = expected.geometry === 'intrinsic-block-center'
      || (expected.authoredBox === true && expected.styles.some((style, index) =>
        style.top === '50%' && halfHeightCenteredTransform(style, expected.rects[index], expectedViewport.height)))
      || (
        expected.geometry === 'strict'
        && expected.styles.some((style, index) => halfHeightCenteredTransform(
          style,
          expected.rects[index],
          expectedViewport.height,
        ))
      )
    // Durable profiles captured before content-flow inference treated these
    // auto-height composite containers as fixed rectangles. Their unchanged
    // CSS and child anchor counts are verified elsewhere; translated or
    // shortened copy may legitimately change their used height.
    const legacyIntrinsicContentContainer = ['strict', 'size'].includes(expected.geometry)
      && /^(?:breakdown|track)$/u.test(legacyTerminalClass ?? '')
    // The same historical profiles froze the viewport Y of fixed-size axes,
    // dots, and similar decoration even when their positioned ancestor moves
    // with an intrinsic-height heading.
    const legacyFixedDecorationInFlow = expected.geometry === 'strict'
      && expected.selector.includes(' ')
      && /(?:^|-)(?:axis|bar|circle|dot|line|progress|track)(?:$|-)/u.test(legacyTerminalClass ?? '')
    const intrinsicBlockSize = expected.geometry === 'intrinsic-block'
      || centeredIntrinsicBlock
      || fullyIntrinsicSize
      || heterogeneousRepeatedInlineSize
      || intrinsicTextChrome
      || legacyIntrinsicContentContainer
    const fixedSizeInFlow = expected.geometry === 'flow-size' || legacyFixedDecorationInFlow
    const intrinsicInlineSize = expected.geometry === 'intrinsic-inline'
      || fullyIntrinsicSize
      || heterogeneousRepeatedInlineSize
      || fullyIntrinsicTextChrome
      || legacyIntrinsicInlineTextCollection
    for (let index = 0; index < samples; index += 1) {
      const expectedRect = expected.rects[index]
      const actualRect = actual.rects[index]
      const widthTolerance = Math.max(2 / expectedViewport.width, expectedRect.width * 0.05)
      const heightTolerance = intrinsicContentHeader
        ? Math.max(4 / expectedViewport.height, expectedRect.height * 0.15)
        : Math.max(2 / expectedViewport.height, expectedRect.height * 0.05)
      if (!pseudoGeometryUnavailable) {
        check(
          (variableProgressFill || intrinsicInlineSize || Math.abs(actualRect.width - expectedRect.width) <= widthTolerance)
            && (intrinsicBlockSize || Math.abs(actualRect.height - expectedRect.height) <= heightTolerance),
          `render ${phase} ${expected.selector}[${index}] size expected ${renderedRectSummary(expectedRect)} but found ${renderedRectSummary(actualRect)}`,
        )
      }
      const expectedStyles = expected.styles[index] ?? {}
      const actualStyles = actual.styles[index] ?? {}
      const positionedIntrinsicBlock = intrinsicBlockSize
        && ['absolute', 'fixed', 'sticky'].includes(expectedStyles.position ?? '')
      const unpositionedIntrinsicFlowItem = (fullyIntrinsicSize || heterogeneousRepeatedInlineSize)
        && !['absolute', 'fixed', 'sticky'].includes(expectedStyles.position ?? '')
      if (!pseudoGeometryUnavailable && (expected.geometry === 'strict' || positionedIntrinsicBlock || intrinsicInlineSize || fixedSizeInFlow)) {
        const expectedBottom = expectedRect.y + expectedRect.height
        const actualBottom = actualRect.y + actualRect.height
        const expectedCenterX = expectedRect.x + expectedRect.width / 2
        const actualCenterX = actualRect.x + actualRect.width / 2
        const expectedCenterY = expectedRect.y + expectedRect.height / 2
        const actualCenterY = actualRect.y + actualRect.height / 2
        const explicitBottomAnchor = expectedStyles.bottom !== undefined
          && expectedStyles.bottom !== 'auto'
          && (expectedStyles.top === undefined || expectedStyles.top === 'auto')
        const inferredStableBottomAnchor = legacyIntrinsicContentContainer
          && ['absolute', 'fixed', 'sticky'].includes(expectedStyles.position ?? '')
          && Math.abs(actualBottom - expectedBottom) <= Math.max(4 / expectedViewport.height, 0.01)
        const explicitLeftAnchor = expectedStyles.left !== undefined
          && expectedStyles.left !== 'auto'
          && (expectedStyles.right === undefined || expectedStyles.right === 'auto')
        const explicitRightAnchor = expectedStyles.right !== undefined
          && expectedStyles.right !== 'auto'
          && (expectedStyles.left === undefined || expectedStyles.left === 'auto')
        const positionedIntrinsicInline = intrinsicInlineSize
          && ['absolute', 'fixed', 'sticky'].includes(expectedStyles.position ?? '')
        const positionedAnchor = ['absolute', 'fixed', 'sticky'].includes(expectedStyles.position ?? '')
        const expectedContainingBlockOffset = expected.containingBlockOffsets?.[index]
        const actualContainingBlockOffset = actual.containingBlockOffsets?.[index]
        const expectedDirectionalProperties = ['top', 'right', 'bottom', 'left', 'inset']
          .filter((property) => expectedStyles[property] !== undefined && expectedStyles[property] !== 'auto')
        const positionedDecorationWithStableInsets = positionedAnchor
          && /(?:^|[-_.#])(?:accent|decoration|doodle|ornament|pin|post-it|shape)(?:$|[-_.:# 0-9])/iu.test(expected.selector)
          && (
            expected.containingBlockOffsets === undefined
            || ((intrinsicBlockSize || intrinsicInlineSize) && Boolean(expectedStyles.transform && expectedStyles.transform !== 'none'))
          )
          && (
            expectedDirectionalProperties.length > 0
              ? expectedDirectionalProperties.every((property) => actualStyles[property] === expectedStyles[property])
              // A legacy repeated base-class anchor can omit the subtype's
              // inset properties. Its subtype anchors still verify those
              // exact declarations, so the base anchor contributes only
              // count/size/non-geometric style evidence.
              : expected.containingBlockOffsets === undefined
                && /(?:^|[-_.#])post-it(?:$|[-_.:# 0-9])/iu.test(expected.selector)
          )
        const containingBlockOffsetsUsable = positionedAnchor
          && expectedContainingBlockOffset != null
          && actualContainingBlockOffset != null
          // Intrinsic translated boxes serialize a used transform that changes
          // with replacement copy. Their established center/edge policies are
          // more authoritative than the transformed bounding-box gap.
          && (!(intrinsicBlockSize || intrinsicInlineSize) || !expectedStyles.transform || expectedStyles.transform === 'none')
        const positionToleranceX = Math.max(4 / expectedViewport.width, 0.01)
        const positionToleranceY = Math.max(4 / expectedViewport.height, 0.01)
        const relativeHorizontalPositionMatches = containingBlockOffsetsUsable
          ? explicitRightAnchor
            ? Math.abs(actualContainingBlockOffset.right - expectedContainingBlockOffset.right) <= positionToleranceX
            : Math.abs(actualContainingBlockOffset.left - expectedContainingBlockOffset.left) <= positionToleranceX
          : undefined
        const relativeVerticalPositionMatches = containingBlockOffsetsUsable
          ? explicitBottomAnchor
            ? Math.abs(actualContainingBlockOffset.bottom - expectedContainingBlockOffset.bottom) <= positionToleranceY
            : Math.abs(actualContainingBlockOffset.top - expectedContainingBlockOffset.top) <= positionToleranceY
          : undefined
        const horizontalPositionMatches = positionedDecorationWithStableInsets
          ? true
          : relativeHorizontalPositionMatches ?? (fixedSizeInFlow
          ? Math.abs(actualRect.x - expectedRect.x) <= Math.max(4 / expectedViewport.width, 0.01)
          : positionedIntrinsicInline && explicitLeftAnchor
            ? Math.abs(actualRect.x - expectedRect.x) <= Math.max(4 / expectedViewport.width, 0.01)
          : positionedIntrinsicInline && explicitRightAnchor
            ? Math.abs(
                (actualRect.x + actualRect.width) - (expectedRect.x + expectedRect.width),
              ) <= Math.max(4 / expectedViewport.width, 0.01)
          : positionedIntrinsicInline
            ? Math.min(
                Math.abs(actualRect.x - expectedRect.x),
                Math.abs(
                  (actualRect.x + actualRect.width) - (expectedRect.x + expectedRect.width),
                ),
              ) <= Math.max(4 / expectedViewport.width, 0.01)
          : fullyIntrinsicSize
            ? true
          : intrinsicInlineSize && !intrinsicTextChrome
            ? true
          : centeredIntrinsicTextChrome
            ? Math.abs(actualCenterX - expectedCenterX) <= Math.max(4 / expectedViewport.width, 0.01)
            : Math.abs(actualRect.x - expectedRect.x) <= Math.max(4 / expectedViewport.width, 0.01))
        const verticalPositionMatches = positionedDecorationWithStableInsets
          ? true
          : relativeVerticalPositionMatches ?? (fixedSizeInFlow || unpositionedIntrinsicFlowItem
          ? true
          : intrinsicBlockSize
            ? positionedIntrinsicBlock
            ? centeredIntrinsicBlock
              ? Math.abs(actualCenterY - expectedCenterY) <= Math.max(4 / expectedViewport.height, 0.01)
              : bottomAnchoredTextChrome || explicitBottomAnchor || inferredStableBottomAnchor
              ? Math.abs(actualBottom - expectedBottom) <= Math.max(4 / expectedViewport.height, 0.01)
              : fullyIntrinsicSize
                ? Math.min(
                    Math.abs(actualRect.y - expectedRect.y),
                    Math.abs(actualBottom - expectedBottom),
                  ) <= Math.max(4 / expectedViewport.height, 0.01)
              : Math.abs(actualRect.y - expectedRect.y) <= Math.max(4 / expectedViewport.height, 0.01)
            : fullyIntrinsicSize
              ? Math.min(
                Math.abs(actualRect.y - expectedRect.y),
                Math.abs(actualBottom - expectedBottom),
              ) <= Math.max(4 / expectedViewport.height, 0.01)
              : true
          : Math.abs(actualRect.y - expectedRect.y) <= Math.max(4 / expectedViewport.height, 0.01))
        check(
          horizontalPositionMatches && verticalPositionMatches,
          `render ${phase} ${expected.selector}[${index}] position expected ${renderedRectSummary(expectedRect)} but found ${renderedRectSummary(actualRect)}${renderedPositionRepairHint({
            expectedRect,
            actualRect,
            expectedStyles,
            actualStyles,
            viewport: expectedViewport,
            centeredIntrinsicBlock,
            explicitBottomAnchor,
            explicitRightAnchor,
            fullyIntrinsicSize,
            expectedContainingBlockOffset: containingBlockOffsetsUsable ? expectedContainingBlockOffset : undefined,
            actualContainingBlockOffset: containingBlockOffsetsUsable ? actualContainingBlockOffset : undefined,
            horizontalPositionMatches,
            verticalPositionMatches,
          })}`,
        )
      } else if (!pseudoGeometryUnavailable && intrinsicBlockSize) {
        check(
          Math.abs(actualRect.x - expectedRect.x) <= Math.max(4 / expectedViewport.width, 0.01),
          `render ${phase} ${expected.selector}[${index}] horizontal position expected ${renderedRectSummary(expectedRect)} but found ${renderedRectSummary(actualRect)}`,
        )
      }
      for (const [property, expectedValue] of Object.entries(expectedStyles)) {
        if (expected.authoredBox && ['top','right','bottom','left','width','height','max-width','max-height','min-width','min-height','grid-template-columns'].includes(property)) {
          check(actualStyles[property] === expectedValue,
            `render ${phase} ${expected.selector}[${index}] authored ${property} expected ${expectedValue} but found ${actualStyles[property] ?? 'missing'}`)
          continue
        }
        if (variableProgressFill && property === 'width') continue
        // `position:relative` in a template backed by an external custom
        // element and `position:absolute` in a self-contained replacement are
        // implementation details when the root occupies the same strict
        // viewport rect. The presentation-state invariant above independently
        // proves that exactly one active page owns the stage.
        if (runtimeManagedSlideRoot && ['position', 'transform'].includes(property)) continue
        // Computed width/height are used values, not authored CSS. Rect
        // geometry above already verifies fixed structure, while the static
        // source gate verifies the exact declarations. Comparing these used
        // strings again makes translated text look like template drift.
        if (['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height'].includes(property)) continue
        // For intrinsic positioned text, computed opposite-edge offsets and
        // inset are used values derived from the replacement copy's width or
        // height. Geometry above validates the stable authored edge; static
        // source verification validates any explicit anchor declarations.
        if ((intrinsicBlockSize || intrinsicInlineSize) && ['top', 'right', 'bottom', 'left', 'inset'].includes(property)) continue
        // Pseudo inset values are resolved against the host's replacement-copy
        // geometry and Chromium reports those used pixels, even though the
        // authored percentage/inset declaration is unchanged. Static source
        // verification owns these declarations; the host rect cannot provide
        // a valid pseudo box to disambiguate them here.
        if (pseudoGeometryUnavailable && ['top', 'right', 'bottom', 'left', 'inset'].includes(property)) continue
        if (intrinsicBlockSize && property === 'grid-template-rows') continue
        // `translateX(-50%)` is serialized by computed style as a pixel
        // matrix derived from the element's intrinsic text width. Static
        // source verification already proves the declaration is unchanged;
        // the center/bottom anchor check above proves the rendered effect.
        if ((intrinsicTextChrome || centeredIntrinsicBlock) && property === 'transform') continue
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
      // Hit-test ownership inside an unpainted text/flex wrapper depends on
      // where its localized glyphs happen to fall. It is not an occlusion
      // signal: the empty part of a runner legitimately resolves to the slide
      // behind it. Painted structural surfaces retain the strict probe below.
      if (!pseudoGeometryUnavailable && expectedOcclusion >= 0.4 && !intrinsicTextChrome && !intrinsicInlineSize) {
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
  const runtimeManagedFullViewportRoot = expectedAnchors.some((expected) => {
    if (!options.runtimeManagedSlideSelectors?.has(expected.selector)) return false
    const actual = actualBySelector.get(expected.selector)
    return Boolean(actual
      && expected.rects.some((rect) => rect.width >= 0.98 && rect.height >= 0.98)
      && actual.rects.some((rect) => rect.width >= 0.98 && rect.height >= 0.98))
  })
  for (let index = 0; index < overlaySamples; index += 1) {
    const expected = expectedPhase.overlayProbes[index]
    const actual = actualPhase.overlayProbes[index]
    check(actual.tag === expected.tag, `render ${phase} painted surface[${index}] tag expected ${expected.tag} but found ${actual.tag}`)
    check(Math.abs(actual.coverage - expected.coverage) <= 0.02, `render ${phase} painted surface[${index}] coverage expected ${expected.coverage} but found ${actual.coverage}`)
    for (const property of ['position', 'backgroundColor', 'backgroundImage', 'opacity', 'zIndex'] as const) {
      if (
        property === 'position'
        && runtimeManagedFullViewportRoot
        && expected.tag === actual.tag
        && expected.coverage >= 0.98
        && actual.coverage >= 0.98
      ) continue
      check(actual[property] === expected[property], `render ${phase} painted surface[${index}] ${property} expected "${expected[property]}" but found "${actual[property]}"`)
    }
  }
  // Preserve causal source/geometry diagnoses in the bounded per-interior
  // repair projection. Moving a fixed source element can also create several
  // text collisions; those symptoms must not displace the exact top/position
  // drift with instructions to shorten otherwise valid copy. Collision-only
  // defects still get the full diagnostic surface and always affect scoring.
  const textLayout = renderedTextLayoutFindings(expectedPhase.textLayout, actualPhase.textLayout)
  const textLayoutGaps = [...textLayout.defects, ...textLayout.observationGaps]
  check(textLayoutGaps.length === 0, `render ${phase} ${textLayoutGaps[0]}`)
  for (const gap of textLayoutGaps.slice(1)) check(false, `render ${phase} ${gap}`)
  const score = checked > 0 ? Math.round((matched / checked) * 1_000) / 10 : 0
  return {
    fidelity: violations.length === 0 ? 'pass' : 'mismatch',
    phase,
    checked,
    matched,
    score,
    violations,
    observationGapCount: textLayout.observationGaps.length,
    url,
    viewport: actualViewport,
    pageEpoch,
  }
}

function applyRenderedPresentationStageViolations(
  verification: BrowserRenderedReferenceStyleVerification,
  violations: readonly string[],
): void {
  if (violations.length === 0) return
  verification.checked += violations.length
  verification.score = Math.round((verification.matched / verification.checked) * 1_000) / 10
  verification.fidelity = 'mismatch'
  // Missing anchors and painted surfaces are downstream symptoms when the
  // selected slide itself is outside the viewport. Expose the causal stage
  // defect alone; a fresh verification after that repair will reveal any
  // independent styling mismatch without encouraging speculative edits.
  verification.violations = violations.slice(0, 64)
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

function halfHeightCenteredTransform(
  styles: Record<string, string>,
  rect: { height: number } | undefined,
  viewportHeight: number,
): boolean {
  if (!rect || styles.position !== 'absolute') return false
  const matrix = /^matrix\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/u.exec(styles.transform ?? '')
  if (!matrix) return false
  const [, a, b, c, d, translateX, translateY] = matrix.map(Number)
  if (![a, b, c, d, translateX, translateY].every(Number.isFinite)) return false
  if (Math.abs(a - 1) > 0.001 || Math.abs(b) > 0.001 || Math.abs(c) > 0.001 || Math.abs(d - 1) > 0.001) return false
  if (Math.abs(translateX) > 1) return false
  const usedHeight = rect.height * viewportHeight
  return usedHeight > 0 && Math.abs(translateY + usedHeight / 2) <= Math.max(1, usedHeight * 0.005)
}

function renderedRectSummary(rect: { x: number; y: number; width: number; height: number }): string {
  return `[${rect.x.toFixed(4)},${rect.y.toFixed(4)},${rect.width.toFixed(4)},${rect.height.toFixed(4)}]`
}

function renderedPositionRepairHint(options: {
  expectedRect: { x: number; y: number; width: number; height: number }
  actualRect: { x: number; y: number; width: number; height: number }
  expectedStyles: Record<string, string>
  actualStyles: Record<string, string>
  viewport: { width: number; height: number }
  centeredIntrinsicBlock: boolean
  explicitBottomAnchor: boolean
  explicitRightAnchor: boolean
  fullyIntrinsicSize: boolean
  expectedContainingBlockOffset?: RenderedReferenceContainingBlockOffsetProfile | null
  actualContainingBlockOffset?: RenderedReferenceContainingBlockOffsetProfile | null
  horizontalPositionMatches: boolean
  verticalPositionMatches: boolean
}): string {
  const {
    expectedRect,
    actualRect,
    expectedStyles,
    actualStyles,
    viewport,
    centeredIntrinsicBlock,
    explicitBottomAnchor,
    explicitRightAnchor,
    fullyIntrinsicSize,
    expectedContainingBlockOffset,
    actualContainingBlockOffset,
    horizontalPositionMatches,
    verticalPositionMatches,
  } = options
  if (!verticalPositionMatches) {
    const expectedTop = expectedRect.y
    const actualTop = actualRect.y
    const expectedBottom = expectedRect.y + expectedRect.height
    const actualBottom = actualRect.y + actualRect.height
    const inferredBottomAnchor = fullyIntrinsicSize
      && !centeredIntrinsicBlock
      && !explicitBottomAnchor
      && Math.abs(actualBottom - expectedBottom) < Math.abs(actualTop - expectedTop)
    const usesBottomEdge = explicitBottomAnchor || inferredBottomAnchor
    const expectedCoordinate = centeredIntrinsicBlock
      ? expectedRect.y + expectedRect.height / 2
      : usesBottomEdge
        ? expectedBottom
        : expectedTop
    const actualCoordinate = centeredIntrinsicBlock
      ? actualRect.y + actualRect.height / 2
      : usesBottomEdge
        ? actualBottom
        : actualTop
    const deltaPx = expectedContainingBlockOffset && actualContainingBlockOffset && !centeredIntrinsicBlock
      ? (explicitBottomAnchor
          ? -(actualContainingBlockOffset.bottom - expectedContainingBlockOffset.bottom)
          : actualContainingBlockOffset.top - expectedContainingBlockOffset.top) * viewport.height
      : (actualCoordinate - expectedCoordinate) * viewport.height
    const magnitude = Math.round(Math.abs(deltaPx) * 10) / 10
    const edge = centeredIntrinsicBlock ? 'vertical center' : usesBottomEdge ? 'bottom edge' : 'top edge'
    const direction = deltaPx < 0 ? 'too high' : 'too low'
    const anchorProperty = centeredIntrinsicBlock ? undefined : usesBottomEdge ? 'bottom' : 'top'
    const expectedAnchor = anchorProperty ? expectedStyles[anchorProperty] : undefined
    const actualAnchor = anchorProperty ? actualStyles[anchorProperty] : undefined
    const expectedMargin = expectedStyles.margin
    const actualMargin = actualStyles.margin
    if (anchorProperty && expectedAnchor && expectedAnchor === actualAnchor) {
      const margin = expectedMargin !== undefined && actualMargin !== undefined && expectedMargin !== actualMargin
        ? `; computed margin expected "${expectedMargin}" but found "${actualMargin}"`
        : ''
      return `; candidate ${edge} is ${magnitude}px ${direction}. Computed ${anchorProperty} already matches "${expectedAnchor}"${margin}; preserve that anchor and fix the differing box-model or semantic-tag default instead.`
    }
    if (anchorProperty && expectedAnchor && actualAnchor) {
      const adjustment = usesBottomEdge
        ? deltaPx < 0 ? 'decrease' : 'increase'
        : deltaPx < 0 ? 'increase' : 'decrease'
      return `; candidate ${edge} is ${magnitude}px ${direction}. ${anchorProperty} expected "${expectedAnchor}" but found "${actualAnchor}"; ${adjustment} the candidate ${anchorProperty} to move it ${deltaPx < 0 ? 'down' : 'up'}.`
    }
    return `; candidate ${edge} is ${magnitude}px ${direction}. Coordinates use the viewport top-left origin, so move it ${deltaPx < 0 ? 'down' : 'up'}; do not invert the y direction.`
  }
  if (!horizontalPositionMatches) {
    const deltaPx = expectedContainingBlockOffset && actualContainingBlockOffset
      ? (explicitRightAnchor
          ? -(actualContainingBlockOffset.right - expectedContainingBlockOffset.right)
          : actualContainingBlockOffset.left - expectedContainingBlockOffset.left) * viewport.width
      : (actualRect.x - expectedRect.x) * viewport.width
    const magnitude = Math.round(Math.abs(deltaPx) * 10) / 10
    return `; candidate left edge is ${magnitude}px too far ${deltaPx < 0 ? 'left' : 'right'}; move it ${deltaPx < 0 ? 'right' : 'left'}.`
  }
  return ''
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
