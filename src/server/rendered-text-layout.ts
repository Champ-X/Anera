/** Bounded text-ink bounding-box intersections, never article text or pixels. */
export interface RenderedTextCollision {
  left: string
  right: string
  widthRatio: number
  heightRatio: number
}

export interface RenderedTextLayout {
  // v1 measured font/em boxes, not ink. Retain it only for history/migration.
  version: 1 | 2
  complete: boolean
  collisions: RenderedTextCollision[]
  observationGaps?: Array<'observation_limit' | 'identity_ambiguous' | 'ink_geometry_unavailable'>
}

// Literal page program: tsx's keepNames transform must not inject Node helpers
// into browser callbacks. Called inside the same atomic phase snapshot as the
// geometry probes, before the corresponding screenshot.
export const RENDERED_TEXT_LAYOUT_SCRIPT = String.raw`(activeSlide) => {
  let complete = true;
  const gaps = new Set();
  const incomplete = (reason = 'observation_limit') => { complete = false; gaps.add(reason); };
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  let measuredCharacters = 0;
  // Range rectangles include ascender/descender space with no painted glyph.
  // Keep their horizontal extent conservatively, but refine vertical bounds
  // using actual text metrics. Never equate an em-box overlap with ink overlap.
  // Unsupported geometry remains unproven only if a coarse collision needs it.
  const inkMetrics = (text, style, supportedGeometry) => {
    if (!context || !supportedGeometry || style.writingMode !== 'horizontal-tb'
      || style.textDecorationLine !== 'none' || !style.font
      || text.length > 8192 || measuredCharacters + text.length > 60000) return null;
    measuredCharacters += text.length;
    context.font = style.font;
    context.textBaseline = 'alphabetic';
    for (const key of ['fontKerning', 'fontStretch', 'fontVariantCaps', 'letterSpacing', 'wordSpacing']) {
      if (key in context) context[key] = style[key];
    }
    const transformed = style.textTransform === 'uppercase' ? text.toUpperCase()
      : style.textTransform === 'lowercase' ? text.toLowerCase() : text;
    const values = [context.measureText(transformed)];
    // Capitalization depends on CSS word boundaries; a conservative union
    // avoids claiming missing ascenders when that shaping cannot be reproduced.
    if (!['none', 'uppercase', 'lowercase'].includes(style.textTransform)) {
      values.push(context.measureText(text.toUpperCase()), context.measureText(text.toLowerCase()));
    }
    const ascent = Math.max(...values.map(value => value.actualBoundingBoxAscent));
    const descent = Math.max(...values.map(value => value.actualBoundingBoxDescent));
    const fontAscent = Math.max(...values.map(value => value.fontBoundingBoxAscent));
    const fontDescent = Math.max(...values.map(value => value.fontBoundingBoxDescent));
    const stroke = Number.parseFloat(style.webkitTextStrokeWidth) || 0;
    if (![ascent, descent, fontAscent, fontDescent, stroke].every(Number.isFinite)
      || fontAscent + fontDescent <= 0 || stroke < 0) return null;
    return { ascent: ascent + stroke / 2, descent: descent + stroke / 2, fontAscent, fontDescent };
  };
  const styles = new WeakMap();
  const styleOf = (element) => {
    if (!styles.has(element)) styles.set(element, getComputedStyle(element));
    return styles.get(element);
  };
  const inline = (element) => ['inline', 'contents'].includes(styleOf(element).display);
  const identities = new WeakMap();
  const identity = (element) => {
    if (!identities.has(element)) {
      if (element.classList.length > 64) { incomplete(); identities.set(element, null); }
      else identities.set(element, element.localName + [...element.classList]
        .filter((name) => /^[a-zA-Z_][\w-]*$/.test(name) && !['active', 'prev'].includes(name))
        .slice(0, 3).map((name) => '.' + name.slice(0, 40)).join(''));
    }
    return identities.get(element);
  };
  // Enumerate one sibling group once, not once per owner/path component.
  // Empty elements and pathological class lists are bounded too.
  const siblingKeys = new WeakMap();
  const indexedParents = new WeakSet();
  const siblingKey = (element) => {
    const parent = element.parentElement;
    if (!parent) return identity(element);
    if (!indexedParents.has(parent)) {
      indexedParents.add(parent);
      if (parent.children.length > 1024) { incomplete(); return null; }
      const counts = new Map(), indices = new Map();
      for (const child of parent.children) {
        const id = identity(child);
        counts.set(id, (counts.get(id) || 0) + 1);
      }
      for (const child of parent.children) {
        const id = identity(child), index = indices.get(id) || 0;
        siblingKeys.set(child, id && (id + (counts.get(id) > 1 ? '[' + index + ']' : '')));
        indices.set(id, index + 1);
      }
    }
    return siblingKeys.get(element) || null;
  };
  const keyOf = (owner) => {
    const parts = [];
    let current = owner;
    for (let depth = 0; current && current !== activeSlide && current !== document.body; depth++) {
      if (depth >= 24) return null;
      if (!inline(current)) {
        const key = siblingKey(current);
        if (!key) return null;
        parts.unshift(key);
      }
      current = current.parentElement;
    }
    const key = (current === activeSlide ? 'slide>' : 'page>') + parts.join('>');
    return key.length <= 240 ? key : null;
  };
  const transparent = (color) => color === 'transparent' || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color);
  // Range exposes an axis-aligned bounding rectangle even for rotated text.
  // Recover its local rectangle under a known 2D affine map, then transform
  // the font-ink bounds, NOT the screen AABB, back into viewport coordinates.
  // Singular AABB inversions (e.g. 45 degrees), 3D and unsupported CSS remain
  // explicit observation gaps. No DOM/style mutation or task/template rule.
  const box = (left, top, right, bottom) => [[left, top], [right, top], [right, bottom], [left, bottom]];
  const cross = (a, b, p) => (b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0]);
  const intersect = (polygon, boundary) => {
    for (let i = 0; i < boundary.length && polygon.length; i++) {
      const a = boundary[i], b = boundary[(i+1)%boundary.length], output = [];
      for (let j = 0; j < polygon.length; j++) {
        const p = polygon[j], q = polygon[(j+1)%polygon.length];
        const dp = cross(a,b,p), dq = cross(a,b,q);
        if (dp >= 0) output.push(p);
        if ((dp >= 0) !== (dq >= 0)) {
          const t = dp/(dp-dq);
          output.push([p[0]+t*(q[0]-p[0]), p[1]+t*(q[1]-p[1])]);
        }
      }
      polygon = output;
    }
    return polygon;
  };
  const bounds = (polygon) => ({ left: Math.min(...polygon.map(p=>p[0])), right: Math.max(...polygon.map(p=>p[0])),
    top: Math.min(...polygon.map(p=>p[1])), bottom: Math.max(...polygon.map(p=>p[1])) });
  const affineInk = (rect, matrix, metrics) => {
    const {a,b,c,d} = matrix, det = Math.abs(a)*Math.abs(d)-Math.abs(b)*Math.abs(c);
    if (Math.abs(det) < 0.00001) return null;
    const width = (rect.width*Math.abs(d)-rect.height*Math.abs(c))/det;
    const height = (rect.height*Math.abs(a)-rect.width*Math.abs(b))/det;
    if (![width,height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    const scale = height/(metrics.fontAscent+metrics.fontDescent);
    const top = (metrics.fontAscent-metrics.ascent)*scale-height/2;
    const bottom = (metrics.fontAscent+metrics.descent)*scale-height/2;
    const cx = (rect.left+rect.right)/2, cy = (rect.top+rect.bottom)/2;
    return box(-width/2, top, width/2, bottom).map(([x,y]) => [cx+a*x+c*y, cy+b*x+d*y]);
  };
  const fragments = [];
  const ownerKeys = new WeakMap();
  let visited = 0, scanned = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (++scanned > 12000) { incomplete(); break; }
    if (node.nodeType !== Node.TEXT_NODE) continue;
    if (++visited > 4000) { incomplete(); break; }
    if (!node.nodeValue?.trim()) continue;
    const parent = node.parentElement;
    if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) continue;
    let visible = true, axisAligned = true, supportedGeometry = true;
    let transform = new DOMMatrixReadOnly();
    const clip = { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
    let depth = 0;
    for (let current = parent; current; current = current.parentElement) {
      if (++depth > 64) { incomplete(); visible = false; break; }
      const style = styleOf(current);
      if (style.writingMode !== 'horizontal-tb' || style.perspective !== 'none'
        || (style.rotate && style.rotate !== 'none') || (style.scale && style.scale !== 'none')) {
        axisAligned = false; supportedGeometry = false;
      }
      if (style.transform !== 'none') {
        try {
          const matrix = new DOMMatrixReadOnly(style.transform);
          if (!matrix.is2D || matrix.a*matrix.d-matrix.b*matrix.c <= 0.00001) supportedGeometry = false;
          if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) axisAligned = false;
          transform = matrix.multiply(transform);
        } catch { axisAligned = false; supportedGeometry = false; }
      }
      if (current.hasAttribute('hidden') || style.display === 'none'
        || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) <= 0.01) {
        visible = false; break;
      }
      const rect = current.getBoundingClientRect();
      if (['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX)) {
        clip.left = Math.max(clip.left, rect.left); clip.right = Math.min(clip.right, rect.right);
      }
      if (['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowY)) {
        clip.top = Math.max(clip.top, rect.top); clip.bottom = Math.min(clip.bottom, rect.bottom);
      }
    }
    const textStyle = styleOf(parent);
    if (!visible || (transparent(textStyle.webkitTextFillColor || textStyle.color) && textStyle.textShadow === 'none')) continue;
    let owner = parent, ownerDepth = 0;
    while (owner.parentElement && inline(owner)) {
      if (++ownerDepth > 24) { incomplete(); break; }
      owner = owner.parentElement;
    }
    if (ownerDepth > 24) continue;
    if (!ownerKeys.has(owner)) ownerKeys.set(owner, keyOf(owner));
    const key = ownerKeys.get(owner);
    if (!key) { incomplete('identity_ambiguous'); continue; }
    const range = document.createRange();
    range.setStart(node, node.nodeValue.search(/\S/));
    range.setEnd(node, node.nodeValue.trimEnd().length);
    const metrics = inkMetrics(node.nodeValue.trim(), textStyle, supportedGeometry);
    for (const rect of range.getClientRects()) {
      const left = Math.max(rect.left, clip.left), right = Math.min(rect.right, clip.right);
      const top = Math.max(rect.top, clip.top), bottom = Math.min(rect.bottom, clip.bottom);
      if (right - left < 2 || bottom - top < 2) continue;
      if (fragments.length >= 1600) { incomplete(); break; }
      const scale = metrics ? rect.height / (metrics.fontAscent + metrics.fontDescent) : 1;
      const baseline = metrics ? rect.top + metrics.fontAscent * scale : 0;
      let polygon = !metrics ? null : axisAligned
        ? box(rect.left, baseline-metrics.ascent*scale, rect.right, baseline+metrics.descent*scale)
        : affineInk(rect, transform, metrics);
      if (polygon) polygon = intersect(polygon, box(clip.left,clip.top,clip.right,clip.bottom));
      if (polygon && !polygon.length) continue;
      const ink = polygon ? bounds(polygon) : { left, right, top, bottom };
      fragments.push({ key, owner, polygon, transformed: !axisAligned, ink,
        left: Math.min(left,ink.left), right: Math.max(right,ink.right),
        top: Math.min(top,ink.top), bottom: Math.max(bottom,ink.bottom) });
    }
    if (!complete && fragments.length >= 1600) break;
  }
  const pairs = new Map();
  fragments.sort((a, b) => a.left - b.left);
  for (let i = 0; i < fragments.length; i++) {
    const a = fragments[i];
    for (let j = i + 1; j < fragments.length && fragments[j].left < a.right; j++) {
      const b = fragments[j];
      // Inline links, CJK spans and different lines in one formatting block
      // must not be compared to their own enclosing text.
      if (a.owner === b.owner) continue;
      const coarseWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const coarseHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (coarseWidth < 3 || coarseHeight < 3) continue;
      if (!a.polygon || !b.polygon) { incomplete('ink_geometry_unavailable'); continue; }
      const overlap = intersect(a.polygon,b.polygon);
      if (!overlap.length) continue;
      const overlapBox = bounds(overlap);
      const width = overlapBox.right-overlapBox.left, height = overlapBox.bottom-overlapBox.top;
      const minWidth = Math.min(a.ink.right-a.ink.left,b.ink.right-b.ink.left);
      const minHeight = Math.min(a.ink.bottom-a.ink.top,b.ink.bottom-b.ink.top);
      // Ignore subpixel/baseline fringe, not a small but legible word crossing
      // a much wider headline. Element boxes alone are not text evidence.
      if (width < 3 || height < (a.transformed || b.transformed ? 3 : Math.max(3, minHeight * 0.15))) continue;
      const keys = [a.key, b.key].sort();
      if (keys[0] === keys[1]) { incomplete('identity_ambiguous'); continue; }
      const pairKey = JSON.stringify(keys);
      const previous = pairs.get(pairKey);
      if (!previous && pairs.size >= 128) { incomplete(); continue; }
      const rounded = (value) => Math.round(value * 10000) / 10000;
      pairs.set(pairKey, { left: keys[0], right: keys[1],
        widthRatio: Math.max(previous?.widthRatio || 0, rounded(width / minWidth)),
        heightRatio: Math.max(previous?.heightRatio || 0, rounded(height / minHeight)),
      });
    }
  }
  return { version: 2, complete, ...(gaps.size ? { observationGaps: [...gaps].sort() } : {}), collisions: [...pairs.values()].sort((a, b) =>
    a.left.localeCompare(b.left) || a.right.localeCompare(b.right)) };
}`

