import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import type { SessionEvent } from '../shared/types.js'
import type { TaskVerification, TaskVerificationCheck, TaskVerificationReceipt } from '../shared/task-verification.js'
import { arenaWorkspacePath, type ToolDefinition } from './tools.js'
import { assertNoSymlinkTraversal, isWorkspaceInternalPath, resolveWorkspacePath } from './workspace.js'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const statuses = new Set(['passed', 'failed', 'unverified', 'not_needed'])

export const ADAPTIVE_VERIFICATION_POLICY = `Anera task completion:
You decide how to verify this user's task using the available tools and actual evidence. Choose checks from the user's requirements, not a fixed task category, filename, template, or checklist. Scale effort to uncertainty and consequence. A simple answer may need only a reasoning check; an executed action needs evidence of the actual result. Use deterministic observations where useful and semantic judgment where needed. Do not demand perfection, invent additional requirements, force unnecessary plans/approvals, or repeatedly inspect unchanged work.
For work involving tools, finish with finish_task as your only tool call in that response. It records your checks AND delivers summary directly to the user without another reviewer/model call. Requirements may be paraphrased faithfully. Mark required only for checks material to the user's objective. Cite actual completed tool call IDs and relevant workspace paths when available; these record provenance, not proof that your interpretation is correct. Explain a self-contained reasoning check in method if no tool evidence is needed.
Before completion, repair genuinely unmet requirements when feasible and repeat only checks invalidated by changes. Distinguish known defects from missing observations. Nonessential gaps may be disclosed without invalidating the task. If a core requirement truly cannot be completed, use outcome limited, preserve useful work, explain the blocker in summary, and do not present unverified work as passed. A failed check may be expected behavior (e.g. testing invalid input); judge against the actual requirement. Never change the user's scope to manufacture completion.
For a direct answer requiring no tool work, you may answer normally without finish_task. Never add verification prose to an exact-output request: put the requested text in summary and the check record in checks. Once sufficient evidence exists, deliver promptly. Existing domain-specific tools are optional aids; no mandatory HTML/Slides phase sequence applies.`

export const FINISH_TASK_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'finish_task',
    description: 'Deliver the final answer with your proportionate task verification record. This ends the turn immediately; call alone, after necessary work/checks. No additional review model is invoked. Use limited when a core requirement remains unmet or unverified.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['summary', 'outcome', 'checks'],
      properties: {
        summary: { type: 'string', description: 'The exact final user-facing answer, including material limitations.' },
        outcome: { type: 'string', enum: ['completed', 'limited'] },
        checks: { type: 'array', maxItems: 128, items: {
          type: 'object', additionalProperties: false, required: ['requirement', 'method', 'required', 'status', 'evidence'],
          properties: {
            requirement: { type: 'string' }, method: { type: 'string' }, required: { type: 'boolean' },
            status: { type: 'string', enum: ['passed', 'failed', 'unverified', 'not_needed'] },
            evidence: { type: 'object', additionalProperties: false, properties: {
              callIds: { type: 'array', items: { type: 'string' } }, paths: { type: 'array', items: { type: 'string' } },
            } },
            note: { type: 'string' },
          },
        } },
      },
    },
  },
}

export class TaskVerificationError extends Error {
  constructor(message: string) { super(message); this.name = 'TaskVerificationError' }
}

function fail(message: string): never { throw new TaskVerificationError(message) }
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('Unexpected verification fields; use the declared schema.')
}
function strings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => !text(item, 2048))) fail(`Invalid ${label}.`)
  return [...new Set(value as string[])]
}

function nonExecutionResult(event: SessionEvent): boolean {
  let result: unknown = event.data.result
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { result = undefined }
  }
  return [event.data, result].some((value) => object(value) && (value.notExecuted === true
    || value.not_executed === true || value.cancelled === true || value.status === 'cancelled' || value.status === 'not_executed'))
}

/** Success and actual failure both establish observations; deferred calls do not. */
export function taskVerificationToolExecuted(event: SessionEvent): boolean {
  return ['tool.completed', 'tool.failed', 'tool.timed_out'].includes(event.type) && !nonExecutionResult(event)
}

