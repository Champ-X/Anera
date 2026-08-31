import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.ANERA_BASE_URL || 'http://127.0.0.1:4174'
const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/real-smokes')
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])

async function createSession() {
  const response = await fetch(`${base}/api/sessions`, { method: 'POST' })
  if (!response.ok) throw new Error(`create session failed: ${response.status} ${await response.text()}`)
  return (await response.json()).session
}

async function snapshot(sessionId) {
  const response = await fetch(`${base}/api/sessions/${sessionId}`)
  if (!response.ok) throw new Error(`snapshot ${sessionId} failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function submit(sessionId, content) {
  const response = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { text: content.trim() },
      metadata: { timezone: 'Asia/Shanghai', submissionSource: 'chat_input' },
      v2Source: 'agentic_chat_submit',
    }),
  })
  if (!response.ok) throw new Error(`submit ${sessionId} failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function resolveHitl(sessionId, hitlId, body) {
  const response = await fetch(`${base}/api/sessions/${sessionId}/hitl/${hitlId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`resolve HITL ${hitlId} failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function waitForRun(sessionId, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 240_000)
  const handled = new Set()
  while (Date.now() < deadline) {
    const current = await snapshot(sessionId)
    const resolved = new Set(current.events
      .filter((event) => event.type === 'hitl.resolved' || event.type === 'hitl.expired')
      .map((event) => String(event.data.hitlId || '')))
    for (const event of current.events.filter((candidate) => candidate.type === 'hitl.required')) {
      const hitlId = String(event.data.hitlId || '')
      if (!hitlId || handled.has(hitlId) || resolved.has(hitlId)) continue
      if (!options.onHitl) throw new Error(`unexpected HITL ${event.data.kind} in ${sessionId}`)
      handled.add(hitlId)
      const body = await options.onHitl(event, current)
      await resolveHitl(sessionId, hitlId, body)
    }
    if (terminalStatuses.has(current.session.status)) return current
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  }
  throw new Error(`session ${sessionId} did not finish before the smoke deadline`)
}

function finalText(current) {
  return String(current.events.findLast((event) => event.type === 'assistant.final')?.data?.content || '')
}

function toolEvents(current, type = 'tool.completed') {
  return current.events.filter((event) => event.type === type)
}

function toolNames(current, type = 'tool.completed') {
  return toolEvents(current, type).map((event) => String(event.data.call?.name || ''))
}

function summary(current) {
  return {
    sessionId: current.session.id,
    status: current.session.status,
    durationMs: current.session.usage.durationMs,
    activeDurationMs: current.session.usage.activeDurationMs,
    modelCalls: current.session.usage.modelCalls,
    toolCalls: current.session.usage.toolCalls,
    promptTokens: current.session.usage.promptTokens,
    completionTokens: current.session.usage.completionTokens,
    totalTokens: current.session.usage.totalTokens,
    cachedPromptTokens: current.session.usage.cachedPromptTokens,
    estimatedCostUsd: current.session.usage.estimatedCostUsd,
    completedTools: toolNames(current),
    failedTools: toolNames(current, 'tool.failed'),
    final: finalText(current),
  }
}

async function runNoTool() {
  const session = await createSession()
  await submit(session.id, 'Do not use any tool. Output exactly ACTIVE-NO-TOOL-9193 and nothing else.')
  const current = await waitForRun(session.id)
  const result = summary(current)
  if (current.session.status !== 'completed' || result.final !== 'ACTIVE-NO-TOOL-9193') {
    throw new Error(`no-tool oracle failed: ${JSON.stringify(result)}`)
  }
  if (current.events.some((event) => event.type === 'tool.started')) throw new Error('no-tool task unexpectedly started a tool')
  return result
}

async function runFileAndCompact() {
  const session = await createSession()
  await submit(session.id, `Use write_file to create /home/user/active-proof.txt with exact UTF-8 content ACTIVE-WRITE-READ-PRESENT-731 followed by one LF. Then use read_file on ~/active-proof.txt to verify the exact content, and call present_file for the same file. Do not use bash. Finish with a concise verification.`)
  let current = await waitForRun(session.id)
  const firstTurn = summary(current)
  const required = ['write_file', 'read_file', 'present_file']
  if (current.session.status !== 'completed' || required.some((name) => !firstTurn.completedTools.includes(name))) {
    throw new Error(`active file tools were not all completed: ${JSON.stringify(firstTurn)}`)
  }
  if (firstTurn.completedTools.includes('bash') || firstTurn.failedTools.length > 0) {
    throw new Error(`active file task used an invalid fallback: ${JSON.stringify(firstTurn)}`)
  }
  const artifact = current.artifacts.find((candidate) => candidate.path === 'active-proof.txt')
  if (!artifact) throw new Error('active-proof.txt Artifact is missing')
  const fileResponse = await fetch(`${base}${artifact.previewUrl}`)
  const fileText = await fileResponse.text()
  if (!fileResponse.ok || fileText !== 'ACTIVE-WRITE-READ-PRESENT-731\n') throw new Error(`active-proof.txt mismatch: ${JSON.stringify(fileText)}`)
  const priorSeq = Math.max(...current.events.map((event) => event.seq))

  await submit(session.id, 'Call compact exactly once to checkpoint the completed prior turn. After the compact tool succeeds and the checkpoint has been consumed, output exactly ACTIVE-COMPACT-OK-557 and nothing else. Do not use any other tool.')
  current = await waitForRun(session.id)
  const secondTurn = summary(current)
  const newEvents = current.events.filter((event) => event.seq > priorSeq)
  const compactCalls = newEvents.filter((event) => event.type === 'tool.completed' && event.data.call?.name === 'compact')
  const checkpoints = newEvents.filter((event) => event.type === 'context.compacted' && event.data.reason === 'tool_request' && event.data.forced === true)
  if (current.session.status !== 'completed' || finalText(current) !== 'ACTIVE-COMPACT-OK-557' || compactCalls.length !== 1 || checkpoints.length < 1) {
    throw new Error(`explicit compact oracle failed: ${JSON.stringify({ secondTurn, compactCalls: compactCalls.length, checkpoints: checkpoints.length })}`)
  }
  return { firstTurn, secondTurn, fileText, compactCalls: compactCalls.length, checkpoints: checkpoints.length }
}

async function runAskUser() {
  const session = await createSession()
  await submit(session.id, `Before answering, call ask_user exactly once with one question whose id is scope, whose text is "Which scope?", and whose two options are Small and Large. After I select Small, output exactly ACTIVE-ASK-USER-SMALL-313 and nothing else. Do not use any other tool.`)
  let requestCount = 0
  const current = await waitForRun(session.id, {
    onHitl: async (event) => {
      if (event.data.kind !== 'ask_user') throw new Error(`expected ask_user, received ${event.data.kind}`)
      requestCount += 1
      const question = event.data.payload.questions[0]
      return { answers: [{ question_id: question.id || 'question-1', selected: ['Small'] }] }
    },
  })
  const result = summary(current)
  if (current.session.status !== 'completed' || finalText(current) !== 'ACTIVE-ASK-USER-SMALL-313' || requestCount !== 1) {
    throw new Error(`ask_user oracle failed: ${JSON.stringify({ result, requestCount })}`)
  }
  if (current.events.filter((event) => event.type === 'hitl.resolved').length !== 1) throw new Error('ask_user did not resolve exactly once')
  return { ...result, requestCount }
}

async function runPlanReview() {
  const session = await createSession()
  await submit(session.id, `First use write_file to create /home/user/plans/active-plan.md containing a Markdown plan with exactly these initial steps: Inspect inputs; Create approved marker. Then call propose_plan using that path and two concise highlights. Do not create approved.txt before I accept. If I request a revision, update active-plan.md to add a third step named Verify marker and call propose_plan again. Only after acceptance, use write_file to create /home/user/approved.txt with exact content ACTIVE-PLAN-ACCEPTED-887 followed by one LF, then use present_file on approved.txt and finish concisely.`)
  let reviewCount = 0
  const current = await waitForRun(session.id, {
    onHitl: async (event, beforeDecision) => {
      if (event.data.kind !== 'propose_plan') throw new Error(`expected propose_plan, received ${event.data.kind}`)
      if (beforeDecision.artifacts.some((artifact) => artifact.path === 'approved.txt')) {
        throw new Error('approved.txt existed before plan acceptance')
      }
      reviewCount += 1
      return reviewCount === 1
        ? { decision: 'revise', feedback: 'Add a third step named Verify marker, then re-propose.' }
        : { decision: 'accept' }
    },
  })
  const result = summary(current)
  const artifact = current.artifacts.find((candidate) => candidate.path === 'approved.txt')
  const text = artifact ? await fetch(`${base}${artifact.previewUrl}`).then((response) => response.text()) : ''
  if (current.session.status !== 'completed' || reviewCount !== 2 || text !== 'ACTIVE-PLAN-ACCEPTED-887\n') {
    throw new Error(`plan-review oracle failed: ${JSON.stringify({ result, reviewCount, text })}`)
  }
  if (toolNames(current).filter((name) => name === 'propose_plan').length !== 2 || !toolNames(current).includes('present_file')) {
    throw new Error(`plan-review tool sequence is incomplete: ${JSON.stringify(result.completedTools)}`)
  }
  return { ...result, reviewCount, approvedText: text }
}

async function runProcessWebsite() {
  const session = await createSession()
  const port = 43231
  await submit(session.id, `Create /home/user/index.html with visible h1 ACTIVE PROCESS WEBSITE 421 and a button initially showing 0 that changes to 1 when clicked. Do not use bash. Use start_process with name Active Website and command exactly "python3 -u -m http.server ${port} --bind 0.0.0.0". Use get_process_output with wait_for=port to verify the listening port. Then use the browser tool to open the published Website, click the 0 button, verify it shows 1, and inspect the console. Finally use stop_process on the same process id and use get_process_output once more to verify it is no longer alive. Finish with a concise report.`)
  const current = await waitForRun(session.id)
  const result = summary(current)
  const required = ['write_file', 'start_process', 'get_process_output', 'browser', 'stop_process']
  const browserActions = toolEvents(current)
    .filter((event) => event.data.call?.name === 'browser')
    .map((event) => event.data.call?.arguments?.action)
  if (current.session.status !== 'completed' || required.some((name) => !result.completedTools.includes(name))) {
    throw new Error(`process Website tools were incomplete: ${JSON.stringify({ result, browserActions })}`)
  }
  if (!browserActions.includes('open') || !browserActions.includes('click') || !browserActions.includes('console')) {
    throw new Error(`browser verification actions were incomplete: ${JSON.stringify(browserActions)}`)
  }
  if (result.completedTools.includes('bash') || result.failedTools.length > 0) {
    throw new Error(`process Website used a fallback or failed tool: ${JSON.stringify(result)}`)
  }
  const processes = current.processes.filter((process) => process.command.includes(`http.server ${port}`))
  if (processes.length !== 1 || processes[0].status !== 'stopped') {
    throw new Error(`managed process did not stop cleanly: ${JSON.stringify(processes)}`)
  }
  return { ...result, port, browserActions, process: processes[0] }
}

const report = {
  generatedAt: new Date().toISOString(),
  base,
  noTool: await runNoTool(),
  fileAndCompact: await runFileAndCompact(),
  askUser: await runAskUser(),
  planReview: await runPlanReview(),
  processWebsite: await runProcessWebsite(),
}

await mkdir(reportDirectory, { recursive: true })
const timestamp = report.generatedAt.replaceAll(':', '-').replaceAll('.', '-')
const reportPath = resolve(reportDirectory, `active-harness-${timestamp}.json`)
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
