import { createHash } from 'node:crypto'
import type {
  ArtifactRecord,
  CodingRepositoryState,
  ProcessRecord,
  RunStatus,
  SessionEvent,
  SessionSummary,
  UsageTotals,
  WebsiteState,
} from '../shared/types.js'
import {
  CANONICAL_TRACE_VERSION,
  canonicalTraceWithUsageProvenance,
  canonicalUsageWithProvenance,
  type CanonicalActor,
  type CanonicalArtifact,
  type CanonicalDeployment,
  type CanonicalEvent,
  type CanonicalEventKind,
  type CanonicalOutcome,
  type CanonicalPhase,
  type CanonicalProcess,
  type CanonicalStatus,
  type CanonicalTool,
  type CanonicalTrace,
  type CanonicalTraceRecord,
  type CanonicalUsage,
  type CanonicalValue,
  type CanonicalWebsite,
  type MissingValue,
} from '../shared/canonical-trace.js'

interface AneraTraceInput {
  events: SessionEvent[]
  summary?: SessionSummary
  artifacts?: ArtifactRecord[]
  processes?: ProcessRecord[]
  website?: WebsiteState
  repository?: CodingRepositoryState | null
  taskId?: string
}

interface ToolIdentity {
  name: string
  operation?: string
}

const MISSING_VALUES = new Set<MissingValue>(['not_visible', 'not_captured', 'unknown', 'not_applicable'])

export function normalizeAneraTrace(input: AneraTraceInput): CanonicalTrace {
  const ordered = [...input.events].sort((a, b) => a.seq - b.seq)
  const traceId = input.summary?.id || ordered[0]?.sessionId || 'anera-unknown'
  const firstTime = ordered[0]?.at ? Date.parse(ordered[0].at) : Number.NaN
  const turns = new StableIds('T')
  const episodes = new StableIds('E')
  const steps = new StableIds('S')
  const calls = new StableIds('C')
  const artifacts = new StableIds('A')
  const processes = new StableIds('P')
  const deployments = new StableIds('D')
  const approvals = new StableIds('AP')
  const planItems = new StableIds('PL')
  const nodes = new StableIds('N')
  const parentEpisodes = new Map<string, string>()
  let previousEpisode: string | undefined

  for (const event of ordered) {
    if (event.type === 'assistant.final') nodes.get(event.id)
    if (!event.turnId) continue
    const turnId = turns.get(event.turnId)
    const episodeId = episodes.get(event.turnId)
    if (event.type === 'run.resumed' && previousEpisode && previousEpisode !== episodeId) {
      parentEpisodes.set(episodeId, previousEpisode)
    }
    if (event.type === 'turn.started' || event.type === 'run.resumed') previousEpisode = episodeId
    void turnId
  }

  const canonical: CanonicalEvent[] = []
  for (const event of ordered) {
    if (
      event.type === 'assistant.thought.delta'
      || event.type === 'assistant.tool_call.delta'
      || event.type === 'assistant.final.delta'
      || event.type === 'tool.output'
      // Local physical-provider accounting has no Arena-visible trajectory
      // counterpart and must not distort parity event alignment.
      || event.type === 'provider.usage'
      // Anera may ask the model to repair a missing required tool argument
      // before any tool event or side effect. Arena exposes no equivalent.
      || event.type === 'model.tool_call.repair'
      // Final source-integrity repair is an internal quality boundary, not an
      // Arena-visible trajectory event.
      || event.type === 'model.final.repair'
    ) continue
    const mapped = mapAneraEvent({
      event,
      traceId,
      firstTime,
      turns,
      episodes,
      steps,
      calls,
      artifacts,
      processes,
      deployments,
      approvals,
      planItems,
      nodes,
      parentEpisodes,
    })
    if (!mapped) continue
    canonical.push({ ...mapped, seq: canonical.length + 1 })
  }

  const finalEvent = [...canonical].reverse().find((event) => event.kind === 'final')
  const lastUsageEvent = [...canonical].reverse().find((event) => event.usage)?.usage
  const eventArtifacts = new Map<string, string>()
  for (const event of canonical) {
    const path = event.artifact?.path
    if (typeof path !== 'string') continue
    if (event.action === 'removed') eventArtifacts.delete(path)
    else eventArtifacts.set(path, path)
  }
  const artifactPaths = input.artifacts
    ? input.artifacts.map((artifact) => normalizeDynamicText(artifact.path))
    : [...eventArtifacts.values()]
  const firstAt = ordered[0]?.at
  const lastAt = ordered.at(-1)?.at
  const durationMs = input.summary?.usage.durationMs ?? durationBetween(firstAt, lastAt)
  const usage = input.summary ? usageFromTotals(input.summary.usage) : lastUsageEvent ?? {}
  if (usage.durationMs === undefined && durationMs !== undefined) usage.durationMs = durationMs
  const status = input.summary
    ? canonicalStatus(input.summary.status)
    : [...canonical].reverse().find((event) => event.kind === 'lifecycle')?.status ?? 'unknown'
  const createdData = asRecord(ordered.find((event) => event.type === 'session.created')?.data)
  const repository = input.repository ?? repositoryFromRecord(asRecord(createdData.repository))
  const productMode = input.summary?.productMode ?? (createdData.productMode === 'coding' ? 'coding' : createdData.productMode === 'chat' ? 'chat' : repository ? 'coding' : undefined)

  const outcome: CanonicalOutcome = {
    status,
    finalText: typeof finalEvent?.message === 'string' ? finalEvent.message : 'not_visible',
    artifactPaths,
    usage,
  }
  return {
    header: {
      schemaVersion: CANONICAL_TRACE_VERSION,
      source: 'anera',
      traceId,
      taskId: input.taskId,
      model: input.summary?.model,
      productMode,
      ...(repository ? {
        repository: {
          provider: repository.provider,
          repoId: repository.repoId,
          fullName: repository.fullName,
          baseBranch: repository.baseBranch,
          baseCommitSha: repository.baseCommitSha,
          private: repository.private,
        },
      } : {}),
      startedAt: firstAt,
      completedAt: lastAt,
      durationMs,
      eventCount: canonical.length,
      sides: ['global'],
    },
    events: canonical,
    outcome,
  }
}

