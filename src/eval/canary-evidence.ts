import { mkdir, mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** Validation runs must survive OS temporary-directory cleanup. Keep their exact
 * sessions, artifacts, reports and failed preflight evidence together. This
 * is storage only: never creates a new budget, resumes a run or admits calls. */
export const CANARY_EVIDENCE_ROOT = fileURLToPath(new URL('../../.anera/canary-runs/', import.meta.url))

export async function createCanaryEvidenceDirectory(root = CANARY_EVIDENCE_ROOT): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  return mkdtemp(resolve(root, 'run-'))
}
