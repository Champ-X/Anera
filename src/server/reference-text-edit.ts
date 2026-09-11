import { createHash } from 'node:crypto'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { normalizeReferenceLanguageVariant, referenceLanguageText, verifyReferenceLanguageMarkup,
  type ReferenceLanguageRole, type ReferenceLanguageVariant } from './reference-language.js'
import { REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES } from './reference-template.js'

export const REFERENCE_TEXT_VIEW_MAX_BYTES = 48 * 1024
const hash = (text: string) => createHash('sha256').update(text).digest('base64url')
const hashPattern = /^[A-Za-z0-9_-]{43}$/u
const shaPattern = /^[a-f0-9]{64}$/u
type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
const attr = (node: Element, name: string) => node.attrs.find((entry) => entry.name === name)?.value
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

export interface ReferenceTextSlot {
  slide_index: number
  variant: string
  slot: string
  role: ReferenceLanguageRole
  text: string
}

export interface ReferenceTextView {
  kind: 'reference_text'
  schemaVersion: 1
  complete: true
  hash: string
  language_manifest_sha256: string
  source_sha256: string
  slots: ReferenceTextSlot[]
}

export interface ReferenceTextEditTarget {
  hash: string
  language_manifest_sha256: string
  slide_index: number
  slot: string
  expected_text: string
}

export interface ReferenceTextEditBatch {
  hash: string
  language_manifest_sha256: string
  edits: Array<Pick<ReferenceTextEditTarget, 'slide_index' | 'slot' | 'expected_text'> & { new_text: string }>
}

const isGroup = (node: Element) => attr(node, 'data-anera-cjk-text') !== undefined
const isRun = (node: Element) => attr(node, 'data-anera-cjk') !== undefined
const isCitation = (node: Element) => node.tagName === 'a' && attr(node, 'style') === 'color:inherit;text-decoration:inherit'
const contentElements = (node: Element) => node.childNodes.filter((child): child is Element => 'tagName' in child)
  .filter((child) => !isGroup(child) && !isRun(child) && !isCitation(child))
