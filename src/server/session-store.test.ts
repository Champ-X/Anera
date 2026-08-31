import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactRecord, DeploymentState } from '../shared/types.js'
import {
  createStaticDeploymentSnapshot,
  deploymentSnapshotManifestPath,
} from './deployment.js'
import { SessionStore, type DurablePendingDeployment, type DurablePendingTerminal } from './session-store.js'
import { applyWorkspacePatch } from './workspace-patch.js'
import { workspaceFileSnapshot } from './workspace.js'

const roots: string[] = []

function deploymentCheckpoint(
  sessionId: string,
  previous: DeploymentState,
  overrides: Partial<DurablePendingDeployment> = {},
): DurablePendingDeployment {
  const createdAt = previous.createdAt ?? '2026-08-29T00:00:00.000Z'
  const deploymentId = previous.id ?? 'dep_checkpoint000000001'
  const revision = previous.revision + 1
  return {
    id: `dpc_checkpoint${String(revision).padStart(9, '0')}`,
    deploymentId,
    revision,
    previous,
    deploying: {
      ...previous,
      id: deploymentId,
      status: 'deploying',
      createdAt,
      updatedAt: '2026-08-29T00:00:01.000Z',
    },
    url: `http://127.0.0.1:4173/deployments/${sessionId}/`,
    visibility: 'local',
    createdAt,
    successAction: previous.revision > 0 ? 'redeployed' : 'deployed',
    phase: 'snapshotting',
    deployingEventId: `evt_deploying${String(revision).padStart(9, '0')}`,
    completionEventId: `evt_deployed${String(revision).padStart(9, '0')}`,
    context: {
      turnId: `turn_deploy${revision}`,
      stepId: `step_deploy${revision}`,
      callId: `call_deploy${revision}`,
    },
    ...overrides,
  }
}

