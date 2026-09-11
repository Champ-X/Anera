import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AUTHORIZED_MODEL_TEST_LEDGER, openAuthorizedModelTestBudget, paidTestMode } from './paid-test-entry.js'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const disabledEntrypoints = [
  "scripts/active-harness-smoke.mjs",
  "scripts/approval-deny-smoke.mjs",
  "scripts/attachment-only-smoke.mjs",
  "scripts/attachment-pagination-smoke.mjs",
  "scripts/bash-failure-recovery-smoke.mjs",
  "scripts/browser-form-smoke.mjs",
  "scripts/browser-task-smoke.mjs",
  "scripts/cancel-smoke.mjs",
  "scripts/compaction-smoke.mjs",
  "scripts/connector-tool-load-smoke.mjs",
  "scripts/crash-tool-recovery-smoke.mjs",
  "scripts/deploy-smoke.mjs",
  "scripts/file-tools-smoke.mjs",
  "scripts/github-agent-connector-smoke.mjs",
  "scripts/harness-convergence-smoke.mjs",
  "scripts/harness-quality-benchmark.mjs",
  "scripts/html-slides-task-smoke.mjs",
  "scripts/length-continuation-smoke.mjs",
  "scripts/multiturn-tool-routing-smoke.mjs",
  "scripts/office-attachment-smoke.mjs",
  "scripts/office-present-file-smoke.mjs",
  "scripts/package-install-smoke.mjs",
  "scripts/plan-smoke.mjs",
  "scripts/process-website-smoke.mjs",
  "scripts/read-file-pagination-smoke.mjs",
  "scripts/request-dispatch-crash-smoke.mjs",
  "scripts/research-smoke.mjs",
  "scripts/resume-smoke.mjs",
  "scripts/search-tools-smoke.mjs",
  "scripts/secret-redaction-smoke.mjs",
  "scripts/session-token-limit-smoke.mjs",
  "scripts/shell-protocol-smoke.mjs",
  "scripts/terminal-crash-smoke.mjs",
  "scripts/token-pressure-checkpoint-smoke.mjs",
  "scripts/vision-task-smoke.mjs",
  "scripts/vision-probe.mjs",
  "scripts/website-idle-sleep-smoke.mjs",
  "scripts/web-provider-cache-canary.ts",
  "scripts/checkpoint-boundary-canary.ts",
  "scripts/checkpoint-mode-replay-canary.ts",
  "scripts/compaction-protocol-smoke.ts",
  "scripts/custom-feedback-protocol-smoke.ts",
  "scripts/image-tool-result-protocol-smoke.ts",
  "scripts/tool-result-cache-benchmark.ts",
  "scripts/visual-final-replay-canary.ts",
  "scripts/visual-final-review-probe.ts"
] as const

