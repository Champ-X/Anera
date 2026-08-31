import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.yaml', '.yml', '.js', '.ts', '.tsx', '.jsx', '.css', '.svg', '.py'])
const OFFICE_ENTRY_LIMIT = 16 * 1024 * 1024

export interface AttachmentExtractionPage {
  content: string
  format: 'text' | 'pdf' | 'docx' | 'xlsx' | 'pptx'
  unit: 'text' | 'page' | 'item' | 'sheet' | 'slide'
  truncated: boolean
  totalItems?: number
  startItem?: number
  endItem?: number
  nextItem?: number
  partialItem?: number
  contentStartOffset?: number
  contentEndOffset?: number
  nextContentOffset?: number
  outputBytes: number
}

export interface AttachmentExtractionOptions {
  pageStart?: number
  pageEnd?: number
  itemStart?: number
  itemEnd?: number
  contentOffset?: number
}

export async function extractAttachment(
  path: string,
  maxBytes: number,
  options: AttachmentExtractionOptions = {},
  signal?: AbortSignal,
): Promise<string> {
  return (await extractAttachmentPage(path, maxBytes, options, signal)).content
}

export async function extractAttachmentPage(
  path: string,
  maxBytes: number,
  options: AttachmentExtractionOptions = {},
  signal?: AbortSignal,
): Promise<AttachmentExtractionPage> {
  signal?.throwIfAborted()
  const extension = extname(path).toLowerCase()
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer')
  validateExtractionOptions(options)
  if (TEXT_EXTENSIONS.has(extension)) {
    if (options.pageStart !== undefined || options.pageEnd !== undefined || options.itemStart !== undefined || options.itemEnd !== undefined || options.contentOffset !== undefined) {
      throw new Error('Use read_file offset/limit to page through text attachments')
    }
    const source = await readFile(path, { encoding: 'utf8', signal })
    const content = truncateUtf8(source, maxBytes)
    return { content, format: 'text', unit: 'text', truncated: content !== source, outputBytes: Buffer.byteLength(content) }
  }
  if (extension === '.pdf') {
    if (options.itemStart !== undefined || options.itemEnd !== undefined) throw new Error('PDF attachments use page_start/page_end')
    return await extractPdf(path, maxBytes, options, signal)
  }
  if (options.pageStart !== undefined || options.pageEnd !== undefined) throw new Error('Office attachments use item_start/item_end')
  if (extension === '.docx') return await extractDocx(path, maxBytes, options, signal)
  if (extension === '.xlsx') return await extractXlsx(path, maxBytes, options, signal)
  if (extension === '.pptx') return await extractPptx(path, maxBytes, options, signal)
  throw new Error(`Unsupported attachment format: ${extension || 'no extension'}`)
}

async function extractPdf(
  path: string,
  maxBytes: number,
  options: AttachmentExtractionOptions,
  signal?: AbortSignal,
): Promise<AttachmentExtractionPage> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(path, { signal }))
  const loadingTask = getDocument({ data, useSystemFonts: true })
  const document = await loadingTask.promise
  try {
    const pages: string[] = []
    const pageStart = Math.floor(options.pageStart ?? 1)
    const requestedPageEnd = Math.floor(options.pageEnd ?? document.numPages)
    if (pageStart > document.numPages) throw new Error(`page_start ${pageStart} is beyond the PDF (${document.numPages} pages total)`)
    if (requestedPageEnd < pageStart) throw new Error('page_end must be greater than or equal to page_start')
    const pageEnd = Math.min(document.numPages, requestedPageEnd)
    let endItem = pageStart - 1
    let nextItem: number | undefined
    let partialItem: number | undefined
    let contentStartOffset: number | undefined
    let contentEndOffset: number | undefined
    let nextContentOffset: number | undefined
    for (let pageNumber = pageStart; pageNumber <= pageEnd; pageNumber += 1) {
      signal?.throwIfAborted()
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .trim()
      const itemOffset = pageNumber === pageStart ? options.contentOffset ?? 0 : 0
      const appended = appendBoundedSection(pages, `--- PDF page ${pageNumber} of ${document.numPages} ---`, text, maxBytes, itemOffset)
      if (appended.status === 'rejected') {
        nextItem = pageNumber
        break
      }
      endItem = pageNumber
      if (appended.status === 'partial') {
        partialItem = pageNumber
        contentStartOffset = appended.startOffset
        contentEndOffset = appended.endOffset
        nextContentOffset = appended.nextOffset
        break
      }
    }
    const content = pages.join('\n\n')
    return {
      content,
      format: 'pdf',
      unit: 'page',
      truncated: nextItem !== undefined || partialItem !== undefined,
      totalItems: document.numPages,
      startItem: pageStart,
      endItem,
      ...(nextItem !== undefined ? { nextItem } : {}),
      ...(partialItem !== undefined ? { partialItem } : {}),
      ...(contentStartOffset !== undefined ? { contentStartOffset } : {}),
      ...(contentEndOffset !== undefined ? { contentEndOffset } : {}),
      ...(nextContentOffset !== undefined ? { nextContentOffset } : {}),
      outputBytes: Buffer.byteLength(content),
    }
  } finally {
    await loadingTask.destroy()
  }
}

