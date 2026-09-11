import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createApp } from './app.js'
import { DeepSeekClient } from './deepseek.js'

it('routes create, follow-up and resume through HTTP, durable state and the provider request body', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-model-selection-'))
  const routed: string[] = []
  const client = new DeepSeekClient({
    apiKey: 'synthetic', baseUrl: 'https://provider.invalid', model: 'default-must-not-win',
    maxOutputTokens: 256,
    fetch: async (_url, init) => {
      routed.push(JSON.parse(String(init?.body)).model)
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const created = await createApp({ dataRoot: root, model: 'deepseek-flash',
    agent: { client, models: ['deepseek-flash', 'deepseek-v4-pro'], runTimeoutMs: 5_000 } })
  const server = createServer(created.app)
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  const base = `http://127.0.0.1:${address.port}`
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const completed = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      if ((await created.store.get(id)).summary.status === 'completed') return
      await new Promise((ready) => setTimeout(ready, 10))
    }
    throw new Error('Fixture turn did not complete')
  }
  try {
    const response = await post('/nextjs-api/stream/create-chat', {
      message: { id: '018bcfe5-6800-7000-8000-000000000001', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      recaptchaV3Token: null, timezone: 'Asia/Shanghai', modelId: 'deepseek-v4-pro',
    })
    expect(response.status).toBe(200)
    const { id } = await response.json() as { id: string }
    await completed(id)
    const path = `/api/sessions/${id}`
    expect((await (await fetch(`${base}${path}`)).json()).session)
      .toMatchObject({ model: 'deepseek-v4-pro', modelSelection: 'deepseek-v4-pro' })
    const followup = await post(`${path}/messages`, {
      message: { text: 'Hello again' }, model: 'deepseek-flash',
      metadata: { timezone: 'Asia/Shanghai', submissionSource: 'chat_input' }, v2Source: 'agentic_chat_submit',
    })
    expect(followup.status, await followup.text()).toBe(202)
    await completed(id)
    // Simulate a saved interrupted task; no production sessions are modified.
    await created.store.update(id, (state) => { state.summary.status = 'interrupted' })
    const before = await created.store.get(id)
    expect((await post(`${path}/resume`, { model: 123 })).status).toBe(400)
    expect((await post(`${path}/resume`, { model: 'unavailable' })).status).toBeGreaterThanOrEqual(400)
    expect(await created.store.get(id)).toEqual(before)
    expect(routed).toEqual(['deepseek-v4-pro', 'deepseek-flash'])
    expect((await post(`${path}/resume`, { model: 'deepseek-v4-pro' })).status).toBe(202)
    await completed(id)
    expect((await created.store.get(id)).summary)
      .toMatchObject({ model: 'deepseek-v4-pro', modelSelection: 'deepseek-v4-pro' })
    expect(JSON.parse(await readFile(resolve(created.store.sessionDir(id), 'state.json'), 'utf8')).summary)
      .toMatchObject({ model: 'deepseek-v4-pro', modelSelection: 'deepseek-v4-pro' })
    expect((await created.store.events(id)).findLast((event) => event.type === 'run.resumed')?.data)
      .toMatchObject({ model: 'deepseek-v4-pro', modelSelection: 'deepseek-v4-pro' })
    await created.store.update(id, (state) => { state.summary.status = 'interrupted' })
    expect((await post(`${path}/resume`, {})).status).toBe(202)
    await completed(id)
    expect(routed).toEqual(['deepseek-v4-pro', 'deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-pro'])
  } finally {
    await created.agent.shutdown()
    await new Promise<void>((closed) => server.close(() => closed()))
    await rm(root, { recursive: true, force: true })
  }
})
