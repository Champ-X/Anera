import { createHash } from 'node:crypto'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { normalizeReferenceTemplateCatalog, normalizeReferenceTemplateRuntimeEvidence, projectReferenceTemplateLayouts } from './reference-template.js'
import { normalizeReferenceLanguageVariant, type ReferenceLanguageVariant } from './reference-language.js'
import { normalizeRenderedTextLayout, type RenderedTextLayout } from './rendered-text-layout.js'
import type { ModelMessage, ToolCallRecord } from '../shared/types.js'
import {
  normalizeReferenceFontEvidenceManifest,
  normalizeReferenceVisualEvidenceManifest,
} from './session-store.js'
import type { ReferenceFontEvidenceManifest, ReferenceVisualEvidenceManifest } from './session-store.js'

export type ReferenceStrictness = 'exact' | 'inspired'

export interface ReferenceStyleContract {
  sourceUrl: string
  strictness: ReferenceStrictness
  colors: string[]
  fonts: string[]
  layout: string[]
  components: string[]
  requiredMarkers: string[]
  signature: string
  avoid: string[]
  viewport: { width: number; height: number }
}

export interface ReferenceStyleProvenance {
  resolvedUrl: string
  evidenceSha256: string
  evidenceBytes: number
}

export interface ReferenceStyleDeclarationProfile {
  property: string
  value: string
}

export interface ReferenceStyleRuleProfile {
  selector: string
  declarations: ReferenceStyleDeclarationProfile[]
  /** Core reference chrome/decorations must remain present in the rendered DOM. */
  requiredInDom: boolean
  /** Simplified source-cascade result used to reject local font overrides. */
  effectiveFontFamily?: string
}

export interface ReferenceStyleInlineVariantProfile {
  property: string
  values: string[]
}

export interface ReferenceStyleDomProfile {
  className: string
  occurrences: number
  required: boolean
  inlineStyleVariants?: ReferenceStyleInlineVariantProfile[]
}

/**
 * A bounded, deterministic fingerprint extracted from the retrieved source.
 * It deliberately records CSS variables verbatim (for example
 * `var(--accent-light)`) so two palette-compatible but structurally different
 * treatments do not collapse to the same global-token score.
 */
export interface ReferenceStyleSourceProfile {
  version: 1
  rules: ReferenceStyleRuleProfile[]
  dom: ReferenceStyleDomProfile[]
  bodyFontFamily?: string
  headingFontFamily?: string
}

export type ReferenceRenderPhase = 'cover' | 'content' | 'closing'

export type ReferenceRenderGeometryPolicy =
  | 'strict'
  | 'size'
  | 'flow-size'
  | 'intrinsic-block'
  | 'intrinsic-block-center'
  | 'intrinsic-inline'
  | 'intrinsic-size'

export interface RenderedReferenceRectProfile {
  /** Viewport-normalized coordinates, retained with bounded precision. */
  x: number
  y: number
  width: number
  height: number
}

export interface RenderedReferenceContainingBlockOffsetProfile {
  /** Viewport-normalized gaps between a positioned box and its offset parent. */
  left: number
  top: number
  right: number
  bottom: number
}

export interface RenderedReferenceAnchorProfile {
  selector: string
  count: number
  geometry: ReferenceRenderGeometryPolicy
  /** Source Browser CSS Typed OM retains auto dimensions and authored insets. */
  authoredBox?: true
  rects: RenderedReferenceRectProfile[]
  /**
   * Relative geometry for positioned, non-pseudo anchors. Optional for
   * compatibility with version-1 profiles captured before this evidence was
   * available; null denotes a sample without a usable containing block.
   */
  containingBlockOffsets?: Array<RenderedReferenceContainingBlockOffsetProfile | null>
  styles: Array<Record<string, string>>
  /** Fraction of five viewport samples whose topmost element belongs to the anchor. */
  occlusion: number[]
}

export interface RenderedReferenceOverlayProbe {
  tag: string
  coverage: number
  position: string
  backgroundColor: string
  backgroundImage: string
  opacity: string
  zIndex: string
}

export interface RenderedReferenceTypographyProbe {
  /** Semantic selector measured inside the active slide; text is never fingerprinted. */
  selector: string
  styles: Record<string, string>
}

export interface RenderedReferencePhaseProfile {
  anchors: RenderedReferenceAnchorProfile[]
  /** Painted elements occupying at least half the viewport, including anchor descendants. */
  overlayProbes: RenderedReferenceOverlayProbe[]
  /** Content-independent computed typography hierarchy for the active phase. */
  typographyProbes?: RenderedReferenceTypographyProbe[]
  /** Cross-block text intersections, captured separately from enclosing boxes. */
  textLayout?: RenderedTextLayout
}

/**
 * One real interior slide-variant grammar captured from the reference deck.
 * The selector is intentionally retained instead of a slide index: an exact
 * candidate may reduce or reorder the reference deck, but it may not invent a
 * layout whose rendered structure was never present in the reference.
 */
export interface RenderedReferenceLayoutVariantProfile {
  layoutSelector: string
  profile: RenderedReferencePhaseProfile
}

/**
 * Bounded browser-derived fingerprint of the real reference source. Unlike
 * the static source profile, this records the final cascade, geometry, and
 * effective visibility at the exact contract viewport.
 */
export interface RenderedReferenceStyleProfile {
  version: 1
  evidenceSha256: string
  viewport: { width: number; height: number }
  phases: Record<ReferenceRenderPhase, RenderedReferencePhaseProfile>
  /**
   * Browser-observed selectors that remain visible in every sampled phase and
   * interior layout. References without shared chrome legitimately omit this.
   */
  sharedAnchorSelectors?: string[]
  /** Bounded library of the reference deck's real interior layout variants. */
  interiorVariants?: RenderedReferenceLayoutVariantProfile[]
}

export interface RenderedReferenceInteriorSlideAttestation {
  slideIndex: number
  layoutSelector?: string
  matchedVariant?: string
  fidelity: 'pass' | 'mismatch'
  score: number
}

export interface RenderedReferenceInteriorAttestation {
  candidateSlides: number
  matchedSlides: number
  referenceVariants: number
  slides: RenderedReferenceInteriorSlideAttestation[]
}

export interface RenderedReferenceStyleVerification {
  fidelity: 'pass' | 'mismatch'
  phase: ReferenceRenderPhase
  checked: number
  matched: number
  score: number
  violations: string[]
  /** Full check count, not inferred from the bounded diagnostic strings. */
  observationGapCount?: number
  url: string
  viewport: { width: number; height: number } | null
  /** Present on the content phase when the profile has interior variants. */
  interiorAttestation?: RenderedReferenceInteriorAttestation
  /** Supplemental visibility probes, never pixel-fidelity or all-size proof. */
  surfaceAttestations?: RenderedReferenceSurfaceAttestation[]
}

export interface RenderedReferenceSurfaceAttestation {
  surface: 'compact-stage-v1'
  controlOcclusion?: import('./rendered-control-occlusion.js').RenderedControlOcclusion
  phase: string
  viewport: { width: number; height: number }
  activeIndex: number
  activeRect?: [number, number, number, number]
  checked: number
  matched: number
  observationGaps: number
  restored: boolean
  violations: string[]
}

export interface DurableReferenceStyleContract {
  contract: ReferenceStyleContract
  provenance: ReferenceStyleProvenance
  sourceProfile?: ReferenceStyleSourceProfile
  renderProfile?: RenderedReferenceStyleProfile
  /** Path-free identity of the private, materialized fonts used by exact renders. */
  fontEvidence?: ReferenceFontEvidenceManifest
  /** Server-private, path-free identity of the immutable reference renders. */
  visualEvidence?: ReferenceVisualEvidenceManifest
  /** Source-derived content slots, never a replacement for the recorded source bytes. */
  templateCatalog?: import('./reference-template.js').ReferenceTemplateCatalog
  runtimeEvidence?: import('./reference-template.js').ReferenceTemplateRuntimeEvidence
  /** Author-documented, source-hash-bound text-role adaptation; never a new theme. */
  languageVariant?: ReferenceLanguageVariant
}

export interface ReferenceStyleEvidence {
  call: ToolCallRecord
  /** All source fetch calls, ordered by chunk index. */
  callIds: string[]
  callMessageIndex: number
  resultMessageIndex: number
  requestedUrl: string
  resolvedUrl: string
  content: string
  sha256: string
  bytes: number
}

export interface ReferenceStyleEvidenceContinuation {
  readonly url: string
  readonly format: 'markdown' | 'raw'
  readonly nextChunkIndex: number
  readonly totalChunks?: number
  /** Source chunks that must remain available until this chain completes. */
  readonly callIds: readonly string[]
}

// Persisted verdicts are evidence from one implementation, not timeless facts.
// Bump when source/cascade semantics change so resumed runs recheck the bytes.
export const REFERENCE_STYLE_VERIFIER_REVISION = 'source-layout-palette-v3'

// Browser verdicts have their own freshness boundary: a source-only pass
// cannot attest checks added to the rendered phase after a process restart.
export const RENDERED_REFERENCE_VERIFIER_REVISION = 'render-layout-surfaces-v5'

export function referenceTextLayoutRequiresUpgrade(profile: RenderedReferenceStyleProfile | undefined): boolean {
  return Boolean(profile && [
    ...Object.values(profile.phases),
    ...(profile.interiorVariants ?? []).map((variant) => variant.profile),
  ].some((phase) => phase.textLayout?.version !== 2))
}

export interface ReferenceStyleVerification {
  verifier_revision: string
  fidelity: 'pass' | 'mismatch'
  score: number
  matched: {
    colors: string[]
    fonts: string[]
    markers: string[]
  }
  missing: {
    colors: string[]
    fonts: string[]
    markers: string[]
  }
  violations: {
    colors: string[]
    fonts: string[]
    avoid: string[]
    source: string[]
  }
  /**
   * Structured, set-level diagnostics for inline values copied from the
   * reference. A reference may intentionally use more than one value for the
   * same class/property (for example two visible `.mono` opacity variants).
   * Those values are simultaneous requirements, not repair alternatives.
   */
  inlineVariantGaps: ReferenceStyleInlineVariantGap[]
  /** Source colors used exclusively by unselected, Browser-attested layouts. */
  omittedAlternativeLayoutColors?: string[]
  thresholds: {
    colors: number
    fonts: number
    markers: number
  }
}

export interface ReferenceStyleInlineVariantGap {
  className: string
  property: string
  required: string[]
  current: string[]
  missing: string[]
}

export interface ReferenceStyleVerificationOptions {
  /**
   * A compact model-authored palette is positive fidelity evidence, not an
   * exhaustive source-color allowlist. Once immutable browser evidence is
   * bound, additional colors are judged by the rendered comparison instead
   * of making a source with more than the bounded palette impossible to copy.
   */
  authoritativeRenderedReference?: boolean
  /**
   * Browser-captured interior roots form an alternative layout library. A
   * shorter adapted deck must choose one real variant per interior slide, but
   * it must not stack or instantiate every reference variant simultaneously.
   */
  alternativeLayoutSelectors?: readonly string[]
  /** Private raw source, recovered and hash-bound to the durable contract by the caller. */
  boundTemplateSource?: ReferenceStyleEvidence
  /**
   * Immutable Browser-observed presentation roots whose base CSS may be
   * adapted from an external deck controller to a self-contained runtime.
   * Static verification still checks their visual declarations; only
   * interaction-state mechanics are deferred to Browser geometry/state
   * attestation.
   */
  runtimeManagedSlideSelectors?: readonly string[]
}

/**
 * Contract-supplied exact tokens that could not be proven by a visual CSS rule
 * connected to the retrieved DOM. The API intentionally returns only rejected
 * contract values (never source excerpts or discovered source tokens), and is
 * unavailable when the contract/evidence URLs are unrelated.
 */
export interface ReferenceStyleGroundingGaps {
  colors: string[]
  fonts: string[]
  markers: string[]
}

export interface ReferenceStyleEvidenceNormalization {
  contract: ReferenceStyleContract
  /** Exact source-declared colors omitted because no DOM-connected rule consumes them. */
  omittedVisuallyInertColors: string[]
}

const STYLE_PROPERTY_PATTERN = /(?:font-family|background(?:-color)?|border-radius|box-shadow|grid-template|clip-path|letter-spacing|line-height|--[a-z][\w-]*\s*:|\b(?:colors?|typography|components?|palette|layout|radii)\s*:)/giu
const STYLE_COLOR_PATTERN = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\([^)]{3,80}\)/giu
// Evidence parsing is independent of the compact profile's property/size
// budget. Only paint values can prove a color: a string in content, a URL,
// an unknown property or an unused custom property cannot paint that token.
const CSS_PAINT_PROPERTY = /^(?:color|background(?:-color|-image)?|(?:border|border-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)(?:-color)?|border-image(?:-source)?|outline(?:-color)?|(?:box|text)-shadow|text-decoration(?:-color)?|text-emphasis(?:-color)?|column-rule(?:-color)?|caret(?:-color)?|accent-color|fill|stroke|(?:stop|flood|lighting)-color|filter|backdrop-filter|-webkit-text-(?:fill|stroke)-color)$/u