function evidenceTarget(workspace: string, path: string): string {
  const workspacePath = arenaWorkspacePath(path)
  const target = resolveWorkspacePath(workspace, workspacePath)
  if (isWorkspaceInternalPath(workspacePath)) fail('Internal runtime paths cannot be used as deliverable evidence.')
  return target
}

/** Compare only declared check dependencies and journal order, never method semantics. */
function bindCheckFileRevisions(result: TaskVerification, workspace: string,
  events: readonly SessionEvent[], terminalByCall: ReadonlyMap<string, SessionEvent>): NonNullable<TaskVerificationReceipt['staleFileEvidence']> {
  const changes = new Map<string, SessionEvent>()
  for (const event of events) {
    if (event.type !== 'file.changed' || typeof event.data.path !== 'string') continue
    try {
      const target = evidenceTarget(workspace, event.data.path)
      if ((changes.get(target)?.seq ?? -1) < event.seq) changes.set(target, event)
    } catch { /* An unrelated, non-workspace path cannot attest a selected file mutation. */ }
  }
  const stale: NonNullable<TaskVerificationReceipt['staleFileEvidence']> = []
  for (const [checkIndex, check] of result.checks.entries()) {
    const calls = check.evidence.callIds ?? []
    if (!calls.length) continue
    const lastObservationSeq = Math.max(...calls.map((callId) => terminalByCall.get(callId)!.seq))
    const changedPaths: string[] = []
    for (const path of check.evidence.paths ?? []) {
      const mutation = changes.get(evidenceTarget(workspace, path))
      if (!mutation || mutation.seq <= lastObservationSeq) continue
      changedPaths.push(path)
      stale.push({ checkIndex, path, lastObservationSeq, changeEventId: mutation.id, changeEventSeq: mutation.seq })
    }
    if (!changedPaths.length || check.status !== 'passed') continue
    const description = changedPaths.slice(0, 3).map((path) => JSON.stringify(path.slice(0, 250))).join(', ')
    if (check.required && result.outcome === 'completed') {
      fail(`Check ${checkIndex + 1} cites observations from before ${description} changed. Verify only the affected file/check and cite the new call, or use outcome limited with that check unverified/failed. Keep unrelated passing checks; the old observation does not verify these current bytes.`)
    }
    check.status = 'unverified'
    const note = `Current file evidence is unverified: ${description} changed after this check's last cited observation (event sequence ${lastObservationSeq}). The earlier result is retained as history, not a pass for the current file.`
    check.note = `${note}${check.note ? `\n${check.note}` : ''}`.slice(0, 8000)
  }
  return stale
}

/** A private tool byte receipt remains authoritative even without a journaled
 * mutation (for example, another process wrote the file after extraction). */
function bindObservedFileBytes(result: TaskVerification, workspace: string,
  terminalByCall: ReadonlyMap<string, SessionEvent>, file: TaskVerificationReceipt['fileEvidence'][number],
): NonNullable<TaskVerificationReceipt['mismatchedFileEvidence']> {
  const mismatches: NonNullable<TaskVerificationReceipt['mismatchedFileEvidence']> = []
  for (const [checkIndex, check] of result.checks.entries()) {
    if (!check.evidence.paths?.includes(file.path)) continue
    let latest: { event: SessionEvent; sha256: string; bytes: number } | undefined
    for (const callId of check.evidence.callIds ?? []) {
      const event = terminalByCall.get(callId)!
      const receipt = event.data.fileEvidence
      // Only private server attestations qualify, never model-visible JSON.
      if (!object(receipt) || receipt.version !== 1 || typeof receipt.path !== 'string'
        || typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.sha256)
        || typeof receipt.bytes !== 'number' || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0) continue
      if (evidenceTarget(workspace, receipt.path) !== evidenceTarget(workspace, file.path)
        || latest && latest.event.seq >= event.seq) continue
      latest = { event, sha256: receipt.sha256, bytes: receipt.bytes }
    }
    if (!latest || latest.sha256 === file.sha256 && latest.bytes === file.bytes) continue
    mismatches.push({ checkIndex, path: file.path, callId: latest.event.callId!, eventId: latest.event.id,
      eventSeq: latest.event.seq, observedSha256: latest.sha256, observedBytes: latest.bytes })
    if (check.status !== 'passed') continue
    if (check.required && result.outcome === 'completed') {
      fail(`Check ${checkIndex + 1} cites an observation of different file bytes for ${JSON.stringify(file.path)}. Verify only the affected file/check and cite the current observation, or use outcome limited with that check unverified/failed. A new file hash cannot turn the earlier observation into a pass.`)
    }
    check.status = 'unverified'
    const note = `Current file evidence is unverified: the cited observation ${JSON.stringify(latest.event.callId)} consumed different file bytes for ${JSON.stringify(file.path)}. The earlier result remains historical evidence.`
    check.note = `${note}${check.note ? `\n${check.note}` : ''}`.slice(0, 8000)
  }
  return mismatches
}

