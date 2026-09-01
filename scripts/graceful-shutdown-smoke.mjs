import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const projectRoot = process.cwd()
const serverEntry = resolve(projectRoot, 'dist-server/server/index.js')
const sessionStoreEntry = pathToFileURL(resolve(projectRoot, 'dist-server/server/session-store.js')).href
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-graceful-shutdown-'))
await symlink(resolve(projectRoot, 'dist-client'), resolve(dataRoot, 'dist-client'), 'dir')
const model = 'graceful-shutdown-smoke-model'
const partialUnit = 'PARTIAL-BEFORE-SERVICE-SHUTDOWN '
const partialMarker = `${partialUnit.repeat(12)}\n`

let signalProviderRequest = () => {}
const providerRequestReceived = new Promise((resolveReceived) => { signalProviderRequest = resolveReceived })
let signalProviderClosed = () => {}
const providerConnectionClosed = new Promise((resolveClosed) => { signalProviderClosed = resolveClosed })
let providerRequests = 0
const providerSockets = new Set()

const provider = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/chat/completions') {
    response.writeHead(404).end()
    return
  }
  providerRequests += 1
  request.resume()
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.flushHeaders()
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: partialMarker }, finish_reason: null }] })}\n\n`)
  // Leave the provider stream unfinished after one visible delta. SIGTERM must
  // preserve exactly those bytes without promoting them to a completed Final.
  response.once('close', signalProviderClosed)
  signalProviderRequest()
})
provider.on('connection', (socket) => {
  providerSockets.add(socket)
  socket.once('close', () => providerSockets.delete(socket))
})

await listen(provider)
const providerAddress = provider.address()
if (!providerAddress || typeof providerAddress === 'string') throw new Error('Fake provider did not bind a TCP port')
const agentPort = await reserveLoopbackPort()
const agentOrigin = `http://127.0.0.1:${agentPort}`
const productionEnvironment = {
  ...process.env,
  ANERA_DATA_DIR: dataRoot,
  ANERA_PORT: String(agentPort),
  ANERA_RUN_TIMEOUT_MS: '120000',
  ANERA_MODEL_FIRST_EVENT_TIMEOUT_MS: '120000',
  NODE_ENV: 'test',
  ANERA_TEST_LOOPBACK_DEEPSEEK_PROVIDER: 'true',
  DEEPSEEK_API_KEY: 'synthetic-graceful-shutdown-key',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerAddress.port}`,
  DEEPSEEK_MODEL: model,
  ANERA_AGENT_MODELS: model,
}

const child = spawn(process.execPath, [serverEntry], {
  cwd: dataRoot,
  env: productionEnvironment,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childStdout = ''
let childStderr = ''
child.stdout.on('data', (chunk) => { childStdout += String(chunk) })
child.stderr.on('data', (chunk) => { childStderr += String(chunk) })
const childClosed = new Promise((resolveClosed) => {
  child.once('close', (code, signal) => resolveClosed({ code, signal }))
})

let sessionId
let sseController
let recoveryChild
let recoveryChildClosed
let recoveryBrowser
try {
  await waitForHealth(agentOrigin, child, () => childStderr || childStdout)
  const created = await requestJson(`${agentOrigin}/api/sessions`, { method: 'POST' })
  sessionId = created.session?.id
  if (!sessionId) throw new Error(`Session creation returned no ID: ${JSON.stringify(created)}`)
  sseController = new AbortController()
  const sseResponse = await fetch(`${agentOrigin}/api/sessions/${sessionId}/events`, { signal: sseController.signal })
  if (!sseResponse.ok || !sseResponse.body) throw new Error(`SSE connection failed (${sseResponse.status})`)
  const sseReader = sseResponse.body.getReader()
  const sseConnectionClosed = (async () => {
    try {
      while (true) {
        const { done } = await sseReader.read()
        if (done) return true
      }
    } catch {
      return true
    }
  })()
  await requestJson(`${agentOrigin}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: 'Keep the model stream open until the service receives SIGTERM.' }),
  })
  await withDeadline(providerRequestReceived, 5_000, 'Timed out waiting for the fake provider request')
  await waitForVisiblePartial(agentOrigin, sessionId, partialUnit)

  const shutdownStartedAt = Date.now()
  if (!child.kill('SIGTERM')) throw new Error('Failed to deliver SIGTERM to the production server')
  const admissionClosedAt = await waitForAdmissionClose(agentOrigin, shutdownStartedAt)
  const termination = await withDeadline(childClosed, 6_000, 'Production server exceeded its five-second shutdown deadline')
  const shutdownDurationMs = Date.now() - shutdownStartedAt
  const sseClosedBeforeCleanup = await Promise.race([
    sseConnectionClosed,
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 1_000)),
  ])
  const providerClosedBeforeCleanup = await Promise.race([
    providerConnectionClosed.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 1_000)),
  ])

  const { SessionStore } = await import(sessionStoreEntry)
  const restarted = new SessionStore(dataRoot, model)
  await restarted.initialize()
  const state = await restarted.get(sessionId)
  const events = await restarted.events(sessionId)
  const interruptedErrors = events.filter((event) => event.type === 'error' && event.data?.interrupted === true)
  const turnTerminals = events.filter((event) => event.type === 'turn.completed')
  const interruptedRunStatuses = events.filter((event) => event.type === 'run.status' && event.data?.status === 'interrupted')
  const visiblePartialDeltas = events.filter((event) => event.type === 'assistant.final.delta')
  const visiblePartialText = visiblePartialDeltas.map((event) => String(event.data?.delta || '')).join('')
  const persistedPartialMessages = state.messages.filter((message) => message.role === 'assistant' && message.content === visiblePartialText)
  const reportRoot = resolve(projectRoot, 'reports', 'real-smokes')
  await mkdir(reportRoot, { recursive: true })

  let recoveryStdout = ''
  let recoveryStderr = ''
  recoveryChild = spawn(process.execPath, [serverEntry], {
    cwd: dataRoot,
    env: productionEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  recoveryChild.stdout.on('data', (chunk) => { recoveryStdout += String(chunk) })
  recoveryChild.stderr.on('data', (chunk) => { recoveryStderr += String(chunk) })
  recoveryChildClosed = new Promise((resolveClosed) => {
    recoveryChild.once('close', (code, signal) => resolveClosed({ code, signal }))
  })
  await waitForHealth(agentOrigin, recoveryChild, () => recoveryStderr || recoveryStdout)
  const { findBrowserExecutable } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/browser-executable.js')).href)
  recoveryBrowser = await chromium.launch({
    executablePath: findBrowserExecutable(process.env.ANERA_BROWSER_EXECUTABLE),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await recoveryBrowser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await page.goto(`${agentOrigin}/agent/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  const errorCard = page.locator('.error-event').filter({ hasText: 'Agent service shut down while the run was active.' })
  const partialCard = page.locator('.final-answer').filter({ hasText: partialUnit.trim() })
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
  await errorCard.waitFor({ state: 'visible' })
  await partialCard.waitFor({ state: 'visible' })
  await continueButton.waitFor({ state: 'visible' })
  const recoveredUiScreenshot = resolve(reportRoot, `graceful-shutdown-${sessionId}-recovered-ui.png`)
  await page.screenshot({ path: recoveredUiScreenshot, animations: 'disabled', caret: 'hide', type: 'png' })
  const recoveredUi = {
    errorVisible: await errorCard.isVisible(),
    partialVisible: await partialCard.isVisible(),
    continueVisible: await continueButton.isVisible(),
    reviewCount: await page.locator('.task-review-panel').count(),
    screenshot: recoveredUiScreenshot,
  }
  const recoveryShutdownStartedAt = Date.now()
  if (!recoveryChild.kill('SIGTERM')) throw new Error('Failed to deliver SIGTERM to the recovered production server')
  const recoveryTermination = await withDeadline(recoveryChildClosed, 6_000, 'Recovered production server exceeded its shutdown deadline with an active browser EventSource')
  const recoveryShutdownDurationMs = Date.now() - recoveryShutdownStartedAt
  await recoveryBrowser.close()
  recoveryBrowser = undefined

  const report = {
    sessionId,
    providerRequests,
    sseStatus: sseResponse.status,
    sseClosedBeforeCleanup,
    providerConnectionClosedBeforeCleanup: providerClosedBeforeCleanup,
    providerSocketsBeforeCleanup: providerSockets.size,
    admissionClosedAfterMs: admissionClosedAt - shutdownStartedAt,
    shutdownDurationMs,
    childTermination: termination,
    recoveredStatus: state.summary.status,
    pendingTerminalCleared: state.pendingTerminal === undefined,
    turnStartedCount: events.filter((event) => event.type === 'turn.started').length,
    interruptedErrorCount: interruptedErrors.length,
    interruptedError: interruptedErrors[0]?.data,
    visiblePartialBytes: Buffer.byteLength(visiblePartialText),
    visiblePartialIsProviderPrefix: partialMarker.startsWith(visiblePartialText),
    persistedPartialMessageCount: persistedPartialMessages.length,
    turnTerminalStatuses: turnTerminals.map((event) => event.data?.status),
    interruptedRunStatusCount: interruptedRunStatuses.length,
    finalCount: events.filter((event) => event.type === 'assistant.final').length,
    reviewCount: events.filter((event) => event.type === 'review.requested').length,
    recoveredUi,
    recoveryShutdownDurationMs,
    recoveryChildTermination: recoveryTermination,
  }
  report.passed = report.providerRequests === 1
    && report.sseStatus === 200
    && report.sseClosedBeforeCleanup
    && report.providerConnectionClosedBeforeCleanup
    && report.providerSocketsBeforeCleanup === 0
    && report.admissionClosedAfterMs < 1_000
    && report.shutdownDurationMs < 5_000
    && report.childTermination.code === 0
    && report.childTermination.signal === null
    && report.recoveredStatus === 'interrupted'
    && report.pendingTerminalCleared
    && report.turnStartedCount === 1
    && report.interruptedErrorCount === 1
    && report.interruptedError?.message === 'Agent service shut down while the run was active.'
    && report.interruptedError?.cancelled === false
    && report.interruptedError?.timedOut === false
    && report.interruptedError?.partialResponsePersisted === true
    && report.visiblePartialBytes > 0
    && report.visiblePartialIsProviderPrefix
    && report.persistedPartialMessageCount === 1
    && report.turnTerminalStatuses.length === 1
    && report.turnTerminalStatuses[0] === 'interrupted'
    && report.interruptedRunStatusCount === 1
    && report.finalCount === 0
    && report.reviewCount === 0
    && report.recoveredUi.errorVisible
    && report.recoveredUi.partialVisible
    && report.recoveredUi.continueVisible
    && report.recoveredUi.reviewCount === 0
    && report.recoveryShutdownDurationMs < 5_000
    && report.recoveryChildTermination.code === 0
    && report.recoveryChildTermination.signal === null

  const reportPath = resolve(reportRoot, `graceful-shutdown-${sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  sseController?.abort()
  await recoveryBrowser?.close().catch(() => undefined)
  if (recoveryChild && recoveryChild.exitCode === null && recoveryChild.signalCode === null) recoveryChild.kill('SIGKILL')
  if (recoveryChildClosed) await recoveryChildClosed
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  provider.closeAllConnections()
  await close(provider)
  await rm(dataRoot, { recursive: true, force: true })
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

async function waitForAdmissionClose(origin, startedAt) {
  const deadline = startedAt + 1_000
  while (Date.now() < deadline) {
    try {
      await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(100) })
    } catch {
      return Date.now()
    }
    await delay(10)
  }
  throw new Error('Production HTTP admission remained open for at least one second after SIGTERM')
}

async function waitForVisiblePartial(origin, sessionId, prefix) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const snapshot = await requestJson(`${origin}/api/sessions/${sessionId}`)
    if (snapshot.events?.some((event) => event.type === 'assistant.final.delta' && String(event.data?.delta || '').startsWith(prefix))) return
    await delay(10)
  }
  throw new Error('Timed out waiting for the provider partial to become visible and durable')
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
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}

async function withDeadline(promise, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
