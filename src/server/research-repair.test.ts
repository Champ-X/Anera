import { describe, expect, it } from 'vitest'
import { canonicalDiagnosticReadForToolCalls } from './agent-service.js'
import { researchRepairCapabilities, researchRepairCallAllowed, researchRepairToolNames, withResearchRepairTools } from './research-repair.js'
import type { ToolDefinition } from './tools.js'

const input = { path: 'report.html', candidateAction: 'read_file' as const, hasContentGap: true, hasResearchDependency: true }
const upstream = ['web_search', 'web_fetch', 'fetch_page', 'record_research_brief']
const definition = (name: string): ToolDefinition => ({ type: 'function', function: { name, description: name,
  parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } }, required: ['path'] } } })
const raw = (name: string) => ({ id: name, type: 'function' as const, function: { name, arguments: '{}' } })

describe('evidence-dependent repair capability', () => {
  it.each([{ hasContentGap: false }, { hasResearchDependency: false }, { path: undefined }, { path: ' ' },
    { path: ' report.html' }, { candidateAction: undefined }])('does not expand authority without all prerequisites: %j', (missing) => {
    expect(researchRepairCapabilities({ ...input, ...missing })).toBeUndefined()
  })

  it.each(['read_file', 'edit_file'] as const)('shares a bounded %s surface between schema and execution', (candidateAction) => {
    const capability = researchRepairCapabilities({ ...input, candidateAction })!
    expect([...capability.independentObservationTools]).toEqual(['web_search', 'web_fetch', 'fetch_page'])
    expect(capability.independentObservationTools.has('record_research_brief')).toBe(false)
    const definitions = [candidateAction, ...upstream, 'write_file', 'bash', 'browser', 'present_file', 'deploy_project'].map(definition)
    const before = structuredClone(definitions)
    const projected = withResearchRepairTools(definitions, capability)
    expect(projected.map((tool) => tool.function.name)).toEqual([...researchRepairToolNames(capability)])
    expect(projected[0].function.parameters).toMatchObject({ properties: { path: { enum: ['report.html'] }, offset: { type: 'integer' } }, required: ['path'] })
    expect(definitions).toEqual(before)
    for (const tool of definitions) expect(researchRepairCallAllowed(capability, { name: tool.function.name, arguments: { path: input.path } }))
      .toBe(projected.some((item) => item.function.name === tool.function.name))
    for (const path of ['other.html', '/report.html', '../report.html', undefined]) {
      expect(researchRepairCallAllowed(capability, { name: candidateAction, arguments: { path } })).toBe(false)
    }
    expect(researchRepairCallAllowed(capability, { name: candidateAction === 'read_file' ? 'edit_file' : 'read_file', arguments: { path: input.path } })).toBe(false)
    expect(withResearchRepairTools([definition(candidateAction)], capability)).toHaveLength(1)
  })

  it('leaves the ordinary controller unchanged without a capability', () => {
    const definitions = [definition('bash')]
    expect(withResearchRepairTools(definitions)).toEqual(definitions)
    expect(researchRepairCallAllowed(undefined, { name: 'bash', arguments: {} })).toBe(true)
  })

  it('preserves authorized upstream batches without consuming or skipping the candidate read cursor', () => {
    const capability = researchRepairCapabilities(input)!
    const cursor = { path: input.path, offset: 7, limit: 5000 }
    for (const names of upstream.map((name) => [name]).concat([['web_search', 'fetch_page']])) {
      expect(canonicalDiagnosticReadForToolCalls(names.map(raw), cursor, undefined, capability.upstreamTools)).toBeUndefined()
      expect(canonicalDiagnosticReadForToolCalls(names.map(raw), cursor, undefined)).toEqual(cursor)
    }
    for (const names of [[], ['read_file'], ['fetch_page', 'edit_file'], ['web_search', 'bash'], ['present_file']]) {
      expect(canonicalDiagnosticReadForToolCalls(names.map(raw), cursor, undefined, capability.upstreamTools)).toEqual(cursor)
    }
  })
})
