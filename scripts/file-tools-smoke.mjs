import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_BASE_URL || 'http://127.0.0.1:4174'

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const { session } = await createResponse.json()

async function submitAndWait(content) {
  const response = await fetch(`${base}/api/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, attachments: [] }),
  })
  if (!response.ok) throw new Error(`submit failed: ${response.status} ${await response.text()}`)
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const snapshotResponse = await fetch(`${base}/api/sessions/${session.id}`)
    if (!snapshotResponse.ok) throw new Error(`snapshot failed: ${snapshotResponse.status}`)
    const snapshot = await snapshotResponse.json()
    if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)) {
      if (snapshot.session.status !== 'completed') throw new Error(`turn ended as ${snapshot.session.status}`)
      return snapshot
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  throw new Error('turn did not finish before the smoke deadline')
}

await submitAndWait(`Use write_file exactly twice and do not use bash or edit_file. Create:
1. config.ts with these exact bytes:
export const mode   = "draft";
export const count = 1;
2. temp-delete.txt with exact content "delete-me" followed by one newline.
Finish after both write_file calls succeed.`)

await submitAndWait(`Use edit_file exactly once and do not use bash or write_file. Edit config.ts with context exactly:
export const mode = "draft";
and replacement exactly:
export const mode = "ready";
The stored file deliberately has different internal whitespace, so edit_file must still succeed without rereading or rewriting the whole file. Finish after the edit succeeds.`)

await submitAndWait(`Use edit_file exactly once to change "export const count = 1;" to "export const count = 2;" in config.ts while preserving the ready mode line. Then use write_file exactly once to create summary.txt with exactly two LF-terminated lines:
mode=ready
count=2
Do not use bash. Finish after both tools succeed.`)

const deleteCommand = 'rm temp-delete.txt'
const snapshot = await submitAndWait(`Use bash exactly once with command ${JSON.stringify(deleteCommand)}, cwd /home/user, and timeout 30 to delete temp-delete.txt. Then use list_files exactly once and read_file exactly twice to verify temp-delete.txt is absent and config.ts plus summary.txt have the required final content. Do not use any legacy file mutation tool. Finish with a concise verification.`)

const completed = snapshot.events.filter((event) => event.type === 'tool.completed')
const started = snapshot.events.filter((event) => event.type === 'tool.started')
const failed = snapshot.events.filter((event) => event.type === 'tool.failed')
const unexpectedFailures = failed
const names = completed.map((event) => event.data.call?.name)
const editEvent = completed.find((event) => event.data.call?.name === 'edit_file')
const editResult = JSON.parse(editEvent?.data.result || '{}')
const deleteEvent = completed.find((event) => (
  event.data.call?.name === 'bash' && event.data.call?.arguments?.command === deleteCommand
))
const deleteResult = JSON.parse(deleteEvent?.data.result || '{}')

const configArtifact = snapshot.artifacts.find((artifact) => artifact.path === 'config.ts')
const summaryArtifact = snapshot.artifacts.find((artifact) => artifact.path === 'summary.txt')
if (!configArtifact || !summaryArtifact) throw new Error('final text artifacts are missing')
const configText = await fetch(`${base}${configArtifact.previewUrl}`).then((response) => response.text())
const summaryText = await fetch(`${base}${summaryArtifact.previewUrl}`).then((response) => response.text())

const canonicalResponse = await fetch(`${base}/api/sessions/${session.id}/canonical.jsonl?task_id=FILE-TOOLS-SMOKE`)
if (!canonicalResponse.ok) throw new Error(`canonical export failed: ${canonicalResponse.status}`)
const canonical = (await canonicalResponse.text()).trim().split('\n').map((line) => JSON.parse(line))
const canonicalTools = canonical
  .filter((record) => record.recordType === 'event' && record.event.kind === 'tool' && record.event.phase === 'completed')
  .map((record) => record.event.tool?.name)

const final = snapshot.events.findLast((event) => event.type === 'assistant.final')?.data?.content || ''
const requiredRaw = ['write_file', 'edit_file', 'bash', 'list_files', 'read_file']
const requiredCanonical = ['file_write', 'file_edit', 'shell', 'file_list', 'file_read']
const passed = snapshot.session.status === 'completed'
  && requiredRaw.every((name) => names.includes(name))
  && requiredCanonical.every((name) => canonicalTools.includes(name))
  && !started.some((event) => ['create_file', 'apply_patch', 'delete_file', 'shell_command'].includes(event.data.call?.name))
  && unexpectedFailures.length === 0
  && editResult.status === 'success'
  && deleteResult.status === 'completed'
  && deleteResult.exit_code === 0
  && configText === 'export const mode = "ready";\nexport const count = 2;\n'
  && summaryText === 'mode=ready\ncount=2\n'
  && !snapshot.artifacts.some((artifact) => artifact.path === 'temp-delete.txt')
const report = {
  sessionId: session.id,
  status: snapshot.session.status,
  durationMs: snapshot.session.usage.durationMs,
  modelCalls: snapshot.session.usage.modelCalls,
  toolCalls: snapshot.session.usage.toolCalls,
  totalTokens: snapshot.session.usage.totalTokens,
  estimatedCostUsd: snapshot.session.usage.estimatedCostUsd,
  tools: names,
  failedTools: failed.map((event) => event.data.call?.name),
  unexpectedFailedTools: unexpectedFailures.map((event) => event.data.call?.name),
  editResult,
  deleteResult,
  canonicalTools,
  configText,
  summaryText,
  final,
  passed,
}
await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
const reportPath = resolve('reports', 'real-smokes', `file-tools-${session.id}.json`)
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ...report, reportPath }, null, 2))

if (!passed) process.exitCode = 1
