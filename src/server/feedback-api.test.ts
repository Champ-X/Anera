import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionSnapshot } from '../shared/types.js'
import { ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE } from './agent-service.js'
import { createApp } from './app.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryDataRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-feedback-api-'))
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

function postFeedback(base: string, sessionId: string, messageEventId: string, value: unknown): Promise<Response> {
  return fetch(`${base}/api/sessions/${sessionId}/messages/${messageEventId}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  })
}

function postReview(base: string, sessionId: string, messageEventId: string, action: unknown): Promise<Response> {
  return fetch(`${base}/api/sessions/${sessionId}/messages/${messageEventId}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
}

function postTaskCompletion(base: string, sessionId: string, sessionNodeId: unknown, type: unknown, value: unknown): Promise<Response> {
  return fetch(`${base}/api/chat/${sessionId}/review-feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionNodeId, recaptchaV3Token: null, feedback: { type, value } }),
  })
}

function postCheckIn(base: string, sessionId: string, sessionNodeId: unknown, action: unknown): Promise<Response> {
  return fetch(`${base}/api/chat/${sessionId}/review-feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionNodeId, recaptchaV3Token: null, action }),
  })
}

function completedModelResponse(content: string) {
  return {
    content,
    reasoningContent: '',
    toolCalls: [],
    finishReason: 'stop' as const,
    usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24, cachedPromptTokens: 0 },
  }
}

async function seedCustomFeedbackTarget(created: Awaited<ReturnType<typeof createApp>>) {
  const session = await created.store.create({ customFeedbackArm: 'treatment-1' })
  const final = await created.store.append(session.summary.id, 'assistant.final', {
    content: 'Original response.', finishReason: 'stop',
  }, { turnId: 'turn_custom_transport_source', stepId: 'step_custom_transport_source' })
  await created.store.append(session.summary.id, 'review.requested', {
    messageEventId: final.id, feedbackType: 'check_in', model: 'test-model',
  }, { turnId: final.turnId, stepId: final.stepId })
  await created.store.append(session.summary.id, 'review.dismissed', {
    sessionNodeId: final.id,
    messageEventId: final.id,
    action: 'continue',
    checkInAction: 'edit',
    feedback: { type: 'check_in', value: 'edit' },
    model: 'test-model',
  }, { turnId: final.turnId, stepId: final.stepId })
  await created.store.update(session.summary.id, (state) => { state.summary.status = 'completed' })
  return { session, final }
}

function structuredCustomFeedbackBody(reviewedNodeId: string, content = 'Use the title Q3 Review.') {
  return {
    message: {
      parts: [
        {
          type: 'data-custom-feedback',
          data: { systemMessage: ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE, reviewedNodeId },
        },
        { type: 'text', text: content },
      ],
    },
    metadata: { timezone: 'Asia/Shanghai', submissionSource: 'chat_input' },
    v2Source: 'agentic_chat_submit',
    model: null,
    enabledConnectorSlugs: [],
  }
}

async function waitForCompleted(created: Awaited<ReturnType<typeof createApp>>, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await created.store.get(sessionId)).summary.status === 'completed') return
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  throw new Error('Agent turn did not complete')
}

