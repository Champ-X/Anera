/** Offline routing replay on isolated copies of an existing canary root.
 * The model is a local stub, the only executable tool is read_file, and the
 * original state/journal/artifact are hash-checked unchanged. No provider,
 * network, Browser, editing or presentation operation is performed.
 * Usage: node --import tsx scripts/research-membership-exclusion-replay.ts <canary-root> <session-id>
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { AgentService, canonicalResearchHtmlContentGap } from '../src/server/agent-service.js'
import { SessionStore, type StoredSession } from '../src/server/session-store.js'
import type { ModelMessage, ToolCallRecord } from '../src/shared/types.js'
import type { ToolDefinition } from '../src/server/tools.js'

assert(process.argv[2] && process.argv[3], 'Supply a retained canary root and session ID.')
const originalRoot = resolve(process.argv[2])
const sessionId = process.argv[3]
assert(/^ses_[a-z0-9]+$/u.test(sessionId), 'Expected one exact session ID.')
const originalSession = resolve(originalRoot, 'sessions', sessionId)
const originalStateBytes = await readFile(resolve(originalSession, 'state.json'))
const originalState = JSON.parse(originalStateBytes.toString('utf8')) as StoredSession
const artifact = originalState.activeVisualArtifact
const brief = originalState.activeTaskResearchEvidence?.brief
assert(artifact && brief, 'Replay requires the actual accepted brief and canonical artifact ledger.')
assert(!artifact.path.includes('..') && !artifact.path.startsWith('/'), 'Expected a workspace-local artifact path.')
const protectedPaths = [resolve(originalSession, 'state.json'), resolve(originalSession, 'events.jsonl'),
  resolve(originalSession, 'workspace', artifact.path)]
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const before = await Promise.all(protectedPaths.map(async (path) => ({ path, sha256: sha(await readFile(path)) })))
const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 }
const results: Array<Record<string, unknown>> = []

for (const mode of ['retained_raw', 'compacted_raw'] as const) {
  const copyRoot = await mkdtemp(resolve(tmpdir(), 'anera-membership-routing-replay-'))
  await cp(originalRoot, copyRoot, { recursive: true })
  const store = new SessionStore(copyRoot, originalState.summary.model)
  await store.initialize()
  let compactedReads = 0
  if (mode === 'compacted_raw') {
    await store.update(sessionId, (state) => {
      const calls = new Map(state.messages.flatMap((message) => (message.tool_calls ?? []).map((call) => [call.id, call])))
      state.messages = state.messages.map((message) => {
        const call = message.tool_call_id ? calls.get(message.tool_call_id) : undefined
        if (message.role !== 'tool' || call?.function.name !== 'read_file') return message
        const args = JSON.parse(call.function.arguments)
        if (args.path !== artifact.path) return message
        compactedReads += 1
        return { ...message, content: '[Historical tool result compacted after a later assistant response consumed it; metadata only.]' }
      })
    })
    assert(compactedReads > 0, 'Expected an actual retained read to compact in the isolated replay.')
  }
  const seen: string[][] = []
  const executed: string[] = []
  let boundaryReached = false
  const stream = async (options: { tools: ToolDefinition[]; messages: ModelMessage[] }) => {
    const names = options.tools.map((tool) => tool.function.name)
    seen.push(names)
    for (const name of ['web_search', 'web_fetch', 'fetch_page', 'record_research_brief']) assert(names.includes(name), name)
    for (const name of ['start_process', 'browser', 'present_file', 'write_file']) assert(!names.includes(name), name)
    assert(options.messages.some((message) => String(message.content).includes('source-exclusion decision')))
    if (mode === 'compacted_raw' && seen.length === 1) {
      assert(names.includes('read_file') && !names.includes('edit_file'))
      return { content: '', reasoningContent: 'Offline fixture chooses the permitted raw source-exclusion read.',
        toolCalls: [{ id: 'offline-membership-read', type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: artifact.path, offset: 1, limit: 5000 }) } }],
        finishReason: 'tool_calls' as const, usage, modelCallCount: 1 }
    }
    assert(names.includes('edit_file') && !names.includes('read_file'))
    boundaryReached = true
    throw new Error('OFFLINE_REPLAY_STOP: source-exclusion edit is available; no edit or provider operation is performed.')
  }
  const execute = async (call: ToolCallRecord) => {
    assert.equal(call.name, 'read_file', 'Replay must never execute research, mutations or Browser tools.')
    assert.deepEqual(call.arguments, { path: artifact.path, offset: 1, limit: 5000 })
    executed.push(call.name)
    const content = await readFile(resolve(store.workspaceDir(sessionId), artifact.path), 'utf8')
    return { content: JSON.stringify({ status: 'success', path: artifact.path, kind: 'text', content,
      hash: createHash('sha256').update(content).digest('base64url'), hasMore: false }), isError: false }
  }
  const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never,
    contextCompactionThresholdTokens: 1_000_000, contextWindowTokens: 2_000_000, runTimeoutMs: 10_000 })
  try {
    await agent.resume(sessionId)
    for (let attempt = 0; agent.isRunning(sessionId) && attempt < 1000; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10))
    }
    assert(!agent.isRunning(sessionId), 'Offline replay failed to settle.')
    const replayState = await store.get(sessionId)
    const events = await store.events(sessionId)
    assert(boundaryReached, JSON.stringify(events.filter((event) => event.type === 'error')))
    assert.equal(replayState.activeTaskResearchEvidence?.brief?.sha256, brief.sha256)
    assert.equal(sha(await readFile(resolve(store.workspaceDir(sessionId), artifact.path))), before[2].sha256)
    const contentGap = await canonicalResearchHtmlContentGap(store.workspaceDir(sessionId), replayState.messages,
      artifact.path, replayState.activeTaskResearchEvidence!.sourceUrls, { requiresResearch: true, requiresPageBody: true,
        requireResearchBrief: true, researchBrief: replayState.activeTaskResearchEvidence?.brief,
        researchPageReads: replayState.activeTaskResearchEvidence?.pageReads ?? [] })
    assert(contentGap?.includes('Research-brief membership review required'), 'Offering exclusion must not approve unchanged HTML.')
    assert.equal(seen.length, mode === 'retained_raw' ? 1 : 2)
    assert.deepEqual(executed, mode === 'retained_raw' ? [] : ['read_file'])
    results.push({ mode, copyRoot, compactedReads, toolSurfaces: seen, executedTools: executed,
      acceptedBriefSha256: brief.sha256, unchangedArtifactSha256: before[2].sha256,
      unchangedMembershipStillBlocksDelivery: true })
  } finally { await agent.shutdown() }
}
for (const entry of before) assert.equal(sha(await readFile(entry.path)), entry.sha256, `Original evidence changed: ${entry.path}`)
console.log(JSON.stringify({ passed: true, liveProviderCalls: 0, networkToolsExecuted: 0, artifactEdits: 0,
  originalRoot, originalUnchanged: before, results }, null, 2))
