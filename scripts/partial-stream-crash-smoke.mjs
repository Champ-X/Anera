import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = process.cwd()
const serverEntry = resolve(projectRoot, 'dist-server/server/index.js')
const sessionStoreEntry = pathToFileURL(resolve(projectRoot, 'dist-server/server/session-store.js')).href
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-partial-stream-crash-'))
await symlink(resolve(projectRoot, 'dist-client'), resolve(dataRoot, 'dist-client'), 'dir')
const model = 'partial-stream-crash-smoke-model'
const partialMarker = `${'HARD-CRASH-VISIBLE-PREFIX '.repeat(20)}\n`
const finalMarker = 'HARD-CRASH-CONTINUE-CONTEXT-OK'

let providerRequests = 0
let firstProviderResponse
let resumeProviderPayload
let signalFirstRequest = () => {}
let signalResumeRequest = () => {}
const firstRequestReceived = new Promise((resolveReceived) => { signalFirstRequest = resolveReceived })
const resumeRequestReceived = new Promise((resolveReceived) => { signalResumeRequest = resolveReceived })
const provider = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/chat/completions') {
    response.writeHead(404).end()
    return
  }
  try {
    const body = await readRequestBody(request)
    const payload = JSON.parse(body)
    providerRequests += 1
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.flushHeaders()
    if (providerRequests === 1) {
      firstProviderResponse = response
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: partialMarker }, finish_reason: null }] })}\n\n`)
      signalFirstRequest()
      return
    }
    resumeProviderPayload = payload
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: finalMarker }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48, prompt_cache_hit_tokens: 0 } })}\n\n`)
    response.end('data: [DONE]\n\n')
    signalResumeRequest()
  } catch (error) {
    response.writeHead(500).end(String(error))
  }
})

