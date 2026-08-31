import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  CANONICAL_TRACE_VERSION,
  type CanonicalEvent,
  type CanonicalOutcome,
  type CanonicalTrace,
  type CanonicalUsage,
  type MissingValue,
  type TraceSource,
} from '../shared/canonical-trace.js'
import { ARENA_ACTIVE_AGENT_TOOL_NAMES } from './arena-public-contract.js'
import {
  ARENA_PARITY_V2_AF_IDS,
  ARENA_PARITY_V2_AF_TASKS,
  ARENA_PARITY_V2_COVERAGE_STATUSES,
  ARENA_PARITY_V2_H_IDS,
  ARENA_PARITY_V2_H_TASKS,
  ARENA_PARITY_V2_OPERATOR_ACTIONS,
  ARENA_PARITY_V2_TASK_SPECS,
  ARENA_PARITY_V2_TASK_IDS,
  ARENA_PARITY_V2_TASK_VERSION,
  ARENA_PARITY_V2_TOOL_TASKS,
  ARENA_PARITY_V2_VIEWPORT,
  type ArenaParityV2CoverageStatus,
  type ArenaParityV2TaskId,
} from './arena-parity-contract.js'
import { diffCanonicalTraces, type TraceDiffReport } from './trace-diff.js'
import { serializeCanonicalTrace } from './trace-io.js'

export type TaskResult = 'pass' | 'partial' | 'fail' | 'unscorable'
export type CaptureQuality = 'complete' | 'complete_with_declared_gaps' | 'incomplete' | 'invalid' | 'pending'

export interface SuiteQualityAssessment {
  assessmentId?: string
  assessmentSha256?: string
  referenceTaskResult: TaskResult
  candidateTaskResult: TaskResult
  candidateOraclePass: boolean
  candidateConstraintViolations: string[]
  criticalViolations: string[]
}

export interface SuiteViewportEvidence {
  widthPx: number
  heightPx: number
  zoomPercent: number
}

export interface SuiteInputFileEvidence {
  logicalId: string
  bytes: number
  sha256: string
  mimeType: string
}

export interface SuiteOperatorActionEvidence {
  turnId: string
  action: string
  payloadSha256: string
}

export interface SuiteProtocolEvidence {
  taskVersion: string
  taskSpecSha256?: string
  rawEvidenceArtifact?: string
  rawEvidenceSha256?: string
  inputVariantId?: string
  operatorVariantId?: string
  promptSha256: string
  inputFiles: SuiteInputFileEvidence[]
  operatorActions: SuiteOperatorActionEvidence[]
  viewport: SuiteViewportEvidence
}

export interface SuitePairingEvidence {
  reference: SuiteProtocolEvidence
  candidate: SuiteProtocolEvidence
}

export interface SuiteRunDefinition {
  taskId: string
  reference: string
  candidate: string
  referenceSha256?: string
  candidateSha256?: string
  referenceSide?: string
  candidateSide?: string
  captureQuality?: CaptureQuality
  unmappedCount?: number
  quality?: SuiteQualityAssessment
  pairing?: SuitePairingEvidence
}

export interface SuiteCoverageEvidence {
  rows: SuiteCoverageEvidenceRow[]
  unmapped: SuiteUnmappedEvidence[]
}

export interface SuiteCoverageEvidenceRow {
  dimension: 'af' | 'h' | 'active_tool'
  id: string
  taskId: string
  runId: string
  status: ArenaParityV2CoverageStatus
  evidenceSha256: string
}

export interface SuiteUnmappedEvidence {
  id: string
  taskId: string
  runId: string
  evidenceSha256: string
}

export interface SuiteVisualEvidence {
  report: string
  reportId: string
  reportSha256: string
}

export interface SuiteManifestV1 {
  schemaVersion: 'anera-eval-suite/1.0'
  baselineVersion: 'observable-parity-v1'
  expectedTaskCount?: number
  visualScope?: 'desktop'
  visualBaselinePassed?: boolean
  runs: SuiteRunDefinition[]
}

export interface SuiteManifestV2 {
  schemaVersion: 'anera-eval-suite/2.0'
  baselineVersion: 'observable-parity-v2'
  expectedTaskCount: 65
  visualScope: 'desktop'
  visualBaselinePassed: true
  visualEvidence: SuiteVisualEvidence
  coverage: SuiteCoverageEvidence
  runs: SuiteRunDefinition[]
}

export type SuiteManifest = SuiteManifestV1 | SuiteManifestV2

export interface LoadedSuiteRun {
  definition: SuiteRunDefinition
  referenceTrace: CanonicalTrace
  candidateTrace: CanonicalTrace
  referencePath?: string
  candidatePath?: string
  referenceEvidenceManifestPath?: string
  candidateEvidenceManifestPath?: string
  referenceEvidencePath?: string
  candidateEvidencePath?: string
  referenceEvidenceSha256?: string
  candidateEvidenceSha256?: string
}

export interface LoadedSuiteExternalEvidence {
  visualReportManifestPath: string
  visualReportPath: string
  visualReportSha256: string
  visualReport: unknown
}

export interface SuiteGate {
  id: string
  category: 'evidence' | 'quality' | 'safety_lifecycle' | 'behavior' | 'efficiency' | 'visual'
  passed: boolean
  observed: string
  required: string
}

export interface DistributionSummary {
  count: number
  mean: number | null
  min: number | null
  p10: number | null
  median: number | null
  p90: number | null
  max: number | null
}

export interface SuiteRunSummary {
  taskId: string
  referenceSide?: string
  candidateSide?: string
  behaviorFidelity: number
  efficiencyFidelity: number | null
  overallFidelity: number
  tools: number | null
  states: number | null
  outcome: number | null
  efficiencyRatios: Partial<Record<keyof CanonicalUsage, number>>
  quality?: SuiteQualityAssessment
  captureQuality?: CaptureQuality
  unmappedCount?: number
  pairing?: SuitePairingAssessment
}

export interface SuitePairingAssessment {
  passed: boolean
  reasonCodes: string[]
}

export interface EfficiencyAggregate {
  metric: 'durationMs' | 'modelCalls' | 'toolCalls' | 'totalTokens' | 'estimatedCostUsd'
  distribution: DistributionSummary
  expectedPairs: number
  medianBudget: number
  p90Budget: number
  passed: boolean
}

export interface SuiteReport {
  schemaVersion: 'anera-eval-suite-report/1.0' | 'anera-eval-suite-report/2.0'
  baselineVersion: 'observable-parity-v1' | 'observable-parity-v2'
  passed: boolean
  expectedTaskCount: number
  observedTaskCount: number
  gates: SuiteGate[]
  aggregates: {
    behavior: DistributionSummary
    overall: DistributionSummary
    tools: DistributionSummary
    states: DistributionSummary
    efficiency: EfficiencyAggregate[]
  }
  runs: SuiteRunSummary[]
  notes: string[]
}

export interface SuiteEvaluation {
  report: SuiteReport
  diffs: Map<string, TraceDiffReport>
}

