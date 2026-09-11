import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import { AgentService } from './agent-service.js'
import { BrowserManager } from './browser-manager.js'
import { ATTACHMENT_VERIFIER } from './file-evidence.js'
import { ProcessManager } from './process-manager.js'
import { SessionStore } from './session-store.js'
import { ToolExecutor } from './tools.js'

describe('file evidence across actual execution, persistence and presentation', () => {
  it.each([false, true])('uses byte identity rather than Bash occurrence at the PDF adapter (changed=%s)', async (changed) => {
    const root = await mkdtemp(join(tmpdir(), 'anera-pdf-evidence-adapter-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const path = join(store.workspaceDir(session.summary.id), 'report.pdf')
    const privateValue = 'private-evidence-sentinel-12345'
    store.registerSensitiveValues(session.summary.id, [privateValue])
    // The parser is fake in this boundary test; actual snapshot/execution is
    // covered below. These are identity bytes, not a purported valid PDF.
    await writeFile(path, 'original')
    let requests = 0
    const calls = [
      ['extract_attachment', { path: 'report.pdf' }],
      ['bash', { command: 'inspect other state' }],
      ['present_file', { path: 'report.pdf' }],
    ] as const
    const decisionContexts: string[] = []
    const stream = vi.fn(async (options: { messages: ModelMessage[] }) => {
      decisionContexts.push(options.messages.map((message) => String(message.content)).join('\n'))
      const call = calls[requests++]
      if (!call) throw new Error('fixture stop after presentation decision')
      return { content: '', reasoningContent: '', finishReason: 'tool_calls', toolCalls: [{ id: `call-${requests}`, type: 'function',
        function: { name: call[0], arguments: JSON.stringify(call[1]) } }],
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 } }
    })
    const execute = vi.fn(async (call: { name: string }) => {
      if (call.name === 'extract_attachment') return { isError: false, content: `--- PDF page 1 of 1 ---\nContent ${privateValue}`,
        fileEvidence: { version: 1, path: 'report.pdf', verifier: ATTACHMENT_VERIFIER, bytes: 8,
          coverage: { unit: 'page', totalUnits: 1, from: [0, 0], to: [1, 0] },
          sha256: createHash('sha256').update('original').digest('hex') } }
      if (call.name === 'bash' && changed) await writeFile(path, 'modified')
      return { isError: false, content: JSON.stringify({ status: 'success', path: 'report.pdf' }) }
    })
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never, runTimeoutMs: 5_000 })
    try {
      await agent.submit(session.summary.id, { content: 'Create and present report.pdf.' })
      await vi.waitFor(() => expect(agent.isRunning(session.summary.id)).toBe(false), { timeout: 5_000, interval: 10 })
      expect(execute.mock.calls.filter(([call]) => call.name === 'present_file')).toHaveLength(changed ? 0 : 1)
      // Evidence is now consumed at the next decision, before present_file
      // admission. It is request-local and never rewrites original tool output.
      expect(decisionContexts[0]).not.toContain('Harness verification state for this decision')
      expect(decisionContexts[1]).toContain('"freshness":"current_at_decision"')
      expect(decisionContexts[1]).toContain('"coverage":{"status":"complete"}')
      // The injected fake ToolExecutor returns its original raw fixture in
      // history. Assert the newly rebuilt journal projection specifically.
      const projectedEvidence = decisionContexts[1].split('Harness verification state for this decision')[1]
      expect(projectedEvidence).not.toContain(privateValue)
      expect(projectedEvidence).toContain('[REDACTED_SECRET]')
      expect(decisionContexts[2]).toContain(changed ? '"freshness":"invalid"' : '"freshness":"current_at_decision"')
      expect((await store.get(session.summary.id)).messages.some((message) => String(message.content).includes('Harness verification state for this decision'))).toBe(false)
      const events = await store.events(session.summary.id)
      const gate = events.find((event) => event.data.reason === 'delivery_verification_required')
      expect(Boolean(gate)).toBe(changed)
      if (changed) {
        expect(gate).toMatchObject({ type: 'tool.completed', data: { notExecuted: true } })
        expect(JSON.parse(String(gate?.data.result))).toMatchObject({ status: 'verification_required', not_executed: true })
      }
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  })

  it('blocks stale presentation before file.presented, survives store reload, and accepts refreshed evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anera-file-evidence-integration-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const processes = new ProcessManager(() => {}, 10_000)
    const browser = new BrowserManager()
    const makeTools = (current: SessionStore) => new ToolExecutor(current, processes, browser, { inspect: vi.fn() }, async () => false)
    const context = { sessionId: session.summary.id, turnId: 'turn', stepId: 'step', signal: new AbortController().signal }
    const source = join(store.workspaceDir(session.summary.id), 'records.csv')
    const extract = { id: 'extract', name: 'extract_attachment', arguments: { path: 'records.csv' } }
    const present = { id: 'present', name: 'present_file', arguments: { path: 'records.csv' } }
    try {
      const tools = makeTools(store)
      await writeFile(source, 'name,value\nA,1\n')
      const parsed = await tools.execute(extract, context)
      expect(parsed.isError).toBe(false)
      expect(parsed.content).toBe('name,value\nA,1\n')
      expect(parsed.fileEvidence).toMatchObject({ path: 'records.csv', verifier: ATTACHMENT_VERIFIER })
      await store.append(context.sessionId, 'tool.completed', { call: extract, result: parsed.content, fileEvidence: parsed.fileEvidence }, context)
      expect((await tools.execute(present, context)).isError).toBe(false)
      await writeFile(source, 'name,value\nA,2\n')
      const reloaded = new SessionStore(root, 'test-model')
      await reloaded.initialize()
      const reopenedTools = makeTools(reloaded)
      const blocked = await reopenedTools.execute(present, context)
      expect(blocked.isError).toBe(true)
      expect(blocked.content).toContain('different file revision')
      expect((await reloaded.events(context.sessionId)).filter((event) => event.type === 'file.presented')).toHaveLength(1)
      const refreshed = await reopenedTools.execute(extract, context)
      expect(refreshed.fileEvidence?.sha256).not.toBe(parsed.fileEvidence?.sha256)
      await reloaded.append(context.sessionId, 'tool.completed', { call: extract, result: refreshed.content, fileEvidence: refreshed.fileEvidence }, context)
      expect((await reopenedTools.execute(present, context)).isError).toBe(false)
      expect((await reloaded.events(context.sessionId)).filter((event) => event.type === 'file.presented')).toHaveLength(2)
    } finally { await processes.stopEverything(); await rm(root, { recursive: true, force: true }) }
  })

  it('persists private receipts in the actual AgentService terminal journal, not in model-visible tool output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anera-file-evidence-agent-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const receipt = { version: 1, path: 'source.pdf', verifier: ATTACHMENT_VERIFIER, bytes: 3,
      sha256: createHash('sha256').update('pdf').digest('hex') }
    let requests = 0
    const stream = vi.fn(async () => {
      if (++requests > 1) throw new Error('fixture stop after extraction')
      return { content: '', reasoningContent: '', toolCalls: [{ id: 'extract', type: 'function',
        function: { name: 'extract_attachment', arguments: '{"path":"source.pdf"}' } }], finishReason: 'tool_calls',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 } }
    })
    const execute = vi.fn(async () => ({ content: 'Parsed page one', isError: false, fileEvidence: receipt }))
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never, runTimeoutMs: 5_000 })
    try {
      await agent.submit(session.summary.id, { content: 'Read source.pdf with extract_attachment and summarize it.' })
      await vi.waitFor(() => expect(agent.isRunning(session.summary.id)).toBe(false), { timeout: 5_000, interval: 10 })
      expect(execute).toHaveBeenCalledOnce()
      expect((await store.events(session.summary.id)).find((event) => event.type === 'tool.completed')?.data.fileEvidence).toEqual(receipt)
      const message = (await store.get(session.summary.id)).messages.find((item) => item.role === 'tool')
      expect(message?.content).toBe('Parsed page one')
      expect(message).not.toHaveProperty('fileEvidence')
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  })
})
