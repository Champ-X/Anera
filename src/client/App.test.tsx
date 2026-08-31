import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionEvent, SessionSnapshot, SessionSummary } from '../shared/types.js'
import {
  AGENT_DRAFT_PATH,
  ApprovalCard,
  ArenaToolGroup,
  AssistantActivityRow,
  AskUserHitl,
  CODING_REPOSITORY_PANEL_STORAGE_KEY,
  CONVERSATION_NEAR_BOTTOM_PX,
  HISTORY_SEARCH_PATH,
  applyEventToSnapshot,
  commandToolPresentation,
  codingErrorMessage,
  conversationDistanceFromBottom,
  conversationScrollBehavior,
  filterHistorySessions,
  formatCreditResetDay,
  formatCreditResetDuration,
  formatCreditResetTime,
  ImageSelectionHitl,
  isAgentDraftPath,
  isConversationNearBottom,
  isHistorySearchPath,
  materializeComposerAttachments,
  mergeWorkspaceInventoryEntries,
  markdownHref,
  pastedImageExtension,
  parseCodingRepositoryPanelState,
  parsePreviewElementPickerMessage,
  officePreviewSections,
  partialJsonStringField,
  previewElementReference,
  previewRenderer,
  previewSourceTokens,
  projectTimeline,
  reconcileSnapshot,
  resolveCreditGaugeState,
  resolveCustomFeedbackOffer,
  resolveUndoTurnCandidate,
  resolveTaskCompletion,
  resolveTaskReview,
  sessionIdFromPath,
  sessionPath,
  shouldAutoOpenWorkspace,
  spreadsheetCellDisplay,
  startProcessTimelineLabel,
  StreamingToolCallRow,
  toolLabel,
  validHistorySearchReturnPath,
  websiteStatusLabel,
  workspacePersistenceFromEvent,
  workspacePersistenceSidebarLabel,
  workspaceEntryPreviewTarget,
  workspaceFileUsageLabel,
  workspaceInventoryFromSnapshot,
  workspaceInventoryTruncationMessage,
  workspacePreviewPickerUrl,
  WorkspaceFileNode,
  WorkspacePanel,
  workspaceWriteDraftsFromTimeline,
} from './App.js'

describe('streamed file-write projection', () => {
  it('decodes partial escaped JSON strings without exposing an invalid final parse', () => {
    expect(partialJsonStringField('{"path":"slides.html","content":"line 1\\n你', 'path')).toEqual({
      value: 'slides.html', complete: true,
    })
    expect(partialJsonStringField('{"path":"slides.html","content":"line 1\\n你', 'content')).toEqual({
      value: 'line 1\n你', complete: false,
    })
    expect(partialJsonStringField('{"content":"A\\u4f60\\u597d"}', 'content')).toEqual({
      value: 'A你好', complete: true,
    })
  })

  it('recognizes only a top-level field and ignores field-shaped text inside strings or nested objects', () => {
    expect(partialJsonStringField(
      '{"path":"safe-\\\"content\\\":\\\"forged","meta":{"content":"nested"},"content":"real"}',
      'content',
    )).toEqual({ value: 'real', complete: true })
    expect(partialJsonStringField(
      '{"meta":{"path":"nested.html"},"path":"top.html","content":"ok"}',
      'path',
    )).toEqual({ value: 'top.html', complete: true })
  })

  it('keeps surrogate-split UTF-8 bytes monotonic and removes an interrupted draft from Workspace', () => {
    const argumentsText = JSON.stringify({ path: 'emoji.html', content: 'A😀你好' })
    const surrogateBoundary = argumentsText.indexOf('😀') + 1
    const firstEvents = [
      event(1, 'assistant.started', { step: 1 }, 'step_emoji'),
      event(2, 'assistant.tool_call.delta', {
        index: 0,
        nameDelta: 'write_file',
        argumentsDelta: argumentsText.slice(0, surrogateBoundary),
      }, 'step_emoji'),
    ]
    const first = fixture(firstEvents)
    expect(workspaceWriteDraftsFromTimeline(projectTimeline(first))).toEqual([
      { key: 'tool-draft-step_emoji:0', path: 'emoji.html', bytes: Buffer.byteLength('A\ud83d') },
    ])

    const complete = fixture([
      ...firstEvents,
      event(3, 'assistant.tool_call.delta', {
        index: 0,
        argumentsDelta: argumentsText.slice(surrogateBoundary),
      }, 'step_emoji'),
    ])
    expect(workspaceWriteDraftsFromTimeline(projectTimeline(complete))).toEqual([
      { key: 'tool-draft-step_emoji:0', path: 'emoji.html', bytes: Buffer.byteLength('A😀你好') },
    ])

    complete.session.status = 'interrupted'
    const interruptedTimeline = projectTimeline(complete)
    expect(workspaceWriteDraftsFromTimeline(interruptedTimeline)).toEqual([])
    expect(complete.workspace).toEqual([])
    expect(complete.artifacts).toEqual([])
    const interrupted = interruptedTimeline.find((item) => item.kind === 'tool-draft')
    if (!interrupted || interrupted.kind !== 'tool-draft') throw new Error('Interrupted write row was not projected')
    const markup = renderToStaticMarkup(<StreamingToolCallRow item={interrupted} />)
    expect(markup).toContain('Write interrupted')
    expect(markup).toContain('emoji.html')
  })

  it('shows a provisional write and Workspace byte count, then hands the row to the durable tool', () => {
    const argumentsText = JSON.stringify({ path: 'slides.html', content: '<html>\n你好\n</html>' })
    const splitAt = Math.floor(argumentsText.length / 2)
    const running = fixture([
      event(1, 'assistant.started', { step: 1 }, 'step_write'),
      event(2, 'assistant.tool_call.delta', {
        index: 0, nameDelta: 'write_file', argumentsDelta: argumentsText.slice(0, splitAt),
      }, 'step_write'),
      event(3, 'assistant.tool_call.delta', {
        index: 0, argumentsDelta: argumentsText.slice(splitAt),
      }, 'step_write'),
    ])
    running.session.status = 'running'
    const runningTimeline = projectTimeline(running)
    expect(runningTimeline).toEqual([
      expect.objectContaining({ kind: 'tool-draft', name: 'write_file', argumentsText, status: 'running' }),
    ])
    const drafts = workspaceWriteDraftsFromTimeline(runningTimeline)
    expect(drafts).toEqual([{ key: 'tool-draft-step_write:0', path: 'slides.html', bytes: 21 }])

    const workspace = renderToStaticMarkup(<WorkspacePanel
      snapshot={running}
      writeDrafts={drafts}
      onOpenFile={() => {}}
      onLoadMore={async () => {}}
      onRefresh={async () => {}}
      onPreview={() => {}}
      onRestart={async () => {}}
    />)
    expect(workspace).toContain('slides.html')
    expect(workspace).toContain('21B/128.0MB')
    expect(workspace).toContain('1/10K files')
    expect(workspace).toContain('not committed yet')

    const call = { id: 'call_write', name: 'write_file', arguments: { path: 'slides.html', content: '<html>\n你好\n</html>' } }
    const settled = fixture([
      ...running.events,
      event(4, 'tool.started', { call }, 'step_write', call.id),
      event(5, 'tool.completed', { call, result: '{"status":"success"}', isError: false }, 'step_write', call.id),
    ])
    const settledTimeline = projectTimeline(settled)
    expect(settledTimeline.some((item) => item.kind === 'tool-draft')).toBe(false)
    expect(settledTimeline[0]).toMatchObject({ kind: 'tool-group', variant: 'files', tools: [{ name: 'write_file', status: 'succeeded' }] })
  })
})

describe('conversation output following', () => {
  it('uses a bounded near-bottom threshold without treating an upward reading position as following', () => {
    const atBottom = { scrollTop: 700, scrollHeight: 1_000, clientHeight: 300 }
    const justInside = { ...atBottom, scrollTop: 700 - CONVERSATION_NEAR_BOTTOM_PX }
    const justOutside = { ...atBottom, scrollTop: 699 - CONVERSATION_NEAR_BOTTOM_PX }

    expect(conversationDistanceFromBottom(atBottom)).toBe(0)
    expect(isConversationNearBottom(atBottom)).toBe(true)
    expect(isConversationNearBottom(justInside)).toBe(true)
    expect(isConversationNearBottom(justOutside)).toBe(false)
    expect(isConversationNearBottom({ ...atBottom, scrollTop: 712 })).toBe(true)
    expect(isConversationNearBottom({ ...atBottom, scrollTop: -8 })).toBe(false)
  })

  it('uses instant scrolling only when reduced motion is requested', () => {
    expect(conversationScrollBehavior(false)).toBe('smooth')
    expect(conversationScrollBehavior(true)).toBe('auto')
  })
})

describe('workspace persistence projection', () => {
  it('maps the durable save protocol to exact Arena status copy', () => {
    const scanning = workspacePersistenceFromEvent(event(1, 'workspace.persistence.started', { phase: 'scanning' }, 'step_final'))!
    const uploading = workspacePersistenceFromEvent(event(2, 'workspace.persistence.updated', { phase: 'uploading', blobCount: 3 }, 'step_final'))!
    const saving = workspacePersistenceFromEvent(event(3, 'workspace.persistence.updated', { phase: 'saving', blobCount: 3 }, 'step_final'))!
    const saved = workspacePersistenceFromEvent(event(4, 'workspace.persistence.completed', {
      phase: 'saved', blobCount: 3, bytes: 4_096, fileCount: 3,
    }, 'step_final'))!

    expect(scanning).toMatchObject({ phase: 'scanning', label: 'Scanning workspace...' })
    expect(uploading).toMatchObject({ phase: 'uploading', label: 'Uploading 3 workspace blobs...', blobCount: 3 })
    expect(saving).toMatchObject({ phase: 'saving', label: 'Saving workspace...', blobCount: 3 })
    expect(saved).toMatchObject({ phase: 'saved', label: 'Workspace saved', bytes: 4_096, fileCount: 3 })
    expect([scanning, uploading, saving, saved].map(workspacePersistenceSidebarLabel)).toEqual([
      'Scanning', 'Uploading 3 blobs', 'Saving', 'Saved',
    ])
    expect(workspacePersistenceFromEvent(event(5, 'assistant.final', { content: 'Done' }, 'step_final'))).toBeUndefined()
  })

  it('uses the completed event as the live authoritative Workspace byte count', () => {
    const snapshot = fixture([])
    snapshot.session.workspaceBytes = 17
    const projected = applyEventToSnapshot(snapshot, event(1, 'workspace.persistence.completed', {
      phase: 'saved', blobCount: 2, bytes: 589, fileCount: 2,
    }, 'step_final'))
    expect(projected.session.workspaceBytes).toBe(589)
  })
})

