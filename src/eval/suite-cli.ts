import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { renderDiffMarkdown } from './trace-diff.js'
import { loadCanonicalTrace } from './trace-io.js'
import {
  evaluateTraceSuite,
  renderSuiteMarkdown,
  type LoadedSuiteExternalEvidence,
  type LoadedSuiteRun,
  type SuiteManifest,
} from './suite-eval.js'

const args = parseArgs(process.argv.slice(2))
const manifestPath = args.values.manifest || args.positionals[0]
if (!manifestPath) usage('Missing --manifest <eval-suite.json>')
const absoluteManifest = resolve(manifestPath)
const manifestRoot = dirname(absoluteManifest)
const manifest = JSON.parse(readFileSync(absoluteManifest, 'utf8')) as SuiteManifest
if (!Array.isArray(manifest.runs)) throw new Error('Suite manifest runs must be an array')

const loaded: LoadedSuiteRun[] = await Promise.all(manifest.runs.map(async (definition) => {
  const referencePath = realpathSync(resolve(manifestRoot, definition.reference))
  const candidatePath = realpathSync(resolve(manifestRoot, definition.candidate))
  const result: LoadedSuiteRun = {
    definition,
    referenceTrace: await loadCanonicalTrace(referencePath),
    candidateTrace: await loadCanonicalTrace(candidatePath),
    referencePath,
    candidatePath,
  }
  if (manifest.schemaVersion === 'anera-eval-suite/2.0') {
    const referenceEvidenceManifestPath = definition.pairing?.reference.rawEvidenceArtifact
    const candidateEvidenceManifestPath = definition.pairing?.candidate.rawEvidenceArtifact
    if (!referenceEvidenceManifestPath || !candidateEvidenceManifestPath) {
      throw new Error(`Task ${definition.taskId} is missing raw-evidence artifact paths`)
    }
    const referenceEvidencePath = realpathSync(resolve(manifestRoot, referenceEvidenceManifestPath))
    const candidateEvidencePath = realpathSync(resolve(manifestRoot, candidateEvidenceManifestPath))
    result.referenceEvidenceManifestPath = referenceEvidenceManifestPath
    result.candidateEvidenceManifestPath = candidateEvidenceManifestPath
    result.referenceEvidencePath = referenceEvidencePath
    result.candidateEvidencePath = candidateEvidencePath
    result.referenceEvidenceSha256 = sha256(readFileSync(referenceEvidencePath))
    result.candidateEvidenceSha256 = sha256(readFileSync(candidateEvidencePath))
  }
  return result
}))
let externalEvidence: LoadedSuiteExternalEvidence | undefined
if (manifest.schemaVersion === 'anera-eval-suite/2.0') {
  const visualReportManifestPath = manifest.visualEvidence.report
  const visualReportPath = realpathSync(resolve(manifestRoot, visualReportManifestPath))
  const visualBytes = readFileSync(visualReportPath)
  externalEvidence = {
    visualReportManifestPath,
    visualReportPath,
    visualReportSha256: sha256(visualBytes),
    visualReport: JSON.parse(visualBytes.toString('utf8')) as unknown,
  }
}
const evaluation = evaluateTraceSuite(manifest, loaded, externalEvidence)
const markdown = renderSuiteMarkdown(evaluation.report)

if (args.values['runs-dir']) {
  const runsRoot = resolve(args.values['runs-dir'])
  mkdirSync(runsRoot, { recursive: true })
  for (const [taskId, diff] of evaluation.diffs) {
    const safeTaskId = basename(taskId).replace(/[^A-Za-z0-9._-]/g, '_')
    writeFileSync(resolve(runsRoot, `${safeTaskId}.json`), `${JSON.stringify(diff, null, 2)}\n`, 'utf8')
    writeFileSync(resolve(runsRoot, `${safeTaskId}.md`), renderDiffMarkdown(diff), 'utf8')
  }
}
if (args.values.json) writeOutput(args.values.json, `${JSON.stringify(evaluation.report, null, 2)}\n`)
if (args.values.markdown) writeOutput(args.values.markdown, markdown)
if (!args.values.json && !args.values.markdown) process.stdout.write(markdown)
if (!evaluation.report.passed) process.exitCode = 1

function writeOutput(path: string, content: string): void {
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf8')
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function parseArgs(values: string[]): { values: Record<string, string>; positionals: string[] } {
  const parsed: { values: Record<string, string>; positionals: string[] } = { values: {}, positionals: [] }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) parsed.positionals.push(value)
    else {
      const name = value.slice(2)
      const next = values[index + 1]
      if (!next || next.startsWith('--')) usage(`Missing value for --${name}`)
      parsed.values[name] = next
      index += 1
    }
  }
  return parsed
}

function usage(error?: string): never {
  if (error) process.stderr.write(`${error}\n\n`)
  process.stderr.write('Usage: npm run trace:suite -- --manifest eval-suite.json [--json suite.json] [--markdown suite.md] [--runs-dir reports/runs]\n')
  process.exit(2)
}
