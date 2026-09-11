import './legacy-live-test-disabled.mjs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = resolve(process.cwd())
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-bash-failure-recovery-'))
const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/real-smokes')
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])
const expectedFile = Buffer.from('anera-probe-v1\n', 'utf8')
const expectedFileSha256 = sha256(expectedFile)
const expectedFinal = 'A02-SHELL-RECOVERY-OK hello.txt'
const failedCommand = "printf 'anera-probe-v1\\n' > hello.txt; printf 'A02-FAIL-STDOUT\\n'; printf 'A02-FAIL-STDERR\\n' >&2; exit 127"
const recoveryCommand = "od -An -tx1 hello.txt && printf '%s\\n' '---' && wc -c hello.txt"
const prompt = `Exercise this exact Arena-style Bash failure and recovery lifecycle in order.

1. Call bash exactly once with command ${JSON.stringify(failedCommand)}, cwd /home/user, and timeout 30. This command is expected to return exit code 127 after creating hello.txt and writing both stdout and stderr. Do not stop or repeat it.
2. Only after receiving that structured failed tool result, call bash exactly once with command ${JSON.stringify(recoveryCommand)}, cwd /home/user, and timeout 30. It must verify the file bytes and succeed.
3. Call present_file exactly once for /home/user/hello.txt.

Do not call any other tool. After all three tool results, output exactly ${expectedFinal} and nothing else.`

const provenancePaths = [
  'package.json',
  'scripts/bash-failure-recovery-smoke.mjs',
  'dist-server/server/app.js',
  'dist-server/server/agent-service.js',
  'dist-server/server/deepseek.js',
  'dist-server/server/network-policy.js',
  'dist-server/server/session-store.js',
  'dist-server/server/tools.js',
]

let server
let agent
let report
let reportPath

