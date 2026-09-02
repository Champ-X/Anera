import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)

if (process.argv[2] === 'child') {
  const [, , , root, failpointPath] = process.argv
  if (!root || !failpointPath) throw new Error('child requires data root and failpoint path')
  const { config } = await import('../dist-server/server/config.js')
  const { SessionStore } = await import('../dist-server/server/session-store.js')
  const { AgentService } = await import('../dist-server/server/agent-service.js')
  const marker = 'TERMINAL-CRASH-RECOVERY-OK-829'
  const prompt = `Do not use any tools. Return only the marker ${marker}, with no other text.`
  const store = new SessionStore(root, config.model)
  await store.initialize()
  const session = await store.create()

  // Stop at the production semantic boundary after the model response and
  // pendingTerminal state are durable, before any terminal event is appended.
  let checkpointCaptured = false
  const stopAtCompletionCheckpoint = async (sessionId, turnId) => {
    const state = await store.get(sessionId)
    const terminal = state.pendingTerminal
    if (!terminal || terminal.turnId !== turnId) throw new Error('terminal checkpoint is missing at failpoint')
    if (!checkpointCaptured) {
      checkpointCaptured = true
      const events = await store.events(sessionId)
      const completionEvents = [...terminal.events, ...(terminal.workspacePersistenceEvents ?? [])]
      await writeFile(failpointPath, JSON.stringify({
        sessionId,
        turnId,
        marker,
        prompt,
        status: state.summary.status,
        assistantCopies: state.messages.filter((message) => message.role === 'assistant' && message.content === marker).length,
        terminal,
        publishedCompletionEventIds: completionEvents.filter((item) => events.some((event) => event.id === item.id)).map((item) => item.id),
        usage: state.summary.usage,
      }), 'utf8')
    }
    await new Promise(() => {})
  }
  store.publishWorkspacePersistenceStarted = stopAtCompletionCheckpoint
  store.publishRunTerminal = stopAtCompletionCheckpoint
  store.publishWorkspacePersistence = stopAtCompletionCheckpoint

  setInterval(() => {}, 60_000)
  await new AgentService(store, { runTimeoutMs: 120_000 }).submit(session.summary.id, {
    content: prompt,
    model: config.model,
  })
  await new Promise(() => {})
}