const EFFICIENCY_BUDGETS: Record<EfficiencyAggregate['metric'], { median: number; p90: number }> = {
  durationMs: { median: 1.25, p90: 1.50 },
  modelCalls: { median: 1.20, p90: 1.50 },
  toolCalls: { median: 1.20, p90: 1.50 },
  totalTokens: { median: 1.20, p90: 1.50 },
  estimatedCostUsd: { median: 1.20, p90: 1.50 },
}

export function evaluateTraceSuite(
  manifest: SuiteManifest,
  loadedRuns: LoadedSuiteRun[],
  externalEvidence?: LoadedSuiteExternalEvidence,
): SuiteEvaluation {
  const isV2 = assertSupportedManifest(manifest)
  if (!Array.isArray(manifest.runs)) throw new Error('Suite manifest runs must be an array')
  if (!Array.isArray(loadedRuns)) throw new Error('Loaded suite runs must be an array')
  if (isV2) assertV2ManifestRuntime(manifest)
  const expectedTaskCount = isV2 ? ARENA_PARITY_V2_TASK_IDS.length : manifest.expectedTaskCount ?? 40
  const configuredIds = manifest.runs.map((run) => run.taskId)
  const loadedIds = loadedRuns.map((run) => run?.definition?.taskId)
  const duplicateLoadedIds = duplicates(loadedIds)
  if (duplicateLoadedIds.length > 0) throw new Error(`Duplicate task IDs in loaded suite: ${duplicateLoadedIds.join(', ')}`)
  const loadedById = new Map(loadedRuns.map((run) => [run.definition.taskId, run]))
  const duplicateIds = configuredIds.filter((taskId, index) => configuredIds.indexOf(taskId) !== index)
  if (duplicateIds.length > 0) throw new Error(`Duplicate task IDs in suite manifest: ${[...new Set(duplicateIds)].join(', ')}`)
  for (const definition of manifest.runs) {
    if (!loadedById.has(definition.taskId)) throw new Error(`Loaded trace pair is missing task ${definition.taskId}`)
  }
  if (isV2) assertV2LoadedSuite(manifest, loadedRuns, externalEvidence)

  const diffs = new Map<string, TraceDiffReport>()
  const runs: SuiteRunSummary[] = []
  for (const definition of manifest.runs) {
    const loaded = loadedById.get(definition.taskId)!
    const diff = diffCanonicalTraces(loaded.referenceTrace, loaded.candidateTrace, {
      referenceSide: definition.referenceSide,
      candidateSide: definition.candidateSide,
    })
    diffs.set(definition.taskId, diff)
    const efficiencyRatios: SuiteRunSummary['efficiencyRatios'] = {}
    for (const item of diff.efficiency) if (item.ratio !== null) efficiencyRatios[item.metric] = item.ratio
    const pairing = isV2 ? assessV2Pairing(definition.taskId as ArenaParityV2TaskId, definition.pairing, loaded) : undefined
    runs.push({
      taskId: definition.taskId,
      referenceSide: definition.referenceSide,
      candidateSide: definition.candidateSide,
      behaviorFidelity: diff.scores.behaviorFidelity,
      efficiencyFidelity: diff.scores.efficiencyFidelity,
      overallFidelity: diff.scores.overallFidelity,
      tools: diff.scores.components.tools.score,
      states: diff.scores.components.states.score,
      outcome: diff.scores.components.outcome.score,
      efficiencyRatios,
      quality: definition.quality,
      captureQuality: definition.captureQuality,
      unmappedCount: definition.unmappedCount,
      ...(pairing ? { pairing } : {}),
    })
  }

  const behavior = distribution(runs.map((run) => run.behaviorFidelity))
  const overall = distribution(runs.map((run) => run.overallFidelity))
  const tools = distribution(runs.map((run) => run.tools).filter((value): value is number => value !== null))
  const states = distribution(runs.map((run) => run.states).filter((value): value is number => value !== null))
  const efficiency = (Object.keys(EFFICIENCY_BUDGETS) as EfficiencyAggregate['metric'][]).map((metric) => {
    const values = runs.map((run) => run.efficiencyRatios[metric]).filter((value): value is number => typeof value === 'number')
    const summary = distribution(values)
    const budget = EFFICIENCY_BUDGETS[metric]
    return {
      metric,
      distribution: summary,
      expectedPairs: manifest.runs.length,
      medianBudget: budget.median,
      p90Budget: budget.p90,
      passed: summary.count === manifest.runs.length && summary.median !== null && summary.p90 !== null && summary.median <= budget.median && summary.p90 <= budget.p90,
    }
  })

  const completeCaptures = runs.filter((run) => run.captureQuality === 'complete' || run.captureQuality === 'complete_with_declared_gaps').length
  const mappedRuns = runs.filter((run) => run.unmappedCount === 0).length
  const qualityComplete = runs.filter((run) => Boolean(run.quality)).length
  const noDowngrades = runs.filter((run) => run.quality && qualityRank(run.quality.candidateTaskResult) >= qualityRank(run.quality.referenceTaskResult)).length
  const oraclePasses = runs.filter((run) => run.quality?.candidateOraclePass === true).length
  const constraintClean = runs.filter((run) => run.quality?.candidateConstraintViolations.length === 0).length
  const criticalClean = runs.filter((run) => run.quality?.criticalViolations.length === 0).length
  const pairingComplete = runs.filter((run) => run.pairing?.passed === true).length
  const v2TaskSetMatches = isV2 && exactStringSet(configuredIds, ARENA_PARITY_V2_TASK_IDS)
  const v2Coverage = isV2 ? assessV2Coverage(manifest.coverage, loadedById) : undefined
  const v2Visual = isV2 ? assessV2VisualEvidence(manifest, externalEvidence) : undefined
  const v2Gates: SuiteGate[] = isV2 ? [
    gate(
      'v2_semantic_provenance',
      'evidence',
      false,
      'not implemented; manifest/raw/quality/coverage/visual semantics remain evidence-producer assertions',
      'structured run bundles, independently derived quality/coverage, recomputed visual gates, and trusted capture provenance',
    ),
    gate('v2_task_set', 'evidence', v2TaskSetMatches, summarizeSet(configuredIds), `${ARENA_PARITY_V2_TASK_IDS.length} exact frozen v2 task IDs`),
    gate('v2_trace_identity', 'evidence', true, `${loadedRuns.length} source/task/schema/path/content-bound pairs`, '65 unique Arena references and 65 unique Anera candidates; no reference/candidate reuse'),
    gate('v2_pairing_evidence', 'evidence', pairingComplete === manifest.runs.length, `${pairingComplete}/${manifest.runs.length} exact protocol pairs`, 'every run matches task version, frozen task spec/prompt, attachments, operator actions, raw evidence, and 1440x900@100% viewport'),
    gate('v2_af_coverage', 'evidence', v2Coverage!.af, summarizeSet(v2Coverage!.afIds), `${ARENA_PARITY_V2_AF_IDS.length} mapped, run-bound AF evidence rows`),
    gate('v2_h_coverage', 'evidence', v2Coverage!.h, summarizeSet(v2Coverage!.hIds), `${ARENA_PARITY_V2_H_IDS.length} mapped, run-bound H evidence rows`),
    gate('v2_active_tool_coverage', 'evidence', v2Coverage!.tools, summarizeSet(v2Coverage!.toolIds), `${ARENA_ACTIVE_AGENT_TOOL_NAMES.length} mapped, run-bound active-tool evidence rows`),
    gate('v2_suite_unmapped_zero', 'evidence', v2Coverage!.unmapped, String(manifest.coverage.unmapped.length), '0 suite-level UNMAPPED-* evidence rows'),
    gate('v2_visual_evidence', 'visual', v2Visual!.passed, v2Visual!.observed, 'loaded report path, ID, SHA-256, desktop viewport and passed=true all match'),
  ] : []
  const gates: SuiteGate[] = [
    ...v2Gates,
    gate('dataset_size', 'evidence', manifest.runs.length === expectedTaskCount && loadedRuns.length === expectedTaskCount, `${manifest.runs.length} configured / ${loadedRuns.length} loaded`, `${expectedTaskCount} unique paired tasks`),
    gate('capture_quality', 'evidence', completeCaptures === manifest.runs.length, `${completeCaptures}/${manifest.runs.length} complete`, 'all runs complete or complete_with_declared_gaps'),
    gate('unmapped_zero', 'evidence', mappedRuns === manifest.runs.length, `${mappedRuns}/${manifest.runs.length} runs have zero unmapped observations`, 'all runs; UNMAPPED-* = 0'),
    gate('quality_assessments', 'quality', qualityComplete === manifest.runs.length, `${qualityComplete}/${manifest.runs.length} paired assessments`, 'one paired assessment per task'),
    gate('no_task_downgrade', 'quality', noDowngrades === manifest.runs.length, `${noDowngrades}/${manifest.runs.length} not downgraded`, 'candidate task_result >= Arena task_result for every task'),
    gate('candidate_oracles', 'quality', oraclePasses === manifest.runs.length, `${oraclePasses}/${manifest.runs.length} passed`, 'all candidate task oracles pass'),
    gate('constraints', 'safety_lifecycle', constraintClean === manifest.runs.length, `${constraintClean}/${manifest.runs.length} clean`, 'zero candidate constraint violations'),
    gate('critical_violations', 'safety_lifecycle', criticalClean === manifest.runs.length, `${criticalClean}/${manifest.runs.length} clean`, 'zero safety/lifecycle/approval/artifact critical violations'),
    gate('behavior_macro', 'behavior', behavior.mean !== null && behavior.mean >= 0.90, formatScore(behavior.mean), 'macro mean >= 90%'),
    gate('behavior_floor', 'behavior', behavior.min !== null && behavior.min >= 0.75, formatScore(behavior.min), 'every task >= 75%'),
    gate('tools_macro', 'behavior', tools.mean !== null && tools.mean >= 0.90, formatScore(tools.mean), 'available Tools macro mean >= 90%'),
    gate('states_macro', 'behavior', states.mean !== null && states.mean >= 0.90, formatScore(states.mean), 'available States macro mean >= 90%'),
    ...efficiency.map((item) => gate(
      `efficiency_${item.metric}`,
      'efficiency',
      item.passed,
      `${item.distribution.count}/${item.expectedPairs} pairs; median ${formatRatio(item.distribution.median)}, p90 ${formatRatio(item.distribution.p90)}`,
      `all paired; median <= ${item.medianBudget.toFixed(2)}, p90 <= ${item.p90Budget.toFixed(2)}`,
    )),
    gate('visual_scope', 'visual', manifest.visualScope === 'desktop', manifest.visualScope ?? 'not_declared', 'desktop'),
    gate('visual_baseline', 'visual', isV2 ? v2Visual!.passed : manifest.visualScope === 'desktop' && manifest.visualBaselinePassed === true, isV2 ? v2Visual!.observed : String(manifest.visualBaselinePassed ?? 'not_assessed'), 'separate desktop DOM/screenshot/interaction baseline passed'),
  ]
  const notes: string[] = []
  if (manifest.runs.length !== expectedTaskCount) notes.push(`Suite is partial: expected ${expectedTaskCount} tasks, received ${manifest.runs.length}. Scores are diagnostic only.`)
  if (efficiency.some((item) => item.distribution.count < item.expectedPairs)) notes.push('At least one efficiency metric is not visible on both sides for every task; the corresponding release gate remains closed.')
  notes.push('Overall and macro scores never override a failed quality, safety/lifecycle, evidence, efficiency, or visual gate.')
  if (isV2) {
    notes.push('Observable parity v2 structural validation is fail-closed on the exact 65-task set, AF01-AF16, H01-H57, active-tool opportunities, trace identity/uniqueness, and per-run protocol pairing evidence.')
    notes.push('Trust boundary: the CLI hashes files actually loaded from resolved paths, but raw-evidence contents and the visual report producer are external trust roots; structural checks do not authenticate who captured those artifacts or independently recompute their semantic claims.')
    notes.push('The v2 semantic-provenance release gate is intentionally closed; structural scores are diagnostic and cannot produce a formal observable-parity PASS until a structured evidence verifier and trusted capture provenance are implemented.')
  }
  const report: SuiteReport = {
    schemaVersion: isV2 ? 'anera-eval-suite-report/2.0' : 'anera-eval-suite-report/1.0',
    baselineVersion: manifest.baselineVersion,
    passed: gates.every((item) => item.passed),
    expectedTaskCount,
    observedTaskCount: runs.length,
    gates,
    aggregates: { behavior, overall, tools, states, efficiency },
    runs,
    notes,
  }
  return { report, diffs }
}

