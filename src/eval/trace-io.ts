import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import {
  canonicalTraceWithUsageProvenance,
  type CanonicalOutcome,
  type CanonicalTrace,
  type CanonicalTraceHeader,
  type CanonicalTraceRecord,
} from '../shared/canonical-trace.js'
import type { SessionEvent, SessionSnapshot } from '../shared/types.js'
import { normalizeAneraTrace, traceToJsonl } from '../server/trace-normalizer.js'
import { importArenaEventsFile } from './arena-importer.js'

export function loadCanonicalTrace(path: string): CanonicalTrace {
  const absolute = resolve(path)
  if (extname(absolute).toLowerCase() === '.md') return importArenaEventsFile(absolute)
  const text = readFileSync(absolute, 'utf8')
  if (extname(absolute).toLowerCase() === '.json') return traceFromJson(JSON.parse(text) as unknown)
  return traceFromJsonl(text)
}

export function traceFromJson(value: unknown): CanonicalTrace {
  if (!value || typeof value !== 'object') throw new Error('Trace JSON must be an object')
  const record = value as Record<string, unknown>
  if (isCanonicalTrace(record)) return canonicalTraceWithUsageProvenance(record as unknown as CanonicalTrace)
  if (Array.isArray(record.events) && record.session && typeof record.session === 'object') {
    const snapshot = record as unknown as SessionSnapshot
    return normalizeAneraTrace({
      events: snapshot.events,
      summary: snapshot.session,
      artifacts: snapshot.artifacts,
      processes: snapshot.processes,
      website: snapshot.website,
      repository: snapshot.repository,
    })
  }
  throw new Error('JSON is neither a canonical trace nor an Anera session snapshot')
}

export function traceFromJsonl(text: string): CanonicalTrace {
  const values = text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line) as unknown
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  if (values.length === 0) throw new Error('Trace JSONL is empty')
  const first = values[0] as Record<string, unknown>
  if (first.recordType) return canonicalRecordsToTrace(values as CanonicalTraceRecord[])
  if (isSessionEvent(first)) return normalizeAneraTrace({ events: values as SessionEvent[] })
  if (isCanonicalTrace(first)) {
    if (values.length !== 1) throw new Error('A complete canonical trace JSONL value cannot be followed by additional records')
    return canonicalTraceWithUsageProvenance(first as unknown as CanonicalTrace)
  }
  throw new Error('JSONL is neither canonical records nor raw Anera SessionEvent records')
}

export function serializeCanonicalTrace(trace: CanonicalTrace): string {
  return traceToJsonl(trace)
}

function canonicalRecordsToTrace(records: CanonicalTraceRecord[]): CanonicalTrace {
  if (records[0]?.recordType !== 'trace') throw new Error('Canonical JSONL must begin with exactly one trace record')
  if (records.at(-1)?.recordType !== 'outcome') throw new Error('Canonical JSONL must end with exactly one outcome record')
  let header: CanonicalTraceHeader | undefined
  let outcome: CanonicalOutcome | undefined
  let sideOutcomes: Record<string, CanonicalOutcome> | undefined
  const events = []
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== 'object') throw new Error(`Canonical JSONL record ${index + 1} must be an object`)
    if (record.recordType === 'trace') {
      if (header) throw new Error('Canonical JSONL contains multiple trace records')
      header = record.trace
    } else if (record.recordType === 'event') {
      if (!header || outcome) throw new Error(`Canonical JSONL event record ${index + 1} is out of order`)
      events.push(record.event)
    }
    else if (record.recordType === 'outcome') {
      if (outcome) throw new Error('Canonical JSONL contains multiple outcome records')
      outcome = record.outcome
      sideOutcomes = record.sideOutcomes
    } else throw new Error(`Canonical JSONL has unknown recordType at record ${index + 1}`)
  }
  if (!header) throw new Error('Canonical JSONL is missing its trace record')
  if (!outcome) throw new Error('Canonical JSONL is missing its outcome record')
  if (header.eventCount !== events.length) {
    throw new Error(`Canonical JSONL declared eventCount ${String(header.eventCount)} but contains ${events.length} event records`)
  }
  return canonicalTraceWithUsageProvenance({ header, events, outcome, sideOutcomes })
}

function isCanonicalTrace(value: Record<string, unknown>): boolean {
  return Boolean(value.header && Array.isArray(value.events) && value.outcome)
}

function isSessionEvent(value: Record<string, unknown>): boolean {
  return typeof value.sessionId === 'string' && typeof value.type === 'string' && typeof value.seq === 'number' && value.data !== undefined
}
