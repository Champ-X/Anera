import { createHash } from 'node:crypto'
import type { ReferenceStyleSourceProfile, RenderedReferenceStyleProfile } from '../reference-style.js'

export interface ReferenceProfileFixtureInput {
  html: string
  sourceProfile: ReferenceStyleSourceProfile
  evidenceSha256: string
  viewport: { width: number; height: number }
}

/**
 * Test-file-local memoization for immutable, network-denied source fixtures.
 * The owner supplies and disposes its dedicated source BrowserManager; this
 * helper never owns candidate contexts, persists evidence, or changes capture.
 * Do not use it for capture failure, cancellation, font/runtime transport, or
 * browser lifecycle tests: those must exercise each real capture boundary.
 * Per-capture options are intentionally unsupported rather than omitted from
 * the cache key. A future option must participate in its immutable identity.
 */
export function createReferenceProfileFixtureCache(
  capture: (input: ReferenceProfileFixtureInput) => Promise<RenderedReferenceStyleProfile>,
) {
  const profiles = new Map<string, Promise<RenderedReferenceStyleProfile>>()
  return {
    async get(input: ReferenceProfileFixtureInput): Promise<RenderedReferenceStyleProfile> {
      const snapshot = structuredClone(input)
      const key = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
      let pending = profiles.get(key)
      if (!pending) {
        pending = Promise.resolve().then(() => capture(snapshot)).then((profile) => structuredClone(profile))
        profiles.set(key, pending)
        const current = pending
        void pending.catch(() => {
          if (profiles.get(key) === current) profiles.delete(key)
        })
      }
      // Neither a consumer nor the capture callback can mutate cached state.
      return structuredClone(await pending)
    },
    clear(): void {
      profiles.clear()
    },
  }
}
