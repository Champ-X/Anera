import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallRecord } from '../shared/types.js'
import { AgentService, executeToolBatch } from './agent-service.js'
import { BrowserManager } from './browser-manager.js'
import { ProcessManager } from './process-manager.js'
import { SessionStore } from './session-store.js'
import { speechMeteringAsModelUsage, speechProviderMetering } from './speech.js'
import { ToolExecutor, type ToolContext } from './tools.js'

const roots: string[] = []
const agents = new Set<AgentService>()
const managers: ProcessManager[] = []

afterEach(async () => {
  for (const agent of agents) await agent.shutdown()
  agents.clear()
  await Promise.all(managers.splice(0).map((manager) => manager.stopEverything()))
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function speechCall(id: string, path: string): ToolCallRecord {
  return { id, name: 'generate_speech', arguments: { text: `Clip ${path}`, voice_id: 'voice-00', file_path: path } }
}

function wavFixture(): Buffer {
  const samples = 800
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8_000, 24)
  bytes.writeUInt32LE(16_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}

const audio = wavFixture()
const audioResponse = () => new Response(Uint8Array.from(audio), { headers: { 'content-type': 'audio/wav' } })

async function speechFixture(fetchImpl: typeof fetch) {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-speech-parallel-'))
  roots.push(root)
  const store = new SessionStore(root, 'test-model')
  await store.initialize()
  const sessionId = (await store.create()).summary.id
  await store.update(sessionId, (state) => {
    state.voices = { 'voice-00': {
      providerVoice: 'alloy', language: 'en-US', createdAt: new Date().toISOString(), sourceCallId: 'voice-registration',
    } }
  })
  const makeExecutor = (currentStore = store) => {
    const processes = new ProcessManager(async () => undefined)
    managers.push(processes)
    return new ToolExecutor(currentStore, processes, new BrowserManager(), { inspect: vi.fn() }, async () => false, {
      fetch: fetchImpl, imageApiKey: 'offline-test-key', imageBaseUrl: 'https://offline.invalid/v1',
    })
  }
  const context: ToolContext = {
    sessionId, turnId: 'turn_speech_parallel', stepId: 'step_speech_parallel', signal: new AbortController().signal,
  }
  return { root, store, sessionId, context, tools: makeExecutor(), makeExecutor }
}

describe('bounded independent speech batches', () => {
  it('parallelizes independent destinations, serializes path aliases and keeps other tools as barriers', async () => {
    const calls = [
      { id: 'before', name: 'read_file', arguments: { path: 'audio/one.wav' } },
      speechCall('first', '/home/user/audio/one.wav'),
      speechCall('same', '~/audio/./one.wav'),
      speechCall('other', 'audio/two.wav'),
      { id: 'after', name: 'read_file', arguments: { path: 'audio/one.wav' } },
      speechCall('last', 'audio/three.wav'),
    ]
    const transitions: string[] = []
    const first = deferred()
    let active = 0
    let peak = 0
    const results = await executeToolBatch(calls, async (call) => {
      transitions.push(`start:${call.id}`)
      active += 1
      peak = Math.max(peak, active)
      if (call.id === 'first') await first.promise
      if (call.id === 'other') first.resolve()
      active -= 1
      transitions.push(`end:${call.id}`)
      return call.id
    }, 2)
    expect(peak).toBe(2)
    expect(results).toEqual(calls.map((call) => call.id))
    expect(transitions.indexOf('start:first')).toBeGreaterThan(transitions.indexOf('end:before'))
    expect(transitions.indexOf('start:other')).toBeLessThan(transitions.indexOf('end:first'))
    expect(transitions.indexOf('start:same')).toBeGreaterThan(transitions.indexOf('end:first'))
    expect(transitions.indexOf('start:after')).toBeGreaterThan(transitions.indexOf('end:same'))
    expect(transitions.indexOf('start:last')).toBeGreaterThan(transitions.indexOf('end:after'))
  })

  it('bounds concurrent provider calls and durable quota by occurrence even when call ids repeat', async () => {
    let active = 0
    let peak = 0
    let requests = 0
    const fetchMock = vi.fn(async () => {
      const request = ++requests
      active += 1
      peak = Math.max(peak, active)
      try {
        await new Promise((done) => setTimeout(done, 10))
        return request === 1 ? new Response('temporary provider failure', { status: 503 }) : audioResponse()
      } finally { active -= 1 }
    })
    const { root, store, context, sessionId, tools, makeExecutor } = await speechFixture(fetchMock as typeof fetch)
    const calls = Array.from({ length: 12 }, (_, index) => speechCall('repeated-provider-id', `audio/${index}.wav`))
    const indexes = new Map(calls.map((call, index) => [call, index]))
    const results = await executeToolBatch(calls, async (call) => {
      const callIndex = indexes.get(call)!
      await store.recordSteerableToolStart(sessionId, call, callIndex, { ...context, callId: call.id })
      return await tools.execute(call, { ...context, callIndex })
    }, 3)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(3)
    expect(requests).toBe(10)
    expect(results.filter((result) => !result.isError)).toHaveLength(9)
    expect(results.filter((result) => result.content.includes('at most 10 speech generations'))).toHaveLength(2)
    expect(results.reduce((total, result) => total + (result.speechUsage?.providerCalls ?? 0), 0)).toBe(10)
    expect((await store.events(sessionId)).filter((event) => event.type === 'tool.started')).toHaveLength(12)

    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const restartedTools = makeExecutor(restarted)
    const denied = await restartedTools.execute(speechCall('after-restart', 'audio/restart.wav'), { ...context, callIndex: 12 })
    expect(denied.content).toContain('at most 10 speech generations')
    expect(requests).toBe(10)
    const nextTurn = await restartedTools.execute(speechCall('next-turn', 'audio/next.wav'), {
      ...context, turnId: 'turn_next', callIndex: 0,
    })
    expect(nextTurn.isError).toBe(false)
    expect(requests).toBe(11)
  })

  it('does not reserve or call a provider for already cancelled queued speech', async () => {
    const fetchMock = vi.fn(async () => audioResponse())
    const { store, context, sessionId, tools } = await speechFixture(fetchMock as typeof fetch)
    const controller = new AbortController()
    controller.abort(new DOMException('Cancelled', 'AbortError'))
    const result = await tools.execute(speechCall('cancelled', 'audio/cancelled.wav'), { ...context, signal: controller.signal })
    expect(result).toMatchObject({ isError: true, aborted: true })
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await store.events(sessionId)).some((event) => event.type === 'tool.started')).toBe(false)
  })

  it('releases a failed destination queue and preserves provider usage if workspace publication fails', async () => {
    const fetchMock = vi.fn(async () => audioResponse())
    const { store, context, sessionId, tools } = await speechFixture(fetchMock as typeof fetch)
    vi.spyOn(store, 'commitWorkspaceWrite').mockRejectedValueOnce(new Error('Injected workspace publication failure'))
    const calls = [speechCall('failed', 'audio/result.wav'), speechCall('retry', '/home/user/audio/result.wav')]
    const results = await executeToolBatch(calls, (call) => tools.execute(call, context), 2)
    expect(results[0]).toMatchObject({ isError: true, speechUsage: { providerCalls: 1, providerOutputBytes: audio.length } })
    expect(results[1]).toMatchObject({ isError: false, speechUsage: { providerCalls: 1 } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await readFile(resolve(store.workspaceDir(sessionId), 'audio/result.wav'))).toEqual(audio)
  })

  it('keeps completed provider usage on cancellation and skips the remaining same-path request', async () => {
    const fetchMock = vi.fn(async () => audioResponse())
    const { store, context, sessionId, tools } = await speechFixture(fetchMock as typeof fetch)
    const controller = new AbortController()
    vi.spyOn(store, 'commitWorkspaceWrite').mockImplementationOnce(async () => {
      controller.abort(new DOMException('Cancelled while publishing speech', 'AbortError'))
      throw controller.signal.reason
    })
    const calls = [speechCall('in-flight', 'audio/cancel.wav'), speechCall('queued', './audio/cancel.wav')]
    const results = await executeToolBatch(calls, (call) => tools.execute(call, { ...context, signal: controller.signal }), 2)
    expect(results[0]).toMatchObject({ isError: true, aborted: true, speechUsage: { providerCalls: 1 } })
    expect(results[1]).toMatchObject({ isError: true, aborted: true })
    expect(results[1].speechUsage).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect((await store.events(sessionId)).filter((event) => event.type === 'tool.started')).toHaveLength(1)
    expect((await store.events(sessionId)).some((event) => event.type === 'audio.generated')).toBe(false)
  })

  it('settles concurrent repeated-id speech occurrences once and recovers publication without rebilling', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-speech-parallel-usage-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const sessionId = (await store.create()).summary.id
    const calls = [speechCall('shared-id', 'audio/one.wav'), speechCall('shared-id', 'audio/two.wav')]
    let decisions = 0
    const stream = vi.fn(async (options: { onContent: (text: string) => void }) => {
      const first = decisions++ === 0
      if (!first) options.onContent('Speech usage settled.')
      return {
        content: first ? '' : 'Speech usage settled.', reasoningContent: '', finishReason: first ? 'tool_calls' : 'stop',
        toolCalls: first ? calls.map((call) => ({ id: call.id, type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) : [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 }, modelCallCount: 1,
      }
    })
    const firstClip = deferred()
    let active = 0
    let peak = 0
    const execute = vi.fn(async (call: ToolCallRecord) => {
      active += 1
      peak = Math.max(peak, active)
      if (call.arguments.file_path === 'audio/one.wav') await firstClip.promise
      else firstClip.resolve()
      const speechUsage = speechProviderMetering(String(call.arguments.text), 100, 100, 100)
      active -= 1
      return { content: JSON.stringify({ status: 'success', file_path: call.arguments.file_path, hash: 'offline' }), isError: false,
        speechUsage, modelUsage: speechMeteringAsModelUsage(speechUsage), modelCallCount: 1, modelRequestCount: 1 }
    })
    const agent = new AgentService(store, { client: { stream } as never, tools: { execute }, runTimeoutMs: 5_000 })
    agents.add(agent)
    await agent.submit(sessionId, { content: 'Generate two independent speech clips.' })
    await vi.waitFor(async () => expect((await store.get(sessionId)).summary.status).toBe('completed'), { timeout: 3_000 })
    expect(peak).toBe(2)
    const before = await store.get(sessionId)
    const settlements = Object.values(before.usageSettlements ?? {}).filter((item) => item.source === 'speech')
    const events = (await store.events(sessionId)).filter((event) => event.type === 'usage.updated' && event.data.source === 'speech')
    expect(settlements).toHaveLength(2)
    expect(new Set(settlements.map((item) => item.id)).size).toBe(2)
    expect(events).toHaveLength(2)
    expect(before.summary.usage.modelCalls).toBe(4)
    await store.update(sessionId, (state) => {
      for (const settlement of Object.values(state.usageSettlements ?? {})) {
        if (settlement.source === 'speech') delete settlement.usageEventId
      }
    })
    await agent.shutdown()
    agents.delete(agent)
    const restarted = new SessionStore(root, 'test-model')
    await restarted.initialize()
    const recoveredAgent = new AgentService(restarted, { client: { stream } as never, tools: { execute } })
    agents.add(recoveredAgent)
    await recoveredAgent.initialize()
    const after = await restarted.get(sessionId)
    expect(after.summary.usage).toEqual(before.summary.usage)
    expect((await restarted.events(sessionId)).filter((event) => event.type === 'usage.updated' && event.data.source === 'speech')).toHaveLength(2)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(stream).toHaveBeenCalledTimes(2)
  })
})
