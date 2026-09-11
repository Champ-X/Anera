import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import { contextHash, projectHistoricalContextRecords, readContextRecord } from './context-records.js'
import { projectProviderMessages } from './deepseek.js'
import { AgentService, estimateProviderContextBytes, repairVisualWebArtifactPhaseToolCalls } from './agent-service.js'
import { SessionStore } from './session-store.js'
import { EXTENSION_TOOL_DEFINITIONS } from './tools.js'
import { resolveAgentTokenLimit } from './config.js'

function history(): ModelMessage[] {
  return [{ role: 'user', content: 'Inspect the records. Preserve limitations.' }, ...Array.from({length: 4}, (_,i): ModelMessage[] => [
    { role: 'assistant', content: '', reasoning_content: 'Exact required tool reasoning.', tool_calls: [
      { id: `call_${i}`, type: 'function', function: { name: `generic_${i}`, arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: `call_${i}`, tool_result_status: 'succeeded', content: JSON.stringify({
      status: 'verification_failed', limitation: 'Do not publish', body: `Evidence ${i} 中文🧭\n`.repeat(3000),
    }) },
  ]).flat(), { role: 'assistant', content: 'Inspect omitted details if needed.' }]
}

describe('retrievable provider context', () => {
  it('keeps exact durable evidence, pairs and reasoning; archives only consumed older text', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-context-records-test-'))
    try {
      const messages = history(), before = structuredClone(messages)
      const projected = await projectHistoricalContextRecords(root, messages, projectProviderMessages(messages))
      expect(messages).toEqual(before)
      expect(projected.recordCount).toBe(2)
      expect(projected.messages.map(m => m.content)).toEqual(messages.map(m => m.content))
      expect(projected.messages.filter(m => m.role === 'assistant')).toEqual(messages.filter(m => m.role === 'assistant'))
      const wire = projectProviderMessages(projected.messages)
      expect(JSON.stringify(wire)).not.toContain('context_projection')
      const record = JSON.parse(String(wire[2].content))
      expect(record.excerpt).toContain('verification_failed')
      expect(record.excerpt).toContain('Do not publish')
      expect(record.note).toContain('NOT complete evidence')
      let offset = 0, restored = ''
      while (true) {
        const page = await readContextRecord(root, { sha256: record.sha256, offset })
        restored += page.content
        if (page.next_offset === null) break
        offset = page.next_offset!
      }
      expect(restored).toBe(messages[2].content)
      expect((await readContextRecord(root, {sha256: record.sha256, query: '中文🧭', limit: 3})).content).toBe('中文🧭')
      expect(await projectHistoricalContextRecords(root, projected.messages, wire)).toMatchObject({changed: false})
      const stale = structuredClone(projected.messages)
      stale[2].content = 'New result must not inherit old projection'
      expect(projectProviderMessages(stale)[2].content).toBe(stale[2].content)
      const failed = history(); failed[2].tool_result_status = 'failed'
      const unknown = history(); delete unknown[2].tool_result_status
      for (const input of [failed, unknown]) expect((await projectHistoricalContextRecords(root,input,projectProviderMessages(input))).messages[2]).toEqual(input[2])
      await expect(readContextRecord(root, {sha256: '../outside'})).rejects.toThrow('Invalid')
      await expect(readContextRecord(root, {sha256: record.sha256, limit: 12001})).rejects.toThrow('Invalid')
      await writeFile(resolve(root, `${record.sha256}.txt`), 'tampered')
      await expect(readContextRecord(root, {sha256: record.sha256})).rejects.toThrow('integrity')
      await expect(projectHistoricalContextRecords(root, messages, projectProviderMessages(messages))).rejects.toThrow('integrity')
    } finally { await rm(root, {recursive: true, force: true}) }
  })

  it('reduces actual request pressure without buying a summary; retrieval uses the real executor and survives reload', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-context-controller-test-'))
    const store = new SessionStore(root,'offline-model'); await store.initialize(); const session = await store.create()
    const stream = vi.fn(async () => { throw new Error('No paid or summary model required') })
    const agent = new AgentService(store,{client: {stream} as never, maxAgentTotalTokensPerTurn: 0})
    try {
      const messages = history()
      const defs = [EXTENSION_TOOL_DEFINITIONS.read_context]
      const result = await agent['prepareContext'](session.summary.id,'turn_test','step_test',messages,
        new AbortController().signal,'offline-model',undefined,defs,'Inspect evidence.')
      expect(stream).not.toHaveBeenCalled()
      expect(result.changed).toBe(true)
      expect(estimateProviderContextBytes(result.messages,defs,'Inspect evidence.'))
        .toBeLessThan(estimateProviderContextBytes(messages,defs,'Inspect evidence.') * 0.6)
      await store.update(session.summary.id, state => { state.messages = result.messages })
      const restored = await new SessionStore(root,'offline-model').get(session.summary.id)
      const record = JSON.parse(String(projectProviderMessages(restored.messages)[2].content))
      const output = await agent['tools'].execute({id:'retrieve',name:'read_context',arguments:{sha256:record.sha256,limit:100}}, {
        sessionId:session.summary.id, turnId:'turn_test', stepId:'step_test', signal:new AbortController().signal,
      })
      expect(output.isError).toBe(false)
      expect(JSON.parse(output.content).content).toBe(Array.from(messages[2].content!).slice(0,100).join(''))
      const other = await store.create()
      const denied = await agent['tools'].execute({id:'cross_session',name:'read_context',arguments:{sha256:record.sha256}}, {
        sessionId:other.summary.id,turnId:'turn_test',stepId:'step_test',signal:new AbortController().signal,
      })
      expect(denied.isError).toBe(true)
      expect(await readFile(resolve(store.sessionDir(session.summary.id),'context-records',`${record.sha256}.txt`),'utf8')).toBe(messages[2].content)
      expect(contextHash(messages[2].content!)).toBe(record.sha256)
      const call = [{id:'read',type:'function' as const,function:{name:'read_context',arguments:JSON.stringify({sha256:record.sha256})}}]
      expect(repairVisualWebArtifactPhaseToolCalls(call,'reference_source_check').toolCalls).toEqual(call)
    } finally { await agent.shutdown(); await rm(root,{recursive:true,force:true}) }
  })

  it('disables token stopping, not metering or request limits, including after restored usage exceeds four million', async () => {
    expect(resolveAgentTokenLimit('')).toBe(0); expect(resolveAgentTokenLimit('0')).toBe(0)
    expect(resolveAgentTokenLimit('4000000')).toBe(4000000)
    for (const value of ['-1','1.2','NaN','unlimited']) expect(() => resolveAgentTokenLimit(value)).toThrow()
    const root = await mkdtemp(resolve(tmpdir(),'anera-unlimited-token-test-'))
    const store = new SessionStore(root,'offline-model'); await store.initialize(); const {summary} = await store.create()
    const stream = vi.fn(async (_options: unknown) => ({ content:'Done',reasoningContent:'',toolCalls:[],finishReason:'stop',
      usage:{promptTokens:4_100_000,completionTokens:1,totalTokens:4_100_001,cachedPromptTokens:0},modelCallCount:1 }))
    const agent = new AgentService(store,{client:{stream} as never,maxAgentTotalTokensPerTurn:0})
    try {
      const pending = {modelRequests:1,totalTokens:4_121_743}
      expect(await agent['assertAgentTurnModelBudget'](summary.id,'turn_test',pending)).toEqual(pending)
      const result = await agent['streamAgentModel'](summary.id,'turn_test','step_test',{
        messages:[{role:'user',content:'Continue'}],tools:[],signal:new AbortController().signal,onContent:()=>{},onReasoning:()=>{},
      },pending)
      expect(stream.mock.calls[0]?.[0]).not.toHaveProperty('maxTotalTokens')
      expect(result.usage.totalTokens).toBe(4_100_001)
      await agent['recordUsage'](summary.id,'turn_test','step_test',result.usage,'agent',undefined,'offline-model',1,1)
      const reloaded = new SessionStore(root,'offline-model')
      const restarted = new AgentService(reloaded,{client:{stream} as never,maxAgentTotalTokensPerTurn:0})
      try {
        expect((await reloaded.get(summary.id)).summary.usage.totalTokens).toBe(4_100_001)
        expect(await restarted['assertAgentTurnModelBudget'](summary.id,'turn_test')).toMatchObject({totalTokens:4_100_001})
      } finally { await restarted.shutdown() }
      await expect(agent['assertAgentTurnModelBudget'](summary.id,'turn_test',{modelRequests:96,totalTokens:0})).rejects.toThrow('model-request budget')
    } finally { await agent.shutdown(); await rm(root,{recursive:true,force:true}) }
  })

  it('offers retrieval to a real Agent turn and executes it without reopening the original task action', async () => {
    const root = await mkdtemp(resolve(tmpdir(),'anera-context-route-test-'))
    const store = new SessionStore(root,'offline-model'); await store.initialize(); const {summary} = await store.create()
    await store.update(summary.id,state => { state.messages = history() })
    let calls = 0
    const stream = vi.fn(async (options: {messages: ModelMessage[]; tools: Array<{function:{name:string}}>; providerTools?: unknown}) => {
      calls++
      expect(options.providerTools).toEqual(options.tools)
      expect(options.messages.at(-1)?.content).toContain('Harness historical evidence navigation')
      expect(options.messages.at(-1)?.content).toContain('read_context is available in this phase')
      const wire = projectProviderMessages(options.messages)
      expect(options.tools.some(tool => tool.function.name === 'read_context')).toBe(true)
      const content = calls === 1 ? '' : 'The reported limitation was: Do not publish.'
      let toolCalls: NonNullable<ModelMessage['tool_calls']> = []
      if (calls === 1) {
        const record = wire.find(m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('historical_context_record'))!
        const sha256 = JSON.parse(String(record.content)).sha256
        toolCalls = [{id:'lookup',type:'function',function:{name:'read_context',arguments:JSON.stringify({sha256,query:'Do not publish',limit:14})}}]
      } else {
        expect(wire.some(m => m.tool_call_id === 'lookup' && String(m.content).includes('Do not publish'))).toBe(true)
      }
      return {content,reasoningContent:'',toolCalls,finishReason:toolCalls.length?'tool_calls':'stop',
        usage:{promptTokens:100,completionTokens:10,totalTokens:110,cachedPromptTokens:0},modelCallCount:1}
    })
    const agent = new AgentService(store,{client:{stream} as never,maxAgentTotalTokensPerTurn:0})
    try {
      await agent.submit(summary.id,{content:'What limitation did the retained generic records report? Do not modify any files.'})
      await vi.waitFor(() => expect(agent.isRunning(summary.id)).toBe(false),{timeout:5000,interval:10})
      const state = await store.get(summary.id)
      expect(state.summary.status).toBe('completed')
      expect(calls).toBe(2)
      const events = await store.events(summary.id)
      expect(events.filter(e => e.type === 'tool.completed').map(e => e.data.call.name)).toEqual(['read_context'])
    } finally {await agent.shutdown();await rm(root,{recursive:true,force:true})}
  })
})
