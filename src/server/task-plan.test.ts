import { describe, expect, it } from 'vitest'
import { createTaskPlanBinding, normalizeTaskPlanBinding, taskPlanBindingMatches } from './task-plan.js'

describe('task-dependent plan provenance', () => {
  it.each(['code behavior plan', 'data selection plan', 'document outline', 'research selection'])('binds %s without domain rules', (task) => {
    const binding = createTaskPlanBinding(task, 'a'.repeat(64))
    expect(taskPlanBindingMatches(JSON.parse(JSON.stringify(binding)), task, 'a'.repeat(64))).toBe(true)
    expect(taskPlanBindingMatches(binding, task + ' revised requirements', 'a'.repeat(64))).toBe(false)
    expect(taskPlanBindingMatches(binding, task, 'b'.repeat(64))).toBe(false)
  })
  it.each([undefined, {}, { schemaVersion: 2, taskSha256: 'a'.repeat(64), planSha256: 'b'.repeat(64) },
    { schemaVersion: 1, taskSha256: 'not a hash', planSha256: 'b'.repeat(64) }])('does not upgrade missing or malformed provenance: %j', (value) => {
    expect(normalizeTaskPlanBinding(value)).toBeUndefined()
    expect(taskPlanBindingMatches(value, 'task', 'b'.repeat(64))).toBe(false)
  })
  it('requires a real bounded task and a canonical plan digest', () => {
    for (const task of ['', ' ', 'x'.repeat(64_001)]) expect(() => createTaskPlanBinding(task, 'a'.repeat(64))).toThrow()
    expect(() => createTaskPlanBinding('task', 'model says approved')).toThrow()
  })
})
