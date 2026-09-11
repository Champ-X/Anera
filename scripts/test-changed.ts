import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVitest } from 'vitest/node'
import { parseChangedTestArguments, requiresFullTestSelection, splitChangedTestPlan } from '../src/eval/test-tiers.js'

// Use Vitest's own transitive import graph. No hand-maintained source→test
// mapping, stale success cache, test execution during discovery, or retries.
const { includeBrowser, planOnly, base } = parseChangedTestArguments(process.argv.slice(2))
const root = fileURLToPath(new URL('../', import.meta.url))
const gitPaths = (gitArgs: string[]) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean)
const changed = [...new Set([
  ...gitPaths(['diff', '--name-only', '-z', '--']),
  ...gitPaths(['diff', '--cached', '--name-only', '-z', '--']),
  ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z']),
  ...(base ? gitPaths(['diff', '--name-only', '-z', `${base}...HEAD`, '--']) : []),
])]
if (!changed.length) {
  console.log('No changed files. No tests executed (not a new full-suite pass).')
} else {
  // Deleted imports and non-module inputs cannot safely use the current graph.
  let full = requiresFullTestSelection(changed) || changed.some((path) => !existsSync(resolve(root, path)))
  const vitest = await createVitest('test', {
    root, watch: false, ...(full ? {} : { related: changed.map((path) => resolve(root, path)) }),
  })
  let specs
  try {
    specs = await vitest.getRelevantTestSpecifications()
    // An unrecognized/dynamic dependency never turns a source edit into a
    // successful zero-test run. Fall back to every discovered test.
    if (!specs.length) {
      specs = await vitest.globTestSpecifications()
      full = true
    }
  } finally {
    await vitest.close()
  }
  const plan = splitChangedTestPlan(specs, includeBrowser)
  console.log(JSON.stringify({ selection: full ? 'conservative-full' : 'transitive-imports',
    changedFiles: changed.length, selectedFiles: plan.selected.length,
    deferredBrowserFiles: plan.deferred.map((spec) => relative(root, spec.moduleId)),
    ...(planOnly ? { files: plan.selected.map((spec) => relative(root, spec.moduleId)) } : {}),
    note: 'No paid models. Deferred browser tests are not verified; run test:browser or --include-browser at the acceptance boundary.',
  }, null, 2))
  if (!planOnly && plan.selected.length) {
    const files = [...new Set(plan.selected.map((spec) => spec.moduleId))]
    const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files], {
      cwd: root, stdio: 'inherit', env: process.env,
    })
    const forward = (signal: NodeJS.Signals) => child.kill(signal)
    const interrupt = () => forward('SIGINT')
    const terminate = () => forward('SIGTERM')
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    try {
      process.exitCode = await new Promise<number>((done, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => done(code ?? (signal === 'SIGINT' ? 130 : 1)))
      })
    } finally {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
    }
  }
}
