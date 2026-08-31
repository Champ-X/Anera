import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CANONICAL_TRACE_VERSION, type CanonicalEvent, type CanonicalTrace } from '../shared/canonical-trace.js'
import { ARENA_ACTIVE_AGENT_TOOL_NAMES } from './arena-public-contract.js'
import {
  ARENA_PARITY_V2_AF_IDS,
  ARENA_PARITY_V2_AF_TASKS,
  ARENA_PARITY_V2_H_IDS,
  ARENA_PARITY_V2_H_TASKS,
  ARENA_PARITY_V2_PROMPT_PROTOCOL_SHA256,
  ARENA_PARITY_V2_TASK_IDS,
  ARENA_PARITY_V2_TASK_SECTION_SHA256,
  ARENA_PARITY_V2_TASK_SPECS,
  ARENA_PARITY_V2_TOOL_TASKS,
  ARENA_PARITY_V2_VIEWPORT,
  type ArenaParityV2TaskId,
} from './arena-parity-contract.js'
import {
  evaluateTraceSuite,
  type LoadedSuiteExternalEvidence,
  type LoadedSuiteRun,
  type SuiteCoverageEvidenceRow,
  type SuiteManifest,
  type SuiteManifestV2,
  type SuiteProtocolEvidence,
  type SuiteRunDefinition,
} from './suite-eval.js'
import { serializeCanonicalTrace } from './trace-io.js'

