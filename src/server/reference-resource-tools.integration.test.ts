import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallRecord } from '../shared/types.js'
import { inspectStoredReferenceRuntime } from './reference-runtime-diagnostics.js'
import { extractReferenceStyleSourceProfile } from './reference-style.js'
import type { BrowserManager } from './browser-manager.js'
import type { ProcessManager } from './process-manager.js'
import { SessionStore } from './session-store.js'
import { materializeReferenceRuntimeLoader, referenceTemplateCatalog, referenceTemplateRuntimeEvidence } from './reference-template.js'
import type { ReferenceResourceBinding, ReferenceResourceReadResult } from './reference-resources.js'
import { EXTENSION_TOOL_DEFINITIONS, ToolExecutor, normalizeAneraRuntimeToolCall, validateToolCallArguments,
  type ToolExecutionResult } from './tools.js'
import { source, sourceUrl } from './test-support/reference-template-fixtures.js'

const roots: string[] = []
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const replacedScript = '<script>window.oldNavigation = true</script>'
const currentHtml = `<html><body><p>Keep user content.</p>${replacedScript}<script>window.unrelated = true</script></body></html>`

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-reference-resource-tools-'))
  roots.push(root)
  const store = new SessionStore(root, 'offline-fixture')
  await store.initialize()
  const session = await store.create()
  const sessionId = session.summary.id
  const catalog = referenceTemplateCatalog(source, sourceUrl)
  const script = '/*' + ' '.repeat(8_189) + '原生资源🪷 */\n' + '/* preserved source bytes */'.repeat(1_000)
    + '\ncustomElements.define("deck-stage", class extends HTMLElement {});'
  const dependency = { url: new URL('deck-stage.js', sourceUrl).toString(), content: script,
    sha256: sha256(script), bytes: Buffer.byteLength(script) }
  const manifest = await store.commitReferenceRuntimeEvidence(sessionId, catalog.sourceSha256, sourceUrl, [dependency])
  await store.append(sessionId, 'tool.completed', {
    call: { id: 'source-fetch', name: 'fetch_page', arguments: { url: sourceUrl, format: 'raw' } },
    result: JSON.stringify({ status: 'success', url: sourceUrl, content: source, hasMore: false, chunkIndex: 0, totalChunks: 1 }),
    isError: false,
  })
  await store.update(sessionId, (state) => {
    state.messages = [{ role: 'assistant', content: 'The exact source was compacted out of model context.' }]
    state.activeReferenceStyleContract = {
      contract: { sourceUrl, strictness: 'exact', colors: ['#120a10', '#ed3d8c'], fonts: ['serif'],
        layout: ['three layouts'], components: ['slide', 'headline'], requiredMarkers: ['.slide', '.display'],
        signature: 'Fixture', avoid: ['invented source'], viewport: { width: 1000, height: 600 } },
      provenance: { resolvedUrl: sourceUrl, evidenceSha256: catalog.sourceSha256, evidenceBytes: Buffer.byteLength(source) },
      templateCatalog: catalog,
      runtimeEvidence: manifest,
    }
  })
  const target = resolve(store.workspaceDir(sessionId), 'deck.html')
  await writeFile(target, currentHtml)
  const runtimePath = resolve(store.sessionDir(sessionId), 'reference-style/runtime/v1', manifest.manifestSha256, `${dependency.sha256}.js`)
  const fetch = vi.fn(async () => { throw new Error('No network is permitted in reference resource fixtures') })
  const forbidden = new Proxy({}, { get: () => { throw new Error('Reference resource tools must not use Browser or Process APIs') } })
  const executor = new ToolExecutor(store, forbidden as ProcessManager, forbidden as BrowserManager,
    { inspect: vi.fn(async () => { throw new Error('No Vision is permitted') }) }, async () => false, { fetch })
  const context = { sessionId, turnId: 'turn_resources', stepId: 'step_resources', signal: new AbortController().signal }
  let sequence = 0
  const execute = (name: string, args: Record<string, unknown>) => executor.execute({ id: `resource-${++sequence}`, name, arguments: args }, context)
  const read = async (args: Record<string, unknown> = {}) => {
    const call: ToolCallRecord = { id: `resource-${++sequence}`, name: 'read_reference_resource',
      arguments: { source_sha256: catalog.sourceSha256, ...args } }
    const result = await executor.execute(call, context)
    expect(result.isError, result.content).toBe(false)
    return { call, result, payload: JSON.parse(result.content) as ReferenceResourceReadResult }
  }
  const receipt = async (readResult: Awaited<ReturnType<typeof read>>, overrides: Record<string, unknown> = {}, id = sessionId) => {
    await store.append(id, 'tool.completed', { call: readResult.call, result: readResult.result.content, isError: false, ...overrides })
  }
  const binding = (payload: ReferenceResourceReadResult): ReferenceResourceBinding => {
    const resource = payload.resources.find((item) => item.resource_id === 'runtime-loader/0')!
    return { source_sha256: payload.source_sha256, resource_id: resource.resource_id, resource_sha256: resource.resource_sha256 }
  }
  return { store, sessionId, root, catalog, dependency, manifest, runtimePath, target, fetch, execute, read, receipt, binding }
}