export function parseTaskVerification(value: unknown): TaskVerification {
  if (!object(value)) fail('finish_task requires an object.')
  keys(value, ['summary', 'outcome', 'checks'])
  if (!text(value.summary, 128_000) || typeof value.outcome !== 'string'
    || !['completed', 'limited'].includes(value.outcome)) fail('A nonempty summary and completed/limited outcome are required.')
  if (!Array.isArray(value.checks) || value.checks.length > 128) fail('checks must be an array of at most 128 selected checks.')
  const checks = value.checks.map((raw): TaskVerificationCheck => {
    if (!object(raw)) fail('Each check must be an object.')
    keys(raw, ['requirement', 'method', 'required', 'status', 'evidence', 'note'])
    if (!text(raw.requirement, 4000) || !text(raw.method, 8000) || typeof raw.required !== 'boolean'
      || typeof raw.status !== 'string' || !statuses.has(raw.status) || !object(raw.evidence)
      || (raw.note !== undefined && !text(raw.note, 8000))) fail('Each check needs requirement, method, required, status and evidence.')
    keys(raw.evidence, ['callIds', 'paths'])
    const callIds = strings(raw.evidence.callIds, 'callIds')
    const paths = strings(raw.evidence.paths, 'paths')
    return { requirement: raw.requirement, method: raw.method, required: raw.required,
      status: raw.status as TaskVerificationCheck['status'], evidence: { ...(callIds ? { callIds } : {}), ...(paths ? { paths } : {}) },
      ...(typeof raw.note === 'string' ? { note: raw.note } : {}) }
  })
  if (value.outcome === 'completed' && checks.some((check) => check.required && ['failed', 'unverified'].includes(check.status))) {
    fail('A core check remains failed/unverified. Repair it if feasible, or deliver honestly with outcome limited; do not relabel the check as passed.')
  }
  return { summary: value.summary, outcome: value.outcome as TaskVerification['outcome'], checks }
}

