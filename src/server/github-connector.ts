import { createSign, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import type {
  CodingRepositoryState,
  CodingSessionStatus,
  GitHubBranch,
  GitHubBranchPage,
  GitHubConnectionState,
  GitHubRepository,
  GitHubRepositoryPage,
  GitHubStatusState,
} from '../shared/types.js'
import type { ConnectorToolExecutor, ShellCommandBroker, ToolApprovalPresentation, ToolDefinition } from './tools.js'
import { assertNoSymlinkTraversal, isWorkspaceInternalPath, resolveWorkspacePath } from './workspace.js'

export type GitHubErrorCode =
  | 'not_connected'
  | 'repo_not_found'
  | 'branch_not_found'
  | 'github_request_failed'
  | 'repo_bootstrap_failed'

export class GitHubConnectorError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'GitHubConnectorError'
  }
}

interface ConnectionRecord {
  version: 1
  token?: string
  installationId?: number
  envTokenDisabled?: boolean
}

interface OAuthStateRecord {
  expiresAt: number
  callbackUrl: string
  kind: 'oauth' | 'installation'
}

interface GitHubConnectorOptions {
  dataRoot: string
  token?: string
  clientId?: string
  clientSecret?: string
  callbackUrl?: string
  appId?: string
  appSlug?: string
  appPrivateKey?: string
  appPrivateKeyPath?: string
  apiBaseUrl?: string
  oauthBaseUrl?: string
  stateTtlMs?: number
  fetch?: typeof fetch
  now?: () => number
}

export interface CodingSessionInput {
  repoId: number
  repoOwner: string
  repoName: string
  baseBranch: string
  message: string
}

export interface PreparedGitHubRepository {
  checkoutDir: string
  temporaryRoot: string
  workspaceBytes: number
  repository: CodingRepositoryState
  cleanup: () => Promise<void>
}

export interface GitHubCredentialLease {
  token: string
  signal: AbortSignal
  release: () => void
}

interface BootstrapOptions {
  dataRoot: string
  cloneTimeoutMs?: number
  maxFiles?: number
  maxBytes?: number
  maxFileBytes?: number
  run?: GitCommandRunner
}

type GitCommandRunner = (
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>

const DEFAULT_API_BASE_URL = 'https://api.github.com'
const DEFAULT_OAUTH_BASE_URL = 'https://github.com'
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000
const MAX_AGENT_GITHUB_FILE_BYTES = 2 * 1024 * 1024
const INSTALLATION_TOKEN_EXPIRY_SKEW_MS = 60_000

interface CachedInstallationToken {
  installationId: number
  token: string
  expiresAt: number
}

export const GITHUB_AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'github_list_repositories',
      description: 'List repositories visible to the connected GitHub account. Use the returned repository id for other GitHub connector tools.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          cursor: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_branches',
      description: 'List branches and exact head commit SHAs for one connected GitHub repository.',
      parameters: {
        type: 'object',
        properties: {
          repo_id: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          cursor: { type: 'string' },
        },
        required: ['repo_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_read_file',
      description: 'Read one bounded UTF-8 text file from a connected GitHub repository and return the repository, branch head commit SHA, blob SHA, path, and content.',
      parameters: {
        type: 'object',
        properties: {
          repo_id: { type: 'integer', minimum: 1 },
          path: { type: 'string', minLength: 1, maxLength: 512 },
          ref: { type: 'string', minLength: 1, maxLength: 255 },
        },
        required: ['repo_id', 'path'],
        additionalProperties: false,
      },
    },
  },
]

export interface GitHubAgentFile {
  repository: { id: number; fullName: string; private: boolean }
  branch: { name: string; commitSha: string }
  file: { path: string; blobSha: string; size: number; htmlUrl: string | null; content: string }
}

export class GitHubConnector {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly apiBaseUrl: string
  private readonly oauthBaseUrl: string
  private readonly states = new Map<string, OAuthStateRecord>()
  private installationTokenCache?: CachedInstallationToken
  private installationTokenRefresh?: {
    installationId: number
    generation: number
    promise: Promise<{ token: string; expiresAt: number }>
  }
  private connectionGeneration = 0
  private disconnecting = false
  private readonly credentialLeases = new Set<AbortController>()

