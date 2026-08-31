import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_TEST_URL || 'http://127.0.0.1:4174'

const created = await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}).then((response) => response.json())
const id = created.session.id
const prompt = `Use bash to run this exact foreground command and wait for it to complete:
python3 -u -c "import time; print('START', flush=True); time.sleep(60); print('DONE')"
Do not turn it into a background process.`
await fetch(`${base}/api/sessions/${id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: prompt, attachments: [] }),
})

let sawTool = false
for (let index = 0; index < 60; index += 1) {
  const snapshot = await fetch(`${base}/api/sessions/${id}`).then((response) => response.json())
  sawTool = snapshot.events.some((event) => event.type === 'tool.started' && event.data?.call?.name === 'bash')
  if (sawTool) break
  await new Promise((resolve) => setTimeout(resolve, 250))
}

const stopStartedAt = Date.now()
const stopResponse = await fetch(`${base}/api/sessions/${id}/stop`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})
if (!stopResponse.ok) throw new Error(`Stop failed: ${stopResponse.status} ${await stopResponse.text()}`)

let terminal
let terminalAt
for (let index = 0; index < 60; index += 1) {
  const snapshot = await fetch(`${base}/api/sessions/${id}`).then((response) => response.json())
  if (['cancelled', 'failed', 'completed'].includes(snapshot.session.status)) {
    terminal = snapshot
    terminalAt = Date.now()
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}

const toolFailure = terminal?.events?.find((event) => event.type === 'tool.failed')
const runTerminal = terminal?.events?.findLast((event) => event.type === 'run.status')
const stopToTerminalMs = terminalAt ? terminalAt - stopStartedAt : undefined
const passed = sawTool
  && terminal?.session?.status === 'cancelled'
  && String(toolFailure?.data?.result).includes('Command cancelled')
  && Number(toolFailure?.seq) < Number(runTerminal?.seq)
  && Number(stopToTerminalMs) < 2_000
const report = {
  sessionId: id,
  sawBashTool: sawTool,
  status: terminal?.session?.status,
  stopToTerminalMs,
  toolFailureSeq: toolFailure?.seq,
  runTerminalSeq: runTerminal?.seq,
  toolResult: toolFailure?.data?.result,
  finalEventTypes: terminal?.events?.slice(-6).map((event) => event.type),
  passed,
}
const reports = resolve('reports', 'real-smokes')
const reportPath = resolve(reports, `cancel-${id}.json`)
await mkdir(reports, { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
report.reportPath = reportPath
console.log(JSON.stringify(report, null, 2))

if (!passed) {
  process.exitCode = 1
}
