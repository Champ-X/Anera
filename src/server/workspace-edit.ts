export type ArenaEditMatchType = 'exact' | 'fuzzy'

export interface ArenaEditResult {
  content: string
  matchType: ArenaEditMatchType
  matchedText: string
}

type MatchStrategy = {
  matchType: ArenaEditMatchType
  find: (content: string, context: string) => number[]
  matchLength: (content: string, context: string, index: number) => number
}

export function applyArenaEdit(content: string, context: string, replacement: string): ArenaEditResult {
  if (!context) throw new Error('Context cannot be empty.')
  const strategies: MatchStrategy[] = [
    { matchType: 'exact', find: exactMatches, matchLength: (_content, value) => value.length },
    { matchType: 'fuzzy', find: lineTrimmedMatches, matchLength: lineMappedLength },
    { matchType: 'fuzzy', find: whitespaceNormalizedMatches, matchLength: lineMappedLength },
    { matchType: 'fuzzy', find: indentationFlexibleMatches, matchLength: lineMappedLength },
  ]
  for (const strategy of strategies) {
    const matches = strategy.find(content, context)
    if (matches.length === 0) continue
    if (matches.length > 1) continue
    const index = matches[0]
    const length = strategy.matchLength(content, context, index)
    const matchedText = content.slice(index, index + length)
    return {
      content: `${content.slice(0, index)}${replacement}${content.slice(index + length)}`,
      matchType: strategy.matchType,
      matchedText,
    }
  }
  const nearby = closestCurrentExcerpt(content, context)
  if (nearby) {
    throw new Error(`Context not found. Closest current excerpt (not applied):\n${nearby}\nUse this exact current text for a targeted retry, or continue if the requested state is already correct.`)
  }
  throw new Error('Context not found. Read the file to verify the text exists.')
}

function closestCurrentExcerpt(content: string, context: string): string | undefined {
  const contentLines = content.split('\n')
  const contextLines = context.split('\n')
  if (contextLines.length < 2 || contextLines.length > contentLines.length) return undefined
  const normalize = (line: string) => line.replace(/\s+/g, ' ').trim()
  const wanted = contextLines.map(normalize)
  let bestStart = -1
  let bestScore = 0
  let bestTied = false
  for (let start = 0; start <= contentLines.length - contextLines.length; start += 1) {
    let score = 0
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (normalize(contentLines[start + offset]) === wanted[offset]) score += 1
    }
    if (score > bestScore) {
      bestStart = start
      bestScore = score
      bestTied = false
    } else if (score === bestScore && score > 0) {
      bestTied = true
    }
  }
  const minimumScore = Math.max(2, Math.ceil(contextLines.length * 0.5))
  if (bestStart >= 0 && bestScore >= minimumScore && !bestTied) {
    return boundedExcerpt(contentLines, Math.max(0, bestStart - 1), contextLines.length + 2)
  }

  // A stale structural edit can differ on most lines while retaining one
  // strong, unique declaration or heading. Returning a bounded current window
  // around that anchor is diagnostic only: applyArenaEdit still fails closed,
  // but the next model step can retry with exact bytes instead of rereading an
  // entire file. Weak, punctuation-only, or repeated anchors are ignored.
  const wantedCounts = new Map<string, number>()
  for (const line of wanted) wantedCounts.set(line, (wantedCounts.get(line) ?? 0) + 1)
  const currentPositions = new Map<string, number[]>()
  for (let index = 0; index < contentLines.length; index += 1) {
    const line = normalize(contentLines[index])
    const positions = currentPositions.get(line) ?? []
    positions.push(index)
    currentPositions.set(line, positions)
  }
  const anchors = wanted.flatMap((line, contextIndex) => {
    const positions = currentPositions.get(line) ?? []
    if (
      line.length < 12
      || !/[A-Za-z0-9_$]/.test(line)
      || (line.match(/[A-Za-z_$][A-Za-z0-9_$-]*/g)?.length ?? 0) < 2
      || wantedCounts.get(line) !== 1
      || positions.length !== 1
    ) return []
    return [{ line, contextIndex, contentIndex: positions[0] }]
  }).sort((left, right) => right.line.length - left.line.length)
  const anchor = anchors[0]
  if (!anchor) return undefined
  const alignedStart = anchor.contentIndex - Math.min(anchor.contextIndex, 10) - 1
  return boundedExcerpt(contentLines, Math.max(0, alignedStart), Math.min(40, contextLines.length + 2))
}

