import './legacy-live-test-disabled.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_SMOKE_BASE || 'http://127.0.0.1:4174'

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const { session } = await createResponse.json()
const prompt = `In the empty workspace, exercise the current Arena active Bash protocol exactly once:
1. Use write_file exactly once to create sub/input.txt containing exactly INPUT_READY plus LF.
2. Call bash exactly once with command "printf 'BASH_PROTOCOL_OK\\n'", cwd "sub", and timeout 30.
Do not call shell_command or any other shell, process, Web, package, build, or browser tool. After both structured tool results succeed, output exactly ACTIVE-BASH-PROTOCOL-OK BASH_PROTOCOL_OK and nothing else.`
const submitResponse = await fetch(`${base}/api/sessions/${session.id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: prompt, attachments: [] }),
})
if (!submitResponse.ok) throw new Error(`submit failed: ${submitResponse.status} ${await submitResponse.text()}`)

const deadline = Date.now() + 180_000
let current
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/sessions/${session.id}`)
  if (!response.ok) throw new Error(`snapshot failed: ${response.status}`)
  current = await response.json()
  if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(current.session.status)) break
  await new Promise((resolveWait) => setTimeout(resolveWait, 400))
}
if (!current || current.session.status !== 'completed') throw new Error(`shell protocol task ended as ${current?.session?.status || 'timeout'}`)

const started = current.events.filter((event) => event.type === 'tool.started').map((event) => event.data.call)
const completed = current.events.filter((event) => event.type === 'tool.completed')
const failed = current.events.filter((event) => ['tool.failed', 'tool.timed_out'].includes(event.type))
const bashCalls = started.filter((call) => call?.name === 'bash')
if (bashCalls.length !== 1) throw new Error(`expected one active Bash call: ${JSON.stringify(started)}`)
if (failed.length !== 0) throw new Error(`shell protocol had failed tools: ${JSON.stringify(failed.map((event) => event.data))}`)
if (started.some((call) => !['write_file', 'bash'].includes(call?.name))) throw new Error(`unexpected tool surface: ${JSON.stringify(started.map((call) => call?.name))}`)
if (JSON.stringify(bashCalls[0].arguments) !== JSON.stringify({ command: "printf 'BASH_PROTOCOL_OK\\n'", cwd: 'sub', timeout: 30 })) {
  throw new Error(`bash arguments do not match Arena schema probe: ${JSON.stringify(bashCalls[0].arguments)}`)
}
const bashResult = completed.find((event) => event.data.call?.name === 'bash')
if (!bashResult) throw new Error('the active Bash protocol did not complete')
if (JSON.parse(bashResult.data.result).stdout !== 'BASH_PROTOCOL_OK\n') throw new Error(`unexpected bash result: ${bashResult.data.result}`)
const final = current.events.findLast((event) => event.type === 'assistant.final')?.data?.content || ''
if (final !== 'ACTIVE-BASH-PROTOCOL-OK BASH_PROTOCOL_OK') throw new Error(`Final did not match the active Bash marker: ${final}`)

const canonicalResponse = await fetch(`${base}/api/sessions/${session.id}/canonical.jsonl?task_id=S01`)
if (!canonicalResponse.ok) throw new Error(`canonical trace failed: ${canonicalResponse.status}`)
const canonicalEvents = (await canonicalResponse.text()).trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.recordType === 'event').map((record) => record.event)
const canonicalShell = canonicalEvents.filter((event) => event.kind === 'tool' && event.action === 'shell' && event.status === 'succeeded')
if (canonicalShell.length !== 1) throw new Error(`canonical trace has ${canonicalShell.length} successful shell calls instead of 1`)
if (!canonicalShell.some((event) => event.tool?.arguments?.cwd === 'sub' && event.tool?.arguments?.timeout === 30 && event.tool?.result?.stdout === 'BASH_PROTOCOL_OK')) {
  throw new Error('canonical Bash cwd, timeout, or result was not preserved')
}

const report = {
  sessionId: session.id,
  status: current.session.status,
  completedTools: completed.map((event) => event.data.call?.name),
  shellProtocols: ['bash'],
  canonicalShellEvents: canonicalShell.length,
  durationMs: current.session.usage.durationMs,
  activeDurationMs: current.session.usage.activeDurationMs,
  modelCalls: current.session.usage.modelCalls,
  toolCalls: current.session.usage.toolCalls,
  totalTokens: current.session.usage.totalTokens,
  cachedPromptTokens: current.session.usage.cachedPromptTokens,
  estimatedCostUsd: current.session.usage.estimatedCostUsd,
  passed: true,
}
await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
const reportPath = resolve('reports', 'real-smokes', `shell-protocol-${session.id}.json`)
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ...report, reportPath }, null, 2))