async function extractDocx(
  path: string,
  maxBytes: number,
  options: AttachmentExtractionOptions,
  signal?: AbortSignal,
): Promise<AttachmentExtractionPage> {
  const entries = new Set(await listZipEntries(path, signal))
  if (!entries.has('word/document.xml')) throw new Error('DOCX is missing word/document.xml')
  const candidates = [
    'word/document.xml',
    ...[...entries].filter((entry) => /^word\/(?:header|footer)\d+\.xml$/.test(entry)).sort(naturalCompare),
    ...['word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml'].filter((entry) => entries.has(entry)),
  ]
  const range = itemRange(options, candidates.length, 'DOCX')
  const sections: string[] = []
  let endItem = range.start - 1
  let nextItem: number | undefined
  let partialItem: number | undefined
  let contentStartOffset: number | undefined
  let contentEndOffset: number | undefined
  let nextContentOffset: number | undefined
  for (let itemNumber = range.start; itemNumber <= range.end; itemNumber += 1) {
    signal?.throwIfAborted()
    const entry = candidates[itemNumber - 1]
    const xml = await unzipEntry(path, entry, officeEntryBuffer(maxBytes), signal)
    const text = itemNumber === 1 ? wordDocumentXmlToText(xml) : wordSupportingXmlToText(xml, entry)
    const label = itemNumber === 1 ? 'DOCX main document' : `DOCX ${entry.replace(/^word\//, '').replace(/\.xml$/, '')}`
    const itemOffset = itemNumber === range.start ? options.contentOffset ?? 0 : 0
    const appended = appendBoundedSection(sections, `--- ${label} ---`, text || '[empty section]', maxBytes, itemOffset)
    if (appended.status === 'rejected') {
      nextItem = itemNumber
      break
    }
    endItem = itemNumber
    if (appended.status === 'partial') {
      partialItem = itemNumber
      contentStartOffset = appended.startOffset
      contentEndOffset = appended.endOffset
      nextContentOffset = appended.nextOffset
      break
    }
  }
  const content = sections.join('\n\n')
  return {
    content,
    format: 'docx',
    unit: 'item',
    truncated: nextItem !== undefined || partialItem !== undefined,
    totalItems: candidates.length,
    startItem: range.start,
    endItem,
    ...(nextItem !== undefined ? { nextItem } : {}),
    ...(partialItem !== undefined ? { partialItem } : {}),
    ...(contentStartOffset !== undefined ? { contentStartOffset } : {}),
    ...(contentEndOffset !== undefined ? { contentEndOffset } : {}),
    ...(nextContentOffset !== undefined ? { nextContentOffset } : {}),
    outputBytes: Buffer.byteLength(content),
  }
}