describe('desktop Workspace ownership', () => {
  it('claims the right rail only after a turn exists and restores historical sessions', () => {
    const draft = fixture([])
    const started = fixture([event(1, 'turn.started', {
      content: 'Build the report.', attachments: [],
    }, 'step_turn')])

    expect(shouldAutoOpenWorkspace(draft.session.id, draft, new Set())).toBe(false)
    expect(shouldAutoOpenWorkspace(started.session.id, started, new Set())).toBe(true)
  })

  it('does not steal the rail from Preview or reopen a manually dismissed Workspace', () => {
    const started = fixture([event(1, 'turn.started', {
      content: 'Present the artifact.', attachments: [],
    }, 'step_turn')])
    const sessionId = started.session.id

    expect(shouldAutoOpenWorkspace(sessionId, started, new Set(), sessionId)).toBe(false)
    expect(shouldAutoOpenWorkspace(sessionId, started, new Set([sessionId]))).toBe(false)
    expect(shouldAutoOpenWorkspace(sessionId, started, new Set(['ses_other']))).toBe(true)
  })

  it('routes Workspace files into the existing docked renderer with a separate download URL', () => {
    const sessionId = 'ses_1234567890abcdefghij'
    const targets = [
      ['site/index.html', 'website', 'text/html', 'html'],
      ['notes/report.md', 'markdown', 'text/markdown', 'markdown'],
      ['notes/plain.txt', 'file', 'text/plain', 'text'],
      ['assets/hero.png', 'image', 'image/png', 'image'],
      ['exports/report.pdf', 'document', 'application/pdf', 'pdf'],
      ['exports/brief.docx', 'document', 'application/octet-stream', 'office'],
      ['data/status.json', 'data', 'application/json', 'text'],
      ['archives/raw.bin', 'file', 'application/octet-stream', 'download'],
    ] as const

    for (const [path, kind, mime, renderer] of targets) {
      const target = workspaceEntryPreviewTarget(sessionId, { name: path.split('/').at(-1)!, path })
      expect(target).toMatchObject({ label: path, kind, mime })
      expect(target.downloadUrl).toBe(`/api/sessions/${sessionId}/download?path=${encodeURIComponent(path)}`)
      expect(previewRenderer(target)).toBe(renderer)
      expect(target.url).toBe(path.endsWith('.html')
        ? `/workspace/${sessionId}/preview/site/index.html`
        : `/workspace/${sessionId}/file?path=${encodeURIComponent(path)}`)
    }
  })

  it('renders a Workspace file as an in-app button instead of a new-tab link', () => {
    const html = renderToStaticMarkup(<WorkspaceFileNode
      entry={{ name: 'report.md', path: 'docs/report.md', type: 'file', size: 128 }}
      depth={0}
      onOpenFile={() => undefined}
    />)

    expect(html).toContain('<button type="button" class="file-node"')
    expect(html).toContain('report.md')
    expect(html).not.toContain('target="_blank"')
    expect(html).not.toContain('href=')
  })

  it('merges flat continuation records into a deterministic nested tree without duplicates', () => {
    const merged = mergeWorkspaceInventoryEntries([
      {
        name: 'docs',
        path: 'docs',
        type: 'directory',
        children: [{ name: 'a.md', path: 'docs/a.md', type: 'file', size: 1 }],
      },
      { name: 'index.html', path: 'index.html', type: 'file', size: 10 },
    ], [
      { name: 'b.md', path: 'docs/b.md', type: 'file', size: 2 },
      { name: 'a.md', path: 'docs/a.md', type: 'file', size: 3 },
      { name: 'hero.png', path: 'assets/images/hero.png', type: 'file', size: 4 },
    ])

    expect(merged.map((entry) => entry.path)).toEqual(['assets', 'docs', 'index.html'])
    expect(merged[0]?.children?.[0]).toMatchObject({ path: 'assets/images', type: 'directory' })
    expect(merged[0]?.children?.[0]?.children?.[0]).toMatchObject({ path: 'assets/images/hero.png', size: 4 })
    expect(merged[1]?.children).toEqual([
      expect.objectContaining({ path: 'docs/a.md', size: 3 }),
      expect.objectContaining({ path: 'docs/b.md', size: 2 }),
    ])
  })

  it('hydrates legacy snapshots safely and renders authoritative paged counts and truncation', () => {
    const snapshot = fixture([])
    snapshot.workspace = [{ name: 'only.txt', path: 'only.txt', type: 'file', size: 1 }]
    expect(workspaceInventoryFromSnapshot(snapshot)).toMatchObject({
      hasMore: false,
      truncated: false,
      totalFiles: 1,
      loadedEntries: 1,
      status: 'ready',
    })
    expect(workspaceFileUsageLabel(10_000, {
      truncated: true,
      fileLimitHit: true,
      entryLimitHit: false,
      totalFilesIsLowerBound: true,
    })).toBe('10,000+/10K files')

    const inventory = {
      ...workspaceInventoryFromSnapshot(snapshot),
      hasMore: true,
      nextCursor: 'opaque-next',
      truncated: true,
      totalFiles: 10_000,
      fileLimitHit: true,
      entryLimitHit: false,
      totalFilesIsLowerBound: true,
      loadedEntries: 500,
    }
    const html = renderToStaticMarkup(<WorkspacePanel
      snapshot={snapshot}
      inventory={inventory}
      onOpenFile={() => undefined}
      onLoadMore={async () => undefined}
      onRefresh={async () => undefined}
      onPreview={() => undefined}
      onRestart={async () => undefined}
    />)

    expect(html).toContain('10,000+/10K files')
    expect(html).toContain('Load more files')
    expect(html).toContain('10,000+ files')
    expect(html).toContain('aria-label="Refresh workspace files"')
  })

  it('does not mislabel an entry-cap truncation as 10,000+ files', () => {
    const snapshot = fixture([])
    const inventory = {
      ...workspaceInventoryFromSnapshot(snapshot),
      truncated: true,
      totalFiles: 742,
      fileLimitHit: false,
      entryLimitHit: true,
      totalFilesIsLowerBound: true,
    }
    const html = renderToStaticMarkup(<WorkspacePanel
      snapshot={snapshot}
      inventory={inventory}
      onOpenFile={() => undefined}
      onLoadMore={async () => undefined}
      onRefresh={async () => undefined}
      onPreview={() => undefined}
      onRestart={async () => undefined}
    />)

    expect(workspaceFileUsageLabel(742, inventory)).toBe('742+/10K files')
    expect(html).toContain('742+ files observed; inventory entry cap reached.')
    expect(html).not.toContain('10,000+ files')
  })

  it('uses neutral truncation copy for metadata persisted before cap reasons were recorded', () => {
    expect(workspaceInventoryTruncationMessage({
      truncated: true,
      totalFiles: 500,
    })).toBe('Workspace inventory is capped; the complete file total is unavailable.')
    expect(workspaceFileUsageLabel(500, { truncated: true })).toBe('500/10K files')
  })

  it('surfaces continuation failures with both retry and full refresh actions', () => {
    const snapshot = fixture([])
    const inventory = {
      ...workspaceInventoryFromSnapshot(snapshot),
      hasMore: true,
      nextCursor: 'opaque-next',
      status: 'failed' as const,
      error: 'The inventory changed while paging.',
    }
    const html = renderToStaticMarkup(<WorkspacePanel
      snapshot={snapshot}
      inventory={inventory}
      onOpenFile={() => undefined}
      onLoadMore={async () => undefined}
      onRefresh={async () => undefined}
      onPreview={() => undefined}
      onRestart={async () => undefined}
    />)

    expect(html).toContain('role="alert"')
    expect(html).toContain('The inventory changed while paging.')
    expect(html).toContain('>Retry<')
    expect(html).toContain('>Refresh<')
  })
})

describe('Arena ask-user card', () => {
  it('renders the question as a single-column native radio group with Arena controls', () => {
    const html = renderToStaticMarkup(<AskUserHitl
      item={{
        kind: 'hitl',
        key: 'hitl-ask',
        hitlId: 'hitl_ask',
        hitlKind: 'ask_user',
        title: 'A few questions before I continue',
        call: { name: 'ask_user', arguments: {} },
        payload: {
          questions: [{
            id: 'audience',
            question: 'Who is the primary audience?',
            options: [
              { id: 'general', label: 'General audience', description: 'Clear and approachable.' },
              { id: 'experts', label: 'Industry experts', description: 'Technical and detailed.' },
            ],
          }],
        },
        decision: 'pending',
      }}
      onResponse={async () => undefined}
    />)

    expect(html).toContain('role="radiogroup"')
    expect(html.match(/type="radio"/g)).toHaveLength(2)
    expect(html).toContain('Who is the primary audience?')
    expect(html).toContain('Revise options or write your own...')
    expect(html).toContain('>Skip<')
    expect(html).toContain('>Submit<')
    expect(html).not.toContain('>Dismiss<')
    expect(html).not.toContain('>Continue<')
    expect(html).not.toContain('A few questions before I continue</strong>')
  })
})

describe('Bash execution projection', () => {
  it('renders command, stdout, and stderr as distinct Arena sections', () => {
    expect(commandToolPresentation({
      kind: 'tool',
      key: 'tool-bash',
      name: 'bash',
      args: { command: "printf 'ok\\n'; printf 'warn\\n' >&2" },
      result: JSON.stringify({
        stdout: 'ok\n', stdout_truncated: false,
        stderr: 'warn\n', stderr_truncated: false,
        exit_code: 7, status: 'completed', duration_ms: 71,
      }),
      status: 'failed',
      durationMs: 71,
    })).toEqual({
      command: "printf 'ok\\n'; printf 'warn\\n' >&2",
      stdout: 'ok\n',
      stderr: 'warn\n',
    })
  })

  it('prefers live stream chunks while a command is running', () => {
    expect(commandToolPresentation({
      kind: 'tool', key: 'tool-live', name: 'bash', args: { command: 'verify' },
      result: 'stdout:\nold', liveOutput: { stdout: 'new\n', stderr: '' }, status: 'running',
    })).toEqual({ command: 'verify', stdout: 'new\n' })
  })

  it('uses a managed process log tail as stdout in the shared command renderer', () => {
    expect(commandToolPresentation({
      kind: 'tool', key: 'tool-start', name: 'start_process',
      args: { name: 'ANERA Dev Server V1', command: 'npm run dev' },
      result: JSON.stringify({ log_tail: 'Vite ready in 160ms\n', new_ports: [{ port: 5173, address: '0.0.0.0' }] }),
      status: 'succeeded',
    })).toEqual({ command: 'npm run dev', stdout: 'Vite ready in 160ms\n' })
  })

  it('auto-expands only the current Bash through live output and its immediate completion', () => {
    const first = { id: 'call_auto_first', name: 'bash', arguments: { command: 'npm test' } }
    const second = { id: 'call_auto_second', name: 'bash', arguments: { command: 'npm run build' } }
    const firstEvents = [
      event(1, 'assistant.started', { step: 1 }, 'step_first'),
      event(2, 'tool.started', { call: first }, 'step_first', first.id),
      event(3, 'tool.output', { stream: 'stdout', chunk: 'tests running\n' }, 'step_first', first.id),
      event(4, 'tool.failed', {
        call: first,
        result: '{"stdout":"tests running\\n","stderr":"failed\\n","exit_code":1}',
        isError: true,
      }, 'step_first', first.id),
    ]
    const immediate = projectTimeline(fixture(firstEvents))[0]
    expect(immediate).toMatchObject({
      kind: 'tool-group',
      tools: [{ name: 'bash', status: 'failed', autoExpanded: true }],
    })
    if (immediate.kind !== 'tool-group') throw new Error('Expected command group')
    const markup = renderToStaticMarkup(<ArenaToolGroup item={immediate} />)
    expect(markup.match(/aria-expanded="true"/g)).toHaveLength(2)
    expect(markup).toContain('COMMAND')
    expect(markup).toContain('STDERR')

    const nextStep = projectTimeline(fixture([
      ...firstEvents,
      event(5, 'assistant.started', { step: 2 }, 'step_second'),
      event(6, 'tool.started', { call: second }, 'step_second', second.id),
      event(7, 'tool.completed', {
        call: second,
        result: '{"stdout":"built\\n","stderr":"","exit_code":0}',
        isError: false,
      }, 'step_second', second.id),
    ]))[0]
    expect(nextStep).toMatchObject({ kind: 'tool-group', tools: [
      { name: 'bash' },
      { name: 'bash', status: 'succeeded', autoExpanded: true },
    ] })
    if (nextStep.kind !== 'tool-group') throw new Error('Expected command group')
    expect(nextStep.tools[0].autoExpanded).toBeUndefined()

    const withThought = projectTimeline(fixture([
      ...firstEvents,
      event(5, 'assistant.thought.started', { step: 2 }, 'step_thought'),
    ]))[0]
    expect(withThought).toMatchObject({ kind: 'tool-group', tools: [{ name: 'bash' }] })
    if (withThought.kind !== 'tool-group') throw new Error('Expected command group')
    expect(withThought.tools[0].autoExpanded).toBeUndefined()
  })

  it('clears command auto-expansion at a terminal Session boundary', () => {
    const call = { id: 'call_auto_terminal', name: 'bash', arguments: { command: 'npm test' } }
    const snapshot = fixture([
      event(1, 'tool.started', { call }, 'step_terminal', call.id),
      event(2, 'tool.completed', { call, result: '{"exit_code":0}', isError: false }, 'step_terminal', call.id),
    ])
    snapshot.session.status = 'completed'
    const terminal = projectTimeline(snapshot)[0]
    expect(terminal).toMatchObject({ kind: 'tool-group', tools: [{ status: 'succeeded' }] })
    if (terminal.kind !== 'tool-group') throw new Error('Expected command group')
    expect(terminal.tools[0].autoExpanded).toBeUndefined()
  })
})

