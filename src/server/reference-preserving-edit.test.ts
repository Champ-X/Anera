import { describe, expect, it } from 'vitest'
import { assertReferenceSourcePreserved, verifyDurableReferenceSource } from './reference-preserving-edit.js'
import { applyArenaEdit } from './workspace-edit.js'
import { verifyHtmlAgainstReferenceStyle } from './reference-style.js'
import { referenceFixture, source } from './test-support/reference-preserving-edit-fixture.js'

describe('reference-preserving edit preflight', () => {
  it('shares the explicit verifier policy without producing a successful receipt', () => {
    const reference = referenceFixture()
    expect(verifyDurableReferenceSource(source, reference)).toEqual(verifyHtmlAgainstReferenceStyle(source, reference.contract, reference.sourceProfile))
    expect(verifyDurableReferenceSource(source, reference)).toMatchObject({ fidelity: 'pass', score: 100 })
    expect(assertReferenceSourcePreserved(source, source.replace('Verified content', 'Revised content'), reference)).toBeUndefined()
  })

  it.each([
    ['font-size:96px', 'font-size:72px', 'font-size'],
    ['font-family:Inter', 'font-family:Arial', 'fonts'],
    ['background:#102030', 'background:#ff0000', 'colors'],
    ['padding:24px', 'padding:8px', 'padding'],
    ['font-weight:600', 'font-weight:400', 'font-weight'],
    ['class="headline"', 'class="other"', 'markers'],
  ])('rejects a regression of %s before any write', (oldText, newText, diagnostic) => {
    const proposed = source.replace(oldText, newText)
    expect(() => assertReferenceSourcePreserved(source, proposed, referenceFixture())).toThrow(/rejected before commit/u)
    try { assertReferenceSourcePreserved(source, proposed, referenceFixture()) } catch (error) {
      expect((error as Error).message).toContain(diagnostic)
      expect((error as Error).message).toContain('No file was changed')
      expect((error as Error).message).toContain('do not undo this rejected edit')
      expect((error as Error).message).toContain('not a successful verification receipt')
    }
  })

  it('evaluates the final coherent batch rather than its temporarily-invalid intermediate state', () => {
    let proposed = applyArenaEdit(source, 'font-size:96px', 'font-size:72px').content
    proposed = applyArenaEdit(proposed, 'font-size:72px', 'font-size:96px').content
    proposed = applyArenaEdit(proposed, 'Verified content', 'Revised content').content
    expect(() => assertReferenceSourcePreserved(source, proposed, referenceFixture())).not.toThrow()
  })

  it('allows content and alternative runtime implementation changes without treating them as proven delivery', () => {
    const proposed = source.replace('Verified content', 'Another verified fact').replace('window.fixtureNavigation=true', 'window.anotherImplementation=true')
    expect(() => assertReferenceSourcePreserved(source, proposed, referenceFixture())).not.toThrow()
    expect(verifyDurableReferenceSource(proposed, referenceFixture())).not.toHaveProperty('render_fidelity')
  })

  it('allows coherent work on already-invalid drafts without granting a pass', () => {
    const before = source.replace('font-size:96px', 'font-size:72px').replace('padding:24px', 'padding:8px')
    const proposed = before.replace('font-size:72px', 'font-size:96px')
    expect(() => assertReferenceSourcePreserved(before, proposed, referenceFixture())).not.toThrow()
    expect(verifyDurableReferenceSource(proposed, referenceFixture()).fidelity).toBe('mismatch')
    expect(() => assertReferenceSourcePreserved(before, source, referenceFixture())).not.toThrow()
  })

  it('does not impose an exact-source freeze on inspired, unprofiled, or unchanged input', () => {
    const reference = referenceFixture()
    const proposed = source.replace('font-size:96px', 'font-size:72px')
    expect(() => assertReferenceSourcePreserved(source, proposed, { ...reference, contract: { ...reference.contract, strictness: 'inspired' } })).not.toThrow()
    expect(() => assertReferenceSourcePreserved(source, proposed, { ...reference, sourceProfile: undefined })).not.toThrow()
    expect(() => assertReferenceSourcePreserved(source, source, reference)).not.toThrow()
  })
})
