const base = process.env.ANERA_SMOKE_BASE || 'http://127.0.0.1:4174'

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const { session } = await createResponse.json()
const lines = Array.from({ length: 900 }, (_, index) => {
  const number = String(index + 1).padStart(4, '0')
  return `FACT-${number}: synthetic checkpoint evidence row ${number}; category=${(index % 7) + 1}; marker=ANERA-LONG-CONTEXT.`
})
lines[0] += ' FIRST_SENTINEL=731.'
lines[lines.length - 1] += ' LAST_SENTINEL=947.'
const source = `${lines.join('\n')}\n`
const uploadResponse = await fetch(`${base}/api/sessions/${session.id}/files`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'long-evidence.txt', mime: 'text/plain', contentBase64: Buffer.from(source).toString('base64') }),
})
if (!uploadResponse.ok) throw new Error(`upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`)
const uploaded = await uploadResponse.json()
const submitResponse = await fetch(`${base}/api/sessions/${session.id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    attachments: [uploaded.path],
    content: 'Use extract_attachment to read the uploaded long-evidence.txt. Create digest.md containing the exact first and last FACT IDs, both sentinel values, the total row count, and counts per category. Then read digest.md back, use bash to independently verify the source row count and both sentinels, and only then finish. Do not use the web.',
  }),
})
if (!submitResponse.ok) throw new Error(`submit failed: ${submitResponse.status} ${await submitResponse.text()}`)

const deadline = Date.now() + 240_000
let snapshot
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/sessions/${session.id}`)
  snapshot = await response.json()
  if (['completed', 'failed', 'cancelled', 'timed_out'].includes(snapshot.session.status)) break
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
}
if (!snapshot || snapshot.session.status !== 'completed') throw new Error(`compaction task ended as ${snapshot?.session?.status || 'timeout'}`)
const checkpoints = snapshot.events.filter((event) => event.type === 'context.compacted')
const compactionUsage = snapshot.events.filter((event) => event.type === 'usage.updated' && event.data.source === 'compaction')
const compactionFailures = snapshot.events.filter((event) => event.type === 'context.compaction.failed')
const completedTools = snapshot.events.filter((event) => event.type === 'tool.completed')
const largeToolResult = completedTools.find((event) => {
  const result = typeof event.data.result === 'string' ? event.data.result : JSON.stringify(event.data.result ?? '')
  return Buffer.byteLength(result) >= 60_000
})
if (!largeToolResult) throw new Error('the task did not produce the expected large tool result')

const agentUsage = snapshot.events.filter((event) => event.type === 'usage.updated' && event.data.source === 'agent')
const consumingUsage = agentUsage.find((event) => event.seq > largeToolResult.seq)
if (!consumingUsage) throw new Error('the large tool result was never consumed by a later model call')
const laterPromptTokens = agentUsage
  .filter((event) => event.seq > consumingUsage.seq)
  .map((event) => event.data.lastCall?.promptTokens)
  .filter((value) => Number.isFinite(value))

let contextStrategy
if (checkpoints.length) {
  contextStrategy = 'model_checkpoint'
  if (compactionUsage.length < checkpoints.length) throw new Error('a model checkpoint was not paired with compaction usage')
  if (checkpoints.some((event) => event.data.afterBytes >= event.data.beforeBytes)) {
    throw new Error('a checkpoint did not reduce persisted context bytes')
  }
} else {
  contextStrategy = 'consumed_tool_result_compaction'
  if (compactionFailures.length) throw new Error('context compaction failed without producing a usable checkpoint')
  if (!laterPromptTokens.length) throw new Error('no model request followed consumption of the large tool result')
  if (laterPromptTokens.some((value) => value >= 12_000)) {
    throw new Error(`consumed large tool result kept bloating later prompts: ${laterPromptTokens.join(', ')}`)
  }
}

const toolCompletions = completedTools.map((event) => event.data.call?.name)
for (const required of ['extract_attachment', 'create_file', 'read_file']) {
  if (!toolCompletions.includes(required)) throw new Error(`required continuation tool did not complete: ${required}`)
}
const completedShells = completedTools.filter((event) => ['bash', 'shell_command'].includes(event.data.call?.name))
if (!completedShells.length) throw new Error('neither bash nor shell_command completed successfully')
const verifiedShell = completedShells.find((event) => {
  const result = typeof event.data.result === 'string' ? event.data.result : JSON.stringify(event.data.result ?? '')
  return ['FACT-0001', 'FACT-0900', '731', '947', '900'].every((value) => result.includes(value))
})
if (!verifiedShell) throw new Error('no successful shell result independently verified the row count and sentinels')
const artifact = snapshot.artifacts.find((item) => item.path === 'digest.md')
if (!artifact) throw new Error('digest.md was not persisted')
const digestResponse = await fetch(`${base}${artifact.previewUrl}`)
const digest = await digestResponse.text()
for (const expected of ['FACT-0001', 'FACT-0900', '731', '947', '900']) {
  if (!digest.includes(expected)) throw new Error(`digest.md missed expected value ${expected}`)
}
for (let category = 1; category <= 7; category += 1) {
  const expectedCount = category <= 4 ? 129 : 128
  const pair = new RegExp(`(?:category\\s*[=:]\\s*)?\\b${category}\\b[^\\d\\r\\n]{1,24}\\b${expectedCount}\\b`, 'i')
  if (!pair.test(digest)) throw new Error(`digest.md missed category ${category} count ${expectedCount}`)
}

console.log(JSON.stringify({
  sessionId: session.id,
  status: snapshot.session.status,
  durationMs: snapshot.session.usage.durationMs,
  modelCalls: snapshot.session.usage.modelCalls,
  toolCalls: snapshot.session.usage.toolCalls,
  totalTokens: snapshot.session.usage.totalTokens,
  estimatedCostUsd: snapshot.session.usage.estimatedCostUsd,
  contextStrategy,
  largeToolResult: {
    tool: largeToolResult.data.call?.name,
    bytes: Buffer.byteLength(typeof largeToolResult.data.result === 'string' ? largeToolResult.data.result : JSON.stringify(largeToolResult.data.result ?? '')),
    consumingPromptTokens: consumingUsage.data.lastCall?.promptTokens,
    laterPromptTokens,
  },
  checkpoints: checkpoints.map((event) => ({
    compactedMessageCount: event.data.compactedMessageCount,
    retainedMessageCount: event.data.retainedMessageCount,
    reason: event.data.reason,
    forced: event.data.forced,
    beforeBytes: event.data.beforeBytes,
    afterBytes: event.data.afterBytes,
  })),
  compactionCalls: compactionUsage.length,
  compactionFailures: compactionFailures.length,
  tools: toolCompletions,
  verifyingShell: verifiedShell.data.call?.name,
  artifact: artifact.path,
}, null, 2))
