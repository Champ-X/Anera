import './legacy-live-test-disabled.mjs'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import archiver from 'archiver'
import { chromium } from 'playwright-core'

const base = process.env.ANERA_BASE_URL || 'http://127.0.0.1:4174'
const projectRoot = resolve(process.cwd())
const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/real-smokes')
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])

const fixtures = [
  {
    path: 'deliverables/readiness-brief.docx',
    format: 'docx',
    selector: '.office-doc-page',
    marker: 'REAL OFFICE BRIEF 431',
    entries: {
      'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>REAL OFFICE BRIEF 431</w:t></w:r></w:p><w:p><w:r><w:t>Owner: Platform</w:t></w:r></w:p></w:body></w:document>',
    },
  },
  {
    path: 'deliverables/readiness-metrics.xlsx',
    format: 'xlsx',
    selector: '.office-sheet',
    marker: '99.99',
    entries: {
      'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheets><sheet name="Readiness" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Metric</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Availability</t></is></c><c r="B2"><v>99.99</v></c></row></sheetData></worksheet>',
    },
  },
  {
    path: 'deliverables/readiness-review.pptx',
    format: 'pptx',
    selector: '.office-slide',
    marker: 'REAL OFFICE REVIEW 431',
    entries: {
      'ppt/presentation.xml': '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
      'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>REAL OFFICE REVIEW 431</a:t></a:r></a:p><a:p><a:r><a:t>Decision: Ready</a:t></a:r></a:p></p:sld>',
    },
  },
]

for (const fixture of fixtures) {
  fixture.bytes = await zipBuffer(fixture.entries)
  fixture.sha256 = sha256(fixture.bytes)
}

const setupScript = `#!/bin/sh
set -eu
node <<'NODE'
const fs = require('node:fs')
fs.mkdirSync('deliverables', { recursive: true })
${fixtures.map((fixture) => `fs.writeFileSync(${JSON.stringify(fixture.path)}, Buffer.from(${JSON.stringify(fixture.bytes.toString('base64'))}, 'base64'))`).join('\n')}
NODE
`

const resumedSessionId = process.env.ANERA_SMOKE_SESSION_ID?.trim()
const sessionId = resumedSessionId || (await postJson('/api/sessions', {}, 201)).session.id
const setupPath = 'uploads/create-office-fixtures.txt'
const exactCommand = `bash ${setupPath}`
if (!resumedSessionId) {
  const uploaded = await postJson(`/api/sessions/${sessionId}/files`, {
    name: setupPath.split('/').at(-1),
    mime: 'text/plain',
    contentBase64: Buffer.from(setupScript).toString('base64'),
  }, 201)
  if (uploaded.path !== setupPath) throw new Error(`Unexpected setup upload path: ${JSON.stringify(uploaded)}`)
  await postJson(`/api/sessions/${sessionId}/messages`, {
    attachments: [uploaded.path],
    timezone: 'Asia/Shanghai',
    content: `Use bash exactly once with command ${JSON.stringify(exactCommand)} to create three finished Office deliverables. Do not read or edit the uploaded setup script and do not use any other creation command. After bash succeeds, call present_file exactly once for each of these paths in this order: ${fixtures.map((fixture) => fixture.path).join(', ')}. Do not use any other tool. Then output exactly OFFICE-PRESENT-FILE-OK-431 and nothing else.`,
  }, 202)
}

const snapshot = await waitForTerminal(sessionId)
const completed = snapshot.events.filter((event) => event.type === 'tool.completed')
const failed = snapshot.events.filter((event) => event.type === 'tool.failed')
const completedNames = completed.map((event) => String(event.data?.call?.name || ''))
const started = snapshot.events.filter((event) => event.type === 'tool.started')
const startedNames = started.map((event) => String(event.data?.call?.name || ''))
const final = String(snapshot.events.findLast((event) => event.type === 'assistant.final')?.data?.content || '')
const presentedPaths = snapshot.events
  .filter((event) => event.type === 'file.presented')
  .map((event) => String(event.data?.path || ''))
const setupResponse = await fetch(`${base}/workspace/${sessionId}/file?path=${encodeURIComponent(setupPath)}`)
if (!setupResponse.ok) throw new Error(`Reading persisted setup script failed: ${setupResponse.status} ${await setupResponse.text()}`)
const persistedSetupScript = await setupResponse.text()
for (const fixture of fixtures) {
  fixture.bytes = fixtureBytesFromSetupScript(persistedSetupScript, fixture.path)
  fixture.sha256 = sha256(fixture.bytes)
}

if (snapshot.session.status !== 'completed') throw new Error(`Office present_file run ended as ${snapshot.session.status}`)
if (final !== 'OFFICE-PRESENT-FILE-OK-431') throw new Error(`Unexpected final: ${JSON.stringify(final)}`)
if (failed.length > 0) throw new Error(`Office present_file run had failed tools: ${JSON.stringify(failed.map((event) => event.data))}`)
if (startedNames.length !== 4 || startedNames[0] !== 'bash' || startedNames.slice(1).some((name) => name !== 'present_file')) {
  throw new Error(`Unexpected tool sequence: ${JSON.stringify(startedNames)}`)
}
if (String(started[0]?.data?.call?.arguments?.command || '') !== exactCommand) {
  throw new Error(`Model changed the exact setup command: ${JSON.stringify(started[0]?.data?.call?.arguments)}`)
}
if (JSON.stringify(presentedPaths) !== JSON.stringify(fixtures.map((fixture) => fixture.path))) {
  throw new Error(`Unexpected file.presented order: ${JSON.stringify(presentedPaths)}`)
}

