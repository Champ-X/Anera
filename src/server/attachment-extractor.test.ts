import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import archiver from 'archiver'
import { afterEach, describe, expect, it } from 'vitest'
import { extractAttachment, extractAttachmentPage } from './attachment-extractor.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Office attachment extraction', () => {
  it('reports text truncation instead of silently presenting a prefix as complete', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-text-attachment-'))
    roots.push(root)
    const path = resolve(root, 'long.txt')
    await writeFile(path, 'alpha\nbeta\ngamma\n')
    const page = await extractAttachmentPage(path, 8)
    expect(page).toEqual({
      content: 'alpha\nbe',
      format: 'text',
      unit: 'text',
      truncated: true,
      outputBytes: 8,
    })
  })

  it('preserves DOCX paragraphs, table cells, headers, and XML entities', async () => {
    const path = await officeFixture('sample.docx', {
      'word/document.xml': `
        <w:document xmlns:w="urn:w"><w:body>
          <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Quarterly &amp; Review</w:t></w:r></w:p>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Regional detail</w:t></w:r></w:p>
          <w:tbl>
            <w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr>
          </w:tbl>
          <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Approve</w:t></w:r></w:p>
          <w:p><w:r><w:br w:type="page"/><w:t>Next page</w:t></w:r></w:p>
        </w:body></w:document>`,
      'word/header1.xml': '<w:hdr xmlns:w="urn:w"><w:p><w:r><w:t>Internal Header</w:t></w:r></w:p></w:hdr>',
      'word/footnotes.xml': '<w:footnotes xmlns:w="urn:w"><w:footnote><w:p><w:r><w:t>Source note</w:t></w:r></w:p></w:footnote></w:footnotes>',
    })

    const text = await extractAttachment(path, 20_000)
    expect(text).toContain('--- DOCX main document ---')
    expect(text).toContain('Document structure: paragraphs=4 | Title=1 | Heading 1=1 | numbered=1 | explicit page breaks=1 | page-break-before=0 | tables=1')
    expect(text).toContain('DOCX paragraph 1 [style=Title]: Quarterly & Review')
    expect(text).toContain('DOCX paragraph 2 [style=Heading1]: Regional detail')
    expect(text).toContain('DOCX table 1: 2 rows x 2 columns')
    expect(text).toContain('DOCX table 1 row 1: Region | Revenue')
    expect(text).toContain('DOCX table 1 row 2: North | 120')
    expect(text).toContain('DOCX paragraph 3 [numbered]: Approve')
    expect(text).toContain('DOCX paragraph 4 [explicit-page-breaks=1]: Next page')
    expect(text).toContain('Quarterly & Review')
    expect(text).toContain('North')
    expect(text).toContain('120')
    expect(text).toContain('--- DOCX header1 ---')
    expect(text).toContain('Internal Header')
    expect(text).toContain('Source note')

    const mainOnly = await extractAttachmentPage(path, 20_000, { itemStart: 1, itemEnd: 1 })
    const firstPage = await extractAttachmentPage(path, mainOnly.outputBytes + 5, { itemStart: 1 })
    expect(firstPage).toMatchObject({
      format: 'docx', unit: 'item', totalItems: 3, startItem: 1, endItem: 1, nextItem: 2, truncated: true,
    })
    expect(firstPage.content).toContain('DOCX main document')
    expect(firstPage.content).not.toContain('Internal Header')
    const secondPage = await extractAttachmentPage(path, 20_000, { itemStart: 2 })
    expect(secondPage).toMatchObject({ startItem: 2, endItem: 3, truncated: false })
    expect(secondPage.content).toContain('Internal Header')
    expect(secondPage.content).toContain('Source note')
  })

  it('continues a single oversized DOCX item with an exact UTF-8 byte cursor', async () => {
    const payload = `开场🙂${'段落-data-🙂'.repeat(80)}结尾`
    const path = await officeFixture('oversized.docx', {
      'word/document.xml': `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${payload}</w:t></w:r></w:p></w:body></w:document>`,
    })

    const unbounded = await extractAttachmentPage(path, 20_000, { itemStart: 1, itemEnd: 1 })
    const expectedBody = unbounded.content.slice(unbounded.content.indexOf('\n') + 1)
    let contentOffset = 0
    let reconstructed = ''
    let chunks = 0
    do {
      const page = await extractAttachmentPage(path, 90, { itemStart: 1, itemEnd: 1, contentOffset })
      reconstructed += page.content.slice(page.content.indexOf('\n') + 1)
      chunks += 1
      expect(page.outputBytes).toBeLessThanOrEqual(90)
      if (page.nextContentOffset === undefined) {
        expect(page).toMatchObject({ truncated: false, startItem: 1, endItem: 1 })
        break
      }
      expect(page).toMatchObject({
        truncated: true,
        partialItem: 1,
        contentStartOffset: contentOffset,
        contentEndOffset: page.nextContentOffset,
      })
      expect(page.nextContentOffset).toBeGreaterThan(contentOffset)
      contentOffset = page.nextContentOffset
    } while (chunks < 100)

    expect(reconstructed).toBe(expectedBody)
    expect(chunks).toBeGreaterThan(1)
    const insideMultibyteCharacter = Buffer.from(expectedBody).indexOf(Buffer.from('开')) + 1
    await expect(extractAttachmentPage(path, 90, { itemStart: 1, contentOffset: insideMultibyteCharacter })).rejects.toThrow(/UTF-8 character boundary/)
  })

  it('distinguishes a real Word PAGE field from typed placeholder text', async () => {
    const dynamicPath = await officeFixture('dynamic-page.docx', {
      'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Memo</w:t></w:r></w:p></w:body></w:document>',
      'word/footer1.xml': '<w:ftr xmlns:w="urn:w"><w:p><w:r><w:t>Prepared · Page </w:t></w:r><w:r><w:instrText> PAGE </w:instrText></w:r></w:p></w:ftr>',
    })
    const dynamicText = await extractAttachment(dynamicPath, 20_000)
    expect(dynamicText).toContain('Word fields: PAGE')
    expect(dynamicText).not.toContain('Footer contains typed text "PAGE"')

    const typedPath = await officeFixture('typed-page.docx', {
      'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Memo</w:t></w:r></w:p></w:body></w:document>',
      'word/footer1.xml': '<w:ftr xmlns:w="urn:w"><w:p><w:r><w:t>Prepared · Page PAGE</w:t></w:r></w:p></w:ftr>',
    })
    const typedText = await extractAttachment(typedPath, 20_000)
    expect(typedText).toContain('OFFICE VERIFICATION FAILED: Footer contains typed text "PAGE" but no dynamic PAGE field instruction')
  })

  it('resolves XLSX sheet names, shared strings, inline strings, booleans, and formulas', async () => {
    const path = await officeFixture('sample.xlsx', {
      'xl/workbook.xml': `
        <workbook xmlns:r="urn:r"><sheets>
          <sheet name="Data &amp; Inputs" sheetId="1" r:id="rIdData"/>
          <sheet name="Summary" sheetId="2" state="hidden" r:id="rIdSummary"/>
        </sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `
        <Relationships>
          <Relationship Id="rIdSummary" Target="worksheets/sheet10.xml"/>
          <Relationship Id="rIdData" Target="worksheets/sheet2.xml"/>
        </Relationships>`,
      'xl/sharedStrings.xml': `
        <sst><si><t>Quarter</t></si><si><r><t>Q</t></r><r><t>1</t></r></si></sst>`,
      'xl/worksheets/sheet2.xml': `
        <worksheet><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row>
          <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>120</v></c><c r="C2" t="b"><v>1</v></c></row>
        </sheetData><mergeCells><mergeCell ref="A3:C3"/></mergeCells></worksheet>`,
      'xl/worksheets/sheet10.xml': `
        <worksheet><sheetData><row r="1">
          <c r="A1" t="inlineStr"><is><t>Total</t></is></c>
          <c r="B1"><f>SUM('Data &amp; Inputs'!B2:B2)</f><v>120</v></c>
        </row></sheetData></worksheet>`,
    })

    const text = await extractAttachment(path, 20_000)
    expect(text).toContain('--- XLSX sheet 1: Data & Inputs ---')
    expect(text).toContain('A1="Quarter"')
    expect(text).toContain('A2="Q1"')
    expect(text).toContain('B2="120"')
    expect(text).toContain('C2="TRUE"')
    expect(text).toContain('Merged cells: A3:C3')
    expect(text).toContain('--- XLSX sheet 2: Summary [hidden] ---')
    expect(text).toContain('B1="120" [formula: SUM(\'Data & Inputs\'!B2:B2)]')
    expect(text.indexOf('Data & Inputs')).toBeLessThan(text.indexOf('Summary [hidden]'))

    const summaryOnly = await extractAttachmentPage(path, 20_000, { itemStart: 2, itemEnd: 2 })
    expect(summaryOnly).toMatchObject({
      format: 'xlsx', unit: 'sheet', totalItems: 2, startItem: 2, endItem: 2, truncated: false,
    })
    expect(summaryOnly.content).not.toContain('XLSX sheet 1: Data & Inputs')
    expect(summaryOnly.content).toContain('Summary [hidden]')
  })

  it('rejects ExcelJS formulas that incorrectly include their destination cell', async () => {
    const path = await officeFixture('self-referencing-formula.xlsx', {
      'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="2">
        <c r="C2"><v>10</v></c><c r="D2"><v>4</v></c><c r="E2"><f>E2=C2-D2</f><v>6</v></c>
      </row></sheetData></worksheet>`,
    })

    const text = await extractAttachment(path, 20_000)
    expect(text).toContain('E2="6" [formula: E2=C2-D2]')
    expect(text).toContain('OFFICE VERIFICATION FAILED: Formula in E2 begins with its own destination reference')
    expect(text).toContain('without a leading "=" or "E2=" prefix')
  })

  it('uses presentation relationship order and includes speaker notes', async () => {
    const path = await officeFixture('sample.pptx', {
      'ppt/presentation.xml': `
        <p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst>
          <p:sldId id="256" r:id="rIdFirst"/><p:sldId id="257" r:id="rIdSecond"/>
        </p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `
        <Relationships>
          <Relationship Id="rIdSecond" Target="slides/slide2.xml"/>
          <Relationship Id="rIdFirst" Target="slides/slide10.xml"/>
        </Relationships>`,
      'ppt/slides/slide10.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Opening &amp; context</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Closing slide</a:t></a:r></a:p></p:sld>',
      'ppt/slides/_rels/slide10.xml.rels': '<Relationships><Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide7.xml"/><Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart3.xml"/><Relationship Id="rIdBrokenChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart4.xml"/></Relationships>',
      'ppt/notesSlides/notesSlide7.xml': '<p:notes xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Ask about budget.</a:t></a:r></a:p></p:notes>',
      'ppt/charts/chart3.xml': `<c:chartSpace xmlns:c="urn:c"><c:chart><c:plotArea><c:doughnutChart><c:ser>
        <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Readiness</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Ready</c:v></c:pt><c:pt idx="1"><c:v>At Risk</c:v></c:pt><c:pt idx="2"><c:v>Blocked</c:v></c:pt></c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>2</c:v></c:pt><c:pt idx="1"><c:v>1</c:v></c:pt><c:pt idx="2"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val>
      </c:ser></c:doughnutChart></c:plotArea></c:chart></c:chartSpace>`,
      'ppt/charts/chart4.xml': `<c:chartSpace xmlns:c="urn:c"><c:chart><c:plotArea><c:doughnutChart><c:ser>
        <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Broken readiness</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Ready</c:v></c:pt></c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val>
      </c:ser></c:doughnutChart></c:plotArea></c:chart></c:chartSpace>`,
    })

    const text = await extractAttachment(path, 20_000)
    expect(text).toContain('--- PPTX slide 1 ---\nOpening & context')
    expect(text).toContain('Speaker notes:\nAsk about budget.')
    expect(text).toContain('Chart data:\nSeries Readiness: Ready=2 | At Risk=1 | Blocked=1')
    expect(text).toContain('OFFICE VERIFICATION FAILED: doughnutChart contains only one cached category')
    expect(text).toContain('--- PPTX slide 2 ---\nClosing slide')
    expect(text.indexOf('Opening & context')).toBeLessThan(text.indexOf('Closing slide'))

    const closingOnly = await extractAttachmentPage(path, 20_000, { itemStart: 2 })
    expect(closingOnly).toMatchObject({
      format: 'pptx', unit: 'slide', totalItems: 2, startItem: 2, endItem: 2, truncated: false,
    })
    expect(closingOnly.content).not.toContain('Opening & context')
    expect(closingOnly.content).toContain('Closing slide')
  })
})

describe('PDF attachment extraction', () => {
  it('paginates at whole-page boundaries and continues an oversized page without loss', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-pdf-attachment-'))
    roots.push(root)
    const boundaryPath = resolve(root, 'two-pages.pdf')
    await writeFile(boundaryPath, minimalPdf(['PAGE ONE SAFE METHODS', 'PAGE TWO IDEMPOTENT METHODS']))

    const first = await extractAttachmentPage(boundaryPath, 60)
    expect(first).toMatchObject({
      format: 'pdf', unit: 'page', totalItems: 2, startItem: 1, endItem: 1, nextItem: 2, truncated: true,
    })
    expect(first.content).toContain('PAGE ONE SAFE METHODS')
    expect(first.content).not.toContain('PAGE TWO IDEMPOTENT METHODS')
    const second = await extractAttachmentPage(boundaryPath, 60, { pageStart: 2 })
    expect(second).toMatchObject({ startItem: 2, endItem: 2, truncated: false })
    expect(second.content).toContain('PAGE TWO IDEMPOTENT METHODS')

    const oversizedPath = resolve(root, 'oversized-page.pdf')
    const payload = `START-${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(40)}-END`
    await writeFile(oversizedPath, minimalPdf([payload]))
    const unbounded = await extractAttachmentPage(oversizedPath, 10_000, { pageStart: 1, pageEnd: 1 })
    const expectedBody = unbounded.content.slice(unbounded.content.indexOf('\n') + 1)
    expect(expectedBody.replace(/\s/g, '')).toBe(payload)
    let contentOffset = 0
    let reconstructed = ''
    let chunks = 0
    do {
      const page = await extractAttachmentPage(oversizedPath, 100, { pageStart: 1, pageEnd: 1, contentOffset })
      reconstructed += page.content.slice(page.content.indexOf('\n') + 1)
      chunks += 1
      expect(page.outputBytes).toBeLessThanOrEqual(100)
      if (page.nextContentOffset === undefined) break
      expect(page).toMatchObject({ partialItem: 1, contentStartOffset: contentOffset })
      expect(page.nextContentOffset).toBeGreaterThan(contentOffset)
      contentOffset = page.nextContentOffset
    } while (chunks < 100)

    expect(reconstructed).toBe(expectedBody)
    expect(chunks).toBeGreaterThan(1)
  })
})

async function officeFixture(name: string, entries: Record<string, string>): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-office-'))
  roots.push(root)
  const path = resolve(root, name)
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(path)
    const archive = archiver('zip', { zlib: { level: 1 } })
    output.on('close', resolvePromise)
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    for (const [entry, content] of Object.entries(entries)) archive.append(content, { name: entry })
    void archive.finalize()
  })
  return path
}

function minimalPdf(pageTexts: string[]): Buffer {
  const objects: string[] = []
  const pageObjectIds = pageTexts.map((_text, index) => 4 + index * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pageTexts.forEach((text, index) => {
    const pageId = pageObjectIds[index]
    const contentId = pageId + 1
    const textRuns = text.match(/[\s\S]{1,50}/g) || ['']
    const operators = textRuns.map((run, runIndex) => {
      const escaped = run.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
      return `${runIndex > 0 ? 'T* ' : ''}(${escaped}) Tj`
    }).join(' ')
    const stream = `BT /F1 12 Tf 14 TL 72 720 Td ${operators} ET`
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id += 1) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
