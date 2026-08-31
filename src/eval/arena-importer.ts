import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  CANONICAL_TRACE_VERSION,
  canonicalTraceWithUsageProvenance,
  canonicalUsageWithProvenance,
  type CanonicalActor,
  type CanonicalEvent,
  type CanonicalEventKind,
  type CanonicalOutcome,
  type CanonicalPhase,
  type CanonicalStatus,
  type CanonicalTrace,
  type CanonicalUsage,
  type CanonicalValue,
  type MissingValue,
} from '../shared/canonical-trace.js'
import {
  canonicalStatus,
  canonicalToolName,
  normalizeCanonicalValue,
  normalizeDynamicText,
  normalizePath,
  normalizeToolArguments,
  normalizeToolResult,
} from '../server/trace-normalizer.js'

export interface ArenaImportOptions {
  traceId?: string
  taskId?: string | MissingValue
  model?: string | MissingValue
  outcomeStatus?: CanonicalStatus
  usage?: CanonicalUsage
  artifactPaths?: string[] | MissingValue
  metadataText?: string
  artifactsCsvText?: string
  bodyLoader?: (reference: string) => string | undefined
}

export interface ParsedArenaMetadata {
  schemaVersion?: string
  runId?: string
  taskId?: string
  taskVersion?: string | MissingValue
  windowSizePx?: string | MissingValue
  browserZoomPercent?: number | MissingValue
  captureQuality?: string | MissingValue
  startedAt?: string | MissingValue
  completedAt?: string | MissingValue
  rawStatuses: Record<string, string>
  statuses: Record<string, CanonicalStatus>
  usage: Record<string, CanonicalUsage>
  models: Record<string, string | MissingValue>
}

interface ArenaRow {
  [key: string]: string
}

interface ArenaArtifactEvidence {
  artifactId: string
  logicalPath?: string
  name?: string
  mime?: string
  bytes?: number
  sha256?: string
}

interface LegacyToolBody {
  command?: string
  stdout?: string
  stderr?: string
}

const MISSING = new Set<MissingValue>(['not_visible', 'not_captured', 'unknown', 'not_applicable'])

export function importArenaEventsFile(path: string, options: Omit<ArenaImportOptions, 'bodyLoader'> = {}): CanonicalTrace {
  const absolute = resolve(path)
  const fileRoot = dirname(absolute)
  const runRoot = basename(fileRoot) === 'normalized' ? dirname(fileRoot) : fileRoot
  let metadataText = options.metadataText
  if (!metadataText) {
    try {
      metadataText = readFileSync(resolve(runRoot, 'metadata.yaml'), 'utf8')
    } catch {
      // Metadata remains explicitly unavailable when only events.md was supplied.
    }
  }
  let artifactsCsvText = options.artifactsCsvText
  if (!artifactsCsvText) {
    try {
      artifactsCsvText = readFileSync(resolve(runRoot, 'normalized/artifacts.csv'), 'utf8')
    } catch {
      // Artifact evidence remains explicitly unavailable when artifacts.csv was not captured.
    }
  }
  return importArenaEventsMarkdown(readFileSync(absolute, 'utf8'), {
    ...options,
    metadataText,
    artifactsCsvText,
    traceId: options.traceId || basename(runRoot),
    bodyLoader: (reference) => {
      if (!reference || MISSING.has(reference as MissingValue)) return undefined
      for (const candidate of [resolve(runRoot, reference), resolve(fileRoot, reference)]) {
        try {
          return readFileSync(candidate, 'utf8')
        } catch {
          // Try the other documented relative-path base.
        }
      }
      return undefined
    },
  })
}