async function extractXlsx(
  path: string,
  maxBytes: number,
  options: AttachmentExtractionOptions,
  signal?: AbortSignal,
): Promise<AttachmentExtractionPage> {
  const entries = new Set(await listZipEntries(path, signal))
  const sharedStrings = entries.has('xl/sharedStrings.xml')
    ? parseSharedStrings(await unzipEntry(path, 'xl/sharedStrings.xml', officeEntryBuffer(maxBytes), signal))
    : []
  const workbookXml = entries.has('xl/workbook.xml')
    ? await unzipEntry(path, 'xl/workbook.xml', officeEntryBuffer(maxBytes), signal)
    : ''
  const relationshipsXml = entries.has('xl/_rels/workbook.xml.rels')
    ? await unzipEntry(path, 'xl/_rels/workbook.xml.rels', officeEntryBuffer(maxBytes), signal)
    : ''
  const relationships = parseRelationships(relationshipsXml, 'xl/workbook.xml')
  const workbookSheets = parseWorkbookSheets(workbookXml)
    .map((sheet) => ({ ...sheet, entry: relationships.get(sheet.relationshipId) }))
    .filter((sheet): sheet is { name: string; relationshipId: string; state?: string; entry: string } => Boolean(sheet.entry && entries.has(sheet.entry)))
  const fallbackEntries = [...entries].filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry)).sort(naturalCompare)
  const sheets = workbookSheets.length > 0
    ? workbookSheets
    : fallbackEntries.map((entry, index) => ({ name: `Sheet ${index + 1}`, relationshipId: '', state: undefined, entry }))
  if (sheets.length === 0) throw new Error('XLSX contains no readable worksheets')

  const range = itemRange(options, sheets.length, 'XLSX')
  const sections: string[] = []
  let endItem = range.start - 1
  let nextItem: number | undefined
  let partialItem: number | undefined
  let contentStartOffset: number | undefined
  let contentEndOffset: number | undefined
  let nextContentOffset: number | undefined
  for (let itemNumber = range.start; itemNumber <= range.end; itemNumber += 1) {
    signal?.throwIfAborted()
    const sheet = sheets[itemNumber - 1]
    const xml = await unzipEntry(path, sheet.entry, officeEntryBuffer(maxBytes), signal)
    const text = worksheetXmlToText(xml, sharedStrings)
    const state = sheet.state && sheet.state !== 'visible' ? ` [${sheet.state}]` : ''
    const itemOffset = itemNumber === range.start ? options.contentOffset ?? 0 : 0
    const appended = appendBoundedSection(sections, `--- XLSX sheet ${itemNumber}: ${sheet.name}${state} ---`, text || '[empty sheet]', maxBytes, itemOffset)
    if (appended.status === 'rejected') {
      nextItem = itemNumber
      break
    }
    endItem = itemNumber
    if (appended.status === 'partial') {
      partialItem = itemNumber
      contentStartOffset = appended.startOffset
      contentEndOffset = appended.endOffset
      nextContentOffset = appended.nextOffset
      break
    }
  }
  const content = sections.join('\n\n')
  return {
    content,
    format: 'xlsx',
    unit: 'sheet',
    truncated: nextItem !== undefined || partialItem !== undefined,
    totalItems: sheets.length,
    startItem: range.start,
    endItem,
    ...(nextItem !== undefined ? { nextItem } : {}),
    ...(partialItem !== undefined ? { partialItem } : {}),
    ...(contentStartOffset !== undefined ? { contentStartOffset } : {}),
    ...(contentEndOffset !== undefined ? { contentEndOffset } : {}),
    ...(nextContentOffset !== undefined ? { nextContentOffset } : {}),
    outputBytes: Buffer.byteLength(content),
  }
}

