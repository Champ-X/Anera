import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from './browser-manager.js'
import { publicReadTransport } from '../eval/public-read-transport.js'
import { visualWebArtifactCompletionGap, visualWebArtifactRequiredToolNames } from './agent-service.js'
import { config } from './config.js'
import { GitHubConnector, createGitHubCodingShellCommandBroker } from './github-connector.js'
import { ProcessManager, type ProcessEvent, type ProcessManagerOptions } from './process-manager.js'
import { SessionStore } from './session-store.js'
import {
  ANERA_RUNTIME_AGENT_TOOL_DEFINITIONS,
  ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS,
  ARENA_ACTIVE_AGENT_TOOL_NAMES,
  ARENA_BINARY_EXTENSIONS,
  arenaActiveToolContentParts,
  arenaActiveToolModelOutput,
  arenaWorkspacePath,
  normalizeAneraRuntimeToolCall,
  normalizeArenaPublicToolCall,
  rewriteArenaWorkspaceCommandPaths,
  stripRedundantArenaWorkspaceCd,
  truncateArenaFileTextForModel,
  readBoundedResponseBytes,
  readBoundedResponseText,
  TOOL_DEFINITIONS,
  ToolExecutor,
  validateToolCallArguments,
  verifyInstalledNpmPackages,
  type ConnectorToolExecutor,
  type VisionInspector,
} from './tools.js'
import { isWorkspaceSnapshotExcludedPath, writeWorkspaceFile } from './workspace.js'

const roots: string[] = []
const processManagers: ProcessManager[] = []
const SPEECH_MP3_FIXTURE = Buffer.from(
  'SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYzLjEuMTAxAAAAAAAAAAAAAAD/84TAAAAAAAAAAAAASW5mbwAAAA8AAAAHAAADYABVVVVVVVVVVVVVVVVVVXFxcXFxcXFxcXFxcXFxjo6Ojo6Ojo6Ojo6Ojo6qqqqqqqqqqqqqqqqqqqrHx8fHx8fHx8fHx8fHx+Pj4+Pj4+Pj4+Pj4+Pj//////////////////8AAAAATGF2YzYzLjEuAAAAAAAAAAAAAAAAJAJAAAAAAAAAA2AyzfsUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/80TEABJQbngfWBgAVkluAXeu9YdU6Y6g7T26FsDW02tNaTOUBHQBrrd+NxiWSiMSykpLGAPg+D4P1Ag7Ln+CDpzp85y/nOnlwQdKAMP5MEOX93+GOlUwCFDC4eqxzUH/80TECRRJMmwBnIAAZjtrHsj8DEGfLGBhVAHwkCZxIBhsKJY0abM4FkoNtQsJ/FJCUhCxAf8ZkZUmiLEC/8xJ0ipkXi9/+Yl0upA038qEgaEoS/4NKg6ElaHCfqHwQAP/80TEChNgWixV3gAAlrQEAaYHoWRhUD5GCcGiYSoiR5OvcGe8IeYUoVBgqgnGC2BMYAAB5ZEvSrc40ix9aHamq+N/6Pu/9noR/Zv932ff/potzXCUGdJDbWEvwACDEJP/80TEDxJoUihW57RAzof7BStME8Uc8IvoTG1CpOQqMiJLQJjrsZ3D8sP41rKvt9296u5P8wjFiqrafb/0vUUMbrvT02a8aKVVimYBACwcADGAQAHBgOgHMYJkBXGD6A7/80TEGBWgWiABXwAAwYIUEFGHHhdpl7bAIYgsJ+GGxAzxgYwEMAAG0wHEA7MAfAGSIADW2huuujr9uv9Vz/rSW//9Hyfbrbv8b/61///G2NIgZxKyAxwGkYAw7+t7IWn/80TEFBbycpQBmmgA/4SATAeH+JmOclxyf+PQoDnJc3//HoXDQly+b//5KFw0L5fNy5//+XEC+X0y4aIF////9NMuIIG6aZoggb//+HwQAYfBABh9AgQgwwwgAHJC+Pj/80TECxU6qoxVk1AAGzpBl8LJQtj4UQBYCt+FCAVAZEF/g3CKIREiz/5EIoWiERJL/+RCKJio9JU//x86j0xDl///mpOXIjZCd////IlkJxxEaaQnHERMQU1FNC4wqqo=',
  'base64',
)

afterEach(async () => {
  await Promise.allSettled(processManagers.splice(0).map((manager) => manager.stopEverything()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function persistedProcessManager(store: SessionStore, options: ProcessManagerOptions = {}): ProcessManager {
  const manager = new ProcessManager(async (sessionId: string, event: ProcessEvent, context) => {
    const type = event.type === 'started'
      ? 'process.started'
      : event.type === 'output'
        ? 'process.output'
        : event.type === 'updated'
          ? 'process.updated'
          : 'process.stopped'
    await store.append(sessionId, type, event as unknown as Record<string, unknown>, context)
    await store.update(sessionId, (state) => {
      state.processes = [...state.processes.filter((process) => process.id !== event.record.id), event.record]
    })
  }, 10_000, options)
  processManagers.push(manager)
  return manager
}

async function expectEventually(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let failure: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      failure = error
      await new Promise((resolveWait) => setTimeout(resolveWait, 15))
    }
  }
  throw failure
}

async function reserveTcpPort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolveListen) => reservation.listen(0, '127.0.0.1', resolveListen))
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>((resolveClose, rejectClose) => reservation.close((error) => error ? rejectClose(error) : resolveClose()))
  return port
}

async function reserveTcpPorts(count: number): Promise<number[]> {
  const reservations = Array.from({ length: count }, () => createServer())
  await Promise.all(reservations.map((reservation) => new Promise<void>((resolveListen) => (
    reservation.listen(0, '127.0.0.1', resolveListen)
  ))))
  const ports = reservations.map((reservation) => (reservation.address() as AddressInfo).port)
  await Promise.all(reservations.map((reservation) => new Promise<void>((resolveClose, rejectClose) => (
    reservation.close((error) => error ? rejectClose(error) : resolveClose())
  ))))
  return ports
}

function syntheticPng(marker: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker, marker, marker, marker])
}

function dimensionedPng(width: number, height: number, marker: number): Buffer {
  const png = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12, 'ascii')
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  png[32] = marker
  return png
}

async function installExactReferenceVisualFixture(
  store: SessionStore,
  sessionId: string,
  options: { includeManifest?: boolean } = {},
) {
  const viewport = { width: 320, height: 180 }
  const sourceEvidenceSha256 = '1'.repeat(64)
  const renderProfile = {
    version: 1 as const,
    evidenceSha256: sourceEvidenceSha256,
    viewport,
    phases: {
      cover: { anchors: [], overlayProbes: [] },
      content: { anchors: [], overlayProbes: [] },
      closing: { anchors: [], overlayProbes: [] },
    },
  }
  const renderProfileSha256 = createHash('sha256').update(JSON.stringify(renderProfile)).digest('hex')
  const screenshots = {
    cover: dimensionedPng(viewport.width, viewport.height, 1),
    content: dimensionedPng(viewport.width, viewport.height, 2),
    closing: dimensionedPng(viewport.width, viewport.height, 3),
  }
  const manifest = await store.commitReferenceVisualEvidence(sessionId, {
    sourceEvidenceSha256,
    renderProfileSha256,
    viewport,
    screenshots,
  })
  const fontEvidence = await store.commitReferenceFontEvidence(sessionId, {
    sourceEvidenceSha256,
    fontCss: '',
    familyNames: [],
    materializationManifest: null,
  })
  const durable = {
    contract: {
      sourceUrl: 'https://example.com/reference.html',
      strictness: 'exact' as const,
      colors: ['#fdfae7', '#1e2bfa'],
      fonts: ['Space Grotesk', 'Inter'],
      layout: ['cover', 'content'],
      components: ['navigation', 'progress'],
      requiredMarkers: ['.slide', '.nav-btn'],
      signature: 'Blue professional reference',
      avoid: ['generic cards'],
      viewport,
    },
    provenance: {
      resolvedUrl: 'https://example.com/reference.html',
      evidenceSha256: sourceEvidenceSha256,
      evidenceBytes: 1_024,
    },
    renderProfile,
    fontEvidence,
    ...(options.includeManifest === false ? {} : { visualEvidence: manifest }),
  }
  await store.update(sessionId, (state) => {
    state.activeReferenceStyleContract = durable
  })
  return { manifest, fontEvidence, renderProfile, renderProfileSha256, screenshots, sourceEvidenceSha256, viewport }
}

async function appendExactRenderAttestation(
  store: SessionStore,
  sessionId: string,
  input: {
    callId: string
    candidatePath: string
    candidateSha256: string
    phase: 'cover' | 'content' | 'closing'
    viewport: { width: number; height: number }
    referenceEvidenceSha256: string
    fontManifestSha256?: string
    pageEpoch?: number
    artifactHash?: string
  },
): Promise<{ pageEpoch: number; artifactHash: string }> {
  const pageEpoch = input.pageEpoch ?? 7
  const artifactHash = input.artifactHash
    ?? createHash('sha256').update(`artifact:${sessionId}`).digest('base64url')
  const fontManifestSha256 = (await store.get(sessionId)).activeReferenceStyleContract?.fontEvidence?.manifestSha256
  if (!fontManifestSha256) throw new Error('fixture font evidence missing')
  const call = {
    id: input.callId,
    type: 'function' as const,
    function: {
      name: 'browser',
      arguments: JSON.stringify({ action: 'screenshot', screenshot_path: input.candidatePath }),
    },
  }
  await store.update(sessionId, (state) => {
    state.messages.push({ role: 'assistant', content: null, tool_calls: [call] }, {
      role: 'tool',
      tool_call_id: call.id,
      tool_result_status: 'succeeded',
      content: JSON.stringify({
        status: 'success',
        render_fidelity: 'pass',
        render_score: 100,
        render_phase: input.phase,
        render_violations: [],
        render_violation_count: 0,
        render_reference_sha256: input.referenceEvidenceSha256,
        render_font_manifest_sha256: input.fontManifestSha256 ?? fontManifestSha256,
        render_page_epoch: pageEpoch,
        render_viewport: input.viewport,
        render_artifact_hash: artifactHash,
        screenshot_sha256: input.candidateSha256,
      }),
    })
  })
  return { pageEpoch, artifactHash }
}

