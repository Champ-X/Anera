import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../server/session-store.js'
import {
  advanceVisualRunningFixture,
  advanceVisualWorkspacePersistenceSaved,
  advanceVisualWorkspacePersistenceSaving,
  advanceVisualWorkspacePersistenceScanning,
  advanceVisualWorkspacePersistenceUploading,
  completeVisualWorkspacePersistenceFixture,
  seedVisualFixtureSessions,
  seedVisualRunningFixture,
  seedVisualWritingFixture,
  seedVisualWorkspacePersistenceFixture,
} from './ui-visual-fixture.js'

describe('deterministic UI visual fixture', () => {
  it('seeds ten lifecycle, structured HITL, both feedback variants, free-credit, and coding projections without a model call', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-ui-fixture-test-'))
    try {
      const store = new SessionStore(root, 'fixture-model')
      await store.initialize()
      const sessions = await seedVisualFixtureSessions(store)
      expect((await store.list()).map((session) => session.title)).toEqual([
        'Visual Complete',
        'Visual Task Completion',
        'Visual Task Review',
        'Visual Coding Repository',
        'Visual High Token Usage',
        'Visual Structured Answer',
        'Visual Approval',
        'Visual Timed Out',
        'Visual Free Session',
        'Visual Empty',
      ])
      expect((await store.get(sessions.empty.id)).summary.status).toBe('idle')
      expect((await store.get(sessions.free.id)).summary).toMatchObject({ status: 'idle', isFreeSession: true })
      expect((await store.get(sessions.approval.id)).summary.status).toBe('awaiting_approval')
      expect((await store.get(sessions.hitl.id)).summary.status).toBe('awaiting_user')
      const timedOut = await store.get(sessions.timedOut.id)
      expect(timedOut.summary.status).toBe('timed_out')
      expect(timedOut.plan?.items.map((item) => item.status)).toEqual(['in_progress', 'pending'])
      const highUsage = await store.get(sessions.highUsage.id)
      expect(highUsage.summary.usage.totalTokens).toBe(100_240)
      expect(highUsage.summary.limits).toBeUndefined()
      expect((await store.events(sessions.highUsage.id)).some((event) => event.type === 'session.limit.reached')).toBe(false)
      const completed = await store.get(sessions.completed.id)
      expect(completed.summary.status).toBe('completed')
      expect(completed.artifacts).toHaveLength(7)
      expect(completed.processes).toHaveLength(1)
      expect(completed.deployment).toMatchObject({ status: 'deployed', visibility: 'public', revision: 2, entryPath: 'index.html' })
      expect(completed.plan).toMatchObject({
        version: 3,
        items: [
          { id: 'plan_visual_build', status: 'completed' },
          { id: 'plan_visual_source', status: 'completed' },
          { id: 'plan_visual_verify', status: 'completed' },
        ],
      })
      const types = (await store.events(sessions.completed.id)).map((event) => event.type)
      const calls = (await store.events(sessions.completed.id))
        .filter((event) => event.type === 'tool.started')
        .map((event) => (event.data.call as { name?: string } | undefined)?.name)
      expect(types).toContain('context.compacted')
      expect(types).toContain('tool.failed')
      expect(types).toContain('approval.resolved')
      expect(calls).toEqual(expect.arrayContaining([
        'write_file',
        'web_search',
        'fetch_page',
        'image_search',
        'generate_image',
        'start_process',
      ]))
      for (const legacy of ['create_file', 'web_fetch', 'fetch_media', 'build_and_start']) expect(calls).not.toContain(legacy)
      expect(calls).not.toContain('search_web')
      expect(types.filter((type) => type === 'deployment.updated')).toHaveLength(3)
      expect(types.filter((type) => type === 'plan.updated')).toHaveLength(3)
      expect(types).toContain('assistant.final')
      expect(types).toContain('review.requested')
      expect(types).not.toContain('feedback.updated')
      const review = await store.get(sessions.review.id)
      expect(review.summary.status).toBe('completed')
      expect((await store.events(sessions.review.id)).map((event) => event.type)).toContain('review.requested')
      const taskCompletion = await store.get(sessions.taskCompletion.id)
      expect(taskCompletion.summary).toMatchObject({ status: 'completed', feedbackType: 'task_completion_bar' })
      expect((await store.events(sessions.taskCompletion.id)).find((event) => event.type === 'review.requested')).toMatchObject({
        data: { feedbackType: 'task_completion_bar' },
      })
      expect((await store.events(sessions.taskCompletion.id)).some((event) => event.type === 'task.completion.updated')).toBe(false)
      const coding = await store.get(sessions.coding.id)
      expect(coding.summary).toMatchObject({ productMode: 'coding', codingSessionStatus: 'active' })
      expect(coding.repository).toMatchObject({ fullName: 'arena-labs/harness', baseBranch: 'main' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('seeds an authentic running Thought and advances it to Plan plus streaming Shell output', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-ui-running-fixture-test-'))
    try {
      const store = new SessionStore(root, 'fixture-model')
      await store.initialize()
      const running = await seedVisualRunningFixture(store)
      let state = await store.get(running.id)
      expect(state.summary).toMatchObject({ status: 'running', isFreeSession: true })
      expect((await store.events(running.id)).map((event) => event.type)).toEqual(expect.arrayContaining([
        'turn.started',
        'run.status',
        'assistant.started',
        'assistant.thought.started',
        'assistant.thought.delta',
      ]))

      await advanceVisualRunningFixture(store, running.id)
      state = await store.get(running.id)
      expect(state.summary.status).toBe('running')
      expect(state.plan?.items.map((item) => item.status)).toEqual(['completed', 'in_progress', 'pending'])
      const events = await store.events(running.id)
      expect(events.filter((event) => event.type === 'tool.started').map((event) => (
        event.data.call as { name?: string } | undefined
      )?.name)).toEqual(['update_plan', 'bash'])
      expect(events.filter((event) => event.type === 'tool.output').map((event) => event.data.stream)).toEqual(['stdout', 'stderr'])
      expect(events.some((event) => event.type === 'tool.completed'
        && (event.data.call as { name?: string } | undefined)?.name === 'bash')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('seeds the recorded Arena HTML Writing state as an uncommitted UTF-8 draft', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-ui-writing-fixture-test-'))
    try {
      const store = new SessionStore(root, 'fixture-model')
      await store.initialize()
      const writing = await seedVisualWritingFixture(store)
      const state = await store.get(writing.id)
      const events = await store.events(writing.id)
      const delta = events.find((event) => event.type === 'assistant.tool_call.delta')

      expect(state.summary).toMatchObject({
        title: 'Visual Streaming HTML Write',
        status: 'running',
        workspaceBytes: 0,
      })
      expect(writing).toMatchObject({ path: 'ai-weekly-2026-08-31.html', lineCount: 422 })
      expect(writing.bytes).toBe(Buffer.byteLength(writing.content))
      expect(writing.content).toContain('全球继续加速 Agent 部署')
      expect(delta?.data).toMatchObject({ index: 0, nameDelta: 'write_file' })
      expect(String(delta?.data.argumentsDelta)).toContain('"path":"ai-weekly-2026-08-31.html"')
      expect(String(delta?.data.argumentsDelta)).not.toMatch(/"}$/)
      expect(events.some((event) => event.type === 'tool.started')).toBe(false)
      await expect(stat(resolve(store.workspaceDir(writing.id), writing.path))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves the A02 interleaving with four local-durable phases before terminal Review', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-ui-workspace-persistence-fixture-test-'))
    try {
      const store = new SessionStore(root, 'fixture-model')
      await store.initialize()
      const fixture = await seedVisualWorkspacePersistenceFixture(store)
      const seeded = await store.events(fixture.id)
      expect(seeded.at(-1)).toMatchObject({
        type: 'assistant.final.delta',
        data: { delta: 'The workspace persistence fixture is complete.' },
      })
      expect((await store.get(fixture.id)).summary.status).toBe('running')

      await advanceVisualWorkspacePersistenceScanning(store, fixture.id)
      await advanceVisualWorkspacePersistenceUploading(store, fixture.id)
      await advanceVisualWorkspacePersistenceSaving(store, fixture.id)
      await advanceVisualWorkspacePersistenceSaved(store, fixture)
      await completeVisualWorkspacePersistenceFixture(store, fixture)

      const events = await store.events(fixture.id)
      const persistence = events.filter((event) => event.type.startsWith('workspace.persistence.'))
      expect(persistence.map((event) => event.type)).toEqual([
        'workspace.persistence.started',
        'workspace.persistence.updated',
        'workspace.persistence.updated',
        'workspace.persistence.completed',
      ])
      expect(persistence.map((event) => event.data)).toEqual([
        { phase: 'scanning', label: 'Scanning workspace...', persistenceMode: 'local_durable' },
        { phase: 'uploading', label: 'Uploading 0 workspace blobs...', blobCount: 0, persistenceMode: 'local_durable' },
        { phase: 'saving', label: 'Saving workspace...', persistenceMode: 'local_durable' },
        {
          phase: 'saved',
          label: 'Workspace saved',
          blobCount: 0,
          bytes: fixture.bytes,
          fileCount: fixture.fileCount,
          persistenceMode: 'local_durable',
        },
      ])

      const streamedFinalIndex = events.findIndex((event) => event.type === 'assistant.final.delta')
      const terminalFinalIndex = events.findIndex((event) => event.type === 'assistant.final')
      const reviewIndex = events.findIndex((event) => event.type === 'review.requested')
      const persistenceIndices = persistence.map((event) => events.findIndex((candidate) => candidate.id === event.id))
      expect(streamedFinalIndex).toBeGreaterThanOrEqual(0)
      expect(persistenceIndices.every((index) => index > streamedFinalIndex && index < terminalFinalIndex)).toBe(true)
      expect(terminalFinalIndex).toBeLessThan(reviewIndex)
      expect(events.slice(streamedFinalIndex).map((event) => event.type)).toEqual([
        'assistant.final.delta',
        'workspace.persistence.started',
        'workspace.persistence.updated',
        'workspace.persistence.updated',
        'workspace.persistence.completed',
        'assistant.final',
        'turn.completed',
        'run.status',
        'review.requested',
      ])
      expect(events[reviewIndex].data.messageEventId).toBe(events[terminalFinalIndex].id)
      expect((await store.get(fixture.id)).summary).toMatchObject({
        status: 'completed',
        workspaceBytes: fixture.bytes,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('also preserves the A01 interleaving where Review is visible while Workspace keeps updating', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-ui-workspace-review-interleaving-test-'))
    try {
      const store = new SessionStore(root, 'fixture-model')
      await store.initialize()
      const fixture = await seedVisualWorkspacePersistenceFixture(store, 'Visual Workspace Persistence Interleaved')

      await advanceVisualWorkspacePersistenceScanning(store, fixture.id)
      await completeVisualWorkspacePersistenceFixture(store, fixture)
      await advanceVisualWorkspacePersistenceUploading(store, fixture.id)
      await advanceVisualWorkspacePersistenceSaving(store, fixture.id)
      await advanceVisualWorkspacePersistenceSaved(store, fixture)

      const events = await store.events(fixture.id)
      const finalIndex = events.findIndex((event) => event.type === 'assistant.final')
      const reviewIndex = events.findIndex((event) => event.type === 'review.requested')
      const persistenceIndices = events.flatMap((event, index) => (
        event.type.startsWith('workspace.persistence.') ? [index] : []
      ))
      expect(finalIndex).toBeGreaterThanOrEqual(0)
      expect(persistenceIndices[0]).toBeLessThan(finalIndex)
      expect(finalIndex).toBeLessThan(reviewIndex)
      expect(persistenceIndices).toHaveLength(4)
      expect(persistenceIndices.slice(1).every((index) => index > reviewIndex)).toBe(true)
      expect(events.slice(persistenceIndices[0]).map((event) => event.type)).toEqual([
        'workspace.persistence.started',
        'assistant.final',
        'turn.completed',
        'run.status',
        'review.requested',
        'workspace.persistence.updated',
        'workspace.persistence.updated',
        'workspace.persistence.completed',
      ])
      expect((await store.get(fixture.id)).summary).toMatchObject({
        title: 'Visual Workspace Persistence Interleaved',
        status: 'completed',
        workspaceBytes: fixture.bytes,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