interface MapContext {
  event: SessionEvent
  traceId: string
  firstTime: number
  turns: StableIds
  episodes: StableIds
  steps: StableIds
  calls: StableIds
  artifacts: StableIds
  processes: StableIds
  deployments: StableIds
  approvals: StableIds
  planItems: StableIds
  nodes: StableIds
  parentEpisodes: Map<string, string>
}

function mapAneraEvent(context: MapContext): Omit<CanonicalEvent, 'seq'> | undefined {
  const { event } = context
  const data = asRecord(event.data)
  const turnId = event.turnId ? context.turns.get(event.turnId) : undefined
  const episodeId = event.turnId ? context.episodes.get(event.turnId) : undefined
  const stepId = event.stepId ? context.steps.get(event.stepId) : undefined
  const observedAtMs = Number.isFinite(context.firstTime) ? Math.max(0, Date.parse(event.at) - context.firstTime) : undefined
  const base = {
    schemaVersion: CANONICAL_TRACE_VERSION,
    source: 'anera' as const,
    traceId: context.traceId,
    sourceSeq: event.seq,
    side: 'global',
    timestamp: event.at,
    observedAtMs,
    turnId,
    episodeId,
    parentEpisodeId: episodeId ? context.parentEpisodes.get(episodeId) : undefined,
    stepId,
  }

  switch (event.type) {
    case 'session.created':
      return canonical(base, 'system_ui', 'session', 'created', 'finalized', 'succeeded', {
        label: stringValue(data.title),
        payload: normalizeCanonicalValue({ productMode: data.productMode ?? 'chat', repository: data.repository ?? null }),
      })
    case 'session.limit.reached':
      return canonical(base, 'system_ui', 'lifecycle', 'session_token_limit', 'finalized', 'failed', {
        message: normalizeDynamicText(stringValue(data.message) || ''),
        payload: normalizeCanonicalValue({ code: data.code ?? 'session_token_limit', limit: data.limit ?? null }),
      })
    case 'turn.started':
      return canonical(base, 'user', 'message', data.customFeedbackTurn === true ? 'custom_feedback_submitted' : 'submitted', 'finalized', 'succeeded', {
        message: normalizeDynamicText(stringValue(data.content) || ''),
        payload: normalizeCanonicalValue({
          attachments: data.attachments ?? [],
          model: data.model ?? null,
          modelSelection: data.modelSelection ?? null,
          ...(data.customFeedbackTurn === true ? {
            customFeedbackTurn: true,
            reviewedNodeId: typeof data.reviewedNodeId === 'string' ? context.nodes.get(data.reviewedNodeId) : null,
            has_feedback: data.has_feedback === true,
          } : {}),
        }),
      })
    case 'turn.completed':
      return canonical(base, 'system_ui', 'lifecycle', 'turn_completed', 'finalized', canonicalStatus(data.status), {})
    case 'run.status':
      return canonical(base, 'system_ui', 'lifecycle', 'run_status', 'updated', canonicalStatus(data.status), {})
    case 'run.resumed':
      return canonical(base, 'operator', 'operator_action', 'continue', 'finalized', 'succeeded', {
        message: normalizeDynamicText(stringValue(data.message) || ''),
      })
    case 'assistant.started':
      return canonical(base, 'assistant', 'lifecycle', 'assistant_started', 'started', 'running', {
        payload: normalizeCanonicalValue({ step: data.step ?? null }),
      })
    case 'assistant.thought.started':
      return canonical(base, 'assistant', 'thought', 'thought', 'started', 'running', {})
    case 'assistant.thought.completed':
      return canonical(base, 'assistant', 'thought', 'thought', 'completed', 'succeeded', {
        message: normalizeDynamicText(stringValue(data.text) || ''),
      })
    case 'assistant.final':
      return canonical(base, 'assistant', 'final', 'final_answer', 'finalized', 'succeeded', {
        message: normalizeDynamicText(stringValue(data.content) || ''),
        payload: normalizeCanonicalValue({ finishReason: data.finishReason ?? null }),
      })
    case 'plan.updated': {
      const rawPlan = asRecord(data.plan)
      const items = Array.isArray(rawPlan.items) ? rawPlan.items.map((value, index) => {
        const item = asRecord(value)
        return {
          id: context.planItems.get(stringValue(item.id) || `plan-item:${index}`),
          step: stringValue(item.step) || '',
          status: stringValue(item.status) || 'unknown',
        }
      }) : []
      const status = items.some((item) => item.status === 'in_progress')
        ? 'running'
        : items.length > 0 && items.every((item) => item.status === 'completed') ? 'succeeded' : 'idle'
      return canonical(base, 'system_ui', 'plan', 'updated', 'updated', status, {
        message: stringValue(data.explanation) || stringValue(rawPlan.explanation),
        payload: normalizeCanonicalValue({ items, version: rawPlan.version ?? null }),
      })
    }
    case 'tool.started': {
      const call = asRecord(data.call)
      const rawName = stringValue(call.name) || 'unknown'
      const identity = canonicalToolName(rawName, asRecord(call.arguments))
      return canonical(base, 'tool', 'tool', identity.name, 'started', 'running', {
        tool: toolFromCall(call, identity, context.calls, event.callId),
      })
    }
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.timed_out': {
      const call = asRecord(data.call)
      const rawName = stringValue(call.name) || 'unknown'
      const identity = canonicalToolName(rawName, asRecord(call.arguments))
      const status = event.type === 'tool.completed' ? 'succeeded' : event.type === 'tool.timed_out' ? 'timed_out' : 'failed'
      return canonical(base, 'tool', 'tool', identity.name, 'completed', status, {
        tool: {
          ...toolFromCall(call, identity, context.calls, event.callId),
          result: normalizeToolResult(data.result),
          isError: typeof data.isError === 'boolean' ? data.isError : status !== 'succeeded',
        },
      })
    }
    case 'file.changed':
      return canonical(base, 'tool', 'file', stringValue(data.operation) || 'changed', 'finalized', 'succeeded', {
        artifact: {
          path: normalizePath(stringValue(data.path)),
          bytes: numberValue(data.bytes),
          operation: stringValue(data.operation) || 'changed',
        },
      })
    case 'workspace.persistence.started':
    case 'workspace.persistence.updated':
    case 'workspace.persistence.completed': {
      const completed = event.type === 'workspace.persistence.completed'
      return canonical(base, 'system_ui', 'workspace', 'updated', completed ? 'finalized' : 'updated', completed ? 'succeeded' : 'running', {
        label: stringValue(data.label),
        payload: normalizeCanonicalValue({
          phase: data.phase ?? null,
          label: data.label ?? null,
          blobCount: data.blobCount ?? null,
          bytes: data.bytes ?? null,
          fileCount: data.fileCount ?? null,
          persistenceMode: data.persistenceMode ?? null,
        }),
      })
    }
    case 'artifact.created':
    case 'artifact.removed': {
      const raw = asRecord(data.artifact)
      const rawId = stringValue(raw.id) || `${stringValue(raw.path)}:${event.type}`
      const artifact: CanonicalArtifact = {
        id: context.artifacts.get(rawId),
        path: normalizePath(stringValue(raw.path) || stringValue(data.path)),
        name: stringValue(raw.name),
        kind: stringValue(raw.kind),
        mime: stringValue(raw.mime),
        operation: event.type === 'artifact.created' ? 'created' : 'removed',
      }
      return canonical(base, 'system_ui', 'artifact', event.type === 'artifact.created' ? 'created' : 'removed', 'finalized', 'succeeded', { artifact })
    }
    case 'process.started':
    case 'process.output':
    case 'process.updated':
    case 'process.stopped': {
      const raw = asRecord(data.record)
      const process = processFromRecord(raw, context.processes)
      const action = event.type === 'process.started'
        ? 'started'
        : event.type === 'process.output'
          ? 'output'
          : event.type === 'process.updated'
            ? 'updated'
            : 'stopped'
      const status = event.type === 'process.started' ? 'running' : canonicalStatus(process.status)
      return canonical(base, 'system_ui', 'process', action, event.type === 'process.output' ? 'progress' : 'updated', status, { process })
    }
    case 'website.updated': {
      const raw = asRecord(data.website)
      const website: CanonicalWebsite = {
        status: canonicalStatus(raw.status),
        entryPath: normalizePath(stringValue(raw.entryPath)),
        processId: stringValue(raw.processId) ? context.processes.get(stringValue(raw.processId) as string) : undefined,
        port: numberValue(raw.port),
        restartCount: numberValue(raw.restartCount),
        action: stringValue(data.action),
      }
      return canonical(base, 'system_ui', 'website', stringValue(data.action) || 'updated', 'updated', website.status ?? 'unknown', { website })
    }
    case 'deployment.updated': {
      const raw = asRecord(data.deployment)
      const deploymentStatus = deploymentCanonicalStatus(raw.status)
      const deployment: CanonicalDeployment = {
        id: stringValue(raw.id) ? context.deployments.get(stringValue(raw.id) as string) : undefined,
        callId: event.callId ? context.calls.get(event.callId) : undefined,
        status: deploymentStatus,
        url: stringValue(raw.url) ? normalizeDynamicText(stringValue(raw.url) as string) : undefined,
        visibility: raw.visibility === 'local' || raw.visibility === 'public' ? raw.visibility : undefined,
        revision: numberValue(raw.revision),
        entryPath: normalizePath(stringValue(raw.entryPath)),
        contentHash: stringValue(raw.contentHash),
        fileCount: numberValue(raw.fileCount),
        bytes: numberValue(raw.bytes),
        action: stringValue(data.action),
      }
      return canonical(base, 'system_ui', 'deployment', stringValue(data.action) || 'updated', 'updated', deploymentStatus, { deployment })
    }
    case 'usage.updated':
      return canonical(base, 'system_ui', 'usage', stringValue(data.source) || 'model', 'updated', 'succeeded', {
        usage: usageFromRecord(asRecord(data.usage)),
      })
    case 'feedback.updated': {
      const value = data.value === 'upvote' || data.value === 'downvote' ? data.value : null
      return canonical(base, 'operator', 'operator_action', value ?? 'feedback_cleared', 'finalized', 'succeeded', {
        payload: normalizeCanonicalValue({ messageEventId: data.messageEventId ?? null, value, model: data.model ?? null }),
      })
    }
    case 'task.completion.updated': {
      const value = data.value === 'no' || data.value === 'making_progress' || data.value === 'yes' ? data.value : null
      return canonical(base, 'operator', 'operator_action', value ? `task_completion_${value}` : 'task_completion_unknown', 'finalized', value ? 'succeeded' : 'failed', {
        payload: normalizeCanonicalValue({
          sessionNodeId: data.sessionNodeId ?? null,
          messageEventId: data.messageEventId ?? data.sessionNodeId ?? null,
          feedbackType: 'task_completion_bar',
          value,
          model: data.model ?? null,
        }),
      })
    }
    case 'review.requested':
      return canonical(base, 'system_ui', 'lifecycle', data.feedbackType === 'task_completion_bar' ? 'task_completion_bar_required' : 'task_review_required', 'appeared', 'awaiting_user_input', {
        payload: normalizeCanonicalValue({ messageEventId: data.messageEventId ?? null, feedbackType: data.feedbackType ?? 'check_in', model: data.model ?? null }),
      })
    case 'review.dismissed': {
      const action = data.action === 'continue' ? 'continue_working' : 'task_review_dismissed'
      return canonical(base, 'operator', 'operator_action', action, 'finalized', 'succeeded', {
        payload: normalizeCanonicalValue({
          messageEventId: data.messageEventId ?? null,
          reviewAction: data.action === 'continue' || data.action === 'dismiss' ? data.action : null,
          model: data.model ?? null,
        }),
      })
    }
    case 'turn.undone':
      return canonical(base, 'operator', 'operator_action', 'undo_last_turn', 'finalized', 'succeeded', {
        payload: normalizeCanonicalValue({
          sessionNodeId: data.sessionNodeId ?? null,
          targetMessageEventId: data.targetMessageEventId ?? data.sessionNodeId ?? null,
          targetTurnIds: data.targetTurnIds ?? [],
          promptRestored: data.promptRestored ?? null,
          attachmentsCleared: data.attachmentsCleared ?? null,
          feedbackPreserved: data.feedbackPreserved ?? null,
          workspaceReverted: data.workspaceReverted ?? null,
        }),
      })
    case 'context.compacted':
      return canonical(base, 'system', 'context', 'compacted', 'completed', 'succeeded', {
        message: normalizeDynamicText(stringValue(data.summary) || ''),
        payload: normalizeCanonicalValue({
          compactedMessageCount: data.compactedMessageCount ?? null,
          retainedMessageCount: data.retainedMessageCount ?? null,
          beforeBytes: data.beforeBytes ?? null,
          afterBytes: data.afterBytes ?? null,
          reason: data.reason ?? null,
          forced: data.forced ?? null,
        }),
      })
    case 'context.compaction.failed':
      return canonical(base, 'system', 'context', 'compaction_failed', 'completed', 'failed', {
        message: normalizeDynamicText(stringValue(data.message) || ''),
        payload: normalizeCanonicalValue({ reason: data.reason ?? null, forced: data.forced ?? null }),
      })
    case 'session.recovered':
      return canonical(base, 'system_ui', 'lifecycle', 'session_recovered', 'finalized', 'interrupted', {
        message: normalizeDynamicText(stringValue(data.message) || ''),
      })
    case 'approval.required': {
      const approvalId = context.approvals.get(stringValue(data.approvalId) || `approval:${event.seq}`)
      return canonical(base, 'system_ui', 'approval', 'required', 'appeared', 'awaiting_approval', {
        approval: { id: approvalId, decision: 'pending', title: stringValue(data.title) },
      })
    }
    case 'approval.resolved': {
      const approvalId = context.approvals.get(stringValue(data.approvalId) || `approval:${event.seq}`)
      const approved = data.approved === true || data.decision === 'approved'
      return canonical(base, 'operator', 'approval', 'resolved', 'finalized', approved ? 'approved' : 'denied', {
        approval: { id: approvalId, decision: approved ? 'approved' : 'denied' },
      })
    }
    case 'approval.expired': {
      const approvalId = context.approvals.get(stringValue(data.approvalId) || `approval:${event.seq}`)
      return canonical(base, 'system_ui', 'approval', 'expired', 'finalized', 'expired', {
        approval: { id: approvalId, decision: 'expired' },
      })
    }
    case 'error':
      return canonical(base, 'system_ui', 'error', data.cancelled ? 'cancelled' : data.interrupted ? 'interrupted' : 'error', 'finalized', data.cancelled ? 'cancelled' : data.interrupted ? 'interrupted' : 'failed', {
        message: normalizeDynamicText(stringValue(data.message) || ''),
      })
    default:
      return canonical(base, 'system', 'other', event.type, 'updated', 'unknown', {
        payload: normalizeCanonicalValue(data),
      })
  }
}

