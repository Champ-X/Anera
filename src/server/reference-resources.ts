import { createHash } from 'node:crypto'
import {
  assertReferenceTemplateDependency, materializeReferenceRuntimeLoader,
  referenceTemplateCatalog, referenceTemplateRuntimeEvidence, REFERENCE_RUNTIME_MATERIALIZER_VERSION,
  REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES, type ReferenceTemplateDependency,
} from './reference-template.js'

const SHA256 = /^[a-f0-9]{64}$/u
export const REFERENCE_RESOURCE_PAGE_BYTES = 8 * 1024
export const REFERENCE_RESOURCE_MIN_PAGE_BYTES = 4
export const REFERENCE_RESOURCE_MAX_PAGE_BYTES = 32 * 1024

export interface ReferenceResourceBinding {
  source_sha256: string
  resource_id: string
  resource_sha256: string
}

export interface ReferenceResourceReadRequest {
  source_sha256: string
  resource_id?: string
  resource_sha256?: string
  byte_offset?: number
  max_bytes?: number
}

export interface ReferenceResourceDescriptor {
  resource_id: string
  resource_sha256: string
  media_type: 'text/html' | 'text/javascript'
  total_bytes: number
  source_url: string
  referenceable: boolean
  runtime_manifest_sha256?: string
  dependency_sha256?: string
  materializer_version?: string
}

export interface ReferenceResourceSet {
  readonly sourceSha256: string
  readonly resources: readonly ReferenceResourceDescriptor[]
  readonly contents: ReadonlyMap<string, string>
}

export interface ReferenceResourceReadResult {
  status: 'success'
  kind: 'reference_resource'
  schemaVersion: 1
  source_sha256: string
  resources: ReferenceResourceDescriptor[]
  resource?: ReferenceResourceDescriptor
  content?: string
  start_byte?: number
  end_byte?: number
  returned_bytes?: number
  has_more?: boolean
  next_cursor?: ReferenceResourceReadRequest
}

const digest = (content: string) => createHash('sha256').update(content).digest('hex')
const isObject = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

function assertKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('Invalid reference resource fields; no mutation was applied')
  }
}

/** Shared by phase admission and execution: never strip misspelled fields. */
export function validateReferenceResourceReadRequest(value: unknown): asserts value is ReferenceResourceReadRequest {
  assertKeys(value, ['source_sha256', 'resource_id', 'resource_sha256', 'byte_offset', 'max_bytes'])
  if (typeof value.source_sha256 !== 'string' || !SHA256.test(value.source_sha256)) throw new Error('Reference resource requires source_sha256')
  if (value.resource_id === undefined) {
    if (Object.keys(value).some((key) => key !== 'source_sha256')) throw new Error('Reference resource directory requests cannot include a content cursor')
    return
  }
  if (typeof value.resource_id !== 'string' || !/^(?:template|runtime(?:-loader)?\/(?:0|[1-9]\d{0,2}))$/u.test(value.resource_id)) {
    throw new Error('Invalid reference resource ID; use the current directory, not a path or URL')
  }
  if (value.resource_sha256 !== undefined && (typeof value.resource_sha256 !== 'string' || !SHA256.test(value.resource_sha256))) {
    throw new Error('Reference resource requires a valid resource_sha256')
  }
  if (value.byte_offset !== undefined && (!Number.isSafeInteger(value.byte_offset) || (value.byte_offset as number) < 0)) {
    throw new Error('Invalid reference resource byte cursor')
  }
  if (value.byte_offset !== undefined && (value.byte_offset as number) > 0 && value.resource_sha256 === undefined) {
    throw new Error('Reference resource continuation requires its current resource_sha256; copy every field from the previous next_cursor exactly, including source_sha256, resource_id, resource_sha256, byte_offset and max_bytes')
  }
  if (value.max_bytes !== undefined && (!Number.isSafeInteger(value.max_bytes)
    || (value.max_bytes as number) < REFERENCE_RESOURCE_MIN_PAGE_BYTES || (value.max_bytes as number) > REFERENCE_RESOURCE_MAX_PAGE_BYTES)) {
    throw new Error('Invalid reference resource page size (4–32768 bytes)')
  }
}

