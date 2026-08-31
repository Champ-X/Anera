import type {
  CanonicalEvent,
  CanonicalEventKind,
  CanonicalStatus,
  CanonicalTrace,
  CanonicalUsage,
  CanonicalValue,
  MissingValue,
} from '../shared/canonical-trace.js'

export interface TraceDiffOptions {
  referenceSide?: string
  candidateSide?: string
}

export interface EventMismatch {
  field: string
  reference: unknown
  candidate: unknown
}

export interface AlignmentEntry {
  operation: 'match' | 'substitute' | 'insert' | 'delete'
  referenceSeq?: number
  candidateSeq?: number
  similarity: number
  mismatches: EventMismatch[]
}

export interface ScoreComponent {
  score: number | null
  available: boolean
  compared: number
  weight: number
}

export interface EfficiencyComparison {
  metric: keyof CanonicalUsage
  reference: number | MissingValue | null
  candidate: number | MissingValue | null
  ratio: number | null
  fidelity: number | null
}

export interface TraceDiffReport {
  schemaVersion: 'anera-trace-diff/1.0'
  reference: { traceId: string; source: string; side?: string; events: number }
  candidate: { traceId: string; source: string; side?: string; events: number }
  scores: {
    behaviorFidelity: number
    efficiencyFidelity: number | null
    overallFidelity: number
    components: Record<'sequence' | 'tools' | 'states' | 'artifacts' | 'final' | 'outcome', ScoreComponent>
  }
  counts: {
    matches: number
    substitutions: number
    insertions: number
    deletions: number
    referenceTools: number
    candidateTools: number
  }
  efficiency: EfficiencyComparison[]
  alignment: AlignmentEntry[]
  notes: string[]
}

const GAP_COST = 0.9

export function diffCanonicalTraces(referenceInput: CanonicalTrace, candidateInput: CanonicalTrace, options: TraceDiffOptions = {}): TraceDiffReport {
  const reference = options.referenceSide ? selectTraceSide(referenceInput, options.referenceSide) : referenceInput
  const candidate = options.candidateSide ? selectTraceSide(candidateInput, options.candidateSide) : candidateInput
  const aligned = alignEvents(reference.events, candidate.events)
  const components = {
    sequence: sequenceComponent(aligned, reference.events.length, candidate.events.length),
    tools: typedAlignmentComponent(aligned, reference.events, candidate.events, new Set(['tool']), toolPairScore, 0.24),
    states: typedAlignmentComponent(
      aligned,
      reference.events,
      candidate.events,
      new Set<CanonicalEventKind>(['lifecycle', 'approval', 'process', 'website', 'deployment', 'error', 'operator_action']),
      statePairScore,
      0.18,
    ),
    artifacts: artifactComponent(reference, candidate),
    final: finalComponent(reference, candidate),
    outcome: outcomeComponent(reference, candidate),
  }
  const behaviorFidelity = weightedComponents(components)
  const efficiency = compareEfficiency(reference.outcome.usage, candidate.outcome.usage)
  const efficiencyScores = efficiency.map((item) => item.fidelity).filter((score): score is number => score !== null)
  const efficiencyFidelity = efficiencyScores.length > 0 ? average(efficiencyScores) : null
  const overallFidelity = efficiencyFidelity === null ? behaviorFidelity : behaviorFidelity * 0.8 + efficiencyFidelity * 0.2
  const notes: string[] = []
  if (efficiencyFidelity === null) notes.push('Efficiency fidelity is unavailable because no metric is numeric on both traces.')
  if (reference.header.sides.length > 1 && !options.referenceSide) notes.push('Reference contains multiple sides; pass --reference-side to compare one Arena side with one candidate run.')
  if (candidate.header.sides.length > 1 && !options.candidateSide) notes.push('Candidate contains multiple sides; pass --candidate-side to select one side.')
  for (const [name, component] of Object.entries(components)) {
    if (!component.available) notes.push(`${name} was excluded from weighted behavior fidelity because the required visible evidence is unavailable.`)
  }

  return {
    schemaVersion: 'anera-trace-diff/1.0',
    reference: {
      traceId: reference.header.traceId,
      source: reference.header.source,
      side: options.referenceSide,
      events: reference.events.length,
    },
    candidate: {
      traceId: candidate.header.traceId,
      source: candidate.header.source,
      side: options.candidateSide,
      events: candidate.events.length,
    },
    scores: {
      behaviorFidelity,
      efficiencyFidelity,
      overallFidelity,
      components,
    },
    counts: {
      matches: aligned.filter((item) => item.operation === 'match').length,
      substitutions: aligned.filter((item) => item.operation === 'substitute').length,
      insertions: aligned.filter((item) => item.operation === 'insert').length,
      deletions: aligned.filter((item) => item.operation === 'delete').length,
      referenceTools: reference.events.filter((event) => event.kind === 'tool' && event.phase !== 'started').length,
      candidateTools: candidate.events.filter((event) => event.kind === 'tool' && event.phase !== 'started').length,
    },
    efficiency,
    alignment: aligned,
    notes,
  }
}

