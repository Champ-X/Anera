import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { GitHubBranch, GitHubRepository } from '../shared/types.js'
import { BrowserManager } from '../server/browser-manager.js'
import {
  GitHubConnector,
  GitHubRepositoryBootstrapper,
  createGitHubCodingShellCommandBroker,
} from '../server/github-connector.js'
import { ProcessManager } from '../server/process-manager.js'
import { SessionStore } from '../server/session-store.js'
import { ToolExecutor, type ToolApprovalPresentation } from '../server/tools.js'

const execFileAsync = promisify(execFile)
const PRODUCTION_GITHUB_API = 'https://api.github.com'
const PRODUCTION_GITHUB_OAUTH = 'https://github.com'
const REPORT_SECRET_PATTERN = /(?:github_pat_[A-Za-z0-9_]{8,}|gh[opsu]_[A-Za-z0-9_]{8,}|Bearer\s+\S+|-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----)/gi

export interface GitHubWritebackCanaryAppConfiguration {
  githubAppId: string
  githubAppSlug: string
  githubAppPrivateKeyPath: string
  githubApiBaseUrl: string
  githubOAuthBaseUrl: string
  githubCloneTimeoutMs?: number
  githubMaxFiles?: number
  githubMaxBytes?: number
  githubMaxFileBytes?: number
  maxOutputBytes?: number
}

export interface GitHubWritebackCanaryConfiguration {
  installationId: number
  repository: string
  owner: string
  name: string
  baseBranch: string
  workflow: string
  workflowInputName: string
  markerPath: string
  expectedMarkerSha256: string
  mergeMethod: 'merge' | 'rebase' | 'squash'
}

export interface GitHubWritebackCanaryConfigurationResult {
  ready: boolean
  missingEnvironment: string[]
  invalidEnvironment: string[]
  productionOrigins: boolean
  configuration?: GitHubWritebackCanaryConfiguration
  publicConfiguration: {
    explicitlyEnabled: boolean
    repositoryConfigured: boolean
    repositoryConfirmed: boolean
    installationConfigured: boolean
    baseBranchConfigured: boolean
    workflowConfigured: boolean
    markerOracleConfigured: boolean
    appConfigured: boolean
    apiOrigin: string | null
    oauthOrigin: string | null
  }
}

export interface GitHubWritebackCanaryEvidence {
  repository: {
    id: number
    fullName: string
    private: true
    visibility: 'private'
    baseBranch: string
    baseCommitSha: string
  }
  markerOracle: { path: string; bytes: number; sha256: string; matched: true }
  branchPush: { branch: string; commitSha: string; remoteMatched: true }
  pullRequestClose: {
    number: number
    created: true
    read: true
    closed: true
    reopened: true
    reclosed: true
  }
  issue: { number: number; created: true; read: true; closed: true }
  workflow: {
    identifier: string
    dispatched: true
    runId: number
    read: true
    headBranch: string
    headSha: string
  }
  release: {
    tag: string
    created: true
    read: true
    assetName: string
    assetBytes: number
    assetSha256: string
    assetUploadedThroughHarness: true
    remoteAssetMatched: true
    deletedThroughHarness: true
  }
  mergeOracle: {
    branch: string
    commitSha: string
    pullRequestNumber: number
    remoteMergedAt: string
    codingSessionStatus: 'pr_merged'
  }
  approvals: {
    count: number
    titles: string[]
  }
  retainedEffects: {
    baseBranchContainsMergedCanaryCommit: true
    explanation: string
  }
}

export interface GitHubWritebackCleanupEntry {
  target: 'pull_request' | 'issue' | 'release' | 'tag' | 'workflow_run' | 'branch'
  identifier: string
  outcome: 'removed' | 'already_absent' | 'retained' | 'failed'
  error?: string
}

export interface GitHubWritebackCanaryDriver {
  execute(): Promise<GitHubWritebackCanaryEvidence>
  cleanup(): Promise<GitHubWritebackCleanupEntry[]>
  close(): Promise<void>
}

export interface GitHubWritebackCanaryExecutionReport {
  outcome: 'passed' | 'failed'
  passed: boolean
  runId: string
  startedAt: string
  completedAt: string
  evidence?: GitHubWritebackCanaryEvidence
  cleanup: GitHubWritebackCleanupEntry[]
  error?: string
}

