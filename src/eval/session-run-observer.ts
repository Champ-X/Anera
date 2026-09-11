import type { RunStatus, SessionEvent } from '../shared/types.js'

const TERMINAL_STATUSES: ReadonlySet<unknown> = new Set<RunStatus>([
  'completed', 'failed', 'cancelled', 'timed_out', 'interrupted', 'awaiting_approval', 'awaiting_user',
])

export interface SessionRunObservation {
  reason: 'terminal' | 'deadline' | 'budget' | 'closed' | 'observer_error'
  status?: RunStatus
  lastSeq: number
  observedEvents: number
  error?: string
}

/** Test observation only: subscribe before starting a run, keep O(1) state,
 * and read the authoritative final snapshot separately after owned work has
 * settled. Never restarts a run, polls history, changes budgets, or attests QA. */
export function observeSessionRun(options: {
  sessionId: string
  afterSeq: number
  deadline: number
  subscribe: (listener: (event: SessionEvent) => void) => () => void
  onEvent?: (event: SessionEvent) => void
}) {
  const remaining = options.deadline - Date.now()
  if (!options.sessionId || !Number.isSafeInteger(options.afterSeq) || options.afterSeq < 0
    || !Number.isSafeInteger(options.deadline) || remaining > 2_147_483_647) {
    throw new Error('Invalid session observation boundary')
  }
  let stopped = false
  let lastSeq = options.afterSeq
  let observedEvents = 0
  let outcome: SessionRunObservation | undefined
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolveResult!: (result: SessionRunObservation) => void
  const result = new Promise<SessionRunObservation>((resolve) => { resolveResult = resolve })
  const finish = (reason: SessionRunObservation['reason'], status?: RunStatus, error?: unknown) => {
    if (stopped) return
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    try { unsubscribe?.() } catch (cleanupError) { error ??= cleanupError; reason = 'observer_error' }
    outcome = { reason, ...(status ? { status } : {}), lastSeq, observedEvents,
      ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}) }
    resolveResult(outcome)
  }
  if (remaining <= 0) finish('deadline')
  else {
    timer = setTimeout(() => finish('deadline'), remaining)
    try {
      unsubscribe = options.subscribe((event) => {
        if (stopped || event.sessionId !== options.sessionId || event.seq <= lastSeq) return
        try {
          if (Date.now() >= options.deadline) { finish('deadline'); return }
          if (!Number.isSafeInteger(event.seq)) throw new Error('Invalid durable event sequence')
          lastSeq = event.seq
          observedEvents += 1
          options.onEvent?.(event)
          if (event.type === 'run.status' && TERMINAL_STATUSES.has(event.data.status)) {
            finish('terminal', event.data.status as RunStatus)
          }
        } catch (error) {
          // A diagnostic callback must not throw into SessionStore publication.
          // Report its failure instead of silently claiming a terminal pass.
          finish('observer_error', undefined, error)
        }
      })
      // Also support an event source that replays synchronously at subscribe.
      if (stopped) unsubscribe()
    } catch (error) {
      if (outcome) {
        outcome.reason = 'observer_error'
        outcome.error = error instanceof Error ? error.message : String(error)
      } else finish('observer_error', undefined, error)
    }
  }
  return { result, get stopped() { return stopped },
    stop: () => finish('budget'), close: () => finish('closed') }
}
