import { createHash } from 'node:crypto'
import { appendFile, link, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import type {
  ArtifactRecord,
  AgentCustomFeedbackArm,
  AgentFeedbackType,
  CodingRepositoryState,
  DeploymentState,
  EstimatedCostStatus,
  EventType,
  ModelMessage,
  PlanState,
  ProcessRecord,
  RunStatus,
  SessionEvent,
  SessionSummary,
  ToolCallRecord,
  UsageTotals,
  SpeechProviderMetering,
  WebsiteState,
} from '../shared/types.js'
import { SESSION_TOKEN_LIMIT_ERROR_MESSAGE } from '../shared/types.js'
import { isWorkspaceSnapshotExcludedPath } from '../shared/workspace-snapshot-policy.js'
import { arenaToolErrorResult } from './arena-tool-result.js'
import { createWorkspaceArtifact } from './artifact.js'
import {
  readVerifiedStaticDeploymentSnapshot,
  removeStaticDeploymentSnapshot,
  type StaticDeploymentSnapshot,
} from './deployment.js'
import { createId } from './ids.js'
import { validateAgentUploadBytes } from './agent-upload-validation.js'
import { terminateRecoveredManagedProcess, type ManagedProcessRecoveryResult } from './process-manager.js'
import { findSensitiveValues, redactDisplayValue, redactText } from './redaction.js'
import {
  assertNoSymlinkTraversal,
  resolveWorkspacePath,
  workspaceFileSnapshot,
  workspaceSize,
  type WorkspaceFileSnapshotEntry,
} from './workspace.js'
import { recoverWorkspacePatchTransactions, type WorkspacePatchRecovery } from './workspace-patch.js'

export interface StoredSession {
  summary: SessionSummary
  messages: ModelMessage[]
  /** Durable boundary between materializing a new Session and publishing session.created. */
  pendingCreation?: DurablePendingSessionCreation
  /**
   * Durable upload publications keyed by upload ID. The hidden temporary file
   * contains the verified bytes; the final workspace path is published with an
   * atomic hard link before the preallocated file.changed event is appended.
   */
  pendingUploads?: Record<string, DurablePendingUpload>
  /**
   * Durable workspace-file publications keyed by mutation ID. File bytes are
   * staged outside the visible Workspace before the checkpoint is written;
   * preallocated event IDs make the file and Artifact boundaries replayable
   * exactly once after an OS crash.
   */
  pendingWorkspaceMutations?: Record<string, DurablePendingWorkspaceMutation>
  /** Recoverable all-or-none publication of multiple already-atomic file changes. */
  pendingWorkspaceEventBatches?: Record<string, DurablePendingWorkspaceEventBatch>
  /** Pre-command SHA-256 snapshot and guardian identity for Shell crash reconciliation. */
  pendingShellReconciliations?: Record<string, DurablePendingShellReconciliation>
  /**
   * Durable semantic checkpoint between accepting a user/resume message and
   * publishing the corresponding start event. The preallocated event ID lets
   * startup replay the event exactly once after a crash or torn JSONL append.
   */
  pendingStart?: DurablePendingStart
  /** Durable publication batch for one terminal run outcome. */
  pendingTerminal?: DurablePendingTerminal
  /**
   * Durable publication boundary for Arena's optimistic "undo last turn"
   * action. The private model context is rewound before this event is
   * published; startup completes the append if the process dies in between.
   */
  pendingTurnUndo?: DurablePendingTurnUndo
  /** Private model-message offsets for visible user turns. */
  turnMessageStarts?: Record<string, number>
  /** Exact-only Final constraint for the current real user task; operator Continue inherits it. */
  activeTaskExactFinalRequest?: string
  /** Connector slugs explicitly enabled when the current real user task was submitted. */
  activeTaskConnectorSlugs?: string[]
  /** Last validated browser timezone used to render Arena's dynamic date prompt. */
  timezone?: string
  /** Private provider-usage anchor for projecting the next request's context pressure. */
  contextPressure?: ContextPressureAnchor
  /** Durable active-tool request whose response resumes the same model episode. */
  pendingHitl?: Record<string, DurablePendingHitl>
  /** Durable approval request whose one-shot decision resumes the same tool call. */
  pendingApprovals?: Record<string, DurablePendingApproval>
  /** Explicit compact tool request consumed by the next context preparation. */
  forceCompactionRequested?: { turnId: string; stepId: string; callId: string }
  /** Session-stable public voice ids mapped to provider voices. */
  voices?: Record<string, StoredVoiceSelection>
  /** Next durable public voice-id candidate; advanced in the HITL response transaction. */
  nextVoiceIndex?: number
  /**
   * Private idempotency ledger for provider-backed tool calls. Entries are
   * retained after publication so a duplicate or restart replay cannot bill
   * the same provider response twice.
   */
  usageSettlements?: Record<string, DurableUsageSettlement>
  plan: PlanState | null
  artifacts: ArtifactRecord[]
  processes: ProcessRecord[]
  website: WebsiteState
  deployment: DeploymentState
  /** Private migration marker: revisions created by the checkpoint protocol must retain a valid manifest. */
  deploymentManifestRequired?: boolean
  /**
   * Durable checkpoint spanning static revision creation and publication.
   * The revision manifest proves whether a crash left a complete snapshot;
   * preallocated event IDs make both observable boundaries replayable once.
   */
  pendingDeployment?: DurablePendingDeployment
  repository: CodingRepositoryState | null
}

export interface StoredVoiceSelection {
  providerVoice: string
  language: string
  createdAt: string
  /** Missing only on voice records written before durable owner tracking. */
  sourceCallId?: string
}

export interface CommitVoiceSelectionOptions {
  /** The durable id reserved in the matching add_voice HITL response. */
  voiceId?: string
  providerVoice: string
  language: string
  callId: string
  createdAt?: string
}

export interface DurablePendingSessionCreation {
  eventId: string
  eventData: Record<string, unknown>
  createdAt: string
}

export interface DurablePendingUpload {
  id: string
  preferredPath: string
  path: string
  temporaryPath: string
  bytes: number
  mime: string
  sha256: string
  eventId: string
  createdAt: string
}

export interface UploadedWorkspaceFile {
  path: string
  bytes: number
  mime: string
}

export interface DurablePendingWorkspaceMutation {
  id: string
  kind: 'write' | 'delete'
  mode?: 'create' | 'replace'
  path: string
  operation: string
  bytes: number
  sha256: string
  temporaryPath?: string
  installPath?: string
  beforeBytes?: number
  beforeSha256?: string
  artifact?: ArtifactRecord
  fileEventId: string
  artifactEventId?: string
  context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
  createdAt: string
}

export interface CommitWorkspaceWriteOptions {
  path: string
  content: string | Buffer
  mode: 'create' | 'replace' | 'upsert'
  operation: string
  artifact: ArtifactRecord
  context?: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
  /** Optional compare-before-write guard used by edit_file. */
  expectedBefore?: Buffer
}

export interface CommitWorkspaceDeleteOptions {
  path: string
  operation: string
  context?: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
}

export interface DurableWorkspaceEventBatchChange {
  path: string
  operation: string
  bytes: number
  expected: 'present' | 'missing'
  sha256?: string
  artifact?: ArtifactRecord
  fileEventId: string
  artifactEventId?: string
}

export interface DurablePendingWorkspaceEventBatch {
  id: string
  source: 'apply_patch' | 'shell'
  changes: DurableWorkspaceEventBatchChange[]
  context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
  createdAt: string
}

export interface StageWorkspaceEventBatchOptions {
  source: DurablePendingWorkspaceEventBatch['source']
  changes: Array<{
    path: string
    operation: string
    bytes: number
    expected: 'present' | 'missing'
    sha256?: string
    artifact?: ArtifactRecord
  }>
  context?: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
}

export interface DurableWorkspaceSnapshotEntry {
  path: string
  bytes: number
  sha256: string
}

export interface DurablePendingShellReconciliation {
  id: string
  guardianId: string
  guardianPid?: number
  phase: 'staged' | 'armed'
  before: DurableWorkspaceSnapshotEntry[]
  context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
  createdAt: string
}

interface UploadCheckpointRecovery {
  id: string
  path: string
  eventId: string
  result: 'published' | 'already_published' | 'abandoned'
  reconstructedEvent: boolean
  reassignedPath: boolean
  reason?: 'missing_or_corrupt_bytes' | 'invalid_checkpoint'
}

interface WorkspaceMutationCheckpointRecovery {
  id: string
  kind: 'write' | 'delete' | 'invalid'
  path: string
  fileEventId: string
  result: 'published' | 'already_published' | 'abandoned'
  materialized: boolean
  reconstructedFileEvent: boolean
  reconstructedArtifactEvent: boolean
  reason?:
    | 'invalid_checkpoint'
    | 'missing_or_corrupt_staging'
    | 'create_conflict'
    | 'replace_conflict'
    | 'delete_conflict'
}

interface WorkspaceEventBatchRecovery {
  id: string
  source: DurablePendingWorkspaceEventBatch['source'] | 'invalid'
  result: 'published' | 'already_publishing' | 'abandoned'
  changeCount: number
  reconstructedFileEvents: number
  reconstructedArtifactEvents: number
  reason?: 'invalid_checkpoint' | 'post_image_mismatch'
}

interface ShellReconciliationRecovery {
  id: string
  guardianId: string
  guardianTermination?: ManagedProcessRecoveryResult
  result: 'published' | 'no_changes' | 'invalid_abandoned'
  batchId?: string
  changeCount: number
}

export interface DurablePendingStart {
  kind: 'submit' | 'resume'
  turnId: string
  eventId: string
  eventData: Record<string, unknown>
  createdAt: string
}

export interface DurablePendingHitl {
  id: string
  kind: 'ask_user' | 'propose_plan' | 'add_voice' | 'generate_image'
  call: ToolCallRecord
  title: string
  payload: Record<string, unknown>
  turnId: string
  stepId: string
  callId: string
  /** Zero-based position in the assistant tool-call batch. Required to disambiguate repeated provider ids. */
  callIndex?: number
  createdAt: string
  /** Present on restart-resumable checkpoints; legacy records without it expire fail-closed. */
  requiredEventId?: string
  resolvedEventId?: string
  phase?: 'awaiting_response' | 'response_recorded' | 'executing'
  response?: Record<string, unknown>
}

export interface DurablePendingApproval {
  id: string
  call: ToolCallRecord
  title: string
  description: string
  turnId: string
  stepId: string
  callId: string
  /** Zero-based position in the assistant tool-call batch. Required to disambiguate repeated provider ids. */
  callIndex?: number
  requestSignature: string
  createdAt: string
  requiredEventId: string
  resolvedEventId?: string
  phase: 'awaiting_decision' | 'decision_recorded' | 'executing'
  approved?: boolean
}

export type DurableTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'

export interface DurableTerminalEvent {
  id: string
  type: Extract<EventType,
    | 'workspace.persistence.started'
    | 'workspace.persistence.updated'
    | 'workspace.persistence.completed'
    | 'assistant.final'
    | 'turn.completed'
    | 'run.status'
    | 'review.requested'
    | 'error'
  >
  data: Record<string, unknown>
}

export interface DurablePendingTerminal {
  turnId: string
  stepId?: string
  status: DurableTerminalStatus
  /**
   * Final/turn/run/review (or error) publication lane. Legacy checkpoints may
   * also contain Workspace persistence events here and remain replayable.
   */
  events: DurableTerminalEvent[]
  /**
   * Workspace persistence is an independent observable saga. Arena traces
   * show that this lane can finish either before or after Final/Review, so new
   * completion checkpoints keep it separate while allocating every event id
   * in the same durable state transaction.
   */
  workspacePersistenceEvents?: DurableTerminalEvent[]
  /** Set only after the corresponding lane has been published completely. */
  terminalPublished?: boolean
  workspacePersistencePublished?: boolean
  createdAt: string
}

export interface DurablePendingTurnUndo {
  id: string
  eventId: string
  sessionNodeId: string
  targetTurnIds: string[]
  promptText: string
  messageCountAfter: number
  eventData: Record<string, unknown>
  createdAt: string
}

export interface CommitTurnUndoOptions {
  sessionNodeId: string
  targetTurnIds: string[]
  promptText: string
  beforeCommit: (state: StoredSession, events: SessionEvent[]) => void
}

export type DurableDeploymentCompletionAction = 'deployed' | 'redeployed' | 'deploy_failed' | 'deploy_interrupted'

export interface DurablePendingDeployment {
  /** Unique checkpoint identity; distinct from the stable Deployment ID. */
  id: string
  deploymentId: string
  revision: number
  previous: DeploymentState
  deploying: DeploymentState
  url: string
  visibility: 'local' | 'public'
  createdAt: string
  successAction: Extract<DurableDeploymentCompletionAction, 'deployed' | 'redeployed'>
  phase: 'snapshotting' | 'ready'
  deployingEventId: string
  completionEventId: string
  completed?: DeploymentState
  completionAction?: DurableDeploymentCompletionAction
  context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
}

interface DeploymentCheckpointRecovery {
  checkpointId: string
  revision: number
  phase: 'snapshotting' | 'ready'
  manifestVerified: boolean
  deployingEventReconstructed: boolean
  completionEventReconstructed: boolean
  completionAction: DurableDeploymentCompletionAction
  status: DeploymentState['status']
}

export interface ContextPressureAnchor {
  schemaVersion?: 2
  model: string
  promptTokens: number
  sampledSurfaceTokens: number
  sampledSystemPromptTokens?: number
  sampledToolSurfaceTokens?: number
}

export type DurableUsageSource = 'agent' | 'vision' | 'image_generation' | 'speech' | 'compaction'

export interface DurableUsageSettlement {
  id: string
  source: DurableUsageSource
  turnId: string
  stepId: string
  callId?: string
  model: string
  /** Physical requests represented by this settlement; absent on legacy records. */
  modelRequestCount?: number
  /** Requests with attributable metering; speech may use explicit heuristics. */
  modelCallCount: number
  usage: Pick<UsageTotals, 'promptTokens' | 'completionTokens' | 'totalTokens' | 'cachedPromptTokens'>
  metering?: SpeechProviderMetering
  estimatedCostUsd: number
  estimatedCostStatus?: EstimatedCostStatus
  cumulativeUsageAfter: UsageTotals
  cumulativeCostUsdAfter: number
  settledCreditsBefore: number
  crossedSessionLimit: boolean
  reachedAt?: string
  appliedAt: string
  applicationOrder?: number
  expectedUsageEventId?: string
  expectedLimitEventId?: string
  usageEventId?: string
  limitEventId?: string
}

export interface CreateSessionOptions {
  repository?: CodingRepositoryState
  workspaceSource?: string
  workspaceBytes?: number
  isFreeSession?: boolean
  feedbackType?: AgentFeedbackType
  customFeedbackArm?: AgentCustomFeedbackArm
}

export type EventListener = (event: SessionEvent) => void

const EMPTY_USAGE: UsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedPromptTokens: 0,
  modelRequests: 0,
  estimatedCostUsd: 0,
  modelCalls: 0,
  estimatedCostStatus: 'not_incurred',
  toolCalls: 0,
}

function estimatedCostStatusForUsage(
  usage: Pick<UsageTotals, 'modelRequests' | 'modelCalls'>,
): EstimatedCostStatus {
  const requests = Math.max(usage.modelCalls, usage.modelRequests ?? usage.modelCalls)
  if (requests === 0) return 'not_incurred'
  if (usage.modelCalls === 0) return 'unknown'
  if (usage.modelCalls < requests) return 'partial'
  return 'estimated'
}

function assertSessionId(id: string): void {
  if (!/^ses_[a-z0-9]{20}$/.test(id)) throw new Error('Invalid session id')
}

export class SessionStore {
  private readonly listeners = new Map<string, Set<EventListener>>()
  private readonly writeQueues = new Map<string, Promise<unknown>>()
  private readonly lastSeq = new Map<string, number>()
  private readonly sensitiveValues = new Map<string, Set<string>>()
  private initialized = false
  private initializing?: Promise<void>

