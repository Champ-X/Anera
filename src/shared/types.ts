export type RunStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_user'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'
  | 'timed_out'
  | 'interrupted'

export type EventType =
  | 'session.created'
  | 'session.limit.reached'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.undone'
  | 'run.status'
  | 'run.resumed'
  | 'assistant.started'
  | 'assistant.thought.started'
  | 'assistant.thought.delta'
  | 'assistant.thought.completed'
  | 'assistant.progress.delta'
  | 'assistant.progress'
  | 'assistant.tool_call.delta'
  | 'assistant.final.delta'
  | 'assistant.final'
  | 'model.tool_call.repair'
  | 'model.final.repair'
  | 'model.final.evidence.expanded'
  | 'tool.started'
  | 'tool.output'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.timed_out'
  | 'file.changed'
  | 'file.presented'
  | 'workspace.persistence.started'
  | 'workspace.persistence.updated'
  | 'workspace.persistence.completed'
  | 'artifact.created'
  | 'artifact.removed'
  | 'process.started'
  | 'process.output'
  | 'process.updated'
  | 'process.stopped'
  | 'website.updated'
  | 'deployment.updated'
  | 'usage.updated'
  | 'provider.usage'
  | 'context.compacted'
  | 'context.projected'
  | 'context.compaction.failed'
  | 'hitl.required'
  | 'hitl.resolved'
  | 'hitl.expired'
  | 'audio.generated'
  | 'plan.updated'
  | 'feedback.updated'
  | 'task.completion.updated'
  | 'review.requested'
  | 'review.dismissed'
  | 'session.recovered'
  | 'approval.expired'
  | 'approval.required'
  | 'approval.resolved'
  | 'error'

export type EstimatedCostStatus = 'not_incurred' | 'estimated' | 'partial' | 'unknown'

export interface UsageTotals {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens: number
  /**
   * Physical model-provider request dispatches. This is intentionally
   * separate from modelCalls: a dispatched request can fail before the
   * provider returns authoritative token usage.
   *
   * Optional only for persisted/session-consumer compatibility. New and
  * hydrated SessionStore records always materialize this field.
  */
  modelRequests?: number
  /**
   * Calls with attributable metering. This normally means provider-reported
   * usage; speech is the explicit exception and carries a persisted heuristic
   * metering method because the binary Speech API returns no usage object.
   */
  modelCalls: number
  estimatedCostUsd: number
  /**
   * Whether estimatedCostUsd covers every physical model request. `partial`
   * is a lower-bound estimate; `unknown` means requests occurred but none
   * returned attributable metering from which a cost estimate could be
   * calculated. Speech metering remains explicitly heuristic.
   */
  estimatedCostStatus?: EstimatedCostStatus
  toolCalls: number
  startedAt?: string
  completedAt?: string
  durationMs?: number
  activeDurationMs?: number
  activeSinceAt?: string
}

/**
 * Speech responses are binary and do not include provider-authoritative token
 * usage. Preserve both physical measurements and the explicit token estimate
 * used for the unified cost ledger.
 */
export interface SpeechProviderMetering {
  providerCalls: number
  inputCharacters: number
  providerOutputBytes: number
  deliveredAudioBytes: number
  audioDurationMs: number
  estimatedTextTokens: number
  estimatedAudioTokens: number
  estimationMethod: 'text_heuristic_and_50ms_audio_tokens'
}

export type WebProviderName = 'tavily' | 'firecrawl' | 'bing' | 'duckduckgo' | 'direct'

export interface WebProviderRequestMetering {
  provider: WebProviderName
  operation: 'search' | 'fetch'
  calls: number
  responseBytes: number
  outcome: 'success' | 'empty' | 'error' | 'not_dispatched'
}

/**
 * Physical web-provider measurements are distinct from model token usage.
 * Provider billing is deliberately unknown until an authoritative bill or a
 * deployment-specific pricing policy is available.
 */
export interface WebProviderMetering {
  schemaVersion: 1
  cache: 'hit' | 'miss' | 'not_applicable'
  cacheProvider?: Extract<WebProviderName, 'firecrawl' | 'direct'>
  providerCalls: number
  responseBytes: number
  requests: WebProviderRequestMetering[]
  costUsd: null
  costStatus: 'not_available'
}

export const SESSION_TOKEN_LIMIT_ERROR_MESSAGE = 'This session has reached its token usage limit. Please start a new chat to continue.'

export interface SessionTokenLimitState {
  maxTokens: number
  usedTokens: number
  remainingTokens: number
  reached: boolean
  message: string
  reachedAt?: string
}

