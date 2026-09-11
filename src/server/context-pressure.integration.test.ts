import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import { AgentService, arenaUserAuthoredText, estimateProviderContextBytes, estimateProviderContextTokens } from './agent-service.js'
import { projectProviderMessages } from './deepseek.js'
import { SessionStore } from './session-store.js'
import type { ToolDefinition } from './tools.js'

const BYTE_LIMIT = 20_000
const SYSTEM = 'Continue the current task.'
const tool = (description = 'Read a file.'): ToolDefinition => ({
  type: 'function', function: { name: 'read_file', description, parameters: { type: 'object', properties: {} } },
})
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
function checkpointIdentity(messages: ModelMessage[]) {
  const serialized = JSON.stringify({ messages: projectProviderMessages(messages) })
  return { checkpointInputBasis: 'messages_json_v1', checkpointInputBytes: Buffer.byteLength(serialized),
    checkpointInputSha256: createHash('sha256').update(serialized).digest('hex'), checkpointInputEstimatedTokens: expect.any(Number) }
}

// Bounded machine-only evidence: large durable profiles, small provider
// attestations. No browser, network, production session or model required.
function referenceRecord(): ModelMessage[] {
  const evidenceSha256 = 'a'.repeat(64)
  const viewport = { width: 1440, height: 900 }
  const phase = (name: string) => ({
    anchors: Array.from({ length: 4 }, (_, index) => ({
      selector: index === 0 ? `.layout-${name}` : `.card-${index}`,
      count: 12, geometry: 'strict',
      rects: Array.from({ length: 12 }, () => ({ x: 0, y: 0, width: 1, height: 1 })),
      styles: Array.from({ length: 12 }, () => ({ display: 'block', position: 'relative', opacity: '1', color: '#111111' })),
      occlusion: Array.from({ length: 12 }, () => 1),
    })),
    overlayProbes: [],
  })
  return [
    { role: 'assistant', content: null, reasoning_content: 'Preserve this exact tool-paired reasoning.', tool_calls: [{
      id: 'reference', type: 'function', function: { name: 'record_reference_style', arguments: '{}' },
    }] },
    { role: 'tool', tool_call_id: 'reference', tool_result_status: 'succeeded', content: JSON.stringify({
      status: 'success',
      contract: {
        source_url: 'https://reference.example/template.html', strictness: 'exact',
        colors: ['#ffffff', '#111111'], fonts: ['Inter'], layout: ['full canvas', 'fixed grid'],
        components: ['headline', 'navigation'], required_markers: ['.layout-cover', '.nav-controls'],
        signature: 'Monochrome grid.', avoid: ['invented palette'], viewport,
      },
      provenance: { resolvedUrl: 'https://reference.example/template.html', evidenceSha256, evidenceBytes: 4096 },
      render_profile: { version: 1, evidenceSha256, viewport,
        phases: { cover: phase('cover'), content: phase('content'), closing: phase('closing') } },
    }) },
  ]
}

async function harness(summary = 'Earlier records were summarized; the retained records remain authoritative.') {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-context-pressure-'))
  const store = new SessionStore(root, 'test-model')
  await store.initialize()
  const session = await store.create()
  const stream = vi.fn(async (_options: { messages: ModelMessage[] }) => ({
    content: summary, reasoningContent: '', toolCalls: [], finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 0 },
    modelCallCount: 1,
  }))
  const agent = new AgentService(store, { client: { stream } as never,
    contextSerializationHardLimitBytes: BYTE_LIMIT,
    contextCompactionThresholdTokens: 100_000, contextWindowTokens: 200_000 })
  return {
    store, session, agent, stream,
    async close() { await agent.shutdown(); await rm(root, { recursive: true, force: true }) },
  }
}

