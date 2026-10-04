import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent-service.js'
import { SessionStore } from './session-store.js'
import type { DeepSeekClient, ModelResult } from './deepseek.js'
import type { ToolExecutor } from './tools.js'

const roots: string[] = []
const agents: AgentService[] = []
afterEach(async () => { await Promise.all(agents.splice(0).map((agent) => agent.shutdown())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
function response(content = '', call?: { name: string; args: unknown; id: string }): ModelResult {
  return { content, reasoningContent: '', finishReason: call ? 'tool_calls' : 'stop',
    toolCalls: call ? [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] : [],
    usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cachedPromptTokens: 0 }, modelCallCount: 1 }
}
interface RunContext { store: SessionStore; agent: AgentService; id: string }
async function run(prompt: string, results: ModelResult[], hooks: {
  setup?: (context: RunContext) => void | Promise<void>
  onRequest?: (context: RunContext, index: number) => void | Promise<void>
  tools?: Pick<ToolExecutor, 'execute'>
} = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-adaptive-')); roots.push(root)
  const store = new SessionStore(root, 'offline-model'); await store.initialize()
  const id = (await store.create()).summary.id
  let context: RunContext
  let requestIndex = 0
  const stream = vi.fn<DeepSeekClient['stream']>().mockImplementation(async (options) => {
    await options.beforeRequest?.()
    await hooks.onRequest?.(context, requestIndex++)
    const next = results.shift(); if (!next) throw new Error('Unexpected extra model request')
    return next
  })
  const agent = new AgentService(store, { client: { stream }, tools: hooks.tools, runTimeoutMs: 5000 }); agents.push(agent)
  context = { store, agent, id }
  await hooks.setup?.(context)
  await agent.submit(id, { content: prompt })
  for (let i = 0; agent.isRunning(id) && i < 1000; i++) await new Promise((done) => setTimeout(done, 5))
  expect(agent.isRunning(id)).toBe(false)
  return { root, store, id, stream, state: await store.get(id), events: await store.events(id) }
}
const finish = (args: unknown) => response('', { name: 'finish_task', args, id: 'finish_actual' })
const report = (path: string) => ({ summary: 'Created the requested file.', outcome: 'completed', checks: [{
  requirement: 'Create the requested file', method: 'The write succeeded with the requested contents.', required: true,
  status: 'passed', evidence: { callIds: ['write_actual'], paths: [path] },
}] })

describe('adaptive completion in the actual agent loop', () => {
  it('finishes a simple direct answer in one call without compulsory tools or review', async () => {
    const task = await run('What is 2 + 2? Answer only the number.', [response('4')])
    expect(task.state.summary.status).toBe('completed')
    expect(task.events.find((event) => event.type === 'assistant.final')?.data.content).toBe('4')
    expect(task.stream).toHaveBeenCalledTimes(1)
  })
  it.each(['result.txt', 'slides.html', 'result.unknown'])('lets the agent select suitable checks independently of %s', async (path) => {
    const task = await run(`Create ${path} containing exactly Hello. Do not start a server.`, [
      response('', { name: 'write_file', args: { path, content: 'Hello' }, id: 'write_actual' }), finish(report(path)),
    ])
    expect(task.state.summary.status).toBe('completed')
    expect(await readFile(resolve(task.store.workspaceDir(task.id), path), 'utf8')).toBe('Hello')
    const record = task.events.find((event) => event.type === 'task.verification.completed')
    expect(record?.data.outcome).toBe('completed')
    expect(record?.data.fileEvidence).toEqual([expect.objectContaining({ path, bytes: 5 })])
    expect(task.stream).toHaveBeenCalledTimes(2)
    expect(task.events.filter((event) => event.type === 'tool.started').map((event) => (event.data.call as { name: string }).name)).toEqual(['write_file'])
  })
  it('corrects invented provenance without redoing successful work', async () => {
    const invalid = report('report.txt'); invalid.checks[0].evidence.callIds = ['invented']
    const task = await run('Create report.txt containing Hello.', [
      response('', { name: 'write_file', args: { path: 'report.txt', content: 'Hello' }, id: 'write_actual' }), finish(invalid), finish(report('report.txt')),
    ])
    expect(task.state.summary.status).toBe('completed')
    expect(task.events.filter((event) => event.type === 'tool.started')).toHaveLength(1)
    expect(task.events.filter((event) => event.type === 'task.verification.completed')).toHaveLength(1)
    expect(task.events.some((event) => event.type === 'model.final.repair' && event.data.reason === 'task_verification_protocol')).toBe(true)
  })
  it('delivers public-path tool results without wasting a completion repair attempt', async () => {
    const path = '/home/user/public-result.txt'
    const task = await run(`Create ${path} containing exactly Hello.`, [
      response('', { name: 'write_file', args: { path, content: 'Hello' }, id: 'write_actual' }), finish(report(path)),
    ])
    expect(task.stream).toHaveBeenCalledTimes(2)
    expect(task.state.summary.status).toBe('completed')
    expect(task.events.find((event) => event.type === 'task.verification.completed')?.data.fileEvidence)
      .toEqual([expect.objectContaining({ path: 'public-result.txt', bytes: 5 })])
    expect(task.events.some((event) => event.type === 'model.final.repair')).toBe(false)
  })
  it('refreshes extraction after an external edit instead of attesting the unobserved bytes', async () => {
    const path = 'external.txt'
    const checked = (callId: string) => ({ summary: 'The current contents were checked.', outcome: 'completed', checks: [{
      requirement: 'Check the current file contents', method: 'Extract the file and compare its contents.', required: true,
      status: 'passed', evidence: { callIds: [callId], paths: [path] },
    }] })
    const task = await run('Check the current contents of external.txt.', [
      response('', { name: 'extract_attachment', id: 'extract_old', args: { path } }), finish(checked('extract_old')),
      response('', { name: 'extract_attachment', id: 'extract_current', args: { path } }), finish(checked('extract_current')),
    ], {
      setup: async ({ store, id }) => { await writeFile(resolve(store.workspaceDir(id), path), 'old bytes') },
      onRequest: async ({ store, id }, index) => {
        if (index === 1) await writeFile(resolve(store.workspaceDir(id), path), 'new bytes')
      },
    })
    expect(task.stream).toHaveBeenCalledTimes(4)
    expect(task.state.summary.status).toBe('completed')
    expect(task.events.filter((event) => event.type === 'file.changed')).toHaveLength(0)
    expect(task.events.filter((event) => event.type === 'model.final.repair')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ reason: 'task_verification_protocol', diagnostic: expect.stringContaining('different file bytes') }) }),
    ])
    const receipt = task.events.find((event) => event.type === 'task.verification.completed')
    expect(receipt?.data.eventEvidence).toEqual([expect.objectContaining({ callId: 'extract_current' })])
    expect(task.events.filter((event) => event.type === 'assistant.final')).toHaveLength(1)
  })
  it('delivers an honest limitation without turning a missing observation into an execution failure', async () => {
    const task = await run('Assess the supplied statement; distinguish unknown facts.', [finish({
      summary: 'The fact cannot be verified from the available information.', outcome: 'limited', checks: [{
        requirement: 'Assess the statement', method: 'Compare the available information', required: true, status: 'unverified', evidence: {}, note: 'Source is unavailable.',
      }],
    })])
    expect(task.state.summary.status).toBe('completed')
    expect(task.events.find((event) => event.type === 'task.verification.completed')?.data.outcome).toBe('limited')
    expect(task.stream).toHaveBeenCalledTimes(1)
  })

  it('stops requesting an invalid completion envelope after two failures and delivers a truthful limited result', async () => {
    const invalidProvenance = report('retained.txt')
    invalidProvenance.checks[0].evidence.callIds = ['invented_call']
    const unresolved = { ...report('retained.txt'), checks: [{ ...report('retained.txt').checks[0], status: 'unverified' }] }
    const final = 'The file was created. I could not complete a valid verification record, so its verification remains unconfirmed.'
    const task = await run('Create retained.txt containing Hello.', [
      response('', { name: 'write_file', args: { path: 'retained.txt', content: 'Hello' }, id: 'write_actual' }),
      finish(invalidProvenance), finish(unresolved), response(final),
    ])
    expect(task.state.summary.status).toBe('completed')
    expect(task.stream).toHaveBeenCalledTimes(4)
    expect(task.stream.mock.calls[2][0].tools.some((tool) => tool.function.name === 'finish_task')).toBe(true)
    expect(task.stream.mock.calls[3][0].tools.some((tool) => tool.function.name === 'finish_task')).toBe(false)
    expect(task.stream.mock.calls[3][0].messages[0].content).toContain('formal check record unavailable')
    expect(task.events.filter((event) => event.type === 'model.final.repair' && event.data.reason === 'task_verification_protocol')).toHaveLength(2)
    expect(task.events.filter((event) => event.type === 'tool.started')).toHaveLength(1)
    expect(await readFile(resolve(task.store.workspaceDir(task.id), 'retained.txt'), 'utf8')).toBe('Hello')
    expect(task.events.filter((event) => event.type === 'assistant.final').map((event) => event.data.content)).toEqual([final])
    const receipts = task.events.filter((event) => event.type === 'task.verification.completed')
    expect(receipts).toHaveLength(1)
    expect(receipts[0].data).toMatchObject({ outcome: 'limited', source: 'direct', verificationRecorded: false, checks: [], summary: final })
  })

  it('bounds a noncooperative model to three invalid finish_task calls and preserves prior work in a limited delivery', async () => {
    const invalid = { summary: 'Everything passed.', outcome: 'completed', checks: [{
      requirement: 'Verify the existing result', method: 'No completed verification is available.', required: true,
      status: 'unverified', evidence: {},
    }] }
    const task = await run('Assess the existing result; report any uncertainty honestly.', [finish(invalid), finish(invalid), finish(invalid)], {
      setup: async ({ store, id }) => { await writeFile(resolve(store.workspaceDir(id), 'prior-work.txt'), 'Retain this valid work.') },
    })
    expect(task.stream).toHaveBeenCalledTimes(3)
    expect(task.state.summary.status).toBe('completed')
    expect(task.stream.mock.calls[2][0].tools.some((tool) => tool.function.name === 'finish_task')).toBe(false)
    expect(await readFile(resolve(task.store.workspaceDir(task.id), 'prior-work.txt'), 'utf8')).toBe('Retain this valid work.')
    const finals = task.events.filter((event) => event.type === 'assistant.final')
    expect(finals).toHaveLength(1)
    expect(finals[0].data.content).toMatch(/unverified/iu)
    expect(task.events.filter((event) => event.type === 'task.verification.completed')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ outcome: 'limited', verificationRecorded: false }) }),
    ])
    expect(task.events.some((event) => event.type === 'model.final.repair'
      && String(event.data.reason).includes('protocol_exhausted'))).toBe(true)
    const finalTool = [...task.state.messages].reverse().find((message) => message.role === 'tool')
    expect(JSON.parse(finalTool?.content ?? '{}')).toMatchObject({ notExecuted: true })
  })

  it('does not reset completion repair exhaustion through an unexecuted ordinary tool proposal', async () => {
    const invalid = { summary: 'Everything passed.', outcome: 'completed', checks: [{
      requirement: 'Confirm the result', method: 'No current observation is available', required: true,
      status: 'unverified', evidence: {},
    }] }
    const task = await run('Confirm the result or explain why it is unverified.', [
      finish(invalid), finish(invalid), response('', { name: 'unavailable_observation_tool', id: 'not_executed', args: {} }), finish(invalid),
    ])
    expect(task.stream).toHaveBeenCalledTimes(4)
    expect(task.state.summary.status).toBe('completed')
    expect(task.stream.mock.calls[3][0].tools.some((tool) => tool.function.name === 'finish_task')).toBe(false)
    const rejected = task.events.find((event) => event.type === 'tool.failed' && event.callId === 'not_executed')
    expect(rejected?.data).toMatchObject({ notExecuted: true, reason: 'tool_not_enabled' })
    expect(task.events.find((event) => event.type === 'task.verification.completed')?.data).toMatchObject({ outcome: 'limited', verificationRecorded: false })
    expect(task.events.find((event) => event.type === 'assistant.final')?.data.content).toMatch(/unverified/iu)
  })

  it('allows a new completion attempt after a real operation provides additional evidence', async () => {
    const invalid = { summary: 'Everything passed.', outcome: 'completed', checks: [{
      requirement: 'Create the requested file', method: 'No file was created yet.', required: true,
      status: 'unverified', evidence: {},
    }] }
    const task = await run('Create fresh-evidence.txt containing Hello.', [
      finish(invalid), finish(invalid),
      response('', { name: 'write_file', id: 'write_actual', args: { path: 'fresh-evidence.txt', content: 'Hello' } }),
      finish(report('fresh-evidence.txt')),
    ])
    expect(task.stream).toHaveBeenCalledTimes(4)
    expect(task.state.summary.status).toBe('completed')
    expect(task.stream.mock.calls[2][0].tools.some((tool) => tool.function.name === 'finish_task')).toBe(false)
    expect(task.stream.mock.calls[3][0].tools.some((tool) => tool.function.name === 'finish_task')).toBe(true)
    expect(await readFile(resolve(task.store.workspaceDir(task.id), 'fresh-evidence.txt'), 'utf8')).toBe('Hello')
    expect(task.events.find((event) => event.type === 'task.verification.completed')?.data).toMatchObject({ outcome: 'completed', source: 'agent' })
    expect(task.events.some((event) => event.type === 'model.final.repair' && String(event.data.reason).includes('protocol_exhausted'))).toBe(false)
  })

  it('keeps completion repair exhausted after a tool explicitly reports not_executed status', async () => {
    const invalid = { summary: 'Everything passed.', outcome: 'completed', checks: [{
      requirement: 'Create the requested result', method: 'No operation has executed.', required: true,
      status: 'unverified', evidence: {},
    }] }
    const task = await run('Create the result, or explain the blocker.', [finish(invalid), finish(invalid),
      response('', { name: 'write_file', id: 'deferred_write', args: { path: 'result.txt', content: 'Hello' } }), finish(invalid),
    ], { tools: { execute: vi.fn().mockResolvedValue({ isError: false, content: JSON.stringify({ status: 'not_executed' }) }) } })
    expect(task.stream).toHaveBeenCalledTimes(4)
    expect(task.stream.mock.calls[3][0].tools.some((tool) => tool.function.name === 'finish_task')).toBe(false)
    expect(task.state.summary.status).toBe('completed')
    expect(task.events.find((event) => event.type === 'task.verification.completed')?.data).toMatchObject({ outcome: 'limited', verificationRecorded: false })
  })

  it('requires a check record for an executed failure as well as an executed success', async () => {
    const task = await run('Read missing.txt and report whether it is available.', [
      response('', { name: 'read_file', id: 'read_missing', args: { path: 'missing.txt' } }),
      finish({ summary: 'Done.', outcome: 'completed', checks: [] }),
      finish({ summary: 'The requested file is missing.', outcome: 'limited', checks: [{
        requirement: 'Read the requested file', method: 'Attempted to read missing.txt', required: true,
        status: 'failed', evidence: { callIds: ['read_missing'] },
      }] }),
    ])
    expect(task.stream).toHaveBeenCalledTimes(3)
    expect(task.events.find((event) => event.type === 'task.verification.completed')?.data).toMatchObject({ outcome: 'limited', source: 'agent' })
  })

  it('resets the completion repair limit when applied steering changes the requirements', async () => {
    const invalid = { summary: 'Everything passed.', outcome: 'completed', checks: [{
      requirement: 'Verify an unavailable fact', method: 'No source is available', required: true,
      status: 'unverified', evidence: {},
    }] }
    const task = await run('Verify the supplied fact.', [finish(invalid), finish(invalid), response('The source is missing.'),
      finish({ summary: '42', outcome: 'completed', checks: [{ requirement: 'Return 42',
        method: 'The answer equals the newly requested number.', required: true, status: 'passed', evidence: {},
      }] }),
    ], { onRequest: async ({ agent, id }, index) => {
      if (index === 2) await agent.steer(id, { content: 'Replace that requirement: answer only 42.', clientMessageId: 'new-scope' })
    } })
    expect(task.stream).toHaveBeenCalledTimes(4)
    expect(task.stream.mock.calls[3][0].tools.some((tool) => tool.function.name === 'finish_task')).toBe(true)
    expect(task.events.find((event) => event.type === 'assistant.final')?.data.content).toBe('42')
    expect(task.events.find((event) => event.type === 'task.verification.completed')?.data).toMatchObject({ outcome: 'completed', source: 'agent' })
  })

  it.each(['model_result', 'terminal_commit'] as const)('never publishes an old finish_task when steering arrives at %s', async (boundary) => {
    const completion = (summary: string, id: string) => response('', { name: 'finish_task', id,
      args: { summary, outcome: 'completed', checks: [{ requirement: 'Return the requested answer',
        method: 'Compare the answer with the current user instruction', required: true, status: 'passed', evidence: {} }] } })
    const input = { content: 'Change the answer to 42.', clientMessageId: 'latest-answer' }
    let receivedId: string | undefined
    const task = await run('Return the answer 10.', [completion('10', 'finish_stale'), completion('42', 'finish_current')], {
      onRequest: boundary === 'model_result' ? async ({ agent, id }, index) => {
        if (index === 0) receivedId = (await agent.steer(id, input)).id
      } : undefined,
      setup: boundary === 'terminal_commit' ? ({ store, agent, id }) => {
        const stage = store.stageRunTerminal.bind(store)
        let injected = false
        vi.spyOn(store, 'stageRunTerminal').mockImplementation(async (...args) => {
          if (!injected && args[1].status === 'completed') {
            injected = true
            receivedId = (await agent.steer(id, input)).id
          }
          return await stage(...args)
        })
      } : undefined,
    })
    expect(task.state.summary.status).toBe('completed')
    expect(task.stream).toHaveBeenCalledTimes(2)
    const finals = task.events.filter((event) => event.type === 'assistant.final')
    expect(finals.map((event) => event.data.content)).toEqual(['42'])
    const receipts = task.events.filter((event) => event.type === 'task.verification.completed')
    expect(receipts).toHaveLength(1)
    expect(receipts[0].data).toMatchObject({ source: 'agent', summary: '42', outcome: 'completed' })
    expect(task.state.steering).toEqual([expect.objectContaining({ id: receivedId, status: 'applied', content: input.content })])
    const applied = task.events.filter((event) => event.type === 'user.steering.applied')
    expect(applied).toHaveLength(1)
    expect(applied[0].seq).toBeLessThan(finals[0].seq)
    expect(task.stream.mock.calls[1][0].messages.some((message) => message.role === 'user'
      && message.content?.startsWith('[Harness user steering:') && message.content.includes(input.content))).toBe(true)
    if (boundary === 'model_result') {
      expect(task.state.messages.some((message) => message.tool_calls?.some((call) => call.id === 'finish_stale'))).toBe(false)
    }
  })
})
