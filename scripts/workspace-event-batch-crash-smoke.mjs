import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)

if (process.argv[2] === 'child') {
  const [, , , root, failpointPath] = process.argv
  if (!root || !failpointPath) throw new Error('child requires data root and failpoint path')
  const [{ SessionStore }, { ToolExecutor }, { ProcessManager }, { BrowserManager }] = await Promise.all([
    import('../dist-server/server/session-store.js'),
    import('../dist-server/server/tools.js'),
    import('../dist-server/server/process-manager.js'),
    import('../dist-server/server/browser-manager.js'),
  ])
  const store = new SessionStore(root, 'workspace-event-batch-crash-smoke-model')
  await store.initialize()
  const session = await store.create()
  const workspace = store.workspaceDir(session.summary.id)
  await writeFile(resolve(workspace, 'first.txt'), 'first-before\n')
  await writeFile(resolve(workspace, 'second.txt'), 'second-before\n')
  const originalAppend = store.append.bind(store)
  store.append = async (sessionId, type, data, context = {}) => {
    if (type !== 'file.changed' || context.callId !== 'call_patch_crash') {
      return await originalAppend(sessionId, type, data, context)
    }
    const durable = await store.get(sessionId)
    const pending = Object.values(durable.pendingWorkspaceEventBatches ?? {})[0]
    let patchResidue = []
    try {
      patchResidue = await readdir(store.workspacePatchTransactionDir(sessionId))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await writeFile(failpointPath, `${JSON.stringify({
      sessionId,
      pending,
      firstAtFailpoint: await readFile(resolve(workspace, 'first.txt'), 'utf8'),
      secondAtFailpoint: await readFile(resolve(workspace, 'second.txt'), 'utf8'),
      patchResidue,
      patchFileEventCount: (await store.events(sessionId)).filter((event) => event.type === 'file.changed' && event.callId === 'call_patch_crash').length,
      patchArtifactEventCount: (await store.events(sessionId)).filter((event) => event.type === 'artifact.created' && event.callId === 'call_patch_crash').length,
      workspaceBytes: durable.summary.workspaceBytes,
    })}\n`, 'utf8')
    setInterval(() => {}, 60_000)
    return await new Promise(() => {})
  }
  const tools = new ToolExecutor(
    store,
    new ProcessManager(() => {}, 10_000),
    new BrowserManager(),
    { inspect: async () => { throw new Error('not used') } },
    async () => false,
  )
  await tools.execute({
    id: 'call_patch_crash',
    name: 'apply_patch',
    arguments: {
      input: `*** Begin Patch
*** Update File: first.txt
@@
-first-before
+first-after
*** Update File: second.txt
@@
-second-before
+second-after
*** End Patch`,
    },
  }, {
    sessionId: session.summary.id,
    turnId: 'turn_patch_crash',
    stepId: 'step_patch_crash',
    signal: new AbortController().signal,
  })
}

const { SessionStore } = await import('../dist-server/server/session-store.js')
const root = await mkdtemp(resolve(tmpdir(), 'anera-workspace-event-batch-crash-'))
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
      if (parsed?.sessionId && parsed?.pending?.changes?.length === 2 && parsed?.patchFileEventCount === 0) return parsed
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Workspace-event-batch child exited before failpoint: ${childStderr || childStdout}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for workspace-event-batch failpoint')
}

try {
  const failpoint = await waitForFailpoint()
  child.kill('SIGKILL')
  const killed = await childClosed
  if (killed.signal !== 'SIGKILL') {
    throw new Error(`Expected SIGKILL, got code=${killed.code} signal=${killed.signal}: ${childStderr || childStdout}`)
  }

  const restarted = new SessionStore(root, 'workspace-event-batch-crash-smoke-model')
  await restarted.initialize()
  const recovered = await restarted.get(failpoint.sessionId)
  const events = await restarted.events(failpoint.sessionId)
  const recovery = events.find((event) => event.type === 'session.recovered')
  const patchEvents = events.filter((event) => event.callId === 'call_patch_crash')
  const eventCount = events.length
  const restartedAgain = new SessionStore(root, 'workspace-event-batch-crash-smoke-model')
  await restartedAgain.initialize()
  const repeatedEvents = await restartedAgain.events(failpoint.sessionId)
  const report = {
    sessionId: failpoint.sessionId,
    childTermination: killed,
    pendingBatchAtFailpoint: failpoint.pending,
    firstAtFailpoint: failpoint.firstAtFailpoint,
    secondAtFailpoint: failpoint.secondAtFailpoint,
    patchResidueAtFailpoint: failpoint.patchResidue,
    patchFileEventCountAtFailpoint: failpoint.patchFileEventCount,
    patchArtifactEventCountAtFailpoint: failpoint.patchArtifactEventCount,
    workspaceBytesAtFailpoint: failpoint.workspaceBytes,
    recoveredFirst: await readFile(resolve(restarted.workspaceDir(failpoint.sessionId), 'first.txt'), 'utf8'),
    recoveredSecond: await readFile(resolve(restarted.workspaceDir(failpoint.sessionId), 'second.txt'), 'utf8'),
    recoveredPendingWorkspaceEventBatches: recovered.pendingWorkspaceEventBatches ?? null,
    recoveredWorkspaceBytes: recovered.summary.workspaceBytes,
    recoveredArtifacts: recovered.artifacts,
    recoveredPatchFileEvents: patchEvents.filter((event) => event.type === 'file.changed'),
    recoveredPatchArtifactEvents: patchEvents.filter((event) => event.type === 'artifact.created'),
    workspaceEventBatchRecovery: recovery?.data?.workspaceEventBatchReconciliation,
    recoveryEventCount: events.filter((event) => event.type === 'session.recovered').length,
    eventCount,
    eventCountAfterSecondRestart: repeatedEvents.length,
  }
  report.passed = report.childTermination.signal === 'SIGKILL'
    && report.firstAtFailpoint === 'first-after\n'
    && report.secondAtFailpoint === 'second-after\n'
    && report.patchResidueAtFailpoint.length === 0
    && report.patchFileEventCountAtFailpoint === 0
    && report.patchArtifactEventCountAtFailpoint === 0
    && report.workspaceBytesAtFailpoint === 0
    && report.recoveredFirst === 'first-after\n'
    && report.recoveredSecond === 'second-after\n'
    && report.recoveredPendingWorkspaceEventBatches === null
    && report.recoveredWorkspaceBytes === 25
    && report.recoveredArtifacts.length === 2
    && report.recoveredPatchFileEvents.length === 2
    && report.recoveredPatchArtifactEvents.length === 2
    && report.workspaceEventBatchRecovery?.batches?.[0]?.reconstructedFileEvents === 2
    && report.workspaceEventBatchRecovery?.batches?.[0]?.reconstructedArtifactEvents === 2
    && report.recoveryEventCount === 1
    && report.eventCountAfterSecondRestart === report.eventCount

  await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
  const reportPath = resolve('reports', 'real-smokes', `workspace-event-batch-crash-${failpoint.sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  await rm(root, { recursive: true, force: true })
}
