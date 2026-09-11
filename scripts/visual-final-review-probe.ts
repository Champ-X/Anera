import './legacy-live-test-disabled.mjs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DeepSeekClient } from '../src/server/deepseek.js'
import { config } from '../src/server/config.js'
import { fetchPublicUrl } from '../src/server/network-policy.js'
import { visualDeliveryCompletionControl, visualDeliveryContext } from '../src/server/visual-delivery.js'
import { visualFinalReviewMessages } from '../src/server/visual-final-review.js'
import { collectVisualFinalReviewProbe } from '../src/eval/visual-final-review-probe.js'
import { recoverActiveTaskRequestText } from '../src/server/agent-service.js'
import type { SessionEvent } from '../src/shared/types.js'
import { resolveWorkspacePath } from '../src/server/workspace.js'
import type { StoredSession } from '../src/server/session-store.js'

// Read-only semantic-review prototype. Not a fresh task or production acceptance.
if (!process.argv[2]) throw new Error('Usage: npx tsx scripts/visual-final-review-probe.ts <completed-session-directory> [draft-report.json]')
const source = resolve(process.argv[2])
const stateBytes = await readFile(resolve(source, 'state.json'))
const state = JSON.parse(stateBytes.toString('utf8')) as StoredSession
const eventBytes = await readFile(resolve(source, 'events.jsonl'))
const events = eventBytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as SessionEvent)
const last = state.messages.at(-1)
if (state.summary.status !== 'completed' || !state.activeVisualArtifact || last?.role !== 'assistant' || last.tool_calls?.length) throw new Error('Requires a completed visual task and its Final')
const draft = process.argv[3] ? JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')).content : last.content
if (typeof draft !== 'string') throw new Error('Requires a textual draft')
const evidenceRoot = await mkdtemp(resolve(tmpdir(), 'anera-visual-final-review-'))
const workspace = resolve(source, 'workspace')
const sourceFiles = [resolve(source, 'state.json'), resolve(source, 'events.jsonl'), resolveWorkspacePath(workspace, state.activeVisualArtifact.path)]
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const before = await Promise.all(sourceFiles.map(async (path) => digest(await readFile(path))))
if (before[0] !== digest(stateBytes) || before[1] !== digest(eventBytes)) throw new Error('Source state or journal changed before review admission')
const context = await visualDeliveryContext({ workspace, artifact: state.activeVisualArtifact, brief: state.activeTaskResearchEvidence?.brief })
if (JSON.parse(context.split('\n').at(-1)!).artifact.status !== 'hash_verified') throw new Error('Missing hash-bound delivery evidence')
const taskRequest = recoverActiveTaskRequestText(events)
if (!taskRequest) throw new Error('Requires original user-authored task requirements in the journal; a checkpoint is not a substitute')
const messages = visualFinalReviewMessages({ taskRequest, draft, deliveryContext: context,
  completionControl: visualDeliveryCompletionControl({ requiresResearch: Boolean(state.activeTaskResearchEvidence?.brief), hasStyleReference: Boolean(state.activeReferenceStyleContract) }) })
const client = new DeepSeekClient({ apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl, model: state.summary.model,
  thinking: config.modelThinking, temperature: config.modelTemperature,
  ...(config.modelThinking === 'enabled' ? { reasoningEffort: config.modelReasoningEffort } : {}),
  maxOutputTokens: config.maxOutputTokens, firstEventTimeoutMs: config.modelFirstEventTimeoutMs,
  maxLengthContinuations: config.maxLengthContinuations, fetch: fetchPublicUrl })
console.log(JSON.stringify({ diagnostic: 'final_review_prototype', source, evidenceRoot, draftBytes: Buffer.byteLength(draft), maxPhysicalRequests: 1 }))
const startedAt = Date.now()
const outcome = await collectVisualFinalReviewProbe(client.stream.bind(client), { messages, tools: [], toolChoice: 'none', maxModelRequests: 1,
  maxTotalTokens: config.maxAgentTotalTokensPerTurn, maxOutputTokens: Math.min(config.maxOutputTokens, 4_096),
  signal: AbortSignal.timeout(Math.min(config.runTimeoutMs, 900_000)) }, draft, context)
const after = await Promise.all(sourceFiles.map((path) => readFile(path).then(digest).catch(() => 'unavailable')))
const report = { diagnostic: 'final_review_prototype', source, elapsedSeconds: (Date.now() - startedAt) / 1000,
  sourceStateUnchanged: digest(stateBytes) === after[0], sourceUnchanged: JSON.stringify(before) === JSON.stringify(after), sourceHashes: before,
  taskRequestSource: 'journal_turn_started', taskRequestSha256: digest(taskRequest),
  draftSha256: digest(draft), requestSha256: digest(JSON.stringify(messages)), ...outcome }
await writeFile(resolve(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (!report.protocolPassed || !report.sourceUnchanged || !report.sourceStateUnchanged) process.exitCode = 1
