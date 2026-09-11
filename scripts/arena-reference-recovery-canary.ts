import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createApp } from '../src/server/app.js'
import { canonicalResearchHtmlContentGap, normalizedDurableResearchEvidence, recoverActiveTaskPlanIdentity, recoverActiveTaskRequestText, recoverActiveTaskTemporalControl, visualWebArtifactCompletionGap, visualWebStyleReferenceRequest } from '../src/server/agent-service.js'
import { taskScopeIdentity } from '../src/server/task-context.js'
import { REFERENCE_STYLE_VERIFIER_REVISION } from '../src/server/reference-style.js'
import type { AgentServiceOptions } from '../src/server/agent-service.js'
import { config } from '../src/server/config.js'
import { DeepSeekClient, ModelStreamBudgetExceededError, type ModelTransportEvent } from '../src/server/deepseek.js'
import { DeepSeekVisionClient } from '../src/server/vision.js'
import { fetchPublicUrl } from '../src/server/network-policy.js'
import { inspectAuthorizedModelTestBudget, openAuthorizedModelTestBudget, paidTestMode } from '../src/eval/paid-test-entry.js'
import { SessionStore } from '../src/server/session-store.js'
import { smokeLocalPage } from '../src/eval/local-page-smoke.js'
import { observeSessionRun } from '../src/eval/session-run-observer.js'
import { createCanaryEvidenceDirectory } from '../src/eval/canary-evidence.js'
import { probeDocumentedProvider } from '../src/eval/provider-capability-probe.js'
import { modelRouteAvailability } from '../src/eval/model-route-availability.js'
import { publicReadTransport } from '../src/eval/public-read-transport.js'
import { assertReviewProbeSource } from '../src/eval/visual-final-review-probe.js'
import { runGeneralAgentCanary } from '../src/eval/general-agent-canary.js'
import { visualDeliveryContext, visualDeliveryCompletionControl, visualDeliveryHandoffOutcome } from '../src/server/visual-delivery.js'
import { isVisualReviewProtocolError, runVisualFinalReview, visualArtifactReviewMessages, visualFinalEvidenceIssues, visualFinalReviewMessages } from '../src/server/visual-final-review.js'
import { resolveWorkspacePath } from '../src/server/workspace.js'
import type { StoredSession } from '../src/server/session-store.js'
import type { SessionEvent } from '../src/shared/types.js'

// Real-provider validation. Preserve all evidence, including a failed run.
// Resume a byte-for-byte copy; never rewrite the user's original session.
// One fixed cross-run ledger, including explicitly appended authorizations.
// Do not override/reset this path to obtain a fresh allowance.
if (paidTestMode(process.argv.slice(2)) === 'preflight') {
  console.log(JSON.stringify({ diagnostic: 'canary_preflight', mode: 'local-only', paidCalls: 0,
    networkCalls: 0, budget: inspectAuthorizedModelTestBudget(), requiresExplicitLive: true }))
  process.exit(0)
}
const budget = openAuthorizedModelTestBudget(process.argv.slice(2))
const canaryModel = 'deepseek-v4-flash'
let evidenceRoot: string | undefined
const startedAt = new Date().toISOString()
try {
  evidenceRoot = await createCanaryEvidenceDirectory()
  console.log(JSON.stringify({ diagnostic: 'canary_evidence', evidenceRoot }))
  await runCanary(evidenceRoot)
} catch (error) {
  console.error(JSON.stringify({ diagnostic: 'canary_stopped', error: error instanceof Error ? error.message : String(error), budget: budget.snapshot() }))
  process.exitCode = 1
} finally {
  try {
    if (evidenceRoot) await writeFile(resolve(evidenceRoot, 'run-metadata.json'), JSON.stringify({
      startedAt, endedAt: new Date().toISOString(), runnerExitCode: process.exitCode ?? 0,
      budget: budget.snapshot(), evidenceRoot,
      // A successful runner is not a successful semantic/visual acceptance.
      acceptance: 'consult the scope-specific report; never inferred from runner exit',
    }, null, 2))
  } finally { budget.close() }
}

