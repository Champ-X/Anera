import { createHash } from 'node:crypto'
import type { SessionEvent } from '../shared/types.js'

// Deliberately conservative: unknown tools, mutations and external waits break
// the window. This is not a tool-permission registry or a result cache.
const SNAPSHOT_READS = new Set([
  'read_file', 'list_files', 'glob_files', 'grep_files',
  'web_search', 'web_fetch', 'fetch_page', 'extract_attachment',
])
const MAX_PERIOD = 4
const OCCURRENCES = 3
const RECOVERY_REASON = 'unchanged_observation_cycle'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]))
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

interface Observation {
  digest: string
  callCount: number
  callNames: string[]
}

export interface ObservationCycle {
  fingerprint: string
  period: number
  occurrences: number
  callNames: string[]
}

function observation(events: readonly SessionEvent[]): Observation | undefined {
  if (!events.length) return undefined
  const items: Array<{ call: unknown; result: unknown; failed: boolean }> = []
  const callNames = new Set<string>()
  for (const event of events) {
    const { call, result, notExecuted, cancelled } = event.data
    if (!['tool.completed', 'tool.failed'].includes(event.type)
      || notExecuted === true || cancelled === true || typeof result !== 'string'
      || !call || typeof call !== 'object') return undefined
    const { name, arguments: args } = call as { name?: unknown; arguments?: unknown }
    if (typeof name !== 'string' || !SNAPSHOT_READS.has(name) || !args || typeof args !== 'object') return undefined
    let content: unknown = result
    try { content = JSON.parse(result) } catch { /* Plain text stays byte-sensitive. */ }
    // Explicit pending state is not stagnation; no prose/keyword inference.
    if (content && typeof content === 'object' && 'status' in content
      && ['pending', 'running', 'queued', 'waiting'].includes(String(content.status))) return undefined
    callNames.add(name)
    items.push({ call: { name, arguments: args }, result: content, failed: event.type !== 'tool.completed' || event.data.isError === true })
  }
  // Parallel completion order and provider call IDs do not constitute evidence.
  return { digest: digest(items.map(digest).sort()), callCount: items.length, callNames: [...callNames].sort() }
}

/** Bounded, task-neutral observation feedback. Never executes/skips a tool,
 * deletes history, asserts completion, or stops a legitimate external wait.
 * Terminal journal entries allow reconstruction independently of model prose.
 */
export class ExecutionProgressMonitor {
  private history: Observation[] = []
  private notified = new Set<string>()

  constructor(events: readonly SessionEvent[] = [], turnId?: string) {
    if (!turnId) return
    let stepId: string | undefined
    let batch: SessionEvent[] = []
    const flush = () => { if (batch.length) this.observe(batch); batch = [] }
    for (const event of events) {
      if (event.turnId !== turnId) continue
      if (event.stepId && event.stepId !== stepId) { flush(); stepId = event.stepId }
      if (['tool.completed', 'tool.failed', 'tool.timed_out'].includes(event.type)) batch.push(event)
      if (event.type === 'model.tool_call.repair' && event.data.reason === RECOVERY_REASON) {
        flush()
        if (typeof event.data.fingerprint === 'string') this.acknowledge(event.data.fingerprint)
      }
    }
    flush()
  }

  acknowledge(fingerprint: string): void {
    this.notified.add(fingerprint)
    if (this.notified.size > 32) this.notified.delete(this.notified.values().next().value!)
  }

  observe(events: readonly SessionEvent[]): ObservationCycle | undefined {
    const next = observation(events)
    if (!next) { this.history = []; return undefined }
    this.history.push(next)
    this.history = this.history.slice(-MAX_PERIOD * OCCURRENCES)
    for (let period = 1; period <= MAX_PERIOD; period += 1) {
      const tail = this.history.slice(-period * OCCURRENCES)
      if (tail.length !== period * OCCURRENCES) continue
      const cycle = tail.slice(0, period)
      // Existing single-call guard owns this case. Avoid duplicate feedback.
      if (cycle.every((item) => item.callCount === 1 && item.digest === cycle[0].digest)) continue
      if (!tail.every((item, index) => item.digest === cycle[index % period].digest)) continue
      const ids = cycle.map((item) => item.digest)
      // The same cycle starting at B instead of A gets only one notification.
      const rotations = ids.map((_, i) => [...ids.slice(i), ...ids.slice(0, i)].join(':')).sort()
      const fingerprint = digest(rotations[0])
      if (this.notified.has(fingerprint)) return undefined
      return { fingerprint, period, occurrences: OCCURRENCES, callNames: [...new Set(cycle.flatMap((item) => item.callNames))].sort() }
    }
    return undefined
  }
}

export function observationCycleRecovery(cycle: ObservationCycle): string {
  return `Harness evidence recovery: ${cycle.period} observation batch(es) involving ${cycle.callNames.join(', ')} returned identical evidence across ${cycle.occurrences} cycles. These tool results are retained; repeated reads have not established additional progress. Identify the unresolved requirement and use a materially different authorized action that can obtain missing evidence or repair the cause. If the task explicitly requires waiting on external state, use its supported wait/poll mechanism. Do not change the user's requirements, claim success from this warning, repeat successful verification without changed inputs, or bypass tool permissions or approval.`
}
