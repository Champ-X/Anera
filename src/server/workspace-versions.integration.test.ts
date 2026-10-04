import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelMessage, SessionEvent, SessionSnapshot } from '../shared/types.js'
import type { WorkspaceVersionList } from '../shared/workspace-versions.js'
import { createApp } from './app.js'
import { createWorkspaceArtifact } from './artifact.js'
import { activeTaskMessageSlice, recoverActiveTaskResearchEvidence, recoverActiveTaskRequestText } from './agent-service.js'
import type { DeepSeekClient } from './deepseek.js'
import { WorkspaceVersionService, workspaceVersionFingerprint } from './workspace-versions.js'

type StreamOptions = Parameters<DeepSeekClient['stream']>[0]
type StreamResult = Awaited<ReturnType<DeepSeekClient['stream']>>
type CreatedApp = Awaited<ReturnType<typeof createApp>>
const roots: string[] = []
const apps: CreatedApp[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.agent.shutdown()
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function tool(id: string, name: string, args: Record<string, unknown>): StreamResult {
  return { content: '', reasoningContent: '', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }], finishReason: 'tool_calls',
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, cachedPromptTokens: 0 } }
}
function finish(id: string, evidenceCall: string, summary: string): StreamResult {
  return tool(id, 'finish_task', { summary, outcome: 'completed', checks: [{ requirement: 'Write the requested report content', method: 'Checked the successful workspace write and the exact current report bytes', required: true, status: 'passed', evidence: { callIds: [evidenceCall], paths: ['report.txt'] } }] })
}

async function fixture(stream?: (options: StreamOptions) => Promise<StreamResult>, onDelivery?: (sessionId: string, turnId: string) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-version-integration-'))
  roots.push(root)
  const created = await createApp({ dataRoot: root, model: 'test-model', agent: { verificationMode: 'adaptive', client: { stream: stream ?? (async () => { throw new Error('No model call expected') }) }, onDelivery, runTimeoutMs: 10_000 } })
  apps.push(created)
  const server = createServer(created.app)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address')
  const base = `http://127.0.0.1:${address.port}`
  const sessionId = (await created.store.create()).summary.id
  return { ...created, root, base, sessionId, workspace: created.store.workspaceDir(sessionId) }
}

async function waitForTurn(created: CreatedApp, sessionId: string, turnId: string): Promise<SessionEvent[]> {
  const completed = (events: SessionEvent[]) => events.some((event) => event.turnId === turnId && event.type === 'run.status' && ['completed', 'failed', 'cancelled', 'timed_out'].includes(String(event.data.status)))
  if (!completed(await created.store.events(sessionId))) await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Turn did not settle')) }, 12_000)
    const unsubscribe = created.store.subscribe(sessionId, (event) => {
      if (completed([event])) { clearTimeout(timeout); unsubscribe(); done() }
    })
    void created.store.events(sessionId).then((events) => { if (completed(events)) { clearTimeout(timeout); unsubscribe(); done() } }).catch(reject)
  })
  const events = await created.store.events(sessionId)
  expect(events.findLast((event) => event.turnId === turnId && event.type === 'run.status'), JSON.stringify(events.filter((event) => event.type === 'error'))).toMatchObject({ data: { status: 'completed' } })
  await expect.poll(async () => (await created.store.get(sessionId)).summary.status, { timeout: 2_000, interval: 5 }).toBe('completed')
  return events
}

async function post(base: string, path: string, body?: Record<string, unknown>) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
}