async function extractPptx(
  path: string,
  maxBytes: number,
  options: AttachmentExtractionOptions,
  signal?: AbortSignal,
): Promise<AttachmentExtractionPage> {
  const entries = new Set(await listZipEntries(path, signal))
  const presentationXml = entries.has('ppt/presentation.xml')
    ? await unzipEntry(path, 'ppt/presentation.xml', officeEntryBuffer(maxBytes), signal)
    : ''
  const relationshipsXml = entries.has('ppt/_rels/presentation.xml.rels')
    ? await unzipEntry(path, 'ppt/_rels/presentation.xml.rels', officeEntryBuffer(maxBytes), signal)
    : ''
  const relationships = parseRelationships(relationshipsXml, 'ppt/presentation.xml')
  const orderedEntries = parsePresentationSlideIds(presentationXml)
    .map((relationshipId) => relationships.get(relationshipId))
    .filter((entry): entry is string => Boolean(entry && entries.has(entry)))
  const fallbackEntries = [...entries].filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry)).sort(naturalCompare)
  const slides = orderedEntries.length > 0 ? orderedEntries : fallbackEntries
  if (slides.length === 0) throw new Error('PPTX contains no readable slides')

  const range = itemRange(options, slides.length, 'PPTX')
  const sections: string[] = []
  let endItem = range.start - 1
  let nextItem: number | undefined
  let partialItem: number | undefined
  let contentStartOffset: number | undefined
  let contentEndOffset: number | undefined
  let nextContentOffset: number | undefined
  for (let itemNumber = range.start; itemNumber <= range.end; itemNumber += 1) {
    signal?.throwIfAborted()
    const entry = slides[itemNumber - 1]
    const xml = await unzipEntry(path, entry, officeEntryBuffer(maxBytes), signal)
    const slideText = drawingXmlToText(xml)
    const chartEntries = await pptxChartEntries(path, entry, entries, signal)
    const chartText = (await Promise.all(chartEntries.map(async (chartEntry) => (
      chartXmlToText(await unzipEntry(path, chartEntry, officeEntryBuffer(maxBytes), signal))
    )))).filter(Boolean).join('\n')
    const notesEntry = await pptxNotesEntry(path, entry, entries, signal)
    const notesText = notesEntry
      ? drawingXmlToText(await unzipEntry(path, notesEntry, officeEntryBuffer(maxBytes), signal))
      : ''
    const body = [
      slideText || '[no text on slide]',
      chartText && `Chart data:\n${chartText}`,
      notesText && `Speaker notes:\n${notesText}`,
    ].filter(Boolean).join('\n')
    const itemOffset = itemNumber === range.start ? options.contentOffset ?? 0 : 0
    const appended = appendBoundedSection(sections, `--- PPTX slide ${itemNumber} ---`, body, maxBytes, itemOffset)
    if (appended.status === 'rejected') {
      nextItem = itemNumber
      break
    }
    endItem = itemNumber
    if (appended.status === 'partial') {
      partialItem = itemNumber
      contentStartOffset = appended.startOffset
      contentEndOffset = appended.endOffset
      nextContentOffset = appended.nextOffset
      break
    }
  }
  const content = sections.join('\n\n')
  return {
    content,
    format: 'pptx',
    unit: 'slide',
    truncated: nextItem !== undefined || partialItem !== undefined,
    totalItems: slides.length,
    startItem: range.start,
    endItem,
    ...(nextItem !== undefined ? { nextItem } : {}),
    ...(partialItem !== undefined ? { partialItem } : {}),
    ...(contentStartOffset !== undefined ? { contentStartOffset } : {}),
    ...(contentEndOffset !== undefined ? { contentEndOffset } : {}),
    ...(nextContentOffset !== undefined ? { nextContentOffset } : {}),
    outputBytes: Buffer.byteLength(content),
  }
}

function itemRange(options: AttachmentExtractionOptions, totalItems: number, label: string): { start: number; end: number } {
  const start = Math.floor(options.itemStart ?? 1)
  const requestedEnd = Math.floor(options.itemEnd ?? totalItems)
  if (start < 1) throw new Error('item_start must be at least 1')
  if (start > totalItems) throw new Error(`item_start ${start} is beyond the ${label} attachment (${totalItems} items total)`)
  if (requestedEnd < start) throw new Error('item_end must be greater than or equal to item_start')
  return { start, end: Math.min(totalItems, requestedEnd) }
}

interface BoundedSectionResult {
  status: 'complete' | 'partial' | 'rejected'
  startOffset?: number
  endOffset?: number
  nextOffset?: number
}

function appendBoundedSection(
  sections: string[],
  header: string,
  body: string,
  maxBytes: number,
  contentOffset: number,
): BoundedSectionResult {
  const separatorBytes = sections.length > 0 ? 2 : 0
  const currentBytes = sections.reduce((total, value, index) => total + Buffer.byteLength(value) + (index > 0 ? 2 : 0), 0)
  const bodyBuffer = Buffer.from(body)
  assertUtf8Offset(bodyBuffer, contentOffset)
  const prefix = `${header}\n`
  const availableBytes = maxBytes - currentBytes - separatorBytes
  const remainingBody = bodyBuffer.subarray(contentOffset).toString('utf8')
  const section = `${prefix}${remainingBody}`
  if (Buffer.byteLength(section) <= availableBytes) {
    sections.push(section)
    return { status: 'complete', startOffset: contentOffset, endOffset: bodyBuffer.length }
  }
  if (sections.length > 0) return { status: 'rejected' }
  const bodyBudget = availableBytes - Buffer.byteLength(prefix)
  if (bodyBudget < 1) throw new Error(`Attachment page limit ${maxBytes} is too small for the section header`)
  const chunk = sliceUtf8Bytes(bodyBuffer, contentOffset, bodyBudget)
  if (chunk.endOffset === contentOffset && contentOffset < bodyBuffer.length) {
    throw new Error(`Attachment page limit ${maxBytes} is too small for the next UTF-8 character`)
  }
  sections.push(`${prefix}${chunk.text}`)
  return {
    status: 'partial',
    startOffset: contentOffset,
    endOffset: chunk.endOffset,
    nextOffset: chunk.endOffset,
  }
}

