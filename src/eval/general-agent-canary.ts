import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentService } from '../server/agent-service.js'
import { extractAttachmentPage } from '../server/attachment-extractor.js'
import type { DeepSeekClient } from '../server/deepseek.js'
import { attachmentCoverageAssessment, attachmentEvidenceStatus } from '../server/file-evidence.js'
import { runCommand } from '../server/process-manager.js'
import { SessionStore } from '../server/session-store.js'
import type { DeepSeekVisionClient } from '../server/vision.js'
import type { ModelTestBudget } from './model-test-budget.js'
import { observeSessionRun } from './session-run-observer.js'
import { preservesProgramStatements } from './program-preservation.js'

const PUBLIC_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTags } from './tag-normalizer.mjs';
test('basic tags', () => assert.deepEqual(normalizeTags([' A ', 'b']), ['a', 'b']));
`
export const TAG_ORACLE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTags } from './tag-normalizer.mjs';
test('order, normalization, duplicates and immutability', () => {
  const input = Object.freeze([' B ', 'A', 'b', '  ', 'E\u0301', 'é']);
  assert.deepEqual(normalizeTags(input), ['b', 'a', 'é']);
  assert.deepEqual(input, [' B ', 'A', 'b', '  ', 'E\u0301', 'é']);
  assert.deepEqual(normalizeTags([]), []);
});
test('invalid inputs are rejected without coercion', () => {
  for (const value of [null, undefined, 'tag', 4, {}, ['ok', 1], ['ok', null]]) {
    assert.throws(() => normalizeTags(value), TypeError);
  }
});
`

export const GENERAL_CASES = [
  { id: 'code', prompt: '请修复工作区 tag-normalizer.mjs 中的 normalizeTags。输入必须是字符串数组，否则抛出 TypeError（不得把非字符串转换成字符串）。逐项去除首尾空白、转换小写并做 NFC 规范化；跳过空结果，按首次出现顺序去重，不修改输入，空数组返回空数组。保留 tag-normalizer.test.mjs 原有文件，可另加必要的边界测试。运行测试后简短说明结果。无需安装依赖。',
    files: { 'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
      'tag-normalizer.mjs': 'export function normalizeTags(values) { return values.sort().map(value => value.trim().toLowerCase()).filter(Boolean); }\n',
      'tag-normalizer.test.mjs': PUBLIC_TEST } },
  { id: 'document', prompt: 'Use brief-data.json to create and present release-brief.pdf, a readable two-page PDF with selectable text. Page 1 title must be "Release Readiness" and show all workstreams with their exact owners and states. Page 2 title must be "Open Decisions" and include both supplied decision statements verbatim. Put "Page 1 of 2" and "Page 2 of 2" on the respective pages. Do not invent dates, quantities, decisions, or owners. Use sensible margins and typography. Verify the generated file, then provide a short handoff. You may install an appropriate npm PDF library.',
    files: { 'brief-data.json': JSON.stringify({ workstreams: [
      { name: 'Data migration', owner: 'Mina', state: 'Ready' },
      { name: 'Access controls', owner: 'Jules', state: 'In review' },
      { name: 'Support training', owner: 'Noor', state: 'Pending' },
    ], decisions: ['Confirm the rollback owner before launch.', 'Approve the support handover checklist.'] }, null, 2) } },
] as const

export function pdfBriefIssues(pages: readonly string[]): string[] {
  const issues: string[] = []
  if (pages.length !== 2) issues.push(`Expected two pages, received ${pages.length}`)
  const required = [
    ['Release Readiness', 'Data migration', 'Mina', 'Ready', 'Access controls', 'Jules', 'In review', 'Support training', 'Noor', 'Pending', 'Page 1 of 2'],
    ['Open Decisions', 'Confirm the rollback owner before launch.', 'Approve the support handover checklist.', 'Page 2 of 2'],
  ]
  for (const [index, strings] of required.entries()) {
    const text = (pages[index] ?? '').replace(/\s+/gu, ' ')
    for (const value of strings) if (!text.includes(value)) issues.push(`Page ${index + 1} missing ${JSON.stringify(value)}`)
  }
  return issues
}

/** Called only by the existing --live entry after catalog validation. There
 * are no credentials, new ledgers, provider defaults or startup side effects.
 * Two independent runs share the injected production-configured metered routes.
 */
