import type { ToolExecutionResult } from './tools.js'

export const ARENA_PUBLIC_RESULT_TOOL_NAMES = [
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
] as const

export const ARENA_PUBLIC_COMMON_ERROR_RESULT_FIELDS = ['status', 'message', 'stdout', 'stderr'] as const

export const ARENA_PUBLIC_TOOL_ERROR_EXTENSION_FIELDS: Record<string, readonly string[]> = {
  build_and_start: ['stage', 'logTail'],
}

export const ARENA_PUBLIC_SUCCESS_RESULT_FIELDS: Record<(typeof ARENA_PUBLIC_RESULT_TOOL_NAMES)[number], readonly string[]> = {
  create_file: ['status', 'message', 'lint_error'],
  edit_file: ['status', 'message', 'match_type', 'matched_text', 'lint_error'],
  read_file: ['status', 'file', 'path', 'content', 'contentType', 'totalLines', 'image', 'mediaType', 'sizeBytes'],
  list_files: ['status', 'files', 'path'],
  delete_file: ['status'],
  install_npm_packages: ['status', 'stdout', 'stderr'],
  build_project: ['status', 'stdout', 'stderr'],
  build_and_start: ['status', 'previewUrl', 'buildLatencyMs'],
  deploy_project: ['status'],
  apply_patch: ['status', 'message', 'lint_error'],
  bash: ['status', 'stdout', 'stderr'],
  shell_command: ['status', 'stdout', 'stderr'],
  update_plan: ['status'],
  grep_files: ['status', 'mode', 'matches', 'path', 'lineNumber', 'lineContent', 'contextBefore', 'contextAfter', 'files', 'counts', 'count', 'totalMatches', 'truncated'],
  glob_files: ['status', 'paths', 'truncated'],
  web_search: ['status', 'results', 'id', 'title', 'url', 'description', 'pageAge'],
  web_fetch: ['status', 'title', 'content'],
  fetch_media: [
    'status', 'query', 'mediaType', 'totalResults', 'results', 'type', 'id', 'pexelsUrl',
    'recommendedUrl', 'thumbnailUrl', 'width', 'height', 'creatorName', 'creatorUrl', 'alt',
    'duration', 'videoFile', 'url', 'quality', 'fileType',
  ],
  generate_image: ['status', 'message'],
}

const PUBLIC_RESULT_TOOLS = new Set<string>(ARENA_PUBLIC_RESULT_TOOL_NAMES)
export const ARENA_ACTIVE_RESULT_TOOL_NAMES = [
  'add_voice',
  'ask_user',
  'bash',
  'compact',
  'edit_file',
  'fetch_page',
  'generate_image',
  'generate_speech',
  'get_process_output',
  'image_search',
  'list_connector_tools',
  'list_files',
  'present_file',
  'propose_plan',
  'read_file',
  'start_process',
  'stop_process',
  'web_search',
  'write_file',
] as const
const ACTIVE_RESULT_TOOLS = new Set<string>(ARENA_ACTIVE_RESULT_TOOL_NAMES)
const STRUCTURED_ERROR_RESULT_TOOLS = new Set<string>([
  ...ARENA_PUBLIC_RESULT_TOOL_NAMES,
  'add_voice',
  'ask_user',
  'compact',
  'fetch_page',
  'generate_speech',
  'get_process_output',
  'image_search',
  'list_connector_tools',
  'present_file',
  'propose_plan',
  'start_process',
  'write_file',
])
const WEBDEV_CONTENT_TYPES = new Set([
  'text/html',
  'text/javascript',
  'text/css',
  'text/markdown',
  'application/json',
  'application/sql',
  'application/toml',
  'application/x-yaml',
  'image/svg+xml',
  'text/x-python',
  'text/x-shellscript',
  'text/yaml',
  'text/plain',
])

export interface ArenaToolErrorExtensions {
  stdout?: string
  stderr?: string
  stage?: string
  logTail?: string
}

/**
 * Creates a Harness-originated tool failure without leaking a private plain-text
 * result into one of Arena's public structured tool protocols.
 *
 * Non-public compatibility tools intentionally retain their legacy plain-text
 * result because no Arena result union is known for them.
 */
export function arenaToolErrorResult(
  toolName: string,
  message: string,
  extensions: ArenaToolErrorExtensions = {},
): ToolExecutionResult {
  if (!STRUCTURED_ERROR_RESULT_TOOLS.has(toolName)) return { content: message, isError: true }
  const payload: Record<string, string> = { status: 'error', message }
  for (const field of ['stdout', 'stderr'] as const) {
    if (extensions[field] !== undefined) payload[field] = extensions[field]
  }
  if (toolName === 'build_and_start') {
    for (const field of ARENA_PUBLIC_TOOL_ERROR_EXTENSION_FIELDS.build_and_start) {
      const value = extensions[field as keyof ArenaToolErrorExtensions]
      if (value !== undefined) payload[field] = value
    }
  }
  return { content: JSON.stringify(payload), isError: true }
}

export function enforceArenaPublicToolResult(toolName: string, result: ToolExecutionResult): ToolExecutionResult {
  if (ACTIVE_RESULT_TOOLS.has(toolName)) {
    try {
      assertArenaActiveToolResult(toolName, result)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return arenaActiveContractViolation(toolName, message)
    }
  }
  if (!PUBLIC_RESULT_TOOLS.has(toolName)) return result
  try {
    assertArenaPublicToolResult(toolName, result)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return arenaToolErrorResult(toolName, `Local result violated the Arena ${toolName} contract: ${message}`)
  }
}

