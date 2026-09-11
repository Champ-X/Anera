import { createHash } from 'node:crypto'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { fetchPublicUrl } from './network-policy.js'
import { normalizeReferenceLanguageVariant, PINK_SCRIPT_SOURCE_SHA256, PINK_SCRIPT_SOURCE_URL, referenceLanguageText, verifyReferenceLanguageMarkup, type ReferenceLanguageVariant } from './reference-language.js'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
type Text = DefaultTreeAdapterMap['textNode']
type Range = { startOffset: number; endOffset: number }
type Replacement = Range & { content: string }

export const REFERENCE_TEMPLATE_MAX_BYTES = 256 * 1024
export const REFERENCE_TEMPLATE_MAX_DEPENDENCIES = 4
export const REFERENCE_TEMPLATE_MAX_SCRIPT_BYTES = 256 * 1024
export const REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES = 768 * 1024
export const REFERENCE_TEMPLATE_CATALOG_VERSION = 3
const MAX_TEMPLATE_NODES = 16_000
const MAX_TEMPLATE_DEPTH = 128

export interface ReferenceTemplateSlot {
  id: string
  element: string
  sample: string
  /** Only ordinary HTML text can be wrapped in a citation link. */
  linkable?: false
  /** Explicitly replace or clear a numeric unit or a reviewed source ordinal. */
  role?: 'unit' | 'ordinal'
  allowEmpty?: true
}

export interface ReferenceTemplateCatalog {
  /** Old catalogs remain readable, but must be re-recorded before composition. */
  version: 1 | 2 | 3
  sourceSha256: string
  variants: Array<{ id: string; layout: string; slots: ReferenceTemplateSlot[] }>
  dependencies: string[]
}

export interface ReferenceTemplateSlide {
  variant: string
  label: string
  texts: Record<string, string>
  links?: Record<string, string>
}

export function referenceTemplateCatalogRequiresUpgrade(catalog: ReferenceTemplateCatalog | undefined): boolean {
  return catalog !== undefined && catalog.version !== REFERENCE_TEMPLATE_CATALOG_VERSION
}

/** Element-child paths survive content replacement; text offsets do not. */
export interface ReferenceTemplateTextParent {
  variant: string
  slot: string
  path: number[]
}

export interface ReferenceTemplateDependency {
  url: string
  sha256: string
  bytes: number
  content: string
}

export interface ReferenceTemplateRuntimeEvidence {
  version: 1
  sourceEvidenceSha256: string
  sourceUrl: string
  dependencies: Array<Omit<ReferenceTemplateDependency, 'content'>>
  manifestSha256: string
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const attr = (node: Element, name: string) => node.attrs.find((item) => item.name === name)?.value
const isElement = (node: Node): node is Element => 'tagName' in node
const children = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : []
const escapeText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const escapeAttribute = (value: string) => escapeText(value).replaceAll('"', '&quot;')

function walk(node: Node): Node[] {
  const result: Node[] = []
  const pending = [{ node, depth: 0 }]
  while (pending.length) {
    const current = pending.pop()!
    if (current.depth > MAX_TEMPLATE_DEPTH || result.length >= MAX_TEMPLATE_NODES) {
      throw new Error('Reference DOM exceeds the bounded node count or depth')
    }
    result.push(current.node)
    for (const child of [...children(current.node)].reverse()) pending.push({ node: child, depth: current.depth + 1 })
  }
  return result
}

function located(node: Node): Range {
  if (!node.sourceCodeLocation) throw new Error('The reference contains an implicit or malformed content node')
  return node.sourceCodeLocation
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function publicUrl(raw: string): string {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('A citation must be a public HTTP(S) URL without credentials')
  url.hash = ''
  return url.toString()
}

function dependencyUrl(raw: string, sourceUrl: string): string {
  const base = new URL('.', publicUrl(sourceUrl))
  const url = new URL(raw, sourceUrl)
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)
    || url.username || url.password || url.search || url.hash || !/\.js$/iu.test(url.pathname)) {
    throw new Error('Template scripts must be concrete .js files inside the same source directory')
  }
  return url.toString()
}

