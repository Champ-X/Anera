import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { findBrowserExecutable } from '../server/browser-executable.js'

export interface VisualDiffOptions {
  pixelThreshold?: number
  maxChangedRatio?: number
  maxMeanAbsoluteError?: number
  diffPath?: string
  browserExecutablePath?: string
}

export interface VisualDiffReport {
  schemaVersion: 'anera-visual-diff/1.0'
  reference: { path: string; width: number; height: number }
  candidate: { path: string; width: number; height: number }
  compared: { width: number; height: number; pixels: number }
  thresholds: { pixel: number; maxChangedRatio: number; maxMeanAbsoluteError: number }
  dimensionEqual: boolean
  changedPixels: number
  changedRatio: number
  meanAbsoluteError: number
  rootMeanSquareError: number
  pixelSimilarity: number
  dimensionPenalty: number
  diffPath?: string
  passed: boolean
}

export async function comparePngFiles(referencePath: string, candidatePath: string, options: VisualDiffOptions = {}): Promise<VisualDiffReport> {
  const pixelThreshold = bounded(options.pixelThreshold ?? 0.10, 0, 1, 'pixelThreshold')
  const maxChangedRatio = bounded(options.maxChangedRatio ?? 0.01, 0, 1, 'maxChangedRatio')
  const maxMeanAbsoluteError = bounded(options.maxMeanAbsoluteError ?? 0.02, 0, 1, 'maxMeanAbsoluteError')
  const [referenceBuffer, candidateBuffer] = await Promise.all([readFile(referencePath), readFile(candidatePath)])
  const browser = await chromium.launch({
    executablePath: findBrowserExecutable(options.browserExecutablePath || process.env.ANERA_BROWSER_EXECUTABLE),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
    const result = await page.evaluate(async ({ referenceBase64, candidateBase64, threshold }) => {
      const referenceImage = await new Promise<HTMLImageElement>((resolveImage, rejectImage) => {
        const image = new Image()
        image.onload = () => resolveImage(image)
        image.onerror = () => rejectImage(new Error('Reference PNG could not be decoded'))
        image.src = `data:image/png;base64,${referenceBase64}`
      })
      const candidateImage = await new Promise<HTMLImageElement>((resolveImage, rejectImage) => {
        const image = new Image()
        image.onload = () => resolveImage(image)
        image.onerror = () => rejectImage(new Error('Candidate PNG could not be decoded'))
        image.src = `data:image/png;base64,${candidateBase64}`
      })
      const width = Math.max(referenceImage.naturalWidth, candidateImage.naturalWidth)
      const height = Math.max(referenceImage.naturalHeight, candidateImage.naturalHeight)
      const referenceCanvas = document.createElement('canvas')
      const candidateCanvas = document.createElement('canvas')
      const diffCanvas = document.createElement('canvas')
      referenceCanvas.width = candidateCanvas.width = diffCanvas.width = width
      referenceCanvas.height = candidateCanvas.height = diffCanvas.height = height
      const referenceContext = referenceCanvas.getContext('2d', { willReadFrequently: true })!
      const candidateContext = candidateCanvas.getContext('2d', { willReadFrequently: true })!
      const diffContext = diffCanvas.getContext('2d')!
      referenceContext.fillStyle = candidateContext.fillStyle = '#ffffff'
      referenceContext.fillRect(0, 0, width, height)
      candidateContext.fillRect(0, 0, width, height)
      referenceContext.drawImage(referenceImage, 0, 0)
      candidateContext.drawImage(candidateImage, 0, 0)
      const referencePixels = referenceContext.getImageData(0, 0, width, height).data
      const candidatePixels = candidateContext.getImageData(0, 0, width, height).data
      const diff = diffContext.createImageData(width, height)
      let changedPixels = 0
      let outsidePixels = 0
      let absoluteError = 0
      let squaredError = 0
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const pixel = y * width + x
          const offset = pixel * 4
          const insideReference = x < referenceImage.naturalWidth && y < referenceImage.naturalHeight
          const insideCandidate = x < candidateImage.naturalWidth && y < candidateImage.naturalHeight
          let error = 0
          if (!insideReference || !insideCandidate) {
            error = 1
            outsidePixels += 1
          } else {
            for (let channel = 0; channel < 4; channel += 1) {
              const delta = Math.abs(referencePixels[offset + channel] - candidatePixels[offset + channel]) / 255
              error += delta / 4
              squaredError += (delta * delta) / 4
            }
          }
          absoluteError += error
          const changed = error > threshold
          if (changed) changedPixels += 1
          if (changed) {
            diff.data[offset] = 220
            diff.data[offset + 1] = Math.round(40 + (1 - error) * 90)
            diff.data[offset + 2] = 48
          } else {
            const luminance = Math.round(candidatePixels[offset] * 0.2126 + candidatePixels[offset + 1] * 0.7152 + candidatePixels[offset + 2] * 0.0722)
            const muted = Math.round(235 + luminance * 0.08)
            diff.data[offset] = muted
            diff.data[offset + 1] = muted
            diff.data[offset + 2] = muted
          }
          diff.data[offset + 3] = 255
        }
      }
      diffContext.putImageData(diff, 0, 0)
      const pixels = width * height
      return {
        referenceWidth: referenceImage.naturalWidth,
        referenceHeight: referenceImage.naturalHeight,
        candidateWidth: candidateImage.naturalWidth,
        candidateHeight: candidateImage.naturalHeight,
        width,
        height,
        pixels,
        changedPixels,
        outsidePixels,
        meanAbsoluteError: pixels > 0 ? absoluteError / pixels : 0,
        rootMeanSquareError: pixels > 0 ? Math.sqrt((squaredError + outsidePixels) / pixels) : 0,
        diffBase64: diffCanvas.toDataURL('image/png').split(',')[1],
      }
    }, {
      referenceBase64: referenceBuffer.toString('base64'),
      candidateBase64: candidateBuffer.toString('base64'),
      threshold: pixelThreshold,
    })
    if (options.diffPath) await writeFile(options.diffPath, Buffer.from(result.diffBase64, 'base64'))
    const dimensionEqual = result.referenceWidth === result.candidateWidth && result.referenceHeight === result.candidateHeight
    const changedRatio = result.pixels > 0 ? result.changedPixels / result.pixels : 0
    const dimensionPenalty = result.pixels > 0 ? result.outsidePixels / result.pixels : 0
    return {
      schemaVersion: 'anera-visual-diff/1.0',
      reference: { path: referencePath, width: result.referenceWidth, height: result.referenceHeight },
      candidate: { path: candidatePath, width: result.candidateWidth, height: result.candidateHeight },
      compared: { width: result.width, height: result.height, pixels: result.pixels },
      thresholds: { pixel: pixelThreshold, maxChangedRatio, maxMeanAbsoluteError },
      dimensionEqual,
      changedPixels: result.changedPixels,
      changedRatio,
      meanAbsoluteError: result.meanAbsoluteError,
      rootMeanSquareError: result.rootMeanSquareError,
      pixelSimilarity: Math.max(0, 1 - result.meanAbsoluteError),
      dimensionPenalty,
      diffPath: options.diffPath,
      passed: dimensionEqual && changedRatio <= maxChangedRatio && result.meanAbsoluteError <= maxMeanAbsoluteError,
    }
  } finally {
    await browser.close()
  }
}

