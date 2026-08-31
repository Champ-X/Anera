import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { diffUiContracts, renderUiContractDiffMarkdown, type UiVisualContract } from './ui-contract.js'

const args = parseArgs(process.argv.slice(2))
const referencePath = args.values.reference || args.positionals[0]
const candidatePath = args.values.candidate || args.positionals[1]
if (!referencePath || !candidatePath) usage('Both --reference and --candidate UI contract JSON files are required')
const reference = JSON.parse(readFileSync(resolve(referencePath), 'utf8')) as UiVisualContract
const candidate = JSON.parse(readFileSync(resolve(candidatePath), 'utf8')) as UiVisualContract
const diff = diffUiContracts(reference, candidate, {
  minOverallScore: optionalNumber(args.values['min-score']),
  minStateScore: optionalNumber(args.values['min-state-score']),
})
const markdown = renderUiContractDiffMarkdown(diff)
if (args.values.json) writeOutput(args.values.json, `${JSON.stringify(diff, null, 2)}\n`)
if (args.values.markdown) writeOutput(args.values.markdown, markdown)
if (!args.values.json && !args.values.markdown) process.stdout.write(markdown)
if (!diff.passed) process.exitCode = 1

function writeOutput(path: string, content: string): void {
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf8')
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

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) usage(`Invalid numeric value: ${value}`)
  return parsed
}

function usage(error?: string): never {
  if (error) process.stderr.write(`${error}\n\n`)
  process.stderr.write('Usage: npm run visual:contract-diff -- --reference arena-ui-contract.json --candidate anera-ui-contract.json [--json report.json] [--markdown report.md] [--min-score 0.98] [--min-state-score 0.95]\n')
  process.exit(2)
}
