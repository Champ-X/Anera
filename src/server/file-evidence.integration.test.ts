import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import { AgentService } from './agent-service.js'
import { BrowserManager } from './browser-manager.js'
import { ATTACHMENT_VERIFIER, attachmentEvidenceStatus } from './file-evidence.js'
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
    const agent = new AgentService(store, { verificationMode: 'legacy', // Historical fixed-phase replay; product defaults to adaptive.
      client: { stream } as never, tools: { execute } as never, runTimeoutMs: 5_000 })
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

  it('presents changed bytes in adaptive mode without turning stale extraction into a passing check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anera-adaptive-file-presentation-'))
    const store = new SessionStore(root, 'offline-model')
    await store.initialize()
    const id = (await store.create()).summary.id
    const original = 'name,value\nA,1\n'
    const current = 'name,value\nA,2\n'
    await writeFile(join(store.workspaceDir(id), 'records.csv'), original)
    const processes = new ProcessManager(() => {}, 10_000)
    const browser = new BrowserManager()
    const tools = new ToolExecutor(store, processes, browser, { inspect: vi.fn() }, async () => false, { verificationMode: 'adaptive' })
    const calls = [
      { id: 'extract_original', name: 'extract_attachment', args: { path: 'records.csv' } },
      { id: 'write_current', name: 'write_file', args: { path: 'records.csv', content: current } },
      { id: 'present_current', name: 'present_file', args: { path: 'records.csv' } },
      { id: 'finish_limited', name: 'finish_task', args: {
        summary: 'The updated file is available; its updated values have not been independently verified.', outcome: 'limited',
        checks: [{ requirement: 'Independently verify the updated values', method: 'Only the earlier revision was extracted.',
          required: true, status: 'unverified', evidence: { callIds: ['extract_original'], paths: ['records.csv'] },
          note: 'The file changed after extraction.' }],
      } },
    ]
    let index = 0
    const stream = vi.fn(async (options: { beforeRequest?: () => Promise<void> }) => {
      await options.beforeRequest?.()
      if (index === 3) {
        const events = await store.events(id)
        expect(events.filter((event) => event.type === 'file.presented')).toHaveLength(1)
        expect(events.filter((event) => event.type === 'task.verification.completed')).toHaveLength(0)
      }
      const call = calls[index++]
      if (!call) throw new Error('Unexpected request after limited completion')
      return { content: '', reasoningContent: '', finishReason: 'tool_calls', toolCalls: [{ id: call.id, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) } }],
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cachedPromptTokens: 0 } }
    })
    const agent = new AgentService(store, { verificationMode: 'adaptive', client: { stream } as never, tools, runTimeoutMs: 5_000 })
    try {
      await agent.submit(id, { content: 'Update records.csv to value 2, present it, and report whether the updated values were independently verified.' })
      await vi.waitFor(() => expect(agent.isRunning(id)).toBe(false), { timeout: 5_000, interval: 10 })
      expect(stream).toHaveBeenCalledTimes(4)
      expect((await store.get(id)).summary.status).toBe('completed')
      const events = await store.events(id)
      expect(events.find((event) => event.type === 'tool.completed' && event.callId === 'present_current')?.data.isError).toBe(false)
      expect(events.find((event) => event.type === 'file.presented')?.data).toMatchObject({
        path: 'records.csv', artifactHash: createHash('sha256').update(current).digest('base64url'), bytes: Buffer.byteLength(current),
      })
      const records = events.filter((event) => event.type === 'task.verification.completed')
      expect(records).toHaveLength(1)
      expect(records[0].data).toMatchObject({ outcome: 'limited', checks: [{ status: 'unverified' }],
        fileEvidence: [{ path: 'records.csv', sha256: createHash('sha256').update(current).digest('hex') }] })
      expect(attachmentEvidenceStatus(events, 'records.csv', createHash('sha256').update(current).digest('hex'), Buffer.byteLength(current)).status).toBe('invalid')
    } finally { await agent.shutdown(); await processes.stopEverything(); await rm(root, { recursive: true, force: true }) }
  })

  it.each(['success', 'failure'] as const)('does not reuse pre-restore %s evidence in a reloaded legacy executor', async (previous) => {
    const root = await mkdtemp(join(tmpdir(), 'anera-restored-file-presentation-'))
    const store = new SessionStore(root, 'offline-model')
    await store.initialize()
    const id = (await store.create()).summary.id
    const source = join(store.workspaceDir(id), 'records.csv')
    const content = 'name,value\nA,1\n'
    const processes = new ProcessManager(() => {}, 10_000)
    const browser = new BrowserManager()
    const makeTools = (current: SessionStore) => new ToolExecutor(current, processes, browser, { inspect: vi.fn() }, async () => false)
    const context = { sessionId: id, turnId: 'turn', stepId: 'step', signal: new AbortController().signal }
    const extract = { id: 'extract', name: 'extract_attachment', arguments: { path: 'records.csv' } }
    const present = { id: 'present', name: 'present_file', arguments: { path: 'records.csv' } }
    try {
      const tools = makeTools(store)
      if (previous === 'success') await writeFile(source, content)
      const parsed = await tools.execute(extract, context)
      expect(parsed.isError).toBe(previous === 'failure')
      await store.append(id, parsed.isError ? 'tool.failed' : 'tool.completed', {
        call: extract, result: parsed.content, isError: parsed.isError, fileEvidence: parsed.fileEvidence,
      }, context)
      await writeFile(source, content)
      expect(attachmentEvidenceStatus(await store.events(id), 'records.csv', createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)).status)
        .toBe(previous === 'success' ? 'current' : 'invalid')
      await store.append(id, 'workspace.version.restored', { restoreId: 'wsr_aaaaaaaaaaaaaaaaaaaa' }, context)
      const reloaded = new SessionStore(root, 'offline-model')
      await reloaded.initialize()
      expect(attachmentEvidenceStatus(await reloaded.events(id), 'records.csv', createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)))
        .toEqual({ status: 'unobserved' })
      expect((await makeTools(reloaded).execute(present, context)).isError).toBe(false)
      expect((await reloaded.events(id)).filter((event) => event.type === 'file.presented')).toHaveLength(1)
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