export function referenceTemplateRuntimeEvidence(sourceEvidenceSha256: string, sourceUrl: string, dependencies: ReferenceTemplateDependency[]): ReferenceTemplateRuntimeEvidence {
  for (const dependency of dependencies) assertReferenceTemplateDependency(dependency)
  const core = { version: 1 as const, sourceEvidenceSha256, sourceUrl,
    dependencies: dependencies.map(({ url, sha256, bytes }) => ({ url, sha256, bytes })) }
  return normalizeReferenceTemplateRuntimeEvidence({ ...core, manifestSha256: sha256(JSON.stringify(core)) })
}

export function normalizeReferenceTemplateRuntimeEvidence(value: unknown): ReferenceTemplateRuntimeEvidence {
  if (!plainObject(value) || value.version !== 1 || typeof value.sourceEvidenceSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.sourceEvidenceSha256) || typeof value.sourceUrl !== 'string'
    || !Array.isArray(value.dependencies) || value.dependencies.length > REFERENCE_TEMPLATE_MAX_DEPENDENCIES) throw new Error('Invalid reference runtime manifest')
  const sourceUrl = publicUrl(value.sourceUrl)
  const dependencies = value.dependencies.map((dependency) => {
    if (!plainObject(dependency) || typeof dependency.url !== 'string' || dependencyUrl(dependency.url, sourceUrl) !== dependency.url
      || typeof dependency.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(dependency.sha256)
      || typeof dependency.bytes !== 'number' || !Number.isInteger(dependency.bytes) || dependency.bytes < 1
      || dependency.bytes > REFERENCE_TEMPLATE_MAX_SCRIPT_BYTES) throw new Error('Invalid reference runtime dependency')
    return { url: dependency.url, sha256: dependency.sha256, bytes: dependency.bytes }
  })
  if (new Set(dependencies.map(({ url }) => url)).size !== dependencies.length) throw new Error('Duplicate reference runtime dependency')
  const core = { version: 1 as const, sourceEvidenceSha256: value.sourceEvidenceSha256, sourceUrl, dependencies }
  if (value.manifestSha256 !== sha256(JSON.stringify(core))) throw new Error('Reference runtime manifest digest mismatch')
  return { ...core, manifestSha256: value.manifestSha256 as string }
}

export function assertReferenceTemplateDependency(dependency: ReferenceTemplateDependency): void {
  if (typeof dependency.content !== 'string' || dependency.bytes < 1 || dependency.bytes > REFERENCE_TEMPLATE_MAX_SCRIPT_BYTES
    || dependency.bytes !== Buffer.byteLength(dependency.content) || dependency.sha256 !== sha256(dependency.content)) {
    throw new Error('Missing or corrupted immutable script dependency')
  }
}

export const REFERENCE_RUNTIME_MATERIALIZER_VERSION = 'ordered-blob-v1'

/** One byte-preserving implementation for composition and reference repairs.
 * This is HTML/CSP-safe packaging, not a verdict about the script's behavior.
 */
export function materializeReferenceRuntimeLoader(dependency: ReferenceTemplateDependency): string {
  assertReferenceTemplateDependency(dependency)
  const content = `(()=>{const b=Uint8Array.from(atob("${Buffer.from(dependency.content).toString('base64')}"),c=>c.charCodeAt(0));const u=URL.createObjectURL(new Blob([b],{type:"text/javascript"}));const s=document.createElement("script");s.async=false;s.src=u;s.onload=s.onerror=()=>URL.revokeObjectURL(u);document.currentScript.after(s)})()`
  return `<script>${content}</script>`
}

