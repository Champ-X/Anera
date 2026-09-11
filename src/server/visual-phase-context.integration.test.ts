import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import { AgentService, visualArtifactDefectRepairPhase } from './agent-service.js'
import { SessionStore } from './session-store.js'
import type { ToolDefinition } from './tools.js'

describe('phase-local context in the real agent request builder', () => {
  it('narrows a prescribed diagnostic read but restores the full contract for Vision and editing', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-phase-read-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const html = '<!doctype html><html><body><section class="slide active"><h1>Workflow</h1></section><section class="slide"><h1>Steps</h1></section></body></html>'
    const requests: Array<{ messages: ModelMessage[]; tools: ToolDefinition[] }> = []
    const actions = [
      ['write_file', { path: 'deck.html', content: html }],
      ['start_process', { command: 'python3 -m http.server 8000', port: 8000 }],
      ['browser', { action: 'open', path: 'deck.html' }],
      ['browser', { action: 'press', key: 'ArrowRight' }],
      ['browser', { action: 'screenshot', screenshot_path: 'deck.png' }],
      ['inspect_image', { path: 'deck.png', prompt: 'Check for layout defects. Reply NO DEFECTS only when there are none.' }],
      ['read_file', { path: 'deck.html' }],
    ] as const
    const stream = vi.fn(async (options: { messages: ModelMessage[]; tools: ToolDefinition[]; providerTools?: ToolDefinition[] }) => {
      expect(options.providerTools).toEqual(options.tools)
      requests.push(structuredClone({ messages: options.messages, tools: options.tools }))
      const action = actions[requests.length - 1]
      if (!action) throw new Error('fixture stop before edit')
      return { content: '', reasoningContent: `Exact phase reasoning ${requests.length}.`, finishReason: 'tool_calls' as const,
        toolCalls: [{ id: `phase-${requests.length}`, type: 'function' as const,
          function: { name: action[0], arguments: JSON.stringify(action[1]) } }], modelCallCount: 1,
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedPromptTokens: 0 } }
    })
    const execute = vi.fn(async (call: { name: string; arguments: Record<string, unknown> }) => {
      if (call.name === 'write_file') await writeFile(resolve(store.workspaceDir(session.summary.id), 'deck.html'), html)
      if (call.name === 'start_process') await store.update(session.summary.id, (state) => {
        state.website = { status: 'running', entryPath: 'deck.html', processId: 'fixture-preview', port: 8000,
          previewUrl: 'http://127.0.0.1:8000/deck.html', updatedAt: new Date().toISOString(), restartCount: 0 }
      })
      if (call.name === 'browser' && call.arguments.action === 'screenshot') {
        await store.update(session.summary.id, (state) => {
          state.artifacts.push({ id: 'fixture-shot', sessionId: session.summary.id, path: 'deck.png', name: 'deck.png',
            kind: 'image', mime: 'image/png', createdAt: new Date().toISOString(), downloadUrl: '/fixture/shot.png' })
        })
        return { isError: false, content: 'Saved browser screenshot to deck.png (123 bytes).' }
      }
      if (call.name === 'inspect_image') return { isError: false, content: 'Visual inspection:\nDEFECT: The heading overlaps the navigation. Repair the overlap.' }
      if (call.name === 'read_file') return { isError: false, content: html }
      if (call.name === 'browser') return { isError: false, content: JSON.stringify({ url: 'http://127.0.0.1:8000/deck.html',
        text: call.arguments.action === 'press' ? 'Steps 2/2' : 'Workflow 1/2' }) }
      return { isError: false, content: JSON.stringify({ status: 'success', path: 'deck.html', url: 'http://127.0.0.1:8000/deck.html' }) }
    })
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never, runTimeoutMs: 5_000 })
    try {
      await agent.submit(session.summary.id, { content: '制作一个中文 HTML Slides，主题是日常工作流程。' })
      for (let attempt = 0; attempt < 600 && agent.isRunning(session.summary.id); attempt += 1) await new Promise((done) => setTimeout(done, 5))
      expect(agent.isRunning(session.summary.id)).toBe(false)
      expect(requests).toHaveLength(8)
      for (const index of [5, 7]) {
        expect(String(requests[index].messages.at(-1)?.content)).toContain('Harness visual HTML presentation contract')
        expect(String(requests[index].messages.at(-1)?.content)).not.toContain('Harness verification execution only')
      }
      expect(visualArtifactDefectRepairPhase(requests[6].messages, 'deck.html'), JSON.stringify(requests[6].messages.filter((message) => message.role === 'tool' || message.tool_calls))).toBe('read')
      expect(requests[6].tools.map((tool) => tool.function.name)).toEqual(['read_file'])
      expect(String(requests[6].messages.at(-1)?.content)).toContain('Harness verification execution only')
      expect(String(requests[6].messages.at(-1)?.content)).not.toContain('Harness visual HTML presentation contract')
      expect(requests[7].tools.map((tool) => tool.function.name)).toEqual(['edit_file'])
      expect(requests[7].messages).toContainEqual(expect.objectContaining({ reasoning_content: 'Exact phase reasoning 6.' }))
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  })

  it('defers design instructions only after authoring, keeps exact history, and stops before a real preview', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-phase-context-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const html = `<!doctype html><html><head><title>Workflow</title></head><body>${Array.from({ length: 6 }, (_, i) => `<section class="slide"><h1>Step ${i + 1}</h1><p>Workflow notes</p></section>`).join('')}</body></html>`
    const requests: Array<{ messages: ModelMessage[]; tools: ToolDefinition[] }> = []
    const stream = vi.fn(async (options: { messages: ModelMessage[]; tools: ToolDefinition[]; providerTools?: ToolDefinition[] }) => {
      expect(options.providerTools).toEqual(options.tools)
      requests.push(structuredClone({ messages: options.messages, tools: options.tools }))
      if (requests.length > 1) throw new Error('fixture stop before preview dispatch')
      return { content: '', reasoningContent: 'Exact original authoring reasoning.', finishReason: 'tool_calls' as const,
        toolCalls: [{ id: 'write-deck', type: 'function' as const,
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'deck.html', content: html }) } }],
        modelCallCount: 1, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedPromptTokens: 0 } }
    })
    const execute = vi.fn(async (call: { name: string }) => {
      expect(call.name).toBe('write_file')
      await writeFile(resolve(store.workspaceDir(session.summary.id), 'deck.html'), html)
      return { isError: false, content: JSON.stringify({ status: 'success', path: 'deck.html' }) }
    })
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never, runTimeoutMs: 5_000 })
    try {
      await agent.submit(session.summary.id, { content: '制作一个中文 HTML Slides，主题是日常工作流程。' })
      for (let attempt = 0; attempt < 500 && agent.isRunning(session.summary.id); attempt += 1) {
        await new Promise((done) => setTimeout(done, 5))
      }
      expect(agent.isRunning(session.summary.id)).toBe(false)
      expect(requests).toHaveLength(2)
      expect(String(requests[0].messages.at(-1)?.content)).toContain('Harness visual HTML presentation contract')
      expect(requests[1].tools.map((tool) => tool.function.name)).toEqual(['start_process'])
      const control = String(requests[1].messages.at(-1)?.content)
      expect(control).toContain('Harness verification execution only')
      expect(control).toContain('start one managed Website preview for the canonical HTML')
      expect(control).not.toContain('Harness visual HTML presentation contract')
      expect(control).not.toContain('A contents/index/TOC is a navigation summary')
      expect(requests[1].messages).toContainEqual(expect.objectContaining({ reasoning_content: 'Exact original authoring reasoning.' }))
      expect(execute).toHaveBeenCalledOnce()
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  })
})
