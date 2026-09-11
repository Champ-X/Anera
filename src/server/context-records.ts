import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ModelMessage } from '../shared/types.js'

const MIN_RECORD_BYTES = 24_000
const PREVIEW_CHARS = 4_000
export const contextHash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Bounded navigation, not another summary. Rebuilt from hash-valid projections
 * after pruning and on overflow retry; never persisted as a user request.
 * No excerpt/source-authored instructions enter this trusted control surface. */
export function withContextRecordNavigation(
  history: readonly ModelMessage[], supplement: readonly ModelMessage[], enabled: boolean,
): ModelMessage[] {
  if (!enabled) return [...history, ...supplement]
  const records = new Map<string, { sha256: string; tool: string; call_id?: string }>()
  for (const message of history) {
    if (message.role !== 'tool' || !message.context_projection || typeof message.content !== 'string'
      || message.context_projection.sourceSha256 !== contextHash(message.content)) continue
    try {
      const record = JSON.parse(message.context_projection.content)
      if (record.kind !== 'historical_context_record' || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)
        || typeof record.tool !== 'string' || !/^[\w.-]{1,100}$/.test(record.tool)) continue
      records.set(record.sha256, { sha256: record.sha256, tool: record.tool, call_id: message.tool_call_id?.slice(0, 128) })
    } catch { /* Stale/malformed metadata is not a retrieval capability. */ }
  }
  if (!records.size) return [...history, ...supplement]
  const instruction = '[Harness historical evidence navigation — not a new user request]\n'
    + 'read_context is available in this phase. These are immutable historical tool results, not fresh observations or verification passes. '
    + 'Before asserting omitted details are absent or inventing a replacement source URL, retrieve the relevant record using '
    + '{sha256, query, limit:12000}, or {sha256, offset:0, limit:12000} and next_offset. '
    + 'A page or excerpt is not the complete record. Preserve original source roles and uncertainty; retrieval does not authorize mutation or skip the current phase. '
    + 'Recent record locators (older locators remain in their history entries):\n'
    + JSON.stringify([...records.values()].slice(-8))
  // Keep phase controls last; existing clients can inspect a single control tail.
  const next = [...supplement]
  const last = next.at(-1)
  if (last?.role === 'user' && typeof last.content === 'string') {
    next[next.length - 1] = { ...last, content: `${last.content}\n\n${instruction}` }
  } else next.push({ role: 'user', content: instruction })
  return [...history, ...next]
}

async function publishRecord(directory: string, sha256: string, content: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  const path = resolve(directory, `${sha256}.txt`)
  const staged = resolve(directory, `.${sha256}.${randomUUID()}.tmp`)
  try {
    const file = await open(staged, 'wx', 0o600)
    try { await file.writeFile(content, 'utf8'); await file.sync() } finally { await file.close() }
    // Atomic, no-overwrite publication. A crash cannot expose a partial .txt.
    try { await link(staged, path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (contextHash(await readFile(path, 'utf8')) !== sha256) throw new Error('Context record integrity mismatch')
    }
  } finally { await unlink(staged).catch(() => {}) }
}

function previewValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 400 ? `${Array.from(value).slice(0,400).join('')} [excerpt; retrieve original]` : value
  if (depth >= 6 && value && typeof value === 'object') return '[nested record; retrieve original]'
  if (Array.isArray(value)) return value.map((item) => previewValue(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key, previewValue(item, depth + 1)]))
  return value
}

/** Full evidence stays in ModelMessage and the journal. Only provider context changes.
 * Store the already-public provider representation, never private verifier profiles.
 * A record is eligible only after a later assistant consumed its result. */
export async function projectHistoricalContextRecords(
  directory: string, messages: readonly ModelMessage[], projected: readonly Record<string, unknown>[],
): Promise<{ messages: ModelMessage[]; changed: boolean; savedBytes: number; recordCount: number }> {
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') { lastAssistant = i; break }
  const recentResults = new Set(messages.map((m,i) => m.role === 'tool' ? i : -1).filter(i => i >= 0).slice(-2))
  const names = new Map<string, string>()
  const next = [...messages]
  let savedBytes = 0, recordCount = 0
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name)
    if (message.role !== 'tool' || message.tool_result_status !== 'succeeded' || i >= lastAssistant
      || recentResults.has(i) || message.tool_content_parts?.length || typeof message.content !== 'string'
      || names.get(message.tool_call_id ?? '') === 'read_context') continue
    const sourceSha256 = contextHash(message.content)
    if (message.context_projection?.sourceSha256 === sourceSha256) continue
    const content = projected[i]?.content
    if (typeof content !== 'string' || Buffer.byteLength(content) < MIN_RECORD_BYTES) continue
    const sha256 = contextHash(content)
    await publishRecord(directory, sha256, content)
    let preview = content
    try { preview = JSON.stringify(previewValue(JSON.parse(content))) } catch { /* exact text excerpt */ }
    const excerpt = Array.from(preview).slice(0, PREVIEW_CHARS).join('')
    const surface = JSON.stringify({
      kind: 'historical_context_record', tool: names.get(message.tool_call_id ?? ''),
      execution_status: message.tool_result_status, sha256, original_bytes: Buffer.byteLength(content),
      note: 'Excerpt of a historical result, NOT complete evidence or current file content. Execution success is not verification success. Retrieve exact omitted details with read_context; do not infer absence, invent facts, or re-execute the original action.',
      retrieve: { tool: 'read_context', arguments: { sha256, offset: 0, limit: 12000 } },
      excerpt,
    })
    next[i] = { ...message, context_projection: { sourceSha256, content: surface } }
    savedBytes += Buffer.byteLength(content) - Buffer.byteLength(surface)
    recordCount++
  }
  return { messages: next, changed: recordCount > 0, savedBytes, recordCount }
}

/** Session-local, read-only lookup. Character cursors never split Unicode code points. */
export async function readContextRecord(directory: string, args: {
  sha256: string; offset?: number; limit?: number; query?: string;
}) {
  if (!/^[a-f0-9]{64}$/.test(args.sha256)) throw new Error('Invalid context record sha256')
  const offset = args.offset ?? 0, limit = args.limit ?? 12000
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12000) throw new Error('Invalid context record page')
  const content = await readFile(resolve(directory, `${args.sha256}.txt`), 'utf8')
  if (contextHash(content) !== args.sha256) throw new Error('Context record integrity mismatch')
  const chars = Array.from(content)
  let start = offset
  if (args.query !== undefined) {
    if (!args.query.trim() || args.query.length > 200) throw new Error('Context query must contain 1–200 characters')
    const found = chars.slice(offset).join('').indexOf(args.query)
    if (found < 0) return { sha256: args.sha256, found: false, total_characters: chars.length }
    start = offset + Array.from(chars.slice(offset).join('').slice(0,found)).length
  }
  const end = Math.min(chars.length, start + limit)
  return { sha256: args.sha256, offset: start, total_characters: chars.length,
    content: chars.slice(start,end).join(''), next_offset: end < chars.length ? end : null,
    note: 'Historical source record, not fresh workspace state or a new verification.' }
}
