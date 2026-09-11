import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent-service.js'
import { SessionStore } from './session-store.js'
import type { ModelMessage } from '../shared/types.js'

describe('shared temporal context in actual agent decisions', () => {
  it.each([
    'Update the parser and test its date boundaries.',
    'Reconcile this week’s transactions from the supplied data.',
    'Research recent storage specifications and cite the sources.',
  ])('retains the request clock across a journal-only restart without changing the requirements: %s', async (request) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-task-time-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    let now = new Date('2026-09-07T08:00:00Z')
    const controls: string[] = []
    const stream = vi.fn(async (options: { messages: ModelMessage[] }) => {
      expect(options.messages.some((message) => String(message.content).includes(request))).toBe(true)
      const control = options.messages.map((message) => String(message.content)).find((text) => text.includes('Harness task temporal context'))!
      expect(control).toBeDefined()
      const json = JSON.parse(control.split('\n').find((line) => line.startsWith('{"version":1,"omittedRequestAnchors"'))!)
      expect(json.requests).toHaveLength(1)
      expect(json.requests[0]).toMatchObject({ receivedAt: '2026-09-07T08:00:00.000Z', localDate: '2026-09-07',
        trailingSevenDates: ['2026-09-01', '2026-09-07'], timezone: 'Asia/Shanghai', timezoneSource: 'request_record' })
      controls.push(JSON.stringify(json))
      throw new Error('fixture stop after actual next-decision inspection')
    })
    const execute = vi.fn()
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never, now: () => now })
    try {
      await agent.submit(session.summary.id, { content: request, timezone: 'Asia/Shanghai' })
      await vi.waitFor(() => expect(agent.isRunning(session.summary.id)).toBe(false))
      const start = (await store.events(session.summary.id)).find((event) => event.type === 'turn.started')!
      expect(start.data).toMatchObject({ content: request, requestReceivedAt: '2026-09-07T08:00:00.000Z', timezone: 'Asia/Shanghai' })
      // Current clock, session timezone and checkpoint narration all changed;
      // the original durable request still owns its relative date window.
      now = new Date('2026-09-10T08:00:00Z')
      await store.update(session.summary.id, (state) => {
        state.messages = [{ role: 'user', content: 'Historical checkpoint: today is 1900-01-01.' }]
        state.timezone = 'America/Los_Angeles'
      })
      await agent.resume(session.summary.id)
      await vi.waitFor(() => expect(agent.isRunning(session.summary.id)).toBe(false))
      expect(controls).toHaveLength(2)
      expect(controls[1]).toBe(controls[0])
      expect(stream).toHaveBeenCalledTimes(2)
      expect(execute).not.toHaveBeenCalled()
      expect((await store.events(session.summary.id)).filter((event) => event.type === 'turn.started')).toHaveLength(1)
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  })
})
