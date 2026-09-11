import type { ModelDeclarationManifest } from './evidence-provenance.js'

/** A delivery receipt describes outcomes, not the work product's contents.
 * Domain adapters own evidence validation; this shape grants no completion
 * authority and cannot substitute for their content/identity gates.
 */
export interface DeliveryReceipt {
  kind: 'delivery_receipt'
  artifacts: Array<{
    path: string
    revision: string
    bytes: number
    units?: { count: number; kind: string }
  }>
  modelDeclarations?: ModelDeclarationManifest
  evidenceLimitations: string[]
  contentEvidenceAvailable: true
}

/** Supplied only by the completed workflow boundary. Scope labels describe
 * available evidence, not universal correctness or additional work to run.
 * Adapters retain the detailed operational record for explicit audit replies.
 */
export interface DeliveryHandoffOutcome {
  kind: 'delivery_outcome'
  artifactDelivery: 'completed'
  availability: 'local'
  verification: Array<{
    scope: string
    outcome: 'performed' | 'pass' | 'fail' | 'inconclusive'
  }>
}

/** Consumer view, not a new receipt or completion authority. Identity and
 * source-unit/declaration diagnostics stay in the caller's immutable evidence
 * and publication guards; the handoff writer needs locations by default.
 * Explicit audit/content requirements can request that same evidence once.
 */
export function deliveryHandoffProjection(receipt: DeliveryReceipt) {
  return {
    kind: 'delivery_handoff' as const,
    artifacts: receipt.artifacts.map(({ path }) => ({ path })),
    evidenceScope: [...receipt.evidenceLimitations],
    contentEvidenceAvailable: receipt.contentEvidenceAvailable,
  }
}

export const DELIVERY_RECEIPT_POLICY = `The deliveryReceipt is a handoff view of the internally validated record, not document contents or factual certification. Its artifact paths locate the work product. File revision, byte counts, source-unit counts, link census and model-declaration diagnostics remain in the same immutable full evidence, not in this default view. evidenceScope bounds what this record establishes; it is not a list of detected artifact defects or mandatory disclaimer paragraphs. Model-authored scope/limitation notes have not been revalidated against the current artifact and must not be promoted to completed actions, established content coverage, failure explanations, or current facts. Respond to the user's actual final-output requirements using only the available outcome record; do not enumerate presumed contents from taskRequest. If answering a substantive explanation, summary, content question, requested audit details, or required qualification needs document/source/declaration text or identity details, return only {"needsContentEvidence":true} to obtain that same evidence once. Assess any material limitation against current document/source evidence before stating it; do not omit a required explanation or limitation, or invent one to avoid requesting evidence. Do not request content simply to acknowledge a delivered file. Missing content here was reserved for content review, not erased from the artifact. For a simple file handoff, identify the file without asserting unobserved coverage or an unproven quality certification.`