  constructor(private readonly options: GitHubConnectorOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.apiBaseUrl = (options.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.oauthBaseUrl = (options.oauthBaseUrl || DEFAULT_OAUTH_BASE_URL).replace(/\/+$/, '')
  }

  async initialize(): Promise<void> {
    await mkdir(this.connectionDir, { recursive: true, mode: 0o700 })
    await chmod(this.connectionDir, 0o700)
  }

  async connection(): Promise<GitHubConnectionState> {
    const record = await this.readConnection()
    const connected = Boolean(
      record?.token
      || (record?.installationId && this.githubAppConfigured())
      || (this.options.token && !record?.envTokenDisabled),
    )
    return { status: connected ? 'connected' : 'disconnected' }
  }

  async disconnect(): Promise<{ success: true }> {
    this.disconnecting = true
    this.connectionGeneration += 1
    this.installationTokenCache = undefined
    for (const lease of this.credentialLeases) lease.abort(new Error('GitHub disconnected'))
    this.credentialLeases.clear()
    try {
      await this.writeConnection({ version: 1, envTokenDisabled: Boolean(this.options.token) })
      return { success: true }
    } finally {
      this.disconnecting = false
    }
  }

  /**
   * Borrow a revocable credential for one broker-reconstructed Coding command.
   * The token never enters Session state; disconnect aborts every active lease.
   */
  async acquireCredentialLease(signal: AbortSignal): Promise<GitHubCredentialLease> {
    if (signal.aborted || this.disconnecting) throw notConnected()
    const generation = this.connectionGeneration
    const token = await this.token(signal)
    if (!token || signal.aborted || this.disconnecting) throw notConnected()
    const current = await this.readConnection()
    if (
      generation !== this.connectionGeneration
      || !this.connectionRecordMatchesToken(current, token)
    ) throw notConnected()
    const controller = new AbortController()
    this.credentialLeases.add(controller)
    if (signal.aborted || this.disconnecting || generation !== this.connectionGeneration) {
      this.credentialLeases.delete(controller)
      controller.abort(new Error('GitHub credential lease was revoked'))
      throw notConnected()
    }
    let released = false
    return {
      token,
      signal: AbortSignal.any([signal, controller.signal]),
      release: () => {
        if (released) return
        released = true
        this.credentialLeases.delete(controller)
        controller.abort(new Error('GitHub credential lease released'))
      },
    }
  }

  /**
   * Resolve the fixed session branch's pull-request state with the same
   * revocable credential lease used by the successful mutation command.
   */
  async codingPullRequestStatus(
    repository: CodingRepositoryState,
    arenaBranch: string,
    token: string,
    signal: AbortSignal,
  ): Promise<CodingSessionStatus | undefined> {
    const query = new URLSearchParams({
      head: `${repository.ownerLogin}:${arenaBranch}`,
      base: repository.baseBranch,
      state: 'all',
      per_page: '10',
    })
    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.apiBaseUrl}/repos/${encodeURIComponent(repository.ownerLogin)}/${encodeURIComponent(repository.name)}/pulls?${query}`,
        {
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'user-agent': 'Anera-Agent',
            'x-github-api-version': '2022-11-28',
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        },
      )
    } catch {
      throw githubRequestFailed()
    }
    if (response.status === 401) throw notConnected()
    if (!response.ok) throw githubRequestFailed()
    const raw = await parseGitHubJson<unknown>(response)
    if (!Array.isArray(raw)) throw githubRequestFailed()
    for (const value of raw) {
      try {
        const pull = objectValue(value)
        const head = objectValue(pull.head)
        const headRepository = objectValue(head.repo)
        const base = objectValue(pull.base)
        if (
          head.ref !== arenaBranch
          || headRepository.full_name !== repository.fullName
          || base.ref !== repository.baseBranch
        ) continue
        if (pull.merged_at !== null && typeof pull.merged_at === 'string' && pull.merged_at) return 'pr_merged'
        if (pull.state === 'closed') return 'closed'
        if (pull.state === 'open') return 'pr_open'
      } catch {
        // Ignore malformed or unrelated rows and keep looking for the exact
        // trusted head/base identity.
      }
    }
    return undefined
  }

  async prepareCodingAskpass(workspace: string): Promise<string> {
    const gitDirectory = resolve(workspace, '.git')
    const info = await lstat(gitDirectory).catch(() => undefined)
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new GitHubConnectorError('github_request_failed', 'The Coding checkout no longer has a safe Git metadata directory.', 409)
    }
    const askpassPath = resolve(gitDirectory, `anera-askpass-${randomBytes(10).toString('hex')}.sh`)
    await writeFile(askpassPath, ASKPASS_SCRIPT, { encoding: 'utf8', mode: 0o700, flag: 'wx' })
    await chmod(askpassPath, 0o700)
    return askpassPath
  }

  async serviceStatus(): Promise<GitHubStatusState> {
    try {
      const response = await this.fetchImpl('https://www.githubstatus.com/api/v2/status.json', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error('status request failed')
      const body = await response.json() as { status?: { indicator?: unknown; description?: unknown } }
      const indicator = body.status?.indicator
      if (!['none', 'minor', 'major', 'critical', 'maintenance'].includes(String(indicator))) throw new Error('invalid status response')
      return {
        indicator: indicator as GitHubStatusState['indicator'],
        description: typeof body.status?.description === 'string' ? body.status.description : '',
      }
    } catch {
      return { indicator: 'none', description: 'GitHub status is unavailable.' }
    }
  }

  async beginOAuth(callbackUrl: string): Promise<{ kind: 'connected' } | { kind: 'redirect'; url: string }> {
    await this.initialize()
    if (this.options.token) {
      await this.writeConnection({ version: 1, envTokenDisabled: false })
      this.connectionGeneration += 1
      return { kind: 'connected' }
    }
    if (!this.options.clientId || !this.options.clientSecret) {
      throw new GitHubConnectorError('not_connected', 'GitHub OAuth is not configured.', 503)
    }
    const resolvedCallback = this.options.callbackUrl || callbackUrl
    const state = randomBytes(32).toString('base64url')
    const stateTtlMs = this.options.stateTtlMs ?? DEFAULT_STATE_TTL_MS
    this.pruneStates()
    this.states.set(state, { expiresAt: this.now() + stateTtlMs, callbackUrl: resolvedCallback, kind: 'oauth' })
    const url = new URL('/login/oauth/authorize', `${this.oauthBaseUrl}/`)
    url.searchParams.set('client_id', this.options.clientId)
    url.searchParams.set('redirect_uri', resolvedCallback)
    url.searchParams.set('scope', 'repo read:user')
    url.searchParams.set('state', state)
    url.searchParams.set('allow_signup', 'true')
    return { kind: 'redirect', url: url.toString() }
  }

  async beginInstallation(callbackUrl: string): Promise<{ kind: 'connected' } | { kind: 'redirect'; url: string }> {
    await this.initialize()
    if (this.githubAppRequested() && !this.githubAppConfigured()) {
      throw new GitHubConnectorError('not_connected', 'GitHub App installation is incompletely configured.', 503)
    }
    if (!this.githubAppConfigured()) return await this.beginOAuth(callbackUrl)
    const resolvedCallback = this.options.callbackUrl || callbackUrl
    const state = randomBytes(32).toString('base64url')
    const stateTtlMs = this.options.stateTtlMs ?? DEFAULT_STATE_TTL_MS
    this.pruneStates()
    this.states.set(state, { expiresAt: this.now() + stateTtlMs, callbackUrl: resolvedCallback, kind: 'installation' })
    const url = new URL(`/apps/${encodeURIComponent(this.options.appSlug as string)}/installations/new`, `${this.oauthBaseUrl}/`)
    url.searchParams.set('state', state)
    return { kind: 'redirect', url: url.toString() }
  }

  async completeOAuth(input: { code?: string; state?: string }): Promise<void> {
    const record = this.consumeOAuthState(input.state, 'oauth')
    if (!input.code) throw new OAuthCallbackError('missing_code')
    if (!this.options.clientId || !this.options.clientSecret) throw new OAuthCallbackError('not_configured')
    const tokenUrl = new URL('/login/oauth/access_token', `${this.oauthBaseUrl}/`)
    const response = await this.fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code: input.code,
        redirect_uri: record.callbackUrl,
      }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined)
    if (!response?.ok) throw new OAuthCallbackError('token_exchange_failed')
    const body = await response.json() as { access_token?: unknown; error?: unknown }
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new OAuthCallbackError(typeof body.error === 'string' ? body.error : 'token_exchange_failed')
    }
    await this.writeConnection({ version: 1, token: body.access_token, envTokenDisabled: false })
    this.connectionGeneration += 1
  }

  async completeInstallation(input: { installationId?: string | number; setupAction?: string; state?: string }): Promise<void> {
    this.consumeOAuthState(input.state, 'installation')
    if (input.setupAction === 'delete') {
      this.installationTokenCache = undefined
      await this.writeConnection({ version: 1, envTokenDisabled: Boolean(this.options.token) })
      throw new OAuthCallbackError('installation_deleted')
    }
    const installationId = typeof input.installationId === 'number'
      ? input.installationId
      : Number.parseInt(input.installationId || '', 10)
    if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new OAuthCallbackError('invalid_installation')
    const issued = await this.requestInstallationToken(installationId).catch(() => undefined)
    if (!issued) throw new OAuthCallbackError('installation_token_failed')
    this.installationTokenCache = { installationId, ...issued }
    await this.writeConnection({ version: 1, installationId, envTokenDisabled: false })
    this.connectionGeneration += 1
  }

  cancelOAuth(state?: string): void {
    this.consumeOAuthState(state)
  }

  async listRepositories(limit: number, cursor?: string, signal?: AbortSignal): Promise<GitHubRepositoryPage> {
    const page = parseCursor(cursor)
    const perPage = normalizeLimit(limit)
    const connection = await this.readConnection()
    const installation = Boolean(connection?.installationId && this.githubAppConfigured())
    const path = installation
      ? `/installation/repositories?per_page=${perPage}&page=${page}`
      : `/user/repos?per_page=${perPage}&page=${page}&sort=updated&direction=desc`
    const response = await this.githubResponse(path, 'github_request_failed', signal)
    const payload = await parseGitHubJson<unknown>(response)
    const raw = installation
      ? objectValue(payload).repositories
      : payload
    if (!Array.isArray(raw)) throw githubRequestFailed()
    const repos = raw.map(mapRepository)
    const nextPage = nextPageFromLink(response.headers.get('link'))
    return {
      repos,
      nextCursor: nextPage ? String(nextPage) : null,
      hasNextPage: nextPage !== null,
    }
  }

  async listBranches(repoId: number, limit: number, cursor?: string, signal?: AbortSignal): Promise<GitHubBranchPage> {
    const repo = await this.getRepository(repoId, signal)
    const page = parseCursor(cursor)
    const perPage = normalizeLimit(limit)
    const response = await this.githubResponse(
      `/repos/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}/branches?per_page=${perPage}&page=${page}`,
      'repo_not_found',
      signal,
    )
    const raw = await parseGitHubJson<unknown[]>(response)
    if (!Array.isArray(raw)) throw githubRequestFailed()
    const branches = raw.map(mapBranch)
    const nextPage = nextPageFromLink(response.headers.get('link'))
    return {
      branches,
      nextCursor: nextPage ? String(nextPage) : null,
      hasNextPage: nextPage !== null,
    }
  }

  async readFile(repoId: number, rawPath: string, ref?: string, signal?: AbortSignal): Promise<GitHubAgentFile> {
    const repo = await this.getRepository(repoId, signal)
    const path = normalizeRepositoryPath(rawPath)
    const branchName = ref?.trim() || repo.defaultBranch
    if (!validBranchName(branchName)) throw new GitHubConnectorError('branch_not_found', 'Invalid branch selection.', 404)
    const branch = await this.githubRequest<unknown>(
      `/repos/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}/branches/${encodeURIComponent(branchName)}`,
      'branch_not_found',
      signal,
    ).then(mapBranch)
    const query = new URLSearchParams({ ref: branch.name })
    const raw = objectValue(await this.githubRequest<unknown>(
      `/repos/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?${query}`,
      'repo_not_found',
      signal,
    ))
    if (raw.type !== 'file' || raw.encoding !== 'base64') throw new GitHubConnectorError('github_request_failed', 'GitHub path is not a readable file.', 400)
    const size = requiredInteger(raw.size)
    if (size < 0 || size > MAX_AGENT_GITHUB_FILE_BYTES) {
      throw new GitHubConnectorError('github_request_failed', `GitHub file exceeds the ${MAX_AGENT_GITHUB_FILE_BYTES}-byte connector limit.`, 413)
    }
    const encoded = requiredString(raw.content).replace(/\s+/g, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw githubRequestFailed()
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length !== size || bytes.includes(0)) throw new GitHubConnectorError('github_request_failed', 'GitHub file is not bounded UTF-8 text.', 415)
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new GitHubConnectorError('github_request_failed', 'GitHub file is not bounded UTF-8 text.', 415)
    }
    return {
      repository: { id: repo.id, fullName: repo.fullName, private: repo.private },
      branch,
      file: {
        path: requiredString(raw.path),
        blobSha: requiredString(raw.sha),
        size,
        htmlUrl: nullableString(raw.html_url),
        content,
      },
    }
  }

  async resolveSelection(input: Pick<CodingSessionInput, 'repoId' | 'repoOwner' | 'repoName' | 'baseBranch'>): Promise<{
    repo: GitHubRepository
    branch: GitHubBranch
    token: string
  }> {
    if (!Number.isSafeInteger(input.repoId) || input.repoId <= 0) throw new GitHubConnectorError('repo_not_found', 'Invalid repository selection.', 404)
    if (!validGitHubName(input.repoOwner) || !validGitHubName(input.repoName)) throw new GitHubConnectorError('repo_not_found', 'Invalid repository selection.', 404)
    if (!validBranchName(input.baseBranch)) throw new GitHubConnectorError('branch_not_found', 'Invalid branch selection.', 404)
    const repo = await this.getRepository(input.repoId)
    if (repo.ownerLogin !== input.repoOwner || repo.name !== input.repoName) {
      throw new GitHubConnectorError('repo_not_found', 'Repository selection does not match GitHub.', 404)
    }
    const branch = await this.githubRequest<unknown>(
      `/repos/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}/branches/${encodeURIComponent(input.baseBranch)}`,
      'branch_not_found',
    ).then(mapBranch)
    if (branch.name !== input.baseBranch) throw new GitHubConnectorError('branch_not_found', 'Branch selection does not match GitHub.', 404)
    const token = await this.token()
    if (!token) throw notConnected()
    return { repo, branch, token }
  }

  private async getRepository(repoId: number, signal?: AbortSignal): Promise<GitHubRepository> {
    if (!Number.isSafeInteger(repoId) || repoId <= 0) throw new GitHubConnectorError('repo_not_found', 'Repository not found.', 404)
    const raw = await this.githubRequest<unknown>(`/repositories/${repoId}`, 'repo_not_found', signal)
    const repo = mapRepository(raw)
    if (repo.id !== repoId) throw new GitHubConnectorError('repo_not_found', 'Repository not found.', 404)
    return repo
  }

  private async githubRequest<T>(path: string, missingCode: GitHubErrorCode = 'github_request_failed', signal?: AbortSignal): Promise<T> {
    return await parseGitHubJson<T>(await this.githubResponse(path, missingCode, signal))
  }

  private async githubResponse(path: string, missingCode: GitHubErrorCode = 'github_request_failed', signal?: AbortSignal): Promise<Response> {
    const token = await this.token(signal)
    if (!token) throw notConnected()
    let response: Response
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'Anera-Agent',
          'x-github-api-version': '2022-11-28',
        },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      })
    } catch {
      throw githubRequestFailed()
    }
    if (response.status === 401) throw notConnected()
    if (response.status === 404) throw new GitHubConnectorError(missingCode, missingCode === 'branch_not_found' ? 'Branch not found.' : 'Repository not found.', 404)
    if (!response.ok) throw githubRequestFailed()
    return response
  }

  private async token(signal?: AbortSignal): Promise<string | undefined> {
    const record = await this.readConnection()
    if (record?.token) return record.token
    if (record?.installationId && this.githubAppConfigured()) {
      const cached = this.installationTokenCache
      if (
        cached?.installationId === record.installationId
        && cached.expiresAt - INSTALLATION_TOKEN_EXPIRY_SKEW_MS > this.now()
      ) return cached.token
      const generation = this.connectionGeneration
      const existingRefresh = this.installationTokenRefresh
      let promise = existingRefresh?.installationId === record.installationId && existingRefresh.generation === generation
        ? existingRefresh.promise
        : undefined
      if (!promise) {
        promise = this.refreshInstallationToken(record.installationId, generation)
        this.installationTokenRefresh = { installationId: record.installationId, generation, promise }
        void promise.finally(() => {
          if (this.installationTokenRefresh?.promise === promise) this.installationTokenRefresh = undefined
        }).catch(() => undefined)
      }
      const issued = await waitForInstallationToken(promise, signal)
      return issued.token
    }
    if (this.options.token && !record?.envTokenDisabled) return this.options.token
    return undefined
  }

  private async requestInstallationToken(installationId: number, signal?: AbortSignal): Promise<{ token: string; expiresAt: number }> {
    const jwt = await this.githubAppJwt()
    let response: Response
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${jwt}`,
          'user-agent': 'Anera-Agent',
          'x-github-api-version': '2022-11-28',
        },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      })
    } catch {
      throw githubRequestFailed()
    }
    if (!response.ok) throw githubRequestFailed()
    const body = objectValue(await parseGitHubJson<unknown>(response))
    const token = requiredString(body.token)
    const expiresAt = Date.parse(requiredString(body.expires_at))
    if (!token || !Number.isFinite(expiresAt) || expiresAt <= this.now()) throw githubRequestFailed()
    return { token, expiresAt }
  }

  private async refreshInstallationToken(installationId: number, generation: number): Promise<{ token: string; expiresAt: number }> {
    const issued = await this.requestInstallationToken(installationId)
    const current = await this.readConnection()
    if (generation !== this.connectionGeneration || current?.installationId !== installationId) throw notConnected()
    this.installationTokenCache = { installationId, ...issued }
    return issued
  }

  private async githubAppJwt(): Promise<string> {
    if (!this.githubAppConfigured()) throw githubRequestFailed()
    let privateKey = this.options.appPrivateKey?.replace(/\\n/g, '\n')
    if (!privateKey && this.options.appPrivateKeyPath) {
      try {
        privateKey = await readFile(this.options.appPrivateKeyPath, 'utf8')
      } catch {
        throw githubRequestFailed()
      }
    }
    if (!privateKey) throw githubRequestFailed()
    const issuedAt = Math.floor(this.now() / 1000) - 60
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: this.options.appId })).toString('base64url')
    const unsigned = `${header}.${payload}`
    try {
      const signer = createSign('RSA-SHA256')
      signer.update(unsigned)
      signer.end()
      return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`
    } catch {
      throw githubRequestFailed()
    }
  }

  private githubAppConfigured(): boolean {
    return Boolean(
      /^\d+$/.test(this.options.appId?.trim() || '')
      && /^[A-Za-z0-9-]+$/.test(this.options.appSlug?.trim() || '')
      && (this.options.appPrivateKey?.trim() || this.options.appPrivateKeyPath?.trim()),
    )
  }

  private githubAppRequested(): boolean {
    return Boolean(
      this.options.appId?.trim()
      || this.options.appSlug?.trim()
      || this.options.appPrivateKey?.trim()
      || this.options.appPrivateKeyPath?.trim(),
    )
  }

  private connectionRecordMatchesToken(record: ConnectionRecord | undefined, token: string): boolean {
    if (record?.token) return record.token === token
    if (record?.installationId && this.githubAppConfigured()) {
      return this.installationTokenCache?.installationId === record.installationId
        && this.installationTokenCache.token === token
        && this.installationTokenCache.expiresAt - INSTALLATION_TOKEN_EXPIRY_SKEW_MS > this.now()
    }
    return Boolean(this.options.token && !record?.envTokenDisabled && this.options.token === token)
  }

  private async readConnection(): Promise<ConnectionRecord | undefined> {
    try {
      const value = JSON.parse(await readFile(this.connectionPath, 'utf8')) as Partial<ConnectionRecord>
      if (value.version !== 1) return undefined
      return {
        version: 1,
        ...(typeof value.token === 'string' && value.token ? { token: value.token } : {}),
        ...(Number.isSafeInteger(value.installationId) && Number(value.installationId) > 0
          ? { installationId: Number(value.installationId) }
          : {}),
        ...(typeof value.envTokenDisabled === 'boolean' ? { envTokenDisabled: value.envTokenDisabled } : {}),
      }
    } catch {
      return undefined
    }
  }

  private async writeConnection(record: ConnectionRecord): Promise<void> {
    await this.initialize()
    const temporary = `${this.connectionPath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.connectionPath)
    await chmod(this.connectionPath, 0o600)
  }

  private pruneStates(): void {
    const now = this.now()
    for (const [state, record] of this.states) if (record.expiresAt <= now) this.states.delete(state)
  }

  private consumeOAuthState(state?: string, expectedKind?: OAuthStateRecord['kind']): OAuthStateRecord {
    const key = state || ''
    const record = this.states.get(key)
    this.states.delete(key)
    if (!key || !record) throw new OAuthCallbackError('invalid_state')
    if (record.expiresAt <= this.now()) throw new OAuthCallbackError('state_expired')
    if (expectedKind && record.kind !== expectedKind) throw new OAuthCallbackError('invalid_state')
    return record
  }

  private get connectionDir(): string {
    return resolve(this.options.dataRoot, 'github')
  }

  private get connectionPath(): string {
    return resolve(this.connectionDir, 'connection.json')
  }

}