export function normalizeRenderedTextLayout(value: unknown): RenderedTextLayout {
  const fail = (): never => { throw new Error('Rendered text layout evidence is invalid or exceeds its bounded limits') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const raw = value as Record<string, unknown>
  if (![1, 2].includes(Number(raw.version)) || typeof raw.version !== 'number' || typeof raw.complete !== 'boolean'
    || !Array.isArray(raw.collisions) || raw.collisions.length > 128) return fail()
  const pairs = new Set<string>()
  const collisions = raw.collisions.map((entry: unknown): RenderedTextCollision => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail()
    const pair = entry as Record<string, unknown>
    if (typeof pair.left !== 'string' || typeof pair.right !== 'string'
      || !pair.left || !pair.right || pair.left.length > 240 || pair.right.length > 240
      || pair.left >= pair.right || /[^a-zA-Z0-9_.>\[\]-]/u.test(pair.left + pair.right)) return fail()
    for (const field of ['widthRatio', 'heightRatio']) {
      if (typeof pair[field] !== 'number' || !Number.isFinite(pair[field]) || pair[field] <= 0 || pair[field] > 1) return fail()
    }
    const key = JSON.stringify([pair.left, pair.right])
    if (pairs.has(key)) return fail()
    pairs.add(key)
    return { left: pair.left, right: pair.right, widthRatio: pair.widthRatio as number, heightRatio: pair.heightRatio as number }
  })
  if (raw.observationGaps !== undefined && (!Array.isArray(raw.observationGaps) || raw.observationGaps.length > 3
    || raw.observationGaps.some((gap) => !['observation_limit', 'identity_ambiguous', 'ink_geometry_unavailable'].includes(gap))
    || new Set(raw.observationGaps).size !== raw.observationGaps.length || raw.complete && raw.observationGaps.length)) return fail()
  return { version: raw.version as 1 | 2, complete: raw.complete, collisions,
    ...(raw.observationGaps !== undefined ? { observationGaps: [...raw.observationGaps] as NonNullable<RenderedTextLayout['observationGaps']> } : {}) }
}

