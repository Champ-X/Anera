import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { comparePngFiles } from './visual-diff.js'

describe('visual PNG diff', () => {
  it('reports an exact image as zero-error and passing', async () => {
    const image = resolve('arena_probe_fixtures/M01_ui_reference.png')
    const report = await comparePngFiles(image, image)
    expect(report).toMatchObject({
      dimensionEqual: true,
      changedPixels: 0,
      changedRatio: 0,
      meanAbsoluteError: 0,
      rootMeanSquareError: 0,
      pixelSimilarity: 1,
      passed: true,
    })
  }, 15_000)
})
