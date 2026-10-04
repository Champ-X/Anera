import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionEvent, SessionSnapshot } from '../shared/types'
import type { SteeringMessage } from '../shared/steering'
import type { TaskVerification } from '../shared/task-verification'
import { api, ApiRequestError } from './api'
import { applyEventsToSnapshot, Composer, FinalActions, projectTimeline, reconcileSnapshot, resolveTaskReview } from './App'
import { mergeSteeringMessages, SteeringUpdates, visibleSteeringMessages } from './SteeringUpdates'
import { WorkspaceVersionChanges, WorkspaceVersionsDialog } from './WorkspaceVersionsDialog'
import { TaskVerificationSummary } from './TaskVerificationSummary'

afterEach(() => vi.unstubAllGlobals())

const received: SteeringMessage = {
  id: 'steering_first', clientMessageId: 'client_first', sequence: 1,
  content: 'Keep the existing introduction and change the total to 12.', status: 'received',
  receivedAt: '2026-09-26T12:00:00.000Z', receivedTurnId: 'turn_first',
}
const applied: SteeringMessage = { ...received, status: 'applied', appliedAt: '2026-09-26T12:00:02.000Z', appliedTurnId: 'turn_first' }
const sessionId = 'ses_collaboration_test'
function event(seq: number, type: string, data: unknown): SessionEvent {
  return { id: `evt_${seq}`, sessionId, seq, type, at: '2026-09-26T12:00:00.000Z', turnId: 'turn_first', data } as SessionEvent
}
function snapshot(events: SessionEvent[] = []): SessionSnapshot {
  return {
    session: { id: sessionId, title: 'Collaboration fixture', status: 'running', model: 'fixture', createdAt: '', updatedAt: '', workspaceBytes: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0, estimatedCostUsd: 0, modelCalls: 0, toolCalls: 0 } },
    events, steering: [], plan: null, workspace: [], artifacts: [], processes: [], repository: null,
    website: { status: 'stopped', updatedAt: '', restartCount: 0 }, deployment: { status: 'not_deployed', revision: 0, updatedAt: '' },
  }
}
const composerDefaults = {
  sessionId, onRemoveCustomFeedback() {}, onDraftStateChange() {}, running: true, resumable: false,
  isFreeSession: false, models: [], modelSelection: null, modelListUnavailable: false, codingMode: false, connectionsOpen: false,
  connectionsEnabled: false, onError() {}, onConnections() {}, async onSend() {}, async onStop() {},
  async onResume() {}, async onNewChat() {},
}