if (process.argv[2] === 'boundary-child') {
  const [, , , root, failpointPath, mode, terminalPrefixText, workspacePrefixText] = process.argv
  const terminalPrefix = Number(terminalPrefixText)
  const workspacePrefix = Number(workspacePrefixText)
  if (
    !root
    || !failpointPath
    || !['prefix', 'terminal_published', 'workspace_published'].includes(mode)
    || !Number.isInteger(terminalPrefix)
    || terminalPrefix < 0
    || terminalPrefix > 4
    || !Number.isInteger(workspacePrefix)
    || workspacePrefix < 0
    || workspacePrefix > 4
  ) throw new Error('boundary-child requires a valid root, failpoint, mode, and 0..4 lane prefixes')

  const { SessionStore } = await import('../dist-server/server/session-store.js')
  const store = new SessionStore(root, 'terminal-boundary-model')
  await store.initialize()
  const session = await store.create()
  await store.setStatus(session.summary.id, 'running')
  const turnId = `turn_boundary_${mode}_${terminalPrefix}_${workspacePrefix}`
  const finalEventId = `evt_boundary_final_${mode}_${terminalPrefix}_${workspacePrefix}`
  const terminalEvents = [
    { id: finalEventId, type: 'assistant.final', data: { content: 'Boundary Final', finishReason: 'stop' } },
    { id: `evt_boundary_turn_${mode}_${terminalPrefix}_${workspacePrefix}`, type: 'turn.completed', data: { status: 'completed' } },
    { id: `evt_boundary_status_${mode}_${terminalPrefix}_${workspacePrefix}`, type: 'run.status', data: { status: 'completed' } },
    { id: `evt_boundary_review_${mode}_${terminalPrefix}_${workspacePrefix}`, type: 'review.requested', data: { messageEventId: finalEventId, model: 'terminal-boundary-model' } },
  ]
  const workspacePersistenceEvents = [
    { id: `evt_boundary_scan_${mode}_${terminalPrefix}_${workspacePrefix}`, type: 'workspace.persistence.started', data: { phase: 'scanning', persistenceMode: 'local_durable' } },
    { id: `evt_boundary_upload_${mode}_${terminalPrefix}_${workspacePrefix}`, type: 'workspace.persistence.updated', data: { phase: 'uploading', blobCount: 0, persistenceMode: 'local_durable' } },
    { id: `evt_boundary_save_${mode}_${terminalPrefix}_${workspacePrefix}`, type: 'workspace.persistence.updated', data: { phase: 'saving', persistenceMode: 'local_durable' } },
    { id: `evt_boundary_saved_${mode}_${terminalPrefix}_${workspacePrefix}`, type: 'workspace.persistence.completed', data: { phase: 'saved', blobCount: 0, bytes: 0, fileCount: 0, persistenceMode: 'local_durable' } },
  ]
  const terminal = {
    turnId,
    stepId: 'step_boundary_completion',
    status: 'completed',
    events: terminalEvents,
    workspacePersistenceEvents,
    createdAt: '2026-08-31T00:00:00.000Z',
  }
  await store.stageRunTerminal(session.summary.id, terminal, (state) => {
    state.messages.push({ role: 'assistant', content: 'Boundary Final' })
  })

  const appendPrefix = async (items, count) => {
    for (const event of items.slice(0, count)) {
      await store.append(session.summary.id, event.type, event.data, {
        turnId,
        stepId: terminal.stepId,
        eventId: event.id,
      })
    }
  }
  if (mode === 'prefix') {
    for (let index = 0; index < Math.max(terminalPrefix, workspacePrefix); index += 1) {
      await appendPrefix(workspacePersistenceEvents.slice(index, index + 1), index < workspacePrefix ? 1 : 0)
      await appendPrefix(terminalEvents.slice(index, index + 1), index < terminalPrefix ? 1 : 0)
    }
  } else if (mode === 'terminal_published') {
    await store.publishRunTerminal(session.summary.id, turnId)
    await appendPrefix(workspacePersistenceEvents, workspacePrefix)
  } else {
    await store.publishWorkspacePersistence(session.summary.id, turnId)
    await appendPrefix(terminalEvents, terminalPrefix)
  }

  const state = await store.get(session.summary.id)
  const events = await store.events(session.summary.id)
  const completionEvents = [...terminalEvents, ...workspacePersistenceEvents]
  await writeFile(failpointPath, JSON.stringify({
    mode,
    terminalPrefix,
    workspacePrefix,
    sessionId: session.summary.id,
    turnId,
    terminal,
    pendingTerminal: state.pendingTerminal,
    status: state.summary.status,
    usage: state.summary.usage,
    publishedCompletionEventIds: completionEvents
      .filter((item) => events.some((event) => event.id === item.id))
      .map((item) => item.id),
  }), 'utf8')
  setInterval(() => {}, 60_000)
  await new Promise(() => {})
}

const { config } = await import('../dist-server/server/config.js')
const { SessionStore } = await import('../dist-server/server/session-store.js')

