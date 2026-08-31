import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const root = await mkdtemp(resolve(tmpdir(), 'anera-recovery-smoke-'))
let server
let agent
try {
  process.env.ANERA_DATA_DIR = root
  const { SessionStore } = await import('../dist-server/server/session-store.js')
  const first = new SessionStore(root, 'recovery-test-model')
  await first.initialize()
  const session = await first.create()
  await first.setStatus(session.summary.id, 'running')
  await first.setStatus(session.summary.id, 'awaiting_approval')
  await first.update(session.summary.id, (state) => {
    state.processes.push({
      id: 'proc_recovery_smoke',
      command: 'npm run dev',
      pid: 43210,
      port: 43199,
      status: 'running',
      startedAt: new Date().toISOString(),
      stdout: 'ready\n',
      stderr: '',
    })
  })
  await first.append(session.summary.id, 'approval.required', {
    approvalId: 'approval_recovery_smoke',
    call: { id: 'call_recovery_smoke', name: 'http_request', arguments: { url: 'https://example.com/write', method: 'POST' } },
    title: 'Approve external request?',
  })

  const { createApp } = await import('../dist-server/server/app.js')
  const created = await createApp()
  agent = created.agent
  server = createServer(created.app)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port')
  const base = `http://127.0.0.1:${address.port}`
  const response = await fetch(`${base}/api/sessions/${session.summary.id}`)
  if (!response.ok) throw new Error(`snapshot failed: ${response.status}`)
  const snapshot = await response.json()
  if (snapshot.session.status !== 'interrupted') throw new Error(`expected interrupted, got ${snapshot.session.status}`)
  const recoveredProcess = snapshot.processes.find((process) => process.id === 'proc_recovery_smoke')
  if (recoveredProcess?.status !== 'interrupted' || recoveredProcess.signal !== 'SERVER_RESTART') {
    throw new Error(`process was not recovered as interrupted: ${JSON.stringify(recoveredProcess)}`)
  }
  const expired = snapshot.events.find((event) => event.type === 'approval.expired' && event.data.approvalId === 'approval_recovery_smoke')
  if (!expired) throw new Error('pending approval was not expired')
  const recoveryEventsBefore = snapshot.events.filter((event) => event.type === 'session.recovered').length
  await fetch(`${base}/api/sessions`)
  await fetch(`${base}/api/sessions`)
  const replayed = await fetch(`${base}/api/sessions/${session.summary.id}`).then((item) => item.json())
  const recoveryEventsAfter = replayed.events.filter((event) => event.type === 'session.recovered').length
  if (recoveryEventsAfter !== recoveryEventsBefore) throw new Error('recovery was applied more than once')
  const staleApproval = await fetch(`${base}/api/sessions/${session.summary.id}/approvals/approval_recovery_smoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved: true }),
  })
  if (staleApproval.status !== 404) throw new Error(`expired approval should be unavailable, got ${staleApproval.status}`)

  console.log(JSON.stringify({
    sessionId: session.summary.id,
    status: snapshot.session.status,
    processStatus: recoveredProcess.status,
    processSignal: recoveredProcess.signal,
    approvalDecision: expired.data.decision,
    recoveryEvents: recoveryEventsAfter,
    staleApprovalStatus: staleApproval.status,
    terminalEvents: snapshot.events.slice(-5).map((event) => event.type),
  }, null, 2))
} finally {
  if (agent) await agent.shutdown()
  if (server) await new Promise((resolveClose) => server.close(resolveClose))
  await rm(root, { recursive: true, force: true })
}
