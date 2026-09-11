import { evidenceTextId, evidenceTextResolver, sharedEvidenceTexts, type EvidenceText, type SharedEvidenceText } from './evidence-text-pool.js'

type Source = { url: string; role: string; snapshotSha256?: string; excerpt?: string; excerptRef?: number; [key: string]: unknown }
type Item = { id: string; sources: Source[]; [key: string]: unknown }
export const SHARED_EXCERPT_CONTROL = 'excerptRef is a zero-based index into researchPlan.sharedExcerpts; sourceId/sourceRevision/text supply that source. Null text is unavailable evidence, not an empty passage.\n'
const text = (source: Source): EvidenceText => ({ sourceId: source.url, sourceRevision: source.snapshotSha256!, text: source.excerpt ?? null })

/** Encode a fresh, already-redacted request object before applying its byte
 * budget. Leave legacy sources without snapshot identity inline. */
export function compactResearchEvidence<T extends { researchPlan?: { items: Item[]; sharedExcerpts?: unknown } }>(surface: T): T {
  if (!surface.researchPlan || surface.researchPlan.sharedExcerpts !== undefined) return surface
  const projected = structuredClone(surface)
  const plan = projected.researchPlan!
  const sources = plan.items.flatMap((item) => item.sources)
  const eligible = sources.filter((source) => (typeof source.excerpt === 'string' || source.excerpt === undefined)
    && typeof source.snapshotSha256 === 'string' && /^[a-f0-9]{64}$/u.test(source.snapshotSha256))
  const shared = sharedEvidenceTexts(eligible.map(text))
  if (!shared.length) return surface
  const ids = new Map(shared.map((entry, index) => [entry.id, index]))
  for (const source of eligible) {
    const id = evidenceTextId(text(source))
    if (!ids.has(id)) continue
    delete source.excerpt
    // Provenance is on the addressed pool entry. Do not repeat the URL and
    // snapshot hash at every occurrence; the decoder restores them exactly.
    delete (source as { url?: string }).url
    delete source.snapshotSha256
    source.excerptRef = ids.get(id)!
  }
  plan.sharedExcerpts = shared
  // Small repeated values can cost more as references than inline text.
  return Buffer.byteLength(JSON.stringify(projected)) < Buffer.byteLength(JSON.stringify(surface)) ? projected : surface
}

/** Consumer compatibility at a single boundary: legacy inline text and new
 * pooled text have exactly the same source/item associations after decoding.
 * Never mutate the compact input that review receipts hash. */
export function resolvedResearchEvidenceItems(plan: { items?: unknown; sharedExcerpts?: unknown } | undefined): Item[] {
  if (!plan) return []
  const resolve = plan.sharedExcerpts === undefined ? undefined : evidenceTextResolver(plan.sharedExcerpts)
  if (!Array.isArray(plan.items) || plan.items.length > 16) {
    if (resolve) throw new Error('Invalid pooled research source associations')
    return []
  }
  return plan.items.map((item) => {
    if (!item || !Array.isArray(item.sources) || item.sources.length > 3) throw new Error('Invalid research source associations')
    return { ...item, sources: item.sources.map((source: Source) => {
      if (!source || typeof source !== 'object') throw new Error('Invalid research source association')
      if (source.excerptRef === undefined) return { ...source }
      if (!resolve || source.excerpt !== undefined) throw new Error('Ambiguous or missing shared excerpt')
      const { excerptRef, ...fields } = source
      if (!Number.isSafeInteger(excerptRef) || excerptRef < 0) throw new Error('Invalid shared excerpt address')
      const entry = (plan.sharedExcerpts as SharedEvidenceText[])[excerptRef]
      if (!entry || source.url !== undefined && source.url !== entry.sourceId
        || source.snapshotSha256 !== undefined && source.snapshotSha256 !== entry.sourceRevision) throw new Error('Conflicting shared excerpt provenance')
      const excerpt = resolve(entry.id, entry.sourceId, entry.sourceRevision)
      return { ...fields, url: entry.sourceId, snapshotSha256: entry.sourceRevision,
        ...(excerpt === null ? {} : { excerpt }) }
    }) }
  })
}
