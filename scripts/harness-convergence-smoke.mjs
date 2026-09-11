import './legacy-live-test-disabled.mjs'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = resolve(process.cwd())
const reportDirectory = resolve(process.env.ANERA_SMOKE_REPORT_DIR || 'reports/real-smokes')
const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-harness-convergence-'))
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'])
const fixturePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x43, 0x41, 0x50, 0x31])
const providerCalls = []
const speechMp3Fixture = Buffer.from(
  'SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYzLjEuMTAxAAAAAAAAAAAAAAD/84TAAAAAAAAAAAAASW5mbwAAAA8AAAAHAAADYABVVVVVVVVVVVVVVVVVVXFxcXFxcXFxcXFxcXFxjo6Ojo6Ojo6Ojo6Ojo6qqqqqqqqqqqqqqqqqqqrHx8fHx8fHx8fHx8fHx+Pj4+Pj4+Pj4+Pj4+Pj//////////////////8AAAAATGF2YzYzLjEuAAAAAAAAAAAAAAAAJAJAAAAAAAAAA2AyzfsUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/80TEABJQbngfWBgAVkluAXeu9YdU6Y6g7T26FsDW02tNaTOUBHQBrrd+NxiWSiMSykpLGAPg+D4P1Ag7Ln+CDpzp85y/nOnlwQdKAMP5MEOX93+GOlUwCFDC4eqxzUH/80TECRRJMmwBnIAAZjtrHsj8DEGfLGBhVAHwkCZxIBhsKJY0abM4FkoNtQsJ/FJCUhCxAf8ZkZUmiLEC/8xJ0ipkXi9/+Yl0upA038qEgaEoS/4NKg6ElaHCfqHwQAP/80TEChNgWixV3gAAlrQEAaYHoWRhUD5GCcGiYSoiR5OvcGe8IeYUoVBgqgnGC2BMYAAB5ZEvSrc40ix9aHamq+N/6Pu/9noR/Zv932ff/potzXCUGdJDbWEvwACDEJP/80TEDxJoUihW57RAzof7BStME8Uc8IvoTG1CpOQqMiJLQJjrsZ3D8sP41rKvt9296u5P8wjFiqrafb/0vUUMbrvT02a8aKVVimYBACwcADGAQAHBgOgHMYJkBXGD6A7/80TEGBWgWiABXwAAwYIUEFGHHhdpl7bAIYgsJ+GGxAzxgYwEMAAG0wHEA7MAfAGSIADW2huuujr9uv9Vz/rSW//9Hyfbrbv8b/61///G2NIgZxKyAxwGkYAw7+t7IWn/80TEFBbycpQBmmgA/4SATAeH+JmOclxyf+PQoDnJc3//HoXDQly+b//5KFw0L5fNy5//+XEC+X0y4aIF////9NMuIIG6aZoggb//+HwQAYfBABh9AgQgwwwgAHJC+Pj/80TECxU6qoxVk1AAGzpBl8LJQtj4UQBYCt+FCAVAZEF/g3CKIREiz/5EIoWiERJL/+RCKJio9JU//x86j0xDl///mpOXIjZCd////IlkJxxEaaQnHERMQU1FNC4wqqo=',
  'base64',
)
const connectorCalls = []

const connectorTool = {
  type: 'function',
  function: {
    name: 'convergence_lookup',
    description: 'Look up an exact marker in the connected convergence evidence service.',
    parameters: {
      type: 'object',
      properties: { marker: { type: 'string', minLength: 1 } },
      required: ['marker'],
      additionalProperties: false,
    },
  },
}

