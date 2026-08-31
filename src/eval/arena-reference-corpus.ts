import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import type { CanonicalEvent, MissingValue } from '../shared/canonical-trace.js'
import {
  ARENA_PARITY_V2_H_IDS,
  ARENA_PARITY_V2_TASK_IDS,
  ARENA_PARITY_V2_TASK_VERSION,
} from './arena-parity-contract.js'
import { importArenaEventsFile, parseArenaMetadataYaml } from './arena-importer.js'
import { serializeCanonicalTrace, traceFromJsonl } from './trace-io.js'

export const ARENA_REFERENCE_CORPUS_SCHEMA_VERSION = 'anera-arena-reference-corpus/1.1' as const

const RUN_OBSERVATIONS: Record<string, string> = {
  A01: '纯推理、零工具、受约束 Final',
  A02: '文件精确字节、Bash 失败恢复、下载一致',
  A03: '`ask_user` 同会话恢复成功；违反前置零工具约束，且缺少明确实现后验证',
  A04: '纯推理零工具；Close 不新建 episode，刷新后 Review 仍关闭',
  D01: '本地 Preview 成功，但没有 Deploy/Publish surface，公开部署未完成',
  F04: '没有 Approval；Bash `curl POST` 返回 204，Deny 分支不可达',
  L05: '前台 Bash 运行时 Stop generating 取代 Send，没有第二 turn/episode',
  U02: '安装、构建、Process、Website、Restart 成功；用 DOM stub 代替实际 Preview 两次点击',
  U03: '历史/刷新恢复事件、Final、Workspace、Review；Website 行不恢复；Continue working 仅关闭 Review',
}

const FROZEN_TASK_IDS = new Set<string>(ARENA_PARITY_V2_TASK_IDS)
const FROZEN_CAPABILITY_IDS = new Set<string>(ARENA_PARITY_V2_H_IDS)

export interface GenerateArenaReferenceCorpusOptions {
  sourceRoot: string
  outputRoot: string
  generatedAt: string
  currentTaskVersion?: string
}

export interface ArenaReferenceCorpusManifest {
  schemaVersion: typeof ARENA_REFERENCE_CORPUS_SCHEMA_VERSION
  generatedAt: string
  sourceRoot: string
  sourcePolicy: Record<string, unknown>
  scope: Record<string, unknown>
  protocol: Record<string, unknown>
  inventory: Record<string, unknown>
  coverage: Record<string, unknown>
  parityReadiness: Record<string, unknown>
  runs: ArenaReferenceCorpusRun[]
}

export interface ArenaReferenceCorpusRun {
  taskId: string
  taskVersion: string | MissingValue
  runId: string
  captureQuality: string | MissingValue
  taskResult: string
  arenaUiOutcome: string
  eventCount: number
  agentDurationMs: number | MissingValue
  sourceCanonical: boolean
  legacySourceCanonicalSha256?: string
  curatedCanonical: string
  sha256: string
  environment: {
    windowSizePx: string | MissingValue
    browserZoomPercent: number | MissingValue
  }
  capture: { gaps: Array<Record<string, string>> }
  operatorActions: Array<Record<string, unknown>>
  pairedEligibility: {
    eligible: false
    eligibleForCurrentTaskVersion: boolean
    currentTaskVersion: string
    reasonCodes: string[]
    requiredExactMatches: string[]
  }
}

interface SourceRun {
  taskId: string
  runId: string
  root: string
  metadataPath?: string
  eventsPath?: string
  sourceCanonicalPath?: string
}

