import './legacy-live-test-disabled.mjs'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = resolve(process.cwd())
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-package-install-smoke-'))
const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/real-smokes')
const packageSpec = 'vite@5.4.19'
let server
let agent

try {
  const { createApp } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/app.js')).href)
  const created = await createApp({ dataRoot })
  agent = created.agent
  server = createServer(created.app)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Package-install smoke server did not bind')
  const base = `http://127.0.0.1:${address.port}`

  const session = (await postJson(base, '/api/sessions', {}, 201)).session
  const prompt = `In the empty workspace, create package.json with name "anera-package-smoke", private true, and type "module". Install the exact npm registry dependency ${packageSpec} with install_npm_packages; do not use Bash, curl, Python, or another package manager for network access. After installation, use Bash without network to verify node_modules/vite/package.json reports exactly 5.4.19 and package-lock.json exists. Do not start a server. Finish with a concise verification report that includes the exact installed version.`
  await postJson(base, `/api/sessions/${session.id}/messages`, {
    message: { text: prompt },
    metadata: { timezone: 'Asia/Shanghai', submissionSource: 'chat_input' },
    v2Source: 'agentic_chat_submit',
  }, 202)

  const snapshot = await waitForTerminal(base, session.id)
  const packageEvents = snapshot.events.filter((event) => (
    event.type === 'tool.completed' && event.data.call?.name === 'install_npm_packages'
  ))
  const packageFailures = snapshot.events.filter((event) => (
    ['tool.failed', 'tool.timed_out'].includes(event.type) && event.data.call?.name === 'install_npm_packages'
  ))
  const bashEvents = snapshot.events.filter((event) => (
    event.type === 'tool.completed' && event.data.call?.name === 'bash'
  ))
  const files = new Set(snapshot.workspace.map((entry) => entry.name))
  const final = String(snapshot.events.findLast((event) => event.type === 'assistant.final')?.data?.content || '')
  const workspace = resolve(dataRoot, 'sessions', session.id, 'workspace')
  const installedManifest = JSON.parse(await readFile(resolve(workspace, 'node_modules/vite/package.json'), 'utf8'))
  const rootManifest = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'))
  const lockfile = JSON.parse(await readFile(resolve(workspace, 'package-lock.json'), 'utf8'))
  const canonicalResponse = await fetch(`${base}/api/sessions/${session.id}/canonical.jsonl?task_id=dependency-install`)
  if (!canonicalResponse.ok) throw new Error(`Canonical trace failed: ${canonicalResponse.status}`)
  const canonicalEvents = (await canonicalResponse.text()).trim().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.recordType === 'event')

  const checks = {
    sessionCompleted: snapshot.session.status === 'completed',
    exactlyOneRegistryInstall: packageEvents.length === 1 && packageFailures.length === 0,
    exactPackageArgument: packageEvents[0]?.data.call?.arguments?.packages?.join(',') === packageSpec,
    successfulToolResult: JSON.parse(packageEvents[0]?.data.result || '{}').status === 'success',
    physicalInstalledVersion: installedManifest.version === '5.4.19',
    manifestRequestsInstalledVersion: ['5.4.19', '^5.4.19', '~5.4.19'].includes(rootManifest.dependencies?.vite),
    lockfilePinnedVersion: lockfile.packages?.['node_modules/vite']?.version === '5.4.19',
    durableRootFiles: files.has('package-lock.json') && files.has('package.json'),
    agentVerifiedVersion: bashEvents.some((event) => /node_modules\/vite\/package\.json/.test(String(event.data.call?.arguments?.command || ''))),
    finalReportsVersion: final.includes('5.4.19'),
    canonicalPackageInstall: canonicalEvents.some((record) => (
      record.event.kind === 'tool'
      && record.event.action === 'package_install'
      && record.event.status === 'succeeded'
    )),
  }
  const passed = Object.values(checks).every(Boolean)
  const report = {
    schemaVersion: 'anera-package-install-smoke/2.0',
    generatedAt: new Date().toISOString(),
    productionBundle: true,
    providerFixture: false,
    arenaParityEvidence: false,
    packageSpec,
    sessionId: session.id,
    status: snapshot.session.status,
    usage: snapshot.session.usage,
    checks,
    completedTools: snapshot.events
      .filter((event) => event.type === 'tool.completed')
      .map((event) => event.data.call?.name),
    failedTools: snapshot.events
      .filter((event) => event.type === 'tool.failed' || event.type === 'tool.timed_out')
      .map((event) => event.data.call?.name),
    installedVersion: installedManifest.version,
    manifestDependency: rootManifest.dependencies?.vite,
    lockfileDependency: lockfile.packages?.['node_modules/vite']?.version,
    final,
    passed,
  }
  await mkdir(reportDirectory, { recursive: true })
  const timestamp = report.generatedAt.replaceAll(':', '-').replaceAll('.', '-')
  const reportPath = resolve(reportDirectory, `package-install-${timestamp}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ reportPath, passed, checks, usage: report.usage }, null, 2)}\n`)
  if (!passed) process.exitCode = 1
} finally {
  await agent?.shutdown()
  if (server) await new Promise((resolveClose) => server.close(() => resolveClose()))
  await rm(dataRoot, { recursive: true, force: true })
}

async function postJson(base, path, body, expectedStatus) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status !== expectedStatus) throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function waitForTerminal(base, sessionId, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    if (!response.ok) throw new Error(`Snapshot failed: ${response.status} ${await response.text()}`)
    const snapshot = await response.json()
    if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)) return snapshot
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  }
  throw new Error(`Session ${sessionId} did not finish before the package-install smoke deadline`)
}
