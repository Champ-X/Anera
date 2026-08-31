import { describe, expect, it, vi } from 'vitest'
import {
  assertCredentialFreeReport,
  executeGitHubWritebackCanary,
  parseGitHubWritebackCanaryConfiguration,
  ProductionGitHubWritebackCanaryDriver,
  type GitHubWritebackCanaryAppConfiguration,
  type GitHubWritebackCanaryDriver,
  type GitHubWritebackCanaryEvidence,
} from './github-writeback-canary.js'

const app: GitHubWritebackCanaryAppConfiguration = {
  githubAppId: '42',
  githubAppSlug: 'anera-writeback-canary',
  githubAppPrivateKeyPath: '/private/operator-owned/github-app.pem',
  githubApiBaseUrl: 'https://api.github.com',
  githubOAuthBaseUrl: 'https://github.com',
}

const readyEnvironment: NodeJS.ProcessEnv = {
  ANERA_GITHUB_WRITEBACK_CANARY_ENABLED: 'true',
  ANERA_GITHUB_WRITEBACK_CANARY_INSTALLATION_ID: '731',
  ANERA_GITHUB_WRITEBACK_CANARY_REPOSITORY: 'anera-canary/disposable-writeback',
  ANERA_GITHUB_WRITEBACK_CANARY_CONFIRM_REPOSITORY: 'anera-canary/disposable-writeback',
  ANERA_GITHUB_WRITEBACK_CANARY_BASE_BRANCH: 'main',
  ANERA_GITHUB_WRITEBACK_CANARY_WORKFLOW: '.github/workflows/anera-writeback.yml',
  ANERA_GITHUB_WRITEBACK_CANARY_WORKFLOW_INPUT: 'anera_canary_id',
  ANERA_GITHUB_WRITEBACK_CANARY_MARKER_PATH: '.anera-writeback-canary',
  ANERA_GITHUB_WRITEBACK_CANARY_EXPECTED_MARKER_SHA256: 'a'.repeat(64),
  ANERA_GITHUB_WRITEBACK_CANARY_MERGE_METHOD: 'squash',
}

