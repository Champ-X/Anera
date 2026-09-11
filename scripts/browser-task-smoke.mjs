import './legacy-live-test-disabled.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_TEST_URL || 'http://127.0.0.1:4174'
const created = await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}).then((response) => response.json())
const id = created.session.id
const prompt = `Create a single-file index.html with heading "Browser Harness E2E", a visible count starting at 0, and a button with exact text "Increment" that increments the count by one on every click. No external dependencies.
Publish the Website, then use the browser tool to open it, click Increment exactly twice, verify the rendered text contains 2, set the viewport to 375×700 and inspect again, check browser console errors, and save browser-check.png. Fix any failed check before the final answer.`
await fetch(`${base}/api/sessions/${id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: prompt, attachments: [] }),
})

let terminal
for (let index = 0; index < 160; index += 1) {
  const snapshot = await fetch(`${base}/api/sessions/${id}`).then((response) => response.json())
  if (['completed', 'failed', 'cancelled'].includes(snapshot.session.status)) {
    terminal = snapshot
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}
const browserCalls = terminal?.events?.filter((event) => event.type === 'tool.started' && event.data?.call?.name === 'browser') ?? []
const actions = browserCalls.map((event) => event.data.call.arguments.action)
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
  workspaceFiles: terminal?.workspace?.map((entry) => entry.name),
}
const passed = report.status === 'completed' && actions.includes('open') && actions.filter((action) => action === 'click').length >= 2 && actions.includes('viewport') && actions.includes('console') && report.workspaceFiles?.includes('browser-check.png')
const durableReport = { ...report, passed }
await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
const reportPath = resolve('reports', 'real-smokes', `browser-task-${id}.json`)
await writeFile(reportPath, `${JSON.stringify(durableReport, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ...durableReport, reportPath }, null, 2))
if (!passed) process.exitCode = 1