export function renderSuiteMarkdown(report: SuiteReport): string {
  const lines = [
    '# Observable parity suite report',
    '',
    `Decision: **${report.passed ? 'PASS' : 'FAIL / NOT YET PROVEN'}**`,
    '',
    `Baseline: \`${report.baselineVersion}\`; tasks: ${report.observedTaskCount}/${report.expectedTaskCount}.`,
    '',
    '## Release gates',
    '',
    '| Gate | Category | Result | Observed | Required |',
    '|---|---|---|---|---|',
    ...report.gates.map((item) => `| ${item.id} | ${item.category} | ${item.passed ? 'PASS' : 'FAIL'} | ${escapeTable(item.observed)} | ${escapeTable(item.required)} |`),
    '',
    '## Aggregate fidelity',
    '',
    '| Component | Count | Mean | Min | p10 | Median | p90 | Max |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    distributionRow('Behavior', report.aggregates.behavior),
    distributionRow('Overall', report.aggregates.overall),
    distributionRow('Tools', report.aggregates.tools),
    distributionRow('States', report.aggregates.states),
    '',
    '## Efficiency ratios (candidate / Arena)',
    '',
    '| Metric | Pairs | Median | p90 | Budget median / p90 | Result |',
    '|---|---:|---:|---:|---:|---|',
    ...report.aggregates.efficiency.map((item) => `| ${item.metric} | ${item.distribution.count}/${item.expectedPairs} | ${formatRatio(item.distribution.median)} | ${formatRatio(item.distribution.p90)} | ${item.medianBudget.toFixed(2)} / ${item.p90Budget.toFixed(2)} | ${item.passed ? 'PASS' : 'FAIL'} |`),
    '',
    '## Runs',
    '',
    '| Task | Behavior | Overall | Tools | States | Task result Arena → Anera | Capture | Pairing | Unmapped |',
    '|---|---:|---:|---:|---:|---|---|---|---:|',
    ...report.runs.map((run) => `| ${escapeTable(run.taskId)} | ${formatScore(run.behaviorFidelity)} | ${formatScore(run.overallFidelity)} | ${formatScore(run.tools)} | ${formatScore(run.states)} | ${run.quality ? `${run.quality.referenceTaskResult} → ${run.quality.candidateTaskResult}` : 'not assessed'} | ${run.captureQuality ?? 'not assessed'} | ${formatPairing(run.pairing)} | ${run.unmappedCount ?? 'not assessed'} |`),
    '',
    '## Notes',
    '',
    ...report.notes.map((note) => `- ${note}`),
    '',
  ]
  return lines.join('\n')
}

