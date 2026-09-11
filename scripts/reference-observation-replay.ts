/** Zero-model reproduction of a terminal session's exact source capture.
 * Copies no user state back and never generates/approves an artifact. */
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BrowserManager } from '../src/server/browser-manager.js'
import { materializeReferenceFonts } from '../src/server/reference-fonts.js'
import { extractReferenceStyleSourceProfile, findReferenceStyleEvidence, normalizeReferenceStyleContract,
  normalizeReferenceStyleContractAgainstEvidence } from '../src/server/reference-style.js'
import { SessionStore, type StoredSession } from '../src/server/session-store.js'
import { AgentService } from '../src/server/agent-service.js'
import { ToolExecutor } from '../src/server/tools.js'
import { ProcessManager } from '../src/server/process-manager.js'
import type { DeepSeekClient } from '../src/server/deepseek.js'
import type { SessionEvent } from '../src/shared/types.js'

const sessionRoot = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('Explicit terminal session directory required')
const controllerReplay = process.argv[3] === '--controller'
if (process.argv.length > 4 || process.argv[3] && !controllerReplay) throw new Error('Unknown replay option')
const statePath = resolve(sessionRoot, 'state.json'), eventsPath = resolve(sessionRoot, 'events.jsonl')
const before = await Promise.all([statePath, eventsPath].map((path) => readFile(path)))
const state = JSON.parse(before[0].toString()) as StoredSession
if (!['completed', 'failed', 'cancelled', 'timed_out'].includes(state.summary.status)) throw new Error('Terminal session required')
const events = before[1].toString().trim().split('\n').map((line) => JSON.parse(line) as SessionEvent)
const call = events.find((event) => event.type === 'tool.failed'
  && (event.data.call as { name?: string })?.name === 'record_reference_style')?.data.call as { arguments: Record<string, unknown> } | undefined
if (!call) throw new Error('A recorded failed reference capture is required')
const proposed = normalizeReferenceStyleContract(call.arguments)
const evidence = findReferenceStyleEvidence(state.messages, [proposed.sourceUrl])
if (!evidence) throw new Error('Original source bytes missing; do not fetch a replacement')
const contract = normalizeReferenceStyleContractAgainstEvidence(proposed, evidence).contract
const profile = extractReferenceStyleSourceProfile(evidence.content, contract)
if (!profile) throw new Error('Missing original source profile')
const root = resolve('.anera/canary-runs')
await mkdir(root, { recursive: true })
const output = await mkdtemp(resolve(root, 'reference-observation-'))
const browser = new BrowserManager()
const signal = AbortSignal.timeout(120_000)
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
let captured: unknown, failure: string | undefined, controllerEvidence: unknown
try {
  if (controllerReplay) {
    // Replay one recorded proposal, not model reasoning or a new generation.
    // Actual ToolExecutor/Browser/SessionStore perform the dependency commit.
    const store = new SessionStore(output, state.summary.model)
    await store.initialize()
    await cp(sessionRoot, resolve(output, 'sessions', state.summary.id), { recursive: true, errorOnExist: true, force: false })
    const processes = new ProcessManager(() => {}, 1000)
    const tools = new ToolExecutor(store, processes, browser, { inspect: async () => { throw new Error('Vision forbidden in reference replay') } }, async () => false)
    let requests = 0, downstreamTools: string[] = []
    const stream: DeepSeekClient['stream'] = async (options) => {
      requests++
      if (requests > 1) {
        downstreamTools = options.tools.map((tool) => tool.function.name)
        throw new Error('Replay stopped at next planning boundary; no generation attempted')
      }
      if (!options.tools.some((tool) => tool.function.name === 'record_reference_style')) throw new Error('Recorded dependency proposal not enabled in restored phase')
      return { content: '', reasoningContent: '', finishReason: 'tool_calls',
        toolCalls: [{ id: 'reference-observation-replay', type: 'function', function: { name: 'record_reference_style', arguments: JSON.stringify(call.arguments) } }],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 }, modelCallCount: 0, modelRequestCount: 0 }
    }
    const agent = new AgentService(store, { client: { stream } as never, tools, runTimeoutMs: 120_000 })
    try {
      const seq = events.at(-1)!.seq
      await agent.resume(state.summary.id)
      while (agent.isRunning(state.summary.id)) { signal.throwIfAborted(); await new Promise((done) => setTimeout(done, 100)) }
      const current = await store.get(state.summary.id)
      const replayEvents = (await store.events(state.summary.id)).filter((event) => event.seq > seq)
      const terminals = replayEvents.filter((event) => event.type === 'tool.completed' || event.type === 'tool.failed')
      captured = current.activeReferenceStyleContract?.renderProfile
      // A new successful observation may start a fresh tracking record; its
      // absence is not required. The exhausted retry state must be reset and
      // anchored to new durable evidence, while history remains auditable.
      const progressReset = !current.visualNoProgress || current.visualNoProgress.recoveryCount === 0
        && current.visualNoProgress.consecutiveCount === 1 && !current.visualNoProgress.recoveryAttempted
        && current.visualNoProgress.progressDigest !== state.visualNoProgress?.progressDigest
      const verified = requests === 2 && terminals.length === 1 && terminals[0].type === 'tool.completed'
        && Boolean(captured) && progressReset && !downstreamTools.includes('record_reference_style')
      controllerEvidence = { verified, syntheticPlanningRequests: requests, downstreamTools,
        contractPersisted: Boolean(current.activeReferenceStyleContract), progressReset,
        terminals: terminals.map((event) => ({ seq: event.seq, type: event.type, call: (event.data.call as { name?: string })?.name })),
        errors: replayEvents.filter((event) => event.type === 'error').map((event) => event.data.message),
        fullGenerationVerified: false }
      if (!verified) throw new Error('Controller replay did not pass the dependency commit and next-phase boundary')
    } finally { await agent.shutdown(); await processes.shutdown() }
  } else {
  const fonts = await materializeReferenceFonts(evidence.content, signal)
  const bundle = await browser.captureReferenceRenderBundle(fonts.rewrittenHtml, profile, evidence.sha256, contract.viewport,
    { signal, ...(fonts.manifest ? { fontCss: fonts.fontCss, expectedFontFamilies: fonts.familyNames } : {}) })
  captured = bundle.profile
  await Promise.all(Object.entries(bundle.screenshots).map(([phase, bytes]) => writeFile(resolve(output, `${phase}.png`), bytes)))
  }
} catch (error) {
  failure = error instanceof Error ? error.message : 'Reference capture failed'
  process.exitCode = 1
} finally { await browser.shutdown() }
const after = await Promise.all([statePath, eventsPath].map((path) => readFile(path)))
const report = { scope: 'original source observation only, not generation or artifact acceptance', sessionRoot, modelCalls: 0,
  sourceUnchanged: before.every((bytes, i) => sha(bytes) === sha(after[i])), stateAndEventsSha256: before.map(sha),
  referenceSha256: evidence.sha256, viewport: contract.viewport, captured, controllerEvidence, failure }
if (!report.sourceUnchanged) process.exitCode = 1
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ output, ...report, captured: Boolean(captured) }))