function minimalPdf(pageTexts: string[]): Buffer {
  const objects: string[] = []
  const pageObjectIds = pageTexts.map((_text, index) => 4 + index * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pageTexts.forEach((text, index) => {
    const pageId = pageObjectIds[index]
    const contentId = pageId + 1
    const textRuns = text.match(/[\s\S]{1,50}/g) || ['']
    const operators = textRuns.map((run, runIndex) => {
      const escaped = run.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
      return `BT /F1 12 Tf 72 ${720 - (runIndex % 40) * 16} Td (${escaped}) Tj ET`
    }).join(' ')
    const stream = operators
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id += 1) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

async function imageBattleFixture(options: {
  generated: Array<{ bytes: Buffer; input: number; output: number; omitUsage?: boolean }>
  humanResponse?: Record<string, unknown>
}) {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-image-battle-'))
  roots.push(root)
  const store = new SessionStore(root, 'test-model')
  await store.initialize()
  const session = await store.create()
  let generation = 0
  const imageBattleModels = ['test-image-model-a', 'test-image-model-b']
  const requestedModels: string[] = []
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const fixture = options.generated[generation++]
    if (!fixture) throw new Error('Unexpected extra image generation')
    const body = JSON.parse(String(init?.body)) as { model?: string }
    requestedModels.push(String(body.model || ''))
    return Response.json({
      data: [{ b64_json: fixture.bytes.toString('base64') }],
      ...(fixture.omitUsage ? {} : {
        usage: {
          input_tokens: fixture.input,
          output_tokens: fixture.output,
          total_tokens: fixture.input + fixture.output,
        },
      }),
    })
  })
  const requestHumanInput = vi.fn(async () => options.humanResponse ?? { selected_index: 0 })
  const tools = new ToolExecutor(
    store,
    persistedProcessManager(store),
    new BrowserManager(),
    { inspect: vi.fn() },
    async () => false,
    {
      fetch: fetchMock as typeof fetch,
      imageApiKey: 'test-image-key',
      imageBaseUrl: 'https://images.example/v1',
      imageModel: 'test-image-model',
      imageBattleModels,
      requestHumanInput,
    },
  )
  const execute = async (callId = 'call_options_select') => await tools.execute({
    id: callId,
    name: 'generate_image',
    arguments: { file_path: 'images/hero.png', prompt: 'One standalone geometric landscape', offer_options: true },
  }, {
    sessionId: session.summary.id,
    turnId: 'turn_image_battle',
    stepId: 'step_image_battle',
    callId,
    signal: new AbortController().signal,
  })
  return { store, session, fetchMock, requestHumanInput, requestedModels, imageBattleModels, execute }
}

describe('tool executor vision integration', () => {
  it('freezes the current Arena active registry order and public workspace namespace', () => {
    expect(ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual(ARENA_ACTIVE_AGENT_TOOL_NAMES)
    expect(ARENA_ACTIVE_AGENT_TOOL_NAMES).toHaveLength(19)
    expect(arenaWorkspacePath('/home/user')).toBe('')
    expect(arenaWorkspacePath('/home/user/projects/app.ts')).toBe('projects/app.ts')
    expect(arenaWorkspacePath('~/projects/app.ts')).toBe('projects/app.ts')
    expect(arenaWorkspacePath('projects/app.ts')).toBe('projects/app.ts')
    expect(() => arenaWorkspacePath('/tmp/outside.txt')).toThrow(/Only paths under \/home\/user/)
    expect(ARENA_BINARY_EXTENSIONS).toEqual([
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif', '.avif',
      '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.wav', '.ogg', '.flac', '.aac',
      '.m4a', '.aiff', '.aif', '.opus', '.mp4', '.webm', '.avi', '.mov', '.mkv', '.zip',
      '.tar', '.gz', '.bz2', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.wasm', '.pdf',
      '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.bin', '.dat', '.db', '.sqlite',
    ])
  })

  it('freezes every provider-visible active tool schema, description, property order, and required set', () => {
    const schemaContracts = Object.fromEntries(ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS.map((tool) => {
      const parameters = tool.function.parameters as {
        type: string
        properties: Record<string, unknown>
        required: string[]
        additionalProperties: boolean
      }
      return [tool.function.name, {
        properties: Object.keys(parameters.properties),
        required: parameters.required,
        additionalProperties: parameters.additionalProperties,
      }]
    }))
    expect(schemaContracts).toEqual({
      add_voice: { properties: ['text', 'language', 'voice_identity'], required: ['text', 'language'], additionalProperties: false },
      ask_user: { properties: ['questions'], required: ['questions'], additionalProperties: false },
      bash: { properties: ['command', 'cwd', 'timeout'], required: ['command'], additionalProperties: false },
      compact: { properties: [], required: [], additionalProperties: false },
      edit_file: { properties: ['path', 'old_text', 'new_text'], required: ['path', 'old_text', 'new_text'], additionalProperties: false },
      fetch_page: { properties: ['url', 'chunkIndex'], required: ['url'], additionalProperties: false },
      generate_image: { properties: ['file_path', 'prompt', 'images', 'offer_options'], required: ['file_path', 'prompt'], additionalProperties: false },
      generate_speech: { properties: ['file_path', 'text', 'voice_id', 'language'], required: ['file_path', 'text', 'voice_id'], additionalProperties: false },
      get_process_output: { properties: ['process_id', 'tail_lines', 'wait_for', 'wait_pattern', 'wait_timeout'], required: ['process_id'], additionalProperties: false },
      image_search: { properties: ['query', 'count'], required: ['query', 'count'], additionalProperties: false },
      list_connector_tools: { properties: ['service'], required: ['service'], additionalProperties: false },
      list_files: { properties: ['path'], required: [], additionalProperties: false },
      present_file: { properties: ['path'], required: ['path'], additionalProperties: false },
      propose_plan: { properties: ['path', 'highlights'], required: ['path', 'highlights'], additionalProperties: false },
      read_file: { properties: ['path'], required: ['path'], additionalProperties: false },
      start_process: { properties: ['name', 'command', 'cwd', 'startup_wait'], required: ['command'], additionalProperties: false },
      stop_process: { properties: ['process_id'], required: ['process_id'], additionalProperties: false },
      web_search: { properties: ['query', 'depth'], required: ['query', 'depth'], additionalProperties: false },
      write_file: { properties: ['path', 'content'], required: ['path', 'content'], additionalProperties: false },
    })

    const providerFunctionHashes = Object.fromEntries(ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS.map((tool) => [
      tool.function.name,
      createHash('sha256').update(JSON.stringify(tool.function)).digest('hex'),
    ]))
    expect(providerFunctionHashes).toEqual({
      add_voice: 'd69b4479cd8b9c1d6593c0375038d6031ee61ff95fe5ba132aa70b89f15fefd1',
      ask_user: '6d98008f27121f9d125e22a23f9e21680684a0d0f82713baf8d48d344510edb5',
      bash: 'e4a33ae2dcfa5c2c1707e9454efadcf8cd6e1eea0d1b6bb61050d5e763e93281',
      compact: '8cd3b8f196e1cd4d5a43e80b8e149de59c7144d1210312cc5d2a754ad7b45069',
      edit_file: '81ad650900ee6487e2b130aae4a0e3b5f1936c1404f148b4c5d4dc65e6685694',
      fetch_page: '025bd359287c8cc145d9fdfcdfe27fe3bc504a1bbe876c82a59f4ebf26b29a87',
      generate_image: 'd3276580d61b487adf9b6667508a17cf4c38afbdc3aac0aa9cb7bcca50870804',
      generate_speech: 'e234d0152c7fc3ff979567f3f327c92dd6d9262995aaf7b091fcc579e96f761f',
      get_process_output: '06588eb2d48557c784e5bf39952d8e21719bec91704c1f7a5af11edd525c23fa',
      image_search: '22efb49384873f7284ef7942a4c406455fc009e24ce0126c4e052a6d155ac2b8',
      list_connector_tools: 'be3780e1c8a59fd9c1ed5002d6d7558fd99e818b73210fa55758ee8c167025c1',
      list_files: '172d4183fb601b26f9e9e715a35986fbba11469e6d39e694e39bb092a673de7a',
      present_file: '2ccf7b89533808eacc346e07fddae6d59ccb85efc42c03d8971cbef0c24d661c',
      propose_plan: 'c4a062fece343b765a5319705d59f17cbf246d02bc6c82086fdb064ab7f176ea',
      read_file: '871d8e88131bb84837d303e1cd62a0692e66a911fc64ee68a3f59c6b670ac560',
      start_process: '36b2b6694319cc3030b71267cb8a186fa9bae8931e2c365697f43736e572c4e2',
      stop_process: '626dda8de8e29df112db832641209237a46cdcb53040800b99120de59f7141df',
      web_search: '10d37b858c6eee8bc02676823164652c4147c41111891c49e3f07a8ff35e0fdc',
      write_file: 'b2e1d3cb7c65d388532a96d2a1574c5195b2412b5c7180cbb570ca7cad613543',
    })
  })

  it('keeps the exact Arena surface frozen while exposing Anera pagination and atomic multi-edit at runtime', () => {
    const arenaRead = ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS.find((tool) => tool.function.name === 'read_file')!
    const runtimeRead = ANERA_RUNTIME_AGENT_TOOL_DEFINITIONS.find((tool) => tool.function.name === 'read_file')!
    expect(Object.keys((arenaRead.function.parameters as { properties: Record<string, unknown> }).properties)).toEqual(['path'])
    expect(Object.keys((runtimeRead.function.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
      'path', 'offset', 'content_offset', 'limit', 'view',
    ])
    expect(ANERA_RUNTIME_AGENT_TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual(ARENA_ACTIVE_AGENT_TOOL_NAMES)
    const raw = {
      id: 'read-page',
      name: 'read_file',
      arguments: { path: 'large.txt', offset: 2001, content_offset: 80_000, limit: 500, private: true },
    }
    expect(normalizeArenaPublicToolCall(raw).arguments).toEqual({ path: 'large.txt' })
    expect(normalizeAneraRuntimeToolCall(raw).arguments).toEqual({
      path: 'large.txt', offset: 2001, content_offset: 80_000, limit: 500,
    })
    expect(() => validateToolCallArguments(normalizeAneraRuntimeToolCall(raw))).not.toThrow()

    const arenaEdit = ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS.find((tool) => tool.function.name === 'edit_file')!
    const runtimeEdit = ANERA_RUNTIME_AGENT_TOOL_DEFINITIONS.find((tool) => tool.function.name === 'edit_file')!
    expect(Object.keys((arenaEdit.function.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
      'path', 'old_text', 'new_text',
    ])
    expect(Object.keys((runtimeEdit.function.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
      'path', 'old_text', 'new_text', 'reference_resource', 'reference_text', 'edits',
    ])
    const batchEdit = normalizeAneraRuntimeToolCall({
      id: 'batch-edit',
      name: 'edit_file',
      arguments: {
        path: 'deck.html',
        edits: [
          { old_text: 'layout-a layout-b', new_text: 'layout-a' },
          { old_text: 'layout-c layout-d', new_text: 'layout-c' },
        ],
      },
    })
    expect(() => validateToolCallArguments(batchEdit)).not.toThrow()
    expect(() => validateToolCallArguments(normalizeAneraRuntimeToolCall({
      ...batchEdit,
      arguments: { ...batchEdit.arguments, old_text: 'also', new_text: 'invalid' },
    }))).toThrow(/either old_text\/new_text or edits/iu)

    const singleEdit = {
      id: 'single-edit',
      name: 'edit_file',
      arguments: {
        path: 'deck.html',
        edits: [{ old_text: 'position:relative', new_text: 'position:absolute' }],
      },
    }
    // Arena's frozen public schema still strips its unknown `edits` overlay.
    expect(normalizeArenaPublicToolCall(singleEdit).arguments).toEqual({ path: 'deck.html' })
    // The provider-visible Anera overlay can repair this unambiguous model
    // shape before schema validation instead of spending a failed tool step.
    const normalizedSingleEdit = normalizeAneraRuntimeToolCall(singleEdit)
    expect(normalizedSingleEdit.arguments).toEqual({
      path: 'deck.html',
      old_text: 'position:relative',
      new_text: 'position:absolute',
    })
    expect(() => validateToolCallArguments(normalizedSingleEdit)).not.toThrow()

    const arenaList = ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS.find((tool) => tool.function.name === 'list_files')!
    const runtimeList = ANERA_RUNTIME_AGENT_TOOL_DEFINITIONS.find((tool) => tool.function.name === 'list_files')!
    expect(Object.keys((arenaList.function.parameters as { properties: Record<string, unknown> }).properties)).toEqual(['path'])
    expect(Object.keys((runtimeList.function.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
      'path', 'cursor', 'limit',
    ])
    const rawList = {
      id: 'list-page',
      name: 'list_files',
      arguments: { path: 'src', cursor: 'opaque-cursor', limit: 300, private: true },
    }
    expect(normalizeArenaPublicToolCall(rawList).arguments).toEqual({ path: 'src' })
    expect(normalizeAneraRuntimeToolCall(rawList).arguments).toEqual({
      path: 'src', cursor: 'opaque-cursor', limit: 300,
    })
    expect(() => validateToolCallArguments(normalizeAneraRuntimeToolCall(rawList))).not.toThrow()
  })

  it('instructs the reference-contract phase to omit exact tokens not consumed by connected DOM CSS', () => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.function.name === 'record_reference_style')
    expect(definition).toBeDefined()
    expect(definition!.function.description).toMatch(/exact mode[\s\S]*real, non-inert DOM[\s\S]*merely declared[\s\S]*never consumed by a DOM-connected rule/iu)
    const properties = (definition!.function.parameters as {
      properties: Record<string, { items?: { description?: string } }>
    }).properties
    expect(properties.colors?.items?.description).toMatch(/DOM-connected rule[\s\S]*omit values from unused variable declarations/iu)
    expect(properties.fonts?.items?.description).toMatch(/font-family[\s\S]*DOM-connected rule/iu)
    expect(properties.required_markers?.items?.description).toMatch(/consumed CSS variable[\s\S]*real DOM relationship[\s\S]*compound selectors/iu)
    expect(properties.required_markers?.items?.description).toMatch(/custom elements[\s\S]*deck-stage[\s\S]*deck-stage > section\.slide/iu)
  })

  it('enforces active ask_user identity uniqueness and legacy-to-active normalization', () => {
    const duplicateQuestionIds = normalizeArenaPublicToolCall({
      id: 'ask-duplicate-questions',
      name: 'ask_user',
      arguments: {
        questions: [
          { id: 'same', question: 'First?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
          { id: 'same', question: 'Second?', options: [{ id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
        ],
      },
    })
    expect(() => validateToolCallArguments(duplicateQuestionIds)).toThrow(/question IDs must be unique/)

    const duplicateOptionIds = normalizeArenaPublicToolCall({
      id: 'ask-duplicate-options',
      name: 'ask_user',
      arguments: {
        questions: [{ id: 'q', question: 'Choose?', options: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }] }],
      },
    })
    expect(() => validateToolCallArguments(duplicateOptionIds)).toThrow(/option IDs must be unique/)

    expect(normalizeArenaPublicToolCall({
      id: 'legacy-active',
      name: 'ask_user',
      arguments: {
        questions: [{ question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }], allow_free_text: false }],
        private: 'drop-me',
      },
    }).arguments).toEqual({
      questions: [{
        id: 'question-1',
        question: 'Choose?',
        options: [
          { id: 'question-1-option-1', label: 'A' },
          { id: 'question-1-option-2', label: 'B' },
        ],
        allowCustomResponse: false,
      }],
    })
    expect(normalizeArenaPublicToolCall({
      id: 'legacy-connector-field',
      name: 'list_connector_tools',
      arguments: { connector_slug: ' github ', ignored: true },
    }).arguments).toEqual({ service: ' github ' })
  })

  it('bounds response bodies while streaming and cancels bytes beyond the limit', async () => {
    const result = await readBoundedResponseText(new Response('A'.repeat(10_000)), 128)
    expect(result).toEqual({ text: 'A'.repeat(128), bytesRead: 128, truncated: true })
    await expect(readBoundedResponseBytes(new Response(Uint8Array.from([1, 2, 3, 4])), 4)).resolves.toEqual(Buffer.from([1, 2, 3, 4]))
    await expect(readBoundedResponseBytes(new Response(Uint8Array.from([1, 2, 3, 4])), 3)).rejects.toThrow(/exceeds the 3-byte limit/)
  })

  it('publishes the exact Arena shell, package, build, start, deploy, and web argument schemas', () => {
    const definitions = new Map(TOOL_DEFINITIONS.map((tool) => [tool.function.name, tool.function.parameters]))
    const publicArenaTools = [
      'create_file',
      'edit_file',
      'read_file',
      'list_files',
      'delete_file',
      'install_npm_packages',
      'build_project',
      'build_and_start',
      'deploy_project',
      'apply_patch',
      'bash',
      'shell_command',
      'update_plan',
      'grep_files',
      'glob_files',
      'web_search',
      'web_fetch',
      'fetch_media',
      'generate_image',
    ]
    expect([...definitions.keys()]).toEqual(expect.arrayContaining(publicArenaTools))
    expect([...definitions.keys()].filter((name) => publicArenaTools.includes(name))).toHaveLength(publicArenaTools.length)
    expect(definitions.get('install_npm_packages')).toEqual({
      type: 'object',
      properties: { packages: { type: 'array', items: { type: 'string' } } },
      required: ['packages'],
      additionalProperties: false,
    })
    expect(definitions.get('build_project')).toEqual({
      type: 'object', properties: {}, required: [], additionalProperties: false,
    })
    expect(definitions.get('build_and_start')).toEqual({
      type: 'object',
      properties: { description: { type: 'string' } },
      required: [],
      additionalProperties: false,
    })
    expect(definitions.get('deploy_project')).toEqual({
      type: 'object', properties: {}, required: [], additionalProperties: false,
    })
    expect(definitions.get('bash')).toEqual({
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
        timeout: { type: 'number' },
        workdir: { type: 'string' },
      },
      required: ['command'],
      additionalProperties: true,
    })
    expect(definitions.get('shell_command')).toEqual({
      type: 'object',
      properties: { command: { type: 'string' }, workdir: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    })
    expect(definitions.get('web_search')).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string' },
        depth: { type: 'string', enum: ['1', '2', '3'] },
      },
      required: ['query', 'depth'],
      additionalProperties: false,
    })
    expect(definitions.get('web_fetch')).toEqual({
      type: 'object',
      properties: {
        url: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'text', 'html'] },
      },
      required: ['url'],
      additionalProperties: false,
    })
    expect(definitions.get('fetch_media')).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string' },
        media_type: { type: 'string', enum: ['image', 'video', 'both'], default: 'both' },
        count: { type: 'number', default: 6 },
        orientation: { type: 'string', enum: ['any', 'landscape', 'portrait', 'square'], default: 'any' },
        size: { type: 'string', enum: ['any', 'large', 'medium', 'small'], default: 'any' },
        locale: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    })
    expect(definitions.get('generate_image')).toEqual({
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['file_path', 'prompt'],
      additionalProperties: false,
    })
    expect([...definitions.keys()]).not.toEqual(expect.arrayContaining([
      'package_install',
      'start_process',
      'preview_website',
      'search_web',
    ]))
  })

  it('normalizes public calls like the bundled Arena argument parser before persistence', () => {
    expect(normalizeArenaPublicToolCall({
      id: 'call_search_number',
      name: 'web_search',
      arguments: { query: 'RFC 8297', depth: 2, ignored: true },
    }).arguments).toEqual({ query: 'RFC 8297', depth: '2' })
    expect(normalizeArenaPublicToolCall({
      id: 'call_media_defaults',
      name: 'fetch_media',
      arguments: { query: 'forest' },
    }).arguments).toEqual({
      query: 'forest',
      media_type: 'both',
      count: 6,
      orientation: 'any',
      size: 'any',
    })
    expect(normalizeArenaPublicToolCall({
      id: 'call_plan_strip',
      name: 'update_plan',
      arguments: { plan: [{ step: 'Inspect', status: 'pending', private: true }], unknown: 'drop' },
    }).arguments).toEqual({ plan: [{ step: 'Inspect', status: 'pending' }] })
    expect(normalizeArenaPublicToolCall({
      id: 'call_bash_passthrough',
      name: 'bash',
      arguments: { command: 'true', provider_extension: { trace: true } },
    }).arguments).toEqual({ command: 'true', cwd: '/home/user', timeout: 30 })
    const malformed = {
      id: 'call_invalid_json',
      name: 'create_file',
      arguments: { _parse_error: 'invalid', _raw: '{' },
    }
    expect(normalizeArenaPublicToolCall(malformed)).toBe(malformed)
    expect(normalizeArenaPublicToolCall({
      id: 'call_extension',
      name: 'browser',
      arguments: { action: 'snapshot', extension: true },
    }).arguments).toEqual({ action: 'snapshot', extension: true })
  })

  it('removes only a redundant public-workspace cd from a root-scoped Bash command', () => {
    expect(stripRedundantArenaWorkspaceCd('cd /home/user && python3 analyze.py')).toBe('python3 analyze.py')
    expect(stripRedundantArenaWorkspaceCd('cd ~; npm test')).toBe('npm test')
    expect(stripRedundantArenaWorkspaceCd('cd /home/user/uploads && node test.mjs')).toBe('cd /home/user/uploads && node test.mjs')
    expect(stripRedundantArenaWorkspaceCd('printf /home/user')).toBe('printf /home/user')
  })

  it('rewrites Arena public workspace paths for commands already running at the workspace root', () => {
    expect(rewriteArenaWorkspaceCommandPaths('python3 -m http.server --directory /home/user/site')).toBe('python3 -m http.server --directory ./site')
    expect(rewriteArenaWorkspaceCommandPaths("rm -f '/home/user/old file.txt' ~/temp.txt")).toBe("rm -f './old file.txt' ./temp.txt")
    expect(rewriteArenaWorkspaceCommandPaths('printf https://example.com/home/user/doc')).toBe('printf https://example.com/home/user/doc')
    expect(rewriteArenaWorkspaceCommandPaths('printf /home/username')).toBe('printf /home/username')
  })

  it('validates every tool call against its published schema before execution', async () => {
    expect(() => validateToolCallArguments({
      id: 'call_missing',
      name: 'create_file',
      arguments: { path: 'output.txt' },
    })).toThrow(/content: required property is missing/)
    expect(() => validateToolCallArguments({
      id: 'call_timeout_type',
      name: 'bash',
      arguments: { command: 'true', timeout: 'fast' },
    })).toThrow(/timeout: expected integer/)
    expect(() => validateToolCallArguments({
      id: 'call_bash_passthrough',
      name: 'bash',
      arguments: { command: 'true', provider_extension: { trace: true } },
    })).toThrow(/provider_extension: additional property is not allowed/)
    expect(() => validateToolCallArguments({
      id: 'call_extra',
      name: 'list_files',
      arguments: { unexpected: true },
    })).toThrow(/additional property is not allowed/)
    expect(() => validateToolCallArguments({
      id: 'call_pattern',
      name: 'grep_files',
      arguments: { pattern: 'x'.repeat(201) },
    })).toThrow(/pattern: must contain at most 200 characters/)
    expect(() => validateToolCallArguments({
      id: 'call_empty_pattern',
      name: 'glob_files',
      arguments: { pattern: '' },
    })).toThrow(/pattern: must contain at least 1 character/)
    expect(() => validateToolCallArguments({
      id: 'call_enum',
      name: 'install_npm_packages',
      arguments: { packages: 'vite' },
    })).toThrow(/packages: expected array/)
    expect(() => validateToolCallArguments({
      id: 'call_search_depth',
      name: 'web_search',
      arguments: { query: 'RFC 8297', depth: 2 },
    })).toThrow(/depth: expected string/)
    expect(() => validateToolCallArguments({
      id: 'call_search_depth_enum',
      name: 'web_search',
      arguments: { query: 'RFC 8297', depth: '4' },
    })).toThrow(/depth: expected one of 1, 2, 3/)
    expect(() => validateToolCallArguments({
      id: 'call_fetch_format_enum',
      name: 'web_fetch',
      arguments: { url: 'https://example.com', format: 'json' },
    })).toThrow(/format: expected one of markdown, text, html/)
    expect(() => validateToolCallArguments({
      id: 'call_fetch_page_format_enum',
      name: 'fetch_page',
      arguments: { url: 'https://example.com', format: 'html' },
    })).toThrow(/format: expected one of markdown, raw/)
    expect(() => validateToolCallArguments({
      id: 'call_media_type_enum',
      name: 'fetch_media',
      arguments: { query: 'forest', media_type: 'audio' },
    })).toThrow(/media_type: expected one of image, video, both/)
    expect(() => validateToolCallArguments({
      id: 'call_media_count_type',
      name: 'fetch_media',
      arguments: { query: 'forest', count: '6' },
    })).toThrow(/count: expected number/)
    expect(() => validateToolCallArguments({
      id: 'call_image_missing_prompt',
      name: 'generate_image',
      arguments: { file_path: 'hero.png' },
    })).toThrow(/prompt: required property is missing/)
    expect(() => validateToolCallArguments({
      id: 'call_plan_shape',
      name: 'update_plan',
      arguments: { plan: [{ status: 'pending' }] },
    })).toThrow(/plan\[0\]\.step: required property is missing/)
    expect(() => validateToolCallArguments({
      id: 'call_plan_type',
      name: 'update_plan',
      arguments: { plan: 'not-an-array' },
    })).toThrow(/plan: expected array/)
    const optionalNull = { id: 'call_null', name: 'bash', arguments: { command: 'true', timeout: null } }
    expect(() => validateToolCallArguments(optionalNull)).not.toThrow()
    expect(optionalNull.arguments).toEqual({ command: 'true' })

    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const result = await tools.execute({
      id: 'call_parse',
      name: 'build_and_start',
      arguments: { _parse_error: 'Invalid JSON tool arguments', _raw: '{' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ isError: true, content: expect.stringMatching(/invalid JSON arguments/) })
    expect((await store.get(session.summary.id)).website.status).toBe('stopped')
  })

  it('rejects npm options, URLs, paths, shell payloads, and spaced ranges before installation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-packages-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_packages',
      stepId: 'step_packages',
      signal: new AbortController().signal,
    }

    for (const spec of [
      '--legacy-peer-deps',
      'https://example.com/pkg.tgz',
      'file:../package',
      '../package',
      'vite;touch-owned',
      'vite@^5 || ^6',
    ]) {
      const result = await tools.execute({
        id: `call_reject_${spec.length}`,
        name: 'install_npm_packages',
        arguments: { packages: [spec] },
      }, context)
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content)).toMatchObject({
        status: 'error',
        message: expect.stringMatching(/npm package spec|npm registry package specs/),
      })
    }
    for (const [spec, hint] of [
      ['openpyxl', 'exceljs@4.4.0'],
      ['python-docx', 'docx@9.5.1'],
      ['python-pptx', 'pptxgenjs@4.0.1'],
    ]) {
      const result = await tools.execute({
        id: `call_python_package_${spec}`,
        name: 'install_npm_packages',
        arguments: { packages: [spec] },
      }, context)
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content)).toEqual({
        status: 'error',
        message: expect.stringContaining(hint),
      })
    }
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'touch-owned'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('verifies requested unscoped and scoped npm package manifests instead of trusting exit code alone', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-package-verification-'))
    roots.push(root)
    await mkdir(resolve(root, 'node_modules/exceljs'), { recursive: true })
    await mkdir(resolve(root, 'node_modules/@scope/pkg'), { recursive: true })
    await mkdir(resolve(root, 'node_modules/wrong-name'), { recursive: true })
    await writeFile(resolve(root, 'node_modules/exceljs/package.json'), JSON.stringify({ name: 'exceljs', version: '4.4.0' }))
    await writeFile(resolve(root, 'node_modules/@scope/pkg/package.json'), JSON.stringify({ name: '@scope/pkg', version: '2.1.0' }))
    await writeFile(resolve(root, 'node_modules/wrong-name/package.json'), JSON.stringify({ name: 'different', version: '1.0.0' }))

    await expect(verifyInstalledNpmPackages(root, [
      'exceljs@4.4.0',
      '@scope/pkg@^2.0.0',
      'wrong-name',
      'missing-package@1.0.0',
    ])).resolves.toEqual({
      installed: ['exceljs@4.4.0', '@scope/pkg@2.1.0'],
      issues: [
        'wrong-name manifest reports a different package name',
        'missing-package package manifest is missing',
      ],
    })
  })

  it('retries an exit-zero but incomplete npm install inside one tool call and returns only a verified success', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-package-retry-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const workspace = store.workspaceDir(session.summary.id)
    let attempt = 0
    const runCommand = vi.fn(async () => {
      attempt += 1
      if (attempt === 2) {
        await mkdir(resolve(workspace, 'node_modules/exceljs'), { recursive: true })
        await writeFile(resolve(workspace, 'node_modules/exceljs/package.json'), JSON.stringify({ name: 'exceljs', version: '4.4.0' }))
      }
      return {
        stdout: attempt === 1 ? 'changed 5 packages\n' : 'added 97 packages\n',
        stderr: attempt === 1 ? 'npm warn tar TAR_ENTRY_ERROR ENOENT node_modules/exceljs/dist\n' : '',
        exitCode: 0,
        signal: null,
        durationMs: 10,
        truncated: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      }
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { runCommand },
    )

    const result = await tools.execute({
      id: 'call_install_retry',
      name: 'install_npm_packages',
      arguments: { packages: ['exceljs@4.4.0'] },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_install_retry',
      stepId: 'step_install_retry',
      signal: new AbortController().signal,
    })

    expect(runCommand).toHaveBeenCalledTimes(2)
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      stdout: 'Harness retried one incomplete or transient npm install attempt.\nadded 97 packages\nVerified installed packages: exceljs@4.4.0',
    })
  })

  it('builds projects with Arena-shaped results and preserves success, failure, and no-script branches', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-build-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const executeBuild = async (sessionId: string, callId: string) => await tools.execute({
      id: callId,
      name: 'build_project',
      arguments: {},
    }, {
      sessionId,
      turnId: `turn_${callId}`,
      stepId: `step_${callId}`,
      signal: new AbortController().signal,
    })

    const success = await store.create()
    await writeFile(resolve(store.workspaceDir(success.summary.id), 'package.json'), JSON.stringify({
      scripts: {
        build: `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','BUILT')"`,
      },
    }))
    const successResult = await executeBuild(success.summary.id, 'call_build_success')
    expect(successResult.isError).toBe(false)
    expect(JSON.parse(successResult.content)).toEqual({
      status: 'success',
      stdout: expect.stringContaining('node -e'),
      stderr: '',
    })
    await expect(readFile(resolve(store.workspaceDir(success.summary.id), 'dist/index.html'), 'utf8')).resolves.toBe('BUILT')
    expect((await store.get(success.summary.id)).artifacts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'dist/index.html' }),
    ]))
    expect((await store.events(success.summary.id)).some((event) => (
      event.type === 'file.changed' && event.data.path === 'dist/index.html'
    ))).toBe(false)

    const failed = await store.create()
    await writeFile(resolve(store.workspaceDir(failed.summary.id), 'package.json'), JSON.stringify({
      scripts: { build: `node -e "console.error('BUILD_BROKEN');process.exit(7)"` },
    }))
    const failedResult = await executeBuild(failed.summary.id, 'call_build_failed')
    expect(failedResult.isError).toBe(true)
    expect(JSON.parse(failedResult.content)).toMatchObject({
      status: 'error',
      message: 'Project build exited with code 7',
      stderr: expect.stringContaining('BUILD_BROKEN'),
    })

    const staticSite = await store.create()
    await writeFile(resolve(store.workspaceDir(staticSite.summary.id), 'index.html'), '<h1>STATIC</h1>')
    expect(JSON.parse((await executeBuild(staticSite.summary.id, 'call_build_static')).content)).toEqual({
      status: 'success',
      stdout: 'No build script configured; build stage skipped.\n',
      stderr: '',
    })

    const unrunnable = await store.create()
    const unrunnableResult = await executeBuild(unrunnable.summary.id, 'call_build_unrunnable')
    expect(unrunnableResult.isError).toBe(true)
    expect(JSON.parse(unrunnableResult.content)).toEqual({
      status: 'error',
      message: 'No build script, runnable npm script, or HTML entry file found',
    })
  })

  it('publishes static and managed Websites while persisting Process, Website, and Artifact state', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-start-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const processes = persistedProcessManager(store)
    const tools = new ToolExecutor(
      store,
      processes,
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const executeStart = async (sessionId: string, callId: string, description?: string) => await tools.execute({
      id: callId,
      name: 'build_and_start',
      arguments: description ? { description } : {},
    }, {
      sessionId,
      turnId: `turn_${callId}`,
      stepId: `step_${callId}`,
      signal: new AbortController().signal,
    })

    const staticSite = await store.create()
    const staticWorkspace = store.workspaceDir(staticSite.summary.id)
    await writeFile(resolve(staticWorkspace, 'index.html'), '<h1>STATIC READY</h1>')
    const staticResult = await executeStart(staticSite.summary.id, 'call_start_static', 'static probe')
    expect(staticResult.isError).toBe(false)
    expect(JSON.parse(staticResult.content)).toMatchObject({
      status: 'success',
      previewUrl: `/workspace/${staticSite.summary.id}/preview/index.html`,
      buildLatencyMs: expect.any(Number),
    })
    const staticWebsite = (await store.get(staticSite.summary.id)).website
    expect(staticWebsite).toMatchObject({ status: 'running', entryPath: 'index.html' })
    expect(staticWebsite.processId).toBeUndefined()
    expect((await store.events(staticSite.summary.id)).find((event) => event.type === 'website.updated')).toMatchObject({
      turnId: 'turn_call_start_static',
      stepId: 'step_call_start_static',
      callId: 'call_start_static',
    })

    const serverCode = "const http=require('http');const server=http.createServer((request,response)=>response.end('MANAGED READY'));server.listen(0,'127.0.0.1',()=>console.log('listening on '+server.address().port))"
    const managed = await store.create()
    await writeFile(resolve(store.workspaceDir(managed.summary.id), 'package.json'), JSON.stringify({
      scripts: { start: `node -e ${JSON.stringify(serverCode)}` },
    }))
    const managedResult = await executeStart(managed.summary.id, 'call_start_managed', 'managed probe')
    expect(managedResult.isError).toBe(false)
    expect(JSON.parse(managedResult.content)).toMatchObject({
      status: 'success', previewUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), buildLatencyMs: expect.any(Number),
    })
    const firstWebsite = (await store.get(managed.summary.id)).website
    expect(firstWebsite).toMatchObject({ status: 'running', processId: expect.stringMatching(/^proc_/), port: expect.any(Number) })
    await expectEventually(async () => {
      expect((await store.get(managed.summary.id)).processes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstWebsite.processId, status: 'running', port: firstWebsite.port }),
      ]))
    })

    const restarted = await executeStart(managed.summary.id, 'call_start_replacement', 'replacement probe')
    expect(restarted.isError).toBe(false)
    const replacementWebsite = (await store.get(managed.summary.id)).website
    expect(replacementWebsite.processId).not.toBe(firstWebsite.processId)
    await expectEventually(async () => {
      const records = (await store.get(managed.summary.id)).processes
      expect(records.find((process) => process.id === firstWebsite.processId)?.status).toBe('stopped')
      expect(records.find((process) => process.id === replacementWebsite.processId)?.status).toBe('running')
    })
    await expectEventually(async () => {
      const events = await store.events(managed.summary.id)
      const processId = (event: typeof events[number]) => (event.data as { record?: { id?: string } }).record?.id
      const firstStarted = events.find((event) => event.type === 'process.started' && processId(event) === firstWebsite.processId)
      const replacementStarted = events.find((event) => event.type === 'process.started' && processId(event) === replacementWebsite.processId)
      const firstStopped = events.find((event) => event.type === 'process.stopped' && processId(event) === firstWebsite.processId)
      expect(firstStarted).toMatchObject({
        turnId: 'turn_call_start_managed',
        stepId: 'step_call_start_managed',
        callId: 'call_start_managed',
      })
      expect(firstStopped).toMatchObject({
        turnId: 'turn_call_start_replacement',
        stepId: 'step_call_start_replacement',
        callId: 'call_start_replacement',
      })
      expect(replacementStarted).toMatchObject({
        turnId: 'turn_call_start_replacement',
        stepId: 'step_call_start_replacement',
        callId: 'call_start_replacement',
      })
    })
    await processes.stopAll(managed.summary.id)
    await store.update(managed.summary.id, () => {})
  })

  it('reports build/start stages and cleans up an unhealthy managed server', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-start-failure-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const processes = persistedProcessManager(store)
    const tools = new ToolExecutor(
      store,
      processes,
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { websiteReadyTimeoutMs: 180 },
    )
    const executeStart = async (sessionId: string, callId: string) => await tools.execute({
      id: callId, name: 'build_and_start', arguments: {},
    }, {
      sessionId,
      turnId: `turn_${callId}`,
      stepId: `step_${callId}`,
      signal: new AbortController().signal,
    })

    const buildFailure = await store.create()
    await writeFile(resolve(store.workspaceDir(buildFailure.summary.id), 'package.json'), JSON.stringify({
      scripts: {
        build: `node -e "console.error('BUILD_STAGE_BROKEN');process.exit(6)"`,
        start: `node -e "setInterval(()=>{},1000)"`,
      },
    }))
    const buildResult = await executeStart(buildFailure.summary.id, 'call_start_build_failure')
    expect(buildResult.isError).toBe(true)
    expect(JSON.parse(buildResult.content)).toMatchObject({
      status: 'error', stage: 'building', logTail: expect.stringContaining('BUILD_STAGE_BROKEN'),
    })
    expect((await store.get(buildFailure.summary.id)).processes).toEqual([])

    const startFailure = await store.create()
    await writeFile(resolve(store.workspaceDir(startFailure.summary.id), 'package.json'), JSON.stringify({
      scripts: { start: `node -e "console.error('START_STAGE_BROKEN');process.exit(3)"` },
    }))
    const startResult = await executeStart(startFailure.summary.id, 'call_start_process_failure')
    expect(startResult.isError).toBe(true)
    expect(JSON.parse(startResult.content)).toMatchObject({
      status: 'error', stage: 'starting-server', logTail: expect.stringContaining('START_STAGE_BROKEN'),
    })
    await expectEventually(async () => {
      expect((await store.get(startFailure.summary.id)).processes).toEqual([
        expect.objectContaining({ status: 'failed', exitCode: 3 }),
      ])
    })
    expect((await store.get(startFailure.summary.id)).website.status).toBe('stopped')

    const unhealthy = await store.create()
    await writeFile(resolve(store.workspaceDir(unhealthy.summary.id), 'package.json'), JSON.stringify({
      scripts: { start: `node -e "console.log('listening on 65534');setInterval(()=>{},1000)"` },
    }))
    const unhealthyResult = await executeStart(unhealthy.summary.id, 'call_start_unhealthy')
    expect(unhealthyResult.isError).toBe(true)
    expect(JSON.parse(unhealthyResult.content)).toMatchObject({
      status: 'error', stage: 'starting-server', message: expect.stringMatching(/did not report a reachable port/),
    })
    await expectEventually(async () => {
      const records = (await store.get(unhealthy.summary.id)).processes
      expect(records).toEqual([expect.objectContaining({ status: 'stopped' })])
      expect(records[0].port).toBeUndefined()
    })
    const liveRecords = processes.list(unhealthy.summary.id)
    expect(liveRecords).toEqual([expect.objectContaining({ status: 'stopped' })])
    expect(liveRecords[0].port).toBeUndefined()
  })

  it('approval-gates static deployments, keeps stable identity across redeploys, and preserves the last good revision on failure', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-deploy-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const approval = vi.fn(async () => true)
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      approval,
    )
    const executeDeploy = async (sessionId: string, callId: string) => await tools.execute({
      id: callId,
      name: 'deploy_project',
      arguments: {},
    }, {
      sessionId,
      turnId: `turn_${callId}`,
      stepId: `step_${callId}`,
      signal: new AbortController().signal,
    })

    const deniedSession = await store.create()
    const deniedTools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      vi.fn(async () => false),
    )
    await writeFile(resolve(store.workspaceDir(deniedSession.summary.id), 'index.html'), '<h1>DENIED</h1>')
    const denied = await deniedTools.execute({ id: 'call_deploy_denied', name: 'deploy_project', arguments: {} }, {
      sessionId: deniedSession.summary.id,
      turnId: 'turn_deploy_denied',
      stepId: 'step_deploy_denied',
      signal: new AbortController().signal,
    })
    expect(denied).toEqual({
      content: JSON.stringify({ status: 'error', message: 'User denied project deployment' }),
      isError: true,
    })
    expect((await store.get(deniedSession.summary.id)).deployment).toMatchObject({ status: 'not_deployed', revision: 0 })
    expect((await store.events(deniedSession.summary.id)).filter((event) => event.type === 'deployment.updated')).toHaveLength(0)

    const session = await store.create()
    const workspace = store.workspaceDir(session.summary.id)
    await writeFile(resolve(workspace, 'index.html'), '<h1>DEPLOY V1</h1>')
    await writeFile(resolve(workspace, 'styles.css'), 'h1 { color: green; }\n')
    await writeFile(resolve(workspace, 'package.json'), '{"private":true}\n')
    const firstResult = await executeDeploy(session.summary.id, 'call_deploy_first')
    expect(firstResult).toEqual({ content: '{"status":"success"}', isError: false })
    expect(approval).toHaveBeenCalledOnce()
    const first = (await store.get(session.summary.id)).deployment
    expect(first).toMatchObject({
      id: expect.stringMatching(/^dep_[a-z0-9]{20}$/),
      status: 'deployed',
      visibility: 'local',
      revision: 1,
      entryPath: 'index.html',
      fileCount: 2,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      url: expect.stringMatching(new RegExp(`/deployments/${session.summary.id}/$`)),
    })
    await expect(readFile(resolve(store.deploymentRevisionDir(session.summary.id, 1), 'index.html'), 'utf8')).resolves.toContain('DEPLOY V1')
    await expect(readFile(resolve(store.deploymentRevisionDir(session.summary.id, 1), 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(resolve(workspace, 'index.html'), '<h1>DEPLOY V2</h1>')
    const secondResult = await executeDeploy(session.summary.id, 'call_deploy_second')
    expect(secondResult).toEqual({ content: '{"status":"success"}', isError: false })
    const second = (await store.get(session.summary.id)).deployment
    expect(second).toMatchObject({ id: first.id, url: first.url, status: 'deployed', revision: 2 })
    expect(second.contentHash).not.toBe(first.contentHash)
    await expect(readFile(resolve(store.deploymentRevisionDir(session.summary.id, 1), 'index.html'), 'utf8')).resolves.toContain('DEPLOY V1')
    await expect(readFile(resolve(store.deploymentRevisionDir(session.summary.id, 2), 'index.html'), 'utf8')).resolves.toContain('DEPLOY V2')

    await writeFile(resolve(workspace, 'package.json'), JSON.stringify({
      scripts: { build: `node -e "console.error('DEPLOY_BUILD_BROKEN');process.exit(9)"` },
    }))
    const failedResult = await executeDeploy(session.summary.id, 'call_deploy_failed')
    expect(failedResult.isError).toBe(true)
    expect(JSON.parse(failedResult.content)).toMatchObject({
      status: 'error', message: 'Project build exited with code 9', stderr: expect.stringContaining('DEPLOY_BUILD_BROKEN'),
    })
    const failed = (await store.get(session.summary.id)).deployment
    expect(failed).toMatchObject({
      id: first.id,
      url: first.url,
      status: 'failed',
      revision: 2,
      entryPath: 'index.html',
      contentHash: second.contentHash,
      error: 'Project build exited with code 9',
    })
    await expect(readFile(resolve(store.deploymentRevisionDir(session.summary.id, 3), 'index.html'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const observations = (await store.events(session.summary.id)).filter((event) => event.type === 'deployment.updated')
    expect(observations.map((event) => event.data.action)).toEqual([
      'building', 'deploying', 'deployed', 'building', 'deploying', 'redeployed', 'building', 'build_failed',
    ])
    expect(observations.map((event) => event.callId)).toEqual([
      'call_deploy_first', 'call_deploy_first', 'call_deploy_first',
      'call_deploy_second', 'call_deploy_second', 'call_deploy_second',
      'call_deploy_failed', 'call_deploy_failed',
    ])

    const reloaded = new SessionStore(root, 'test-model')
    await reloaded.initialize()
    expect((await reloaded.get(session.summary.id)).deployment).toEqual(failed)
  })

  it('materializes exact-reference fonts into the immutable deployment entry only', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-deploy-exact-fonts-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const workspace = store.workspaceDir(session.summary.id)
    const entryPath = 'verified-deck.html'
    const sourceHtml = '<!doctype html><html><head><title>Exact</title><link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head><body>EXACT DEPLOYMENT</body></html>'
    const decoyHtml = '<!doctype html><title>DECOY</title>'
    await writeFile(resolve(workspace, entryPath), sourceHtml)
    await writeFile(resolve(workspace, 'index.html'), decoyHtml)
    const fixture = await installExactReferenceVisualFixture(store, session.summary.id)
    const verificationCallId = 'call_deploy_exact_verifier'
    await store.update(session.summary.id, (state) => {
      state.messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: verificationCallId,
          type: 'function',
          function: { name: 'verify_reference_style', arguments: JSON.stringify({ path: entryPath }) },
        }],
      }, {
        role: 'tool',
        tool_call_id: verificationCallId,
        tool_result_status: 'succeeded',
        content: JSON.stringify({
          status: 'success',
          path: entryPath,
          fidelity: 'pass',
          score: 100,
          artifact_hash: createHash('sha256').update(sourceHtml).digest('base64url'),
          reference_sha256: fixture.sourceEvidenceSha256,
          reference_font_manifest_sha256: fixture.fontEvidence.manifestSha256,
        }),
      })
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      vi.fn(async () => true),
    )

    const deployed = await tools.execute({
      id: 'call_deploy_exact_fonts',
      name: 'deploy_project',
      arguments: {},
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_deploy_exact_fonts',
      stepId: 'step_deploy_exact_fonts',
      signal: new AbortController().signal,
    })
    expect(deployed).toEqual({ content: '{"status":"success"}', isError: false })

    const deliveredHtml = await readFile(
      resolve(store.deploymentRevisionDir(session.summary.id, 1), entryPath),
      'utf8',
    )
    expect(deliveredHtml).toContain(
      `<style data-anera-reference-fonts data-manifest-sha256="${fixture.fontEvidence.manifestSha256}">`,
    )
    expect(deliveredHtml).toContain('EXACT DEPLOYMENT')
    expect(deliveredHtml).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/u)
    expect(await readFile(resolve(workspace, entryPath), 'utf8')).toBe(sourceHtml)
    await expect(readFile(resolve(store.deploymentRevisionDir(session.summary.id, 1), 'index.html'), 'utf8'))
      .resolves.toBe(decoyHtml)
    expect((await store.get(session.summary.id)).deployment).toMatchObject({
      status: 'deployed',
      revision: 1,
      entryPath,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      bytes: Buffer.byteLength(deliveredHtml) + Buffer.byteLength(decoyHtml),
    })
  })

  it('persists Arena-compatible plan updates with stable item identity and append-only snapshots', async () => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.function.name === 'update_plan')
    expect(definition?.function.parameters).toEqual({
      type: 'object',
      properties: {
        explanation: { type: 'string' },
        plan: {
          type: 'array',
          items: {
            type: 'object',
            properties: { step: { type: 'string' }, status: { type: 'string' } },
            required: ['step', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['plan'],
      additionalProperties: false,
    })

    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-plan-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const baseContext = {
      sessionId: session.summary.id,
      turnId: 'turn_plan_1',
      stepId: 'step_plan_1',
      signal: new AbortController().signal,
    }
    const initial = await tools.execute({
      id: 'call_plan_1',
      name: 'update_plan',
      arguments: {
        explanation: 'Start with inspection.',
        plan: [
          { step: 'Inspect files', status: 'in_progress' },
          { step: 'Verify output', status: 'pending' },
        ],
      },
    }, baseContext)
    expect(initial).toEqual({ content: '{"status":"success"}', isError: false })
    const firstPlan = (await store.get(session.summary.id)).plan
    expect(firstPlan).toMatchObject({
      explanation: 'Start with inspection.',
      version: 1,
      items: [
        { id: expect.stringMatching(/^plan_[a-z0-9]{20}$/), step: 'Inspect files', status: 'in_progress' },
        { id: expect.stringMatching(/^plan_[a-z0-9]{20}$/), step: 'Verify output', status: 'pending' },
      ],
    })

    const advanced = await tools.execute({
      id: 'call_plan_2',
      name: 'update_plan',
      arguments: {
        plan: [
          { step: 'Inspect files', status: 'completed' },
          { step: 'Verify output', status: 'in_progress' },
        ],
      },
    }, { ...baseContext, turnId: 'turn_plan_2', stepId: 'step_plan_2' })
    expect(advanced).toEqual({ content: '{"status":"success"}', isError: false })
    const secondPlan = (await store.get(session.summary.id)).plan
    expect(secondPlan).toMatchObject({ explanation: 'Start with inspection.', version: 2 })
    expect(secondPlan?.items.map((item) => item.id)).toEqual(firstPlan?.items.map((item) => item.id))
    expect(secondPlan?.items.map((item) => item.status)).toEqual(['completed', 'in_progress'])

    const priorEvents = (await store.events(session.summary.id)).filter((event) => event.type === 'plan.updated')
    expect(priorEvents).toHaveLength(2)
    expect(priorEvents.map((event) => [event.turnId, event.callId, (event.data.plan as { version: number }).version])).toEqual([
      ['turn_plan_1', 'call_plan_1', 1],
      ['turn_plan_2', 'call_plan_2', 2],
    ])

    const invalid = await tools.execute({
      id: 'call_plan_invalid',
      name: 'update_plan',
      arguments: { plan: [{ step: 'Broken state', status: 'active' }] },
    }, { ...baseContext, turnId: 'turn_plan_3', stepId: 'step_plan_3' })
    expect(invalid.isError).toBe(true)
    expect(JSON.parse(invalid.content)).toEqual({
      status: 'error',
      message: 'plan[0].status must be pending, in_progress, or completed',
    })
    expect((await store.get(session.summary.id)).plan).toEqual(secondPlan)
    expect((await store.events(session.summary.id)).filter((event) => event.type === 'plan.updated')).toHaveLength(2)

    const reloaded = new SessionStore(root, 'test-model')
    await reloaded.initialize()
    expect((await reloaded.get(session.summary.id)).plan).toEqual(secondPlan)
  })

  it('publishes and executes Arena-compatible structured file mutation tools', async () => {
    const definitions = new Map(TOOL_DEFINITIONS.map((tool) => [tool.function.name, tool.function.parameters]))
    expect(definitions.has('write_file')).toBe(true)
    expect([...definitions.keys()]).toEqual(expect.arrayContaining(['create_file', 'edit_file', 'delete_file', 'apply_patch']))
    expect(definitions.get('edit_file')).toMatchObject({
      required: ['path', 'context', 'replacement'],
      additionalProperties: false,
      properties: { context: { type: 'string', minLength: 1 }, replacement: { type: 'string' } },
    })

    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_file_tools',
      stepId: 'step_file_tools',
      signal: new AbortController().signal,
    }

    const created = await tools.execute({
      id: 'call_create', name: 'create_file', arguments: { path: 'config.ts', content: 'mode   = draft\n' },
    }, context)
    expect(JSON.parse(created.content)).toEqual({ status: 'success', message: 'Created config.ts (15 bytes).' })
    const duplicate = await tools.execute({
      id: 'call_duplicate', name: 'create_file', arguments: { path: 'config.ts', content: 'overwritten\n' },
    }, context)
    expect(duplicate.isError).toBe(true)
    expect(JSON.parse(duplicate.content)).toEqual({ status: 'error', message: 'File already exists: config.ts' })

    const edited = await tools.execute({
      id: 'call_edit', name: 'edit_file', arguments: { path: 'config.ts', old_text: 'mode = draft', new_text: 'mode = ready' },
    }, context)
    expect(JSON.parse(edited.content)).toMatchObject({
      status: 'success',
      message: 'Edited config.ts.',
      hash: expect.any(String),
    })
    await tools.execute({
      id: 'call_batch_create',
      name: 'create_file',
      arguments: { path: 'batch.html', content: '<section class="layout-a layout-b"></section><section class="layout-c layout-d"></section>\n' },
    }, context)
    const batchEdited = await tools.execute({
      id: 'call_batch_edit',
      name: 'edit_file',
      arguments: {
        path: 'batch.html',
        edits: [
          { old_text: 'layout-a layout-b', new_text: 'layout-a' },
          { old_text: 'layout-c layout-d', new_text: 'layout-c' },
        ],
      },
    }, context)
    expect(JSON.parse(batchEdited.content)).toMatchObject({ status: 'success', hash: expect.any(String) })
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'batch.html'), 'utf8')).resolves.toBe(
      '<section class="layout-a"></section><section class="layout-c"></section>\n',
    )
    await tools.execute({
      id: 'call_batch_delete', name: 'delete_file', arguments: { path: 'batch.html' },
    }, context)
    await tools.execute({
      id: 'call_temp', name: 'create_file', arguments: { path: 'temp.txt', content: 'remove\n' },
    }, context)

    const patched = await tools.execute({
      id: 'call_patch',
      name: 'apply_patch',
      arguments: { input: `*** Begin Patch
*** Update File: config.ts
@@
-mode = ready
+mode = final
*** Add File: extra.txt
+extra
*** Delete File: temp.txt
*** End Patch` },
    }, context)
    expect(JSON.parse(patched.content)).toEqual({ status: 'success', message: 'Applied patch (3 file changes).' })
    const deleted = await tools.execute({
      id: 'call_delete', name: 'delete_file', arguments: { path: 'extra.txt' },
    }, context)
    expect(JSON.parse(deleted.content)).toEqual({ status: 'success' })

    await tools.execute({
      id: 'call_generated_create', name: 'create_file', arguments: { path: 'dist/generated.txt', content: 'generated v1\n' },
    }, context)
    await tools.execute({
      id: 'call_cache_write', name: 'write_file', arguments: { path: '.next/cache/state.txt', content: 'cache\n' },
    }, context)
    await tools.execute({
      id: 'call_generated_edit', name: 'edit_file', arguments: { path: 'dist/generated.txt', old_text: 'generated v1', new_text: 'generated v2' },
    }, context)
    const excludedPatch = await tools.execute({
      id: 'call_generated_patch',
      name: 'apply_patch',
      arguments: { input: `*** Begin Patch
*** Update File: dist/generated.txt
@@
-generated v2
+generated v3
*** Add File: .netrc
+machine example.test password secret
*** End Patch` },
    }, context)
    expect(JSON.parse(excludedPatch.content)).toEqual({ status: 'success', message: 'Applied patch (2 file changes).' })

    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'config.ts'), 'utf8')).resolves.toBe('mode = final\n')
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'temp.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'extra.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'dist/generated.txt'), 'utf8')).resolves.toBe('generated v3\n')
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), '.next/cache/state.txt'), 'utf8')).resolves.toBe('cache\n')
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), '.netrc'), 'utf8')).resolves.toBe('machine example.test password secret\n')
    expect((await store.get(session.summary.id)).artifacts).toEqual([
      expect.objectContaining({ path: 'config.ts', mime: 'text/javascript' }),
    ])
    const events = await store.events(session.summary.id)
    expect(events.filter((event) => event.type === 'artifact.removed').map((event) => event.data.path)).toEqual([
      'batch.html', 'temp.txt', 'extra.txt',
    ])
    expect(events
      .filter((event) => event.type === 'file.changed')
      .map((event) => String(event.data.path))
      .filter(isWorkspaceSnapshotExcludedPath)).toEqual([])
  })

  it('creates and overwrites one durable file through /home/user, tilde, and relative aliases', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-active-file-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_active_file',
      stepId: 'step_active_file',
      signal: new AbortController().signal,
    }

    const created = await tools.execute({
      id: 'call_write_create', name: 'write_file', arguments: { path: '/home/user/state.txt', content: 'v1\n' },
    }, context)
    expect(JSON.parse(created.content)).toEqual({ status: 'success', hash: expect.any(String) })

    const overwritten = await tools.execute({
      id: 'call_write_overwrite', name: 'write_file', arguments: { path: '~/state.txt', content: 'v2\n' },
    }, context)
    expect(JSON.parse(overwritten.content)).toEqual({ status: 'success', hash: expect.any(String) })

    const read = await tools.execute({
      id: 'call_read_alias', name: 'read_file', arguments: { path: 'state.txt' },
    }, context)
    expect(JSON.parse(read.content)).toMatchObject({
      status: 'success',
      kind: 'text',
      content: 'v2\n',
    })
    const escaped = await tools.execute({
      id: 'call_write_escape', name: 'write_file', arguments: { path: '../outside.txt', content: 'no' },
    }, context)
    expect(escaped.isError).toBe(true)
    expect(JSON.parse(escaped.content)).toMatchObject({ status: 'error', message: expect.stringMatching(/escapes the workspace/) })
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'state.txt'), 'utf8')).resolves.toBe('v2\n')
    expect((await store.events(session.summary.id)).filter((event) => event.type === 'file.changed').map((event) => event.data.operation)).toEqual([
      'created', 'overwritten',
    ])
  })

  it('continues fetch_page by chunk index until the exact response body is reconstructed', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-fetch-page-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const source = Array.from({ length: 7_500 }, (_, index) => `row-${String(index).padStart(5, '0')}|${'x'.repeat(31)}\n`).join('')
    const fetchMock = vi.fn(async () => new Response(source, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_fetch_page',
      stepId: 'step_fetch_page',
      signal: new AbortController().signal,
    }

    let chunkIndex = 0
    let reconstructed = ''
    let chunkCount = 0
    while (true) {
      const result = await tools.execute({
        id: `call_fetch_page_${chunkIndex}`,
        name: 'fetch_page',
        arguments: { url: 'https://example.com/large.txt', chunkIndex },
      }, context)
      expect(result.isError, result.content).toBe(false)
      expect(result.researchPageRead).toMatchObject({
        url: 'https://example.com/large.txt', requestedUrl: 'https://example.com/large.txt',
        format: 'markdown', chunkIndex,
        snapshotSha256: createHash('sha256').update(source).digest('hex'),
      })
      expect(result.webProviderUsage).toMatchObject(chunkIndex === 0 ? {
        schemaVersion: 1,
        cache: 'miss',
        providerCalls: 1,
        responseBytes: Buffer.byteLength(source),
        requests: [{ provider: 'direct', operation: 'fetch', calls: 1, outcome: 'success' }],
        costUsd: null,
        costStatus: 'not_available',
      } : {
        schemaVersion: 1,
        cache: 'hit',
        cacheProvider: 'direct',
        providerCalls: 0,
        responseBytes: 0,
        requests: [],
        costUsd: null,
        costStatus: 'not_available',
      })
      const payload = JSON.parse(result.content) as {
        content: string
        chunkIndex: number
        hasMore: boolean
        totalChunks: number
      }
      expect(payload.chunkIndex).toBe(chunkIndex)
      reconstructed += payload.content
      chunkCount += 1
      if (!payload.hasMore) break
      expect(payload.totalChunks).toBeGreaterThan(chunkIndex + 1)
      chunkIndex += 1
    }
    expect(chunkCount).toBeGreaterThan(1)
    expect(reconstructed).toBe(source)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('preserves paginated raw HTML source through the direct transport and isolates it from Firecrawl markdown cache', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-fetch-page-raw-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const source = [
      '<!doctype html><html><head><title>Exact Source</title>',
      '<style>:root{--accent:#1e2bfa}.layout-cover{clip-path:polygon(35% 0,100% 0,100% 100%,0 100%)}</style>',
      '<script>window.referenceSourceMustSurvive=true</script></head>',
      `<body><main class="layout-cover">${'source-byte-'.repeat(Math.ceil(config.maxReadBytes / 12))}</main></body></html>`,
    ].join('')
    expect(Buffer.byteLength(source)).toBeGreaterThan(config.maxReadBytes)
    const targetUrl = 'https://templates.example/exact.html'
    const firecrawlUrl = 'https://firecrawl.example/v1/scrape'
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === firecrawlUrl) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          url: targetUrl,
          formats: ['markdown'],
        })
        return Response.json({
          success: true,
          data: {
            markdown: '# Extracted by Firecrawl',
            metadata: { sourceURL: targetUrl, title: 'Extracted', statusCode: 200 },
          },
        })
      }
      expect(String(input)).toBe(targetUrl)
      expect(init?.method).toBeUndefined()
      return new Response(source, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
        firecrawlApiKey: 'fc-raw-bypass-fixture',
        firecrawlBaseUrl: 'https://firecrawl.example/v1',
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_fetch_page_raw',
      stepId: 'step_fetch_page_raw',
      signal: new AbortController().signal,
    }

    let chunkIndex = 0
    let reconstructed = ''
    while (true) {
      const result = await tools.execute({
        id: `call_fetch_page_raw_${chunkIndex}`,
        name: 'fetch_page',
        arguments: { url: targetUrl, chunkIndex, format: 'raw' },
      }, context)
      expect(result.isError).toBe(false)
      expect(result.webProviderUsage).toMatchObject(chunkIndex === 0 ? {
        cache: 'miss',
        providerCalls: 1,
        requests: [{ provider: 'direct', operation: 'fetch', calls: 1, outcome: 'success' }],
      } : {
        cache: 'hit',
        cacheProvider: 'direct',
        providerCalls: 0,
        requests: [],
      })
      const payload = JSON.parse(result.content) as {
        content: string
        hasMore: boolean
        totalChunks: number
      }
      reconstructed += payload.content
      if (!payload.hasMore) break
      expect(payload.totalChunks).toBeGreaterThan(chunkIndex + 1)
      chunkIndex += 1
    }

    expect(chunkIndex).toBeGreaterThan(0)
    expect(reconstructed).toBe(source)
    expect(reconstructed).toContain('<style>:root{--accent:#1e2bfa}')
    expect(reconstructed).toContain('<script>window.referenceSourceMustSurvive=true</script>')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(targetUrl)

    const markdown = await tools.execute({
      id: 'call_fetch_page_markdown_after_raw',
      name: 'fetch_page',
      arguments: { url: targetUrl, chunkIndex: 0 },
    }, context)
    expect(markdown.isError).toBe(false)
    expect(JSON.parse(markdown.content)).toMatchObject({ content: '# Extracted by Firecrawl' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(firecrawlUrl)
  })

  it('parses at most 30 PDF pages and continues only across the extracted chunks', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-fetch-page-pdf-limit-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const pdf = minimalPdf(Array.from({ length: 31 }, (_value, index) => (
      index === 30
        ? 'PAGE_31_MUST_NOT_BE_RETURNED'
        : `PAGE_${String(index + 1).padStart(2, '0')}_EVIDENCE ${'bounded evidence '.repeat(700)}`
    )))
    const fetchMock = vi.fn(async (input: string | URL | Request) => (
      String(input) === 'https://docs.example/report'
        ? new Response('', { status: 302, headers: { location: '/files/report.pdf' } })
        : new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf; charset=binary' } })
    ))
    const validated: string[] = []
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => {
          validated.push(raw)
          return new URL(raw)
        },
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_fetch_page_pdf_limit',
      stepId: 'step_fetch_page_pdf_limit',
      signal: new AbortController().signal,
    }

    let chunkIndex = 0
    let reconstructed = ''
    let totalChunks = 0
    while (true) {
      const result = await tools.execute({
        id: `call_fetch_page_pdf_${chunkIndex}`,
        name: 'fetch_page',
        arguments: { url: 'https://docs.example/report', chunkIndex },
      }, context)
      expect(result.isError).toBe(false)
      const payload = JSON.parse(result.content) as {
        url: string
        content: string
        chunkIndex: number
        hasMore: boolean
        totalChunks: number
      }
      expect(payload.url).toBe('https://docs.example/files/report.pdf')
      expect(payload.chunkIndex).toBe(chunkIndex)
      totalChunks = payload.totalChunks
      reconstructed += payload.content
      if (!payload.hasMore) break
      expect(payload.totalChunks).toBeGreaterThan(chunkIndex + 1)
      chunkIndex += 1
    }

    expect(totalChunks).toBeGreaterThan(1)
    expect(reconstructed.match(/--- PDF page \d+ of 31 ---/g)).toHaveLength(30)
    expect(reconstructed).toContain('PAGE_30_EVIDENCE')
    expect(reconstructed).not.toContain('PAGE_31_MUST_NOT_BE_RETURNED')
    expect(reconstructed).toContain('PDF page limit reached: parsed pages 1-30 of 31')
    expect(reconstructed).toContain('chunk continuation ends after the extracted text above')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(validated).toContain('https://docs.example/files/report.pdf')
  })

  it('sniffs a PDF signature when the server sends a generic MIME type', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-fetch-page-pdf-sniff-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const pdf = minimalPdf(['MAGIC_SNIFFED_PDF_EVIDENCE'])
    const fetchMock = vi.fn(async () => new Response(pdf, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, validatePublicUrl: async (raw) => new URL(raw) },
    )
    const result = await tools.execute({
      id: 'call_fetch_page_pdf_sniff',
      name: 'fetch_page',
      arguments: { url: 'https://docs.example/download', chunkIndex: 0 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_fetch_page_pdf_sniff',
      stepId: 'step_fetch_page_pdf_sniff',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toMatchObject({
      status: 'success',
      content: expect.stringContaining('MAGIC_SNIFFED_PDF_EVIDENCE'),
      hasMore: false,
      totalChunks: 1,
    })
  })

  it('fails closed for a declared PDF without PDF magic and for a corrupt signed PDF', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-fetch-page-pdf-invalid-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const responses = [
      new Response('<html>not a pdf</html>', { status: 200, headers: { 'content-type': 'application/pdf' } }),
      new Response('%PDF-1.7\nthis is not a valid object graph', { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    ]
    const fetchMock = vi.fn(async () => responses.shift() as Response)
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, validatePublicUrl: async (raw) => new URL(raw) },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_fetch_page_pdf_invalid',
      stepId: 'step_fetch_page_pdf_invalid',
      signal: new AbortController().signal,
    }
    const missingMagic = await tools.execute({
      id: 'call_fetch_page_pdf_missing_magic',
      name: 'fetch_page',
      arguments: { url: 'https://docs.example/missing-magic', chunkIndex: 0 },
    }, context)
    const corrupt = await tools.execute({
      id: 'call_fetch_page_pdf_corrupt',
      name: 'fetch_page',
      arguments: { url: 'https://docs.example/corrupt', chunkIndex: 0 },
    }, context)

    expect(missingMagic.isError).toBe(true)
    expect(JSON.parse(missingMagic.content).error).toMatch(/missing the required %PDF- signature/)
    expect(corrupt.isError).toBe(true)
    expect(JSON.parse(corrupt.content).error).toMatch(/Could not parse PDF response/)
  })

  it('cancels an oversized PDF download at the direct-fetch byte limit', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-fetch-page-pdf-oversize-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const limit = config.maxReadBytes * 10
    const base = minimalPdf(['BOUNDED_DOWNLOAD'])
    const pdf = Buffer.concat([base, Buffer.alloc(Math.max(0, limit + 1 - base.length))])
    const fetchMock = vi.fn(async () => new Response(pdf, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, validatePublicUrl: async (raw) => new URL(raw) },
    )
    const result = await tools.execute({
      id: 'call_fetch_page_pdf_oversize',
      name: 'fetch_page',
      arguments: { url: 'https://docs.example/oversize.pdf', chunkIndex: 0 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_fetch_page_pdf_oversize',
      stepId: 'step_fetch_page_pdf_oversize',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toContain(`exceeds the ${limit}-byte download limit`)
    expect(result.webProviderUsage).toMatchObject({
      cache: 'miss',
      providerCalls: 1,
      responseBytes: limit,
      requests: [{ provider: 'direct', calls: 1, outcome: 'error', responseBytes: limit }],
    })
  })

  it('ends non-PDF continuation after an explicit source-byte-limit marker', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-fetch-page-source-limit-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const limit = config.maxReadBytes * 10
    const source = 'x'.repeat(limit + 73)
    const fetchMock = vi.fn(async () => new Response(source, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, validatePublicUrl: async (raw) => new URL(raw) },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_fetch_page_source_limit',
      stepId: 'step_fetch_page_source_limit',
      signal: new AbortController().signal,
    }

    let chunkIndex = 0
    let reconstructed = ''
    while (true) {
      const result = await tools.execute({
        id: `call_fetch_page_source_limit_${chunkIndex}`,
        name: 'fetch_page',
        arguments: { url: 'https://docs.example/too-large.txt', chunkIndex },
      }, context)
      expect(result.isError).toBe(false)
      const payload = JSON.parse(result.content) as { content: string; hasMore: boolean; totalChunks: number }
      reconstructed += payload.content
      if (!payload.hasMore) {
        expect(chunkIndex).toBe(payload.totalChunks - 1)
        break
      }
      expect(chunkIndex).toBeLessThan(payload.totalChunks - 1)
      chunkIndex += 1
    }

    expect(reconstructed.startsWith('x'.repeat(limit))).toBe(true)
    expect(reconstructed).toContain(`Source response byte limit reached after ${limit} bytes`)
    expect(reconstructed).toContain('chunk continuation ends after the text above')
    expect(fetchMock).toHaveBeenCalledOnce()

    const raw = await tools.execute({
      id: 'call_fetch_page_raw_source_limit',
      name: 'fetch_page',
      arguments: { url: 'https://docs.example/too-large.txt', chunkIndex: 0, format: 'raw' },
    }, context)
    expect(raw.isError).toBe(true)
    expect(JSON.parse(raw.content)).toEqual({
      status: 'error',
      error: `fetch_page format raw requires the complete textual source, but the response from https://docs.example/too-large.txt exceeds the ${limit}-byte download limit; no partial source was returned`,
    })
    expect(raw.content).not.toContain('x'.repeat(1_000))
    expect(raw.webProviderUsage).toMatchObject({
      cache: 'miss',
      providerCalls: 1,
      responseBytes: limit,
      requests: [{ provider: 'direct', calls: 1, outcome: 'error', responseBytes: limit }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses Firecrawl for fetch_page, preserves exact chunk continuation, and redacts its credential', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-firecrawl-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const secret = 'fc-test-secret-123456789'
    const source = `${Array.from({ length: 8_000 }, (_, index) => `row-${index}|${'z'.repeat(32)}\n`).join('')}credential=${secret}`
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://firecrawl.example/v1/scrape')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${secret}` })
      expect(JSON.parse(String(init?.body))).toEqual({
        url: 'https://docs.example/article',
        formats: ['markdown'],
        onlyMainContent: true,
        timeout: 120_000,
      })
      return Response.json({
        success: true,
        data: {
          markdown: source,
          metadata: {
            title: `Provider guide ${secret}`,
            sourceURL: 'https://docs.example/article',
            statusCode: 200,
          },
        },
      })
    })
    const validated: string[] = []
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => {
          validated.push(raw)
          return new URL(raw)
        },
        firecrawlApiKey: secret,
        firecrawlBaseUrl: 'https://firecrawl.example/v1/',
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_firecrawl',
      stepId: 'step_firecrawl',
      signal: new AbortController().signal,
    }

    let chunkIndex = 0
    let reconstructed = ''
    while (true) {
      const result = await tools.execute({
        id: `call_firecrawl_${chunkIndex}`,
        name: 'fetch_page',
        arguments: { url: 'https://docs.example/article', chunkIndex },
      }, context)
      expect(result.isError).toBe(false)
      expect(result.content).not.toContain(secret)
      expect(result.webProviderUsage).toMatchObject(chunkIndex === 0 ? {
        cache: 'miss',
        providerCalls: 1,
        requests: [{ provider: 'firecrawl', operation: 'fetch', calls: 1, outcome: 'success' }],
      } : {
        cache: 'hit',
        cacheProvider: 'firecrawl',
        providerCalls: 0,
        responseBytes: 0,
        requests: [],
      })
      const payload = JSON.parse(result.content) as {
        title: string
        content: string
        hasMore: boolean
      }
      expect(payload.title).toContain('[REDACTED]')
      reconstructed += payload.content
      if (!payload.hasMore) break
      chunkIndex += 1
    }

    expect(chunkIndex).toBeGreaterThan(0)
    expect(reconstructed).toBe(source.replaceAll(secret, '[REDACTED]'))
    expect(fetchMock).toHaveBeenCalledOnce()
    // Every tool call still validates its requested URL, and the first scrape
    // additionally validates Firecrawl's reported final URL.
    expect(validated).toEqual(Array(chunkIndex + 2).fill('https://docs.example/article'))
  })

  it('scopes fetch_page snapshots to one turn and canonicalizes URL fragments', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-fetch-page-turn-cache-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const source = `${'a'.repeat(250_000)}${'b'.repeat(250_000)}`
    const fetchMock = vi.fn(async () => new Response(source, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
      },
    )
    const execute = async (turnId: string, chunkIndex: number, suffix: string) => await tools.execute({
      id: `call_${turnId}_${chunkIndex}_${suffix}`,
      name: 'fetch_page',
      arguments: { url: `https://example.com/large.txt${suffix}`, chunkIndex },
    }, {
      sessionId: session.summary.id,
      turnId,
      stepId: `step_${turnId}_${chunkIndex}`,
      signal: new AbortController().signal,
    })

    const first = await execute('turn_a', 0, '#start')
    const second = await execute('turn_a', 1, '#continuation')
    const nextTurn = await execute('turn_b', 0, '#new-turn')

    expect([first, second, nextTurn].every((result) => !result.isError)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('evicts fetch_page snapshots by LRU entry order', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-fetch-page-lru-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn(async (input: string | URL | Request) => new Response(`body:${String(input)}`, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
        fetchPageCacheMaxEntries: 2,
        fetchPageCacheMaxBytes: 1_000_000,
      },
    )
    let callIndex = 0
    const execute = async (path: string) => await tools.execute({
      id: `call_lru_${callIndex++}`,
      name: 'fetch_page',
      arguments: { url: `https://example.com/${path}`, chunkIndex: 0 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_lru',
      stepId: `step_lru_${callIndex}`,
      signal: new AbortController().signal,
    })

    await execute('a')
    await execute('b')
    await execute('a') // Refresh A, making B the least-recently used entry.
    await execute('c')
    await execute('b')

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/b',
    ])
  })

  it('does not cache failed fetch_page responses or snapshots above the byte cap', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-fetch-page-cache-admission-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn(async () => {
      const attempt = fetchMock.mock.calls.length
      if (attempt === 1) return new Response('temporarily unavailable', { status: 503 })
      return new Response('successful body exceeds cap', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    })
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
        fetchPageCacheMaxEntries: 2,
        fetchPageCacheMaxBytes: 8,
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_cache_admission',
      stepId: 'step_cache_admission',
      signal: new AbortController().signal,
    }
    const execute = async (index: number) => await tools.execute({
      id: `call_cache_admission_${index}`,
      name: 'fetch_page',
      arguments: { url: 'https://example.com/admission', chunkIndex: 0 },
    }, context)

    expect((await execute(0)).isError).toBe(true)
    expect((await execute(1)).isError).toBe(false)
    expect((await execute(2)).isError).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reuses a successful direct fallback for later chunks without retrying Firecrawl', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-firecrawl-fallback-cache-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const source = `${'x'.repeat(240_000)}${'y'.repeat(10_000)}`
    const fetchMock = vi.fn(async (input: string | URL | Request) => (
      String(input) === 'https://firecrawl.example/v1/scrape'
        ? new Response('provider unavailable', { status: 503 })
        : new Response(source, { status: 200, headers: { 'content-type': 'text/plain' } })
    ))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
        firecrawlApiKey: 'fc-fallback-cache-secret',
        firecrawlBaseUrl: 'https://firecrawl.example/v1',
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_firecrawl_fallback_cache',
      stepId: 'step_firecrawl_fallback_cache',
      signal: new AbortController().signal,
    }

    const first = await tools.execute({
      id: 'call_fallback_cache_0', name: 'fetch_page', arguments: { url: 'https://docs.example/large', chunkIndex: 0 },
    }, context)
    const second = await tools.execute({
      id: 'call_fallback_cache_1', name: 'fetch_page', arguments: { url: 'https://docs.example/large', chunkIndex: 1 },
    }, context)

    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    expect(`${JSON.parse(first.content).content}${JSON.parse(second.content).content}`).toBe(source)
    expect(first.webProviderUsage).toMatchObject({
      cache: 'miss',
      providerCalls: 2,
      requests: [
        { provider: 'firecrawl', calls: 1, outcome: 'error' },
        { provider: 'direct', calls: 1, outcome: 'success', responseBytes: Buffer.byteLength(source) },
      ],
    })
    expect(second.webProviderUsage).toEqual({
      schemaVersion: 1,
      cache: 'hit',
      cacheProvider: 'direct',
      providerCalls: 0,
      responseBytes: 0,
      requests: [],
      costUsd: null,
      costStatus: 'not_available',
    })
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://firecrawl.example/v1/scrape',
      'https://docs.example/large',
    ])
  })

  it.each([
    ['local capability denial', () => { throw new Error('Unpriced tool-provider route unavailable in this canary') }],
    ['HTTP 401', () => new Response('credential rejected', { status: 401 })],
    ['HTTP 429', () => new Response('rate limited', { status: 429 })],
    ['HTTP 503', () => new Response('provider unavailable', { status: 503 })],
    ['invalid JSON', () => new Response('not-json', { status: 200 })],
  ])('falls back to the safe direct fetch when Firecrawl returns %s', async (_label, providerResponse) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-firecrawl-fallback-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const secret = 'fc-fallback-secret-123456'
    const fetchMock = vi.fn(async (input: string | URL | Request) => (
      String(input) === 'https://firecrawl.example/v1/scrape'
        ? providerResponse()
        : new Response('<title>Direct page</title><main><h1>Fallback worked</h1></main>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
    ))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
        firecrawlApiKey: secret,
        firecrawlBaseUrl: 'https://firecrawl.example/v1',
      },
    )
    const result = await tools.execute({
      id: 'call_firecrawl_fallback',
      name: 'fetch_page',
      arguments: { url: 'https://docs.example/fallback', chunkIndex: 0 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_firecrawl_fallback',
      stepId: 'step_firecrawl_fallback',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toMatchObject({
      status: 'success',
      title: 'Direct page',
      content: '# Fallback worked',
    })
    expect(result.content).not.toContain(secret)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['fetch', 'search', 'image', 'fetch-failed'] as const)(
    'keeps %s local non-dispatch separate from actual fallback usage and evidence', async (kind) => {
      const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-dispatch-'))
      roots.push(root)
      const store = new SessionStore(root, 'test-model')
      await store.initialize()
      const session = await store.create()
      const publicFetch = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init)
        expect(request.method).toBe('GET')
        expect(request.headers.has('authorization')).toBe(false)
        if (kind === 'search') return new Response('<li class="b_algo"><h2><a href="https://docs.example/article">Source</a></h2><p>Observed public evidence</p></li>',
          { headers: { 'content-type': 'text/html' } })
        return new Response('<title>Source</title><main>Observed public evidence</main>', {
          status: kind === 'fetch-failed' ? 404 : 200, headers: { 'content-type': 'text/html' },
        })
      })
      const localFetch = vi.fn<typeof fetch>()
      const executor = new ToolExecutor(store, persistedProcessManager(store), new BrowserManager(),
        { inspect: vi.fn() }, async () => false, {
          fetch: publicReadTransport({ publicFetch, localFetch, localBaseUrl: () => '' }),
          validatePublicUrl: async raw => new URL(raw),
          firecrawlApiKey: 'synthetic-secret-fc', tavilyApiKey: 'synthetic-secret-tv', pexelsApiKey: '',
        })
      const controller = new AbortController()
      const result = await executor.execute({ id: 'dispatch-case',
        name: kind === 'search' ? 'web_search' : kind === 'image' ? 'image_search' : 'fetch_page',
        arguments: kind === 'search' ? { query: 'public evidence', depth: '1' }
          : kind === 'image' ? { query: 'public evidence', count: 1 } : { url: 'https://docs.example/article' },
      }, { sessionId: session.summary.id, turnId: 'turn_dispatch', stepId: 'step_dispatch', signal: controller.signal })
      expect(result.isError).toBe(kind === 'image' || kind === 'fetch-failed')
      expect(result.webProviderUsage?.providerCalls).toBe(kind === 'image' ? 0 : 1)
      expect(result.webProviderUsage?.requests[0]).toMatchObject({
        provider: kind === 'search' || kind === 'image' ? 'tavily' : 'firecrawl',
        calls: 0, responseBytes: 0, outcome: 'not_dispatched',
      })
      if (kind !== 'image') expect(result.webProviderUsage?.requests[1]).toMatchObject({
        provider: kind === 'search' ? 'bing' : 'direct', calls: 1,
        outcome: kind === 'fetch-failed' ? 'error' : 'success',
      })
      expect(result.webProviderUsage).toMatchObject({ costUsd: null, costStatus: 'not_available' })
      expect(result.content).not.toContain('synthetic-secret')
      expect(publicFetch).toHaveBeenCalledTimes(kind === 'image' ? 0 : 1)
      expect(localFetch).not.toHaveBeenCalled()
      expect(controller.signal.aborted).toBe(false)
    })

  it('validates the target before Firecrawl and does not fall back after cancellation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-firecrawl-policy-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason
      return Response.json({ success: true, data: { markdown: 'unexpected' } })
    })
    const blocked = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async () => { throw new Error('Private network targets are blocked') },
        firecrawlApiKey: 'fc-policy-secret-123456',
        firecrawlBaseUrl: 'https://firecrawl.example/v1',
      },
    )
    const baseContext = {
      sessionId: session.summary.id,
      turnId: 'turn_firecrawl_policy',
      stepId: 'step_firecrawl_policy',
    }
    const blockedResult = await blocked.execute({
      id: 'call_firecrawl_blocked',
      name: 'fetch_page',
      arguments: { url: 'http://127.0.0.1/private', chunkIndex: 0 },
    }, { ...baseContext, signal: new AbortController().signal })
    expect(blockedResult.isError).toBe(true)
    expect(JSON.parse(blockedResult.content)).toEqual({ status: 'error', error: 'Private network targets are blocked' })
    expect(fetchMock).not.toHaveBeenCalled()

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const cancelled = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
        firecrawlApiKey: 'fc-policy-secret-123456',
        firecrawlBaseUrl: 'https://firecrawl.example/v1',
      },
    )
    const cancelledResult = await cancelled.execute({
      id: 'call_firecrawl_cancelled',
      name: 'fetch_page',
      arguments: { url: 'https://docs.example/cancel', chunkIndex: 0 },
    }, { ...baseContext, signal: controller.signal })
    expect(cancelledResult).toMatchObject({ isError: true, aborted: true })
    expect(JSON.parse(cancelledResult.content)).toEqual({ status: 'aborted' })
    expect(cancelledResult.webProviderUsage).toMatchObject({
      cache: 'miss',
      providerCalls: 0,
      responseBytes: 0,
      requests: [],
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('runs the active process start, wait-for-existing-port, stop, and final-output lifecycle', async () => {
    const reservation = createServer()
    await new Promise<void>((resolveListen) => reservation.listen(0, '127.0.0.1', resolveListen))
    const address = reservation.address() as AddressInfo
    const port = address.port
    await new Promise<void>((resolveClose, rejectClose) => reservation.close((error) => error ? rejectClose(error) : resolveClose()))

    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-active-process-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_active_process',
      stepId: 'step_active_process',
      signal: new AbortController().signal,
    }
    const started = await tools.execute({
      id: 'call_process_start',
      name: 'start_process',
      arguments: { name: 'active-process-test', command: `python3 -u -m http.server ${port} --bind 127.0.0.1`, startup_wait: 1 },
    }, context)
    const startedPayload = JSON.parse(started.content) as {
      process_id: string
      status: string
      listening_ports: Array<{ port: number; address: string }>
      new_ports: Array<{ port: number; address: string }>
      warnings: string[]
    }
    expect(startedPayload).toMatchObject({
      status: 'running',
      listening_ports: [{ port, address: '127.0.0.1' }],
      new_ports: [{ port, address: '127.0.0.1' }],
    })
    expect(startedPayload.warnings).toEqual([
      `Port ${port} is listening on 127.0.0.1, which is not reachable from Arena's live preview. Bind the server to 0.0.0.0.`,
    ])
    expect((await store.get(session.summary.id)).processes.find((process) => process.id === startedPayload.process_id)?.name).toBe('active-process-test')

    const waited = await tools.execute({
      id: 'call_process_wait',
      name: 'get_process_output',
      arguments: { process_id: startedPayload.process_id, wait_for: 'port', wait_timeout: 1 },
    }, context)
    expect(JSON.parse(waited.content)).toMatchObject({
      status: 'running',
      listening_ports: [{ port }],
      wait_result: 'satisfied',
    })

    const stopped = await tools.execute({
      id: 'call_process_stop', name: 'stop_process', arguments: { process_id: startedPayload.process_id },
    }, context)
    expect(JSON.parse(stopped.content)).toMatchObject({
      status: 'stopped',
    })
    const final = await tools.execute({
      id: 'call_process_final', name: 'get_process_output', arguments: { process_id: startedPayload.process_id },
    }, context)
    expect(JSON.parse(final.content)).toMatchObject({
      status: 'exited',
    })
  })

  it('publishes the Website for the requested managed process without borrowing another server port', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-owned-process-preview-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'silent_server.py', [
      'import sys',
      'from http.server import BaseHTTPRequestHandler, HTTPServer',
      'marker = sys.argv[2]',
      'class Handler(BaseHTTPRequestHandler):',
      '    def do_GET(self):',
      '        body = ("<!doctype html><title>" + marker + "</title><h1>" + marker + "</h1>").encode()',
      '        self.send_response(200)',
      '        self.send_header("Content-Type", "text/html; charset=utf-8")',
      '        self.send_header("Content-Length", str(len(body)))',
      '        self.end_headers()',
      '        self.wfile.write(body)',
      '    def log_message(self, *_args):',
      '        pass',
      'HTTPServer(("0.0.0.0", int(sys.argv[1])), Handler).serve_forever()',
      '',
    ].join('\n'))
    const [lowPort, highPort] = (await reserveTcpPorts(2)).sort((left, right) => left - right)
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_owned_process_preview',
      stepId: 'step_owned_process_preview',
      signal: new AbortController().signal,
    }
    const high = await tools.execute({
      id: 'call_owned_process_high',
      name: 'start_process',
      arguments: { command: `python3 -u silent_server.py ${highPort} guardian-high`, startup_wait: 2 },
    }, context)
    const highId = (JSON.parse(high.content) as { process_id: string }).process_id
    const low = await tools.execute({
      id: 'call_owned_process_low',
      name: 'start_process',
      arguments: { command: `python3 -u silent_server.py ${lowPort} guardian-low`, startup_wait: 2 },
    }, context)
    const lowId = (JSON.parse(low.content) as { process_id: string }).process_id
    expect(lowId).not.toBe(highId)

    const refreshedHigh = await tools.execute({
      id: 'call_owned_process_refresh_high',
      name: 'get_process_output',
      arguments: { process_id: highId },
    }, context)
    expect(JSON.parse(refreshedHigh.content)).toMatchObject({
      status: 'running',
      listening_ports: [{ port: highPort }],
    })
    const website = (await store.get(session.summary.id)).website
    expect(website).toMatchObject({
      status: 'running',
      processId: highId,
      port: highPort,
      previewUrl: `http://127.0.0.1:${highPort}`,
    })
    expect(await (await fetch(website.previewUrl!)).text()).toContain('guardian-high')
  })

  it('does not publish a reachable host decoy reported by a process when ownership is unknown', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-unverified-preview-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const hostDecoy = createServer((socket) => socket.end([
      'HTTP/1.1 200 OK',
      'Content-Type: text/html',
      'Content-Length: 24',
      'Connection: close',
      '',
      '<h1>HOST DECOY PAGE</h1>',
    ].join('\r\n')))
    await new Promise<void>((resolveListen) => hostDecoy.listen(0, '127.0.0.1', resolveListen))
    const port = (hostDecoy.address() as AddressInfo).port
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store, {
        portProbe: async () => ({ ports: [], ownershipVerified: false }),
      }),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )

    try {
      const result = await tools.execute({
        id: 'call_unverified_preview',
        name: 'start_process',
        arguments: {
          command: `python3 -u -c "import time;print('listening on ${port}',flush=True);time.sleep(30)"`,
          startup_wait: 1,
        },
      }, {
        sessionId: session.summary.id,
        turnId: 'turn_unverified_preview',
        stepId: 'step_unverified_preview',
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.content)).toMatchObject({
        status: 'running',
        listening_ports: [],
        new_ports: [],
      })
      expect((await store.get(session.summary.id)).website.status).toBe('stopped')
    } finally {
      await new Promise<void>((resolveClose) => hostDecoy.close(() => resolveClose()))
    }
  })

  it('keeps the process root URL when index.html already serves the Website', async () => {
    const port = await reserveTcpPort()
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-preview-root-index-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'index.html', '<!doctype html><title>Root app</title><h1>Root app</h1>')
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const result = await tools.execute({
      id: 'call_preview_root_index',
      name: 'start_process',
      arguments: { command: `python3 -u -m http.server ${port} --bind 0.0.0.0`, startup_wait: 1 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_preview_root_index',
      stepId: 'step_preview_root_index',
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect((await store.get(session.summary.id)).website).toMatchObject({
      status: 'running',
      entryPath: 'index.html',
      previewUrl: `http://127.0.0.1:${port}`,
    })
  })

  it('selects the unique HTML file when the process root is a directory listing', async () => {
    const port = await reserveTcpPort()
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-preview-unique-entry-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'dashboard.html', '<!doctype html><title>Dashboard entry</title><h1>Dashboard entry</h1>')
    const processes = persistedProcessManager(store)
    const tools = new ToolExecutor(
      store,
      processes,
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_preview_unique_entry',
      stepId: 'step_preview_unique_entry',
      signal: new AbortController().signal,
    }
    const result = await tools.execute({
      id: 'call_preview_unique_entry',
      name: 'start_process',
      arguments: { command: `python3 -u -m http.server ${port} --bind 0.0.0.0`, startup_wait: 1 },
    }, context)
    const processId = (JSON.parse(result.content) as { process_id: string }).process_id
    const website = (await store.get(session.summary.id)).website
    expect(website).toMatchObject({
      status: 'running',
      entryPath: 'dashboard.html',
      previewUrl: `http://127.0.0.1:${port}/dashboard.html`,
    })
    expect(await (await fetch(website.previewUrl!)).text()).toContain('Dashboard entry')

    await tools.execute({
      id: 'call_preview_unique_refresh',
      name: 'get_process_output',
      arguments: { process_id: processId },
    }, context)
    expect((await store.get(session.summary.id)).website.previewUrl).toBe(`http://127.0.0.1:${port}/dashboard.html`)
  })

  it('resolves a unique HTML preview entry relative to start_process.cwd', async () => {
    const port = await reserveTcpPort()
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-preview-cwd-entry-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'site/status.html', '<!doctype html><title>Nested status</title><h1>Nested status</h1>')
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    await tools.execute({
      id: 'call_preview_cwd_entry',
      name: 'start_process',
      arguments: { command: `python3 -u -m http.server ${port} --bind 0.0.0.0`, cwd: 'site', startup_wait: 1 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_preview_cwd_entry',
      stepId: 'step_preview_cwd_entry',
      signal: new AbortController().signal,
    })
    expect((await store.get(session.summary.id)).website).toMatchObject({
      status: 'running',
      entryPath: 'site/status.html',
      previewUrl: `http://127.0.0.1:${port}/status.html`,
    })
  })

  it('keeps a directory-listing root when multiple HTML entries are ambiguous', async () => {
    const port = await reserveTcpPort()
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-preview-ambiguous-entry-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'alpha.html', '<!doctype html><title>Alpha</title>')
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'beta.html', '<!doctype html><title>Beta</title>')
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const result = await tools.execute({
      id: 'call_preview_ambiguous_entry',
      name: 'start_process',
      arguments: { command: `python3 -u -m http.server ${port} --bind 0.0.0.0`, startup_wait: 1 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_preview_ambiguous_entry',
      stepId: 'step_preview_ambiguous_entry',
      signal: new AbortController().signal,
    })
    const payload = JSON.parse(result.content) as { warnings: string[] }
    const website = (await store.get(session.summary.id)).website
    expect(website.previewUrl).toBe(`http://127.0.0.1:${port}`)
    expect(website.entryPath).toBeUndefined()
    expect(payload.warnings).toContain('Live preview root is a directory listing with 2 HTML entries; kept the root URL because no unique entry could be selected.')
  })

  it('publishes exact process Websites and Browser verification through the same font-materialized App preview', async () => {
    const port = await reserveTcpPort()
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-preview-exact-app-route-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const entryPath = 'exact-deck.html'
    const html = '<!doctype html><title>Exact deck</title><main>EXACT APP ROUTE</main>'
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), entryPath, html)
    const fixture = await installExactReferenceVisualFixture(store, session.summary.id)
    const verificationCallId = 'call_exact_app_route_verifier'
    await store.update(session.summary.id, (state) => {
      state.messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: verificationCallId,
          type: 'function',
          function: {
            name: 'verify_reference_style',
            arguments: JSON.stringify({ path: entryPath }),
          },
        }],
      }, {
        role: 'tool',
        tool_call_id: verificationCallId,
        tool_result_status: 'succeeded',
        content: JSON.stringify({
          status: 'success',
          path: entryPath,
          fidelity: 'pass',
          score: 100,
          artifact_hash: createHash('sha256').update(html).digest('base64url'),
          reference_sha256: fixture.sourceEvidenceSha256,
          reference_font_manifest_sha256: fixture.fontEvidence.manifestSha256,
        }),
      })
    })
    const browser = new BrowserManager()
    const browserOpen = vi.spyOn(browser, 'open').mockResolvedValue({ text: 'EXACT APP ROUTE' })
    const resolveFonts = vi.spyOn(store, 'resolveReferenceFontEvidence')
    const appOrigin = 'http://127.0.0.1:49123'
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      browser,
      { inspect: vi.fn() },
      async () => false,
      { localAppBaseUrl: appOrigin },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_exact_app_route',
      stepId: 'step_exact_app_route',
      signal: new AbortController().signal,
    }
    const started = await tools.execute({
      id: 'call_exact_app_route_start',
      name: 'start_process',
      arguments: { command: `python3 -u -m http.server ${port} --bind 0.0.0.0`, startup_wait: 1 },
    }, context)
    expect(started.isError).toBe(false)
    const expectedPreviewUrl = `/workspace/${session.summary.id}/preview/${entryPath}`
    expect((await store.get(session.summary.id)).website).toMatchObject({
      status: 'running',
      entryPath,
      port,
      previewUrl: expectedPreviewUrl,
    })
    expect((JSON.parse(started.content) as { warnings: string[] }).warnings).toEqual([])

    const opened = await tools.execute({
      id: 'call_exact_app_route_browser',
      name: 'browser',
      arguments: { action: 'open' },
    }, context)
    expect(opened.isError).toBe(false)
    expect(browserOpen).toHaveBeenCalledWith(
      session.summary.id,
      `${appOrigin}${expectedPreviewUrl}`,
      context.signal,
    )
    expect(resolveFonts).toHaveBeenCalledWith(session.summary.id, fixture.fontEvidence)
  })

  it('refreshes listening ports on an immediate get_process_output call without a wait mode', async () => {
    const reservation = createServer()
    await new Promise<void>((resolveListen) => reservation.listen(0, '127.0.0.1', resolveListen))
    const port = (reservation.address() as AddressInfo).port
    await new Promise<void>((resolveClose, rejectClose) => reservation.close((error) => error ? rejectClose(error) : resolveClose()))

    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-process-refresh-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const processes = persistedProcessManager(store)
    const tools = new ToolExecutor(
      store,
      processes,
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const process = await processes.start(
      session.summary.id,
      store.workspaceDir(session.summary.id),
      `python3 -u -m http.server ${port} --bind 127.0.0.1`,
    )
    expect(processes.get(session.summary.id, process.id)?.listeningPorts).toEqual([])
    await expectEventually(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      expect(response.ok).toBe(true)
    })

    const result = await tools.execute({
      id: 'call_process_refresh', name: 'get_process_output', arguments: { process_id: process.id },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_process_refresh',
      stepId: 'step_process_refresh',
      signal: new AbortController().signal,
    })
    expect(JSON.parse(result.content)).toMatchObject({
      status: 'running',
      listening_ports: [{ port, address: '127.0.0.1' }],
    })
  })

  it('reports host/origin and iframe response policies that break Arena live preview', async () => {
    const reservation = createServer()
    await new Promise<void>((resolveListen) => reservation.listen(0, '127.0.0.1', resolveListen))
    const port = (reservation.address() as AddressInfo).port
    await new Promise<void>((resolveClose, rejectClose) => reservation.close((error) => error ? rejectClose(error) : resolveClose()))

    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-preview-policy-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeFile(resolve(store.workspaceDir(session.summary.id), 'preview-server.mjs'), `
      import http from 'node:http'
      http.createServer((_request, response) => {
        response.writeHead(403, {
          'content-type': 'text/plain',
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        })
        response.end('Preview host rejected')
      }).listen(${port}, '0.0.0.0', () => console.log('READY', ${port}))
    `)
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const result = await tools.execute({
      id: 'call_preview_policy',
      name: 'start_process',
      arguments: { command: 'node preview-server.mjs', name: 'Policy test server', startup_wait: 1 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_preview_policy',
      stepId: 'step_preview_policy',
      signal: new AbortController().signal,
    })
    const payload = JSON.parse(result.content) as { warnings: string[] }
    expect(payload.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(`Live preview request for host ${port}-anera-preview.e2b.app returned HTTP 403`),
      expect.stringContaining('X-Frame-Options: DENY'),
      expect.stringContaining("frame-ancestors 'none'"),
    ]))
  })

  it('presents a durable file and reports enabled, disabled, disconnected, lookup-error, and unsupported connectors', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-present-connectors-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'deliverables/report.md', '# Report\n')
    const connectorTool = {
      type: 'function' as const,
      function: {
        name: 'github_search_code',
        description: 'Search code in the connected synthetic GitHub repository.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', minLength: 1 } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    }
    const executeConnectorTool: ConnectorToolExecutor = vi.fn(async (call) => ({
      content: JSON.stringify({ status: 'success', query: call.arguments.query, matches: ['src/probe.ts:1'] }),
      isError: false,
    }))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { connectorTools: { github: [connectorTool] }, connectorExecutors: { github: executeConnectorTool } },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_present_connector',
      stepId: 'step_present_connector',
      signal: new AbortController().signal,
    }

    const presented = await tools.execute({
      id: 'call_present', name: 'present_file', arguments: { path: '/home/user/deliverables/report.md' },
    }, context)
    expect(JSON.parse(presented.content)).toEqual({
      status: 'success',
      path: 'deliverables/report.md',
      artifact_hash: createHash('sha256').update('# Report\n').digest('base64url'),
      bytes: 9,
    })
    expect((await store.events(session.summary.id)).find((event) => event.type === 'file.presented')).toMatchObject({
      turnId: context.turnId,
      stepId: context.stepId,
      callId: 'call_present',
      data: { path: 'deliverables/report.md', artifact: expect.objectContaining({ path: 'deliverables/report.md' }) },
    })

    const enabled = await tools.execute({
      id: 'call_connector_enabled', name: 'list_connector_tools', arguments: { service: ' GitHub ' },
    }, context)
    expect(JSON.parse(enabled.content)).toMatchObject({
      status: 'enabled', connector: 'github', tools: [{ name: 'github_search_code' }],
    })
    const connectorResult = await tools.execute({
      id: 'call_connector_search', name: 'github_search_code', arguments: { query: 'marker' },
    }, context)
    expect(JSON.parse(connectorResult.content)).toEqual({
      status: 'success', query: 'marker', matches: ['src/probe.ts:1'],
    })
    expect(executeConnectorTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'call_connector_search', name: 'github_search_code' }),
      expect.objectContaining({ ...context, callId: 'call_connector_search' }),
    )
    const invalidConnectorCall = await tools.execute({
      id: 'call_connector_invalid', name: 'github_search_code', arguments: {},
    }, context)
    expect(invalidConnectorCall).toMatchObject({ isError: true })
    expect(invalidConnectorCall.content).toContain('query: required property is missing')
    expect(executeConnectorTool).toHaveBeenCalledTimes(1)
    const unavailableTools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        connectorTools: { github: [connectorTool] },
        connectorExecutors: { github: executeConnectorTool },
        connectorAvailability: { github: async () => false },
      },
    )
    const dynamicallyDisconnected = await unavailableTools.execute({
      id: 'call_connector_dynamic_disconnected', name: 'list_connector_tools', arguments: { service: 'github' },
    }, context)
    expect(JSON.parse(dynamicallyDisconnected.content)).toEqual({
      status: 'disconnected', connector: 'github',
    })
    const disabled = await tools.execute({
      id: 'call_connector_disabled', name: 'list_connector_tools', arguments: { service: 'github' },
    }, { ...context, enabledConnectorSlugs: [] })
    expect(JSON.parse(disabled.content)).toEqual({
      status: 'disabled', connector: 'github',
    })
    const failedAvailabilityTools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        connectorTools: { github: [connectorTool] },
        connectorExecutors: { github: executeConnectorTool },
        connectorAvailability: { github: async () => { throw new Error('synthetic database failure') } },
      },
    )
    const databaseError = await failedAvailabilityTools.execute({
      id: 'call_connector_database_error', name: 'list_connector_tools', arguments: { service: 'github' },
    }, { ...context, enabledConnectorSlugs: ['github'] })
    expect(JSON.parse(databaseError.content)).toEqual({
      status: 'database_error', message: 'Could not check the connector connection. Try again.',
    })
    const unsupported = await tools.execute({
      id: 'call_connector_unsupported', name: 'list_connector_tools', arguments: { service: 'slack' },
    }, context)
    expect(JSON.parse(unsupported.content)).toEqual({ status: 'unsupported' })
  })

  it('returns all propose_plan decisions with the exact Markdown and review payload', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-propose-plan-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const markdown = '# Plan\n\n1. Inspect\n2. Build\n'
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'plans/task.md', markdown)
    const requestHumanInput = vi.fn(async (_context, request) => {
      if (request.call.id.endsWith('accept')) return { decision: 'accepted' }
      if (request.call.id.endsWith('revise')) return { decision: 'revise' }
      return { decision: 'rejected' }
    })
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { requestHumanInput },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_propose_plan',
      stepId: 'step_propose_plan',
      signal: new AbortController().signal,
    }
    const executeDecision = async (suffix: string) => await tools.execute({
      id: `call_plan_${suffix}`,
      name: 'propose_plan',
      arguments: { path: '~/plans/task.md', highlights: ['Inspect first', 'Verify build'] },
    }, context)

    expect(JSON.parse((await executeDecision('accept')).content)).toEqual({ decision: 'accepted' })
    expect(JSON.parse((await executeDecision('revise')).content)).toEqual({ decision: 'revise' })
    const rejected = await executeDecision('reject')
    expect(rejected.isError).toBe(false)
    expect(JSON.parse(rejected.content)).toEqual({ decision: 'rejected' })
    expect(requestHumanInput).toHaveBeenCalledTimes(3)
    expect(requestHumanInput.mock.calls[0][1]).toMatchObject({
      kind: 'propose_plan',
      payload: { path: 'plans/task.md', highlights: ['Inspect first', 'Verify build'], markdown },
    })
  })

  it('downloads image_search results into the workspace with source attribution', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-image-search-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input)
      if (url.startsWith('https://api.pexels.com/v1/search')) return Response.json({
        total_results: 1,
        photos: [{
          id: 42,
          width: 1200,
          height: 800,
          url: 'https://pexels.example/photo/42',
          photographer: 'Synthetic Author',
          photographer_url: 'https://pexels.example/author',
          alt: 'Synthetic skyline',
          src: { large2x: 'https://images.example/42.png' },
        }],
      })
      if (url === 'https://images.example/42.png') return new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
      throw new Error(`Unexpected image_search URL: ${url}`)
    })
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
        pexelsApiKey: 'test-pexels-key',
      },
    )
    const result = await tools.execute({
      id: 'call_image_search', name: 'image_search', arguments: { query: 'Synthetic Skyline', count: 1 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_image_search',
      stepId: 'step_image_search',
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      results: [{
        file_path: 'images/synthetic-skyline-01.png',
        hash: expect.any(String),
        thumbnail_url: 'https://images.example/42.png',
        title: 'Synthetic skyline',
        source_url: 'https://pexels.example/photo/42',
      }],
    })
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'images/synthetic-skyline-01.png'))).resolves.toEqual(png)
    expect((await store.get(session.summary.id)).artifacts).toEqual([
      expect.objectContaining({ path: 'images/synthetic-skyline-01.png', kind: 'image' }),
    ])
  })

  it('falls back from Pexels to admitted Tavily images and records provider usage', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-image-search-tavily-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const secret = 'tvly-image-secret-123456789'
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6])
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1])
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('https://api.pexels.com/v1/search')) {
        return new Response('temporarily unavailable', { status: 503 })
      }
      if (url === 'https://tavily.example/search') {
        expect(init).toMatchObject({
          method: 'POST',
          redirect: 'manual',
          headers: { authorization: `Bearer ${secret}` },
        })
        expect(JSON.parse(String(init?.body))).toEqual({
          query: 'Misty Forest',
          topic: 'general',
          search_depth: 'basic',
          max_results: 2,
          include_answer: false,
          include_raw_content: false,
          include_images: true,
          include_image_descriptions: true,
        })
        return Response.json({
          images: [
            { url: 'http://127.0.0.1/private.png', description: 'Unsafe image' },
            {
              url: 'https://cdn.example/forest.png#first',
              description: `Misty forest evidence ${secret}`,
              source_url: 'https://photos.example/forest#gallery',
            },
            { url: 'https://cdn.example/forest.png#duplicate', description: 'Duplicate image' },
            { url: 'https://cdn.example/clouds.webp', description: 'Cloud bands' },
          ],
        })
      }
      if (url === 'https://cdn.example/forest.png') {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
      }
      if (url === 'https://cdn.example/clouds.webp') {
        return new Response(webp, { status: 200, headers: { 'content-type': 'image/webp' } })
      }
      throw new Error(`Unexpected Tavily image_search URL: ${url}`)
    })
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => {
          const url = new URL(raw)
          if (url.hostname === '127.0.0.1') throw new Error('private address rejected')
          return url
        },
        pexelsApiKey: 'test-pexels-key',
        tavilyApiKey: secret,
        tavilyBaseUrl: 'https://tavily.example/',
      },
    )
    const result = await tools.execute({
      id: 'call_image_search_tavily', name: 'image_search', arguments: { query: 'Misty Forest', count: 2 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_image_search_tavily',
      stepId: 'step_image_search_tavily',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      results: [
        {
          file_path: 'images/misty-forest-01.png',
          hash: expect.any(String),
          thumbnail_url: 'https://cdn.example/forest.png',
          title: 'Misty forest evidence [REDACTED]',
          source_url: 'https://photos.example/forest',
        },
        {
          file_path: 'images/misty-forest-02.webp',
          hash: expect.any(String),
          thumbnail_url: 'https://cdn.example/clouds.webp',
          title: 'Cloud bands',
          source_url: 'https://cdn.example/clouds.webp',
        },
      ],
    })
    expect(result.content).not.toContain(secret)
    expect(result.webProviderUsage).toMatchObject({
      schemaVersion: 1,
      cache: 'not_applicable',
      providerCalls: 1,
      requests: [{ provider: 'tavily', operation: 'search', calls: 1, outcome: 'success' }],
      costUsd: null,
      costStatus: 'not_available',
    })
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'images/misty-forest-01.png'))).resolves.toEqual(png)
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'images/misty-forest-02.webp'))).resolves.toEqual(webp)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('fails image_search safely when neither image provider is configured', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-image-search-unconfigured-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn()
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, pexelsApiKey: '', tavilyApiKey: '' },
    )
    const result = await tools.execute({
      id: 'call_image_search_unconfigured', name: 'image_search', arguments: { query: 'forest', count: 1 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_image_search_unconfigured',
      stepId: 'step_image_search_unconfigured',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content)).toEqual({
      status: 'error',
      message: 'image_search requires PEXELS_API_KEY or TAVILY_API_KEY to be configured',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not leak a failed Tavily image provider response', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-image-search-provider-failure-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const secret = 'tvly-image-failure-secret-123456'
    const fetchMock = vi.fn(async () => new Response(`invalid ${secret}`, { status: 401 }))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        pexelsApiKey: '',
        tavilyApiKey: secret,
        tavilyBaseUrl: 'https://tavily.example',
      },
    )
    const result = await tools.execute({
      id: 'call_image_search_provider_failure', name: 'image_search', arguments: { query: 'forest', count: 1 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_image_search_provider_failure',
      stepId: 'step_image_search_provider_failure',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content)).toEqual({ status: 'error', message: 'Image search failed: Tavily request failed' })
    expect(result.content).not.toContain(secret)
    expect(result.webProviderUsage).toMatchObject({
      providerCalls: 1,
      requests: [{ provider: 'tavily', operation: 'search', outcome: 'error' }],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reads every large-text page with an advancing 1-based cursor and no missing middle lines', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const lines = Array.from({ length: 2_002 }, (_, index) => `line-${index + 1}`)
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'long.txt', `${lines.join('\n')}\n`)
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    }

    const pages: Array<{
      content: string
      offset: number
      returnedLines: number
      hasMore: boolean
      nextOffset?: number
      lines: number
    }> = []
    let offset = 1
    do {
      const result = await tools.execute({
        id: `call_page_${offset}`,
        name: 'read_file',
        arguments: { path: 'long.txt', offset, limit: 700 },
      }, context)
      expect(result).toMatchObject({ isError: false })
      const page = JSON.parse(result.content) as (typeof pages)[number]
      pages.push(page)
      if (!page.hasMore) break
      expect(page.nextOffset).toBe(offset + page.returnedLines)
      offset = page.nextOffset!
    } while (pages.length < 10)

    expect(pages).toHaveLength(3)
    expect(pages.map((page) => [page.offset, page.returnedLines, page.hasMore, page.nextOffset])).toEqual([
      [1, 700, true, 701],
      [701, 700, true, 1401],
      [1401, 602, false, undefined],
    ])
    expect(pages.every((page) => page.lines === 2_002)).toBe(true)
    expect(pages[0].content).toContain('line-1\nline-2')
    expect(pages[1].content).toContain('line-1001')
    expect(pages[2].content).toContain('line-2002\n')
    expect(pages[0].content).toContain('READ_FILE_CONTINUATION_REQUIRED: offset=701')
    expect(pages[2].content).not.toContain('READ_FILE_CONTINUATION_REQUIRED')
  })

  it('matches active read_file UTF-8 truncation, line counts, image metadata, and binary fallback unions', async () => {
    const source = `${'开头🙂\n'.repeat(20_000)}${'中'.repeat(60_000)}\n${'结尾🚀\n'.repeat(20_000)}`
    expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(262_144)
    const bounded = truncateArenaFileTextForModel(source)
    expect(bounded.truncated).toBe(true)
    expect(bounded.content).toContain('KB elided from the middle of the file')
    expect(bounded.content).not.toContain('\uFFFD')
    expect(bounded.content).toMatch(/^开头🙂/)
    expect(bounded.content).toMatch(/结尾🚀\n$/)

    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-read-file-active-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const workspace = store.workspaceDir(session.summary.id)
    await writeWorkspaceFile(workspace, 'empty.txt', '')
    const png = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    png.writeUInt32BE(800, 16)
    png.writeUInt32BE(600, 20)
    await writeWorkspaceFile(workspace, 'image.png', png)
    await writeWorkspaceFile(workspace, 'oversized.png', Buffer.alloc(config.maxVisionImageBytes + 1))
    await writeWorkspaceFile(workspace, 'archive.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_read_file_active',
      stepId: 'step_read_file_active',
      signal: new AbortController().signal,
    }
    expect(JSON.parse((await tools.execute({ id: 'read_empty', name: 'read_file', arguments: { path: 'empty.txt' } }, context)).content)).toEqual({
      status: 'success', kind: 'text', size: 0, lines: 0, content: '', offset: 1, returnedLines: 0, hasMore: false,
    })
    const imageResult = await tools.execute({ id: 'read_image', name: 'read_file', arguments: { path: 'image.png' } }, context)
    expect(JSON.parse(imageResult.content)).toEqual({
      status: 'success', kind: 'image', mediaType: 'image/png', size: 24,
      data: png.toString('base64'), width: 800, height: 600,
    })
    expect(JSON.parse(arenaActiveToolModelOutput('read_file', imageResult.content))).toEqual({
      kind: 'image', mediaType: 'image/png', size: 24, width: 800, height: 600,
    })
    expect(arenaActiveToolContentParts('read_file', imageResult.content)).toEqual([
      { type: 'image-data', data: png.toString('base64'), mediaType: 'image/png' },
    ])
    const oversizedImage = await tools.execute(
      { id: 'read_oversized_image', name: 'read_file', arguments: { path: 'oversized.png' } },
      context,
    )
    expect(oversizedImage.isError).toBe(true)
    expect(JSON.parse(oversizedImage.content)).toEqual({
      status: 'error',
      message: `Image exceeds the ${config.maxVisionImageBytes} byte read_file limit`,
    })
    expect(JSON.parse((await tools.execute({ id: 'read_binary', name: 'read_file', arguments: { path: 'archive.zip' } }, context)).content)).toEqual({
      status: 'success', kind: 'unsupported', mediaType: 'application/zip', size: 4,
    })
  })

  it('executes Arena-compatible grep_files and glob_files through the tool protocol', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'src/one.ts', 'alpha\nneedle\nomega\n')
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'src/two.md', 'needle elsewhere\n')
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    }

    const list = await tools.execute({ id: 'call_list', name: 'list_files', arguments: { path: 'src' } }, context)
    expect(JSON.parse(list.content)).toEqual({
      files: [{ path: 'src/one.ts' }, { path: 'src/two.md' }],
      hasMore: false,
      truncated: false,
      totalFiles: 2,
    })

    const glob = await tools.execute({
      id: 'call_glob', name: 'glob_files', arguments: { pattern: '**/*.ts' },
    }, context)
    expect(glob.isError).toBe(false)
    expect(JSON.parse(glob.content)).toEqual({ status: 'success', paths: ['src/one.ts'], truncated: false })

    const grep = await tools.execute({
      id: 'call_grep', name: 'grep_files', arguments: { pattern: 'needle', glob: '*.ts', context: 1 },
    }, context)
    expect(grep.isError).toBe(false)
    expect(JSON.parse(grep.content)).toEqual({
      status: 'success',
      mode: 'content',
      matches: [{ path: 'src/one.ts', lineNumber: 2, lineContent: 'needle', contextBefore: ['alpha'], contextAfter: ['omega'] }],
      truncated: false,
    })
  })

  it('continues list_files from a session-private immutable manifest without requiring path again', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-list-pages-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    for (let index = 0; index < 5; index += 1) {
      await writeWorkspaceFile(store.workspaceDir(session.summary.id), `src/${index}.txt`, String(index))
    }
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_list_pages',
      stepId: 'step_list_pages',
      signal: new AbortController().signal,
    }
    const first = JSON.parse((await tools.execute({
      id: 'list_page_1', name: 'list_files', arguments: { path: 'src', limit: 2 },
    }, context)).content) as Record<string, unknown>
    expect(first).toMatchObject({
      files: [{ path: 'src/0.txt' }, { path: 'src/1.txt' }],
      hasMore: true,
      truncated: false,
      totalFiles: 5,
    })
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'src/00-new.txt', 'new')
    const secondCall = {
      id: 'list_page_2', name: 'list_files', arguments: { cursor: first.nextCursor },
    }
    const second = JSON.parse((await tools.execute(secondCall, context)).content)
    expect(second).toMatchObject({
      files: [{ path: 'src/2.txt' }, { path: 'src/3.txt' }],
      hasMore: true,
      totalFiles: 5,
    })
    expect(JSON.parse((await tools.execute({ ...secondCall, id: 'list_page_2_retry' }, context)).content)).toEqual(second)
    const final = JSON.parse((await tools.execute({
      id: 'list_page_3', name: 'list_files', arguments: { cursor: second.nextCursor },
    }, context)).content)
    expect(final).toEqual({
      files: [{ path: 'src/4.txt' }],
      hasMore: false,
      truncated: false,
      totalFiles: 5,
    })

    const mismatch = await tools.execute({
      id: 'list_path_mismatch', name: 'list_files', arguments: { path: '', cursor: first.nextCursor },
    }, context)
    expect(mismatch.isError).toBe(true)
    expect(JSON.parse(mismatch.content)).toMatchObject({ status: 'error', message: expect.stringMatching(/same path/) })
  })

  it('marks a bounded text attachment as incomplete and directs continuation to read_file', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const sourceLines = Array.from({ length: 3_000 }, (_, index) => (
      `${String(index + 1).padStart(4, '0')}|${'x'.repeat(45)}${index === 2_500 ? '|MIDDLE-ONLY-731' : ''}`
    ))
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'uploads/large.txt', `${sourceLines.join('\n')}\n`)
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const result = await tools.execute({
      id: 'call_attachment_page', name: 'extract_attachment', arguments: { path: 'uploads/large.txt' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ isError: false })
    expect(result.content).toContain('Text attachment output reached the 120000-byte limit')
    expect(result.content).toContain('Use read_file with offset/limit to continue')
    expect(Buffer.byteLength(result.content)).toBeLessThan(121_000)

    const firstRead = await tools.execute({
      id: 'call_attachment_text_page_1', name: 'read_file', arguments: { path: 'uploads/large.txt', limit: 1_000 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test_read_1',
      signal: new AbortController().signal,
    })
    const firstPayload = JSON.parse(firstRead.content) as { hasMore: boolean; nextOffset?: number; content: string }
    expect(firstPayload).toMatchObject({ hasMore: true, nextOffset: 1_001 })
    expect(firstPayload.content).toContain('READ_FILE_CONTINUATION_REQUIRED: offset=1001')

    const secondRead = await tools.execute({
      id: 'call_attachment_text_page_2', name: 'read_file', arguments: { path: 'uploads/large.txt', offset: firstPayload.nextOffset, limit: 2_000 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test_read_2',
      signal: new AbortController().signal,
    })
    const secondPayload = JSON.parse(secondRead.content) as { hasMore: boolean; nextOffset?: number; content: string }
    expect(secondPayload.content).toContain('MIDDLE-ONLY-731')
    expect(secondPayload.hasMore).toBe(true)
    expect(secondPayload.nextOffset).toBeGreaterThan(2_501)
  })

  it('continues an over-budget UTF-8 line with exact byte cursors before advancing by line', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-long-line-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const longLine = `${'x'.repeat(config.textReadPageBytes - 1)}🙂${'y'.repeat(config.textReadPageBytes + 20)}`
    const source = `${longLine}\nsecond-line\n`
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'minified.js', source)
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_long_line',
      stepId: 'step_long_line',
      signal: new AbortController().signal,
    }
    const rawParts: string[] = []
    const observedContentOffsets: number[] = []
    let offset = 1
    let contentOffset: number | undefined
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const result = await tools.execute({
        id: `read_long_line_${pageIndex}`,
        name: 'read_file',
        arguments: {
          path: 'minified.js',
          offset,
          ...(contentOffset !== undefined ? { content_offset: contentOffset } : {}),
        },
      }, context)
      expect(result.isError).toBe(false)
      const page = JSON.parse(result.content) as {
        content: string
        offset: number
        contentOffset?: number
        nextContentOffset?: number
        nextOffset?: number
        returnedLines: number
        hasMore: boolean
        truncatedBy?: string
      }
      const raw = page.content.split('\n\n[READ_FILE_CONTINUATION_REQUIRED:', 1)[0]
      rawParts.push(raw)
      expect(raw).not.toContain('\uFFFD')
      expect(page.offset).toBe(offset)
      if (page.contentOffset !== undefined) {
        expect(page.contentOffset).toBe(contentOffset ?? 0)
        observedContentOffsets.push(page.contentOffset)
      }
      if (page.nextContentOffset !== undefined) {
        expect(page.nextContentOffset).toBeGreaterThan(page.contentOffset ?? -1)
        expect(page.nextOffset).toBeUndefined()
        expect(page.returnedLines).toBe(0)
        expect(page.truncatedBy).toBe('bytes')
        expect(page.content).toContain(`READ_FILE_CONTINUATION_REQUIRED: offset=${offset} content_offset=${page.nextContentOffset}`)
        contentOffset = page.nextContentOffset
        continue
      }
      if (page.nextOffset !== undefined) {
        expect(page.nextOffset).toBeGreaterThan(offset)
        expect(page.returnedLines).toBe(1)
        expect(page.content).toContain(`READ_FILE_CONTINUATION_REQUIRED: offset=${page.nextOffset}`)
        offset = page.nextOffset
        contentOffset = undefined
        continue
      }
      expect(page.hasMore).toBe(false)
      break
    }
    expect(observedContentOffsets).toEqual([0, config.textReadPageBytes - 1, (config.textReadPageBytes * 2) - 1])
    expect(rawParts.join('')).toBe(source)

    const invalidBoundary = await tools.execute({
      id: 'read_long_line_invalid_boundary',
      name: 'read_file',
      arguments: { path: 'minified.js', offset: 1, content_offset: config.textReadPageBytes },
    }, context)
    expect(invalidBoundary.isError).toBe(true)
    expect(JSON.parse(invalidBoundary.content)).toMatchObject({ status: 'error' })
    expect(invalidBoundary.content).toContain('not a UTF-8 character boundary')
  })

  it('resolves only workspace images and returns vision usage to the agent ledger', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'uploads/reference.png', Buffer.from([1, 2, 3]))
    const inspect = vi.fn<VisionInspector['inspect']>(async () => ({
      content: 'A white dashboard with a dark sidebar.',
      metadata: { mime: 'image/png', bytes: 3, width: 800, height: 600 },
      usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940, cachedPromptTokens: 0 },
      estimatedCostUsd: 0.000224,
      modelCallCount: 2,
    }))
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect },
      async () => false,
    )
    const controller = new AbortController()
    const result = await tools.execute({
      id: 'call_vision',
      name: 'inspect_image',
      arguments: { path: 'uploads/reference.png', prompt: 'Identify layout.' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: controller.signal,
    })

    expect(result).toMatchObject({
      content: `Image metadata: image/png, 800×600, 3 bytes.\nImage evidence SHA-256: ${createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex')}\n\nVisual inspection:\nA white dashboard with a dark sidebar.\n\nEvidence note: visual OCR is approximate. When this is a browser screenshot, the browser snapshot or action result is authoritative for exact rendered text, control state, and element refs; use this inspection for layout, color, spacing, clipping, and overlap evidence.`,
      isError: false,
      modelUsage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 },
      estimatedCostUsd: 0.000224,
      modelCallCount: 2,
    })
    expect(inspect).toHaveBeenCalledWith(
      resolve(store.workspaceDir(session.summary.id), 'uploads/reference.png'),
      'Identify layout.',
      controller.signal,
    )
  })

  it('binds exact cover, content, and closing inspections to their immutable reference PNGs', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-exact-vision-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fixture = await installExactReferenceVisualFixture(store, session.summary.id)
    const candidate = dimensionedPng(fixture.viewport.width, fixture.viewport.height, 9)
    const candidatePath = 'evidence/candidate.png'
    const candidateTarget = resolve(store.workspaceDir(session.summary.id), candidatePath)
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), candidatePath, candidate)
    const inspect = vi.fn<VisionInspector['inspect']>()
    const compare = vi.fn<NonNullable<VisionInspector['compare']>>(async () => ({
      content: 'NO DEFECTS\nREFERENCE MATCH',
      referenceMetadata: {
        mime: 'image/png',
        bytes: fixture.screenshots.cover.length,
        width: fixture.viewport.width,
        height: fixture.viewport.height,
      },
      candidateMetadata: {
        mime: 'image/png',
        bytes: candidate.length,
        width: fixture.viewport.width,
        height: fixture.viewport.height,
      },
      usage: { promptTokens: 1_200, completionTokens: 8, totalTokens: 1_208, cachedPromptTokens: 600 },
      estimatedCostUsd: 0.0001,
      modelRequestCount: 1,
      modelCallCount: 1,
    }))
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect, compare },
      async () => false,
    )
    const controller = new AbortController()
    const phases = [
      { phase: 'cover' as const, stage: 'cover slide' },
      { phase: 'content' as const, stage: 'representative content slide' },
      { phase: 'closing' as const, stage: 'closing/source slide' },
    ]
    const candidateSha256 = createHash('sha256').update(candidate).digest('hex')

    for (const [index, { phase, stage }] of phases.entries()) {
      const prompt = `REFERENCE FIDELITY check — ${stage}. Return NO DEFECTS then REFERENCE MATCH only on pass.`
      const attestation = await appendExactRenderAttestation(store, session.summary.id, {
        callId: `browser_exact_${phase}`,
        candidatePath,
        candidateSha256,
        phase,
        viewport: fixture.viewport,
        referenceEvidenceSha256: fixture.sourceEvidenceSha256,
      })
      const result = await tools.execute({
        id: `call_exact_vision_${phase}`,
        name: 'inspect_image',
        arguments: { path: candidatePath, prompt },
      }, {
        sessionId: session.summary.id,
        turnId: 'turn_exact_vision',
        stepId: `step_exact_vision_${phase}`,
        signal: controller.signal,
      })
      const referencePath = await store.resolveReferenceVisualEvidencePath(
        session.summary.id,
        fixture.manifest,
        phase,
      )
      const referenceSha256 = fixture.manifest.phases[phase].sha256
      const digest = createHash('sha256').update(JSON.stringify({
        version: 1,
        candidate_screenshot_sha256: candidateSha256,
        reference_png_sha256: referenceSha256,
        source_evidence_sha256: fixture.sourceEvidenceSha256,
        render_profile_sha256: fixture.renderProfileSha256,
        manifest_sha256: fixture.manifest.manifestSha256,
        font_manifest_sha256: fixture.fontEvidence.manifestSha256,
        phase,
        viewport: fixture.viewport,
        render_page_epoch: attestation.pageEpoch,
        candidate_artifact_hash: attestation.artifactHash,
        comparison: 'NO DEFECTS\nREFERENCE MATCH',
      })).digest('hex')

      expect(result).toMatchObject({
        isError: false,
        modelUsage: { promptTokens: 1_200, completionTokens: 8, totalTokens: 1_208, cachedPromptTokens: 600 },
        estimatedCostUsd: 0.0001,
        modelRequestCount: 1,
        modelCallCount: 1,
      })
      expect(result.content).toContain(`Image evidence SHA-256: ${candidateSha256}`)
      expect(result.content).toContain(`Candidate screenshot SHA-256: ${candidateSha256}`)
      expect(result.content).toContain(`Reference PNG SHA-256: ${referenceSha256}`)
      expect(result.content).toContain(`Source evidence SHA-256: ${fixture.sourceEvidenceSha256}`)
      expect(result.content).toContain(`Render profile SHA-256: ${fixture.renderProfileSha256}`)
      expect(result.content).toContain(`Reference manifest SHA-256: ${fixture.manifest.manifestSha256}`)
      expect(result.content).toContain(`Font manifest SHA-256: ${fixture.fontEvidence.manifestSha256}`)
      expect(result.content).toContain(`Reference comparison phase: ${phase}`)
      expect(result.content).toContain(`Reference viewport: ${JSON.stringify(fixture.viewport)}`)
      expect(result.content).toContain(`Render page epoch: ${attestation.pageEpoch}`)
      expect(result.content).toContain(`Candidate artifact hash: ${attestation.artifactHash}`)
      expect(result.content).toContain(`Comparison digest SHA-256: ${digest}`)
      expect(result.content).toContain('\n\nVisual inspection:\nNO DEFECTS\nREFERENCE MATCH\n\nEvidence note:')
      expect(compare).toHaveBeenNthCalledWith(
        index + 1,
        referencePath,
        candidateTarget,
        expect.stringContaining(prompt),
        controller.signal,
      )
      const submittedPrompt = compare.mock.calls[index][2]
      expect(submittedPrompt).toContain('Harness-grounded deterministic evidence for this phase (authoritative)')
      expect(submittedPrompt).toContain('passed the source-bound render-profile verifier with score 100')
      expect(submittedPrompt).toContain('[ATTESTED_FIXED_SELECTORS:')
      expect(submittedPrompt).toContain('[ATTESTED_INTRINSIC_SELECTORS:')
      expect(submittedPrompt).toContain('[ATTESTED_FACT: localized_copy_not_a_defect]')
      expect(submittedPrompt).toContain('Do not claim these fixed anchors are missing')
      expect(submittedPrompt).toContain('does not prove that every visible Unicode glyph is covered')
      expect(submittedPrompt).toContain('glyph-coverage or typography-role mismatch')
      expect(submittedPrompt).toContain('translated/replaced words')
      expect(submittedPrompt).toContain('content-driven label/pill/badge/kicker dimensions')
      expect(submittedPrompt).toContain('report it only when candidate ink is visibly cut off')
    }
    expect(inspect).not.toHaveBeenCalled()
    expect(await readFile(candidateTarget)).toEqual(candidate)
  })

  it('fails exact inspection closed when dual-image capability, manifest, binding, or phase is missing', async () => {
    const cases = [
      'compare', 'manifest', 'binding', 'font_manifest', 'font_binding',
      'phase', 'attestation', 'attestation_hash', 'attestation_font',
    ] as const
    for (const missing of cases) {
      const root = await mkdtemp(resolve(tmpdir(), `anera-tools-exact-vision-missing-${missing}-`))
      roots.push(root)
      const store = new SessionStore(root, 'test-model')
      await store.initialize()
      const session = await store.create()
      const fixture = await installExactReferenceVisualFixture(store, session.summary.id, {
        includeManifest: missing !== 'manifest',
      })
      if (missing === 'binding') {
        await store.update(session.summary.id, (state) => {
          const active = state.activeReferenceStyleContract
          if (!active?.visualEvidence) throw new Error('fixture manifest missing')
          active.visualEvidence = {
            ...active.visualEvidence,
            sourceEvidenceSha256: 'f'.repeat(64),
          }
        })
      }
      if (missing === 'font_manifest' || missing === 'font_binding') {
        await store.update(session.summary.id, (state) => {
          const active = state.activeReferenceStyleContract
          if (!active?.fontEvidence) throw new Error('fixture font evidence missing')
          if (missing === 'font_manifest') delete active.fontEvidence
          else active.fontEvidence = { ...active.fontEvidence, sourceEvidenceSha256: 'f'.repeat(64) }
        })
      }
      const candidatePath = 'evidence/candidate.png'
      const candidate = dimensionedPng(fixture.viewport.width, fixture.viewport.height, 9)
      await writeWorkspaceFile(
        store.workspaceDir(session.summary.id),
        candidatePath,
        candidate,
      )
      if (missing === 'attestation_hash') {
        await appendExactRenderAttestation(store, session.summary.id, {
          callId: 'browser_exact_wrong_hash',
          candidatePath,
          candidateSha256: 'e'.repeat(64),
          phase: 'cover',
          viewport: fixture.viewport,
          referenceEvidenceSha256: fixture.sourceEvidenceSha256,
        })
      }
      if (missing === 'attestation_font') {
        await appendExactRenderAttestation(store, session.summary.id, {
          callId: 'browser_exact_wrong_font_manifest',
          candidatePath,
          candidateSha256: createHash('sha256').update(candidate).digest('hex'),
          phase: 'cover',
          viewport: fixture.viewport,
          referenceEvidenceSha256: fixture.sourceEvidenceSha256,
          fontManifestSha256: 'e'.repeat(64),
        })
      }
      const inspect = vi.fn<VisionInspector['inspect']>()
      const compare = vi.fn<NonNullable<VisionInspector['compare']>>()
      const tools = new ToolExecutor(
        store,
        new ProcessManager(() => {}, 10_000),
        new BrowserManager(),
        missing === 'compare' ? { inspect } : { inspect, compare },
        async () => false,
      )
      const result = await tools.execute({
        id: `call_exact_vision_missing_${missing}`,
        name: 'inspect_image',
        arguments: {
          path: candidatePath,
          prompt: missing === 'phase'
            ? 'Compare this screenshot with the exact reference.'
            : 'REFERENCE FIDELITY check — cover slide. Compare it.',
        },
      }, {
        sessionId: session.summary.id,
        turnId: 'turn_exact_vision_missing',
        stepId: `step_exact_vision_missing_${missing}`,
        signal: new AbortController().signal,
      })

      expect(result.isError).toBe(true)
      expect(result.content).toMatch(missing === 'compare'
        ? /requires a dual-image Vision comparison provider/
        : missing === 'manifest'
          ? /requires a durable reference visual evidence manifest/
          : missing === 'binding'
            ? /not bound to the active source evidence SHA-256/
            : missing === 'font_manifest'
              ? /requires durable font evidence/
              : missing === 'font_binding'
                ? /visual\/font evidence is not bound/iu
            : missing === 'phase'
              ? /must identify exactly one phase/
              : missing === 'attestation'
                ? /requires a successful browser screenshot render attestation/
                : /does not carry a matching exact render attestation/)
      expect(inspect).not.toHaveBeenCalled()
      expect(compare).not.toHaveBeenCalled()
    }
  })

  it('rejects an exact comparison when the candidate screenshot changes during the model call', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-exact-vision-mutated-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fixture = await installExactReferenceVisualFixture(store, session.summary.id)
    const candidatePath = 'evidence/candidate.png'
    const candidateTarget = resolve(store.workspaceDir(session.summary.id), candidatePath)
    const candidate = dimensionedPng(fixture.viewport.width, fixture.viewport.height, 9)
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), candidatePath, candidate)
    await appendExactRenderAttestation(store, session.summary.id, {
      callId: 'browser_exact_mutated',
      candidatePath,
      candidateSha256: createHash('sha256').update(candidate).digest('hex'),
      phase: 'cover',
      viewport: fixture.viewport,
      referenceEvidenceSha256: fixture.sourceEvidenceSha256,
    })
    const inspect = vi.fn<VisionInspector['inspect']>()
    const compare = vi.fn<NonNullable<VisionInspector['compare']>>(async () => {
      await writeFile(candidateTarget, dimensionedPng(fixture.viewport.width, fixture.viewport.height, 8))
      return {
        content: 'NO DEFECTS\nREFERENCE MATCH',
        referenceMetadata: { mime: 'image/png', bytes: fixture.screenshots.cover.length, ...fixture.viewport },
        candidateMetadata: { mime: 'image/png', bytes: candidate.length, ...fixture.viewport },
        usage: { promptTokens: 100, completionTokens: 4, totalTokens: 104, cachedPromptTokens: 0 },
        modelRequestCount: 1,
        modelCallCount: 1,
      }
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect, compare },
      async () => false,
    )

    const result = await tools.execute({
      id: 'call_exact_vision_mutated',
      name: 'inspect_image',
      arguments: {
        path: candidatePath,
        prompt: 'REFERENCE FIDELITY check — cover slide. Compare it.',
      },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_exact_vision_mutated',
      stepId: 'step_exact_vision_mutated',
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      isError: true,
      content: expect.stringMatching(/Image changed while visual comparison was running/),
      modelUsage: { promptTokens: 100, completionTokens: 4, totalTokens: 104, cachedPromptTokens: 0 },
      modelRequestCount: 1,
      modelCallCount: 1,
    })
    expect(compare).toHaveBeenCalledOnce()
    expect(inspect).not.toHaveBeenCalled()
  })

  it('keeps completed vision usage on a failed inspect_image result', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-vision-failed-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'uploads/reference.png', Buffer.from([1, 2, 3]))
    const inspect = vi.fn<VisionInspector['inspect']>(async () => {
      throw Object.assign(new Error('Vision model ended with unsupported finish reason: content_filter'), {
        modelUsage: { promptTokens: 900, completionTokens: 12, totalTokens: 912, cachedPromptTokens: 300 },
        estimatedCostUsd: 0.00028404,
        modelCallCount: 1,
      })
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect },
      async () => false,
    )

    const result = await tools.execute({
      id: 'call_vision_failed',
      name: 'inspect_image',
      arguments: { path: 'uploads/reference.png', prompt: 'Identify layout.' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result).toEqual({
      content: 'Vision model ended with unsupported finish reason: content_filter',
      isError: true,
      modelUsage: { promptTokens: 900, completionTokens: 12, totalTokens: 912, cachedPromptTokens: 300 },
      estimatedCostUsd: 0.00028404,
      modelCallCount: 1,
    })
  })

  it('does not pass a workspace escape path to the vision client', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const inspect = vi.fn<VisionInspector['inspect']>()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect },
      async () => false,
    )
    const result = await tools.execute({
      id: 'call_escape',
      name: 'inspect_image',
      arguments: { path: '../outside.png', prompt: 'Inspect.' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/escapes the workspace/)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('rejects symlink traversal across attachment, vision, build/start, and browser file tools', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const workspace = store.workspaceDir(session.summary.id)
    const outside = resolve(root, 'outside')
    await mkdir(outside)
    await writeFile(resolve(outside, 'secret.txt'), 'outside text')
    await writeFile(resolve(outside, 'secret.png'), Buffer.from([1, 2, 3]))
    await writeFile(resolve(outside, 'secret.html'), '<h1>outside</h1>')
    await symlink(resolve(outside, 'secret.txt'), resolve(workspace, 'linked.txt'))
    await symlink(resolve(outside, 'secret.png'), resolve(workspace, 'linked.png'))
    await symlink(resolve(outside, 'secret.html'), resolve(workspace, 'index.html'))
    await symlink(outside, resolve(workspace, 'linked-dir'))

    const inspect = vi.fn<VisionInspector['inspect']>()
    const browser = new BrowserManager()
    const browserOpen = vi.spyOn(browser, 'open')
    const browserScreenshot = vi.spyOn(browser, 'screenshot')
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      browser,
      { inspect },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    }

    for (const call of [
      { id: 'call_extract_link', name: 'extract_attachment', arguments: { path: 'linked.txt' } },
      { id: 'call_vision_link', name: 'inspect_image', arguments: { path: 'linked.png', prompt: 'Inspect.' } },
      { id: 'call_browser_open_link', name: 'browser', arguments: { action: 'open', path: 'index.html' } },
      { id: 'call_browser_shot_link', name: 'browser', arguments: { action: 'screenshot', screenshot_path: 'linked-dir/capture.png' } },
    ]) {
      const result = await tools.execute(call, context)
      expect(result).toMatchObject({ isError: true, content: expect.stringMatching(/Symlink traversal/) })
    }
    const linkedWorkdir = await tools.execute({
      id: 'call_shell_linked_workdir', name: 'shell_command', arguments: { command: 'pwd', workdir: 'linked-dir' },
    }, context)
    expect(linkedWorkdir.isError).toBe(true)
    expect(JSON.parse(linkedWorkdir.content)).toMatchObject({ status: 'error', message: expect.stringMatching(/Symlink traversal/) })
    const buildAndStart = await tools.execute({
      id: 'call_build_link', name: 'build_and_start', arguments: {},
    }, context)
    expect(buildAndStart.isError).toBe(true)
    expect(JSON.parse(buildAndStart.content)).toMatchObject({ status: 'error', stage: 'building' })
    expect(inspect).not.toHaveBeenCalled()
    expect(browserOpen).not.toHaveBeenCalled()
    expect(browserScreenshot).not.toHaveBeenCalled()
    expect((await store.get(session.summary.id)).website.status).toBe('stopped')
  })

  it('captures browser screenshots into the durable workspace mutation protocol', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-browser-screenshot-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const browser = new BrowserManager()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const screenshot = vi.spyOn(browser, 'screenshot').mockResolvedValue(png)
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      browser,
      { inspect: vi.fn() },
      async () => false,
    )
    const result = await tools.execute({
      id: 'call_browser_screenshot',
      name: 'browser',
      arguments: { action: 'screenshot', path: 'evidence/page.png' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_browser',
      stepId: 'step_browser',
      signal: new AbortController().signal,
    })

    expect(result).toEqual({ content: 'Saved browser screenshot to evidence/page.png (12 bytes).', isError: false })
    expect(screenshot).toHaveBeenCalledWith(session.summary.id, expect.anything())
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'evidence/page.png'))).resolves.toEqual(png)
    const state = await store.get(session.summary.id)
    expect(state.pendingWorkspaceMutations).toBeUndefined()
    expect(state.summary.workspaceBytes).toBe(12)
    expect(state.artifacts).toEqual([expect.objectContaining({ path: 'evidence/page.png', kind: 'image', mime: 'image/png' })])
    expect((await store.events(session.summary.id)).map((event) => event.type)).toEqual(expect.arrayContaining(['file.changed', 'artifact.created']))
  })

  it('resolves explicit browser paths against the injected local App origin', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-browser-origin-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeFile(resolve(store.workspaceDir(session.summary.id), 'dashboard.html'), '<h1>Dashboard</h1>')
    const browser = new BrowserManager()
    const open = vi.spyOn(browser, 'open').mockResolvedValue({ text: 'Dashboard' })
    let appOrigin = 'http://127.0.0.1:49123'
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      browser,
      { inspect: vi.fn() },
      async () => false,
      { localAppBaseUrl: () => appOrigin },
    )

    const result = await tools.execute({
      id: 'call_browser_origin',
      name: 'browser',
      arguments: { action: 'open', path: 'dashboard.html' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_browser_origin',
      stepId: 'step_browser_origin',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(open).toHaveBeenCalledWith(
      session.summary.id,
      `${appOrigin}/workspace/${session.summary.id}/preview/dashboard.html`,
      expect.anything(),
    )
    appOrigin = ''
  })

  it('fails an explicit Browser open before transport when the workspace file is missing', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-browser-missing-file-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const browser = new BrowserManager()
    const open = vi.spyOn(browser, 'open').mockResolvedValue({ text: 'unexpected preview response' })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      browser,
      { inspect: vi.fn() },
      async () => false,
      { localAppBaseUrl: 'http://127.0.0.1:49123' },
    )

    const result = await tools.execute({
      id: 'call_browser_missing_file',
      name: 'browser',
      arguments: { action: 'open', path: 'missing-deck.html' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_browser_missing_file',
      stepId: 'step_browser_missing_file',
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      isError: true,
      content: expect.stringContaining('Browser cannot open missing workspace file: missing-deck.html'),
    })
    expect(open).not.toHaveBeenCalled()
  })

  it('applies an explicit viewport on browser open and returns the resized snapshot', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-browser-open-viewport-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeFile(resolve(store.workspaceDir(session.summary.id), 'dashboard.html'), '<h1>Dashboard</h1>')
    const browser = new BrowserManager()
    const open = vi.spyOn(browser, 'open').mockResolvedValue({ viewport: { width: 1440, height: 900 }, text: 'Dashboard' })
    const setViewport = vi.spyOn(browser, 'setViewport').mockResolvedValue({ viewport: { width: 1200, height: 800 }, text: 'Dashboard' })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      browser,
      { inspect: vi.fn() },
      async () => false,
      { localAppBaseUrl: 'http://127.0.0.1:49123' },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_browser_open_viewport',
      stepId: 'step_browser_open_viewport',
      signal: new AbortController().signal,
    }

    const result = await tools.execute({
      id: 'call_browser_open_viewport',
      name: 'browser',
      arguments: { action: 'open', path: 'dashboard.html', width: 1200, height: 800 },
    }, context)

    expect(result).toEqual({
      content: JSON.stringify({ viewport: { width: 1200, height: 800 }, text: 'Dashboard' }, null, 2),
      isError: false,
    })
    expect(open).toHaveBeenCalledOnce()
    expect(setViewport).toHaveBeenCalledWith(session.summary.id, 1200, 800, context.signal)
  })

  it('rejects a partial viewport on browser open instead of silently ignoring it', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-browser-open-partial-viewport-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeFile(resolve(store.workspaceDir(session.summary.id), 'dashboard.html'), '<h1>Dashboard</h1>')
    const browser = new BrowserManager()
    const open = vi.spyOn(browser, 'open').mockResolvedValue({ text: 'Dashboard' })
    const setViewport = vi.spyOn(browser, 'setViewport')
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      browser,
      { inspect: vi.fn() },
      async () => false,
      { localAppBaseUrl: 'http://127.0.0.1:49123' },
    )

    const result = await tools.execute({
      id: 'call_browser_open_partial_viewport',
      name: 'browser',
      arguments: { action: 'open', path: 'dashboard.html', width: 1200 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_browser_open_partial_viewport',
      stepId: 'step_browser_open_partial_viewport',
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('requires both width and height') })
    expect(open).not.toHaveBeenCalled()
    expect(setViewport).not.toHaveBeenCalled()
  })

  it('anchors a missing basename-only browser path to the published Website entry', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-browser-entry-anchor-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'service-dashboard/index.html', '<h1>Service Health</h1>')
    await store.recordWebsiteUpdate(session.summary.id, {
      status: 'running',
      entryPath: 'service-dashboard/index.html',
      previewUrl: 'http://127.0.0.1:8080',
      processId: 'proc_fixture',
      port: 8080,
      updatedAt: new Date().toISOString(),
      restartCount: 0,
    })
    const browser = new BrowserManager()
    const open = vi.spyOn(browser, 'open').mockResolvedValue({ text: 'Service Health' })
    const appOrigin = 'http://127.0.0.1:49123'
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      browser,
      { inspect: vi.fn() },
      async () => false,
      { localAppBaseUrl: appOrigin },
    )

    const result = await tools.execute({
      id: 'call_browser_entry_anchor',
      name: 'browser',
      arguments: { action: 'open', path: 'index.html' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_browser_entry_anchor',
      stepId: 'step_browser_entry_anchor',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(open).toHaveBeenCalledWith(
      session.summary.id,
      `${appOrigin}/workspace/${session.summary.id}/preview/service-dashboard/index.html`,
      expect.anything(),
    )
  })

  it('sends an approved external request once and discards the response body', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'manual',
        body: '{"probe":"approved","value":7}',
      })
      return new Response('untrusted response must not enter context', { status: 201 })
    })
    const approval = vi.fn(async () => true)
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      approval,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
      },
    )
    const call = {
      id: 'call_approved',
      name: 'http_request',
      arguments: { url: 'https://public.example/write', method: 'POST', json_body: { probe: 'approved', value: 7 } },
    }
    const result = await tools.execute(call, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(approval).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toMatchObject({ status: 201, bodyDiscarded: true, redirected: false })
    expect(result.content).not.toContain('untrusted response')
  })

  it('times out only the approved HTTP execution phase and aborts the underlying request', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    let requestAborted = false
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const onAbort = () => {
        requestAborted = true
        reject(signal?.reason || new DOMException('Aborted', 'AbortError'))
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    }))
    const approval = vi.fn(async () => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
      return true
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      approval,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
        toolTimeoutMs: 15,
      },
    )
    const result = await tools.execute({
      id: 'call_timeout',
      name: 'http_request',
      arguments: { url: 'https://public.example/write', method: 'POST', json_body: { probe: 'timeout' } },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(approval).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(requestAborted).toBe(true)
    expect(result).toMatchObject({ isError: true, timedOut: true, content: expect.stringContaining('15ms') })
  })

  it('does not call fetch when an external request is denied', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, validatePublicUrl: async (raw) => new URL(raw) },
    )
    const result = await tools.execute({
      id: 'call_denied',
      name: 'http_request',
      arguments: { url: 'https://public.example/write', method: 'DELETE' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('not sent') })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses Tavily for web_search and maps depth, citations, dates, and secret redaction to the Arena result', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-tavily-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const secret = 'tvly-test-secret-123456789'
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://tavily.example/search')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${secret}` })
      expect(JSON.parse(String(init?.body))).toEqual({
        query: 'current web protocol evidence',
        topic: 'general',
        search_depth: 'advanced',
        max_results: 8,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        chunks_per_source: 3,
      })
      return Response.json({
        results: [
          {
            title: 'Authoritative protocol reference',
            url: 'https://standards.example/protocol',
            content: `  Current   protocol evidence ${secret}. `,
            published_date: '2026-08-29',
            score: 0.98,
          },
          { title: '', url: 'javascript:alert(1)', content: 'invalid result' },
        ],
      })
    })
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
        tavilyApiKey: secret,
        tavilyBaseUrl: 'https://tavily.example/',
      },
    )
    const result = await tools.execute({
      id: 'call_tavily',
      name: 'web_search',
      arguments: { query: 'current web protocol evidence', depth: '3' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_tavily',
      stepId: 'step_tavily',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      results: [{
        id: 1,
        title: 'Authoritative protocol reference',
        url: 'https://standards.example/protocol',
        description: 'Current protocol evidence [REDACTED].',
        pageAge: '2026-08-29',
      }],
    })
    expect(result.content).not.toContain(secret)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.webProviderUsage).toMatchObject({
      schemaVersion: 1,
      cache: 'not_applicable',
      providerCalls: 1,
      requests: [{ provider: 'tavily', operation: 'search', calls: 1, outcome: 'success' }],
      costUsd: null,
      costStatus: 'not_available',
    })
  })

  it('admits only public unique Tavily result URLs and stably reindexes the surviving citations', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-tavily-result-admission-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn(async () => Response.json({
      results: [
        { title: 'Public primary', url: 'https://public.example/article#intro', content: 'Primary evidence.', published_date: '2026-08-30' },
        { title: 'Duplicate fragment', url: 'https://public.example/article#details', content: 'Duplicate evidence.' },
        { title: 'Loopback', url: 'http://127.0.0.1/private', content: 'Unsafe loopback.' },
        { title: 'Localhost', url: 'http://localhost/admin', content: 'Unsafe local host.' },
        { title: 'Credentialed', url: 'https://user:pass@public.example/secret', content: 'Unsafe credentials.' },
        { title: 'Second public', url: 'https://second.example/path', content: 'Second source.' },
      ],
    }))
    const validated: string[] = []
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        tavilyApiKey: 'tvly-result-admission-secret',
        tavilyBaseUrl: 'https://tavily.example',
        validatePublicUrl: async (raw) => {
          validated.push(raw)
          const url = new URL(raw)
          if (url.username || url.password) throw new Error('credentials rejected')
          if (['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('private host rejected')
          return url
        },
      },
    )
    const result = await tools.execute({
      id: 'call_tavily_result_admission',
      name: 'web_search',
      arguments: { query: 'safe sources only', depth: '3' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_tavily_result_admission',
      stepId: 'step_tavily_result_admission',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      results: [
        {
          id: 1,
          title: 'Public primary',
          url: 'https://public.example/article',
          description: 'Primary evidence.',
          pageAge: '2026-08-30',
        },
        {
          id: 2,
          title: 'Second public',
          url: 'https://second.example/path',
          description: 'Second source.',
        },
      ],
    })
    expect(validated).toEqual([
      'https://public.example/article#intro',
      'https://public.example/article#details',
      'http://127.0.0.1/private',
      'http://localhost/admin',
      'https://user:pass@public.example/secret',
      'https://second.example/path',
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.webProviderUsage).toMatchObject({
      providerCalls: 1,
      requests: [{ provider: 'tavily', outcome: 'success' }],
    })
  })

  it('falls back after Tavily returns no public result URL and filters fallback results too', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-search-result-fallback-admission-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fallbackHtml = [
      '<li class="b_algo"><h2><a href="http://localhost/private">Unsafe</a></h2><div class="b_caption"><p>Unsafe.</p></div></li>',
      '<li class="b_algo"><h2><a href="https://safe.example/result#section">Safe fallback</a></h2><div class="b_caption"><p>Usable evidence.</p></div></li>',
    ].join('')
    const fetchMock = vi.fn(async (input: string | URL | Request) => (
      String(input) === 'https://tavily.example/search'
        ? Response.json({ results: [{ title: 'Unsafe provider result', url: 'http://127.0.0.1/private', content: 'Do not admit.' }] })
        : new Response(fallbackHtml, { status: 200, headers: { 'content-type': 'text/html' } })
    ))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        tavilyApiKey: 'tvly-fallback-result-admission-secret',
        tavilyBaseUrl: 'https://tavily.example',
        validatePublicUrl: async (raw) => {
          const url = new URL(raw)
          if (['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('private host rejected')
          return url
        },
      },
    )
    const result = await tools.execute({
      id: 'call_search_result_fallback_admission',
      name: 'web_search',
      arguments: { query: 'safe fallback source', depth: '1' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_search_result_fallback_admission',
      stepId: 'step_search_result_fallback_admission',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      results: [{
        id: 1,
        title: 'Safe fallback',
        url: 'https://safe.example/result',
        description: 'Usable evidence.',
      }],
    })
    expect(result.webProviderUsage).toMatchObject({
      providerCalls: 2,
      requests: [
        { provider: 'tavily', outcome: 'empty' },
        { provider: 'bing', outcome: 'success' },
      ],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['HTTP 401', () => new Response('unauthorized', { status: 401 })],
    ['HTTP 429', () => new Response('rate limited', { status: 429 })],
    ['HTTP 503', () => new Response('unavailable', { status: 503 })],
    ['invalid JSON', () => new Response('not-json', { status: 200 })],
  ])('falls back to HTML search without leaking Tavily failures for %s', async (_label, providerResponse) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-tavily-fallback-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const secret = 'tvly-fallback-secret-123456'
    const html = '<li class="b_algo"><h2><a href="https://example.com/result"><strong>Fallback result</strong></a></h2><div class="b_caption"><p>Fallback evidence.</p></div></li>'
    const fetchMock = vi.fn(async (input: string | URL | Request) => (
      String(input) === 'https://tavily.example/search'
        ? providerResponse()
        : new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
    ))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => new URL(raw),
        tavilyApiKey: secret,
        tavilyBaseUrl: 'https://tavily.example',
      },
    )
    const result = await tools.execute({
      id: 'call_tavily_fallback',
      name: 'web_search',
      arguments: { query: 'fallback evidence', depth: '1' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_tavily_fallback',
      stepId: 'step_tavily_fallback',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      results: [{
        id: 1,
        title: 'Fallback result',
        url: 'https://example.com/result',
        description: 'Fallback evidence.',
      }],
    })
    expect(result.content).not.toContain(secret)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.webProviderUsage).toMatchObject({
      cache: 'not_applicable',
      providerCalls: 2,
      requests: [
        { provider: 'tavily', calls: 1, outcome: 'error' },
        { provider: 'bing', calls: 1, outcome: 'success' },
      ],
      costUsd: null,
      costStatus: 'not_available',
    })
  })

  it('returns an aborted web_search result without trying an HTML fallback after Tavily cancellation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-tavily-abort-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      throw init?.signal?.reason ?? new Error('cancelled')
    })
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        tavilyApiKey: 'tvly-abort-secret-123456',
        tavilyBaseUrl: 'https://tavily.example',
      },
    )
    const result = await tools.execute({
      id: 'call_tavily_aborted',
      name: 'web_search',
      arguments: { query: 'cancelled search', depth: '2' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_tavily_aborted',
      stepId: 'step_tavily_aborted',
      signal: controller.signal,
    })

    expect(result).toMatchObject({ isError: true, aborted: true })
    expect(JSON.parse(result.content)).toEqual({ status: 'aborted' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    ['1', 4],
    ['2', 6],
    ['3', 8],
  ])('returns the exact Arena web_search union at depth %s', async (depth, expectedCount) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const html = `<ol>${Array.from({ length: 9 }, (_, index) => (
      `<li class="b_algo"><h2><a href="https://example.com/result-${index + 1}"><strong>Result ${index + 1}</strong></a></h2><div class="b_caption"><p>Description ${index + 1}.</p></div></li>`
    )).join('')}</ol>`
    const fetchMock = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }))
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, validatePublicUrl: async (raw) => new URL(raw) },
    )
    const result = await tools.execute({ id: 'call_search', name: 'web_search', arguments: { query: 'RFC 8297', depth } }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      results: Array.from({ length: expectedCount }, (_, index) => ({
        id: index + 1,
        title: `Result ${index + 1}`,
        url: `https://example.com/result-${index + 1}`,
        description: `Description ${index + 1}.`,
      })),
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    ['markdown', '# Web Protocol\n\nRead [the RFC](https://www.rfc-editor.org/rfc/rfc8297.html)\n\n- First item'],
    ['text', 'Web Protocol Read the RFC First item'],
    ['html', '<!doctype html><html><head><title>Arena &amp; Web</title><style>.hidden{display:none}</style><script>SECRET_SCRIPT()</script></head><body><h1>Web Protocol</h1><p>Read <a href="https://www.rfc-editor.org/rfc/rfc8297.html">the RFC</a></p><ul><li>First item</li></ul></body></html>'],
  ])('returns Arena web_fetch success in %s format', async (format, expectedContent) => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const html = '<!doctype html><html><head><title>Arena &amp; Web</title><style>.hidden{display:none}</style><script>SECRET_SCRIPT()</script></head><body><h1>Web Protocol</h1><p>Read <a href="https://www.rfc-editor.org/rfc/rfc8297.html">the RFC</a></p><ul><li>First item</li></ul></body></html>'
    const fetchMock = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }))
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, validatePublicUrl: async (raw) => new URL(raw) },
    )
    const result = await tools.execute({
      id: `call_fetch_${format}`,
      name: 'web_fetch',
      arguments: { url: 'https://example.com/article', format },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      title: 'Arena & Web',
      content: expectedContent,
    })
    if (format !== 'html') {
      expect(result.content).not.toContain('SECRET_SCRIPT')
      expect(result.content).not.toContain('display:none')
    }
  })

  it('returns Arena web_fetch errors and revalidates every redirect hop', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const validated: string[] = []
    const responses = [
      new Response('', { status: 302, headers: { location: 'https://cdn.example.com/missing' } }),
      new Response('<title>Missing</title><h1>Not found</h1>', { status: 404, headers: { 'content-type': 'text/html' } }),
    ]
    const fetchMock = vi.fn(async () => responses.shift() as Response)
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => {
          validated.push(raw)
          return new URL(raw)
        },
      },
    )
    const result = await tools.execute({
      id: 'call_fetch_missing',
      name: 'web_fetch',
      arguments: { url: 'https://example.com/start', format: 'markdown' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content)).toEqual({
      status: 'error',
      message: 'HTTP 404 fetching https://cdn.example.com/missing',
      stdout: '# Not found',
    })
    expect(validated).toEqual(['https://example.com/start', 'https://cdn.example.com/missing'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true)
  })

  it('records only a source-grounded reference contract and statically rejects the prior navy-and-gold redesign', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-reference-style-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const referenceUrl = 'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/main/templates/blue-professional/template.html'
    const referenceHtml = '<!doctype html><html><head><style>:root{--bg:#fdfae7;--primary:#1e2bfa;--text:#111111;--muted:#6b6b6b;--accent-medium:rgba(30,43,250,0.15)}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--bg)}body{font-family:Inter;color:var(--text)}p{color:var(--muted)}.deck{position:relative;width:100vw;height:100vh}.slide{position:absolute;inset:0;display:flex;flex-direction:column;opacity:0}.slide.active{opacity:1}.layout-cover{justify-content:center;clip-path:polygon(30% 0,100% 0,100% 100%,0 100%)}.cover-dots{display:grid;grid-template-columns:repeat(3,6px)}.slide-header{display:flex;justify-content:space-between}.layout-closing{display:flex;align-items:center;justify-content:center}.progress-bar{height:3px;position:fixed;left:0;right:0;bottom:0;background:var(--primary)}.nav-controls{position:fixed;right:24px;bottom:20px}h1{font-family:"Space Grotesk"}</style></head><body><main class="deck"><section class="slide active layout-cover"><h1>Reference cover</h1><p>Reference subtitle</p><div class="cover-dots"><span></span><span></span><span></span></div></section><section class="slide"><header class="slide-header"><span>Overview</span><span>Weekly</span></header></section><section class="slide layout-closing"><h1>Reference closing</h1></section></main><div class="progress-bar"></div><nav class="nav-controls"><button>Previous</button><button>Next</button></nav></body></html>'
    const fetchCall = {
      id: 'reference-fetch',
      type: 'function' as const,
      function: { name: 'web_fetch', arguments: JSON.stringify({ url: referenceUrl, format: 'html' }) },
    }
    await store.update(session.summary.id, (state) => {
      state.messages = [{ role: 'user', content: '严格参考 blue-professional 制作 HTML Slides。' }, {
        role: 'assistant', content: null, tool_calls: [fetchCall],
      }, {
        role: 'tool', tool_call_id: fetchCall.id, tool_result_status: 'succeeded',
        content: JSON.stringify({ status: 'success', url: referenceUrl, content: referenceHtml }),
      }]
    })
    const referenceBrowser = new BrowserManager()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      referenceBrowser,
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_reference_style',
      stepId: 'step_reference_style',
      signal: new AbortController().signal,
    }
    const contractArguments = {
      source_url: referenceUrl,
      strictness: 'exact',
      colors: ['#fdfae7', '#1e2bfa', '#111111', '#6b6b6b'],
      fonts: ['Space Grotesk', 'Inter'],
      layout: ['warm cream 16:9 canvas', 'diagonal cover panel and dot grid'],
      components: ['soft cobalt cards', 'circular navigation and progress bar'],
      required_markers: ['.layout-cover', '.cover-dots', '.progress-bar', '.nav-controls', '.slide.active'],
      signature: 'Warm cream canvas with one cobalt accent and restrained consulting geometry.',
      avoid: ['dark gradient cover', 'gold accent', 'full-width dark footer'],
      viewport: { width: 1440, height: 900 },
    }
    const fabricated = await tools.execute({
      id: 'record-fabricated-reference',
      name: 'record_reference_style',
      arguments: {
        ...contractArguments,
        colors: ['#081426', '#d4af37', '#ffffff'],
        fonts: ['Segoe UI', 'PingFang SC'],
        required_markers: ['.dark-cover', '.gold-divider', '.square-nav'],
      },
    }, context)
    expect(fabricated.isError).toBe(true)
    expect(JSON.parse(fabricated.content)).toMatchObject({
      status: 'error', message: expect.stringMatching(/not grounded/iu),
    })

    const cssOnlyReference = referenceHtml.replace(/<main[\s\S]*$/u, '')
    await store.update(session.summary.id, (state) => {
      const fetchResult = state.messages.find((message) => message.role === 'tool' && message.tool_call_id === fetchCall.id)
      if (fetchResult) fetchResult.content = JSON.stringify({ status: 'success', url: referenceUrl, content: cssOnlyReference })
    })
    const exactWithoutDom = await tools.execute({
      id: 'record-reference-without-dom', name: 'record_reference_style', arguments: contractArguments,
    }, context)
    expect(exactWithoutDom.isError).toBe(true)
    expect(JSON.parse(exactWithoutDom.content)).toMatchObject({
      status: 'error', message: expect.stringMatching(/not grounded|concrete template.*CSS.*DOM/iu),
    })
    await store.update(session.summary.id, (state) => {
      const fetchResult = state.messages.find((message) => message.role === 'tool' && message.tool_call_id === fetchCall.id)
      if (fetchResult) fetchResult.content = JSON.stringify({ status: 'success', url: referenceUrl, content: referenceHtml })
      state.referenceStyleEvidenceInvalidation = {
        version: 1,
        contractEvidenceSha256: 'f'.repeat(64),
        sourceUrl: referenceUrl,
        sourceEvidenceSha256: 'e'.repeat(64),
        strictness: 'exact',
        reason: 'visual_evidence_missing_or_invalid',
        invalidatedAt: new Date().toISOString(),
      }
    })

    const recorded = await tools.execute({
      id: 'record-reference',
      name: 'record_reference_style',
      arguments: {
        ...contractArguments,
        colors: [...contractArguments.colors, 'rgba(30, 43, 250, 0.15)'],
      },
    }, context)
    expect(recorded.isError, recorded.content).toBe(false)
    const recordedState = await store.get(session.summary.id)
    expect(recordedState.referenceStyleEvidenceInvalidation).toBeUndefined()
    expect(recordedState.activeReferenceStyleEvidenceGeneration).toMatch(/^ref_[a-z0-9]{20}$/u)
    const recordedPayload = JSON.parse(recorded.content) as Record<string, unknown>
    expect(recordedPayload).toMatchObject({
      status: 'success',
      contract: contractArguments,
      normalization: {
        omitted_visually_inert_colors: ['rgba(30,43,250,0.15)'],
      },
      provenance: {
        resolvedUrl: referenceUrl,
        evidenceSha256: createHash('sha256').update(referenceHtml).digest('hex'),
        evidenceBytes: Buffer.byteLength(referenceHtml),
      },
      source_profile: {
        version: 1,
        rules: expect.arrayContaining([
          expect.objectContaining({ selector: '.layout-cover', requiredInDom: true }),
          expect.objectContaining({ selector: '.progress-bar', requiredInDom: true }),
        ]),
        dom: expect.arrayContaining([
          expect.objectContaining({ className: 'layout-cover', required: true }),
          expect.objectContaining({ className: 'progress-bar', required: true }),
        ]),
      },
      render_profile: {
        version: 1,
        evidenceSha256: createHash('sha256').update(referenceHtml).digest('hex'),
        viewport: contractArguments.viewport,
        phases: {
          cover: { anchors: expect.arrayContaining([expect.objectContaining({ selector: '.progress-bar' })]) },
          content: { anchors: expect.arrayContaining([expect.objectContaining({ selector: '.progress-bar' })]) },
          closing: { anchors: expect.arrayContaining([expect.objectContaining({ selector: '.progress-bar' })]) },
        },
      },
    })
    expect(recordedState.activeReferenceStyleContract?.contract.colors)
      .toEqual(contractArguments.colors)

    const recordCall = {
      id: 'record-reference',
      type: 'function' as const,
      function: { name: 'record_reference_style', arguments: JSON.stringify(contractArguments) },
    }
    await store.update(session.summary.id, (state) => {
      state.messages.push(
        { role: 'assistant', content: null, tool_calls: [recordCall] },
        { role: 'tool', tool_call_id: recordCall.id, tool_result_status: 'succeeded', content: recorded.content },
      )
    })
    const navyCandidate = '<!doctype html><html><head><style>:root{--navy:#081426;--gold:#d4af37}body{background:linear-gradient(135deg,#081426,#123769);font-family:Segoe UI}.card{background:#fff;box-shadow:0 12px 30px #0003}</style><!-- #fdfae7 #1e2bfa Space Grotesk Inter .layout-cover .cover-dots .progress-bar .nav-controls --></head><body><main class="card">Corporate deck</main></body></html>'
    await writeFile(resolve(store.workspaceDir(session.summary.id), 'ai-week.html'), navyCandidate, 'utf8')
    const mismatch = await tools.execute({
      id: 'verify-reference', name: 'verify_reference_style', arguments: { path: 'ai-week.html' },
    }, context)
    expect(mismatch.isError).toBe(false)
    expect(JSON.parse(mismatch.content)).toMatchObject({
      status: 'success', path: 'ai-week.html', fidelity: 'mismatch', score: 0,
      missing: {
        colors: contractArguments.colors,
        fonts: contractArguments.fonts,
        markers: contractArguments.required_markers,
      },
      violations: { source: expect.arrayContaining([expect.stringMatching(/layout-cover|progress-bar/iu)]) },
    })

    const geometryDrift = referenceHtml.replace('.progress-bar{height:3px;position:fixed', '.progress-bar{height:12px;position:fixed')
    await writeFile(resolve(store.workspaceDir(session.summary.id), 'ai-week.html'), geometryDrift, 'utf8')
    const geometryMismatch = await tools.execute({
      id: 'verify-reference-geometry', name: 'verify_reference_style', arguments: { path: 'ai-week.html' },
    }, context)
    expect(geometryMismatch.isError).toBe(false)
    expect(JSON.parse(geometryMismatch.content)).toMatchObject({
      fidelity: 'mismatch',
      violations: { source: expect.arrayContaining([expect.stringMatching(/progress-bar height.*3px.*12px/iu)]) },
    })

    await writeFile(resolve(store.workspaceDir(session.summary.id), 'ai-week.html'), referenceHtml, 'utf8')
    const exactMatch = await tools.execute({
      id: 'verify-reference-exact', name: 'verify_reference_style', arguments: { path: 'ai-week.html' },
    }, context)
    expect(exactMatch.isError).toBe(false)
    expect(JSON.parse(exactMatch.content)).toMatchObject({
      fidelity: 'pass', score: 100, violations: { source: [] },
      reference_font_manifest_sha256: (recordedPayload.font_evidence as { manifestSha256: string }).manifestSha256,
    })
    await store.update(session.summary.id, (state) => {
      if (!state.activeReferenceStyleContract) throw new Error('reference fixture missing')
      delete state.activeReferenceStyleContract.fontEvidence
    })
    const missingFontEvidence = await tools.execute({
      id: 'verify-reference-missing-font', name: 'verify_reference_style', arguments: { path: 'ai-week.html' },
    }, context)
    expect(missingFontEvidence.isError).toBe(true)
    expect(missingFontEvidence.content).toMatch(/requires durable font evidence/iu)
    await referenceBrowser.closeEverything()
  })

  it('atomically records exact font and three-phase visual evidence without exposing materialized font bytes', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-reference-bundle-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const referenceUrl = 'https://example.com/reference.html'
    const cssUrl = 'https://fonts.googleapis.com/css2?family=Inter&display=swap'
    const fontUrl = 'https://fonts.gstatic.com/s/inter/v1/inter.woff2'
    const referenceHtml = `<!doctype html><html><head><title>Reference demo</title>
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link rel="stylesheet" href="${cssUrl.replaceAll('&', '&amp;')}">
      <style>
        :root{--bg:#fdfae7;--primary:#1e2bfa}
        body{margin:0;background:var(--bg);color:var(--primary);font-family:'Inter',sans-serif}
        .slide{position:absolute;inset:0}.layout-cover{display:flex}.layout-content{display:grid}
        .layout-closing{display:flex}.progress-bar{position:fixed;bottom:0;height:3px;background:var(--primary)}
      </style></head><body>
      <main><section class="slide layout-cover">Cover</section>
      <section class="slide layout-content">Content</section>
      <section class="slide layout-closing">Closing</section></main>
      <div class="progress-bar"></div></body></html>`
    const fetchCall = {
      id: 'reference-bundle-fetch',
      type: 'function' as const,
      function: { name: 'web_fetch', arguments: JSON.stringify({ url: referenceUrl, format: 'html' }) },
    }
    await store.update(session.summary.id, (state) => {
      state.messages = [
        { role: 'user', content: 'Use the exact reference style.' },
        { role: 'assistant', content: null, tool_calls: [fetchCall] },
        {
          role: 'tool', tool_call_id: fetchCall.id, tool_result_status: 'succeeded',
          content: JSON.stringify({ status: 'success', url: referenceUrl, content: referenceHtml }),
        },
      ]
    })

    const fontBytes = Buffer.from('wOF2-inter-fixture', 'ascii')
    const fontCss = `@font-face{font-family:'Inter';font-style:normal;font-weight:400;src:url(${fontUrl}) format('woff2')}`
    let rejectFontFetch = false
    const responseAt = (url: string, body: BodyInit, contentType: string, status = 200): Response => {
      const response = new Response(body, { status, headers: { 'content-type': contentType } })
      Object.defineProperty(response, 'url', { configurable: true, value: url })
      return response
    }
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input)
      if (url === cssUrl) {
        return rejectFontFetch
          ? responseAt(url, 'unavailable', 'text/css', 503)
          : responseAt(url, fontCss, 'text/css')
      }
      if (url === fontUrl) return responseAt(url, fontBytes, 'font/woff2')
      throw new Error(`Unexpected exact-font fetch ${url}`)
    }) as unknown as typeof fetch

    const viewport = { width: 1000, height: 600 }
    const evidenceSha256 = createHash('sha256').update(referenceHtml).digest('hex')
    const chrome = {
      selector: '.progress-bar', count: 1, geometry: 'strict' as const,
      rects: [{ x: 0, y: 0.995, width: 1, height: 0.005 }],
      styles: [{ display: 'block', position: 'fixed', opacity: '1', height: '3px' }],
      occlusion: [1],
    }
    const structural = (selector: string) => ({
      selector, count: 1, geometry: 'strict' as const,
      rects: [{ x: 0, y: 0, width: 1, height: 1 }],
      styles: [{ display: 'flex', position: 'absolute', opacity: '1' }],
      occlusion: [1],
    })
    const renderProfile = {
      version: 1 as const,
      evidenceSha256,
      viewport,
      phases: {
        cover: { anchors: [structural('.layout-cover'), chrome], overlayProbes: [], textLayout: { version: 2 as const, complete: true, collisions: [] } },
        content: { anchors: [structural('.layout-content'), chrome], overlayProbes: [], textLayout: { version: 2 as const, complete: true, collisions: [] } },
        closing: { anchors: [structural('.layout-closing'), chrome], overlayProbes: [], textLayout: { version: 2 as const, complete: true, collisions: [] } },
      },
    }
    const screenshots = {
      cover: dimensionedPng(viewport.width, viewport.height, 11),
      content: dimensionedPng(viewport.width, viewport.height, 12),
      closing: dimensionedPng(viewport.width, viewport.height, 13),
    }
    const browser = new BrowserManager()
    const capture = vi.spyOn(browser, 'captureReferenceRenderBundle').mockResolvedValue({
      profile: renderProfile,
      screenshots,
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      browser,
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn-reference-bundle',
      stepId: 'step-reference-bundle',
      signal: new AbortController().signal,
    }
    const contractArguments = {
      source_url: referenceUrl,
      strictness: 'exact',
      colors: ['#fdfae7', '#1e2bfa'],
      fonts: ['Inter'],
      layout: ['full viewport slide canvas', 'three distinct cover/content/closing layouts'],
      components: ['persistent progress bar', 'structured slide layouts'],
      required_markers: ['.layout-cover', '.progress-bar'],
      signature: 'Cream and cobalt exact reference.',
      avoid: ['unapproved fonts'],
      viewport,
    }

    const recorded = await tools.execute({
      id: 'record-reference-bundle', name: 'record_reference_style', arguments: contractArguments,
    }, context)
    expect(recorded.isError, recorded.content).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenCalledTimes(1)
    const [renderedHtml, , renderedEvidenceSha256, renderedViewport, renderedOptions] = capture.mock.calls[0]
    expect(renderedHtml).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/iu)
    expect(renderedHtml).toContain(`data:font/woff2;base64,${fontBytes.toString('base64')}`)
    expect(renderedEvidenceSha256).toBe(evidenceSha256)
    expect(renderedViewport).toEqual(viewport)
    expect(renderedOptions).toMatchObject({
      signal: context.signal,
      expectedFontFamilies: ['Inter'],
      fontCss: expect.stringContaining(`data:font/woff2;base64,${fontBytes.toString('base64')}`),
    })

    const payload = JSON.parse(recorded.content) as Record<string, unknown>
    expect(payload).toMatchObject({
      status: 'success',
      composition_template: {
        version: 3, sourceSha256: evidenceSha256, dependencies: [],
        variants: [
          { id: 'v1', slots: [{ id: 't1', sample: 'Cover' }] },
          { id: 'v2', slots: [{ id: 't1', sample: 'Content' }] },
          { id: 'v3', slots: [{ id: 't1', sample: 'Closing' }] },
        ],
      },
      visual_evidence: {
        sourceEvidenceSha256: evidenceSha256,
        renderProfileSha256: createHash('sha256').update(JSON.stringify(renderProfile)).digest('hex'),
        viewport,
      },
      font_evidence: {
        sourceEvidenceSha256: evidenceSha256,
        familyNames: ['Inter'],
        materializationManifest: { familyNames: ['Inter'], fonts: [{ bytes: fontBytes.length }] },
      },
    })
    expect(recorded.content).not.toContain('data:font/woff2')
    const durable = (await store.get(session.summary.id)).activeReferenceStyleContract
    expect(durable).toMatchObject({
      provenance: { evidenceSha256 },
      renderProfile,
      visualEvidence: payload.visual_evidence,
      fontEvidence: payload.font_evidence,
      templateCatalog: payload.composition_template,
    })
    expect(await store.resolveReferenceFontEvidence(session.summary.id, durable!.fontEvidence!)).toMatchObject({
      familyNames: ['Inter'],
      fontCss: expect.stringContaining(`data:font/woff2;base64,${fontBytes.toString('base64')}`),
    })
    for (const phase of ['cover', 'content', 'closing'] as const) {
      const path = await store.resolveReferenceVisualEvidencePath(session.summary.id, durable!.visualEvidence!, phase)
      expect(await readFile(path)).toEqual(screenshots[phase])
    }

    const priorDurable = structuredClone(durable)
    rejectFontFetch = true
    const failed = await tools.execute({
      id: 'record-reference-bundle-font-failure', name: 'record_reference_style', arguments: contractArguments,
    }, context)
    expect(failed.isError).toBe(true)
    expect(JSON.parse(failed.content)).toMatchObject({
      status: 'error', message: expect.stringMatching(/font materialization.*HTTP 503/iu),
    })
    expect(capture).toHaveBeenCalledTimes(1)
    expect((await store.get(session.summary.id)).activeReferenceStyleContract).toEqual(priorDurable)

    rejectFontFetch = false
    capture.mockRejectedValueOnce(new Error('trusted family failed to load'))
    const renderFailed = await tools.execute({
      id: 'record-reference-bundle-render-failure', name: 'record_reference_style', arguments: contractArguments,
    }, context)
    expect(renderFailed.isError).toBe(true)
    expect(JSON.parse(renderFailed.content)).toMatchObject({
      status: 'error', message: expect.stringMatching(/browser-rendered bundle.*trusted family failed to load/iu),
    })
    expect((await store.get(session.summary.id)).activeReferenceStyleContract).toEqual(priorDurable)

    const fontCommit = vi.spyOn(store, 'commitReferenceFontEvidence')
      .mockRejectedValueOnce(new Error('private font publication failed'))
    const commitFailed = await tools.execute({
      id: 'record-reference-bundle-commit-failure', name: 'record_reference_style', arguments: contractArguments,
    }, context)
    expect(commitFailed.isError).toBe(true)
    expect(JSON.parse(commitFailed.content)).toMatchObject({
      status: 'error', message: expect.stringMatching(/evidence could not be committed.*private font publication failed/iu),
    })
    expect(fontCommit).toHaveBeenCalledOnce()
    expect((await store.get(session.summary.id)).activeReferenceStyleContract).toEqual(priorDurable)

    // Persisted v1/v2 catalogs must leave the composer lane, even after the
    // provider checkpoint has discarded the original reference body.
    for (const version of [1, 2] as const) {
      const upgradedPath = `upgraded-v${version}.html`
      const legacy = { ...priorDurable!, templateCatalog: { ...priorDurable!.templateCatalog!, version } }
      await store.append(session.summary.id, 'tool.completed', {
        call: { id: fetchCall.id, name: 'web_fetch', arguments: { url: referenceUrl, format: 'html' } },
        result: JSON.stringify({ status: 'success', url: referenceUrl, content: referenceHtml }),
      }, { turnId: context.turnId, callId: fetchCall.id })
      await store.update(session.summary.id, (state) => {
        state.messages = [{ role: 'assistant', content: 'Legacy checkpoint; source bytes are only in the journal.' }]
        state.activeReferenceStyleContract = legacy
      })
      const legacyGap = visualWebArtifactCompletionGap([], {
        forceTask: true, requiresResearch: false, referenceContract: legacy,
        referenceRequest: { urls: [referenceUrl], strictness: 'exact' },
      })!
      expect(legacyGap.missingPhases).toContain('reference_contract')
      expect([...visualWebArtifactRequiredToolNames(legacyGap)!]).toEqual(['record_reference_style'])
      const composeCall = { id: 'legacy-compose', name: 'compose_reference_html', arguments: {
        path: upgradedPath, source_sha256: evidenceSha256, title: 'Upgraded fixture',
        slides: legacy.templateCatalog.variants.map((variant) => ({ variant: variant.id, label: variant.id,
          texts: Object.fromEntries(variant.slots.map((slot) => [slot.id, `Task ${slot.sample}`])) })),
      } }
      const staleCompose = await tools.execute(composeCall, context)
      expect(staleCompose.isError).toBe(true)
      expect(staleCompose.content).toMatch(new RegExp(`catalog v${version} is stale[\\s\\S]*record_reference_style`))
      await expect(readFile(resolve(store.workspaceDir(session.summary.id), upgradedPath))).rejects.toMatchObject({ code: 'ENOENT' })
      const upgrade = await tools.execute({ id: 'upgrade-reference', name: 'record_reference_style', arguments: contractArguments }, context)
      expect(upgrade.isError, upgrade.content).toBe(false)
      const upgraded = (await store.get(session.summary.id)).activeReferenceStyleContract!
      expect(upgraded.templateCatalog?.version).toBe(3)
      expect(upgraded.provenance).toEqual(legacy.provenance)
      const upgradedGap = visualWebArtifactCompletionGap([], {
        forceTask: true, requiresResearch: false, referenceContract: upgraded,
        referenceRequest: { urls: [referenceUrl], strictness: 'exact' },
      })!
      expect(upgradedGap.missingPhases).not.toContain('reference_contract')
      expect([...visualWebArtifactRequiredToolNames(upgradedGap)!]).toEqual(['compose_reference_html'])
      const composed = await tools.execute({ ...composeCall, id: 'upgraded-compose' }, context)
      expect(composed.isError, composed.content).toBe(false)
      expect(await readFile(resolve(store.workspaceDir(session.summary.id), upgradedPath), 'utf8')).toContain('Task Content')
    }

    // Text-layout upgrades must also work after compaction when the current
    // catalog is already up to date. Only hash-bound journal bytes qualify.
    const legacyTextReference = structuredClone(priorDurable!)
    for (const phase of Object.values(legacyTextReference.renderProfile!.phases)) delete phase.textLayout
    await store.update(session.summary.id, (state) => {
      state.messages = [{ role: 'assistant', content: 'Only the journal retains the exact source.' }]
      state.activeReferenceStyleContract = legacyTextReference
    })
    const textUpgrade = await tools.execute({
      id: 'upgrade-reference-text-layout', name: 'record_reference_style', arguments: contractArguments,
    }, context)
    expect(textUpgrade.isError, textUpgrade.content).toBe(false)
    const textUpgraded = (await store.get(session.summary.id)).activeReferenceStyleContract!
    expect(textUpgraded.provenance).toEqual(legacyTextReference.provenance)
    expect(textUpgraded.renderProfile?.phases.cover.textLayout).toEqual({ version: 2, complete: true, collisions: [] })
  })

  it('maps a constrained Pexels image search to the exact Arena fetch_media result', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input))
      expect(url.origin + url.pathname).toBe('https://api.pexels.com/v1/search')
      expect(Object.fromEntries(url.searchParams)).toEqual({
        query: 'misty forest',
        per_page: '2',
        orientation: 'landscape',
        size: 'large',
        locale: 'en-US',
      })
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
      expect(init?.headers).toMatchObject({ authorization: 'test-pexels-key', accept: 'application/json' })
      return Response.json({
        total_results: 41,
        photos: [{
          id: 101,
          width: 2400,
          height: 1600,
          url: 'https://www.pexels.com/photo/101/',
          photographer: 'Ada Camera',
          photographer_url: 'https://www.pexels.com/@ada-camera',
          alt: 'Misty forest at sunrise',
          src: {
            original: 'https://images.pexels.com/photos/101/original.jpeg',
            large2x: 'https://images.pexels.com/photos/101/large2x.jpeg',
            medium: 'https://images.pexels.com/photos/101/medium.jpeg',
          },
        }],
      })
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, pexelsApiKey: 'test-pexels-key' },
    )
    const result = await tools.execute({
      id: 'call_media_image',
      name: 'fetch_media',
      arguments: {
        query: 'misty forest',
        media_type: 'image',
        count: 2,
        orientation: 'landscape',
        size: 'large',
        locale: 'en-US',
      },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      query: 'misty forest',
      mediaType: 'image',
      totalResults: 41,
      results: [{
        type: 'image',
        id: 101,
        pexelsUrl: 'https://www.pexels.com/photo/101/',
        recommendedUrl: 'https://images.pexels.com/photos/101/large2x.jpeg',
        thumbnailUrl: 'https://images.pexels.com/photos/101/medium.jpeg',
        width: 2400,
        height: 1600,
        creatorName: 'Ada Camera',
        creatorUrl: 'https://www.pexels.com/@ada-camera',
        alt: 'Misty forest at sunrise',
      }],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('applies fetch_media defaults and interleaves Pexels image/video results', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input))
      expect(url.searchParams.get('per_page')).toBe('3')
      expect(url.searchParams.has('orientation')).toBe(false)
      expect(url.searchParams.has('size')).toBe(false)
      if (url.pathname === '/v1/search') {
        return Response.json({
          total_results: 12,
          photos: [
            { id: 1, url: 'https://pexels.test/photo/1', src: { large: 'https://img.test/1.jpg' } },
            { id: 2, url: 'https://pexels.test/photo/2', src: { original: 'https://img.test/2.jpg' } },
          ],
        })
      }
      return Response.json({
        total_results: 8,
        videos: [{
          id: 3,
          url: 'https://pexels.test/video/3',
          width: 3840,
          height: 2160,
          duration: 9,
          image: 'https://img.test/video-3.jpg',
          user: { name: 'Video Maker', url: 'https://pexels.test/@video-maker' },
          video_files: [
            { link: 'https://video.test/4k.mp4', width: 3840, height: 2160, quality: 'uhd', file_type: 'video/mp4' },
            { link: 'https://video.test/hd.mp4', width: 1920, height: 1080, quality: 'hd', file_type: 'video/mp4' },
          ],
        }],
      })
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, pexelsApiKey: 'test-pexels-key' },
    )
    const result = await tools.execute({
      id: 'call_media_both',
      name: 'fetch_media',
      arguments: { query: 'city lights' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      query: 'city lights',
      mediaType: 'both',
      totalResults: 20,
      results: [
        {
          type: 'image', id: 1, pexelsUrl: 'https://pexels.test/photo/1', recommendedUrl: 'https://img.test/1.jpg',
        },
        {
          type: 'video',
          id: 3,
          pexelsUrl: 'https://pexels.test/video/3',
          recommendedUrl: 'https://video.test/hd.mp4',
          thumbnailUrl: 'https://img.test/video-3.jpg',
          width: 3840,
          height: 2160,
          creatorName: 'Video Maker',
          creatorUrl: 'https://pexels.test/@video-maker',
          duration: 9,
          videoFile: {
            url: 'https://video.test/hd.mp4', width: 1920, height: 1080, quality: 'hd', fileType: 'video/mp4',
          },
        },
        {
          type: 'image', id: 2, pexelsUrl: 'https://pexels.test/photo/2', recommendedUrl: 'https://img.test/2.jpg',
        },
      ],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps fetch_media count=1 valid in both mode without issuing a zero-result video request', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input))
      expect(url.pathname).toBe('/v1/search')
      expect(url.searchParams.get('per_page')).toBe('1')
      return Response.json({ photos: [{ id: 7, url: 'https://pexels.test/photo/7', src: { large: 'https://img.test/7.jpg' } }] })
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, pexelsApiKey: 'test-pexels-key' },
    )
    const result = await tools.execute({
      id: 'call_media_one',
      name: 'fetch_media',
      arguments: { query: 'single image', media_type: 'both', count: 1 },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content)).toEqual({
      status: 'success',
      query: 'single image',
      mediaType: 'both',
      totalResults: 1,
      results: [{ type: 'image', id: 7, pexelsUrl: 'https://pexels.test/photo/7', recommendedUrl: 'https://img.test/7.jpg' }],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('returns an Arena-shaped fetch_media error without calling Pexels when no key is configured', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: fetchMock as typeof fetch, pexelsApiKey: '' },
    )
    const result = await tools.execute({
      id: 'call_media_unconfigured',
      name: 'fetch_media',
      arguments: { query: 'forest' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content)).toEqual({
      status: 'error',
      message: 'fetch_media requires PEXELS_API_KEY to be configured',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('generates a base64 PNG through the exact Arena generate_image protocol and publishes an Artifact', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('https://images.example/v1/images/generations')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-image-key', 'content-type': 'application/json' })
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'test-image-model',
        prompt: 'A geometric sunrise over quiet mountains',
        n: 1,
        size: 'auto',
        quality: 'auto',
        output_format: 'png',
      })
      return Response.json({
        data: [{ b64_json: png.toString('base64') }],
        usage: { input_tokens: 18, output_tokens: 272, total_tokens: 290 },
      })
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        imageApiKey: 'test-image-key',
        imageBaseUrl: 'https://images.example/v1/',
        imageModel: 'test-image-model',
      },
    )
    const result = await tools.execute({
      id: 'call_generate_png',
      name: 'generate_image',
      arguments: { file_path: 'assets/generated-hero.png', prompt: 'A geometric sunrise over quiet mountains' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ isError: false, modelRequestCount: 1, modelCallCount: 1 })
    expect(result.modelUsage).toEqual({
      promptTokens: 18,
      completionTokens: 272,
      totalTokens: 290,
      cachedPromptTokens: 0,
    })
    expect(JSON.parse(result.content)).toEqual({
      status: 'success', hash: expect.any(String), file_path: 'assets/generated-hero.png',
    })
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'assets/generated-hero.png'))).resolves.toEqual(png)
    expect((await store.get(session.summary.id)).artifacts).toEqual([
      expect.objectContaining({ path: 'assets/generated-hero.png', kind: 'image', mime: 'image/png' }),
    ])
    expect((await store.events(session.summary.id)).map((event) => event.type)).toEqual(expect.arrayContaining(['file.changed', 'artifact.created']))
  })

  it('preserves physical image request counts across HTTP, transport, and missing-usage responses', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-image-physical-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const png = syntheticPng(30)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { message: 'provider unavailable' } }, { status: 503 }))
      .mockRejectedValueOnce(new Error('image transport reset'))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: png.toString('base64') }] }))
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        imageApiKey: 'test-image-key',
        imageBaseUrl: 'https://images.example/v1',
        imageModel: 'test-image-model',
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_image_physical',
      stepId: 'step_image_physical',
      signal: new AbortController().signal,
    }
    const execute = async (id: string, filePath: string) => await tools.execute({
      id,
      name: 'generate_image',
      arguments: { file_path: filePath, prompt: 'One standalone image' },
    }, context)

    const httpFailure = await execute('call_image_http_failure', 'images/http.png')
    const transportFailure = await execute('call_image_transport_failure', 'images/transport.png')
    const missingUsageSuccess = await execute('call_image_missing_usage', 'images/no-usage.png')

    for (const result of [httpFailure, transportFailure, missingUsageSuccess]) {
      expect(result).toMatchObject({ modelRequestCount: 1, modelCallCount: 0 })
      expect(result.modelUsage).toBeUndefined()
    }
    expect(httpFailure.isError).toBe(true)
    expect(transportFailure.isError).toBe(true)
    expect(missingUsageSuccess.isError).toBe(false)
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'images/no-usage.png'))).resolves.toEqual(png)
  })

  it('runs an offer_options battle, aggregates usage, saves the selected image, and retains only the unselected candidate', async () => {
    const first = syntheticPng(1)
    const second = syntheticPng(2)
    const fixture = await imageBattleFixture({
      generated: [
        { bytes: first, input: 10, output: 20 },
        { bytes: second, input: 11, output: 21 },
      ],
      humanResponse: { selected_index: 1 },
    })
    const result = await fixture.execute()
    expect(result).toMatchObject({
      isError: false,
      modelRequestCount: 2,
      modelCallCount: 2,
      modelUsage: { promptTokens: 21, completionTokens: 41, totalTokens: 62, cachedPromptTokens: 0 },
    })
    expect(fixture.requestedModels).toEqual(fixture.imageBattleModels)
    expect(new Set(fixture.requestedModels).size).toBe(2)
    expect(JSON.parse(result.content)).toEqual({
      status: 'completed',
      candidates: [{ index: 0, hash: expect.any(String) }, { index: 1, hash: expect.any(String) }],
      selected_index: 1,
      file_path: 'images/hero.png',
      selection_method: 'user',
    })
    expect(fixture.requestHumanInput).toHaveBeenCalledOnce()
    expect(fixture.requestHumanInput.mock.calls[0][1]).toMatchObject({
      kind: 'generate_image',
      title: 'Choose an image',
      payload: {
        file_path: 'images/hero.png',
        prompt: 'One standalone geometric landscape',
        candidates: [
          { id: 'call_options_select-0', index: 0, hash: expect.any(String), path: 'Unselected files/hero-select-1.png' },
          { id: 'call_options_select-1', index: 1, hash: expect.any(String), path: 'Unselected files/hero-select-2.png' },
        ],
      },
    })
    const workspace = fixture.store.workspaceDir(fixture.session.summary.id)
    await expect(readFile(resolve(workspace, 'images/hero.png'))).resolves.toEqual(second)
    await expect(readFile(resolve(workspace, 'Unselected files/hero-select-1.png'))).resolves.toEqual(first)
    await expect(readFile(resolve(workspace, 'Unselected files/hero-select-2.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fixture.store.get(fixture.session.summary.id)).artifacts.map((artifact) => artifact.path)).toEqual(expect.arrayContaining([
      'images/hero.png',
      'Unselected files/hero-select-1.png',
    ]))
  })

  it('preserves both offer_options candidates and writes no final image when the user skips', async () => {
    const first = syntheticPng(3)
    const second = syntheticPng(4)
    const fixture = await imageBattleFixture({
      generated: [
        { bytes: first, input: 5, output: 15 },
        { bytes: second, input: 6, output: 16 },
      ],
      humanResponse: { selected_index: 0, skipped: true },
    })
    const result = await fixture.execute('call_options_skip')
    expect(result.modelUsage).toEqual({ promptTokens: 11, completionTokens: 31, totalTokens: 42, cachedPromptTokens: 0 })
    expect(result).toMatchObject({ modelRequestCount: 2, modelCallCount: 2 })
    expect(JSON.parse(result.content)).toMatchObject({
      status: 'completed', selected_index: 0, file_path: 'images/hero.png', selection_method: 'skip',
    })
    const workspace = fixture.store.workspaceDir(fixture.session.summary.id)
    await expect(readFile(resolve(workspace, 'images/hero.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(resolve(workspace, 'Unselected files/hero-s_skip-1.png'))).resolves.toEqual(first)
    await expect(readFile(resolve(workspace, 'Unselected files/hero-s_skip-2.png'))).resolves.toEqual(second)
  })

  it('auto-succeeds with one offer_options survivor and still accounts for the failed model usage', async () => {
    const survivor = syntheticPng(5)
    const fixture = await imageBattleFixture({
      generated: [
        { bytes: survivor, input: 7, output: 17 },
        { bytes: Buffer.from('invalid image'), input: 8, output: 18 },
      ],
    })
    const result = await fixture.execute('call_options_single')
    expect(result).toMatchObject({
      isError: false,
      modelRequestCount: 2,
      modelCallCount: 2,
      modelUsage: { promptTokens: 15, completionTokens: 35, totalTokens: 50, cachedPromptTokens: 0 },
    })
    expect(JSON.parse(result.content)).toEqual({ status: 'success', hash: expect.any(String), file_path: 'images/hero.png' })
    expect(fixture.requestHumanInput).not.toHaveBeenCalled()
    const workspace = fixture.store.workspaceDir(fixture.session.summary.id)
    await expect(readFile(resolve(workspace, 'images/hero.png'))).resolves.toEqual(survivor)
    await expect(readFile(resolve(workspace, 'Unselected files/hero-single-1.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns the public all-model failure union with aggregate offer_options usage and no HITL pause', async () => {
    const fixture = await imageBattleFixture({
      generated: [
        { bytes: Buffer.from('invalid one'), input: 3, output: 13 },
        { bytes: Buffer.from('invalid two'), input: 4, output: 14 },
      ],
    })
    const result = await fixture.execute('call_options_failed')
    expect(result).toMatchObject({
      isError: true,
      modelRequestCount: 2,
      modelCallCount: 2,
      modelUsage: { promptTokens: 7, completionTokens: 27, totalTokens: 34, cachedPromptTokens: 0 },
    })
    expect(JSON.parse(result.content)).toEqual({
      status: 'error',
      message: 'Image generation failed for every model in the battle. Try again or rephrase the prompt.',
    })
    expect(fixture.requestHumanInput).not.toHaveBeenCalled()
    await expect(readFile(resolve(fixture.store.workspaceDir(fixture.session.summary.id), 'images/hero.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('counts every offer_options request while limiting authoritative calls to candidates with provider usage', async () => {
    const partial = await imageBattleFixture({
      generated: [
        { bytes: syntheticPng(31), input: 5, output: 15, omitUsage: true },
        { bytes: syntheticPng(32), input: 6, output: 16 },
      ],
      humanResponse: { selected_index: 1 },
    })
    const partialResult = await partial.execute('call_options_partial_usage')
    expect(partialResult).toMatchObject({
      isError: false,
      modelRequestCount: 2,
      modelCallCount: 1,
      modelUsage: { promptTokens: 6, completionTokens: 16, totalTokens: 22, cachedPromptTokens: 0 },
    })

    const unknown = await imageBattleFixture({
      generated: [
        { bytes: syntheticPng(33), input: 7, output: 17, omitUsage: true },
        { bytes: syntheticPng(34), input: 8, output: 18, omitUsage: true },
      ],
      humanResponse: { selected_index: 0 },
    })
    const unknownResult = await unknown.execute('call_options_unknown_usage')
    expect(unknownResult).toMatchObject({
      isError: false,
      modelRequestCount: 2,
      modelCallCount: 0,
    })
    expect(unknownResult.modelUsage).toBeUndefined()
  })

  it('fails offer_options before provider access unless two distinct image models are configured', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-image-battle-routes-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const fetchMock = vi.fn()
    const requestHumanInput = vi.fn()
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        imageApiKey: 'test-image-key',
        imageBaseUrl: 'https://images.example/v1',
        imageModel: 'only-image-model',
        imageBattleModels: ['only-image-model', 'only-image-model'],
        requestHumanInput,
      },
    )
    const result = await tools.execute({
      id: 'call_options_unconfigured',
      name: 'generate_image',
      arguments: { file_path: 'images/hero.png', prompt: 'One standalone landscape', offer_options: true },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_options_unconfigured',
      stepId: 'step_options_unconfigured',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content)).toEqual({
      status: 'error',
      message: 'offer_options requires two distinct image model routes; configure ANERA_IMAGE_BATTLE_MODELS with an additional model',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(requestHumanInput).not.toHaveBeenCalled()
  })

  it('enforces three durable offer_options reservations per turn across executor restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-image-battle-limit-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    let generation = 0
    const requestedModels: string[] = []
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestedModels.push(String((JSON.parse(String(init?.body)) as { model?: string }).model || ''))
      generation += 1
      return Response.json({ data: [{ b64_json: syntheticPng(generation).toString('base64') }] })
    })
    const requestHumanInput = vi.fn(async () => ({ selected_index: 0, skipped: true }))
    const dependencies = {
      fetch: fetchMock as typeof fetch,
      imageApiKey: 'test-image-key',
      imageBaseUrl: 'https://images.example/v1',
      imageModel: 'battle-model-a',
      imageBattleModels: ['battle-model-a', 'battle-model-b'],
      requestHumanInput,
    }
    const execute = async (tools: ToolExecutor, callId: string, turnId: string) => await tools.execute({
      id: callId,
      name: 'generate_image',
      arguments: { file_path: `images/${callId}.png`, prompt: `Standalone image ${callId}`, offer_options: true },
    }, {
      sessionId: session.summary.id,
      turnId,
      stepId: `step_${callId}`,
      signal: new AbortController().signal,
    })
    for (let index = 1; index <= 4; index += 1) {
      const callId = `battle_${index}`
      await store.append(session.summary.id, 'tool.started', {
        call: {
          id: callId,
          name: 'generate_image',
          arguments: { file_path: `images/${callId}.png`, prompt: `Standalone image ${callId}`, offer_options: true },
        },
      }, { turnId: 'turn_battle_limit', stepId: `step_${callId}`, callId })
    }
    const first = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      dependencies,
    )
    for (let index = 1; index <= 3; index += 1) {
      expect((await execute(first, `battle_${index}`, 'turn_battle_limit')).isError).toBe(false)
    }

    const restartedStore = new SessionStore(root, 'test-model')
    await restartedStore.initialize()
    const restarted = new ToolExecutor(
      restartedStore,
      persistedProcessManager(restartedStore),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      dependencies,
    )
    const overLimit = await execute(restarted, 'battle_4', 'turn_battle_limit')
    expect(overLimit.isError).toBe(true)
    expect(JSON.parse(overLimit.content).message).toMatch(/at most 3 offer_options image battles/)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(requestHumanInput).toHaveBeenCalledTimes(3)
    expect(requestedModels).toEqual([
      'battle-model-a', 'battle-model-b',
      'battle-model-a', 'battle-model-b',
      'battle-model-a', 'battle-model-b',
    ])
    expect((await restartedStore.events(session.summary.id)).filter((event) => (
      event.type === 'tool.started' && event.turnId === 'turn_battle_limit'
    ))).toHaveLength(4)

    expect((await execute(restarted, 'battle_next_turn', 'turn_battle_limit_next')).isError).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })

  it('sends workspace source images through the active generate_image edit protocol', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-image-edit-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const source = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 1, 1])
    const edited = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2, 2, 2, 2])
    await writeWorkspaceFile(store.workspaceDir(session.summary.id), 'inputs/source.png', source)
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('https://images.example/v1/images/edits')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-image-key' })
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      expect(form.get('model')).toBe('test-image-model')
      expect(form.get('prompt')).toBe('Turn the sky violet while preserving the layout')
      expect(form.get('output_format')).toBe('png')
      const sourceImages = form.getAll('image[]')
      expect(sourceImages).toHaveLength(1)
      expect(sourceImages[0]).toBeInstanceOf(Blob)
      expect((sourceImages[0] as Blob).type).toBe('image/png')
      return Response.json({
        data: [{ b64_json: edited.toString('base64') }],
        usage: { input_tokens: 30, output_tokens: 250, total_tokens: 280 },
      })
    })
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        imageApiKey: 'test-image-key',
        imageBaseUrl: 'https://images.example/v1',
        imageModel: 'test-image-model',
      },
    )
    const result = await tools.execute({
      id: 'call_generate_edit',
      name: 'generate_image',
      arguments: {
        file_path: '/home/user/outputs/edited.png',
        prompt: 'Turn the sky violet while preserving the layout',
        images: ['~/inputs/source.png'],
      },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_generate_edit',
      stepId: 'step_generate_edit',
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({
      isError: false,
      modelUsage: { promptTokens: 30, completionTokens: 250, totalTokens: 280, cachedPromptTokens: 0 },
    })
    expect(JSON.parse(result.content)).toEqual({
      status: 'success', hash: expect.any(String), file_path: 'outputs/edited.png',
    })
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'outputs/edited.png'))).resolves.toEqual(edited)
  })

  it('persists an add_voice choice and generates a playable audio Artifact after executor recreation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-voice-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const auditionRequests: Array<Record<string, unknown>> = []
    let auditionPaths: string[] = []
    const auditionFetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      auditionRequests.push(body)
      return new Response(SPEECH_MP3_FIXTURE, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
    })
    const requestHumanInput = vi.fn(async (_context, request) => {
      expect(request.call.arguments.language).toBe('zh-CN')
      const candidates = request.payload.candidates as Array<{ id: string; path: string }>
      auditionPaths = candidates.map((candidate) => candidate.path)
      expect(auditionPaths).toHaveLength(2)
      await expect(Promise.all(auditionPaths.map((path) => (
        readFile(resolve(store.workspaceDir(session.summary.id), path))
      )))).resolves.toEqual([SPEECH_MP3_FIXTURE, SPEECH_MP3_FIXTURE])
      return { status: 'selected', candidate_id: candidates[0].id }
    })
    const first = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        requestHumanInput,
        fetch: auditionFetch as typeof fetch,
        imageApiKey: 'test-image-key',
        imageBaseUrl: 'https://images.example/v1',
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_voice',
      stepId: 'step_voice',
      signal: new AbortController().signal,
    }
    const selected = await first.execute({
      id: 'call_add_voice',
      name: 'add_voice',
      arguments: { language: 'ZH-cn', text: '这是语音试听文本。', voice_identity: { index: 0 } },
    }, context)
    const selectedPayload = JSON.parse(selected.content) as { voice_id: string; selected_index: number }
    expect(selectedPayload).toMatchObject({
      status: 'completed',
      selected_index: 0,
      voice_id: expect.stringMatching(/^voice-/),
    })
    expect((await store.get(session.summary.id)).voices?.[selectedPayload.voice_id]).toMatchObject({
      providerVoice: 'alloy', language: 'zh-CN',
    })
    expect(auditionRequests.map((request) => request.voice)).toEqual(['alloy', 'verse'])
    expect(auditionRequests.every((request) => request.input === '这是语音试听文本。' && request.response_format === 'mp3')).toBe(true)
    await Promise.all(auditionPaths.map(async (path) => {
      await expect(readFile(resolve(store.workspaceDir(session.summary.id), path))).rejects.toMatchObject({ code: 'ENOENT' })
    }))

    const audio = SPEECH_MP3_FIXTURE
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('https://images.example/v1/audio/speech')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        voice: 'alloy',
        input: '最终播报。',
        response_format: 'mp3',
      })
      return new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    })
    const recreated = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        imageApiKey: 'test-image-key',
        imageBaseUrl: 'https://images.example/v1',
      },
    )
    const generated = await recreated.execute({
      id: 'call_generate_speech',
      name: 'generate_speech',
      arguments: {
        text: '最终播报。',
        voice_id: selectedPayload.voice_id,
        language: 'zh-cn',
        file_path: '/home/user/audio/final.mp3',
      },
    }, context)
    expect(JSON.parse(generated.content)).toEqual({
      status: 'success', hash: expect.any(String), file_path: 'audio/final.mp3',
    })
    expect(generated).toMatchObject({
      modelRequestCount: 1,
      modelCallCount: 1,
      modelUsage: { cachedPromptTokens: 0, totalTokens: expect.any(Number) },
      speechUsage: {
        providerCalls: 1,
        inputCharacters: 5,
        providerOutputBytes: audio.length,
        deliveredAudioBytes: audio.length,
        audioDurationMs: expect.any(Number),
        estimationMethod: 'text_heuristic_and_50ms_audio_tokens',
      },
    })
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'audio/final.mp3'))).resolves.toEqual(audio)
    expect((await store.events(session.summary.id)).find((event) => event.type === 'audio.generated')).toMatchObject({
      callId: 'call_generate_speech',
      data: { path: 'audio/final.mp3', bytes: audio.length, voiceId: selectedPayload.voice_id, language: 'zh-CN' },
    })
    expect((await store.get(session.summary.id)).artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'audio/final.mp3', kind: 'audio' }),
    ]))
  })

  it('records a speech provider request and explicit local estimate when transport usage is unavailable', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-speech-physical-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await store.update(session.summary.id, (state) => {
      state.voices = {
        'voice-physical': {
          providerVoice: 'alloy',
          language: 'en-US',
          createdAt: '2026-08-31T00:00:00.000Z',
          sourceCallId: 'call_voice_physical',
        },
      }
    })
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: vi.fn(async () => { throw new Error('speech transport reset') }) as typeof fetch,
        imageApiKey: 'test-image-key',
        imageBaseUrl: 'https://images.example/v1',
      },
    )
    const result = await tools.execute({
      id: 'call_speech_physical',
      name: 'generate_speech',
      arguments: {
        text: 'Hello world',
        voice_id: 'voice-physical',
        language: 'en-US',
        file_path: 'audio/failed.mp3',
      },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_speech_physical',
      stepId: 'step_speech_physical',
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      isError: true,
      modelRequestCount: 1,
      modelCallCount: 1,
      modelUsage: {
        promptTokens: expect.any(Number),
        completionTokens: 0,
        totalTokens: expect.any(Number),
        cachedPromptTokens: 0,
      },
      speechUsage: {
        providerCalls: 1,
        inputCharacters: 11,
        providerOutputBytes: 0,
        deliveredAudioBytes: 0,
        audioDurationMs: 0,
        estimatedAudioTokens: 0,
        estimationMethod: 'text_heuristic_and_50ms_audio_tokens',
      },
    })
    expect(JSON.parse(result.content)).toMatchObject({ status: 'error', message: 'speech transport reset' })
    expect(result.modelUsage?.promptTokens).toBeGreaterThan(0)
    expect(result.modelUsage?.totalTokens).toBe(result.modelUsage?.promptTokens)
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'audio/failed.mp3'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('normalizes BCP-47 tags and rejects unproven voice-language changes before synthesis', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-voice-language-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await store.update(session.summary.id, (state) => {
      state.voices = {
        'voice-00': {
          providerVoice: 'alloy',
          language: 'en-US',
          createdAt: '2026-08-31T00:00:00.000Z',
          sourceCallId: 'call_voice_language',
        },
      }
    })
    const fetchMock = vi.fn(async () => new Response(SPEECH_MP3_FIXTURE, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }))
    const requestHumanInput = vi.fn()
    const tools = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        imageApiKey: 'test-image-key',
        imageBaseUrl: 'https://images.example/v1',
        requestHumanInput,
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_voice_language',
      stepId: 'step_voice_language',
      signal: new AbortController().signal,
    }
    const incompatible = await tools.execute({
      id: 'call_speech_en_gb',
      name: 'generate_speech',
      arguments: { text: 'Hello.', voice_id: 'voice-00', language: 'en-GB', file_path: 'audio/en-gb.mp3' },
    }, context)
    expect(incompatible.isError).toBe(true)
    expect(JSON.parse(incompatible.content).message).toMatch(/auditioned for en-US.*cannot be proven compatible with en-GB/)
    expect(fetchMock).not.toHaveBeenCalled()

    const invalid = await tools.execute({
      id: 'call_speech_invalid_language',
      name: 'generate_speech',
      arguments: { text: 'Hello.', voice_id: 'voice-00', language: 'en_US', file_path: 'audio/invalid.mp3' },
    }, context)
    expect(invalid.isError).toBe(true)
    expect(JSON.parse(invalid.content).message).toBe('language must be a valid BCP-47 language tag')
    expect(fetchMock).not.toHaveBeenCalled()

    const compatibleBareLanguage = await tools.execute({
      id: 'call_speech_en_generic',
      name: 'generate_speech',
      arguments: { text: 'Hello.', voice_id: 'voice-00', language: 'EN', file_path: 'audio/en.mp3' },
    }, context)
    expect(compatibleBareLanguage.isError).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect((await store.events(session.summary.id)).find((event) => event.type === 'audio.generated')).toMatchObject({
      data: { voiceId: 'voice-00', language: 'en', auditionLanguage: 'en-US' },
    })

    const invalidAudition = await tools.execute({
      id: 'call_add_voice_invalid_language',
      name: 'add_voice',
      arguments: { language: 'not_a_language', text: 'Invalid language audition.' },
    }, context)
    expect(invalidAudition.isError).toBe(true)
    expect(JSON.parse(invalidAudition.content).message).toBe('language must be a valid BCP-47 language tag')
    expect(requestHumanInput).not.toHaveBeenCalled()
  })

  it('enforces ten durable speech generations per turn across executor restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-speech-limit-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    await store.update(session.summary.id, (state) => {
      state.voices = {
        'voice-00': {
          providerVoice: 'alloy',
          language: 'en-US',
          createdAt: '2026-08-31T00:00:00.000Z',
          sourceCallId: 'call_voice_limit',
        },
      }
    })
    const fetchMock = vi.fn(async () => new Response(SPEECH_MP3_FIXTURE, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }))
    const dependencies = {
      fetch: fetchMock as typeof fetch,
      imageApiKey: 'test-image-key',
      imageBaseUrl: 'https://images.example/v1',
    }
    const execute = async (tools: ToolExecutor, callId: string, turnId: string) => await tools.execute({
      id: callId,
      name: 'generate_speech',
      arguments: {
        text: `Clip ${callId}.`,
        voice_id: 'voice-00',
        language: 'en-us',
        file_path: `audio/${callId}.mp3`,
      },
    }, {
      sessionId: session.summary.id,
      turnId,
      stepId: `step_${callId}`,
      signal: new AbortController().signal,
    })
    for (let index = 1; index <= 11; index += 1) {
      const callId = `speech_${index}`
      await store.append(session.summary.id, 'tool.started', {
        call: {
          id: callId,
          name: 'generate_speech',
          arguments: {
            text: `Clip ${callId}.`,
            voice_id: 'voice-00',
            language: 'en-us',
            file_path: `audio/${callId}.mp3`,
          },
        },
      }, { turnId: 'turn_speech_limit', stepId: `step_${callId}`, callId })
    }
    const first = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      dependencies,
    )
    for (let index = 1; index <= 10; index += 1) {
      expect((await execute(first, `speech_${index}`, 'turn_speech_limit')).isError).toBe(false)
    }

    const restartedStore = new SessionStore(root, 'test-model')
    await restartedStore.initialize()
    const restarted = new ToolExecutor(
      restartedStore,
      persistedProcessManager(restartedStore),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      dependencies,
    )
    const overLimit = await execute(restarted, 'speech_11', 'turn_speech_limit')
    expect(overLimit.isError).toBe(true)
    expect(JSON.parse(overLimit.content).message).toMatch(/at most 10 speech generations/)
    expect(fetchMock).toHaveBeenCalledTimes(10)
    expect((await restartedStore.events(session.summary.id)).filter((event) => (
      event.type === 'tool.started'
      && event.turnId === 'turn_speech_limit'
      && (event.data.call as { name?: string } | undefined)?.name === 'generate_speech'
    ))).toHaveLength(11)

    expect((await execute(restarted, 'speech_next_turn', 'turn_speech_limit_next')).isError).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(11)
  })

  it('fails closed when a different add_voice call reuses an id even with the same provider and language', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-voice-id-conflict-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const requestHumanInput = vi.fn(async (_context, request) => {
      const candidates = request.payload.candidates as Array<{ id: string }>
      return { candidate_id: candidates[0].id, voice_id: 'voice-00' }
    })
    const executor = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { requestHumanInput, imageApiKey: '' },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_voice_conflict',
      stepId: 'step_voice_conflict',
      signal: new AbortController().signal,
    }

    const first = await executor.execute({
      id: 'call_voice_conflict_en',
      name: 'add_voice',
      arguments: { language: 'en-US', text: 'First voice', voice_identity: { index: 0 } },
    }, context)
    expect(first.isError).toBe(false)
    expect(JSON.parse(first.content)).toMatchObject({ voice_id: 'voice-00', selected_index: 0 })

    const conflicting = await executor.execute({
      id: 'call_voice_conflict_reused',
      name: 'add_voice',
      arguments: { language: 'en-US', text: 'A second call for the same provider', voice_identity: { index: 0 } },
    }, context)
    expect(conflicting.isError).toBe(true)
    expect(JSON.parse(conflicting.content)).toMatchObject({
      status: 'error',
      message: 'Voice voice-00 was already assigned to a different add_voice call',
    })
    expect((await store.get(session.summary.id)).voices).toEqual({
      'voice-00': expect.objectContaining({
        providerVoice: 'alloy', language: 'en-US', sourceCallId: 'call_voice_conflict_en',
      }),
    })
  })

  it('preserves add_voice audition files when a durable human-input wait pauses for restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-voice-restart-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    let auditionPaths: string[] = []
    const requestHumanInput = vi.fn(async (_context, request) => {
      auditionPaths = (request.payload.candidates as Array<{ path: string }>).map((candidate) => candidate.path)
      const pause = Object.assign(new Error('service restart'), { preserveHitlFiles: true })
      throw pause
    })
    const executor = new ToolExecutor(
      store,
      persistedProcessManager(store),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        requestHumanInput,
        fetch: vi.fn(async () => new Response(SPEECH_MP3_FIXTURE, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })) as typeof fetch,
        imageApiKey: 'test-image-key',
        imageBaseUrl: 'https://images.example/v1',
      },
    )

    const result = await executor.execute({
      id: 'call_voice_restart_2',
      name: 'add_voice',
      arguments: { language: 'en-US', text: 'Restart-safe audition.' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_voice_restart',
      stepId: 'step_voice_restart',
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ isError: true })
    expect(auditionPaths).toHaveLength(2)
    expect(auditionPaths.every((path) => path.includes('_'))).toBe(true)
    await expect(Promise.all(auditionPaths.map((path) => (
      readFile(resolve(store.workspaceDir(session.summary.id), path))
    )))).resolves.toEqual([SPEECH_MP3_FIXTURE, SPEECH_MP3_FIXTURE])
  })

  it('downloads URL-based generated JPEGs with redirect revalidation and without forwarding provider authorization', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const validated: string[] = []
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/images/generations')) return Response.json({ data: [{ url: 'https://download.example/start' }] })
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined()
      if (url === 'https://download.example/start') return new Response('', { status: 302, headers: { location: 'https://cdn.example/final.jpg' } })
      if (url === 'https://cdn.example/final.jpg') return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
      throw new Error(`Unexpected URL ${url}`)
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: fetchMock as typeof fetch,
        validatePublicUrl: async (raw) => {
          validated.push(raw)
          return new URL(raw)
        },
        imageApiKey: 'test-image-key',
        imageBaseUrl: 'https://images.example/v1',
        imageModel: 'test-image-model',
      },
    )
    const result = await tools.execute({
      id: 'call_generate_jpeg',
      name: 'generate_image',
      arguments: { file_path: 'generated.jpg', prompt: 'A documentary photograph of a city street' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'generated.jpg'))).resolves.toEqual(jpeg)
    expect(validated).toEqual(['https://download.example/start', 'https://cdn.example/final.jpg'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects unconfigured or invalid generate_image output without creating a file', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    }
    const unconfiguredFetch = vi.fn()
    const unconfigured = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      { fetch: unconfiguredFetch as typeof fetch, imageApiKey: '' },
    )
    const missingKey = await unconfigured.execute({
      id: 'call_generate_unconfigured',
      name: 'generate_image',
      arguments: { file_path: 'missing.png', prompt: 'test' },
    }, context)
    expect(JSON.parse(missingKey.content)).toEqual({
      status: 'error',
      message: 'generate_image requires ANERA_IMAGE_API_KEY or OPENAI_API_KEY to be configured',
    })
    expect(unconfiguredFetch).not.toHaveBeenCalled()

    const invalid = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: vi.fn(async () => Response.json({
          data: [{ b64_json: Buffer.from('not an image').toString('base64') }],
          usage: { input_tokens: 7, output_tokens: 272, total_tokens: 279 },
        })) as typeof fetch,
        imageApiKey: 'test-image-key',
      },
    )
    const invalidResult = await invalid.execute({
      id: 'call_generate_invalid',
      name: 'generate_image',
      arguments: { file_path: 'invalid.png', prompt: 'test' },
    }, context)
    expect(invalidResult.isError).toBe(true)
    expect(invalidResult.modelUsage).toEqual({
      promptTokens: 7,
      completionTokens: 272,
      totalTokens: 279,
      cachedPromptTokens: 0,
    })
    expect(JSON.parse(invalidResult.content)).toMatchObject({ status: 'error', message: expect.stringMatching(/invalid image bytes/) })
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'invalid.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps completed image-generation usage but blocks a late post-abort file write', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-image-abort-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const controller = new AbortController()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        fetch: vi.fn(async () => {
          controller.abort(new DOMException('Tool timed out', 'TimeoutError'))
          return Response.json({
            data: [{ b64_json: png.toString('base64') }],
            usage: { input_tokens: 9, output_tokens: 272, total_tokens: 281 },
          })
        }) as typeof fetch,
        imageApiKey: 'test-image-key',
      },
    )

    const result = await tools.execute({
      id: 'call_generate_aborted',
      name: 'generate_image',
      arguments: { file_path: 'must-not-exist.png', prompt: 'A late generated image' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: controller.signal,
    })

    expect(result).toMatchObject({
      isError: true,
      modelUsage: { promptTokens: 9, completionTokens: 272, totalTokens: 281, cachedPromptTokens: 0 },
    })
    expect(JSON.parse(result.content)).toEqual({ status: 'aborted' })
    await expect(readFile(resolve(store.workspaceDir(session.summary.id), 'must-not-exist.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('projects HTML artifacts to encoded preview routes that preserve relative assets', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const result = await tools.execute({
      id: 'call_html',
      name: 'create_file',
      arguments: { path: '资料 2026/page#1.html', content: '<link rel="stylesheet" href="styles.css"><h1>Ready</h1>' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect((await store.get(session.summary.id)).artifacts).toEqual([
      expect.objectContaining({
        path: '资料 2026/page#1.html',
        previewUrl: `/workspace/${session.summary.id}/preview/%E8%B5%84%E6%96%99%202026/page%231.html`,
      }),
    ])
  })

  it('suppresses live shell chunks for sensitive sessions while preserving the model-only result', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const secret = 'synthetic_secret_123456'
    store.registerSensitiveValues(session.summary.id, [secret])
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const result = await tools.execute({
      id: 'call_sensitive_shell',
      name: 'bash',
      arguments: { command: `printf '${secret}\\n'` },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.content).toContain(secret)
    expect((await store.events(session.summary.id)).some((event) => event.type === 'tool.output')).toBe(false)
  })

  it('discovers a secret in command output before emitting a live UI chunk', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const secret = 'sk-dynamic-tool-output-1234567890'
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const result = await tools.execute({
      id: 'call_dynamic_secret',
      name: 'bash',
      arguments: { command: `printf 'DYNAMIC_API_KEY=${secret}\\n'` },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    })

    expect(result.content).toContain(secret)
    expect(store.hasSensitiveValues(session.summary.id)).toBe(true)
    expect((await store.events(session.summary.id)).some((event) => event.type === 'tool.output')).toBe(false)
  })

  it('projects files created and deleted by Bash into the durable Artifact ledger', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_test',
      stepId: 'step_test',
      signal: new AbortController().signal,
    }
    const created = await tools.execute({ id: 'call_create', name: 'bash', arguments: { command: "printf 'from-shell\\n' > shell.txt" } }, context)
    expect(created).toMatchObject({ isError: false })
    expect((await store.get(session.summary.id)).artifacts).toEqual([expect.objectContaining({ path: 'shell.txt' })])
    expect((await store.events(session.summary.id)).find((event) => event.type === 'artifact.created' && (event.data as { artifact?: { path?: string } }).artifact?.path === 'shell.txt')).toMatchObject({
      turnId: 'turn_test',
      stepId: 'step_test',
      callId: 'call_create',
    })

    const deleted = await tools.execute({ id: 'call_delete', name: 'bash', arguments: { command: 'rm shell.txt' } }, context)
    expect(deleted.isError).toBe(false)
    expect((await store.get(session.summary.id)).artifacts).toEqual([])
    expect((await store.events(session.summary.id)).find((event) => event.type === 'artifact.removed' && (event.data as { path?: string }).path === 'shell.txt')).toMatchObject({
      turnId: 'turn_test',
      stepId: 'step_test',
      callId: 'call_delete',
    })
  })

  it('gives only controlled Coding push/PR commands temporary network/auth, persists pr_open, and redacts credentials', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-coding-push-'))
    roots.push(root)
    const token = 'ghp_SYNTHETIC_CODING_PUSH_TOKEN_123456'
    const arenaBranch = 'arena/0123456789abcdef0123'
    const store = new SessionStore(resolve(root, 'sessions'), 'test-model')
    await store.initialize()
    const session = await store.create({
      repository: {
        provider: 'github', repoId: 17, fullName: 'arena-labs/harness', ownerLogin: 'arena-labs', name: 'harness',
        baseBranch: 'main', baseCommitSha: 'a'.repeat(40), arenaBranch, cwd: '/home/user', private: true,
        importedAt: '2026-08-30T00:00:00.000Z',
      },
    })
    const workspace = store.workspaceDir(session.summary.id)
    await mkdir(resolve(workspace, '.git'), { recursive: true })
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token })
    const runs: Array<Record<string, unknown>> = []
    const runCommand = vi.fn(async (options: {
      command: string
      allowNetwork?: boolean
      environment?: NodeJS.ProcessEnv
      signal: AbortSignal
      onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void
    }) => {
      runs.push(options as unknown as Record<string, unknown>)
      const stdout = options.allowNetwork
        ? options.command.includes("'gh' 'pr' 'create'")
          ? `https://github.com/arena-labs/harness/pull/42 token=${token}\n`
          : `pushed with ${token}\n`
        : 'LOCAL_OK\n'
      options.onOutput('stdout', stdout)
      return {
        stdout, stderr: '', exitCode: 0, signal: null, durationMs: 4,
        truncated: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      }
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        runCommand: runCommand as never,
        shellCommandBroker: createGitHubCodingShellCommandBroker(connector),
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_coding_push',
      stepId: 'step_coding_push',
      signal: new AbortController().signal,
    }

    const pushed = await tools.execute({
      id: 'call_coding_push', name: 'bash', arguments: { command: `git push origin ${arenaBranch}` },
    }, context)
    expect(pushed.isError).toBe(false)
    expect(pushed.content).toContain('[REDACTED_SECRET]')
    expect(pushed.content).not.toContain(token)
    expect(runs[0]).toMatchObject({
      command: expect.stringContaining(`refs/heads/${arenaBranch}:refs/heads/${arenaBranch}`),
      allowNetwork: true,
      environment: expect.objectContaining({ ANERA_GITHUB_ASKPASS_TOKEN: token }),
    })

    const wrongBranch = await tools.execute({
      id: 'call_wrong_push', name: 'bash', arguments: { command: 'git push origin main' },
    }, context)
    expect(wrongBranch.isError).toBe(true)
    expect(JSON.parse(wrongBranch.content)).toMatchObject({ status: 'shell_error', exit_code: null })
    expect(runs).toHaveLength(1)

    const local = await tools.execute({
      id: 'call_local_git', name: 'bash', arguments: { command: 'git status --short' },
    }, context)
    expect(JSON.parse(local.content)).toMatchObject({ stdout: 'LOCAL_OK\n', status: 'completed' })
    expect(runs[1]).toMatchObject({ command: 'git status --short' })
    expect(runs[1]).not.toHaveProperty('allowNetwork')
    expect(runs[1]).not.toHaveProperty('environment')

    const pullRequest = await tools.execute({
      id: 'call_pr_create',
      name: 'bash',
      arguments: { command: 'gh pr create --title "Fix parser" --body "Adds regression coverage." --draft' },
    }, context)
    expect(pullRequest.isError).toBe(false)
    expect(pullRequest.content).toContain('https://github.com/arena-labs/harness/pull/42')
    expect(pullRequest.content).toContain('[REDACTED_SECRET]')
    expect(pullRequest.content).not.toContain(token)
    expect(runs[2]).toMatchObject({
      command: expect.stringContaining(`'--head' '${arenaBranch}'`),
      allowNetwork: true,
      environment: expect.objectContaining({ GH_TOKEN: token, GH_HOST: 'github.com' }),
    })
    expect((runs[2].environment as NodeJS.ProcessEnv)).not.toHaveProperty('ANERA_GITHUB_ASKPASS_TOKEN')
    expect((await store.get(session.summary.id)).summary.codingSessionStatus).toBe('pr_open')

    await store.update(session.summary.id, (state) => { state.summary.codingSessionStatus = 'closed' })
    const closed = await tools.execute({
      id: 'call_closed_push', name: 'bash', arguments: { command: `git push origin ${arenaBranch}` },
    }, context)
    expect(JSON.parse(closed.content)).toMatchObject({ status: 'shell_error', stderr: expect.stringContaining('closed') })
    expect(runs).toHaveLength(3)
    expect(JSON.stringify(await store.events(session.summary.id))).not.toContain(token)
  })

  it('keeps a Coding session active when the controlled PR creation command fails', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-coding-pr-failure-'))
    roots.push(root)
    const token = 'ghp_SYNTHETIC_FAILED_PR_TOKEN_123456'
    const arenaBranch = 'arena/0123456789abcdef0123'
    const store = new SessionStore(resolve(root, 'sessions'), 'test-model')
    await store.initialize()
    const session = await store.create({
      repository: {
        provider: 'github', repoId: 17, fullName: 'arena-labs/harness', ownerLogin: 'arena-labs', name: 'harness',
        baseBranch: 'main', baseCommitSha: 'a'.repeat(40), arenaBranch, cwd: '/home/user', private: true,
        importedAt: '2026-08-30T00:00:00.000Z',
      },
    })
    await mkdir(resolve(store.workspaceDir(session.summary.id), '.git'), { recursive: true })
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token })
    const runCommand = vi.fn(async (options: {
      environment?: NodeJS.ProcessEnv
      signal: AbortSignal
      onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void
    }) => {
      options.onOutput('stderr', `pull request rejected token=${token}\n`)
      return {
        stdout: '', stderr: `pull request rejected token=${token}\n`, exitCode: 1, signal: null, durationMs: 4,
        truncated: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      }
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        runCommand: runCommand as never,
        shellCommandBroker: createGitHubCodingShellCommandBroker(connector),
      },
    )
    const result = await tools.execute({
      id: 'call_failed_pr_create',
      name: 'bash',
      arguments: { command: 'gh pr create --title "Fail PR" --body "Expected failure"' },
    }, {
      sessionId: session.summary.id,
      turnId: 'turn_failed_pr_create',
      stepId: 'step_failed_pr_create',
      signal: new AbortController().signal,
    })

    expect(JSON.parse(result.content)).toMatchObject({
      exit_code: 1,
      stderr: expect.stringContaining('[REDACTED_SECRET]'),
      status: 'completed',
    })
    expect(result.content).not.toContain(token)
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
      allowNetwork: true,
      environment: expect.objectContaining({ GH_TOKEN: token, GH_HOST: 'github.com' }),
    }))
    expect((await store.get(session.summary.id)).summary.codingSessionStatus).toBe('active')
    expect(JSON.stringify(await store.events(session.summary.id))).not.toContain(token)
  })

  it('executes scoped issue creation and current-branch workflow diagnostics without changing Coding status', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-coding-github-operations-'))
    roots.push(root)
    const token = 'ghp_SYNTHETIC_CODING_OPERATIONS_TOKEN_123456'
    const arenaBranch = 'arena/0123456789abcdef0123'
    const store = new SessionStore(resolve(root, 'sessions'), 'test-model')
    await store.initialize()
    const session = await store.create({
      repository: {
        provider: 'github', repoId: 17, fullName: 'arena-labs/harness', ownerLogin: 'arena-labs', name: 'harness',
        baseBranch: 'main', baseCommitSha: 'a'.repeat(40), arenaBranch, cwd: '/home/user', private: true,
        importedAt: '2026-08-30T00:00:00.000Z',
      },
    })
    await mkdir(resolve(store.workspaceDir(session.summary.id), '.git'), { recursive: true })
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token })
    const runs: Array<Record<string, unknown>> = []
    const runCommand = vi.fn(async (options: {
      command: string
      onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void
    }) => {
      runs.push(options as unknown as Record<string, unknown>)
      const stdout = options.command.includes("'issue' 'create'")
        ? `https://github.com/arena-labs/harness/issues/7 token=${token}\n`
        : `[{"databaseId":12345,"headBranch":"${arenaBranch}","status":"completed"}] token=${token}\n`
      options.onOutput('stdout', stdout)
      return {
        stdout, stderr: '', exitCode: 0, signal: null, durationMs: 4,
        truncated: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      }
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
      {
        runCommand: runCommand as never,
        shellCommandBroker: createGitHubCodingShellCommandBroker(connector),
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_coding_github_operations',
      stepId: 'step_coding_github_operations',
      signal: new AbortController().signal,
    }

    const issue = await tools.execute({
      id: 'call_issue_create',
      name: 'bash',
      arguments: { command: 'gh issue create --title "Parser regression" --body "Tracks the remaining edge case." --label bug' },
    }, context)
    expect(issue.content).toContain('/issues/7')
    expect(issue.content).toContain('[REDACTED_SECRET]')
    expect(issue.content).not.toContain(token)
    expect(runs[0]).toMatchObject({
      command: expect.stringContaining("'gh' 'issue' 'create' '--repo' 'arena-labs/harness'"),
      allowNetwork: true,
      environment: expect.objectContaining({ GH_TOKEN: token, GH_HOST: 'github.com' }),
    })

    const runsForBranch = await tools.execute({
      id: 'call_run_list',
      name: 'bash',
      arguments: { command: 'gh run list --limit 10 --json databaseId,headBranch,status' },
    }, context)
    expect(runsForBranch.content).toContain('[REDACTED_SECRET]')
    expect(runsForBranch.content).not.toContain(token)
    expect(runs[1]).toMatchObject({
      command: expect.stringContaining(`'--branch' '${arenaBranch}'`),
      allowNetwork: true,
      environment: expect.objectContaining({ GH_TOKEN: token, GH_HOST: 'github.com' }),
    })
    expect((await store.get(session.summary.id)).summary.codingSessionStatus).toBe('active')
    expect(JSON.stringify(await store.events(session.summary.id))).not.toContain(token)
  })

  it('keeps high-impact GitHub mutations credential-free until approval and applies status only after success', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-approved-github-mutation-'))
    roots.push(root)
    const token = 'ghp_SYNTHETIC_APPROVED_MUTATION_TOKEN_123456'
    const arenaBranch = 'arena/0123456789abcdef0123'
    const store = new SessionStore(resolve(root, 'sessions'), 'test-model')
    await store.initialize()
    const session = await store.create({
      repository: {
        provider: 'github', repoId: 17, fullName: 'arena-labs/harness', ownerLogin: 'arena-labs', name: 'harness',
        baseBranch: 'main', baseCommitSha: 'a'.repeat(40), arenaBranch, cwd: '/home/user', private: true,
        importedAt: '2026-08-30T00:00:00.000Z',
      },
      codingSessionStatus: 'pr_open',
    })
    await store.update(session.summary.id, (state) => { state.summary.codingSessionStatus = 'pr_open' })
    await mkdir(resolve(store.workspaceDir(session.summary.id), '.git'), { recursive: true })
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token })
    const acquire = vi.spyOn(connector, 'acquireCredentialLease')
    const runs: Array<Record<string, unknown>> = []
    const runCommand = vi.fn(async (options: {
      command: string
      onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void
    }) => {
      runs.push(options as unknown as Record<string, unknown>)
      const stdout = `Closed pull request token=${token}\n`
      options.onOutput('stdout', stdout)
      return {
        stdout, stderr: '', exitCode: 0, signal: null, durationMs: 4,
        truncated: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      }
    })
    let approvalCall = 0
    const requestApproval = vi.fn(async (
      _context: unknown,
      _call: unknown,
      presentation?: { title?: string; description?: string },
    ) => {
      approvalCall += 1
      expect(acquire).not.toHaveBeenCalled()
      expect(runCommand).not.toHaveBeenCalled()
      expect(presentation).toMatchObject({ title: expect.stringContaining('Approve'), description: expect.stringContaining('arena-labs/harness') })
      return approvalCall === 2
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      requestApproval as never,
      {
        runCommand: runCommand as never,
        shellCommandBroker: createGitHubCodingShellCommandBroker(connector),
      },
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_approved_github_mutation',
      stepId: 'step_approved_github_mutation',
      signal: new AbortController().signal,
    }

    const denied = await tools.execute({
      id: 'call_denied_issue_close',
      name: 'bash',
      arguments: { command: 'gh issue close 42 --reason completed' },
    }, context)
    expect(denied.isError).toBe(true)
    expect(JSON.parse(denied.content)).toMatchObject({ status: 'shell_error', stderr: expect.stringContaining('denied') })
    expect(acquire).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
    expect((await store.get(session.summary.id)).summary.codingSessionStatus).toBe('pr_open')

    const approved = await tools.execute({
      id: 'call_approved_pr_close',
      name: 'bash',
      arguments: { command: 'gh pr close --comment "Superseded"' },
    }, context)
    expect(approved.content).toContain('[REDACTED_SECRET]')
    expect(approved.content).not.toContain(token)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      command: expect.stringContaining(`'gh' 'pr' 'close' '${arenaBranch}' '--repo' 'arena-labs/harness'`),
      allowNetwork: true,
      environment: expect.objectContaining({ GH_TOKEN: token, GH_HOST: 'github.com' }),
    })
    expect((await store.get(session.summary.id)).summary.codingSessionStatus).toBe('closed')
    expect(JSON.stringify(await store.events(session.summary.id))).not.toContain(token)
  })

  it('reopens a closed Coding Session only after approval and revalidates closure state and connection before execution', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-closed-pr-reopen-'))
    roots.push(root)
    const token = 'ghp_SYNTHETIC_CLOSED_REOPEN_TOKEN_123456'
    const arenaBranch = 'arena/0123456789abcdef0123'
    const store = new SessionStore(resolve(root, 'sessions'), 'test-model')
    await store.initialize()
    const createClosedSession = async () => {
      const session = await store.create({
        repository: {
          provider: 'github', repoId: 17, fullName: 'arena-labs/harness', ownerLogin: 'arena-labs', name: 'harness',
          baseBranch: 'main', baseCommitSha: 'a'.repeat(40), arenaBranch, cwd: '/home/user', private: true,
          importedAt: '2026-08-30T00:00:00.000Z',
        },
        codingSessionStatus: 'closed',
      })
      await store.update(session.summary.id, (state) => { state.summary.codingSessionStatus = 'closed' })
      await mkdir(resolve(store.workspaceDir(session.summary.id), '.git'), { recursive: true })
      return session
    }
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token })
    const acquire = vi.spyOn(connector, 'acquireCredentialLease')
    const runs: Array<Record<string, unknown>> = []
    const runCommand = vi.fn(async (options: {
      command: string
      onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void
    }) => {
      runs.push(options as unknown as Record<string, unknown>)
      const stdout = `Reopened pull request token=${token}\n`
      options.onOutput('stdout', stdout)
      return {
        stdout, stderr: '', exitCode: 0, signal: null, durationMs: 4,
        truncated: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      }
    })
    const sessions = new Map<string, Awaited<ReturnType<typeof createClosedSession>>>()
    const requestApproval = vi.fn(async (
      context: { sessionId: string },
      call: { id: string },
      presentation?: { title?: string; description?: string },
    ) => {
      expect(presentation).toMatchObject({
        title: 'Approve pull request reopening?',
        description: expect.stringContaining(arenaBranch),
      })
      if (call.id === 'call_reopen_success') {
        expect(acquire).not.toHaveBeenCalled()
        expect(runCommand).not.toHaveBeenCalled()
      } else if (call.id === 'call_reopen_became_merged') {
        await store.update(context.sessionId, (state) => { state.summary.codingSessionStatus = 'pr_merged' })
      } else if (call.id === 'call_reopen_disconnected') {
        await connector.disconnect()
      }
      return true
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      requestApproval as never,
      {
        runCommand: runCommand as never,
        shellCommandBroker: createGitHubCodingShellCommandBroker(connector),
      },
    )

    const successful = await createClosedSession()
    sessions.set('successful', successful)
    const success = await tools.execute({
      id: 'call_reopen_success', name: 'bash', arguments: { command: 'gh pr reopen --comment "Resume work"' },
    }, {
      sessionId: successful.summary.id, turnId: 'turn_reopen_success', stepId: 'step_reopen_success',
      signal: new AbortController().signal,
    })
    expect(success.isError).toBe(false)
    expect(success.content).toContain('[REDACTED_SECRET]')
    expect(success.content).not.toContain(token)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      command: expect.stringContaining(`'gh' 'pr' 'reopen' '${arenaBranch}' '--repo' 'arena-labs/harness'`),
      allowNetwork: true,
      environment: expect.objectContaining({ GH_TOKEN: token, GH_HOST: 'github.com' }),
    })
    expect((await store.get(successful.summary.id)).summary.codingSessionStatus).toBe('pr_open')
    expect(JSON.stringify(await store.events(successful.summary.id))).not.toContain(token)

    const becameMerged = await createClosedSession()
    sessions.set('becameMerged', becameMerged)
    const stale = await tools.execute({
      id: 'call_reopen_became_merged', name: 'bash', arguments: { command: 'gh pr reopen' },
    }, {
      sessionId: becameMerged.summary.id, turnId: 'turn_reopen_merged', stepId: 'step_reopen_merged',
      signal: new AbortController().signal,
    })
    expect(stale.isError).toBe(true)
    expect(JSON.parse(stale.content)).toMatchObject({ status: 'shell_error', stderr: expect.stringContaining('merged') })
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect((await store.get(becameMerged.summary.id)).summary.codingSessionStatus).toBe('pr_merged')

    const disconnected = await createClosedSession()
    sessions.set('disconnected', disconnected)
    const disconnectedResult = await tools.execute({
      id: 'call_reopen_disconnected', name: 'bash', arguments: { command: 'gh pr reopen' },
    }, {
      sessionId: disconnected.summary.id, turnId: 'turn_reopen_disconnected', stepId: 'step_reopen_disconnected',
      signal: new AbortController().signal,
    })
    expect(disconnectedResult.isError).toBe(true)
    expect(disconnectedResult.content).not.toContain(token)
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(runCommand).toHaveBeenCalledTimes(1)
    for (const session of sessions.values()) {
      expect(JSON.stringify(await store.events(session.summary.id))).not.toContain(token)
      expect(JSON.stringify(await store.get(session.summary.id))).not.toContain(token)
    }
  })

  it('promotes a successful merge to pr_merged from the trusted oracle and fails closed when that oracle is unavailable', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-github-merge-oracle-'))
    roots.push(root)
    const token = 'ghp_SYNTHETIC_MERGE_ORACLE_TOKEN_123456'
    const arenaBranch = 'arena/0123456789abcdef0123'
    const store = new SessionStore(resolve(root, 'sessions'), 'test-model')
    await store.initialize()
    const createSession = async () => {
      const session = await store.create({
        repository: {
          provider: 'github', repoId: 17, fullName: 'arena-labs/harness', ownerLogin: 'arena-labs', name: 'harness',
          baseBranch: 'main', baseCommitSha: 'a'.repeat(40), arenaBranch, cwd: '/home/user', private: true,
          importedAt: '2026-08-30T00:00:00.000Z',
        },
        codingSessionStatus: 'pr_open',
      })
      await store.update(session.summary.id, (state) => { state.summary.codingSessionStatus = 'pr_open' })
      await mkdir(resolve(store.workspaceDir(session.summary.id), '.git'), { recursive: true })
      return session
    }
    let oracleAvailable = true
    let commandCompleted = false
    const fetchImpl = vi.fn(async () => {
      expect(commandCompleted).toBe(true)
      if (!oracleAvailable) return new Response('unavailable', { status: 503 })
      return Response.json([{
        state: 'closed', merged_at: '2026-08-30T00:00:00.000Z',
        head: { ref: arenaBranch, repo: { full_name: 'arena-labs/harness' } }, base: { ref: 'main' },
      }])
    })
    const connector = new GitHubConnector({
      dataRoot: resolve(root, 'connector'), token, apiBaseUrl: 'https://api.test', fetch: fetchImpl as typeof fetch,
    })
    const runCommand = vi.fn(async (options: { onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void }) => {
      commandCompleted = true
      options.onOutput('stdout', 'Merged pull request\n')
      return {
        stdout: 'Merged pull request\n', stderr: '', exitCode: 0, signal: null, durationMs: 4,
        truncated: false, stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      }
    })
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => true,
      { runCommand: runCommand as never, shellCommandBroker: createGitHubCodingShellCommandBroker(connector) },
    )

    const merged = await createSession()
    const mergedResult = await tools.execute({
      id: 'call_merge_with_oracle', name: 'bash', arguments: { command: 'gh pr merge --squash' },
    }, {
      sessionId: merged.summary.id, turnId: 'turn_merge_oracle', stepId: 'step_merge_oracle', signal: new AbortController().signal,
    })
    expect(mergedResult.isError).toBe(false)
    expect((await store.get(merged.summary.id)).summary.codingSessionStatus).toBe('pr_merged')

    oracleAvailable = false
    commandCompleted = false
    const fallback = await createSession()
    const fallbackResult = await tools.execute({
      id: 'call_merge_without_oracle', name: 'bash', arguments: { command: 'gh pr merge --rebase' },
    }, {
      sessionId: fallback.summary.id, turnId: 'turn_merge_fallback', stepId: 'step_merge_fallback', signal: new AbortController().signal,
    })
    expect(fallbackResult.isError).toBe(false)
    expect((await store.get(fallback.summary.id)).summary.codingSessionStatus).toBe('closed')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(await store.events(merged.summary.id))).not.toContain(token)
    expect(JSON.stringify(await store.events(fallback.summary.id))).not.toContain(token)
  })

  it('revalidates status and connection after GitHub mutation approval before acquiring usable credentials', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-stale-github-approval-'))
    roots.push(root)
    const token = 'ghp_SYNTHETIC_STALE_APPROVAL_TOKEN_123456'
    const arenaBranch = 'arena/0123456789abcdef0123'
    const store = new SessionStore(resolve(root, 'sessions'), 'test-model')
    await store.initialize()
    const createSession = async () => {
      const session = await store.create({
        repository: {
          provider: 'github', repoId: 17, fullName: 'arena-labs/harness', ownerLogin: 'arena-labs', name: 'harness',
          baseBranch: 'main', baseCommitSha: 'a'.repeat(40), arenaBranch, cwd: '/home/user', private: true,
          importedAt: '2026-08-30T00:00:00.000Z',
        },
        codingSessionStatus: 'pr_open',
      })
      await store.update(session.summary.id, (state) => { state.summary.codingSessionStatus = 'pr_open' })
      await mkdir(resolve(store.workspaceDir(session.summary.id), '.git'), { recursive: true })
      return session
    }
    const connector = new GitHubConnector({ dataRoot: resolve(root, 'connector'), token })
    const acquire = vi.spyOn(connector, 'acquireCredentialLease')
    const runCommand = vi.fn()
    const staleSession = await createSession()
    const staleTools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      (async () => {
        await store.update(staleSession.summary.id, (state) => { state.summary.codingSessionStatus = 'closed' })
        return true
      }) as never,
      { runCommand: runCommand as never, shellCommandBroker: createGitHubCodingShellCommandBroker(connector) },
    )
    const stale = await staleTools.execute({
      id: 'call_stale_pr_merge', name: 'bash', arguments: { command: 'gh pr merge --squash' },
    }, {
      sessionId: staleSession.summary.id, turnId: 'turn_stale', stepId: 'step_stale', signal: new AbortController().signal,
    })
    expect(stale.isError).toBe(true)
    expect(JSON.parse(stale.content)).toMatchObject({ status: 'shell_error', stderr: expect.stringContaining('closed') })
    expect(acquire).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()

    const disconnectedSession = await createSession()
    const disconnectedTools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      (async () => {
        await connector.disconnect()
        return true
      }) as never,
      { runCommand: runCommand as never, shellCommandBroker: createGitHubCodingShellCommandBroker(connector) },
    )
    const disconnected = await disconnectedTools.execute({
      id: 'call_disconnected_issue_close', name: 'bash', arguments: { command: 'gh issue close 42 --reason completed' },
    }, {
      sessionId: disconnectedSession.summary.id, turnId: 'turn_disconnected', stepId: 'step_disconnected', signal: new AbortController().signal,
    })
    expect(disconnected.isError).toBe(true)
    expect(disconnected.content).not.toContain(token)
    expect(runCommand).not.toHaveBeenCalled()
    expect(JSON.stringify(await store.events(disconnectedSession.summary.id))).not.toContain(token)
  })

  it('executes Arena bash and shell_command schemas with structured results, bounded timeouts, and workspace-relative workdirs', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-tools-shell-schema-'))
    roots.push(root)
    const store = new SessionStore(root, 'test-model')
    await store.initialize()
    const session = await store.create()
    const workspace = store.workspaceDir(session.summary.id)
    await mkdir(resolve(workspace, 'sub'))
    const tools = new ToolExecutor(
      store,
      new ProcessManager(() => {}, 10_000),
      new BrowserManager(),
      { inspect: vi.fn() },
      async () => false,
    )
    const context = {
      sessionId: session.summary.id,
      turnId: 'turn_shell_schema',
      stepId: 'step_shell_schema',
      signal: new AbortController().signal,
    }

    const bash = await tools.execute({
      id: 'call_bash_schema',
      name: 'bash',
      arguments: {
        command: "printf 'BASH_OK\\n'",
        timeout: 5,
        cwd: 'sub',
      },
    }, context)
    expect(bash).toMatchObject({ isError: false, timedOut: false })
    expect(JSON.parse(bash.content)).toMatchObject({
      stdout: 'BASH_OK\n', stdout_truncated: false, stderr: '', stderr_truncated: false,
      exit_code: 0, status: 'completed', duration_ms: expect.any(Number),
    })

    const stdoutHeavy = await tools.execute({
      id: 'call_bash_stdout_truncation',
      name: 'bash',
      arguments: { command: `python3 -c "import sys;sys.stdout.write('O'*20050);sys.stderr.write('err')"`, timeout: 5 },
    }, context)
    const stdoutHeavyPayload = JSON.parse(stdoutHeavy.content) as Record<string, unknown>
    expect(String(stdoutHeavyPayload.stdout)).toHaveLength(20_000)
    expect(stdoutHeavyPayload).toMatchObject({
      stdout_truncated: true,
      stderr: 'err',
      stderr_truncated: false,
      exit_code: 0,
      status: 'completed',
    })

    const failedBash = await tools.execute({
      id: 'call_bash_failed',
      name: 'bash',
      arguments: { command: "printf 'BASH_WARNING\\n' >&2; exit 127", timeout: 5 },
    }, context)
    expect(failedBash).toMatchObject({ isError: true, timedOut: false })
    expect(JSON.parse(failedBash.content)).toMatchObject({
      stdout: '',
      stderr: 'BASH_WARNING\n',
      exit_code: 127,
      status: 'completed',
      duration_ms: expect.any(Number),
    })

    const shell = await tools.execute({
      id: 'call_shell_command_schema',
      name: 'shell_command',
      arguments: { command: "printf 'FROM_SHELL_COMMAND\\n' > nested.txt", workdir: 'sub' },
    }, context)
    expect(shell).toEqual({ content: '{"status":"success"}', isError: false, timedOut: false })
    await expect(readFile(resolve(workspace, 'sub', 'nested.txt'), 'utf8')).resolves.toBe('FROM_SHELL_COMMAND\n')
    expect((await store.get(session.summary.id)).artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sub/nested.txt' }),
    ]))

    const failed = await tools.execute({
      id: 'call_shell_failed', name: 'shell_command', arguments: { command: "printf 'SHELL_WARNING\\n' >&2; exit 7" },
    }, context)
    expect(failed).toMatchObject({ isError: true, timedOut: false })
    expect(JSON.parse(failed.content)).toEqual({
      status: 'error', message: 'Command exited with code 7', stderr: 'SHELL_WARNING\n',
    })

    for (const command of [
      'pip3 install openpyxl',
      'python3 -m pip install openpyxl',
      'npm install exceljs',
      'pnpm add exceljs',
    ]) {
      const blockedInstall = await tools.execute({
        id: `call_blocked_install_${command.length}`,
        name: 'bash',
        arguments: { command },
      }, context)
      expect(blockedInstall.isError).toBe(true)
      expect(JSON.parse(blockedInstall.content)).toMatchObject({
        status: 'shell_error',
        stderr: expect.stringMatching(/install_npm_packages|no pip install path/),
      })
    }

    const timedOut = await tools.execute({
      id: 'call_bash_timed_out', name: 'bash', arguments: { command: 'sleep 2', timeout: 1 },
    }, context)
    expect(timedOut).toMatchObject({ isError: true, timedOut: true })
    expect(JSON.parse(timedOut.content)).toMatchObject({
      status: 'timeout', exit_code: null, stderr: expect.stringContaining('Command timed out after 1000ms'),
    })

    const escaped = await tools.execute({
      id: 'call_shell_escape', name: 'shell_command', arguments: { command: 'true', workdir: '..' },
    }, context)
    expect(escaped.isError).toBe(true)
    expect(JSON.parse(escaped.content)).toMatchObject({ status: 'error', message: expect.stringMatching(/escapes the workspace/) })
  })
})
