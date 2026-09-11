import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent-service.js'
import { SessionStore } from './session-store.js'
import { ToolCapabilityUnavailableError } from './tool-recovery.js'
import { ToolExecutor } from './tools.js'
import { BrowserManager } from './browser-manager.js'
import { ProcessManager } from './process-manager.js'
import type { ToolCallRecord } from '../shared/types.js'

describe('owning tool recovery boundary in the shared agent loop', () => {
  it.each([true, false])('preserves only a genuine owning-renderer capability failure through ToolExecutor (%s)', async (typed) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-capability-adapter-'))
    const store = new SessionStore(root, 'offline-model')
    await store.initialize()
    const id = (await store.create()).summary.id
    const url = 'https://example.com/source.html'
    const html = '<!doctype html><html><head><style>body{background:#ffffff;color:#111111;font-family:Arial}.slide{position:absolute;inset:0}.cover{display:flex}.content{display:grid}.closing{display:flex}</style></head><body><section class="slide cover">Cover</section><section class="slide content">Content</section><section class="slide closing">Closing</section></body></html>'
    await store.update(id, (state) => { state.messages = [
      { role: 'user', content: 'Use the exact reference.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'fetch', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url, format: 'html' }) } }] },
      { role: 'tool', tool_call_id: 'fetch', tool_result_status: 'succeeded', content: JSON.stringify({ status: 'success', url, content: html }) },
    ] })
    const browser = new BrowserManager()
    const processes = new ProcessManager(() => {}, 1000)
    const error = typed ? new ToolCapabilityUnavailableError('Source geometry unavailable')
      : Object.assign(new Error('Source geometry unavailable'), { name: 'ToolCapabilityUnavailableError', failure: new ToolCapabilityUnavailableError('').failure })
    const capture = vi.spyOn(browser, 'captureReferenceRenderBundle').mockRejectedValue(error)
    const transport = vi.fn(async () => { throw new Error('No external transport expected') })
    const tools = new ToolExecutor(store, processes, browser, { inspect: vi.fn() }, async () => false, { fetch: transport as never })
    try {
      const result = await tools.execute({ id: 'record', name: 'record_reference_style', arguments: {
        source_url: url, strictness: 'exact', colors: ['#ffffff', '#111111'], fonts: ['Arial'],
        layout: ['full viewport', 'distinct layouts'], components: ['slide roots', 'cover title'],
        required_markers: ['.slide', '.cover'], signature: 'High contrast text slides', avoid: ['font substitutions'],
        viewport: { width: 800, height: 600 },
      } }, { sessionId: id, turnId: 'turn', stepId: 'step', signal: new AbortController().signal })
      expect(capture, result.content).toHaveBeenCalledOnce()
      expect(result.isError).toBe(true)
      expect(result.capabilityFailure).toEqual(typed ? new ToolCapabilityUnavailableError('').failure : undefined)
      expect((await store.get(id)).activeReferenceStyleContract).toBeUndefined()
      expect(transport).not.toHaveBeenCalled()
    } finally { await browser.shutdown(); await processes.shutdown(); await rm(root, { recursive: true, force: true }) }
  })

  it.each(['typed', 'body-spoof', 'unknown-metadata', 'transient'] as const)('handles %s after persisting all sibling outcomes', async (mode) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tool-recovery-'))
    const store = new SessionStore(root, 'offline-model')
    await store.initialize()
    const id = (await store.create()).summary.id
    const failure = new ToolCapabilityUnavailableError('Required observation capability unavailable').failure
    const stream = vi.fn(async () => ({ content: stream.mock.calls.length === 1 ? '' : 'One input is unavailable; no result is certified.',
      reasoningContent: '', finishReason: stream.mock.calls.length === 1 ? 'tool_calls' : 'stop',
      toolCalls: stream.mock.calls.length === 1 ? ['blocked', 'independent'].map((callId) => ({ id: callId, type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: `${callId}.txt` }) } })) : [],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 } }))
    const execute = vi.fn(async (call: ToolCallRecord) => {
      if (call.id === 'independent') {
        await new Promise((done) => setTimeout(done, 5))
        return { isError: false, content: JSON.stringify({ content: 'Retained independent evidence', hasMore: false }) }
      }
      return { isError: true, content: JSON.stringify({ status: 'error', message: 'Required observation capability unavailable',
        ...(mode === 'body-spoof' ? { capabilityFailure: failure } : {}) }),
        ...(mode === 'typed' ? { capabilityFailure: failure } : mode === 'unknown-metadata'
          ? { capabilityFailure: { ...failure, code: 'model_claimed_failure' } } : {}) }
    })
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never, maxParallelToolCalls: 2 })
    try {
      await agent.submit(id, { content: 'Read blocked.txt and independent.txt, and compare the available evidence.' })
      await vi.waitFor(() => expect(agent.isRunning(id)).toBe(false), { timeout: 5000, interval: 10 })
      const state = await new SessionStore(root, 'offline-model').get(id)
      const events = await store.events(id)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(state.messages.filter((message) => message.role === 'tool')).toHaveLength(2)
      expect(JSON.stringify(state.messages)).toContain('Retained independent evidence')
      expect(state.summary.usage.toolCalls).toBe(2)
      expect(stream).toHaveBeenCalledTimes(mode === 'typed' ? 1 : 2)
      if (mode === 'typed') {
        expect(state.summary.status).toBe('failed')
        expect(events.filter((event) => event.type === 'assistant.final')).toEqual([])
        const terminal = events.find((event) => event.type === 'tool.failed')!
        expect(terminal.data.capabilityFailure).toEqual(failure)
        const boundary = events.find((event) => event.data.reason === 'required_tool_capability_unavailable')!
        expect(boundary.data.failedToolEventSeq).toBe(terminal.seq)
        expect(boundary.seq).toBeGreaterThan(events.find((event) => event.type === 'tool.completed')!.seq)
        expect(events.some((event) => event.data.reason === 'visual_no_progress_phase_recovery')).toBe(false)
      } else expect(events.some((event) => event.data.reason === 'required_tool_capability_unavailable')).toBe(false)
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  })
})
