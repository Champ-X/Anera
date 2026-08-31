import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { comparePngFiles, renderVisualDiffMarkdown } from './visual-diff.js'

const args = parseArgs(process.argv.slice(2))
const reference = args.values.reference || args.positionals[0]
const candidate = args.values.candidate || args.positionals[1]
if (!reference || !candidate) usage('Both --reference and --candidate PNGs are required')
const jsonPath = args.values.json ? resolve(args.values.json) : undefined
const markdownPath = args.values.markdown ? resolve(args.values.markdown) : undefined
const diffPath = args.values.diff ? resolve(args.values.diff) : undefined
for (const path of [jsonPath, markdownPath, diffPath].filter((value): value is string => Boolean(value))) mkdirSync(dirname(path), { recursive: true })
const report = await comparePngFiles(resolve(reference), resolve(candidate), {
  pixelThreshold: optionalNumber(args.values['pixel-threshold']),
  maxChangedRatio: optionalNumber(args.values['max-changed-ratio']),
  maxMeanAbsoluteError: optionalNumber(args.values['max-mae']),
  diffPath,
})
const markdown = renderVisualDiffMarkdown(report)
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
if (markdownPath) writeFileSync(markdownPath, markdown, 'utf8')
if (!jsonPath && !markdownPath) process.stdout.write(markdown)
if (!report.passed) process.exitCode = 1

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) usage(`Invalid numeric value: ${value}`)
  return parsed
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
  process.stderr.write('Usage: npm run visual:diff -- --reference arena.png --candidate anera.png [--diff diff.png] [--json report.json] [--markdown report.md] [--pixel-threshold 0.10] [--max-changed-ratio 0.01] [--max-mae 0.02]\n')
  process.exit(2)
}