export function createGitHubAgentToolExecutor(connector: GitHubConnector): ConnectorToolExecutor {
  return async (call, context) => {
    try {
      if (call.name === 'github_list_repositories') {
        const page = await connector.listRepositories(
          optionalIntegerArgument(call.arguments.limit, 50),
          optionalStringArgument(call.arguments.cursor),
          context.signal,
        )
        return { content: JSON.stringify({ status: 'success', ...page }), isError: false }
      }
      if (call.name === 'github_list_branches') {
        const page = await connector.listBranches(
          requiredInteger(call.arguments.repo_id),
          optionalIntegerArgument(call.arguments.limit, 100),
          optionalStringArgument(call.arguments.cursor),
          context.signal,
        )
        return { content: JSON.stringify({ status: 'success', ...page }), isError: false }
      }
      if (call.name === 'github_read_file') {
        const file = await connector.readFile(
          requiredInteger(call.arguments.repo_id),
          requiredString(call.arguments.path),
          optionalStringArgument(call.arguments.ref),
          context.signal,
        )
        return { content: JSON.stringify({ status: 'success', ...file }), isError: false }
      }
      return {
        content: JSON.stringify({ status: 'error', code: 'unsupported_tool', message: `Unsupported GitHub connector tool: ${call.name}` }),
        isError: true,
      }
    } catch (error) {
      const code = error instanceof GitHubConnectorError ? error.code : 'github_request_failed'
      const message = error instanceof GitHubConnectorError ? error.message : 'GitHub request failed.'
      return { content: JSON.stringify({ status: 'error', code, message }), isError: true }
    }
  }
}

const UNSUPPORTED_CODING_REMOTE_COMMAND = 'This Coding session permits only the exact fixed-branch push and the scoped `gh pr`, `gh issue`, workflow-check, and release-read forms documented in the Coding system instructions. Other repositories, remotes, branches, shell composition, and unmodeled `gh` commands are blocked.'
const CLOSED_CODING_REMOTE_COMMAND = 'This Coding session is closed. Remote GitHub operations are disabled except for the approval-gated `gh pr reopen` command for this session pull request.'
const MERGED_CODING_REMOTE_COMMAND = 'This Coding session pull request was merged. Remote GitHub operations are disabled; start a new Coding session to push or change GitHub.'

/**
 * Authorize only branch/repository-scoped operations promised by Arena's
 * public Coding prompt. Every accepted command is parsed and reconstructed;
 * everything else remains in the ordinary network-denied Bash path.
 */