function assertSupportedManifest(manifest: SuiteManifest): manifest is SuiteManifestV2 {
  const schema = String(manifest.schemaVersion)
  const baseline = String(manifest.baselineVersion)
  if (schema === 'anera-eval-suite/1.0' && baseline === 'observable-parity-v1') return false
  if (schema === 'anera-eval-suite/2.0' && baseline === 'observable-parity-v2') {
    if (manifest.expectedTaskCount !== ARENA_PARITY_V2_TASK_IDS.length) {
      throw new Error(`Observable parity v2 requires expectedTaskCount ${ARENA_PARITY_V2_TASK_IDS.length}`)
    }
    if (!('coverage' in manifest) || !manifest.coverage || typeof manifest.coverage !== 'object') {
      throw new Error('Observable parity v2 requires coverage evidence')
    }
    return true
  }
  if (!['anera-eval-suite/1.0', 'anera-eval-suite/2.0'].includes(schema)) throw new Error(`Unsupported suite schema: ${schema}`)
  throw new Error(`Suite schema ${schema} cannot be combined with baseline ${baseline}`)
}

function assertV2ManifestRuntime(manifest: SuiteManifestV2): void {
  if (manifest.visualScope !== 'desktop' || manifest.visualBaselinePassed !== true) {
    throw new Error('Observable parity v2 requires a passed desktop visual baseline')
  }
  if (!isRecord(manifest.visualEvidence)
    || !nonEmptyString(manifest.visualEvidence.report)
    || !nonEmptyString(manifest.visualEvidence.reportId)
    || !validSha256(manifest.visualEvidence.reportSha256)) {
    throw new Error('Observable parity v2 visualEvidence must contain report, reportId, and a lowercase SHA-256')
  }
  if (!isRecord(manifest.coverage) || !Array.isArray(manifest.coverage.rows) || !Array.isArray(manifest.coverage.unmapped)) {
    throw new Error('Observable parity v2 coverage rows and unmapped must be real arrays')
  }
  for (const [index, row] of manifest.coverage.rows.entries()) assertCoverageRow(row, `coverage.rows[${index}]`)
  for (const [index, row] of manifest.coverage.unmapped.entries()) {
    if (!isRecord(row)
      || !nonEmptyString(row.id)
      || !nonEmptyString(row.taskId)
      || !nonEmptyString(row.runId)
      || !validSha256(row.evidenceSha256)) {
      throw new Error(`coverage.unmapped[${index}] is invalid`)
    }
  }
  const assessmentIds: string[] = []
  for (const [index, run] of manifest.runs.entries()) {
    if (!isRecord(run) || !nonEmptyString(run.taskId) || !nonEmptyString(run.reference) || !nonEmptyString(run.candidate)) {
      throw new Error(`runs[${index}] must contain taskId, reference, and candidate strings`)
    }
    if (run.reference === run.candidate) throw new Error(`Task ${run.taskId} cannot use the same reference and candidate trace artifact`)
    if (run.referenceSide !== undefined || run.candidateSide !== undefined) {
      throw new Error(`Task ${run.taskId} cannot select alternate sides in observable parity v2; both traces must use the global outcome`)
    }
    if (!validSha256(run.referenceSha256) || !validSha256(run.candidateSha256)) {
      throw new Error(`Task ${run.taskId} must lock both canonical traces with SHA-256`)
    }
    if (!['complete', 'complete_with_declared_gaps', 'incomplete', 'invalid', 'pending'].includes(String(run.captureQuality))) {
      throw new Error(`Task ${run.taskId} has an invalid captureQuality`)
    }
    if (!Number.isInteger(run.unmappedCount) || Number(run.unmappedCount) < 0) {
      throw new Error(`Task ${run.taskId} must declare a non-negative integer unmappedCount`)
    }
    assertV2Quality(run.taskId, run.quality)
    assessmentIds.push(run.quality!.assessmentId!)
    assertV2ProtocolShape(run.taskId, 'reference', run.pairing?.reference)
    assertV2ProtocolShape(run.taskId, 'candidate', run.pairing?.candidate)
  }
  const duplicateAssessmentIds = duplicates(assessmentIds)
  if (duplicateAssessmentIds.length > 0) {
    throw new Error(`Duplicate v2 quality assessment IDs: ${duplicateAssessmentIds.join(', ')}`)
  }
}

function assertV2Quality(taskId: string, quality: SuiteQualityAssessment | undefined): void {
  if (!isRecord(quality)) throw new Error(`Task ${taskId} is missing its quality assessment`)
  const taskResults = new Set<TaskResult>(['pass', 'partial', 'fail', 'unscorable'])
  if (!taskResults.has(quality.referenceTaskResult) || !taskResults.has(quality.candidateTaskResult)) {
    throw new Error(`Task ${taskId} has an invalid quality task result`)
  }
  if (quality.referenceTaskResult === 'unscorable' || quality.candidateTaskResult === 'unscorable') {
    throw new Error(`Task ${taskId} cannot use unscorable in observable parity v2`)
  }
  if (typeof quality.candidateOraclePass !== 'boolean') throw new Error(`Task ${taskId} candidateOraclePass must be boolean`)
  if (quality.candidateOraclePass && quality.candidateTaskResult !== 'pass') {
    throw new Error(`Task ${taskId} candidateOraclePass=true contradicts candidateTaskResult`)
  }
  if (!strictStringArray(quality.candidateConstraintViolations) || !strictStringArray(quality.criticalViolations)) {
    throw new Error(`Task ${taskId} quality violation fields must be arrays of non-empty strings`)
  }
  if (!nonEmptyString(quality.assessmentId) || !validSha256(quality.assessmentSha256)) {
    throw new Error(`Task ${taskId} quality assessment must contain assessmentId and assessmentSha256`)
  }
}

function assertV2ProtocolShape(taskId: string, side: 'reference' | 'candidate', protocol: SuiteProtocolEvidence | undefined): void {
  if (!isRecord(protocol)) throw new Error(`Task ${taskId} is missing ${side} pairing evidence`)
  if (!nonEmptyString(protocol.taskVersion)
    || !validSha256(protocol.taskSpecSha256)
    || !nonEmptyString(protocol.rawEvidenceArtifact)
    || !validSha256(protocol.rawEvidenceSha256)
    || !nonEmptyString(protocol.inputVariantId)
    || !nonEmptyString(protocol.operatorVariantId)
    || !validSha256(protocol.promptSha256)
    || !Array.isArray(protocol.inputFiles)
    || !Array.isArray(protocol.operatorActions)
    || !isRecord(protocol.viewport)) {
    throw new Error(`Task ${taskId} ${side} pairing evidence is malformed`)
  }
}

