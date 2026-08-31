import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evaluateLaunchReadinessPdf } from './pdf-quality-oracle.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('launch-readiness PDF quality oracle', () => {
  it('accepts a two-page selectable vector PDF after parsing and rasterization', async () => {
    const path = await writeFixture(buildLaunchReadinessPdf())
    const evidence = await evaluateLaunchReadinessPdf(path)

    expect(evidence.allPassed).toBe(true)
    expect(evidence).toMatchObject({
      headerValid: true,
      eofValid: true,
      parsed: true,
      pageCount: 2,
      exactPageCount: true,
      metadata: { exact: true },
      selectableVectorContent: true,
      containsRasterImages: false,
      allRequiredTextPresent: true,
      allPagesRasterized: true,
    })
    expect(evidence.pages).toHaveLength(2)
    expect(evidence.pages.every((page) => page.letterPortrait)).toBe(true)
    expect(evidence.pages.every((page) => page.raster.width === 1_224 && page.raster.height === 1_584)).toBe(true)
    expect(evidence.pages.every((page) => page.raster.minimumEdgeClearancePixels >= 60)).toBe(true)
  })

  it('rejects a superficially named file that is not a PDF', async () => {
    const path = await writeFixture(Buffer.from('<html><body>not a PDF</body></html>'))
    const evidence = await evaluateLaunchReadinessPdf(path)

    expect(evidence.allPassed).toBe(false)
    expect(evidence.headerValid).toBe(false)
    expect(evidence.parsed).toBe(false)
  })

  it('rejects valid visual content when required document metadata is wrong', async () => {
    const path = await writeFixture(buildLaunchReadinessPdf({ exactMetadata: false }))
    const evidence = await evaluateLaunchReadinessPdf(path)

    expect(evidence.parsed).toBe(true)
    expect(evidence.pages.every((page) => page.raster.healthy)).toBe(true)
    expect(evidence.metadata.exact).toBe(false)
    expect(evidence.allPassed).toBe(false)
  })

  it('accepts chart value-label pairs in natural value-above-category extraction order', async () => {
    const path = await writeFixture(buildLaunchReadinessPdf({ chartValueFirst: true, secondPageWithoutTeal: true }))
    const evidence = await evaluateLaunchReadinessPdf(path)

    expect(evidence.pages[0].text).toContain('2 Ready')
    expect(evidence.pages[1].raster.tealPixels).toBe(0)
    expect(evidence.allRequiredTextPresent).toBe(true)
    expect(evidence.allPagesRasterized).toBe(true)
    expect(evidence.allPassed).toBe(true)
  })

  it('rejects a one-page document even when its first page is complete', async () => {
    const path = await writeFixture(buildLaunchReadinessPdf({ includeSecondPage: false }))
    const evidence = await evaluateLaunchReadinessPdf(path)

    expect(evidence.parsed).toBe(true)
    expect(evidence.pageCount).toBe(1)
    expect(evidence.exactPageCount).toBe(false)
    expect(evidence.allPassed).toBe(false)
  })
})

async function writeFixture(content: Buffer): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'anera-pdf-oracle-test-'))
  temporaryDirectories.push(directory)
  const path = resolve(directory, 'launch-readiness.pdf')
  await writeFile(path, content)
  return path
}

function buildLaunchReadinessPdf(options: {
  exactMetadata?: boolean
  includeSecondPage?: boolean
  chartValueFirst?: boolean
  secondPageWithoutTeal?: boolean
} = {}): Buffer {
  const exactMetadata = options.exactMetadata ?? true
  const includeSecondPage = options.includeSecondPage ?? true
  const pageOne = pageContent([
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
    ...(options.chartValueFirst ? ['2 Ready', '1 At Risk', '1 Blocked'] : ['Ready 2', 'At Risk 1', 'Blocked 1']),
    'CONFIDENTIAL - 30 AUGUST 2026',
    'Page 1 of 2',
  ])
  const pageTwo = pageContent([
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
  ], !options.secondPageWithoutTeal)
  const pageObjects = includeSecondPage ? '[3 0 R 5 0 R]' : '[3 0 R]'
  const objects = new Map<number, string>([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Kids ${pageObjects} /Count ${includeSecondPage ? 2 : 1} >>`],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>'],
    [4, streamObject(pageOne)],
    [5, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>'],
    [6, streamObject(pageTwo)],
    [7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [8, `<< /Title (${escapePdf(exactMetadata ? 'Northstar Launch Readiness' : 'Wrong Title')}) /Author (Anera Agent) /Subject (Executive launch decision brief) >>`],
  ])
  return serializePdf(objects)
}

function pageContent(lines: string[], includeTeal = true): string {
  const commands = [
    'q 0.043 0.122 0.200 rg 36 720 540 36 re f Q',
    ...(includeTeal ? ['q 0.000 0.651 0.651 rg 36 696 180 7 re f 396 696 180 7 re f Q'] : []),
  ]
  lines.forEach((line, index) => {
    const y = index === lines.length - 2 ? 50 : index === lines.length - 1 ? 50 : 680 - (index * 23)
    const x = index === lines.length - 1 ? 480 : 36
    const fontSize = index === 1 ? 18 : 10
    commands.push(`BT /F1 ${fontSize} Tf 0.043 0.122 0.200 rg ${x} ${y} Td (${escapePdf(line)}) Tj ET`)
  })
  return commands.join('\n')
}

function streamObject(content: string): string {
  return `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
}

function serializePdf(objects: Map<number, string>): Buffer {
  let output = '%PDF-1.7\n%ANERA\n'
  const offsets = new Map<number, number>()
  const maximumObject = Math.max(...objects.keys())
  for (let objectNumber = 1; objectNumber <= maximumObject; objectNumber += 1) {
    const object = objects.get(objectNumber)
    if (!object) continue
    offsets.set(objectNumber, Buffer.byteLength(output))
    output += `${objectNumber} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output)
  output += `xref\n0 ${maximumObject + 1}\n`
  output += '0000000000 65535 f \n'
  for (let objectNumber = 1; objectNumber <= maximumObject; objectNumber += 1) {
    const offset = offsets.get(objectNumber) || 0
    output += `${String(offset).padStart(10, '0')} ${offset ? '00000 n ' : '65535 f '}\n`
  }
  output += `trailer\n<< /Size ${maximumObject + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(output, 'ascii')
}

function escapePdf(value: string): string {
  return value.replace(/([\\()])/g, '\\$1')
}
