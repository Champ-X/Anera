import { createHash } from 'node:crypto'

const base = process.env.ANERA_SMOKE_BASE || 'http://127.0.0.1:4174'
const lineCount = positiveInt('ANERA_SMOKE_LINE_COUNT', 80)
const deadlineMs = positiveInt('ANERA_SMOKE_DEADLINE_MS', lineCount >= 1_000 ? 15 * 60_000 : 120_000)
const expectedStatus = process.env.ANERA_SMOKE_EXPECT_STATUS || 'completed'
const marker = process.env.ANERA_SMOKE_LINE_MARKER || 'ANERA-LONG-FINAL-V1'
const requireContinuation = process.env.ANERA_SMOKE_REQUIRE_CONTINUATION !== 'false'

if (lineCount > 9_999) throw new Error('ANERA_SMOKE_LINE_COUNT must be between 1 and 9999')
if (!['completed', 'failed'].includes(expectedStatus)) throw new Error('ANERA_SMOKE_EXPECT_STATUS must be completed or failed')
if (!/^[A-Z0-9-]{1,64}$/.test(marker)) throw new Error('ANERA_SMOKE_LINE_MARKER must match ^[A-Z0-9-]{1,64}$')

const expectedLines = Array.from({ length: lineCount }, (_, index) => (
  `${String(index + 1).padStart(4, '0')}|${marker}`
))
const expected = expectedLines.join('\n')
const expectedSha256 = sha256(expected)

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const { session } = await createResponse.json()
const submitResponse = await fetch(`${base}/api/sessions/${session.id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    content: [
      'Do not use web, terminal, files, or any other tool.',
      `Output exactly ${lineCount} lines and nothing else.`,
      `Line n must be the four-digit decimal line number, one vertical bar, and the fixed marker ${marker}.`,
      `The first line must be 0001|${marker} and the last line must be ${String(lineCount).padStart(4, '0')}|${marker}.`,
      'Do not add a title, Markdown fence, explanation, blank line, duplicated line, skipped line, or ellipsis.',
      'Do not end with a blank line. If a provider output limit is reached, continue from the next missing line without repeating any visible prefix.',
    ].join(' '),
  }),
})
if (!submitResponse.ok) throw new Error(`submit failed: ${submitResponse.status} ${await submitResponse.text()}`)

const deadline = Date.now() + deadlineMs
let snapshot
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/sessions/${session.id}`)
  if (!response.ok) throw new Error(`snapshot failed: ${response.status}`)
  snapshot = await response.json()
  if (['completed', 'failed', 'cancelled', 'timed_out'].includes(snapshot.session.status)) break
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
}
if (!snapshot) throw new Error(`length-continuation task ${session.id} exceeded the ${deadlineMs}ms polling deadline`)
if (!['completed', 'failed'].includes(snapshot.session.status)) {
  throw new Error(`length-continuation task ${session.id} ended as ${snapshot.session.status}, expected completed or failed`)
}

const deltaEvents = snapshot.events.filter((event) => event.type === 'assistant.final.delta')
const streamed = deltaEvents.map((event) => String(event.data?.delta || '')).join('')
const finalEvents = snapshot.events.filter((event) => event.type === 'assistant.final')
const reviewEvents = snapshot.events.filter((event) => event.type === 'review.requested')
const errorEvents = snapshot.events.filter((event) => event.type === 'error')
const usageEvents = snapshot.events.filter((event) => event.type === 'usage.updated' && event.data.source === 'agent')
const continuationModelCalls = Math.max(0, ...usageEvents.map((event) => Number(event.data.modelCallCount) || 0))
const toolEvents = snapshot.events.filter((event) => event.type.startsWith('tool.'))
const violations = []
if (snapshot.session.status !== expectedStatus) violations.push(`status:${snapshot.session.status}!=${expectedStatus}`)
if (requireContinuation && continuationModelCalls <= 1) violations.push('continuation_not_observed')
if (snapshot.session.usage.toolCalls !== 0 || toolEvents.length !== 0) violations.push('unexpected_tool_use')

let observed = streamed
let finalMatchesStream = false
let exactSequence = false
let trailingLf = false
let lineOracle = { valid: false, reason: 'not_evaluated' }
let terminalError

