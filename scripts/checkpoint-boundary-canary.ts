import './legacy-live-test-disabled.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { ModelMessage, SessionEvent, ToolCallRecord } from '../src/shared/types.js'
import { compactionRequestMessages, retainedCheckpointIndex } from '../src/server/checkpoint-context.js'
import { config } from '../src/server/config.js'
import { DeepSeekClient } from '../src/server/deepseek.js'
import { fetchPublicUrl } from '../src/server/network-policy.js'
import { SessionStore } from '../src/server/session-store.js'

// A bounded paid, tools-disabled checkpoint probe over a controlled historical
// subset of a real journal. This never resumes the session, calls task tools,
// rewrites its cache, or claims end-to-end task / factual / chat UI acceptance.
const sourceRoot = process.env.ANERA_CHECKPOINT_CANARY_SOURCE_ROOT
const sourceSessionId = process.env.ANERA_CHECKPOINT_CANARY_SESSION_ID
if (!sourceRoot || !sourceSessionId) throw new Error('Provide the read-only canary source root and session ID')
if (!config.deepseekApiKey) throw new Error('A configured real provider is required')
const events = await new SessionStore(resolve(sourceRoot), config.model).events(sourceSessionId)
const checkpoint = events.find((event) => event.type === 'context.compacted')
assert.ok(checkpoint, 'Source journal must contain a real partial-history checkpoint')
const earlier = events.filter((event) => event.seq < checkpoint.seq)
const user = earlier.find((event) => event.type === 'turn.started')
assert.equal(typeof user?.data.content, 'string')
const callOf = (event: SessionEvent) => event.data.call as ToolCallRecord | undefined
const rejected = earlier.find((event) => event.type === 'tool.failed' && callOf(event)?.name === 'record_research_brief')
const accepted = earlier.findLast((event) => event.type === 'tool.completed' && event.data.isError !== true && callOf(event)?.name === 'record_research_brief')
const reference = earlier.findLast((event) => event.type === 'tool.completed' && event.data.isError !== true && callOf(event)?.name === 'record_reference_style')
assert.ok(rejected && accepted && reference, 'Need the real earlier rejection and later accepted brief/reference')
assert.ok(rejected.seq < accepted.seq)
function pair(event: SessionEvent): ModelMessage[] {
  const call = callOf(event)
  assert.ok(call && typeof event.data.result === 'string')
  return [
    { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
    { role: 'tool', tool_call_id: call.id, content: event.data.result,
      tool_result_status: event.type === 'tool.failed' ? 'failed' : 'succeeded' },
  ]
}
const summarized: ModelMessage[] = [{ role: 'user', content: user!.data.content as string }, ...pair(rejected)]
const retained = [...pair(accepted), ...pair(reference)]
const messages = compactionRequestMessages(summarized, retained)
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-checkpoint-boundary-'))
const startedAt = Date.now()
const maxRequests = 1 + config.maxLengthContinuations
const report: Record<string, unknown> = {
  kind: 'checkpoint-boundary-component-canary', fullAgentTask: false, chatUiVerified: false,
  controlledSubsetNotOriginalRequestReplay: true,
  dataRoot, sourceRoot: resolve(sourceRoot), sourceSessionId,
  originalCheckpointSeq: checkpoint.seq, summarizedEventSeqs: [user!.seq, rejected.seq], retainedEventSeqs: [accepted.seq, reference.seq],
  model: config.model, maxOutputTokens: 1_800, maxLengthContinuations: config.maxLengthContinuations,
  maxRequests, requestBytes: Buffer.byteLength(JSON.stringify({ messages })),
  requestSha256: createHash('sha256').update(JSON.stringify({ messages })).digest('hex'),
  retainedIndex: retainedCheckpointIndex(retained), transportCompleted: false,
}
await writeFile(resolve(dataRoot, 'request.json'), JSON.stringify({ messages }, null, 2), { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ dataRoot, model: config.model, kind: report.kind }))
try {
  const client = new DeepSeekClient({
    apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl, model: config.model,
    temperature: config.modelTemperature, thinking: config.modelThinking,
    ...(config.modelThinking === 'enabled' ? { reasoningEffort: config.modelReasoningEffort } : {}),
    maxOutputTokens: 1_800, maxRetries: 0, maxEmptyCompletionRetries: 0,
    maxLengthContinuations: config.maxLengthContinuations,
    firstEventTimeoutMs: config.modelFirstEventTimeoutMs, fetch: fetchPublicUrl,
  })
  const result = await client.stream({ messages, tools: [], toolChoice: 'none', thinking: 'disabled', maxModelRequests: maxRequests,
    signal: AbortSignal.timeout(90_000), onContent: () => {}, onReasoning: () => {} })
  Object.assign(report, { finishReason: result.finishReason, usage: result.usage,
    modelRequestCount: result.modelRequestCount, modelCallCount: result.modelCallCount,
    summary: result.content, toolCallCount: result.toolCalls.length })
  assert.equal(result.finishReason, 'stop', 'A truncated summary is not a complete checkpoint')
  assert.equal(result.toolCalls.length, 0)
  assert.ok(result.modelRequestCount && result.modelRequestCount <= maxRequests)
  assert.ok(result.content.trim())
  report.transportCompleted = true
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  report.durationMs = Date.now() - startedAt
  await writeFile(resolve(dataRoot, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
  // Manual review of this actual output remains necessary. Transport success
  // alone does not prove that the model's historical/factual claims are true.
  console.log(JSON.stringify(report, null, 2))
}