export interface SessionLimits {
  sessionTokens: SessionTokenLimitState
}

export interface SessionEvent<T = Record<string, unknown>> {
  id: string
  sessionId: string
  seq: number
  type: EventType
  at: string
  turnId?: string
  stepId?: string
  callId?: string
  data: T
}

export interface SessionSummary {
  id: string
  title: string
  archivedAt?: string
  /** Monotonic revision for user edits, independent of conversation activity. */
  metadataVersion?: number
  createdAt: string
  updatedAt: string
  status: RunStatus
  model: string
  modelSelection?: string | null
  lastMessage?: string
  workspaceBytes: number
  usage: UsageTotals
  limits?: SessionLimits
  productMode?: 'chat' | 'coding'
  codingSessionStatus?: CodingSessionStatus
  isFreeSession?: boolean
  settledCredits?: number
  /** Server-selected terminal-feedback cohort exposed by Arena session data. */
  feedbackType?: AgentFeedbackType
  /** Public Arena experiment arm; treatment-2 suppresses the thank-you toast. */
  customFeedbackArm?: AgentCustomFeedbackArm
}

export interface SessionMetadataPatch {
  title?: string
  archived?: boolean
}

export type CodingSessionStatus = 'active' | 'pr_open' | 'closed' | 'pr_merged' | 'error'

export interface CreditBalance {
  creditsRemaining: number
  dailyFreeCredits: number
  refreshedAt: string
}

export interface DailyCreditPulse {
  pulse: number
  refreshedAt: string
}

export type PointwiseFeedbackValue = 'upvote' | 'downvote'

export type TaskReviewDismissAction = 'continue' | 'dismiss'

export type AgentFeedbackType = 'check_in' | 'task_completion_bar'

export type AgentCustomFeedbackArm = 'control' | 'treatment-1' | 'treatment-2'

/** Arena's public check_in values sent to the shared review-feedback route. */
export type TaskReviewFeedbackAction = 'approve' | 'disapprove' | 'edit' | 'escape'

export type TaskCompletionFeedbackValue = 'no' | 'making_progress' | 'yes'

export type GitHubConnectionStatus = 'disconnected' | 'installed' | 'connected'

export interface GitHubConnectionState {
  status: GitHubConnectionStatus
}

export interface GitHubStatusState {
  indicator: 'none' | 'minor' | 'major' | 'critical' | 'maintenance'
  description: string
}

export interface GitHubRepository {
  id: number
  fullName: string
  name: string
  ownerLogin: string
  ownerType: string | null
  defaultBranch: string
  private: boolean
  visibility: string | null
  description: string | null
  homepage: string | null
  language: string | null
  sizeKb: number | null
  stargazersCount: number | null
  watchersCount: number | null
  forksCount: number | null
  openIssuesCount: number | null
  topics: string[]
  fork: boolean | null
  archived: boolean | null
  disabled: boolean | null
  isTemplate: boolean | null
  createdAt: string | null
  pushedAt: string | null
  updatedAt: string
}

export interface GitHubBranch {
  name: string
  commitSha: string
}

export interface GitHubRepositoryPage {
  repos: GitHubRepository[]
  nextCursor: string | null
  hasNextPage: boolean
}

export interface GitHubBranchPage {
  branches: GitHubBranch[]
  nextCursor: string | null
  hasNextPage: boolean
}

export interface CodingRepositoryState {
  provider: 'github'
  repoId: number
  fullName: string
  ownerLogin: string
  name: string
  baseBranch: string
  baseCommitSha: string
  /** Session-fixed working branch. Older persisted sessions fall back to baseBranch. */
  arenaBranch?: string
  /** Public tool-path namespace used in the provider-facing Coding prompt. */
  cwd?: string
  private: boolean
  importedAt: string
}

export interface AgentModelOption {
  id: string
  publicName: string
  displayName: string | null
  description?: string
}

export interface WorkspaceEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: WorkspaceEntry[]
}

/**
 * Bounded Workspace inventory state returned with a session snapshot.
 * `truncated` describes the server-side inventory cap, while `hasMore`
 * describes whether the bounded inventory itself still has another page.
 */
export interface WorkspaceInventoryMetadata {
  hasMore: boolean
  nextCursor?: string
  truncated: boolean
  totalFiles: number
  /** The bounded manifest reached its file-count support cap. */
  fileLimitHit?: boolean
  /** The bounded manifest reached its broader file/directory entry cap. */
  entryLimitHit?: boolean
  /** totalFiles is an observed lower bound rather than an exact total. */
  totalFilesIsLowerBound?: boolean
  /** Number of flat inventory records materialized through this page. */
  loadedEntries?: number
}

