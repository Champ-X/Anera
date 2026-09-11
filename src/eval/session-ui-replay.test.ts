import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { cloneTerminalSessionForUi, sessionReplayManifest } from './session-ui-replay.js'

async function fixture(run: (root: string, source: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'anera-ui-replay-')))
  const source = resolve(root, 'source/sessions/ses_example')
  try {
    await mkdir(resolve(source, 'event-payloads/v1'), { recursive: true })
    await writeFile(resolve(source, 'state.json'), JSON.stringify({ summary: { id: 'ses_example', status: 'completed' } }))
    await writeFile(resolve(source, 'events.jsonl'), '{"seq":1}\n')
    await writeFile(resolve(source, 'event-payloads/v1/example'), 'durable evidence')
    await run(root, source)
  } finally { await rm(root, { recursive: true, force: true }) }
}

it('clones terminal history and CAS bytes independently, without overwriting destinations', () => fixture(async (root, source) => {
  const before = await sessionReplayManifest(source)
  const result = await cloneTerminalSessionForUi(source, resolve(root, 'copy'))
  expect(await sessionReplayManifest(result.destination)).toEqual(before)
  await writeFile(resolve(result.destination, 'events.jsonl'), 'copy-only')
  expect(await sessionReplayManifest(source)).toEqual(before)
  await expect(cloneTerminalSessionForUi(source, resolve(root, 'copy'))).rejects.toThrow()
  expect(await readFile(resolve(result.destination, 'events.jsonl'), 'utf8')).toBe('copy-only')
}))

it.each(['running', 'awaiting_input', 'idle'])('rejects nonterminal %s without allocating a destination', (status) => fixture(async (root, source) => {
  await writeFile(resolve(source, 'state.json'), JSON.stringify({ summary: { id: 'ses_example', status } }))
  await expect(cloneTerminalSessionForUi(source, resolve(root, 'copy'))).rejects.toThrow('terminal')
  await expect(readFile(resolve(root, 'copy/sessions/ses_example/state.json'))).rejects.toThrow()
}))

it('rejects wrong identity and symlinked evidence instead of following external data', () => fixture(async (root, source) => {
  await writeFile(resolve(source, 'state.json'), JSON.stringify({ summary: { id: 'ses_other', status: 'completed' } }))
  await expect(cloneTerminalSessionForUi(source, resolve(root, 'copy'))).rejects.toThrow('identity')
  await symlink(resolve(root, 'source'), resolve(source, 'external'))
  await expect(cloneTerminalSessionForUi(source, resolve(root, 'copy'))).rejects.toThrow('symlinks')
}))

it.each(['pendingApprovals', 'pendingHitl'])('rejects terminal sessions with %s recovery authority', (field) => fixture(async (root, source) => {
  await writeFile(resolve(source, 'state.json'), JSON.stringify({ summary: { id: 'ses_example', status: 'completed' },
    [field]: { recover: { phase: 'executing' } } }))
  await expect(cloneTerminalSessionForUi(source, resolve(root, 'copy'))).rejects.toThrow('pending interactions')
}))
