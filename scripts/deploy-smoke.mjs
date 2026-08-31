const base = process.env.ANERA_SMOKE_BASE || 'http://127.0.0.1:4174'
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])

async function snapshot(sessionId) {
  const response = await fetch(`${base}/api/sessions/${sessionId}`)
  if (!response.ok) throw new Error(`snapshot failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function submit(sessionId, content) {
  const response = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, attachments: [] }),
  })
  if (!response.ok) throw new Error(`submit failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function waitForApproval(sessionId, afterSeq, deadline) {
  while (Date.now() < deadline) {
    const current = await snapshot(sessionId)
    const approval = current.events.find((event) => event.seq > afterSeq && event.type === 'approval.required' && event.data?.call?.name === 'deploy_project')
    if (approval) return { current, approval }
    if (terminalStatuses.has(current.session.status)) {
      throw new Error(`deploy turn reached ${current.session.status} without approval`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  }
  throw new Error('timed out waiting for deploy approval')
}

async function approve(sessionId, approvalId) {
  const response = await fetch(`${base}/api/sessions/${sessionId}/approvals/${approvalId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved: true }),
  })
  if (!response.ok) throw new Error(`approval failed: ${response.status} ${await response.text()}`)
}

async function waitForTurn(sessionId, turnId, deadline) {
  while (Date.now() < deadline) {
    const current = await snapshot(sessionId)
    const completed = current.events.find((event) => event.type === 'turn.completed' && event.turnId === turnId)
    if (completed) return current
    if (terminalStatuses.has(current.session.status) && current.session.status !== 'completed') {
      throw new Error(`deploy turn ${turnId} ended as ${current.session.status}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  }
  throw new Error(`timed out waiting for deploy turn ${turnId}`)
}

async function readDeployment(url) {
  const response = await fetch(url, { redirect: 'follow' })
  const body = await response.text()
  if (!response.ok) throw new Error(`deployment fetch failed: ${response.status} ${body.slice(0, 300)}`)
  return { body, finalUrl: response.url, contentType: response.headers.get('content-type') }
}

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const { session } = await createResponse.json()
const firstPrompt = 'In the empty workspace create a dependency-free index.html whose title and visible h1 are both exactly ANERA-DEPLOY-SMOKE-V1. Use create_file, then call deploy_project exactly once with empty arguments. Wait for approval and do not use Bash, an external hosting service, GitHub, curl, or http_request. After deploy_project succeeds, finish with a concise report; the test harness will verify the deployment URL.'
const beforeFirst = await snapshot(session.id)
const firstTurn = await submit(session.id, firstPrompt)
const firstDeadline = Date.now() + 180_000
const firstApproval = await waitForApproval(session.id, beforeFirst.events.at(-1)?.seq || 0, firstDeadline)
await approve(session.id, firstApproval.approval.data.approvalId)
const firstSnapshot = await waitForTurn(session.id, firstTurn.turnId, firstDeadline)
if (firstSnapshot.session.status !== 'completed') throw new Error(`first deploy ended as ${firstSnapshot.session.status}`)
if (firstSnapshot.deployment.status !== 'deployed' || firstSnapshot.deployment.revision !== 1 || !firstSnapshot.deployment.url) {
  throw new Error(`first deployment state is invalid: ${JSON.stringify(firstSnapshot.deployment)}`)
}
const firstDeployment = { ...firstSnapshot.deployment }
const firstPage = await readDeployment(firstDeployment.url)
if (!firstPage.body.includes('ANERA-DEPLOY-SMOKE-V1') || firstPage.body.includes('ANERA-DEPLOY-SMOKE-V2')) {
  throw new Error('first deployment did not serve only the V1 marker')
}

const beforeSecondSeq = firstSnapshot.events.at(-1)?.seq || 0
const secondPrompt = 'In the same workspace edit only the title and visible h1 marker in index.html from ANERA-DEPLOY-SMOKE-V1 to ANERA-DEPLOY-SMOKE-V2. Use edit_file, then call deploy_project exactly once with empty arguments to update the same deployment. Wait for approval and do not use Bash, an external hosting service, GitHub, curl, or http_request. After deploy_project succeeds, finish with a concise report; the test harness will verify the URL and content.'
const secondTurn = await submit(session.id, secondPrompt)
const secondDeadline = Date.now() + 180_000
const secondApproval = await waitForApproval(session.id, beforeSecondSeq, secondDeadline)
await approve(session.id, secondApproval.approval.data.approvalId)
const secondSnapshot = await waitForTurn(session.id, secondTurn.turnId, secondDeadline)
if (secondSnapshot.session.status !== 'completed') throw new Error(`second deploy ended as ${secondSnapshot.session.status}`)
const secondDeployment = secondSnapshot.deployment
if (secondDeployment.status !== 'deployed' || secondDeployment.revision !== 2) {
  throw new Error(`second deployment state is invalid: ${JSON.stringify(secondDeployment)}`)
}
if (secondDeployment.id !== firstDeployment.id || secondDeployment.url !== firstDeployment.url) {
  throw new Error(`redeploy identity or URL changed: ${JSON.stringify({ firstDeployment, secondDeployment })}`)
}
if (secondDeployment.contentHash === firstDeployment.contentHash) throw new Error('redeploy content hash did not change')
const secondPage = await readDeployment(secondDeployment.url)
if (!secondPage.body.includes('ANERA-DEPLOY-SMOKE-V2') || secondPage.body.includes('ANERA-DEPLOY-SMOKE-V1')) {
  throw new Error('second deployment did not replace V1 with only the V2 marker')
}

const deployStarts = secondSnapshot.events.filter((event) => event.type === 'tool.started' && event.data?.call?.name === 'deploy_project')
const deploySuccesses = secondSnapshot.events.filter((event) => event.type === 'tool.completed' && event.data?.call?.name === 'deploy_project')
const deployFailures = secondSnapshot.events.filter((event) => ['tool.failed', 'tool.timed_out'].includes(event.type) && event.data?.call?.name === 'deploy_project')
if (deployStarts.length !== 2 || deploySuccesses.length !== 2 || deployFailures.length !== 0) {
  throw new Error(`unexpected deploy tool lifecycle: ${JSON.stringify({ starts: deployStarts.length, successes: deploySuccesses.length, failures: deployFailures.length })}`)
}
if (deploySuccesses.some((event) => event.data?.result !== '{"status":"success"}')) throw new Error('deploy_project did not return the exact Arena success shape')
const approvalRequired = secondSnapshot.events.filter((event) => event.type === 'approval.required' && event.data?.call?.name === 'deploy_project')
const approvalResolved = secondSnapshot.events.filter((event) => event.type === 'approval.resolved' && event.data?.approved === true)
if (approvalRequired.length !== 2 || approvalResolved.length !== 2) throw new Error('both deploy calls were not approved through the visible approval lifecycle')

const canonicalResponse = await fetch(`${base}/api/sessions/${session.id}/canonical.jsonl?task_id=D01`)
if (!canonicalResponse.ok) throw new Error(`canonical trace failed: ${canonicalResponse.status}`)
const canonicalRecords = (await canonicalResponse.text()).trim().split('\n').map((line) => JSON.parse(line))
const canonicalEvents = canonicalRecords.filter((record) => record.recordType === 'event').map((record) => record.event)
const canonicalDeployTools = canonicalEvents.filter((event) => event.kind === 'tool' && event.action === 'deploy' && event.status === 'succeeded')
const canonicalDeployment = canonicalEvents.filter((event) => event.kind === 'deployment')
if (canonicalDeployTools.length !== 2) throw new Error(`canonical trace has ${canonicalDeployTools.length} successful deploy tools instead of 2`)
for (const action of ['building', 'deploying', 'deployed', 'redeployed']) {
  if (!canonicalDeployment.some((event) => event.action === action)) throw new Error(`canonical deployment is missing ${action}`)
}
if (new Set(canonicalDeployment.map((event) => event.deployment?.id).filter(Boolean)).size !== 1) throw new Error('canonical deployment identity is not stable')

console.log(JSON.stringify({
  sessionId: session.id,
  status: secondSnapshot.session.status,
  visibility: secondDeployment.visibility,
  deploymentUrl: secondDeployment.url,
  firstFinalUrl: firstPage.finalUrl,
  secondFinalUrl: secondPage.finalUrl,
  contentType: secondPage.contentType,
  deploymentIdStable: secondDeployment.id === firstDeployment.id,
  urlStable: secondDeployment.url === firstDeployment.url,
  revisions: [firstDeployment.revision, secondDeployment.revision],
  contentHashesChanged: firstDeployment.contentHash !== secondDeployment.contentHash,
  approvals: approvalResolved.length,
  deployToolCalls: deployStarts.length,
  canonicalDeploymentEvents: canonicalDeployment.length,
  durationMs: secondSnapshot.session.usage.durationMs,
  activeDurationMs: secondSnapshot.session.usage.activeDurationMs,
  modelCalls: secondSnapshot.session.usage.modelCalls,
  toolCalls: secondSnapshot.session.usage.toolCalls,
  totalTokens: secondSnapshot.session.usage.totalTokens,
  cachedPromptTokens: secondSnapshot.session.usage.cachedPromptTokens,
  estimatedCostUsd: secondSnapshot.session.usage.estimatedCostUsd,
}, null, 2))
