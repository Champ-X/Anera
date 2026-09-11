import './legacy-live-test-disabled.mjs'
const base = process.env.ANERA_BASE_URL || 'http://127.0.0.1:4174'

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const { session } = await createResponse.json()

const prompt = `Complete this four-step task in the empty workspace. You must use the platform's update_plan tool for the visible plan; do not create plan.md.

Before any file or shell action, call update_plan with exactly these four steps in this order, the first in_progress and the rest pending:
1. Create input.json
2. Create summarize.mjs
3. Run the summarizer
4. Verify summary.json

As execution advances, call update_plan again after every step so each step is visibly in_progress before becoming completed, at most one item is in_progress, and the final plan has all four completed.

Task details:
- input.json must contain {"values":[3,1,4,1,5]} as valid JSON.
- summarize.mjs must use only Node standard libraries, read input.json, and write summary.json.
- summary.json must parse to exactly {"count":5,"sum":14,"min":1,"max":5}, with no additional fields.
- Actually run the script and verify the result. Finish with a concise report and the three file paths.`

const submitResponse = await fetch(`${base}/api/sessions/${session.id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: prompt, attachments: [] }),
})
if (!submitResponse.ok) throw new Error(`submit failed: ${submitResponse.status} ${await submitResponse.text()}`)

const deadline = Date.now() + 240_000
let snapshot
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/sessions/${session.id}`)
  if (!response.ok) throw new Error(`snapshot failed: ${response.status}`)
  snapshot = await response.json()
  if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)) break
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
}
if (!snapshot || snapshot.session.status === 'running') throw new Error('plan smoke did not finish before the deadline')

const planEvents = snapshot.events.filter((event) => event.type === 'plan.updated')
const completedTools = snapshot.events.filter((event) => event.type === 'tool.completed')
const failedTools = snapshot.events.filter((event) => event.type === 'tool.failed')
const expectedSteps = ['Create input.json', 'Create summarize.mjs', 'Run the summarizer', 'Verify summary.json']
const statusHistory = Object.fromEntries(expectedSteps.map((step) => [
  step,
  planEvents.flatMap((event) => {
    const item = event.data.plan?.items?.find((candidate) => candidate.step === step)
    return item ? [{ id: item.id, status: item.status, version: event.data.plan.version }] : []
  }),
]))

const summaryArtifact = snapshot.artifacts.find((artifact) => artifact.path === 'summary.json')
const summaryText = summaryArtifact
  ? await fetch(`${base}${summaryArtifact.previewUrl}`).then((response) => response.text())
  : ''
let summaryJson
try { summaryJson = JSON.parse(summaryText) } catch { summaryJson = null }

const canonicalResponse = await fetch(`${base}/api/sessions/${session.id}/canonical.jsonl?task_id=PLAN-SMOKE`)
if (!canonicalResponse.ok) throw new Error(`canonical export failed: ${canonicalResponse.status}`)
const canonical = (await canonicalResponse.text()).trim().split('\n').map((line) => JSON.parse(line))
const canonicalPlanTools = canonical.filter((record) => (
  record.recordType === 'event'
  && record.event.kind === 'tool'
  && record.event.tool?.name === 'plan_update'
  && record.event.phase === 'completed'
))
const canonicalPlanEvents = canonical.filter((record) => record.recordType === 'event' && record.event.kind === 'plan')
const final = snapshot.events.findLast((event) => event.type === 'assistant.final')?.data?.content || ''

const stableIds = expectedSteps.every((step) => {
  const ids = new Set(statusHistory[step].map((observation) => observation.id))
  return ids.size === 1 && !ids.has(undefined)
})
const completeTransitions = expectedSteps.every((step) => {
  const statuses = statusHistory[step].map((observation) => observation.status)
  return statuses.includes('in_progress') && statuses.includes('completed')
})
const finalPlanComplete = snapshot.plan?.items.length === 4
  && snapshot.plan.items.every((item) => item.status === 'completed')
  && snapshot.plan.items.map((item) => item.step).join('\n') === expectedSteps.join('\n')
const summaryCorrect = JSON.stringify(summaryJson) === JSON.stringify({ count: 5, sum: 14, min: 1, max: 5 })

const report = {
  sessionId: session.id,
  status: snapshot.session.status,
  durationMs: snapshot.session.usage.durationMs,
  modelCalls: snapshot.session.usage.modelCalls,
  toolCalls: snapshot.session.usage.toolCalls,
  totalTokens: snapshot.session.usage.totalTokens,
  estimatedCostUsd: snapshot.session.usage.estimatedCostUsd,
  rawPlanToolCalls: completedTools.filter((event) => event.data.call?.name === 'update_plan').length,
  planSnapshots: planEvents.length,
  canonicalPlanToolCalls: canonicalPlanTools.length,
  canonicalPlanEvents: canonicalPlanEvents.length,
  stableIds,
  completeTransitions,
  finalPlan: snapshot.plan,
  statusHistory,
  summaryJson,
  failedTools: failedTools.map((event) => event.data.call?.name),
  final,
}
console.log(JSON.stringify(report, null, 2))

const passed = snapshot.session.status === 'completed'
  && planEvents.length >= 5
  && completedTools.filter((event) => event.data.call?.name === 'update_plan').length >= 5
  && canonicalPlanTools.length >= 5
  && canonicalPlanEvents.length >= 5
  && !failedTools.some((event) => event.data.call?.name === 'update_plan')
  && stableIds
  && completeTransitions
  && finalPlanComplete
  && summaryCorrect
if (!passed) process.exitCode = 1
