/** Isolated, offline replay of a retained failed session's public Resume path.
 * No source-state rewriting, threshold overrides, model summaries, edits,
 * Browser work, external fetches, or final delivery are permitted by default.
 * --refresh-preview permits one managed preview, one Browser open, one cover
 * screenshot tool call, and (if required) one local source verification in a
 * fresh copy. An owned CLI browser checks page loading before workflow capture.
 * Usage: node --import tsx scripts/reference-resource-routing-replay.ts <root> <session> <ledger> [--refresh-preview]
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { relative, resolve } from 'node:path'
import { smokeLocalPage } from '../src/eval/local-page-smoke.js'
import { AgentService, canonicalDiagnosticReadCursor, canonicalResearchHtmlContentGap,
  latestVisualBrowserEnvironmentResetIndex, referenceStyleArtifactRepairPhase,
  visualArtifactDefectRepairPhase, visualWebArtifactCompletionGap, visualWebArtifactRequiredToolNames } from '../src/server/agent-service.js'
import { config } from '../src/server/config.js'
import { createApp } from '../src/server/app.js'
import { SessionStore, type StoredSession } from '../src/server/session-store.js'
import { ToolExecutor, type ToolDefinition, type ToolContext } from '../src/server/tools.js'
import type { ModelMessage, ToolCallRecord } from '../src/shared/types.js'

assert(process.argv[2] && process.argv[3] && process.argv[4], 'Supply the source root, session ID, and protected budget ledger.')
const originalRoot = resolve(process.argv[2])
const sessionId = process.argv[3]
assert.match(sessionId, /^ses_[a-z0-9]+$/u)
const ledgerPath = resolve(process.argv[4])
assert(process.argv.slice(5).every((argument) => argument === '--refresh-preview'), 'Unknown replay option.')
const refreshPreview = process.argv.includes('--refresh-preview')
const originalSession = resolve(originalRoot, 'sessions', sessionId)
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const originalState = JSON.parse(await readFile(resolve(originalSession, 'state.json'), 'utf8')) as StoredSession
const artifact = originalState.activeVisualArtifact
assert(artifact && !artifact.path.startsWith('/') && !artifact.path.includes('..'), 'Need an existing canonical artifact.')
assert(originalState.activeReferenceStyleContract?.runtimeEvidence, 'Need the actual retained private runtime evidence.')
assert.equal(originalState.summary.status, 'failed', 'This replay must start from the actual failed session.')

async function treeHashes(directory: string): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const hashes: Array<{ path: string; sha256: string; bytes: number }> = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name)
    assert(!(await lstat(path)).isSymbolicLink(), `Refuse to follow a source-session symlink: ${path}`)
    if (entry.isDirectory()) hashes.push(...await treeHashes(path))
    else if (entry.isFile()) {
      const bytes = await readFile(path)
      hashes.push({ path, sha256: sha256(bytes), bytes: bytes.byteLength })
    }
  }
  return hashes
}
const before = await treeHashes(originalSession)
const ledgerBefore = sha256(await readFile(ledgerPath))
const artifactBefore = sha256(await readFile(resolve(originalSession, 'workspace', artifact.path)))
const outputRoot = await mkdtemp(resolve(tmpdir(), 'anera-reference-resource-routing-replay-'))
const copyRoot = resolve(outputRoot, 'isolated-root')
await mkdir(resolve(copyRoot, 'sessions'), { recursive: true })
await cp(originalSession, resolve(copyRoot, 'sessions', sessionId), { recursive: true })
let store = new SessionStore(copyRoot, originalState.summary.model)
let agent: AgentService | undefined
let appServer: Server | undefined
let appOrigin = ''
let independentSmokeAcknowledged = false
const independentSmoke: Record<string, unknown> = { scope: 'page-load-only; not workflow/render attestation', passed: false }
let initialEventSeq = 0
// Production phase normalization owns this path. Only the isolated copy's
// screenshot may be replaced; every original-session file remains protected.
const screenshotPath = artifact.path.replace(/\.html?$/iu, '') + '-reference-cover.png'
// Match the managed-preview contract; the App front door remains loopback-only.
const previewCommand = 'python3 -m http.server 0 --bind 0.0.0.0'
const issued = { startProcess: 0, browserOpen: 0, coverScreenshot: 0, sourceVerification: 0 }
const localFetches: Array<{ method: string; url: string }> = []
const originalFetch = globalThis.fetch

function snapshot(state: StoredSession) {
  const evidence = state.activeTaskResearchEvidence
  const gap = visualWebArtifactCompletionGap(state.messages, { forceTask: true, requiresResearch: true,
    requireResearchBrief: true, requirePrivateVisualEvidence: true, requireCurrentReferenceVerifier: true,
    referenceContract: state.activeReferenceStyleContract,
    referenceContractInvalidated: Boolean(state.referenceStyleEvidenceInvalidation),
    referenceSourceResolution: state.activeReferenceSourceResolution,
    canonicalPath: artifact!.path, canonicalArtifact: state.activeVisualArtifact,
    slidePlan: state.activeVisualWebSlidePlan,
    researchSourceUrls: evidence?.sourceUrls, researchPageReads: evidence?.pageReads,
    researchBrief: evidence?.brief, researchUnavailableSourceUrls: evidence?.unavailableSourceUrls,
  })
  return { firstMissingPhase: gap?.missingPhases[0], missingPhases: gap?.missingPhases,
    dependencyOrderedRequiredTools: gap ? [...visualWebArtifactRequiredToolNames(gap) ?? []] : [],
    renderRepair: gap?.renderRepair, researchPending: gap?.research?.pending,
    researchNeedsBrief: gap?.research?.needsBrief,
    referenceRepair: referenceStyleArtifactRepairPhase(state.messages, artifact!.path),
    visualRepair: visualArtifactDefectRepairPhase(state.messages, artifact!.path, gap?.interactionRepair),
    canonicalCursor: canonicalDiagnosticReadCursor(state.messages, artifact!.path),
    browserResetIndex: latestVisualBrowserEnvironmentResetIndex(state.messages),
    activeArtifactHash: state.activeVisualArtifact?.currentHash,
    invalidation: state.referenceStyleEvidenceInvalidation }
}
const originalSnapshot = snapshot(originalState)
const requests: Record<string, unknown>[] = []
const executions: Record<string, unknown>[] = []
let manifestRead = false
let templateRead = false
let stopReason: string | undefined
let replayError: string | undefined
let baselineGates: string[] | undefined
let forbiddenAttempts = 0
let fakeClientCalls = 0
class OfflineReplayStop extends Error {}
const deny = async (): Promise<never> => {
  forbiddenAttempts += 1
  replayError ??= 'OFFLINE_REPLAY_DENIED: external fetches, models, Vision, mutations, and unapproved Browser/Process operations are forbidden.'
  throw new Error(replayError)
}
const offlineFetch: typeof fetch = async (input, init) => {
  if (!refreshPreview) return await deny()
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const port = Number(url.port)
  const managedPort = agent?.processes.list(sessionId).some((process) => process.status === 'running'
    && (process.port === port || process.listeningPorts?.some((listener) => listener.port === port)))
  if (url.protocol !== 'http:' || url.username || url.password
    || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || (url.origin !== appOrigin && !managedPort)) return await deny()
  localFetches.push({ method: init?.method ?? (input instanceof Request ? input.method : 'GET'), url: url.href })
  // An owned loopback probe must never redirect to an external URL.
  return await originalFetch(input, { ...init, redirect: 'error' })
}
globalThis.fetch = offlineFetch
const forbidden = new Proxy({}, { get: () => deny })
let executor = new ToolExecutor(store, forbidden as never, forbidden as never,
  { inspect: deny }, async () => false, { fetch: offlineFetch, imageApiKey: '' })
const executeRead = async (call: ToolCallRecord, context: ToolContext) => {
  const allowed = ['read_reference_resource', 'read_file', ...(refreshPreview ? ['start_process', 'browser', 'verify_reference_style'] : [])]
  assert(allowed.includes(call.name), 'Replay attempted an unauthorized tool.')
  if (call.name === 'read_file' || call.name === 'verify_reference_style') assert.equal(call.arguments.path, artifact.path)
  if (call.name === 'read_reference_resource') assert.equal(call.arguments.source_sha256, originalState.activeReferenceStyleContract!.provenance.evidenceSha256)
  if (call.name === 'start_process') assert.deepEqual(call.arguments, { command: previewCommand, cwd: '/home/user', name: 'Offline reference replay', startup_wait: 3 })
  if (call.name === 'browser') {
    if (call.arguments.action === 'open') assert.deepEqual(call.arguments, { action: 'open', path: artifact.path,
      ...originalState.activeReferenceStyleContract!.contract.viewport })
    else assert.deepEqual(call.arguments, { action: 'screenshot', screenshot_path: screenshotPath })
  }
  const result = await executor.execute(call, context)
  let payload: Record<string, unknown>
  try { payload = JSON.parse(result.content) } catch {
    assert(call.name === 'browser' && call.arguments.action === 'screenshot' && !result.isError, result.content.slice(0, 1500))
    payload = { status: 'success', initial_screenshot_message: result.content }
  }
  executions.push({ name: call.name, arguments: call.arguments, isError: result.isError,
    status: payload.status, kind: payload.kind, resultSha256: sha256(result.content),
    resultBytes: Buffer.byteLength(result.content), contentBytes: typeof payload.content === 'string' ? Buffer.byteLength(payload.content) : undefined,
    hasMore: payload.hasMore, nextOffset: payload.nextOffset, nextContentOffset: payload.nextContentOffset,
    has_more: payload.has_more, next_cursor: payload.next_cursor,
    resources: payload.resources, message: result.isError ? payload.message : undefined })
  assert.equal(result.isError, false, result.content.slice(0, 1500))
  if (call.name === 'read_reference_resource') {
    if (call.arguments.resource_id === undefined) manifestRead = true
    else templateRead = true
  }
  return result
}
const execute = async (call: ToolCallRecord, context: ToolContext) => {
  try { return await executeRead(call, context) }
  catch (error) {
    replayError ??= error instanceof Error ? error.message : String(error)
    throw error
  }
}
function toolResponse(name: string, args: Record<string, unknown>) {
  return { content: '', reasoningContent: 'Isolated deterministic routing fixture; no model generation.',
    toolCalls: [{ id: `offline-resource-routing-${fakeClientCalls}`, type: 'function' as const,
      function: { name, arguments: JSON.stringify(args) } }], finishReason: 'tool_calls' as const,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 }, modelCallCount: 0 }
}
async function awaitIndependentSmoke() {
  const previewUrl = `${appOrigin}/workspace/${sessionId}/preview/${artifact!.path.split('/').map(encodeURIComponent).join('/')}`
  Object.assign(independentSmoke, { previewUrl }, await smokeLocalPage({
    url: previewUrl,
    outputRoot,
    cli: process.env.ANERA_REFERENCE_REPLAY_BROWSER_CLI,
    browserExecutablePath: config.browserExecutablePath,
  }))
  independentSmokeAcknowledged = true
}
const readOnlyRequest = async (options: { tools: ToolDefinition[]; messages: ModelMessage[]; thinking?: string; maxOutputTokens?: number }) => {
  fakeClientCalls += 1
  const current = snapshot(await store.get(sessionId))
  const names = options.tools.map((tool) => tool.function.name)
  const compaction = names.length === 0 && options.thinking === 'disabled'
  requests.push({ index: fakeClientCalls, names, compaction, maxOutputTokens: options.maxOutputTokens,
    snapshot: current, toolConstraints: options.tools.map((tool) => ({ name: tool.function.name, parameters: tool.function.parameters })),
    instructions: options.messages.flatMap((message) => typeof message.content === 'string'
      ? message.content.split('\n').filter((line) => /next durable phase|Optional repair input|diagnostic step|only mutation tool/u.test(line)) : []).map((line) => line.slice(0, 2200)) })
  if (compaction) {
    stopReason = 'compaction_required_under_real_configuration'
    throw new OfflineReplayStop('OFFLINE_REPLAY_STOP: do not synthesize a model checkpoint or raise context thresholds.')
  }
  assert(fakeClientCalls <= 16, 'Unexpected bounded replay loop; stop without further work.')
  if (refreshPreview && !names.includes('read_reference_resource')) {
    if (names.includes('verify_reference_style')) {
      assert.equal(issued.sourceVerification++, 0, 'Only one local source verification is permitted.')
      return toolResponse('verify_reference_style', { path: artifact.path })
    }
    if (names.includes('start_process')) {
      assert.equal(issued.startProcess++, 0, 'Only one managed preview startup is permitted.')
      return toolResponse('start_process', { command: previewCommand, cwd: '/home/user', name: 'Offline reference replay', startup_wait: 3 })
    }
    if (names.includes('browser')) {
      const properties = options.tools.find((tool) => tool.function.name === 'browser')!.function.parameters.properties as Record<string, { enum?: unknown[] }>
      const actions = properties.action?.enum ?? []
      if (actions.includes('open')) {
        assert.equal(issued.startProcess, 1, 'The real managed preview must start before Browser open.')
        assert.equal(issued.browserOpen++, 0, 'Only one Browser open is permitted.')
        if (!independentSmokeAcknowledged) await awaitIndependentSmoke()
        return toolResponse('browser', { action: 'open', path: artifact.path,
          ...originalState.activeReferenceStyleContract!.contract.viewport })
      }
      if (actions.includes('screenshot') && current.missingPhases?.includes('reference_cover_screenshot')) {
        assert.equal(issued.browserOpen, 1, 'The current Browser epoch must exist before its cover screenshot.')
        assert.equal(issued.coverScreenshot++, 0, 'Only one cover screenshot tool call is permitted.')
        return toolResponse('browser', { action: 'screenshot', screenshot_path: screenshotPath })
      }
      stopReason = 'refresh_preview_scope_exhausted_before_reference_resources'
      throw new OfflineReplayStop('OFFLINE_REPLAY_STOP: do not navigate or capture any additional Browser state.')
    }
    if (names.includes('inspect_image')) {
      stopReason = 'vision_required_before_reference_resource_repair'
      throw new OfflineReplayStop('OFFLINE_REPLAY_STOP: Vision is outside this offline replay.')
    }
  }
  if (!names.includes('read_reference_resource')) {
    stopReason = 'reference_resource_capability_not_available_at_public_resume_boundary'
    throw new OfflineReplayStop('OFFLINE_REPLAY_STOP: required auxiliary capability is absent; no state rewrite or unauthorized execution.')
  }
  baselineGates ??= current.missingPhases
  assert.deepEqual(current.missingPhases, baselineGates, 'Read-only operations must not satisfy acceptance gates.')
  let name: string
  let args: Record<string, unknown>
  if (!manifestRead) {
    name = 'read_reference_resource'
    args = { source_sha256: originalState.activeReferenceStyleContract!.provenance.evidenceSha256 }
  } else if (names.includes('read_file') && !names.includes('edit_file')) {
    name = 'read_file'
    args = { ...current.canonicalCursor }
  } else if (!templateRead) {
    name = 'read_reference_resource'
    args = { source_sha256: originalState.activeReferenceStyleContract!.provenance.evidenceSha256, resource_id: 'template', max_bytes: 1024 }
  } else {
    stopReason = 'reference_and_candidate_reads_completed_without_mutation_or_gate_advancement'
    throw new OfflineReplayStop('OFFLINE_REPLAY_STOP: read-only replay reached its boundary; no edit or acceptance operation.')
  }
  return toolResponse(name, args)
}
const stream = async (options: Parameters<typeof readOnlyRequest>[0]) => {
  // A compaction error can be retained and followed by a normal model step;
  // an observed stop boundary must still prevent every subsequent tool.
  if (replayError) throw new Error(replayError)
  if (stopReason) throw new OfflineReplayStop(`OFFLINE_REPLAY_STOP: ${stopReason}`)
  try { return await readOnlyRequest(options) }
  catch (error) {
    if (!(error instanceof OfflineReplayStop)) replayError ??= error instanceof Error ? error.message : String(error)
    throw error
  }
}
let report: Record<string, unknown>
try {
  if (refreshPreview) {
    const created = await createApp({ dataRoot: copyRoot, model: originalState.summary.model,
      agent: { client: { stream } as never, tools: { execute }, vision: { inspect: deny }, runTimeoutMs: 120_000,
        toolExecutorDependencies: { fetch: offlineFetch, imageApiKey: '' } } })
    store = created.store
    agent = created.agent
    const previewPath = `/workspace/${sessionId}/preview/${artifact.path.split('/').map(encodeURIComponent).join('/')}`
    appServer = createServer((request, response) => {
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405).end(); return }
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      // The harness has no icon; do not turn a browser's automatic request
      // into an unrelated console 404. All application routes stay restricted.
      if (path === '/favicon.ico') { response.writeHead(204).end(); return }
      if (path !== previewPath) { response.writeHead(404).end(); return }
      created.app(request, response)
    })
    await new Promise<void>((done, reject) => {
      appServer!.once('error', reject)
      appServer!.listen(0, '127.0.0.1', () => { appServer!.off('error', reject); done() })
    })
    const address = appServer.address()
    assert(address && typeof address !== 'string', 'The isolated App must have a loopback port.')
    appOrigin = `http://127.0.0.1:${address.port}`
    executor = new ToolExecutor(store, agent.processes, agent.browser, { inspect: deny }, async () => false,
      { fetch: offlineFetch, imageApiKey: '', localAppBaseUrl: () => appOrigin })
  } else {
    await store.initialize()
    agent = new AgentService(store, { client: { stream } as never, tools: { execute }, vision: { inspect: deny }, runTimeoutMs: 10_000 })
  }
  initialEventSeq = (await store.events(sessionId)).at(-1)?.seq ?? 0
  await agent.resume(sessionId)
  for (let attempt = 0; agent.isRunning(sessionId) && attempt < (refreshPreview ? 13_000 : 1500); attempt += 1) {
    await new Promise((done) => setTimeout(done, 10))
  }
  assert(!agent.isRunning(sessionId), 'Offline replay did not settle.')
} catch (error) {
  if (!(error instanceof OfflineReplayStop)) replayError ??= error instanceof Error ? error.message : String(error)
}
finally {
  try { await agent?.shutdown() }
  finally {
    if (appServer) {
      appServer.closeAllConnections()
      await new Promise<void>((done, reject) => appServer!.close((error) => error ? reject(error) : done()))
    }
  }
  const after = await treeHashes(originalSession)
  const originalUnchanged = JSON.stringify(before) === JSON.stringify(after)
  const ledgerUnchanged = sha256(await readFile(ledgerPath)) === ledgerBefore
  const copyArtifactUnchanged = sha256(await readFile(resolve(copyRoot, 'sessions', sessionId, 'workspace', artifact.path))) === artifactBefore
  const finalState = JSON.parse(await readFile(resolve(copyRoot, 'sessions', sessionId, 'state.json'), 'utf8')) as StoredSession
  const finalSnapshot = snapshot(finalState)
  const events = await store.events(sessionId)
  const newToolResults = events.filter((event) => event.seq > initialEventSeq
    && ['tool.completed', 'tool.failed'].includes(event.type)).map((event) => {
    const call = event.data.call as ToolCallRecord | undefined
    let result: Record<string, unknown> = {}
    try { result = JSON.parse(String(event.data.result)) } catch { /* Preserve terminal status even for non-JSON errors. */ }
    return { seq: event.seq, type: event.type, call, isError: event.data.isError,
      result: Object.fromEntries(Object.entries(result).filter(([key]) =>
        ['status', 'kind', 'url', 'pageEpoch', 'screenshot_path', 'screenshot_sha256', 'artifact_hash', 'fidelity', 'score', 'message'].includes(key)
          || key.startsWith('render_'))) }
  })
  const evidence = finalState.activeTaskResearchEvidence
  const contentGap = await canonicalResearchHtmlContentGap(store.workspaceDir(sessionId), finalState.messages,
    artifact.path, evidence?.sourceUrls ?? [], { requiresResearch: true, requiresPageBody: true, requireResearchBrief: true,
      researchBrief: evidence?.brief, researchPageReads: evidence?.pageReads ?? [] })
  const observationCompleted = stopReason !== undefined && replayError === undefined
  report = { kind: 'isolated-reference-resource-routing-replay', originalRoot, sessionId, outputRoot, copyRoot,
    boundary: stopReason ?? 'unclassified_failure', observationCompleted, replayError,
    policy: { publicResume: true, refreshPreview, originalStateRewritten: false, contextThresholdsOverridden: false,
      contextWindowTokens: config.contextWindowTokens, contextCompactionThresholdTokens: config.contextCompactionThresholdTokens },
    originalSnapshot, finalSnapshot, contentGap, requests, executions, newToolResults,
    appOrigin, independentSmokeAcknowledged, independentSmoke, issued, localFetches,
    liveProviderCalls: 0, fakeClientCalls, forbiddenAttempts, artifactEdits: 0, canonicalHtmlEdits: 0,
    isolatedScreenshotPath: issued.coverScreenshot ? screenshotPath : undefined,
    browserToolCalls: executions.filter((entry) => entry.name === 'browser').length,
    screenshotNote: 'At most one cover screenshot tool call; production may replace its initial capture with the atomic render-attested capture. No Vision or full visual acceptance is claimed.',
    originalUnchanged, ledgerUnchanged, copyArtifactUnchanged,
    ledger: { path: ledgerPath, sha256: ledgerBefore }, artifactSha256: artifactBefore,
    protectedOriginalFiles: before.map((entry) => ({ ...entry, path: relative(originalRoot, entry.path) })),
    errors: events.filter((event) => event.type === 'error').slice(-3).map((event) => event.data),
    newToolNames: executions.map((entry) => entry.name),
    acceptanceVerified: false, note: 'Only bounded routing, optional preview refresh, and reads are in scope; no generation quality, rendered repair, Vision, or Final is claimed.' }
  await writeFile(resolve(outputRoot, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ reportPath: resolve(outputRoot, 'report.json'), boundary: stopReason,
    observationCompleted, replayError, acceptanceVerified: false,
    originalSnapshot, finalSnapshot, surfaces: requests.map((request) => request.names), executions,
    originalUnchanged, ledgerUnchanged, copyArtifactUnchanged, liveProviderCalls: 0, fakeClientCalls }, null, 2))
  assert(originalUnchanged && ledgerUnchanged && copyArtifactUnchanged, 'Protected bytes changed; inspect replay report.')
  assert.equal(forbiddenAttempts, 0, 'A forbidden execution path was attempted.')
  assert(observationCompleted, replayError ?? 'Unclassified replay failure; inspect replay report.')
}
