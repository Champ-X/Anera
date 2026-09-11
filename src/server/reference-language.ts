import { createHash } from 'node:crypto'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { fetchPublicUrl } from './network-policy.js'
import { materializeReferenceFonts } from './reference-fonts.js'
import { REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES, referenceTemplateCatalog, referenceTemplateTextParents, type ReferenceTemplateCatalog, type ReferenceTemplateTextParent } from './reference-template.js'

// This adapter implements the author's documented CJK strategy, not a generic
// license to change exact references. Both complete public source documents
// are pinned; a new upstream revision needs a reviewed adapter, not fuzzy
// matching of a few font names in arbitrary model-supplied prose.
export const PINK_SCRIPT_SOURCE_SHA256 = 'd2263b8267b03c3edfc2ae77b4d8f4c876289728c441405c18d76db71bfb3167'
export const PINK_SCRIPT_DESIGN_SHA256 = '934adb9d973431dd99bf7b05f292eb10f204d02bc6bde4a7ca7df4f8186eb218'
export const PINK_SCRIPT_SOURCE_URL = 'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/main/templates/pink-script/template.html'
export const PINK_SCRIPT_DESIGN_URL = new URL('design.md', PINK_SCRIPT_SOURCE_URL).href
export const REFERENCE_LANGUAGE_MAX_CHARACTERS = 2_048
const DESIGN_MAX_BYTES = 256 * 1024
const CJK_RUN = /[\p{Script=Han}\u3000-\u303f\uff01-\uff60]+/gu
const hasCjk = (text: string) => /[\p{Script=Han}\u3000-\u303f\uff01-\uff60]/u.test(text)
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const escapeText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export type ReferenceLanguageRole = 'display' | 'body' | 'label'
export const REFERENCE_LANGUAGE_ROLES = {
  display: { latin: 'DM Serif Display', cjk: 'Noto Serif SC', weight: 900, lineHeight: 1.2, family: '"DM Serif Display","Noto Serif SC",serif' },
  body: { latin: 'Inter', cjk: 'Noto Serif SC', weight: 400, lineHeight: 1.8, family: '"Inter","Noto Serif SC",system-ui,sans-serif' },
  label: { latin: 'JetBrains Mono', cjk: 'Noto Sans SC', weight: 400, family: '"JetBrains Mono","Noto Sans SC",monospace' },
} as const

export interface ReferenceLanguageBinding extends ReferenceTemplateTextParent {
  role: ReferenceLanguageRole
}

export interface ReferenceLanguageVariant {
  version: 1
  adapter: 'pink-script-zh-cn-v1'
  language: 'zh-CN'
  sourceSha256: string
  designUrl: string
  designSha256: string
  layouts: Array<{ variant: string; classes: string }>
  bindings: ReferenceLanguageBinding[]
  manifestSha256: string
}

export function referenceLanguageRunStyle(role: ReferenceLanguageRole): string {
  const rule = REFERENCE_LANGUAGE_ROLES[role]
  return `font-family:${rule.family};font-weight:${rule.weight};font-size:inherit;font-style:normal;font-synthesis:none;${'lineHeight' in rule ? `line-height:${rule.lineHeight};` : ''}letter-spacing:0;text-transform:none`
}

export function referenceLanguageRole(family: string): ReferenceLanguageRole {
  const primary = family.split(',')[0].trim().replaceAll('"', '').replaceAll("'", '').toLowerCase()
  const role = (Object.keys(REFERENCE_LANGUAGE_ROLES) as ReferenceLanguageRole[])
    .find((key) => REFERENCE_LANGUAGE_ROLES[key].latin.toLowerCase() === primary)
  if (!role) throw new Error(`Unsupported source typography role: ${family.slice(0, 100)}`)
  return role
}

export async function fetchReferenceLanguageDesign(signal: AbortSignal, fetchImpl: typeof fetch = fetchPublicUrl): Promise<string> {
  const response = await fetchImpl(PINK_SCRIPT_DESIGN_URL, { signal })
  if (!response.ok || (response.url && response.url !== PINK_SCRIPT_DESIGN_URL) || !response.body) {
    throw new Error('The documented CJK variant requires the exact original design document')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > DESIGN_MAX_BYTES) throw new Error('CJK design document exceeds its bounded source size')
      chunks.push(chunk.value)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => undefined)
  }
  signal.throwIfAborted()
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
  if (digest(content) !== PINK_SCRIPT_DESIGN_SHA256) throw new Error('The CJK design source changed; this adapter is not authorized for that revision')
  return content
}