export function alignEvents(reference: CanonicalEvent[], candidate: CanonicalEvent[]): AlignmentEntry[] {
  const width = candidate.length + 1
  const size = (reference.length + 1) * width
  const costs = new Float64Array(size)
  const directions = new Uint8Array(size) // 1 diagonal, 2 delete, 3 insert
  for (let row = 1; row <= reference.length; row += 1) {
    costs[row * width] = row * GAP_COST
    directions[row * width] = 2
  }
  for (let column = 1; column <= candidate.length; column += 1) {
    costs[column] = column * GAP_COST
    directions[column] = 3
  }
  for (let row = 1; row <= reference.length; row += 1) {
    for (let column = 1; column <= candidate.length; column += 1) {
      const index = row * width + column
      const diagonal = costs[(row - 1) * width + column - 1] + eventDistance(reference[row - 1], candidate[column - 1])
      const deletion = costs[(row - 1) * width + column] + GAP_COST
      const insertion = costs[row * width + column - 1] + GAP_COST
      if (diagonal <= deletion && diagonal <= insertion) {
        costs[index] = diagonal
        directions[index] = 1
      } else if (deletion <= insertion) {
        costs[index] = deletion
        directions[index] = 2
      } else {
        costs[index] = insertion
        directions[index] = 3
      }
    }
  }

  const alignment: AlignmentEntry[] = []
  let row = reference.length
  let column = candidate.length
  while (row > 0 || column > 0) {
    const direction = directions[row * width + column]
    if (direction === 1) {
      const left = reference[row - 1]
      const right = candidate[column - 1]
      const mismatches = compareEventFields(left, right)
      const distance = eventDistance(left, right)
      alignment.push({
        operation: mismatches.length === 0 ? 'match' : 'substitute',
        referenceSeq: left.seq,
        candidateSeq: right.seq,
        similarity: clamp01(1 - distance / (2 * GAP_COST)),
        mismatches,
      })
      row -= 1
      column -= 1
    } else if (direction === 2 || column === 0) {
      alignment.push({
        operation: 'delete',
        referenceSeq: reference[row - 1].seq,
        similarity: 0,
        mismatches: [{ field: 'event', reference: eventSignature(reference[row - 1]), candidate: null }],
      })
      row -= 1
    } else {
      alignment.push({
        operation: 'insert',
        candidateSeq: candidate[column - 1].seq,
        similarity: 0,
        mismatches: [{ field: 'event', reference: null, candidate: eventSignature(candidate[column - 1]) }],
      })
      column -= 1
    }
  }
  return alignment.reverse()
}

