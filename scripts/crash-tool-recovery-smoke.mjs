import { writeFile } from 'node:fs/promises'

const { config } = await import('../dist-server/server/config.js')
const { SessionStore } = await import('../dist-server/server/session-store.js')
const { AgentService } = await import('../dist-server/server/agent-service.js')

const marker = 'CRASH-TOOL-RECOVERY-OK-829'
const path = 'crash-recovery-marker.txt'
const prompt = `Create ${path} with exactly ${marker} followed by one LF. Then verify it with read_file. If crash recovery reports that create_file started but its outcome is unknown, do not repeat create_file blindly: first inspect the existing workspace with read_file and use the verified file. Your final answer must contain ${marker}.`
const turnId = 'turn_crash_recovery_fixture'
const stepId = 'step_crash_recovery_fixture'
const call = {
  id: 'call_crash_recovery_create',
  name: 'create_file',
  arguments: { path, content: `${marker}\n` },
}

const first = new SessionStore(config.dataRoot, config.model, config.sessionTokenLimit)
await first.initialize()
const session = await first.create()
await first.update(session.summary.id, (state) => {
  state.messages.push(
    { role: 'user', content: prompt },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }],
    },
  )
})
await first.append(session.summary.id, 'turn.started', {
  content: prompt,
  attachments: [],
  model: config.model,
  modelSelection: config.model,
  productMode: 'chat',
}, { turnId })
await first.setStatus(session.summary.id, 'running')
await first.append(session.summary.id, 'run.status', { status: 'running' }, { turnId })
await first.append(session.summary.id, 'assistant.started', { step: 1 }, { turnId, stepId })
await first.append(session.summary.id, 'tool.started', { call }, { turnId, stepId, callId: call.id })

// Simulate the exact crash window: the side effect happened after tool.started,
// but neither the terminal event nor the provider tool message became durable.
await writeFile(first.workspaceDir(session.summary.id) + `/${path}`, `${marker}\n`, 'utf8')

const restarted = new SessionStore(config.dataRoot, config.model, config.sessionTokenLimit)
await restarted.initialize()
const recoveredBeforeResume = await restarted.get(session.summary.id)
const recoveryEvents = await restarted.events(session.summary.id)
const recoveredToolMessage = recoveredBeforeResume.messages.at(-1)

const agent = new AgentService(restarted, { runTimeoutMs: 120_000 })
try {
  const resumed = await agent.resume(session.summary.id)
  const deadline = Date.now() + 120_000
  let terminal
  while (Date.now() < deadline) {
    terminal = await restarted.get(session.summary.id)
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(terminal.summary.status)) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  const events = await restarted.events(session.summary.id)
  const resumedToolStarts = events.filter((event) => event.type === 'tool.started' && event.turnId === resumed.turnId)
  const resumedTools = resumedToolStarts.map((event) => event.data.call?.name)
  const final = events.findLast((event) => event.type === 'assistant.final')?.data?.content || ''
  const recovery = recoveryEvents.find((event) => event.type === 'session.recovered')
  const syntheticFailure = recoveryEvents.find((event) => (
    event.type === 'tool.failed'
    && event.callId === call.id
    && event.data.reason === 'tool_outcome_unknown_after_restart'
  ))
  const report = {
    sessionId: session.summary.id,
    statusBeforeResume: recoveredBeforeResume.summary.status,
    recoveredMessageRoles: recoveredBeforeResume.messages.map((message) => message.role),
    recoveredToolResultStatus: recoveredToolMessage?.tool_result_status,
    recoveredToolResult: recoveredToolMessage?.content,
    recoveryResolution: recovery?.data?.repairedToolCalls,
    syntheticFailure: syntheticFailure ? {
      callId: syntheticFailure.callId,
      reason: syntheticFailure.data.reason,
      outcomeUnknown: syntheticFailure.data.outcomeUnknown,
      notExecuted: syntheticFailure.data.notExecuted,
    } : null,
    resumeTurnId: resumed.turnId,
    status: terminal?.summary.status,
    resumedTools,
    blindCreateReplay: resumedTools.includes('create_file'),
    readVerification: resumedTools.includes('read_file'),
    final,
    modelCalls: terminal?.summary.usage.modelCalls,
    toolCalls: terminal?.summary.usage.toolCalls,
    promptTokens: terminal?.summary.usage.promptTokens,
    completionTokens: terminal?.summary.usage.completionTokens,
    totalTokens: terminal?.summary.usage.totalTokens,
    cachedPromptTokens: terminal?.summary.usage.cachedPromptTokens,
    estimatedCostUsd: terminal?.summary.usage.estimatedCostUsd,
    durationMs: terminal?.summary.usage.durationMs,
  }
  report.passed = report.statusBeforeResume === 'interrupted'
    && report.recoveredToolResultStatus === 'failed'
    && Array.isArray(report.recoveryResolution)
    && report.recoveryResolution.some((item) => item.callId === call.id && item.resolution === 'outcome_unknown')
    && report.syntheticFailure?.outcomeUnknown === true
    && report.syntheticFailure?.notExecuted === false
    && report.status === 'completed'
    && report.readVerification
    && !report.blindCreateReplay
    && final.includes(marker)
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  await agent.shutdown()
}
