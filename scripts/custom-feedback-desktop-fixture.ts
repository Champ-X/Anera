import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { ModelMessage } from '../src/shared/types.js'
import { createApp } from '../src/server/app.js'
import {
  seedVisualTaskCompletionFixture,
  seedVisualTaskReviewFixture,
} from '../src/eval/ui-visual-fixture.js'

const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-custom-feedback-desktop-'))
const modelClient = {
  async stream(options: {
    messages: ModelMessage[]
    onContent: (delta: string) => void
  }) {
    const latest = options.messages.findLast((message) => message.role === 'user')
    const customFeedback = latest?.arena_system_messages?.some((part) => part.kind === 'custom_feedback') === true
    const content = customFeedback
      ? 'Updated the result using the submitted feedback.'
      : 'Fixture response.'
    options.onContent(content)
    return {
      content,
      reasoningContent: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28, cachedPromptTokens: 0 },
    }
  },
}
const created = await createApp({
  dataRoot,
  model: 'arena-custom-feedback-fixture',
  customFeedbackArm: 'control',
  agent: { client: modelClient as never, runTimeoutMs: 5_000 },
})
let rejectNextCustomFeedback = false
const submit = created.agent.submit.bind(created.agent)
created.agent.submit = async (sessionId, options) => {
  if (rejectNextCustomFeedback && options.reviewedNodeId) {
    rejectNextCustomFeedback = false
    throw Object.assign(new Error('Fixture rejected the staged custom feedback'), { statusCode: 503 })
  }
  return await submit(sessionId, options)
}
created.app.post('/api/test/custom-feedback-reject-once', (_request, response) => {
  rejectNextCustomFeedback = true
  response.json({ ok: true })
})

const treatment1 = await seedVisualTaskReviewFixture(
  created.store,
  'Custom Feedback Treatment 1',
  { isFreeSession: true, customFeedbackArm: 'treatment-1' },
)
const treatment2 = await seedVisualTaskCompletionFixture(
  created.store,
  'Custom Feedback Treatment 2',
  { isFreeSession: true, customFeedbackArm: 'treatment-2' },
)
const history = await seedVisualTaskReviewFixture(
  created.store,
  'Custom Feedback History',
  { isFreeSession: true, customFeedbackArm: 'treatment-1' },
)
const historyEvents = await created.store.events(history.id)
const sourceFinal = historyEvents.findLast((event) => event.type === 'assistant.final')
if (!sourceFinal) throw new Error('Custom feedback history source Final is missing')
await created.store.append(history.id, 'feedback.updated', {
  sessionNodeId: sourceFinal.id,
  messageEventId: sourceFinal.id,
  value: 'upvote',
  checkInAction: 'approve',
  feedback: { type: 'check_in', value: 'approve' },
  model: 'arena-custom-feedback-fixture',
}, { turnId: sourceFinal.turnId, stepId: sourceFinal.stepId })
const feedbackTurnId = 'turn_visual_custom_feedback_history'
await created.store.append(history.id, 'turn.started', {
  content: 'The result should mention the verified source and use a shorter title.',
  attachments: ['uploads/reference.txt'],
  reviewedNodeId: sourceFinal.id,
  customFeedbackTurn: true,
  has_feedback: true,
  model: 'arena-custom-feedback-fixture',
  modelSelection: null,
}, { turnId: feedbackTurnId })
const correctedFinal = await created.store.append(history.id, 'assistant.final', {
  content: 'Updated the result with the verified source and a shorter title.',
  finishReason: 'stop',
}, { turnId: feedbackTurnId, stepId: 'step_visual_custom_feedback_history' })
await created.store.append(history.id, 'turn.completed', { status: 'completed' }, {
  turnId: feedbackTurnId,
  stepId: correctedFinal.stepId,
})
await created.store.append(history.id, 'run.status', { status: 'completed' }, {
  turnId: feedbackTurnId,
  stepId: correctedFinal.stepId,
})
await created.store.append(history.id, 'review.requested', {
  messageEventId: correctedFinal.id,
  feedbackType: 'check_in',
  model: 'arena-custom-feedback-fixture',
}, { turnId: feedbackTurnId, stepId: correctedFinal.stepId })
await created.store.append(history.id, 'review.dismissed', {
  messageEventId: correctedFinal.id,
  action: 'dismiss',
  checkInAction: 'escape',
  feedback: { type: 'check_in', value: 'escape' },
  model: 'arena-custom-feedback-fixture',
}, { turnId: feedbackTurnId, stepId: correctedFinal.stepId })
await created.store.update(history.id, (state) => {
  state.summary.status = 'completed'
  state.summary.lastMessage = 'The result should mention the verified source and use a shorter title.'
})

const server = createServer(created.app)
await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Custom feedback fixture server did not bind')
const baseUrl = `http://127.0.0.1:${address.port}`
console.log(`CUSTOM_FEEDBACK_FIXTURE ${JSON.stringify({ baseUrl, treatment1, treatment2, history })}`)

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await created.agent.shutdown()
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  await rm(dataRoot, { recursive: true, force: true })
}

process.once('SIGINT', () => void shutdown().then(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)))