/** No filesystem or network I/O. The caller resolves these bytes from the
 * current session's private, validated evidence. This layer rechecks content
 * identity and source-declared dependency order, not the caller's summaries.
 */
export function buildReferenceResourceSet(input: {
  source: string
  sourceUrl: string
  sourceSha256: string
  dependencies: ReferenceTemplateDependency[]
  manifestSha256?: string
}): ReferenceResourceSet {
  if (!SHA256.test(input.sourceSha256) || digest(input.source) !== input.sourceSha256) {
    throw new Error('Reference source identity is stale; read_reference_resource with the current source_sha256')
  }
  const catalog = referenceTemplateCatalog(input.source, input.sourceUrl)
  if (catalog.sourceSha256 !== input.sourceSha256
    || JSON.stringify(catalog.dependencies) !== JSON.stringify(input.dependencies.map(({ url }) => url))) {
    throw new Error('Reference runtime resources do not match the source-declared dependency order')
  }
  const runtime = buildReferenceRuntimeResourceSet(input)
  if (Buffer.byteLength(input.source) > REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES) throw new Error('Reference resource exceeds the bounded output size')
  return { sourceSha256: input.sourceSha256,
    resources: [{ resource_id: 'template', source_url: input.sourceUrl, media_type: 'text/html', referenceable: false,
      resource_sha256: input.sourceSha256, total_bytes: Buffer.byteLength(input.source) }, ...runtime.resources],
    contents: new Map([['template', input.source], ...runtime.contents]) }
}

/** Runtime-only consumers need the same verified native/loader bytes without
 * rehydrating an unrelated template body or manufacturing a resource receipt. */
export function buildReferenceRuntimeResourceSet(input: {
  sourceSha256: string; sourceUrl: string; dependencies: ReferenceTemplateDependency[]; manifestSha256?: string
}): ReferenceResourceSet {
  if (!SHA256.test(input.sourceSha256) || (input.dependencies.length
    && (!input.manifestSha256 || !SHA256.test(input.manifestSha256)
      || referenceTemplateRuntimeEvidence(input.sourceSha256, input.sourceUrl, input.dependencies).manifestSha256 !== input.manifestSha256))) {
    throw new Error('Reference runtime manifest is missing or invalid')
  }
  const resources: ReferenceResourceDescriptor[] = []
  const contents = new Map<string, string>()
  const add = (resource: Omit<ReferenceResourceDescriptor, 'resource_sha256' | 'total_bytes'>, content: string) => {
    const bytes = Buffer.byteLength(content)
    if (bytes > REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES) throw new Error('Reference resource exceeds the bounded output size')
    resources.push({ ...resource, resource_sha256: digest(content), total_bytes: bytes })
    contents.set(resource.resource_id, content)
  }
  input.dependencies.forEach((dependency, index) => {
    assertReferenceTemplateDependency(dependency)
    const provenance = { source_url: dependency.url, runtime_manifest_sha256: input.manifestSha256!, dependency_sha256: dependency.sha256 }
    add({ ...provenance, resource_id: `runtime/${index}`, media_type: 'text/javascript', referenceable: false }, dependency.content)
    add({ ...provenance, resource_id: `runtime-loader/${index}`, media_type: 'text/html', referenceable: true,
      materializer_version: REFERENCE_RUNTIME_MATERIALIZER_VERSION }, materializeReferenceRuntimeLoader(dependency))
  })
  return { sourceSha256: input.sourceSha256, resources, contents }
}

function resolveResource(set: ReferenceResourceSet, id: unknown) {
  const descriptor = set.resources.find((resource) => resource.resource_id === id)
  const content = typeof id === 'string' ? set.contents.get(id) : undefined
  if (!descriptor || content === undefined) throw new Error('Unknown reference resource; read_reference_resource for the current resource directory')
  if (digest(content) !== descriptor.resource_sha256 || Buffer.byteLength(content) !== descriptor.total_bytes) {
    throw new Error('Reference resource bytes are stale; read_reference_resource again')
  }
  return { descriptor, content }
}

