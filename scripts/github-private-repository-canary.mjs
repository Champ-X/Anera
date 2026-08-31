import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = resolve(process.cwd())
const reportDirectory = resolve(process.env.ANERA_CANARY_REPORT_DIR || 'reports/production-canaries')
const generatedAt = new Date().toISOString()
const reportPath = resolve(reportDirectory, `github-private-repository-${generatedAt.replaceAll(':', '-')}.json`)
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-real-github-canary-'))
let report

try {
  const [{ config }, { GitHubConnector }] = await Promise.all([
    import(pathToFileURL(resolve(projectRoot, 'dist-server/server/config.js')).href),
    import(pathToFileURL(resolve(projectRoot, 'dist-server/server/github-connector.js')).href),
  ])
  const installationId = positiveInteger(process.env.ANERA_GITHUB_CANARY_INSTALLATION_ID)
  const repositoryName = process.env.ANERA_GITHUB_CANARY_REPOSITORY?.trim() || ''
  const filePath = process.env.ANERA_GITHUB_CANARY_PATH?.trim() || 'README.md'
  const ref = process.env.ANERA_GITHUB_CANARY_REF?.trim() || undefined
  const expectedSha256 = process.env.ANERA_GITHUB_CANARY_EXPECTED_SHA256?.trim().toLowerCase() || ''
  const missingEnvironment = []
  if (!config.githubAppId) missingEnvironment.push('ANERA_GITHUB_APP_ID')
  if (!config.githubAppSlug) missingEnvironment.push('ANERA_GITHUB_APP_SLUG')
  if (!config.githubAppPrivateKeyPath) missingEnvironment.push('ANERA_GITHUB_APP_PRIVATE_KEY_PATH')
  if (!installationId) missingEnvironment.push('ANERA_GITHUB_CANARY_INSTALLATION_ID')
  if (!/^[^/\s]+\/[^/\s]+$/.test(repositoryName)) missingEnvironment.push('ANERA_GITHUB_CANARY_REPOSITORY=owner/name')
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) missingEnvironment.push('ANERA_GITHUB_CANARY_EXPECTED_SHA256')
  const productionOrigins = config.githubApiBaseUrl === 'https://api.github.com'
    && config.githubOAuthBaseUrl === 'https://github.com'

  report = {
    schemaVersion: 'anera-production-github-private-canary/1.0',
    generatedAt,
    execution: 'production GitHubConnector with a real GitHub App installation and no injected fetch implementation',
    fixturePolicy: 'forbidden',
    authentication: 'github_app_installation',
    mobileExcluded: true,
    arenaParityGate: 'paused',
    configuration: {
      appConfigured: Boolean(config.githubAppId && config.githubAppSlug && config.githubAppPrivateKeyPath),
      installationConfigured: Boolean(installationId),
      repositoryConfigured: /^[^/\s]+\/[^/\s]+$/.test(repositoryName),
      expectedFileHashConfigured: /^[a-f0-9]{64}$/.test(expectedSha256),
      apiOrigin: origin(config.githubApiBaseUrl),
      oauthOrigin: origin(config.githubOAuthBaseUrl),
    },
  }

  if (missingEnvironment.length > 0) {
    Object.assign(report, {
      outcome: 'blocked_configuration',
      passed: false,
      missingEnvironment,
    })
  } else if (!productionOrigins) {
    Object.assign(report, {
      outcome: 'failed',
      passed: false,
      error: 'The production GitHub canary requires exactly https://api.github.com and https://github.com; fixture and custom origins are forbidden.',
    })
  } else {
    await stat(config.githubAppPrivateKeyPath)
    const connector = new GitHubConnector({
      dataRoot,
      appId: config.githubAppId,
      appSlug: config.githubAppSlug,
      appPrivateKeyPath: config.githubAppPrivateKeyPath,
      apiBaseUrl: config.githubApiBaseUrl,
      oauthBaseUrl: config.githubOAuthBaseUrl,
    })
    const latenciesMs = {}
    const started = await timed(() => connector.beginInstallation('http://127.0.0.1/github-canary/callback'))
    latenciesMs.beginInstallation = started.latencyMs
    if (started.value.kind !== 'redirect') throw new Error('GitHub App did not enter the installation flow')
    const state = new URL(started.value.url).searchParams.get('state') || ''
    const installed = await timed(() => connector.completeInstallation({
      installationId,
      setupAction: 'install',
      state,
    }))
    latenciesMs.installationTokenExchange = installed.latencyMs
    if ((await connector.connection()).status !== 'connected') throw new Error('GitHub App installation did not become connected')

    let cursor
    let pageCount = 0
    let repository
    const listStarted = performance.now()
    do {
      const page = await connector.listRepositories(100, cursor)
      pageCount += 1
      repository = page.repos.find((candidate) => candidate.fullName.toLowerCase() === repositoryName.toLowerCase())
      cursor = page.nextCursor || undefined
    } while (!repository && cursor && pageCount < 10)
    latenciesMs.listRepositories = roundedMs(performance.now() - listStarted)
    if (!repository) throw new Error(`Configured repository was not visible in the first ${pageCount} GitHub App installation page(s)`)
    if (!repository.private || repository.visibility !== 'private') {
      throw new Error('Configured repository is not reported as private')
    }

    const branchName = ref || repository.defaultBranch
    const branches = await timed(() => connector.listBranches(repository.id, 100))
    latenciesMs.listBranches = branches.latencyMs
    const branch = branches.value.branches.find((candidate) => candidate.name === branchName)
    if (!branch) throw new Error(`Configured branch ${branchName} was not returned by the GitHub App installation`)

    const read = await timed(() => connector.readFile(repository.id, filePath, branchName))
    latenciesMs.readPrivateFile = read.latencyMs
    if (!read.value.repository.private || read.value.repository.fullName.toLowerCase() !== repositoryName.toLowerCase()) {
      throw new Error('Private file response lost repository attribution')
    }
    if (read.value.branch.commitSha !== branch.commitSha) throw new Error('Private file response lost branch-head commit attribution')
    const actualSha256 = createHash('sha256').update(read.value.file.content, 'utf8').digest('hex')
    if (actualSha256 !== expectedSha256) throw new Error('Private file SHA-256 did not match the configured canary oracle')

    const connectionPath = resolve(dataRoot, 'github', 'connection.json')
    const connectionBytes = await readFile(connectionPath, 'utf8')
    const connectionRecord = JSON.parse(connectionBytes)
    const connectionMode = (await stat(connectionPath)).mode & 0o777
    if (connectionMode !== 0o600) throw new Error('GitHub connection record is not owner-only')
    if (connectionRecord.installationId !== installationId || 'token' in connectionRecord) {
      throw new Error('GitHub App connection record did not confine the short-lived installation token')
    }
    if (/gh[opsu]_[A-Za-z0-9_]+/.test(connectionBytes) || connectionBytes.includes('PRIVATE KEY')) {
      throw new Error('GitHub credential material leaked into the durable connection record')
    }

    Object.assign(report, {
      outcome: 'passed',
      passed: true,
      installationId,
      operations: {
        installationTokenExchange: true,
        repositoryEndpoint: '/installation/repositories',
        repositoryPagesRead: pageCount,
        branchListRead: true,
        privateFileRead: true,
      },
      latenciesMs,
      repository: {
        id: repository.id,
        fullName: repository.fullName,
        private: repository.private,
        visibility: repository.visibility,
        defaultBranch: repository.defaultBranch,
      },
      branch: { name: branch.name, commitSha: branch.commitSha },
      file: {
        path: read.value.file.path,
        blobSha: read.value.file.blobSha,
        bytes: read.value.file.size,
        sha256: actualSha256,
        expectedSha256Matched: true,
      },
      credentialConfinement: {
        durableRecordMode: '0600',
        persistedInstallationIdOnly: true,
        shortLivedTokenPersisted: false,
      },
    })
  }
} catch (error) {
  report = {
    ...(report || {
      schemaVersion: 'anera-production-github-private-canary/1.0',
      generatedAt,
      fixturePolicy: 'forbidden',
      mobileExcluded: true,
      arenaParityGate: 'paused',
    }),
    outcome: 'failed',
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  }
} finally {
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await rm(dataRoot, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
if (report.outcome === 'failed') process.exitCode = 1
else if (!report.passed) process.exitCode = 2

function positiveInteger(raw) {
  const value = Number.parseInt(raw || '', 10)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function origin(value) {
  try { return new URL(value).origin } catch { return null }
}

async function timed(operation) {
  const started = performance.now()
  const value = await operation()
  return { value, latencyMs: roundedMs(performance.now() - started) }
}

function roundedMs(value) {
  return Math.round(value * 1000) / 1000
}
