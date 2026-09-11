import './legacy-live-test-disabled.mjs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { AgentService, systemPromptForTools } from '../src/server/agent-service.js'
import { assertCheckpointSummary } from '../src/server/checkpoint-context.js'
import { config } from '../src/server/config.js'
import { DeepSeekClient, ModelStreamBudgetExceededError, type ModelResult, type ModelTransportEvent } from '../src/server/deepseek.js'
import { fetchPublicUrl } from '../src/server/network-policy.js'
import { findSensitiveValues, redactText } from '../src/server/redaction.js'
import { readHydratedSessionEventLog, SessionStore, type StoredSession } from '../src/server/session-store.js'

// A read-only source snapshot, production checkpoint selection in an isolated
// Store, then exactly one physical provider request. This is a component
// comparison, NOT reconstruction of the historical wire request, a resumed
// task, semantic truth certification or chat UI acceptance.
if (!process.argv[2]) throw new Error('Usage: npx tsx scripts/checkpoint-mode-replay-canary.ts <source-session-directory> [disabled|enabled] [boundary-tool-event-seq]')
const source = resolve(process.argv[2])
const thinking = process.argv[3] ?? 'disabled'
if (thinking !== 'disabled' && thinking !== 'enabled') throw new Error('Expected disabled or enabled')
const paths = [resolve(source, 'state.json'), resolve(source, 'events.jsonl')]
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const before = await Promise.all(paths.map((path) => readFile(path)))
const state = JSON.parse(before[0].toString('utf8')) as StoredSession
if (!['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(state.summary.status)) throw new Error('Source must be terminal')
const boundaryEventSeq = process.argv[4] === undefined ? undefined : Number(process.argv[4])
let selectedHistory = state.messages
if (boundaryEventSeq !== undefined) {
  if (!Number.isSafeInteger(boundaryEventSeq) || boundaryEventSeq < 1) throw new Error('Invalid tool event boundary')
  const events = await readHydratedSessionEventLog(paths[1])
  const boundary = events.find((event) => event.seq === boundaryEventSeq && ['tool.completed', 'tool.failed'].includes(event.type))
  const callId = (boundary?.data.call as { id?: unknown } | undefined)?.id
  const index = typeof callId === 'string' ? state.messages.findIndex((message) => message.role === 'tool' && message.tool_call_id === callId) : -1
  if (index < 0) throw new Error('Tool boundary is not represented in the retained source snapshot')
  // Preserve the newest result's unconsumed status. The terminal snapshot can
  // otherwise compact it as historical and select a much easier request.
  selectedHistory = state.messages.slice(0, index + 1)
}
const evidenceRoot = await mkdtemp(resolve(tmpdir(), 'anera-checkpoint-mode-'))
const store = new SessionStore(resolve(evidenceRoot, 'isolated-store'), state.summary.model)
await store.initialize()
const isolated = await store.create()
let captured: Parameters<DeepSeekClient['stream']>[0] | undefined
const agent = new AgentService(store, { client: { stream: async (options) => {
  if (!captured) captured = options
  throw new Error('Diagnostic captured the checkpoint request; no provider was dispatched by this isolated selector')
} } })
try {
  await agent['prepareContext'](isolated.summary.id, 'turn_diagnostic', 'step_checkpoint_capture', selectedHistory,
    new AbortController().signal, state.summary.model, state.contextPressure, [], systemPromptForTools([], { timezone: state.timezone }),
    { force: true, reason: 'tool_request', visualTask: true })
} finally { await agent.shutdown() }
if (!captured) throw new Error(`No bounded checkpoint request selected; diagnostic evidence at ${evidenceRoot}`)
const selected = captured as Parameters<DeepSeekClient['stream']>[0]
const serialized = JSON.stringify(selected.messages)
const messages = JSON.parse(redactText(serialized, findSensitiveValues(serialized))) as typeof selected.messages
await writeFile(resolve(evidenceRoot, 'request.json'), JSON.stringify({ messages }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const transport: ModelTransportEvent[] = []
const maxOutputTokens = Math.min(selected.maxOutputTokens ?? 1_800, 1_800, config.maxOutputTokens)
const client = new DeepSeekClient({ apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl, model: state.summary.model,
  temperature: config.modelTemperature, thinking: config.modelThinking,
  ...(config.modelThinking === 'enabled' ? { reasoningEffort: config.modelReasoningEffort } : {}),
  maxOutputTokens: config.maxOutputTokens, maxLengthContinuations: config.maxLengthContinuations,
  firstEventTimeoutMs: config.modelFirstEventTimeoutMs, fetch: fetchPublicUrl })
const startedAt = Date.now()
console.log(JSON.stringify({ evidenceRoot, source, thinking, maxOutputTokens, maxPhysicalRequests: 1, requestSha256: digest(JSON.stringify(messages)) }))
let result: ModelResult | undefined
let failure: Record<string, unknown> | undefined
let failureUsage: { usage?: ModelResult['usage']; modelCallCount?: number; modelRequestCount?: number } = {}
let partialSummary = ''
let partialSummaryTruncated = false
try {
  result = await client.stream({ messages, tools: [], toolChoice: 'none', thinking, maxOutputTokens,
    maxModelRequests: 1, maxTotalTokens: config.maxAgentTotalTokensPerTurn,
    signal: AbortSignal.timeout(Math.min(config.runTimeoutMs, 90_000)), onContent: (delta) => {
      const available = Math.max(0, 32_768 - partialSummary.length)
      partialSummary += delta.slice(0, available)
      if (delta.length > available) partialSummaryTruncated = true
    }, onReasoning: () => {},
    onTransportEvent: (event) => { if (transport.length < 64) transport.push(event) },
  })
  if (result.finishReason !== 'stop' || result.toolCalls.length || !result.content.trim()) throw new Error('Nonterminal checkpoint')
  assertCheckpointSummary(result.content, state.messages)
} catch (error) {
  failure = error instanceof ModelStreamBudgetExceededError
    ? { code: error.code, budget: error.budget, used: error.used, limit: error.limit }
    : { code: result ? 'invalid_checkpoint' : 'provider_failure' }
  const fields = error as { modelUsage?: Partial<ModelResult['usage']>; modelCallCount?: unknown; modelRequestCount?: unknown } | undefined
  const usage = fields?.modelUsage
  if (usage && [usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.cachedPromptTokens]
    .every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
    failureUsage.usage = { promptTokens: usage.promptTokens!, completionTokens: usage.completionTokens!,
      totalTokens: usage.totalTokens!, cachedPromptTokens: usage.cachedPromptTokens! }
  }
  for (const key of ['modelCallCount', 'modelRequestCount'] as const) {
    const value = fields?.[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) failureUsage[key] = value
  }
}
const after = await Promise.all(paths.map((path) => readFile(path).then(digest).catch(() => 'unavailable')))
const sourceHashes = before.map(digest)
const report = { kind: 'checkpoint-mode-component-comparison', fullAgentTask: false, chatUiVerified: false,
  historicalRequestReconstructed: false, selection: 'production forced checkpoint over terminal source snapshot',
  source, evidenceRoot, boundaryEventSeq, selectedHistoryMessages: selectedHistory.length,
  thinking, productionSelectionThinking: selected.thinking, maxOutputTokens, maxPhysicalRequests: 1,
  requestSha256: digest(JSON.stringify(messages)), requestBytes: Buffer.byteLength(JSON.stringify(messages)),
  retainedIndex: JSON.parse(String(messages[2]?.content)),
  sourceHashes, sourceUnchanged: JSON.stringify(sourceHashes) === JSON.stringify(after),
  elapsedSeconds: (Date.now() - startedAt) / 1000, failure, transport,
  ...(!result && partialSummary ? {
    partialSummary: redactText(partialSummary, findSensitiveValues(partialSummary)), partialSummaryTruncated,
  } : {}),
  ...failureUsage,
  ...(result ? { summary: redactText(result.content, findSensitiveValues(result.content)), finishReason: result.finishReason,
    usage: result.usage, modelCallCount: result.modelCallCount, modelRequestCount: result.modelRequestCount,
    reasoningBytes: Buffer.byteLength(result.reasoningContent), contentBytes: Buffer.byteLength(result.content) } : {}),
}
await writeFile(resolve(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
if (failure || !report.sourceUnchanged) process.exitCode = 1
