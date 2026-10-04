import { describe, expect, it } from 'vitest'
import { modelToolFrameIsClosed, parseSteeringInput, steeringModelMessage } from './steering.js'
import { activeTaskRequestEvents, taskPlanScopeIdentity, taskTemporalControl } from './task-context.js'
import type { SessionEvent } from '../shared/types.js'

describe('running task steering protocol', () => {
  it('validates bounded authored content and a stable retry identity', () => {
    expect(parseSteeringInput({ content: ' 改为中文。 ', clientMessageId: 'req_1' })).toEqual({ content: ' 改为中文。 ', clientMessageId: 'req_1' })
    for (const input of [{ content: 'x' }, { content: ' ', clientMessageId: '1' }, { content: 'x'.repeat(32_001), clientMessageId: '1' },
      { content: 'x', clientMessageId: '../bad' }]) expect(() => parseSteeringInput(input)).toThrow()
  })

  it('waits for every result of a parallel tool frame and preserves authored text', () => {
    const frame = [{ role: 'assistant' as const, content: '', tool_calls: ['a', 'b'].map((id) => ({ id, type: 'function' as const,
      function: { name: 'read_file', arguments: '{}' } })) }, { role: 'tool' as const, tool_call_id: 'a', content: 'done' }]
    expect(modelToolFrameIsClosed(frame)).toBe(false)
    expect(modelToolFrameIsClosed([...frame, { role: 'tool', tool_call_id: 'b', content: 'not executed' }])).toBe(true)
    expect(steeringModelMessage({ id: '1', clientMessageId: '1', sequence: 2, status: 'applied', receivedAt: 'now', content: 'Use CSV instead.' }))
      .toMatchObject({ role: 'user', content: expect.stringContaining('Use CSV instead.') })
  })

  it('includes only applied corrections in requirement identity with their original receipt clock', () => {
    const event = (type: SessionEvent['type'], content: string, turnId = 'turn_1'): SessionEvent => ({ id: `${type}-${content}`, seq: 1,
      sessionId: 'session', at: '2026-09-27T01:00:00Z', type, turnId, data: { content } })
    const initial = event('turn.started', 'Create a short summary.')
    const received = event('user.steering.received', 'Include yesterday’s events.')
    const applied = { ...event('user.steering.applied', 'Include yesterday’s events.'), data: { content: 'Include yesterday’s events.',
      requestReceivedAt: '2026-09-26T10:00:00Z', timezone: 'Asia/Shanghai' } }
    const continuation = (text: string) => text === 'Continue'
    expect(activeTaskRequestEvents([initial, received], continuation)).toEqual([initial])
    const events = [initial, received, applied, event('turn.started', 'Continue', 'turn_2')]
    expect(activeTaskRequestEvents(events, continuation)).toEqual([initial, applied])
    expect(taskPlanScopeIdentity(events, continuation)).not.toBe(taskPlanScopeIdentity([initial], continuation))
    expect(taskTemporalControl(events, continuation)).toContain('2026-09-26T10:00:00.000Z')
    expect(activeTaskRequestEvents([...events, event('turn.started', 'A different task', 'turn_3')], continuation))
      .toHaveLength(1)
    const undone = { ...event('turn.undone', '', 'turn_2'), data: { targetTurnIds: ['turn_1'] } }
    expect(activeTaskRequestEvents([initial, applied, undone], continuation)).toEqual([])
  })
})
