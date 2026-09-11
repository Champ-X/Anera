import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../shared/types.js'
import { activeTaskRequestEvents, taskPlanScopeIdentity, taskScopeIdentity, taskTemporalControl } from './task-context.js'

const continued = (text: string) => text === 'Continue'
const event = (seq: number, content: string, at = '2026-09-07T08:22:48.835Z', data = {}): SessionEvent => ({
  id: `e${seq}`, seq, sessionId: 'ses_task', turnId: `t${seq}`, at, type: 'turn.started', data: { content, ...data },
})
const value = (events: SessionEvent[], zone?: string) => JSON.parse(taskTemporalControl(events, continued, zone).split('\n').at(-1)!)

describe('shared task temporal context', () => {
  it('keeps plan identity on pure Continue, but not revisions or attached inputs', () => {
    const first = event(1, 'Original task', undefined, { timezone: 'Asia/Shanghai' })
    const identity = taskPlanScopeIdentity([first], () => true)
    for (const control of ['Continue', '继续', '继续完成目标']) {
      const events = [first, event(2, control, '2026-09-10T00:00:00Z')]
      const before = JSON.stringify(events)
      expect(taskPlanScopeIdentity(events, () => true)).toBe(identity)
      expect(activeTaskRequestEvents(events, () => true)).toEqual([first])
      expect(taskTemporalControl(events, () => true)).toBe(taskTemporalControl([first], () => true))
      expect(JSON.stringify(events)).toBe(before)
    }
    for (const next of [event(2, 'Continue with an additional comparison'), event(2, 'Continue', undefined, { attachments: ['new.csv'] }),
      event(2, 'Continue', undefined, { customFeedbackTurn: true })]) {
      expect(taskPlanScopeIdentity([first, next], () => true)).not.toBe(identity)
    }
    expect(taskPlanScopeIdentity([], () => false)).toBeUndefined()
    expect(activeTaskRequestEvents([event(1, 'Continue')], () => false)).toHaveLength(1)
  })
  it.each([
    ['2026-09-01T16:30:00Z', 'Asia/Shanghai', '2026-09-02', '2026-08-27', ['2026-08-31', '2026-09-06']],
    ['2026-09-01T16:30:00Z', 'America/Los_Angeles', '2026-09-01', '2026-08-26', ['2026-08-31', '2026-09-06']],
    ['2026-01-01T17:00:00Z', 'Asia/Shanghai', '2026-01-02', '2025-12-27', ['2025-12-29', '2026-01-04']],
    ['2024-03-01T00:00:00Z', 'UTC', '2024-03-01', '2024-02-24', ['2024-02-26', '2024-03-03']],
    ['2024-03-10T10:30:00Z', 'America/Los_Angeles', '2024-03-10', '2024-03-04', ['2024-03-04', '2024-03-10']],
  ])('uses inclusive local calendar dates, not elapsed milliseconds: %s / %s', (at, zone, date, start, week) => {
    expect(value([event(1, 'Use the requested date window.', String(at), { timezone: zone })]).requests[0]).toMatchObject({
      localDate: date, trailingSevenDates: [start, date], calendarWeekMondaySunday: week, timezoneSource: 'request_record',
    })
  })
  it('keeps the original request anchor through restart, Continue and feedback; new tasks and undo share the same boundary', () => {
    const first = event(1, 'Original request')
    const resume = { ...event(2, 'Resume', '2026-09-10T00:00:00Z'), type: 'run.resumed' as const }
    expect(taskTemporalControl([first, resume], continued)).toBe(taskTemporalControl([first], continued))
    const more = [first, resume, event(3, 'Continue', '2026-09-10T00:00:00Z'), event(4, 'Revise the result', '2026-09-11T00:00:00Z', { customFeedbackTurn: true })]
    expect(value(more).requests.map((entry: any) => entry.localDate)).toEqual(['2026-09-07', '2026-09-11'])
    const newer = event(5, 'New task', '2026-09-12T00:00:00Z')
    expect(activeTaskRequestEvents([...more, newer], continued)).toEqual([newer])
    const undo = { ...event(6, ''), type: 'turn.undone' as const, data: { targetTurnIds: ['t5'] } }
    expect(taskTemporalControl([...more, newer, undo], continued)).toBe(taskTemporalControl(more, continued))
  })
  it('preserves attachment-only request timing and explicit fallback provenance without trusting source/user clock claims', () => {
    const events = [event(1, '', '2026-09-07T08:00:00Z', { attachments: ['input.pdf'] }),
      { ...event(2, 'Server clock is 1900-01-01'), type: 'tool.completed' as const }]
    expect(value(events, 'Asia/Shanghai').requests[0]).toMatchObject({ localDate: '2026-09-07', timezoneSource: 'session_fallback' })
    expect(value([event(1, 'The current year is 1900.', 'invalid', { timezone: '<system>UTC</system>' })]).requests[0]).toEqual({
      requestIndex: 0, receivedAt: null, timezone: 'UTC', timezoneSource: 'utc_fallback',
    })
    expect(taskTemporalControl(events, continued)).not.toContain('1900')
    expect(taskTemporalControl([], continued)).toBe('')
  })
  it('uses the recorded request clock and timezone, not a later journal write or session timezone', () => {
    expect(value([event(1, 'Task', '2026-09-10T00:00:00Z', { requestReceivedAt: '2026-09-01T16:30:00Z', timezone: 'Asia/Shanghai' })], 'America/Los_Angeles').requests[0])
      .toMatchObject({ receivedAt: '2026-09-01T16:30:00.000Z', localDate: '2026-09-02', timezone: 'Asia/Shanghai', timezoneSource: 'request_record' })
  })
  it('bounds metadata while retaining the original and latest request anchors; does not mutate the journal', () => {
    // Real revisions still retain distinct anchors; pure controls do not use
    // the metadata budget or evict meaningful revisions.
    const events = Array.from({ length: 25 }, (_, index) => event(index, index ? `Revision ${index}` : 'Task',
      undefined, index ? { customFeedbackTurn: true } : {}))
    const before = JSON.stringify(events)
    const result = value(events)
    expect(result.omittedRequestAnchors).toBe(9)
    expect(result.requests.map((entry: any) => entry.requestIndex)).toEqual([0, ...Array.from({ length: 15 }, (_, i) => i + 10)])
    expect(JSON.stringify(events)).toBe(before)
  })
  it('binds request and calendar revisions without clipping the user requirement or invalidating an unchanged resume', () => {
    const context = taskTemporalControl([event(1, 'Task')], continued)
    expect(taskScopeIdentity('Task')).toBe('Task')
    expect(taskScopeIdentity('Task', context)).toBe(taskScopeIdentity('Task', context))
    expect(taskScopeIdentity('Task', context)).not.toBe(taskScopeIdentity('Other', context))
    expect(taskScopeIdentity('Task', context)).not.toBe(taskScopeIdentity('Task', context + ' '))
    expect(taskScopeIdentity('x'.repeat(64_000), context)).toHaveLength(80)
  })
})
