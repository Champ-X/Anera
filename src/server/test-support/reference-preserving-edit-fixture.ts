import { createHash } from 'node:crypto'
import { extractReferenceStyleSourceProfile, type DurableReferenceStyleContract, type ReferenceStyleContract } from '../reference-style.js'

export const referenceUrl = 'https://reference.example/workshop.html'
export const source = '<!doctype html><html><head><title>Workshop</title><style>body{font-family:Inter;color:#ffffff}.slide{background:#102030;padding:24px}.headline{font-size:96px;font-weight:600}</style></head><body><section class="slide"><h1 class="headline">Workshop notes</h1><p>Verified content</p></section><script>window.fixtureNavigation=true</script></body></html>'
export const fixtureHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export function referenceFixture(): DurableReferenceStyleContract {
  const contract: ReferenceStyleContract = { sourceUrl: referenceUrl, strictness: 'exact',
    colors: ['#102030', '#ffffff'], fonts: ['Inter'], layout: ['full viewport'], components: ['slide', 'headline'],
    requiredMarkers: ['.slide', '.headline'], signature: 'Dark workshop slides', avoid: ['invented palette'],
    viewport: { width: 1000, height: 600 } }
  return { contract, provenance: { resolvedUrl: referenceUrl, evidenceSha256: fixtureHash(source), evidenceBytes: Buffer.byteLength(source) },
    sourceProfile: extractReferenceStyleSourceProfile(source, contract)! }
}