  constructor(
    private readonly root: string,
    private readonly model: string,
    private readonly sessionTokenLimit = 1_000_000,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializing) return await this.initializing
    this.initializing = this.initializeOnce()
    try {
      await this.initializing
      this.initialized = true
    } finally {
      this.initializing = undefined
    }
  }

  sessionDir(id: string): string {
    assertSessionId(id)
    return resolve(this.root, 'sessions', id)
  }

  workspaceDir(id: string): string {
    return resolve(this.sessionDir(id), 'workspace')
  }

  workspacePatchTransactionDir(id: string): string {
    return resolve(this.sessionDir(id), 'patch-transactions')
  }

  workspaceMutationStagingDir(id: string): string {
    return resolve(this.sessionDir(id), 'workspace-mutation-staging')
  }

  deploymentRevisionDir(id: string, revision: number): string {
    if (!Number.isInteger(revision) || revision < 1) throw new Error('Deployment revision must be a positive integer')
    return resolve(this.sessionDir(id), 'deployments', `revision-${revision}`)
  }

  private statePath(id: string): string {
    return resolve(this.sessionDir(id), 'state.json')
  }

  private eventsPath(id: string): string {
    return resolve(this.sessionDir(id), 'events.jsonl')
  }

  async create(options: CreateSessionOptions = {}): Promise<StoredSession> {
    const now = new Date().toISOString()
    const id = createId('ses')
    const creationEventData = {
      title: 'New task',
      productMode: options.repository ? 'coding' as const : 'chat' as const,
      repository: options.repository ?? null,
      isFreeSession: options.isFreeSession === true,
      feedbackType: options.feedbackType ?? 'check_in' as const,
      ...(options.customFeedbackArm ? { customFeedbackArm: options.customFeedbackArm } : {}),
    }
    const creationEventId = createId('evt')
    const state: StoredSession = {
      summary: {
        id,
        title: 'New task',
        createdAt: now,
        updatedAt: now,
        status: 'idle',
        model: this.model,
        workspaceBytes: 0,
        usage: { ...EMPTY_USAGE },
        limits: {
          sessionTokens: {
            maxTokens: this.sessionTokenLimit,
            usedTokens: 0,
            remainingTokens: this.sessionTokenLimit,
            reached: false,
            message: SESSION_TOKEN_LIMIT_ERROR_MESSAGE,
          },
        },
        productMode: options.repository ? 'coding' : 'chat',
        ...(options.repository ? { codingSessionStatus: 'active' as const } : {}),
        isFreeSession: options.isFreeSession === true,
        settledCredits: 0,
        feedbackType: options.feedbackType ?? 'check_in',
        ...(options.customFeedbackArm ? { customFeedbackArm: options.customFeedbackArm } : {}),
      },
      messages: [],
      turnMessageStarts: {},
      pendingCreation: {
        eventId: creationEventId,
        eventData: creationEventData,
        createdAt: now,
      },
      plan: null,
      artifacts: [],
      processes: [],
      website: { status: 'stopped', updatedAt: now, restartCount: 0 },
      deployment: { status: 'not_deployed', revision: 0, updatedAt: now },
      repository: options.repository ?? null,
    }
    const sessionDir = this.sessionDir(id)
    let createdSessionDir = false
    try {
      await mkdir(sessionDir, { recursive: false })
      createdSessionDir = true
      if (options.workspaceSource) await rename(options.workspaceSource, this.workspaceDir(id))
      else await mkdir(this.workspaceDir(id), { recursive: false })
      state.summary.workspaceBytes = options.workspaceBytes ?? 0
      await this.writeState(id, state)
      await writeFile(this.eventsPath(id), '', 'utf8')
    } catch (error) {
      if (createdSessionDir) await rm(sessionDir, { recursive: true, force: true })
      throw error
    }
    this.lastSeq.set(id, 0)
    await this.append(id, 'session.created', creationEventData, { eventId: creationEventId })
    return await this.update(id, (committed) => { delete committed.pendingCreation }, { updatedAt: now })
  }

  /**
   * Remove a just-created Session whose atomic create-chat request failed
   * before its id was published to the client. This is deliberately narrower
   * than a user-facing delete operation: a running or terminal Session is
   * never eligible.
   */
  async discardUnpublishedSession(id: string): Promise<void> {
    await this.initialize()
    const queued = this.writeQueues.get(id)
    if (queued) await queued.catch(() => undefined)
    const state = await this.get(id)
    if (['queued', 'running', 'awaiting_approval', 'awaiting_user', 'cancelling', 'completed'].includes(state.summary.status)) {
      throw new Error('Cannot discard a published or active Session')
    }
    if ((await this.events(id)).some((event) => event.type === 'turn.started' || event.type === 'run.status')) {
      throw new Error('Cannot discard a Session after its first turn was published')
    }
    await rm(this.sessionDir(id), { recursive: true, force: true })
    this.listeners.delete(id)
    this.writeQueues.delete(id)
    this.lastSeq.delete(id)
    this.sensitiveValues.delete(id)
  }

  async createUpload(
    id: string,
    preferredPath: string,
    content: Buffer,
    mime: string,
  ): Promise<UploadedWorkspaceFile> {
    await this.initialize()
    await this.get(id)
    validateAgentUploadBytes(preferredPath, mime, content)
    const uploadId = createId('upl')
    const temporaryPath = `upload-staging/${uploadId}.part`
    const temporaryTarget = resolve(this.sessionDir(id), temporaryPath)
    await mkdir(dirname(temporaryTarget), { recursive: true })
    await writeFile(temporaryTarget, content, { flag: 'wx' })

    let pending: DurablePendingUpload
    try {
      pending = await this.stageUpload(id, {
        id: uploadId,
        preferredPath,
        path: preferredPath,
        temporaryPath,
        bytes: content.length,
        mime,
        sha256: createHash('sha256').update(content).digest('hex'),
        eventId: createId('evt'),
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      await rm(temporaryTarget, { force: true })
      throw error
    }

    pending = await this.materializePendingUpload(id, pending.id)
    await this.publishPendingUpload(id, pending.id)
    return { path: pending.path, bytes: pending.bytes, mime: pending.mime }
  }

  private async stageUpload(id: string, candidate: DurablePendingUpload): Promise<DurablePendingUpload> {
    return await this.enqueue(id, async () => {
      const state = await this.get(id)
      const pendingUploads = state.pendingUploads ?? {}
      const path = await allocateUniqueUploadPath(
        this.workspaceDir(id),
        candidate.preferredPath,
        Object.values(pendingUploads).map((pending) => pending.path),
      )
      const pending = { ...candidate, path }
      state.pendingUploads = { ...pendingUploads, [pending.id]: pending }
      state.summary.updatedAt = pending.createdAt
      await this.writeState(id, state)
      return pending
    })
  }

  private async reassignPendingUploadPath(id: string, uploadId: string): Promise<DurablePendingUpload> {
    return await this.enqueue(id, async () => {
      const state = await this.get(id)
      const current = state.pendingUploads?.[uploadId]
      if (!current) throw new Error(`Upload checkpoint ${uploadId} is not active`)
      const path = await allocateUniqueUploadPath(
        this.workspaceDir(id),
        current.preferredPath,
        Object.values(state.pendingUploads ?? {})
          .filter((pending) => pending.id !== uploadId)
          .map((pending) => pending.path),
      )
      const pending = { ...current, path }
      state.pendingUploads = { ...state.pendingUploads, [uploadId]: pending }
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
      return pending
    })
  }

  private async materializePendingUpload(id: string, uploadId: string): Promise<DurablePendingUpload> {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const state = await this.get(id)
      let pending = state.pendingUploads?.[uploadId]
      if (!pending) throw new Error(`Upload checkpoint ${uploadId} is not active`)
      if (!await verifiedFileMatches(resolve(this.sessionDir(id), pending.temporaryPath), pending)) {
        throw new Error(`Upload checkpoint ${uploadId} has missing or corrupt staged bytes`)
      }
      const temporaryTarget = resolve(this.sessionDir(id), pending.temporaryPath)
      const target = resolveWorkspacePath(this.workspaceDir(id), pending.path)
      await assertNoSymlinkTraversal(this.workspaceDir(id), target)
      await mkdir(dirname(target), { recursive: true })
      try {
        await link(temporaryTarget, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (await uploadFileMatches(this.workspaceDir(id), pending.path, pending)) return pending
        pending = await this.reassignPendingUploadPath(id, uploadId)
        continue
      }
      if (!await uploadFileMatches(this.workspaceDir(id), pending.path, pending)) {
        throw new Error(`Upload checkpoint ${uploadId} failed final-byte verification`)
      }
      return pending
    }
    throw new Error('Could not allocate a unique workspace upload path')
  }

  private async publishPendingUpload(id: string, uploadId: string): Promise<void> {
    const pending = (await this.get(id)).pendingUploads?.[uploadId]
    if (!pending) return
    if (!await uploadFileMatches(this.workspaceDir(id), pending.path, pending)) {
      throw new Error(`Upload checkpoint ${uploadId} has no verified final file`)
    }
    const prior = (await this.events(id)).find((event) => event.id === pending.eventId)
    if (prior && !uploadEventMatches(prior, pending)) {
      throw new Error(`Upload event ${pending.eventId} does not match checkpoint ${uploadId}`)
    }
    await this.append(id, 'file.changed', {
      path: pending.path,
      bytes: pending.bytes,
      operation: 'uploaded',
      mime: pending.mime,
    }, { eventId: pending.eventId })
    await this.enqueue(id, async () => {
      const state = await this.get(id)
      if (!state.pendingUploads?.[uploadId]) return
      state.summary.workspaceBytes = await workspaceSize(this.workspaceDir(id))
      delete state.pendingUploads[uploadId]
      if (Object.keys(state.pendingUploads).length === 0) delete state.pendingUploads
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
    })
    await unlink(resolve(this.sessionDir(id), pending.temporaryPath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  async commitWorkspaceWrite(id: string, options: CommitWorkspaceWriteOptions): Promise<number> {
    await this.initialize()
    await this.get(id)
    const target = resolveWorkspacePath(this.workspaceDir(id), options.path)
    await assertNoSymlinkTraversal(this.workspaceDir(id), target)
    const content = Buffer.isBuffer(options.content) ? Buffer.from(options.content) : Buffer.from(options.content)
    const mutationId = createId('wmut')
    const temporaryPath = `workspace-mutation-staging/${mutationId}.part`
    const installPath = `workspace-mutation-staging/${mutationId}.install`
    const temporaryTarget = resolve(this.sessionDir(id), temporaryPath)
    await mkdir(dirname(temporaryTarget), { recursive: true })
    await writeFile(temporaryTarget, content, { flag: 'wx' })

    let pending: DurablePendingWorkspaceMutation
    try {
      pending = await this.enqueue(id, async () => {
        const state = await this.get(id)
        if (Object.values(state.pendingWorkspaceMutations ?? {}).some((item) => item.path === options.path)) {
          throw new Error(`Another workspace mutation is already active for ${options.path}`)
        }
        const artifact = artifactRecordFromValue(options.artifact, id)
        if (!artifact || artifact.path !== options.path) throw new Error('Workspace mutation Artifact does not match its path')
        const before = await inspectWorkspaceFile(target)
        const mode = options.mode === 'upsert'
          ? before.kind === 'file' ? 'replace' as const : before.kind === 'missing' ? 'create' as const : undefined
          : options.mode
        if (!mode) throw new Error(`Path is not a regular file: ${options.path}`)
        if (mode === 'create' && before.kind !== 'missing') throw new Error(`File already exists: ${options.path}`)
        if (mode === 'replace' && before.kind !== 'file') throw new Error(`File does not exist: ${options.path}`)
        if (options.expectedBefore) {
          if (mode !== 'replace') throw new Error(`File changed before edit: ${options.path}`)
          const observed = await readFile(target)
          if (!observed.equals(options.expectedBefore)) throw new Error(`File changed before edit: ${options.path}`)
        }
        const createdAt = new Date().toISOString()
        const checkpoint: DurablePendingWorkspaceMutation = {
          id: mutationId,
          kind: 'write',
          mode,
          path: options.path,
          operation: options.operation,
          bytes: content.length,
          sha256: sha256(content),
          temporaryPath,
          installPath,
          ...(before.kind === 'file' ? { beforeBytes: before.bytes, beforeSha256: before.sha256 } : {}),
          artifact,
          fileEventId: createId('evt'),
          artifactEventId: createId('evt'),
          context: options.context ?? {},
          createdAt,
        }
        state.pendingWorkspaceMutations = {
          ...state.pendingWorkspaceMutations,
          [checkpoint.id]: checkpoint,
        }
        state.summary.updatedAt = createdAt
        await this.writeState(id, state)
        return checkpoint
      })
    } catch (error) {
      await rm(temporaryTarget, { force: true })
      throw error
    }

    const materialized = await this.materializePendingWorkspaceMutation(id, pending)
    if (materialized.reason) {
      await this.discardPendingWorkspaceMutation(id, pending.id)
      throw new Error(workspaceMutationFailureMessage(pending, materialized.reason))
    }
    await this.publishPendingWorkspaceMutation(id, pending.id)
    return pending.bytes
  }

  async commitWorkspaceDelete(id: string, options: CommitWorkspaceDeleteOptions): Promise<void> {
    await this.initialize()
    await this.get(id)
    const target = resolveWorkspacePath(this.workspaceDir(id), options.path)
    await assertNoSymlinkTraversal(this.workspaceDir(id), target)
    const pending = await this.enqueue(id, async () => {
      const state = await this.get(id)
      if (Object.values(state.pendingWorkspaceMutations ?? {}).some((item) => item.path === options.path)) {
        throw new Error(`Another workspace mutation is already active for ${options.path}`)
      }
      const before = await inspectWorkspaceFile(target)
      if (before.kind !== 'file') throw new Error(before.kind === 'missing'
        ? `File does not exist: ${options.path}`
        : `Path is not a regular file: ${options.path}`)
      const artifact = state.artifacts.find((item) => item.path === options.path)
      const createdAt = new Date().toISOString()
      const checkpoint: DurablePendingWorkspaceMutation = {
        id: createId('wmut'),
        kind: 'delete',
        path: options.path,
        operation: options.operation,
        bytes: 0,
        sha256: sha256(Buffer.alloc(0)),
        beforeBytes: before.bytes,
        beforeSha256: before.sha256,
        ...(artifact ? { artifact, artifactEventId: createId('evt') } : {}),
        fileEventId: createId('evt'),
        context: options.context ?? {},
        createdAt,
      }
      state.pendingWorkspaceMutations = {
        ...state.pendingWorkspaceMutations,
        [checkpoint.id]: checkpoint,
      }
      state.summary.updatedAt = createdAt
      await this.writeState(id, state)
      return checkpoint
    })

    const materialized = await this.materializePendingWorkspaceMutation(id, pending)
    if (materialized.reason) {
      await this.discardPendingWorkspaceMutation(id, pending.id)
      throw new Error(workspaceMutationFailureMessage(pending, materialized.reason))
    }
    await this.publishPendingWorkspaceMutation(id, pending.id)
  }

  private async materializePendingWorkspaceMutation(
    id: string,
    pending: DurablePendingWorkspaceMutation,
  ): Promise<{ materialized: boolean; reason?: WorkspaceMutationCheckpointRecovery['reason'] }> {
    const workspace = this.workspaceDir(id)
    let target: string
    try {
      target = resolveWorkspacePath(workspace, pending.path)
      await assertNoSymlinkTraversal(workspace, target)
    } catch {
      return { materialized: false, reason: pending.kind === 'delete' ? 'delete_conflict' : pending.mode === 'create' ? 'create_conflict' : 'replace_conflict' }
    }
    const observed = await inspectWorkspaceFile(target)
    if (pending.kind === 'delete') {
      if (observed.kind === 'missing') return { materialized: false }
      if (
        observed.kind !== 'file'
        || observed.bytes !== pending.beforeBytes
        || observed.sha256 !== pending.beforeSha256
      ) return { materialized: false, reason: 'delete_conflict' }
      await unlink(target)
      if ((await inspectWorkspaceFile(target)).kind !== 'missing') throw new Error(`Workspace delete did not remove ${pending.path}`)
      return { materialized: true }
    }

    if (observed.kind === 'file' && observed.bytes === pending.bytes && observed.sha256 === pending.sha256) {
      return { materialized: false }
    }
    if (!pending.temporaryPath || !pending.installPath) {
      return { materialized: false, reason: 'missing_or_corrupt_staging' }
    }
    const stagedTarget = resolve(this.sessionDir(id), pending.temporaryPath)
    if (!await verifiedFileMatches(stagedTarget, pending)) {
      return { materialized: false, reason: 'missing_or_corrupt_staging' }
    }
    await mkdir(dirname(target), { recursive: true })
    if (pending.mode === 'create') {
      if (observed.kind !== 'missing') return { materialized: false, reason: 'create_conflict' }
      try {
        await link(stagedTarget, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const raced = await inspectWorkspaceFile(target)
        if (raced.kind !== 'file' || raced.bytes !== pending.bytes || raced.sha256 !== pending.sha256) {
          return { materialized: false, reason: 'create_conflict' }
        }
      }
    } else {
      if (
        observed.kind !== 'file'
        || observed.bytes !== pending.beforeBytes
        || observed.sha256 !== pending.beforeSha256
      ) return { materialized: false, reason: 'replace_conflict' }
      const installTarget = resolve(this.sessionDir(id), pending.installPath)
      try {
        await link(stagedTarget, installTarget)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!await verifiedFileMatches(installTarget, pending)) {
          return { materialized: false, reason: 'missing_or_corrupt_staging' }
        }
      }
      // Re-check immediately before the atomic replacement. All Harness-owned
      // writers use the same per-path checkpoint guard; a mismatch is treated
      // as an external/concurrent conflict and is never overwritten.
      const current = await inspectWorkspaceFile(target)
      if (
        current.kind !== 'file'
        || current.bytes !== pending.beforeBytes
        || current.sha256 !== pending.beforeSha256
      ) return { materialized: false, reason: 'replace_conflict' }
      await rename(installTarget, target)
    }
    if (!await verifiedFileMatches(target, pending)) throw new Error(`Workspace mutation ${pending.id} failed final-byte verification`)
    return { materialized: true }
  }

  private async publishPendingWorkspaceMutation(id: string, mutationId: string): Promise<{
    reconstructedFileEvent: boolean
    reconstructedArtifactEvent: boolean
  }> {
    const pending = (await this.get(id)).pendingWorkspaceMutations?.[mutationId]
    if (!pending) return { reconstructedFileEvent: false, reconstructedArtifactEvent: false }
    const snapshotExcluded = isWorkspaceSnapshotExcludedPath(pending.path)
    const events = snapshotExcluded ? [] : await this.events(id)
    const fileData = workspaceMutationFileEventData(pending)
    const existingFileEvent = events.find((event) => event.id === pending.fileEventId)
    if (existingFileEvent && !workspaceMutationEventMatches(existingFileEvent, 'file.changed', this.redactForDisplay(id, fileData))) {
      throw new Error(`Workspace mutation event ${pending.fileEventId} does not match checkpoint ${mutationId}`)
    }
    if (!existingFileEvent) {
      const target = resolveWorkspacePath(this.workspaceDir(id), pending.path)
      await assertNoSymlinkTraversal(this.workspaceDir(id), target)
      const observed = await inspectWorkspaceFile(target)
      const materialized = pending.kind === 'delete'
        ? observed.kind === 'missing'
        : observed.kind === 'file' && observed.bytes === pending.bytes && observed.sha256 === pending.sha256
      if (!materialized) throw new Error(`Workspace mutation ${mutationId} has no verified final state`)
    }
    if (!snapshotExcluded) {
      await this.append(id, 'file.changed', fileData, { ...pending.context, eventId: pending.fileEventId })
    }

    let existingArtifactEvent: SessionEvent | undefined
    if (!snapshotExcluded && pending.artifact && pending.artifactEventId) {
      const artifactType = pending.kind === 'write' ? 'artifact.created' as const : 'artifact.removed' as const
      const artifactData = pending.kind === 'write'
        ? { artifact: pending.artifact }
        : { artifact: pending.artifact, path: pending.path }
      existingArtifactEvent = events.find((event) => event.id === pending.artifactEventId)
      if (existingArtifactEvent && !workspaceMutationEventMatches(existingArtifactEvent, artifactType, this.redactForDisplay(id, artifactData))) {
        throw new Error(`Workspace Artifact event ${pending.artifactEventId} does not match checkpoint ${mutationId}`)
      }
      await this.append(id, artifactType, artifactData, { ...pending.context, eventId: pending.artifactEventId })
    }

    await this.enqueue(id, async () => {
      const state = await this.get(id)
      const current = state.pendingWorkspaceMutations?.[mutationId]
      if (!current) return
      if (snapshotExcluded) {
        state.artifacts = state.artifacts.filter((item) => item.path !== pending.path)
      } else if (pending.kind === 'write' && pending.artifact) {
        state.artifacts = [...state.artifacts.filter((item) => item.path !== pending.path), pending.artifact]
      } else if (pending.kind === 'delete') {
        state.artifacts = state.artifacts.filter((item) => item.path !== pending.path)
      }
      state.summary.workspaceBytes = await workspaceSize(this.workspaceDir(id))
      delete state.pendingWorkspaceMutations?.[mutationId]
      if (state.pendingWorkspaceMutations && Object.keys(state.pendingWorkspaceMutations).length === 0) {
        delete state.pendingWorkspaceMutations
      }
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
    })
    await cleanupWorkspaceMutationFiles(this.sessionDir(id), pending)
    return {
      reconstructedFileEvent: !snapshotExcluded && !existingFileEvent,
      reconstructedArtifactEvent: !snapshotExcluded && Boolean(pending.artifactEventId && !existingArtifactEvent),
    }
  }

  async stageWorkspaceEventBatch(id: string, options: StageWorkspaceEventBatchOptions): Promise<string> {
    await this.initialize()
    if (options.changes.length === 0) throw new Error('Workspace event batch must contain at least one change')
    if (options.changes.length > 2_000) throw new Error('Workspace event batch exceeds 2,000 changes')
    const batchId = createId('wbatch')
    return await this.enqueue(id, async () => {
      const state = await this.get(id)
      const paths = new Set<string>()
      const changes = options.changes.map((candidate): DurableWorkspaceEventBatchChange => {
        if (!isSafeWorkspaceRelativePath(candidate.path)) throw new Error(`Invalid workspace event path: ${candidate.path}`)
        if (paths.has(candidate.path)) throw new Error(`Workspace event batch contains duplicate path: ${candidate.path}`)
        paths.add(candidate.path)
        if (!candidate.operation) throw new Error(`Workspace event operation is required for ${candidate.path}`)
        if (!Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0) throw new Error(`Invalid workspace event byte count for ${candidate.path}`)
        if (candidate.expected === 'present') {
          if (!candidate.sha256 || !/^[a-f0-9]{64}$/.test(candidate.sha256)) throw new Error(`Workspace event batch lacks SHA-256 for ${candidate.path}`)
          if (candidate.bytes < 0) throw new Error(`Invalid workspace event byte count for ${candidate.path}`)
        } else if (candidate.expected === 'missing') {
          if (candidate.bytes !== 0 || candidate.sha256 !== undefined) throw new Error(`Deleted workspace event must use zero bytes for ${candidate.path}`)
        } else {
          throw new Error(`Invalid workspace event expectation for ${candidate.path}`)
        }
        const artifact = candidate.artifact === undefined ? undefined : artifactRecordFromValue(candidate.artifact, id)
        if (candidate.artifact !== undefined && (!artifact || artifact.path !== candidate.path)) {
          throw new Error(`Workspace event Artifact does not match ${candidate.path}`)
        }
        if (candidate.expected === 'present' && !artifact) throw new Error(`Present workspace event lacks Artifact for ${candidate.path}`)
        return {
          path: candidate.path,
          operation: candidate.operation,
          bytes: candidate.bytes,
          expected: candidate.expected,
          ...(candidate.sha256 ? { sha256: candidate.sha256 } : {}),
          ...(artifact ? { artifact, artifactEventId: createId('evt') } : {}),
          fileEventId: createId('evt'),
        }
      })
      const reservedPaths = new Set([
        ...Object.values(state.pendingWorkspaceMutations ?? {}).map((pending) => pending.path),
        ...Object.values(state.pendingWorkspaceEventBatches ?? {}).flatMap((pending) => pending.changes.map((change) => change.path)),
      ])
      const conflict = changes.find((change) => reservedPaths.has(change.path))
      if (conflict) throw new Error(`Another workspace publication is already active for ${conflict.path}`)
      const checkpoint: DurablePendingWorkspaceEventBatch = {
        id: batchId,
        source: options.source,
        changes,
        context: options.context ?? {},
        createdAt: new Date().toISOString(),
      }
      state.pendingWorkspaceEventBatches = {
        ...state.pendingWorkspaceEventBatches,
        [batchId]: checkpoint,
      }
      state.summary.updatedAt = checkpoint.createdAt
      await this.writeState(id, state)
      return batchId
    })
  }

  async publishWorkspaceEventBatch(id: string, batchId: string): Promise<{
    reconstructedFileEvents: number
    reconstructedArtifactEvents: number
  }> {
    const pending = (await this.get(id)).pendingWorkspaceEventBatches?.[batchId]
    if (!pending) return { reconstructedFileEvents: 0, reconstructedArtifactEvents: 0 }
    const initialEvents = await this.events(id)
    const publicationStarted = pending.changes.some((change) => (
      initialEvents.some((event) => event.id === change.fileEventId || event.id === change.artifactEventId)
    ))
    if (!publicationStarted && !await workspaceEventBatchPostImageMatches(this.workspaceDir(id), pending)) {
      throw new Error(`Workspace event batch ${batchId} post-image does not match`)
    }

    let reconstructedFileEvents = 0
    let reconstructedArtifactEvents = 0
    for (const change of pending.changes) {
      if (isWorkspaceSnapshotExcludedPath(change.path)) continue
      const fileData = workspaceEventBatchFileEventData(change)
      const events = await this.events(id)
      const existingFile = events.find((event) => event.id === change.fileEventId)
      if (existingFile && !workspaceMutationEventMatches(
        existingFile,
        'file.changed',
        this.redactForDisplay(id, fileData),
      )) throw new Error(`Workspace batch event ${change.fileEventId} does not match ${batchId}`)
      await this.append(id, 'file.changed', fileData, { ...pending.context, eventId: change.fileEventId })
      if (!existingFile) reconstructedFileEvents += 1

      if (change.artifact && change.artifactEventId) {
        const artifactType = change.expected === 'present' ? 'artifact.created' as const : 'artifact.removed' as const
        const artifactData = change.expected === 'present'
          ? { artifact: change.artifact }
          : { artifact: change.artifact, path: change.path }
        const currentEvents = await this.events(id)
        const existingArtifact = currentEvents.find((event) => event.id === change.artifactEventId)
        if (existingArtifact && !workspaceMutationEventMatches(
          existingArtifact,
          artifactType,
          this.redactForDisplay(id, artifactData),
        )) throw new Error(`Workspace batch Artifact event ${change.artifactEventId} does not match ${batchId}`)
        await this.append(id, artifactType, artifactData, { ...pending.context, eventId: change.artifactEventId })
        if (!existingArtifact) reconstructedArtifactEvents += 1
      }
    }

    await this.enqueue(id, async () => {
      const state = await this.get(id)
      if (!state.pendingWorkspaceEventBatches?.[batchId]) return
      for (const change of pending.changes) {
        if (isWorkspaceSnapshotExcludedPath(change.path)) {
          state.artifacts = state.artifacts.filter((item) => item.path !== change.path)
        } else if (change.expected === 'present' && change.artifact) {
          state.artifacts = [...state.artifacts.filter((item) => item.path !== change.path), change.artifact]
        } else if (change.expected === 'missing') {
          state.artifacts = state.artifacts.filter((item) => item.path !== change.path)
        }
      }
      state.summary.workspaceBytes = await workspaceSize(this.workspaceDir(id))
      delete state.pendingWorkspaceEventBatches[batchId]
      if (Object.keys(state.pendingWorkspaceEventBatches).length === 0) delete state.pendingWorkspaceEventBatches
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
    })
    return { reconstructedFileEvents, reconstructedArtifactEvents }
  }

  async discardWorkspaceEventBatch(id: string, batchId: string): Promise<void> {
    await this.enqueue(id, async () => {
      const state = await this.get(id)
      if (!state.pendingWorkspaceEventBatches?.[batchId]) return
      delete state.pendingWorkspaceEventBatches[batchId]
      if (Object.keys(state.pendingWorkspaceEventBatches).length === 0) delete state.pendingWorkspaceEventBatches
      state.summary.workspaceBytes = await workspaceSize(this.workspaceDir(id))
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
    })
  }

  async stageShellReconciliation(
    id: string,
    guardianId: string,
    before: Map<string, WorkspaceFileSnapshotEntry>,
    context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'> = {},
  ): Promise<string> {
    await this.initialize()
    if (!/^cmd_[a-f0-9]{20}$/.test(guardianId)) throw new Error('Invalid foreground command guardian ID')
    if (before.size > 2_000) throw new Error('Foreground command snapshot exceeds 2,000 files')
    const checkpointId = createId('shrec')
    return await this.enqueue(id, async () => {
      const state = await this.get(id)
      if (Object.keys(state.pendingShellReconciliations ?? {}).length > 0) {
        throw new Error('Another Shell reconciliation is already active')
      }
      const entries: DurableWorkspaceSnapshotEntry[] = [...before.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, entry]) => {
          if (!isSafeWorkspaceRelativePath(path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
            throw new Error(`Invalid foreground command snapshot entry: ${path}`)
          }
          return { path, bytes: entry.size, sha256: entry.sha256 }
        })
      const pending: DurablePendingShellReconciliation = {
        id: checkpointId,
        guardianId,
        phase: 'staged',
        before: entries,
        context,
        createdAt: new Date().toISOString(),
      }
      state.pendingShellReconciliations = { [checkpointId]: pending }
      state.summary.updatedAt = pending.createdAt
      await this.writeState(id, state)
      return checkpointId
    })
  }

  async armShellReconciliation(id: string, checkpointId: string, guardianPid: number): Promise<void> {
    if (!Number.isInteger(guardianPid) || guardianPid <= 1) throw new Error('Invalid foreground command guardian PID')
    await this.enqueue(id, async () => {
      const state = await this.get(id)
      const pending = state.pendingShellReconciliations?.[checkpointId]
      if (!pending) throw new Error(`Shell reconciliation ${checkpointId} is not active`)
      if (pending.phase === 'armed') {
        if (pending.guardianPid !== guardianPid) throw new Error(`Shell reconciliation ${checkpointId} guardian changed`)
        return
      }
      state.pendingShellReconciliations = {
        ...state.pendingShellReconciliations,
        [checkpointId]: { ...pending, phase: 'armed', guardianPid },
      }
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
    })
  }

  async settleShellReconciliation(id: string, checkpointId: string): Promise<{
    batchId?: string
    changeCount: number
  }> {
    const after = await workspaceFileSnapshot(this.workspaceDir(id))
    return await this.enqueue(id, async () => {
      const state = await this.get(id)
      const pending = state.pendingShellReconciliations?.[checkpointId]
      if (!pending) return { changeCount: 0 }
      const before = new Map(pending.before.map((entry) => [entry.path, entry]))
      const createdAt = new Date().toISOString()
      const candidates: Array<Omit<DurableWorkspaceEventBatchChange, 'fileEventId' | 'artifactEventId'>> = []
      for (const [path, current] of [...after.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const prior = before.get(path)
        if (prior?.sha256 === current.sha256) continue
        candidates.push({
          path,
          operation: prior ? 'modified-by-shell' : 'created-by-shell',
          bytes: current.size,
          expected: 'present',
          sha256: current.sha256,
          artifact: createWorkspaceArtifact(id, path, createdAt),
        })
      }
      for (const path of [...before.keys()].filter((path) => !after.has(path)).sort()) {
        const artifact = state.artifacts.find((item) => item.path === path)
        candidates.push({
          path,
          operation: 'deleted-by-shell',
          bytes: 0,
          expected: 'missing',
          ...(artifact ? { artifact } : {}),
        })
      }

      delete state.pendingShellReconciliations?.[checkpointId]
      if (state.pendingShellReconciliations && Object.keys(state.pendingShellReconciliations).length === 0) {
        delete state.pendingShellReconciliations
      }
      if (candidates.length === 0) {
        state.summary.workspaceBytes = await workspaceSize(this.workspaceDir(id))
        state.summary.updatedAt = createdAt
        await this.writeState(id, state)
        return { changeCount: 0 }
      }
      const reservedPaths = new Set([
        ...Object.values(state.pendingWorkspaceMutations ?? {}).map((pending) => pending.path),
        ...Object.values(state.pendingWorkspaceEventBatches ?? {}).flatMap((pending) => pending.changes.map((change) => change.path)),
      ])
      const conflict = candidates.find((change) => reservedPaths.has(change.path))
      if (conflict) throw new Error(`Another workspace publication is already active for ${conflict.path}`)
      const batchId = createId('wbatch')
      const changes: DurableWorkspaceEventBatchChange[] = candidates.map((candidate) => ({
        ...candidate,
        fileEventId: createId('evt'),
        ...(candidate.artifact ? { artifactEventId: createId('evt') } : {}),
      }))
      state.pendingWorkspaceEventBatches = {
        ...state.pendingWorkspaceEventBatches,
        [batchId]: {
          id: batchId,
          source: 'shell',
          changes,
          context: pending.context,
          createdAt,
        },
      }
      state.summary.updatedAt = createdAt
      await this.writeState(id, state)
      return { batchId, changeCount: changes.length }
    })
  }

  async list(): Promise<SessionSummary[]> {
    await this.initialize()
    const names = await readdir(resolve(this.root, 'sessions'))
    const sessions = await Promise.all(
      names.filter((name) => name.startsWith('ses_')).map(async (name) => {
        try {
          const summary = (await this.get(name)).summary
          return this.redactForDisplay(name, summary)
        } catch {
          return undefined
        }
      }),
    )
    return sessions
      .filter((session): session is SessionSummary => Boolean(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async get(id: string): Promise<StoredSession> {
    assertSessionId(id)
    const state = JSON.parse(await readFile(this.statePath(id), 'utf8')) as StoredSession
    state.processes ??= []
    state.artifacts ??= []
    state.messages ??= []
    state.turnMessageStarts ??= {}
    state.plan ??= null
    state.deployment ??= { status: 'not_deployed', revision: 0, updatedAt: state.summary.createdAt }
    state.repository ??= null
    state.summary.productMode ??= state.repository ? 'coding' : 'chat'
    if (state.repository) {
      state.summary.codingSessionStatus ??= 'active'
      state.repository.arenaBranch ??= state.repository.baseBranch
      state.repository.cwd ??= '/home/user'
    }
    state.summary.isFreeSession ??= false
    state.summary.settledCredits ??= 0
    state.summary.feedbackType ??= 'check_in'
    state.summary.usage.cachedPromptTokens ??= 0
    state.summary.usage.modelRequests ??= state.summary.usage.modelCalls
    state.summary.usage.modelRequests = Math.max(
      state.summary.usage.modelCalls,
      state.summary.usage.modelRequests,
    )
    state.summary.usage.estimatedCostStatus ??= estimatedCostStatusForUsage(state.summary.usage)
    state.usageSettlements ??= {}
    this.syncSessionTokenLimit(state.summary)
    return state
  }

  async update(
    id: string,
    mutate: (state: StoredSession) => void,
    options: { updatedAt?: string } = {},
  ): Promise<StoredSession> {
    return this.enqueue(id, async () => {
      const state = await this.get(id)
      mutate(state)
      this.syncSessionTokenLimit(state.summary)
      state.summary.updatedAt = options.updatedAt ?? new Date().toISOString()
      await this.writeState(id, state)
      return state
    })
  }

  async setStatus(id: string, status: RunStatus): Promise<void> {
    await this.update(id, (state) => {
      transitionRunStatus(state, status)
    })
  }

  async stageHitl(id: string, pending: DurablePendingHitl): Promise<void> {
    await this.update(id, (state) => {
      if (state.pendingHitl?.[pending.id]) throw new Error(`HITL request ${pending.id} already exists`)
      const callIndex = pending.callIndex ?? allocatePendingToolCallIndex(state, pending)
      state.pendingHitl = {
        ...(state.pendingHitl ?? {}),
        [pending.id]: pending.requiredEventId
          ? { ...pending, ...(callIndex === undefined ? {} : { callIndex }), phase: pending.phase ?? 'awaiting_response' }
          : { ...pending, ...(callIndex === undefined ? {} : { callIndex }) },
      }
      transitionRunStatus(state, 'awaiting_user')
    })
  }

  async settleHitl(
    id: string,
    hitlId: string,
    response: Record<string, unknown>,
  ): Promise<{ event: SessionEvent; appended: boolean }> {
    return await this.enqueue(id, async () => {
      const events = await this.events(id)
      const existing = events.find((event) => (
        event.type === 'hitl.resolved'
        && (event.data as Record<string, unknown>).hitlId === hitlId
      ))
      const state = await this.get(id)
      if (existing) {
        const pending = state.pendingHitl?.[hitlId]
        if (pending?.requiredEventId) {
          const durableResponse = (existing.data as { response?: unknown }).response
          if (!durableResponse || typeof durableResponse !== 'object' || Array.isArray(durableResponse)) {
            throw new Error('Durable HITL response is invalid')
          }
          state.pendingHitl = {
            ...state.pendingHitl,
            [hitlId]: {
              ...pending,
              response: durableResponse as Record<string, unknown>,
              resolvedEventId: existing.id,
              phase: pending.phase === 'executing' ? 'executing' : 'response_recorded',
            },
          }
          transitionRunStatus(state, Object.values(state.pendingHitl).some((entry) => entry.phase === 'awaiting_response')
            ? 'awaiting_user'
            : 'running')
          await this.writeState(id, state)
        } else if (pending) {
          delete state.pendingHitl![hitlId]
          if (Object.keys(state.pendingHitl!).length === 0) delete state.pendingHitl
          transitionRunStatus(state, 'running')
          await this.writeState(id, state)
        }
        return { event: existing, appended: false }
      }
      const pending = state.pendingHitl?.[hitlId]
      if (!pending) throw new Error('HITL request not found')
      // A voice id is part of the durable human decision, not a later
      // ToolExecutor convenience value. Allocate it while holding the same
      // per-Session queue that records the first-writer response so two
      // independently resolved add_voice cards cannot observe the same stale
      // voices snapshot and reserve one id.
      const durableResponse = pending.kind === 'add_voice'
        ? { ...response, voice_id: nextVoiceId(state) }
        : response
      if (pending.requiredEventId) {
        const eventId = pending.resolvedEventId ?? createId('evt')
        state.pendingHitl = {
          ...state.pendingHitl,
          [hitlId]: {
            ...pending,
            response: durableResponse,
            resolvedEventId: eventId,
            phase: 'response_recorded',
          },
        }
        transitionRunStatus(state, Object.values(state.pendingHitl).some((entry) => entry.phase === 'awaiting_response')
          ? 'awaiting_user'
          : 'running')
        state.summary.updatedAt = new Date().toISOString()
        // Persist the chosen first-writer response before publishing its
        // preallocated event. Startup can reconstruct the latter after a
        // process death in this narrow window.
        await this.writeState(id, state)
        const event = await this.appendUnqueued(id, 'hitl.resolved', {
          hitlId,
          kind: pending.kind,
          response: durableResponse,
        }, { turnId: pending.turnId, stepId: pending.stepId, callId: pending.callId, eventId })
        return { event, appended: true }
      }
      const event = await this.appendUnqueued(id, 'hitl.resolved', {
        hitlId,
        kind: pending.kind,
        response: durableResponse,
      }, { turnId: pending.turnId, stepId: pending.stepId, callId: pending.callId })
      delete state.pendingHitl![hitlId]
      if (Object.keys(state.pendingHitl!).length === 0) {
        delete state.pendingHitl
        transitionRunStatus(state, 'running')
      }
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
      return { event, appended: true }
    })
  }

  /**
   * Materialize a selected provider voice without allowing a later concurrent
   * add_voice completion to rebind the same public id. Direct ToolExecutor
   * callers that do not have a durable HITL reservation are allocated an id in
   * this same Session queue; Agent runs pass the id already reserved by
   * settleHitl above.
   */
  async commitVoiceSelection(
    id: string,
    options: CommitVoiceSelectionOptions,
  ): Promise<{ voiceId: string; voice: StoredVoiceSelection }> {
    return await this.enqueue(id, async () => {
      const state = await this.get(id)
      if (!options.callId.trim()) throw new Error('A voice selection requires its add_voice call id')
      const voiceId = options.voiceId ?? nextVoiceId(state)
      if (!/^voice-\d+$/.test(voiceId)) throw new Error('Durable voice_id is invalid')

      const reservations = Object.values(state.pendingHitl ?? {}).filter((pending) => (
        pending.kind === 'add_voice'
        && pending.response?.voice_id === voiceId
      ))
      const foreignReservation = reservations.find((pending) => pending.callId !== options.callId)
      if (foreignReservation) {
        throw new Error(`Voice ${voiceId} is reserved by a different add_voice selection`)
      }

      const existing = state.voices?.[voiceId]
      if (existing) {
        if (existing.providerVoice !== options.providerVoice || existing.language !== options.language) {
          throw new Error(`Voice ${voiceId} was already assigned to a different selection`)
        }
        if (existing.sourceCallId && existing.sourceCallId !== options.callId) {
          throw new Error(`Voice ${voiceId} was already assigned to a different add_voice call`)
        }
        if (!existing.sourceCallId) {
          // A legacy record has no owner. Only an extant durable response can
          // prove that this recovery frame owns the id; accepting an unrelated
          // explicit reuse after pending cleanup would recreate the collision.
          if (!reservations.some((pending) => pending.callId === options.callId)) {
            throw new Error(`Voice ${voiceId} has no verifiable add_voice owner`)
          }
          const claimed = { ...existing, sourceCallId: options.callId }
          state.voices = { ...(state.voices ?? {}), [voiceId]: claimed }
          state.summary.updatedAt = new Date().toISOString()
          await this.writeState(id, state)
          return { voiceId, voice: claimed }
        }
        return { voiceId, voice: existing }
      }

      const voice: StoredVoiceSelection = {
        providerVoice: options.providerVoice,
        language: options.language,
        createdAt: options.createdAt ?? new Date().toISOString(),
        sourceCallId: options.callId,
      }
      state.voices = { ...(state.voices ?? {}), [voiceId]: voice }
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
      return { voiceId, voice }
    })
  }

  async markHitlExecuting(id: string, hitlId: string): Promise<DurablePendingHitl> {
    return await this.enqueue(id, async () => {
      const state = await this.get(id)
      const pending = state.pendingHitl?.[hitlId]
      if (!pending?.requiredEventId || !pending.response) throw new Error('HITL response is not ready for continuation')
      const executing = { ...pending, phase: 'executing' as const }
      state.pendingHitl = { ...state.pendingHitl, [hitlId]: executing }
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
      return executing
    })
  }

  async stageApproval(id: string, pending: DurablePendingApproval): Promise<void> {
    await this.update(id, (state) => {
      if (state.pendingApprovals?.[pending.id]) throw new Error(`Approval request ${pending.id} already exists`)
      const callIndex = pending.callIndex ?? allocatePendingToolCallIndex(state, pending)
      state.pendingApprovals = {
        ...(state.pendingApprovals ?? {}),
        [pending.id]: { ...pending, ...(callIndex === undefined ? {} : { callIndex }) },
      }
      transitionRunStatus(state, 'awaiting_approval')
    })
  }

  async settleApproval(
    id: string,
    approvalId: string,
    approved: boolean,
  ): Promise<{ event: SessionEvent; appended: boolean; approved: boolean; pending?: DurablePendingApproval }> {
    return await this.enqueue(id, async () => {
      const events = await this.events(id)
      const existing = events.find((event) => (
        event.type === 'approval.resolved'
        && (event.data as Record<string, unknown>).approvalId === approvalId
      ))
      const state = await this.get(id)
      const pending = state.pendingApprovals?.[approvalId]
      if (existing) {
        const durableApproved = (existing.data as { approved?: unknown }).approved
        if (typeof durableApproved !== 'boolean') throw new Error('Durable approval decision is invalid')
        if (pending) {
          const settled = {
            ...pending,
            approved: durableApproved,
            resolvedEventId: existing.id,
            phase: pending.phase === 'executing' ? 'executing' as const : 'decision_recorded' as const,
          }
          state.pendingApprovals = { ...state.pendingApprovals, [approvalId]: settled }
          transitionRunStatus(state, 'running')
          state.summary.updatedAt = new Date().toISOString()
          await this.writeState(id, state)
          return { event: existing, appended: false, approved: durableApproved, pending: settled }
        }
        return { event: existing, appended: false, approved: durableApproved }
      }
      if (!pending) throw new Error('Approval request not found')
      const eventId = pending.resolvedEventId ?? createId('evt')
      const settled: DurablePendingApproval = {
        ...pending,
        approved,
        resolvedEventId: eventId,
        phase: 'decision_recorded',
      }
      state.pendingApprovals = { ...state.pendingApprovals, [approvalId]: settled }
      transitionRunStatus(state, 'running')
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
      const event = await this.appendUnqueued(id, 'approval.resolved', {
        approvalId,
        approved,
        decision: approved ? 'approved' : 'denied',
        requestSignature: pending.requestSignature,
      }, { turnId: pending.turnId, stepId: pending.stepId, callId: pending.callId, eventId })
      return { event, appended: true, approved, pending: settled }
    })
  }

  async markApprovalExecuting(id: string, approvalId: string): Promise<DurablePendingApproval> {
    return await this.enqueue(id, async () => {
      const state = await this.get(id)
      const pending = state.pendingApprovals?.[approvalId]
      if (!pending || typeof pending.approved !== 'boolean') throw new Error('Approval decision is not ready for continuation')
      const executing = { ...pending, phase: 'executing' as const }
      state.pendingApprovals = { ...state.pendingApprovals, [approvalId]: executing }
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
      return executing
    })
  }

  async expireApproval(id: string, approvalId: string, reason: string): Promise<void> {
    await this.enqueue(id, async () => {
      const state = await this.get(id)
      const pending = state.pendingApprovals?.[approvalId]
      if (!pending) return
      const existing = (await this.events(id)).some((event) => (
        (event.type === 'approval.resolved' || event.type === 'approval.expired')
        && (event.data as Record<string, unknown>).approvalId === approvalId
      ))
      if (!existing) {
        await this.appendUnqueued(id, 'approval.expired', {
          approvalId,
          decision: 'expired',
          reason,
        }, { turnId: pending.turnId, stepId: pending.stepId, callId: pending.callId })
      }
      delete state.pendingApprovals![approvalId]
      if (Object.keys(state.pendingApprovals!).length === 0) delete state.pendingApprovals
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
    })
  }

  async expireHitl(id: string, hitlId: string, reason: string): Promise<void> {
    await this.enqueue(id, async () => {
      const state = await this.get(id)
      const pending = state.pendingHitl?.[hitlId]
      if (!pending) return
      const existing = (await this.events(id)).some((event) => (
        (event.type === 'hitl.resolved' || event.type === 'hitl.expired')
        && (event.data as Record<string, unknown>).hitlId === hitlId
      ))
      if (!existing) {
        await this.appendUnqueued(id, 'hitl.expired', {
          hitlId,
          kind: pending.kind,
          decision: 'expired',
          reason,
        }, { turnId: pending.turnId, stepId: pending.stepId, callId: pending.callId })
      }
      delete state.pendingHitl![hitlId]
      if (Object.keys(state.pendingHitl!).length === 0) delete state.pendingHitl
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
    })
  }

  async recordWebsiteUpdate(
    id: string,
    website: WebsiteState,
    details: Record<string, unknown> = {},
    context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'> = {},
  ): Promise<void> {
    // Event first: if the process dies before materialization, startup can
    // deterministically replay the complete Website projection from JSONL.
    await this.append(id, 'website.updated', { ...details, website }, context)
    await this.update(id, (state) => { state.website = website })
  }

  async recordDeploymentUpdate(
    id: string,
    deployment: DeploymentState,
    action: string,
    context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'> = {},
  ): Promise<void> {
    // Event first: a restart can materialize this complete projection if the
    // process dies before state.json is replaced.
    await this.append(id, 'deployment.updated', { deployment, action }, context)
    await this.update(id, (state) => { state.deployment = deployment })
  }

  async recordPlanUpdate(
    id: string,
    plan: PlanState,
    details: Record<string, unknown> = {},
    context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'> = {},
  ): Promise<void> {
    await this.append(id, 'plan.updated', { ...details, plan }, context)
    await this.update(id, (state) => { state.plan = plan })
  }

  async recordArtifactCreated(
    id: string,
    artifact: ArtifactRecord,
    context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'> & { eventId?: string } = {},
  ): Promise<void> {
    await this.append(id, 'artifact.created', { artifact }, context)
    await this.update(id, (state) => {
      state.artifacts = [...state.artifacts.filter((item) => item.path !== artifact.path), artifact]
    })
  }

  async recordArtifactRemoved(
    id: string,
    artifact: ArtifactRecord,
    context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'> & { eventId?: string } = {},
  ): Promise<void> {
    await this.append(id, 'artifact.removed', { artifact, path: artifact.path }, context)
    await this.update(id, (state) => {
      state.artifacts = state.artifacts.filter((item) => item.path !== artifact.path)
    })
  }

  async stageDeploymentSnapshot(id: string, pending: DurablePendingDeployment): Promise<void> {
    if (pending.phase !== 'snapshotting' || pending.completed || pending.completionAction) {
      throw new Error('A new Deployment checkpoint must begin in the snapshotting phase')
    }
    await this.update(id, (state) => {
      if (state.pendingDeployment) throw new Error(`Deployment checkpoint ${state.pendingDeployment.id} is already active`)
      state.deployment = pending.deploying
      state.pendingDeployment = pending
    })
    await this.append(id, 'deployment.updated', {
      deployment: pending.deploying,
      action: 'deploying',
    }, {
      ...pending.context,
      eventId: pending.deployingEventId,
    })
  }

  async settleDeploymentSnapshot(
    id: string,
    checkpointId: string,
    deployment: DeploymentState,
    action: DurableDeploymentCompletionAction,
  ): Promise<void> {
    await this.update(id, (state) => {
      const pending = state.pendingDeployment
      if (!pending || pending.id !== checkpointId) {
        throw new Error(`Deployment checkpoint ${checkpointId} is not active`)
      }
      if (pending.phase === 'ready') {
        if (
          !pending.completed
          || pending.completionAction !== action
          || !deploymentStatesEqual(pending.completed, deployment)
        ) throw new Error(`Deployment checkpoint ${checkpointId} already has a different completion`)
        state.deployment = pending.completed
        if (pending.completed.status === 'deployed') state.deploymentManifestRequired = true
        return
      }
      state.deployment = deployment
      if (deployment.status === 'deployed') state.deploymentManifestRequired = true
      state.pendingDeployment = {
        ...pending,
        phase: 'ready',
        completed: deployment,
        completionAction: action,
      }
    })

    const ready = (await this.get(id)).pendingDeployment
    if (!ready || ready.id !== checkpointId || ready.phase !== 'ready' || !ready.completed || !ready.completionAction) {
      throw new Error(`Deployment checkpoint ${checkpointId} was not durably prepared for publication`)
    }
    const completed = ready.completed
    await this.append(id, 'deployment.updated', {
      deployment: completed,
      action: ready.completionAction,
    }, {
      ...ready.context,
      eventId: ready.completionEventId,
    })
    await this.update(id, (state) => {
      if (state.pendingDeployment?.id !== checkpointId) {
        throw new Error(`Deployment checkpoint ${checkpointId} changed while it was being published`)
      }
      state.deployment = completed
      if (completed.status === 'deployed') state.deploymentManifestRequired = true
      delete state.pendingDeployment
    })
  }

  async stageRunStart(
    id: string,
    pending: DurablePendingStart,
    mutate: (state: StoredSession) => void,
  ): Promise<StoredSession> {
    return await this.update(id, (state) => {
      if (state.pendingStart) throw new Error(`Turn ${state.pendingStart.turnId} is already pending dispatch`)
      mutate(state)
      state.pendingStart = pending
      transitionRunStatus(state, 'queued')
    })
  }

  async commitRunStart(id: string, turnId: string): Promise<void> {
    await this.update(id, (state) => {
      if (state.pendingStart?.turnId !== turnId) {
        throw new Error(`Turn ${turnId} does not match the durable pending start`)
      }
      delete state.pendingStart
      transitionRunStatus(state, 'running')
    })
  }

  async stageRunTerminal(
    id: string,
    pending: DurablePendingTerminal,
    mutate: (state: StoredSession) => void = () => {},
  ): Promise<StoredSession> {
    return await this.update(id, (state) => {
      if (state.pendingStart) throw new Error(`Turn ${state.pendingStart.turnId} has not finished dispatching`)
      if (state.pendingTerminal) throw new Error(`Turn ${state.pendingTerminal.turnId} already has a pending terminal outcome`)
      mutate(state)
      state.pendingTerminal = pending
    })
  }

  async publishRunTerminal(id: string, turnId: string): Promise<void> {
    const state = await this.get(id)
    const pending = state.pendingTerminal
    if (!pending || pending.turnId !== turnId) throw new Error(`Turn ${turnId} does not match the durable pending terminal outcome`)
    for (const event of pending.events) {
      await this.append(id, event.type, event.data, {
        turnId: pending.turnId,
        stepId: pending.stepId,
        eventId: event.id,
      })
    }
    await this.update(id, (next) => {
      if (next.pendingTerminal?.turnId !== turnId) {
        throw new Error(`Turn ${turnId} terminal outcome changed while it was being published`)
      }
      const current = next.pendingTerminal
      if (!current.terminalPublished) transitionRunStatus(next, current.status)
      if (!current.workspacePersistenceEvents || current.workspacePersistencePublished) {
        delete next.pendingTerminal
      } else {
        next.pendingTerminal = { ...current, terminalPublished: true }
      }
    })
  }

  /**
   * Opens the independent Workspace persistence lane without committing it.
   * Completion publication uses this durable, idempotent boundary to ensure
   * that the visible scanning phase precedes Final while leaving every later
   * persistence event free to interleave with the terminal lane.
   */
  async publishWorkspacePersistenceStarted(id: string, turnId: string): Promise<void> {
    const state = await this.get(id)
    const pending = state.pendingTerminal
    if (!pending || pending.turnId !== turnId) throw new Error(`Turn ${turnId} does not match the durable pending completion outcome`)
    const event = pending.workspacePersistenceEvents?.[0]
    if (!event || event.type !== 'workspace.persistence.started' || event.data.phase !== 'scanning') {
      throw new Error(`Turn ${turnId} has no Workspace persistence scanning boundary`)
    }
    await this.append(id, event.type, event.data, {
      turnId: pending.turnId,
      stepId: pending.stepId,
      eventId: event.id,
    })
  }

  async publishWorkspacePersistence(id: string, turnId: string): Promise<void> {
    const state = await this.get(id)
    const pending = state.pendingTerminal
    if (!pending || pending.turnId !== turnId) throw new Error(`Turn ${turnId} does not match the durable pending completion outcome`)
    const events = pending.workspacePersistenceEvents
    if (!events) throw new Error(`Turn ${turnId} has no independent Workspace persistence lane`)
    for (const event of events) {
      await this.append(id, event.type, event.data, {
        turnId: pending.turnId,
        stepId: pending.stepId,
        eventId: event.id,
      })
    }
    await this.update(id, (next) => {
      if (next.pendingTerminal?.turnId !== turnId) {
        throw new Error(`Turn ${turnId} completion outcome changed while Workspace persistence was being published`)
      }
      const current = next.pendingTerminal
      if (current.terminalPublished) {
        delete next.pendingTerminal
      } else {
        next.pendingTerminal = { ...current, workspacePersistencePublished: true }
      }
    })
  }

  async events(id: string, afterSeq = 0): Promise<SessionEvent[]> {
    assertSessionId(id)
    let text = ''
    try {
      text = await readFile(this.eventsPath(id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return parseEventLog(text).events
      .filter((event) => event.seq > afterSeq)
      .map((event) => event.type === 'turn.started' ? event : { ...event, data: this.redactForDisplay(id, event.data) })
  }

  async append<T extends Record<string, unknown>>(
    id: string,
    type: SessionEvent<T>['type'],
    data: T,
    context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'> & { eventId?: string } = {},
  ): Promise<SessionEvent<T>> {
    return this.enqueue(id, async () => this.appendUnqueued(id, type, data, context))
  }

  /**
   * Serializes the read-before-write decision with the JSONL append. This is
   * used for immutable first-response-wins controls where concurrent browser
   * retries must observe the same durable event instead of appending twice.
   */
  async appendIfAbsent<T extends Record<string, unknown>>(
    id: string,
    type: SessionEvent<T>['type'],
    data: T,
    matchesExisting: (event: SessionEvent) => boolean,
    context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'> & { eventId?: string } = {},
    options: {
      beforeAppend?: (state: StoredSession, events: SessionEvent[]) => void
    } = {},
  ): Promise<{ event: SessionEvent<T>; appended: boolean }> {
    return this.enqueue(id, async () => {
      const events = await this.events(id)
      const existing = events.find(matchesExisting)
      if (existing) return { event: existing as SessionEvent<T>, appended: false }
      if (options.beforeAppend) options.beforeAppend(await this.get(id), events)
      return {
        event: await this.appendUnqueued(id, type, data, context),
        appended: true,
      }
    })
  }

  /**
   * Rewinds the private provider context and then publishes the observable
   * turn.undone boundary. The two writes deliberately use a checkpoint: a
   * restart can safely finish publication without ever restoring an already
   * removed turn to the model context.
   */
  async commitTurnUndo(
    id: string,
    options: CommitTurnUndoOptions,
  ): Promise<{ event: SessionEvent; appended: boolean; promptText: string }> {
    return this.enqueue(id, async () => {
      const events = await this.events(id)
      const existing = events.find((event) => (
        event.type === 'turn.undone'
        && (event.data as { sessionNodeId?: unknown }).sessionNodeId === options.sessionNodeId
      ))
      if (existing) return { event: existing, appended: false, promptText: options.promptText }

      const state = await this.get(id)
      if (state.pendingTurnUndo) throw new Error(`Turn undo ${state.pendingTurnUndo.id} is already pending`)
      options.beforeCommit(state, events)
      const targetTurnIds = [...new Set(options.targetTurnIds)]
      if (targetTurnIds.length === 0 || targetTurnIds.some((turnId) => typeof turnId !== 'string' || !turnId)) {
        throw new Error('Turn undo requires at least one target turn')
      }
      const firstTurnId = targetTurnIds[0]
      const recordedBoundary = state.turnMessageStarts?.[firstTurnId]
      const fallbackBoundary = findLastMessageIndex(state.messages, (message) => message.role === 'user')
      const messageCountAfter = recordedBoundary ?? fallbackBoundary
      if (!Number.isSafeInteger(messageCountAfter) || messageCountAfter < 0 || messageCountAfter >= state.messages.length) {
        throw new Error('The last turn cannot be rewound from the persisted model context')
      }

      const createdAt = new Date().toISOString()
      const eventId = createId('evt')
      const pending: DurablePendingTurnUndo = {
        id: createId('undo'),
        eventId,
        sessionNodeId: options.sessionNodeId,
        targetTurnIds,
        promptText: options.promptText,
        messageCountAfter,
        eventData: {
          sessionNodeId: options.sessionNodeId,
          targetMessageEventId: options.sessionNodeId,
          targetTurnIds,
          promptRestored: true,
          attachmentsCleared: true,
          feedbackPreserved: true,
          workspaceReverted: false,
        },
        createdAt,
      }
      state.messages = state.messages.slice(0, messageCountAfter)
      for (const turnId of targetTurnIds) delete state.turnMessageStarts?.[turnId]
      state.pendingTurnUndo = pending
      state.summary.updatedAt = createdAt
      await this.writeState(id, state)

      const event = await this.appendUnqueued(id, 'turn.undone', pending.eventData, {
        turnId: targetTurnIds.at(-1),
        eventId,
      })
      const committed = await this.get(id)
      if (committed.pendingTurnUndo?.id === pending.id) {
        delete committed.pendingTurnUndo
        committed.summary.updatedAt = new Date().toISOString()
        await this.writeState(id, committed)
      }
      return { event, appended: true, promptText: options.promptText }
    })
  }

  private async appendUnqueued<T extends Record<string, unknown>>(
    id: string,
    type: SessionEvent<T>['type'],
    data: T,
    context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'> & { eventId?: string },
  ): Promise<SessionEvent<T>> {
    const { eventId, ...eventContext } = context
    if (eventId) {
      const prior = (await this.events(id)).find((event) => event.id === eventId)
      if (prior) {
        if (prior.type !== type) throw new Error(`Event id ${eventId} is already used by ${prior.type}`)
        return prior as SessionEvent<T>
      }
    }
    let seq = this.lastSeq.get(id)
    if (seq === undefined) {
      const prior = await this.events(id)
      seq = prior.at(-1)?.seq ?? 0
    }
    const visibleData = type === 'turn.started' ? data : this.redactForDisplay(id, data)
    const event: SessionEvent<T> = {
      id: eventId ?? createId('evt'),
      sessionId: id,
      seq: seq + 1,
      type,
      at: new Date().toISOString(),
      ...eventContext,
      data: visibleData,
    }
    await appendFile(this.eventsPath(id), `${JSON.stringify(event)}\n`, 'utf8')
    this.lastSeq.set(id, event.seq)
    for (const listener of this.listeners.get(id) ?? []) listener(event)
    return event
  }

  subscribe(id: string, listener: EventListener): () => void {
    assertSessionId(id)
    const set = this.listeners.get(id) ?? new Set<EventListener>()
    set.add(listener)
    this.listeners.set(id, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(id)
    }
  }

  registerSensitiveValues(id: string, values: Iterable<string>): void {
    assertSessionId(id)
    const current = this.sensitiveValues.get(id) ?? new Set<string>()
    for (const value of values) if (value) current.add(value)
    if (current.size > 0) this.sensitiveValues.set(id, current)
  }

  hasSensitiveValues(id: string): boolean {
    return (this.sensitiveValues.get(id)?.size ?? 0) > 0
  }

  redactTextForDisplay(id: string, text: string): string {
    return redactWorkspacePath(redactText(text, this.sensitiveValues.get(id) ?? []), this.workspaceDir(id))
  }

  redactForDisplay<T>(id: string, value: T): T {
    return redactWorkspaceValue(redactDisplayValue(value, this.sensitiveValues.get(id) ?? []), this.workspaceDir(id))
  }

  private async initializeOnce(): Promise<void> {
    const sessionsRoot = resolve(this.root, 'sessions')
    await mkdir(sessionsRoot, { recursive: true })
    const names = await readdir(sessionsRoot)
    for (const id of names.filter((name) => /^ses_[a-z0-9]{20}$/.test(name))) {
      try {
        const state = await this.get(id)
        this.registerSensitiveValues(id, findSensitiveValues(JSON.stringify(state.messages)))
        await this.repairEventLog(id)
        await this.recoverSession(id)
      } catch {
        // A corrupt session remains isolated and is omitted by list(); other sessions still recover.
      }
    }
  }

  private async repairEventLog(id: string): Promise<void> {
    let text = ''
    try {
      text = await readFile(this.eventsPath(id), 'utf8')
    } catch {
      await writeFile(this.eventsPath(id), '', 'utf8')
      this.lastSeq.set(id, 0)
      return
    }
    const parsed = parseEventLog(text)
    if (parsed.invalidLines > 0 || (text.length > 0 && !text.endsWith('\n'))) {
      const repaired = parsed.events.map((event) => JSON.stringify(event)).join('\n')
      const temporary = `${this.eventsPath(id)}.repair-${process.pid}-${Date.now()}`
      await writeFile(temporary, repaired ? `${repaired}\n` : '', 'utf8')
      await rename(temporary, this.eventsPath(id))
    }
    this.lastSeq.set(id, parsed.events.reduce((maximum, event) => Math.max(maximum, event.seq), 0))
  }

  private async recoverPendingDeployment(
    id: string,
    pending: DurablePendingDeployment,
    events: SessionEvent[],
  ): Promise<DeploymentCheckpointRecovery> {
    const phase = pending.phase
    const deployingEventReconstructed = !events.some((event) => event.id === pending.deployingEventId)
    await this.append(id, 'deployment.updated', {
      deployment: pending.deploying,
      action: 'deploying',
      recovered: true,
    }, {
      ...pending.context,
      eventId: pending.deployingEventId,
    })

    let manifestVerified = false
    let completed = pending.completed
    let completionAction = pending.completionAction
    const target = this.deploymentRevisionDir(id, pending.revision)
    if (phase === 'snapshotting') {
      const snapshot = await readVerifiedStaticDeploymentSnapshot(target)
      manifestVerified = Boolean(snapshot)
      if (snapshot) {
        completed = {
          id: pending.deploymentId,
          status: 'deployed',
          url: pending.url,
          visibility: pending.visibility,
          revision: pending.revision,
          entryPath: snapshot.entryPath,
          contentHash: snapshot.contentHash,
          fileCount: snapshot.fileCount,
          bytes: snapshot.bytes,
          createdAt: pending.createdAt,
          updatedAt: new Date().toISOString(),
        }
        completionAction = pending.successAction
      } else {
        await removeStaticDeploymentSnapshot(target)
        completed = interruptedDeploymentState(pending)
        completionAction = 'deploy_interrupted'
      }
    } else if (
      completed?.status === 'deployed'
      && (completionAction === 'deployed' || completionAction === 'redeployed')
    ) {
      const snapshot = await readVerifiedStaticDeploymentSnapshot(target)
      manifestVerified = Boolean(
        snapshot
        && completed.revision === pending.revision
        && completed.entryPath === snapshot.entryPath
        && completed.contentHash === snapshot.contentHash
        && completed.fileCount === snapshot.fileCount
        && completed.bytes === snapshot.bytes,
      )
      if (!manifestVerified) {
        await removeStaticDeploymentSnapshot(target)
        completed = interruptedDeploymentState(pending)
        completionAction = 'deploy_interrupted'
        const completionAlreadyPublished = events.some((event) => event.id === pending.completionEventId)
        await this.update(id, (state) => {
          const current = state.pendingDeployment
          if (!current || current.id !== pending.id) throw new Error(`Deployment checkpoint ${pending.id} changed during recovery`)
          state.deployment = completed as DeploymentState
          state.pendingDeployment = {
            ...current,
            completed,
            completionAction,
            // If the earlier success boundary reached JSONL, retain it as
            // history and publish a distinct corruption/interruption boundary.
            ...(completionAlreadyPublished ? { completionEventId: createId('evt') } : {}),
          }
        })
      }
    }
    if (!completed || !completionAction) {
      throw new Error(`Deployment checkpoint ${pending.id} is ready without a completion projection`)
    }

    const publicationCheckpoint = (await this.get(id)).pendingDeployment
    if (!publicationCheckpoint || publicationCheckpoint.id !== pending.id) {
      throw new Error(`Deployment checkpoint ${pending.id} disappeared during recovery`)
    }
    const beforeCompletion = await this.events(id)
    const completionEventReconstructed = !beforeCompletion.some((event) => event.id === publicationCheckpoint.completionEventId)
    await this.settleDeploymentSnapshot(id, pending.id, completed, completionAction)
    return {
      checkpointId: pending.id,
      revision: pending.revision,
      phase,
      manifestVerified,
      deployingEventReconstructed,
      completionEventReconstructed,
      completionAction,
      status: completed.status,
    }
  }

  private async recoverPendingUploads(
    id: string,
    state: StoredSession,
    events: SessionEvent[],
  ): Promise<{
    checkpoints: UploadCheckpointRecovery[]
    orphanTemporaryFilesRemoved: number
    workspaceBytesBefore: number
  }> {
    const workspaceBytesBefore = state.summary.workspaceBytes
    const checkpoints: UploadCheckpointRecovery[] = []
    for (const [checkpointKey, value] of Object.entries(state.pendingUploads ?? {})) {
      const pending = pendingUploadFromValue(value, checkpointKey)
      if (!pending) {
        await this.discardPendingUpload(id, checkpointKey)
        checkpoints.push({
          id: checkpointKey,
          path: '',
          eventId: '',
          result: 'abandoned',
          reconstructedEvent: false,
          reassignedPath: false,
          reason: 'invalid_checkpoint',
        })
        continue
      }

      const existingEvent = events.find((event) => event.id === pending.eventId)
      if (existingEvent && !uploadEventMatches(existingEvent, pending)) {
        throw new Error(`Upload event ${pending.eventId} does not match checkpoint ${pending.id}`)
      }
      const finalMatches = await uploadFileMatches(this.workspaceDir(id), pending.path, pending)
      if (existingEvent && !finalMatches) {
        // A published event can only be paired with the exact path it named.
        // Do not silently redirect history if an external mutation replaced it.
        await this.discardPendingUpload(id, pending.id)
        checkpoints.push({
          id: pending.id,
          path: pending.path,
          eventId: pending.eventId,
          result: 'abandoned',
          reconstructedEvent: false,
          reassignedPath: false,
          reason: 'missing_or_corrupt_bytes',
        })
        continue
      }

      let recovered = pending
      let reassignedPath = false
      if (!finalMatches) {
        if (!await verifiedFileMatches(resolve(this.sessionDir(id), pending.temporaryPath), pending)) {
          await this.discardPendingUpload(id, pending.id)
          checkpoints.push({
            id: pending.id,
            path: pending.path,
            eventId: pending.eventId,
            result: 'abandoned',
            reconstructedEvent: false,
            reassignedPath: false,
            reason: 'missing_or_corrupt_bytes',
          })
          continue
        }
        recovered = await this.materializePendingUpload(id, pending.id)
        reassignedPath = recovered.path !== pending.path
      }

      await this.publishPendingUpload(id, pending.id)
      checkpoints.push({
        id: recovered.id,
        path: recovered.path,
        eventId: recovered.eventId,
        result: existingEvent ? 'already_published' : 'published',
        reconstructedEvent: !existingEvent,
        reassignedPath,
      })
    }

    const current = await this.get(id)
    const activeTemporaryPaths = new Set(Object.values(current.pendingUploads ?? {}).map((pending) => pending.temporaryPath))
    const orphanTemporaryFilesRemoved = await cleanupOrphanUploadTemporaryFiles(
      this.sessionDir(id),
      activeTemporaryPaths,
    )
    return { checkpoints, orphanTemporaryFilesRemoved, workspaceBytesBefore }
  }

  private async discardPendingUpload(id: string, uploadId: string): Promise<void> {
    let temporaryPath: string | undefined
    await this.enqueue(id, async () => {
      const state = await this.get(id)
      temporaryPath = state.pendingUploads?.[uploadId]?.temporaryPath
      if (!state.pendingUploads?.[uploadId]) return
      delete state.pendingUploads[uploadId]
      if (Object.keys(state.pendingUploads).length === 0) delete state.pendingUploads
      state.summary.workspaceBytes = await workspaceSize(this.workspaceDir(id))
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
    })
    if (
      /^upl_[a-f0-9]{20}$/.test(uploadId)
      && temporaryPath === `upload-staging/${uploadId}.part`
    ) {
      await rm(resolve(this.sessionDir(id), temporaryPath), { force: true })
    }
  }

  private async recoverPendingWorkspaceMutations(
    id: string,
    state: StoredSession,
    events: SessionEvent[],
  ): Promise<{
    checkpoints: WorkspaceMutationCheckpointRecovery[]
    orphanTemporaryFilesRemoved: number
    workspaceBytesBefore: number
  }> {
    const workspaceBytesBefore = state.summary.workspaceBytes
    const checkpoints: WorkspaceMutationCheckpointRecovery[] = []
    for (const [checkpointKey, value] of Object.entries(state.pendingWorkspaceMutations ?? {})) {
      const pending = pendingWorkspaceMutationFromValue(value, checkpointKey, id)
      if (!pending) {
        await this.discardPendingWorkspaceMutation(id, checkpointKey)
        checkpoints.push({
          id: checkpointKey,
          kind: 'invalid',
          path: '',
          fileEventId: '',
          result: 'abandoned',
          materialized: false,
          reconstructedFileEvent: false,
          reconstructedArtifactEvent: false,
          reason: 'invalid_checkpoint',
        })
        continue
      }

      const existingFileEvent = events.find((event) => event.id === pending.fileEventId)
      if (existingFileEvent && !workspaceMutationEventMatches(
        existingFileEvent,
        'file.changed',
        this.redactForDisplay(id, workspaceMutationFileEventData(pending)),
      )) throw new Error(`Workspace mutation event ${pending.fileEventId} does not match checkpoint ${pending.id}`)

      let materialized = false
      if (!existingFileEvent) {
        const outcome = await this.materializePendingWorkspaceMutation(id, pending)
        materialized = outcome.materialized
        if (outcome.reason) {
          await this.discardPendingWorkspaceMutation(id, pending.id)
          checkpoints.push({
            id: pending.id,
            kind: pending.kind,
            path: pending.path,
            fileEventId: pending.fileEventId,
            result: 'abandoned',
            materialized,
            reconstructedFileEvent: false,
            reconstructedArtifactEvent: false,
            reason: outcome.reason,
          })
          continue
        }
      }
      const publication = await this.publishPendingWorkspaceMutation(id, pending.id)
      checkpoints.push({
        id: pending.id,
        kind: pending.kind,
        path: pending.path,
        fileEventId: pending.fileEventId,
        result: existingFileEvent ? 'already_published' : 'published',
        materialized,
        reconstructedFileEvent: publication.reconstructedFileEvent,
        reconstructedArtifactEvent: publication.reconstructedArtifactEvent,
      })
    }

    const current = await this.get(id)
    const active = new Set<string>()
    for (const pending of Object.values(current.pendingWorkspaceMutations ?? {})) {
      if (pending.temporaryPath) active.add(pending.temporaryPath)
      if (pending.installPath) active.add(pending.installPath)
    }
    const orphanTemporaryFilesRemoved = await cleanupOrphanWorkspaceMutationFiles(this.sessionDir(id), active)
    return { checkpoints, orphanTemporaryFilesRemoved, workspaceBytesBefore }
  }

  private async recoverPendingWorkspaceEventBatches(
    id: string,
    state: StoredSession,
    events: SessionEvent[],
  ): Promise<{ batches: WorkspaceEventBatchRecovery[]; workspaceBytesBefore: number }> {
    const workspaceBytesBefore = state.summary.workspaceBytes
    const batches: WorkspaceEventBatchRecovery[] = []
    for (const [checkpointKey, value] of Object.entries(state.pendingWorkspaceEventBatches ?? {})) {
      const pending = pendingWorkspaceEventBatchFromValue(value, checkpointKey, id)
      if (!pending) {
        await this.discardWorkspaceEventBatch(id, checkpointKey)
        batches.push({
          id: checkpointKey,
          source: 'invalid',
          result: 'abandoned',
          changeCount: 0,
          reconstructedFileEvents: 0,
          reconstructedArtifactEvents: 0,
          reason: 'invalid_checkpoint',
        })
        continue
      }
      const publicationStarted = pending.changes.some((change) => (
        events.some((event) => event.id === change.fileEventId || event.id === change.artifactEventId)
      ))
      if (!publicationStarted && !await workspaceEventBatchPostImageMatches(this.workspaceDir(id), pending)) {
        await this.discardWorkspaceEventBatch(id, pending.id)
        batches.push({
          id: pending.id,
          source: pending.source,
          result: 'abandoned',
          changeCount: pending.changes.length,
          reconstructedFileEvents: 0,
          reconstructedArtifactEvents: 0,
          reason: 'post_image_mismatch',
        })
        continue
      }
      const publication = await this.publishWorkspaceEventBatch(id, pending.id)
      batches.push({
        id: pending.id,
        source: pending.source,
        result: publicationStarted ? 'already_publishing' : 'published',
        changeCount: pending.changes.length,
        ...publication,
      })
    }
    return { batches, workspaceBytesBefore }
  }

  private async recoverPendingShellReconciliations(
    id: string,
    state: StoredSession,
  ): Promise<ShellReconciliationRecovery[]> {
    const recoveries: ShellReconciliationRecovery[] = []
    for (const [checkpointKey, value] of Object.entries(state.pendingShellReconciliations ?? {})) {
      const pending = pendingShellReconciliationFromValue(value, checkpointKey)
      if (!pending) {
        await this.discardPendingShellReconciliation(id, checkpointKey)
        recoveries.push({
          id: checkpointKey,
          guardianId: '',
          result: 'invalid_abandoned',
          changeCount: 0,
        })
        continue
      }
      let guardianTermination: ManagedProcessRecoveryResult | undefined
      if (pending.phase === 'armed' && pending.guardianPid) {
        guardianTermination = await terminateRecoveredManagedProcess({
          id: pending.guardianId,
          pid: pending.guardianPid,
        })
      }
      const settled = await this.settleShellReconciliation(id, pending.id)
      recoveries.push({
        id: pending.id,
        guardianId: pending.guardianId,
        ...(guardianTermination ? { guardianTermination } : {}),
        result: settled.batchId ? 'published' : 'no_changes',
        ...(settled.batchId ? { batchId: settled.batchId } : {}),
        changeCount: settled.changeCount,
      })
    }
    return recoveries
  }

  private async discardPendingShellReconciliation(id: string, checkpointId: string): Promise<void> {
    await this.enqueue(id, async () => {
      const state = await this.get(id)
      if (!state.pendingShellReconciliations?.[checkpointId]) return
      delete state.pendingShellReconciliations[checkpointId]
      if (Object.keys(state.pendingShellReconciliations).length === 0) delete state.pendingShellReconciliations
      state.summary.workspaceBytes = await workspaceSize(this.workspaceDir(id))
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
    })
  }

  private async discardPendingWorkspaceMutation(id: string, mutationId: string): Promise<void> {
    let pending: DurablePendingWorkspaceMutation | undefined
    await this.enqueue(id, async () => {
      const state = await this.get(id)
      pending = state.pendingWorkspaceMutations?.[mutationId]
      if (!pending) return
      delete state.pendingWorkspaceMutations?.[mutationId]
      if (state.pendingWorkspaceMutations && Object.keys(state.pendingWorkspaceMutations).length === 0) {
        delete state.pendingWorkspaceMutations
      }
      state.summary.workspaceBytes = await workspaceSize(this.workspaceDir(id))
      state.summary.updatedAt = new Date().toISOString()
      await this.writeState(id, state)
    })
    if (pending) await cleanupWorkspaceMutationFiles(this.sessionDir(id), pending)
    else if (/^wmut_[a-f0-9]{20}$/.test(mutationId)) {
      await Promise.all([
        rm(resolve(this.workspaceMutationStagingDir(id), `${mutationId}.part`), { force: true }),
        rm(resolve(this.workspaceMutationStagingDir(id), `${mutationId}.install`), { force: true }),
      ])
    }
  }

  private async recoverSession(id: string): Promise<void> {
    let state = await this.get(id)
    let events = await this.events(id)
    const workspacePatchRecovery: WorkspacePatchRecovery[] = await recoverWorkspacePatchTransactions(
      this.workspaceDir(id),
      this.workspacePatchTransactionDir(id),
    )
    const uploadRecovery = await this.recoverPendingUploads(id, state, events)
    if (uploadRecovery.checkpoints.length > 0 || uploadRecovery.orphanTemporaryFilesRemoved > 0) {
      state = await this.get(id)
      events = await this.events(id)
    }
    const workspaceMutationRecovery = await this.recoverPendingWorkspaceMutations(id, state, events)
    if (workspaceMutationRecovery.checkpoints.length > 0 || workspaceMutationRecovery.orphanTemporaryFilesRemoved > 0) {
      state = await this.get(id)
      events = await this.events(id)
    }
    const shellReconciliationRecovery = await this.recoverPendingShellReconciliations(id, state)
    if (shellReconciliationRecovery.length > 0) {
      state = await this.get(id)
      events = await this.events(id)
    }
    const workspaceEventBatchRecovery = await this.recoverPendingWorkspaceEventBatches(id, state, events)
    if (workspaceEventBatchRecovery.batches.length > 0) {
      state = await this.get(id)
      events = await this.events(id)
    }
    const pendingHitl = state.pendingHitl
    const pendingApprovals = state.pendingApprovals
    for (const request of Object.values(pendingHitl ?? {}).filter(isRestartResumableHitl)) {
      await this.append(id, 'hitl.required', {
        hitlId: request.id,
        kind: request.kind,
        call: request.call,
        title: request.title,
        payload: request.payload,
      }, {
        turnId: request.turnId,
        stepId: request.stepId,
        callId: request.callId,
        eventId: request.requiredEventId,
      })
      if (request.response && request.resolvedEventId) {
        await this.append(id, 'hitl.resolved', {
          hitlId: request.id,
          kind: request.kind,
          response: request.response,
        }, {
          turnId: request.turnId,
          stepId: request.stepId,
          callId: request.callId,
          eventId: request.resolvedEventId,
        })
      }
    }
    for (const request of Object.values(pendingApprovals ?? {}).filter(isRestartResumableApproval)) {
      await this.append(id, 'approval.required', {
        approvalId: request.id,
        call: request.call,
        title: request.title,
        description: request.description,
      }, {
        turnId: request.turnId,
        stepId: request.stepId,
        callId: request.callId,
        eventId: request.requiredEventId,
      })
      if (typeof request.approved === 'boolean' && request.resolvedEventId) {
        await this.append(id, 'approval.resolved', {
          approvalId: request.id,
          approved: request.approved,
          decision: request.approved ? 'approved' : 'denied',
          requestSignature: request.requestSignature,
        }, {
          turnId: request.turnId,
          stepId: request.stepId,
          callId: request.callId,
          eventId: request.resolvedEventId,
        })
      }
    }
    if (Object.keys(pendingHitl ?? {}).length > 0 || Object.keys(pendingApprovals ?? {}).length > 0) {
      events = await this.events(id)
    }
    const pendingCreation = state.pendingCreation
    const existingCreationEvent = events.find((event) => event.type === 'session.created')
    const creationEventData = pendingCreation?.eventData ?? {
      title: state.summary.title,
      productMode: state.summary.productMode,
      repository: state.repository,
      isFreeSession: state.summary.isFreeSession,
      feedbackType: state.summary.feedbackType,
      customFeedbackArm: state.summary.customFeedbackArm,
    }
    const creationEventId = pendingCreation?.eventId ?? createId('evt')
    const creationEventReconstructed = !existingCreationEvent
    if (pendingCreation || !existingCreationEvent) {
      await this.append(id, 'session.created', creationEventData, {
        eventId: pendingCreation?.eventId ?? creationEventId,
      })
      events = await this.events(id)
    }
    const pendingStart = state.pendingStart
    let reconstructedStartEvent = false
    if (pendingStart) {
      const eventType = pendingStart.kind === 'submit' ? 'turn.started' : 'run.resumed'
      reconstructedStartEvent = !events.some((event) => event.id === pendingStart.eventId)
      await this.append(id, eventType, pendingStart.eventData, {
        turnId: pendingStart.turnId,
        eventId: pendingStart.eventId,
      })
      events = await this.events(id)
    }
    const pendingTerminal = state.pendingTerminal
    const recoveredTerminalEvents = pendingTerminal
      ? [
          ...pendingTerminal.events.map((event) => ({
            id: event.id,
            type: event.type,
            lane: 'terminal' as const,
            reconstructed: !events.some((existing) => existing.id === event.id),
          })),
          ...(pendingTerminal.workspacePersistenceEvents ?? []).map((event) => ({
            id: event.id,
            type: event.type,
            lane: 'workspace_persistence' as const,
            reconstructed: !events.some((existing) => existing.id === event.id),
          })),
        ]
      : []
    if (pendingTerminal) {
      const terminalWasVisible = pendingTerminal.terminalPublished
        || pendingTerminal.events.some((event) => events.some((existing) => existing.id === event.id))
      // A newly recovered dual-lane checkpoint must retain the same opening
      // boundary as live publication: scanning is visible before Final. Once a
      // terminal event was already durable its historical order cannot change;
      // preallocated ids still make completion of both lanes idempotent.
      const lanes = pendingTerminal.workspacePersistenceEvents && !terminalWasVisible
        ? [pendingTerminal.workspacePersistenceEvents ?? [], pendingTerminal.events]
        : [pendingTerminal.events, pendingTerminal.workspacePersistenceEvents ?? []]
      for (const lane of lanes) {
        for (const event of lane) {
          await this.append(id, event.type, event.data, {
            turnId: pendingTerminal.turnId,
            stepId: pendingTerminal.stepId,
            eventId: event.id,
          })
        }
      }
      events = await this.events(id)
    }
    const pendingTurnUndo = state.pendingTurnUndo
    const reconstructedTurnUndoEvent = Boolean(
      pendingTurnUndo && !events.some((event) => event.id === pendingTurnUndo.eventId),
    )
    if (pendingTurnUndo) {
      await this.append(id, 'turn.undone', pendingTurnUndo.eventData, {
        turnId: pendingTurnUndo.targetTurnIds.at(-1),
        eventId: pendingTurnUndo.eventId,
      })
      events = await this.events(id)
    }
    const pendingDeployment = state.pendingDeployment
    const deploymentCheckpointRecovery = pendingDeployment
      ? await this.recoverPendingDeployment(id, pendingDeployment, events)
      : undefined
    if (deploymentCheckpointRecovery) {
      state = await this.get(id)
      events = await this.events(id)
    }
    const processReconciliation = reconcileProcessRecords(state.processes, events)
    state.processes = processReconciliation.records
    const websiteReconciliation = reconcileWebsiteState(state.website, events)
    state.website = websiteReconciliation.website
    const missingWebsiteEventProjection = websiteReconciliation.missingEvent
      ? { ...state.website }
      : undefined
    const deploymentReconciliation = reconcileDeploymentState(state.deployment, events)
    state.deployment = deploymentReconciliation.deployment
    if (state.deployment.revision === 0) state.deploymentManifestRequired = false
    const missingDeploymentEventProjection = deploymentReconciliation.missingEvent
      ? { ...state.deployment }
      : undefined
    const interruptedDeploymentStatus = ['building', 'deploying'].includes(state.deployment.status)
      ? state.deployment.status as 'building' | 'deploying'
      : undefined
    const verifiedMaterializedDeployment = !deploymentCheckpointRecovery
      && state.deploymentManifestRequired === true
      && state.deployment.revision > 0
      ? await readVerifiedStaticDeploymentSnapshot(this.deploymentRevisionDir(id, state.deployment.revision))
      : undefined
    const materializedDeploymentCorrupted = state.deploymentManifestRequired === true
      && state.deployment.revision > 0
      && !deploymentCheckpointRecovery
      && !deploymentSnapshotMatchesState(verifiedMaterializedDeployment, state.deployment)
    const corruptedDeploymentRevision = materializedDeploymentCorrupted ? state.deployment.revision : undefined
    const planReconciliation = reconcilePlanState(state.plan, events)
    state.plan = planReconciliation.plan
    const missingPlanEventProjection = planReconciliation.missingEvent && state.plan
      ? { ...state.plan, items: state.plan.items.map((item) => ({ ...item })) }
      : undefined
    const artifactReconciliation = await reconcileArtifactRecords(
      id,
      this.workspaceDir(id),
      state.artifacts,
      events,
    )
    state.artifacts = artifactReconciliation.artifacts
    const materializedWorkspaceBytes = state.summary.workspaceBytes
    const observedWorkspaceBytes = await workspaceSize(this.workspaceDir(id))
    const workspaceBytesChanged = materializedWorkspaceBytes !== observedWorkspaceBytes
    state.summary.workspaceBytes = observedWorkspaceBytes
    const managedWebsiteProcessId = state.website.processId
    const managedWebsiteNeedsSleep = Boolean(
      managedWebsiteProcessId
      && ['running', 'starting'].includes(state.website.status),
    )
    const resumableCallIds = new Set([
      ...Object.values(pendingHitl ?? {}).filter(isRestartResumableHitl).map((entry) => entry.callId),
      ...Object.values(pendingApprovals ?? {}).filter(isRestartResumableApproval).map((entry) => entry.callId),
    ])
    const resumableInteraction = resumableCallIds.size > 0
    // A resumable human interaction belongs to the still-open latest assistant
    // tool batch. Do not materialize a partial repair tail here: the Agent will
    // reconstruct the whole batch atomically, in the assistant's original
    // order, once every card has a durable response. Filtering by call id is
    // insufficient because providers may repeat a non-empty id in one batch.
    const toolRepairs = resumableInteraction
      ? []
      : repairInterruptedToolTail(state.messages, events, state.deployment)
    const transient = !pendingTerminal
      && !resumableInteraction
      && (Boolean(pendingStart) || ['queued', 'running', 'awaiting_approval', 'awaiting_user', 'cancelling'].includes(state.summary.status))
    const interruptedRun = transient
      ? interruptedRunRecoveryEvidence(state.messages, events, pendingStart)
      : undefined
    const interruptedProcesses = state.processes.filter((process) => process.status === 'running')
    const processRepairRequired = processReconciliation.materializedChanged
      || processReconciliation.missingStartedIds.size > 0
      || processReconciliation.missingStoppedIds.size > 0
    const websiteRepairRequired = managedWebsiteNeedsSleep
      || websiteReconciliation.materializedChanged
      || websiteReconciliation.missingEvent
    const deploymentRepairRequired = Boolean(deploymentCheckpointRecovery)
      || Boolean(interruptedDeploymentStatus)
      || materializedDeploymentCorrupted
      || deploymentReconciliation.materializedChanged
      || deploymentReconciliation.missingEvent
    const planRepairRequired = planReconciliation.materializedChanged || planReconciliation.missingEvent
    const artifactRepairRequired = artifactReconciliation.materializedChanged || artifactReconciliation.repairs.length > 0
    const uploadRepairRequired = workspaceBytesChanged
      || uploadRecovery.checkpoints.length > 0
      || uploadRecovery.orphanTemporaryFilesRemoved > 0
    const workspaceMutationRepairRequired = workspaceMutationRecovery.checkpoints.length > 0
      || workspaceMutationRecovery.orphanTemporaryFilesRemoved > 0
    const workspaceEventBatchRepairRequired = workspaceEventBatchRecovery.batches.length > 0
    const shellReconciliationRepairRequired = shellReconciliationRecovery.length > 0
    const workspacePatchRepairRequired = workspacePatchRecovery.length > 0
    const creationRepairRequired = Boolean(pendingCreation) || !existingCreationEvent
    if (
      !pendingTerminal
      && !pendingTurnUndo
      && !creationRepairRequired
      && !transient
      && interruptedProcesses.length === 0
      && toolRepairs.length === 0
      && !processRepairRequired
      && !websiteRepairRequired
      && !deploymentRepairRequired
      && !planRepairRequired
      && !artifactRepairRequired
      && !uploadRepairRequired
      && !workspaceMutationRepairRequired
      && !workspaceEventBatchRepairRequired
      && !shellReconciliationRepairRequired
      && !workspacePatchRepairRequired
    ) return

    const recoveredProcessTermination: ManagedProcessRecoveryResult[] = []
    for (const process of interruptedProcesses) {
      recoveredProcessTermination.push(await terminateRecoveredManagedProcess(process))
    }

    const now = new Date().toISOString()
    const previousStatus = state.summary.status
    if (pendingTerminal && state.summary.status !== pendingTerminal.status) {
      transitionRunStatus(state, pendingTerminal.status, now)
    } else if (transient) {
      state.summary.status = 'interrupted'
      state.summary.usage.completedAt = now
      if (state.summary.usage.activeSinceAt) {
        state.summary.usage.activeDurationMs = (state.summary.usage.activeDurationMs ?? 0) + Math.max(0, Date.parse(now) - Date.parse(state.summary.usage.activeSinceAt))
        delete state.summary.usage.activeSinceAt
      } else if (state.summary.usage.startedAt && state.summary.usage.activeDurationMs === undefined) {
        // Backward-compatible recovery for sessions created before active segments were persisted.
        state.summary.usage.activeDurationMs = Math.max(0, Date.parse(now) - Date.parse(state.summary.usage.startedAt))
      }
      state.summary.usage.durationMs = state.summary.usage.activeDurationMs ?? 0
    }
    delete state.pendingStart
    delete state.pendingTerminal
    delete state.pendingTurnUndo
    delete state.pendingCreation
    if (!resumableInteraction) {
      delete state.pendingHitl
      delete state.pendingApprovals
    }
    delete state.forceCompactionRequested
    state.processes = state.processes.map((process) => process.status === 'running'
      ? { ...process, status: 'interrupted' as const, completedAt: now, signal: 'SERVER_RESTART' }
      : process)
    if (interruptedRun?.partial?.messageAppended) {
      state.messages.push({ role: 'assistant', content: interruptedRun.partial.content })
    }
    let recoveredWebsiteAction: 'server_restarted' | 'process_not_running' | 'projection_repaired' | 'event_replayed' | undefined
    if (managedWebsiteNeedsSleep) {
      const recoveredProcess = state.processes.find((process) => process.id === managedWebsiteProcessId)
      recoveredWebsiteAction = recoveredProcess?.signal === 'SERVER_RESTART'
        ? 'server_restarted'
        : 'process_not_running'
      state.website = { ...state.website, status: 'asleep', updatedAt: now }
    } else if (websiteReconciliation.missingEvent) {
      recoveredWebsiteAction = 'projection_repaired'
    } else if (websiteReconciliation.materializedChanged) {
      recoveredWebsiteAction = 'event_replayed'
    }
    let recoveredDeploymentAction: 'deployment_corrupted' | 'deploy_interrupted' | 'projection_repaired' | 'event_replayed' | DurableDeploymentCompletionAction | undefined
    if (materializedDeploymentCorrupted && corruptedDeploymentRevision) {
      if (interruptedDeploymentStatus) {
        await removeStaticDeploymentSnapshot(this.deploymentRevisionDir(id, corruptedDeploymentRevision + 1))
      }
      await removeStaticDeploymentSnapshot(this.deploymentRevisionDir(id, corruptedDeploymentRevision))
      const corrupted = state.deployment
      state.deployment = {
        status: 'failed',
        id: corrupted.id,
        url: corrupted.url,
        visibility: corrupted.visibility,
        revision: 0,
        error: `Deployment revision ${corruptedDeploymentRevision} failed manifest verification after the server restarted.`,
        createdAt: corrupted.createdAt,
        updatedAt: now,
      }
      state.deploymentManifestRequired = false
      recoveredDeploymentAction = 'deployment_corrupted'
    } else if (interruptedDeploymentStatus) {
      await removeStaticDeploymentSnapshot(this.deploymentRevisionDir(id, state.deployment.revision + 1))
      state.deployment = {
        ...state.deployment,
        status: 'failed',
        error: `Deployment ${interruptedDeploymentStatus} was interrupted when the server restarted.`,
        updatedAt: now,
      }
      recoveredDeploymentAction = 'deploy_interrupted'
    } else if (deploymentCheckpointRecovery) {
      recoveredDeploymentAction = deploymentCheckpointRecovery.completionAction
    } else if (deploymentReconciliation.missingEvent) {
      recoveredDeploymentAction = 'projection_repaired'
    } else if (deploymentReconciliation.materializedChanged) {
      recoveredDeploymentAction = 'event_replayed'
    }
    const recoveredPlanAction = planReconciliation.missingEvent
      ? 'projection_repaired' as const
      : planReconciliation.materializedChanged
        ? 'event_replayed' as const
        : undefined
    if (toolRepairs.length > 0) {
      state.messages.push(...toolRepairs.map((repair) => repair.message))
      // A crash can land after tool.started but before the ordinary usage
      // increment. Preserve the observable attempt count without double-counting
      // calls whose increment was already durable.
      const startedToolCalls = events.filter((event) => event.type === 'tool.started').length
      state.summary.usage.toolCalls = Math.max(state.summary.usage.toolCalls, startedToolCalls)
    }
    state.summary.updatedAt = now

    // Legacy fire-and-forget persistence could leave materialized state
    // without its start event. Reconstruct the missing observable boundary
    // before publishing the recovered terminal record.
    for (const process of state.processes.filter((item) => processReconciliation.missingStartedIds.has(item.id))) {
      await this.append(id, 'process.started', {
        type: 'started',
        record: processStartedProjection(process),
        recovered: true,
      }, processReconciliation.contextById.get(process.id) ?? {})
    }
    if (missingWebsiteEventProjection) {
      await this.append(id, 'website.updated', {
        website: missingWebsiteEventProjection,
        action: 'projection_repaired',
        recovered: true,
      }, websiteReconciliation.context)
    }
    if (missingDeploymentEventProjection) {
      await this.append(id, 'deployment.updated', {
        deployment: missingDeploymentEventProjection,
        action: 'projection_repaired',
        recovered: true,
      }, deploymentReconciliation.context)
    }
    if (interruptedDeploymentStatus && !materializedDeploymentCorrupted) {
      await this.append(id, 'deployment.updated', {
        deployment: state.deployment,
        action: 'deploy_interrupted',
        interruptedStage: interruptedDeploymentStatus,
        recovered: true,
      }, deploymentReconciliation.context)
    }
    if (materializedDeploymentCorrupted) {
      await this.append(id, 'deployment.updated', {
        deployment: state.deployment,
        action: 'deployment_corrupted',
        corruptedRevision: corruptedDeploymentRevision,
        recovered: true,
      }, deploymentReconciliation.context)
    }
    if (missingPlanEventProjection) {
      await this.append(id, 'plan.updated', {
        plan: missingPlanEventProjection,
        explanation: missingPlanEventProjection.explanation,
        action: 'projection_repaired',
        recovered: true,
      }, planReconciliation.context)
    }
    for (const repair of artifactReconciliation.repairs) {
      if (repair.type === 'artifact.created' && !repair.artifact) continue
      await this.append(id, repair.type, {
        ...(repair.artifact ? { artifact: repair.artifact } : {}),
        path: repair.path,
        reason: repair.reason,
        recovered: true,
      }, {
        ...repair.context,
        ...(repair.eventId ? { eventId: repair.eventId } : {}),
      })
    }
    for (const repair of toolRepairs) {
      if (!repair.terminalEvent) continue
      await this.append(id, repair.terminalEvent.type, {
        ...repair.terminalEvent.data,
        call: repair.call,
        result: repair.message.content,
        recovered: true,
      }, repair.context)
    }
    await this.writeState(id, state)

    await this.append(id, 'session.recovered', {
      previousStatus,
      status: state.summary.status,
      interruptedProcessIds: interruptedProcesses.map((process) => process.id),
      ...(creationRepairRequired ? {
        recoveredSessionCreation: {
          eventId: pendingCreation?.eventId ?? creationEventId,
          reconstructedEvent: creationEventReconstructed,
          legacyStateOnly: !pendingCreation && !existingCreationEvent,
        },
      } : {}),
      ...(pendingStart ? {
        recoveredPendingStart: {
          kind: pendingStart.kind,
          turnId: pendingStart.turnId,
          eventId: pendingStart.eventId,
          reconstructedStartEvent,
        },
      } : {}),
      ...(pendingTerminal ? {
        recoveredPendingTerminal: {
          turnId: pendingTerminal.turnId,
          stepId: pendingTerminal.stepId,
          status: pendingTerminal.status,
          terminalPublished: pendingTerminal.terminalPublished === true,
          workspacePersistencePublished: pendingTerminal.workspacePersistencePublished === true,
          events: recoveredTerminalEvents,
        },
      } : {}),
      ...(pendingTurnUndo ? {
        recoveredPendingTurnUndo: {
          id: pendingTurnUndo.id,
          eventId: pendingTurnUndo.eventId,
          sessionNodeId: pendingTurnUndo.sessionNodeId,
          targetTurnIds: pendingTurnUndo.targetTurnIds,
          messageCountAfter: pendingTurnUndo.messageCountAfter,
          reconstructedEvent: reconstructedTurnUndoEvent,
        },
      } : {}),
      ...(interruptedRun?.partial ? {
        partialResponseReconciliation: {
          turnId: interruptedRun.turnId,
          stepId: interruptedRun.stepId,
          eventCount: interruptedRun.partial.eventCount,
          visibleBytes: interruptedRun.partial.visibleBytes,
          messageAppended: interruptedRun.partial.messageAppended,
          alreadyMaterialized: !interruptedRun.partial.messageAppended,
        },
      } : {}),
      repairedToolCalls: toolRepairs.map((repair) => ({
        callId: repair.call.id,
        name: repair.call.name,
        resolution: repair.resolution,
      })),
      processReconciliation: {
        reconstructedMaterializedProcessIds: processReconciliation.reconstructedMaterializedIds,
        reconstructedStartedEventIds: [...processReconciliation.missingStartedIds],
        reconstructedStoppedEventIds: [...new Set([
          ...processReconciliation.missingStoppedIds,
          ...interruptedProcesses.map((process) => process.id),
        ])],
        termination: recoveredProcessTermination,
      },
      ...(recoveredWebsiteAction ? {
        websiteReconciliation: {
          action: recoveredWebsiteAction,
          processId: state.website.processId,
          status: state.website.status,
          materializedFromEvent: websiteReconciliation.materializedChanged,
          reconstructedMissingEvent: websiteReconciliation.missingEvent,
        },
      } : {}),
      ...(recoveredDeploymentAction ? {
        deploymentReconciliation: {
          action: recoveredDeploymentAction,
          status: state.deployment.status,
          revision: state.deployment.revision,
          materializedFromEvent: deploymentReconciliation.materializedChanged,
          reconstructedMissingEvent: deploymentReconciliation.missingEvent,
          ...(interruptedDeploymentStatus ? { interruptedStage: interruptedDeploymentStatus } : {}),
          ...(corruptedDeploymentRevision ? { corruptedRevision: corruptedDeploymentRevision } : {}),
          ...(deploymentCheckpointRecovery ? { checkpoint: deploymentCheckpointRecovery } : {}),
        },
      } : {}),
      ...(recoveredPlanAction ? {
        planReconciliation: {
          action: recoveredPlanAction,
          version: state.plan?.version,
          materializedFromEvent: planReconciliation.materializedChanged,
          reconstructedMissingEvent: planReconciliation.missingEvent,
        },
      } : {}),
      ...(artifactRepairRequired ? {
        artifactReconciliation: {
          materializedChanged: artifactReconciliation.materializedChanged,
          artifactCount: state.artifacts.length,
          repairs: artifactReconciliation.repairs.map((repair) => ({
            type: repair.type,
            path: repair.path,
            reason: repair.reason,
            eventId: repair.eventId,
          })),
        },
      } : {}),
      ...(uploadRepairRequired ? {
        uploadReconciliation: {
          workspaceBytesBefore: uploadRecovery.workspaceBytesBefore,
          workspaceBytesAfter: observedWorkspaceBytes,
          workspaceBytesRecomputed: workspaceBytesChanged || uploadRecovery.checkpoints.length > 0,
          orphanTemporaryFilesRemoved: uploadRecovery.orphanTemporaryFilesRemoved,
          checkpoints: uploadRecovery.checkpoints,
        },
      } : {}),
      ...(workspaceMutationRepairRequired ? {
        workspaceMutationReconciliation: {
          workspaceBytesBefore: workspaceMutationRecovery.workspaceBytesBefore,
          workspaceBytesAfter: observedWorkspaceBytes,
          workspaceBytesRecomputed: workspaceBytesChanged || workspaceMutationRecovery.checkpoints.length > 0,
          orphanTemporaryFilesRemoved: workspaceMutationRecovery.orphanTemporaryFilesRemoved,
          checkpoints: workspaceMutationRecovery.checkpoints,
        },
      } : {}),
      ...(workspaceEventBatchRepairRequired ? {
        workspaceEventBatchReconciliation: {
          workspaceBytesBefore: workspaceEventBatchRecovery.workspaceBytesBefore,
          workspaceBytesAfter: observedWorkspaceBytes,
          batches: workspaceEventBatchRecovery.batches,
        },
      } : {}),
      ...(shellReconciliationRepairRequired ? {
        shellReconciliation: shellReconciliationRecovery,
      } : {}),
      ...(workspacePatchRepairRequired ? { workspacePatchReconciliation: workspacePatchRecovery } : {}),
      message: 'Recovered persisted state after a server restart.',
    })
    const stoppedEventIds = new Set([
      ...processReconciliation.missingStoppedIds,
      ...interruptedProcesses.map((process) => process.id),
    ])
    for (const process of state.processes.filter((item) => stoppedEventIds.has(item.id))) {
      await this.append(
        id,
        'process.stopped',
        { type: 'stopped', record: process, recovered: true },
        processReconciliation.contextById.get(process.id) ?? {},
      )
    }
    if (managedWebsiteNeedsSleep) {
      await this.append(id, 'website.updated', {
        website: state.website,
        action: recoveredWebsiteAction,
        recovered: true,
      }, state.website.processId
        ? processReconciliation.contextById.get(state.website.processId) ?? {}
        : websiteReconciliation.context)
    }
    if (previousStatus === 'awaiting_approval' && !resumableInteraction) {
      const currentEvents = await this.events(id)
      const resolved = new Set(currentEvents
        .filter((event) => event.type === 'approval.resolved' || event.type === 'approval.expired')
        .map((event) => String((event.data as Record<string, unknown>).approvalId || '')))
      const pending = currentEvents.filter((event) => event.type === 'approval.required' && !resolved.has(String((event.data as Record<string, unknown>).approvalId || '')))
      for (const event of pending) {
        await this.append(id, 'approval.expired', {
          approvalId: String((event.data as Record<string, unknown>).approvalId || ''),
          decision: 'expired',
          reason: 'server_restarted',
        }, { turnId: event.turnId, stepId: event.stepId, callId: event.callId })
      }
    }
    if (previousStatus === 'awaiting_user' && pendingHitl && !resumableInteraction) {
      const currentEvents = await this.events(id)
      const resolved = new Set(currentEvents
        .filter((event) => event.type === 'hitl.resolved' || event.type === 'hitl.expired')
        .map((event) => String((event.data as Record<string, unknown>).hitlId || '')))
      for (const request of Object.values(pendingHitl).filter((entry) => !resolved.has(entry.id))) {
        await this.append(id, 'hitl.expired', {
          hitlId: request.id,
          kind: request.kind,
          decision: 'expired',
          reason: 'server_restarted',
        }, { turnId: request.turnId, stepId: request.stepId, callId: request.callId })
      }
    }
    if (transient) {
      const recoveryContext = {
        ...(interruptedRun?.turnId ? { turnId: interruptedRun.turnId } : {}),
        ...(interruptedRun?.stepId ? { stepId: interruptedRun.stepId } : {}),
      }
      await this.append(id, 'error', {
        message: 'The active run was interrupted when the server restarted. You can continue in this conversation.',
        cancelled: false,
        interrupted: true,
        partialResponsePersisted: Boolean(interruptedRun?.partial),
      }, recoveryContext)
      const hasTurnTerminal = interruptedRun?.turnId
        ? events.some((event) => event.type === 'turn.completed' && event.turnId === interruptedRun.turnId)
        : false
      if (!hasTurnTerminal) {
        await this.append(id, 'turn.completed', { status: 'interrupted', recovered: true }, recoveryContext)
      }
      await this.append(id, 'run.status', { status: 'interrupted', previousStatus, recovered: true }, recoveryContext)
    }
  }

  private async writeState(id: string, state: StoredSession): Promise<void> {
    const target = this.statePath(id)
    const temporary = `${target}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  private syncSessionTokenLimit(summary: SessionSummary): void {
    const previous = summary.limits?.sessionTokens
    const maxTokens = previous?.maxTokens && previous.maxTokens > 0
      ? previous.maxTokens
      : this.sessionTokenLimit
    const usedTokens = Math.max(0, summary.usage.totalTokens)
    const reached = usedTokens >= maxTokens
    summary.limits = {
      sessionTokens: {
        maxTokens,
        usedTokens,
        remainingTokens: Math.max(0, maxTokens - usedTokens),
        reached,
        message: SESSION_TOKEN_LIMIT_ERROR_MESSAGE,
        ...(previous?.reachedAt ? { reachedAt: previous.reachedAt } : {}),
      },
    }
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(id) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    this.writeQueues.set(id, current)
    const cleanup = () => {
      if (this.writeQueues.get(id) === current) this.writeQueues.delete(id)
    }
    void current.then(cleanup, cleanup)
    return current
  }
}

async function allocateUniqueUploadPath(
  workspace: string,
  preferredPath: string,
  reservedPaths: Iterable<string>,
): Promise<string> {
  const extension = extname(preferredPath)
  const directory = dirname(preferredPath)
  const stem = basename(preferredPath, extension)
  const reserved = new Set(reservedPaths)
  for (let index = 1; index <= 10_000; index += 1) {
    const name = index === 1 ? `${stem}${extension}` : `${stem} (${index})${extension}`
    const path = directory === '.' ? name : `${directory.replaceAll('\\', '/')}/${name}`
    if (reserved.has(path)) continue
    const target = resolveWorkspacePath(workspace, path)
    await assertNoSymlinkTraversal(workspace, target)
    try {
      await lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path
      throw error
    }
  }
  throw new Error('Could not allocate a unique workspace upload path')
}

function pendingUploadFromValue(value: unknown, checkpointKey: string): DurablePendingUpload | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const pending = value as Partial<DurablePendingUpload>
  if (
    pending.id !== checkpointKey
    || !/^upl_[a-f0-9]{20}$/.test(checkpointKey)
    || typeof pending.preferredPath !== 'string'
    || !/^uploads\/[^/\\]+$/.test(pending.preferredPath)
    || typeof pending.path !== 'string'
    || !/^uploads\/[^/\\]+$/.test(pending.path)
    || pending.temporaryPath !== `upload-staging/${checkpointKey}.part`
    || !Number.isSafeInteger(pending.bytes)
    || Number(pending.bytes) < 0
    || typeof pending.mime !== 'string'
    || typeof pending.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(pending.sha256)
    || typeof pending.eventId !== 'string'
    || !/^evt_[a-f0-9]{20}$/.test(pending.eventId)
    || typeof pending.createdAt !== 'string'
  ) return undefined
  return pending as DurablePendingUpload
}

function uploadEventMatches(event: SessionEvent, pending: DurablePendingUpload): boolean {
  const data = event.data as Record<string, unknown>
  return event.type === 'file.changed'
    && data.path === pending.path
    && data.bytes === pending.bytes
    && data.operation === 'uploaded'
    && data.mime === pending.mime
}

async function uploadFileMatches(
  workspace: string,
  path: string,
  pending: Pick<DurablePendingUpload, 'bytes' | 'sha256'>,
): Promise<boolean> {
  try {
    const target = resolveWorkspacePath(workspace, path)
    await assertNoSymlinkTraversal(workspace, target)
    return await verifiedFileMatches(target, pending)
  } catch {
    return false
  }
}

async function verifiedFileMatches(
  target: string,
  pending: Pick<DurablePendingUpload, 'bytes' | 'sha256'>,
): Promise<boolean> {
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== pending.bytes) return false
    const bytes = await readFile(target)
    return createHash('sha256').update(bytes).digest('hex') === pending.sha256
  } catch {
    return false
  }
}

async function cleanupOrphanUploadTemporaryFiles(
  sessionDirectory: string,
  activeTemporaryPaths: Set<string>,
): Promise<number> {
  const directory = resolve(sessionDirectory, 'upload-staging')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let removed = 0
  for (const name of names) {
    if (!/^upl_[a-f0-9]{20}\.part$/.test(name)) continue
    const path = `upload-staging/${name}`
    if (activeTemporaryPaths.has(path)) continue
    const target = resolve(sessionDirectory, path)
    const info = await lstat(target).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink()) continue
    await rm(target, { force: true })
    removed += 1
  }
  return removed
}

function pendingWorkspaceMutationFromValue(
  value: unknown,
  checkpointKey: string,
  sessionId: string,
): DurablePendingWorkspaceMutation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const pending = value as Partial<DurablePendingWorkspaceMutation>
  const context = pending.context as Record<string, unknown> | undefined
  const artifact = pending.artifact === undefined ? undefined : artifactRecordFromValue(pending.artifact, sessionId)
  if (
    pending.id !== checkpointKey
    || !/^wmut_[a-f0-9]{20}$/.test(checkpointKey)
    || !['write', 'delete'].includes(String(pending.kind))
    || typeof pending.path !== 'string'
    || !isSafeWorkspaceRelativePath(pending.path)
    || typeof pending.operation !== 'string'
    || !pending.operation
    || !Number.isSafeInteger(pending.bytes)
    || Number(pending.bytes) < 0
    || typeof pending.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(pending.sha256)
    || typeof pending.fileEventId !== 'string'
    || !/^evt_[a-f0-9]{20}$/.test(pending.fileEventId)
    || typeof pending.createdAt !== 'string'
    || !context
    || Array.isArray(context)
    || ['turnId', 'stepId', 'callId'].some((key) => context[key] !== undefined && typeof context[key] !== 'string')
    || (pending.artifactEventId !== undefined && !/^evt_[a-f0-9]{20}$/.test(pending.artifactEventId))
    || (pending.artifact !== undefined && !artifact)
    || (artifact !== undefined && artifact.path !== pending.path)
  ) return undefined
  if (pending.kind === 'write') {
    if (
      !['create', 'replace'].includes(String(pending.mode))
      || pending.temporaryPath !== `workspace-mutation-staging/${checkpointKey}.part`
      || pending.installPath !== `workspace-mutation-staging/${checkpointKey}.install`
      || !artifact
      || !pending.artifactEventId
      || (pending.mode === 'create' && (pending.beforeBytes !== undefined || pending.beforeSha256 !== undefined))
      || (pending.mode === 'replace' && (
        !Number.isSafeInteger(pending.beforeBytes)
        || Number(pending.beforeBytes) < 0
        || typeof pending.beforeSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(pending.beforeSha256)
      ))
    ) return undefined
  } else if (
    pending.mode !== undefined
    || pending.temporaryPath !== undefined
    || pending.installPath !== undefined
    || pending.bytes !== 0
    || pending.sha256 !== sha256(Buffer.alloc(0))
    || !Number.isSafeInteger(pending.beforeBytes)
    || Number(pending.beforeBytes) < 0
    || typeof pending.beforeSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(pending.beforeSha256)
    || Boolean(artifact) !== Boolean(pending.artifactEventId)
  ) return undefined
  return { ...pending, ...(artifact ? { artifact } : {}) } as DurablePendingWorkspaceMutation
}

function pendingWorkspaceEventBatchFromValue(
  value: unknown,
  checkpointKey: string,
  sessionId: string,
): DurablePendingWorkspaceEventBatch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const pending = value as Partial<DurablePendingWorkspaceEventBatch>
  const context = pending.context as Record<string, unknown> | undefined
  if (
    pending.id !== checkpointKey
    || !/^wbatch_[a-f0-9]{20}$/.test(checkpointKey)
    || !['apply_patch', 'shell'].includes(String(pending.source))
    || !Array.isArray(pending.changes)
    || pending.changes.length === 0
    || pending.changes.length > 2_000
    || !context
    || Array.isArray(context)
    || ['turnId', 'stepId', 'callId'].some((key) => context[key] !== undefined && typeof context[key] !== 'string')
    || typeof pending.createdAt !== 'string'
  ) return undefined
  const paths = new Set<string>()
  const eventIds = new Set<string>()
  const changes: DurableWorkspaceEventBatchChange[] = []
  for (const value of pending.changes) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const change = value as Partial<DurableWorkspaceEventBatchChange>
    const artifact = change.artifact === undefined ? undefined : artifactRecordFromValue(change.artifact, sessionId)
    if (
      typeof change.path !== 'string'
      || !isSafeWorkspaceRelativePath(change.path)
      || paths.has(change.path)
      || typeof change.operation !== 'string'
      || !change.operation
      || !Number.isSafeInteger(change.bytes)
      || Number(change.bytes) < 0
      || !['present', 'missing'].includes(String(change.expected))
      || typeof change.fileEventId !== 'string'
      || !/^evt_[a-f0-9]{20}$/.test(change.fileEventId)
      || eventIds.has(change.fileEventId)
      || (change.artifactEventId !== undefined && (
        !/^evt_[a-f0-9]{20}$/.test(change.artifactEventId)
        || eventIds.has(change.artifactEventId)
      ))
      || (change.artifact !== undefined && (!artifact || artifact.path !== change.path))
      || Boolean(artifact) !== Boolean(change.artifactEventId)
      || (change.expected === 'present' && (
        typeof change.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(change.sha256)
        || !artifact
      ))
      || (change.expected === 'missing' && (change.bytes !== 0 || change.sha256 !== undefined))
    ) return undefined
    paths.add(change.path)
    eventIds.add(change.fileEventId)
    if (change.artifactEventId) eventIds.add(change.artifactEventId)
    changes.push({ ...change, ...(artifact ? { artifact } : {}) } as DurableWorkspaceEventBatchChange)
  }
  return { ...pending, changes } as DurablePendingWorkspaceEventBatch
}

function pendingShellReconciliationFromValue(
  value: unknown,
  checkpointKey: string,
): DurablePendingShellReconciliation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const pending = value as Partial<DurablePendingShellReconciliation>
  const context = pending.context as Record<string, unknown> | undefined
  if (
    pending.id !== checkpointKey
    || !/^shrec_[a-f0-9]{20}$/.test(checkpointKey)
    || typeof pending.guardianId !== 'string'
    || !/^cmd_[a-f0-9]{20}$/.test(pending.guardianId)
    || !['staged', 'armed'].includes(String(pending.phase))
    || (pending.phase === 'armed' && (!Number.isInteger(pending.guardianPid) || Number(pending.guardianPid) <= 1))
    || (pending.phase === 'staged' && pending.guardianPid !== undefined)
    || !Array.isArray(pending.before)
    || pending.before.length > 2_000
    || !context
    || Array.isArray(context)
    || ['turnId', 'stepId', 'callId'].some((key) => context[key] !== undefined && typeof context[key] !== 'string')
    || typeof pending.createdAt !== 'string'
  ) return undefined
  const paths = new Set<string>()
  for (const entry of pending.before) {
    if (
      !entry
      || typeof entry !== 'object'
      || typeof entry.path !== 'string'
      || !isSafeWorkspaceRelativePath(entry.path)
      || paths.has(entry.path)
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) return undefined
    paths.add(entry.path)
  }
  return pending as DurablePendingShellReconciliation
}

function isSafeWorkspaceRelativePath(path: string): boolean {
  if (!path || path.includes('\0')) return false
  const normalized = path.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return false
  return !normalized.split('/').some((part) => part === '..')
}

function workspaceMutationFileEventData(pending: DurablePendingWorkspaceMutation): Record<string, unknown> {
  return {
    path: pending.path,
    bytes: pending.bytes,
    operation: pending.operation,
    ...(pending.artifact && pending.artifactEventId
      ? { artifact: pending.artifact, artifactEventId: pending.artifactEventId }
      : {}),
  }
}

function workspaceEventBatchFileEventData(change: DurableWorkspaceEventBatchChange): Record<string, unknown> {
  return {
    path: change.path,
    bytes: change.bytes,
    operation: change.operation,
    ...(change.artifact && change.artifactEventId
      ? { artifact: change.artifact, artifactEventId: change.artifactEventId }
      : {}),
  }
}

async function workspaceEventBatchPostImageMatches(
  workspace: string,
  pending: DurablePendingWorkspaceEventBatch,
): Promise<boolean> {
  for (const change of pending.changes) {
    try {
      const target = resolveWorkspacePath(workspace, change.path)
      await assertNoSymlinkTraversal(workspace, target)
      const observed = await inspectWorkspaceFile(target)
      if (change.expected === 'missing') {
        if (observed.kind !== 'missing') return false
      } else if (
        observed.kind !== 'file'
        || observed.bytes !== change.bytes
        || observed.sha256 !== change.sha256
      ) return false
    } catch {
      return false
    }
  }
  return true
}

function workspaceMutationEventMatches(
  event: SessionEvent,
  type: EventType,
  expectedData: Record<string, unknown>,
): boolean {
  return event.type === type && JSON.stringify(event.data) === JSON.stringify(expectedData)
}

async function inspectWorkspaceFile(target: string): Promise<
  | { kind: 'missing' | 'other' }
  | { kind: 'file'; bytes: number; sha256: string }
> {
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) return { kind: 'other' }
    const content = await readFile(target)
    return { kind: 'file', bytes: content.length, sha256: sha256(content) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

async function cleanupWorkspaceMutationFiles(
  sessionDirectory: string,
  pending: Pick<DurablePendingWorkspaceMutation, 'id'>,
): Promise<void> {
  if (!/^wmut_[a-f0-9]{20}$/.test(pending.id)) return
  const directory = resolve(sessionDirectory, 'workspace-mutation-staging')
  await Promise.all([
    rm(resolve(directory, `${pending.id}.part`), { force: true }),
    rm(resolve(directory, `${pending.id}.install`), { force: true }),
  ])
}

async function cleanupOrphanWorkspaceMutationFiles(
  sessionDirectory: string,
  activeTemporaryPaths: Set<string>,
): Promise<number> {
  const directory = resolve(sessionDirectory, 'workspace-mutation-staging')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let removed = 0
  for (const name of names) {
    if (!/^wmut_[a-f0-9]{20}\.(?:part|install)$/.test(name)) continue
    const path = `workspace-mutation-staging/${name}`
    if (activeTemporaryPaths.has(path)) continue
    const target = resolve(sessionDirectory, path)
    const info = await lstat(target).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink()) continue
    await rm(target, { force: true })
    removed += 1
  }
  return removed
}

function workspaceMutationFailureMessage(
  pending: DurablePendingWorkspaceMutation,
  reason: NonNullable<WorkspaceMutationCheckpointRecovery['reason']>,
): string {
  if (reason === 'missing_or_corrupt_staging') return `Workspace mutation staging is missing or corrupt for ${pending.path}`
  if (reason === 'create_conflict') return `File already exists: ${pending.path}`
  if (reason === 'replace_conflict') return `File changed before replacement: ${pending.path}`
  if (reason === 'delete_conflict') return `File changed before deletion: ${pending.path}`
  return `Workspace mutation checkpoint is invalid for ${pending.path}`
}

function transitionRunStatus(state: StoredSession, status: RunStatus, now = new Date().toISOString()): void {
  const wasActive = state.summary.status === 'running' || state.summary.status === 'cancelling'
  const willBeActive = status === 'running' || status === 'cancelling'
  if (!wasActive && willBeActive) state.summary.usage.activeSinceAt = now
  if (wasActive && !willBeActive && state.summary.usage.activeSinceAt) {
    state.summary.usage.activeDurationMs = (state.summary.usage.activeDurationMs ?? 0) + Math.max(0, Date.parse(now) - Date.parse(state.summary.usage.activeSinceAt))
    delete state.summary.usage.activeSinceAt
  }
  state.summary.status = status
  if (status === 'running' && !state.summary.usage.startedAt) state.summary.usage.startedAt = now
  if (status === 'running') {
    delete state.summary.usage.completedAt
    delete state.summary.usage.durationMs
  }
  if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(status)) {
    state.summary.usage.completedAt = now
    state.summary.usage.durationMs = state.summary.usage.activeDurationMs ?? 0
  }
}

function findLastMessageIndex(
  messages: ModelMessage[],
  predicate: (message: ModelMessage) => boolean,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index])) return index
  }
  return -1
}

interface ProcessReconciliation {
  records: ProcessRecord[]
  materializedChanged: boolean
  reconstructedMaterializedIds: string[]
  missingStartedIds: Set<string>
  missingStoppedIds: Set<string>
  contextById: Map<string, Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>>
}

function reconcileProcessRecords(materialized: ProcessRecord[], events: SessionEvent[]): ProcessReconciliation {
  const eventRecords = new Map<string, { record: ProcessRecord; eventType: SessionEvent['type'] }>()
  const startedIds = new Set<string>()
  const stoppedIds = new Set<string>()
  const contextById = new Map<string, Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>>()
  for (const event of events) {
    if (!['process.started', 'process.output', 'process.updated', 'process.stopped'].includes(event.type)) continue
    const record = processRecordFromEvent(event)
    if (!record) continue
    eventRecords.set(record.id, { record, eventType: event.type })
    contextById.set(record.id, { turnId: event.turnId, stepId: event.stepId, callId: event.callId })
    if (event.type === 'process.started') startedIds.add(record.id)
    if (event.type === 'process.stopped') stoppedIds.add(record.id)
  }

  const reconstructedMaterializedIds: string[] = []
  const records = materialized.map((record) => {
    const observed = eventRecords.get(record.id)
    if (!observed) return record
    eventRecords.delete(record.id)
    return mergeProcessRecord(record, observed.record, observed.eventType)
  })
  for (const [id, observed] of eventRecords) {
    reconstructedMaterializedIds.push(id)
    records.push(observed.record)
  }

  const missingStartedIds = new Set(records.filter((record) => !startedIds.has(record.id)).map((record) => record.id))
  const missingStoppedIds = new Set(records
    .filter((record) => record.status !== 'running' && !stoppedIds.has(record.id))
    .map((record) => record.id))
  return {
    records,
    materializedChanged: JSON.stringify(records) !== JSON.stringify(materialized),
    reconstructedMaterializedIds,
    missingStartedIds,
    missingStoppedIds,
    contextById,
  }
}

function processRecordFromEvent(event: SessionEvent): ProcessRecord | undefined {
  const raw = (event.data as Record<string, unknown>).record
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Partial<ProcessRecord>
  if (
    typeof record.id !== 'string'
    || typeof record.command !== 'string'
    || typeof record.startedAt !== 'string'
    || typeof record.stdout !== 'string'
    || typeof record.stderr !== 'string'
    || !['running', 'exited', 'failed', 'stopped', 'interrupted'].includes(String(record.status))
  ) return undefined
  return record as ProcessRecord
}

function mergeProcessRecord(
  materialized: ProcessRecord,
  observed: ProcessRecord,
  observedEventType: SessionEvent['type'],
): ProcessRecord {
  const materializedTerminal = materialized.status !== 'running'
  const observedTerminal = observed.status !== 'running'
  let primary = observed
  let secondary = materialized
  let observedIsPrimary = true
  if (materializedTerminal && !observedTerminal) {
    primary = materialized
    secondary = observed
    observedIsPrimary = false
  } else if (materializedTerminal && observedTerminal) {
    const materializedCompleted = Date.parse(materialized.completedAt ?? '') || 0
    const observedCompleted = Date.parse(observed.completedAt ?? '') || 0
    if (materializedCompleted > observedCompleted) {
      primary = materialized
      secondary = observed
      observedIsPrimary = false
    }
  }
  return {
    ...secondary,
    ...primary,
    pid: primary.pid ?? secondary.pid,
    name: primary.name ?? secondary.name,
    // `process.updated` is an authoritative ownership snapshot. An omitted
    // JSON `port` alongside empty listener arrays explicitly clears a stale
    // verified port after probe failure or listener shutdown.
    port: observedIsPrimary && observedEventType === 'process.updated'
      ? observed.port
      : primary.port ?? secondary.port,
    stdout: primary.stdout.length >= secondary.stdout.length ? primary.stdout : secondary.stdout,
    stderr: primary.stderr.length >= secondary.stderr.length ? primary.stderr : secondary.stderr,
    combinedOutput: (primary.combinedOutput?.length ?? 0) >= (secondary.combinedOutput?.length ?? 0)
      ? primary.combinedOutput
      : secondary.combinedOutput,
    listeningPorts: primary.listeningPorts ?? secondary.listeningPorts,
    newPorts: primary.newPorts ?? secondary.newPorts,
  }
}

function processStartedProjection(process: ProcessRecord): ProcessRecord {
  const { completedAt: _completedAt, exitCode: _exitCode, signal: _signal, ...started } = process
  return { ...started, status: 'running' }
}

interface WebsiteReconciliation {
  website: WebsiteState
  materializedChanged: boolean
  missingEvent: boolean
  context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
}

function reconcileWebsiteState(materialized: WebsiteState, events: SessionEvent[]): WebsiteReconciliation {
  const latest = [...events].reverse().find((event) => event.type === 'website.updated')
  const observed = latest ? websiteStateFromEvent(latest) : undefined
  const context = latest
    ? { turnId: latest.turnId, stepId: latest.stepId, callId: latest.callId }
    : {}
  if (!observed) {
    return {
      website: materialized,
      materializedChanged: false,
      missingEvent: !isDefaultWebsiteState(materialized),
      context,
    }
  }
  if (websiteStatesEqual(materialized, observed)) {
    return { website: materialized, materializedChanged: false, missingEvent: false, context }
  }
  const materializedAt = Date.parse(materialized.updatedAt) || 0
  const observedAt = Date.parse(observed.updatedAt) || 0
  if (observedAt >= materializedAt) {
    return { website: observed, materializedChanged: true, missingEvent: false, context }
  }
  return { website: materialized, materializedChanged: false, missingEvent: true, context }
}

function websiteStateFromEvent(event: SessionEvent): WebsiteState | undefined {
  const raw = (event.data as Record<string, unknown>).website
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const website = raw as Partial<WebsiteState>
  if (
    !['stopped', 'starting', 'running', 'asleep', 'failed'].includes(String(website.status))
    || typeof website.updatedAt !== 'string'
    || typeof website.restartCount !== 'number'
  ) return undefined
  return website as WebsiteState
}

function websiteStatesEqual(left: WebsiteState, right: WebsiteState): boolean {
  return left.status === right.status
    && left.entryPath === right.entryPath
    && left.processId === right.processId
    && left.port === right.port
    && left.previewUrl === right.previewUrl
    && left.updatedAt === right.updatedAt
    && left.restartCount === right.restartCount
}

function isDefaultWebsiteState(website: WebsiteState): boolean {
  return website.status === 'stopped'
    && website.entryPath === undefined
    && website.processId === undefined
    && website.port === undefined
    && website.previewUrl === undefined
    && website.restartCount === 0
}

interface InterruptedRunRecoveryEvidence {
  turnId?: string
  stepId?: string
  partial?: {
    content: string
    eventCount: number
    visibleBytes: number
    messageAppended: boolean
  }
}

/**
 * Rebuild the provider-visible prefix that was already durable and visible
 * when an active run died without reaching its terminal checkpoint. Only the
 * latest assistant step in the active turn is eligible; deltas from completed
 * earlier steps or turns must never be copied back into model context.
 */
function interruptedRunRecoveryEvidence(
  messages: ModelMessage[],
  events: SessionEvent[],
  pendingStart: DurablePendingStart | undefined,
): InterruptedRunRecoveryEvidence {
  const transientStatuses = new Set(['queued', 'running', 'awaiting_approval', 'awaiting_user', 'cancelling'])
  const latestTransientStatus = [...events].reverse().find((event) => (
    event.type === 'run.status'
    && transientStatuses.has(String((event.data as Record<string, unknown>).status || ''))
    && Boolean(event.turnId)
  ))
  const latestTurnStart = [...events].reverse().find((event) => (
    (event.type === 'turn.started' || event.type === 'run.resumed') && Boolean(event.turnId)
  ))
  const turnId = pendingStart?.turnId ?? latestTransientStatus?.turnId ?? latestTurnStart?.turnId
  const latestAssistantStart = [...events].reverse().find((event) => (
    event.type === 'assistant.started' && (!turnId || event.turnId === turnId)
  ))
  const stepId = latestAssistantStart?.stepId
  if (!latestAssistantStart) return { turnId }

  const sameStep = (event: SessionEvent) => (
    event.seq >= latestAssistantStart.seq
    && (!turnId || event.turnId === turnId)
    && (stepId ? event.stepId === stepId : true)
  )
  const finalized = events.some((event) => (
    sameStep(event) && (event.type === 'assistant.final' || event.type === 'turn.completed')
  ))
  if (finalized) return { turnId, stepId }

  const deltas = events.filter((event) => event.type === 'assistant.final.delta' && sameStep(event))
  const content = deltas
    .map((event) => typeof (event.data as Record<string, unknown>).delta === 'string'
      ? String((event.data as Record<string, unknown>).delta)
      : '')
    .join('')
  if (!content.trim()) return { turnId, stepId }

  // A crash can happen after the complete assistant message is materialized
  // but before the next tool/terminal event. In that window the last provider
  // message is already authoritative and must not be duplicated.
  const messageAppended = messages.at(-1)?.role !== 'assistant'
  return {
    turnId,
    stepId,
    partial: {
      content,
      eventCount: deltas.length,
      visibleBytes: Buffer.byteLength(content),
      messageAppended,
    },
  }
}

interface DeploymentReconciliation {
  deployment: DeploymentState
  materializedChanged: boolean
  missingEvent: boolean
  context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
}

function reconcileDeploymentState(materialized: DeploymentState, events: SessionEvent[]): DeploymentReconciliation {
  const latest = [...events].reverse().find((event) => event.type === 'deployment.updated' && deploymentStateFromEvent(event))
  const observed = latest ? deploymentStateFromEvent(latest) : undefined
  const context = latest
    ? { turnId: latest.turnId, stepId: latest.stepId, callId: latest.callId }
    : {}
  if (!observed) {
    return {
      deployment: materialized,
      materializedChanged: false,
      missingEvent: !isDefaultDeploymentState(materialized),
      context,
    }
  }
  if (deploymentStatesEqual(materialized, observed)) {
    return { deployment: materialized, materializedChanged: false, missingEvent: false, context }
  }
  const materializedAt = Date.parse(materialized.updatedAt) || 0
  const observedAt = Date.parse(observed.updatedAt) || 0
  if (observedAt >= materializedAt) {
    return { deployment: observed, materializedChanged: true, missingEvent: false, context }
  }
  return { deployment: materialized, materializedChanged: false, missingEvent: true, context }
}

function deploymentStateFromEvent(event: SessionEvent): DeploymentState | undefined {
  const raw = (event.data as Record<string, unknown>).deployment
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const deployment = raw as Partial<DeploymentState>
  if (
    !['not_deployed', 'building', 'deploying', 'deployed', 'failed'].includes(String(deployment.status))
    || !Number.isInteger(deployment.revision)
    || Number(deployment.revision) < 0
    || typeof deployment.updatedAt !== 'string'
  ) return undefined
  return deployment as DeploymentState
}

function deploymentStatesEqual(left: DeploymentState, right: DeploymentState): boolean {
  return left.status === right.status
    && left.id === right.id
    && left.url === right.url
    && left.visibility === right.visibility
    && left.revision === right.revision
    && left.entryPath === right.entryPath
    && left.contentHash === right.contentHash
    && left.fileCount === right.fileCount
    && left.bytes === right.bytes
    && left.error === right.error
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
}

function isDefaultDeploymentState(deployment: DeploymentState): boolean {
  return deployment.status === 'not_deployed'
    && deployment.id === undefined
    && deployment.url === undefined
    && deployment.visibility === undefined
    && deployment.revision === 0
    && deployment.entryPath === undefined
    && deployment.contentHash === undefined
    && deployment.fileCount === undefined
    && deployment.bytes === undefined
    && deployment.error === undefined
    && deployment.createdAt === undefined
}

function deploymentSnapshotMatchesState(
  snapshot: StaticDeploymentSnapshot | undefined,
  deployment: DeploymentState,
): boolean {
  return Boolean(
    snapshot
    && deployment.entryPath === snapshot.entryPath
    && deployment.contentHash === snapshot.contentHash
    && deployment.fileCount === snapshot.fileCount
    && deployment.bytes === snapshot.bytes,
  )
}

function interruptedDeploymentState(pending: DurablePendingDeployment): DeploymentState {
  return {
    ...pending.previous,
    id: pending.deploymentId,
    status: 'failed',
    error: 'Deployment snapshot was interrupted when the server restarted and no verified revision manifest was found.',
    createdAt: pending.createdAt,
    updatedAt: new Date().toISOString(),
  }
}

interface PlanReconciliation {
  plan: PlanState | null
  materializedChanged: boolean
  missingEvent: boolean
  context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
}

function reconcilePlanState(materialized: PlanState | null, events: SessionEvent[]): PlanReconciliation {
  const latest = [...events].reverse().find((event) => event.type === 'plan.updated' && planStateFromEvent(event))
  const observed = latest ? planStateFromEvent(latest) : undefined
  const context = latest
    ? { turnId: latest.turnId, stepId: latest.stepId, callId: latest.callId }
    : {}
  if (!observed) {
    return {
      plan: materialized,
      materializedChanged: false,
      missingEvent: materialized !== null,
      context,
    }
  }
  if (!materialized) return { plan: observed, materializedChanged: true, missingEvent: false, context }
  if (planStatesEqual(materialized, observed)) {
    return { plan: materialized, materializedChanged: false, missingEvent: false, context }
  }
  const observedIsNewer = observed.version > materialized.version
    || (observed.version === materialized.version && (Date.parse(observed.updatedAt) || 0) >= (Date.parse(materialized.updatedAt) || 0))
  return observedIsNewer
    ? { plan: observed, materializedChanged: true, missingEvent: false, context }
    : { plan: materialized, materializedChanged: false, missingEvent: true, context }
}

function planStateFromEvent(event: SessionEvent): PlanState | undefined {
  const raw = (event.data as Record<string, unknown>).plan
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const plan = raw as Partial<PlanState>
  if (
    !Array.isArray(plan.items)
    || !Number.isInteger(plan.version)
    || Number(plan.version) < 1
    || typeof plan.updatedAt !== 'string'
    || (plan.explanation !== undefined && typeof plan.explanation !== 'string')
    || plan.items.some((item) => (
      !item
      || typeof item !== 'object'
      || typeof item.id !== 'string'
      || typeof item.step !== 'string'
      || !['pending', 'in_progress', 'completed'].includes(String(item.status))
    ))
  ) return undefined
  return plan as PlanState
}

function planStatesEqual(left: PlanState, right: PlanState): boolean {
  return left.version === right.version
    && left.updatedAt === right.updatedAt
    && left.explanation === right.explanation
    && left.items.length === right.items.length
    && left.items.every((item, index) => (
      item.id === right.items[index]?.id
      && item.step === right.items[index]?.step
      && item.status === right.items[index]?.status
    ))
}

interface ArtifactRepair {
  type: Extract<EventType, 'artifact.created' | 'artifact.removed'>
  path: string
  artifact?: ArtifactRecord
  eventId?: string
  context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
  reason: 'file_boundary_replayed' | 'projection_repaired' | 'missing_file_reconciled'
}

interface ArtifactReconciliation {
  artifacts: ArtifactRecord[]
  materializedChanged: boolean
  repairs: ArtifactRepair[]
}

async function reconcileArtifactRecords(
  sessionId: string,
  workspace: string,
  materialized: ArtifactRecord[],
  events: SessionEvent[],
): Promise<ArtifactReconciliation> {
  interface ObservedBoundary {
    kind: 'created' | 'removed'
    path: string
    artifact?: ArtifactRecord
    event: SessionEvent
    pendingEventId?: string
  }
  const eventIds = new Set(events.map((event) => event.id))
  const latestTerminal = new Map<string, ObservedBoundary>()
  const latestFileBoundary = new Map<string, ObservedBoundary>()
  const historicalArtifact = new Map<string, ArtifactRecord>()
  for (const event of events) {
    if (event.type === 'artifact.created') {
      const artifact = artifactRecordFromValue((event.data as Record<string, unknown>).artifact, sessionId)
      if (!artifact) continue
      historicalArtifact.set(artifact.path, artifact)
      latestTerminal.set(artifact.path, { kind: 'created', path: artifact.path, artifact, event })
      continue
    }
    if (event.type === 'artifact.removed') {
      const data = event.data as Record<string, unknown>
      const artifact = artifactRecordFromValue(data.artifact, sessionId)
      const path = artifact?.path ?? (typeof data.path === 'string' ? data.path : '')
      if (!path) continue
      if (artifact) historicalArtifact.set(path, artifact)
      latestTerminal.set(path, { kind: 'removed', path, artifact, event })
      continue
    }
    if (event.type !== 'file.changed') continue
    const data = event.data as Record<string, unknown>
    const artifact = artifactRecordFromValue(data.artifact, sessionId)
    const path = artifact?.path ?? (typeof data.path === 'string' ? data.path : '')
    const pendingEventId = typeof data.artifactEventId === 'string' ? data.artifactEventId : undefined
    if (!artifact || !path || !pendingEventId || eventIds.has(pendingEventId)) continue
    historicalArtifact.set(path, artifact)
    const operation = String(data.operation || '')
    latestFileBoundary.set(path, {
      kind: operation.includes('deleted') ? 'removed' : 'created',
      path,
      artifact,
      event,
      pendingEventId,
    })
  }

  const materializedByPath = new Map(materialized
    .map((artifact) => artifactRecordFromValue(artifact, sessionId))
    .filter((artifact): artifact is ArtifactRecord => Boolean(artifact))
    .map((artifact) => [artifact.path, artifact]))
  const materializedOrder = new Map(materialized.map((artifact, index) => [artifact.path, index]))
  const pathOrder = [...new Set([
    ...materializedByPath.keys(),
    ...latestTerminal.keys(),
    ...latestFileBoundary.keys(),
  ])]
  const artifacts: ArtifactRecord[] = []
  const repairs: ArtifactRepair[] = []

  for (const path of pathOrder) {
    const materializedArtifact = materializedByPath.get(path)
    const terminal = latestTerminal.get(path)
    const fileBoundary = latestFileBoundary.get(path)
    const pending = fileBoundary && (!terminal || fileBoundary.event.seq > terminal.event.seq)
      ? fileBoundary
      : undefined
    const observed = pending ?? terminal
    if (pending) {
      repairs.push({
        type: pending.kind === 'created' ? 'artifact.created' : 'artifact.removed',
        path,
        artifact: pending.artifact,
        eventId: pending.pendingEventId,
        context: eventContext(pending.event),
        reason: 'file_boundary_replayed',
      })
    }

    const exists = await artifactFileExists(workspace, path)
    let selected: ArtifactRecord | undefined
    if (exists) {
      selected = observed?.kind === 'created' ? observed.artifact : undefined
      if (
        materializedArtifact
        && (!observed || Date.parse(materializedArtifact.createdAt) > Date.parse(observed.event.at))
      ) selected = materializedArtifact
    }
    if (selected) artifacts.push(selected)

    const observedAfterPending = pending ?? terminal
    if (selected) {
      const alreadyProjected = observedAfterPending?.kind === 'created'
        && observedAfterPending.artifact?.id === selected.id
      if (!alreadyProjected) {
        repairs.push({
          type: 'artifact.created',
          path,
          artifact: selected,
          context: observedAfterPending ? eventContext(observedAfterPending.event) : {},
          reason: 'projection_repaired',
        })
      }
    } else {
      const lastArtifact = observedAfterPending?.artifact ?? materializedArtifact ?? historicalArtifact.get(path)
      const alreadyRemoved = observedAfterPending?.kind === 'removed'
      if (!alreadyRemoved && lastArtifact) {
        repairs.push({
          type: 'artifact.removed',
          path,
          artifact: lastArtifact,
          context: observedAfterPending ? eventContext(observedAfterPending.event) : {},
          reason: exists ? 'projection_repaired' : 'missing_file_reconciled',
        })
      }
    }
  }

  artifacts.sort((left, right) => {
    const timeDifference = (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0)
    if (timeDifference !== 0) return timeDifference
    const leftSeq = Math.max(latestTerminal.get(left.path)?.event.seq ?? 0, latestFileBoundary.get(left.path)?.event.seq ?? 0)
    const rightSeq = Math.max(latestTerminal.get(right.path)?.event.seq ?? 0, latestFileBoundary.get(right.path)?.event.seq ?? 0)
    if (leftSeq !== rightSeq) return leftSeq - rightSeq
    return (materializedOrder.get(left.path) ?? Number.MAX_SAFE_INTEGER)
      - (materializedOrder.get(right.path) ?? Number.MAX_SAFE_INTEGER)
  })

  return {
    artifacts,
    materializedChanged: !artifactCollectionsEqual(materialized, artifacts),
    repairs,
  }
}

function artifactRecordFromValue(value: unknown, sessionId: string): ArtifactRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const artifact = value as Partial<ArtifactRecord>
  if (
    typeof artifact.id !== 'string'
    || artifact.sessionId !== sessionId
    || typeof artifact.path !== 'string'
    || !artifact.path
    || typeof artifact.name !== 'string'
    || !['file', 'website', 'image', 'audio', 'video', 'markdown', 'document', 'data', 'archive'].includes(String(artifact.kind))
    || typeof artifact.mime !== 'string'
    || typeof artifact.createdAt !== 'string'
    || (artifact.previewUrl !== undefined && typeof artifact.previewUrl !== 'string')
    || typeof artifact.downloadUrl !== 'string'
  ) return undefined
  return artifact as ArtifactRecord
}

async function artifactFileExists(workspace: string, path: string): Promise<boolean> {
  try {
    const target = resolveWorkspacePath(workspace, path)
    await assertNoSymlinkTraversal(workspace, target)
    return (await lstat(target)).isFile()
  } catch {
    return false
  }
}

function artifactCollectionsEqual(left: ArtifactRecord[], right: ArtifactRecord[]): boolean {
  return left.length === right.length
    && left.every((artifact, index) => JSON.stringify(artifact) === JSON.stringify(right[index]))
}

function eventContext(event: SessionEvent): Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'> {
  return { turnId: event.turnId, stepId: event.stepId, callId: event.callId }
}

type InterruptedToolResolution = 'durable_terminal' | 'outcome_unknown' | 'not_started'

function nextVoiceId(state: Pick<StoredSession, 'voices' | 'pendingHitl' | 'nextVoiceIndex'>): string {
  const used = new Set([
    ...Object.keys(state.voices ?? {}),
    ...Object.values(state.pendingHitl ?? {})
      .map((pending) => pending.response?.voice_id)
      .filter((value): value is string => typeof value === 'string'),
  ])
  let index = Number.isSafeInteger(state.nextVoiceIndex) && Number(state.nextVoiceIndex) >= 0
    ? Number(state.nextVoiceIndex)
    : 0
  while (used.has(`voice-${String(index).padStart(2, '0')}`)) index += 1
  state.nextVoiceIndex = index + 1
  return `voice-${String(index).padStart(2, '0')}`
}

function allocatePendingToolCallIndex(
  state: StoredSession,
  pending: Pick<DurablePendingHitl | DurablePendingApproval, 'turnId' | 'stepId' | 'call'>,
): number | undefined {
  const assistant = [...state.messages].reverse().find((message) => (
    message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
  ))
  if (!assistant?.tool_calls) return undefined
  const occupied = new Set([
    ...Object.values(state.pendingHitl ?? {}),
    ...Object.values(state.pendingApprovals ?? {}),
  ].filter((entry) => entry.turnId === pending.turnId && entry.stepId === pending.stepId)
    .map((entry) => entry.callIndex)
    .filter((index): index is number => Number.isInteger(index) && Number(index) >= 0))
  const targetIdentity = durableToolCallIdentity(pending.call)
  const exact = assistant.tool_calls.flatMap((rawCall, index) => {
    const call = persistedModelToolCall(rawCall)
    return durableToolCallIdentity(call) === targetIdentity ? [index] : []
  })
  const fallback = exact.length > 0
    ? exact
    : assistant.tool_calls.flatMap((rawCall, index) => (
      rawCall.id === pending.call.id && rawCall.function.name === pending.call.name ? [index] : []
    ))
  return fallback.find((index) => !occupied.has(index))
}

function persistedModelToolCall(rawCall: NonNullable<ModelMessage['tool_calls']>[number]): ToolCallRecord {
  return {
    id: rawCall.id,
    name: rawCall.function.name,
    arguments: parsePersistedToolArguments(rawCall.function.arguments),
  }
}

function durableToolCallIdentity(call: ToolCallRecord): string {
  return `${call.id}\0${call.name}\0${JSON.stringify(canonicalizeDurableJson(call.arguments))}`
}

function canonicalizeDurableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeDurableJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalizeDurableJson(item)]))
}

function isRestartResumableHitl(pending: DurablePendingHitl): boolean {
  return typeof pending.requiredEventId === 'string'
    && pending.requiredEventId.length > 0
    && ['awaiting_response', 'response_recorded', 'executing'].includes(String(pending.phase || ''))
    && pending.callId === pending.call.id
}

function isRestartResumableApproval(pending: DurablePendingApproval): boolean {
  return typeof pending.requiredEventId === 'string'
    && pending.requiredEventId.length > 0
    && ['awaiting_decision', 'decision_recorded', 'executing'].includes(String(pending.phase || ''))
    && pending.callId === pending.call.id
    && typeof pending.requestSignature === 'string'
    && pending.requestSignature.length > 0
}

interface InterruptedToolRepair {
  call: ToolCallRecord
  message: ModelMessage
  resolution: InterruptedToolResolution
  terminalEvent?: {
    type: Extract<EventType, 'tool.completed' | 'tool.failed'>
    data: Record<string, unknown>
  }
  context: Pick<SessionEvent, 'turnId' | 'stepId' | 'callId'>
}

/**
 * Close only the unmatched tail tool-call group. During normal execution the
 * assistant call intent is persisted before tools run, while the whole result
 * batch is persisted afterwards. A crash in that window therefore leaves the
 * latest assistant message followed by zero or some tool messages and no later
 * user/assistant message. Older transcript surgery is deliberately avoided.
 */
function repairInterruptedToolTail(
  messages: ModelMessage[],
  events: SessionEvent[],
  deployment: DeploymentState,
): InterruptedToolRepair[] {
  let assistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant' && (messages[index].tool_calls?.length ?? 0) > 0) {
      assistantIndex = index
      break
    }
  }
  if (assistantIndex < 0) return []
  const tail = messages.slice(assistantIndex + 1)
  if (tail.some((message) => message.role !== 'tool')) return []

  const resolvedCounts = new Map<string, number>()
  for (const message of tail) {
    if (!message.tool_call_id) continue
    resolvedCounts.set(message.tool_call_id, (resolvedCounts.get(message.tool_call_id) ?? 0) + 1)
  }
  const missing = (messages[assistantIndex].tool_calls ?? []).filter((call) => {
    const remaining = resolvedCounts.get(call.id) ?? 0
    if (remaining <= 0) return true
    resolvedCounts.set(call.id, remaining - 1)
    return false
  })
  if (missing.length === 0) return []

  const stepStart = [...events].reverse().find((event) => event.type === 'assistant.started')
  const stepEvents = stepStart
    ? events.filter((event) => event.turnId === stepStart.turnId && event.stepId === stepStart.stepId)
    : []
  return missing.map((rawCall) => {
    const call: ToolCallRecord = {
      id: rawCall.id,
      name: rawCall.function.name,
      arguments: parsePersistedToolArguments(rawCall.function.arguments),
    }
    const terminal = [...stepEvents].reverse().find((event) => (
      event.callId === call.id
      && ['tool.completed', 'tool.failed', 'tool.timed_out'].includes(event.type)
    ))
    const started = stepEvents.some((event) => event.type === 'tool.started' && event.callId === call.id)
    const context = { turnId: stepStart?.turnId, stepId: stepStart?.stepId, callId: call.id }
    if (terminal) {
      const data = terminal.data as Record<string, unknown>
      const fallback = arenaToolErrorResult(call.name, 'The durable tool terminal event did not contain a readable result during restart recovery.')
      const content = typeof data.result === 'string' ? data.result : fallback.content
      return {
        call,
        message: {
          role: 'tool' as const,
          tool_call_id: call.id,
          content,
          tool_result_status: terminal.type === 'tool.completed' ? 'succeeded' as const : 'failed' as const,
        },
        resolution: 'durable_terminal' as const,
        context,
      }
    }

    const deploymentTerminal = [...stepEvents].reverse().find((event) => {
      if (event.type !== 'deployment.updated' || event.callId !== call.id) return false
      const action = String((event.data as Record<string, unknown>).action || '')
      return ['deployed', 'redeployed', 'deploy_failed', 'deploy_interrupted', 'build_failed'].includes(action)
    })
    const deploymentProjection = deploymentTerminal
      ? deploymentStateFromEvent(deploymentTerminal)
      : call.name === 'deploy_project' && ['building', 'deploying'].includes(deployment.status)
        ? deployment
        : undefined
    if (deploymentProjection) {
      const isError = deploymentProjection.status !== 'deployed'
      const content = isError
        ? JSON.stringify({
            status: 'error',
            message: deploymentProjection.error || `Deployment ${deploymentProjection.status} was interrupted when the server restarted.`,
          })
        : JSON.stringify({ status: 'success' })
      return {
        call,
        message: {
          role: 'tool' as const,
          tool_call_id: call.id,
          content,
          tool_result_status: isError ? 'failed' as const : 'succeeded' as const,
        },
        resolution: 'durable_terminal' as const,
        terminalEvent: {
          type: isError ? 'tool.failed' as const : 'tool.completed' as const,
          data: {
            isError,
            reason: deploymentTerminal ? 'deployment_terminal_recovered' : 'deployment_interrupted_after_restart',
          },
        },
        context,
      }
    }

    const resolution = started ? 'outcome_unknown' as const : 'not_started' as const
    const explanation = started
      ? 'The tool call was interrupted after it was recorded as started, but no terminal result was durably recorded. Its outcome is unknown. Do not retry a possibly state-changing operation blindly; first verify external or workspace state. Read-only or idempotent work may be retried if still needed.'
      : 'The tool call was interrupted before the Harness recorded it as started, so it was not executed. Reissue it if it is still needed.'
    const failure = arenaToolErrorResult(call.name, explanation)
    return {
      call,
      message: {
        role: 'tool' as const,
        tool_call_id: call.id,
        content: failure.content,
        tool_result_status: 'failed' as const,
      },
      resolution,
      terminalEvent: {
        type: 'tool.failed' as const,
        data: {
          isError: true,
          outcomeUnknown: resolution === 'outcome_unknown',
          notExecuted: resolution === 'not_started',
          reason: resolution === 'outcome_unknown'
            ? 'tool_outcome_unknown_after_restart'
            : 'tool_not_started_after_restart',
        },
      },
      context,
    }
  })
}

function parsePersistedToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed }
  } catch {
    return { _parse_error: 'Invalid JSON tool arguments', _raw: raw }
  }
}

function redactWorkspacePath(value: string, workspace: string): string {
  return value.split(workspace).join('<workspace>')
}

function redactWorkspaceValue<T>(value: T, workspace: string): T {
  if (typeof value === 'string') return redactWorkspacePath(value, workspace) as T
  if (Array.isArray(value)) return value.map((item) => redactWorkspaceValue(item, workspace)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactWorkspaceValue(item, workspace)])) as T
  }
  return value
}

function parseEventLog(text: string): { events: SessionEvent[]; invalidLines: number } {
  const events: SessionEvent[] = []
  let invalidLines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as Partial<SessionEvent>
      if (
        typeof value.id !== 'string' ||
        typeof value.sessionId !== 'string' ||
        !Number.isInteger(value.seq) ||
        (value.seq as number) < 1 ||
        typeof value.type !== 'string' ||
        typeof value.at !== 'string' ||
        !value.data ||
        typeof value.data !== 'object'
      ) {
        invalidLines += 1
        continue
      }
      events.push(value as SessionEvent)
    } catch {
      invalidLines += 1
    }
  }
  return { events, invalidLines }
}
