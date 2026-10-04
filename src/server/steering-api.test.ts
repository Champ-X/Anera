import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import type { DeepSeekClient } from './deepseek.js'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) })))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const modelResult = (content: string) => ({ content, reasoningContent: '', finishReason: 'stop', toolCalls: [],
  usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cachedPromptTokens: 0 }, modelCallCount: 1 })
async function fixture(stream?: DeepSeekClient['stream']) {
  const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-steering-api-'))
  roots.push(dataRoot)
  const created = await createApp({ dataRoot, model: 'offline-model', agent: { verificationMode: 'legacy',
    client: { stream: stream ?? (async () => modelResult('Done.')) } as never } })
  const server = createServer(created.app)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback test address')
  const base = `http://127.0.0.1:${address.port}`
  const id = (await created.store.create()).summary.id
  return { ...created, base, id }
}
const post = (base: string, path: string, body: unknown = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
async function waitUntil(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (await condition()) return; await new Promise((done) => setTimeout(done, 5)) }
  throw new Error('Fixture state did not settle')
}

describe('running instruction HTTP contract', () => {
  it('returns durable received/applied receipts, restores them in snapshots, and reports typed conflicts', async () => {
    const created = await fixture()
    const { store, agent, id, base } = created
    try {
      await store.update(id, (state) => { state.summary.status = 'running'; state.messages.push({ role: 'user', content: 'An active task' }) })
      await store.append(id, 'turn.started', { content: 'An active task' }, { turnId: 'turn_active' })
      const path = `/api/sessions/${id}/steering`
      const response = await post(base, path, { content: 'Use the supplied evidence.', clientMessageId: 'same-request' })
      expect(response.status).toBe(202)
      const { steering } = await response.json()
      expect(steering).toMatchObject({ status: 'received', sequence: 1, receivedTurnId: 'turn_active' })
      expect(steering.receivedEventId).toBeUndefined()
      await store.applyPendingSteering(id, 'turn_active', 'step_next')
      const snapshot = await (await fetch(`${base}/api/sessions/${id}`)).json()
      expect(snapshot.steering).toEqual([expect.objectContaining({ id: steering.id, status: 'applied' })])
      expect(snapshot.events.filter((event: { type: string }) => event.type.startsWith('user.steering.')).map((event: { data: { status: string } }) => event.data.status))
        .toEqual(['received', 'applied'])
      const duplicate = await post(base, path, { content: 'Use the supplied evidence.', clientMessageId: 'same-request' })
      expect((await duplicate.json()).steering).toMatchObject({ id: steering.id, status: 'applied' })
      const malformed = await post(base, path, { content: ' ', clientMessageId: 'invalid' })
      expect(malformed.status).toBe(400)
      await store.setStatus(id, 'completed')
      const inactive = await post(base, path, { content: 'Late correction', clientMessageId: 'late' })
      expect(inactive.status).toBe(409)
      expect(await inactive.json()).toMatchObject({ code: 'steering_session_not_active' })
    } finally { await agent.shutdown() }
  })

  it('retains received input across actual cancellation and applies it exactly once on HTTP resume', async () => {
    let started = false
    let requests = 0
    const stream: DeepSeekClient['stream'] = async (options) => {
      await options.beforeRequest?.()
      requests++
      if (requests === 1) {
        started = true
        return await new Promise<never>((_resolve, reject) => {
          const aborted = () => reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'))
          if (options.signal.aborted) aborted()
          else options.signal.addEventListener('abort', aborted, { once: true })
        })
      }
      expect(options.messages.filter((message) => message.role === 'user'
        && message.content?.startsWith('[Harness user steering:') && message.content.includes('Answer in Spanish.'))).toHaveLength(1)
      return modelResult('Hecho.')
    }
    const { store, agent, base, id } = await fixture(stream)
    try {
      expect((await post(base, `/api/sessions/${id}/messages`, { content: 'Provide a brief response.' })).status).toBe(202)
      await waitUntil(() => started)
      const input = { content: 'Answer in Spanish.', clientMessageId: 'spanish' }
      expect((await post(base, `/api/sessions/${id}/steering`, input)).status).toBe(202)
      expect((await post(base, `/api/sessions/${id}/stop`)).status).toBe(202)
      await waitUntil(() => !agent.isRunning(id))
      expect((await store.get(id)).summary.status).toBe('cancelled')
      expect((await store.get(id)).steering?.[0].status).toBe('received')
      expect((await post(base, `/api/sessions/${id}/resume`)).status).toBe(202)
      await waitUntil(() => !agent.isRunning(id))
      const state = await store.get(id)
      expect(state.summary.status, JSON.stringify((await store.events(id)).filter((event) => event.type === 'error'))).toBe('completed')
      expect(state.steering?.[0].status).toBe('applied')
      expect((await (await post(base, `/api/sessions/${id}/steering`, input)).json()).steering.status).toBe('applied')
      expect((await store.events(id)).filter((event) => event.type === 'user.steering.applied')).toHaveLength(1)
      expect((await store.events(id)).filter((event) => event.type === 'assistant.final').map((event) => event.data.content)).toEqual(['Hecho.'])
    } finally { await agent.shutdown() }
  })
})