describe('continuous instructions', () => {
  it('keeps received instructions ordered and never downgrades a late receipt over an application', () => {
    const second = { ...received, id: 'steering_second', clientMessageId: 'client_second', sequence: 2 }
    expect(mergeSteeringMessages([applied], [second, received])).toEqual([applied, second])
    expect(mergeSteeringMessages([received], [received, applied, applied])).toEqual([applied])
  })

  it('survives batched SSE replay and hydration without duplicate application state', () => {
    const events = [event(1, 'user.steering.received', received), event(2, 'user.steering.applied', applied)]
    const live = applyEventsToSnapshot(snapshot(), [...events, events[1]])
    expect(live.steering).toEqual([applied])
    expect(live.events).toHaveLength(2)
    expect(reconcileSnapshot(live, { ...snapshot(events), steering: [received] }).steering).toEqual([applied])
    expect(reconcileSnapshot(live, snapshot([events[0]])).steering).toEqual([applied])
  })

  it('keeps a durable HTTP receipt when an equally recent snapshot arrives before its SSE event', () => {
    const current = { ...snapshot(), steering: [received] }
    expect(reconcileSnapshot(current, snapshot()).steering).toEqual([received])
  })

  it('keeps restored instructions archived during snapshot hydration and late SSE receipts', () => {
    const archived: SteeringMessage = { ...received, status: 'archived', archivedAt: '2026-09-26T12:01:00.000Z', archiveReason: 'workspace_restored' }
    const current = applyEventsToSnapshot(snapshot(), [event(1, 'user.steering.received', received), event(2, 'user.steering.archived', archived)])
    expect(current.steering).toEqual([archived])
    expect(reconcileSnapshot(current, { ...snapshot(current.events), steering: [received] }).steering).toEqual([archived])
    expect(mergeSteeringMessages([archived], [received, applied])).toEqual([archived])
    const markup = renderToStaticMarkup(<SteeringUpdates messages={[archived]} paused />)
    expect(markup).toContain('Archived after restore')
    expect(markup).toContain('1 archived')
    expect(markup).not.toContain('waiting to resume')
    expect(markup).not.toContain('1 applied')
  })

  it('allows plain-text corrections while retaining Stop, and keeps replay inputs locked', () => {
    const active = renderToStaticMarkup(<Composer {...composerDefaults} steeringEnabled onSteer={async () => {}} />)
    expect(active).toContain('contentEditable="true"')
    expect(active).toContain('aria-label="Add instructions"')
    expect(active).toContain('aria-label="Stop agent"')
    expect(active).toContain('The current operation will finish first.')
    const replay = renderToStaticMarkup(<Composer {...composerDefaults} steeringEnabled onSteer={async () => {}} readOnly />)
    expect(replay).toContain('contentEditable="false"')
  })

  it('distinguishes received from applied and describes pending instructions after cancellation', () => {
    const markup = renderToStaticMarkup(<SteeringUpdates messages={[received, { ...applied, id: 'steering_applied', sequence: 2 }]} paused />)
    expect(markup).toContain('Received')
    expect(markup).toContain('Applied')
    expect(markup).toContain('waiting to resume')
    expect(markup).toContain(received.content)
  })

  it('hides instructions attached to an undone turn but retains those applied in a later turn', () => {
    const later = { ...applied, id: 'later', appliedTurnId: 'turn_later' }
    expect(visibleSteeringMessages([received, applied, later], new Set(['turn_first']))).toEqual([later])
  })

  it('carries the caller-owned idempotency key across retries and preserves an inactive-session error code', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ steering: received }), { status: 202 })
    }))
    await api.steer(sessionId, '  correction  ', 'retry-key')
    await api.steer(sessionId, '  correction  ', 'retry-key')
    expect(bodies).toEqual([{ content: 'correction', clientMessageId: 'retry-key' }, { content: 'correction', clientMessageId: 'retry-key' }])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'No active task', code: 'steering_session_not_active' }), { status: 409 })))
    await expect(api.steer(sessionId, 'correction', 'retry-key')).rejects.toMatchObject({ status: 409, code: 'steering_session_not_active' })
    await expect(api.steer(sessionId, 'correction', 'retry-key')).rejects.toBeInstanceOf(ApiRequestError)
  })
})

describe('workspace versions', () => {
  const scope = { files: 'saved-workspace', excludedPaths: 'dependencies-caches-builds-and-private-runtime-files', conversationReverted: false, externalSideEffectsReverted: false } as const
  it('shows added/deleted text safely, binary limits, and truncated evidence without claiming complete comparison', () => {
    const markup = renderToStaticMarkup(<WorkspaceVersionChanges diff={{ fromVersionId: 'version_one', against: 'current', scope, added: 1, modified: 1, deleted: 1, changes: [
      { path: 'index.html', kind: 'added', afterText: '<script>alert(1)</script>', textTruncated: true },
      { path: 'gone.txt', kind: 'deleted', beforeText: 'previous text' },
      { path: 'image.png', kind: 'modified', before: { sha256: 'old', bytes: 11, mode: 420 }, after: { sha256: 'new', bytes: 22, mode: 420 } },
    ] }} />)
    expect(markup).toContain('1 added · 1 modified · 1 deleted')
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('&lt;script&gt;')
    expect(markup).toContain('Text preview is shortened')
    expect(markup).toContain('Content comparison is unavailable')
    expect(markup).toContain('(file absent)')
  })

  it('makes restore scope and active-task restrictions visible before a mutation', () => {
    const markup = renderToStaticMarkup(<WorkspaceVersionsDialog sessionId={sessionId} busy onClose={() => {}} onRestored={async () => {}} />)
    expect(markup).toContain('<dialog')
    expect(markup).toContain('keeping conversation history')
    expect(markup).toContain('External actions are not undone')
    expect(markup).toContain('Stop it or wait for completion')
    expect(markup).toContain('Restoring saves the current workspace first')
    expect(markup).toContain('Restore &amp; continue')
  })

  it('sends comparisons and restores to the selected version without changing the conversation', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      return new Response('{}', { status: 200 })
    }))
    await api.workspaceVersionDiff(sessionId, 'version/one', 'version two')
    await api.restoreWorkspaceVersion(sessionId, 'version/one')
    expect(calls[0].path).toBe(`/api/sessions/${sessionId}/workspace-versions/version%2Fone/diff?against=version+two`)
    expect(calls[1].path).toBe(`/api/sessions/${sessionId}/workspace-versions/version%2Fone/restore`)
    expect(calls[1].init?.body).toBe('{}')
  })

  it('does not revive old artifact cards or metadata when hydrating a restored workspace', () => {
    const artifact = { id: 'artifact_old', sessionId, name: 'Old report', path: 'removed.html', kind: 'website' as const, mime: 'text/html', bytes: 20, createdAt: '', downloadUrl: '/old', previewUrl: '/old' }
    const events = [event(1, 'artifact.created', { artifact }), event(2, 'workspace.version.restored', { artifacts: [], version: { label: 'Before report' } })]
    const restored = reconcileSnapshot(undefined, snapshot(events))
    expect(restored.artifacts).toEqual([])
    expect(projectTimeline(restored).some((item) => item.kind === 'artifact')).toBe(false)
    expect(projectTimeline(restored)).toContainEqual(expect.objectContaining({ kind: 'thought', label: 'Workspace restored' }))
    const completed = snapshot([event(1, 'assistant.final', { content: 'Prior delivery' }), event(2, 'workspace.version.restored', { artifacts: [] })])
    completed.session.status = 'completed'
    expect(resolveTaskReview(completed)).toBeUndefined()
  })

  it('clears the pre-restore active plan during live events and later snapshot hydration', () => {
    const plan = { explanation: 'Old task', items: [{ step: 'Recreate removed file', status: 'in_progress' }] }
    const events = [event(1, 'plan.updated', { plan }), event(2, 'workspace.version.restored', { artifacts: [], version: { label: 'Earlier files' } })]
    expect(applyEventsToSnapshot(snapshot(), events).plan).toBeNull()
    expect(reconcileSnapshot(undefined, snapshot(events)).plan).toBeNull()
  })
})

