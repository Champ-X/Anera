import { writeFileSync } from 'node:fs'
import { loadCanonicalTrace, serializeCanonicalTrace } from './trace-io.js'

const args = parseArgs(process.argv.slice(2))
const input = args.values.input || args.positionals[0]
if (!input) usage('Missing --input <trace.jsonl|snapshot.json|events.md>')
const output = args.values.output || args.positionals[1]
const serialized = serializeCanonicalTrace(loadCanonicalTrace(input))
if (output) writeFileSync(output, serialized, 'utf8')
else process.stdout.write(serialized)

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
  process.stderr.write('Usage: npm run trace:normalize -- --input <file> [--output canonical.jsonl]\n')
  process.exit(2)
}
