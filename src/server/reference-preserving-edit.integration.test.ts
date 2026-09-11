import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from './session-store.js'
import { ToolExecutor } from './tools.js'
import type { ProcessManager } from './process-manager.js'
import type { BrowserManager } from './browser-manager.js'
import { referenceFixture, source, fixtureHash } from './test-support/reference-preserving-edit-fixture.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-reference-preserving-edit-'))
  roots.push(root)
  const store = new SessionStore(root, 'offline-fixture')
  await store.initialize()
  const sessionId = (await store.create()).summary.id
  const forbidden = new Proxy({}, { get: () => { throw new Error('No Browser/Process work in edit preflight') } })
  const fetch = vi.fn(async () => { throw new Error('No network in edit preflight') })
  const tools = new ToolExecutor(store, forbidden as ProcessManager, forbidden as BrowserManager,
    { inspect: vi.fn(async () => { throw new Error('No Vision in edit preflight') }) }, async () => false, { fetch })
  let sequence = 0
  const execute = (name: string, args: Record<string, unknown>) => tools.execute({ id: `edit-${++sequence}`, name, arguments: args },
    { sessionId, turnId: 'turn_fixture', stepId: 'step_fixture', signal: new AbortController().signal })
  const initial = await execute('write_file', { path: 'deck.html', content: source })
  expect(initial.isError, initial.content).toBe(false)
  const fontEvidence = await store.commitReferenceFontEvidence(sessionId, { sourceEvidenceSha256: fixtureHash(source),
    fontCss: '', familyNames: [], materializationManifest: null })
  const reference = { ...referenceFixture(), fontEvidence }
  await store.update(sessionId, (state) => {
    state.activeReferenceStyleContract = reference
    state.activeVisualArtifact = { schemaVersion: 1, path: 'deck.html', canonicalWriteCallId: 'fixture-write',
      canonicalWriteEventSeq: 1, lastMutationCallId: 'fixture-write', lastMutationEventSeq: 1,
      currentHash: createHash('sha256').update(source).digest('base64url') }
  })
  const pass = await execute('verify_reference_style', { path: 'deck.html' })
  expect(pass.isError, pass.content).toBe(false)
  expect(JSON.parse(pass.content)).toMatchObject({ fidelity: 'pass', score: 100 })
  const target = resolve(store.workspaceDir(sessionId), 'deck.html')
  return { store, sessionId, target, execute, fetch, reference }
}

describe('canonical reference-preserving mutation admission', () => {
  it.each(['edit_file', 'write_file'] as const)('rejects %s regressions without changing file, ledger, artifacts or verification state', async (name) => {
    const f = await fixture()
    const statePath = resolve(f.store.sessionDir(f.sessionId), 'state.json')
    const eventsPath = resolve(f.store.sessionDir(f.sessionId), 'events.jsonl')
    const paths = [statePath, eventsPath, f.target]
    const before = await Promise.all(paths.map((path) => readFile(path)))
    const commit = vi.spyOn(f.store, 'commitWorkspaceWrite')
    const result = await f.execute(name, name === 'edit_file'
      ? { path: '/home/user/deck.html', old_text: 'font-size:96px', new_text: 'font-size:72px' }
      : { path: 'deck.html', content: source.replace('font-size:96px', 'font-size:72px') })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content)).toMatchObject({ status: 'error', message: expect.stringContaining('rejected before commit') })
    expect(result.content).toContain('font-size')
    expect(commit).not.toHaveBeenCalled()
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('allows a coherent raw batch and content changes while retaining the reference CAS constraint', async () => {
    const f = await fixture()
    const commit = vi.spyOn(f.store, 'commitWorkspaceWrite')
    const result = await f.execute('edit_file', { path: 'deck.html', edits: [
      { old_text: 'font-size:96px', new_text: 'font-size:72px' },
      { old_text: 'font-size:72px', new_text: 'font-size:96px' },
      { old_text: 'Verified content', new_text: 'Revised content' },
    ] })
    expect(result.isError, result.content).toBe(false)
    expect(await readFile(f.target, 'utf8')).toBe(source.replace('Verified content', 'Revised content'))
    expect(commit).toHaveBeenCalledOnce()
    expect(commit.mock.calls[0][1].expectedReferenceStyleSha256).toBe(fixtureHash(JSON.stringify(f.reference)))
    expect(JSON.parse(result.content)).not.toHaveProperty('fidelity')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it.each(['reference', 'file'] as const)('rejects a changed %s between preflight and transaction admission', async (changed) => {
    const f = await fixture()
    const commit = f.store.commitWorkspaceWrite.bind(f.store)
    const eventsBefore = await f.store.events(f.sessionId)
    vi.spyOn(f.store, 'commitWorkspaceWrite').mockImplementationOnce(async (id, options) => {
      if (changed === 'reference') await f.store.update(id, (state) => {
        state.activeReferenceStyleContract!.contract.signature = 'A newer user-approved contract'
      })
      else await writeFile(f.target, source.replace('Verified content', 'External concurrent edit'))
      return commit(id, options)
    })
    const result = await f.execute('edit_file', { path: 'deck.html', old_text: 'Verified content', new_text: 'Model proposal' })
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(changed === 'reference' ? /Reference identity changed/u : /File changed before edit/u)
    expect(await readFile(f.target, 'utf8')).toBe(changed === 'reference' ? source : source.replace('Verified content', 'External concurrent edit'))
    expect((await f.store.events(f.sessionId)).slice(eventsBefore.length).some((event) => event.type === 'file.changed')).toBe(false)
    expect(Object.keys((await f.store.get(f.sessionId)).pendingWorkspaceMutations ?? {})).toEqual([])
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('permits repairs to an already-invalid draft and still requires an explicit new verifier receipt', async () => {
    const f = await fixture()
    await writeFile(f.target, source.replace('font-size:96px', 'font-size:72px'))
    const result = await f.execute('edit_file', { path: 'deck.html', old_text: 'font-size:72px', new_text: 'font-size:96px' })
    expect(result.isError, result.content).toBe(false)
    expect(await readFile(f.target, 'utf8')).toBe(source)
    expect(JSON.parse(result.content)).not.toHaveProperty('verifier_revision')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it.each(['inspired', 'unrelated', 'no-canonical'] as const)('does not freeze %s edits', async (kind) => {
    const f = await fixture()
    await f.store.update(f.sessionId, (state) => {
      if (kind === 'inspired') state.activeReferenceStyleContract!.contract.strictness = 'inspired'
      else if (kind === 'unrelated') state.activeVisualArtifact!.path = 'other.html'
      else delete state.activeVisualArtifact
    })
    const commit = vi.spyOn(f.store, 'commitWorkspaceWrite')
    const result = await f.execute('edit_file', { path: 'deck.html', old_text: 'font-size:96px', new_text: 'font-size:72px' })
    expect(result.isError, result.content).toBe(false)
    expect(commit.mock.calls[0][1].expectedReferenceStyleSha256).toBeUndefined()
    expect(await readFile(f.target, 'utf8')).toBe(source.replace('font-size:96px', 'font-size:72px'))
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
