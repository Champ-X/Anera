import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_SMOKE_BASE || 'http://127.0.0.1:4174'

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const { session } = await createResponse.json()
const prompt = `In the empty workspace, exercise both Arena shell protocols exactly once:
1. Create sub/input.txt containing exactly INPUT_READY plus LF, using create_file rather than a shell.
2. Call bash exactly once with command "printf 'BASH_PROTOCOL_OK\\n'", description "Verify Arena bash protocol", timeout 5000, and workdir "sub".
3. Call shell_command exactly once with command "printf 'SHELL_COMMAND_OK\\n'" and workdir "sub".
Do not call any other shell, process, Web, package, build, or browser tool. Report both exact output markers only after both structured tool results succeed.`
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
const shellCalls = started.filter((call) => call?.name === 'shell_command')
if (bashCalls.length !== 1 || shellCalls.length !== 1) throw new Error(`expected one call to each shell protocol: ${JSON.stringify(started)}`)
if (failed.length !== 0) throw new Error(`shell protocol had failed tools: ${JSON.stringify(failed.map((event) => event.data))}`)
if (started.some((call) => !['create_file', 'bash', 'shell_command'].includes(call?.name))) throw new Error(`unexpected tool surface: ${JSON.stringify(started.map((call) => call?.name))}`)
if (JSON.stringify(bashCalls[0].arguments) !== JSON.stringify({ command: "printf 'BASH_PROTOCOL_OK\\n'", description: 'Verify Arena bash protocol', timeout: 5000, workdir: 'sub' })) {
  throw new Error(`bash arguments do not match Arena schema probe: ${JSON.stringify(bashCalls[0].arguments)}`)
}
if (JSON.stringify(shellCalls[0].arguments) !== JSON.stringify({ command: "printf 'SHELL_COMMAND_OK\\n'", workdir: 'sub' })) {
  throw new Error(`shell_command arguments do not match Arena schema probe: ${JSON.stringify(shellCalls[0].arguments)}`)
}
const bashResult = completed.find((event) => event.data.call?.name === 'bash')
const shellResult = completed.find((event) => event.data.call?.name === 'shell_command')
if (!bashResult || !shellResult) throw new Error('a shell protocol did not complete')
if (JSON.parse(bashResult.data.result).stdout !== 'BASH_PROTOCOL_OK\n') throw new Error(`unexpected bash result: ${bashResult.data.result}`)
if (JSON.parse(shellResult.data.result).stdout !== 'SHELL_COMMAND_OK\n') throw new Error(`unexpected shell_command result: ${shellResult.data.result}`)
const final = current.events.findLast((event) => event.type === 'assistant.final')?.data?.content || ''
if (!String(final).includes('BASH_PROTOCOL_OK') || !String(final).includes('SHELL_COMMAND_OK')) throw new Error(`Final omitted shell markers: ${final}`)

const canonicalResponse = await fetch(`${base}/api/sessions/${session.id}/canonical.jsonl?task_id=S01`)
if (!canonicalResponse.ok) throw new Error(`canonical trace failed: ${canonicalResponse.status}`)
const canonicalEvents = (await canonicalResponse.text()).trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.recordType === 'event').map((record) => record.event)
const canonicalShell = canonicalEvents.filter((event) => event.kind === 'tool' && event.action === 'shell' && event.status === 'succeeded')
if (canonicalShell.length !== 2) throw new Error(`canonical trace has ${canonicalShell.length} successful shell calls instead of 2`)
if (!canonicalShell.some((event) => event.tool?.arguments?.description === 'Verify Arena bash protocol' && event.tool?.arguments?.timeout === 5000)) {
  throw new Error('canonical bash arguments lost description or timeout')
}
if (!canonicalShell.some((event) => event.tool?.arguments?.workdir === 'sub' && event.tool?.result?.stdout === 'SHELL_COMMAND_OK')) {
  throw new Error('canonical shell_command workdir or result was not preserved')
}

const report = {
  sessionId: session.id,
  status: current.session.status,
  completedTools: completed.map((event) => event.data.call?.name),
  shellProtocols: ['bash', 'shell_command'],
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