describe('proportionate verification presentation', () => {
  const verification: TaskVerification = { outcome: 'limited', summary: 'The report is complete; remote preview was unavailable.', checks: [
    { requirement: 'Report totals', method: 'Recalculated totals from the source rows', required: true, status: 'passed', evidence: { paths: ['report.md'] } },
    { requirement: 'Remote preview', method: 'Service did not respond', required: false, status: 'unverified', evidence: {}, note: 'Local output is available.' },
  ] }
  it('keeps limited completion and unverified checks explicit without calling the whole task a failure', () => {
    const markup = renderToStaticMarkup(<TaskVerificationSummary verification={verification} />)
    expect(markup).toContain('completed with limitations')
    expect(markup).toContain('Passed')
    expect(markup).toContain('Not verified')
    expect(markup).not.toContain('Task failed')
    expect(markup).toContain('report.md')
    const actions = renderToStaticMarkup(<FinalActions content="Done within the stated limits." verificationOutcome="limited" />)
    expect(actions).toContain('Completed with limitations')
    expect(actions).not.toContain('aria-label="Completed"')
    const projected = projectTimeline(snapshot([event(1, 'task.verification.completed', verification), event(2, 'assistant.final', { content: 'Done within the stated limits.' })]))
    expect(projected.find((item) => item.kind === 'final')).toMatchObject({ verificationOutcome: 'limited' })
  })

  it.each([
    ['completed', 'Verification · not recorded'],
    ['limited', 'Verification · unavailable'],
  ] as const)('keeps %s responses without a recorded review neutral in projection and presentation', (outcome, label) => {
    const projected = projectTimeline(snapshot([event(1, 'task.verification.completed', {
      source: 'direct', verificationRecorded: false, outcome, summary: 'Response delivered without a recorded review.', checks: [],
    })]))
    const item = projected.find((entry) => entry.kind === 'verification')
    if (!item || item.kind !== 'verification') throw new Error('Verification projection is missing')
    expect(item.verification.verificationRecorded).toBe(false)
    const markup = renderToStaticMarkup(<TaskVerificationSummary verification={item.verification} />)
    expect(markup).toContain(label)
    expect(markup).toContain('task-verification-summary unrecorded')
    expect(markup).toContain('lucide-circle-help')
    expect(markup).not.toContain('lucide-check')
    expect(markup).not.toContain('Verification · complete')
    expect(markup).not.toContain('Passed')
  })

  it('marks earlier verification stale after restore but leaves a later review current', () => {
    const projected = projectTimeline(snapshot([
      event(1, 'task.verification.completed', verification),
      event(2, 'workspace.version.restored', { version: { id: 'version_one' } }),
      event(3, 'task.verification.completed', { ...verification, outcome: 'completed' }),
    ]))
    expect(projected.filter((item) => item.kind === 'verification').map((item) => item.stale)).toEqual([true, false])
    const markup = renderToStaticMarkup(<TaskVerificationSummary verification={{ outcome: 'completed', checks: [], summary: 'Direct answer checked.' }} />)
    expect(markup).toContain('No additional checks were recorded')
    expect(markup).not.toContain('all passed')
  })
})