let server
let agent
let base = ''
try {
  const { createApp } = await import(pathToFileURL(resolve(projectRoot, 'dist-server/server/app.js')).href)
  const created = await createApp({
    dataRoot,
    agent: {
      vision: {
        inspect: async (path, _prompt, _signal) => {
          const bytes = await readFile(path)
          if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            throw new Error('Vision convergence fixture requires a real PNG workspace file')
          }
          return {
            content: 'One large blue geometric convergence marker is centered on a white field. No unexpected visual element is present.',
            metadata: { mime: 'image/png', bytes: bytes.length },
            usage: { promptTokens: 32, completionTokens: 20, totalTokens: 52, cachedPromptTokens: 0 },
          }
        },
      },
      connectorTools: { convergence: [connectorTool] },
      connectorExecutors: {
        convergence: async (call, context) => {
          connectorCalls.push({
            name: call.name,
            arguments: call.arguments,
            sessionId: context.sessionId,
            turnId: context.turnId,
            stepId: context.stepId,
            callId: context.callId,
          })
          return {
            content: JSON.stringify({
              status: 'success',
              marker: call.arguments.marker,
              evidence: 'CONNECTED-CONVERGENCE-731',
              source: 'convergence://fixture/evidence',
            }),
            isError: false,
          }
        },
      },
      toolExecutorDependencies: {
        fetch: fixtureFetch,
        validatePublicUrl: async (rawUrl) => new URL(String(rawUrl)),
        localAppBaseUrl: () => base,
        pexelsApiKey: 'convergence-fixture-key',
        imageApiKey: 'convergence-fixture-key',
        imageBaseUrl: 'https://fixture-provider.example/v1',
        imageModel: 'convergence-image-fixture',
      },
    },
  })
  agent = created.agent
  server = createServer(created.app)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Harness convergence server did not bind')
  base = `http://127.0.0.1:${address.port}`

  const scenarios = []
  scenarios.push(await runNoTool(base))
  scenarios.push(await runFileProcessCompact(base))
  scenarios.push(await runResearch(base))
  scenarios.push(await runMedia(base))
  scenarios.push(await runBrowserVisualLoop(base))
  scenarios.push(await runVoice(base))
  scenarios.push(await runPlanAndAsk(base))
  scenarios.push(await runFailureRecovery(base))
  scenarios.push(await runConnector(base))

  const activeTools = [
    'add_voice', 'ask_user', 'bash', 'compact', 'edit_file', 'fetch_page', 'generate_image',
    'generate_speech', 'get_process_output', 'image_search', 'list_connector_tools', 'list_files',
    'present_file', 'propose_plan', 'read_file', 'start_process', 'stop_process', 'web_search', 'write_file',
  ]
  const completedToolSet = new Set(scenarios.flatMap((scenario) => scenario.completedTools))
  const coveredActiveTools = activeTools.filter((name) => completedToolSet.has(name))
  const totals = scenarios.reduce((result, scenario) => ({
    wallMs: result.wallMs + scenario.wallMs,
    activeDurationMs: result.activeDurationMs + scenario.usage.activeDurationMs,
    modelCalls: result.modelCalls + scenario.usage.modelCalls,
    toolCalls: result.toolCalls + scenario.usage.toolCalls,
    promptTokens: result.promptTokens + scenario.usage.promptTokens,
    completionTokens: result.completionTokens + scenario.usage.completionTokens,
    cachedPromptTokens: result.cachedPromptTokens + scenario.usage.cachedPromptTokens,
    estimatedCostUsd: result.estimatedCostUsd + scenario.usage.estimatedCostUsd,
  }), {
    wallMs: 0,
    activeDurationMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    estimatedCostUsd: 0,
  })
  const report = {
    schemaVersion: 'anera-harness-convergence/1.1',
    generatedAt: new Date().toISOString(),
    modelExecution: 'real configured DeepSeek provider',
    externalTools: 'deterministic in-process fixtures for search pages, vision, media generation, speech, and connector data',
    costScope: 'Session estimatedCostUsd; fixture media and speech calls do not represent external provider charges',
    mobileExcluded: true,
    arenaParityGate: 'paused',
    activeToolCoverage: {
      required: activeTools,
      covered: coveredActiveTools,
      missing: activeTools.filter((name) => !completedToolSet.has(name)),
      passed: coveredActiveTools.length === activeTools.length,
    },
    totals: {
      ...totals,
      estimatedCostUsd: roundUsd(totals.estimatedCostUsd),
      cacheHitRatio: totals.promptTokens > 0 ? totals.cachedPromptTokens / totals.promptTokens : 0,
      passedScenarios: scenarios.filter((scenario) => scenario.passed).length,
      scenarios: scenarios.length,
    },
    providerFixtureCalls: providerCalls,
    connectorCalls,
    scenarios,
    passed: scenarios.every((scenario) => scenario.passed) && coveredActiveTools.length === activeTools.length,
  }
  await mkdir(reportDirectory, { recursive: true })
  const timestamp = report.generatedAt.replaceAll(':', '-').replaceAll('.', '-')
  const reportPath = resolve(reportDirectory, `harness-convergence-${timestamp}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} finally {
  await agent?.shutdown()
  if (server) await new Promise((resolveClose) => server.close(() => resolveClose()))
  await rm(dataRoot, { recursive: true, force: true })
}

async function fixtureFetch(input, init = {}) {
  const url = String(input)
  const method = String(init.method || 'GET').toUpperCase()
  if (url.startsWith('https://www.bing.com/search')) {
    providerCalls.push({ kind: 'web_search_fixture', method, url: 'https://www.bing.com/search' })
    return new Response(`<!doctype html><li class="b_algo"><h2><a href="https://evidence.example/research">Harness convergence evidence</a></h2><p>Authoritative fixture evidence for the convergence smoke.</p></li>`, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  }
  if (url === 'https://evidence.example/research') {
    providerCalls.push({ kind: 'fetch_page_fixture', method, url })
    return new Response(`<!doctype html><html><head><title>Harness convergence evidence</title></head><body><main><h1>Convergence evidence</h1><p>The verified evidence marker is RESEARCH-EVIDENCE-731.</p><p>Source class: deterministic authoritative fixture.</p></main></body></html>`, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  if (url.startsWith('https://api.pexels.com/v1/search')) {
    providerCalls.push({ kind: 'image_search_fixture', method, url: 'https://api.pexels.com/v1/search' })
    return Response.json({
      total_results: 1,
      photos: [{
        id: 731,
        url: 'https://www.pexels.com/photo/convergence-731/',
        width: 1,
        height: 1,
        photographer: 'Anera Fixture',
        photographer_url: 'https://www.pexels.com/@anera-fixture/',
        alt: 'A tiny convergence fixture image',
        src: {
          large2x: 'https://images.example/convergence.png',
          medium: 'https://images.example/convergence.png',
        },
      }],
    })
  }
  if (url === 'https://images.example/convergence.png') {
    providerCalls.push({ kind: 'image_download_fixture', method, url })
    return new Response(fixturePng, { status: 200, headers: { 'content-type': 'image/png' } })
  }
  if (url === 'https://fixture-provider.example/v1/images/generations' || url === 'https://fixture-provider.example/v1/images/edits') {
    providerCalls.push({ kind: 'image_generation_fixture', method, url })
    return Response.json({ data: [{ b64_json: fixturePng.toString('base64') }] })
  }
  if (url === 'https://fixture-provider.example/v1/audio/speech') {
    const body = JSON.parse(String(init.body || '{}'))
    providerCalls.push({
      kind: body.input?.includes('audition') ? 'voice_audition_fixture' : 'speech_generation_fixture',
      method,
      url,
      voice: body.voice,
      responseFormat: body.response_format,
      inputCharacters: String(body.input || '').length,
    })
    return new Response(speechMp3Fixture, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    })
  }
  return await fetch(input, init)
}

async function createSession(base) {
  return (await postJson(base, '/api/sessions', {}, 201)).session
}

async function submit(base, sessionId, text, enabledConnectorSlugs) {
  return await postJson(base, `/api/sessions/${sessionId}/messages`, {
    message: { text: text.trim() },
    metadata: { timezone: 'Asia/Shanghai', submissionSource: 'chat_input' },
    v2Source: 'agentic_chat_submit',
    ...(enabledConnectorSlugs ? { enabledConnectorSlugs } : {}),
  }, 202)
}

async function snapshot(base, sessionId) {
  const response = await fetch(`${base}/api/sessions/${sessionId}`)
  if (!response.ok) throw new Error(`Snapshot ${sessionId} failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function waitForTerminal(base, sessionId, onHitl, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  const handled = new Set()
  while (Date.now() < deadline) {
    const current = await snapshot(base, sessionId)
    const resolved = new Set(current.events
      .filter((event) => event.type === 'hitl.resolved' || event.type === 'hitl.expired')
      .map((event) => String(event.data.hitlId || '')))
    for (const event of current.events.filter((candidate) => candidate.type === 'hitl.required')) {
      const hitlId = String(event.data.hitlId || '')
      if (!hitlId || handled.has(hitlId) || resolved.has(hitlId)) continue
      if (!onHitl) throw new Error(`Unexpected ${event.data.kind} HITL in ${sessionId}`)
      handled.add(hitlId)
      const response = await onHitl(event, current)
      await postJson(base, `/api/sessions/${sessionId}/hitl/${hitlId}`, response, 200)
    }
    if (terminalStatuses.has(current.session.status)) return current
    await new Promise((resolveWait) => setTimeout(resolveWait, 350))
  }
  throw new Error(`Session ${sessionId} did not finish before the convergence deadline`)
}

async function postJson(base, path, body, expectedStatus) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status !== expectedStatus) throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`)
  return await response.json()
}

function finalText(current) {
  return String(current.events.findLast((event) => event.type === 'assistant.final')?.data?.content || '')
}

function toolNames(current, eventType = 'tool.completed') {
  return current.events
    .filter((event) => event.type === eventType)
    .map((event) => String(event.data.call?.name || ''))
}

function scenarioResult(name, current, startedAt, checks, extra = {}) {
  const completedTools = toolNames(current)
  const failedTools = toolNames(current, 'tool.failed')
  const firstTurn = current.events.find((event) => event.type === 'turn.started')
  const firstModelEvidence = current.events.find((event) => (
    event.type === 'tool.started'
    || event.type === 'assistant.thought.delta'
    || event.type === 'assistant.final.delta'
  ))
  const firstModelOutputLatencyMs = firstTurn && firstModelEvidence
    ? Math.max(0, Date.parse(firstModelEvidence.at) - Date.parse(firstTurn.at))
    : null
  const usage = current.session.usage
  const passed = current.session.status === 'completed' && checks.every((check) => check.passed)
  return {
    name,
    sessionId: current.session.id,
    status: current.session.status,
    passed,
    checks,
    wallMs: Date.now() - startedAt,
    firstModelOutputLatencyMs,
    usage: {
      activeDurationMs: usage.activeDurationMs ?? usage.durationMs ?? 0,
      modelCalls: usage.modelCalls,
      toolCalls: usage.toolCalls,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cachedPromptTokens: usage.cachedPromptTokens,
      estimatedCostUsd: roundUsd(usage.estimatedCostUsd),
    },
    completedTools,
    failedTools,
    final: finalText(current),
    ...extra,
  }
}

function check(name, passed, observed) {
  return { name, passed: Boolean(passed), ...(observed === undefined ? {} : { observed }) }
}

async function runNoTool(base) {
  const startedAt = Date.now()
  const session = await createSession(base)
  await submit(base, session.id, 'Do not use any tool. Output exactly CONVERGENCE-NO-TOOL-731 and nothing else.')
  const current = await waitForTerminal(base, session.id)
  return scenarioResult('no_tool_efficiency', current, startedAt, [
    check('exact final', finalText(current) === 'CONVERGENCE-NO-TOOL-731', finalText(current)),
    check('zero tools', current.session.usage.toolCalls === 0, current.session.usage.toolCalls),
  ])
}

async function runFileProcessCompact(base) {
  const startedAt = Date.now()
  const session = await createSession(base)
  await submit(base, session.id, `Complete this exact lifecycle in order without using tools not requested here:
