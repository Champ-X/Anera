import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { CANARY_EVIDENCE_ROOT, createCanaryEvidenceDirectory } from './canary-evidence.js'

it('anchors paid evidence in the checkout, independently of cwd and temporary-directory policy', () => {
  expect(CANARY_EVIDENCE_ROOT).toBe(fileURLToPath(new URL('../../.anera/canary-runs/', import.meta.url)))
})

it('allocates distinct private directories without overwriting or cleaning earlier failed evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anera-evidence-test-'))
  try {
    const archive = join(root, 'persistent-runs')
    const first = await createCanaryEvidenceDirectory(archive)
    await writeFile(join(first, 'report.json'), '{"status":"failed"}')
    const second = await createCanaryEvidenceDirectory(archive)
    expect(first).not.toBe(second)
    expect(first.startsWith(archive + '/run-')).toBe(true)
    expect((await stat(first)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(first, 'report.json'), 'utf8')).toBe('{"status":"failed"}')
  } finally { await rm(root, { recursive: true, force: true }) }
})