async function runCanary(evidenceRoot: string) {
// The user explicitly authorized the current Flash route for this canary.
// Confirm the free provider catalog before creating a session or paid request.
for (const model of [canaryModel, config.visionModel]) budget.assertModel(model)
const catalogUrl = new URL(`${config.deepseekBaseUrl.replace(/\/+$/, '')}/models`)
if (catalogUrl.origin !== 'https://api.deepseek.com'
  || !['/models', '/v1/models'].includes(catalogUrl.pathname)
  || catalogUrl.search || catalogUrl.username || catalogUrl.password) {
  budget.stop('unverified model catalog endpoint')
}
const catalogResponse = await fetchPublicUrl(catalogUrl, {
  method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
  headers: { authorization: `Bearer ${config.deepseekApiKey}`, accept: 'application/json' },
})
if (!catalogResponse.ok) budget.stop(`model catalog unavailable (HTTP ${catalogResponse.status})`)
const catalog = await catalogResponse.json() as { object?: unknown; data?: Array<{ id?: unknown }> }
if (catalog?.object !== 'list' || !Array.isArray(catalog.data)) budget.stop('invalid model catalog')
const availableModels = (catalog.data ?? []).flatMap((model) => typeof model?.id === 'string' ? [model.id] : [])
await writeFile(resolve(evidenceRoot, 'model-catalog.json'), JSON.stringify({
  observedAt: new Date().toISOString(), endpoint: catalogUrl.href, httpStatus: catalogResponse.status,
  availableModels, requiredModels: [canaryModel, config.visionModel],
}, null, 2))
if (process.env.ANERA_ARENA_CANARY_MODE === 'capability') {
  // Catalog absence is an observation, not a provider rejection. This explicit
  // diagnostic tests only the existing documented routes, through the same
  // ledger. It never relaxes normal task admission or selects another alias.
  if (config.modelThinking === undefined) throw new Error('Capability diagnostic requires an explicit thinking configuration')
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(16, 16)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, 16, 16)
  const observations: unknown[] = []
  const initialBudget = budget.snapshot()
  const report = async () => writeFile(resolve(evidenceRoot, 'capability-report.json'), JSON.stringify({
    diagnostic: 'documented_route_capability_only', acceptanceVerified: false, availableModels,
    initialBudget, budget: budget.snapshot(), observations,
  }, null, 2))
  try {
    await probeDocumentedProvider({ fetch: budget.wrapFetch(fetchPublicUrl), apiKey: config.deepseekApiKey,
      baseUrl: config.deepseekBaseUrl, model: canaryModel, visionModel: config.visionModel,
      thinking: config.modelThinking, reasoningEffort: config.modelReasoningEffort,
      imageDataUrl: `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`,
      onResult: async (observation) => { observations.push(observation); await report(); console.log(JSON.stringify(observation)) },
    })
  } finally { await report() }
  return
}
for (const model of [canaryModel, config.visionModel]) {
  const availability = modelRouteAvailability(model, availableModels)
  if (!availability.mayAttempt) budget.stop(`authorized model unavailable: ${model}`)
  if (!availability.listed) console.log(JSON.stringify({ diagnostic: 'documented_route_not_listed', ...availability,
    routeSubstituted: false, qualityVerified: false }))
}
const providerFetch = budget.wrapFetch(fetchPublicUrl)
const client = new DeepSeekClient({
  apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl, model: canaryModel,
  temperature: config.modelTemperature, thinking: config.modelThinking,
  ...(config.modelThinking === 'enabled' ? { reasoningEffort: config.modelReasoningEffort } : {}),
  maxOutputTokens: config.maxOutputTokens, firstEventTimeoutMs: config.modelFirstEventTimeoutMs,
  maxLengthContinuations: config.maxLengthContinuations, fetch: providerFetch,
})
if (process.env.ANERA_ARENA_CANARY_MODE === 'review') {
  await runReviewBoundary(client, evidenceRoot)
  return
}
const vision = new DeepSeekVisionClient({
  apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl, model: config.visionModel,
  maxImageBytes: config.maxVisionImageBytes, maxOutputTokens: config.maxVisionOutputTokens,
  pricing: config.deepSeekVisionPricing, fetch: providerFetch,
})
if (process.env.ANERA_ARENA_CANARY_MODE === 'general') {
  await runGeneralAgentCanary({ client, vision, model: canaryModel, budget, dataRoot: evidenceRoot })
  return
}
const mode = process.env.ANERA_ARENA_CANARY_MODE === 'fresh' ? 'fresh'
  : process.env.ANERA_ARENA_CANARY_MODE === 'continue' ? 'continue' : 'resume'