/** Validate the small durable catalog without treating it as source bytes. */
export function normalizeReferenceTemplateCatalog(value: unknown, sourceSha256: string, sourceUrl: string): ReferenceTemplateCatalog {
  if (!plainObject(value) || (value.version !== 1 && value.version !== 2 && value.version !== REFERENCE_TEMPLATE_CATALOG_VERSION) || value.sourceSha256 !== sourceSha256
    || !Array.isArray(value.variants) || value.variants.length < 3 || value.variants.length > 64
    || !Array.isArray(value.dependencies) || value.dependencies.length > REFERENCE_TEMPLATE_MAX_DEPENDENCIES) {
    throw new Error('Invalid source-bound reference composition catalog')
  }
  const variants = value.variants.map((variant, index) => {
    if (!plainObject(variant) || variant.id !== `v${index + 1}` || typeof variant.layout !== 'string'
      || !variant.layout.trim() || variant.layout.length > 1_000 || !Array.isArray(variant.slots)
      || variant.slots.length < 1 || variant.slots.length > 160) throw new Error('Invalid reference variant catalog')
    const slots = variant.slots.map((slot, slotIndex) => {
      if (!plainObject(slot) || slot.id !== `t${slotIndex + 1}` || typeof slot.element !== 'string'
        || !slot.element || slot.element.length > 1_000 || typeof slot.sample !== 'string'
        || !slot.sample.trim() || slot.sample.length > 2_000
        || (slot.linkable !== undefined && slot.linkable !== false)
        || (slot.role !== undefined && (value.version === 1 || (slot.role !== 'unit' && slot.role !== 'ordinal')))
        || (slot.role === 'ordinal' && value.version !== REFERENCE_TEMPLATE_CATALOG_VERSION)
        || (slot.allowEmpty !== undefined && (slot.allowEmpty !== true || !slot.role))
        || (slot.role !== undefined && (slot.allowEmpty !== true || slot.linkable !== false))) throw new Error('Invalid reference content slot')
      return { id: slot.id, element: slot.element, sample: slot.sample,
        ...(slot.linkable === false ? { linkable: false as const } : {}),
        ...(slot.role ? { role: slot.role as 'unit' | 'ordinal', allowEmpty: true as const } : {}) }
    })
    return { id: variant.id, layout: variant.layout, slots }
  })
  const dependencies = value.dependencies.map((url) => {
    if (typeof url !== 'string' || dependencyUrl(url, sourceUrl) !== url) throw new Error('Invalid reference dependency catalog')
    return url
  })
  if (new Set(dependencies).size !== dependencies.length) throw new Error('Duplicate reference dependencies')
  return { version: value.version, sourceSha256, variants, dependencies }
}

const SYMBOLIC_UNIT = /^[%％‰‱×$€£¥￥°℃℉]{1,3}$/u
const TEXT_UNIT = /^(?:万亿|千万|百万|十万|亿|万|千|元|人|次|天|日|分|分钟|小时|个|倍|家|件|kg|g|km|m|cm|mm|ms|s|days?|hours?|mins?|points?)$/iu

function isNumericPeer(node: Node): boolean {
  const value = node.nodeName === '#text' ? (node as Text).value
    : isElement(node) && children(node).every((child) => child.nodeName === '#text')
      ? children(node).map((child) => (child as Text).value).join('') : ''
  return /^[+\-−]?(?:[$€£¥￥]\s*)?\d+(?:[.,]\d+)*$/u.test(value.trim())
}

function isOptionalUnit(node: Text): boolean {
  const sample = node.value.trim()
  if (!SYMBOLIC_UNIT.test(sample) && !TEXT_UNIT.test(sample)) return false
  const container = node.parentNode
  if (!container || !isElement(container) || container.namespaceURI !== 'http://www.w3.org/1999/xhtml'
    || !['sup', 'sub', 'span'].includes(container.tagName) || !container.parentNode) return false
  const siblings = children(container.parentNode).filter((child) => isElement(child)
    || (child.nodeName === '#text' && Boolean((child as Text).value.trim())))
  const index = siblings.indexOf(container)
  return [siblings[index - 1], siblings[index + 1]].some((peer) => peer && isNumericPeer(peer))
}

function isReviewedSourceOrdinal(node: Text, sourceSha256: string, sourceUrl: string, variantIndex: number): boolean {
  // "Paris · 11e" names the 11th arrondissement in the reviewed source. Its
  // superscript is an ordinal suffix, not required copy or a general license
  // to delete arbitrary annotations beside numbers. Other sources/revisions
  // need their own reviewed role metadata.
  if (sourceSha256 !== PINK_SCRIPT_SOURCE_SHA256 || sourceUrl !== PINK_SCRIPT_SOURCE_URL
    || variantIndex !== 0 || node.value.trim() !== 'e') return false
  const container = node.parentNode
  if (!container || !isElement(container) || container.tagName !== 'sup' || !container.parentNode) return false
  const siblings = children(container.parentNode)
  const previous = siblings[siblings.indexOf(container) - 1]
  return previous?.nodeName === '#text' && (previous as Text).value.trim() === 'Paris · 11'
}

