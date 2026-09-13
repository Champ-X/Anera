import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type { DeepSeekClient } from './deepseek.js'

it('carries real browser failures through tools, durable events and the next Agent decision, then verifies repair', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-browser-runtime-recovery-'))
  let base = ''
  let requests = 0
  const feedback: boolean[] = []
  const actions = [
    { name: 'browser', args: { action: 'open', path: 'demo.html' } },
    { name: 'browser', args: { action: 'press', key: 'Space' } },
    { name: 'browser', args: { action: 'screenshot', screenshot_path: 'failure.png' } },
    { name: 'edit_file', args: { path: 'demo.html', old_text: 'hsla(45,100,50,0)', new_text: 'hsla(45,100%,50%,0)' } },
    { name: 'browser', args: { action: 'open', path: 'demo.html' } },
    { name: 'browser', args: { action: 'press', key: 'Space' } },
    { name: 'present_file', args: { path: 'demo.html' } },
  ]
  // Provider choices are scripted to test orchestration, while the app server,
  // tools, Chromium exception, workspace repair and evidence are all real.
  const stream = vi.fn(async (options: Parameters<DeepSeekClient['stream']>[0]) => {
    await options.beforeRequest?.()
    feedback.push(JSON.stringify(options.messages).includes('Harness browser runtime observations for the currently loaded document'))
    const action = actions[requests++]
    if (!action) options.onContent('Repaired and verified the affected interaction.')
    return { content: action ? '' : 'Repaired and verified the affected interaction.', reasoningContent: '',
      toolCalls: action ? [{ id: `call_runtime_${requests}`, type: 'function' as const,
        function: { name: action.name, arguments: JSON.stringify(action.args) } }] : [],
      finishReason: action ? 'tool_calls' as const : 'stop' as const,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, cachedPromptTokens: 0 },
      modelCallCount: 1, modelRequestCount: 1 }
  })
  const created = await createApp({ dataRoot: root, model: 'test-model', agent: {
    client: { stream } as never, maxAgentModelRequestsPerTurn: 0, maxAgentTotalTokensPerTurn: 0,
    toolExecutorDependencies: { localAppBaseUrl: () => base },
  } })
  const server = createServer(created.app)
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const session = await created.store.create()
    const id = session.summary.id
    const html = `<canvas></canvas><p id="status">Ready</p><script>
      addEventListener('keydown', () => requestAnimationFrame(() => {
        const gradient = document.querySelector('canvas').getContext('2d').createRadialGradient(0,0,0,1,1,1);
        gradient.addColorStop(1, 'hsla(45,100,50,0)');
        document.querySelector('#status').textContent = 'Running';
      }));
    </script>`
    await writeFile(resolve(created.store.workspaceDir(id), 'demo.html'), html)
    await created.agent.submit(id, { content: 'Fix the existing program and verify in the browser that pressing Space works.' })
    await vi.waitFor(async () => {
      const state = await created.store.get(id)
      expect(state.summary.status).toBe('completed')
    }, { timeout: 20_000, interval: 50 })
    const failed = (await created.store.events(id)).filter(event => event.type === 'tool.failed' || event.type === 'error')
    expect(failed.map(event => event.data)).toEqual([])
    expect(requests).toBe(8)
    expect(feedback).toEqual([false, false, true, true, true, false, false, false])
    const response = await fetch(`${base}/api/sessions/${id}`)
    const snapshot = await response.json()
    const terminals = snapshot.events.filter((event: { type: string }) => event.type === 'tool.completed')
    const browserResults = terminals.filter((event: { data: { call: { name: string } } }) => event.data.call.name === 'browser')
    expect(browserResults[1].data.result).toContain('addColorStop')
    expect(browserResults[2].data.result).toContain('Browser runtime diagnostics')
    expect(JSON.parse(browserResults[4].data.result)).toMatchObject({ text: 'Running', runtimeDiagnostics: { errorCount: 0 } })
    expect(await readFile(resolve(created.store.workspaceDir(id), 'demo.html'), 'utf8')).toBe(html.replace('hsla(45,100,50,0)', 'hsla(45,100%,50%,0)'))
    expect(snapshot.events.filter((event: { type: string }) => event.type === 'tool.failed' || event.type === 'error')).toEqual([])
  } finally {
    await created.agent.shutdown()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