/** No task classifiers or semantic score thresholds. Bind only the evidence the agent selected. */
export async function bindTaskVerification(value: unknown, options: {
  task: string; workspace: string; events: readonly SessionEvent[]; requireChecks?: boolean
}): Promise<TaskVerificationReceipt> {
  const result = parseTaskVerification(value)
  for (const check of result.checks) {
    if (check.evidence.paths) check.evidence.paths = [...new Set(check.evidence.paths
      .map((path) => relative(options.workspace, evidenceTarget(options.workspace, path)).replaceAll('\\', '/')))]
  }
  if (options.requireChecks && !result.checks.length) fail('Record the necessary check, or explain in a not_needed check why no additional verification is warranted.')
  const terminalByCall = new Map(options.events.filter((event) => event.callId
    && ['tool.completed', 'tool.failed', 'tool.timed_out'].includes(event.type)).map((event) => [event.callId!, event]))
  const ids = [...new Set(result.checks.flatMap((check) => check.evidence.callIds ?? []))]
  const eventEvidence = ids.map((callId) => {
    const event = terminalByCall.get(callId)
    if (!event) fail(`Evidence call ${JSON.stringify(callId)} has no durable terminal in this task. Use a real call ID, or describe a reasoning-only check without a fabricated reference.`)
    if (nonExecutionResult(event)) fail(`Evidence call ${JSON.stringify(callId)} was not executed or was cancelled. It cannot establish an actual execution result. Use a completed observation, or remove that execution reference and mark the check unverified/failed with outcome limited when it is required. Do not retry a potentially state-changing operation blindly.`)
    return { callId, eventId: event.id, seq: event.seq, sha256: digest(JSON.stringify(event)) }
  })
  const staleFileEvidence = bindCheckFileRevisions(result, options.workspace, options.events, terminalByCall)
  let totalBytes = 0
  const fileEvidence: TaskVerificationReceipt['fileEvidence'] = []
  const mismatchedFileEvidence: NonNullable<TaskVerificationReceipt['mismatchedFileEvidence']> = []
  const unavailableFileEvidence: NonNullable<TaskVerificationReceipt['unavailableFileEvidence']> = []
  for (const path of new Set(result.checks.flatMap((check) => check.evidence.paths ?? []))) {
    const target = evidenceTarget(options.workspace, path)
    try {
      await assertNoSymlinkTraversal(options.workspace, target)
      const before = await stat(target)
      if (!before.isFile() || before.size > 128 * 1024 * 1024 || totalBytes + before.size > 128 * 1024 * 1024) {
        fail('File evidence must be ordinary files within the 128 MiB binding limit; use bounded actual tool observations for larger results.')
      }
      const bytes = await readFile(target)
      const after = await stat(target)
      if (bytes.length !== before.size || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size) fail('Evidence changed while being read; inspect the current file before completing.')
      totalBytes += bytes.length
      const file = { path, bytes: bytes.length, sha256: digest(bytes) }
      mismatchedFileEvidence.push(...bindObservedFileBytes(result, options.workspace, terminalByCall, file))
      fileEvidence.push(file)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const reason = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing'
        : code === 'EACCES' || code === 'EPERM' ? 'unreadable' : undefined
      if (!reason) throw error
      const checkIndexes = result.checks.flatMap((check, index) => check.evidence.paths?.some((candidate) => evidenceTarget(options.workspace, candidate) === target) ? [index] : [])
      if (checkIndexes.some((index) => result.checks[index].status === 'passed')) {
        fail(`File evidence ${JSON.stringify(path)} is ${reason}. A passed check cannot cite unavailable file bytes. Inspect the correct current path, or honestly mark the affected check unverified/failed (and use outcome limited if required).`)
      }
      unavailableFileEvidence.push({ path, reason, checkIndexes })
    }
  }
  const unavailable = unavailableFileEvidence.length ? { unavailableFileEvidence } : {}
  const stale = staleFileEvidence.length ? { staleFileEvidence } : {}
  const mismatched = mismatchedFileEvidence.length ? { mismatchedFileEvidence } : {}
  return { ...result, schemaVersion: 1, taskSha256: digest(options.task),
    evidenceSha256: digest(JSON.stringify({ eventEvidence, fileEvidence, ...unavailable, ...stale, ...mismatched })),
    eventEvidence, fileEvidence, ...unavailable, ...stale, ...mismatched }
}

export async function taskVerificationFilesCurrent(receipt: TaskVerificationReceipt, workspace: string): Promise<boolean> {
  const passingTargets = new Set(receipt.checks.filter((check) => check.status === 'passed')
    .flatMap((check) => (check.evidence.paths ?? []).map((path) => evidenceTarget(workspace, path))))
  for (const file of receipt.fileEvidence) {
    try {
      const target = resolveWorkspacePath(workspace, file.path)
      // Unverified/failed observations remain honest historical evidence. A
      // later change cannot promote them to a pass or force an optional repair.
      if (!passingTargets.has(target)) continue
      await assertNoSymlinkTraversal(workspace, target)
      const info = await stat(target)
      if (info.size !== file.bytes || digest(await readFile(target)) !== file.sha256) return false
    } catch { return false }
  }
  return true
}
