import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
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
  appendVisualLongThoughtChunk,
  completeVisualLongThoughtFixture,
  completeVisualWorkspacePersistenceFixture,
  seedVisualFixtureSessions,
  seedVisualLongThoughtFixture,
  seedVisualRunningFixture,
  seedVisualWritingFixture,
  seedVisualWorkspacePersistenceFixture,
} from './ui-visual-fixture.js'

describe('deterministic UI visual fixture', () => {
  it('seeds bounded synthetic thoughts, streams two chunks, and completes separate progress with zero provider usage', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-ui-long-thought-fixture-test-'))
    try {
      const store = new SessionStore(root, 'fixture-model')
      await store.initialize()
      const fixture = await seedVisualLongThoughtFixture(store)
      const zeroUsage = {
        promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0,
        modelCalls: 0, modelRequests: 0, toolCalls: 0, estimatedCostUsd: 0,
      }
      expect((await store.get(fixture.id)).summary).toMatchObject({
        title: fixture.title, model: 'synthetic-ui-zero-provider', status: 'running', usage: zeroUsage,
      })
      const seeded = await store.events(fixture.id)
      const prior = seeded.find((event) => event.type === 'assistant.thought.completed')!
      const active = seeded.filter((event) => event.type === 'assistant.thought.started').at(-1)!
      expect(prior.stepId).not.toBe(active.stepId)
      expect(prior.data.text).toContain('Synthetic prior thought')
      expect(seeded.some((event) => event.type === 'assistant.thought.completed' && event.stepId === active.stepId)).toBe(false)
      const initialDelta = seeded.find((event) => event.type === 'assistant.thought.delta')!
      expect(String(initialDelta.data.delta).trimEnd().split('\n')).toHaveLength(24)
      expect(initialDelta.data.visibleProgress).toBeUndefined()
      expect(seeded.at(-1)?.type).toBe('assistant.progress.delta')

      await appendVisualLongThoughtChunk(store, fixture.id, 1)
      await appendVisualLongThoughtChunk(store, fixture.id, 2)
      const streaming = await store.events(fixture.id)
      const thoughtText = streaming.filter((event) => event.type === 'assistant.thought.delta')
        .map((event) => event.data.delta).join('')
      expect(thoughtText.trimEnd().split('\n')).toHaveLength(48)
      expect(thoughtText).toContain('Synthetic chunk 2, line 12')
      expect(Buffer.byteLength(thoughtText)).toBeLessThan(10_000)
      expect(streaming.filter((event) => event.type === 'assistant.thought.completed')).toHaveLength(1)

      await completeVisualLongThoughtFixture(store, fixture.id)
      const completed = await store.events(fixture.id)
      expect(completed.slice(-6).map((event) => event.type)).toEqual([
        'assistant.progress', 'assistant.thought.completed', 'assistant.started', 'assistant.final', 'turn.completed', 'run.status',
      ])
      expect(completed.find((event) => event.type === 'assistant.progress')?.data.content)
        .toBe(seeded.at(-1)?.data.delta)
      expect(completed.filter((event) => event.type === 'assistant.thought.completed').at(-1)?.data.text).toBe(thoughtText)
      expect(completed.find((event) => event.type === 'assistant.final')?.data.content)
        .toBe('Synthetic UI fixture complete. No model or provider was called.')
      expect(completed.find((event) => event.type === 'assistant.final')?.stepId).not.toBe(active.stepId)
      expect(completed.some((event) => event.type.startsWith('tool.') || event.type === 'usage.updated')).toBe(false)
      expect((await store.get(fixture.id)).summary).toMatchObject({ status: 'completed', usage: zeroUsage })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses historical and reopened sessions without changing their state or journal', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-ui-long-thought-ownership-test-'))
    try {
      const store = new SessionStore(root, 'fixture-model')
      await store.initialize()
      const historical = await store.create()
      const owned = await seedVisualLongThoughtFixture(store)
      const reopened = new SessionStore(root, 'fixture-model')
      for (const [targetStore, id] of [[store, historical.summary.id], [reopened, owned.id]] as const) {
        const statePath = resolve(store.sessionDir(id), 'state.json')
        const journalPath = resolve(store.sessionDir(id), 'events.jsonl')
        const before = await Promise.all([readFile(statePath, 'utf8'), readFile(journalPath, 'utf8')])
        await expect(appendVisualLongThoughtChunk(targetStore, id, 1)).rejects.toThrow('not owned')
        await expect(completeVisualLongThoughtFixture(targetStore, id)).rejects.toThrow('not owned')
        expect(await Promise.all([readFile(statePath, 'utf8'), readFile(journalPath, 'utf8')])).toEqual(before)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects skipped, concurrent duplicate, and terminal transitions without extra events', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-ui-long-thought-order-test-'))
    try {
      const store = new SessionStore(root, 'fixture-model')
      await store.initialize()
      const fixture = await seedVisualLongThoughtFixture(store)
      const seeded = await store.events(fixture.id)
      await expect(appendVisualLongThoughtChunk(store, fixture.id, 2)).rejects.toThrow('out of order')
      await expect(completeVisualLongThoughtFixture(store, fixture.id)).rejects.toThrow('out of order')
      expect(await store.events(fixture.id)).toEqual(seeded)
      const concurrent = await Promise.allSettled([
        appendVisualLongThoughtChunk(store, fixture.id, 1),
        appendVisualLongThoughtChunk(store, fixture.id, 1),
      ])
      expect(concurrent.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
      expect(await store.events(fixture.id)).toHaveLength(seeded.length + 1)
      await expect(appendVisualLongThoughtChunk(store, fixture.id, 1)).rejects.toThrow('duplicate')
      await expect(completeVisualLongThoughtFixture(store, fixture.id)).rejects.toThrow('out of order')
      await appendVisualLongThoughtChunk(store, fixture.id, 2)
      await completeVisualLongThoughtFixture(store, fixture.id)
      const completed = await store.events(fixture.id)
      await expect(completeVisualLongThoughtFixture(store, fixture.id)).rejects.toThrow('duplicate')
      await expect(appendVisualLongThoughtChunk(store, fixture.id, 2)).rejects.toThrow('duplicate')
      expect(await store.events(fixture.id)).toEqual(completed)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['journal', 'status', 'usage'] as const)('refuses a fixture whose %s was changed outside its transitions', async (change) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-ui-long-thought-change-test-'))
    try {
      const store = new SessionStore(root, 'fixture-model')
      await store.initialize()
      const fixture = await seedVisualLongThoughtFixture(store)
      if (change === 'journal') await store.append(fixture.id, 'assistant.started', { step: 99 })
      else await store.update(fixture.id, (state) => {
        if (change === 'status') state.summary.status = 'completed'
        else state.summary.usage.modelCalls = 1
      })
      const before = await store.events(fixture.id)
      await expect(appendVisualLongThoughtChunk(store, fixture.id, 1)).rejects.toThrow('changed outside')
      expect(await store.events(fixture.id)).toEqual(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
