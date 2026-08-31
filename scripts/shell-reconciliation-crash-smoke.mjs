import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  const store = new SessionStore(root, 'shell-reconciliation-crash-smoke-model')
  await store.initialize()
  const session = await store.create()
  const workspace = store.workspaceDir(session.summary.id)
  await mkdir(resolve(workspace, '.tmp'), { recursive: true })
  await writeFile(resolve(workspace, '.tmp/late_child.py'), "import pathlib, time\ntime.sleep(2)\npathlib.Path('late.txt').write_text('LATE\\n')\n")
  const originalAppend = store.append.bind(store)
  store.append = async (sessionId, type, data, context = {}) => {
    if (type === 'tool.output' && context.callId === 'call_shell_crash' && String(data.chunk || '').includes('SHELL-READY')) {
      const durable = await store.get(sessionId)
      const pending = Object.values(durable.pendingShellReconciliations ?? {})[0]
      await writeFile(failpointPath, `${JSON.stringify({
        sessionId,
        pending,
        immediateAtFailpoint: await readFile(resolve(workspace, 'immediate.txt'), 'utf8'),
        shellFileEventCount: (await store.events(sessionId)).filter((event) => event.type === 'file.changed' && event.callId === 'call_shell_crash').length,
        workspaceBytes: durable.summary.workspaceBytes,
      })}\n`, 'utf8')
    }
    return await originalAppend(sessionId, type, data, context)
  }
  const tools = new ToolExecutor(
    store,
    new ProcessManager(() => {}, 10_000),
    new BrowserManager(),
    { inspect: async () => { throw new Error('not used') } },
    async () => false,
  )
  const command = `python3 -u -c "import pathlib,subprocess,sys,time; pathlib.Path('immediate.txt').write_text('IMMEDIATE\\n'); subprocess.Popen([sys.executable,'.tmp/late_child.py']); print('SHELL-READY',flush=True); time.sleep(30)"`
  await tools.execute({
    id: 'call_shell_crash',
    name: 'bash',
    arguments: { command, timeout: 60_000 },
  }, {
    sessionId: session.summary.id,
    turnId: 'turn_shell_crash',
    stepId: 'step_shell_crash',
    signal: new AbortController().signal,
  })
}

const { SessionStore } = await import('../dist-server/server/session-store.js')
const root = await mkdtemp(resolve(tmpdir(), 'anera-shell-reconciliation-crash-'))
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
      if (parsed?.sessionId && parsed?.pending?.phase === 'armed' && parsed?.shellFileEventCount === 0) return parsed
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Shell-reconciliation child exited before failpoint: ${childStderr || childStdout}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for Shell-reconciliation failpoint')
}

try {
  const failpoint = await waitForFailpoint()
  child.kill('SIGKILL')
  const killed = await childClosed
  if (killed.signal !== 'SIGKILL') {
    throw new Error(`Expected SIGKILL, got code=${killed.code} signal=${killed.signal}: ${childStderr || childStdout}`)
  }

  const restarted = new SessionStore(root, 'shell-reconciliation-crash-smoke-model')
  await restarted.initialize()
  const recovered = await restarted.get(failpoint.sessionId)
  const events = await restarted.events(failpoint.sessionId)
  const recovery = events.find((event) => event.type === 'session.recovered')
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_500))
  let lateExists = true
  try {
    await readFile(resolve(restarted.workspaceDir(failpoint.sessionId), 'late.txt'))
  } catch (error) {
    if (error?.code === 'ENOENT') lateExists = false
    else throw error
  }
  const shellFileEvents = events.filter((event) => event.type === 'file.changed' && event.callId === 'call_shell_crash')
  const shellArtifactEvents = events.filter((event) => event.type === 'artifact.created' && event.callId === 'call_shell_crash')
  const eventCount = events.length
  const restartedAgain = new SessionStore(root, 'shell-reconciliation-crash-smoke-model')
  await restartedAgain.initialize()
  const repeatedEvents = await restartedAgain.events(failpoint.sessionId)
  const report = {
    sessionId: failpoint.sessionId,
    childTermination: killed,
    pendingShellAtFailpoint: failpoint.pending,
    immediateAtFailpoint: failpoint.immediateAtFailpoint,
    shellFileEventCountAtFailpoint: failpoint.shellFileEventCount,
    workspaceBytesAtFailpoint: failpoint.workspaceBytes,
    recoveredImmediate: await readFile(resolve(restarted.workspaceDir(failpoint.sessionId), 'immediate.txt'), 'utf8'),
    lateExistsAfterGuardianRecovery: lateExists,
    recoveredPendingShellReconciliations: recovered.pendingShellReconciliations ?? null,
    recoveredPendingWorkspaceEventBatches: recovered.pendingWorkspaceEventBatches ?? null,
    recoveredWorkspaceBytes: recovered.summary.workspaceBytes,
    recoveredArtifacts: recovered.artifacts,
    recoveredShellFileEvents: shellFileEvents,
    recoveredShellArtifactEvents: shellArtifactEvents,
    shellReconciliation: recovery?.data?.shellReconciliation,
    workspaceEventBatchRecovery: recovery?.data?.workspaceEventBatchReconciliation,
    recoveryEventCount: events.filter((event) => event.type === 'session.recovered').length,
    eventCount,
    eventCountAfterSecondRestart: repeatedEvents.length,
  }
  report.passed = report.childTermination.signal === 'SIGKILL'
    && report.pendingShellAtFailpoint.phase === 'armed'
    && Number.isInteger(report.pendingShellAtFailpoint.guardianPid)
    && report.immediateAtFailpoint === 'IMMEDIATE\n'
    && report.shellFileEventCountAtFailpoint === 0
    && report.workspaceBytesAtFailpoint === 0
    && report.recoveredImmediate === 'IMMEDIATE\n'
    && report.lateExistsAfterGuardianRecovery === false
    && report.recoveredPendingShellReconciliations === null
    && report.recoveredPendingWorkspaceEventBatches === null
    && report.recoveredWorkspaceBytes === 10
    && report.recoveredArtifacts.length === 1
    && report.recoveredArtifacts[0]?.path === 'immediate.txt'
    && report.recoveredShellFileEvents.length === 1
    && report.recoveredShellFileEvents[0]?.data?.operation === 'created-by-shell'
    && report.recoveredShellArtifactEvents.length === 1
    && report.shellReconciliation?.[0]?.changeCount === 1
    && report.workspaceEventBatchRecovery?.batches?.[0]?.source === 'shell'
    && report.recoveryEventCount === 1
    && report.eventCountAfterSecondRestart === report.eventCount

  await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
  const reportPath = resolve('reports', 'real-smokes', `shell-reconciliation-crash-${failpoint.sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  await rm(root, { recursive: true, force: true })
}
