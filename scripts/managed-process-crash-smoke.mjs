import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)

if (process.argv[2] === 'child') {
  const [, , , root, failpointPath] = process.argv
  if (!root || !failpointPath) throw new Error('child requires data root and failpoint path')
  const { SessionStore } = await import('../dist-server/server/session-store.js')
  const { ProcessManager } = await import('../dist-server/server/process-manager.js')
  const store = new SessionStore(root, 'managed-process-crash-smoke-model')
  await store.initialize()
  const session = await store.create()
  const workspace = store.workspaceDir(session.summary.id)
  await writeFile(resolve(workspace, 'delayed-child.mjs'), `import { writeFileSync } from 'node:fs'\nsetTimeout(() => { writeFileSync('orphan-marker.txt', 'ORPHANED\\n') }, 2500)\nsetTimeout(() => {}, 60000)\n`, 'utf8')
  await writeFile(resolve(workspace, 'managed-parent.mjs'), `import { spawn } from 'node:child_process'\nimport { createServer } from 'node:http'\nconst child = spawn(process.execPath, ['delayed-child.mjs'], { stdio: 'ignore' })\nconst server = createServer((_request, response) => response.end('MANAGED-CRASH-SMOKE'))\nserver.listen(0, '127.0.0.1', () => {\n  console.log('DESCENDANT_PID=' + child.pid)\n  console.log('listening on ' + server.address().port)\n})\n`, 'utf8')

  const manager = new ProcessManager(async (sessionId, event, context) => {
    const type = event.type === 'started'
      ? 'process.started'
      : event.type === 'output'
        ? 'process.output'
        : 'process.stopped'
    await store.append(sessionId, type, event, context)
    await store.update(sessionId, (state) => {
      state.processes = [...state.processes.filter((item) => item.id !== event.record.id), event.record]
    })
  }, 100_000)

  const record = await manager.start(session.summary.id, workspace, 'node managed-parent.mjs', undefined, {
    turnId: 'turn_managed_process_crash',
    stepId: 'step_managed_process_crash',
    callId: 'call_managed_process_crash',
  })
  const deadline = Date.now() + 10_000
  let durable
  let descendantPid
  let serverPort
  while (Date.now() < deadline) {
    durable = await store.get(session.summary.id)
    const durableProcess = durable.processes.find((item) => item.id === record.id)
    const descendantMatch = durableProcess?.stdout.match(/DESCENDANT_PID=(\d+)/)
    const portMatch = durableProcess?.stdout.match(/listening on (\d+)/)
    if (descendantMatch && portMatch && durableProcess?.port) {
      descendantPid = Number.parseInt(descendantMatch[1], 10)
      serverPort = Number.parseInt(portMatch[1], 10)
      break
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  if (!durable || !descendantPid || !serverPort) throw new Error('Managed Website and descendant did not become durably visible')
  const context = {
    turnId: 'turn_managed_process_crash',
    stepId: 'step_managed_process_crash',
    callId: 'call_managed_process_crash',
  }
  const website = {
    status: 'running',
    processId: record.id,
    port: serverPort,
    previewUrl: `http://127.0.0.1:${serverPort}`,
    updatedAt: new Date().toISOString(),
    restartCount: 0,
  }
  await store.recordWebsiteUpdate(session.summary.id, website, { action: 'published' }, context)
  durable = await store.get(session.summary.id)
  const events = await store.events(session.summary.id)
  await writeFile(failpointPath, JSON.stringify({
    sessionId: session.summary.id,
    processId: record.id,
    guardianPid: record.pid,
    descendantPid,
    serverPort,
    markerPath: resolve(workspace, 'orphan-marker.txt'),
    durableStatus: durable.processes.find((item) => item.id === record.id)?.status,
    startedEvents: events.filter((event) => event.type === 'process.started' && event.data?.record?.id === record.id).length,
    outputEvents: events.filter((event) => event.type === 'process.output' && event.data?.record?.id === record.id).length,
    websiteStatus: durable.website.status,
  }), 'utf8')
  await new Promise(() => {})
}

const { SessionStore } = await import('../dist-server/server/session-store.js')
const root = await mkdtemp(resolve(tmpdir(), 'anera-managed-process-crash-'))
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
      if (parsed?.durableStatus === 'running' && parsed?.websiteStatus === 'running' && parsed?.startedEvents === 1 && parsed?.descendantPid) return parsed
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Managed-process crash child exited before failpoint: ${childStderr || childStdout}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for managed-process crash failpoint')
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

try {
  const failpoint = await waitForFailpoint()
  child.kill('SIGKILL')
  const killed = await childClosed
  if (killed.signal !== 'SIGKILL') {
    throw new Error(`Expected SIGKILL, got code=${killed.code} signal=${killed.signal}: ${childStderr || childStdout}`)
  }

  // The descendant would write at 2.5 s if either it or its parent survived.
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000))
  const guardianAliveBeforeRecovery = pidAlive(failpoint.guardianPid)
  const descendantAliveBeforeRecovery = pidAlive(failpoint.descendantPid)
  const markerExistsBeforeRecovery = existsSync(failpoint.markerPath)

  const restarted = new SessionStore(root, 'managed-process-crash-smoke-model')
  await restarted.initialize()
  const recovered = await restarted.get(failpoint.sessionId)
  const events = await restarted.events(failpoint.sessionId)
  const recoveredRecord = recovered.processes.find((item) => item.id === failpoint.processId)
  const recovery = events.find((event) => event.type === 'session.recovered')
  const eventCount = events.length

  const restartedAgain = new SessionStore(root, 'managed-process-crash-smoke-model')
  await restartedAgain.initialize()
  const repeatedEvents = await restartedAgain.events(failpoint.sessionId)
  const report = {
    sessionId: failpoint.sessionId,
    processId: failpoint.processId,
    childTermination: killed,
    durableStatusAtFailpoint: failpoint.durableStatus,
    startedEventsAtFailpoint: failpoint.startedEvents,
    outputEventsAtFailpoint: failpoint.outputEvents,
    guardianAliveBeforeRecovery,
    descendantAliveBeforeRecovery,
    markerExistsBeforeRecovery,
    recoveredProcessStatus: recoveredRecord?.status,
    recoveredProcessSignal: recoveredRecord?.signal,
    recoveredWebsiteStatus: recovered.website.status,
    recoveredWebsiteProcessId: recovered.website.processId,
    startedEventCount: events.filter((event) => event.type === 'process.started' && event.data?.record?.id === failpoint.processId).length,
    stoppedEventCount: events.filter((event) => event.type === 'process.stopped' && event.data?.record?.id === failpoint.processId).length,
    recoveryEventCount: events.filter((event) => event.type === 'session.recovered').length,
    recoveredWebsiteEventCount: events.filter((event) => (
      event.type === 'website.updated'
      && event.data?.recovered === true
      && event.data?.website?.processId === failpoint.processId
    )).length,
    termination: recovery?.data?.processReconciliation?.termination,
    eventCount,
    eventCountAfterSecondRestart: repeatedEvents.length,
  }
  report.passed = report.childTermination.signal === 'SIGKILL'
    && report.durableStatusAtFailpoint === 'running'
    && report.startedEventsAtFailpoint === 1
    && report.outputEventsAtFailpoint >= 1
    && !report.guardianAliveBeforeRecovery
    && !report.descendantAliveBeforeRecovery
    && !report.markerExistsBeforeRecovery
    && report.recoveredProcessStatus === 'interrupted'
    && report.recoveredProcessSignal === 'SERVER_RESTART'
    && report.recoveredWebsiteStatus === 'failed'
    && report.recoveredWebsiteProcessId === failpoint.processId
    && report.startedEventCount === 1
    && report.stoppedEventCount === 1
    && report.recoveryEventCount === 1
    && report.recoveredWebsiteEventCount === 1
    && report.eventCountAfterSecondRestart === report.eventCount

  await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
  const reportPath = resolve('reports', 'real-smokes', `managed-process-crash-${failpoint.sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  await rm(root, { recursive: true, force: true })
}