/**
 * Enforce Anera's provider-visible runtime overlays without widening Arena's
 * frozen active result unions. Today only list_files has a distinct paged
 * result; every other tool continues through the Arena validator above.
 */
export function enforceAneraRuntimeToolResult(toolName: string, result: ToolExecutionResult): ToolExecutionResult {
  if (toolName !== 'list_files') return enforceArenaPublicToolResult(toolName, result)
  try {
    assertAneraRuntimeToolResult(toolName, result)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return arenaActiveContractViolation(toolName, `Local result violated the Anera ${toolName} runtime contract: ${message}`)
  }
}

export function assertAneraRuntimeToolResult(toolName: string, result: ToolExecutionResult): void {
  if (toolName !== 'list_files') return assertArenaActiveToolResult(toolName, result)
  let payload: unknown
  try {
    payload = JSON.parse(result.content)
  } catch {
    throw new Error('result content is not valid JSON')
  }
  const record = objectValue(payload, 'result')
  if (record.status === 'error') return assertErrorMessage(record)
  exactKeys(record, ['files', 'hasMore', 'truncated', 'totalFiles'], ['nextCursor'], 'result')
  const files = arrayValue(record.files, 'result.files')
  if (files.length > 500) throw new Error('result.files must contain at most 500 files')
  files.forEach((value, index) => {
    const file = objectValue(value, `result.files[${index}]`)
    exactKeys(file, ['path'], [], `result.files[${index}]`)
    boundedString(file.path, `result.files[${index}].path`, 4_096)
  })
  booleanValue(record.hasMore, 'result.hasMore')
  const hasMore = record.hasMore === true
  booleanValue(record.truncated, 'result.truncated')
  const totalFiles = nonNegativeInteger(record.totalFiles, 'result.totalFiles')
  if (totalFiles > 10_001) throw new Error('result.totalFiles exceeds the 10,000-file support cap lower bound')
  if (totalFiles < files.length) throw new Error('result.totalFiles cannot be smaller than the returned page')
  if (hasMore) {
    const nextCursor = nonEmptyString(record.nextCursor, 'result.nextCursor')
    if (nextCursor.trim().length === 0) throw new Error('result.nextCursor must be non-empty')
    if (nextCursor.length > 1_024) throw new Error('result.nextCursor must contain at most 1024 characters')
  } else if (record.nextCursor !== undefined) {
    throw new Error('terminal list_files page cannot contain result.nextCursor')
  }
  if (Buffer.byteLength(result.content) > 64 * 1_024) throw new Error('result exceeds the 64 KiB JSON budget')
}

function arenaActiveContractViolation(toolName: string, detail: string): ToolExecutionResult {
  const message = `Local result violated the Arena ${toolName} active contract: ${detail}`
  let payload: Record<string, unknown>
  switch (toolName) {
    case 'ask_user':
      payload = { skipped: true, answers: [] }
      break
    case 'compact':
      payload = { summary: '' }
      break
    case 'bash':
      payload = {
        stdout: '', stdout_truncated: false, stderr: message, stderr_truncated: false,
        exit_code: null, status: 'shell_error', duration_ms: 0,
      }
      break
    case 'fetch_page':
    case 'web_search':
      payload = { status: 'error', error: message }
      break
    case 'get_process_output':
      payload = { status: 'shell_error', exit_code: null, log_tail: message, listening_ports: [] }
      break
    case 'start_process':
      payload = {
        status: 'shell_error', process_id: null, pid: null, exit_code: null, log_tail: message,
        listening_ports: [], new_ports: [], duration_ms: 0,
      }
      break
    case 'stop_process':
      payload = { status: 'shell_error', log_tail: message }
      break
    case 'list_connector_tools':
      payload = { status: 'internal_error', message: 'Could not load the connector tools. Try again.' }
      break
    default:
      payload = { status: 'error', message }
  }
  return { content: JSON.stringify(payload), isError: true }
}

/** Validate the completed-route output unions recovered from Arena's public bundle. */
export function assertArenaActiveToolResult(toolName: string, result: ToolExecutionResult): void {
  if (!ACTIVE_RESULT_TOOLS.has(toolName)) return
  let payload: unknown
  try {
    payload = JSON.parse(result.content)
  } catch {
    throw new Error('result content is not valid JSON')
  }
  const record = objectValue(payload, 'result')
  switch (toolName) {
    case 'add_voice':
      assertAddVoiceResult(record)
      return
    case 'ask_user':
      assertAskUserResult(record)
      return
    case 'bash':
      assertBashResult(record)
      return
    case 'compact':
      assertCompactResult(record)
      return
    case 'edit_file':
      assertMutationResult(record, true)
      return
    case 'fetch_page':
      assertFetchPageResult(record)
      return
    case 'generate_image':
      assertGenerateImageResult(record)
      return
    case 'generate_speech':
      assertGenerateSpeechResult(record)
      return
    case 'get_process_output':
      assertGetProcessOutputResult(record)
      return
    case 'image_search':
      assertImageSearchResult(record)
      return
    case 'list_connector_tools':
      assertConnectorResult(record)
      return
    case 'list_files':
      assertActiveListFilesResult(record)
      return
    case 'present_file':
      assertPresentFileResult(record)
      return
    case 'propose_plan':
      assertProposePlanResult(record)
      return
    case 'read_file':
      assertActiveReadFileResult(record)
      return
    case 'start_process':
      assertStartProcessResult(record)
      return
    case 'stop_process':
      assertStopProcessResult(record)
      return
    case 'web_search':
      assertActiveWebSearchResult(record)
      return
    case 'write_file':
      assertMutationResult(record, false)
      return
    default:
      throw new Error(`no active result validator exists for ${toolName}`)
  }
}