describe('observable parity suite evaluator', () => {
  it('keeps v1 behavior and hard gates intact', () => {
    const { manifest, loaded } = exactSuiteV1()
    const evaluation = evaluateTraceSuite(manifest, loaded)
    expect(evaluation.report.passed).toBe(true)
    manifest.runs[0].quality!.criticalViolations.push('approval bypassed')
    expect(evaluateTraceSuite(manifest, loaded).report.passed).toBe(false)
  })

  it('passes all structural checks but keeps formal v2 closed without semantic provenance', () => {
    const fixture = exactSuiteV2()
    const report = evaluateV2(fixture)
    expect(report).toMatchObject({
      schemaVersion: 'anera-eval-suite-report/2.0',
      baselineVersion: 'observable-parity-v2',
      passed: false,
      expectedTaskCount: 65,
      observedTaskCount: 65,
    })
    expect(report.gates.filter((gate) => gate.id !== 'v2_semantic_provenance').every((gate) => gate.passed)).toBe(true)
    expect(report.gates.find((gate) => gate.id === 'v2_semantic_provenance')).toMatchObject({ passed: false })
    expect(report.notes.some((note) => note.startsWith('Trust boundary:'))).toBe(true)
  })

  it('rejects reused traces, paths, trace IDs, canonical content, and raw evidence', () => {
    for (const mutate of [
      (fixture: V2Fixture) => { fixture.loaded[1].referencePath = fixture.loaded[0].referencePath },
      (fixture: V2Fixture) => { fixture.loaded[1].referenceTrace.header.traceId = fixture.loaded[0].referenceTrace.header.traceId },
      (fixture: V2Fixture) => { fixture.loaded[1].referenceEvidencePath = fixture.loaded[0].referenceEvidencePath },
      (fixture: V2Fixture) => {
        fixture.loaded[1].referenceEvidenceSha256 = fixture.loaded[0].referenceEvidenceSha256
        fixture.manifest.runs[1].pairing!.reference.rawEvidenceSha256 = fixture.loaded[0].referenceEvidenceSha256
      },
    ]) {
      const fixture = exactSuiteV2()
      mutate(fixture)
      expect(() => evaluateV2(fixture)).toThrow(/Duplicate|raw-evidence|canonical|trace/i)
    }
  })

  it('rejects canonical schema, source, task, event identity, and manifest digest mismatches', () => {
    const mutations: Array<(fixture: V2Fixture) => void> = [
      (fixture) => { fixture.loaded[0].referenceTrace.header.schemaVersion = 'wrong' as typeof CANONICAL_TRACE_VERSION },
      (fixture) => { fixture.loaded[0].referenceTrace.header.source = 'anera' },
      (fixture) => { fixture.loaded[0].referenceTrace.header.taskId = 'WRONG' },
      (fixture) => { fixture.loaded[0].referenceTrace.events[0].traceId = 'wrong-event-trace' },
      (fixture) => { fixture.loaded[0].referenceTrace.outcome.usage.modelRequests = -1 },
      (fixture) => { fixture.loaded[0].referenceTrace.outcome.usage.estimatedCostStatus = 'complete' as 'estimated' },
      (fixture) => { fixture.manifest.runs[0].referenceSha256 = 'a'.repeat(64) },
    ]
    for (const mutate of mutations) {
      const fixture = exactSuiteV2()
      mutate(fixture)
      expect(() => evaluateV2(fixture)).toThrow()
    }
  })

  it('rejects alternate or decoy side selection in v2 traces', () => {
    const selected = exactSuiteV2()
    selected.manifest.runs[0].referenceSide = 'decoy'
    selected.manifest.runs[0].candidateSide = 'decoy'
    expect(() => evaluateV2(selected)).toThrow(/cannot select alternate sides/)

    const sideOutcome = exactSuiteV2()
    sideOutcome.loaded[0].referenceTrace.sideOutcomes = { global: sideOutcome.loaded[0].referenceTrace.outcome }
    expect(() => evaluateV2(sideOutcome)).toThrow(/only the top-level global outcome/)
  })

  it('does not accept arbitrary equal task/prompt hashes, variants, attachments, or actions', () => {
    const digest = 'b'.repeat(64)
    const cases: Array<(run: SuiteRunDefinition) => void> = [
      (run) => {
        run.pairing!.reference.promptSha256 = digest
        run.pairing!.candidate.promptSha256 = digest
      },
      (run) => {
        run.pairing!.reference.taskSpecSha256 = digest
        run.pairing!.candidate.taskSpecSha256 = digest
      },
      (run) => {
        run.pairing!.reference.inputVariantId = 'invented'
        run.pairing!.candidate.inputVariantId = 'invented'
      },
      (run) => {
        run.pairing!.reference.operatorVariantId = 'invented'
        run.pairing!.candidate.operatorVariantId = 'invented'
      },
    ]
    for (const mutate of cases) {
      const fixture = exactSuiteV2()
      mutate(fixture.manifest.runs[0])
      expect(evaluateV2(fixture).passed).toBe(false)
    }

    const ingress = exactSuiteV2()
    const index = ARENA_PARITY_V2_TASK_IDS.indexOf('F01')
    ingress.manifest.runs[index].pairing!.reference.operatorActions = [operatorAction('message_submit', 0)]
    ingress.manifest.runs[index].pairing!.candidate.operatorActions = [operatorAction('message_submit', 0)]
    expect(evaluateV2(ingress).runs[index].pairing?.reasonCodes).toContain('required_operator_actions_missing')
  })

  it('binds each declared raw-evidence path and hash to what the CLI loaded', () => {
    const fixture = exactSuiteV2()
    fixture.loaded[0].referenceEvidenceSha256 = sha256('different bytes')
    expect(() => evaluateV2(fixture)).toThrow(/raw-evidence SHA-256/)

    const pathFixture = exactSuiteV2()
    pathFixture.loaded[0].candidateEvidenceManifestPath = 'evidence/not-the-manifest-artifact.json'
    expect(() => evaluateV2(pathFixture)).toThrow(/paths do not match/)
  })

  it('requires real strict quality arrays, unique assessment IDs, and score consistency', () => {
    const fakeArray = exactSuiteV2()
    fakeArray.manifest.runs[0].quality!.criticalViolations = { length: 0 } as unknown as string[]
    expect(() => evaluateV2(fakeArray)).toThrow(/arrays/)

    const unscorable = exactSuiteV2()
    unscorable.manifest.runs[0].quality!.referenceTaskResult = 'unscorable'
    expect(() => evaluateV2(unscorable)).toThrow(/unscorable/)

    const contradictory = exactSuiteV2()
    contradictory.manifest.runs[0].quality!.candidateTaskResult = 'partial'
    expect(() => evaluateV2(contradictory)).toThrow(/contradicts/)

    const duplicate = exactSuiteV2()
    duplicate.manifest.runs[1].quality!.assessmentId = duplicate.manifest.runs[0].quality!.assessmentId
    expect(() => evaluateV2(duplicate)).toThrow(/Duplicate v2 quality assessment/)
  })

  it('derives AF/H/tool coverage only from frozen task mappings and verified Arena runs', () => {
    const cases: Array<(row: SuiteCoverageEvidenceRow) => void> = [
      (row) => { row.taskId = unsupportedTask(row) },
      (row) => { row.runId = 'invented-run' },
      (row) => { row.evidenceSha256 = 'c'.repeat(64) },
      (row) => { row.status = 'not_captured' },
    ]
    for (const mutate of cases) {
      const fixture = exactSuiteV2()
      mutate(fixture.manifest.coverage.rows[0])
      expect(evaluateV2(fixture).gates.find((gate) => gate.id === 'v2_af_coverage')).toMatchObject({ passed: false })
    }

    const duplicate = exactSuiteV2()
    duplicate.manifest.coverage.rows[1] = { ...duplicate.manifest.coverage.rows[0] }
    expect(evaluateV2(duplicate).gates.find((gate) => gate.id === 'v2_af_coverage')).toMatchObject({ passed: false })

    const unmapped = exactSuiteV2()
    unmapped.manifest.coverage.unmapped.push({
      id: 'UNMAPPED-002', taskId: 'A01', runId: 'arena-A01', evidenceSha256: rawDigest('reference', 'A01'),
    })
    expect(evaluateV2(unmapped).gates.find((gate) => gate.id === 'v2_suite_unmapped_zero')).toMatchObject({ passed: false })
  })

  it('rejects fake-array coverage and malformed coverage status at runtime', () => {
    const fake = exactSuiteV2()
    fake.manifest.coverage.rows = { length: 0 } as unknown as SuiteCoverageEvidenceRow[]
    expect(() => evaluateV2(fake)).toThrow(/real arrays/)
    const status = exactSuiteV2()
    status.manifest.coverage.rows[0].status = 'self_attested' as SuiteCoverageEvidenceRow['status']
    expect(() => evaluateV2(status)).toThrow(/coverage.rows/)
  })

  it('closes authenticated K01 H48/H56 only for observed success/attempt, never failure, non-use, blocking, or K02 substitution', () => {
    for (const status of ['failed', 'requested_not_used', 'blocked_by_policy', 'unsupported', 'not_captured'] as const) {
      const fixture = exactSuiteV2()
      fixture.manifest.coverage.rows.find((row) => row.id === 'H48')!.status = status
      expect(evaluateV2(fixture).gates.find((gate) => gate.id === 'v2_h_coverage'), status).toMatchObject({ passed: false })
    }

    const substituted = exactSuiteV2()
    const row = substituted.manifest.coverage.rows.find((item) => item.id === 'H56')!
    row.taskId = 'K02'
    row.runId = 'arena-K02'
    row.evidenceSha256 = rawDigest('reference', 'K02')
    expect(evaluateV2(substituted).gates.find((gate) => gate.id === 'v2_h_coverage')).toMatchObject({ passed: false })
  })

  it('loads and verifies visual report path, ID, SHA, desktop scope, viewport, and result', () => {
    const noReport = exactSuiteV2()
    noReport.external = undefined
    expect(evaluateV2(noReport).gates.find((gate) => gate.id === 'v2_visual_evidence')).toMatchObject({ passed: false })

    for (const mutate of [
      (fixture: V2Fixture) => { fixture.external!.visualReportSha256 = 'd'.repeat(64) },
      (fixture: V2Fixture) => { (fixture.external!.visualReport as Record<string, unknown>).reportId = 'wrong' },
      (fixture: V2Fixture) => { (fixture.external!.visualReport as Record<string, unknown>).passed = false },
      (fixture: V2Fixture) => { (fixture.external!.visualReport as Record<string, any>).viewport.widthPx = 390 },
    ]) {
      const fixture = exactSuiteV2()
      mutate(fixture)
      expect(evaluateV2(fixture).passed).toBe(false)
    }
  })

  it('rejects schema/baseline cross-pairs and configurable v2 task counts', () => {
    const fixture = exactSuiteV2()
    expect(() => evaluateTraceSuite({ ...fixture.manifest, expectedTaskCount: 64 } as unknown as SuiteManifest, fixture.loaded, fixture.external)).toThrow('requires expectedTaskCount 65')
    expect(() => evaluateTraceSuite({ ...fixture.manifest, schemaVersion: 'anera-eval-suite/1.0' } as unknown as SuiteManifest, fixture.loaded, fixture.external)).toThrow('cannot be combined')
  })
})