function validateExtractionOptions(options: AttachmentExtractionOptions): void {
  const oneBased = [
    ['page_start', options.pageStart],
    ['page_end', options.pageEnd],
    ['item_start', options.itemStart],
    ['item_end', options.itemEnd],
  ] as const
  for (const [name, value] of oneBased) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer`)
  }
  if (options.contentOffset !== undefined && (!Number.isInteger(options.contentOffset) || options.contentOffset < 0)) {
    throw new Error('content_offset must be a non-negative integer')
  }
}

function assertUtf8Offset(buffer: Buffer, offset: number): void {
  if (offset > buffer.length) throw new Error(`content_offset ${offset} is beyond this attachment item (${buffer.length} UTF-8 bytes)`)
  if (offset < buffer.length && (buffer[offset] & 0xC0) === 0x80) throw new Error(`content_offset ${offset} is not a UTF-8 character boundary`)
}

function sliceUtf8Bytes(buffer: Buffer, startOffset: number, maxBytes: number): { text: string; endOffset: number } {
  let endOffset = Math.min(buffer.length, startOffset + maxBytes)
  while (endOffset > startOffset && endOffset < buffer.length && (buffer[endOffset] & 0xC0) === 0x80) endOffset -= 1
  return { text: buffer.subarray(startOffset, endOffset).toString('utf8'), endOffset }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text)
  if (buffer.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buffer[end] & 0xC0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

async function pptxNotesEntry(path: string, slideEntry: string, entries: Set<string>, signal?: AbortSignal): Promise<string | undefined> {
  return (await pptxRelatedEntries(path, slideEntry, entries, 'notesSlide', signal))[0]
}

async function pptxChartEntries(path: string, slideEntry: string, entries: Set<string>, signal?: AbortSignal): Promise<string[]> {
  return await pptxRelatedEntries(path, slideEntry, entries, 'chart', signal)
}

async function pptxRelatedEntries(
  path: string,
  slideEntry: string,
  entries: Set<string>,
  relationshipType: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const relationshipEntry = posix.join(posix.dirname(slideEntry), '_rels', `${posix.basename(slideEntry)}.rels`)
  if (!entries.has(relationshipEntry)) return []
  const relationshipsXml = await unzipEntry(path, relationshipEntry, 2_000_000, signal)
  const related: string[] = []
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1]
    const type = xmlAttribute(attributes, 'Type') || ''
    if (!new RegExp(`/${relationshipType}(?:\\b|$)`, 'i').test(type)) continue
    const target = xmlAttribute(attributes, 'Target')
    if (!target) continue
    const entry = archiveTarget(slideEntry, target)
    if (entries.has(entry)) related.push(entry)
  }
  return related
}

async function unzipEntry(path: string, entry: string, maxBuffer: number, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync('unzip', ['-p', path, entry], { maxBuffer, encoding: 'utf8', signal })
  return stdout
}

async function listZipEntries(path: string, signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await execFileAsync('unzip', ['-Z1', path], { maxBuffer: 2_000_000, encoding: 'utf8', signal })
  return stdout.split(/\r?\n/).filter(Boolean)
}

function officeEntryBuffer(maxBytes: number): number {
  return Math.min(OFFICE_ENTRY_LIMIT, Math.max(2_000_000, maxBytes * 8))
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true })
}

function parseRelationships(xml: string, baseEntry: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const id = xmlAttribute(match[1], 'Id')
    const target = xmlAttribute(match[1], 'Target')
    const mode = xmlAttribute(match[1], 'TargetMode')
    if (!id || !target || mode?.toLowerCase() === 'external') continue
    result.set(id, archiveTarget(baseEntry, target))
  }
  return result
}

function archiveTarget(baseEntry: string, target: string): string {
  const decoded = decodeXml(target).replaceAll('\\', '/')
  if (decoded.startsWith('/')) return posix.normalize(decoded.slice(1))
  return posix.normalize(posix.join(posix.dirname(baseEntry), decoded))
}

function parseWorkbookSheets(xml: string): Array<{ name: string; relationshipId: string; state?: string }> {
  const sheets: Array<{ name: string; relationshipId: string; state?: string }> = []
  for (const match of xml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const name = xmlAttribute(match[1], 'name')
    const relationshipId = xmlAttribute(match[1], 'r:id')
    if (name && relationshipId) sheets.push({ name, relationshipId, state: xmlAttribute(match[1], 'state') })
  }
  return sheets
}

function parsePresentationSlideIds(xml: string): string[] {
  const result: string[] = []
  for (const match of xml.matchAll(/<p:sldId\b([^>]*)\/?\s*>/gi)) {
    const relationshipId = xmlAttribute(match[1], 'r:id')
    if (relationshipId) result.push(relationshipId)
  }
  return result
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => xmlTextRuns(match[1]).join(''))
}

function worksheetXmlToText(xml: string, sharedStrings: string[]): string {
  const lines: string[] = []
  const formulaWarnings: string[] = []
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    const rowNumber = xmlAttribute(rowMatch[1], 'r') || '?'
    const cells: string[] = []
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/gi)) {
      const attributes = cellMatch[1]
      const body = cellMatch[2] || ''
      const reference = xmlAttribute(attributes, 'r') || '?'
      const type = xmlAttribute(attributes, 't') || 'n'
      const rawValue = firstXmlTagText(body, 'v')
      const formula = firstXmlTagText(body, 'f')
      let value = rawValue
      if (type === 's') value = sharedStrings[Number.parseInt(rawValue, 10)] ?? `[missing shared string ${rawValue}]`
      else if (type === 'inlineStr') value = xmlTextRuns(body).join('')
      else if (type === 'b') value = rawValue === '1' ? 'TRUE' : 'FALSE'
      else if (type === 'e') value = `#ERROR ${rawValue}`
      const rendered = JSON.stringify(value ?? '')
      cells.push(`${reference}=${rendered}${formula ? ` [formula: ${formula}]` : ''}`)
      const normalizedFormula = formula.trim().replace(/^=/, '').trim()
      const escapedReference = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (normalizedFormula && new RegExp(`^${escapedReference}\\s*=`, 'i').test(normalizedFormula)) {
        formulaWarnings.push(`[OFFICE VERIFICATION FAILED: Formula in ${reference} begins with its own destination reference (${JSON.stringify(formula)}). Store only the expression in the formula field, without a leading "=" or "${reference}=" prefix, then regenerate and re-extract.]`)
      }
    }
    if (cells.length > 0) lines.push(`Row ${rowNumber}: ${cells.join(' | ')}`)
  }
  const merged = [...xml.matchAll(/<mergeCell\b([^>]*)\/?\s*>/gi)]
    .map((match) => xmlAttribute(match[1], 'ref'))
    .filter((value): value is string => Boolean(value))
  if (merged.length > 0) lines.push(`Merged cells: ${merged.join(', ')}`)
  lines.push(...formulaWarnings)
  return lines.join('\n')
}