/** Replace source ranges from right to left, leaving every other byte untouched. */
function replaceRanges(source: string, replacements: Replacement[]): string {
  let boundary = source.length
  let result = source
  for (const range of [...replacements].sort((left, right) => right.startOffset - left.startOffset)) {
    if (range.startOffset < 0 || range.endOffset > boundary || range.startOffset > range.endOffset) {
      throw new Error('Template content ranges overlap or exceed their source')
    }
    result = result.slice(0, range.startOffset) + range.content + result.slice(range.endOffset)
    boundary = range.startOffset
  }
  return result
}

function inspectTemplate(html: string, sourceUrl: string) {
  if (Buffer.byteLength(html) > REFERENCE_TEMPLATE_MAX_BYTES) throw new Error('Reference template exceeds the bounded source size')
  const sourceSha256 = sha256(html)
  if (!/<!doctype\s+html\b/iu.test(html) || !/<\/html\s*>/iu.test(html)) throw new Error('Reference composition requires a complete HTML document')
  const document = parse(html, { sourceCodeLocationInfo: true })
  const elements = walk(document).filter(isElement)
  if (elements.some((element) => element.tagName === 'base')) throw new Error('Reference composition does not accept a base URL override')
  const charsetMeta = elements.find((element) => element.tagName === 'meta' && attr(element, 'charset'))
  if (charsetMeta && !/^utf-?8$/iu.test(attr(charsetMeta, 'charset')!)) throw new Error('Reference composition requires UTF-8 source encoding')
  const slides = elements.filter((element) => ['section', 'article', 'div'].includes(element.tagName)
    && (attr(element, 'class') ?? '').split(/\s+/u).includes('slide'))
  if (slides.length < 3 || slides.length > 64 || slides.some((slide) => slide.parentNode !== slides[0].parentNode)) {
    throw new Error('Reference composition requires 3–64 sibling .slide roots')
  }
  const parent = slides[0].parentNode
  if (!parent || children(parent).filter(isElement).some((node) => !slides.includes(node))) {
    throw new Error('Reference slide siblings must not contain unrelated executable or layout elements')
  }
  const variants = slides.map((element, index) => {
    const nodes = walk(element)
    if (nodes.some((node) => isElement(node) && ['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript'].includes(node.tagName))) {
      throw new Error('Composable slide roots must contain content, not executable or nested template blocks')
    }
    // This composer supports text-only layouts. Do not silently retain demo
    // URLs, accessibility copy, media sources or actions that have no binding.
    if (nodes.some((node) => isElement(node) && node.attrs.some((item) => (
      ['href', 'alt', 'title', 'aria-label', 'placeholder', 'value', 'src', 'srcset', 'action', 'formaction'].includes(item.name)
      && item.value.trim()
    )))) throw new Error('Reference content attributes require explicit bindings; use the ordinary targeted HTML workflow for this template')
    const texts = nodes.filter((node): node is Text => node.nodeName === '#text')
    // Preserve every v1 text ID. Append previously unbound unit symbols rather
    // than inserting them between existing t IDs and reinterpreting old copy.
    const slots = [...texts.filter((node) => /[\p{L}\p{N}]/u.test(node.value)),
      ...texts.filter((node) => !/[\p{L}\p{N}]/u.test(node.value) && SYMBOLIC_UNIT.test(node.value.trim()))]
      .map((node, slotIndex) => {
        const container = node.parentNode && isElement(node.parentNode) ? node.parentNode : element
        const role = isOptionalUnit(node) ? 'unit' as const
          : isReviewedSourceOrdinal(node, sourceSha256, sourceUrl, index) ? 'ordinal' as const : undefined
        let linkable = !role && container.namespaceURI === 'http://www.w3.org/1999/xhtml'
        for (let ancestor: Node | null = container; ancestor && ancestor !== element; ancestor = 'parentNode' in ancestor ? ancestor.parentNode : null) {
          if (isElement(ancestor) && ['a', 'button', 'select', 'textarea', 'label'].includes(ancestor.tagName)) linkable = false
        }
        return {
          id: `t${slotIndex + 1}`,
          element: `${container.tagName}${attr(container, 'class') ? `.${attr(container, 'class')!.trim().replace(/\s+/gu, '.')}` : ''}`,
          sample: node.value.trim(),
          ...(!linkable ? { linkable: false as const } : {}),
          ...(role ? { role, allowEmpty: true as const } : {}),
          leadingWhitespace: node.value.match(/^\s*/u)![0],
          trailingWhitespace: node.value.match(/\s*$/u)![0],
          range: located(node),
          parent: container,
        }
      })
    if (slots.length === 0 || slots.length > 160) throw new Error('Reference variant has no usable content slots or exceeds the bounded slot count')
    return {
      id: `v${index + 1}`, layout: attr(element, 'class') ?? element.tagName, slots,
      element, range: located(element), hasIds: nodes.some((node) => isElement(node) && attr(node, 'id')),
    }
  })
  const scripts = elements.filter((element) => element.tagName === 'script' && attr(element, 'src')).map((element) => {
    if (attr(element, 'type') && !['text/javascript', 'application/javascript'].includes(attr(element, 'type')!)) {
      throw new Error('Reference composition currently requires classic self-contained scripts')
    }
    if (element.attrs.some((item) => !['src', 'type'].includes(item.name))) {
      throw new Error('Reference script scheduling or integrity attributes require the ordinary HTML workflow')
    }
    return { element, range: located(element), url: dependencyUrl(attr(element, 'src')!, sourceUrl) }
  })
  const dependencies = [...new Set(scripts.map((script) => script.url))]
  if (dependencies.length > REFERENCE_TEMPLATE_MAX_DEPENDENCIES) throw new Error('Reference template declares too many script dependencies')
  const catalog = normalizeReferenceTemplateCatalog({
    version: REFERENCE_TEMPLATE_CATALOG_VERSION, sourceSha256, dependencies,
    variants: variants.map(({ id, layout, slots }) => ({ id, layout, slots: slots.map(({ id, element, sample, linkable, role, allowEmpty }) => ({
      id, element, sample, ...(linkable === false ? { linkable } : {}), ...(role ? { role, allowEmpty } : {}),
    })) })),
  }, sourceSha256, sourceUrl)
  const notes = elements.filter((element) => element.tagName === 'script' && attr(element, 'type') === 'application/json' && attr(element, 'id') === 'speaker-notes')
  return { variants, scripts, notes, catalog, charsetMeta,
    head: elements.find((element) => element.tagName === 'head'), title: elements.find((element) => element.tagName === 'title') }
}

