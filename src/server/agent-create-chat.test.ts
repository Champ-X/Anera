import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_OOXML_UPLOAD_TYPES } from '../shared/agent-upload-policy.js'
import { createApp } from './app.js'

const roots: string[] = []
const servers: Server[] = []
const agents: Array<{ shutdown(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }))
  await Promise.all(agents.splice(0).map((agent) => agent.shutdown()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryDataRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-create-chat-'))
  roots.push(root)
  return resolve(root, 'data')
}

async function listen(app: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function createTestApp() {
  const stream = vi.fn(async (options: { onContent: (delta: string) => void }) => {
    options.onContent('Created atomically.')
    return {
      content: 'Created atomically.',
      reasoningContent: '',
      toolCalls: [],
      finishReason: 'stop' as const,
      usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24, cachedPromptTokens: 0 },
    }
  })
  const created = await createApp({
    dataRoot: await temporaryDataRoot(),
    model: 'test-model',
    agent: { client: { stream } as never, runTimeoutMs: 1_000 },
  })
  agents.push(created.agent)
  return { ...created, stream }
}

function messageId(suffix = '000000000001'): string {
  return `018bcfe5-6800-7000-8000-${suffix}`
}

function createEnvelope(
  parts: unknown[],
  metadata?: unknown,
  modelId: string | undefined = 'test-model',
) {
  return {
    message: {
      id: messageId(),
      role: 'user',
      parts,
      ...(metadata === undefined ? {} : { metadata }),
    },
    recaptchaV3Token: null,
    timezone: 'Asia/Shanghai',
    ...(modelId ? { modelId } : {}),
  }
}

async function postJson(base: string, path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function waitForCompleted(created: Awaited<ReturnType<typeof createTestApp>>, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await created.store.get(sessionId)).summary.status === 'completed') return
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  throw new Error('Agent turn did not complete')
}

describe('Arena current atomic create-chat transport', () => {
  it('preserves a manual title when the first message starts while still naming untitled sessions', async () => {
    const created = await createTestApp()
    const named = await created.store.create()
    await created.store.updateMetadata(named.summary.id, { title: 'My saved conversation name' })
    await created.agent.submit(named.summary.id, { content: 'Hello from the first message' })
    await waitForCompleted(created, named.summary.id)
    expect((await created.store.get(named.summary.id)).summary.title).toBe('My saved conversation name')

    const automatic = await created.store.create()
    await created.agent.submit(automatic.summary.id, { content: 'Hello from the first message' })
    await waitForCompleted(created, automatic.summary.id)
    expect((await created.store.get(automatic.summary.id)).summary.title).toBe('Hello from the first message')
  })

  it('creates and starts exactly one Session from the current first-message envelope', async () => {
    const created = await createTestApp()
    const base = await listen(created.app)
    const response = await postJson(base, '/nextjs-api/stream/create-chat', createEnvelope([
      { type: 'text', text: 'Start the task.' },
    ]))

    expect(response.status).toBe(200)
    const body = await response.json() as { id: string }
    expect(body.id).toMatch(/^ses_[a-z0-9]{20}$/)
    expect((await created.store.list()).map((session) => session.id)).toEqual([body.id])
    await waitForCompleted(created, body.id)
    const turn = (await created.store.events(body.id)).find((event) => event.type === 'turn.started')
    expect(turn).toMatchObject({
      data: {
        content: 'Start the task.',
        attachments: [],
        clientMessageId: messageId(),
        model: 'test-model',
      },
    })
    expect(created.stream).toHaveBeenCalledTimes(1)
  })

  it('uses signed binary upload plus CAS projection before atomically importing attachments', async () => {
    const created = await createTestApp()
    const base = await listen(created.app)
    const content = Buffer.from('SIGNED-CAS-EVIDENCE-731\n')
    const hash = createHash('sha256').update(content).digest('base64url')

    const signedResponse = await postJson(base, '/api/storage/generate-agent-upload-url', {
      hash,
      contentType: 'text/plain',
      size: content.length,
    })
    expect(signedResponse.status).toBe(200)
    const signed = await signedResponse.json() as { uploadUrl: string; key: string }
    expect(signed.key).toMatch(new RegExp(`^cas/users/[0-9a-f-]{36}/${hash}$`))
    const put = await fetch(`${base}${signed.uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: content,
    })
    expect(put.status).toBe(200)
    const cas = await fetch(`${base}/api/chat/workspace/cas/user/${hash}`)
    expect(cas.status).toBe(200)
    expect(Buffer.from(await cas.arrayBuffer())).toEqual(content)

    const create = await postJson(base, '/nextjs-api/stream/create-chat', createEnvelope(
      [{ type: 'text', text: 'Read the attachment.' }],
      {
        manifestNodeId: null,
        uploads: [{ key: signed.key, filename: 'evidence.txt', mediaType: 'text/plain' }],
      },
    ))
    expect(create.status).toBe(200)
    const { id } = await create.json() as { id: string }
    await waitForCompleted(created, id)
    const turn = (await created.store.events(id)).find((event) => event.type === 'turn.started')
    const attachment = (turn?.data as { attachments?: string[] } | undefined)?.attachments?.[0]
    expect(attachment).toBe('uploads/evidence.txt')
    expect(await readFile(resolve(created.store.workspaceDir(id), attachment!))).toEqual(content)
  })

  it('rejects fake Office bytes at signed PUT before they become readable from CAS', async () => {
    const created = await createTestApp()
    const base = await listen(created.app)
    const content = Buffer.from('not an OOXML ZIP archive')
    const hash = createHash('sha256').update(content).digest('base64url')
    const docx = AGENT_OOXML_UPLOAD_TYPES[0]

    const signedResponse = await postJson(base, '/api/storage/generate-agent-upload-url', {
      hash,
      contentType: docx.mime,
      size: content.length,
    })
    expect(signedResponse.status).toBe(200)
    const signed = await signedResponse.json() as { uploadUrl: string; key: string }

    const put = await fetch(`${base}${signed.uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': docx.mime },
      body: content,
    })
    expect(put.status).toBe(400)
    expect(await put.json()).toEqual({
      error: 'DOCX upload is invalid: the file does not begin with ZIP magic.',
    })

    const cas = await fetch(`${base}/api/chat/workspace/cas/user/${hash}`)
    expect(cas.status).toBe(404)
  })

  it('rejects malformed/cross-origin requests before creation and rolls back submit rejection', async () => {
    const created = await createTestApp()
    const base = await listen(created.app)

    const malformed = await postJson(base, '/nextjs-api/stream/create-chat', {
      ...createEnvelope([{ type: 'text', text: 'Invalid role.' }]),
      message: { id: messageId(), role: 'assistant', parts: [{ type: 'text', text: 'Invalid role.' }] },
    })
    expect(malformed.status).toBe(400)

    const crossOrigin = await postJson(
      base,
      '/nextjs-api/stream/create-chat',
      createEnvelope([{ type: 'text', text: 'Cross origin.' }]),
      { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
    )
    expect(crossOrigin.status).toBe(403)

    const unavailableModel = await postJson(base, '/nextjs-api/stream/create-chat', createEnvelope(
      [{ type: 'text', text: 'Unavailable model.' }],
      undefined,
      'not-a-model',
    ))
    expect(unavailableModel.status).toBe(400)
    expect(await created.store.list()).toEqual([])
    expect(created.stream).not.toHaveBeenCalled()
  })
})