export function parseGitHubWritebackCanaryConfiguration(
  environment: NodeJS.ProcessEnv,
  app: GitHubWritebackCanaryAppConfiguration,
): GitHubWritebackCanaryConfigurationResult {
  const enabled = environment.ANERA_GITHUB_WRITEBACK_CANARY_ENABLED?.trim().toLowerCase() === 'true'
  const installationId = positiveInteger(environment.ANERA_GITHUB_WRITEBACK_CANARY_INSTALLATION_ID)
  const repository = environment.ANERA_GITHUB_WRITEBACK_CANARY_REPOSITORY?.trim() || ''
  const confirmedRepository = environment.ANERA_GITHUB_WRITEBACK_CANARY_CONFIRM_REPOSITORY?.trim() || ''
  const baseBranch = environment.ANERA_GITHUB_WRITEBACK_CANARY_BASE_BRANCH?.trim() || ''
  const workflow = environment.ANERA_GITHUB_WRITEBACK_CANARY_WORKFLOW?.trim() || ''
  const workflowInputName = environment.ANERA_GITHUB_WRITEBACK_CANARY_WORKFLOW_INPUT?.trim() || 'anera_canary_id'
  const markerPath = environment.ANERA_GITHUB_WRITEBACK_CANARY_MARKER_PATH?.trim() || '.anera-writeback-canary'
  const expectedMarkerSha256 = environment.ANERA_GITHUB_WRITEBACK_CANARY_EXPECTED_MARKER_SHA256?.trim().toLowerCase() || ''
  const mergeMethod = environment.ANERA_GITHUB_WRITEBACK_CANARY_MERGE_METHOD?.trim().toLowerCase() || 'squash'
  const repositoryMatch = repository.match(/^([^/\s]+)\/([^/\s]+)$/)
  const productionOrigins = app.githubApiBaseUrl === PRODUCTION_GITHUB_API
    && app.githubOAuthBaseUrl === PRODUCTION_GITHUB_OAUTH
  const missingEnvironment: string[] = []
  const invalidEnvironment: string[] = []

  if (!enabled) missingEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_ENABLED=true')
  if (!app.githubAppId) missingEnvironment.push('ANERA_GITHUB_APP_ID')
  if (!app.githubAppSlug) missingEnvironment.push('ANERA_GITHUB_APP_SLUG')
  if (!app.githubAppPrivateKeyPath) missingEnvironment.push('ANERA_GITHUB_APP_PRIVATE_KEY_PATH')
  if (!installationId) missingEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_INSTALLATION_ID')
  if (!repository) missingEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_REPOSITORY=owner/name')
  else if (!repositoryMatch || !validGitHubName(repositoryMatch[1]) || !validGitHubName(repositoryMatch[2])) {
    invalidEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_REPOSITORY=owner/name')
  }
  if (!confirmedRepository) missingEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_CONFIRM_REPOSITORY=owner/name')
  else if (!repository || confirmedRepository !== repository) {
    invalidEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_CONFIRM_REPOSITORY must exactly match ANERA_GITHUB_WRITEBACK_CANARY_REPOSITORY')
  }
  if (!baseBranch) missingEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_BASE_BRANCH')
  else if (!validBranchName(baseBranch)) invalidEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_BASE_BRANCH')
  if (!workflow) missingEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_WORKFLOW=.github/workflows/name.yml')
  else if (!validCanaryWorkflow(workflow)) invalidEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_WORKFLOW')
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(workflowInputName)) {
    invalidEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_WORKFLOW_INPUT')
  }
  if (!validRepositoryPath(markerPath)) invalidEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_MARKER_PATH')
  if (!expectedMarkerSha256) missingEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_EXPECTED_MARKER_SHA256')
  else if (!/^[a-f0-9]{64}$/.test(expectedMarkerSha256)) {
    invalidEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_EXPECTED_MARKER_SHA256')
  }
  if (!['merge', 'rebase', 'squash'].includes(mergeMethod)) {
    invalidEnvironment.push('ANERA_GITHUB_WRITEBACK_CANARY_MERGE_METHOD')
  }
  if (!productionOrigins) invalidEnvironment.push('GitHub origins must be exactly https://api.github.com and https://github.com')

  const ready = missingEnvironment.length === 0 && invalidEnvironment.length === 0 && Boolean(repositoryMatch)
  return {
    ready,
    missingEnvironment,
    invalidEnvironment,
    productionOrigins,
    publicConfiguration: {
      explicitlyEnabled: enabled,
      repositoryConfigured: Boolean(repositoryMatch),
      repositoryConfirmed: Boolean(repository && confirmedRepository === repository),
      installationConfigured: Boolean(installationId),
      baseBranchConfigured: validBranchName(baseBranch),
      workflowConfigured: validCanaryWorkflow(workflow),
      markerOracleConfigured: validRepositoryPath(markerPath) && /^[a-f0-9]{64}$/.test(expectedMarkerSha256),
      appConfigured: Boolean(app.githubAppId && app.githubAppSlug && app.githubAppPrivateKeyPath),
      apiOrigin: origin(app.githubApiBaseUrl),
      oauthOrigin: origin(app.githubOAuthBaseUrl),
    },
    ...(ready && repositoryMatch && installationId
      ? {
          configuration: {
            installationId,
            repository,
            owner: repositoryMatch[1],
            name: repositoryMatch[2],
            baseBranch,
            workflow,
            workflowInputName,
            markerPath,
            expectedMarkerSha256,
            mergeMethod: mergeMethod as GitHubWritebackCanaryConfiguration['mergeMethod'],
          },
        }
      : {}),
  }
}

export async function executeGitHubWritebackCanary(
  driver: GitHubWritebackCanaryDriver,
  options: { runId?: string; now?: () => Date } = {},
): Promise<GitHubWritebackCanaryExecutionReport> {
  const now = options.now ?? (() => new Date())
  const runId = options.runId ?? `wb-${randomBytes(8).toString('hex')}`
  if (!/^wb-[a-f0-9]{16}$/.test(runId)) throw new Error('Invalid GitHub writeback canary run ID')
  const startedAt = now().toISOString()
  let evidence: GitHubWritebackCanaryEvidence | undefined
  let error: string | undefined
  try {
    evidence = await driver.execute()
  } catch (caught) {
    error = safeReportError(caught)
  }

  let cleanup: GitHubWritebackCleanupEntry[] = []
  try {
    cleanup = await driver.cleanup()
  } catch (caught) {
    cleanup = [{
      target: 'branch',
      identifier: 'cleanup-orchestration',
      outcome: 'failed',
      error: safeReportError(caught),
    }]
    error ??= 'GitHub writeback cleanup orchestration failed.'
  }
  try {
    await driver.close()
  } catch (caught) {
    error ??= `GitHub writeback canary resource shutdown failed: ${safeReportError(caught)}`
  }

  const cleanupFailed = cleanup.some((entry) => entry.outcome === 'failed')
  if (cleanupFailed && !error) error = 'One or more GitHub writeback cleanup actions failed.'
  const passed = Boolean(evidence) && !error
  return assertCredentialFreeReport({
    outcome: passed ? 'passed' : 'failed',
    passed,
    runId,
    startedAt,
    completedAt: now().toISOString(),
    ...(evidence ? { evidence } : {}),
    cleanup,
    ...(error ? { error } : {}),
  })
}

interface ProductionDriverOptions {
  dataRoot: string
  app: GitHubWritebackCanaryAppConfiguration
  canary: GitHubWritebackCanaryConfiguration
  runId: string
  fetch?: typeof fetch
  workflowPollTimeoutMs?: number
  workflowPollIntervalMs?: number
}