export function referenceTemplateCatalog(html: string, sourceUrl: string): ReferenceTemplateCatalog {
  return inspectTemplate(html, sourceUrl).catalog
}

export function referenceTemplateTextParents(html: string, sourceUrl: string): ReferenceTemplateTextParent[] {
  return inspectTemplate(html, sourceUrl).variants.flatMap((variant) => variant.slots.map((slot) => {
    const path: number[] = []
    for (let node: Element = slot.parent; node !== variant.element;) {
      const parent = node.parentNode
      if (!parent || !isElement(parent)) throw new Error('Reference text parent escaped its slide')
      path.unshift(children(parent).filter(isElement).indexOf(node))
      node = parent
    }
    return { variant: variant.id, slot: slot.id, path }
  }))
}

/** Keep source CSS/chrome intact while selecting only its actual interior roots. */
export function projectReferenceTemplateLayouts(
  source: string,
  sourceUrl: string,
  alternativeLayoutClasses: ReadonlySet<string>,
  selectedLayoutClasses: ReadonlySet<string>,
): string {
  const template = inspectTemplate(source, sourceUrl)
  const omitted = template.variants.slice(1, -1).filter((variant) => {
    const roots = (attr(variant.element, 'class') ?? '').split(/\s+/u)
      .filter((name) => alternativeLayoutClasses.has(name))
    return roots.length > 0 && roots.every((name) => !selectedLayoutClasses.has(name))
  })
  return replaceRanges(source, omitted.map((variant) => ({ ...variant.range, content: '' })))
}