function canonical(
  base: Omit<CanonicalEvent, 'seq' | 'actor' | 'kind' | 'action' | 'phase' | 'status'>,
  actor: CanonicalActor,
  kind: CanonicalEventKind,
  action: string,
  phase: CanonicalPhase,
  status: CanonicalStatus,
  extra: Partial<CanonicalEvent>,
): Omit<CanonicalEvent, 'seq'> {
  return { ...base, actor, kind, action, phase, status, ...extra }
}

function toolFromCall(call: Record<string, unknown>, identity: ToolIdentity, ids: StableIds, fallbackId?: string): CanonicalTool {
  const rawId = stringValue(call.id) || fallbackId || `${identity.name}:${JSON.stringify(call.arguments ?? {})}`
  return {
    name: identity.name,
    operation: identity.operation,
    callId: ids.get(rawId),
    arguments: normalizeToolArguments(identity, asRecord(call.arguments)),
  }
}

function processFromRecord(raw: Record<string, unknown>, ids: StableIds): CanonicalProcess {
  const rawId = stringValue(raw.id) || `process:${stringValue(raw.command) || 'unknown'}`
  return {
    id: ids.get(rawId),
    command: stringValue(raw.command) ? normalizeDynamicText(stringValue(raw.command) as string) : undefined,
    pid: numberValue(raw.pid),
    port: numberValue(raw.port),
    status: canonicalStatus(raw.status),
    exitCode: raw.exitCode === null ? null : numberValue(raw.exitCode),
    signal: raw.signal === null ? null : stringValue(raw.signal),
  }
}