try {
  const provenance = await buildProvenance()
  const { createApp } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/app.js')).href)
  const created = await createApp({ dataRoot })
  agent = created.agent
  server = createServer(created.app)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Bash failure-recovery smoke server did not bind')
  const base = `http://127.0.0.1:${address.port}`

  const session = (await postJson(base, '/api/sessions', {}, 201)).session
  await postJson(base, `/api/sessions/${session.id}/messages`, {
    message: { text: prompt },
    metadata: { timezone: 'Asia/Shanghai', submissionSource: 'chat_input' },
    v2Source: 'agentic_chat_submit',
  }, 202)

  const snapshot = await waitForTerminal(base, session.id)
  const bashStarted = snapshot.events.filter((event) => (
    event.type === 'tool.started' && event.data.call?.name === 'bash'
  ))
  const bashFailed = snapshot.events.filter((event) => (
    event.type === 'tool.failed' && event.data.call?.name === 'bash'
  ))
  const bashCompleted = snapshot.events.filter((event) => (
    event.type === 'tool.completed' && event.data.call?.name === 'bash'
  ))
  const timedOut = snapshot.events.filter((event) => event.type === 'tool.timed_out')
  const failedEvent = bashFailed.find((event) => event.data.call?.arguments?.command === failedCommand)
  const recoveryEvent = bashCompleted.find((event) => event.data.call?.arguments?.command === recoveryCommand)
  const failedPayload = parseToolResult(failedEvent?.data.result)
  const recoveryPayload = parseToolResult(recoveryEvent?.data.result)
  const recoveryStarted = bashStarted.find((event) => event.data.call?.arguments?.command === recoveryCommand)
  const final = String(snapshot.events.findLast((event) => event.type === 'assistant.final')?.data?.content || '')
  const file = await readFile(resolve(created.store.workspaceDir(session.id), 'hello.txt'))
  const fileSha256 = sha256(file)
  const presented = snapshot.events.filter((event) => event.type === 'file.presented')

  const canonicalResponse = await fetch(`${base}/api/sessions/${session.id}/canonical.jsonl?task_id=A02-shell-recovery`)
  if (!canonicalResponse.ok) throw new Error(`Canonical trace failed: ${canonicalResponse.status}`)
  const canonicalEvents = (await canonicalResponse.text()).trim().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.recordType === 'event')
    .map((record) => record.event)
  const canonicalShell = canonicalEvents.filter((event) => event.kind === 'tool' && event.action === 'shell')
  const canonicalShellTerminal = canonicalShell.filter((event) => event.status === 'failed' || event.status === 'succeeded')

  const usage = snapshot.session.usage
  const activeDurationMs = Number(usage.activeDurationMs ?? usage.durationMs ?? 0)
  const checks = {
    currentProductionBundleFingerprinted: provenance.aggregateSha256.length === 64,
    sessionCompleted: snapshot.session.status === 'completed',
    exactBashStartCount: bashStarted.length === 2,
    exactFailedBashTerminal: bashFailed.length === 1 && Boolean(failedEvent),
    exactSuccessfulBashTerminal: bashCompleted.length === 1 && Boolean(recoveryEvent),
    noToolTimeout: timedOut.length === 0,
    failedCallActuallyExecuted: failedEvent?.data.notExecuted !== true,
    failedCallMarkedIsError: failedEvent?.data.isError === true,
    failedProcessStatusPreserved: failedPayload.status === 'completed',
    failedExitCodePreserved: failedPayload.exit_code === 127,
    failedStdoutPreserved: failedPayload.stdout === 'A02-FAIL-STDOUT\n',
    failedStderrPreserved: failedPayload.stderr === 'A02-FAIL-STDERR\n',
    recoveryStartedAfterFailureTerminal: Boolean(
      failedEvent && recoveryStarted
      && recoveryStarted.seq > failedEvent.seq
      && recoveryStarted.stepId !== failedEvent.stepId,
    ),
    recoverySucceeded: recoveryPayload.status === 'completed' && recoveryPayload.exit_code === 0,
    recoveryVerifiedExactBytes: /61\s+6e\s+65\s+72\s+61\s+2d\s+70\s+72\s+6f\s+62\s+65\s+2d\s+76\s+31\s+0a/.test(String(recoveryPayload.stdout || '')),
    recoveryVerifiedExactLength: /(?:^|\n)\s*15 hello\.txt(?:\n|$)/.test(String(recoveryPayload.stdout || '')),
    exactWorkspaceFile: file.equals(expectedFile),
    exactWorkspaceFileSha256: fileSha256 === expectedFileSha256,
    filePresentedExactlyOnce: presented.length === 1 && normalizeWorkspacePath(presented[0].data.path) === 'hello.txt',
    exactFinal: final === expectedFinal,
    canonicalFailedThenSucceeded: canonicalShellTerminal.length === 2
      && canonicalShellTerminal[0].status === 'failed'
      && canonicalShellTerminal[1].status === 'succeeded',
    modelCallBudget: Number(usage.modelCalls) <= 6,
    toolCallBudget: Number(usage.toolCalls) === 3,
    activeDurationBudget: activeDurationMs <= 35_000,
    estimatedCostBudget: Number(usage.estimatedCostUsd) <= 0.008,
  }
  const passed = Object.values(checks).every(Boolean)
  report = {
    schemaVersion: 'anera-bash-failure-recovery-smoke/1.0',
    generatedAt: new Date().toISOString(),
    productionBundle: true,
    modelExecution: 'real configured DeepSeek provider',
    providerFixture: false,
    arenaParityEvidence: false,
    arenaReferenceAnchors: ['A02', 'U03'],
    provenance,
    sessionId: session.id,
    model: snapshot.session.model,
    status: snapshot.session.status,
    prompt,
    expected: {
      failedCommand,
      recoveryCommand,
      filePath: 'hello.txt',
      fileBytes: expectedFile.length,
      fileSha256: expectedFileSha256,
      final: expectedFinal,
    },
    budgets: {
      modelCalls: 6,
      toolCalls: 3,
      activeDurationMs: 35_000,
      estimatedCostUsd: 0.008,
    },
    usage: {
      ...usage,
      activeDurationMs,
    },
    checks,
    toolTrace: [failedEvent, recoveryEvent].filter(Boolean).map((event) => ({
      seq: event.seq,
      stepId: event.stepId,
      callId: event.callId,
      terminal: event.type,
      command: event.data.call?.arguments?.command,
      isError: event.data.isError,
      result: parseToolResult(event.data.result),
    })),
    file: { path: 'hello.txt', bytes: file.length, sha256: fileSha256 },
    final,
    canonicalShell: canonicalShell.map((event) => ({ status: event.status, result: event.tool?.result })),
    passed,
  }
  reportPath = await writeReport(report)
  process.stdout.write(`${JSON.stringify({ reportPath, passed, checks, usage: report.usage, provenance: report.provenance }, null, 2)}\n`)
  if (!passed) process.exitCode = 1
} catch (error) {
  const provenance = await buildProvenance().catch(() => undefined)
  report = {
    schemaVersion: 'anera-bash-failure-recovery-smoke/1.0',
    generatedAt: new Date().toISOString(),
    productionBundle: true,
    modelExecution: 'real configured DeepSeek provider',
    providerFixture: false,
    arenaParityEvidence: false,
    arenaReferenceAnchors: ['A02', 'U03'],
    ...(provenance ? { provenance } : {}),
    error: safeError(error),
    passed: false,
  }
  reportPath = await writeReport(report)
  process.stderr.write(`${JSON.stringify({ reportPath, passed: false, error: report.error }, null, 2)}\n`)
  process.exitCode = 1
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
  if (response.status !== expectedStatus) {
    throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`)
  }
  return await response.json()
}

async function waitForTerminal(base, sessionId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/sessions/${sessionId}`)
    if (!response.ok) throw new Error(`Snapshot ${sessionId} failed: ${response.status} ${await response.text()}`)
    const current = await response.json()
    if (terminalStatuses.has(current.session.status)) return current
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Session ${sessionId} did not finish within ${timeoutMs}ms`)
}

async function buildProvenance() {
  const files = {}
  for (const path of provenancePaths) {
    files[path] = sha256(await readFile(resolve(projectRoot, path)))
  }
  const aggregateInput = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, hash]) => `${path}\0${hash}\n`)
    .join('')
  return {
    gitCommit: null,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    files,
    aggregateSha256: sha256(Buffer.from(aggregateInput, 'utf8')),
  }
}

async function writeReport(value) {
  await mkdir(reportDirectory, { recursive: true })
  const timestamp = value.generatedAt.replaceAll(':', '-').replaceAll('.', '-')
  const path = resolve(reportDirectory, `bash-failure-recovery-${timestamp}.json`)
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  if (/DEEPSEEK_API_KEY|authorization\s*[:=]|bearer\s+[A-Za-z0-9._~-]+|\bsk-[A-Za-z0-9_-]{12,}/i.test(serialized)) {
    throw new Error('Refusing to write a smoke report containing credential-shaped text')
  }
  await writeFile(path, serialized, 'utf8')
  return path
}

function parseToolResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed }
  } catch {
    return { value: String(value || '') }
  }
}

function normalizeWorkspacePath(value) {
  return String(value || '').replace(/^\/?home\/user\//, '').replace(/^\/+/, '')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\b(?:sk-|ds-)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .slice(0, 2_000)
}