export function readReferenceResource(set: ReferenceResourceSet, request: ReferenceResourceReadRequest): ReferenceResourceReadResult {
  validateReferenceResourceReadRequest(request)
  if (request.source_sha256 !== set.sourceSha256) throw new Error('Reference source identity changed; read_reference_resource with the current source_sha256')
  const result: ReferenceResourceReadResult = { status: 'success', kind: 'reference_resource', schemaVersion: 1,
    source_sha256: set.sourceSha256, resources: structuredClone([...set.resources]) }
  if (request.resource_id === undefined) {
    return result
  }
  const { descriptor, content } = resolveResource(set, request.resource_id)
  if (request.resource_sha256 !== undefined && request.resource_sha256 !== descriptor.resource_sha256) {
    throw new Error('Reference resource identity changed; read_reference_resource for a new cursor')
  }
  const start = request.byte_offset ?? 0
  const limit = request.max_bytes ?? REFERENCE_RESOURCE_PAGE_BYTES
  if (!Number.isSafeInteger(start) || start < 0 || start > descriptor.total_bytes
    || !Number.isSafeInteger(limit) || limit < REFERENCE_RESOURCE_MIN_PAGE_BYTES || limit > REFERENCE_RESOURCE_MAX_PAGE_BYTES) {
    throw new Error('Invalid reference resource byte cursor or page size (4–32768 bytes)')
  }
  if (start > 0 && request.resource_sha256 !== descriptor.resource_sha256) {
    throw new Error('Reference resource continuation requires its current resource_sha256; copy every field from the previous next_cursor exactly, including source_sha256, resource_id, resource_sha256, byte_offset and max_bytes')
  }
  const bytes = Buffer.from(content)
  const continuationByte = (index: number) => (bytes[index] & 0xc0) === 0x80
  if (start < bytes.length && continuationByte(start)) throw new Error('Reference resource cursor splits a UTF-8 character')
  let end = Math.min(start + limit, bytes.length)
  while (end < bytes.length && continuationByte(end)) end -= 1
  const hasMore = end < bytes.length
  return { ...result, resource: structuredClone(descriptor), content: bytes.subarray(start, end).toString('utf8'),
    start_byte: start, end_byte: end, returned_bytes: end - start, has_more: hasMore,
    ...(hasMore ? { next_cursor: { source_sha256: set.sourceSha256, resource_id: descriptor.resource_id,
      resource_sha256: descriptor.resource_sha256, byte_offset: end, max_bytes: limit } } : {}) }
}

/** Resolve one opaque replacement, never fuzzy-match or copy a template/demo.
 * Authorization/receipt and atomic expectedBefore commit belong to the caller.
 */
export function resolveReferenceResourceReplacement(
  set: ReferenceResourceSet, binding: ReferenceResourceBinding, oldText: string, currentHtml: string,
): { content: string } {
  assertKeys(binding, ['source_sha256', 'resource_id', 'resource_sha256'])
  if (binding.source_sha256 !== set.sourceSha256 || typeof binding.resource_sha256 !== 'string' || !SHA256.test(binding.resource_sha256)) {
    throw new Error('Reference replacement identity is stale; read_reference_resource for the current binding. No edit was applied')
  }
  const { descriptor, content } = resolveResource(set, binding.resource_id)
  if (!descriptor.referenceable || descriptor.resource_sha256 !== binding.resource_sha256) {
    throw new Error('Reference resource is read-only or stale; read_reference_resource for a current runtime-loader binding. No edit was applied')
  }
  if (typeof oldText !== 'string' || oldText.length === 0) throw new Error('Reference replacement requires nonempty exact old_text. No edit was applied')
  const start = currentHtml.indexOf(oldText)
  if (start < 0) throw new Error('Context not found: reference replacement requires literal old_text. Read the canonical file again. No edit was applied')
  if (currentHtml.indexOf(oldText, start + 1) >= 0) throw new Error('Context not found: reference replacement old_text is not unique. Read the canonical file and use one exact unique span. No edit was applied')
  const edited = currentHtml.slice(0, start) + content + currentHtml.slice(start + oldText.length)
  if (Buffer.byteLength(edited) > REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES) throw new Error('Reference replacement exceeds the bounded output size. No edit was applied')
  return { content: edited }
}
