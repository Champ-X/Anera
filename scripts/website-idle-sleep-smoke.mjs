import './legacy-live-test-disabled.mjs'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const projectRoot = resolve(process.cwd())
const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/real-smokes')
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-website-idle-sleep-'))
const websiteIdleSleepMs = 1_500
const websitePort = await reservePort()
let server
let agent
let store
let browser

try {
  const { createApp } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/app.js')).href)
  const created = await createApp({ dataRoot, agent: { websiteIdleSleepMs } })
  agent = created.agent
  store = created.store
  server = createServer(created.app)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Website idle-sleep smoke server did not bind')
  const base = `http://127.0.0.1:${address.port}`

  const createdSession = await postJson(base, '/api/sessions', {}, 201)
  const sessionId = createdSession.session.id
  await postJson(base, `/api/sessions/${sessionId}/messages`, {
    attachments: [],
    timezone: 'Asia/Shanghai',
    content: `Use write_file to create /home/user/stale-reference.svg with exact content <svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#000"/></svg>. Then use write_file to create /home/user/index.html with one visible h1 whose exact text is ARENA-ASLEEP-RESTART-731. Do not use bash. Use start_process exactly once with name "Arena asleep Website" and command exactly "python3 -u -m http.server ${websitePort} --bind 0.0.0.0". Then use get_process_output with wait_for=port to verify the same port. Do not stop the process. Finish with a concise answer that says the Website is ready and leave the managed process running.`,
  }, 202)

  const terminal = await waitFor(base, sessionId, (snapshot) => (
    ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)
  ), 240_000)
  if (terminal.session.status !== 'completed') throw new Error(`Website task ended as ${terminal.session.status}`)
  const completedTools = terminal.events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => String(event.data?.call?.name || ''))
  const failedTools = terminal.events.filter((event) => event.type === 'tool.failed')
  for (const required of ['write_file', 'start_process', 'get_process_output']) {
    if (!completedTools.includes(required)) throw new Error(`Required tool did not complete: ${required}`)
  }
  if (completedTools.includes('bash') || failedTools.length > 0) {
    throw new Error(`Website task used a forbidden fallback or failed: ${JSON.stringify({ completedTools, failedTools: failedTools.map((event) => event.data) })}`)
  }

  const firstAsleep = await waitFor(base, sessionId, (snapshot) => snapshot.website.status === 'asleep', 15_000)
  const firstProcessId = firstAsleep.website.processId
  const firstProcess = firstAsleep.processes.find((process) => process.id === firstProcessId)
  if (!firstProcessId || firstProcess?.status !== 'stopped') {
    throw new Error(`Terminal Website did not release its managed process: ${JSON.stringify({ website: firstAsleep.website, firstProcess })}`)
  }
  const firstSleepEvent = firstAsleep.events.findLast((event) => (
    event.type === 'website.updated' && event.data?.website?.status === 'asleep'
  ))
  if (firstSleepEvent?.data?.action !== 'process_stopped' || firstSleepEvent.data?.processStatus !== 'stopped') {
    throw new Error(`Website asleep event is incomplete: ${JSON.stringify(firstSleepEvent)}`)
  }
  const firstCanonical = await fetch(`${base}/api/sessions/${sessionId}/canonical.jsonl?task_id=U02`).then(async (response) => {
    if (!response.ok) throw new Error(`Canonical trace failed: ${response.status} ${await response.text()}`)
    return (await response.text()).trim().split('\n').map((line) => JSON.parse(line))
  })
  if (!firstCanonical.some((record) => record.recordType === 'event'
    && record.event.kind === 'website'
    && record.event.status === 'asleep')) {
    throw new Error('Canonical trace did not preserve the Website asleep state')
  }

  const unrelatedSubmit = await postJson(base, `/api/sessions/${sessionId}/messages`, {
    attachments: [],
    timezone: 'Asia/Shanghai',
    content: 'Do not use any tool. Compute 6 * 7. Your final answer must contain only the exact number.',
  }, 202)
  const unrelatedTerminal = await waitFor(base, sessionId, (snapshot) => (
    ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)
    && snapshot.events.some((event) => event.type === 'turn.completed' && event.turnId === unrelatedSubmit.turnId)
  ), 120_000)
  if (unrelatedTerminal.session.status !== 'completed') {
    throw new Error(`Unrelated task after Website sleep ended as ${unrelatedTerminal.session.status}`)
  }
  const unrelatedCalls = unrelatedTerminal.events
    .filter((event) => event.type === 'tool.started' && event.turnId === unrelatedSubmit.turnId)
    .map((event) => String(event.data?.call?.name || ''))
  if (unrelatedCalls.length > 0) {
    throw new Error(`Unrelated task after Website sleep unexpectedly used tools: ${JSON.stringify(unrelatedCalls)}`)
  }
  const unrelatedFinal = String(unrelatedTerminal.events.findLast((event) => (
    event.type === 'assistant.final' && event.turnId === unrelatedSubmit.turnId
  ))?.data?.content || '')
  if (unrelatedFinal.trim() !== '42') throw new Error(`Unrelated task returned the wrong Final: ${unrelatedFinal}`)
  const { estimateToolSurfaceTokens } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/agent-service.js')).href)
  const { ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS, EXTENSION_TOOL_DEFINITIONS } = await import(
    pathToFileURL(resolve(projectRoot, 'dist-server/server/tools.js')).href
  )
  const activeToolSurfaceTokens = estimateToolSurfaceTokens(ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS)
  const browserToolSurfaceTokens = estimateToolSurfaceTokens([
    ...ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS,
    EXTENSION_TOOL_DEFINITIONS.browser,
  ])
  const inspectImageToolSurfaceTokens = estimateToolSurfaceTokens([
    ...ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS,
    EXTENSION_TOOL_DEFINITIONS.inspect_image,
  ])
  const staleExtensionToolSurfaceTokens = estimateToolSurfaceTokens([
    ...ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS,
    EXTENSION_TOOL_DEFINITIONS.inspect_image,
    EXTENSION_TOOL_DEFINITIONS.browser,
  ])
  const routingState = await store.get(sessionId)
  if (routingState.contextPressure?.sampledToolSurfaceTokens !== activeToolSurfaceTokens) {
    throw new Error(`Unrelated task did not reset to the active 19-tool surface: ${JSON.stringify(routingState.contextPressure)}`)
  }
  if (routingState.website.status !== 'asleep') {
    throw new Error(`Unrelated task changed the stale Website state: ${JSON.stringify(routingState.website)}`)
  }
  if (!routingState.artifacts.some((artifact) => artifact.path === 'stale-reference.svg' && artifact.kind === 'image')) {
    throw new Error(`Stale image Artifact was not preserved for the routing boundary: ${JSON.stringify(routingState.artifacts)}`)
  }

  await mkdir(reportDirectory, { recursive: true })
  const consoleErrors = []
  const { findBrowserExecutable } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/browser-executable.js')).href)
  browser = await chromium.launch({
    executablePath: findBrowserExecutable(process.env.ANERA_BROWSER_EXECUTABLE),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 })
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await page.goto(`${base}/agent/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  const workspace = page.locator('.workspace-panel')
  await workspace.waitFor({ state: 'visible' })
  await workspace.locator('.website-state').filter({ hasText: 'Asleep' }).waitFor({ state: 'visible' })
  const firstScreenshot = resolve(reportDirectory, `website-asleep-${sessionId}-before-restart.png`)
  await page.screenshot({ path: firstScreenshot, animations: 'disabled', caret: 'hide', type: 'png' })

  await workspace.getByRole('button', { name: 'Restart', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'Website preview' })
  await preview.waitFor({ state: 'visible', timeout: 15_000 })
  await preview.frameLocator('iframe').getByRole('heading', { name: 'ARENA-ASLEEP-RESTART-731', exact: true }).waitFor({ state: 'visible' })
  const running = await waitFor(base, sessionId, (snapshot) => (
    snapshot.website.status === 'running' && snapshot.website.processId !== firstProcessId
  ), 10_000)
  const restartedProcessId = running.website.processId
  if (!restartedProcessId || running.website.restartCount !== 1) {
    throw new Error(`Website Restart did not create a new live process: ${JSON.stringify(running.website)}`)
  }
  const response = await fetch(running.website.previewUrl)
  if (!response.ok || !(await response.text()).includes('ARENA-ASLEEP-RESTART-731')) {
    throw new Error('Restarted Website did not serve the original workspace artifact')
  }

  const secondAsleep = await waitFor(base, sessionId, (snapshot) => (
    snapshot.website.status === 'asleep'
    && snapshot.website.processId === restartedProcessId
    && snapshot.processes.some((process) => process.id === restartedProcessId && process.status === 'stopped')
  ), 15_000)
  await preview.waitFor({ state: 'detached', timeout: 10_000 })
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await workspace.locator('.website-state').filter({ hasText: 'Asleep' }).waitFor({ state: 'visible' })
  const secondScreenshot = resolve(reportDirectory, `website-asleep-${sessionId}-after-restart.png`)
  await page.screenshot({ path: secondScreenshot, animations: 'disabled', caret: 'hide', type: 'png' })
  if (consoleErrors.length > 0) throw new Error(`Website idle-sleep UI console errors: ${JSON.stringify(consoleErrors)}`)

  const sleepEvents = secondAsleep.events.filter((event) => (
    event.type === 'website.updated' && event.data?.website?.status === 'asleep'
  ))
  if (sleepEvents.length !== 2) throw new Error(`Expected two durable idle sleeps, found ${sleepEvents.length}`)
  const report = {
    generatedAt: new Date().toISOString(),
    sessionId,
    status: secondAsleep.session.status,
    model: secondAsleep.session.model,
    usage: secondAsleep.session.usage,
    websiteIdleSleepMs,
    websitePort,
    completedTools,
    unrelatedTask: {
      turnId: unrelatedSubmit.turnId,
      final: unrelatedFinal,
      toolCalls: unrelatedCalls,
      activeToolSurfaceTokens,
      browserToolSurfaceTokens,
      inspectImageToolSurfaceTokens,
      staleExtensionToolSurfaceTokens,
      avoidedToolSurfaceTokens: staleExtensionToolSurfaceTokens - activeToolSurfaceTokens,
      websiteStatus: routingState.website.status,
      staleImagePath: 'stale-reference.svg',
    },
    firstProcessId,
    restartedProcessId,
    restartCount: secondAsleep.website.restartCount,
    sleepEvents: sleepEvents.map((event) => ({ seq: event.seq, action: event.data.action, status: event.data.website.status })),
    canonicalAsleep: true,
    ui: { firstScreenshot, secondScreenshot, consoleErrors },
    passed: true,
  }
  const reportPath = resolve(reportDirectory, `website-idle-sleep-${sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
} finally {
  await browser?.close()
  await agent?.shutdown()
  if (server) await new Promise((resolveClose) => server.close(() => resolveClose()))
  await rm(dataRoot, { recursive: true, force: true })
}

async function postJson(base, path, body, expectedStatus) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status !== expectedStatus) throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function waitFor(base, sessionId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    if (!response.ok) throw new Error(`Snapshot failed: ${response.status} ${await response.text()}`)
    last = await response.json()
    if (predicate(last)) return last
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Session ${sessionId} did not reach the expected state: ${JSON.stringify({ status: last?.session?.status, website: last?.website })}`)
}

async function reservePort() {
  const probe = createServer()
  await new Promise((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('Port probe did not bind')
  const port = address.port
  await new Promise((resolveClose) => probe.close(() => resolveClose()))
  return port
}