export function importArenaEventsMarkdown(markdown: string, options: ArenaImportOptions = {}): CanonicalTrace {
  const rows = parseEventTable(markdown)
  if (rows.length === 0) throw new Error('Arena events Markdown does not contain a non-empty seq event table')
  const embeddedBodies = parseEmbeddedBodies(markdown)
  const metadata = options.metadataText ? parseArenaMetadataYaml(options.metadataText) : undefined
  const artifactEvidence = options.artifactsCsvText ? parseArenaArtifactsCsv(options.artifactsCsvText) : new Map<string, ArenaArtifactEvidence[]>()
  const headingTraceId = markdown.match(/^#\s+Visible events\s+[—-]\s+(.+)$/m)?.[1]?.trim()
  const traceId = options.traceId || headingTraceId || 'arena-manual-run'
  const taskId = options.taskId || metadata?.taskId || traceId.match(/\b([A-Z]\d{2})\b/)?.[1] || 'unknown'
  const turnIds = new ManualIds('T')
  const episodeIds = new ManualIds('E')
  const stepIds = new ManualIds('S')
  const callIds = new ManualIds('C')
  const artifactIds = new ManualIds('A')
  const approvalIds = new ManualIds('AP')
  const deploymentIds = new ManualIds('D')

  const events = rows.map((row, index) => {
    const sourceSeq = numeric(row.seq) ?? (row.seq || index + 1)
    const embedded = embeddedBodies.get(String(row.seq).trim())
    const external = row.body_ref ? options.bodyLoader?.(row.body_ref) : undefined
    const body = external ?? embedded ?? ''
    const bodyFields = parseBodyFields(body)
    const legacyToolBody = parseLegacyToolBody(body)
    return mapArenaRow({
      row,
      body,
      bodyFields,
      legacyToolBody,
      artifactEvidence,
      traceId,
      seq: index + 1,
      sourceSeq,
      turnIds,
      episodeIds,
      stepIds,
      callIds,
      artifactIds,
      approvalIds,
      deploymentIds,
    })
  })
  const sides = [...new Set(events.map((event) => event.side))]
  const sideOutcomes = Object.fromEntries(sides.map((side) => [side, arenaSideOutcome(events, side, metadata)]))
  const outcome = aggregateArenaOutcome(sideOutcomes, metadata)
  if (options.outcomeStatus) outcome.status = options.outcomeStatus
  if (options.usage) outcome.usage = options.usage
  if (options.artifactPaths) outcome.artifactPaths = options.artifactPaths
  if (sides.length === 1) {
    const side = sides[0]
    if (options.outcomeStatus) sideOutcomes[side].status = options.outcomeStatus
    if (options.usage) sideOutcomes[side].usage = options.usage
    if (options.artifactPaths) sideOutcomes[side].artifactPaths = options.artifactPaths
  }
  const durationValues = Object.values(sideOutcomes).map((item) => item.usage.durationMs).filter((value): value is number => typeof value === 'number')
  const models = Object.values(metadata?.models ?? {}).filter((value): value is string => typeof value === 'string' && !isMissing(value))
  const uniqueModels = [...new Set(models)]

  return canonicalTraceWithUsageProvenance({
    header: {
      schemaVersion: CANONICAL_TRACE_VERSION,
      source: 'arena',
      traceId,
      taskId,
      model: options.model ?? (uniqueModels.length === 1 ? uniqueModels[0] : uniqueModels.length > 1 ? 'unknown' : 'not_visible'),
      startedAt: metadata?.startedAt ?? 'unknown',
      completedAt: metadata?.completedAt ?? 'unknown',
      durationMs: durationValues.length > 0 ? Math.max(...durationValues) : 'unknown',
      eventCount: events.length,
      sides,
    },
    events,
    outcome,
    sideOutcomes,
  })
}

interface RowContext {
  row: ArenaRow
  body: string
  bodyFields: Record<string, string>
  legacyToolBody: LegacyToolBody
  artifactEvidence: Map<string, ArenaArtifactEvidence[]>
  traceId: string
  seq: number
  sourceSeq: number | string
  turnIds: ManualIds
  episodeIds: ManualIds
  stepIds: ManualIds
  callIds: ManualIds
  artifactIds: ManualIds
  approvalIds: ManualIds
  deploymentIds: ManualIds
}

function mapArenaRow(context: RowContext): CanonicalEvent {
  const { row, bodyFields, legacyToolBody } = context
  const sourceEventType = normalizeName(row.event_type || 'other')
  const legacyTaskReview = isKnownLegacyTaskReview(context, sourceEventType)
  const eventType = legacyTaskReview ? 'task_review' : sourceEventType
  const mapping = arenaEventIdentity(eventType, row)
  const status = legacyTaskReview ? 'awaiting_user_input' : canonicalStatus(row.status || 'unknown')
  const phase = canonicalPhase(row.phase)
  const turnId = canonicalManualId(row.turn || row.turn_id, context.turnIds)
  const episodeId = canonicalManualId(row.episode || row.execution_episode_id, context.episodeIds)
  const parentEpisodeId = canonicalManualId(row.parent || row.parent_episode_id, context.episodeIds, true)
  const rawStep = row.step || row.step_id
  const stepId = canonicalManualId(rawStep, context.stepIds, true)
  const actor = canonicalActor(row.actor)
  const explicitVisibleArgs = fieldValue(bodyFields.visible_args ?? row.visible_args)
  const visibleArgs = explicitVisibleArgs ?? fieldValue(legacyToolBody.command)
  const explicitVisibleResult = fieldValue(bodyFields.visible_result ?? row.visible_result)
  const visibleResult = explicitVisibleResult ?? legacyToolResult(legacyToolBody, row, phase)
  const message = messageFromBody(context.body, bodyFields, row, mapping.kind)
  const evidence = {
    recordingId: missingAware(row.recording || row.recording_id),
    segmentId: missingAware(row.segment || row.segment_id),
    videoTimecode: missingAware(row.video_timecode),
    uiItemId: missingAware(row.ui_item_id),
    visibility: missingAware(row.visibility),
    captureMethods: parseListOrMissing(row.capture_methods),
    reference: missingAware(row.evidence),
    notes: missingAware(row.notes),
  }
  const event: CanonicalEvent = {
    schemaVersion: CANONICAL_TRACE_VERSION,
    source: 'arena',
    traceId: context.traceId,
    seq: context.seq,
    sourceSeq: context.sourceSeq,
    side: row.side || 'global',
    timestamp: 'not_visible',
    observedAtMs: numeric(row.observed_at_ms) ?? (isMissing(row.observed_at_ms) ? row.observed_at_ms : 'unknown'),
    actor,
    kind: mapping.kind,
    action: mapping.action,
    phase,
    status,
    turnId,
    episodeId,
    parentEpisodeId,
    stepId,
    label: missingAware(row.label),
    message,
    evidence,
  }

  if (mapping.kind === 'tool') {
    const rawTool = row.tool_or_op || (row.event_type === 'tool' ? row.label : '') || mapping.action
    const rawArgs = recordForToolArgs(visibleArgs)
    const identity = canonicalToolName(rawTool, rawArgs)
    const sourceCallId = row.call_id || row.ui_item_id || `${row.seq}:${rawTool}`
    event.action = identity.name
    event.tool = {
      name: identity.name,
      operation: identity.operation,
      callId: canonicalManualId(sourceCallId, context.callIds),
      arguments: visibleArgs === undefined ? missingFromVisibility(row.visibility) : toolArgumentsFromVisible(identity, visibleArgs),
      result: visibleResult === undefined
        ? status === 'running' ? 'not_applicable' : missingFromVisibility(row.visibility)
        : isMissing(visibleResult) ? visibleResult : normalizeToolResult(visibleResult),
      isError: status === 'failed' || status === 'timed_out' ? true : status === 'succeeded' ? false : 'unknown',
    }
  }
  const artifactIdValues = listValues(row.artifact_ids)
  const rawArtifactId = artifactIdValues.length === 1 ? artifactIdValues[0] : undefined
  const linkedArtifactRows = rawArtifactId ? context.artifactEvidence.get(rawArtifactId) : undefined
  const linkedArtifact = linkedArtifactRows?.length === 1 ? linkedArtifactRows[0] : undefined
  if (mapping.kind === 'artifact' || mapping.kind === 'file' || (mapping.kind === 'operator_action' && linkedArtifact)) {
    const args = recordForToolArgs(visibleArgs)
    const inferredPath = stringField(bodyFields.path) || stringField(args.path)
    const logicalPath = linkedArtifact?.logicalPath || inferredPath
    event.artifact = {
      id: rawArtifactId ? canonicalManualId(rawArtifactId, context.artifactIds) : undefined,
      path: logicalPath ? normalizePath(logicalPath) : 'unknown',
      name: linkedArtifact?.name || stringField(bodyFields.name) || (logicalPath ? basename(logicalPath) : 'unknown'),
      kind: stringField(bodyFields.kind) || 'unknown',
      mime: linkedArtifact?.mime || stringField(bodyFields.mime) || 'unknown',
      bytes: linkedArtifact?.bytes ?? numeric(bodyFields.bytes) ?? 'unknown',
      sha256: linkedArtifact?.sha256 ?? 'unknown',
      operation: mapping.action,
    }
  }
  if (mapping.kind === 'approval') {
    const rawApprovalId = bodyFields.approval_id || row.ui_item_id || `approval:${row.seq}`
    const decision = status === 'approved' ? 'approved' : status === 'denied' ? 'denied' : status === 'expired' ? 'expired' : 'pending'
    event.approval = {
      id: canonicalManualId(rawApprovalId, context.approvalIds),
      decision,
      title: missingAware(row.label),
    }
  }
  if (mapping.kind === 'deployment') {
    const rawArgs = recordForToolArgs(visibleArgs)
    const rawDeploymentId = stringField(bodyFields.project_id) || stringField(bodyFields.deployment_id)
    event.deployment = {
      id: rawDeploymentId ? canonicalManualId(rawDeploymentId, context.deploymentIds) : 'not_visible',
      status,
      url: stringField(bodyFields.visible_url) || stringField(rawArgs.url) || 'not_visible',
      visibility: bodyFields.visibility === 'local' || bodyFields.visibility === 'public' ? bodyFields.visibility : 'not_visible',
      revision: numeric(bodyFields.revision) ?? 'not_visible',
      entryPath: stringField(bodyFields.entry_path) || 'not_visible',
      contentHash: stringField(bodyFields.content_hash) || 'not_visible',
      fileCount: numeric(bodyFields.file_count) ?? 'not_visible',
      bytes: numeric(bodyFields.bytes) ?? 'not_visible',
      action: mapping.action,
    }
  }
  if (mapping.kind === 'usage') {
    event.usage = usageFromFields(bodyFields)
  }
  if (Object.keys(bodyFields).length > 0) event.payload = normalizeCanonicalValue(bodyFields)
  return event
}

function arenaEventIdentity(eventType: string, row: ArenaRow): { kind: CanonicalEventKind; action: string } {
  const values: Record<string, { kind: CanonicalEventKind; action: string }> = {
    user_message: { kind: 'message', action: 'submitted' },
    attachment: { kind: 'file', action: 'uploaded' },
    assistant_started: { kind: 'lifecycle', action: 'assistant_started' },
    assistant_awaiting_user: { kind: 'lifecycle', action: 'awaiting_user_input' },
    thought: { kind: 'thought', action: 'thought' },
    progress: { kind: 'thought', action: 'progress' },
    plan: { kind: 'plan', action: normalizeName(row.tool_or_op || 'updated') },
    web_group: { kind: 'tool', action: 'web_group' },
    tool: { kind: 'tool', action: normalizeName(row.tool_or_op || 'unknown') },
    file: { kind: 'file', action: normalizeName(row.tool_or_op || 'changed') },
    artifact: { kind: 'artifact', action: normalizeName(row.tool_or_op || 'created') },
    process: { kind: 'process', action: normalizeName(row.tool_or_op || 'updated') },
    website: { kind: 'website', action: normalizeName(row.tool_or_op || 'updated') },
    deployment: { kind: 'deployment', action: normalizeName(row.tool_or_op || 'deploy') },
    workspace: { kind: 'workspace', action: normalizeName(row.tool_or_op || 'updated') },
    package_install: { kind: 'tool', action: 'package_install' },
    build: { kind: 'tool', action: 'build' },
    final: { kind: 'final', action: 'final_answer' },
    error: { kind: 'error', action: 'error' },
    approval: { kind: 'approval', action: normalizeName(row.tool_or_op || 'required') },
    task_review: { kind: 'lifecycle', action: normalizeName(row.tool_or_op || 'task_review_required') },
    operator_action: { kind: 'operator_action', action: normalizeName(row.tool_or_op || row.label || 'operator_action') },
    connection_lost: { kind: 'lifecycle', action: 'connection_lost' },
    connection_restored: { kind: 'lifecycle', action: 'connection_restored' },
    refresh: { kind: 'operator_action', action: 'refresh' },
    replay: { kind: 'lifecycle', action: 'replay' },
    model_revealed: { kind: 'model', action: 'revealed' },
    vote_recorded: { kind: 'operator_action', action: 'vote' },
    skip_recorded: { kind: 'operator_action', action: 'skip' },
    download: { kind: 'operator_action', action: 'download' },
    export: { kind: 'operator_action', action: 'export' },
    usage: { kind: 'usage', action: 'updated' },
  }
  return values[eventType] || { kind: 'other', action: eventType || 'other' }
}

export function parseArenaMetadataYaml(yaml: string): ParsedArenaMetadata {
  const values = flattenYamlScalars(yaml)
  const sides = new Set<string>()
  for (const path of values.keys()) {
    const usage = path.match(/^post_run\.visible_usage\.([^.]+)\./)
    const outcome = path.match(/^post_run\.final_ui_outcomes\.([^.]+)$/)
    if (usage) sides.add(usage[1])
    if (outcome) sides.add(outcome[1])
  }
  const statuses: Record<string, CanonicalStatus> = {}
  const rawStatuses: Record<string, string> = {}
  const usage: Record<string, CanonicalUsage> = {}
  const models: Record<string, string | MissingValue> = {}
  for (const side of sides) {
    const prefix = `post_run.visible_usage.${side}.`
    const promptTokens = numericOrMissing(values.get(`${prefix}input_tokens`))
    const completionTokens = numericOrMissing(values.get(`${prefix}output_tokens`))
    const cachedTokens = numericOrMissing(values.get(`${prefix}cached_tokens`))
    const modelCalls = numericOrMissing(values.get(`${prefix}model_calls`))
    const toolCalls = numericOrMissing(values.get(`${prefix}tool_calls`))
    const displayedCost = missingAware(values.get(`${prefix}displayed_cost`)) ?? 'unknown'
    const numericCost = typeof displayedCost === 'string' && !isMissing(displayedCost) ? parseDisplayedUsd(displayedCost) : undefined
    usage[side] = canonicalUsageWithProvenance({
      promptTokens: promptTokens ?? 'unknown',
      completionTokens: completionTokens ?? 'unknown',
      totalTokens: typeof promptTokens === 'number' && typeof completionTokens === 'number' ? promptTokens + completionTokens : 'unknown',
      cachedTokens: cachedTokens ?? 'unknown',
      modelCalls: modelCalls ?? 'unknown',
      toolCalls: toolCalls ?? 'unknown',
      estimatedCostUsd: numericCost ?? (isMissing(displayedCost) ? displayedCost : 'unknown'),
      displayedCost,
      durationMs: 'unknown',
    })
    rawStatuses[side] = values.get(`post_run.final_ui_outcomes.${side}`) || 'unknown'
    statuses[side] = canonicalStatus(rawStatuses[side])
    models[side] = missingAware(values.get(`${prefix}model_or_agent_label`)) ?? 'not_visible'
  }
  return {
    schemaVersion: values.get('schema_version'),
    runId: values.get('run_id'),
    taskId: values.get('task_id'),
    taskVersion: missingAware(values.get('task_version')),
    windowSizePx: missingAware(values.get('environment.window_size_px')),
    browserZoomPercent: numericOrMissing(values.get('environment.browser_zoom_percent')),
    captureQuality: missingAware(values.get('post_run.capture_quality')),
    startedAt: missingAware(values.get('environment.started_at')),
    completedAt: missingAware(values.get('environment.ended_at')),
    rawStatuses,
    statuses,
    usage,
    models,
  }
}

function arenaSideOutcome(events: CanonicalEvent[], side: string, metadata?: ParsedArenaMetadata): CanonicalOutcome {
  const selected = events.filter((event) => event.side === side)
  const finalEvent = [...selected].reverse().find((event) => event.kind === 'final')
  const terminal = [...selected].reverse().find((event) => isTerminal(event.status))
  const discoveredArtifacts = selected
    .map((event) => event.artifact?.path)
    .filter((path): path is string => typeof path === 'string' && !isMissing(path))
  const metadataUsage = metadata?.usage[side] ?? metadata?.usage.global
  const durationMs = durationFromVisibleEvents(selected)
  const usage = metadataUsage ? { ...metadataUsage } : unknownUsage()
  if (typeof durationMs === 'number') usage.durationMs = durationMs
  return {
    status: metadata?.statuses[side] ?? metadata?.statuses.global ?? terminal?.status ?? 'unknown',
    finalText: finalEvent?.message ?? missingFromVisibility(finalEvent?.evidence?.visibility),
    artifactPaths: discoveredArtifacts.length > 0 ? [...new Set(discoveredArtifacts)] : 'unknown',
    usage,
  }
}

function aggregateArenaOutcome(sideOutcomes: Record<string, CanonicalOutcome>, metadata?: ParsedArenaMetadata): CanonicalOutcome {
  const sides = Object.keys(sideOutcomes)
  if (sides.length === 1) return structuredClone(sideOutcomes[sides[0]])
  const statuses = [...new Set(Object.values(sideOutcomes).map((outcome) => outcome.status))]
  const artifactPaths = Object.values(sideOutcomes)
    .flatMap((outcome) => Array.isArray(outcome.artifactPaths) ? outcome.artifactPaths : [])
  return {
    status: statuses.length === 1 ? statuses[0] : 'unknown',
    finalText: 'not_applicable',
    artifactPaths: artifactPaths.length > 0 ? [...new Set(artifactPaths)] : 'unknown',
    usage: metadata?.usage.global ?? unknownUsage(),
  }
}

function toolArgumentsFromVisible(identity: ReturnType<typeof canonicalToolName>, value: CanonicalValue | MissingValue): CanonicalValue | MissingValue {
  if (isMissing(value)) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeToolArguments(identity, value as Record<string, unknown>)
  if (typeof value !== 'string') return normalizeCanonicalValue(value)
  const raw: Record<string, unknown> = identity.name === 'shell'
    ? { command: value }
    : identity.name === 'search'
      ? { query: value }
      : identity.name === 'fetch' && /^https?:\/\//i.test(value)
        ? { url: value }
        : ['file_read', 'file_write', 'file_edit', 'attachment_read', 'vision'].includes(identity.name)
          ? { path: value }
          : { value }
  return normalizeToolArguments(identity, raw)
}

function durationFromVisibleEvents(events: CanonicalEvent[]): number | undefined {
  const episodeKeys = new Set(events.map((event) => episodeKey(event)))
  const durations: number[] = []
  for (const key of episodeKeys) {
    const episode = events.filter((event) => episodeKey(event) === key)
    const terminal = [...episode].reverse().find(isAgentEpisodeTerminal)
    const start = episode.find(isAgentEpisodeStart)
    if (!start && !terminal) continue
    if (!start || !terminal || !sameCapturedRecording(start, terminal)) return undefined
    const observedDuration = numericDurationFromEpisode(start, terminal)
    if (observedDuration !== undefined) {
      durations.push(observedDuration)
      continue
    }
    const startTimecode = parseTimecode(start.evidence?.videoTimecode)
    const endTimecode = parseTimecode(terminal.evidence?.videoTimecode)
    if (startTimecode === undefined || endTimecode === undefined || endTimecode < startTimecode) return undefined
    durations.push(endTimecode - startTimecode)
  }
  return durations.length > 0 ? durations.reduce((sum, duration) => sum + duration, 0) : undefined
}

function episodeKey(event: CanonicalEvent): string {
  return `${event.side}\u0000${event.episodeId || event.turnId || 'unknown'}`
}

function isAgentEpisodeStart(event: CanonicalEvent): boolean {
  if (event.actor === 'operator' && event.kind === 'operator_action') {
    return ['send', 'submit', 'submit_custom_response'].includes(event.action)
  }
  return event.kind === 'message' && event.actor === 'user'
}

function isAgentEpisodeTerminal(event: CanonicalEvent): boolean {
  if (event.kind === 'final') return event.phase === 'finalized' && isTerminal(event.status)
  if (event.kind === 'error') return event.phase === 'finalized' && isTerminal(event.status)
  return event.kind === 'lifecycle'
    && event.phase === 'finalized'
    && ['awaiting_user_input', 'assistant_awaiting_user', 'run_completed', 'run_failed', 'run_cancelled', 'run_timed_out'].includes(event.action)
}

function sameCapturedRecording(start: CanonicalEvent, terminal: CanonicalEvent): boolean {
  const startRecording = start.evidence?.recordingId
  const terminalRecording = terminal.evidence?.recordingId
  return typeof startRecording === 'string' && !isMissing(startRecording)
    && typeof terminalRecording === 'string' && !isMissing(terminalRecording)
    && startRecording === terminalRecording
}

function numericDurationFromEpisode(start: CanonicalEvent, terminal: CanonicalEvent): number | undefined {
  const startObserved = typeof start.observedAtMs === 'number' ? start.observedAtMs : undefined
  const terminalObserved = typeof terminal.observedAtMs === 'number' ? terminal.observedAtMs : undefined
  if (startObserved === undefined || terminalObserved === undefined || terminalObserved < startObserved) return undefined
  return terminalObserved - startObserved
}

function parseTimecode(value: string | MissingValue | undefined): number | undefined {
  if (!value || isMissing(value)) return undefined
  const match = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/)
  if (!match) return undefined
  const hours = Number(match[1] || 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const milliseconds = Number((match[4] || '').padEnd(3, '0'))
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds
}

function flattenYamlScalars(yaml: string): Map<string, string> {
  const values = new Map<string, string>()
  const stack: Array<{ indent: number; key: string }> = []
  for (const rawLine of yaml.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#') || rawLine.trimStart().startsWith('- ')) continue
    const match = rawLine.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/)
    if (!match) continue
    const indent = match[1].replace(/\t/g, '  ').length
    while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop()
    const key = match[2]
    const rawValue = stripYamlComment(match[3] || '').trim()
    const path = [...stack.map((item) => item.key), key].join('.')
    if (!rawValue) stack.push({ indent, key })
    else values.set(path, parseYamlScalar(rawValue))
  }
  return values
}

