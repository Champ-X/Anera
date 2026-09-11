import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CANONICAL_TRACE_VERSION, type CanonicalTrace } from '../shared/canonical-trace.js'
import { SessionStore } from '../server/session-store.js'
import { loadCanonicalTrace, serializeCanonicalTrace, traceFromJsonl } from './trace-io.js'

describe('canonical trace JSONL I/O', () => {
  it('round-trips side-specific outcomes', () => {
    const trace: CanonicalTrace = {
      header: { schemaVersion: CANONICAL_TRACE_VERSION, source: 'arena', traceId: 'paired', eventCount: 0, sides: ['left', 'right'] },
      events: [],
      outcome: {
        status: 'unknown', finalText: 'not_applicable', artifactPaths: 'unknown',
        usage: { totalTokens: 'unknown', modelRequests: 'unknown', estimatedCostStatus: 'unknown' },
      },
      sideOutcomes: {
        left: {
          status: 'succeeded', finalText: 'left final', artifactPaths: [],
          usage: { totalTokens: 100, modelRequests: 'unknown', estimatedCostStatus: 'unknown' },
        },
        right: {
          status: 'failed', finalText: 'right final', artifactPaths: [],
          usage: { totalTokens: 120, modelRequests: 'unknown', estimatedCostStatus: 'unknown' },
        },
      },
    }

    expect(traceFromJsonl(serializeCanonicalTrace(trace))).toEqual(trace)
  })

  it('hydrates legacy usage provenance and keeps zero-cost unknown or partial coverage explicit in JSONL', () => {
    const records = [
      {
        recordType: 'trace',
        trace: { schemaVersion: CANONICAL_TRACE_VERSION, source: 'anera', traceId: 'legacy-usage', eventCount: 1, sides: ['global'] },
      },
      {
        recordType: 'event',
        event: {
          schemaVersion: CANONICAL_TRACE_VERSION,
          source: 'anera',
          traceId: 'legacy-usage',
          seq: 1,
          sourceSeq: 1,
          side: 'global',
          actor: 'system_ui',
          kind: 'usage',
          action: 'agent',
          phase: 'updated',
          status: 'succeeded',
          usage: { modelRequests: 1, modelCalls: 0, estimatedCostUsd: 0 },
        },
      },
      {
        recordType: 'outcome',
        outcome: {
          status: 'succeeded',
          finalText: '',
          artifactPaths: [],
          usage: { modelRequests: 3, modelCalls: 2, estimatedCostUsd: 0 },
        },
        sideOutcomes: {
          global: {
            status: 'succeeded', finalText: '', artifactPaths: [],
            usage: { modelCalls: 2, estimatedCostUsd: 0.001 },
          },
        },
      },
    ].map((record) => JSON.stringify(record)).join('\n')

    const trace = traceFromJsonl(records)
    expect(trace.events[0].usage).toMatchObject({
      modelRequests: 1, modelCalls: 0, estimatedCostUsd: 0, estimatedCostStatus: 'unknown',
    })
    expect(trace.outcome.usage).toMatchObject({
      modelRequests: 3, modelCalls: 2, estimatedCostUsd: 0, estimatedCostStatus: 'partial',
    })
    expect(trace.sideOutcomes?.global.usage).toMatchObject({
      modelRequests: 2, modelCalls: 2, estimatedCostUsd: 0.001, estimatedCostStatus: 'estimated',
    })

    const exported = serializeCanonicalTrace(trace)
    const exportedRecords = exported.trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
    expect(exportedRecords[1].event.usage).toMatchObject({
      estimatedCostUsd: 0, modelRequests: 1, estimatedCostStatus: 'unknown',
    })
    expect(exportedRecords.at(-1)?.outcome.usage).toMatchObject({
      estimatedCostUsd: 0, modelRequests: 3, estimatedCostStatus: 'partial',
    })
  })

  it('accepts raw append-only Anera SessionEvent JSONL', () => {
    const raw = [
      { id: 'evt_00000000000000000001', sessionId: 'ses_1234567890abcdefghij', seq: 1, type: 'session.created', at: '2026-08-28T00:00:00.000Z', data: { title: 'Probe' } },
      { id: 'evt_00000000000000000002', sessionId: 'ses_1234567890abcdefghij', seq: 2, type: 'run.status', at: '2026-08-28T00:00:00.100Z', data: { status: 'completed' } },
    ].map((event) => JSON.stringify(event)).join('\n')

    const trace = traceFromJsonl(raw)
    expect(trace.header.source).toBe('anera')
    expect(trace.outcome.status).toBe('succeeded')
  })

  it('hydrates persisted event sidecars from a file and fails closed without their bytes', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-trace-event-payloads-'))
    try {
      const store = new SessionStore(root, 'test-model')
      await store.initialize()
      const session = await store.create()
      const finalText = `${'Large durable Final🙂\n'.repeat(5_000)}complete`
      await store.append(session.summary.id, 'assistant.final', {
        content: finalText,
        finishReason: 'stop',
      }, { turnId: 'turn_large_trace', stepId: 'step_large_trace' })
      await store.append(session.summary.id, 'run.status', {
        status: 'completed',
      }, { turnId: 'turn_large_trace' })

      const eventPath = resolve(store.sessionDir(session.summary.id), 'events.jsonl')
      const persisted = await readFile(eventPath, 'utf8')
      expect(persisted).toContain('_aneraStorage')
      expect(() => traceFromJsonl(persisted)).toThrow(/durable payload references/iu)

      const hydrated = await loadCanonicalTrace(eventPath)
      expect(hydrated.outcome).toMatchObject({ status: 'succeeded', finalText })

      await rm(resolve(store.sessionDir(session.summary.id), 'event-payloads'), { recursive: true })
      await expect(loadCanonicalTrace(eventPath)).rejects.toMatchObject({
        name: 'EventPayloadIntegrityError',
        code: 'EVENT_PAYLOAD_INTEGRITY',
        eventType: 'assistant.final',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not repair a false declared eventCount', () => {
    const records = [
      { recordType: 'trace', trace: { schemaVersion: CANONICAL_TRACE_VERSION, source: 'arena', traceId: 'bad-count', eventCount: 9, sides: ['global'] } },
      { recordType: 'outcome', outcome: { status: 'succeeded', finalText: '', artifactPaths: [], usage: {} } },
    ].map((record) => JSON.stringify(record)).join('\n')

    expect(() => traceFromJsonl(records)).toThrow('declared eventCount 9 but contains 0')
  })

  it('rejects duplicate, out-of-order, and unknown canonical record types', () => {
    const header = { recordType: 'trace', trace: { schemaVersion: CANONICAL_TRACE_VERSION, source: 'arena', traceId: 'strict', eventCount: 0, sides: ['global'] } }
    const outcome = { recordType: 'outcome', outcome: { status: 'succeeded', finalText: '', artifactPaths: [], usage: {} } }
    expect(() => traceFromJsonl([header, header, outcome].map((record) => JSON.stringify(record)).join('\n'))).toThrow('multiple trace')
    expect(() => traceFromJsonl([header, { recordType: 'invented' }, outcome].map((record) => JSON.stringify(record)).join('\n'))).toThrow('unknown recordType')
    expect(() => traceFromJsonl([outcome, header].map((record) => JSON.stringify(record)).join('\n'))).toThrow('must begin')
  })

  it('rejects trailing records after a complete canonical trace value', () => {
    const trace: CanonicalTrace = {
      header: { schemaVersion: CANONICAL_TRACE_VERSION, source: 'arena', traceId: 'complete-value', eventCount: 0, sides: ['global'] },
      events: [],
      outcome: { status: 'succeeded', finalText: '', artifactPaths: [], usage: {} },
    }
    expect(() => traceFromJsonl(`${JSON.stringify(trace)}\n${JSON.stringify({ ignored: true })}`)).toThrow('cannot be followed')
  })
})
