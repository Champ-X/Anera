import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import { AgentService } from './agent-service.js'
import { SessionStore } from './session-store.js'

describe('domain context selection in the actual Agent request', () => {
  it.each([
    ['Install the pinned npm dependency vite@5.4.19 and run the build.', undefined],
    ['Create and present budget.xlsx.', 'XLSX API guidance'],
    ['Create and present brief.pdf.', 'PDF API guidance'],
  ])('does not inject unrelated artifact recipes for %s', async (request, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'anera-domain-context-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    let messages: ModelMessage[] = []
    const stream = vi.fn(async (options: { messages: ModelMessage[] }) => {
      messages = options.messages
      throw new Error('fixture stop after first request construction')
    })
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute: vi.fn() } as never, runTimeoutMs: 5_000 })
    try {
      await agent.submit(session.summary.id, { content: request! })
      await vi.waitFor(() => expect(agent.isRunning(session.summary.id)).toBe(false), { timeout: 5_000, interval: 10 })
      const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
      expect(system).toContain('Lifecycle scripts, audit, and funding calls are disabled')
      for (const label of ['PDF API guidance', 'DOCX API guidance', 'XLSX API guidance', 'PPTX API guidance']) {
        expect(system.includes(label)).toBe(label === expected)
      }
      expect(system).not.toContain('at most three generator executions')
      expect(system).not.toContain('For Letter width 612 and SAFE 48')
    } finally { await agent.shutdown(); await rm(root, { recursive: true, force: true }) }
  })
})