function paintValue(value: string): string {
  return value.replace(/url\((?:[^()"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/giu, '')
}
const STYLE_FONT_PATTERN = /(?:font-family\s*:|fontFamily\s*:|typeface|fonts?\s*:|Space Grotesk|Inter|Noto Sans|Noto Serif|Helvetica|Arial|Georgia|Roboto|Montserrat|Poppins)/giu

const SOURCE_PROFILE_MAX_RULES = 64
const SOURCE_PROFILE_MAX_DECLARATIONS = 16
const SOURCE_PROFILE_MAX_DOM_CLASSES = 64
const SOURCE_PROFILE_MAX_INLINE_PROPERTIES = 8
const SOURCE_PROFILE_MAX_INLINE_VALUES = 12
const SOURCE_PROFILE_MAX_BYTES = 12 * 1_024
// Eight real interior variants in the ten-slide blue-professional reference
// require more room than the historical single-content-page fingerprint. The
// full value never enters repeated provider context; only the bounded compact
// attestation below is projected.
const RENDER_PROFILE_MAX_BYTES = 160 * 1_024
const RENDER_PROFILE_MAX_ANCHORS_PER_PHASE = 48
const RENDER_PROFILE_MAX_LAYOUT_VARIANTS = 16
const RENDER_PROFILE_MAX_ANCHORS_PER_VARIANT = 20
const RENDER_PROFILE_MAX_SHARED_ANCHOR_SELECTORS = 8
const RENDER_PROFILE_MAX_INSTANCES_PER_ANCHOR = 12
const RENDER_PROFILE_MAX_STYLE_PROPERTIES = 24
const RENDER_PROFILE_MAX_OVERLAY_PROBES = 12
const RENDER_PROFILE_MAX_TYPOGRAPHY_PROBES = 8
const RENDER_PROFILE_STYLE_PROPERTIES = new Set([
  'align-items', 'background', 'background-color', 'border', 'border-color',
  'border-radius', 'border-style', 'border-width', 'bottom', 'box-shadow',
  'clip-path', 'color', 'column-gap', 'display', 'font-family', 'font-size',
  'font-weight', 'gap', 'grid-template-columns', 'grid-template-rows', 'height',
  'inset', 'justify-content', 'left', 'letter-spacing', 'line-height', 'margin',
  'max-height', 'max-width', 'min-height', 'min-width', 'opacity', 'overflow',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'pointer-events', 'position', 'right', 'row-gap', 'text-align',
  'text-transform', 'top', 'transform', 'visibility', 'width', 'flex-direction',
  'flex-wrap', 'background-image',
])
const SOURCE_PROFILE_PROPERTIES = new Set([
  'background', 'background-color', 'color', 'font-family', 'font-size', 'font-weight',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'top', 'right', 'bottom', 'left', 'inset', 'display', 'visibility', 'position', 'opacity', 'gap',
  'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows',
  'border', 'border-width', 'border-color', 'border-style', 'border-radius',
  'clip-path', 'box-shadow', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'transform', 'overflow',
  'align-items', 'justify-content', 'text-align', 'text-transform', 'letter-spacing',
])
const SOURCE_PROFILE_PROPERTY_PRIORITY = [
  'background', 'background-color', 'color', 'font-family', 'width', 'height',
  'top', 'right', 'bottom', 'left', 'inset', 'position', 'display', 'visibility', 'opacity', 'gap',
  'grid-template-columns', 'border', 'border-radius', 'clip-path', 'box-shadow',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'transform', 'font-size', 'font-weight', 'letter-spacing',
  'min-width', 'max-width', 'min-height', 'max-height', 'row-gap', 'column-gap',
  'grid-template-rows', 'border-width', 'border-color', 'border-style', 'overflow',
  'align-items', 'justify-content', 'text-align', 'text-transform',
] as const
const CORE_REFERENCE_SELECTOR_PATTERN = /(?:^|[-_.#])(?:accent|dots?|keyboard|nav(?:igation)?|progress|counter|pager|controls?|chrome|footer|header|hint)(?:$|[-_.:#])/iu
const SOURCE_PROFILE_INLINE_PROPERTIES = new Set(['opacity'])
const VISUAL_COMPONENT_SELECTOR_PATTERN = /(?:^|[-_.#])(?:metric|bar|split|step|hero|stripe|tile|label|card|panel|track|badge|quote|timeline|chart|stat)(?:$|[-_.:#])/iu
const ROOT_VISUAL_TAG_SELECTOR_PATTERN = /^(?::root|html|body)(?:::(?:before|after))?$/iu
const SEMANTIC_TYPOGRAPHY_TAG_SELECTOR_PATTERN = /^(?:h[1-6]|p|li|blockquote|small|strong|em)$/iu
const TYPOGRAPHY_SELECTOR_PATTERN = /(?:^|[\s>+~])(?:h[1-6]|p|li|blockquote|small|strong|em)(?:$|[.#:[\s>+~])/iu
const STRUCTURAL_LAYOUT_PROPERTIES = new Set([
  'display', 'grid-template-columns', 'grid-template-rows', 'gap', 'row-gap', 'column-gap',
  'align-items', 'justify-content', 'position', 'width', 'height', 'min-width', 'min-height',
])
const STRUCTURAL_REFERENCE_MARKERS = new Set([
  'clip-path', 'grid-template', 'grid-template-columns', 'grid-template-rows',
])
const RUNTIME_MANAGED_SLIDE_SOURCE_PROPERTIES = new Set([
  'display', 'opacity', 'position', 'visibility',
])
const RENDER_PHASE_STRUCTURAL_ROOT_SELECTOR_PATTERN = /^(?:\.slide-header|\.(?!(?:(?:slide|active|prev|current|visible|hidden|entering|leaving)|(?:nav|progress|counter|keyboard|hint|chrome|runner|footer|topbar|top-bar|slide-meta)(?:[-_][\w-]*)?|cover-dots?|closing-decoration|accent-(?:line|dot))$)[a-z_][\w-]*)$/iu
const STANDARD_HTML_SELECTOR_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'blockquote', 'body', 'button',
  'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'dd', 'del', 'details',
  'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'html', 'i',
  'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'main', 'mark', 'menu',
  'meter', 'nav', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre',
  'progress', 'q', 's', 'samp', 'section', 'select', 'slot', 'small', 'source', 'span',
  'strong', 'sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea',
  'tfoot', 'th', 'thead', 'time', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
])

export function normalizeReferenceStyleContract(value: unknown): ReferenceStyleContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reference style contract must be an object')
  const input = value as Record<string, unknown>
  const sourceUrl = requiredBoundedString(input.source_url ?? input.sourceUrl, 'source_url', 2_000)
  try { new URL(sourceUrl) } catch { throw new Error('source_url must be an absolute URL') }
  const strictness = input.strictness === 'inspired' ? 'inspired' : input.strictness === 'exact' ? 'exact' : undefined
  if (!strictness) throw new Error('strictness must be exact or inspired')
  const viewportInput = input.viewport
  if (!viewportInput || typeof viewportInput !== 'object' || Array.isArray(viewportInput)) {
    throw new Error('viewport must be an object')
  }
  const width = Number((viewportInput as Record<string, unknown>).width)
  const height = Number((viewportInput as Record<string, unknown>).height)
  if (!Number.isInteger(width) || width < 800 || width > 2_560) throw new Error('viewport.width must be an integer between 800 and 2560')
  if (!Number.isInteger(height) || height < 450 || height > 1_440) throw new Error('viewport.height must be an integer between 450 and 1440')
  const colors = boundedColorStringArray(input.colors, 'colors', 2, 12, 180)
  const fonts = boundedNormalizedStringArray(input.fonts, 'fonts', 1, 5, 220, normalizeContractFont)
  const requiredMarkers = boundedNormalizedStringArray(
    input.required_markers ?? input.requiredMarkers,
    'required_markers',
    2,
    10,
    300,
    normalizeReferenceContractMarker,
  )
  const distinctiveMarkers = requiredMarkers.filter(referenceContractMarkerIsDistinctive)
  if (distinctiveMarkers.length < Math.min(2, requiredMarkers.length)) {
    throw new Error('required_markers must include at least two distinctive source selectors, variables, or layout declarations')
  }
  return {
    sourceUrl,
    strictness,
    colors,
    fonts,
    layout: boundedStringArray(input.layout, 'layout', 2, 8, 300),
    components: boundedStringArray(input.components, 'components', 2, 10, 300),
    requiredMarkers,
    signature: requiredBoundedString(input.signature, 'signature', 600),
    avoid: boundedStringArray(input.avoid, 'avoid', 1, 8, 240),
    viewport: { width, height },
  }
}

/** Build a compact source fingerprint from real HTML/CSS evidence, never from model prose. */
export function extractReferenceStyleSourceProfile(
  content: string,
  contract: ReferenceStyleContract,
): ReferenceStyleSourceProfile | undefined {
  const cssRules = mergeCssRules(extractCssRules(content, contract.viewport))
  const sourceDom = extractDomSnapshot(content)
  if (cssRules.length === 0 || (sourceDom.classes.size === 0 && sourceDom.ids.size === 0)) return undefined

  const bodyFontFamily = globalFontFamily(cssRules, ['body']) ?? globalFontFamily(cssRules, ['html'])
  const headingFontFamily = globalFontFamily(cssRules, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
  const markerIdentifiers = new Set(contract.requiredMarkers.flatMap(selectorIdentifiers))
  const relevanceWords = new Set(
    [
      ...contract.requiredMarkers,
      ...contract.layout,
      ...contract.components,
      contract.signature,
    ].join(' ').toLowerCase().match(/[a-z][\w-]{2,}/gu) ?? [],
  )
  const relevanceSurface = [
    ...contract.requiredMarkers,
    ...contract.layout,
    ...contract.components,
    contract.signature,
  ].join(' ').toLowerCase()
  const contractPalette = new Set(contract.colors.map(normalizeCssColorToken))

  const ranked = cssRules.flatMap((rule, order) => {
    if (rule.selector.length > 240) return []
    const identifiers = selectorIdentifiers(rule.selector)
    const rootVisualTag = ROOT_VISUAL_TAG_SELECTOR_PATTERN.test(rule.selector)
    const semanticTypographyTag = SEMANTIC_TYPOGRAPHY_TAG_SELECTOR_PATTERN.test(rule.selector)
    const tagOnlyVisualRule = rootVisualTag || semanticTypographyTag
    if ((!tagOnlyVisualRule && identifiers.length === 0)
      || (!tagOnlyVisualRule && !selectorIdentifiersShareRelationship(rule.selector, sourceDom))) return []
    const declarations = prioritizedProfileDeclarations(rule.declarations)
    if (declarations.length === 0) return []
    const directContractPaletteColors = new Set(declarations.flatMap((declaration) => (
      (declaration.value.match(STYLE_COLOR_PATTERN) ?? [])
        .map(normalizeCssColorToken)
        .filter((color) => contractPalette.has(color))
    )))
    const selectorTerminal = terminalSelectorIdentifier(rule.selector)
    const markerMatch = (identifiers.length === 1 && selectorTerminal === identifiers[0] && markerIdentifiers.has(identifiers[0]))
      || contract.requiredMarkers.some((marker) => normalizeCssSelector(marker) === rule.selector)
    const phaseDecoration = Boolean(selectorTerminal
      && /^\.(?:cover|closing)-(?:decoration|dots?)(?:-|$)/iu.test(selectorTerminal))
    const phasePseudoDecoration = identifiers.length === 1
      && /^\.layout-(?:cover|closing)$/iu.test(identifiers[0])
      && /::(?:before|after)\b/iu.test(rule.selector)
    const requiredInDom = tagOnlyVisualRule
      || markerMatch
      || Boolean(selectorTerminal && CORE_REFERENCE_SELECTOR_PATTERN.test(selectorTerminal))
      || phaseDecoration
      || phasePseudoDecoration
      || /^(?:\.layout-)?(?:cover|closing)$/iu.test(rule.selector)
      || /^(?:\.slide|\.slide\.active)$/iu.test(rule.selector)
    const selectorWords = rule.selector.match(/[a-z][\w-]{2,}/giu)?.map((word) => word.toLowerCase()) ?? []
    const relevance = selectorWords.filter((word) => relevanceWords.has(word)).length
    const terminalIdentifier = selectorTerminal?.slice(1) ?? identifiers.at(-1)?.slice(1)
    const explicitlyMentioned = Boolean(terminalIdentifier && relevanceSurface.includes(terminalIdentifier))
    const geometryRole = Boolean(terminalIdentifier && /(?:^|-)(?:label|track|highlight|circle|dots?|decoration|line)$/iu.test(terminalIdentifier))
    const markerComponentGeometry = geometryRole
      && identifiers.slice(0, -1).some((identifier) => markerIdentifiers.has(identifier))
    const inlineVariantCount = identifiers.reduce((total, identifier) => {
      if (!identifier.startsWith('.')) return total
      return total + (sourceDom.classes.get(identifier.slice(1))?.inline.size ?? 0)
    }, 0)
    const salience = declarations.reduce((total, declaration) => (
      total + (['background', 'background-color', 'clip-path', 'box-shadow', 'position', 'opacity', 'border-radius'].includes(declaration.property) ? 2 : 1)
    ), 0)
    const structuralDeclarationCount = declarations.filter((declaration) => STRUCTURAL_LAYOUT_PROPERTIES.has(declaration.property)).length
    const interiorLayoutRule = identifiers.length > 0
      && structuralDeclarationCount >= 2
      && (
        /(?:^|[-_.#])layout-[\w-]+(?:$|[-_.:# ])/iu.test(rule.selector)
        || declarations.some((declaration) => declaration.property === 'grid-template-columns' || declaration.property === 'grid-template-rows')
        || declarations.some((declaration) => declaration.property === 'display' && /^(?:grid|flex|inline-grid|inline-flex)$/u.test(declaration.value))
      )
    const phaseInteriorStructure = interiorLayoutRule
      && identifiers.length > 1
      && identifiers.some((identifier) => /^\.layout-[\w-]+$/u.test(identifier))
    const contextualTypography = identifiers.length > 0 && TYPOGRAPHY_SELECTOR_PATTERN.test(rule.selector)
    const score = (requiredInDom ? 100 : 0)
      + (rootVisualTag ? 240 : 0)
      + (semanticTypographyTag ? 170 : 0)
      + (interiorLayoutRule ? 300 + structuralDeclarationCount * 6 : 0)
      + (phaseInteriorStructure ? 220 : 0)
      + (contextualTypography ? 90 : 0)
      // Keep at least the visible carrier rules for compact exact-palette
      // tokens—especially positive/negative status colors—inside the bounded
      // source profile. Without this, a later verifier can name a missing
      // color but cannot ground the selector/state needed for a faithful fix.
      + directContractPaletteColors.size * 500
      + Number(markerMatch) * 80
      + (VISUAL_COMPONENT_SELECTOR_PATTERN.test(rule.selector) ? 30 : 0)
      + (explicitlyMentioned ? 50 : 0)
      + (geometryRole ? 35 : 0)
      + (markerComponentGeometry ? 100 : 0)
      + relevance * 12
      + salience
      + inlineVariantCount * 5
      + (/::|:hover|:focus|:active/iu.test(rule.selector) ? 4 : 0)
    const ownFont = rule.declarations.get('font-family')
    const effectiveFontFamily = ownFont
      ?? (selectorTargetsHeading(rule.selector) ? headingFontFamily ?? bodyFontFamily : bodyFontFamily)
    return [{
      order,
      score,
      paletteColors: [...directContractPaletteColors],
      profile: {
        selector: rule.selector,
        declarations,
        requiredInDom,
        ...(effectiveFontFamily ? { effectiveFontFamily } : {}),
      } satisfies ReferenceStyleRuleProfile,
    }]
  })

  ranked.sort((left, right) => right.score - left.score || left.order - right.order || left.profile.selector.localeCompare(right.profile.selector))
  // Preserve one real DOM-connected carrier for every exact palette token that
  // appears directly in a rule. These selectors are often optional content
  // states (for example positive/negative metric deltas), so treating only
  // required chrome as durable would discard the evidence needed to reproduce
  // those colors faithfully once the compact profile reaches its byte cap.
  const coveredPaletteColors = new Set<string>()
  const paletteCarriers = ranked.filter((entry) => {
    if (!entry.paletteColors.some((color) => !coveredPaletteColors.has(color))) return false
    for (const color of entry.paletteColors) coveredPaletteColors.add(color)
    return true
  })
  const paletteCarrierSelectors = new Set(paletteCarriers.map((entry) => entry.profile.selector))
  const selected = [
    ...paletteCarriers,
    ...ranked.filter((entry) => !paletteCarrierSelectors.has(entry.profile.selector)),
  ].slice(0, SOURCE_PROFILE_MAX_RULES)
  const rules = selected.map((entry) => entry.profile)
  if (rules.length === 0) return undefined

  const requiredClasses = new Set<string>()
  const selectedClasses = new Set<string>()
  for (const rule of rules) {
    for (const identifier of selectorIdentifiers(rule.selector)) {
      if (!identifier.startsWith('.')) continue
      const className = identifier.slice(1)
      if (className.length > 100) continue
      selectedClasses.add(className)
      if (rule.requiredInDom) requiredClasses.add(className)
    }
  }
  const dom = [...selectedClasses]
    .map((className) => {
      const usage = sourceDom.classes.get(className)
      if (!usage) return undefined
      const inlineStyleVariants = [...usage.inline]
        .filter(([property]) => SOURCE_PROFILE_INLINE_PROPERTIES.has(property))
        .sort(([left], [right]) => profilePropertyRank(left) - profilePropertyRank(right) || left.localeCompare(right))
        .slice(0, SOURCE_PROFILE_MAX_INLINE_PROPERTIES)
        .map(([property, values]) => ({
          property,
          values: [...values].slice(0, SOURCE_PROFILE_MAX_INLINE_VALUES),
        }))
      const required = requiredClasses.has(className)
      if (!required && inlineStyleVariants.length === 0) return undefined
      return {
        className,
        occurrences: usage.count,
        required,
        ...(inlineStyleVariants.length > 0 ? { inlineStyleVariants } : {}),
      } satisfies ReferenceStyleDomProfile
    })
    .filter((entry): entry is ReferenceStyleDomProfile => Boolean(entry))
    .sort((left, right) => Number(right.required) - Number(left.required) || left.className.localeCompare(right.className))
    .slice(0, SOURCE_PROFILE_MAX_DOM_CLASSES)

  return normalizeReferenceStyleSourceProfile(boundGeneratedSourceProfile({
    version: 1,
    rules,
    dom,
    ...(bodyFontFamily ? { bodyFontFamily } : {}),
    ...(headingFontFamily ? { headingFontFamily } : {}),
  }, paletteCarrierSelectors))
}

/** Validate persisted source profiles while retaining compatibility with records that predate them. */
export function normalizeReferenceStyleSourceProfile(value: unknown): ReferenceStyleSourceProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('source_profile must be an object')
  let serialized: string
  try { serialized = JSON.stringify(value) } catch { throw new Error('source_profile must be JSON-serializable') }
  if (Buffer.byteLength(serialized) > SOURCE_PROFILE_MAX_BYTES) {
    throw new Error(`source_profile exceeds the ${SOURCE_PROFILE_MAX_BYTES}-byte budget`)
  }
  const input = value as Record<string, unknown>
  if (input.version !== 1) throw new Error('source_profile.version must be 1')
  if (!Array.isArray(input.rules) || input.rules.length < 1 || input.rules.length > SOURCE_PROFILE_MAX_RULES) {
    throw new Error(`source_profile.rules must contain between 1 and ${SOURCE_PROFILE_MAX_RULES} entries`)
  }
  const seenSelectors = new Set<string>()
  const rules = input.rules.map((rawRule, index) => {
    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) throw new Error(`source_profile.rules[${index}] must be an object`)
    const rule = rawRule as Record<string, unknown>
    const selector = normalizeCssSelector(requiredBoundedString(rule.selector, `source_profile.rules[${index}].selector`, 240))
    if (!selector || (selectorIdentifiers(selector).length === 0
      && !ROOT_VISUAL_TAG_SELECTOR_PATTERN.test(selector)
      && !SEMANTIC_TYPOGRAPHY_TAG_SELECTOR_PATTERN.test(selector))) {
      throw new Error(`source_profile.rules[${index}].selector must contain a class/id or an approved visual tag`)
    }
    if (seenSelectors.has(selector)) throw new Error(`source_profile contains duplicate selector ${selector}`)
    seenSelectors.add(selector)
    if (!Array.isArray(rule.declarations) || rule.declarations.length < 1 || rule.declarations.length > SOURCE_PROFILE_MAX_DECLARATIONS) {
      throw new Error(`source_profile.rules[${index}].declarations is out of bounds`)
    }
    const seenProperties = new Set<string>()
    const declarations = rule.declarations.map((rawDeclaration, declarationIndex) => {
      if (!rawDeclaration || typeof rawDeclaration !== 'object' || Array.isArray(rawDeclaration)) {
        throw new Error(`source_profile.rules[${index}].declarations[${declarationIndex}] must be an object`)
      }
      const declaration = rawDeclaration as Record<string, unknown>
      const property = requiredBoundedString(
        declaration.property,
        `source_profile.rules[${index}].declarations[${declarationIndex}].property`,
        48,
      ).toLowerCase()
      if (!SOURCE_PROFILE_PROPERTIES.has(property) || seenProperties.has(property)) {
        throw new Error(`source_profile.rules[${index}] contains an unsupported or duplicate property`)
      }
      seenProperties.add(property)
      const rawValue = requiredBoundedString(
        declaration.value,
        `source_profile.rules[${index}].declarations[${declarationIndex}].value`,
        240,
      )
      return { property, value: normalizeCssDeclarationValue(property, rawValue) }
    })
    if (typeof rule.requiredInDom !== 'boolean') throw new Error(`source_profile.rules[${index}].requiredInDom must be boolean`)
    const effectiveFontFamily = rule.effectiveFontFamily === undefined
      ? undefined
      : normalizeCssDeclarationValue('font-family', requiredBoundedString(rule.effectiveFontFamily, `source_profile.rules[${index}].effectiveFontFamily`, 120))
    return {
      selector,
      declarations,
      requiredInDom: rule.requiredInDom,
      ...(effectiveFontFamily ? { effectiveFontFamily } : {}),
    }
  })
  if (!Array.isArray(input.dom) || input.dom.length > SOURCE_PROFILE_MAX_DOM_CLASSES) {
    throw new Error(`source_profile.dom must contain at most ${SOURCE_PROFILE_MAX_DOM_CLASSES} entries`)
  }
  const seenClasses = new Set<string>()
  const dom = input.dom.map((rawDom, index) => {
    if (!rawDom || typeof rawDom !== 'object' || Array.isArray(rawDom)) throw new Error(`source_profile.dom[${index}] must be an object`)
    const entry = rawDom as Record<string, unknown>
    const className = requiredBoundedString(entry.className, `source_profile.dom[${index}].className`, 100).toLowerCase()
    if (!/^-?[_a-z][\w-]*$/iu.test(className) || seenClasses.has(className)) throw new Error(`source_profile.dom[${index}].className is invalid or duplicated`)
    seenClasses.add(className)
    const occurrences = Number(entry.occurrences)
    if (!Number.isInteger(occurrences) || occurrences < 1 || occurrences > 10_000) throw new Error(`source_profile.dom[${index}].occurrences is out of bounds`)
    if (typeof entry.required !== 'boolean') throw new Error(`source_profile.dom[${index}].required must be boolean`)
    let inlineStyleVariants: ReferenceStyleInlineVariantProfile[] | undefined
    if (entry.inlineStyleVariants !== undefined) {
      if (!Array.isArray(entry.inlineStyleVariants) || entry.inlineStyleVariants.length > SOURCE_PROFILE_MAX_INLINE_PROPERTIES) {
        throw new Error(`source_profile.dom[${index}].inlineStyleVariants is out of bounds`)
      }
      const seenProperties = new Set<string>()
      inlineStyleVariants = entry.inlineStyleVariants.map((rawVariant, variantIndex) => {
        if (!rawVariant || typeof rawVariant !== 'object' || Array.isArray(rawVariant)) {
          throw new Error(`source_profile.dom[${index}].inlineStyleVariants[${variantIndex}] must be an object`)
        }
        const variant = rawVariant as Record<string, unknown>
        const property = requiredBoundedString(variant.property, `source_profile.dom[${index}].inlineStyleVariants[${variantIndex}].property`, 48).toLowerCase()
        if (!SOURCE_PROFILE_INLINE_PROPERTIES.has(property) || seenProperties.has(property)) throw new Error(`source_profile.dom[${index}] contains an unsupported or duplicate inline property`)
        seenProperties.add(property)
        if (!Array.isArray(variant.values) || variant.values.length < 1 || variant.values.length > SOURCE_PROFILE_MAX_INLINE_VALUES) {
          throw new Error(`source_profile.dom[${index}].inlineStyleVariants[${variantIndex}].values is out of bounds`)
        }
        const values = [...new Set(variant.values.map((item) => normalizeCssDeclarationValue(
          property,
          requiredBoundedString(item, `source_profile.dom[${index}].inlineStyleVariants[${variantIndex}].values`, 240),
        )))]
        return { property, values }
      })
    }
    return {
      className,
      occurrences,
      required: entry.required,
      ...(inlineStyleVariants && inlineStyleVariants.length > 0 ? { inlineStyleVariants } : {}),
    }
  })
  const bodyFontFamily = optionalProfileFont(input.bodyFontFamily, 'source_profile.bodyFontFamily')
  const headingFontFamily = optionalProfileFont(input.headingFontFamily, 'source_profile.headingFontFamily')
  return {
    version: 1,
    rules,
    dom,
    ...(bodyFontFamily ? { bodyFontFamily } : {}),
    ...(headingFontFamily ? { headingFontFamily } : {}),
  }
}

export function normalizeRenderedReferenceStyleProfile(
  value: unknown,
  expected?: { evidenceSha256?: string; viewport?: { width: number; height: number } },
): RenderedReferenceStyleProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('render_profile must be an object')
  let serialized: string
  try { serialized = JSON.stringify(value) } catch { throw new Error('render_profile must be JSON-serializable') }
  if (Buffer.byteLength(serialized) > RENDER_PROFILE_MAX_BYTES) {
    throw new Error(`render_profile exceeds the ${RENDER_PROFILE_MAX_BYTES}-byte budget`)
  }
  const input = value as Record<string, unknown>
  if (input.version !== 1) throw new Error('render_profile.version must be 1')
  const evidenceSha256 = requiredBoundedString(input.evidenceSha256, 'render_profile.evidenceSha256', 64).toLowerCase()
  if (!/^[0-9a-f]{64}$/u.test(evidenceSha256)) throw new Error('render_profile.evidenceSha256 must be a SHA-256 digest')
  if (expected?.evidenceSha256 && evidenceSha256 !== expected.evidenceSha256.toLowerCase()) {
    throw new Error('render_profile evidence hash does not match provenance')
  }
  const viewportInput = input.viewport
  if (!viewportInput || typeof viewportInput !== 'object' || Array.isArray(viewportInput)) throw new Error('render_profile.viewport must be an object')
  const width = Number((viewportInput as Record<string, unknown>).width)
  const height = Number((viewportInput as Record<string, unknown>).height)
  if (!Number.isInteger(width) || width < 800 || width > 2_560 || !Number.isInteger(height) || height < 450 || height > 1_440) {
    throw new Error('render_profile.viewport is out of bounds')
  }
  if (expected?.viewport && (width !== expected.viewport.width || height !== expected.viewport.height)) {
    throw new Error('render_profile viewport does not match the StyleContract')
  }
  if (!input.phases || typeof input.phases !== 'object' || Array.isArray(input.phases)) throw new Error('render_profile.phases must be an object')
  const phasesInput = input.phases as Record<string, unknown>
  const phases = Object.fromEntries((['cover', 'content', 'closing'] as const).map((phase) => {
    return [phase, normalizeRenderedReferencePhaseProfile(
      phasesInput[phase],
      `render_profile.phases.${phase}`,
      RENDER_PROFILE_MAX_ANCHORS_PER_PHASE,
      RENDER_PHASE_STRUCTURAL_ROOT_SELECTOR_PATTERN,
    )]
  })) as unknown as Record<ReferenceRenderPhase, RenderedReferencePhaseProfile>
  let sharedAnchorSelectors: string[] | undefined
  if (input.sharedAnchorSelectors !== undefined) {
    if (!Array.isArray(input.sharedAnchorSelectors)
      || input.sharedAnchorSelectors.length < 1
      || input.sharedAnchorSelectors.length > RENDER_PROFILE_MAX_SHARED_ANCHOR_SELECTORS) {
      throw new Error('render_profile.sharedAnchorSelectors is out of bounds')
    }
    const selectors = new Set<string>()
    sharedAnchorSelectors = input.sharedAnchorSelectors.map((rawSelector, index) => {
      const selector = normalizeCssSelector(requiredBoundedString(
        rawSelector,
        `render_profile.sharedAnchorSelectors[${index}]`,
        240,
      ))
      if (!selector || selectors.has(selector)) {
        throw new Error(`render_profile.sharedAnchorSelectors[${index}] is invalid or duplicated`)
      }
      selectors.add(selector)
      for (const phase of ['cover', 'content', 'closing'] as const) {
        if (!phases[phase].anchors.some((anchor) => anchor.selector === selector)) {
          throw new Error(`render_profile.phases.${phase} lacks shared anchor ${selector}`)
        }
      }
      return selector
    })
  }
  let interiorVariants: RenderedReferenceLayoutVariantProfile[] | undefined
  if (input.interiorVariants !== undefined) {
    if (!Array.isArray(input.interiorVariants)
      || input.interiorVariants.length < 1
      || input.interiorVariants.length > RENDER_PROFILE_MAX_LAYOUT_VARIANTS) {
      throw new Error('render_profile.interiorVariants is out of bounds')
    }
    const selectors = new Set<string>()
    interiorVariants = input.interiorVariants.map((rawVariant, index) => {
      const path = `render_profile.interiorVariants[${index}]`
      if (!rawVariant || typeof rawVariant !== 'object' || Array.isArray(rawVariant)) throw new Error(`${path} must be an object`)
      const variant = rawVariant as Record<string, unknown>
      const layoutSelector = normalizeCssSelector(requiredBoundedString(variant.layoutSelector, `${path}.layoutSelector`, 120))
      if (!RENDER_PHASE_STRUCTURAL_ROOT_SELECTOR_PATTERN.test(layoutSelector) || selectors.has(layoutSelector)) {
        throw new Error(`${path}.layoutSelector is invalid or duplicated`)
      }
      selectors.add(layoutSelector)
      const escapedSelector = layoutSelector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      return {
        layoutSelector,
        profile: normalizeRenderedReferencePhaseProfile(
          variant.profile,
          `${path}.profile`,
          RENDER_PROFILE_MAX_ANCHORS_PER_VARIANT,
          new RegExp(`^${escapedSelector}(?:$|[ .:#>+~])`, 'iu'),
        ),
      }
    })
    if (sharedAnchorSelectors) {
      for (const [index, variant] of interiorVariants.entries()) {
        for (const selector of sharedAnchorSelectors) {
          if (!variant.profile.anchors.some((anchor) => anchor.selector === selector)) {
            throw new Error(`render_profile.interiorVariants[${index}].profile lacks shared anchor ${selector}`)
          }
        }
      }
    }
  }
  return {
    version: 1,
    evidenceSha256,
    viewport: { width, height },
    phases,
    ...(sharedAnchorSelectors ? { sharedAnchorSelectors } : {}),
    ...(interiorVariants ? { interiorVariants } : {}),
  }
}

/**
 * Return Browser-grounded selectors that identify the presentation page
 * roots. These roots may use different CSS mechanics when an external deck
 * controller is replaced by an equivalent self-contained runtime; their
 * rendered geometry and single-active-page behavior remain authoritative.
 */
export function renderedReferenceRuntimeManagedSlideSelectors(
  profile: RenderedReferenceStyleProfile | undefined,
): string[] {
  if (!profile) return []
  const shared = profile.sharedAnchorSelectors ?? profile.phases.cover.anchors
    .map((anchor) => anchor.selector)
    .filter((selector) => (
      profile.phases.content.anchors.some((anchor) => anchor.selector === selector)
      && profile.phases.closing.anchors.some((anchor) => anchor.selector === selector)
    ))
  return [...new Set(shared.map(normalizeCssSelector).filter(referenceSelectorTargetsPresentationRoot))]
}

function referenceSelectorTargetsPresentationRoot(selector: string): boolean {
  const surface = selectorRelationshipSurface(selector)
  if (!surface) return false
  return /(?:^|[>+~\s])(?:section|article)?\.slide(?:$|[.#\[])/iu.test(surface)
    || /^[a-z][\w]*-[\w-]+>(?:section|article)(?:$|[.#\[])/iu.test(surface)
}

function normalizeRenderedReferencePhaseProfile(
  value: unknown,
  path: string,
  maxAnchors: number,
  structuralPattern: RegExp,
): RenderedReferencePhaseProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`)
  const rawPhase = value as Record<string, unknown>
  const rawAnchors = rawPhase.anchors
  if (!Array.isArray(rawAnchors) || rawAnchors.length < 1 || rawAnchors.length > maxAnchors) {
    throw new Error(`${path}.anchors is out of bounds`)
  }
  const selectors = new Set<string>()
  const anchors = rawAnchors.map((rawAnchor, anchorIndex) => {
    const anchorPath = `${path}.anchors[${anchorIndex}]`
    if (!rawAnchor || typeof rawAnchor !== 'object' || Array.isArray(rawAnchor)) throw new Error(`${anchorPath} must be an object`)
    const anchor = rawAnchor as Record<string, unknown>
    const selector = normalizeCssSelector(requiredBoundedString(anchor.selector, `${anchorPath}.selector`, 240))
    if (!selector || selectors.has(selector)) throw new Error(`${anchorPath}.selector is invalid or duplicated`)
    selectors.add(selector)
    const count = Number(anchor.count)
    if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new Error(`${anchorPath}.count is out of bounds`)
    if (![
      'strict', 'size', 'flow-size', 'intrinsic-block', 'intrinsic-block-center', 'intrinsic-inline', 'intrinsic-size',
    ].includes(String(anchor.geometry))) {
      throw new Error(`${anchorPath}.geometry is invalid`)
    }
    const geometry = anchor.geometry as ReferenceRenderGeometryPolicy
    if (!Array.isArray(anchor.rects) || !Array.isArray(anchor.styles) || !Array.isArray(anchor.occlusion)) {
      throw new Error(`${anchorPath} samples must be arrays`)
    }
    const sampleCount = Math.min(count, RENDER_PROFILE_MAX_INSTANCES_PER_ANCHOR)
    if (anchor.rects.length !== sampleCount || anchor.styles.length !== sampleCount || anchor.occlusion.length !== sampleCount) {
      throw new Error(`${anchorPath} sample counts do not match`)
    }
    const rects = anchor.rects.map((rawRect, rectIndex) => normalizeRenderedRect(rawRect, `${anchorPath}.rects[${rectIndex}]`))
    if (anchor.authoredBox !== undefined && anchor.authoredBox !== true) throw new Error(`${anchorPath}.authoredBox must be true when present`)
    let containingBlockOffsets: Array<RenderedReferenceContainingBlockOffsetProfile | null> | undefined
    if (anchor.containingBlockOffsets !== undefined) {
      if (!Array.isArray(anchor.containingBlockOffsets) || anchor.containingBlockOffsets.length !== sampleCount) {
        throw new Error(`${anchorPath}.containingBlockOffsets sample count does not match`)
      }
      containingBlockOffsets = anchor.containingBlockOffsets.map((rawOffset, offsetIndex) => {
        if (rawOffset === null) return null
        const offsetPath = `${anchorPath}.containingBlockOffsets[${offsetIndex}]`
        if (!rawOffset || typeof rawOffset !== 'object' || Array.isArray(rawOffset)) {
          throw new Error(`${offsetPath} must be an object or null`)
        }
        const values = rawOffset as Record<string, unknown>
        const normalized = {} as RenderedReferenceContainingBlockOffsetProfile
        for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
          const coordinate = Number(values[edge])
          if (!Number.isFinite(coordinate) || coordinate < -4 || coordinate > 4) {
            throw new Error(`${offsetPath}.${edge} is out of bounds`)
          }
          normalized[edge] = Math.round(coordinate * 10_000) / 10_000
        }
        return normalized
      })
    }
    const styles = anchor.styles.map((rawStyles, styleIndex) => {
      const stylePath = `${anchorPath}.styles[${styleIndex}]`
      if (!rawStyles || typeof rawStyles !== 'object' || Array.isArray(rawStyles)) throw new Error(`${stylePath} must be an object`)
      const entries = Object.entries(rawStyles as Record<string, unknown>)
      if (entries.length < 1 || entries.length > RENDER_PROFILE_MAX_STYLE_PROPERTIES) throw new Error(`${stylePath} is out of bounds`)
      const normalized: Record<string, string> = {}
      for (const [rawProperty, rawValue] of entries) {
        const property = rawProperty.trim().toLowerCase()
        if (!RENDER_PROFILE_STYLE_PROPERTIES.has(property) || property in normalized) throw new Error(`${stylePath} contains an unsupported property`)
        normalized[property] = requiredBoundedString(rawValue, `${stylePath}.${property}`, 240).replace(/\s+/gu, ' ').trim().toLowerCase()
      }
      return normalized
    })
    const occlusion = anchor.occlusion.map((rawRatio, ratioIndex) => {
      const ratio = Number(rawRatio)
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error(`${anchorPath}.occlusion[${ratioIndex}] is out of bounds`)
      return Math.round(ratio * 100) / 100
    })
    return {
      selector,
      count,
      geometry,
      ...(anchor.authoredBox === true ? { authoredBox: true as const } : {}),
      rects,
      ...(containingBlockOffsets ? { containingBlockOffsets } : {}),
      styles,
      occlusion,
    } satisfies RenderedReferenceAnchorProfile
  })
  const structuralAnchors = anchors.filter((anchor) => structuralPattern.test(anchor.selector))
  if (structuralAnchors.length === 0) throw new Error(`${path} lacks a phase structural anchor`)
  if (!structuralAnchors.some((anchor) => anchor.geometry === 'strict')) {
    throw new Error(`${path} must retain at least one strict geometry structural anchor`)
  }
  const rawOverlayProbes = rawPhase.overlayProbes
  if (!Array.isArray(rawOverlayProbes) || rawOverlayProbes.length > RENDER_PROFILE_MAX_OVERLAY_PROBES) {
    throw new Error(`${path}.overlayProbes is out of bounds`)
  }
  const overlayProbes = rawOverlayProbes.map((rawProbe, probeIndex) => {
    const probePath = `${path}.overlayProbes[${probeIndex}]`
    if (!rawProbe || typeof rawProbe !== 'object' || Array.isArray(rawProbe)) throw new Error(`${probePath} must be an object`)
    const probe = rawProbe as Record<string, unknown>
    const tag = requiredBoundedString(probe.tag, `${probePath}.tag`, 40).toLowerCase()
    if (!/^[a-z][\w-]*(?:::(?:before|after))?$/u.test(tag)) throw new Error(`${probePath}.tag is invalid`)
    const coverage = Number(probe.coverage)
    if (!Number.isFinite(coverage) || coverage < 0.5 || coverage > 1) throw new Error(`${probePath}.coverage is out of bounds`)
    return {
      tag,
      coverage: Math.round(coverage * 10_000) / 10_000,
      position: requiredBoundedString(probe.position, `${probePath}.position`, 40).toLowerCase(),
      backgroundColor: requiredBoundedString(probe.backgroundColor, `${probePath}.backgroundColor`, 120).toLowerCase(),
      backgroundImage: requiredBoundedString(probe.backgroundImage, `${probePath}.backgroundImage`, 240).toLowerCase(),
      opacity: requiredBoundedString(probe.opacity, `${probePath}.opacity`, 40).toLowerCase(),
      zIndex: requiredBoundedString(probe.zIndex, `${probePath}.zIndex`, 40).toLowerCase(),
    } satisfies RenderedReferenceOverlayProbe
  })
  const rawTypographyProbes = rawPhase.typographyProbes
  let typographyProbes: RenderedReferenceTypographyProbe[] | undefined
  if (rawTypographyProbes !== undefined) {
    if (!Array.isArray(rawTypographyProbes) || rawTypographyProbes.length > RENDER_PROFILE_MAX_TYPOGRAPHY_PROBES) {
      throw new Error(`${path}.typographyProbes is out of bounds`)
    }
    const typographySelectors = new Set<string>()
    typographyProbes = rawTypographyProbes.map((rawProbe, probeIndex) => {
      const probePath = `${path}.typographyProbes[${probeIndex}]`
      if (!rawProbe || typeof rawProbe !== 'object' || Array.isArray(rawProbe)) throw new Error(`${probePath} must be an object`)
      const probe = rawProbe as Record<string, unknown>
      const selector = normalizeCssSelector(requiredBoundedString(probe.selector, `${probePath}.selector`, 40))
      if (!/^(?:h[1-6]|p|li|\.tag)$/u.test(selector) || typographySelectors.has(selector)) {
        throw new Error(`${probePath}.selector is invalid or duplicated`)
      }
      typographySelectors.add(selector)
      if (!probe.styles || typeof probe.styles !== 'object' || Array.isArray(probe.styles)) throw new Error(`${probePath}.styles must be an object`)
      const entries = Object.entries(probe.styles as Record<string, unknown>)
      if (entries.length < 1 || entries.length > 10) throw new Error(`${probePath}.styles is out of bounds`)
      const styles: Record<string, string> = {}
      for (const [rawProperty, rawValue] of entries) {
        const property = rawProperty.trim().toLowerCase()
        if (!['color', 'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'line-height', 'text-align', 'text-transform'].includes(property)
          || property in styles) throw new Error(`${probePath}.styles contains an unsupported property`)
        styles[property] = requiredBoundedString(rawValue, `${probePath}.styles.${property}`, 240).replace(/\s+/gu, ' ').trim().toLowerCase()
      }
      return { selector, styles }
    })
  }
  return {
    anchors,
    overlayProbes,
    ...(typographyProbes ? { typographyProbes } : {}),
    ...(rawPhase.textLayout !== undefined ? { textLayout: normalizeRenderedTextLayout(rawPhase.textLayout) } : {}),
  }
}

/**
 * Keep the full deterministic fingerprints in durable Harness state while
 * exposing only a small, stable attestation to the model provider. The model
 * already has the concrete reference source while authoring the first HTML;
 * replaying tens of kilobytes of computed rectangles on every later phase
 * adds no creative information, consumes context, and lowers effective prompt
 * cache density. Server-side gates continue to parse the unprojected record.
 */
export function projectReferenceStyleToolResultForProvider(content: string): string {
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return content
    payload = parsed as Record<string, unknown>
  } catch {
    return content
  }
  if (payload.status !== 'success' || !payload.contract || !payload.provenance) return content
  const rawSourceProfile = payload.source_profile ?? payload.sourceProfile
  const rawRenderProfile = payload.render_profile ?? payload.renderProfile
  if (rawSourceProfile === undefined && rawRenderProfile === undefined) return content

  try {
    const contract = normalizeReferenceStyleContract(payload.contract)
    const provenanceInput = payload.provenance
    if (!provenanceInput || typeof provenanceInput !== 'object' || Array.isArray(provenanceInput)) return content
    const provenance = provenanceInput as Record<string, unknown>
    const resolvedUrl = requiredBoundedString(provenance.resolvedUrl, 'provenance.resolvedUrl', 2_000)
    const evidenceSha256 = requiredBoundedString(provenance.evidenceSha256, 'provenance.evidenceSha256', 64).toLowerCase()
    const evidenceBytes = Number(provenance.evidenceBytes)
    if (!/^[0-9a-f]{64}$/u.test(evidenceSha256)
      || !Number.isInteger(evidenceBytes)
      || evidenceBytes <= 0
      || !referenceUrlsAreRelated(contract.sourceUrl, resolvedUrl)) return content

    const sourceProfile = rawSourceProfile === undefined
      ? undefined
      : normalizeReferenceStyleSourceProfile(rawSourceProfile)
    const renderProfile = rawRenderProfile === undefined
      ? undefined
      : normalizeRenderedReferenceStyleProfile(rawRenderProfile, {
        evidenceSha256,
        viewport: contract.viewport,
      })
    const rawFontEvidence = payload.font_evidence ?? payload.fontEvidence
    const fontEvidence = rawFontEvidence === undefined
      ? undefined
      : normalizeReferenceFontEvidenceManifest(rawFontEvidence)
    if (fontEvidence && fontEvidence.sourceEvidenceSha256 !== evidenceSha256) return content
    const rawVisualEvidence = payload.visual_evidence ?? payload.visualEvidence
    const visualEvidence = rawVisualEvidence === undefined
      ? undefined
      : normalizeReferenceVisualEvidenceManifest(rawVisualEvidence)
    if (visualEvidence && (
      visualEvidence.sourceEvidenceSha256 !== evidenceSha256
      || !renderProfile
      || visualEvidence.renderProfileSha256 !== createHash('sha256').update(JSON.stringify(renderProfile)).digest('hex')
      || visualEvidence.viewport.width !== contract.viewport.width
      || visualEvidence.viewport.height !== contract.viewport.height
    )) return content
    const sourceProfileJson = sourceProfile ? JSON.stringify(sourceProfile) : undefined
    const renderProfileJson = renderProfile ? JSON.stringify(renderProfile) : undefined
    const languageVariant = payload.language_variant === undefined ? undefined : normalizeReferenceLanguageVariant(payload.language_variant)
    if (languageVariant && languageVariant.sourceSha256 !== evidenceSha256) return content
    return JSON.stringify({
      status: 'success',
      contract: {
        source_url: contract.sourceUrl,
        strictness: contract.strictness,
        colors: contract.colors,
        fonts: contract.fonts,
        layout: contract.layout,
        components: contract.components,
        required_markers: contract.requiredMarkers,
        signature: contract.signature,
        avoid: contract.avoid,
        viewport: contract.viewport,
      },
      provenance: { resolvedUrl, evidenceSha256, evidenceBytes },
      ...(languageVariant ? { language_variant_attestation: {
        language: languageVariant.language, adapter: languageVariant.adapter,
        manifest_sha256: languageVariant.manifestSha256, design_url: languageVariant.designUrl,
        design_sha256: languageVariant.designSha256,
      } } : {}),
      ...(sourceProfile && sourceProfileJson ? {
        source_profile_attestation: {
          version: sourceProfile.version,
          sha256: createHash('sha256').update(sourceProfileJson).digest('hex'),
          rules: sourceProfile.rules.length,
          required_rules: sourceProfile.rules.filter((rule) => rule.requiredInDom).length,
          dom_classes: sourceProfile.dom.length,
          required_dom_classes: sourceProfile.dom.filter((entry) => entry.required).length,
        },
      } : {}),
      ...(renderProfile && renderProfileJson ? {
        render_profile_attestation: {
          version: renderProfile.version,
          sha256: createHash('sha256').update(renderProfileJson).digest('hex'),
          evidenceSha256: renderProfile.evidenceSha256,
          viewport: renderProfile.viewport,
          phases: Object.fromEntries((['cover', 'content', 'closing'] as const).map((phase) => [phase, {
            anchors: renderProfile.phases[phase].anchors.length,
            overlay_probes: renderProfile.phases[phase].overlayProbes.length,
          }])),
          shared_anchor_selectors: renderProfile.sharedAnchorSelectors ?? [],
          ...(renderProfile.interiorVariants ? {
            interior_variants: {
              count: renderProfile.interiorVariants.length,
              layout_selectors: renderProfile.interiorVariants.map((variant) => variant.layoutSelector),
            },
          } : {}),
        },
      } : {}),
      ...(fontEvidence ? {
        font_evidence_attestation: {
          version: fontEvidence.version,
          manifest_sha256: fontEvidence.manifestSha256,
          source_evidence_sha256: fontEvidence.sourceEvidenceSha256,
          font_css_sha256: fontEvidence.fontCssSha256,
          font_css_bytes: fontEvidence.fontCssBytes,
          family_names: fontEvidence.familyNames,
          stylesheets: fontEvidence.materializationManifest?.stylesheets.length ?? 0,
          font_files: fontEvidence.materializationManifest?.fonts.length ?? 0,
          font_bytes: fontEvidence.materializationManifest?.fontBytes ?? 0,
        },
      } : {}),
      ...(visualEvidence ? {
        visual_evidence_attestation: {
          version: visualEvidence.version,
          manifest_sha256: visualEvidence.manifestSha256,
          source_evidence_sha256: visualEvidence.sourceEvidenceSha256,
          render_profile_sha256: visualEvidence.renderProfileSha256,
          viewport: visualEvidence.viewport,
          phases: Object.fromEntries((['cover', 'content', 'closing'] as const).map((phase) => [phase, {
            sha256: visualEvidence.phases[phase].sha256,
            bytes: visualEvidence.phases[phase].bytes,
          }])),
        },
      } : {}),
      verification_note: 'Full source and browser render profiles are retained server-side for deterministic verification.',
    })
  } catch {
    // Never rewrite an unrecognized or malformed result. The normal durable
    // parser remains fail-closed and will reject it independently.
    return content
  }
}

function normalizeRenderedRect(value: unknown, name: string): RenderedReferenceRectProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  const input = value as Record<string, unknown>
  const result = Object.fromEntries(['x', 'y', 'width', 'height'].map((field) => {
    const number = Number(input[field])
    if (!Number.isFinite(number) || number < -4 || number > 4 || ((field === 'width' || field === 'height') && number <= 0)) {
      throw new Error(`${name}.${field} is out of bounds`)
    }
    return [field, Math.round(number * 10_000) / 10_000]
  })) as unknown as RenderedReferenceRectProfile
  return result
}

export function referenceStyleEvidenceScore(content: string): number {
  const colors = new Set(content.match(STYLE_COLOR_PATTERN)?.map((value) => value.toLowerCase()) ?? [])
  const properties = new Set(content.match(STYLE_PROPERTY_PATTERN)?.map((value) => value.toLowerCase()) ?? [])
  const fonts = new Set(content.match(STYLE_FONT_PATTERN)?.map((value) => value.toLowerCase()) ?? [])
  let score = 0
  if (colors.size >= 2) score += 2
  else if (colors.size === 1) score += 1
  if (properties.size >= 4) score += 2
  else if (properties.size >= 1) score += 1
  if (fonts.size >= 1) score += 1
  if (/(?:<!doctype\s+html|<style\b|```(?:css|html)|\bcomponents?\s*:|\btypography\s*:)/iu.test(content)) score += 1
  return score
}

export function findReferenceStyleEvidence(
  messages: readonly ModelMessage[],
  referenceUrls: readonly string[],
  beforeMessageIndex = Number.POSITIVE_INFINITY,
): ReferenceStyleEvidence | undefined {
  let best: ReferenceStyleEvidence | undefined
  let bestScore = -1
  const occurrences = successfulReferenceFetchOccurrences(messages, referenceUrls, beforeMessageIndex)
  const candidates: ReferenceStyleEvidence[] = occurrences.webFetches.map((occurrence) => evidenceFromWebFetch(occurrence))
  for (const chain of fetchPageChains(occurrences.fetchPageChunks)) {
    const evidence = evidenceFromCompleteFetchPageChain(chain)
    if (evidence) candidates.push(evidence)
  }
  for (const candidate of candidates) {
    const score = referenceStyleEvidenceScore(candidate.content)
    if (score < 4) continue
    if (score < bestScore || (score === bestScore && best && candidate.resultMessageIndex < best.resultMessageIndex)) continue
    bestScore = score
    best = candidate
  }
  return best
}

/**
 * Resolve the complete fetch occurrence containing one terminal call without
 * applying the style-score threshold. The source-resolution ledger uses this
 * to distinguish a complete but non-style-bearing response from an incomplete
 * pagination chain; callers must still apply `referenceStyleEvidenceScore`.
 */
export function completedReferenceStyleFetchForCall(
  messages: readonly ModelMessage[],
  referenceUrls: readonly string[],
  callId: string,
  beforeMessageIndex = Number.POSITIVE_INFINITY,
): ReferenceStyleEvidence | undefined {
  const occurrences = successfulReferenceFetchOccurrences(messages, referenceUrls, beforeMessageIndex)
  const candidates: ReferenceStyleEvidence[] = occurrences.webFetches.map(evidenceFromWebFetch)
  for (const chain of fetchPageChains(occurrences.fetchPageChunks)) {
    const evidence = evidenceFromCompleteFetchPageChain(chain)
    if (evidence) candidates.push(evidence)
  }
  return candidates
    .filter((candidate) => candidate.callIds.includes(callId))
    .sort((left, right) => right.resultMessageIndex - left.resultMessageIndex)[0]
}

/**
 * Returns the most recently advanced, internally consistent fetch_page chain
 * that still needs another chunk. It never mutates history and deliberately
 * omits malformed/contradictory chains so a prompt cannot continue from
 * ambiguous evidence.
 */
export function referenceStyleEvidenceContinuation(
  messages: readonly ModelMessage[],
  referenceUrls: readonly string[],
  beforeMessageIndex = Number.POSITIVE_INFINITY,
): ReferenceStyleEvidenceContinuation | undefined {
  const occurrences = successfulReferenceFetchOccurrences(messages, referenceUrls, beforeMessageIndex)
  let latest: { continuation: ReferenceStyleEvidenceContinuation; resultMessageIndex: number } | undefined
  for (const chain of fetchPageChains(occurrences.fetchPageChunks)) {
    const continuation = continuationFromFetchPageChain(chain)
    if (!continuation || (latest && chain.latestResultMessageIndex < latest.resultMessageIndex)) continue
    latest = { continuation, resultMessageIndex: chain.latestResultMessageIndex }
  }
  return latest?.continuation
}

type ReferenceFetchPageFormat = ReferenceStyleEvidenceContinuation['format']

interface SuccessfulReferenceWebFetch {
  call: ToolCallRecord
  callMessageIndex: number
  resultMessageIndex: number
  requestedUrl: string
  resolvedUrl: string
  content: string
}

interface SuccessfulReferenceFetchPageChunk extends SuccessfulReferenceWebFetch {
  canonicalRequestedUrl: string
  canonicalResolvedUrl: string
  format: ReferenceFetchPageFormat
  chunkIndex: number
  hasMore: boolean
  totalChunks?: number
  metadataValid: boolean
}

interface ReferenceFetchPageChain {
  chunks: Map<number, SuccessfulReferenceFetchPageChunk>
  format: ReferenceFetchPageFormat
  invalid: boolean
  latestResultMessageIndex: number
  totalChunks?: number
}

function successfulReferenceFetchOccurrences(
  messages: readonly ModelMessage[],
  referenceUrls: readonly string[],
  beforeMessageIndex: number,
): { webFetches: SuccessfulReferenceWebFetch[]; fetchPageChunks: SuccessfulReferenceFetchPageChunk[] } {
  const calls = toolCallsById(messages)
  const webFetches: SuccessfulReferenceWebFetch[] = []
  const fetchPageChunks: SuccessfulReferenceFetchPageChunk[] = []
  for (let index = 0; index < messages.length && index < beforeMessageIndex; index += 1) {
    const message = messages[index]
    if (message.role !== 'tool' || !message.tool_call_id || message.tool_result_status === 'failed') continue
    const source = calls.get(message.tool_call_id)
    if (!source || source.index >= index || !['fetch_page', 'web_fetch'].includes(source.call.name)) continue
    const payload = structuredPayload(message.content)
    if (payload?.status !== 'success' || typeof payload.content !== 'string') continue
    const requestedUrl = typeof source.call.arguments.url === 'string' ? source.call.arguments.url : ''
    const resolvedUrl = typeof payload.url === 'string' ? payload.url : requestedUrl
    if (!eligibleReferenceStyleFetch(requestedUrl, resolvedUrl, referenceUrls)) continue
    if (source.call.name === 'web_fetch') {
      webFetches.push({
        call: source.call,
        callMessageIndex: source.index,
        resultMessageIndex: index,
        requestedUrl,
        resolvedUrl,
        content: payload.content,
      })
      continue
    }

    const canonicalRequestedUrl = canonicalReferenceFetchUrl(requestedUrl)
    const canonicalResolvedUrl = canonicalReferenceFetchUrl(resolvedUrl)
    const format = normalizeFetchPageFormat(source.call.arguments.format)
    if (!canonicalRequestedUrl || !canonicalResolvedUrl || !format) continue
    const requestedChunkIndex = source.call.arguments.chunkIndex === undefined
      ? 0
      : source.call.arguments.chunkIndex
    const payloadChunkIndex = payload.chunkIndex
    const payloadHasMore = payload.hasMore
    const payloadTotalChunks = payload.totalChunks
    const validRequestedChunkIndex = Number.isInteger(requestedChunkIndex) && Number(requestedChunkIndex) >= 0
    const validPayloadChunkIndex = Number.isInteger(payloadChunkIndex) && Number(payloadChunkIndex) >= 0
    const validTotalChunks = payloadTotalChunks === undefined
      || (Number.isInteger(payloadTotalChunks) && Number(payloadTotalChunks) > 0)
    const metadataValid = validRequestedChunkIndex
      && validPayloadChunkIndex
      && requestedChunkIndex === payloadChunkIndex
      && typeof payload.url === 'string'
      && typeof payloadHasMore === 'boolean'
      && validTotalChunks
      && (payloadTotalChunks === undefined || Number(payloadChunkIndex) < Number(payloadTotalChunks))
    fetchPageChunks.push({
      call: source.call,
      callMessageIndex: source.index,
      resultMessageIndex: index,
      requestedUrl,
      resolvedUrl,
      content: payload.content,
      canonicalRequestedUrl,
      canonicalResolvedUrl,
      format,
      chunkIndex: validPayloadChunkIndex ? Number(payloadChunkIndex) : -1,
      hasMore: payloadHasMore === true,
      ...(validTotalChunks && payloadTotalChunks !== undefined ? { totalChunks: Number(payloadTotalChunks) } : {}),
      metadataValid,
    })
  }
  return { webFetches, fetchPageChunks }
}

function fetchPageChains(chunks: readonly SuccessfulReferenceFetchPageChunk[]): ReferenceFetchPageChain[] {
  const grouped = new Map<string, SuccessfulReferenceFetchPageChunk[]>()
  for (const chunk of chunks) {
    const key = `${chunk.canonicalResolvedUrl}\0${chunk.format}`
    const group = grouped.get(key) ?? []
    group.push(chunk)
    grouped.set(key, group)
  }
  return [...grouped.values()].map((group) => {
    const byIndex = new Map<number, SuccessfulReferenceFetchPageChunk>()
    const requestedUrls = new Set<string>()
    const declaredTotals = new Set<number>()
    let invalid = false
    let latestResultMessageIndex = -1
    for (const chunk of group) {
      latestResultMessageIndex = Math.max(latestResultMessageIndex, chunk.resultMessageIndex)
      requestedUrls.add(chunk.canonicalRequestedUrl)
      const duplicate = byIndex.get(chunk.chunkIndex)
      if (!chunk.metadataValid) {
        invalid = true
      } else if (!duplicate) {
        byIndex.set(chunk.chunkIndex, chunk)
      } else if (referenceFetchPageChunksAreIdentical(duplicate, chunk)) {
        // A provider replay or process restart may publish the same immutable
        // page twice. Retain the newest occurrence so its call id can anchor
        // continuation/evidence while treating the bytes as one logical page.
        byIndex.set(chunk.chunkIndex, chunk)
      } else {
        invalid = true
      }
      if (chunk.totalChunks !== undefined) declaredTotals.add(chunk.totalChunks)
    }
    if (requestedUrls.size !== 1 || declaredTotals.size > 1) invalid = true
    let totalChunks = declaredTotals.size === 1 ? [...declaredTotals][0] : undefined
    const ordered = [...byIndex.values()].sort((left, right) => left.chunkIndex - right.chunkIndex)
    const terminalChunks = ordered.filter((chunk) => !chunk.hasMore)
    if (totalChunks === undefined && terminalChunks.length === 1) {
      totalChunks = terminalChunks[0].chunkIndex + 1
    } else if (totalChunks === undefined && terminalChunks.length > 1) {
      invalid = true
    }
    for (const chunk of ordered) {
      if (totalChunks !== undefined) {
        if (chunk.chunkIndex >= totalChunks) invalid = true
        else if (chunk.chunkIndex === totalChunks - 1 ? chunk.hasMore : !chunk.hasMore) invalid = true
      }
    }
    return {
      chunks: byIndex,
      format: group[0].format,
      invalid,
      latestResultMessageIndex,
      ...(totalChunks === undefined ? {} : { totalChunks }),
    }
  })
}

function referenceFetchPageChunksAreIdentical(
  left: SuccessfulReferenceFetchPageChunk,
  right: SuccessfulReferenceFetchPageChunk,
): boolean {
  return left.canonicalRequestedUrl === right.canonicalRequestedUrl
    && left.canonicalResolvedUrl === right.canonicalResolvedUrl
    && left.format === right.format
    && left.chunkIndex === right.chunkIndex
    && left.hasMore === right.hasMore
    && left.totalChunks === right.totalChunks
    && left.metadataValid === right.metadataValid
    && left.content === right.content
}

function evidenceFromCompleteFetchPageChain(chain: ReferenceFetchPageChain): ReferenceStyleEvidence | undefined {
  if (chain.invalid || chain.totalChunks === undefined || chain.chunks.size !== chain.totalChunks) return undefined
  const ordered: SuccessfulReferenceFetchPageChunk[] = []
  for (let chunkIndex = 0; chunkIndex < chain.totalChunks; chunkIndex += 1) {
    const chunk = chain.chunks.get(chunkIndex)
    if (!chunk || chunk.hasMore !== (chunkIndex < chain.totalChunks - 1)) return undefined
    ordered.push(chunk)
  }
  const content = ordered.map((chunk) => chunk.content).join('')
  const first = ordered[0]
  return {
    call: first.call,
    callIds: ordered.map((chunk) => chunk.call.id),
    callMessageIndex: first.callMessageIndex,
    resultMessageIndex: chain.latestResultMessageIndex,
    requestedUrl: first.requestedUrl,
    resolvedUrl: first.resolvedUrl,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
  }
}

function continuationFromFetchPageChain(chain: ReferenceFetchPageChain): ReferenceStyleEvidenceContinuation | undefined {
  if (chain.invalid) return undefined
  let nextChunkIndex = 0
  while (chain.chunks.has(nextChunkIndex)) nextChunkIndex += 1
  if (chain.totalChunks !== undefined && nextChunkIndex >= chain.totalChunks) return undefined
  for (let chunkIndex = 0; chunkIndex < nextChunkIndex; chunkIndex += 1) {
    if (chain.chunks.get(chunkIndex)?.hasMore !== true) return undefined
  }
  const latest = [...chain.chunks.values()].reduce((current, chunk) => (
    chunk.resultMessageIndex >= current.resultMessageIndex ? chunk : current
  ))
  return {
    url: latest.requestedUrl,
    format: chain.format,
    nextChunkIndex,
    ...(chain.totalChunks === undefined ? {} : { totalChunks: chain.totalChunks }),
    callIds: [...chain.chunks.values()]
      .sort((left, right) => left.chunkIndex - right.chunkIndex)
      .map((chunk) => chunk.call.id),
  }
}

function evidenceFromWebFetch(occurrence: SuccessfulReferenceWebFetch): ReferenceStyleEvidence {
  return {
    call: occurrence.call,
    callIds: [occurrence.call.id],
    callMessageIndex: occurrence.callMessageIndex,
    resultMessageIndex: occurrence.resultMessageIndex,
    requestedUrl: occurrence.requestedUrl,
    resolvedUrl: occurrence.resolvedUrl,
    content: occurrence.content,
    sha256: createHash('sha256').update(occurrence.content).digest('hex'),
    bytes: Buffer.byteLength(occurrence.content),
  }
}

function normalizeFetchPageFormat(value: unknown): ReferenceFetchPageFormat | undefined {
  if (value === undefined || value === 'markdown') return 'markdown'
  return value === 'raw' ? 'raw' : undefined
}

function canonicalReferenceFetchUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function eligibleReferenceStyleFetch(
  requestedUrl: string,
  resolvedUrl: string,
  referenceUrls: readonly string[],
): boolean {
  // Both ends of the fetch provenance must remain inside one explicitly
  // authorized identity. Trusting only the requested URL would let an
  // arbitrary cross-origin redirect inject style evidence.
  if (!referenceUrls.some((referenceUrl) => (
    referenceUrlsAreRelated(referenceUrl, requestedUrl)
    && referenceUrlsAreRelated(referenceUrl, resolvedUrl)
  ))) return false
  // GitHub repository/directory HTML describes GitHub's own chrome, not the
  // referenced design. Even if that shell happens to contain many CSS/color
  // tokens, it remains discovery evidence and the workflow must follow a
  // concrete raw or GitHub file such as design.md/template.json/template.html.
  try {
    const requested = new URL(requestedUrl)
    const resolved = new URL(resolvedUrl)
    const requestedCoordinates = githubReferenceCoordinates(requested)
    const resolvedCoordinates = githubReferenceCoordinates(resolved)
    return !(
      (requested.hostname.toLowerCase() === 'github.com' && requestedCoordinates?.kind !== 'file')
      || (resolved.hostname.toLowerCase() === 'github.com' && resolvedCoordinates?.kind !== 'file')
    )
  } catch {
    return false
  }
}

export function contractIsGroundedInEvidence(
  contract: ReferenceStyleContract,
  evidence: ReferenceStyleEvidence,
): boolean {
  if (!referenceUrlsAreRelated(contract.sourceUrl, evidence.requestedUrl)
    || !referenceUrlsAreRelated(contract.sourceUrl, evidence.resolvedUrl)) return false
  if (contract.strictness === 'exact') {
    const gaps = referenceStyleGroundingGaps(contract, evidence)
    return Boolean(gaps
      && gaps.colors.length === 0
      && gaps.fonts.length === 0
      && gaps.markers.length === 0)
  }
  const haystack = normalizeStyleText(staticVisualSurface(evidence.content))
  const groundedColors = contract.colors.filter((value) => haystack.includes(normalizeStyleText(value))).length
  const groundedFonts = contract.fonts.filter((value) => haystack.includes(normalizeStyleText(value))).length
  const groundedMarkers = contract.requiredMarkers.filter((value) => haystack.includes(normalizeStyleText(value))).length
  return groundedColors >= Math.max(2, Math.ceil(contract.colors.length * 0.6))
    && groundedFonts >= Math.max(1, Math.ceil(contract.fonts.length * 0.5))
    && groundedMarkers >= Math.max(1, Math.ceil(contract.requiredMarkers.length * 0.5))
}

/**
 * Return actionable exact-grounding failures without weakening provenance.
 * `undefined` means the request is not eligible for detailed diagnostics: the
 * mode is not exact, or either fetched URL is unrelated to `sourceUrl`.
 */
export function referenceStyleGroundingGaps(
  contract: ReferenceStyleContract,
  evidence: ReferenceStyleEvidence,
): ReferenceStyleGroundingGaps | undefined {
  if (contract.strictness !== 'exact'
    || !referenceUrlsAreRelated(contract.sourceUrl, evidence.requestedUrl)
    || !referenceUrlsAreRelated(contract.sourceUrl, evidence.resolvedUrl)) return undefined
  const grounded = domConnectedVisualTokens(evidence.content, contract.viewport)
  return {
    colors: contract.colors.filter((value) => !grounded.colors.has(normalizeCssColorToken(value))),
    fonts: contract.fonts.filter((value) => !grounded.fonts.has(normalizeFontFamilyToken(value))),
    markers: contract.requiredMarkers.filter((value) => !domConnectedMarkerIsGrounded(value, grounded)),
  }
}

/**
 * Remove exact color tokens that are declared but visually inert, and fill
 * any remaining compact palette capacity with colors proven on the connected
 * reference DOM. Exact mode must not punish a faithful implementation merely
 * because the model omitted a real semantic status color from its summary.
 *
 * Fabricated colors, comment/script stuffing, fonts, and markers remain
 * untouched so the normal grounding gate continues to fail closed. We also
 * preserve the schema's minimum two-color invariant; an ambiguous contract
 * that would fall below it is rejected instead of silently weakened.
 */
export function normalizeReferenceStyleContractAgainstEvidence(
  contract: ReferenceStyleContract,
  evidence: ReferenceStyleEvidence,
): ReferenceStyleEvidenceNormalization {
  if (contract.strictness !== 'exact'
    || !referenceUrlsAreRelated(contract.sourceUrl, evidence.requestedUrl)
    || !referenceUrlsAreRelated(contract.sourceUrl, evidence.resolvedUrl)) {
    return { contract, omittedVisuallyInertColors: [] }
  }

  const connectedColors = domConnectedVisualTokens(evidence.content, contract.viewport).colors
  const declaredColors = new Set<string>()
  for (const rule of extractCssRules(evidence.content, contract.viewport)) {
    for (const [property, value] of rule.declarations) {
      if (!CSS_PAINT_PROPERTY.test(property) && !property.startsWith('--')) continue
      for (const color of paintValue(value).match(STYLE_COLOR_PATTERN) ?? []) {
        declaredColors.add(normalizeCssColorToken(color))
      }
    }
  }
  let omittedVisuallyInertColors = contract.colors.filter((value) => {
    const normalized = normalizeCssColorToken(value)
    return declaredColors.has(normalized) && !connectedColors.has(normalized)
  })
  if (contract.colors.length - omittedVisuallyInertColors.length < 2) {
    omittedVisuallyInertColors = []
  }
  const omitted = new Set(omittedVisuallyInertColors.map(normalizeCssColorToken))
  const colors = contract.colors.filter((value) => !omitted.has(normalizeCssColorToken(value)))
  const included = new Set(colors.map(normalizeCssColorToken))
  for (const color of connectedColors) {
    if (colors.length >= 12) break
    if (included.has(color)) continue
    colors.push(color)
    included.add(color)
  }
  if (omittedVisuallyInertColors.length === 0 && colors.length === contract.colors.length) {
    return { contract, omittedVisuallyInertColors: [] }
  }
  return {
    contract: {
      ...contract,
      colors,
    },
    omittedVisuallyInertColors,
  }
}

export function latestSuccessfulReferenceStyleContract(
  messages: readonly ModelMessage[],
  beforeMessageIndex = Number.POSITIVE_INFINITY,
): DurableReferenceStyleContract | undefined {
  const calls = toolCallsById(messages)
  for (let index = Math.min(messages.length, beforeMessageIndex) - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'tool' || !message.tool_call_id || message.tool_result_status === 'failed') continue
    const source = calls.get(message.tool_call_id)
    if (source?.call.name !== 'record_reference_style') continue
    const payload = structuredPayload(message.content)
    if (payload?.status !== 'success') continue
    try {
      const contract = normalizeReferenceStyleContract(payload.contract)
      const provenanceInput = payload.provenance
      if (!provenanceInput || typeof provenanceInput !== 'object' || Array.isArray(provenanceInput)) continue
      const provenance = provenanceInput as Record<string, unknown>
      if (typeof provenance.resolvedUrl !== 'string'
        || typeof provenance.evidenceSha256 !== 'string'
        || !/^[0-9a-f]{64}$/iu.test(provenance.evidenceSha256)
        || typeof provenance.evidenceBytes !== 'number'
        || !Number.isInteger(provenance.evidenceBytes)
        || provenance.evidenceBytes <= 0
        || !referenceUrlsAreRelated(contract.sourceUrl, provenance.resolvedUrl)) continue
      try { new URL(provenance.resolvedUrl) } catch { continue }
      const rawSourceProfile = payload.source_profile ?? payload.sourceProfile
      const sourceProfile = rawSourceProfile === undefined
        ? undefined
        : normalizeReferenceStyleSourceProfile(rawSourceProfile)
      const rawRenderProfile = payload.render_profile ?? payload.renderProfile
      const renderProfile = rawRenderProfile === undefined
        ? undefined
        : normalizeRenderedReferenceStyleProfile(rawRenderProfile, {
          evidenceSha256: provenance.evidenceSha256,
          viewport: contract.viewport,
        })
      const rawFontEvidence = payload.font_evidence ?? payload.fontEvidence
      const fontEvidence = rawFontEvidence === undefined
        ? undefined
        : normalizeReferenceFontEvidenceManifest(rawFontEvidence)
      if (fontEvidence && fontEvidence.sourceEvidenceSha256 !== provenance.evidenceSha256) continue
      const rawVisualEvidence = payload.visual_evidence ?? payload.visualEvidence
      const visualEvidence = rawVisualEvidence === undefined
        ? undefined
        : normalizeReferenceVisualEvidenceManifest(rawVisualEvidence)
      if (visualEvidence && (
        visualEvidence.sourceEvidenceSha256 !== provenance.evidenceSha256
        || !renderProfile
        || visualEvidence.renderProfileSha256 !== createHash('sha256').update(JSON.stringify(renderProfile)).digest('hex')
        || visualEvidence.viewport.width !== contract.viewport.width
        || visualEvidence.viewport.height !== contract.viewport.height
      )) continue
      const rawTemplateCatalog = payload.composition_template ?? payload.templateCatalog
      const rawRuntimeEvidence = payload.runtime_evidence ?? payload.runtimeEvidence
      const runtimeEvidence = rawRuntimeEvidence === undefined ? undefined : normalizeReferenceTemplateRuntimeEvidence(rawRuntimeEvidence)
      if (runtimeEvidence && runtimeEvidence.sourceEvidenceSha256 !== provenance.evidenceSha256) continue
      let templateCatalog: DurableReferenceStyleContract['templateCatalog']
      if (rawTemplateCatalog !== undefined) {
        try {
          templateCatalog = normalizeReferenceTemplateCatalog(rawTemplateCatalog, provenance.evidenceSha256, provenance.resolvedUrl)
        } catch {
          // Unsupported/corrupt optional composition metadata must not erase
          // otherwise valid source/render evidence. Use the ordinary path.
        }
      }
      const languageVariant = payload.language_variant === undefined ? undefined
        : normalizeReferenceLanguageVariant(payload.language_variant, templateCatalog)
      if (languageVariant && (languageVariant.sourceSha256 !== provenance.evidenceSha256 || !templateCatalog)) continue
      return {
        contract,
        provenance: {
          resolvedUrl: provenance.resolvedUrl,
          evidenceSha256: provenance.evidenceSha256,
          evidenceBytes: provenance.evidenceBytes,
        },
        ...(sourceProfile ? { sourceProfile } : {}),
        ...(renderProfile ? { renderProfile } : {}),
        ...(fontEvidence ? { fontEvidence } : {}),
        ...(visualEvidence ? { visualEvidence } : {}),
        ...(templateCatalog ? { templateCatalog } : {}),
        ...(runtimeEvidence ? { runtimeEvidence } : {}),
        ...(languageVariant ? { languageVariant } : {}),
      }
    } catch {
      // A malformed historical record cannot satisfy the durable gate.
    }
  }
  return undefined
}

export function verifyHtmlAgainstReferenceStyle(
  html: string,
  contract: ReferenceStyleContract,
  sourceProfile?: ReferenceStyleSourceProfile,
  options: ReferenceStyleVerificationOptions = {},
): ReferenceStyleVerification {
  // Ignore comments and script bodies so a candidate cannot satisfy the
  // deterministic gate by stuffing unused reference tokens into metadata or
  // JavaScript strings. The rendered DOM and CSS remain eligible evidence.
  const haystack = normalizeStyleText(staticVisualSurface(html))
  const runtimeManagedSlideSelectors = new Set(
    (options.runtimeManagedSlideSelectors ?? []).map(normalizeCssSelector).filter(Boolean),
  )
  const connected = contract.strictness === 'exact'
    ? domConnectedVisualTokens(html, contract.viewport, runtimeManagedSlideSelectors)
    : undefined
  const alternativeLayoutClasses = new Set(
    (options.alternativeLayoutSelectors ?? []).flatMap((selector) => {
      const identifiers = selectorIdentifiers(normalizeCssSelector(selector))
      return identifiers.length === 1 && identifiers[0].startsWith('.')
        ? [identifiers[0].slice(1)]
        : []
    }),
  )
  const candidateDomClasses = connected?.domClasses ?? extractDomSnapshot(html).classes
  let requiredColors = contract.colors
  if (contract.strictness === 'exact' && sourceProfile && options.authoritativeRenderedReference
    && alternativeLayoutClasses.size > 0 && options.boundTemplateSource) {
    const source = options.boundTemplateSource
    if (createHash('sha256').update(source.content).digest('hex') !== source.sha256
      || !referenceUrlsAreRelated(contract.sourceUrl, source.resolvedUrl)
      || !referenceUrlsAreRelated(contract.sourceUrl, source.requestedUrl)) {
      throw new Error('Selected-layout palette requires the exact source-bound template bytes')
    }
    const projected = projectReferenceTemplateLayouts(source.content, source.resolvedUrl,
      alternativeLayoutClasses, new Set(candidateDomClasses.keys()))
    const fullPalette = domConnectedVisualTokens(source.content, contract.viewport).colors
    const selectedPalette = domConnectedVisualTokens(projected, contract.viewport).colors
    // Omit only colors positively proven to belong exclusively to omitted
    // source layouts. Never derive requirements from candidate CSS, and never
    // exempt a fabricated contract color or a global/selected-layout color.
    requiredColors = contract.colors.filter((color) => {
      const token = normalizeCssColorToken(color)
      return !fullPalette.has(token) || selectedPalette.has(token)
    })
  }
  const requiredMarkers = contract.requiredMarkers.filter((value) => (
    // Browser-captured interior roots are a library of alternatives. A
    // compound marker such as `.s-chart .plotwrap` belongs only to the chart
    // variant and must not become a global checklist item when a shorter deck
    // legitimately selects `.s-process` instead. If the root is selected,
    // retain the whole marker so its private structure is still exact.
    !selectorIdentifiers(value).some((identifier) => (
      identifier.startsWith('.')
      && alternativeLayoutClasses.has(identifier.slice(1))
      && !candidateDomClasses.has(identifier.slice(1))
    ))
  ))
  const matchedColors = requiredColors.filter((value) => connected
    ? connected.colors.has(normalizeCssColorToken(value))
    : haystack.includes(normalizeStyleText(value)))
  const matchedFonts = contract.fonts.filter((value) => connected
    ? connected.fonts.has(normalizeFontFamilyToken(value))
    : haystack.includes(normalizeStyleText(value)))
  const matchedMarkers = requiredMarkers.filter((value) => connected
    ? domConnectedMarkerIsGrounded(value, connected)
    : haystack.includes(normalizeStyleText(value)))
  const renderedReferenceOwnsExhaustivePalette = contract.strictness === 'exact'
    && Boolean(sourceProfile)
    && options.authoritativeRenderedReference === true
  const colorViolations = renderedReferenceOwnsExhaustivePalette
    ? []
    : unexpectedChromaticColors(staticVisualSurface(html), contract.colors)
  const fontViolations = unexpectedPrimaryFontFamilies(staticVisualSurface(html), contract.fonts)
  const avoidViolations: string[] = []
  const sourceVerification = contract.strictness === 'exact' && sourceProfile
      ? verifySourceProfile(
        html,
        sourceProfile,
        contract.viewport,
        alternativeLayoutClasses,
        runtimeManagedSlideSelectors,
      )
    : { violations: [], checked: 0, matched: 0, inlineVariantGaps: [] }
  const avoidText = contract.avoid.join('\n')
  if (
    /(?:no\s+)?(?:drop\s+)?shadows?.{0,30}(?:cards?|content)|(?:cards?|content).{0,30}(?:drop\s+)?shadows?|卡片.{0,20}阴影/iu.test(avoidText)
    && /(?:\.[a-z][\w-]*card[\w-]*|\bcard[\w-]*)[^{}]*\{[^{}]*box-shadow\s*:\s*(?!none\b)[^;}]+/iu.test(staticVisualSurface(html))
  ) avoidViolations.push('card/content box-shadow contradicts the StyleContract')
  const colorThreshold = contract.strictness === 'exact'
    ? requiredColors.length
    : Math.max(2, Math.ceil(contract.colors.length * 0.4))
  const fontThreshold = contract.strictness === 'exact'
    ? contract.fonts.length
    : Math.max(1, Math.ceil(contract.fonts.length * 0.34))
  const markerThreshold = contract.strictness === 'exact'
    ? requiredMarkers.length
    : Math.max(1, Math.ceil(requiredMarkers.length * 0.34))
  const colorRatio = requiredColors.length > 0 ? matchedColors.length / requiredColors.length : 1
  const fontRatio = matchedFonts.length / contract.fonts.length
  const markerRatio = requiredMarkers.length > 0 ? matchedMarkers.length / requiredMarkers.length : 1
  const tokenScore = colorRatio * 45 + fontRatio * 25 + markerRatio * 30
  const sourceRatio = sourceVerification.checked > 0
    ? sourceVerification.matched / sourceVerification.checked
    : 1
  const rawScore = sourceProfile && contract.strictness === 'exact'
    ? tokenScore * 0.45 + sourceRatio * 55
    : tokenScore
  const score = Math.max(0, Math.round((rawScore - Math.min(40, (
    colorViolations.length * 10 + fontViolations.length * 12 + avoidViolations.length * 12
  ))) * 10) / 10)
  return {
    verifier_revision: REFERENCE_STYLE_VERIFIER_REVISION,
    fidelity: matchedColors.length >= colorThreshold
      && matchedFonts.length >= fontThreshold
      && matchedMarkers.length >= markerThreshold
      && colorViolations.length === 0
      && fontViolations.length === 0
      && avoidViolations.length === 0
      && sourceVerification.violations.length === 0
      ? 'pass'
      : 'mismatch',
    score,
    matched: { colors: matchedColors, fonts: matchedFonts, markers: matchedMarkers },
    missing: {
      colors: requiredColors.filter((value) => !matchedColors.includes(value)),
      fonts: contract.fonts.filter((value) => !matchedFonts.includes(value)),
      markers: requiredMarkers.filter((value) => !matchedMarkers.includes(value)),
    },
    violations: {
      colors: colorViolations,
      fonts: fontViolations,
      avoid: avoidViolations,
      source: sourceVerification.violations,
    },
    inlineVariantGaps: sourceVerification.inlineVariantGaps,
    ...(requiredColors.length < contract.colors.length ? {
      omittedAlternativeLayoutColors: contract.colors.filter((color) => !requiredColors.includes(color)),
    } : {}),
    thresholds: { colors: colorThreshold, fonts: fontThreshold, markers: markerThreshold },
  }
}

export function referenceUrlsAreRelated(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    if (!['http:', 'https:'].includes(a.protocol) || !['http:', 'https:'].includes(b.protocol)) return false
    if (a.username || a.password || b.username || b.password) return false
    const githubA = githubReferenceCoordinates(a)
    const githubB = githubReferenceCoordinates(b)
    const githubHostA = isGitHubReferenceHost(a.hostname)
    const githubHostB = isGitHubReferenceHost(b.hostname)
    if (githubHostA || githubHostB) {
      if (!githubA || !githubB) return false
      if (referenceIdentitySearch(a) !== referenceIdentitySearch(b)) return false
      if (githubA.repository !== githubB.repository) return false
      // An unrecognized README anchor is a section identity, not permission
      // to consume an arbitrary file from the same repository. Repository
      // roots without an anchor remain related so a model that drops a known
      // catalog slug can still be repaired back to its tentative source.
      if (githubA.anchor && githubB.anchor && githubA.anchor !== githubB.anchor) return false
      if (githubA.anchor && !githubA.resourcePath && githubB.resourcePath) return false
      if (githubB.anchor && !githubB.resourcePath && githubA.resourcePath) return false
      if (
        githubA.revision
        && githubB.revision
        && !githubRevisionsAreRelated(githubA.revision, githubB.revision)
      ) return false
      if (!githubA.resourcePath || !githubB.resourcePath) return true
      if (githubA.kind === 'file' && githubB.kind === 'file') {
        return githubA.resourcePath === githubB.resourcePath
      }
      if (githubA.kind === 'directory') {
        return githubB.resourcePath === githubA.resourcePath
          || githubB.resourcePath.startsWith(`${githubA.resourcePath}/`)
      }
      if (githubB.kind === 'directory') {
        return githubA.resourcePath === githubB.resourcePath
          || githubA.resourcePath.startsWith(`${githubB.resourcePath}/`)
      }
      return false
    }
    a.hash = ''
    b.hash = ''
    if (a.toString() === b.toString()) return true
    // Generic references never cross an origin boundary. Query parameters
    // remain part of the resource identity because no application-specific
    // policy proves that they are non-semantic.
    if (a.origin !== b.origin || a.search !== b.search) return false
    const aPath = a.pathname.replace(/\/+$/, '')
    const bPath = b.pathname.replace(/\/+$/, '')
    return aPath === bPath || aPath.startsWith(`${bPath}/`) || bPath.startsWith(`${aPath}/`)
  } catch {
    return false
  }
}

function githubRevisionsAreRelated(left: string, right: string): boolean {
  if (left === right) return true
  // HEAD is a default-branch alias, not a wildcard for arbitrary branches.
  // GitHub's overwhelmingly common concrete defaults are main/master; other
  // default names remain usable through HEAD itself without broadening
  // provenance to experimental or attacker-selected revisions.
  const concrete = left === 'HEAD' ? right : right === 'HEAD' ? left : undefined
  return concrete === 'main' || concrete === 'master'
}

function isGitHubReferenceHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'github.com' || host === 'raw.githubusercontent.com'
}

function referenceIdentitySearch(url: URL): string {
  if (githubRepositoryQueryIsNonSemantic(url)) return ''
  return url.search
}

function githubRepositoryQueryIsNonSemantic(url: URL): boolean {
  if (url.hostname.toLowerCase() !== 'github.com' || !url.search) return false
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 2) return false
  const entries = [...url.searchParams.entries()]
  return entries.length > 0 && entries.every(([name, value]) => (
    (name === 'tab' && value === 'readme-ov-file')
    || (name === 'utm_source' && value === 'copied-link')
  ))
}

interface GitHubReferenceCoordinates {
  repository: string
  revision?: string
  resourcePath: string
  kind: 'repository' | 'directory' | 'file'
  /** Valid repository-root README anchor, retained as resource identity. */
  anchor?: string
}

/**
 * Template catalogs commonly expose a concrete template as a README anchor on
 * the repository URL (for example `repo#paper-deck`) while storing its source
 * at `templates/paper-deck/template.html`. Preserve that anchor as resource
 * identity and produce a default-branch raw URL without trusting slashes,
 * traversal, query text, or arbitrary nested paths from the fragment.
 */
export function githubAnchoredTemplateSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.search && !githubRepositoryQueryIsNonSemantic(url)) return undefined
    const resourcePath = githubAnchoredTemplateResourcePath(url)
    if (!resourcePath) return undefined
    const segments = url.pathname.split('/').filter(Boolean)
    return new URL(
      `https://raw.githubusercontent.com/${segments[0]}/${segments[1].replace(/\.git$/iu, '')}/HEAD/${resourcePath}/template.html`,
    ).toString()
  } catch {
    return undefined
  }
}

function githubAnchoredTemplateResourcePath(url: URL): string | undefined {
  const slug = githubRepositoryAnchor(url)
  if (!slug) return undefined
  const segments = url.pathname.split('/').filter(Boolean)
  // README anchors are ambiguous. Apply the templates/<slug>/template.html
  // convention only when the repository advertises itself as a template
  // catalog; every other valid anchor stays a section-scoped identity and
  // cannot silently authorize sibling repository files.
  const repositoryName = segments[1].replace(/\.git$/iu, '')
  if (!repositoryName.split(/[-_.]+/u).some((token) => /^templates?$/iu.test(token))) return undefined
  return `templates/${slug}`
}

function githubRepositoryAnchor(url: URL): string | undefined {
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== 'github.com'
    || url.username
    || url.password
    || url.port
  ) return undefined
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 2 || !url.hash) return undefined
  let slug = ''
  try {
    slug = decodeURIComponent(url.hash.slice(1)).trim()
  } catch {
    return undefined
  }
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u.test(slug)
    || slug === '.'
    || slug === '..'
  ) return undefined
  return slug
}

