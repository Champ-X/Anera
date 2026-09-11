import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { createApp } from '../src/server/app.js'
import { findBrowserExecutable } from '../src/server/browser-executable.js'
import { GitHubConnector } from '../src/server/github-connector.js'
import { createCanaryEvidenceDirectory } from '../src/eval/canary-evidence.js'
import {
  appendVisualLongThoughtChunk,
  completeVisualLongThoughtFixture,
  seedVisualFixtureSessions,
  seedVisualLongThoughtFixture,
} from '../src/eval/ui-visual-fixture.js'

// Project regression: owns a fresh Chromium, app, and synthetic SessionStore.
// Never attaches to an existing browser. No text, vision, or tool transport runs.
const output = await createCanaryEvidenceDirectory()
const screenshots = resolve(output, 'screenshots')
await mkdir(screenshots)
const checks: Array<{ name: string; passed: boolean; evidence?: unknown; error?: string }> = []
const consoleErrors: string[] = []
const pageErrors: string[] = []
const blockedRequests: Array<{ method: string; url: string }> = []
const deniedHttpMutations: string[] = []
const disabledCalls = { text: 0, vision: 0, tools: 0 }
let browser: Browser | undefined
let created: Awaited<ReturnType<typeof createApp>> | undefined
let server: ReturnType<typeof createServer> | undefined
let activePage: Page | undefined
let baseUrl = ''
let error: string | undefined
let clientIndexSha256 = ''
let sessions: unknown
let checksCompleted = false

