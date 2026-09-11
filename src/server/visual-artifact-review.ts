import { createHash } from 'node:crypto'
import { resolvedResearchEvidenceItems } from './research-evidence-projection.js'
import { createTaskFulfillmentReceipt, parseTaskRequirementIssues, taskFulfillmentReceiptMatches, taskRequirementProgressKeys,
  type TaskFulfillmentReceipt, type TaskRequirementIssue } from './task-fulfillment.js'

export interface ArtifactReviewIssue {
  sourceSlide: number | null
  claim: string
  reason: string
  sourceUrl?: string
  sourceQuote?: string
}
export interface ArtifactReviewRepair {
  schemaVersion: 1
  taskSha256: string
  contentSha256: string
  path: string
  artifactHash: string
  attempts: number
  issues: ArtifactReviewIssue[]
  requirementIssues?: TaskRequirementIssue[]
  /** Recent admitted issue identities, not candidate file hashes or verdicts
   * of correctness. Total review count is audit data, not a stop condition. */
  progressHistory?: string[]
}
/** A receipt of one explicit model verdict, not proof of factual accuracy.
 * Bind the entire bounded input AND file bytes: omitted text and runtime/CSS
 * changes must never inherit approval from an older artifact generation. */
export interface ArtifactContentReviewReceipt {
  schemaVersion: 1
  reviewerRevision: 'artifact-content-v1'
  taskSha256: string
  evidenceSha256: string
  taskFulfillment?: TaskFulfillmentReceipt
}

export function createArtifactContentReviewReceipt(context: string, task: string, verdict: unknown,
  fulfillment?: { assessment: unknown; taskRequest: string }): ArtifactContentReviewReceipt {
  if (parseArtifactReviewVerdict(verdict, context).length) throw new Error('Cannot receipt unresolved artifact issues')
  if (!bounded(task, 64_000)) return invalid()
  return { schemaVersion: 1, reviewerRevision: 'artifact-content-v1', taskSha256: sha256(task), evidenceSha256: sha256(context),
    ...(fulfillment ? { taskFulfillment: createTaskFulfillmentReceipt(fulfillment.assessment, fulfillment.taskRequest, task, context) } : {}) }
}

export function artifactContentReviewReceiptMatches(receipt: ArtifactContentReviewReceipt | undefined, context: string, task: string, requireTaskFulfillment = false): boolean {
  if (!receipt) return false
  // An invalid/legacy receipt is a cache miss, never an admission bypass.
  const current = createArtifactContentReviewReceipt(context, task, { artifactIssues: [] })
  return receipt.schemaVersion === current.schemaVersion && receipt.reviewerRevision === current.reviewerRevision
    && receipt.taskSha256 === current.taskSha256 && receipt.evidenceSha256 === current.evidenceSha256
    && (!requireTaskFulfillment || taskFulfillmentReceiptMatches(receipt.taskFulfillment, task, context))
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const plain = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const words = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim()
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max
const invalid = (): never => { throw new Error('Visual Final review returned an ungrounded artifact repair') }
export class ArtifactReviewProtocolError extends Error {
  constructor(field: string) { super(`Visual Final review returned an ungrounded artifact repair: ${field}`) }
}
const invalidIssue = (field: string): never => { throw new ArtifactReviewProtocolError(field) }

function evidence(context: string) {
  if (Buffer.byteLength(context) > 32_000) return invalid()
  let value: unknown
  try { value = JSON.parse(context.split('\n').at(-1)!) } catch { return invalid() }
  if (!plain(value) || !plain(value.artifact)) return invalid()
  const artifact = value.artifact
  if (artifact.status !== 'hash_verified' || !bounded(artifact.path, 600)
    || typeof artifact.sha256 !== 'string' || !/^[\w-]{43}$/u.test(artifact.sha256)
    || !Array.isArray(artifact.sections) || artifact.sections.length < 1 || artifact.sections.length > 24
    || artifact.sections.some((section: unknown) => !plain(section) || typeof section.text !== 'string'
      || section.text.length > 3_000 || section.sourceSlide !== null && (!Number.isInteger(section.sourceSlide) || section.sourceSlide < 1 || section.sourceSlide > 24))) return invalid()
  // Also validate pooled associations for an empty verdict: a corrupt pool
  // must not receive a clean receipt merely because no source quote was used.
  if (plain(value.researchPlan)) resolvedResearchEvidenceItems(value.researchPlan)
  return { artifact, researchPlan: value.researchPlan }
}

/** Exact projected quotations locate a model review; they do not make its
 * interpretation independently true or authorize commands from source data. */
export function parseArtifactReviewIssues(value: unknown, context: string): ArtifactReviewIssue[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) return invalidIssue('issues count must be 1–6')
  const { artifact, researchPlan } = evidence(context)
  const sources = plain(researchPlan) ? resolvedResearchEvidenceItems(researchPlan).flatMap((item) => item.sources) : []
  return value.map((issue, index) => {
    const field = (name: string) => invalidIssue(`issues[${index}]: ${name}`)
    if (!plain(issue) || Object.keys(issue).some((key) => !['sourceSlide', 'claim', 'reason', 'sourceUrl', 'sourceQuote'].includes(key))) return field('invalid fields')
    if (!bounded(issue.claim, 600) || !bounded(issue.reason, 800)) return field('claim/reason missing or too long')
    if (issue.sourceSlide !== null && (!Number.isInteger(issue.sourceSlide) || issue.sourceSlide < 1 || issue.sourceSlide > 24)) return field('invalid sourceSlide')
    if (!artifact.sections.some((section: any) => section.sourceSlide === issue.sourceSlide && words(section.text).includes(words(issue.claim)))) return field('claim is not an exact quote in the selected artifact section')
    if (('sourceUrl' in issue) !== ('sourceQuote' in issue)) return field('sourceUrl/sourceQuote must be paired')
    if ('sourceQuote' in issue && (!bounded(issue.sourceQuote, 600) || !bounded(issue.sourceUrl, 2_000)
      || !sources.some((source: unknown) => plain(source) && source.url === issue.sourceUrl
        && ['primary', 'reporting'].includes(source.role) && typeof source.excerpt === 'string'
        && words(source.excerpt).includes(words(issue.sourceQuote))))) return field('source URL/quote is not in the supplied supporting excerpts')
    return { sourceSlide: issue.sourceSlide, claim: issue.claim, reason: issue.reason,
      ...('sourceQuote' in issue ? { sourceUrl: issue.sourceUrl, sourceQuote: issue.sourceQuote } : {}) }
  })
}