export function createReferenceLanguageVariant(
  source: string, sourceUrl: string, design: string,
  parents: readonly ReferenceTemplateTextParent[], families: readonly string[],
): ReferenceLanguageVariant {
  if (sourceUrl !== PINK_SCRIPT_SOURCE_URL || digest(source) !== PINK_SCRIPT_SOURCE_SHA256
    || digest(design) !== PINK_SCRIPT_DESIGN_SHA256 || parents.length !== families.length
    || JSON.stringify(parents) !== JSON.stringify(referenceTemplateTextParents(source, sourceUrl))) {
    throw new Error('The CJK adapter needs its exact source, documented authorization and Browser-observed text roles')
  }
  const core = {
    version: 1 as const, adapter: 'pink-script-zh-cn-v1' as const, language: 'zh-CN' as const,
    sourceSha256: digest(source), designUrl: PINK_SCRIPT_DESIGN_URL, designSha256: digest(design),
    layouts: referenceTemplateCatalog(source, sourceUrl).variants.map((variant) => ({ variant: variant.id, classes: variant.layout })),
    bindings: parents.map((parent, index) => ({ ...parent, role: referenceLanguageRole(families[index]) })),
  }
  return normalizeReferenceLanguageVariant({ ...core, manifestSha256: digest(JSON.stringify(core)) }, referenceTemplateCatalog(source, sourceUrl))
}

export function normalizeReferenceLanguageVariant(value: unknown, catalog?: ReferenceTemplateCatalog): ReferenceLanguageVariant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing source-authorized language variant')
  const input = value as ReferenceLanguageVariant
  if (input.version !== 1 || input.adapter !== 'pink-script-zh-cn-v1' || input.language !== 'zh-CN'
    || input.sourceSha256 !== PINK_SCRIPT_SOURCE_SHA256 || input.designUrl !== PINK_SCRIPT_DESIGN_URL
    || input.designSha256 !== PINK_SCRIPT_DESIGN_SHA256 || !Array.isArray(input.layouts) || input.layouts.length < 3 || input.layouts.length > 64
    || !Array.isArray(input.bindings)
    || input.bindings.length < 1 || input.bindings.length > 64 * 160) throw new Error('Invalid source-authorized language variant')
  const seen = new Set<string>()
  const layouts = input.layouts.map((layout, index) => {
    if (!layout || layout.variant !== `v${index + 1}` || typeof layout.classes !== 'string' || layout.classes.length > 1_000
      || !/^[a-z][a-z0-9_-]*(?: [a-z][a-z0-9_-]*)*$/iu.test(layout.classes)) throw new Error('Invalid source language layout identity')
    return { variant: layout.variant, classes: layout.classes }
  })
  const bindings = input.bindings.map((binding) => {
    if (!binding || typeof binding !== 'object' || !/^v[1-9]\d?$/u.test(binding.variant) || !/^t[1-9]\d{0,2}$/u.test(binding.slot)
      || !layouts.some((layout) => layout.variant === binding.variant)
      || !Object.hasOwn(REFERENCE_LANGUAGE_ROLES, binding.role) || !Array.isArray(binding.path) || binding.path.length > 128
      || binding.path.some((index) => !Number.isInteger(index) || index < 0 || index > 16_000)) throw new Error('Invalid source text-role binding')
    const key = `${binding.variant}.${binding.slot}`
    if (seen.has(key)) throw new Error('Duplicate source text-role binding')
    seen.add(key)
    return { variant: binding.variant, slot: binding.slot, path: [...binding.path], role: binding.role }
  })
  if (catalog && (catalog.sourceSha256 !== input.sourceSha256
    || JSON.stringify(layouts) !== JSON.stringify(catalog.variants.map((variant) => ({ variant: variant.id, classes: variant.layout })))
    || JSON.stringify(bindings.map(({ variant, slot }) => `${variant}.${slot}`)) !== JSON.stringify(catalog.variants.flatMap((variant) => variant.slots.map((slot) => `${variant.id}.${slot.id}`))))) {
    throw new Error('Language bindings do not match the source composition catalog')
  }
  const core = { version: input.version, adapter: input.adapter, language: input.language,
    sourceSha256: input.sourceSha256, designUrl: input.designUrl, designSha256: input.designSha256, layouts, bindings }
  if (input.manifestSha256 !== digest(JSON.stringify(core))) throw new Error('Language variant manifest digest mismatch')
  return { ...core, manifestSha256: input.manifestSha256 }
}

