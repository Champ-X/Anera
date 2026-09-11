import { describe, expect, it } from 'vitest'
import { assertStructuredResponse, structuredResponseInstruction } from './structured-response-contract.js'

const contract = { name: 'test-v1', fields: { records: 'array', assessment: 'object', note: 'string' } } as const
const valid = { records: [], assessment: {}, note: '' }

describe('closed structured response envelope', () => {
  it('derives prompt and validation from the same required fields without inventing a verdict', () => {
    const schema = JSON.parse(structuredResponseInstruction(contract).split('\n').at(-1)!)
    expect(schema).toEqual({ type: 'object', required: ['records', 'assessment', 'note'], additionalProperties: false,
      properties: { records: { type: 'array' }, assessment: { type: 'object' }, note: { type: 'string' } } })
    expect(() => assertStructuredResponse(contract, valid)).not.toThrow()
  })
  it.each([
    [{ records: [], note: '' }, 'assessment required (missing)'],
    [{ ...valid, records: {} }, 'records must be array; received object'],
    [{ ...valid, assessment: null }, 'assessment must be object; received null'],
    [{ ...valid, assessment: [] }, 'assessment must be object; received array'],
    [{ ...valid, PRIVATE_KEY: 'PRIVATE_VALUE' }, 'unexpected top-level fields: 1'],
    [null, 'top-level object required; received null'],
    [[], 'top-level object required; received array'],
  ])('rejects the shape without logging source-controlled data: %j', (value, diagnostic) => {
    expect(() => assertStructuredResponse(contract, value)).toThrow(diagnostic)
    try { assertStructuredResponse(contract, value) } catch (error) { expect(String(error)).not.toContain('PRIVATE_') }
  })
  it('requires own fields and reports all shape defects without altering the payload', () => {
    const value = Object.assign(Object.create({ assessment: {} }), { records: [], note: '', secret: 'PRIVATE_VALUE' })
    expect(() => assertStructuredResponse(contract, value)).toThrow('assessment required (missing); unexpected top-level fields: 1')
    expect(Object.hasOwn(value, 'assessment')).toBe(false)
  })
})