1. write_file /home/user/runner.py with a Python program that prints PROCESS-STATE-0 with flush=True and then sleeps forever.
2. edit_file runner.py to replace PROCESS-STATE-0 with PROCESS-STATE-1.
3. read_file runner.py and list_files on the workspace root to verify it.
4. bash exactly "python3 -m py_compile runner.py" with cwd /home/user and timeout 30.
5. start_process named Convergence Process with command exactly "python3 -u runner.py" and startup_wait 1.
6. get_process_output once with wait_for log, wait_pattern PROCESS-STATE-1, and wait_timeout 10.
7. stop_process using that process id, then get_process_output once more to verify it exited.
8. present_file runner.py.
Finish with a concise report containing PROCESS-LIFECYCLE-731.`)
  let current = await waitForTerminal(base, session.id)
  const firstTurnTools = toolNames(current)
  const priorSeq = Math.max(...current.events.map((event) => event.seq))
  await submit(base, session.id, 'Call compact exactly once. After it succeeds and the checkpoint is consumed, output exactly CONVERGENCE-COMPACT-731 and nothing else. Do not call another tool.')
  current = await waitForTerminal(base, session.id)
  const newEvents = current.events.filter((event) => event.seq > priorSeq)
  const compactCount = newEvents.filter((event) => event.type === 'tool.completed' && event.data.call?.name === 'compact').length
  const checkpointCount = newEvents.filter((event) => event.type === 'context.compacted' && event.data.reason === 'tool_request').length
  const required = ['write_file', 'edit_file', 'read_file', 'list_files', 'bash', 'start_process', 'get_process_output', 'stop_process', 'present_file']
  const process = current.processes.find((candidate) => candidate.command === 'python3 -u runner.py')
  return scenarioResult('file_shell_process_compaction', current, startedAt, [
    check('first-turn tool coverage', required.every((name) => firstTurnTools.includes(name)), firstTurnTools),
    check('no first-turn tool failures', current.events.filter((event) => event.seq <= priorSeq && event.type === 'tool.failed').length === 0),
    check('managed process stopped', process?.status === 'stopped', process?.status),
    check('one compact call', compactCount === 1, compactCount),
    check('forced checkpoint consumed', checkpointCount >= 1, checkpointCount),
    check('exact compact final', finalText(current) === 'CONVERGENCE-COMPACT-731', finalText(current)),
  ], { firstTurnTools, compactCount, checkpointCount, processStatus: process?.status })
}

async function runResearch(base) {
  const startedAt = Date.now()
  const session = await createSession(base)
  await submit(base, session.id, `Use web_search exactly once with query "ANERA convergence evidence 731" and depth "1". Only after search succeeds, use fetch_page on the evidence result URL. Use that page—not the search snippet—as evidence. Then write_file /home/user/research.md with a short cited note containing the exact marker RESEARCH-EVIDENCE-731 and the source URL, and present_file it. Finish with a concise answer containing RESEARCH-CLOSED-731. Do not use other tools.`)
  const current = await waitForTerminal(base, session.id)
  const completed = toolNames(current)
  const artifact = current.artifacts.find((candidate) => candidate.path === 'research.md')
  const artifactText = artifact ? await fetch(`${base}${artifact.previewUrl}`).then((response) => response.text()) : ''
  return scenarioResult('research_to_artifact', current, startedAt, [
    check('exact tool sequence', JSON.stringify(completed) === JSON.stringify(['web_search', 'fetch_page', 'write_file', 'present_file']), completed),
    check('evidence persisted', artifactText.includes('RESEARCH-EVIDENCE-731') && artifactText.includes('https://evidence.example/research')),
    check('final marker', finalText(current).includes('RESEARCH-CLOSED-731'), finalText(current)),
    check('no failed tools', toolNames(current, 'tool.failed').length === 0),
  ], { artifact: artifact?.path, artifactText })
}

async function runMedia(base) {
  const startedAt = Date.now()
  const providerStart = providerCalls.length
  const session = await createSession(base)
  await submit(base, session.id, `Use image_search exactly once with query "convergence fixture" and count 1. Read the returned image path with read_file. Then call generate_image exactly once to edit that returned image, saving /home/user/images/convergence-generated.png, with prompt "One standalone blue geometric convergence marker on white" and offer_options false. Read the generated image once, present_file it, and finish with a concise answer containing MEDIA-CLOSED-731. Do not use other tools.`)
  const current = await waitForTerminal(base, session.id)
  const completed = toolNames(current)
  const artifact = current.artifacts.find((candidate) => candidate.path === 'images/convergence-generated.png')
  const calls = providerCalls.slice(providerStart)
  return scenarioResult('image_search_generate_present', current, startedAt, [
    check('media tools completed', ['image_search', 'generate_image', 'present_file'].every((name) => completed.includes(name)), completed),
    check('two image reads', completed.filter((name) => name === 'read_file').length === 2, completed),
    check('generated image persisted', Boolean(artifact), artifact?.path),
    check('provider fixture path exercised', calls.some((call) => call.kind === 'image_search_fixture') && calls.some((call) => call.kind === 'image_generation_fixture'), calls),
    check('final marker', finalText(current).includes('MEDIA-CLOSED-731'), finalText(current)),
    check('no failed tools', toolNames(current, 'tool.failed').length === 0, toolNames(current, 'tool.failed')),
  ], { artifact: artifact?.path, providerCalls: calls })
}

async function runBrowserVisualLoop(base) {
  const startedAt = Date.now()
  const session = await createSession(base)
  await submit(base, session.id, `Build one self-contained desktop HTML page showing one large blue geometric convergence marker centered on a white field. Save it once as visual-convergence.html, start a live preview directly with start_process, open it with browser, and save exactly one browser screenshot to evidence/browser-visual.png. After that save, follow the newly available task-local tool surface and its instructions to resolve the remaining visual question. Use the returned visual evidence to verify the blue marker, present visual-convergence.html, and finish with VISUAL-LOOP-CLOSED-731. Do not use Bash, read_file, generate_image, image_search, a competing second write, or any extra screenshot.`)
  const current = await waitForTerminal(base, session.id)
  const completed = toolNames(current)
  const failed = toolNames(current, 'tool.failed')
  const completedTrace = current.events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => ({ name: event.data.call?.name, action: event.data.call?.arguments?.action }))
  const screenshotIndex = completedTrace.findIndex((call) => call.name === 'browser' && call.action === 'screenshot')
  const inspectIndex = completedTrace.findIndex((call) => call.name === 'inspect_image')
  const screenshotCalls = current.events
    .filter((event) => event.type === 'tool.completed' && event.data.call?.name === 'browser')
    .map((event) => event.data.call)
    .filter((call) => call.arguments.action === 'screenshot')
  const inspectCalls = current.events
    .filter((event) => event.type === 'tool.completed' && event.data.call?.name === 'inspect_image')
    .map((event) => event.data.call)
  const screenshotArtifact = current.artifacts.find((artifact) => artifact.path === 'evidence/browser-visual.png')
  const htmlArtifact = current.artifacts.find((artifact) => artifact.path === 'visual-convergence.html')
  return scenarioResult('browser_screenshot_to_vision', current, startedAt, [
    check('one browser screenshot saved', screenshotCalls.length === 1 && Boolean(screenshotArtifact), { screenshotCalls, artifact: screenshotArtifact?.path }),
    check('matching screenshot inspected once', inspectCalls.length === 1 && inspectCalls[0].arguments.path === 'evidence/browser-visual.png', inspectCalls),
    check('vision follows browser evidence', screenshotIndex >= 0 && inspectIndex > screenshotIndex, completedTrace),
    check('live Website and HTML Artifact exist', current.website.status === 'running' && Boolean(htmlArtifact), { website: current.website, artifact: htmlArtifact?.path }),
    check('HTML presented', current.events.some((event) => event.type === 'file.presented' && event.data.path === 'visual-convergence.html')),
    check('final marker', finalText(current).includes('VISUAL-LOOP-CLOSED-731'), finalText(current)),
    check('no failed tools', failed.length === 0, failed),
    check('bounded visual loop', current.session.usage.modelCalls <= 12 && current.session.usage.toolCalls <= 10, {
      modelCalls: current.session.usage.modelCalls,
      toolCalls: current.session.usage.toolCalls,
    }),
  ], {
    screenshotArtifact: screenshotArtifact?.path,
    htmlArtifact: htmlArtifact?.path,
    screenshotCalls,
    inspectCalls,
  })
}

async function runVoice(base) {
  const startedAt = Date.now()
  const providerStart = providerCalls.length
  const session = await createSession(base)
  let voiceSelections = 0
  await submit(base, session.id, `Call add_voice exactly once with language en-US and an audition text of 30 to 45 words that includes the literal word audition. After I choose a voice, call generate_speech exactly once with that returned voice_id, file_path /home/user/audio/convergence.mp3, and text "Voice convergence is complete, marker seven three one." Then present_file the audio and finish with VOICE-CLOSED-731. Do not use other tools.`)
  const current = await waitForTerminal(base, session.id, async (event) => {
    if (event.data.kind !== 'add_voice') throw new Error(`Voice scenario received ${event.data.kind}`)
    const candidates = event.data.payload.candidates
    if (!Array.isArray(candidates) || candidates.length !== 2 || candidates.some((candidate) => typeof candidate.path !== 'string')) {
      throw new Error(`Voice auditions were not provider-backed: ${JSON.stringify(candidates)}`)
    }
    voiceSelections += 1
    return { candidate_id: candidates[0].id }
  })
  const completed = toolNames(current)
  const artifact = current.artifacts.find((candidate) => candidate.path === 'audio/convergence.mp3')
  const calls = providerCalls.slice(providerStart)
  return scenarioResult('voice_selection_to_speech', current, startedAt, [
    check('exact tool sequence', JSON.stringify(completed) === JSON.stringify(['add_voice', 'generate_speech', 'present_file']), completed),
    check('one voice selection', voiceSelections === 1, voiceSelections),
    check('two provider auditions', calls.filter((call) => call.kind === 'voice_audition_fixture').length === 2, calls),
    check('final speech used provider', calls.some((call) => call.kind === 'speech_generation_fixture'), calls),
    check('audio persisted', Boolean(artifact), artifact?.path),
    check('final marker', finalText(current).includes('VOICE-CLOSED-731'), finalText(current)),
  ], { artifact: artifact?.path, providerCalls: calls, voiceSelections })
}

async function runPlanAndAsk(base) {
  const startedAt = Date.now()
  const session = await createSession(base)
  let askCount = 0
  let planCount = 0
  await submit(base, session.id, `First call ask_user exactly once with question id scope, question text "Which convergence scope?", and options Small and Large. After Small is selected, write_file /home/user/convergence-plan.md containing exactly two initial Markdown steps: Create marker; Present marker. Wait for that write result, then call propose_plan with that exact path in a separate model step. If I request a revision, edit_file the plan to add a third step named Verify marker, wait for the edit result, then propose the same plan again in another separate model step. Never emit a file mutation and propose_plan in the same model response. Only after acceptance, write_file /home/user/plan-result.txt containing PLAN-ASK-CLOSED-731 followed by one LF, present_file it, and finish concisely. Do not use other tools.`)
  const current = await waitForTerminal(base, session.id, async (event, beforeDecision) => {
    if (event.data.kind === 'ask_user') {
      askCount += 1
      const question = event.data.payload.questions[0]
      const small = question.options.find((option) => option.label === 'Small')
      return { answers: [{ question_id: question.id, selected: [small?.id || 'Small'] }] }
    }
    if (event.data.kind === 'propose_plan') {
      if (beforeDecision.artifacts.some((artifact) => artifact.path === 'plan-result.txt')) {
        throw new Error('Plan result existed before acceptance')
      }
      planCount += 1
      return planCount === 1
        ? { decision: 'revise', feedback: 'Add a third step named Verify marker, then re-propose.' }
        : { decision: 'accept' }
    }
    throw new Error(`Plan scenario received ${event.data.kind}`)
  })
  const completed = toolNames(current)
  const failedToolTrace = current.events
    .filter((event) => event.type === 'tool.failed')
    .map((event) => ({
      call: event.data.call,
      result: event.data.result,
      reason: event.data.reason,
      notExecuted: event.data.notExecuted,
    }))
  const artifact = current.artifacts.find((candidate) => candidate.path === 'plan-result.txt')
  const artifactText = artifact ? await fetch(`${base}${artifact.previewUrl}`).then((response) => response.text()) : ''
  return scenarioResult('ask_and_plan_revision', current, startedAt, [
    check('one ask_user', askCount === 1 && completed.filter((name) => name === 'ask_user').length === 1, { askCount, completed }),
    check('two plan reviews', planCount === 2 && completed.filter((name) => name === 'propose_plan').length === 2, { planCount, completed }),
    check('plan revised with edit_file', completed.includes('edit_file'), completed),
    check('accepted result exact', artifactText === 'PLAN-ASK-CLOSED-731\n', artifactText),
    check('no failed tools', toolNames(current, 'tool.failed').length === 0, toolNames(current, 'tool.failed')),
  ], { askCount, planCount, artifactText, failedToolTrace })
}

async function runFailureRecovery(base) {
  const startedAt = Date.now()
  const session = await createSession(base)
  await submit(base, session.id, `First call read_file exactly once for /home/user/definitely-missing-731.txt and allow the expected missing-file error. Do not repeat that failed call. Recover by using write_file to create /home/user/recovered-731.txt containing RECOVERY-CLOSED-731 followed by one LF, read_file that new path to verify it, and present_file it. Finish concisely. Do not use other tools.`)
  const current = await waitForTerminal(base, session.id)
  const started = toolNames(current, 'tool.started')
  const failed = toolNames(current, 'tool.failed')
  const completed = toolNames(current)
  const artifact = current.artifacts.find((candidate) => candidate.path === 'recovered-731.txt')
  const artifactText = artifact ? await fetch(`${base}${artifact.previewUrl}`).then((response) => response.text()) : ''
  return scenarioResult('tool_failure_recovery', current, startedAt, [
    check('one intentional failed read', failed.filter((name) => name === 'read_file').length === 1, failed),
    check('failed call not repeated', started.filter((name) => name === 'read_file').length === 2, started),
    check('recovery tools completed', ['write_file', 'read_file', 'present_file'].every((name) => completed.includes(name)), completed),
    check('recovery artifact exact', artifactText === 'RECOVERY-CLOSED-731\n', artifactText),
  ], { startedTools: started, artifactText })
}

async function runConnector(base) {
  const startedAt = Date.now()
  const connectorStart = connectorCalls.length
  const session = await createSession(base)
  await submit(base, session.id, `First call list_connector_tools exactly once with service convergence. Only after it is enabled, call convergence_lookup exactly once with marker LOOKUP-731. Use the evidence and output exactly CONNECTOR-CLOSED-731 and nothing else. Do not use any other tool.`, ['convergence'])
  const current = await waitForTerminal(base, session.id)
  const completed = toolNames(current)
  const calls = connectorCalls.slice(connectorStart)
  return scenarioResult('dynamic_connector_loading', current, startedAt, [
    check('exact tool sequence', JSON.stringify(completed) === JSON.stringify(['list_connector_tools', 'convergence_lookup']), completed),
    check('dynamic executor exact call', calls.length === 1 && calls[0].arguments.marker === 'LOOKUP-731', calls),
    check('exact final', finalText(current) === 'CONNECTOR-CLOSED-731', finalText(current)),
    check('no failed tools', toolNames(current, 'tool.failed').length === 0),
  ], { connectorCalls: calls })
}

function roundUsd(value) {
  return Math.round((Number(value) || 0) * 1_000_000_000) / 1_000_000_000
}
