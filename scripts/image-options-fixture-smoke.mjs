import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const projectRoot = resolve(process.cwd())
const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/fixture-smokes')
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-image-options-fixture-'))
const image = await readFile(resolve(projectRoot, 'arena_probe_fixtures/M01_ui_reference.png'))
let server
let agent
let browser
let modelCall = 0
let generation = 0

try {
  const { createApp } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/app.js')).href)
  const client = {
    stream: async (options) => {
      modelCall += 1
      if (modelCall === 1) {
        return {
          content: '', reasoningContent: '', finishReason: 'tool_calls',
          toolCalls: [{
            id: 'call_image_options_fixture', type: 'function',
            function: {
              name: 'generate_image',
              arguments: JSON.stringify({
                file_path: 'images/selected-dashboard.png',
                prompt: 'One standalone operations dashboard illustration',
                offer_options: true,
              }),
            },
          }],
          usage: usage(10, 2),
        }
      }
      if (modelCall === 2) {
        const toolResult = options.messages.findLast((message) => message.tool_call_id === 'call_image_options_fixture')
        const payload = JSON.parse(String(toolResult?.content || '{}'))
        if (payload.status !== 'success' || !String(payload.message || '').includes('selected option 2 of 2')) {
          throw new Error(`Harness did not resume with the selected image result: ${JSON.stringify(payload)}`)
        }
        options.onContent('IMAGE-OPTIONS-FIXTURE-OK-731')
        return {
          content: 'IMAGE-OPTIONS-FIXTURE-OK-731', reasoningContent: '', finishReason: 'stop', toolCalls: [],
          usage: usage(14, 4),
        }
      }
      if (modelCall === 3) {
        if (options.tools.length !== 0) throw new Error('Exact Final formatter unexpectedly received tools')
        options.onContent('{"final":"IMAGE-OPTIONS-FIXTURE-OK-731"}')
        return {
          content: '{"final":"IMAGE-OPTIONS-FIXTURE-OK-731"}', reasoningContent: '', finishReason: 'stop', toolCalls: [],
          usage: usage(8, 3),
        }
      }
      throw new Error(`Unexpected extra model call ${modelCall}`)
    },
  }
  const created = await createApp({
    dataRoot,
    model: 'image-options-fixture-model',
    agent: {
      client,
      models: ['image-options-fixture-model'],
      runTimeoutMs: 30_000,
      toolExecutorDependencies: {
        imageApiKey: 'image-options-fixture-key',
        imageBaseUrl: 'https://images.fixture/v1',
        imageModel: 'image-options-fixture-generator',
        imageBattleModels: ['image-options-fixture-generator-a', 'image-options-fixture-generator-b'],
        fetch: async () => {
          generation += 1
          return Response.json({
            data: [{ b64_json: image.toString('base64') }],
            usage: { input_tokens: 5 + generation, output_tokens: 7 + generation, total_tokens: 12 + generation * 2 },
          })
        },
      },
    },
  })
  agent = created.agent
  server = createServer(created.app)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Image-options fixture server did not bind')
  const base = `http://127.0.0.1:${address.port}`

  const createdSession = await postJson(base, '/api/sessions', {}, 201)
  const sessionId = createdSession.session.id
  await postJson(base, `/api/sessions/${sessionId}/messages`, {
    attachments: [],
    timezone: 'Asia/Shanghai',
    content: 'Generate one dashboard image, show me separate options, and after I select one output exactly IMAGE-OPTIONS-FIXTURE-OK-731.',
  }, 202)
  const awaiting = await waitForStatus(base, sessionId, new Set(['awaiting_user', 'failed', 'timed_out']))
  if (awaiting.session.status !== 'awaiting_user') throw new Error(`Image options did not pause for the user: ${awaiting.session.status}`)
  const required = awaiting.events.filter((event) => event.type === 'hitl.required' && event.data.kind === 'generate_image')
  if (required.length !== 1 || required[0].data.payload?.candidates?.length !== 2 || generation !== 2) {
    throw new Error(`Image options fixture did not publish exactly two candidates: ${JSON.stringify({ required: required.length, generation })}`)
  }

  await mkdir(reportDirectory, { recursive: true })
  const { findBrowserExecutable } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/browser-executable.js')).href)
  browser = await chromium.launch({
    executablePath: findBrowserExecutable(process.env.ANERA_BROWSER_EXECUTABLE),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 })
  const consoleErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await page.goto(`${base}/agent/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  const dialog = page.getByRole('dialog', { name: 'Choose an image' })
  await dialog.waitFor({ state: 'visible' })
  if (await dialog.locator('.image-options button').count() !== 2) throw new Error('Desktop image chooser did not render two option buttons')
  await page.waitForFunction(() => [...document.querySelectorAll('.image-options img')]
    .every((candidate) => candidate.complete && candidate.naturalWidth > 0))
  const pendingScreenshot = resolve(reportDirectory, `image-options-${sessionId}-pending.png`)
  await page.screenshot({ path: pendingScreenshot, animations: 'disabled', caret: 'hide', type: 'png' })
  await dialog.getByRole('button', { name: /Use option 2/ }).click()

  const completed = await waitForStatus(base, sessionId, new Set(['completed', 'failed', 'timed_out']))
  if (completed.session.status !== 'completed') throw new Error(`Image options did not complete after selection: ${completed.session.status}`)
  const resolved = completed.events.filter((event) => event.type === 'hitl.resolved' && event.data.kind === 'generate_image')
  const completedTool = completed.events.find((event) => event.type === 'tool.completed' && event.data.call?.name === 'generate_image')
  const final = String(completed.events.findLast((event) => event.type === 'assistant.final')?.data?.content || '')
  if (resolved.length !== 1 || resolved[0].data.response?.selected_index !== 1 || !String(completedTool?.data?.result || '').includes('"selected_index":1')) {
    throw new Error(`Selected image was not durably resolved as option 2: ${JSON.stringify(resolved)}`)
  }
  if (final !== 'IMAGE-OPTIONS-FIXTURE-OK-731') throw new Error(`Unexpected image-options Final: ${JSON.stringify(final)}`)
  const artifact = completed.artifacts.find((candidate) => candidate.path === 'images/selected-dashboard.png')
  if (!artifact) throw new Error('Selected image Artifact was not published')

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.getByText('Image selected', { exact: true }).waitFor({ state: 'visible' })
  if (await page.locator('.tool-row').filter({ hasText: 'Generated images/selected-dashboard.png' }).count()) {
    throw new Error('Resolved image selection was duplicated by a normal tool row')
  }
  const resolvedScreenshot = resolve(reportDirectory, `image-options-${sessionId}-resolved.png`)
  await page.screenshot({ path: resolvedScreenshot, animations: 'disabled', caret: 'hide', type: 'png' })
  if (consoleErrors.length > 0) throw new Error(`Image-options UI console errors: ${JSON.stringify(consoleErrors)}`)

  const report = {
    generatedAt: new Date().toISOString(),
    kind: 'Anera deterministic fixture smoke; not Arena parity evidence',
    sessionId,
    status: completed.session.status,
    modelCalls: modelCall,
    generatedCandidates: generation,
    selectedIndex: resolved[0].data.response.selected_index,
    artifact: artifact.path,
    final,
    ui: { pendingScreenshot, resolvedScreenshot, consoleErrors },
    passed: true,
  }
  const reportPath = resolve(reportDirectory, `image-options-${sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
} finally {
  await browser?.close()
  await agent?.shutdown()
  if (server) await new Promise((resolveClose) => server.close(() => resolveClose()))
  await rm(dataRoot, { recursive: true, force: true })
}

function usage(promptTokens, completionTokens) {
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedPromptTokens: 0 }
}

async function postJson(base, path, body, expectedStatus) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (response.status !== expectedStatus) throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function waitForStatus(base, sessionId, statuses) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    if (!response.ok) throw new Error(`Snapshot failed: ${response.status} ${await response.text()}`)
    const snapshot = await response.json()
    if (statuses.has(snapshot.session.status)) return snapshot
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Session ${sessionId} did not reach one of ${[...statuses].join(', ')}`)
}
