import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const expectedContent = 'UPLOAD-CRASH-RECOVERY-7F31\n'

if (process.argv[2] === 'child') {
  const [, , , root, failpointPath] = process.argv
  if (!root || !failpointPath) throw new Error('child requires data root and failpoint path')
  const { SessionStore } = await import('../dist-server/server/session-store.js')
  const store = new SessionStore(root, 'upload-crash-smoke-model')
  await store.initialize()
  const session = await store.create()
  const originalAppend = store.append.bind(store)
  store.append = async (sessionId, type, data, context = {}) => {
    if (type !== 'file.changed') return await originalAppend(sessionId, type, data, context)
    const durable = await store.get(sessionId)
    const pending = Object.values(durable.pendingUploads ?? {})[0]
    const finalPath = pending ? resolve(store.workspaceDir(sessionId), pending.path) : undefined
    const temporaryPath = pending ? resolve(store.sessionDir(sessionId), pending.temporaryPath) : undefined
    await writeFile(failpointPath, `${JSON.stringify({
      sessionId,
      pending,
      finalBytes: finalPath ? (await stat(finalPath)).size : null,
      temporaryBytes: temporaryPath ? (await stat(temporaryPath)).size : null,
      eventCount: (await store.events(sessionId)).filter((event) => event.type === 'file.changed').length,
      workspaceBytes: durable.summary.workspaceBytes,
    })}\n`, 'utf8')
    setInterval(() => {}, 60_000)
    return await new Promise(() => {})
  }
  await store.createUpload(
    session.summary.id,
    'uploads/crash-evidence.txt',
    Buffer.from(expectedContent),
    'text/plain',
  )
}

const { SessionStore } = await import('../dist-server/server/session-store.js')
const root = await mkdtemp(resolve(tmpdir(), 'anera-upload-crash-'))
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
      if (parsed?.sessionId && parsed?.pending?.eventId && parsed?.eventCount === 0) return parsed
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Upload crash child exited before failpoint: ${childStderr || childStdout}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for upload crash failpoint')
}

try {
  const failpoint = await waitForFailpoint()
  child.kill('SIGKILL')
  const killed = await childClosed
  if (killed.signal !== 'SIGKILL') {
    throw new Error(`Expected SIGKILL, got code=${killed.code} signal=${killed.signal}: ${childStderr || childStdout}`)
  }

  const restarted = new SessionStore(root, 'upload-crash-smoke-model')
  await restarted.initialize()
  const recovered = await restarted.get(failpoint.sessionId)
  const events = await restarted.events(failpoint.sessionId)
  const uploadEvents = events.filter((event) => event.id === failpoint.pending.eventId)
  const recovery = events.find((event) => event.type === 'session.recovered')
  const finalPath = resolve(restarted.workspaceDir(failpoint.sessionId), failpoint.pending.path)
  const temporaryPath = resolve(restarted.sessionDir(failpoint.sessionId), failpoint.pending.temporaryPath)
  const recoveredContent = await readFile(finalPath, 'utf8')
  let temporaryExists = true
  try {
    await stat(temporaryPath)
  } catch (error) {
    if (error?.code === 'ENOENT') temporaryExists = false
    else throw error
  }
  const eventCount = events.length
  const restartedAgain = new SessionStore(root, 'upload-crash-smoke-model')
  await restartedAgain.initialize()
  const repeatedEvents = await restartedAgain.events(failpoint.sessionId)
  const report = {
    sessionId: failpoint.sessionId,
    childTermination: killed,
    pendingUploadAtFailpoint: failpoint.pending,
    fileChangedCountAtFailpoint: failpoint.eventCount,
    finalBytesAtFailpoint: failpoint.finalBytes,
    temporaryBytesAtFailpoint: failpoint.temporaryBytes,
    workspaceBytesAtFailpoint: failpoint.workspaceBytes,
    recoveredPendingUploads: recovered.pendingUploads ?? null,
    recoveredWorkspaceBytes: recovered.summary.workspaceBytes,
    recoveredContent,
    temporaryExistsAfterRecovery: temporaryExists,
    recoveredUploadEventCount: uploadEvents.length,
    recoveredUploadEvent: uploadEvents[0],
    uploadRecovery: recovery?.data?.uploadReconciliation,
    recoveryEventCount: events.filter((event) => event.type === 'session.recovered').length,
    eventCount,
    eventCountAfterSecondRestart: repeatedEvents.length,
  }
  report.passed = report.childTermination.signal === 'SIGKILL'
    && report.fileChangedCountAtFailpoint === 0
    && report.finalBytesAtFailpoint === Buffer.byteLength(expectedContent)
    && report.temporaryBytesAtFailpoint === Buffer.byteLength(expectedContent)
    && report.workspaceBytesAtFailpoint === 0
    && report.recoveredPendingUploads === null
    && report.recoveredWorkspaceBytes === Buffer.byteLength(expectedContent)
    && report.recoveredContent === expectedContent
    && report.temporaryExistsAfterRecovery === false
    && report.recoveredUploadEventCount === 1
    && report.recoveredUploadEvent?.data?.path === failpoint.pending.path
    && report.recoveredUploadEvent?.data?.operation === 'uploaded'
    && report.uploadRecovery?.checkpoints?.[0]?.reconstructedEvent === true
    && report.recoveryEventCount === 1
    && report.eventCountAfterSecondRestart === report.eventCount

  await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
  const reportPath = resolve('reports', 'real-smokes', `upload-crash-${failpoint.sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  await rm(root, { recursive: true, force: true })
}