export function renderDiffMarkdown(report: TraceDiffReport): string {
  const percent = (value: number | null) => value === null ? 'unavailable' : `${(value * 100).toFixed(1)}%`
  const lines = [
    '# Canonical trace fidelity report',
    '',
    `Reference: \`${report.reference.source}:${report.reference.traceId}\`${report.reference.side ? ` side \`${report.reference.side}\`` : ''} (${report.reference.events} events)`,
    '',
    `Candidate: \`${report.candidate.source}:${report.candidate.traceId}\`${report.candidate.side ? ` side \`${report.candidate.side}\`` : ''} (${report.candidate.events} events)`,
    '',
    '## Scores',
    '',
    '| Metric | Score | Evidence pairs |',
    '|---|---:|---:|',
    `| Overall observable fidelity | ${percent(report.scores.overallFidelity)} | — |`,
    `| Behavior fidelity | ${percent(report.scores.behaviorFidelity)} | — |`,
    `| Efficiency fidelity | ${percent(report.scores.efficiencyFidelity)} | — |`,
    ...Object.entries(report.scores.components).map(([name, component]) => `| ${name} | ${percent(component.score)} | ${component.compared} |`),
    '',
    '## Alignment',
    '',
    `Exact ${report.counts.matches}; substitutions ${report.counts.substitutions}; insertions ${report.counts.insertions}; deletions ${report.counts.deletions}.`,
    '',
    '| Op | Reference | Candidate | Similarity | Mismatches |',
    '|---|---:|---:|---:|---|',
  ]
  const nonMatches = report.alignment.filter((item) => item.operation !== 'match')
  if (nonMatches.length === 0) lines.push('| match | — | — | 100.0% | none |')
  else for (const item of nonMatches.slice(0, 200)) {
    lines.push(`| ${item.operation} | ${item.referenceSeq ?? '—'} | ${item.candidateSeq ?? '—'} | ${percent(item.similarity)} | ${escapeTable(item.mismatches.map((mismatch) => mismatch.field).join(', '))} |`)
  }
  if (nonMatches.length > 200) lines.push(`| … | — | — | — | ${nonMatches.length - 200} additional differences are present in JSON |`)
  lines.push('', '## Efficiency and cost', '', '| Metric | Reference | Candidate | Candidate / reference | Fidelity |', '|---|---:|---:|---:|---:|')
  for (const item of report.efficiency) {
    lines.push(`| ${item.metric} | ${formatMetric(item.reference)} | ${formatMetric(item.candidate)} | ${item.ratio === null ? 'unavailable' : item.ratio.toFixed(3)} | ${percent(item.fidelity)} |`)
  }
  if (report.notes.length > 0) {
    lines.push('', '## Notes', '')
    for (const note of report.notes) lines.push(`- ${note}`)
  }
  lines.push('')
  return lines.join('\n')
}

function eventDistance(reference: CanonicalEvent, candidate: CanonicalEvent): number {
  let distance = 0
  if (reference.kind !== candidate.kind) distance += 0.6
  if (reference.action !== candidate.action) distance += 0.35
  if (reference.actor !== candidate.actor) distance += 0.1
  if (comparable(reference.status, candidate.status) && reference.status !== candidate.status) distance += 0.25
  if (reference.phase !== candidate.phase) distance += 0.1
  if (reference.side !== candidate.side) distance += 0.2
  if (reference.kind === 'tool' && candidate.kind === 'tool') {
    if (reference.tool?.name !== candidate.tool?.name) distance += 0.4
    if ((reference.tool?.operation || '') !== (candidate.tool?.operation || '')) distance += 0.15
  }
  return distance
}

function compareEventFields(reference: CanonicalEvent, candidate: CanonicalEvent): EventMismatch[] {
  const mismatches: EventMismatch[] = []
  compare('kind', reference.kind, candidate.kind, mismatches)
  compare('action', reference.action, candidate.action, mismatches)
  compare('actor', reference.actor, candidate.actor, mismatches)
  compare('phase', reference.phase, candidate.phase, mismatches)
  compare('status', reference.status, candidate.status, mismatches)
  compare('side', reference.side, candidate.side, mismatches)
  if (reference.kind === 'tool' || candidate.kind === 'tool') {
    compare('tool.name', reference.tool?.name, candidate.tool?.name, mismatches)
    compare('tool.operation', reference.tool?.operation, candidate.tool?.operation, mismatches)
    compareSimilarity('tool.arguments', reference.tool?.arguments, candidate.tool?.arguments, mismatches, 0.999)
    compareSimilarity('tool.result', reference.tool?.result, candidate.tool?.result, mismatches, 0.82)
  }
  if (reference.kind === 'final' && candidate.kind === 'final') compareSimilarity('message', reference.message, candidate.message, mismatches, 0.9)
  if ((reference.kind === 'artifact' || reference.kind === 'file') && (candidate.kind === 'artifact' || candidate.kind === 'file')) {
    compare('artifact.path', reference.artifact?.path, candidate.artifact?.path, mismatches)
    compare('artifact.operation', reference.artifact?.operation, candidate.artifact?.operation, mismatches)
  }
  return mismatches
}

function sequenceComponent(alignment: AlignmentEntry[], referenceCount: number, candidateCount: number): ScoreComponent {
  const denominator = Math.max(referenceCount, candidateCount)
  return {
    score: denominator === 0 ? 1 : clamp01(alignment.reduce((sum, item) => sum + item.similarity, 0) / denominator),
    available: true,
    compared: alignment.length,
    weight: 0.28,
  }
}

function typedAlignmentComponent(
  alignment: AlignmentEntry[],
  reference: CanonicalEvent[],
  candidate: CanonicalEvent[],
  kinds: Set<CanonicalEventKind>,
  scorePair: (left: CanonicalEvent, right: CanonicalEvent) => number,
  weight: number,
): ScoreComponent {
  const referenceBySeq = new Map(reference.map((event) => [event.seq, event]))
  const candidateBySeq = new Map(candidate.map((event) => [event.seq, event]))
  const scores: number[] = []
  for (const entry of alignment) {
    const left = entry.referenceSeq === undefined ? undefined : referenceBySeq.get(entry.referenceSeq)
    const right = entry.candidateSeq === undefined ? undefined : candidateBySeq.get(entry.candidateSeq)
    if (!left && !right) continue
    if (!kinds.has(left?.kind as CanonicalEventKind) && !kinds.has(right?.kind as CanonicalEventKind)) continue
    scores.push(left && right && kinds.has(left.kind) && kinds.has(right.kind) ? scorePair(left, right) : 0)
  }
  return { score: scores.length > 0 ? average(scores) : null, available: scores.length > 0, compared: scores.length, weight }
}

function toolPairScore(reference: CanonicalEvent, candidate: CanonicalEvent): number {
  const pairs: Array<[number, number | null]> = [
    [0.38, reference.tool?.name === candidate.tool?.name ? 1 : 0],
    [0.12, (reference.tool?.operation || '') === (candidate.tool?.operation || '') ? 1 : 0],
    [0.18, comparable(reference.status, candidate.status) ? reference.status === candidate.status ? 1 : 0 : null],
    [0.22, valuePairSimilarity(reference.tool?.arguments, candidate.tool?.arguments)],
    [0.10, valuePairSimilarity(reference.tool?.result, candidate.tool?.result)],
  ]
  return weightedPairs(pairs)
}

function statePairScore(reference: CanonicalEvent, candidate: CanonicalEvent): number {
  return weightedPairs([
    [0.30, reference.kind === candidate.kind ? 1 : 0],
    [0.25, reference.action === candidate.action ? 1 : 0],
    [0.35, comparable(reference.status, candidate.status) ? reference.status === candidate.status ? 1 : 0 : null],
    [0.10, reference.side === candidate.side ? 1 : 0],
  ])
}

function artifactComponent(reference: CanonicalTrace, candidate: CanonicalTrace): ScoreComponent {
  const left = artifactSet(reference)
  const right = artifactSet(candidate)
  if (!left.available || !right.available) return { score: null, available: false, compared: 0, weight: 0.12 }
  const union = new Set([...left.paths, ...right.paths])
  const intersection = [...left.paths].filter((path) => right.paths.has(path)).length
  return { score: union.size === 0 ? 1 : intersection / union.size, available: true, compared: union.size, weight: 0.12 }
}

function finalComponent(reference: CanonicalTrace, candidate: CanonicalTrace): ScoreComponent {
  const left = reference.outcome.finalText
  const right = candidate.outcome.finalText
  if (!comparable(left, right)) return { score: null, available: false, compared: 0, weight: 0.12 }
  return { score: textSimilarity(String(left), String(right)), available: true, compared: 1, weight: 0.12 }
}

function outcomeComponent(reference: CanonicalTrace, candidate: CanonicalTrace): ScoreComponent {
  const left = reference.outcome.status
  const right = candidate.outcome.status
  if (!comparable(left, right)) return { score: null, available: false, compared: 0, weight: 0.06 }
  return { score: left === right ? 1 : 0, available: true, compared: 1, weight: 0.06 }
}

function artifactSet(trace: CanonicalTrace): { available: boolean; paths: Set<string> } {
  if (Array.isArray(trace.outcome.artifactPaths)) return { available: true, paths: new Set(trace.outcome.artifactPaths) }
  const eventPaths = trace.events.map((event) => event.artifact?.path).filter((path): path is string => typeof path === 'string' && !isMissing(path))
  return { available: eventPaths.length > 0, paths: new Set(eventPaths) }
}

function compareEfficiency(reference: CanonicalUsage, candidate: CanonicalUsage): EfficiencyComparison[] {
  const metrics: Array<keyof CanonicalUsage> = ['durationMs', 'modelCalls', 'toolCalls', 'totalTokens', 'estimatedCostUsd']
  return metrics.map((metric) => {
    const left = numericMetric(reference[metric])
    const right = numericMetric(candidate[metric])
    const ratio = left !== null && right !== null && left !== 0 ? right / left : left === 0 && right === 0 ? 1 : null
    const fidelity = ratio === null ? null : ratio === 0 ? 0 : Math.min(ratio, 1 / ratio)
    return {
      metric,
      reference: metricValue(reference[metric]),
      candidate: metricValue(candidate[metric]),
      ratio,
      fidelity,
    }
  })
}

function selectTraceSide(trace: CanonicalTrace, side: string): CanonicalTrace {
  const selected = trace.events.filter((event) => event.side === side).map((event, index) => ({ ...event, seq: index + 1, side: 'global' }))
  if (selected.length === 0) throw new Error(`Trace ${trace.header.traceId} has no events for side ${side}`)
  const final = [...selected].reverse().find((event) => event.kind === 'final')
  const terminal = [...selected].reverse().find((event) => isTerminalStatus(event.status))
  const paths = selected.map((event) => event.artifact?.path).filter((path): path is string => typeof path === 'string')
  return {
    header: { ...trace.header, eventCount: selected.length, sides: ['global'] },
    events: selected,
    outcome: {
      ...(trace.sideOutcomes?.[side] ?? trace.outcome),
      status: terminal?.status ?? trace.sideOutcomes?.[side]?.status ?? trace.outcome.status,
      finalText: final?.message ?? trace.sideOutcomes?.[side]?.finalText ?? trace.outcome.finalText,
      artifactPaths: paths.length > 0 ? paths : trace.sideOutcomes?.[side]?.artifactPaths ?? trace.outcome.artifactPaths,
    },
  }
}

function eventSignature(event: CanonicalEvent): string {
  return [event.side, event.actor, event.kind, event.action, event.phase, event.status, event.tool?.name, event.tool?.operation].filter(Boolean).join(':')
}

function weightedComponents(components: Record<string, ScoreComponent>): number {
  let sum = 0
  let weight = 0
  for (const component of Object.values(components)) {
    if (!component.available || component.score === null) continue
    sum += component.score * component.weight
    weight += component.weight
  }
  return weight > 0 ? sum / weight : 0
}

function weightedPairs(pairs: Array<[number, number | null]>): number {
  let sum = 0
  let weight = 0
  for (const [pairWeight, score] of pairs) {
    if (score === null) continue
    sum += pairWeight * score
    weight += pairWeight
  }
  return weight > 0 ? sum / weight : 0
}

function valuePairSimilarity(reference: unknown, candidate: unknown): number | null {
  if (!comparable(reference, candidate)) return null
  return valueSimilarity(reference, candidate)
}

function valueSimilarity(reference: unknown, candidate: unknown): number {
  const left = stableValue(reference)
  const right = stableValue(candidate)
  if (left === right) return 1
  return textSimilarity(left, right)
}

function textSimilarity(reference: string, candidate: string): number {
  const left = textFeatures(reference)
  const right = textFeatures(candidate)
  if (left.size === 0 && right.size === 0) return 1
  const union = new Set([...left, ...right])
  let intersection = 0
  for (const feature of left) if (right.has(feature)) intersection += 1
  return union.size === 0 ? 1 : intersection / union.size
}

function textFeatures(value: string): Set<string> {
  const normalized = value.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim()
  const features = new Set<string>()
  for (const word of normalized.match(/[\p{L}\p{N}_./:-]+/gu) || []) features.add(`w:${word}`)
  const compactCjk = [...normalized].filter((character) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character))
  for (let index = 0; index + 1 < compactCjk.length; index += 1) features.add(`c:${compactCjk[index]}${compactCjk[index + 1]}`)
  return features
}

function stableValue(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value ?? '')
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${key}:${stableValue(item)}`).join(',')}}`
}

function compare(field: string, reference: unknown, candidate: unknown, mismatches: EventMismatch[]): void {
  if (!comparable(reference, candidate)) return
  if (stableValue(reference) !== stableValue(candidate)) mismatches.push({ field, reference: compactValue(reference), candidate: compactValue(candidate) })
}

function compareSimilarity(field: string, reference: unknown, candidate: unknown, mismatches: EventMismatch[], threshold: number): void {
  if (!comparable(reference, candidate)) return
  if (valueSimilarity(reference, candidate) < threshold) mismatches.push({ field, reference: compactValue(reference), candidate: compactValue(candidate) })
}

function comparable(reference: unknown, candidate: unknown): boolean {
  return reference !== undefined && candidate !== undefined && !isMissing(reference) && !isMissing(candidate)
}

function isMissing(value: unknown): value is MissingValue {
  return typeof value === 'string' && ['not_visible', 'not_captured', 'unknown', 'not_applicable'].includes(value)
}

function numericMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function metricValue(value: unknown): number | MissingValue | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return isMissing(value) ? value : null
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function compactValue(value: unknown): unknown {
  const text = stableValue(value)
  return text.length <= 500 ? value : `${text.slice(0, 497)}…`
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function formatMetric(value: number | MissingValue | null): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toPrecision(6)
  return value ?? 'unavailable'
}

function isTerminalStatus(status: CanonicalStatus): boolean {
  return ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted', 'input_rejected'].includes(status)
}