describe('provider-context byte pressure', () => {
  it.each(['plain', 'tools', 'image'] as const)('counts exactly the projected context envelope: %s', (variant) => {
    const messages: ModelMessage[] = [{ role: 'user', content: '中文 🧭',
      arena_system_messages: [{ kind: 'compaction', position: 'leading' }] }]
    if (variant === 'image') messages.push({ role: 'tool', tool_call_id: 'image', content: 'Private image wrapper.',
      tool_result_status: 'succeeded', tool_content_parts: [{ type: 'image-data', mediaType: 'image/png', data: 'YWJj' }] })
    const tools = variant === 'tools' ? [tool()] : []
    const original = structuredClone(messages)
    const context = { messages: [{ role: 'system', content: SYSTEM }, ...projectProviderMessages(messages)],
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }
    expect(estimateProviderContextBytes(messages, tools, SYSTEM)).toBe(bytes(context))
    expect(estimateProviderContextTokens(messages, tools, SYSTEM)).toBeGreaterThan(0)
    expect(messages).toEqual(original)
  })

  it('does not buy a checkpoint for profiles already projected out of the request', async () => {
    const context = await harness()
    const records = referenceRecord()
    const messages: ModelMessage[] = [{ role: 'user', content: 'Keep the validated reference record.' },
      ...records, { role: 'user', content: 'Continue.' }]
    const original = structuredClone(messages)
    expect(bytes(messages)).toBeGreaterThan(BYTE_LIMIT)
    expect(estimateProviderContextBytes(messages, [], SYSTEM)).toBeLessThan(BYTE_LIMIT / 2)
    expect(JSON.parse(String(projectProviderMessages(records)[1].content))).toHaveProperty('render_profile_attestation')
    try {
      const prepared = await context.agent['prepareContext'](context.session.summary.id, 'turn_test', 'step_test', messages,
        new AbortController().signal, 'test-model', undefined, [], SYSTEM)
      expect(context.stream).not.toHaveBeenCalled()
      expect(prepared).toEqual({ changed: false, messages: original })
      expect(messages).toEqual(original)
      expect((await context.store.events(context.session.summary.id)).filter((event) => event.type.startsWith('context.'))).toEqual([])
    } finally { await context.close() }
  })

  it.each(['malformed', 'unpaired', 'unrelated'] as const)('still counts the full result when projection cannot authorize a rewrite: %s', (variant) => {
    const records = referenceRecord()
    if (variant === 'malformed') records[1].content = String(records[1].content).replace('"version":1', '"version":999')
    if (variant === 'unpaired') records.shift()
    if (variant === 'unrelated') records[0].tool_calls![0].function.name = 'fetch_page'
    const original = structuredClone(records)
    expect(projectProviderMessages(records).at(-1)?.content).toBe(records.at(-1)?.content)
    expect(estimateProviderContextBytes(records, [], SYSTEM)).toBeGreaterThan(BYTE_LIMIT)
    expect(records).toEqual(original)
  })

  it.each(['system', 'tools', 'supplement'] as const)('includes %s bytes when deciding and reporting checkpoint pressure', async (variant) => {
    const context = await harness()
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Earlier task.' },
      { role: 'assistant', content: 'Earlier result.', reasoning_content: 'r'.repeat(12_000) },
      { role: 'user', content: 'Current task.' },
    ]
    const marker = 'CURRENT_CONTROL'
    const overhead = `${marker} ${'x'.repeat(9_000)}`
    const system = variant === 'system' ? overhead : SYSTEM
    const tools = variant === 'tools' ? [tool(overhead)] : []
    const supplement: ModelMessage[] = variant === 'supplement' ? [{ role: 'system', content: overhead }] : []
    const providerBytes = estimateProviderContextBytes([...messages, ...supplement], tools, system)
    expect(bytes(messages)).toBeLessThan(BYTE_LIMIT)
    expect(providerBytes).toBeGreaterThan(BYTE_LIMIT)
    expect(estimateProviderContextTokens([...messages, ...supplement], tools, system)).toBeLessThan(100_000)
    const original = structuredClone(messages)
    try {
      const prepared = await context.agent['prepareContext'](context.session.summary.id, 'turn_test', 'step_test', messages,
        new AbortController().signal, 'test-model', undefined, tools, system, { contextSupplement: supplement })
      expect(context.stream).toHaveBeenCalledOnce()
      expect(JSON.stringify(context.stream.mock.calls[0][0])).not.toContain(marker)
      expect(prepared.changed).toBe(true)
      expect(prepared.messages.some((message) => arenaUserAuthoredText(message) === messages.at(-1)?.content)).toBe(true)
      expect(estimateProviderContextBytes([...prepared.messages, ...supplement], tools, system)).toBeLessThan(BYTE_LIMIT)
      expect(messages).toEqual(original)
      const event = (await context.store.events(context.session.summary.id)).find((entry) => entry.type === 'context.compacted')
      expect(event?.data).toMatchObject({ contextByteBasis: 'provider_context_v1', beforeBytes: providerBytes,
        ...checkpointIdentity(context.stream.mock.calls[0][0].messages),
        afterBytes: estimateProviderContextBytes([...prepared.messages, ...supplement], tools, system),
        beforeDurableMessageBytes: bytes(original), afterDurableMessageBytes: bytes(prepared.messages) })
    } finally { await context.close() }
  })

  it('preserves an indivisible current reasoning/tool pair instead of claiming it was compacted', async () => {
    const context = await harness()
    const records = referenceRecord()
    records[0].reasoning_content = 'current reasoning '.repeat(2_000)
    const messages: ModelMessage[] = [{ role: 'user', content: 'Current task.' }, ...records]
    const original = structuredClone(messages)
    expect(estimateProviderContextBytes(messages, [], SYSTEM)).toBeGreaterThan(BYTE_LIMIT)
    try {
      const prepared = await context.agent['prepareContext'](context.session.summary.id, 'turn_test', 'step_test', messages,
        new AbortController().signal, 'test-model', undefined, [], SYSTEM)
      expect(context.stream).not.toHaveBeenCalled()
      expect(prepared).toEqual({ changed: false, messages: original })
      expect(projectProviderMessages(prepared.messages)[1].reasoning_content).toBe(records[0].reasoning_content)
    } finally { await context.close() }
  })

  it('rejects a summary that shrinks durable bytes but grows the actual provider context', async () => {
    const context = await harness('Retrospective fact. '.repeat(200))
    const messages: ModelMessage[] = [{ role: 'user', content: 'Earlier task.' }, ...referenceRecord(),
      { role: 'user', content: 'Continue.' }]
    const original = structuredClone(messages)
    try {
      const prepared = await context.agent['prepareContext'](context.session.summary.id, 'turn_test', 'step_test', messages,
        new AbortController().signal, 'test-model', undefined, [], SYSTEM, { force: true, reason: 'tool_request' })
      expect(context.stream).toHaveBeenCalledOnce()
      expect(prepared).toEqual({ changed: false, messages: original })
      const events = await context.store.events(context.session.summary.id)
      expect(events.some((event) => event.type === 'context.compacted')).toBe(false)
      expect(events.find((event) => event.type === 'context.compaction.failed')?.data).toMatchObject({
        ...checkpointIdentity(context.stream.mock.calls[0][0].messages),
        contextByteBasis: 'provider_context_v1', message: expect.stringContaining('did not reduce context bytes'),
      })
    } finally { await context.close() }
  })
})
