import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentService } from './agent-service.js'
import { createApp } from './app.js'
import { SessionStore } from './session-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed Website recovery', () => {
  it('projects a published Website to failed when its current managed process exits', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-website-process-exit-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeFile(resolve(store.workspaceDir(session.summary.id), 'exit-server.mjs'), 'setTimeout(() => process.exit(3), 300)\n', 'utf8')
    const agent = new AgentService(store)
    try {
      const managed = await agent.processes.start(session.summary.id, store.workspaceDir(session.summary.id), 'node exit-server.mjs', undefined, {
        turnId: 'turn_process_exit',
        stepId: 'step_process_exit',
        callId: 'call_process_exit',
      })
      await store.update(session.summary.id, (state) => {
        state.website = {
          status: 'running',
          processId: managed.id,
          port: 43131,
          previewUrl: 'http://127.0.0.1:43131',
          updatedAt: new Date().toISOString(),
          restartCount: 0,
        }
      })

      await waitUntil(async () => (await store.get(session.summary.id)).website.status === 'failed')
      const state = await store.get(session.summary.id)
      expect(state.processes.find((process) => process.id === managed.id)).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(state.website).toMatchObject({ status: 'failed', processId: managed.id })
      expect((await store.events(session.summary.id)).find((event) => (
        event.type === 'website.updated' && event.data?.action === 'process_stopped'
      ))).toMatchObject({
        turnId: 'turn_process_exit',
        stepId: 'step_process_exit',
        callId: 'call_process_exit',
        data: { processStatus: 'failed', website: { status: 'failed', processId: managed.id } },
      })
    } finally {
      await agent.shutdown()
    }
  })

  it('automatically sleeps an idle terminal Website while preserving Restart state', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-website-process-asleep-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeFile(resolve(store.workspaceDir(session.summary.id), 'sleep-server.mjs'), 'setInterval(() => {}, 1000)\n', 'utf8')
    const stream = async (options: { onContent: (delta: string) => void }) => {
      options.onContent('Website delivery complete.')
      return {
        content: 'Website delivery complete.',
        reasoningContent: '',
        toolCalls: [],
        finishReason: 'stop' as const,
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, cachedPromptTokens: 0 },
      }
    }
    const agent = new AgentService(store, {
      client: { stream } as never,
      websiteIdleSleepMs: 50,
    })
    try {
      const context = {
        turnId: 'turn_process_asleep',
        stepId: 'step_process_asleep',
        callId: 'call_process_asleep',
      }
      const managed = await agent.processes.start(
        session.summary.id,
        store.workspaceDir(session.summary.id),
        'node sleep-server.mjs',
        undefined,
        context,
      )
      await store.update(session.summary.id, (state) => {
        state.website = {
          status: 'running',
          processId: managed.id,
          port: 43132,
          previewUrl: 'http://127.0.0.1:43132',
          updatedAt: new Date().toISOString(),
          restartCount: 0,
        }
      })

      await agent.submit(session.summary.id, { content: 'Finish the current Website task.' })
      await waitUntil(async () => (await store.get(session.summary.id)).summary.status === 'completed')
      await waitUntil(async () => (await store.get(session.summary.id)).website.status === 'asleep')
      const state = await store.get(session.summary.id)
      expect(state.processes.find((process) => process.id === managed.id)).toMatchObject({ status: 'stopped' })
      expect(state.website).toMatchObject({ status: 'asleep', processId: managed.id, port: 43132 })
      expect((await store.events(session.summary.id)).findLast((event) => event.type === 'website.updated')).toMatchObject({
        data: { action: 'process_stopped', processStatus: 'stopped', website: { status: 'asleep', processId: managed.id } },
      })
    } finally {
      await agent.shutdown()
    }
  })

  it('cancels a pending idle sleep for a new run and reschedules it after the run completes', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-website-sleep-admission-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeFile(resolve(store.workspaceDir(session.summary.id), 'active-server.mjs'), 'setInterval(() => {}, 1000)\n', 'utf8')
    const stream = async (options: { onContent: (delta: string) => void }) => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 150))
      options.onContent('Follow-up complete.')
      return {
        content: 'Follow-up complete.',
        reasoningContent: '',
        toolCalls: [],
        finishReason: 'stop' as const,
        usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13, cachedPromptTokens: 0 },
      }
    }
    const agent = new AgentService(store, {
      client: { stream } as never,
      websiteIdleSleepMs: 80,
    })
    try {
      const managed = await agent.processes.start(
        session.summary.id,
        store.workspaceDir(session.summary.id),
        'node active-server.mjs',
      )
      await store.update(session.summary.id, (state) => {
        state.website = {
          status: 'running',
          processId: managed.id,
          port: 43133,
          previewUrl: 'http://127.0.0.1:43133',
          updatedAt: new Date().toISOString(),
          restartCount: 0,
        }
      })

      await agent.scheduleWebsiteSleep(session.summary.id)
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
      await agent.submit(session.summary.id, { content: 'Continue checking the Website.' })
      await new Promise((resolveWait) => setTimeout(resolveWait, 90))
      expect((await store.get(session.summary.id)).website.status).toBe('running')
      expect(agent.processes.get(session.summary.id, managed.id)?.status).toBe('running')

      await waitUntil(async () => (await store.get(session.summary.id)).summary.status === 'completed')
      await waitUntil(async () => (await store.get(session.summary.id)).website.status === 'asleep')
      expect(agent.processes.get(session.summary.id, managed.id)?.status).toBe('stopped')
    } finally {
      await agent.shutdown()
    }
  })

  it('restarts a recovered Website from its durable process command when no live record exists', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-website-durable-restart-'))
    roots.push(root)
    const port = await reservePort()
    const first = new SessionStore(root, 'test-model')
    await first.initialize()
    const session = await first.create()
    await writeFile(resolve(first.workspaceDir(session.summary.id), 'server.mjs'), `import { createServer } from 'node:http'\ncreateServer((_request, response) => response.end('DURABLE-RESTART-OK')).listen(${port}, '127.0.0.1')\n`, 'utf8')
    const startedAt = new Date(Date.now() - 1_000).toISOString()
    const stoppedAt = new Date().toISOString()
    const runningRecord = {
      id: 'proc_durablerestart0001',
      command: 'node server.mjs',
      pid: 999_999_994,
      port,
      portHint: port,
      status: 'running' as const,
      startedAt,
      stdout: '',
      stderr: '',
    }
    const interruptedRecord = {
      ...runningRecord,
      status: 'interrupted' as const,
      completedAt: stoppedAt,
      signal: 'SERVER_RESTART',
    }
    const asleepWebsite = {
      status: 'asleep' as const,
      processId: runningRecord.id,
      port,
      previewUrl: `http://127.0.0.1:${port}`,
      updatedAt: stoppedAt,
      restartCount: 0,
    }
    const context = { turnId: 'turn_durable_restart', stepId: 'step_durable_restart', callId: 'call_durable_restart' }
    await first.append(session.summary.id, 'process.started', { type: 'started', record: runningRecord }, context)
    await first.append(session.summary.id, 'process.stopped', { type: 'stopped', record: interruptedRecord }, context)
    await first.append(session.summary.id, 'website.updated', { website: asleepWebsite, action: 'server_restarted', recovered: true }, context)
    await first.update(session.summary.id, (state) => {
      state.processes = [interruptedRecord]
      state.website = asleepWebsite
    })

    const created = await createApp({ dataRoot: root, model: 'test-model' })
    const server = createServer(created.app)
    try {
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test API server did not bind')
      const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${session.summary.id}/website/restart`, { method: 'POST' })
      expect(response.status).toBe(200)
      const body = await response.json() as { website: { status: string; processId: string; port: number; previewUrl: string; restartCount: number } }
      expect(body.website).toMatchObject({
        status: 'running',
        processId: expect.stringMatching(/^proc_/),
        port,
        previewUrl: `http://127.0.0.1:${port}`,
        restartCount: 1,
      })
      expect(body.website.processId).not.toBe(runningRecord.id)
      expect(await fetch(body.website.previewUrl).then((item) => item.text())).toBe('DURABLE-RESTART-OK')

      const state = await created.store.get(session.summary.id)
      expect(state.processes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: runningRecord.id, status: 'interrupted' }),
        expect.objectContaining({ id: body.website.processId, status: 'running', portHint: port }),
      ]))
      const events = await created.store.events(session.summary.id)
      expect(events.findLast((event) => event.type === 'website.updated')).toMatchObject({
        turnId: context.turnId,
        stepId: context.stepId,
        callId: context.callId,
        data: {
          action: 'restarted',
          previousProcessId: runningRecord.id,
          website: { status: 'running', processId: body.website.processId, restartCount: 1 },
        },
      })
    } finally {
      await created.agent.shutdown()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })
})

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Port probe did not bind')
  const port = address.port
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  return port
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for managed Website state')
}
