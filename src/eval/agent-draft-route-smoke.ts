import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import type { DeepSeekClient } from '../server/deepseek.js'
import { findBrowserExecutable } from '../server/browser-executable.js'

const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-agent-draft-route-'))
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let server: ReturnType<typeof createServer> | undefined
let agent: { shutdown(): Promise<void> } | undefined

try {
  const { createApp } = await import('../server/app.js')
  const stream = async (options: Parameters<DeepSeekClient['stream']>[0]) => {
    const content = 'Draft task accepted.'
    options.onContent(content)
    return {
      content,
      reasoningContent: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16, cachedPromptTokens: 0 },
      modelCallCount: 1,
    }
  }
  const created = await createApp({
    dataRoot,
    agent: { client: { stream }, runTimeoutMs: 2_000 },
  })
  agent = created.agent
  const historical = await created.store.create()
  await created.store.update(historical.summary.id, (state) => {
    state.summary.title = 'Existing history'
    state.summary.lastMessage = 'A previously materialized task'
  })

  server = createServer(created.app)
  await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Draft-route fixture did not bind to a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`

  browser = await chromium.launch({
    executablePath: findBrowserExecutable(process.env.ANERA_BROWSER_EXECUTABLE),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const consoleErrors: string[] = []
  const stateChangingRequests: Array<{ path: string; body: unknown }> = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    const path = new URL(request.url()).pathname
    if (!['/api/sessions', '/api/storage/generate-agent-upload-url', '/nextjs-api/stream/create-chat'].includes(path)) return
    let body: unknown
    try { body = request.postDataJSON() }
    catch { body = request.postData() }
    stateChangingRequests.push({ path, body })
  })

  const sessionIds = async () => await page.evaluate(async () => {
    const response = await fetch('/api/sessions')
    const payload = await response.json() as { sessions: Array<{ id: string }> }
    return payload.sessions.map((session) => session.id)
  })
  const expectDraftRoute = async () => {
    await page.waitForURL((url) => url.pathname === '/agent', { timeout: 5_000 })
    await page.getByRole('heading', { name: 'What would you like to do?', exact: true }).waitFor({ state: 'visible' })
    if (await page.locator('.history-list button.active').count() !== 0) throw new Error('Blank Agent route selected a persisted history item')
  }

  await page.goto(`${baseUrl}/agent`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await expectDraftRoute()
  const initialIds = await sessionIds()
  if (initialIds.length !== 1 || initialIds[0] !== historical.summary.id) throw new Error(`Direct /agent hydration changed Sessions: ${JSON.stringify(initialIds)}`)

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await expectDraftRoute()
  if ((await sessionIds()).length !== 1) throw new Error('Refreshing /agent created a Session')

  let failNextUpload = true
  await page.route('**/api/storage/generate-agent-upload-url', async (route) => {
    if (failNextUpload) {
      failNextUpload = false
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic first-upload failure' }),
      })
      return
    }
    await route.continue()
  })

  const editor = page.getByRole('textbox', { name: 'Message', exact: true })
  await editor.fill('Use the attached draft evidence.')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'draft-evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('DRAFT-ATTACHMENT-BOUNDARY-731\n'),
  })
  await page.locator('.attachment-chip').filter({ hasText: 'draft-evidence.txt' }).waitFor({ state: 'visible' })
  if ((await sessionIds()).length !== 1) throw new Error('Selecting a draft attachment created a Session')

  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByText('Synthetic first-upload failure', { exact: false }).waitFor({ state: 'visible' })
  const afterFailedUploadIds = await sessionIds()
  if (afterFailedUploadIds.length !== 1 || afterFailedUploadIds[0] !== historical.summary.id) {
    throw new Error(`Failed pre-upload created a partial Session: ${JSON.stringify(afterFailedUploadIds)}`)
  }
  await expectDraftRoute()
  if ((await editor.textContent()) !== 'Use the attached draft evidence.') throw new Error('Upload failure did not preserve the migrated text draft')
  await page.locator('.attachment-chip').filter({ hasText: 'draft-evidence.txt' }).waitFor({ state: 'visible' })

  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForURL((url) => /^\/agent\/ses_[a-z0-9]{20}$/.test(url.pathname), { timeout: 5_000 })
  const materializedId = page.url().match(/\/agent\/(ses_[a-z0-9]{20})/)?.[1]
  if (!materializedId) throw new Error(`Successful retry did not materialize a canonical Session route: ${page.url()}`)
  await page.getByText('Draft task accepted.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  if ((await sessionIds()).length !== 2) throw new Error('Retry after upload failure created a duplicate Session')
  if (await page.locator('.attachment-chip').count() !== 0) throw new Error('Successful first turn did not clear the attachment draft')

  let snapshot: Awaited<ReturnType<typeof created.store.get>> | undefined
  for (let attempt = 0; attempt < 100; attempt += 1) {
    snapshot = await created.store.get(materializedId)
    if (snapshot.summary.status === 'completed') break
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  if (snapshot?.summary.status !== 'completed') throw new Error(`Materialized draft ended as ${snapshot?.summary.status ?? 'missing'}`)
  const events = await created.store.events(materializedId)
  const turn = events.find((event) => event.type === 'turn.started')
  const turnData = turn?.data as { content?: string; attachments?: string[] } | undefined
  if (turnData?.content !== 'Use the attached draft evidence.' || turnData.attachments?.length !== 1) {
    throw new Error(`Materialized turn did not preserve text plus attachment: ${JSON.stringify(turnData)}`)
  }
  const attachmentPath = turnData.attachments[0]
  const attachmentContent = await readFile(resolve(created.store.workspaceDir(materializedId), attachmentPath), 'utf8')
  if (attachmentContent !== 'DRAFT-ATTACHMENT-BOUNDARY-731\n') throw new Error('Materialized upload bytes changed')

  const createRequests = stateChangingRequests.filter((request) => request.path === '/nextjs-api/stream/create-chat')
  if (createRequests.length !== 1) throw new Error(`Expected one atomic create-chat request, saw ${createRequests.length}`)
  const createMessage = (createRequests[0]?.body as { message?: { id?: unknown; role?: unknown; parts?: unknown[]; metadata?: unknown } } | undefined)?.message
  if (typeof createMessage?.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(createMessage.id)
    || createMessage.role !== 'user'
    || !Array.isArray(createMessage.parts)
    || !createMessage.metadata) {
    throw new Error(`Atomic create-chat request did not use the current Arena first-message shape: ${JSON.stringify(createRequests[0]?.body)}`)
  }
  if (stateChangingRequests.some((request) => request.path === '/api/sessions')) {
    throw new Error('Draft submission called the legacy empty-Session creation endpoint')
  }

  await page.getByRole('button', { name: 'New Chat', exact: true }).first().click()
  await expectDraftRoute()
  if ((await sessionIds()).length !== 2) throw new Error('New Chat eagerly created a Session')
  if ((await editor.textContent()) !== '' || await page.locator('.attachment-chip').count() !== 0) throw new Error('New Chat did not reset the blank draft')

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await expectDraftRoute()
  if ((await sessionIds()).length !== 2) throw new Error('Reloading a New Chat draft created a Session')

  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/history/search', { timeout: 5_000 })
  await page.keyboard.press('Escape')
  await expectDraftRoute()
  if ((await sessionIds()).length !== 2) throw new Error('Search round-trip from /agent created a Session')

  await page.getByRole('button', { name: 'Leaderboard', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/leaderboard/agent', { timeout: 5_000 })
  await page.getByRole('button', { name: 'New Agent task', exact: true }).click()
  await expectDraftRoute()
  if ((await sessionIds()).length !== 2) throw new Error('Leaderboard Try Agent eagerly created a Session')
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await page.waitForURL((url) => url.pathname === '/leaderboard/agent', { timeout: 5_000 })
  await page.goForward({ waitUntil: 'domcontentloaded' })
  await expectDraftRoute()
  if ((await sessionIds()).length !== 2) throw new Error('Back/Forward over /agent created a Session')

  const unexpectedConsoleErrors = consoleErrors.filter((message) => !message.includes('status of 400'))
  if (unexpectedConsoleErrors.length > 0) throw new Error(`Draft route emitted browser errors: ${unexpectedConsoleErrors.join(' | ')}`)
  const report = {
    schemaVersion: 'anera-agent-draft-route/1.1',
    generatedAt: new Date().toISOString(),
    route: '/agent',
    initialSessionCount: 1,
    directHydrationCreatedSession: false,
    reloadCreatedSession: false,
    attachmentSelectionCreatedSession: false,
    failedPreUploadCreatedSessions: 0,
    failedUploadDraftPreserved: true,
    successfulRetryCreatedSessions: 1,
    atomicCreateChatRequests: 1,
    legacyCreateSessionRequests: 0,
    firstMessageUuidV7: true,
    casUploadTransport: true,
    textAndAttachmentPersisted: true,
    newChatCreatedSession: false,
    searchRoundTripCreatedSession: false,
    leaderboardRoundTripCreatedSession: false,
    browserHistoryRoundTrip: true,
    expectedInjectedConsoleErrors: consoleErrors.length - unexpectedConsoleErrors.length,
    unexpectedConsoleErrors: 0,
    passed: true,
  } as const
  const reportRoot = resolve(process.cwd(), 'reports', 'agent-draft-route-v1')
  await mkdir(reportRoot, { recursive: true })
  await writeFile(resolve(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await browser?.close().catch(() => undefined)
  await agent?.shutdown().catch(() => undefined)
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolveClose) => server!.close(() => resolveClose()))
  }
  await rm(dataRoot, { recursive: true, force: true })
}
