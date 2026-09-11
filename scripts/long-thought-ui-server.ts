import assert from 'node:assert/strict'
import { access, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { createApp } from '../src/server/app.js'
import { GitHubConnector } from '../src/server/github-connector.js'
import { createCanaryEvidenceDirectory } from '../src/eval/canary-evidence.js'
import { cloneTerminalSessionForUi, sessionReplayManifest } from '../src/eval/session-ui-replay.js'
import {
  appendVisualLongThoughtChunk,
  completeVisualLongThoughtFixture,
  seedVisualFixtureSessions,
  seedVisualLongThoughtFixture,
} from '../src/eval/ui-visual-fixture.js'

// Run with an open stdin/PTY. Controls are newline-delimited JSON, for example
// {"action":"chunk1"}, then chunk2, complete, status, or shutdown. No HTTP
// mutation controls are exposed. All data stays in a fresh, retained directory.
await access(resolve(process.cwd(), 'dist-client/index.html'))
const dataRoot = await createCanaryEvidenceDirectory()
const source = process.env.ANERA_UI_REPLAY_SESSION_DIR
const replay = source ? await cloneTerminalSessionForUi(source, dataRoot) : undefined
const deniedCalls = { text: 0, vision: 0, tools: 0, connector: 0 }
const deny = (kind: keyof typeof deniedCalls) => async (...args: unknown[]): Promise<never> => {
  deniedCalls[kind] += 1
  // Names only; never log arguments, prompts, URLs, or credentials.
  console.log(JSON.stringify({ type: 'execution-denied', kind,
    tool: kind === 'tools' && args[0] && typeof args[0] === 'object' ? (args[0] as { name?: string }).name : undefined }))
  throw new Error(`UI replay: ${kind} execution is disabled`)
}
const created = await createApp({
  dataRoot,
  model: 'synthetic-ui-zero-provider',
  agent: {
    client: { stream: deny('text') },
    vision: { inspect: deny('vision'), compare: deny('vision') },
    tools: { execute: deny('tools') },
    runTimeoutMs: 5_000,
  },
  github: { connector: new GitHubConnector({ dataRoot, fetch: deny('connector') }) },
})
const sessions = replay ? undefined : await seedVisualFixtureSessions(created.store)
const longThought = replay ? undefined : await seedVisualLongThoughtFixture(created.store)
const sessionId = replay?.id ?? longThought!.id
const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD' })
    response.end(JSON.stringify({ error: 'Synthetic UI fixture is read-only; use stdin thought controls' }))
    return
  }
  created.app(request, response)
})
await new Promise<void>((resolveListen, rejectListen) => {
  server.once('error', rejectListen)
  server.listen(0, '127.0.0.1', () => {
    server.off('error', rejectListen)
    resolveListen()
  })
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('UI fixture server did not bind')
const baseUrl = `http://127.0.0.1:${address.port}`
const input = createInterface({ input: process.stdin, terminal: false })
let commands = Promise.resolve()
let closing: Promise<void> | undefined

function shutdown(): Promise<void> {
  closing ??= (async () => {
    input.close()
    process.stdin.pause()
    const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    server.closeAllConnections()
    await created.agent.shutdown()
    await closed
    const sourceUnchanged = replay ? JSON.stringify(await sessionReplayManifest(replay.directory)) === JSON.stringify(replay.manifest) : undefined
    await writeFile(resolve(dataRoot, 'ui-replay-report.json'), JSON.stringify({
      sessionId, source: replay?.directory, sourceManifest: replay?.manifest, sourceUnchanged,
      deniedCalls, providerCalls: 0, scope: 'UI replay only; not generation acceptance',
    }, null, 2))
    console.log(JSON.stringify({ type: 'stopped', dataRoot, retained: true, providerCalls: 0, deniedCalls, sourceUnchanged }))
    assert(sourceUnchanged !== false, 'UI replay source changed')
    // The shell's GitHub availability/status reads can probe the connector.
    // Those remain denied and counted, independently of Agent execution.
    assert.deepEqual({ text: deniedCalls.text, vision: deniedCalls.vision, tools: deniedCalls.tools },
      { text: 0, vision: 0, tools: 0 }, 'UI replay attempted Agent execution')
  })()
  return closing
}

input.on('line', (line) => {
  if (closing || !line.trim()) return
  commands = commands.then(async () => {
    if (closing) return
    let action: unknown
    try {
      if (line.length > 256) throw new Error('Control command exceeds 256 characters')
      action = (JSON.parse(line) as { action?: unknown }).action
      if (replay && action !== 'status' && action !== 'shutdown') throw new Error('Real session replay accepts status or shutdown only')
      if (action === 'chunk1' || action === 'chunk2') {
        await appendVisualLongThoughtChunk(created.store, sessionId, action === 'chunk1' ? 1 : 2)
      } else if (action === 'complete') {
        await completeVisualLongThoughtFixture(created.store, sessionId)
      } else if (action === 'shutdown') {
        await shutdown()
        return
      } else if (action !== 'status') {
        throw new Error('Expected chunk1, chunk2, complete, status, or shutdown')
      }
      const state = await created.store.get(sessionId)
      const events = await created.store.events(sessionId)
      console.log(JSON.stringify({ type: 'control', action, ok: true, sessionId,
        status: state.summary.status, lastSeq: events.at(-1)?.seq, usage: state.summary.usage }))
    } catch (error) {
      console.log(JSON.stringify({ type: 'control', action, ok: false,
        error: error instanceof Error ? error.message : String(error) }))
    }
  })
})
const stop = () => void commands.then(shutdown).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
input.once('close', stop)
console.log(JSON.stringify({ type: 'ready', baseUrl, dataRoot, sessions, longThought,
  longThoughtUrl: `${baseUrl}/agent/${sessionId}`, providerCalls: 0, replaySource: replay?.directory,
  defaultFixturesHaveSyntheticUsage: !replay, controls: 'stdin JSON only', retainedOnShutdown: true }))