const failpointPath = `${config.dataRoot}/terminal-crash-failpoint-${process.pid}.json`
await rm(failpointPath, { force: true })
const child = spawn(process.execPath, [scriptPath, 'child', config.dataRoot, failpointPath], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childStdout = ''
let childStderr = ''
child.stdout.on('data', (chunk) => { childStdout += String(chunk) })
child.stderr.on('data', (chunk) => { childStderr += String(chunk) })
const childClosed = new Promise((resolveClose) => {
  child.once('close', (code, signal) => resolveClose({ code, signal }))
})

async function waitForFailpoint() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(failpointPath, 'utf8'))
      if (parsed?.terminal?.status === 'completed' && parsed?.sessionId) return parsed
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`terminal crash child exited before failpoint: ${childStderr || childStdout}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for terminal crash failpoint')
}

async function runBoundaryCrashCase(mode, terminalPrefix, workspacePrefix) {
  const root = await mkdtemp(resolve(tmpdir(), `anera-terminal-boundary-${mode}-${terminalPrefix}-${workspacePrefix}-`))
  const boundaryFailpointPath = resolve(root, 'failpoint.json')
  const boundaryChild = spawn(process.execPath, [
    scriptPath,
    'boundary-child',
    root,
    boundaryFailpointPath,
    mode,
    String(terminalPrefix),
    String(workspacePrefix),
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  boundaryChild.stdout.on('data', (chunk) => { stdout += String(chunk) })
  boundaryChild.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const closed = new Promise((resolveClose) => {
    boundaryChild.once('close', (code, signal) => resolveClose({ code, signal }))
  })

  try {
    const deadline = Date.now() + 10_000
    let failpoint
    while (Date.now() < deadline) {
      try {
        const parsed = JSON.parse(await readFile(boundaryFailpointPath, 'utf8'))
        if (parsed?.terminal?.status === 'completed' && parsed?.sessionId) {
          failpoint = parsed
          break
        }
      } catch {}
      if (boundaryChild.exitCode !== null || boundaryChild.signalCode !== null) {
        throw new Error(`boundary child exited before failpoint: ${stderr || stdout}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    }
    if (!failpoint) throw new Error(`Timed out waiting for ${mode}:${terminalPrefix}:${workspacePrefix}`)

    boundaryChild.kill('SIGKILL')
    const killed = await closed
    const restarted = new SessionStore(root, 'terminal-boundary-model')
    await restarted.initialize()
    const recovered = await restarted.get(failpoint.sessionId)
    const events = await restarted.events(failpoint.sessionId)
    const completionEvents = [...failpoint.terminal.events, ...(failpoint.terminal.workspacePersistenceEvents ?? [])]
    const completionEventCounts = Object.fromEntries(completionEvents.map((expected) => [
      expected.id,
      events.filter((event) => event.id === expected.id).length,
    ]))
    const recovery = events.find((event) => event.type === 'session.recovered')
    const recoveredPendingTerminal = recovery?.data?.recoveredPendingTerminal
    const final = events.find((event) => event.id === failpoint.terminal.events[0].id)
    const scanning = events.find((event) => event.id === failpoint.terminal.workspacePersistenceEvents?.[0]?.id)
    const review = events.find((event) => event.type === 'review.requested' && event.turnId === failpoint.turnId)
    const terminalWasVisible = failpoint.publishedCompletionEventIds.some((id) => (
      failpoint.terminal.events.some((event) => event.id === id)
    ))
    const eventCount = events.length
    const secondRestart = new SessionStore(root, 'terminal-boundary-model')
    await secondRestart.initialize()
    const secondEvents = await secondRestart.events(failpoint.sessionId)
    const secondState = await secondRestart.get(failpoint.sessionId)
    const completedAtPreserved = failpoint.pendingTerminal?.terminalPublished !== true
      || secondState.summary.usage.completedAt === failpoint.usage.completedAt
    const reconstructedFalseCount = recoveredPendingTerminal?.events?.filter((event) => event.reconstructed === false).length
    const result = {
      mode,
      terminalPrefix,
      workspacePrefix,
      childSignal: killed.signal,
      statusAtCrash: failpoint.status,
      publishedEventCount: failpoint.publishedCompletionEventIds.length,
      terminalPublishedAtCrash: failpoint.pendingTerminal?.terminalPublished === true,
      workspacePersistencePublishedAtCrash: failpoint.pendingTerminal?.workspacePersistencePublished === true,
      recoveredStatus: recovered.summary.status,
      pendingTerminalCleared: recovered.pendingTerminal === undefined,
      reconstructedFalseCount,
      scanningBeforeFinalWhenRecoverable: terminalWasVisible || Boolean(scanning && final && scanning.seq < final.seq),
      completedAtPreserved,
      stableAfterSecondRestart: secondEvents.length === eventCount,
      completionEventCounts,
    }
    result.passed = result.childSignal === 'SIGKILL'
      && result.recoveredStatus === 'completed'
      && result.pendingTerminalCleared
      && Object.values(result.completionEventCounts).every((count) => count === 1)
      && reconstructedFalseCount === failpoint.publishedCompletionEventIds.length
      && recoveredPendingTerminal?.terminalPublished === result.terminalPublishedAtCrash
      && recoveredPendingTerminal?.workspacePersistencePublished === result.workspacePersistencePublishedAtCrash
      && result.scanningBeforeFinalWhenRecoverable
      && result.completedAtPreserved
      && result.stableAfterSecondRestart
      && review?.data?.messageEventId === final?.id
      && events.filter((event) => event.type === 'error' && event.data?.interrupted).length === 0
    return result
  } finally {
    if (boundaryChild.exitCode === null && boundaryChild.signalCode === null) boundaryChild.kill('SIGKILL')
    await closed
    await rm(root, { recursive: true, force: true })
  }
}