describe('conversation search', () => {
  const session = (overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'title' | 'updatedAt'>): SessionSummary => ({
    createdAt: overrides.updatedAt,
    status: 'completed',
    model: 'fixture',
    workspaceBytes: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0, estimatedCostUsd: 0, modelCalls: 0, toolCalls: 0 },
    ...overrides,
  })
  const sessions = [
    session({ id: 'ses_1', title: 'Quarterly finance reconciliation', lastMessage: 'Regional net revenue report', updatedAt: '2026-08-29T10:00:00.000Z' }),
    session({ id: 'ses_2', title: 'Service Health dashboard', lastMessage: 'Built a desktop status page', updatedAt: '2026-08-30T10:00:00.000Z' }),
    session({ id: 'ses_3', title: 'Research HTTP 103', lastMessage: 'Compared RFC and MDN guidance', updatedAt: '2026-08-30T11:00:00.000Z' }),
    session({ id: 'ses_4', title: 'Finance follow-up', lastMessage: 'Quarterly exceptions', updatedAt: '2026-08-30T12:00:00.000Z' }),
  ]

  it('searches normalized title and last-message text with every query term', () => {
    expect(filterHistorySessions(sessions, '  FINANCE   quarterly ' ).map((item) => item.id)).toEqual(['ses_1', 'ses_4'])
    expect(filterHistorySessions(sessions, 'desktop status').map((item) => item.id)).toEqual(['ses_2'])
    expect(filterHistorySessions(sessions, 'finance missing')).toEqual([])
  })

  it('ranks title matches ahead of message-only matches and keeps empty-query order', () => {
    expect(filterHistorySessions(sessions, 'quarterly').map((item) => item.id)).toEqual(['ses_1', 'ses_4'])
    expect(filterHistorySessions(sessions, '').map((item) => item.id)).toEqual(sessions.map((item) => item.id))
  })
})

describe('conversation search route', () => {
  const sessionId = 'ses_1234567890abcdefghij'

  it('uses the observed durable Arena history route', () => {
    expect(HISTORY_SEARCH_PATH).toBe('/history/search')
    expect(isHistorySearchPath('/history/search')).toBe(true)
    expect(isHistorySearchPath('/history/search/')).toBe(true)
    expect(isHistorySearchPath('/history')).toBe(false)
    expect(isHistorySearchPath('/history/search/fake')).toBe(false)
  })

  it('only accepts canonical internal return paths from history state', () => {
    expect(validHistorySearchReturnPath('/agent')).toBe('/agent')
    expect(validHistorySearchReturnPath('/agent/')).toBe('/agent')
    expect(validHistorySearchReturnPath(`/agent/${sessionId}/`)).toBe(`/agent/${sessionId}`)
    expect(validHistorySearchReturnPath('/leaderboard/agent/')).toBe('/leaderboard/agent')
    expect(validHistorySearchReturnPath('/history/search')).toBeUndefined()
    expect(validHistorySearchReturnPath('https://example.com/agent')).toBeUndefined()
    expect(validHistorySearchReturnPath('/agent/not-a-session')).toBeUndefined()
  })
})