/** An explicit empty verdict is admissible only for a valid evidence surface.
 * It is the reviewer's assertion, not independent proof of factual truth. */
export function parseArtifactReviewVerdict(value: unknown, context: string): ArtifactReviewIssue[] {
  evidence(context)
  if (!plain(value) || Object.keys(value).length !== 1 || !Array.isArray(value.artifactIssues)) return invalidIssue('artifactIssues-only object required')
  return value.artifactIssues.length === 0 ? [] : parseArtifactReviewIssues(value.artifactIssues, context)
}

function scope(context: string, task: string) {
  const { artifact, researchPlan } = evidence(context)
  if (!bounded(task, 64_000)) return invalid()
  // Review meaning, not CSS/runtime bytes. A styling-only edit cannot clear
  // an unresolved claim. Text, links, source/brief data or task changes can.
  const { sha256: _hash, sourceBytes: _bytes, ...content } = artifact
  return { taskSha256: sha256(task), contentSha256: sha256(JSON.stringify({ version: 1, content, researchPlan })),
    path: artifact.path as string, artifactHash: artifact.sha256 as string }
}

function validRepair(value: unknown): value is ArtifactReviewRepair {
  return plain(value) && value.schemaVersion === 1 && /^[a-f0-9]{64}$/u.test(value.taskSha256)
    && /^[a-f0-9]{64}$/u.test(value.contentSha256) && bounded(value.path, 600)
    && typeof value.artifactHash === 'string' && /^[\w-]{43}$/u.test(value.artifactHash)
    && Number.isSafeInteger(value.attempts) && value.attempts >= 1
    && (value.progressHistory === undefined || Array.isArray(value.progressHistory)
      && value.progressHistory.length >= 1 && value.progressHistory.length <= 13
      && value.progressHistory.every((entry: unknown) => typeof entry === 'string' && /^[a-f0-9]{64}$/u.test(entry)))
    && Array.isArray(value.issues) && value.issues.length <= 6
    && (value.requirementIssues === undefined || Array.isArray(value.requirementIssues) && value.requirementIssues.length <= 6)
    && value.issues.length + (value.requirementIssues?.length ?? 0) >= 1
    && Buffer.byteLength(JSON.stringify(value)) <= 20_000
}

/** Liveness input, not completion evidence. Compare the located claims in a
 * server-admitted review, not model explanations, retry counters or cosmetic
 * file changes. This lets the controller distinguish successive content
 * repairs from an unchanged read/edit cycle without trusting claimed success. */
