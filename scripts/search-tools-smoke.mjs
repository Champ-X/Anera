import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_BASE_URL || 'http://127.0.0.1:4174'
const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/real-smokes')
const marker = 'FEATURE_ALPHA_731'
const expectedCommand = `grep -n -B1 -A1 "${marker}" uploads/*.ts`
const expectedFinal = 'SEARCH-TOOLS-OK alpha-search.ts:2 before=export const before = 1 after=export const after = 3'

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const session = (await createResponse.json()).session

const attachments = []
for (const file of [
  { name: 'alpha-search.ts', content: `export const before = 1\nexport const marker = '${marker}'\nexport const after = 3\n` },
  { name: 'beta-search.ts', content: 'export const beta = true\n' },
  { name: 'search-notes.md', content: `${marker} appears in Markdown but must be excluded by the glob.\n` },
]) {
  const response = await fetch(`${base}/api/sessions/${session.id}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: file.name, mime: 'text/plain', contentBase64: Buffer.from(file.content).toString('base64') }),
  })
  if (!response.ok) throw new Error(`upload ${file.name} failed: ${response.status} ${await response.text()}`)
  attachments.push((await response.json()).path)
}

const prompt = `Exercise the current Arena active-tool search path in this exact order.

1. Call list_files exactly once with path "uploads". Do not call read_file, glob_files, or grep_files.
2. After list_files succeeds, call bash exactly once with command ${JSON.stringify(expectedCommand)}, cwd /home/user, and timeout 30. Do not substitute another command.
3. After bash succeeds, output exactly ${expectedFinal} and nothing else.

Both tool calls are required even though the attachment names are visible. Do not call any other tool.`
const submit = await fetch(`${base}/api/sessions/${session.id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: prompt, attachments }),
})
if (!submit.ok) throw new Error(`submit failed: ${submit.status} ${await submit.text()}`)

const deadline = Date.now() + 180_000
let snapshot
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/sessions/${session.id}`)
  if (!response.ok) throw new Error(`snapshot failed: ${response.status}`)
  snapshot = await response.json()
  if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)) break
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
}

const started = snapshot?.events?.filter((event) => event.type === 'tool.started').map((event) => event.data?.call).filter(Boolean) ?? []
const completed = snapshot?.events?.filter((event) => event.type === 'tool.completed').map((event) => event.data?.call).filter(Boolean) ?? []
const failed = snapshot?.events?.filter((event) => event.type === 'tool.failed').map((event) => event.data?.call).filter(Boolean) ?? []
const final = snapshot?.events?.findLast((event) => event.type === 'assistant.final')?.data?.content || ''
const usage = snapshot?.session?.usage ?? {}
const startedNames = started.map((call) => call.name)
const completedNames = completed.map((call) => call.name)
const checks = {
  sessionCompleted: snapshot?.session?.status === 'completed',
  exactStartedTools: JSON.stringify(startedNames) === JSON.stringify(['list_files', 'bash']),
  exactCompletedTools: JSON.stringify(completedNames) === JSON.stringify(['list_files', 'bash']),
  zeroFailedTools: failed.length === 0,
  exactListFilesArguments: started[0]?.name === 'list_files' && started[0]?.arguments?.path === 'uploads',
  exactBashArguments: started[1]?.name === 'bash'
    && started[1]?.arguments?.command === expectedCommand
    && started[1]?.arguments?.cwd === '/home/user'
    && started[1]?.arguments?.timeout === 30,
  exactFinal: final === expectedFinal,
  modelCallBudget: Number(usage.modelCalls) <= 4,
  exactToolCallBudget: Number(usage.toolCalls) === 2,
  estimatedCostBudget: Number(usage.estimatedCostUsd) <= 0.006,
}
const generatedAt = new Date().toISOString()
const report = {
  schemaVersion: 'anera-active-search-tools-smoke/1.0',
  generatedAt,
  productionBundle: true,
  modelExecution: 'real configured DeepSeek provider',
  providerFixture: false,
  arenaParityEvidence: false,
  activeToolPath: ['list_files', 'bash'],
  sessionId: session.id,
  model: snapshot?.session?.model,
  status: snapshot?.session?.status,
  prompt,
  startedTools: started.map((call) => ({ name: call.name, arguments: call.arguments })),
  completedTools: completedNames,
  failedTools: failed.map((call) => call.name),
  modelCalls: usage.modelCalls,
  toolCalls: usage.toolCalls,
  totalTokens: usage.totalTokens,
  estimatedCostUsd: usage.estimatedCostUsd,
  final,
  checks,
}
await mkdir(reportDirectory, { recursive: true })
const reportPath = resolve(reportDirectory, `active-search-tools-${generatedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`)
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ reportPath, ...report }, null, 2))

if (!Object.values(checks).every(Boolean)) {
  process.exitCode = 1
}