function assertV2LoadedSuite(
  manifest: SuiteManifestV2,
  loadedRuns: LoadedSuiteRun[],
  _externalEvidence: LoadedSuiteExternalEvidence | undefined,
): void {
  if (loadedRuns.length !== manifest.runs.length) {
    throw new Error(`Observable parity v2 loaded run count must equal manifest run count (${manifest.runs.length})`)
  }
  const manifestById = new Map(manifest.runs.map((run) => [run.taskId, run]))
  const referencePaths: string[] = []
  const candidatePaths: string[] = []
  const referenceTraceIds: string[] = []
  const candidateTraceIds: string[] = []
  const referenceTraceDigests: string[] = []
  const candidateTraceDigests: string[] = []
  const referenceEvidencePaths: string[] = []
  const candidateEvidencePaths: string[] = []
  const referenceEvidenceDigests: string[] = []
  const candidateEvidenceDigests: string[] = []

  for (const loaded of loadedRuns) {
    if (!isRecord(loaded) || !isRecord(loaded.definition) || !nonEmptyString(loaded.definition.taskId)) {
      throw new Error('Observable parity v2 loaded run is malformed')
    }
    const taskId = loaded.definition.taskId
    const definition = manifestById.get(taskId)
    if (!definition) throw new Error(`Loaded suite contains task not present in manifest: ${taskId}`)
    if (loaded.definition.reference !== definition.reference || loaded.definition.candidate !== definition.candidate) {
      throw new Error(`Loaded paths do not match the manifest for task ${taskId}`)
    }
    assertAbsoluteArtifactPath(loaded.referencePath, `${taskId} reference trace`)
    assertAbsoluteArtifactPath(loaded.candidatePath, `${taskId} candidate trace`)
    assertAbsoluteArtifactPath(loaded.referenceEvidencePath, `${taskId} reference raw evidence`)
    assertAbsoluteArtifactPath(loaded.candidateEvidencePath, `${taskId} candidate raw evidence`)
    if (loaded.referencePath === loaded.candidatePath) throw new Error(`Task ${taskId} reuses one resolved trace path for both sides`)
    if (loaded.referenceEvidencePath === loaded.candidateEvidencePath) throw new Error(`Task ${taskId} reuses one raw-evidence artifact for both sides`)

    assertCanonicalTrace(loaded.referenceTrace, { taskId, source: 'arena' })
    assertCanonicalTrace(loaded.candidateTrace, { taskId, source: 'anera' })
    if (!exactStringSet(loaded.referenceTrace.header.sides, ['global'])
      || !exactStringSet(loaded.candidateTrace.header.sides, ['global'])
      || loaded.referenceTrace.sideOutcomes !== undefined
      || loaded.candidateTrace.sideOutcomes !== undefined) {
      throw new Error(`Task ${taskId} observable parity v2 traces must contain only the top-level global outcome`)
    }
    const referenceDigest = canonicalTraceSha256(loaded.referenceTrace)
    const candidateDigest = canonicalTraceSha256(loaded.candidateTrace)
    if (definition.referenceSha256 !== referenceDigest) throw new Error(`Task ${taskId} reference canonical SHA-256 does not match the manifest`)
    if (definition.candidateSha256 !== candidateDigest) throw new Error(`Task ${taskId} candidate canonical SHA-256 does not match the manifest`)
    if (referenceDigest === candidateDigest) throw new Error(`Task ${taskId} reference and candidate canonical traces are identical`)

    const referenceProtocol = definition.pairing!.reference
    const candidateProtocol = definition.pairing!.candidate
    if (loaded.referenceEvidenceManifestPath !== referenceProtocol.rawEvidenceArtifact
      || loaded.candidateEvidenceManifestPath !== candidateProtocol.rawEvidenceArtifact) {
      throw new Error(`Task ${taskId} loaded raw-evidence paths do not match the manifest`)
    }
    if (!validSha256(loaded.referenceEvidenceSha256) || !validSha256(loaded.candidateEvidenceSha256)) {
      throw new Error(`Task ${taskId} raw-evidence artifacts were not hashed by the loader`)
    }
    if (referenceProtocol.rawEvidenceSha256 !== loaded.referenceEvidenceSha256
      || candidateProtocol.rawEvidenceSha256 !== loaded.candidateEvidenceSha256) {
      throw new Error(`Task ${taskId} raw-evidence SHA-256 does not match the loaded artifact`)
    }
    if (loaded.referenceEvidenceSha256 === loaded.candidateEvidenceSha256) {
      throw new Error(`Task ${taskId} reference and candidate raw evidence are identical`)
    }
    if (definition.quality!.assessmentSha256 !== loaded.candidateEvidenceSha256) {
      throw new Error(`Task ${taskId} quality assessment is not bound to its loaded candidate evidence`)
    }

    referencePaths.push(loaded.referencePath!)
    candidatePaths.push(loaded.candidatePath!)
    referenceTraceIds.push(loaded.referenceTrace.header.traceId)
    candidateTraceIds.push(loaded.candidateTrace.header.traceId)
    referenceTraceDigests.push(referenceDigest)
    candidateTraceDigests.push(candidateDigest)
    referenceEvidencePaths.push(loaded.referenceEvidencePath!)
    candidateEvidencePaths.push(loaded.candidateEvidencePath!)
    referenceEvidenceDigests.push(loaded.referenceEvidenceSha256!)
    candidateEvidenceDigests.push(loaded.candidateEvidenceSha256!)
  }

  assertNoDuplicates('reference trace paths', referencePaths)
  assertNoDuplicates('candidate trace paths', candidatePaths)
  assertNoDuplicates('trace paths across both sides', [...referencePaths, ...candidatePaths])
  assertNoDuplicates('reference trace IDs', referenceTraceIds)
  assertNoDuplicates('candidate trace IDs', candidateTraceIds)
  assertNoDuplicates('trace IDs across both sides', [...referenceTraceIds, ...candidateTraceIds])
  assertNoDuplicates('reference canonical trace content', referenceTraceDigests)
  assertNoDuplicates('candidate canonical trace content', candidateTraceDigests)
  assertNoDuplicates('canonical trace content across both sides', [...referenceTraceDigests, ...candidateTraceDigests])
  assertNoDuplicates('reference raw-evidence paths', referenceEvidencePaths)
  assertNoDuplicates('candidate raw-evidence paths', candidateEvidencePaths)
  assertNoDuplicates('raw-evidence paths across both sides', [...referenceEvidencePaths, ...candidateEvidencePaths])
  assertNoDuplicates('reference raw-evidence content', referenceEvidenceDigests)
  assertNoDuplicates('candidate raw-evidence content', candidateEvidenceDigests)
  assertNoDuplicates('raw-evidence content across both sides', [...referenceEvidenceDigests, ...candidateEvidenceDigests])
}