function artifactRecord(sessionId: string, path: string, id: string, createdAt = '2026-08-29T00:00:01.000Z'): ArtifactRecord {
  return {
    id,
    sessionId,
    path,
    name: path.split('/').at(-1) || path,
    kind: 'file',
    mime: 'text/plain',
    createdAt,
    previewUrl: `/workspace/${sessionId}/file?path=${encodeURIComponent(path)}`,
    downloadUrl: `/api/sessions/${sessionId}/download?path=${encodeURIComponent(path)}`,
  }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('session store', () => {
  it('treats only a missing event log as empty and surfaces other read failures', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-event-read-errors-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const eventPath = resolve(store.sessionDir(session.summary.id), 'events.jsonl')
    await rm(eventPath)
    await expect(store.events(session.summary.id)).resolves.toEqual([])
    await mkdir(eventPath)
    await expect(store.events(session.summary.id)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('materializes honest empty model-accounting defaults for new and legacy sessions', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-usage-schema-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    expect(session.summary.usage).toMatchObject({
      modelRequests: 0,
      modelCalls: 0,
      estimatedCostUsd: 0,
      estimatedCostStatus: 'not_incurred',
    })

    const statePath = resolve(store.sessionDir(session.summary.id), 'state.json')
    const legacy = JSON.parse(await readFile(statePath, 'utf8')) as {
      summary: { usage: Record<string, unknown> }
    }
    legacy.summary.usage.modelCalls = 2
    legacy.summary.usage.estimatedCostUsd = 0.01
    delete legacy.summary.usage.modelRequests
    delete legacy.summary.usage.estimatedCostStatus
    await writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')

    expect((await store.get(session.summary.id)).summary.usage).toMatchObject({
      modelRequests: 2,
      modelCalls: 2,
      estimatedCostUsd: 0.01,
      estimatedCostStatus: 'estimated',
    })
  })

  it('projects safe Coding prompt defaults for repositories persisted before branch metadata existed', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-coding-prompt-migration-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create({
      repository: {
        provider: 'github',
        repoId: 17,
        fullName: 'arena-labs/harness',
        ownerLogin: 'arena-labs',
        name: 'harness',
        baseBranch: 'main',
        baseCommitSha: 'a'.repeat(40),
        private: true,
        importedAt: '2026-08-30T00:00:00.000Z',
      },
    })
    const loaded = await store.get(session.summary.id)
    expect(loaded.summary).toMatchObject({ productMode: 'coding', codingSessionStatus: 'active' })
    expect(loaded.repository).toMatchObject({ arenaBranch: 'main', cwd: '/home/user' })
  })

  it('settles one durable HITL response exactly once under concurrent replay', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-hitl-once-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await store.setStatus(session.summary.id, 'running')
    await store.stageHitl(session.summary.id, {
      id: 'hitl_once000000000001',
      kind: 'ask_user',
      call: { id: 'call_hitl_once', name: 'ask_user', arguments: { questions: [] } },
      title: 'Choose once',
      payload: { questions: [] },
      turnId: 'turn_hitl_once',
      stepId: 'step_hitl_once',
      callId: 'call_hitl_once',
      createdAt: '2026-08-29T00:00:00.000Z',
    })

    const results = await Promise.all([
      store.settleHitl(session.summary.id, 'hitl_once000000000001', { status: 'answered', marker: 'first' }),
      store.settleHitl(session.summary.id, 'hitl_once000000000001', { status: 'answered', marker: 'second' }),
    ])
    expect(results.map((result) => result.appended).sort()).toEqual([false, true])
    expect(new Set(results.map((result) => result.event.id)).size).toBe(1)
    const settledEvents = (await store.events(session.summary.id)).filter((event) => event.type === 'hitl.resolved')
    expect(settledEvents).toHaveLength(1)
    expect(['first', 'second']).toContain((settledEvents[0].data.response as { marker: string }).marker)
    expect((await store.get(session.summary.id))).toMatchObject({ summary: { status: 'running' } })
    expect((await store.get(session.summary.id)).pendingHitl).toBeUndefined()
  })

  it('atomically allocates unique voice ids across HITL cards while preserving same-card first-writer replay', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-hitl-voice-id-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await store.setStatus(session.summary.id, 'running')
    const pending = [0, 1].map((index) => ({
      id: `hitl_voice_atomic_${index}`,
      kind: 'add_voice' as const,
      call: {
        id: `call_voice_atomic_${index}`,
        name: 'add_voice',
        arguments: { language: index === 0 ? 'en-US' : 'zh-CN', text: `Voice ${index}`, voice_identity: { index } },
      },
      title: 'Choose a voice',
      payload: { candidates: [{ id: `candidate_${index}_a` }, { id: `candidate_${index}_b` }] },
      turnId: 'turn_voice_atomic',
      stepId: 'step_voice_atomic',
      callId: `call_voice_atomic_${index}`,
      callIndex: index,
      createdAt: '2026-08-30T00:00:00.000Z',
      requiredEventId: `evt_voice_atomic_required_${index}`,
      phase: 'awaiting_response' as const,
    }))
    await Promise.all(pending.map((entry) => store.stageHitl(session.summary.id, entry)))

    const [first, replay, second] = await Promise.all([
      store.settleHitl(session.summary.id, pending[0].id, { candidate_id: 'candidate_0_a', marker: 'first' }),
      store.settleHitl(session.summary.id, pending[0].id, { candidate_id: 'candidate_0_b', marker: 'second' }),
      store.settleHitl(session.summary.id, pending[1].id, { candidate_id: 'candidate_1_a' }),
    ])
    expect([first.appended, replay.appended].sort()).toEqual([false, true])
    expect(first.event.id).toBe(replay.event.id)
    expect(first.event.data.response).toEqual(replay.event.data.response)
    expect(first.event.data.response).toMatchObject({
      candidate_id: 'candidate_0_a',
      marker: 'first',
      voice_id: 'voice-00',
    })
    expect(second.event.data.response).toMatchObject({ candidate_id: 'candidate_1_a', voice_id: 'voice-01' })

    const state = await store.get(session.summary.id)
    expect(state.nextVoiceIndex).toBe(2)
    expect([state.pendingHitl?.[pending[0].id].response, state.pendingHitl?.[pending[1].id].response])
      .toEqual([first.event.data.response, second.event.data.response])
    const resolved = (await store.events(session.summary.id)).filter((event) => event.type === 'hitl.resolved')
    expect(resolved).toHaveLength(2)
    expect(new Set(resolved.map((event) => (event.data.response as { voice_id: string }).voice_id)))
      .toEqual(new Set(['voice-00', 'voice-01']))
  })

  it('claims a legacy voice owner only from its matching durable HITL reservation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-legacy-voice-owner-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await store.update(session.summary.id, (state) => {
      state.voices = {
        'voice-00': {
          providerVoice: 'alloy',
          language: 'en-US',
          createdAt: '2026-08-29T00:00:00.000Z',
        },
      }
    })
    await store.stageHitl(session.summary.id, {
      id: 'hitl_voice_legacy_owner',
      kind: 'add_voice',
      call: {
        id: 'call_voice_legacy_owner',
        name: 'add_voice',
        arguments: { language: 'en-US', text: 'Legacy voice', voice_identity: { index: 0 } },
      },
      title: 'Choose a voice',
      payload: { candidates: [{ id: 'legacy_candidate' }] },
      turnId: 'turn_voice_legacy_owner',
      stepId: 'step_voice_legacy_owner',
      callId: 'call_voice_legacy_owner',
      createdAt: '2026-08-30T00:00:00.000Z',
      requiredEventId: 'evt_voice_legacy_owner',
      resolvedEventId: 'evt_voice_legacy_resolved',
      phase: 'executing',
      response: { candidate_id: 'legacy_candidate', voice_id: 'voice-00' },
    })

    await expect(store.commitVoiceSelection(session.summary.id, {
      voiceId: 'voice-00',
      providerVoice: 'alloy',
      language: 'en-US',
      callId: 'call_voice_legacy_owner',
    })).resolves.toMatchObject({
      voiceId: 'voice-00',
      voice: { sourceCallId: 'call_voice_legacy_owner' },
    })
    await expect(store.commitVoiceSelection(session.summary.id, {
      voiceId: 'voice-00',
      providerVoice: 'alloy',
      language: 'en-US',
      callId: 'call_voice_unrelated',
    })).rejects.toThrow('Voice voice-00 is reserved by a different add_voice selection')
    expect((await store.get(session.summary.id)).voices?.['voice-00']).toMatchObject({
      providerVoice: 'alloy', language: 'en-US', sourceCallId: 'call_voice_legacy_owner',
    })
  })

  it('expires pending HITL once and interrupts the abandoned episode after restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-hitl-restart-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await first.setStatus(session.summary.id, 'running')
    const pending = {
      id: 'hitl_restart000000001',
      kind: 'propose_plan' as const,
      call: { id: 'call_hitl_restart', name: 'propose_plan', arguments: { path: 'plans/task.md', highlights: ['One'] } },
      title: 'Review plan',
      payload: { path: 'plans/task.md', highlights: ['One'] },
      turnId: 'turn_hitl_restart',
      stepId: 'step_hitl_restart',
      callId: 'call_hitl_restart',
      createdAt: '2026-08-29T00:00:00.000Z',
    }
    await first.stageHitl(session.summary.id, pending)
    await first.append(session.summary.id, 'hitl.required', {
      hitlId: pending.id,
      kind: pending.kind,
      call: pending.call,
      title: pending.title,
      payload: pending.payload,
    }, { turnId: pending.turnId, stepId: pending.stepId, callId: pending.callId })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.summary.status).toBe('interrupted')
    expect(recovered.pendingHitl).toBeUndefined()
    expect((await restarted.events(session.summary.id)).filter((event) => event.type === 'hitl.expired')).toEqual([
      expect.objectContaining({
        turnId: pending.turnId,
        stepId: pending.stepId,
        callId: pending.callId,
        data: { hitlId: pending.id, kind: pending.kind, decision: 'expired', reason: 'server_restarted' },
      }),
    ])

    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id)).filter((event) => event.type === 'hitl.expired')).toHaveLength(1)
  })
  it('persists append-only events with monotonic sequence numbers', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await Promise.all([
      store.append(session.summary.id, 'assistant.started', { index: 1 }),
      store.append(session.summary.id, 'assistant.started', { index: 2 }),
      store.append(session.summary.id, 'assistant.started', { index: 3 }),
    ])
    const events = await store.events(session.summary.id)
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(events[0].type).toBe('session.created')
  })

  it('idempotently appends a preallocated event id under concurrent replay', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const observed: string[] = []
    store.subscribe(session.summary.id, (event) => observed.push(event.id))

    const [first, replay] = await Promise.all([
      store.append(session.summary.id, 'usage.updated', { source: 'agent' }, { eventId: 'evt_preallocated_usage' }),
      store.append(session.summary.id, 'usage.updated', { source: 'agent' }, { eventId: 'evt_preallocated_usage' }),
    ])

    expect(replay).toEqual(first)
    expect((await store.events(session.summary.id)).filter((event) => event.id === first.id)).toHaveLength(1)
    expect(observed).toEqual(['evt_preallocated_usage'])
    await expect(store.append(
      session.summary.id,
      'session.limit.reached',
      { code: 'session_token_limit' },
      { eventId: 'evt_preallocated_usage' },
    )).rejects.toThrow(/already used by usage\.updated/)
  })

  it('repairs a torn JSONL tail before appending new durable events', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await first.append(session.summary.id, 'assistant.started', { index: 1 })
    const eventPath = resolve(first.sessionDir(session.summary.id), 'events.jsonl')
    await appendFile(eventPath, '{"id":"evt_torn","sessionId":', 'utf8')

    expect((await first.events(session.summary.id)).map((event) => event.seq)).toEqual([1, 2])
    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const appended = await restarted.append(session.summary.id, 'assistant.started', { index: 2 })
    expect(appended.seq).toBe(3)
    expect((await restarted.events(session.summary.id)).map((event) => event.seq)).toEqual([1, 2, 3])
    const repaired = await readFile(eventPath, 'utf8')
    expect(repaired).not.toContain('evt_torn')
    expect(repaired.endsWith('\n')).toBe(true)
    expect(repaired.trim().split('\n').every((line) => Boolean(JSON.parse(line)))).toBe(true)
  })

  it('reconstructs session.created when creation crashes after state materialization but before append', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-pending-creation-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    vi.spyOn(first, 'append').mockRejectedValueOnce(new Error('simulated crash before session.created append'))
    await expect(first.create()).rejects.toThrow('simulated crash')

    const sessionIds = (await readdir(resolve(root, 'sessions'))).filter((name) => name.startsWith('ses_'))
    expect(sessionIds).toHaveLength(1)
    const sessionId = sessionIds[0]
    const before = JSON.parse(await readFile(resolve(first.sessionDir(sessionId), 'state.json'), 'utf8')) as {
      pendingCreation?: { eventId: string; eventData: Record<string, unknown> }
    }
    expect(before.pendingCreation?.eventId).toMatch(/^evt_/)

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(sessionId)
    expect(recovered.pendingCreation).toBeUndefined()
    const events = await restarted.events(sessionId)
    expect(events.filter((event) => event.id === before.pendingCreation?.eventId)).toEqual([
      expect.objectContaining({ type: 'session.created', data: before.pendingCreation?.eventData }),
    ])
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        recoveredSessionCreation: {
          eventId: before.pendingCreation?.eventId,
          reconstructedEvent: true,
          legacyStateOnly: false,
        },
      },
    })
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(sessionId))).toHaveLength(eventCount)
  })

  it('clears an already-published Session creation checkpoint without duplicating its event', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-published-creation-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const createdEvent = (await first.events(session.summary.id)).find((event) => event.type === 'session.created')
    expect(createdEvent).toBeDefined()
    await first.update(session.summary.id, (state) => {
      state.pendingCreation = {
        eventId: String(createdEvent?.id),
        eventData: createdEvent?.data ?? {},
        createdAt: state.summary.createdAt,
      }
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).pendingCreation).toBeUndefined()
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === createdEvent?.id)).toHaveLength(1)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        recoveredSessionCreation: {
          eventId: createdEvent?.id,
          reconstructedEvent: false,
          legacyStateOnly: false,
        },
      },
    })
  })

  it('reconstructs one legacy state-only session.created boundary', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-legacy-creation-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await writeFile(resolve(first.sessionDir(session.summary.id), 'events.jsonl'), '', 'utf8')

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'session.created')).toEqual([
      expect.objectContaining({
        data: {
          title: session.summary.title,
          productMode: session.summary.productMode,
          repository: null,
          isFreeSession: false,
          feedbackType: 'check_in',
        },
      }),
    ])
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        recoveredSessionCreation: {
          reconstructedEvent: true,
          legacyStateOnly: true,
        },
      },
    })
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('publishes a verified pending upload after a crash before file.changed append', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-pending-upload-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    vi.spyOn(first, 'append').mockRejectedValueOnce(new Error('simulated crash before upload event'))
    await expect(first.createUpload(
      session.summary.id,
      'uploads/evidence.txt',
      Buffer.from('durable upload\n'),
      'text/plain',
    )).rejects.toThrow('simulated crash')

    const before = await first.get(session.summary.id)
    const pending = Object.values(before.pendingUploads ?? {})[0]
    expect(pending).toMatchObject({
      path: 'uploads/evidence.txt',
      bytes: 15,
      mime: 'text/plain',
    })
    expect(await readFile(resolve(first.workspaceDir(session.summary.id), pending.path), 'utf8')).toBe('durable upload\n')
    expect((await first.events(session.summary.id)).some((event) => event.id === pending.eventId)).toBe(false)

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.pendingUploads).toBeUndefined()
    expect(recovered.summary.workspaceBytes).toBe(15)
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === pending.eventId)).toEqual([
      expect.objectContaining({
        type: 'file.changed',
        data: {
          path: pending.path,
          bytes: 15,
          operation: 'uploaded',
          mime: 'text/plain',
        },
      }),
    ])
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        uploadReconciliation: {
          checkpoints: [{
            id: pending.id,
            path: pending.path,
            eventId: pending.eventId,
            result: 'published',
            reconstructedEvent: true,
            reassignedPath: false,
          }],
        },
      },
    })
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('clears an upload checkpoint whose preallocated file.changed event was already appended', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-published-upload-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const append = first.append.bind(first)
    vi.spyOn(first, 'append').mockImplementationOnce(async (id, type, data, context) => {
      await append(id, type, data, context)
      throw new Error('simulated crash after upload event')
    })
    await expect(first.createUpload(
      session.summary.id,
      'uploads/published.txt',
      Buffer.from('event durable\n'),
      'text/plain',
    )).rejects.toThrow('simulated crash')

    const pending = Object.values((await first.get(session.summary.id)).pendingUploads ?? {})[0]
    expect((await first.events(session.summary.id)).filter((event) => event.id === pending.eventId)).toHaveLength(1)
    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).pendingUploads).toBeUndefined()
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === pending.eventId)).toHaveLength(1)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        uploadReconciliation: {
          checkpoints: [{
            id: pending.id,
            result: 'already_published',
            reconstructedEvent: false,
          }],
        },
      },
    })
  })

  it('publishes a verified pending workspace write after a crash before file.changed append', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-pending-workspace-write-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const artifact = artifactRecord(session.summary.id, 'durable.txt', 'art_durable_write')
    vi.spyOn(first, 'append').mockRejectedValueOnce(new Error('simulated crash before workspace event'))
    await expect(first.commitWorkspaceWrite(session.summary.id, {
      path: 'durable.txt',
      content: 'durable mutation\n',
      mode: 'create',
      operation: 'created',
      artifact,
      context: { turnId: 'turn_write', stepId: 'step_write', callId: 'call_write' },
    })).rejects.toThrow('simulated crash')

    const before = await first.get(session.summary.id)
    const pending = Object.values(before.pendingWorkspaceMutations ?? {})[0]
    expect(pending).toMatchObject({ kind: 'write', mode: 'create', path: 'durable.txt', bytes: 17 })
    expect(await readFile(resolve(first.workspaceDir(session.summary.id), 'durable.txt'), 'utf8')).toBe('durable mutation\n')
    expect(before.summary.workspaceBytes).toBe(0)

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.pendingWorkspaceMutations).toBeUndefined()
    expect(recovered.summary.workspaceBytes).toBe(17)
    expect(recovered.artifacts).toEqual([artifact])
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === pending.fileEventId)).toEqual([
      expect.objectContaining({
        type: 'file.changed',
        turnId: 'turn_write',
        stepId: 'step_write',
        callId: 'call_write',
        data: {
          path: 'durable.txt',
          bytes: 17,
          operation: 'created',
          artifact,
          artifactEventId: pending.artifactEventId,
        },
      }),
    ])
    expect(events.filter((event) => event.id === pending.artifactEventId)).toEqual([
      expect.objectContaining({ type: 'artifact.created', data: { artifact } }),
    ])
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        workspaceMutationReconciliation: {
          checkpoints: [{
            id: pending.id,
            kind: 'write',
            path: 'durable.txt',
            result: 'published',
            reconstructedFileEvent: true,
            reconstructedArtifactEvent: true,
          }],
        },
      },
    })
    await expect(readFile(resolve(restarted.sessionDir(session.summary.id), pending.temporaryPath))).rejects.toMatchObject({ code: 'ENOENT' })
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('finishes an Artifact boundary when file.changed was durable before a workspace-write crash', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-published-workspace-write-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const artifact = artifactRecord(session.summary.id, 'published.txt', 'art_published_write')
    const append = first.append.bind(first)
    vi.spyOn(first, 'append').mockImplementationOnce(async (id, type, data, context) => {
      await append(id, type, data, context)
      throw new Error('simulated crash after workspace event')
    })
    await expect(first.commitWorkspaceWrite(session.summary.id, {
      path: 'published.txt',
      content: 'published\n',
      mode: 'create',
      operation: 'created',
      artifact,
    })).rejects.toThrow('simulated crash')

    const pending = Object.values((await first.get(session.summary.id)).pendingWorkspaceMutations ?? {})[0]
    expect((await first.events(session.summary.id)).filter((event) => event.id === pending.fileEventId)).toHaveLength(1)
    expect((await first.events(session.summary.id)).filter((event) => event.id === pending.artifactEventId)).toHaveLength(0)
    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === pending.fileEventId)).toHaveLength(1)
    expect(events.filter((event) => event.id === pending.artifactEventId)).toHaveLength(1)
    expect((await restarted.get(session.summary.id)).artifacts).toEqual([artifact])
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        workspaceMutationReconciliation: {
          checkpoints: [{
            id: pending.id,
            result: 'already_published',
            reconstructedFileEvent: false,
            reconstructedArtifactEvent: true,
          }],
        },
      },
    })
  })

  it('publishes pending file and Artifact removal after a delete crash', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-pending-workspace-delete-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const artifact = artifactRecord(session.summary.id, 'delete-me.txt', 'art_delete_me')
    await first.commitWorkspaceWrite(session.summary.id, {
      path: 'delete-me.txt',
      content: 'remove me\n',
      mode: 'create',
      operation: 'created',
      artifact,
    })
    vi.spyOn(first, 'append').mockRejectedValueOnce(new Error('simulated crash before delete event'))
    await expect(first.commitWorkspaceDelete(session.summary.id, {
      path: 'delete-me.txt',
      operation: 'deleted',
      context: { turnId: 'turn_delete', stepId: 'step_delete', callId: 'call_delete' },
    })).rejects.toThrow('simulated crash')
    const pending = Object.values((await first.get(session.summary.id)).pendingWorkspaceMutations ?? {})[0]
    await expect(readFile(resolve(first.workspaceDir(session.summary.id), 'delete-me.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.pendingWorkspaceMutations).toBeUndefined()
    expect(recovered.summary.workspaceBytes).toBe(0)
    expect(recovered.artifacts).toEqual([])
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === pending.fileEventId)).toEqual([
      expect.objectContaining({
        type: 'file.changed',
        turnId: 'turn_delete',
        data: {
          path: 'delete-me.txt',
          bytes: 0,
          operation: 'deleted',
          artifact,
          artifactEventId: pending.artifactEventId,
        },
      }),
    ])
    expect(events.filter((event) => event.id === pending.artifactEventId)).toEqual([
      expect.objectContaining({ type: 'artifact.removed', data: { artifact, path: 'delete-me.txt' } }),
    ])
  })

  it('abandons a pending create rather than overwriting a conflicting final file', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-workspace-create-conflict-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const mutationId = 'wmut_0123456789abcdef0123'
    const staged = Buffer.from('checkpoint bytes\n')
    const stagingDirectory = first.workspaceMutationStagingDir(session.summary.id)
    await mkdir(stagingDirectory, { recursive: true })
    await writeFile(resolve(stagingDirectory, `${mutationId}.part`), staged)
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'conflict.txt'), 'external winner\n')
    const artifact = artifactRecord(session.summary.id, 'conflict.txt', 'art_conflicting_create')
    await first.update(session.summary.id, (state) => {
      state.pendingWorkspaceMutations = {
        [mutationId]: {
          id: mutationId,
          kind: 'write',
          mode: 'create',
          path: 'conflict.txt',
          operation: 'created',
          bytes: staged.length,
          sha256: createHash('sha256').update(staged).digest('hex'),
          temporaryPath: `workspace-mutation-staging/${mutationId}.part`,
          installPath: `workspace-mutation-staging/${mutationId}.install`,
          artifact,
          fileEventId: 'evt_11111111111111111111',
          artifactEventId: 'evt_22222222222222222222',
          context: {},
          createdAt: '2026-08-29T00:00:00.000Z',
        },
      }
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect(await readFile(resolve(restarted.workspaceDir(session.summary.id), 'conflict.txt'), 'utf8')).toBe('external winner\n')
    expect((await restarted.get(session.summary.id)).pendingWorkspaceMutations).toBeUndefined()
    const events = await restarted.events(session.summary.id)
    expect(events.some((event) => event.id === 'evt_11111111111111111111')).toBe(false)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        workspaceMutationReconciliation: {
          checkpoints: [{ id: mutationId, result: 'abandoned', reason: 'create_conflict' }],
        },
      },
    })
    await expect(readFile(resolve(stagingDirectory, `${mutationId}.part`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('abandons corrupt staging and removes unreferenced workspace-mutation residue', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-workspace-corrupt-staging-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const mutationId = 'wmut_abcdef0123456789abcd'
    const expected = Buffer.from('expected bytes\n')
    const stagingDirectory = first.workspaceMutationStagingDir(session.summary.id)
    await mkdir(stagingDirectory, { recursive: true })
    await writeFile(resolve(stagingDirectory, `${mutationId}.part`), 'corrupt')
    await writeFile(resolve(stagingDirectory, 'wmut_99999999999999999999.part'), 'orphan part')
    await writeFile(resolve(stagingDirectory, 'wmut_99999999999999999999.install'), 'orphan install')
    const artifact = artifactRecord(session.summary.id, 'missing.txt', 'art_missing_staging')
    await first.update(session.summary.id, (state) => {
      state.pendingWorkspaceMutations = {
        [mutationId]: {
          id: mutationId,
          kind: 'write',
          mode: 'create',
          path: 'missing.txt',
          operation: 'created',
          bytes: expected.length,
          sha256: createHash('sha256').update(expected).digest('hex'),
          temporaryPath: `workspace-mutation-staging/${mutationId}.part`,
          installPath: `workspace-mutation-staging/${mutationId}.install`,
          artifact,
          fileEventId: 'evt_33333333333333333333',
          artifactEventId: 'evt_44444444444444444444',
          context: {},
          createdAt: '2026-08-29T00:00:00.000Z',
        },
      }
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    await expect(readFile(resolve(restarted.workspaceDir(session.summary.id), 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await restarted.get(session.summary.id)).pendingWorkspaceMutations).toBeUndefined()
    expect(await readdir(stagingDirectory)).toEqual([])
    const events = await restarted.events(session.summary.id)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        workspaceMutationReconciliation: {
          orphanTemporaryFilesRemoved: 2,
          checkpoints: [{ id: mutationId, result: 'abandoned', reason: 'missing_or_corrupt_staging' }],
        },
      },
    })
  })

  it('publishes a complete multi-file workspace event batch after all post-images commit', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-workspace-event-batch-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const workspace = first.workspaceDir(session.summary.id)
    const updated = Buffer.from('updated after patch\n')
    const added = Buffer.from('added after patch\n')
    const removedArtifact = artifactRecord(session.summary.id, 'removed.txt', 'art_batch_removed')
    const updatedArtifact = artifactRecord(session.summary.id, 'updated.txt', 'art_batch_updated')
    const addedArtifact = artifactRecord(session.summary.id, 'added.txt', 'art_batch_added')
    await writeFile(resolve(workspace, 'updated.txt'), 'updated before patch\n')
    await writeFile(resolve(workspace, 'removed.txt'), 'remove before patch\n')
    await first.update(session.summary.id, (state) => { state.artifacts = [removedArtifact] })
    const batchId = await first.stageWorkspaceEventBatch(session.summary.id, {
      source: 'apply_patch',
      changes: [
        {
          path: 'updated.txt',
          operation: 'patched',
          bytes: updated.length,
          expected: 'present',
          sha256: createHash('sha256').update(updated).digest('hex'),
          artifact: updatedArtifact,
        },
        {
          path: 'added.txt',
          operation: 'patch-added',
          bytes: added.length,
          expected: 'present',
          sha256: createHash('sha256').update(added).digest('hex'),
          artifact: addedArtifact,
        },
        {
          path: 'removed.txt',
          operation: 'patch-deleted',
          bytes: 0,
          expected: 'missing',
          artifact: removedArtifact,
        },
      ],
      context: { turnId: 'turn_patch', stepId: 'step_patch', callId: 'call_patch' },
    })
    const pending = (await first.get(session.summary.id)).pendingWorkspaceEventBatches?.[batchId]
    expect(pending?.changes).toHaveLength(3)
    await writeFile(resolve(workspace, 'updated.txt'), updated)
    await writeFile(resolve(workspace, 'added.txt'), added)
    await rm(resolve(workspace, 'removed.txt'), { force: true })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.pendingWorkspaceEventBatches).toBeUndefined()
    expect(recovered.summary.workspaceBytes).toBe(updated.length + added.length)
    expect(recovered.artifacts.map((artifact) => artifact.path)).toEqual(['updated.txt', 'added.txt'])
    const events = await restarted.events(session.summary.id)
    for (const change of pending?.changes ?? []) {
      expect(events.filter((event) => event.id === change.fileEventId)).toHaveLength(1)
      if (change.artifactEventId) expect(events.filter((event) => event.id === change.artifactEventId)).toHaveLength(1)
    }
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        workspaceEventBatchReconciliation: {
          batches: [{
            id: batchId,
            source: 'apply_patch',
            result: 'published',
            changeCount: 3,
            reconstructedFileEvents: 3,
            reconstructedArtifactEvents: 3,
          }],
        },
      },
    })
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('resumes a partially published workspace event batch without duplicating its prefix', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-partial-workspace-event-batch-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const one = Buffer.from('one\n')
    const two = Buffer.from('two\n')
    const oneArtifact = artifactRecord(session.summary.id, 'one.txt', 'art_batch_one')
    const twoArtifact = artifactRecord(session.summary.id, 'two.txt', 'art_batch_two')
    const batchId = await first.stageWorkspaceEventBatch(session.summary.id, {
      source: 'apply_patch',
      changes: [
        { path: 'one.txt', operation: 'patch-added', bytes: one.length, expected: 'present', sha256: createHash('sha256').update(one).digest('hex'), artifact: oneArtifact },
        { path: 'two.txt', operation: 'patch-added', bytes: two.length, expected: 'present', sha256: createHash('sha256').update(two).digest('hex'), artifact: twoArtifact },
      ],
    })
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'one.txt'), one)
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'two.txt'), two)
    const pending = (await first.get(session.summary.id)).pendingWorkspaceEventBatches?.[batchId]
    const append = first.append.bind(first)
    let appendCount = 0
    vi.spyOn(first, 'append').mockImplementation(async (id, type, data, context) => {
      appendCount += 1
      const event = await append(id, type, data, context)
      if (appendCount === 3) throw new Error('simulated crash in workspace event batch')
      return event
    })
    await expect(first.publishWorkspaceEventBatch(session.summary.id, batchId)).rejects.toThrow('simulated crash')
    expect((await first.events(session.summary.id)).filter((event) => (
      pending?.changes.some((change) => event.id === change.fileEventId || event.id === change.artifactEventId)
    ))).toHaveLength(3)

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const events = await restarted.events(session.summary.id)
    for (const change of pending?.changes ?? []) {
      expect(events.filter((event) => event.id === change.fileEventId)).toHaveLength(1)
      expect(events.filter((event) => event.id === change.artifactEventId)).toHaveLength(1)
    }
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        workspaceEventBatchReconciliation: {
          batches: [{
            id: batchId,
            result: 'already_publishing',
            reconstructedFileEvents: 0,
            reconstructedArtifactEvents: 1,
          }],
        },
      },
    })
  })

  it('abandons an unpublished workspace event batch when its atomic operation rolled back', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-rolled-back-workspace-event-batch-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const expected = Buffer.from('never committed\n')
    const artifact = artifactRecord(session.summary.id, 'rolled-back.txt', 'art_batch_rollback')
    const batchId = await first.stageWorkspaceEventBatch(session.summary.id, {
      source: 'apply_patch',
      changes: [{
        path: 'rolled-back.txt',
        operation: 'patch-added',
        bytes: expected.length,
        expected: 'present',
        sha256: createHash('sha256').update(expected).digest('hex'),
        artifact,
      }],
    })
    const pending = (await first.get(session.summary.id)).pendingWorkspaceEventBatches?.[batchId]

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).pendingWorkspaceEventBatches).toBeUndefined()
    const events = await restarted.events(session.summary.id)
    expect(events.some((event) => event.id === pending?.changes[0]?.fileEventId)).toBe(false)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        workspaceEventBatchReconciliation: {
          batches: [{ id: batchId, result: 'abandoned', reason: 'post_image_mismatch' }],
        },
      },
    })
  })

  it('reconciles Shell side effects from a durable pre-command SHA-256 snapshot after restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-shell-reconciliation-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const workspace = first.workspaceDir(session.summary.id)
    await writeFile(resolve(workspace, 'modified.txt'), 'before modified\n')
    await writeFile(resolve(workspace, 'deleted.txt'), 'before deleted\n')
    const deletedArtifact = artifactRecord(session.summary.id, 'deleted.txt', 'art_shell_deleted')
    await first.update(session.summary.id, (state) => { state.artifacts = [deletedArtifact] })
    const checkpointId = await first.stageShellReconciliation(
      session.summary.id,
      'cmd_0123456789abcdef0123',
      await workspaceFileSnapshot(workspace),
      { turnId: 'turn_shell', stepId: 'step_shell', callId: 'call_shell' },
    )
    await first.armShellReconciliation(session.summary.id, checkpointId, 999_999)
    await writeFile(resolve(workspace, 'modified.txt'), 'after modified\n')
    await writeFile(resolve(workspace, 'created.txt'), 'after created\n')
    await rm(resolve(workspace, 'deleted.txt'), { force: true })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.pendingShellReconciliations).toBeUndefined()
    expect(recovered.pendingWorkspaceEventBatches).toBeUndefined()
    expect(recovered.summary.workspaceBytes).toBe(29)
    expect(recovered.artifacts.map((artifact) => artifact.path)).toEqual(['created.txt', 'modified.txt'])
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'file.changed' && event.callId === 'call_shell').map((event) => event.data)).toEqual([
      expect.objectContaining({ path: 'created.txt', operation: 'created-by-shell', bytes: 14 }),
      expect.objectContaining({ path: 'modified.txt', operation: 'modified-by-shell', bytes: 15 }),
      expect.objectContaining({ path: 'deleted.txt', operation: 'deleted-by-shell', bytes: 0 }),
    ])
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        shellReconciliation: [{
          id: checkpointId,
          guardianId: 'cmd_0123456789abcdef0123',
          guardianTermination: { identity: 'not_found', action: 'already_absent' },
          result: 'published',
          changeCount: 3,
        }],
        workspaceEventBatchReconciliation: {
          batches: [{ source: 'shell', changeCount: 3, reconstructedFileEvents: 3 }],
        },
      },
    })
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('clears a staged Shell checkpoint without fabricating file events when no bytes changed', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-shell-no-change-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'stable.txt'), 'stable\n')
    const checkpointId = await first.stageShellReconciliation(
      session.summary.id,
      'cmd_abcdef0123456789abcd',
      await workspaceFileSnapshot(first.workspaceDir(session.summary.id)),
      { callId: 'call_shell_no_change' },
    )

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const state = await restarted.get(session.summary.id)
    expect(state.pendingShellReconciliations).toBeUndefined()
    expect(state.pendingWorkspaceEventBatches).toBeUndefined()
    expect(state.summary.workspaceBytes).toBe(7)
    const events = await restarted.events(session.summary.id)
    expect(events.some((event) => event.type === 'file.changed' && event.callId === 'call_shell_no_change')).toBe(false)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        shellReconciliation: [{ id: checkpointId, result: 'no_changes', changeCount: 0 }],
      },
    })
  })

  it('recomputes stale workspace bytes and removes unreferenced hidden upload staging files', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-workspace-byte-recovery-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'untracked.txt'), '1234567')
    const staging = resolve(first.sessionDir(session.summary.id), 'upload-staging/upl_0123456789abcdef0123.part')
    await mkdir(resolve(first.sessionDir(session.summary.id), 'upload-staging'), { recursive: true })
    await writeFile(staging, 'orphaned staging bytes')

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).summary.workspaceBytes).toBe(7)
    await expect(readFile(staging)).rejects.toMatchObject({ code: 'ENOENT' })
    const events = await restarted.events(session.summary.id)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        uploadReconciliation: {
          workspaceBytesBefore: 0,
          workspaceBytesAfter: 7,
          workspaceBytesRecomputed: true,
          orphanTemporaryFilesRemoved: 1,
          checkpoints: [],
        },
      },
    })
  })

  it('rolls back a partially installed durable patch transaction during Session startup', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-patch-recovery-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'first.txt'), 'first-before\n')
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'second.txt'), 'second-before\n')
    let release!: () => void
    let installed!: () => void
    const installedBoundary = new Promise<void>((resolveInstalled) => { installed = resolveInstalled })
    const hold = new Promise<void>((resolveHold) => { release = resolveHold })
    const applying = applyWorkspacePatch(first.workspaceDir(session.summary.id), `*** Begin Patch
*** Update File: first.txt
@@
-first-before
+first-after
*** Update File: second.txt
@@
-second-before
+second-after
*** End Patch`, undefined, {
      transactionParent: first.workspacePatchTransactionDir(session.summary.id),
      onDurablePhase: async (phase, details) => {
        if (phase === 'installed' && details.installedCount === 1) {
          installed()
          await hold
        }
      },
    })
    await installedBoundary
    await expect(readFile(resolve(first.workspaceDir(session.summary.id), 'first.txt'), 'utf8')).resolves.toBe('first-after\n')

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    await expect(readFile(resolve(restarted.workspaceDir(session.summary.id), 'first.txt'), 'utf8')).resolves.toBe('first-before\n')
    await expect(readFile(resolve(restarted.workspaceDir(session.summary.id), 'second.txt'), 'utf8')).resolves.toBe('second-before\n')
    const events = await restarted.events(session.summary.id)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        workspacePatchReconciliation: [
          expect.objectContaining({ phase: 'prepared', action: 'rolled_back', changeCount: 2 }),
        ],
      },
    })
    release()
    await expect(applying).rejects.toThrow()
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('reconstructs a staged submit start event after a hard crash before model dispatch', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-pending-submit-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const pending = {
      kind: 'submit' as const,
      turnId: 'turn_pending_submit',
      eventId: 'evt_pending_submit',
      eventData: {
        content: 'Durably accepted request',
        attachments: [],
        model: 'test-model',
        modelSelection: 'test-model',
        productMode: 'chat',
        repository: null,
      },
      createdAt: '2026-08-29T00:00:00.000Z',
    }
    await first.stageRunStart(session.summary.id, pending, (state) => {
      state.messages.push({ role: 'user', content: 'Durably accepted request' })
    })
    expect((await first.get(session.summary.id)).summary.status).toBe('queued')

    // A torn append with the preallocated ID is discarded, then reconstructed
    // exactly once from the semantic checkpoint during startup recovery.
    const eventPath = resolve(first.sessionDir(session.summary.id), 'events.jsonl')
    await appendFile(eventPath, '{"id":"evt_pending_submit","sessionId":', 'utf8')
    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.summary.status).toBe('interrupted')
    expect(recovered.pendingStart).toBeUndefined()
    expect(recovered.messages).toEqual([{ role: 'user', content: 'Durably accepted request' }])

    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === pending.eventId)).toEqual([
      expect.objectContaining({
        type: 'turn.started',
        turnId: pending.turnId,
        data: pending.eventData,
      }),
    ])
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        recoveredPendingStart: {
          kind: 'submit',
          turnId: pending.turnId,
          eventId: pending.eventId,
          reconstructedStartEvent: true,
        },
      },
    })
    expect(events.slice(-3).map((event) => ({ type: event.type, turnId: event.turnId }))).toEqual([
      { type: 'error', turnId: pending.turnId },
      { type: 'turn.completed', turnId: pending.turnId },
      { type: 'run.status', turnId: pending.turnId },
    ])

    const eventCount = events.length
    const secondRestart = new SessionStore(root, 'test-model')
    await secondRestart.initialize()
    expect((await secondRestart.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('does not duplicate an already published staged resume event during recovery', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-pending-resume-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await first.setStatus(session.summary.id, 'failed')
    const pending = {
      kind: 'resume' as const,
      turnId: 'turn_pending_resume',
      eventId: 'evt_pending_resume',
      eventData: {
        previousStatus: 'failed',
        message: 'Continue from the persisted conversation and workspace without repeating completed work.',
      },
      createdAt: '2026-08-29T00:00:00.000Z',
    }
    await first.stageRunStart(session.summary.id, pending, (state) => {
      state.messages.push({ role: 'user', content: '[Harness operator action: Continue] Resume the unfinished task.' })
    })
    await first.append(session.summary.id, 'run.resumed', pending.eventData, {
      turnId: pending.turnId,
      eventId: pending.eventId,
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === pending.eventId)).toHaveLength(1)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        recoveredPendingStart: {
          kind: 'resume',
          turnId: pending.turnId,
          eventId: pending.eventId,
          reconstructedStartEvent: false,
        },
      },
    })
    expect((await restarted.get(session.summary.id)).pendingStart).toBeUndefined()
  })

  it('publishes a complete Final and Task Review exactly once from a crashed terminal checkpoint', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-pending-terminal-completed-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await first.setStatus(session.summary.id, 'running')
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'durable.txt'), 'durable')
    const finalEventId = 'evt_terminal_final'
    const pending = {
      turnId: 'turn_terminal_completed',
      stepId: 'step_terminal_completed',
      status: 'completed' as const,
      createdAt: '2026-08-29T00:00:00.000Z',
      events: [
        { id: 'evt_terminal_workspace_scanning', type: 'workspace.persistence.started' as const, data: { phase: 'scanning', label: 'Scanning workspace...', persistenceMode: 'local_durable' } },
        { id: 'evt_terminal_workspace_uploading', type: 'workspace.persistence.updated' as const, data: { phase: 'uploading', label: 'Uploading 0 workspace blobs...', blobCount: 0, persistenceMode: 'local_durable' } },
        { id: 'evt_terminal_workspace_saving', type: 'workspace.persistence.updated' as const, data: { phase: 'saving', label: 'Saving workspace...', persistenceMode: 'local_durable' } },
        { id: 'evt_terminal_workspace_saved', type: 'workspace.persistence.completed' as const, data: { phase: 'saved', label: 'Workspace saved', blobCount: 0, bytes: 7, fileCount: 1, persistenceMode: 'local_durable' } },
        { id: finalEventId, type: 'assistant.final' as const, data: { content: 'Durable Final', finishReason: 'stop' } },
        { id: 'evt_terminal_turn_completed', type: 'turn.completed' as const, data: { status: 'completed', firstTurn: true } },
        { id: 'evt_terminal_run_status', type: 'run.status' as const, data: { status: 'completed' } },
        { id: 'evt_terminal_review', type: 'review.requested' as const, data: { messageEventId: finalEventId, model: 'test-model' } },
      ],
    }
    await first.stageRunTerminal(session.summary.id, pending, (state) => {
      state.summary.workspaceBytes = 7
      state.messages.push({ role: 'assistant', content: 'Durable Final' })
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.summary.status).toBe('completed')
    expect(recovered.summary.workspaceBytes).toBe(7)
    expect(recovered.pendingTerminal).toBeUndefined()
    expect(recovered.messages.at(-1)).toEqual({ role: 'assistant', content: 'Durable Final' })
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => pending.events.some((item) => item.id === event.id)).map((event) => event.type)).toEqual([
      'workspace.persistence.started',
      'workspace.persistence.updated',
      'workspace.persistence.updated',
      'workspace.persistence.completed',
      'assistant.final',
      'turn.completed',
      'run.status',
      'review.requested',
    ])
    expect(events.find((event) => event.id === 'evt_terminal_review')).toMatchObject({
      data: { messageEventId: finalEventId },
    })
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        previousStatus: 'running',
        status: 'completed',
        recoveredPendingTerminal: {
          turnId: pending.turnId,
          stepId: pending.stepId,
          status: 'completed',
          events: pending.events.map((event) => ({ id: event.id, type: event.type, reconstructed: true })),
        },
      },
    })

    const eventCount = events.length
    const secondRestart = new SessionStore(root, 'test-model')
    await secondRestart.initialize()
    expect((await secondRestart.events(session.summary.id))).toHaveLength(eventCount)
  })

  it.each(['terminal', 'workspace_persistence'] as const)(
    'recovers the independently published %s completion lane without duplicating either lane',
    async (publishedLane) => {
      const root = await mkdtemp(resolve(tmpdir(), `anera-store-completion-lane-${publishedLane}-`))
      roots.push(root)
      const first = new SessionStore(root, 'test-model')
      await first.initialize()
      const session = await first.create()
      await first.setStatus(session.summary.id, 'running')
      const turnId = `turn_completion_lane_${publishedLane}`
      const finalEventId = `evt_completion_final_${publishedLane}`
      const terminalEvents = [
        { id: finalEventId, type: 'assistant.final' as const, data: { content: 'Independent lanes', finishReason: 'stop' } },
        { id: `evt_completion_turn_${publishedLane}`, type: 'turn.completed' as const, data: { status: 'completed', firstTurn: true } },
        { id: `evt_completion_status_${publishedLane}`, type: 'run.status' as const, data: { status: 'completed' } },
        { id: `evt_completion_review_${publishedLane}`, type: 'review.requested' as const, data: { messageEventId: finalEventId, model: 'test-model' } },
      ]
      const workspacePersistenceEvents = [
        { id: `evt_completion_scan_${publishedLane}`, type: 'workspace.persistence.started' as const, data: { phase: 'scanning', label: 'Scanning workspace...', persistenceMode: 'local_durable' } },
        { id: `evt_completion_upload_${publishedLane}`, type: 'workspace.persistence.updated' as const, data: { phase: 'uploading', label: 'Uploading 0 workspace blobs...', blobCount: 0, persistenceMode: 'local_durable' } },
        { id: `evt_completion_save_${publishedLane}`, type: 'workspace.persistence.updated' as const, data: { phase: 'saving', label: 'Saving workspace...', persistenceMode: 'local_durable' } },
        { id: `evt_completion_saved_${publishedLane}`, type: 'workspace.persistence.completed' as const, data: { phase: 'saved', label: 'Workspace saved', blobCount: 0, bytes: 0, fileCount: 0, persistenceMode: 'local_durable' } },
      ]
      await first.stageRunTerminal(session.summary.id, {
        turnId,
        stepId: 'step_completion_lanes',
        status: 'completed',
        events: terminalEvents,
        workspacePersistenceEvents,
        createdAt: '2026-08-31T00:00:00.000Z',
      }, (state) => {
        state.messages.push({ role: 'assistant', content: 'Independent lanes' })
      })

      let completedAtBeforeRestart: string | undefined
      if (publishedLane === 'terminal') {
        await first.publishRunTerminal(session.summary.id, turnId)
        const partiallyPublished = await first.get(session.summary.id)
        completedAtBeforeRestart = partiallyPublished.summary.usage.completedAt
        expect(partiallyPublished).toMatchObject({
          summary: { status: 'completed' },
          pendingTerminal: { terminalPublished: true },
        })
      } else {
        await first.publishWorkspacePersistence(session.summary.id, turnId)
        expect((await first.get(session.summary.id))).toMatchObject({
          summary: { status: 'running' },
          pendingTerminal: { workspacePersistencePublished: true },
        })
      }

      const restarted = new SessionStore(root, 'test-model')
      await restarted.initialize()
      const recovered = await restarted.get(session.summary.id)
      const events = await restarted.events(session.summary.id)
      expect(recovered.summary.status).toBe('completed')
      if (publishedLane === 'terminal') expect(recovered.summary.usage.completedAt).toBe(completedAtBeforeRestart)
      expect(recovered.pendingTerminal).toBeUndefined()
      for (const expected of [...terminalEvents, ...workspacePersistenceEvents]) {
        expect(events.filter((event) => event.id === expected.id)).toHaveLength(1)
      }
      const terminalFirst = publishedLane === 'terminal'
      const terminalIndex = events.findIndex((event) => event.id === terminalEvents[0].id)
      const persistenceIndex = events.findIndex((event) => event.id === workspacePersistenceEvents[0].id)
      expect(terminalFirst ? terminalIndex < persistenceIndex : persistenceIndex < terminalIndex).toBe(true)
      expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
        data: {
          recoveredPendingTerminal: {
            status: 'completed',
            terminalPublished: terminalFirst,
            workspacePersistencePublished: !terminalFirst,
          },
        },
      })

      const eventCount = events.length
      const secondRestart = new SessionStore(root, 'test-model')
      await secondRestart.initialize()
      expect((await secondRestart.events(session.summary.id))).toHaveLength(eventCount)
    },
  )

  it('publishes the Workspace scanning boundary idempotently without committing either completion lane', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-completion-scanning-boundary-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await store.setStatus(session.summary.id, 'running')
    const turnId = 'turn_completion_scanning_boundary'
    await store.stageRunTerminal(session.summary.id, {
      turnId,
      status: 'completed',
      events: [
        { id: 'evt_scanning_boundary_final', type: 'assistant.final', data: { content: 'Final after scanning' } },
      ],
      workspacePersistenceEvents: [
        { id: 'evt_scanning_boundary_started', type: 'workspace.persistence.started', data: { phase: 'scanning' } },
        { id: 'evt_scanning_boundary_saved', type: 'workspace.persistence.completed', data: { phase: 'saved' } },
      ],
      createdAt: '2026-08-31T00:00:00.000Z',
    })

    await store.publishWorkspacePersistenceStarted(session.summary.id, turnId)
    await store.publishWorkspacePersistenceStarted(session.summary.id, turnId)

    const state = await store.get(session.summary.id)
    const events = await store.events(session.summary.id)
    expect(state.summary.status).toBe('running')
    expect(state.pendingTerminal).toMatchObject({ turnId })
    expect(state.pendingTerminal?.terminalPublished).not.toBe(true)
    expect(state.pendingTerminal?.workspacePersistencePublished).not.toBe(true)
    expect(events.filter((event) => event.id === 'evt_scanning_boundary_started')).toHaveLength(1)
    expect(events.some((event) => event.id === 'evt_scanning_boundary_final')).toBe(false)
    expect(events.some((event) => event.id === 'evt_scanning_boundary_saved')).toBe(false)
  })

  it('recovers every pair of terminal and Workspace event-prefix boundaries exactly once', async () => {
    for (let terminalPrefix = 0; terminalPrefix <= 4; terminalPrefix += 1) {
      for (let workspacePrefix = 0; workspacePrefix <= 4; workspacePrefix += 1) {
        const root = await mkdtemp(resolve(tmpdir(), `anera-store-completion-prefix-${terminalPrefix}-${workspacePrefix}-`))
        roots.push(root)
        const first = new SessionStore(root, 'test-model')
        await first.initialize()
        const session = await first.create()
        await writeFile(resolve(first.workspaceDir(session.summary.id), 'boundary.txt'), '12345678901234567')
        await first.setStatus(session.summary.id, 'running')
        const suffix = `${terminalPrefix}_${workspacePrefix}`
        const turnId = `turn_completion_prefix_${suffix}`
        const finalEventId = `evt_prefix_final_${suffix}`
        const terminalEvents: DurablePendingTerminal['events'] = [
          { id: finalEventId, type: 'assistant.final', data: { content: `Boundary ${suffix}` } },
          { id: `evt_prefix_turn_${suffix}`, type: 'turn.completed', data: { status: 'completed' } },
          { id: `evt_prefix_status_${suffix}`, type: 'run.status', data: { status: 'completed' } },
          { id: `evt_prefix_review_${suffix}`, type: 'review.requested', data: { messageEventId: finalEventId } },
        ]
        const workspacePersistenceEvents: NonNullable<DurablePendingTerminal['workspacePersistenceEvents']> = [
          { id: `evt_prefix_scan_${suffix}`, type: 'workspace.persistence.started', data: { phase: 'scanning' } },
          { id: `evt_prefix_upload_${suffix}`, type: 'workspace.persistence.updated', data: { phase: 'uploading' } },
          { id: `evt_prefix_save_${suffix}`, type: 'workspace.persistence.updated', data: { phase: 'saving' } },
          { id: `evt_prefix_saved_${suffix}`, type: 'workspace.persistence.completed', data: { phase: 'saved' } },
        ]
        await first.stageRunTerminal(session.summary.id, {
          turnId,
          status: 'completed',
          events: terminalEvents,
          workspacePersistenceEvents,
          createdAt: '2026-08-31T00:00:00.000Z',
        }, (state) => {
          state.summary.workspaceBytes = 17
          state.messages.push({ role: 'assistant', content: `Boundary ${suffix}` })
        })

        // These are all durable prefixes that can remain when either publisher
        // is killed between append boundaries. Alternate the append order so
        // cases with two non-empty prefixes also exercise cross-lane overlap.
        for (let index = 0; index < Math.max(terminalPrefix, workspacePrefix); index += 1) {
          const workspaceEvent = workspacePersistenceEvents[index]
          if (index < workspacePrefix && workspaceEvent) {
            await first.append(session.summary.id, workspaceEvent.type, workspaceEvent.data, {
              turnId,
              eventId: workspaceEvent.id,
            })
          }
          const terminalEvent = terminalEvents[index]
          if (index < terminalPrefix && terminalEvent) {
            await first.append(session.summary.id, terminalEvent.type, terminalEvent.data, {
              turnId,
              eventId: terminalEvent.id,
            })
          }
        }

        const restarted = new SessionStore(root, 'test-model')
        await restarted.initialize()
        const recovered = await restarted.get(session.summary.id)
        const events = await restarted.events(session.summary.id)
        expect(recovered.summary).toMatchObject({ status: 'completed', workspaceBytes: 17 })
        expect(recovered.summary.usage.completedAt).toBeTruthy()
        expect(recovered.pendingTerminal).toBeUndefined()
        for (const expected of [...terminalEvents, ...workspacePersistenceEvents]) {
          expect(events.filter((event) => event.id === expected.id), `${suffix}:${expected.id}`).toHaveLength(1)
        }
        if (terminalPrefix === 0) {
          const scanning = events.find((event) => event.id === workspacePersistenceEvents[0].id)!
          const final = events.find((event) => event.id === terminalEvents[0].id)!
          expect(scanning.seq, suffix).toBeLessThan(final.seq)
        }
        const recovery = events.find((event) => event.type === 'session.recovered')
        const recoveredEvents = recovery?.data.recoveredPendingTerminal as { events?: Array<{ reconstructed?: boolean }> } | undefined
        expect(recoveredEvents?.events?.filter((event) => event.reconstructed === false)).toHaveLength(terminalPrefix + workspacePrefix)

        const eventCount = events.length
        const secondRestart = new SessionStore(root, 'test-model')
        await secondRestart.initialize()
        expect((await secondRestart.events(session.summary.id))).toHaveLength(eventCount)
        expect((await secondRestart.get(session.summary.id)).summary.usage.completedAt).toBe(recovered.summary.usage.completedAt)
      }
    }
  })

  it('recovers a crash after Review and Workspace scanning without duplicating the partial saga', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-completion-mid-persistence-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await first.setStatus(session.summary.id, 'running')
    const turnId = 'turn_completion_mid_persistence'
    const finalEventId = 'evt_mid_persistence_final'
    const terminalEvents = [
      { id: finalEventId, type: 'assistant.final' as const, data: { content: 'Review is visible', finishReason: 'stop' } },
      { id: 'evt_mid_persistence_turn', type: 'turn.completed' as const, data: { status: 'completed' } },
      { id: 'evt_mid_persistence_status', type: 'run.status' as const, data: { status: 'completed' } },
      { id: 'evt_mid_persistence_review', type: 'review.requested' as const, data: { messageEventId: finalEventId, model: 'test-model' } },
    ]
    const workspacePersistenceEvents = [
      { id: 'evt_mid_persistence_scan', type: 'workspace.persistence.started' as const, data: { phase: 'scanning', label: 'Scanning workspace...', persistenceMode: 'local_durable' } },
      { id: 'evt_mid_persistence_upload', type: 'workspace.persistence.updated' as const, data: { phase: 'uploading', label: 'Uploading 0 workspace blobs...', blobCount: 0, persistenceMode: 'local_durable' } },
      { id: 'evt_mid_persistence_save', type: 'workspace.persistence.updated' as const, data: { phase: 'saving', label: 'Saving workspace...', persistenceMode: 'local_durable' } },
      { id: 'evt_mid_persistence_saved', type: 'workspace.persistence.completed' as const, data: { phase: 'saved', label: 'Workspace saved', blobCount: 0, bytes: 0, fileCount: 0, persistenceMode: 'local_durable' } },
    ]
    await first.stageRunTerminal(session.summary.id, {
      turnId,
      status: 'completed',
      events: terminalEvents,
      workspacePersistenceEvents,
      createdAt: '2026-08-31T00:00:00.000Z',
    })
    await first.publishRunTerminal(session.summary.id, turnId)
    await first.append(session.summary.id, workspacePersistenceEvents[0].type, workspacePersistenceEvents[0].data, {
      turnId,
      eventId: workspacePersistenceEvents[0].id,
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const events = await restarted.events(session.summary.id)
    expect((await restarted.get(session.summary.id)).pendingTerminal).toBeUndefined()
    expect(events.filter((event) => event.id === workspacePersistenceEvents[0].id)).toHaveLength(1)
    expect(events.find((event) => event.id === workspacePersistenceEvents.at(-1)!.id)).toMatchObject({
      type: 'workspace.persistence.completed',
    })
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        recoveredPendingTerminal: {
          terminalPublished: true,
          workspacePersistencePublished: false,
          events: expect.arrayContaining([
            { id: workspacePersistenceEvents[0].id, type: 'workspace.persistence.started', lane: 'workspace_persistence', reconstructed: false },
            { id: workspacePersistenceEvents.at(-1)!.id, type: 'workspace.persistence.completed', lane: 'workspace_persistence', reconstructed: true },
          ]),
        },
      },
    })
  })

  it('finishes a partially published failed terminal checkpoint without duplicating its error', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-pending-terminal-failed-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await first.setStatus(session.summary.id, 'running')
    const pending = {
      turnId: 'turn_terminal_failed',
      status: 'failed' as const,
      createdAt: '2026-08-29T00:00:00.000Z',
      events: [
        { id: 'evt_terminal_error', type: 'error' as const, data: { message: 'provider failed', cancelled: false, timedOut: false } },
        { id: 'evt_terminal_failed_turn', type: 'turn.completed' as const, data: { status: 'failed' } },
        { id: 'evt_terminal_failed_status', type: 'run.status' as const, data: { status: 'failed' } },
      ],
    }
    await first.stageRunTerminal(session.summary.id, pending)
    await first.append(session.summary.id, 'error', pending.events[0].data, {
      turnId: pending.turnId,
      eventId: pending.events[0].id,
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).summary.status).toBe('failed')
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === 'evt_terminal_error')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'review.requested')).toHaveLength(0)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        recoveredPendingTerminal: {
          status: 'failed',
          events: [
            { id: 'evt_terminal_error', type: 'error', reconstructed: false },
            { id: 'evt_terminal_failed_turn', type: 'turn.completed', reconstructed: true },
            { id: 'evt_terminal_failed_status', type: 'run.status', reconstructed: true },
          ],
        },
      },
    })
  })

  it('materializes an event-only Deployment projection and reconstructs a state-only boundary exactly once', async () => {
    const eventRoot = await mkdtemp(resolve(tmpdir(), 'anera-store-deployment-event-'))
    roots.push(eventRoot)
    const eventStore = new SessionStore(eventRoot, 'test-model')
    await eventStore.initialize()
    const eventSession = await eventStore.create()
    const deploymentCreatedAt = new Date(Date.parse(eventSession.summary.createdAt) + 1).toISOString()
    const deploymentUpdatedAt = new Date(Date.parse(eventSession.summary.createdAt) + 2).toISOString()
    const eventDeployment: DeploymentState = {
      id: 'dep_eventonly00000001',
      status: 'deployed',
      url: `http://127.0.0.1/deployments/${eventSession.summary.id}/`,
      visibility: 'local',
      revision: 1,
      entryPath: 'index.html',
      contentHash: 'a'.repeat(64),
      fileCount: 1,
      bytes: 18,
      createdAt: deploymentCreatedAt,
      updatedAt: deploymentUpdatedAt,
    }
    await eventStore.append(eventSession.summary.id, 'deployment.updated', {
      deployment: eventDeployment,
      action: 'deployed',
    }, { turnId: 'turn_event_deploy', stepId: 'step_event_deploy', callId: 'call_event_deploy' })

    const eventRestart = new SessionStore(eventRoot, 'test-model')
    await eventRestart.initialize()
    expect((await eventRestart.get(eventSession.summary.id)).deployment).toEqual(eventDeployment)
    let eventLog = await eventRestart.events(eventSession.summary.id)
    expect(eventLog.filter((event) => event.type === 'deployment.updated')).toHaveLength(1)
    expect(eventLog.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        deploymentReconciliation: {
          action: 'event_replayed',
          status: 'deployed',
          revision: 1,
          materializedFromEvent: true,
          reconstructedMissingEvent: false,
        },
      },
    })
    const eventCount = eventLog.length
    const eventRestartAgain = new SessionStore(eventRoot, 'test-model')
    await eventRestartAgain.initialize()
    expect((await eventRestartAgain.events(eventSession.summary.id))).toHaveLength(eventCount)

    const stateRoot = await mkdtemp(resolve(tmpdir(), 'anera-store-deployment-state-'))
    roots.push(stateRoot)
    const stateStore = new SessionStore(stateRoot, 'test-model')
    await stateStore.initialize()
    const stateSession = await stateStore.create()
    const stateDeployment = {
      ...eventDeployment,
      id: 'dep_stateonly00000001',
      url: `http://127.0.0.1/deployments/${stateSession.summary.id}/`,
      updatedAt: '2026-08-29T00:00:02.000Z',
    }
    await stateStore.update(stateSession.summary.id, (state) => { state.deployment = stateDeployment })

    const stateRestart = new SessionStore(stateRoot, 'test-model')
    await stateRestart.initialize()
    expect((await stateRestart.get(stateSession.summary.id)).deployment).toEqual(stateDeployment)
    const stateEvents = await stateRestart.events(stateSession.summary.id)
    expect(stateEvents.filter((event) => event.type === 'deployment.updated')).toEqual([
      expect.objectContaining({
        data: { deployment: stateDeployment, action: 'projection_repaired', recovered: true },
      }),
    ])
    const stateCount = stateEvents.length
    const stateRestartAgain = new SessionStore(stateRoot, 'test-model')
    await stateRestartAgain.initialize()
    expect((await stateRestartAgain.events(stateSession.summary.id))).toHaveLength(stateCount)
  })

  it('reconciles event-only and state-only Plan projections without duplicating either boundary', async () => {
    const eventRoot = await mkdtemp(resolve(tmpdir(), 'anera-store-plan-event-'))
    roots.push(eventRoot)
    const eventStore = new SessionStore(eventRoot, 'test-model')
    await eventStore.initialize()
    const eventSession = await eventStore.create()
    const eventPlan = {
      items: [
        { id: 'plan_event_1', step: 'Inspect', status: 'completed' as const },
        { id: 'plan_event_2', step: 'Implement', status: 'in_progress' as const },
      ],
      explanation: 'Recovered from the event log.',
      updatedAt: '2026-08-29T00:00:01.000Z',
      version: 1,
    }
    await eventStore.append(eventSession.summary.id, 'plan.updated', {
      plan: eventPlan,
      explanation: eventPlan.explanation,
    }, { turnId: 'turn_plan_event', stepId: 'step_plan_event', callId: 'call_plan_event' })

    const eventRestart = new SessionStore(eventRoot, 'test-model')
    await eventRestart.initialize()
    expect((await eventRestart.get(eventSession.summary.id)).plan).toEqual(eventPlan)
    const eventEvents = await eventRestart.events(eventSession.summary.id)
    expect(eventEvents.filter((event) => event.type === 'plan.updated')).toHaveLength(1)
    expect(eventEvents.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        planReconciliation: {
          action: 'event_replayed',
          version: 1,
          materializedFromEvent: true,
          reconstructedMissingEvent: false,
        },
      },
    })
    const eventCount = eventEvents.length
    const eventRestartAgain = new SessionStore(eventRoot, 'test-model')
    await eventRestartAgain.initialize()
    expect((await eventRestartAgain.events(eventSession.summary.id))).toHaveLength(eventCount)

    const stateRoot = await mkdtemp(resolve(tmpdir(), 'anera-store-plan-state-'))
    roots.push(stateRoot)
    const stateStore = new SessionStore(stateRoot, 'test-model')
    await stateStore.initialize()
    const stateSession = await stateStore.create()
    const statePlan = {
      ...eventPlan,
      items: eventPlan.items.map((item) => ({ ...item })),
      explanation: 'Recovered from materialized state.',
      updatedAt: '2026-08-29T00:00:02.000Z',
    }
    await stateStore.update(stateSession.summary.id, (state) => { state.plan = statePlan })

    const stateRestart = new SessionStore(stateRoot, 'test-model')
    await stateRestart.initialize()
    expect((await stateRestart.get(stateSession.summary.id)).plan).toEqual(statePlan)
    const stateEvents = await stateRestart.events(stateSession.summary.id)
    expect(stateEvents.filter((event) => event.type === 'plan.updated')).toEqual([
      expect.objectContaining({
        data: {
          plan: statePlan,
          explanation: statePlan.explanation,
          action: 'projection_repaired',
          recovered: true,
        },
      }),
    ])
    const stateCount = stateEvents.length
    const stateRestartAgain = new SessionStore(stateRoot, 'test-model')
    await stateRestartAgain.initialize()
    expect((await stateRestartAgain.events(stateSession.summary.id))).toHaveLength(stateCount)
  })

  it('reconciles event-only and state-only Artifact projections against files exactly once', async () => {
    const eventRoot = await mkdtemp(resolve(tmpdir(), 'anera-store-artifact-event-'))
    roots.push(eventRoot)
    const eventStore = new SessionStore(eventRoot, 'test-model')
    await eventStore.initialize()
    const eventSession = await eventStore.create()
    const eventArtifact = artifactRecord(eventSession.summary.id, 'event-only.txt', 'art_eventonly00000001')
    await writeFile(resolve(eventStore.workspaceDir(eventSession.summary.id), eventArtifact.path), 'event only\n')
    await eventStore.append(eventSession.summary.id, 'artifact.created', { artifact: eventArtifact }, {
      turnId: 'turn_artifact_event', stepId: 'step_artifact_event', callId: 'call_artifact_event',
    })

    const eventRestart = new SessionStore(eventRoot, 'test-model')
    await eventRestart.initialize()
    expect((await eventRestart.get(eventSession.summary.id)).artifacts).toEqual([eventArtifact])
    const eventEvents = await eventRestart.events(eventSession.summary.id)
    expect(eventEvents.filter((event) => event.type === 'artifact.created')).toHaveLength(1)
    expect(eventEvents.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        artifactReconciliation: {
          materializedChanged: true,
          artifactCount: 1,
          repairs: [],
        },
      },
    })
    const eventCount = eventEvents.length
    const eventRestartAgain = new SessionStore(eventRoot, 'test-model')
    await eventRestartAgain.initialize()
    expect((await eventRestartAgain.events(eventSession.summary.id))).toHaveLength(eventCount)

    const stateRoot = await mkdtemp(resolve(tmpdir(), 'anera-store-artifact-state-'))
    roots.push(stateRoot)
    const stateStore = new SessionStore(stateRoot, 'test-model')
    await stateStore.initialize()
    const stateSession = await stateStore.create()
    const stateArtifact = artifactRecord(stateSession.summary.id, 'state-only.txt', 'art_stateonly00000001')
    await writeFile(resolve(stateStore.workspaceDir(stateSession.summary.id), stateArtifact.path), 'state only\n')
    await stateStore.update(stateSession.summary.id, (state) => { state.artifacts = [stateArtifact] })

    const stateRestart = new SessionStore(stateRoot, 'test-model')
    await stateRestart.initialize()
    expect((await stateRestart.get(stateSession.summary.id)).artifacts).toEqual([stateArtifact])
    const stateEvents = await stateRestart.events(stateSession.summary.id)
    expect(stateEvents.filter((event) => event.type === 'artifact.created')).toEqual([
      expect.objectContaining({
        data: {
          artifact: stateArtifact,
          path: stateArtifact.path,
          reason: 'projection_repaired',
          recovered: true,
        },
      }),
    ])
    const stateCount = stateEvents.length
    const stateRestartAgain = new SessionStore(stateRoot, 'test-model')
    await stateRestartAgain.initialize()
    expect((await stateRestartAgain.events(stateSession.summary.id))).toHaveLength(stateCount)
  })

  it('replays preallocated Artifact create and remove boundaries from a torn file.changed tail', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-artifact-file-boundary-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const created = artifactRecord(session.summary.id, 'boundary.txt', 'art_boundary000000001')
    const createEventId = 'evt_artifact_boundary_create'
    await writeFile(resolve(first.workspaceDir(session.summary.id), created.path), 'created before crash\n')
    await first.append(session.summary.id, 'file.changed', {
      path: created.path,
      bytes: 21,
      operation: 'created',
      artifact: created,
      artifactEventId: createEventId,
    }, { turnId: 'turn_artifact_create', stepId: 'step_artifact_create', callId: 'call_artifact_create' })

    const createRestart = new SessionStore(root, 'test-model')
    await createRestart.initialize()
    expect((await createRestart.get(session.summary.id)).artifacts).toEqual([created])
    let events = await createRestart.events(session.summary.id)
    expect(events.filter((event) => event.id === createEventId)).toEqual([
      expect.objectContaining({
        type: 'artifact.created',
        data: expect.objectContaining({ artifact: created, reason: 'file_boundary_replayed', recovered: true }),
      }),
    ])

    const removeEventId = 'evt_artifact_boundary_remove'
    await rm(resolve(createRestart.workspaceDir(session.summary.id), created.path))
    await createRestart.append(session.summary.id, 'file.changed', {
      path: created.path,
      bytes: 0,
      operation: 'deleted',
      artifact: created,
      artifactEventId: removeEventId,
    }, { turnId: 'turn_artifact_remove', stepId: 'step_artifact_remove', callId: 'call_artifact_remove' })

    const removeRestart = new SessionStore(root, 'test-model')
    await removeRestart.initialize()
    expect((await removeRestart.get(session.summary.id)).artifacts).toEqual([])
    events = await removeRestart.events(session.summary.id)
    expect(events.filter((event) => event.id === removeEventId)).toEqual([
      expect.objectContaining({
        type: 'artifact.removed',
        data: expect.objectContaining({ artifact: created, path: created.path, reason: 'file_boundary_replayed', recovered: true }),
      }),
    ])
    const eventCount = events.length
    const removeRestartAgain = new SessionStore(root, 'test-model')
    await removeRestartAgain.initialize()
    expect((await removeRestartAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('removes an Artifact projection whose backing file disappeared without a removal event', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-artifact-missing-file-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const artifact = artifactRecord(session.summary.id, 'missing.txt', 'art_missingfile0000001')
    await first.recordArtifactCreated(session.summary.id, artifact, {
      turnId: 'turn_artifact_missing', stepId: 'step_artifact_missing', callId: 'call_artifact_missing',
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).artifacts).toEqual([])
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'artifact.removed')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          artifact,
          path: artifact.path,
          reason: 'missing_file_reconciled',
          recovered: true,
        }),
      }),
    ])
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('promotes a verified snapshot checkpoint and reconstructs its Deployment and tool terminal boundaries once', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-deployment-valid-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const pending = deploymentCheckpoint(session.summary.id, session.deployment)
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'index.html'), '<h1>RECOVERED DEPLOY</h1>')
    await first.setStatus(session.summary.id, 'running')
    await first.update(session.summary.id, (state) => {
      state.messages.push(
        { role: 'user', content: 'Deploy the project.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: String(pending.context.callId),
            type: 'function',
            function: { name: 'deploy_project', arguments: '{}' },
          }],
        },
      )
    })
    await first.append(session.summary.id, 'assistant.started', { step: 1 }, pending.context)
    await first.append(session.summary.id, 'tool.started', {
      call: { id: pending.context.callId, name: 'deploy_project', arguments: {} },
    }, pending.context)
    await first.stageDeploymentSnapshot(session.summary.id, pending)
    const snapshot = await createStaticDeploymentSnapshot(
      first.workspaceDir(session.summary.id),
      first.deploymentRevisionDir(session.summary.id, pending.revision),
      new AbortController().signal,
    )

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.pendingDeployment).toBeUndefined()
    expect(recovered.deployment).toMatchObject({
      id: pending.deploymentId,
      status: 'deployed',
      revision: 1,
      entryPath: snapshot.entryPath,
      contentHash: snapshot.contentHash,
      fileCount: snapshot.fileCount,
      bytes: snapshot.bytes,
    })
    expect(recovered.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: pending.context.callId,
      content: '{"status":"success"}',
      tool_result_status: 'succeeded',
    })
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === pending.deployingEventId)).toHaveLength(1)
    expect(events.filter((event) => event.id === pending.completionEventId)).toEqual([
      expect.objectContaining({ type: 'deployment.updated', data: { deployment: recovered.deployment, action: 'deployed' } }),
    ])
    expect(events.filter((event) => event.type === 'tool.completed' && event.callId === pending.context.callId)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'deployment_terminal_recovered', result: '{"status":"success"}', recovered: true }),
      }),
    ])
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        deploymentReconciliation: {
          action: 'deployed',
          checkpoint: {
            checkpointId: pending.id,
            revision: 1,
            phase: 'snapshotting',
            manifestVerified: true,
            deployingEventReconstructed: false,
            completionEventReconstructed: true,
            completionAction: 'deployed',
            status: 'deployed',
          },
        },
      },
    })
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('recovers a verified redeploy with stable identity while retaining the prior revision', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-deployment-redeploy-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const workspace = first.workspaceDir(session.summary.id)
    await writeFile(resolve(workspace, 'index.html'), '<h1>REVISION ONE</h1>')
    const firstSnapshot = await createStaticDeploymentSnapshot(
      workspace,
      first.deploymentRevisionDir(session.summary.id, 1),
      new AbortController().signal,
    )
    const prior: DeploymentState = {
      id: 'dep_stableredeploy00001',
      status: 'deployed',
      url: `http://127.0.0.1:4173/deployments/${session.summary.id}/`,
      visibility: 'local',
      revision: 1,
      entryPath: firstSnapshot.entryPath,
      contentHash: firstSnapshot.contentHash,
      fileCount: firstSnapshot.fileCount,
      bytes: firstSnapshot.bytes,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:01.000Z',
    }
    await first.recordDeploymentUpdate(session.summary.id, prior, 'deployed')
    await writeFile(resolve(workspace, 'index.html'), '<h1>REVISION TWO</h1>')
    const pending = deploymentCheckpoint(session.summary.id, prior)
    await first.stageDeploymentSnapshot(session.summary.id, pending)
    const secondSnapshot = await createStaticDeploymentSnapshot(
      workspace,
      first.deploymentRevisionDir(session.summary.id, 2),
      new AbortController().signal,
    )

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).deployment).toMatchObject({
      id: prior.id,
      url: prior.url,
      status: 'deployed',
      revision: 2,
      contentHash: secondSnapshot.contentHash,
    })
    await expect(readFile(resolve(first.deploymentRevisionDir(session.summary.id, 1), 'index.html'), 'utf8')).resolves.toContain('REVISION ONE')
    await expect(readFile(resolve(first.deploymentRevisionDir(session.summary.id, 2), 'index.html'), 'utf8')).resolves.toContain('REVISION TWO')
    expect((await restarted.events(session.summary.id)).filter((event) => event.type === 'deployment.updated').map((event) => event.data.action)).toEqual([
      'deployed', 'deploying', 'redeployed',
    ])
  })

  it('removes a partial snapshot without a manifest and publishes deploy_interrupted once', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-deployment-partial-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const pending = deploymentCheckpoint(session.summary.id, session.deployment)
    await first.stageDeploymentSnapshot(session.summary.id, pending)
    const target = first.deploymentRevisionDir(session.summary.id, pending.revision)
    await mkdir(target, { recursive: true })
    await writeFile(resolve(target, 'index.html'), '<h1>PARTIAL</h1>')

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.pendingDeployment).toBeUndefined()
    expect(recovered.deployment).toMatchObject({
      id: pending.deploymentId,
      status: 'failed',
      revision: 0,
      error: expect.stringContaining('no verified revision manifest'),
    })
    await expect(readFile(resolve(target, 'index.html'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(deploymentSnapshotManifestPath(target), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'deployment.updated').map((event) => event.data.action)).toEqual([
      'deploying', 'deploy_interrupted',
    ])
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        deploymentReconciliation: {
          action: 'deploy_interrupted',
          checkpoint: { manifestVerified: false, completionEventReconstructed: true },
        },
      },
    })
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('publishes a ready checkpoint with a missing completion event and clears it idempotently', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-deployment-ready-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const pending = deploymentCheckpoint(session.summary.id, session.deployment)
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'index.html'), '<h1>READY</h1>')
    await first.stageDeploymentSnapshot(session.summary.id, pending)
    const snapshot = await createStaticDeploymentSnapshot(
      first.workspaceDir(session.summary.id),
      first.deploymentRevisionDir(session.summary.id, pending.revision),
      new AbortController().signal,
    )
    const completed: DeploymentState = {
      id: pending.deploymentId,
      status: 'deployed',
      url: pending.url,
      visibility: pending.visibility,
      revision: pending.revision,
      entryPath: snapshot.entryPath,
      contentHash: snapshot.contentHash,
      fileCount: snapshot.fileCount,
      bytes: snapshot.bytes,
      createdAt: pending.createdAt,
      updatedAt: '2026-08-29T00:00:02.000Z',
    }
    await first.update(session.summary.id, (state) => {
      state.deployment = completed
      state.pendingDeployment = {
        ...pending,
        phase: 'ready',
        completed,
        completionAction: 'deployed',
      }
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).deployment).toEqual(completed)
    expect((await restarted.get(session.summary.id)).pendingDeployment).toBeUndefined()
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === pending.completionEventId)).toHaveLength(1)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        deploymentReconciliation: {
          checkpoint: {
            phase: 'ready', manifestVerified: true, completionEventReconstructed: true,
          },
        },
      },
    })
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('retains an already-published success boundary but fails and removes a ready revision tampered before restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-deployment-tampered-ready-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const pending = deploymentCheckpoint(session.summary.id, session.deployment)
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'index.html'), '<h1>ORIGINAL</h1>')
    await first.stageDeploymentSnapshot(session.summary.id, pending)
    const target = first.deploymentRevisionDir(session.summary.id, pending.revision)
    const snapshot = await createStaticDeploymentSnapshot(
      first.workspaceDir(session.summary.id),
      target,
      new AbortController().signal,
    )
    const completed: DeploymentState = {
      id: pending.deploymentId,
      status: 'deployed',
      url: pending.url,
      visibility: pending.visibility,
      revision: pending.revision,
      entryPath: snapshot.entryPath,
      contentHash: snapshot.contentHash,
      fileCount: snapshot.fileCount,
      bytes: snapshot.bytes,
      createdAt: pending.createdAt,
      updatedAt: '2026-08-29T00:00:03.000Z',
    }
    await first.update(session.summary.id, (state) => {
      state.deployment = completed
      state.pendingDeployment = {
        ...pending,
        phase: 'ready',
        completed,
        completionAction: 'deployed',
      }
    })
    await first.append(session.summary.id, 'deployment.updated', {
      deployment: completed,
      action: 'deployed',
    }, { ...pending.context, eventId: pending.completionEventId })
    await writeFile(resolve(target, 'index.html'), '<h1>TAMPERED</h1>')

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.deployment).toMatchObject({ status: 'failed', revision: 0, id: pending.deploymentId })
    expect(recovered.pendingDeployment).toBeUndefined()
    await expect(readFile(resolve(target, 'index.html'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const deploymentEvents = (await restarted.events(session.summary.id)).filter((event) => event.type === 'deployment.updated')
    expect(deploymentEvents.map((event) => event.data.action)).toEqual(['deploying', 'deployed', 'deploy_interrupted'])
    expect(deploymentEvents.filter((event) => event.id === pending.completionEventId)).toHaveLength(1)
    expect(new Set(deploymentEvents.map((event) => event.id)).size).toBe(3)
  })

  it('detects corruption of a fully published checkpoint revision on a later restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-deployment-corrupt-published-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const pending = deploymentCheckpoint(session.summary.id, session.deployment)
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'index.html'), '<h1>PUBLISHED</h1>')
    await first.stageDeploymentSnapshot(session.summary.id, pending)
    const target = first.deploymentRevisionDir(session.summary.id, pending.revision)
    const snapshot = await createStaticDeploymentSnapshot(
      first.workspaceDir(session.summary.id),
      target,
      new AbortController().signal,
    )
    const completed: DeploymentState = {
      id: pending.deploymentId,
      status: 'deployed',
      url: pending.url,
      visibility: pending.visibility,
      revision: pending.revision,
      entryPath: snapshot.entryPath,
      contentHash: snapshot.contentHash,
      fileCount: snapshot.fileCount,
      bytes: snapshot.bytes,
      createdAt: pending.createdAt,
      updatedAt: '2026-08-29T00:00:04.000Z',
    }
    await first.settleDeploymentSnapshot(session.summary.id, pending.id, completed, 'deployed')
    expect((await first.get(session.summary.id)).deploymentManifestRequired).toBe(true)
    await writeFile(resolve(target, 'index.html'), '<h1>CORRUPTED AFTER PUBLICATION</h1>')

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.deployment).toMatchObject({
      id: pending.deploymentId,
      status: 'failed',
      revision: 0,
      error: 'Deployment revision 1 failed manifest verification after the server restarted.',
    })
    expect(recovered.deploymentManifestRequired).toBe(false)
    await expect(readFile(resolve(target, 'index.html'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'deployment.updated').map((event) => event.data.action)).toEqual([
      'deploying', 'deployed', 'deployment_corrupted',
    ])
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        deploymentReconciliation: {
          action: 'deployment_corrupted',
          status: 'failed',
          revision: 0,
          corruptedRevision: 1,
        },
      },
    })
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('fails a legacy transient Deployment after restart while preserving its last good revision', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-deployment-transient-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const revisionOne = first.deploymentRevisionDir(session.summary.id, 1)
    await mkdir(revisionOne, { recursive: true })
    await writeFile(resolve(revisionOne, 'index.html'), '<h1>LAST GOOD</h1>')
    const prior: DeploymentState = {
      id: 'dep_transient000000001',
      status: 'deployed',
      url: `http://127.0.0.1/deployments/${session.summary.id}/`,
      visibility: 'local',
      revision: 1,
      entryPath: 'index.html',
      contentHash: 'b'.repeat(64),
      fileCount: 1,
      bytes: 18,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:01.000Z',
    }
    await first.recordDeploymentUpdate(session.summary.id, prior, 'deployed')
    const deploying: DeploymentState = {
      ...prior,
      status: 'deploying',
      updatedAt: '2026-08-29T00:00:02.000Z',
    }
    await first.recordDeploymentUpdate(session.summary.id, deploying, 'deploying')
    const incompleteRevision = first.deploymentRevisionDir(session.summary.id, 2)
    await mkdir(incompleteRevision, { recursive: true })
    await writeFile(resolve(incompleteRevision, 'index.html'), '<h1>INCOMPLETE</h1>')

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).deployment).toMatchObject({
      id: prior.id,
      status: 'failed',
      revision: 1,
      entryPath: 'index.html',
      error: 'Deployment deploying was interrupted when the server restarted.',
    })
    await expect(readFile(resolve(revisionOne, 'index.html'), 'utf8')).resolves.toContain('LAST GOOD')
    await expect(readFile(resolve(incompleteRevision, 'index.html'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'deployment.updated').map((event) => event.data.action)).toEqual([
      'deployed', 'deploying', 'deploy_interrupted',
    ])
    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('recovers transient run, approval, and process state exactly once after restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await first.setStatus(session.summary.id, 'running')
    await first.setStatus(session.summary.id, 'awaiting_approval')
    await first.update(session.summary.id, (state) => {
      state.processes.push({
        id: 'proc_restart',
        command: 'npm run dev',
        pid: 1234,
        port: 43199,
        status: 'running',
        startedAt: new Date().toISOString(),
        stdout: 'ready\n',
        stderr: '',
      })
      state.website = {
        status: 'running',
        processId: 'proc_restart',
        port: 43199,
        previewUrl: 'http://127.0.0.1:43199',
        updatedAt: new Date().toISOString(),
        restartCount: 0,
      }
    })
    await first.append(session.summary.id, 'approval.required', {
      approvalId: 'approval_restart',
      call: { id: 'call_restart', name: 'http_request', arguments: { url: 'https://example.com', method: 'POST' } },
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.summary.status).toBe('interrupted')
    expect(recovered.processes[0]).toMatchObject({ id: 'proc_restart', status: 'interrupted', signal: 'SERVER_RESTART' })
    expect(recovered.website).toMatchObject({ status: 'asleep', processId: 'proc_restart', port: 43199 })
    const events = await restarted.events(session.summary.id)
    expect(events.map((event) => event.type)).toContain('session.recovered')
    expect(events.map((event) => event.type)).toContain('approval.expired')
    const websiteEvents = events.filter((event) => event.type === 'website.updated')
    expect(websiteEvents).toHaveLength(2)
    expect(websiteEvents[0]).toMatchObject({
      data: { action: 'projection_repaired', recovered: true, website: { status: 'running', processId: 'proc_restart' } },
    })
    expect(websiteEvents[1]).toMatchObject({
      data: { action: 'server_restarted', recovered: true, website: { status: 'asleep', processId: 'proc_restart' } },
    })
    expect(events.at(-1)).toMatchObject({ type: 'run.status', data: { status: 'interrupted' } })

    const countAfterRecovery = events.length
    await restarted.list()
    expect((await restarted.events(session.summary.id)).length).toBe(countAfterRecovery)
  })

  it('rebuilds an event-only running process and publishes one recovered stop boundary', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-process-event-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const record = {
      id: 'proc_eventonly00000001',
      command: 'npm run dev',
      pid: 999_999_991,
      port: 43129,
      status: 'running' as const,
      startedAt: new Date().toISOString(),
      stdout: 'ready\n',
      stderr: '',
    }
    await first.append(session.summary.id, 'process.started', { type: 'started', record })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).processes).toEqual([
      expect.objectContaining({ id: record.id, status: 'interrupted', signal: 'SERVER_RESTART' }),
    ])
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'process.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'process.stopped')).toHaveLength(1)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        processReconciliation: {
          reconstructedMaterializedProcessIds: [record.id],
          termination: [expect.objectContaining({ processId: record.id, identity: 'not_found', action: 'already_absent' })],
        },
      },
    })

    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('replays a torn process ownership update that explicitly clears a stale durable port', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-process-port-update-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const verified = {
      id: 'proc_portupdate00000001',
      command: 'npm run dev',
      pid: 999_999_990,
      port: 43_129,
      portHint: 43_129,
      status: 'running' as const,
      startedAt: new Date().toISOString(),
      stdout: 'ready\n',
      stderr: '',
      listeningPorts: [{ port: 43_129, address: '0.0.0.0' }],
      newPorts: [{ port: 43_129, address: '0.0.0.0' }],
    }
    await first.append(session.summary.id, 'process.started', { type: 'started', record: verified })
    await first.update(session.summary.id, (state) => { state.processes = [verified] })

    // Simulate a crash after the authoritative event append but before the
    // materialized state write. JSON intentionally omits `port: undefined`;
    // the empty ownership arrays carry the explicit clear semantics.
    await first.append(session.summary.id, 'process.updated', {
      type: 'updated',
      record: { ...verified, port: undefined, listeningPorts: [], newPorts: [] },
    })
    expect((await first.get(session.summary.id)).processes[0].port).toBe(43_129)

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recoveredProcesses = (await restarted.get(session.summary.id)).processes
    expect(recoveredProcesses).toEqual([
      expect.objectContaining({
        id: verified.id,
        status: 'interrupted',
        listeningPorts: [],
        newPorts: [],
      }),
    ])
    expect(recoveredProcesses[0].port).toBeUndefined()
    expect((await restarted.events(session.summary.id)).filter((event) => event.type === 'process.updated')).toEqual([
      expect.objectContaining({
        data: { type: 'updated', record: expect.objectContaining({ listeningPorts: [], newPorts: [] }) },
      }),
    ])
  })

  it('repairs missing start and stop events for a terminal materialized process exactly once', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-process-state-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const record = {
      id: 'proc_stateonly00000001',
      command: 'npm run dev',
      pid: 999_999_992,
      status: 'stopped' as const,
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: null,
      signal: 'SIGTERM',
      stdout: 'ready\n',
      stderr: '',
    }
    await first.update(session.summary.id, (state) => { state.processes.push(record) })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'process.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'process.stopped')).toHaveLength(1)
    expect(events.find((event) => event.type === 'process.started')).toMatchObject({
      data: { recovered: true, record: { id: record.id, status: 'running' } },
    })
    expect(events.find((event) => event.type === 'process.stopped')).toMatchObject({
      data: { recovered: true, record: { id: record.id, status: 'stopped' } },
    })

    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('repairs a torn managed Website failure projection without duplicating it on later restarts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-website-state-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const startedAt = new Date(Date.now() - 1_000).toISOString()
    const stoppedAt = new Date().toISOString()
    const running = {
      id: 'proc_website000000001',
      command: 'npm run dev',
      pid: 999_999_993,
      port: 43130,
      portHint: 43130,
      status: 'running' as const,
      startedAt,
      stdout: 'ready\n',
      stderr: '',
    }
    const interrupted = {
      ...running,
      status: 'interrupted' as const,
      completedAt: stoppedAt,
      signal: 'SERVER_RESTART',
    }
    await first.append(session.summary.id, 'process.started', { type: 'started', record: running })
    await first.append(session.summary.id, 'process.stopped', { type: 'stopped', record: interrupted })
    await first.update(session.summary.id, (state) => {
      state.processes = [interrupted]
      state.website = {
        status: 'failed',
        processId: running.id,
        port: running.port,
        previewUrl: `http://127.0.0.1:${running.port}`,
        updatedAt: stoppedAt,
        restartCount: 0,
      }
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'website.updated')).toEqual([
      expect.objectContaining({
        data: {
          website: expect.objectContaining({ status: 'failed', processId: running.id }),
          action: 'projection_repaired',
          recovered: true,
        },
      }),
    ])

    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('materializes an event-only static Website projection exactly once', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-website-event-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const website = {
      status: 'running' as const,
      entryPath: 'index.html',
      previewUrl: `/workspace/${session.summary.id}/preview/index.html`,
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
      restartCount: 0,
    }
    await first.append(session.summary.id, 'website.updated', { website, action: 'published' }, {
      turnId: 'turn_website_event',
      stepId: 'step_website_event',
      callId: 'call_website_event',
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).website).toEqual(website)
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'website.updated')).toHaveLength(1)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        websiteReconciliation: {
          action: 'event_replayed',
          materializedFromEvent: true,
          reconstructedMissingEvent: false,
        },
      },
    })

    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('reconstructs a state-only static Website event exactly once', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-website-materialized-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const website = {
      status: 'running' as const,
      entryPath: 'index.html',
      previewUrl: `/workspace/${session.summary.id}/preview/index.html`,
      updatedAt: new Date().toISOString(),
      restartCount: 0,
    }
    await first.update(session.summary.id, (state) => { state.website = website })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    expect((await restarted.get(session.summary.id)).website).toEqual(website)
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'website.updated')).toEqual([
      expect.objectContaining({
        data: { website, action: 'projection_repaired', recovered: true },
      }),
    ])

    const eventCount = events.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('restores a hard-crashed visible partial into model context and closes the turn exactly once', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-partial-stream-crash-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const turnId = 'turn_partial_crash'
    const stepId = 'step_partial_crash'
    const partial = 'Visible prefix before '
      + 'the process was killed.\n'
    await first.setStatus(session.summary.id, 'running')
    await first.update(session.summary.id, (state) => {
      state.messages.push({ role: 'user', content: 'Stream a response and then crash.' })
    })
    await first.append(session.summary.id, 'turn.started', { content: 'Stream a response and then crash.' }, { turnId })
    await first.append(session.summary.id, 'run.status', { status: 'running' }, { turnId })
    await first.append(session.summary.id, 'assistant.started', { step: 1 }, { turnId, stepId })
    await first.append(session.summary.id, 'assistant.final.delta', { delta: 'Visible prefix before ' }, { turnId, stepId })
    await first.append(session.summary.id, 'assistant.final.delta', { delta: 'the process was killed.\n' }, { turnId, stepId })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    const events = await restarted.events(session.summary.id)
    expect(recovered.summary.status).toBe('interrupted')
    expect(recovered.messages).toEqual([
      { role: 'user', content: 'Stream a response and then crash.' },
      { role: 'assistant', content: partial },
    ])
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      expect.objectContaining({
        turnId,
        stepId,
        data: { status: 'interrupted', recovered: true },
      }),
    ])
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      turnId,
      stepId,
      data: { interrupted: true, cancelled: false, partialResponsePersisted: true },
    })
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        partialResponseReconciliation: {
          turnId,
          stepId,
          eventCount: 2,
          visibleBytes: Buffer.byteLength(partial),
          messageAppended: true,
          alreadyMaterialized: false,
        },
      },
    })
    expect(events.findLast((event) => event.type === 'run.status')).toMatchObject({
      turnId,
      stepId,
      data: { status: 'interrupted', recovered: true },
    })

    const eventCount = events.length
    const messageCount = recovered.messages.length
    const restartedAgain = new SessionStore(root, 'test-model')
    await restartedAgain.initialize()
    expect((await restartedAgain.get(session.summary.id)).messages).toHaveLength(messageCount)
    expect((await restartedAgain.events(session.summary.id))).toHaveLength(eventCount)
  })

  it('does not duplicate a visible partial already materialized before a hard crash', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-partial-materialized-crash-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const turnId = 'turn_partial_materialized'
    const stepId = 'step_partial_materialized'
    const partial = 'Already materialized partial.\n'
    await first.setStatus(session.summary.id, 'running')
    await first.update(session.summary.id, (state) => {
      state.messages.push(
        { role: 'user', content: 'Preserve the materialized response.' },
        { role: 'assistant', content: partial },
      )
    })
    await first.append(session.summary.id, 'turn.started', { content: 'Preserve the materialized response.' }, { turnId })
    await first.append(session.summary.id, 'run.status', { status: 'running' }, { turnId })
    await first.append(session.summary.id, 'assistant.started', { step: 1 }, { turnId, stepId })
    await first.append(session.summary.id, 'assistant.final.delta', { delta: partial }, { turnId, stepId })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.messages.filter((message) => message.role === 'assistant' && message.content === partial)).toHaveLength(1)
    expect((await restarted.events(session.summary.id)).find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        partialResponseReconciliation: {
          messageAppended: false,
          alreadyMaterialized: true,
        },
      },
    })
  })

  it('closes started-unknown and never-started tail tool calls without replaying side effects', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-tool-recovery-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const startedCall = { id: 'call_started_unknown', name: 'create_file', arguments: { path: 'marker.txt', content: 'possibly-written' } }
    await first.setStatus(session.summary.id, 'running')
    await first.update(session.summary.id, (state) => {
      state.messages.push(
        { role: 'user', content: 'Create two files.' },
        {
          role: 'assistant', content: null,
          tool_calls: [
            { id: startedCall.id, type: 'function', function: { name: startedCall.name, arguments: JSON.stringify(startedCall.arguments) } },
            { id: 'call_never_started', type: 'function', function: { name: 'delete_file', arguments: '{"path":"old.txt"}' } },
          ],
        },
      )
    })
    await first.append(session.summary.id, 'assistant.started', { step: 1 }, { turnId: 'turn_recovery', stepId: 'step_recovery' })
    await first.append(session.summary.id, 'tool.started', { call: startedCall }, {
      turnId: 'turn_recovery', stepId: 'step_recovery', callId: startedCall.id,
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.summary.status).toBe('interrupted')
    expect(recovered.summary.usage.toolCalls).toBe(1)
    expect(recovered.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(recovered.messages.slice(-2).map((message) => message.tool_call_id)).toEqual([
      'call_started_unknown', 'call_never_started',
    ])
    expect(recovered.messages.slice(-2).every((message) => message.tool_result_status === 'failed')).toBe(true)
    expect(JSON.parse(String(recovered.messages.at(-2)?.content))).toMatchObject({
      status: 'error', message: expect.stringContaining('outcome is unknown'),
    })
    expect(JSON.parse(String(recovered.messages.at(-1)?.content))).toMatchObject({
      status: 'error', message: expect.stringContaining('was not executed'),
    })

    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'tool.failed' && event.data.recovered)).toEqual([
      expect.objectContaining({
        callId: 'call_started_unknown',
        data: expect.objectContaining({
          reason: 'tool_outcome_unknown_after_restart', outcomeUnknown: true, notExecuted: false,
        }),
      }),
      expect.objectContaining({
        callId: 'call_never_started',
        data: expect.objectContaining({
          reason: 'tool_not_started_after_restart', outcomeUnknown: false, notExecuted: true,
        }),
      }),
    ])
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        repairedToolCalls: [
          { callId: 'call_started_unknown', name: 'create_file', resolution: 'outcome_unknown' },
          { callId: 'call_never_started', name: 'delete_file', resolution: 'not_started' },
        ],
      },
    })

    const recoveredMessageCount = recovered.messages.length
    const secondRestart = new SessionStore(root, 'test-model')
    await secondRestart.initialize()
    expect((await secondRestart.get(session.summary.id)).messages).toHaveLength(recoveredMessageCount)
    expect((await secondRestart.events(session.summary.id)).filter((event) => event.type === 'session.recovered')).toHaveLength(1)
  })

  it('reconstructs a missing provider tool result from a durable terminal event', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-tool-terminal-recovery-'))
    roots.push(root)
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    const call = { id: 'call_durable_terminal', name: 'read_file', arguments: { path: 'evidence.txt' } }
    const durableResult = JSON.stringify({
      status: 'success',
      file: { path: 'evidence.txt', content: 'durable evidence\n', contentType: 'text/plain' },
      totalLines: 1,
    })
    await first.setStatus(session.summary.id, 'running')
    await first.update(session.summary.id, (state) => {
      state.messages.push(
        { role: 'user', content: 'Read the evidence.' },
        {
          role: 'assistant', content: null,
          tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }],
        },
      )
      state.summary.usage.toolCalls += 1
    })
    await first.append(session.summary.id, 'assistant.started', { step: 1 }, { turnId: 'turn_terminal', stepId: 'step_terminal' })
    await first.append(session.summary.id, 'tool.started', { call }, {
      turnId: 'turn_terminal', stepId: 'step_terminal', callId: call.id,
    })
    await first.append(session.summary.id, 'tool.completed', { call, result: durableResult, isError: false }, {
      turnId: 'turn_terminal', stepId: 'step_terminal', callId: call.id,
    })

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.messages.at(-1)).toEqual({
      role: 'tool', tool_call_id: call.id, content: durableResult, tool_result_status: 'succeeded',
    })
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.type === 'tool.failed')).toHaveLength(0)
    expect(events.find((event) => event.type === 'session.recovered')).toMatchObject({
      data: {
        repairedToolCalls: [{ callId: call.id, name: call.name, resolution: 'durable_terminal' }],
      },
    })
  })

  it('accumulates active execution time while excluding approval and between-turn waits', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T00:00:00.000Z'))
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()

    vi.setSystemTime(new Date('2026-08-28T00:00:01.000Z'))
    await store.setStatus(session.summary.id, 'running')
    vi.setSystemTime(new Date('2026-08-28T00:00:04.000Z'))
    await store.setStatus(session.summary.id, 'awaiting_approval')
    vi.setSystemTime(new Date('2026-08-28T00:00:10.000Z'))
    await store.setStatus(session.summary.id, 'running')
    vi.setSystemTime(new Date('2026-08-28T00:00:12.000Z'))
    await store.setStatus(session.summary.id, 'completed')

    expect((await store.get(session.summary.id)).summary.usage).toMatchObject({
      startedAt: '2026-08-28T00:00:01.000Z',
      completedAt: '2026-08-28T00:00:12.000Z',
      activeDurationMs: 5_000,
      durationMs: 5_000,
    })
  })

  it('replaces the host workspace root in visible event and summary text', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-store-path-redaction-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const workspace = store.workspaceDir(session.summary.id)
    await store.append(session.summary.id, 'tool.completed', {
      call: { id: 'call_pwd', name: 'shell_command', arguments: { command: 'pwd', workdir: 'sub' } },
      result: JSON.stringify({ status: 'success', stdout: `${workspace}/sub\n` }),
      isError: false,
    })

    const visible = await store.events(session.summary.id)
    expect(JSON.stringify(visible)).not.toContain(workspace)
    expect(JSON.stringify(visible)).toContain('<workspace>/sub')
    expect(store.redactTextForDisplay(session.summary.id, `Built in ${workspace}/dist`)).toBe('Built in <workspace>/dist')
  })
})