function wordXmlToText(xml: string): string {
  return normalizeExtractedText(xml
    .replace(/<w:tab\b[^>]*\/?\s*>/gi, '\t')
    .replace(/<w:br\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<\/w:tc>/gi, '\t')
    .replace(/<\/w:tr>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
}

function wordSupportingXmlToText(xml: string, entry: string): string {
  const text = wordXmlToText(xml)
  const fields = wordFieldInstructions(xml)
  const lines = [text]
  if (fields.length > 0) lines.push(`Word fields: ${fields.join(' | ')}`)
  if (/^word\/footer\d+\.xml$/i.test(entry) && /\bPAGE\b/.test(text) && !fields.some((field) => /\bPAGE\b/i.test(field))) {
    lines.push('[OFFICE VERIFICATION FAILED: Footer contains typed text "PAGE" but no dynamic PAGE field instruction. Use the Word library\'s real current-page field, regenerate, and re-extract before presenting.]')
  }
  return lines.filter(Boolean).join('\n')
}

function wordFieldInstructions(xml: string): string[] {
  const values = [
    ...[...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?instrText\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?instrText>/gi)]
      .map((match) => decodeXml(match[1].replace(/<[^>]+>/g, '')).trim()),
    ...[...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?fldSimple\b([^>]*)>/gi)]
      .map((match) => xmlLocalAttribute(match[1], 'instr')?.trim() || ''),
  ].filter(Boolean)
  return values.filter((value, index) => values.indexOf(value) === index)
}