/** Download only declared, source-directory-scoped dependencies; never execute them server-side. */
export async function materializeReferenceTemplateDependencies(
  catalog: ReferenceTemplateCatalog,
  sourceUrl: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetchPublicUrl,
): Promise<ReferenceTemplateDependency[]> {
  if (catalog.dependencies.length > REFERENCE_TEMPLATE_MAX_DEPENDENCIES) throw new Error('Too many reference dependencies')
  return await Promise.all(catalog.dependencies.map(async (requested) => {
    const url = dependencyUrl(requested, sourceUrl)
    signal.throwIfAborted()
    const response = await fetchImpl(url, { signal, headers: { accept: 'application/javascript, text/javascript, text/plain' } })
    if (!response.ok) throw new Error(`Reference script retrieval failed: HTTP ${response.status}`)
    if (response.url && dependencyUrl(response.url, sourceUrl) !== url) throw new Error('Reference script redirected away from its declared source')
    if (!response.body) throw new Error('Reference script response has no body')
    const reader = response.body.getReader()
    const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined) }
    signal.addEventListener('abort', onAbort, { once: true })
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > REFERENCE_TEMPLATE_MAX_SCRIPT_BYTES) throw new Error('Reference script exceeds the bounded dependency size')
        chunks.push(chunk.value)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      await reader.cancel().catch(() => undefined)
    }
    signal.throwIfAborted()
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
    if (!content.trim() || /<!doctype\s+html|<html\b/iu.test(content)) throw new Error('Reference script response is not JavaScript source')
    return { url, sha256: sha256(content), bytes, content }
  }))
}

/** Inspect independent binding mistakes without materializing or changing a file.
 * The caller must supply a catalog re-derived from the hash-checked source.
 * Citation coverage counts only usable, nonempty, source-allowed slot bindings;
 * an invented slot or malformed link cannot satisfy a research item.
 * This is not a complete source, runtime, content or rendered-layout verdict.
 */
export function referenceTemplateBindingReview(
  catalog: ReferenceTemplateCatalog, slides: unknown, allowedSourceUrls: readonly string[],
): { issues: string[]; citationUrls: string[] } {
  if (!Array.isArray(slides) || slides.length < 3 || slides.length > 64) {
    return { issues: ['Choose 3–64 content-driven slides, including cover and closing'], citationUrls: [] }
  }
  const issues: string[] = []
  const citationUrls = new Set<string>()
  const allowedUrls = new Set(allowedSourceUrls.map(publicUrl))
  const first = catalog.variants[0].id
  const last = catalog.variants.at(-1)!.id
  if (!plainObject(slides[0]) || slides[0].variant !== first
    || !plainObject(slides.at(-1)) || slides.at(-1).variant !== last) {
    issues.push(`Retain the actual reference cover and closing: first variant ${JSON.stringify(first)}, last variant ${JSON.stringify(last)}. Repair these selections without dropping supported content or copying demo text.`)
  }
  let bindingGap = false
  for (const [index, slide] of slides.entries()) {
    const label = `Slide ${index + 1}`
    if (!plainObject(slide)) { issues.push(`${label} requires an object of complete content bindings`); continue }
    const variant = catalog.variants.find((candidate) => candidate.id === slide.variant)
    if (!variant) { issues.push(`${label}: unknown reference variant ${JSON.stringify(String(slide.variant).slice(0, 80))}`); continue }
    if (index > 0 && index < slides.length - 1 && [first, last].includes(variant.id)) {
      issues.push(`${label}: Choose real interior variants for content slides`)
    }
    if (typeof slide.label !== 'string' || !slide.label.trim() || slide.label.length > 160) {
      issues.push(`${label} requires a short label and complete text bindings`)
    }
    if (!plainObject(slide.texts) || (slide.links !== undefined && !plainObject(slide.links))) {
      issues.push(`${label} requires complete text bindings and a slot-ID-to-URL links object`)
      continue
    }
    const texts = slide.texts
    const links = (slide.links ?? {}) as Record<string, unknown>
    const keys = new Set(variant.slots.map((slot) => slot.id))
    const missing = variant.slots.filter((slot) => typeof texts[slot.id] !== 'string'
      || (!slot.allowEmpty && !(texts[slot.id] as string).trim())).map((slot) => slot.id)
    const unknown = [...new Set([...Object.keys(texts), ...Object.keys(links)].filter((key) => !keys.has(key)))]
    if (missing.length || unknown.length) {
      bindingGap = true
      issues.push(`${label} binding gap: missing=${missing.slice(0, 24).join(',')}${missing.length > 24 ? ` (+${missing.length - 24})` : ''}; unknown=${unknown.slice(0, 24).map((key) => key.slice(0, 40)).join(',')}${unknown.length > 24 ? ` (+${unknown.length - 24})` : ''}`)
    }
    for (const slot of variant.slots) {
      const text = texts[slot.id]
      if (typeof text === 'string' && text.length > 2_000) issues.push(`${label} slot ${slot.id} exceeds the bounded copy size`)
      const link = links[slot.id]
      if (link === undefined) continue
      if (slot.linkable === false) { issues.push(`${label} slot ${slot.id} cannot contain a nested or non-HTML citation link`); continue }
      let url: string | undefined
      try { if (typeof link === 'string') url = publicUrl(link) } catch { /* Invalid data, not a usable citation. */ }
      if (!url || !allowedUrls.has(url)) { issues.push(`${label} citation ${slot.id} has no allowed retrieved source URL`); continue }
      if (typeof text === 'string' && text.trim() && text.length <= 2_000) citationUrls.add(url)
    }
  }
  const bounded = issues.slice(0, 16)
  if (issues.length > bounded.length) bounded.push(`${issues.length - bounded.length} additional binding issues remain; this diagnostic is bounded, not an all-clear for omitted slides.`)
  if (bindingGap) bounded.push('Fill every selected content slot, including explicit unit and ordinal bindings; only catalog allowEmpty slots may be "" when that affix no longer applies. Both texts and links use catalog text slot IDs (t1, t2, ...), never item IDs (n1) or names. Never retain example facts by omission.')
  return { issues: bounded, citationUrls: [...citationUrls] }
}

