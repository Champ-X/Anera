import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import archiver from 'archiver'
import express, { type NextFunction, type Request, type Response } from 'express'
import mime from 'mime-types'
import {
  AGENT_OOXML_UPLOAD_TYPES,
  MAX_AGENT_UPLOAD_BYTES,
  agentUploadError,
} from '../shared/agent-upload-policy.js'
import type {
  AgentCustomFeedbackArm,
  AgentFeedbackType,
  PointwiseFeedbackValue,
  SessionEvent,
  TaskCompletionFeedbackValue,
  TaskReviewDismissAction,
  TaskReviewFeedbackAction,
  UploadedFileInput,
  WorkspaceEntry,
} from '../shared/types.js'
import {
  ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE,
  AgentService,
  type AgentServiceOptions,
} from './agent-service.js'
import { config } from './config.js'
import { assertReferenceLanguageDelivery } from './reference-language.js'
import { osSandboxStatus } from './os-sandbox.js'
import { DailyCreditStore } from './credit-store.js'
import {
  GitHubConnector,
  GitHubConnectorError,
  GitHubRepositoryBootstrapper,
  GITHUB_AGENT_TOOL_DEFINITIONS,
  OAuthCallbackError,
  createGitHubAgentToolExecutor,
  createGitHubCodingShellCommandBroker,
  type CodingSessionInput,
} from './github-connector.js'
import { SessionStore, type StoredSession } from './session-store.js'
import { injectMaterializedReferenceFonts } from './reference-fonts.js'
import { extractAttachmentPage } from './attachment-extractor.js'
import { validateAgentUploadBytes } from './agent-upload-validation.js'
import { normalizeAneraTrace, traceToJsonl } from './trace-normalizer.js'
import {
  assertNoSymlinkTraversal,
  encodeWorkspaceUrlPath,
  findWebsiteEntry,
  isWorkspaceInternalPath,
  isWorkspaceSnapshotExcludedPath,
  readWorkspaceFile,
  resolveWorkspacePath,
  workspaceSize,
  type WorkspaceInventoryEntry,
} from './workspace.js'
import {
  WORKSPACE_INVENTORY_MAX_LIMIT,
  WorkspaceInventoryCursorError,
  listWorkspaceEntryInventoryPage,
} from './workspace-inventory.js'

export interface CreateAppOptions {
  dataRoot?: string
  model?: string
  dailyFreeCredits?: number
  creditsPerUsd?: number
  creditNow?: () => Date
  /** Session-stable arm for Arena's public agentic-custom-feedback experiment. */
  customFeedbackArm?: AgentCustomFeedbackArm
  agent?: AgentServiceOptions
  github?: {
    connector?: GitHubConnector
    bootstrapper?: GitHubRepositoryBootstrapper
  }
}

