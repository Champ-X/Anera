export const CANONICAL_TRACE_VERSION = 'anera-canonical-trace/1.0' as const

export type TraceSource = 'arena' | 'anera'

export type MissingValue = 'not_visible' | 'not_captured' | 'unknown' | 'not_applicable'

export type CanonicalActor = 'user' | 'assistant' | 'tool' | 'operator' | 'system_ui' | 'system'

export type CanonicalEventKind =
  | 'session'
  | 'message'
  | 'thought'
  | 'plan'
  | 'tool'
  | 'file'
  | 'artifact'
  | 'process'
  | 'website'
  | 'deployment'
  | 'workspace'
  | 'approval'
  | 'usage'
  | 'context'
  | 'lifecycle'
  | 'final'
  | 'error'
  | 'model'
  | 'operator_action'
  | 'other'

export type CanonicalPhase =
  | 'appeared'
  | 'started'
  | 'progress'
  | 'updated'
  | 'completed'
  | 'finalized'
  | 'unknown'

export type CanonicalStatus =
  | 'idle'
  | 'queued'
  | 'starting'
  | 'running'
  | 'asleep'
  | 'cancelling'
  | 'stopped'
  | 'exited'
  | 'awaiting_approval'
  | 'awaiting_user_input'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'
  | 'input_rejected'
  | 'approved'
  | 'denied'
  | 'expired'
  | MissingValue

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue }

export type CanonicalEstimatedCostStatus =
  | 'not_incurred'
  | 'estimated'
  | 'partial'
  | MissingValue

export interface CanonicalUsage {
  promptTokens?: number | MissingValue
  completionTokens?: number | MissingValue
  totalTokens?: number | MissingValue
  cachedTokens?: number | MissingValue
  /** Physical model-provider requests, including requests without returned usage. */
  modelRequests?: number | MissingValue
  /** Requests with attributable metering; speech may use explicit heuristic metering. */
  modelCalls?: number | MissingValue
  toolCalls?: number | MissingValue
  estimatedCostUsd?: number | MissingValue
  /** Qualifies whether estimatedCostUsd covers none, some, or all model requests. */
  estimatedCostStatus?: CanonicalEstimatedCostStatus
  displayedCost?: string | MissingValue
  durationMs?: number | MissingValue
}

/**
 * Upgrade legacy usage records without erasing source visibility markers.
 *
 * Older Anera records only had modelCalls, so modelRequests=modelCalls is the
 * sole evidence-backed compatibility default. A numeric cost is never left
 * unqualified: failed/unmetered requests become unknown/partial, while usage
 * whose request provenance is unavailable stays explicitly unknown.
 */
export function canonicalUsageWithProvenance(usage: CanonicalUsage): CanonicalUsage {
  const modelCalls = usage.modelCalls
  let modelRequests = usage.modelRequests
  if (modelRequests === undefined) {
    modelRequests = modelCalls === undefined ? 'unknown' : modelCalls
  } else if (typeof modelRequests === 'number' && typeof modelCalls === 'number') {
    modelRequests = Math.max(modelRequests, modelCalls)
  }

  return {
    ...usage,
    modelRequests,
    estimatedCostStatus: usage.estimatedCostStatus
      ?? inferredCanonicalEstimatedCostStatus(modelRequests, modelCalls, usage.estimatedCostUsd),
  }
}

export function canonicalTraceWithUsageProvenance(trace: CanonicalTrace): CanonicalTrace {
  return {
    ...trace,
    events: trace.events.map((event) => event.usage
      ? { ...event, usage: canonicalUsageWithProvenance(event.usage) }
      : event),
    outcome: { ...trace.outcome, usage: canonicalUsageWithProvenance(trace.outcome.usage) },
    ...(trace.sideOutcomes ? {
      sideOutcomes: Object.fromEntries(Object.entries(trace.sideOutcomes).map(([side, outcome]) => [
        side,
        { ...outcome, usage: canonicalUsageWithProvenance(outcome.usage) },
      ])),
    } : {}),
  }
}

function inferredCanonicalEstimatedCostStatus(
  modelRequests: number | MissingValue,
  modelCalls: number | MissingValue | undefined,
  estimatedCostUsd: number | MissingValue | undefined,
): CanonicalEstimatedCostStatus {
  if (modelRequests === 0) return 'not_incurred'
  if (typeof modelRequests !== 'number') return modelRequests
  if (typeof modelCalls !== 'number' || modelCalls === 0) return 'unknown'
  if (typeof estimatedCostUsd !== 'number') {
    return estimatedCostUsd === 'not_visible'
      || estimatedCostUsd === 'not_captured'
      || estimatedCostUsd === 'not_applicable'
      ? estimatedCostUsd
      : 'unknown'
  }
  return modelCalls < modelRequests ? 'partial' : 'estimated'
}

