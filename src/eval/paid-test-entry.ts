import { fileURLToPath } from 'node:url'
import { inspectModelTestBudget, ModelTestBudget } from './model-test-budget.js'

// This is one authorization, not a daily/entry-specific allowance. Anchor it to
// this checkout, never cwd, an environment variable, a session, or a CLI path.
export const AUTHORIZED_MODEL_TEST_LEDGER = fileURLToPath(new URL('../../.anera/model-test-budget-20260909.jsonl', import.meta.url))

export function paidTestMode(args: readonly string[]): 'preflight' | 'live' {
  if (args.some((arg) => arg !== '--live' && arg !== '--preflight-only')) {
    throw new Error('Expected --live or --preflight-only; ledger/budget overrides are forbidden')
  }
  if (new Set(args).size !== args.length || (args.includes('--live') && args.includes('--preflight-only'))) {
    throw new Error('Choose one test mode: --live or --preflight-only')
  }
  return args.includes('--live') ? 'live' : 'preflight'
}

export function inspectAuthorizedModelTestBudget() {
  return inspectModelTestBudget(AUTHORIZED_MODEL_TEST_LEDGER)
}

/** Explicit intent alone cannot create a new authorization or unmetered route. */
export function openAuthorizedModelTestBudget(args: readonly string[]) {
  if (paidTestMode(args) !== 'live') throw new Error('Paid tests require explicit --live; default preflight is local-only')
  // Missing or damaged authorization must not silently become a fresh ¥20.
  inspectAuthorizedModelTestBudget()
  return new ModelTestBudget(AUTHORIZED_MODEL_TEST_LEDGER)
}
