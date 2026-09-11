import { createHash } from 'node:crypto'

/** Server provenance for a task-dependent interpretation/plan, not raw input
 * freshness or semantic approval. Sources and plans have different lifetimes. */
export interface TaskPlanBinding {
  schemaVersion: 1
  taskSha256: string
  planSha256: string
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export function createTaskPlanBinding(taskIdentity: string, planSha256: string): TaskPlanBinding {
  if (!taskIdentity.trim() || Buffer.byteLength(taskIdentity) > 64_000 || !sha(planSha256)) throw new Error('Task plan binding requires a bounded task identity and plan digest')
  return { schemaVersion: 1, taskSha256: digest(taskIdentity), planSha256 }
}

export function normalizeTaskPlanBinding(value: unknown): TaskPlanBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  return item.schemaVersion === 1 && sha(item.taskSha256) && sha(item.planSha256)
    ? { schemaVersion: 1, taskSha256: item.taskSha256, planSha256: item.planSha256 } : undefined
}

export function taskPlanBindingMatches(value: unknown, taskIdentity: string, planSha256: string): boolean {
  const binding = normalizeTaskPlanBinding(value)
  return Boolean(binding && binding.taskSha256 === digest(taskIdentity) && binding.planSha256 === planSha256)
}

export const TASK_PLAN_REVIEW_INSTRUCTION = 'The retained research plan has no matching server binding to the current original task and its temporal scope. Its source snapshots remain available, but its selection, date interpretations and coverage are historical proposals, not an accepted current plan. Reassess those sources against the original requirements and record_research_brief; retrieve new sources only for an actual missing dependency. Do not simply change a scope label to approve unchanged unsuitable material. This task binding proves which requirements informed the recorded plan, not that the plan is semantically correct; all content and delivery checks still apply.'
