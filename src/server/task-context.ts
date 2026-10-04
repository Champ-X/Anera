import type { SessionEvent } from '../shared/types.js'
import { createHash } from 'node:crypto'

/** One boundary resolver for verbatim requirements and their server metadata.
 * Neither checkpoint prose nor source text may create a task or its clock. */
export function activeTaskRequestEvents(events: readonly SessionEvent[], isContinuation: (text: string) => boolean): SessionEvent[] {
  const undone = new Set(events.flatMap((event) => event.type === 'turn.undone'
    && Array.isArray(event.data.targetTurnIds) ? event.data.targetTurnIds.filter((id): id is string => typeof id === 'string') : []))
  const beforeStart = new Map<string, SessionEvent[]>()
  for (const event of events) {
    if (event.type !== 'user.steering.applied' || event.data.appliedBeforeTurnStart !== true || !event.turnId) continue
    const queued = beforeStart.get(event.turnId) ?? []
    queued.push(event)
    beforeStart.set(event.turnId, queued)
  }
  let requests: SessionEvent[] = []
  for (const event of events) {
    // A physical workspace restore starts a new execution scope while keeping
    // the audit conversation. It cannot be undone by hiding a chat turn.
    // Otherwise a later "continue" re-imports old completed work and steering
    // as live requirements in the model's recovered task control.
    if (event.type === 'workspace.version.restored') { requests = []; continue }
    if (event.turnId && undone.has(event.turnId)) continue
    if (event.type === 'user.steering.applied') {
      // stageRunStart applies queued corrections before the newer submit.
      // Project them with that submit, not with the task it supersedes. The
      // metadata also makes replay independent of delayed event publication.
      if (event.data.appliedBeforeTurnStart === true) continue
      // The queue is scoped to an existing task. Receipt alone does not change
      // model requirements; only the durable apply boundary belongs here.
      if (requests.length > 0) requests.push(event)
      continue
    }
    if (event.type !== 'turn.started') continue
    const content = typeof event.data.content === 'string' ? event.data.content : ''
    const feedback = event.data.customFeedbackTurn === true || typeof event.data.reviewedNodeId === 'string'
    // A control-only continuation is an execution event, not a new semantic
    // requirement or clock anchor. All consumers (plan, review, repair and
    // handoff) must share this distinction; filtering only plans makes valid
    // content receipts expire on an otherwise unchanged Continue.
    const attachments = Array.isArray(event.data.attachments) && event.data.attachments.length > 0
    const queued = event.turnId ? beforeStart.get(event.turnId) ?? [] : []
    if (requests.length > 0 && !feedback && !attachments
      && /^(?:continue|resume|proceed|go ahead|继续(?:推进|完成(?:任务|目标))?|接着|恢复)[。.!！]?$/iu.test(content.trim())) {
      requests.push(...queued)
      continue
    }
    if (!feedback && !isContinuation(content)) requests = []
    requests.push(...queued)
    requests.push(event)
  }
  return requests
}

/** Rebuild this control from the durable journal, outside compactable chat
 * history. A restore archives prior execution obligations, not just evidence. */
export function workspaceRestoreDecisionContext(events: readonly SessionEvent[]): string {
  let restore: SessionEvent | undefined
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === 'workspace.version.restored') { restore = events[index]; break }
  }
  if (!restore) return ''
  return [
    'Harness workspace restore task boundary (server control, not a new user request).',
    'The user deliberately restored a saved local workspace. Instructions, applied steering, plans, completed actions and proposed follow-ups from before this restore remain archived conversation history; they are not pending tasks or authorization for new changes. A historical checkpoint or recovered conversation summary cannot reactivate those obligations.',
    'The restored files are the starting state. Make only changes needed by user requests received after this restore and corrections to those requests. A post-restore Continue refers to this restored state and the post-restore task; it does not replay archived operations. Do not recreate removed files, reapply old edits, repeat completed commands, or redo external actions merely to satisfy an earlier task or steering instruction. If the current request explicitly asks to repeat an earlier operation, that new request supplies its scope.',
    'Read current files before changing them and verify what the current request needs. Pre-restore tool observations and verification claims do not establish current file contents. Conversation history remains available for audit and reference; external side effects were not undone.',
    JSON.stringify({ version: 1, restoreEventSeq: restore.seq }),
  ].join('\n')
}

