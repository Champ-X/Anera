import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildReferenceResourceSet } from './reference-resources.js'
import { materializeReferenceRuntimeLoader, referenceTemplateRuntimeEvidence, REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES } from './reference-template.js'
import { currentReferenceRuntimeDiagnostic, inspectReferenceRuntime, referenceRuntimeRepairInstruction } from './reference-runtime-diagnostics.js'
import { source, sourceUrl } from './test-support/reference-template-fixtures.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const code = 'customElements.define("workshop-deck", class extends HTMLElement {});'
const dependency = { url: new URL('deck-stage.js', sourceUrl).href, content: code, bytes: Buffer.byteLength(code), sha256: hash(code) }
const runtime = referenceTemplateRuntimeEvidence(hash(source), sourceUrl, [dependency])
const resources = buildReferenceResourceSet({ source, sourceUrl, sourceSha256: hash(source), dependencies: [dependency], manifestSha256: runtime.manifestSha256 })
const loader = materializeReferenceRuntimeLoader(dependency)
const candidate = (script: string) => `<html><body><p>Workshop notes</p>${script}</body></html>`
const expected = (html: string) => ({ sourceSha256: hash(source), artifactHash: createHash('sha256').update(html).digest('base64url'),
  manifestSha256: runtime.manifestSha256, dependencyHashes: [dependency.sha256] })

describe('source-bound runtime diagnostics, not style or execution verdicts', () => {
  it.each([`<script>${code}</script>`, loader, `<SCRIPT nonce="test" type="text/javascript">${code}</SCRIPT>`])('recognizes an actual classic-script body', (script) => {
    const html = candidate(script)
    const diagnostic = inspectReferenceRuntime(html, resources)
    expect(diagnostic).toMatchObject({ advisory_only: true, source_sha256: hash(source), artifact_hash: expected(html).artifactHash,
      dependencies: [{ resource_id: 'runtime/0', loader_resource_id: 'runtime-loader/0', recognized_inline_scripts: 1 }] })
    expect(currentReferenceRuntimeDiagnostic(diagnostic, expected(html))).toEqual(diagnostic)
    expect(referenceRuntimeRepairInstruction(diagnostic)).toBe('')
    expect(JSON.stringify(diagnostic)).not.toContain(code)
  })

  it.each([
    '', `<!--${loader}-->`, `<template>${loader}</template>`, `<textarea>${loader}</textarea>`,
    `<script type="application/json">${code}</script>`, `<script type="module">${code}</script>`,
    `<script nomodule>${code}</script>`, `<script src="deck-stage.js">${code}</script>`,
    `<script>const example=${JSON.stringify(loader.replaceAll('</script>', '<\\/script>'))}</script>`,
  ])('does not confuse absent, inert or differently executed code with native integration', (script) => {
    const diagnostic = inspectReferenceRuntime(candidate(script), resources)
    expect(diagnostic.dependencies[0].recognized_inline_scripts).toBe(0)
    expect(referenceRuntimeRepairInstruction(diagnostic)).toContain('Unrecognized code is not proof of a defect')
    expect(referenceRuntimeRepairInstruction(diagnostic)).toContain('shadow-root inheritance')
    expect(referenceRuntimeRepairInstruction(diagnostic)).toContain('all current source/render/Vision gates remain required')
  })

  it('reports duplicated integration without claiming runtime execution or blocking a gate', () => {
    const diagnostic = inspectReferenceRuntime(candidate(loader + loader), resources)
    expect(diagnostic.dependencies[0].recognized_inline_scripts).toBe(2)
    expect(diagnostic).not.toHaveProperty('fidelity')
    expect(diagnostic).not.toHaveProperty('status')
    expect(diagnostic).not.toHaveProperty('score')
    expect(referenceRuntimeRepairInstruction(diagnostic)).toContain('recognized code is not proof of execution')
  })

  it('rejects stale candidate, source, manifest and dependency identities before repair projection', () => {
    const html = candidate('')
    const diagnostic = inspectReferenceRuntime(html, resources)
    const identity = expected(html)
    for (const patch of [
      { artifactHash: 'x'.repeat(43) }, { sourceSha256: 'a'.repeat(64) },
      { manifestSha256: 'b'.repeat(64) }, { dependencyHashes: ['c'.repeat(64)] }, { dependencyHashes: [] },
    ]) expect(currentReferenceRuntimeDiagnostic(diagnostic, { ...identity, ...patch })).toBeUndefined()
    for (const patch of [
      { advisory_only: false }, { schemaVersion: 2 }, { dependencies: [] },
      ...[-1, 1.5, 16_001, '1'].map((recognized_inline_scripts) => ({ dependencies: [{ ...diagnostic.dependencies[0], recognized_inline_scripts }] })),
    ]) expect(currentReferenceRuntimeDiagnostic({ ...diagnostic, ...patch }, identity)).toBeUndefined()
    expect(currentReferenceRuntimeDiagnostic({ ...diagnostic, ignored: code }, identity)).toEqual(diagnostic)
  })

  it('does not infer recognition from corrupted private resource bytes', () => {
    const contents = new Map(resources.contents)
    contents.set('runtime/0', `${code} altered`)
    expect(() => inspectReferenceRuntime(candidate(loader), { ...resources, contents })).toThrow(/stale/u)
  })

  it('bounds candidate parsing independently of the generated loader size', () => {
    expect(() => inspectReferenceRuntime(' '.repeat(REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES + 1), resources)).toThrow(/bounded HTML/u)
  })
})
