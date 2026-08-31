import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '../shared/types.js'
import { createApp } from './app.js'
import { SessionStore } from './session-store.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryDataRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-undo-api-'))
  roots.push(root)
  return resolve(root, 'data')
}

async function listen(app: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function postCheckIn(base: string, sessionId: string, sessionNodeId: string, action: string): Promise<Response> {
  return fetch(`${base}/api/chat/${sessionId}/review-feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionNodeId, recaptchaV3Token: null, action }),
  })
}

function postUndo(base: string, sessionId: string, sessionNodeId: unknown, type: unknown = 'undo'): Promise<Response> {
  return fetch(`${base}/api/chat/${sessionId}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, sessionNodeId, recaptchaV3Token: null }),
  })
}

async function seedCompletedTurn(
  created: Awaited<ReturnType<typeof createApp>>,
  options: { compacted?: boolean; feedbackType?: 'check_in' | 'task_completion_bar' } = {},
) {
  const session = await created.store.create({ feedbackType: options.feedbackType ?? 'check_in' })
  const sessionId = session.summary.id
  const priorTurnId = 'turn_undo_prior'
  const targetTurnId = 'turn_undo_target'
  await created.store.append(sessionId, 'turn.started', { content: 'Earlier prompt', attachments: [] }, { turnId: priorTurnId })
  await created.store.append(sessionId, 'assistant.final', { content: 'Earlier answer', finishReason: 'stop' }, { turnId: priorTurnId, stepId: 'step_prior' })
  await created.store.append(sessionId, 'turn.started', { content: 'Original prompt to revise', attachments: ['uploads/reference.txt'] }, { turnId: targetTurnId })
  if (options.compacted) {
    await created.store.append(sessionId, 'context.compacted', { summary: 'Checkpoint', compactedMessageCount: 2 }, { turnId: targetTurnId, stepId: 'step_target' })
  }
  await created.store.append(sessionId, 'tool.started', {
    call: { id: 'call_undo_probe', name: 'read_file', arguments: { path: 'reference.txt' } },
  }, { turnId: targetTurnId, stepId: 'step_target', callId: 'call_undo_probe' })
  await created.store.append(sessionId, 'tool.completed', {
    call: { id: 'call_undo_probe', name: 'read_file', arguments: { path: 'reference.txt' } }, result: 'read', isError: false,
  }, { turnId: targetTurnId, stepId: 'step_target', callId: 'call_undo_probe' })
  const final = await created.store.append(sessionId, 'assistant.final', {
    content: 'Answer to undo', finishReason: 'stop',
  }, { turnId: targetTurnId, stepId: 'step_target' })
  await created.store.append(sessionId, 'review.requested', {
    messageEventId: final.id,
    model: 'test-model',
    feedbackType: options.feedbackType ?? 'check_in',
  }, { turnId: targetTurnId, stepId: 'step_target' })
  await created.store.update(sessionId, (state) => {
    state.summary.status = 'completed'
    state.messages = [
      { role: 'user', content: 'Earlier prompt' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Original prompt to revise\n\n<arena-system-message>\nUploaded workspace files:\n- uploads/reference.txt\n</arena-system-message>' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_undo_probe', type: 'function', function: { name: 'read_file', arguments: '{"path":"reference.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_undo_probe', content: 'read', tool_result_status: 'succeeded' },
      { role: 'assistant', content: 'Answer to undo' },
    ]
    state.turnMessageStarts = { [priorTurnId]: 0, [targetTurnId]: 2 }
  })
  return { sessionId, priorTurnId, targetTurnId, final }
}

describe('Arena undo-last-turn action', () => {
  it('rewinds the private model context, retains raw history, and settles concurrent retries once', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const seeded = await seedCompletedTurn(created)
    const base = await listen(created.app)
    try {
      const feedback = await postCheckIn(base, seeded.sessionId, seeded.final.id, 'disapprove')
      expect(feedback.status).toBe(200)

      const responses = await Promise.all([
        postUndo(base, seeded.sessionId, seeded.final.id),
        postUndo(base, seeded.sessionId, seeded.final.id),
      ])
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      const bodies = await Promise.all(responses.map(async (response) => await response.json() as Record<string, unknown>))
      expect(bodies).toEqual([expect.objectContaining({
        type: 'undo',
        sessionNodeId: seeded.final.id,
        targetTurnIds: [seeded.targetTurnId],
        promptText: 'Original prompt to revise',
        workspaceReverted: false,
      }), expect.objectContaining({
        type: 'undo',
        sessionNodeId: seeded.final.id,
        targetTurnIds: [seeded.targetTurnId],
        promptText: 'Original prompt to revise',
        workspaceReverted: false,
      })])

      const state = await created.store.get(seeded.sessionId)
      expect(state.messages).toEqual([
        { role: 'user', content: 'Earlier prompt' },
        { role: 'assistant', content: 'Earlier answer' },
      ])
      expect(state.turnMessageStarts).toEqual({ [seeded.priorTurnId]: 0 })
      expect(state.pendingTurnUndo).toBeUndefined()
      const events = await created.store.events(seeded.sessionId)
      const undoEvents = events.filter((event) => event.type === 'turn.undone')
      expect(undoEvents).toHaveLength(1)
      expect(undoEvents[0]).toMatchObject({
        turnId: seeded.targetTurnId,
        data: {
          sessionNodeId: seeded.final.id,
          targetTurnIds: [seeded.targetTurnId],
          promptRestored: true,
          attachmentsCleared: true,
          feedbackPreserved: true,
          workspaceReverted: false,
        },
      })
      expect(events.some((event) => event.id === seeded.final.id)).toBe(true)
      expect(events.some((event) => event.type === 'feedback.updated' && (event.data as { checkInAction?: string }).checkInAction === 'disapprove')).toBe(true)

      const canonical = await fetch(`${base}/api/sessions/${seeded.sessionId}/canonical.jsonl?task_id=R01`).then((response) => response.text())
      const records = canonical.trim().split('\n').map((line) => JSON.parse(line) as { recordType?: string; event?: { action?: string; payload?: unknown } })
      expect(records.find((record) => record.event?.action === 'undo_last_turn')?.event).toMatchObject({
        action: 'undo_last_turn',
        payload: { promptRestored: true, feedbackPreserved: true, workspaceReverted: false },
      })
    } finally {
      await created.agent.shutdown()
    }
  })

  it('requires check-in No and rejects malformed, wrong-cohort, and post-compaction actions without rewinding', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const plain = await seedCompletedTurn(created)
    const compacted = await seedCompletedTurn(created, { compacted: true })
    const completion = await seedCompletedTurn(created, { feedbackType: 'task_completion_bar' })
    const base = await listen(created.app)
    try {
      const malformed = await postUndo(base, plain.sessionId, plain.final.id, 'rewind')
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toEqual({ error: 'type must be undo' })

      const beforeNo = await postUndo(base, plain.sessionId, plain.final.id)
      expect(beforeNo.status).toBe(409)
      expect(await beforeNo.json()).toEqual({ error: 'The last turn is not awaiting undo after disapprove feedback' })

      const wrongCohort = await postUndo(base, completion.sessionId, completion.final.id)
      expect(wrongCohort.status).toBe(409)
      expect(await wrongCohort.json()).toEqual({ error: 'Session does not use check_in feedback' })

      expect((await postCheckIn(base, compacted.sessionId, compacted.final.id, 'disapprove')).status).toBe(200)
      const blocked = await postUndo(base, compacted.sessionId, compacted.final.id)
      expect(blocked.status).toBe(409)
      expect(await blocked.json()).toEqual({ error: 'The last turn cannot be undone after a context checkpoint' })
      expect((await created.store.get(compacted.sessionId)).messages).toHaveLength(6)
      expect((await created.store.events(compacted.sessionId)).filter((event) => event.type === 'turn.undone')).toHaveLength(0)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('finishes a checkpointed undo publication exactly once after restart', async () => {
    const dataRoot = await temporaryDataRoot()
    const store = new SessionStore(dataRoot, 'test-model')
    await store.initialize()
    const session = await store.create()
    const eventId = 'evt_11111111111111111111'
    await store.update(session.summary.id, (state) => {
      state.messages = []
      state.pendingTurnUndo = {
        id: 'undo_11111111111111111111',
        eventId,
        sessionNodeId: 'evt_22222222222222222222',
        targetTurnIds: ['turn_recovery'],
        promptText: 'Recovered prompt',
        messageCountAfter: 0,
        eventData: {
          sessionNodeId: 'evt_22222222222222222222',
          targetTurnIds: ['turn_recovery'],
          promptRestored: true,
          attachmentsCleared: true,
          feedbackPreserved: true,
          workspaceReverted: false,
        },
        createdAt: '2026-08-29T00:00:00.000Z',
      }
    })

    const restarted = new SessionStore(dataRoot, 'test-model')
    await restarted.initialize()
    const recovered = await restarted.get(session.summary.id)
    expect(recovered.pendingTurnUndo).toBeUndefined()
    const events = await restarted.events(session.summary.id)
    expect(events.filter((event) => event.id === eventId)).toHaveLength(1)
    const recovery = [...events].reverse().find((event) => event.type === 'session.recovered') as SessionEvent | undefined
    expect(recovery?.data).toMatchObject({
      recoveredPendingTurnUndo: {
        eventId,
        reconstructedEvent: true,
        targetTurnIds: ['turn_recovery'],
      },
    })
  })
})