function assessV2Pairing(
  taskId: ArenaParityV2TaskId,
  pairing: SuitePairingEvidence | undefined,
  loaded: LoadedSuiteRun,
): SuitePairingAssessment {
  if (!pairing?.reference || !pairing.candidate) return { passed: false, reasonCodes: ['pairing_evidence_missing'] }
  const reasons = new Set<string>()
  const spec = ARENA_PARITY_V2_TASK_SPECS[taskId]
  if (!spec) return { passed: false, reasonCodes: ['task_not_frozen'] }
  const reference = pairing.reference
  const candidate = pairing.candidate
  if (reference.taskVersion !== ARENA_PARITY_V2_TASK_VERSION || candidate.taskVersion !== ARENA_PARITY_V2_TASK_VERSION) reasons.add('task_version_mismatch')
  if (reference.taskSpecSha256 !== spec.taskSpecSha256 || candidate.taskSpecSha256 !== spec.taskSpecSha256) reasons.add('task_spec_not_frozen')
  if (reference.promptSha256 !== spec.promptSha256 || candidate.promptSha256 !== spec.promptSha256) reasons.add('prompt_not_frozen')
  if (reference.promptSha256 !== candidate.promptSha256) reasons.add('prompt_mismatch')
  if (reference.taskSpecSha256 !== candidate.taskSpecSha256) reasons.add('task_spec_mismatch')
  assessInputVariant(spec.inputVariants, reference, candidate, reasons)
  assessOperatorVariant(spec.operatorVariants, reference, candidate, reasons)
  if (!fixedV2Viewport(reference.viewport) || !fixedV2Viewport(candidate.viewport)) reasons.add('viewport_or_zoom_mismatch')
  if (reference.rawEvidenceArtifact !== loaded.referenceEvidenceManifestPath
    || candidate.rawEvidenceArtifact !== loaded.candidateEvidenceManifestPath
    || reference.rawEvidenceSha256 !== loaded.referenceEvidenceSha256
    || candidate.rawEvidenceSha256 !== loaded.candidateEvidenceSha256) reasons.add('raw_evidence_not_loaded')
  if (reference.rawEvidenceArtifact === candidate.rawEvidenceArtifact || reference.rawEvidenceSha256 === candidate.rawEvidenceSha256) reasons.add('raw_evidence_reused')
  return { passed: reasons.size === 0, reasonCodes: [...reasons] }
}

function assessInputVariant(
  variants: readonly { id: string; files: readonly SuiteInputFileEvidence[] }[],
  reference: SuiteProtocolEvidence,
  candidate: SuiteProtocolEvidence,
  reasons: Set<string>,
): void {
  if (reference.inputVariantId !== candidate.inputVariantId) reasons.add('input_variant_mismatch')
  const variant = variants.find((item) => item.id === reference.inputVariantId)
  if (!variant) reasons.add('input_variant_not_frozen')
  if (!validInputFiles(reference.inputFiles) || !validInputFiles(candidate.inputFiles)) reasons.add('attachment_evidence_invalid')
  else {
    if (canonicalInputFiles(reference.inputFiles) !== canonicalInputFiles(candidate.inputFiles)) reasons.add('attachments_mismatch')
    if (variant && canonicalInputFiles(reference.inputFiles) !== canonicalInputFiles([...variant.files])) reasons.add('attachments_not_frozen')
  }
}

function assessOperatorVariant(
  variants: readonly { id: string; requiredActions: readonly string[] }[],
  reference: SuiteProtocolEvidence,
  candidate: SuiteProtocolEvidence,
  reasons: Set<string>,
): void {
  if (reference.operatorVariantId !== candidate.operatorVariantId) reasons.add('operator_variant_mismatch')
  const variant = variants.find((item) => item.id === reference.operatorVariantId)
  if (!variant) reasons.add('operator_variant_not_frozen')
  if (!validOperatorActions(reference.operatorActions) || !validOperatorActions(candidate.operatorActions)) reasons.add('operator_action_evidence_invalid')
  else {
    if (canonicalOperatorActions(reference.operatorActions) !== canonicalOperatorActions(candidate.operatorActions)) reasons.add('operator_actions_mismatch')
    if (variant && (!orderedSubsequence(variant.requiredActions, reference.operatorActions.map((item) => item.action))
      || !orderedSubsequence(variant.requiredActions, candidate.operatorActions.map((item) => item.action)))) {
      reasons.add('required_operator_actions_missing')
    }
  }
}

function validInputFiles(files: SuiteInputFileEvidence[]): boolean {
  if (!Array.isArray(files)) return false
  const ids = new Set<string>()
  return files.every((file) => {
    if (
      !file
      || typeof file.logicalId !== 'string'
      || !file.logicalId.trim()
      || ids.has(file.logicalId)
      || !Number.isInteger(file.bytes)
      || file.bytes < 0
      || !validSha256(file.sha256)
      || typeof file.mimeType !== 'string'
      || !file.mimeType.trim()
    ) return false
    ids.add(file.logicalId)
    return true
  })
}

function canonicalInputFiles(files: SuiteInputFileEvidence[]): string {
  return JSON.stringify(files.map((file) => ({
    logicalId: file.logicalId,
    bytes: file.bytes,
    sha256: file.sha256,
    mimeType: file.mimeType,
  })))
}

function validOperatorActions(actions: SuiteOperatorActionEvidence[]): boolean {
  return Array.isArray(actions) && actions.every((action) => Boolean(
    action
    && typeof action.turnId === 'string'
    && action.turnId.trim()
    && typeof action.action === 'string'
    && (ARENA_PARITY_V2_OPERATOR_ACTIONS as readonly string[]).includes(action.action)
    && validSha256(action.payloadSha256),
  ))
}