/** Literal text only. Latin/numeric runs retain their source CSS unchanged. */
export function referenceLanguageText(text: string, binding: ReferenceLanguageBinding, namespace: 'html' | 'svg' = 'html'): string {
  if (!hasCjk(text)) return escapeText(text)
  const tag = namespace === 'svg' ? 'tspan' : 'span'
  let offset = 0
  let html = ''
  for (const match of text.matchAll(CJK_RUN)) {
    html += escapeText(text.slice(offset, match.index))
    html += `<${tag} data-anera-cjk="${binding.role}" data-anera-cjk-slot="${binding.slot}" style="${referenceLanguageRunStyle(binding.role).replaceAll('"', '&quot;')}">${escapeText(match[0])}</${tag}>`
    offset = match.index + match[0].length
  }
  // A text node is one anonymous flex/grid item. Keep the whole mixed-script
  // slot together so inserting styled CJK runs cannot create extra items,
  // lose boundary spaces, or apply the parent's gap between every script.
  return `<${tag} data-anera-cjk-text="${binding.slot}">${html + escapeText(text.slice(offset))}</${tag}>`
}

/** Final rendered text, not hrefs/scripts/source examples, determines coverage. */
export function referenceLanguageCharacters(html: string): string {
  type Node = DefaultTreeAdapterMap['node']
  const characters = new Set<string>()
  const pending: Array<{ node: Node; excluded: boolean }> = [{ node: parse(html), excluded: false }]
  while (pending.length) {
    const { node, excluded } = pending.pop()!
    const skip = excluded || ('tagName' in node && ['script', 'style', 'template', 'noscript'].includes(node.tagName))
    if (skip) continue
    if (node.nodeName === '#text') {
      const text = (node as DefaultTreeAdapterMap['textNode']).value
      for (const match of text.matchAll(CJK_RUN)) for (const character of match[0]) characters.add(character)
    }
    if (characters.size > REFERENCE_LANGUAGE_MAX_CHARACTERS) throw new Error('Final CJK character subset exceeds its bounded coverage size')
    if ('childNodes' in node) for (const child of node.childNodes) pending.push({ node: child, excluded: skip })
  }
  return [...characters].sort((left, right) => left.codePointAt(0)! - right.codePointAt(0)!).join('')
}

export function referenceLanguageFontLink(characters: string): string {
  if (!characters || [...characters].length > REFERENCE_LANGUAGE_MAX_CHARACTERS
    || !/^[\p{Script=Han}\u3000-\u303f\uff01-\uff60]+$/u.test(characters)
    || [...new Set(characters)].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!).join('') !== characters) {
    throw new Error('A canonical bounded final-character subset is required')
  }
  const url = new URL('https://fonts.googleapis.com/css2')
  url.searchParams.append('family', 'Noto Sans SC:wght@400')
  url.searchParams.append('family', 'Noto Serif SC:wght@400;900')
  url.searchParams.set('display', 'swap')
  url.searchParams.set('text', characters)
  return `<link rel="stylesheet" href="${url.href.replaceAll('&', '&amp;')}">`
}

type Element = DefaultTreeAdapterMap['element']
type Node = DefaultTreeAdapterMap['node']
const attribute = (node: Element, name: string) => node.attrs.find((item) => item.name === name)?.value
const elements = (node: Node): Element[] => 'childNodes' in node ? node.childNodes.filter((child): child is Element => 'tagName' in child) : []
const isRun = (node: Element) => attribute(node, 'data-anera-cjk') !== undefined
const isTextGroup = (node: Element) => attribute(node, 'data-anera-cjk-text') !== undefined
const isCitation = (node: Element) => node.tagName === 'a' && attribute(node, 'style') === 'color:inherit;text-decoration:inherit'

