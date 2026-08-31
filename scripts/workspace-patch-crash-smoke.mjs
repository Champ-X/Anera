import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const firstBefore = 'first-before\n'
const secondBefore = 'second-before\n'

if (process.argv[2] === 'child') {
  const [, , , root, failpointPath] = process.argv
  if (!root || !failpointPath) throw new Error('child requires data root and failpoint path')
  const [{ SessionStore }, { applyWorkspacePatch }] = await Promise.all([
    import('../dist-server/server/session-store.js'),
    import('../dist-server/server/workspace-patch.js'),
  ])
  const store = new SessionStore(root, 'workspace-patch-crash-smoke-model')
  await store.initialize()
  const session = await store.create()
  const workspace = store.workspaceDir(session.summary.id)
  await writeFile(resolve(workspace, 'first.txt'), firstBefore)
  await writeFile(resolve(workspace, 'second.txt'), secondBefore)
  await applyWorkspacePatch(workspace, `*** Begin Patch
*** Update File: first.txt
@@
-first-before
+first-after
*** Update File: second.txt
@@
-second-before
+second-after
*** End Patch`, undefined, {
    transactionParent: store.workspacePatchTransactionDir(session.summary.id),
    onDurablePhase: async (phase, details) => {
      if (phase !== 'installed' || details.installedCount !== 1) return
      await writeFile(failpointPath, `${JSON.stringify({
        sessionId: session.summary.id,
        details,
        firstAtFailpoint: await readFile(resolve(workspace, 'first.txt'), 'utf8'),
        secondAtFailpoint: await readFile(resolve(workspace, 'second.txt'), 'utf8'),
        eventCount: (await store.events(session.summary.id)).length,
      })}\n`, 'utf8')
      setInterval(() => {}, 60_000)
      await new Promise(() => {})
    },
  })
}

const { SessionStore } = await import('../dist-server/server/session-store.js')
const root = await mkdtemp(resolve(tmpdir(), 'anera-workspace-patch-crash-'))
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
      if (parsed?.sessionId && parsed?.details?.installedCount === 1) return parsed
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Workspace-patch crash child exited before failpoint: ${childStderr || childStdout}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for workspace-patch crash failpoint')
}

try {
  const failpoint = await waitForFailpoint()
  child.kill('SIGKILL')
  const killed = await childClosed
  if (killed.signal !== 'SIGKILL') {
    throw new Error(`Expected SIGKILL, got code=${killed.code} signal=${killed.signal}: ${childStderr || childStdout}`)
  }

  const restarted = new SessionStore(root, 'workspace-patch-crash-smoke-model')
  await restarted.initialize()
  const recovered = await restarted.get(failpoint.sessionId)
  const workspace = restarted.workspaceDir(failpoint.sessionId)
  const events = await restarted.events(failpoint.sessionId)
  const recovery = events.find((event) => event.type === 'session.recovered')
  const transactionDirectory = restarted.workspacePatchTransactionDir(failpoint.sessionId)
  let remainingTransactions = []
  try {
    remainingTransactions = await readdir(transactionDirectory)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const eventCount = events.length
  const restartedAgain = new SessionStore(root, 'workspace-patch-crash-smoke-model')
  await restartedAgain.initialize()
  const repeatedEvents = await restartedAgain.events(failpoint.sessionId)
  const report = {
    sessionId: failpoint.sessionId,
    transactionId: failpoint.details.transactionId,
    childTermination: killed,
    installedCountAtFailpoint: failpoint.details.installedCount,
    changeCountAtFailpoint: failpoint.details.changeCount,
    firstAtFailpoint: failpoint.firstAtFailpoint,
    secondAtFailpoint: failpoint.secondAtFailpoint,
    eventCountAtFailpoint: failpoint.eventCount,
    recoveredFirst: await readFile(resolve(workspace, 'first.txt'), 'utf8'),
    recoveredSecond: await readFile(resolve(workspace, 'second.txt'), 'utf8'),
    recoveredWorkspaceBytes: recovered.summary.workspaceBytes,
    patchRecovery: recovery?.data?.workspacePatchReconciliation,
    remainingTransactions,
    recoveryEventCount: events.filter((event) => event.type === 'session.recovered').length,
    eventCount,
    eventCountAfterSecondRestart: repeatedEvents.length,
  }
  report.passed = report.childTermination.signal === 'SIGKILL'
    && report.installedCountAtFailpoint === 1
    && report.changeCountAtFailpoint === 2
    && report.firstAtFailpoint === 'first-after\n'
    && report.secondAtFailpoint === secondBefore
    && report.eventCountAtFailpoint === 1
    && report.recoveredFirst === firstBefore
    && report.recoveredSecond === secondBefore
    && report.recoveredWorkspaceBytes === Buffer.byteLength(firstBefore) + Buffer.byteLength(secondBefore)
    && report.patchRecovery?.[0]?.transactionId === report.transactionId
    && report.patchRecovery?.[0]?.phase === 'prepared'
    && report.patchRecovery?.[0]?.action === 'rolled_back'
    && report.remainingTransactions.length === 0
    && report.recoveryEventCount === 1
    && report.eventCountAfterSecondRestart === report.eventCount

  await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
  const reportPath = resolve('reports', 'real-smokes', `workspace-patch-crash-${failpoint.sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  await rm(root, { recursive: true, force: true })
}
