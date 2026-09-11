import './legacy-live-test-disabled.mjs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fingerprintProductionImplementation } from '../dist-server/eval/implementation-fingerprint.js'

const projectRoot = resolve(process.cwd())
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-html-slides-canary-'))
const prompt = '看看本周的AI领域热点，创建一个精美的HTML Slides进行展示。'
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])
let server
let agent
let base = ''

try {
  const [{ createApp }, { config }, { isSingleArtifactWebTask, isVisualWebArtifactTask, visualWebArtifactCompletionGap }] = await Promise.all([
    import(pathToFileURL(resolve(projectRoot, 'dist-server/server/app.js')).href),
    import(pathToFileURL(resolve(projectRoot, 'dist-server/server/config.js')).href),
    import(pathToFileURL(resolve(projectRoot, 'dist-server/server/agent-service.js')).href),
  ])
  const created = await createApp({
    dataRoot,
    agent: {
      toolExecutorDependencies: {
        localAppBaseUrl: () => base,
      },
    },
  })
  agent = created.agent
  server = createServer(created.app)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTML Slides canary server did not bind')
  base = `http://127.0.0.1:${address.port}`

  const createResponse = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!createResponse.ok) throw new Error(`Create session failed: ${createResponse.status} ${await createResponse.text()}`)
  const { session } = await createResponse.json()
  const submitResponse = await fetch(`${base}/api/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: prompt, attachments: [] }),
  })
  if (!submitResponse.ok) throw new Error(`Submit failed: ${submitResponse.status} ${await submitResponse.text()}`)

  const deadline = Date.now() + Number(process.env.ANERA_HTML_SLIDES_TIMEOUT_MS || 600_000)
  let snapshot
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/sessions/${session.id}`)
    if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`)
    snapshot = await response.json()
    if (terminalStatuses.has(snapshot.session.status)) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
  }
  if (!snapshot || !terminalStatuses.has(snapshot.session.status)) {
    throw new Error(`HTML Slides task did not reach a terminal state before the deadline: ${snapshot?.session?.status || 'no snapshot'}`)
  }

  const started = snapshot.events.filter((event) => event.type === 'tool.started')
  const completed = snapshot.events.filter((event) => event.type === 'tool.completed' && event.data.notExecuted !== true)
  const failed = snapshot.events.filter((event) => event.type === 'tool.failed')
  const timedOut = snapshot.events.filter((event) => event.type === 'tool.timed_out')
  const completedCalls = completed.map((event) => event.data.call || {})
  const completedNames = completedCalls.map((call) => call.name)
  const successfulPresent = completed.find((event) => event.data.call?.name === 'present_file')
  const presentedPath = normalizeWorkspacePath(successfulPresent?.data.call?.arguments?.path)
  const htmlArtifact = snapshot.artifacts.find((artifact) => normalizeWorkspacePath(artifact.path) === presentedPath && /\.html?$/i.test(artifact.path))
    || snapshot.artifacts.find((artifact) => /\.html?$/i.test(artifact.path))
  if (!htmlArtifact) throw new Error('No HTML artifact was produced')

  const download = await fetch(`${base}/api/sessions/${session.id}/download?path=${encodeURIComponent(htmlArtifact.path)}`)
  if (!download.ok) throw new Error(`HTML artifact download failed: ${download.status}`)
  const htmlBytes = Buffer.from(await download.arrayBuffer())
  const html = htmlBytes.toString('utf8')
  const completedIndex = (predicate) => completed.findIndex((event) => predicate(event.data.call || {}, event))
  const completedLastIndex = (predicate, before = completed.length) => {
    for (let index = Math.min(before, completed.length) - 1; index >= 0; index -= 1) {
      if (predicate(completed[index].data.call || {}, completed[index])) return index
    }
    return -1
  }
  const searchIndex = completedIndex((call) => ['web_search', 'fetch_page'].includes(call.name))
  const writeIndex = completedIndex((call) => call.name === 'write_file' && /\.html?$/i.test(String(call.arguments?.path || '')))
  const previewIndex = completedIndex((call) => ['start_process', 'build_and_start'].includes(call.name))
  const presentIndex = completedLastIndex((call) => call.name === 'present_file')
  const inspectIndex = completedLastIndex((call) => call.name === 'inspect_image', presentIndex >= 0 ? presentIndex : completed.length)
  const screenshotIndex = completedLastIndex((call) => call.name === 'browser' && call.arguments?.action === 'screenshot', inspectIndex >= 0 ? inspectIndex : completed.length)
  const navigationIndex = completedLastIndex((call) => call.name === 'browser' && ['click', 'press'].includes(call.arguments?.action), screenshotIndex >= 0 ? screenshotIndex : completed.length)
  const openIndex = completedLastIndex((call) => call.name === 'browser' && call.arguments?.action === 'open', navigationIndex >= 0 ? navigationIndex : completed.length)
  const screenshotCall = completedCalls[screenshotIndex]
  const screenshotPath = normalizeWorkspacePath(screenshotCall?.arguments?.screenshot_path || screenshotCall?.arguments?.path)
  let screenshotBytes = Buffer.alloc(0)
  if (screenshotPath) {
    const response = await fetch(`${base}/api/sessions/${session.id}/download?path=${encodeURIComponent(screenshotPath)}`)
    if (response.ok) screenshotBytes = Buffer.from(await response.arrayBuffer())
  }
  const inspectionEvent = completed[inspectIndex]
  const inspectionPassed = /\bNO DEFECTS\b/i.test(String(inspectionEvent?.data.result || ''))
  const sourceUrls = [...new Set(html.match(/https?:\/\/[^\s<>'"]+/g) || [])]
    .map((url) => url.replace(/[),.;:!?]+$/, ''))
  const externalExecutableAssets = /<script\b[^>]*\bsrc\s*=|<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html)
  const final = String(snapshot.events.findLast((event) => event.type === 'assistant.final')?.data.content || '')
  const sequencePassed = [searchIndex, writeIndex, previewIndex, openIndex, navigationIndex, screenshotIndex, inspectIndex, presentIndex]
    .every((value, index, all) => value >= 0 && (index === 0 || value > all[index - 1]))
  const unexpectedFailures = failed.filter((event) => event.data.notExecuted !== true)
  const internalState = await created.store.get(session.id)
  const completionGap = visualWebArtifactCompletionGap(internalState.messages, {
    forceTask: true,
    requiresResearch: true,
    canonicalPath: htmlArtifact.path,
  })
  const checks = {
    completed: snapshot.session.status === 'completed',
    canonicalWorkflowComplete: completionGap === undefined,
    exactPromptPreserved: snapshot.events.some((event) => event.type === 'turn.started' && event.data.content === prompt),
    fullToolSequence: sequencePassed,
    researchBeforeArtifact: searchIndex >= 0 && searchIndex < writeIndex,
    htmlArtifactPresented: Boolean(successfulPresent && htmlArtifact.path === presentedPath),
    htmlDocumentComplete: /<!doctype\s+html/i.test(html) && /<html\b/i.test(html) && /<\/html\s*>/i.test(html),
    substantialArtifact: htmlBytes.length >= 8_000,
    accessibleNavigationPresent: /<button\b/i.test(html) && /(?:ArrowRight|keydown|aria-label)/i.test(html),
    visibleSourceLinks: sourceUrls.length > 0,
    selfContainedExecutableAssets: !externalExecutableAssets,
    browserScreenshotSaved: screenshotBytes.length > 0 && screenshotBytes.subarray(1, 4).toString('ascii') === 'PNG',
    visionInspectionPassed: inspectionPassed,
    noUnexpectedToolFailures: unexpectedFailures.length === 0,
    oneFinal: snapshot.events.filter((event) => event.type === 'assistant.final').length === 1 && final.length > 0,
    boundedEfficiency: snapshot.session.usage.modelCalls <= 30
      && snapshot.session.usage.toolCalls <= 30
      && snapshot.session.usage.activeDurationMs <= 600_000
      && snapshot.session.usage.estimatedCostUsd <= 0.15,
  }
  const generatedAt = new Date().toISOString()
  const evidenceDirectory = resolve(projectRoot, 'reports/real-smokes', `html-slides-${generatedAt.replace(/[:.]/g, '-')}`)
  await mkdir(evidenceDirectory, { recursive: true })
  const artifactEvidencePath = resolve(evidenceDirectory, basename(htmlArtifact.path))
  await writeFile(artifactEvidencePath, htmlBytes)
  let screenshotEvidencePath
  if (screenshotBytes.length > 0) {
    screenshotEvidencePath = resolve(evidenceDirectory, basename(screenshotPath))
    await writeFile(screenshotEvidencePath, screenshotBytes)
  }
  const implementationFingerprint = await fingerprintProductionImplementation(projectRoot, {
    verifierPaths: ['scripts/html-slides-task-smoke.mjs'],
  })
  const report = {
    schemaVersion: 'anera-html-slides-live-canary/1.0',
    generatedAt,
    productionBundle: true,
    liveProviders: true,
    prompt,
    mobileExcluded: true,
    arenaExactParityClaimed: false,
    implementationFingerprint,
    providerIdentity: {
      agentModel: config.model,
      visionModel: config.visionModel,
      temperature: config.modelTemperature,
    },
    internalWorkflowDiagnostic: {
      classifiedSingleArtifact: isSingleArtifactWebTask(internalState.messages),
      classifiedVisualWebArtifact: isVisualWebArtifactTask(internalState.messages),
      completionGap: completionGap ?? null,
    },
    sessionId: session.id,
    status: snapshot.session.status,
    usage: snapshot.session.usage,
    checks,
    toolSequence: started.map((event) => ({
      name: event.data.call?.name,
      action: event.data.call?.arguments?.action,
      arguments: diagnosticToolArguments(event.data.call?.arguments),
      at: event.at,
      callId: event.callId,
    })),
    verificationRequiredCalls: snapshot.events
      .filter((event) => event.type === 'tool.completed' && event.data.notExecuted === true)
      .map((event) => ({ callId: event.callId, name: event.data.call?.name, reason: event.data.reason, result: event.data.result })),
    toolFailures: failed.map((event) => ({
      callId: event.callId,
      name: event.data.call?.name,
      arguments: diagnosticToolArguments(event.data.call?.arguments),
      notExecuted: event.data.notExecuted === true,
      reason: event.data.reason,
      result: event.data.result,
    })),
    toolTimeouts: timedOut.map((event) => ({
      callId: event.callId,
      name: event.data.call?.name,
      arguments: diagnosticToolArguments(event.data.call?.arguments),
      result: event.data.result,
    })),
    inspectionAttempts: completed
      .filter((event) => event.data.call?.name === 'inspect_image')
      .map((event) => ({
        callId: event.callId,
        path: event.data.call?.arguments?.path,
        passed: /\bNO DEFECTS\b/i.test(String(event.data.result || '')),
        result: event.data.result,
      })),
    unexpectedToolFailures: unexpectedFailures.map((event) => ({
      callId: event.callId,
      name: event.data.call?.name,
      result: event.data.result,
    })),
    artifact: {
      path: htmlArtifact.path,
      bytes: htmlBytes.length,
      sha256: sha256(htmlBytes),
      sourceUrlCount: sourceUrls.length,
      evidencePath: artifactEvidencePath,
    },
    screenshot: screenshotEvidencePath ? {
      path: screenshotPath,
      bytes: screenshotBytes.length,
      sha256: sha256(screenshotBytes),
      evidencePath: screenshotEvidencePath,
    } : null,
    website: snapshot.website,
    terminalDiagnostics: snapshot.events
      .filter((event) => ['run.status', 'run.failed', 'run.timed_out', 'turn.completed'].includes(event.type))
      .slice(-12)
      .map((event) => ({ type: event.type, at: event.at, data: event.data })),
    final,
    passed: Object.values(checks).every(Boolean),
  }
  const reportPath = resolve(evidenceDirectory, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({
    reportPath,
    passed: report.passed,
    sessionId: report.sessionId,
    usage: report.usage,
    checks: report.checks,
    toolFailures: report.toolFailures,
    toolTimeouts: report.toolTimeouts,
    artifact: report.artifact,
    screenshot: report.screenshot,
  }, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} finally {
  await agent?.shutdown()
  if (server) await new Promise((resolveClose) => server.close(() => resolveClose()))
  await rm(dataRoot, { recursive: true, force: true })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeWorkspacePath(value) {
  return String(value || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^file:\/\/+/i, '/')
    .replace(/^\/home\/user\/?/i, '')
    .replace(/^~\/?/, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
}

function diagnosticToolArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const argumentsCopy = { ...value }
  if (typeof argumentsCopy.content === 'string') {
    argumentsCopy.content = `[omitted ${Buffer.byteLength(argumentsCopy.content, 'utf8')} bytes]`
  }
  return argumentsCopy
}
