import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'

const roots: string[] = []
const agents: Awaited<ReturnType<typeof createApp>>['agent'][] = []
const servers: Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))))
  await Promise.all(agents.splice(0).map(agent => agent.shutdown()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-admission-audit-'))
  roots.push(dataRoot)
  const stream = vi.fn(async () => ({
    content: 'Acknowledged.', reasoningContent: '', toolCalls: [], finishReason: 'stop' as const,
    usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24, cachedPromptTokens: 0 },
  }))
  const app = await createApp({ dataRoot, model: 'test-model', agent: { client: { stream } as never } })
  agents.push(app.agent)
  return { ...app, dataRoot, stream }
}

describe('independent input admission audit', () => {
  it.each([
    ['null receipt', { audit: null }],
    ['zero receipt', { audit: 0 }],
    ['empty receipt', { audit: '' }],
    ['null receipt table', null],
    ['array receipt table', []],
    ['array-valued fingerprint', { audit: { fingerprint: ['a'.repeat(64)], turnId: 'turn_' + 'a'.repeat(20) } }],
  ])('fails closed for a damaged %s without dispatching another run', async (_name, damaged) => {
    const app = await setup()
    const session = await app.store.create()
    const id = session.summary.id
    const options = { content: 'Acknowledge.', clientMessageId: 'audit' }
    await app.agent.submit(id, options)
    await vi.waitFor(() => expect(app.agent.isRunning(id)).toBe(false))
    expect(app.stream).toHaveBeenCalledTimes(1)
    const statePath = resolve(app.store.sessionDir(id), 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    state.inputReceipts = damaged
    await writeFile(statePath, JSON.stringify(state))

    await expect(app.agent.submit(id, options)).rejects.toThrow(/Stored input receipt/)
    expect(await readdir(resolve(app.dataRoot, 'sessions'))).toEqual([id])
    expect(app.stream).toHaveBeenCalledTimes(1)
  })

  it('admits at most one of simultaneous different input IDs and allows a later new ID', async () => {
    const app = await setup()
    const session = await app.store.create()
    const id = session.summary.id
    const options = { content: 'Acknowledge.' }
    const results = await Promise.allSettled([
      app.agent.submit(id, { ...options, clientMessageId: 'parallel-a' }),
      app.agent.submit(id, { ...options, clientMessageId: 'parallel-b' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    await vi.waitFor(() => expect(app.agent.isRunning(id)).toBe(false))
    expect(app.stream).toHaveBeenCalledTimes(1)
    await app.agent.submit(id, { ...options, clientMessageId: 'later-intent' })
    await vi.waitFor(() => expect(app.agent.isRunning(id)).toBe(false))
    expect(app.stream).toHaveBeenCalledTimes(2)
    expect(Object.keys((await app.store.get(id)).inputReceipts!)).toHaveLength(2)
  })

  it('retains accepted identities across undo while allowing an explicitly new input', async () => {
    const app = await setup()
    const session = await app.store.create()
    const id = session.summary.id
    const options = { content: 'Acknowledge.', clientMessageId: 'before-undo' }
    const receipt = await app.agent.submit(id, options)
    await vi.waitFor(() => expect(app.agent.isRunning(id)).toBe(false))
    const final = (await app.store.events(id)).find(event => event.type === 'assistant.final')!
    await app.store.commitTurnUndo(id, {
      sessionNodeId: final.id, targetTurnIds: [receipt.turnId], promptText: options.content,
      beforeCommit: () => undefined,
    })
    expect(await app.agent.submit(id, options)).toEqual(receipt)
    expect(app.stream).toHaveBeenCalledTimes(1)
    const next = await app.agent.submit(id, { ...options, clientMessageId: 'after-undo' })
    expect(next.turnId).not.toBe(receipt.turnId)
    await vi.waitFor(() => expect(app.agent.isRunning(id)).toBe(false))
    expect(app.stream).toHaveBeenCalledTimes(2)
  })

  it('repairs an unlaunched receipt on retry once transient status publication recovers', async () => {
    const app = await setup()
    const session = await app.store.create()
    const id = session.summary.id
    const append = app.store.append.bind(app.store)
    const failure = vi.spyOn(app.store, 'append').mockImplementation(async (...args) => {
      if (args[1] === 'run.status') throw new Error('temporary status journal outage')
      return await append(...args)
    })
    const options = { content: 'Acknowledge.', clientMessageId: 'status-outage' }
    await expect(app.agent.submit(id, options)).rejects.toThrow('temporary status journal outage')
    failure.mockRestore()
    expect(app.agent.isRunning(id)).toBe(false)
    const receipt = await app.agent.submit(id, options)
    expect(receipt.turnId).toBeTruthy()
    expect(app.stream).not.toHaveBeenCalled()
    expect((await app.store.get(id)).summary.status).toBe('interrupted')
  })

  it('repairs the same unlaunched admission when retrying the atomic create-chat endpoint', async () => {
    const app = await setup()
    const server = createServer(app.app)
    servers.push(server)
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test port')
    const body = {
      message: { id: '018bcfe5-6800-7000-8000-000000000003', role: 'user', parts: [{ type: 'text', text: 'Acknowledge.' }] },
      recaptchaV3Token: null, timezone: 'UTC', modelId: 'test-model',
    }
    const post = () => fetch(`http://127.0.0.1:${address.port}/nextjs-api/stream/create-chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const append = app.store.append.bind(app.store)
    const failure = vi.spyOn(app.store, 'append').mockImplementation(async (...args) => {
      if (args[1] === 'run.status') throw new Error('temporary status journal outage')
      return await append(...args)
    })
    const first = await post()
    expect(first.ok).toBe(false)
    expect(await first.json()).toMatchObject({ error: 'temporary status journal outage' })
    failure.mockRestore()
    const retry = await post()
    const retriedBody = await retry.json() as { id: string }
    expect(retry.status, JSON.stringify(retriedBody)).toBe(200)
    const { id } = retriedBody
    expect(app.stream).not.toHaveBeenCalled()
    expect((await app.store.get(id)).summary.status).toBe('interrupted')
    expect(await readdir(resolve(app.dataRoot, 'sessions'))).toEqual([id])
  })
})