function canonicalOperatorActions(actions: SuiteOperatorActionEvidence[]): string {
  return JSON.stringify(actions.map((action) => ({
    turnId: action.turnId,
    action: action.action,
    payloadSha256: action.payloadSha256,
  })))
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function fixedV2Viewport(viewport: SuiteViewportEvidence): boolean {
  return viewport?.widthPx === ARENA_PARITY_V2_VIEWPORT.widthPx
    && viewport.heightPx === ARENA_PARITY_V2_VIEWPORT.heightPx
    && viewport.zoomPercent === ARENA_PARITY_V2_VIEWPORT.zoomPercent
}

function assessV2Coverage(
  coverage: SuiteCoverageEvidence,
  loadedById: Map<string, LoadedSuiteRun>,
): { af: boolean; h: boolean; tools: boolean; unmapped: boolean; afIds: string[]; hIds: string[]; toolIds: string[] } {
  const validRows = coverage.rows.filter((row) => {
    if (row.status === 'not_captured') return false
    if (row.dimension === 'h' && (row.id === 'H48' || row.id === 'H56')) {
      if (row.taskId !== 'K01' || !['observed_succeeded', 'observed_attempted'].includes(row.status)) return false
    }
    const mappedTasks = row.dimension === 'af'
      ? ARENA_PARITY_V2_AF_TASKS[row.id]
      : row.dimension === 'h'
        ? ARENA_PARITY_V2_H_TASKS[row.id]
        : ARENA_PARITY_V2_TOOL_TASKS[row.id]
    if (!mappedTasks?.includes(row.taskId as ArenaParityV2TaskId)) return false
    const loaded = loadedById.get(row.taskId)
    return Boolean(loaded
      && row.runId === loaded.referenceTrace.header.traceId
      && row.evidenceSha256 === loaded.referenceEvidenceSha256
      && row.evidenceSha256 === loaded.definition.pairing?.reference.rawEvidenceSha256)
  })
  const afIds = validRows.filter((row) => row.dimension === 'af').map((row) => row.id)
  const hIds = validRows.filter((row) => row.dimension === 'h').map((row) => row.id)
  const toolIds = validRows.filter((row) => row.dimension === 'active_tool').map((row) => row.id)
  return {
    af: exactStringSet(afIds, ARENA_PARITY_V2_AF_IDS),
    h: exactStringSet(hIds, ARENA_PARITY_V2_H_IDS),
    tools: exactStringSet(toolIds, ARENA_ACTIVE_AGENT_TOOL_NAMES),
    unmapped: coverage.unmapped.length === 0,
    afIds,
    hIds,
    toolIds,
  }
}

function assessV2VisualEvidence(
  manifest: SuiteManifestV2,
  external: LoadedSuiteExternalEvidence | undefined,
): { passed: boolean; observed: string } {
  if (!external) return { passed: false, observed: 'visual report not loaded' }
  const report = external.visualReport
  const reportRecord = isRecord(report) ? report : undefined
  const viewport = reportRecord && isRecord(reportRecord.viewport) ? reportRecord.viewport : undefined
  const passed = external.visualReportManifestPath === manifest.visualEvidence.report
    && isAbsolute(external.visualReportPath)
    && external.visualReportSha256 === manifest.visualEvidence.reportSha256
    && reportRecord?.reportId === manifest.visualEvidence.reportId
    && reportRecord.passed === true
    && reportRecord.visualScope === 'desktop'
    && viewport?.widthPx === ARENA_PARITY_V2_VIEWPORT.widthPx
    && viewport.heightPx === ARENA_PARITY_V2_VIEWPORT.heightPx
    && viewport.zoomPercent === ARENA_PARITY_V2_VIEWPORT.zoomPercent
  return {
    passed,
    observed: passed
      ? `${String(reportRecord!.reportId)}; desktop 1440x900@100%; loaded SHA matched`
      : 'visual path, ID, SHA, scope, viewport, or passed result did not match',
  }
}

function assertCoverageRow(value: unknown, label: string): asserts value is SuiteCoverageEvidenceRow {
  if (!isRecord(value)
    || !['af', 'h', 'active_tool'].includes(String(value.dimension))
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.taskId)
    || !nonEmptyString(value.runId)
    || !(ARENA_PARITY_V2_COVERAGE_STATUSES as readonly string[]).includes(String(value.status))
    || !validSha256(value.evidenceSha256)) {
    throw new Error(`${label} is invalid`)
  }
}

function assertAbsoluteArtifactPath(value: unknown, label: string): asserts value is string {
  if (!nonEmptyString(value) || !isAbsolute(value)) throw new Error(`${label} must be a resolved absolute path loaded from disk`)
}

function assertNoDuplicates(label: string, values: readonly string[]): void {
  const repeated = duplicates(values)
  if (repeated.length > 0) throw new Error(`Duplicate ${label}: ${repeated.join(', ')}`)
}

function duplicates(values: readonly unknown[]): string[] {
  const seen = new Set<unknown>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) repeated.add(String(value))
    seen.add(value)
  }
  return [...repeated]
}

function canonicalTraceSha256(trace: CanonicalTrace): string {
  return createHash('sha256').update(serializeCanonicalTrace(trace)).digest('hex')
}

const MISSING_VALUES = new Set<MissingValue>(['not_visible', 'not_captured', 'unknown', 'not_applicable'])
const CANONICAL_ACTORS = new Set(['user', 'assistant', 'tool', 'operator', 'system_ui', 'system'])
const CANONICAL_KINDS = new Set([
  'session', 'message', 'thought', 'plan', 'tool', 'file', 'artifact', 'process', 'website', 'deployment',
  'workspace', 'approval', 'usage', 'context', 'lifecycle', 'final', 'error', 'model', 'operator_action', 'other',
])
const CANONICAL_PHASES = new Set(['appeared', 'started', 'progress', 'updated', 'completed', 'finalized', 'unknown'])
const CANONICAL_STATUSES = new Set([
  'idle', 'queued', 'starting', 'running', 'asleep', 'cancelling', 'stopped', 'exited', 'awaiting_approval',
  'awaiting_user_input', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted', 'input_rejected',
  'approved', 'denied', 'expired', ...MISSING_VALUES,
])
const CANONICAL_ESTIMATED_COST_STATUSES = new Set([
  'not_incurred', 'estimated', 'partial', ...MISSING_VALUES,
])

function assertCanonicalTrace(trace: unknown, expected: { taskId: string; source: TraceSource }): asserts trace is CanonicalTrace {
  const label = `${expected.taskId} ${expected.source}`
  if (!isRecord(trace) || !isRecord(trace.header) || !Array.isArray(trace.events) || !isRecord(trace.outcome)) {
    throw new Error(`${label} canonical trace must contain header, events, and outcome`)
  }
  const header = trace.header
  if (header.schemaVersion !== CANONICAL_TRACE_VERSION) throw new Error(`${label} canonical header schemaVersion is invalid`)
  if (header.source !== expected.source) throw new Error(`${label} canonical header source is invalid`)
  if (!nonEmptyString(header.traceId)) throw new Error(`${label} canonical traceId is missing`)
  if (header.taskId !== expected.taskId) throw new Error(`${label} canonical taskId does not match the frozen task`)
  if (!Number.isInteger(header.eventCount) || header.eventCount !== trace.events.length) throw new Error(`${label} canonical eventCount is invalid`)
  if (!strictStringArray(header.sides) || header.sides.length === 0 || new Set(header.sides).size !== header.sides.length) {
    throw new Error(`${label} canonical sides are invalid`)
  }
  if (!optionalMissingOrString(header.model)
    || !optionalMissingOrString(header.startedAt)
    || !optionalMissingOrString(header.completedAt)
    || !optionalMissingOrNonNegative(header.durationMs)) {
    throw new Error(`${label} canonical header optional fields are invalid`)
  }
  if (header.productMode !== undefined && !['chat', 'coding', ...MISSING_VALUES].includes(String(header.productMode))) {
    throw new Error(`${label} canonical productMode is invalid`)
  }

  for (const [index, event] of trace.events.entries()) {
    assertCanonicalEvent(event, {
      label: `${label} event ${index + 1}`,
      source: expected.source,
      traceId: header.traceId,
      expectedSeq: index + 1,
      sides: header.sides,
    })
  }
  assertCanonicalOutcome(trace.outcome, `${label} outcome`)
  if (trace.sideOutcomes !== undefined) {
    if (!isRecord(trace.sideOutcomes)) throw new Error(`${label} sideOutcomes is invalid`)
    for (const [side, outcome] of Object.entries(trace.sideOutcomes)) {
      if (!header.sides.includes(side)) throw new Error(`${label} sideOutcomes contains an undeclared side`)
      assertCanonicalOutcome(outcome, `${label} side outcome ${side}`)
    }
  }
}

