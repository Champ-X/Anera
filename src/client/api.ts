import type {
  AgentModelOption,
  CreditBalance,
  GitHubBranchPage,
  GitHubConnectionState,
  GitHubRepositoryPage,
  GitHubStatusState,
  OfficeArtifactPreview,
  PointwiseFeedbackValue,
  SessionSnapshot,
  SessionMetadataPatch,
  SessionSummary,
  TaskReviewDismissAction,
  TaskCompletionFeedbackValue,
  TaskReviewFeedbackAction,
  UploadedFileInput,
  WorkspaceInventoryPage,
} from '../shared/types'
import { STATIC_SHOWCASE } from './showcase-mode'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (STATIC_SHOWCASE) {
    const { showcaseRequest } = await import('./showcase-api')
    return await showcaseRequest<T>(path, options)
  }
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({})) as { error?: string }
  const method = options?.method?.toUpperCase() || 'GET'
  if (!response.ok) throw new Error(body.error || `${method} ${path} failed (${response.status})`)
  return body as T
}

const ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE = 'The next message part will be the user providing feedback about the previous message.'

export interface AgentMessageAttachment {
  path: string
  name: string
  mime: string
}

export interface AgentCreateChatAttachment extends AgentMessageAttachment {
  url?: string
}

export function generateUuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let timestamp = BigInt(now)
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn)
    timestamp >>= 8n
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function arenaAgentMessageTransport(
  sessionId: string,
  content: string,
  attachments: readonly AgentMessageAttachment[],
  reviewedNodeId: string | undefined,
  timezone: string,
) {
  const text = content.trim()
  const uploads = attachments.map((attachment) => ({
    key: attachment.path,
    filename: attachment.name,
    mediaType: attachment.mime,
  }))
  const imageParts = uploads
    .filter((upload) => upload.mediaType.startsWith('image/'))
    .map((upload) => ({
      type: 'file' as const,
      url: `/api/sessions/${sessionId}/download?path=${encodeURIComponent(upload.key)}`,
      mediaType: upload.mediaType,
      filename: upload.filename,
    }))
  const customFeedbackParts = reviewedNodeId
    ? [{
        type: 'data-custom-feedback' as const,
        data: {
          systemMessage: ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE,
          reviewedNodeId,
        },
      }]
    : []
  const textParts = text || imageParts.length === 0
    ? [{ type: 'text' as const, text }]
    : []
  const message = uploads.length > 0 || reviewedNodeId
    ? {
        parts: [...customFeedbackParts, ...imageParts, ...textParts],
        ...(uploads.length > 0
          ? { metadata: { manifestNodeId: null, uploads } }
          : {}),
      }
    : { text }
  return {
    message,
    metadata: { timezone, submissionSource: 'chat_input' },
    v2Source: 'agentic_chat_submit',
  } as const
}

