import { createHash } from 'node:crypto'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { buildReferenceRuntimeResourceSet, type ReferenceResourceSet } from './reference-resources.js'
import type { DurableReferenceStyleContract } from './reference-style.js'
import { resolveReferenceRuntimeEvidence } from './reference-runtime-evidence.js'
import { REFERENCE_TEMPLATE_MAX_DEPENDENCIES, REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES } from './reference-template.js'

export interface ReferenceRuntimeDiagnostic {
  schemaVersion: 1
  advisory_only: true
  source_sha256: string
  artifact_hash: string
  dependencies: Array<{
    resource_id: string
    loader_resource_id: string
    resource_sha256: string
    runtime_manifest_sha256: string
    /** Source-byte recognition, never proof of execution or equivalence. */
    recognized_inline_scripts: number
  }>
}

/** Shared source/render boundary. Read-only private evidence resolution, with
 * no template re-fetch, source verification, resource receipt or gate changes. */
export async function inspectStoredReferenceRuntime(
  sessionDirectory: string, reference: DurableReferenceStyleContract, html: string,
): Promise<ReferenceRuntimeDiagnostic | { advisory_only: true; unavailable: true } | undefined> {
  if (reference.contract.strictness !== 'exact' || !reference.templateCatalog?.dependencies.length) return undefined
  try {
    const sourceSha256 = reference.provenance.evidenceSha256
    const manifest = reference.runtimeEvidence
    if (reference.templateCatalog.sourceSha256 !== sourceSha256 || !manifest
      || manifest.sourceEvidenceSha256 !== sourceSha256 || manifest.sourceUrl !== reference.provenance.resolvedUrl
      || JSON.stringify(manifest.dependencies.map(({ url }) => url)) !== JSON.stringify(reference.templateCatalog.dependencies)) {
      throw new Error('Runtime identity is unavailable')
    }
    const dependencies = await resolveReferenceRuntimeEvidence(sessionDirectory, manifest)
    return inspectReferenceRuntime(html, buildReferenceRuntimeResourceSet({ sourceSha256,
      sourceUrl: manifest.sourceUrl, dependencies, manifestSha256: manifest.manifestSha256 }))
  } catch {
    // No OS/private paths in advisory output, and no silent refetch/recapture.
    return { advisory_only: true, unavailable: true }
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

/** Observe only executable classic-script elements in the document tree.
 * Template contents, comments and JS strings are not executable script nodes.
 * This does not execute code, fetch URLs, or infer behavioral equivalence. */
function inlineScriptBodies(html: string): string[] {
  if (Buffer.byteLength(html) > REFERENCE_TEMPLATE_MAX_OUTPUT_BYTES) throw new Error('Runtime diagnostic exceeds the bounded HTML size')
  const pending: Array<{ node: DefaultTreeAdapterMap['node']; depth: number }> = [{ node: parse(html, { sourceCodeLocationInfo: true }), depth: 0 }]
  const bodies: string[] = []
  let visited = 0
  while (pending.length) {
    const { node, depth } = pending.pop()!
    if (++visited > 16_000 || depth > 128) throw new Error('Runtime diagnostic exceeds the bounded document tree')
    if ('tagName' in node && node.tagName === 'script' && node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      const attr = (name: string) => node.attrs.find((item) => item.name === name)
      const type = attr('type')?.value.trim().toLowerCase() ?? ''
      const location = node.sourceCodeLocation
      if (!attr('src') && !attr('nomodule') && !attr('language')
        && ['', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(type)
        && location?.startTag && location.endTag) {
        bodies.push(html.slice(location.startTag.endOffset, location.endTag.startOffset))
      }
    }
    // parse5 stores inert <template> descendants under .content, not childNodes.
    if ('childNodes' in node) for (const child of node.childNodes) pending.push({ node: child, depth: depth + 1 })
  }
  return bodies
}

/** Compare a candidate against already verified, immutable runtime resources.
 * A different implementation may still render correctly. Do not change any
 * style score/gate based on this source-byte diagnostic. */
export function inspectReferenceRuntime(html: string, resources: ReferenceResourceSet): ReferenceRuntimeDiagnostic {
  const scripts = inlineScriptBodies(html)
  const runtimes = resources.resources.filter((item) => /^runtime\/\d+$/u.test(item.resource_id))
  if (runtimes.length > REFERENCE_TEMPLATE_MAX_DEPENDENCIES || !sha256(resources.sourceSha256)) throw new Error('Invalid runtime diagnostic resources')
  const dependencies = runtimes.map((runtime, index) => {
    const loaderId = `runtime-loader/${index}`
    const loader = resources.resources.find((item) => item.resource_id === loaderId)
    const native = resources.contents.get(runtime.resource_id)
    const packaged = resources.contents.get(loaderId)
    if (runtime.resource_id !== `runtime/${index}` || native === undefined || packaged === undefined || !loader
      || digest(native) !== runtime.resource_sha256 || digest(packaged) !== loader.resource_sha256
      || !sha256(runtime.runtime_manifest_sha256) || loader.runtime_manifest_sha256 !== runtime.runtime_manifest_sha256
      || loader.dependency_sha256 !== runtime.resource_sha256) throw new Error('Runtime diagnostic resources are stale')
    const loaderBodies = inlineScriptBodies(packaged)
    if (loaderBodies.length !== 1) throw new Error('Runtime diagnostic loader is invalid')
    return { resource_id: runtime.resource_id, loader_resource_id: loaderId,
      resource_sha256: runtime.resource_sha256, runtime_manifest_sha256: runtime.runtime_manifest_sha256,
      recognized_inline_scripts: scripts.filter((body) => body === native || body === loaderBodies[0]).length }
  })
  return { schemaVersion: 1, advisory_only: true, source_sha256: resources.sourceSha256,
    artifact_hash: createHash('sha256').update(html).digest('base64url'), dependencies }
}

/** Untrusted/legacy result fields are never promoted into a repair hint for
 * another candidate version, source, manifest, or dependency ordering. */
export function currentReferenceRuntimeDiagnostic(value: unknown, expected: {
  sourceSha256: string
  artifactHash: string
  manifestSha256: string
  dependencyHashes: readonly string[]
}): ReferenceRuntimeDiagnostic | undefined {
  if (!object(value) || value.schemaVersion !== 1 || value.advisory_only !== true
    || value.source_sha256 !== expected.sourceSha256 || value.artifact_hash !== expected.artifactHash
    || !sha256(expected.sourceSha256) || !sha256(expected.manifestSha256)
    || !/^[a-zA-Z0-9_-]{43}$/u.test(expected.artifactHash)
    || !Array.isArray(value.dependencies) || value.dependencies.length !== expected.dependencyHashes.length
    || value.dependencies.length > REFERENCE_TEMPLATE_MAX_DEPENDENCIES) return undefined
  const dependencies: ReferenceRuntimeDiagnostic['dependencies'] = []
  for (const [index, item] of value.dependencies.entries()) {
    if (!object(item) || item.resource_id !== `runtime/${index}` || item.loader_resource_id !== `runtime-loader/${index}`
      || !sha256(expected.dependencyHashes[index]) || item.resource_sha256 !== expected.dependencyHashes[index]
      || item.runtime_manifest_sha256 !== expected.manifestSha256
      || !Number.isSafeInteger(item.recognized_inline_scripts) || Number(item.recognized_inline_scripts) < 0
      || Number(item.recognized_inline_scripts) > 16_000) return undefined
    dependencies.push({ resource_id: item.resource_id, loader_resource_id: item.loader_resource_id,
      resource_sha256: item.resource_sha256 as string, runtime_manifest_sha256: expected.manifestSha256,
      recognized_inline_scripts: Number(item.recognized_inline_scripts) })
  }
  return { schemaVersion: 1, advisory_only: true, source_sha256: expected.sourceSha256,
    artifact_hash: expected.artifactHash, dependencies }
}

export function referenceRuntimeRepairInstruction(diagnostic: ReferenceRuntimeDiagnostic | undefined): string {
  const unrecognized = diagnostic?.dependencies.filter((item) => item.recognized_inline_scripts !== 1) ?? []
  if (!unrecognized.length) return ''
  return ` Current candidate runtime diagnosis (source-byte comparison only): ${JSON.stringify(unrecognized)}. The source verifier checks static CSS; the rendered reference also includes its declared runtime, which may change DOM structure, shadow-root inheritance and computed styles. When these layers disagree, inspect the corresponding read_reference_resource runtime inputs and compare the candidate's integration before changing another static declaration. A runtime-loader binding can restore the verified native implementation without echoing its bytes; obtain its real resource receipt first. Unrecognized code is not proof of a defect, recognized code is not proof of execution, and all current source/render/Vision gates remain required.`
}
