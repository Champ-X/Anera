import { createHash } from 'node:crypto'
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

export type ReferenceRenderGeometryPolicy = 'strict' | 'size' | 'intrinsic-block'

export interface RenderedReferenceRectProfile {
  /** Viewport-normalized coordinates, retained with bounded precision. */
  x: number
  y: number
  width: number
  height: number
}

export interface RenderedReferenceAnchorProfile {
  selector: string
  count: number
  geometry: ReferenceRenderGeometryPolicy
  rects: RenderedReferenceRectProfile[]
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
}

/**
 * One real interior `.layout-*` grammar captured from the reference deck.
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
  url: string
  viewport: { width: number; height: number } | null
  /** Present on the content phase when the profile has interior variants. */
  interiorAttestation?: RenderedReferenceInteriorAttestation
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
}

export interface ReferenceStyleVerification {
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
  thresholds: {
    colors: number
    fonts: number
    markers: number
  }
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
  'padding', 'pointer-events', 'position', 'right', 'row-gap', 'text-align',
  'text-transform', 'top', 'transform', 'visibility', 'width', 'flex-direction',
  'flex-wrap', 'background-image',
])
const SOURCE_PROFILE_PROPERTIES = new Set([
  'background', 'background-color', 'color', 'font-family', 'font-size', 'font-weight',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'top', 'right', 'bottom', 'left', 'inset', 'display', 'visibility', 'position', 'opacity', 'gap',
  'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows',
  'border', 'border-width', 'border-color', 'border-style', 'border-radius',
  'clip-path', 'box-shadow', 'padding', 'margin', 'transform', 'overflow',
  'align-items', 'justify-content', 'text-align', 'text-transform', 'letter-spacing',
])
const SOURCE_PROFILE_PROPERTY_PRIORITY = [
  'background', 'background-color', 'color', 'font-family', 'width', 'height',
  'top', 'right', 'bottom', 'left', 'inset', 'position', 'display', 'visibility', 'opacity', 'gap',
  'grid-template-columns', 'border', 'border-radius', 'clip-path', 'box-shadow',
  'padding', 'margin', 'transform', 'font-size', 'font-weight', 'letter-spacing',
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
    normalizeContractMarker,
  )
  const distinctiveMarkers = requiredMarkers.filter((marker) => (
    /(?:[.#][a-z][\w-]{3,}|--[a-z][\w-]+|clip-path|grid-template|progress|nav(?:igation)?[-_ ]|cover[-_ ]|dots?[-_ ]|diagonal|slide-counter)/iu.test(marker)
  ))
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
    const structuralPattern = phase === 'cover'
      ? /(?:^|[-_.#])(?:layout-cover|cover)(?:$|[-_.:# ])/iu
      : phase === 'closing'
        ? /(?:^|[-_.#])(?:layout-closing|closing)(?:$|[-_.:# ])/iu
        : /(?:^|[-_.#])(?:slide-header|layout-(?!cover|closing)[a-z0-9-]+)(?:$|[-_.:# ])/iu
    return [phase, normalizeRenderedReferencePhaseProfile(
      phasesInput[phase],
      `render_profile.phases.${phase}`,
      RENDER_PROFILE_MAX_ANCHORS_PER_PHASE,
      structuralPattern,
      true,
    )]
  })) as unknown as Record<ReferenceRenderPhase, RenderedReferencePhaseProfile>
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
      if (!/^\.layout-(?!cover$|closing$)[a-z0-9-]+$/u.test(layoutSelector) || selectors.has(layoutSelector)) {
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
          true,
        ),
      }
    })
  }
  return {
    version: 1,
    evidenceSha256,
    viewport: { width, height },
    phases,
    ...(interiorVariants ? { interiorVariants } : {}),
  }
}

