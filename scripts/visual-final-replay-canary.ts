import './legacy-live-test-disabled.mjs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { selectAgentToolDefinitions, systemPromptForTools, visualWebArtifactCompletionGap, visualWebStyleReferenceRequest } from '../src/server/agent-service.js'
import { config } from '../src/server/config.js'
import { DeepSeekClient, type ModelTransportEvent } from '../src/server/deepseek.js'
import { fetchPublicUrl } from '../src/server/network-policy.js'
import type { StoredSession } from '../src/server/session-store.js'
import { ANERA_RUNTIME_AGENT_TOOL_DEFINITIONS, EXTENSION_TOOL_DEFINITIONS, type ExtensionToolName } from '../src/server/tools.js'
import { visualDeliveryCompletionControl, visualDeliveryContext } from '../src/server/visual-delivery.js'
import { resolveWorkspacePath } from '../src/server/workspace.js'

// One real, tool-free model request using production context builders and the
// pinned production network path. This is final-response QA, not a fresh task,
// SessionStore replay, renewed render check or chat UI acceptance. Source
// state/journal/artifact are read only; evidence goes to a new temporary root.
if (!process.argv[2]) throw new Error('Usage: npx tsx scripts/visual-final-replay-canary.ts <completed-session-directory>')
const source = resolve(process.argv[2])
const stateBytes = await readFile(resolve(source, 'state.json'))
const state = JSON.parse(stateBytes.toString('utf8')) as StoredSession
const artifact = state.activeVisualArtifact
if (state.summary.status !== 'completed' || !artifact) throw new Error('Requires a completed visual task with a canonical artifact ledger')
const last = state.messages.at(-1)
if (last?.role !== 'assistant' || last.tool_calls?.length) throw new Error('The last stored message must be the completed Final')
const messages = state.messages.slice(0, -1)
const research = state.activeTaskResearchEvidence
const reference = visualWebStyleReferenceRequest(messages) ?? (state.activeReferenceStyleContract ? {
  urls: [state.activeReferenceStyleContract.contract.sourceUrl], strictness: state.activeReferenceStyleContract.contract.strictness,
} : undefined)
const requiresResearch = Boolean(research?.brief)
const gap = visualWebArtifactCompletionGap(messages, {
  forceTask: true, requiresResearch, requirePrivateVisualEvidence: true, requireCurrentReferenceVerifier: true, requireResearchBrief: true,
  canonicalPath: artifact.path, canonicalArtifact: artifact, slidePlan: state.activeVisualWebSlidePlan,
  referenceRequest: reference, referenceContract: state.activeReferenceStyleContract,
  referenceSourceResolution: state.activeReferenceSourceResolution, referenceContractInvalidated: Boolean(state.referenceStyleEvidenceInvalidation),
  researchSourceUrls: research?.sourceUrls, researchPageReads: research?.pageReads ?? [], researchBrief: research?.brief,
  researchUnavailableSourceUrls: research?.unavailableSourceUrls,
})
if (gap) throw new Error(`Stored workflow is incomplete: ${gap.missingPhases.join(', ')}`)
const workspace = resolve(source, 'workspace')
const sourceFiles = [resolve(source, 'state.json'), resolve(source, 'events.jsonl'), resolveWorkspacePath(workspace, artifact.path)]
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const before = await Promise.all(sourceFiles.map(async (path) => digest(await readFile(path))))
const delivery = await visualDeliveryContext({ workspace, artifact, brief: research?.brief })
if (JSON.parse(delivery.split('\n').at(-1)!).artifact.status !== 'hash_verified') throw new Error('Current file bytes do not provide delivery evidence')
const providerTools = selectAgentToolDefinitions({ ...state, messages }, ANERA_RUNTIME_AGENT_TOOL_DEFINITIONS)
const stableVisualExtensions: ExtensionToolName[] = ['browser', 'inspect_image',
  ...(requiresResearch ? ['record_research_brief'] as ExtensionToolName[] : []),
  ...(reference ? ['web_fetch', 'record_reference_style', 'verify_reference_style', 'compose_reference_html'] as ExtensionToolName[] : [])]
for (const name of stableVisualExtensions) if (!providerTools.some((tool) => tool.function.name === name)) providerTools.push(EXTENSION_TOOL_DEFINITIONS[name])
const control = '[Harness trusted phase control — not a new user request]\n'
  + visualDeliveryCompletionControl({ requiresResearch, hasStyleReference: Boolean(reference) }) + '\n\n' + delivery
const requestMessages = [{ role: 'system' as const, content: systemPromptForTools(providerTools, { timezone: state.timezone, includeHarnessConvergence: true }) },
  ...messages, { role: 'user' as const, content: control }]
const evidenceRoot = await mkdtemp(resolve(tmpdir(), 'anera-visual-final-replay-'))
const transport: ModelTransportEvent[] = []
const client = new DeepSeekClient({ apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl, model: state.summary.model,
  temperature: config.modelTemperature, thinking: config.modelThinking,
  ...(config.modelThinking === 'enabled' ? { reasoningEffort: config.modelReasoningEffort } : {}),
  maxOutputTokens: config.maxOutputTokens, firstEventTimeoutMs: config.modelFirstEventTimeoutMs,
  maxLengthContinuations: config.maxLengthContinuations, fetch: fetchPublicUrl })
const startedAt = Date.now()
console.log(JSON.stringify({ diagnostic: 'final_only_replay', source, evidenceRoot, deliveryContextBytes: Buffer.byteLength(delivery),
  requestMessages: requestMessages.length, requestSha256: digest(JSON.stringify(requestMessages)), maxPhysicalRequests: 1 }))
const signal = AbortSignal.timeout(Math.min(config.runTimeoutMs, 900_000))
let result: Awaited<ReturnType<DeepSeekClient['stream']>> | undefined
let failure: string | undefined
try {
  result = await client.stream({ messages: requestMessages, tools: [], providerTools, toolChoice: 'none', requireToolCall: false,
    model: state.summary.model, signal, maxModelRequests: 1, maxTotalTokens: config.maxAgentTotalTokensPerTurn,
    onContent: () => {}, onReasoning: () => {}, onTransportEvent: (event) => { transport.push(event); console.log(JSON.stringify({ diagnostic: 'model_transport', ...event })) } })
} catch (error) { failure = error instanceof Error ? error.message : String(error) }
const after = await Promise.all(sourceFiles.map(async (path) => digest(await readFile(path))))
const report = { diagnostic: 'final_only_replay', source, elapsedSeconds: (Date.now() - startedAt) / 1000,
  sourceUnchanged: JSON.stringify(before) === JSON.stringify(after), sourceHashes: before, deliveryContextBytes: Buffer.byteLength(delivery),
  requestSha256: digest(JSON.stringify(requestMessages)), transport, failure,
  ...(result ? { content: result.content, finishReason: result.finishReason, toolCallCount: result.toolCalls.length,
    reasoningBytes: Buffer.byteLength(result.reasoningContent), usage: result.usage, modelCallCount: result.modelCallCount, modelRequestCount: result.modelRequestCount } : {}) }
await writeFile(resolve(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (failure || !report.sourceUnchanged || !result?.content.trim() || result.toolCalls.length || result.finishReason !== 'stop') process.exitCode = 1
