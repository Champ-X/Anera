import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateArenaReferenceCorpus, type ArenaReferenceCorpusManifest } from './arena-reference-corpus.js'
import { traceFromJsonl } from './trace-io.js'

const temporaryRoots: string[] = []
const committedReportRoot = resolve('reports/arena-reference-corpus-2026-08-30')
const committedManifestPath = join(committedReportRoot, 'manifest.json')
const committedManifest = existsSync(committedManifestPath)
  ? JSON.parse(readFileSync(committedManifestPath, 'utf8')) as ArenaReferenceCorpusManifest
  : undefined

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Arena reference corpus generation', () => {
  it('deterministically generates canonical JSONL, provenance, event counts, and hashes', () => {
    const fixtureRoot = temporaryRoot()
    const sourceRoot = join(fixtureRoot, 'source')
    const runRoot = join(sourceRoot, 'A01/A01-fixture')
    mkdirSync(join(runRoot, 'normalized'), { recursive: true })
    mkdirSync(join(runRoot, 'qc'), { recursive: true })
    writeFileSync(join(runRoot, 'metadata.yaml'), `schema_version: arena-visible-trace/1.1
run_id: A01-fixture
task_id: A01
task_version: "1.1"
included_in_dataset: true
environment:
  window_size_px: "1440x900 logical"
  browser_zoom_percent: 100
capture:
  gaps:
    - gap_id: G01
      started_at: "2026-08-30T00:00:01Z"
      ended_at: "2026-08-30T00:00:02Z"
      preceding_segment_id: S01
      following_segment_id: S02
      reason: "fixture gap"
post_run:
  final_ui_outcomes:
    global: success
  visible_usage:
    global:
      model_or_agent_label: not_visible
  capture_quality: complete_with_declared_gaps
`)
    writeFileSync(join(runRoot, 'normalized/events.md'), `# Visible events — A01-fixture

| seq | segment | episode | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility |
|---:|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|
| 1 | S01 | E01 | T01 | global | R01 | 00:00:01.000 | 0 | UI-SEND | operator | operator_action | finalized | succeeded | clicked Send | Send | | | fully_visible |
| 2 | S01 | E01 | T01 | global | R01 | 00:00:03.500 | 2500 | UI-FINAL | assistant | final | finalized | succeeded | Final | | | | fully_visible |
`)
    writeFileSync(join(runRoot, 'qc/task_assessment.yaml'), 'task_result: pass\n')
    writeFileSync(join(runRoot, 'qc/capability_assessment.yaml'), 'observations:\n  - id: UNMAPPED-002\n')
    writeFileSync(join(sourceRoot, 'coverage_matrix.csv'), 'capability_id,task_id\nH01,A01\n')
    writeFileSync(join(sourceRoot, 'public_tool_opportunity_matrix.csv'), 'public_tool,task_id\nbash,A01\n')
    const firstOutput = join(fixtureRoot, 'first')
    const secondOutput = join(fixtureRoot, 'second')
    const options = { sourceRoot, generatedAt: '2026-08-30T23:00:00+08:00', currentTaskVersion: '2.0' }

    const first = generateArenaReferenceCorpus({ ...options, outputRoot: firstOutput })
    const second = generateArenaReferenceCorpus({ ...options, outputRoot: secondOutput })
    const relative = first.runs[0].curatedCanonical
    const canonical = readFileSync(join(firstOutput, relative), 'utf8')
    const trace = traceFromJsonl(canonical)

    expect(readFileSync(join(firstOutput, 'manifest.json'), 'utf8')).toBe(readFileSync(join(secondOutput, 'manifest.json'), 'utf8'))
    expect(readFileSync(join(firstOutput, 'README.md'), 'utf8')).toBe(readFileSync(join(secondOutput, 'README.md'), 'utf8'))
    expect(canonical).toBe(readFileSync(join(secondOutput, relative), 'utf8'))
    expect(first).toEqual(second)
    expect(first.inventory).toMatchObject({ curatedCanonicalRuns: 1, totalCanonicalEvents: 2 })
    expect(first.coverage).toMatchObject({ distinctCapabilityCount: 1, unmappedObservations: 1 })
    expect(first.runs[0]).toMatchObject({
      taskVersion: '1.1',
      eventCount: 2,
      agentDurationMs: 2500,
      arenaUiOutcome: 'success',
      environment: { windowSizePx: '1440x900 logical', browserZoomPercent: 100 },
      capture: { gaps: [{ gapId: 'G01', reason: 'fixture gap' }] },
      pairedEligibility: { eligible: false, eligibleForCurrentTaskVersion: false },
    })
    expect(trace.events).toHaveLength(2)
    expect(first.runs[0].sha256).toBe(sha256(canonical))
  })

  it.each([
    {
      name: 'metadata task_id',
      fixture: { metadataTaskId: 'A02' },
      expected: 'metadata task_id',
    },
    {
      name: 'metadata run_id',
      fixture: { metadataRunId: 'different-run' },
      expected: 'metadata run_id',
    },
    {
      name: 'source canonical taskId',
      fixture: { sourceCanonical: { taskId: 'A02', traceId: 'A01-fixture' } },
      expected: 'source canonical header.taskId',
    },
    {
      name: 'source canonical traceId',
      fixture: { sourceCanonical: { taskId: 'A01', traceId: 'different-run' } },
      expected: 'source canonical header.traceId',
    },
  ])('rejects a $name that disagrees with its task/run directories', ({ fixture, expected }) => {
    const root = temporaryRoot()
    const sourceRoot = join(root, 'source')
    writeIncludedRunFixture(sourceRoot, { taskId: 'A01', runId: 'A01-fixture', ...fixture })
    const outputRoot = join(root, 'output')

    expect(() => generateFixtureCorpus(sourceRoot, outputRoot)).toThrow(expected)
    expect(existsSync(join(outputRoot, 'canonical'))).toBe(false)
  })

  it('rejects included runs whose task directory is outside the frozen v2 task set', () => {
    const root = temporaryRoot()
    const sourceRoot = join(root, 'source')
    writeIncludedRunFixture(sourceRoot, { taskId: 'Z99', runId: 'Z99-fixture' })

    expect(() => generateFixtureCorpus(sourceRoot, join(root, 'output'))).toThrow('outside the frozen v2 task set')
  })

  it('rejects globally duplicated runIds before writing any canonical output', () => {
    const root = temporaryRoot()
    const sourceRoot = join(root, 'source')
    writeIncludedRunFixture(sourceRoot, { taskId: 'A01', runId: 'shared-run' })
    writeIncludedRunFixture(sourceRoot, { taskId: 'A02', runId: 'shared-run' })
    const outputRoot = join(root, 'output')

    expect(() => generateFixtureCorpus(sourceRoot, outputRoot)).toThrow('globally unique runIds and canonical output paths')
    expect(existsSync(join(outputRoot, 'canonical'))).toBe(false)
  })

  it('rejects case-only canonical output path collisions before writing', () => {
    const root = temporaryRoot()
    const sourceRoot = join(root, 'source')
    writeIncludedRunFixture(sourceRoot, { taskId: 'A01', runId: 'Shared-Run' })
    writeIncludedRunFixture(sourceRoot, { taskId: 'A02', runId: 'shared-run' })
    const outputRoot = join(root, 'output')

    expect(() => generateFixtureCorpus(sourceRoot, outputRoot)).toThrow('canonical output path')
    expect(existsSync(join(outputRoot, 'canonical'))).toBe(false)
  })

  it.each(['H00', 'H58', 'UNMAPPED-002', ''])('rejects non-frozen coverage capability_id %j', (capabilityId) => {
    const root = temporaryRoot()
    const sourceRoot = join(root, 'source')
    writeIncludedRunFixture(sourceRoot, { taskId: 'A01', runId: 'A01-fixture' })
    writeFileSync(join(sourceRoot, 'coverage_matrix.csv'), `capability_id,task_id\n${capabilityId},A01\n`)
    const outputRoot = join(root, 'output')

    expect(() => generateFixtureCorpus(sourceRoot, outputRoot)).toThrow('expected H01-H57')
    expect(existsSync(join(outputRoot, 'canonical'))).toBe(false)
  })

  it('accepts H57 and counts every UNMAPPED-* identifier, not only UNMAPPED-001', () => {
    const root = temporaryRoot()
    const sourceRoot = join(root, 'source')
    writeIncludedRunFixture(sourceRoot, {
      taskId: 'A01',
      runId: 'A01-fixture',
      capabilityAssessment: `unmapped_observations:
  - id: UNMAPPED-002
  - id: "UNMAPPED-new-ui"
`,
    })
    writeFileSync(join(sourceRoot, 'coverage_matrix.csv'), 'capability_id,task_id\nH57,A01\n')

    const manifest = generateFixtureCorpus(sourceRoot, join(root, 'output'))

    expect(manifest.coverage).toMatchObject({ distinctCapabilityIds: ['H57'], unmappedObservations: 2 })
  })

  it.skipIf(!committedManifest)('keeps the committed curated manifest hashes and event counts internally consistent', () => {
    if (!committedManifest) throw new Error('Committed private report is unavailable')
    const manifest = committedManifest
    const canonicalNames = readdirSync(join(committedReportRoot, 'canonical')).filter((name) => name.endsWith('.jsonl')).sort()
    const manifestNames = manifest.runs.map((run) => run.curatedCanonical.replace(/^canonical\//, '')).sort()
    let totalEvents = 0

    expect(canonicalNames).toEqual(manifestNames)
    for (const run of manifest.runs) {
      const canonical = readFileSync(join(committedReportRoot, run.curatedCanonical), 'utf8')
      const trace = traceFromJsonl(canonical)
      expect(run.sha256, run.runId).toBe(sha256(canonical))
      expect(run.eventCount, run.runId).toBe(trace.events.length)
      expect(trace.header.eventCount, run.runId).toBe(trace.events.length)
      totalEvents += trace.events.length
    }
    expect(totalEvents).toBe(manifest.inventory.totalCanonicalEvents)
  })

  it.skipIf(!committedManifest || !existsSync(committedManifest.sourceRoot))('exactly regenerates the committed report from its read-only source', () => {
    if (!committedManifest) throw new Error('Committed private report is unavailable')
    const root = temporaryRoot()
    const regenerated = join(root, 'regenerated')
    generateArenaReferenceCorpus({
      sourceRoot: committedManifest.sourceRoot,
      outputRoot: regenerated,
      generatedAt: committedManifest.generatedAt,
      currentTaskVersion: String(committedManifest.protocol.currentTaskVersion),
    })

    expect(readFileSync(join(regenerated, 'manifest.json'), 'utf8')).toBe(readFileSync(join(committedReportRoot, 'manifest.json'), 'utf8'))
    expect(readFileSync(join(regenerated, 'README.md'), 'utf8')).toBe(readFileSync(join(committedReportRoot, 'README.md'), 'utf8'))
    for (const run of committedManifest.runs) {
      expect(readFileSync(join(regenerated, run.curatedCanonical), 'utf8')).toBe(readFileSync(join(committedReportRoot, run.curatedCanonical), 'utf8'))
    }
  })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'anera-arena-corpus-test-'))
  temporaryRoots.push(root)
  return root
}

