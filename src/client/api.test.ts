import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ANERA_DEV_PROXY, ANERA_DEV_PROXY_TARGET } from '../shared/dev-proxy'
import { api, generateUuidV7, type AgentMessageAttachment } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function captureRequests() {
  const requests: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      init,
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
    })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return requests
}

describe('Vite development proxy', () => {
  it('forwards every backend-owned route family to the Agent server', () => {
    expect(ANERA_DEV_PROXY).toEqual({
      '/api': { target: ANERA_DEV_PROXY_TARGET, changeOrigin: false },
      '/nextjs-api': { target: ANERA_DEV_PROXY_TARGET, changeOrigin: false },
      '/workspace': { target: ANERA_DEV_PROXY_TARGET, changeOrigin: false },
    })
  })
})

describe('Arena-shaped desktop message transport', () => {
  it('carries explicit models on follow-up and resume, preserving model-less resume compatibility', async () => {
    const requests = captureRequests()
    await api.send('ses_model', 'Follow up', [], 'deepseek-v4-pro', [])
    await api.resume('ses_model', 'deepseek-flash')
    await api.resume('ses_model')
    expect(requests.map(({ body }) => body.model)).toEqual(['deepseek-v4-pro', 'deepseek-flash', undefined])
    expect(requests[1]?.url).toBe('/api/sessions/ses_model/resume')
    expect(requests[2]?.body).toEqual({})
  })
  it('identifies the failed method and route when a proxy returns no JSON error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))

    await expect(api.createAgentChat('Diagnose routing.', [], 'deepseek-chat', []))
      .rejects.toThrow('POST /nextjs-api/stream/create-chat failed (404)')
  })

  it('uses Arena current create-chat envelope for an atomic first submission', async () => {
    const requests = captureRequests()
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

    await api.createAgentChat('  Inspect the image.  ', [{
      path: 'cas/users/00000000-0000-4000-8000-000000000000/hash',
      name: 'reference.png',
      mime: 'image/png',
      url: '/api/chat/workspace/cas/user/hash',
    }], 'deepseek-chat', [])

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/nextjs-api/stream/create-chat')
    expect(requests[0]?.init).toEqual(expect.objectContaining({ method: 'POST' }))
    expect(requests[0]?.body).toEqual({
      message: {
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        role: 'user',
        parts: [
          {
            type: 'file',
            url: '/api/chat/workspace/cas/user/hash',
            mediaType: 'image/png',
            filename: 'reference.png',
          },
          { type: 'text', text: 'Inspect the image.' },
        ],
        metadata: {
          manifestNodeId: null,
          uploads: [{
            key: 'cas/users/00000000-0000-4000-8000-000000000000/hash',
            filename: 'reference.png',
            mediaType: 'image/png',
          }],
        },
      },
      recaptchaV3Token: null,
      timezone,
      modelId: 'deepseek-chat',
    })
  })

  it('generates a valid timestamped UUIDv7 for the first user message', () => {
    const id = generateUuidV7(1_700_000_000_000)
    expect(id).toMatch(/^018bcfe5-6800-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('uses the simple text branch, trims the Composer value, and includes the public submit envelope', async () => {
    const requests = captureRequests()
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

    await api.send('ses_text', '  First line\nSecond line  ', [], null, [])

    expect(requests).toEqual([{
      url: '/api/sessions/ses_text/messages',
      init: expect.objectContaining({ method: 'POST' }),
      body: {
        message: { text: 'First line\nSecond line' },
        metadata: { timezone, submissionSource: 'chat_input' },
        v2Source: 'agentic_chat_submit',
        model: null,
        enabledConnectorSlugs: [],
      },
    }])
  })

  it('puts every upload in metadata, only images in file parts, and keeps text last', async () => {
    const requests = captureRequests()
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const attachments: AgentMessageAttachment[] = [
      { path: 'uploads/brief.txt', name: 'brief.txt', mime: 'text/plain' },
      { path: 'uploads/reference.png', name: 'reference.png', mime: 'image/png' },
    ]

    await api.send('ses_uploads', '  Inspect both files.  ', attachments, 'deepseek-chat', ['github'])

    expect(requests[0]?.body).toEqual({
      message: {
        parts: [
          {
            type: 'file',
            url: '/api/sessions/ses_uploads/download?path=uploads%2Freference.png',
            mediaType: 'image/png',
            filename: 'reference.png',
          },
          { type: 'text', text: 'Inspect both files.' },
        ],
        metadata: {
          manifestNodeId: null,
          uploads: [
            { key: 'uploads/brief.txt', filename: 'brief.txt', mediaType: 'text/plain' },
            { key: 'uploads/reference.png', filename: 'reference.png', mediaType: 'image/png' },
          ],
        },
      },
      metadata: { timezone, submissionSource: 'chat_input' },
      v2Source: 'agentic_chat_submit',
      model: 'deepseek-chat',
      enabledConnectorSlugs: ['github'],
    })
  })

  it('orders feedback before image files and omits an empty text part for an image-only turn', async () => {
    const requests = captureRequests()
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

    await api.send(
      'ses_feedback_image',
      '   ',
      [{ path: 'uploads/fix.png', name: 'fix.png', mime: 'image/png' }],
      null,
      [],
      'evt_reviewed',
    )

    expect(requests[0]?.body).toEqual({
      message: {
        parts: [
          {
            type: 'data-custom-feedback',
            data: {
              systemMessage: 'The next message part will be the user providing feedback about the previous message.',
              reviewedNodeId: 'evt_reviewed',
            },
          },
          {
            type: 'file',
            url: '/api/sessions/ses_feedback_image/download?path=uploads%2Ffix.png',
            mediaType: 'image/png',
            filename: 'fix.png',
          },
        ],
        metadata: {
          manifestNodeId: null,
          uploads: [{ key: 'uploads/fix.png', filename: 'fix.png', mediaType: 'image/png' }],
        },
      },
      metadata: { timezone, submissionSource: 'chat_input' },
      v2Source: 'agentic_chat_submit',
      model: null,
      enabledConnectorSlugs: [],
    })
  })

  it('uses Arena signed upload then projects the content hash to the user CAS URL', async () => {
    const content = 'arena-cas'
    const hash = createHash('sha256').update(content).digest('base64url')
    const file = new File([content], 'evidence.txt', { type: 'text/plain' })
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url) === '/api/storage/generate-agent-upload-url') {
        return new Response(JSON.stringify({
          uploadUrl: '/api/storage/agent-upload/upl_test?token=secret',
          key: `cas/users/00000000-0000-4000-8000-000000000000/${hash}`,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(null, { status: 200 })
    }))

    await expect(api.uploadAgentFile(file)).resolves.toEqual({
      path: `cas/users/00000000-0000-4000-8000-000000000000/${hash}`,
      url: `/api/chat/workspace/cas/user/${hash}`,
      bytes: file.size,
      mime: 'text/plain',
    })
    expect(calls).toHaveLength(2)
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      hash,
      contentType: 'text/plain',
      size: file.size,
    })
    expect(calls[1]).toEqual({
      url: '/api/storage/agent-upload/upl_test?token=secret',
      init: expect.objectContaining({
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: file,
      }),
    })
  })
})

describe('Workspace inventory paging transport', () => {
  it('requests a continuation page without changing the page size bound into the opaque snapshot cursor', async () => {
    const payload = {
      entries: [{ name: 'report.md', path: 'docs/report.md', type: 'file', size: 128 }],
      hasMore: true,
      nextCursor: 'next/page+2',
      truncated: false,
      totalFiles: 701,
      fileLimitHit: false,
      entryLimitHit: false,
      totalFilesIsLowerBound: false,
      loadedEntries: 700,
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.workspaceInventory('ses_inventory', 'manifest/page+1')).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/ses_inventory/workspace-inventory?cursor=manifest%2Fpage%2B1',
      expect.objectContaining({ headers: expect.objectContaining({ 'content-type': 'application/json' }) }),
    )

    await api.workspaceInventory('ses_inventory', undefined, 200)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/sessions/ses_inventory/workspace-inventory?limit=200',
      expect.objectContaining({ headers: expect.objectContaining({ 'content-type': 'application/json' }) }),
    )
  })
})