const originalId = process.env.ANERA_ARENA_CANARY_SOURCE_SESSION || 'ses_b551308e76c24e4c9818'
if (!/^ses_[a-zA-Z0-9]+$/.test(originalId)) throw new Error('Invalid canary source Session ID')
const sourceDataRoot = resolve(process.env.ANERA_ARENA_CANARY_SOURCE_ROOT || '.anera')
const dataRoot = evidenceRoot
const prompt = '看看最近一周的娱乐热点新闻，做成HTML Slides，风格严格参考：https://github.com/zarazhangrui/beautiful-html-templates/blob/main/templates/pink-script'
let sourceModel: string | undefined
if (mode !== 'fresh') {
  if (mode === 'continue' && !process.env.ANERA_ARENA_CANARY_SOURCE_ROOT) throw new Error('Continue requires an explicit completed source root')
  await mkdir(resolve(dataRoot, 'sessions'), { recursive: true })
  await cp(resolve(sourceDataRoot, 'sessions', originalId), resolve(dataRoot, 'sessions', originalId), { recursive: true, errorOnExist: true })
  // resume() has no model-selection option and uses the stored summary model.
  // Select Flash through the store API on this isolated copy before createApp
  // can recover any persisted interactions. The original session is untouched.
  const copiedStore = new SessionStore(dataRoot, canaryModel)
  await copiedStore.initialize()
  const copiedSession = await copiedStore.get(originalId)
  if (mode === 'continue' && copiedSession.summary.status !== 'completed') throw new Error('Continue mode requires a completed source; use Resume for an unfinished run')
  sourceModel = copiedSession.summary.model
  await copiedStore.update(originalId, (state) => {
    state.summary.model = canaryModel
    state.summary.modelSelection = canaryModel
  })
}
let base = ''
const toolFetch = publicReadTransport({ publicFetch: fetchPublicUrl, localFetch: fetch, localBaseUrl: () => base })
type TransportRecord = Parameters<NonNullable<AgentServiceOptions['modelTransportObserver']>>[0] & { at: string }
const modelTransport: TransportRecord[] = []
let omittedTransportEvents = 0
const { app, agent, store } = await createApp({
  dataRoot, model: canaryModel,
  agent: {
    client, vision, models: [canaryModel],
    toolExecutorDependencies: {
      localAppBaseUrl: () => base, fetch: toolFetch,
      // A custom fetch normally disables these config fallbacks. Explicitly
      // preserve all production credentials without exposing them in logs.
      tavilyApiKey: config.tavilyApiKey, firecrawlApiKey: config.firecrawlApiKey,
      pexelsApiKey: config.pexelsApiKey, imageApiKey: config.imageApiKey,
    },
    modelTransportObserver: (event) => {
      if (modelTransport.length >= 512) { omittedTransportEvents += 1; return }
      const record = { ...event, at: new Date().toISOString() }
      modelTransport.push(record)
      console.log(JSON.stringify({ diagnostic: 'model_transport', ...record }))
    },
  },
})
const server = createServer(app)
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Canary failed to bind')
base = `http://127.0.0.1:${address.port}`
const session = mode !== 'fresh' ? await store.get(originalId) : await store.create()
if (session.summary.model !== canaryModel) budget.stop('canary session retained an unexpected model')
const sessionId = session.summary.id
const initialSnapshot = await (await fetch(`${base}/api/sessions/${sessionId}`)).json()
const initialBudget = budget.snapshot()
const initialSeq = Math.max(0, ...initialSnapshot.events.map((event: { seq: number }) => event.seq))
const startedAt = Date.now()
const deadline = startedAt + Number(process.env.ANERA_ARENA_CANARY_TIMEOUT_MS || 900_000)
console.log(JSON.stringify({ mode, model: session.summary.model, sourceModel, dataRoot, sessionId, base, initialSeq }))
let observation: ReturnType<typeof observeSessionRun> | undefined
try {
  observation = observeSessionRun({ sessionId, afterSeq: initialSeq, deadline,
    subscribe: (listener) => store.subscribe(sessionId, listener),
    onEvent: (event) => {
      if (['tool.started', 'tool.completed', 'tool.failed', 'run.status', 'assistant.final', 'model.tool_call.repair'].includes(event.type)) {
        const call = event.data.call as { name?: string; arguments?: { action?: unknown } } | undefined
        const result = String(event.data.result || event.data.error || '').slice(0, 900)
        console.log(JSON.stringify({ seq: event.seq, type: event.type, tool: call?.name, action: call?.arguments?.action,
          status: event.data.status, reason: event.data.reason, result }))
        if (budget.snapshot().stopped) observation?.stop()
      }
    },
  })
  // Verify the owned Anera UI before starting any paid generation. This uses
  // the cached local CLI, never a user profile or an AI/browser provider.
  // Startup smoke covers the application home. Historical-session UI and the
  // canonical artifact retain their separate, stronger acceptance boundaries.
  await smokeLocalPage({ url: `${base}/agent`, outputRoot: dataRoot,
    cli: process.env.ANERA_BROWSER_SMOKE_CLI, browserExecutablePath: config.browserExecutablePath,
    expectedTitle: 'Anera', readySelector: '.empty-conversation' })
  if (!observation.stopped) {
    if (mode === 'resume') await agent.resume(sessionId)
    // A completed session cannot use Resume. Use the normal user continuation
    // path, preserving the historical request scope and never forging failure.
    else if (mode === 'continue') await agent.submit(sessionId, { content: 'Continue', attachments: [], model: canaryModel })
    else await agent.submit(sessionId, { content: prompt, attachments: [], timezone: 'Asia/Shanghai', model: canaryModel })
  }
  const runObservation = await observation.result
  const deadlineExceeded = runObservation.reason === 'deadline'
  if (runObservation.reason !== 'terminal') {
    await agent.cancel(sessionId)
  }
  // Drain every outcome before reading final evidence. A durable run.status
  // can precede the terminal summary commit, just as cancel() can precede
  // model/tool settlement. Shutdown preserves an already staged terminal.
  await agent.shutdown()
  const snapshot = await (await fetch(`${base}/api/sessions/${sessionId}`)).json()
  const current = await store.get(sessionId)
  const path = current.activeVisualArtifact?.path
  const html = path ? await readFile(resolve(store.workspaceDir(sessionId), path), 'utf8').catch(() => '') : ''
  const events = snapshot.events.filter((event: { seq: number }) => event.seq > initialSeq)
  const taskEvents = await store.events(sessionId)
  const researchEvidence = normalizedDurableResearchEvidence(current.activeTaskResearchEvidence,
    recoverActiveTaskPlanIdentity(taskEvents, current.timezone)
      ?? taskScopeIdentity(recoverActiveTaskRequestText(taskEvents) ?? '', recoverActiveTaskTemporalControl(taskEvents, current.timezone)))
  const contentGap = path ? await canonicalResearchHtmlContentGap(store.workspaceDir(sessionId), current.messages,
    path, researchEvidence.sourceUrls, {
      requiresResearch: true, requiresPageBody: true, requireResearchBrief: true,
      researchPageReads: researchEvidence.pageReads ?? [],
      researchBrief: researchEvidence.brief,
      referenceUrls: current.activeReferenceStyleContract ? [current.activeReferenceStyleContract.contract.sourceUrl] : undefined,
    }) : 'No canonical HTML artifact was produced.'
  const gap = visualWebArtifactCompletionGap(current.messages, {
    forceTask: true,
    requiresResearch: true,
    requirePrivateVisualEvidence: true,
    requireCurrentReferenceVerifier: true,
    requireResearchBrief: true,
    // The provider checkpoint may omit the original request. Match production
    // recovery's server-private fallback, or closing/reference phases silently
    // disappear from the canary report despite a durable exact contract.
    referenceRequest: visualWebStyleReferenceRequest(current.messages) ?? (
      current.activeReferenceStyleContract ? {
        urls: [current.activeReferenceStyleContract.contract.sourceUrl],
        strictness: current.activeReferenceStyleContract.contract.strictness,
      } : undefined
    ),
    referenceSourceResolution: current.activeReferenceSourceResolution,
    referenceContract: current.activeReferenceStyleContract,
    referenceContractInvalidated: Boolean(current.referenceStyleEvidenceInvalidation),
    canonicalPath: path,
    canonicalArtifact: current.activeVisualArtifact,
    slidePlan: current.activeVisualWebSlidePlan,
    researchSourceUrls: researchEvidence.sourceUrls,
    researchPageReads: researchEvidence.pageReads ?? [],
    researchBrief: researchEvidence.brief, researchBriefAuthoritative: true,
    researchUnavailableSourceUrls: current.activeTaskResearchEvidence?.unavailableSourceUrls,
  })
  const report = {
    mode, model: current.summary.model, sourceModel, sessionId, dataRoot, elapsedSeconds: (Date.now() - startedAt) / 1000,
    status: snapshot.session.status, deadlineExceeded, runObservation, verifierRevision: REFERENCE_STYLE_VERIFIER_REVISION,
    path, artifactBytes: Buffer.byteLength(html), missingPhases: gap?.missingPhases ?? [], contentGap,
    thoughtDeltas: events.filter((event: any) => event.type === 'assistant.thought.delta').length,
    progressDeltas: events.filter((event: any) => event.type === 'assistant.progress.delta').length,
    calls: events.filter((event: any) => event.type === 'tool.started').map((event: any) => event.data.call?.name),
    usage: snapshot.session.usage,
    initialUsage: initialSnapshot.session.usage,
    budget: budget.snapshot(), initialBudget,
    runAccountedUpperBoundCny: budget.snapshot().accountedUpperBoundCny - initialBudget.accountedUpperBoundCny,
    modelTransport, omittedTransportEvents,
    presented: events.some((event: any) => event.type === 'file.presented'),
    visibleChineseCharacters: (html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '').match(/[\u4e00-\u9fff]/g) || []).length,
    final: events.findLast((event: any) => event.type === 'assistant.final')?.data.content,
    errors: events.filter((event: any) => ['error', 'tool.failed'].includes(event.type)),
  }
  await writeFile(resolve(dataRoot, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report,
    modelTransport: { eventCount: report.modelTransport.length, omittedTransportEvents },
    final: typeof report.final === 'string' ? report.final.slice(0, 1_500) : report.final,
    errors: report.errors.map((event: any) => ({ seq: event.seq, type: event.type,
      tool: event.data.call?.name, result: String(event.data.result ?? event.data.message ?? event.data.error ?? '').slice(0, 900) })),
    fullReport: resolve(dataRoot, 'report.json'),
  }))
  if (report.status !== 'completed' || runObservation.reason !== 'terminal'
    || gap || contentGap || !report.presented || report.budget.stopped) process.exitCode = 1
} finally {
  observation?.close()
  await agent.shutdown()
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
}
}

