import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../shared/types.js'
import { ATTACHMENT_VERIFIER, attachmentEvidenceFreshnessGap, withFileEvidenceSnapshot } from './file-evidence.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function extracted(text: string, args: Record<string, unknown> = {}, data: Record<string, unknown> = {}): SessionEvent {
  return { id: 'event', seq: 1, sessionId: 'session', turnId: 'turn', type: 'tool.completed', at: '', data: {
    call: { name: 'extract_attachment', arguments: { path: '/home/user/report.pdf', ...args } }, result: 'Parsed text',
    fileEvidence: { version: 1, path: 'report.pdf', verifier: ATTACHMENT_VERIFIER, sha256: hash(text), bytes: Buffer.byteLength(text) }, ...data,
  } }
}
const gap = (events: SessionEvent[], text = 'current') => attachmentEvidenceFreshnessGap(events, 'report.pdf', hash(text), Buffer.byteLength(text))

describe('version-bound file evidence', () => {
  it('accepts current bytes, not just the same filename or byte length', () => {
    expect(gap([extracted('current')])).toBeUndefined()
    expect(gap([extracted('changed')])).toContain('different file revision')
    expect(gap([extracted('current', {}, { fileEvidence: { version: 1, path: 'report.pdf', verifier: ATTACHMENT_VERIFIER, sha256: hash('current'), bytes: 999 } })])).toContain('different file revision')
  })
  it('does not impose parsing on an uninspected file or use another path as its evidence', () => {
    expect(gap([])).toBeUndefined()
    expect(gap([extracted('other', { path: 'other.pdf' })])).toBeUndefined()
  })
  it.each([undefined, { version: 1 }, { version: 1, path: 'report.pdf', verifier: 'model-says-verified', sha256: hash('current'), bytes: 7 }])('fails closed on legacy or malformed private receipts (%#)', (receipt) => {
    expect(gap([extracted('current', {}, { fileEvidence: receipt })])).toContain('no valid byte-bound receipt')
  })
  it('never accepts a receipt embedded in model-visible parsed text', () => {
    const entry = extracted('current')
    entry.data.result = JSON.stringify({ fileEvidence: entry.data.fileEvidence, status: 'success' })
    delete entry.data.fileEvidence
    expect(gap([entry])).toContain('no valid byte-bound receipt')
  })
  it('rejects mixed revision pagination and allows a fresh traversal to replace it', () => {
    const old = extracted('old')
    const currentTail = extracted('current', { page_start: 2 })
    expect(gap([old, currentTail])).toContain('different file revision')
    expect(gap([old, currentTail, extracted('current'), currentTail])).toBeUndefined()
    expect(gap([old, extracted('current', { content_offset: 20 })])).toContain('different file revision')
  })
  it('retains a failed traversal until a successful new one, but ignores calls that were not executed', () => {
    const failure = { ...extracted('current'), type: 'tool.failed' as const }
    expect(gap([extracted('current'), failure])).toContain('did not complete')
    expect(gap([failure, extracted('current', { item_start: 2 })])).toContain('did not complete')
    expect(gap([failure, extracted('current')])).toBeUndefined()
    expect(gap([extracted('current'), { ...failure, data: { ...failure.data, notExecuted: true } }])).toBeUndefined()
  })
  it('reuses the same byte identity across unrelated commands', () => {
    const command = extracted('old')
    command.data.call = { name: 'bash', arguments: { command: 'inspect-other-file' } }
    expect(gap([extracted('current'), command])).toBeUndefined()
  })

  it('inspects an immutable snapshot even if the workspace source changes during parsing, and cleans up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anera-evidence-test-'))
    let snapshotPath = ''
    try {
      const source = join(root, 'source.csv')
      await writeFile(source, 'old')
      const result = await withFileEvidenceSnapshot(source, 'source.csv', ATTACHMENT_VERIFIER, async (snapshot) => {
        snapshotPath = snapshot
        await writeFile(source, 'new')
        return readFile(snapshot, 'utf8')
      })
      expect(result.value).toBe('old')
      expect(result.receipt).toMatchObject({ sha256: hash('old'), bytes: 3, path: 'source.csv' })
      expect(await readFile(source, 'utf8')).toBe('new')
      await expect(access(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.each(['error', 'abort'])('cleans up after parser %s and does not expose the private path', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'anera-evidence-test-'))
    let snapshotPath = ''
    const controller = new AbortController()
    try {
      const source = join(root, 'source.txt')
      await writeFile(source, 'source')
      const operation = withFileEvidenceSnapshot(source, 'source.txt', ATTACHMENT_VERIFIER, async (snapshot) => {
        snapshotPath = snapshot
        if (mode === 'error') throw new Error(`Parser could not read ${snapshot}`)
        controller.abort()
      }, controller.signal)
      await expect(operation).rejects.toMatchObject(mode === 'error' ? { message: 'Parser could not read source.txt' } : { name: 'AbortError' })
      await expect(access(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
