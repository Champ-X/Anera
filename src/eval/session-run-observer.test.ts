import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunStatus, SessionEvent } from '../shared/types.js'
import { observeSessionRun } from './session-run-observer.js'

function event(seq: number, type: SessionEvent['type'] = 'run.status', status: unknown = 'running'): SessionEvent {
  return { id: `evt_${seq}`, sessionId: 'ses_fixture', seq, type, at: new Date().toISOString(), data: { status } }
}

function fixture(onEvent?: (event: SessionEvent) => void) {
  let listener!: (event: SessionEvent) => void
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe })
  const observer = observeSessionRun({ sessionId: 'ses_fixture', afterSeq: 10, deadline: Date.now() + 100,
    subscribe, onEvent })
  return { observer, subscribe, unsubscribe, emit: (value: SessionEvent) => listener(value) }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000) })
afterEach(() => { vi.useRealTimers() })

describe('incremental test-run observation', () => {
  it.each<RunStatus>(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted', 'awaiting_approval', 'awaiting_user'])(
    'observes %s once, without turning a terminal status into QA acceptance', async (status) => {
      const f = fixture()
      f.emit(event(11, 'run.status', status))
      expect(await f.observer.result).toEqual({ reason: 'terminal', status, lastSeq: 11, observedEvents: 1 })
      f.observer.close()
      f.observer.stop()
      f.emit(event(12, 'run.status', 'completed'))
      expect(f.unsubscribe).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('ignores history, duplicate/old sequences and other sessions; progress never restarts the deadline', async () => {
    const received = vi.fn()
    const f = fixture(received)
    f.emit(event(10, 'run.status', 'failed'))
    f.emit({ ...event(99, 'run.status', 'completed'), sessionId: 'ses_other' })
    f.emit(event(11, 'run.status', 'queued'))
    f.emit(event(11, 'run.status', 'completed'))
    f.emit(event(9, 'run.status', 'completed'))
    await vi.advanceTimersByTimeAsync(99)
    f.emit(event(12, 'assistant.thought.delta', 'completed'))
    f.emit(event(13, 'tool.completed', 'completed'))
    f.emit(event(14, 'run.status', 'cancelling'))
    f.emit(event(15, 'run.status', 'invented-status'))
    expect(f.observer.stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await f.observer.result).toEqual({ reason: 'deadline', lastSeq: 15, observedEvents: 5 })
    expect(received).toHaveBeenCalledTimes(5)
    expect(f.subscribe).toHaveBeenCalledTimes(1)
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not accept a late terminal event when the timer callback has not run yet', async () => {
    const f = fixture()
    vi.setSystemTime(1_100)
    f.emit(event(11, 'run.status', 'completed'))
    expect(await f.observer.result).toEqual({ reason: 'deadline', lastSeq: 10, observedEvents: 0 })
  })

  it.each(['stop', 'close'] as const)('cleans up on %s without a fake run.status event', async (method) => {
    const f = fixture()
    f.observer[method]()
    expect(await f.observer.result).toEqual({ reason: method === 'stop' ? 'budget' : 'closed', lastSeq: 10, observedEvents: 0 })
    f.emit(event(11, 'run.status', 'completed'))
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains diagnostic errors instead of throwing into durable event publication', async () => {
    const f = fixture(() => { throw new Error('diagnostic failed') })
    expect(() => f.emit(event(11))).not.toThrow()
    expect(await f.observer.result).toMatchObject({ reason: 'observer_error', error: 'diagnostic failed' })
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails closed for a corrupt new sequence', async () => {
    const f = fixture()
    expect(() => f.emit(event(Number.NaN))).not.toThrow()
    expect(await f.observer.result).toMatchObject({ reason: 'observer_error', error: 'Invalid durable event sequence', lastSeq: 10 })
  })

  it('records subscription and cleanup failures, including synchronous replay', async () => {
    const common = { sessionId: 'ses_fixture', afterSeq: 10, deadline: Date.now() + 100 }
    const broken = observeSessionRun({ ...common, subscribe: () => { throw new Error('subscribe failed') } })
    expect(await broken.result).toMatchObject({ reason: 'observer_error', error: 'subscribe failed' })
    const cleanup = vi.fn(() => { throw new Error('cleanup failed') })
    const replay = observeSessionRun({ ...common, subscribe: (callback) => {
      callback(event(11, 'run.status', 'completed'))
      return cleanup
    } })
    expect(await replay.result).toMatchObject({ reason: 'observer_error', error: 'cleanup failed' })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not subscribe or start a timer when the window already expired', async () => {
    const subscribe = vi.fn(() => () => {})
    const observer = observeSessionRun({ sessionId: 'ses_fixture', afterSeq: 10, deadline: Date.now(), subscribe })
    expect(observer.stopped).toBe(true)
    expect(await observer.result).toMatchObject({ reason: 'deadline' })
    expect(subscribe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([{ afterSeq: -1 }, { afterSeq: 0.5 }, { deadline: Number.NaN }, { deadline: Number.POSITIVE_INFINITY },
    { deadline: 2_147_484_648 }, { sessionId: '' }])('rejects invalid boundaries before subscribing: %j', (invalid) => {
    const subscribe = vi.fn(() => () => {})
    expect(() => observeSessionRun({ sessionId: 'ses_fixture', afterSeq: 10, deadline: 1_100, ...invalid, subscribe })).toThrow()
    expect(subscribe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