export function canonicalToolName(rawName: string, args: Record<string, unknown> = {}): ToolIdentity {
  const compact = rawName.trim().toLowerCase().replace(/[\s.-]+/g, '_')
  const aliases: Record<string, string> = {
    bash: 'shell',
    shell_command: 'shell',
    shell: 'shell',
    terminal: 'shell',
    search_web: 'search',
    web_search: 'search',
    search: 'search',
    searched_the_web: 'search',
    web_fetch: 'fetch',
    fetch_page: 'fetch',
    fetch: 'fetch',
    fetched: 'fetch',
    read_url: 'fetch',
    fetch_media: 'media_fetch',
    generate_image: 'image_generate',
    list_files: 'file_list',
    grep: 'grep_files',
    grep_files: 'grep_files',
    glob: 'glob_files',
    glob_files: 'glob_files',
    read_file: 'file_read',
    create_file: 'file_write',
    write_file: 'file_write',
    edit_file: 'file_edit',
    delete_file: 'file_delete',
    apply_patch: 'file_patch',
    update_plan: 'plan_update',
    extract_attachment: 'attachment_read',
    inspect_image: 'vision',
    start_process: 'process_start',
    list_processes: 'process_list',
    stop_process: 'process_stop',
    preview_website: 'website_preview',
    http_request: 'http_write',
    package_install: 'package_install',
    install_npm_packages: 'package_install',
    build_project: 'build',
    build_and_start: 'website_start',
    deploy_project: 'deploy',
  }
  if (compact === 'browser' || compact.startsWith('browser_')) {
    const operation = stringValue(args.action) || compact.replace(/^browser_?/, '') || 'unknown'
    return { name: 'browser', operation }
  }
  if (compact === 'read') {
    if (typeof args.url === 'string') return { name: 'fetch' }
    if (typeof args.path === 'string') return { name: 'file_read' }
  }
  if (compact.startsWith('searched')) return { name: 'search' }
  if (compact.startsWith('fetched') || compact.startsWith('read_url')) return { name: 'fetch' }
  if (compact.startsWith('ran_bash') || compact.startsWith('used_bash')) return { name: 'shell' }
  return { name: aliases[compact] || compact || 'unknown' }
}

