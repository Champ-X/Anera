/** Controller state and painted state are separate evidence. A native runtime
 * may leave an old .active class in the document without ever updating it. */
export interface PresentationStateSnapshot {
  index: number
  className: string
  deckActive: boolean
  ariaHidden: string | null
  hidden: boolean
  inert: boolean
  display: string
  position: string
  visibility: string
  opacity: string
  intersectsViewport: boolean
  rect: [number, number, number, number]
}

export interface PresentationActiveState {
  controller: 'data-deck-active' | 'active-class' | 'visibility'
  indices: number[]
}

/** A deterministic compact-surface probe, not a responsiveness certificate.
 * Preserve the design aspect ratio and test the existing stage-visibility
 * invariant at one third size. No filename, controller tag or theme policy. */
export function compactPresentationViewport(design: { width: number; height: number }) {
  if (![design.width, design.height].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Invalid presentation design viewport')
  }
  return { width: Math.max(1, Math.round(design.width / 3)), height: Math.max(1, Math.round(design.height / 3)) }
}

// One literal program is shared by Node checks and browser snapshots. Do not
// serialize a transpiled callback: esbuild can inject Node-only name helpers.
export const PRESENTATION_ACTIVE_STATE_SCRIPT = String.raw`(slides) => {
  const native = slides.filter((slide) => slide.deckActive === true)
  const explicit = slides.filter((slide) => slide.className.split(/\s+/u).includes('active'))
  const active = native.length ? native : explicit.length ? explicit : slides.filter((slide) => slide.intersectsViewport)
  return { controller: native.length ? 'data-deck-active' : explicit.length ? 'active-class' : 'visibility',
    indices: active.map((slide) => slide.index) }
}`

export const presentationActiveState = Function(`"use strict"; return (${PRESENTATION_ACTIVE_STATE_SCRIPT})`)() as (
  slides: readonly Pick<PresentationStateSnapshot, 'index' | 'className' | 'deckActive' | 'intersectsViewport'>[],
) => PresentationActiveState

/** Reject the real stage before forced per-layout sampling can hide a broken
 * controller. Diagnostics describe observed ownership, never a passed gate. */
export function presentationStageViolations(phase: string, slides: readonly PresentationStateSnapshot[]): string[] {
  if (slides.length === 0) return []
  const state = presentationActiveState(slides)
  const activeSlides = slides.filter((slide) => state.indices.includes(slide.index))
  const ownership = state.controller === 'data-deck-active'
    ? ` Native [data-deck-active] selects slide(s) ${state.indices.map((index) => index + 1).join(', ')}; .active selects slide(s) ${slides.filter((slide) => slide.className.split(/\s+/u).includes('active')).map((slide) => slide.index + 1).join(', ') || 'none'}. Use the declared runtime's actual state ownership, not a stale class. Authored document visibility/opacity/display rules can override shadow-root ::slotted rules; inspect both layers and preserve the reference geometry.`
    : ''
  if (activeSlides.length !== 1) {
    return [`render ${phase} has ${activeSlides.length} active presentation roots; exactly one active slide must own the viewport stage.${ownership}`]
  }
  const active = activeSlides[0]
  if (!active.intersectsViewport) {
    const flowOccupyingPredecessors = slides.filter((candidate) => candidate.index < active.index
      && candidate.display !== 'none' && !candidate.hidden
      && ['static', 'relative', 'sticky'].includes(candidate.position)
      && candidate.rect[2] > 0.5 && candidate.rect[3] > 0.5)
    const top = Number.isFinite(active.rect[1]) ? `${active.rect[1]}px` : 'outside'
    const computed = ` Observed active root: display=${active.display}, visibility=${active.visibility}, opacity=${active.opacity}, hidden=${active.hidden}, aria-hidden=${active.ariaHidden}, inert=${active.inert}.`
    if (flowOccupyingPredecessors.length > 0) {
      const inactiveRule = state.controller === 'active-class' ? '.slide:not(.active){display:none}'
        : state.controller === 'data-deck-active' ? '.slide:not([data-deck-active]){display:none}' : 'an inactive-state rule bound to the actual controller'
      return [`render ${phase} active slide ${active.index + 1} is outside the viewport (top ${top}) because ${flowOccupyingPredecessors.length} inactive predecessor slide${flowOccupyingPredecessors.length === 1 ? '' : 's'} still occup${flowOccupyingPredecessors.length === 1 ? 'ies' : 'y'} normal vertical flow; preserve the reference base slide rule and add a separate inactive-state rule such as ${inactiveRule}, or place all slides on one shared viewport stage with an equally specific state rule.${computed}${ownership}`]
    }
    return [`render ${phase} active slide ${active.index + 1} does not visibly intersect the viewport stage.${computed}${ownership}`]
  }
  const intersecting = slides.filter((slide) => slide.intersectsViewport)
  if (intersecting.length !== 1 || intersecting[0].index !== active.index) {
    return [`render ${phase} has ${intersecting.length} visible slides intersecting the viewport; exactly the active slide ${active.index + 1} must intersect.${ownership}`]
  }
  return []
}