function statusOf(record: Record<string, unknown>): string {
  return stringValue(record.status, 'result.status')
}

function assertStatusOnly(record: Record<string, unknown>, expected: string): void {
  exactKeys(record, ['status'], [], 'result')
  literalValue(record.status, expected, 'result.status')
}

function assertErrorMessage(record: Record<string, unknown>): void {
  exactKeys(record, ['status', 'message'], [], 'result')
  literalValue(record.status, 'error', 'result.status')
  stringValue(record.message, 'result.message')
}

function assertCandidateArray(value: unknown, path: string, max: number): void {
  const candidates = arrayValue(value, path)
  if (candidates.length < 1 || candidates.length > max) throw new Error(`${path} must contain 1-${max} candidates`)
  candidates.forEach((candidateValue, index) => {
    const candidate = objectValue(candidateValue, `${path}[${index}]`)
    exactKeys(candidate, ['index', 'hash'], [], `${path}[${index}]`)
    const candidateIndex = integerValue(candidate.index, `${path}[${index}].index`)
    if (candidateIndex !== index) throw new Error(`${path}[${index}].index must be contiguous from 0`)
    nonEmptyString(candidate.hash, `${path}[${index}].hash`)
  })
}

function assertAddVoiceResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'error') return assertErrorMessage(record)
  if (status === 'aborted') return assertStatusOnly(record, status)
  if (status === 'awaiting_user_response') {
    exactKeys(record, ['status', 'candidates'], ['voice_id'], 'result')
    assertCandidateArray(record.candidates, 'result.candidates', 8)
    optionalString(record.voice_id, 'result.voice_id')
    return
  }
  if (status !== 'completed') throw new Error('result.status is unsupported')
  exactKeys(record, ['status', 'candidates', 'selected_index'], [
    'voice_id', 'selection_method', 'play_counts', 'listen_seconds',
  ], 'result')
  assertCandidateArray(record.candidates, 'result.candidates', 8)
  nonNegativeInteger(record.selected_index, 'result.selected_index')
  optionalString(record.voice_id, 'result.voice_id')
  optionalEnum(record.selection_method, ['user', 'auto', 'skip'], 'result.selection_method')
  for (const field of ['play_counts', 'listen_seconds'] as const) {
    if (record[field] !== undefined) {
      const values = arrayValue(record[field], `result.${field}`)
      if (values.length > 8) throw new Error(`result.${field} must contain at most 8 items`)
      values.forEach((value, index) => numberValue(value, `result.${field}[${index}]`))
    }
  }
}

function assertAskUserResult(record: Record<string, unknown>): void {
  exactKeys(record, ['skipped', 'answers'], [], 'result')
  booleanValue(record.skipped, 'result.skipped')
  const answers = arrayValue(record.answers, 'result.answers')
  if (record.skipped === true && answers.length !== 0) throw new Error('result.answers must be empty when skipped is true')
  if (record.skipped === false && (answers.length < 1 || answers.length > 6)) throw new Error('result.answers must contain 1-6 answers')
  answers.forEach((answerValue, index) => {
    const answer = objectValue(answerValue, `result.answers[${index}]`)
    exactKeys(answer, ['questionId', 'selectedOptionId', 'customResponse'], [], `result.answers[${index}]`)
    nonEmptyString(answer.questionId, `result.answers[${index}].questionId`)
    nullableNonEmptyString(answer.selectedOptionId, `result.answers[${index}].selectedOptionId`)
    nullableNonEmptyString(answer.customResponse, `result.answers[${index}].customResponse`, 2_000)
  })
}

function assertBashResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'aborted' && Object.keys(record).length === 1) return assertStatusOnly(record, status)
  exactKeys(record, [
    'stdout', 'stdout_truncated', 'stderr', 'stderr_truncated', 'exit_code', 'status', 'duration_ms',
  ], [], 'result')
  stringValue(record.stdout, 'result.stdout')
  booleanValue(record.stdout_truncated, 'result.stdout_truncated')
  stringValue(record.stderr, 'result.stderr')
  booleanValue(record.stderr_truncated, 'result.stderr_truncated')
  nullableInteger(record.exit_code, 'result.exit_code')
  enumValue(status, ['running', 'completed', 'timeout', 'killed', 'shell_error', 'aborted'], 'result.status')
  nonNegativeInteger(record.duration_ms, 'result.duration_ms')
}