function boundedExcerpt(lines: string[], start: number, lineCount: number): string {
  const candidates = lines.slice(start, Math.min(lines.length, start + lineCount))
  const selected: string[] = []
  let chars = 0
  for (const line of candidates) {
    const nextChars = line.length + (selected.length > 0 ? 1 : 0)
    if (selected.length > 0 && chars + nextChars > 2_000) break
    if (selected.length === 0 && nextChars > 2_000) {
      return `${line.slice(0, 2_000)}\n[Closest excerpt truncated inside an oversized line; use read_file for exact current bytes.]`
    }
    selected.push(line)
    chars += nextChars
  }
  if (selected.length < candidates.length) {
    selected.push('[Closest excerpt truncated at a whole-line boundary; use read_file for additional exact current bytes.]')
  }
  return selected.join('\n')
}

function exactMatches(content: string, context: string): number[] {
  const matches: number[] = []
  let offset = 0
  while (true) {
    const index = content.indexOf(context, offset)
    if (index === -1) break
    matches.push(index)
    offset = index + 1
  }
  return matches
}

function lineTrimmedMatches(content: string, context: string): number[] {
  return lineWindowMatches(content, context, (line) => line.trimEnd())
}

function whitespaceNormalizedMatches(content: string, context: string): number[] {
  return lineWindowMatches(content, context, (line) => line.replace(/\s+/g, ' ').trim())
}

function lineWindowMatches(content: string, context: string, normalize: (line: string) => string): number[] {
  const wanted = context.split('\n').map(normalize)
  const lines = content.split('\n')
  const normalized = lines.map(normalize)
  const matches: number[] = []
  for (let start = 0; start <= lines.length - wanted.length; start += 1) {
    if (wanted.every((line, offset) => normalized[start + offset] === line)) {
      matches.push(lineStartOffset(lines, start))
    }
  }
  return matches
}

function indentationFlexibleMatches(content: string, context: string): number[] {
  const wantedLines = context.split('\n')
  const contentLines = content.split('\n')
  const wantedIndent = minimumIndent(wantedLines)
  const wanted = wantedLines.map((line) => line.trim() === '' ? '' : line.slice(wantedIndent))
  const matches: number[] = []
  for (let start = 0; start <= contentLines.length - wanted.length; start += 1) {
    const candidateLines = contentLines.slice(start, start + wanted.length)
    const candidateIndent = minimumIndent(candidateLines)
    const candidate = candidateLines.map((line) => line.trim() === '' ? '' : line.slice(candidateIndent))
    if (wanted.every((line, offset) => candidate[offset] === line)) matches.push(lineStartOffset(contentLines, start))
  }
  return matches
}

function minimumIndent(lines: string[]): number {
  let minimum = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (line.trim() === '') continue
    minimum = Math.min(minimum, line.length - line.trimStart().length)
  }
  return minimum === Number.POSITIVE_INFINITY ? 0 : minimum
}

function lineMappedLength(_modeContent: string, context: string, index: number): number {
  const content = _modeContent.slice(index).split('\n')
  const contextLines = context.split('\n')
  let length = 0
  for (let line = 0; line < contextLines.length; line += 1) {
    if (line > 0) length += 1
    length += content[line]?.length ?? 0
  }
  return length
}

function lineStartOffset(lines: string[], line: number): number {
  let offset = 0
  for (let index = 0; index < line; index += 1) offset += lines[index].length + 1
  return offset
}
