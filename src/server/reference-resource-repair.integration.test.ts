import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage, ToolCallRecord } from '../shared/types.js'
import type { ToolDefinition } from './tools.js'
import { AgentService, canonicalDiagnosticReadCursor, referenceStyleArtifactRepairPhase, visualWebArtifactCompletionGap } from './agent-service.js'
import { SessionStore } from './session-store.js'
import { extractReferenceStyleSourceProfile, findReferenceStyleEvidence, normalizeReferenceStyleContract, REFERENCE_STYLE_VERIFIER_REVISION,
  type DurableReferenceStyleContract } from './reference-style.js'
import { verifyDurableReferenceSource } from './reference-preserving-edit.js'
import { materializeReferenceRuntimeLoader, referenceTemplateCatalog } from './reference-template.js'
import type { ReferenceResourceBinding, ReferenceResourceReadResult } from './reference-resources.js'
import { buildReferenceResourceSet } from './reference-resources.js'
import { inspectReferenceRuntime } from './reference-runtime-diagnostics.js'
import { referenceResourceReceipt } from './reference-resource-repair.js'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const isToolCallIdentity = (value: unknown): value is Pick<ToolCallRecord, 'id' | 'name'> => (
  value !== null && typeof value === 'object'
  && 'id' in value && typeof value.id === 'string'
  && 'name' in value && typeof value.name === 'string'
)
const sourceUrl = 'https://reference.example/workshop/template.html'
const oldScript = '<script>window.oldNavigation = true</script>'
const source = '<!doctype html><html><head><title>Workshop</title><style>.slide{background:#112233;color:#eeeeee}.headline{font-family:Georgia;font-size:96px;font-weight:900}</style></head><body><deck-stage><section class="slide cover"><h1 class="headline">Welcome</h1></section><section class="slide agenda"><p>Requirements</p></section><section class="slide closing"><h1>Next steps</h1></section></deck-stage><script src="runtime.js"></script></body></html>'
const candidate = source.replace('<script src="runtime.js"></script>', oldScript)
const candidateHash = createHash('sha256').update(candidate).digest('base64url')
const viewport = { width: 1000, height: 600 }
const contractArgs = { source_url: sourceUrl, strictness: 'exact', colors: ['#112233', '#eeeeee'], fonts: ['Georgia'],
  layout: ['full viewport', 'separate pages'], components: ['slide', 'headline'], required_markers: ['.slide', '.headline'],
  signature: 'Workshop deck', avoid: ['invented palette'], viewport }

// Private-evidence bytes are synthetic fixture attestations only. No browser,
// font transport or final visual acceptance is claimed. Deterministic source
// verification below executes normally against the synthetic HTML.
function fixturePng(marker: string): Buffer {
  const bytes = Buffer.alloc(33 + Buffer.byteLength(marker))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(viewport.width, 16)
  bytes.writeUInt32BE(viewport.height, 20)
  bytes[24] = 8
  bytes[25] = 6
  bytes.write(marker, 33)
  return bytes
}