/** Compile task content into literal source layouts; no model-generated CSS or HTML is accepted. */
export function composeReferenceTemplate(input: {
  source: string
  sourceUrl: string
  sourceSha256: string
  title: string
  slides: ReferenceTemplateSlide[]
  dependencies: ReferenceTemplateDependency[]
  allowedSourceUrls: readonly string[]
  languageVariant?: ReferenceLanguageVariant
}) {
  const template = inspectTemplate(input.source, input.sourceUrl)
  const language = input.languageVariant ? normalizeReferenceLanguageVariant(input.languageVariant, template.catalog) : undefined
  if (input.sourceSha256 !== template.catalog.sourceSha256) throw new Error('Reference template SHA-256 does not match the recorded source')
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw new Error('A concise document title is required')
  const bindingReview = referenceTemplateBindingReview(template.catalog, input.slides, input.allowedSourceUrls)
  if (bindingReview.issues.length) throw new Error(bindingReview.issues.join('\n'))
  const allowedUrls = new Set(input.allowedSourceUrls.map(publicUrl))
  const used = new Set<string>()
  let composedBytes = 0
  const composed = input.slides.map((slide, index) => {
    const variant = template.variants.find((candidate) => candidate.id === slide.variant)
    if (!variant) throw new Error(`Unknown reference variant ${slide.variant}`)
    if (index > 0 && index < input.slides.length - 1 && [template.variants[0].id, template.variants.at(-1)!.id].includes(variant.id)) {
      throw new Error('Choose real interior variants for content slides')
    }
    if (used.has(variant.id) && variant.hasIds) throw new Error('Cannot duplicate a reference variant with document-global IDs')
    used.add(variant.id)
    if (typeof slide.label !== 'string' || !slide.label.trim() || slide.label.length > 160 || !plainObject(slide.texts) || (slide.links !== undefined && !plainObject(slide.links))) {
      throw new Error(`Slide ${index + 1} requires a short label and complete text bindings`)
    }
    const replacements: Replacement[] = variant.slots.map((slot) => {
      const text = slide.texts[slot.id]
      if (text.length > 2_000) throw new Error(`Slide ${index + 1} slot ${slot.id} exceeds the bounded copy size`)
      const languageBinding = language?.bindings.find((binding) => binding.variant === variant.id && binding.slot === slot.id)
      let content = languageBinding
        ? referenceLanguageText(text, languageBinding, slot.parent.namespaceURI === 'http://www.w3.org/2000/svg' ? 'svg' : 'html')
        : escapeText(text)
      const link = slide.links?.[slot.id]
      if (link !== undefined) {
        if (slot.linkable === false) throw new Error(`Slide ${index + 1} slot ${slot.id} cannot contain a nested or non-HTML citation link`)
        if (typeof link !== 'string' || !allowedUrls.has(publicUrl(link))) throw new Error(`Slide ${index + 1} citation ${slot.id} has no allowed retrieved source URL`)
        content = `<a href="${escapeAttribute(link)}" style="color:inherit;text-decoration:inherit">${content}</a>`
      }
      return { startOffset: slot.range.startOffset - variant.range.startOffset, endOffset: slot.range.endOffset - variant.range.startOffset,
        content: slot.leadingWhitespace + content + slot.trailingWhitespace }
    })
    const label = variant.element.sourceCodeLocation?.attrs?.['data-label']
    const startTag = variant.element.sourceCodeLocation?.startTag
    if (!startTag) throw new Error('Reference slide opening tag is malformed')
    replacements.push(label
      ? { startOffset: label.startOffset - variant.range.startOffset, endOffset: label.endOffset - variant.range.startOffset, content: `data-label="${escapeAttribute(slide.label)}"` }
      : { startOffset: startTag.endOffset - variant.range.startOffset - 1, endOffset: startTag.endOffset - variant.range.startOffset - 1, content: ` data-label="${escapeAttribute(slide.label)}"` })
    if (language) replacements.push({ startOffset: startTag.endOffset - variant.range.startOffset - 1,
      endOffset: startTag.endOffset - variant.range.startOffset - 1,
      content: ` data-anera-cjk-variant="${variant.id}"` })
    const html = replaceRanges(input.source.slice(variant.range.startOffset, variant.range.endOffset), replacements)
    composedBytes += Buffer.byteLength(html)
    if (composedBytes > REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES) throw new Error('Composed reference HTML exceeds the bounded output size')
    return html
  }).join('\n')
  const replacements: Replacement[] = [{ startOffset: template.variants[0].range.startOffset, endOffset: template.variants.at(-1)!.range.endOffset, content: composed }]
  if (!template.charsetMeta) {
    const head = template.head?.sourceCodeLocation?.startTag
    if (!head) throw new Error('Reference composition requires an explicit document head')
    replacements.push({ startOffset: head.endOffset, endOffset: head.endOffset, content: '<meta charset="utf-8">' })
  }
  if (!template.title?.sourceCodeLocation?.startTag || !template.title.sourceCodeLocation.endTag) throw new Error('Reference composition requires an explicit document title')
  replacements.push({ startOffset: template.title.sourceCodeLocation.startTag.endOffset, endOffset: template.title.sourceCodeLocation.endTag.startOffset, content: escapeText(input.title) })
  for (const notes of template.notes) {
    const location = notes.sourceCodeLocation
    if (!location?.startTag || !location.endTag) throw new Error('Reference speaker notes are malformed')
    // The original sample narration is not task content. Labels are already
    // explicit caller bindings; encode raw-text terminators safely in JSON.
    replacements.push({ startOffset: location.startTag.endOffset, endOffset: location.endTag.startOffset,
      content: JSON.stringify(input.slides.map((slide) => slide.label)).replaceAll('<', '\\u003c') })
  }
  for (const script of template.scripts) {
    const dependency = input.dependencies.find((item) => item.url === script.url)
    if (!dependency) {
      throw new Error(`Missing or corrupted immutable script dependency: ${script.url}`)
    }
    // App previews prohibit data: scripts. Ordered Blob scripts preserve the
    // exact UTF-8 bytes without raw-text boundaries or markup-looking strings
    // polluting downstream static HTML parsers. No eval or CSP relaxation.
    replacements.push({ ...script.range, content: materializeReferenceRuntimeLoader(dependency) })
  }
  const html = replaceRanges(input.source, replacements)
  if (Buffer.byteLength(html) > REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES) throw new Error('Composed reference HTML exceeds the bounded output size')
  if (language) verifyReferenceLanguageMarkup(html, language)
  return {
    html, sourceSha256: template.catalog.sourceSha256,
    dependencies: template.catalog.dependencies.map((url) => {
      const dependency = input.dependencies.find((item) => item.url === url)!
      return { url, sha256: dependency.sha256, bytes: dependency.bytes }
    }),
    slideCount: input.slides.length,
  }
}
