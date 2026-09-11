import { describe, expect, it, vi } from 'vitest'
import type { RenderedReferenceStyleProfile } from '../reference-style.js'
import { createReferenceProfileFixtureCache, type ReferenceProfileFixtureInput } from './reference-profile-cache.js'

function input(): ReferenceProfileFixtureInput {
  return {
    html: '<html>source fixture</html>',
    sourceProfile: { version: 1, rules: [], dom: [], bodyFontFamily: 'Arial' },
    evidenceSha256: 'a'.repeat(64),
    viewport: { width: 800, height: 600 },
  }
}

function profile(): RenderedReferenceStyleProfile {
  const phase = () => ({ anchors: [], overlayProbes: [], textLayout: { version: 2 as const, complete: true, collisions: [] } })
  return {
    version: 1, evidenceSha256: 'a'.repeat(64), viewport: { width: 800, height: 600 },
    phases: { cover: phase(), content: phase(), closing: phase() },
  }
}

describe('test-only immutable reference profile cache', () => {
  it('captures identical inputs once and isolates the producer and every consumer', async () => {
    const original = profile()
    const capture = vi.fn(async () => original)
    const cache = createReferenceProfileFixtureCache(capture)
    const first = await cache.get(input())
    first.phases.cover.textLayout!.complete = false
    original.phases.content.textLayout!.complete = false
    const second = await cache.get(input())
    expect(second).toEqual(profile())
    expect(second).not.toBe(first)
    expect(second.phases.cover).not.toBe(first.phases.cover)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it.each(['html', 'sourceProfile', 'evidenceSha256', 'viewport'] as const)('includes %s in the cache identity', async (field) => {
    const capture = vi.fn(async () => profile())
    const cache = createReferenceProfileFixtureCache(capture)
    const changed = input()
    if (field === 'html') changed.html += ' different bytes'
    if (field === 'sourceProfile') changed.sourceProfile.bodyFontFamily = 'Inter'
    if (field === 'evidenceSha256') changed.evidenceSha256 = 'b'.repeat(64)
    if (field === 'viewport') changed.viewport.height += 1
    await cache.get(input())
    await cache.get(changed)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('coalesces pending captures without sharing returned objects or mutable input', async () => {
    let finish!: (result: RenderedReferenceStyleProfile) => void
    const capture = vi.fn(() => new Promise<RenderedReferenceStyleProfile>((resolve) => { finish = resolve }))
    const cache = createReferenceProfileFixtureCache(capture)
    const mutableInput = input()
    const first = cache.get(mutableInput)
    const second = cache.get(input())
    mutableInput.viewport.height = 999
    await Promise.resolve()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0]).toEqual([input()])
    finish(profile())
    const [left, right] = await Promise.all([first, second])
    expect(left).toEqual(right)
    expect(left.phases.cover).not.toBe(right.phases.cover)
  })

  it('evicts a rejected capture so a later request performs a real retry', async () => {
    const capture = vi.fn<(value: ReferenceProfileFixtureInput) => Promise<RenderedReferenceStyleProfile>>()
      .mockRejectedValueOnce(new Error('capture failed'))
      .mockResolvedValue(profile())
    const cache = createReferenceProfileFixtureCache(capture)
    await expect(cache.get(input())).rejects.toThrow('capture failed')
    await expect(cache.get(input())).resolves.toEqual(profile())
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('keeps separate cache instances and explicitly cleared runs independent', async () => {
    const capture = vi.fn(async () => profile())
    const first = createReferenceProfileFixtureCache(capture)
    const second = createReferenceProfileFixtureCache(capture)
    await first.get(input())
    await second.get(input())
    first.clear()
    await first.get(input())
    expect(capture).toHaveBeenCalledTimes(3)
  })
})
