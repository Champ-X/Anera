import { createServer } from 'node:http'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import { createApp } from './app.js'
import {
  GitHubConnector,
  GitHubConnectorError,
  GitHubRepositoryBootstrapper,
  GITHUB_AGENT_TOOL_DEFINITIONS,
  OAuthCallbackError,
  createGitHubAgentToolExecutor,
  createGitHubCodingShellCommandBroker,
} from './github-connector.js'

const SYNTHETIC_TOKEN = 'ghp_SYNTHETIC_TEST_TOKEN_DO_NOT_USE'

describe('GitHub connector protocol', () => {
  it('uses expiring one-time OAuth state and persists the credential with owner-only permissions', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-oauth-'))
    let now = 1_000
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return jsonResponse({ access_token: SYNTHETIC_TOKEN })
    })
    const connector = new GitHubConnector({
      dataRoot: root,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      stateTtlMs: 50,
      now: () => now,
      fetch: fetchImpl as typeof fetch,
    })
    try {
      const started = await connector.beginOAuth('http://127.0.0.1/callback')
      expect(started.kind).toBe('redirect')
      if (started.kind !== 'redirect') throw new Error('Expected OAuth redirect')
      const state = new URL(started.url).searchParams.get('state') || ''
      expect(state.length).toBeGreaterThan(30)
      await connector.completeOAuth({ code: 'synthetic-code', state })
      expect(await connector.connection()).toEqual({ status: 'connected' })
      expect(String(requests[0].init?.body)).toContain('client_secret=client-secret')
      await expect(connector.completeOAuth({ code: 'replayed-code', state })).rejects.toMatchObject<Partial<OAuthCallbackError>>({ oauthCode: 'invalid_state' })

      const denied = await connector.beginOAuth('http://127.0.0.1/callback')
      if (denied.kind !== 'redirect') throw new Error('Expected OAuth redirect')
      const deniedState = new URL(denied.url).searchParams.get('state') || ''
      connector.cancelOAuth(deniedState)
      await expect(connector.completeOAuth({ code: 'code-after-denial', state: deniedState })).rejects.toMatchObject<Partial<OAuthCallbackError>>({ oauthCode: 'invalid_state' })

      const connectionPath = resolve(root, 'github', 'connection.json')
      expect((await stat(connectionPath)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(connectionPath, 'utf8'))).toMatchObject({ version: 1, token: SYNTHETIC_TOKEN })

      const expiring = await connector.beginOAuth('http://127.0.0.1/callback')
      if (expiring.kind !== 'redirect') throw new Error('Expected OAuth redirect')
      const expiringState = new URL(expiring.url).searchParams.get('state') || ''
      now += 51
      await expect(connector.completeOAuth({ code: 'late-code', state: expiringState })).rejects.toMatchObject<Partial<OAuthCallbackError>>({ oauthCode: 'state_expired' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses a repository-scoped GitHub App installation with signed short-lived tokens', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-app-'))
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    let now = Date.parse('2026-08-29T00:00:00Z')
    const requests: Array<{ path: string; authorization: string | null }> = []
    let issued = 0
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const authorization = new Headers(init?.headers).get('authorization')
      requests.push({ path: url.pathname, authorization })
      if (url.pathname === '/app/installations/731/access_tokens') {
        expect(init?.method).toBe('POST')
        const jwt = String(authorization).replace(/^Bearer /, '')
        const [header, payload, signature] = jwt.split('.')
        expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toEqual({ alg: 'RS256', typ: 'JWT' })
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iat: number; exp: number; iss: string }
        expect(claims.iss).toBe('42')
        expect(claims.exp - claims.iat).toBe(9 * 60)
        const verifier = createVerify('RSA-SHA256')
        verifier.update(`${header}.${payload}`)
        verifier.end()
        expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
        issued += 1
        return jsonResponse({
          token: `ghs_SYNTHETIC_INSTALLATION_${issued}`,
          expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
        }, 201)
      }
      if (url.pathname === '/installation/repositories') {
        expect(authorization).toBe(`Bearer ghs_SYNTHETIC_INSTALLATION_${issued}`)
        return jsonResponse({ total_count: 1, repositories: [repositoryPayload()] })
      }
      return new Response('{}', { status: 404 })
    })
    const connector = new GitHubConnector({
      dataRoot: root,
      appId: '42',
      appSlug: 'anera-agent-test',
      appPrivateKey: privatePem,
      apiBaseUrl: 'https://api.test',
      oauthBaseUrl: 'https://github.test',
      now: () => now,
      fetch: fetchImpl as typeof fetch,
    })
    try {
      const started = await connector.beginInstallation('http://127.0.0.1/callback')
      expect(started.kind).toBe('redirect')
      if (started.kind !== 'redirect') throw new Error('Expected installation redirect')
      const installUrl = new URL(started.url)
      expect(installUrl.origin).toBe('https://github.test')
      expect(installUrl.pathname).toBe('/apps/anera-agent-test/installations/new')
      const state = installUrl.searchParams.get('state') || ''
      await connector.completeInstallation({ installationId: '731', setupAction: 'install', state })
      expect(await connector.connection()).toEqual({ status: 'connected' })

      const connectionPath = resolve(root, 'github', 'connection.json')
      expect((await stat(connectionPath)).mode & 0o777).toBe(0o600)
      const persisted = await readFile(connectionPath, 'utf8')
      expect(JSON.parse(persisted)).toEqual({ version: 1, installationId: 731, envTokenDisabled: false })
      expect(persisted).not.toContain('ghs_SYNTHETIC')
      expect(persisted).not.toContain('PRIVATE KEY')

      expect((await connector.listRepositories(10)).repos[0].id).toBe(17)
      expect(requests.some((request) => request.path === '/installation/repositories')).toBe(true)
      expect(requests.some((request) => request.path === '/user/repos')).toBe(false)
      expect(issued).toBe(1)
      now += 2 * 60 * 60 * 1000
      expect((await connector.listRepositories(10)).repos[0].id).toBe(17)
      expect(issued).toBe(2)
      now += 2 * 60 * 60 * 1000
      const concurrentPages = await Promise.all([
        connector.listRepositories(10),
        connector.listRepositories(10),
        connector.listRepositories(10),
      ])
      expect(concurrentPages.every((page) => page.repos[0].id === 17)).toBe(true)
      expect(issued).toBe(3)
      expect(requests.filter((request) => request.path.includes('/access_tokens'))).toHaveLength(3)

      await expect(connector.completeInstallation({ installationId: 731, state })).rejects.toMatchObject<Partial<OAuthCallbackError>>({ oauthCode: 'invalid_state' })
      await connector.disconnect()
      expect(await connector.connection()).toEqual({ status: 'disconnected' })
      await expect(connector.listRepositories(10)).rejects.toMatchObject<Partial<GitHubConnectorError>>({ code: 'not_connected' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when an installation is disconnected during token refresh', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-app-disconnect-race-'))
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    await mkdir(resolve(root, 'github'), { recursive: true })
    await writeFile(resolve(root, 'github', 'connection.json'), '{"version":1,"installationId":731}\n', { mode: 0o600 })
    let releaseToken: ((response: Response) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted })
    const paths: string[] = []
    const connector = new GitHubConnector({
      dataRoot: root,
      appId: '42',
      appSlug: 'anera-agent-test',
      appPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      apiBaseUrl: 'https://api.test',
      fetch: vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname
        paths.push(path)
        if (path === '/app/installations/731/access_tokens') {
          markStarted?.()
          return await new Promise<Response>((resolveToken) => { releaseToken = resolveToken })
        }
        if (path === '/user/repos') return jsonResponse([repositoryPayload()])
        return new Response('{}', { status: 404 })
      }) as typeof fetch,
    })
    try {
      const pending = connector.listRepositories(10)
      await started
      await connector.disconnect()
      releaseToken?.(jsonResponse({ token: 'ghs_LATE_DISCONNECTED_TOKEN', expires_at: '2099-01-01T00:00:00Z' }, 201))
      await expect(pending).rejects.toMatchObject<Partial<GitHubConnectorError>>({ code: 'not_connected' })
      expect(paths).toEqual(['/app/installations/731/access_tokens'])
      expect(await connector.connection()).toEqual({ status: 'disconnected' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('routes the coding Install control through the GitHub App callback instead of broad OAuth', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-app-api-'))
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const connector = new GitHubConnector({
      dataRoot: resolve(root, 'connector'),
      appId: '42',
      appSlug: 'anera-agent-test',
      appPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      apiBaseUrl: 'https://api.test',
      oauthBaseUrl: 'https://github.test',
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input))
        if (url.pathname === '/app/installations/731/access_tokens') {
          return jsonResponse({ token: 'ghs_SYNTHETIC_INSTALLATION_API', expires_at: '2099-01-01T00:00:00Z' }, 201)
        }
        return new Response('{}', { status: 404 })
      }) as typeof fetch,
    })
    const created = await createApp({ dataRoot: resolve(root, 'data'), model: 'test-model', github: { connector } })
    const server = createServer(created.app)
    try {
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not bind')
      const base = `http://127.0.0.1:${address.port}`
      const startResponse = await fetch(`${base}/api/coding/github/connect/start`, { redirect: 'manual' })
      expect(startResponse.status).toBe(302)
      const location = new URL(startResponse.headers.get('location') || '')
      expect(location.origin).toBe('https://github.test')
      expect(location.pathname).toBe('/apps/anera-agent-test/installations/new')
      const state = location.searchParams.get('state') || ''
      const callback = await fetch(`${base}/api/coding/github/callback?installation_id=731&setup_action=install&state=${encodeURIComponent(state)}`)
      expect(callback.status).toBe(200)
      expect(await callback.text()).toContain('"success":true')
      expect(await (await fetch(`${base}/api/coding/github/connection`)).json()).toEqual({ status: 'connected' })
    } finally {
      await created.agent.shutdown()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps repository and branch pages to the exact public schema and rejects mismatched selections', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-pages-'))
    const seen: Array<{ url: string; authorization: string | null }> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      seen.push({ url: url.toString(), authorization: headers.get('authorization') })
      if (url.pathname === '/user/repos') return jsonResponse([repositoryPayload()], 200, url.searchParams.get('per_page') === '1' ? { link: '<https://api.test/user/repos?per_page=1&page=2>; rel="next"' } : {})
      if (url.pathname === '/repositories/17') return jsonResponse(repositoryPayload())
      if (url.pathname === '/repos/arena-labs/harness/branches') return jsonResponse([{ name: 'main', commit: { sha: 'a'.repeat(40) } }], 200, url.searchParams.get('per_page') === '1' ? { link: '<https://api.test/repos/arena-labs/harness/branches?per_page=1&page=2>; rel="next"' } : {})
      if (url.pathname === '/repos/arena-labs/harness/branches/main') return jsonResponse({ name: 'main', commit: { sha: 'a'.repeat(40) } })
      if (url.pathname === '/repos/arena-labs/harness/contents/README.md') return jsonResponse({
        type: 'file',
        encoding: 'base64',
        path: 'README.md',
        sha: 'b'.repeat(40),
        size: Buffer.byteLength('PRIVATE-CONNECTOR-MARKER-731\n'),
        html_url: 'https://github.test/arena-labs/harness/blob/main/README.md',
        content: Buffer.from('PRIVATE-CONNECTOR-MARKER-731\n').toString('base64'),
      })
      return new Response('{}', { status: 404 })
    })
    const connector = new GitHubConnector({ dataRoot: root, token: SYNTHETIC_TOKEN, apiBaseUrl: 'https://api.test', fetch: fetchImpl as typeof fetch })
    try {
      expect(await connector.listRepositories(1)).toEqual({
        repos: [{
          id: 17,
          fullName: 'arena-labs/harness',
          name: 'harness',
          ownerLogin: 'arena-labs',
          ownerType: 'Organization',
          defaultBranch: 'main',
          private: true,
          visibility: 'private',
          description: 'Synthetic repository',
          homepage: null,
          language: 'TypeScript',
          sizeKb: 42,
          stargazersCount: 3,
          watchersCount: 4,
          forksCount: 1,
          openIssuesCount: 2,
          topics: ['agents'],
          fork: false,
          archived: false,
          disabled: false,
          isTemplate: false,
          createdAt: '2026-01-01T00:00:00Z',
          pushedAt: '2026-08-28T00:00:00Z',
          updatedAt: '2026-08-28T00:00:00Z',
        }],
        nextCursor: '2',
        hasNextPage: true,
      })
      expect(await connector.listBranches(17, 1)).toEqual({
        branches: [{ name: 'main', commitSha: 'a'.repeat(40) }],
        nextCursor: '2',
        hasNextPage: true,
      })
      expect(await connector.listRepositories(2)).toMatchObject({ nextCursor: null, hasNextPage: false })
      expect(await connector.listBranches(17, 2)).toMatchObject({ nextCursor: null, hasNextPage: false })
      expect(await connector.readFile(17, 'README.md')).toEqual({
        repository: { id: 17, fullName: 'arena-labs/harness', private: true },
        branch: { name: 'main', commitSha: 'a'.repeat(40) },
        file: {
          path: 'README.md',
          blobSha: 'b'.repeat(40),
          size: Buffer.byteLength('PRIVATE-CONNECTOR-MARKER-731\n'),
          htmlUrl: 'https://github.test/arena-labs/harness/blob/main/README.md',
          content: 'PRIVATE-CONNECTOR-MARKER-731\n',
        },
      })
      await expect(connector.readFile(17, '../secret.txt')).rejects.toMatchObject<Partial<GitHubConnectorError>>({ code: 'github_request_failed', statusCode: 400 })
      expect((await connector.resolveSelection({ repoId: 17, repoOwner: 'arena-labs', repoName: 'harness', baseBranch: 'main' })).branch.commitSha).toBe('a'.repeat(40))
      await expect(connector.resolveSelection({ repoId: 17, repoOwner: 'arena-labs', repoName: 'harness', baseBranch: 'feature/probe' })).rejects.toMatchObject<Partial<GitHubConnectorError>>({ code: 'branch_not_found', statusCode: 404 })
      await expect(connector.resolveSelection({ repoId: 17, repoOwner: 'attacker', repoName: 'harness', baseBranch: 'main' })).rejects.toMatchObject<Partial<GitHubConnectorError>>({ code: 'repo_not_found' })
      await expect(connector.resolveSelection({ repoId: 17, repoOwner: 'arena-labs', repoName: 'harness', baseBranch: '../main' })).rejects.toMatchObject<Partial<GitHubConnectorError>>({ code: 'branch_not_found' })
      expect(seen.every((request) => request.authorization === `Bearer ${SYNTHETIC_TOKEN}`)).toBe(true)
      expect(seen.some((request) => request.url.includes('per_page=1&page=1'))).toBe(true)
      expect(seen.some((request) => request.url.includes('/branches/feature%2Fprobe'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns stable public error categories for disconnected and failed GitHub requests', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-errors-'))
    const disconnected = new GitHubConnector({ dataRoot: root })
    await expect(disconnected.listRepositories(100)).rejects.toMatchObject<Partial<GitHubConnectorError>>({ code: 'not_connected', statusCode: 401 })
    const partiallyConfiguredApp = new GitHubConnector({
      dataRoot: root,
      appId: '42',
      clientId: 'broad-oauth-client-that-must-not-be-used',
      clientSecret: 'synthetic-secret',
    })
    await expect(partiallyConfiguredApp.beginInstallation('http://127.0.0.1/callback')).rejects.toMatchObject<Partial<GitHubConnectorError>>({
      code: 'not_connected',
      statusCode: 503,
      message: 'GitHub App installation is incompletely configured.',
    })
    const unavailable = new GitHubConnector({
      dataRoot: root,
      token: SYNTHETIC_TOKEN,
      fetch: vi.fn(async () => new Response('{}', { status: 503 })) as typeof fetch,
    })
    await expect(unavailable.listRepositories(100)).rejects.toMatchObject<Partial<GitHubConnectorError>>({ code: 'github_request_failed', statusCode: 502 })
    await rm(root, { recursive: true, force: true })
  })

  it('exposes a bounded read-only Agent tool surface with structured results', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-agent-tools-'))
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/user/repos') return jsonResponse([repositoryPayload()])
      if (url.pathname === '/repositories/17') return jsonResponse(repositoryPayload())
      if (url.pathname === '/repos/arena-labs/harness/branches/main') return jsonResponse({ name: 'main', commit: { sha: 'a'.repeat(40) } })
      if (url.pathname === '/repos/arena-labs/harness/contents/README.md') return jsonResponse({
        type: 'file', encoding: 'base64', path: 'README.md', sha: 'b'.repeat(40),
        size: 11, html_url: null, content: Buffer.from('PRIVATE-731').toString('base64'),
      })
      return new Response('{}', { status: 404 })
    })
    const connector = new GitHubConnector({ dataRoot: root, token: SYNTHETIC_TOKEN, apiBaseUrl: 'https://api.test', fetch: fetchImpl as typeof fetch })
    const execute = createGitHubAgentToolExecutor(connector)
    const context = { sessionId: 'ses_github', turnId: 'turn_github', stepId: 'step_github', signal: new AbortController().signal }
    try {
      expect(GITHUB_AGENT_TOOL_DEFINITIONS.map((definition) => definition.function.name)).toEqual([
        'github_list_repositories', 'github_list_branches', 'github_read_file',
      ])
      const listed = await execute({ id: 'call_repos', name: 'github_list_repositories', arguments: { limit: 10 } }, context)
      expect(JSON.parse(listed.content)).toMatchObject({ status: 'success', repos: [{ id: 17, private: true }] })
      const read = await execute({ id: 'call_read', name: 'github_read_file', arguments: { repo_id: 17, path: 'README.md' } }, context)
      expect(JSON.parse(read.content)).toMatchObject({
        status: 'success',
        repository: { id: 17, fullName: 'arena-labs/harness', private: true },
        branch: { name: 'main', commitSha: 'a'.repeat(40) },
        file: { path: 'README.md', blobSha: 'b'.repeat(40), content: 'PRIVATE-731' },
      })
      expect(`${listed.content}\n${read.content}`).not.toContain(SYNTHETIC_TOKEN)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('wires live GitHub connection state into Agent list-and-load without a service restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-agent-wiring-'))
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/repositories/17') return jsonResponse(repositoryPayload())
      if (url.pathname === '/repos/arena-labs/harness/branches/main') return jsonResponse({ name: 'main', commit: { sha: 'a'.repeat(40) } })
      if (url.pathname === '/repos/arena-labs/harness/contents/README.md') return jsonResponse({
        type: 'file', encoding: 'base64', path: 'README.md', sha: 'b'.repeat(40),
        size: 20, html_url: null, content: Buffer.from('AGENT-GITHUB-OK-731\n').toString('base64'),
      })
      return new Response('{}', { status: 404 })
    })
    const connector = new GitHubConnector({ dataRoot: root, token: SYNTHETIC_TOKEN, apiBaseUrl: 'https://api.test', fetch: fetchImpl as typeof fetch })
    let modelCall = 0
    const observedToolNames: string[][] = []
    const observedSystemPrompts: string[] = []
    const stream = vi.fn(async (options: {
      messages: Array<{ role: string; content?: string | null }>
      tools: Array<{ function: { name: string } }>
      onContent: (delta: string) => void
    }) => {
      modelCall += 1
      observedToolNames.push(options.tools.map((tool) => tool.function.name))
      observedSystemPrompts.push(String(options.messages[0]?.content || ''))
      if (modelCall === 1) {
        expect(observedToolNames[0]).not.toContain('github_read_file')
        expect(observedSystemPrompts[0]).toContain('The user turned these apps on for this conversation: github.')
        return modelToolCall('call_list_real_github', 'list_connector_tools', { service: 'github' })
      }
      if (modelCall === 2) {
        expect(observedToolNames[1]).toEqual(expect.arrayContaining([
          'github_list_repositories', 'github_list_branches', 'github_read_file',
        ]))
        expect(options.messages.findLast((message) => message.role === 'tool')?.content).toContain('github_read_file')
        return modelToolCall('call_read_real_github', 'github_read_file', { repo_id: 17, path: 'README.md' })
      }
      if (modelCall === 3) {
        expect(options.messages.findLast((message) => message.role === 'tool')?.content).toContain('AGENT-GITHUB-OK-731')
        options.onContent('GitHub connector verified.')
        return modelFinal('GitHub connector verified.')
      }
      expect(observedToolNames.at(-1)).not.toContain('github_read_file')
      expect(observedSystemPrompts.at(-1)).not.toContain('Enabled for this conversation: github')
      options.onContent('Disconnected state verified.')
      return modelFinal('Disconnected state verified.')
    })
    const created = await createApp({
      dataRoot: resolve(root, 'data'),
      model: 'test-model',
      agent: { client: { stream } as never, runTimeoutMs: 1_000 },
      github: { connector },
    })
    try {
      const connectedSession = await created.store.create()
      await created.agent.submit(connectedSession.summary.id, { content: 'Use the connected GitHub repository and read README.md.' })
      await waitForSessionStatus(created.store, connectedSession.summary.id, 'completed')
      expect((await created.store.events(connectedSession.summary.id)).filter((event) => event.type === 'tool.completed').map((event) => (
        event.data as { call: { name: string } }
      ).call.name)).toEqual(['list_connector_tools', 'github_read_file'])

      await connector.disconnect()
      const disconnectedSession = await created.store.create()
      await created.agent.submit(disconnectedSession.summary.id, { content: 'Confirm the disconnected state without tools.' })
      await waitForSessionStatus(created.store, disconnectedSession.summary.id, 'completed')
      expect(modelCall).toBe(4)
    } finally {
      await created.agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Coding GitHub remote command broker', () => {
  const repository = {
    provider: 'github' as const,
    repoId: 17,
    fullName: 'arena-labs/harness',
    ownerLogin: 'arena-labs',
    name: 'harness',
    baseBranch: 'main',
    baseCommitSha: 'a'.repeat(40),
    arenaBranch: 'arena/0123456789abcdef0123',
    cwd: '/home/user',
    private: true,
    importedAt: '2026-08-30T00:00:00.000Z',
  }

  it('reconstructs only the exact session-branch push and grants a revocable credential lease', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-command-broker-'))
    const workspace = resolve(root, 'workspace')
    await mkdir(resolve(workspace, '.git'), { recursive: true })
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN })
    const broker = createGitHubCodingShellCommandBroker(connector)
    const signal = new AbortController().signal
    try {
      const local = await broker({
        requestedCommand: 'git status --short', workspace, repository, codingSessionStatus: 'active', signal,
      })
      expect(local).toEqual({ kind: 'passthrough' })

      const decision = await broker({
        requestedCommand: `  git   push  origin  ${repository.arenaBranch}  `,
        workspace,
        repository,
        codingSessionStatus: 'active',
        signal,
      })
      expect(decision.kind).toBe('authorized')
      if (decision.kind !== 'authorized') throw new Error('Expected an authorized push')
      expect(decision.command).toBe([
        'git',
        '-c core.hooksPath=/dev/null',
        '-c core.fsmonitor=false',
        '-c credential.helper=',
        '-c http.proxy=',
        'push --no-verify --',
        'https://github.com/arena-labs/harness.git',
        `refs/heads/${repository.arenaBranch}:refs/heads/${repository.arenaBranch}`,
      ].join(' '))
      expect(decision.environment).toMatchObject({
        GIT_TERMINAL_PROMPT: '0',
        ANERA_GITHUB_ASKPASS_TOKEN: SYNTHETIC_TOKEN,
      })
      expect(String(decision.environment.GIT_ASKPASS).startsWith(resolve(workspace, '.git', 'anera-askpass-'))).toBe(true)
      expect(decision.environment.GIT_ASKPASS).toMatch(/anera-askpass-[a-f0-9]{20}\.sh$/)
      expect(await readFile(String(decision.environment.GIT_ASKPASS), 'utf8')).not.toContain(SYNTHETIC_TOKEN)
      expect(decision.signal.aborted).toBe(false)
      decision.release()
      expect(decision.signal.aborted).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('scopes PR creation and read commands to the trusted repository, base, and session branch', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-pr-broker-'))
    const workspace = resolve(root, 'workspace')
    await mkdir(resolve(workspace, '.git'), { recursive: true })
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN })
    const broker = createGitHubCodingShellCommandBroker(connector)
    const signal = new AbortController().signal
    try {
      const created = await broker({
        requestedCommand: "gh pr create --title \"Fix O'Brien's parser\" --body 'Handles $literal; safely' --draft --label bug --reviewer arena-labs/reviewers",
        workspace,
        repository,
        codingSessionStatus: 'active',
        signal,
      })
      expect(created.kind).toBe('authorized')
      if (created.kind !== 'authorized') throw new Error('Expected an authorized PR create')
      expect(created.command).toContain("'gh' 'pr' 'create' '--repo' 'arena-labs/harness' '--base' 'main'")
      expect(created.command).toContain(`'--head' '${repository.arenaBranch}'`)
      expect(created.command).toContain(`'--title=Fix O'\"'\"'Brien'\"'\"'s parser'`)
      expect(created.command).toContain("'--body=Handles $literal; safely'")
      expect(created.command).not.toContain('--repo attacker')
      expect(created.environment).toMatchObject({
        GH_TOKEN: SYNTHETIC_TOKEN,
        GH_HOST: 'github.com',
        GH_PROMPT_DISABLED: '1',
        GH_PAGER: 'cat',
      })
      expect(created.environment).not.toHaveProperty('ANERA_GITHUB_ASKPASS_TOKEN')
      expect(created.codingSessionStatusOnSuccess).toBe('pr_open')
      created.release()

      const checks = await broker({
        requestedCommand: 'gh pr checks --json name,state,bucket --required --interval 15',
        workspace,
        repository,
        codingSessionStatus: 'pr_open',
        signal,
      })
      expect(checks.kind).toBe('authorized')
      if (checks.kind !== 'authorized') throw new Error('Expected authorized PR checks')
      expect(checks.command).toContain(`'gh' 'pr' 'checks' '${repository.arenaBranch}' '--repo' 'arena-labs/harness'`)
      expect(checks.command).toContain("'--json=name,state,bucket' '--required' '--interval=15'")
      expect(checks.codingSessionStatusOnSuccess).toBeUndefined()
      checks.release()

      for (const requestedCommand of [
        'gh pr status --conflict-status --json number,title,url',
        'gh pr view --comments --json number,title,state,url',
        'gh pr diff --name-only --exclude generated/*',
        'gh pr list --state all --limit 25 --head arena/other-read-filter',
      ]) {
        const decision = await broker({ requestedCommand, workspace, repository, codingSessionStatus: 'pr_open', signal })
        expect(decision.kind).toBe('authorized')
        if (decision.kind === 'authorized') {
          expect(decision.command).toContain("'--repo' 'arena-labs/harness'")
          decision.release()
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('scopes issue, workflow-check, workflow, and release-read commands to the trusted repository and session branch', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-coding-operations-'))
    const workspace = resolve(root, 'workspace')
    await mkdir(resolve(workspace, '.git'), { recursive: true })
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN })
    const broker = createGitHubCodingShellCommandBroker(connector)
    const signal = new AbortController().signal
    try {
      const issue = await broker({
        requestedCommand: 'gh issue create --title "Bug in O\'Brien parser" --body \'Keep $literal; text\' --label bug --assignee @me',
        workspace,
        repository,
        codingSessionStatus: 'active',
        signal,
      })
      expect(issue.kind).toBe('authorized')
      if (issue.kind !== 'authorized') throw new Error('Expected an authorized issue create')
      expect(issue.command).toContain("'gh' 'issue' 'create' '--repo' 'arena-labs/harness'")
      expect(issue.command).toContain("'--title=Bug in O'\"'\"'Brien parser'")
      expect(issue.command).toContain("'--body=Keep $literal; text'")
      expect(issue.environment).toMatchObject({ GH_TOKEN: SYNTHETIC_TOKEN, GH_HOST: 'github.com' })
      expect(issue.codingSessionStatusOnSuccess).toBeUndefined()
      issue.release()

      const flagLikeValue = await broker({
        requestedCommand: 'gh issue create --title=--repo --body safe',
        workspace,
        repository,
        codingSessionStatus: 'active',
        signal,
      })
      expect(flagLikeValue.kind).toBe('authorized')
      if (flagLikeValue.kind !== 'authorized') throw new Error('Expected a safely encoded flag-like value')
      expect(flagLikeValue.command).toContain("'--title=--repo'")
      expect(flagLikeValue.command.match(/'--repo'/g)).toHaveLength(1)
      flagLikeValue.release()

      const commands: Array<[requestedCommand: string, expected: string[]]> = [
        ['gh issue status --json number,title,state,url', ["'gh' 'issue' 'status' '--repo' 'arena-labs/harness'"]],
        ['gh issue list --state all --limit 25 --label bug', ["'gh' 'issue' 'list' '--repo' 'arena-labs/harness'", "'--state=all' '--limit=25'"]],
        ['gh issue view 42 --comments --json number,title,state,url', ["'gh' 'issue' 'view' '42' '--repo' 'arena-labs/harness'"]],
        ['gh run list --status failure --limit 10 --json databaseId,headBranch,status', ["'gh' 'run' 'list' '--repo' 'arena-labs/harness'", `'--branch' '${repository.arenaBranch}'`]],
        ['gh run view 12345 --attempt 2 --log-failed', ["'gh' 'run' 'view' '12345' '--repo' 'arena-labs/harness'", "'--attempt=2' '--log-failed'"]],
        ['gh run watch 12345 --compact --exit-status --interval 5', ["'gh' 'run' 'watch' '12345' '--repo' 'arena-labs/harness'", "'--compact' '--exit-status' '--interval=5'"]],
        ['gh workflow list --all --limit 20', ["'gh' 'workflow' 'list' '--repo' 'arena-labs/harness'", "'--all' '--limit=20'"]],
        ['gh workflow view .github/workflows/ci.yml --yaml', ["'gh' 'workflow' 'view' '.github/workflows/ci.yml' '--repo' 'arena-labs/harness'", `'--ref' '${repository.arenaBranch}' '--yaml'`]],
        ['gh release list --exclude-drafts --order desc --limit 25', ["'gh' 'release' 'list' '--repo' 'arena-labs/harness'", "'--order=desc' '--limit=25'"]],
        ['gh release view v1.2.3 --json tagName,url', ["'gh' 'release' 'view' 'v1.2.3' '--repo' 'arena-labs/harness'", "'--json=tagName,url'"]],
      ]
      for (const [requestedCommand, expected] of commands) {
        const decision = await broker({ requestedCommand, workspace, repository, codingSessionStatus: 'pr_open', signal })
        expect(decision.kind).toBe('authorized')
        if (decision.kind === 'authorized') {
          for (const fragment of expected) expect(decision.command).toContain(fragment)
          expect(decision.environment).toMatchObject({ GH_TOKEN: SYNTHETIC_TOKEN, GH_HOST: 'github.com' })
          decision.release()
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires approval before credential access for high-impact GitHub mutations and rebuilds them after approval', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-approved-mutations-'))
    const workspace = resolve(root, 'workspace')
    await mkdir(resolve(workspace, '.git'), { recursive: true })
    await mkdir(resolve(workspace, 'dist'), { recursive: true })
    await writeFile(resolve(workspace, 'dist', 'app.zip'), 'release-asset-bytes\n')
    await writeFile(resolve(workspace, 'dist', 'checksums.txt'), 'sha256  app.zip\n')
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN })
    const acquire = vi.spyOn(connector, 'acquireCredentialLease')
    const broker = createGitHubCodingShellCommandBroker(connector)
    const signal = new AbortController().signal
    const mutations: Array<{
      command: string
      expected: string[]
      status?: 'pr_open' | 'closed'
      stagedAssets?: Array<{ position: number; name: string; content: string }>
    }> = [
      { command: `gh pr merge --squash --match-head-commit ${'a'.repeat(40)}`, expected: ["'gh' 'pr' 'merge'", "'--squash'", `'--match-head-commit=${'a'.repeat(40)}'`], status: 'closed' },
      { command: 'gh pr edit --title "Updated parser" --add-label bug', expected: ["'gh' 'pr' 'edit'", "'--title=Updated parser'", "'--add-label=bug'"] },
      { command: 'gh pr close --comment "Superseded"', expected: ["'gh' 'pr' 'close'", "'--comment=Superseded'"], status: 'closed' },
      { command: 'gh pr reopen', expected: ["'gh' 'pr' 'reopen'"], status: 'pr_open' },
      { command: 'gh pr comment --body "CI is green."', expected: ["'gh' 'pr' 'comment'", "'--body=CI is green.'"] },
      { command: 'gh pr review --request-changes --body "Please add coverage."', expected: ["'gh' 'pr' 'review'", "'--request-changes'", "'--body=Please add coverage.'"] },
      { command: 'gh issue edit 42 --title "Updated issue" --add-label bug', expected: ["'gh' 'issue' 'edit' '42'", "'--title=Updated issue'"] },
      { command: 'gh issue close 42 --reason "not planned" --comment "Closing."', expected: ["'gh' 'issue' 'close' '42'", "'--reason=not planned'"] },
      { command: 'gh issue reopen 42', expected: ["'gh' 'issue' 'reopen' '42'"] },
      { command: 'gh issue comment 42 --body "Investigating."', expected: ["'gh' 'issue' 'comment' '42'", "'--body=Investigating.'"] },
      { command: 'gh run rerun 12345 --failed', expected: ["'gh' 'run' 'rerun' '12345'", "'--failed'"] },
      { command: 'gh run cancel 12345 --force', expected: ["'gh' 'run' 'cancel' '12345'", "'--force'"] },
      { command: 'gh run delete 12345', expected: ["'gh' 'run' 'delete' '12345'"] },
      { command: 'gh workflow run .github/workflows/ci.yml --raw-field environment=staging', expected: ["'gh' 'workflow' 'run' '.github/workflows/ci.yml'", `'--ref' '${repository.arenaBranch}'`, "'--raw-field=environment=staging'"] },
      { command: 'gh workflow enable .github/workflows/ci.yml', expected: ["'gh' 'workflow' 'enable' '.github/workflows/ci.yml'"] },
      { command: 'gh workflow disable .github/workflows/ci.yml', expected: ["'gh' 'workflow' 'disable' '.github/workflows/ci.yml'"] },
      { command: 'gh release create v1.2.3 --generate-notes --draft', expected: ["'gh' 'release' 'create' 'v1.2.3'", `'--target' '${repository.arenaBranch}'`, "'--generate-notes' '--draft'"] },
      {
        command: 'gh release create v1.2.4 dist/app.zip --generate-notes --draft dist/checksums.txt',
        expected: ["'gh' 'release' 'create' 'v1.2.4'", `'--target' '${repository.arenaBranch}'`, "'--generate-notes' '--draft'"],
        stagedAssets: [
          { position: 1, name: 'app.zip', content: 'release-asset-bytes\n' },
          { position: 2, name: 'checksums.txt', content: 'sha256  app.zip\n' },
        ],
      },
      {
        command: 'gh release upload v1.2.3 dist/app.zip --clobber',
        expected: ["'gh' 'release' 'upload' 'v1.2.3'", "'--clobber'"],
        stagedAssets: [{ position: 1, name: 'app.zip', content: 'release-asset-bytes\n' }],
      },
      { command: 'gh release edit v1.2.3 --title "Updated release"', expected: ["'gh' 'release' 'edit' 'v1.2.3'", "'--title=Updated release'"] },
      { command: 'gh release delete v1.2.3', expected: ["'gh' 'release' 'delete' 'v1.2.3'", "'--yes'"] },
    ]
    try {
      for (const mutation of mutations) {
        const decision = await broker({
          requestedCommand: mutation.command,
          workspace,
          repository,
          codingSessionStatus: 'pr_open',
          signal,
        })
        expect(decision, mutation.command).toMatchObject({
          kind: 'approval_required',
          presentation: { title: expect.stringContaining('Approve'), description: expect.stringContaining('arena-labs/harness') },
        })
      }
      expect(acquire).not.toHaveBeenCalled()
      await expect(lstat(resolve(workspace, '.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })

      for (const mutation of mutations) {
        const decision = await broker({
          requestedCommand: mutation.command,
          workspace,
          repository,
          codingSessionStatus: 'pr_open',
          signal,
          approved: true,
        })
        expect(decision.kind).toBe('authorized')
        if (decision.kind === 'authorized') {
          expect(decision.command).toContain("'--repo' 'arena-labs/harness'")
          for (const fragment of mutation.expected) expect(decision.command).toContain(fragment)
          for (const asset of mutation.stagedAssets ?? []) {
            const pattern = new RegExp(`'([^']*\\.tmp/github-release-[^']+/${String(asset.position).padStart(2, '0')}/${asset.name.replace('.', '\\.')})'`)
            const stagedPath = decision.command.match(pattern)?.[1]
            expect(stagedPath, decision.command).toBeTruthy()
            expect(decision.command).not.toContain(`'dist/${asset.name}'`)
            expect(await readFile(resolve(workspace, stagedPath as string), 'utf8')).toBe(asset.content)
          }
          expect(decision.codingSessionStatusOnSuccess).toBe(mutation.status)
          expect(decision.environment).toMatchObject({ GH_TOKEN: SYNTHETIC_TOKEN, GH_HOST: 'github.com' })
          decision.release()
        }
      }
      expect(acquire).toHaveBeenCalledTimes(mutations.length)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows only an approval-gated fixed-branch PR reopen after closure and keeps merged sessions sealed', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-closed-pr-reopen-'))
    const workspace = resolve(root, 'workspace')
    await mkdir(resolve(workspace, '.git'), { recursive: true })
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN })
    const acquire = vi.spyOn(connector, 'acquireCredentialLease')
    const broker = createGitHubCodingShellCommandBroker(connector)
    const signal = new AbortController().signal
    try {
      const approval = await broker({
        requestedCommand: 'gh pr reopen --comment "Resuming the fixed branch"',
        workspace,
        repository,
        codingSessionStatus: 'closed',
        signal,
      })
      expect(approval).toMatchObject({
        kind: 'approval_required',
        presentation: {
          title: 'Approve pull request reopening?',
          description: expect.stringContaining(repository.arenaBranch),
        },
      })
      expect(acquire).not.toHaveBeenCalled()

      const authorized = await broker({
        requestedCommand: 'gh pr reopen --comment "Resuming the fixed branch"',
        workspace,
        repository,
        codingSessionStatus: 'closed',
        signal,
        approved: true,
      })
      expect(authorized.kind).toBe('authorized')
      if (authorized.kind !== 'authorized') throw new Error('Expected an authorized closed-session PR reopen')
      expect(authorized.command).toBe([
        'gh', 'pr', 'reopen', repository.arenaBranch, '--repo', repository.fullName,
        '--comment=Resuming the fixed branch',
      ].map((argument) => `'${argument}'`).join(' '))
      expect(authorized.codingSessionStatusOnSuccess).toBe('pr_open')
      expect(authorized.environment).toMatchObject({ GH_TOKEN: SYNTHETIC_TOKEN, GH_HOST: 'github.com' })
      authorized.release()

      for (const requestedCommand of [
        `git push origin ${repository.arenaBranch}`,
        'gh pr view --json number,state',
        'gh pr comment --body "Still closed"',
        'gh pr reopen --repo attacker/project',
        'gh pr reopen 42',
        'gh issue list --state open',
        'gh workflow run .github/workflows/ci.yml',
        'gh release list',
      ]) {
        await expect(broker({
          requestedCommand, workspace, repository, codingSessionStatus: 'closed', signal,
        }), requestedCommand).resolves.toMatchObject({ kind: 'rejected', message: expect.stringContaining('closed') })
      }
      await expect(broker({
        requestedCommand: 'gh pr reopen', workspace, repository, codingSessionStatus: 'pr_merged', signal,
      })).resolves.toMatchObject({ kind: 'rejected', message: expect.stringContaining('merged') })
      expect(acquire).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('derives merged, closed, and still-open session states from the exact trusted pull-request oracle', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-pr-state-oracle-'))
    const workspace = resolve(root, 'workspace')
    await mkdir(resolve(workspace, '.git'), { recursive: true })
    let remoteState: 'merged' | 'closed' | 'open' = 'merged'
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/repos/arena-labs/harness/pulls')
      expect(url.searchParams.get('head')).toBe(`arena-labs:${repository.arenaBranch}`)
      expect(url.searchParams.get('base')).toBe('main')
      expect(url.searchParams.get('state')).toBe('all')
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SYNTHETIC_TOKEN}`)
      return jsonResponse([
        {
          state: 'closed', merged_at: '2026-08-30T00:00:00.000Z',
          head: { ref: 'attacker-branch', repo: { full_name: 'attacker/project' } }, base: { ref: 'main' },
        },
        {
          state: remoteState === 'open' ? 'open' : 'closed',
          merged_at: remoteState === 'merged' ? '2026-08-30T00:00:00.000Z' : null,
          head: { ref: repository.arenaBranch, repo: { full_name: repository.fullName } },
          base: { ref: repository.baseBranch },
        },
      ])
    })
    const connector = new GitHubConnector({
      dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN,
      apiBaseUrl: 'https://api.test', fetch: fetchImpl as typeof fetch,
    })
    const broker = createGitHubCodingShellCommandBroker(connector)
    const signal = new AbortController().signal
    try {
      for (const [state, expected] of [
        ['merged', 'pr_merged'], ['closed', 'closed'], ['open', 'pr_open'],
      ] as const) {
        remoteState = state
        const decision = await broker({
          requestedCommand: 'gh pr merge --squash', workspace, repository,
          codingSessionStatus: 'pr_open', signal, approved: true,
        })
        expect(decision).toMatchObject({ kind: 'authorized', codingSessionStatusOnSuccess: 'closed' })
        if (decision.kind !== 'authorized') throw new Error('Expected authorized merge')
        expect(await decision.resolveCodingSessionStatusOnSuccess?.()).toBe(expected)
        decision.release()
      }
      expect(fetchImpl).toHaveBeenCalledTimes(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('revalidates release assets after approval and rejects host paths, symlinks, directories, labels, and globs without credentials', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-release-assets-'))
    const workspace = resolve(root, 'workspace')
    const outside = resolve(root, 'outside-secret.txt')
    await mkdir(resolve(workspace, '.git'), { recursive: true })
    await mkdir(resolve(workspace, 'dist'), { recursive: true })
    await writeFile(resolve(workspace, 'dist', 'app.zip'), 'approved-version\n')
    await writeFile(outside, 'outside-secret\n')
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN })
    const acquire = vi.spyOn(connector, 'acquireCredentialLease')
    const broker = createGitHubCodingShellCommandBroker(connector)
    const signal = new AbortController().signal
    const command = 'gh release upload v1.2.3 dist/app.zip'
    try {
      await expect(broker({
        requestedCommand: command, workspace, repository, codingSessionStatus: 'pr_open', signal,
      })).resolves.toMatchObject({
        kind: 'approval_required',
        presentation: {
          title: 'Approve release asset upload?',
          description: expect.stringContaining('1 workspace asset (app.zip)'),
        },
      })
      expect(acquire).not.toHaveBeenCalled()
      await rm(resolve(workspace, 'dist', 'app.zip'))
      await symlink(outside, resolve(workspace, 'dist', 'app.zip'))
      await expect(broker({
        requestedCommand: command, workspace, repository, codingSessionStatus: 'pr_open', signal, approved: true,
      })).resolves.toMatchObject({ kind: 'rejected' })

      for (const requestedCommand of [
        'gh release upload v1.2.3',
        'gh release upload v1.2.3 /etc/passwd',
        'gh release upload v1.2.3 ../outside-secret.txt',
        'gh release upload v1.2.3 dist/*.zip',
        'gh release upload v1.2.3 dist/app.zip#Installer',
        'gh release upload v1.2.3 .git/config',
        'gh release upload v1.2.3 dist',
        `gh release upload v1.2.3 ${Array.from({ length: 17 }, (_, index) => `dist/asset-${index}.zip`).join(' ')}`,
        'gh release upload v1.2.3 one/app.zip two/app.zip',
        'gh release create v1.2.4 missing.zip --generate-notes',
      ]) {
        await expect(broker({
          requestedCommand, workspace, repository, codingSessionStatus: 'pr_open', signal,
        }), requestedCommand).resolves.toMatchObject({ kind: 'rejected' })
      }
      expect(acquire).not.toHaveBeenCalled()
      await expect(lstat(resolve(workspace, '.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects alternate remotes, branches, shell composition, remote gh, and closed sessions before credential access', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-command-rejections-'))
    const workspace = resolve(root, 'workspace')
    await mkdir(resolve(workspace, '.git'), { recursive: true })
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN })
    const acquire = vi.spyOn(connector, 'acquireCredentialLease')
    const broker = createGitHubCodingShellCommandBroker(connector)
    const signal = new AbortController().signal
    try {
      for (const requestedCommand of [
        `git push upstream ${repository.arenaBranch}`,
        'git push origin main',
        `git push --set-upstream origin ${repository.arenaBranch}`,
        `git push origin ${repository.arenaBranch}; printenv`,
        'git fetch origin',
        'gh auth token',
        `gh pr create --head ${repository.arenaBranch}`,
        'gh pr create --title "$(printenv)" --body safe',
        'gh pr create --title safe --body safe; printenv',
        'gh pr create --repo attacker/project --title safe --body safe',
        'gh pr create --base other --title safe --body safe',
        'gh pr view 123',
        'gh pr checks --interval 0',
        'gh pr list --limit 101',
        'gh pr merge --admin --squash',
        'gh pr merge',
        'gh issue create --title safe',
        `gh issue create --title safe --body ${'x'.repeat(64_001)}`,
        `gh issue create --title safe --body safe ${Array.from({ length: 260 }, (_, index) => `--label l${index}`).join(' ')}`,
        'gh issue create --repo attacker/project --title safe --body safe',
        'gh issue view 0',
        'gh issue view https://github.com/arena-labs/harness/issues/42',
        'gh issue list --limit 101',
        'gh issue list --state merged',
        'gh issue close https://github.com/arena-labs/harness/issues/42',
        'gh issue comment 42',
        'gh run list --branch main',
        'gh run view 0',
        'gh run view 12345 --attempt 0',
        'gh run view 12345 --job not-a-number',
        'gh run rerun 12345 --job invalid',
        'gh run cancel 12345 --repo attacker/project',
        'gh workflow view',
        'gh workflow view ci.yml --ref main',
        'gh workflow run ci.yml --field @payload.json',
        'gh release list --limit 101',
        'gh release list --order newest',
        'gh release view v1.2.3 --web',
        'gh release create v1.2.3 --notes-file RELEASE.md',
        'gh release delete v1.2.3 --cleanup-tag',
        'gh api /user',
        'gh extension install attacker/tool',
      ]) {
        await expect(broker({
          requestedCommand, workspace, repository, codingSessionStatus: 'active', signal,
        })).resolves.toMatchObject({ kind: 'rejected' })
      }
      await expect(broker({
        requestedCommand: `git push origin ${repository.arenaBranch}`,
        workspace,
        repository,
        codingSessionStatus: 'pr_merged',
        signal,
      })).resolves.toMatchObject({ kind: 'rejected', message: expect.stringContaining('merged') })
      expect(acquire).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('revokes an in-flight command lease and rejects new leases on disconnect', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-command-disconnect-'))
    const workspace = resolve(root, 'workspace')
    await mkdir(resolve(workspace, '.git'), { recursive: true })
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN })
    const broker = createGitHubCodingShellCommandBroker(connector)
    const signal = new AbortController().signal
    try {
      const decision = await broker({
        requestedCommand: `git push origin ${repository.arenaBranch}`,
        workspace,
        repository,
        codingSessionStatus: 'active',
        signal,
      })
      if (decision.kind !== 'authorized') throw new Error('Expected an authorized push')
      await connector.disconnect()
      expect(decision.signal.aborted).toBe(true)
      await expect(broker({
        requestedCommand: `git push origin ${repository.arenaBranch}`,
        workspace,
        repository,
        codingSessionStatus: 'active',
        signal,
      })).rejects.toMatchObject<Partial<GitHubConnectorError>>({ code: 'not_connected' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('GitHub repository bootstrap', () => {
  it('passes the token only through askpass environment and imports an exact bounded checkout', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-bootstrap-'))
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
    const run = vi.fn(async (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: options.env })
      if (args.includes('clone')) {
        const checkout = args.at(-1) as string
        await mkdir(resolve(checkout, '.git'), { recursive: true })
        await mkdir(resolve(checkout, 'src'), { recursive: true })
        await writeFile(resolve(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
        await writeFile(resolve(checkout, 'src', 'index.ts'), 'export const ready = true\n')
        return { stdout: '', stderr: '' }
      }
      if (args.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      if (args.includes('checkout')) return { stdout: '', stderr: '' }
      if (args.includes('ls-files')) return { stdout: `100644 ${'b'.repeat(40)} 0\tsrc/index.ts\n`, stderr: '' }
      throw new Error('Unexpected git command')
    })
    const bootstrapper = new GitHubRepositoryBootstrapper({ dataRoot: root, run: run as never })
    try {
      const prepared = await bootstrapper.prepare({ repo: mappedRepository(), branch: { name: 'main', commitSha: 'a'.repeat(40) }, token: SYNTHETIC_TOKEN })
      expect(await readFile(resolve(prepared.checkoutDir, 'src', 'index.ts'), 'utf8')).toBe('export const ready = true\n')
      expect(prepared.workspaceBytes).toBe(Buffer.byteLength('export const ready = true\n'))
      expect(prepared.repository).toMatchObject({
        fullName: 'arena-labs/harness',
        baseBranch: 'main',
        baseCommitSha: 'a'.repeat(40),
        arenaBranch: expect.stringMatching(/^arena\/[a-f0-9]{20}$/),
        cwd: '/home/user',
      })
      expect(calls.find((call) => call.args.includes('checkout'))?.args).toEqual([
        '-C', prepared.checkoutDir, 'checkout', '--no-track', '-b', prepared.repository.arenaBranch,
      ])
      expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(SYNTHETIC_TOKEN)
      expect(calls[0].env.ANERA_GITHUB_ASKPASS_TOKEN).toBe(SYNTHETIC_TOKEN)
      expect(calls.slice(1).every((call) => !call.env.ANERA_GITHUB_ASKPASS_TOKEN)).toBe(true)
      await prepared.cleanup()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['symlink', async (checkout: string) => { await symlink('/tmp', resolve(checkout, 'unsafe-link')) }],
    ['oversized file', async (checkout: string) => { await writeFile(resolve(checkout, 'large.bin'), Buffer.alloc(33)) }],
  ])('rejects an unsafe %s checkout', async (_label, mutate) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-unsafe-'))
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('clone')) {
        const checkout = args.at(-1) as string
        await mkdir(resolve(checkout, '.git'), { recursive: true })
        await writeFile(resolve(checkout, 'safe.txt'), 'safe\n')
        await mutate(checkout)
        return { stdout: '', stderr: '' }
      }
      if (args.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      if (args.includes('checkout')) return { stdout: '', stderr: '' }
      if (args.includes('ls-files')) return { stdout: `100644 ${'b'.repeat(40)} 0\tsafe.txt\n`, stderr: '' }
      throw new Error('Unexpected git command')
    })
    const bootstrapper = new GitHubRepositoryBootstrapper({ dataRoot: root, run: run as never, maxFileBytes: 32 })
    try {
      await expect(bootstrapper.prepare({ repo: mappedRepository(), branch: { name: 'main', commitSha: 'a'.repeat(40) }, token: SYNTHETIC_TOKEN })).rejects.toMatchObject<Partial<GitHubConnectorError>>({ code: 'repo_bootstrap_failed' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects Git symlink and submodule modes before the Agent can run', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-github-index-mode-'))
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('clone')) {
        const checkout = args.at(-1) as string
        await mkdir(resolve(checkout, '.git'), { recursive: true })
        await writeFile(resolve(checkout, 'safe.txt'), 'safe\n')
        return { stdout: '', stderr: '' }
      }
      if (args.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      if (args.includes('checkout')) return { stdout: '', stderr: '' }
      if (args.includes('ls-files')) return { stdout: `160000 ${'b'.repeat(40)} 0\tvendor/submodule\n`, stderr: '' }
      throw new Error('Unexpected git command')
    })
    try {
      const bootstrapper = new GitHubRepositoryBootstrapper({ dataRoot: root, run: run as never })
      await expect(bootstrapper.prepare({ repo: mappedRepository(), branch: { name: 'main', commitSha: 'a'.repeat(40) }, token: SYNTHETIC_TOKEN })).rejects.toMatchObject({ code: 'repo_bootstrap_failed' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('coding session API', () => {
  it('wires push, PR, issue, and workflow-check operations through Agent execution without exposing the credential', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-coding-push-agent-'))
    const arenaBranch = 'arena/0123456789abcdef0123'
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN })
    const remoteRuns: Array<Record<string, unknown>> = []
    const runCommand = vi.fn(async (options: {
      command: string
      allowNetwork?: boolean
      environment?: NodeJS.ProcessEnv
      onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void
    }) => {
      remoteRuns.push(options as unknown as Record<string, unknown>)
      const stdout = options.command.includes("'gh' 'pr' 'create'")
        ? `https://github.com/arena-labs/harness/pull/42 token=${SYNTHETIC_TOKEN}\n`
        : options.command.includes("'gh' 'issue' 'create'")
          ? `https://github.com/arena-labs/harness/issues/7 token=${SYNTHETIC_TOKEN}\n`
          : options.command.includes("'gh' 'run' 'list'")
            ? `[{"databaseId":12345,"headBranch":"${arenaBranch}","status":"completed"}] token=${SYNTHETIC_TOKEN}\n`
            : `remote accepted token=${SYNTHETIC_TOKEN}\n`
      options.onOutput('stdout', stdout)
      return {
        stdout, stderr: '', exitCode: 0, signal: null, durationMs: 3,
        truncated: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      }
    })
    let modelCall = 0
    const providerTranscripts: ModelMessage[][] = []
    const stream = vi.fn(async (options: { messages: ModelMessage[]; onContent: (delta: string) => void }) => {
      modelCall += 1
      providerTranscripts.push(structuredClone(options.messages))
      if (modelCall === 1) {
        return {
          content: '', reasoningContent: '',
          toolCalls: [{
            id: 'call_agent_coding_push', type: 'function' as const,
            function: { name: 'bash', arguments: JSON.stringify({ command: `git push origin ${arenaBranch}` }) },
          }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 },
        }
      }
      expect(JSON.stringify(options.messages)).not.toContain(SYNTHETIC_TOKEN)
      expect(options.messages.findLast((message) => message.role === 'tool')?.content).toContain('[REDACTED_SECRET]')
      if (modelCall === 2) {
        return {
          content: '', reasoningContent: '',
          toolCalls: [{
            id: 'call_agent_pr_create', type: 'function' as const,
            function: {
              name: 'bash',
              arguments: JSON.stringify({ command: 'gh pr create --title "Fix parser" --body "Adds regression coverage."' }),
            },
          }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14, cachedPromptTokens: 0 },
        }
      }
      if (modelCall === 3) {
        expect(options.messages.findLast((message) => message.role === 'tool')?.content).toContain('/pull/42')
        return {
          content: '', reasoningContent: '',
          toolCalls: [{
            id: 'call_agent_issue_create', type: 'function' as const,
            function: {
              name: 'bash',
              arguments: JSON.stringify({ command: 'gh issue create --title "Follow-up parser edge case" --body "Tracks the remaining compatibility work." --label bug' }),
            },
          }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15, cachedPromptTokens: 0 },
        }
      }
      if (modelCall === 4) {
        expect(options.messages.findLast((message) => message.role === 'tool')?.content).toContain('/issues/7')
        return {
          content: '', reasoningContent: '',
          toolCalls: [{
            id: 'call_agent_run_list', type: 'function' as const,
            function: {
              name: 'bash',
              arguments: JSON.stringify({ command: 'gh run list --limit 10 --json databaseId,headBranch,status' }),
            },
          }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 13, completionTokens: 3, totalTokens: 16, cachedPromptTokens: 0 },
        }
      }
      expect(options.messages.findLast((message) => message.role === 'tool')?.content).toContain('databaseId')
      options.onContent('Pushed the fixed session branch, opened PR #42, filed issue #7, and inspected the branch workflow runs.')
      return {
        content: 'Pushed the fixed session branch, opened PR #42, filed issue #7, and inspected the branch workflow runs.', reasoningContent: '', toolCalls: [], finishReason: 'stop',
        usage: { promptTokens: 14, completionTokens: 5, totalTokens: 19, cachedPromptTokens: 0 },
      }
    })
    const created = await createApp({
      dataRoot: resolve(root, 'data'),
      model: 'test-model',
      github: { connector },
      agent: {
        client: { stream } as never,
        runTimeoutMs: 1_000,
        toolExecutorDependencies: { runCommand: runCommand as never },
      },
    })
    try {
      const session = await created.store.create({
        repository: {
          provider: 'github', repoId: 17, fullName: 'arena-labs/harness', ownerLogin: 'arena-labs', name: 'harness',
          baseBranch: 'main', baseCommitSha: 'a'.repeat(40), arenaBranch, cwd: '/home/user', private: true,
          importedAt: '2026-08-30T00:00:00.000Z',
        },
      })
      await mkdir(resolve(created.store.workspaceDir(session.summary.id), '.git'), { recursive: true })
      await created.agent.submit(session.summary.id, { content: 'Push the completed work, open a pull request, file the follow-up issue, and inspect workflow checks.' })
      await waitForSessionStatus(created.store, session.summary.id, 'completed')

      expect(remoteRuns).toHaveLength(4)
      expect(remoteRuns[0]).toMatchObject({
        command: expect.stringContaining(`refs/heads/${arenaBranch}:refs/heads/${arenaBranch}`),
        allowNetwork: true,
        environment: expect.objectContaining({ ANERA_GITHUB_ASKPASS_TOKEN: SYNTHETIC_TOKEN }),
      })
      expect(remoteRuns[1]).toMatchObject({
        command: expect.stringContaining("'gh' 'pr' 'create' '--repo' 'arena-labs/harness' '--base' 'main'"),
        allowNetwork: true,
        environment: expect.objectContaining({ GH_TOKEN: SYNTHETIC_TOKEN, GH_HOST: 'github.com' }),
      })
      expect(remoteRuns[2]).toMatchObject({
        command: expect.stringContaining("'gh' 'issue' 'create' '--repo' 'arena-labs/harness'"),
        allowNetwork: true,
        environment: expect.objectContaining({ GH_TOKEN: SYNTHETIC_TOKEN, GH_HOST: 'github.com' }),
      })
      expect(remoteRuns[3]).toMatchObject({
        command: expect.stringContaining(`'gh' 'run' 'list' '--repo' 'arena-labs/harness' '--branch' '${arenaBranch}'`),
        allowNetwork: true,
        environment: expect.objectContaining({ GH_TOKEN: SYNTHETIC_TOKEN, GH_HOST: 'github.com' }),
      })
      expect((await created.store.get(session.summary.id)).summary.codingSessionStatus).toBe('pr_open')
      const stateText = await readFile(resolve(root, 'data', 'sessions', session.summary.id, 'state.json'), 'utf8')
      const eventText = await readFile(resolve(root, 'data', 'sessions', session.summary.id, 'events.jsonl'), 'utf8')
      expect(`${stateText}\n${eventText}\n${JSON.stringify(providerTranscripts)}`).not.toContain(SYNTHETIC_TOKEN)
      expect(stateText).toContain('[REDACTED_SECRET]')
    } finally {
      await created.agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('pauses an Agent GitHub mutation before credentials, resumes after approval, and persists the closed status', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-coding-approved-mutation-agent-'))
    const arenaBranch = 'arena/0123456789abcdef0123'
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN })
    const acquire = vi.spyOn(connector, 'acquireCredentialLease')
    const runCommand = vi.fn(async (options: {
      command: string
      environment?: NodeJS.ProcessEnv
      onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void
    }) => {
      const stdout = `Closed pull request token=${SYNTHETIC_TOKEN}\n`
      options.onOutput('stdout', stdout)
      return {
        stdout, stderr: '', exitCode: 0, signal: null, durationMs: 3,
        truncated: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      }
    })
    let modelCall = 0
    const transcripts: ModelMessage[][] = []
    const stream = vi.fn(async (options: { messages: ModelMessage[]; onContent: (delta: string) => void }) => {
      modelCall += 1
      transcripts.push(structuredClone(options.messages))
      expect(JSON.stringify(options.messages)).not.toContain(SYNTHETIC_TOKEN)
      if (modelCall === 1) {
        return {
          content: '', reasoningContent: '',
          toolCalls: [{
            id: 'call_agent_pr_close', type: 'function' as const,
            function: { name: 'bash', arguments: JSON.stringify({ command: 'gh pr close --comment "Superseded"' }) },
          }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 },
        }
      }
      expect(options.messages.findLast((message) => message.role === 'tool')?.content).toContain('[REDACTED_SECRET]')
      options.onContent('Closed the pull request after approval.')
      return {
        content: 'Closed the pull request after approval.', reasoningContent: '', toolCalls: [], finishReason: 'stop',
        usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14, cachedPromptTokens: 0 },
      }
    })
    const created = await createApp({
      dataRoot: resolve(root, 'data'),
      model: 'test-model',
      github: { connector },
      agent: {
        client: { stream } as never,
        runTimeoutMs: 1_000,
        toolExecutorDependencies: { runCommand: runCommand as never },
      },
    })
    try {
      const session = await created.store.create({
        repository: {
          provider: 'github', repoId: 17, fullName: 'arena-labs/harness', ownerLogin: 'arena-labs', name: 'harness',
          baseBranch: 'main', baseCommitSha: 'a'.repeat(40), arenaBranch, cwd: '/home/user', private: true,
          importedAt: '2026-08-30T00:00:00.000Z',
        },
      })
      await created.store.update(session.summary.id, (state) => { state.summary.codingSessionStatus = 'pr_open' })
      await mkdir(resolve(created.store.workspaceDir(session.summary.id), '.git'), { recursive: true })
      await created.agent.submit(session.summary.id, { content: 'Close the current pull request as superseded.' })
      let approvalId = ''
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const required = (await created.store.events(session.summary.id)).find((event) => event.type === 'approval.required')
        if (required) {
          approvalId = String(required.data.approvalId || '')
          break
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect(approvalId).not.toBe('')
      expect(acquire).not.toHaveBeenCalled()
      expect(runCommand).not.toHaveBeenCalled()
      expect((await created.store.get(session.summary.id)).summary.status).toBe('awaiting_approval')
      expect((await created.store.events(session.summary.id)).find((event) => event.type === 'approval.required')).toMatchObject({
        data: {
          title: 'Approve pull request closure?',
          description: expect.stringContaining('arena-labs/harness'),
          call: { name: 'bash', arguments: { command: 'gh pr close --comment "Superseded"' } },
        },
      })

      await created.agent.resolveApproval(session.summary.id, approvalId, true)
      await waitForSessionStatus(created.store, session.summary.id, 'completed')
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: expect.stringContaining(`'gh' 'pr' 'close' '${arenaBranch}' '--repo' 'arena-labs/harness'`),
        allowNetwork: true,
        environment: expect.objectContaining({ GH_TOKEN: SYNTHETIC_TOKEN, GH_HOST: 'github.com' }),
      }))
      expect((await created.store.get(session.summary.id)).summary.codingSessionStatus).toBe('closed')
      const stateText = await readFile(resolve(root, 'data', 'sessions', session.summary.id, 'state.json'), 'utf8')
      const eventText = await readFile(resolve(root, 'data', 'sessions', session.summary.id, 'events.jsonl'), 'utf8')
      expect(`${stateText}\n${eventText}\n${JSON.stringify(transcripts)}`).not.toContain(SYNTHETIC_TOKEN)
    } finally {
      await created.agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uploads an immutable workspace release-asset snapshot only after durable approval', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-coding-release-upload-agent-'))
    const arenaBranch = 'arena/0123456789abcdef0123'
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token: SYNTHETIC_TOKEN })
    const acquire = vi.spyOn(connector, 'acquireCredentialLease')
    let stagedContent = ''
    let stagedPath = ''
    const runCommand = vi.fn(async (options: {
      command: string
      workspace: string
      environment?: NodeJS.ProcessEnv
      onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void
    }) => {
      stagedPath = options.command.match(/'([^']*\.tmp\/github-release-[^']+\/01\/app\.zip)'/)?.[1] ?? ''
      await writeFile(resolve(options.workspace, 'dist', 'app.zip'), 'release-snapshot-v2\n')
      stagedContent = await readFile(resolve(options.workspace, stagedPath), 'utf8')
      options.onOutput('stdout', 'Uploaded app.zip\n')
      return {
        stdout: 'Uploaded app.zip\n', stderr: '', exitCode: 0, signal: null, durationMs: 3,
        truncated: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      }
    })
    let modelCall = 0
    const stream = vi.fn(async (options: { messages: ModelMessage[]; onContent: (delta: string) => void }) => {
      modelCall += 1
      expect(JSON.stringify(options.messages)).not.toContain(SYNTHETIC_TOKEN)
      if (modelCall === 1) {
        return {
          content: '', reasoningContent: '',
          toolCalls: [{
            id: 'call_agent_release_upload', type: 'function' as const,
            function: { name: 'bash', arguments: JSON.stringify({ command: 'gh release upload v1.2.3 dist/app.zip --clobber' }) },
          }],
          finishReason: 'tool_calls',
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 },
        }
      }
      expect(options.messages.findLast((message) => message.role === 'tool')?.content).toContain('Uploaded app.zip')
      options.onContent('Uploaded the release asset after approval.')
      return {
        content: 'Uploaded the release asset after approval.', reasoningContent: '', toolCalls: [], finishReason: 'stop',
        usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14, cachedPromptTokens: 0 },
      }
    })
    const created = await createApp({
      dataRoot: resolve(root, 'data'),
      model: 'test-model',
      github: { connector },
      agent: {
        client: { stream } as never,
        runTimeoutMs: 1_000,
        toolExecutorDependencies: { runCommand: runCommand as never },
      },
    })
    try {
      const session = await created.store.create({
        repository: {
          provider: 'github', repoId: 17, fullName: 'arena-labs/harness', ownerLogin: 'arena-labs', name: 'harness',
          baseBranch: 'main', baseCommitSha: 'a'.repeat(40), arenaBranch, cwd: '/home/user', private: true,
          importedAt: '2026-08-30T00:00:00.000Z',
        },
      })
      await created.store.update(session.summary.id, (state) => { state.summary.codingSessionStatus = 'pr_open' })
      const workspace = created.store.workspaceDir(session.summary.id)
      await mkdir(resolve(workspace, '.git'), { recursive: true })
      await mkdir(resolve(workspace, 'dist'), { recursive: true })
      await writeFile(resolve(workspace, 'dist', 'app.zip'), 'release-snapshot-v1\n')
      await created.agent.submit(session.summary.id, { content: 'Upload dist/app.zip to release v1.2.3 and replace the existing asset.' })
      let approvalId = ''
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const required = (await created.store.events(session.summary.id)).find((event) => event.type === 'approval.required')
        if (required) {
          approvalId = String(required.data.approvalId || '')
          expect(required.data).toMatchObject({
            title: 'Approve release asset upload?',
            description: expect.stringContaining('1 workspace asset (app.zip)'),
          })
          break
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect(approvalId).not.toBe('')
      expect(acquire).not.toHaveBeenCalled()
      expect(runCommand).not.toHaveBeenCalled()
      await expect(lstat(resolve(workspace, '.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })

      await created.agent.resolveApproval(session.summary.id, approvalId, true)
      await waitForSessionStatus(created.store, session.summary.id, 'completed')
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
        command: expect.stringContaining("'gh' 'release' 'upload' 'v1.2.3'"),
        allowNetwork: true,
        environment: expect.objectContaining({ GH_TOKEN: SYNTHETIC_TOKEN, GH_HOST: 'github.com' }),
      }))
      expect(stagedPath).toContain('.tmp/github-release-')
      expect(stagedContent).toBe('release-snapshot-v1\n')
      expect(await readFile(resolve(workspace, 'dist', 'app.zip'), 'utf8')).toBe('release-snapshot-v2\n')
      expect(runCommand.mock.calls[0][0].command).not.toContain("'dist/app.zip'")
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await readdir(resolve(workspace, '.tmp'))).length === 0) break
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect(await readdir(resolve(workspace, '.tmp'))).toEqual([])
    } finally {
      await created.agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('bootstraps before session creation, persists repository metadata, and never copies the token into trace state', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-coding-api-'))
    const gitCalls: string[][] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      if (path === '/repositories/17') return jsonResponse(repositoryPayload())
      if (path === '/repos/arena-labs/harness/branches/main') return jsonResponse({ name: 'main', commit: { sha: 'a'.repeat(40) } })
      return new Response('{}', { status: 404 })
    })
    const connector = new GitHubConnector({ dataRoot: root, token: SYNTHETIC_TOKEN, apiBaseUrl: 'https://api.test', fetch: fetchImpl as typeof fetch })
    const run = vi.fn(async (args: string[]) => {
      gitCalls.push(args)
      if (args.includes('clone')) {
        const checkout = args.at(-1) as string
        await mkdir(resolve(checkout, '.git'), { recursive: true })
        await writeFile(resolve(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
        await writeFile(resolve(checkout, 'README.md'), '# Imported repository\n')
        return { stdout: '', stderr: '' }
      }
      if (args.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      if (args.includes('checkout')) return { stdout: '', stderr: '' }
      if (args.includes('ls-files')) return { stdout: `100644 ${'b'.repeat(40)} 0\tREADME.md\n`, stderr: '' }
      throw new Error('Unexpected git command')
    })
    const bootstrapper = new GitHubRepositoryBootstrapper({ dataRoot: root, run: run as never })
    let providerMessages: ModelMessage[] = []
    const stream = vi.fn(async (options: { messages: ModelMessage[]; onContent: (delta: string) => void }) => {
      providerMessages = options.messages
      options.onContent('Repository inspected.')
      return {
        content: 'Repository inspected.', reasoningContent: '', toolCalls: [], finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 },
      }
    })
    const created = await createApp({
      dataRoot: resolve(root, 'data'),
      model: 'test-model',
      agent: { client: { stream } as never },
      github: { connector, bootstrapper },
    })
    const server = createServer(created.app)
    try {
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not bind')
      const base = `http://127.0.0.1:${address.port}`
      const message = '  Fix the build.  \n'
      const response = await fetch(`${base}/api/coding-agent/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 17, repoOwner: 'arena-labs', repoName: 'harness', baseBranch: 'main', message }),
      })
      expect(response.status).toBe(201)
      const { sessionId } = await response.json() as { sessionId: string }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await created.store.get(sessionId)).summary.status === 'completed') break
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      const snapshot = await (await fetch(`${base}/api/sessions/${sessionId}`)).json() as Record<string, any>
      expect(snapshot).toMatchObject({
        session: { productMode: 'coding', codingSessionStatus: 'active', title: 'Fix the build.' },
        repository: {
          repoId: 17,
          fullName: 'arena-labs/harness',
          baseBranch: 'main',
          baseCommitSha: 'a'.repeat(40),
          arenaBranch: expect.stringMatching(/^arena\/[a-f0-9]{20}$/),
          cwd: '/home/user',
        },
        workspace: expect.arrayContaining([expect.objectContaining({ path: 'README.md', type: 'file' })]),
      })
      const stateText = await readFile(resolve(root, 'data', 'sessions', sessionId, 'state.json'), 'utf8')
      const eventText = await readFile(resolve(root, 'data', 'sessions', sessionId, 'events.jsonl'), 'utf8')
      expect(stateText).not.toContain('Trusted coding-session context')
      expect(providerMessages[0]).toMatchObject({ role: 'system' })
      expect(providerMessages[0].content).toContain("You are a coding agent running on Arena.ai's Agent Mode")
      expect(providerMessages[0].content).toContain('`arena-labs/harness` at `/home/user`')
      expect(providerMessages[0].content).toContain(`working branch \`${snapshot.repository.arenaBranch}\``)
      expect(providerMessages.at(-1)?.content).toBe(message)
      expect(eventText).toContain('"productMode":"coding"')
      expect((await created.store.events(sessionId)).find((event) => event.type === 'turn.started')?.data.content).toBe(message)
      expect(`${stateText}\n${eventText}\n${JSON.stringify(gitCalls)}\n${JSON.stringify(providerMessages)}`).not.toContain(SYNTHETIC_TOKEN)
    } finally {
      await created.agent.shutdown()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not create a pseudo session when repository bootstrap fails', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-coding-bootstrap-fail-'))
    const connector = new GitHubConnector({
      dataRoot: root,
      token: SYNTHETIC_TOKEN,
      apiBaseUrl: 'https://api.test',
      fetch: vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname
        if (path === '/repositories/17') return jsonResponse(repositoryPayload())
        if (path.endsWith('/branches/main')) return jsonResponse({ name: 'main', commit: { sha: 'a'.repeat(40) } })
        return new Response('{}', { status: 404 })
      }) as typeof fetch,
    })
    const bootstrapper = new GitHubRepositoryBootstrapper({ dataRoot: root, run: vi.fn(async () => { throw new Error('clone failed') }) as never })
    const created = await createApp({ dataRoot: resolve(root, 'data'), model: 'test-model', github: { connector, bootstrapper } })
    const server = createServer(created.app)
    try {
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not bind')
      const base = `http://127.0.0.1:${address.port}`
      const response = await fetch(`${base}/api/coding-agent/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoId: 17, repoOwner: 'arena-labs', repoName: 'harness', baseBranch: 'main', message: 'Do work.' }),
      })
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'repo_bootstrap_failed' })
      expect(await created.store.list()).toEqual([])
    } finally {
      await created.agent.shutdown()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await rm(root, { recursive: true, force: true })
    }
  })
})

function modelToolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    content: '', reasoningContent: '', finishReason: 'tool_calls',
    toolCalls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 },
    modelCallCount: 1,
  }
}

function modelFinal(content: string) {
  return {
    content, reasoningContent: '', finishReason: 'stop', toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 },
    modelCallCount: 1,
  }
}

async function waitForSessionStatus(
  store: Awaited<ReturnType<typeof createApp>>['store'],
  sessionId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await store.get(sessionId)).summary.status === status) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  throw new Error(`Session ${sessionId} did not reach ${status}`)
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function repositoryPayload(): Record<string, unknown> {
  return {
    id: 17,
    full_name: 'arena-labs/harness',
    name: 'harness',
    owner: { login: 'arena-labs', type: 'Organization' },
    default_branch: 'main',
    private: true,
    visibility: 'private',
    description: 'Synthetic repository',
    homepage: null,
    language: 'TypeScript',
    size: 42,
    stargazers_count: 3,
    watchers_count: 4,
    forks_count: 1,
    open_issues_count: 2,
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

function mappedRepository() {
  return {
    id: 17,
    fullName: 'arena-labs/harness',
    name: 'harness',
    ownerLogin: 'arena-labs',
    ownerType: 'Organization',
    defaultBranch: 'main',
    private: true,
    visibility: 'private',
    description: 'Synthetic repository',
    homepage: null,
    language: 'TypeScript',
    sizeKb: 42,
    stargazersCount: 3,
    watchersCount: 4,
    forksCount: 1,
    openIssuesCount: 2,
    topics: ['agents'],
    fork: false,
    archived: false,
    disabled: false,
    isTemplate: false,
    createdAt: '2026-01-01T00:00:00Z',
    pushedAt: '2026-08-28T00:00:00Z',
    updatedAt: '2026-08-28T00:00:00Z',
  }
}