export function createGitHubCodingShellCommandBroker(connector: GitHubConnector): ShellCommandBroker {
  return async (input) => {
    if (!input.repository || input.repository.provider !== 'github') return { kind: 'passthrough' }
    if (!codingRemoteCommandIntent(input.requestedCommand)) return { kind: 'passthrough' }
    const arenaBranch = input.repository.arenaBranch ?? input.repository.baseBranch
    const safeSessionIdentity = /^arena\/[a-f0-9]{20}$/.test(arenaBranch)
      && /^[A-Za-z0-9_.-]{1,100}$/.test(input.repository.ownerLogin)
      && /^[A-Za-z0-9_.-]{1,100}$/.test(input.repository.name)
    if (!safeSessionIdentity) return { kind: 'rejected', message: UNSUPPORTED_CODING_REMOTE_COMMAND }

    const tokens = strictShellWords(input.requestedCommand)
    if (!tokens) return { kind: 'rejected', message: UNSUPPORTED_CODING_REMOTE_COMMAND }
    const closedPullRequestReopen = input.codingSessionStatus === 'closed'
      && tokens[0] === 'gh'
      && tokens[1] === 'pr'
      && tokens[2] === 'reopen'
      && Boolean(scopedGhPullRequestCommand(tokens, input.repository, arenaBranch))
    if (
      input.codingSessionStatus !== 'active'
      && input.codingSessionStatus !== 'pr_open'
      && !closedPullRequestReopen
    ) {
      return {
        kind: 'rejected',
        message: input.codingSessionStatus === 'pr_merged'
          ? MERGED_CODING_REMOTE_COMMAND
          : CLOSED_CODING_REMOTE_COMMAND,
      }
    }
    const scopedGh = tokens[0] === 'gh'
      ? scopedGhCommand(tokens, input.repository, arenaBranch)
      : undefined
    if (tokens[0] === 'gh') {
      if (!scopedGh) return { kind: 'rejected', message: UNSUPPORTED_CODING_REMOTE_COMMAND }
      if (scopedGh.approval && !input.approved) {
        if (
          scopedGh.assetArguments
          && !await releaseAssetSourcesAreValid(input.workspace, scopedGh.assetArguments.map((asset) => asset.path), input.signal)
        ) return { kind: 'rejected', message: UNSUPPORTED_CODING_REMOTE_COMMAND }
        return { kind: 'approval_required', presentation: scopedGh.approval }
      }
      let authorizedArgs = scopedGh.args
      let stagedAssets: StagedReleaseAssets | undefined
      if (scopedGh.assetArguments) {
        try {
          stagedAssets = await stageReleaseAssets(
            input.workspace,
            scopedGh.assetArguments.map((asset) => asset.path),
            input.signal,
          )
          authorizedArgs = [...scopedGh.args]
          for (let index = 0; index < scopedGh.assetArguments.length; index += 1) {
            authorizedArgs[scopedGh.assetArguments[index].index] = stagedAssets.paths[index]
          }
        } catch (error) {
          if (input.signal.aborted) throw error
          return { kind: 'rejected', message: UNSUPPORTED_CODING_REMOTE_COMMAND }
        }
      }
      let lease: GitHubCredentialLease
      try {
        lease = await connector.acquireCredentialLease(input.signal)
      } catch (error) {
        stagedAssets?.release()
        throw error
      }
      return {
        kind: 'authorized',
        command: authorizedArgs.map(shellQuoteArgument).join(' '),
        environment: {
          GH_TOKEN: lease.token,
          GH_HOST: 'github.com',
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_PAGER: 'cat',
          PAGER: 'cat',
          GH_EDITOR: 'true',
          GIT_EDITOR: 'true',
        },
        signal: lease.signal,
        sensitiveValues: [lease.token],
        ...(scopedGh.sessionStatusOnSuccess
          ? { codingSessionStatusOnSuccess: scopedGh.sessionStatusOnSuccess }
          : {}),
        ...(scopedGh.resolveSessionStatusFromPullRequest
          ? {
              resolveCodingSessionStatusOnSuccess: async () => await connector.codingPullRequestStatus(
                input.repository as CodingRepositoryState,
                arenaBranch,
                lease.token,
                lease.signal,
              ),
            }
          : {}),
        release: () => {
          lease.release()
          stagedAssets?.release()
        },
      }
    }

    if (
      tokens.length !== 4
      || tokens[0] !== 'git'
      || tokens[1] !== 'push'
      || tokens[2] !== 'origin'
      || tokens[3] !== arenaBranch
    ) return { kind: 'rejected', message: UNSUPPORTED_CODING_REMOTE_COMMAND }

    const askpassPath = await connector.prepareCodingAskpass(input.workspace)
    let lease: GitHubCredentialLease
    try {
      lease = await connector.acquireCredentialLease(input.signal)
    } catch (error) {
      await rm(askpassPath, { force: true })
      throw error
    }
    const repositoryUrl = `https://github.com/${input.repository.ownerLogin}/${input.repository.name}.git`
    const refspec = `refs/heads/${arenaBranch}:refs/heads/${arenaBranch}`
    return {
      kind: 'authorized',
      command: [
        'git',
        '-c core.hooksPath=/dev/null',
        '-c core.fsmonitor=false',
        '-c credential.helper=',
        '-c http.proxy=',
        'push --no-verify --',
        repositoryUrl,
        refspec,
      ].join(' '),
      environment: {
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        ANERA_GITHUB_ASKPASS_TOKEN: lease.token,
      },
      signal: lease.signal,
      sensitiveValues: [lease.token],
      release: () => {
        lease.release()
        void rm(askpassPath, { force: true })
      },
    }
  }
}

interface ScopedGhCommand {
  args: string[]
  sessionStatusOnSuccess?: CodingSessionStatus
  resolveSessionStatusFromPullRequest?: boolean
  approval?: ToolApprovalPresentation
  assetArguments?: Array<{ index: number; path: string }>
}

interface ValidatedGhOptions {
  args: string[]
  values: Map<string, string[]>
  flags: Set<string>
}

interface GhOptionSpecification {
  value: ReadonlyArray<readonly [canonical: string, ...aliases: string[]]>
  boolean: ReadonlyArray<readonly [canonical: string, ...aliases: string[]]>
}

function githubMutationApproval(title: string, description: string): ToolApprovalPresentation {
  return { title, description }
}

const GH_FORMATTING_OPTIONS = [
  ['--jq', '-q'],
  ['--json'],
  ['--template', '-t'],
] as const

function scopedGhCommand(
  words: readonly string[],
  repository: CodingRepositoryState,
  arenaBranch: string,
): ScopedGhCommand | undefined {
  return scopedGhPullRequestCommand(words, repository, arenaBranch)
    ?? scopedGhIssueCommand(words, repository)
    ?? scopedGhRunCommand(words, repository, arenaBranch)
    ?? scopedGhWorkflowCommand(words, repository, arenaBranch)
    ?? scopedGhReleaseCommand(words, repository, arenaBranch)
}

