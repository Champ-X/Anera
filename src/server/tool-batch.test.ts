import { describe, expect, it } from 'vitest'
import { admitToolBatch } from './tool-batch.js'

const call = (id: string, name = 'observe', args = JSON.stringify({ id })) => ({ id, type: 'function' as const,
  function: { name, arguments: args } })
const policy = { maximumCalls: 1, independent: { toolNames: new Set(['observe', 'inspect']), maximumCalls: 3 } }

describe('capability-owned batch scheduling', () => {
  it('keeps distinct observations in one bounded response with original identities', () => {
    const calls = [call('a'), call('b', 'inspect'), call('c'), call('d')]
    const before = structuredClone(calls)
    const result = admitToolBatch(calls, policy)
    expect(result).toEqual({ calls: calls.slice(0, 3), maximumCalls: 3, droppedCallIds: ['d'] })
    expect(result.calls[0]).toBe(calls[0])
    expect(calls).toEqual(before)
  })
  it('does not let duplicate observations consume distinct slots', () => {
    const calls = [call('a'), call('duplicate', 'observe', callsArgs('a')), call('b'), call('c')]
    expect(admitToolBatch(calls, policy).calls.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })
  it.each(['commit', 'write', 'unknown'])('retains the ordered boundary for mixed %s batches', (name) => {
    expect(admitToolBatch([call('a'), call('b', name)], policy).maximumCalls).toBe(1)
    expect(admitToolBatch([call('a', name), call('b')], policy).calls.map((entry) => entry.id)).toEqual(['a'])
  })
  it('preserves caller limits without an independent capability and handles an empty response', () => {
    expect(admitToolBatch([call('a'), call('b')], { maximumCalls: 1 }).calls).toHaveLength(1)
    expect(admitToolBatch([], policy)).toEqual({ calls: [], maximumCalls: 1, droppedCallIds: [] })
  })
  it('rejects invalid limits instead of creating an unbounded batch', () => {
    for (const maximumCalls of [0, -1, 1.5, Infinity]) {
      expect(() => admitToolBatch([], { maximumCalls })).toThrow()
      expect(() => admitToolBatch([], { ...policy, independent: { ...policy.independent, maximumCalls } })).toThrow()
    }
  })
})
function callsArgs(id: string) { return JSON.stringify({ id }) }
