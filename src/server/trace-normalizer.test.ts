import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionSummary } from '../shared/types.js'
import { canonicalStatus, canonicalToolName, normalizeAneraTrace, normalizeToolArguments, normalizeToolResult, traceToJsonl } from './trace-normalizer.js'

describe('Anera canonical trace normalizer', () => {
  it('preserves Arena Website asleep as a distinct observable lifecycle state', () => {
    expect(canonicalStatus('asleep')).toBe('asleep')
  })

  it('folds streaming noise, preserves parallel order, and normalizes dynamic values', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const at = (offset: number) => new Date(Date.parse('2026-08-28T00:00:00.000Z') + offset).toISOString()
    const events: SessionEvent[] = [
      event(1, 'session.created', { title: 'Probe' }, at(0), sessionId),
      event(2, 'turn.started', { content: 'Build it', attachments: [] }, at(10), sessionId, 'turn_11111111111111111111'),
      event(3, 'run.status', { status: 'running' }, at(20), sessionId, 'turn_11111111111111111111'),
      event(4, 'assistant.thought.started', { step: 1 }, at(30), sessionId, 'turn_11111111111111111111', 'step_11111111111111111111'),
      event(5, 'assistant.thought.delta', { delta: 'hidden transport chunk' }, at(35), sessionId, 'turn_11111111111111111111', 'step_11111111111111111111'),
      event(6, 'assistant.thought.completed', { text: 'I will inspect both inputs.' }, at(40), sessionId, 'turn_11111111111111111111', 'step_11111111111111111111'),
      event(7, 'tool.started', { call: { id: 'call_alpha_12345678', name: 'web_fetch', arguments: { url: 'https://example.com/a' } } }, at(50), sessionId, 'turn_11111111111111111111', 'step_11111111111111111111', 'call_alpha_12345678'),
      event(8, 'tool.started', { call: { id: 'call_beta_12345678', name: 'browser', arguments: { action: 'open', path: 'index.html' } } }, at(51), sessionId, 'turn_11111111111111111111', 'step_11111111111111111111', 'call_beta_12345678'),
      event(9, 'tool.completed', { call: { id: 'call_beta_12345678', name: 'browser', arguments: { action: 'open', path: 'index.html' } }, result: 'http://127.0.0.1:49123/workspace/ses_1234567890abcdefghij/preview/index.html', isError: false }, at(70), sessionId, 'turn_11111111111111111111', 'step_11111111111111111111', 'call_beta_12345678'),
      event(10, 'tool.completed', { call: { id: 'call_alpha_12345678', name: 'web_fetch', arguments: { url: 'https://example.com/a' } }, result: 'ok', isError: false }, at(80), sessionId, 'turn_11111111111111111111', 'step_11111111111111111111', 'call_alpha_12345678'),
      event(11, 'usage.updated', { usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 10, modelCalls: 1, toolCalls: 2, estimatedCostUsd: 0.001 } }, at(90), sessionId, 'turn_11111111111111111111'),
      event(12, 'assistant.final.delta', { delta: 'Done' }, at(95), sessionId, 'turn_11111111111111111111'),
      event(13, 'assistant.final', { content: 'Done at http://localhost:49123', finishReason: 'stop' }, at(100), sessionId, 'turn_11111111111111111111'),
      event(14, 'turn.completed', { status: 'completed' }, at(105), sessionId, 'turn_11111111111111111111'),
      event(15, 'run.status', { status: 'completed' }, at(110), sessionId, 'turn_11111111111111111111'),
    ]
    const summary: SessionSummary = {
      id: sessionId,
      title: 'Probe',
      createdAt: at(0),
      updatedAt: at(110),
      status: 'completed',
      model: 'deepseek-chat',
      workspaceBytes: 0,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 25, modelCalls: 1, toolCalls: 2, estimatedCostUsd: 0.001, durationMs: 100 },
    }

    const trace = normalizeAneraTrace({ events, summary, artifacts: [] })

    expect(trace.events.some((item) => item.action.endsWith('delta'))).toBe(false)
    const tools = trace.events.filter((item) => item.kind === 'tool')
    expect(tools.map((item) => [item.phase, item.tool?.callId])).toEqual([
      ['started', 'C01'],
      ['started', 'C02'],
      ['completed', 'C02'],
      ['completed', 'C01'],
    ])
    expect(tools[2].tool?.name).toBe('browser')
    expect(tools[2].tool?.operation).toBe('open')
    expect(String(tools[2].tool?.result)).toContain('127.0.0.1:<port>')
    expect(String(tools[2].tool?.result)).toContain('/workspace/<ses>/preview')
    expect(trace.outcome).toMatchObject({ status: 'succeeded', finalText: 'Done at http://localhost:<port>' })
    expect(trace.outcome.usage.totalTokens).toBe(120)
    expect(trace.outcome.usage.cachedTokens).toBe(25)
    expect(trace.outcome.usage.modelRequests).toBe(1)
    expect(trace.outcome.usage.estimatedCostStatus).toBe('estimated')
    expect(trace.events.find((item) => item.kind === 'usage')?.usage?.cachedTokens).toBe(10)
    expect(trace.events.find((item) => item.kind === 'usage')?.usage).toMatchObject({
      modelRequests: 1,
      modelCalls: 1,
      estimatedCostUsd: 0.001,
      estimatedCostStatus: 'estimated',
    })
    expect(trace.header.durationMs).toBe(100)
    const jsonl = traceToJsonl(trace)
    expect(jsonl.trim().split('\n')).toHaveLength(trace.events.length + 2)
    expect(jsonl).toContain('"modelRequests":1')
    expect(jsonl).toContain('"estimatedCostStatus":"estimated"')
  })

  it('keeps zero-cost unknown and partial request coverage attached to canonical usage', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const trace = normalizeAneraTrace({
      events: [
        event(1, 'usage.updated', {
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedPromptTokens: 0,
            modelRequests: 1,
            modelCalls: 0,
            toolCalls: 0,
            estimatedCostUsd: 0,
            estimatedCostStatus: 'unknown',
          },
        }, '2026-08-28T00:00:00.000Z', sessionId, 'turn_usage'),
        event(2, 'usage.updated', {
          usage: {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
            cachedPromptTokens: 0,
            modelRequests: 3,
            modelCalls: 2,
            toolCalls: 0,
            estimatedCostUsd: 0.001,
            estimatedCostStatus: 'partial',
          },
        }, '2026-08-28T00:00:01.000Z', sessionId, 'turn_usage'),
      ],
    })

    expect(trace.events.map((item) => item.usage)).toEqual([
      expect.objectContaining({ modelRequests: 1, modelCalls: 0, estimatedCostUsd: 0, estimatedCostStatus: 'unknown' }),
      expect.objectContaining({ modelRequests: 3, modelCalls: 2, estimatedCostUsd: 0.001, estimatedCostStatus: 'partial' }),
    ])
    expect(trace.outcome.usage).toMatchObject({
      modelRequests: 3,
      modelCalls: 2,
      estimatedCostUsd: 0.001,
      estimatedCostStatus: 'partial',
    })
    const records = traceToJsonl(trace).trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
    expect(records[1].event.usage).toMatchObject({ estimatedCostUsd: 0, estimatedCostStatus: 'unknown' })
    expect(records.at(-1)?.outcome.usage).toMatchObject({ modelRequests: 3, estimatedCostStatus: 'partial' })
  })

  it('keeps the session token limit as a distinct lifecycle failure', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const events: SessionEvent[] = [
      event(1, 'session.created', { title: 'Limit probe' }, '2026-08-28T00:00:00.000Z', sessionId),
      event(2, 'session.limit.reached', {
        code: 'session_token_limit',
        message: 'This session has reached its token usage limit. Please start a new chat to continue.',
        limit: { maxTokens: 100, usedTokens: 104, remainingTokens: 0, reached: true },
      }, '2026-08-28T00:00:01.000Z', sessionId, 'turn_limit'),
    ]
    const trace = normalizeAneraTrace({ events })
    expect(trace.events[1]).toMatchObject({
      actor: 'system_ui',
      kind: 'lifecycle',
      action: 'session_token_limit',
      phase: 'finalized',
      status: 'failed',
      message: 'This session has reached its token usage limit. Please start a new chat to continue.',
    })
  })

  it('keeps local provider accounting and model-repair diagnostics out of Arena parity event alignment', () => {
    const trace = normalizeAneraTrace({
      events: [
        event(1, 'provider.usage', {
          toolName: 'fetch_page',
          metering: {
            schemaVersion: 1,
            cache: 'hit',
            cacheProvider: 'firecrawl',
            providerCalls: 0,
            responseBytes: 0,
            requests: [],
            costUsd: null,
            costStatus: 'not_available',
          },
        }, '2026-08-28T00:00:00.000Z', 'ses_1234567890abcdefghij', 'turn_provider', 'step_provider', 'call_provider'),
        event(2, 'model.tool_call.repair', {
          reason: 'missing_required_tool_argument', attempt: 1, succeeded: true,
        }, '2026-08-28T00:00:00.100Z', 'ses_1234567890abcdefghij', 'turn_provider', 'step_provider'),
        event(3, 'model.final.repair', {
          reason: 'web_source_citation_integrity', attempt: 1, succeeded: true,
        }, '2026-08-28T00:00:00.200Z', 'ses_1234567890abcdefghij', 'turn_provider', 'step_provider'),
      ],
    })

    expect(trace.events).toEqual([])
    expect(trace.header.eventCount).toBe(0)
  })

  it('normalizes durable Workspace persistence as running updates and one succeeded finalization', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const turnId = 'turn_workspace_persistence'
    const stepId = 'step_workspace_persistence'
    const trace = normalizeAneraTrace({
      events: [
        event(1, 'workspace.persistence.started', {
          phase: 'scanning', label: 'Scanning workspace...', persistenceMode: 'local_durable',
        }, '2026-08-28T00:00:00.000Z', sessionId, turnId, stepId),
        event(2, 'workspace.persistence.updated', {
          phase: 'uploading', label: 'Uploading 0 workspace blobs...', blobCount: 0, persistenceMode: 'local_durable',
        }, '2026-08-28T00:00:00.100Z', sessionId, turnId, stepId),
        event(3, 'workspace.persistence.updated', {
          phase: 'saving', label: 'Saving workspace...', persistenceMode: 'local_durable',
        }, '2026-08-28T00:00:00.200Z', sessionId, turnId, stepId),
        event(4, 'workspace.persistence.completed', {
          phase: 'saved', label: 'Workspace saved', blobCount: 0, bytes: 589, fileCount: 2, persistenceMode: 'local_durable',
        }, '2026-08-28T00:00:00.300Z', sessionId, turnId, stepId),
      ],
    })

    expect(trace.events.map((item) => ({
      actor: item.actor,
      kind: item.kind,
      action: item.action,
      phase: item.phase,
      status: item.status,
      label: item.label,
      payload: item.payload,
    }))).toEqual([
      expect.objectContaining({ actor: 'system_ui', kind: 'workspace', action: 'updated', phase: 'updated', status: 'running', label: 'Scanning workspace...' }),
      expect.objectContaining({ actor: 'system_ui', kind: 'workspace', action: 'updated', phase: 'updated', status: 'running', label: 'Uploading 0 workspace blobs...', payload: expect.objectContaining({ phase: 'uploading', blobCount: 0, persistenceMode: 'local_durable' }) }),
      expect.objectContaining({ actor: 'system_ui', kind: 'workspace', action: 'updated', phase: 'updated', status: 'running', label: 'Saving workspace...' }),
      expect.objectContaining({ actor: 'system_ui', kind: 'workspace', action: 'updated', phase: 'finalized', status: 'succeeded', label: 'Workspace saved', payload: expect.objectContaining({ phase: 'saved', blobCount: 0, bytes: 589, fileCount: 2, persistenceMode: 'local_durable' }) }),
    ])
  })

  it('normalizes pointwise feedback and its clear action as operator actions', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const turnId = 'turn_feedback'
    const stepId = 'step_feedback'
    const events: SessionEvent[] = [
      event(1, 'assistant.final', { content: 'Result' }, '2026-08-28T00:00:00.000Z', sessionId, turnId, stepId),
      event(2, 'feedback.updated', {
        messageEventId: 'evt_00000000000000000001', value: 'upvote', model: 'fixture-model',
      }, '2026-08-28T00:00:01.000Z', sessionId, turnId, stepId),
      event(3, 'feedback.updated', {
        messageEventId: 'evt_00000000000000000001', value: 'downvote', model: 'fixture-model',
      }, '2026-08-28T00:00:02.000Z', sessionId, turnId, stepId),
      event(4, 'feedback.updated', {
        messageEventId: 'evt_00000000000000000001', value: null, model: 'fixture-model',
      }, '2026-08-28T00:00:03.000Z', sessionId, turnId, stepId),
    ]

    const feedback = normalizeAneraTrace({ events }).events.filter((item) => item.kind === 'operator_action')
    expect(feedback.map((item) => item.action)).toEqual(['upvote', 'downvote', 'feedback_cleared'])
    expect(feedback).toMatchObject([
      { actor: 'operator', phase: 'finalized', status: 'succeeded', turnId: 'T01', stepId: 'S01', payload: { value: 'upvote', model: 'fixture-model' } },
      { actor: 'operator', phase: 'finalized', status: 'succeeded', turnId: 'T01', stepId: 'S01', payload: { value: 'downvote', model: 'fixture-model' } },
      { actor: 'operator', phase: 'finalized', status: 'succeeded', turnId: 'T01', stepId: 'S01', payload: { value: null, model: 'fixture-model' } },
    ])
  })

  it('keeps a custom-feedback user turn distinct and correlated to the reviewed Final', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const events: SessionEvent[] = [
      event(1, 'assistant.final', { content: 'Original result.' }, '2026-08-27T23:59:59.000Z', sessionId, 'turn_original', 'step_original'),
      event(2, 'turn.started', {
        content: 'The title is wrong.',
        attachments: ['uploads/reference.txt'],
        customFeedbackTurn: true,
        reviewedNodeId: 'evt_00000000000000000001',
        has_feedback: true,
        model: 'fixture-model',
        modelSelection: null,
      }, '2026-08-28T00:00:00.000Z', sessionId, 'turn_custom_feedback'),
    ]
    expect(normalizeAneraTrace({ events }).events[1]).toMatchObject({
      actor: 'user',
      kind: 'message',
      action: 'custom_feedback_submitted',
      message: 'The title is wrong.',
      payload: {
        attachments: ['uploads/reference.txt'],
        customFeedbackTurn: true,
        reviewedNodeId: 'N01',
        has_feedback: true,
      },
    })
  })

  it('keeps task review appearance and dismissal distinct from run resume', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const turnId = 'turn_review'
    const stepId = 'step_review'
    const events: SessionEvent[] = [
      event(1, 'assistant.final', { content: 'Result' }, '2026-08-28T00:00:00.000Z', sessionId, turnId, stepId),
      event(2, 'review.requested', {
        messageEventId: 'evt_00000000000000000001', model: 'fixture-model',
      }, '2026-08-28T00:00:01.000Z', sessionId, turnId, stepId),
      event(3, 'review.dismissed', {
        messageEventId: 'evt_00000000000000000001', action: 'continue', model: 'fixture-model',
      }, '2026-08-28T00:00:02.000Z', sessionId, turnId, stepId),
    ]

    const review = normalizeAneraTrace({ events }).events.slice(1)
    expect(review).toMatchObject([
      { actor: 'system_ui', kind: 'lifecycle', action: 'task_review_required', phase: 'appeared', status: 'awaiting_user_input', turnId: 'T01', stepId: 'S01' },
      { actor: 'operator', kind: 'operator_action', action: 'continue_working', phase: 'finalized', status: 'succeeded', turnId: 'T01', stepId: 'S01' },
    ])
  })

  it('keeps task completion bar state and all three values separate from check-in feedback', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const turnId = 'turn_task_completion'
    const stepId = 'step_task_completion'
    const events: SessionEvent[] = [
      event(1, 'assistant.final', { content: 'Result' }, '2026-08-28T00:00:00.000Z', sessionId, turnId, stepId),
      event(2, 'review.requested', {
        messageEventId: 'evt_00000000000000000001', feedbackType: 'task_completion_bar', model: 'fixture-model',
      }, '2026-08-28T00:00:01.000Z', sessionId, turnId, stepId),
      ...(['no', 'making_progress', 'yes'] as const).map((value, index) => event(3 + index, 'task.completion.updated', {
        sessionNodeId: 'evt_00000000000000000001',
        messageEventId: 'evt_00000000000000000001',
        feedback: { type: 'task_completion_bar', value },
        value,
        model: 'fixture-model',
      }, `2026-08-28T00:00:0${2 + index}.000Z`, sessionId, turnId, stepId)),
    ]

    const completion = normalizeAneraTrace({ events }).events.slice(1)
    expect(completion.map((item) => item.action)).toEqual([
      'task_completion_bar_required',
      'task_completion_no',
      'task_completion_making_progress',
      'task_completion_yes',
    ])
    expect(completion[0]).toMatchObject({
      actor: 'system_ui', kind: 'lifecycle', phase: 'appeared', status: 'awaiting_user_input',
      payload: { feedbackType: 'task_completion_bar' },
    })
    expect(completion.slice(1)).toMatchObject([
      { actor: 'operator', kind: 'operator_action', status: 'succeeded', payload: { value: 'no', feedbackType: 'task_completion_bar' } },
      { actor: 'operator', kind: 'operator_action', status: 'succeeded', payload: { value: 'making_progress', feedbackType: 'task_completion_bar' } },
      { actor: 'operator', kind: 'operator_action', status: 'succeeded', payload: { value: 'yes', feedbackType: 'task_completion_bar' } },
    ])
  })

  it('exports undo as a durable operator action without claiming a workspace rollback', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const turnId = 'turn_undo'
    const events: SessionEvent[] = [event(1, 'turn.undone', {
      sessionNodeId: 'evt_target',
      targetMessageEventId: 'evt_target',
      targetTurnIds: [turnId],
      promptRestored: true,
      attachmentsCleared: true,
      feedbackPreserved: true,
      workspaceReverted: false,
    }, '2026-08-28T00:00:00.000Z', sessionId, turnId, 'step_undo')]

    expect(normalizeAneraTrace({ events }).events[0]).toMatchObject({
      actor: 'operator',
      kind: 'operator_action',
      action: 'undo_last_turn',
      phase: 'finalized',
      status: 'succeeded',
      turnId: 'T01',
      payload: {
        promptRestored: true,
        attachmentsCleared: true,
        feedbackPreserved: true,
        workspaceReverted: false,
      },
    })
  })

  it('exports successful and failed context checkpoints with strategy and byte evidence', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const turnId = 'turn_compaction'
    const events: SessionEvent[] = [
      event(1, 'context.compacted', {
        summary: 'Preserve the current goal and marker 731.',
        compactedMessageCount: 12,
        retainedMessageCount: 4,
        beforeBytes: 28_660,
        afterBytes: 8_461,
        reason: 'threshold',
        forced: false,
      }, '2026-08-28T00:00:00.000Z', sessionId, turnId, 'step_compaction'),
      event(2, 'context.compaction.failed', {
        message: 'provider checkpoint was truncated',
        reason: 'context_overflow',
        forced: true,
      }, '2026-08-28T00:00:01.000Z', sessionId, turnId, 'step_compaction'),
    ]

    expect(normalizeAneraTrace({ events }).events).toMatchObject([
      {
        actor: 'system', kind: 'context', action: 'compacted', phase: 'completed', status: 'succeeded',
        message: 'Preserve the current goal and marker 731.',
        payload: {
          compactedMessageCount: 12,
          retainedMessageCount: 4,
          beforeBytes: 28_660,
          afterBytes: 8_461,
          reason: 'threshold',
          forced: false,
        },
      },
      {
        actor: 'system', kind: 'context', action: 'compaction_failed', phase: 'completed', status: 'failed',
        message: 'provider checkpoint was truncated',
        payload: { reason: 'context_overflow', forced: true },
      },
    ])
  })

  it('preserves coding product and repository identity without dynamic clone credentials', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const repository = {
      provider: 'github' as const,
      repoId: 17,
      fullName: 'arena-labs/harness',
      ownerLogin: 'arena-labs',
      name: 'harness',
      baseBranch: 'main',
      baseCommitSha: 'a'.repeat(40),
      private: true,
      importedAt: '2026-08-28T00:00:00.000Z',
    }
    const events: SessionEvent[] = [event(1, 'session.created', {
      title: 'Coding task', productMode: 'coding', repository,
    }, '2026-08-28T00:00:00.000Z', sessionId)]
    const trace = normalizeAneraTrace({ events, repository })
    expect(trace.header).toMatchObject({
      productMode: 'coding',
      repository: {
        provider: 'github', repoId: 17, fullName: 'arena-labs/harness', baseBranch: 'main',
        baseCommitSha: 'a'.repeat(40), private: true,
      },
    })
    expect(trace.events[0]).toMatchObject({
      kind: 'session', action: 'created', payload: { productMode: 'coding', repository: { fullName: 'arena-labs/harness' } },
    })
    expect(JSON.stringify(trace)).not.toContain('token')
  })

  it('normalizes legacy and current Arena file-search tool names identically', () => {
    expect(canonicalToolName('grep')).toEqual({ name: 'grep_files' })
    expect(canonicalToolName('grep_files')).toEqual({ name: 'grep_files' })
    expect(canonicalToolName('Glob')).toEqual({ name: 'glob_files' })
    expect(canonicalToolName('glob_files')).toEqual({ name: 'glob_files' })
    expect(canonicalToolName('bash')).toEqual({ name: 'shell' })
    expect(canonicalToolName('shell_command')).toEqual({ name: 'shell' })
  })

  it('normalizes legacy and current Arena web protocol names identically', () => {
    expect(canonicalToolName('search_web')).toEqual({ name: 'search' })
    expect(canonicalToolName('web_search')).toEqual({ name: 'search' })
    expect(canonicalToolName('web_fetch')).toEqual({ name: 'fetch' })
    expect(canonicalToolName('fetch_page')).toEqual({ name: 'fetch' })
    expect(canonicalToolName('fetch_media')).toEqual({ name: 'media_fetch' })
    expect(canonicalToolName('generate_image')).toEqual({ name: 'image_generate' })
    expect(normalizeToolArguments({ name: 'search' }, { query: 'RFC 8297', depth: '2' })).toEqual({
      depth: '2',
      query: 'RFC 8297',
    })
    expect(normalizeToolResult('{"status":"success","results":[{"id":1,"title":"RFC 8297","url":"https://example.com","description":"Early Hints"}]}')).toEqual({
      results: [{ description: 'Early Hints', id: 1, title: 'RFC 8297', url: 'https://example.com' }],
      status: 'success',
    })
  })

  it('normalizes Arena package/build/start names while retaining legacy aliases', () => {
    expect(canonicalToolName('install_npm_packages')).toEqual({ name: 'package_install' })
    expect(canonicalToolName('package_install')).toEqual({ name: 'package_install' })
    expect(canonicalToolName('build_project')).toEqual({ name: 'build' })
    expect(canonicalToolName('build_and_start')).toEqual({ name: 'website_start' })
    expect(canonicalToolName('deploy_project')).toEqual({ name: 'deploy' })
    expect(canonicalToolName('start_process')).toEqual({ name: 'process_start' })
    expect(canonicalToolName('preview_website')).toEqual({ name: 'website_preview' })
  })

  it('keeps Arena structured tool result unions as canonical objects', () => {
    expect(normalizeToolResult('{"status":"success","stdout":"READY\\n"}')).toEqual({ status: 'success', stdout: 'READY' })
    expect(normalizeToolResult('{"status":"error","message":"failed","stderr":"warning\\n"}')).toEqual({
      message: 'failed', status: 'error', stderr: 'warning',
    })
    expect(normalizeToolResult('{not-json')).toBe('{not-json')
  })

  it('projects deployment lifecycle observations with stable identities and call linkage', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const deployment = {
      id: 'dep_1234567890abcdefghij',
      revision: 1,
      entryPath: 'index.html',
      contentHash: 'a'.repeat(64),
      fileCount: 2,
      bytes: 42,
      createdAt: '2026-08-28T00:00:00.000Z',
    }
    const trace = normalizeAneraTrace({
      events: [
        event(1, 'deployment.updated', {
          deployment: { ...deployment, status: 'building', updatedAt: '2026-08-28T00:00:00.000Z' },
          action: 'building',
        }, '2026-08-28T00:00:00.000Z', sessionId, 'turn_deploy', 'step_deploy', 'call_deploy'),
        event(2, 'deployment.updated', {
          deployment: {
            ...deployment,
            status: 'deployed',
            url: `http://127.0.0.1:43129/deployments/${sessionId}/`,
            visibility: 'local',
            updatedAt: '2026-08-28T00:00:01.000Z',
          },
          action: 'deployed',
        }, '2026-08-28T00:00:01.000Z', sessionId, 'turn_deploy', 'step_deploy', 'call_deploy'),
      ],
    })

    expect(trace.events).toMatchObject([
      {
        kind: 'deployment', action: 'building', status: 'running',
        deployment: { id: 'D01', callId: 'C01', status: 'running', revision: 1 },
      },
      {
        kind: 'deployment', action: 'deployed', status: 'succeeded',
        deployment: {
          id: 'D01', callId: 'C01', status: 'succeeded', revision: 1, visibility: 'local',
          url: 'http://127.0.0.1:<port>/deployments/<ses>/', entryPath: 'index.html', fileCount: 2, bytes: 42,
        },
      },
    ])
  })

  it('normalizes the Arena file mutation surface and bounds patch/edit payloads', () => {
    expect(canonicalToolName('create_file')).toEqual({ name: 'file_write' })
    expect(canonicalToolName('edit_file')).toEqual({ name: 'file_edit' })
    expect(canonicalToolName('delete_file')).toEqual({ name: 'file_delete' })
    expect(canonicalToolName('apply_patch')).toEqual({ name: 'file_patch' })
    expect(normalizeToolArguments({ name: 'file_edit' }, {
      path: 'a.txt', context: 'a'.repeat(500), replacement: 'b'.repeat(500),
    })).toMatchObject({ path: 'a.txt' })
    expect(JSON.stringify(normalizeToolArguments({ name: 'file_patch' }, { input: 'x'.repeat(5_000) })).length).toBeLessThan(1_000)
  })

  it('normalizes update_plan calls and append-only visible plan snapshots', () => {
    expect(canonicalToolName('update_plan')).toEqual({ name: 'plan_update' })
    const sessionId = 'ses_1234567890abcdefghij'
    const trace = normalizeAneraTrace({
      events: [
        event(1, 'plan.updated', {
          explanation: 'Starting the first step.',
          plan: {
            items: [
              { id: 'plan_aaaaaaaaaaaaaaaaaaaa', step: 'Inspect files', status: 'in_progress' },
              { id: 'plan_bbbbbbbbbbbbbbbbbbbb', step: 'Verify output', status: 'pending' },
            ],
            version: 1,
            updatedAt: '2026-08-28T00:00:00.000Z',
          },
        }, '2026-08-28T00:00:00.000Z', sessionId, 'turn_plan', 'step_plan', 'call_plan'),
        event(2, 'plan.updated', {
          plan: {
            items: [
              { id: 'plan_aaaaaaaaaaaaaaaaaaaa', step: 'Inspect files', status: 'completed' },
              { id: 'plan_bbbbbbbbbbbbbbbbbbbb', step: 'Verify output', status: 'in_progress' },
            ],
            version: 2,
            updatedAt: '2026-08-28T00:00:01.000Z',
          },
        }, '2026-08-28T00:00:01.000Z', sessionId, 'turn_plan', 'step_plan_2', 'call_plan_2'),
      ],
    })

    expect(trace.events).toMatchObject([
      {
        kind: 'plan',
        action: 'updated',
        phase: 'updated',
        status: 'running',
        message: 'Starting the first step.',
        payload: {
          items: [
            { id: 'PL01', status: 'in_progress', step: 'Inspect files' },
            { id: 'PL02', status: 'pending', step: 'Verify output' },
          ],
          version: 1,
        },
      },
      {
        kind: 'plan',
        action: 'updated',
        status: 'running',
        payload: {
          items: [
            { id: 'PL01', status: 'completed', step: 'Inspect files' },
            { id: 'PL02', status: 'in_progress', step: 'Verify output' },
          ],
          version: 2,
        },
      },
    ])
  })
})

function event(
  seq: number,
  type: SessionEvent['type'],
  data: Record<string, unknown>,
  at: string,
  sessionId: string,
  turnId?: string,
  stepId?: string,
  callId?: string,
): SessionEvent {
  return { id: `evt_${String(seq).padStart(20, '0')}`, sessionId, seq, type, at, turnId, stepId, callId, data }
}