const opaque = new Set(['head', 'script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'textarea'])

/** A bounded view of existing, source-authorized literal text slots.
 * It is neither the complete HTML nor proof of factual/render correctness.
 * Unmarked Latin/numeric text is exposed only when one binding and one literal
 * node identify it unambiguously; other structures retain ordinary raw edits.
 */
function inspect(html: string, value: ReferenceLanguageVariant) {
  const language = normalizeReferenceLanguageVariant(value)
  if (Buffer.byteLength(html) > REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES || Buffer.from(html).toString('utf8') !== html) {
    throw new Error('Reference text view requires bounded, losslessly UTF-8 HTML; use ordinary read_file')
  }
  verifyReferenceLanguageMarkup(html, language)
  const document = parse(html, { sourceCodeLocationInfo: true })
  const pending: Node[] = [document]
  const slides: Element[] = []
  while (pending.length) {
    const node = pending.pop()!
    if ('tagName' in node && ['head', 'script', 'style', 'template', 'noscript'].includes(node.tagName)) continue
    if ('tagName' in node && (attr(node, 'class') ?? '').split(/\s+/u).includes('slide')) slides.push(node)
    if ('childNodes' in node) pending.push(...[...node.childNodes].reverse())
  }
  const ranges: Array<{ slot: ReferenceTextSlot; start: number; end: number; namespace: 'html' | 'svg' }> = []
  for (const [index, slide] of slides.entries()) {
    const nodes: Node[] = [slide]
    while (nodes.length) {
      const node = nodes.pop()!
      if ('tagName' in node) {
        const slot = attr(node, 'data-anera-cjk-text')
        if (slot !== undefined) {
          const variant = attr(slide, 'data-anera-cjk-variant')!
          const binding = language.bindings.find((entry) => entry.variant === variant && entry.slot === slot)!
          const location = node.sourceCodeLocation
          if (!location?.startTag || !location.endTag || location.startOffset < 0 || location.endOffset > html.length) {
            throw new Error('Reference text view requires an explicitly closed literal-text group; use ordinary read_file')
          }
          const text = node.childNodes.map((child) => {
            if (child.nodeName === '#text') return (child as DefaultTreeAdapterMap['textNode']).value
            if (!('tagName' in child) || attr(child, 'data-anera-cjk') === undefined) {
              throw new Error('Reference text view requires an unmodified literal-text group; use ordinary read_file for embedded comments or markup')
            }
            return child.childNodes.map((run) => (run as DefaultTreeAdapterMap['textNode']).value).join('')
          }).join('')
          ranges.push({ slot: { slide_index: index + 1, variant, slot, role: binding.role, text },
            start: location.startOffset, end: location.endOffset, namespace: node.namespaceURI === 'http://www.w3.org/2000/svg' ? 'svg' : 'html' })
          continue
        }
      }
      if ('childNodes' in node) nodes.push(...[...node.childNodes].reverse())
    }
    const variant = attr(slide, 'data-anera-cjk-variant')!
    const bindings = language.bindings.filter((binding) => binding.variant === variant)
    for (const binding of bindings) {
      if (ranges.some((range) => range.slot.slide_index === index + 1 && range.slot.slot === binding.slot)) continue
      // Parent paths do not encode text-node ordinals. Never guess which of
      // multiple same-parent source slots an unmarked value belongs to.
      if (bindings.filter((other) => JSON.stringify(other.path) === JSON.stringify(binding.path)).length !== 1) continue
      let parent: Element | undefined = slide
      for (const childIndex of binding.path) {
        parent = parent && !opaque.has(parent.tagName) ? contentElements(parent)[childIndex] : undefined
      }
      if (!parent || opaque.has(parent.tagName)) continue
      const literals = parent.childNodes.flatMap((child) => {
        if (child.nodeName === '#text') return (child as DefaultTreeAdapterMap['textNode']).value.trim() ? [child] : []
        if ('tagName' in child && isCitation(child) && child.childNodes.length === 1 && child.childNodes[0].nodeName === '#text') {
          return (child.childNodes[0] as DefaultTreeAdapterMap['textNode']).value.trim() ? [child.childNodes[0]] : []
        }
        return []
      })
      if (literals.length !== 1) continue
      const node = literals[0] as DefaultTreeAdapterMap['textNode']
      const location = node.sourceCodeLocation
      if (!location || location.startOffset < 0 || location.endOffset > html.length) continue
      ranges.push({ slot: { slide_index: index + 1, variant, slot: binding.slot, role: binding.role, text: node.value },
        start: location.startOffset, end: location.endOffset, namespace: parent.namespaceURI === 'http://www.w3.org/2000/svg' ? 'svg' : 'html' })
    }
  }
  ranges.sort((left, right) => left.start - right.start)
  const view: ReferenceTextView = { kind: 'reference_text', schemaVersion: 1, complete: true, hash: hash(html),
    language_manifest_sha256: language.manifestSha256, source_sha256: language.sourceSha256, slots: ranges.map((entry) => entry.slot) }
  if (!view.slots.length || Buffer.byteLength(JSON.stringify(view)) > REFERENCE_TEXT_VIEW_MAX_BYTES) {
    throw new Error('Reference text view has no editable groups or exceeds its bounded complete view; use ordinary read_file')
  }
  return { language, view, ranges }
}

export function readReferenceText(html: string, language: ReferenceLanguageVariant): ReferenceTextView {
  return inspect(html, language).view
}

/** Shape check for an executed tool result; a compacted/partial catalog must
 * never unlock a text edit as though current target text and hashes survived.
 */
export function isCompleteReferenceTextView(value: unknown): value is ReferenceTextView {
  if (!plain(value) || value.kind !== 'reference_text' || value.schemaVersion !== 1 || value.complete !== true
    || typeof value.hash !== 'string' || !hashPattern.test(value.hash)
    || typeof value.language_manifest_sha256 !== 'string' || !shaPattern.test(value.language_manifest_sha256)
    || typeof value.source_sha256 !== 'string' || !shaPattern.test(value.source_sha256)
    || !Array.isArray(value.slots) || !value.slots.length || value.slots.length > 10_240
    || Buffer.byteLength(JSON.stringify(value)) > REFERENCE_TEXT_VIEW_MAX_BYTES) return false
  const seen = new Set<string>()
  for (const slot of value.slots) {
    if (!plain(slot) || !Number.isInteger(slot.slide_index) || Number(slot.slide_index) < 1 || Number(slot.slide_index) > 64
      || typeof slot.variant !== 'string' || !/^v[1-9]\d?$/u.test(slot.variant)
      || typeof slot.slot !== 'string' || !/^t[1-9]\d{0,2}$/u.test(slot.slot)
      || !['display', 'body', 'label'].includes(String(slot.role)) || typeof slot.text !== 'string') return false
    const key = `${slot.slide_index}.${slot.slot}`
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

/** Replace one uniquely addressed group, never fuzzy-match text across pages.
 * The caller must additionally compare current file bytes inside its atomic
 * commit, so an edit between this check and commit cannot be overwritten.
 */
export function applyReferenceTextEdit(html: string, language: ReferenceLanguageVariant,
  target: ReferenceTextEditTarget | ReferenceTextEditBatch, replacement?: string): string {
  const batch = plain(target) && Object.hasOwn(target, 'edits')
  const allowed = ['hash', 'language_manifest_sha256', ...(batch ? ['edits'] : ['slide_index', 'slot', 'expected_text'])]
  if (!plain(target) || Object.keys(target).some((key) => !allowed.includes(key))
    || typeof target.hash !== 'string' || !hashPattern.test(target.hash) || target.hash !== hash(html)
    || target.language_manifest_sha256 !== language.manifestSha256) {
    throw new Error('Reference text edit requires the current file hash and language manifest from read_file view=reference_text. No edit was applied; read the current text view again')
  }
  const inspected = inspect(html, language)
  const edits = batch ? (target as ReferenceTextEditBatch).edits : [{
    slide_index: (target as ReferenceTextEditTarget).slide_index, slot: (target as ReferenceTextEditTarget).slot,
    expected_text: (target as ReferenceTextEditTarget).expected_text, new_text: replacement,
  }]
  if (!Array.isArray(edits) || (batch && (replacement !== undefined || edits.length < 2 || edits.length > 16))) {
    throw new Error('Reference text batch requires 2–16 edits from one snapshot and no outer new_text')
  }
  const selectedSlots = new Set<string>()
  const replacements = edits.map((edit) => {
    if (!plain(edit) || Object.keys(edit).some((key) => !['slide_index', 'slot', 'expected_text', 'new_text'].includes(key))) {
      throw new Error('Reference text batch entries require only slide_index, slot, expected_text and literal new_text')
    }
    const text = edit.new_text
    if (typeof text !== 'string' || !text.trim() || text.length > 8_000
      || /[\u0000\r]/u.test(text) || Buffer.from(text).toString('utf8') !== text) {
      throw new Error('Reference text replacement must be non-empty literal UTF-8 text of at most 8000 characters, without NUL or carriage returns; do not clear a content slot')
    }
    const selected = inspected.ranges.filter((entry) => entry.slot.slide_index === edit.slide_index && entry.slot.slot === edit.slot)
    const key = `${edit.slide_index}.${edit.slot}`
    if (selected.length !== 1 || selected[0].slot.text !== edit.expected_text || selectedSlots.has(key)) {
      throw new Error('Reference text edit target or expected_text differs from the current text view, or its slot is duplicated. No edit was applied; read the current text view again')
    }
    selectedSlots.add(key)
    const range = selected[0]
    const binding = inspected.language.bindings.find((entry) => entry.variant === range.slot.variant && entry.slot === range.slot.slot)!
    return { ...range, markup: referenceLanguageText(text, binding, range.namespace) }
  }).sort((left, right) => right.start - left.start)
  let result = html
  let boundary = html.length
  for (const range of replacements) {
    if (range.end > boundary) throw new Error('Reference text edit ranges overlap; use ordinary read_file')
    result = result.slice(0, range.start) + range.markup + result.slice(range.end)
    boundary = range.start
  }
  verifyReferenceLanguageMarkup(result, inspected.language)
  return result
}