interface WordParagraphProjection {
  text: string
  style?: string
  numbered: boolean
  explicitPageBreaks: number
  pageBreakBefore: boolean
}

interface WordTableProjection {
  rows: string[][]
}

/**
 * Preserve the semantic shape of a Word document instead of flattening tables
 * into ambiguous tabs. This projection is deliberately plain text so the
 * agent can compare the independent OOXML parse with the user's requested
 * paragraph styles, table dimensions, row mappings, numbering, and pagination.
 */
function wordDocumentXmlToText(xml: string): string {
  const body = firstXmlElementBody(xml, 'body') || xml
  const paragraphs: WordParagraphProjection[] = []
  const tables: WordTableProjection[] = []
  const orderedBlocks: Array<{ kind: 'paragraph'; value: WordParagraphProjection } | { kind: 'table'; value: WordTableProjection }> = []
  const blockPattern = /<(?:[A-Za-z_][\w.-]*:)?(p|tbl)\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?\1>/gi

  for (const match of body.matchAll(blockPattern)) {
    if (match[1].toLowerCase() === 'p') {
      const paragraph = projectWordParagraph(match[0])
      paragraphs.push(paragraph)
      orderedBlocks.push({ kind: 'paragraph', value: paragraph })
    } else {
      const table = projectWordTable(match[0])
      tables.push(table)
      orderedBlocks.push({ kind: 'table', value: table })
    }
  }

  // Malformed or unusual producers may omit a conventional w:body wrapper.
  // Retain the old text projection as a safe fallback rather than returning an
  // empty preview.
  if (orderedBlocks.length === 0) return wordXmlToText(xml)

  const titleCount = paragraphs.filter((paragraph) => paragraph.style?.toLowerCase() === 'title').length
  const headingOneCount = paragraphs.filter((paragraph) => /^heading\s*1$/i.test(paragraph.style || '')).length
  const numberedCount = paragraphs.filter((paragraph) => paragraph.numbered).length
  const explicitPageBreakCount = paragraphs.reduce((total, paragraph) => total + paragraph.explicitPageBreaks, 0)
  const pageBreakBeforeCount = paragraphs.filter((paragraph) => paragraph.pageBreakBefore).length
  const lines = [
    `Document structure: paragraphs=${paragraphs.length} | Title=${titleCount} | Heading 1=${headingOneCount} | numbered=${numberedCount} | explicit page breaks=${explicitPageBreakCount} | page-break-before=${pageBreakBeforeCount} | tables=${tables.length}`,
  ]
  let paragraphNumber = 0
  let tableNumber = 0

  for (const block of orderedBlocks) {
    if (block.kind === 'paragraph') {
      paragraphNumber += 1
      const annotations: string[] = []
      if (block.value.style) annotations.push(`style=${block.value.style}`)
      if (block.value.numbered) annotations.push('numbered')
      if (block.value.explicitPageBreaks > 0) annotations.push(`explicit-page-breaks=${block.value.explicitPageBreaks}`)
      if (block.value.pageBreakBefore) annotations.push('page-break-before')
      const annotation = annotations.length > 0 ? ` [${annotations.join(', ')}]` : ''
      lines.push(`DOCX paragraph ${paragraphNumber}${annotation}: ${block.value.text || '[empty]'}`)
      continue
    }

    tableNumber += 1
    const widths = block.value.rows.map((row) => row.length)
    const uniqueWidths = [...new Set(widths)]
    const shape = uniqueWidths.length === 1
      ? `${block.value.rows.length} rows x ${uniqueWidths[0] || 0} columns`
      : `${block.value.rows.length} rows; row widths=${widths.join(',')}`
    lines.push(`DOCX table ${tableNumber}: ${shape}`)
    block.value.rows.forEach((row, rowIndex) => {
      lines.push(`DOCX table ${tableNumber} row ${rowIndex + 1}: ${row.map((cell) => cell || '[empty]').join(' | ')}`)
    })
  }

  return lines.join('\n')
}

function projectWordParagraph(xml: string): WordParagraphProjection {
  const styleTag = xml.match(/<(?:[A-Za-z_][\w.-]*:)?pStyle\b([^>]*)\/?\s*>/i)
  const style = styleTag ? xmlLocalAttribute(styleTag[1], 'val') : undefined
  const explicitPageBreaks = [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?br\b([^>]*)\/?\s*>/gi)]
    .filter((match) => xmlLocalAttribute(match[1], 'type')?.toLowerCase() === 'page')
    .length
  return {
    text: wordXmlToText(xml).replace(/\n+/g, ' / '),
    ...(style ? { style } : {}),
    numbered: /<(?:[A-Za-z_][\w.-]*:)?numPr\b/i.test(xml),
    explicitPageBreaks,
    pageBreakBefore: /<(?:[A-Za-z_][\w.-]*:)?pageBreakBefore\b/i.test(xml),
  }
}