function stripYamlComment(value: string): string {
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if ((character === '"' || character === "'") && (index === 0 || value[index - 1] !== '\\')) quote = quote === character ? '' : quote || character
    if (character === '#' && !quote && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index)
  }
  return value
}

function parseYamlScalar(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try { return JSON.parse(value) as string } catch { return value.slice(1, -1) }
    }
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function numericOrMissing(value: string | undefined): number | MissingValue | undefined {
  if (value && isMissing(value)) return value
  return numeric(value)
}

function parseDisplayedUsd(value: string): number | undefined {
  const match = value.trim().match(/^\$\s*([\d,]+(?:\.\d+)?)$/)
  return match ? Number(match[1].replace(/,/g, '')) : undefined
}

function messageFromBody(body: string, fields: Record<string, string>, row: ArenaRow, kind: CanonicalEventKind): string | MissingValue | undefined {
  if (!['message', 'thought', 'final', 'error', 'context'].includes(kind)) return undefined
  const explicit = fields.content || fields.message || fields.text || fields.body
  if (explicit) return normalizeDynamicText(stripFence(explicit))
  const withoutFields = body.trim()
  if (withoutFields && Object.keys(fields).length === 0) return normalizeDynamicText(stripFence(withoutFields))
  if (kind === 'message' && row.label) return normalizeDynamicText(row.label)
  return missingFromVisibility(row.visibility)
}

