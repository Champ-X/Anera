import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_TEST_URL || 'http://127.0.0.1:4174'
const created = await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}).then((response) => response.json())
const id = created.session.id
const prompt = '使用 http_request 向 https://httpbin.org/status/204 发送 POST，JSON 为 {"probe":"anera-approval-deny"}。出现审批时等待，不得使用 bash 或其他工具绕过；如果拒绝就报告没有发送。'
await fetch(`${base}/api/sessions/${id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: prompt, attachments: [] }),
})

let approval
let preApprovalTerminal
for (let index = 0; index < 80; index += 1) {
  const snapshot = await fetch(`${base}/api/sessions/${id}`).then((response) => response.json())
  approval = snapshot.events.find((event) => event.type === 'approval.required')
  if (approval) break
  if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)) {
    preApprovalTerminal = snapshot
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!approval) {
  const final = preApprovalTerminal?.events?.findLast((event) => event.type === 'assistant.final')?.data?.content
  throw new Error(`Model did not request approval before reaching ${preApprovalTerminal?.session?.status || 'the observation deadline'}${final ? `: ${final}` : ''}`)
}

await fetch(`${base}/api/sessions/${id}/approvals/${approval.data.approvalId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ approved: false }),
})

let terminal
for (let index = 0; index < 80; index += 1) {
  const snapshot = await fetch(`${base}/api/sessions/${id}`).then((response) => response.json())
  if (['completed', 'failed', 'cancelled'].includes(snapshot.session.status)) {
    terminal = snapshot
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}
const report = {
  sessionId: id,
  status: terminal?.session?.status,
  approvalId: approval.data.approvalId,
  decision: terminal?.events?.find((event) => event.type === 'approval.resolved')?.data?.decision,
  requestSignature: terminal?.events?.find((event) => event.type === 'approval.resolved')?.data?.requestSignature,
  approvalRequiredCount: terminal?.events?.filter((event) => event.type === 'approval.required').length,
  approvalResolvedCount: terminal?.events?.filter((event) => event.type === 'approval.resolved').length,
  toolResult: terminal?.events?.find((event) => event.type === 'tool.failed' && event.data?.call?.name === 'http_request')?.data?.result,
  final: terminal?.events?.findLast((event) => event.type === 'assistant.final')?.data?.content,
  usage: terminal?.session?.usage,
}
console.log(JSON.stringify(report, null, 2))
await mkdir(resolve('reports', 'real-smokes'), { recursive: true })
await writeFile(
  resolve('reports', 'real-smokes', `approval-deny-${id}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
)
if (
  report.status !== 'completed'
  || report.decision !== 'denied'
  || report.approvalRequiredCount !== 1
  || report.approvalResolvedCount !== 1
  || !String(report.toolResult).includes('not sent')
) process.exitCode = 1
