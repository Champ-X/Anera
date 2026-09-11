import { describe, expect, it } from 'vitest'
import { parseChangedTestArguments, requiresFullTestSelection, splitChangedTestPlan } from './test-tiers.js'

describe('resource-tier test selection', () => {
  it('uses transitive imports for source modules but conservatively reruns file-read and configuration inputs', () => {
    expect(requiresFullTestSelection(['src/server/research-brief.ts', 'src/client/App.test.tsx'])).toBe(false)
    for (const path of ['src/client/styles.css', 'src/server/fixtures/template.ts',
      'src/server/test-support/cache.ts', 'src/server/fixtures/example.html', 'package-lock.json',
      'vitest.config.ts', 'scripts/smoke.mjs', 'ARENA_MANUAL_PROBE_RUNBOOK.md',
      'src/client/__snapshots__/App.test.tsx.snap']) {
      expect(requiresFullTestSelection([path]), path).toBe(true)
    }
  })

  it('records browser deferrals without dropping module or cross-module integration tests', () => {
    const specs = ['module', 'integration', 'browser'].map((name) => ({ project: { name }, moduleId: `${name}.test.ts` }))
    expect(splitChangedTestPlan(specs, false)).toEqual({ selected: specs.slice(0, 2), deferred: specs.slice(2) })
    expect(splitChangedTestPlan(specs, true)).toEqual({ selected: specs, deferred: [] })
    expect(specs).toHaveLength(3)
  })

  it('makes expanded verification explicit, and rejects unknown or ambiguous command-line options', () => {
    expect(parseChangedTestArguments([])).toEqual({ includeBrowser: false, planOnly: false, base: undefined })
    expect(parseChangedTestArguments(['--base', 'origin/main', '--plan', '--include-browser']))
      .toEqual({ includeBrowser: true, planOnly: true, base: 'origin/main' })
    for (const args of [['--base'], ['--base', '--plan'], ['--typo'], ['--plan', '--plan'], ['stray'],
      ['--base', 'HEAD', '--base', 'main'], ['--live']]) {
      expect(() => parseChangedTestArguments(args), args.join(' ')).toThrow()
    }
  })
})
