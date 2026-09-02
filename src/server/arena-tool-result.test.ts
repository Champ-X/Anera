import { describe, expect, it } from 'vitest'
import {
  ARENA_ACTIVE_RESULT_TOOL_NAMES,
  ARENA_PUBLIC_RESULT_TOOL_NAMES,
  arenaToolErrorResult,
  assertAneraRuntimeToolResult,
  assertArenaActiveToolResult,
  assertArenaPublicToolResult,
  enforceArenaPublicToolResult,
  enforceAneraRuntimeToolResult,
} from './arena-tool-result.js'

const activeSuccesses: Record<string, Record<string, unknown>> = {
  add_voice: {
    status: 'completed', candidates: [{ index: 0, hash: 'voice-a' }, { index: 1, hash: 'voice-b' }],
    selected_index: 1, voice_id: 'voice-00', selection_method: 'user', play_counts: [1, 2], listen_seconds: [1.5, 3],
  },
  ask_user: {
    skipped: false,
    answers: [{ questionId: 'format', selectedOptionId: 'markdown', customResponse: null }],
  },
  bash: {
    stdout: 'ok', stdout_truncated: false, stderr: '', stderr_truncated: false,
    exit_code: 0, status: 'completed', duration_ms: 15,
  },
  compact: {
    summary: 'Checkpoint', summarizeUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    tokensAtCompaction: 2_000, ratio: 0.4,
  },
  edit_file: { status: 'success', message: 'Edited notes.md.', hash: 'edit-hash' },
  fetch_page: {
    status: 'success', url: 'https://example.com', title: 'Example', content: '# Example',
    chunkIndex: 0, hasMore: false, totalChunks: 1,
  },
  generate_image: { status: 'success', hash: 'image-hash', file_path: 'images/hero.png' },
  generate_speech: {
    status: 'success', hash: 'audio-hash', file_path: 'audio/voice.mp3',
    attribution: {
      provider: 'provider', model: 'model', system: 'system', voice_id: 'voice-00', voice_name: 'Voice',
      language: 'en', locale_match: 'exact', loudness_lufs: -16,
    },
  },
  get_process_output: {
    status: 'running', exit_code: null, log_tail: 'ready',
    listening_ports: [{ port: 3000, address: '0.0.0.0' }], wait_result: 'satisfied',
  },
  image_search: {
    status: 'success',
    results: [{ file_path: 'images/result.jpg', hash: 'search-hash', thumbnail_url: 'https://img.example/t.jpg', title: 'Result', source_url: 'https://example.com/result' }],
  },
  list_connector_tools: {
    status: 'enabled', connector: 'github', tools: [{ name: 'github_read_file', description: 'Read a file.' }],
  },
  list_files: { files: [{ path: 'notes.md', size: '12 B' }] },
  present_file: { status: 'success', path: 'notes.md', artifact_hash: 'present-hash', bytes: 12 },
  propose_plan: { decision: 'accepted' },
  read_file: { status: 'success', kind: 'text', size: 8, lines: 1, content: 'contents', truncated: false },
  start_process: {
    status: 'running', process_id: 'proc-1', pid: 123, exit_code: null, log_tail: 'ready',
    listening_ports: [{ port: 3000, address: '0.0.0.0' }],
    new_ports: [{ port: 3000, address: '0.0.0.0' }], duration_ms: 500, warnings: [],
  },
  stop_process: { status: 'stopped', log_tail: 'stopped' },
  web_search: {
    status: 'success', results: [{ id: 1, title: 'Result', url: 'https://example.com', description: 'Excerpt' }],
  },
  write_file: { status: 'success', hash: 'write-hash' },
}

