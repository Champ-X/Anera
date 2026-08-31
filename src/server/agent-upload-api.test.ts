import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import archiver from 'archiver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_OOXML_UPLOAD_TYPES,
  AGENT_UPLOAD_ALLOWED_MIME_TYPES,
  MAX_AGENT_UPLOAD_BYTES,
} from '../shared/agent-upload-policy.js'
import type { ModelMessage } from '../shared/types.js'
import { createApp } from './app.js'
import type { ToolDefinition } from './tools.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryDataRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-agent-upload-api-'))
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

function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function officeArchive(entries: Record<string, string>): Promise<Buffer> {
  return await new Promise<Buffer>((resolveArchive, reject) => {
    const output = new PassThrough()
    const chunks: Buffer[] = []
    const archive = archiver('zip', { zlib: { level: 1 } })
    output.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    output.on('end', () => resolveArchive(Buffer.concat(chunks)))
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    for (const [entry, content] of Object.entries(entries)) archive.append(content, { name: entry })
    void archive.finalize()
  })
}

async function waitForCompleted(created: Awaited<ReturnType<typeof createApp>>, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await created.store.get(sessionId)).summary.status === 'completed') return
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  throw new Error('Agent turn did not complete')
}

describe('Arena Agent attachment API contract', () => {
  it('persists an allowed upload and rejects an unsupported MIME with exact runtime copy', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create()
    const base = await listen(created.app)
    try {
      const accepted = await postJson(base, `/api/sessions/${session.summary.id}/files`, {
        name: 'evidence.txt', mime: 'text/plain', contentBase64: Buffer.from('ok').toString('base64'),
      })
      expect(accepted.status).toBe(201)
      expect(await accepted.json()).toEqual({ path: 'uploads/evidence.txt', bytes: 2, mime: 'text/plain' })

      const rejected = await postJson(base, `/api/sessions/${session.summary.id}/files`, {
        name: 'input.zip',
        mime: 'application/zip',
        contentBase64: Buffer.from('not-supported').toString('base64'),
      })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({
        error: `input.zip is not a supported file type. Allowed: ${AGENT_UPLOAD_ALLOWED_MIME_TYPES.join(', ')}.`,
      })
      expect((await created.store.events(session.summary.id)).filter((event) => event.type === 'file.changed')).toMatchObject([
        { data: { path: 'uploads/evidence.txt', bytes: 2, operation: 'uploaded', mime: 'text/plain' } },
      ])
    } finally {
      await created.agent.shutdown()
    }
  })

  it('accepts and persists valid DOCX, XLSX, and PPTX archives', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create()
    const base = await listen(created.app)
    try {
      const fixtures = [
        {
          type: AGENT_OOXML_UPLOAD_TYPES[0],
          content: await officeArchive({
            'word/document.xml': '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>DOCX marker</w:t></w:r></w:p></w:body></w:document>',
          }),
        },
        {
          type: AGENT_OOXML_UPLOAD_TYPES[1],
          content: await officeArchive({
            'xl/workbook.xml': '<workbook xmlns="urn:test"><sheets/></workbook>',
          }),
        },
        {
          type: AGENT_OOXML_UPLOAD_TYPES[2],
          content: await officeArchive({
            'ppt/presentation.xml': '<p:presentation xmlns:p="urn:test"><p:sldIdLst/></p:presentation>',
          }),
        },
      ]

      for (const fixture of fixtures) {
        const name = `valid${fixture.type.extension}`
        const response = await postJson(base, `/api/sessions/${session.summary.id}/files`, {
          name,
          mime: fixture.type.mime,
          contentBase64: fixture.content.toString('base64'),
        })
        expect(response.status).toBe(201)
        expect(await response.json()).toEqual({
          path: `uploads/${name}`,
          bytes: fixture.content.length,
          mime: fixture.type.mime,
        })
        expect(await readFile(resolve(created.store.workspaceDir(session.summary.id), 'uploads', name)))
          .toEqual(fixture.content)
      }

      expect((await created.store.events(session.summary.id)).filter((event) => event.type === 'file.changed'))
        .toHaveLength(3)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('rejects non-ZIP, fake ZIP, wrong-family, and MIME/extension-spoofed Office uploads before publication', async () => {
    const created = await createApp({ dataRoot: await temporaryDataRoot(), model: 'test-model' })
    const session = await created.store.create()
    const base = await listen(created.app)
    try {
      const docx = AGENT_OOXML_UPLOAD_TYPES[0]
      const validDocx = await officeArchive({ 'word/document.xml': '<w:document xmlns:w="urn:test" />' })
      const wrongFamily = await officeArchive({ 'xl/workbook.xml': '<workbook xmlns="urn:test" />' })
      const cases = [
        {
          name: 'plain.docx', mime: docx.mime, content: Buffer.from('not a ZIP archive'),
          error: 'DOCX upload is invalid: the file does not begin with ZIP magic.',
        },
        {
          name: 'fake.docx', mime: docx.mime, content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
          error: 'DOCX upload is invalid: the ZIP end-of-central-directory record is missing.',
        },
        {
          name: 'wrong-family.docx', mime: docx.mime, content: wrongFamily,
          error: 'DOCX upload is invalid: the archive must contain exactly one word/document.xml entry.',
        },
        {
          name: 'mismatch.xlsx', mime: docx.mime, content: validDocx,
          error: `mismatch.xlsx has an invalid Office file type. XLSX uploads require the .xlsx extension and ${AGENT_OOXML_UPLOAD_TYPES[1].mime} MIME type.`,
        },
      ]

      for (const fixture of cases) {
        const response = await postJson(base, `/api/sessions/${session.summary.id}/files`, {
          name: fixture.name,
          mime: fixture.mime,
          contentBase64: fixture.content.toString('base64'),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: fixture.error })
        await expect(readFile(resolve(created.store.workspaceDir(session.summary.id), 'uploads', fixture.name)))
          .rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect((await created.store.events(session.summary.id)).filter((event) => event.type === 'file.changed'))
        .toHaveLength(0)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('routes a valid uploaded DOCX through the real extract_attachment tool on the next message', async () => {
    const marker = 'OFFICE-UPLOAD-ROUTING-MARKER-731'
    let modelCall = 0
    const stream = vi.fn(async (options: {
      messages: ModelMessage[]
      tools: ToolDefinition[]
      onContent: (delta: string) => void
    }) => {
      modelCall += 1
      if (modelCall === 1) {
        expect(options.tools.map((tool) => tool.function.name)).toContain('extract_attachment')
        expect(options.messages.at(-1)?.content).toContain('uploads/routing.docx')
        return {
          content: '', reasoningContent: '', finishReason: 'tool_calls' as const,
          toolCalls: [{
            id: 'call_extract_uploaded_docx',
            type: 'function' as const,
            function: { name: 'extract_attachment', arguments: '{"path":"uploads/routing.docx"}' },
          }],
          usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24, cachedPromptTokens: 0 },
        }
      }
      const result = options.messages.find((message) => (
        message.role === 'tool' && message.tool_call_id === 'call_extract_uploaded_docx'
      ))
      expect(result).toMatchObject({ role: 'tool', tool_result_status: 'succeeded' })
      expect(result?.content).toContain(marker)
      options.onContent('The marker was extracted successfully.')
      return {
        content: 'The marker was extracted successfully.', reasoningContent: '',
        finishReason: 'stop' as const, toolCalls: [],
        usage: { promptTokens: 24, completionTokens: 6, totalTokens: 30, cachedPromptTokens: 0 },
      }
    })
    const created = await createApp({
      dataRoot: await temporaryDataRoot(),
      model: 'test-model',
      agent: { client: { stream } as never, runTimeoutMs: 2_000 },
    })
    const session = await created.store.create()
    const base = await listen(created.app)
    try {
      const docx = await officeArchive({
        'word/document.xml': `<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>${marker}</w:t></w:r></w:p></w:body></w:document>`,
      })
      const upload = await postJson(base, `/api/sessions/${session.summary.id}/files`, {
        name: 'routing.docx',
        mime: AGENT_OOXML_UPLOAD_TYPES[0].mime,
        contentBase64: docx.toString('base64'),
      })
      expect(upload.status).toBe(201)

      const message = await postJson(base, `/api/sessions/${session.summary.id}/messages`, {
        content: 'What is the marker?', attachments: ['uploads/routing.docx'], model: null,
      })
      expect(message.status).toBe(202)
      await waitForCompleted(created, session.summary.id)

      expect(stream).toHaveBeenCalledTimes(2)
      expect((await created.store.events(session.summary.id)).filter((event) => (
        event.type === 'tool.completed' && event.callId === 'call_extract_uploaded_docx'
      ))).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            call: expect.objectContaining({ name: 'extract_attachment' }),
            isError: false,
            result: expect.stringContaining(marker),
          }),
        }),
      ])
    } finally {
      await created.agent.shutdown()
    }
  })

  it('enforces the 50 MiB message total before creating a turn or calling the model', async () => {
    const stream = vi.fn()
    const created = await createApp({
      dataRoot: await temporaryDataRoot(),
      model: 'test-model',
      agent: { client: { stream } as never },
    })
    const session = await created.store.create()
    const uploads = resolve(created.store.workspaceDir(session.summary.id), 'uploads')
    await mkdir(uploads, { recursive: true })
    const files = [
      { path: 'uploads/first.txt', size: MAX_AGENT_UPLOAD_BYTES },
      { path: 'uploads/second.txt', size: MAX_AGENT_UPLOAD_BYTES },
      { path: 'uploads/over.txt', size: 1 },
    ]
    for (const file of files) {
      const target = resolve(created.store.workspaceDir(session.summary.id), file.path)
      await writeFile(target, '')
      await truncate(target, file.size)
      await created.store.append(session.summary.id, 'file.changed', {
        path: file.path, bytes: file.size, operation: 'uploaded', mime: 'text/plain',
      })
    }
    const base = await listen(created.app)
    try {
      const response = await postJson(base, `/api/sessions/${session.summary.id}/messages`, {
        content: 'Inspect these files.', attachments: files.map((file) => file.path), model: null,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'Adding over.txt would exceed the 50 MB total upload limit for this message.',
      })
      expect(stream).not.toHaveBeenCalled()
      expect((await created.store.events(session.summary.id)).filter((event) => event.type === 'turn.started')).toHaveLength(0)
    } finally {
      await created.agent.shutdown()
    }
  })

  it('rechecks durable upload identity and per-file size when a message is submitted', async () => {
    const stream = vi.fn()
    const created = await createApp({
      dataRoot: await temporaryDataRoot(),
      model: 'test-model',
      agent: { client: { stream } as never },
    })
    const session = await created.store.create()
    const uploads = resolve(created.store.workspaceDir(session.summary.id), 'uploads')
    await mkdir(uploads, { recursive: true })
    const expandedPath = resolve(uploads, 'expanded.txt')
    await writeFile(expandedPath, '')
    await truncate(expandedPath, MAX_AGENT_UPLOAD_BYTES + 1)
    await created.store.append(session.summary.id, 'file.changed', {
      path: 'uploads/expanded.txt', bytes: 1, operation: 'uploaded', mime: 'text/plain',
    })
    await writeFile(resolve(created.store.workspaceDir(session.summary.id), 'unregistered.txt'), 'not an upload')
    const base = await listen(created.app)
    try {
      const expanded = await postJson(base, `/api/sessions/${session.summary.id}/messages`, {
        content: 'Inspect it.', attachments: ['uploads/expanded.txt'], model: null,
      })
      expect(expanded.status).toBe(400)
      expect(await expanded.json()).toEqual({ error: 'expanded.txt exceeds the 25 MB per-file upload limit.' })

      const unregistered = await postJson(base, `/api/sessions/${session.summary.id}/messages`, {
        content: 'Inspect it.', attachments: ['unregistered.txt'], model: null,
      })
      expect(unregistered.status).toBe(400)
      expect(await unregistered.json()).toEqual({ error: 'Attachment not found: unregistered.txt' })
      expect(stream).not.toHaveBeenCalled()
    } finally {
      await created.agent.shutdown()
    }
  })
})
