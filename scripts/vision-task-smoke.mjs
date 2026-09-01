import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_SMOKE_BASE || 'http://127.0.0.1:4174'
const fixture = resolve(process.cwd(), 'arena_probe_fixtures/M01_ui_reference.png')
const requiredVisionModel = 'deepseek-v4-flash-vision-exp'

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const { session } = await createResponse.json()
const image = await readFile(fixture)
const uploadResponse = await fetch(`${base}/api/sessions/${session.id}/files`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'M01_ui_reference.png',
    mime: 'image/png',
    contentBase64: image.toString('base64'),
  }),
})
if (!uploadResponse.ok) throw new Error(`upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`)
const uploaded = await uploadResponse.json()

const submitResponse = await fetch(`${base}/api/sessions/${session.id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    attachments: [uploaded.path],
    content: 'Inspect the uploaded UI image with the image inspection tool. Then create dashboard.html that reproduces its visible layout, colors, KPI cards, charts, and table using only inline HTML/CSS/SVG and no external dependencies. Publish it, open it in the browser, verify the visible heading and desktop layout at 1200x800, check the console, and finish with a concise report.',
  }),
})
if (!submitResponse.ok) throw new Error(`submit failed: ${submitResponse.status} ${await submitResponse.text()}`)

const deadline = Date.now() + 240_000
let snapshot
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/sessions/${session.id}`)
  if (!response.ok) throw new Error(`snapshot failed: ${response.status}`)
  snapshot = await response.json()
  if (['completed', 'failed', 'cancelled', 'timed_out'].includes(snapshot.session.status)) break
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
}
if (!snapshot || snapshot.session.status !== 'completed') {
  throw new Error(`vision task did not complete: ${snapshot?.session?.status || 'timeout'}\n${JSON.stringify(snapshot?.events?.slice(-5), null, 2)}`)
}

const toolStarts = snapshot.events.filter((event) => event.type === 'tool.started').map((event) => event.data.call?.name)
const toolCompletions = snapshot.events.filter((event) => event.type === 'tool.completed').map((event) => event.data.call?.name)
const visionUsageEvents = snapshot.events.filter((event) => event.type === 'usage.updated' && event.data.source === 'vision')
const visionUsage = visionUsageEvents[0]
const artifact = snapshot.artifacts.find((item) => item.path === 'dashboard.html')
for (const required of ['inspect_image', 'browser']) {
  if (!toolStarts.includes(required)) throw new Error(`required tool was not started: ${required}`)
  if (!toolCompletions.includes(required)) throw new Error(`required tool did not complete: ${required}`)
}
if (!toolCompletions.includes('write_file')) {
  throw new Error('dashboard was not created with the active write_file tool')
}
if (!toolCompletions.includes('start_process')) {
  throw new Error('dashboard website was not started with the active start_process tool')
}
if (!visionUsage) throw new Error('vision usage was not recorded in the unified session ledger')
if (!artifact) throw new Error('dashboard.html artifact was not created')
if (snapshot.session.usage.modelCalls < 2) throw new Error('modelCalls did not include both harness and vision model calls')
if (visionUsageEvents.some((event) => event.data.model !== requiredVisionModel)) {
  throw new Error(`unexpected vision model: ${visionUsageEvents.map((event) => event.data.model || 'missing').join(', ')}`)
}
if (!Number.isInteger(visionUsage.data.modelRequestCount) || visionUsage.data.modelRequestCount < 1) {
  throw new Error('vision usage did not record a physical provider request')
}
if (!Number.isInteger(visionUsage.data.modelCallCount) || visionUsage.data.modelCallCount < 1) {
  throw new Error('vision provider response did not include attributable token metering')
}
if (!Number.isInteger(visionUsage.data.lastCall?.totalTokens) || visionUsage.data.lastCall.totalTokens < 1) {
  throw new Error('vision provider response did not include positive token usage')
}

const generatedAt = new Date().toISOString()
const report = {
  schemaVersion: 'anera-vision-task-smoke/1.0',
  generatedAt,
  productionBundle: true,
  liveProvider: true,
  providerFixture: false,
  provider: {
    name: 'DeepSeek',
    api: 'OpenAI-compatible chat/completions',
    requestImageTransport: 'image_url data URL',
  },
  requiredVisionModel,
  sessionId: session.id,
  status: snapshot.session.status,
  usage: snapshot.session.usage,
  visionUsage: visionUsageEvents.map((event) => ({
    source: event.data.source,
    model: event.data.model,
    modelRequestCount: event.data.modelRequestCount,
    modelCallCount: event.data.modelCallCount,
    estimatedCostUsd: event.data.estimatedCostUsd,
    estimatedCostStatus: event.data.estimatedCostStatus,
    tokens: event.data.lastCall,
  })),
  checks: {
    completed: snapshot.session.status === 'completed',
    requiredVisionModelUsed: visionUsageEvents.every((event) => event.data.model === requiredVisionModel),
    physicalVisionRequestRecorded: visionUsage.data.modelRequestCount >= 1,
    meteredVisionCallRecorded: visionUsage.data.modelCallCount >= 1,
    positiveVisionTokenUsage: visionUsage.data.lastCall.totalTokens >= 1,
    requiredToolsCompleted: toolCompletions.includes('inspect_image')
      && toolCompletions.includes('browser')
      && toolCompletions.includes('write_file')
      && toolCompletions.includes('start_process'),
    dashboardArtifactCreated: Boolean(artifact),
  },
  completedTools: toolCompletions,
  artifact: artifact.path,
  website: snapshot.website,
  passed: true,
}
const reportDir = resolve(process.cwd(), 'reports/real-smokes')
await mkdir(reportDir, { recursive: true })
const reportPath = resolve(reportDir, `vision-task-${generatedAt.replace(/[:.]/g, '-')}.json`)
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ reportPath, ...report }, null, 2))