await listen(provider)
const providerAddress = provider.address()
if (!providerAddress || typeof providerAddress === 'string') throw new Error('Synthetic provider did not bind a TCP port')
const agentPort = await reserveLoopbackPort()
const agentOrigin = `http://127.0.0.1:${agentPort}`
const productionEnvironment = {
  ...process.env,
  ANERA_DATA_DIR: dataRoot,
  ANERA_PORT: String(agentPort),
  ANERA_RUN_TIMEOUT_MS: '120000',
  ANERA_MODEL_FIRST_EVENT_TIMEOUT_MS: '120000',
  DEEPSEEK_API_KEY: 'synthetic-partial-stream-crash-key',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerAddress.port}`,
  DEEPSEEK_MODEL: model,
  ANERA_AGENT_MODELS: model,
}

let firstChild
let firstChildClosed
let recoveryChild
let recoveryChildClosed
let sessionId
let visiblePartial
try {
  const first = startServer(serverEntry, dataRoot, productionEnvironment)
  firstChild = first.child
  firstChildClosed = first.closed
  await waitForHealth(agentOrigin, firstChild, first.diagnostics)
  const created = await requestJson(`${agentOrigin}/api/sessions`, { method: 'POST' })
  sessionId = created.session?.id
  if (!sessionId) throw new Error(`Session creation returned no ID: ${JSON.stringify(created)}`)
  await requestJson(`${agentOrigin}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: 'Stream a visible prefix, then wait. After a restart, continue without repeating that prefix.' }),
  })
  await withDeadline(firstRequestReceived, 5_000, 'Timed out waiting for the first provider request')
  const beforeCrash = await waitForVisiblePartial(agentOrigin, sessionId)
  const firstTurnId = beforeCrash.events.find((event) => event.type === 'turn.started')?.turnId
  if (!firstTurnId) throw new Error('Initial turn ID was not visible before the crash')
  visiblePartial = beforeCrash.events
    .filter((event) => event.type === 'assistant.final.delta' && event.turnId === firstTurnId)
    .map((event) => String(event.data?.delta || ''))
    .join('')
  if (!visiblePartial || !partialMarker.startsWith(visiblePartial)) {
    throw new Error('The durable visible partial was not a provider-prefix boundary')
  }

  if (!firstChild.kill('SIGKILL')) throw new Error('Failed to deliver SIGKILL to the first production server')
  const firstTermination = await withDeadline(firstChildClosed, 3_000, 'First production server did not die after SIGKILL')
  firstProviderResponse?.destroy()

  const recovery = startServer(serverEntry, dataRoot, productionEnvironment)
  recoveryChild = recovery.child
  recoveryChildClosed = recovery.closed
  await waitForHealth(agentOrigin, recoveryChild, recovery.diagnostics)
  const recoveredSnapshot = await requestJson(`${agentOrigin}/api/sessions/${sessionId}`)
  if (recoveredSnapshot.session?.status !== 'interrupted') {
    throw new Error(`Expected interrupted recovery, got ${recoveredSnapshot.session?.status}`)
  }
  await requestJson(`${agentOrigin}/api/sessions/${sessionId}/resume`, { method: 'POST' })
  await withDeadline(resumeRequestReceived, 5_000, 'Timed out waiting for the resumed provider request')
  const completedSnapshot = await waitForTerminal(agentOrigin, sessionId, 'completed')

  if (!recoveryChild.kill('SIGTERM')) throw new Error('Failed to stop the recovered production server')
  const recoveryTermination = await withDeadline(recoveryChildClosed, 6_000, 'Recovered production server exceeded its shutdown deadline')

  const { SessionStore } = await import(sessionStoreEntry)
  const store = new SessionStore(dataRoot, model)
  await store.initialize()
  const durable = await store.get(sessionId)
  const durableEvents = await store.events(sessionId)
  const resumeMessages = Array.isArray(resumeProviderPayload?.messages) ? resumeProviderPayload.messages : []
  const partialIndex = resumeMessages.findIndex((message) => message?.role === 'assistant' && message?.content === visiblePartial)
  const continueIndex = resumeMessages.findIndex((message, index) => (
    index > partialIndex
    && message?.role === 'user'
    && String(message?.content || '').includes('[Harness operator action: Continue]')
  ))
  const recoveryEvent = durableEvents.find((event) => event.type === 'session.recovered')
  const interruptedError = durableEvents.find((event) => (
    event.type === 'error' && event.turnId === firstTurnId && event.data?.interrupted === true
  ))
  const interruptedTurn = durableEvents.find((event) => (
    event.type === 'turn.completed' && event.turnId === firstTurnId && event.data?.status === 'interrupted'
  ))
  const partialMessages = durable.messages.filter((message) => message.role === 'assistant' && message.content === visiblePartial)
  const firstTurnPartial = durableEvents
    .filter((event) => event.type === 'assistant.final.delta' && event.turnId === firstTurnId)
    .map((event) => String(event.data?.delta || ''))
    .join('')
  const final = durableEvents.findLast((event) => event.type === 'assistant.final')
  const report = {
    sessionId,
    providerRequests,
    firstTermination,
    recoveryTermination,
    recoveredStatusBeforeContinue: recoveredSnapshot.session.status,
    finalStatus: completedSnapshot.session.status,
    firstTurnId,
    visiblePartialBytes: Buffer.byteLength(firstTurnPartial),
    visiblePartialIsProviderPrefix: partialMarker.startsWith(firstTurnPartial),
    visiblePartialMatchesCrashBoundary: firstTurnPartial === visiblePartial,
    durablePartialMessageCount: partialMessages.length,
    resumeSawPartialAt: partialIndex,
    resumeSawContinueAt: continueIndex,
    resumeMessageRoles: resumeMessages.map((message) => message?.role),
    partialResponseReconciliation: recoveryEvent?.data?.partialResponseReconciliation,
    interruptedError: interruptedError?.data,
    interruptedTurnCount: interruptedTurn ? 1 : 0,
    recoveryEventCount: durableEvents.filter((event) => event.type === 'session.recovered').length,
    final: final?.data?.content,
    finalCount: durableEvents.filter((event) => event.type === 'assistant.final').length,
    reviewCount: durableEvents.filter((event) => event.type === 'review.requested').length,
    eventCountAfterSecondInitialization: durableEvents.length,
  }
  report.passed = report.providerRequests === 2
    && report.firstTermination.signal === 'SIGKILL'
    && report.recoveryTermination.code === 0
    && report.recoveryTermination.signal === null
    && report.recoveredStatusBeforeContinue === 'interrupted'
    && report.finalStatus === 'completed'
    && report.visiblePartialBytes > 0
    && report.visiblePartialIsProviderPrefix
    && report.visiblePartialMatchesCrashBoundary
    && report.durablePartialMessageCount === 1
    && report.resumeSawPartialAt >= 0
    && report.resumeSawContinueAt > report.resumeSawPartialAt
    && report.partialResponseReconciliation?.turnId === firstTurnId
    && report.partialResponseReconciliation?.messageAppended === true
    && report.partialResponseReconciliation?.visibleBytes === Buffer.byteLength(visiblePartial)
    && report.interruptedError?.partialResponsePersisted === true
    && report.interruptedTurnCount === 1
    && report.recoveryEventCount === 1
    && report.final === finalMarker
    && report.finalCount === 1
    && report.reviewCount === 1

  const reportRoot = resolve(projectRoot, 'reports', 'real-smokes')
  await mkdir(reportRoot, { recursive: true })
  const reportPath = resolve(reportRoot, `partial-stream-crash-${sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  firstProviderResponse?.destroy()
  if (firstChild && firstChild.exitCode === null && firstChild.signalCode === null) firstChild.kill('SIGKILL')
  if (firstChildClosed) await firstChildClosed
  if (recoveryChild && recoveryChild.exitCode === null && recoveryChild.signalCode === null) recoveryChild.kill('SIGKILL')
  if (recoveryChildClosed) await recoveryChildClosed
  provider.closeAllConnections()
  await close(provider)
  await rm(dataRoot, { recursive: true, force: true })
}

function startServer(entry, cwd, env) {
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const closed = new Promise((resolveClosed) => {
    child.once('close', (code, signal) => resolveClosed({ code, signal }))
  })
  return { child, closed, diagnostics: () => stderr || stdout }
}

async function readRequestBody(request) {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  return body
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(2_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url} failed (${response.status}): ${text}`)
  return text ? JSON.parse(text) : {}
}

