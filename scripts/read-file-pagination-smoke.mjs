import './legacy-live-test-disabled.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_SMOKE_BASE || 'http://127.0.0.1:4174'
const middleMarker = 'PAGINATION-MARKER-731'
const tailMarker = 'PAGINATION-TAIL-926'
const expectedFinal = `${middleMarker}|${tailMarker}`
const lineCount = 1_200
const oversizedLineNumber = 601
// Put the marker just inside the second default byte page so the live model
// must follow content_offset, while avoiding a marker buried deep in a run of
// identical tokens that would turn this into an attention benchmark.
const oversizedLine = `${'q'.repeat(80_050)}${middleMarker}${'r'.repeat(89_950)}`
const source = `${Array.from({ length: lineCount }, (_, index) => {
  const line = index + 1
  if (line === oversizedLineNumber) return oversizedLine
  const marker = line === lineCount ? tailMarker : 'ordinary-evidence'
  return `${String(line).padStart(4, '0')}|${marker}|${'x'.repeat(42)}`
}).join('\n')}\n`

const created = await request('/api/sessions', { method: 'POST' })
const sessionId = created.session?.id
if (!sessionId) throw new Error('Session creation returned no id')

const uploaded = await request(`/api/sessions/${sessionId}/files`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'long-evidence.txt',
    mime: 'text/plain',
    contentBase64: Buffer.from(source).toString('base64'),
  }),
})
if (typeof uploaded.path !== 'string') throw new Error('Upload returned no workspace path')