function assertCompactResult(record: Record<string, unknown>): void {
  exactKeys(record, ['summary'], ['summarizeUsage', 'tokensAtCompaction', 'ratio'], 'result')
  stringValue(record.summary, 'result.summary')
  if (record.summarizeUsage !== undefined) {
    const usage = objectValue(record.summarizeUsage, 'result.summarizeUsage')
    exactKeys(usage, [], ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'], 'result.summarizeUsage')
    Object.entries(usage).forEach(([field, value]) => numberValue(value, `result.summarizeUsage.${field}`))
  }
  if (record.tokensAtCompaction !== undefined) nonNegativeInteger(record.tokensAtCompaction, 'result.tokensAtCompaction')
  optionalNumber(record.ratio, 'result.ratio')
}

function assertMutationResult(record: Record<string, unknown>, edit: boolean): void {
  const status = statusOf(record)
  if (status === 'error') return assertErrorMessage(record)
  if (status === 'aborted') return assertStatusOnly(record, status)
  if (status !== 'success') throw new Error('result.status must be success, error, or aborted')
  exactKeys(record, edit ? ['status', 'message', 'hash'] : ['status', 'hash'], [], 'result')
  if (edit) stringValue(record.message, 'result.message')
  stringValue(record.hash, 'result.hash')
}

function assertFetchPageResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'error') {
    exactKeys(record, ['status', 'error'], [], 'result')
    stringValue(record.error, 'result.error')
    return
  }
  if (status === 'aborted') return assertStatusOnly(record, status)
  if (status !== 'success') throw new Error('result.status must be success, error, or aborted')
  exactKeys(record, ['status', 'url', 'title', 'content', 'chunkIndex', 'hasMore'], ['totalChunks'], 'result')
  for (const field of ['url', 'title', 'content'] as const) stringValue(record[field], `result.${field}`)
  nonNegativeInteger(record.chunkIndex, 'result.chunkIndex')
  booleanValue(record.hasMore, 'result.hasMore')
  if (record.totalChunks !== undefined && positiveInteger(record.totalChunks, 'result.totalChunks') < 1) throw new Error('result.totalChunks must be positive')
}

function assertGenerateImageResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'error') return assertErrorMessage(record)
  if (status === 'aborted') return assertStatusOnly(record, status)
  if (status === 'success') {
    exactKeys(record, ['status', 'hash', 'file_path'], [], 'result')
    stringValue(record.hash, 'result.hash')
    stringValue(record.file_path, 'result.file_path')
    return
  }
  if (status === 'awaiting_user_response') {
    exactKeys(record, ['status', 'candidates'], [], 'result')
    assertCandidateArray(record.candidates, 'result.candidates', 16)
    return
  }
  if (status !== 'completed') throw new Error('result.status is unsupported')
  exactKeys(record, ['status', 'candidates', 'selected_index', 'file_path', 'selection_method'], [], 'result')
  assertCandidateArray(record.candidates, 'result.candidates', 16)
  nonNegativeInteger(record.selected_index, 'result.selected_index')
  stringValue(record.file_path, 'result.file_path')
  enumValue(record.selection_method, ['user', 'skip'], 'result.selection_method')
}

function assertGenerateSpeechResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'error') return assertErrorMessage(record)
  if (status === 'aborted') return assertStatusOnly(record, status)
  if (status !== 'success') throw new Error('result.status must be success, error, or aborted')
  exactKeys(record, ['status', 'hash', 'file_path'], ['attribution'], 'result')
  stringValue(record.hash, 'result.hash')
  stringValue(record.file_path, 'result.file_path')
  if (record.attribution !== undefined) {
    const attribution = objectValue(record.attribution, 'result.attribution')
    exactKeys(attribution, ['provider', 'model', 'system', 'voice_id', 'voice_name', 'language', 'locale_match'], [
      'locale', 'provider_locale', 'loudness_lufs',
    ], 'result.attribution')
    for (const field of ['provider', 'model', 'system', 'voice_id', 'voice_name', 'language', 'locale_match'] as const) {
      stringValue(attribution[field], `result.attribution.${field}`)
    }
    optionalString(attribution.locale, 'result.attribution.locale')
    optionalString(attribution.provider_locale, 'result.attribution.provider_locale')
    optionalNumber(attribution.loudness_lufs, 'result.attribution.loudness_lufs')
  }
}

function assertPortArray(value: unknown, path: string): void {
  arrayValue(value, path).forEach((portValue, index) => {
    const port = objectValue(portValue, `${path}[${index}]`)
    exactKeys(port, ['port', 'address'], [], `${path}[${index}]`)
    const number = integerValue(port.port, `${path}[${index}].port`)
    if (number < 1 || number > 65_535) throw new Error(`${path}[${index}].port must be between 1 and 65535`)
    stringValue(port.address, `${path}[${index}].address`)
  })
}

function assertGetProcessOutputResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'aborted') return assertStatusOnly(record, status)
  enumValue(status, ['running', 'exited', 'not_found', 'shell_error'], 'result.status')
  exactKeys(record, ['status', 'exit_code', 'log_tail', 'listening_ports'], ['wait_result'], 'result')
  nullableInteger(record.exit_code, 'result.exit_code')
  stringValue(record.log_tail, 'result.log_tail')
  assertPortArray(record.listening_ports, 'result.listening_ports')
  optionalEnum(record.wait_result, ['satisfied', 'timeout', 'process_exited'], 'result.wait_result')
}

function assertImageSearchResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'error') return assertErrorMessage(record)
  if (status === 'aborted') return assertStatusOnly(record, status)
  if (status !== 'success') throw new Error('result.status must be success, error, or aborted')
  exactKeys(record, ['status', 'results'], [], 'result')
  arrayValue(record.results, 'result.results').forEach((value, index) => {
    const image = objectValue(value, `result.results[${index}]`)
    exactKeys(image, ['file_path', 'hash', 'thumbnail_url', 'title', 'source_url'], [], `result.results[${index}]`)
    for (const field of ['file_path', 'hash', 'thumbnail_url', 'title', 'source_url'] as const) stringValue(image[field], `result.results[${index}].${field}`)
  })
}

function assertConnectorResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'aborted' || status === 'unsupported') return assertStatusOnly(record, status)
  if (status === 'enabled') {
    exactKeys(record, ['status', 'connector', 'tools'], [], 'result')
    boundedString(record.connector, 'result.connector', 100)
    const tools = arrayValue(record.tools, 'result.tools')
    if (tools.length > 100) throw new Error('result.tools must contain at most 100 tools')
    tools.forEach((toolValue, index) => {
      const tool = objectValue(toolValue, `result.tools[${index}]`)
      exactKeys(tool, ['name', 'description'], [], `result.tools[${index}]`)
      boundedString(tool.name, `result.tools[${index}].name`, 100)
      boundedString(tool.description, `result.tools[${index}].description`, 400)
    })
    return
  }
  if (status === 'disconnected' || status === 'disabled') {
    exactKeys(record, ['status', 'connector'], [], 'result')
    boundedString(record.connector, 'result.connector', 100)
    return
  }
  enumValue(status, ['unavailable', 'catalog_error', 'tools_error', 'database_error', 'internal_error'], 'result.status')
  exactKeys(record, ['status', 'message'], [], 'result')
  boundedString(record.message, 'result.message', 200)
}

function assertActiveListFilesResult(record: Record<string, unknown>): void {
  if (record.status === 'error') return assertErrorMessage(record)
  exactKeys(record, ['files'], [], 'result')
  arrayValue(record.files, 'result.files').forEach((value, index) => {
    const file = objectValue(value, `result.files[${index}]`)
    exactKeys(file, ['path'], ['size'], `result.files[${index}]`)
    stringValue(file.path, `result.files[${index}].path`)
    optionalString(file.size, `result.files[${index}].size`)
  })
}

function assertPresentFileResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'error') return assertErrorMessage(record)
  if (status !== 'success') throw new Error('result.status must be success or error')
  // The local presenter binds publication to the exact bytes that were
  // opened. Keep the legacy two-field success variant readable for recovered
  // Arena histories, while admitting and validating the stronger attestation
  // emitted by the current runtime.
  exactKeys(record, ['status', 'path'], ['artifact_hash', 'bytes'], 'result')
  stringValue(record.path, 'result.path')
  if (record.artifact_hash !== undefined) boundedString(record.artifact_hash, 'result.artifact_hash', 128)
  if (record.bytes !== undefined) nonNegativeInteger(record.bytes, 'result.bytes')
}

function assertProposePlanResult(record: Record<string, unknown>): void {
  if ('decision' in record) {
    exactKeys(record, ['decision'], [], 'result')
    enumValue(record.decision, ['accepted', 'revise', 'rejected', 'no_decision'], 'result.decision')
    return
  }
  const status = statusOf(record)
  if (status === 'error') return assertErrorMessage(record)
  if (status === 'awaiting_user_response' || status === 'aborted') return assertStatusOnly(record, status)
  throw new Error('result must contain a plan decision or supported status')
}

function assertActiveReadFileResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'error') return assertErrorMessage(record)
  if (status !== 'success') throw new Error('result.status must be success or error')
  const kind = stringValue(record.kind, 'result.kind')
  if (kind === 'text') {
    exactKeys(record, ['status', 'kind', 'size', 'lines', 'content'], [
      'truncated', 'offset', 'returnedLines', 'hasMore', 'contentOffset', 'nextContentOffset', 'nextOffset', 'truncatedBy',
    ], 'result')
    nonNegativeInteger(record.size, 'result.size')
    nonNegativeInteger(record.lines, 'result.lines')
    stringValue(record.content, 'result.content')
    if (record.truncated !== undefined) booleanValue(record.truncated, 'result.truncated')
    const paginationFields = [
      'offset', 'returnedLines', 'hasMore', 'contentOffset', 'nextContentOffset', 'nextOffset', 'truncatedBy',
    ]
      .filter((field) => record[field] !== undefined)
    if (paginationFields.length > 0) {
      positiveInteger(record.offset, 'result.offset')
      const returnedLines = nonNegativeInteger(record.returnedLines, 'result.returnedLines')
      booleanValue(record.hasMore, 'result.hasMore')
      const contentOffset = record.contentOffset === undefined
        ? undefined
        : nonNegativeInteger(record.contentOffset, 'result.contentOffset')
      if (record.nextContentOffset !== undefined && contentOffset === undefined) {
        throw new Error('result.nextContentOffset requires result.contentOffset')
      }
      if (record.hasMore === true) {
        const hasNextOffset = record.nextOffset !== undefined
        const hasNextContentOffset = record.nextContentOffset !== undefined
        if (hasNextOffset === hasNextContentOffset) {
          throw new Error('continuing read_file page must contain exactly one of result.nextOffset or result.nextContentOffset')
        }
        if (hasNextOffset) {
          const nextOffset = positiveInteger(record.nextOffset, 'result.nextOffset')
          if (nextOffset <= Number(record.offset)) throw new Error('result.nextOffset must advance beyond result.offset')
        } else {
          const nextContentOffset = nonNegativeInteger(record.nextContentOffset, 'result.nextContentOffset')
          if (nextContentOffset <= Number(contentOffset)) {
            throw new Error('result.nextContentOffset must advance beyond result.contentOffset')
          }
          if (returnedLines !== 0) throw new Error('partial-line read_file page must report zero returnedLines')
        }
        if (record.truncated !== true) throw new Error('result.truncated must be true when result.hasMore is true')
      } else if (
        record.nextOffset !== undefined
        || record.nextContentOffset !== undefined
        || record.truncatedBy !== undefined
        || record.truncated === true
      ) {
        throw new Error('terminal read_file page cannot contain continuation fields')
      }
      if (record.truncatedBy !== undefined) enumValue(record.truncatedBy, ['lines', 'bytes'], 'result.truncatedBy')
    }
    return
  }
  if (kind === 'image') {
    exactKeys(record, ['status', 'kind', 'mediaType', 'size', 'data'], ['width', 'height'], 'result')
    stringValue(record.mediaType, 'result.mediaType')
    nonNegativeInteger(record.size, 'result.size')
    stringValue(record.data, 'result.data')
    if (record.width !== undefined) positiveInteger(record.width, 'result.width')
    if (record.height !== undefined) positiveInteger(record.height, 'result.height')
    return
  }
  if (kind === 'unsupported') {
    exactKeys(record, ['status', 'kind', 'mediaType', 'size'], [], 'result')
    stringValue(record.mediaType, 'result.mediaType')
    nonNegativeInteger(record.size, 'result.size')
    return
  }
  throw new Error('result.kind must be text, image, or unsupported')
}

function assertStartProcessResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'aborted') return assertStatusOnly(record, status)
  enumValue(status, ['running', 'exited', 'shell_error'], 'result.status')
  exactKeys(record, [
    'status', 'process_id', 'pid', 'exit_code', 'log_tail', 'listening_ports', 'new_ports', 'duration_ms',
  ], ['warnings'], 'result')
  nullableString(record.process_id, 'result.process_id')
  nullableInteger(record.pid, 'result.pid')
  nullableInteger(record.exit_code, 'result.exit_code')
  stringValue(record.log_tail, 'result.log_tail')
  assertPortArray(record.listening_ports, 'result.listening_ports')
  assertPortArray(record.new_ports, 'result.new_ports')
  nonNegativeInteger(record.duration_ms, 'result.duration_ms')
  if (record.warnings !== undefined) stringArray(record.warnings, 'result.warnings')
}

function assertStopProcessResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'aborted') return assertStatusOnly(record, status)
  enumValue(status, ['stopped', 'already_exited', 'not_found', 'shell_error'], 'result.status')
  exactKeys(record, ['status', 'log_tail'], [], 'result')
  stringValue(record.log_tail, 'result.log_tail')
}

function assertActiveWebSearchResult(record: Record<string, unknown>): void {
  const status = statusOf(record)
  if (status === 'error') {
    exactKeys(record, ['status', 'error'], [], 'result')
    stringValue(record.error, 'result.error')
    return
  }
  if (status === 'aborted') return assertStatusOnly(record, status)
  if (status !== 'success') throw new Error('result.status must be success, error, or aborted')
  exactKeys(record, ['status', 'results'], [], 'result')
  arrayValue(record.results, 'result.results').forEach(assertSearchResult)
}

export function assertArenaPublicToolResult(toolName: string, result: ToolExecutionResult): void {
  if (!PUBLIC_RESULT_TOOLS.has(toolName)) return
  let payload: unknown
  try {
    payload = JSON.parse(result.content)
  } catch {
    throw new Error('result content is not valid JSON')
  }
  const record = objectValue(payload, 'result')
  const status = stringValue(record.status, 'result.status')
  if (status === 'error') {
    if (!result.isError) throw new Error('status is error but isError is false')
    assertErrorResult(toolName, record)
    return
  }
  if (status !== 'success') throw new Error('result.status must be success or error')
  if (result.isError) throw new Error('status is success but isError is true')
  assertSuccessResult(toolName, record)
}

function assertErrorResult(toolName: string, record: Record<string, unknown>): void {
  const optional = toolName === 'build_and_start'
    ? [...ARENA_PUBLIC_COMMON_ERROR_RESULT_FIELDS.slice(2), ...ARENA_PUBLIC_TOOL_ERROR_EXTENSION_FIELDS.build_and_start]
    : ['stdout', 'stderr']
  exactKeys(record, ['status', 'message'], optional, 'result')
  literalValue(record.status, 'error', 'result.status')
  stringValue(record.message, 'result.message')
  optional.forEach((field) => optionalString(record[field], `result.${field}`))
}