interface IncludedRunFixtureOptions {
  taskId: string
  runId: string
  metadataTaskId?: string
  metadataRunId?: string
  sourceCanonical?: { taskId: string; traceId: string }
  capabilityAssessment?: string
}

function writeIncludedRunFixture(sourceRoot: string, options: IncludedRunFixtureOptions): void {
  const runRoot = join(sourceRoot, options.taskId, options.runId)
  mkdirSync(join(runRoot, 'normalized'), { recursive: true })
  mkdirSync(join(runRoot, 'qc'), { recursive: true })
  writeFileSync(join(runRoot, 'metadata.yaml'), `schema_version: arena-visible-trace/1.1
run_id: ${options.metadataRunId ?? options.runId}
task_id: ${options.metadataTaskId ?? options.taskId}
task_version: "1.1"
included_in_dataset: true
post_run:
  final_ui_outcomes:
    global: success
  capture_quality: complete
`)
  writeFileSync(join(runRoot, 'normalized/events.md'), `# Visible events — ${options.runId}

| seq | segment | episode | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility |
|---:|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|
| 1 | S01 | E01 | T01 | global | R01 | 00:00:01.000 | 0 | UI-FINAL | assistant | final | finalized | succeeded | Final | | | | fully_visible |
`)
  if (options.capabilityAssessment) {
    writeFileSync(join(runRoot, 'qc/capability_assessment.yaml'), options.capabilityAssessment)
  }
  if (options.sourceCanonical) {
    const header = {
      schemaVersion: 'anera-canonical-trace/1.0',
      source: 'arena',
      traceId: options.sourceCanonical.traceId,
      taskId: options.sourceCanonical.taskId,
      eventCount: 0,
      sides: ['global'],
    }
    const outcome = {
      status: 'succeeded',
      finalText: 'fixture',
      artifactPaths: [],
      usage: {},
    }
    writeFileSync(join(runRoot, 'normalized/canonical.jsonl'), `${JSON.stringify({ recordType: 'trace', trace: header })}\n${JSON.stringify({ recordType: 'outcome', outcome })}\n`)
  }
}

function generateFixtureCorpus(sourceRoot: string, outputRoot: string): ArenaReferenceCorpusManifest {
  return generateArenaReferenceCorpus({
    sourceRoot,
    outputRoot,
    generatedAt: '2026-08-30T23:00:00+08:00',
    currentTaskVersion: '2.0',
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