const previews = []
for (const fixture of fixtures) {
  const artifact = snapshot.artifacts.find((candidate) => candidate.path === fixture.path)
  if (!artifact) throw new Error(`Missing Artifact ${fixture.path}`)
  const previewResponse = await fetch(`${base}/api/sessions/${sessionId}/artifact-preview?path=${encodeURIComponent(fixture.path)}`)
  if (!previewResponse.ok) throw new Error(`Preview ${fixture.path} failed: ${previewResponse.status} ${await previewResponse.text()}`)
  const preview = await previewResponse.json()
  if (preview.format !== fixture.format || preview.truncated !== false || !String(preview.content).includes(fixture.marker)) {
    throw new Error(`Preview oracle failed for ${fixture.path}: ${JSON.stringify(preview)}`)
  }
  const downloadResponse = await fetch(`${base}${artifact.downloadUrl}`)
  const downloaded = Buffer.from(await downloadResponse.arrayBuffer())
  if (!downloadResponse.ok || sha256(downloaded) !== fixture.sha256) throw new Error(`Downloaded bytes changed for ${fixture.path}`)
  previews.push({
    path: fixture.path,
    format: preview.format,
    unit: preview.unit,
    marker: fixture.marker,
    bytes: downloaded.length,
    sha256: fixture.sha256,
  })
}

await mkdir(reportDirectory, { recursive: true })
const screenshotStem = `office-present-file-${sessionId}`
const browserChecks = []
const consoleErrors = []
let browser
try {
  const { findBrowserExecutable } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/browser-executable.js')).href)
  browser = await chromium.launch({
    executablePath: findBrowserExecutable(process.env.ANERA_BROWSER_EXECUTABLE),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 })
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await page.goto(`${base}/agent/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  const artifactPreview = page.getByRole('dialog', { name: 'Artifact preview' })
  for (const fixture of fixtures) {
    const name = fixture.path.split('/').at(-1)
    await page.getByRole('button', { name: `Open ${name}`, exact: true }).click()
    await artifactPreview.waitFor({ state: 'visible' })
    await artifactPreview.locator(fixture.selector).filter({ hasText: fixture.marker }).first().waitFor({ state: 'visible' })
    if (await artifactPreview.locator('iframe').count()) throw new Error(`${fixture.path} used an iframe fallback`)
    const screenshot = resolve(reportDirectory, `${screenshotStem}-${fixture.format}.png`)
    await page.screenshot({ path: screenshot, animations: 'disabled', caret: 'hide', type: 'png' })
    browserChecks.push({ path: fixture.path, selector: fixture.selector, marker: fixture.marker, iframeCount: 0, screenshot })
    await artifactPreview.getByRole('button', { name: 'Close preview' }).click()
    await artifactPreview.waitFor({ state: 'detached' })
  }
} finally {
  await browser?.close()
}
if (consoleErrors.length > 0) throw new Error(`Browser console errors: ${JSON.stringify(consoleErrors)}`)

const report = {
  generatedAt: new Date().toISOString(),
  sessionId,
  status: snapshot.session.status,
  model: snapshot.session.model,
  usage: snapshot.session.usage,
  exactCommand,
  completedTools: completedNames,
  presentedPaths,
  final,
  previews,
  browserChecks,
  consoleErrors,
  passed: true,
}
const reportPath = resolve(reportDirectory, `${screenshotStem}.json`)
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)

async function postJson(path, body, expectedStatus = 200) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status !== expectedStatus) throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function waitForTerminal(id) {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/sessions/${id}`)
    if (!response.ok) throw new Error(`Snapshot ${id} failed: ${response.status} ${await response.text()}`)
    const current = await response.json()
    if (terminalStatuses.has(current.session.status)) return current
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  }
  throw new Error(`Session ${id} did not finish before the smoke deadline`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fixtureBytesFromSetupScript(script, path) {
  const prefix = `fs.writeFileSync(${JSON.stringify(path)}, Buffer.from("`
  const start = script.indexOf(prefix)
  if (start < 0) throw new Error(`Persisted setup script does not contain ${path}`)
  const valueStart = start + prefix.length
  const valueEnd = script.indexOf("\", 'base64'))", valueStart)
  if (valueEnd < 0) throw new Error(`Persisted setup script has an invalid payload for ${path}`)
  return Buffer.from(script.slice(valueStart, valueEnd), 'base64')
}

async function zipBuffer(entries) {
  return await new Promise((resolvePromise, reject) => {
    const archive = archiver('zip', { zlib: { level: 1 } })
    const chunks = []
    archive.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    archive.on('end', () => resolvePromise(Buffer.concat(chunks)))
    archive.on('error', reject)
    for (const [name, content] of Object.entries(entries)) archive.append(content, { name })
    void archive.finalize()
  })
}
