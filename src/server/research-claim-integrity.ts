import { fromMarkdown } from 'mdast-util-from-markdown'
import { parse, type DefaultTreeAdapterMap } from 'parse5'

// These are local contradiction checks, not entailment, entity resolution or
// fact verification. Only explicit measured quantities and named Chinese work
// releases are covered. No dates, numbers or new claims are manufactured.
export interface ResearchClaimItem {
  id: string
  sources: Array<{ url: string; role: string; excerpt?: string }>
}
export interface ResearchClaimIssue {
  code: 'quantity_qualification' | 'planned_event_status'
  itemId: string
  claim: string
  sourceQuote: string
  sourceUrl: string
}
type Qualifier = 'exact' | 'over' | 'at_least' | 'under' | 'at_most' | 'nearly' | 'about'
interface Quantity { token: string; qualifier: Qualifier; quote: string }
const MAX_TEXT = 2_000_000
const MAX_NODES = 100_000
const MAX_ISSUES = 16
const normalize = (value: string) => value.normalize('NFC').replace(/[\t\r ]+/gu, ' ').trim()

/** Visible Markdown words only: link destinations, images and code cannot
 * supply a qualification. Block breaks stay hard boundaries. */
function sourceWords(source: string): string {
  if (source.length > 2_400) return ''
  const pieces: string[] = []
  type Node = { type: string; value?: string; children?: Node[] }
  const pending: Array<Node | '\n'> = [fromMarkdown(source)]
  let visited = 0
  while (pending.length) {
    if (++visited > MAX_NODES) return ''
    const node = pending.pop()!
    if (node === '\n') { pieces.push('\n'); continue }
    if (['html', 'image', 'imageReference', 'code', 'inlineCode', 'definition'].includes(node.type)) { pieces.push('\n'); continue }
    if (node.type === 'text') pieces.push(node.value ?? '')
    if (node.children) {
      if (['paragraph', 'heading', 'listItem', 'blockquote', 'break'].includes(node.type)) {
        pieces.push('\n'); pending.push('\n')
      }
      for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index])
    }
  }
  return normalize(pieces.join(''))
}

function quantities(text: string): Quantity[] {
  const result: Quantity[] = []
  // Explicit scales/units prevent page ordinals and event/publication dates
  // from becoming statistics. Only whole 0–10 成 has an exact percent mapping;
  // do not guess colloquial fractions, rounding or currency/scale conversions.
  const pattern = /\d+(?:,\d{3})*(?:\.\d+)?[ \t]*(?:万亿|千万|百万|十万|亿|万|千|%|％|billion\b|million\b|thousand\b|percent\b|人次|人|家|场|元|分钟|minutes?\b)|(?<![\d一二三四五六七八九十百千万亿.])([一二三四五六七八九十]|10|[0-9])[ \t]*成(?=$|[^\p{L}\p{N}]|以上|以下|左右|余|多)/giu
  for (const match of text.matchAll(pattern)) {
    if (match[1] && text.lastIndexOf('《', match.index) > text.lastIndexOf('》', match.index)) continue
    const before = text.slice(Math.max(0, match.index - 28), match.index)
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 12)
    if (/(?:不是|并非|非|\bnot|\bwasn't|\bisn't)[ \t]*$/iu.test(before)) continue
    const prefixMatch = before.match(/(?:不超过|不少于|不低于|不多于|不到|至少|至多|超过|突破|低于|小于|大于|接近|将近|大约|约有|超|逾|近|约|>=|<=|[<>≤≥≈~]|\bmore than|\bover|\bat least|\bless than|\bunder|\bat most|\bnearly|\balmost|\babout|\baround|\bapproximately)[ \t]*$/iu)
    const suffixMatch = after.match(/^[ \t]*(?:以上|以下|左右|余|多|[+＋])/u)
    const prefix = prefixMatch?.[0].trim().toLowerCase()
    const suffix = suffixMatch?.[0].trim()
    let qualifier: Qualifier = 'exact'
    if (prefix && /^(?:超过|突破|大于|超|逾|>|more than|over)$/u.test(prefix) || suffix && /^(?:余|多|[+＋])$/u.test(suffix)) qualifier = 'over'
    else if (prefix && /^(?:至少|不少于|不低于|≥|>=|at least)$/u.test(prefix) || suffix === '以上') qualifier = 'at_least'
    else if (prefix && /^(?:不到|低于|小于|<|less than|under)$/u.test(prefix)) qualifier = 'under'
    else if (prefix && /^(?:不超过|不多于|至多|≤|<=|at most)$/u.test(prefix) || suffix === '以下') qualifier = 'at_most'
    else if (prefix && /^(?:近|将近|接近|nearly|almost)$/u.test(prefix)) qualifier = 'nearly'
    else if (prefix && /^(?:约|约有|大约|≈|~|about|around|approximately)$/u.test(prefix) || suffix === '左右') qualifier = 'about'
    const fraction = match[1] ? (/^\d+$/u.test(match[1]) ? Number(match[1]) : '一二三四五六七八九十'.indexOf(match[1]) + 1) : undefined
    result.push({ token: fraction !== undefined ? `${fraction * 10}%`
      : match[0].toLowerCase().replace(/[\s,]/gu, '').replaceAll('％', '%').replace(/percent$/u, '%'),
      qualifier, quote: text.slice(match.index - (prefixMatch?.[0].length ?? 0), match.index + match[0].length + (suffixMatch?.[0].length ?? 0)) })
  }
  return result
}

