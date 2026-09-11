import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ModelMessage, ToolCallRecord } from '../shared/types.js'
import {
  canonicalArtifactDiagnosticReadRequired, canonicalDiagnosticReadCursor, canonicalDiagnosticReadForToolCalls,
  compactHistoricalToolPayloads, referenceStyleArtifactRepairPhase, repairVisualWebArtifactPhaseToolCalls, visualWebArtifactCompletionGap,
  visualWebArtifactRequiredToolNames, visualWorkflowCompactionAnchors,
} from './agent-service.js'
import { ANERA_RUNTIME_AGENT_TOOL_DEFINITIONS, EXTENSION_TOOL_DEFINITIONS } from './tools.js'
import { referenceTemplateCatalog, referenceTemplateRuntimeEvidence } from './reference-template.js'
import { latestSuccessfulReferenceStyleContract, normalizeReferenceStyleContract, type DurableReferenceStyleContract } from './reference-style.js'
import { buildReferenceResourceSet, readReferenceResource, REFERENCE_RESOURCE_MAX_PAGE_BYTES } from './reference-resources.js'
import {
  referenceRepairCapabilities, referenceRepairReadAllowed, referenceRepairReadAuthorized, referenceRepairCallAllowed,
  referenceResourceReceipt, withReferenceRepairTools,
  referenceRepairInstruction,
} from './reference-resource-repair.js'
import { inspectReferenceRuntime } from './reference-runtime-diagnostics.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const sourceUrl = 'https://reference.example/workshop/template.html'
const source = '<!doctype html><html><head><title>Workshop</title><style>.slide{background:#112233;color:#eeeeee}.headline{font:900 96px Georgia}</style></head><body><deck-stage><section class="slide cover"><h1 class="headline">Welcome</h1></section><section class="slide agenda"><p>Requirements</p></section><section class="slide closing"><h1>Next steps</h1></section></deck-stage><script src="runtime.js"></script></body></html>'
const script = 'customElements.define("deck-stage", class extends HTMLElement {});'
const dependency = { url: new URL('runtime.js', sourceUrl).toString(), content: script, sha256: digest(script), bytes: Buffer.byteLength(script) }
const catalog = referenceTemplateCatalog(source, sourceUrl)
const runtime = referenceTemplateRuntimeEvidence(catalog.sourceSha256, sourceUrl, [dependency])
const contractArgs = { source_url: sourceUrl, strictness: 'exact', colors: ['#112233', '#eeeeee'], fonts: ['Georgia'],
  layout: ['full viewport', 'separate pages'], components: ['slide', 'headline'], required_markers: ['.slide', '.headline'],
  signature: 'Workshop deck', avoid: ['invented palette'], viewport: { width: 1000, height: 600 } }
const reference: DurableReferenceStyleContract = { contract: normalizeReferenceStyleContract(contractArgs),
  provenance: { resolvedUrl: sourceUrl, evidenceSha256: catalog.sourceSha256, evidenceBytes: Buffer.byteLength(source) },
  templateCatalog: catalog, runtimeEvidence: runtime }
const resources = buildReferenceResourceSet({ source, sourceUrl, sourceSha256: catalog.sourceSha256,
  dependencies: [dependency], manifestSha256: runtime.manifestSha256 })
const manifest = readReferenceResource(resources, { source_sha256: catalog.sourceSha256 })
const readDefinition = EXTENSION_TOOL_DEFINITIONS.read_reference_resource
const fileDefinition = (name: string) => ANERA_RUNTIME_AGENT_TOOL_DEFINITIONS.find((item) => item.function.name === name)!
const capability = (candidateAction: 'read' | 'edit' = 'read') => referenceRepairCapabilities({
  canonicalPath: 'workshop.html', reference, phase: 'reference_implementation', candidateAction,
  concreteReferenceOrVisualRepair: true, researchOrContentBlocked: false,
})!
const rawCall = (name: string, args: Record<string, unknown>, id = name): NonNullable<ModelMessage['tool_calls']>[number] => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
})
const call = (name: string, args: Record<string, unknown>): ToolCallRecord => ({ id: name, name, arguments: args })
function occurrence(name: string, args: Record<string, unknown>, result: unknown, id = name, failed = false): ModelMessage[] {
  return [{ role: 'assistant', content: null, tool_calls: [rawCall(name, args, id)] },
    { role: 'tool', tool_call_id: id, tool_result_status: failed ? 'failed' : 'succeeded', content: JSON.stringify(result) }]
}
const record = () => occurrence('record_reference_style', contractArgs, { status: 'success', contract: contractArgs,
  provenance: reference.provenance, composition_template: catalog, runtime_evidence: runtime })