if (snapshot.session.status === 'completed') {
  if (finalEvents.length !== 1) violations.push(`final_count:${finalEvents.length}!=1`)
  if (reviewEvents.length !== 1) violations.push(`review_count:${reviewEvents.length}!=1`)
  if (errorEvents.length !== 0) violations.push(`completed_error_count:${errorEvents.length}!=0`)
  observed = String(finalEvents[0]?.data?.content || '')
  finalMatchesStream = observed === streamed
  if (!finalMatchesStream) violations.push('stream_final_mismatch')
  lineOracle = inspectLines(observed, lineCount, marker)
  exactSequence = lineOracle.valid
  trailingLf = lineOracle.trailingLf
  if (!exactSequence) violations.push(`line_oracle:${lineOracle.reason || 'failed'}`)
} else {
  if (finalEvents.length !== 0) violations.push(`failed_final_count:${finalEvents.length}!=0`)
  if (reviewEvents.length !== 0) violations.push(`failed_review_count:${reviewEvents.length}!=0`)
  const truncationError = errorEvents.find((event) => /remained truncated/i.test(String(event.data?.message || '')))
  terminalError = truncationError?.data
  if (!truncationError) violations.push('bounded_truncation_error_missing')
  if (truncationError?.data?.partialResponsePersisted !== true) violations.push('partial_response_not_reported_persisted')
  if (!streamed) violations.push('visible_partial_stream_missing')
  lineOracle = inspectPartialLines(streamed, lineCount, marker)
  if (!lineOracle.valid) violations.push(`partial_line_oracle:${lineOracle.reason || 'failed'}`)
}

const report = {
  schemaVersion: 'anera-real-smoke/1.1',
  runAt: new Date().toISOString(),
  sessionId: session.id,
  status: snapshot.session.status,
  expectedStatus,
  deadlineMs,
  requireContinuation,
  durationMs: snapshot.session.usage.durationMs,
  modelCalls: snapshot.session.usage.modelCalls,
  continuationModelCalls,
  toolCalls: snapshot.session.usage.toolCalls,
  promptTokens: snapshot.session.usage.promptTokens,
  completionTokens: snapshot.session.usage.completionTokens,
  cachedPromptTokens: snapshot.session.usage.cachedPromptTokens,
  totalTokens: snapshot.session.usage.totalTokens,
  estimatedCostUsd: snapshot.session.usage.estimatedCostUsd,
  requestedLines: lineCount,
  marker,
  expectedBytes: Buffer.byteLength(expected),
  expectedSha256,
  observedBytes: Buffer.byteLength(observed),
  observedSha256: sha256(observed),
  deltaEvents: deltaEvents.length,
  publishedContinuationChunks: deltaEvents.filter((event) => Buffer.byteLength(String(event.data?.delta || '')) > 512).length,
  streamedBytes: Buffer.byteLength(streamed),
  streamedSha256: sha256(streamed),
  finalMatchesStream,
  exactSequence,
  trailingLf,
  lineOracle,
  terminalError,
  finalEvents: finalEvents.length,
  reviewEvents: reviewEvents.length,
  errorEvents: errorEvents.length,
  passed: violations.length === 0,
  violations,
}
console.log(JSON.stringify(report, null, 2))
if (violations.length > 0) throw new Error(`length-continuation oracle failed for ${session.id}: ${violations.join(', ')}`)

function positiveInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function inspectLines(value, expectedCount, expectedMarker) {
  const trailingLf = value.endsWith('\n')
  const canonical = trailingLf ? value.slice(0, -1) : value
  if (canonical.includes('\r')) return { valid: false, reason: 'carriage_return', trailingLf }
  const lines = canonical ? canonical.split('\n') : []
  if (lines.length !== expectedCount) return { valid: false, reason: 'line_count', observedLines: lines.length, expectedLines: expectedCount, trailingLf }
  for (let index = 0; index < lines.length; index += 1) {
    const expectedLine = `${String(index + 1).padStart(4, '0')}|${expectedMarker}`
    if (lines[index] !== expectedLine) {
      return { valid: false, reason: 'line_mismatch', line: index + 1, expected: expectedLine, observed: lines[index], trailingLf }
    }
  }
  return { valid: true, observedLines: lines.length, first: lines[0], last: lines.at(-1), trailingLf }
}

function inspectPartialLines(value, expectedCount, expectedMarker) {
  if (value.includes('\r')) return { valid: false, reason: 'carriage_return' }
  const completeLines = value.endsWith('\n') ? value.slice(0, -1).split('\n') : value.split('\n').slice(0, -1)
  if (completeLines.length === 0) return { valid: true, observedCompleteLines: 0, partialTailBytes: Buffer.byteLength(value) }
  if (completeLines.length >= expectedCount) return { valid: false, reason: 'not_partial', observedCompleteLines: completeLines.length }
  for (let index = 0; index < completeLines.length; index += 1) {
    const expectedLine = `${String(index + 1).padStart(4, '0')}|${expectedMarker}`
    if (completeLines[index] !== expectedLine) {
      return { valid: false, reason: 'line_mismatch', line: index + 1, expected: expectedLine, observed: completeLines[index] }
    }
  }
  return { valid: true, observedCompleteLines: completeLines.length, first: completeLines[0], lastComplete: completeLines.at(-1) }
}