const RELEASE = /发行|推出|发布|上线|上市/gu
const PLANNED = /将于|定于|拟于|预定|计划|预计|即将|将要/gu
const COMPLETED = /已经|已于|已在|已正式|已|此前|曾经|曾于|完成了/gu
const PROMOTIONAL_OBJECT = /(?:曲目列表|预告片?|海报|概念照|封面|声明|公告)/u
const titles = (clause: string) => [...clause.matchAll(/《([^《》\n]{2,80})》/gu)]
const clauses = (text: string) => text.split(/[。！？；;\n，,（）()]|\.(?=\s|$)/u)

function releaseMentions(text: string): Array<{ title: string; planned: boolean; completed: boolean; qualified: boolean; quote: string }> {
  const mentions: ReturnType<typeof releaseMentions> = []
  for (const clause of clauses(text)) {
    const names = titles(clause)
    if (!names.length || clause.length > 600) continue
    for (const verb of clause.matchAll(RELEASE)) {
      // Associate only the closest explicitly named work in this clause, not
      // a different album/film in another sentence or an editorial date note.
      const distances = names.map((name) => ({ name, distance: Math.min(Math.abs(name.index - verb.index), Math.abs(name.index + name[0].length - verb.index)) }))
        .sort((left, right) => left.distance - right.distance)
      if (distances[0].distance > 120 || distances[1]?.distance === distances[0].distance) continue
      const before = clause.slice(Math.max(0, verb.index - 100), verb.index)
      const after = clause.slice(verb.index + verb[0].length, verb.index + verb[0].length + 16)
      // Another release predicate is a boundary: an earlier planned action
      // cannot qualify a subsequent unqualified assertion.
      const local = before.split(RELEASE).at(-1) ?? ''
      const plannedAt = [...local.matchAll(PLANNED)].at(-1)?.index ?? -1
      const completedAt = [...local.matchAll(COMPLETED)].at(-1)?.index ?? -1
      const completed = (completedAt > plannedAt || plannedAt < 0 && /正式/u.test(local)) && !/(?:未|不|没有).{0,5}$/u.test(local)
      const planned = plannedAt >= 0 && !completed
      // Publishing an album's track list/preview is not releasing the album.
      // Inspect the named object's suffix too when the predicate precedes it.
      const name = distances[0].name
      const objectTail = clause.slice(name.index + name[0].length, name.index + name[0].length + 16)
      if (/^(?:了|其|的|相关|新|首张|首支)*?(?:曲目列表|预告片?|海报|概念照|封面|声明|公告)/u.test(after)
        || verb.index < name.index && /^(?:的)?(?:曲目列表|预告片?|海报|概念照|封面|声明|公告)/u.test(objectTail)
        || verb.index > name.index && PROMOTIONAL_OBJECT.test(clause.slice(name.index + name[0].length, verb.index))) continue
      const qualified = planned || /(?:预告|计划|安排|尚未|并未|未确认|未核实|无法确认|是否)/u.test(local)
        || /^(?:前)?(?:预告|计划|安排)|^(?:情况|状态)?(?:尚未|仍未|待)(?:确认|核实)/u.test(after)
      mentions.push({ title: distances[0].name[1], planned, completed, qualified, quote: clause.trim() })
    }
  }
  return mentions
}