const successes: Record<string, Record<string, unknown>> = {
  create_file: { status: 'success', message: 'Created index.html.' },
  edit_file: { status: 'success', message: 'Edited index.html.', match_type: 'fuzzy', matched_text: '<main>' },
  read_file: { status: 'success', file: { path: 'index.html', content: '<main />', contentType: 'text/html' }, totalLines: 1 },
  list_files: { status: 'success', files: [{ path: 'index.html' }] },
  delete_file: { status: 'success' },
  install_npm_packages: { status: 'success', stdout: 'added 1 package' },
  build_project: { status: 'success', stdout: 'built', stderr: '' },
  build_and_start: { status: 'success', previewUrl: '/workspace/session/preview/index.html', buildLatencyMs: 42 },
  deploy_project: { status: 'success' },
  apply_patch: { status: 'success', message: 'Applied patch.' },
  bash: { status: 'success', stdout: 'ok' },
  shell_command: { status: 'success', stderr: 'warning' },
  update_plan: { status: 'success' },
  grep_files: {
    status: 'success',
    mode: 'content',
    matches: [{ path: 'src/app.ts', lineNumber: 2, lineContent: 'TODO', contextBefore: ['one'], contextAfter: ['three'] }],
    truncated: false,
  },
  glob_files: { status: 'success', paths: ['src/app.ts'], truncated: false },
  web_search: { status: 'success', results: [{ id: 1, title: 'RFC', url: 'https://example.com', description: 'Reference', pageAge: '2 days ago' }] },
  web_fetch: { status: 'success', title: 'RFC', content: '# Reference' },
  fetch_media: {
    status: 'success',
    query: 'forest',
    mediaType: 'both',
    totalResults: 2,
    results: [
      { type: 'image', id: 1, pexelsUrl: 'https://pexels.example/1', recommendedUrl: 'https://images.example/1.jpg', width: 1200, height: 800 },
      { type: 'video', id: 2, pexelsUrl: 'https://pexels.example/2', recommendedUrl: 'https://videos.example/2.mp4', duration: 8, videoFile: { url: 'https://videos.example/2.mp4', quality: 'hd', fileType: 'video/mp4' } },
    ],
  },
  generate_image: { status: 'success', message: 'Generated assets/hero.png.' },
}

