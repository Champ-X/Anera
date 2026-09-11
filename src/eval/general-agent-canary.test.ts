import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GENERAL_CASES, pdfBriefIssues } from './general-agent-canary.js'

describe('concentrated general canary oracles (no provider calls)', () => {
  const pages = [
    'Release Readiness\nData migration Mina Ready\nAccess controls Jules In review\nSupport training Noor Pending\nPage 1 of 2',
    'Open Decisions\nConfirm the rollback owner before launch.\nApprove the support handover checklist.\nPage 2 of 2',
  ]
  it('requires both pages and all exact supplied facts on the correct page', () => {
    expect(pdfBriefIssues(pages)).toEqual([])
    expect(pdfBriefIssues(pages.slice(0, 1)).length).toBeGreaterThan(0)
    expect(pdfBriefIssues([...pages].reverse()).length).toBeGreaterThan(0)
    expect(pdfBriefIssues([pages[0].replace('Jules', 'Wrong owner'), pages[1]])).toContain('Page 1 missing "Jules"')
  })
  it('keeps two bounded independent cases instead of expanding a live benchmark', () => {
    expect(GENERAL_CASES.map((item) => item.id)).toEqual(['code', 'document'])
  })
  it('uses the existing catalog-checked metered routes and no standalone credential or ledger entry', () => {
    const entry = readFileSync(new URL('../../scripts/arena-reference-recovery-canary.ts', import.meta.url), 'utf8')
    const helper = readFileSync(new URL('./general-agent-canary.ts', import.meta.url), 'utf8')
    const branch = entry.indexOf("process.env.ANERA_ARENA_CANARY_MODE === 'general'")
    expect(branch).toBeGreaterThan(entry.indexOf('fetch: providerFetch'))
    expect(branch).toBeGreaterThan(entry.indexOf('const vision = new DeepSeekVisionClient'))
    expect(branch).toBeLessThan(entry.indexOf('await createApp('))
    expect(entry).toContain('runGeneralAgentCanary({ client, vision, model: canaryModel, budget, dataRoot: evidenceRoot })')
    expect(helper).not.toContain('tmpdir()')
    expect(helper).not.toContain('new DeepSeekClient')
    expect(helper).not.toContain('new ModelTestBudget')
    expect(helper).not.toContain('process.env')
    expect(helper).toContain('allowNetwork: false')
    expect(helper).toContain('const runObservation = await observation.result')
  })
})