/** Additional flat records returned by the Workspace inventory endpoint. */
export interface WorkspaceInventoryPage extends WorkspaceInventoryMetadata {
  entries: WorkspaceEntry[]
}

export interface ArtifactRecord {
  id: string
  sessionId: string
  path: string
  name: string
  kind: 'file' | 'website' | 'image' | 'audio' | 'video' | 'markdown' | 'document' | 'data' | 'archive'
  mime: string
  createdAt: string
  previewUrl?: string
  downloadUrl: string
}

export interface OfficeArtifactPreview {
  path: string
  name: string
  format: 'docx' | 'xlsx' | 'pptx'
  unit: 'item' | 'sheet' | 'slide'
  content: string
  truncated: boolean
  totalItems?: number
  startItem?: number
  endItem?: number
  outputBytes: number
}

export interface ProcessRecord {
  id: string
  /** User-facing label supplied to Arena's start_process tool. */
  name?: string
  command: string
  pid?: number
  /** Preferred listener proven by the OS ownership probe; never a command/output hint. */
  port?: number
  /** Unverified durable restart/ranking hint; intentionally ignored by the rendered UI and canonical trace. */
  portHint?: number
  status: 'running' | 'exited' | 'failed' | 'stopped' | 'interrupted'
  startedAt: string
  completedAt?: string
  exitCode?: number | null
  signal?: string | null
  stdout: string
  stderr: string
  /** Tail-captured stdout/stderr in the order chunks were observed. */
  combinedOutput?: string
  /** TCP listeners ownership-verified for this guardian/process tree at the latest check. */
  listeningPorts?: ProcessPortRecord[]
  /** Ownership-verified listeners created inside this guardian's fresh process tree. */
  newPorts?: ProcessPortRecord[]
}

export interface ProcessPortRecord {
  port: number
  address: string
}

export interface WebsiteState {
  status: 'stopped' | 'starting' | 'running' | 'asleep' | 'failed'
  entryPath?: string
  processId?: string
  port?: number
  previewUrl?: string
  updatedAt: string
  restartCount: number
}

export interface DeploymentState {
  status: 'not_deployed' | 'building' | 'deploying' | 'deployed' | 'failed'
  id?: string
  url?: string
  visibility?: 'local' | 'public'
  revision: number
  entryPath?: string
  contentHash?: string
  fileCount?: number
  bytes?: number
  error?: string
  createdAt?: string
  updatedAt: string
}

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanItem {
  id: string
  step: string
  status: PlanItemStatus
}

export interface PlanState {
  items: PlanItem[]
  explanation?: string
  updatedAt: string
  version: number
}

export interface SessionSnapshot {
  session: SessionSummary
  events: SessionEvent[]
  plan: PlanState | null
  workspace: WorkspaceEntry[]
  /** Optional for compatibility with sessions persisted before inventory paging. */
  workspaceInventory?: WorkspaceInventoryMetadata
  artifacts: ArtifactRecord[]
  processes: ProcessRecord[]
  website: WebsiteState
  deployment: DeploymentState
  repository: CodingRepositoryState | null
}

export interface UploadedFileInput {
  name: string
  contentBase64: string
  mime?: string
}

export interface ToolCallRecord {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** Arena AI-SDK-style content emitted by multimodal tool-result projection. */
export interface ModelToolImageDataPart {
  type: 'image-data'
  data: string
  mediaType: string
}

/** Private provenance for Arena server-authored user-message parts. */
export interface ModelArenaSystemMessagePart {
  kind: 'attachments' | 'compaction' | 'custom_feedback'
  position: 'leading' | 'trailing'
  /** Present only for Arena's trusted custom-feedback leading part. */
  reviewedNodeId?: string
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  /** Provider reasoning must be replayed verbatim in subsequent thinking/tool requests. */
  reasoning_content?: string
  name?: string
  tool_call_id?: string
  /** Private harness metadata. DeepSeekClient removes it from provider payloads. */
  tool_result_status?: 'succeeded' | 'failed'
  /** Private provider-only context view; original evidence remains in content. */
  context_projection?: { sourceSha256: string; content: string }
  /** Private typed projection of an Arena tool result; provider adapters translate it. */
  tool_content_parts?: ModelToolImageDataPart[]
  /** Private provenance only; provider adapters remove it after projecting the tagged text. */
  arena_system_messages?: ModelArenaSystemMessagePart[]
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}