export const api = {
  async listSessions(): Promise<SessionSummary[]> {
    return (await request<{ sessions: SessionSummary[] }>('/api/sessions')).sessions
  },
  async createSession(): Promise<SessionSummary> {
    return (await request<{ session: SessionSummary }>('/api/sessions', { method: 'POST', body: '{}' })).session
  },
  async updateSession(id: string, patch: SessionMetadataPatch): Promise<SessionSummary> {
    return (await request<{ session: SessionSummary }>(`/api/sessions/${id}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    })).session
  },
  async createAgentChat(
    content: string,
    attachments: AgentCreateChatAttachment[],
    model: string | null,
    enabledConnectorSlugs: string[],
  ): Promise<string> {
    const text = content.trim()
    const uploads = attachments.map((attachment) => ({
      key: attachment.path,
      filename: attachment.name,
      mediaType: attachment.mime,
    }))
    const imageParts = attachments
      .filter((attachment) => attachment.mime.startsWith('image/'))
      .map((attachment) => {
        if (!attachment.url) throw new Error(`Missing CAS URL for image upload: ${attachment.name}`)
        return {
          type: 'file' as const,
          url: attachment.url,
          mediaType: attachment.mime,
          filename: attachment.name,
        }
      })
    const parts = [
      ...imageParts,
      ...(text ? [{ type: 'text' as const, text }] : []),
    ]
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const result = await request<{ id: string }>('/nextjs-api/stream/create-chat', {
      method: 'POST',
      headers: enabledConnectorSlugs.length > 0
        ? { 'x-anera-enabled-connectors': [...new Set(enabledConnectorSlugs)].join(',') }
        : undefined,
      body: JSON.stringify({
        message: {
          id: generateUuidV7(),
          role: 'user',
          parts,
          ...(uploads.length > 0 ? { metadata: { manifestNodeId: null, uploads } } : {}),
        },
        recaptchaV3Token: null,
        timezone,
        ...(model ? { modelId: model } : {}),
      }),
    })
    return result.id
  },
  async listAgentModels(): Promise<AgentModelOption[]> {
    return (await request<{ models: AgentModelOption[] }>('/api/agent-models')).models
  },
  async creditBalance(): Promise<CreditBalance> {
    return await request('/api/billing/balance')
  },
  async snapshot(id: string): Promise<SessionSnapshot> {
    return await request<SessionSnapshot>(`/api/sessions/${id}`)
  },
  async workspaceInventory(id: string, cursor?: string, limit?: number): Promise<WorkspaceInventoryPage> {
    const query = new URLSearchParams()
    if (cursor) query.set('cursor', cursor)
    if (limit !== undefined) query.set('limit', String(limit))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return await request<WorkspaceInventoryPage>(`/api/sessions/${id}/workspace-inventory${suffix}`)
  },
  async officeArtifactPreview(id: string, path: string): Promise<OfficeArtifactPreview> {
    return await request(`/api/sessions/${id}/artifact-preview?path=${encodeURIComponent(path)}`)
  },
  async send(id: string, content: string, attachments: AgentMessageAttachment[], model: string | null, enabledConnectorSlugs: string[], reviewedNodeId?: string): Promise<void> {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    await request(`/api/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        ...arenaAgentMessageTransport(id, content, attachments, reviewedNodeId, timezone),
        model,
        enabledConnectorSlugs,
      }),
    })
  },
  async stop(id: string): Promise<void> {
    await request(`/api/sessions/${id}/stop`, { method: 'POST', body: '{}' })
  },
  async resume(id: string, model?: string): Promise<void> {
    await request(`/api/sessions/${id}/resume`, { method: 'POST', body: JSON.stringify({ model }) })
  },
  async feedback(id: string, messageEventId: string, value: PointwiseFeedbackValue | null): Promise<void> {
    await request(`/api/sessions/${id}/messages/${messageEventId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ value }),
    })
  },
  async dismissReview(id: string, messageEventId: string, action: TaskReviewDismissAction): Promise<void> {
    await request(`/api/sessions/${id}/messages/${messageEventId}/review`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    })
  },
  async checkInFeedback(id: string, sessionNodeId: string, action: TaskReviewFeedbackAction): Promise<{ sessionNodeId: string; action: TaskReviewFeedbackAction }> {
    return await request(`/api/chat/${id}/review-feedback`, {
      method: 'POST',
      body: JSON.stringify({
        sessionNodeId,
        recaptchaV3Token: null,
        action,
      }),
    })
  },
  async taskCompletionFeedback(id: string, sessionNodeId: string, value: TaskCompletionFeedbackValue): Promise<{ sessionNodeId: string; feedback: { type: 'task_completion_bar'; value: TaskCompletionFeedbackValue } }> {
    return await request(`/api/chat/${id}/review-feedback`, {
      method: 'POST',
      body: JSON.stringify({
        sessionNodeId,
        recaptchaV3Token: null,
        feedback: { type: 'task_completion_bar', value },
      }),
    })
  },
  async undoTurn(id: string, sessionNodeId: string): Promise<{
    type: 'undo'
    sessionNodeId: string
    targetTurnIds: string[]
    promptText: string
    workspaceReverted: false
  }> {
    return await request(`/api/chat/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'undo',
        sessionNodeId,
        recaptchaV3Token: null,
      }),
    })
  },
  async resolveApproval(id: string, approvalId: string, approved: boolean): Promise<void> {
    await request(`/api/sessions/${id}/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    })
  },
  async resolveHitl(id: string, hitlId: string, response: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await request<{ response: Record<string, unknown> }>(`/api/sessions/${id}/hitl/${hitlId}`, {
      method: 'POST',
      body: JSON.stringify(response),
    })).response
  },
  async upload(id: string, file: File): Promise<{ path: string; bytes: number; mime: string }> {
    const contentBase64 = await fileToBase64(file)
    const input: UploadedFileInput = { name: file.name, mime: file.type, contentBase64 }
    return await request<{ path: string; bytes: number; mime: string }>(`/api/sessions/${id}/files`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  async uploadAgentFile(file: File): Promise<{ path: string; url: string; bytes: number; mime: string }> {
    const hash = await sha256Base64Url(file)
    const signed = await withAgentUploadRetry(async () => {
      const response = await fetch('/api/storage/generate-agent-upload-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash, contentType: file.type, size: file.size }),
      })
      const body = await response.json().catch(() => ({})) as { uploadUrl?: unknown; key?: unknown; error?: unknown }
      if (!response.ok) {
        throw new AgentUploadHttpError(
          typeof body.error === 'string' ? body.error : `Failed to generate Agent upload URL (${response.status})`,
          response.status >= 500,
        )
      }
      if (typeof body.uploadUrl !== 'string' || typeof body.key !== 'string') {
        throw new AgentUploadHttpError('Agent upload URL response was malformed', false)
      }
      return { uploadUrl: body.uploadUrl, key: body.key }
    })
    await withAgentUploadRetry(async () => {
      const response = await fetch(signed.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      })
      if (!response.ok) throw new AgentUploadHttpError(`Failed to upload Agent file (${response.status})`, true)
    })
    return {
      path: signed.key,
      url: `/api/chat/workspace/cas/user/${hash}`,
      bytes: file.size,
      mime: file.type,
    }
  },
  async restartWebsite(id: string): Promise<void> {
    await request(`/api/sessions/${id}/website/restart`, { method: 'POST', body: '{}' })
  },
  async githubConnection(): Promise<GitHubConnectionState> {
    const connection = await request<GitHubConnectionState>('/api/coding/github/connection')
    if (!['disconnected', 'installed', 'connected'].includes(connection?.status)) throw new Error('github_request_failed')
    return connection
  },
  async githubStatus(): Promise<GitHubStatusState> {
    const status = await request<GitHubStatusState>('/api/coding/github/status')
    if (!['none', 'minor', 'major', 'critical', 'maintenance'].includes(status?.indicator) || typeof status?.description !== 'string') {
      throw new Error('github_request_failed')
    }
    return status
  },
  async disconnectGitHub(): Promise<void> {
    await request('/api/coding/github/disconnect', { method: 'POST', body: '{}' })
  },
  async githubRepositories(cursor?: string): Promise<GitHubRepositoryPage> {
    const query = new URLSearchParams({ limit: '100' })
    if (cursor) query.set('cursor', cursor)
    return await request(`/api/coding/github/repos?${query}`)
  },
  async githubBranches(repoId: number, cursor?: string): Promise<GitHubBranchPage> {
    const query = new URLSearchParams({ repoId: String(repoId), limit: '100' })
    if (cursor) query.set('cursor', cursor)
    return await request(`/api/coding/github/branches?${query}`)
  },
  async createCodingSession(input: { repoId: number; repoOwner: string; repoName: string; baseBranch: string; message: string }): Promise<string> {
    return (await request<{ sessionId: string }>('/api/coding-agent/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    })).sessionId
  },
}

class AgentUploadHttpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
  }
}

async function withAgentUploadRetry<T>(operation: () => Promise<T>): Promise<T> {
  let failure: unknown
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      failure = error
      if (error instanceof AgentUploadHttpError && !error.retryable) throw error
      if (attempt === 3) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(10_000, 1_000 * (2 ** attempt))))
    }
  }
  throw failure
}

async function sha256Base64Url(file: File): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.readAsDataURL(file)
  })
}
