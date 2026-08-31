import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = process.cwd()
const serverEntry = resolve(projectRoot, 'dist-server/server/index.js')
const sessionStoreEntry = pathToFileURL(resolve(projectRoot, 'dist-server/server/session-store.js')).href
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-graceful-resources-'))
const model = 'graceful-resource-shutdown-model'
const websiteMarker = 'GRACEFUL-RESOURCE-WEBSITE-READY'
const partialUnit = 'RESOURCE-PARTIAL-BEFORE-SHUTDOWN '
const partialContent = `${partialUnit.repeat(12)}\n`
const managedPort = await reserveLoopbackPort()
let providerRequests = 0
let signalFinalProviderClosed = () => {}
const finalProviderClosed = new Promise((resolveClosed) => { signalFinalProviderClosed = resolveClosed })
const providerSockets = new Set()

const provider = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/chat/completions') {
    response.writeHead(404).end()
    return
  }
  request.resume()
  providerRequests += 1
  if (providerRequests === 1) {
    completeToolCalls(response, [
      toolCall(0, 'call_resource_index', 'create_file', {
        path: 'index.html',
        content: `<!doctype html><meta charset="utf-8"><title>Resource shutdown</title><h1>${websiteMarker}</h1>\n`,
      }),
      toolCall(1, 'call_resource_package', 'create_file', {
        path: 'package.json',
        content: `${JSON.stringify({ scripts: { start: `python3 -u -m http.server ${managedPort} --bind 127.0.0.1` } }, null, 2)}\n`,
      }),
    ], 120, 28)
    return
  }
  if (providerRequests === 2) {
    completeToolCalls(response, [toolCall(0, 'call_resource_start', 'build_and_start', {
      description: 'graceful resource shutdown fixture',
    })], 180, 18)
    return
  }
  if (providerRequests === 3) {
    completeToolCalls(response, [toolCall(0, 'call_resource_browser', 'browser', { action: 'open' })], 220, 16)
    return
  }
  if (providerRequests === 4) {
    openSse(response)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: partialContent }, finish_reason: null }] })}\n\n`)
    response.once('close', signalFinalProviderClosed)
    return
  }
  response.writeHead(500).end('Unexpected provider request')
})
provider.on('connection', (socket) => {
  providerSockets.add(socket)
  socket.once('close', () => providerSockets.delete(socket))
})

await listen(provider)
const providerAddress = provider.address()
if (!providerAddress || typeof providerAddress === 'string') throw new Error('Fake provider did not bind a port')
const agentPort = await reserveLoopbackPort()
const origin = `http://127.0.0.1:${agentPort}`
const child = spawn(process.execPath, [serverEntry], {
  cwd: dataRoot,
  env: {
    ...process.env,
    ANERA_DATA_DIR: dataRoot,
    ANERA_PORT: String(agentPort),
    ANERA_RUN_TIMEOUT_MS: '120000',
    ANERA_TOOL_TIMEOUT_MS: '30000',
    ANERA_MODEL_FIRST_EVENT_TIMEOUT_MS: '120000',
    DEEPSEEK_API_KEY: 'synthetic-graceful-resource-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerAddress.port}`,
    DEEPSEEK_MODEL: model,
    ANERA_AGENT_MODELS: model,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childStdout = ''
let childStderr = ''
child.stdout.on('data', (chunk) => { childStdout += String(chunk) })
child.stderr.on('data', (chunk) => { childStderr += String(chunk) })
const childClosed = new Promise((resolveClosed) => child.once('close', (code, signal) => resolveClosed({ code, signal })))

let sessionId
try {
  await waitForHealth(origin, child, () => childStderr || childStdout)
  const created = await requestJson(`${origin}/api/sessions`, { method: 'POST' })
  sessionId = created.session?.id
  if (!sessionId) throw new Error(`Session creation returned no ID: ${JSON.stringify(created)}`)
  await requestJson(`${origin}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: 'Create and start a local Website, test it in the browser, and keep the response stream open afterward so service shutdown can verify every live resource.',
    }),
  })
  const ready = await waitForResources(origin, sessionId)
  const previewResponse = await fetch(ready.snapshot.website.previewUrl, { signal: AbortSignal.timeout(2_000) })
  const previewText = await previewResponse.text()
  if (!previewResponse.ok || !previewText.includes(websiteMarker)) throw new Error('Managed Website was not actually reachable before shutdown')

  const processRecord = ready.snapshot.processes.find((record) => record.status === 'running')
  if (!processRecord?.pid) throw new Error('Managed process had no live guardian PID')
  const descendants = await descendantProcesses(child.pid)
  const browserDescendants = descendants.filter((entry) => /(?:chrome|chromium)/i.test(entry.command))
  const guardianDescendants = descendants.filter((entry) => entry.command.includes('managed-process-guardian.mjs'))
  if (browserDescendants.length === 0) throw new Error(`No Chromium descendant was found: ${JSON.stringify(descendants)}`)
  if (!guardianDescendants.some((entry) => entry.pid === processRecord.pid)) {
    throw new Error(`Managed guardian ${processRecord.pid} was not a production-server descendant`)
  }

  const shutdownStartedAt = Date.now()
  if (!child.kill('SIGTERM')) throw new Error('Failed to deliver SIGTERM to the production server')
  const termination = await withDeadline(childClosed, 6_000, 'Production resource shutdown exceeded its five-second deadline')
  const shutdownDurationMs = Date.now() - shutdownStartedAt
  const finalProviderConnectionClosed = await Promise.race([
    finalProviderClosed.then(() => true),
    delay(1_000).then(() => false),
  ])
  const descendantsGone = await waitForPidsToExit(descendants.map((entry) => entry.pid), 2_000)
  const previewClosed = await waitForPortClosed(managedPort, 2_000)

  const { SessionStore } = await import(sessionStoreEntry)
  const restarted = new SessionStore(dataRoot, model)
  await restarted.initialize()
  const state = await restarted.get(sessionId)
  const events = await restarted.events(sessionId)
  const durableProcess = state.processes.find((record) => record.id === processRecord.id)
  const stoppedEvents = events.filter((event) => event.type === 'process.stopped' && event.data?.record?.id === processRecord.id)
  const failedWebsiteEvents = events.filter((event) => (
    event.type === 'website.updated'
    && event.data?.action === 'process_stopped'
    && event.data?.website?.processId === processRecord.id
  ))
  const partialText = events.filter((event) => event.type === 'assistant.final.delta').map((event) => String(event.data?.delta || '')).join('')
  const report = {
    sessionId,
    providerRequests,
    toolSequence: events.filter((event) => event.type === 'tool.completed').map((event) => event.data?.call?.name),
    preShutdown: {
      sessionStatus: ready.snapshot.session.status,
      websiteStatus: ready.snapshot.website.status,
      websitePort: ready.snapshot.website.port,
      processId: processRecord.id,
      processPid: processRecord.pid,
      browserDiagnostics: ready.health.browser,
      descendantCount: descendants.length,
      browserDescendantCount: browserDescendants.length,
      guardianDescendantCount: guardianDescendants.length,
      visiblePartialBytes: Buffer.byteLength(partialText),
    },
    shutdownDurationMs,
    childTermination: termination,
    finalProviderConnectionClosed,
    providerSocketsBeforeCleanup: providerSockets.size,
    descendantsGone,
    previewClosed,
    recovered: {
      sessionStatus: state.summary.status,
      processStatus: durableProcess?.status,
      processSignal: durableProcess?.signal,
      websiteStatus: state.website.status,
      stoppedEventCount: stoppedEvents.length,
      failedWebsiteEventCount: failedWebsiteEvents.length,
      interruptedErrorCount: events.filter((event) => event.type === 'error' && event.data?.interrupted === true).length,
      finalCount: events.filter((event) => event.type === 'assistant.final').length,
      reviewCount: events.filter((event) => event.type === 'review.requested').length,
    },
  }
  report.passed = report.providerRequests === 4
    && JSON.stringify(report.toolSequence) === JSON.stringify(['create_file', 'create_file', 'build_and_start', 'browser'])
    && report.preShutdown.sessionStatus === 'running'
    && report.preShutdown.websiteStatus === 'running'
    && report.preShutdown.websitePort === managedPort
    && report.preShutdown.browserDiagnostics?.browserInstances === 1
    && report.preShutdown.browserDiagnostics?.sessionContexts === 1
    && report.preShutdown.visiblePartialBytes > 0
    && report.shutdownDurationMs < 5_000
    && report.childTermination.code === 0
    && report.childTermination.signal === null
    && report.finalProviderConnectionClosed
    && report.providerSocketsBeforeCleanup === 0
    && report.descendantsGone
    && report.previewClosed
    && report.recovered.sessionStatus === 'interrupted'
    && report.recovered.processStatus === 'stopped'
    && report.recovered.websiteStatus === 'failed'
    && report.recovered.stoppedEventCount === 1
    && report.recovered.failedWebsiteEventCount === 1
    && report.recovered.interruptedErrorCount === 1
    && report.recovered.finalCount === 0
    && report.recovered.reviewCount === 0

  const reportRoot = resolve(projectRoot, 'reports', 'real-smokes')
  await mkdir(reportRoot, { recursive: true })
  const reportPath = resolve(reportRoot, `graceful-resource-shutdown-${sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await childClosed
  provider.closeAllConnections()
  await close(provider)
  await rm(dataRoot, { recursive: true, force: true })
}

function toolCall(index, id, name, args) {
  return { index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function openSse(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.flushHeaders()
}

function completeToolCalls(response, calls, promptTokens, completionTokens) {
  openSse(response)
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ choices: [], usage: {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_cache_hit_tokens: 0,
  } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

async function waitForResources(origin, sessionId) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const [snapshot, health] = await Promise.all([
      requestJson(`${origin}/api/sessions/${sessionId}`),
      requestJson(`${origin}/api/health`),
    ])
    const tools = snapshot.events?.filter((event) => event.type === 'tool.completed').map((event) => event.data?.call?.name) ?? []
    const visiblePartial = snapshot.events?.some((event) => event.type === 'assistant.final.delta' && String(event.data?.delta || '').startsWith(partialUnit))
    if (
      providerRequests === 4
      && snapshot.session?.status === 'running'
      && snapshot.website?.status === 'running'
      && snapshot.processes?.some((record) => record.status === 'running')
      && health.browser?.browserInstances === 1
      && health.browser?.sessionContexts === 1
      && tools.includes('build_and_start')
      && tools.includes('browser')
      && visiblePartial
    ) return { snapshot, health }
    if (snapshot.session && ['failed', 'cancelled', 'timed_out', 'interrupted', 'completed'].includes(snapshot.session.status)) {
      throw new Error(`Resource fixture terminated early: ${JSON.stringify({ status: snapshot.session.status, events: snapshot.events?.slice(-8) })}`)
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for production resources; providerRequests=${providerRequests}`)
}

async function descendantProcesses(rootPid) {
  if (!rootPid) return []
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 4 * 1024 * 1024 })
  const rows = stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
  })
  const descendants = []
  const parents = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!parents.has(row.ppid) || parents.has(row.pid)) continue
      parents.add(row.pid)
      descendants.push(row)
      changed = true
    }
  }
  return descendants
}

async function waitForPidsToExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pids.every((pid) => !pidAlive(pid))) return true
    await delay(25)
  }
  return pids.every((pid) => !pidAlive(pid))
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitForPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(100) })
    } catch {
      return true
    }
    await delay(25)
  }
  return false
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
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) throw new Error(`Production server exited before health: ${diagnostics()}`)
    try {
      if ((await requestJson(`${origin}/api/health`)).ok) return
    } catch {}
    await delay(25)
  }
  throw new Error(`Timed out waiting for production health: ${diagnostics()}`)
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
    if (timer) clearTimeout(timer)
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