describe('AgentService reference resource repair', () => {
  it.each(['valid', 'missing-hash', 'unknown-field', 'wrong-source', 'unknown-id'] as const)('keeps %s auxiliary reads independent of candidate reads, edits, and acceptance gates', async (variant) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-reference-resource-repair-'))
    let agent: AgentService | undefined
    try {
      const store = new SessionStore(root, 'offline-fixture')
      await store.initialize()
      const sessionId = (await store.create()).summary.id
      const catalog = referenceTemplateCatalog(source, sourceUrl)
      const script = 'customElements.define("deck-stage", class extends HTMLElement {});'
      const dependency = { url: new URL('runtime.js', sourceUrl).toString(), content: script,
        sha256: digest(script), bytes: Buffer.byteLength(script) }
      const contract = normalizeReferenceStyleContract(contractArgs)
      const phase = (selector: string) => ({ anchors: [{ selector, count: 1, geometry: 'strict' as const,
        rects: [{ x: 0, y: 0, width: 1, height: 1 }], styles: [{ display: 'block' }], occlusion: [1] }],
      overlayProbes: [], textLayout: { version: 2 as const, complete: true, collisions: [] } })
      const renderProfile = { version: 1 as const, evidenceSha256: catalog.sourceSha256, viewport,
        phases: { cover: phase('.cover'), content: phase('.agenda'), closing: phase('.closing') } }
      const visualEvidence = await store.commitReferenceVisualEvidence(sessionId, {
        sourceEvidenceSha256: catalog.sourceSha256, renderProfileSha256: digest(JSON.stringify(renderProfile)), viewport,
        screenshots: { cover: fixturePng('cover'), content: fixturePng('content'), closing: fixturePng('closing') },
      })
      const fontEvidence = await store.commitReferenceFontEvidence(sessionId, {
        sourceEvidenceSha256: catalog.sourceSha256, fontCss: '', familyNames: [], materializationManifest: null,
      })
      const runtimeEvidence = await store.commitReferenceRuntimeEvidence(sessionId, catalog.sourceSha256, sourceUrl, [dependency])
      const reference: DurableReferenceStyleContract = { contract,
        provenance: { resolvedUrl: sourceUrl, evidenceSha256: catalog.sourceSha256, evidenceBytes: Buffer.byteLength(source) },
        sourceProfile: extractReferenceStyleSourceProfile(source, contract)!, renderProfile, templateCatalog: catalog,
        visualEvidence, fontEvidence, runtimeEvidence }
      const append = async (name: string, arguments_: Record<string, unknown>, result: Record<string, unknown>) => {
        const call: ToolCallRecord = { id: `seed-${name}`, name, arguments: arguments_ }
        await store.append(sessionId, 'tool.completed', { call, result: JSON.stringify(result), isError: false })
        await store.update(sessionId, (state) => { state.messages.push(
          { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name, arguments: JSON.stringify(arguments_) } }] },
          { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result), tool_result_status: 'succeeded' },
        ) })
      }
      await store.update(sessionId, (state) => {
        state.messages = [{ role: 'user', content: `Create 3 HTML Slides for a workshop agenda, strictly matching ${sourceUrl}. No web research is needed.` }]
        state.activeReferenceStyleContract = reference
        state.summary.status = 'failed'
      })
      await append('fetch_page', { url: sourceUrl, format: 'raw' }, {
        status: 'success', url: sourceUrl, content: source, hasMore: false, chunkIndex: 0, totalChunks: 1,
      })
      await append('record_reference_style', contractArgs, { status: 'success', contract: contractArgs,
        provenance: reference.provenance, source_profile: reference.sourceProfile, render_profile: renderProfile,
        composition_template: catalog, visual_evidence: visualEvidence, font_evidence: fontEvidence, runtime_evidence: runtimeEvidence })
      await writeFile(resolve(store.workspaceDir(sessionId), 'workshop.html'), candidate)
      await append('write_file', { path: 'workshop.html', content: candidate }, {
        status: 'success', hash: candidateHash, canonical_html: true,
      })
      const runtimeDiagnostic = inspectReferenceRuntime(candidate, buildReferenceResourceSet({ source, sourceUrl,
        sourceSha256: catalog.sourceSha256, dependencies: [dependency], manifestSha256: runtimeEvidence.manifestSha256 }))
      await append('verify_reference_style', { path: 'workshop.html' }, {
        status: 'success', fidelity: 'mismatch', score: 95, verifier_revision: REFERENCE_STYLE_VERIFIER_REVISION,
        artifact_hash: candidateHash, reference_sha256: catalog.sourceSha256, provenance: reference.provenance,
        source_profile_sha256: digest(JSON.stringify(reference.sourceProfile)), render_profile_sha256: digest(JSON.stringify(renderProfile)),
        reference_font_manifest_sha256: fontEvidence.manifestSha256,
        missing: { colors: [], fonts: [], markers: [] }, violations: { colors: [], fonts: [], avoid: [], source: ['Restore native navigation.'] },
        ...(variant === 'valid' ? {} : { runtime_diagnostic: runtimeDiagnostic }),
      })
      if (variant === 'valid') {
        // Legacy source checks have no advisory; a current screenshot result
        // may supply the same source-byte diagnosis without re-running source.
        // This synthetic metadata is NOT a render/Browser pass attestation.
        await append('browser', { action: 'screenshot', screenshot_path: 'cover.png' }, {
          status: 'success', render_canonical_path: 'workshop.html', runtime_diagnostic: runtimeDiagnostic,
        })
      }
      const gap = (messages: ModelMessage[]) => visualWebArtifactCompletionGap(messages, { forceTask: true,
        canonicalPath: 'workshop.html', referenceContract: reference, requiresResearch: false,
        requirePrivateVisualEvidence: true, requireCurrentReferenceVerifier: true })?.missingPhases
      const initialGap = gap((await store.get(sessionId)).messages)
      expect(initialGap?.[0]).toBe('reference_implementation')
      const invalidArgs: Record<string, unknown> | undefined = variant === 'valid' ? undefined
        : variant === 'missing-hash' ? { source_sha256: catalog.sourceSha256, resource_id: 'template', byte_offset: 4, max_bytes: 32 }
          : variant === 'unknown-field' ? { source_sha256: catalog.sourceSha256, resource_id: 'template', cursor_typo: 4 }
            : variant === 'wrong-source' ? { source_sha256: 'a'.repeat(64), resource_id: 'template' }
              : { source_sha256: catalog.sourceSha256, resource_id: 'runtime/1' }
      const invalidReachesExecutor = variant === 'missing-hash' || variant === 'unknown-field'
      const requests: Array<{ names: string[]; messages: ModelMessage[]; phase: string | undefined }> = []
      let binding: ReferenceResourceBinding | undefined
      let verifiedRoundObserved = false
      let rejectedEditIssued = false
      let rejectedEditObserved = false
      let preservedArtifact: Awaited<ReturnType<SessionStore['get']>>['activeVisualArtifact']
      let preservedGap: ReturnType<typeof gap>
      const stream = vi.fn(async (options: { tools: ToolDefinition[]; messages: ModelMessage[] }) => {
        const state = await store.get(sessionId)
        requests.push({ names: options.tools.map((tool) => tool.function.name), messages: options.messages,
          phase: referenceStyleArtifactRepairPhase(state.messages, 'workshop.html') })
        const step = requests.length - Number(Boolean(invalidArgs)) - Number(rejectedEditIssued)
        const phaseControl = options.messages.findLast((message) => message.role === 'user'
          && message.content?.startsWith('[Harness trusted phase control'))?.content ?? ''
        if (step <= 4 && !rejectedEditIssued) expect(phaseControl).toContain('Current candidate runtime diagnosis')
        if (step >= 5 && step <= 6) expect(phaseControl).not.toContain('Current candidate runtime diagnosis')
        if (invalidArgs && step === 1) {
          const last = state.messages.findLast((message) => message.role === 'tool')!
          expect(last.tool_result_status).toBe('failed')
          expect(last.content).toMatch(variant === 'missing-hash' ? /resource_sha256; copy every field from the previous next_cursor exactly/u
            : variant === 'unknown-field' ? /Invalid reference resource fields/u : /not enabled for this task/u)
          expect(referenceResourceReceipt(last.content!)).toBeUndefined()
          expect(gap(state.messages)).toEqual(initialGap)
          expect(canonicalDiagnosticReadCursor(state.messages, 'workshop.html')).toEqual({ path: 'workshop.html', offset: 1, limit: 5000 })
          expect(await readFile(resolve(store.workspaceDir(sessionId), 'workshop.html'), 'utf8')).toBe(candidate)
          const journal = await store.events(sessionId)
          const failed = journal.find((event) => event.type === 'tool.failed' && isToolCallIdentity(event.data.call) && event.data.call.id === 'repair-0')!
          expect(failed.data.call).toMatchObject({ name: 'read_reference_resource', arguments: invalidArgs })
          expect(journal.some((event) => event.type === 'tool.completed' && isToolCallIdentity(event.data.call) && event.data.call.name === 'read_reference_resource')).toBe(false)
          expect(journal.some((event) => event.type === 'file.changed')).toBe(false)
        }
        if (step === 2) {
          expect(gap(state.messages)).toEqual(initialGap)
          expect(await readFile(resolve(store.workspaceDir(sessionId), 'workshop.html'), 'utf8')).toBe(candidate)
          const receipt = JSON.parse(state.messages.findLast((message) => message.role === 'tool')!.content!) as ReferenceResourceReadResult
          expect(receipt.kind).toBe('reference_resource')
          const loader = receipt.resources.find((item) => item.resource_id === 'runtime-loader/0')!
          binding = { source_sha256: receipt.source_sha256, resource_id: loader.resource_id, resource_sha256: loader.resource_sha256 }
        }
        if (variant === 'valid' && step === 4) {
          if (!rejectedEditIssued) {
            expect(state.activeVisualArtifact?.path).toBe('workshop.html')
            expect(verifyDurableReferenceSource(candidate, reference,
              findReferenceStyleEvidence(state.messages, [sourceUrl]))).toMatchObject({ fidelity: 'pass', score: 100 })
            preservedArtifact = structuredClone(state.activeVisualArtifact)
            preservedGap = gap(state.messages)
            rejectedEditIssued = true
            return { content: '', reasoningContent: '', finishReason: 'tool_calls' as const,
              toolCalls: [{ id: 'repair-rejected-style', type: 'function' as const, function: { name: 'edit_file',
                arguments: JSON.stringify({ path: 'workshop.html', old_text: 'background:#112233', new_text: 'background:#ff0000' }) } }],
              usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23, cachedPromptTokens: 0 }, modelCallCount: 1 }
          }
          const last = state.messages.findLast((message) => message.role === 'tool')!
          expect(last.tool_call_id).toBe('repair-rejected-style')
          expect(last.tool_result_status).toBe('failed')
          expect(last.content).toContain('Reference-preserving edit rejected before commit')
          expect(last.content).toContain('not a successful verification receipt')
          expect(phaseControl).toContain('Current candidate runtime diagnosis')
          expect(state.activeVisualArtifact).toEqual(preservedArtifact)
          expect(gap(state.messages)).toEqual(preservedGap)
          expect(referenceStyleArtifactRepairPhase(state.messages, 'workshop.html')).toBe('edit')
          expect(requests.at(-1)!.names).toEqual(['edit_file', 'read_reference_resource'])
          expect(await readFile(resolve(store.workspaceDir(sessionId), 'workshop.html'), 'utf8')).toBe(candidate)
          const journal = await store.events(sessionId)
          expect(journal.some((event) => event.type === 'file.changed' || event.type === 'artifact.created')).toBe(false)
          expect(journal.find((event) => event.type === 'tool.failed' && event.callId === 'repair-rejected-style')?.data.isError).toBe(true)
          expect(journal.some((event) => event.type === 'tool.completed' && event.callId === 'repair-rejected-style')).toBe(false)
          rejectedEditObserved = true
        }
        if (step === 6) {
          const last = state.messages.findLast((message) => message.role === 'tool')!
          expect(last.tool_result_status).toBe('failed')
          expect(last.content).toMatch(/not enabled for this task/u)
          expect(referenceResourceReceipt(last.content!)).toBeUndefined()
          if (variant !== 'valid') throw new Error('Fixture stop before source verification or visual delivery; no provider is invoked.')
        }
        if (step === 7) {
          const terminal = (await store.events(sessionId)).find((event) => event.type === 'tool.completed'
            && isToolCallIdentity(event.data.call) && event.data.call.id === 'repair-6')!
          const result = JSON.parse(state.messages.findLast((message) => message.role === 'tool')!.content!)
          const progress = state.visualNoProgress?.verificationProgress
          expect(progress?.scopeDigest).toMatch(/^[a-f0-9]{64}$/u)
          expect(progress?.channels).toHaveLength(1)
          expect(progress?.channels[0]).toMatchObject({ channel: 'source', lastSequence: terminal.seq })
          if (result.fidelity === 'pass') expect(progress?.channels[0].defects).toEqual([])
          else {
            expect(progress?.channels[0].defects.length).toBeGreaterThan(0)
            expect(progress?.channels[0].defects.every((defect) => defect.observations === 1 && defect.recoveries === 0)).toBe(true)
          }
          const reloaded = await new SessionStore(root, 'offline-fixture').get(sessionId)
          expect(reloaded.visualNoProgress?.verificationProgress).toEqual(progress)
          verifiedRoundObserved = true
          throw new Error('Fixture stop after deterministic source verification and durable liveness projection; no provider or browser is invoked.')
        }
        const name = step === 6 ? 'verify_reference_style'
          : [0, 1, 3, 5].includes(step) ? 'read_reference_resource' : step === 2 ? 'read_file' : 'edit_file'
        const args = step === 0 ? invalidArgs!
          : step === 1 ? variant === 'missing-hash'
            ? { ...invalidArgs, resource_sha256: catalog.sourceSha256 }
            : { source_sha256: catalog.sourceSha256 }
          : step === 2 ? { path: 'workshop.html', offset: 1, limit: 5000 }
            : step === 3 ? { source_sha256: catalog.sourceSha256, resource_id: 'template', max_bytes: 32 }
              : step === 5 ? { source_sha256: catalog.sourceSha256, resource_id: 'template' }
                : step === 6 ? { path: 'workshop.html' }
              : { path: 'workshop.html', old_text: oldScript, reference_resource: binding }
        return { content: '', reasoningContent: '', finishReason: 'tool_calls' as const,
          toolCalls: [{ id: `repair-${step}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
          usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23, cachedPromptTokens: 0 }, modelCallCount: 1 }
      })
      const forbiddenFetch = vi.fn(async () => { throw new Error('No network is permitted in this fixture') })
      agent = new AgentService(store, { client: { stream } as never, runTimeoutMs: 5_000,
        vision: { inspect: vi.fn(async () => { throw new Error('No Vision is permitted in this fixture') }) },
        toolExecutorDependencies: { fetch: forbiddenFetch, imageApiKey: '' } })
      const execute = vi.spyOn(agent['tools'], 'execute')
      await agent.resume(sessionId)
      await vi.waitFor(() => expect(agent?.isRunning(sessionId)).toBe(false), { timeout: 8_000, interval: 10 })
      const events = await store.events(sessionId)
      const diagnostic = JSON.stringify(events.filter((event) => ['error', 'tool.failed', 'model.tool_call.repair'].includes(event.type)))
      expect((variant === 'valid' ? requests.slice(0, -1) : requests).map((request) => request.names), diagnostic).toEqual([
        ...(invalidArgs ? [['read_file', 'read_reference_resource']] : []),
        ['read_file', 'read_reference_resource'], ['read_file', 'read_reference_resource'],
        ...(variant === 'valid' ? [['edit_file', 'read_reference_resource']] : []),
        ['edit_file', 'read_reference_resource'], ['edit_file', 'read_reference_resource'], ['verify_reference_style'], ['verify_reference_style'],
      ])
      expect((variant === 'valid' ? requests.slice(0, -1) : requests).map((request) => request.phase)).toEqual([
        ...(invalidArgs ? ['read'] : []), 'read', 'read', ...(variant === 'valid' ? ['edit'] : []), 'edit', 'edit', undefined, undefined,
      ])
      expect(execute.mock.calls.map(([call]) => call.name)).toEqual([
        ...(invalidReachesExecutor ? ['read_reference_resource'] : []), 'read_reference_resource', 'read_file', 'read_reference_resource', 'edit_file',
        ...(variant === 'valid' ? ['edit_file', 'verify_reference_style'] : []),
      ])
      expect(events.filter((event) => event.type === 'tool.failed'), diagnostic).toHaveLength(2)
      expect(events.filter((event) => event.type === 'model.tool_call.repair' && event.data.reason === 'canonical_diagnostic_read')).toEqual([])
      expect(events.filter((event) => event.type === 'model.tool_call.repair' && typeof event.data.reason === 'string' && ['visual_workflow_phase_action', 'missing_required_tool_argument'].includes(event.data.reason))).toEqual([])
      expect(events.some((event) => event.type === 'tool.completed' && isToolCallIdentity(event.data.call) && event.data.call.id === 'repair-5')).toBe(false)
      expect(await readFile(resolve(store.workspaceDir(sessionId), 'workshop.html'), 'utf8'))
        .toBe(candidate.replace(oldScript, materializeReferenceRuntimeLoader(dependency)))
      const finalGap = gap((await store.get(sessionId)).messages)
      if (variant === 'valid') {
        expect(rejectedEditObserved, diagnostic).toBe(true)
        expect(verifiedRoundObserved, diagnostic).toBe(true)
        expect(requests).toHaveLength(8)
        expect(finalGap).not.toContain('reference_source_check')
      } else expect(finalGap).toContain('reference_source_check')
      expect(finalGap).toContain('present_file')
      expect(finalGap).toContain('reference_closing_inspection')
      expect(forbiddenFetch).not.toHaveBeenCalled()
    } finally {
      await agent?.shutdown()
      vi.restoreAllMocks()
      await rm(root, { recursive: true, force: true })
    }
  })
})