function githubReferenceCoordinates(url: URL): GitHubReferenceCoordinates | undefined {
  const host = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || !isGitHubReferenceHost(host)
  ) return undefined
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2) return undefined
  const repository = `${segments[0].toLowerCase()}/${segments[1].replace(/\.git$/iu, '').toLowerCase()}`
  if (host === 'raw.githubusercontent.com') {
    return {
      repository,
      revision: segments[2],
      resourcePath: segments.slice(3).join('/'),
      kind: segments.length > 3 ? 'file' : 'repository',
    }
  }
  if (host !== 'github.com') return undefined
  if (segments.length === 2) {
    const anchor = githubRepositoryAnchor(url)
    const anchoredTemplatePath = githubAnchoredTemplateResourcePath(url)
    return anchoredTemplatePath
      ? { repository, resourcePath: anchoredTemplatePath, kind: 'directory', anchor }
      : { repository, resourcePath: '', kind: 'repository', ...(anchor ? { anchor } : {}) }
  }
  const route = segments[2]
  if (route === 'tree' && segments.length >= 4) {
    return {
      repository,
      revision: segments[3],
      resourcePath: segments.slice(4).join('/'),
      kind: segments.length > 4 ? 'directory' : 'repository',
    }
  }
  if (['blob', 'raw'].includes(route) && segments.length >= 5) {
    const resourcePath = segments.slice(4).join('/')
    const finalSegment = segments.at(-1) ?? ''
    return {
      repository,
      revision: segments[3],
      resourcePath,
      // Some GitHub links in persisted Sessions use /blob/ for a directory.
      // Treat only extensionless blob targets as directories so their raw
      // design.md/template.html children remain related without broadening the
      // relationship to sibling templates in the repository.
      kind: route === 'blob' && !finalSegment.includes('.') ? 'directory' : 'file',
    }
  }
  // GitHub action/settings/issues URLs are not source descendants.
  return undefined
}

