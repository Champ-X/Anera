import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = resolve(process.cwd())
const reportDirectory = resolve(process.env.ANERA_CANARY_REPORT_DIR || 'reports/production-canaries')
const generatedAt = new Date().toISOString()
const reportPath = resolve(reportDirectory, `github-writeback-${generatedAt.replaceAll(':', '-')}.json`)
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-github-writeback-canary-'))
let report

try {
  const [{ config }, canaryModule] = await Promise.all([
    import(pathToFileURL(resolve(projectRoot, 'dist-server/server/config.js')).href),
    import(pathToFileURL(resolve(projectRoot, 'dist-server/eval/github-writeback-canary.js')).href),
  ])
  const app = {
    githubAppId: config.githubAppId,
    githubAppSlug: config.githubAppSlug,
    githubAppPrivateKeyPath: config.githubAppPrivateKeyPath,
    githubApiBaseUrl: config.githubApiBaseUrl,
    githubOAuthBaseUrl: config.githubOAuthBaseUrl,
    githubCloneTimeoutMs: config.githubCloneTimeoutMs,
    githubMaxFiles: config.githubMaxFiles,
    githubMaxBytes: config.githubMaxBytes,
    githubMaxFileBytes: config.githubMaxFileBytes,
    maxOutputBytes: config.maxToolOutputBytes,
  }
  const parsed = canaryModule.parseGitHubWritebackCanaryConfiguration(process.env, app)
  const base = {
    schemaVersion: 'anera-production-github-writeback-canary/1.0',
    generatedAt,
    execution: 'production GitHubConnector, GitHubRepositoryBootstrapper, Coding shell broker, and ToolExecutor with no injected network or command implementation',
    fixturePolicy: 'forbidden',
    authentication: 'github_app_installation',
    explicitOptInRequired: true,
    dedicatedDisposablePrivateRepositoryRequired: true,
    mobileExcluded: true,
    arenaParityGate: 'paused',
    configuration: parsed.publicConfiguration,
  }

  if (!parsed.ready) {
    report = {
      ...base,
      outcome: 'blocked_configuration',
      passed: false,
      missingEnvironment: parsed.missingEnvironment,
      invalidEnvironment: parsed.invalidEnvironment,
    }
  } else {
    await stat(config.githubAppPrivateKeyPath)
    const runId = `wb-${randomBytes(8).toString('hex')}`
    const driver = new canaryModule.ProductionGitHubWritebackCanaryDriver({
      dataRoot,
      app,
      canary: parsed.configuration,
      runId,
    })
    const execution = await canaryModule.executeGitHubWritebackCanary(driver, { runId })
    report = canaryModule.assertCredentialFreeReport({ ...base, ...execution })
  }
} catch (error) {
  report = {
    ...(report || {
      schemaVersion: 'anera-production-github-writeback-canary/1.0',
      generatedAt,
      fixturePolicy: 'forbidden',
      explicitOptInRequired: true,
      dedicatedDisposablePrivateRepositoryRequired: true,
      mobileExcluded: true,
      arenaParityGate: 'paused',
    }),
    outcome: 'failed',
    passed: false,
    error: safeError(error),
  }
} finally {
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rm(dataRoot, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
if (report.outcome === 'failed') process.exitCode = 1
else if (!report.passed) process.exitCode = 2

function safeError(error) {
  const value = error instanceof Error ? error.message : String(error)
  return value
    .replace(/(?:github_pat_[A-Za-z0-9_]{8,}|gh[opsu]_[A-Za-z0-9_]{8,}|Bearer\s+\S+|-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----)/gi, '[REDACTED_SECRET]')
    .slice(0, 1000)
}
