import './legacy-live-test-disabled.mjs'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const projectRoot = resolve(process.cwd())
const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/real-smokes')
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-connector-load-'))
const connectorCalls = []
const connectorTool = {
  type: 'function',
  function: {
    name: 'synthetic_lookup',
    description: 'Look up one exact marker in the connected synthetic evidence service.',
    parameters: {
      type: 'object',
      properties: { marker: { type: 'string', minLength: 1 } },
      required: ['marker'],
      additionalProperties: false,
    },
  },
}

let server
let agent
let browser
try {
  const { createApp } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/app.js')).href)
  const created = await createApp({
    dataRoot,
    agent: {
      connectorTools: { synthetic: [connectorTool] },
      connectorExecutors: {
        synthetic: async (call, context) => {
          connectorCalls.push({
            name: call.name,
            arguments: call.arguments,
            sessionId: context.sessionId,
            turnId: context.turnId,
            stepId: context.stepId,
            callId: context.callId,
          })
          return {
            content: JSON.stringify({
              status: 'success',
              marker: call.arguments.marker,
              source: 'synthetic://evidence/PROBE-431',
              value: 'CONNECTED-EVIDENCE-731',
            }),
            isError: false,
          }
        },
      },
    },
  })
  agent = created.agent
  server = createServer(created.app)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Connector smoke server did not bind')
  const base = `http://127.0.0.1:${address.port}`

  const createdSession = await postJson(base, '/api/sessions', {}, 201)
  const sessionId = createdSession.session.id
  await postJson(base, `/api/sessions/${sessionId}/messages`, {
    attachments: [],
    timezone: 'Asia/Shanghai',
    content: 'First call list_connector_tools exactly once with service synthetic. Only after that succeeds, call the newly loaded synthetic_lookup tool exactly once with marker PROBE-431. Do not use any other tool. Use its returned evidence, then output exactly CONNECTOR-LOAD-OK-731 and nothing else.',
  }, 202)

  const snapshot = await waitForTerminal(base, sessionId)
  const startedTools = snapshot.events
    .filter((event) => event.type === 'tool.started')
    .map((event) => String(event.data?.call?.name || ''))
  const completedTools = snapshot.events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => String(event.data?.call?.name || ''))
  const failedTools = snapshot.events.filter((event) => event.type === 'tool.failed')
  const final = String(snapshot.events.findLast((event) => event.type === 'assistant.final')?.data?.content || '')
  const dynamicResult = snapshot.events.find((event) => (
    event.type === 'tool.completed' && event.data?.call?.name === 'synthetic_lookup'
  ))?.data?.result

  if (snapshot.session.status !== 'completed') throw new Error(`Connector run ended as ${snapshot.session.status}`)
  if (JSON.stringify(startedTools) !== JSON.stringify(['list_connector_tools', 'synthetic_lookup'])) {
    throw new Error(`Unexpected connector tool start sequence: ${JSON.stringify(startedTools)}`)
  }
  if (JSON.stringify(completedTools) !== JSON.stringify(startedTools) || failedTools.length > 0) {
    throw new Error(`Connector tools did not all complete: ${JSON.stringify({ completedTools, failed: failedTools.map((event) => event.data) })}`)
  }
  if (connectorCalls.length !== 1 || connectorCalls[0].arguments.marker !== 'PROBE-431') {
    throw new Error(`Connector executor did not receive the exact validated call: ${JSON.stringify(connectorCalls)}`)
  }
  if (!String(dynamicResult).includes('CONNECTED-EVIDENCE-731')) throw new Error(`Dynamic connector result is missing: ${JSON.stringify(dynamicResult)}`)
  if (final !== 'CONNECTOR-LOAD-OK-731') throw new Error(`Unexpected connector Final: ${JSON.stringify(final)}`)

  await mkdir(reportDirectory, { recursive: true })
  const consoleErrors = []
  const { findBrowserExecutable } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/browser-executable.js')).href)
  browser = await chromium.launch({
    executablePath: findBrowserExecutable(process.env.ANERA_BROWSER_EXECUTABLE),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 })
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await page.goto(`${base}/agent/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await page.locator('.tool-row').filter({ hasText: 'Checked synthetic' }).waitFor({ state: 'visible' })
  const dynamicToolRow = page.locator('.tool-row').filter({ hasText: 'synthetic lookup' })
  await dynamicToolRow.waitFor({ state: 'visible' })
  await dynamicToolRow.locator('button.tool-head').click()
  await dynamicToolRow.locator('.tool-body').filter({ hasText: 'CONNECTED-EVIDENCE-731' }).waitFor({ state: 'visible' })
  const screenshot = resolve(reportDirectory, `connector-tool-load-${sessionId}.png`)
  await page.screenshot({ path: screenshot, animations: 'disabled', caret: 'hide', type: 'png' })
  if (consoleErrors.length > 0) throw new Error(`Connector UI console errors: ${JSON.stringify(consoleErrors)}`)

  const report = {
    generatedAt: new Date().toISOString(),
    sessionId,
    status: snapshot.session.status,
    model: snapshot.session.model,
    usage: snapshot.session.usage,
    startedTools,
    completedTools,
    connectorCalls,
    dynamicResult: JSON.parse(String(dynamicResult)),
    final,
    ui: {
      listToolVisible: true,
      dynamicToolVisible: true,
      dynamicResultVisible: true,
      consoleErrors,
      screenshot,
    },
    passed: true,
  }
  const reportPath = resolve(reportDirectory, `connector-tool-load-${sessionId}.json`)
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

async function waitForTerminal(base, sessionId) {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    if (!response.ok) throw new Error(`Snapshot failed: ${response.status} ${await response.text()}`)
    const snapshot = await response.json()
    if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)) return snapshot
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  }
  throw new Error(`Session ${sessionId} did not finish before the connector smoke deadline`)
}
