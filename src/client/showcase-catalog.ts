import type { UsageTotals } from '../shared/types'
import rawShowcaseCatalog from './showcase-catalog.json'

export interface ShowcaseDemoDefinition {
  id: string
  title: string
  eyebrow: string
  note: string
  metrics: UsageTotals
}

interface ShowcaseCatalogData {
  schemaVersion: string
  generatedAt: string
  disclosure: string
  defaultSessionId: string
  demos: ShowcaseDemoDefinition[]
}

export const showcaseCatalog = rawShowcaseCatalog as unknown as ShowcaseCatalogData