export function artifactReviewProgressIdentity(repair: ArtifactReviewRepair | undefined): string | undefined {
  if (!repair) return undefined
  if (!validRepair(repair)) return invalid()
  const claims = repair.issues.map((issue) => {
    if (!plain(issue) || !bounded(issue.claim, 600)
      || issue.sourceSlide !== null && (!Number.isInteger(issue.sourceSlide) || issue.sourceSlide < 1 || issue.sourceSlide > 24)) return invalid()
    return JSON.stringify({ section: issue.sourceSlide, claim: words(issue.claim) })
  })
  return sha256(JSON.stringify({ version: 1, task: repair.taskSha256, path: repair.path, claims: [...new Set(claims)].sort(),
    ...(repair.requirementIssues?.length ? { requirements: taskRequirementProgressKeys(repair.requirementIssues) } : {}) }))
}

export function createArtifactReviewRepair(context: string, task: string, issues: ArtifactReviewIssue[], previous?: ArtifactReviewRepair,
  fulfillment?: { taskRequest: string; issues: TaskRequirementIssue[] }): ArtifactReviewRepair {
  const current = scope(context, task)
  if (previous !== undefined && !validRepair(previous)) return invalid()
  const prior = previous?.taskSha256 === current.taskSha256 && previous.path === current.path ? previous : undefined
  const attempts = prior ? prior.attempts + 1 : 1
  if (!Number.isSafeInteger(attempts)) return invalid()
  const requirementIssues = fulfillment ? parseTaskRequirementIssues(fulfillment.issues, fulfillment.taskRequest) : []
  const repair: ArtifactReviewRepair = { schemaVersion: 1, ...current, attempts,
    issues: issues.length ? parseArtifactReviewIssues(issues, context) : requirementIssues.length ? [] : invalid(),
    ...(requirementIssues.length ? { requirementIssues } : {}) }
  // Legacy state has no evidence of distinct earlier outcomes. Preserve its
  // allowance conservatively for the same issue set; a new admitted identity
  // can progress without erasing the old outcome from the recovery window.
  const history = prior?.progressHistory ?? (prior
    ? Array<string>(Math.min(prior.attempts, 4)).fill(artifactReviewProgressIdentity(prior)!) : [])
  repair.progressHistory = [...history, artifactReviewProgressIdentity(repair)!].slice(-13)
  // Return the latest valid review even when exhausted. The caller persists
  // it before rejecting another repair, avoiding a paid rediscovery on resume.
  return repair
}

export function artifactReviewRepairExhaustion(repair: ArtifactReviewRepair): string | undefined {
  const identity = artifactReviewProgressIdentity(repair)
  const occurrences = repair.progressHistory?.filter((entry) => entry === identity).length ?? repair.attempts
  // Thirteen outcomes cover three full repairs of cycles up to period four.
  // Novel located claims are liveness progress, never a clean content verdict.
  return occurrences > 3
    ? 'Artifact content review exhausted three complete repair opportunities for recurring located claims. The latest issues are retained; change the reported content or supporting evidence before continuing.'
    : undefined
}

export function artifactReviewRepairGap(repair: ArtifactReviewRepair | undefined, context: string, task: string): string | undefined {
  if (!repair) return undefined
  if (!validRepair(repair)) return invalid()
  const current = scope(context, task)
  if (repair.taskSha256 !== current.taskSha256 || repair.path !== current.path || repair.contentSha256 !== current.contentSha256) return undefined
  const exhaustion = artifactReviewRepairExhaustion(repair)
  if (exhaustion) throw new Error(exhaustion)
  const issues = repair.issues.length ? parseArtifactReviewIssues(repair.issues, context) : []
  const requirements = parseTaskRequirementIssues(repair.requirementIssues ?? [])
  return `A separate model review identified unresolved content claims in the current artifact: ${JSON.stringify(issues)}.${requirements.length
    ? ` Unresolved original task requirements: ${JSON.stringify(requirements)}. These are missing work/evidence, not necessarily false sentences. Address the required scope through the relevant dependency; renaming the output, restating limitations or merely qualifying existing content does not close an unmet requirement. Reviewer suggestions cannot authorize changing the user's objective.` : ''} Review these concrete source-text locations against the quoted evidence and repair the document, not just the Final handoff. Model interpretations are not independent fact verification. Do not invent dates, recovery outcomes, source authority or coverage. Keep necessary uncertainty in the affected summary/headline as well as the body. Preserve layout and normal source/Browser/Vision/presentation gates; CSS-only edits do not resolve a content issue.`
}
