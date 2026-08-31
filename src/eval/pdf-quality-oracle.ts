import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument, OPS, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

const LETTER_WIDTH = 612
const LETTER_HEIGHT = 792
const RENDER_SCALE = 2

const PAGE_ONE_TEXT = [
  'NORTHSTAR / LAUNCH READINESS',
  'Northstar Launch Readiness',
  'Executive Steering Committee | 30 August 2026',
  'GO WITH CONDITIONS',
  'Target launch',
  '14 Oct 2026',
  'Approved budget',
  '$480,000',
  'Open blockers',
  '3',
  'Release Conditions',
  'SSO retest',
  'Patel',
  '18 Sep 2026',
  'Rollback drill',
  'Chen',
  '22 Sep 2026',
  'Messaging approval',
  'Rivera',
  '25 Sep 2026',
  'Readiness',
  'Ready',
  'At Risk',
  'Blocked',
  'CONFIDENTIAL - 30 AUGUST 2026',
  'Page 1 of 2',
] as const

const PAGE_TWO_TEXT = [
  'Risk Register',
  'SSO regression',
  'Critical',
  'Patel',
  'Pass independent retest',
  'Data migration',
  'High',
  'Chen',
  'Complete rollback drill',
  'Partner messaging',
  'Medium',
  'Rivera',
  'Approve final copy',
  'Next checkpoint: 30 Sep 2026',
  'CONFIDENTIAL - 30 AUGUST 2026',
  'Page 2 of 2',
] as const

const IMAGE_OPERATORS = new Set<number>([
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintSolidColorImageMask,
])

const TEXT_OPERATORS = new Set<number>([
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText,
])

const VECTOR_OPERATORS = new Set<number>([
  OPS.rectangle,
  OPS.constructPath,
  OPS.rawFillPath,
  OPS.stroke,
  OPS.closeStroke,
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
])

export interface PdfPageQualityEvidence {
  pageNumber: number
  widthPoints: number
  heightPoints: number
  letterPortrait: boolean
  text: string
  requiredTextPresent: boolean
  missingText: string[]
  textBoundsPoints?: { left: number; top: number; right: number; bottom: number }
  minimumTextEdgeClearancePoints: number
  textSafeMargins: boolean
  textOperatorCount: number
  vectorOperatorCount: number
  imageOperatorCount: number
  raster: {
    width: number
    height: number
    pngBytes: number
    pngSha256: string
    nonWhitePixels: number
    navyPixels: number
    tealPixels: number
    contentBounds?: { left: number; top: number; right: number; bottom: number }
    minimumEdgeClearancePixels: number
    healthy: boolean
  }
}

export interface PdfQualityEvidence {
  path: string
  bytes: number
  sha256: string
  headerValid: boolean
  eofValid: boolean
  parsed: boolean
  parseError?: string
  pageCount: number
  exactPageCount: boolean
  metadata: {
    title: string
    author: string
    subject: string
    exact: boolean
  }
  pages: PdfPageQualityEvidence[]
  selectableVectorContent: boolean
  containsRasterImages: boolean
  allRequiredTextPresent: boolean
  allPagesRasterized: boolean
  allPassed: boolean
}

/**
 * Independently parse and render the benchmark PDF. This deliberately uses
 * neither the candidate generator nor the Agent's extract_attachment result.
 */
export async function evaluateLaunchReadinessPdf(path: string): Promise<PdfQualityEvidence> {
  const bytes = await readFile(path).catch(() => Buffer.alloc(0))
  const headerValid = bytes.subarray(0, 5).toString('ascii') === '%PDF-'
  const eofValid = bytes.subarray(Math.max(0, bytes.length - 1_024)).toString('latin1').includes('%%EOF')
  const base: PdfQualityEvidence = {
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    headerValid,
    eofValid,
    parsed: false,
    pageCount: 0,
    exactPageCount: false,
    metadata: { title: '', author: '', subject: '', exact: false },
    pages: [],
    selectableVectorContent: false,
    containsRasterImages: false,
    allRequiredTextPresent: false,
    allPagesRasterized: false,
    allPassed: false,
  }
  if (!headerValid || !eofValid || bytes.length < 1_000) return base

  let loadingTask: ReturnType<typeof getDocument> | undefined
  let document: Awaited<ReturnType<typeof getDocument>['promise']> | undefined
  try {
    loadingTask = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
    })
    document = await loadingTask.promise
    base.parsed = true
    base.pageCount = document.numPages
    base.exactPageCount = document.numPages === 2

    const documentMetadata = await document.getMetadata()
    const info = documentMetadata.info as Record<string, unknown>
    base.metadata = {
      title: String(info.Title || ''),
      author: String(info.Author || ''),
      subject: String(info.Subject || ''),
      exact: String(info.Title || '') === 'Northstar Launch Readiness'
        && String(info.Author || '') === 'Anera Agent'
        && String(info.Subject || '') === 'Executive launch decision brief',
    }

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const textContent = await page.getTextContent()
      const text = normalizePdfText(textContent.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' '))
      const required = pageNumber === 1 ? PAGE_ONE_TEXT : pageNumber === 2 ? PAGE_TWO_TEXT : []
      const comparableText = comparablePdfText(text)
      const missingText: string[] = required.filter((expected) => !comparableText.includes(comparablePdfText(expected)))
      if (pageNumber === 1) {
        for (const [label, pattern] of [
          ['Ready 2', /(?:\bready\s+2\b|\b2\s+ready\b)/],
          ['At Risk 1', /(?:\bat risk\s+1\b|\b1\s+at risk\b)/],
          ['Blocked 1', /(?:\bblocked\s+1\b|\b1\s+blocked\b)/],
        ] as const) {
          if (!pattern.test(comparableText)) missingText.push(label)
        }
      }
      const textGeometry = textBounds(textContent.items)
      const operators = await page.getOperatorList()
      const textOperatorCount = operators.fnArray.filter((operator) => TEXT_OPERATORS.has(operator)).length
      const vectorOperatorCount = operators.fnArray.filter((operator) => VECTOR_OPERATORS.has(operator)).length
      const imageOperatorCount = operators.fnArray.filter((operator) => IMAGE_OPERATORS.has(operator)).length
      const raster = await rasterizePage(page, pageNumber)

      base.pages.push({
        pageNumber,
        widthPoints: round(viewport.width),
        heightPoints: round(viewport.height),
        letterPortrait: Math.abs(viewport.width - LETTER_WIDTH) <= 0.5
          && Math.abs(viewport.height - LETTER_HEIGHT) <= 0.5,
        text,
        requiredTextPresent: missingText.length === 0,
        missingText,
        textBoundsPoints: textGeometry.bounds,
        minimumTextEdgeClearancePoints: textGeometry.minimumEdgeClearancePoints,
        textSafeMargins: textGeometry.minimumEdgeClearancePoints >= 35.5,
        textOperatorCount,
        vectorOperatorCount,
        imageOperatorCount,
        raster,
      })
      page.cleanup()
    }
  } catch (error) {
    base.parseError = String(error instanceof Error ? error.message : error)
  } finally {
    await document?.cleanup()
    await loadingTask?.destroy()
  }

  base.containsRasterImages = base.pages.some((page) => page.imageOperatorCount > 0)
  base.selectableVectorContent = base.pages.length === 2
    && base.pages.every((page) => page.textOperatorCount > 0 && page.vectorOperatorCount > 0)
  base.allRequiredTextPresent = base.pages.length === 2
    && base.pages.every((page) => page.requiredTextPresent)
  base.allPagesRasterized = base.pages.length === 2
    && base.pages.every((page) => page.raster.healthy)
    && base.pages.reduce((sum, page) => sum + page.raster.tealPixels, 0) >= 100
  base.allPassed = base.headerValid
    && base.eofValid
    && base.bytes >= 2_000
    && base.parsed
    && base.exactPageCount
    && base.metadata.exact
    && base.pages.every((page) => page.letterPortrait)
    && base.pages.every((page) => page.textSafeMargins)
    && base.selectableVectorContent
    && !base.containsRasterImages
    && base.allRequiredTextPresent
    && base.allPagesRasterized
  return base
}