function parseEventTable(markdown: string): ArenaRow[] {
  const lines = markdown.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => {
    const cells = splitMarkdownRow(line).map(normalizeColumn)
    return cells[0] === 'seq' && cells.includes('event_type')
  })
  if (headerIndex < 0) return []
  const headers = splitMarkdownRow(lines[headerIndex]).map(normalizeColumn)
  const rows: ArenaRow[] = []
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim().startsWith('|')) {
      if (rows.length > 0) break
      continue
    }
    const cells = splitMarkdownRow(line)
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) continue
    if (!cells[0]?.trim()) continue
    const row: ArenaRow = {}
    headers.forEach((header, cellIndex) => { row[header] = unescapeCell(cells[cellIndex] || '') })
    rows.push(row)
  }
  return rows
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  let escaped = false
  let inCode = false
  for (const char of trimmed) {
    if (escaped) {
      cell += char
      escaped = false
    } else if (char === '\\') {
      cell += char
      escaped = true
    } else if (char === '`') {
      inCode = !inCode
      cell += char
    } else if (char === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell.trim())
  return cells
}

function parseEmbeddedBodies(markdown: string): Map<string, string> {
  const result = new Map<string, string>()
  const pattern = /^###\s+Event\s+([^\s]+)\s*$\n([\s\S]*?)(?=^###\s+Event\s+|^##\s+Inferences|(?![\s\S]))/gm
  for (const match of markdown.matchAll(pattern)) result.set(match[1].trim(), match[2].trim())
  return result
}