describe('Arena pointwise feedback API contract', () => {
  it('rejects an invalid value and unknown or non-Final message targets', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create()
    const turn = await created.store.append(session.summary.id, 'turn.started', {
      content: 'A test turn.', attachments: [],
    }, { turnId: 'turn_feedback_validation' })
    const base = await listen(created.app)
    try {
      const invalid = await postFeedback(base, session.summary.id, turn.id, 'tie')
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: 'value must be upvote, downvote, or null' })

      for (const messageEventId of [turn.id, 'evt_99999999999999999999']) {
        const missing = await postFeedback(base, session.summary.id, messageEventId, 'upvote')
        expect(missing.status).toBe(404)
        expect(await missing.json()).toEqual({ error: 'Final message not found' })
      }
      expect((await created.store.events(session.summary.id)).filter((event) => event.type === 'feedback.updated')).toHaveLength(0)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('appends, replaces, clears, and idempotently preserves feedback with Final correlation', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create()
    const turnId = 'turn_feedback_roundtrip'
    const stepId = 'step_feedback_final'
    const final = await created.store.append(session.summary.id, 'assistant.final', {
      content: 'Delivered response.', finishReason: 'stop',
    }, { turnId, stepId })
    const base = await listen(created.app)
    try {
      const upvote = await postFeedback(base, session.summary.id, final.id, 'upvote')
      expect(upvote.status).toBe(200)
      expect(await upvote.json()).toEqual({ messageEventId: final.id, value: 'upvote' })

      const idempotent = await postFeedback(base, session.summary.id, final.id, 'upvote')
      expect(idempotent.status).toBe(200)
      expect((await created.store.events(session.summary.id)).filter((event) => event.type === 'feedback.updated')).toHaveLength(1)

      expect((await postFeedback(base, session.summary.id, final.id, 'downvote')).status).toBe(200)
      expect((await postFeedback(base, session.summary.id, final.id, null)).status).toBe(200)

      const feedback = (await created.store.events(session.summary.id)).filter((event) => event.type === 'feedback.updated')
      expect(feedback).toHaveLength(3)
      expect(feedback.map((event) => (event.data as { value: unknown }).value)).toEqual(['upvote', 'downvote', null])
      expect(feedback).toMatchObject([
        { turnId, stepId, data: { messageEventId: final.id, value: 'upvote', model: 'test-model' } },
        { turnId, stepId, data: { messageEventId: final.id, value: 'downvote', model: 'test-model' } },
        { turnId, stepId, data: { messageEventId: final.id, value: null, model: 'test-model' } },
      ])

      const refreshed = await fetch(`${base}/api/sessions/${session.summary.id}`)
      expect(refreshed.status).toBe(200)
      const snapshot = await refreshed.json() as SessionSnapshot
      expect(snapshot.events.filter((event) => event.type === 'feedback.updated')).toEqual(feedback)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('exports each feedback transition in the canonical operator timeline', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create()
    const final = await created.store.append(session.summary.id, 'assistant.final', {
      content: 'Canonical response.', finishReason: 'stop',
    }, { turnId: 'turn_feedback_export', stepId: 'step_feedback_export' })
    const base = await listen(created.app)
    try {
      for (const value of ['upvote', 'downvote', null] as const) {
        expect((await postFeedback(base, session.summary.id, final.id, value)).status).toBe(200)
      }
      const exported = await fetch(`${base}/api/sessions/${session.summary.id}/canonical.jsonl?task_id=A01`)
      expect(exported.status).toBe(200)
      const records = (await exported.text()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      const actions = records
        .filter((record) => record.recordType === 'event')
        .map((record) => record.event as SessionEvent & { kind?: string; action?: string })
        .filter((event) => event.kind === 'operator_action')
      expect(actions.map((event) => event.action)).toEqual(['upvote', 'downvote', 'feedback_cleared'])
      expect(actions.every((event) => event.turnId === 'T01' && event.stepId === 'S01')).toBe(true)
    } finally {
      await created.agent.shutdown()
    }
  })
})

describe('Arena task review API contract', () => {
  it('rejects invalid actions and unknown or non-Final targets', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create()
    const turn = await created.store.append(session.summary.id, 'turn.started', {
      content: 'A review validation turn.', attachments: [],
    }, { turnId: 'turn_review_validation' })
    const base = await listen(created.app)
    try {
      const invalid = await postReview(base, session.summary.id, turn.id, 'resume')
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: 'action must be continue or dismiss' })

      for (const messageEventId of [turn.id, 'evt_99999999999999999999']) {
        const missing = await postReview(base, session.summary.id, messageEventId, 'dismiss')
        expect(missing.status).toBe(404)
        expect(await missing.json()).toEqual({ error: 'Final message not found' })
      }
      expect((await created.store.events(session.summary.id)).filter((event) => event.type === 'review.dismissed')).toHaveLength(0)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('durably dismisses a Final exactly once with turn, step, and model correlation', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create()
    const turnId = 'turn_review_roundtrip'
    const stepId = 'step_review_final'
    const final = await created.store.append(session.summary.id, 'assistant.final', {
      content: 'Delivered response.', finishReason: 'stop',
    }, { turnId, stepId })
    const base = await listen(created.app)
    try {
      const continued = await postReview(base, session.summary.id, final.id, 'continue')
      expect(continued.status).toBe(200)
      expect(await continued.json()).toEqual({ messageEventId: final.id, action: 'continue' })

      const idempotent = await postReview(base, session.summary.id, final.id, 'continue')
      expect(idempotent.status).toBe(200)
      expect(await idempotent.json()).toEqual({ messageEventId: final.id, action: 'continue' })

      const alreadyDismissed = await postReview(base, session.summary.id, final.id, 'dismiss')
      expect(alreadyDismissed.status).toBe(200)
      expect(await alreadyDismissed.json()).toEqual({ messageEventId: final.id, action: 'continue' })

      const reviews = (await created.store.events(session.summary.id)).filter((event) => event.type === 'review.dismissed')
      expect(reviews).toEqual([expect.objectContaining({
        turnId,
        stepId,
        data: { messageEventId: final.id, action: 'continue', model: 'test-model' },
      })])

      const refreshed = await fetch(`${base}/api/sessions/${session.summary.id}`)
      expect(refreshed.status).toBe(200)
      const snapshot = await refreshed.json() as SessionSnapshot
      expect(snapshot.events.filter((event) => event.type === 'review.dismissed')).toEqual(reviews)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('exports Continue working and close dismissal separately from run resume', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create()
    const first = await created.store.append(session.summary.id, 'assistant.final', {
      content: 'First review.', finishReason: 'stop',
    }, { turnId: 'turn_review_continue', stepId: 'step_review_continue' })
    const second = await created.store.append(session.summary.id, 'assistant.final', {
      content: 'Second review.', finishReason: 'stop',
    }, { turnId: 'turn_review_dismiss', stepId: 'step_review_dismiss' })
    const base = await listen(created.app)
    try {
      expect((await postReview(base, session.summary.id, first.id, 'continue')).status).toBe(200)
      expect((await postReview(base, session.summary.id, second.id, 'dismiss')).status).toBe(200)
      const exported = await fetch(`${base}/api/sessions/${session.summary.id}/canonical.jsonl?task_id=U03`)
      expect(exported.status).toBe(200)
      const records = (await exported.text()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      const actions = records
        .filter((record) => record.recordType === 'event')
        .map((record) => record.event as SessionEvent & { kind?: string; action?: string })
        .filter((event) => event.kind === 'operator_action')
      expect(actions.map((event) => event.action)).toEqual(['continue_working', 'task_review_dismissed'])
      expect(actions.map((event) => event.turnId)).toEqual(['T01', 'T02'])
      expect(actions.map((event) => event.stepId)).toEqual(['S01', 'S02'])
    } finally {
      await created.agent.shutdown()
    }
  })
})

describe('Arena check_in review-feedback transport', () => {
  it('rejects malformed actions, the wrong cohort, and a Final without matching review metadata', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const checkIn = await created.store.create()
    const unreviewed = await created.store.append(checkIn.summary.id, 'assistant.final', {
      content: 'No check-in review metadata.', finishReason: 'stop',
    }, { turnId: 'turn_check_in_unreviewed', stepId: 'step_check_in_unreviewed' })
    await created.store.update(checkIn.summary.id, (state) => { state.summary.status = 'completed' })
    const completion = await created.store.create({ feedbackType: 'task_completion_bar' })
    const completionFinal = await created.store.append(completion.summary.id, 'assistant.final', {
      content: 'Task-completion cohort.', finishReason: 'stop',
    }, { turnId: 'turn_check_in_wrong_cohort', stepId: 'step_check_in_wrong_cohort' })
    const base = await listen(created.app)
    try {
      const malformed = await postCheckIn(base, checkIn.summary.id, unreviewed.id, 'continue')
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toEqual({ error: 'action must be approve, disapprove, edit, or escape' })

      const wrongCohort = await postCheckIn(base, completion.summary.id, completionFinal.id, 'approve')
      expect(wrongCohort.status).toBe(409)
      expect(await wrongCohort.json()).toEqual({ error: 'Session does not use check_in feedback' })

      const noReview = await postCheckIn(base, checkIn.summary.id, unreviewed.id, 'approve')
      expect(noReview.status).toBe(409)
      expect(await noReview.json()).toEqual({ error: 'Final message is not awaiting check-in feedback' })
      expect((await created.store.events(checkIn.summary.id)).filter((event) => (
        event.type === 'feedback.updated' || event.type === 'review.dismissed'
      ))).toHaveLength(0)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('maps all four public actions once, persists them, and exports isolated canonical operator actions', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const base = await listen(created.app)
    const probes = [
      { action: 'approve', eventType: 'feedback.updated', field: 'value', durableValue: 'upvote', canonical: 'upvote' },
      { action: 'disapprove', eventType: 'feedback.updated', field: 'value', durableValue: 'downvote', canonical: 'downvote' },
      { action: 'edit', eventType: 'review.dismissed', field: 'action', durableValue: 'continue', canonical: 'continue_working' },
      { action: 'escape', eventType: 'review.dismissed', field: 'action', durableValue: 'dismiss', canonical: 'task_review_dismissed' },
    ] as const
    try {
      for (const probe of probes) {
        const session = await created.store.create({ feedbackType: 'check_in' })
        const turnId = `turn_check_in_${probe.action}`
        const stepId = `step_check_in_${probe.action}`
        const final = await created.store.append(session.summary.id, 'assistant.final', {
          content: `Check-in response ${probe.action}.`, finishReason: 'stop',
        }, { turnId, stepId })
        await created.store.append(session.summary.id, 'review.requested', {
          messageEventId: final.id, model: 'test-model', feedbackType: 'check_in',
        }, { turnId, stepId })
        await created.store.update(session.summary.id, (state) => { state.summary.status = 'completed' })

        const recorded = await postCheckIn(base, session.summary.id, final.id, probe.action)
        expect(recorded.status).toBe(200)
        expect(await recorded.json()).toEqual({ sessionNodeId: final.id, action: probe.action })
        const idempotent = await postCheckIn(base, session.summary.id, final.id, probe.action === 'approve' ? 'edit' : 'approve')
        expect(idempotent.status).toBe(200)
        expect((await idempotent.json() as { action: string }).action).toBe(probe.action)

        const events = (await created.store.events(session.summary.id)).filter((event) => (
          (event.type === 'feedback.updated' || event.type === 'review.dismissed')
          && (event.data as { messageEventId?: string }).messageEventId === final.id
        ))
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          type: probe.eventType,
          turnId,
          stepId,
          data: {
            sessionNodeId: final.id,
            messageEventId: final.id,
            [probe.field]: probe.durableValue,
            checkInAction: probe.action,
            feedback: { type: 'check_in', value: probe.action },
            model: 'test-model',
          },
        })

        const refreshed = await fetch(`${base}/api/sessions/${session.summary.id}`).then((response) => response.json()) as SessionSnapshot
        expect(refreshed.events.filter((event) => event.id === events[0]?.id)).toEqual(events)
        const exported = await fetch(`${base}/api/sessions/${session.summary.id}/canonical.jsonl?task_id=A01`)
        const records = (await exported.text()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
        const actions = records
          .filter((record) => record.recordType === 'event')
          .map((record) => record.event as SessionEvent & { kind?: string; action?: string })
        expect(actions.find((event) => event.action === probe.canonical)).toMatchObject({
          kind: 'operator_action', turnId: 'T01', stepId: 'S01', status: 'succeeded',
        })
        expect(actions.some((event) => String(event.action).startsWith('task_completion_'))).toBe(false)
      }
    } finally {
      await created.agent.shutdown()
    }
  })

  it('atomically settles concurrent actions even when they map to different event types', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create({ feedbackType: 'check_in' })
    const final = await created.store.append(session.summary.id, 'assistant.final', {
      content: 'Concurrent check-in response.', finishReason: 'stop',
    }, { turnId: 'turn_check_in_concurrent', stepId: 'step_check_in_concurrent' })
    await created.store.append(session.summary.id, 'review.requested', {
      messageEventId: final.id, model: 'test-model', feedbackType: 'check_in',
    }, { turnId: final.turnId, stepId: final.stepId })
    await created.store.update(session.summary.id, (state) => { state.summary.status = 'completed' })
    const base = await listen(created.app)
    try {
      const responses = await Promise.all([
        postCheckIn(base, session.summary.id, final.id, 'approve'),
        postCheckIn(base, session.summary.id, final.id, 'edit'),
      ])
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      const bodies = await Promise.all(responses.map(async (response) => await response.json() as { action: string }))
      expect(new Set(bodies.map((body) => body.action)).size).toBe(1)
      const events = (await created.store.events(session.summary.id)).filter((event) => terminalReviewEvent(event, final.id))
      expect(events).toHaveLength(1)
    } finally {
      await created.agent.shutdown()
    }
  })
})

describe('Arena task completion bar API contract', () => {
  it('rejects malformed feedback, the wrong session cohort, and a Final that is not awaiting feedback', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const checkIn = await created.store.create()
    const final = await created.store.append(checkIn.summary.id, 'assistant.final', {
      content: 'Check-in response.', finishReason: 'stop',
    }, { turnId: 'turn_completion_wrong_cohort', stepId: 'step_completion_wrong_cohort' })
    const completion = await created.store.create({ feedbackType: 'task_completion_bar' })
    const unreviewed = await created.store.append(completion.summary.id, 'assistant.final', {
      content: 'No review metadata.', finishReason: 'stop',
    }, { turnId: 'turn_completion_unreviewed', stepId: 'step_completion_unreviewed' })
    await created.store.update(completion.summary.id, (state) => { state.summary.status = 'completed' })
    const base = await listen(created.app)
    try {
      const malformed = await postTaskCompletion(base, completion.summary.id, unreviewed.id, 'task_completion_bar', 'partial')
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toEqual({ error: 'feedback must be task_completion_bar with value no, making_progress, or yes' })

      const wrongCohort = await postTaskCompletion(base, checkIn.summary.id, final.id, 'task_completion_bar', 'yes')
      expect(wrongCohort.status).toBe(409)
      expect(await wrongCohort.json()).toEqual({ error: 'Session does not use task_completion_bar feedback' })

      const noReview = await postTaskCompletion(base, completion.summary.id, unreviewed.id, 'task_completion_bar', 'yes')
      expect(noReview.status).toBe(409)
      expect(await noReview.json()).toEqual({ error: 'Final message is not awaiting task completion feedback' })
      expect((await created.store.events(completion.summary.id)).filter((event) => event.type === 'task.completion.updated')).toHaveLength(0)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('durably records each value with Final correlation, first-write idempotency, refresh recovery, and canonical isolation', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const base = await listen(created.app)
    try {
      for (const value of ['no', 'making_progress', 'yes'] as const) {
        const session = await created.store.create({ feedbackType: 'task_completion_bar' })
        const turnId = `turn_completion_${value}`
        const stepId = `step_completion_${value}`
        const final = await created.store.append(session.summary.id, 'assistant.final', {
          content: `Completion response ${value}.`, finishReason: 'stop',
        }, { turnId, stepId })
        await created.store.append(session.summary.id, 'review.requested', {
          messageEventId: final.id, model: 'test-model', feedbackType: 'task_completion_bar',
        }, { turnId, stepId })
        await created.store.update(session.summary.id, (state) => { state.summary.status = 'completed' })

        const recorded = await postTaskCompletion(base, session.summary.id, final.id, 'task_completion_bar', value)
        expect(recorded.status).toBe(200)
        expect(await recorded.json()).toEqual({
          sessionNodeId: final.id,
          feedback: { type: 'task_completion_bar', value },
        })
        const idempotent = await postTaskCompletion(base, session.summary.id, final.id, 'task_completion_bar', value === 'yes' ? 'no' : 'yes')
        expect(idempotent.status).toBe(200)
        expect((await idempotent.json() as { feedback: { value: string } }).feedback.value).toBe(value)

        const events = (await created.store.events(session.summary.id)).filter((event) => event.type === 'task.completion.updated')
        expect(events).toEqual([expect.objectContaining({
          turnId,
          stepId,
          data: {
            sessionNodeId: final.id,
            messageEventId: final.id,
            value,
            feedback: { type: 'task_completion_bar', value },
            model: 'test-model',
          },
        })])
        const refreshed = await fetch(`${base}/api/sessions/${session.summary.id}`).then((response) => response.json()) as SessionSnapshot
        expect(refreshed.session.feedbackType).toBe('task_completion_bar')
        expect(refreshed.events.filter((event) => event.type === 'task.completion.updated')).toEqual(events)

        const exported = await fetch(`${base}/api/sessions/${session.summary.id}/canonical.jsonl?task_id=A01`)
        const records = (await exported.text()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
        const actions = records
          .filter((record) => record.recordType === 'event')
          .map((record) => record.event as SessionEvent & { kind?: string; action?: string })
        expect(actions.find((event) => event.action === 'task_completion_bar_required')).toBeDefined()
        expect(actions.find((event) => event.action === `task_completion_${value}`)).toMatchObject({
          kind: 'operator_action', turnId: 'T01', stepId: 'S01', status: 'succeeded',
        })
        expect(actions.some((event) => event.action === 'upvote' || event.action === 'downvote' || event.action === 'continue_working')).toBe(false)
      }
    } finally {
      await created.agent.shutdown()
    }
  })

  it('settles concurrent first writes to one durable value', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create({ feedbackType: 'task_completion_bar' })
    const final = await created.store.append(session.summary.id, 'assistant.final', {
      content: 'Concurrent completion response.', finishReason: 'stop',
    }, { turnId: 'turn_completion_concurrent', stepId: 'step_completion_concurrent' })
    await created.store.append(session.summary.id, 'review.requested', {
      messageEventId: final.id, model: 'test-model', feedbackType: 'task_completion_bar',
    }, { turnId: final.turnId, stepId: final.stepId })
    await created.store.update(session.summary.id, (state) => { state.summary.status = 'completed' })
    const base = await listen(created.app)
    try {
      const responses = await Promise.all([
        postTaskCompletion(base, session.summary.id, final.id, 'task_completion_bar', 'no'),
        postTaskCompletion(base, session.summary.id, final.id, 'task_completion_bar', 'yes'),
      ])
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      const bodies = await Promise.all(responses.map(async (response) => (
        await response.json() as { feedback: { value: string } }
      )))
      expect(new Set(bodies.map((body) => body.feedback.value)).size).toBe(1)

      const events = (await created.store.events(session.summary.id))
        .filter((event) => event.type === 'task.completion.updated')
      expect(events).toHaveLength(1)
      expect(bodies[0]?.feedback.value).toBe((events[0]?.data as { value?: string }).value)
    } finally {
      await created.agent.shutdown()
    }
  })
})

describe('Arena custom feedback message transport', () => {
  it('accepts Arena-shaped parts and keeps the trusted marker out of visible durable content', async () => {
    let modelMessages: Array<{ role: string; content?: string | null }> = []
    const stream = vi.fn(async (options: { messages: Array<{ role: string; content?: string | null }>; onContent: (delta: string) => void }) => {
      modelMessages = options.messages
      options.onContent('Corrected response.')
      return completedModelResponse('Corrected response.')
    })
    const created = await createApp({
      dataRoot: await temporaryDataRoot(),
      model: 'test-model',
      agent: { client: { stream } as never, runTimeoutMs: 1_000 },
    })
    const { session, final } = await seedCustomFeedbackTarget(created)
    const base = await listen(created.app)
    try {
      const response = await fetch(`${base}/api/sessions/${session.summary.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(structuredCustomFeedbackBody(final.id)),
      })
      expect(response.status).toBe(202)
      await waitForCompleted(created, session.summary.id)

      const started = (await created.store.events(session.summary.id)).findLast((event) => event.type === 'turn.started')
      expect(started).toMatchObject({
        data: {
          content: 'Use the title Q3 Review.',
          attachments: [],
          reviewedNodeId: final.id,
          customFeedbackTurn: true,
          has_feedback: true,
        },
      })
      expect(JSON.stringify(started?.data)).not.toContain(ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE)
      expect(modelMessages.at(-1)?.content).toMatch(new RegExp(`^<arena-system-message>\\n${ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n</arena-system-message>`))
    } finally {
      await created.agent.shutdown()
    }
  })

  it('rejects a wrong marker, wrong order, duplicate part, malformed data, unknown data, and envelope drift', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const { session, final } = await seedCustomFeedbackTarget(created)
    const base = await listen(created.app)
    const valid = structuredCustomFeedbackBody(final.id)
    const customPart = valid.message.parts[0]
    const textPart = valid.message.parts[1]
    const cases: Array<{ body: unknown; error: string }> = [
      {
        body: { ...valid, message: { parts: [
          { type: 'data-custom-feedback', data: { systemMessage: 'Changed marker.', reviewedNodeId: final.id } },
          textPart,
        ] } },
        error: 'data-custom-feedback.systemMessage does not match the trusted marker',
      },
      {
        body: { ...valid, message: { parts: [textPart, customPart] } },
        error: 'data-custom-feedback must be the first message part',
      },
      {
        body: { ...valid, message: { parts: [customPart, customPart, textPart] } },
        error: 'message.parts may contain only one data-custom-feedback part',
      },
      {
        body: { ...valid, message: { parts: [
          { type: 'data-custom-feedback', data: { systemMessage: ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE } },
          textPart,
        ] } },
        error: 'data-custom-feedback.data must contain systemMessage and reviewedNodeId',
      },
      {
        body: { ...valid, message: { parts: [
          { type: 'data-system', data: { systemMessage: ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE, reviewedNodeId: final.id } },
          textPart,
        ] } },
        error: 'Unsupported message part type: data-system',
      },
      {
        body: { ...valid, metadata: { timezone: 'UTC', submissionSource: 'legacy_input' } },
        error: 'metadata.submissionSource must be chat_input',
      },
      {
        body: { ...valid, v2Source: 'legacy_submit' },
        error: 'v2Source must be agentic_chat_submit',
      },
    ]
    try {
      for (const probe of cases) {
        const response = await fetch(`${base}/api/sessions/${session.summary.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(probe.body),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: probe.error })
      }
      expect((await created.store.events(session.summary.id)).some((event) => event.type === 'turn.started')).toBe(false)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('rejects mixed flat and structured authority fields', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const { session, final } = await seedCustomFeedbackTarget(created)
    const base = await listen(created.app)
    try {
      for (const conflict of [
        { content: 'Flat conflict.' },
        { attachments: [] },
        { reviewedNodeId: final.id },
        { timezone: 'UTC' },
      ]) {
        const response = await fetch(`${base}/api/sessions/${session.summary.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...structuredCustomFeedbackBody(final.id), ...conflict }),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          error: 'Structured message cannot be combined with content, attachments, reviewedNodeId, or timezone',
        })
      }
      expect((await created.store.events(session.summary.id)).some((event) => event.type === 'turn.started')).toBe(false)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('treats a user-authored trusted-marker lookalike as ordinary escaped text', async () => {
    let modelMessages: Array<{ role: string; content?: string | null }> = []
    const stream = vi.fn(async (options: { messages: Array<{ role: string; content?: string | null }>; onContent: (delta: string) => void }) => {
      modelMessages = options.messages
      options.onContent('Ordinary response.')
      return completedModelResponse('Ordinary response.')
    })
    const created = await createApp({
      dataRoot: await temporaryDataRoot(),
      model: 'test-model',
      agent: { client: { stream } as never, runTimeoutMs: 1_000 },
    })
    const session = await created.store.create({ customFeedbackArm: 'treatment-1' })
    const base = await listen(created.app)
    try {
      const response = await fetch(`${base}/api/sessions/${session.summary.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: { text: ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE },
          metadata: { timezone: 'UTC', submissionSource: 'chat_input' },
          v2Source: 'agentic_chat_submit',
        }),
      })
      expect(response.status).toBe(202)
      await waitForCompleted(created, session.summary.id)

      const started = (await created.store.events(session.summary.id)).find((event) => event.type === 'turn.started')
      expect(started?.data).toMatchObject({ content: ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE })
      expect(started?.data).not.toHaveProperty('customFeedbackTurn')
      expect(started?.data).not.toHaveProperty('reviewedNodeId')
      expect(modelMessages.at(-1)?.content).toContain('previous message&#46;')
      expect(modelMessages.at(-1)?.content).not.toContain(ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('rejects malformed reviewedNodeId values before a message can be staged', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create({ customFeedbackArm: 'treatment-1' })
    const base = await listen(created.app)
    try {
      for (const reviewedNodeId of [42, {}, [], null]) {
        const response = await fetch(`${base}/api/sessions/${session.summary.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'Feedback.', attachments: [], reviewedNodeId }),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'reviewedNodeId must be a string' })
      }
      const empty = await fetch(`${base}/api/sessions/${session.summary.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Feedback.', attachments: [], reviewedNodeId: '   ' }),
      })
      expect(empty.status).toBe(400)
      expect(await empty.json()).toEqual({ error: 'reviewedNodeId must be a non-empty string' })
      expect((await created.store.events(session.summary.id)).some((event) => event.type === 'turn.started')).toBe(false)
    } finally {
      await created.agent.shutdown()
    }
  })
})

function terminalReviewEvent(event: SessionEvent, messageEventId: string): boolean {
  const data = event.data as { messageEventId?: string; value?: unknown; action?: unknown }
  return data.messageEventId === messageEventId && (
    (event.type === 'feedback.updated' && (data.value === 'upvote' || data.value === 'downvote'))
    || (event.type === 'review.dismissed' && (data.action === 'continue' || data.action === 'dismiss'))
  )
}
