import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'

/** Snapshot all regular files, including CAS payloads. Never follow workspace
 * symlinks or share mutable state with the source. This is UI replay, not Resume. */
export async function sessionReplayManifest(directory: string): Promise<Record<string, string>> {
  const manifest: Record<string, string> = {}
  async function visit(path: string): Promise<void> {
    const info = await lstat(path)
    assert(!info.isSymbolicLink(), 'UI replay does not accept symlinks')
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(resolve(path, name))
    } else {
      assert(info.isFile(), 'UI replay accepts regular files only')
      manifest[relative(directory, path)] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }
  await visit(directory)
  return manifest
}

export async function cloneTerminalSessionForUi(source: string, dataRoot: string) {
  const directory = resolve(source)
  assert.equal(await realpath(directory), directory, 'UI replay source must be a canonical path')
  assert.equal(basename(dirname(directory)), 'sessions')
  const id = basename(directory)
  assert.match(id, /^ses_[a-zA-Z0-9]+$/u)
  const manifest = await sessionReplayManifest(directory)
  const state = JSON.parse(await readFile(resolve(directory, 'state.json'), 'utf8'))
  assert.equal(state.summary?.id, id, 'UI replay session identity mismatch')
  assert(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(state.summary?.status), 'UI replay requires a terminal session')
  assert(Object.keys(state.pendingApprovals ?? {}).length === 0 && Object.keys(state.pendingHitl ?? {}).length === 0,
    'UI replay rejects pending interactions that could recover execution during initialization')
  assert(manifest['events.jsonl'], 'UI replay requires its durable event journal')
  const destination = resolve(dataRoot, 'sessions', id)
  assert(!destination.startsWith(directory + '/') && destination !== directory, 'UI replay must not write into its source')
  await mkdir(resolve(dataRoot, 'sessions'), { recursive: true })
  // Reserve the destination exclusively; never merge with an existing session.
  await mkdir(destination)
  for (const name of await readdir(directory)) {
    await cp(resolve(directory, name), resolve(destination, name), { recursive: true, force: false, errorOnExist: true })
  }
  assert.deepEqual(await sessionReplayManifest(destination), manifest, 'UI replay copy changed source bytes')
  assert.deepEqual(await sessionReplayManifest(directory), manifest, 'UI replay source changed during copy')
  return { id, directory, destination, manifest }
}