function toolCallsById(messages: readonly ModelMessage[]): Map<string, { call: ToolCallRecord; index: number }> {
  const calls = new Map<string, { call: ToolCallRecord; index: number }>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    for (const call of message.tool_calls ?? []) {
      let args: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(call.function.arguments) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
      } catch {
        // Invalid calls cannot establish reference provenance.
      }
      calls.set(call.id, { call: { id: call.id, name: call.function.name, arguments: args }, index })
    }
  }
  return calls
}

function structuredPayload(content: string | null | undefined): Record<string, unknown> | undefined {
  if (typeof content !== 'string') return undefined
  try {
    const parsed = JSON.parse(content) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function boundedStringArray(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  maxCharacters: number,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  const normalized = [...new Set(value.map((item) => requiredBoundedString(item, name, maxCharacters)))]
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`${name} must contain between ${minimum} and ${maximum} unique values`)
  }
  return normalized
}

function boundedNormalizedStringArray(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  maxCharacters: number,
  normalize: (value: string) => string | undefined,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    const entryName = `${name}[${index}]`
    const raw = requiredBoundedString(item, entryName, maxCharacters)
    const token = normalize(raw)
    if (!token) {
      throw new Error(`${entryName} ${JSON.stringify(raw)} must contain one concrete source token, not a generic label`)
    }
    const key = normalizeStyleText(token)
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(token)
  }
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`${name} must contain between ${minimum} and ${maximum} unique concrete values`)
  }
  return normalized
}