function normalizeRenderedReferencePhaseProfile(
  value: unknown,
  path: string,
  maxAnchors: number,
  structuralPattern: RegExp,
  requirePersistentChrome: boolean,
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
    if (!['strict', 'size', 'intrinsic-block'].includes(String(anchor.geometry))) {
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
    return { selector, count, geometry, rects, styles, occlusion } satisfies RenderedReferenceAnchorProfile
  })
  const structuralAnchors = anchors.filter((anchor) => structuralPattern.test(anchor.selector))
  if (structuralAnchors.length === 0) throw new Error(`${path} lacks a phase structural anchor`)
  if (!structuralAnchors.some((anchor) => anchor.geometry === 'strict')) {
    throw new Error(`${path} must retain at least one strict geometry structural anchor`)
  }
  if (requirePersistentChrome
    && !anchors.some((anchor) => /(?:^|[-_.#])(?:nav|progress|counter|keyboard|hint|chrome)(?:$|[-_.:# ])/iu.test(anchor.selector))) {
    throw new Error(`${path} lacks persistent chrome`)
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
      if (!chunk.metadataValid || byIndex.has(chunk.chunkIndex)) invalid = true
      else byIndex.set(chunk.chunkIndex, chunk)
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
  if (!referenceUrls.some((referenceUrl) => (
    referenceUrlsAreRelated(referenceUrl, requestedUrl) || referenceUrlsAreRelated(referenceUrl, resolvedUrl)
  ))) return false
  // GitHub directory HTML describes GitHub's own chrome, not the referenced
  // design. Even if that shell happens to contain many CSS/color tokens, it
  // remains discovery evidence and the workflow must follow a concrete raw
  // design.md/template.json/template.html child.
  try {
    const requested = new URL(requestedUrl)
    const resolved = new URL(resolvedUrl)
    const requestedCoordinates = githubReferenceCoordinates(requested)
    const resolvedCoordinates = githubReferenceCoordinates(resolved)
    return !(
      (requested.hostname.toLowerCase() === 'github.com' && requestedCoordinates?.kind === 'directory')
      || (resolved.hostname.toLowerCase() === 'github.com' && resolvedCoordinates?.kind === 'directory')
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
    && !referenceUrlsAreRelated(contract.sourceUrl, evidence.resolvedUrl)) return false
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
 * mode is not exact, or neither fetched URL is related to `sourceUrl`.
 */
export function referenceStyleGroundingGaps(
  contract: ReferenceStyleContract,
  evidence: ReferenceStyleEvidence,
): ReferenceStyleGroundingGaps | undefined {
  if (contract.strictness !== 'exact'
    || (!referenceUrlsAreRelated(contract.sourceUrl, evidence.requestedUrl)
      && !referenceUrlsAreRelated(contract.sourceUrl, evidence.resolvedUrl))) return undefined
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
    || (!referenceUrlsAreRelated(contract.sourceUrl, evidence.requestedUrl)
      && !referenceUrlsAreRelated(contract.sourceUrl, evidence.resolvedUrl))) {
    return { contract, omittedVisuallyInertColors: [] }
  }

  const connectedColors = domConnectedVisualTokens(evidence.content, contract.viewport).colors
  const declaredColors = new Set<string>()
  for (const rule of extractCssRules(evidence.content, contract.viewport)) {
    for (const value of rule.declarations.values()) {
      for (const color of value.match(STYLE_COLOR_PATTERN) ?? []) {
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
): ReferenceStyleVerification {
  // Ignore comments and script bodies so a candidate cannot satisfy the
  // deterministic gate by stuffing unused reference tokens into metadata or
  // JavaScript strings. The rendered DOM and CSS remain eligible evidence.
  const haystack = normalizeStyleText(staticVisualSurface(html))
  const connected = contract.strictness === 'exact'
    ? domConnectedVisualTokens(html, contract.viewport)
    : undefined
  const matchedColors = contract.colors.filter((value) => connected
    ? connected.colors.has(normalizeCssColorToken(value))
    : haystack.includes(normalizeStyleText(value)))
  const matchedFonts = contract.fonts.filter((value) => connected
    ? connected.fonts.has(normalizeFontFamilyToken(value))
    : haystack.includes(normalizeStyleText(value)))
  const matchedMarkers = contract.requiredMarkers.filter((value) => connected
    ? domConnectedMarkerIsGrounded(value, connected)
    : haystack.includes(normalizeStyleText(value)))
  const colorViolations = unexpectedChromaticColors(staticVisualSurface(html), contract.colors)
  const fontViolations = unexpectedPrimaryFontFamilies(staticVisualSurface(html), contract.fonts)
  const avoidViolations: string[] = []
  const sourceVerification = contract.strictness === 'exact' && sourceProfile
    ? verifySourceProfile(html, sourceProfile, contract.viewport)
    : { violations: [], checked: 0, matched: 0 }
  const avoidText = contract.avoid.join('\n')
  if (
    /(?:no\s+)?(?:drop\s+)?shadows?.{0,30}(?:cards?|content)|(?:cards?|content).{0,30}(?:drop\s+)?shadows?|卡片.{0,20}阴影/iu.test(avoidText)
    && /(?:\.[a-z][\w-]*card[\w-]*|\bcard[\w-]*)[^{}]*\{[^{}]*box-shadow\s*:\s*(?!none\b)[^;}]+/iu.test(staticVisualSurface(html))
  ) avoidViolations.push('card/content box-shadow contradicts the StyleContract')
  const colorThreshold = contract.strictness === 'exact'
    ? contract.colors.length
    : Math.max(2, Math.ceil(contract.colors.length * 0.4))
  const fontThreshold = contract.strictness === 'exact'
    ? contract.fonts.length
    : Math.max(1, Math.ceil(contract.fonts.length * 0.34))
  const markerThreshold = contract.strictness === 'exact'
    ? contract.requiredMarkers.length
    : Math.max(1, Math.ceil(contract.requiredMarkers.length * 0.34))
  const colorRatio = matchedColors.length / contract.colors.length
  const fontRatio = matchedFonts.length / contract.fonts.length
  const markerRatio = matchedMarkers.length / contract.requiredMarkers.length
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
      colors: contract.colors.filter((value) => !matchedColors.includes(value)),
      fonts: contract.fonts.filter((value) => !matchedFonts.includes(value)),
      markers: contract.requiredMarkers.filter((value) => !matchedMarkers.includes(value)),
    },
    violations: {
      colors: colorViolations,
      fonts: fontViolations,
      avoid: avoidViolations,
      source: sourceVerification.violations,
    },
    thresholds: { colors: colorThreshold, fonts: fontThreshold, markers: markerThreshold },
  }
}

export function referenceUrlsAreRelated(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    a.hash = ''
    b.hash = ''
    if (a.toString() === b.toString()) return true
    const githubA = githubReferenceCoordinates(a)
    const githubB = githubReferenceCoordinates(b)
    if (githubA && githubB) {
      if (githubA.repository !== githubB.repository) return false
      if (githubA.revision && githubB.revision && githubA.revision !== githubB.revision) return false
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
    if (a.hostname !== b.hostname) return false
    const aPath = a.pathname.replace(/\/+$/, '')
    const bPath = b.pathname.replace(/\/+$/, '')
    return aPath === bPath || aPath.startsWith(`${bPath}/`) || bPath.startsWith(`${aPath}/`)
  } catch {
    return false
  }
}

interface GitHubReferenceCoordinates {
  repository: string
  revision?: string
  resourcePath: string
  kind: 'repository' | 'directory' | 'file'
}

function githubReferenceCoordinates(url: URL): GitHubReferenceCoordinates | undefined {
  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2) return undefined
  const repository = `${segments[0].toLowerCase()}/${segments[1].replace(/\.git$/iu, '').toLowerCase()}`
  if (host === 'raw.githubusercontent.com') {
    return {
      repository,
      revision: segments[2]?.toLowerCase(),
      resourcePath: segments.slice(3).join('/').toLowerCase(),
      kind: segments.length > 3 ? 'file' : 'repository',
    }
  }
  if (host !== 'github.com') return undefined
  if (segments.length === 2) return { repository, resourcePath: '', kind: 'repository' }
  const route = segments[2].toLowerCase()
  if (route === 'tree' && segments.length >= 4) {
    return {
      repository,
      revision: segments[3]?.toLowerCase(),
      resourcePath: segments.slice(4).join('/').toLowerCase(),
      kind: segments.length > 4 ? 'directory' : 'repository',
    }
  }
  if (['blob', 'raw'].includes(route) && segments.length >= 5) {
    const resourcePath = segments.slice(4).join('/').toLowerCase()
    const finalSegment = segments.at(-1) ?? ''
    return {
      repository,
      revision: segments[3]?.toLowerCase(),
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
  for (const item of value) {
    const raw = requiredBoundedString(item, name, maxCharacters)
    const token = normalize(raw)
    if (!token) throw new Error(`${name} entries must contain one concrete source token, not a generic label`)
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
      const canonical = token.toLowerCase().replace(/\s+/gu, '')
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
}

function normalizeCssColorToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, '')
}

function normalizeFontFamilyToken(value: string): string {
  return value.trim().toLowerCase().replace(/^['"]|['"]$/gu, '').replace(/\s+/gu, ' ')
}

function cssRuleIsVisiblyConnected(rule: ParsedCssRule, dom: DomSnapshot): boolean {
  if (rule.declarations.get('display') === 'none'
    || ['hidden', 'collapse'].includes(rule.declarations.get('visibility') ?? '')) return false
  const identifiers = selectorIdentifiers(rule.selector)
  if (identifiers.length > 0) return selectorIdentifiersShareRelationship(rule.selector, dom)
  const base = rule.selector.replace(/::(?:before|after)$/iu, '')
  if (base === ':root') return dom.tags.has('html')
  return /^(?:html|body|h[1-6]|p|li|blockquote|small|strong|em)$/iu.test(base)
    && dom.tags.has(base.toLowerCase())
}

/**
 * Extract only exact tokens carried by CSS rules that can apply to the real,
 * non-inert DOM. This prevents an unused selector, comment, script string, or
 * substring (for example Inter inside Interstate) from satisfying exact mode.
 */
function domConnectedVisualTokens(
  html: string,
  viewport: { width: number; height: number },
): DomConnectedVisualTokens {
  const dom = extractDomSnapshot(html)
  const rules = mergeCssRules(extractCssRules(html, viewport)).filter((rule) => cssRuleIsVisiblyConnected(rule, dom))
  const colors = new Set<string>()
  const fonts = new Set<string>()
  const selectors = new Set<string>()
  const properties = new Set<string>()
  const variables = new Set<string>()
  const variableValues = new Map<string, string>()
  const referencedVariables = new Set<string>()
  const fontVariables = new Set<string>()

  for (const rule of rules) {
    selectors.add(rule.selector)
    for (const identifier of selectorIdentifiers(rule.selector)) selectors.add(identifier)
    for (const [property, value] of rule.declarations) {
      properties.add(property)
      if (property.startsWith('--')) variableValues.set(property, value)
      else {
        for (const color of value.match(STYLE_COLOR_PATTERN) ?? []) colors.add(normalizeCssColorToken(color))
      }
      for (const reference of value.matchAll(/var\(\s*(--[a-z][\w-]*)/giu)) {
        const variable = reference[1].toLowerCase()
        referencedVariables.add(variable)
        if (property === 'font-family') fontVariables.add(variable)
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
      }
    }
    if (!changed) break
  }
  for (const variable of referencedVariables) {
    const value = variableValues.get(variable)
    if (!value) continue
    variables.add(variable)
    for (const color of value.match(STYLE_COLOR_PATTERN) ?? []) colors.add(normalizeCssColorToken(color))
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
    return tokens.selectors.has(normalized) && identifiers.every((identifier) => (
      identifier.startsWith('.')
        ? tokens.domClasses.has(identifier.slice(1))
        : tokens.domIds.has(identifier.slice(1))
    ))
  }
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

function normalizeContractMarker(value: string): string | undefined {
  const trimmed = value.trim()
  if (/^(?:[.#][a-z][\w-]{3,}|--[a-z][\w-]+|(?:layout|cover|closing|nav|progress|slide|metric|accent|card|tag|cta|step|bar|insight|split|keyboard)[a-z0-9_.-]{2,})$/iu.test(trimmed)) {
    return trimmed
  }
  return trimmed.match(
    /(?:[.#](?:layout|cover|closing|nav|progress|slide|metric|accent|card|tag|cta|step|bar|insight|split|keyboard)[a-z0-9_.-]*|\b(?:layout|cover|closing|nav|progress|slide|metric|accent|card|tag|cta|step|bar|insight|split|keyboard)[a-z0-9_.-]{2,}|--[a-z][\w-]+)/iu,
  )?.[0]
}

interface ParsedCssRule {
  selector: string
  declarations: Map<string, string>
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
  identifierPaths: Array<Array<Set<string>>>
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
      const declarations = parseCssDeclarations(body)
      if (declarations.size > 0) {
        for (const selector of splitCssSelectors(header)) {
          const normalized = normalizeCssSelector(selector)
          if (normalized) output.push({ selector: normalized, declarations: new Map(declarations) })
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

function parseCssDeclarations(value: string): Map<string, string> {
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
    if (!SOURCE_PROFILE_PROPERTIES.has(property) && !/^--[a-z][\w-]*$/u.test(property)) continue
    const rawValue = chunk.slice(separator + 1).trim()
    if (!rawValue || rawValue.length > 2_000) continue
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
      merged.set(rule.selector, { selector: rule.selector, declarations: new Map(rule.declarations) })
      continue
    }
    for (const [property, value] of rule.declarations) prior.declarations.set(property, value)
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
  const surface = selector
    .replace(/::[-\w]+/gu, '')
    .replace(/:[-\w]+(?:\([^)]*\))?/gu, '')
    .replace(/\[[^\]]*\]/gu, '')
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
    if (identifiers.length === 0) return selectorIdentifiersExist(selectorIdentifiers(selector), dom)
    if (compounds.length > 0) combinators.push(pending ?? ' ')
    compounds.push(identifiers)
    pending = undefined
  }
  if (compounds.length === 0) return false
  if (compounds.length === 1) {
    return dom.identifierPaths.some((path) => path.some((nodeIdentifiers) => (
      compounds[0].every((identifier) => nodeIdentifiers.has(identifier))
    )))
  }
  if (combinators.some((entry) => entry === '+' || entry === '~')) return false
  return dom.identifierPaths.some((path) => {
    const visit = (compoundIndex: number, pathIndex: number): boolean => {
      if (!compounds[compoundIndex].every((identifier) => path[pathIndex]?.has(identifier))) return false
      if (compoundIndex === compounds.length - 1) return true
      if (combinators[compoundIndex] === '>') return pathIndex + 1 < path.length && visit(compoundIndex + 1, pathIndex + 1)
      for (let next = pathIndex + 1; next < path.length; next += 1) {
        if (visit(compoundIndex + 1, next)) return true
      }
      return false
    }
    return path.some((_, index) => visit(0, index))
  })
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
  const identifierPaths: Array<Array<Set<string>>> = []
  const stack: Array<{ tagName: string; hiddenReason?: string; identifierPath: Array<Set<string>> }> = []
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
    const ownHiddenReason = ['template', 'noscript', 'script', 'style'].includes(tagName)
      ? `<${tagName}> subtree`
      : htmlHasAttribute(attributes, 'hidden')
        ? 'hidden attribute'
        : htmlHasAttribute(attributes, 'inert')
          ? 'inert attribute'
          : htmlAttributeValue(attributes, 'aria-hidden')?.trim().toLowerCase() === 'true'
            ? 'aria-hidden=true'
            : inlineHidden
    const hiddenReason = stack.at(-1)?.hiddenReason ?? ownHiddenReason
    if (!hiddenReason) tags.add(tagName)
    const identifiers = new Set<string>()
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
      } else ids.add(id)
    }
    const identifierPath = hiddenReason
      ? stack.at(-1)?.identifierPath ?? []
      : [...(stack.at(-1)?.identifierPath ?? []), identifiers]
    if (!hiddenReason && identifiers.size > 0) identifierPaths.push(identifierPath)
    if (!voidTags.has(tagName) && !/\/\s*>$/u.test(tag[0])) {
      stack.push({ tagName, identifierPath, ...(hiddenReason ? { hiddenReason } : {}) })
    }
  }
  return { classes, ids, tags, hiddenClasses, hiddenIds, identifierPaths }
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
): { violations: string[]; checked: number; matched: number } {
  const candidateRules = mergeCssRules(extractCssRules(html, viewport))
  const candidateBySelector = new Map(candidateRules.map((rule) => [rule.selector, rule]))
  const candidateDom = extractDomSnapshot(html)
  const candidateBodyFont = globalFontFamily(candidateRules, ['body']) ?? globalFontFamily(candidateRules, ['html'])
  const candidateHeadingFont = globalFontFamily(candidateRules, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
  const violations: string[] = []
  let checked = 0
  let matched = 0
  const check = (passes: boolean, violation: string) => {
    checked += 1
    if (passes) matched += 1
    else violations.push(violation)
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
      check(
        exists,
        hiddenReasons?.size
          ? `source selector ${expectedRule.selector} is hidden from candidate DOM (${identifier}: ${[...hiddenReasons].join(', ')})`
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
    for (const expected of expectedRule.declarations) {
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
    if (!expectedDom.required && !candidateUsage) continue
    check(Boolean(candidateUsage), `source DOM is missing required .${expectedDom.className}`)
    if (!candidateUsage) {
      checked += expectedDom.inlineStyleVariants?.reduce((total, variant) => total + variant.values.length, 0) ?? 0
      continue
    }
    for (const variant of expectedDom.inlineStyleVariants ?? []) {
      const actualValues = candidateUsage.inline.get(variant.property)
      for (const expectedValue of variant.values) {
        check(
          Boolean(actualValues?.has(expectedValue)),
          `source .${expectedDom.className} inline ${variant.property} is missing variant "${expectedValue}"`,
        )
      }
    }
  }

  return { violations: [...new Set(violations)].slice(0, 128), checked, matched }
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
  for (const match of surface.matchAll(/font-family\s*:\s*([^;}]+)/giu)) {
    const primary = match[1]
      .split(',')[0]
      ?.trim()
      .replace(/^['"]|['"]$/gu, '')
    if (!primary || /^(?:var\(|inherit|initial|unset|sans-serif|serif|monospace|system-ui)/iu.test(primary)) continue
    if (!allowed.has(normalizeStyleText(primary))) violations.add(primary)
  }
  return [...violations]
}
