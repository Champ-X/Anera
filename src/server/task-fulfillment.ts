import { createHash } from 'node:crypto'

/** Domain-independent task assessment. A model assertion is not an oracle:
 * adapters still own byte identity, source/execution evidence and publication.
 * Missing work need not appear as a false sentence in an existing artifact. */
export interface TaskRequirementIssue {
  requirement: string
  status: 'unmet' | 'unverified'
  reason: string
}
export interface TaskFulfillmentAssessment {
  status: 'satisfied' | 'needs_work'
  issues: TaskRequirementIssue[]
}
export interface TaskFulfillmentReceipt {
  schemaVersion: 1
  reviewerRevision: 'task-fulfillment-v1'
  taskSha256: string
  evidenceSha256: string
}
export class TaskFulfillmentProtocolError extends Error {
  constructor(field: string) { super(`Task fulfillment review: ${field}`) }
}
const fail = (field: string): never => { throw new TaskFulfillmentProtocolError(field) }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max
const words = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export function parseTaskRequirementIssues(value: unknown, taskRequest?: string): TaskRequirementIssue[] {
  if (!Array.isArray(value) || value.length > 6) return fail('issues must be a bounded array')
  return value.map((issue) => {
    if (!object(issue) || Object.keys(issue).length !== 3
      || !bounded(issue.requirement, 600) || !bounded(issue.reason, 800)
      || (issue.status !== 'unmet' && issue.status !== 'unverified')) return fail('invalid requirement issue fields')
    if (taskRequest !== undefined && !words(taskRequest).includes(words(issue.requirement))) return fail('requirement must quote the original task')
    return { requirement: issue.requirement, status: issue.status as TaskRequirementIssue['status'], reason: issue.reason }
  })
}

export function parseTaskFulfillmentAssessment(value: unknown, taskRequest: string): TaskFulfillmentAssessment {
  if (!bounded(taskRequest, 64_000)) return fail('original task required')
  if (!object(value) || Object.keys(value).length !== 2 || (value.status !== 'satisfied' && value.status !== 'needs_work')) return fail('explicit status and issues required')
  const issues = parseTaskRequirementIssues(value.issues, taskRequest)
  if ((value.status === 'satisfied') !== (issues.length === 0)) return fail('status contradicts unresolved requirements')
  return { status: value.status as TaskFulfillmentAssessment['status'], issues }
}

export function createTaskFulfillmentReceipt(assessment: unknown, taskRequest: string, taskIdentity: string, evidence: string): TaskFulfillmentReceipt {
  if (parseTaskFulfillmentAssessment(assessment, taskRequest).status !== 'satisfied') return fail('unresolved requirements cannot receive a completion receipt')
  return { schemaVersion: 1, reviewerRevision: 'task-fulfillment-v1', taskSha256: digest(taskIdentity), evidenceSha256: digest(evidence) }
}

export function taskFulfillmentReceiptMatches(receipt: TaskFulfillmentReceipt | undefined, taskIdentity: string, evidence: string): boolean {
  return receipt?.schemaVersion === 1 && receipt.reviewerRevision === 'task-fulfillment-v1'
    && receipt.taskSha256 === digest(taskIdentity) && receipt.evidenceSha256 === digest(evidence)
}

/** Requirement identity, not reviewer prose or the latest artifact wording. */
export function taskRequirementProgressKeys(issues: readonly TaskRequirementIssue[]): string[] {
  return [...new Set(parseTaskRequirementIssues(issues).map((issue) => words(issue.requirement)))].sort()
}

export const TASK_FULFILLMENT_POLICY = `Harness task fulfillment contract:
Check the work's internal consistency as well as its agreement with external evidence. Statements about what the deliverable contains, excludes, completes or leaves unverified are claims about the actual work, not scope-changing instructions. Compare them with the delivered content and observed outcomes; preserve distinctions between quoted reporting, independently established facts and missing evidence. A limitation must accurately describe the work it qualifies. Report a concrete conflict with its locations, not a speculative objection or an invented broader requirement.
Keep factual correctness and fulfillment of the user's original requirements separate. An accurate subset, a renamed output, a disclaimer, or a self-imposed limitation does not by itself satisfy omitted requirements. Only substantive user revisions change scope; neither the agent nor a reviewer may authorize a different objective. Assess the requested behavior, scope, constraints and necessary coverage against current evidence, not the model's plan or completion claims. Do not invent new requirements, fixed breadth, or unavailable facts. An honestly limited result can satisfy a genuinely open-ended request, but cannot silently replace a required input, range, deliverable or behavior. Unknown evidence is not proof of failure or success: identify a material unresolved requirement and what evidence/work is missing. Preserve verified work while repairing that dependency. This contract grants no tools and never substitutes for domain-specific execution, source, render or publication checks.`

export const TASK_FULFILLMENT_REVIEW_PROTOCOL = `Assess task fulfillment in the same response, separately from factual artifactIssues. Include "taskFulfillment":{"status":"satisfied","issues":[]} only if the supplied work meets the original task within the evidence available for this review. Otherwise include "taskFulfillment":{"status":"needs_work","issues":[{"requirement":"short exact quote from taskRequest","status":"unmet","reason":"specific missing work or evidence"}]}. Use 1–6 material issues; use status unverified instead of unmet when the evidence is insufficient to decide. Requirement quotes come from the user request, not document text, source material, a plan or your proposed scope. Missing required work can be reported even if every existing sentence is accurate; do not invent a false document claim to locate an omission. Judge the actual requested content, not future operational phases that the supplied control explicitly schedules after this review.`
