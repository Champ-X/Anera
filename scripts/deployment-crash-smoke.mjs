import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)

if (process.argv[2] === 'child') {
  const [, , , root, failpointPath] = process.argv
  if (!root || !failpointPath) throw new Error('child requires data root and failpoint path')
  const { createStaticDeploymentSnapshot, deploymentSnapshotManifestPath } = await import('../dist-server/server/deployment.js')
  const { SessionStore } = await import('../dist-server/server/session-store.js')
  const store = new SessionStore(root, 'deployment-crash-smoke-model')
  await store.initialize()
  const session = await store.create()
  const workspace = store.workspaceDir(session.summary.id)
  await writeFile(resolve(workspace, 'index.html'), '<!doctype html><h1>DEPLOYMENT CRASH RECOVERY</h1>\n', 'utf8')
  await writeFile(resolve(workspace, 'site.css'), 'h1 { color: rebeccapurple; }\n', 'utf8')
  await store.setStatus(session.summary.id, 'running')
  const callId = 'call_deployment_crash'
  const context = {
    turnId: 'turn_deployment_crash',
    stepId: 'step_deployment_crash',
    callId,
  }
  await store.update(session.summary.id, (state) => {
    state.messages.push(
      { role: 'user', content: 'Deploy the synthetic crash fixture.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name: 'deploy_project', arguments: '{}' },
        }],
      },
    )
  })
  await store.append(session.summary.id, 'assistant.started', { step: 1 }, context)
  await store.append(session.summary.id, 'tool.started', {
    call: { id: callId, name: 'deploy_project', arguments: {} },
  }, context)

  const previous = (await store.get(session.summary.id)).deployment
  const createdAt = new Date().toISOString()
  const deploymentId = 'dep_deploymentcrash001'
  await store.recordDeploymentUpdate(session.summary.id, {
    ...previous,
    id: deploymentId,
    status: 'building',
    createdAt,
    updatedAt: createdAt,
  }, 'building', context)
  const deploying = {
    ...previous,
    id: deploymentId,
    status: 'deploying',
    createdAt,
    updatedAt: new Date().toISOString(),
  }
  const pending = {
    id: 'dpc_deploymentcrash001',
    deploymentId,
    revision: 1,
    previous,
    deploying,
    url: `http://127.0.0.1:4173/deployments/${session.summary.id}/`,
    visibility: 'local',
    createdAt,
    successAction: 'deployed',
    phase: 'snapshotting',
    deployingEventId: 'evt_deploymentcrash_start',
    completionEventId: 'evt_deploymentcrash_done',
    context,
  }
  await store.stageDeploymentSnapshot(session.summary.id, pending)
  const target = store.deploymentRevisionDir(session.summary.id, pending.revision)
  const snapshot = await createStaticDeploymentSnapshot(workspace, target, new AbortController().signal)
  const durable = await store.get(session.summary.id)
  const events = await store.events(session.summary.id)
  await writeFile(failpointPath, `${JSON.stringify({
    sessionId: session.summary.id,
    checkpointId: pending.id,
    deployingEventId: pending.deployingEventId,
    completionEventId: pending.completionEventId,
    contentHash: snapshot.contentHash,
    manifestPath: deploymentSnapshotManifestPath(target),
    pendingPhase: durable.pendingDeployment?.phase,
    deploymentStatus: durable.deployment.status,
    deployingEventCount: events.filter((event) => event.id === pending.deployingEventId).length,
  })}\n`, 'utf8')
  setInterval(() => {}, 60_000)
  await new Promise(() => {})
}

const { SessionStore } = await import('../dist-server/server/session-store.js')
const root = await mkdtemp(resolve(tmpdir(), 'anera-deployment-crash-'))
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
      if (
        parsed?.pendingPhase === 'snapshotting'
        && parsed?.deploymentStatus === 'deploying'
        && parsed?.deployingEventCount === 1
        && /^[a-f0-9]{64}$/.test(parsed?.contentHash || '')
      ) return parsed
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Deployment crash child exited before failpoint: ${childStderr || childStdout}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for Deployment crash failpoint')
}

try {
  const failpoint = await waitForFailpoint()
  child.kill('SIGKILL')
  const killed = await childClosed
  if (killed.signal !== 'SIGKILL') {
    throw new Error(`Expected SIGKILL, got code=${killed.code} signal=${killed.signal}: ${childStderr || childStdout}`)
  }

  const restarted = new SessionStore(root, 'deployment-crash-smoke-model')
  await restarted.initialize()
  const recovered = await restarted.get(failpoint.sessionId)
  const events = await restarted.events(failpoint.sessionId)
  const recovery = events.find((event) => event.type === 'session.recovered')
  const deploymentActions = events
    .filter((event) => event.type === 'deployment.updated')
    .map((event) => event.data?.action)
  const eventCount = events.length
  const restartedAgain = new SessionStore(root, 'deployment-crash-smoke-model')
  await restartedAgain.initialize()
  const repeatedEvents = await restartedAgain.events(failpoint.sessionId)
  const report = {
    sessionId: failpoint.sessionId,
    checkpointId: failpoint.checkpointId,
    childTermination: killed,
    durablePendingPhaseAtFailpoint: failpoint.pendingPhase,
    durableDeploymentStatusAtFailpoint: failpoint.deploymentStatus,
    manifestPresentAtFailpoint: Boolean(await readFile(failpoint.manifestPath, 'utf8')),
    recoveredPendingCheckpoint: recovered.pendingDeployment ?? null,
    recoveredDeploymentStatus: recovered.deployment.status,
    recoveredRevision: recovered.deployment.revision,
    expectedContentHash: failpoint.contentHash,
    recoveredContentHash: recovered.deployment.contentHash,
    deploymentActions,
    deployingEventCount: events.filter((event) => event.id === failpoint.deployingEventId).length,
    completionEventCount: events.filter((event) => event.id === failpoint.completionEventId).length,
    recoveredToolCompletedCount: events.filter((event) => (
      event.type === 'tool.completed'
      && event.callId === 'call_deployment_crash'
      && event.data?.recovered === true
    )).length,
    recoveredToolMessage: recovered.messages.at(-1),
    checkpointRecovery: recovery?.data?.deploymentReconciliation?.checkpoint,
    recoveryEventCount: events.filter((event) => event.type === 'session.recovered').length,
    eventCount,
    eventCountAfterSecondRestart: repeatedEvents.length,
  }
  report.passed = report.childTermination.signal === 'SIGKILL'
    && report.durablePendingPhaseAtFailpoint === 'snapshotting'
    && report.durableDeploymentStatusAtFailpoint === 'deploying'
    && report.manifestPresentAtFailpoint
    && report.recoveredPendingCheckpoint === null
    && report.recoveredDeploymentStatus === 'deployed'
    && report.recoveredRevision === 1
    && report.recoveredContentHash === report.expectedContentHash
    && JSON.stringify(report.deploymentActions) === JSON.stringify(['building', 'deploying', 'deployed'])
    && report.deployingEventCount === 1
    && report.completionEventCount === 1
    && report.recoveredToolCompletedCount === 1
    && report.recoveredToolMessage?.tool_result_status === 'succeeded'
    && report.checkpointRecovery?.manifestVerified === true
    && report.checkpointRecovery?.completionEventReconstructed === true
    && report.recoveryEventCount === 1
    && report.eventCountAfterSecondRestart === report.eventCount

  await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
  const reportPath = resolve('reports', 'real-smokes', `deployment-crash-${failpoint.sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  await rm(root, { recursive: true, force: true })
}