export async function createApp(options: CreateAppOptions = {}): Promise<{
  app: express.Express
  store: SessionStore
  agent: AgentService
  credits: DailyCreditStore
  github: GitHubConnector
}> {
  const initialModel = options.model ?? config.model
  const dataRoot = options.dataRoot ?? config.dataRoot
  const customFeedbackArm = options.customFeedbackArm ?? config.customFeedbackArm
  const store = new SessionStore(dataRoot, initialModel)
  await store.initialize()
  const localUserId = await loadLocalUserId(dataRoot)
  const agentCasRoot = resolve(dataRoot, 'agent-cas')
  await mkdir(agentCasRoot, { recursive: true })
  const signedAgentUploads = new Map<string, SignedAgentUpload>()
  const websiteRestartRequests = new Map<string, Promise<StoredSession['website']>>()
  const credits = new DailyCreditStore(dataRoot, {
    dailyFreeCredits: options.dailyFreeCredits ?? config.dailyFreeCredits,
    creditsPerUsd: options.creditsPerUsd ?? config.creditsPerUsd,
    now: options.creditNow,
  })
  await credits.initialize()
  const github = options.github?.connector ?? new GitHubConnector({
    dataRoot,
    token: config.githubToken,
    clientId: config.githubClientId,
    clientSecret: config.githubClientSecret,
    callbackUrl: config.githubCallbackUrl,
    appId: config.githubAppId,
    appSlug: config.githubAppSlug,
    appPrivateKeyPath: config.githubAppPrivateKeyPath,
    apiBaseUrl: config.githubApiBaseUrl,
    oauthBaseUrl: config.githubOAuthBaseUrl,
    stateTtlMs: config.githubOAuthStateTtlMs,
  })
  const githubBootstrapper = options.github?.bootstrapper ?? new GitHubRepositoryBootstrapper({
    dataRoot,
    cloneTimeoutMs: config.githubCloneTimeoutMs,
    maxFiles: config.githubMaxFiles,
    maxBytes: config.githubMaxBytes,
    maxFileBytes: config.githubMaxFileBytes,
  })
  await github.initialize()
  const agent = new AgentService(store, {
    ...options.agent,
    credits,
    models: options.agent?.models ?? (options.model ? [options.model] : config.agentModels),
    connectorTools: {
      github: GITHUB_AGENT_TOOL_DEFINITIONS,
      ...options.agent?.connectorTools,
    },
    connectorExecutors: {
      github: createGitHubAgentToolExecutor(github),
      ...options.agent?.connectorExecutors,
    },
    connectorAvailability: {
      github: async () => (await github.connection()).status === 'connected',
      ...options.agent?.connectorAvailability,
    },
    toolExecutorDependencies: {
      ...options.agent?.toolExecutorDependencies,
      shellCommandBroker: createGitHubCodingShellCommandBroker(github),
    },
  })
  await agent.initialize()
  const app = express()
  app.disable('x-powered-by')
  app.use(['/api', '/nextjs-api'], (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      next()
      return
    }
    const origin = request.get('origin')
    const fetchSite = request.get('sec-fetch-site')
    const expectedOrigin = `${request.protocol}://${request.get('host')}`
    if ((origin && origin !== expectedOrigin) || fetchSite === 'cross-site') {
      response.status(403).json({ error: 'Cross-origin state changes are not allowed' })
      return
    }
    next()
  })
  app.put(
    '/api/storage/agent-upload/:uploadId',
    express.raw({ type: '*/*', limit: MAX_AGENT_UPLOAD_BYTES }),
    async (request, response) => {
      expireSignedAgentUploads(signedAgentUploads)
      const pending = signedAgentUploads.get(request.params.uploadId)
      const token = typeof request.query.token === 'string' ? request.query.token : ''
      if (!pending || !constantTimeEqual(token, pending.token) || pending.expiresAt <= Date.now()) {
        throw statusError('Agent upload URL is invalid or expired', 403)
      }
      if (!Buffer.isBuffer(request.body)) throw statusError('Agent upload body must be binary', 400)
      if (request.body.length !== pending.size) throw statusError('Agent upload size does not match the signed request', 400)
      if ((request.get('content-type') || '').split(';', 1)[0] !== pending.contentType) {
        throw statusError('Agent upload content type does not match the signed request', 400)
      }
      const hash = sha256Base64Url(request.body)
      if (hash !== pending.hash) throw statusError('Agent upload hash does not match the signed request', 400)
      validateAgentUploadBytes(agentUploadPolicyName(pending.contentType), pending.contentType, request.body)

      const blobPath = resolve(agentCasRoot, hash)
      const metadataPath = resolve(agentCasRoot, `${hash}.json`)
      const temporarySuffix = `${pending.uploadId}-${randomBytes(8).toString('hex')}.part`
      const temporaryBlob = resolve(agentCasRoot, temporarySuffix)
      const temporaryMetadata = resolve(agentCasRoot, `${temporarySuffix}.json`)
      try {
        await writeFile(temporaryBlob, request.body, { flag: 'wx' })
        await writeFile(temporaryMetadata, JSON.stringify({
          hash,
          contentType: pending.contentType,
          size: pending.size,
        }), { flag: 'wx' })
        await rename(temporaryBlob, blobPath)
        await rename(temporaryMetadata, metadataPath)
      } finally {
        await rm(temporaryBlob, { force: true })
        await rm(temporaryMetadata, { force: true })
      }
      signedAgentUploads.delete(pending.uploadId)
      response.status(200).end()
    },
  )
  // A 25 MiB Agent file expands to roughly 33.4 MiB as base64 in this local
  // JSON transport. Arena uploads the same bytes through a signed object URL.
  app.use(express.json({ limit: '40mb' }))

  app.post('/api/storage/generate-agent-upload-url', (request, response) => {
    expireSignedAgentUploads(signedAgentUploads)
    const body = isRecord(request.body) ? request.body : {}
    if (Object.keys(body).some((key) => !['hash', 'contentType', 'size'].includes(key))) {
      throw statusError('Agent upload request may contain only hash, contentType, and size', 400)
    }
    if (typeof body.hash !== 'string' || !CAS_HASH_PATTERN.test(body.hash)) {
      throw statusError('Agent upload hash must be a SHA-256 base64url value', 400)
    }
    if (typeof body.contentType !== 'string' || !body.contentType) {
      throw statusError('Agent upload contentType is required', 400)
    }
    if (!Number.isInteger(body.size) || (body.size as number) < 0) {
      throw statusError('Agent upload size must be a non-negative integer', 400)
    }
    const policyError = agentUploadError({
      name: agentUploadPolicyName(body.contentType),
      type: body.contentType,
      size: body.size as number,
    })
    if (policyError) throw statusError(policyError, 400)

    const uploadId = createLocalUploadId()
    const token = randomBytes(24).toString('base64url')
    const pending: SignedAgentUpload = {
      uploadId,
      token,
      hash: body.hash,
      contentType: body.contentType,
      size: body.size as number,
      expiresAt: Date.now() + SIGNED_AGENT_UPLOAD_TTL_MS,
    }
    signedAgentUploads.set(uploadId, pending)
    response.status(200).json({
      uploadUrl: `/api/storage/agent-upload/${uploadId}?token=${encodeURIComponent(token)}`,
      key: `cas/users/${localUserId}/${body.hash}`,
    })
  })

  app.get('/api/chat/workspace/cas/user/:hash', async (request, response, next) => {
    try {
      const hash = request.params.hash
      if (!CAS_HASH_PATTERN.test(hash)) throw statusError('Invalid CAS hash', 400)
      const metadata = await readAgentCasMetadata(agentCasRoot, hash)
      const target = resolve(agentCasRoot, hash)
      const info = await stat(target)
      if (!info.isFile() || info.size !== metadata.size) throw statusError('CAS file not found', 404)
      response.setHeader('content-type', metadata.contentType)
      response.setHeader('content-length', String(info.size))
      response.setHeader('cache-control', 'public, max-age=31536000, immutable')
      response.setHeader('x-content-type-options', 'nosniff')
      createReadStream(target).pipe(response)
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      model: initialModel,
      models: agent.listModels(),
      modelConfigured: Boolean(config.deepseekApiKey),
      osSandbox: osSandboxStatus(),
      browser: agent.browser.diagnostics(),
    })
  })

  app.get('/api/agent-models', (_request, response) => {
    response.json({ models: agent.listModels() })
  })

  app.get('/api/billing/balance', async (_request, response) => {
    response.json(await credits.balance())
  })

  app.get('/api/me/pulse', async (_request, response) => {
    response.json(await credits.pulse())
  })

  app.get('/api/coding/github/connection', async (_request, response) => {
    response.json(await github.connection())
  })

  app.get('/api/coding/github/status', async (_request, response) => {
    response.json(await github.serviceStatus())
  })

  const beginGitHubConnection = async (request: Request, response: Response) => {
    const callbackUrl = `${request.protocol}://${request.get('host')}/api/coding/github/callback`
    try {
      // Prefer repository-scoped GitHub App installation when configured. The
      // connector falls back to the existing OAuth/development-token flow.
      const result = await github.beginInstallation(callbackUrl)
      if (result.kind === 'redirect') response.redirect(302, result.url)
      else sendOAuthPopupResult(response, { success: true })
    } catch (error) {
      const code = error instanceof GitHubConnectorError ? error.code : 'github_request_failed'
      sendOAuthPopupResult(response, { success: false, error: code })
    }
  }
  app.get('/api/coding/github/connect/start', (request, response) => void beginGitHubConnection(request, response))
  app.get('/api/coding/github/connect/install', (request, response) => void beginGitHubConnection(request, response))

  app.get('/api/coding/github/callback', async (request, response) => {
    const upstreamError = typeof request.query.error === 'string' ? request.query.error : undefined
    if (upstreamError) {
      try {
        github.cancelOAuth(typeof request.query.state === 'string' ? request.query.state : undefined)
        sendOAuthPopupResult(response, { success: false, error: upstreamError })
      } catch (error) {
        sendOAuthPopupResult(response, { success: false, error: error instanceof OAuthCallbackError ? error.oauthCode : 'invalid_state' })
      }
      return
    }
    try {
      const state = typeof request.query.state === 'string' ? request.query.state : undefined
      const installationId = typeof request.query.installation_id === 'string' ? request.query.installation_id : undefined
      const setupAction = typeof request.query.setup_action === 'string' ? request.query.setup_action : undefined
      if (installationId || setupAction) {
        await github.completeInstallation({ installationId, setupAction, state })
      } else {
        await github.completeOAuth({
          code: typeof request.query.code === 'string' ? request.query.code : undefined,
          state,
        })
      }
      sendOAuthPopupResult(response, { success: true })
    } catch (error) {
      sendOAuthPopupResult(response, {
        success: false,
        error: error instanceof OAuthCallbackError ? error.oauthCode : 'github_request_failed',
      })
    }
  })

  app.post('/api/coding/github/disconnect', async (_request, response) => {
    response.json(await github.disconnect())
  })

  app.get('/api/coding/github/repos', async (request, response) => {
    const limit = Number.parseInt(typeof request.query.limit === 'string' ? request.query.limit : '100', 10)
    const cursor = typeof request.query.cursor === 'string' ? request.query.cursor : undefined
    response.json(await github.listRepositories(limit, cursor))
  })

  app.get('/api/coding/github/branches', async (request, response) => {
    const repoId = Number.parseInt(typeof request.query.repoId === 'string' ? request.query.repoId : '', 10)
    const limit = Number.parseInt(typeof request.query.limit === 'string' ? request.query.limit : '100', 10)
    const cursor = typeof request.query.cursor === 'string' ? request.query.cursor : undefined
    response.json(await github.listBranches(repoId, limit, cursor))
  })

  app.post('/api/coding-agent/sessions', async (request, response) => {
    await credits.assertCanStart(false)
    const input = parseCodingSessionInput(request.body)
    const selection = await github.resolveSelection(input)
    const prepared = await githubBootstrapper.prepare(selection)
    try {
      const session = await store.create({
        repository: prepared.repository,
        workspaceSource: prepared.checkoutDir,
        workspaceBytes: prepared.workspaceBytes,
        customFeedbackArm,
      })
      await agent.submit(session.summary.id, { content: input.message, enabledConnectorSlugs: ['github'] })
      response.status(201).json({ sessionId: session.summary.id })
    } finally {
      await prepared.cleanup()
    }
  })

  app.get('/api/sessions', async (_request, response) => {
    response.json({ sessions: await store.list() })
  })

  app.post('/api/sessions', async (_request, response) => {
    const session = await store.create({ customFeedbackArm })
    response.status(201).json({ session: session.summary })
  })

  app.post('/nextjs-api/stream/create-chat', async (request, response) => {
    const input = await parseArenaCreateChatTransport(request.body, { agentCasRoot, localUserId })
    const enabledConnectorSlugs = parseLocalConnectorHeader(request.get('x-anera-enabled-connectors'))
    const session = await store.create({ customFeedbackArm })
    try {
      const attachments: string[] = []
      for (const upload of input.uploads) {
        const safeName = safeAgentUploadName(upload.filename)
        const uploaded = await store.createUpload(
          session.summary.id,
          `uploads/${safeName}`,
          upload.content,
          upload.mediaType,
        )
        attachments.push(uploaded.path)
      }
      await agent.submit(session.summary.id, {
        content: input.content,
        attachments,
        model: input.modelId,
        timezone: input.timezone,
        enabledConnectorSlugs,
        clientMessageId: input.messageId,
      })
      response.status(200).json({ id: session.summary.id })
    } catch (error) {
      await store.discardUnpublishedSession(session.summary.id).catch(() => undefined)
      throw error
    }
  })

  app.get('/api/sessions/:id', async (request, response) => {
    const id = request.params.id
    const workspace = store.workspaceDir(id)
    const bytes = await workspaceSize(workspace)
    const state = await store.get(id)
    const inventory = await listWorkspaceEntryInventoryPage({
      workspaceRoot: workspace,
      manifestDirectory: resolve(store.sessionDir(id), 'workspace-inventory', 'ui'),
      sessionId: id,
      limit: WORKSPACE_INVENTORY_MAX_LIMIT,
    })
    const processes = new Map(state.processes.map((process) => [process.id, process]))
    for (const process of agent.processes.list(id)) processes.set(process.id, process)
    response.json({
      session: store.redactForDisplay(id, { ...state.summary, workspaceBytes: bytes }),
      events: await store.events(id),
      plan: store.redactForDisplay(id, state.plan),
      workspace: workspaceInventoryTree(inventory.entries),
      workspaceInventory: workspaceInventoryMetadata(inventory),
      artifacts: state.artifacts,
      processes: store.redactForDisplay(id, [...processes.values()]),
      website: state.website,
      deployment: state.deployment,
      repository: state.repository,
    })
  })

  app.get('/api/sessions/:id/workspace-inventory', async (request, response) => {
    const id = request.params.id
    try {
      await store.get(id)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw statusError('Session not found', 404)
      throw error
    }
    const cursor = parseWorkspaceInventoryCursor(request.query.cursor)
    const requestedLimit = parseWorkspaceInventoryLimit(request.query.limit)
    try {
      const page = await listWorkspaceEntryInventoryPage({
        workspaceRoot: store.workspaceDir(id),
        manifestDirectory: resolve(store.sessionDir(id), 'workspace-inventory', 'ui'),
        sessionId: id,
        cursor,
        // A cursor already persists its original limit. Omitting limit on a
        // continuation is therefore safe; an explicitly changed limit fails
        // closed inside the pager.
        limit: requestedLimit ?? (cursor ? undefined : WORKSPACE_INVENTORY_MAX_LIMIT),
      })
      response.json({
        entries: page.entries,
        ...workspaceInventoryMetadata(page),
      })
    } catch (error) {
      if (error instanceof WorkspaceInventoryCursorError) {
        throw Object.assign(error, {
          statusCode: error.code === 'cursor_expired' ? 410 : 400,
        })
      }
      throw error
    }
  })

  app.post('/api/sessions/:id/messages', async (request, response) => {
    const body = isRecord(request.body) ? request.body : {}
    const rawModel = body.model
    if (rawModel !== undefined && rawModel !== null && typeof rawModel !== 'string') throw new Error('model must be a string or null')
    const rawEnabledConnectorSlugs = body.enabledConnectorSlugs
    if (rawEnabledConnectorSlugs !== undefined && (
      !Array.isArray(rawEnabledConnectorSlugs)
      || rawEnabledConnectorSlugs.some((value: unknown) => typeof value !== 'string')
    )) throw new Error('enabledConnectorSlugs must be an array of strings')
    const message = parseAgentMessageTransport(body, request.params.id)
    await assertAgentTurnAttachments(store, request.params.id, message.attachments)
    const result = await agent.submit(request.params.id, {
      content: message.content,
      attachments: message.attachments,
      model: rawModel,
      timezone: message.timezone,
      enabledConnectorSlugs: rawEnabledConnectorSlugs,
      reviewedNodeId: message.reviewedNodeId,
    })
    response.status(202).json(result)
  })

  app.post('/api/sessions/:id/stop', async (request, response) => {
    await agent.cancel(request.params.id)
    response.status(202).json({ ok: true })
  })

  app.post('/api/sessions/:id/resume', async (request, response) => {
    const model = request.body?.model
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw statusError('model must be a non-empty string', 400)
    const result = await agent.resume(request.params.id, model)
    response.status(202).json(result)
  })

  app.post('/api/sessions/:id/messages/:messageEventId/feedback', async (request, response) => {
    const value = request.body?.value
    if (value !== null && value !== 'upvote' && value !== 'downvote') {
      response.status(400).json({ error: 'value must be upvote, downvote, or null' })
      return
    }
    const events = await store.events(request.params.id)
    const target = events.find((event) => event.id === request.params.messageEventId && event.type === 'assistant.final')
    if (!target) throw new Error('Final message not found')
    const latest = [...events].reverse().find((event) => (
      event.type === 'feedback.updated' && (event.data as { messageEventId?: string }).messageEventId === target.id
    ))
    const current = latest ? ((latest.data as { value?: PointwiseFeedbackValue | null }).value ?? null) : null
    if (current !== value) {
      await store.append(request.params.id, 'feedback.updated', {
        messageEventId: target.id,
        value: value as PointwiseFeedbackValue | null,
        model: (await store.get(request.params.id)).summary.model,
      }, { turnId: target.turnId, stepId: target.stepId })
    }
    response.json({ messageEventId: target.id, value })
  })

  app.post('/api/sessions/:id/messages/:messageEventId/review', async (request, response) => {
    const action = request.body?.action
    if (action !== 'continue' && action !== 'dismiss') {
      response.status(400).json({ error: 'action must be continue or dismiss' })
      return
    }
    const events = await store.events(request.params.id)
    const target = events.find((event) => event.id === request.params.messageEventId && event.type === 'assistant.final')
    if (!target) throw new Error('Final message not found')
    const existing = events.find((event) => (
      event.type === 'review.dismissed' && (event.data as { messageEventId?: string }).messageEventId === target.id
    ))
    const effectiveAction = existing
      ? (existing.data as { action?: TaskReviewDismissAction }).action ?? action
      : action as TaskReviewDismissAction
    if (!existing) {
      await store.append(request.params.id, 'review.dismissed', {
        messageEventId: target.id,
        action: effectiveAction,
        model: (await store.get(request.params.id)).summary.model,
      }, { turnId: target.turnId, stepId: target.stepId })
    }
    response.json({ messageEventId: target.id, action: effectiveAction })
  })

  // Mirrors Arena's shared completed-route transport. check_in sends a
  // top-level action while task_completion_bar sends a nested feedback value.
  // The recaptcha value is accepted as transport metadata but is not needed by
  // a local-only deployment.
  app.post('/api/chat/:id/review-feedback', async (request, response) => {
    const sessionNodeId = request.body?.sessionNodeId
    const action = request.body?.action
    const feedback = request.body?.feedback
    const value = feedback?.value
    if (typeof sessionNodeId !== 'string') {
      response.status(400).json({ error: 'sessionNodeId must be a string' })
      return
    }
    const state = await store.get(request.params.id)
    const events = await store.events(request.params.id)

    if (action !== undefined || feedback === undefined) {
      if (feedback !== undefined || (action !== 'approve' && action !== 'disapprove' && action !== 'edit' && action !== 'escape')) {
        response.status(400).json({ error: 'action must be approve, disapprove, edit, or escape' })
        return
      }
      const requestedAction = action as TaskReviewFeedbackAction
      const target = reviewFeedbackTarget(state, events, sessionNodeId, 'check_in')
      const eventType = requestedAction === 'approve' || requestedAction === 'disapprove'
        ? 'feedback.updated' as const
        : 'review.dismissed' as const
      const eventData: Record<string, unknown> = eventType === 'feedback.updated'
        ? {
            sessionNodeId: target.id,
            messageEventId: target.id,
            value: requestedAction === 'approve' ? 'upvote' : 'downvote',
            checkInAction: requestedAction,
            feedback: { type: 'check_in', value: requestedAction },
            model: state.summary.model,
          }
        : {
            sessionNodeId: target.id,
            messageEventId: target.id,
            action: requestedAction === 'edit' ? 'continue' : 'dismiss',
            checkInAction: requestedAction,
            feedback: { type: 'check_in', value: requestedAction },
            model: state.summary.model,
          }
      const settled = await store.appendIfAbsent(request.params.id, eventType, eventData, (event) => (
        terminalCheckInEventMatches(event, target.id)
      ), { turnId: target.turnId, stepId: target.stepId }, {
        beforeAppend: (nextState, nextEvents) => {
          reviewFeedbackTarget(nextState, nextEvents, sessionNodeId, 'check_in')
        },
      })
      const effectiveAction = checkInActionFromEvent(settled.event) ?? requestedAction
      response.json({ sessionNodeId: target.id, action: effectiveAction })
      return
    }

    if (feedback?.type !== 'task_completion_bar' || (value !== 'no' && value !== 'making_progress' && value !== 'yes')) {
      response.status(400).json({ error: 'feedback must be task_completion_bar with value no, making_progress, or yes' })
      return
    }
    const target = reviewFeedbackTarget(state, events, sessionNodeId, 'task_completion_bar')
    const requestedValue = value as TaskCompletionFeedbackValue
    const settled = await store.appendIfAbsent(request.params.id, 'task.completion.updated', {
      sessionNodeId: target.id,
      messageEventId: target.id,
      value: requestedValue,
      feedback: { type: 'task_completion_bar', value: requestedValue },
      model: state.summary.model,
    }, (event) => (
      event.type === 'task.completion.updated'
      && (event.data as { sessionNodeId?: string }).sessionNodeId === target.id
    ), { turnId: target.turnId, stepId: target.stepId }, {
      beforeAppend: (nextState, nextEvents) => {
        reviewFeedbackTarget(nextState, nextEvents, sessionNodeId, 'task_completion_bar')
      },
    })
    const effectiveValue = (settled.event.data as { value?: TaskCompletionFeedbackValue }).value ?? requestedValue
    response.json({ sessionNodeId: target.id, feedback: { type: 'task_completion_bar', value: effectiveValue } })
  })

  // Arena sends this through its generic realtime sendAction transport. The
  // local REST edge preserves the public action object while the Store owns
  // the durable model-context rewind and append-only observable boundary.
  app.post('/api/chat/:id/action', async (request, response) => {
    const type = request.body?.type
    const sessionNodeId = request.body?.sessionNodeId
    if (type !== 'undo') {
      response.status(400).json({ error: 'type must be undo' })
      return
    }
    if (typeof sessionNodeId !== 'string') {
      response.status(400).json({ error: 'sessionNodeId must be a string' })
      return
    }
    const state = await store.get(request.params.id)
    const events = await store.events(request.params.id)
    const existing = events.find((event) => (
      event.type === 'turn.undone'
      && (event.data as { sessionNodeId?: unknown }).sessionNodeId === sessionNodeId
    ))
    if (existing) {
      const data = existing.data as { targetTurnIds?: unknown }
      const firstTurnId = Array.isArray(data.targetTurnIds) && typeof data.targetTurnIds[0] === 'string'
        ? data.targetTurnIds[0]
        : undefined
      const promptEvent = firstTurnId
        ? events.find((event) => event.type === 'turn.started' && event.turnId === firstTurnId)
        : undefined
      response.json({
        type: 'undo',
        sessionNodeId,
        targetTurnIds: Array.isArray(data.targetTurnIds) ? data.targetTurnIds : [],
        promptText: String((promptEvent?.data as { content?: unknown } | undefined)?.content ?? ''),
        workspaceReverted: false,
      })
      return
    }

    const target = turnUndoTarget(state, events, sessionNodeId)
    const settled = await store.commitTurnUndo(request.params.id, {
      sessionNodeId,
      targetTurnIds: target.targetTurnIds,
      promptText: target.promptText,
      beforeCommit: (nextState, nextEvents) => {
        turnUndoTarget(nextState, nextEvents, sessionNodeId)
      },
    })
    response.json({
      type: 'undo',
      sessionNodeId,
      targetTurnIds: target.targetTurnIds,
      promptText: settled.promptText,
      workspaceReverted: false,
    })
  })

  app.post('/api/sessions/:id/approvals/:approvalId', async (request, response) => {
    if (typeof request.body?.approved !== 'boolean') throw new Error('approved must be a boolean')
    const approved = await agent.resolveApproval(request.params.id, request.params.approvalId, request.body.approved)
    response.json({ ok: true, approved })
  })

  app.post('/api/sessions/:id/hitl/:hitlId', async (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      response.status(400).json({ error: 'HITL response must be an object' })
      return
    }
    const result = await agent.resolveHumanInput(request.params.id, request.params.hitlId, request.body)
    response.json({ ok: true, response: result })
  })

  app.post('/api/sessions/:id/files', async (request, response) => {
    const input = request.body as UploadedFileInput
    if (!input || typeof input.name !== 'string' || typeof input.contentBase64 !== 'string') {
      response.status(400).json({ error: 'name and contentBase64 are required' })
      return
    }
    const safeName = basename(input.name).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 160)
    if (!safeName || safeName === '.' || safeName === '..') throw new Error('Invalid upload file name')
    const buffer = Buffer.from(input.contentBase64, 'base64')
    const declaredMime = typeof input.mime === 'string' ? input.mime : ''
    const policyError = agentUploadError({ name: input.name, type: declaredMime, size: buffer.length })
    if (policyError) {
      response.status(400).json({ error: policyError })
      return
    }
    const uploaded = await store.createUpload(request.params.id, `uploads/${safeName}`, buffer, declaredMime)
    response.status(201).json(uploaded)
  })

  app.get('/api/sessions/:id/events', async (request, response) => {
    const id = request.params.id
    await store.get(id)
    response.status(200)
    response.setHeader('content-type', 'text/event-stream')
    response.setHeader('cache-control', 'no-cache, no-transform')
    response.setHeader('connection', 'keep-alive')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders()
    response.write('retry: 1500\n\n')
    const after = Number.parseInt(String(request.headers['last-event-id'] || request.query.after || 0), 10) || 0
    // Subscribe before reading history. Otherwise an append that lands between
    // the replay read and listener registration is durably present but absent
    // from this live stream until a later reconnect.
    let replaying = true
    const buffered: SessionEvent[] = []
    const unsubscribe = store.subscribe(id, (event) => {
      if (replaying) buffered.push(event)
      else writeSse(response, event)
    })
    let replayHighWater = after
    for (const event of await store.events(id, after)) {
      writeSse(response, event)
      replayHighWater = Math.max(replayHighWater, event.seq)
    }
    replaying = false
    for (const event of buffered.sort((left, right) => left.seq - right.seq)) {
      if (event.seq <= replayHighWater) continue
      writeSse(response, event)
      replayHighWater = event.seq
    }
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
    request.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  app.get('/api/sessions/:id/canonical.jsonl', async (request, response) => {
    const id = request.params.id
    const state = await store.get(id)
    const taskId = typeof request.query.task_id === 'string' ? request.query.task_id : undefined
    const trace = normalizeAneraTrace({
      events: await store.events(id),
      summary: store.redactForDisplay(id, state.summary),
      artifacts: state.artifacts,
      processes: store.redactForDisplay(id, state.processes),
      website: state.website,
      repository: state.repository,
      taskId,
    })
    response.type('application/x-ndjson')
    response.setHeader('content-disposition', `inline; filename="${id}-canonical.jsonl"`)
    response.send(traceToJsonl(trace))
  })

  app.get('/api/sessions/:id/download', async (request, response) => {
    const path = typeof request.query.path === 'string' ? request.query.path : ''
    if (!path) throw new Error('path query parameter is required')
    const id = request.params.id
    const workspace = store.workspaceDir(id)
    const target = resolveWorkspacePath(workspace, path)
    await assertNoSymlinkTraversal(workspace, target)
    if (!(await stat(target)).isFile()) throw new Error('Path is not a file')
    response.attachment(basename(target))
    const state = await store.get(id)
    const referenceStyle = state.activeReferenceStyleContract
    if (
      referenceStyle?.contract.strictness === 'exact'
      && state.website.entryPath
      && /\.html?$/iu.test(target)
    ) {
      const entryTarget = resolveWorkspacePath(workspace, state.website.entryPath)
      await assertNoSymlinkTraversal(workspace, entryTarget)
      if (entryTarget === target) {
        const fontEvidence = referenceStyle.fontEvidence
        if (!fontEvidence) {
          throw statusError('Exact reference download is unavailable because its private font evidence is missing', 409)
        }
        if (fontEvidence.sourceEvidenceSha256 !== referenceStyle.provenance.evidenceSha256) {
          throw statusError('Exact reference download is unavailable because its font evidence is bound to another source', 409)
        }
        const resolvedFonts = await store.resolveReferenceFontEvidence(id, fontEvidence)
        const sourceHtml = await readFile(target, 'utf8')
        assertReferenceLanguageDelivery(sourceHtml, resolvedFonts.fontCss, referenceStyle.languageVariant)
        const html = injectWorkspaceReferenceFonts(
          sourceHtml,
          resolvedFonts.fontCss,
          fontEvidence.manifestSha256,
        )
        response.setHeader('cache-control', 'private, no-store')
        response.setHeader('x-anera-reference-font-manifest-sha256', fontEvidence.manifestSha256)
        response.send(html)
        return
      }
    }
    createReadStream(target).pipe(response)
  })

  app.get('/api/sessions/:id/artifact-preview', async (request, response) => {
    const path = typeof request.query.path === 'string' ? request.query.path : ''
    if (!path) throw new Error('path query parameter is required')
    const extension = extname(path).toLowerCase()
    if (!['.docx', '.xlsx', '.pptx'].includes(extension)) throw statusError('Rich document preview supports DOCX, XLSX, and PPTX', 400)
    const target = resolveWorkspacePath(store.workspaceDir(request.params.id), path)
    await assertNoSymlinkTraversal(store.workspaceDir(request.params.id), target)
    const info = await stat(target)
    if (!info.isFile()) throw new Error('Path is not a file')
    if (info.size > 25 * 1024 * 1024) throw statusError('Document preview is limited to 25 MiB', 400)
    const preview = await extractAttachmentPage(target, 1_500_000)
    if (!['docx', 'xlsx', 'pptx'].includes(preview.format)) throw new Error('Unsupported rich document preview format')
    response.setHeader('cache-control', 'no-cache')
    response.json({ path, name: basename(path), ...preview })
  })

  app.get('/api/sessions/:id/workspace.zip', async (request, response) => {
    await store.get(request.params.id)
    response.attachment(`anera-${request.params.id}.zip`)
    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.on('error', (error) => response.destroy(error))
    archive.pipe(response)
    archive.directory(store.workspaceDir(request.params.id), false, (entry) => {
      if (entry.stats?.isSymbolicLink() || isWorkspaceSnapshotExcludedPath(entry.name)) return false
      return entry
    })
    await archive.finalize()
  })

  app.post('/api/sessions/:id/website/restart', async (request, response) => {
    const id = request.params.id
    let restart = websiteRestartRequests.get(id)
    if (!restart) {
      restart = (async () => {
        const state = await store.get(id)
        const anchor = [...await store.events(id)].reverse().find((event) => (
          event.type === 'website.updated' || event.type === 'assistant.final'
        ))
        const eventContext = anchor
          ? { turnId: anchor.turnId, stepId: anchor.stepId, callId: anchor.callId }
          : {}
        const starting = { ...state.website, status: 'starting' as const, updatedAt: new Date().toISOString() }
        await store.recordWebsiteUpdate(id, starting, { action: 'restart' }, eventContext)
        try {
          let exactPreviewUrl: string | undefined
          if (state.activeReferenceStyleContract?.contract.strictness === 'exact') {
            const fontEvidence = state.activeReferenceStyleContract.fontEvidence
            const entryPath = state.website.entryPath
            if (!fontEvidence || !entryPath) {
              throw new Error('Exact reference Website restart requires its verified entry and private font evidence')
            }
            if (fontEvidence.sourceEvidenceSha256 !== state.activeReferenceStyleContract.provenance.evidenceSha256) {
              throw new Error('Exact reference Website restart font evidence is bound to another source')
            }
            await store.resolveReferenceFontEvidence(id, fontEvidence)
            exactPreviewUrl = `/workspace/${id}/preview/${encodeWorkspaceUrlPath(entryPath)}`
          }
          if (state.website.processId) {
            const durableProcess = state.processes.find((process) => process.id === state.website.processId)
            if (!durableProcess) throw new Error('Managed Website process record not found')
            const process = await agent.processes.restartFromRecord(id, store.workspaceDir(id), durableProcess, eventContext)
            if (!process.port || process.status !== 'running') throw new Error('Restarted process did not report a live port')
            const running = {
              status: 'running' as const,
              processId: process.id,
              port: process.port,
              ...(state.website.entryPath ? { entryPath: state.website.entryPath } : {}),
              previewUrl: exactPreviewUrl ?? `http://127.0.0.1:${process.port}`,
              restartCount: state.website.restartCount + 1,
              updatedAt: new Date().toISOString(),
            }
            await store.recordWebsiteUpdate(id, running, { action: 'restarted', previousProcessId: state.website.processId }, eventContext)
            await agent.scheduleWebsiteSleep(id)
            return running
          }
          const entryPath = state.website.entryPath || await findWebsiteEntry(store.workspaceDir(id))
          if (!entryPath) throw new Error('No website entry file found')
          const entryTarget = resolveWorkspacePath(store.workspaceDir(id), entryPath)
          await assertNoSymlinkTraversal(store.workspaceDir(id), entryTarget)
          if (!(await stat(entryTarget)).isFile()) throw new Error('Website entry is not a file')
          const running = {
            ...starting,
            status: 'running' as const,
            entryPath,
            previewUrl: `/workspace/${id}/preview/${encodeWorkspaceUrlPath(entryPath)}`,
            restartCount: state.website.restartCount + 1,
            updatedAt: new Date().toISOString(),
          }
          await store.recordWebsiteUpdate(id, running, { action: 'restarted' }, eventContext)
          return running
        } catch (error) {
          const failed = { ...starting, status: 'failed' as const, updatedAt: new Date().toISOString() }
          await store.recordWebsiteUpdate(id, failed, { action: 'restart_failed', message: error instanceof Error ? error.message : String(error) }, eventContext)
          throw error
        }
      })()
      websiteRestartRequests.set(id, restart)
    }
    try {
      response.json({ website: await restart })
    } finally {
      if (websiteRestartRequests.get(id) === restart) websiteRestartRequests.delete(id)
    }
  })

  app.get('/workspace/:id/file', async (request, response) => {
    const path = typeof request.query.path === 'string' ? request.query.path : ''
    const target = resolveWorkspacePath(store.workspaceDir(request.params.id), path)
    await assertNoSymlinkTraversal(store.workspaceDir(request.params.id), target)
    const info = await stat(target)
    if (!info.isFile()) throw new Error('Path is not a file')
    const contentType = mime.lookup(target) || 'application/octet-stream'
    response.type(contentType)
    if (isActiveWorkspaceContent(contentType)) setWorkspaceSecurityHeaders(response)
    createReadStream(target).pipe(response)
  })

  app.use('/workspace/:id/preview', async (request, response, next) => {
    try {
      const id = request.params.id
      const state = await store.get(id)
      const requested = decodeURIComponent(request.path).replace(/^\/+/, '') || state.website.entryPath || 'index.html'
      let target = resolveWorkspacePath(store.workspaceDir(id), requested)
      await assertNoSymlinkTraversal(store.workspaceDir(id), target)
      const info = await stat(target)
      if (info.isDirectory()) {
        target = resolve(target, 'index.html')
        await assertNoSymlinkTraversal(store.workspaceDir(id), target)
      }
      const contentType = mime.lookup(target) || 'application/octet-stream'
      response.type(contentType)
      if (isActiveWorkspaceContent(contentType)) setWorkspaceSecurityHeaders(response)
      response.setHeader('cache-control', 'no-cache')
      const referenceStyle = state.activeReferenceStyleContract
      const exactReference = referenceStyle?.contract.strictness === 'exact'
      const elementPicker = request.query.aneraElementPicker === '1'
      if (contentType === 'text/html' && (exactReference || elementPicker)) {
        let html = await readFile(target, 'utf8')
        if (exactReference) {
          const fontEvidence = referenceStyle?.fontEvidence
          if (!fontEvidence) {
            throw statusError('Exact reference preview is unavailable because its private font evidence is missing', 409)
          }
          if (fontEvidence.sourceEvidenceSha256 !== referenceStyle?.provenance.evidenceSha256) {
            throw statusError('Exact reference preview is unavailable because its font evidence is bound to another source', 409)
          }
          const resolvedFonts = await store.resolveReferenceFontEvidence(id, fontEvidence)
          assertReferenceLanguageDelivery(html, resolvedFonts.fontCss, referenceStyle?.languageVariant)
          html = injectWorkspaceReferenceFonts(html, resolvedFonts.fontCss, fontEvidence.manifestSha256)
          response.setHeader('cache-control', 'private, no-store')
        }
        if (elementPicker) html = injectWorkspaceElementPicker(html)
        response.send(html)
        return
      }
      createReadStream(target).pipe(response)
    } catch (error) {
      next(error)
    }
  })

  app.use('/deployments/:id', async (request, response, next) => {
    try {
      const id = request.params.id
      const state = await store.get(id)
      if (state.deployment.revision < 1 || !state.deployment.entryPath) throw new Error('Deployment not found')
      const root = store.deploymentRevisionDir(id, state.deployment.revision)
      const requested = decodeURIComponent(request.path).replace(/^\/+/, '') || state.deployment.entryPath
      let target = resolveWorkspacePath(root, requested)
      await assertNoSymlinkTraversal(root, target)
      const info = await stat(target)
      if (info.isDirectory()) {
        target = resolve(target, 'index.html')
        await assertNoSymlinkTraversal(root, target)
      }
      const contentType = mime.lookup(target) || 'application/octet-stream'
      response.type(contentType)
      if (isActiveWorkspaceContent(contentType)) setWorkspaceSecurityHeaders(response)
      response.setHeader('cache-control', 'no-cache')
      createReadStream(target).pipe(response)
    } catch (error) {
      next(error)
    }
  })

  const clientRoot = resolve(config.projectRoot, 'dist-client')
  try {
    if ((await stat(clientRoot)).isDirectory()) {
      app.use(express.static(clientRoot))
      app.get('*path', (_request, response) => response.sendFile(resolve(clientRoot, 'index.html')))
    }
  } catch {
    // Vite serves the client in development.
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof GitHubConnectorError) {
      if (!response.headersSent) response.status(error.statusCode).json({ error: error.code })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    const coded = error as { code?: string; statusCode?: number }
    const status = coded.statusCode
      ?? (/not found/i.test(message) ? 404 : /invalid|required|empty|outside|exceeds|blocked|unavailable|symlink|traversal/i.test(message) ? 400 : 500)
    if (!response.headersSent) response.status(status).json({ error: message, ...(coded.code ? { code: coded.code } : {}) })
  })

  await mkdir(dataRoot, { recursive: true })
  return { app, store, agent, credits, github }
}

