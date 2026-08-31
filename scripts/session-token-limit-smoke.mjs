import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const { createApp } = await import('../dist-server/server/app.js')

const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-session-limit-smoke-'))
const created = await createApp({ dataRoot, sessionTokenLimit: 1 })
try {
  const session = await created.store.create()
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
  const limit = state.summary.limits?.sessionTokens
  if (!limit?.reached || limit.remainingTokens !== 0 || limit.usedTokens <= 1) {
    throw new Error(`Session limit did not persist after real model usage: ${JSON.stringify(limit)}`)
  }
  let rejected
  try {
    await created.agent.submit(session.summary.id, { content: 'This second turn must be rejected.' })
  } catch (error) {
    rejected = error
  }
  if (!rejected || rejected.code !== 'session_token_limit' || rejected.statusCode !== 409) {
    throw new Error(`Expected session_token_limit/409, got ${String(rejected)}`)
  }
  const events = await created.store.events(session.summary.id)
  const limitEvents = events.filter((event) => event.type === 'session.limit.reached')
  const userTurns = events.filter((event) => event.type === 'turn.started')
  const usageEvents = events.filter((event) => event.type === 'usage.updated')
  if (limitEvents.length !== 1 || userTurns.length !== 1) {
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
    limit,
    rejected: { code: rejected.code, statusCode: rejected.statusCode, message: rejected.message },
    limitEventCount: limitEvents.length,
    turnCount: userTurns.length,
  }, null, 2)}\n`)
} finally {
  await created.agent.shutdown()
  await rm(dataRoot, { recursive: true, force: true })
}