async function waitForHealth(origin, processHandle, diagnostics) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      throw new Error(`Production server exited before health check: ${diagnostics()}`)
    }
    try {
      const health = await requestJson(`${origin}/api/health`)
      if (health.ok) return
    } catch {}
    await delay(25)
  }
  throw new Error(`Timed out waiting for production server health: ${diagnostics()}`)
}

async function waitForVisiblePartial(origin, sessionId) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const snapshot = await requestJson(`${origin}/api/sessions/${sessionId}`)
    const visible = snapshot.events
      ?.filter((event) => event.type === 'assistant.final.delta')
      .map((event) => String(event.data?.delta || ''))
      .join('')
    if (visible) return snapshot
    await delay(10)
  }
  throw new Error('Timed out waiting for the exact visible partial response')
}

async function waitForTerminal(origin, sessionId, expected) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const snapshot = await requestJson(`${origin}/api/sessions/${sessionId}`)
    if (snapshot.session?.status === expected) return snapshot
    if (['failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session?.status)) {
      throw new Error(`Expected ${expected}, got ${snapshot.session.status}: ${JSON.stringify(snapshot.events?.slice(-6))}`)
    }
    await delay(20)
  }
  throw new Error(`Timed out waiting for Session status ${expected}`)
}

async function reserveLoopbackPort() {
  const reservation = createServer()
  await listen(reservation)
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('Port reservation did not bind TCP')
  await close(reservation)
  return address.port
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
}

async function close(server) {
  if (!server.listening) return
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
}

async function withDeadline(promise, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