function deploymentCanonicalStatus(value: unknown): CanonicalStatus {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'not_deployed': return 'idle'
    case 'building':
    case 'deploying': return 'running'
    case 'deployed': return 'succeeded'
    case 'failed': return 'failed'
    default: return canonicalStatus(value)
  }
}

export function normalizeToolArguments(identity: ToolIdentity, raw: Record<string, unknown>): CanonicalValue | MissingValue {
  if (Object.keys(raw).length === 0) return {}
  const args = { ...raw }
  if (identity.name === 'file_write' && typeof args.content === 'string') args.content = summarizeLargeString(args.content, 0)
  if (identity.name === 'file_edit') {
    if (typeof args.old_text === 'string') args.old_text = summarizeLargeString(args.old_text, 120)
    if (typeof args.new_text === 'string') args.new_text = summarizeLargeString(args.new_text, 120)
    if (typeof args.context === 'string') args.context = summarizeLargeString(args.context, 120)
    if (typeof args.replacement === 'string') args.replacement = summarizeLargeString(args.replacement, 120)
  }
  if (identity.name === 'file_patch' && typeof args.input === 'string') args.input = summarizeLargeString(args.input, 240)
  if (identity.name === 'browser' && typeof args.ref === 'string') args.ref = '<ref>'
  if (typeof args.process_id === 'string') args.process_id = '<process>'
  return normalizeCanonicalValue(args)
}

