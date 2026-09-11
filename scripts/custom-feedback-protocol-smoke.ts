import './legacy-live-test-disabled.mjs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  AgentService,
  ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE,
  arenaUserAuthoredText,
} from '../src/server/agent-service.js'
import { config } from '../src/server/config.js'
import { SessionStore } from '../src/server/session-store.js'
import { normalizeAneraTrace } from '../src/server/trace-normalizer.js'

if (!config.deepseekApiKey) throw new Error('DEEPSEEK_API_KEY is not configured')

const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-custom-feedback-protocol-smoke-'))
const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/real-smokes')
const store = new SessionStore(dataRoot, config.model)
await store.initialize()
const session = await store.create({ customFeedbackArm: 'treatment-1' })
const sourceTurnId = 'turn_custom_feedback_smoke_source'
const sourceStepId = 'step_custom_feedback_smoke_source'
await store.append(session.summary.id, 'turn.started', {
  content: 'Reply exactly ALPHA and nothing else.', attachments: [], model: config.model, modelSelection: config.model,
}, { turnId: sourceTurnId })
const sourceFinal = await store.append(session.summary.id, 'assistant.final', {
  content: 'ALPHA', finishReason: 'stop',
}, { turnId: sourceTurnId, stepId: sourceStepId })
await store.append(session.summary.id, 'turn.completed', { status: 'completed' }, { turnId: sourceTurnId, stepId: sourceStepId })
await store.append(session.summary.id, 'run.status', { status: 'completed' }, { turnId: sourceTurnId, stepId: sourceStepId })
await store.append(session.summary.id, 'review.requested', {
  messageEventId: sourceFinal.id, model: config.model, feedbackType: 'check_in',
}, { turnId: sourceTurnId, stepId: sourceStepId })
await store.append(session.summary.id, 'feedback.updated', {
  sessionNodeId: sourceFinal.id,
  messageEventId: sourceFinal.id,
  value: 'upvote',
  checkInAction: 'approve',
  feedback: { type: 'check_in', value: 'approve' },
  model: config.model,
}, { turnId: sourceTurnId, stepId: sourceStepId })
await store.update(session.summary.id, (state) => {
  state.summary.status = 'completed'
  state.summary.title = 'Real custom feedback protocol smoke'
  state.messages = [
    { role: 'user', content: 'Reply exactly ALPHA and nothing else.' },
    { role: 'assistant', content: 'ALPHA' },
  ]
  state.turnMessageStarts = { [sourceTurnId]: 0 }
})

const agent = new AgentService(store, { models: [config.model], runTimeoutMs: 180_000 })
try {
  const feedback = 'The previous answer is incorrect. Reply exactly BETA and nothing else.'
  await agent.submit(session.summary.id, {
    content: feedback,
    reviewedNodeId: sourceFinal.id,
    model: config.model,
    timezone: 'Asia/Shanghai',
  })
  const deadline = Date.now() + 180_000
  let state = await store.get(session.summary.id)
  while (Date.now() < deadline && !['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(state.summary.status)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    state = await store.get(session.summary.id)
  }
  const events = await store.events(session.summary.id)
  const final = String(events.findLast((event) => event.type === 'assistant.final')?.data.content || '')
  const customTurn = events.find((event) => (
    event.type === 'turn.started'
    && (event.data as { customFeedbackTurn?: unknown }).customFeedbackTurn === true
  ))
  const customMessage = state.messages.find((message) => (
    message.role === 'user'
    && message.arena_system_messages?.some((part) => part.kind === 'custom_feedback')
  ))
  if (state.summary.status !== 'completed') throw new Error(`custom feedback protocol run ended as ${state.summary.status}`)
  if (final.trim() !== 'BETA') throw new Error(`real model did not apply the custom feedback exactly: ${JSON.stringify(final)}`)
  if (!customTurn) throw new Error('custom feedback turn.started event was not published')
  if (!customMessage || arenaUserAuthoredText(customMessage) !== feedback) throw new Error('trusted custom feedback message did not preserve only the user feedback body')
  if (!customMessage.content?.startsWith(`<arena-system-message>\n${ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE}\n</arena-system-message>\n\n`)) {
    throw new Error('provider-facing custom feedback marker was missing or misplaced')
  }
  const provenance = customMessage.arena_system_messages?.filter((part) => part.kind === 'custom_feedback') ?? []
  if (provenance.length !== 1 || provenance[0].reviewedNodeId !== sourceFinal.id || provenance[0].position !== 'leading') {
    throw new Error('custom feedback provenance did not retain its reviewed Final correlation')
  }
  const canonicalTurn = normalizeAneraTrace({ events, summary: state.summary }).events.find((event) => event.action === 'custom_feedback_submitted')
  if (canonicalTurn?.payload && JSON.stringify(canonicalTurn.payload).includes(sourceFinal.id)) {
    throw new Error('canonical feedback correlation leaked a dynamic raw event id')
  }
  if ((canonicalTurn?.payload as { reviewedNodeId?: unknown } | undefined)?.reviewedNodeId !== 'N01') {
    throw new Error(`canonical feedback correlation was not stable: ${JSON.stringify(canonicalTurn?.payload)}`)
  }

  const report = {
    schemaVersion: 'anera-custom-feedback-protocol-smoke/1.0',
    generatedAt: new Date().toISOString(),
    sessionId: session.summary.id,
    model: state.summary.model,
    status: state.summary.status,
    sourceFinalId: sourceFinal.id,
    feedback,
    final,
    usage: state.summary.usage,
    turnProjection: customTurn.data,
    modelProjection: {
      markerLeading: true,
      trustedParts: customMessage.arena_system_messages,
      userAuthoredText: arenaUserAuthoredText(customMessage),
    },
    canonical: {
      action: canonicalTurn.action,
      reviewedNodeId: (canonicalTurn.payload as { reviewedNodeId?: unknown }).reviewedNodeId,
    },
    oracle: {
      realModelAppliedFeedback: true,
      trustedLeadingMarker: true,
      reviewedFinalCorrelated: true,
      canonicalCorrelationStable: true,
    },
  }
  await mkdir(reportDirectory, { recursive: true })
  const reportPath = resolve(reportDirectory, `custom-feedback-protocol-${session.summary.id}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ reportPath, ...report }, null, 2))
} finally {
  await agent.shutdown()
  await rm(dataRoot, { recursive: true, force: true })
}
