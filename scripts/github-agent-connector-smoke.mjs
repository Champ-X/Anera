import { createServer } from 'node:http'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const projectRoot = resolve(process.cwd())
const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/real-smokes')
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-github-agent-connector-'))
const syntheticInstallationToken = 'ghs_SYNTHETIC_AGENT_CONNECTOR_TOKEN_DO_NOT_USE'
const installationId = 731
const appId = '42'
const appSlug = 'anera-agent-smoke'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateMarker = 'PRIVATE-GITHUB-EVIDENCE-731'
const finalMarker = 'GITHUB-AGENT-CONNECTOR-OK-731'
const commitSha = 'a'.repeat(40)
const blobSha = 'b'.repeat(40)
const githubRequests = []
let server
let agent
let browser

try {
  const { createApp } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/app.js')).href)
  const { GitHubConnector } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/github-connector.js')).href)
  const github = new GitHubConnector({
    dataRoot,
    appId,
    appSlug,
    appPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    apiBaseUrl: 'https://api.github.test',
    oauthBaseUrl: 'https://github.test',
    fetch: async (input, init) => {
      const url = new URL(String(input))
      const authorization = new Headers(init?.headers).get('authorization')
      const isInstallationTokenRequest = url.pathname === `/app/installations/${installationId}/access_tokens`
      const authorized = isInstallationTokenRequest
        ? verifyAppJwt(authorization, publicKey)
        : authorization === `Bearer ${syntheticInstallationToken}`
      githubRequests.push({
        scope: isInstallationTokenRequest ? 'installation_token' : url.origin === 'https://api.github.test' ? 'api' : 'service_status',
        path: `${url.pathname}${url.search}`,
        authorized,
      })
      if (isInstallationTokenRequest) {
        return jsonResponse({ token: syntheticInstallationToken, expires_at: '2099-01-01T00:00:00Z' }, 201)
      }
      if (url.pathname === '/installation/repositories') {
        return jsonResponse({ total_count: 1, repositories: [repositoryPayload()] })
      }
      if (url.pathname === '/repositories/17') return jsonResponse(repositoryPayload())
      if (url.pathname === '/repos/arena-labs/private-harness/branches/main') {
        return jsonResponse({ name: 'main', commit: { sha: commitSha } })
      }
      if (url.pathname === '/repos/arena-labs/private-harness/contents/README.md') {
        const content = `${privateMarker}\n`
        return jsonResponse({
          type: 'file', encoding: 'base64', path: 'README.md', sha: blobSha,
          size: Buffer.byteLength(content), html_url: null, content: Buffer.from(content).toString('base64'),
        })
      }
      return new Response('{}', { status: 404 })
    },
  })
  const installation = await github.beginInstallation('http://127.0.0.1/callback')
  if (installation.kind !== 'redirect') throw new Error('GitHub App smoke did not enter installation flow')
  const installationState = new URL(installation.url).searchParams.get('state') || ''
  await github.completeInstallation({ installationId, setupAction: 'install', state: installationState })
  const created = await createApp({ dataRoot, github: { connector: github } })
  agent = created.agent
  server = createServer(created.app)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('GitHub Agent connector smoke server did not bind')
  const base = `http://127.0.0.1:${address.port}`

  const createdSession = await postJson(base, '/api/sessions', {}, 201)
  const sessionId = createdSession.session.id
  await postJson(base, `/api/sessions/${sessionId}/messages`, {
    attachments: [],
    timezone: 'Asia/Shanghai',
    content: `First call list_connector_tools exactly once with service github. After it succeeds, call github_list_repositories exactly once with limit 10. From that result use repo_id 17 to call github_read_file exactly once for path README.md and ref main. Do not use any other tool. Verify that the private file contains ${privateMarker}, then output exactly ${finalMarker} and nothing else.`,
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
  const expectedTools = ['list_connector_tools', 'github_list_repositories', 'github_read_file']
  const readResultText = String(snapshot.events.find((event) => (
    event.type === 'tool.completed' && event.data?.call?.name === 'github_read_file'
  ))?.data?.result || '')
  const readResult = JSON.parse(readResultText)

  if (snapshot.session.status !== 'completed') throw new Error(`GitHub connector run ended as ${snapshot.session.status}`)
  if (JSON.stringify(startedTools) !== JSON.stringify(expectedTools)) throw new Error(`Unexpected GitHub tool sequence: ${JSON.stringify(startedTools)}`)
  if (JSON.stringify(completedTools) !== JSON.stringify(expectedTools) || failedTools.length > 0) {
    throw new Error(`GitHub tools did not all complete: ${JSON.stringify({ completedTools, failed: failedTools.map((event) => event.data) })}`)
  }
  if (final !== finalMarker) throw new Error(`Unexpected GitHub connector Final: ${JSON.stringify(final)}`)
  if (readResult.repository?.private !== true || readResult.repository?.fullName !== 'arena-labs/private-harness') {
    throw new Error(`GitHub repository attribution is missing: ${readResultText}`)
  }
  if (readResult.branch?.commitSha !== commitSha || readResult.file?.blobSha !== blobSha || !readResult.file?.content?.includes(privateMarker)) {
    throw new Error(`GitHub file evidence is incomplete: ${readResultText}`)
  }
  const apiRequests = githubRequests.filter((request) => request.scope === 'api')
  if (apiRequests.length !== 4 || apiRequests.some((request) => !request.authorized)) {
    throw new Error(`GitHub HTTP boundary was not authorized as expected: ${JSON.stringify(githubRequests)}`)
  }
  const installationTokenRequests = githubRequests.filter((request) => request.scope === 'installation_token')
  if (installationTokenRequests.length !== 1 || installationTokenRequests.some((request) => !request.authorized)) {
    throw new Error(`GitHub App token exchange was not authorized as expected: ${JSON.stringify(githubRequests)}`)
  }
  if (JSON.stringify(snapshot).includes(syntheticInstallationToken)) throw new Error('GitHub installation token leaked into public Session state')

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
  await page.locator('.tool-row').filter({ hasText: 'Checked github' }).waitFor({ state: 'visible' })
  const readRow = page.locator('.tool-row').filter({ hasText: 'github read file' })
  await readRow.waitFor({ state: 'visible' })
  await readRow.locator('button.tool-head').click()
  await readRow.locator('.tool-body').filter({ hasText: privateMarker }).waitFor({ state: 'visible' })
  const screenshot = resolve(reportDirectory, `github-agent-connector-${sessionId}.png`)
  await page.screenshot({ path: screenshot, animations: 'disabled', caret: 'hide', type: 'png' })
  if (consoleErrors.length > 0) throw new Error(`GitHub connector UI console errors: ${JSON.stringify(consoleErrors)}`)
  if (githubRequests.some((request) => request.scope === 'service_status' && request.authorized)) {
    throw new Error(`GitHub token leaked outside the configured API origin: ${JSON.stringify(githubRequests)}`)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sessionId,
    status: snapshot.session.status,
    model: snapshot.session.model,
    usage: snapshot.session.usage,
    startedTools,
    completedTools,
    githubRequests,
    repository: readResult.repository,
    branch: readResult.branch,
    file: { path: readResult.file.path, blobSha: readResult.file.blobSha, markerVerified: true },
    final,
    ui: { dynamicToolVisible: true, privateResultVisible: true, consoleErrors, screenshot },
    passed: true,
  }
  const reportPath = resolve(reportDirectory, `github-agent-connector-${sessionId}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
} finally {
  await browser?.close()
  await agent?.shutdown()
  if (server) await new Promise((resolveClose) => server.close(() => resolveClose()))
  await rm(dataRoot, { recursive: true, force: true })
}

function repositoryPayload() {
  return {
    id: 17, full_name: 'arena-labs/private-harness', name: 'private-harness',
    owner: { login: 'arena-labs', type: 'Organization' }, default_branch: 'main', private: true,
    visibility: 'private', description: 'Synthetic private connector repository', homepage: null,
    language: 'TypeScript', size: 42, stargazers_count: 0, watchers_count: 0, forks_count: 0,
    open_issues_count: 0, topics: ['agents'], fork: false, archived: false, disabled: false,
    is_template: false, created_at: '2026-01-01T00:00:00Z', pushed_at: '2026-08-29T00:00:00Z', updated_at: '2026-08-29T00:00:00Z',
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function verifyAppJwt(authorization, publicKey) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  const jwt = authorization.slice('Bearer '.length)
  const [header, payload, signature] = jwt.split('.')
  if (!header || !payload || !signature) return false
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (claims.iss !== appId || claims.exp - claims.iat !== 9 * 60) return false
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${header}.${payload}`)
    verifier.end()
    return verifier.verify(publicKey, Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}

async function postJson(base, path, body, expectedStatus) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
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
  throw new Error(`Session ${sessionId} did not finish before the GitHub connector smoke deadline`)
}
