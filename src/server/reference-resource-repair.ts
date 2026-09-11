import type { ToolCallRecord } from '../shared/types.js'
import type { DurableReferenceStyleContract } from './reference-style.js'
import type { ToolDefinition } from './tools.js'
import { validateReferenceResourceReadRequest } from './reference-resources.js'
import { currentReferenceRuntimeDiagnostic, referenceRuntimeRepairInstruction, type ReferenceRuntimeDiagnostic } from './reference-runtime-diagnostics.js'

const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const workspacePath = (value: string) => value.trim().replaceAll('\\', '/').replace(/^(?:\/home\/user\/|~\/|\.\/)/u, '')

export interface ReferenceRepairCapabilities {
  canonicalPath: string
  sourceSha256: string
  candidateAction: 'read' | 'edit'
  resourceIds: readonly string[]
  runtimeDiagnostic?: ReferenceRuntimeDiagnostic
}

/** Optional immutable inputs to a concrete repair, never a new workflow phase.
 * One capability governs advertisement, argument narrowing and admission. */
export function referenceRepairCapabilities(input: {
  canonicalPath?: string
  reference?: DurableReferenceStyleContract
  invalidated?: boolean
  phase?: string
  candidateAction?: 'read' | 'edit'
  concreteReferenceOrVisualRepair: boolean
  researchOrContentBlocked: boolean
  runtimeDiagnostic?: unknown
  artifactHash?: string
}): ReferenceRepairCapabilities | undefined {
  const { reference } = input
  if (!input.canonicalPath || input.canonicalPath !== input.canonicalPath.trim()
    || !input.candidateAction || !input.concreteReferenceOrVisualRepair
    || input.researchOrContentBlocked || input.invalidated
    || !['reference_implementation', 'visual_inspection_pass'].includes(input.phase ?? '')
    || reference?.contract.strictness !== 'exact' || !reference.templateCatalog
    || !sha256(reference.provenance.evidenceSha256)
    || reference.templateCatalog.sourceSha256 !== reference.provenance.evidenceSha256) return undefined
  const resourceIds = ['template']
  for (let index = 0; index < reference.templateCatalog.dependencies.length; index += 1) {
    resourceIds.push(`runtime/${index}`, `runtime-loader/${index}`)
  }
  const runtimeDiagnostic = input.artifactHash && reference.runtimeEvidence
    && reference.runtimeEvidence.sourceEvidenceSha256 === reference.provenance.evidenceSha256
    && reference.runtimeEvidence.dependencies.length === reference.templateCatalog.dependencies.length
    && reference.runtimeEvidence.dependencies.every((dependency, index) => dependency.url === reference.templateCatalog!.dependencies[index])
    ? currentReferenceRuntimeDiagnostic(input.runtimeDiagnostic, {
      sourceSha256: reference.provenance.evidenceSha256, artifactHash: input.artifactHash,
      manifestSha256: reference.runtimeEvidence.manifestSha256,
      dependencyHashes: reference.runtimeEvidence.dependencies.map((dependency) => dependency.sha256),
    }) : undefined
  return { canonicalPath: workspacePath(input.canonicalPath), sourceSha256: reference.provenance.evidenceSha256,
    candidateAction: input.candidateAction, resourceIds,
    ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}) }
}

/** Preserve the requested object even when its arguments or phase are invalid. */
export function referenceResourceReadIntent(call: Pick<ToolCallRecord, 'name'>): boolean {
  return call.name === 'read_reference_resource'
}

/** Phase/source/resource authority is independent of cursor/schema validity. */
export function referenceRepairReadAuthorized(capability: ReferenceRepairCapabilities | undefined, call: Pick<ToolCallRecord, 'name' | 'arguments'>): boolean {
  if (!capability || !referenceResourceReadIntent(call)) return false
  const args = call.arguments
  return args.source_sha256 === capability.sourceSha256
    && (args.resource_id === undefined || (typeof args.resource_id === 'string' && capability.resourceIds.includes(args.resource_id)))
}

export function referenceRepairReadAllowed(capability: ReferenceRepairCapabilities | undefined, call: Pick<ToolCallRecord, 'name' | 'arguments'>): boolean {
  if (!referenceRepairReadAuthorized(capability, call)) return false
  try { validateReferenceResourceReadRequest(call.arguments) } catch { return false }
  return true
}

/** Additional admission checks, not a replacement for the executable tool
 * whitelist or the executor's current-contract/resource hash validation. */