export async function runGeneralAgentCanary(options: {
  client: DeepSeekClient; vision: DeepSeekVisionClient; model: string; budget: ModelTestBudget; dataRoot: string
}): Promise<void> {
  const dataRoot = options.dataRoot
  const store = new SessionStore(dataRoot, options.model)
  await store.initialize()
  const initialBudget = options.budget.snapshot()
  const results: Record<string, unknown>[] = []
  console.log(JSON.stringify({ diagnostic: 'general_canary_started', dataRoot, model: options.model, cases: GENERAL_CASES.map((item) => item.id) }))
  const report = async () => writeFile(join(dataRoot, 'report.json'), JSON.stringify({
    mode: 'general', model: options.model, initialBudget, budget: options.budget.snapshot(), results,
    // Raster inspection is an explicit separate result, never inferred from text.
    visualAcceptance: 'pending independent rendered inspection',
  }, null, 2))
  for (const fixture of GENERAL_CASES) {
    if (options.budget.snapshot().stopped) break
    const session = await store.create()
    const sessionId = session.summary.id
    const workspace = store.workspaceDir(sessionId)
    for (const [name, content] of Object.entries(fixture.files)) await writeFile(join(workspace, name), content!)
    const initialSeq = (await store.events(sessionId)).at(-1)?.seq ?? 0
    const beforeBudget = options.budget.snapshot()
    const agent = new AgentService(store, {
      client: options.client, vision: options.vision, models: [options.model],
      toolExecutorDependencies: { fetch: async () => { throw new Error('Unpriced external tool-provider route is unavailable in this local-artifact canary') } },
      modelTransportObserver: (event) => console.log(JSON.stringify({ diagnostic: 'general_model_transport', case: fixture.id, ...event })),
    })
    const started = Date.now()
    const observation = observeSessionRun({ sessionId, afterSeq: initialSeq, deadline: started + 900_000,
      subscribe: (listener) => store.subscribe(sessionId, listener),
      onEvent: (event) => {
        if (['tool.started', 'tool.completed', 'tool.failed', 'model.tool_call.repair', 'run.status'].includes(event.type)) {
          const call = event.data.call as { name?: string } | undefined
          console.log(JSON.stringify({ diagnostic: 'general_event', case: fixture.id, seq: event.seq, type: event.type,
            tool: call?.name, status: event.data.status, reason: event.data.reason,
            ...(event.type === 'tool.failed' ? { result: String(event.data.result).slice(0, 1200) } : {}) }))
        }
        if (options.budget.snapshot().stopped) observation.stop()
      },
    })
    const result: Record<string, unknown> = { case: fixture.id, sessionId, workspace, beforeBudget }
    try {
      await agent.submit(sessionId, { content: fixture.prompt, model: options.model, timezone: 'Asia/Shanghai' })
      const runObservation = await observation.result
      if (runObservation.reason !== 'terminal') await agent.cancel(sessionId)
      await agent.shutdown()
      const state = await store.get(sessionId)
      const events = (await store.events(sessionId)).filter((event) => event.seq > initialSeq)
      Object.assign(result, { status: state.summary.status, runObservation, elapsedSeconds: (Date.now() - started) / 1000,
        final: [...events].reverse().find((event) => event.type === 'assistant.final')?.data,
        errors: events.filter((event) => event.type === 'error').map((event) => event.data),
        calls: events.filter((event) => event.type === 'tool.started').length })
      if (fixture.id === 'code') {
        const currentPublicTest = await readFile(join(workspace, 'tag-normalizer.test.mjs'), 'utf8')
        const publicTestUnchanged = currentPublicTest === PUBLIC_TEST
        const publicTestPreserved = preservesProgramStatements(PUBLIC_TEST, currentPublicTest)
        await writeFile(join(workspace, 'acceptance-oracle.test.mjs'), TAG_ORACLE)
        const oracle = await runCommand({ workspace, command: 'node --test tag-normalizer.test.mjs acceptance-oracle.test.mjs', timeoutMs: 20_000,
          maxOutputBytes: 20_000, signal: AbortSignal.timeout(25_000), onOutput: () => {}, allowNetwork: false })
        Object.assign(result, { publicTestUnchanged, publicTestPreserved, oracle, mechanicalAcceptance: state.summary.status === 'completed' && publicTestPreserved && oracle.exitCode === 0 })
      } else {
        const path = join(workspace, 'release-brief.pdf')
        const bytes = await readFile(path)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const all = await extractAttachmentPage(path, 120_000)
        const pages: string[] = []
        for (let index = 1; index <= (all.totalItems ?? 0); index += 1) pages.push((await extractAttachmentPage(path, 120_000, { pageStart: index, pageEnd: index })).content)
        const issues = pdfBriefIssues(pages)
        const evidence = attachmentEvidenceStatus(events, 'release-brief.pdf', sha256, bytes.length)
        const coverage = attachmentCoverageAssessment(events, 'release-brief.pdf', sha256)
        const presented = events.some((event) => event.type === 'file.presented' && event.data.path === 'release-brief.pdf'
          && event.data.artifactHash === createHash('sha256').update(bytes).digest('base64url'))
        Object.assign(result, { artifact: { path, sha256, bytes: bytes.length }, pages, issues, evidence, coverage: coverage.coverage, presented,
          mechanicalAcceptance: state.summary.status === 'completed' && issues.length === 0 && evidence.status === 'current' && coverage.coverage.status === 'complete' && presented })
      }
    } catch (error) {
      Object.assign(result, { mechanicalAcceptance: false, harnessError: error instanceof Error ? error.message : String(error) })
    } finally {
      observation.close()
      await agent.shutdown()
      result.afterBudget = options.budget.snapshot()
      results.push(result)
      await report()
      console.log(JSON.stringify({ diagnostic: 'general_case_completed', ...result }))
    }
  }
  if (results.length !== GENERAL_CASES.length || results.some((result) => result.mechanicalAcceptance !== true)) {
    throw new Error(`General canary did not pass every mechanical check; retained report at ${join(dataRoot, 'report.json')}`)
  }
  console.log(JSON.stringify({ diagnostic: 'general_canary_mechanically_passed', dataRoot, visualAcceptance: 'not yet inspected' }))
}
