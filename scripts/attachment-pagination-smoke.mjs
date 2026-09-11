import './legacy-live-test-disabled.mjs'
const base = process.env.ANERA_BASE_URL || 'http://127.0.0.1:4174'
const marker = 'PAGE-CURSOR-OK-731'
const document = minimalPdf([`${'A'.repeat(125_000)}${marker}`])

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const session = (await createResponse.json()).session
const uploadResponse = await fetch(`${base}/api/sessions/${session.id}/files`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'oversized-page.pdf',
    mime: 'application/pdf',
    contentBase64: document.toString('base64'),
  }),
})
if (!uploadResponse.ok) throw new Error(`upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`)
const uploaded = await uploadResponse.json()
const submitResponse = await fetch(`${base}/api/sessions/${session.id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    attachments: [uploaded.path],
    content: `只读取上传的 PDF，不要联网、不要使用 Bash、不要创建文件。完整读取第一页；如果工具返回 continuation，必须按返回的游标继续，直到该页读完。最终只回答文档末尾的 marker；它以 PAGE-CURSOR 开头，不得猜测。`,
  }),
})
if (!submitResponse.ok) throw new Error(`submit failed: ${submitResponse.status} ${await submitResponse.text()}`)

let snapshot
for (let attempt = 0; attempt < 300; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  const response = await fetch(`${base}/api/sessions/${session.id}`)
  if (!response.ok) throw new Error(`snapshot failed: ${response.status}`)
  snapshot = await response.json()
  if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)) break
}
if (!snapshot || snapshot.session.status !== 'completed') throw new Error(`Attachment pagination task ended as ${snapshot?.session?.status || 'timeout'}`)
const calls = snapshot.events
  .filter((event) => event.type === 'tool.started')
  .map((event) => event.data?.call)
  .filter(Boolean)
const attachmentCalls = calls.filter((call) => call.name === 'extract_attachment')
const final = snapshot.events.findLast((event) => event.type === 'assistant.final')?.data?.content || ''
const usageCalls = snapshot.events
  .filter((event) => event.type === 'usage.updated' && event.data?.source === 'agent')
  .map((event) => event.data?.lastCall)
  .filter(Boolean)
const firstResult = snapshot.events.find((event) => (
  event.type === 'tool.completed' && event.data?.call?.name === 'extract_attachment'
))?.data?.result || ''
const returnedCursor = Number(firstResult.match(/content_offset=(\d+)/)?.[1])
if (attachmentCalls.length < 2) throw new Error(`Expected at least two attachment reads: ${JSON.stringify(attachmentCalls)}`)
if (!Number.isInteger(returnedCursor) || returnedCursor < 1) {
  throw new Error(`First extraction did not return an exact content_offset cursor: ${firstResult.slice(-500)}`)
}
if (!attachmentCalls.some((call) => Number(call.arguments?.content_offset) === returnedCursor)) {
  throw new Error(`Agent did not follow the content_offset continuation: ${JSON.stringify(attachmentCalls)}`)
}
if (calls.some((call) => ['bash', 'web_fetch', 'web_search', 'search_web'].includes(call.name))) {
  throw new Error(`Agent violated local-only constraints: ${JSON.stringify(calls.map((call) => call.name))}`)
}
if (final.trim() !== marker) throw new Error(`Final was not the exact requested marker ${marker}: ${final}`)

console.log(JSON.stringify({
  sessionId: session.id,
  status: snapshot.session.status,
  documentBytes: document.length,
  attachmentCalls: attachmentCalls.map((call) => call.arguments),
  modelCalls: snapshot.session.usage.modelCalls,
  toolCalls: snapshot.session.usage.toolCalls,
  activeDurationMs: snapshot.session.usage.activeDurationMs,
  promptTokens: snapshot.session.usage.promptTokens,
  completionTokens: snapshot.session.usage.completionTokens,
  totalTokens: snapshot.session.usage.totalTokens,
  cachedPromptTokens: snapshot.session.usage.cachedPromptTokens,
  estimatedCostUsd: snapshot.session.usage.estimatedCostUsd,
  perCallUsage: usageCalls,
  contextCompactions: snapshot.events.filter((event) => event.type === 'context.compacted').length,
  oracle: { exactCursor: true, exactFinal: true, localOnly: true },
  final,
}, null, 2))

function minimalPdf(pageTexts) {
  const objects = []
  const pageObjectIds = pageTexts.map((_text, index) => 4 + index * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pageTexts.forEach((text, index) => {
    const pageId = pageObjectIds[index]
    const contentId = pageId + 1
    const textRuns = text.match(/[\s\S]{1,50}/g) || ['']
    const operators = textRuns.map((run) => {
      const escaped = run.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
      return `BT /F1 1 Tf 72 720 Td (${escaped}) Tj ET`
    }).join(' ')
    const stream = operators
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id += 1) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