export function referenceRepairCallAllowed(capability: ReferenceRepairCapabilities | undefined, call: Pick<ToolCallRecord, 'name' | 'arguments'>): boolean {
  // In-scope malformed reads reach the executor's strict validator and receive
  // their own error, never candidate bytes or a successful resource receipt.
  if (referenceResourceReadIntent(call)) return referenceRepairReadAuthorized(capability, call)
  if (!capability || !['read_file', 'edit_file'].includes(call.name)) return true
  return typeof call.arguments.path === 'string' && call.arguments.path === call.arguments.path.trim()
    && workspacePath(call.arguments.path) === capability.canonicalPath
}

export function withReferenceRepairTools(
  definitions: readonly ToolDefinition[], referenceReadDefinition: ToolDefinition,
  capability: ReferenceRepairCapabilities | undefined,
): ToolDefinition[] {
  const primary = definitions.filter((definition) => definition.function.name !== 'read_reference_resource')
  if (!capability) return primary
  return [...primary, referenceReadDefinition].map((definition) => {
    const name = definition.function.name
    if (!['read_file', 'edit_file', 'read_reference_resource'].includes(name)) return definition
    const parameters = definition.function.parameters
    const properties = object(parameters.properties) ? parameters.properties : {}
    const key = name === 'read_reference_resource' ? 'source_sha256' : 'path'
    const value = name === 'read_reference_resource' ? capability.sourceSha256 : capability.canonicalPath
    return { ...definition, function: { ...definition.function, parameters: { ...parameters,
      properties: { ...properties, [key]: { ...(object(properties[key]) ? properties[key] : { type: 'string' }), enum: [value] },
        ...(name === 'read_reference_resource' ? { resource_id: { ...(object(properties.resource_id) ? properties.resource_id : { type: 'string' }), enum: [...capability.resourceIds] } } : {}),
      },
    } } }
  })
}

export function referenceRepairInstruction(capability: ReferenceRepairCapabilities | undefined): string {
  if (!capability) return ''
  return ` Optional repair input: read_reference_resource with source_sha256=${JSON.stringify(capability.sourceSha256)} reads only the current immutable template/runtime resources; omit resource_id to obtain their verified manifest. It never supplies current candidate HTML bytes or passes a source/render/Vision/delivery gate. Keep the required canonical ${capability.candidateAction} step. For a referenceable runtime-loader, edit_file may use old_text plus reference_resource={source_sha256,resource_id,resource_sha256} copied from its receipt instead of new_text; do not echo the large loader. All other file paths, external fetching, and full-file writes remain unavailable.${referenceRuntimeRepairInstruction(capability.runtimeDiagnostic)}`
}

/** A small, path-free verified metadata receipt survives compaction. It is
 * explicitly not source text, a completed byte page, or candidate file bytes. */
export function referenceResourceReceipt(content: string, expectedSourceSha256?: string): Record<string, unknown> | undefined {
  let payload: unknown
  try { payload = JSON.parse(content) } catch { return undefined }
  if (!object(payload) || payload.status !== 'success' || payload.kind !== 'reference_resource' || payload.schemaVersion !== 1
    || !sha256(payload.source_sha256) || (expectedSourceSha256 !== undefined && payload.source_sha256 !== expectedSourceSha256)
    || !Array.isArray(payload.resources) || payload.resources.length > 64) return undefined
  const resources: Record<string, unknown>[] = []
  for (const descriptor of payload.resources) {
    if (!object(descriptor) || typeof descriptor.resource_id !== 'string' || !/^(?:template|runtime(?:-loader)?\/(?:0|[1-9]\d*))$/u.test(descriptor.resource_id)
      || !sha256(descriptor.resource_sha256) || typeof descriptor.media_type !== 'string' || descriptor.media_type.length > 128
      || !Number.isSafeInteger(descriptor.total_bytes) || Number(descriptor.total_bytes) < 0
      || typeof descriptor.source_url !== 'string' || descriptor.source_url.length > 4_096
      || typeof descriptor.referenceable !== 'boolean') return undefined
    const copy: Record<string, unknown> = { resource_id: descriptor.resource_id, resource_sha256: descriptor.resource_sha256,
      media_type: descriptor.media_type, total_bytes: descriptor.total_bytes, source_url: descriptor.source_url, referenceable: descriptor.referenceable }
    for (const key of ['runtime_manifest_sha256', 'dependency_sha256']) {
      if (descriptor[key] !== undefined) { if (!sha256(descriptor[key])) return undefined; copy[key] = descriptor[key] }
    }
    if (descriptor.materializer_version !== undefined) {
      if (typeof descriptor.materializer_version !== 'string' || descriptor.materializer_version.length > 128) return undefined
      copy.materializer_version = descriptor.materializer_version
    }
    resources.push(copy)
  }
  if (new Set(resources.map((resource) => resource.resource_id)).size !== resources.length) return undefined
  return { status: 'success', kind: 'reference_resource', schemaVersion: 1, source_sha256: payload.source_sha256,
    resources, reference_resource_receipt_only: true }
}
