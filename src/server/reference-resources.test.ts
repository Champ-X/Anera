import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildReferenceResourceSet, buildReferenceRuntimeResourceSet, readReferenceResource, resolveReferenceResourceReplacement, validateReferenceResourceReadRequest,
  type ReferenceResourceReadRequest,
} from './reference-resources.js'
import {
  composeReferenceTemplate, materializeReferenceRuntimeLoader, referenceTemplateRuntimeEvidence,
} from './reference-template.js'
import { source, sourceUrl, dependency, input } from './test-support/reference-template-fixtures.js'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const sourceHash = sha(source)
const manifest = referenceTemplateRuntimeEvidence(sourceHash, sourceUrl, [dependency])
const options = { source, sourceUrl, sourceSha256: sourceHash, dependencies: [dependency], manifestSha256: manifest.manifestSha256 }
const set = () => buildReferenceResourceSet(options)
const descriptor = () => readReferenceResource(set(), { source_sha256: sourceHash }).resources.find((item) => item.referenceable)!
const binding = () => ({ source_sha256: sourceHash, resource_id: descriptor().resource_id, resource_sha256: descriptor().resource_sha256 })

describe('immutable reference resource boundary', () => {
  it('shares identical validated runtime descriptors and bytes without reconstructing a template resource', () => {
    const full = set()
    const runtime = buildReferenceRuntimeResourceSet(options)
    expect(runtime).toEqual({ sourceSha256: sourceHash,
      resources: full.resources.filter((resource) => resource.resource_id !== 'template'),
      contents: new Map([...full.contents].filter(([id]) => id !== 'template')) })
    expect(() => buildReferenceRuntimeResourceSet({ ...options, manifestSha256: 'a'.repeat(64) })).toThrow(/manifest/u)
    expect(() => buildReferenceRuntimeResourceSet({ ...options, sourceSha256: 'b'.repeat(64) })).toThrow(/manifest/u)
  })
  it('lists byte identities without expanding source or loader content', () => {
    const result = readReferenceResource(set(), { source_sha256: sourceHash })
    expect(result).toMatchObject({ kind: 'reference_resource', schemaVersion: 1, source_sha256: sourceHash })
    expect(result).not.toHaveProperty('content')
    expect(result).not.toHaveProperty('has_more')
    expect(result.resources.map((item) => [item.resource_id, item.referenceable])).toEqual([
      ['template', false], ['runtime/0', false], ['runtime-loader/0', true],
    ])
    expect(result.resources[2]).toMatchObject({ runtime_manifest_sha256: manifest.manifestSha256,
      dependency_sha256: dependency.sha256, materializer_version: 'ordered-blob-v1',
      total_bytes: Buffer.byteLength(materializeReferenceRuntimeLoader(dependency)),
      resource_sha256: sha(materializeReferenceRuntimeLoader(dependency)) })
    expect(JSON.stringify(result)).not.toContain(Buffer.from(dependency.content).toString('base64'))
  })

  it('uses exactly the same UTF-8 and raw-script-boundary-safe bytes as composition', () => {
    const content = '/* 字形 😀 </script><p> */ customElements.define("deck-stage",class extends HTMLElement{});'
    const native = { ...dependency, content, bytes: Buffer.byteLength(content), sha256: sha(content) }
    const loader = materializeReferenceRuntimeLoader(native)
    const composed = composeReferenceTemplate({ ...input(), dependencies: [native] })
    expect(composed.html).toContain(loader)
    const encoded = loader.match(/atob\("([^"]+)"\)/u)![1]
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(content)
    expect(loader.match(/<script>/gu)).toHaveLength(1)
    expect(loader.match(/<\/script>/gu)).toHaveLength(1)
    expect(loader).not.toContain('eval(')
    expect(loader).not.toContain('data:text/javascript')
    expect(loader).toContain('s.async=false')
  })

  it('reassembles Unicode pages with identity-bound byte cursors and no inline control text', () => {
    const unicodeSource = source.replace('Template demo', 'Title 中文 😀 end')
    const hash = sha(unicodeSource)
    const resources = buildReferenceResourceSet({ ...options, source: unicodeSource, sourceSha256: hash,
      manifestSha256: referenceTemplateRuntimeEvidence(hash, sourceUrl, [dependency]).manifestSha256 })
    let request: ReferenceResourceReadRequest = { source_sha256: hash, resource_id: 'template', max_bytes: 7 }
    let content = ''
    let end = 0
    for (;;) {
      const page = readReferenceResource(resources, request)
      expect(page.start_byte).toBe(end)
      expect(page.returned_bytes).toBe(Buffer.byteLength(page.content!))
      expect(page.returned_bytes).toBeLessThanOrEqual(7)
      expect(page.content).not.toContain('\ufffd')
      content += page.content
      end = page.end_byte!
      if (!page.has_more) { expect(page.next_cursor).toBeUndefined(); break }
      expect(page.next_cursor).toMatchObject({ source_sha256: hash, resource_sha256: hash, byte_offset: end })
      request = page.next_cursor!
    }
    expect(content).toBe(unicodeSource)
    expect(end).toBe(Buffer.byteLength(unicodeSource))
    const insideScalar = Buffer.byteLength(unicodeSource.slice(0, unicodeSource.indexOf('中'))) + 1
    expect(() => readReferenceResource(resources, { source_sha256: hash, resource_id: 'template',
      resource_sha256: hash, byte_offset: insideScalar })).toThrow('UTF-8')
  })

  it('rejects changed, absent, reordered, or corrupted source/runtime evidence', () => {
    for (const bad of [
      { ...options, source: source + ' ' },
      { ...options, sourceSha256: 'f'.repeat(64) },
      { ...options, manifestSha256: 'a'.repeat(64) },
      { ...options, manifestSha256: undefined },
      { ...options, dependencies: [] },
      { ...options, dependencies: [{ ...dependency, content: dependency.content + ';' }] },
      { ...options, dependencies: [{ ...dependency, url: 'https://other.example/runtime.js' }] },
    ]) expect(() => buildReferenceResourceSet(bad)).toThrow(/identity|manifest|dependency|corrupted/u)
    const second = { ...dependency, url: new URL('second.js', sourceUrl).href }
    const twoSource = source.replace('</body>', '<script src="second.js"></script></body>')
    const twoHash = sha(twoSource)
    const twoOptions = { source: twoSource, sourceUrl, sourceSha256: twoHash, dependencies: [dependency, second],
      manifestSha256: referenceTemplateRuntimeEvidence(twoHash, sourceUrl, [dependency, second]).manifestSha256 }
    expect(buildReferenceResourceSet(twoOptions).resources).toHaveLength(5)
    expect(() => buildReferenceResourceSet({ ...twoOptions, dependencies: [second, dependency] })).toThrow('order')
  })

  it('keeps returned descriptors separate from the private resource set', () => {
    const resources = set()
    const result = readReferenceResource(resources, { source_sha256: sourceHash })
    result.resources[0].referenceable = true
    const original = readReferenceResource(resources, { source_sha256: sourceHash })
    expect(original.resources[0].referenceable).toBe(false)
  })

  it('rejects paths, foreign identities, invalid cursors, unknown fields and unbound continuation', () => {
    const resources = set()
    const base = { source_sha256: sourceHash, resource_id: 'template' }
    expect(() => readReferenceResource(resources, { ...base, byte_offset: 8192, max_bytes: 20000 }))
      .toThrow(/requires its current resource_sha256; copy every field from the previous next_cursor exactly/u)
    for (const request of [
      { ...base, resource_id: '../../state.json' }, { ...base, source_sha256: 'a'.repeat(64) },
      { ...base, resource_sha256: 'a'.repeat(64) }, { ...base, byte_offset: 1 },
      { ...base, byte_offset: -1 }, { ...base, max_bytes: 3 }, { ...base, max_bytes: 32_769 },
      { ...base, max_bytes: NaN }, { ...base, byte_offset: Infinity },
      { ...base, resource_sha256: sourceHash, byte_offset: Buffer.byteLength(source) + 1 },
      { ...base, resource_sha256: sourceHash, byte_offset: 0.5 }, { ...base, cursor_typo: 0 },
      { source_sha256: sourceHash, byte_offset: 0 },
    ]) expect(() => readReferenceResource(resources, request)).toThrow()
    for (const request of [null, [], 'template', {}, { source_sha256: 123 },
      { ...base, byte_offset: null }, { ...base, max_bytes: '8192' },
      { ...base, resource_id: 'runtime/00' }, { ...base, resource_id: 'runtime/-1' },
      { ...base, resource_sha256: null }, { ...base, source_sha256: sourceHash.toUpperCase() },
    ]) expect(() => validateReferenceResourceReadRequest(request)).toThrow()
    expect(readReferenceResource(resources, { ...base, resource_sha256: sourceHash,
      byte_offset: Buffer.byteLength(source), max_bytes: 4 })).toMatchObject({
      content: '', returned_bytes: 0, has_more: false,
    })
  })

  it('replaces exactly one literal span from a compact binding without changing other bytes', () => {
    const resources = set()
    const old = '<script>customNavigation()</script>'
    const current = `<!doctype html><html><head></head><body><h1>Actual content</h1>${old}<p>Tail</p></body></html>`
    const edited = resolveReferenceResourceReplacement(resources, binding(), old, current).content
    expect(edited).toBe(current.replace(old, materializeReferenceRuntimeLoader(dependency)))
    expect(JSON.stringify(binding()).length).toBeLessThan(230)
    for (const target of ['', ' customNavigation() ', '<script>CustomNavigation()</script>']) {
      expect(() => resolveReferenceResourceReplacement(resources, binding(), target, current)).toThrow(/exact|literal/u)
    }
    expect(() => resolveReferenceResourceReplacement(resources, binding(), 'script', current)).toThrow('not unique')
    // Overlapping matches are ambiguous too; do not skip past oldText.length.
    expect(() => resolveReferenceResourceReplacement(resources, binding(), 'aa', 'aaa')).toThrow('not unique')
  })

  it('never accepts template/raw-script insertion, stale bindings or typo fallback', () => {
    const resources = set()
    for (const item of resources.resources.filter((item) => !item.referenceable)) {
      expect(() => resolveReferenceResourceReplacement(resources, { source_sha256: sourceHash,
        resource_id: item.resource_id, resource_sha256: item.resource_sha256 }, 'OLD', 'OLD')).toThrow('read-only')
    }
    for (const bad of [
      { ...binding(), source_sha256: 'a'.repeat(64) }, { ...binding(), resource_sha256: 'a'.repeat(64) },
      { ...binding(), resource_id: 'runtime-loader/9' }, { ...binding(), resource_hahs: 'typo' },
    ]) expect(() => resolveReferenceResourceReplacement(resources, bad, 'OLD', 'OLD')).toThrow()
    expect(() => resolveReferenceResourceReplacement(resources, binding(), 'OLD', 'OLD' + 'x'.repeat(768 * 1024)))
      .toThrow('bounded output')
  })
})