function timezone(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 100) return undefined
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone } catch { return undefined }
}

function instant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/u.test(value)) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function calendar(receivedAt: string, zone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(receivedAt))
  const part = (kind: string) => Number(parts.find((value) => value.type === kind)!.value)
  const day = new Date(Date.UTC(part('year'), part('month') - 1, part('day')))
  const offset = (days: number) => { const date = new Date(day); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10) }
  const monday = -((day.getUTCDay() + 6) % 7)
  return { localDate: offset(0), trailingSevenDates: [offset(-6), offset(0)], calendarWeekMondaySunday: [offset(monday), offset(monday + 6)] }
}

/** Stable across resume and midnight. Relative words belong to the request
 * that introduced them, not a later reviewer, checkpoint, or repair run.
 * Legacy timezone fallback is explicit; missing timestamps remain unknown. */
export function taskTemporalControl(events: readonly SessionEvent[], isContinuation: (text: string) => boolean, fallbackTimezone?: string): string {
  const requests = activeTaskRequestEvents(events, isContinuation)
  if (!requests.length) return ''
  const selected = requests.length <= 16 ? requests.map((event, index) => ({ event, index }))
    : [{ event: requests[0], index: 0 }, ...requests.slice(-15).map((event, index) => ({ event, index: requests.length - 15 + index }))]
  const anchors = selected.map(({ event, index }) => {
    const recordedZone = timezone(event.data.timezone)
    const zone = recordedZone ?? timezone(fallbackTimezone) ?? 'UTC'
    const receivedAt = instant(event.data.requestReceivedAt) ?? instant(event.at)
    return { requestIndex: index, ...(receivedAt ? { receivedAt, ...calendar(receivedAt, zone) } : { receivedAt: null }),
      timezone: zone, timezoneSource: recordedZone ? 'request_record' : timezone(fallbackTimezone) ? 'session_fallback' : 'utc_fallback' }
  })
  return `Harness task temporal context (server metadata, not a new user request): requestIndex identifies the corresponding verbatim user requirement in journal order. Interpret relative dates in each requirement at its received local date; Continue, repair, review and handoff do not move an earlier request's window. Explicit historical/future dates and later substantive user revisions remain requirements, not overrides of the server clock. trailingSevenDates is seven inclusive local dates ending at that request; calendarWeekMondaySunday is a distinct calendar week. These timestamps establish request timing only, never a source's publication date, an event date, freshness, or task completion. Missing metadata is unknown; a session/UTC timezone fallback is not proof of the original timezone. Current server time, if supplied separately, describes now and does not silently rewrite the original scope.\n${JSON.stringify({ version: 1, omittedRequestAnchors: Math.max(0, requests.length - selected.length), requests: anchors })}`
}

/** Bind the same request-local control sent to a reviewer into its receipts
 * and repair scope, without rewriting the user-authored task text. */
export function taskScopeIdentity(request: string, temporalControl?: string): string {
  return temporalControl ? `task-context-v1:${createHash('sha256').update(JSON.stringify({ request, temporalControl })).digest('hex')}` : request
}

/** Task-dependent plans ignore only pure control-only continuation turns.
 * Corrective feedback, attached inputs and substantive Continue instructions
 * remain scope revisions. The journal itself and displayed clocks are intact. */
export function taskPlanScopeIdentity(events: readonly SessionEvent[], isContinuation: (text: string) => boolean, fallbackTimezone?: string): string | undefined {
  const requests = activeTaskRequestEvents(events, isContinuation)
  if (!requests.length) return undefined
  const request = requests.flatMap((event) => typeof event.data.content === 'string' && event.data.content.trim() ? [event.data.content] : []).join('\n\n')
  return taskScopeIdentity(request, taskTemporalControl(events, isContinuation, fallbackTimezone))
}