function assertSuccessResult(toolName: string, record: Record<string, unknown>): void {
  literalValue(record.status, 'success', 'result.status')
  switch (toolName) {
    case 'create_file':
      exactKeys(record, ['status', 'message'], ['lint_error'], 'result')
      stringValue(record.message, 'result.message')
      optionalString(record.lint_error, 'result.lint_error')
      return
    case 'edit_file':
      exactKeys(record, ['status'], ['message', 'match_type', 'matched_text', 'lint_error'], 'result')
      optionalString(record.message, 'result.message')
      if (record.match_type !== undefined && !['exact', 'fuzzy'].includes(String(record.match_type))) throw new Error('result.match_type must be exact or fuzzy')
      optionalString(record.matched_text, 'result.matched_text')
      optionalString(record.lint_error, 'result.lint_error')
      return
    case 'read_file': {
      exactKeys(record, ['status', 'file'], ['totalLines', 'image'], 'result')
      const file = objectValue(record.file, 'result.file')
      exactKeys(file, ['path', 'content', 'contentType'], [], 'result.file')
      stringValue(file.path, 'result.file.path')
      stringValue(file.content, 'result.file.content')
      const contentType = stringValue(file.contentType, 'result.file.contentType')
      if (!WEBDEV_CONTENT_TYPES.has(contentType)) throw new Error(`result.file.contentType is unsupported: ${contentType}`)
      optionalNumber(record.totalLines, 'result.totalLines')
      if (record.image !== undefined) {
        const image = objectValue(record.image, 'result.image')
        exactKeys(image, ['mediaType', 'sizeBytes'], [], 'result.image')
        stringValue(image.mediaType, 'result.image.mediaType')
        numberValue(image.sizeBytes, 'result.image.sizeBytes')
      }
      return
    }
    case 'list_files':
      exactKeys(record, ['status', 'files'], [], 'result')
      arrayValue(record.files, 'result.files').forEach((value, index) => {
        const file = objectValue(value, `result.files[${index}]`)
        exactKeys(file, ['path'], [], `result.files[${index}]`)
        stringValue(file.path, `result.files[${index}].path`)
      })
      return
    case 'delete_file':
    case 'deploy_project':
    case 'update_plan':
      exactKeys(record, ['status'], [], 'result')
      return
    case 'install_npm_packages':
    case 'bash':
    case 'shell_command':
      exactKeys(record, ['status'], ['stdout', 'stderr'], 'result')
      optionalString(record.stdout, 'result.stdout')
      optionalString(record.stderr, 'result.stderr')
      return
    case 'build_project':
      exactKeys(record, ['status', 'stdout', 'stderr'], [], 'result')
      stringValue(record.stdout, 'result.stdout')
      stringValue(record.stderr, 'result.stderr')
      return
    case 'build_and_start':
      exactKeys(record, ['status', 'previewUrl', 'buildLatencyMs'], [], 'result')
      stringValue(record.previewUrl, 'result.previewUrl')
      numberValue(record.buildLatencyMs, 'result.buildLatencyMs')
      return
    case 'apply_patch':
      exactKeys(record, ['status', 'message'], ['lint_error'], 'result')
      stringValue(record.message, 'result.message')
      optionalString(record.lint_error, 'result.lint_error')
      return
    case 'grep_files':
      assertGrepResult(record)
      return
    case 'glob_files':
      exactKeys(record, ['status', 'paths', 'truncated'], [], 'result')
      stringArray(record.paths, 'result.paths')
      booleanValue(record.truncated, 'result.truncated')
      return
    case 'web_search':
      exactKeys(record, ['status', 'results'], [], 'result')
      arrayValue(record.results, 'result.results').forEach(assertSearchResult)
      return
    case 'web_fetch':
      exactKeys(record, ['status', 'title', 'content'], [], 'result')
      stringValue(record.title, 'result.title')
      stringValue(record.content, 'result.content')
      return
    case 'fetch_media':
      assertMediaResult(record)
      return
    case 'generate_image':
      exactKeys(record, ['status', 'message'], [], 'result')
      stringValue(record.message, 'result.message')
      return
    default:
      throw new Error(`no success validator exists for ${toolName}`)
  }
}

function assertGrepResult(record: Record<string, unknown>): void {
  const mode = stringValue(record.mode, 'result.mode')
  if (mode === 'content') {
    exactKeys(record, ['status', 'mode', 'matches', 'truncated'], [], 'result')
    arrayValue(record.matches, 'result.matches').forEach((value, index) => {
      const match = objectValue(value, `result.matches[${index}]`)
      exactKeys(match, ['path', 'lineNumber', 'lineContent'], ['contextBefore', 'contextAfter'], `result.matches[${index}]`)
      stringValue(match.path, `result.matches[${index}].path`)
      numberValue(match.lineNumber, `result.matches[${index}].lineNumber`)
      stringValue(match.lineContent, `result.matches[${index}].lineContent`)
      if (match.contextBefore !== undefined) stringArray(match.contextBefore, `result.matches[${index}].contextBefore`)
      if (match.contextAfter !== undefined) stringArray(match.contextAfter, `result.matches[${index}].contextAfter`)
    })
  } else if (mode === 'files_with_matches') {
    exactKeys(record, ['status', 'mode', 'files', 'truncated'], [], 'result')
    stringArray(record.files, 'result.files')
  } else if (mode === 'count') {
    exactKeys(record, ['status', 'mode', 'counts', 'totalMatches', 'truncated'], [], 'result')
    arrayValue(record.counts, 'result.counts').forEach((value, index) => {
      const count = objectValue(value, `result.counts[${index}]`)
      exactKeys(count, ['path', 'count'], [], `result.counts[${index}]`)
      stringValue(count.path, `result.counts[${index}].path`)
      numberValue(count.count, `result.counts[${index}].count`)
    })
    numberValue(record.totalMatches, 'result.totalMatches')
  } else {
    throw new Error('result.mode must be content, files_with_matches, or count')
  }
  booleanValue(record.truncated, 'result.truncated')
}