function boundedColorStringArray(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  maxCharacters: number,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const raw = requiredBoundedString(item, name, maxCharacters)
    const tokens = raw.match(STYLE_COLOR_PATTERN) ?? []
    if (tokens.length === 0) throw new Error(`${name} entries must contain one concrete CSS color token, not a generic label`)
    for (const token of tokens) {
      const canonical = normalizeCssColorToken(token)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      normalized.push(canonical)
    }
  }
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`${name} must contain between ${minimum} and ${maximum} unique concrete values`)
  }
  return normalized
}

function requiredBoundedString(value: unknown, name: string, maxCharacters: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  const normalized = value.trim()
  if (normalized.length > maxCharacters) throw new Error(`${name} exceeds ${maxCharacters} characters`)
  return normalized
}

function normalizeStyleText(value: string): string {
  return value.toLowerCase().replace(/[\s'"`]+/gu, '')
}

interface DomConnectedVisualTokens {
  colors: Set<string>
  fonts: Set<string>
  selectors: Set<string>
  properties: Set<string>
  variables: Set<string>
  domClasses: Set<string>
  domIds: Set<string>
  domTags: Set<string>
}

function normalizeCssColorToken(value: string): string {
  // Parsed declarations already normalize leading decimals. Match the same
  // authored number in contract tokens without rounding or changing alpha.
  return value.trim().toLowerCase().replace(/\s+/gu, '')
    .replace(/(^|[(:,/])([+-]?)\.(\d)/gu, '$1$20.$3')
}

function normalizeFontFamilyToken(value: string): string {
  return value.trim().toLowerCase().replace(/^['"]|['"]$/gu, '').replace(/\s+/gu, ' ')
}

function cssRuleIsVisiblyConnected(
  rule: ParsedCssRule,
  dom: DomSnapshot,
  rules: readonly ParsedCssRule[],
  runtimeManagedSlideSelectors: ReadonlySet<string>,
): boolean {
  const displayHidden = rule.declarations.get('display') === 'none'
  const visibilityHidden = ['hidden', 'collapse'].includes(rule.declarations.get('visibility') ?? '')
  if (displayHidden || visibilityHidden) {
    // A self-contained slide runtime commonly hides the base root and exposes
    // one `.active` refinement. The base rule still paints that real visible
    // instance, so its palette and selector are connected evidence. Keep this
    // exception bound to Browser-attested slide roots and require one concrete
    // DOM-matching state rule that explicitly reverses every hidden property;
    // an arbitrary hidden token-stuffing selector remains inert.
    const activated = runtimeManagedSlideSelectors.has(rule.selector)
      && runtimeSlideHasVisibleInstance(rule, dom, rules)
    if (!activated) return false
  }
  const base = rule.selector.replace(/::(?:before|after)$/iu, '')
  if (base === ':root') return dom.tags.has('html')
  return selectorIdentifiersShareRelationship(rule.selector, dom)
}

function runtimeSlideHasVisibleInstance(
  base: ParsedCssRule,
  dom: DomSnapshot,
  rules: readonly ParsedCssRule[],
): boolean {
  // `.slide.active` can override `deck-stage > section.slide` without sharing
  // its textual prefix. Prove that both selectors target the SAME element,
  // then resolve the actual visibility cascade. An unrelated active element,
  // a weaker rule, or a later hide must not turn inert CSS into evidence.
  // Dynamic/functional selectors need Browser evidence; do not approximate
  // :hover, :not(...), attribute state or pseudo-elements as currently active.
  const simple = (selector: string) => /^[\w.#*>\s-]+$/u.test(selector)
  if (!simple(base.selector)) return false
  const properties = ['display', 'visibility', 'opacity'] as const
  const candidates = rules.filter((rule) => simple(rule.selector)).map((rule, order) => ({
    rule,
    order,
    specificity: [
      (rule.selector.match(/#/gu) ?? []).length,
      (rule.selector.match(/\./gu) ?? []).length,
      selectorCompoundFragments(rule.selector).filter((part) => /^[a-z]/iu.test(part)).length,
    ],
  }))
  return dom.identifierPaths.some((path) => {
    if (!selectorMatchesIdentifierPath(base.selector, path, true)) return false
    const winners = new Map<string, { value: string; rank: number[] }>()
    for (const { rule, order, specificity } of candidates) {
      if (!selectorMatchesIdentifierPath(rule.selector, path, true)) continue
      for (const property of properties) {
        const value = rule.declarations.get(property)
        if (value === undefined) continue
        const rank = [rule.importantProperties?.has(property) ? 1 : 0, ...specificity, order]
        const previous = winners.get(property)
        const difference = previous ? rank.findIndex((value, index) => value !== previous.rank[index]) : -1
        if (!previous || (difference >= 0 && rank[difference] > previous.rank[difference])) {
          winners.set(property, { value, rank })
        }
      }
    }
    const display = winners.get('display')?.value
    const visibility = winners.get('visibility')?.value
    const opacity = winners.get('opacity')?.value
    return (display === undefined || /^(?:block|inline|inline-block|flex|inline-flex|grid|inline-grid|table|contents|flow-root)$/u.test(display))
      && (visibility === undefined || visibility === 'visible')
      && (opacity === undefined || (Number.isFinite(Number(opacity)) && Number(opacity) > 0))
  })
}

/**
 * Extract only exact tokens carried by CSS rules that can apply to the real,
 * non-inert DOM. This prevents an unused selector, comment, script string, or
 * substring (for example Inter inside Interstate) from satisfying exact mode.
 */
function domConnectedVisualTokens(
  html: string,
  viewport: { width: number; height: number },
  runtimeManagedSlideSelectors: ReadonlySet<string> = new Set(),
): DomConnectedVisualTokens {
  const dom = extractDomSnapshot(html)
  const cascadeRules = extractCssRules(html, viewport)
  const parsedRules = mergeCssRules(cascadeRules)
  const rules = parsedRules.filter((rule) => cssRuleIsVisiblyConnected(
    rule,
    dom,
    cascadeRules,
    runtimeManagedSlideSelectors,
  ))
  const colors = new Set<string>()
  const fonts = new Set<string>()
  const selectors = new Set<string>()
  const properties = new Set<string>()
  const variables = new Set<string>()
  const variableValues = new Map<string, string>()
  const referencedVariables = new Set<string>()
  const fontVariables = new Set<string>()
  const paintVariables = new Set<string>()

  for (const rule of rules) {
    selectors.add(rule.selector)
    for (const identifier of selectorIdentifiers(rule.selector)) selectors.add(identifier)
    for (const fragment of selectorCompoundFragments(rule.selector)) selectors.add(fragment)
    for (const [property, value] of rule.declarations) {
      properties.add(property)
      if (property.startsWith('--')) variableValues.set(property, value)
      else if (CSS_PAINT_PROPERTY.test(property)) {
        for (const color of paintValue(value).match(STYLE_COLOR_PATTERN) ?? []) colors.add(normalizeCssColorToken(color))
      }
      for (const reference of value.matchAll(/var\(\s*(--[a-z][\w-]*)/giu)) {
        const variable = reference[1].toLowerCase()
        referencedVariables.add(variable)
        if (property === 'font-family') fontVariables.add(variable)
        if (CSS_PAINT_PROPERTY.test(property)) paintVariables.add(variable)
      }
      if (property === 'font-family') {
        for (const family of value.split(',')) {
          const normalized = normalizeFontFamilyToken(family)
          if (normalized && !normalized.startsWith('var(')) fonts.add(normalized)
        }
      }
    }
  }

  // Resolve bounded custom-property chains so a palette/font variable counts
  // only when a connected rule actually consumes it.
  for (let pass = 0; pass < 32; pass += 1) {
    let changed = false
    for (const variable of [...referencedVariables]) {
      const value = variableValues.get(variable)
      if (!value) continue
      for (const reference of value.matchAll(/var\(\s*(--[a-z][\w-]*)/giu)) {
        const nested = reference[1].toLowerCase()
        if (!referencedVariables.has(nested)) {
          referencedVariables.add(nested)
          changed = true
        }
        if (fontVariables.has(variable) && !fontVariables.has(nested)) {
          fontVariables.add(nested)
          changed = true
        }
        if (paintVariables.has(variable) && !paintVariables.has(nested)) {
          paintVariables.add(nested)
          changed = true
        }
      }
    }
    if (!changed) break
  }
  for (const variable of referencedVariables) {
    const value = variableValues.get(variable)
    if (!value) continue
    variables.add(variable)
    if (paintVariables.has(variable)) {
      for (const color of paintValue(value).match(STYLE_COLOR_PATTERN) ?? []) colors.add(normalizeCssColorToken(color))
    }
    if (fontVariables.has(variable)) {
      for (const family of value.split(',')) {
        const normalized = normalizeFontFamilyToken(family)
        if (normalized && !normalized.startsWith('var(')) fonts.add(normalized)
      }
    }
  }

  return {
    colors,
    fonts,
    selectors,
    properties,
    variables,
    domClasses: new Set(dom.classes.keys()),
    domIds: new Set(dom.ids),
    domTags: new Set(dom.tags),
  }
}

function domConnectedMarkerIsGrounded(marker: string, tokens: DomConnectedVisualTokens): boolean {
  const normalized = normalizeCssSelector(marker)
  if (normalized.startsWith('--')) return tokens.variables.has(normalized)
  const identifiers = selectorIdentifiers(normalized)
  if (identifiers.length > 0) {
    // `tokens.selectors` contains a full selector only after its parsed rule was
    // proven against one real DOM relationship. Requiring that exact selector
    // keeps unused-selector stuffing out while allowing valid compounds such
    // as `.slide.active` whose classes coexist on the same element.
    return tokens.selectors.has(normalized)
      && identifiers.every((identifier) => (
        identifier.startsWith('.')
          ? tokens.domClasses.has(identifier.slice(1))
          : tokens.domIds.has(identifier.slice(1))
      ))
      && selectorTypeNames(normalized).every((tagName) => tokens.domTags.has(tagName))
  }
  if (concreteCustomElementName(normalized)
    && tokens.domTags.has(normalized)
    && tokens.selectors.has(normalized)) return true
  if (tokens.properties.has(normalized) || tokens.selectors.has(normalized)) return true
  return tokens.domClasses.has(normalized) && tokens.selectors.has(`.${normalized}`)
}

function normalizeContractFont(value: string): string | undefined {
  const quoted = value.match(/['"]([^'"]{2,80})['"]/u)?.[1]?.trim()
  const candidate = quoted ?? value
    .replace(/^(?:font(?:-family)?|display|body|heading|headlines?|chrome)\s*[:=]\s*/iu, '')
    .split(/\s+(?=\d{3}(?:\s*[-–]\s*\d{3})?\b)|\s*\(|,\s*(?:sans-serif|serif|monospace|system-ui)\b/iu)[0]
    ?.trim()
  if (!candidate || candidate.length > 80 || /^(?:sans-serif|serif|monospace|system-ui|font-family|font)$/iu.test(candidate)) return undefined
  return candidate
}

/**
 * Normalize one model-authored marker using the same grammar as the durable
 * StyleContract validator and phase repair. Custom elements and bounded CSS
 * relationships are first-class source tokens; template-specific word lists
 * are intentionally not used here.
 */
export function normalizeReferenceContractMarker(value: string): string | undefined {
  const trimmed = value.trim()
  const leadingVariable = trimmed.match(/^--[a-z][\w-]+/iu)?.[0]
  if (leadingVariable) return leadingVariable.toLowerCase()

  const structural = trimmed.toLowerCase()
  if (STRUCTURAL_REFERENCE_MARKERS.has(structural)) return structural

  const selector = analyzeConcreteCssSelector(trimmed)
  if (selector?.distinctive) return selector.normalized

  const identifier = trimmed.match(/[.#]-?[_a-z][\w-]{2,}/iu)?.[0]
  if (identifier) return identifier.toLowerCase()

  for (const candidate of trimmed.matchAll(/(?:^|[^\w-])([a-z][\w]*-[\w-]*[a-z0-9])(?=$|[^\w-])/giu)) {
    const customElement = concreteCustomElementName(candidate[1])
    if (customElement) return customElement
  }

  const structuralInProse = trimmed.match(/\b(?:clip-path|grid-template(?:-columns|-rows)?)\b/iu)?.[0]?.toLowerCase()
  if (structuralInProse) return structuralInProse
  const embeddedVariable = trimmed.match(/--[a-z][\w-]+/iu)?.[0]
  if (embeddedVariable) return embeddedVariable.toLowerCase()
  return undefined
}

function referenceContractMarkerIsDistinctive(marker: string): boolean {
  if (/^--[a-z][\w-]+$/u.test(marker) || STRUCTURAL_REFERENCE_MARKERS.has(marker)) return true
  return analyzeConcreteCssSelector(marker)?.distinctive === true
    || /[.#][a-z][\w-]{2,}/iu.test(marker)
}

interface ConcreteCssSelectorAnalysis {
  normalized: string
  distinctive: boolean
}

function analyzeConcreteCssSelector(value: string): ConcreteCssSelectorAnalysis | undefined {
  const normalized = normalizeCssSelector(value)
  if (!normalized || normalized.length > 300 || /[,{};]/u.test(normalized)) return undefined
  const surface = selectorRelationshipSurface(normalized)
  if (!surface
    || /^[>+~]/u.test(surface)
    || /[>+~]$/u.test(surface)
    || /[>+~]{2}/u.test(surface)) return undefined
  const compounds = surface.split(/(?:[>+~]|\s+)/u).filter(Boolean)
  if (compounds.length === 0) return undefined
  let distinctive = false
  for (const compound of compounds) {
    const match = compound.match(/^(?:(\*|[a-z][\w-]*))?((?:[.#]-?[_a-z][\w-]*)*)$/iu)
    if (!match || (!match[1] && !match[2])) return undefined
    const tagName = match[1]?.toLowerCase()
    if (tagName && tagName !== '*') {
      const customElement = concreteCustomElementName(tagName)
      if (!STANDARD_HTML_SELECTOR_TAGS.has(tagName) && !customElement) return undefined
      if (customElement) distinctive = true
    }
    for (const identifier of selectorIdentifiers(compound)) {
      if (identifier.slice(1).length >= 3) distinctive = true
    }
  }
  return { normalized, distinctive }
}

function concreteCustomElementName(value: string): string | undefined {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z][\w]*-[\w-]*[a-z0-9]$/u.test(normalized)
    || SOURCE_PROFILE_PROPERTIES.has(normalized)
    || STRUCTURAL_REFERENCE_MARKERS.has(normalized)) return undefined
  return normalized
}

interface ParsedCssRule {
  selector: string
  declarations: Map<string, string>
  importantProperties?: Set<string>
}

interface DomClassUsage {
  count: number
  inline: Map<string, Set<string>>
}

interface DomSnapshot {
  classes: Map<string, DomClassUsage>
  ids: Set<string>
  tags: Set<string>
  hiddenClasses: Map<string, Set<string>>
  hiddenIds: Map<string, Set<string>>
  semanticallyHiddenClasses: Map<string, Set<string>>
  semanticallyHiddenIds: Map<string, Set<string>>
  identifierPaths: Array<Array<Set<string>>>
  /** Visible elements in source order, represented by their tag/class/id identifiers. */
  elements: Array<Set<string>>
}

function boundGeneratedSourceProfile(
  profile: ReferenceStyleSourceProfile,
  protectedRuleSelectors: ReadonlySet<string> = new Set(),
): ReferenceStyleSourceProfile {
  const bounded: ReferenceStyleSourceProfile = {
    ...profile,
    rules: profile.rules.map((rule) => ({
      ...rule,
      declarations: rule.declarations.map((declaration) => ({ ...declaration })),
    })),
    dom: profile.dom.map((entry) => ({
      ...entry,
      ...(entry.inlineStyleVariants ? {
        inlineStyleVariants: entry.inlineStyleVariants.map((variant) => ({ ...variant, values: [...variant.values] })),
      } : {}),
    })),
  }
  const exceedsBudget = () => Buffer.byteLength(JSON.stringify(bounded)) > SOURCE_PROFILE_MAX_BYTES
  const removeLastRule = (predicate: (rule: ReferenceStyleRuleProfile, index: number) => boolean): boolean => {
    for (let index = bounded.rules.length - 1; index >= 0; index -= 1) {
      if (protectedRuleSelectors.has(bounded.rules[index].selector)
        || !predicate(bounded.rules[index], index)) continue
      bounded.rules.splice(index, 1)
      return true
    }
    return false
  }
  const trimLastDeclaration = (predicate: (rule: ReferenceStyleRuleProfile) => boolean, minimum: number): boolean => {
    for (let index = bounded.rules.length - 1; index >= 0; index -= 1) {
      const rule = bounded.rules[index]
      if (protectedRuleSelectors.has(rule.selector)
        || !predicate(rule)
        || rule.declarations.length <= minimum) continue
      rule.declarations.pop()
      return true
    }
    return false
  }
  while (exceedsBudget()) {
    if (bounded.rules.length > 24 && removeLastRule((rule) => !rule.requiredInDom)) continue
    if (trimLastDeclaration((rule) => !rule.requiredInDom, 6)) continue
    if (bounded.rules.length > 12 && removeLastRule((rule) => !rule.requiredInDom)) continue
    if (trimLastDeclaration((rule) => rule.requiredInDom, 8)) continue
    if (removeLastRule((rule) => !rule.requiredInDom)) continue
    if (bounded.dom.length > 0) {
      let optionalDomIndex = -1
      for (let index = bounded.dom.length - 1; index >= 0; index -= 1) {
        if (bounded.dom[index].required) continue
        optionalDomIndex = index
        break
      }
      if (optionalDomIndex >= 0) {
        bounded.dom.splice(optionalDomIndex, 1)
        continue
      }
    }
    if (trimLastDeclaration(() => true, 1)) continue
    if (bounded.rules.length > 1 && removeLastRule(() => true)) continue
    if (bounded.dom.length > 0) {
      bounded.dom.pop()
      continue
    }
    // Palette carriers normally contain a single declaration and are tiny.
    // Keep this final fallback only for adversarial inputs where protected
    // evidence alone somehow exceeds the global serialization budget.
    if (bounded.rules.length > 1) {
      bounded.rules.pop()
      continue
    }
    break
  }
  return bounded
}

function optionalProfileFont(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return normalizeCssDeclarationValue('font-family', requiredBoundedString(value, name, 120))
}

function extractCssRules(content: string, viewport?: { width: number; height: number }): ParsedCssRule[] {
  const sources = new Set<string>()
  const collectStyleBlocks = (value: string) => {
    for (const match of value.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)) {
      if (match[1]?.trim()) sources.add(match[1])
    }
  }
  collectStyleBlocks(content)
  for (const match of content.matchAll(/```\s*(css|html?)?\s*\n([\s\S]*?)```/giu)) {
    const language = match[1]?.toLowerCase()
    const body = match[2] ?? ''
    if (language === 'css') sources.add(body)
    else collectStyleBlocks(body)
  }
  if (sources.size === 0 && /(?:^|[}\s])[.#]?-?[_a-z][\w.#:[\]()>+~="'-]*\s*\{[^{}]*:/imu.test(content)) {
    sources.add(staticVisualSurface(content).replace(/<[^>]+>/gu, ' '))
  }
  const rules: ParsedCssRule[] = []
  for (const source of sources) {
    parseCssRuleList(source.replace(/\/\*[\s\S]*?\*\//gu, ' '), rules, viewport)
    if (rules.length >= 2_048) break
  }
  return rules.slice(0, 2_048)
}

function parseCssRuleList(
  css: string,
  output: ParsedCssRule[],
  viewport?: { width: number; height: number },
): void {
  let statementStart = 0
  let quote = ''
  let escaped = false
  let parentheses = 0
  let brackets = 0
  for (let index = 0; index < css.length && output.length < 2_048; index += 1) {
    const character = css[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') parentheses += 1
    else if (character === ')') parentheses = Math.max(0, parentheses - 1)
    else if (character === '[') brackets += 1
    else if (character === ']') brackets = Math.max(0, brackets - 1)
    if (parentheses > 0 || brackets > 0) continue
    if (character === ';') {
      statementStart = index + 1
      continue
    }
    if (character !== '{') continue
    const header = css.slice(statementStart, index).trim()
    const close = findCssBlockEnd(css, index)
    if (close < 0) return
    const body = css.slice(index + 1, close)
    if (/^@media\b/iu.test(header)) {
      if (!viewport || mediaQueryMatchesViewport(header, viewport)) parseCssRuleList(body, output, viewport)
    } else if (/^@(supports|layer|container|scope|document)\b/iu.test(header)) {
      parseCssRuleList(body, output, viewport)
    } else if (header && !header.startsWith('@')) {
      const importantProperties = new Set<string>()
      const declarations = parseCssDeclarations(body, importantProperties)
      if (declarations.size > 0) {
        for (const selector of splitCssSelectors(header)) {
          const normalized = normalizeCssSelector(selector)
          if (normalized) output.push({ selector: normalized, declarations: new Map(declarations), importantProperties })
          if (output.length >= 2_048) break
        }
      }
    }
    index = close
    statementStart = close + 1
  }
}

function findCssBlockEnd(css: string, openIndex: number): number {
  let depth = 1
  let quote = ''
  let escaped = false
  for (let index = openIndex + 1; index < css.length; index += 1) {
    const character = css[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return index
  }
  return -1
}

function splitCssSelectors(value: string): string[] {
  const selectors: string[] = []
  let start = 0
  let quote = ''
  let escaped = false
  let parentheses = 0
  let brackets = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses = Math.max(0, parentheses - 1)
    else if (character === '[') brackets += 1
    else if (character === ']') brackets = Math.max(0, brackets - 1)
    else if (character === ',' && parentheses === 0 && brackets === 0) {
      selectors.push(value.slice(start, index))
      start = index + 1
    }
  }
  selectors.push(value.slice(start))
  return selectors
}

function mediaQueryMatchesViewport(
  header: string,
  viewport: { width: number; height: number },
): boolean {
  const queryList = header.replace(/^@media\s*/iu, '')
  return splitCssSelectors(queryList).some((rawQuery) => {
    let query = rawQuery.trim().toLowerCase()
    const negated = /^not\b/u.test(query)
    if (negated) query = query.replace(/^not\s+/u, '')
    let matches = !/\bprint\b/u.test(query)
    let sawViewportConstraint = false
    for (const condition of query.matchAll(/\(\s*(min|max)-(width|height)\s*:\s*([\d.]+)\s*(px|em|rem)\s*\)/gu)) {
      sawViewportConstraint = true
      const threshold = Number(condition[3]) * (condition[4] === 'px' ? 1 : 16)
      const actual = condition[2] === 'width' ? viewport.width : viewport.height
      if (!Number.isFinite(threshold)) return false
      if (condition[1] === 'min' ? actual < threshold : actual > threshold) matches = false
    }
    const unitPixels = (amount: string, unit: string) => Number(amount) * (unit === 'px' ? 1 : 16)
    for (const condition of query.matchAll(/\(\s*(width|height)\s*(<=|>=|<|>)\s*([\d.]+)\s*(px|em|rem)\s*\)/gu)) {
      sawViewportConstraint = true
      const actual = condition[1] === 'width' ? viewport.width : viewport.height
      const threshold = unitPixels(condition[3], condition[4])
      if (!Number.isFinite(threshold) || !rangeComparisonMatches(actual, condition[2], threshold)) matches = false
    }
    for (const condition of query.matchAll(/\(\s*([\d.]+)\s*(px|em|rem)\s*(<=|>=|<|>)\s*(width|height)\s*\)/gu)) {
      sawViewportConstraint = true
      const threshold = unitPixels(condition[1], condition[2])
      const actual = condition[4] === 'width' ? viewport.width : viewport.height
      if (!Number.isFinite(threshold) || !rangeComparisonMatches(threshold, condition[3], actual)) matches = false
    }
    // Unknown width/height syntax must not overwrite the desktop baseline.
    if (!sawViewportConstraint && /\(\s*(?:min-|max-)?(?:width|height)\b/gu.test(query)) matches = false
    return negated ? !matches : matches
  })
}

function rangeComparisonMatches(left: number, operator: string, right: number): boolean {
  if (operator === '<') return left < right
  if (operator === '<=') return left <= right
  if (operator === '>') return left > right
  return left >= right
}

function parseCssDeclarations(value: string, importantProperties = new Set<string>()): Map<string, string> {
  const declarations = new Map<string, string>()
  const chunks: string[] = []
  let start = 0
  let quote = ''
  let escaped = false
  let parentheses = 0
  let brackets = 0
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index] ?? ';'
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses = Math.max(0, parentheses - 1)
    else if (character === '[') brackets += 1
    else if (character === ']') brackets = Math.max(0, brackets - 1)
    else if (character === ';' && parentheses === 0 && brackets === 0) {
      chunks.push(value.slice(start, index))
      start = index + 1
    }
  }
  for (const chunk of chunks.slice(0, 256)) {
    const separator = declarationColonIndex(chunk)
    if (separator < 1) continue
    const property = chunk.slice(0, separator).trim().toLowerCase()
    // Parse bounded source declarations before applying any summary policy.
    // The profile projector still selects SOURCE_PROFILE_PROPERTIES below;
    // evidence consumers must not mistake omitted summary fields for absence.
    if (!/^(?:--[a-z][\w-]*|-?[a-z][\w-]*)$/u.test(property)) continue
    const rawValue = chunk.slice(separator + 1).trim()
    if (!rawValue || rawValue.length > 2_000) continue
    const important = /!important\s*$/iu.test(rawValue)
    if (!important && importantProperties.has(property)) continue
    if (important) importantProperties.add(property)
    declarations.set(property, normalizeCssDeclarationValue(property, rawValue))
  }
  return declarations
}

function declarationColonIndex(value: string): number {
  let quote = ''
  let escaped = false
  let parentheses = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses = Math.max(0, parentheses - 1)
    else if (character === ':' && parentheses === 0) return index
  }
  return -1
}

function normalizeCssSelector(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/\s*([>+~])\s*/gu, '$1')
    .toLowerCase()
}

function normalizeCssDeclarationValue(property: string, value: string): string {
  let normalized = value
    .replace(/\s*!important\s*$/iu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/\(\s+/gu, '(')
    .replace(/\s+\)/gu, ')')
    .replace(/\s*,\s*/gu, ',')
    .replace(/(^|[\s(:,])([+-]?)\.(\d)/gu, '$1$20.$3')
    .replace(/(^|[\s(:,])0(?:px|rem|em|%|vh|vw|vmin|vmax)\b/gu, '$10')
  if (property === 'font-family') normalized = normalized.replace(/["']/gu, '')
  return normalized.slice(0, 240)
}

function mergeCssRules(rules: readonly ParsedCssRule[]): ParsedCssRule[] {
  const merged = new Map<string, ParsedCssRule>()
  for (const rule of rules) {
    const prior = merged.get(rule.selector)
    if (!prior) {
      merged.set(rule.selector, { selector: rule.selector, declarations: new Map(rule.declarations), importantProperties: new Set(rule.importantProperties) })
      continue
    }
    for (const [property, value] of rule.declarations) {
      if (prior.importantProperties?.has(property) && !rule.importantProperties?.has(property)) continue
      prior.declarations.set(property, value)
      if (rule.importantProperties?.has(property)) prior.importantProperties?.add(property)
    }
  }
  return [...merged.values()]
}

function prioritizedProfileDeclarations(declarations: ReadonlyMap<string, string>): ReferenceStyleDeclarationProfile[] {
  return [...declarations]
    .filter(([property]) => SOURCE_PROFILE_PROPERTIES.has(property))
    .sort(([left], [right]) => profilePropertyRank(left) - profilePropertyRank(right) || left.localeCompare(right))
    .slice(0, SOURCE_PROFILE_MAX_DECLARATIONS)
    .map(([property, value]) => ({ property, value }))
}

function profilePropertyRank(property: string): number {
  const index = SOURCE_PROFILE_PROPERTY_PRIORITY.indexOf(property as (typeof SOURCE_PROFILE_PROPERTY_PRIORITY)[number])
  return index < 0 ? SOURCE_PROFILE_PROPERTY_PRIORITY.length : index
}

function selectorIdentifiers(selector: string): string[] {
  const identifiers: string[] = []
  const seen = new Set<string>()
  const surface = selector.replace(/\[[^\]]*\]/gu, ' ')
  for (const match of surface.matchAll(/([.#])(-?[_a-z][\w-]*)/giu)) {
    const identifier = `${match[1]}${match[2].toLowerCase()}`
    if (seen.has(identifier)) continue
    seen.add(identifier)
    identifiers.push(identifier)
  }
  return identifiers
}

function selectorRelationshipSurface(selector: string): string | undefined {
  const withoutAttributes = selector.replace(/\[[^\]\r\n]{0,160}\]/gu, '')
  if (/[\[\]]/u.test(withoutAttributes)) return undefined
  const withoutPseudos = withoutAttributes.replace(/::?[-a-z][\w-]*(?:\([^()\r\n]{0,160}\))?/giu, '')
  if (/[:()]/u.test(withoutPseudos)) return undefined
  return withoutPseudos.trim()
}

function selectorCompoundFragments(selector: string): string[] {
  const surface = selectorRelationshipSurface(normalizeCssSelector(selector))
  if (!surface) return []
  return surface.split(/(?:[>+~]|\s+)/u).filter(Boolean)
}

function selectorTypeNames(selector: string): string[] {
  const typeNames: string[] = []
  for (const compound of selectorCompoundFragments(selector)) {
    const tagName = compound.match(/^[a-z][\w-]*/iu)?.[0]?.toLowerCase()
    if (tagName && !typeNames.includes(tagName)) typeNames.push(tagName)
  }
  return typeNames
}

function terminalSelectorIdentifier(selector: string): string | undefined {
  const surface = selector.replace(/\[[^\]]*\]/gu, ' ')
  const matches = [...surface.matchAll(/([.#])(-?[_a-z][\w-]*)/giu)]
  const last = matches.at(-1)
  if (!last || last.index === undefined) return undefined
  const tail = surface.slice(last.index + last[0].length).trim()
  // A pseudo-class/element still targets the preceding class or id. A later
  // type selector/combinator means that identifier is only an ancestor.
  if (tail && (!tail.startsWith(':') || /\s|[>+~]/u.test(tail))) return undefined
  return `${last[1]}${last[2].toLowerCase()}`
}

function classNamesAreRelated(left: string, right: string): boolean {
  if (left === right) return true
  if (Math.min(left.length, right.length) < 5) return false
  return left.startsWith(`${right}-`) || right.startsWith(`${left}-`)
}

function compatibleCandidateRule(
  expectedSelector: string,
  candidateRules: readonly ParsedCssRule[],
  candidateDom: DomSnapshot,
): ParsedCssRule | undefined {
  const expectedIdentifiers = selectorIdentifiers(expectedSelector)
  if (expectedIdentifiers.length === 0 || expectedIdentifiers.some((identifier) => identifier.startsWith('#'))) return undefined
  for (const candidateRule of candidateRules) {
    const candidateIdentifiers = selectorIdentifiers(candidateRule.selector)
    if (candidateIdentifiers.length !== expectedIdentifiers.length) continue
    const allRelated = expectedIdentifiers.every((expected, index) => {
      const candidate = candidateIdentifiers[index]
      return expected.startsWith('.')
        && candidate?.startsWith('.')
        && candidateDom.classes.has(candidate.slice(1))
        && classNamesAreRelated(expected.slice(1), candidate.slice(1))
    })
    if (allRelated) return candidateRule
  }
  return undefined
}

function selectorIdentifiersExist(identifiers: readonly string[], dom: DomSnapshot): boolean {
  return identifiers.every((identifier) => identifier.startsWith('.')
    ? dom.classes.has(identifier.slice(1))
    : dom.ids.has(identifier.slice(1)))
}

function selectorIdentifiersShareRelationship(selector: string, dom: DomSnapshot): boolean {
  return dom.identifierPaths.some((path) => selectorMatchesIdentifierPath(selector, path))
}

function selectorMatchesIdentifierPath(
  selector: string,
  path: Array<Set<string>>,
  terminalOnly = false,
): boolean {
  const relationshipSurface = selectorRelationshipSurface(selector)
  if (!relationshipSurface) return false
  const surface = relationshipSurface
    .replace(/\s*([>+~])\s*/gu, ' $1 ')
    .trim()
  const tokens = surface.split(/\s+/gu).filter(Boolean)
  const compounds: string[][] = []
  const combinators: string[] = []
  let pending: string | undefined
  for (const token of tokens) {
    if (/^[>+~]$/u.test(token)) {
      pending = token
      continue
    }
    const identifiers = selectorIdentifiers(token)
    const tagName = token.match(/^[a-z][\w-]*/iu)?.[0]?.toLowerCase()
    const relationshipIdentifiers = [
      ...(tagName ? [`@${tagName}`] : []),
      ...identifiers,
    ]
    if (relationshipIdentifiers.length === 0 && token !== '*') return false
    if (compounds.length > 0) combinators.push(pending ?? ' ')
    compounds.push(relationshipIdentifiers)
    pending = undefined
  }
  if (compounds.length === 0) return false
  if (compounds.length === 1) {
    return (terminalOnly ? path.slice(-1) : path).some((nodeIdentifiers) => (
      compounds[0].every((identifier) => nodeIdentifiers.has(identifier))
    ))
  }
  if (combinators.some((entry) => entry === '+' || entry === '~')) return false
    const visit = (compoundIndex: number, pathIndex: number): boolean => {
      if (!compounds[compoundIndex].every((identifier) => path[pathIndex]?.has(identifier))) return false
      if (compoundIndex === compounds.length - 1) return !terminalOnly || pathIndex === path.length - 1
      if (combinators[compoundIndex] === '>') return pathIndex + 1 < path.length && visit(compoundIndex + 1, pathIndex + 1)
      for (let next = pathIndex + 1; next < path.length; next += 1) {
        if (visit(compoundIndex + 1, next)) return true
      }
      return false
    }
    return path.some((_, index) => visit(0, index))
}

function selectorTargetsHeading(selector: string): boolean {
  return /(?:^|[\s>+~])h[1-6](?:$|[.#:[\s>+~])/iu.test(selector)
}

function globalFontFamily(rules: readonly ParsedCssRule[], selectors: readonly string[]): string | undefined {
  let result: string | undefined
  for (const rule of rules) {
    if (!selectors.includes(rule.selector)) continue
    result = rule.declarations.get('font-family') ?? result
  }
  return result
}

function extractDomSnapshot(content: string): DomSnapshot {
  const classes = new Map<string, DomClassUsage>()
  const ids = new Set<string>()
  const tags = new Set<string>()
  const hiddenClasses = new Map<string, Set<string>>()
  const hiddenIds = new Map<string, Set<string>>()
  const semanticallyHiddenClasses = new Map<string, Set<string>>()
  const semanticallyHiddenIds = new Map<string, Set<string>>()
  const identifierPaths: Array<Array<Set<string>>> = []
  const elements: Array<Set<string>> = []
  const stack: Array<{
    tagName: string
    hiddenReason?: string
    semanticHiddenReasons?: string[]
    identifierPath: Array<Set<string>>
  }> = []
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
  for (const tag of content.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/giu)) {
    if (tag[0].startsWith('<!--')) continue
    const tagName = tag[1]?.toLowerCase()
    if (!tagName) continue
    if (/^<\//u.test(tag[0])) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const closed = stack.pop()
        if (closed?.tagName === tagName) break
      }
      continue
    }
    const attributes = tag[2] ?? ''
    const classValue = htmlAttributeValue(attributes, 'class')
    const idValue = htmlAttributeValue(attributes, 'id')
    const styleValue = htmlAttributeValue(attributes, 'style')
    const inline = styleValue ? parseCssDeclarations(styleValue) : new Map<string, string>()
    const inlineHidden = inline.get('display') === 'none'
      ? 'inline display:none'
      : inline.get('visibility') === 'hidden' || inline.get('visibility') === 'collapse'
        ? `inline visibility:${inline.get('visibility')}`
        : /^0(?:\.0+)?$/u.test(inline.get('opacity') ?? '')
          ? 'inline opacity:0'
          : undefined
    // `aria-hidden` and `inert` remove accessibility/interaction semantics,
    // not paint. Decorative reference artwork commonly uses aria-hidden and
    // must remain eligible for a visual StyleContract.
    const ownHiddenReason = ['template', 'noscript', 'script', 'style'].includes(tagName)
      ? `<${tagName}> subtree`
      : htmlHasAttribute(attributes, 'hidden')
        ? 'hidden attribute'
        : inlineHidden
    const hiddenReason = stack.at(-1)?.hiddenReason ?? ownHiddenReason
    const semanticHiddenReasons = [...new Set([
      ...(stack.at(-1)?.semanticHiddenReasons ?? []),
      ...(htmlHasAttribute(attributes, 'inert') ? ['inert attribute'] : []),
      ...(htmlAttributeValue(attributes, 'aria-hidden')?.trim().toLowerCase() === 'true'
        ? ['aria-hidden=true']
        : []),
    ])]
    if (!hiddenReason) tags.add(tagName)
    const identifiers = new Set<string>()
    identifiers.add(`@${tagName}`)
    for (const rawClass of classValue?.split(/\s+/gu) ?? []) {
      const className = rawClass.trim().toLowerCase()
      if (!/^-?[_a-z][\w-]*$/iu.test(className)) continue
      identifiers.add(`.${className}`)
      if (hiddenReason) {
        const reasons = hiddenClasses.get(className) ?? new Set<string>()
        reasons.add(hiddenReason)
        hiddenClasses.set(className, reasons)
        continue
      }
      if (semanticHiddenReasons.length > 0) {
        const reasons = semanticallyHiddenClasses.get(className) ?? new Set<string>()
        for (const reason of semanticHiddenReasons) reasons.add(reason)
        semanticallyHiddenClasses.set(className, reasons)
      }
      const usage = classes.get(className) ?? { count: 0, inline: new Map<string, Set<string>>() }
      usage.count += 1
      for (const [property, value] of inline) {
        const values = usage.inline.get(property) ?? new Set<string>()
        values.add(value)
        usage.inline.set(property, values)
      }
      classes.set(className, usage)
    }
    if (idValue && /^-?[_a-z][\w-]*$/iu.test(idValue.trim())) {
      const id = idValue.trim().toLowerCase()
      identifiers.add(`#${id}`)
      if (hiddenReason) {
        const reasons = hiddenIds.get(id) ?? new Set<string>()
        reasons.add(hiddenReason)
        hiddenIds.set(id, reasons)
      } else {
        ids.add(id)
        if (semanticHiddenReasons.length > 0) {
          const reasons = semanticallyHiddenIds.get(id) ?? new Set<string>()
          for (const reason of semanticHiddenReasons) reasons.add(reason)
          semanticallyHiddenIds.set(id, reasons)
        }
      }
    }
    const identifierPath = hiddenReason
      ? stack.at(-1)?.identifierPath ?? []
      : [...(stack.at(-1)?.identifierPath ?? []), identifiers]
    if (!hiddenReason && identifiers.size > 0) {
      identifierPaths.push(identifierPath)
      elements.push(identifiers)
    }
    if (!voidTags.has(tagName) && !/\/\s*>$/u.test(tag[0])) {
      stack.push({
        tagName,
        identifierPath,
        ...(hiddenReason ? { hiddenReason } : {}),
        ...(semanticHiddenReasons.length > 0 ? { semanticHiddenReasons } : {}),
      })
    }
  }
  return {
    classes,
    ids,
    tags,
    hiddenClasses,
    hiddenIds,
    semanticallyHiddenClasses,
    semanticallyHiddenIds,
    identifierPaths,
    elements,
  }
}

function referenceSelectorRequiresInteractiveSemantics(selector: string): boolean {
  return /(?:^|[-_.#])(?:button|controls?|keyboard|link|menu|nav(?:igation)?|next|pager|prev(?:ious)?|tab)(?:$|[-_.:# ])/iu.test(selector)
    || /(?:^|[\s>+~])(?:a|button|input|nav|select|textarea)(?:$|[.#:[\s>+~])/iu.test(selector)
}

function htmlAttributeValue(attributes: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = attributes.match(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu'))
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

function htmlHasAttribute(attributes: string, name: string): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|\\s)${escapedName}(?=\\s|=|$)`, 'iu').test(attributes)
}

function verifySourceProfile(
  html: string,
  profile: ReferenceStyleSourceProfile,
  viewport: { width: number; height: number },
  alternativeLayoutClasses: ReadonlySet<string> = new Set(),
  runtimeManagedSlideSelectors: ReadonlySet<string> = new Set(),
): {
  violations: string[]
  checked: number
  matched: number
  inlineVariantGaps: ReferenceStyleInlineVariantGap[]
} {
  const candidateRules = mergeCssRules(extractCssRules(html, viewport))
  const candidateBySelector = new Map(candidateRules.map((rule) => [rule.selector, rule]))
  const candidateDom = extractDomSnapshot(html)
  const candidateBodyFont = globalFontFamily(candidateRules, ['body']) ?? globalFontFamily(candidateRules, ['html'])
  const candidateHeadingFont = globalFontFamily(candidateRules, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
  const violations: string[] = []
  const inlineVariantGaps: ReferenceStyleInlineVariantGap[] = []
  const alternativeScopesByClass = new Map<string, Set<string>>()
  const globallyRequiredClasses = new Set<string>()
  for (const rule of profile.rules) {
    if (!rule.requiredInDom) continue
    const classNames = selectorIdentifiers(rule.selector)
      .filter((identifier) => identifier.startsWith('.'))
      .map((identifier) => identifier.slice(1))
    const layoutRoots = classNames.filter((className) => alternativeLayoutClasses.has(className))
    if (layoutRoots.length === 0) {
      for (const className of classNames) globallyRequiredClasses.add(className)
      continue
    }
    for (const className of classNames) {
      const scopes = alternativeScopesByClass.get(className) ?? new Set<string>()
      for (const root of layoutRoots) scopes.add(root)
      alternativeScopesByClass.set(className, scopes)
    }
  }
  let checked = 0
  let matched = 0
  const check = (passes: boolean, violation: string) => {
    checked += 1
    if (passes) matched += 1
    else violations.push(violation)
  }

  // Render-profile layout roots are alternatives, not a checklist of classes
  // to pile onto every adapted page. Enforce this in the source gate as well
  // as the Browser gate so a model cannot hide a stacked pair behind compound
  // CSS overrides that happen to reproduce one variant's pixels.
  if (alternativeLayoutClasses.size > 0) {
    const slides = candidateDom.elements.filter((identifiers) => identifiers.has('.slide'))
    if (slides.length >= 3) {
      slides.slice(1, -1).forEach((identifiers, interiorIndex) => {
        const selected = [...alternativeLayoutClasses]
          .filter((className) => identifiers.has(`.${className}`))
          .sort()
        check(
          selected.length === 1,
          selected.length === 0
            ? `source interior slide ${interiorIndex + 2} must use exactly one alternative layout root; found none of ${JSON.stringify([...alternativeLayoutClasses].map((className) => `.${className}`))}`
            : `source interior slide ${interiorIndex + 2} stacks alternative layout roots ${JSON.stringify(selected.map((className) => `.${className}`))}; remove every surplus root class from the slide class attribute instead of neutralizing it with compound CSS overrides`,
        )
      })
    }
  }

  if (profile.bodyFontFamily) {
    check(
      candidateBodyFont === profile.bodyFontFamily,
      `source body font-family expected "${profile.bodyFontFamily}" but found "${candidateBodyFont ?? 'missing'}"`,
    )
  }
  if (profile.headingFontFamily) {
    check(
      candidateHeadingFont === profile.headingFontFamily,
      `source heading font-family expected "${profile.headingFontFamily}" but found "${candidateHeadingFont ?? 'missing'}"`,
    )
  }

  for (const expectedRule of profile.rules) {
    const identifiers = selectorIdentifiers(expectedRule.selector)
    // Interior slide-root selectors are alternatives. When one is not used
    // by this shorter adapted deck, its private subtree is outside the active
    // source-verification surface; Browser attestation separately requires
    // every actual interior slide to choose one real reference variant.
    if (identifiers.some((identifier) => (
      identifier.startsWith('.')
      && alternativeLayoutClasses.has(identifier.slice(1))
      && !candidateDom.classes.has(identifier.slice(1))
    ))) continue
    const requiresInteractiveSemantics = referenceSelectorRequiresInteractiveSemantics(expectedRule.selector)
    const candidateUsesAllIdentifiers = selectorIdentifiersShareRelationship(expectedRule.selector, candidateDom)
    const aliasRule = expectedRule.requiredInDom
      ? undefined
      : compatibleCandidateRule(expectedRule.selector, candidateRules, candidateDom)
    const terminalIdentifier = terminalSelectorIdentifier(expectedRule.selector)
    const stateVariantTargetsUsedClass = /:(?:nth-child|nth-of-type)\(/iu.test(expectedRule.selector)
      && Boolean(terminalIdentifier?.startsWith('.') && candidateDom.classes.has(terminalIdentifier.slice(1)))
    const candidateUsesRule = candidateUsesAllIdentifiers || Boolean(aliasRule) || stateVariantTargetsUsedClass
    if (!expectedRule.requiredInDom && !candidateUsesRule) continue
    if (expectedRule.requiredInDom && identifiers.length > 1) {
      check(
        candidateUsesAllIdentifiers,
        `source selector ${expectedRule.selector} identifiers do not match the same candidate DOM relationship`,
      )
    }
    for (const identifier of identifiers) {
      const exactExists = identifier.startsWith('.')
        ? candidateDom.classes.has(identifier.slice(1))
        : candidateDom.ids.has(identifier.slice(1))
      const aliasExists = !expectedRule.requiredInDom && identifier.startsWith('.') && Boolean(
        aliasRule && selectorIdentifiers(aliasRule.selector).some((candidateIdentifier) => (
          candidateIdentifier.startsWith('.')
          && candidateDom.classes.has(candidateIdentifier.slice(1))
          && classNamesAreRelated(identifier.slice(1), candidateIdentifier.slice(1))
        )),
      )
      const exists = exactExists || aliasExists
      const hiddenReasons = identifier.startsWith('.')
        ? candidateDom.hiddenClasses.get(identifier.slice(1))
        : candidateDom.hiddenIds.get(identifier.slice(1))
      const semanticHiddenReasons = requiresInteractiveSemantics
        ? identifier.startsWith('.')
          ? candidateDom.semanticallyHiddenClasses.get(identifier.slice(1))
          : candidateDom.semanticallyHiddenIds.get(identifier.slice(1))
        : undefined
      check(
        exists && !semanticHiddenReasons?.size,
        hiddenReasons?.size
          ? `source selector ${expectedRule.selector} is hidden from candidate DOM (${identifier}: ${[...hiddenReasons].join(', ')})`
          : semanticHiddenReasons?.size
            ? `source selector ${expectedRule.selector} is semantically unavailable in candidate DOM (${identifier}: ${[...semanticHiddenReasons].join(', ')})`
          : `source selector ${expectedRule.selector} is not used by candidate DOM (missing ${identifier})`,
      )
    }
    const exactCandidateRule = candidateBySelector.get(expectedRule.selector)
    const candidateRule = exactCandidateRule ?? aliasRule
    check(
      Boolean(exactCandidateRule),
      aliasRule
        ? `source selector ${expectedRule.selector} was replaced by ${aliasRule.selector}`
        : `source selector ${expectedRule.selector} is missing from candidate CSS`,
    )
    if (!candidateRule) {
      checked += expectedRule.declarations.length + (expectedRule.effectiveFontFamily ? 1 : 0)
      continue
    }
    const runtimeManagedSlideRoot = runtimeManagedSlideSelectors.has(expectedRule.selector)
    for (const expected of expectedRule.declarations) {
      // External custom-element controllers often own page stacking while a
      // standalone deliverable implements the same single-stage behavior in
      // its own CSS. Browser verification checks the active computed display,
      // opacity, visibility, geometry, and occlusion; comparing the inactive
      // base mechanism here would reject a visually equivalent runtime before
      // that authoritative check can run.
      if (runtimeManagedSlideRoot && RUNTIME_MANAGED_SLIDE_SOURCE_PROPERTIES.has(expected.property)) continue
      const actual = candidateRule.declarations.get(expected.property)
      check(
        actual === expected.value,
        `source ${expectedRule.selector} ${expected.property} expected "${expected.value}" but found "${actual ?? 'missing'}"`,
      )
    }
    if (expectedRule.effectiveFontFamily && !expectedRule.declarations.some((entry) => entry.property === 'font-family')) {
      const actualFont = candidateRule.declarations.get('font-family')
        ?? (selectorTargetsHeading(expectedRule.selector) ? candidateHeadingFont ?? candidateBodyFont : candidateBodyFont)
      check(
        actualFont === expectedRule.effectiveFontFamily,
        `source ${expectedRule.selector} effective font-family expected "${expectedRule.effectiveFontFamily}" but found "${actualFont ?? 'missing'}"`,
      )
      for (const identifier of identifiers.filter((entry) => entry.startsWith('.'))) {
        const inlineFonts = candidateDom.classes.get(identifier.slice(1))?.inline.get('font-family')
        for (const inlineFont of inlineFonts ?? []) {
          check(
            inlineFont === expectedRule.effectiveFontFamily,
            `source ${identifier} inline font-family expected "${expectedRule.effectiveFontFamily}" but found "${inlineFont}"`,
          )
        }
      }
    }
  }

  for (const expectedDom of profile.dom) {
    const candidateUsage = candidateDom.classes.get(expectedDom.className)
    const alternativeScopes = alternativeScopesByClass.get(expectedDom.className)
    if (
      !globallyRequiredClasses.has(expectedDom.className)
      && alternativeScopes
      && ![...alternativeScopes].some((root) => candidateDom.classes.has(root))
    ) continue
    if (alternativeLayoutClasses.has(expectedDom.className) && !candidateUsage) continue
    if (!expectedDom.required && !candidateUsage) continue
    check(Boolean(candidateUsage), `source DOM is missing required .${expectedDom.className}`)
    if (!candidateUsage) {
      for (const variant of expectedDom.inlineStyleVariants ?? []) {
        checked += variant.values.length
        inlineVariantGaps.push({
          className: expectedDom.className,
          property: variant.property,
          required: [...variant.values],
          current: [],
          missing: [...variant.values],
        })
      }
      continue
    }
    for (const variant of expectedDom.inlineStyleVariants ?? []) {
      const actualValues = candidateUsage.inline.get(variant.property)
      const missing = variant.values.filter((expectedValue) => !actualValues?.has(expectedValue))
      checked += variant.values.length
      matched += variant.values.length - missing.length
      if (missing.length === 0) continue
      // Always surface already-satisfied required values before unrelated
      // candidate values. This keeps the complete invariant visible within a
      // bounded diagnostic even for adversarially variant-heavy HTML.
      const currentRequired = variant.values.filter((expectedValue) => actualValues?.has(expectedValue))
      const currentExtras = [...(actualValues ?? [])]
        .filter((value) => !variant.values.includes(value))
        .slice(0, SOURCE_PROFILE_MAX_INLINE_VALUES)
      const gap: ReferenceStyleInlineVariantGap = {
        className: expectedDom.className,
        property: variant.property,
        required: [...variant.values],
        current: [...currentRequired, ...currentExtras],
        missing,
      }
      inlineVariantGaps.push(gap)
      violations.push(
        `source .${gap.className} inline ${gap.property} variants required ${JSON.stringify(gap.required)}, `
        + `current ${JSON.stringify(gap.current)}, missing ${JSON.stringify(gap.missing)}; `
        + 'preserve every current required variant and add each missing value on another existing visible instance instead of replacing one required variant with another',
      )
    }
  }

  return {
    violations: [...new Set(violations)].slice(0, 128),
    checked,
    matched,
    inlineVariantGaps: inlineVariantGaps.slice(0, SOURCE_PROFILE_MAX_DOM_CLASSES),
  }
}

function staticVisualSurface(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, ' ')
}

function unexpectedChromaticColors(surface: string, allowedColors: readonly string[]): string[] {
  const allowedRgb = allowedColors.flatMap((color) => {
    const rgb = cssColorRgb(color)
    return rgb ? [rgb] : []
  })
  const violations = new Set<string>()
  for (const raw of surface.match(STYLE_COLOR_PATTERN) ?? []) {
    const token = raw.toLowerCase().replace(/\s+/gu, '')
    if (allowedColors.some((allowed) => normalizeStyleText(allowed) === normalizeStyleText(token))) continue
    const rgb = cssColorRgb(token)
    if (!rgb) continue
    const spread = Math.max(...rgb) - Math.min(...rgb)
    if (spread < 28) continue
    const belongsToAllowedFamily = allowedRgb.some((allowed) => (
      Math.max(...allowed.map((channel, index) => Math.abs(channel - rgb[index]))) <= 3
    ))
    if (!belongsToAllowedFamily) violations.add(token)
  }
  return [...violations]
}

function cssColorRgb(value: string): [number, number, number] | undefined {
  const normalized = value.trim().toLowerCase()
  const hex = normalized.match(/^#([0-9a-f]{3,8})$/u)?.[1]
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      return [0, 1, 2].map((index) => Number.parseInt(hex[index] + hex[index], 16)) as [number, number, number]
    }
    if (hex.length === 6 || hex.length === 8) {
      return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number]
    }
  }
  const rgb = normalized.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/u)
  if (!rgb) return undefined
  const channels = rgb.slice(1, 4).map(Number)
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) return undefined
  return channels as [number, number, number]
}

function unexpectedPrimaryFontFamilies(surface: string, allowedFonts: readonly string[]): string[] {
  const allowed = new Set(allowedFonts.map((font) => normalizeStyleText(font)))
  const violations = new Set<string>()
  // Attribute values are HTML-decoded by the parser; style bodies are raw
  // CSS. A literal font-family example in visible text is neither of these.
  const css: string[] = []
  const pending: DefaultTreeAdapterMap['node'][] = [parse(surface)]
  while (pending.length) {
    const node = pending.pop()!
    if ('tagName' in node) {
      const inline = node.attrs.find((attribute) => attribute.name === 'style')?.value
      if (inline) css.push(inline)
      if (node.tagName === 'style') css.push(node.childNodes
        .filter((child): child is DefaultTreeAdapterMap['textNode'] => child.nodeName === '#text')
        .map((child) => child.value).join(''))
    }
    if ('childNodes' in node) pending.push(...node.childNodes)
  }
  for (const match of css.join('\n').matchAll(/font-family\s*:\s*([^;}]+)/giu)) {
    const primary = match[1]
      .split(',')[0]
      ?.trim()
      .replace(/^['"]|['"]$/gu, '')
    if (!primary || /^(?:var\(|inherit|initial|unset|sans-serif|serif|monospace|system-ui)/iu.test(primary)) continue
    if (!allowed.has(normalizeStyleText(primary))) violations.add(primary)
  }
  return [...violations]
}