const CAS_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SIGNED_AGENT_UPLOAD_TTL_MS = 15 * 60 * 1000

interface SignedAgentUpload {
  uploadId: string
  token: string
  hash: string
  contentType: string
  size: number
  expiresAt: number
}

interface AgentCasMetadata {
  hash: string
  contentType: string
  size: number
}

interface ArenaCreateChatUpload extends ArenaUploadDescriptor {
  content: Buffer
  hash: string
}

interface ArenaCreateChatInput {
  messageId: string
  content: string
  uploads: ArenaCreateChatUpload[]
  timezone: string
  modelId?: string
}

async function loadLocalUserId(dataRoot: string): Promise<string> {
  const target = resolve(dataRoot, 'local-user-id')
  try {
    const existing = (await readFile(target, 'utf8')).trim()
    if (!UUID_PATTERN.test(existing)) throw new Error('Stored local user id is invalid')
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const candidate = randomUUID()
  try {
    await writeFile(target, `${candidate}\n`, { encoding: 'utf8', flag: 'wx' })
    return candidate
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = (await readFile(target, 'utf8')).trim()
    if (!UUID_PATTERN.test(existing)) throw new Error('Stored local user id is invalid')
    return existing
  }
}

function createLocalUploadId(): string {
  return `upl_${randomUUID().replaceAll('-', '').slice(0, 20)}`
}

function sha256Base64Url(content: Buffer): string {
  return createHash('sha256').update(content).digest('base64url')
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function expireSignedAgentUploads(records: Map<string, SignedAgentUpload>): void {
  const now = Date.now()
  for (const [id, record] of records) {
    if (record.expiresAt <= now) records.delete(id)
  }
}

async function readAgentCasMetadata(agentCasRoot: string, hash: string): Promise<AgentCasMetadata> {
  try {
    const parsed = JSON.parse(await readFile(resolve(agentCasRoot, `${hash}.json`), 'utf8')) as unknown
    if (!isRecord(parsed)
      || parsed.hash !== hash
      || typeof parsed.contentType !== 'string'
      || !parsed.contentType
      || !Number.isInteger(parsed.size)
      || (parsed.size as number) < 0) {
      throw statusError('CAS metadata is invalid', 500)
    }
    return { hash, contentType: parsed.contentType, size: parsed.size as number }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw statusError('CAS file not found', 404)
    throw error
  }
}

function safeAgentUploadName(name: string): string {
  const safeName = basename(name).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 160)
  if (!safeName || safeName === '.' || safeName === '..') throw statusError('Invalid upload file name', 400)
  return safeName
}

function agentUploadPolicyName(contentType: string): string {
  const office = AGENT_OOXML_UPLOAD_TYPES.find((type) => type.mime === contentType)
  if (office) return `upload${office.extension}`
  return contentType === 'application/pdf' ? 'upload.pdf' : 'upload'
}

function parseLocalConnectorHeader(value: string | undefined): string[] {
  if (!value) return []
  const slugs = value.split(',').map((slug) => slug.trim()).filter(Boolean)
  if (slugs.some((slug) => !/^[a-z0-9-]{1,40}$/.test(slug))) {
    throw statusError('x-anera-enabled-connectors is invalid', 400)
  }
  return [...new Set(slugs)]
}

async function parseArenaCreateChatTransport(
  rawBody: unknown,
  options: { agentCasRoot: string; localUserId: string },
): Promise<ArenaCreateChatInput> {
  if (!isRecord(rawBody)) throw statusError('create-chat body must be an object', 400)
  const allowedBodyKeys = ['message', 'recaptchaV2Token', 'recaptchaV3Token', 'timezone', 'modelId']
  if (Object.keys(rawBody).some((key) => !allowedBodyKeys.includes(key))) {
    throw statusError('create-chat body contains unsupported fields', 400)
  }
  if (typeof rawBody.timezone !== 'string' || !rawBody.timezone) {
    throw statusError('timezone must be a non-empty string', 400)
  }
  if (rawBody.modelId !== undefined && (typeof rawBody.modelId !== 'string' || !rawBody.modelId)) {
    throw statusError('modelId must be a non-empty string when provided', 400)
  }
  const hasV2 = hasOwn(rawBody, 'recaptchaV2Token')
  const hasV3 = hasOwn(rawBody, 'recaptchaV3Token')
  if (hasV2) {
    if (typeof rawBody.recaptchaV2Token !== 'string' || !rawBody.recaptchaV2Token) {
      throw statusError('recaptchaV2Token must be a non-empty string', 400)
    }
    if (!hasV3 || rawBody.recaptchaV3Token !== null) {
      throw statusError('recaptchaV3Token must be null when recaptchaV2Token is present', 400)
    }
  } else if (!hasV3 || (rawBody.recaptchaV3Token !== null && typeof rawBody.recaptchaV3Token !== 'string')) {
    throw statusError('recaptchaV3Token must be a string or null', 400)
  }

  if (!isRecord(rawBody.message)) throw statusError('message must be an object', 400)
  const message = rawBody.message
  if (Object.keys(message).some((key) => !['id', 'role', 'parts', 'metadata'].includes(key))) {
    throw statusError('create-chat message contains unsupported fields', 400)
  }
  if (typeof message.id !== 'string' || !UUID_V7_PATTERN.test(message.id)) {
    throw statusError('message.id must be a UUIDv7', 400)
  }
  if (message.role !== 'user') throw statusError('message.role must be user', 400)
  if (!Array.isArray(message.parts)) throw statusError('message.parts must be an array', 400)

  const descriptors = parseArenaUploadDescriptors(message.metadata)
  if (descriptors.some((upload) => upload.kind !== undefined && upload.kind !== 'html_element_selection')) {
    throw statusError('Unsupported Agent upload kind', 400)
  }
  if (descriptors.length === 0 && hasOwn(message, 'metadata')) {
    throw statusError('message.metadata requires at least one upload', 400)
  }

  let textIndex = -1
  let content = ''
  const fileParts: Array<{ index: number; url: string; mediaType: string; filename: string }> = []
  for (const [index, rawPart] of message.parts.entries()) {
    if (!isRecord(rawPart) || typeof rawPart.type !== 'string') {
      throw statusError('Each create-chat message part must be an object with a type', 400)
    }
    if (rawPart.type === 'text') {
      if (textIndex >= 0) throw statusError('message.parts may contain only one text part', 400)
      if (Object.keys(rawPart).some((key) => key !== 'type' && key !== 'text') || typeof rawPart.text !== 'string') {
        throw statusError('text message part must contain only a string text field', 400)
      }
      if (!rawPart.text || rawPart.text !== rawPart.text.trim()) {
        throw statusError('create-chat text must be non-empty and trimmed', 400)
      }
      textIndex = index
      content = rawPart.text
      continue
    }
    if (rawPart.type === 'file') {
      if (Object.keys(rawPart).some((key) => !['type', 'url', 'mediaType', 'filename'].includes(key))
        || typeof rawPart.url !== 'string'
        || typeof rawPart.mediaType !== 'string'
        || typeof rawPart.filename !== 'string'
        || !rawPart.mediaType.startsWith('image/')) {
        throw statusError('create-chat file parts must be image file descriptors', 400)
      }
      fileParts.push({
        index,
        url: rawPart.url,
        mediaType: rawPart.mediaType,
        filename: rawPart.filename,
      })
      continue
    }
    throw statusError(`Unsupported create-chat message part type: ${rawPart.type}`, 400)
  }
  if (fileParts.some((part, index) => part.index !== index)) {
    throw statusError('create-chat file parts must precede text', 400)
  }
  if (textIndex >= 0 && textIndex !== message.parts.length - 1) {
    throw statusError('create-chat text must be the last message part', 400)
  }

  const expectedImages = descriptors.filter((upload) => upload.mediaType.startsWith('image/'))
  if (fileParts.length !== expectedImages.length) {
    throw statusError('create-chat file parts must exactly match image uploads', 400)
  }
  const uploads: ArenaCreateChatUpload[] = []
  let bytesUsed = 0
  for (const descriptor of descriptors) {
    const keyMatch = new RegExp(`^cas/users/${escapeRegExp(options.localUserId)}/([A-Za-z0-9_-]{43})$`).exec(descriptor.key)
    if (!keyMatch) throw statusError('Agent upload key is not in the local user CAS scope', 400)
    const hash = keyMatch[1]
    const metadata = await readAgentCasMetadata(options.agentCasRoot, hash)
    if (metadata.contentType !== descriptor.mediaType) {
      throw statusError('Agent upload mediaType does not match the signed upload', 400)
    }
    const contentBuffer = await readFile(resolve(options.agentCasRoot, hash))
    if (contentBuffer.length !== metadata.size || sha256Base64Url(contentBuffer) !== hash) {
      throw statusError('Agent upload CAS content failed integrity validation', 400)
    }
    const policyError = agentUploadError({
      name: descriptor.filename,
      type: descriptor.mediaType,
      size: contentBuffer.length,
    }, bytesUsed)
    if (policyError) throw statusError(policyError, 400)
    bytesUsed += contentBuffer.length
    uploads.push({ ...descriptor, content: contentBuffer, hash })

    if (descriptor.mediaType.startsWith('image/')) {
      const imageIndex = expectedImages.findIndex((image) => image.key === descriptor.key)
      const part = fileParts[imageIndex]
      const expectedUrl = `/api/chat/workspace/cas/user/${hash}`
      if (!part
        || part.url !== expectedUrl
        || part.mediaType !== descriptor.mediaType
        || part.filename !== descriptor.filename) {
        throw statusError('create-chat file parts must exactly match image uploads', 400)
      }
    }
  }
  if (!content && uploads.length === 0) throw statusError('Message and attachments are empty', 400)

  return {
    messageId: message.id,
    content,
    uploads,
    timezone: rawBody.timezone,
    ...(typeof rawBody.modelId === 'string' ? { modelId: rawBody.modelId } : {}),
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function assertAgentTurnAttachments(store: SessionStore, sessionId: string, attachments: string[]): Promise<void> {
  if (attachments.length === 0) return
  const uploaded = new Map<string, { mime: string }>()
  for (const event of await store.events(sessionId)) {
    if (event.type !== 'file.changed') continue
    const data = event.data as { path?: unknown; operation?: unknown; mime?: unknown }
    if (data.operation !== 'uploaded' || typeof data.path !== 'string') continue
    uploaded.set(data.path, { mime: typeof data.mime === 'string' ? data.mime : '' })
  }

  let bytesUsed = 0
  for (const path of attachments) {
    const metadata = uploaded.get(path)
    if (!metadata) throw statusError(`Attachment not found: ${path}`, 400)
    const target = resolveWorkspacePath(store.workspaceDir(sessionId), path)
    await assertNoSymlinkTraversal(store.workspaceDir(sessionId), target)
    let info
    try {
      info = await stat(target)
    } catch {
      throw statusError(`Attachment not found: ${path}`, 400)
    }
    if (!info.isFile()) throw statusError(`Attachment not found: ${path}`, 400)
    const candidate = { name: basename(path), type: metadata.mime, size: info.size }
    const error = agentUploadError(candidate, bytesUsed)
    if (error) throw statusError(error, 400)
    bytesUsed += info.size
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function parseAgentMessageTransport(
  body: Record<string, unknown>,
  sessionId: string,
): { content: string; attachments: string[]; timezone?: string | null; reviewedNodeId?: string } {
  if (!hasOwn(body, 'message')) {
    const rawAttachments = body.attachments
    if (rawAttachments !== undefined && (
      !Array.isArray(rawAttachments)
      || rawAttachments.some((attachment) => typeof attachment !== 'string')
    )) throw statusError('attachments must be an array of strings', 400)
    const rawReviewedNodeId = body.reviewedNodeId
    if (rawReviewedNodeId !== undefined && typeof rawReviewedNodeId !== 'string') {
      throw statusError('reviewedNodeId must be a string', 400)
    }
    const rawTimezone = body.timezone
    if (rawTimezone !== undefined && rawTimezone !== null && typeof rawTimezone !== 'string') {
      throw statusError('timezone must be a string or null', 400)
    }
    return {
      content: typeof body.content === 'string' ? body.content : '',
      attachments: (rawAttachments ?? []) as string[],
      timezone: rawTimezone as string | null | undefined,
      reviewedNodeId: rawReviewedNodeId,
    }
  }

  if (hasOwn(body, 'content') || hasOwn(body, 'attachments') || hasOwn(body, 'reviewedNodeId') || hasOwn(body, 'timezone')) {
    throw statusError('Structured message cannot be combined with content, attachments, reviewedNodeId, or timezone', 400)
  }
  if (!isRecord(body.message)) throw statusError('message must be an object', 400)
  if (!isRecord(body.metadata)) throw statusError('metadata must be an object for a structured message', 400)
  if (Object.keys(body.metadata).some((key) => key !== 'timezone' && key !== 'submissionSource')) {
    throw statusError('metadata may contain only timezone and submissionSource', 400)
  }
  if (body.metadata.submissionSource !== 'chat_input') {
    throw statusError('metadata.submissionSource must be chat_input', 400)
  }
  if (typeof body.metadata.timezone !== 'string') {
    throw statusError('metadata.timezone must be a string', 400)
  }
  if (body.v2Source !== 'agentic_chat_submit') {
    throw statusError('v2Source must be agentic_chat_submit', 400)
  }

  const message = body.message
  const hasText = hasOwn(message, 'text')
  const hasParts = hasOwn(message, 'parts')
  if (hasText === hasParts) throw statusError('message must contain exactly one of text or parts', 400)
  if (hasText) {
    if (typeof message.text !== 'string') throw statusError('message.text must be a string', 400)
    if (message.text !== message.text.trim()) throw statusError('message.text must be trimmed', 400)
    if (hasOwn(message, 'metadata')) throw statusError('message.metadata requires a parts message', 400)
    if (Object.keys(message).some((key) => key !== 'text')) {
      throw statusError('A text message may contain only text', 400)
    }
    return { content: message.text, attachments: [], timezone: body.metadata.timezone }
  }
  if (!Array.isArray(message.parts)) throw statusError('message.parts must be an array', 400)
  if (Object.keys(message).some((key) => key !== 'parts' && key !== 'metadata')) {
    throw statusError('A parts message may contain only parts and metadata', 400)
  }

  const uploadDescriptors = parseArenaUploadDescriptors(message.metadata)
  const attachments = uploadDescriptors.map((upload) => upload.key)

  let customFeedbackIndex = -1
  let textIndex = -1
  const fileParts: Array<{ index: number; url: string; mediaType: string; filename: string }> = []
  let reviewedNodeId: string | undefined
  let content = ''
  for (const [index, rawPart] of message.parts.entries()) {
    if (!isRecord(rawPart) || typeof rawPart.type !== 'string') {
      throw statusError('Each message part must be an object with a type', 400)
    }
    if (rawPart.type === 'data-custom-feedback') {
      if (customFeedbackIndex >= 0) throw statusError('message.parts may contain only one data-custom-feedback part', 400)
      customFeedbackIndex = index
      if (Object.keys(rawPart).some((key) => key !== 'type' && key !== 'data') || !isRecord(rawPart.data)) {
        throw statusError('data-custom-feedback must contain only a data object', 400)
      }
      if (Object.keys(rawPart.data).length !== 2
        || !hasOwn(rawPart.data, 'systemMessage')
        || !hasOwn(rawPart.data, 'reviewedNodeId')) {
        throw statusError('data-custom-feedback.data must contain systemMessage and reviewedNodeId', 400)
      }
      if (rawPart.data.systemMessage !== ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE) {
        throw statusError('data-custom-feedback.systemMessage does not match the trusted marker', 400)
      }
      if (typeof rawPart.data.reviewedNodeId !== 'string') {
        throw statusError('data-custom-feedback.reviewedNodeId must be a string', 400)
      }
      reviewedNodeId = rawPart.data.reviewedNodeId
      if (!reviewedNodeId.trim()) {
        throw statusError('data-custom-feedback.reviewedNodeId must be a non-empty string', 400)
      }
      continue
    }
    if (rawPart.type === 'text') {
      if (textIndex >= 0) throw statusError('message.parts may contain only one text part', 400)
      if (Object.keys(rawPart).some((key) => key !== 'type' && key !== 'text') || typeof rawPart.text !== 'string') {
        throw statusError('text message part must contain only a string text field', 400)
      }
      textIndex = index
      content = rawPart.text
      if (content !== content.trim()) throw statusError('text message part must be trimmed', 400)
      continue
    }
    if (rawPart.type === 'file') {
      if (Object.keys(rawPart).some((key) => !['type', 'url', 'mediaType', 'filename'].includes(key))
        || typeof rawPart.url !== 'string'
        || typeof rawPart.mediaType !== 'string'
        || typeof rawPart.filename !== 'string') {
        throw statusError('file message part must contain only url, mediaType, and filename strings', 400)
      }
      if (!rawPart.mediaType.startsWith('image/')) {
        throw statusError('Only image uploads may appear as file message parts', 400)
      }
      fileParts.push({
        index,
        url: rawPart.url,
        mediaType: rawPart.mediaType,
        filename: rawPart.filename,
      })
      continue
    }
    throw statusError(`Unsupported message part type: ${rawPart.type}`, 400)
  }

  if (customFeedbackIndex > 0) throw statusError('data-custom-feedback must be the first message part', 400)
  const firstNonFeedbackIndex = customFeedbackIndex === 0 ? 1 : 0
  if (fileParts.some((part, index) => part.index !== firstNonFeedbackIndex + index)) {
    throw statusError('file parts must follow custom feedback and precede text', 400)
  }
  if (textIndex >= 0 && textIndex !== message.parts.length - 1) {
    throw statusError('text must be the last message part', 400)
  }
  const expectedImageUploads = uploadDescriptors.filter((upload) => upload.mediaType.startsWith('image/'))
  if (fileParts.length !== expectedImageUploads.length) {
    throw statusError('file parts must exactly match the image uploads', 400)
  }
  for (const [index, upload] of expectedImageUploads.entries()) {
    const part = fileParts[index]
    const expectedUrl = `/api/sessions/${sessionId}/download?path=${encodeURIComponent(upload.key)}`
    if (!part
      || part.url !== expectedUrl
      || part.mediaType !== upload.mediaType
      || part.filename !== upload.filename) {
      throw statusError('file parts must exactly match the image uploads', 400)
    }
  }
  if (textIndex < 0 && fileParts.length === 0) {
    throw statusError('message.parts must contain a text part when there are no image file parts', 400)
  }
  if (textIndex >= 0 && !content && fileParts.length > 0) {
    throw statusError('An empty text part must be omitted when image file parts are present', 400)
  }
  if (uploadDescriptors.length === 0 && !reviewedNodeId) {
    throw statusError('A parts message requires uploads or custom feedback', 400)
  }
  return { content, attachments, timezone: body.metadata.timezone, reviewedNodeId }
}

interface ArenaUploadDescriptor {
  key: string
  filename: string
  mediaType: string
  kind?: string
}

function parseArenaUploadDescriptors(metadata: unknown): ArenaUploadDescriptor[] {
  if (metadata === undefined) return []
  if (!isRecord(metadata)) throw statusError('message.metadata must be an object', 400)
  if (Object.keys(metadata).some((key) => key !== 'manifestNodeId' && key !== 'uploads')) {
    throw statusError('message.metadata may contain only manifestNodeId and uploads', 400)
  }
  if (metadata.manifestNodeId !== null) {
    throw statusError('message.metadata.manifestNodeId must be null for a new submission', 400)
  }
  if (!Array.isArray(metadata.uploads) || metadata.uploads.length === 0) {
    throw statusError('message.metadata.uploads must be a non-empty array', 400)
  }
  const uploads: ArenaUploadDescriptor[] = []
  const keys = new Set<string>()
  for (const rawUpload of metadata.uploads) {
    if (!isRecord(rawUpload)
      || Object.keys(rawUpload).some((key) => !['key', 'filename', 'mediaType', 'kind'].includes(key))
      || typeof rawUpload.key !== 'string'
      || typeof rawUpload.filename !== 'string'
      || typeof rawUpload.mediaType !== 'string'
      || (rawUpload.kind !== undefined && typeof rawUpload.kind !== 'string')) {
      throw statusError('Each upload descriptor must contain key, filename, and mediaType strings', 400)
    }
    if (!rawUpload.key || !rawUpload.filename || !rawUpload.mediaType) {
      throw statusError('Upload descriptor fields must be non-empty', 400)
    }
    if (keys.has(rawUpload.key)) throw statusError('Upload descriptor keys must be unique', 400)
    keys.add(rawUpload.key)
    uploads.push({
      key: rawUpload.key,
      filename: rawUpload.filename,
      mediaType: rawUpload.mediaType,
      ...(rawUpload.kind ? { kind: rawUpload.kind } : {}),
    })
  }
  return uploads
}

function statusError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

function parseWorkspaceInventoryCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) {
    throw statusError('Workspace inventory cursor must be a non-empty string', 400)
  }
  return value
}

function parseWorkspaceInventoryLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw statusError(`Workspace inventory limit must be an integer from 1 to ${WORKSPACE_INVENTORY_MAX_LIMIT}`, 400)
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_INVENTORY_MAX_LIMIT) {
    throw statusError(`Workspace inventory limit must be an integer from 1 to ${WORKSPACE_INVENTORY_MAX_LIMIT}`, 400)
  }
  return limit
}

function workspaceInventoryMetadata(page: {
  entries: WorkspaceInventoryEntry[]
  hasMore: boolean
  nextCursor?: string
  truncated: boolean
  totalFiles: number
  fileLimitHit: boolean
  entryLimitHit: boolean
  totalFilesIsLowerBound: boolean
}): {
  hasMore: boolean
  nextCursor?: string
  truncated: boolean
  totalFiles: number
  loadedEntries: number
  fileLimitHit: boolean
  entryLimitHit: boolean
  totalFilesIsLowerBound: boolean
} {
  return {
    hasMore: page.hasMore,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    truncated: page.truncated,
    totalFiles: page.totalFiles,
    loadedEntries: page.entries.length,
    fileLimitHit: page.fileLimitHit,
    entryLimitHit: page.entryLimitHit,
    totalFilesIsLowerBound: page.totalFilesIsLowerBound,
  }
}

function workspaceInventoryTree(entries: WorkspaceInventoryEntry[]): WorkspaceEntry[] {
  const roots: WorkspaceEntry[] = []
  const nodes = new Map<string, WorkspaceEntry>()

  const addToParent = (node: WorkspaceEntry): void => {
    const separator = node.path.lastIndexOf('/')
    if (separator < 0) {
      roots.push(node)
      return
    }
    const parentPath = node.path.slice(0, separator)
    ensureDirectory(parentPath).children!.push(node)
  }

  const ensureDirectory = (path: string): WorkspaceEntry => {
    const existing = nodes.get(path)
    if (existing) {
      if (existing.type !== 'directory') throw new Error('Workspace inventory contains a file/directory path collision')
      return existing
    }
    const separator = path.lastIndexOf('/')
    const directory: WorkspaceEntry = {
      name: separator < 0 ? path : path.slice(separator + 1),
      path,
      type: 'directory',
      children: [],
    }
    nodes.set(path, directory)
    addToParent(directory)
    return directory
  }

  for (const entry of entries) {
    if (entry.type === 'directory') {
      ensureDirectory(entry.path)
      continue
    }
    if (nodes.has(entry.path)) throw new Error('Workspace inventory contains duplicate or conflicting paths')
    const file: WorkspaceEntry = {
      name: entry.name,
      path: entry.path,
      type: 'file',
      size: entry.size,
    }
    nodes.set(entry.path, file)
    addToParent(file)
  }

  const sortTree = (items: WorkspaceEntry[]): void => {
    items.sort((left, right) => (
      Number(right.type === 'directory') - Number(left.type === 'directory')
      || left.name.localeCompare(right.name)
    ))
    for (const item of items) if (item.type === 'directory') sortTree(item.children ?? [])
  }
  sortTree(roots)
  return roots
}

function reviewFeedbackTarget(
  state: StoredSession,
  events: SessionEvent[],
  sessionNodeId: string,
  feedbackType: AgentFeedbackType,
): SessionEvent {
  const cohort = state.summary.feedbackType ?? 'check_in'
  if (cohort !== feedbackType) {
    throw statusError(`Session does not use ${feedbackType} feedback`, 409)
  }
  const target = events.find((event) => event.id === sessionNodeId && event.type === 'assistant.final')
  if (!target) throw statusError('Final message not found', 404)
  const latestFinal = [...events].reverse().find((event) => event.type === 'assistant.final')
  const reviewRequested = events.some((event) => {
    if (event.type !== 'review.requested') return false
    const data = event.data as { messageEventId?: string; feedbackType?: AgentFeedbackType }
    return data.messageEventId === target.id && (data.feedbackType ?? cohort) === feedbackType
  })
  if (state.summary.status !== 'completed' || latestFinal?.id !== target.id || !reviewRequested) {
    const label = feedbackType === 'task_completion_bar' ? 'task completion' : 'check-in'
    throw statusError(`Final message is not awaiting ${label} feedback`, 409)
  }
  return target
}

function terminalCheckInEventMatches(event: SessionEvent, messageEventId: string): boolean {
  const data = event.data as { messageEventId?: string; value?: unknown; action?: unknown }
  if (data.messageEventId !== messageEventId) return false
  return (event.type === 'feedback.updated' && (data.value === 'upvote' || data.value === 'downvote'))
    || (event.type === 'review.dismissed' && (data.action === 'continue' || data.action === 'dismiss'))
}

function checkInActionFromEvent(event: SessionEvent): TaskReviewFeedbackAction | undefined {
  const data = event.data as { checkInAction?: unknown; value?: unknown; action?: unknown }
  if (data.checkInAction === 'approve' || data.checkInAction === 'disapprove' || data.checkInAction === 'edit' || data.checkInAction === 'escape') {
    return data.checkInAction
  }
  if (event.type === 'feedback.updated') {
    if (data.value === 'upvote') return 'approve'
    if (data.value === 'downvote') return 'disapprove'
  }
  if (event.type === 'review.dismissed') {
    if (data.action === 'continue') return 'edit'
    if (data.action === 'dismiss') return 'escape'
  }
  return undefined
}

interface TurnUndoTarget {
  final: SessionEvent
  promptText: string
  targetTurnIds: string[]
}

function turnUndoTarget(
  state: StoredSession,
  events: SessionEvent[],
  sessionNodeId: string,
): TurnUndoTarget {
  if ((state.summary.feedbackType ?? 'check_in') !== 'check_in') {
    throw statusError('Session does not use check_in feedback', 409)
  }
  if (state.summary.status !== 'completed') throw statusError('Only a completed turn can be undone', 409)

  const undoneTurnIds = new Set(events.flatMap((event) => {
    if (event.type !== 'turn.undone') return []
    const values = (event.data as { targetTurnIds?: unknown }).targetTurnIds
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : []
  }))
  const activeEvents = events.filter((event) => !event.turnId || !undoneTurnIds.has(event.turnId))
  const final = activeEvents.find((event) => event.id === sessionNodeId && event.type === 'assistant.final')
  if (!final) throw statusError('Final message not found', 404)
  const latestFinal = [...activeEvents].reverse().find((event) => event.type === 'assistant.final')
  if (latestFinal?.id !== final.id) throw statusError('Only the last turn can be undone', 409)

  const disapproved = activeEvents.some((event) => (
    terminalCheckInEventMatches(event, final.id) && checkInActionFromEvent(event) === 'disapprove'
  ))
  if (!disapproved) throw statusError('The last turn is not awaiting undo after disapprove feedback', 409)

  const finalIndex = activeEvents.findIndex((event) => event.id === final.id)
  let promptEvent: SessionEvent | undefined
  for (let index = finalIndex; index >= 0; index -= 1) {
    if (activeEvents[index]?.type === 'turn.started') {
      promptEvent = activeEvents[index]
      break
    }
  }
  if (!promptEvent?.turnId) throw statusError('The last user prompt cannot be restored', 409)
  const compacted = activeEvents.some((event) => (
    event.type === 'context.compacted' && event.seq > promptEvent!.seq
  ))
  if (compacted) throw statusError('The last turn cannot be undone after a context checkpoint', 409)

  const targetTurnIds = [...new Set(activeEvents
    .filter((event) => event.seq >= promptEvent!.seq && event.turnId)
    .map((event) => event.turnId as string))]
  return {
    final,
    promptText: String((promptEvent.data as { content?: unknown }).content ?? ''),
    targetTurnIds,
  }
}

function parseCodingSessionInput(value: unknown): CodingSessionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubConnectorError('repo_not_found', 'Invalid repository selection.', 400)
  }
  const input = value as Record<string, unknown>
  if (!Number.isSafeInteger(input.repoId) || typeof input.repoOwner !== 'string' || typeof input.repoName !== 'string') {
    throw new GitHubConnectorError('repo_not_found', 'Invalid repository selection.', 400)
  }
  if (typeof input.baseBranch !== 'string' || !input.baseBranch) {
    throw new GitHubConnectorError('branch_not_found', 'Select a branch before starting a coding session.', 400)
  }
  if (typeof input.message !== 'string' || !input.message.trim()) {
    throw new GitHubConnectorError('repo_bootstrap_failed', 'Message is required.', 400)
  }
  return {
    repoId: input.repoId as number,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    baseBranch: input.baseBranch,
    message: input.message,
  }
}