/** The caller supplies a single item's text, or a document/Final with explicit
 * names. Ambiguous quantity tokens shared across items are not auto-attributed.
 * Missing excerpts never establish a negative proof. */
export function researchClaimIssues(items: readonly ResearchClaimItem[], text: string): ResearchClaimIssue[] {
  if (text.length > MAX_TEXT || items.length > 16) return []
  const sources = items.flatMap((item) => {
    const supporting = item.sources.filter((source) => source.role === 'primary' || source.role === 'reporting')
    if (!supporting.length || supporting.length > 3 || supporting.some((source) => typeof source.excerpt !== 'string' || !source.excerpt || source.excerpt.length > 2_400)) return []
    return supporting.map((source) => ({ itemId: item.id, url: source.url, words: sourceWords(source.excerpt!) }))
  })
  const sourceQuantities = sources.flatMap((source) => quantities(source.words).map((quantity) => ({ ...quantity, itemId: source.itemId, url: source.url })))
  const byToken = new Map<string, typeof sourceQuantities>()
  for (const quantity of sourceQuantities) {
    const group = byToken.get(quantity.token) ?? []
    group.push(quantity)
    byToken.set(quantity.token, group)
  }
  const candidate = normalize(text)
  const issues: ResearchClaimIssue[] = []
  for (const quantity of quantities(candidate)) {
    const support = byToken.get(quantity.token) ?? []
    if (!support.length || new Set(support.map((source) => source.itemId)).size !== 1
      || support.some((source) => source.qualifier === quantity.qualifier || source.qualifier === 'exact')) continue
    const source = support[0]
    issues.push({ code: 'quantity_qualification', itemId: source.itemId, claim: quantity.quote, sourceQuote: source.quote, sourceUrl: source.url })
    if (issues.length >= MAX_ISSUES) return issues
  }
  const sourceReleases = sources.flatMap((source) => releaseMentions(source.words).map((mention) => ({ ...mention, itemId: source.itemId, url: source.url })))
  for (const mention of releaseMentions(candidate)) {
    if (mention.qualified && !mention.completed) continue
    const supporting = sourceReleases.filter((source) => source.title === mention.title)
    const planned = supporting.find((source) => source.planned)
    if (!planned || supporting.some((source) => source.completed) || new Set(supporting.map((source) => source.itemId)).size !== 1) continue
    issues.push({ code: 'planned_event_status', itemId: planned.itemId, claim: mention.quote, sourceQuote: planned.quote, sourceUrl: planned.url })
    if (issues.length >= MAX_ISSUES) break
  }
  return issues
}

type HtmlNode = DefaultTreeAdapterMap['node']
type HtmlElement = DefaultTreeAdapterMap['element']
const ignoredClaimNode = (node: HtmlElement) => ['head', 'script', 'style', 'template', 'noscript', 'svg', 'canvas', 'iframe', 'object'].includes(node.tagName)
  || node.attrs.some((attr) => attr.name === 'hidden' || attr.name === 'aria-hidden' && attr.value.toLowerCase() === 'true')
const hasClass = (node: HtmlElement, name: string) => (node.attrs.find((attr) => attr.name === 'class')?.value ?? '').split(/\s+/u).includes(name)

/** A recognized statistic's figure and percentage label jointly express one
 * quantity. Never concatenate arbitrary blocks or borrow its description's
 * qualifier. Ambiguous/multiple figures or labels remain outside this check.
 */
