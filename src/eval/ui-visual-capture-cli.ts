import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { ConsoleMessage } from 'playwright-core'
import { chromium } from 'playwright-core'
import { findBrowserExecutable } from '../server/browser-executable.js'
import { captureUiStateContract, type UiStateContract, type UiVisualContract } from './ui-contract.js'
import {
  advanceVisualRunningFixture,
  advanceVisualWorkspacePersistenceSaved,
  advanceVisualWorkspacePersistenceSaving,
  advanceVisualWorkspacePersistenceScanning,
  advanceVisualWorkspacePersistenceUploading,
  completeVisualWorkspacePersistenceFixture,
  resolveVisualHitlFixture,
  seedVisualFixtureSessions,
  seedVisualRunningFixture,
  seedVisualTaskCompletionFixture,
  seedVisualTaskReviewFixture,
  seedVisualWritingFixture,
  seedVisualWorkspacePersistenceFixture,
} from './ui-visual-fixture.js'

interface TaskReviewInteractionCheck {
  action: 'approve' | 'disapprove' | 'close_button' | 'escape_key' | 'continue_working'
  requestAction: 'approve' | 'disapprove' | 'edit' | 'escape'
  transport: 'review-feedback'
  eventType: 'feedback.updated' | 'review.dismissed'
  durableValue: 'upvote' | 'downvote' | 'dismiss' | 'continue'
  finalCorrelated: true
  noAgentEpisode: true
  sessionStatus: 'completed'
  persistedAfterRefresh: true
}

interface TaskCompletionInteractionCheck {
  action: 'no' | 'making_progress' | 'yes'
  transport: 'review-feedback'
  eventType: 'task.completion.updated'
  durableValue: 'no' | 'making_progress' | 'yes'
  finalCorrelated: true
  noAgentEpisode: true
  sessionStatus: 'completed'
  persistedAfterRefresh: true
}

interface UndoInteractionCheck {
  transport: 'action'
  requestType: 'undo'
  optimisticTimelineRemoved: true
  promptRestored: true
  attachmentsCleared: true
  durableExactlyOnce: true
  persistedAfterRefresh: true
  workspaceReverted: false
}

interface WorkspacePersistenceInteractionCheck {
  observedPhases: Array<'scanning' | 'uploading' | 'saving' | 'saved'>
  uploadingBlobCount: 0
  persistenceMode: 'local_durable'
  a01ReviewVisibleDuringWorkspaceUpdate: true
  a01PersistenceStartedBeforeReview: true
  a01ReviewBeforePersistenceCompleted: true
  a01ReviewOverlappedWorkspaceUpdate: true
  a02SavedBeforeReview: true
  persistenceBeforeTerminalFinal: true
  reviewAfterTerminalFinal: true
  reloadHighWaterSeq: number
  reloadedPersistenceStatuses: string[]
  saveAnimationReplayedAfterRefresh: false
  persistedAfterRefresh: true
}

interface ExecutionLogInteractionCheck {
  currentCommandGroupAutoExpanded: true
  currentBashAutoExpanded: true
  commandSectionsVisibleWithoutCaptureClick: true
  visibleSections: ['COMMAND', 'STDOUT', 'STDERR']
}

interface WorkspaceFileInteractionCheck {
  controlElement: 'BUTTON'
  targetBlank: false
  dockedPreviewOpened: true
  workspaceHiddenWhilePreviewOpen: true
  workspaceRestoredAfterPreviewClose: true
}

interface StreamingWriteInteractionCheck {
  path: 'ai-weekly-2026-08-31.html'
  visibleTailLines: 8
  firstVisibleLine: 415
  lastVisibleLine: 422
  timelineByteBadgeAbsent: true
  workspaceDraftVisible: true
  workspaceBytesMatchUtf8: true
  composerLocked: true
  stopVisible: true
}

const args = parseArgs(process.argv.slice(2))
const outputRoot = args.values.output || args.positionals[0]
if (!outputRoot) usage('Missing --output <directory>')
const output = resolve(outputRoot)
const screenshotsRoot = resolve(output, 'screenshots')
await mkdir(screenshotsRoot, { recursive: true })

