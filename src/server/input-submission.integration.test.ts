import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'

const roots: string[] = []
const servers: Server[] = []
const agents: Awaited<ReturnType<typeof createApp>>['agent'][] = []
const messageId = '018bcfe5-6800-7000-8000-000000000001'

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))))
  await Promise.all(agents.splice(0).map((agent) => agent.shutdown()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(dataRoot?: string) {
  if (!dataRoot) {
    dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-input-receipts-'))
    roots.push(dataRoot)
  }
  const stream = vi.fn(async () => ({
    content: 'Acknowledged.', reasoningContent: '', toolCalls: [], finishReason: 'stop' as const,
    usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24, cachedPromptTokens: 0 },
  }))
  const created = await createApp({ dataRoot, model: 'test-model', agent: { client: { stream } as never } })
  agents.push(created.agent)
  const server = createServer(created.app)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  const base = `http://127.0.0.1:${address.port}`
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { ...created, stream, dataRoot, post, base }
}

function initial(text = 'Say acknowledged.') {
  return {
    message: { id: messageId, role: 'user', parts: [{ type: 'text', text }] },
    recaptchaV3Token: null, timezone: 'Asia/Shanghai', modelId: 'test-model',
  }
}

async function settled(app: Awaited<ReturnType<typeof setup>>, id: string) {
  await vi.waitFor(() => expect(app.agent.isRunning(id)).toBe(false))
}

describe('durable input admission', () => {
  it('coalesces concurrent create requests, detects conflicting content, and replays after restart', async () => {
    const app = await setup()
    const replies = await Promise.all(Array.from({ length: 5 }, () => app.post('/nextjs-api/stream/create-chat', initial())))
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
    const bodies = await Promise.all(replies.map((r) => r.json()))
    const id = bodies[0].id as string
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1)
    await settled(app, id)
    expect(app.stream).toHaveBeenCalledTimes(1)
    expect(await app.store.list()).toHaveLength(1)
    const conflict = await app.post('/nextjs-api/stream/create-chat', initial('A different task.'))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'input_id_conflict' })

    await app.agent.shutdown()
    const restarted = await setup(app.dataRoot)
    const retry = await restarted.post('/nextjs-api/stream/create-chat', initial())
    expect(await retry.json()).toEqual({ id })
    expect(restarted.stream).not.toHaveBeenCalled()
    expect(await restarted.store.list()).toHaveLength(1)
    expect((await restarted.store.events(id)).filter((event) => event.type === 'turn.started')).toHaveLength(1)
    const publicSnapshot = await (await fetch(`${restarted.base}/api/sessions/${id}`)).json()
    expect(publicSnapshot).not.toHaveProperty('inputReceipts')
    expect(publicSnapshot).not.toHaveProperty('creationInput')
  })

  it('imports CAS uploads once when create-chat acknowledgement is lost', async () => {
    const app = await setup()
    const content = Buffer.from('one durable upload')
    const hash = createHash('sha256').update(content).digest('base64url')
    const signed = await (await app.post('/api/storage/generate-agent-upload-url', {
      hash, contentType: 'text/plain', size: content.length,
    })).json() as { uploadUrl: string; key: string }
    expect((await fetch(`${app.base}${signed.uploadUrl}`, {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: content,
    })).status).toBe(200)
    const body = initial()
    Object.assign(body.message, { metadata: { manifestNodeId: null, uploads: [{
      key: signed.key, filename: 'brief.txt', mediaType: 'text/plain',
    }] } })
    // Deliberately discard the first acknowledgement; the client knows only its input ID.
    await app.post('/nextjs-api/stream/create-chat', body)
    const retry = await app.post('/nextjs-api/stream/create-chat', body)
    const { id } = await retry.json() as { id: string }
    await settled(app, id)
    expect(await readdir(resolve(app.store.workspaceDir(id), 'uploads'))).toEqual(['brief.txt'])
    expect((await app.store.events(id)).filter((event) => event.type === 'file.changed')).toHaveLength(1)
    expect(app.stream).toHaveBeenCalledTimes(1)
  })

  it('deduplicates follow-ups, keeps identities session-scoped, and replays even after attachment removal', async () => {
    const app = await setup()
    const session = await app.store.create()
    const id = session.summary.id
    const uploaded = await app.store.createUpload(id, 'uploads/brief.txt', Buffer.from('data'), 'text/plain')
    const body = { clientMessageId: 'follow-up-1', content: 'Acknowledge.', attachments: [uploaded.path], enabledConnectorSlugs: [] }
    const path = `/api/sessions/${id}/messages`
    const replies = await Promise.all([app.post(path, body), app.post(path, body)])
    expect(replies.map((r) => r.status)).toEqual([202, 202])
    const [a, b] = await Promise.all(replies.map((r) => r.json()))
    expect(a).toEqual(b)
    await settled(app, id)
    await rm(resolve(app.store.workspaceDir(id), uploaded.path))
    expect(await (await app.post(path, body)).json()).toEqual(a)
    for (const changed of [{ content: 'Other.' }, { model: 'other-model' }, { enabledConnectorSlugs: ['github'] }]) {
      expect((await app.post(path, { ...body, ...changed })).status).toBe(409)
    }
    expect(app.stream).toHaveBeenCalledTimes(1)
    const other = await app.store.create()
    expect((await app.post(`/api/sessions/${other.summary.id}/messages`, { ...body, attachments: [] })).status).toBe(202)
    await settled(app, other.summary.id)
    expect(app.stream).toHaveBeenCalledTimes(2)
    await app.agent.shutdown()
    const restarted = await setup(app.dataRoot)
    expect(await (await restarted.post(path, body)).json()).toEqual(a)
    expect(restarted.stream).not.toHaveBeenCalled()
  })

  it.each(['turn.started', 'run.status'] as const)('keeps an accepted input recoverable when publishing %s fails', async (failureType) => {
    const app = await setup()
    const session = await app.store.create()
    const append = app.store.append.bind(app.store)
    let failed = false
    vi.spyOn(app.store, 'append').mockImplementation(async (...args) => {
      if (args[1] === failureType && !failed) { failed = true; throw new Error('injected publication failure') }
      return await append(...args)
    })
    const options = { content: 'Acknowledge.', clientMessageId: 'accepted-before-failure' }
    await expect(app.agent.submit(session.summary.id, options)).rejects.toThrow('injected publication failure')
    const state = await app.store.get(session.summary.id)
    expect(state.summary.status).toBe('interrupted')
    expect(state.pendingStart).toBeUndefined()
    const receipt = state.inputReceipts![options.clientMessageId]
    expect(await app.agent.submit(session.summary.id, options)).toEqual({ turnId: receipt.turnId })
    expect(app.stream).not.toHaveBeenCalled()
    expect((await app.store.events(session.summary.id)).filter((event) => event.type === 'turn.started')).toHaveLength(1)
    await expect(app.store.discardUnpublishedSession(session.summary.id)).rejects.toThrow('input was accepted')
  })

  it('recovers a durable pending start after repeated publication failure without replaying the model', async () => {
    const app = await setup()
    const session = await app.store.create()
    const append = app.store.append.bind(app.store)
    vi.spyOn(app.store, 'append').mockImplementation(async (...args) => {
      if (args[1] === 'turn.started') throw new Error('storage unavailable')
      return await append(...args)
    })
    const options = { content: 'Acknowledge.', clientMessageId: 'pending-start' }
    await expect(app.agent.submit(session.summary.id, options)).rejects.toThrow('storage unavailable')
    const pending = (await app.store.get(session.summary.id)).pendingStart!
    expect(pending.turnId).toBeTruthy()
    vi.restoreAllMocks()
    await app.agent.shutdown()
    const restarted = await setup(app.dataRoot)
    expect((await restarted.store.get(session.summary.id)).summary.status).toBe('interrupted')
    expect(await restarted.agent.submit(session.summary.id, options)).toEqual({ turnId: pending.turnId })
    expect(restarted.stream).not.toHaveBeenCalled()
    expect((await restarted.store.events(session.summary.id)).filter((event) => event.type === 'turn.started')).toHaveLength(1)
  })

  it('rebuilds preparation after interruption before the admission checkpoint', async () => {
    const app = await setup()
    const failedSubmit = vi.spyOn(app.agent, 'submit').mockRejectedValueOnce(new Error('before admission'))
    const failedDiscard = vi.spyOn(app.store, 'discardUnpublishedSession').mockRejectedValueOnce(new Error('process exited'))
    expect((await app.post('/nextjs-api/stream/create-chat', initial())).status).toBe(500)
    expect(await app.store.list()).toHaveLength(1)
    failedSubmit.mockRestore()
    failedDiscard.mockRestore()
    await app.agent.shutdown()
    const restarted = await setup(app.dataRoot)
    const response = await restarted.post('/nextjs-api/stream/create-chat', initial())
    expect(response.status).toBe(200)
    const { id } = await response.json() as { id: string }
    await settled(restarted, id)
    expect(await restarted.store.list()).toHaveLength(1)
    expect(restarted.stream).toHaveBeenCalledTimes(1)
  })

  it('fails closed for damaged private receipts and rejects invalid input IDs', async () => {
    const app = await setup()
    const session = await app.store.create()
    expect((await app.post(`/api/sessions/${session.summary.id}/messages`, { content: 'hello', clientMessageId: '../escape' })).status).toBe(400)
    await app.store.update(session.summary.id, (state) => {
      state.creationInput = { id: messageId, fingerprint: 'damaged' }
    })
    expect((await app.post('/nextjs-api/stream/create-chat', initial())).status).not.toBe(200)
    expect(await readdir(resolve(app.dataRoot, 'sessions'))).toEqual([session.summary.id])
    expect(app.stream).not.toHaveBeenCalled()
  })
})