describe('paid test entry safety (zero provider calls)', () => {
  it('defaults to local-only inspection and accepts only an explicit live flag', () => {
    expect(paidTestMode([])).toBe('preflight')
    expect(paidTestMode(['--preflight-only'])).toBe('preflight')
    expect(paidTestMode(['--live'])).toBe('live')
    expect(() => openAuthorizedModelTestBudget([])).toThrow('explicit --live')
  })

  it.each([
    ['--live=true'], ['--live', '--live'], ['--live', '--preflight-only'],
    ['--ledger', '/tmp/new-allowance.jsonl'], ['--budget=20'], ['--paid'],
  ].map((args) => ({ args })))('rejects ambiguous intent and allowance overrides: $args', ({ args }) => {
    expect(() => paidTestMode(args)).toThrow()
  })

  it('anchors the single authorization to the checkout, not cwd or environment', () => {
    expect(AUTHORIZED_MODEL_TEST_LEDGER).toBe(fileURLToPath(new URL('../../.anera/model-test-budget-20260909.jsonl', import.meta.url)))
  })

  it.each(disabledEntrypoints)('guards %s before production imports or side effects', (path) => {
    expect(readFileSync(new URL('../../' + path, import.meta.url), 'utf8').split('\n')[0])
      .toBe("import './legacy-live-test-disabled.mjs'")
  })

  it.each([[], ['--live']].map((args) => ({ args })))('legacy guard cannot opt in even with inherited credentials: $args', ({ args }) => {
    expect(() => execFileSync(process.execPath, ['scripts/legacy-live-test-disabled.mjs', ...args], {
      cwd: projectRoot, stdio: 'pipe',
      env: { ...process.env, ANERA_ALLOW_PAID_TESTS: 'true', DEEPSEEK_API_KEY: 'synthetic-opt-in-test' },
    })).toThrow('Unbudgeted live test disabled')
  })

  it('keeps media reconciliation before the new-generation guard', () => {
    const source = readFileSync(new URL('../../scripts/media-provider-canary.mjs', import.meta.url), 'utf8')
    expect(source.indexOf("process.argv[2] === '--reconcile'")).toBeLessThan(source.indexOf("await import('./legacy-live-test-disabled.mjs')"))
    expect(source.indexOf("await import('./legacy-live-test-disabled.mjs')")).toBeLessThan(source.indexOf('const dataRoot = await mkdtemp'))
  })

  it('keeps default budgeted preflight before networking or ledger construction', () => {
    const source = readFileSync(new URL('../../scripts/arena-reference-recovery-canary.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('new ModelTestBudget(')
    expect(source.indexOf("paidTestMode(process.argv.slice(2)) === 'preflight'")).toBeLessThan(source.indexOf('const budget = openAuthorizedModelTestBudget'))
    expect(source.indexOf('process.exit(0)')).toBeLessThan(source.indexOf('await createCanaryEvidenceDirectory()'))
    expect(source.indexOf('await createCanaryEvidenceDirectory()')).toBeLessThan(source.indexOf('await runCanary(evidenceRoot)'))
    expect(source).toContain("'run-metadata.json'")
    expect(source).toContain("'model-catalog.json'")
    expect(source).not.toContain('tmpdir()')
    expect(source).not.toContain('researchPosts')
  })

  it('keeps the read-only review probe behind the same metered client and before App startup', () => {
    const source = readFileSync(new URL('../../scripts/arena-reference-recovery-canary.ts', import.meta.url), 'utf8')
    const branch = source.indexOf("process.env.ANERA_ARENA_CANARY_MODE === 'review'")
    expect(branch).toBeGreaterThan(source.indexOf('fetch: providerFetch'))
    expect(branch).toBeLessThan(source.indexOf('await createApp('))
    expect(source).toContain('maxModelRequests: maxPhysicalRequestsPerReview')
    expect(source).toContain('maxPhysicalRequestsPerReview = 5 + config.maxLengthContinuations')
    expect(source).toContain('attempts.length >= maxLogicalReviews')
    expect(source).toContain("maxLogicalReviews = target === 'handoff' ? 3 : 2")
    expect(source).toContain('acceptanceVerified: false')
    expect(source).toContain('sourceUnchanged: unchanged')
    expect(source).toContain("!['artifact', 'handoff'].includes(target)")
    expect(source).toContain("artifactOnly: target === 'artifact'")
    expect(source).toContain('Handoff diagnostic requires a saved final draft')
    expect(source).toContain('no publication or workflow acceptance')
  })

  it('restricts the catalog-disagreement diagnostic to documented routes and the original metered fetch', () => {
    const source = readFileSync(new URL('../../scripts/arena-reference-recovery-canary.ts', import.meta.url), 'utf8')
    const branch = source.indexOf("process.env.ANERA_ARENA_CANARY_MODE === 'capability'")
    expect(branch).toBeGreaterThan(source.indexOf("'model-catalog.json'"))
    expect(source).toContain('probeDocumentedProvider({ fetch: budget.wrapFetch(fetchPublicUrl)')
    const thinkingGuard = source.indexOf("if (config.modelThinking === undefined) throw new Error('Capability diagnostic requires an explicit thinking configuration')")
    expect(thinkingGuard).toBeGreaterThan(branch)
    expect(thinkingGuard).toBeLessThan(source.indexOf('await probeDocumentedProvider('))
    expect(branch).toBeLessThan(source.indexOf('const client = new DeepSeekClient'))
    expect(source).toContain("budget.stop(`authorized model unavailable: ${model}`)")
  })

  it('keeps tool capability rejection separate from the model budget halt', () => {
    const source = readFileSync(new URL('../../scripts/arena-reference-recovery-canary.ts', import.meta.url), 'utf8')
    expect(source).toContain('publicReadTransport({ publicFetch: fetchPublicUrl, localFetch: fetch, localBaseUrl: () => base })')
    expect(source).not.toContain("budget.stop('unpriced paid tool route")
  })
})