const initial = (): ModelMessage[] => [
  { role: 'user', content: `Create HTML Slides for a workshop agenda, strictly matching ${sourceUrl}.` },
  ...record(), ...occurrence('write_file', { path: 'workshop.html', content: source }, { status: 'success', hash: digest(source) }),
  ...occurrence('verify_reference_style', { path: 'workshop.html' }, { status: 'success', fidelity: 'mismatch', missing: { fonts: ['Georgia'] } }),
]
const readReference = () => occurrence('read_reference_resource', { source_sha256: catalog.sourceSha256 }, manifest)
const readCandidate = () => occurrence('read_file', { path: 'workshop.html', offset: 1, limit: 5000 }, {
  status: 'success', kind: 'text', path: 'workshop.html', offset: 1, content: source, hasMore: false,
})

describe('reference-resource repair capability (local, non-news fixtures)', () => {
  it('projects only current hash-bound runtime diagnostics without changing the tool surface', () => {
    const runtimeDiagnostic = inspectReferenceRuntime(source, resources)
    const args = { canonicalPath: 'workshop.html', reference, phase: 'visual_inspection_pass', candidateAction: 'edit' as const,
      concreteReferenceOrVisualRepair: true, researchOrContentBlocked: false, runtimeDiagnostic,
      artifactHash: runtimeDiagnostic.artifact_hash }
    const cap = referenceRepairCapabilities(args)!
    expect(referenceRepairInstruction(cap)).toContain('Current candidate runtime diagnosis')
    expect(withReferenceRepairTools([fileDefinition('edit_file')], readDefinition, cap).map((item) => item.function.name))
      .toEqual(['edit_file', 'read_reference_resource'])
    for (const patch of [{ artifactHash: 'x'.repeat(43) }, { artifactHash: undefined },
      { runtimeDiagnostic: { ...runtimeDiagnostic, source_sha256: 'a'.repeat(64) } },
      { reference: { ...reference, runtimeEvidence: { ...runtime, sourceEvidenceSha256: 'a'.repeat(64) } } },
      { reference: { ...reference, templateCatalog: { ...catalog, dependencies: ['https://reference.example/other.js'] } } },
    ]) {
      expect(referenceRepairInstruction(referenceRepairCapabilities({ ...args, ...patch }))).not.toContain('Current candidate runtime diagnosis')
    }
    expect(referenceRepairCapabilities({ ...args, invalidated: true })).toBeUndefined()
    expect(referenceRepairCapabilities({ ...args, researchOrContentBlocked: true })).toBeUndefined()
  })

  it('offers the same bounded auxiliary read in candidate read and edit lanes', () => {
    for (const action of ['read', 'edit'] as const) {
      const primary = fileDefinition(action === 'read' ? 'read_file' : 'edit_file')
      const definitions = withReferenceRepairTools([primary], readDefinition, capability(action))
      expect(definitions.map((item) => item.function.name)).toEqual([primary.function.name, 'read_reference_resource'])
      expect(definitions[0].function.parameters.properties).toMatchObject({ path: { enum: ['workshop.html'] } })
      expect(definitions[1].function.parameters.properties).toMatchObject({ source_sha256: { enum: [catalog.sourceSha256] },
        resource_id: { enum: ['template', 'runtime/0', 'runtime-loader/0'] } })
      expect(referenceRepairReadAllowed(capability(action), call('read_reference_resource', { source_sha256: catalog.sourceSha256 }))).toBe(true)
    }
  })

  it('requires a current exact catalog and a concrete reference/visual repair', () => {
    const valid = { canonicalPath: 'workshop.html', reference, phase: 'reference_implementation', candidateAction: 'read' as const,
      concreteReferenceOrVisualRepair: true, researchOrContentBlocked: false }
    for (const patch of [
      { invalidated: true }, { researchOrContentBlocked: true }, { concreteReferenceOrVisualRepair: false },
      { canonicalPath: undefined }, { canonicalPath: ' workshop.html' }, { canonicalPath: 'workshop.html ' },
      { candidateAction: undefined }, { reference: undefined },
      { reference: { ...reference, templateCatalog: undefined } },
      { reference: { ...reference, contract: { ...reference.contract, strictness: 'inspired' as const } } },
      { reference: { ...reference, provenance: { ...reference.provenance, evidenceSha256: 'a'.repeat(64) } } },
    ]) expect(referenceRepairCapabilities({ ...valid, ...patch })).toBeUndefined()
    expect(referenceRepairCapabilities({ ...valid, phase: 'visual_inspection_pass' })).toBeDefined()
  })

  it('never adds auxiliary reads in research, preview, verification, presentation or Final', () => {
    for (const phase of ['web_research', 'website_preview', 'reference_source_check', 'reference_cover_inspection', 'visual_inspection', 'reference_closing_inspection', 'present_file', undefined]) {
      const cap = referenceRepairCapabilities({ canonicalPath: 'workshop.html', reference, phase, candidateAction: 'edit',
        concreteReferenceOrVisualRepair: true, researchOrContentBlocked: false })
      expect(cap).toBeUndefined()
      expect(withReferenceRepairTools([readDefinition], readDefinition, cap)).toEqual([])
      expect(referenceRepairCallAllowed(cap, call('read_reference_resource', { source_sha256: catalog.sourceSha256 }))).toBe(false)
    }
    expect([...visualWebArtifactRequiredToolNames({ missingPhases: ['present_file'] })!]).toEqual(['present_file'])
    expect([...visualWebArtifactRequiredToolNames({ missingPhases: ['reference_source_check'] })!]).toEqual(['verify_reference_style'])
  })

  it('shares strict source/cursor admission without accepting arbitrary paths or sibling resources', () => {
    const valid = { source_sha256: catalog.sourceSha256, resource_id: 'runtime/0' }
    for (const args of [
      { ...valid, source_sha256: 'a'.repeat(64) }, { ...valid, path: 'other.html' }, { ...valid, url: sourceUrl },
      { ...valid, resource_id: 'runtime/1' }, { ...valid, resource_id: '../runtime.js' },
      { ...valid, max_bytes: 3 }, { ...valid, max_bytes: REFERENCE_RESOURCE_MAX_PAGE_BYTES + 1 },
      { ...valid, byte_offset: 1 }, { ...valid, resource_sha256: 'bad' },
      { source_sha256: catalog.sourceSha256, byte_offset: 0 },
    ]) expect(referenceRepairReadAllowed(capability(), call('read_reference_resource', args))).toBe(false)
    expect(referenceRepairReadAllowed(capability(), call('read_reference_resource', {
      ...valid, byte_offset: 4, resource_sha256: dependency.sha256,
    }))).toBe(true)
    for (const name of ['read_file', 'edit_file']) {
      for (const path of ['workshop.html', '/home/user/workshop.html', '~/workshop.html', './workshop.html']) {
        expect(referenceRepairCallAllowed(capability(), call(name, { path }))).toBe(true)
      }
      expect(referenceRepairCallAllowed(capability(), call(name, { path: 'other.html' }))).toBe(false)
      for (const path of [' workshop.html', 'workshop.html ', ' /home/user/workshop.html', './workshop.html\n']) {
        expect(referenceRepairCallAllowed(capability(), call(name, { path }))).toBe(false)
      }
    }
  })

  it('keeps a single reference read intent intact for separate authorization and validation', () => {
    const cursor = { path: 'workshop.html', offset: 1, limit: 5000 }
    const refCall = rawCall('read_reference_resource', { source_sha256: catalog.sourceSha256 })
    expect(canonicalDiagnosticReadForToolCalls([refCall], cursor, undefined)).toBeUndefined()
    expect(canonicalDiagnosticReadForToolCalls([rawCall('read_reference_resource', { source_sha256: 'a'.repeat(64) })], cursor, undefined)).toBeUndefined()
    const badCursor = rawCall('read_reference_resource', { source_sha256: catalog.sourceSha256, resource_id: 'template', byte_offset: 8192, max_bytes: 20000 })
    expect(canonicalDiagnosticReadForToolCalls([badCursor], cursor, undefined)).toBeUndefined()
    expect(canonicalDiagnosticReadForToolCalls([badCursor], undefined, cursor)).toBeUndefined()
    expect(canonicalDiagnosticReadForToolCalls([rawCall('read_file', { path: 'other.html' })], cursor, undefined)).toEqual(cursor)
    expect(canonicalDiagnosticReadForToolCalls([refCall, rawCall('edit_file', { path: 'other.html' })], cursor, undefined)).toEqual(cursor)
  })

  it('admits in-scope invalid arguments only to strict validation, not as valid resource reads', () => {
    const invalid = call('read_reference_resource', { source_sha256: catalog.sourceSha256,
      resource_id: 'template', byte_offset: 8192, max_bytes: 20000 })
    expect(referenceRepairReadAuthorized(capability(), invalid)).toBe(true)
    expect(referenceRepairCallAllowed(capability(), invalid)).toBe(true)
    expect(referenceRepairReadAllowed(capability(), invalid)).toBe(false)
    expect(referenceRepairReadAuthorized(undefined, invalid)).toBe(false)
    for (const patch of [{ source_sha256: 'a'.repeat(64) }, { resource_id: 'runtime/1' }]) {
      expect(referenceRepairCallAllowed(capability(), { ...invalid, arguments: { ...invalid.arguments, ...patch } })).toBe(false)
    }
  })

  it('never rewrites resource intent into another tool in later visual-phase normalization', () => {
    const requested = rawCall('read_reference_resource', { source_sha256: catalog.sourceSha256,
      resource_id: 'template', byte_offset: 8192, max_bytes: 20000 })
    for (const phase of ['web_research', 'reference_acquisition', 'reference_contract', 'html_artifact',
      'reference_source_check', 'reference_implementation', 'website_preview', 'browser_open',
      'reference_cover_screenshot', 'reference_cover_inspection', 'navigation_check', 'browser_screenshot',
      'visual_inspection', 'visual_inspection_pass', 'reference_closing_navigation',
      'reference_closing_screenshot', 'reference_closing_inspection', 'present_file', undefined] as const) {
      expect(repairVisualWebArtifactPhaseToolCalls([requested], phase, 'workshop.html', reference))
        .toEqual({ toolCalls: [requested], repairs: [] })
    }
  })

  it('reference manifest and source pages never satisfy candidate raw-read or final gates', () => {
    const before = initial()
    const withReference = [...before, ...readReference(), ...occurrence('read_reference_resource', {
      source_sha256: catalog.sourceSha256, resource_id: 'template',
    }, readReferenceResource(resources, { source_sha256: catalog.sourceSha256, resource_id: 'template' }), 'source-page')]
    expect(referenceStyleArtifactRepairPhase(withReference, 'workshop.html')).toBe('read')
    expect(canonicalDiagnosticReadCursor(withReference, 'workshop.html')).toEqual({ path: 'workshop.html', offset: 1, limit: 5000 })
    expect(visualWebArtifactCompletionGap(withReference, { forceTask: true, canonicalPath: 'workshop.html' })?.missingPhases)
      .toEqual(visualWebArtifactCompletionGap(before, { forceTask: true, canonicalPath: 'workshop.html' })?.missingPhases)
    const candidateRead = [...withReference, ...readCandidate()]
    expect(referenceStyleArtifactRepairPhase(candidateRead, 'workshop.html')).toBe('edit')
    expect(referenceStyleArtifactRepairPhase([...candidateRead, ...readReference()], 'workshop.html')).toBe('edit')
    expect(referenceStyleArtifactRepairPhase([...candidateRead, ...occurrence('edit_file', {
      path: 'workshop.html', old_text: '<script src="runtime.js"></script>',
      reference_resource: { source_sha256: catalog.sourceSha256, resource_id: 'runtime-loader/0', resource_sha256: resources.resources[2].resource_sha256 },
    }, { status: 'success', hash: 'new-candidate-hash' })], 'workshop.html')).toBeUndefined()
  })

  it('resource retrieval errors do not reopen candidate reading, but ordinary context misses do', () => {
    const before = [...initial(), ...readCandidate()]
    const args = { path: 'workshop.html', old_text: '<script></script>', reference_resource: {
      source_sha256: catalog.sourceSha256, resource_id: 'runtime-loader/0', resource_sha256: resources.resources[2].resource_sha256,
    } }
    expect(canonicalArtifactDiagnosticReadRequired([...before, ...occurrence('edit_file', args, {
      status: 'error', message: 'Reference resources are missing or stale. Use read_reference_resource; no artifact was changed.',
    }, 'missing-resource', true)], 'workshop.html')).toBe(false)
    expect(canonicalArtifactDiagnosticReadRequired([...before, ...occurrence('edit_file', args, {
      status: 'error', message: 'Context not found: reference replacement requires literal old_text. Read the canonical file again. No edit was applied',
    }, 'missing-candidate', true)], 'workshop.html')).toBe(true)
    expect(canonicalArtifactDiagnosticReadRequired([...before, ...occurrence('edit_file', args, {
      status: 'error', message: 'Context not found: reference replacement old_text is not unique. Read the canonical file and provide unique literal bytes. No edit was applied.',
    }, 'ambiguous-candidate', true)], 'workshop.html')).toBe(true)
  })

  it('compacts consumed large resource pages to hash receipts without fabricating completed bytes', () => {
    const page = { ...manifest, resource: resources.resources[2], content: 'opaque-loader-data'.repeat(2500),
      start_byte: 0, end_byte: 32768, returned_bytes: 32768, has_more: true }
    const messages = [...initial(), ...occurrence('read_reference_resource', { source_sha256: catalog.sourceSha256,
      resource_id: 'runtime-loader/0' }, page), { role: 'assistant' as const, content: 'Now read the candidate target.' }]
    const unread = compactHistoricalToolPayloads(messages.slice(0, -1), { forceResultCompaction: true, canonicalPath: 'workshop.html' })
    expect(JSON.parse(unread.messages.at(-1)!.content!)).toEqual(page)
    const compacted = compactHistoricalToolPayloads(messages, { forceResultCompaction: true, canonicalPath: 'workshop.html' })
    const result = compacted.messages.find((message) => message.tool_call_id === 'read_reference_resource')!
    const receipt = JSON.parse(result.content!)
    expect(receipt).toMatchObject({ reference_resource_receipt_only: true, source_sha256: catalog.sourceSha256, resources: manifest.resources })
    for (const key of ['content', 'has_more', 'hasMore', 'complete', 'end_byte', 'next_cursor']) expect(receipt).not.toHaveProperty(key)
    expect(Buffer.byteLength(result.content!)).toBeLessThan(3000)
    expect(referenceStyleArtifactRepairPhase(compacted.messages, 'workshop.html')).toBe('read')
    expect(visualWorkflowCompactionAnchors(compacted.messages, 'workshop.html', true).has(result)).toBe(true)
    expect(referenceResourceReceipt(result.content!, 'a'.repeat(64))).toBeUndefined()
    expect(compactHistoricalToolPayloads(compacted.messages, { forceResultCompaction: true, canonicalPath: 'workshop.html' }).changed).toBe(false)
  })

  it('keeps referenced replacement identity in compacted edit arguments without expanding bytes', () => {
    const binding = { source_sha256: catalog.sourceSha256, resource_id: 'runtime-loader/0', resource_sha256: resources.resources[2].resource_sha256 }
    const messages = [...initial(), ...occurrence('edit_file', { path: 'workshop.html', old_text: 'x'.repeat(9000), reference_resource: binding },
      { status: 'success', hash: 'new-hash' }), { role: 'assistant' as const, content: 'Verify the candidate.' }]
    const compacted = compactHistoricalToolPayloads(messages, { forceResultCompaction: true, canonicalPath: 'workshop.html' })
    const edit = compacted.messages.flatMap((message) => message.tool_calls ?? []).find((item) => item.function.name === 'edit_file')!
    expect(JSON.parse(edit.function.arguments)).toMatchObject({ path: 'workshop.html', reference_resource: binding,
      _historicalMutation: { schema: 'reference_resource', priorTextSha256: digest('x'.repeat(9000)) } })
    expect(edit.function.arguments.length).toBeLessThan(1000)
  })

  it('does not pin a resource receipt as evidence for a later source identity', () => {
    const newerHash = 'a'.repeat(64)
    const messages = [...initial(), ...readReference(), ...occurrence('record_reference_style', contractArgs, {
      status: 'success', contract: contractArgs, provenance: { ...reference.provenance, evidenceSha256: newerHash },
    }, 'new-contract')]
    expect(latestSuccessfulReferenceStyleContract(messages)?.provenance.evidenceSha256).toBe(newerHash)
    const result = messages.find((message) => message.tool_call_id === 'read_reference_resource')!
    expect(visualWorkflowCompactionAnchors(messages, 'workshop.html', true).has(result)).toBe(false)
  })
})
