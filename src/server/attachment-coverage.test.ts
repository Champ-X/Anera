import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../shared/types.js'
import { ATTACHMENT_VERIFIER, attachmentCoverageAssessment, attachmentExtractionCoverage } from './file-evidence.js'

const sha = 'a'.repeat(64)
function parsed(from: readonly [number, number], to: readonly [number, number], text: string, revision = sha): SessionEvent {
  return { id: 'event', seq: 1, type: 'tool.completed', sessionId: 'session', at: '', data: {
    call: { name: 'extract_attachment', arguments: { path: 'report.pdf' } }, result: text,
    fileEvidence: { version: 1, path: 'report.pdf', bytes: 10, verifier: ATTACHMENT_VERIFIER, sha256: revision,
      coverage: { unit: 'page', totalUnits: 2, from, to } },
  } }
}

describe('attachment coverage adapter', () => {
  it('records explicit bounded page ranges as partial coverage even without a continuation marker', () => {
    expect(attachmentExtractionCoverage({ format: 'pdf', unit: 'page', content: 'Page 2', outputBytes: 6,
      truncated: false, startItem: 2, endItem: 2, totalItems: 3 }, { pageStart: 2, pageEnd: 2 }))
      .toEqual({ unit: 'page', totalUnits: 3, from: [1, 0], to: [2, 0] })
  })
  it('preserves byte continuation boundaries rather than marking the partial item complete', () => {
    expect(attachmentExtractionCoverage({ format: 'xlsx', unit: 'sheet', content: 'part', outputBytes: 4,
      truncated: true, startItem: 1, endItem: 2, totalItems: 3, partialItem: 2, nextContentOffset: 55 }, { contentOffset: 20 }))
      .toEqual({ unit: 'item', totalUnits: 3, from: [0, 20], to: [1, 55] })
  })
  it('does not invent text coverage where read_file continuation owns the contract', () => {
    expect(attachmentExtractionCoverage({ format: 'text', unit: 'text', content: 'part', outputBytes: 4, truncated: true }, {})).toBeUndefined()
  })
  it('reconstructs current complete evidence and its exact ordered excerpts from the journal', () => {
    const first = parsed([0, 0], [1, 0], 'Opening')
    const last = parsed([1, 0], [2, 0], 'Closing')
    expect(attachmentCoverageAssessment([last], 'report.pdf', sha).coverage).toEqual({ status: 'incomplete', next: [0, 0] })
    expect(attachmentCoverageAssessment([last, first, first], '/home/user/report.pdf', sha))
      .toMatchObject({ coverage: { status: 'complete' }, extraction: 'Opening\n\nClosing' })
    expect(attachmentCoverageAssessment([parsed([0, 0], [1, 0], 'Old', 'b'.repeat(64)), last], 'report.pdf', sha).coverage.status).toBe('incomplete')
  })
  it('does not credit failed, not-executed or legacy receipts', () => {
    const entry = parsed([0, 0], [2, 0], 'All')
    expect(attachmentCoverageAssessment([{ ...entry, type: 'tool.failed' }], 'report.pdf', sha).coverage.status).toBe('unproven')
    entry.data.notExecuted = true
    expect(attachmentCoverageAssessment([entry], 'report.pdf', sha).coverage.status).toBe('unproven')
  })
})