function sendOAuthPopupResult(response: Response, result: { success: boolean; error?: string }): void {
  const payload = JSON.stringify({ type: 'coding-github-oauth', ...result }).replace(/</g, '\\u003c')
  response.status(200)
  response.type('html')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
  response.send(`<!doctype html><meta charset="utf-8"><title>GitHub connection</title><script>window.opener?.postMessage(${payload}, window.location.origin);window.close()</script>`)
}

function writeSse(response: Response, event: { id: string; seq: number }): void {
  response.write(`id: ${event.seq}\n`)
  response.write(`event: session-event\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

export const WORKSPACE_CONTENT_SECURITY_POLICY = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const WORKSPACE_ELEMENT_PICKER_BOOTSTRAP = String.raw`<script data-anera-element-picker-bootstrap>
(() => {
  const MESSAGE_PREFIX = 'anera.element-picker.';
  let active = false;
  let highlighted = null;
  let outline = null;
  let hint = null;

  const post = (type, selection) => parent.postMessage({ type: MESSAGE_PREFIX + type, ...(selection ? { selection } : {}) }, '*');
  const escapePart = (value) => typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(value)
    : String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => '\\' + character);
  const selectorFor = (element) => {
    if (!(element instanceof Element)) return '';
    if (element.id) return '#' + escapePart(element.id);
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const stableClasses = [...current.classList].filter((name) => !name.startsWith('anera-')).slice(0, 2);
      if (stableClasses.length) part += stableClasses.map((name) => '.' + escapePart(name)).join('');
      const parentElement = current.parentElement;
      if (parentElement) {
        const peers = [...parentElement.children].filter((child) => child.tagName === current.tagName);
        if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      if (parentElement && parentElement.id) {
        parts.unshift('#' + escapePart(parentElement.id));
        break;
      }
      current = parentElement;
      if (parts.length >= 7) break;
    }
    return parts.join(' > ');
  };
  const removeChrome = () => {
    outline?.remove();
    hint?.remove();
    outline = null;
    hint = null;
    highlighted = null;
  };
  const drawOutline = (element) => {
    if (highlighted === element && outline) return;
    highlighted = element;
    outline?.remove();
    const bounds = element.getBoundingClientRect();
    outline = document.createElement('div');
    outline.setAttribute('data-anera-element-picker-outline', '');
    Object.assign(outline.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
      left: bounds.left + 'px', top: bounds.top + 'px', width: bounds.width + 'px', height: bounds.height + 'px',
      border: '2px solid #3190e8', background: 'rgba(49,144,232,.10)', boxSizing: 'border-box',
    });
    document.documentElement.append(outline);
  };
  const onPointerMove = (event) => {
    const target = event.target;
    if (active && target instanceof Element && !target.hasAttribute('data-anera-element-picker-hint')) drawOutline(target);
  };
  const onClick = (event) => {
    if (!active || !(event.target instanceof Element)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const element = event.target;
    const selection = {
      selector: selectorFor(element).slice(0, 500),
      tagName: element.tagName.toLowerCase().slice(0, 80),
      text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
      outerHTML: element.outerHTML.slice(0, 4000),
    };
    setActive(false);
    post('selected', selection);
  };
  const onKeyDown = (event) => {
    if (!active || event.key !== 'Escape') return;
    event.preventDefault();
    setActive(false);
    post('cancelled');
  };
  const setActive = (next) => {
    active = Boolean(next);
    removeChrome();
    document.documentElement.style.cursor = active ? 'crosshair' : '';
    if (!active) return;
    hint = document.createElement('div');
    hint.setAttribute('data-anera-element-picker-hint', '');
    hint.textContent = 'Click an element in the preview. Press Esc to cancel.';
    Object.assign(hint.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', top: '9px', left: '50%', transform: 'translateX(-50%)',
      border: '1px solid #b9d9f5', borderRadius: '999px', padding: '5px 10px', background: '#f7fbff', color: '#2474b5',
      boxShadow: '0 2px 8px rgba(24,73,112,.16)', font: '11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', whiteSpace: 'nowrap',
    });
    document.documentElement.append(hint);
  };

  addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.type !== 'anera.element-picker.toggle') return;
    setActive(event.data.active);
  });
  addEventListener('pointermove', onPointerMove, true);
  addEventListener('click', onClick, true);
  addEventListener('keydown', onKeyDown, true);
  post('ready');
})();
</script>`

export function injectWorkspaceElementPicker(html: string): string {
  const closingBody = html.search(/<\/body\s*>/i)
  if (closingBody < 0) return `${html}${WORKSPACE_ELEMENT_PICKER_BOOTSTRAP}`
  return `${html.slice(0, closingBody)}${WORKSPACE_ELEMENT_PICKER_BOOTSTRAP}${html.slice(closingBody)}`
}

/**
 * Add verified private font CSS without trusting the candidate document to
 * choose an insertion point or reserve Arena's evidence marker for itself.
 */
export function injectWorkspaceReferenceFonts(
  html: string,
  fontCss: string,
  manifestSha256: string,
): string {
  return injectMaterializedReferenceFonts(html, fontCss, manifestSha256)
}

function isActiveWorkspaceContent(contentType: string): boolean {
  return contentType === 'text/html' || contentType === 'image/svg+xml' || contentType === 'application/xhtml+xml'
}

function setWorkspaceSecurityHeaders(response: Response): void {
  response.setHeader('content-security-policy', WORKSPACE_CONTENT_SECURITY_POLICY)
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
}
