import './legacy-live-test-disabled.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const { createApp } = await import('../dist-server/server/app.js')

const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-session-unlimited-usage-smoke-'))
const created = await createApp({ dataRoot })
try {
  const session = await created.store.create()
  await created.store.update(session.summary.id, (state) => {
    state.summary.usage.promptTokens = 986_843
    state.summary.usage.completionTokens = 15_953
    state.summary.usage.totalTokens = 1_002_796
    state.summary.usage.cachedPromptTokens = 925_952
    state.summary.usage.modelCalls = 50
    state.summary.usage.modelRequests = 50
  })
  await created.agent.submit(session.summary.id, {
    content: 'Do not use tools. Answer only with the result of 2 + 2.',
    model: null,
  })
  let state
  for (let attempt = 0; attempt < 600; attempt += 1) {
    state = await created.store.get(session.summary.id)
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(state.summary.status)) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  if (!state || state.summary.status !== 'completed') {
    throw new Error(`Expected the first turn to complete, got ${state?.summary.status || 'unknown'}`)
  }
  if (state.summary.limits !== undefined || state.summary.usage.totalTokens <= 1_002_796) {
    throw new Error(`Cumulative usage was not retained as unlimited metering: ${JSON.stringify(state.summary)}`)
  }
  await created.agent.submit(session.summary.id, { content: 'Answer only with the result of 3 + 3.' })
  for (let attempt = 0; attempt < 600; attempt += 1) {
    state = await created.store.get(session.summary.id)
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(state.summary.status)) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  if (!state || state.summary.status !== 'completed') {
    throw new Error(`Expected the second high-usage turn to complete, got ${state?.summary.status || 'unknown'}`)
  }
  const events = await created.store.events(session.summary.id)
  const limitEvents = events.filter((event) => event.type === 'session.limit.reached')
  const userTurns = events.filter((event) => event.type === 'turn.started')
  const usageEvents = events.filter((event) => event.type === 'usage.updated')
  if (limitEvents.length !== 0 || userTurns.length !== 2) {
    throw new Error(`Unexpected event counts: limits=${limitEvents.length}, turns=${userTurns.length}`)
  }
  if (state.summary.modelSelection !== null || userTurns[0]?.data.modelSelection !== null || usageEvents[0]?.data.model !== state.summary.model) {
    throw new Error('Auto (sampled) selection did not remain aligned with the real provider model')
  }
  process.stdout.write(`${JSON.stringify({
    sessionId: session.summary.id,
    status: state.summary.status,
    modelCalls: state.summary.usage.modelCalls,
    toolCalls: state.summary.usage.toolCalls,
    totalTokens: state.summary.usage.totalTokens,
    model: state.summary.model,
    modelSelection: state.summary.modelSelection,
    limits: state.summary.limits ?? null,
    limitEventCount: limitEvents.length,
    turnCount: userTurns.length,
  }, null, 2)}\n`)
} finally {
  await created.agent.shutdown()
  await rm(dataRoot, { recursive: true, force: true })
}
