import { generateArenaReferenceCorpus } from './arena-reference-corpus.js'

const args = parseArgs(process.argv.slice(2))
const sourceRoot = args['source-root']
const outputRoot = args.output
const generatedAt = args['generated-at']
if (!sourceRoot || !outputRoot || !generatedAt) usage('Missing required corpus generation argument')

const manifest = generateArenaReferenceCorpus({
  sourceRoot,
  outputRoot,
  generatedAt,
  currentTaskVersion: args['current-task-version'] || '2.0',
})
process.stdout.write(`${JSON.stringify({
  output: outputRoot,
  runs: manifest.runs.length,
  events: manifest.inventory.totalCanonicalEvents,
}, null, 2)}\n`)

function parseArgs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) usage(`Unexpected positional argument: ${value}`)
    const name = value.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith('--')) usage(`Missing value for --${name}`)
    result[name] = next
    index += 1
  }
  return result
}

function usage(error?: string): never {
  if (error) process.stderr.write(`${error}\n\n`)
  process.stderr.write('Usage: npm run corpus:arena-reference -- --source-root <arena_manual_runs> --output <report-dir> --generated-at <ISO-8601> [--current-task-version 2.0]\n')
  process.exit(2)
}
