import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_TEST_URL || 'http://127.0.0.1:4174'
const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((response) => response.json())
const id = created.session.id
const prompt = `Create a single-file index.html containing:
- heading "Browser Form E2E";
- a text input with visible label and aria-label "Name";
- a select with aria-label "Plan" and values basic and pro;
- a checkbox with aria-label "Accept terms";
- a button with text "Submit".
On Submit, render an element whose exact text is name|plan|accepted when checked, so the requested interaction produces Alice|pro|accepted. No external dependencies.
Publish and open the Website. Use the stable refs from the browser snapshot to fill Name with Alice, select pro, check Accept terms, and click Submit. Verify the rendered result, scroll down by 300 pixels, and check the console. Do not claim success from source code alone.`
await fetch(`${base}/api/sessions/${id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: prompt, attachments: [] }),
})

const deadline = Date.now() + 180_000
let terminal
while (Date.now() < deadline) {
  const snapshot = await fetch(`${base}/api/sessions/${id}`).then((response) => response.json())
  if (['completed', 'failed', 'cancelled', 'timed_out'].includes(snapshot.session.status)) {
    terminal = snapshot
    break
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
}
const browserCalls = terminal?.events?.filter((event) => event.type === 'tool.started' && event.data?.call?.name === 'browser') ?? []
const actions = browserCalls.map((event) => event.data.call.arguments.action)
const refsByAction = Object.fromEntries(browserCalls
  .filter((event) => ['fill', 'select', 'check', 'click'].includes(event.data.call.arguments.action))
  .map((event) => [event.data.call.arguments.action, event.data.call.arguments.ref]))
const report = {
  sessionId: id,
  status: terminal?.session?.status,
  durationMs: terminal?.session?.usage?.durationMs,
  activeDurationMs: terminal?.session?.usage?.activeDurationMs,
  estimatedCostUsd: terminal?.session?.usage?.estimatedCostUsd,
  modelCalls: terminal?.session?.usage?.modelCalls,
  toolCalls: terminal?.session?.usage?.toolCalls,
  totalTokens: terminal?.session?.usage?.totalTokens,
  cachedPromptTokens: terminal?.session?.usage?.cachedPromptTokens,
  browserActions: actions,
  refsByAction,
}
const required = ['open', 'fill', 'select', 'check', 'click', 'scroll', 'console']
const passed = report.status === 'completed'
  && required.every((action) => actions.includes(action))
  && ['fill', 'select', 'check'].every((action) => /^e\d+$/.test(String(refsByAction[action] || '')))
  && terminal?.events?.some((event) => event.type === 'tool.completed' && event.data.call?.name === 'browser' && String(event.data.result).includes('Alice|pro|accepted'))
const durableReport = { ...report, passed }
await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
const reportPath = resolve('reports', 'real-smokes', `browser-form-${id}.json`)
await writeFile(reportPath, `${JSON.stringify(durableReport, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ...durableReport, reportPath }, null, 2))
if (!passed) process.exitCode = 1
