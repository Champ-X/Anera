import './legacy-live-test-disabled.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_BASE_URL || 'http://127.0.0.1:4174'
const firstMarker = 'MULTITURN-PAGE-ONE-184'
const bridgeMarker = 'MULTITURN-BRIDGE-512'
const secondMarker = 'MULTITURN-PAGE-TWO-927'
const document = minimalPdf([firstMarker, secondMarker])

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const { session } = await createResponse.json()

const uploadResponse = await fetch(`${base}/api/sessions/${session.id}/files`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'multiturn-routing.pdf',
    mime: 'application/pdf',
    contentBase64: document.toString('base64'),
  }),
})
if (!uploadResponse.ok) throw new Error(`upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`)
const uploaded = await uploadResponse.json()

const firstSubmit = await submit({
  attachments: [uploaded.path],
  content: '只使用专用附件读取工具读取上传 PDF 的第一页，明确设置 page_start=1 和 page_end=1；不要读取第二页，不要联网或使用 Bash。最终只回答第一页中以 MULTITURN 开头的 marker。',
})
const firstSnapshot = await waitForTerminal()
assertCompleted(firstSnapshot, 'first turn')
const firstCalls = toolCallsForTurn(firstSnapshot, firstSubmit.turnId)
const firstAttachmentCalls = firstCalls.filter((call) => call.name === 'extract_attachment')
if (firstAttachmentCalls.length < 1 || !firstAttachmentCalls.some((call) => call.arguments?.page_start === 1 && call.arguments?.page_end === 1)) {
  throw new Error(`first turn did not use the bounded attachment reader: ${JSON.stringify(firstCalls)}`)
}
const firstFinal = finalForTurn(firstSnapshot, firstSubmit.turnId)
if (firstFinal.trim() !== firstMarker) throw new Error(`first turn returned the wrong marker: ${firstFinal}`)

const bridgeSubmit = await submit({
  attachments: [],
  content: `继续上一轮；这一轮不要使用任何工具。最终只回答 ${bridgeMarker}。`,
})
const bridgeSnapshot = await waitForTerminal()
assertCompleted(bridgeSnapshot, 'bridge turn')
const bridgeCalls = toolCallsForTurn(bridgeSnapshot, bridgeSubmit.turnId)
if (bridgeCalls.length !== 0) throw new Error(`bridge turn unexpectedly used tools: ${JSON.stringify(bridgeCalls)}`)
const bridgeFinal = finalForTurn(bridgeSnapshot, bridgeSubmit.turnId)
if (bridgeFinal.trim() !== bridgeMarker) throw new Error(`bridge turn returned the wrong marker: ${bridgeFinal}`)

const secondSubmit = await submit({
  attachments: [],
  // Deliberately omit PDF/document/attachment/path terms. The immediately
  // preceding continuation did not call any tool, so the router must walk the
  // whole continuation chain back to the original attachment task.
  content: '继续上一轮；不要联网或使用 Bash。现在只读取第二页，明确使用 page_start=2 和 page_end=2。最终只回答该页中以 MULTITURN 开头的 marker。',
})
const secondSnapshot = await waitForTerminal()
assertCompleted(secondSnapshot, 'second turn')
const secondCalls = toolCallsForTurn(secondSnapshot, secondSubmit.turnId)
const secondAttachmentCalls = secondCalls.filter((call) => call.name === 'extract_attachment')
if (secondAttachmentCalls.length < 1 || !secondAttachmentCalls.some((call) => call.arguments?.page_start === 2 && call.arguments?.page_end === 2)) {
  throw new Error(`continued turn lost extract_attachment or used the wrong page: ${JSON.stringify(secondCalls)}`)
}
if (secondCalls.some((call) => ['bash', 'shell_command', 'web_fetch', 'web_search'].includes(call.name))) {
  throw new Error(`continued turn violated local-only constraints: ${JSON.stringify(secondCalls)}`)
}
const secondFinal = finalForTurn(secondSnapshot, secondSubmit.turnId)
if (secondFinal.trim() !== secondMarker) throw new Error(`second turn returned the wrong marker: ${secondFinal}`)

const report = {
  sessionId: session.id,
  status: secondSnapshot.session.status,
  documentBytes: document.length,
  turns: [
    { turnId: firstSubmit.turnId, calls: firstCalls, final: firstFinal },
    { turnId: bridgeSubmit.turnId, calls: bridgeCalls, final: bridgeFinal },
    { turnId: secondSubmit.turnId, calls: secondCalls, final: secondFinal },
  ],
  usage: secondSnapshot.session.usage,
  oracle: {
    multiHopPriorExtensionRecovered: true,
    toolFreeBridgePreserved: true,
    exactPageBounds: true,
    unrelatedNetworkAndShellCalls: false,
    exactFinals: true,
  },
}
console.log(JSON.stringify(report, null, 2))
await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
await writeFile(
  resolve('reports', 'real-smokes', `multiturn-tool-routing-${session.id}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
)

async function submit(body) {
  const response = await fetch(`${base}/api/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`submit failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function waitForTerminal() {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/sessions/${session.id}`)
    if (!response.ok) throw new Error(`snapshot failed: ${response.status}`)
    const snapshot = await response.json()
    if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)) return snapshot
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  throw new Error('session did not reach a terminal state before the smoke deadline')
}

function assertCompleted(snapshot, label) {
  if (snapshot.session.status !== 'completed') {
    throw new Error(`${label} ended as ${snapshot.session.status}: ${JSON.stringify(snapshot.events.slice(-5), null, 2)}`)
  }
}

function toolCallsForTurn(snapshot, turnId) {
  return snapshot.events
    .filter((event) => event.type === 'tool.started' && event.turnId === turnId)
    .map((event) => event.data?.call)
    .filter(Boolean)
}

function finalForTurn(snapshot, turnId) {
  return snapshot.events.findLast((event) => event.type === 'assistant.final' && event.turnId === turnId)?.data?.content || ''
}

function minimalPdf(pageTexts) {
  const objects = []
  const pageObjectIds = pageTexts.map((_text, index) => 4 + index * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pageTexts.forEach((text, index) => {
    const pageId = pageObjectIds[index]
    const contentId = pageId + 1
    const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
    const stream = `BT /F1 16 Tf 72 720 Td (${escaped}) Tj ET`
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
