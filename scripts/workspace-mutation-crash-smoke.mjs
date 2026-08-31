import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const expectedContent = 'WORKSPACE-MUTATION-CRASH-2D91\n'

if (process.argv[2] === 'child') {
  const [, , , root, failpointPath] = process.argv
  if (!root || !failpointPath) throw new Error('child requires data root and failpoint path')
  const { SessionStore } = await import('../dist-server/server/session-store.js')
  const store = new SessionStore(root, 'workspace-mutation-crash-smoke-model')
  await store.initialize()
  const session = await store.create()
  const path = 'crash/durable.txt'
  const artifact = {
    id: 'art_workspace_mutation_crash',
    sessionId: session.summary.id,
    path,
    name: 'durable.txt',
    kind: 'markdown',
    mime: 'text/plain',
    createdAt: new Date().toISOString(),
    previewUrl: `/workspace/${session.summary.id}/file?path=${encodeURIComponent(path)}`,
    downloadUrl: `/api/sessions/${session.summary.id}/download?path=${encodeURIComponent(path)}`,
  }
  const originalAppend = store.append.bind(store)
  store.append = async (sessionId, type, data, context = {}) => {
    if (type !== 'file.changed') return await originalAppend(sessionId, type, data, context)
    const durable = await store.get(sessionId)
    const pending = Object.values(durable.pendingWorkspaceMutations ?? {})[0]
    const finalPath = pending ? resolve(store.workspaceDir(sessionId), pending.path) : undefined
    const temporaryPath = pending?.temporaryPath ? resolve(store.sessionDir(sessionId), pending.temporaryPath) : undefined
    await writeFile(failpointPath, `${JSON.stringify({
      sessionId,
      pending,
      finalBytes: finalPath ? (await stat(finalPath)).size : null,
      temporaryBytes: temporaryPath ? (await stat(temporaryPath)).size : null,
      fileEventCount: (await store.events(sessionId)).filter((event) => event.type === 'file.changed').length,
      artifactEventCount: (await store.events(sessionId)).filter((event) => event.type === 'artifact.created').length,
      workspaceBytes: durable.summary.workspaceBytes,
    })}\n`, 'utf8')
    setInterval(() => {}, 60_000)
    return await new Promise(() => {})
  }
  await store.commitWorkspaceWrite(session.summary.id, {
    path,
    content: expectedContent,
    mode: 'create',
    operation: 'created',
    artifact,
    context: { turnId: 'turn_crash', stepId: 'step_crash', callId: 'call_crash' },
  })
}

const { SessionStore } = await import('../dist-server/server/session-store.js')
const root = await mkdtemp(resolve(tmpdir(), 'anera-workspace-mutation-crash-'))
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
      if (parsed?.sessionId && parsed?.pending?.fileEventId && parsed?.fileEventCount === 0) return parsed
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Workspace-mutation crash child exited before failpoint: ${childStderr || childStdout}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for workspace-mutation crash failpoint')
}

try {
  const failpoint = await waitForFailpoint()
  child.kill('SIGKILL')
  const killed = await childClosed
  if (killed.signal !== 'SIGKILL') {
    throw new Error(`Expected SIGKILL, got code=${killed.code} signal=${killed.signal}: ${childStderr || childStdout}`)
  }

  const restarted = new SessionStore(root, 'workspace-mutation-crash-smoke-model')
  await restarted.initialize()
  const recovered = await restarted.get(failpoint.sessionId)
  const events = await restarted.events(failpoint.sessionId)
  const fileEvents = events.filter((event) => event.id === failpoint.pending.fileEventId)
  const artifactEvents = events.filter((event) => event.id === failpoint.pending.artifactEventId)
  const recovery = events.find((event) => event.type === 'session.recovered')
  const finalPath = resolve(restarted.workspaceDir(failpoint.sessionId), failpoint.pending.path)
  const stagingDirectory = restarted.workspaceMutationStagingDir(failpoint.sessionId)
  let stagingResidue = []
  try {
    stagingResidue = await readdir(stagingDirectory)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const eventCount = events.length
  const restartedAgain = new SessionStore(root, 'workspace-mutation-crash-smoke-model')
  await restartedAgain.initialize()
  const repeatedEvents = await restartedAgain.events(failpoint.sessionId)
  const report = {
    sessionId: failpoint.sessionId,
    childTermination: killed,
    pendingMutationAtFailpoint: failpoint.pending,
    fileEventCountAtFailpoint: failpoint.fileEventCount,
    artifactEventCountAtFailpoint: failpoint.artifactEventCount,
    finalBytesAtFailpoint: failpoint.finalBytes,
    temporaryBytesAtFailpoint: failpoint.temporaryBytes,
    workspaceBytesAtFailpoint: failpoint.workspaceBytes,
    recoveredPendingWorkspaceMutations: recovered.pendingWorkspaceMutations ?? null,
    recoveredWorkspaceBytes: recovered.summary.workspaceBytes,
    recoveredContent: await readFile(finalPath, 'utf8'),
    recoveredArtifacts: recovered.artifacts,
    stagingResidue,
    recoveredFileEventCount: fileEvents.length,
    recoveredArtifactEventCount: artifactEvents.length,
    workspaceMutationRecovery: recovery?.data?.workspaceMutationReconciliation,
    recoveryEventCount: events.filter((event) => event.type === 'session.recovered').length,
    eventCount,
    eventCountAfterSecondRestart: repeatedEvents.length,
  }
  report.passed = report.childTermination.signal === 'SIGKILL'
    && report.fileEventCountAtFailpoint === 0
    && report.artifactEventCountAtFailpoint === 0
    && report.finalBytesAtFailpoint === Buffer.byteLength(expectedContent)
    && report.temporaryBytesAtFailpoint === Buffer.byteLength(expectedContent)
    && report.workspaceBytesAtFailpoint === 0
    && report.recoveredPendingWorkspaceMutations === null
    && report.recoveredWorkspaceBytes === Buffer.byteLength(expectedContent)
    && report.recoveredContent === expectedContent
    && report.recoveredArtifacts.length === 1
    && report.recoveredArtifacts[0]?.path === failpoint.pending.path
    && report.stagingResidue.length === 0
    && report.recoveredFileEventCount === 1
    && report.recoveredArtifactEventCount === 1
    && report.workspaceMutationRecovery?.checkpoints?.[0]?.reconstructedFileEvent === true
    && report.workspaceMutationRecovery?.checkpoints?.[0]?.reconstructedArtifactEvent === true
    && report.recoveryEventCount === 1
    && report.eventCountAfterSecondRestart === report.eventCount

  await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
  const reportPath = resolve('reports', 'real-smokes', `workspace-mutation-crash-${failpoint.sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  await rm(root, { recursive: true, force: true })
}