describe('production GitHub writeback canary', () => {
  it('is blocked by default and requires an exact repository confirmation plus marker oracle', () => {
    const blocked = parseGitHubWritebackCanaryConfiguration({}, app)
    expect(blocked.ready).toBe(false)
    expect(blocked.publicConfiguration).toMatchObject({
      explicitlyEnabled: false,
      repositoryConfirmed: false,
      markerOracleConfigured: false,
      appConfigured: true,
    })
    expect(blocked.missingEnvironment).toEqual(expect.arrayContaining([
      'ANERA_GITHUB_WRITEBACK_CANARY_ENABLED=true',
      'ANERA_GITHUB_WRITEBACK_CANARY_REPOSITORY=owner/name',
      'ANERA_GITHUB_WRITEBACK_CANARY_CONFIRM_REPOSITORY=owner/name',
      'ANERA_GITHUB_WRITEBACK_CANARY_EXPECTED_MARKER_SHA256',
    ]))

    const mismatch = parseGitHubWritebackCanaryConfiguration({
      ...readyEnvironment,
      ANERA_GITHUB_WRITEBACK_CANARY_CONFIRM_REPOSITORY: 'anera-canary/some-other-repo',
    }, app)
    expect(mismatch.ready).toBe(false)
    expect(mismatch.invalidEnvironment).toContain(
      'ANERA_GITHUB_WRITEBACK_CANARY_CONFIRM_REPOSITORY must exactly match ANERA_GITHUB_WRITEBACK_CANARY_REPOSITORY',
    )
  })

  it('accepts only a production-origin, dedicated private-repository configuration', () => {
    const parsed = parseGitHubWritebackCanaryConfiguration(readyEnvironment, app)
    expect(parsed.ready).toBe(true)
    expect(parsed.missingEnvironment).toEqual([])
    expect(parsed.invalidEnvironment).toEqual([])
    expect(parsed.configuration).toEqual({
      installationId: 731,
      repository: 'anera-canary/disposable-writeback',
      owner: 'anera-canary',
      name: 'disposable-writeback',
      baseBranch: 'main',
      workflow: '.github/workflows/anera-writeback.yml',
      workflowInputName: 'anera_canary_id',
      markerPath: '.anera-writeback-canary',
      expectedMarkerSha256: 'a'.repeat(64),
      mergeMethod: 'squash',
    })

    const fixtureOrigin = parseGitHubWritebackCanaryConfiguration(readyEnvironment, {
      ...app,
      githubApiBaseUrl: 'https://api.fixture.invalid',
    })
    expect(fixtureOrigin.ready).toBe(false)
    expect(fixtureOrigin.productionOrigins).toBe(false)
    expect(fixtureOrigin.invalidEnvironment).toContain(
      'GitHub origins must be exactly https://api.github.com and https://github.com',
    )
  })

  it('runs cleanup and resource shutdown after success', async () => {
    const evidence = evidenceFixture()
    const driver: GitHubWritebackCanaryDriver = {
      execute: vi.fn(async () => evidence),
      cleanup: vi.fn(async () => [{ target: 'branch' as const, identifier: 'arena/canary', outcome: 'removed' as const }]),
      close: vi.fn(async () => undefined),
    }
    const report = await executeGitHubWritebackCanary(driver, {
      runId: 'wb-0123456789abcdef',
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    })
    expect(report).toMatchObject({ outcome: 'passed', passed: true, evidence })
    expect(driver.execute).toHaveBeenCalledTimes(1)
    expect(driver.cleanup).toHaveBeenCalledTimes(1)
    expect(driver.close).toHaveBeenCalledTimes(1)
  })

  it('still cleans up after an execution failure and redacts credentials from the report', async () => {
    const leaked = 'ghs_SYNTHETIC_WRITEBACK_TOKEN_DO_NOT_REPORT'
    const driver: GitHubWritebackCanaryDriver = {
      execute: vi.fn(async () => { throw new Error(`remote failure ${leaked}`) }),
      cleanup: vi.fn(async () => [{ target: 'tag' as const, identifier: 'anera-wb', outcome: 'already_absent' as const }]),
      close: vi.fn(async () => undefined),
    }
    const report = await executeGitHubWritebackCanary(driver, {
      runId: 'wb-fedcba9876543210',
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    })
    expect(report).toMatchObject({ outcome: 'failed', passed: false, error: expect.stringContaining('[REDACTED_SECRET]') })
    expect(JSON.stringify(report)).not.toContain(leaked)
    expect(driver.cleanup).toHaveBeenCalledTimes(1)
    expect(driver.close).toHaveBeenCalledTimes(1)
  })

  it('fails the gate when an exact cleanup action fails', async () => {
    const driver: GitHubWritebackCanaryDriver = {
      execute: vi.fn(async () => evidenceFixture()),
      cleanup: vi.fn(async () => [{
        target: 'workflow_run' as const,
        identifier: '123',
        outcome: 'failed' as const,
        error: 'HTTP 409',
      }]),
      close: vi.fn(async () => undefined),
    }
    const report = await executeGitHubWritebackCanary(driver, {
      runId: 'wb-1111111111111111',
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    })
    expect(report).toMatchObject({
      outcome: 'failed',
      passed: false,
      error: 'One or more GitHub writeback cleanup actions failed.',
    })
  })

  it('rejects a report containing recognizable credential material', () => {
    expect(() => assertCredentialFreeReport({ token: 'github_pat_SYNTHETIC_TOKEN_123456789' })).toThrow(
      'Credential material was detected',
    )
  })

  it('uses a rediscovered pull-request number for identity-checked partial-success cleanup', async () => {
    const configuration = parseGitHubWritebackCanaryConfiguration(readyEnvironment, app).configuration
    if (!configuration) throw new Error('Expected ready canary configuration')
    const branch = 'arena/0123456789abcdef0123'
    const title = 'Anera writeback wb-0123456789abcdef close-path'
    const driver = new ProductionGitHubWritebackCanaryDriver({
      dataRoot: '/tmp/anera-writeback-cleanup-test',
      app,
      canary: configuration,
      runId: 'wb-0123456789abcdef',
    })
    const internal = driver as unknown as {
      cleanupState: { pullRequests: Array<{ number?: number; branch: string; base: string; title: string }> }
      githubJson: (path: string, options?: { method?: string }) => Promise<unknown>
      githubArray: (path: string) => Promise<unknown[]>
    }
    internal.cleanupState.pullRequests.push({ branch, base: 'main', title })
    const requests: Array<{ path: string; method?: string }> = []
    internal.githubArray = vi.fn(async (path: string) => {
      requests.push({ path })
      return [{ number: 42, title, state: 'open', head: { ref: branch }, base: { ref: 'main' } }]
    })
    internal.githubJson = vi.fn(async (path: string, options?: { method?: string }) => {
      requests.push({ path, method: options?.method })
      if (path.endsWith('/pulls/42') && options?.method === 'PATCH') return { state: 'closed' }
      if (path.endsWith('/pulls/42')) return { number: 42, title, state: 'open', head: { ref: branch }, base: { ref: 'main' } }
      throw new Error(`Unexpected GitHub request: ${path}`)
    })

    await expect(driver.cleanup()).resolves.toEqual([{
      target: 'pull_request', identifier: branch, outcome: 'removed',
    }])
    expect(requests).toContainEqual({
      path: '/repos/anera-canary/disposable-writeback/pulls/42',
      method: 'PATCH',
    })
    expect(requests.some(({ path }) => path.includes('/pulls/undefined'))).toBe(false)
  })
})

function evidenceFixture(): GitHubWritebackCanaryEvidence {
  return {
    repository: {
      id: 17,
      fullName: 'anera-canary/disposable-writeback',
      private: true,
      visibility: 'private',
      baseBranch: 'main',
      baseCommitSha: 'a'.repeat(40),
    },
    markerOracle: { path: '.anera-writeback-canary', bytes: 8, sha256: 'a'.repeat(64), matched: true },
    branchPush: { branch: 'arena/0123456789abcdef0123', commitSha: 'b'.repeat(40), remoteMatched: true },
    pullRequestClose: {
      number: 10,
      created: true,
      read: true,
      closed: true,
      reopened: true,
      reclosed: true,
    },
    issue: { number: 11, created: true, read: true, closed: true },
    workflow: {
      identifier: '.github/workflows/anera-writeback.yml',
      dispatched: true,
      runId: 12,
      read: true,
      headBranch: 'arena/0123456789abcdef0123',
      headSha: 'b'.repeat(40),
    },
    release: {
      tag: 'anera-wb-0123456789abcdef',
      created: true,
      read: true,
      assetName: 'asset.txt',
      assetBytes: 8,
      assetSha256: 'c'.repeat(64),
      assetUploadedThroughHarness: true,
      remoteAssetMatched: true,
      deletedThroughHarness: true,
    },
    mergeOracle: {
      branch: 'arena/fedcba98765432100123',
      commitSha: 'd'.repeat(40),
      pullRequestNumber: 13,
      remoteMergedAt: '2026-08-30T00:00:00.000Z',
      codingSessionStatus: 'pr_merged',
    },
    approvals: { count: 5, titles: ['Approve issue closure?'] },
    retainedEffects: {
      baseBranchContainsMergedCanaryCommit: true,
      explanation: 'A real merge is retained in the disposable repository.',
    },
  }
}