describe('Arena credit presentation helpers', () => {
  it('uses the public normal, low, zero, and loading gauge thresholds', () => {
    expect(resolveCreditGaugeState(undefined)).toBe('loading')
    expect(resolveCreditGaugeState({ creditsRemaining: 2_500, dailyFreeCredits: 2_500, refreshedAt: '2026-08-29T00:00:00.000Z' })).toBe('normal')
    expect(resolveCreditGaugeState({ creditsRemaining: 1_251, dailyFreeCredits: 2_500, refreshedAt: '2026-08-29T00:00:00.000Z' })).toBe('normal')
    expect(resolveCreditGaugeState({ creditsRemaining: 1_250, dailyFreeCredits: 2_500, refreshedAt: '2026-08-29T00:00:00.000Z' })).toBe('low')
    expect(resolveCreditGaugeState({ creditsRemaining: 1, dailyFreeCredits: 2_500, refreshedAt: '2026-08-29T00:00:00.000Z' })).toBe('low')
    expect(resolveCreditGaugeState({ creditsRemaining: 0, dailyFreeCredits: 2_500, refreshedAt: '2026-08-29T00:00:00.000Z' })).toBe('zero')
  })

  it('formats the reset countdown with stable singular and expired forms', () => {
    const now = Date.parse('2026-08-28T12:00:00.000Z')
    expect(formatCreditResetDuration('2026-08-28T13:01:00.000Z', now)).toBe('1 hour 1 minute until daily credits reset')
    expect(formatCreditResetDuration('2026-08-28T14:00:00.000Z', now)).toBe('2 hours 0 minutes until daily credits reset')
    expect(formatCreditResetDuration('2026-08-28T11:59:00.000Z', now)).toBe('0 hours 0 minutes until daily credits reset')
  })

  it('labels resets as today or tomorrow in the browser locale', () => {
    const current = new Date(2026, 7, 28, 10, 0)
    const today = new Date(2026, 7, 28, 23, 0)
    const tomorrow = new Date(2026, 7, 29, 8, 0)
    expect(formatCreditResetDay(today.toISOString(), current.getTime())).toBe('today')
    expect(formatCreditResetDay(tomorrow.toISOString(), current.getTime())).toBe('tomorrow')
    expect(formatCreditResetTime(today.toISOString())).toBe(today.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
  })
})

describe('managed Website presentation', () => {
  it('labels every lifecycle state without presenting a failure as stopped', () => {
    expect(websiteStatusLabel('running')).toBe('Running')
    expect(websiteStatusLabel('starting')).toBe('Starting')
    expect(websiteStatusLabel('asleep')).toBe('Asleep')
    expect(websiteStatusLabel('failed')).toBe('Failed')
    expect(websiteStatusLabel('stopped')).toBe('Stopped')
  })
})

describe('conversation routes', () => {
  const id = 'ses_1234567890abcdefghij'

  it('uses a stable Arena-style path that round-trips the session id', () => {
    expect(sessionPath(id)).toBe(`/agent/${id}`)
    expect(sessionIdFromPath(`/agent/${id}`)).toBe(id)
    expect(sessionIdFromPath(`/agent/${id}/`)).toBe(id)
  })

  it('does not interpret unrelated or malformed paths as sessions', () => {
    expect(sessionIdFromPath('/')).toBeUndefined()
    expect(sessionIdFromPath('/agent/not-a-session')).toBeUndefined()
    expect(sessionIdFromPath('/api/sessions/ses_1234567890abcdefghij')).toBeUndefined()
  })

  it('recognizes only the canonical blank Agent draft route', () => {
    expect(AGENT_DRAFT_PATH).toBe('/agent')
    expect(isAgentDraftPath('/agent')).toBe(true)
    expect(isAgentDraftPath('/agent/')).toBe(true)
    expect(isAgentDraftPath('/')).toBe(false)
    expect(isAgentDraftPath(`/agent/${id}`)).toBe(false)
    expect(isAgentDraftPath('/agent/draft')).toBe(false)
  })
})

describe('blank Agent draft attachments', () => {
  it('uploads pending browser Files in order while retaining existing server uploads', async () => {
    const first = new File(['first'], 'first.txt', { type: 'text/plain' })
    const second = new File(['second'], 'second.txt', { type: 'text/plain' })
    const uploadedNames: string[] = []
    const progress: string[][] = []

    const result = await materializeComposerAttachments([
      { name: first.name, path: 'draft:1:first.txt', size: first.size, mime: first.type, file: first },
      { name: 'existing.pdf', path: 'uploads/existing.pdf', size: 42, mime: 'application/pdf' },
      { name: second.name, path: 'draft:2:second.txt', size: second.size, mime: second.type, file: second },
    ], async (file) => {
      uploadedNames.push(file.name)
      return { path: `uploads/${file.name}`, bytes: file.size, mime: file.type }
    }, (attachments) => progress.push(attachments.map((attachment) => attachment.path)))

    expect(uploadedNames).toEqual(['first.txt', 'second.txt'])
    expect(progress).toEqual([
      ['uploads/first.txt', 'uploads/existing.pdf', 'draft:2:second.txt'],
      ['uploads/first.txt', 'uploads/existing.pdf', 'uploads/second.txt'],
    ])
    expect(result).toEqual([
      { name: 'first.txt', path: 'uploads/first.txt', size: 5, mime: 'text/plain' },
      { name: 'existing.pdf', path: 'uploads/existing.pdf', size: 42, mime: 'application/pdf' },
      { name: 'second.txt', path: 'uploads/second.txt', size: 6, mime: 'text/plain' },
    ])
  })
})

describe('coding product errors', () => {
  it('projects the stable Arena coding error categories into actionable copy', () => {
    expect(codingErrorMessage(new Error('not_connected'))).toBe('Connect GitHub before starting a coding session.')
    expect(codingErrorMessage(new Error('repo_not_found'))).toContain("repository isn't available")
    expect(codingErrorMessage(new Error('branch_not_found'))).toContain('no branches yet')
    expect(codingErrorMessage(new Error('github_request_failed'))).toContain('temporarily unavailable')
  })

  it('preserves unexpected server detail instead of inventing a category', () => {
    expect(codingErrorMessage(new Error('Synthetic failure detail'))).toBe('Synthetic failure detail')
  })
})

describe('coding repository panel persistence', () => {
  it('uses the public Arena storage key and restores the visible repository selection', () => {
    expect(CODING_REPOSITORY_PANEL_STORAGE_KEY).toBe('coding-repo-connect-panel')
    expect(parseCodingRepositoryPanelState(JSON.stringify({
      isOpen: true,
      attachedRepoId: 42,
      attachedRepoFullName: 'arena-labs/harness',
      attachedBranch: 'main',
    }))).toEqual({
      isOpen: true,
      attachedRepoId: 42,
      attachedRepoFullName: 'arena-labs/harness',
      attachedBranch: 'main',
    })
  })

  it('normalizes malformed or partially invalid persisted state without throwing', () => {
    expect(parseCodingRepositoryPanelState('{broken')).toEqual({
      isOpen: false,
      attachedRepoId: null,
      attachedRepoFullName: null,
      attachedBranch: null,
    })
    expect(parseCodingRepositoryPanelState(JSON.stringify({
      isOpen: 'yes',
      attachedRepoId: '42',
      attachedRepoFullName: 7,
      attachedBranch: false,
    }))).toEqual({
      isOpen: false,
      attachedRepoId: null,
      attachedRepoFullName: null,
      attachedBranch: null,
    })
  })
})

describe('final answer links', () => {
  const id = 'ses_1234567890abcdefghij'

  it('maps relative artifact links to the current workspace', () => {
    expect(markdownHref(id, 'docs/report.md')).toBe(`/workspace/${id}/file?path=docs%2Freport.md`)
    expect(markdownHref(id, './资料 2026/清单.txt')).toBe(`/workspace/${id}/file?path=${encodeURIComponent('资料 2026/清单.txt')}`)
    expect(markdownHref(id, '站点 1/index.html')).toBe(`/workspace/${id}/preview/%E7%AB%99%E7%82%B9%201/index.html`)
  })

  it('preserves safe web, app, and anchor links while blocking other schemes', () => {
    expect(markdownHref(id, 'https://example.com/source')).toBe('https://example.com/source')
    expect(markdownHref(id, '/api/sessions/example')).toBe('/api/sessions/example')
    expect(markdownHref(id, '#result')).toBe('#result')
    expect(markdownHref(id, 'javascript:alert(1)')).toBe('#')
  })
})

describe('Artifact preview routing', () => {
  it('uses native renderers instead of sending non-HTML files through the Website iframe', () => {
    expect(previewRenderer({ url: '/workspace/id/preview/index.html', label: 'index.html', kind: 'website', mime: 'text/html' })).toBe('html')
    expect(previewRenderer({ url: '/workspace/id/file?path=report.md', label: 'report.md', kind: 'markdown', mime: 'text/markdown' })).toBe('markdown')
    expect(previewRenderer({ url: '/workspace/id/file?path=proof.txt', label: 'proof.txt', kind: 'markdown', mime: 'text/plain' })).toBe('text')
    expect(previewRenderer({ url: '/workspace/id/file?path=plot.png', label: 'plot.png', kind: 'image', mime: 'image/png' })).toBe('image')
    expect(previewRenderer({ url: '/workspace/id/file?path=voice.mp3', label: 'voice.mp3', kind: 'audio', mime: 'audio/mpeg' })).toBe('audio')
    expect(previewRenderer({ url: '/workspace/id/file?path=voice.aiff', label: 'voice.aiff', kind: 'document', mime: 'application/octet-stream' })).toBe('audio')
    expect(previewRenderer({ url: '/workspace/id/file?path=clip.mp4', label: 'clip.mp4', kind: 'video', mime: 'video/mp4' })).toBe('video')
    expect(previewRenderer({ url: '/workspace/id/file?path=report.pdf', label: 'report.pdf', kind: 'document', mime: 'application/pdf' })).toBe('pdf')
    expect(previewRenderer({ url: '/workspace/id/file?path=brief.docx', label: 'brief.docx', kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBe('office')
  })

  it('adds the isolated picker bootstrap only to local workspace preview URLs', () => {
    expect(workspacePreviewPickerUrl('/workspace/ses_123/preview/index.html')).toBe('/workspace/ses_123/preview/index.html?aneraElementPicker=1')
    expect(workspacePreviewPickerUrl('/workspace/ses_123/preview/page.html?revision=2#hero')).toBe('/workspace/ses_123/preview/page.html?revision=2&aneraElementPicker=1#hero')
    expect(workspacePreviewPickerUrl('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173')
  })

  it('accepts only bounded picker messages and produces a concise composer reference', () => {
    expect(parsePreviewElementPickerMessage({ type: 'anera.element-picker.ready' })).toEqual({ type: 'ready' })
    expect(parsePreviewElementPickerMessage({ type: 'anera.element-picker.cancelled' })).toEqual({ type: 'cancelled' })
    expect(parsePreviewElementPickerMessage({
      type: 'anera.element-picker.selected',
      selection: { selector: '#hero > h1', tagName: 'h1', text: '  Systems   ready  ', outerHTML: '<h1>Systems ready</h1>' },
    })).toEqual({
      type: 'selected',
      selection: { selector: '#hero > h1', tagName: 'h1', text: '  Systems   ready  ', outerHTML: '<h1>Systems ready</h1>' },
    })
    expect(parsePreviewElementPickerMessage({ type: 'anera.element-picker.selected', selection: { selector: 1 } })).toBeUndefined()
    expect(parsePreviewElementPickerMessage({ type: 'unknown' })).toBeUndefined()
    expect(previewElementReference({ file: 'index.html', selector: '#hero > h1', tagName: 'h1', text: '  Systems   ready  ', outerHTML: '<h1>Systems ready</h1>' }))
      .toBe('[Selected element in index.html: #hero > h1 — “Systems ready”]')
    expect(previewSourceTokens('  <h1 class="hero">Ready</h1>')).toEqual([
      { text: '  ', kind: 'plain' },
      { text: '<h1', kind: 'tag' },
      { text: ' class=', kind: 'plain' },
      { text: '"hero"', kind: 'string' },
      { text: '>', kind: 'tag' },
      { text: 'Ready', kind: 'plain' },
      { text: '</h1', kind: 'tag' },
      { text: '>', kind: 'tag' },
    ])
  })

  it('splits bounded Office extraction output into ordered viewer sections', () => {
    expect(officePreviewSections({ content: '--- PPTX slide 1 ---\nOpening\n\n--- PPTX slide 2 ---\nClosing' })).toEqual([
      { title: 'PPTX slide 1', body: 'Opening', index: 1 },
      { title: 'PPTX slide 2', body: 'Closing', index: 2 },
    ])
    expect(officePreviewSections({ content: 'plain fallback' })).toEqual([{ title: 'Document', body: 'plain fallback', index: 1 }])
  })

  it('turns extracted spreadsheet tokens into readable cells while retaining provenance', () => {
    expect(spreadsheetCellDisplay('B2="99.99"')).toEqual({ reference: 'B2', value: '99.99' })
    expect(spreadsheetCellDisplay('C4="120" [formula: SUM(C2:C3)]')).toEqual({ reference: 'C4', value: '120', formula: 'Formula: SUM(C2:C3)' })
    expect(spreadsheetCellDisplay('unparsed')).toEqual({ reference: '', value: 'unparsed' })
  })
})

describe('tool labels', () => {
  it('keeps attachment item and byte continuation visible in the collapsed row', () => {
    expect(toolLabel('extract_attachment', {
      path: 'uploads/oversized-main-section.docx',
      item_start: 1,
      content_offset: 119_973,
    })).toBe('Read attachment uploads/oversized-main-section.docx:1 @ byte 119973')
  })

  it('uses Arena-style file-search labels', () => {
    expect(toolLabel('grep_files', { pattern: 'TODO|FIXME', path: 'src' })).toBe('Searched files for “TODO|FIXME” in src')
    expect(toolLabel('glob_files', { pattern: '**/*.test.ts' })).toBe('Found files matching **/*.test.ts')
  })

  it('uses Arena web protocol labels while retaining legacy trace playback', () => {
    expect(toolLabel('web_search', { query: 'HTTP 103 Early Hints', depth: '2' })).toBe('Searched the web')
    expect(toolLabel('search_web', { query: 'legacy trace' })).toBe('Searched the web')
    expect(toolLabel('web_search', { query: 'current state' }, 'running')).toBe('Searching the web...')
    expect(toolLabel('web_search', {}, 'running')).toBe('Searching the web...')
    expect(toolLabel('web_search', { query: 'current state' }, 'failed')).toBe('Search failed')
    expect(toolLabel('web_search', { query: 'current state' }, 'timed_out')).toBe('Search stopped')
    expect(toolLabel('web_fetch', { url: 'https://www.rfc-editor.org/rfc/rfc8297.html', format: 'markdown' })).toBe('Read www.rfc-editor.org/rfc/rfc8297.html')
    expect(toolLabel('fetch_media', { query: 'misty forest', media_type: 'image' })).toBe('Found media for “misty forest”')
    expect(toolLabel('generate_image', { file_path: 'assets/hero.png' })).toBe('Generated image')
    expect(toolLabel('generate_image', { file_path: 'assets/hero.png' }, 'running')).toBe('Generating images…')
  })

  it('labels every current active Agent operation without exposing raw snake_case names', () => {
    expect(toolLabel('write_file', { path: '/home/user/report.md' })).toBe('Wrote /home/user/report.md')
    expect(toolLabel('fetch_page', { url: 'https://example.com/docs', chunkIndex: 1 })).toBe('Read example.com/docs')
    expect(toolLabel('image_search', { query: 'quiet library' })).toBe('Searched images for "quiet library"')
    expect(toolLabel('image_search', { query: 'quiet library' }, 'running')).toBe('Searching images for "quiet library"')
    expect(toolLabel('image_search', {}, 'running')).toBe('Searching images…')
    expect(toolLabel('image_search', { query: 'quiet library' }, 'failed')).toBe('Image search failed')
    expect(toolLabel('image_search', { query: 'quiet library' }, 'timed_out')).toBe('Image search stopped')
    expect(toolLabel('present_file', { path: 'report.pdf' })).toBe('Presented report.pdf')
    expect(toolLabel('list_connector_tools', { service: 'github' })).toBe('Checked github')
    expect(toolLabel('list_connector_tools', { connector_slug: 'legacy-github' })).toBe('Checked legacy-github')
    expect(toolLabel('start_process', { name: 'Preview', command: 'npm run dev' })).toBe('Start Preview')
    expect(startProcessTimelineLabel({
      args: { name: 'ANERA Dev Server V1', command: 'npm run dev' },
      result: JSON.stringify({ new_ports: [{ port: 5173, address: '0.0.0.0' }] }),
    })).toBe('Start ANERA Dev Server V1 :5173')
    expect(toolLabel('get_process_output', { process_id: 'proc_123' })).toBe('Read process output')
    expect(toolLabel('stop_process', { process_id: 'proc_123' })).toBe('Stopped process proc_123')
    expect(toolLabel('generate_speech', { file_path: 'audio/final.mp3' })).toBe('Generated speech')
    expect(toolLabel('generate_speech', { file_path: 'audio/final.mp3' }, 'running')).toBe('Generating speech…')
    expect(toolLabel('compact', {})).toBe('Compacted conversation context')
  })

  it('uses Arena package/build/start labels without exposing legacy protocol names', () => {
    expect(toolLabel('install_npm_packages', { packages: ['vite@5.4.19', 'react@19.1.1'] })).toBe('Installed vite@5.4.19, react@19.1.1')
    expect(toolLabel('install_npm_packages', { packages: [] })).toBe('Installed npm packages')
    expect(toolLabel('build_project', {})).toBe('Built project')
    expect(toolLabel('build_and_start', { description: 'production preview' })).toBe('Built and started production preview')
    expect(toolLabel('deploy_project', {})).toBe('Deployed project')
    expect(toolLabel('bash', { command: 'npm test', description: 'Run the unit tests' })).toBe('used Bash')
    expect(toolLabel('shell_command', { command: 'pwd' })).toBe('used Bash')
  })
})

describe('pasted Agent images', () => {
  it('matches Arena filename extension derivation from MIME, source name, and fallback', () => {
    expect(pastedImageExtension({ type: 'image/png', name: 'clipboard' })).toBe('png')
    expect(pastedImageExtension({ type: 'image/webp; charset=binary', name: 'clipboard' })).toBe('webp')
    expect(pastedImageExtension({ type: '', name: 'capture.jpeg' })).toBe('jpeg')
    expect(pastedImageExtension({ type: '', name: 'clipboard' })).toBe('png')
  })
})

describe('client timeline projection', () => {
  it('shows Orchestrating immediately for assistant.started and removes it at the next visible activity', () => {
    const started = projectTimeline(fixture([
      event(1, 'turn.started', { content: 'Inspect the workspace.', attachments: [] }, 'step_turn'),
      event(2, 'assistant.started', { step: 1 }, 'step_model'),
    ]))
    expect(started).toMatchObject([
      { kind: 'user', content: 'Inspect the workspace.' },
      { kind: 'activity', label: 'Orchestrating...' },
    ])
    const activity = started.find((item) => item.kind === 'activity')
    if (activity?.kind !== 'activity') throw new Error('Expected assistant activity')
    const markup = renderToStaticMarkup(<AssistantActivityRow item={activity} />)
    expect(markup).toContain('role="status"')
    expect(markup).toContain('Orchestrating...')

    const thinking = projectTimeline(fixture([
      event(1, 'turn.started', { content: 'Inspect the workspace.', attachments: [] }, 'step_turn'),
      event(2, 'assistant.started', { step: 1 }, 'step_model'),
      event(3, 'assistant.thought.started', { step: 1 }, 'step_model'),
    ]))
    expect(thinking.some((item) => item.kind === 'activity')).toBe(false)
    expect(thinking.find((item) => item.kind === 'thought')).toMatchObject({ running: true })

    const terminal = fixture([event(1, 'assistant.started', { step: 1 }, 'step_model')])
    terminal.session.status = 'interrupted'
    expect(projectTimeline(terminal).some((item) => item.kind === 'activity')).toBe(false)
  })

  it('preserves operation-specific approval risk copy for the desktop card', () => {
    const call = {
      id: 'call_pr_close',
      name: 'bash',
      arguments: { command: 'gh pr close --comment "Superseded"' },
    }
    const timeline = projectTimeline(fixture([
      event(1, 'tool.started', { call }, 'step_pr_close', call.id),
      event(2, 'approval.required', {
        approvalId: 'approval_pr_close',
        call,
        title: 'Approve pull request closure?',
        description: 'This closes the pull request for the fixed session branch in the connected repository.',
      }, 'step_pr_close', call.id),
    ]))

    const approval = timeline.find((item) => item.kind === 'approval')
    expect(approval).toMatchObject({
      kind: 'approval',
      approvalId: 'approval_pr_close',
      title: 'Approve pull request closure?',
      description: 'This closes the pull request for the fixed session branch in the connected repository.',
      decision: 'pending',
    })
    expect(approval?.kind).toBe('approval')
    if (approval?.kind !== 'approval') throw new Error('Expected projected approval')
    const markup = renderToStaticMarkup(<ApprovalCard item={approval} onDecision={async () => {}} />)
    expect(markup).toContain('Approve pull request closure?')
    expect(markup).toContain('This closes the pull request for the fixed session branch in the connected repository.')
  })

  it('replays structured HITL requests through resolved and expired states without showing duplicate tool rows', () => {
    const askCall = {
      id: 'call_ask_replay',
      name: 'ask_user',
      arguments: { questions: [{ id: 'scope', question: 'Which scope?', options: [{ label: 'Small' }, { label: 'Large' }] }] },
    }
    const voiceCall = {
      id: 'call_voice_replay',
      name: 'add_voice',
      arguments: { language: 'en-US', text: 'Sample', voice_identity: { index: 0 } },
    }
    const timeline = projectTimeline(fixture([
      event(1, 'tool.started', { call: askCall }, 'step_ask', askCall.id),
      event(2, 'hitl.required', {
        hitlId: 'hitl_ask_replay', kind: 'ask_user', call: askCall, title: 'Choose scope', payload: askCall.arguments,
      }, 'step_ask', askCall.id),
      event(3, 'hitl.resolved', {
        hitlId: 'hitl_ask_replay', kind: 'ask_user', response: { status: 'answered', answers: [{ question_id: 'scope', selected: ['Small'] }] },
      }, 'step_ask', askCall.id),
      event(4, 'tool.completed', { call: askCall, result: '{"status":"answered"}', isError: false }, 'step_ask', askCall.id),
      event(5, 'tool.started', { call: voiceCall }, 'step_voice', voiceCall.id),
      event(6, 'hitl.required', {
        hitlId: 'hitl_voice_replay', kind: 'add_voice', call: voiceCall, title: 'Choose voice', payload: { candidates: [] },
      }, 'step_voice', voiceCall.id),
      event(7, 'hitl.expired', { hitlId: 'hitl_voice_replay', kind: 'add_voice', reason: 'server_restarted' }, 'step_voice', voiceCall.id),
    ]))
    expect(timeline).toEqual([
      expect.objectContaining({
        kind: 'hitl', hitlId: 'hitl_ask_replay', hitlKind: 'ask_user', decision: 'resolved',
        response: { status: 'answered', answers: [{ question_id: 'scope', selected: ['Small'] }] },
      }),
      {
        kind: 'user', key: 'hitl-answer:hitl_ask_replay', content: 'Small', attachments: [],
      },
      expect.objectContaining({
        kind: 'hitl', hitlId: 'hitl_voice_replay', hitlKind: 'add_voice', decision: 'expired',
      }),
    ])
  })

  it('projects one deterministic multi-question answer bubble immediately after its HITL card', () => {
    const askCall = {
      id: 'call_multi_question',
      name: 'ask_user',
      arguments: {
        questions: [
          {
            id: 'tone',
            question: 'Which tone?',
            options: [{ id: 'concise', label: 'Concise' }, { id: 'detailed', label: 'Detailed' }],
          },
          {
            id: 'constraints',
            question: 'Any constraints?',
            options: [{ id: 'none', label: 'None' }],
          },
        ],
      },
    }
    const snapshot = fixture([
      event(1, 'hitl.required', {
        hitlId: 'hitl_multi_question', kind: 'ask_user', call: askCall,
        title: 'A few questions', payload: askCall.arguments,
      }, 'step_multi', askCall.id),
      event(2, 'assistant.thought.started', {}, 'step_between'),
      event(3, 'hitl.resolved', {
        hitlId: 'hitl_multi_question', kind: 'ask_user', response: {
          skipped: false,
          answers: [
            { questionId: 'tone', selectedOptionId: 'concise', customResponse: null },
            { questionId: 'constraints', selectedOptionId: null, customResponse: 'Keep the original charts' },
          ],
        },
      }, 'step_multi', askCall.id),
      event(4, 'hitl.resolved', {
        hitlId: 'hitl_multi_question', kind: 'ask_user', response: {
          skipped: false,
          answers: [
            { questionId: 'tone', selectedOptionId: 'concise', customResponse: null },
            { questionId: 'constraints', selectedOptionId: null, customResponse: 'Keep the original charts' },
          ],
        },
      }, 'step_multi', askCall.id),
    ])

    const firstProjection = projectTimeline(snapshot)
    const reloadedProjection = projectTimeline(JSON.parse(JSON.stringify(snapshot)) as SessionSnapshot)
    expect(reloadedProjection).toEqual(firstProjection)
    expect(firstProjection.map((item) => item.key)).toEqual([
      'hitl-hitl_multi_question',
      'hitl-answer:hitl_multi_question',
      'thought-step_between',
    ])
    expect(firstProjection.filter((item) => item.key === 'hitl-answer:hitl_multi_question')).toEqual([{
      kind: 'user',
      key: 'hitl-answer:hitl_multi_question',
      content: 'Which tone? — Concise\nAny constraints? — Keep the original charts',
      attachments: [],
    }])
  })

  it('does not invent user answers for skipped or expired HITL requests', () => {
    const skippedCall = {
      id: 'call_skipped_question',
      name: 'ask_user',
      arguments: { questions: [{ id: 'scope', question: 'Which scope?', options: [{ id: 'small', label: 'Small' }] }] },
    }
    const expiredCall = {
      id: 'call_expired_image',
      name: 'generate_image',
      arguments: { offer_options: true },
    }
    const timeline = projectTimeline(fixture([
      event(1, 'hitl.required', {
        hitlId: 'hitl_skipped_question', kind: 'ask_user', call: skippedCall,
        title: 'Choose scope', payload: skippedCall.arguments,
      }, 'step_skipped', skippedCall.id),
      event(2, 'hitl.resolved', {
        hitlId: 'hitl_skipped_question', kind: 'ask_user', response: { skipped: true, answers: [] },
      }, 'step_skipped', skippedCall.id),
      event(3, 'hitl.required', {
        hitlId: 'hitl_expired_image', kind: 'generate_image', call: expiredCall,
        title: 'Choose image', payload: { candidates: [{ id: 'first', index: 0 }] },
      }, 'step_expired', expiredCall.id),
      event(4, 'hitl.expired', {
        hitlId: 'hitl_expired_image', kind: 'generate_image', reason: 'server_restarted',
      }, 'step_expired', expiredCall.id),
    ]))

    expect(timeline.filter((item) => item.kind === 'user')).toEqual([])
    expect(timeline).toMatchObject([
      { kind: 'hitl', hitlId: 'hitl_skipped_question', decision: 'resolved', response: { skipped: true } },
      { kind: 'hitl', hitlId: 'hitl_expired_image', decision: 'expired' },
    ])
  })

  it('summarizes plan, voice, and image selections as visible user choices', () => {
    const planCall = { id: 'call_plan_answer', name: 'propose_plan', arguments: { path: 'PLAN.md' } }
    const voiceCall = { id: 'call_voice_answer', name: 'add_voice', arguments: { text: 'Hello' } }
    const imageCall = { id: 'call_image_answer', name: 'generate_image', arguments: { offer_options: true } }
    const timeline = projectTimeline(fixture([
      event(1, 'hitl.required', {
        hitlId: 'hitl_plan_answer', kind: 'propose_plan', call: planCall,
        title: 'Review plan', payload: planCall.arguments,
      }, 'step_plan', planCall.id),
      event(2, 'hitl.resolved', {
        hitlId: 'hitl_plan_answer', kind: 'propose_plan', response: { decision: 'revise', feedback: 'Add rollback steps' },
      }, 'step_plan', planCall.id),
      event(3, 'hitl.required', {
        hitlId: 'hitl_voice_answer', kind: 'add_voice', call: voiceCall,
        title: 'Choose voice', payload: { candidates: [{ id: 'voice-a', label: 'Warm narrator' }] },
      }, 'step_voice', voiceCall.id),
      event(4, 'hitl.resolved', {
        hitlId: 'hitl_voice_answer', kind: 'add_voice', response: { candidate_id: 'voice-a', voice_id: 'voice-01' },
      }, 'step_voice', voiceCall.id),
      event(5, 'hitl.required', {
        hitlId: 'hitl_image_answer', kind: 'generate_image', call: imageCall,
        title: 'Choose image', payload: { candidates: [{ id: 'image-a', index: 0 }, { id: 'image-b', index: 1 }] },
      }, 'step_image', imageCall.id),
      event(6, 'hitl.resolved', {
        hitlId: 'hitl_image_answer', kind: 'generate_image', response: { skipped: false, selected_index: 1 },
      }, 'step_image', imageCall.id),
    ]))

    expect(timeline.filter((item) => item.kind === 'user').map((item) => item.content)).toEqual([
      'Request changes: Add rollback steps',
      'Use voice: Warm narrator',
      'Use image option 2',
    ])
  })

  it('projects an offer_options image choice as one HITL row and replays the selected candidate', () => {
    const imageCall = {
      id: 'call_image_options',
      name: 'generate_image',
      arguments: { file_path: 'images/hero.png', prompt: 'Geometric landscape', offer_options: true },
    }
    const candidates = [
      { id: 'candidate-a', index: 0, path: '.arena/image-options/candidate-a.png' },
      { id: 'candidate-b', index: 1, path: '.arena/image-options/candidate-b.png' },
    ]
    const timeline = projectTimeline(fixture([
      event(1, 'tool.started', { call: imageCall }, 'step_image', imageCall.id),
      event(2, 'hitl.required', {
        hitlId: 'hitl_image_options', kind: 'generate_image', call: imageCall,
        title: 'Choose an image', payload: { candidates, file_path: 'images/hero.png' },
      }, 'step_image', imageCall.id),
      event(3, 'hitl.resolved', {
        hitlId: 'hitl_image_options', kind: 'generate_image', response: { skipped: false, selected_index: 1 },
      }, 'step_image', imageCall.id),
      event(4, 'tool.completed', { call: imageCall, result: '{"status":"success"}', isError: false }, 'step_image', imageCall.id),
    ]))

    expect(timeline).toHaveLength(2)
    expect(timeline[0]).toMatchObject({
      kind: 'hitl',
      hitlId: 'hitl_image_options',
      hitlKind: 'generate_image',
      decision: 'resolved',
      response: { skipped: false, selected_index: 1 },
      payload: { candidates, file_path: 'images/hero.png' },
    })
    expect(timeline[1]).toEqual({
      kind: 'user', key: 'hitl-answer:hitl_image_options', content: 'Use image option 2', attachments: [],
    })
  })

  it('renders the desktop image-choice card with encoded candidates and explicit select/skip actions', () => {
    const markup = renderToStaticMarkup(<ImageSelectionHitl
      item={{
        kind: 'hitl',
        key: 'hitl-image-desktop',
        hitlId: 'hitl_image_desktop',
        hitlKind: 'generate_image',
        title: 'Choose an image',
        call: { name: 'generate_image', arguments: { offer_options: true } },
        payload: {
          candidates: [
            { id: 'candidate-one', index: 0, path: '.arena/options/first image.png' },
            { id: 'candidate-two', index: 1, path: '.arena/options/second.png' },
          ],
        },
        decision: 'pending',
      }}
      sessionId="ses_1234567890abcdefghij"
      onResponse={async () => undefined}
    />)

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-label="Choose an image"')
    expect(markup).toContain('/workspace/ses_1234567890abcdefghij/file?path=.arena%2Foptions%2Ffirst%20image.png')
    expect(markup).toContain('alt="Generated option 1"')
    expect(markup).toContain('Use option 1')
    expect(markup).toContain('Use option 2')
    expect(markup).toContain('Skip all')
  })

  it('combines streamed final chunks and finalizes them without duplication', () => {
    const snapshot = fixture([
      event(1, 'assistant.final.delta', { delta: 'Delivered ' }, 'step_final'),
      event(2, 'assistant.final.delta', { delta: 'the result.' }, 'step_final'),
      event(3, 'assistant.final', { content: 'Delivered the result.', finishReason: 'stop' }, 'step_final'),
    ])

    expect(projectTimeline(snapshot)).toEqual([
      {
        kind: 'final',
        key: 'final-step_final',
        content: 'Delivered the result.',
        streaming: false,
        feedback: null,
        messageEventId: 'evt_00000000000000000003',
      },
    ])
  })

  it('replays pointwise Like, Dislike, and clear feedback against the addressed Final', () => {
    const baseEvents = [
      event(1, 'assistant.final', { content: 'First response.' }, 'step_first'),
      event(2, 'assistant.final', { content: 'Second response.' }, 'step_second'),
    ]

    const liked = projectTimeline(fixture([
      ...baseEvents,
      event(3, 'feedback.updated', { messageEventId: 'evt_00000000000000000001', value: 'upvote' }, 'step_first'),
    ]))
    expect(liked.filter((item) => item.kind === 'final')).toMatchObject([
      { messageEventId: 'evt_00000000000000000001', feedback: 'upvote' },
      { messageEventId: 'evt_00000000000000000002', feedback: null },
    ])

    const disliked = projectTimeline(fixture([
      ...baseEvents,
      event(3, 'feedback.updated', { messageEventId: 'evt_00000000000000000001', value: 'upvote' }, 'step_first'),
      event(4, 'feedback.updated', { messageEventId: 'evt_00000000000000000001', value: 'downvote' }, 'step_first'),
    ]))
    expect(disliked[0]).toMatchObject({ kind: 'final', feedback: 'downvote' })

    const cleared = projectTimeline(fixture([
      ...baseEvents,
      event(3, 'feedback.updated', { messageEventId: 'evt_00000000000000000001', value: 'downvote' }, 'step_first'),
      event(4, 'feedback.updated', { messageEventId: 'evt_00000000000000000001', value: null }, 'step_first'),
    ]))
    expect(cleared[0]).toMatchObject({ kind: 'final', feedback: null })
  })

  it('reclassifies streamed content as progress when the same model step calls tools', () => {
    const call = { id: 'call_read', name: 'read_file', arguments: { path: 'input.txt' } }
    const snapshot = fixture([
      event(1, 'assistant.final.delta', { delta: 'I will inspect the input.' }, 'step_tool'),
      event(2, 'assistant.thought.started', { step: 1, visibleProgress: true }, 'step_tool'),
      event(3, 'assistant.thought.completed', { text: 'I will inspect the input.', visibleProgress: true }, 'step_tool'),
      event(4, 'tool.started', { call }, 'step_tool', call.id),
      event(5, 'tool.completed', { call, result: 'contents', isError: false }, 'step_tool', call.id),
    ])

    const timeline = projectTimeline(snapshot)
    expect(timeline.filter((item) => item.kind === 'final')).toEqual([])
    expect(timeline.filter((item) => item.kind === 'thought')).toEqual([
      { kind: 'thought', key: 'thought-step_tool-progress', label: 'Thought for less than a second', content: 'I will inspect the input.', running: false },
    ])
    expect(timeline.filter((item) => item.kind === 'exploration')).toEqual([
      {
        kind: 'exploration',
        key: 'exploration-tool-call_read',
        tools: [{ kind: 'tool', key: 'tool-call_read', name: 'read_file', args: { path: 'input.txt' }, result: 'contents', status: 'succeeded', durationMs: 1 }],
      },
    ])
  })

  it('lets a durable same-step Final replace provisional streamed progress', () => {
    const call = { id: 'call_verify', name: 'bash', arguments: { command: 'npm test' } }
    const snapshot = fixture([
      event(1, 'tool.started', { call }, 'step_terminal', call.id),
      event(2, 'tool.completed', { call, result: 'passed', isError: false }, 'step_terminal', call.id),
      event(3, 'assistant.final.delta', { delta: 'Verification passed.' }, 'step_terminal'),
      event(4, 'assistant.final', { content: 'Verification passed.', finishReason: 'stop' }, 'step_terminal'),
    ])
    snapshot.session.status = 'completed'

    const timeline = projectTimeline(snapshot)
    expect(timeline.filter((item) => item.kind === 'thought')).toEqual([])
    expect(timeline.filter((item) => item.kind === 'final')).toEqual([{
      kind: 'final',
      key: 'final-step_terminal',
      content: 'Verification passed.',
      streaming: false,
      feedback: null,
      messageEventId: 'evt_00000000000000000004',
    }])
  })

  it('never leaves a Thought running after a completed terminal snapshot', () => {
    const snapshot = fixture([
      event(1, 'assistant.thought.started', { step: 1 }, 'step_terminal_thought'),
      event(2, 'assistant.thought.delta', { delta: 'Finishing verification.' }, 'step_terminal_thought'),
    ])
    snapshot.session.status = 'completed'

    expect(projectTimeline(snapshot).find((item) => item.kind === 'thought')).toMatchObject({
      content: 'Finishing verification.',
      running: false,
    })
  })

  it('groups consecutive exploration tools in start order and preserves mutation boundaries and failures', () => {
    const list = { id: 'call_list', name: 'list_files', arguments: { path: 'src' } }
    const read = { id: 'call_read', name: 'read_file', arguments: { path: 'src/app.ts' } }
    const write = { id: 'call_write', name: 'create_file', arguments: { path: 'out.txt', content: 'ok\n' } }
    const grep = { id: 'call_grep', name: 'grep_files', arguments: { pattern: 'TODO', path: 'src' } }
    const timeline = projectTimeline(fixture([
      event(1, 'tool.started', { call: list }, 'step_parallel', list.id),
      event(2, 'tool.started', { call: read }, 'step_parallel', read.id),
      event(3, 'tool.completed', { call: read, result: 'app source', isError: false }, 'step_parallel', read.id),
      event(4, 'tool.completed', { call: list, result: 'src/app.ts', isError: false }, 'step_parallel', list.id),
      event(5, 'tool.started', { call: write }, 'step_write', write.id),
      event(6, 'tool.completed', { call: write, result: '{"status":"success"}', isError: false }, 'step_write', write.id),
      event(7, 'tool.started', { call: grep }, 'step_grep', grep.id),
      event(8, 'tool.failed', { call: grep, result: 'invalid expression', isError: true }, 'step_grep', grep.id),
    ]))

    expect(timeline.map((item) => item.kind)).toEqual(['exploration', 'tool', 'exploration'])
    expect(timeline[0]).toMatchObject({
      kind: 'exploration',
      tools: [
        { key: 'tool-call_list', name: 'list_files', status: 'succeeded', result: 'src/app.ts' },
        { key: 'tool-call_read', name: 'read_file', status: 'succeeded', result: 'app source' },
      ],
    })
    expect(timeline[1]).toMatchObject({ kind: 'tool', name: 'create_file', status: 'succeeded' })
    expect(timeline[2]).toMatchObject({
      kind: 'exploration',
      tools: [{ key: 'tool-call_grep', name: 'grep_files', status: 'failed', result: 'invalid expression' }],
    })
  })

  it('closes a running exploration child when replayed terminal state is interrupted', () => {
    const read = { id: 'call_read_hung', name: 'read_file', arguments: { path: 'large.txt' } }
    const snapshot = fixture([event(1, 'tool.started', { call: read }, 'step_read_hung', read.id)])
    snapshot.session.status = 'interrupted'
    expect(projectTimeline(snapshot)).toMatchObject([{
      kind: 'exploration',
      tools: [{ name: 'read_file', status: 'failed' }],
    }])
  })

  it('projects partial stdout and stderr while a foreground tool is still running', () => {
    const call = { id: 'call_shell', name: 'bash', arguments: { command: 'python3 -u probe.py' } }
    const timeline = projectTimeline(fixture([
      event(1, 'tool.started', { call }, 'step_shell', call.id),
      event(2, 'tool.output', { stream: 'stdout', chunk: 'START\n' }, 'step_shell', call.id),
      event(3, 'tool.output', { stream: 'stderr', chunk: 'warning\n' }, 'step_shell', call.id),
    ]))

    expect(timeline).toEqual([{
      kind: 'tool-group',
      key: 'commands-tool-call_shell',
      variant: 'commands',
      tools: [{
        kind: 'tool',
        key: 'tool-call_shell',
        name: 'bash',
        args: { command: 'python3 -u probe.py' },
        result: 'stdout:\nSTART\n\nstderr:\nwarning\n',
        liveOutput: { stdout: 'START\n', stderr: 'warning\n' },
        status: 'running',
        autoExpanded: true,
      }],
    }])
  })

  it('uses the current Arena execution-log groups for adjacent commands and file edits', () => {
    const firstCommand = { id: 'call_cmd_1', name: 'bash', arguments: { command: 'npm test' } }
    const secondCommand = { id: 'call_cmd_2', name: 'bash', arguments: { command: 'npm run build' } }
    const write = { id: 'call_write', name: 'write_file', arguments: { path: 'report.md', content: '# Report\n' } }
    const edit = { id: 'call_edit', name: 'edit_file', arguments: { path: 'report.md', old_text: 'Report', new_text: 'Verified report' } }
    const timeline = projectTimeline(fixture([
      event(1, 'tool.started', { call: firstCommand }, 'step_commands', firstCommand.id),
      event(2, 'tool.started', { call: secondCommand }, 'step_commands', secondCommand.id),
      event(3, 'tool.completed', { call: firstCommand, result: '{"status":"success"}' }, 'step_commands', firstCommand.id),
      event(4, 'tool.completed', { call: secondCommand, result: '{"status":"success"}' }, 'step_commands', secondCommand.id),
      event(5, 'tool.started', { call: write }, 'step_files', write.id),
      event(6, 'tool.started', { call: edit }, 'step_files', edit.id),
      event(7, 'tool.completed', { call: write, result: '{"status":"success"}' }, 'step_files', write.id),
      event(8, 'tool.failed', { call: edit, result: '{"status":"error"}' }, 'step_files', edit.id),
    ]))

    expect(timeline).toMatchObject([
      {
        kind: 'tool-group',
        variant: 'commands',
        tools: [
          { name: 'bash', status: 'succeeded' },
          { name: 'bash', status: 'succeeded' },
        ],
      },
      {
        kind: 'tool-group',
        variant: 'files',
        tools: [
          { name: 'write_file', status: 'succeeded' },
          { name: 'edit_file', status: 'failed' },
        ],
      },
    ])
  })

  it('updates rewritten artifacts and removes cards whose file was deleted', () => {
    const first = artifact('art_first', 'report.md', '2026-08-28T00:00:00.000Z')
    const second = artifact('art_second', 'report.md', '2026-08-28T00:00:01.000Z')
    const deleted = artifact('art_deleted', 'gone.txt', '2026-08-28T00:00:00.000Z')
    const timeline = projectTimeline(fixture([
      event(1, 'artifact.created', { artifact: first }, 'step_artifact'),
      event(2, 'artifact.created', { artifact: second }, 'step_artifact'),
      event(3, 'artifact.created', { artifact: deleted }, 'step_artifact'),
      event(4, 'artifact.removed', { artifact: deleted, path: deleted.path }, 'step_artifact'),
    ]))

    expect(timeline).toEqual([{ kind: 'artifact', key: 'artifact-report.md', artifact: second }])
  })

  it('projects plan snapshots as one stable independent card and hides the duplicate tool row', () => {
    const updateCall = {
      id: 'call_plan',
      name: 'update_plan',
      arguments: { plan: [{ step: 'Inspect files', status: 'in_progress' }, { step: 'Verify result', status: 'pending' }] },
    }
    const first = {
      items: [
        { id: 'plan_inspect', step: 'Inspect files', status: 'in_progress' as const },
        { id: 'plan_verify', step: 'Verify result', status: 'pending' as const },
      ],
      explanation: 'Starting with the workspace.',
      updatedAt: '2026-08-28T00:00:00.002Z',
      version: 1,
    }
    const second = {
      ...first,
      items: [
        { id: 'plan_inspect', step: 'Inspect files', status: 'completed' as const },
        { id: 'plan_verify', step: 'Verify result', status: 'in_progress' as const },
      ],
      explanation: 'Files inspected; validating now.',
      version: 2,
    }
    const timeline = projectTimeline(fixture([
      event(1, 'tool.started', { call: updateCall }, 'step_plan', updateCall.id),
      event(2, 'plan.updated', { plan: first, explanation: first.explanation }, 'step_plan', updateCall.id),
      event(3, 'tool.completed', { call: updateCall, result: '{"status":"success"}', isError: false }, 'step_plan', updateCall.id),
      event(4, 'plan.updated', { plan: second, explanation: second.explanation }, 'step_plan_2', 'call_plan_2'),
    ]))

    expect(timeline).toEqual([{ kind: 'plan', key: 'plan-ses_aaaaaaaaaaaaaaaaaaaa', plan: second }])
  })

  it('restores the persisted current plan when historical plan events are unavailable', () => {
    const snapshot = fixture([])
    snapshot.plan = {
      items: [{ id: 'plan_resume', step: 'Resume from state', status: 'in_progress' }],
      updatedAt: '2026-08-28T00:00:00.000Z',
      version: 3,
    }
    expect(projectTimeline(snapshot)).toEqual([{
      kind: 'plan',
      key: 'plan-ses_aaaaaaaaaaaaaaaaaaaa',
      plan: snapshot.plan,
    }])
  })

  it('closes partial streamed UI items when a run reaches a terminal interruption', () => {
    const call = { id: 'call_hung', name: 'bash', arguments: { command: 'python3 hung.py' } }
    const snapshot = fixture([
      event(1, 'assistant.thought.started', { step: 1 }, 'step_thought'),
      event(2, 'tool.started', { call }, 'step_tool', call.id),
      event(3, 'assistant.final.delta', { delta: 'Partial answer' }, 'step_final'),
      event(4, 'error', { message: 'Run interrupted.', cancelled: false }, 'step_final'),
    ])
    snapshot.session.status = 'interrupted'

    const timeline = projectTimeline(snapshot)
    expect(timeline.find((item) => item.kind === 'thought')).toMatchObject({ running: false })
    expect(timeline.find((item) => item.kind === 'tool-group')).toMatchObject({
      variant: 'commands',
      tools: [{ status: 'failed' }],
    })
    expect(timeline.find((item) => item.kind === 'final')).toMatchObject({ content: 'Partial answer', streaming: false })
  })

  it('projects a provider-rejected retry as a generic error without inventing a Final', () => {
    const message = 'The AI service rejected this request. Please adjust your message or attachments and try again.'
    const snapshot = fixture([
      event(1, 'turn.started', {
        content: 'Use only the uploaded orders CSV and pricing rules.',
        attachments: ['uploads/M04_orders.csv', 'uploads/M04_pricing_rules.md'],
      }, 'step_provider_rejected'),
      event(2, 'error', { message, cancelled: false, timedOut: false }, 'step_provider_rejected'),
    ])
    snapshot.session.status = 'failed'

    const timeline = projectTimeline(snapshot)
    expect(timeline.find((item) => item.kind === 'error')).toEqual({
      kind: 'error',
      key: 'evt_00000000000000000002',
      content: message,
      cancelled: false,
    })
    expect(timeline.some((item) => item.kind === 'final')).toBe(false)
  })
})

describe('live snapshot projection', () => {
  it('updates durable side panels immediately from SSE events', () => {
    const created = artifact('art_live', 'live.md', '2026-08-28T00:00:00.001Z')
    const process = {
      id: 'proc_live', sessionId: 'ses_aaaaaaaaaaaaaaaaaaaa', command: 'npm run dev',
      status: 'running' as const, startedAt: '2026-08-28T00:00:00.002Z',
    }
    const verifiedProcess = {
      ...process,
      port: 43129,
      listeningPorts: [{ port: 43129, address: '0.0.0.0' }],
      newPorts: [{ port: 43129, address: '0.0.0.0' }],
    }
    const website = {
      status: 'running' as const, processId: process.id, port: 43129,
      previewUrl: '/workspace/site', updatedAt: '2026-08-28T00:00:00.003Z', restartCount: 0,
    }
    const deployment = {
      status: 'deployed' as const, id: 'dep_live', url: '/deploy/dep_live', visibility: 'local' as const,
      revision: 1, updatedAt: '2026-08-28T00:00:00.004Z',
    }
    const plan = {
      items: [{ id: 'plan_live', step: 'Verify live state', status: 'in_progress' as const }],
      updatedAt: '2026-08-28T00:00:00.005Z', version: 1,
    }
    const events = [
      event(1, 'artifact.created', { artifact: created }, 'step_live'),
      event(2, 'process.started', { record: process }, 'step_live'),
      event(3, 'process.updated', { type: 'updated', record: verifiedProcess }, 'step_live'),
      event(4, 'website.updated', { website }, 'step_live'),
      event(5, 'deployment.updated', { deployment }, 'step_live'),
      event(6, 'plan.updated', { plan }, 'step_live'),
    ]
    const projected = events.reduce(applyEventToSnapshot, fixture([]))

    expect(projected.artifacts).toEqual([created])
    expect(projected.processes).toEqual([verifiedProcess])
    expect(projected.website).toEqual(website)
    expect(projected.deployment).toEqual(deployment)
    expect(projected.plan).toEqual(plan)
  })

  it('does not let duplicate or out-of-order SSE events roll a panel backward', () => {
    const running = { status: 'running' as const, port: 43129, updatedAt: '2026-08-28T00:00:00.002Z', restartCount: 0 }
    const stopped = { status: 'stopped' as const, updatedAt: '2026-08-28T00:00:00.003Z', restartCount: 0 }
    const startEvent = event(2, 'website.updated', { website: running }, 'step_live')
    const stopEvent = event(3, 'website.updated', { website: stopped }, 'step_live')
    let projected = applyEventToSnapshot(fixture([]), startEvent)
    projected = applyEventToSnapshot(projected, stopEvent)
    expect(projected.website.status).toBe('stopped')
    expect(applyEventToSnapshot(projected, startEvent).website.status).toBe('stopped')

    const unseenOlder = { ...startEvent, id: 'evt_unseen_older' }
    expect(applyEventToSnapshot(projected, unseenOlder).website.status).toBe('stopped')
  })

  it('rejects a stale refresh and hydrates a fresh but non-atomic snapshot from its events', () => {
    const running = { status: 'running' as const, port: 43129, updatedAt: '2026-08-28T00:00:00.002Z', restartCount: 0 }
    const liveEvent = event(2, 'website.updated', { website: running }, 'step_live')
    const current = applyEventToSnapshot(fixture([]), liveEvent)
    const stale = fixture([event(1, 'assistant.started', { step: 1 }, 'step_old')])
    expect(reconcileSnapshot(current, stale)).toBe(current)

    const nonAtomic = fixture([liveEvent])
    nonAtomic.website = { status: 'stopped', updatedAt: '2026-08-28T00:00:00.000Z', restartCount: 0 }
    expect(reconcileSnapshot(undefined, nonAtomic).website).toEqual(running)
  })
})

describe('task review projection', () => {
  it('opens only for the latest stable Final in a completed session', () => {
    const snapshot = fixture([
      event(1, 'assistant.final', { content: 'First response.' }, 'step_first'),
      event(2, 'assistant.final', { content: 'Latest response.' }, 'step_latest'),
    ])
    snapshot.session.status = 'completed'
    expect(resolveTaskReview(snapshot)).toEqual({
      messageEventId: 'evt_00000000000000000002',
      turnId: 'turn_fixture',
      stepId: 'step_latest',
    })

    snapshot.session.status = 'running'
    expect(resolveTaskReview(snapshot)).toBeUndefined()
  })

  it('closes after Yes or No feedback on the addressed Final', () => {
    for (const value of ['upvote', 'downvote'] as const) {
      const snapshot = fixture([
        event(1, 'assistant.final', { content: 'Reviewed response.' }, 'step_final'),
        event(2, 'feedback.updated', { messageEventId: 'evt_00000000000000000001', value }, 'step_final'),
      ])
      snapshot.session.status = 'completed'
      expect(resolveTaskReview(snapshot)).toBeUndefined()
    }
  })

  it('closes durably after Continue working or dismissal without treating old Finals as current', () => {
    for (const action of ['continue', 'dismiss'] as const) {
      const snapshot = fixture([
        event(1, 'assistant.final', { content: 'First response.' }, 'step_first'),
        event(2, 'review.dismissed', { messageEventId: 'evt_00000000000000000001', action }, 'step_first'),
      ])
      snapshot.session.status = 'completed'
      expect(resolveTaskReview(snapshot)).toBeUndefined()
    }

    const latest = fixture([
      event(1, 'assistant.final', { content: 'First response.' }, 'step_first'),
      event(2, 'review.dismissed', { messageEventId: 'evt_00000000000000000001', action: 'continue' }, 'step_first'),
      event(3, 'assistant.final', { content: 'Second response.' }, 'step_second'),
    ])
    latest.session.status = 'completed'
    expect(resolveTaskReview(latest)?.messageEventId).toBe('evt_00000000000000000003')
  })

  it('does not let feedback on an older Final suppress a new task review', () => {
    const snapshot = fixture([
      event(1, 'assistant.final', { content: 'First response.' }, 'step_first'),
      event(2, 'feedback.updated', { messageEventId: 'evt_00000000000000000001', value: 'upvote' }, 'step_first'),
      event(3, 'assistant.final', { content: 'Second response.' }, 'step_second'),
    ])
    snapshot.session.status = 'completed'
    expect(resolveTaskReview(snapshot)?.messageEventId).toBe('evt_00000000000000000003')
  })

  it('derives an undo candidate from the last visible user turn and blocks it after compaction', () => {
    const priorTurn = 'turn_prior'
    const targetTurn = 'turn_target'
    const events = [
      { ...event(1, 'turn.started', { content: 'Earlier prompt', attachments: [] }, 'step_prior'), turnId: priorTurn },
      { ...event(2, 'assistant.final', { content: 'Earlier answer' }, 'step_prior'), turnId: priorTurn },
      { ...event(3, 'turn.started', { content: 'Original prompt', attachments: ['uploads/input.txt'] }, 'step_target'), turnId: targetTurn },
      { ...event(4, 'assistant.final', { content: 'Latest answer' }, 'step_target'), turnId: targetTurn },
    ]
    const snapshot = fixture(events)
    snapshot.session.status = 'completed'
    snapshot.session.feedbackType = 'check_in'
    expect(resolveUndoTurnCandidate(snapshot, 'evt_00000000000000000004')).toEqual({
      sessionNodeId: 'evt_00000000000000000004',
      promptText: 'Original prompt',
      targetTurnIds: [targetTurn],
    })

    snapshot.events.splice(3, 0, {
      ...event(5, 'context.compacted', { summary: 'Checkpoint' }, 'step_target'),
      seq: 3.5,
      turnId: targetTurn,
    })
    expect(resolveUndoTurnCandidate(snapshot, 'evt_00000000000000000004')).toBeUndefined()
  })

  it('optimistically and durably removes every event in the undone turn while retaining raw history', () => {
    const priorTurn = 'turn_prior'
    const targetTurn = 'turn_target'
    const baseEvents = [
      { ...event(1, 'turn.started', { content: 'Earlier prompt', attachments: [] }, 'step_prior'), turnId: priorTurn },
      { ...event(2, 'assistant.final', { content: 'Earlier answer' }, 'step_prior'), turnId: priorTurn },
      { ...event(3, 'turn.started', { content: 'Prompt to undo', attachments: [] }, 'step_target'), turnId: targetTurn },
      { ...event(4, 'tool.started', { call: { id: 'call_target', name: 'read_file', arguments: { path: 'a.txt' } } }, 'step_target', 'call_target'), turnId: targetTurn },
      { ...event(5, 'assistant.final', { content: 'Answer to undo' }, 'step_target'), turnId: targetTurn },
      { ...event(6, 'feedback.updated', { messageEventId: 'evt_00000000000000000005', value: 'downvote', checkInAction: 'disapprove' }, 'step_target'), turnId: targetTurn },
    ]
    const optimistic = fixture(baseEvents)
    expect(projectTimeline(optimistic, new Set([targetTurn]))).toMatchObject([
      { kind: 'user', content: 'Earlier prompt' },
      { kind: 'final', content: 'Earlier answer' },
    ])

    const durable = fixture([...baseEvents, {
      ...event(7, 'turn.undone', {
        sessionNodeId: 'evt_00000000000000000005',
        targetTurnIds: [targetTurn],
        promptRestored: true,
      }, 'step_target'),
      turnId: targetTurn,
    }])
    expect(projectTimeline(durable)).toEqual(projectTimeline(optimistic, new Set([targetTurn])))
    expect(durable.events).toHaveLength(7)
  })
})

describe('custom feedback projection', () => {
  it.each([
    ['approve', 'feedback.updated', { value: 'upvote', checkInAction: 'approve' }],
    ['disapprove', 'feedback.updated', { value: 'downvote', checkInAction: 'disapprove' }],
    ['edit', 'review.dismissed', { action: 'continue', checkInAction: 'edit' }],
  ] as const)('offers treatment-1 after eligible check-in action %s', (_label, eventType, terminalData) => {
    const snapshot = fixture([
      event(1, 'assistant.final', { content: 'Result.' }, 'step_final'),
      event(2, 'review.requested', { messageEventId: 'evt_00000000000000000001', feedbackType: 'check_in' }, 'step_final'),
      event(3, eventType, { messageEventId: 'evt_00000000000000000001', ...terminalData }, 'step_final'),
    ])
    snapshot.session.status = 'completed'
    snapshot.session.feedbackType = 'check_in'
    snapshot.session.customFeedbackArm = 'treatment-1'
    expect(resolveCustomFeedbackOffer(snapshot)).toEqual({
      messageEventId: 'evt_00000000000000000001',
      arm: 'treatment-1',
    })
  })

  it('excludes Escape, control, non-completed sessions, and an already-submitted feedback turn', () => {
    const snapshot = fixture([
      event(1, 'assistant.final', { content: 'Result.' }, 'step_final'),
      event(2, 'review.requested', { messageEventId: 'evt_00000000000000000001', feedbackType: 'check_in' }, 'step_final'),
      event(3, 'review.dismissed', {
        messageEventId: 'evt_00000000000000000001', action: 'dismiss', checkInAction: 'escape',
      }, 'step_final'),
    ])
    snapshot.session.status = 'completed'
    snapshot.session.customFeedbackArm = 'treatment-2'
    expect(resolveCustomFeedbackOffer(snapshot)).toBeUndefined()

    snapshot.events[2] = event(3, 'feedback.updated', {
      messageEventId: 'evt_00000000000000000001', value: 'upvote', checkInAction: 'approve',
    }, 'step_final')
    snapshot.session.customFeedbackArm = 'control'
    expect(resolveCustomFeedbackOffer(snapshot)).toBeUndefined()
    snapshot.session.customFeedbackArm = 'treatment-2'
    snapshot.session.status = 'running'
    expect(resolveCustomFeedbackOffer(snapshot)).toBeUndefined()
    snapshot.session.status = 'completed'
    snapshot.events.push(event(4, 'turn.started', {
      content: 'More feedback.', attachments: [], customFeedbackTurn: true, reviewedNodeId: 'evt_00000000000000000001',
    }, 'step_feedback'))
    expect(resolveCustomFeedbackOffer(snapshot)).toBeUndefined()
  })

  it.each(['no', 'making_progress', 'yes'] as const)('offers treatment-2 after task-completion value %s', (value) => {
    const snapshot = fixture([
      event(1, 'assistant.final', { content: 'Result.' }, 'step_final'),
      event(2, 'review.requested', {
        messageEventId: 'evt_00000000000000000001', feedbackType: 'task_completion_bar',
      }, 'step_final'),
      event(3, 'task.completion.updated', {
        sessionNodeId: 'evt_00000000000000000001', messageEventId: 'evt_00000000000000000001', value,
      }, 'step_final'),
    ])
    snapshot.session.status = 'completed'
    snapshot.session.feedbackType = 'task_completion_bar'
    snapshot.session.customFeedbackArm = 'treatment-2'
    expect(resolveCustomFeedbackOffer(snapshot)).toEqual({
      messageEventId: 'evt_00000000000000000001',
      arm: 'treatment-2',
    })
  })

  it('projects a durable custom-feedback user turn as a dedicated history card without the trusted marker', () => {
    const timeline = projectTimeline(fixture([
      event(1, 'turn.started', {
        content: 'The title should be Q3 Review.',
        attachments: ['uploads/title.txt'],
        customFeedbackTurn: true,
        reviewedNodeId: 'evt_reviewed',
        has_feedback: true,
      }, 'step_feedback'),
    ]))
    expect(timeline).toEqual([{
      kind: 'user',
      key: 'evt_00000000000000000001',
      content: 'The title should be Q3 Review.',
      attachments: ['uploads/title.txt'],
      customFeedbackTurn: true,
      reviewedNodeId: 'evt_reviewed',
    }])
  })
})

describe('task completion bar projection', () => {
  it('opens only for the latest stable Final in a completed task-completion cohort with review metadata', () => {
    const snapshot = fixture([
      event(1, 'assistant.final', { content: 'First response.' }, 'step_first'),
      event(2, 'assistant.final', { content: 'Latest response.' }, 'step_latest'),
      event(3, 'review.requested', {
        messageEventId: 'evt_00000000000000000002', feedbackType: 'task_completion_bar', model: 'fixture',
      }, 'step_latest'),
    ])
    snapshot.session.status = 'completed'
    snapshot.session.feedbackType = 'task_completion_bar'
    expect(resolveTaskCompletion(snapshot)).toEqual({
      messageEventId: 'evt_00000000000000000002',
      turnId: 'turn_fixture',
      stepId: 'step_latest',
    })
    expect(resolveTaskReview(snapshot)).toBeUndefined()

    snapshot.session.status = 'running'
    expect(resolveTaskCompletion(snapshot)).toBeUndefined()
  })

  it('does not invent the bar without requires-review metadata and closes only for its own correlated feedback event', () => {
    const withoutMetadata = fixture([
      event(1, 'assistant.final', { content: 'Unreviewed response.' }, 'step_final'),
    ])
    withoutMetadata.session.status = 'completed'
    withoutMetadata.session.feedbackType = 'task_completion_bar'
    expect(resolveTaskCompletion(withoutMetadata)).toBeUndefined()

    const pending = fixture([
      event(1, 'assistant.final', { content: 'Reviewed response.' }, 'step_final'),
      event(2, 'review.requested', {
        messageEventId: 'evt_00000000000000000001', feedbackType: 'task_completion_bar', model: 'fixture',
      }, 'step_final'),
      event(3, 'feedback.updated', { messageEventId: 'evt_00000000000000000001', value: 'upvote' }, 'step_final'),
      event(4, 'review.dismissed', { messageEventId: 'evt_00000000000000000001', action: 'continue' }, 'step_final'),
    ])
    pending.session.status = 'completed'
    pending.session.feedbackType = 'task_completion_bar'
    expect(resolveTaskCompletion(pending)?.messageEventId).toBe('evt_00000000000000000001')

    pending.events.push(event(5, 'task.completion.updated', {
      sessionNodeId: 'evt_00000000000000000001',
      messageEventId: 'evt_00000000000000000001',
      value: 'making_progress',
      feedback: { type: 'task_completion_bar', value: 'making_progress' },
    }, 'step_final'))
    expect(resolveTaskCompletion(pending)).toBeUndefined()
  })

  it('does not let task-completion feedback suppress the independent check-in review contract', () => {
    const snapshot = fixture([
      event(1, 'assistant.final', { content: 'Check-in response.' }, 'step_final'),
      event(2, 'task.completion.updated', {
        sessionNodeId: 'evt_00000000000000000001', value: 'yes',
      }, 'step_final'),
    ])
    snapshot.session.status = 'completed'
    snapshot.session.feedbackType = 'check_in'
    expect(resolveTaskReview(snapshot)?.messageEventId).toBe('evt_00000000000000000001')
    expect(resolveTaskCompletion(snapshot)).toBeUndefined()
  })
})

function artifact(id: string, path: string, createdAt: string) {
  return {
    id,
    sessionId: 'ses_aaaaaaaaaaaaaaaaaaaa',
    path,
    name: path,
    kind: 'markdown' as const,
    mime: 'text/markdown',
    createdAt,
    previewUrl: `/workspace/ses_aaaaaaaaaaaaaaaaaaaa/file?path=${encodeURIComponent(path)}`,
    downloadUrl: `/api/sessions/ses_aaaaaaaaaaaaaaaaaaaa/download?path=${encodeURIComponent(path)}`,
  }
}

function fixture(events: SessionEvent[]): SessionSnapshot {
  return {
    session: {
      id: 'ses_aaaaaaaaaaaaaaaaaaaa',
      title: 'Fixture',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:01.000Z',
      status: 'running',
      model: 'fixture',
      workspaceBytes: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0, estimatedCostUsd: 0, modelCalls: 0, toolCalls: 0 },
    },
    events,
    plan: null,
    workspace: [],
    artifacts: [],
    processes: [],
    website: { status: 'stopped', updatedAt: '2026-08-28T00:00:00.000Z', restartCount: 0 },
    deployment: { status: 'not_deployed', revision: 0, updatedAt: '2026-08-28T00:00:00.000Z' },
    repository: null,
  }
}

function event(
  seq: number,
  type: SessionEvent['type'],
  data: Record<string, unknown>,
  stepId: string,
  callId?: string,
): SessionEvent {
  return {
    id: `evt_${String(seq).padStart(20, '0')}`,
    sessionId: 'ses_aaaaaaaaaaaaaaaaaaaa',
    seq,
    type,
    at: `2026-08-28T00:00:00.${String(seq).padStart(3, '0')}Z`,
    turnId: 'turn_fixture',
    stepId,
    callId,
    data,
  }
}
