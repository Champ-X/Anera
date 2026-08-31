import { extractAttachment } from '../src/server/attachment-extractor.js'

const path = process.argv[2]
if (!path) throw new Error('PDF path is required')
const text = await extractAttachment(path, 240_000)
const whole = await extractAttachment(path, 2_000_000)
const statusMatches = [...whole.matchAll(/Overview of Status Codes/g)]
const statusIndex = statusMatches.at(-1)?.index ?? -1
const statusPage = statusIndex >= 0 ? [...whole.slice(0, statusIndex).matchAll(/--- PDF page (\d+)/g)].at(-1)?.[1] : undefined
const later = await extractAttachment(path, 240_000, { pageStart: Number(statusPage || 1), pageEnd: Number(statusPage || 1) + 20 })
const report = {
  chars: text.length,
  hasTitle: text.includes('HTTP Semantics'),
  hasSafeMethods: /9\.2\.1\.?\s+Safe Methods/.test(text),
  hasIdempotentMethods: /9\.2\.2\.?\s+Idempotent Methods/.test(text),
  hasStatusCodes: /15\.1\.?\s+Overview of Status Codes/.test(later),
  statusPage,
  pageMarkers: (text.match(/--- PDF page/g) || []).length,
  rangedPageMarkers: (later.match(/--- PDF page/g) || []).length,
}
console.log(JSON.stringify(report, null, 2))
if (!report.hasTitle || !report.hasSafeMethods || !report.hasIdempotentMethods || !report.hasStatusCodes) process.exitCode = 1