/** Reject missing, moved, relabelled, or edited CJK runs before font loading. */
export function verifyReferenceLanguageMarkup(html: string, value: ReferenceLanguageVariant) {
  const language = normalizeReferenceLanguageVariant(value)
  if (Buffer.byteLength(html) > REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES) throw new Error('Language markup exceeds its bounded HTML size')
  const document = parse(html)
  const pending: Node[] = [document]
  const roots: Element[] = []
  const allRuns: Element[] = []
  const allGroups: Element[] = []
  while (pending.length) {
    const node = pending.pop()!
    if ('tagName' in node) {
      if (['head', 'script', 'style', 'template', 'noscript'].includes(node.tagName)) continue
      if ((attribute(node, 'class') ?? '').split(/\s+/u).includes('slide')) roots.push(node)
      if (isRun(node)) allRuns.push(node)
      if (isTextGroup(node)) allGroups.push(node)
    }
    if (node.nodeName === '#text' && hasCjk((node as DefaultTreeAdapterMap['textNode']).value)) {
      let parent = node.parentNode
      let inSlide = false
      while (parent) {
        if ('tagName' in parent && (attribute(parent, 'class') ?? '').split(/\s+/u).includes('slide')) { inSlide = true; break }
        parent = 'parentNode' in parent ? parent.parentNode : null
      }
      if (!inSlide) throw new Error('Visible Chinese copy escaped its source slide')
    }
    if ('childNodes' in node) pending.push(...[...node.childNodes].reverse())
  }
  if (!roots.length || roots.length > 64) throw new Error('CJK markup requires bounded source slide roots')
  const accountedRuns = new Set<Element>()
  const accountedGroups = new Set<Element>()
  for (const root of roots) {
    const variant = attribute(root, 'data-anera-cjk-variant')
    const layout = language.layouts.find((item) => item.variant === variant)
    if (!layout || attribute(root, 'class') !== layout.classes) throw new Error('CJK slide lost its source layout identity')
    const nodes: Node[] = [root]
    const groupedSlots = new Set<string>()
    while (nodes.length) {
      const node = nodes.pop()!
      if ('tagName' in node && isTextGroup(node)) {
        const slot = attribute(node, 'data-anera-cjk-text')!
        if (groupedSlots.has(slot) || node.attrs.length !== 1
          || node.tagName !== (node.namespaceURI === 'http://www.w3.org/2000/svg' ? 'tspan' : 'span')
          || !elements(node).length || elements(node).some((child) => !isRun(child))
          || !language.bindings.some((binding) => binding.variant === variant && binding.slot === slot)) throw new Error('CJK text group lost its original literal-text slot')
        groupedSlots.add(slot)
        accountedGroups.add(node)
      }
      if ('tagName' in node && isRun(node)) {
        const binding = language.bindings.find((item) => item.variant === variant && item.slot === attribute(node, 'data-anera-cjk-slot'))
        const identity = `${variant}.${attribute(node, 'data-anera-cjk-slot') ?? '?'}`
        if (!binding || attribute(node, 'data-anera-cjk') !== binding.role
          || attribute(node, 'style') !== referenceLanguageRunStyle(binding.role)) {
          throw new Error(`CJK run ${identity} differs from its source-authorized role and exact typography${binding ? `: expected ${binding.role}, ${referenceLanguageRunStyle(binding.role)}` : ''}`)
        }
        if (node.attrs.length !== 3
          || node.tagName !== (node.namespaceURI === 'http://www.w3.org/2000/svg' ? 'tspan' : 'span')
          || node.childNodes.length !== 1 || node.childNodes[0].nodeName !== '#text') {
          throw new Error(`CJK run ${identity} has invalid structure: keep the source span (or SVG tspan), exactly its three generated attributes and one non-empty literal text node; do not add nested markup`)
        }
        const runText = (node.childNodes[0] as DefaultTreeAdapterMap['textNode']).value
        if (!/^[\p{Script=Han}\u3000-\u303f\uff01-\uff60]+$/u.test(runText)) {
          const nonCjk = /[^\p{Script=Han}\u3000-\u303f\uff01-\uff60]/u.exec(runText)?.[0]
          const codePoint = nonCjk ? ` (first non-CJK code point U+${nonCjk.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})` : ''
          throw new Error(`CJK run ${identity} contains non-CJK text${codePoint}. Keep Latin letters, numbers, whitespace and ASCII punctuation outside the inner data-anera-cjk run but inside the same data-anera-cjk-text group. Preserve the source-authorized role and exact typography; split the text, do not change fonts or layout`)
        }
        let expectedParent: Element | undefined = root
        for (const index of binding.path) expectedParent = expectedParent
          ? elements(expectedParent).filter((child) => !isRun(child) && !isTextGroup(child) && !isCitation(child))[index] : undefined
        let parent = node.parentNode
        if (!parent || !('tagName' in parent) || !isTextGroup(parent)
          || attribute(parent, 'data-anera-cjk-text') !== binding.slot) throw new Error('CJK run lost its original literal-text group')
        parent = parent.parentNode
        if (parent && 'tagName' in parent && isCitation(parent)) parent = parent.parentNode
        if (!expectedParent || parent !== expectedParent) throw new Error('CJK run moved away from its original template text parent')
        accountedRuns.add(node)
      }
      if (node.nodeName === '#text' && hasCjk((node as DefaultTreeAdapterMap['textNode']).value)) {
        const parent = (node as DefaultTreeAdapterMap['textNode']).parentNode
        if (!parent || !('tagName' in parent) || !isRun(parent)) throw new Error('Visible Chinese copy lacks its documented typography run')
      }
      if ('childNodes' in node) nodes.push(...node.childNodes)
    }
  }
  if (accountedRuns.size !== allRuns.length) throw new Error('CJK run escaped its source slide')
  if (accountedGroups.size !== allGroups.length) throw new Error('CJK text group escaped its source slide')
  return { characters: referenceLanguageCharacters(html), runCount: accountedRuns.size }
}

