import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, posix } from 'node:path'
import type { SessionEvent } from '../shared/types.js'
import type { AttachmentExtractionOptions, AttachmentExtractionPage } from './attachment-extractor.js'
import { assessEvidenceCoverage, type CoverageAssessment, type CoverageObservation, type EvidenceCursor } from './evidence-coverage.js'

/** Identity of the bytes a verifier actually consumed, not a quality verdict. */
export interface FileEvidenceReceipt {
  version: 1
  path: string
  sha256: string
  bytes: number
  verifier: string
  /** The consumed region; identity alone does not prove a complete traversal. */
  coverage?: { unit: 'page' | 'item'; totalUnits: number; from: EvidenceCursor; to: EvidenceCursor }
}

export const ATTACHMENT_VERIFIER = 'attachment-extractor-v1'

export function attachmentExtractionCoverage(
  extracted: AttachmentExtractionPage, options: AttachmentExtractionOptions,
): FileEvidenceReceipt['coverage'] {
  // Text continuation belongs to read_file, whose line/UTF-8 paging contract
  // remains separate until it can supply the same private byte identity.
  if (extracted.format === 'text' || !extracted.totalItems || !extracted.startItem || !extracted.endItem) return undefined
  return { unit: extracted.unit === 'page' ? 'page' : 'item', totalUnits: extracted.totalItems,
    from: [extracted.startItem - 1, options.contentOffset ?? 0],
    to: extracted.partialItem !== undefined
      ? [extracted.partialItem - 1, extracted.nextContentOffset ?? -1]
      : [extracted.endItem, 0],
  }
}

/** Coverage is an independent obligation, not a consequence of freshness. */
export function attachmentCoverageAssessment(
  events: readonly SessionEvent[], path: string, sha256: string,
): { coverage: CoverageAssessment; unit?: 'page' | 'item'; extraction?: string } {
  const normalized = evidencePath(path)
  const spans: CoverageObservation[] = []
  let totalUnits: number | undefined
  let unit: 'page' | 'item' | undefined
  const excerpts = new Map<string, { from: EvidenceCursor; text: string }>()
  for (const event of events) {
    const call = event.data.call as { name?: string; arguments?: Record<string, unknown> } | undefined
    if (event.type !== 'tool.completed' || event.data.notExecuted === true || event.data.isError === true
      || call?.name !== 'extract_attachment' || evidencePath(call.arguments?.path) !== normalized) continue
    const receipt = event.data.fileEvidence
    if (!normalized || !validReceipt(receipt, normalized) || receipt.sha256 !== sha256) continue
    const span = receipt.coverage
    if (!span) continue
    if (span.unit !== 'page' && span.unit !== 'item') return { coverage: { status: 'unproven', reason: 'invalid_unit' } }
    if (unit && span.unit !== unit) return { coverage: { status: 'unproven', reason: 'conflicting_units' } }
    unit = span.unit
    totalUnits ??= span.totalUnits
    spans.push({ subject: normalized, revision: sha256, totalUnits: span.totalUnits, from: span.from, to: span.to })
    if (typeof event.data.result === 'string') {
      excerpts.set(JSON.stringify([span.from, span.to]), { from: span.from, text: event.data.result })
    }
  }
  const coverage = assessEvidenceCoverage({ subject: normalized ?? '', revision: sha256, totalUnits: totalUnits ?? 0 }, spans)
  return { unit, coverage, ...(coverage.status === 'complete' ? {
    // Exact retained parser excerpts, not model summaries. Repeated ranges are
    // deduplicated; delimiters preserve provenance instead of inventing text
    // where a literal itself crossed the parser's byte boundary.
    extraction: [...excerpts.values()].sort((a, b) => a.from[0] - b.from[0] || a.from[1] - b.from[1]).map((item) => item.text).join('\n\n'),
  } : {}) }
}

/** All parser subprocesses see one immutable revision, including ZIP readers
 * that open the file repeatedly. The private snapshot never becomes an artifact.
 */
