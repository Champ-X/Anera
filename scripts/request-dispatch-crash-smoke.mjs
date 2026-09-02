import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)

if (process.argv[2] === 'child') {
  const [, , , root, failpointPath] = process.argv
  if (!root || !failpointPath) throw new Error('child requires data root and failpoint path')
  const { config } = await import('../dist-server/server/config.js')
  const { SessionStore } = await import('../dist-server/server/session-store.js')
  const marker = 'REQUEST-DISPATCH-CRASH-OK-829'
  const prompt = `Do not use any tools. Resume this accepted request after recovery and return exactly ${marker}, with no other text.`
  const turnId = 'turn_request_dispatch_crash_fixture'
  const eventId = `evt_${randomUUID().replaceAll('-', '').slice(0, 20)}`
  const store = new SessionStore(root, config.model)
  await store.initialize()
  const session = await store.create()
  const eventData = {
    content: prompt,
    attachments: [],
    model: config.model,
    modelSelection: config.model,
    productMode: 'chat',
    repository: null,
  }
  await store.stageRunStart(session.summary.id, {
    kind: 'submit',
    turnId,
    eventId,
    eventData,
    createdAt: new Date().toISOString(),
  }, (state) => {
    state.summary.title = 'Request dispatch crash smoke'
    state.summary.lastMessage = prompt
    state.summary.model = config.model
    state.summary.modelSelection = config.model
    state.messages.push({ role: 'user', content: prompt })
  })
  // Publishing this marker is the failpoint: the accepted request and its
  // preallocated start identity are durable, but turn.started is still absent.
  await writeFile(failpointPath, JSON.stringify({
    sessionId: session.summary.id,
    prompt,
    marker,
    turnId,
    eventId,
    status: (await store.get(session.summary.id)).summary.status,
  }), 'utf8')
  setInterval(() => {}, 60_000)
  await new Promise(() => {})
}

const { config } = await import('../dist-server/server/config.js')
const { SessionStore } = await import('../dist-server/server/session-store.js')
const { AgentService } = await import('../dist-server/server/agent-service.js')

const failpointPath = `${config.dataRoot}/request-dispatch-crash-failpoint-${process.pid}.json`
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
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(failpointPath, 'utf8'))
      if (parsed?.status === 'queued' && parsed?.sessionId) return parsed
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`crash child exited before failpoint: ${childStderr || childStdout}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for request-dispatch crash failpoint')
}

let agent
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
  const recoveryEvents = await restarted.events(failpoint.sessionId)
  const startEvents = recoveryEvents.filter((event) => event.id === failpoint.eventId)
  const recovery = recoveryEvents.find((event) => event.type === 'session.recovered')
  const promptCopiesBeforeResume = recovered.messages.filter((message) => (
    message.role === 'user' && message.content === failpoint.prompt
  )).length

  agent = new AgentService(restarted, { runTimeoutMs: 120_000 })
  const resumed = await agent.resume(failpoint.sessionId)
  const deadline = Date.now() + 120_000
  let terminal
  while (Date.now() < deadline) {
    terminal = await restarted.get(failpoint.sessionId)
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(terminal.summary.status)) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  const events = await restarted.events(failpoint.sessionId)
  const final = [...events].reverse().find((event) => event.type === 'assistant.final')?.data?.content || ''
  const report = {
    sessionId: failpoint.sessionId,
    childTermination: killed,
    failpointStatus: failpoint.status,
    recoveredStatus: recovered.summary.status,
    pendingStartCleared: recovered.pendingStart === undefined,
    promptCopiesBeforeResume,
    reconstructedStartEvents: startEvents.map((event) => ({
      id: event.id,
      type: event.type,
      turnId: event.turnId,
      content: event.data.content,
    })),
    recoveredPendingStart: recovery?.data?.recoveredPendingStart,
    resumeTurnId: resumed.turnId,
    status: terminal?.summary.status,
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
  report.passed = report.childTermination.signal === 'SIGKILL'
    && report.failpointStatus === 'queued'
    && report.recoveredStatus === 'interrupted'
    && report.pendingStartCleared
    && report.promptCopiesBeforeResume === 1
    && report.reconstructedStartEvents.length === 1
    && report.reconstructedStartEvents[0].id === failpoint.eventId
    && report.reconstructedStartEvents[0].turnId === failpoint.turnId
    && report.recoveredPendingStart?.reconstructedStartEvent === true
    && report.status === 'completed'
    && report.toolCalls === 0
    && final.trim() === failpoint.marker
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  await agent?.shutdown()
  await rm(failpointPath, { force: true })
}
