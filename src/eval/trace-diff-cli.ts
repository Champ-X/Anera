import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { diffCanonicalTraces, renderDiffMarkdown } from './trace-diff.js'
import { loadCanonicalTrace } from './trace-io.js'

const args = parseArgs(process.argv.slice(2))
const referencePath = args.values.reference || args.positionals[0]
const candidatePath = args.values.candidate || args.positionals[1]
if (!referencePath || !candidatePath) usage('Both --reference and --candidate are required')

const report = diffCanonicalTraces(loadCanonicalTrace(referencePath), loadCanonicalTrace(candidatePath), {
  referenceSide: args.values['reference-side'],
  candidateSide: args.values['candidate-side'],
})
const markdown = renderDiffMarkdown(report)
if (args.values.json) writeOutput(args.values.json, `${JSON.stringify(report, null, 2)}\n`)
if (args.values.markdown) writeOutput(args.values.markdown, markdown)
if (!args.values.json && !args.values.markdown) process.stdout.write(markdown)

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

function usage(error?: string): never {
  if (error) process.stderr.write(`${error}\n\n`)
  process.stderr.write('Usage: npm run trace:diff -- --reference <Arena events.md|canonical.jsonl> --candidate <Anera canonical.jsonl|events.jsonl> [--reference-side left] [--candidate-side global] [--json report.json] [--markdown report.md]\n')
  process.exit(2)
}