function errorMessage(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  return JSON.parse(result.content).message
}

describe('reference resource tools', () => {
  it('attaches runtime diagnostics to source verification without changing its verdict or granting a replacement receipt', async () => {
    const f = await fixture()
    const fontEvidence = await f.store.commitReferenceFontEvidence(f.sessionId, {
      sourceEvidenceSha256: f.catalog.sourceSha256, fontCss: '', familyNames: [], materializationManifest: null,
    })
    await f.store.update(f.sessionId, (state) => { state.activeReferenceStyleContract!.fontEvidence = fontEvidence })
    const html = source.replace('<script src="deck-stage.js"></script>', replacedScript)
    await writeFile(f.target, html)
    const before = await f.execute('verify_reference_style', { path: 'deck.html' })
    expect(before.isError, before.content).toBe(false)
    const first = JSON.parse(before.content)
    expect(first.runtime_diagnostic).toMatchObject({ advisory_only: true,
      artifact_hash: createHash('sha256').update(html).digest('base64url'),
      dependencies: [{ resource_id: 'runtime/0', recognized_inline_scripts: 0 }] })
    // This generic fixture intentionally has an unmatched generic-family
    // token. Runtime metadata must neither fix nor worsen that existing gap.
    expect(first.fidelity).toBe('mismatch')
    expect(first.missing.fonts).toEqual(['serif'])
    const descriptor = (await f.read()).payload
    expect(errorMessage(await f.execute('edit_file', { path: 'deck.html', old_text: replacedScript, reference_resource: f.binding(descriptor) })))
      .toMatch(/Read this runtime-loader descriptor/u)
    const manifest = await f.read()
    await f.receipt(manifest)
    expect((await f.execute('edit_file', { path: 'deck.html', old_text: replacedScript, reference_resource: f.binding(manifest.payload) })).isError).toBe(false)
    const after = await f.execute('verify_reference_style', { path: 'deck.html' })
    expect(after.isError, after.content).toBe(false)
    const second = JSON.parse(after.content)
    expect(second.runtime_diagnostic.dependencies[0].recognized_inline_scripts).toBe(1)
    expect({ fidelity: second.fidelity, score: second.score, violations: second.violations })
      .toEqual({ fidelity: first.fidelity, score: first.score, violations: first.violations })
    await writeFile(f.runtimePath, 'corrupted private runtime')
    const unavailable = await f.execute('verify_reference_style', { path: 'deck.html' })
    expect(unavailable.isError, unavailable.content).toBe(false)
    const third = JSON.parse(unavailable.content)
    expect(third.runtime_diagnostic).toEqual({ advisory_only: true, unavailable: true })
    expect({ fidelity: third.fidelity, score: third.score }).toEqual({ fidelity: second.fidelity, score: second.score })
    expect(unavailable.content).not.toContain(f.root)
    const rejectedResource = await f.execute('read_reference_resource', { source_sha256: f.catalog.sourceSha256 })
    expect(errorMessage(rejectedResource)).toMatch(/missing, invalid, or no longer bound/u)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('recovers journal-backed source and returns a path-free manifest without mutation, initialization, network, or Browser work', async () => {
    const f = await fixture()
    const statePath = resolve(f.store.sessionDir(f.sessionId), 'state.json')
    const eventsPath = resolve(f.store.sessionDir(f.sessionId), 'events.jsonl')
    const paths = [statePath, eventsPath, f.target, f.runtimePath]
    const before = await Promise.all(paths.map((path) => readFile(path)))
    const initialize = vi.spyOn(f.store, 'initialize')
    const commit = vi.spyOn(f.store, 'commitWorkspaceWrite')
    const { payload, result } = await f.read()
    expect(payload).toMatchObject({ status: 'success', kind: 'reference_resource', schemaVersion: 1,
      source_sha256: f.catalog.sourceSha256 })
    expect(payload.resources.map((resource) => [resource.resource_id, resource.referenceable]))
      .toEqual([['template', false], ['runtime/0', false], ['runtime-loader/0', true]])
    expect(payload.content).toBeUndefined()
    expect(result.content).not.toContain(f.root)
    expect(result.content).not.toContain('base64')
    expect(payload.resources[1]).toMatchObject({ resource_sha256: f.dependency.sha256, total_bytes: f.dependency.bytes,
      runtime_manifest_sha256: f.manifest.manifestSha256, source_url: f.dependency.url })
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before)
    expect(initialize).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('projects runtime-only diagnostics without rehydrating source, creating evidence or granting a receipt', async () => {
    const f = await fixture()
    const directory = f.store.sessionDir(f.sessionId)
    const reference = (await f.store.get(f.sessionId)).activeReferenceStyleContract!
    const paths = [resolve(directory, 'state.json'), resolve(directory, 'events.jsonl'), f.target, f.runtimePath]
    const before = await Promise.all(paths.map((path) => readFile(path)))
    const html = currentHtml.replace(replacedScript, materializeReferenceRuntimeLoader(f.dependency))
    const diagnostic = await inspectStoredReferenceRuntime(directory, reference, html)
    expect(diagnostic).toMatchObject({ advisory_only: true, artifact_hash: createHash('sha256').update(html).digest('base64url'),
      source_sha256: f.catalog.sourceSha256, dependencies: [{ recognized_inline_scripts: 1,
        resource_sha256: f.dependency.sha256, runtime_manifest_sha256: f.manifest.manifestSha256 }] })
    expect(diagnostic).not.toHaveProperty('kind')
    expect(diagnostic).not.toHaveProperty('fidelity')
    for (const modified of [
      { ...reference, runtimeEvidence: undefined },
      { ...reference, provenance: { ...reference.provenance, evidenceSha256: 'a'.repeat(64) } },
      { ...reference, provenance: { ...reference.provenance, resolvedUrl: 'https://different.example/template.html' } },
      { ...reference, templateCatalog: { ...reference.templateCatalog!, dependencies: ['https://different.example/runtime.js'] } },
    ]) expect(await inspectStoredReferenceRuntime(directory, modified, html)).toEqual({ advisory_only: true, unavailable: true })
    const missingDirectory = resolve(f.root, 'must-not-create')
    expect(await inspectStoredReferenceRuntime(missingDirectory, reference, html)).toEqual({ advisory_only: true, unavailable: true })
    await expect(readFile(resolve(missingDirectory, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await inspectStoredReferenceRuntime(missingDirectory, { ...reference, templateCatalog: undefined }, html)).toBeUndefined()
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('keeps UTF-8 content and continuation metadata separate and reassembles the exact original script', async () => {
    const f = await fixture()
    let page = await f.read({ resource_id: 'runtime/0', max_bytes: 8192 })
    let content = ''
    let offset = 0
    // The first byte limit lands inside the source's first non-ASCII scalar.
    while (true) {
      expect(page.payload.start_byte).toBe(offset)
      expect(page.payload.returned_bytes).toBe(Buffer.byteLength(page.payload.content!))
      expect(page.payload.content).not.toContain('\uFFFD')
      content += page.payload.content
      offset = page.payload.end_byte!
      if (!page.payload.has_more) break
      expect(page.payload.next_cursor).toMatchObject({ source_sha256: f.catalog.sourceSha256,
        resource_id: 'runtime/0', resource_sha256: f.dependency.sha256, byte_offset: offset })
      page = await f.read({ ...page.payload.next_cursor })
    }
    expect(content).toBe(f.dependency.content)
    expect(sha256(content)).toBe(f.dependency.sha256)
  })

  it.each(['manifest', 'partial page'])('uses a real %s receipt to replace only the explicit script without echoing the loader', async (kind) => {
    const f = await fixture()
    const read = await f.read(kind === 'manifest' ? {} : { resource_id: 'runtime-loader/0', max_bytes: 32 })
    await f.receipt(read)
    const beforeEvents = await f.store.events(f.sessionId)
    const commit = vi.spyOn(f.store, 'commitWorkspaceWrite')
    const args = { path: 'deck.html', old_text: replacedScript, reference_resource: f.binding(read.payload) }
    expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThan(1000)
    const result = await f.execute('edit_file', args)
    expect(result.isError, result.content).toBe(false)
    const loader = materializeReferenceRuntimeLoader(f.dependency)
    expect(Buffer.byteLength(loader)).toBeGreaterThan(16_000)
    expect(await readFile(f.target, 'utf8')).toBe(currentHtml.replace(replacedScript, loader))
    expect(commit).toHaveBeenCalledOnce()
    expect(commit.mock.calls[0][1]).toMatchObject({ mode: 'replace', operation: 'edited', expectedBefore: Buffer.from(currentHtml) })
    const newEvents = (await f.store.events(f.sessionId)).slice(beforeEvents.length)
    expect(newEvents.filter((event) => event.type === 'file.changed')).toHaveLength(1)
    expect(newEvents.some((event) => /reference.*verif|render|inspection/u.test(event.type))).toBe(false)
    expect(result.content).not.toContain('base64')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it.each(['none', 'message only', 'not executed', 'failed', 'other session'])('rejects a %s receipt without changing the artifact', async (kind) => {
    const f = await fixture()
    const read = await f.read()
    if (kind === 'message only') await f.store.update(f.sessionId, (state) => {
      state.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: read.call.id, type: 'function',
        function: { name: read.call.name, arguments: JSON.stringify(read.call.arguments) } }] },
      { role: 'tool', tool_call_id: read.call.id, content: read.result.content, tool_result_status: 'succeeded' })
    })
    if (kind === 'not executed') await f.receipt(read, { notExecuted: true })
    if (kind === 'failed') await f.receipt(read, { isError: true })
    if (kind === 'other session') await f.receipt(read, {}, (await f.store.create()).summary.id)
    const commit = vi.spyOn(f.store, 'commitWorkspaceWrite')
    const result = await f.execute('edit_file', { path: 'deck.html', old_text: replacedScript, reference_resource: f.binding(read.payload) })
    expect(errorMessage(result)).toContain('read_reference_resource')
    expect(await readFile(f.target, 'utf8')).toBe(currentHtml)
    expect(commit).not.toHaveBeenCalled()
  })

  it.each(['source', 'resource'])('rejects a stale %s identity and requests resource reading, not canonical rereading', async (kind) => {
    const f = await fixture()
    const read = await f.read()
    await f.receipt(read)
    const binding = f.binding(read.payload)
    binding[kind === 'source' ? 'source_sha256' : 'resource_sha256'] = 'a'.repeat(64)
    const result = await f.execute('edit_file', { path: 'deck.html', old_text: replacedScript, reference_resource: binding })
    expect(errorMessage(result)).toContain('read_reference_resource')
    expect(result.content).not.toMatch(/Context not found|Read the canonical file/u)
    expect(await readFile(f.target, 'utf8')).toBe(currentHtml)
  })

  it.each(['corrupted', 'symlink'])('revalidates %s private runtime bytes after the receipt without exposing its path', async (kind) => {
    const f = await fixture()
    const read = await f.read()
    await f.receipt(read)
    if (kind === 'corrupted') await writeFile(f.runtimePath, f.dependency.content.replace('原生', '损坏'))
    else {
      await rm(f.runtimePath)
      await symlink(f.target, f.runtimePath)
    }
    const commit = vi.spyOn(f.store, 'commitWorkspaceWrite')
    const result = await f.execute('edit_file', { path: 'deck.html', old_text: replacedScript, reference_resource: f.binding(read.payload) })
    expect(errorMessage(result)).toContain('read_reference_resource')
    expect(result.content).not.toContain(f.root)
    expect(await readFile(f.target, 'utf8')).toBe(currentHtml)
    expect(commit).not.toHaveBeenCalled()
  })

  it.each(['missing', 'fuzzy', 'duplicate'])('fails closed on %s old_text without changing any file bytes', async (kind) => {
    const f = await fixture()
    const read = await f.read()
    await f.receipt(read)
    const original = kind === 'duplicate' ? currentHtml + replacedScript : currentHtml
    if (kind === 'duplicate') await writeFile(f.target, original)
    const oldText = kind === 'missing' ? '<script>absent()</script>'
      : kind === 'fuzzy' ? replacedScript.replace(' = ', '  =  ') : replacedScript
    const commit = vi.spyOn(f.store, 'commitWorkspaceWrite')
    const result = await f.execute('edit_file', { path: 'deck.html', old_text: oldText, reference_resource: f.binding(read.payload) })
    expect(errorMessage(result)).toMatch(/canonical file/u)
    expect(await readFile(f.target, 'utf8')).toBe(original)
    expect(commit).not.toHaveBeenCalled()
  })

  it('retains the existing atomic expectedBefore conflict check after resolving a resource', async () => {
    const f = await fixture()
    const read = await f.read()
    await f.receipt(read)
    const commit = f.store.commitWorkspaceWrite.bind(f.store)
    vi.spyOn(f.store, 'commitWorkspaceWrite').mockImplementationOnce(async (id, options) => {
      await writeFile(f.target, 'Concurrent user edit')
      return await commit(id, options)
    })
    const beforeEvents = await f.store.events(f.sessionId)
    const result = await f.execute('edit_file', { path: 'deck.html', old_text: replacedScript, reference_resource: f.binding(read.payload) })
    expect(errorMessage(result)).toContain('File changed before edit')
    expect(await readFile(f.target, 'utf8')).toBe('Concurrent user edit')
    expect((await f.store.events(f.sessionId)).slice(beforeEvents.length).some((event) => event.type === 'file.changed')).toBe(false)
  })

  it.each(['source switch', 'invalidation', 'runtime manifest change'])('rejects reference admission after a receipt-time %s', async (change) => {
    const f = await fixture()
    // Exercise both constraints together: even an already-invalid canonical
    // draft must not replace the resource receipt's old contract CAS with a
    // freshly observed contract during the later edit preflight.
    await f.store.update(f.sessionId, (state) => {
      const reference = state.activeReferenceStyleContract!
      reference.sourceProfile = extractReferenceStyleSourceProfile(source, reference.contract)!
      state.activeVisualArtifact = { schemaVersion: 1, path: 'deck.html', canonicalWriteCallId: 'fixture-write',
        canonicalWriteEventSeq: 1, lastMutationCallId: 'fixture-write', lastMutationEventSeq: 1,
        currentHash: createHash('sha256').update(currentHtml).digest('base64url') }
    })
    const read = await f.read()
    await f.receipt(read)
    const before = await f.store.get(f.sessionId)
    const beforeEvents = await f.store.events(f.sessionId)
    const originalEvents = f.store.events.bind(f.store)
    let reads = 0
    vi.spyOn(f.store, 'events').mockImplementation(async (id, afterSeq) => {
      const events = await originalEvents(id, afterSeq)
      // The first read restores source bytes. The second is the receipt await,
      // after the replacement's private resource set has already been built.
      if (++reads === 2) await f.store.update(f.sessionId, (state) => {
        const reference = state.activeReferenceStyleContract!
        if (change === 'source switch') {
          const nextSource = source.replace('Template demo', 'A different source revision')
          reference.templateCatalog = referenceTemplateCatalog(nextSource, sourceUrl)
          reference.provenance = { ...reference.provenance, evidenceSha256: sha256(nextSource), evidenceBytes: Buffer.byteLength(nextSource) }
          reference.runtimeEvidence = referenceTemplateRuntimeEvidence(sha256(nextSource), sourceUrl, [f.dependency])
        } else if (change === 'invalidation') {
          state.referenceStyleEvidenceInvalidation = { version: 1, contractEvidenceSha256: sha256(JSON.stringify(reference)),
            sourceUrl, sourceEvidenceSha256: reference.provenance.evidenceSha256, strictness: 'exact',
            reason: 'runtime_evidence_missing_or_invalid', invalidatedAt: new Date().toISOString() }
        } else {
          const nextScript = `${f.dependency.content}\n/* Updated native runtime */`
          reference.runtimeEvidence = referenceTemplateRuntimeEvidence(f.catalog.sourceSha256, sourceUrl,
            [{ ...f.dependency, content: nextScript, bytes: Buffer.byteLength(nextScript), sha256: sha256(nextScript) }])
        }
      })
      return events
    })
    const commit = vi.spyOn(f.store, 'commitWorkspaceWrite')
    const result = await f.execute('edit_file', { path: 'deck.html', old_text: replacedScript, reference_resource: f.binding(read.payload) })
    expect(reads).toBe(2)
    expect(errorMessage(result)).toContain('read_reference_resource')
    expect(result.content).not.toMatch(/Context not found|Read the canonical file|read the file to verify/u)
    expect(commit).toHaveBeenCalledOnce()
    expect(commit.mock.calls[0][1].expectedReferenceStyleSha256).toBe(sha256(JSON.stringify(before.activeReferenceStyleContract)))
    expect(await readFile(f.target, 'utf8')).toBe(currentHtml)
    const after = await f.store.get(f.sessionId)
    expect(after.artifacts).toEqual(before.artifacts)
    expect(Object.keys(after.pendingWorkspaceMutations ?? {})).toEqual([])
    expect((await originalEvents(f.sessionId)).slice(beforeEvents.length).some((event) => event.type === 'file.changed')).toBe(false)
    expect(f.fetch).not.toHaveBeenCalled()
  })
})

describe('reference resource tool schemas', () => {
  const binding = { source_sha256: 'a'.repeat(64), resource_id: 'runtime-loader/0', resource_sha256: 'b'.repeat(64) }

  it('publishes a separate extension without altering the frozen Arena tool surface', () => {
    expect(EXTENSION_TOOL_DEFINITIONS.read_reference_resource.function.name).toBe('read_reference_resource')
    const call = { id: 'read', name: 'read_reference_resource', arguments: { source_sha256: binding.source_sha256 } }
    expect(() => validateToolCallArguments(normalizeAneraRuntimeToolCall(call))).not.toThrow()
  })

  it.each([
    { source_sha256: 'a'.repeat(64), path: '/private/source.html' },
    { source_sha256: 'a'.repeat(64), resource_id: 'template', resource_sha: 'b'.repeat(64) },
    { source_sha256: 'a'.repeat(64), resource_id: 'runtime/0', byte_offset: 1 },
    { source_sha256: 'a'.repeat(64), resource_id: 'runtime/0', max_bytes: 3 },
    { source_sha256: 'a'.repeat(64), resource_id: 'runtime/0', max_bytes: 32_769 },
    { source_sha256: 'a'.repeat(64), resource_id: null },
  ])('rejects malformed or unbound read fields before resource access: %j', (args) => {
    const call = { id: 'bad-read', name: 'read_reference_resource', arguments: args }
    const normalized = normalizeAneraRuntimeToolCall(call)
    expect(normalized.arguments).toEqual(args)
    expect(() => validateToolCallArguments(normalized)).toThrow()
  })

  it.each([
    { reference_resource: binding, new_text: 'must not be used' },
    { reference_resource: binding, new_text: null },
    { reference_resource: binding, edits: [{ old_text: 'x', new_text: 'y' }] },
    { reference_resource: binding, reference_text: {} },
    { reference_resource: { ...binding, resource_sha: binding.resource_sha256 } },
    { reference_resource: null, new_text: 'must not be used' },
    { reference_resouce: binding, new_text: 'must not be used' },
    { reference_resource: { ...binding, resource_id: 'template' } },
    { reference_resource: { ...binding, resource_id: 'runtime/0' } },
    { edits: [{ old_text: 'x', new_text: 'y', reference_resource: binding }] },
  ])('preserves and rejects mixed, misspelled, or read-only replacement fields: %j', (mode) => {
    const args = { path: 'deck.html', old_text: 'x', ...mode }
    const normalized = normalizeAneraRuntimeToolCall({ id: 'bad-edit', name: 'edit_file', arguments: args })
    expect(normalized.arguments).toEqual(args)
    expect(() => validateToolCallArguments(normalized)).toThrow()
  })
})