async function rasterizePage(page: PDFPageProxy, pageNumber: number) {
  const viewport = page.getViewport({ scale: RENDER_SCALE })
  const width = Math.round(viewport.width)
  const height = Math.round(viewport.height)
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
    background: '#FFFFFF',
  }).promise
  const image = context.getImageData(0, 0, width, height).data
  let nonWhitePixels = 0
  let navyPixels = 0
  let tealPixels = 0
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let index = 0; index < image.length; index += 4) {
    const r = image[index]
    const g = image[index + 1]
    const b = image[index + 2]
    if (r < 246 || g < 246 || b < 246) {
      const pixel = index / 4
      const x = pixel % width
      const y = Math.floor(pixel / width)
      nonWhitePixels += 1
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
    if (colorDistance(r, g, b, 11, 31, 51) <= 50) navyPixels += 1
    if (colorDistance(r, g, b, 0, 166, 166) <= 50) tealPixels += 1
  }
  const png = canvas.toBuffer('image/png')
  const hasBounds = right >= left && bottom >= top
  const contentBounds = hasBounds ? { left, top, right, bottom } : undefined
  const minimumEdgeClearancePixels = hasBounds
    ? Math.min(left, top, width - 1 - right, height - 1 - bottom)
    : 0
  return {
    pageNumber,
    width,
    height,
    pngBytes: png.length,
    pngSha256: createHash('sha256').update(png).digest('hex'),
    nonWhitePixels,
    navyPixels,
    tealPixels,
    contentBounds,
    minimumEdgeClearancePixels,
    healthy: width === LETTER_WIDTH * RENDER_SCALE
      && height === LETTER_HEIGHT * RENDER_SCALE
      && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && png.length >= 10_000
      && nonWhitePixels >= 2_000
      && navyPixels >= 250,
  }
}

function normalizePdfText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function comparablePdfText(text: string): string {
  return normalizePdfText(text).toLocaleLowerCase('en-US')
}

function textBounds(items: Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items']): {
  bounds?: { left: number; top: number; right: number; bottom: number }
  minimumEdgeClearancePoints: number
} {
  let left = LETTER_WIDTH
  let top = 0
  let right = 0
  let bottom = LETTER_HEIGHT
  let found = false
  for (const item of items) {
    if (!('str' in item) || !item.str.trim()) continue
    const x = item.transform[4]
    const baseline = item.transform[5]
    const width = Math.abs(item.width)
    const height = Math.max(Math.abs(item.height), Math.hypot(item.transform[2], item.transform[3]))
    left = Math.min(left, x)
    right = Math.max(right, x + width)
    bottom = Math.min(bottom, baseline - (height * 0.25))
    top = Math.max(top, baseline + height)
    found = true
  }
  if (!found) return { minimumEdgeClearancePoints: 0 }
  const bounds = {
    left: round(left),
    top: round(top),
    right: round(right),
    bottom: round(bottom),
  }
  return {
    bounds,
    minimumEdgeClearancePoints: round(Math.min(
      bounds.left,
      bounds.bottom,
      LETTER_WIDTH - bounds.right,
      LETTER_HEIGHT - bounds.top,
    )),
  }
}

function colorDistance(r: number, g: number, b: number, expectedR: number, expectedG: number, expectedB: number): number {
  return Math.hypot(r - expectedR, g - expectedG, b - expectedB)
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000
}
