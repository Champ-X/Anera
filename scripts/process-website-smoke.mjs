const base = process.env.ANERA_SMOKE_BASE || 'http://127.0.0.1:4174'

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const { session } = await createResponse.json()
const submitResponse = await fetch(`${base}/api/sessions/${session.id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    content: 'Create index.html with the exact visible heading PROCESS WEBSITE READY and a button whose text changes from 0 to 1 when clicked. Create package.json with a build script that uses Node standard library to copy index.html to dist/index.html and a start script exactly `python3 -m http.server 43129 --bind 0.0.0.0`. Use build_project once, then build_and_start with description "process Website smoke". Use browser open without a path so it opens the published managed Website, click 0, verify 1, and check the console. Do not use Bash to start the server and keep the managed server running.',
    attachments: [],
  }),
})
if (!submitResponse.ok) throw new Error(`submit failed: ${submitResponse.status} ${await submitResponse.text()}`)

const deadline = Date.now() + 180_000
let snapshot
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/sessions/${session.id}`)
  snapshot = await response.json()
  if (['completed', 'failed', 'cancelled', 'timed_out'].includes(snapshot.session.status)) break
  await new Promise((resolveWait) => setTimeout(resolveWait, 750))
}
if (!snapshot || snapshot.session.status !== 'completed') throw new Error(`process Website task ended as ${snapshot?.session?.status || 'timeout'}`)
if (!snapshot.website.processId || snapshot.website.port !== 43129 || snapshot.website.status !== 'running') {
  throw new Error(`managed process was not projected as Website: ${JSON.stringify(snapshot.website)}`)
}
const completedTools = snapshot.events.filter((event) => event.type === 'tool.completed').map((event) => event.data.call?.name)
for (const required of ['build_project', 'build_and_start', 'browser']) {
  if (!completedTools.includes(required)) throw new Error(`required tool did not complete: ${required}`)
}
const buildStart = snapshot.events.find((event) => event.type === 'tool.completed' && event.data.call?.name === 'build_and_start')
const buildStartResult = JSON.parse(buildStart?.data?.result || '{}')
if (buildStartResult.status !== 'success' || buildStartResult.previewUrl !== snapshot.website.previewUrl || typeof buildStartResult.buildLatencyMs !== 'number') {
  throw new Error(`build_and_start result did not match Website state: ${JSON.stringify(buildStartResult)}`)
}
const initialProcessStart = snapshot.events.find((event) => event.type === 'process.started' && event.data.record?.id === snapshot.website.processId)
if (!initialProcessStart
  || initialProcessStart.turnId !== buildStart.turnId
  || initialProcessStart.stepId !== buildStart.stepId
  || initialProcessStart.callId !== buildStart.callId) {
  throw new Error(`initial Process event lost build_and_start correlation: ${JSON.stringify({ initialProcessStart, buildStart })}`)
}
const canonicalResponse = await fetch(`${base}/api/sessions/${session.id}/canonical.jsonl?task_id=U02`)
if (!canonicalResponse.ok) throw new Error(`canonical trace failed: ${canonicalResponse.status}`)
const canonicalEvents = (await canonicalResponse.text()).trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.recordType === 'event')
for (const action of ['build', 'website_start']) {
  if (!canonicalEvents.some((record) => record.event.kind === 'tool' && record.event.action === action && record.event.status === 'succeeded')) {
    throw new Error(`canonical trace is missing successful ${action}`)
  }
}
const beforeProcessId = snapshot.website.processId
const restartResponse = await fetch(`${base}/api/sessions/${session.id}/website/restart`, { method: 'POST' })
if (!restartResponse.ok) throw new Error(`Website restart failed: ${restartResponse.status} ${await restartResponse.text()}`)
const { website } = await restartResponse.json()
if (website.processId === beforeProcessId || website.port !== 43129 || website.status !== 'running' || website.restartCount !== 1) {
  throw new Error(`Website did not perform a real process restart: ${JSON.stringify(website)}`)
}
const pageResponse = await fetch(website.previewUrl)
const page = await pageResponse.text()
if (!pageResponse.ok || !page.includes('PROCESS WEBSITE READY')) throw new Error('restarted Website did not serve the workspace page')
const postRestartResponse = await fetch(`${base}/api/sessions/${session.id}`)
if (!postRestartResponse.ok) throw new Error(`post-restart snapshot failed: ${postRestartResponse.status}`)
const postRestart = await postRestartResponse.json()
const finalEvent = snapshot.events.findLast((event) => event.type === 'assistant.final')
const restartEvents = postRestart.events.filter((event) => (
  (event.type === 'website.updated' && ['restart', 'restarted'].includes(event.data.action))
  || (event.type === 'process.started' && event.data.record?.id === website.processId)
))
if (!finalEvent || restartEvents.length !== 3 || restartEvents.some((event) => (
  event.turnId !== finalEvent.turnId || event.stepId !== finalEvent.stepId || event.callId !== undefined
))) {
  throw new Error(`restart events lost terminal-turn correlation: ${JSON.stringify({ finalEvent, restartEvents })}`)
}
const postCanonicalResponse = await fetch(`${base}/api/sessions/${session.id}/canonical.jsonl?task_id=U02`)
if (!postCanonicalResponse.ok) throw new Error(`post-restart canonical trace failed: ${postCanonicalResponse.status}`)
const postCanonicalEvents = (await postCanonicalResponse.text()).trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.recordType === 'event')
const canonicalRestartEvents = postCanonicalEvents.filter((record) => (
  (record.event.kind === 'website' && ['restart', 'restarted'].includes(record.event.action))
  || (record.event.kind === 'process' && record.event.process?.id && record.event.process.id !== undefined)
))
if (canonicalRestartEvents.some((record) => !record.event.turnId)) throw new Error('canonical restart/process event lost turn identity')

console.log(JSON.stringify({
  sessionId: session.id,
  status: snapshot.session.status,
  durationMs: snapshot.session.usage.durationMs,
  modelCalls: snapshot.session.usage.modelCalls,
  toolCalls: snapshot.session.usage.toolCalls,
  totalTokens: snapshot.session.usage.totalTokens,
  cachedPromptTokens: snapshot.session.usage.cachedPromptTokens,
  estimatedCostUsd: snapshot.session.usage.estimatedCostUsd,
  beforeProcessId,
  afterProcessId: website.processId,
  port: website.port,
  restartCount: website.restartCount,
  completedTools,
  canonicalActions: ['build', 'website_start'],
  restartCorrelatedEvents: restartEvents.length,
}, null, 2))
