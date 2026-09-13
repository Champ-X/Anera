import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../shared/types.js'
import { ExecutionProgressMonitor, observationCycleRecovery } from './execution-progress.js'

let sequence = 0
function event(name: string, args: Record<string, unknown>, result: unknown = { text: 'same evidence' }, data = {}): SessionEvent {
  sequence += 1
  return { id: `event-${sequence}`, seq: sequence, sessionId: 'session', turnId: 'turn', stepId: `step-${sequence}`,
    type: 'tool.completed', at: '2026-09-10T00:00:00Z', callId: `call-${sequence}`,
    data: { call: { id: `call-${sequence}`, name, arguments: args }, result: JSON.stringify(result), ...data } }
}
const read = (path: string, result?: unknown) => event('read_file', { path }, result)

describe('task-neutral execution observation', () => {
  it('retains repeated executed failures across edits and restart without claiming identical output', () => {
    const fail = (stdout: string) => event('bash', { command: 'node tests/play.js', cwd: '.' },
      { status: 'completed', exit_code: 1, stdout }, { isError: true })
    const events = [fail('2 failures'), event('edit_file', { path: 'tests/play.js' }),
      read('game.html'), fail('1 failure'), event('edit_file', { path: 'game.html' })]
    const monitor = new ExecutionProgressMonitor(events, 'turn')
    const third = fail('different failure')
    const cycle = monitor.observe([third])!
    expect(cycle).toMatchObject({ kind: 'repeated_execution_failure', occurrences: 3 })
    expect(observationCycleRecovery(cycle)).toContain('does not imply identical output or absence of progress')
    monitor.acknowledge(cycle.fingerprint)
    expect(monitor.observe([fail('still failed')])).toBeUndefined()
    const receipt: SessionEvent = { ...third, seq: third.seq + 1, type: 'model.tool_call.repair',
      data: { reason: 'repeated_execution_failure', ...cycle } }
    const restored = new ExecutionProgressMonitor([...events, third, receipt], 'turn')
    expect(restored.observe([fail('still failed after restart')])).toBeUndefined()
    monitor.observe([event('bash', { command: 'node tests/play.js', cwd: '.' }, { status: 'completed', exit_code: 0 })])
    expect(monitor.observe([fail('new failure')])).toBeUndefined()
    expect(monitor.observe([fail('new failure')])).toBeUndefined()
    expect(monitor.observe([fail('new failure')])).toMatchObject({ occurrences: 3 })
  })

  it('does not count unknown, blocked, cancelled or pending command outcomes as repeated executions', () => {
    const monitor = new ExecutionProgressMonitor()
    for (let i = 0; i < 6; i += 1) {
      for (const result of [{ status: 'running', exit_code: 1 }, { status: 'shell_error', exit_code: null }]) {
        expect(monitor.observe([event('bash', { command: 'node tests/play.js' }, result)])).toBeUndefined()
      }
      for (const data of [{ notExecuted: true }, { cancelled: true }]) {
        expect(monitor.observe([event('bash', { command: 'node tests/play.js' }, { status: 'completed', exit_code: 1 }, data)])).toBeUndefined()
      }
    }
  })
  it.each([2, 3, 4])('detects a %i-step cycle from terminal evidence, independently of provider IDs', (period) => {
    const monitor = new ExecutionProgressMonitor()
    for (let i = 0; i < period * 3 - 1; i += 1) expect(monitor.observe([read(String(i % period))])).toBeUndefined()
    const cycle = monitor.observe([read(String(period - 1))])!
    expect(cycle).toMatchObject({ period, occurrences: 3, callNames: ['read_file'] })
    monitor.acknowledge(cycle.fingerprint)
    for (let i = 0; i < period * 3; i += 1) expect(monitor.observe([read(String(i % period))])).toBeUndefined()
    expect(observationCycleRecovery(cycle)).toContain('Do not change the user\'s requirements')
    expect(observationCycleRecovery(cycle)).not.toContain('same evidence')
  })

  it('recognizes identical parallel batches despite JSON key order and completion order', () => {
    const monitor = new ExecutionProgressMonitor()
    const a = () => read('a', { x: 1, y: 2 })
    const b = () => read('b')
    expect(monitor.observe([a(), b()])).toBeUndefined()
    expect(monitor.observe([b(), read('a', { y: 2, x: 1 })])).toBeUndefined()
    expect(monitor.observe([a(), b()])).toMatchObject({ period: 1, occurrences: 3 })
  })

  it('does not duplicate the existing identical-single-call guard', () => {
    const monitor = new ExecutionProgressMonitor()
    for (let i = 0; i < 30; i += 1) expect(monitor.observe([read('a')])).toBeUndefined()
  })

  it('treats changed evidence and changed cursors as new observations', () => {
    const monitor = new ExecutionProgressMonitor()
    for (let i = 0; i < 20; i += 1) {
      expect(monitor.observe([read('a', { revision: i }), read('b')])).toBeUndefined()
      expect(monitor.observe([event('read_file', { path: 'a', cursor: String(i) })])).toBeUndefined()
    }
  })

  it.each([
    () => event('write_file', { path: 'a', content: 'updated' }),
    () => event('custom_connector', { action: 'read' }),
    () => event('get_process_output', { process_id: 'pending' }),
    () => read('progress', { status: 'pending' }),
    () => read('progress', { status: 'running' }),
    () => event('read_file', { path: 'a' }, {}, { notExecuted: true }),
    () => event('read_file', { path: 'a' }, {}, { cancelled: true }),
    () => ({ ...read('a'), type: 'tool.timed_out' as const }),
  ])('breaks the window for mutation, unknown, pending or non-executed boundaries (%#)', (boundary) => {
    const monitor = new ExecutionProgressMonitor()
    for (const path of ['a', 'b', 'a', 'b']) monitor.observe([read(path)])
    monitor.observe([boundary()])
    expect(monitor.observe([read('a')])).toBeUndefined()
    expect(monitor.observe([read('b')])).toBeUndefined()
  })

  it('can recover repeated executed failures without mislabelling them success', () => {
    const monitor = new ExecutionProgressMonitor()
    let cycle
    for (let i = 0; i < 6; i += 1) cycle = monitor.observe([{ ...read(String(i % 2), { error: 'missing' }), type: 'tool.failed' }])
    expect(cycle).toMatchObject({ period: 2 })
  })

  it('rehydrates only this turn, retaining observed cycles but acknowledging only journaled feedback', () => {
    const events = Array.from({ length: 6 }, (_, i) => read(String(i % 2)))
    const live = new ExecutionProgressMonitor()
    let cycle
    for (const entry of events) cycle = live.observe([entry])
    expect(cycle).toBeDefined()
    const unnotified = new ExecutionProgressMonitor(events, 'turn')
    expect(unnotified.observe([read('0')])?.fingerprint).toBe(cycle!.fingerprint)
    const receipt: SessionEvent = { ...events.at(-1)!, type: 'model.tool_call.repair', data: {
      reason: 'unchanged_observation_cycle', ...cycle,
    } }
    const restored = new ExecutionProgressMonitor([...events, receipt], 'turn')
    expect(restored.observe([read('0')])).toBeUndefined()
    expect(new ExecutionProgressMonitor(events, 'another-turn').observe([read('0')])).toBeUndefined()
  })
})