function scopedGhPullRequestCommand(
  words: readonly string[],
  repository: CodingRepositoryState,
  arenaBranch: string,
): ScopedGhCommand | undefined {
  if (words[0] !== 'gh' || words[1] !== 'pr' || words.length < 3) return undefined
  const operation = words[2]
  const fullName = `${repository.ownerLogin}/${repository.name}`
  const options = words.slice(3)
  if (operation === 'create') {
    const validated = validateGhOptions(options, {
      value: [
        ['--title', '-t'],
        ['--body', '-b'],
        ['--assignee', '-a'],
        ['--label', '-l'],
        ['--milestone', '-m'],
        ['--project', '-p'],
        ['--reviewer', '-r'],
      ],
      boolean: [
        ['--draft', '-d'],
        ['--no-maintainer-edit'],
      ],
    })
    const titles = validated?.values.get('--title') ?? []
    const bodies = validated?.values.get('--body') ?? []
    if (
      !validated
      || titles.length !== 1
      || bodies.length !== 1
      || titles[0].length < 1
      || titles[0].length > 256
      || bodies[0].length > 8_000
    ) return undefined
    return {
      args: [
        'gh', 'pr', 'create',
        '--repo', fullName,
        '--base', repository.baseBranch,
        '--head', arenaBranch,
        ...validated.args,
      ],
      sessionStatusOnSuccess: 'pr_open',
    }
  }

  if (operation === 'status') {
    const validated = validateGhOptions(options, {
      value: GH_FORMATTING_OPTIONS,
      boolean: [['--conflict-status', '-c']],
    })
    return validated ? { args: ['gh', 'pr', 'status', '--repo', fullName, ...validated.args] } : undefined
  }
  if (operation === 'view') {
    const validated = validateGhOptions(options, {
      value: GH_FORMATTING_OPTIONS,
      boolean: [['--comments', '-c']],
    })
    return validated
      ? { args: ['gh', 'pr', 'view', arenaBranch, '--repo', fullName, ...validated.args] }
      : undefined
  }
  if (operation === 'checks') {
    const validated = validateGhOptions(options, {
      value: [...GH_FORMATTING_OPTIONS, ['--interval', '-i']],
      boolean: [['--fail-fast'], ['--required'], ['--watch']],
    })
    if (!validated || !boundedIntegerOption(validated.values.get('--interval'), 1, 60)) return undefined
    return { args: ['gh', 'pr', 'checks', arenaBranch, '--repo', fullName, ...validated.args] }
  }
  if (operation === 'diff') {
    const validated = validateGhOptions(options, {
      value: [['--color'], ['--exclude', '-e']],
      boolean: [['--name-only'], ['--patch']],
    })
    const colors = validated?.values.get('--color') ?? []
    if (!validated || colors.length > 1 || colors.some((value) => !['always', 'never', 'auto'].includes(value))) return undefined
    return { args: ['gh', 'pr', 'diff', arenaBranch, '--repo', fullName, ...validated.args] }
  }
  if (operation === 'list' || operation === 'ls') {
    const validated = validateGhOptions(options, {
      value: [
        ['--app'], ['--assignee', '-a'], ['--author', '-A'], ['--base', '-B'], ['--head', '-H'],
        ...GH_FORMATTING_OPTIONS,
        ['--label', '-l'], ['--limit', '-L'], ['--search', '-S'], ['--state', '-s'],
      ],
      boolean: [['--draft', '-d']],
    })
    const states = validated?.values.get('--state') ?? []
    if (
      !validated
      || !boundedIntegerOption(validated.values.get('--limit'), 1, 100)
      || states.length > 1
      || states.some((value) => !['open', 'closed', 'merged', 'all'].includes(value))
    ) return undefined
    return { args: ['gh', 'pr', 'list', '--repo', fullName, ...validated.args] }
  }
  if (operation === 'merge') {
    const validated = validateGhOptions(options, {
      value: [
        ['--author-email', '-A'], ['--body', '-b'], ['--match-head-commit'], ['--subject', '-t'],
      ],
      boolean: [['--auto'], ['--disable-auto'], ['--merge', '-m'], ['--rebase', '-r'], ['--squash', '-s']],
    })
    const modes = ['--auto', '--disable-auto', '--merge', '--rebase', '--squash']
      .filter((flag) => validated?.flags.has(flag))
    const headCommits = validated?.values.get('--match-head-commit') ?? []
    if (
      !validated
      || modes.length !== 1
      || headCommits.length > 1
      || headCommits.some((value) => !/^[a-f0-9]{40}$/i.test(value))
    ) return undefined
    return {
      args: ['gh', 'pr', 'merge', arenaBranch, '--repo', fullName, ...validated.args],
      sessionStatusOnSuccess: modes[0] === '--auto' || modes[0] === '--disable-auto' ? 'pr_open' : 'closed',
      resolveSessionStatusFromPullRequest: true,
      approval: githubMutationApproval(
        'Approve pull request merge?',
        `This will change merge state for the pull request from ${arenaBranch} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'edit') {
    const validated = validateGhOptions(options, {
      value: [
        ['--title', '-t'], ['--body', '-b'], ['--add-assignee'], ['--add-label'], ['--add-project'],
        ['--add-reviewer'], ['--milestone', '-m'], ['--remove-assignee'], ['--remove-label'],
        ['--remove-project'], ['--remove-reviewer'],
      ],
      boolean: [['--remove-milestone']],
    })
    const titles = validated?.values.get('--title') ?? []
    const bodies = validated?.values.get('--body') ?? []
    if (
      !validated
      || validated.args.length === 0
      || titles.length > 1
      || titles.some((value) => value.length < 1 || value.length > 256)
      || bodies.length > 1
      || bodies.some((value) => value.length > 8_000)
    ) return undefined
    return {
      args: ['gh', 'pr', 'edit', arenaBranch, '--repo', fullName, ...validated.args],
      approval: githubMutationApproval(
        'Approve pull request edit?',
        `This will edit metadata for the pull request from ${arenaBranch} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'close' || operation === 'reopen') {
    const validated = validateGhOptions(options, { value: [['--comment', '-c']], boolean: [] })
    const comments = validated?.values.get('--comment') ?? []
    if (!validated || comments.length > 1 || comments.some((value) => value.length > 8_000)) return undefined
    return {
      args: ['gh', 'pr', operation, arenaBranch, '--repo', fullName, ...validated.args],
      sessionStatusOnSuccess: operation === 'close' ? 'closed' : 'pr_open',
      approval: githubMutationApproval(
        operation === 'close' ? 'Approve pull request closure?' : 'Approve pull request reopening?',
        `This will ${operation} the pull request from ${arenaBranch} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'comment') {
    const validated = validateGhOptions(options, { value: [['--body', '-b']], boolean: [] })
    const bodies = validated?.values.get('--body') ?? []
    if (!validated || bodies.length !== 1 || bodies[0].length < 1 || bodies[0].length > 8_000) return undefined
    return {
      args: ['gh', 'pr', 'comment', arenaBranch, '--repo', fullName, ...validated.args],
      approval: githubMutationApproval(
        'Approve pull request comment?',
        `This will publish a comment on the pull request from ${arenaBranch} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'review') {
    const validated = validateGhOptions(options, {
      value: [['--body', '-b']],
      boolean: [['--approve', '-a'], ['--comment', '-c'], ['--request-changes', '-r']],
    })
    const modes = ['--approve', '--comment', '--request-changes'].filter((flag) => validated?.flags.has(flag))
    const bodies = validated?.values.get('--body') ?? []
    if (
      !validated
      || modes.length !== 1
      || bodies.length > 1
      || bodies.some((value) => value.length > 8_000)
      || (modes[0] !== '--approve' && (bodies.length !== 1 || bodies[0].length < 1))
    ) return undefined
    return {
      args: ['gh', 'pr', 'review', arenaBranch, '--repo', fullName, ...validated.args],
      approval: githubMutationApproval(
        'Approve pull request review?',
        `This will publish a ${modes[0].slice(2)} review on the pull request from ${arenaBranch} in ${fullName}.`,
      ),
    }
  }
  return undefined
}

function scopedGhIssueCommand(
  words: readonly string[],
  repository: CodingRepositoryState,
): ScopedGhCommand | undefined {
  if (words[0] !== 'gh' || words[1] !== 'issue' || words.length < 3) return undefined
  const operation = words[2] === 'new' ? 'create' : words[2] === 'ls' ? 'list' : words[2]
  const fullName = `${repository.ownerLogin}/${repository.name}`
  if (operation === 'create') {
    const validated = validateGhOptions(words.slice(3), {
      value: [
        ['--title', '-t'], ['--body', '-b'], ['--assignee', '-a'], ['--label', '-l'],
        ['--milestone', '-m'], ['--project', '-p'], ['--type'],
      ],
      boolean: [],
    })
    const titles = validated?.values.get('--title') ?? []
    const bodies = validated?.values.get('--body') ?? []
    if (
      !validated
      || titles.length !== 1
      || bodies.length !== 1
      || titles[0].length < 1
      || titles[0].length > 256
      || bodies[0].length > 8_000
    ) return undefined
    return { args: ['gh', 'issue', 'create', '--repo', fullName, ...validated.args] }
  }
  if (operation === 'status') {
    const validated = validateGhOptions(words.slice(3), {
      value: GH_FORMATTING_OPTIONS,
      boolean: [],
    })
    return validated ? { args: ['gh', 'issue', 'status', '--repo', fullName, ...validated.args] } : undefined
  }
  if (operation === 'list') {
    const validated = validateGhOptions(words.slice(3), {
      value: [
        ['--app'], ['--assignee', '-a'], ['--author', '-A'], ...GH_FORMATTING_OPTIONS,
        ['--label', '-l'], ['--limit', '-L'], ['--mention'], ['--milestone', '-m'],
        ['--search', '-S'], ['--state', '-s'], ['--type'],
      ],
      boolean: [],
    })
    const states = validated?.values.get('--state') ?? []
    if (
      !validated
      || !boundedIntegerOption(validated.values.get('--limit'), 1, 100)
      || states.length > 1
      || states.some((value) => !['open', 'closed', 'all'].includes(value))
    ) return undefined
    return { args: ['gh', 'issue', 'list', '--repo', fullName, ...validated.args] }
  }
  if (operation === 'view') {
    const issueNumber = words[3]
    if (!positiveDecimalIdentifier(issueNumber)) return undefined
    const validated = validateGhOptions(words.slice(4), {
      value: GH_FORMATTING_OPTIONS,
      boolean: [['--comments', '-c']],
    })
    return validated
      ? { args: ['gh', 'issue', 'view', issueNumber, '--repo', fullName, ...validated.args] }
      : undefined
  }
  if (operation === 'edit') {
    const issueNumber = words[3]
    if (!positiveDecimalIdentifier(issueNumber)) return undefined
    const validated = validateGhOptions(words.slice(4), {
      value: [
        ['--title', '-t'], ['--body', '-b'], ['--add-assignee'], ['--add-label'], ['--add-project'],
        ['--milestone', '-m'], ['--remove-assignee'], ['--remove-label'], ['--remove-project'], ['--type'],
      ],
      boolean: [['--remove-milestone'], ['--remove-type']],
    })
    const titles = validated?.values.get('--title') ?? []
    const bodies = validated?.values.get('--body') ?? []
    if (
      !validated
      || validated.args.length === 0
      || titles.length > 1
      || titles.some((value) => value.length < 1 || value.length > 256)
      || bodies.length > 1
      || bodies.some((value) => value.length > 8_000)
    ) return undefined
    return {
      args: ['gh', 'issue', 'edit', issueNumber, '--repo', fullName, ...validated.args],
      approval: githubMutationApproval(
        'Approve issue edit?',
        `This will edit issue #${issueNumber} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'close') {
    const issueNumber = words[3]
    if (!positiveDecimalIdentifier(issueNumber)) return undefined
    const validated = validateGhOptions(words.slice(4), {
      value: [['--comment', '-c'], ['--duplicate-of'], ['--reason', '-r']],
      boolean: [],
    })
    const comments = validated?.values.get('--comment') ?? []
    const duplicates = validated?.values.get('--duplicate-of') ?? []
    const reasons = validated?.values.get('--reason') ?? []
    if (
      !validated
      || comments.length > 1
      || comments.some((value) => value.length > 8_000)
      || !positiveDecimalOption(duplicates)
      || reasons.length > 1
      || reasons.some((value) => !['completed', 'not planned', 'duplicate'].includes(value))
    ) return undefined
    return {
      args: ['gh', 'issue', 'close', issueNumber, '--repo', fullName, ...validated.args],
      approval: githubMutationApproval(
        'Approve issue closure?',
        `This will close issue #${issueNumber} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'reopen') {
    const issueNumber = words[3]
    if (!positiveDecimalIdentifier(issueNumber)) return undefined
    const validated = validateGhOptions(words.slice(4), { value: [['--comment', '-c']], boolean: [] })
    const comments = validated?.values.get('--comment') ?? []
    if (!validated || comments.length > 1 || comments.some((value) => value.length > 8_000)) return undefined
    return {
      args: ['gh', 'issue', 'reopen', issueNumber, '--repo', fullName, ...validated.args],
      approval: githubMutationApproval(
        'Approve issue reopening?',
        `This will reopen issue #${issueNumber} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'comment') {
    const issueNumber = words[3]
    if (!positiveDecimalIdentifier(issueNumber)) return undefined
    const validated = validateGhOptions(words.slice(4), { value: [['--body', '-b']], boolean: [] })
    const bodies = validated?.values.get('--body') ?? []
    if (!validated || bodies.length !== 1 || bodies[0].length < 1 || bodies[0].length > 8_000) return undefined
    return {
      args: ['gh', 'issue', 'comment', issueNumber, '--repo', fullName, ...validated.args],
      approval: githubMutationApproval(
        'Approve issue comment?',
        `This will publish a comment on issue #${issueNumber} in ${fullName}.`,
      ),
    }
  }
  return undefined
}

function scopedGhRunCommand(
  words: readonly string[],
  repository: CodingRepositoryState,
  arenaBranch: string,
): ScopedGhCommand | undefined {
  if (words[0] !== 'gh' || words[1] !== 'run' || words.length < 3) return undefined
  const operation = words[2] === 'ls' ? 'list' : words[2]
  const fullName = `${repository.ownerLogin}/${repository.name}`
  if (operation === 'list') {
    const validated = validateGhOptions(words.slice(3), {
      value: [
        ['--commit', '-c'], ['--created'], ['--event', '-e'], ...GH_FORMATTING_OPTIONS,
        ['--limit', '-L'], ['--status', '-s'], ['--user', '-u'], ['--workflow', '-w'],
      ],
      boolean: [['--all', '-a']],
    })
    const commits = validated?.values.get('--commit') ?? []
    const statuses = validated?.values.get('--status') ?? []
    const allowedStatuses = new Set([
      'queued', 'completed', 'in_progress', 'requested', 'waiting', 'pending',
      'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale',
      'startup_failure', 'success', 'timed_out',
    ])
    if (
      !validated
      || !boundedIntegerOption(validated.values.get('--limit'), 1, 100)
      || commits.length > 1
      || commits.some((value) => !/^[a-f0-9]{7,40}$/i.test(value))
      || statuses.length > 1
      || statuses.some((value) => !allowedStatuses.has(value))
    ) return undefined
    return {
      args: ['gh', 'run', 'list', '--repo', fullName, '--branch', arenaBranch, ...validated.args],
    }
  }
  if (operation === 'view') {
    const runId = words[3]
    if (!positiveDecimalIdentifier(runId)) return undefined
    const validated = validateGhOptions(words.slice(4), {
      value: [['--attempt', '-a'], ['--job', '-j'], ...GH_FORMATTING_OPTIONS],
      boolean: [['--exit-status'], ['--log'], ['--log-failed'], ['--verbose', '-v']],
    })
    if (
      !validated
      || !boundedIntegerOption(validated.values.get('--attempt'), 1, 100)
      || !positiveDecimalOption(validated.values.get('--job'))
    ) return undefined
    return { args: ['gh', 'run', 'view', runId, '--repo', fullName, ...validated.args] }
  }
  if (operation === 'watch') {
    const runId = words[3]
    if (!positiveDecimalIdentifier(runId)) return undefined
    const validated = validateGhOptions(words.slice(4), {
      value: [['--interval', '-i']],
      boolean: [['--compact'], ['--exit-status']],
    })
    if (!validated || !boundedIntegerOption(validated.values.get('--interval'), 1, 60)) return undefined
    return { args: ['gh', 'run', 'watch', runId, '--repo', fullName, ...validated.args] }
  }
  if (operation === 'rerun') {
    const runId = words[3]
    if (!positiveDecimalIdentifier(runId)) return undefined
    const validated = validateGhOptions(words.slice(4), {
      value: [['--job', '-j']],
      boolean: [['--debug', '-d'], ['--failed']],
    })
    if (
      !validated
      || !positiveDecimalOption(validated.values.get('--job'))
      || (validated.values.has('--job') && validated.flags.has('--failed'))
    ) return undefined
    return {
      args: ['gh', 'run', 'rerun', runId, '--repo', fullName, ...validated.args],
      approval: githubMutationApproval(
        'Approve workflow run rerun?',
        `This will rerun workflow run ${runId} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'cancel') {
    const runId = words[3]
    if (!positiveDecimalIdentifier(runId)) return undefined
    const validated = validateGhOptions(words.slice(4), { value: [], boolean: [['--force']] })
    if (!validated) return undefined
    return {
      args: ['gh', 'run', 'cancel', runId, '--repo', fullName, ...validated.args],
      approval: githubMutationApproval(
        'Approve workflow run cancellation?',
        `This will cancel workflow run ${runId} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'delete') {
    const runId = words[3]
    if (!positiveDecimalIdentifier(runId) || words.length !== 4) return undefined
    return {
      args: ['gh', 'run', 'delete', runId, '--repo', fullName],
      approval: githubMutationApproval(
        'Approve workflow run deletion?',
        `This will permanently delete workflow run ${runId} from ${fullName}.`,
      ),
    }
  }
  return undefined
}

function scopedGhWorkflowCommand(
  words: readonly string[],
  repository: CodingRepositoryState,
  arenaBranch: string,
): ScopedGhCommand | undefined {
  if (words[0] !== 'gh' || words[1] !== 'workflow' || words.length < 3) return undefined
  const operation = words[2] === 'ls' ? 'list' : words[2]
  const fullName = `${repository.ownerLogin}/${repository.name}`
  if (operation === 'list') {
    const validated = validateGhOptions(words.slice(3), {
      value: [...GH_FORMATTING_OPTIONS, ['--limit', '-L']],
      boolean: [['--all', '-a']],
    })
    if (!validated || !boundedIntegerOption(validated.values.get('--limit'), 1, 100)) return undefined
    return { args: ['gh', 'workflow', 'list', '--repo', fullName, ...validated.args] }
  }
  if (operation === 'view') {
    const workflow = words[3]
    if (!safeWorkflowIdentifier(workflow)) return undefined
    const validated = validateGhOptions(words.slice(4), {
      value: [],
      boolean: [['--yaml', '-y']],
    })
    return validated
      ? { args: ['gh', 'workflow', 'view', workflow, '--repo', fullName, '--ref', arenaBranch, ...validated.args] }
      : undefined
  }
  if (operation === 'run') {
    const workflow = words[3]
    if (!safeWorkflowIdentifier(workflow)) return undefined
    const validated = validateGhOptions(words.slice(4), {
      value: [['--raw-field', '-f']],
      boolean: [],
    })
    const fields = validated?.values.get('--raw-field') ?? []
    if (
      !validated
      || fields.length > 32
      || fields.some((value) => !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}=[\s\S]{0,2000}$/.test(value))
    ) return undefined
    return {
      args: ['gh', 'workflow', 'run', workflow, '--repo', fullName, '--ref', arenaBranch, ...validated.args],
      approval: githubMutationApproval(
        'Approve workflow dispatch?',
        `This will trigger ${workflow} from ${arenaBranch} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'enable' || operation === 'disable') {
    const workflow = words[3]
    if (!safeWorkflowIdentifier(workflow) || words.length !== 4) return undefined
    return {
      args: ['gh', 'workflow', operation, workflow, '--repo', fullName],
      approval: githubMutationApproval(
        operation === 'enable' ? 'Approve workflow enablement?' : 'Approve workflow disablement?',
        `This will ${operation} ${workflow} in ${fullName}.`,
      ),
    }
  }
  return undefined
}

function scopedGhReleaseCommand(
  words: readonly string[],
  repository: CodingRepositoryState,
  arenaBranch: string,
): ScopedGhCommand | undefined {
  if (words[0] !== 'gh' || words[1] !== 'release' || words.length < 3) return undefined
  const operation = words[2] === 'ls' ? 'list' : words[2] === 'new' ? 'create' : words[2]
  const fullName = `${repository.ownerLogin}/${repository.name}`
  if (operation === 'list') {
    const validated = validateGhOptions(words.slice(3), {
      value: [...GH_FORMATTING_OPTIONS, ['--limit', '-L'], ['--order', '-O']],
      boolean: [['--exclude-drafts'], ['--exclude-pre-releases']],
    })
    const orders = validated?.values.get('--order') ?? []
    if (
      !validated
      || !boundedIntegerOption(validated.values.get('--limit'), 1, 100)
      || orders.length > 1
      || orders.some((value) => !['asc', 'desc'].includes(value))
    ) return undefined
    return { args: ['gh', 'release', 'list', '--repo', fullName, ...validated.args] }
  }
  if (operation === 'view') {
    const remaining = words.slice(3)
    const tag = remaining[0]?.startsWith('-') ? undefined : remaining.shift()
    if (tag !== undefined && !safeReleaseTag(tag)) return undefined
    const validated = validateGhOptions(remaining, { value: GH_FORMATTING_OPTIONS, boolean: [] })
    return validated
      ? { args: ['gh', 'release', 'view', ...(tag ? [tag] : []), '--repo', fullName, ...validated.args] }
      : undefined
  }
  if (operation === 'create') {
    const tag = words[3]
    if (!tag || !safeReleaseTag(tag)) return undefined
    const specification: GhOptionSpecification = {
      value: [
        ['--discussion-category'], ['--notes', '-n'], ['--notes-start-tag'], ['--title', '-t'],
      ],
      boolean: [
        ['--draft', '-d'], ['--fail-on-no-commits'], ['--generate-notes'], ['--latest'],
        ['--notes-from-tag'], ['--prerelease', '-p'], ['--verify-tag'],
      ],
    }
    const parsed = validateGhOptionsWithReleaseAssets(words.slice(4), specification)
    const validated = parsed?.validated
    const assets = parsed?.assets ?? []
    const notes = validated?.values.get('--notes') ?? []
    const titles = validated?.values.get('--title') ?? []
    const startTags = validated?.values.get('--notes-start-tag') ?? []
    const noteModes = Number(notes.length === 1)
      + Number(validated?.flags.has('--generate-notes'))
      + Number(validated?.flags.has('--notes-from-tag'))
    if (
      !validated
      || noteModes !== 1
      || notes.length > 1
      || notes.some((value) => value.length > 8_000)
      || titles.length > 1
      || titles.some((value) => value.length < 1 || value.length > 256)
      || startTags.length > 1
      || startTags.some((value) => !safeReleaseTag(value))
    ) return undefined
    const args = ['gh', 'release', 'create', tag, ...assets, '--repo', fullName, '--target', arenaBranch, ...validated.args]
    return {
      args,
      ...(assets.length > 0
        ? { assetArguments: assets.map((path, index) => ({ index: 4 + index, path })) }
        : {}),
      approval: githubMutationApproval(
        'Approve release creation?',
        assets.length > 0
          ? `This will create release ${tag} from ${arenaBranch} in ${fullName} and upload ${releaseAssetSummary(assets)}.`
          : `This will create release ${tag} from ${arenaBranch} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'upload') {
    const tag = words[3]
    if (!tag || !safeReleaseTag(tag)) return undefined
    const parsed = validateGhOptionsWithReleaseAssets(words.slice(4), {
      value: [],
      boolean: [['--clobber']],
    })
    const assets = parsed?.assets ?? []
    if (!parsed || assets.length === 0) return undefined
    const args = ['gh', 'release', 'upload', tag, ...assets, '--repo', fullName, ...parsed.validated.args]
    return {
      args,
      assetArguments: assets.map((path, index) => ({ index: 4 + index, path })),
      approval: githubMutationApproval(
        'Approve release asset upload?',
        `This will upload ${releaseAssetSummary(assets)} to release ${tag} in ${fullName}${parsed.validated.flags.has('--clobber') ? ' and replace assets with matching names' : ''}.`,
      ),
    }
  }
  if (operation === 'edit') {
    const tag = words[3]
    if (!tag || !safeReleaseTag(tag)) return undefined
    const validated = validateGhOptions(words.slice(4), {
      value: [['--discussion-category'], ['--notes', '-n'], ['--title', '-t']],
      boolean: [['--draft'], ['--latest'], ['--prerelease'], ['--verify-tag']],
    })
    const notes = validated?.values.get('--notes') ?? []
    const titles = validated?.values.get('--title') ?? []
    if (
      !validated
      || validated.args.length === 0
      || notes.length > 1
      || notes.some((value) => value.length > 8_000)
      || titles.length > 1
      || titles.some((value) => value.length < 1 || value.length > 256)
    ) return undefined
    return {
      args: ['gh', 'release', 'edit', tag, '--repo', fullName, ...validated.args],
      approval: githubMutationApproval(
        'Approve release edit?',
        `This will edit release ${tag} in ${fullName}.`,
      ),
    }
  }
  if (operation === 'delete') {
    const tag = words[3]
    if (!tag || !safeReleaseTag(tag) || words.length !== 4) return undefined
    return {
      args: ['gh', 'release', 'delete', tag, '--repo', fullName, '--yes'],
      approval: githubMutationApproval(
        'Approve release deletion?',
        `This will permanently delete release ${tag} from ${fullName} without deleting its Git tag.`,
      ),
    }
  }
  return undefined
}

function validateGhOptions(
  rawOptions: readonly string[],
  specification: GhOptionSpecification,
): ValidatedGhOptions | undefined {
  const valueNames = new Map<string, string>()
  const booleanNames = new Map<string, string>()
  for (const [canonical, ...aliases] of specification.value) {
    for (const name of [canonical, ...aliases]) valueNames.set(name, canonical)
  }
  for (const [canonical, ...aliases] of specification.boolean) {
    for (const name of [canonical, ...aliases]) booleanNames.set(name, canonical)
  }
  const args: string[] = []
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  for (let index = 0; index < rawOptions.length; index += 1) {
    const raw = rawOptions[index]
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1
    const name = equals > 0 ? raw.slice(0, equals) : raw
    const inlineValue = equals > 0 ? raw.slice(equals + 1) : undefined
    const valueName = valueNames.get(name)
    if (valueName) {
      const value = inlineValue ?? rawOptions[++index]
      if (value === undefined || value.includes('\0') || value.length > 8_000) return undefined
      const prior = values.get(valueName) ?? []
      prior.push(value)
      values.set(valueName, prior)
      // Keep every untrusted value in the same argv element as its canonical
      // long option. This prevents a value beginning with `-` from being
      // reinterpreted by a downstream CLI parser as another option.
      args.push(`${valueName}=${value}`)
      continue
    }
    const booleanName = booleanNames.get(name)
    if (!booleanName || inlineValue !== undefined || flags.has(booleanName)) return undefined
    flags.add(booleanName)
    args.push(booleanName)
  }
  return { args, values, flags }
}

function boundedIntegerOption(values: readonly string[] | undefined, minimum: number, maximum: number): boolean {
  if (!values) return true
  return values.length === 1
    && values.every((value) => /^\d+$/.test(value) && Number(value) >= minimum && Number(value) <= maximum)
}

function positiveDecimalIdentifier(value: string | undefined): value is string {
  return Boolean(value && /^[1-9]\d{0,19}$/.test(value))
}

function positiveDecimalOption(values: readonly string[] | undefined): boolean {
  return !values || values.length === 0 || (values.length === 1 && positiveDecimalIdentifier(values[0]))
}

function safeWorkflowIdentifier(value: string | undefined): value is string {
  return Boolean(
    value
    && value.length <= 256
    && !value.startsWith('-')
    && /^[A-Za-z0-9_.\/ -]+$/.test(value),
  )
}

function safeReleaseTag(value: string): boolean {
  return value.length <= 255
    && !value.startsWith('-')
    && /^[A-Za-z0-9][A-Za-z0-9._+\/-]*$/.test(value)
}

const MAX_RELEASE_ASSETS = 16
const MAX_RELEASE_ASSET_BYTES = 50 * 1024 * 1024
const MAX_RELEASE_ASSET_TOTAL_BYTES = 200 * 1024 * 1024

interface ValidatedReleaseOptionsAndAssets {
  validated: ValidatedGhOptions
  assets: string[]
}

interface StagedReleaseAssets {
  paths: string[]
  release: () => void
}

function validateGhOptionsWithReleaseAssets(
  rawArguments: readonly string[],
  specification: GhOptionSpecification,
): ValidatedReleaseOptionsAndAssets | undefined {
  const valueNames = new Set(specification.value.flatMap(([canonical, ...aliases]) => [canonical, ...aliases]))
  const booleanNames = new Set(specification.boolean.flatMap(([canonical, ...aliases]) => [canonical, ...aliases]))
  const optionArguments: string[] = []
  const assets: string[] = []
  for (let index = 0; index < rawArguments.length; index += 1) {
    const raw = rawArguments[index]
    if (!raw.startsWith('-')) {
      const asset = canonicalReleaseAssetPath(raw)
      if (!asset) return undefined
      assets.push(asset)
      continue
    }
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1
    const name = equals > 0 ? raw.slice(0, equals) : raw
    if (valueNames.has(name)) {
      optionArguments.push(raw)
      if (equals < 0) {
        const value = rawArguments[++index]
        if (value === undefined) return undefined
        optionArguments.push(value)
      }
      continue
    }
    if (!booleanNames.has(name)) return undefined
    optionArguments.push(raw)
  }
  if (
    assets.length > MAX_RELEASE_ASSETS
    || new Set(assets).size !== assets.length
    || new Set(assets.map((asset) => basename(asset))).size !== assets.length
  ) return undefined
  const validated = validateGhOptions(optionArguments, specification)
  return validated ? { validated, assets } : undefined
}

function canonicalReleaseAssetPath(value: string): string | undefined {
  if (
    !value
    || Buffer.byteLength(value) > 1_024
    || value.startsWith('-')
    || value.includes('\\')
    || /[\x00-\x1f\x7f*?\[\]{}!#]/.test(value)
  ) return undefined
  let normalized = value
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  const parts = normalized.split('/')
  if (
    !normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || parts.some((part) => !part || part === '.' || part === '..')
    || isWorkspaceInternalPath(normalized)
  ) return undefined
  return normalized
}

function releaseAssetSummary(assets: readonly string[]): string {
  const noun = assets.length === 1 ? 'workspace asset' : 'workspace assets'
  return `${assets.length} ${noun} (${assets.map((asset) => basename(asset)).join(', ')})`
}

async function releaseAssetSourcesAreValid(
  workspace: string,
  assets: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  let totalBytes = 0
  try {
    const canonicalWorkspace = await realpath(workspace)
    for (const asset of assets) {
      signal.throwIfAborted()
      const opened = await openValidatedReleaseAsset(workspace, canonicalWorkspace, asset)
      try {
        totalBytes += opened.info.size
        if (totalBytes > MAX_RELEASE_ASSET_TOTAL_BYTES) return false
      } finally {
        await opened.handle.close()
      }
    }
    return true
  } catch (error) {
    if (signal.aborted) throw error
    return false
  }
}

async function openValidatedReleaseAsset(
  workspace: string,
  canonicalWorkspace: string,
  asset: string,
) {
  const target = resolveWorkspacePath(workspace, asset)
  await assertNoSymlinkTraversal(workspace, target)
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_RELEASE_ASSET_BYTES) throw new Error('Release asset is not an allowed regular file')
    const canonicalTarget = await realpath(target)
    const workspaceRelative = relative(canonicalWorkspace, canonicalTarget)
    if (
      !workspaceRelative
      || workspaceRelative === '..'
      || workspaceRelative.startsWith(`..${sep}`)
      || resolve(canonicalWorkspace, workspaceRelative) !== canonicalTarget
    ) throw new Error('Release asset is outside the workspace')
    const current = await stat(canonicalTarget)
    if (current.dev !== info.dev || current.ino !== info.ino || !current.isFile()) {
      throw new Error('Release asset changed during validation')
    }
    return { handle, info }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function stageReleaseAssets(
  workspace: string,
  assets: readonly string[],
  signal: AbortSignal,
): Promise<StagedReleaseAssets> {
  signal.throwIfAborted()
  if (!await releaseAssetSourcesAreValid(workspace, assets, signal)) {
    throw new Error('Release assets changed after approval')
  }
  const temporaryRoot = resolveWorkspacePath(workspace, '.tmp')
  try {
    await mkdir(temporaryRoot, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await assertNoSymlinkTraversal(workspace, temporaryRoot)
  const temporaryInfo = await lstat(temporaryRoot)
  if (!temporaryInfo.isDirectory() || temporaryInfo.isSymbolicLink()) throw new Error('Invalid release staging root')
  const canonicalWorkspace = await realpath(workspace)
  const canonicalTemporaryRoot = await realpath(temporaryRoot)
  const temporaryRelative = relative(canonicalWorkspace, canonicalTemporaryRoot)
  if (
    !temporaryRelative
    || temporaryRelative === '..'
    || temporaryRelative.startsWith(`..${sep}`)
    || resolve(canonicalWorkspace, temporaryRelative) !== canonicalTemporaryRoot
  ) throw new Error('Invalid release staging root')
  const stagingRoot = await mkdtemp(resolve(temporaryRoot, 'github-release-'))
  await chmod(stagingRoot, 0o700)
  const stagedPaths: string[] = []
  let totalBytes = 0
  try {
    for (let index = 0; index < assets.length; index += 1) {
      signal.throwIfAborted()
      const asset = assets[index]
      const opened = await openValidatedReleaseAsset(workspace, canonicalWorkspace, asset)
      let destination: Awaited<ReturnType<typeof open>> | undefined
      let stagedTarget = ''
      try {
        const assetDirectory = resolve(stagingRoot, String(index + 1).padStart(2, '0'))
        await mkdir(assetDirectory, { mode: 0o700 })
        stagedTarget = resolve(assetDirectory, basename(asset))
        destination = await open(
          stagedTarget,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
          0o600,
        )
        totalBytes += opened.info.size
        if (totalBytes > MAX_RELEASE_ASSET_TOTAL_BYTES) throw new Error('Release assets exceed the total byte limit')
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.info.size)))
        let position = 0
        while (position < opened.info.size) {
          signal.throwIfAborted()
          const requested = Math.min(buffer.length, opened.info.size - position)
          const { bytesRead } = await opened.handle.read(buffer, 0, requested, position)
          if (bytesRead === 0) throw new Error('Release asset changed during staging')
          let written = 0
          while (written < bytesRead) {
            const result = await destination.write(buffer, written, bytesRead - written, position + written)
            if (result.bytesWritten === 0) throw new Error('Could not stage release asset')
            written += result.bytesWritten
          }
          position += bytesRead
        }
        const current = await opened.handle.stat()
        if (
          current.size !== opened.info.size
          || current.mtimeMs !== opened.info.mtimeMs
          || current.ctimeMs !== opened.info.ctimeMs
        ) throw new Error('Release asset changed during staging')
      } finally {
        await Promise.allSettled([
          opened.handle.close(),
          ...(destination ? [destination.close()] : []),
        ])
      }
      stagedPaths.push(relative(workspace, stagedTarget).split(sep).join('/'))
    }
    signal.throwIfAborted()
    return {
      paths: stagedPaths,
      release: () => { void rm(stagingRoot, { recursive: true, force: true }) },
    }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true })
    throw error
  }
}

function strictShellWords(command: string): string[] | undefined {
  if (!command.trim() || command.length > 64_000 || command.includes('\0') || /[\r\n]/.test(command)) return undefined
  const words: string[] = []
  let word = ''
  let started = false
  let quote: 'single' | 'double' | undefined
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (quote === 'single') {
      if (character === "'") quote = undefined
      else word += character
      continue
    }
    if (quote === 'double') {
      if (character === '"') {
        quote = undefined
      } else if (character === '\\') {
        const next = command[++index]
        if (next === undefined) return undefined
        word += next
      } else if (character === '$' || character === '`') {
        return undefined
      } else {
        word += character
      }
      continue
    }
    if (/\s/.test(character)) {
      if (started) {
        words.push(word)
        word = ''
        started = false
      }
      continue
    }
    if (character === "'") {
      quote = 'single'
      started = true
      continue
    }
    if (character === '"') {
      quote = 'double'
      started = true
      continue
    }
    if (character === '\\') {
      const next = command[++index]
      if (next === undefined) return undefined
      word += next
      started = true
      continue
    }
    if (/[;&|<>`$()]/.test(character)) return undefined
    word += character
    started = true
  }
  if (quote) return undefined
  if (started) words.push(word)
  return words.length <= 256 ? words : undefined
}

function shellQuoteArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function codingRemoteCommandIntent(command: string): boolean {
  if (/(?:^|[;&|()\s])gh(?:\s|$)/i.test(command)) {
    return !/^\s*gh\s+(?:--version|version|help)(?:\s|$)/i.test(command)
  }
  return /\bgit\b[\s\S]*\b(?:push|fetch|pull|clone|ls-remote)\b/i.test(command)
    || /\bgit\b[\s\S]*\bremote\s+update\b/i.test(command)
}

export class OAuthCallbackError extends Error {
  constructor(readonly oauthCode: string) {
    super(oauthCode)
    this.name = 'OAuthCallbackError'
  }
}

export class GitHubRepositoryBootstrapper {
  private readonly run: GitCommandRunner
  private readonly cloneTimeoutMs: number
  private readonly maxFiles: number
  private readonly maxBytes: number
  private readonly maxFileBytes: number

  constructor(private readonly options: BootstrapOptions) {
    this.run = options.run ?? runGit
    this.cloneTimeoutMs = options.cloneTimeoutMs ?? 5 * 60 * 1000
    this.maxFiles = options.maxFiles ?? 20_000
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024
    this.maxFileBytes = options.maxFileBytes ?? 50 * 1024 * 1024
  }

  async prepare(selection: { repo: GitHubRepository; branch: GitHubBranch; token: string }): Promise<PreparedGitHubRepository> {
    const bootstrapRoot = resolve(this.options.dataRoot, 'github-bootstrap')
    await mkdir(bootstrapRoot, { recursive: true, mode: 0o700 })
    await chmod(bootstrapRoot, 0o700)
    const temporaryRoot = await mkdtemp(resolve(bootstrapRoot, 'repo-'))
    const checkoutDir = resolve(temporaryRoot, 'checkout')
    const askpassPath = resolve(temporaryRoot, 'askpass.sh')
    const cleanup = async () => { await rm(temporaryRoot, { recursive: true, force: true }) }
    try {
      await writeFile(askpassPath, ASKPASS_SCRIPT, { encoding: 'utf8', mode: 0o700 })
      await chmod(askpassPath, 0o700)
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        LANG: 'C',
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_LFS_SKIP_SMUDGE: '1',
        ANERA_GITHUB_ASKPASS_TOKEN: selection.token,
      }
      const cloneUrl = `https://github.com/${selection.repo.ownerLogin}/${selection.repo.name}.git`
      await this.run([
        '-c', 'core.hooksPath=/dev/null',
        'clone', '--no-tags', '--no-recurse-submodules', '--single-branch', '--depth', '1',
        '--branch', selection.branch.name, '--', cloneUrl, checkoutDir,
      ], { env, timeoutMs: this.cloneTimeoutMs })
      await rm(askpassPath, { force: true })
      const head = (await this.run(['-C', checkoutDir, 'rev-parse', 'HEAD'], { env: safeGitEnv(), timeoutMs: 30_000 })).stdout.trim()
      if (head !== selection.branch.commitSha) throw new Error('Checked out commit does not match selected branch')
      const arenaBranch = `arena/${randomBytes(10).toString('hex')}`
      await this.run(
        ['-C', checkoutDir, 'checkout', '--no-track', '-b', arenaBranch],
        { env: safeGitEnv(), timeoutMs: 30_000 },
      )
      const staged = (await this.run(['-C', checkoutDir, 'ls-files', '--stage'], { env: safeGitEnv(), timeoutMs: 30_000 })).stdout
      if (/^120000 |^160000 /m.test(staged)) throw new Error('Repository contains unsupported links or submodules')
      const measured = await measureCheckout(checkoutDir, this.maxFiles, this.maxBytes, this.maxFileBytes)
      return {
        checkoutDir,
        temporaryRoot,
        workspaceBytes: measured.workspaceBytes,
        repository: {
          provider: 'github',
          repoId: selection.repo.id,
          fullName: selection.repo.fullName,
          ownerLogin: selection.repo.ownerLogin,
          name: selection.repo.name,
          baseBranch: selection.branch.name,
          baseCommitSha: selection.branch.commitSha,
          arenaBranch,
          cwd: '/home/user',
          private: selection.repo.private,
          importedAt: new Date().toISOString(),
        },
        cleanup,
      }
    } catch (error) {
      await cleanup()
      if (error instanceof GitHubConnectorError) throw error
      throw new GitHubConnectorError('repo_bootstrap_failed', 'Could not initialize the selected GitHub repository.', 502)
    }
  }
}

async function measureCheckout(root: string, maxFiles: number, maxBytes: number, maxFileBytes: number): Promise<{ workspaceBytes: number }> {
  let fileCount = 0
  let totalBytes = 0
  let workspaceBytes = 0
  const visit = async (directory: string, insideGit: boolean): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('Repository contains a symbolic link')
      const nextInsideGit = insideGit || (directory === root && entry.name === '.git')
      if (info.isDirectory()) {
        await visit(path, nextInsideGit)
        continue
      }
      if (!info.isFile()) throw new Error('Repository contains an unsupported filesystem entry')
      fileCount += 1
      totalBytes += info.size
      if (!nextInsideGit) workspaceBytes += info.size
      if (fileCount > maxFiles || totalBytes > maxBytes || info.size > maxFileBytes) throw new Error('Repository exceeds bootstrap limits')
    }
  }
  await visit(root, false)
  return { workspaceBytes }
}

function mapRepository(value: unknown): GitHubRepository {
  const repo = objectValue(value)
  const owner = objectValue(repo.owner)
  return {
    id: requiredInteger(repo.id),
    fullName: requiredString(repo.full_name),
    name: requiredString(repo.name),
    ownerLogin: requiredString(owner.login),
    ownerType: nullableString(owner.type),
    defaultBranch: requiredString(repo.default_branch),
    private: Boolean(repo.private),
    visibility: nullableString(repo.visibility),
    description: nullableString(repo.description),
    homepage: nullableString(repo.homepage),
    language: nullableString(repo.language),
    sizeKb: nullableInteger(repo.size),
    stargazersCount: nullableInteger(repo.stargazers_count),
    watchersCount: nullableInteger(repo.watchers_count),
    forksCount: nullableInteger(repo.forks_count),
    openIssuesCount: nullableInteger(repo.open_issues_count),
    topics: Array.isArray(repo.topics) ? repo.topics.filter((topic): topic is string => typeof topic === 'string') : [],
    fork: nullableBoolean(repo.fork),
    archived: nullableBoolean(repo.archived),
    disabled: nullableBoolean(repo.disabled),
    isTemplate: nullableBoolean(repo.is_template),
    createdAt: nullableString(repo.created_at),
    pushedAt: nullableString(repo.pushed_at),
    updatedAt: requiredString(repo.updated_at),
  }
}

function mapBranch(value: unknown): GitHubBranch {
  const branch = objectValue(value)
  const commit = objectValue(branch.commit)
  return { name: requiredString(branch.name), commitSha: requiredString(commit.sha) }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw githubRequestFailed()
  return value as Record<string, unknown>
}

async function waitForInstallationToken<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise
  if (signal.aborted) throw githubRequestFailed()
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(githubRequestFailed())
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener('abort', abort))
  })
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw githubRequestFailed()
  return value
}

function requiredInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw githubRequestFailed()
  return value as number
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) ? value as number : null
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 100
  return Math.min(100, Math.max(1, Math.trunc(limit)))
}