describe('Arena public tool-result protocol', () => {
  it('accepts one complete active success/completed variant for all 19 current tools', () => {
    expect(Object.keys(activeSuccesses)).toEqual(ARENA_ACTIVE_RESULT_TOOL_NAMES)
    for (const tool of ARENA_ACTIVE_RESULT_TOOL_NAMES) {
      expect(() => assertArenaActiveToolResult(tool, {
        content: JSON.stringify(activeSuccesses[tool]),
        isError: false,
      }), tool).not.toThrow()
    }
  })

  it('accepts the active awaiting, skipped, binary, process, error, and aborted unions', () => {
    const variants: Array<[string, Record<string, unknown>]> = [
      ['add_voice', { status: 'awaiting_user_response', candidates: [{ index: 0, hash: 'a' }] }],
      ['add_voice', { status: 'error', message: 'failed' }],
      ['add_voice', { status: 'aborted' }],
      ['ask_user', { skipped: true, answers: [] }],
      ['bash', { status: 'aborted' }],
      ['bash', { stdout: '', stdout_truncated: false, stderr: '', stderr_truncated: false, exit_code: null, status: 'timeout', duration_ms: 30_000 }],
      ['edit_file', { status: 'error', message: 'not found' }],
      ['fetch_page', { status: 'error', error: 'network' }],
      ['fetch_page', { status: 'aborted' }],
      ['generate_image', { status: 'awaiting_user_response', candidates: [{ index: 0, hash: 'a' }, { index: 1, hash: 'b' }] }],
      ['generate_image', { status: 'completed', candidates: [{ index: 0, hash: 'a' }], selected_index: 0, file_path: 'hero.png', selection_method: 'skip' }],
      ['generate_image', { status: 'error', message: 'failed' }],
      ['generate_speech', { status: 'aborted' }],
      ['get_process_output', { status: 'not_found', exit_code: null, log_tail: '', listening_ports: [] }],
      ['get_process_output', { status: 'aborted' }],
      ['image_search', { status: 'error', message: 'failed' }],
      ['list_connector_tools', { status: 'disconnected', connector: 'github' }],
      ['list_connector_tools', { status: 'disabled', connector: 'github' }],
      ['list_connector_tools', { status: 'unsupported' }],
      ['list_connector_tools', { status: 'internal_error', message: 'failed' }],
      ['list_connector_tools', { status: 'aborted' }],
      ['list_files', { status: 'error', message: 'failed' }],
      ['present_file', { status: 'error', message: 'missing' }],
      ['propose_plan', { status: 'awaiting_user_response' }],
      ['propose_plan', { decision: 'no_decision' }],
      ['propose_plan', { status: 'error', message: 'failed' }],
      ['propose_plan', { status: 'aborted' }],
      ['read_file', { status: 'success', kind: 'image', mediaType: 'image/png', size: 4, data: 'iVBORw==', width: 1, height: 1 }],
      ['read_file', { status: 'success', kind: 'unsupported', mediaType: 'application/pdf', size: 100 }],
      ['read_file', { status: 'error', message: 'missing' }],
      ['start_process', { status: 'shell_error', process_id: null, pid: null, exit_code: null, log_tail: 'failed', listening_ports: [], new_ports: [], duration_ms: 0 }],
      ['start_process', { status: 'aborted' }],
      ['stop_process', { status: 'not_found', log_tail: '' }],
      ['stop_process', { status: 'aborted' }],
      ['web_search', { status: 'error', error: 'failed' }],
      ['web_search', { status: 'aborted' }],
      ['write_file', { status: 'error', message: 'failed' }],
      ['write_file', { status: 'aborted' }],
    ]
    for (const [tool, payload] of variants) {
      expect(() => assertArenaActiveToolResult(tool, {
        content: JSON.stringify(payload),
        isError: ['error', 'aborted', 'shell_error'].includes(String(payload.status)),
      }), `${tool}: ${JSON.stringify(payload)}`).not.toThrow()
    }
  })

  it('rejects malformed active unions and fail-closes them into a valid tool-specific shape', () => {
    expect(() => assertArenaActiveToolResult('bash', {
      content: JSON.stringify({ status: 'completed', stdout: 'missing required fields' }), isError: false,
    })).toThrow(/missing/)
    expect(() => assertArenaActiveToolResult('generate_image', {
      content: JSON.stringify({ status: 'awaiting_user_response', candidates: [{ index: 1, hash: 'not-contiguous' }] }), isError: false,
    })).toThrow(/contiguous/)
    expect(() => assertArenaActiveToolResult('read_file', {
      content: JSON.stringify({ status: 'success', kind: 'image', mediaType: 'image/png', size: 1, data: 'x', width: 0 }), isError: false,
    })).toThrow(/positive/)
    expect(() => assertArenaActiveToolResult('ask_user', {
      content: JSON.stringify({ skipped: true, answers: [{ questionId: 'q', selectedOptionId: 'a', customResponse: null }] }), isError: false,
    })).toThrow(/must be empty/)
    expect(() => assertArenaActiveToolResult('present_file', {
      content: JSON.stringify({ status: 'success', path: 'notes.md', artifact_hash: 42, bytes: '12' }), isError: false,
    })).toThrow(/artifact_hash/)

    const enforced = enforceArenaPublicToolResult('bash', {
      content: JSON.stringify({ status: 'completed', stdout: 'invalid' }), isError: false,
    })
    expect(JSON.parse(enforced.content)).toMatchObject({ status: 'shell_error', exit_code: null, duration_ms: 0 })
    expect(enforced.isError).toBe(true)
    expect(() => assertArenaActiveToolResult('bash', enforced)).not.toThrow()

    const askFallback = enforceArenaPublicToolResult('ask_user', { content: '{broken', isError: true })
    expect(JSON.parse(askFallback.content)).toEqual({ skipped: true, answers: [] })
    expect(() => assertArenaActiveToolResult('ask_user', askFallback)).not.toThrow()
  })

  it('accepts an advancing Anera read_file page overlay and rejects ambiguous cursors', () => {
    const firstPage = {
      status: 'success', kind: 'text', size: 200_000, lines: 3_000,
      content: 'page one', offset: 1, returnedLines: 1_000, hasMore: true,
      nextOffset: 1_001, truncatedBy: 'lines', truncated: true,
    }
    expect(() => assertArenaActiveToolResult('read_file', {
      content: JSON.stringify(firstPage), isError: false,
    })).not.toThrow()
    expect(() => assertArenaActiveToolResult('read_file', {
      content: JSON.stringify({ ...firstPage, nextOffset: 1 }), isError: false,
    })).toThrow(/must advance/)
    expect(() => assertArenaActiveToolResult('read_file', {
      content: JSON.stringify({ ...firstPage, hasMore: false, nextOffset: undefined, truncatedBy: undefined }), isError: false,
    })).toThrow(/terminal read_file page/)

    const firstFragment = {
      status: 'success', kind: 'text', size: 200_000, lines: 2,
      content: 'line fragment', offset: 1, returnedLines: 0, hasMore: true,
      contentOffset: 0, nextContentOffset: 80_000, truncatedBy: 'bytes', truncated: true,
    }
    expect(() => assertArenaActiveToolResult('read_file', {
      content: JSON.stringify(firstFragment), isError: false,
    })).not.toThrow()
    expect(() => assertArenaActiveToolResult('read_file', {
      content: JSON.stringify({
        ...firstFragment,
        contentOffset: 80_000,
        nextContentOffset: undefined,
        nextOffset: 2,
        returnedLines: 1,
      }),
      isError: false,
    })).not.toThrow()
    expect(() => assertArenaActiveToolResult('read_file', {
      content: JSON.stringify({
        ...firstFragment,
        contentOffset: 160_000,
        nextContentOffset: undefined,
        hasMore: false,
        truncatedBy: undefined,
        truncated: undefined,
        returnedLines: 1,
      }),
      isError: false,
    })).not.toThrow()
    expect(() => assertArenaActiveToolResult('read_file', {
      content: JSON.stringify({ ...firstFragment, nextContentOffset: 0 }), isError: false,
    })).toThrow(/must advance/)
    expect(() => assertArenaActiveToolResult('read_file', {
      content: JSON.stringify({ ...firstFragment, contentOffset: undefined }), isError: false,
    })).toThrow(/requires result.contentOffset/)
    expect(() => assertArenaActiveToolResult('read_file', {
      content: JSON.stringify({ ...firstFragment, nextOffset: 2 }), isError: false,
    })).toThrow(/exactly one/)
    expect(() => assertArenaActiveToolResult('read_file', {
      content: JSON.stringify({ ...firstFragment, returnedLines: 1 }), isError: false,
    })).toThrow(/zero returnedLines/)
  })

  it('keeps the Arena list_files union frozen while enforcing Anera runtime pages separately', () => {
    const page = {
      files: [{ path: 'a.txt' }, { path: 'nested/b.txt' }],
      hasMore: true,
      nextCursor: 'opaque-next-cursor',
      truncated: false,
      totalFiles: 3,
    }
    const result = { content: JSON.stringify(page), isError: false }
    expect(() => assertArenaActiveToolResult('list_files', result)).toThrow(/unexpected/)
    expect(() => assertAneraRuntimeToolResult('list_files', result)).not.toThrow()
    expect(() => assertAneraRuntimeToolResult('list_files', {
      content: JSON.stringify({ ...page, hasMore: false }), isError: false,
    })).toThrow(/terminal/)
    const { nextCursor: _nextCursor, ...pageWithoutCursor } = page
    expect(() => assertAneraRuntimeToolResult('list_files', {
      content: JSON.stringify(pageWithoutCursor), isError: false,
    })).toThrow(/string/)
    expect(() => assertAneraRuntimeToolResult('list_files', {
      content: JSON.stringify({ ...page, nextCursor: '' }), isError: false,
    })).toThrow(/non-empty/)
    expect(() => assertAneraRuntimeToolResult('list_files', {
      content: JSON.stringify({ ...page, nextCursor: '   ' }), isError: false,
    })).toThrow(/non-empty/)
    expect(() => assertAneraRuntimeToolResult('list_files', {
      content: JSON.stringify({ ...page, hasMore: false, nextCursor: '' }), isError: false,
    })).toThrow(/terminal/)

    const enforced = enforceAneraRuntimeToolResult('list_files', {
      content: JSON.stringify({ ...page, totalFiles: 10_002 }), isError: false,
    })
    expect(enforced.isError).toBe(true)
    expect(JSON.parse(enforced.content)).toMatchObject({ status: 'error' })
    expect(() => assertArenaActiveToolResult('list_files', enforced)).not.toThrow()
  })

  it('accepts a complete success variant for every frozen public tool', () => {
    expect(Object.keys(successes).sort()).toEqual([...ARENA_PUBLIC_RESULT_TOOL_NAMES].sort())
    for (const tool of ARENA_PUBLIC_RESULT_TOOL_NAMES) {
      expect(() => assertArenaPublicToolResult(tool, {
        content: JSON.stringify(successes[tool]),
        isError: false,
      }), tool).not.toThrow()
    }
  })

  it('accepts every grep success union and the common error union', () => {
    for (const payload of [
      { status: 'success', mode: 'files_with_matches', files: ['a.ts'], truncated: false },
      { status: 'success', mode: 'count', counts: [{ path: 'a.ts', count: 3 }], totalMatches: 3, truncated: false },
    ]) {
      expect(() => assertArenaPublicToolResult('grep_files', { content: JSON.stringify(payload), isError: false })).not.toThrow()
    }
    for (const tool of ARENA_PUBLIC_RESULT_TOOL_NAMES) {
      const payload = tool === 'build_and_start'
        ? { status: 'error', message: 'Server failed', stdout: 'build output', stderr: 'failure', stage: 'starting-server', logTail: 'tail' }
        : { status: 'error', message: 'Synthetic failure', stdout: 'partial output', stderr: 'failure' }
      expect(() => assertArenaPublicToolResult(tool, { content: JSON.stringify(payload), isError: true }), tool).not.toThrow()
    }
  })

  it('creates a valid Harness-originated error union for every public tool and preserves private compatibility text', () => {
    for (const tool of ARENA_PUBLIC_RESULT_TOOL_NAMES) {
      const result = arenaToolErrorResult(tool, `Synthetic ${tool} failure`, {
        stdout: 'partial stdout',
        stderr: 'partial stderr',
        stage: 'starting-server',
        logTail: 'last line',
      })
      expect(() => assertArenaPublicToolResult(tool, result), tool).not.toThrow()
      expect(JSON.parse(result.content)).toEqual(tool === 'build_and_start'
        ? {
            status: 'error',
            message: `Synthetic ${tool} failure`,
            stdout: 'partial stdout',
            stderr: 'partial stderr',
            stage: 'starting-server',
            logTail: 'last line',
          }
        : {
            status: 'error',
            message: `Synthetic ${tool} failure`,
            stdout: 'partial stdout',
            stderr: 'partial stderr',
          })
    }
    expect(arenaToolErrorResult('browser', 'Private compatibility failure', { stderr: 'ignored' })).toEqual({
      content: 'Private compatibility failure',
      isError: true,
    })
  })

  it('rejects malformed status, nested fields, extra fields, and isError disagreement', () => {
    expect(() => assertArenaPublicToolResult('delete_file', { content: '{broken', isError: false })).toThrow(/valid JSON/)
    expect(() => assertArenaPublicToolResult('delete_file', { content: JSON.stringify({ status: 'success', extra: true }), isError: false })).toThrow(/unexpected extra/)
    expect(() => assertArenaPublicToolResult('build_project', { content: JSON.stringify({ status: 'success', stdout: 'ok' }), isError: false })).toThrow(/missing stderr/)
    expect(() => assertArenaPublicToolResult('read_file', {
      content: JSON.stringify({ status: 'success', file: { path: 'a.csv', content: 'a,b', contentType: 'text/csv' } }),
      isError: false,
    })).toThrow(/contentType is unsupported/)
    expect(() => assertArenaPublicToolResult('web_search', {
      content: JSON.stringify({ status: 'success', results: [{ id: 'one', title: 'T', url: 'U', description: 'D' }] }),
      isError: false,
    })).toThrow(/id must be a finite number/)
    expect(() => assertArenaPublicToolResult('generate_image', {
      content: JSON.stringify({ status: 'error', message: 'failed' }),
      isError: false,
    })).toThrow(/isError is false/)
  })

  it('converts a local malformed public result into the same common error union', () => {
    expect(enforceArenaPublicToolResult('build_project', {
      content: JSON.stringify({ status: 'success', stdout: 'missing stderr' }),
      isError: false,
    })).toEqual({
      content: JSON.stringify({
        status: 'error',
        message: 'Local result violated the Arena build_project contract: result is missing stderr',
      }),
      isError: true,
    })
    expect(enforceArenaPublicToolResult('browser', { content: 'legacy private result', isError: false })).toEqual({
      content: 'legacy private result',
      isError: false,
    })
  })
})
