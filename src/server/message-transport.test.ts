import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryDataRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-message-transport-'))
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

function response(content = 'Done.') {
  return {
    content,
    reasoningContent: '',
    toolCalls: [],
    finishReason: 'stop' as const,
    usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24, cachedPromptTokens: 0 },
  }
}

async function createTestApp() {
  const stream = vi.fn(async (options: { onContent: (delta: string) => void }) => {
    options.onContent('Done.')
    return response()
  })
  const created = await createApp({
    dataRoot: await temporaryDataRoot(),
    model: 'test-model',
    agent: { client: { stream } as never, runTimeoutMs: 1_000 },
  })
  return { ...created, stream }
}

async function postMessage(base: string, sessionId: string, body: unknown): Promise<Response> {
  return await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function envelope(message: unknown) {
  return {
    message,
    metadata: { timezone: 'Asia/Shanghai', submissionSource: 'chat_input' },
    v2Source: 'agentic_chat_submit',
    model: null,
    enabledConnectorSlugs: [],
  }
}

async function waitForCompleted(created: Awaited<ReturnType<typeof createApp>>, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await created.store.get(sessionId)).summary.status === 'completed') return
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  throw new Error('Agent turn did not complete')
}

describe('Arena ordinary message envelope', () => {
  it('accepts the simple text branch and persists only the visible text', async () => {
    const created = await createTestApp()
    const session = await created.store.create()
    const base = await listen(created.app)
    try {
      const result = await postMessage(base, session.summary.id, envelope({ text: 'A trimmed request.' }))
      expect(result.status).toBe(202)
      await waitForCompleted(created, session.summary.id)
      expect((await created.store.events(session.summary.id)).find((event) => event.type === 'turn.started')).toMatchObject({
        data: { content: 'A trimmed request.', attachments: [] },
      })
      expect(created.stream).toHaveBeenCalledTimes(1)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('accepts non-image attachment-only submissions as an empty text part plus upload metadata', async () => {
    const created = await createTestApp()
    const session = await created.store.create()
    const upload = await created.store.createUpload(session.summary.id, 'uploads/brief.txt', Buffer.from('brief'), 'text/plain')
    const base = await listen(created.app)
    try {
      const result = await postMessage(base, session.summary.id, envelope({
        parts: [{ type: 'text', text: '' }],
        metadata: {
          manifestNodeId: null,
          uploads: [{ key: upload.path, filename: 'brief.txt', mediaType: 'text/plain' }],
        },
      }))
      expect(result.status).toBe(202)
      await waitForCompleted(created, session.summary.id)
      expect((await created.store.events(session.summary.id)).find((event) => event.type === 'turn.started')).toMatchObject({
        data: { content: '', attachments: [upload.path] },
      })
    } finally {
      await created.agent.shutdown()
    }
  })

  it('accepts image-only submissions only when file parts exactly match upload metadata', async () => {
    const created = await createTestApp()
    const session = await created.store.create()
    const upload = await created.store.createUpload(session.summary.id, 'uploads/reference.png', Buffer.from('png'), 'image/png')
    const base = await listen(created.app)
    const file = {
      type: 'file',
      url: `/api/sessions/${session.summary.id}/download?path=${encodeURIComponent(upload.path)}`,
      mediaType: 'image/png',
      filename: 'reference.png',
    }
    const metadata = {
      manifestNodeId: null,
      uploads: [{ key: upload.path, filename: 'reference.png', mediaType: 'image/png' }],
    }
    try {
      const mismatch = await postMessage(base, session.summary.id, envelope({
        parts: [{ ...file, url: '/forged-image-url' }],
        metadata,
      }))
      expect(mismatch.status).toBe(400)
      expect(await mismatch.json()).toEqual({ error: 'file parts must exactly match the image uploads' })

      const result = await postMessage(base, session.summary.id, envelope({ parts: [file], metadata }))
      expect(result.status).toBe(202)
      await waitForCompleted(created, session.summary.id)
      expect((await created.store.events(session.summary.id)).find((event) => event.type === 'turn.started')).toMatchObject({
        data: { content: '', attachments: [upload.path] },
      })
    } finally {
      await created.agent.shutdown()
    }
  })

  it('rejects untrimmed text, misplaced files, duplicate uploads, and parts without an Arena branch trigger', async () => {
    const created = await createTestApp()
    const session = await created.store.create()
    const upload = await created.store.createUpload(session.summary.id, 'uploads/reference.png', Buffer.from('png'), 'image/png')
    const base = await listen(created.app)
    const descriptor = { key: upload.path, filename: 'reference.png', mediaType: 'image/png' }
    const file = {
      type: 'file',
      url: `/api/sessions/${session.summary.id}/download?path=${encodeURIComponent(upload.path)}`,
      mediaType: 'image/png',
      filename: 'reference.png',
    }
    const probes: Array<{ body: unknown; error: string }> = [
      { body: envelope({ text: ' untrimmed ' }), error: 'message.text must be trimmed' },
      {
        body: envelope({
          parts: [{ type: 'text', text: 'Text first.' }, file],
          metadata: { manifestNodeId: null, uploads: [descriptor] },
        }),
        error: 'file parts must follow custom feedback and precede text',
      },
      {
        body: envelope({
          parts: [file],
          metadata: { manifestNodeId: null, uploads: [descriptor, descriptor] },
        }),
        error: 'Upload descriptor keys must be unique',
      },
      {
        body: envelope({ parts: [{ type: 'text', text: 'Use the simple branch.' }] }),
        error: 'A parts message requires uploads or custom feedback',
      },
    ]
    try {
      for (const probe of probes) {
        const result = await postMessage(base, session.summary.id, probe.body)
        expect(result.status).toBe(400)
        expect(await result.json()).toEqual({ error: probe.error })
      }
      expect((await created.store.events(session.summary.id)).some((event) => event.type === 'turn.started')).toBe(false)
    } finally {
      await created.agent.shutdown()
    }
  })
})