await request(`/api/sessions/${sessionId}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    attachments: [uploaded.path],
    content: `Read the uploaded long-evidence.txt completely from line 1 through EOF using only read_file. Follow every returned continuation cursor exactly until hasMore is false: copy nextContentOffset as content_offset with the same offset line when present; otherwise copy nextOffset as offset. Record each marker when first seen and do not reread any completed byte range. Do not use Bash, list_files, grep_files, or any other tool. The oversized middle line and final line contain two marker values. Your Final must be exactly the two marker values joined by | with no prose, markdown, or whitespace.`,
  }),
})

const snapshot = await waitForTerminal(sessionId, 180_000)
if (snapshot.session.status !== 'completed') {
  throw new Error(`Pagination smoke ended as ${snapshot.session.status}: ${JSON.stringify(snapshot.events?.slice(-6))}`)
}

const readEvents = snapshot.events.filter((event) => (
  event.type === 'tool.completed' && event.data?.call?.name === 'read_file'
))
const failedTools = snapshot.events.filter((event) => event.type === 'tool.failed')
const allStartedTools = snapshot.events
  .filter((event) => event.type === 'tool.started')
  .map((event) => event.data?.call?.name)
const pages = readEvents.map((event) => {
  const payload = JSON.parse(event.data.result)
  return {
    callId: event.data.call.id,
    requestedOffset: event.data.call.arguments.offset ?? 1,
    requestedContentOffset: event.data.call.arguments.content_offset ?? null,
    requestedLimit: event.data.call.arguments.limit ?? null,
    offset: payload.offset,
    contentOffset: payload.contentOffset ?? null,
    returnedLines: payload.returnedLines,
    hasMore: payload.hasMore,
    nextOffset: payload.nextOffset ?? null,
    nextContentOffset: payload.nextContentOffset ?? null,
    totalLines: payload.lines,
  }
})
const final = snapshot.events.findLast((event) => event.type === 'assistant.final')?.data?.content ?? ''

if (pages.length < 5) throw new Error(`Expected at least five physical text pages, received ${pages.length}`)
if (failedTools.length > 0) throw new Error(`Pagination smoke had failed tools: ${JSON.stringify(failedTools)}`)
if (allStartedTools.some((name) => name !== 'read_file')) throw new Error(`Unexpected tool surface: ${JSON.stringify(allStartedTools)}`)
if (final !== expectedFinal) throw new Error(`Final did not exactly recover the ordered marker pair: ${JSON.stringify(final)}`)
const terminalIndex = pages.findIndex((page) => page.hasMore === false)
if (terminalIndex < 4) throw new Error(`The complete cursor chain ended too early at page ${terminalIndex + 1}`)
const primaryPages = pages.slice(0, terminalIndex + 1)
const extraReads = pages.slice(terminalIndex + 1)
if (extraReads.length > 0) throw new Error(`Model reread ${extraReads.length} completed range(s): ${JSON.stringify(extraReads)}`)
for (let index = 0; index < primaryPages.length; index += 1) {
  const page = primaryPages[index]
  if (page.offset !== page.requestedOffset) throw new Error(`Page ${index + 1} lost its requested offset`)
  if (page.contentOffset !== null || page.requestedContentOffset !== null) {
    const requestedContentOffset = page.requestedContentOffset ?? 0
    if (page.contentOffset !== requestedContentOffset) {
      throw new Error(`Page ${index + 1} lost its requested content_offset=${requestedContentOffset}`)
    }
  }
  if (page.totalLines !== lineCount) throw new Error(`Page ${index + 1} reported ${page.totalLines} lines instead of ${lineCount}`)
  if (index < primaryPages.length - 1) {
    if (!page.hasMore) throw new Error(`Page ${index + 1} omitted its continuation cursor`)
    if (Number.isInteger(page.nextContentOffset)) {
      if (page.nextOffset !== null) throw new Error(`Page ${index + 1} returned two continuation cursors`)
      if (primaryPages[index + 1].requestedOffset !== page.offset) {
        throw new Error(`Page ${index + 2} changed offset while continuing line ${page.offset}`)
      }
      if (primaryPages[index + 1].requestedContentOffset !== page.nextContentOffset) {
        throw new Error(`Page ${index + 2} did not copy nextContentOffset=${page.nextContentOffset}`)
      }
    } else {
      if (!Number.isInteger(page.nextOffset) || page.nextContentOffset !== null) {
        throw new Error(`Page ${index + 1} returned an invalid continuation cursor`)
      }
      if (primaryPages[index + 1].requestedOffset !== page.nextOffset || primaryPages[index + 1].requestedContentOffset !== null) {
        throw new Error(`Page ${index + 2} did not copy nextOffset=${page.nextOffset}`)
      }
    }
  } else if (page.hasMore || page.nextOffset !== null || page.nextContentOffset !== null) {
    throw new Error('Terminal page retained a continuation cursor')
  }
}
if (!primaryPages.some((page) => Number.isInteger(page.nextContentOffset))) {
  throw new Error('Pagination smoke never exercised the oversized-line content_offset cursor')
}
if (!primaryPages.some((page) => Number.isInteger(page.nextOffset))) {
  throw new Error('Pagination smoke never exercised the ordinary nextOffset cursor')
}

const generatedAt = new Date().toISOString()
const report = {
  schemaVersion: 'anera-read-file-pagination-smoke/1.2',
  generatedAt,
  productionBundle: true,
  liveModel: true,
  providerFixture: false,
  sessionId,
  status: snapshot.session.status,
  file: {
    path: uploaded.path,
    bytes: Buffer.byteLength(source),
    lines: lineCount,
    oversizedLine: oversizedLineNumber,
    oversizedLineBytes: Buffer.byteLength(oversizedLine),
  },
  pages,
  primaryPageCount: primaryPages.length,
  extraReadCount: extraReads.length,
  usage: snapshot.session.usage,
  final,
  checks: {
    completed: true,
    onlyReadFileUsed: true,
    atLeastFivePages: true,
    usedLineCursor: true,
    usedContentCursor: true,
    noCompletedRangeRereads: true,
    everyCursorCopiedExactly: true,
    terminalPageHasNoCursor: true,
    middleAndTailMarkersRecovered: true,
    exactOrderedMarkerPairInFinal: true,
  },
  passed: true,
}
const reportDir = resolve(process.cwd(), 'reports/real-smokes')
await mkdir(reportDir, { recursive: true })
const reportPath = resolve(reportDir, `read-file-pagination-${generatedAt.replace(/[:.]/g, '-')}.json`)
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  let payload
  try { payload = text ? JSON.parse(text) : {} }
  catch { payload = { raw: text.slice(0, 1_000) } }
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${path} failed (${response.status}): ${JSON.stringify(payload)}`)
  return payload
}

async function waitForTerminal(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await request(`/api/sessions/${id}`)
    if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session?.status)) return snapshot
    await new Promise((resolveWait) => setTimeout(resolveWait, 750))
  }
  throw new Error(`Pagination smoke did not finish within ${timeoutMs}ms`)
}