export function renderVisualDiffMarkdown(report: VisualDiffReport): string {
  return [
    '# Visual pixel diff',
    '',
    `Decision: **${report.passed ? 'PASS' : 'FAIL'}**`,
    '',
    '| Metric | Value | Gate |',
    '|---|---:|---:|',
    `| Reference | ${report.reference.width} × ${report.reference.height} | — |`,
    `| Candidate | ${report.candidate.width} × ${report.candidate.height} | exact dimensions |`,
    `| Changed pixels | ${report.changedPixels.toLocaleString()} (${percent(report.changedRatio)}) | ≤ ${percent(report.thresholds.maxChangedRatio)} |`,
    `| Mean absolute error | ${report.meanAbsoluteError.toFixed(6)} | ≤ ${report.thresholds.maxMeanAbsoluteError.toFixed(6)} |`,
    `| RMS error | ${report.rootMeanSquareError.toFixed(6)} | diagnostic |`,
    `| Pixel similarity | ${percent(report.pixelSimilarity)} | diagnostic |`,
    `| Dimension penalty | ${percent(report.dimensionPenalty)} | 0% |`,
    '',
    `Per-pixel change threshold: ${report.thresholds.pixel.toFixed(4)}.`,
    ...(report.diffPath ? ['', `Diff image: \`${report.diffPath}\``] : []),
    '',
  ].join('\n')
}

function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  return value
}

function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`
}
