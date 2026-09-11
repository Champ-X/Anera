import { describe, expect, it } from 'vitest'
import { preservesProgramStatements } from './program-preservation.js'

describe('test preservation versus byte immutability', () => {
  const source = "import assert from 'node:assert/strict';\ntest('kept', () => assert.equal(actual(), 7));"
  it('permits formatting, comments and additive tests without losing the original assertions', () => {
    expect(preservesProgramStatements(source, '// retained\n' + source.replace(';\n', ';\n\n') + "\ntest('new', () => assert.ok(extra()));")).toBe(true)
  })
  it.each([
    source.replace('assert.equal(actual(), 7)', 'assert.ok(true)'),
    '// ' + source.replace('\n', '\n// '),
    source.replace("test('kept',", "test.skip('kept',"),
    source.replace('7', '8'), '',
  ])('rejects removal, disabling, weakening or changing the original assertion (%#)', (after) => {
    expect(preservesProgramStatements(source, after)).toBe(false)
  })
})