export function generateArenaReferenceCorpus(options: GenerateArenaReferenceCorpusOptions): ArenaReferenceCorpusManifest {
  const sourceRoot = resolve(options.sourceRoot)
  const outputRoot = resolve(options.outputRoot)
  const currentTaskVersion = options.currentTaskVersion ?? ARENA_PARITY_V2_TASK_VERSION
  if (!existsSync(sourceRoot)) throw new Error(`Arena source root does not exist: ${sourceRoot}`)
  if (!options.generatedAt.trim()) throw new Error('generatedAt must be explicit for deterministic corpus generation')

  const taskDirectories = listDirectories(sourceRoot).filter((name) => /^[A-Z]\d{2}$/.test(name))
  const sourceRuns = taskDirectories.flatMap((taskId) => discoverTaskRuns(sourceRoot, taskId))
  const metadataRuns = sourceRuns.filter((run) => run.metadataPath)
  const includedRuns = metadataRuns.filter((run) => {
    const metadata = readFileSync(run.metadataPath!, 'utf8')
    return topLevelYamlScalar(metadata, 'included_in_dataset') === 'true' && Boolean(run.eventsPath)
  })
  assertUniqueIncludedTasks(includedRuns)
  assertIncludedRunIdentitiesAndOutputUniqueness(includedRuns, outputRoot)

  const taskOrder = new Map<string, number>(ARENA_PARITY_V2_TASK_IDS.map((taskId, index) => [taskId, index]))
  includedRuns.sort((left, right) => (taskOrder.get(left.taskId) ?? Number.MAX_SAFE_INTEGER) - (taskOrder.get(right.taskId) ?? Number.MAX_SAFE_INTEGER)
    || left.runId.localeCompare(right.runId))

  const coverageRows = readCsvObjectsIfPresent(join(sourceRoot, 'coverage_matrix.csv'))
  assertFrozenCapabilityIds(coverageRows)
  const toolRows = readCsvObjectsIfPresent(join(sourceRoot, 'public_tool_opportunity_matrix.csv'))
  const capabilityIds = [...new Set(coverageRows.map((row) => row.capability_id))].sort()
  const publicTools = [...new Set(toolRows.map((row) => row.public_tool).filter(Boolean))].sort()
  const unmappedObservations = includedRuns.reduce((count, run) => {
    const assessment = join(run.root, 'qc/capability_assessment.yaml')
    if (!existsSync(assessment)) return count
    return count + countUnmappedObservations(readFileSync(assessment, 'utf8'))
  }, 0)

  assertCanonicalDirectoryContainsOnly(outputRoot, includedRuns.map((run) => `${run.runId}.jsonl`))
  mkdirSync(join(outputRoot, 'canonical'), { recursive: true })
  const runs: ArenaReferenceCorpusRun[] = []
  for (const sourceRun of includedRuns) {
    const metadataText = readFileSync(sourceRun.metadataPath!, 'utf8')
    const metadata = parseArenaMetadataYaml(metadataText)
    const trace = importArenaEventsFile(sourceRun.eventsPath!, { metadataText })
    const serialized = serializeCanonicalTrace(trace)
    const relativeCanonical = `canonical/${sourceRun.runId}.jsonl`
    writeAtomic(join(outputRoot, relativeCanonical), serialized)
    const taskAssessmentPath = join(sourceRun.root, 'qc/task_assessment.yaml')
    const taskResult = existsSync(taskAssessmentPath)
      ? topLevelYamlScalar(readFileSync(taskAssessmentPath, 'utf8'), 'task_result') || 'unknown'
      : 'unknown'
    const taskVersion = metadata.taskVersion ?? 'unknown'
    const taskVersionMatches = taskVersion === currentTaskVersion
    const sourceCanonical = Boolean(sourceRun.sourceCanonicalPath)
    const operatorActions = trace.events.filter((event) => event.actor === 'operator').map(operatorActionProjection)
    const run: ArenaReferenceCorpusRun = {
      taskId: sourceRun.taskId,
      taskVersion,
      runId: sourceRun.runId,
      captureQuality: metadata.captureQuality ?? 'unknown',
      taskResult,
      arenaUiOutcome: metadata.rawStatuses.global ?? singleValue(metadata.rawStatuses) ?? 'unknown',
      eventCount: trace.events.length,
      agentDurationMs: trace.header.durationMs ?? 'unknown',
      sourceCanonical,
      ...(sourceRun.sourceCanonicalPath ? { legacySourceCanonicalSha256: sha256(readFileSync(sourceRun.sourceCanonicalPath)) } : {}),
      curatedCanonical: relativeCanonical,
      sha256: sha256(serialized),
      environment: {
        windowSizePx: metadata.windowSizePx ?? 'unknown',
        browserZoomPercent: metadata.browserZoomPercent ?? 'unknown',
      },
      capture: { gaps: parseCaptureGaps(metadataText) },
      operatorActions,
      pairedEligibility: {
        eligible: false,
        eligibleForCurrentTaskVersion: taskVersionMatches,
        currentTaskVersion,
        reasonCodes: [...(taskVersionMatches ? [] : ['historical_task_protocol_version']), 'candidate_not_present'],
        requiredExactMatches: ['task_version', 'prompt', 'attachments', 'operator_actions', 'viewport_and_zoom'],
      },
    }
    runs.push(run)
  }

  const structuredTaskIds = runs.map((run) => run.taskId)
  const structuredSet = new Set(structuredTaskIds)
  const taskDirectorySet = new Set(taskDirectories)
  const rawOnlyTaskIds = ARENA_PARITY_V2_TASK_IDS.filter((taskId) => taskDirectorySet.has(taskId) && !structuredSet.has(taskId))
  const missingTaskIds = ARENA_PARITY_V2_TASK_IDS.filter((taskId) => !taskDirectorySet.has(taskId))
  const captureQuality = countValues(runs.map((run) => run.captureQuality))
  const arenaUiOutcomes = countValues(runs.map((run) => run.arenaUiOutcome))
  const taskOracleResults = countValues(runs.map((run) => run.taskResult))
  const manifest: ArenaReferenceCorpusManifest = {
    schemaVersion: ARENA_REFERENCE_CORPUS_SCHEMA_VERSION,
    generatedAt: options.generatedAt,
    sourceRoot,
    sourcePolicy: {
      readOnly: true,
      rawEvidenceCopied: false,
      reason: 'The source contains recordings, screenshots, local paths, and account-visible material. Only evidence-constrained canonical JSONL is curated here.',
    },
    scope: {
      product: 'Arena Agent Mode',
      visualScope: 'desktop',
      mobileExcluded: true,
      expectedTaskCount: ARENA_PARITY_V2_TASK_IDS.length,
    },
    protocol: {
      currentTaskVersion,
      includedTaskVersions: [...new Set(runs.map((run) => run.taskVersion))],
      currentTaskVersionEligibleReferenceRuns: runs.filter((run) => run.pairedEligibility.eligibleForCurrentTaskVersion).length,
      historicalReferenceOnly: runs.some((run) => !run.pairedEligibility.eligibleForCurrentTaskVersion),
      warning: 'A historical v1.x reference must not be paired as a current v2.0 baseline without an exact versioned task protocol match.',
    },
    inventory: {
      taskDirectories: taskDirectories.length,
      runDirectories: sourceRuns.length,
      rawRunDirectories: sourceRuns.length,
      metadataRuns: metadataRuns.length,
      includedMetadataRuns: includedRuns.length,
      invalidMetadataRetries: metadataRuns.length - includedRuns.length,
      rawOnlyRunsWithoutMetadata: sourceRuns.length - metadataRuns.length,
      structuredRuns: runs.length,
      preexistingCanonicalRuns: sourceRuns.filter((run) => run.sourceCanonicalPath).length,
      curatedCanonicalRuns: runs.length,
      totalCanonicalEvents: runs.reduce((sum, run) => sum + run.eventCount, 0),
      captureQuality,
      arenaUiOutcomes,
      taskOracleResults,
    },
    coverage: {
      structuredTaskIds,
      rawOnlyTaskIds,
      missingTaskIds,
      capabilityMatrixRows: coverageRows.length,
      distinctCapabilityIds: capabilityIds,
      distinctCapabilityCount: capabilityIds.length,
      unmappedObservations,
      publicToolOpportunityRows: toolRows.length,
      distinctPublicToolOpportunities: publicTools,
    },
    parityReadiness: {
      historicalReferenceRuns: runs.length,
      currentTaskVersionEligibleReferenceRuns: runs.filter((run) => run.pairedEligibility.eligibleForCurrentTaskVersion).length,
      pairedAneraCandidateRuns: 0,
      eligiblePairedRuns: 0,
      formalParityScoreAvailable: false,
      efficiencyBaselineAvailable: false,
      sameViewportDomPngBaselineAvailable: false,
      reason: 'These are historical protocol references with no exact-version Anera candidates. Arena model-call, token, and cost values are not visible.',
    },
    runs,
  }
  writeAtomic(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeAtomic(join(outputRoot, 'README.md'), renderCorpusReadme(manifest))
  return manifest
}

function discoverTaskRuns(sourceRoot: string, taskId: string): SourceRun[] {
  return listDirectories(join(sourceRoot, taskId)).map((runId) => {
    const root = join(sourceRoot, taskId, runId)
    const metadataPath = join(root, 'metadata.yaml')
    const eventsPath = join(root, 'normalized/events.md')
    const sourceCanonicalPath = join(root, 'normalized/canonical.jsonl')
    return {
      taskId,
      runId,
      root,
      ...(existsSync(metadataPath) ? { metadataPath } : {}),
      ...(existsSync(eventsPath) ? { eventsPath } : {}),
      ...(existsSync(sourceCanonicalPath) ? { sourceCanonicalPath } : {}),
    }
  })
}

function assertUniqueIncludedTasks(runs: SourceRun[]): void {
  const seen = new Set<string>()
  for (const run of runs) {
    if (seen.has(run.taskId)) throw new Error(`Multiple included Arena runs for task ${run.taskId}`)
    seen.add(run.taskId)
  }
}

function assertIncludedRunIdentitiesAndOutputUniqueness(runs: SourceRun[], outputRoot: string): void {
  const outputPaths: string[] = []
  for (const run of runs) {
    const identity = `${run.taskId}/${run.runId}`
    if (!FROZEN_TASK_IDS.has(run.taskId)) {
      throw new Error(`Included Arena run ${identity} uses taskId outside the frozen v2 task set`)
    }

    const metadataText = readFileSync(run.metadataPath!, 'utf8')
    const metadata = parseArenaMetadataYaml(metadataText)
    assertIdentityField(identity, 'metadata task_id', metadata.taskId, run.taskId)
    assertIdentityField(identity, 'metadata run_id', metadata.runId, run.runId)

    const importedTrace = importArenaEventsFile(run.eventsPath!, { metadataText })
    assertCanonicalIdentity(identity, 'imported canonical', importedTrace.header.taskId, importedTrace.header.traceId, run)
    if (run.sourceCanonicalPath) {
      const sourceTrace = traceFromJsonl(readFileSync(run.sourceCanonicalPath, 'utf8'))
      assertCanonicalIdentity(identity, 'source canonical', sourceTrace.header.taskId, sourceTrace.header.traceId, run)
    }
    outputPaths.push(resolve(outputRoot, 'canonical', `${run.runId}.jsonl`))
  }

  const duplicateRunIds = duplicateValues(runs.map((run) => run.runId))
  const duplicateOutputPaths = duplicateValues(outputPaths.map((path) => path.normalize('NFC').toLowerCase()))
  if (duplicateRunIds.length > 0 || duplicateOutputPaths.length > 0) {
    const details = [
      duplicateRunIds.length > 0 ? `runId: ${duplicateRunIds.join(', ')}` : '',
      duplicateOutputPaths.length > 0 ? `canonical output path: ${duplicateOutputPaths.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    throw new Error(`Included Arena runs must have globally unique runIds and canonical output paths (${details})`)
  }
}

function assertCanonicalIdentity(
  identity: string,
  label: string,
  taskId: string | MissingValue | undefined,
  traceId: string,
  run: SourceRun,
): void {
  assertIdentityField(identity, `${label} header.taskId`, taskId, run.taskId)
  assertIdentityField(identity, `${label} header.traceId`, traceId, run.runId)
}

function assertIdentityField(identity: string, field: string, actual: unknown, expected: string): void {
  if (actual !== expected) {
    throw new Error(`Arena run identity mismatch for ${identity}: ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort()
}

function assertFrozenCapabilityIds(rows: Array<Record<string, string>>): void {
  const invalid = [...new Set(rows.map((row) => row.capability_id).filter((id) => !FROZEN_CAPABILITY_IDS.has(id)))].sort()
  if (invalid.length > 0) {
    const labels = invalid.map((id) => id || '<empty>')
    throw new Error(`coverage_matrix.csv contains invalid capability_id values: ${labels.join(', ')}; expected H01-H57`)
  }
}

function countUnmappedObservations(yaml: string): number {
  return yaml.split(/\r?\n/).reduce((count, line) => {
    const match = line.match(/^\s*-\s+id:\s*(.*?)\s*$/)
    if (!match) return count
    const id = parseYamlScalar(stripYamlComment(match[1]))
    return /^UNMAPPED-.+/.test(id) ? count + 1 : count
  }, 0)
}

function assertCanonicalDirectoryContainsOnly(outputRoot: string, expected: string[]): void {
  const canonicalRoot = join(outputRoot, 'canonical')
  if (!existsSync(canonicalRoot)) return
  const actual = readdirSync(canonicalRoot).filter((name) => name.endsWith('.jsonl')).sort()
  const wanted = [...expected].sort()
  const stale = actual.filter((name) => !wanted.includes(name))
  if (stale.length > 0) throw new Error(`Refusing to leave stale curated canonical files: ${stale.join(', ')}`)
}

function operatorActionProjection(event: CanonicalEvent): Record<string, unknown> {
  return {
    seq: event.seq,
    sourceSeq: event.sourceSeq,
    turnId: event.turnId ?? 'unknown',
    action: event.action,
    label: event.label ?? 'unknown',
    status: event.status,
    recordingId: event.evidence?.recordingId ?? 'unknown',
    videoTimecode: event.evidence?.videoTimecode ?? 'unknown',
    observedAtMs: event.observedAtMs ?? 'unknown',
  }
}

function parseCaptureGaps(yaml: string): Array<Record<string, string>> {
  const lines = yaml.split(/\r?\n/)
  const captureIndex = lines.findIndex((line) => /^capture:\s*(?:#.*)?$/.test(line))
  if (captureIndex < 0) return []
  const captureIndent = indentation(lines[captureIndex])
  let gapsIndex = -1
  for (let index = captureIndex + 1; index < lines.length; index += 1) {
    if (!lines[index].trim() || lines[index].trimStart().startsWith('#')) continue
    const indent = indentation(lines[index])
    if (indent <= captureIndent) break
    if (/^gaps:\s*/.test(lines[index].trim())) {
      gapsIndex = index
      break
    }
  }
  if (gapsIndex < 0 || /^gaps:\s*\[\s*\]/.test(lines[gapsIndex].trim())) return []
  const gapsIndent = indentation(lines[gapsIndex])
  const records: Array<Record<string, string>> = []
  let current: Record<string, string> | undefined
  for (let index = gapsIndex + 1; index < lines.length; index += 1) {
    const raw = lines[index]
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    const indent = indentation(raw)
    if (indent <= gapsIndent) break
    const trimmed = raw.trim()
    if (trimmed.startsWith('- ')) {
      if (current) records.push(current)
      current = {}
      parseGapScalar(trimmed.slice(2), current)
    } else if (current) parseGapScalar(trimmed, current)
  }
  if (current) records.push(current)
  return records
}

function parseGapScalar(line: string, target: Record<string, string>): void {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
  if (!match) return
  const aliases: Record<string, string> = {
    gap_id: 'gapId',
    started_at: 'startedAt',
    ended_at: 'endedAt',
    preceding_segment_id: 'precedingSegmentId',
    following_segment_id: 'followingSegmentId',
  }
  target[aliases[match[1]] || match[1]] = parseYamlScalar(match[2])
}

function topLevelYamlScalar(yaml: string, key: string): string | undefined {
  const pattern = new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm')
  const match = yaml.match(pattern)
  return match ? parseYamlScalar(stripYamlComment(match[1])) : undefined
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string } catch { return trimmed.slice(1, -1) }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'")
  return trimmed
}

function stripYamlComment(value: string): string {
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if ((character === '"' || character === "'") && value[index - 1] !== '\\') quote = quote === character ? '' : quote || character
    if (character === '#' && !quote && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index)
  }
  return value
}

function readCsvObjectsIfPresent(path: string): Array<Record<string, string>> {
  if (!existsSync(path)) return []
  const rows = parseCsv(readFileSync(path, 'utf8'))
  if (rows.length === 0) return []
  const headers = rows[0].map((value) => value.replace(/^\uFEFF/, '').trim())
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index]?.trim() ?? ''])))
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
      if (row.some(Boolean)) rows.push(row)
      row = []
      field = ''
    } else field += character
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    if (row.some(Boolean)) rows.push(row)
  }
  return rows
}

