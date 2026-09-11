/** Read-only interaction-surface evidence. This detects external controls
 * hit-tested above visible text regions, not all visual occlusion or ink.
 * A caller supplies the currently owned content root; there are no selectors
 * for a particular template, topic, controller name or navigation language.
 */
export interface RenderedControlOcclusion {
  sampledRegions: number
  complete: boolean
  collisions: Array<{ text: string; control: string; point: [number, number] }>
}

export const RENDERED_CONTROL_OCCLUSION_SCRIPT = String.raw`(root) => {
  const result = { sampledRegions: 0, complete: true, collisions: [] }
  if (!root) return { ...result, complete: false }
  const parent = element => element.assignedSlot || element.parentElement || element.getRootNode().host || null
  const contains = (ancestor, element) => {
    for (let current = element; current; current = parent(current)) if (current === ancestor) return true
    return false
  }
  const visible = element => {
    for (let current = element; current; current = parent(current)) {
      const style = getComputedStyle(current)
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
        || Number(style.opacity) <= 0.01 || current.hasAttribute('hidden')) return false
    }
    return true
  }
  const topElement = (x, y) => {
    let element = document.elementFromPoint(x, y)
    for (let depth = 0; element?.shadowRoot && depth < 16; depth += 1) {
      const inner = element.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === element) break
      element = inner
    }
    return element
  }
  const control = element => {
    for (let current = element; current; current = parent(current)) {
      if (contains(root, current) || contains(current, root)) return null
      if (current.matches('button,input,select,textarea,a[href],[role="button"],[role="link"]')) return current
    }
    return null
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let nodes = 0
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (!node.textContent.trim() || !node.parentElement || /^(SCRIPT|STYLE|TEMPLATE)$/u.test(node.parentElement.tagName)
      || !visible(node.parentElement)) continue
    if (++nodes > 512) { result.complete = false; break }
    const range = document.createRange()
    range.selectNodeContents(node)
    for (const rect of range.getClientRects()) {
      const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right)
      const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom)
      if (right - left <= 1 || bottom - top <= 1) continue
      if (++result.sampledRegions > 1024) { result.complete = false; return result }
      for (const fraction of [0.15, 0.5, 0.85]) {
        const x = left + (right - left) * fraction, y = (top + bottom) / 2
        const blocker = control(topElement(x, y))
        if (!blocker || !visible(blocker)) continue
        result.collisions.push({ text: node.textContent.trim().slice(0, 100),
          control: blocker.tagName.toLowerCase() + (blocker.getAttribute('aria-label') ? ' ' + blocker.getAttribute('aria-label').slice(0, 80) : ''),
          point: [Math.round(x * 10) / 10, Math.round(y * 10) / 10] })
        if (result.collisions.length >= 16) { result.complete = false; return result }
        break
      }
    }
  }
  return result
}`
