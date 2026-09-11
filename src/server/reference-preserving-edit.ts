import { createHash } from 'node:crypto'
import { renderedReferenceRuntimeManagedSlideSelectors, verifyHtmlAgainstReferenceStyle,
  type DurableReferenceStyleContract, type ReferenceStyleEvidence, type ReferenceStyleVerification } from './reference-style.js'

/** One static-source policy for explicit verification and edit preflight.
 * Private evidence resolution, language/font materialization and all later
 * Browser/Vision checks remain at their existing boundaries. */
export function verifyDurableReferenceSource(
  html: string, reference: DurableReferenceStyleContract, boundTemplateSource?: ReferenceStyleEvidence,
): ReferenceStyleVerification {
  return verifyHtmlAgainstReferenceStyle(html, reference.contract, reference.sourceProfile, {
    authoritativeRenderedReference: Boolean(reference.renderProfile && reference.visualEvidence),
    ...(boundTemplateSource ? { boundTemplateSource } : {}),
    alternativeLayoutSelectors: reference.renderProfile?.interiorVariants?.map((variant) => variant.layoutSelector),
    runtimeManagedSlideSelectors: renderedReferenceRuntimeManagedSlideSelectors(reference.renderProfile),
  })
}

/** No mutation, network, successful verifier receipt or new fidelity policy.
 * Only a currently passing exact source is protected. Already-invalid bytes
 * may still be repaired coherently, and a multi-edit is checked as one final
 * candidate rather than rejecting its intermediate substitutions. */
export function assertReferenceSourcePreserved(
  before: string, proposed: string, reference: DurableReferenceStyleContract, boundTemplateSource?: ReferenceStyleEvidence,
): void {
  if (before === proposed || reference.contract.strictness !== 'exact' || !reference.sourceProfile) return
  const baseline = verifyDurableReferenceSource(before, reference, boundTemplateSource)
  if (baseline.fidelity !== 'pass' || baseline.score !== 100) return
  const candidate = verifyDurableReferenceSource(proposed, reference, boundTemplateSource)
  if (candidate.fidelity === 'pass' && candidate.score === 100) return
  const defects = [
    ...Object.entries(candidate.missing).flatMap(([kind, values]) => values.map((value) => `missing ${kind}: ${value}`)),
    ...Object.entries(candidate.violations).flatMap(([kind, values]) => values.map((value) => `${kind}: ${value}`)),
  ].slice(0, 8).map((value) => value.replace(/\s+/gu, ' ').slice(0, 400))
  const identity = { current_artifact_hash: createHash('sha256').update(before).digest('base64url'),
    proposed_artifact_hash: createHash('sha256').update(proposed).digest('base64url'),
    reference_sha256: reference.provenance.evidenceSha256, proposed_score: candidate.score, defects }
  throw new Error(`Reference-preserving edit rejected before commit: ${JSON.stringify(identity)}. The current file passes the exact static-source checks, but this proposed edit would invalidate them. No file was changed and existing verification evidence was not invalidated. Revise the edit to preserve the reported source requirements while fixing the remaining defects; do not undo this rejected edit or repeat a source verification on unchanged bytes. This preflight is not a successful verification receipt; all checks required after an accepted mutation still apply.`)
}
