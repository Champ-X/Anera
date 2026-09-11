import { createHash } from 'node:crypto'
import { assessEvidenceCoverage } from './evidence-coverage.js'

/** Evidence of returned page bytes, not an attestation that their claims are true. */
export interface ResearchPageRead {
  url: string
  requestedUrl: string
  format: string
  chunkIndex: number
  totalChunks: number
  hasMore: boolean
  contentBytes: number
  contentSha256: string
  snapshotSha256?: string
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

export function normalizeResearchPageReads(value: unknown): ResearchPageRead[] {
  if (!Array.isArray(value)) return []
  const reads = new Map<string, ResearchPageRead>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const read = item as ResearchPageRead
    const url = httpUrl(read.url)
    const requestedUrl = httpUrl(read.requestedUrl)
    if (!url || !requestedUrl
      || !['markdown', 'raw', 'text', 'html'].includes(read.format)
      || !Number.isInteger(read.chunkIndex) || read.chunkIndex < 0
      || !Number.isInteger(read.totalChunks) || read.totalChunks < 1 || read.totalChunks > 10_000
      || read.chunkIndex >= read.totalChunks
      || typeof read.hasMore !== 'boolean'
      || read.hasMore !== (read.chunkIndex + 1 < read.totalChunks)
      || !Number.isInteger(read.contentBytes) || read.contentBytes < 1
      || typeof read.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(read.contentSha256)
      || (read.snapshotSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(read.snapshotSha256))) continue
    const normalized = {
      url, requestedUrl, format: read.format,
      chunkIndex: read.chunkIndex, totalChunks: read.totalChunks, hasMore: read.hasMore,
      contentBytes: read.contentBytes, contentSha256: read.contentSha256,
      ...(read.snapshotSha256 ? { snapshotSha256: read.snapshotSha256 } : {}),
    }
    const key = JSON.stringify(normalized)
    // Retain the last observation order, including a deliberate re-read.
    reads.delete(key)
    reads.set(key, normalized)
  }
  return [...reads.values()]
}

export function researchPageReadFromResult(
  call: { name: string; arguments: Record<string, unknown> },
  payload: Record<string, unknown> | undefined,
): ResearchPageRead | undefined {
  if (!['fetch_page', 'web_fetch'].includes(call.name) || payload?.status !== 'success'
    || payload.notExecuted === true || payload.not_executed === true) return undefined
  // Only our compactor can emit this outer metadata. A source URL or a
  // head/tail excerpt from a legacy compacted result never proves a read.
  if (payload.historical_result_compacted === true) {
    return normalizeResearchPageReads([payload.research_page_read])[0]
  }
  const content = typeof payload.content === 'string' ? payload.content : ''
  if (!content.trim() || payload.truncated === true
    || /\[(?:Content truncated|Source response byte limit reached)/u.test(content)) return undefined
  const requestedUrl = httpUrl(call.arguments.url)
  const url = httpUrl(payload.url) ?? requestedUrl
  if (!url || !requestedUrl) return undefined
  const chunkIndex = call.name === 'web_fetch' ? 0 : payload.chunkIndex ?? call.arguments.chunkIndex ?? 0
  const hasMore = call.name === 'web_fetch' ? false : payload.hasMore ?? false
  const totalChunks = call.name === 'web_fetch' ? 1 : payload.totalChunks ?? (hasMore === false ? Number(chunkIndex) + 1 : undefined)
  return normalizeResearchPageReads([{
    url, requestedUrl,
    format: call.arguments.format ?? 'markdown',
    chunkIndex, totalChunks, hasMore,
    contentBytes: Buffer.byteLength(content),
    contentSha256: createHash('sha256').update(content).digest('hex'),
    ...(typeof payload.snapshot_sha256 === 'string' ? { snapshotSha256: payload.snapshot_sha256 } : {}),
  }])[0]
}

/** Only the most recently observed representation of a source can support it. */
export function latestResearchPageReads(values: readonly ResearchPageRead[]): ResearchPageRead[] {
  const reads = normalizeResearchPageReads(values)
  const attestedSources = new Set(reads.filter((read) => read.snapshotSha256)
    .map((read) => JSON.stringify([read.requestedUrl, read.format])))
  const groups = new Map<string, ResearchPageRead[]>()
  const latestByUrl = new Map<string, string>()
  for (const read of reads) {
    // Legacy public pagination carries less evidence than the private
    // snapshot from the same tool. It cannot supersede that attestation.
    if (!read.snapshotSha256 && read.totalChunks > 1
      && attestedSources.has(JSON.stringify([read.requestedUrl, read.format]))) continue
    const key = JSON.stringify([read.requestedUrl, read.url, read.format,
      read.snapshotSha256 ?? (read.totalChunks === 1 ? read.contentSha256 : 'legacy'), read.totalChunks])
    groups.set(key, [...groups.get(key) ?? [], read])
    latestByUrl.set(read.requestedUrl, key)
    latestByUrl.set(read.url, key)
  }
  return [...groups.entries()].flatMap(([key, group]) => (
    latestByUrl.get(group[0].requestedUrl) === key && latestByUrl.get(group[0].url) === key ? group : []
  ))
}

export function researchPageReadProgress(values: readonly ResearchPageRead[], unavailableUrls: readonly string[] = []): {
  sourceUrls: string[]
  pending: Array<{ url: string; format: string; chunkIndex: number; totalChunks: number }>
} {
  const groups = new Map<string, ResearchPageRead[]>()
  for (const read of latestResearchPageReads(values)) {
    const key = JSON.stringify([read.requestedUrl, read.url, read.format,
      read.snapshotSha256 ?? (read.totalChunks === 1 ? read.contentSha256 : 'legacy'), read.totalChunks])
    groups.set(key, [...groups.get(key) ?? [], read])
  }
  const sourceUrls = new Set<string>()
  const pending = new Map<string, { url: string; format: string; chunkIndex: number; totalChunks: number }>()
  for (const group of groups.values()) {
    const first = group[0]
    // Multiple chunks need a common snapshot identity. Never join bytes from
    // two different page versions or infer the missing first chunk from EOF.
    const required = { subject: JSON.stringify([first.requestedUrl, first.url, first.format]),
      revision: first.snapshotSha256 ?? (first.totalChunks === 1 ? first.contentSha256 : ''), totalUnits: first.totalChunks }
    const coverage = assessEvidenceCoverage(required, group.map((read) => ({ ...required,
      from: [read.chunkIndex, 0], to: [read.chunkIndex + 1, 0],
    })))
    const key = JSON.stringify([first.requestedUrl, first.format])
    if (coverage.status === 'complete') {
      sourceUrls.add(first.url)
      sourceUrls.add(first.requestedUrl)
      pending.delete(key)
    } else {
      pending.set(key, {
        url: first.requestedUrl, format: first.format,
        chunkIndex: coverage.status === 'incomplete' ? coverage.next[0] : 0,
        totalChunks: first.totalChunks,
      })
    }
  }
  const unavailable = new Set(unavailableUrls.map(httpUrl).filter(Boolean))
  return { sourceUrls: [...sourceUrls], pending: [...pending.values()].filter((item) => !unavailable.has(item.url)) }
}