describe('workspace version integration with the real app, agent and file tools', () => {
  it('captures delivery automatically, restores usable artifacts, invalidates stale state and continues from restored bytes', async () => {
    let step = 0
    let continuationMessages: ModelMessage[] = []
    const deliveries: string[] = []
    const f = await fixture(async (options) => {
      step += 1
      if (step === 1) return tool('write_first', 'write_file', { path: 'report.txt', content: 'first\n' })
      if (step === 2) return finish('finish_first', 'write_first', 'Saved first report.')
      if (step === 3) return tool('write_second', 'write_file', { path: 'report.txt', content: 'second, longer\n' })
      if (step === 4) return finish('finish_second', 'write_second', 'Saved second report.')
      if (step === 5) { continuationMessages = options.messages; return tool('read_restored', 'read_file', { path: 'report.txt' }) }
      if (step === 6) {
        const observed = options.messages.findLast((message) => message.role === 'tool' && message.tool_call_id === 'read_restored')
        expect(observed?.content).toContain('first')
        expect(observed?.content).not.toContain('second, longer')
        return tool('write_third', 'write_file', { path: 'report.txt', content: 'first\ncontinued\n' })
      }
      if (step === 7) return finish('finish_third', 'write_third', 'Continued the restored report.')
      throw new Error(`Unexpected model call ${step}`)
    }, async (_session, turnId) => { deliveries.push(turnId) })
    const first = await f.agent.submit(f.sessionId, { content: 'Write report.txt containing first followed by a newline.' })
    await waitForTurn(f, f.sessionId, first.turnId)
    const versionList = await (await fetch(`${f.base}/api/sessions/${f.sessionId}/workspace-versions`)).json() as WorkspaceVersionList
    expect(versionList.versions).toHaveLength(1)
    expect(versionList.versions[0]).toMatchObject({ reason: 'delivery', turnId: first.turnId, fileCount: 1 })
    const version = versionList.versions[0]
    const second = await f.agent.submit(f.sessionId, { content: 'Change report.txt to second, longer followed by a newline.' })
    await waitForTurn(f, f.sessionId, second.turnId)
    expect(deliveries).toEqual([first.turnId, second.turnId])
    const archivedSteering = 'Keep obsolete.txt containing the newer result.'
    await f.store.append(f.sessionId, 'user.steering.applied', { content: archivedSteering }, { turnId: second.turnId })
    await f.store.append(f.sessionId, 'tool.completed', {
      call: { id: 'old_read', name: 'fetch_page', arguments: { url: 'https://old.example/source' } },
      result: JSON.stringify({ status: 'success', url: 'https://old.example/source', content: 'An observed source from the later workspace version.', title: 'Old source' }),
      isError: false,
    }, { turnId: second.turnId, callId: 'old_read' })
    expect(recoverActiveTaskResearchEvidence(await f.store.events(f.sessionId)).sourceUrls).toContain('https://old.example/source')
    await writeFile(resolve(f.workspace, 'obsolete.txt'), 'This belongs only to the newer version')
    await f.store.update(f.sessionId, (state) => {
      state.artifacts = [createWorkspaceArtifact(f.sessionId, 'report.txt'), createWorkspaceArtifact(f.sessionId, 'obsolete.txt')]
      state.website = { status: 'running', previewUrl: '/stale-preview/', port: 65530, processId: 'old_process', updatedAt: new Date().toISOString(), restartCount: 2 }
      state.deployment = { status: 'deployed', revision: 7, url: 'https://published.example/second', visibility: 'public', updatedAt: new Date().toISOString() }
      state.activeTaskResearchEvidence = { schemaVersion: 1, sourceUrls: ['https://old.example/source'], toolCallIds: ['old_read'] }
      state.activeTaskExactFinalRequest = 'OLD EXACT FINAL'
      state.messages.push({ role: 'user', content: archivedSteering })
      state.activeVisualArtifact = { schemaVersion: 1, path: 'report.txt', canonicalWriteCallId: 'write_second', canonicalWriteEventSeq: 1, lastMutationCallId: 'write_second', lastMutationEventSeq: 1, currentHash: createHash('sha256').update('second, longer\n').digest('base64url') }
    })
    const restored = await post(f.base, `/api/sessions/${f.sessionId}/workspace-versions/${version.id}/restore`)
    expect(restored.status).toBe(200)
    const snapshot = await (await fetch(`${f.base}/api/sessions/${f.sessionId}`)).json() as SessionSnapshot
    expect(await readFile(resolve(f.workspace, 'report.txt'), 'utf8')).toBe('first\n')
    expect(snapshot.session.workspaceBytes).toBe(Buffer.byteLength('first\n'))
    expect(snapshot.artifacts.some((artifact) => artifact.path === 'report.txt')).toBe(true)
    expect(snapshot.artifacts.some((artifact) => artifact.path === 'obsolete.txt')).toBe(false)
    expect(snapshot.website).toMatchObject({ status: 'stopped' })
    expect(snapshot.website.previewUrl).toBeUndefined()
    expect(snapshot.deployment).toMatchObject({ status: 'deployed', revision: 7, url: 'https://published.example/second' })
    const state = await f.store.get(f.sessionId)
    expect(state.summary.workspaceBytes).toBe(Buffer.byteLength('first\n'))
    expect(state.activeTaskResearchEvidence).toBeUndefined()
    expect(state.activeTaskExactFinalRequest).toBeUndefined()
    expect(state.activeVisualArtifact).toBeUndefined()
    expect(recoverActiveTaskResearchEvidence(snapshot.events).sourceUrls).toEqual([])
    expect(activeTaskMessageSlice(state.messages).some((message) => message.role === 'tool')).toBe(false)
    const restoreEvent = snapshot.events.findLast((event) => event.type === 'workspace.version.restored')!
    expect(snapshot.events.filter((event) => event.type === 'task.verification.completed').every((event) => event.seq < restoreEvent.seq)).toBe(true)
    const artifact = snapshot.artifacts.find((entry) => entry.path === 'report.txt')!
    expect(await (await fetch(`${f.base}${artifact.downloadUrl}`)).text()).toBe('first\n')
    const third = await f.agent.submit(f.sessionId, { content: 'Continue from this version, read report.txt and append continued followed by a newline.' })
    await waitForTurn(f, f.sessionId, third.turnId)
    expect(continuationMessages.some((message) => typeof message.content === 'string' && message.content.includes('[Workspace restored:'))).toBe(true)
    const system = continuationMessages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n')
    expect(system).toContain('Harness workspace restore task boundary')
    expect(system).toContain('they are not pending tasks or authorization for new changes')
    expect(system).toContain('Do not recreate removed files')
    // Keep the real conversation for audit without reauthorizing its obsolete
    // requests via the controller's durable task projection or repair tail.
    expect(continuationMessages.some((message) => message.role === 'user' && message.content === archivedSteering)).toBe(true)
    const currentRequest = 'Continue from this version, read report.txt and append continued followed by a newline.'
    expect(recoverActiveTaskRequestText(await f.store.events(f.sessionId))).toBe(currentRequest)
    const recoveredControls = continuationMessages.filter((message) => typeof message.content === 'string'
      && message.content.includes('User-authored task requirements recovered from the append-only journal'))
    for (const message of recoveredControls) {
      expect(message.content).not.toContain(archivedSteering)
      expect(message.content).not.toContain('Change report.txt to second, longer')
    }
    expect(await readFile(resolve(f.workspace, 'report.txt'), 'utf8')).toBe('first\ncontinued\n')
    await expect(readFile(resolve(f.workspace, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(step).toBe(7)
    expect((await f.store.events(f.sessionId)).filter((event) => event.type === 'workspace.version.restored')).toHaveLength(1)
  })

  it('archives unapplied steering on restore and never revives it after a hook replay or app restart', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'report.txt'), 'restored baseline')
    const service = new WorkspaceVersionService(f.store, f.agent)
    const saved = await service.captureManual(f.sessionId)
    const obsoleteInstruction = 'Create obsolete.txt containing the abandoned newer instruction.'
    await f.store.update(f.sessionId, (state) => { state.summary.status = 'running' })
    const pending = await f.store.receiveSteering(f.sessionId, { clientMessageId: 'before-restore', content: obsoleteInstruction })
    await f.store.update(f.sessionId, (state) => { state.summary.status = 'cancelled' })
    expect(await f.store.hasPendingSteering(f.sessionId)).toBe(true)

    const response = await post(f.base, `/api/sessions/${f.sessionId}/workspace-versions/${saved.id}/restore`)
    const restored = await response.json() as { restoreId: string }
    expect(response.status, JSON.stringify(restored)).toBe(200)
    expect(await f.store.hasPendingSteering(f.sessionId)).toBe(false)
    expect((await f.store.get(f.sessionId)).steering).toMatchObject([
      { id: pending.id, content: obsoleteInstruction, status: 'archived', archiveReason: 'workspace_restored', restoreId: restored.restoreId },
    ])
    // Crash recovery may replay the semantic hook after its state was written.
    await f.agent.workspaceVersionRestored(f.sessionId, saved, restored.restoreId)
    await f.agent.shutdown()
    let continuationMessages: ModelMessage[] = []
    const restarted = await createApp({ dataRoot: f.root, model: 'test-model', agent: {
      verificationMode: 'adaptive', client: { stream: async (options) => {
        continuationMessages = options.messages
        options.onContent('Ready.')
        return { content: 'Ready.', reasoningContent: '', toolCalls: [], finishReason: 'stop',
          usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4, cachedPromptTokens: 0 } }
      } },
    } })
    apps.push(restarted)
    expect(await restarted.store.hasPendingSteering(f.sessionId)).toBe(false)
    const turn = await restarted.agent.submit(f.sessionId, { content: 'Continue from the restored version without modifying files; say ready.' })
    await waitForTurn(restarted, f.sessionId, turn.turnId)
    expect(continuationMessages.some((message) => typeof message.content === 'string' && message.content.includes(obsoleteInstruction))).toBe(false)
    const events = await restarted.store.events(f.sessionId)
    expect(events.filter((event) => event.type === 'user.steering.received' && event.data.id === pending.id)).toHaveLength(1)
    expect(events.filter((event) => event.type === 'user.steering.archived')).toHaveLength(1)
    expect(events.some((event) => event.type === 'user.steering.applied')).toBe(false)
    expect(await readFile(resolve(f.workspace, 'report.txt'), 'utf8')).toBe('restored baseline')
    await expect(readFile(resolve(f.workspace, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks both submit and resume while a real restore journal is pending, then retries through the API', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'report.txt'), 'saved')
    const savedResponse = await post(f.base, `/api/sessions/${f.sessionId}/workspace-versions`, { label: 'Saved' })
    expect(savedResponse.status).toBe(201)
    const { version } = await savedResponse.json() as { version: WorkspaceVersionList['versions'][number] }
    await writeFile(resolve(f.workspace, 'report.txt'), 'changed')
    const interrupted = new WorkspaceVersionService(f.store, f.agent, {
      onRestorePhase: async (phase) => { if (phase === 'installed') throw new Error('Interrupted before semantic reconciliation') },
    })
    await expect(interrupted.restore(f.sessionId, version.id)).rejects.toThrow('Interrupted')
    await expect(f.agent.submit(f.sessionId, { content: 'Continue' })).rejects.toMatchObject({ statusCode: 409 })
    await expect(f.agent.resume(f.sessionId)).rejects.toMatchObject({ statusCode: 409 })
    const blockedUpload = await post(f.base, `/api/sessions/${f.sessionId}/files`, {
      name: 'not-accepted.txt', mime: 'text/plain', contentBase64: Buffer.from('Do not write into an unsettled restore').toString('base64'),
    })
    const blockedRestart = await post(f.base, `/api/sessions/${f.sessionId}/website/restart`)
    expect(blockedUpload.status).toBe(409)
    expect(blockedRestart.status).toBe(409)
    expect((await f.store.events(f.sessionId)).some((event) => event.type === 'file.changed' && event.data.path === 'uploads/not-accepted.txt')).toBe(false)
    await expect(readFile(resolve(f.workspace, 'uploads/not-accepted.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.store.events(f.sessionId)).some((event) => event.type === 'turn.started' || event.type === 'run.resumed')).toBe(false)
    const retried = await post(f.base, `/api/sessions/${f.sessionId}/workspace-versions/${version.id}/restore`)
    expect(retried.status).toBe(200)
    expect(await readFile(resolve(f.workspace, 'report.txt'), 'utf8')).toBe('saved')
    expect((await f.store.events(f.sessionId)).filter((event) => event.type === 'workspace.version.restored')).toHaveLength(1)
  })

  it('manual capture leaves a live preview process running, while restore stops it before swapping files', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'report.txt'), 'saved')
    const processRecord = await f.agent.processes.start(f.sessionId, f.workspace, "node -e 'setInterval(() => {}, 1000)'")
    const saved = await post(f.base, `/api/sessions/${f.sessionId}/workspace-versions`)
    expect(saved.status).toBe(201)
    expect(f.agent.processes.get(f.sessionId, processRecord.id)?.status).toBe('running')
    const { version } = await saved.json() as { version: WorkspaceVersionList['versions'][number] }
    const restored = await post(f.base, `/api/sessions/${f.sessionId}/workspace-versions/${version.id}/restore`)
    expect(restored.status).toBe(200)
    expect(f.agent.processes.get(f.sessionId, processRecord.id)?.status).not.toBe('running')
  })

  it('starts the real app when one restore cannot recover, keeps that session blocked and permits a later HTTP retry', async () => {
    const f = await fixture()
    const healthySessionId = (await f.store.create()).summary.id
    await writeFile(resolve(f.workspace, 'report.txt'), 'saved')
    const interrupted = new WorkspaceVersionService(f.store, f.agent, {
      onRestorePhase: async (phase) => { if (phase === 'installed') throw new Error('Interrupted restore') },
    })
    const version = await interrupted.captureManual(f.sessionId)
    await writeFile(resolve(f.workspace, 'report.txt'), 'changed')
    await expect(interrupted.restore(f.sessionId, version.id)).rejects.toThrow('Interrupted restore')
    const journalPath = resolve(f.store.sessionDir(f.sessionId), 'workspace-versions/restore.json')
    const journal = await readFile(journalPath, 'utf8')
    const snapshotFile = resolve(f.store.sessionDir(f.sessionId), 'workspace-versions', version.id, 'files/report.txt')
    await writeFile(snapshotFile, 'corrupted snapshot')
    await f.agent.shutdown()
    let modelCalls = 0
    const restarted = await createApp({ dataRoot: f.root, model: 'test-model', agent: {
      verificationMode: 'adaptive', client: { stream: async (options) => {
        modelCalls += 1
        options.onContent('Done.')
        return { content: 'Done.', reasoningContent: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4, cachedPromptTokens: 0 } }
      } },
    } })
    apps.push(restarted)
    const server = createServer(restarted.app)
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address')
    const base = `http://127.0.0.1:${address.port}`
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
    expect((await fetch(`${base}/api/sessions/${f.sessionId}`)).status).toBe(200)
    expect((await fetch(`${base}/api/sessions/${f.sessionId}/workspace-versions`)).status).toBe(200)
    expect(await readFile(journalPath, 'utf8')).toBe(journal)
    expect(modelCalls).toBe(0)
    await new WorkspaceVersionService(restarted.store, restarted.agent).recoverAll()
    const failures = (await restarted.store.events(f.sessionId)).filter((event) => event.type === 'workspace.version.failed')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ data: { reason: 'restore_recovery' } })
    expect((await post(base, `/api/sessions/${f.sessionId}/messages`, { content: 'Say done.' })).status).toBe(409)
    expect((await post(base, `/api/sessions/${f.sessionId}/files`, {
      name: 'blocked.txt', mime: 'text/plain', contentBase64: Buffer.from('Blocked').toString('base64'),
    })).status).toBe(409)
    expect((await post(base, `/api/sessions/${f.sessionId}/website/restart`)).status).toBe(409)
    const healthyRun = await post(base, `/api/sessions/${healthySessionId}/messages`, { content: 'Say done.' })
    expect(healthyRun.status).toBe(202)
    await waitForTurn(restarted, healthySessionId, (await healthyRun.json() as { turnId: string }).turnId)
    expect(modelCalls).toBe(1)
    expect((await restarted.store.events(f.sessionId)).some((event) => event.type === 'workspace.version.restored')).toBe(false)
    await writeFile(snapshotFile, 'saved')
    expect((await post(base, `/api/sessions/${f.sessionId}/workspace-versions/${version.id}/restore`)).status).toBe(200)
    await expect(readFile(journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(resolve(f.workspace, 'report.txt'), 'utf8')).toBe('saved')
  })

  it('a delivery snapshot failure reports the limitation without discarding the completed result or rerunning the model', async () => {
    let calls = 0
    const f = await fixture(async (options) => {
      calls += 1
      options.onContent('A short direct response.')
      return { content: 'A short direct response.', reasoningContent: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 4, completionTokens: 4, totalTokens: 8, cachedPromptTokens: 0 } }
    })
    // The normal onDelivery callback must report a genuine snapshot admission failure.
    await writeFile(resolve(f.workspace, 'report.txt'), 'An existing result remains intact.')
    await symlink(resolve(f.root, 'outside-workspace'), resolve(f.workspace, 'unsafe-link'))
    const run = await f.agent.submit(f.sessionId, { content: 'Say a short sentence.' })
    const events = await waitForTurn(f, f.sessionId, run.turnId)
    expect(calls).toBe(1)
    expect(events.find((event) => event.type === 'workspace.version.failed')).toMatchObject({ data: { reason: 'delivery_snapshot' } })
    expect(events.find((event) => event.type === 'assistant.final')).toMatchObject({ data: { content: 'A short direct response.' } })
  })

  it('accepts a follow-up submitted immediately when the client receives the terminal status event', async () => {
    const f = await fixture(async (options) => {
      options.onContent('Done.')
      return { content: 'Done.', reasoningContent: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4, cachedPromptTokens: 0 } }
    })
    let submitted = false
    let receiveFollowup!: (value: Promise<{ turnId: string }>) => void
    const followup = new Promise<{ turnId: string }>((resolveNext) => { receiveFollowup = resolveNext })
    const unsubscribe = f.store.subscribe(f.sessionId, (event) => {
      if (!submitted && event.type === 'run.status' && event.data.status === 'completed') {
        submitted = true
        receiveFollowup(f.agent.submit(f.sessionId, { content: 'Say done again.' }))
      }
    })
    try {
      await f.agent.submit(f.sessionId, { content: 'Say done.' })
      const next = await followup
      await waitForTurn(f, f.sessionId, next.turnId)
      expect((await f.store.events(f.sessionId)).filter((event) => event.type === 'turn.started')).toHaveLength(2)
    } finally { unsubscribe() }
  })

  it.each(['before_capture', 'after_snapshot', 'before_capture_current_changed', 'after_snapshot_current_changed'] as const)(
    'reconciles an accepted terminal outcome after a restart at %s', async (boundary) => {
      const f = await fixture()
      const turnId = 'turn_delivery_recovery'
      await writeFile(resolve(f.workspace, 'report.txt'), 'accepted delivery\n')
      const sha256 = await workspaceVersionFingerprint(f.workspace)
      await f.store.append(f.sessionId, 'turn.started', { content: 'Save this report.', attachments: [] }, { turnId })
      await f.store.update(f.sessionId, (state) => { state.summary.status = 'running' })
      await f.store.stageRunTerminal(f.sessionId, {
        turnId, status: 'completed', createdAt: new Date().toISOString(),
        events: [
          { id: 'evt_delivery_recovery_final', type: 'assistant.final', data: { content: 'Saved report.', finishReason: 'stop' } },
          { id: 'evt_delivery_recovery_turn', type: 'turn.completed', data: { status: 'completed' } },
          { id: 'evt_delivery_recovery_status', type: 'run.status', data: { status: 'completed' } },
        ],
        workspacePersistenceEvents: [{ id: 'evt_delivery_recovery_workspace', type: 'workspace.persistence.completed',
          data: { fileCount: 1, bytes: Buffer.byteLength('accepted delivery\n'), workspaceVersion: { sha256 } } }],
      })
      let installedVersionId: string | undefined
      if (boundary.startsWith('after_snapshot')) {
        const crashed = new WorkspaceVersionService(f.store, f.agent, {
          onCapturePhase: async () => { throw new Error('Process loss after immutable snapshot rename') },
        })
        await expect(crashed.capture(f.sessionId, { reason: 'delivery', turnId })).rejects.toThrow('Process loss')
        installedVersionId = (await crashed.list(f.sessionId)).versions[0].id
        expect((await f.store.events(f.sessionId)).some((event) => event.type === 'workspace.version.created')).toBe(false)
      }
      if (boundary.endsWith('current_changed')) await writeFile(resolve(f.workspace, 'report.txt'), 'newer unrelated bytes\n')
      await f.agent.shutdown()
      const restarted = await createApp({ dataRoot: f.root, model: 'test-model', agent: {
        client: { stream: async () => { throw new Error('Recovery must never call the model') } },
      } })
      apps.push(restarted)
      const versions = new WorkspaceVersionService(restarted.store, restarted.agent)
      const events = await restarted.store.events(f.sessionId)
      expect((await restarted.store.get(f.sessionId)).summary.status).toBe('completed')
      const saved = (await versions.list(f.sessionId)).versions
      if (boundary === 'before_capture_current_changed') {
        expect(saved).toHaveLength(0)
        expect(events.filter((event) => event.type === 'workspace.version.failed')).toMatchObject([
          { turnId, data: { reason: 'delivery_snapshot_recovery', expectedSha256: sha256 } },
        ])
      } else {
        expect(saved).toHaveLength(1)
        expect(saved[0]).toMatchObject({ reason: 'delivery', turnId, sha256 })
        if (installedVersionId) expect(saved[0].id).toBe(installedVersionId)
        expect(events.filter((event) => event.type === 'workspace.version.created')).toHaveLength(1)
        expect(events.some((event) => event.type === 'workspace.version.failed')).toBe(false)
      }
      await versions.recoverAll()
      expect((await versions.list(f.sessionId)).versions).toEqual(saved)
      expect(await restarted.store.events(f.sessionId)).toEqual(events)
      expect(await readFile(resolve(f.workspace, 'report.txt'), 'utf8')).toBe(boundary.endsWith('current_changed') ? 'newer unrelated bytes\n' : 'accepted delivery\n')
    },
  )

  it('queues HTTP uploads and preview restart behind directory restoration, then uses the restored workspace', async () => {
    const f = await fixture()
    await writeFile(resolve(f.workspace, 'index.html'), '<h1>Saved version</h1>')
    const versions = new WorkspaceVersionService(f.store, f.agent)
    const saved = await versions.captureManual(f.sessionId)
    await writeFile(resolve(f.workspace, 'index.html'), '<h1>Old live process version</h1>')
    await f.store.update(f.sessionId, (state) => {
      state.website = { status: 'sleeping', processId: 'old_missing_process', previewUrl: 'http://127.0.0.1:65530', updatedAt: new Date().toISOString(), restartCount: 1 }
    })
    let entered!: () => void
    let release!: () => void
    const atSwap = new Promise<void>((resolveEntered) => { entered = resolveEntered })
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const gated = new WorkspaceVersionService(f.store, f.agent, {
      onRestorePhase: async (phase) => { if (phase === 'workspace_moved') { entered(); await gate } },
    })
    const restoring = gated.restore(f.sessionId, saved.id)
    await atSwap
    const uploading = post(f.base, `/api/sessions/${f.sessionId}/files`, { name: 'during-restore.txt', mime: 'text/plain', contentBase64: Buffer.from('Upload accepted during restore').toString('base64') })
    const restarting = post(f.base, `/api/sessions/${f.sessionId}/website/restart`)
    try {
      const first = await Promise.race([
        uploading.then(() => 'upload-finished'), restarting.then(() => 'restart-finished'),
        new Promise<string>((done) => setTimeout(() => done('both-queued'), 30)),
      ])
      expect(first).toBe('both-queued')
    } finally { release() }
    await restoring
    const [uploaded, restarted] = await Promise.all([uploading, restarting])
    expect(uploaded.status).toBe(201)
    const upload = await uploaded.json() as { path: string }
    expect(await readFile(resolve(f.workspace, upload.path), 'utf8')).toBe('Upload accepted during restore')
    expect(restarted.status).toBe(200)
    const restart = await restarted.json() as { website: { processId?: string; entryPath?: string; previewUrl: string } }
    expect(restart.website.processId).toBeUndefined()
    expect(restart.website.entryPath).toBe('index.html')
    expect(await (await fetch(`${f.base}${restart.website.previewUrl}`)).text()).toContain('Saved version')
    const events = await f.store.events(f.sessionId)
    const restoredSeq = events.find((event) => event.type === 'workspace.version.restored')!.seq
    expect(events.find((event) => event.type === 'file.changed' && event.data.path === upload.path)!.seq).toBeGreaterThan(restoredSeq)
    expect(events.filter((event) => event.type === 'website.updated').every((event) => event.seq > restoredSeq)).toBe(true)
  })

  it('continues to accept HTTP uploads while the Agent is running', async () => {
    let entered!: () => void
    let release!: () => void
    const inModel = new Promise<void>((done) => { entered = done })
    const gate = new Promise<void>((done) => { release = done })
    const f = await fixture(async (options) => {
      entered()
      await gate
      options.onContent('Done.')
      return { content: 'Done.', reasoningContent: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4, cachedPromptTokens: 0 } }
    })
    const run = await f.agent.submit(f.sessionId, { content: 'Say done.' })
    await inModel
    try {
      expect((await f.store.get(f.sessionId)).summary.status).toBe('running')
      const response = await post(f.base, `/api/sessions/${f.sessionId}/files`, { name: 'running.txt', mime: 'text/plain', contentBase64: Buffer.from('Still accepted').toString('base64') })
      expect(response.status).toBe(201)
      expect(await readFile(resolve(f.workspace, 'uploads/running.txt'), 'utf8')).toBe('Still accepted')
    } finally { release() }
    await waitForTurn(f, f.sessionId, run.turnId)
  })
})
