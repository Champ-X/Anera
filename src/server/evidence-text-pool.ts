import { createHash } from 'node:crypto'

/** Lossless request-local storage, not a truth/freshness receipt. Provenance
 * stays on every occurrence; only identical source/version/text triples share
 * bytes. No normalization, partial excerpts, or cross-version substitution. */
export interface EvidenceText {
  sourceId: string
  sourceRevision: string
  /** null means unavailable text; it is never an empty verified passage. */
  text: string | null
}
export interface SharedEvidenceText extends EvidenceText { id: string }
const idOf = (entry: EvidenceText) => createHash('sha256')
  .update(JSON.stringify([entry.sourceId, entry.sourceRevision, entry.text])).digest('hex')
const valid = (entry: EvidenceText) => typeof entry.sourceId === 'string' && entry.sourceId.length > 0 && entry.sourceId.length <= 4096
  && typeof entry.sourceRevision === 'string' && /^[a-f0-9]{64}$/u.test(entry.sourceRevision)
  && (entry.text === null || typeof entry.text === 'string' && Buffer.byteLength(entry.text) <= 32_000)

export function sharedEvidenceTexts(entries: readonly EvidenceText[]): SharedEvidenceText[] {
  if (entries.length > 64 || entries.some((entry) => !valid(entry))) throw new Error('Invalid bounded evidence text')
  const seen = new Map<string, SharedEvidenceText>()
  const repeated = new Set<string>()
  for (const entry of entries) {
    const id = idOf(entry)
    if (seen.has(id)) repeated.add(id)
    else seen.set(id, { sourceId: entry.sourceId, sourceRevision: entry.sourceRevision, text: entry.text, id })
  }
  return [...seen.values()].filter((entry) => repeated.has(entry.id))
}

export function evidenceTextId(entry: EvidenceText): string {
  if (!valid(entry)) throw new Error('Invalid bounded evidence text')
  return idOf(entry)
}

/** Evict whole payloads under a fixed consumer budget. Prefer unrelated
 * sources, then extra passages of an already represented source/version,
 * before its last supporting passage. Relevance is supplied by the consumer's
 * actual dependencies, never inferred from topic, language, or model prose.
 * This is coverage preservation, not a judgment of which passage is true. */
export function evidenceTextEviction(entries: readonly EvidenceText[], relevantSources: ReadonlySet<string>): number[] {
  if (entries.length > 64 || entries.some((entry) => !valid(entry) || entry.text === null)) throw new Error('Invalid bounded evidence text')
  const groups = new Map<string, { entry: EvidenceText; indices: number[] }>()
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const id = idOf(entry)
    const group = groups.get(id) ?? { entry, indices: [] }
    group.indices.push(index)
    groups.set(id, group)
  }
  const sourceKey = (entry: EvidenceText) => JSON.stringify([entry.sourceId, entry.sourceRevision])
  const count = new Map<string, number>()
  for (const { entry } of groups.values()) count.set(sourceKey(entry), (count.get(sourceKey(entry)) ?? 0) + 1)
  const tier = (entry: EvidenceText) => !relevantSources.has(entry.sourceId) ? 0 : count.get(sourceKey(entry))! > 1 ? 1 : 2
  return [...groups.values()].sort((a, b) => tier(a.entry) - tier(b.entry)
    || Buffer.byteLength(b.entry.text!) - Buffer.byteLength(a.entry.text!))[0]?.indices ?? []
}

/** Build once per bounded consumer input. Invalid/dangling references must
 * fail closed at the consumer, not silently become absent supporting text. */
export function evidenceTextResolver(value: unknown) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid evidence text pool')
  const entries = new Map<string, SharedEvidenceText>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'id,sourceId,sourceRevision,text'
      || !valid(entry) || entry.id !== idOf(entry) || entries.has(entry.id)) throw new Error('Invalid evidence text pool entry')
    entries.set(entry.id, { ...entry })
  }
  return (id: unknown, sourceId: unknown, sourceRevision: unknown): string | null => {
    const entry = typeof id === 'string' ? entries.get(id) : undefined
    if (!entry || sourceId !== entry.sourceId || sourceRevision !== entry.sourceRevision) throw new Error('Unresolved source-bound evidence text')
    return entry.text
  }
}