export function normalizeToolResult(value: unknown): CanonicalValue | MissingValue {
  if (isMissingValue(value)) return value
  if (typeof value === 'string') {
    const normalized = normalizeDynamicText(value)
    if (/^[\[{]/.test(normalized)) {
      try {
        return normalizeCanonicalValue(JSON.parse(normalized))
      } catch {
        // Preserve non-JSON command output that merely begins with a brace/bracket.
      }
    }
    return summarizeLargeString(normalized, 2_000)
  }
  return normalizeCanonicalValue(value)
}

export function normalizeCanonicalValue(value: unknown): CanonicalValue {
  if (value === undefined) return null
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return normalizeDynamicText(value)
  if (Array.isArray(value)) return value.map((item) => normalizeCanonicalValue(item))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeCanonicalValue(item)]),
    )
  }
  return String(value)
}

export function normalizeDynamicText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\/[\w./ -]*\/sessions\/ses_[a-z0-9]{20}\/workspace\//gi, '<workspace>/')
    .replace(/\b(?:ses|evt|turn|step|art|proc|approval)_[A-Za-z0-9_-]{8,}\b/g, (match) => `<${match.split('_', 1)[0]}>`)
    .replace(/\bcall_[A-Za-z0-9_-]{8,}\b/g, '<call>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/((?:https?:\/\/)?(?:127\.0\.0\.1|localhost)):\d{2,5}\b/gi, '$1:<port>')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

export function normalizePath(value: string | undefined): string | undefined {
  if (!value) return undefined
  return normalizeDynamicText(value).replace(/^\.\//, '')
}

export function canonicalStatus(value: unknown): CanonicalStatus {
  if (isMissingValue(value)) return value
  const status = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const aliases: Record<string, CanonicalStatus> = {
    completed: 'succeeded',
    complete: 'succeeded',
    success: 'succeeded',
    successful: 'succeeded',
    succeeded: 'succeeded',
    failure: 'failed',
    canceled: 'cancelled',
    awaiting_user: 'awaiting_user_input',
    pending_approval: 'awaiting_approval',
    rejected: 'denied',
  }
  const mapped = aliases[status] || status
  const allowed = new Set<CanonicalStatus>([
    'idle', 'queued', 'starting', 'running', 'asleep', 'cancelling', 'stopped', 'exited', 'awaiting_approval', 'awaiting_user_input', 'succeeded', 'failed', 'cancelled',
    'timed_out', 'interrupted', 'input_rejected', 'approved', 'denied', 'expired', 'not_visible', 'not_captured',
    'unknown', 'not_applicable',
  ])
  return allowed.has(mapped as CanonicalStatus) ? mapped as CanonicalStatus : 'unknown'
}

export function traceToJsonl(trace: CanonicalTrace): string {
  const qualifiedTrace = canonicalTraceWithUsageProvenance(trace)
  const records: CanonicalTraceRecord[] = [
    { recordType: 'trace', trace: qualifiedTrace.header },
    ...qualifiedTrace.events.map((event): CanonicalTraceRecord => ({ recordType: 'event', event })),
    { recordType: 'outcome', outcome: qualifiedTrace.outcome, sideOutcomes: qualifiedTrace.sideOutcomes },
  ]
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function usageFromTotals(usage: UsageTotals): CanonicalUsage {
  return canonicalUsageWithProvenance({
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: usage.cachedPromptTokens,
    modelRequests: usage.modelRequests,
    modelCalls: usage.modelCalls,
    toolCalls: usage.toolCalls,
    estimatedCostUsd: usage.estimatedCostUsd,
    estimatedCostStatus: usage.estimatedCostStatus,
    durationMs: usage.durationMs,
  })
}

function usageFromRecord(usage: Record<string, unknown>): CanonicalUsage {
  return canonicalUsageWithProvenance({
    promptTokens: numericOrMissing(usage.promptTokens),
    completionTokens: numericOrMissing(usage.completionTokens),
    totalTokens: numericOrMissing(usage.totalTokens),
    cachedTokens: numericOrMissing(usage.cachedPromptTokens ?? usage.cachedTokens),
    modelRequests: numericOrMissing(usage.modelRequests),
    modelCalls: numericOrMissing(usage.modelCalls),
    toolCalls: numericOrMissing(usage.toolCalls),
    estimatedCostUsd: numericOrMissing(usage.estimatedCostUsd),
    estimatedCostStatus: estimatedCostStatusValue(usage.estimatedCostStatus),
    durationMs: numericOrMissing(usage.durationMs),
  })
}

function estimatedCostStatusValue(value: unknown): CanonicalUsage['estimatedCostStatus'] {
  return value === 'not_incurred'
    || value === 'estimated'
    || value === 'partial'
    || isMissingValue(value)
    ? value
    : undefined
}

function repositoryFromRecord(value: Record<string, unknown>): CodingRepositoryState | undefined {
  if (
    value.provider !== 'github' ||
    !Number.isSafeInteger(value.repoId) ||
    typeof value.fullName !== 'string' ||
    typeof value.ownerLogin !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.baseBranch !== 'string' ||
    typeof value.baseCommitSha !== 'string' ||
    typeof value.private !== 'boolean' ||
    typeof value.importedAt !== 'string'
  ) return undefined
  return value as unknown as CodingRepositoryState
}

function summarizeLargeString(value: string, previewLength: number): CanonicalValue {
  const normalized = normalizeDynamicText(value)
  const bytes = Buffer.byteLength(normalized)
  if (bytes <= 4_000) return normalized
  return {
    _type: 'large_text',
    bytes,
    sha256: createHash('sha256').update(normalized).digest('hex'),
    ...(previewLength > 0 ? { preview: normalized.slice(0, previewLength) } : {}),
  }
}

function durationBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined
  const duration = Date.parse(end) - Date.parse(start)
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

function isMissingValue(value: unknown): value is MissingValue {
  return typeof value === 'string' && MISSING_VALUES.has(value as MissingValue)
}

function numericOrMissing(value: unknown): number | MissingValue | undefined {
  if (isMissingValue(value)) return value
  return numberValue(value)
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

class StableIds {
  private readonly values = new Map<string, string>()

  constructor(private readonly prefix: string) {}

  get(raw: string): string {
    const existing = this.values.get(raw)
    if (existing) return existing
    const next = `${this.prefix}${String(this.values.size + 1).padStart(2, '0')}`
    this.values.set(raw, next)
    return next
  }
}

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && [
    'idle', 'queued', 'running', 'awaiting_approval', 'cancelling', 'cancelled', 'failed', 'completed', 'timed_out', 'interrupted',
  ].includes(value)
}
