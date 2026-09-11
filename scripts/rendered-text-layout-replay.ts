import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { BrowserManager } from '../src/server/browser-manager.js'
import { injectMaterializedReferenceFonts } from '../src/server/reference-fonts.js'
import { resolveReferenceRuntimeEvidence } from '../src/server/reference-runtime-evidence.js'
import { extractReferenceStyleSourceProfile } from '../src/server/reference-style.js'
import { normalizeReferenceFontEvidenceManifest, type StoredSession } from '../src/server/session-store.js'
import type { SessionEvent, ToolCallRecord } from '../src/shared/types.js'
import { createCanaryEvidenceDirectory } from '../src/eval/canary-evidence.js'
import { smokeLocalPage } from '../src/eval/local-page-smoke.js'
import { verificationAssessment } from '../src/server/verification-assessment.js'

// Read-only replay of a terminal artifact (single-phase diagnostics) or completed
// artifact (all pages), in the project's isolated,
// network-denied renderer. Never open a user browser, call a model, recover a
// SessionStore, or rewrite the source session. Not chat UI acceptance.
const input = process.env.ANERA_TEXT_FIT_SESSION_DIR
assert.ok(input, 'Set ANERA_TEXT_FIT_SESSION_DIR to the completed source session directory')
const sessionDirectory = resolve(input)
assert.equal(basename(dirname(sessionDirectory)), 'sessions')
assert.match(basename(sessionDirectory), /^ses_[a-zA-Z0-9]+$/u)
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const stateBytes = await readFile(resolve(sessionDirectory, 'state.json'))
const eventBytes = await readFile(resolve(sessionDirectory, 'events.jsonl'))
const state = JSON.parse(stateBytes.toString('utf8')) as StoredSession
const diagnosticPhase = process.env.ANERA_TEXT_FIT_PHASE
assert.ok(!diagnosticPhase || ['cover', 'closing'].includes(diagnosticPhase), 'Diagnostic phase must be cover or closing')
assert.ok(diagnosticPhase ? ['completed', 'cancelled', 'failed'].includes(state.summary.status) : state.summary.status === 'completed',
  'Replay requires a terminal session; full replay requires completed status')
const reference = state.activeReferenceStyleContract!
assert.ok(reference?.renderProfile && reference.fontEvidence && reference.runtimeEvidence)
const artifactPath = state.activeVisualArtifact!.path
assert.ok(artifactPath && !artifactPath.includes('..') && !artifactPath.startsWith('/'))
const html = await readFile(resolve(sessionDirectory, 'workspace', artifactPath), 'utf8')
const events = eventBytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as SessionEvent)
async function toolResult(event: SessionEvent): Promise<string> {
  if (typeof event.data.result === 'string') return event.data.result
  const payload = (event.data.result as { __aneraEventPayload?: { schemaVersion: number; encoding: string; sha256: string; bytes: number } })?.__aneraEventPayload
  assert.ok(payload && payload.schemaVersion === 1 && payload.encoding === 'utf8')
  assert.match(payload.sha256, /^[0-9a-f]{64}$/u)
  const bytes = await readFile(resolve(sessionDirectory, 'event-payloads', 'v1', payload.sha256))
  assert.equal(bytes.length, payload.bytes)
  assert.equal(sha(bytes), payload.sha256)
  return bytes.toString('utf8')
}
const record = events.findLast((event) => event.type === 'tool.completed'
  && (event.data.call as ToolCallRecord | undefined)?.name === 'record_reference_style')
assert.ok(record)
const sourceFontManifest = normalizeReferenceFontEvidenceManifest(JSON.parse(await toolResult(record)).font_evidence)
let source = ''
for (const event of events) {
  if (event.type !== 'tool.completed') continue
  try {
    const result = JSON.parse(await toolResult(event))
    if (typeof result.content === 'string' && sha(result.content) === reference.provenance.evidenceSha256) source = result.content
  } catch { /* Unrelated non-JSON tool output is not a source snapshot. */ }
}
assert.ok(source, 'Need a complete, hash-matching source snapshot in the journal')
const fontManifest = normalizeReferenceFontEvidenceManifest(reference.fontEvidence)
const fontCss = await readFile(resolve(sessionDirectory, 'reference-style', 'fonts', 'v1',
  fontManifest.manifestSha256, `${fontManifest.fontCssSha256}.css`), 'utf8')
assert.equal(sha(fontCss), fontManifest.fontCssSha256)
assert.equal(Buffer.byteLength(fontCss), fontManifest.fontCssBytes)
const sourceFontCss = await readFile(resolve(sessionDirectory, 'reference-style', 'fonts', 'v1',
  sourceFontManifest.manifestSha256, `${sourceFontManifest.fontCssSha256}.css`), 'utf8')
