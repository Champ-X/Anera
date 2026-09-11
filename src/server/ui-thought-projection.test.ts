import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { applyEventsToSnapshot, projectTimeline, ThoughtRow } from '../client/App.js'
import {
  appendVisualLongThoughtChunk, completeVisualLongThoughtFixture, seedVisualLongThoughtFixture,
} from '../eval/ui-visual-fixture.js'
import type { SessionSnapshot } from '../shared/types.js'
import { SessionStore } from './session-store.js'

/** Actual durable fixture events through the client projection and initial
 * component markup. This does NOT attest browser scroll, motion or real model
 * reasoning; the sample is deliberately synthetic and has zero usage. */
describe('zero-provider long-thought fixture client boundary', () => {
  it('keeps thought/progress distinct across incremental replay and terminal state', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-thought-projection-'))
    try {
      const store = new SessionStore(root, 'synthetic-ui-only')
      await store.initialize()
      const fixture = await seedVisualLongThoughtFixture(store)
      const snapshot = async (): Promise<SessionSnapshot> => {
        const state = await store.get(fixture.id)
        return { session: state.summary, events: await store.events(fixture.id), workspace: [],
          artifacts: state.artifacts, processes: state.processes, plan: state.plan, website: state.website,
          deployment: state.deployment, repository: state.repository }
      }
      let current = await snapshot()
      const initial = projectTimeline(current)
      const thoughts = initial.filter((item) => item.kind === 'thought')
      expect(thoughts).toHaveLength(2)
      expect(thoughts.map((item) => item.running)).toEqual([false, true])
      const active = thoughts[1]
      expect(active.content.split('\n').length).toBeGreaterThan(12)
      const progress = initial.filter((item) => item.kind === 'progress')
      expect(progress.length).toBeGreaterThan(0)
      expect(progress.every((item) => !active.content.includes(item.content))).toBe(true)
      const activeMarkup = renderToStaticMarkup(createElement(ThoughtRow, { item: active }))
      expect(activeMarkup).toContain('aria-expanded="true"')
      expect(activeMarkup).toContain('aria-label="Thinking details"')
      expect(activeMarkup).toContain('tabindex="0"')
      expect(activeMarkup).toContain('aria-label="Thinking in progress"')
      const historicalMarkup = renderToStaticMarkup(createElement(ThoughtRow, { item: thoughts[0] }))
      expect(historicalMarkup).toContain('aria-expanded="false"')
      expect(historicalMarkup).not.toContain('aria-label="Thinking details"')

      for (const index of [1, 2] as const) {
        await appendVisualLongThoughtChunk(store, fixture.id, index)
        const fresh = await snapshot()
        const deltas = fresh.events.filter((event) => event.seq > current.events.at(-1)!.seq)
        const previous = projectTimeline(current).filter((item) => item.kind === 'thought').find((item) => item.running)!
        current = applyEventsToSnapshot(current, deltas)
        expect(projectTimeline(current)).toEqual(projectTimeline(fresh))
        const next = projectTimeline(current).filter((item) => item.kind === 'thought').find((item) => item.running)!
        expect(next.key).toBe(previous.key)
        expect(next.content.startsWith(previous.content)).toBe(true)
        expect(next.content.length).toBeGreaterThan(previous.content.length)
        expect(projectTimeline(current).filter((item) => item.kind === 'thought')).toHaveLength(2)
      }

      await completeVisualLongThoughtFixture(store, fixture.id)
      const final = await snapshot()
      current = applyEventsToSnapshot(current, final.events.filter((event) => event.seq > current.events.at(-1)!.seq))
      const timeline = projectTimeline(current)
      expect(timeline).toEqual(projectTimeline(final))
      expect(timeline.filter((item) => item.kind === 'thought').map((item) => item.running)).toEqual([false, false])
      const settledProgress = timeline.filter((item) => item.kind === 'progress')
      expect(settledProgress).toHaveLength(1)
      expect(settledProgress[0]).toMatchObject({ content: progress[0].content, streaming: false })
      expect(timeline.filter((item) => item.kind === 'final')).toHaveLength(1)
      expect(final.session.usage).toMatchObject({ modelCalls: 0, totalTokens: 0, estimatedCostUsd: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
