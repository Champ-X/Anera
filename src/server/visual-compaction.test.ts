import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import {
  AgentService,
  arenaUserAuthoredText,
  canonicalDiagnosticReadCursor,
  compactHistoricalToolPayloads,
  groupMessages,
  projectArenaCompactionCheckpoint,
  researchArtifactSourceRepairPhase,
  referenceStyleArtifactRepairPhase,
  visualWebArtifactCompletionGap,
  visualWorkflowCompactionAnchors,
} from './agent-service.js'
import { COMPACTION_CONTINUATION_CONTEXT } from './checkpoint-context.js'
import { researchPageReadFromResult } from './research-evidence.js'
import { SessionStore } from './session-store.js'

function step(id: string, name: string, args: Record<string, unknown>, result: string): ModelMessage[] {
  return [
    {
      role: 'assistant', content: null, reasoning_content: `Exact reasoning for ${id}.`,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    { role: 'tool', tool_call_id: id, content: result, tool_result_status: 'succeeded' },
  ]
}

const request: ModelMessage = { role: 'user', content: '制作中文 HTML Slides，保留六页并检查实际渲染。' }
const html = `<!doctype html><html><head><title>Deck</title></head><body>${Array.from({ length: 6 }, (_, i) => `<section class="slide"><h1>${i + 1}</h1></section>`).join('')}</body></html>`
const url = 'http://localhost:8000/deck.html'
const write = step('write', 'write_file', { path: 'deck.html', content: html }, '{"status":"success","hash":"current-hash"}')
const verify = step('verify', 'verify_reference_style', { path: 'deck.html' }, '{"status":"success","fidelity":"pass"}')
const preview = step('preview', 'start_process', { command: 'python3 -m http.server 8000' }, '{"status":"success","url":"http://localhost:8000"}')
const open = step('open', 'browser', { action: 'open', path: url }, JSON.stringify({ url, text: '1 / 6' }))
const navigation = step('next', 'browser', { action: 'press', key: 'ArrowRight' }, JSON.stringify({ url: `${url}#2`, text: '2 / 6' }))
const screenshot = step('shot', 'browser', { action: 'screenshot', screenshot_path: 'deck.png' }, 'Saved browser screenshot to deck.png (124 bytes).')
const defect = step('defect', 'inspect_image', { path: 'deck.png', prompt: 'Return exactly NO DEFECTS or concrete defects.' }, 'Visual inspection:\nThe footer clips at the viewport edge.')
const workflow = [request, ...write, ...verify, ...preview, ...open, ...navigation, ...screenshot, ...defect]

describe('visual workflow checkpoint anchors', () => {
  it('keeps current machine dependencies and exact paired reasoning outside the checkpoint', () => {
    const anchors = visualWorkflowCompactionAnchors(workflow)
    const retained = groupMessages(workflow).filter((group) => group.some((message) => anchors.has(message))).flat()
    expect(retained).toEqual(workflow)
    expect(visualWebArtifactCompletionGap(retained)).toEqual(visualWebArtifactCompletionGap(workflow))
    expect(visualWebArtifactCompletionGap(retained)?.missingPhases).toContain('visual_inspection_pass')
  })

  it('releases superseded versions and epochs while retaining the newest open even when it is wrong', () => {
    const edit = step('edit', 'edit_file', { path: 'deck.html', old_text: '1', new_text: 'one' }, '{"status":"success","hash":"new-hash"}')
    const decoyOpen = step('decoy', 'browser', { action: 'open', path: 'other.html' }, '{"url":"http://localhost:8000/other.html"}')
    const messages = [...workflow, ...edit, ...decoyOpen]
    const anchors = visualWorkflowCompactionAnchors(messages, 'deck.html')
    expect(anchors.has(write[0])).toBe(false)
    expect(anchors.has(verify[0])).toBe(false)
    expect(anchors.has(open[0])).toBe(false)
    expect(anchors.has(defect[0])).toBe(false)
    expect(anchors.has(edit[0])).toBe(true)
    expect(anchors.has(decoyOpen[0])).toBe(true)
  })

  it('does not let another HTML mutation erase the canonical verification epoch', () => {
    const unrelatedEdit = step('other-edit', 'edit_file', { path: 'other.html', old_text: 'a', new_text: 'b' }, '{"status":"success","hash":"other-hash"}')
    const anchors = visualWorkflowCompactionAnchors([...workflow, ...unrelatedEdit], 'deck.html')
    expect(anchors.has(write[0])).toBe(true)
    expect(anchors.has(open[0])).toBe(true)
    expect(anchors.has(unrelatedEdit[0])).toBe(false)
  })

  it('does not carry old task evidence into an unrelated user request', () => {
    expect(visualWorkflowCompactionAnchors([
      ...workflow, { role: 'user', content: 'Explain TCP congestion control.' },
    ]).size).toBe(0)
  })

  it('protects remaining records when trusted durable state identifies a legacy compacted visual task', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '[Harness operator action: Continue] Resume the unfinished task.' },
      ...verify, ...preview, ...open, ...navigation, ...screenshot, ...defect,
    ]
    const anchors = visualWorkflowCompactionAnchors(messages, 'deck.html', true)
    expect(anchors.has(messages[0])).toBe(false)
    expect(anchors.has(verify[0])).toBe(true)
    expect(anchors.has(open[0])).toBe(true)
    expect(anchors.has(defect[0])).toBe(true)
  })

  it('protects exact repair bytes using durable identity after the original write was summarized', () => {
    const read = step('read-current', 'read_file', { path: 'deck.html' }, JSON.stringify({
      status: 'success', kind: 'text', content: 'exact middle bytes '.repeat(700), hasMore: false,
    }))
    const messages: ModelMessage[] = [request, ...read, { role: 'assistant', content: 'Repairing the reported footer.' }]
    const compacted = compactHistoricalToolPayloads(messages, { forceResultCompaction: true, canonicalPath: 'deck.html' })
    expect(compacted.messages).toEqual(messages)
    const anchors = visualWorkflowCompactionAnchors(compacted.messages, 'deck.html')
    expect(anchors.has(read[1])).toBe(true)
    const groups = groupMessages(compacted.messages).filter((group) => group.some((message) => anchors.has(message)))
    expect(groups.flat()).toContainEqual(read[0])
    expect(groups.flat()).toContainEqual(read[1])
  })

  it.each([false, true])('retains every current source-repair page without a text-view fallback (forced=%s)', (forceResultCompaction) => {
    const failed = step('source-failed', 'verify_reference_style', { path: 'deck.html' }, JSON.stringify({
      status: 'success', fidelity: 'mismatch', violations: ['v3.t7 contains ASCII U+0029 in a CJK run.'],
    }))
    const head = step('source-head', 'read_file', { path: 'deck.html', offset: 1, limit: 5_000 }, JSON.stringify({
      status: 'success', kind: 'text', content: 'prefix '.repeat(1_000) + 'EXACT_CURRENT_V3_T7' + ' suffix'.repeat(1_000),
      offset: 1, returnedLines: 403, hasMore: true, nextOffset: 404, truncated: true,
    }))
    const tail = step('source-tail', 'read_file', { path: 'deck.html', offset: 404, limit: 5_000 }, JSON.stringify({
      status: 'success', kind: 'text', content: '</body></html>', offset: 404, hasMore: false,
    }))
    const messages = [request, ...write, ...failed, ...head, ...tail, { role: 'assistant' as const, content: 'Fixing the CJK run.' }]
    const compacted = compactHistoricalToolPayloads(messages, { forceResultCompaction, canonicalPath: 'deck.html' })
    expect(compacted.messages.find((message) => message.tool_call_id === 'source-head')).toEqual(head[1])
    const anchors = visualWorkflowCompactionAnchors(compacted.messages, 'deck.html')
    expect(anchors.has(head[1])).toBe(true)
    expect(anchors.has(tail[1])).toBe(true)
    expect(referenceStyleArtifactRepairPhase(compacted.messages, 'deck.html')).toBe('edit')

    const edit = step('source-edit', 'edit_file', { path: 'deck.html', old_text: 'bad', new_text: 'fixed' }, '{"status":"success","hash":"fixed"}')
    const released = compactHistoricalToolPayloads([...messages, ...edit, { role: 'assistant', content: 'Reverify.' }], {
      forceResultCompaction: true, canonicalPath: 'deck.html',
    })
    expect(released.messages.find((message) => message.tool_call_id === 'source-head')?.content).toContain('Historical tool result compacted')
  })

  it.each(['compacted prefix', 'missing prefix', 'missing same-line prefix'] as const)('reopens source repair for a %s instead of treating the terminal suffix as complete', (missing) => {
    const failed = step('source-failed', 'verify_reference_style', { path: 'deck.html' }, '{"status":"success","fidelity":"mismatch"}')
    const compacted = step('lost-head', 'read_file', { path: 'deck.html', offset: 1, limit: 5_000 },
      '[Historical tool result compacted after a later assistant response consumed it: 81640 UTF-8 bytes, sha256 deadbeef]\n[bytes omitted]')
    const sameLine = missing === 'missing same-line prefix'
    const tail = step('retained-tail', 'read_file', { path: 'deck.html', offset: sameLine ? 1 : 404,
      ...(sameLine ? { content_offset: 80_000 } : {}), limit: 5_000 }, JSON.stringify({
      status: 'success', kind: 'text', content: '</body></html>', offset: sameLine ? 1 : 404,
      ...(sameLine ? { contentOffset: 80_000 } : {}), hasMore: false,
    }))
    const messages = [request, ...write, ...failed, ...(missing === 'compacted prefix' ? compacted : []), ...tail]
    expect(referenceStyleArtifactRepairPhase(messages, 'deck.html')).toBe('read')
    expect(canonicalDiagnosticReadCursor(messages, 'deck.html')).toEqual({ path: 'deck.html', offset: 1, limit: 5_000 })
    const restored = step('restored-head', 'read_file', { path: 'deck.html', offset: 1, limit: 5_000 }, JSON.stringify({
      status: 'success', kind: 'text', content: 'exact missing bytes', offset: 1, hasMore: true,
      ...(sameLine ? { nextContentOffset: 80_000 } : { nextOffset: 404 }),
    }))
    // The already-retained tail need not be fetched a second time.
    expect(referenceStyleArtifactRepairPhase([...messages, ...restored], 'deck.html')).toBe('edit')
  })

  it.each([false, true])('refills only a missing interior page and reuses both retained sides (same-line=%s)', (sameLine) => {
    const failed = step('source-failed', 'verify_reference_style', { path: 'deck.html' }, '{"status":"success","fidelity":"mismatch"}')
    const page = (id: string, index: number, hasMore: boolean) => step(id, 'read_file', {
      path: 'deck.html', offset: sameLine ? 1 : 1 + 60 * index,
      ...(sameLine && index ? { content_offset: 80_000 * index } : {}),
    }, JSON.stringify({ status: 'success', kind: 'text', content: `exact page ${index}`,
      offset: sameLine ? 1 : 1 + 60 * index, hasMore,
      ...(sameLine && index ? { contentOffset: 80_000 * index } : {}),
      ...(hasMore ? sameLine ? { nextContentOffset: 80_000 * (index + 1) } : { nextOffset: 1 + 60 * (index + 1) } : {}),
    }))
    const messages = [request, ...write, ...failed, ...page('head', 0, true), ...page('tail', 2, false)]
    expect(referenceStyleArtifactRepairPhase(messages, 'deck.html')).toBe('read')
    expect(canonicalDiagnosticReadCursor(messages, 'deck.html')).toEqual({ path: 'deck.html', offset: sameLine ? 1 : 61,
      ...(sameLine ? { content_offset: 80_000 } : {}), limit: 5_000 })
    expect(referenceStyleArtifactRepairPhase([...messages, ...page('middle', 1, true)], 'deck.html')).toBe('edit')
  })

  it.each(['failed', 'not executed', 'wrong path', 'older mutation'] as const)('does not fill a pagination gap with a %s result', (invalid) => {
    const failed = step('source-failed', 'verify_reference_style', { path: 'deck.html' }, '{"status":"success","fidelity":"mismatch"}')
    const tail = step('invalid-tail', 'read_file', { path: invalid === 'wrong path' ? 'other.html' : 'deck.html', offset: 61 }, JSON.stringify({
      status: 'success', kind: 'text', content: '</html>', offset: 61, hasMore: false,
      ...(invalid === 'not executed' ? { notExecuted: true } : {}),
    }))
    if (invalid === 'failed') tail[1].tool_result_status = 'failed'
    const head = step('head', 'read_file', { path: 'deck.html', offset: 1 }, JSON.stringify({
      status: 'success', kind: 'text', content: '<html>', offset: 1, hasMore: true, nextOffset: 61,
    }))
    const messages = [request, ...(invalid === 'older mutation' ? tail : []), ...write, ...failed, ...head,
      ...(invalid === 'older mutation' ? [] : tail)]
    expect(referenceStyleArtifactRepairPhase(messages, 'deck.html')).toBe('read')
    expect(canonicalDiagnosticReadCursor(messages, 'deck.html')).toEqual({ path: 'deck.html', offset: 61, limit: 5_000 })
  })

  it.each(['source failure', 'edit context miss'])('uses the same fresh-read boundary for routing and pagination after a %s', (boundary) => {
    const oldTail = step('pre-defect-tail', 'read_file', { path: 'deck.html', offset: 61 }, JSON.stringify({
      status: 'success', kind: 'text', content: 'old diagnostic tail', offset: 61, hasMore: false,
    }))
    const failed = boundary === 'source failure'
      ? step('source-failed', 'verify_reference_style', { path: 'deck.html' }, '{"status":"success","fidelity":"mismatch"}')
      : step('context-miss', 'edit_file', { path: 'deck.html', old_text: 'missing', new_text: 'fixed' },
        '{"status":"error","message":"Context not found. Read the file to verify the text exists."}')
    if (boundary === 'edit context miss') failed[1].tool_result_status = 'failed'
    const head = step('fresh-head', 'read_file', { path: 'deck.html', offset: 1 }, JSON.stringify({
      status: 'success', kind: 'text', content: 'fresh diagnostic head', offset: 1, hasMore: true, nextOffset: 61,
    }))
    expect(canonicalDiagnosticReadCursor([request, ...write, ...oldTail, ...failed, ...head], 'deck.html'))
      .toEqual({ path: 'deck.html', offset: 61, limit: 5_000 })
  })

  it('releases repair pages after a later source pass and does not revive its superseded failure', () => {
    const failed = step('source-failed', 'verify_reference_style', { path: 'deck.html' }, '{"status":"success","fidelity":"mismatch"}')
    const read = step('source-read', 'read_file', { path: 'deck.html', offset: 1 }, JSON.stringify({
      status: 'success', kind: 'text', content: 'current HTML '.repeat(1_000), hasMore: false,
    }))
    const messages = [request, ...write, ...failed, ...read, ...verify, { role: 'assistant' as const, content: 'Continue required verification.' }]
    expect(referenceStyleArtifactRepairPhase(messages, 'deck.html')).toBeUndefined()
    const compacted = compactHistoricalToolPayloads(messages, { forceResultCompaction: true, canonicalPath: 'deck.html' })
    expect(compacted.messages.find((message) => message.tool_call_id === 'source-read')?.content).toContain('Historical tool result compacted')
    expect(visualWorkflowCompactionAnchors(messages, 'deck.html').has(read[1])).toBe(false)
  })

  it('resumes a compacted source-repair prefix through the main loop with no provider and no duplicate tail read', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-source-repair-prefix-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const failed = step('source-failed', 'verify_reference_style', { path: 'deck.html' }, JSON.stringify({
      status: 'success', fidelity: 'mismatch', violations: ['v3.t7 contains ASCII U+0029 in a CJK run.'],
    }))
    const lost = step('lost-head', 'read_file', { path: 'deck.html', offset: 1, limit: 5_000 },
      '[Historical tool result compacted after a later assistant response consumed it: 81640 UTF-8 bytes, sha256 deadbeef]\n[bytes omitted]')
    const tail = step('retained-tail', 'read_file', { path: 'deck.html', offset: 404, limit: 5_000 }, JSON.stringify({
      status: 'success', kind: 'text', content: '</body></html>', offset: 404, hasMore: false,
    }))
    await store.update(session.summary.id, (state) => {
      state.summary.status = 'failed'
      state.messages = [{ role: 'user', content: 'Recreate a dashboard as one self-contained HTML file.' },
        ...step('write-source-dashboard', 'write_file', { path: 'deck.html',
          content: '<!doctype html><html><body><main>Dashboard</main></body></html>' }, '{"status":"success","hash":"current-hash"}'),
        ...failed, ...lost, ...tail]
    })
    const exactTarget = '<span>broken CJK run</span>'
    const surfaces: string[][] = []
    const stream = vi.fn(async (options: { tools: Array<{ function: { name: string } }>; messages: ModelMessage[] }) => {
      surfaces.push(options.tools.map((tool) => tool.function.name))
      const attempt = surfaces.length
      if (attempt > 3) throw new Error('fixture stop after durable edit; source/render verification is still required')
      if (attempt >= 2) expect(JSON.stringify(options.messages)).toContain(exactTarget)
      if (attempt === 3) {
        const blocked = options.messages.find((message) => message.tool_call_id === 'repair-2')
        expect(blocked?.content).toContain('Use edit_file for the pending defect')
        expect(blocked?.content).not.toContain('start or continue browser verification')
      }
      return {
        content: '', reasoningContent: '', finishReason: 'tool_calls',
        toolCalls: [{ id: `repair-${attempt}`, type: 'function' as const, function: {
          name: attempt < 3 ? 'read_file' : 'edit_file', arguments: JSON.stringify(attempt < 3
            ? { path: 'deck.html', offset: 236, limit: 130 }
            : { path: 'deck.html', old_text: exactTarget, new_text: '<span>fixed CJK run</span>' }),
        } }], usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 },
      }
    })
    const execute = vi.fn(async (call: { name: string; arguments: Record<string, unknown> }) => ({
      content: JSON.stringify(call.name === 'read_file'
        ? { status: 'success', kind: 'text', content: 'prefix '.repeat(1_000) + exactTarget + ' suffix'.repeat(1_000),
          offset: 1, hasMore: true, nextOffset: 404, truncated: true }
        : { status: 'success', hash: 'fixed' }), isError: false,
    }))
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never })
    try {
      await agent.resume(session.summary.id)
      await vi.waitFor(() => expect(agent.isRunning(session.summary.id)).toBe(false), { timeout: 5_000, interval: 20 })
      expect(surfaces.slice(0, 3)).toEqual([['read_file'], ['edit_file'], ['edit_file']])
      expect(stream).toHaveBeenCalledTimes(4)
      expect(execute.mock.calls.map(([call]) => call.name)).toEqual(['read_file', 'edit_file'])
      expect(execute.mock.calls[0][0].arguments).toEqual({ path: 'deck.html', offset: 1, limit: 5_000 })
      expect((await store.events(session.summary.id)).filter((event) => event.type === 'tool.completed')
        .some((event) => event.callId === 'repair-3')).toBe(true)
      expect((await store.get(session.summary.id)).summary.status).toBe('failed')
    } finally {
      await agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('pins a non-executed citation admission only until the file changes or presentation succeeds', () => {
    const blocked = step('present-blocked', 'present_file', { path: 'deck.html' }, JSON.stringify({
      status: 'verification_required', not_executed: true,
      message: 'Research-source verification failed for deck.html. Add at least one exact retrieved source URL to the deliverable.',
    }))
    const pending = [...workflow, ...blocked]
    expect(visualWorkflowCompactionAnchors(pending, 'deck.html').has(blocked[0])).toBe(true)
    expect(visualWorkflowCompactionAnchors(pending, 'deck.html').has(blocked[1])).toBe(true)
    for (const resolved of [
      step('edit-source', 'edit_file', { path: 'deck.html', old_text: 'bad', new_text: 'good' }, '{"status":"success","hash":"repaired-hash"}'),
      step('present-ok', 'present_file', { path: 'deck.html' }, '{"status":"success","path":"deck.html"}'),
    ]) expect(visualWorkflowCompactionAnchors([...pending, ...resolved], 'deck.html').has(blocked[1])).toBe(false)
    expect(visualWebArtifactCompletionGap(pending)?.missingPhases).toContain('present_file')
  })

  it('retains the citation failure and next fetch across actual semantic compaction, not just a prose summary', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-citation-checkpoint-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const article = 'https://news.example/read'
    const unread = 'https://news.example/unread'
    const pageRead = researchPageReadFromResult({ name: 'fetch_page', arguments: { url: article } }, {
      status: 'success', url: article, content: 'Current news article body.',
    })!
    const blocked = step('source-blocked', 'present_file', { path: 'deck.html' }, JSON.stringify({
      status: 'verification_required', not_executed: true,
      message: `Research-source verification failed for deck.html. Add at least one exact retrieved source URL to the deliverable. Remove or replace unsupported external URLs: ${unread}. Retrieved source URLs: ${article}`,
    }))
    const history = Array.from({ length: 12 }, (_, index) => {
      const group = step(`old-source-${index}`, 'list_files', {}, '{"status":"success","files":[]}')
      group[0].reasoning_content = `old reasoning ${index} `.repeat(3_000)
      return group
    }).flat()
    // Put the failed admission outside the ordinary recent-message tail.
    const tail = Array.from({ length: 20 }, (_, index) => step(`tail-${index}`, 'list_files', {}, '{"status":"success","files":[]}')).flat()
    const stream = vi.fn(async () => ({
      content: 'Earlier discovery is complete.', reasoningContent: '', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedPromptTokens: 0 }, modelCallCount: 1,
    }))
    const agent = new AgentService(store, {
      client: { stream } as never, contextCompactionThresholdTokens: 12_000, contextWindowTokens: 200_000,
    })
    try {
      const messages: ModelMessage[] = [
        { role: 'user', content: '研究本周新闻，制作中文 HTML Slides。' },
        ...history, ...workflow.slice(1, -2),
        ...step('passed', 'inspect_image', { path: 'deck.png', prompt: 'Return exactly NO DEFECTS or concrete defects.' }, 'Visual inspection:\nNO DEFECTS'),
        ...blocked, ...tail,
      ]
      const options = { canonicalPath: 'deck.html', researchSourceUrls: [article, unread], researchPageReads: [pageRead] }
      const before = visualWebArtifactCompletionGap(messages, options)
      expect(before?.missingPhases).toEqual(['web_research', 'present_file'])
      const prepared = await agent['prepareContext'](
        session.summary.id, 'turn_test', 'step_test', messages,
        new AbortController().signal, 'test-model', undefined, [], 'Test system prompt.',
        { canonicalPath: 'deck.html', visualTask: true },
      )
      expect(prepared.changed).toBe(true)
      expect(stream).toHaveBeenCalledOnce()
      expect(visualWebArtifactCompletionGap(prepared.messages, options)).toEqual(before)
      expect(researchArtifactSourceRepairPhase(prepared.messages, 'deck.html', [article], {
        requiresPageBody: true, discoveredSourceUrls: [article, unread],
      })).toBe('search')
      for (const message of blocked) expect(prepared.messages).toContainEqual(message)
      expect(JSON.stringify(prepared.messages)).not.toContain('old reasoning')
      expect((await store.events(session.summary.id)).some((event) => event.type === 'context.compacted')).toBe(true)
    } finally {
      await agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps failed oversized edits unexecuted and requests a smaller complete repair', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-truncated-edit-repair-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const agent = new AgentService(store)
    try {
      const messages = await agent['failTruncatedToolCalls'](session.summary.id, 'turn_test', 'step_test', [{
        id: 'truncated-edit', name: 'edit_file', arguments: { _parse_error: 'Invalid JSON', _raw: '{"path":"deck.html"' },
      }])
      expect(messages[0].tool_result_status).toBe('failed')
      expect(messages[0].content).toContain('No file bytes changed')
      expect(messages[0].content).toContain('one smaller, complete edit')
      expect(messages[0].content).toContain('never claim the unfinished remainder was applied')
      expect((await store.events(session.summary.id)).find((event) => event.type === 'tool.failed')?.data).toMatchObject({
        notExecuted: true, reason: 'model_output_truncated',
      })
    } finally {
      await agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains the original history when the checkpoint model emits a rejected brief as a pseudo-call', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-checkpoint-proposal-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const rejected = step('rejected-brief', 'record_research_brief', { sources: [{ role: 'primary' }] },
      '{"status":"error","message":"Research brief rejected; no partial brief was recorded."}')
    rejected[1].tool_result_status = 'failed'
    const messages: ModelMessage[] = [request, ...rejected,
      ...Array.from({ length: 20 }, (_, index) => {
        const group = step(`old-${index}`, 'list_files', {}, '{"status":"success","files":[]}')
        group[0].reasoning_content = `old reasoning ${index} `.repeat(700)
        return group
      }).flat(),
    ]
    const invalidSummary = 'Research is complete.\n\n<record_research_brief "{\\"sources\\":[{\\"role\\":\\"primary\\"}]}"'
    const stream = vi.fn(async () => ({ content: invalidSummary, reasoningContent: '', toolCalls: [], finishReason: 'stop',
      modelCallCount: 1, modelRequestCount: 1, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedPromptTokens: 0 } }))
    const agent = new AgentService(store, { client: { stream } as never,
      contextCompactionThresholdTokens: 12_000, contextWindowTokens: 200_000 })
    try {
      const prepared = await agent['prepareContext'](session.summary.id, 'turn_test', 'step_test', messages,
        new AbortController().signal, 'test-model', undefined, [], 'Test system prompt.', { visualTask: true })
      expect(stream).toHaveBeenCalledOnce()
      for (const message of [request, ...rejected]) expect(prepared.messages).toContainEqual(message)
      expect(JSON.stringify(prepared.messages)).not.toContain(invalidSummary)
      const events = await store.events(session.summary.id)
      expect(events.some((event) => event.type === 'context.compacted')).toBe(false)
      expect(events.find((event) => event.type === 'context.compaction.failed')?.data.message).toContain('execution-shaped')
      expect(events.filter((event) => event.type === 'usage.updated')).toHaveLength(1)
    } finally {
      await agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('actually compacts oversized old reasoning without restarting the current visual check chain', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-visual-checkpoint-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const history = Array.from({ length: 12 }, (_, i) => {
      const group = step(`old-${i}`, 'list_files', {}, '{"status":"success","files":[]}')
      group[0].reasoning_content = `old reasoning ${i} `.repeat(3_000)
      return group
    }).flat()
    const compactionRequests: ModelMessage[][] = []
    const stream = vi.fn(async (options: { messages: ModelMessage[]; thinking?: string; toolChoice?: string; maxOutputTokens?: number }) => {
      compactionRequests.push(options.messages)
      return {
        content: 'Earlier file discovery is complete; retained tool records remain authoritative.',
        reasoningContent: '', toolCalls: [], finishReason: 'stop',
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedPromptTokens: 0 },
        modelCallCount: 1,
      }
    })
    const agent = new AgentService(store, {
      client: { stream } as never, contextCompactionThresholdTokens: 12_000, contextWindowTokens: 200_000,
    })
    try {
      const earlierSummary = 'Earlier summary claimed that visual inspection had not yet happened.'
      const messages: ModelMessage[] = [{
        role: 'user', content: `${projectArenaCompactionCheckpoint(earlierSummary)}\n\n${COMPACTION_CONTINUATION_CONTEXT}`,
        arena_system_messages: [{ kind: 'compaction', position: 'leading' }],
      }, request, ...history, ...workflow.slice(1)]
      const before = visualWebArtifactCompletionGap(messages)
      const prepared = await agent['prepareContext'](
        session.summary.id, 'turn_test', 'step_test', messages,
        new AbortController().signal, 'test-model', undefined, [], 'Test system prompt.',
        { canonicalPath: 'deck.html' },
      )
      expect(prepared.changed).toBe(true)
      expect(stream).toHaveBeenCalledOnce()
      const { thinking, toolChoice, maxOutputTokens } = stream.mock.calls[0][0]
      expect({ thinking, toolChoice, maxOutputTokens }).toEqual({ thinking: 'disabled', toolChoice: 'none', maxOutputTokens: 1800 })
      const records = JSON.parse(String(compactionRequests[0][1].content).split('records:\n')[1])
      expect(records[0]).toMatchObject({ content: null,
        historical_model_checkpoint: { scope: 'earlier_history_only', content: earlierSummary },
        historical_harness_continuation: COMPACTION_CONTINUATION_CONTEXT,
      })
      expect(JSON.stringify(compactionRequests[0])).not.toContain('old reasoning')
      expect(history.some((message) => message.reasoning_content?.includes('old reasoning'))).toBe(true)
      const index = JSON.parse(String(compactionRequests[0][2]?.content))
      expect(index).toMatchObject({ kind: 'retained_records_index', scope: 'not_summarized' })
      expect(index.tools).toContainEqual({ name: 'inspect_image', resultCount: 1,
        executionStatusCounts: { succeeded: 1, failed: 0, unknown: 0 }, latestExecutionStatus: 'succeeded' })
      expect(compactionRequests[0][0].content).toContain('Absence from the summary input is not evidence of unfinished work')
      expect(String(prepared.messages.find((message) => message.arena_system_messages?.length)?.content))
        .toContain('Retained tool records take precedence over this earlier-history summary')
      expect(prepared.messages.some((message) => arenaUserAuthoredText(message) === request.content)).toBe(true)
      expect(visualWebArtifactCompletionGap(prepared.messages)).toEqual(before)
      for (const original of workflow.filter((message) => message.role !== 'user')) {
        expect(prepared.messages).toContainEqual(original)
      }
      expect(JSON.stringify(prepared.messages)).not.toContain('old reasoning')
      const event = (await store.events(session.summary.id)).find((entry) => entry.type === 'context.compacted')
      expect(Number(event?.data.retainedVisualEvidenceGroupCount)).toBeGreaterThan(0)
    } finally {
      await agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })
})