function projectWordTable(xml: string): WordTableProjection {
  const rows: string[][] = []
  for (const rowMatch of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?tr\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<(?:[A-Za-z_][\w.-]*:)?tc\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?tc>/gi)]
      .map((cellMatch) => wordXmlToText(cellMatch[1]).replace(/\n+/g, ' / '))
    rows.push(cells)
  }
  return { rows }
}

function drawingXmlToText(xml: string): string {
  const paragraphs = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi)]
    .map((match) => xmlTextRuns(match[1]).join('').trim())
    .filter(Boolean)
  return paragraphs.length > 0 ? paragraphs.join('\n') : normalizeExtractedText(xml.replace(/<[^>]+>/g, ' '))
}

function chartXmlToText(xml: string): string {
  const lines: string[] = []
  const chartKind = xml.match(/<(?:[A-Za-z_][\w.-]*:)?(doughnutChart|pieChart|pie3DChart)\b/i)?.[1]
  let maximumCategoryCount = 0
  let maximumValueCount = 0
  const series = [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?ser\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?ser>/gi)]
  for (let index = 0; index < series.length; index += 1) {
    const body = series[index][1]
    const name = chartPointValues(firstXmlElementBody(body, 'tx'))[0] || `Series ${index + 1}`
    const categories = chartPointValues(firstXmlElementBody(body, 'cat'))
    const values = chartPointValues(firstXmlElementBody(body, 'val'))
    maximumCategoryCount = Math.max(maximumCategoryCount, categories.length)
    maximumValueCount = Math.max(maximumValueCount, values.length)
    const pairs = values.map((value, pointIndex) => `${categories[pointIndex] || `Point ${pointIndex + 1}`}=${value}`)
    lines.push(`Series ${name}: ${pairs.length > 0 ? pairs.join(' | ') : '[no cached values]'}`)
  }
  if (chartKind && Math.max(maximumCategoryCount, maximumValueCount) <= 1) {
    lines.push(`[OFFICE VERIFICATION FAILED: ${chartKind} contains only one cached category. Compare Chart data with every category/value requested by the user; do not present the file while any requested category or value is absent.]`)
  }
  return lines.join('\n')
}

function firstXmlElementBody(xml: string, localName: string): string {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = xml.match(new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}>`, 'i'))
  return match?.[1] || ''
}

function chartPointValues(xml: string): string[] {
  const points = [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?pt\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?pt>/gi)]
    .map((match, position) => ({
      index: Number.parseInt(xmlAttribute(match[1], 'idx') || String(position), 10),
      value: firstXmlTagText(match[2], 'v'),
    }))
    .filter((point) => point.value !== '')
    .sort((left, right) => left.index - right.index)
  if (points.length > 0) return points.map((point) => point.value)
  return [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/gi)]
    .map((match) => decodeXml(match[1].replace(/<[^>]+>/g, '')))
}

function xmlTextRuns(xml: string): string[] {
  return [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/gi)]
    .map((match) => decodeXml(match[1]))
}

function firstXmlTagText(xml: string, localName: string): string {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = xml.match(new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}>`, 'i'))
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, '')) : ''
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = attributes.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  const value = match?.[1] ?? match?.[2]
  return value === undefined ? undefined : decodeXml(value)
}

function xmlLocalAttribute(attributes: string, localName: string): string | undefined {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = attributes.match(new RegExp(`(?:^|\\s)(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  const value = match?.[1] ?? match?.[2]
  return value === undefined ? undefined : decodeXml(value)
}

function normalizeExtractedText(text: string): string {
  return decodeXml(text)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => safeCodePoint(digits, 16))
    .replace(/&#([0-9]+);/g, (_match, digits: string) => safeCodePoint(digits, 10))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function safeCodePoint(digits: string, radix: number): string {
  const value = Number.parseInt(digits, radix)
  try {
    return Number.isFinite(value) ? String.fromCodePoint(value) : ''
  } catch {
    return '\uFFFD'
  }
}