export function renderedTextLayoutViolations(
  expected: RenderedTextLayout | undefined,
  actual: RenderedTextLayout | undefined,
): string[] {
  const findings = renderedTextLayoutFindings(expected, actual)
  return [...findings.defects, ...findings.observationGaps]
}

export function renderedTextLayoutFindings(
  expected: RenderedTextLayout | undefined,
  actual: RenderedTextLayout | undefined,
): { defects: string[]; observationGaps: string[] } {
  const observationGaps: string[] = []
  if (!actual?.complete || expected?.complete === false) observationGaps.push('text layout could not be completely measured within the bounded observation limits')
  if (!actual) return { defects: [], observationGaps }
  if (actual.version !== 2 || expected && expected.version !== 2) return { defects: [], observationGaps: [
    ...observationGaps, 'text layout requires current ink-bound measurements; recapture the reference and candidate',
  ] }
  const known = new Map(expected?.collisions.map((pair) => [JSON.stringify([pair.left, pair.right]), pair]))
  const defects = actual.collisions.flatMap((pair) => {
    const source = known.get(JSON.stringify([pair.left, pair.right]))
    if (source && pair.widthRatio <= source.widthRatio + 0.03 && pair.heightRatio <= source.heightRatio + 0.03) return []
    // A partial or missing baseline cannot prove that an observed pair is new.
    // It can still prove enlargement of a pair actually measured in both.
    if (!source && !expected?.complete) {
      observationGaps.push(`text collision between ${pair.left} and ${pair.right} has no measured source baseline; recapture the reference before accepting an intentional overlap`)
      return []
    }
    const comparison = source ? 'is larger than the source overlap'
      : 'was absent from the source'
    return [`text collision between ${pair.left} and ${pair.right} ${comparison}. Fit the copy within its source-defined text areas and preserve meaningful qualifiers; do not hide text or move fixed chrome to suppress the collision.`]
  }).slice(0, 32)
  return { defects, observationGaps: observationGaps.slice(0, 32) }
}