const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-ui-contract-'))
const visualNow = new Date('2026-08-28T12:00:00.000Z')
process.env.ANERA_DATA_DIR = dataRoot
let server: ReturnType<typeof createServer> | undefined
let agent: { shutdown(): Promise<void> } | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const { createApp } = await import('../server/app.js')
  const { GitHubConnector } = await import('../server/github-connector.js')
  const github = new GitHubConnector({
    dataRoot,
    token: 'github-visual-fixture-token',
    apiBaseUrl: 'https://api.github.visual-fixture',
    fetch: visualGitHubFetch,
  })
  const created = await createApp({ dataRoot, creditNow: () => visualNow, github: { connector: github } })
  agent = created.agent
  const sessions = await seedVisualFixtureSessions(created.store)
  server = createServer(created.app)
  await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Visual fixture server did not bind to a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`

  browser = await chromium.launch({
    executablePath: findBrowserExecutable(process.env.ANERA_BROWSER_EXECUTABLE),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 })
  await page.addInitScript(`Object.defineProperty(Date, 'now', { configurable: true, value: () => ${visualNow.getTime()} })`)
  let connectionFixtureMode: 'normal' | 'slow-normal' | 'error' | 'disconnected' = 'normal'
  let githubStatusFixtureMode: 'normal' | 'outage' = 'normal'
  let repositoryFixtureMode: 'normal' | 'empty' | 'error' = 'normal'
  await page.route('**/api/coding/github/connection', async (route) => {
    if (connectionFixtureMode === 'slow-normal') {
      connectionFixtureMode = 'normal'
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500))
      await route.continue()
      return
    }
    if (connectionFixtureMode === 'error') {
      // A malformed success payload exercises Arena's response-shape failure
      // without adding an expected browser console network error.
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'github_request_failed' }) })
      return
    }
    if (connectionFixtureMode === 'disconnected') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'disconnected' }) })
      return
    }
    await route.continue()
  })
  await page.route('**/api/coding/github/status', async (route) => {
    if (githubStatusFixtureMode === 'outage') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ indicator: 'major', description: 'Major Service Outage' }) })
      return
    }
    await route.continue()
  })
  await page.route('**/api/coding/github/repos**', async (route) => {
    if (repositoryFixtureMode === 'empty') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ repos: [], hasNextPage: false }) })
      return
    }
    if (repositoryFixtureMode === 'error') {
      // A malformed 200 response exercises the client error branch without
      // adding an expected network console error to the visual health gate.
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'github_request_failed' }) })
      return
    }
    await route.continue()
  })
  const consoleMessages: Array<{ level: string; text: string }> = []
  const captureConsole = (message: ConsoleMessage) => consoleMessages.push({ level: message.type(), text: message.text() })
  page.on('console', captureConsole)
  page.on('pageerror', (error) => consoleMessages.push({ level: 'error', text: error.message }))
  page.on('requestfailed', (request) => consoleMessages.push({ level: 'requestfailed', text: `${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}` }))
  // The product intentionally keeps an EventSource open, so networkidle is not a valid readiness signal.
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })

  const states: UiStateContract[] = []
  const capture = async (name: string, settleBefore = true, targetPage = page) => {
    if (settleBefore) await settle(targetPage)
    const screenshot = `screenshots/${name}.png`
    await targetPage.screenshot({ path: resolve(output, screenshot), animations: 'disabled', caret: 'hide', type: 'png' })
    states.push(await captureUiStateContract(targetPage, name, screenshot, consoleMessages.splice(0)))
  }
  const selectDesktopSession = async (title: string) => {
    await page.locator('.history-list button').filter({ hasText: title }).click()
    await page.locator('.history-list button.active').filter({ hasText: title }).waitFor({ state: 'visible' })
    await settle(page)
  }
  const expectSessionRoute = async (id: string, title: string) => {
    const expected = `/agent/${id}`
    await page.waitForURL((url) => url.pathname === expected, { timeout: 5_000 })
    await page.locator('.history-list button.active').filter({ hasText: title }).waitFor({ state: 'visible' })
  }
  const ensureWorkspaceOpen = async () => {
    const workspacePanel = page.locator('.workspace-panel')
    if (await workspacePanel.isVisible().catch(() => false)) return
    await page.locator('button[aria-label="Toggle workspace sidebar"]:visible').click()
    await workspacePanel.waitFor({ state: 'visible' })
  }
  const conversationFollowInteractionChecks = {
    longSessionHydratedAtBottom: false,
    topControlVisible: false,
    expandedControlVisible: false,
    userReadingPositionPreserved: false,
    clickReachedBottom: false,
    clickHidControl: false,
    nearBottomGrowthFollowed: false,
    taskCompletionIngress: false,
  }

  await page.locator('.history-list button').first().waitFor({ state: 'visible' })
  await page.waitForURL((url) => url.pathname === '/agent', { timeout: 5_000 })
  await page.getByRole('heading', { name: 'What would you like to do?', exact: true }).waitFor({ state: 'visible' })
  const countSessions = async () => await page.evaluate(async () => {
    const response = await fetch('/api/sessions')
    const payload = await response.json() as { sessions: unknown[] }
    return payload.sessions.length
  })
  const sessionCountBeforeDraftActions = await countSessions()
  if (await page.locator('.history-list button.active').count() !== 0) throw new Error('Direct /agent draft hydration selected a persisted Session')
  await page.getByRole('button', { name: 'New Chat', exact: true }).first().click()
  if (await countSessions() !== sessionCountBeforeDraftActions) throw new Error('New Chat eagerly created an Agent Session')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForURL((url) => url.pathname === '/agent', { timeout: 5_000 })
  await page.getByRole('heading', { name: 'What would you like to do?', exact: true }).waitFor({ state: 'visible' })
  if (await countSessions() !== sessionCountBeforeDraftActions) throw new Error('Direct /agent refresh created an Agent Session')
  await capture('agent-new-chat-draft-desktop')
  const agentDraftRouteInteractionChecks = {
    route: '/agent',
    directHydrationCreatedSession: false,
    reloadCreatedSession: false,
    newChatCreatedSession: false,
    historySelection: false,
  } as const

  const leaderboardButton = page.getByRole('button', { name: 'Leaderboard', exact: true })
  await leaderboardButton.click()
  await page.waitForURL((url) => url.pathname === '/leaderboard/agent', { timeout: 5_000 })
  await page.getByRole('heading', { name: 'Agent Arena', exact: true }).waitFor({ state: 'visible' })
  if (await leaderboardButton.getAttribute('aria-current') !== 'page') throw new Error('Leaderboard route did not expose aria-current=page')
  const rankingTable = page.getByRole('table', { name: 'Agent Arena models ranking', exact: true })
  await rankingTable.waitFor({ state: 'visible' })
  if (!(await rankingTable.getByRole('rowheader').first().innerText()).includes('Anera Harness · DeepSeek')) throw new Error('Leaderboard did not identify its Anera evidence row')
  if (!await page.getByText('not live Arena data', { exact: false }).isVisible()) throw new Error('Leaderboard did not disclose its evidence boundary')
  const sessionCountBeforeLeaderboardReload = await countSessions()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForURL((url) => url.pathname === '/leaderboard/agent', { timeout: 5_000 })
  await page.getByRole('heading', { name: 'Agent Arena', exact: true }).waitFor({ state: 'visible' })
  const sessionCountAfterLeaderboardReload = await countSessions()
  if (sessionCountAfterLeaderboardReload !== sessionCountBeforeLeaderboardReload) throw new Error('Direct Leaderboard hydration created an Agent Session')
  await capture('leaderboard-agent-ranking-desktop')

  await page.getByRole('radio', { name: 'Code', exact: true }).click()
  await page.getByRole('radio', { name: 'Open Source', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search models or labs', exact: true }).fill('DeepSeek')
  await page.getByRole('tab', { name: 'Labs', exact: true }).click()
  await page.getByRole('table', { name: 'Agent Arena labs ranking', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Edit columns', exact: true }).click()
  const columnDialog = page.getByRole('dialog', { name: 'Edit leaderboard columns', exact: true })
  await columnDialog.waitFor({ state: 'visible' })
  await columnDialog.getByRole('checkbox', { name: 'Net Improvement', exact: true }).uncheck()
  if (await page.getByRole('columnheader', { name: 'Net Improvement', exact: true }).count() !== 0) throw new Error('Leaderboard column selection did not update the table')
  await page.getByRole('button', { name: 'Edit columns', exact: true }).click()
  await page.getByRole('radio', { name: 'Pareto', exact: true }).click()
  const pareto = page.getByRole('img', { name: 'Quality versus median task cost Pareto chart', exact: true })
  await pareto.waitFor({ state: 'visible' })
  await capture('leaderboard-agent-pareto-desktop')

  await selectDesktopSession('Visual Complete')
  await expectSessionRoute(sessions.completed.id, 'Visual Complete')
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await page.waitForURL((url) => url.pathname === '/leaderboard/agent', { timeout: 5_000 })
  await page.getByRole('heading', { name: 'Agent Arena', exact: true }).waitFor({ state: 'visible' })
  await page.goForward({ waitUntil: 'domcontentloaded' })
  await expectSessionRoute(sessions.completed.id, 'Visual Complete')
  const leaderboardInteractionChecks = {
    route: '/leaderboard/agent',
    sidebarCurrent: true,
    directHydrationCreatedSession: false,
    browserHistoryRoundTrip: true,
    ranking: true,
    pareto: true,
    category: 'Code',
    license: 'Open Source',
    query: 'DeepSeek',
    entity: 'Labs',
    columnEditing: true,
    evidenceBoundaryVisible: true,
  } as const

  const conversationSearchButton = page.getByRole('button', { name: 'Search', exact: true })
  await conversationSearchButton.click()
  await page.waitForURL((url) => url.pathname === '/history/search', { timeout: 5_000 })
  const conversationSearch = page.getByRole('dialog', { name: 'Search conversations' })
  await conversationSearch.waitFor({ state: 'visible' })
  if (await conversationSearchButton.getAttribute('aria-current') !== 'page') throw new Error('Conversation Search route did not expose aria-current=page')
  const sessionCountBeforeSearchReload = await countSessions()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForURL((url) => url.pathname === '/history/search', { timeout: 5_000 })
  await conversationSearch.waitFor({ state: 'visible' })
  const sessionCountAfterSearchReload = await countSessions()
  if (sessionCountAfterSearchReload !== sessionCountBeforeSearchReload) throw new Error('Direct Search hydration created an Agent Session')
  const conversationSearchInput = conversationSearch.getByRole('combobox', { name: 'Search conversations' })
  await conversationSearchInput.fill('Visual')
  const conversationSearchResults = conversationSearch.getByRole('option')
  if (await conversationSearchResults.count() < 5) throw new Error('Conversation search did not match the seeded visual sessions')
  await conversationSearchInput.press('ArrowDown')
  const selectedSearchOptions = conversationSearch.locator('[role="option"][aria-selected="true"]')
  if (await selectedSearchOptions.count() !== 1) throw new Error('Conversation search keyboard selection was not singular')
  const selectedSearchId = (await selectedSearchOptions.getAttribute('id'))?.replace(/^conversation-search-/, '')
  if (!selectedSearchId) throw new Error('Conversation search result did not expose its durable Session identity')
  await capture('conversation-search-desktop')
  await conversationSearchInput.press('Enter')
  await page.waitForURL((url) => url.pathname === `/agent/${selectedSearchId}`, { timeout: 5_000 })
  await conversationSearch.waitFor({ state: 'detached' })
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await page.waitForURL((url) => url.pathname === '/history/search', { timeout: 5_000 })
  await conversationSearch.waitFor({ state: 'visible' })
  await page.goForward({ waitUntil: 'domcontentloaded' })
  await page.waitForURL((url) => url.pathname === `/agent/${selectedSearchId}`, { timeout: 5_000 })
  await conversationSearch.waitFor({ state: 'detached' })
  await page.keyboard.press('Control+KeyK')
  await page.waitForURL((url) => url.pathname === '/history/search', { timeout: 5_000 })
  await conversationSearch.waitFor({ state: 'visible' })
  if (!await conversationSearchInput.evaluate((element) => document.activeElement === element)) {
    throw new Error('Conversation search shortcut did not focus the query input')
  }
  await conversationSearchInput.press('Escape')
  await conversationSearch.waitFor({ state: 'detached' })
  await page.waitForURL((url) => url.pathname === `/agent/${selectedSearchId}`, { timeout: 5_000 })
  const conversationSearchInteractionChecks = {
    route: '/history/search',
    sidebarCurrent: true,
    directHydrationCreatedSession: false,
    browserHistoryRoundTrip: true,
    selectionNavigatesToSession: true,
    keyboardShortcutNavigates: true,
    escapeRestoresReturnPath: true,
    comboboxFocused: true,
    keyboardSelection: true,
  } as const

  await selectDesktopSession(sessions.completed.title)
  await expectSessionRoute(sessions.completed.id, sessions.completed.title)
  // Arena restores Workspace when an existing Session is selected, while a
  // running Website remains a row inside that panel until the user opens it.
  const completedWorkspace = page.locator('.workspace-panel')
  const completedWebsiteRow = page.locator('.workspace-resource-row.website-panel')
  await completedWorkspace.waitFor({ state: 'visible', timeout: 10_000 })
  await completedWebsiteRow.waitFor({ state: 'visible', timeout: 10_000 })
  if (await page.locator('.preview-layer').count()) throw new Error('Completed Website stole focus from Workspace before an explicit open')
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await expectSessionRoute(sessions.completed.id, sessions.completed.title)
  await completedWorkspace.waitFor({ state: 'visible', timeout: 10_000 })
  await completedWebsiteRow.waitFor({ state: 'visible', timeout: 10_000 })
  if (await page.locator('.preview-layer').count()) throw new Error('Completed Website auto-opened after direct Session hydration')
  const completedWebsiteButton = completedWebsiteRow.locator('.workspace-resource-main')
  const workspaceWebsiteLabel = (await completedWebsiteButton.innerText()).replace(/\s+/g, ' ').trim()
  if (workspaceWebsiteLabel !== 'ANERA Dev Server V1 :43123') {
    throw new Error(`Workspace Website identity drifted: ${JSON.stringify(workspaceWebsiteLabel)}`)
  }
  const websitePreview = page.getByRole('dialog', { name: 'Website preview' })
  await completedWebsiteButton.click()
  try {
    await websitePreview.waitFor({ state: 'visible', timeout: 10_000 })
    await page.frameLocator('iframe[title="Workspace website preview"]').locator('body').waitFor({ state: 'attached', timeout: 10_000 })
  } catch {
    const diagnostic = await page.evaluate(async () => {
      const sessionId = window.location.pathname.split('/').filter(Boolean).at(-1)
      const current = sessionId ? await fetch(`/api/sessions/${sessionId}`).then((response) => response.json()) : null
      return {
        path: window.location.pathname,
        rootClass: document.querySelector('.app-shell')?.className || null,
        activeConversation: document.querySelector('.history-list button.active')?.textContent?.trim() || null,
        previewCount: document.querySelectorAll('.preview-layer').length,
        documentTitle: document.title,
        loadingCount: document.querySelectorAll('.center-state').length,
        timelineItemCount: document.querySelectorAll('.conversation-column > *').length,
        finalCount: document.querySelectorAll('.final-answer').length,
        website: current?.website ?? null,
        eventTypes: Array.isArray(current?.events) ? current.events.map((event: { type?: string }) => event.type) : [],
      }
    })
    throw new Error(`Completed Website row did not open its preview: ${JSON.stringify({ ...diagnostic, console: consoleMessages })}`)
  }
  if (!await page.locator('.app-shell.preview-open').count()) throw new Error('Completed Website row did not open the docked preview')
  if (await page.locator('.workspace-panel').count()) throw new Error('Workspace and Website preview opened at the same time')
  const hydratedCompletedMetrics = await expectConversationAtBottom(page, 'Completed Session hydration')
  if (hydratedCompletedMetrics.scrollHeight <= hydratedCompletedMetrics.clientHeight) {
    throw new Error(`Completed Session was not long enough to exercise hydration following: ${JSON.stringify(hydratedCompletedMetrics)}`)
  }
  if (await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).count()) {
    throw new Error('Scroll-to-bottom control remained visible after completed Session hydration reached the latest output')
  }
  conversationFollowInteractionChecks.longSessionHydratedAtBottom = true
  await setConversationScroll(page, 'top')
  const scrollToBottomControl = page.getByRole('button', { name: 'Scroll to bottom', exact: true })
  await scrollToBottomControl.waitFor({ state: 'visible' })
  conversationFollowInteractionChecks.topControlVisible = true
  await capture('completed-desktop-top')
  const readingPositionBeforeResize = await conversationScrollMetrics(page)
  // Trigger expansion without Playwright's actionability auto-scroll: this gate
  // is about resize following, while real pointer scrolling is covered by the
  // explicit top/bottom interactions above and below.
  await page.locator('.thought-row > button').first().evaluate((button: HTMLElement) => button.click())
  const fileGroup = page.locator('.arena-tool-group.files .arena-tool-group-head').first()
  if (await fileGroup.count()) {
    await fileGroup.evaluate((button: HTMLElement) => button.click())
    await page.locator('.arena-tool-group.files .tool-row .tool-head').first().evaluate((button: HTMLElement) => button.click())
  }
  const exploration = page.locator('.exploration-group .exploration-head').first()
  if (await exploration.count()) {
    await exploration.evaluate((button: HTMLElement) => button.click())
    await page.locator('.exploration-body').first().waitFor({ state: 'visible' })
    await page.locator('.exploration-item > button').first().evaluate((button: HTMLElement) => button.click())
  }
  const failedTool = page.locator('.tool-row.failed .tool-head').first()
  if (await failedTool.count()) await failedTool.evaluate((button: HTMLElement) => button.click())
  await scrollToBottomControl.waitFor({ state: 'visible' })
  conversationFollowInteractionChecks.expandedControlVisible = true
  const readingPositionAfterResize = await conversationScrollMetrics(page)
  if (Math.abs(readingPositionAfterResize.scrollTop - readingPositionBeforeResize.scrollTop) > 1) {
    throw new Error(`Expanded content pulled the user away from their reading position: ${JSON.stringify({ readingPositionBeforeResize, readingPositionAfterResize })}`)
  }
  conversationFollowInteractionChecks.userReadingPositionPreserved = true
  await capture('completed-desktop-expanded')
  await scrollToBottomControl.click()
  await scrollToBottomControl.waitFor({ state: 'detached' })
  await expectConversationAtBottom(page, 'Scroll-to-bottom action')
  conversationFollowInteractionChecks.clickReachedBottom = true
  conversationFollowInteractionChecks.clickHidControl = true
  await capture('completed-desktop-bottom')
  await page.getByRole('button', { name: 'Close file viewer' }).click()
  await websitePreview.waitFor({ state: 'detached' })
  await completedWorkspace.waitFor({ state: 'visible' })
  await completedWebsiteRow.waitFor({ state: 'visible' })
  const workspaceReportNode = completedWorkspace.locator('.file-node').filter({ hasText: 'report.md' })
  await workspaceReportNode.waitFor({ state: 'visible' })
  const workspaceReportNodeSemantics = await workspaceReportNode.evaluate((element) => ({
    tag: element.tagName,
    target: element.getAttribute('target'),
  }))
  if (workspaceReportNodeSemantics.tag !== 'BUTTON' || workspaceReportNodeSemantics.target !== null) {
    throw new Error(`Workspace file still uses an external-navigation control: ${JSON.stringify(workspaceReportNodeSemantics)}`)
  }
  await workspaceReportNode.click()
  const workspaceFilePreview = page.getByRole('dialog', { name: 'Artifact preview' })
  await workspaceFilePreview.waitFor({ state: 'visible' })
  await workspaceFilePreview.getByRole('heading', { name: 'Delivery report' }).waitFor({ state: 'visible' })
  if (!await page.locator('.app-shell.preview-open').count() || await page.locator('.workspace-panel').count()) {
    throw new Error('Workspace file did not open in the docked Preview rail')
  }
  await capture('completed-desktop-workspace-file-preview')
  await workspaceFilePreview.getByRole('button', { name: 'Close file viewer' }).click()
  await workspaceFilePreview.waitFor({ state: 'detached' })
  await completedWorkspace.waitFor({ state: 'visible' })
  const workspaceFileInteractionCheck: WorkspaceFileInteractionCheck = {
    controlElement: 'BUTTON',
    targetBlank: false,
    dockedPreviewOpened: true,
    workspaceHiddenWhilePreviewOpen: true,
    workspaceRestoredAfterPreviewClose: true,
  }
  const websiteWorkspaceInteractionChecks = {
    initialWorkspaceVisible: true,
    directHydrationWorkspaceVisible: true,
    previewInitiallyClosed: true,
    websiteLabel: workspaceWebsiteLabel,
    explicitWebsiteOpen: true,
    workspaceHiddenWhilePreviewOpen: true,
    workspaceRestoredAfterPreviewClose: true,
    workspaceFileUsesButton: true,
    workspaceFileUsesDockedPreview: true,
  } as const
  await completedWebsiteButton.click()
  await websitePreview.waitFor({ state: 'visible' })
  const previewModeControls = websitePreview.getByRole('group', { name: 'View mode' })
  await previewModeControls.getByRole('button', { name: 'Raw source', exact: true }).click()
  await websitePreview.getByRole('button', { name: 'Switch file', exact: true }).click()
  await websitePreview.getByRole('menuitem', { name: 'about.html', exact: true }).click()
  await page.locator('.preview-source pre').filter({ hasText: 'Secondary preview file' }).waitFor({ state: 'visible' })
  await websitePreview.getByRole('button', { name: 'Switch file', exact: true }).click()
  await websitePreview.getByRole('menuitem', { name: 'index.html', exact: true }).click()
  await page.locator('.preview-source pre').filter({ hasText: 'Visual contract fixture website.' }).waitFor({ state: 'visible' })
  await capture('completed-desktop-raw-source')
  await previewModeControls.getByRole('button', { name: 'Preview', exact: true }).click()
  await page.locator('.preview-content iframe').evaluate((element) => element.setAttribute('data-reload-probe', 'before'))
  await page.getByRole('button', { name: 'Refresh preview' }).click()
  await page.locator('.preview-content iframe').waitFor({ state: 'visible' })
  if (await page.locator('.preview-content iframe').getAttribute('data-reload-probe') !== null) throw new Error('Preview reload did not replace the rendered document')
  const pickerButton = websitePreview.getByRole('button', { name: 'Pick an element', exact: true })
  await pickerButton.click()
  const pickerHint = page.frameLocator('.preview-content iframe').getByText('Click an element in the preview. Press Esc to cancel.', { exact: true })
  await pickerHint.waitFor({ state: 'visible' })
  if (await websitePreview.getByRole('button', { name: 'Cancel element picker', exact: true }).getAttribute('aria-pressed') !== 'true') {
    throw new Error('Element picker did not expose its active state')
  }
  await page.evaluate(() => {
    const state = window as typeof window & { __aneraPickerMessages?: Array<{ data: unknown; sourceMatches: boolean }> }
    state.__aneraPickerMessages = []
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'anera.element-picker.selected') return
      const frame = document.querySelector<HTMLIFrameElement>('.preview-content iframe')
      state.__aneraPickerMessages?.push({ data: event.data, sourceMatches: event.source === frame?.contentWindow })
    })
  })
  await page.frameLocator('.preview-content iframe').getByRole('heading', { name: 'All systems operational', exact: true }).click()
  await pickerHint.waitFor({ state: 'detached' })
  await page.waitForFunction(() => (
    ((window as typeof window & { __aneraPickerMessages?: unknown[] }).__aneraPickerMessages?.length ?? 0) > 0
  ), undefined, { timeout: 5_000 })
  const pickerMessage = await page.evaluate(() => (
    (window as typeof window & { __aneraPickerMessages?: Array<{ data: unknown; sourceMatches: boolean }> }).__aneraPickerMessages?.[0]
  ))
  if (!pickerMessage?.sourceMatches) {
    throw new Error(`Element-picker selection came from an unexpected frame: ${JSON.stringify(pickerMessage)}`)
  }
  const pickerAfterSelection = websitePreview.getByRole('button', { name: 'Pick an element', exact: true })
  if (await pickerAfterSelection.getAttribute('aria-pressed') !== 'false') {
    throw new Error('Element picker remained active after selecting an element')
  }
  await capture('completed-desktop-preview')

  // Arena's terminal check-in replaces the Composer rather than coexisting
  // with it. The selected-element draft must survive while that surface is
  // hidden and become visible as soon as the check-in is dismissed.
  const completedReviewPanel = page.getByRole('dialog', { name: '此任务成功了吗？' })
  await completedReviewPanel.getByRole('button', { name: 'Close review panel' }).click()
  await completedReviewPanel.waitFor({ state: 'detached' })
  const composerEditor = page.locator('.composer-editor')
  await composerEditor.waitFor({ state: 'visible' })
  const selectedElementReference = await readComposerValue(composerEditor)
  if (!selectedElementReference.startsWith('[Selected element in index.html: ')
    || !selectedElementReference.endsWith(' — “All systems operational”]')) {
    throw new Error(`Element picker did not write the selected heading reference into the Composer: ${JSON.stringify({ selectedElementReference, pickerMessage })}`)
  }
  const previewElementPickerInteractionChecks = {
    selectedElement: 'h1',
    composerReference: selectedElementReference,
    pickerDeactivated: true,
    survivedHiddenComposer: true,
  } as const
  await composerEditor.fill('')
  if (await readComposerValue(composerEditor)) throw new Error('Element-picker verification draft could not be cleared')
  await page.getByRole('button', { name: 'Close file viewer' }).click()
  const reportOpen = page.getByRole('button', { name: 'Open report.md' })
  await reportOpen.click()
  const artifactPreview = page.getByRole('dialog', { name: 'Artifact preview' })
  await artifactPreview.waitFor({ state: 'visible' })
  await artifactPreview.getByRole('heading', { name: 'Delivery report' }).waitFor({ state: 'visible' })
  if (await artifactPreview.locator('iframe').count()) throw new Error('Markdown Artifact preview was rendered through an iframe')
  await capture('completed-desktop-markdown')
  await artifactPreview.getByRole('button', { name: 'Close file viewer' }).click()
  await artifactPreview.waitFor({ state: 'detached' })
  const officeStates = [
    { file: 'project-brief.docx', state: 'completed-desktop-docx', selector: '.office-doc-page', marker: 'Project readiness brief' },
    { file: 'readiness.xlsx', state: 'completed-desktop-xlsx', selector: '.office-sheet', marker: 'Availability' },
    { file: 'review.pptx', state: 'completed-desktop-pptx', selector: '.office-slide', marker: 'Launch readiness' },
  ] as const
  for (const office of officeStates) {
    await page.getByRole('button', { name: `Open ${office.file}` }).click()
    await artifactPreview.waitFor({ state: 'visible' })
    await artifactPreview.locator(office.selector).filter({ hasText: office.marker }).first().waitFor({ state: 'visible' })
    if (await artifactPreview.locator('iframe').count()) throw new Error(`${office.file} Artifact preview was rendered through an iframe`)
    await capture(office.state)
    await artifactPreview.getByRole('button', { name: 'Close file viewer' }).click()
    await artifactPreview.waitFor({ state: 'detached' })
  }

  const completedBeforeSleep = await created.store.get(sessions.completed.id)
  const asleepAt = '2026-08-28T00:05:30.000Z'
  const sleepingProcess = completedBeforeSleep.processes.find((process) => process.id === completedBeforeSleep.website.processId)
  if (!sleepingProcess) throw new Error('Completed visual Website is missing its managed process')
  const asleepProcess = {
    ...sleepingProcess,
    port: undefined,
    listeningPorts: [],
    newPorts: [],
    status: 'stopped' as const,
    completedAt: asleepAt,
    signal: 'SIGTERM',
  }
  await created.store.append(sessions.completed.id, 'process.stopped', { type: 'stopped', record: asleepProcess })
  await created.store.update(sessions.completed.id, (state) => {
    state.processes = state.processes.map((process) => process.id === completedBeforeSleep.website.processId
      ? asleepProcess
      : process)
  })
  await created.store.recordWebsiteUpdate(sessions.completed.id, {
    ...completedBeforeSleep.website,
    status: 'asleep',
    updatedAt: asleepAt,
  }, { action: 'idle_sleep', processStatus: 'stopped' })
  await ensureWorkspaceOpen()
  await page.locator('.website-state').filter({ hasText: 'asleep' }).waitFor({ state: 'visible' })
  // Closing the docked Preview and restoring Workspace are separate React
  // commits. Wait for the grid to leave the previous 2fr/3fr Preview tracks
  // before freezing geometry; a visible panel alone can precede that reflow.
  await page.waitForFunction(() => {
    const root = document.querySelector<HTMLElement>('.app-shell.workspace-open:not(.preview-open)')
    const panel = document.querySelector<HTMLElement>('.workspace-panel')
    if (!root || !panel) return false
    const box = panel.getBoundingClientRect()
    return Math.abs(box.x - 1192) <= 1
      && Math.abs(box.width - 248) <= 1
      && getComputedStyle(root).gridTemplateColumns.endsWith(' 248px')
  }, undefined, { timeout: 5_000 })
  const workspaceGeometry = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.workspace-panel')?.getBoundingClientRect()
    const card = document.querySelector<HTMLElement>('.workspace-card')?.getBoundingClientRect()
    const toggle = document.querySelector<HTMLElement>('.workspace-toggle-global')?.getBoundingClientRect()
    return panel && card && toggle ? {
      panel: { x: panel.x, y: panel.y, width: panel.width, height: panel.height },
      card: { x: card.x, y: card.y, width: card.width },
      toggle: { top: toggle.top, right: window.innerWidth - toggle.right, width: toggle.width },
    } : null
  })
  const expectedWorkspaceGeometry = {
    panel: { x: 1192, y: 53, width: 248, height: 847 },
    card: { x: 1192, y: 65, width: 248 },
    toggle: { top: 11, right: 15, width: 31 },
  }
  if (JSON.stringify(workspaceGeometry) !== JSON.stringify(expectedWorkspaceGeometry)) {
    const workspaceLayoutDiagnostic = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.app-shell')
      const panel = document.querySelector<HTMLElement>('.workspace-panel')
      const rootStyle = root ? getComputedStyle(root) : undefined
      const panelStyle = panel ? getComputedStyle(panel) : undefined
      const matchingMediaQueries: string[] = []
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSMediaRule && matchMedia(rule.conditionText).matches) matchingMediaQueries.push(rule.conditionText)
          }
        } catch {
          // Same-origin production CSS is readable; ignore browser-internal sheets.
        }
      }
      return {
        innerWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio,
        rootClass: root?.className || null,
        rootDisplay: rootStyle?.display || null,
        gridTemplateColumns: rootStyle?.gridTemplateColumns || null,
        gridTemplateRows: rootStyle?.gridTemplateRows || null,
        panelDisplay: panelStyle?.display || null,
        panelGridColumn: panelStyle?.gridColumn || null,
        panelGridRow: panelStyle?.gridRow || null,
        panelPosition: panelStyle?.position || null,
        matchingMediaQueries,
      }
    })
    throw new Error(`Desktop Workspace geometry mismatch: ${JSON.stringify({ workspaceGeometry, workspaceLayoutDiagnostic })}`)
  }
  await capture('website-asleep-desktop')
  await page.getByRole('button', { name: 'Toggle workspace sidebar', exact: true }).click()

  await selectDesktopSession(sessions.review.title)
  await expectSessionRoute(sessions.review.id, sessions.review.title)
  await setConversationScroll(page, 'bottom')
  const reviewPanel = page.getByRole('dialog', { name: '此任务成功了吗？' })
  if (!await reviewPanel.isVisible().catch(() => false)) {
    const diagnostic = await page.evaluate(async () => {
      const sessionId = window.location.pathname.split('/').filter(Boolean).at(-1)
      const snapshot = sessionId ? await fetch(`/api/sessions/${sessionId}`).then((response) => response.json()) : null
      return {
        path: window.location.pathname,
        activeConversation: document.querySelector('.history-list button.active')?.textContent?.trim() || null,
        composerCount: document.querySelectorAll('.composer').length,
        reviewCount: document.querySelectorAll('.task-review-panel').length,
        finalCount: document.querySelectorAll('.final-answer').length,
        sessionStatus: snapshot?.session?.status ?? null,
        eventTypes: Array.isArray(snapshot?.events) ? snapshot.events.map((event: { type?: string }) => event.type) : [],
      }
    })
    throw new Error(`Task review fixture did not project: ${JSON.stringify(diagnostic)}`)
  }
  const reviewActionLayout = await reviewPanel.locator('.task-review-actions').evaluate((actions) => {
    const actionBox = actions.getBoundingClientRect()
    const buttons = [...actions.querySelectorAll<HTMLButtonElement>(':scope > button')]
      .map((button) => {
        const box = button.getBoundingClientRect()
        return { label: button.textContent?.trim() || '', x: box.x, y: box.y, width: box.width, height: box.height }
      })
    return {
      display: getComputedStyle(actions).display,
      actionBox: { x: actionBox.x, y: actionBox.y, width: actionBox.width, height: actionBox.height },
      buttons,
    }
  })
  const verticallyOrdered = reviewActionLayout.buttons.every((button, index, buttons) => (
    index === 0 || button.y >= buttons[index - 1].y + buttons[index - 1].height - 1
  ))
  const fullWidth = reviewActionLayout.buttons.every((button) => (
    Math.abs(button.x - reviewActionLayout.actionBox.x) <= 1
      && Math.abs(button.width - reviewActionLayout.actionBox.width) <= 2
  ))
  if (reviewActionLayout.display !== 'grid'
    || reviewActionLayout.buttons.map((button) => button.label).join('|') !== '是|否|继续工作'
    || !verticallyOrdered
    || !fullWidth) {
    throw new Error(`Task review actions do not match Arena's vertical full-width list: ${JSON.stringify(reviewActionLayout)}`)
  }
  await capture('review-desktop')
  const reviewEventsBefore = await page.evaluate(async (sessionId) => (
    await fetch(`/api/sessions/${sessionId}`).then((response) => response.json())
  ).events.length, sessions.review.id)
  const continueRequestPromise = page.waitForRequest((request) => (
    request.method() === 'POST' && request.url().endsWith(`/api/chat/${sessions.review.id}/review-feedback`)
  ))
  await page.getByRole('button', { name: '继续工作' }).click()
  const continueRequest = await continueRequestPromise
  const continueRequestBody = continueRequest.postDataJSON() as Record<string, unknown>
  await page.locator('.composer').waitFor({ state: 'visible' })
  await page.locator('.task-review-panel').waitFor({ state: 'detached' })
  const reviewTransition = await page.evaluate(async (sessionId) => {
    const snapshot = await fetch(`/api/sessions/${sessionId}`).then((response) => response.json())
    return {
      status: snapshot.session.status,
      events: snapshot.events.map((event: { type: string; data: unknown }) => ({ type: event.type, data: event.data })),
    }
  }, sessions.review.id)
  const reviewDismissals = reviewTransition.events.filter((event: { type: string }) => event.type === 'review.dismissed')
  if (reviewTransition.events.length !== reviewEventsBefore + 1
    || reviewTransition.status !== 'completed'
    || reviewDismissals.length !== 1
    || (reviewDismissals[0].data as { action?: string }).action !== 'continue'
    || continueRequestBody.sessionNodeId !== (reviewDismissals[0].data as { messageEventId?: string }).messageEventId
    || continueRequestBody.recaptchaV3Token !== null
    || continueRequestBody.action !== 'edit'
    || continueRequestBody.feedback !== undefined) {
    throw new Error(`Continue working changed the wrong state or transport: ${JSON.stringify({ reviewTransition, continueRequestBody })}`)
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await expectSessionRoute(sessions.review.id, sessions.review.title)
  await page.locator('.composer').waitFor({ state: 'visible' })
  if (await page.locator('.task-review-panel').count()) throw new Error('Task review reappeared after durable Continue working dismissal')
  const treatmentOneEntry = page.getByRole('button', { name: 'Give feedback', exact: true })
  await treatmentOneEntry.waitFor({ state: 'visible' })
  await capture('custom-feedback-treatment-1-entry-desktop')
  await treatmentOneEntry.click()
  const feedbackChip = page.locator('.feedback-chip')
  const feedbackEditor = page.getByRole('textbox', { name: 'Message' })
  await feedbackChip.waitFor({ state: 'visible' })
  if (await feedbackEditor.getAttribute('data-placeholder') !== 'Give feedback on this task…') {
    throw new Error('Treatment-1 did not activate Arena\'s custom-feedback composer placeholder')
  }
  await capture('custom-feedback-treatment-1-chip-desktop')
  let customFeedbackPayload: Record<string, unknown> | undefined
  const customFeedbackFailureRoute = async (route: import('playwright-core').Route) => {
    customFeedbackPayload = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic custom feedback failure"}' })
  }
  const customFeedbackMessagePattern = `**/api/sessions/${sessions.review.id}/messages`
  await page.route(customFeedbackMessagePattern, customFeedbackFailureRoute)
  await feedbackEditor.fill('The title should be Q3 Review.')
  await feedbackEditor.press('Enter')
  await page.locator('.inline-error').filter({ hasText: 'synthetic custom feedback failure' }).waitFor({ state: 'visible' })
  await feedbackChip.waitFor({ state: 'visible' })
  const reviewedNodeId = (reviewDismissals[0].data as { messageEventId?: string }).messageEventId
  const customFeedbackTimezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const expectedCustomFeedbackPayload = {
    message: {
      parts: [
        {
          type: 'data-custom-feedback',
          data: {
            systemMessage: 'The next message part will be the user providing feedback about the previous message.',
            reviewedNodeId,
          },
        },
        { type: 'text', text: 'The title should be Q3 Review.' },
      ],
    },
    metadata: { timezone: customFeedbackTimezone, submissionSource: 'chat_input' },
    v2Source: 'agentic_chat_submit',
    model: null,
    enabledConnectorSlugs: [],
  }
  if (!customFeedbackPayload
    || JSON.stringify(customFeedbackPayload) !== JSON.stringify(expectedCustomFeedbackPayload)
    || await feedbackEditor.textContent() !== 'The title should be Q3 Review.'
    || await feedbackEditor.getAttribute('data-placeholder') !== 'Give feedback on this task…') {
    throw new Error(`Custom-feedback failure did not preserve Arena transport, correlation, chip, placeholder, and draft: ${JSON.stringify(customFeedbackPayload)}`)
  }
  const customFeedbackArenaTransportPassed = true
  for (let attempt = 0; attempt < 100 && !consoleMessages.some((message) => message.level === 'error' && /status of 503/.test(message.text)); attempt += 1) {
    await page.waitForTimeout(10)
  }
  const expectedCustomFeedbackConsole = consoleMessages.findIndex((message) => message.level === 'error' && /status of 503/.test(message.text))
  if (expectedCustomFeedbackConsole < 0) throw new Error('Synthetic custom-feedback failure did not emit its expected browser error')
  consoleMessages.splice(expectedCustomFeedbackConsole, 1)
  await capture('custom-feedback-failure-rollback-desktop')
  await page.locator('.inline-error button').click()
  await page.getByRole('button', { name: 'Remove Feedback' }).click()
  await feedbackChip.waitFor({ state: 'detached' })
  await page.unroute(customFeedbackMessagePattern, customFeedbackFailureRoute)
  const taskReviewInteractionChecks: TaskReviewInteractionCheck[] = [{
    action: 'continue_working',
    requestAction: 'edit',
    transport: 'review-feedback',
    eventType: 'review.dismissed',
    durableValue: 'continue',
    finalCorrelated: true,
    noAgentEpisode: true,
    sessionStatus: 'completed',
    persistedAfterRefresh: true,
  }]

  await page.goto(`${baseUrl}/agent/${sessions.taskCompletion.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await expectSessionRoute(sessions.taskCompletion.id, sessions.taskCompletion.title)
  const taskCompletionBar = page.getByTestId('task-completion-bar')
  await taskCompletionBar.waitFor({ state: 'visible' })
  await expectConversationAtBottom(page, 'Task Completion hydration')
  await setConversationScroll(page, 'top')
  const taskCompletionScrollControl = page.getByRole('button', { name: 'Scroll to bottom', exact: true })
  await taskCompletionScrollControl.waitFor({ state: 'visible' })
  const taskCompletionReadingPosition = await conversationScrollMetrics(page)
  const followTurnId = 'turn_visual_completion_follow'
  const followStepId = 'step_visual_completion_follow'
  await created.store.append(sessions.taskCompletion.id, 'turn.started', {
    content: 'Confirm the final completion state without moving my current reading position.',
    attachments: [],
  }, { turnId: followTurnId })
  await created.store.append(sessions.taskCompletion.id, 'run.status', { status: 'running' }, { turnId: followTurnId })
  const followFinal = await created.store.append(sessions.taskCompletion.id, 'assistant.final', {
    content: 'The follow-up completion state is verified.',
    finishReason: 'stop',
  }, { turnId: followTurnId, stepId: followStepId })
  await created.store.append(sessions.taskCompletion.id, 'turn.completed', { status: 'completed' }, { turnId: followTurnId, stepId: followStepId })
  await created.store.append(sessions.taskCompletion.id, 'run.status', { status: 'completed' }, { turnId: followTurnId, stepId: followStepId })
  await created.store.append(sessions.taskCompletion.id, 'review.requested', {
    messageEventId: followFinal.id,
    model: 'arena-agent-fixture',
    feedbackType: 'task_completion_bar',
  }, { turnId: followTurnId, stepId: followStepId })
  await page.locator(`.final-answer[data-assistant-response-id="${followFinal.id}"]`).waitFor({ state: 'attached' })
  await taskCompletionBar.waitFor({ state: 'detached' })
  const taskCompletionAfterGrowth = await conversationScrollMetrics(page)
  if (Math.abs(taskCompletionAfterGrowth.scrollTop - taskCompletionReadingPosition.scrollTop) > 1) {
    throw new Error(`Offscreen Final pulled the user away from their reading position: ${JSON.stringify({ taskCompletionReadingPosition, taskCompletionAfterGrowth })}`)
  }
  await taskCompletionScrollControl.click()
  await taskCompletionScrollControl.waitFor({ state: 'detached' })
  await taskCompletionBar.waitFor({ state: 'visible' })
  // The bar adds a new composer row after the Final intersects. Assert the
  // post-ingress layout, not the transient bottom position before that row is
  // mounted and the conversation ResizeObserver has followed the resize.
  await expectConversationAtBottom(page, 'Task Completion scroll-to-bottom action')
  conversationFollowInteractionChecks.taskCompletionIngress = true
  const taskCompletionDesktopLayout = await taskCompletionBar.evaluate((bar) => {
    const actions = bar.querySelector<HTMLElement>('.task-completion-actions')
    const barStyle = getComputedStyle(bar)
    const actionBox = actions?.getBoundingClientRect()
    return {
      direction: barStyle.flexDirection,
      labels: [...bar.querySelectorAll<HTMLButtonElement>('.task-completion-actions button')].map((button) => button.textContent?.trim()),
      actionWidth: actionBox?.width ?? 0,
      containerTestId: bar.parentElement?.getAttribute('data-testid'),
    }
  })
  if (taskCompletionDesktopLayout.direction !== 'row'
    || taskCompletionDesktopLayout.labels.join('|') !== 'No|Making progress|Yes'
    || Math.abs(taskCompletionDesktopLayout.actionWidth - 383) > 2
    || taskCompletionDesktopLayout.containerTestId !== 'task-completion-bar-container') {
    throw new Error(`Task completion desktop layout drifted: ${JSON.stringify(taskCompletionDesktopLayout)}`)
  }
  await capture('task-completion-desktop')

  await selectDesktopSession(sessions.hitl.title)
  await expectSessionRoute(sessions.hitl.id, sessions.hitl.title)
  const hitlDialog = page.locator('.ask-user-card')
  await hitlDialog.waitFor({ state: 'visible' })
  const pendingHitlQuestionCount = await hitlDialog.locator('.ask-user-question').count()
  const pendingHitlOptionCount = await hitlDialog.locator('.hitl-option').count()
  const pendingHitlCustomInputCount = await hitlDialog.locator('.ask-user-custom-response input').count()
  await setConversationScroll(page, 'bottom')
  await capture('ask-user-pending-desktop')

  await resolveVisualHitlFixture(created.store, sessions.hitl.id)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expectSessionRoute(sessions.hitl.id, sessions.hitl.title)
  const resolvedHitl = page.locator('.hitl-card.resolved')
  await resolvedHitl.waitFor({ state: 'visible' })
  const answerBubble = page.locator('.user-bubble').filter({ hasText: 'Keep the original launch date' })
  await answerBubble.waitFor({ state: 'visible' })
  const answerBubbleCount = await answerBubble.count()
  const resolvedAnswerText = (await answerBubble.textContent())?.trim() ?? ''
  const answerImmediatelyFollowsCard = await resolvedHitl.evaluate((element) => (
    element.nextElementSibling?.classList.contains('user-turn')
    && Boolean(element.nextElementSibling.querySelector('.user-bubble'))
  ))
  const hitlInteractionCheck = {
    pendingQuestionCount: pendingHitlQuestionCount,
    pendingOptionCount: pendingHitlOptionCount,
    pendingCustomInputCount: pendingHitlCustomInputCount,
    resolvedAnswerCount: answerBubbleCount,
    answerImmediatelyFollowsCard,
    selectedLabelVisible: resolvedAnswerText.includes('Focused launch'),
    customResponseVisible: resolvedAnswerText.includes('Keep the original launch date'),
    persistedAfterRefresh: true,
  }
  await setConversationScroll(page, 'bottom')
  await capture('ask-user-resolved-after-reload-desktop')

  await selectDesktopSession(sessions.approval.title)
  await expectSessionRoute(sessions.approval.id, sessions.approval.title)
  await setConversationScroll(page, 'bottom')
  await capture('approval-desktop')

  await selectDesktopSession(sessions.timedOut.title)
  await expectSessionRoute(sessions.timedOut.id, sessions.timedOut.title)
  await page.goBack()
  await expectSessionRoute(sessions.approval.id, sessions.approval.title)
  await page.goForward()
  await expectSessionRoute(sessions.timedOut.id, sessions.timedOut.title)
  await page.locator('.arena-tool-group.commands .arena-tool-group-head').click()
  await page.locator('.arena-tool-group.commands .tool-row.timed_out .tool-head').click()
  await setConversationScroll(page, 'bottom')
  await capture('timed-out-desktop')

  await selectDesktopSession(sessions.limited.title)
  await expectSessionRoute(sessions.limited.id, sessions.limited.title)
  await setConversationScroll(page, 'bottom')
  await capture('token-limit-desktop')

  await selectDesktopSession(sessions.empty.title)
  await capture('empty-desktop')
  const messageEditor = page.getByRole('textbox', { name: 'Message' })
  const composerContract = await messageEditor.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      tag: element.tagName,
      contentEditable: element.getAttribute('contenteditable'),
      role: element.getAttribute('role'),
      ariaLabel: element.getAttribute('aria-label'),
      ariaMultiline: element.getAttribute('aria-multiline'),
      ariaPlaceholder: element.getAttribute('aria-placeholder'),
      dataPlaceholder: element.getAttribute('data-placeholder'),
      whiteSpace: style.whiteSpace,
      overflowY: style.overflowY,
      minHeight: style.minHeight,
      maxHeight: style.maxHeight,
    }
  })
  const expectedComposerContract = {
    tag: 'DIV',
    contentEditable: 'true',
    role: 'textbox',
    ariaLabel: 'Message',
    ariaMultiline: 'true',
    ariaPlaceholder: 'Ask anything…',
    dataPlaceholder: 'Ask anything…',
    whiteSpace: 'pre-wrap',
    overflowY: 'auto',
    minHeight: '93px',
    maxHeight: '180px',
  }
  if (JSON.stringify(composerContract) !== JSON.stringify(expectedComposerContract)) {
    throw new Error(`Composer DOM contract mismatch: ${JSON.stringify(composerContract)}`)
  }

  const interceptedMessages: Array<Record<string, unknown>> = []
  const messagePattern = '**/api/sessions/*/messages'
  const messagePayloadText = (payload: Record<string, unknown>): string | undefined => {
    const message = payload.message as { text?: unknown; parts?: unknown } | undefined
    if (typeof message?.text === 'string') return message.text
    if (!Array.isArray(message?.parts)) return undefined
    const textPart = message.parts.find((part): part is { type: 'text'; text: string } => (
      typeof part === 'object'
      && part !== null
      && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string'
    ))
    return textPart?.text
  }
  const messageRoute = async (route: import('playwright-core').Route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>
    interceptedMessages.push(payload)
    await route.fulfill(messagePayloadText(payload) === 'restore this draft'
      ? { status: 503, contentType: 'application/json', body: '{"error":"synthetic composer failure"}' }
      : { status: 200, contentType: 'application/json', body: '{}' })
  }
  const waitForMessageCount = async (count: number) => {
    for (let attempt = 0; attempt < 100 && interceptedMessages.length < count; attempt += 1) await page.waitForTimeout(10)
    if (interceptedMessages.length !== count) throw new Error(`Expected ${count} composer submissions, observed ${interceptedMessages.length}`)
  }
  await page.route(messagePattern, messageRoute)
  const readMessageEditor = () => messageEditor.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    let value = ''
    let node = walker.nextNode()
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) value += (node.textContent || '').replaceAll('\u200b', '')
      else if (node instanceof HTMLBRElement) value += '\n'
      node = walker.nextNode()
    }
    return value
  })
  await messageEditor.fill('组合输入')
  await messageEditor.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '组' }))
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 229 }))
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '合' }))
  })
  await settle(page)
  if (interceptedMessages.length !== 0 || await readMessageEditor() !== '组合输入') {
    throw new Error(`IME Enter submitted or changed the draft: ${JSON.stringify({ interceptedMessages, text: await readMessageEditor() })}`)
  }
  await messageEditor.fill('Paste: ')
  await messageEditor.evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'alpha\r\nbeta')
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    element.dispatchEvent(event)
  })
  if (await readMessageEditor() !== 'Paste: alpha\nbeta') {
    throw new Error(`Plain-text paste did not normalize CRLF: ${JSON.stringify(await readMessageEditor())}`)
  }
  await messageEditor.fill('First line')
  await messageEditor.press('Shift+Enter')
  await messageEditor.pressSequentially('Second line')
  if (await readMessageEditor() !== 'First line\nSecond line') {
    throw new Error(`Shift+Enter did not create one plain-text newline: ${JSON.stringify(await readMessageEditor())}`)
  }
  await messageEditor.press('Enter')
  await waitForMessageCount(1)
  await page.waitForFunction(() => document.querySelector('.composer-editor')?.textContent === '')
  await page.locator('.composer-operation-status').filter({ hasText: 'Preparing message...' }).waitFor({ state: 'hidden' })
  const expectedTimezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  if (JSON.stringify(interceptedMessages[0]) !== JSON.stringify({
    message: { text: 'First line\nSecond line' },
    metadata: { timezone: expectedTimezone, submissionSource: 'chat_input' },
    v2Source: 'agentic_chat_submit',
    model: null,
    enabledConnectorSlugs: [],
  })) {
    throw new Error(`Enter submission payload mismatch: ${JSON.stringify(interceptedMessages[0])}`)
  }
  await messageEditor.fill('restore this draft')
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
    return Boolean(button && !button.disabled)
  })
  await messageEditor.press('Enter')
  await waitForMessageCount(2)
  await page.locator('.inline-error').filter({ hasText: 'synthetic composer failure' }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('.composer-editor')?.textContent?.includes('restore this draft'))
  if (await readMessageEditor() !== 'restore this draft') throw new Error('Failed submission did not restore the contenteditable draft')
  await page.locator('.inline-error button').click()
  const expectedFailureConsole = consoleMessages.findIndex((message) => message.level === 'error' && /status of 503/.test(message.text))
  if (expectedFailureConsole < 0) throw new Error('Synthetic failed submission did not emit its expected browser error')
  consoleMessages.splice(expectedFailureConsole, 1)
  await messageEditor.fill('')
  await page.locator('.composer').evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['visual fixture'], 'drag-probe.txt', { type: 'text/plain' }))
    element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }))
  })
  await page.locator('.drop-files-overlay').waitFor({ state: 'visible' })
  await capture('empty-desktop-drag')
  await page.locator('.composer').evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['visual fixture'], 'drag-probe.txt', { type: 'text/plain' }))
    element.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: transfer }))
  })
  await page.locator('.drop-files-overlay').waitFor({ state: 'detached' })

  await page.getByRole('textbox', { name: 'Message' }).evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['visual clipboard image'], 'clipboard-source.png', { type: 'image/png' }))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    element.dispatchEvent(event)
  })
  await page.locator('.attachment-chip').filter({ hasText: 'image-1.png' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Toggle workspace sidebar', exact: true }).click()
  await page.locator('.file-node').filter({ hasText: 'image-1.png' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Toggle workspace sidebar', exact: true }).click()
  await capture('empty-desktop-paste')
  await messageEditor.focus()
  await messageEditor.press('Enter')
  await waitForMessageCount(3)
  const expectedAttachmentOnlyPayload = {
    message: {
      parts: [{
        type: 'file',
        url: `/api/sessions/${sessions.empty.id}/download?path=uploads%2Fimage-1.png`,
        mediaType: 'image/png',
        filename: 'image-1.png',
      }],
      metadata: {
        manifestNodeId: null,
        uploads: [{ key: 'uploads/image-1.png', filename: 'image-1.png', mediaType: 'image/png' }],
      },
    },
    metadata: { timezone: expectedTimezone, submissionSource: 'chat_input' },
    v2Source: 'agentic_chat_submit',
    model: null,
    enabledConnectorSlugs: [],
  }
  if (JSON.stringify(interceptedMessages[2]) !== JSON.stringify(expectedAttachmentOnlyPayload)) {
    throw new Error(`Attachment-only submission payload mismatch: ${JSON.stringify(interceptedMessages[2])}`)
  }
  await page.locator('.attachment-chip').waitFor({ state: 'detached' })
  await page.unroute(messagePattern, messageRoute)

  const connectionsTrigger = page.getByRole('button', { name: /^Connections(?: enabled: GitHub)?$/ })
  if (await connectionsTrigger.getAttribute('aria-label') !== 'Connections') throw new Error('Connected GitHub appeared enabled while its conversation switch was off')
  await connectionsTrigger.click()
  const connectionsDialog = page.getByRole('dialog', { name: 'Connections' })
  await connectionsDialog.waitFor({ state: 'visible' })
  const [connectionsTriggerBox, connectionsDialogBox] = await Promise.all([connectionsTrigger.boundingBox(), connectionsDialog.boundingBox()])
  if (!connectionsTriggerBox || !connectionsDialogBox
    || Math.abs(connectionsDialogBox.width - 224) > 1
    || Math.abs(connectionsDialogBox.x - connectionsTriggerBox.x) > 1
    || Math.abs(connectionsDialogBox.y + connectionsDialogBox.height - (connectionsTriggerBox.y - 8)) > 1
    || await page.locator('.connections-layer').count()) {
    throw new Error(`Connections popover geometry mismatch: ${JSON.stringify({ connectionsTriggerBox, connectionsDialogBox })}`)
  }
  await capture('connections-github-desktop')
  await page.keyboard.press('Escape')
  await connectionsDialog.waitFor({ state: 'detached' })
  if (await connectionsTrigger.getAttribute('aria-expanded') !== 'false') throw new Error('Connections trigger stayed expanded after Escape')
  await connectionsTrigger.click()
  await connectionsDialog.waitFor({ state: 'visible' })
  await page.getByRole('heading', { name: 'What would you like to do?' }).click()
  await connectionsDialog.waitFor({ state: 'detached' })
  if (await connectionsTrigger.getAttribute('aria-expanded') !== 'false') throw new Error('Connections trigger stayed expanded after outside click')
  await connectionsTrigger.click()
  await connectionsDialog.waitFor({ state: 'visible' })
  await page.locator('.connection-switch').click()
  await page.getByRole('checkbox', { name: 'Show repository panel' }).waitFor({ state: 'attached' })
  if (!await page.getByRole('checkbox', { name: 'Show repository panel' }).isChecked()) throw new Error('Repository panel switch did not turn on')
  await connectionsTrigger.click()
  await connectionsDialog.waitFor({ state: 'detached' })
  if (await connectionsTrigger.getAttribute('aria-label') !== 'Connections enabled: GitHub') throw new Error('Conversation switch did not enable GitHub in the Composer')
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('coding-repo-connect-panel') || '{}').isOpen === true }
    catch { return false }
  })
  connectionFixtureMode = 'slow-normal'
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await page.locator('.repository-controls').waitFor({ state: 'visible' })
  await page.locator('.repository-loading').waitFor({ state: 'visible' })
  await capture('coding-repository-loading-desktop')
  await page.getByRole('button', { name: 'Select a repository' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Add files' }).waitFor({ state: 'visible' })
  if (await messageEditor.getAttribute('data-placeholder') !== 'Ask anything…') throw new Error('Coding Composer changed the public Ask anything… placeholder')
  const codingAttachment = await page.evaluate(() => {
    const composer = document.querySelector('.composer')
    const controls = document.querySelector('.repository-controls')
    if (!(composer instanceof HTMLElement) || !(controls instanceof HTMLElement)) return null
    const composerBox = composer.getBoundingClientRect()
    const controlsBox = controls.getBoundingClientRect()
    const composerStyle = getComputedStyle(composer)
    const controlsStyle = getComputedStyle(controls)
    return {
      composer: { x: composerBox.x, y: composerBox.y, width: composerBox.width, height: composerBox.height },
      controls: { x: controlsBox.x, y: controlsBox.y, width: controlsBox.width, height: controlsBox.height },
      composerBottomLeftRadius: composerStyle.borderBottomLeftRadius,
      composerBottomRightRadius: composerStyle.borderBottomRightRadius,
      controlsBorderTopWidth: controlsStyle.borderTopWidth,
    }
  })
  if (!codingAttachment
    || Math.abs(codingAttachment.controls.y - (codingAttachment.composer.y + codingAttachment.composer.height)) > 1
    || Math.abs(codingAttachment.controls.x - codingAttachment.composer.x) > 1
    || Math.abs(codingAttachment.controls.width - codingAttachment.composer.width) > 1
    || codingAttachment.composerBottomLeftRadius !== '0px'
    || codingAttachment.composerBottomRightRadius !== '0px'
    || codingAttachment.controlsBorderTopWidth !== '0px') {
    throw new Error(`GitHub repository controls are not attached to the Composer: ${JSON.stringify(codingAttachment)}`)
  }
  const githubSettings = page.getByRole('button', { name: 'GitHub settings' })
  await githubSettings.click()
  const githubMenu = page.getByRole('menu')
  await githubMenu.waitFor({ state: 'visible' })
  await page.getByRole('menuitem', { name: 'Manage repositories' }).waitFor({ state: 'visible' })
  await page.getByRole('menuitem', { name: 'Disconnect' }).waitFor({ state: 'visible' })
  if (await githubMenu.locator('[title="Manage repositories on GitHub"]').count() !== 1) throw new Error('GitHub Manage repositories tooltip contract is missing')
  if (await githubMenu.locator('[title="Disconnect GitHub"]').count() !== 1) throw new Error('GitHub Disconnect tooltip contract is missing')
  await capture('coding-github-settings-desktop')
  await page.keyboard.press('Escape')
  await githubMenu.waitFor({ state: 'detached' })
  if (await githubSettings.getAttribute('aria-expanded') !== 'false') throw new Error('GitHub settings menu stayed expanded after Escape')
  await githubSettings.click()
  await githubMenu.waitFor({ state: 'visible' })
  await messageEditor.click()
  await githubMenu.waitFor({ state: 'detached' })
  if (await githubSettings.getAttribute('aria-expanded') !== 'false') throw new Error('GitHub settings menu stayed expanded after outside click')
  await capture('coding-repository-empty-desktop')
  await page.getByRole('button', { name: 'Select a repository' }).click()
  await page.getByPlaceholder('Search repositories…').waitFor({ state: 'visible' })
  await capture('coding-repository-picker-desktop')
  await page.keyboard.press('Escape')
  await page.getByPlaceholder('Search repositories…').waitFor({ state: 'detached' })
  if (await page.getByRole('button', { name: 'Select a repository' }).getAttribute('aria-expanded') !== 'false') throw new Error('Repository picker stayed expanded after Escape')
  await page.getByRole('button', { name: 'Select a repository' }).click()
  await page.getByPlaceholder('Search repositories…').waitFor({ state: 'visible' })
  await page.getByRole('textbox', { name: 'Message' }).click()
  await page.getByPlaceholder('Search repositories…').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Select a repository' }).click()
  await page.getByPlaceholder('Search repositories…').waitFor({ state: 'visible' })
  await page.locator('.search-picker-options button').filter({ hasText: 'arena-labs/harness' }).click()
  await page.getByRole('button', { name: 'Branch' }).filter({ hasText: 'main' }).waitFor({ state: 'visible' })
  const persistedCodingPanel = await page.evaluate(() => JSON.parse(localStorage.getItem('coding-repo-connect-panel') || '{}')) as Record<string, unknown>
  if (persistedCodingPanel.isOpen !== true
    || persistedCodingPanel.attachedRepoId !== 17
    || persistedCodingPanel.attachedRepoFullName !== 'arena-labs/harness'
    || persistedCodingPanel.attachedBranch !== 'main') {
    throw new Error(`Coding repository selection did not persist with the public storage contract: ${JSON.stringify(persistedCodingPanel)}`)
  }
  await capture('coding-branch-ready-desktop')

  repositoryFixtureMode = 'empty'
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await page.getByText('No repositories found', { exact: true }).waitFor({ state: 'visible' })
  if (await page.getByLabel("A repo won't appear if its owner hasn't installed the app or granted access.").count() !== 1) throw new Error('Empty repository explanation is missing')
  await capture('coding-repository-none-desktop')

  repositoryFixtureMode = 'error'
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await page.getByText("Couldn't load your repositories.", { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Retry' }).waitFor({ state: 'visible' })
  await capture('coding-repository-error-desktop')
  repositoryFixtureMode = 'normal'

  connectionFixtureMode = 'error'
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await page.getByText('We couldn’t verify your GitHub connection. Please try again.', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Retry' }).waitFor({ state: 'visible' })
  await capture('coding-github-verification-error-desktop')
  connectionFixtureMode = 'normal'
  await page.getByRole('button', { name: 'Retry' }).click()
  await page.getByRole('button', { name: 'Select a repository' }).waitFor({ state: 'visible' })

  githubStatusFixtureMode = 'outage'
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Dismiss GitHub outage notice' }).waitFor({ state: 'visible' })
  await page.getByRole('link', { name: 'View status', exact: true }).waitFor({ state: 'visible' })
  await capture('coding-github-outage-desktop')
  await page.getByRole('button', { name: 'Dismiss GitHub outage notice' }).click()
  await page.locator('.repository-outage-banner').waitFor({ state: 'detached' })

  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('coding-repo-connect-panel') || '{}')
    localStorage.setItem('coding-repo-connect-panel', JSON.stringify({ ...stored, isOpen: false }))
  })
  connectionFixtureMode = 'disconnected'
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await connectionsTrigger.click()
  await connectionsDialog.waitFor({ state: 'visible' })
  await page.getByLabel('GitHub outage notice').waitFor({ state: 'visible' })
  await page.getByRole('link', { name: 'View Status', exact: true }).waitFor({ state: 'visible' })
  await capture('connections-github-outage-desktop')
  await connectionsTrigger.click()
  await connectionsDialog.waitFor({ state: 'detached' })
  connectionFixtureMode = 'normal'
  githubStatusFixtureMode = 'normal'

  await selectDesktopSession(sessions.coding.title)
  await expectSessionRoute(sessions.coding.id, sessions.coding.title)
  await setConversationScroll(page, 'bottom')
  await capture('coding-session-desktop')

  await selectDesktopSession(sessions.empty.title)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await expectSessionRoute(sessions.empty.id, sessions.empty.title)
  const creditGauge = page.locator('.credit-gauge-trigger')
  await creditGauge.click()
  await page.getByRole('dialog', { name: 'Daily credits details' }).waitFor({ state: 'visible' })
  await capture('credits-normal-desktop')
  await creditGauge.click()

  await created.credits.settle(sessions.empty.id, 1.3)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await expectSessionRoute(sessions.empty.id, sessions.empty.title)
  await page.getByRole('button', { name: 'Credits remaining: 1,200 of 2,500' }).click()
  await page.getByRole('dialog', { name: 'Daily credits details' }).waitFor({ state: 'visible' })
  await capture('credits-low-desktop')
  await page.getByRole('button', { name: 'Credits remaining: 1,200 of 2,500' }).click()

  await created.credits.settle(sessions.empty.id, 2.5)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await expectSessionRoute(sessions.empty.id, sessions.empty.title)
  await page.getByRole('dialog', { name: 'Daily usage limit' }).waitFor({ state: 'visible' })
  await page.getByRole('textbox', { name: 'Message' }).evaluate((element) => {
    if (element.getAttribute('aria-placeholder') !== 'You have reached your usage limit for today...'
      || element.getAttribute('contenteditable') !== 'false'
      || element.getAttribute('aria-readonly') !== 'true') {
      throw new Error('Daily-limit composer did not project its locked contenteditable state')
    }
  })
  await capture('credits-zero-desktop')
  await page.getByRole('button', { name: 'You have reached your daily usage limit' }).click()
  await page.getByRole('button', { name: 'All credits used' }).click()
  await page.getByRole('dialog', { name: 'Daily credits details' }).waitFor({ state: 'visible' })
  await capture('credits-zero-gauge-desktop')

  await selectDesktopSession(sessions.free.title)
  await expectSessionRoute(sessions.free.id, sessions.free.title)
  await page.getByRole('button', { name: 'No credits being used during this session' }).click()
  await page.getByRole('dialog', { name: 'Daily credits details' }).waitFor({ state: 'visible' })
  await capture('credits-free-session-desktop')

  const running = await seedVisualRunningFixture(created.store)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await selectDesktopSession(running.title)
  await expectSessionRoute(running.id, running.title)
  await page.locator('.thought-row.running').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Stop agent' }).waitFor({ state: 'visible' })
  await page.getByRole('textbox', { name: 'Message' }).evaluate((element) => {
    if (element.getAttribute('aria-placeholder') !== 'Agent is working…'
      || element.getAttribute('contenteditable') !== 'false'
      || element.getAttribute('aria-disabled') !== 'true') {
      throw new Error('Running composer did not project its locked contenteditable state')
    }
  })
  await setConversationScroll(page, 'bottom')
  await capture('running-thinking-desktop')

  await advanceVisualRunningFixture(created.store, running.id)
  await page.locator('.plan-card li.in_progress').waitFor({ state: 'visible' })
  const runningCommandGroup = page.locator('.arena-tool-group.commands.running .arena-tool-group-head')
  await runningCommandGroup.waitFor({ state: 'visible' })
  await expectConversationAtBottom(page, 'Near-bottom SSE growth')
  if (await runningCommandGroup.getAttribute('aria-expanded') !== 'true') {
    throw new Error('Current Bash command group did not auto-expand')
  }
  const runningTool = page.locator('.arena-tool-group.commands .tool-row.running .tool-head')
  await runningTool.waitFor({ state: 'visible' })
  if (await runningTool.getAttribute('aria-expanded') !== 'true') {
    throw new Error('Current Bash command did not auto-expand')
  }
  const runningCommandBody = page.locator('.arena-tool-group.commands .tool-row.running .command-tool-body')
  await runningCommandBody.filter({ hasText: 'VERIFY 2/3 checks running' }).waitFor({ state: 'visible' })
  const visibleCommandSections = await runningCommandBody.locator('.command-tool-section > header > span').allTextContents()
  if (visibleCommandSections.join('|') !== 'COMMAND|STDOUT|STDERR') {
    throw new Error(`Current Bash sections were not visible without a capture click: ${JSON.stringify(visibleCommandSections)}`)
  }
  const executionLogInteractionCheck: ExecutionLogInteractionCheck = {
    currentCommandGroupAutoExpanded: true,
    currentBashAutoExpanded: true,
    commandSectionsVisibleWithoutCaptureClick: true,
    visibleSections: ['COMMAND', 'STDOUT', 'STDERR'],
  }
  await expectConversationAtBottom(page, 'Near-bottom tool-output resize')
  if (await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).count()) {
    throw new Error('Near-bottom streamed growth exposed a stale scroll-to-bottom control')
  }
  conversationFollowInteractionChecks.nearBottomGrowthFollowed = true
  await capture('running-tool-desktop')

  const writing = await seedVisualWritingFixture(created.store)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await selectDesktopSession(writing.title)
  await expectSessionRoute(writing.id, writing.title)
  await ensureWorkspaceOpen()
  await setConversationScroll(page, 'bottom')
  const writingRow = page.locator('.streaming-file-write.running')
  await writingRow.waitFor({ state: 'visible' })
  if (await writingRow.getAttribute('aria-label') !== `Writing ${writing.path}`) {
    throw new Error('Streaming write did not expose the recorded Arena path')
  }
  const writingHeader = writingRow.locator('.streaming-file-write-head')
  const writingHeaderSmallLabels = await writingHeader.locator('small').allTextContents()
  if (writingHeaderSmallLabels.join('|') !== 'open') {
    throw new Error(`Streaming write timeline repeated Workspace bytes: ${JSON.stringify(writingHeaderSmallLabels)}`)
  }
  const visibleWritingLines = writingRow.locator('.streaming-file-write-line')
  if (await visibleWritingLines.count() !== 8) throw new Error('Streaming write did not show the final eight source lines')
  const visibleWritingLineNumbers = await visibleWritingLines.locator(':scope > span').allTextContents()
  if (visibleWritingLineNumbers.join('|') !== '415|416|417|418|419|420|421|422') {
    throw new Error(`Streaming write line-number tail drifted: ${JSON.stringify(visibleWritingLineNumbers)}`)
  }
  const workspaceDraft = page.locator('.workspace-draft-file').filter({ hasText: writing.path })
  await workspaceDraft.waitFor({ state: 'visible' })
  const expectedDraftUsage = `${(writing.bytes / 1024).toFixed(1)}KB/128.0MB`
  if (!(await page.locator('.workspace-usage').innerText()).replaceAll(' ', '').includes(expectedDraftUsage)) {
    throw new Error(`Workspace did not project the streaming UTF-8 byte count ${expectedDraftUsage}`)
  }
  const writingComposer = page.getByRole('textbox', { name: 'Message' })
  const composerLocked = await writingComposer.getAttribute('contenteditable') === 'false'
    && await writingComposer.getAttribute('aria-disabled') === 'true'
  const stopVisible = await page.getByRole('button', { name: 'Stop agent' }).isVisible()
  if (!composerLocked || !stopVisible) throw new Error('Streaming write lost its locked composer or Stop control')
  const streamingWriteInteractionCheck: StreamingWriteInteractionCheck = {
    path: 'ai-weekly-2026-08-31.html',
    visibleTailLines: 8,
    firstVisibleLine: 415,
    lastVisibleLine: 422,
    timelineByteBadgeAbsent: true,
    workspaceDraftVisible: true,
    workspaceBytesMatchUtf8: true,
    composerLocked: true,
    stopVisible: true,
  }
  await capture('running-writing-desktop')

  const workspacePersistence = await seedVisualWorkspacePersistenceFixture(created.store)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await selectDesktopSession(workspacePersistence.title)
  await expectSessionRoute(workspacePersistence.id, workspacePersistence.title)
  await page.getByLabel('Final answer streaming', { exact: true }).waitFor({ state: 'visible' })
  await ensureWorkspaceOpen()
  await setConversationScroll(page, 'bottom')
  const observedWorkspacePersistencePhases: WorkspacePersistenceInteractionCheck['observedPhases'] = []
  const waitForWorkspacePersistencePhase = async (
    phase: WorkspacePersistenceInteractionCheck['observedPhases'][number],
    composerLabel: string,
    sidebarLabel: string,
  ) => {
    const composerStatus = page.locator(`.workspace-persistence-status.${phase}`)
    const sidebarStatus = page.locator(`.workspace-persistence-heading.${phase}`)
    await composerStatus.waitFor({ state: 'visible' })
    await sidebarStatus.waitFor({ state: 'visible' })
    const labels = {
      composer: (await composerStatus.innerText()).trim(),
      sidebar: (await sidebarStatus.innerText()).trim(),
    }
    if (labels.composer !== composerLabel || labels.sidebar !== sidebarLabel) {
      throw new Error(`Workspace persistence ${phase} labels drifted: ${JSON.stringify(labels)}`)
    }
    if (!await page.getByLabel('Final answer streaming', { exact: true }).isVisible()) {
      throw new Error(`Workspace persistence ${phase} overtook Final streaming`)
    }
    if (await page.locator('.task-review-panel').count()) {
      throw new Error(`Workspace persistence ${phase} appeared after review.requested`)
    }
    observedWorkspacePersistencePhases.push(phase)
  }

  await advanceVisualWorkspacePersistenceScanning(created.store, workspacePersistence.id)
  await waitForWorkspacePersistencePhase('scanning', 'Scanning workspace...', 'Scanning')
  await capture('workspace-persistence-scanning-desktop')

  await advanceVisualWorkspacePersistenceUploading(created.store, workspacePersistence.id)
  await waitForWorkspacePersistencePhase('uploading', 'Uploading 0 workspace blobs...', 'Uploading 0 blobs')
  await capture('workspace-persistence-uploading-zero-blobs-desktop')

  await advanceVisualWorkspacePersistenceSaving(created.store, workspacePersistence.id)
  await waitForWorkspacePersistencePhase('saving', 'Saving workspace...', 'Saving')
  await capture('workspace-persistence-saving-desktop')

  await advanceVisualWorkspacePersistenceSaved(created.store, workspacePersistence)
  await waitForWorkspacePersistencePhase('saved', 'Workspace saved', 'Saved')
  await capture('workspace-persistence-saved-desktop')

  await completeVisualWorkspacePersistenceFixture(created.store, workspacePersistence)
  await page.locator('.final-streaming').waitFor({ state: 'detached' })
  await page.locator('.task-review-panel').waitFor({ state: 'visible' })
  const workspacePersistenceEvents = await created.store.events(workspacePersistence.id)
  const persistenceEvents = workspacePersistenceEvents.filter((event) => event.type.startsWith('workspace.persistence.'))
  const terminalFinalEvent = workspacePersistenceEvents.find((event) => event.type === 'assistant.final')
  const reviewRequestedEvent = workspacePersistenceEvents.find((event) => event.type === 'review.requested')
  const uploadingEvent = persistenceEvents.find((event) => event.data.phase === 'uploading')
  const persistencePhases = persistenceEvents.map((event) => event.data.phase)
  if (!terminalFinalEvent || !reviewRequestedEvent) {
    throw new Error('A02 persistence fixture is missing its terminal Final or Review request')
  }
  const a02SavedBeforeReview = persistenceEvents.every((event) => event.seq < terminalFinalEvent.seq)
    && terminalFinalEvent.seq < reviewRequestedEvent.seq
  if (JSON.stringify(persistencePhases) !== JSON.stringify(['scanning', 'uploading', 'saving', 'saved'])
    || uploadingEvent?.data.blobCount !== 0
    || uploadingEvent.data.persistenceMode !== 'local_durable'
    || !a02SavedBeforeReview) {
    throw new Error(`A02 Saved-before-Review ordering drifted: ${JSON.stringify(workspacePersistenceEvents.map((event) => ({ seq: event.seq, type: event.type, phase: event.data.phase, blobCount: event.data.blobCount, persistenceMode: event.data.persistenceMode })))}`)
  }
  await page.locator('.workspace-persistence-heading').waitFor({ state: 'detached' })

  await page.evaluate(() => sessionStorage.setItem('__aneraCaptureWorkspacePersistenceReload', '1'))
  // Pass source text rather than a transpiled callback: Playwright evaluates
  // init scripts in the page, where tsx's private __name helper is absent.
  await page.addInitScript(`(() => {
    if (sessionStorage.getItem('__aneraCaptureWorkspacePersistenceReload') !== '1') return;
    sessionStorage.removeItem('__aneraCaptureWorkspacePersistenceReload');
    const observed = [];
    window.__aneraWorkspacePersistenceReplay = observed;
    const collect = () => {
      for (const element of document.querySelectorAll('.workspace-persistence-status, .workspace-persistence-heading')) {
        const value = element.className + ':' + (element.textContent?.trim() || '');
        if (!observed.includes(value)) observed.push(value);
      }
    };
    const observe = () => {
      collect();
      const observer = new MutationObserver(collect);
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
    else observe();
  })()`)
  const reloadStreamRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === `/api/sessions/${workspacePersistence.id}/events`
      && Number(url.searchParams.get('after')) >= reviewRequestedEvent.seq
  }, { timeout: 5_000 })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await expectSessionRoute(workspacePersistence.id, workspacePersistence.title)
  const reloadStreamRequest = await reloadStreamRequestPromise
  const reloadHighWaterSeq = Number(new URL(reloadStreamRequest.url()).searchParams.get('after'))
  if (reloadHighWaterSeq !== reviewRequestedEvent.seq) {
    throw new Error(`Completed Session subscribed from the wrong persistence high-water mark: ${reloadHighWaterSeq} !== ${reviewRequestedEvent.seq}`)
  }
  await page.locator('.task-review-panel').waitFor({ state: 'visible' })
  await ensureWorkspaceOpen()
  await page.waitForTimeout(800)
  const reloadedPersistenceStatuses = await page.evaluate(() => (
    (window as typeof window & { __aneraWorkspacePersistenceReplay?: string[] }).__aneraWorkspacePersistenceReplay ?? []
  ))
  if (reloadedPersistenceStatuses.length > 0
    || await page.locator('.workspace-persistence-status, .workspace-persistence-heading').count() > 0
    || await page.locator('.final-streaming').count() > 0) {
    throw new Error(`Completed Session replayed its save animation: ${JSON.stringify(reloadedPersistenceStatuses)}`)
  }
  const reloadedWorkspacePersistence = await created.store.get(workspacePersistence.id)
  if (reloadedWorkspacePersistence.summary.status !== 'completed'
    || reloadedWorkspacePersistence.summary.workspaceBytes !== workspacePersistence.bytes) {
    throw new Error(`Completed Workspace persistence did not survive refresh: ${JSON.stringify(reloadedWorkspacePersistence.summary)}`)
  }
  await capture('workspace-persistence-reloaded-completed-desktop')

  // Arena exposes two legal terminal interleavings. A02 saves before Review;
  // A01 can show Review while the Workspace is still updating. Exercise the
  // second contract in a separate Session so neither order is treated as the
  // sole valid protocol.
  const interleavedPersistence = await seedVisualWorkspacePersistenceFixture(
    created.store,
    'Visual Workspace Persistence Interleaved',
  )
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await selectDesktopSession(interleavedPersistence.title)
  await expectSessionRoute(interleavedPersistence.id, interleavedPersistence.title)
  await page.getByLabel('Final answer streaming', { exact: true }).waitFor({ state: 'visible' })

  const interleavedSidebarStatus = page.locator('.workspace-persistence-heading')
  await advanceVisualWorkspacePersistenceScanning(created.store, interleavedPersistence.id)
  await interleavedSidebarStatus.filter({ hasText: 'Scanning' }).waitFor({ state: 'visible' })

  await completeVisualWorkspacePersistenceFixture(created.store, interleavedPersistence)
  const interleavedReview = page.locator('.task-review-panel')
  await interleavedReview.waitFor({ state: 'visible' })
  await ensureWorkspaceOpen()
  const waitForInterleavedPhase = async (label: string) => {
    await interleavedSidebarStatus.filter({ hasText: label }).waitFor({ state: 'visible' })
    if (!await interleavedReview.isVisible()) {
      throw new Error(`A01 Review disappeared while Workspace showed ${label}`)
    }
  }
  await waitForInterleavedPhase('Scanning')
  await capture('workspace-persistence-review-plus-scanning-desktop')
  await advanceVisualWorkspacePersistenceUploading(created.store, interleavedPersistence.id)
  await waitForInterleavedPhase('Uploading 0 blobs')
  await capture('workspace-persistence-review-plus-uploading-desktop')
  await advanceVisualWorkspacePersistenceSaving(created.store, interleavedPersistence.id)
  await waitForInterleavedPhase('Saving')
  await capture('workspace-persistence-review-plus-saving-desktop')
  await advanceVisualWorkspacePersistenceSaved(created.store, interleavedPersistence)
  await waitForInterleavedPhase('Saved')

  const interleavedEvents = await created.store.events(interleavedPersistence.id)
  const interleavedFinalEvent = interleavedEvents.find((event) => event.type === 'assistant.final')
  const interleavedReviewEvent = interleavedEvents.find((event) => event.type === 'review.requested')
  const interleavedPersistenceEvents = interleavedEvents.filter((event) => event.type.startsWith('workspace.persistence.'))
  const interleavedPersistenceStarted = interleavedPersistenceEvents.find((event) => event.type === 'workspace.persistence.started')
  const interleavedPersistenceCompleted = interleavedPersistenceEvents.find((event) => event.type === 'workspace.persistence.completed')
  const a01ReviewBeforePersistenceCompleted = Boolean(
    interleavedPersistenceStarted
    && interleavedFinalEvent
    && interleavedReviewEvent
    && interleavedPersistenceEvents.length === 4
    && interleavedPersistenceStarted.seq < interleavedFinalEvent.seq
    && interleavedFinalEvent.seq < interleavedReviewEvent.seq
    && interleavedPersistenceEvents.slice(1).every((event) => event.seq > interleavedReviewEvent.seq)
    && interleavedPersistenceCompleted
    && interleavedReviewEvent.seq < interleavedPersistenceCompleted.seq,
  )
  if (!a01ReviewBeforePersistenceCompleted) {
    throw new Error(`A01 Review-during-Workspace ordering drifted: ${JSON.stringify(interleavedEvents.map((event) => ({ seq: event.seq, type: event.type, phase: event.data.phase })))}`)
  }
  await interleavedSidebarStatus.waitFor({ state: 'detached', timeout: 5_000 })

  const workspacePersistenceInteractionCheck: WorkspacePersistenceInteractionCheck = {
    observedPhases: observedWorkspacePersistencePhases,
    uploadingBlobCount: 0,
    persistenceMode: 'local_durable',
    a01ReviewVisibleDuringWorkspaceUpdate: true,
    a01PersistenceStartedBeforeReview: true,
    a01ReviewBeforePersistenceCompleted: true,
    a01ReviewOverlappedWorkspaceUpdate: true,
    a02SavedBeforeReview: true,
    persistenceBeforeTerminalFinal: true,
    reviewAfterTerminalFinal: true,
    reloadHighWaterSeq,
    reloadedPersistenceStatuses,
    saveAnimationReplayedAfterRefresh: false,
    persistedAfterRefresh: true,
  }

  const thankYouPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 })
  thankYouPage.on('console', captureConsole)
  thankYouPage.on('pageerror', (error) => consoleMessages.push({ level: 'error', text: error.message }))
  thankYouPage.on('requestfailed', (request) => consoleMessages.push({ level: 'requestfailed', text: `${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}` }))
  const taskCompletionThankYouPassed = await captureTaskCompletionThankYouStates(
    thankYouPage,
    created.store,
    baseUrl,
    (name, settleBefore) => capture(name, settleBefore, thankYouPage),
  )
  await thankYouPage.close()
  const undoSuccess = await verifyUndoSuccessAndCapture(page, created.store, baseUrl, capture)
  const taskReviewGate = await verifyTaskReviewTerminalActions(page, created.store, baseUrl)
  taskReviewInteractionChecks.push(...taskReviewGate.checks)
  const taskReviewInteractionsPassed = taskReviewInteractionChecks.length === 5
    && new Set(taskReviewInteractionChecks.map((check) => check.action)).size === 5
    && taskReviewGate.optimisticRollbackPassed
  const taskCompletionGate = await verifyTaskCompletionActions(page, created.store, baseUrl)
  const taskCompletionInteractionChecks = taskCompletionGate.checks
  const taskCompletionInteractionsPassed = taskCompletionInteractionChecks.length === 3
    && new Set(taskCompletionInteractionChecks.map((check) => check.action)).size === 3
    && taskCompletionGate.optimisticRollbackPassed
  const undoFailureAndCompactionPassed = await verifyUndoFailureAndCompaction(page, created.store, baseUrl)
  const undoInteractionsPassed = undoSuccess.durableExactlyOnce && undoFailureAndCompactionPassed
  const conversationFollowInteractionsPassed = Object.values(conversationFollowInteractionChecks).every(Boolean)
  const workspacePersistenceInteractionsPassed = workspacePersistenceInteractionCheck.observedPhases.join('|') === 'scanning|uploading|saving|saved'
    && workspacePersistenceInteractionCheck.uploadingBlobCount === 0
    && workspacePersistenceInteractionCheck.persistenceMode === 'local_durable'
    && workspacePersistenceInteractionCheck.a01ReviewVisibleDuringWorkspaceUpdate
    && workspacePersistenceInteractionCheck.a01PersistenceStartedBeforeReview
    && workspacePersistenceInteractionCheck.a01ReviewBeforePersistenceCompleted
    && workspacePersistenceInteractionCheck.a01ReviewOverlappedWorkspaceUpdate
    && workspacePersistenceInteractionCheck.a02SavedBeforeReview
    && workspacePersistenceInteractionCheck.persistenceBeforeTerminalFinal
    && workspacePersistenceInteractionCheck.reviewAfterTerminalFinal
    && !workspacePersistenceInteractionCheck.saveAnimationReplayedAfterRefresh
    && workspacePersistenceInteractionCheck.persistedAfterRefresh
  const websiteWorkspaceInteractionsPassed = websiteWorkspaceInteractionChecks.initialWorkspaceVisible
    && websiteWorkspaceInteractionChecks.directHydrationWorkspaceVisible
    && websiteWorkspaceInteractionChecks.previewInitiallyClosed
    && websiteWorkspaceInteractionChecks.websiteLabel === 'ANERA Dev Server V1 :43123'
    && websiteWorkspaceInteractionChecks.explicitWebsiteOpen
    && websiteWorkspaceInteractionChecks.workspaceHiddenWhilePreviewOpen
    && websiteWorkspaceInteractionChecks.workspaceRestoredAfterPreviewClose
    && websiteWorkspaceInteractionChecks.workspaceFileUsesButton
    && websiteWorkspaceInteractionChecks.workspaceFileUsesDockedPreview
  const executionLogInteractionsPassed = executionLogInteractionCheck.currentCommandGroupAutoExpanded
    && executionLogInteractionCheck.currentBashAutoExpanded
    && executionLogInteractionCheck.commandSectionsVisibleWithoutCaptureClick
    && executionLogInteractionCheck.visibleSections.join('|') === 'COMMAND|STDOUT|STDERR'
  const workspaceFileInteractionsPassed = workspaceFileInteractionCheck.controlElement === 'BUTTON'
    && !workspaceFileInteractionCheck.targetBlank
    && workspaceFileInteractionCheck.dockedPreviewOpened
    && workspaceFileInteractionCheck.workspaceHiddenWhilePreviewOpen
    && workspaceFileInteractionCheck.workspaceRestoredAfterPreviewClose
  const streamingWriteInteractionsPassed = streamingWriteInteractionCheck.timelineByteBadgeAbsent
    && streamingWriteInteractionCheck.workspaceDraftVisible
    && streamingWriteInteractionCheck.workspaceBytesMatchUtf8
    && streamingWriteInteractionCheck.composerLocked
    && streamingWriteInteractionCheck.stopVisible
  const hitlInteractionsPassed = hitlInteractionCheck.pendingQuestionCount === 2
    && hitlInteractionCheck.pendingOptionCount === 4
    && hitlInteractionCheck.pendingCustomInputCount === 2
    && hitlInteractionCheck.resolvedAnswerCount === 1
    && hitlInteractionCheck.answerImmediatelyFollowsCard
    && hitlInteractionCheck.selectedLabelVisible
    && hitlInteractionCheck.customResponseVisible
    && hitlInteractionCheck.persistedAfterRefresh

  const contract: UiVisualContract = {
    schemaVersion: 'anera-ui-contract/1.0',
    product: 'Anera Agent Mode visual fixture',
    capturedAt: new Date().toISOString(),
    browser: await browser.version(),
    states,
  }
  await writeFile(resolve(output, 'ui-contract.json'), `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
  const errors = states.flatMap((state) => state.console
    .filter((message) => ['error', 'warning', 'requestfailed'].includes(message.level))
    // Route changes intentionally close the live SSE request and any in-flight
    // same-origin preview iframe. Keep every other network failure in the gate.
    .filter((message) => !(message.level === 'requestfailed' && /\/events(?:\?[^ ]*)?: net::ERR_ABORTED$/.test(message.text)))
    .filter((message) => !(message.level === 'requestfailed' && /\/workspace\/[^ ]+\/preview\/[^ ]+: net::ERR_ABORTED$/.test(message.text)))
    .map((message) => ({ state: state.name, ...message })))
  const overflows = states.filter((state) => state.document.horizontalOverflowPx > 0).map((state) => ({ state: state.name, pixels: state.document.horizontalOverflowPx }))
  const verticalOverflows = states
    .filter((state) => state.document.verticalOverflowPx > 0 || state.document.windowScrollY !== 0)
    .map((state) => ({ state: state.name, pixels: state.document.verticalOverflowPx, windowScrollY: state.document.windowScrollY }))
  const passed = errors.length === 0
    && overflows.length === 0
    && verticalOverflows.length === 0
    && taskReviewInteractionsPassed
    && taskCompletionInteractionsPassed
    && taskCompletionThankYouPassed
    && undoInteractionsPassed
    && conversationFollowInteractionsPassed
    && workspacePersistenceInteractionsPassed
    && websiteWorkspaceInteractionsPassed
    && executionLogInteractionsPassed
    && workspaceFileInteractionsPassed
    && streamingWriteInteractionsPassed
    && hitlInteractionsPassed
  await writeFile(resolve(output, 'capture-summary.json'), `${JSON.stringify({
    schemaVersion: contract.schemaVersion,
    stateCount: states.length,
    screenshots: states.map((state) => state.screenshot),
    consoleErrors: errors,
    horizontalOverflows: overflows,
    verticalOverflows,
    taskReviewInteractions: taskReviewInteractionChecks,
    taskReviewOptimisticRollback: taskReviewGate.optimisticRollbackPassed,
    taskCompletionInteractions: taskCompletionInteractionChecks,
    taskCompletionOptimisticRollback: taskCompletionGate.optimisticRollbackPassed,
    taskCompletionThankYou: taskCompletionThankYouPassed,
    customFeedbackArenaTransport: customFeedbackArenaTransportPassed,
    previewElementPickerInteraction: previewElementPickerInteractionChecks,
    agentDraftRouteInteractions: agentDraftRouteInteractionChecks,
    leaderboardInteractions: leaderboardInteractionChecks,
    conversationSearchInteractions: conversationSearchInteractionChecks,
    conversationFollowInteractions: conversationFollowInteractionChecks,
    executionLogInteraction: executionLogInteractionCheck,
    workspaceFileInteraction: workspaceFileInteractionCheck,
    streamingWriteInteraction: streamingWriteInteractionCheck,
    hitlInteraction: hitlInteractionCheck,
    websiteWorkspaceInteraction: websiteWorkspaceInteractionChecks,
    workspacePersistenceInteraction: workspacePersistenceInteractionCheck,
    undoInteraction: undoSuccess,
    undoFailureAndCompaction: undoFailureAndCompactionPassed,
    passed,
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ output, states: states.length, consoleErrors: errors.length, horizontalOverflows: overflows.length, verticalOverflows: verticalOverflows.length, agentDraftRouteInteractions: agentDraftRouteInteractionChecks, leaderboardInteractions: leaderboardInteractionChecks, conversationSearchInteractions: conversationSearchInteractionChecks, conversationFollowInteractions: conversationFollowInteractionChecks, executionLogInteraction: executionLogInteractionCheck, workspaceFileInteraction: workspaceFileInteractionCheck, streamingWriteInteraction: streamingWriteInteractionCheck, hitlInteraction: hitlInteractionCheck, websiteWorkspaceInteraction: websiteWorkspaceInteractionChecks, workspacePersistenceInteraction: workspacePersistenceInteractionCheck, previewElementPickerInteraction: previewElementPickerInteractionChecks, taskReviewInteractions: taskReviewInteractionChecks.length, taskReviewOptimisticRollback: taskReviewGate.optimisticRollbackPassed, taskCompletionInteractions: taskCompletionInteractionChecks.length, taskCompletionOptimisticRollback: taskCompletionGate.optimisticRollbackPassed, taskCompletionThankYou: taskCompletionThankYouPassed, customFeedbackArenaTransport: customFeedbackArenaTransportPassed, undoInteraction: undoSuccess, undoFailureAndCompaction: undoFailureAndCompactionPassed, passed }, null, 2)}\n`)
  if (!passed) process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (agent) await agent.shutdown()
  if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()))
  await rm(dataRoot, { recursive: true, force: true })
}