function assertCanonicalEvent(
  event: unknown,
  expected: { label: string; source: TraceSource; traceId: string; expectedSeq: number; sides: string[] },
): asserts event is CanonicalEvent {
  if (!isRecord(event)) throw new Error(`${expected.label} is not an object`)
  if (event.schemaVersion !== CANONICAL_TRACE_VERSION
    || event.source !== expected.source
    || event.traceId !== expected.traceId
    || event.seq !== expected.expectedSeq) {
    throw new Error(`${expected.label} schema/source/traceId/seq identity is invalid`)
  }
  if (!((Number.isInteger(event.sourceSeq) && Number(event.sourceSeq) >= 0) || nonEmptyString(event.sourceSeq))) {
    throw new Error(`${expected.label} sourceSeq is invalid`)
  }
  if (!nonEmptyString(event.side) || !expected.sides.includes(event.side)) throw new Error(`${expected.label} side is invalid`)
  if (!CANONICAL_ACTORS.has(String(event.actor))
    || !CANONICAL_KINDS.has(String(event.kind))
    || !nonEmptyString(event.action)
    || !CANONICAL_PHASES.has(String(event.phase))
    || !CANONICAL_STATUSES.has(String(event.status))) {
    throw new Error(`${expected.label} actor/kind/action/phase/status is invalid`)
  }
  if (!optionalMissingOrString(event.timestamp) || !optionalMissingOrNonNegative(event.observedAtMs)) {
    throw new Error(`${expected.label} timing evidence is invalid`)
  }
  for (const key of ['turnId', 'episodeId', 'parentEpisodeId', 'stepId', 'label', 'message'] as const) {
    if (!optionalMissingOrString(event[key])) throw new Error(`${expected.label} ${key} is invalid`)
  }
  if (event.usage !== undefined) assertCanonicalUsage(event.usage, `${expected.label} usage`)
  if (event.tool !== undefined && (!isRecord(event.tool) || !nonEmptyString(event.tool.name))) throw new Error(`${expected.label} tool is invalid`)
  if (event.artifact !== undefined) {
    if (!isRecord(event.artifact)
      || !optionalMissingOrNonNegative(event.artifact.bytes)
      || (event.artifact.sha256 !== undefined && !MISSING_VALUES.has(event.artifact.sha256 as MissingValue) && !validSha256(event.artifact.sha256))) {
      throw new Error(`${expected.label} artifact is invalid`)
    }
  }
  if (event.process !== undefined) {
    if (!isRecord(event.process)
      || !optionalMissingOrNonNegative(event.process.pid)
      || !optionalMissingOrNonNegative(event.process.port)
      || !optionalMissingOrNonNegative(event.process.exitCode, true)) throw new Error(`${expected.label} process is invalid`)
  }
  if (event.website !== undefined && (!isRecord(event.website)
    || !optionalMissingOrNonNegative(event.website.port)
    || !optionalMissingOrNonNegative(event.website.restartCount))) throw new Error(`${expected.label} website is invalid`)
  if (event.deployment !== undefined && (!isRecord(event.deployment)
    || !optionalMissingOrNonNegative(event.deployment.revision)
    || !optionalMissingOrNonNegative(event.deployment.fileCount)
    || !optionalMissingOrNonNegative(event.deployment.bytes))) throw new Error(`${expected.label} deployment is invalid`)
}

function assertCanonicalOutcome(value: unknown, label: string): asserts value is CanonicalOutcome {
  if (!isRecord(value) || !CANONICAL_STATUSES.has(String(value.status))) throw new Error(`${label} status is invalid`)
  if (!(nonEmptyString(value.finalText) || value.finalText === '' || MISSING_VALUES.has(value.finalText as MissingValue))) {
    throw new Error(`${label} finalText is invalid`)
  }
  if (!(Array.isArray(value.artifactPaths) && value.artifactPaths.every((item) => typeof item === 'string'))
    && !MISSING_VALUES.has(value.artifactPaths as MissingValue)) throw new Error(`${label} artifactPaths is invalid`)
  assertCanonicalUsage(value.usage, `${label} usage`)
}

function assertCanonicalUsage(value: unknown, label: string): asserts value is CanonicalUsage {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'modelRequests', 'modelCalls', 'toolCalls', 'estimatedCostUsd', 'durationMs'] as const) {
    if (!optionalMissingOrNonNegative(value[key])) throw new Error(`${label}.${key} is invalid`)
  }
  if (value.estimatedCostStatus !== undefined && !CANONICAL_ESTIMATED_COST_STATUSES.has(value.estimatedCostStatus)) {
    throw new Error(`${label}.estimatedCostStatus is invalid`)
  }
  if (!optionalMissingOrString(value.displayedCost)) throw new Error(`${label}.displayedCost is invalid`)
}

function optionalMissingOrString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function optionalMissingOrNonNegative(value: unknown, allowNull = false): boolean {
  return value === undefined
    || (allowNull && value === null)
    || MISSING_VALUES.has(value as MissingValue)
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function orderedSubsequence(required: readonly string[], actual: readonly string[]): boolean {
  let index = 0
  for (const action of actual) if (action === required[index]) index += 1
  return index === required.length
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function strictStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString)
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === actual.length
    && expected.every((value) => actual.includes(value))
}

function summarizeSet(values: readonly string[]): string {
  return `${new Set(values).size} unique / ${values.length} entries`
}

function formatPairing(pairing: SuitePairingAssessment | undefined): string {
  if (!pairing) return 'not required'
  return pairing.passed ? 'exact' : `FAIL: ${pairing.reasonCodes.join(', ')}`
}

function gate(id: string, category: SuiteGate['category'], passed: boolean, observed: string, required: string): SuiteGate {
  return { id, category, passed, observed, required }
}

function qualityRank(result: TaskResult): number {
  return { unscorable: -1, fail: 0, partial: 1, pass: 2 }[result]
}

function distribution(values: number[]): DistributionSummary {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length === 0) return { count: 0, mean: null, min: null, p10: null, median: null, p90: null, max: null }
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    min: sorted[0],
    p10: percentile(sorted, 0.10),
    median: percentile(sorted, 0.50),
    p90: percentile(sorted, 0.90),
    max: sorted.at(-1)!,
  }
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * quantile
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  const fraction = position - lower
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction
}

function distributionRow(label: string, value: DistributionSummary): string {
  return `| ${label} | ${value.count} | ${formatScore(value.mean)} | ${formatScore(value.min)} | ${formatScore(value.p10)} | ${formatScore(value.median)} | ${formatScore(value.p90)} | ${formatScore(value.max)} |`
}

function formatScore(value: number | null): string {
  return value === null ? 'unavailable' : `${(value * 100).toFixed(1)}%`
}

function formatRatio(value: number | null): string {
  return value === null ? 'unavailable' : value.toFixed(3)
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
