import { createHash } from 'node:crypto'

/** A declaration is retained context, not an observed outcome. This manifest
 * identifies the exact available text without promoting its contents into a
 * fact-only consumer. It neither resolves a claim nor establishes its truth. */
export interface ModelDeclarationManifest {
  origin: 'model'
  source: string
  snapshotSha256: string
  disposition: 'not_revalidated_against_current_evidence'
  availableEntryCount: number
  omittedEntryCount: number
  availableTextLocation: 'full_content_evidence' | 'durable_research_brief'
}

export function modelDeclarationManifest(source: string, entries: Array<{ field: string; text: string }>, omittedEntryCount = 0,
  availableTextLocation: ModelDeclarationManifest['availableTextLocation'] = 'full_content_evidence'): ModelDeclarationManifest {
  if (!source.trim() || !Number.isSafeInteger(omittedEntryCount) || omittedEntryCount < 0
    || !['full_content_evidence', 'durable_research_brief'].includes(availableTextLocation)) throw new Error('Invalid declaration provenance')
  return { origin: 'model', source,
    snapshotSha256: createHash('sha256').update(JSON.stringify({ source, entries, omittedEntryCount })).digest('hex'),
    disposition: 'not_revalidated_against_current_evidence', availableEntryCount: entries.length, omittedEntryCount,
    availableTextLocation }
}