/** Google text subsets declare coverage explicitly; never assume a family name is enough. */
export function assertReferenceLanguageFontCoverage(fontCss: string, characters: string): void {
  const faces = [...fontCss.matchAll(/@font-face\s*\{([^{}]*)\}/giu)].map((match) => {
    const family = /font-family\s*:\s*(['"])(.*?)\1/iu.exec(match[1])?.[2]
    const weight = /font-weight\s*:\s*(\d+)(?:\s+(\d+))?\s*[;}]/iu.exec(match[1])
    const style = /font-style\s*:\s*([^;}]+)/iu.exec(match[1])?.[1].trim().toLowerCase() ?? 'normal'
    const range = /unicode-range\s*:\s*([^;}]+)/iu.exec(match[1])?.[1]
    return { family, style, min: Number(weight?.[1]), max: Number(weight?.[2] ?? weight?.[1]), ranges: (range ?? '').split(',').flatMap((raw) => {
      const part = /^\s*U\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/iu.exec(raw)
      if (!part) return []
      return [[Number.parseInt(part[1].replaceAll('?', '0'), 16), Number.parseInt(part[2] ?? part[1].replaceAll('?', 'f'), 16)]]
    }) }
  })
  for (const rule of Object.values(REFERENCE_LANGUAGE_ROLES)) for (const character of characters) {
    const code = character.codePointAt(0)!
    if (!faces.some((face) => face.family === rule.cjk && face.style === 'normal' && face.min <= rule.weight && face.max >= rule.weight
      && face.ranges.some(([min, max]) => min <= code && code <= max))) {
      throw new Error(`Missing declared CJK glyph coverage: ${rule.cjk} ${rule.weight} U+${code.toString(16).toUpperCase()}`)
    }
  }
}

export async function materializeReferenceLanguageFonts(
  source: string, html: string, language: ReferenceLanguageVariant,
  signal: AbortSignal, fetchImpl: typeof fetch = fetchPublicUrl,
) {
  if (digest(source) !== language.sourceSha256) throw new Error('Language fonts require the bound original template bytes')
  const { characters } = verifyReferenceLanguageMarkup(html, language)
  const fontSource = characters ? source.replace('</head>', `${referenceLanguageFontLink(characters)}</head>`) : source
  const fonts = await materializeReferenceFonts(fontSource, signal, fetchImpl)
  if (characters) assertReferenceLanguageFontCoverage(fonts.fontCss, characters)
  return { ...fonts, characters, charactersSha256: digest(characters) }
}

export function assertReferenceLanguageDelivery(html: string, fontCss: string, language: ReferenceLanguageVariant | undefined): void {
  if (!language) return
  const { characters } = verifyReferenceLanguageMarkup(html, language)
  assertReferenceLanguageFontCoverage(fontCss, characters)
}
