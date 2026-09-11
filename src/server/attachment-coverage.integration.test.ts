import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentService, officePresentVerificationGap, pdfPresentVerificationGap } from './agent-service.js'
import { ATTACHMENT_VERIFIER } from './file-evidence.js'
import { SessionStore } from './session-store.js'

describe('coverage-driven document presentation in the actual agent loop', () => {
  it('keeps semantic obligations mandatory even when byte coverage is complete', () => {
    expect(pdfPresentVerificationGap([{ role: 'user', content: 'Create report.pdf. Page 1 must contain "Required heading".' }],
      'report.pdf', { currentByteEvidence: true, verifiedExtraction: '--- PDF page 1 of 1 ---\nUnrelated content' }))
      .toContain('missing explicitly requested visible text')
    expect(officePresentVerificationGap([{ role: 'user', content: 'Create report.docx with Title/Heading 1 styles.' }],
      'report.docx', { verifiedExtraction: 'Document structure: paragraphs=2 | Title=0 | Heading 1=1 | numbered=0 | explicit page breaks=0 | page-break-before=0 | tables=0' }))
      .toContain('Title=0')
  })

  it.each([
    { extension: 'pdf', unit: 'page', request: 'Create report.pdf. Page 1 must contain "Opening". Page 2 must contain "Closing". Present it.',
      first: '--- PDF page 1 of 2 ---\nOpening', last: '--- PDF page 2 of 2 ---\nClosing' },
    { extension: 'docx', unit: 'item', request: 'Create report.docx with real Title/Heading 1 styles and a dynamic PAGE field. Present it.',
      first: 'Document structure: paragraphs=2 | Title=1 | Heading 1=1 | numbered=0 | explicit page breaks=0 | page-break-before=0 | tables=0',
      last: '--- DOCX footer ---\nWord fields: PAGE' },
  ])('blocks EOF-only $extension evidence, then reuses earlier/later verified excerpts without rereading them', async ({ extension, unit, request, first, last }) => {
    const root = await mkdtemp(join(tmpdir(), 'anera-coverage-loop-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const path = `report.${extension}`
    // Fake parser results deliberately exercise controller coverage/semantics,
    // not document rendering. The byte identity oracle reads a real file.
    await writeFile(join(store.workspaceDir(session.summary.id), path), 'identity')
    const startKey = `${unit}_start`
    const endKey = `${unit}_end`
    const actions = [
      ['extract_attachment', { path, [startKey]: 2, [endKey]: 2 }], ['present_file', { path }],
      ['extract_attachment', { path, [startKey]: 1, [endKey]: 1 }], ['present_file', { path }],
    ] as const
    let requestCount = 0
    const stream = vi.fn(async () => {
      const action = actions[requestCount++]
      if (!action) throw new Error('fixture stop after second presentation decision')
      return { content: '', reasoningContent: '', finishReason: 'tool_calls', toolCalls: [{ id: `call-${requestCount}`, type: 'function',
        function: { name: action[0], arguments: JSON.stringify(action[1]) } }],
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 0 } }
    })
    const execute = vi.fn(async (call: { name: string; arguments: Record<string, unknown> }) => {
      if (call.name !== 'extract_attachment') return { isError: false, content: JSON.stringify({ status: 'success', path }) }
      const index = Number(call.arguments[startKey]) - 1
      return { isError: false, content: index === 0 ? first : last, fileEvidence: {
        version: 1, path, verifier: ATTACHMENT_VERIFIER, sha256: createHash('sha256').update('identity').digest('hex'), bytes: 8,
        coverage: { unit, totalUnits: 2, from: [index, 0], to: [index + 1, 0] },
      } }
    })
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never, runTimeoutMs: 5_000 })
    try {
      await agent.submit(session.summary.id, { content: request })
      await vi.waitFor(() => expect(agent.isRunning(session.summary.id)).toBe(false), { timeout: 5_000, interval: 10 })
      expect(requestCount).toBe(5)
      expect(execute.mock.calls.filter(([call]) => call.name === 'extract_attachment')).toHaveLength(2)
      expect(execute.mock.calls.filter(([call]) => call.name === 'present_file')).toHaveLength(1)
      const gates = (await store.events(session.summary.id)).filter((event) => event.data.reason === 'delivery_verification_required')
      expect(gates).toHaveLength(1)
      expect(JSON.parse(String(gates[0].data.result)).message).toContain(`${startKey}=1 and content_offset=0`)
      expect(gates[0].data.notExecuted).toBe(true)
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  })
})