function parseBodyFields(body: string): Record<string, string> {
  const result: Record<string, string> = {}
  const keys = [
    'visible_args', 'visible_result', 'displayed_duration', 'group_id', 'path', 'name', 'kind', 'mime', 'bytes',
    'approval_id', 'content', 'message', 'text', 'body', 'input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens',
    'model_calls', 'tool_calls', 'displayed_cost', 'duration_ms', 'project_id', 'deployment_id', 'visible_url',
    'visibility', 'revision', 'entry_path', 'content_hash', 'file_count',
  ]
  const pattern = new RegExp(`(?:^|\\n)(${keys.join('|')})\\s*:\\s*([\\s\\S]*?)(?=\\n(?:${keys.join('|')})\\s*:|$)`, 'g')
  for (const match of body.matchAll(pattern)) result[match[1]] = stripFence(match[2].trim())
  return result
}

function parseLegacyToolBody(body: string): LegacyToolBody {
  const sections = new Map<string, string[]>()
  const pattern = /(?:^|\n)(COMMAND|STDOUT|STDERR)[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*```[^\r\n]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/g
  for (const match of body.matchAll(pattern)) {
    const key = match[1].toLowerCase()
    const values = sections.get(key) ?? []
    values.push(normalizeDynamicText(match[2]))
    sections.set(key, values)
  }
  const unique = (key: string): string | undefined => {
    const values = sections.get(key)
    return values?.length === 1 ? values[0] : undefined
  }
  return { command: unique('command'), stdout: unique('stdout'), stderr: unique('stderr') }
}

function legacyToolResult(body: LegacyToolBody, row: ArenaRow, phase: CanonicalPhase): CanonicalValue | MissingValue | undefined {
  if (phase !== 'finalized' || (!body.stdout && !body.stderr)) return undefined
  const result: Record<string, unknown> = {}
  if (body.stdout) result.stdout = body.stdout
  if (body.stderr) result.stderr = body.stderr
  const exitCode = explicitExitCode(row.label)
  if (exitCode !== undefined) result.exit_code = exitCode
  return normalizeToolResult(result)
}

function explicitExitCode(label: string | undefined): number | undefined {
  const match = label?.match(/(?:^|[\s·])exit\s+(-?\d+)(?=$|[\s·])/i)
  return match ? numeric(match[1]) : undefined
}

export function parseArenaArtifactsCsv(csv: string): Map<string, ArenaArtifactEvidence[]> {
  const rows = parseCsv(csv)
  if (rows.length === 0) return new Map()
  const headers = rows[0].map((value) => normalizeName(value))
  const result = new Map<string, ArenaArtifactEvidence[]>()
  for (const cells of rows.slice(1)) {
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index]?.trim() ?? '']))
    const artifactId = row.artifact_id
    if (!artifactId || isMissing(artifactId)) continue
    const uiName = stringField(row.ui_name)
    const sha256 = /^[0-9a-f]{64}$/i.test(row.sha256 || '') ? row.sha256.toLowerCase() : undefined
    const evidence: ArenaArtifactEvidence = {
      artifactId,
      logicalPath: uiName,
      name: uiName ? basename(uiName) : undefined,
      mime: stringField(row.ui_type),
      bytes: numeric(row.bytes),
      sha256,
    }
    const values = result.get(artifactId) ?? []
    values.push(evidence)
    result.set(artifactId, values)
  }
  return result
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') quoted = false
      else field += character
    } else if (character === '"') quoted = true
    else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && csv[index + 1] === '\n') index += 1
      row.push(field)
      if (row.some((value) => value.length > 0)) rows.push(row)
      row = []
      field = ''
    } else field += character
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    if (row.some((value) => value.length > 0)) rows.push(row)
  }
  return rows
}

function isKnownLegacyTaskReview(context: RowContext, eventType: string): boolean {
  const allowlist = new Set([
    'A01-20260828T013159+0800:8',
    'A02-20260828T021058+0800:31',
  ])
  if (!allowlist.has(`${context.traceId}:${context.sourceSeq}`)) return false
  if (eventType !== 'other' || normalizeName(context.row.actor || '') !== 'system_ui' || context.row.label.trim() !== '此任务成功了吗？') return false
  return ['是', '否', '继续工作'].every((choice) => new RegExp(`^\\s*-\\s*${choice}\\s*$`, 'm').test(context.body))
}

function fieldValue(value: string | undefined): CanonicalValue | MissingValue | undefined {
  if (!value) return undefined
  const trimmed = stripFence(value.trim())
  if (isMissing(trimmed)) return trimmed
  try {
    return normalizeCanonicalValue(JSON.parse(trimmed))
  } catch {
    return normalizeDynamicText(trimmed)
  }
}

function recordForToolArgs(value: CanonicalValue | MissingValue | undefined): Record<string, unknown> {
  if (!value || isMissing(value) || Array.isArray(value) || typeof value !== 'object') return {}
  return value as Record<string, unknown>
}

function canonicalActor(value: string | undefined): CanonicalActor {
  const actor = normalizeName(value || 'system')
  if (['user', 'assistant', 'tool', 'operator', 'system_ui', 'system'].includes(actor)) return actor as CanonicalActor
  return 'system'
}

function canonicalPhase(value: string | undefined): CanonicalPhase {
  const phase = normalizeName(value || 'unknown')
  if (['appeared', 'started', 'progress', 'updated', 'completed', 'finalized', 'unknown'].includes(phase)) return phase as CanonicalPhase
  return 'unknown'
}

function canonicalManualId(value: string | undefined, ids: ManualIds, optional = false): string | MissingValue | undefined {
  if (!value) return optional ? undefined : 'unknown'
  if (isMissing(value)) return value
  return ids.get(value)
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s./-]+/g, '_').replace(/^_+|_+$/g, '')
}

function normalizeColumn(value: string): string {
  const column = normalizeName(value.replaceAll('`', ''))
  const aliases: Record<string, string> = {
    execution_episode_id: 'episode',
    parent_episode_id: 'parent',
    segment_id: 'segment',
    recording_id: 'recording',
    supersedes_seq: 'supersedes',
  }
  return aliases[column] || column
}

function unescapeCell(value: string): string {
  return value.trim().replace(/\\\|/g, '|').replace(/^`([\s\S]*)`$/, '$1').trim()
}

function missingAware(value: string | undefined): string | MissingValue | undefined {
  if (!value) return undefined
  return isMissing(value) ? value : normalizeDynamicText(value)
}

function missingFromVisibility(value: string | MissingValue | undefined): MissingValue {
  if (isMissing(value)) return value
  if (value === 'not_visible') return 'not_visible'
  return value ? 'not_captured' : 'unknown'
}

function parseListOrMissing(value: string | undefined): string[] | MissingValue | undefined {
  if (!value) return undefined
  if (isMissing(value)) return value
  return value.split(/[+,]/).map((item) => item.trim()).filter(Boolean)
}

function listValues(value: string | undefined): string[] {
  return value?.split(/[+,]/).map((item) => item.trim()).filter(Boolean) ?? []
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value.replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && !isMissing(value) ? value.trim() : undefined
}

function stripFence(value: string): string {
  return value.replace(/^```(?:json|text|yaml)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim()
}

function isMissing(value: unknown): value is MissingValue {
  return typeof value === 'string' && MISSING.has(value as MissingValue)
}

function isTerminal(status: CanonicalStatus): boolean {
  return ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted', 'input_rejected'].includes(status)
}

function usageFromFields(fields: Record<string, string>): CanonicalUsage {
  return canonicalUsageWithProvenance({
    promptTokens: numeric(fields.input_tokens) ?? missingOrUnknown(fields.input_tokens),
    completionTokens: numeric(fields.output_tokens) ?? missingOrUnknown(fields.output_tokens),
    totalTokens: numeric(fields.total_tokens) ?? missingOrUnknown(fields.total_tokens),
    cachedTokens: numeric(fields.cached_tokens) ?? missingOrUnknown(fields.cached_tokens),
    modelCalls: numeric(fields.model_calls) ?? missingOrUnknown(fields.model_calls),
    toolCalls: numeric(fields.tool_calls) ?? missingOrUnknown(fields.tool_calls),
    displayedCost: fields.displayed_cost ? missingAware(fields.displayed_cost) : 'unknown',
    durationMs: numeric(fields.duration_ms) ?? missingOrUnknown(fields.duration_ms),
  })
}

function missingOrUnknown(value: string | undefined): MissingValue {
  return value && isMissing(value) ? value : 'unknown'
}

function unknownUsage(): CanonicalUsage {
  return canonicalUsageWithProvenance({
    promptTokens: 'unknown',
    completionTokens: 'unknown',
    totalTokens: 'unknown',
    cachedTokens: 'unknown',
    modelCalls: 'unknown',
    toolCalls: 'unknown',
    estimatedCostUsd: 'unknown',
    displayedCost: 'unknown',
    durationMs: 'unknown',
  })
}

class ManualIds {
  private readonly values = new Map<string, string>()

  constructor(private readonly prefix: string) {}

  get(raw: string): string {
    const trimmed = raw.trim()
    if (new RegExp(`^${this.prefix}\\d+$`, 'i').test(trimmed)) return trimmed.toUpperCase()
    const existing = this.values.get(trimmed)
    if (existing) return existing
    const next = `${this.prefix}${String(this.values.size + 1).padStart(2, '0')}`
    this.values.set(trimmed, next)
    return next
  }
}
