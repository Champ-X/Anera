import './legacy-live-test-disabled.mjs'
const base = process.env.ANERA_BASE_URL || 'http://127.0.0.1:4174'
const marker = 'ATTACHMENT-ONLY-OK-947'

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const session = (await createResponse.json()).session
const uploadResponse = await fetch(`${base}/api/sessions/${session.id}/files`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'attachment-only.txt',
    mime: 'text/plain',
    contentBase64: Buffer.from(`This is a synthetic attachment-only submission.\nMarker: ${marker}\n`).toString('base64'),
  }),
})
if (!uploadResponse.ok) throw new Error(`upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`)
const uploaded = await uploadResponse.json()
const submitResponse = await fetch(`${base}/api/sessions/${session.id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: '', attachments: [uploaded.path] }),
})
if (!submitResponse.ok) throw new Error(`attachment-only submit failed: ${submitResponse.status} ${await submitResponse.text()}`)

let snapshot
for (let attempt = 0; attempt < 240; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  const response = await fetch(`${base}/api/sessions/${session.id}`)
  if (!response.ok) throw new Error(`snapshot failed: ${response.status}`)
  snapshot = await response.json()
  if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)) break
}
if (!snapshot || snapshot.session.status !== 'completed') throw new Error(`Attachment-only task ended as ${snapshot?.session?.status || 'timeout'}`)
const startedCalls = snapshot.events.filter((event) => event.type === 'tool.started').map((event) => event.data?.call).filter(Boolean)
const final = snapshot.events.findLast((event) => event.type === 'assistant.final')?.data?.content || ''
const turn = snapshot.events.find((event) => event.type === 'turn.started')
if (!startedCalls.some((call) => call.name === 'extract_attachment' || call.name === 'read_file')) {
  throw new Error(`Agent did not inspect the attachment: ${JSON.stringify(startedCalls)}`)
}
if (!final.includes(marker)) throw new Error(`Final missed ${marker}: ${final}`)
if (turn?.data?.content !== '' || turn?.data?.attachments?.[0] !== uploaded.path) {
  throw new Error(`Attachment-only user event was not preserved: ${JSON.stringify(turn)}`)
}

console.log(JSON.stringify({
  sessionId: session.id,
  status: snapshot.session.status,
  calls: startedCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
  modelCalls: snapshot.session.usage.modelCalls,
  toolCalls: snapshot.session.usage.toolCalls,
  totalTokens: snapshot.session.usage.totalTokens,
  cachedPromptTokens: snapshot.session.usage.cachedPromptTokens,
  estimatedCostUsd: snapshot.session.usage.estimatedCostUsd,
  final,
}, null, 2))
