const base = process.env.ANERA_BASE_URL || 'http://127.0.0.1:4174'
const marker = 'FEATURE_ALPHA_731'

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

const prompt = `Do not use bash, list_files, or read_file. First call glob_files with path "uploads" to find only TypeScript files. Then call grep_files with path "uploads", glob "*.ts", pattern "${marker}", output_mode "content", and one context line before and after. Report the matched file, line number, and both context lines. The tool calls are required even though the attachment names are visible.`
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
const final = snapshot?.events?.findLast((event) => event.type === 'assistant.final')?.data?.content || ''
const report = {
  sessionId: session.id,
  status: snapshot?.session?.status,
  startedTools: started.map((call) => ({ name: call.name, arguments: call.arguments })),
  completedTools: completed.map((call) => call.name),
  modelCalls: snapshot?.session?.usage?.modelCalls,
  toolCalls: snapshot?.session?.usage?.toolCalls,
  totalTokens: snapshot?.session?.usage?.totalTokens,
  estimatedCostUsd: snapshot?.session?.usage?.estimatedCostUsd,
  final,
}
console.log(JSON.stringify(report, null, 2))

const names = completed.map((call) => call.name)
if (report.status !== 'completed'
  || !names.includes('glob_files')
  || !names.includes('grep_files')
  || started.some((call) => call.name === 'bash')
  || !final.includes('alpha-search.ts')
  || !final.includes('2')
  || !final.includes('before')
  || !final.includes('after')) {
  process.exitCode = 1
}
