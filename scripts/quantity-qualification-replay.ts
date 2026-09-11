/** Read-only replay of quantity qualifications in the recorded eight-slide
 * report. No model, network, Browser, SessionStore initialization or writes.
 * Usage: npm exec -- tsx scripts/quantity-qualification-replay.ts <session-dir>
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readHydratedSessionEventLog, type StoredSession } from '../src/server/session-store.js'
import { applyReferenceTextEdit, readReferenceText } from '../src/server/reference-text-edit.js'
import { verifyReferenceLanguageMarkup } from '../src/server/reference-language.js'
import { researchHtmlClaimGap, type ResearchClaimIssue } from '../src/server/research-claim-integrity.js'

assert(process.argv[2], 'Supply the existing session directory; no live model is permitted.')
const directory = resolve(process.argv[2])
const statePath = resolve(directory, 'state.json')
const eventPath = resolve(directory, 'events.jsonl')
const initialPath = resolve(directory, 'workspace/index.html')
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const originals = new Map<string, Buffer>()
for (const path of [statePath, eventPath, initialPath]) originals.set(path, await readFile(path))
const state = JSON.parse(originals.get(statePath)!.toString('utf8')) as StoredSession
const artifact = state.activeVisualArtifact
const language = state.activeReferenceStyleContract?.languageVariant
const items = state.activeTaskResearchEvidence?.brief?.items
assert(artifact && language && items)
const canonicalPath = resolve(directory, 'workspace', artifact.path)
assert(canonicalPath.startsWith(resolve(directory, 'workspace') + '/'))
originals.set(canonicalPath, await readFile(canonicalPath))
const events = await readHydratedSessionEventLog(eventPath)
const composition = events.find((event) => event.type === 'tool.completed' && event.callId === artifact.canonicalWriteCallId)
assert(composition && typeof composition.data.result === 'string')
const initial = originals.get(initialPath)!.toString('utf8')
assert.equal(createHash('sha256').update(initial).digest('base64url'), JSON.parse(composition.data.result).hash)
const terminal = originals.get(canonicalPath)!.toString('utf8')
const decode = (gap: string | undefined): ResearchClaimIssue[] => {
  const match = gap?.match(/^Research-claim verification failed: (\[.*\])\. Preserve /u)
  assert(match, 'Expected a bounded claim rejection, not an absent/incomplete scan')
  return JSON.parse(match[1]) as ResearchClaimIssue[]
}
const issues = decode(researchHtmlClaimGap(items, initial))
assert.deepEqual(decode(researchHtmlClaimGap(items, terminal)), issues)
assert.deepEqual(issues, [
  ...[['57.1%', '超57.1%'], ['99%', '超99%'], ['7.7%', '超过7.7%']].map(([claim, sourceQuote]) => ({
    code: 'quantity_qualification', itemId: 'n1', claim, sourceQuote,
    sourceUrl: 'https://news.qq.com/rain/a/20260903A088DA00?ptag=ima',
  })),
  { code: 'quantity_qualification', itemId: 'n6', claim: '约70%', sourceQuote: '超七成',
    sourceUrl: 'https://www.chinanews.com.cn/cul/2026/09-01/10687814.shtml' },
])
for (const issue of issues) assert(items.find((item) => item.id === issue.itemId)?.sources.some((source) =>
  source.url === issue.sourceUrl && source.excerpt?.includes(issue.sourceQuote)))
const view = readReferenceText(initial, language)
const at = (slide: number, slot: string) => {
  const entry = view.slots.find((entry) => entry.slide_index === slide && entry.slot === slot)
  assert(entry)
  return entry
}
// Verify the recorded card identities, not just coincidentally equal numbers.
assert.equal(at(2, 't12').text, '跨城观演占比(%)')
assert.equal(at(2, 't19').text, '正向评价率(%)')
assert.equal(at(2, 't22').text, '老粉复购率(%)')
const targets: Array<[number, string, string, string]> = [
  [2, 't11', '57.1', '>57.1'], [2, 't18', '99', '>99'], [2, 't21', '7.7', '>7.7'],
  [3, 't18', '70', '70+'], [3, 't19', '国产票房占比(约%)', '国产票房占比(%)'],
]
const edits = targets.map(([slide_index, slot, expected_text, new_text]) => {
  assert.equal(at(slide_index, slot).text, expected_text)
  return { slide_index, slot, expected_text, new_text }
})
const reference_text = { hash: view.hash, language_manifest_sha256: view.language_manifest_sha256, edits }
const corrected = applyReferenceTextEdit(initial, language, reference_text)
verifyReferenceLanguageMarkup(corrected, language)
assert.equal(researchHtmlClaimGap(items, corrected), undefined)
// Fixing only the numeral must not let the separate "about" label pass.
const partial = applyReferenceTextEdit(initial, language, { ...reference_text, edits: edits.slice(0, -1) })
assert.deepEqual(decode(researchHtmlClaimGap(items, partial)).map((issue) => issue.claim), ['约70%'])
for (const [path, bytes] of originals) assert.equal(sha(await readFile(path)), sha(bytes))
console.log(JSON.stringify({ passed: true, liveModelCalls: 0, historicalFilesUnchanged: true,
  sourceHash: view.hash, issues, correctedSlots: edits.map(({ slide_index, slot }) => `${slide_index}.${slot}`),
  inMemoryClaimGapAfter: null, cjkMarkupPass: true,
  canonicalBytes: Buffer.byteLength(initial), textViewBytes: Buffer.byteLength(JSON.stringify(view)),
  batchArgumentBytes: Buffer.byteLength(JSON.stringify({ path: artifact.path, reference_text })),
  caveat: 'Narrow in-memory contradiction checks only; no factual approval, rendered-layout pass, live delivery or measured billing savings.',
}, null, 2))