async function settle(page: import('playwright-core').Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))))
  await page.waitForTimeout(60)
}

interface ConversationScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceFromBottom: number
}

async function conversationScrollMetrics(page: import('playwright-core').Page): Promise<ConversationScrollMetrics> {
  return await page.locator('.conversation-scroll').evaluate((element) => {
    const scrollTop = element.scrollTop
    const scrollHeight = element.scrollHeight
    const clientHeight = element.clientHeight
    return {
      scrollTop,
      scrollHeight,
      clientHeight,
      distanceFromBottom: Math.max(0, scrollHeight - clientHeight - scrollTop),
    }
  })
}

async function expectConversationAtBottom(
  page: import('playwright-core').Page,
  label: string,
): Promise<ConversationScrollMetrics> {
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLElement>('.conversation-scroll')
    return Boolean(element && Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop) <= 1)
  }, undefined, { timeout: 5_000 })
  const metrics = await conversationScrollMetrics(page)
  if (metrics.distanceFromBottom > 1) throw new Error(`${label} did not reach the conversation bottom: ${JSON.stringify(metrics)}`)
  return metrics
}

async function setConversationScroll(page: import('playwright-core').Page, position: 'top' | 'bottom'): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.locator('.conversation-scroll').evaluate((element, edge) => {
    element.scrollTop = edge === 'bottom' ? element.scrollHeight : 0
  }, position)
  await settle(page)
}