export async function withFileEvidenceSnapshot<T>(
  target: string,
  path: string,
  verifier: string,
  inspect: (snapshotPath: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<{ value: T; receipt: FileEvidenceReceipt }> {
  signal?.throwIfAborted()
  const bytes = await readFile(target, { signal })
  const receipt: FileEvidenceReceipt = { version: 1, path, verifier,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  const directory = await mkdtemp(join(tmpdir(), 'anera-file-evidence-'))
  const snapshot = join(directory, `source${extname(target)}`)
  try {
    await writeFile(snapshot, bytes, { mode: 0o400, signal })
    signal?.throwIfAborted()
    const value = await inspect(snapshot)
    signal?.throwIfAborted()
    return { value, receipt }
  } catch (error) {
    // Parser diagnostics may include the private snapshot pathname.
    if (error instanceof Error && error.message.includes(directory)) {
      error.message = error.message.replaceAll(snapshot, path).replaceAll(directory, '[verification snapshot]')
    }
    throw error
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function evidencePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const relative = raw.replace(/^\/home\/user\//u, '').replace(/^~\//u, '')
  if (relative.startsWith('/') || relative.split('/').includes('..')) return undefined
  const path = posix.normalize(relative)
  return path === '.' ? undefined : path
}

function validReceipt(raw: unknown, path: string): raw is FileEvidenceReceipt {
  if (!raw || typeof raw !== 'object') return false
  const receipt = raw as FileEvidenceReceipt
  return receipt.version === 1 && receipt.verifier === ATTACHMENT_VERIFIER
    && evidencePath(receipt.path) === path && /^[a-f0-9]{64}$/u.test(receipt.sha256)
    && Number.isSafeInteger(receipt.bytes) && receipt.bytes >= 0
}

/** Completeness/semantics stay with domain validators. This common boundary
 * prevents them from composing obsolete or mixed-revision parser evidence.
 * An uninspected file is still viewable; this is not a new universal parse gate.
 */
export function attachmentEvidenceStatus(
  events: readonly SessionEvent[], path: string, sha256: string, bytes: number,
): { status: 'unobserved' | 'current' | 'invalid'; gap?: string } {
  const normalizedPath = evidencePath(path)
  if (!normalizedPath) return { status: 'invalid', gap: 'Cannot establish a workspace file identity for verification.' }
  let gap: string | undefined
  let observed = false
  for (const event of events) {
    if (!['tool.completed', 'tool.failed', 'tool.timed_out'].includes(event.type)
      || event.data.notExecuted === true) continue
    const call = event.data.call as { name?: string; arguments?: Record<string, unknown> } | undefined
    if (call?.name !== 'extract_attachment' || evidencePath(call.arguments?.path) !== normalizedPath) continue
    observed = true
    const args = call.arguments ?? {}
    const startsNewTraversal = Number(args.page_start ?? args.item_start ?? 1) === 1
      && Number(args.content_offset ?? 0) === 0
    if (startsNewTraversal) gap = undefined
    const receipt = event.data.fileEvidence
    if (event.type !== 'tool.completed' || event.data.isError === true) {
      gap = `The latest attachment verification of ${normalizedPath} did not complete successfully.`
    } else if (!validReceipt(receipt, normalizedPath)) {
      gap = `The attachment verification of ${normalizedPath} has no valid byte-bound receipt.`
    } else if (receipt.sha256 !== sha256 || receipt.bytes !== bytes) {
      gap = `The attachment verification of ${normalizedPath} belongs to a different file revision.`
    }
    // Once stale/missing/failed, continuation pages cannot repair the chain;
    // a fresh traversal must start with the first item of the current revision.
  }
  return gap ? { status: 'invalid', gap: `${gap} Run extract_attachment from the first page/item of the current file, consume its continuations, and recheck the requested requirements before presenting. Historical parsed text is not evidence for changed bytes.` }
    : { status: observed ? 'current' : 'unobserved' }
}

export function attachmentEvidenceFreshnessGap(
  events: readonly SessionEvent[], path: string, sha256: string, bytes: number,
): string | undefined {
  return attachmentEvidenceStatus(events, path, sha256, bytes).gap
}
