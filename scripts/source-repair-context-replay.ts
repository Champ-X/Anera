/** Read-only regression replay. No AgentService instance, model client, server
 * or browser is started. The supplied session and workspace are never written.
 * Usage: npm exec -- tsx scripts/source-repair-context-replay.ts <session-dir>
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  canonicalDiagnosticReadCursor, compactHistoricalToolPayloads,
  referenceStyleArtifactRepairPhase, visualWorkflowCompactionAnchors,
} from '../src/server/agent-service.js'
import { readHydratedSessionEventLog, type StoredSession } from '../src/server/session-store.js'
import { arenaActiveToolModelOutput } from '../src/server/tools.js'
import type { ToolCallRecord } from '../src/shared/types.js'

assert(process.argv[2], 'Supply the existing failed session directory; this script never starts a live canary.')
const directory = resolve(process.argv[2])
const statePath = resolve(directory, 'state.json')
const eventPath = resolve(directory, 'events.jsonl')
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const stateBytes = await readFile(statePath)
const eventBytes = await readFile(eventPath)
const state = JSON.parse(stateBytes.toString('utf8')) as StoredSession
const artifact = state.activeVisualArtifact
assert(artifact, 'This replay requires durable canonical-artifact identity.')
const artifactPath = resolve(directory, 'workspace', artifact.path)
assert(artifactPath.startsWith(resolve(directory, 'workspace') + '/'), 'Artifact must stay inside the session workspace.')
const artifactBytes = await readFile(artifactPath)
const events = await readHydratedSessionEventLog(eventPath)
const missingReads = state.messages.filter((message) => message.role === 'tool'
  && typeof message.content === 'string' && message.content.startsWith('[Historical tool result compacted'))
  .flatMap((message) => {
    const event = events.find((entry) => entry.type === 'tool.completed' && entry.callId === message.tool_call_id
      && entry.seq > artifact.lastMutationEventSeq)
    const call = event?.data.call as ToolCallRecord | undefined
    if (!event || call?.name !== 'read_file' || call.arguments.path !== artifact.path) return []
    assert.equal(typeof event.data.result, 'string')
    return [{ message, content: arenaActiveToolModelOutput('read_file', event.data.result as string) }]
  })
assert(missingReads.length > 0, 'Expected an actually compacted current canonical read, not a synthetic failure.')
assert.equal(referenceStyleArtifactRepairPhase(state.messages, artifact.path), 'read')
const cursor = canonicalDiagnosticReadCursor(state.messages, artifact.path)
assert.deepEqual(cursor, { path: artifact.path, offset: 1, limit: 5_000 })

// Restore only already-executed, CAS-verified tool payloads in memory. The
// recorded terminal suffix remains untouched and is not fetched again.
const restored = state.messages.map((message) => {
  const original = missingReads.find((entry) => entry.message === message)
  return original ? { ...message, content: original.content } : message
})
assert.equal(referenceStyleArtifactRepairPhase(restored, artifact.path), 'edit')
const compacted = compactHistoricalToolPayloads(restored, { forceResultCompaction: true, canonicalPath: artifact.path })
const anchors = visualWorkflowCompactionAnchors(compacted.messages, artifact.path, true)
for (const read of missingReads) {
  const retained = compacted.messages.find((message) => message.tool_call_id === read.message.tool_call_id)
  assert.equal(retained?.content, read.content)
  assert(anchors.has(retained!))
}
for (const [path, bytes] of [[statePath, stateBytes], [eventPath, eventBytes], [artifactPath, artifactBytes]] as const) {
  assert.equal(hash(await readFile(path)), hash(bytes), `Read-only replay changed ${path}`)
}
console.log(JSON.stringify({
  passed: true, liveModelCalls: 0, session: state.summary.id, hydratedEvents: events.length,
  before: 'read', cursor, afterInMemoryRestore: 'edit', forcedCompactionRetainsRepairBytes: true,
  restored: missingReads.map((entry) => ({ callId: entry.message.tool_call_id,
    retainedBytes: Buffer.byteLength(entry.message.content as string), originalBytes: Buffer.byteLength(entry.content), sha256: hash(entry.content) })),
  unchanged: { state: hash(stateBytes), events: hash(eventBytes), artifact: hash(artifactBytes) },
}, null, 2))