interface CodingCanarySession {
  id: string
  branch: string
  headSha: string
  markerFile: string
}

interface CleanupState {
  branches: Array<{ name: string; sha: string }>
  pullRequests: Array<{ number?: number; branch: string; base: string; title: string }>
  issues: Array<{ number?: number; title: string }>
  release?: { id?: number; tag: string }
  tag?: { name: string; sha: string }
  workflowRun?: { id?: number; branch: string; sha: string }
}

interface GitHubRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: Record<string, unknown>
  allowNotFound?: boolean
  expectNoContent?: boolean
  allowedStatuses?: number[]
}

export class ProductionGitHubWritebackCanaryDriver implements GitHubWritebackCanaryDriver {
  private readonly connector: GitHubConnector
  private readonly bootstrapper: GitHubRepositoryBootstrapper
  private readonly store: SessionStore
  private readonly processes: ProcessManager
  private readonly browser = new BrowserManager()
  private readonly tools: ToolExecutor
  private readonly cleanupState: CleanupState = { branches: [], pullRequests: [], issues: [] }
  private readonly approvals: ToolApprovalPresentation[] = []
  private readonly fetchImpl: typeof fetch
  private repository?: GitHubRepository
  private baseBranch?: GitHubBranch
  private callSequence = 0

  constructor(private readonly options: ProductionDriverOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.connector = new GitHubConnector({
      dataRoot: resolve(options.dataRoot, 'connector'),
      appId: options.app.githubAppId,
      appSlug: options.app.githubAppSlug,
      appPrivateKeyPath: options.app.githubAppPrivateKeyPath,
      apiBaseUrl: options.app.githubApiBaseUrl,
      oauthBaseUrl: options.app.githubOAuthBaseUrl,
      fetch: options.fetch,
    })
    this.bootstrapper = new GitHubRepositoryBootstrapper({
      dataRoot: resolve(options.dataRoot, 'bootstrap'),
      cloneTimeoutMs: options.app.githubCloneTimeoutMs,
      maxFiles: options.app.githubMaxFiles,
      maxBytes: options.app.githubMaxBytes,
      maxFileBytes: options.app.githubMaxFileBytes,
    })
    this.store = new SessionStore(resolve(options.dataRoot, 'store'), 'github-writeback-canary')
    this.processes = new ProcessManager(() => {}, options.app.maxOutputBytes ?? 160_000)
    this.tools = new ToolExecutor(
      this.store,
      this.processes,
      this.browser,
      { inspect: async () => { throw new Error('Vision is unavailable in the GitHub writeback canary') } } as never,
      async (_context, _call, presentation) => {
        if (!presentation) throw new Error('GitHub writeback mutation did not expose an approval presentation')
        this.approvals.push(presentation)
        return true
      },
      {
        shellCommandBroker: createGitHubCodingShellCommandBroker(this.connector),
        toolTimeoutMs: 120_000,
      },
    )
  }

  async execute(): Promise<GitHubWritebackCanaryEvidence> {
    await this.store.initialize()
    await this.connectInstallation()
    const repository = await this.findConfiguredRepository()
    this.repository = repository
    if (!repository.private || repository.visibility !== 'private') {
      throw new Error('The configured GitHub writeback canary repository is not private.')
    }
    if (repository.archived || repository.disabled) {
      throw new Error('The configured GitHub writeback canary repository is archived or disabled.')
    }
    const branchPage = await this.connector.listBranches(repository.id, 100)
    const baseBranch = branchPage.branches.find((candidate) => candidate.name === this.options.canary.baseBranch)
    if (!baseBranch) throw new Error('The configured GitHub writeback canary base branch was not found.')
    this.baseBranch = baseBranch

    const marker = await this.connector.readFile(
      repository.id,
      this.options.canary.markerPath,
      baseBranch.name,
    )
    const markerSha256 = createHash('sha256').update(marker.file.content, 'utf8').digest('hex')
    if (markerSha256 !== this.options.canary.expectedMarkerSha256) {
      throw new Error('The dedicated-repository marker SHA-256 did not match the configured writeback oracle.')
    }

    const ordinary = await this.createCodingSession('operations')
    await this.pushAndVerify(ordinary)
    const closedPullRequestNumber = await this.createAndReadPullRequest(ordinary, 'close-path')

    const issue = await this.createReadAndCloseIssue(ordinary)
    const workflow = await this.dispatchAndReadWorkflow(ordinary)
    const release = await this.createVerifyAndDeleteRelease(ordinary)

    await this.executeBash(ordinary.id, `gh pr close --comment "Anera writeback canary ${this.options.runId} close-path complete"`)
    const closedState = await this.store.get(ordinary.id)
    if (closedState.summary.codingSessionStatus !== 'closed') {
      throw new Error('The Coding Session did not become closed after the canary pull request closure.')
    }
    const closedPull = await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/pulls/${closedPullRequestNumber}`)
    if (objectString(closedPull, 'state') !== 'closed' || objectString(objectValue(closedPull, 'head'), 'ref') !== ordinary.branch) {
      throw new Error('The closed pull-request oracle did not match the fixed canary branch.')
    }

    await this.executeBash(ordinary.id, `gh pr reopen --comment "Anera writeback canary ${this.options.runId} reopen-path verification"`)
    const reopenedState = await this.store.get(ordinary.id)
    if (reopenedState.summary.codingSessionStatus !== 'pr_open') {
      throw new Error('The Coding Session did not return to pr_open after the canary pull request reopening.')
    }
    const reopenedPull = await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/pulls/${closedPullRequestNumber}`)
    if (objectString(reopenedPull, 'state') !== 'open' || objectString(objectValue(reopenedPull, 'head'), 'ref') !== ordinary.branch) {
      throw new Error('The reopened pull-request oracle did not match the fixed canary branch.')
    }

