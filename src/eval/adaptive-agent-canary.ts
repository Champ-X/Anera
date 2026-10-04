import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createApp } from '../server/app.js'
import type { DeepSeekClient } from '../server/deepseek.js'
import type { DeepSeekVisionClient } from '../server/vision.js'
import { findBrowserExecutable } from '../server/browser-executable.js'
import { workspaceFileSnapshot } from '../server/workspace.js'
import type { ModelTestBudget } from './model-test-budget.js'
import { observeSessionRun } from './session-run-observer.js'

/** Real provider, actual API and files, independent outcome checks. Called only by the metered live entry. */
export async function runAdaptiveAgentCanary(options: {
  client: Pick<DeepSeekClient, 'stream'>; vision: DeepSeekVisionClient; model: string; budget: ModelTestBudget; dataRoot: string
  restoreSource?: { dataRoot: string; sessionId: string; versionId: string }
}) {
  const initialBudget = options.budget.snapshot()
  const results: Array<Record<string, unknown>> = []
  const root = join(options.dataRoot, 'runtime')
  const publicFiles = async (workspace: string, except?: string) => [...await workspaceFileSnapshot(workspace)]
    .filter(([path]) => path !== except).map(([path, file]) => [path, file.sha256] as const)
  const appendsReviewLine = (before: string, after: string) => after.startsWith(before)
    && /^(?:\r?\n)?复核完成(?:\r?\n)?$/u.test(after.slice(before.length))
    && (before.endsWith('\n') || /^\r?\n/u.test(after.slice(before.length)))
  const source = options.restoreSource
  let sourceIdentity: string | undefined
  const sourceDigest = async () => {
    if (!source) return ''
    const directory = join(source.dataRoot, 'sessions', source.sessionId)
    return createHash('sha256').update(await readFile(join(directory, 'state.json')))
      .update(await readFile(join(directory, 'events.jsonl')))
      .update(JSON.stringify(await publicFiles(join(directory, 'workspace')))).digest('hex')
  }
  if (source) {
    if (!/^ses_[a-zA-Z0-9]+$/u.test(source.sessionId) || !/^wsv_[a-f0-9]{20}$/u.test(source.versionId)) throw new Error('Invalid restore replay identity')
    const sourceDirectory = join(source.dataRoot, 'sessions', source.sessionId)
    const state = JSON.parse(await readFile(join(sourceDirectory, 'state.json'), 'utf8'))
    if (state.summary?.status !== 'completed' || state.pendingTerminal || state.pendingStart) throw new Error('Restore replay requires a terminal source')
    sourceIdentity = await sourceDigest()
    await mkdir(join(root, 'sessions'), { recursive: true })
    await cp(sourceDirectory, join(root, 'sessions', source.sessionId), { recursive: true, errorOnExist: true, force: false, dereference: false })
  }
  let base = ''
  const runtime = await createApp({ dataRoot: root, model: options.model, agent: {
    client: options.client, vision: options.vision, models: [options.model], runTimeoutMs: 900_000,
    toolExecutorDependencies: {
      localAppBaseUrl: () => base,
      fetch: async () => { throw new Error('This local-outcome canary does not authorize unpriced external tool providers.') },
    },
    modelTransportObserver: (event) => console.log(JSON.stringify({ diagnostic: 'adaptive_transport', ...event })),
  } })
  const server = createServer(runtime.app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Canary server did not bind')
  base = `http://127.0.0.1:${address.port}`
  const persist = () => writeFile(join(options.dataRoot, 'adaptive-report.json'), JSON.stringify({
    mode: source ? 'adaptive_restore_replay' : 'adaptive', model: options.model, dataRoot: root, results,
    ...(source ? { restoreSource: source, sourceIdentity } : {}),
    initialBudget, budget: options.budget.snapshot(),
    passed: results.length === (source ? 1 : 6) && results.every((result) => result.passed === true),
  }, null, 2))
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Canary API ${path}: HTTP ${response.status} ${await response.text()}`)
    return await response.json()
  }
  const newSession = async () => (await request('/api/sessions', {})).session.id as string
  async function turn(name: string, sessionId: string, content: string, correction?: { afterPath: string; content: string }) {
    const afterSeq = (await runtime.store.events(sessionId)).at(-1)?.seq ?? 0
    const start = Date.now()
    let correctionRequest: Promise<unknown> | undefined
    const observation = observeSessionRun({ sessionId, afterSeq, deadline: start + 900_000,
      subscribe: (listener) => runtime.store.subscribe(sessionId, listener),
      onEvent: (event) => {
        if (['tool.started', 'tool.completed', 'tool.failed', 'run.status', 'user.steering.received', 'user.steering.applied', 'task.verification.completed'].includes(event.type)) {
          console.log(JSON.stringify({ diagnostic: 'adaptive_event', case: name, seq: event.seq, type: event.type,
            tool: (event.data.call as { name?: string } | undefined)?.name, status: event.data.status, outcome: event.data.outcome }))
        }
        if (correction && event.type === 'file.changed' && event.data.path === correction.afterPath && !correctionRequest) {
          correctionRequest = request(`/api/sessions/${sessionId}/steering`, { content: correction.content, clientMessageId: `canary-${name}` })
          // Observation owns the eventual await; prevent an unhandled rejection before it settles.
          void correctionRequest.catch(() => undefined)
        }
      },
    })
    try {
      await request(`/api/sessions/${sessionId}/messages`, { content, model: options.model, timezone: 'Asia/Shanghai' })
      const outcome = await observation.result
      if (outcome.reason !== 'terminal' || outcome.status !== 'completed') {
        await runtime.agent.cancel(sessionId)
        throw new Error(`Run did not complete: ${JSON.stringify(outcome)}`)
      }
      if (correction) {
        if (!correctionRequest) throw new Error('The requested steering trigger was never observed')
        await correctionRequest
      }
      // Wait on this same run's cleanup only; do not restart a model request.
      for (let i = 0; runtime.agent.isRunning(sessionId) && i < 500; i++) await new Promise((done) => setTimeout(done, 10))
      if (runtime.agent.isRunning(sessionId)) throw new Error('Terminal run cleanup did not settle')
      const events = (await runtime.store.events(sessionId)).filter((event) => event.seq > afterSeq)
      return { sessionId, elapsedSeconds: (Date.now() - start) / 1000,
        toolCalls: events.filter((event) => event.type === 'tool.started').length,
        toolFailures: events.filter((event) => event.type === 'tool.failed').length,
        protocolRepairs: events.filter((event) => event.type === 'model.final.repair').length,
        final: events.filter((event) => event.type === 'assistant.final').at(-1)?.data.content,
        verification: events.filter((event) => event.type === 'task.verification.completed').at(-1)?.data,
        steering: events.filter((event) => event.type === 'user.steering.applied').map((event) => event.data),
      }
    } finally { observation.stop() }
  }
  async function record(name: string, work: () => Promise<Record<string, unknown>>) {
    try { results.push({ case: name, ...await work() }) }
    catch (error) { results.push({ case: name, passed: false, error: error instanceof Error ? error.message : String(error) }) }
    await persist()
    console.log(JSON.stringify({ diagnostic: 'adaptive_case', ...results.at(-1) }))
  }
  let dataSession = ''
  let dataVersion = ''
  let originalSummary = ''
  let originalNote = ''
  let restoredOtherFiles: ReadonlyArray<readonly [string, string]> = []
  const orders = [{ id: 'a', amount: 120, status: 'paid' }, { id: 'b', amount: 50, status: 'cancelled' },
    { id: 'c', amount: 80, status: 'paid' }, { id: 'd', amount: 20, status: 'refunded' }]
  const inputSource = JSON.stringify(orders, null, 2)
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  try {
    if (source) {
      await record('restore_continuation', async () => {
        const sessionId = source.sessionId
        const restored = await request(`/api/sessions/${sessionId}/workspace-versions/${source.versionId}/restore`, {})
        const workspace = runtime.store.workspaceDir(sessionId)
        const beforeNote = await readFile(join(workspace, 'summary.md'), 'utf8')
        const beforeOtherFiles = await publicFiles(workspace, 'summary.md')
        const result = await turn('restore_continuation', sessionId, '基于当前恢复后的文件继续：只在 summary.md 末尾增加一行“复核完成”，其他已有内容及文件保持不变，不重新生成统计。')
        const afterNote = await readFile(join(workspace, 'summary.md'), 'utf8')
        const afterOtherFiles = await publicFiles(workspace, 'summary.md')
        const onlyAppended = appendsReviewLine(beforeNote, afterNote)
        const exactOtherFiles = JSON.stringify(beforeOtherFiles) === JSON.stringify(afterOtherFiles)
        const sourceUnchanged = await sourceDigest() === sourceIdentity
        return { ...result, restored, onlyAppended, exactOtherFiles, beforeOtherFiles, afterOtherFiles, sourceUnchanged,
          passed: onlyAppended && exactOtherFiles && sourceUnchanged }
      })
    } else {
    await record('simple', async () => {
      const result = await turn('simple', await newSession(), '计算 17 × 23。只回复结果的整数。')
      return { ...result, passed: String(result.final).trim() === '391' && result.toolCalls === 0 }
    })
    await record('data', async () => {
      dataSession = await newSession()
      const workspace = runtime.store.workspaceDir(dataSession)
      await writeFile(join(workspace, 'orders.json'), inputSource)
      const result = await turn('data', dataSession, '读取 orders.json，仅统计 status 为 paid 的记录。生成 summary.json，内容只有 paidCount 和 paidTotal 两个数值字段；再生成 summary.md，简短说明统计口径和结果。保留输入文件。自行做与此任务相称的验证，完成后简短交付。要求已明确，直接执行。')
      const summary = JSON.parse(await readFile(join(workspace, 'summary.json'), 'utf8'))
      const note = await readFile(join(workspace, 'summary.md'), 'utf8')
      originalSummary = await readFile(join(workspace, 'summary.json'), 'utf8')
      originalNote = note
      const versions = await request(`/api/sessions/${dataSession}/workspace-versions`)
      dataVersion = versions.versions[0]?.id ?? ''
      return { ...result, summary, versionId: dataVersion,
        passed: summary.paidCount === 2 && summary.paidTotal === 200 && Object.keys(summary).length === 2
          && /200/u.test(note) && hash(await readFile(join(workspace, 'orders.json'), 'utf8')) === hash(inputSource)
          && Boolean(dataVersion) && result.verification?.source === 'agent' }
    })
    await record('steering', async () => {
      if (!dataSession || !dataVersion) throw new Error('Data baseline is unavailable')
      const result = await turn('steering', dataSession,
        '先创建 progress.txt，内容为 started。然后创建 result.txt，内容为 original。请按顺序执行两个写入，保留已有文件。',
        { afterPath: 'progress.txt', content: '调整最后的结果：result.txt 内容改为 revised，保留已完成的 progress.txt 和原有统计文件。无需重新做统计。' })
      const workspace = runtime.store.workspaceDir(dataSession)
      const resultText = await readFile(join(workspace, 'result.txt'), 'utf8')
      const progress = await readFile(join(workspace, 'progress.txt'), 'utf8')
      const statisticsPreserved = await readFile(join(workspace, 'summary.json'), 'utf8') === originalSummary
        && await readFile(join(workspace, 'summary.md'), 'utf8') === originalNote
        && await readFile(join(workspace, 'orders.json'), 'utf8') === inputSource
      return { ...result, resultText, statisticsPreserved,
        passed: resultText.trim() === 'revised' && progress.trim() === 'started' && result.steering.length === 1 && statisticsPreserved }
    })
    await record('restore', async () => {
      if (!dataVersion) throw new Error('Data baseline is unavailable')
      const diff = await request(`/api/sessions/${dataSession}/workspace-versions/${dataVersion}/diff`)
      const restored = await request(`/api/sessions/${dataSession}/workspace-versions/${dataVersion}/restore`, {})
      const workspace = runtime.store.workspaceDir(dataSession)
      const removed = await Promise.all(['progress.txt', 'result.txt'].map((path) => readFile(join(workspace, path)).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT')))
      const summary = JSON.parse(await readFile(join(workspace, 'summary.json'), 'utf8'))
      const exactRestore = await readFile(join(workspace, 'summary.json'), 'utf8') === originalSummary
        && await readFile(join(workspace, 'summary.md'), 'utf8') === originalNote
        && await readFile(join(workspace, 'orders.json'), 'utf8') === inputSource
      restoredOtherFiles = await publicFiles(workspace, 'summary.md')
      return { sessionId: dataSession, versionId: dataVersion, diff, restored,
        exactRestore, passed: diff.added === 2 && removed.every(Boolean) && exactRestore && summary.paidTotal === 200 && restored.workspaceReverted === true && restored.externalSideEffectsReverted === false }
    })
    await record('continue_restored', async () => {
      const result = await turn('continue_restored', dataSession, '基于当前恢复后的文件继续：只在 summary.md 末尾增加一行“复核完成”，其他已有内容及文件保持不变，不重新生成统计。')
      const workspace = runtime.store.workspaceDir(dataSession)
      const note = await readFile(join(workspace, 'summary.md'), 'utf8')
      const onlyAppended = appendsReviewLine(originalNote, note)
      const otherFilesPreserved = await readFile(join(workspace, 'summary.json'), 'utf8') === originalSummary
        && await readFile(join(workspace, 'orders.json'), 'utf8') === inputSource
      const exactOtherFiles = JSON.stringify(await publicFiles(workspace, 'summary.md')) === JSON.stringify(restoredOtherFiles)
      return { ...result, onlyAppended, otherFilesPreserved, exactOtherFiles, passed: onlyAppended && otherFilesPreserved && exactOtherFiles }
    })
    await record('interactive_web', async () => {
      const sessionId = await newSession()
      const result = await turn('interactive_web', sessionId,
        '创建一个独立的 index.html 计数页面，标题“专注计数”，初始数字为 0，按钮“增加”每次加 1，按钮“重置”归零。使用内联样式和脚本，适合桌面与窄屏，无外部依赖。请实际检查交互，保存并展示文件后简短交付。需求已明确，无需另行提案。')
      const browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true })
      try {
        const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
        const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(`${base}/workspace/${sessionId}/preview/index.html`)
        await page.getByRole('button', { name: '增加', exact: true }).click()
        await page.getByRole('button', { name: '增加', exact: true }).click()
        const incremented = await page.getByText('2', { exact: true }).first().isVisible()
        await page.getByRole('button', { name: '重置', exact: true }).click()
        const reset = await page.getByText('0', { exact: true }).first().isVisible()
        await page.screenshot({ path: join(options.dataRoot, 'web-desktop.png'), fullPage: true })
        await page.setViewportSize({ width: 390, height: 844 })
        await page.getByRole('button', { name: '增加', exact: true }).click()
        const narrowIncremented = await page.getByText('1', { exact: true }).first().isVisible()
        await page.getByRole('button', { name: '重置', exact: true }).click()
        const narrowReset = await page.getByText('0', { exact: true }).first().isVisible()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
        await page.screenshot({ path: join(options.dataRoot, 'web-narrow.png'), fullPage: true })
        return { ...result, incremented, reset, narrowIncremented, narrowReset, errors, overflow,
          passed: incremented && reset && narrowIncremented && narrowReset && !overflow && errors.length === 0 && result.verification?.source === 'agent' }
      } finally { await browser.close() }
    })
    }
  } finally {
    await runtime.agent.shutdown()
    server.closeAllConnections()
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
    await persist()
  }
  if (results.some((result) => result.passed !== true)) throw new Error('Adaptive canary has failed cases; consult adaptive-report.json and retained sessions.')
}