async function runBoundaryCrashMatrix() {
  const cases = []
  for (let terminalPrefix = 0; terminalPrefix <= 4; terminalPrefix += 1) {
    for (let workspacePrefix = 0; workspacePrefix <= 4; workspacePrefix += 1) {
      cases.push(['prefix', terminalPrefix, workspacePrefix])
    }
  }
  for (let workspacePrefix = 0; workspacePrefix <= 4; workspacePrefix += 1) {
    cases.push(['terminal_published', 4, workspacePrefix])
  }
  for (let terminalPrefix = 0; terminalPrefix <= 4; terminalPrefix += 1) {
    cases.push(['workspace_published', terminalPrefix, 4])
  }
  const results = []
  for (const [mode, terminalPrefix, workspacePrefix] of cases) {
    results.push(await runBoundaryCrashCase(mode, terminalPrefix, workspacePrefix))
  }
  return {
    caseCount: results.length,
    passedCount: results.filter((result) => result.passed).length,
    passed: results.every((result) => result.passed),
    results,
  }
}

try {
  const failpoint = await waitForFailpoint()
  child.kill('SIGKILL')
  const killed = await childClosed
  if (killed.signal !== 'SIGKILL') {
    throw new Error(`Expected SIGKILL, got code=${killed.code} signal=${killed.signal}: ${childStderr || childStdout}`)
  }

  const restarted = new SessionStore(config.dataRoot, config.model)
  await restarted.initialize()
  const recovered = await restarted.get(failpoint.sessionId)
  const events = await restarted.events(failpoint.sessionId)
  const completionEvents = [...failpoint.terminal.events, ...(failpoint.terminal.workspacePersistenceEvents ?? [])]
  const recoveredCompletionEvents = completionEvents.map((expected) => events.filter((event) => event.id === expected.id))
  const final = events.find((event) => event.type === 'assistant.final')
  const review = events.find((event) => event.type === 'review.requested')
  const scanning = events.find((event) => event.type === 'workspace.persistence.started' && event.turnId === failpoint.turnId)
  const saved = events.find((event) => event.type === 'workspace.persistence.completed' && event.turnId === failpoint.turnId)
  const recovery = events.find((event) => event.type === 'session.recovered')
  const boundaryCrashMatrix = await runBoundaryCrashMatrix()
  const report = {
    sessionId: failpoint.sessionId,
    childTermination: killed,
    failpointStatus: failpoint.status,
    assistantCopiesAtFailpoint: failpoint.assistantCopies,
    completionEventIdsPublishedAtFailpoint: failpoint.publishedCompletionEventIds,
    recoveredStatus: recovered.summary.status,
    pendingTerminalCleared: recovered.pendingTerminal === undefined,
    completionEventCounts: Object.fromEntries(completionEvents.map((expected, index) => [expected.id, recoveredCompletionEvents[index].length])),
    final: final?.data?.content,
    finalEventId: final?.id,
    reviewMessageEventId: review?.data?.messageEventId,
    scanningBeforeFinal: Boolean(scanning && final && scanning.seq < final.seq),
    savedBeforeFinal: Boolean(saved && final && saved.seq < final.seq),
    recoveredPendingTerminal: recovery?.data?.recoveredPendingTerminal,
    interruptErrors: events.filter((event) => event.type === 'error' && event.data?.interrupted).length,
    modelCalls: recovered.summary.usage.modelCalls,
    toolCalls: recovered.summary.usage.toolCalls,
    promptTokens: recovered.summary.usage.promptTokens,
    completionTokens: recovered.summary.usage.completionTokens,
    totalTokens: recovered.summary.usage.totalTokens,
    cachedPromptTokens: recovered.summary.usage.cachedPromptTokens,
    estimatedCostUsd: recovered.summary.usage.estimatedCostUsd,
    durationMs: recovered.summary.usage.durationMs,
    boundaryCrashMatrix,
  }
  report.passed = report.childTermination.signal === 'SIGKILL'
    && report.failpointStatus === 'running'
    && report.assistantCopiesAtFailpoint === 1
    && report.completionEventIdsPublishedAtFailpoint.length === 0
    && report.recoveredStatus === 'completed'
    && report.pendingTerminalCleared
    && Object.values(report.completionEventCounts).every((count) => count === 1)
    && report.final === failpoint.marker
    && report.reviewMessageEventId === report.finalEventId
    && report.scanningBeforeFinal
    && report.savedBeforeFinal
    && report.recoveredPendingTerminal?.status === 'completed'
    && report.recoveredPendingTerminal?.events?.length === completionEvents.length
    && report.recoveredPendingTerminal.events.every((event) => event.reconstructed === true)
    && report.interruptErrors === 0
    && report.modelCalls === 1
    && report.toolCalls === 0
    && report.boundaryCrashMatrix.passed
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  await rm(failpointPath, { force: true })
}