function parseCursor(cursor?: string): number {
  if (!cursor) return 1
  if (!/^\d+$/.test(cursor)) throw new GitHubConnectorError('github_request_failed', 'Invalid pagination cursor.', 400)
  const page = Number.parseInt(cursor, 10)
  if (!Number.isSafeInteger(page) || page < 1) throw new GitHubConnectorError('github_request_failed', 'Invalid pagination cursor.', 400)
  return page
}

function optionalIntegerArgument(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? value as number : fallback
}

function optionalStringArgument(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function normalizeRepositoryPath(value: string): string {
  if (value.length < 1 || value.length > 512 || value.startsWith('/') || value.endsWith('/')) {
    throw new GitHubConnectorError('github_request_failed', 'Invalid GitHub repository path.', 400)
  }
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\0\r\n]/.test(segment))) {
    throw new GitHubConnectorError('github_request_failed', 'Invalid GitHub repository path.', 400)
  }
  return segments.join('/')
}

function nextPageFromLink(link: string | null): number | null {
  if (!link) return null
  for (const part of link.split(',')) {
    if (!/;\s*rel="next"\s*$/.test(part.trim())) continue
    const match = part.match(/^\s*<([^>]+)>/)
    if (!match) return null
    try {
      const page = Number.parseInt(new URL(match[1]).searchParams.get('page') || '', 10)
      return Number.isSafeInteger(page) && page > 0 ? page : null
    } catch {
      return null
    }
  }
  return null
}

async function parseGitHubJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    throw githubRequestFailed()
  }
}

function validGitHubName(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..'
}

function validBranchName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\0-\x20\x7f~^:?*[\]\\]/.test(value) && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') && !value.includes('..') && !value.includes('@{') && !value.includes('//')
}

function notConnected(): GitHubConnectorError {
  return new GitHubConnectorError('not_connected', 'Connect GitHub before using GitHub tools.', 401)
}

function githubRequestFailed(): GitHubConnectorError {
  return new GitHubConnectorError('github_request_failed', 'GitHub request failed.', 502)
}

function safeGitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
}

function runGit(args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    execFile('git', args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolveRun({ stdout, stderr })
    })
  })
}

const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *) printf '%s\\n' "$ANERA_GITHUB_ASKPASS_TOKEN" ;;
esac
`