describe('frozen v2 task source', () => {
  it('recomputes all section and prompt-protocol hashes from the repository runbook', () => {
    const runbook = readFileSync(resolve(process.cwd(), 'ARENA_MANUAL_PROBE_RUNBOOK.md'), 'utf8').replace(/\r\n/g, '\n')
    const headings = [...runbook.matchAll(/^#### ([A-Z]\d{2}) —.*$/gm)]
    const sections = new Map<string, string>()
    for (let index = 0; index < headings.length; index += 1) {
      const taskId = headings[index][1]
      if (!(ARENA_PARITY_V2_TASK_IDS as readonly string[]).includes(taskId)) continue
      const nextTask = headings[index + 1]
      const nextMajorHeading = !nextTask
        ? [...runbook.matchAll(/^## .*$/gm)].find((heading) => heading.index! > headings[index].index!)
        : undefined
      sections.set(taskId, `${runbook.slice(headings[index].index!, nextTask?.index ?? nextMajorHeading?.index ?? runbook.length).trimEnd()}\n`)
    }
    expect([...sections.keys()].sort()).toEqual([...ARENA_PARITY_V2_TASK_IDS].sort())
    for (const taskId of ARENA_PARITY_V2_TASK_IDS) {
      const section = sections.get(taskId)!
      expect(sha256(section), `${taskId} section`).toBe(ARENA_PARITY_V2_TASK_SECTION_SHA256[taskId])
      const prompts = taskId === 'I03'
        ? []
        : [...section.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1].replace(/\n$/, ''))
      expect(sha256(JSON.stringify({ taskId, taskVersion: '2.0', prompts })), `${taskId} prompt protocol`)
        .toBe(ARENA_PARITY_V2_PROMPT_PROTOCOL_SHA256[taskId])
    }
  })

  it('freezes repository input and attachment ingress for applicable tasks', () => {
    const repository = ARENA_PARITY_V2_TASK_SPECS.K01
    expect(repository.inputVariants[0].files.map((file) => [file.logicalId, file.bytes, file.sha256])).toEqual([
      ['K01-R01:README.md', 153, 'aed7bfbabb1981aedfc1f2674bb5cd82743e731916a2138d9ae96e43c4f2658d'],
      ['K01-R02:src/probe.ts', 115, 'f3d060ed6a5e6434e435a0dde96d78e411cba5bd2d932c48de210087b9cac701'],
      ['K01-R03:data/numbers.csv', 29, 'e3d1fdf0316f05459415adf95da11721302ad0b7288750648028ad7d5877b41e'],
    ])
    expect(repository.operatorVariants[0].requiredActions).toEqual(['repository_select', 'message_submit'])
    for (const taskId of ['F01', 'G04', 'I01', 'L04', 'M01', 'M02', 'M03', 'M04', 'M06'] as const) {
      expect(ARENA_PARITY_V2_TASK_SPECS[taskId].operatorVariants.every((variant) => variant.requiredActions.includes('attachment_select')), taskId).toBe(true)
    }
  })
})

interface V2Fixture {
  manifest: SuiteManifestV2
  loaded: LoadedSuiteRun[]
  external: LoadedSuiteExternalEvidence | undefined
}

function exactSuiteV1(): { manifest: SuiteManifest; loaded: LoadedSuiteRun[] } {
  const runs = ['A01', 'W01'].map((taskId): SuiteRunDefinition => ({
    taskId,
    reference: `${taskId}-arena.jsonl`,
    candidate: `${taskId}-anera.jsonl`,
    captureQuality: 'complete',
    unmappedCount: 0,
    quality: {
      referenceTaskResult: 'pass', candidateTaskResult: 'pass', candidateOraclePass: true,
      candidateConstraintViolations: [], criticalViolations: [],
    },
  }))
  const manifest: SuiteManifest = {
    schemaVersion: 'anera-eval-suite/1.0', baselineVersion: 'observable-parity-v1', expectedTaskCount: 2,
    visualScope: 'desktop', visualBaselinePassed: true, runs,
  }
  return {
    manifest,
    loaded: runs.map((definition) => ({
      definition,
      referenceTrace: fixtureTrace(definition.taskId, 'arena'),
      candidateTrace: fixtureTrace(definition.taskId, 'anera'),
    })),
  }
}

function exactSuiteV2(): V2Fixture {
  const runs = ARENA_PARITY_V2_TASK_IDS.map((taskId): SuiteRunDefinition => {
    const referenceTrace = fixtureTrace(taskId, 'arena')
    const candidateTrace = fixtureTrace(taskId, 'anera')
    return {
      taskId,
      reference: `traces/${taskId}-arena.jsonl`,
      candidate: `traces/${taskId}-anera.jsonl`,
      referenceSha256: sha256(serializeCanonicalTrace(referenceTrace)),
      candidateSha256: sha256(serializeCanonicalTrace(candidateTrace)),
      captureQuality: 'complete',
      unmappedCount: 0,
      quality: {
        assessmentId: `assessment-${taskId}`,
        assessmentSha256: rawDigest('candidate', taskId),
        referenceTaskResult: 'pass', candidateTaskResult: 'pass', candidateOraclePass: true,
        candidateConstraintViolations: [], criticalViolations: [],
      },
      pairing: {
        reference: protocolEvidence(taskId, 'reference'),
        candidate: protocolEvidence(taskId, 'candidate'),
      },
    }
  })
  const loaded = runs.map((definition): LoadedSuiteRun => ({
    definition,
    referenceTrace: fixtureTrace(definition.taskId, 'arena'),
    candidateTrace: fixtureTrace(definition.taskId, 'anera'),
    referencePath: `/virtual/traces/${definition.taskId}-arena.jsonl`,
    candidatePath: `/virtual/traces/${definition.taskId}-anera.jsonl`,
    referenceEvidenceManifestPath: definition.pairing!.reference.rawEvidenceArtifact,
    candidateEvidenceManifestPath: definition.pairing!.candidate.rawEvidenceArtifact,
    referenceEvidencePath: `/virtual/evidence/${definition.taskId}-arena.json`,
    candidateEvidencePath: `/virtual/evidence/${definition.taskId}-anera.json`,
    referenceEvidenceSha256: rawDigest('reference', definition.taskId),
    candidateEvidenceSha256: rawDigest('candidate', definition.taskId),
  }))
  const rows: SuiteCoverageEvidenceRow[] = [
    ...coverageRows('af', ARENA_PARITY_V2_AF_IDS, ARENA_PARITY_V2_AF_TASKS),
    ...coverageRows('h', ARENA_PARITY_V2_H_IDS, ARENA_PARITY_V2_H_TASKS),
    ...coverageRows('active_tool', ARENA_ACTIVE_AGENT_TOOL_NAMES, ARENA_PARITY_V2_TOOL_TASKS),
  ]
  const visualReport = {
    schemaVersion: 'anera-observable-parity-visual/2.0', reportId: 'desktop-parity-v2', passed: true,
    visualScope: 'desktop', viewport: { ...ARENA_PARITY_V2_VIEWPORT },
  }
  const manifest: SuiteManifestV2 = {
    schemaVersion: 'anera-eval-suite/2.0', baselineVersion: 'observable-parity-v2', expectedTaskCount: 65,
    visualScope: 'desktop', visualBaselinePassed: true,
    visualEvidence: { report: 'visual/desktop-parity-v2.json', reportId: 'desktop-parity-v2', reportSha256: sha256(JSON.stringify(visualReport)) },
    coverage: { rows, unmapped: [] },
    runs,
  }
  return {
    manifest,
    loaded,
    external: {
      visualReportManifestPath: 'visual/desktop-parity-v2.json',
      visualReportPath: '/virtual/visual/desktop-parity-v2.json',
      visualReportSha256: sha256(JSON.stringify(visualReport)),
      visualReport,
    },
  }
}

function protocolEvidence(taskId: ArenaParityV2TaskId, side: 'reference' | 'candidate'): SuiteProtocolEvidence {
  const spec = ARENA_PARITY_V2_TASK_SPECS[taskId]
  const inputVariant = spec.inputVariants[0]
  const operatorVariant = spec.operatorVariants[0]
  return {
    taskVersion: '2.0',
    taskSpecSha256: spec.taskSpecSha256,
    rawEvidenceArtifact: `evidence/${taskId}-${side === 'reference' ? 'arena' : 'anera'}.json`,
    rawEvidenceSha256: rawDigest(side, taskId),
    inputVariantId: inputVariant.id,
    operatorVariantId: operatorVariant.id,
    promptSha256: spec.promptSha256,
    inputFiles: inputVariant.files.map((file) => ({ ...file })),
    operatorActions: operatorVariant.requiredActions.map(operatorAction),
    viewport: { ...ARENA_PARITY_V2_VIEWPORT },
  }
}

function operatorAction(action: string, index: number): { turnId: string; action: string; payloadSha256: string } {
  return { turnId: `T${String(index + 1).padStart(2, '0')}`, action, payloadSha256: sha256(`operator:${index}:${action}`) }
}

function coverageRows(
  dimension: SuiteCoverageEvidenceRow['dimension'],
  ids: readonly string[],
  mappings: Readonly<Record<string, readonly ArenaParityV2TaskId[]>>,
): SuiteCoverageEvidenceRow[] {
  return ids.map((id) => {
    const taskId = mappings[id][0]
    return { dimension, id, taskId, runId: `arena-${taskId}`, status: 'observed_succeeded', evidenceSha256: rawDigest('reference', taskId) }
  })
}

function unsupportedTask(row: SuiteCoverageEvidenceRow): string {
  const mapping = row.dimension === 'af' ? ARENA_PARITY_V2_AF_TASKS : row.dimension === 'h' ? ARENA_PARITY_V2_H_TASKS : ARENA_PARITY_V2_TOOL_TASKS
  return ARENA_PARITY_V2_TASK_IDS.find((taskId) => !mapping[row.id]?.includes(taskId)) ?? 'X01'
}

function fixtureTrace(taskId: string, source: 'arena' | 'anera'): CanonicalTrace {
  const traceId = `${source}-${taskId}`
  const events: CanonicalEvent[] = [
    baseEvent(traceId, 1, source, 'user', 'message', 'submitted', 'finalized', 'succeeded'),
    { ...baseEvent(traceId, 2, source, 'tool', 'tool', 'fetch', 'started', 'running'), tool: { name: 'fetch', callId: `${taskId}-C01`, arguments: { url: 'https://example.com' } } },
    { ...baseEvent(traceId, 3, source, 'tool', 'tool', 'fetch', 'completed', 'succeeded'), tool: { name: 'fetch', callId: `${taskId}-C01`, arguments: { url: 'https://example.com' }, result: 'ok', isError: false } },
    { ...baseEvent(traceId, 4, source, 'assistant', 'final', 'final_answer', 'finalized', 'succeeded'), message: 'Complete.' },
    baseEvent(traceId, 5, source, 'system_ui', 'lifecycle', 'run_status', 'updated', 'succeeded'),
  ]
  return {
    header: { schemaVersion: CANONICAL_TRACE_VERSION, source, traceId, taskId, eventCount: events.length, sides: ['global'] },
    events,
    outcome: {
      status: 'succeeded', finalText: 'Complete.', artifactPaths: [],
      usage: { durationMs: 1_000, modelCalls: 2, toolCalls: 1, totalTokens: 1_000, estimatedCostUsd: 0.01 },
    },
  }
}

function baseEvent(
  traceId: string,
  seq: number,
  source: 'arena' | 'anera',
  actor: CanonicalEvent['actor'],
  kind: CanonicalEvent['kind'],
  action: string,
  phase: CanonicalEvent['phase'],
  status: CanonicalEvent['status'],
): CanonicalEvent {
  return { schemaVersion: CANONICAL_TRACE_VERSION, source, traceId, seq, sourceSeq: seq, side: 'global', actor, kind, action, phase, status }
}

function rawDigest(side: 'reference' | 'candidate', taskId: string): string {
  return sha256(`raw-evidence:${side}:${taskId}`)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function evaluateV2(fixture: V2Fixture) {
  return evaluateTraceSuite(fixture.manifest, fixture.loaded, fixture.external).report
}