function assertSearchResult(value: unknown, index: number): void {
  const result = objectValue(value, `result.results[${index}]`)
  exactKeys(result, ['id', 'title', 'url', 'description'], ['pageAge'], `result.results[${index}]`)
  numberValue(result.id, `result.results[${index}].id`)
  stringValue(result.title, `result.results[${index}].title`)
  stringValue(result.url, `result.results[${index}].url`)
  stringValue(result.description, `result.results[${index}].description`)
  optionalString(result.pageAge, `result.results[${index}].pageAge`)
}

function assertMediaResult(record: Record<string, unknown>): void {
  exactKeys(record, ['status', 'query', 'mediaType', 'totalResults', 'results'], [], 'result')
  stringValue(record.query, 'result.query')
  if (!['image', 'video', 'both'].includes(String(record.mediaType))) throw new Error('result.mediaType must be image, video, or both')
  numberValue(record.totalResults, 'result.totalResults')
  arrayValue(record.results, 'result.results').forEach((value, index) => {
    const media = objectValue(value, `result.results[${index}]`)
    exactKeys(media, ['type', 'id', 'pexelsUrl', 'recommendedUrl'], [
      'thumbnailUrl', 'width', 'height', 'creatorName', 'creatorUrl', 'alt', 'duration', 'videoFile',
    ], `result.results[${index}]`)
    if (!['image', 'video'].includes(String(media.type))) throw new Error(`result.results[${index}].type must be image or video`)
    numberValue(media.id, `result.results[${index}].id`)
    stringValue(media.pexelsUrl, `result.results[${index}].pexelsUrl`)
    stringValue(media.recommendedUrl, `result.results[${index}].recommendedUrl`)
    for (const field of ['thumbnailUrl', 'creatorName', 'creatorUrl', 'alt'] as const) optionalString(media[field], `result.results[${index}].${field}`)
    for (const field of ['width', 'height', 'duration'] as const) optionalNumber(media[field], `result.results[${index}].${field}`)
    if (media.videoFile !== undefined) {
      const file = objectValue(media.videoFile, `result.results[${index}].videoFile`)
      exactKeys(file, ['url'], ['width', 'height', 'quality', 'fileType'], `result.results[${index}].videoFile`)
      stringValue(file.url, `result.results[${index}].videoFile.url`)
      optionalNumber(file.width, `result.results[${index}].videoFile.width`)
      optionalNumber(file.height, `result.results[${index}].videoFile.height`)
      optionalString(file.quality, `result.results[${index}].videoFile.quality`)
      optionalString(file.fileType, `result.results[${index}].videoFile.fileType`)
    }
  })
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  const allowed = new Set([...required, ...optional])
  const missing = required.filter((key) => !(key in record))
  const extra = Object.keys(record).filter((key) => !allowed.has(key))
  if (missing.length > 0) throw new Error(`${path} is missing ${missing.join(', ')}`)
  if (extra.length > 0) throw new Error(`${path} has unexpected ${extra.join(', ')}`)
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as Record<string, unknown>
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  return value
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) stringValue(value, path)
}

function nonEmptyString(value: unknown, path: string): string {
  const parsed = stringValue(value, path)
  if (parsed.length < 1) throw new Error(`${path} must be non-empty`)
  return parsed
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  const parsed = stringValue(value, path)
  if (parsed.length > maxLength) throw new Error(`${path} must contain at most ${maxLength} characters`)
  return parsed
}

function nullableString(value: unknown, path: string): void {
  if (value !== null) stringValue(value, path)
}

function nullableNonEmptyString(value: unknown, path: string, maxLength?: number): void {
  if (value === null) return
  const parsed = nonEmptyString(value, path)
  if (maxLength !== undefined && parsed.length > maxLength) throw new Error(`${path} must contain at most ${maxLength} characters`)
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`)
  return value
}

function optionalNumber(value: unknown, path: string): void {
  if (value !== undefined) numberValue(value, path)
}

function integerValue(value: unknown, path: string): number {
  const parsed = numberValue(value, path)
  if (!Number.isInteger(parsed)) throw new Error(`${path} must be an integer`)
  return parsed
}

function nonNegativeInteger(value: unknown, path: string): number {
  const parsed = integerValue(value, path)
  if (parsed < 0) throw new Error(`${path} must be non-negative`)
  return parsed
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = integerValue(value, path)
  if (parsed <= 0) throw new Error(`${path} must be positive`)
  return parsed
}

function nullableInteger(value: unknown, path: string): void {
  if (value !== null) integerValue(value, path)
}

function booleanValue(value: unknown, path: string): void {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
}

function stringArray(value: unknown, path: string): void {
  arrayValue(value, path).forEach((item, index) => stringValue(item, `${path}[${index}]`))
}

function literalValue(value: unknown, literal: string, path: string): void {
  if (value !== literal) throw new Error(`${path} must be ${literal}`)
}

function enumValue(value: unknown, allowed: readonly string[], path: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${path} must be one of ${allowed.join(', ')}`)
}

function optionalEnum(value: unknown, allowed: readonly string[], path: string): void {
  if (value !== undefined) enumValue(value, allowed, path)
}