assert.equal(sha(sourceFontCss), sourceFontManifest.fontCssSha256)
assert.equal(Buffer.byteLength(sourceFontCss), sourceFontManifest.fontCssBytes)
const runtimeScripts = await resolveReferenceRuntimeEvidence(sessionDirectory, reference.runtimeEvidence)
const derivedHtml = injectMaterializedReferenceFonts(html, fontCss, fontManifest.manifestSha256)
const outputRoot = await createCanaryEvidenceDirectory()
const manager = new BrowserManager()
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  // Match the App's blob-capable workspace script policy; compiled source
  // dependencies use a hash-bound base64-to-Blob loader, not eval.
  response.setHeader('content-security-policy', "default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'")
  response.end(derivedHtml)
})
const pages: Array<Record<string, unknown>> = []
console.log(JSON.stringify({ kind: 'read-only-text-fit-replay', outputRoot, chatUiVerified: false, modelCalls: 0 }))
try {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await smokeLocalPage({ url: `http://127.0.0.1:${address.port}/#1`, outputRoot,
    cli: process.env.ANERA_BROWSER_SMOKE_CLI })
  const fontOptions = { fontCss, expectedFontFamilies: fontManifest.familyNames, languageVariant: reference.languageVariant }
  const bundle = await manager.captureReferenceRenderBundle(source,
    extractReferenceStyleSourceProfile(source, reference.contract)!, reference.provenance.evidenceSha256,
    reference.contract.viewport, { fontCss: sourceFontCss,
      expectedFontFamilies: sourceFontManifest.familyNames, runtimeScripts })
  await writeFile(resolve(outputRoot, 'reference-profile.json'), JSON.stringify(bundle.profile, null, 2))
  await manager.setViewport('text-fit-replay', reference.contract.viewport.width, reference.contract.viewport.height)
  await manager.open('text-fit-replay', `http://127.0.0.1:${address.port}/`)
  const slideCount = (html.match(/<section\b/gu) ?? []).length
  assert.ok(slideCount >= 3 && slideCount <= 64)
  const indices = diagnosticPhase === 'cover' ? [0] : diagnosticPhase === 'closing' ? [slideCount - 1]
    : Array.from({ length: slideCount }, (_, index) => index)
  for (const index of indices) {
    if (diagnosticPhase === 'closing') await manager.press('text-fit-replay', 'End')
    else if (index) await manager.press('text-fit-replay', 'ArrowRight')
    const phase = index === 0 ? 'cover' : index === 1 ? 'content' : index === slideCount - 1 ? 'closing' : undefined
    const result = phase ? await manager.verifyRenderedReferenceStyleAndScreenshot(
      'text-fit-replay', bundle.profile, phase, undefined, fontOptions) : undefined
    const screenshot = result?.screenshot ?? await manager.screenshot('text-fit-replay')
    const path = resolve(outputRoot, `page-${index + 1}.png`)
    await writeFile(path, screenshot)
    const snapshot = await manager.snapshot('text-fit-replay')
    assert.equal(new URL(String(snapshot.url)).hash, `#${index + 1}`, 'The actual native controller must navigate each requested slide')
    const page = { index: index + 1, path, sha256: sha(screenshot), text: snapshot.text,
      ...(result ? { verification: result.verification, assessment: verificationAssessment(result.verification.checked,
        result.verification.matched, result.verification.observationGapCount ?? 0) } : {}) }
    pages.push(page)
    console.log(JSON.stringify({ index: page.index, path, sha256: page.sha256, verification: result?.verification, assessment: page.assessment }))
  }
} finally {
  await manager.shutdown()
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  assert.equal(sha(await readFile(resolve(sessionDirectory, 'state.json'))), sha(stateBytes))
  assert.equal(sha(await readFile(resolve(sessionDirectory, 'events.jsonl'))), sha(eventBytes))
  assert.equal(sha(await readFile(resolve(sessionDirectory, 'workspace', artifactPath))), sha(html))
  await writeFile(resolve(outputRoot, 'report.json'), JSON.stringify({ sessionDirectory, artifactPath,
    sourceStateSha256: sha(stateBytes), sourceEventsSha256: sha(eventBytes), artifactSha256: sha(html), pages,
    modelCalls: 0, chatUiVerified: false, originalUnchanged: true, acceptanceVerified: false,
    scope: diagnosticPhase ? `${diagnosticPhase}-only diagnostic; not whole-artifact acceptance` : 'all-page rendering replay' }, null, 2))
}
