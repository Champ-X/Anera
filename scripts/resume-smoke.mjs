const base = process.env.ANERA_TEST_URL || 'http://127.0.0.1:4174'
const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((response) => response.json())
const id = created.session.id
const prompt = `Use bash to run this exact foreground command:
python3 -u -c "import time; print('RESUME_TEST_STARTED', flush=True); time.sleep(30); open('natural.txt','w').write('natural')"
If this command is cancelled, do not rerun it. When the user uses Continue, create resumed.txt with exact content resumed-after-cancel plus an LF, verify it, and finish.`
await fetch(`${base}/api/sessions/${id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: prompt, attachments: [] }),
})

let sawBash = false
for (let index = 0; index < 120; index += 1) {
  const snapshot = await fetch(`${base}/api/sessions/${id}`).then((response) => response.json())
  sawBash = snapshot.events.some((event) => event.type === 'tool.started' && event.data.call?.name === 'bash')
  if (sawBash) break
  await new Promise((resolveWait) => setTimeout(resolveWait, 100))
}
if (!sawBash) throw new Error('bash tool did not start')
await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

let cancelled
for (let index = 0; index < 100; index += 1) {
  const snapshot = await fetch(`${base}/api/sessions/${id}`).then((response) => response.json())
  if (snapshot.session.status === 'cancelled') { cancelled = snapshot; break }
  await new Promise((resolveWait) => setTimeout(resolveWait, 100))
}
if (!cancelled) throw new Error('run did not settle as cancelled')
const resumeResponse = await fetch(`${base}/api/sessions/${id}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
if (!resumeResponse.ok) throw new Error(`resume failed: ${resumeResponse.status} ${await resumeResponse.text()}`)

const deadline = Date.now() + 120_000
let completed
while (Date.now() < deadline) {
  const snapshot = await fetch(`${base}/api/sessions/${id}`).then((response) => response.json())
  if (['completed', 'failed', 'cancelled', 'timed_out'].includes(snapshot.session.status)) {
    completed = snapshot
    break
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 250))
}
const resumedArtifact = completed?.artifacts?.find((artifact) => artifact.path === 'resumed.txt')
const naturalArtifact = completed?.artifacts?.find((artifact) => artifact.path === 'natural.txt')
const report = {
  sessionId: id,
  cancelledStatus: cancelled.session.status,
  finalStatus: completed?.session?.status,
  resumeEvents: completed?.events?.filter((event) => event.type === 'run.resumed').length,
  resumedArtifact: resumedArtifact?.path,
  naturalArtifact: naturalArtifact?.path,
  final: completed?.events?.findLast((event) => event.type === 'assistant.final')?.data?.content,
}
console.log(JSON.stringify(report, null, 2))
if (report.finalStatus !== 'completed' || report.resumeEvents !== 1 || !resumedArtifact || naturalArtifact) process.exitCode = 1