function statisticClaims(node: HtmlElement): string[] {
  if (!hasClass(node, 'stat')) return []
  const children = node.childNodes.filter((child): child is HtmlElement => 'tagName' in child && !ignoredClaimNode(child))
  const figures = children.filter((child) => hasClass(child, 'figure'))
  const metas = children.filter((child) => hasClass(child, 'meta'))
  if (figures.length !== 1 || metas.length !== 1) return []
  const labels = metas[0].childNodes.filter((child): child is HtmlElement => 'tagName' in child && !ignoredClaimNode(child) && hasClass(child, 'lab'))
  if (labels.length !== 1) return []
  const literal = (root: HtmlElement): string | undefined => {
    const pending: HtmlNode[] = [root]
    let text = ''
    let visited = 0
    while (pending.length) {
      if (++visited > 256 || text.length > 200) return undefined
      const child = pending.pop()!
      if ('tagName' in child && ignoredClaimNode(child)) continue
      if (child !== root && 'tagName' in child && /^(?:p|div|section|article|footer|aside|h[1-6]|li|br|hr)$/u.test(child.tagName)) return undefined
      if (child.nodeName === '#text') text += (child as DefaultTreeAdapterMap['textNode']).value
      if ('childNodes' in child) pending.push(...[...child.childNodes].reverse())
    }
    return text.length <= 200 ? normalize(text) : undefined
  }
  const value = literal(figures[0])
  const label = literal(labels[0])
  if (!value || !label || (label.match(/[%％]/gu)?.length ?? 0) !== 1 || /\d\s*[%％]/u.test(label)) return []
  const number = /^([^\d]*)(\d+(?:\.\d+)?)([^\d]*)$/u.exec(value)
  if (!number) return []
  const valueWithUnit = `${number[1]}${number[2]}%${number[3]}`
  const parsed = quantities(valueWithUnit)
  if (parsed.length !== 1 || normalize(parsed[0].quote) !== normalize(valueWithUnit)) return []
  const joined = label.replace(/[%％]/u, valueWithUnit)
  const labelOnly = label.replace(/[%％]/u, `${number[2]}%`)
  // An explicit "about" in the label must not disappear behind a plus sign
  // in the figure. Validate both asserted qualifications in that case.
  const qualifiedLabel = quantities(labelOnly).some((quantity) => quantity.qualifier !== 'exact')
  return qualifiedLabel && joined !== labelOnly ? [joined, labelOnly] : [joined]
}

/** Bounded HTML text projection for the write/present boundary. It preserves
 * inline numeral/unit adjacency; headings/footnotes cannot lend qualifiers to
 * other blocks. This is source text, not rendered visibility attestation. */
export function researchHtmlClaimGap(items: readonly ResearchClaimItem[], html: string): string | undefined {
  if (Buffer.byteLength(html) > MAX_TEXT) return 'Research-claim verification incomplete: HTML exceeds the bounded source scan.'
  const pieces: string[] = []
  type Node = DefaultTreeAdapterMap['node']
  const pending: Array<Node | '\n'> = [parse(html)]
  let visited = 0
  while (pending.length) {
    if (++visited > MAX_NODES) return 'Research-claim verification incomplete: HTML exceeds the bounded node scan.'
    const node = pending.pop()!
    if (node === '\n') { pieces.push('\n'); continue }
    if ('tagName' in node) {
      if (ignoredClaimNode(node)) { pieces.push('\n'); continue }
      for (const claim of statisticClaims(node)) pieces.push('\n', claim, '\n')
      if (/^(?:p|div|section|article|main|header|footer|h[1-6]|li|tr|br|hr)$/u.test(node.tagName)) { pieces.push('\n'); pending.push('\n') }
    }
    if (node.nodeName === '#text') pieces.push((node as DefaultTreeAdapterMap['textNode']).value)
    if ('childNodes' in node) for (let index = node.childNodes.length - 1; index >= 0; index -= 1) pending.push(node.childNodes[index])
  }
  const issues = researchClaimIssues(items, pieces.join(''))
  return issues.length ? researchClaimIssueMessage(issues) : undefined
}

export function researchClaimIssueMessage(issues: readonly ResearchClaimIssue[]): string {
  return `Research-claim verification failed: ${JSON.stringify(issues.slice(0, 8))}. Preserve the source qualification in each headline, numeral and main sentence; a separate footnote cannot repair a stronger claim. Revise the wording or provide explicit supporting source evidence. This narrow check is not general fact verification.`
}