    await this.executeBash(ordinary.id, `gh pr close --comment "Anera writeback canary ${this.options.runId} reclose-path complete"`)
    const reclosedState = await this.store.get(ordinary.id)
    if (reclosedState.summary.codingSessionStatus !== 'closed') {
      throw new Error('The Coding Session did not become closed after the reopened canary pull request was closed again.')
    }
    const reclosedPull = await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/pulls/${closedPullRequestNumber}`)
    if (objectString(reclosedPull, 'state') !== 'closed' || objectString(objectValue(reclosedPull, 'head'), 'ref') !== ordinary.branch) {
      throw new Error('The reclosed pull-request oracle did not match the fixed canary branch.')
    }

    const merge = await this.createCodingSession('merge-oracle')
    await this.pushAndVerify(merge)
    const mergePullRequestNumber = await this.createAndReadPullRequest(merge, 'merge-oracle')
    await this.executeBash(
      merge.id,
      `gh pr merge --${this.options.canary.mergeMethod} --match-head-commit ${merge.headSha}`,
    )
    const mergeState = await this.store.get(merge.id)
    if (mergeState.summary.codingSessionStatus !== 'pr_merged') {
      throw new Error('The trusted merge oracle did not promote the Coding Session to pr_merged.')
    }
    const mergedPull = await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/pulls/${mergePullRequestNumber}`)
    const remoteMergedAt = objectString(mergedPull, 'merged_at')
    if (!remoteMergedAt || objectString(objectValue(mergedPull, 'head'), 'ref') !== merge.branch) {
      throw new Error('GitHub did not report the exact canary pull request as merged.')
    }

    return {
      repository: {
        id: repository.id,
        fullName: repository.fullName,
        private: true,
        visibility: 'private',
        baseBranch: baseBranch.name,
        baseCommitSha: baseBranch.commitSha,
      },
      markerOracle: {
        path: marker.file.path,
        bytes: marker.file.size,
        sha256: markerSha256,
        matched: true,
      },
      branchPush: { branch: ordinary.branch, commitSha: ordinary.headSha, remoteMatched: true },
      pullRequestClose: {
        number: closedPullRequestNumber,
        created: true,
        read: true,
        closed: true,
        reopened: true,
        reclosed: true,
      },
      issue,
      workflow,
      release,
      mergeOracle: {
        branch: merge.branch,
        commitSha: merge.headSha,
        pullRequestNumber: mergePullRequestNumber,
        remoteMergedAt,
        codingSessionStatus: 'pr_merged',
      },
      approvals: {
        count: this.approvals.length,
        titles: this.approvals.map((approval) => approval.title),
      },
      retainedEffects: {
        baseBranchContainsMergedCanaryCommit: true,
        explanation: 'A real merge is required to verify pr_merged. The dedicated disposable repository retains that merged commit; branch, run, release, tag, issue, and open-PR cleanup remains best effort.',
      },
    }
  }

  async cleanup(): Promise<GitHubWritebackCleanupEntry[]> {
    const entries: GitHubWritebackCleanupEntry[] = []
    for (const pull of this.cleanupState.pullRequests) {
      entries.push(await this.cleanupEntry('pull_request', pull.number ? String(pull.number) : pull.branch, async () => {
        let number = pull.number
        if (!number) {
          const query = new URLSearchParams({
            state: 'all',
            head: `${this.options.canary.owner}:${pull.branch}`,
            base: pull.base,
            per_page: '10',
          })
          const candidates = await this.githubArray(`/repos/${encodedRepository(this.options.canary)}/pulls?${query}`)
          const exact = candidates.map((value) => objectValue(value)).find((candidate) => (
            objectString(candidate, 'title') === pull.title
            && objectString(objectValue(candidate, 'head'), 'ref') === pull.branch
            && objectString(objectValue(candidate, 'base'), 'ref') === pull.base
          ))
          if (!exact) return 'already_absent'
          number = objectInteger(exact, 'number')
        }
        const current = await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/pulls/${number}`, { allowNotFound: true })
        if (!current) return 'already_absent'
        const head = objectValue(current.head)
        const base = objectValue(current.base)
        if (objectString(head, 'ref') !== pull.branch || objectString(base, 'ref') !== pull.base) {
          throw new Error('Pull-request identity changed before cleanup.')
        }
        if (objectString(current, 'state') !== 'open') return 'retained'
        await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/pulls/${number}`, {
          method: 'PATCH',
          body: { state: 'closed' },
        })
        return 'removed'
      }))
    }
    for (const issue of this.cleanupState.issues) {
      entries.push(await this.cleanupEntry('issue', issue.number ? String(issue.number) : issue.title, async () => {
        let number = issue.number
        if (!number) {
          const query = new URLSearchParams({ state: 'all', per_page: '100', sort: 'created', direction: 'desc' })
          const candidates = await this.githubArray(`/repos/${encodedRepository(this.options.canary)}/issues?${query}`)
          const exact = candidates.map((value) => objectValue(value)).find((candidate) => (
            !candidate.pull_request && objectString(candidate, 'title') === issue.title
          ))
          if (!exact) return 'already_absent'
          number = objectInteger(exact, 'number')
        }
        const current = await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/issues/${number}`, { allowNotFound: true })
        if (!current) return 'already_absent'
        if (objectString(current, 'title') !== issue.title) throw new Error('Issue identity changed before cleanup.')
        if (objectString(current, 'state') === 'closed') return 'retained'
        await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/issues/${number}`, {
          method: 'PATCH',
          body: { state: 'closed', state_reason: 'completed' },
        })
        return 'removed'
      }))
    }
    if (this.cleanupState.release) {
      entries.push(await this.cleanupEntry('release', this.cleanupState.release.tag, async () => {
        const release = await this.githubJson(
          `/repos/${encodedRepository(this.options.canary)}/releases/tags/${encodeURIComponent(this.cleanupState.release!.tag)}`,
          { allowNotFound: true },
        )
        if (!release) return 'already_absent'
        const releaseId = objectInteger(release, 'id')
        if (this.cleanupState.release!.id && releaseId !== this.cleanupState.release!.id) throw new Error('Release identity changed before cleanup.')
        await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/releases/${releaseId}`, {
          method: 'DELETE',
          expectNoContent: true,
        })
        return 'removed'
      }))
    }
    if (this.cleanupState.tag) {
      entries.push(await this.cleanupEntry(
        'tag',
        this.cleanupState.tag.name,
        async () => await this.deleteRef('tags', this.cleanupState.tag!.name, this.cleanupState.tag!.sha),
      ))
    }
    if (this.cleanupState.workflowRun) {
      entries.push(await this.cleanupEntry('workflow_run', this.cleanupState.workflowRun.id ? String(this.cleanupState.workflowRun.id) : this.cleanupState.workflowRun.branch, async () => {
        let runId = this.cleanupState.workflowRun!.id
        if (!runId) {
          const workflow = encodeURIComponent(this.options.canary.workflow)
          const query = new URLSearchParams({ branch: this.cleanupState.workflowRun!.branch, event: 'workflow_dispatch', per_page: '100' })
          const listed = await this.githubJson(
            `/repos/${encodedRepository(this.options.canary)}/actions/workflows/${workflow}/runs?${query}`,
            { allowNotFound: true },
          )
          if (!listed) return 'already_absent'
          const exact = objectArray(listed, 'workflow_runs').map((value) => objectValue(value)).find((candidate) => (
            objectString(candidate, 'head_branch') === this.cleanupState.workflowRun!.branch
            && objectString(candidate, 'head_sha') === this.cleanupState.workflowRun!.sha
            && objectString(candidate, 'event') === 'workflow_dispatch'
          ))
          if (!exact) return 'already_absent'
          runId = objectInteger(exact, 'id')
        }
        const run = await this.githubJson(
          `/repos/${encodedRepository(this.options.canary)}/actions/runs/${runId}`,
          { allowNotFound: true },
        )
        if (!run) return 'already_absent'
        if (
          objectString(run, 'head_branch') !== this.cleanupState.workflowRun!.branch
          || objectString(run, 'head_sha') !== this.cleanupState.workflowRun!.sha
          || objectString(run, 'event') !== 'workflow_dispatch'
        ) throw new Error('Workflow-run identity changed before cleanup.')
        const status = objectString(run, 'status')
        if (status !== 'completed') {
          await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/actions/runs/${runId}/cancel`, {
            method: 'POST',
            expectNoContent: true,
            allowedStatuses: [202, 409],
          })
          const deadline = Date.now() + 30_000
          let completed = false
          do {
            const current = await this.githubJson(
              `/repos/${encodedRepository(this.options.canary)}/actions/runs/${runId}`,
              { allowNotFound: true },
            )
            if (!current) return 'already_absent'
            completed = objectString(current, 'status') === 'completed'
            if (!completed) await wait(1_000)
          } while (!completed && Date.now() < deadline)
          if (!completed) throw new Error('Workflow run did not reach a deletable terminal state before cleanup timeout.')
        }
        await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/actions/runs/${runId}`, {
          method: 'DELETE',
          expectNoContent: true,
        })
        return 'removed'
      }))
    }
    for (const branch of [...this.cleanupState.branches].reverse()) {
      entries.push(await this.cleanupEntry('branch', branch.name, async () => await this.deleteRef('heads', branch.name, branch.sha)))
    }
    return entries
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.processes.stopEverything(),
      this.browser.closeEverything(),
    ])
    await this.connector.disconnect().catch(() => undefined)
  }

  private async connectInstallation(): Promise<void> {
    const started = await this.connector.beginInstallation('http://127.0.0.1/github-writeback-canary/callback')
    if (started.kind !== 'redirect') throw new Error('GitHub App did not enter the installation flow.')
    const state = new URL(started.url).searchParams.get('state') || ''
    await this.connector.completeInstallation({
      installationId: this.options.canary.installationId,
      setupAction: 'install',
      state,
    })
    if ((await this.connector.connection()).status !== 'connected') {
      throw new Error('GitHub App installation did not become connected.')
    }
  }

  private async findConfiguredRepository(): Promise<GitHubRepository> {
    let cursor: string | undefined
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await this.connector.listRepositories(100, cursor)
      const repository = page.repos.find((candidate) => candidate.fullName.toLowerCase() === this.options.canary.repository.toLowerCase())
      if (repository) {
        if (repository.fullName !== this.options.canary.repository) {
          throw new Error('GitHub repository casing did not exactly match the writeback configuration.')
        }
        return repository
      }
      cursor = page.nextCursor || undefined
      if (!cursor) break
    }
    throw new Error('The configured writeback repository was not visible to the GitHub App installation.')
  }

  private async createCodingSession(purpose: 'operations' | 'merge-oracle'): Promise<CodingCanarySession> {
    const repository = this.repository
    if (!repository || !this.baseBranch) throw new Error('GitHub writeback repository selection is unavailable.')
    const selection = await this.connector.resolveSelection({
      repoId: repository.id,
      repoOwner: repository.ownerLogin,
      repoName: repository.name,
      baseBranch: this.baseBranch.name,
    })
    const prepared = await this.bootstrapper.prepare(selection)
    let session
    try {
      session = await this.store.create({
        repository: prepared.repository,
        workspaceSource: prepared.checkoutDir,
        workspaceBytes: prepared.workspaceBytes,
      })
    } finally {
      await prepared.cleanup()
    }
    const branch = prepared.repository.arenaBranch
    if (!branch) throw new Error('The Coding bootstrap did not create a fixed canary branch.')
    const markerFile = `anera-writeback-${this.options.runId}-${purpose}.txt`
    const markerTarget = resolve(this.store.workspaceDir(session.summary.id), markerFile)
    await writeFile(markerTarget, `Anera GitHub writeback canary ${this.options.runId} ${purpose}\n`, { flag: 'wx' })
    await mkdir(resolve(this.options.dataRoot, 'git-home'), { recursive: true, mode: 0o700 })
    await this.git(session.summary.id, ['config', 'user.name', 'Anera Writeback Canary'])
    await this.git(session.summary.id, ['config', 'user.email', 'anera-writeback-canary@invalid.example'])
    await this.git(session.summary.id, ['add', '--', markerFile])
    await this.git(session.summary.id, ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-m', `Anera writeback canary ${this.options.runId} ${purpose}`])
    const headSha = (await this.git(session.summary.id, ['rev-parse', 'HEAD'])).trim()
    if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error('The canary commit did not produce a full Git SHA.')
    this.cleanupState.branches.push({ name: branch, sha: headSha })
    return { id: session.summary.id, branch, headSha, markerFile }
  }

  private async git(sessionId: string, args: string[]): Promise<string> {
    const result = await execFileAsync('git', args, {
      cwd: this.store.workspaceDir(sessionId),
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        HOME: resolve(this.options.dataRoot, 'git-home'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return result.stdout
  }

  private async pushAndVerify(session: CodingCanarySession): Promise<void> {
    await this.executeBash(session.id, `git push origin ${session.branch}`)
    const remote = await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/git/ref/heads/${encodedRef(session.branch)}`)
    if (objectString(objectValue(remote, 'object'), 'sha') !== session.headSha) {
      throw new Error('The remote fixed-branch SHA did not match the local canary commit.')
    }
  }

  private async createAndReadPullRequest(session: CodingCanarySession, purpose: string): Promise<number> {
    const title = `Anera writeback ${this.options.runId} ${purpose}`
    const cleanup = { branch: session.branch, base: this.options.canary.baseBranch, title } as CleanupState['pullRequests'][number]
    this.cleanupState.pullRequests.push(cleanup)
    const stdout = await this.executeBash(
      session.id,
      `gh pr create --title "${title}" --body "Automated dedicated-repository canary ${this.options.runId}."`,
    )
    const number = githubNumberFromUrl(stdout, 'pull')
    cleanup.number = number
    const view = parseJsonOutput(await this.executeBash(
      session.id,
      'gh pr view --json number,state,headRefName,baseRefName,url',
    ))
    if (
      objectInteger(view, 'number') !== number
      || objectString(view, 'state') !== 'OPEN'
      || objectString(view, 'headRefName') !== session.branch
      || objectString(view, 'baseRefName') !== this.options.canary.baseBranch
    ) throw new Error('The harness pull-request read did not preserve the fixed head/base identity.')
    return number
  }

  private async createReadAndCloseIssue(session: CodingCanarySession): Promise<GitHubWritebackCanaryEvidence['issue']> {
    const title = `Anera writeback ${this.options.runId} issue`
    const cleanup = { title } as CleanupState['issues'][number]
    this.cleanupState.issues.push(cleanup)
    const stdout = await this.executeBash(
      session.id,
      `gh issue create --title "${title}" --body "Automated dedicated-repository canary ${this.options.runId}."`,
    )
    const number = githubNumberFromUrl(stdout, 'issues')
    cleanup.number = number
    const view = parseJsonOutput(await this.executeBash(session.id, `gh issue view ${number} --json number,state,title,url`))
    if (
      objectInteger(view, 'number') !== number
      || objectString(view, 'state') !== 'OPEN'
      || objectString(view, 'title') !== title
    ) throw new Error('The harness issue read did not match the canary issue identity.')
    await this.executeBash(session.id, `gh issue close ${number} --reason completed`)
    const closed = parseJsonOutput(await this.executeBash(session.id, `gh issue view ${number} --json number,state,title,url`))
    if (objectString(closed, 'state') !== 'CLOSED') throw new Error('The canary issue was not closed.')
    return { number, created: true, read: true, closed: true }
  }

  private async dispatchAndReadWorkflow(session: CodingCanarySession): Promise<GitHubWritebackCanaryEvidence['workflow']> {
    await this.executeBash(session.id, `gh workflow view ${this.options.canary.workflow} --yaml`)
    this.cleanupState.workflowRun = { branch: session.branch, sha: session.headSha }
    await this.executeBash(
      session.id,
      `gh workflow run ${this.options.canary.workflow} --raw-field ${this.options.canary.workflowInputName}=${this.options.runId}`,
    )
    const deadline = Date.now() + (this.options.workflowPollTimeoutMs ?? 45_000)
    let selected: Record<string, unknown> | undefined
    do {
      const listed = parseJsonOutput(await this.executeBash(
        session.id,
        `gh run list --workflow ${this.options.canary.workflow} --limit 20 --json databaseId,headBranch,headSha,event,status,workflowName,createdAt,url`,
      ))
      if (!Array.isArray(listed)) throw new Error('The workflow run list did not return an array.')
      selected = listed.map((value) => objectValue(value)).find((candidate) => (
        objectString(candidate, 'headBranch') === session.branch
        && objectString(candidate, 'headSha') === session.headSha
        && objectString(candidate, 'event') === 'workflow_dispatch'
      ))
      if (!selected) await wait(this.options.workflowPollIntervalMs ?? 1_500)
    } while (!selected && Date.now() < deadline)
    if (!selected) throw new Error('The dispatched canary workflow run did not appear before the polling deadline.')
    const runId = objectInteger(selected, 'databaseId')
    const view = parseJsonOutput(await this.executeBash(
      session.id,
      `gh run view ${runId} --json databaseId,headBranch,headSha,event,status,workflowName,createdAt,url`,
    ))
    if (
      objectInteger(view, 'databaseId') !== runId
      || objectString(view, 'headBranch') !== session.branch
      || objectString(view, 'headSha') !== session.headSha
      || objectString(view, 'event') !== 'workflow_dispatch'
    ) throw new Error('The harness workflow-run read did not match the dispatched branch and commit.')
    this.cleanupState.workflowRun.id = runId
    return {
      identifier: this.options.canary.workflow,
      dispatched: true,
      runId,
      read: true,
      headBranch: session.branch,
      headSha: session.headSha,
    }
  }

  private async createVerifyAndDeleteRelease(session: CodingCanarySession): Promise<GitHubWritebackCanaryEvidence['release']> {
    const tag = `anera-${this.options.runId}`
    const assetName = `anera-${this.options.runId}.txt`
    const assetPath = `release-assets/${assetName}`
    const assetBytes = Buffer.from(`Anera release asset ${this.options.runId}\n`, 'utf8')
    await mkdir(resolve(this.store.workspaceDir(session.id), 'release-assets'))
    await writeFile(resolve(this.store.workspaceDir(session.id), assetPath), assetBytes, { flag: 'wx' })
    const assetSha256 = createHash('sha256').update(assetBytes).digest('hex')
    this.cleanupState.tag = { name: tag, sha: session.headSha }
    this.cleanupState.release = { tag }
    await this.executeBash(
      session.id,
      `gh release create ${tag} --title "Anera ${this.options.runId}" --notes "Automated dedicated-repository canary ${this.options.runId}."`,
    )
    const createdRelease = await this.githubJson(
      `/repos/${encodedRepository(this.options.canary)}/releases/tags/${encodeURIComponent(tag)}`,
    )
    const releaseId = objectInteger(createdRelease, 'id')
    this.cleanupState.release.id = releaseId
    const tagRef = await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/git/ref/tags/${encodedRef(tag)}`)
    if (objectString(objectValue(tagRef, 'object'), 'sha') !== session.headSha) {
      throw new Error('The release tag did not resolve to the fixed canary branch commit.')
    }
    await this.executeBash(session.id, `gh release upload ${tag} ${assetPath}`)
    const view = parseJsonOutput(await this.executeBash(
      session.id,
      `gh release view ${tag} --json tagName,name,isDraft,isPrerelease,targetCommitish,url,assets`,
    ))
    if (objectString(view, 'tagName') !== tag || objectString(view, 'targetCommitish') !== session.branch) {
      throw new Error('The harness release read did not match the canary tag and target branch.')
    }
    const remoteRelease = await this.githubJson(
      `/repos/${encodedRepository(this.options.canary)}/releases/tags/${encodeURIComponent(tag)}`,
    )
    if (objectInteger(remoteRelease, 'id') !== releaseId) throw new Error('The release identity changed during asset upload.')
    const assets = objectArray(remoteRelease, 'assets').map((value) => objectValue(value))
    const asset = assets.find((candidate) => objectString(candidate, 'name') === assetName)
    if (!asset || objectInteger(asset, 'size') !== assetBytes.length) {
      throw new Error('The GitHub release asset metadata did not match the approved workspace snapshot.')
    }
    const downloaded = await this.downloadReleaseAsset(objectInteger(asset, 'id'))
    if (
      downloaded.length !== assetBytes.length
      || createHash('sha256').update(downloaded).digest('hex') !== assetSha256
    ) throw new Error('The downloaded GitHub release asset did not match the approved workspace snapshot.')
    await this.executeBash(session.id, `gh release delete ${tag}`)
    const deleted = await this.githubJson(
      `/repos/${encodedRepository(this.options.canary)}/releases/tags/${encodeURIComponent(tag)}`,
      { allowNotFound: true },
    )
    if (deleted) throw new Error('The release remained readable after harness deletion.')
    return {
      tag,
      created: true,
      read: true,
      assetName,
      assetBytes: assetBytes.length,
      assetSha256,
      assetUploadedThroughHarness: true,
      remoteAssetMatched: true,
      deletedThroughHarness: true,
    }
  }

  private async executeBash(sessionId: string, command: string): Promise<string> {
    this.callSequence += 1
    const result = await this.tools.execute({
      id: `call_github_writeback_${this.callSequence}`,
      name: 'bash',
      arguments: { command, timeout_seconds: 120 },
    }, {
      sessionId,
      turnId: `turn_github_writeback_${this.callSequence}`,
      stepId: `step_github_writeback_${this.callSequence}`,
      signal: new AbortController().signal,
    })
    const payload = parseJsonOutput(result.content)
    if (
      !payload
      || Array.isArray(payload)
      || objectString(payload, 'status') !== 'completed'
      || objectIntegerOrNull(payload, 'exit_code') !== 0
    ) {
      const stderr = payload && !Array.isArray(payload) && typeof payload.stderr === 'string'
        ? safeReportError(payload.stderr)
        : 'No bounded stderr was available.'
      throw new Error(`Harness command failed: ${stderr}`)
    }
    return typeof payload.stdout === 'string' ? payload.stdout.trim() : ''
  }

  private async githubJson(
    path: string,
    options: GitHubRequestOptions = {},
  ): Promise<Record<string, unknown> | undefined> {
    const value = await this.githubRaw(path, options)
    return value === undefined ? undefined : objectValue(value)
  }

  private async githubArray(path: string, options: GitHubRequestOptions = {}): Promise<unknown[]> {
    const value = await this.githubRaw(path, options)
    if (!Array.isArray(value)) throw new Error('GitHub writeback oracle returned an invalid array shape.')
    return value
  }

  private async githubRaw(path: string, options: GitHubRequestOptions): Promise<unknown | undefined> {
    const controller = new AbortController()
    const lease = await this.connector.acquireCredentialLease(controller.signal)
    try {
      const response = await this.fetchImpl(`${PRODUCTION_GITHUB_API}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${lease.token}`,
          'content-type': 'application/json',
          'user-agent': 'Anera-Agent',
          'x-github-api-version': '2022-11-28',
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.any([lease.signal, AbortSignal.timeout(30_000)]),
      })
      if (response.status === 404 && options.allowNotFound) return undefined
      if (options.allowedStatuses?.includes(response.status)) return {}
      if (!response.ok) throw new Error(`GitHub writeback oracle returned HTTP ${response.status}.`)
      if (options.expectNoContent || response.status === 204) return {}
      return await response.json()
    } finally {
      lease.release()
    }
  }

  private async downloadReleaseAsset(assetId: number): Promise<Buffer> {
    const controller = new AbortController()
    const lease = await this.connector.acquireCredentialLease(controller.signal)
    try {
      const response = await this.fetchImpl(
        `${PRODUCTION_GITHUB_API}/repos/${encodedRepository(this.options.canary)}/releases/assets/${assetId}`,
        {
          redirect: 'manual',
          headers: {
            accept: 'application/octet-stream',
            authorization: `Bearer ${lease.token}`,
            'user-agent': 'Anera-Agent',
            'x-github-api-version': '2022-11-28',
          },
          signal: AbortSignal.any([lease.signal, AbortSignal.timeout(30_000)]),
        },
      )
      let bodyResponse = response
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location || new URL(location).protocol !== 'https:') throw new Error('GitHub returned an unsafe release-asset redirect.')
        await response.body?.cancel().catch(() => undefined)
        bodyResponse = await this.fetchImpl(location, { signal: AbortSignal.timeout(30_000) })
      }
      if (!bodyResponse.ok) throw new Error(`GitHub release-asset download returned HTTP ${bodyResponse.status}.`)
      return await boundedResponseBuffer(bodyResponse, 50 * 1024 * 1024)
    } finally {
      lease.release()
    }
  }

  private async deleteRef(kind: 'heads' | 'tags', name: string, expectedSha?: string): Promise<'removed' | 'already_absent'> {
    const path = `/repos/${encodedRepository(this.options.canary)}/git/ref/${kind}/${encodedRef(name)}`
    const current = await this.githubJson(path, { allowNotFound: true })
    if (!current) return 'already_absent'
    if (expectedSha && objectString(objectValue(current, 'object'), 'sha') !== expectedSha) {
      throw new Error('Git reference changed before cleanup.')
    }
    await this.githubJson(`/repos/${encodedRepository(this.options.canary)}/git/refs/${kind}/${encodedRef(name)}`, {
      method: 'DELETE',
      expectNoContent: true,
    })
    return 'removed'
  }

  private async cleanupEntry(
    target: GitHubWritebackCleanupEntry['target'],
    identifier: string,
    operation: () => Promise<GitHubWritebackCleanupEntry['outcome']>,
  ): Promise<GitHubWritebackCleanupEntry> {
    try {
      return { target, identifier, outcome: await operation() }
    } catch (error) {
      return { target, identifier, outcome: 'failed', error: safeReportError(error) }
    }
  }
}

export function assertCredentialFreeReport<T>(report: T): T {
  const serialized = JSON.stringify(report)
  REPORT_SECRET_PATTERN.lastIndex = 0
  if (REPORT_SECRET_PATTERN.test(serialized)) throw new Error('Credential material was detected in the GitHub writeback canary report.')
  REPORT_SECRET_PATTERN.lastIndex = 0
  return report
}

function safeReportError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  REPORT_SECRET_PATTERN.lastIndex = 0
  return value.replace(REPORT_SECRET_PATTERN, '[REDACTED_SECRET]').slice(0, 1_000)
}

function positiveInteger(raw: string | undefined): number | undefined {
  if (!raw || !/^[1-9]\d*$/.test(raw.trim())) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

function validGitHubName(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..'
}

function validBranchName(value: string): boolean {
  return value.length >= 1
    && value.length <= 255
    && /^[A-Za-z0-9._\/-]+$/.test(value)
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.endsWith('.')
    && !value.includes('..')
    && !value.includes('@{')
    && !value.split('/').some((part) => !part || part.endsWith('.lock'))
}

function validCanaryWorkflow(value: string): boolean {
  return /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(value)
}

function validRepositoryPath(value: string): boolean {
  return Boolean(value)
    && value.length <= 512
    && !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..')
}

function origin(value: string): string | null {
  try { return new URL(value).origin } catch { return null }
}

function encodedRepository(configuration: Pick<GitHubWritebackCanaryConfiguration, 'owner' | 'name'>): string {
  return `${encodeURIComponent(configuration.owner)}/${encodeURIComponent(configuration.name)}`
}

function encodedRef(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/')
}

function parseJsonOutput(value: string): Record<string, unknown> | unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    return parsed as Record<string, unknown> | unknown[]
  } catch {
    throw new Error('The harness command did not return valid JSON output.')
  }
}

function githubNumberFromUrl(output: string, collection: 'pull' | 'issues'): number {
  const pattern = collection === 'pull' ? /\/pull\/([1-9]\d*)\/?$/ : /\/issues\/([1-9]\d*)\/?$/
  const match = output.trim().match(pattern)
  const value = match ? Number(match[1]) : Number.NaN
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`GitHub did not return a canonical ${collection} URL.`)
  return value
}

function objectValue(value: unknown, field?: string): Record<string, unknown> {
  const selected = field && value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[field]
    : value
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) throw new Error('GitHub returned an invalid object shape.')
  return selected as Record<string, unknown>
}

function objectString(value: unknown, field: string): string {
  const object = objectValue(value)
  const selected = object[field]
  if (typeof selected !== 'string') throw new Error(`GitHub response field ${field} was not a string.`)
  return selected
}

function objectInteger(value: unknown, field: string): number {
  const object = objectValue(value)
  const selected = object[field]
  if (!Number.isSafeInteger(selected)) throw new Error(`GitHub response field ${field} was not an integer.`)
  return selected as number
}

function objectIntegerOrNull(value: unknown, field: string): number | null {
  const object = objectValue(value)
  const selected = object[field]
  if (selected === null) return null
  if (!Number.isSafeInteger(selected)) throw new Error(`Harness result field ${field} was not an integer or null.`)
  return selected as number
}

function objectArray(value: unknown, field: string): unknown[] {
  const object = objectValue(value)
  const selected = object[field]
  if (!Array.isArray(selected)) throw new Error(`GitHub response field ${field} was not an array.`)
  return selected
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

async function boundedResponseBuffer(response: Response, maximumBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('GitHub release asset exceeded the canary byte limit.')
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel()
        throw new Error('GitHub release asset exceeded the canary byte limit.')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes)
}
