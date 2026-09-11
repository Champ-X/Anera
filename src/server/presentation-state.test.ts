import { describe, expect, it } from 'vitest'
import { compactPresentationViewport, presentationActiveState, presentationStageViolations, type PresentationStateSnapshot } from './presentation-state.js'

const slide = (index: number, changes: Partial<PresentationStateSnapshot> = {}): PresentationStateSnapshot => ({
  index, className: 'slide', deckActive: false, ariaHidden: null, hidden: false, inert: false,
  display: 'block', position: 'absolute', visibility: 'hidden', opacity: '0',
  intersectsViewport: false, rect: [0, 0, 1200, 800], ...changes,
})
const visible = { intersectsViewport: true, visibility: 'visible', opacity: '1' }

it('derives a bounded compact probe from design geometry without a task or template lookup', () => {
  expect(compactPresentationViewport({ width: 1920, height: 1080 })).toEqual({ width: 640, height: 360 })
  expect(compactPresentationViewport({ width: 801, height: 603 })).toEqual({ width: 267, height: 201 })
  expect(compactPresentationViewport({ width: 1, height: 1 })).toEqual({ width: 1, height: 1 })
})

it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid design dimensions %s', width => {
  expect(() => compactPresentationViewport({ width, height: 600 })).toThrow('Invalid')
})

describe('shared presentation state ownership', () => {
  it.each(['cover', 'content', 'closing'])('uses native ownership despite a stale class in %s', (phase) => {
    const slides = [slide(0, { className: 'slide active' }), slide(1, { deckActive: true, ...visible })]
    expect(presentationActiveState(slides)).toEqual({ controller: 'data-deck-active', indices: [1] })
    expect(presentationStageViolations(phase, slides)).toEqual([])
  })

  it.each(['none', 'block'])('reports the hidden native root instead of accepting a painted stale cover (display=%s)', (display) => {
    const slides = [slide(0, { className: 'slide active', ...visible }), slide(1, { deckActive: true, display })]
    const violations = presentationStageViolations('content', slides)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('active slide 2 does not visibly intersect')
    expect(violations[0]).toContain('Native [data-deck-active] selects slide(s) 2; .active selects slide(s) 1')
    expect(violations[0]).toContain(`display=${display}, visibility=hidden, opacity=0`)
    expect(violations[0]).toContain('shadow-root ::slotted')
  })

  it('reports the native target even when every slide is blank', () => {
    expect(presentationStageViolations('content', [slide(0, { className: 'slide active' }), slide(1, { deckActive: true })])[0])
      .toContain('active slide 2 does not visibly intersect')
  })

  it.each(['data-deck-active', 'active-class', 'visibility'] as const)('retains multiple-root rejection for %s', (controller) => {
    const changes = controller === 'data-deck-active' ? { deckActive: true }
      : controller === 'active-class' ? { className: 'slide active' } : visible
    expect(presentationStageViolations('content', [slide(0, changes), slide(1, changes)])[0])
      .toContain('has 2 active presentation roots')
  })

  it.each(['data-deck-active', 'active-class'] as const)('rejects extra painted roots for %s', (controller) => {
    const changes = controller === 'data-deck-active' ? { deckActive: true } : { className: 'slide active' }
    expect(presentationStageViolations('content', [slide(0, visible), slide(1, { ...visible, ...changes })])[0])
      .toContain('has 2 visible slides intersecting the viewport; exactly the active slide 2 must intersect')
  })

  it.each(['data-deck-active', 'active-class'] as const)('uses the actual state selector in a vertical-flow diagnostic (%s)', (controller) => {
    const changes = controller === 'data-deck-active' ? { deckActive: true } : { className: 'slide active' }
    const violations = presentationStageViolations('content', [slide(0, { position: 'relative' }),
      slide(1, { ...changes, rect: [0, 800, 1200, 800] })])
    expect(violations[0]).toContain('inactive predecessor slide still occupies normal vertical flow')
    expect(violations[0]).toContain(controller === 'data-deck-active' ? ':not([data-deck-active])' : ':not(.active)')
  })

  it.each(['active-class', 'visibility'] as const)('preserves valid non-native decks (%s)', (controller) => {
    const changes = controller === 'active-class' ? { className: 'slide active' } : {}
    const slides = [slide(0), slide(1, { ...visible, ...changes })]
    expect(presentationActiveState(slides)).toEqual({ controller, indices: [1] })
    expect(presentationStageViolations('content', slides)).toEqual([])
  })

  it('does not fabricate native ownership or stage evidence', () => {
    expect(presentationStageViolations('content', [slide(0, { className: 'slide inactive' })])[0]).toContain('has 0 active presentation roots')
    expect(presentationStageViolations('content', [])).toEqual([])
  })
})
