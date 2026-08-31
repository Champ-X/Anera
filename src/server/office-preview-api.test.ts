import { createWriteStream } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import archiver from 'archiver'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'

describe('Workspace Office Artifact preview API', () => {
  it('returns bounded DOCX/XLSX/PPTX preview data without weakening the Workspace path boundary', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-office-preview-api-'))
    const created = await createApp({ dataRoot: resolve(root, 'data'), model: 'test-model' })
    const session = await created.store.create()
    const workspace = created.store.workspaceDir(session.summary.id)
    await writeOfficeArchive(resolve(workspace, 'brief.docx'), {
      'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Office preview marker</w:t></w:r></w:p></w:body></w:document>',
    })
    await writeOfficeArchive(resolve(workspace, 'metrics.xlsx'), {
      'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheets><sheet name="Readiness" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Score</t></is></c><c r="B1"><v>98</v></c></row></sheetData></worksheet>',
    })
    await writeOfficeArchive(resolve(workspace, 'review.pptx'), {
      'ppt/presentation.xml': '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
      'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Launch review</a:t></a:r></a:p></p:sld>',
    })
    const outside = resolve(root, 'outside.docx')
    await writeFile(outside, 'HOST SECRET')
    await symlink(outside, resolve(workspace, 'linked.docx'))
    await writeFile(resolve(workspace, 'plain.txt'), 'not an Office file')
    const server = createServer(created.app)
    try {
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not bind')
      const base = `http://127.0.0.1:${address.port}`
      const cases = [
        { path: 'brief.docx', format: 'docx', unit: 'item', marker: 'Office preview marker' },
        { path: 'metrics.xlsx', format: 'xlsx', unit: 'sheet', marker: 'B1="98"' },
        { path: 'review.pptx', format: 'pptx', unit: 'slide', marker: 'Launch review' },
      ] as const
      for (const expected of cases) {
        const response = await fetch(`${base}/api/sessions/${session.summary.id}/artifact-preview?path=${encodeURIComponent(expected.path)}`)
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-cache')
        expect(await response.json()).toMatchObject({
          path: expected.path,
          name: expected.path,
          format: expected.format,
          unit: expected.unit,
          truncated: false,
          content: expect.stringContaining(expected.marker),
        })
      }
      const unsupported = await fetch(`${base}/api/sessions/${session.summary.id}/artifact-preview?path=plain.txt`)
      expect(unsupported.status).toBe(400)
      expect(await unsupported.json()).toEqual({ error: 'Rich document preview supports DOCX, XLSX, and PPTX' })
      const linked = await fetch(`${base}/api/sessions/${session.summary.id}/artifact-preview?path=linked.docx`)
      expect(linked.status).toBe(400)
      expect(await linked.text()).not.toContain('HOST SECRET')
    } finally {
      await created.agent.shutdown()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeOfficeArchive(path: string, entries: Record<string, string>): Promise<void> {
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
}
