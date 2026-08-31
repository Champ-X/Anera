import { describe, expect, it } from 'vitest'
import { CANONICAL_TRACE_VERSION, type CanonicalEvent, type CanonicalTrace } from '../shared/canonical-trace.js'
import { diffCanonicalTraces } from './trace-diff.js'

describe('canonical trace diff', () => {
  it('scores identical observable traces as exact', () => {
    const reference = fixtureTrace()
    const report = diffCanonicalTraces(reference, structuredClone(reference))
    expect(report.scores.overallFidelity).toBe(1)
    expect(report.counts).toMatchObject({ substitutions: 0, insertions: 0, deletions: 0 })
    expect(report.scores.efficiencyFidelity).toBe(1)
  })

  it('aligns inserted and deleted events instead of comparing by array offset', () => {
    const reference = fixtureTrace()
    const candidate = fixtureTrace()
    candidate.events.splice(2, 0, event(99, 'assistant', 'thought', 'extra_progress', 'completed', 'succeeded'))
    candidate.events = candidate.events.map((item, index) => ({ ...item, seq: index + 1 }))
    candidate.header.eventCount = candidate.events.length

    const report = diffCanonicalTraces(reference, candidate)

    expect(report.counts.insertions + report.counts.deletions).toBeGreaterThan(0)
    expect(report.scores.components.sequence.score).toBeLessThan(1)
    expect(report.scores.components.sequence.score).toBeGreaterThan(0.6)
  })

  it('surfaces a tool terminal status mismatch', () => {
    const reference = fixtureTrace()
    const candidate = fixtureTrace()
    const completed = candidate.events.find((item) => item.kind === 'tool' && item.phase === 'completed')
    if (!completed) throw new Error('fixture lacks completed tool')
    completed.status = 'failed'
    if (completed.tool) completed.tool.isError = true

    const report = diffCanonicalTraces(reference, candidate)

    expect(report.scores.components.tools.score).toBeLessThan(1)
    expect(report.alignment.some((item) => item.mismatches.some((mismatch) => mismatch.field === 'status'))).toBe(true)
  })

  it('can select one side from a paired Arena trace', () => {
    const left = fixtureTrace('left')
    const rightEvents = fixtureTrace('right').events.map((item) => ({ ...item, seq: item.seq + left.events.length }))
    const paired: CanonicalTrace = {
      ...left,
      header: { ...left.header, sides: ['left', 'right'], eventCount: left.events.length + rightEvents.length },
      events: [...left.events, ...rightEvents],
    }
    const candidate = fixtureTrace('global')

    const unselected = diffCanonicalTraces(paired, candidate)
    const selected = diffCanonicalTraces(paired, candidate, { referenceSide: 'left', candidateSide: 'global' })

    expect(unselected.scores.behaviorFidelity).toBeLessThan(1)
    expect(selected.scores.behaviorFidelity).toBe(1)
  })

  it('does not invent an efficiency score when Arena usage is not visible', () => {
    const reference = fixtureTrace()
    reference.outcome.usage = { totalTokens: 'not_visible', modelCalls: 'not_visible', toolCalls: 'not_visible', estimatedCostUsd: 'not_visible', durationMs: 'not_visible' }
    const report = diffCanonicalTraces(reference, fixtureTrace())
    expect(report.scores.efficiencyFidelity).toBeNull()
    expect(report.scores.overallFidelity).toBe(report.scores.behaviorFidelity)
  })
})

function fixtureTrace(side = 'global'): CanonicalTrace {
  const events = [
    event(1, 'user', 'message', 'submitted', 'finalized', 'succeeded', side),
    {
      ...event(2, 'tool', 'tool', 'fetch', 'started', 'running', side),
      tool: { name: 'fetch', callId: 'C01', arguments: { url: 'https://example.com' } },
    },
    {
      ...event(3, 'tool', 'tool', 'fetch', 'completed', 'succeeded', side),
      tool: { name: 'fetch', callId: 'C01', arguments: { url: 'https://example.com' }, result: 'ok', isError: false },
    },
    {
      ...event(4, 'system_ui', 'artifact', 'created', 'finalized', 'succeeded', side),
      artifact: { id: 'A01', path: 'report.md', operation: 'created' },
    },
    {
      ...event(5, 'assistant', 'final', 'final_answer', 'finalized', 'succeeded', side),
      message: 'The report is complete.',
    },
    event(6, 'system_ui', 'lifecycle', 'run_status', 'updated', 'succeeded', side),
  ]
  return {
    header: { schemaVersion: CANONICAL_TRACE_VERSION, source: 'arena', traceId: 'fixture', eventCount: events.length, sides: [side], durationMs: 1000 },
    events,
    outcome: {
      status: 'succeeded',
      finalText: 'The report is complete.',
      artifactPaths: ['report.md'],
      usage: { durationMs: 1000, modelCalls: 2, toolCalls: 1, totalTokens: 1000, estimatedCostUsd: 0.01 },
    },
  }
}

function event(
  seq: number,
  actor: CanonicalEvent['actor'],
  kind: CanonicalEvent['kind'],
  action: string,
  phase: CanonicalEvent['phase'],
  status: CanonicalEvent['status'],
  side = 'global',
): CanonicalEvent {
  return { schemaVersion: CANONICAL_TRACE_VERSION, source: 'arena', traceId: 'fixture', seq, sourceSeq: seq, side, actor, kind, action, phase, status }
}