/** Read-only diagnostic for the first broken boundary. Shares the exact
 * production reviewer, models and fixed ledger; never starts an App/Browser,
 * changes the source session, manufactures receipts or claims acceptance. */
async function runReviewBoundary(client: DeepSeekClient, outputRoot: string) {
  const target = process.env.ANERA_REVIEW_TARGET || 'artifact'
  if (!['artifact', 'handoff'].includes(target)) throw new Error('Unknown review target')
  if (!process.env.ANERA_ARENA_CANARY_SOURCE_ROOT) throw new Error('Review diagnostic requires an explicit source root')
  const sourceRoot = resolve(process.env.ANERA_ARENA_CANARY_SOURCE_ROOT)
  const id = process.env.ANERA_ARENA_CANARY_SOURCE_SESSION || 'ses_b551308e76c24e4c9818'
  if (!/^ses_[a-zA-Z0-9]+$/.test(id)) throw new Error('Invalid review source session')
  const sessionRoot = resolve(sourceRoot, 'sessions', id)
  const statePath = resolve(sessionRoot, 'state.json')
  const eventPath = resolve(sessionRoot, 'events.jsonl')
  const stateBytes = await readFile(statePath)
  const state = JSON.parse(stateBytes.toString()) as StoredSession
  const eventBytes = await readFile(eventPath)
  const sourceReport = JSON.parse(await readFile(resolve(sourceRoot, 'report.json'), 'utf8'))
  if (!state.activeVisualArtifact) throw new Error('Review diagnostic requires an artifact snapshot')
  assertReviewProbeSource({ target, status: state.summary.status, reportStatus: sourceReport.status,
    path: state.activeVisualArtifact.path, reportPath: sourceReport.path, model: state.summary.model, requiredModel: canaryModel,
    presented: sourceReport.presented === true, missingPhases: sourceReport.missingPhases })
  const workspace = resolve(sessionRoot, 'workspace')
  const artifactPath = resolveWorkspacePath(workspace, state.activeVisualArtifact.path)
  const artifactBytes = await readFile(artifactPath)
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const before = [stateBytes, eventBytes, artifactBytes].map(digest)
  const context = await visualDeliveryContext({ workspace, artifact: state.activeVisualArtifact, brief: state.activeTaskResearchEvidence?.brief,
    audience: target === 'artifact' ? 'artifact-review' : 'handoff' })
  if (JSON.parse(context.split('\n').at(-1)!).artifact.status !== 'hash_verified') throw new Error('Review diagnostic requires current hash-bound evidence')
  const sourceEvents = eventBytes.toString().trim().split('\n').map((line) => JSON.parse(line) as SessionEvent)
  const taskRequest = recoverActiveTaskRequestText(sourceEvents)
  const trustedTaskTemporalControl = recoverActiveTaskTemporalControl(sourceEvents, state.timezone)
  if (!taskRequest) throw new Error('Missing original task for review')
  const draft = target === 'handoff' ? sourceReport.final : ''
  if (typeof draft !== 'string' || (target === 'handoff' && !draft.trim())) throw new Error('Handoff diagnostic requires a saved final draft')
  const messages = target === 'artifact' ? visualArtifactReviewMessages({ taskRequest, deliveryContext: context, trustedTaskTemporalControl })
    : visualFinalReviewMessages({ taskRequest, draft, deliveryContext: context, trustedTaskTemporalControl,
      handoffOutcome: visualDeliveryHandoffOutcome({ requiresResearch: Boolean(state.activeTaskResearchEvidence?.brief),
        hasStyleReference: Boolean(state.activeReferenceStyleContract) }),
      completionControl: visualDeliveryCompletionControl({ requiresResearch: Boolean(state.activeTaskResearchEvidence?.brief),
        hasStyleReference: Boolean(state.activeReferenceStyleContract) }) })
  const contentMessages = target === 'handoff' ? visualFinalReviewMessages({ taskRequest, draft, deliveryContext: context, trustedTaskTemporalControl,
    completionControl: visualDeliveryCompletionControl({ requiresResearch: Boolean(state.activeTaskResearchEvidence?.brief),
      hasStyleReference: Boolean(state.activeReferenceStyleContract) }) }, { includeContentEvidence: true }) : undefined
  const initialBudget = budget.snapshot()
  // Keep the production client's two transport retries, two empty-response
  // retries and configured length continuations; do not lower model quality
  // merely to make a probe cheaper. Only the workflow scope is reduced.
  const maxPhysicalRequestsPerReview = 5 + config.maxLengthContinuations
  const attempts: Array<{ finishReason: string; contentBytes: number; reasoningBytes: number }> = []
  const transport: ModelTransportEvent[] = []
  const diagnostics: string[] = []
  const maxLogicalReviews = target === 'handoff' ? 3 : 2 // one optional same-snapshot evidence expansion, one protocol repair
  let contentExpansions = 0
  let review: Awaited<ReturnType<typeof runVisualFinalReview>> | undefined
  let failure: string | undefined
  console.log(JSON.stringify({ diagnostic: 'review_boundary_only', target, sourceRoot, outputRoot, maxLogicalReviews, maxPhysicalRequests: maxLogicalReviews * maxPhysicalRequestsPerReview, browserCalls: 0, acceptanceVerified: false }))
  try {
    review = await runVisualFinalReview({ messages, contentMessages, draft, artifactOnly: target === 'artifact', deliveryContext: context, taskRequest,
      onContentExpansion: async () => { contentExpansions += 1 },
      request: async (current, contract) => {
        if (attempts.length >= maxLogicalReviews) throw new Error('Review diagnostic request bound exceeded')
        const response = await client.stream({ ...contract, messages: current, tools: [], toolChoice: 'none', maxModelRequests: maxPhysicalRequestsPerReview,
          signal: AbortSignal.timeout(config.runTimeoutMs),
          onContent: () => {}, onReasoning: () => {}, onTransportEvent: (event) => { transport.push(event) } })
        attempts.push({ finishReason: response.finishReason, contentBytes: Buffer.byteLength(response.content), reasoningBytes: Buffer.byteLength(response.reasoningContent) })
        return response
      }, onProtocolRepair: async (diagnostic) => { diagnostics.push(diagnostic) },
    })
  } catch (error) {
    failure = error instanceof ModelStreamBudgetExceededError ? `${error.code}: ${error.budget} ${error.used}/${error.limit}`
      : isVisualReviewProtocolError(error) || error instanceof Error && error.message.startsWith('Visual Final review ') ? error.message : 'Review provider/operational failure; inspect metered ledger'
  }
  const after = await Promise.all([statePath, eventPath, artifactPath].map(async (path) => digest(await readFile(path))))
  const unchanged = before.every((hash, index) => hash === after[index])
  const remainingEvidenceIssues = review && !review.artifactIssues?.length ? visualFinalEvidenceIssues(review.final, context) : []
  const report = { diagnostic: 'review_boundary_only', sourceRoot, acceptanceVerified: false, browserCalls: 0, sourceUnchanged: unchanged,
    before, after, target, reviewScope: target === 'artifact' ? 'artifact-only; no Final draft or publication' : 'handoff-only; independent evidence input; saved draft is comparison-only; no publication or workflow acceptance',
    draftBytes: Buffer.byteLength(draft), contentExpansions, ...(review ? { textChanged: review.final !== draft } : {}), attempts, transport, diagnostics, review, failure,
    remainingEvidenceIssues, initialBudget, budget: budget.snapshot() }
  await writeFile(resolve(outputRoot, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, fullReport: resolve(outputRoot, 'report.json') }))
  if (!unchanged || failure || remainingEvidenceIssues.length) process.exitCode = 1
}
