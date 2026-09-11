const MAX_SCAN_CHARACTERS = 2_000_000
const CONTEXT_CHARACTERS = 100
const RETRY = 'This call was not executed. Resubmit one complete JSON object, encoded once, without comments, trailing prose or an extra arguments wrapper.'

/** Diagnostic only: never repair, unwrap or admit a malformed tool call.
 * Parser error text may echo credentials or other argument data, so expose
 * only a known error category, coordinates and a text-masked structure view.
 */
export function invalidToolJsonDiagnostic(raw: unknown): string {
  if (typeof raw !== 'string') return RETRY
  if (raw.length > MAX_SCAN_CHARACTERS) return `${RETRY} Raw arguments exceed the bounded diagnostic scan limit.`
  let errorText: string
  try {
    JSON.parse(raw)
    // A caller-supplied invalid marker is never overridden by this diagnostic.
    return RETRY
  } catch (error) {
    errorText = error instanceof SyntaxError ? error.message : ''
  }
  const categories: Array<[string, string]> = [
    ['Unexpected non-whitespace character after JSON', 'Unexpected content after the completed JSON value'],
    ["Expected ',' or ']'", 'Expected a comma or closing array bracket'],
    ["Expected ',' or '}'", 'Expected a comma or closing object brace'],
    ['Expected double-quoted property name', 'Expected a double-quoted property name'],
    ["Expected property name or '}'", 'Expected a double-quoted property name'],
    ["Expected ':' after property name", 'Expected a colon after the property name'],
    ['Unterminated string', 'Unterminated JSON string'],
    ['Bad escaped character', 'Invalid escape inside a JSON string'],
    ['Bad Unicode escape', 'Invalid Unicode escape inside a JSON string'],
    ['Bad control character', 'Unescaped control character inside a JSON string'],
    ['Unexpected end of JSON', 'Unexpected end of JSON'],
  ]
  const reason = categories.find(([prefix]) => errorText.startsWith(prefix))?.[1] ?? 'Invalid JSON syntax'
  const match = /\bat position (\d+)\b/u.exec(errorText)
  const offset = match ? Number(match[1]) : errorText.startsWith('Unexpected end of JSON') ? raw.length : undefined
  if (offset === undefined || !Number.isSafeInteger(offset) || offset < 0 || offset > raw.length) return `${RETRY} ${reason}.`

  const start = Math.max(0, offset - CONTEXT_CHARACTERS)
  const end = Math.min(raw.length, offset + CONTEXT_CHARACTERS)
  const pieces: string[] = []
  let inString = false
  let escaped = false
  let line = 1
  let column = 1
  for (let index = 0; index <= end; index += 1) {
    if (index === offset) pieces.push('⟦ERROR⟧')
    if (index === end) break
    const character = raw[index]
    let visible = '·'
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') { visible = '\\'; escaped = true }
      else if (character === '"') { visible = '"'; inString = false }
    } else if (character === '"') { visible = '"'; inString = true }
    else if ('{}[]:,'.includes(character)) visible = character
    if (/[\t\r\n ]/u.test(character)) visible = character
    if (index >= start) pieces.push(visible)
    if (index < offset) {
      if (character === '\r') { line += 1; column = 1 }
      else if (character === '\n') { if (raw[index - 1] !== '\r') line += 1; column = 1 }
      else column += 1
    }
  }
  return `${RETRY} ${reason} at UTF-16 offset ${offset} (line ${line}, column ${column}). Nearby JSON structure only (all text masked; starts at UTF-16 offset ${start}): ${JSON.stringify(pieces.join(''))}`
}
