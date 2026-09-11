import { describe, expect, it } from 'vitest'
import { documentAuthoringPolicy, requestedDocumentFormats } from './document-authoring-policy.js'

describe('format adapters, not task exemplars', () => {
  it.each([
    ['Install vite@5.4.19 and build the app.', []],
    ['Make HTML Slides.', []],
    ['Prepare brief.pdf and budget.xlsx.', ['pdf', 'xlsx']],
    ['生成 Word文档与电子表格。', ['docx', 'xlsx']],
    ['Create a PowerPoint presentation and a Word document.', ['docx', 'pptx']],
  ])('selects only explicit formats for %s', (task, formats) => {
    expect(requestedDocumentFormats(task as string)).toEqual(formats)
  })
  it('deduplicates guidance and does not attach document rules to unrelated tasks', () => {
    expect(documentAuthoringPolicy([])).toEqual([])
    expect(documentAuthoringPolicy(['xlsx', 'xlsx'])).toHaveLength(2)
    expect(documentAuthoringPolicy(['xlsx']).join('\n')).not.toContain('DOCX API guidance')
  })
  it('retains API and verification constraints without hardcoded benchmark data or arbitrary retries', () => {
    const policy = documentAuthoringPolicy(['pdf', 'docx', 'xlsx', 'pptx']).join('\n')
    for (const required of ['OFFICE VERIFICATION FAILED', 'Consume its continuations', 'PDFPage has no public page.doc.getFont API',
      'HeadingLevel.TITLE', 'PageNumber.CURRENT', 'cell.result', 'array of row arrays', 'new revision']) expect(policy).toContain(required)
    for (const removed of ['516', '540', '660', 'C2-D2', '9000', 'Executive Summary', 'requiredStrings', 'at most three generator']) expect(policy).not.toContain(removed)
    expect(policy.length).toBeLessThan(4_500)
  })
})
