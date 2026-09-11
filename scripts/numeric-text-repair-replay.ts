/** Read-only replay of the recorded seven-slot numeric collision repair.
 * It never starts a model, browser, server or writes a historical artifact.
 * Usage: npm exec -- tsx scripts/numeric-text-repair-replay.ts <session-dir>
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { readHydratedSessionEventLog, type StoredSession } from '../src/server/session-store.js'
import { applyArenaEdit } from '../src/server/workspace-edit.js'
import { applyReferenceTextEdit, readReferenceText } from '../src/server/reference-text-edit.js'
import { referenceLanguageText, verifyReferenceLanguageMarkup } from '../src/server/reference-language.js'
import type { ToolCallRecord } from '../src/shared/types.js'

assert(process.argv[2], 'Supply the existing failed session directory; no live model is permitted.')
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
assert(artifact && language)
const canonicalPath = resolve(directory, 'workspace', artifact.path)
assert(canonicalPath.startsWith(resolve(directory, 'workspace') + '/'))
originals.set(canonicalPath, await readFile(canonicalPath))
const events = await readHydratedSessionEventLog(eventPath)
const composition = events.find((event) => event.type === 'tool.completed' && event.callId === artifact.canonicalWriteCallId)
const initial = originals.get(initialPath)!.toString('utf8')
assert(composition && typeof composition.data.result === 'string')
assert.equal(createHash('sha256').update(initial).digest('base64url'), JSON.parse(composition.data.result).hash)
const mutation = events.find((event) => event.type === 'tool.completed' && event.callId === artifact.lastMutationCallId)
const call = mutation?.data.call as ToolCallRecord | undefined
assert(call?.name === 'edit_file' && Array.isArray(call.arguments.edits))
let recorded = initial
for (const edit of call.arguments.edits as Array<{ old_text: string; new_text: string }>) {
  recorded = applyArenaEdit(recorded, edit.old_text, edit.new_text).content
}
assert.equal(recorded, originals.get(canonicalPath)!.toString('utf8'))

// The recorded raw edit malformed one CJK run. Decode only its literal copy
// and regenerate that group in memory, without changing any factual wording.
type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
const attr = (node: Element, name: string) => node.attrs.find((value) => value.name === name)?.value
const text = (node: Node): string => node.nodeName === '#text'
  ? (node as DefaultTreeAdapterMap['textNode']).value : 'childNodes' in node ? node.childNodes.map(text).join('') : ''
const pending: Node[] = [parse(recorded, { sourceCodeLocationInfo: true })]
const slides: Element[] = []
while (pending.length) {
  const node = pending.pop()!
  if ('tagName' in node && (attr(node, 'class') ?? '').split(/\s+/u).includes('slide')) slides.push(node)
  if ('childNodes' in node) pending.push(...[...node.childNodes].reverse())
}
const nodes: Node[] = [slides[2]]
let broken: Element | undefined
while (nodes.length) {
  const node = nodes.pop()!
  if ('tagName' in node && attr(node, 'data-anera-cjk-text') === 't7') { assert(!broken); broken = node }
  if ('childNodes' in node) nodes.push(...node.childNodes)
}
assert(broken?.sourceCodeLocation)
assert.throws(() => verifyReferenceLanguageMarkup(recorded, language), /U\+0029/)
const binding = language.bindings.find((entry) => entry.variant === 'v3' && entry.slot === 't7')!
const repairedMarkup = recorded.slice(0, broken.sourceCodeLocation.startOffset)
  + referenceLanguageText(text(broken), binding) + recorded.slice(broken.sourceCodeLocation.endOffset)
verifyReferenceLanguageMarkup(repairedMarkup, language)
const before = readReferenceText(initial, language)
const after = readReferenceText(repairedMarkup, language)
const edits = before.slots.flatMap((slot) => {
  const changed = after.slots.find((entry) => entry.slide_index === slot.slide_index && entry.slot === slot.slot)
  assert(changed, 'A source slot unexpectedly disappeared from the recorded edit')
  return slot.text === changed.text ? [] : [{ slide_index: slot.slide_index, slot: slot.slot,
    expected_text: slot.text, new_text: changed.text }]
})
assert.equal(edits.length, 7)
assert(edits.some((entry) => entry.expected_text === '124.98' && entry.new_text === '18'))
assert(edits.some((entry) => entry.expected_text === '36.74' && entry.new_text === '4'))
const arguments_ = { path: artifact.path, reference_text: { hash: before.hash,
  language_manifest_sha256: before.language_manifest_sha256, edits } }
const batchResult = applyReferenceTextEdit(initial, language, arguments_.reference_text)
assert.deepEqual(readReferenceText(batchResult, language).slots, after.slots)
verifyReferenceLanguageMarkup(batchResult, language)
for (const [path, bytes] of originals) assert.equal(sha(await readFile(path)), sha(bytes))
console.log(JSON.stringify({ passed: true, liveModelCalls: 0, historicalFilesUnchanged: true,
  sourceHash: before.hash, canonicalBytes: Buffer.byteLength(initial), textViewBytes: Buffer.byteLength(JSON.stringify(before)),
  editableSlots: before.slots.length, repairedSlots: edits.map(({ slide_index, slot }) => `${slide_index}.${slot}`),
  recordedRawEditArgumentBytes: Buffer.byteLength(JSON.stringify(call.arguments)),
  literalBatchArgumentBytes: Buffer.byteLength(JSON.stringify(arguments_)),
  preservesRecordedLiteralCopy: true, cjkMarkupPass: true,
  caveat: 'In-memory replay only: no factual audit, render pass, live-model delivery or measured billing savings.',
}, null, 2))
