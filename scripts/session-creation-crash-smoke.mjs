import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)

if (process.argv[2] === 'child') {
  const [, , , root, failpointPath] = process.argv
  if (!root || !failpointPath) throw new Error('child requires data root and failpoint path')
  const { SessionStore } = await import('../dist-server/server/session-store.js')
  const store = new SessionStore(root, 'session-creation-crash-smoke-model')
  await store.initialize()
  const originalAppend = store.append.bind(store)
  store.append = async (sessionId, type, data, context = {}) => {
    if (type !== 'session.created') return await originalAppend(sessionId, type, data, context)
    const durable = await store.get(sessionId)
    await writeFile(failpointPath, `${JSON.stringify({
      sessionId,
      pendingEventId: durable.pendingCreation?.eventId,
      pendingEventData: durable.pendingCreation?.eventData,
      stateStatus: durable.summary.status,
      eventCount: (await store.events(sessionId)).length,
    })}\n`, 'utf8')
    setInterval(() => {}, 60_000)
    return await new Promise(() => {})
  }
  await store.create()
}

const { SessionStore } = await import('../dist-server/server/session-store.js')
const root = await mkdtemp(resolve(tmpdir(), 'anera-session-creation-crash-'))
const failpointPath = resolve(root, 'failpoint.json')
const child = spawn(process.execPath, [scriptPath, 'child', root, failpointPath], {
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
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(failpointPath, 'utf8'))
      if (parsed?.sessionId && parsed?.pendingEventId && parsed?.eventCount === 0) return parsed
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Session-creation crash child exited before failpoint: ${childStderr || childStdout}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for Session creation crash failpoint')
}

try {
  const failpoint = await waitForFailpoint()
  child.kill('SIGKILL')
  const killed = await childClosed
  if (killed.signal !== 'SIGKILL') {
    throw new Error(`Expected SIGKILL, got code=${killed.code} signal=${killed.signal}: ${childStderr || childStdout}`)
  }

  const restarted = new SessionStore(root, 'session-creation-crash-smoke-model')
  await restarted.initialize()
  const recovered = await restarted.get(failpoint.sessionId)
  const events = await restarted.events(failpoint.sessionId)
  const creationEvents = events.filter((event) => event.type === 'session.created')
  const recovery = events.find((event) => event.type === 'session.recovered')
  const eventCount = events.length
  const restartedAgain = new SessionStore(root, 'session-creation-crash-smoke-model')
  await restartedAgain.initialize()
  const repeatedEvents = await restartedAgain.events(failpoint.sessionId)
  const report = {
    sessionId: failpoint.sessionId,
    childTermination: killed,
    pendingEventIdAtFailpoint: failpoint.pendingEventId,
    eventCountAtFailpoint: failpoint.eventCount,
    recoveredPendingCreation: recovered.pendingCreation ?? null,
    recoveredSessionStatus: recovered.summary.status,
    creationEventCount: creationEvents.length,
    recoveredCreationEventId: creationEvents[0]?.id,
    recoveredCreationEventData: creationEvents[0]?.data,
    expectedCreationEventData: failpoint.pendingEventData,
    creationRecovery: recovery?.data?.recoveredSessionCreation,
    recoveryEventCount: events.filter((event) => event.type === 'session.recovered').length,
    eventCount,
    eventCountAfterSecondRestart: repeatedEvents.length,
  }
  report.passed = report.childTermination.signal === 'SIGKILL'
    && report.eventCountAtFailpoint === 0
    && report.recoveredPendingCreation === null
    && report.recoveredSessionStatus === 'idle'
    && report.creationEventCount === 1
    && report.recoveredCreationEventId === report.pendingEventIdAtFailpoint
    && JSON.stringify(report.recoveredCreationEventData) === JSON.stringify(report.expectedCreationEventData)
    && report.creationRecovery?.reconstructedEvent === true
    && report.creationRecovery?.legacyStateOnly === false
    && report.recoveryEventCount === 1
    && report.eventCountAfterSecondRestart === report.eventCount

  await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
  const reportPath = resolve('reports', 'real-smokes', `session-creation-crash-${failpoint.sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  await rm(root, { recursive: true, force: true })
}