const denied = (kind: keyof typeof disabledCalls) => async (): Promise<never> => {
  disabledCalls[kind] += 1
  throw new Error(`Synthetic UI canary forbids ${kind} execution`)
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 8_000
  let value: T
  do {
    value = await read()
    if (accept(value)) return value
    await new Promise((ready) => setTimeout(ready, 50))
  } while (Date.now() < deadline)
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
const metrics = (body: Locator) => body.evaluate((element) => ({
  top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight,
  gap: element.scrollHeight - element.clientHeight - element.scrollTop,
  maxHeight: getComputedStyle(element).maxHeight,
}))
async function settled(page: Page) {
  await page.evaluate(() => new Promise<void>((ready) => requestAnimationFrame(() => requestAnimationFrame(() => ready()))))
}
async function check(name: string, run: () => Promise<unknown>) {
  try {
    const evidence = await run()
    checks.push({ name, passed: true, evidence })
    if (activePage) await activePage.screenshot({ path: resolve(screenshots, `${checks.length}-${name}.png`) })
  } catch (failure) {
    checks.push({ name, passed: false, error: failure instanceof Error ? failure.message : String(failure) })
    throw failure
  }
}
async function openSession(page: Page, id: string) {
  activePage = page
  await page.goto(`${baseUrl}/agent/${id}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.conversation-column .user-turn').first().waitFor()
}
async function ensureWorkspace(page: Page, visible: boolean, touch = false) {
  const panel = page.locator('.workspace-panel')
  if (await panel.isVisible() !== visible) {
    const toggle = page.getByRole('button', { name: 'Toggle workspace sidebar', exact: true })
    if (touch) await toggle.tap()
    else await toggle.click()
  }
  await panel.waitFor({ state: visible ? 'visible' : 'hidden' })
}
async function viewerRoundTrip(page: Page, open: () => Promise<unknown>, restoreWorkspace: boolean, touch = false) {
  await open()
  const viewer = page.getByRole('dialog', { name: 'Website preview', exact: true })
  await viewer.waitFor()
  await page.locator('.workspace-panel').waitFor({ state: 'hidden' })
  await page.frameLocator('iframe[title="Workspace website preview"]').locator('body').waitFor()
  await page.screenshot({ path: resolve(screenshots, `viewer-${checks.length + 1}.png`) })
  const close = viewer.getByRole('button', { name: 'Close file viewer', exact: true })
  if (touch) await close.tap()
  else await close.click()
  await viewer.waitFor({ state: 'hidden' })
  await page.locator('.workspace-panel').waitFor({ state: restoreWorkspace ? 'visible' : 'hidden' })
}

try {
  clientIndexSha256 = createHash('sha256').update(await readFile(resolve('dist-client/index.html'))).digest('hex')
  created = await createApp({
    dataRoot: resolve(output, 'data'), model: 'synthetic-ui-zero-provider',
    agent: {
      client: { stream: denied('text') },
      vision: { inspect: denied('vision'), compare: denied('vision') },
      tools: { execute: denied('tools') },
    },
    github: { connector: new GitHubConnector({ dataRoot: resolve(output, 'data'), fetch: async () => {
      throw new Error('Synthetic UI canary disables connector network')
    } }) },
  })
  const fixtureSessions = await seedVisualFixtureSessions(created.store)
  const thought = await seedVisualLongThoughtFixture(created.store)
  const touchThought = await seedVisualLongThoughtFixture(created.store)
  const disclosureThought = await seedVisualLongThoughtFixture(created.store)
  sessions = { ...fixtureSessions, thought, touchThought, disclosureThought }
  const store = created.store
  const app = created.app
  server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      deniedHttpMutations.push(`${request.method} ${request.url}`)
      response.writeHead(405, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Synthetic UI canary allows read-only HTTP' }))
      return
    }
    app(request, response)
  })
  await new Promise<void>((ready, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); ready() })
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true })

  async function newPage(touch: boolean) {
    const context = await browser!.newContext({
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      hasTouch: touch, isMobile: touch, reducedMotion: touch ? 'reduce' : 'no-preference',
    })
    await context.route('**/*', async (route) => {
      const request = route.request()
      if (new URL(request.url()).origin === baseUrl && ['GET', 'HEAD'].includes(request.method())) {
        await route.continue()
      } else {
        blockedRequests.push({ method: request.method(), url: request.url() })
        await route.abort('blockedbyclient')
      }
    })
    const page = await context.newPage()
    page.setDefaultTimeout(8_000)
    page.on('pageerror', (failure) => pageErrors.push(failure.message))
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    return page
  }

  const desktop = await newPage(false)
  await openSession(desktop, thought.id)
  await check('automatic-scroll-has-no-animation', async () => {
    const behavior = await desktop.locator('.conversation-scroll').evaluate((element) => getComputedStyle(element).scrollBehavior)
    assert.equal(behavior, 'auto', 'Hydration and streaming follow must be immediate; only explicit navigation opts into smooth scrolling')
    return { behavior }
  })
  await openSession(desktop, thought.id)
  const rows = desktop.locator('.thought-row')
  const current = rows.nth(1)
  const disclosure = current.locator(':scope > button')
  const body = current.locator('.thought-body')
  await check('thought-initial-tail', async () => {
    await body.waitFor()
    assert.equal(await rows.first().locator('button').getAttribute('aria-expanded'), 'false')
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true')
    const value = await until(() => metrics(body), (m) => m.gap <= 2, 'Initial thought must follow its tail')
    assert.equal(value.maxHeight, '192px')
    assert(value.height <= 192 && value.scrollHeight > value.height)
    return value
  })
  await check('wheel-pauses-tail', async () => {
    const before = await metrics(body)
    await body.hover()
    await desktop.mouse.wheel(0, -140)
    let lastTop = Number.NaN
    let stableSamples = 0
    const reading = await until(() => metrics(body), (m) => {
      stableSamples = Math.abs(m.top - lastTop) < 0.5 ? stableSamples + 1 : 0
      lastTop = m.top
      return stableSamples >= 2 && m.top < before.top - 60 && m.gap > 28
    }, 'Wheel must settle at an upward reading position')
    await appendVisualLongThoughtChunk(store, thought.id, 1)
    await until(() => body.innerText(), (text) => text.includes('Synthetic chunk 1, line 12'), 'Chunk 1 must render')
    await settled(desktop)
    const after = await metrics(body)
    assert(Math.abs(after.top - reading.top) <= 2, 'Appending while reading must preserve scrollTop')
    assert(after.scrollHeight > reading.scrollHeight)
    return { reading, after }
  })
  await check('wheel-resumes-tail', async () => {
    await body.hover()
    await desktop.mouse.wheel(0, 100_000)
    const before = await until(() => metrics(body), (m) => m.gap <= 2, 'Wheel must reach the thought bottom')
    await appendVisualLongThoughtChunk(store, thought.id, 2)
    await until(() => body.innerText(), (text) => text.includes('Synthetic chunk 2, line 12'), 'Chunk 2 must render')
    const after = await until(() => metrics(body), (m) => m.gap <= 2 && m.scrollHeight > before.scrollHeight, 'Thought must resume following')
    return { before, after }
  })
  await check('disclosure-and-progress-completion', async () => {
    await disclosure.click()
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false')
    await disclosure.click()
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true')
    await completeVisualLongThoughtFixture(store, thought.id)
    await desktop.locator('.thought-row.running').waitFor({ state: 'hidden' })
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true', 'Explicitly expanded thought must stay open after completion')
    assert.equal(await desktop.locator('.assistant-progress').count(), 1)
    assert((await desktop.locator('.assistant-progress').innerText()).includes('合成界面进度'))
    await desktop.getByText('Synthetic UI fixture complete. No model or provider was called.', { exact: true }).waitFor()
    const usage = (await store.get(thought.id)).summary.usage
    assert.equal(usage.modelCalls + usage.totalTokens + usage.estimatedCostUsd, 0)
    await disclosure.click()
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false')
    return { explicitExpansionPreserved: true, progressRows: 1, usage }
  })

  await check('reading-position-across-disclosure', async () => {
    await openSession(desktop, disclosureThought.id)
    const row = desktop.locator('.thought-row').nth(1)
    const toggle = row.locator(':scope > button')
    const text = row.locator('.thought-body')
    const initial = await until(() => metrics(text), (m) => m.gap <= 2 && m.top > 100, 'New thought initially follows its tail')
    await text.focus()
    await desktop.keyboard.press('PageUp')
    let lastTop = Number.NaN
    let stable = 0
    const reading = await until(() => metrics(text), (m) => {
      stable = Math.abs(m.top - lastTop) < 0.5 ? stable + 1 : 0
      lastTop = m.top
      return stable >= 2 && m.top > 0 && m.top < initial.top - 60 && m.gap > 28
    }, 'Keyboard reading position must settle above the tail')
    await toggle.click()
    await appendVisualLongThoughtChunk(store, disclosureThought.id, 1)
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await row.locator('.thought-body').count(), 0)
    await toggle.click()
    await until(() => text.innerText(), (content) => content.includes('Synthetic chunk 1, line 12'), 'Hidden delta must appear on reopening')
    const reopened = await metrics(text)
    assert(Math.abs(reopened.top - reading.top) <= 2, 'Reopening must restore the reading position, not jump to the top or tail')
    await appendVisualLongThoughtChunk(store, disclosureThought.id, 2)
    await until(() => text.innerText(), (content) => content.includes('Synthetic chunk 2, line 12'), 'Next delta must render')
    assert(Math.abs((await metrics(text)).top - reading.top) <= 2, 'Reopening must retain the paused-follow intent')
    await completeVisualLongThoughtFixture(store, disclosureThought.id)
    await row.locator('.thinking-activity-dot').waitFor({ state: 'hidden' })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    return { initial, reading, reopened, hiddenDeltaRetained: true, explicitExpansionPreserved: true }
  })

  await openSession(desktop, fixtureSessions.completed.id)
  await ensureWorkspace(desktop, true)
  const desktopCard = desktop.locator('.website-artifact').first()
  const desktopPreview = desktopCard.locator('.website-artifact-preview')
  const desktopOpen = desktopCard.getByRole('button', { name: 'Open index.html in viewer', exact: true })
  await check('desktop-hover-open', async () => {
    await desktopPreview.scrollIntoViewIfNeeded()
    await desktop.mouse.move(0, 0)
    await desktopPreview.hover()
    await until(() => desktopOpen.evaluate((element) => getComputedStyle(element).opacity), (opacity) => opacity === '1', 'Hover Open must be visible')
    assert.equal(await desktopOpen.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    }), true, 'Visible Open must receive pointer input, not be covered by the preview iframe')
    await viewerRoundTrip(desktop, () => desktopOpen.click(), true)
    return { nativeHover: true, viewerOpened: true, workspaceRestored: true }
  })
  await check('desktop-keyboard-open', async () => {
    await desktop.mouse.move(0, 0)
    await desktopOpen.focus()
    await until(() => desktopOpen.evaluate((element) => getComputedStyle(element).opacity), (opacity) => opacity === '1', 'Focused Open must be visible')
    assert(await desktopOpen.evaluate((element) => element === document.activeElement))
    await viewerRoundTrip(desktop, () => desktop.keyboard.press('Enter'), true)
    return { focusAndEnter: true, viewerOpened: true, workspaceRestored: true }
  })

  const mobile = await newPage(true)
  await openSession(mobile, touchThought.id)
  await ensureWorkspace(mobile, false, true)
  await check('native-touch-reduced-motion', async () => {
    const media = await mobile.evaluate(() => ({
      width: innerWidth, touchPoints: navigator.maxTouchPoints,
      noHover: matchMedia('(hover: none)').matches, coarse: matchMedia('(pointer: coarse)').matches,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      scrollWidth: document.documentElement.scrollWidth,
      activityAnimation: getComputedStyle(document.querySelector('.thinking-activity-dot')!).animationName,
    }))
    assert.equal(media.width, 390)
    assert(media.touchPoints > 0 && media.noHover && media.coarse && media.reduced)
    assert.equal(media.activityAnimation, 'none')
    assert(media.scrollWidth <= media.width + 1, 'Mobile document must not overflow horizontally')
    const touchCurrent = mobile.locator('.thought-row').nth(1)
    const touchDisclosure = touchCurrent.locator(':scope > button')
    await touchDisclosure.tap()
    assert.equal(await touchDisclosure.getAttribute('aria-expanded'), 'false')
    await appendVisualLongThoughtChunk(store, touchThought.id, 1)
    await appendVisualLongThoughtChunk(store, touchThought.id, 2)
    await completeVisualLongThoughtFixture(store, touchThought.id)
    await mobile.locator('.thought-row.running').waitFor({ state: 'hidden' })
    assert((await mobile.locator('.assistant-progress').innerText()).includes('合成界面进度'))
    assert.equal(await touchDisclosure.getAttribute('aria-expanded'), 'false', 'A streamed chunk must not reopen a user-collapsed thought')
    assert.equal(await touchCurrent.locator('.thought-body').count(), 0)
    await touchDisclosure.tap()
    await until(() => touchCurrent.locator('.thought-body').innerText(),
      (text) => text.includes('Synthetic chunk 2, line 12'), 'Reopening must show all retained streamed text')
    return { ...media, nativeTapDisclosurePreservedAcrossDelta: true }
  })
  await openSession(mobile, fixtureSessions.completed.id)
  await ensureWorkspace(mobile, false, true)
  await check('touch-always-visible-open', async () => {
    const open = mobile.locator('.website-artifact').first().getByRole('button', { name: 'Open index.html in viewer', exact: true })
    await open.scrollIntoViewIfNeeded()
    const appearance = await open.evaluate((element) => {
      const style = getComputedStyle(element)
      return { opacity: style.opacity, pointerEvents: style.pointerEvents, focused: element === document.activeElement }
    })
    assert.equal(appearance.opacity, '1')
    assert.equal(appearance.pointerEvents, 'auto')
    assert.equal(appearance.focused, false)
    await viewerRoundTrip(mobile, () => open.tap(), false, true)
    assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    return { appearance, nativeTapOpenedViewer: true, viewerClosed: true }
  })
  assert.deepEqual(disabledCalls, { text: 0, vision: 0, tools: 0 })
  assert.equal(deniedHttpMutations.length, 0)
  assert.equal(blockedRequests.filter((request) => !['GET', 'HEAD'].includes(request.method)).length, 0)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(consoleErrors, [])
  checksCompleted = true
} catch (failure) {
  error = failure instanceof Error ? failure.stack || failure.message : String(failure)
  process.exitCode = 1
  if (activePage) await activePage.screenshot({ path: resolve(screenshots, 'failure.png') }).catch(() => undefined)
} finally {
  await browser?.close().catch(() => undefined)
  await created?.agent.shutdown().catch((failure: unknown) => {
    error ??= String(failure)
    process.exitCode = 1
  })
  if (server) {
    const closed = new Promise<void>((ready) => server!.close(() => ready()))
    server.closeAllConnections()
    await closed
  }
  const report = { passed: !error && checksCompleted && checks.every((entry) => entry.passed),
    synthetic: true, providerCalls: 0, disabledCalls, defaultFixturesHaveSyntheticUsage: true,
    output, baseUrl, clientIndexSha256, sessions, checks, error, pageErrors, consoleErrors,
    blockedRequests, deniedHttpMutations, retained: true }
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
  console.log(JSON.stringify(report))
}