export interface CanonicalTool {
  name: string
  operation?: string
  callId?: string
  arguments?: CanonicalValue | MissingValue
  result?: CanonicalValue | MissingValue
  isError?: boolean | MissingValue
}

export interface CanonicalArtifact {
  id?: string
  path?: string | MissingValue
  name?: string | MissingValue
  kind?: string | MissingValue
  mime?: string | MissingValue
  bytes?: number | MissingValue
  sha256?: string | MissingValue
  operation?: string | MissingValue
}

export interface CanonicalProcess {
  id?: string
  command?: string | MissingValue
  pid?: number | MissingValue
  port?: number | MissingValue
  status?: CanonicalStatus
  exitCode?: number | null | MissingValue
  signal?: string | null | MissingValue
}

export interface CanonicalWebsite {
  status?: CanonicalStatus
  entryPath?: string | MissingValue
  processId?: string | MissingValue
  port?: number | MissingValue
  restartCount?: number | MissingValue
  action?: string | MissingValue
}

export interface CanonicalDeployment {
  id?: string | MissingValue
  callId?: string | MissingValue
  status?: CanonicalStatus
  url?: string | MissingValue
  visibility?: 'local' | 'public' | MissingValue
  revision?: number | MissingValue
  entryPath?: string | MissingValue
  contentHash?: string | MissingValue
  fileCount?: number | MissingValue
  bytes?: number | MissingValue
  action?: string | MissingValue
}

export interface CanonicalApproval {
  id?: string
  decision?: 'pending' | 'approved' | 'denied' | 'expired' | MissingValue
  title?: string | MissingValue
}

export interface CanonicalEvidence {
  recordingId?: string | MissingValue
  segmentId?: string | MissingValue
  videoTimecode?: string | MissingValue
  uiItemId?: string | MissingValue
  visibility?: string | MissingValue
  captureMethods?: string[] | MissingValue
  reference?: string | MissingValue
  notes?: string | MissingValue
}

export interface CanonicalEvent {
  schemaVersion: typeof CANONICAL_TRACE_VERSION
  source: TraceSource
  traceId: string
  seq: number
  sourceSeq: number | string
  side: string
  timestamp?: string | MissingValue
  observedAtMs?: number | MissingValue
  actor: CanonicalActor
  kind: CanonicalEventKind
  action: string
  phase: CanonicalPhase
  status: CanonicalStatus
  turnId?: string | MissingValue
  episodeId?: string | MissingValue
  parentEpisodeId?: string | MissingValue
  stepId?: string | MissingValue
  label?: string | MissingValue
  message?: string | MissingValue
  tool?: CanonicalTool
  artifact?: CanonicalArtifact
  process?: CanonicalProcess
  website?: CanonicalWebsite
  deployment?: CanonicalDeployment
  approval?: CanonicalApproval
  usage?: CanonicalUsage
  payload?: CanonicalValue
  evidence?: CanonicalEvidence
}

export interface CanonicalTraceHeader {
  schemaVersion: typeof CANONICAL_TRACE_VERSION
  source: TraceSource
  traceId: string
  taskId?: string | MissingValue
  model?: string | MissingValue
  productMode?: 'chat' | 'coding' | MissingValue
  repository?: {
    provider: 'github' | MissingValue
    repoId?: number | MissingValue
    fullName?: string | MissingValue
    baseBranch?: string | MissingValue
    baseCommitSha?: string | MissingValue
    private?: boolean | MissingValue
  }
  startedAt?: string | MissingValue
  completedAt?: string | MissingValue
  durationMs?: number | MissingValue
  eventCount: number
  sides: string[]
}

export interface CanonicalOutcome {
  status: CanonicalStatus
  finalText: string | MissingValue
  artifactPaths: string[] | MissingValue
  usage: CanonicalUsage
}

export interface CanonicalTrace {
  header: CanonicalTraceHeader
  events: CanonicalEvent[]
  outcome: CanonicalOutcome
  sideOutcomes?: Record<string, CanonicalOutcome>
}

export type CanonicalTraceRecord =
  | { recordType: 'trace'; trace: CanonicalTraceHeader }
  | { recordType: 'event'; event: CanonicalEvent }
  | { recordType: 'outcome'; outcome: CanonicalOutcome; sideOutcomes?: Record<string, CanonicalOutcome> }
