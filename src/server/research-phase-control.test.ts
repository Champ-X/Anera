import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage, ToolDefinition } from '../shared/types.js'
import { AgentService, trustedResearchCalendarControl } from './agent-service.js'
import { createResearchBrief } from './research-brief.js'
import { SessionStore } from './session-store.js'

describe('research phase control', () => {
  it.each([
    ['2026-09-08T02:00:00Z', 'Asia/Shanghai', '2026-09-02', '2026-09-08'],
    ['2026-01-01T17:00:00Z', 'Asia/Shanghai', '2025-12-27', '2026-01-02'],
    ['2024-03-01T00:00:00Z', 'UTC', '2024-02-24', '2024-03-01'],
    ['2024-03-10T10:30:00Z', 'America/Los_Angeles', '2024-03-04', '2024-03-10'],
  ])('separates trailing seven local dates from a calendar week: %s in %s', (instant, timezone, start, end) => {
    const control = trustedResearchCalendarControl(new Date(instant), timezone)
    expect(control).toContain(`“最近一周”/“过去七天”/“past seven days” means ${start} through ${end}, inclusive`)
    expect(control).toContain('Do not replace a trailing-seven-day request with the Monday–Sunday week')
    expect(control).toContain('An explicit user-requested historical or future reporting window remains the task scope')
    expect(control).toContain('future-dated coverage does not prove an event has already happened')
  })

  it('keeps research focused on article review, then restores downstream presentation instructions', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-research-phase-control-'))
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const url = 'https://reporting.example/article'
    const content = 'The interview lasted 107 minutes, according to the reporter present at the event.'
    const input = {
      scope: 'Entertainment reporting in the requested period', limitations: ['Limited to this accessible report.'],
      items: [{ title: 'Interview report', summary: 'The interview lasted 107 minutes.', date_note: 'Within the requested period.',
        sources: [{ url, role: 'reporting', quality_note: 'A specific attributed report.', excerpt: content }] }],
    }
    const brief = createResearchBrief(input, [{ url, requestedUrl: url, title: 'Interview report', content,
      sha256: createHash('sha256').update(content).digest('hex') }])
    const requests: Array<{ messages: ModelMessage[]; tools: ToolDefinition[]; requireToolCall?: boolean }> = []
    const stream = vi.fn(async (options: { messages: ModelMessage[]; tools: ToolDefinition[]; requireToolCall?: boolean }) => {
      requests.push(structuredClone({ messages: options.messages, tools: options.tools, requireToolCall: options.requireToolCall }))
      if (requests.length === 3) throw new Error('fixture stop after the accepted research boundary')
      const name = requests.length === 1 ? 'fetch_page' : 'record_research_brief'
      return { content: '', reasoningContent: `Original reasoning for ${name}.`,
        toolCalls: [{ id: `call-${requests.length}`, type: 'function' as const, function: {
          name, arguments: JSON.stringify(name === 'fetch_page' ? { url } : input),
        } }], finishReason: 'tool_calls' as const, modelCallCount: 1,
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedPromptTokens: 0 } }
    })
    const execute = vi.fn(async (call: { name: string }) => ({ isError: false,
      content: JSON.stringify(call.name === 'fetch_page' ? { status: 'success', url, content } : { status: 'success', brief }),
    }))
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute } as never, runTimeoutMs: 5_000 })
    try {
      await agent.submit(session.summary.id, { content: '看看最近一周娱乐新闻，制作中文 HTML Slides。', timezone: 'Asia/Shanghai' })
      for (let attempt = 0; attempt < 500 && agent.isRunning(session.summary.id); attempt += 1) {
        await new Promise((done) => setTimeout(done, 5))
      }
      expect(agent.isRunning(session.summary.id)).toBe(false)
      expect(requests).toHaveLength(3)
      for (const request of requests.slice(0, 2)) {
        expect(request.requireToolCall).toBe(true)
        const tail = String(request.messages.at(-1)?.content)
        expect(tail).toContain('Harness research phase only')
        expect(tail).toContain('The complete requested presentation and its reference-fidelity checks remain required after research')
        expect(tail).not.toContain('Include accessible next/previous and keyboard navigation')
        expect(tail).not.toContain('Build the complete HTML directly')
        expect(tail).not.toContain('Harness visual HTML presentation contract')
        expect(request.tools.map((tool) => tool.function.name)).not.toContain('compose_reference_html')
      }
      expect(String(requests[2].messages.at(-1)?.content)).toContain('Harness visual HTML presentation contract')
      expect(requests[2].requireToolCall).toBe(true)
      expect(String(requests[2].messages.at(-1)?.content)).toContain('Include accessible next/previous and keyboard navigation')
      expect(String(requests[2].messages.at(-1)?.content)).toContain('A contents/index/TOC is a navigation summary')
      expect(requests[2].messages).toContainEqual(expect.objectContaining({ reasoning_content: 'Original reasoning for record_research_brief.' }))
      expect(execute).toHaveBeenCalledTimes(2)
    } finally {
      await agent.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })
})