function renderCorpusReadme(manifest: ArenaReferenceCorpusManifest): string {
  const inventory = manifest.inventory as Record<string, number | Record<string, number>>
  const coverage = manifest.coverage as Record<string, unknown>
  const protocol = manifest.protocol as Record<string, unknown>
  const rows = manifest.runs.map((run) => `| ${run.taskId} | ${run.taskVersion} | ${run.eventCount} | ${run.agentDurationMs} | ${String(run.captureQuality).replaceAll('_', ' ')} | ${run.taskResult} | ${RUN_OBSERVATIONS[run.taskId] || '结构化历史观察'} |`).join('\n')
  return `# Arena 手工 reference corpus intake

日期：${manifest.generatedAt.slice(0, 10)}
范围：Arena Agent Mode 桌面端；只读接入；移动端排除

## 判定

当前收录 ${manifest.runs.length} 个结构化历史 reference run、${inventory.totalCanonicalEvents} 个 canonical 事件。它们适合校准可观察事件 schema、产品行为和各自历史任务协议下的任务质量，但**不是当前 v${protocol.currentTaskVersion} 的可配对 baseline**：这批任务版本为 ${(protocol.includedTaskVersions as Array<string>).join('、')}，当前版本合格 reference 为 ${protocol.currentTaskVersionEligibleReferenceRuns}。

Curated canonical 由生成器从 \`events.md + metadata.yaml + body refs + artifacts.csv\` 确定性重建。旧的 7 个 source \`canonical.jsonl\` 仅作为历史输入证据；新版输出修正了 Agent 终态时长、A01/A02 Review 类型，并按唯一 artifact ID 融合路径、字节和 SHA，因此不再声称与旧 canonical 逐字节一致。Arena model-call、token 和 cost 均不可见，当前也没有 Anera candidate。

## 数据分层

| 层级 | 数量 | 可用于什么 | 不能用于什么 |
|---|---:|---|---|
| v2.0 冻结任务集 | ${manifest.scope.expectedTaskCount} | 定义当前目标能力面 | 不能由历史 v1.x run 替代 |
| 有任务目录 | ${inventory.taskDirectories} | 定位已有原始采集素材 | 不能视为合格 run |
| run 目录 | ${inventory.runDirectories} | 原始录屏/截图素材索引 | 不能直接进入 trace diff |
| 带 metadata | ${inventory.metadataRuns} | 判断采集有效性 | 其中 ${inventory.invalidMetadataRetries} 个是 invalid retry |
| 历史结构化 run | ${inventory.structuredRuns} | schema、行为、生命周期和历史任务质量 reference | 不能直接与当前 v2.0 candidate 配对 |
| 当前 curated canonical | ${inventory.curatedCanonicalRuns} | 可重复审计 importer 和证据融合 | 尚无 exact-version Anera candidate |

源数据包含录屏、截图、账户可见内容和本地路径。本目录只保留 evidence-constrained canonical 文本，不复制 raw evidence。Canonical 中的 \`evidence.reference\` 仍以原始 run 根目录为解析基准。

## 结构化历史 reference

| 任务 | task version | 事件 | Agent duration ms | capture | 任务 oracle | 关键观察 |
|---|---:|---:|---:|---|---|---|
${rows}

Arena UI outcome 全部是 \`success\`，但独立任务 oracle 为 ${formatCounts(inventory.taskOracleResults as Record<string, number>)}。Terminal success 只表示 Agent 结束，不能代替任务正确性。\`agentDurationMs\` 是同一 side 各 episode 从 Agent start 到 Final/明确终态的 active duration 之和；episode 之间的人类等待，以及 Final 后 Expand、Download、Refresh、Replay 等人工取证不计入。任一 Agent episode 缺 start/terminal，或 start/terminal 跨 recording 不能证明时，整体保持 \`unknown\`。

## 已覆盖与明确缺口

\`coverage_matrix.csv\` 有 ${coverage.capabilityMatrixRows} 行，覆盖 ${coverage.distinctCapabilityCount}/57 个 H 维度：${(coverage.distinctCapabilityIds as string[]).join('、')}。它包含 ${coverage.unmappedObservations} 个尚未关闭的 \`UNMAPPED-001\` 观察。

${(coverage.rawOnlyTaskIds as string[]).length} 个任务已有 raw-only 目录但还没有合格结构化 run，${(coverage.missingTaskIds as string[]).length} 个冻结任务完全没有目录。Raw-only 数据可继续规范化，但本次 intake 不猜测其任务结果或事件。

## 配对规则

1. 这 9 个 v1.x run 只能与相同 \`taskVersion\`、prompt、附件、人工动作、viewport/zoom 的 candidate 做历史配对。
2. 当前 v2.0 parity 必须重新采集 v2.0 Arena reference；不能把“任务 ID 相同”当作协议相同。
3. 单题 diff 前检查 manifest 中的 \`pairedEligibility\`；当前全部因历史版本和 candidate 缺失而 \`eligible=false\`。
4. 只有完整 reference/candidate、任务质量 gate、capability/tool coverage 及同 viewport DOM/PNG 都齐全后，才计算正式 suite。
5. Arena 不可见的 calls/tokens/cost 保持 unavailable，不得用录屏时长或 Anera 数值反推。

机器可读清单见 [\`manifest.json\`](./manifest.json)，canonical 输入见 [\`canonical/\`](./canonical/)。使用显式 source、output 和时间戳运行 \`npm run corpus:arena-reference -- --source-root <arena_manual_runs> --output <report-dir> --generated-at <ISO-8601>\` 可重复生成。
`
}

function formatCounts(values: Record<string, number>): string {
  return Object.entries(values).map(([key, value]) => `${value} ${key}`).join(' / ')
}

function listDirectories(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
}

function countValues(values: Array<string | number>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1
  return counts
}

function singleValue<T>(values: Record<string, T>): T | undefined {
  const unique = [...new Set(Object.values(values))]
  return unique.length === 1 ? unique[0] : undefined
}

function indentation(value: string): number {
  return value.match(/^\s*/)?.[0].replace(/\t/g, '  ').length ?? 0
}

function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, content, 'utf8')
  renameSync(temporary, path)
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