async function revealLatestAssistantResponse(page: import('playwright-core').Page): Promise<void> {
  // app-shell exists before the asynchronous Session snapshot is materialized.
  // Wait for the actual Final before scrolling, otherwise a long completion
  // fixture can render after an early scroll and never cross the view gate.
  await page.locator('.final-answer[data-assistant-response-id]').last().waitFor({ state: 'attached' })
  await setConversationScroll(page, 'bottom')
}

async function captureTaskCompletionThankYouStates(
  page: import('playwright-core').Page,
  store: import('../server/session-store.js').SessionStore,
  baseUrl: string,
  capture: (name: string, settleBefore?: boolean) => Promise<void>,
): Promise<true> {
  await page.clock.install({ time: new Date('2026-08-28T12:00:00.000Z') })
  const defaultArm = await seedVisualTaskCompletionFixture(
    store,
    'Visual Task Completion Thank You',
    { isFreeSession: true },
  )
  await page.goto(`${baseUrl}/agent/${defaultArm.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await revealLatestAssistantResponse(page)
  const bar = page.getByTestId('task-completion-bar')
  await bar.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Yes', exact: true }).click()
  await bar.waitFor({ state: 'detached' })
  const thankYou = page.locator('.feedback-thank-you')
  await thankYou.filter({ hasText: 'Thank you for your feedback!' }).waitFor({ state: 'visible' })
  if (!await thankYou.evaluate((element) => element.classList.contains('in'))) {
    throw new Error('Task-completion thank-you did not enter through the in phase')
  }
  // Give the RPC enough headroom that the mocked clock cannot advance past
  // the requested pause instant between Date.now() and pauseAt(). This stays
  // well inside the already-scheduled 2s `in` phase.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 250)
  await capture('task-completion-thank-you-in', false)
  // Jump fires the already-scheduled 2s timer once without also consuming
  // the 200ms timer that the resulting `out` render schedules.
  await page.clock.fastForward(5_000)
  await page.locator('.feedback-thank-you.out').waitFor({ state: 'visible' })
  await capture('task-completion-thank-you-out', false)
  await page.clock.fastForward(200)
  await thankYou.waitFor({ state: 'detached', timeout: 1_000 })
  await page.clock.resume()

  const treatment = await seedVisualTaskCompletionFixture(
    store,
    'Visual Task Completion Treatment 2',
    { isFreeSession: true, customFeedbackArm: 'treatment-2' },
  )
  await page.goto(`${baseUrl}/agent/${treatment.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await revealLatestAssistantResponse(page)
  const treatmentBar = page.getByTestId('task-completion-bar')
  await treatmentBar.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Yes', exact: true }).click()
  await treatmentBar.waitFor({ state: 'detached' })
  await page.waitForTimeout(250)
  if (await page.locator('.feedback-thank-you').count()) {
    throw new Error('Task-completion treatment-2 arm rendered the default thank-you feedback')
  }
  const customFeedbackCallout = page.getByRole('region', { name: 'Provide your feedback' })
  await customFeedbackCallout.waitFor({ state: 'visible' })
  await capture('custom-feedback-treatment-2-callout-desktop')
  await customFeedbackCallout.getByRole('button', { name: 'Give feedback', exact: true }).click()
  const chip = page.locator('.feedback-chip')
  const editor = page.getByRole('textbox', { name: 'Message' })
  await chip.waitFor({ state: 'visible' })
  if (await editor.getAttribute('data-placeholder') !== 'Give feedback on this task…') {
    throw new Error('Treatment-2 callout did not activate the custom-feedback composer')
  }
  await capture('custom-feedback-treatment-2-chip-desktop')
  await page.getByRole('button', { name: 'Remove Feedback' }).click()
  await chip.waitFor({ state: 'detached' })
  return true
}

async function verifyUndoSuccessAndCapture(
  page: import('playwright-core').Page,
  store: import('../server/session-store.js').SessionStore,
  baseUrl: string,
  capture: (name: string, settleBefore?: boolean) => Promise<void>,
): Promise<UndoInteractionCheck> {
  const session = await seedVisualTaskReviewFixture(store, 'Visual Task Review Undo', { isFreeSession: true })
  await page.goto(`${baseUrl}/agent/${session.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await setConversationScroll(page, 'bottom')
  const panel = page.getByRole('dialog', { name: '此任务成功了吗？' })
  await panel.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '否', exact: true }).click()
  await panel.waitFor({ state: 'detached' })
  const callout = page.getByRole('status', { name: 'Undo last turn' })
  await callout.waitFor({ state: 'visible' })
  if (!await page.getByRole('button', { name: 'Send message' }).isDisabled()) {
    throw new Error('Composer Send remained enabled while the Undo offer was unresolved')
  }
  await capture('review-no-undo-offer')

  const editor = page.getByRole('textbox', { name: 'Message' })
  await editor.fill('draft that should be replaced during optimistic undo')
  await editor.evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['visual undo attachment'], 'undo-source.png', { type: 'image/png' }))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    element.dispatchEvent(event)
  })
  await page.locator('.attachment-chip').filter({ hasText: 'image-1.png' }).waitFor({ state: 'visible' })

  let releaseAction: (() => void) | undefined
  const actionGate = new Promise<void>((resolveAction) => { releaseAction = resolveAction })
  const actionUrl = `**/api/chat/${session.id}/action`
  await page.route(actionUrl, async (route) => {
    await actionGate
    await route.continue()
  })
  const requestPromise = page.waitForRequest((request) => (
    request.method() === 'POST' && request.url().endsWith(`/api/chat/${session.id}/action`)
  ))
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && response.url().endsWith(`/api/chat/${session.id}/action`)
  ))
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.locator('.composer-operation-status').filter({ hasText: 'Undoing last turn...' }).waitFor({ state: 'visible' })
  await page.locator('.attachment-chip').waitFor({ state: 'detached' })
  if (await page.locator('.user-turn').count() || await page.locator('.final-answer').count()) {
    throw new Error('Optimistic Undo left the target user/assistant turn visible')
  }
  if (await readComposerValue(editor) !== 'Calculate 317 × 29 and answer in one sentence.') {
    throw new Error(`Optimistic Undo restored the wrong prompt: ${JSON.stringify(await readComposerValue(editor))}`)
  }
  if (!await page.getByRole('button', { name: 'Send message' }).isDisabled()) {
    throw new Error('Composer Send remained enabled while Undo was in flight')
  }
  await capture('review-no-undo-inflight')
  releaseAction?.()
  const transportRequest = await requestPromise
  const transportResponse = await responsePromise
  const requestBody = transportRequest.postDataJSON() as Record<string, unknown>
  const responseBody = await transportResponse.json() as Record<string, unknown>
  await page.locator('.composer-operation-status').waitFor({ state: 'detached' })
  await page.waitForFunction(async (sessionId) => {
    const snapshot = await fetch(`/api/sessions/${sessionId}`).then((response) => response.json())
    return snapshot.events.filter((event: { type?: string }) => event.type === 'turn.undone').length === 1
  }, session.id)
  await page.unroute(actionUrl)

  if (requestBody.type !== 'undo'
    || typeof requestBody.sessionNodeId !== 'string'
    || requestBody.recaptchaV3Token !== null
    || Object.keys(requestBody).sort().join('|') !== 'recaptchaV3Token|sessionNodeId|type'
    || responseBody.type !== 'undo'
    || responseBody.sessionNodeId !== requestBody.sessionNodeId
    || responseBody.workspaceReverted !== false) {
    throw new Error(`Undo action transport drifted: ${JSON.stringify({ requestBody, responseBody })}`)
  }

  await page.evaluate(async ({ id, body }) => {
    const response = await fetch(`/api/chat/${id}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Idempotent Undo retry failed with ${response.status}`)
  }, { id: session.id, body: requestBody })
  const durableUndoEvents = (await store.events(session.id)).filter((event) => event.type === 'turn.undone')
  if (durableUndoEvents.length !== 1) throw new Error(`Undo retry appended ${durableUndoEvents.length} durable events`)

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  if (await page.locator('.user-turn').count() || await page.locator('.final-answer').count()) {
    throw new Error('Durable Undo target reappeared after refresh')
  }
  return {
    transport: 'action',
    requestType: 'undo',
    optimisticTimelineRemoved: true,
    promptRestored: true,
    attachmentsCleared: true,
    durableExactlyOnce: true,
    persistedAfterRefresh: true,
    workspaceReverted: false,
  }
}

async function verifyUndoFailureAndCompaction(
  page: import('playwright-core').Page,
  store: import('../server/session-store.js').SessionStore,
  baseUrl: string,
): Promise<true> {
  const failed = await seedVisualTaskReviewFixture(store, 'Visual Task Review Undo Failure', { isFreeSession: true })
  await page.goto(`${baseUrl}/agent/${failed.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await setConversationScroll(page, 'bottom')
  const panel = page.getByRole('dialog', { name: '此任务成功了吗？' })
  await panel.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '否', exact: true }).click()
  await panel.waitFor({ state: 'detached' })
  await page.getByRole('status', { name: 'Undo last turn' }).waitFor({ state: 'visible' })
  const editor = page.getByRole('textbox', { name: 'Message' })
  await editor.fill('preserve this draft after failed undo')
  await editor.evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['rollback attachment'], 'rollback-source.png', { type: 'image/png' }))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    element.dispatchEvent(event)
  })
  await page.locator('.attachment-chip').filter({ hasText: 'image-1.png' }).waitFor({ state: 'visible' })
  const failureUrl = `**/api/chat/${failed.id}/action`
  await page.route(failureUrl, async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic_undo_failure' }) })
  })
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.locator('.inline-error').filter({ hasText: 'Failed to undo message' }).waitFor({ state: 'visible' })
  await page.getByRole('status', { name: 'Undo last turn' }).waitFor({ state: 'visible' })
  await page.locator('.attachment-chip').filter({ hasText: 'image-1.png' }).waitFor({ state: 'visible' })
  if (await readComposerValue(editor) !== 'preserve this draft after failed undo') {
    throw new Error('Failed Undo did not restore the previous composer draft')
  }
  if ((await store.events(failed.id)).some((event) => event.type === 'turn.undone')) {
    throw new Error('Failed optimistic Undo appended a durable event')
  }
  await page.unroute(failureUrl)

  const compacted = await seedVisualTaskReviewFixture(store, 'Visual Task Review Compacted', { compacted: true, isFreeSession: true })
  await page.goto(`${baseUrl}/agent/${compacted.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await setConversationScroll(page, 'bottom')
  const compactedPanel = page.getByRole('dialog', { name: '此任务成功了吗？' })
  await compactedPanel.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '否', exact: true }).click()
  await compactedPanel.waitFor({ state: 'detached' })
  await page.locator('.composer').waitFor({ state: 'visible' })
  await settle(page)
  if (await page.getByRole('status', { name: 'Undo last turn' }).count()) {
    throw new Error('Undo offer appeared after a successful context compaction')
  }
  return true
}

async function readComposerValue(editor: import('playwright-core').Locator): Promise<string> {
  return editor.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    let value = ''
    let node = walker.nextNode()
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) value += (node.textContent || '').replaceAll('\u200b', '')
      else if (node instanceof HTMLBRElement) value += '\n'
      node = walker.nextNode()
    }
    return value
  })
}

async function verifyTaskReviewTerminalActions(
  page: import('playwright-core').Page,
  store: import('../server/session-store.js').SessionStore,
  baseUrl: string,
): Promise<{ checks: TaskReviewInteractionCheck[]; optimisticRollbackPassed: true }> {
  const probes = [
    { name: 'Yes', action: 'approve', requestAction: 'approve', button: '是', expectedType: 'feedback.updated', expectedField: 'value', expectedValue: 'upvote' },
    { name: 'No', action: 'disapprove', requestAction: 'disapprove', button: '否', expectedType: 'feedback.updated', expectedField: 'value', expectedValue: 'downvote' },
    { name: 'Close', action: 'close_button', requestAction: 'escape', button: 'Close review panel', expectedType: 'review.dismissed', expectedField: 'action', expectedValue: 'dismiss' },
    { name: 'Escape', action: 'escape_key', requestAction: 'escape', button: null, expectedType: 'review.dismissed', expectedField: 'action', expectedValue: 'dismiss' },
  ] as const
  const checks: TaskReviewInteractionCheck[] = []

  const rollback = await seedVisualTaskReviewFixture(store, 'Visual Task Review Rollback')
  await page.goto(`${baseUrl}/agent/${rollback.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  const rollbackPanel = page.getByRole('dialog', { name: '此任务成功了吗？' })
  await rollbackPanel.waitFor({ state: 'visible' })
  let releaseFailure: (() => void) | undefined
  const failureGate = new Promise<void>((resolveFailure) => { releaseFailure = resolveFailure })
  const failureUrl = `**/api/chat/${rollback.id}/review-feedback`
  await page.route(failureUrl, async (route) => {
    await failureGate
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic_check_in_failure' }) })
  })
  await page.getByRole('button', { name: '是', exact: true }).click()
  await rollbackPanel.waitFor({ state: 'detached' })
  await page.locator('.composer').waitFor({ state: 'visible' })
  releaseFailure?.()
  await rollbackPanel.waitFor({ state: 'visible' })
  await page.unroute(failureUrl)
  if ((await store.events(rollback.id)).some((event) => event.type === 'feedback.updated' || event.type === 'review.dismissed')) {
    throw new Error('Failed optimistic check-in feedback appended a durable event')
  }

  for (const probe of probes) {
    const session = await seedVisualTaskReviewFixture(store, `Visual Task Review ${probe.name}`)
    await page.goto(`${baseUrl}/agent/${session.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.locator('.app-shell').waitFor({ state: 'visible' })
    const panel = page.getByRole('dialog', { name: '此任务成功了吗？' })
    await panel.waitFor({ state: 'visible' })
    const before = await store.events(session.id)
    const requested = [...before].reverse().find((event) => event.type === 'review.requested')
    const messageEventId = (requested?.data as { messageEventId?: string } | undefined)?.messageEventId
    const turnCount = before.filter((event) => event.type === 'turn.started').length
    if (!messageEventId) throw new Error(`Task Review ${probe.name} fixture is missing its Final correlation`)

    const requestPromise = page.waitForRequest((request) => (
      request.method() === 'POST' && request.url().endsWith(`/api/chat/${session.id}/review-feedback`)
    ))
    if (probe.button) await page.getByRole('button', { name: probe.button, exact: true }).click()
    else await page.keyboard.press('Escape')
    const transportRequest = await requestPromise
    const requestBody = transportRequest.postDataJSON() as Record<string, unknown>
    await panel.waitFor({ state: 'detached' })
    await page.locator('.composer').waitFor({ state: 'visible' })

    const after = await store.events(session.id)
    const appended = after.slice(before.length)
    const action = appended[0]
    const summary = await store.get(session.id)
    if (appended.length !== 1
      || action?.type !== probe.expectedType
      || (action.data as Record<string, unknown> | undefined)?.[probe.expectedField] !== probe.expectedValue
      || (action.data as { messageEventId?: string } | undefined)?.messageEventId !== messageEventId
      || after.filter((event) => event.type === 'turn.started').length !== turnCount
      || after.some((event) => event.type === 'run.resumed')
      || summary.summary.status !== 'completed'
      || requestBody.sessionNodeId !== messageEventId
      || requestBody.recaptchaV3Token !== null
      || requestBody.action !== probe.requestAction
      || requestBody.feedback !== undefined) {
      throw new Error(`Task Review ${probe.name} changed the wrong durable state: ${JSON.stringify({
        appended,
        expectedType: probe.expectedType,
        expectedField: probe.expectedField,
        expectedValue: probe.expectedValue,
        messageEventId,
        turnCount,
        finalTurnCount: after.filter((event) => event.type === 'turn.started').length,
        sessionStatus: summary.summary.status,
        requestBody,
      })}`)
    }

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.locator('.composer').waitFor({ state: 'visible' })
    if (await page.locator('.task-review-panel').count()) {
      throw new Error(`Task Review ${probe.name} reappeared after refresh`)
    }
    checks.push({
      action: probe.action,
      requestAction: probe.requestAction,
      transport: 'review-feedback',
      eventType: probe.expectedType,
      durableValue: probe.expectedValue,
      finalCorrelated: true,
      noAgentEpisode: true,
      sessionStatus: 'completed',
      persistedAfterRefresh: true,
    })
  }
  return { checks, optimisticRollbackPassed: true }
}

async function verifyTaskCompletionActions(
  page: import('playwright-core').Page,
  store: import('../server/session-store.js').SessionStore,
  baseUrl: string,
): Promise<{ checks: TaskCompletionInteractionCheck[]; optimisticRollbackPassed: true }> {
  const rollback = await seedVisualTaskCompletionFixture(
    store,
    'Visual Task Completion Rollback',
    { isFreeSession: true },
  )
  await page.goto(`${baseUrl}/agent/${rollback.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await revealLatestAssistantResponse(page)
  const rollbackBar = page.getByTestId('task-completion-bar')
  await rollbackBar.waitFor({ state: 'visible' })
  let releaseFailure: (() => void) | undefined
  const failureGate = new Promise<void>((resolveFailure) => { releaseFailure = resolveFailure })
  const failureUrl = `**/api/chat/${rollback.id}/review-feedback`
  await page.route(failureUrl, async (route) => {
    await failureGate
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic_task_completion_failure' }) })
  })
  await page.getByRole('button', { name: 'Yes', exact: true }).click()
  await rollbackBar.waitFor({ state: 'detached' })
  releaseFailure?.()
  await rollbackBar.waitFor({ state: 'visible' })
  await page.unroute(failureUrl)
  if ((await store.events(rollback.id)).some((event) => event.type === 'task.completion.updated')) {
    throw new Error('Failed optimistic task-completion feedback appended a durable event')
  }

  const probes = [
    { value: 'no', button: 'No' },
    { value: 'making_progress', button: 'Making progress' },
    { value: 'yes', button: 'Yes' },
  ] as const
  const checks: TaskCompletionInteractionCheck[] = []
  for (const probe of probes) {
    const session = await seedVisualTaskCompletionFixture(
      store,
      `Visual Task Completion ${probe.button}`,
      { isFreeSession: true },
    )
    await page.goto(`${baseUrl}/agent/${session.id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.locator('.app-shell').waitFor({ state: 'visible' })
    await revealLatestAssistantResponse(page)
    const bar = page.getByTestId('task-completion-bar')
    await bar.waitFor({ state: 'visible' })
    const before = await store.events(session.id)
    const requested = [...before].reverse().find((event) => event.type === 'review.requested')
    const messageEventId = (requested?.data as { messageEventId?: string } | undefined)?.messageEventId
    const turnCount = before.filter((event) => event.type === 'turn.started').length
    if (!messageEventId) throw new Error(`Task completion ${probe.button} fixture is missing its Final correlation`)

    const requestPromise = page.waitForRequest((request) => (
      request.method() === 'POST' && request.url().endsWith(`/api/chat/${session.id}/review-feedback`)
    ))
    await page.getByRole('button', { name: probe.button, exact: true }).click()
    const transportRequest = await requestPromise
    const requestBody = transportRequest.postDataJSON() as Record<string, unknown>
    await bar.waitFor({ state: 'detached' })
    await page.locator('.composer').waitFor({ state: 'visible' })
    const after = await store.events(session.id)
    const appended = after.slice(before.length)
    const action = appended[0]
    const summary = await store.get(session.id)
    if (appended.length !== 1
      || action?.type !== 'task.completion.updated'
      || (action.data as { value?: string } | undefined)?.value !== probe.value
      || (action.data as { sessionNodeId?: string } | undefined)?.sessionNodeId !== messageEventId
      || (action.data as { feedback?: { type?: string; value?: string } } | undefined)?.feedback?.type !== 'task_completion_bar'
      || (action.data as { feedback?: { value?: string } } | undefined)?.feedback?.value !== probe.value
      || after.filter((event) => event.type === 'turn.started').length !== turnCount
      || after.some((event) => event.type === 'run.resumed')
      || summary.summary.status !== 'completed'
      || requestBody.sessionNodeId !== messageEventId
      || requestBody.recaptchaV3Token !== null
      || (requestBody.feedback as { type?: unknown; value?: unknown } | undefined)?.type !== 'task_completion_bar'
      || (requestBody.feedback as { value?: unknown } | undefined)?.value !== probe.value
      || requestBody.action !== undefined) {
      throw new Error(`Task completion ${probe.button} changed the wrong durable state: ${JSON.stringify({
        appended,
        expectedValue: probe.value,
        messageEventId,
        turnCount,
        finalTurnCount: after.filter((event) => event.type === 'turn.started').length,
        sessionStatus: summary.summary.status,
        requestBody,
      })}`)
    }

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.locator('.composer').waitFor({ state: 'visible' })
    await setConversationScroll(page, 'bottom')
    if (await page.getByTestId('task-completion-bar').count()) {
      throw new Error(`Task completion ${probe.button} reappeared after refresh`)
    }
    checks.push({
      action: probe.value,
      transport: 'review-feedback',
      eventType: 'task.completion.updated',
      durableValue: probe.value,
      finalCorrelated: true,
      noAgentEpisode: true,
      sessionStatus: 'completed',
      persistedAfterRefresh: true,
    })
  }
  return { checks, optimisticRollbackPassed: true }
}

function parseArgs(values: string[]): { values: Record<string, string>; positionals: string[] } {
  const parsed: { values: Record<string, string>; positionals: string[] } = { values: {}, positionals: [] }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) parsed.positionals.push(value)
    else {
      const name = value.slice(2)
      const next = values[index + 1]
      if (!next || next.startsWith('--')) usage(`Missing value for --${name}`)
      parsed.values[name] = next
      index += 1
    }
  }
  return parsed
}

function usage(error?: string): never {
  if (error) process.stderr.write(`${error}\n\n`)
  process.stderr.write('Usage: npm run visual:capture -- --output <directory>\n')
  process.exit(2)
}

async function visualGitHubFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input))
  if (url.hostname === 'www.githubstatus.com') {
    return visualJson({ status: { indicator: 'none', description: 'All Systems Operational' } })
  }
  if (url.pathname === '/user/repos') return visualJson([visualRepository()])
  if (url.pathname === '/repositories/17') return visualJson(visualRepository())
  if (url.pathname === '/repos/arena-labs/harness/branches') return visualJson([{ name: 'main', commit: { sha: 'a'.repeat(40) } }, { name: 'feature/visual-contract', commit: { sha: 'b'.repeat(40) } }])
  if (url.pathname === '/repos/arena-labs/harness/branches/main') return visualJson({ name: 'main', commit: { sha: 'a'.repeat(40) } })
  return visualJson({}, 404)
}

function visualJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function visualRepository(): Record<string, unknown> {
  return {
    id: 17,
    full_name: 'arena-labs/harness',
    name: 'harness',
    owner: { login: 'arena-labs', type: 'Organization' },
    default_branch: 'main',
    private: true,
    visibility: 'private',
    description: 'Visual contract repository',
    homepage: null,
    language: 'TypeScript',
    size: 42,
    stargazers_count: 3,
    watchers_count: 3,
    forks_count: 1,
    open_issues_count: 0,
    topics: ['agents'],
    fork: false,
    archived: false,
    disabled: false,
    is_template: false,
    created_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-08-28T00:00:00Z',
    updated_at: '2026-08-28T00:00:00Z',
  }
}
