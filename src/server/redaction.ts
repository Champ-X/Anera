const SENSITIVE_KEY = String.raw`[A-Za-z][A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)[A-Za-z0-9_-]*`

export function findSensitiveValues(text: string): string[] {
  const values = new Set<string>()
  const assignment = new RegExp(String.raw`\b${SENSITIVE_KEY}\b\s*(?:=|:)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;\]}]+))`, 'gi')
  for (const match of text.matchAll(assignment)) addSensitiveValue(values, match[1] ?? match[2] ?? match[3])
  for (const match of text.matchAll(/\b(?:sk|pk|api|token)[-_][A-Za-z0-9][A-Za-z0-9._-]{10,}\b/g)) addSensitiveValue(values, match[0])
  return [...values].sort((left, right) => right.length - left.length)
}

export function redactText(text: string, values: Iterable<string>): string {
  let redacted = text
  for (const value of values) {
    if (value) redacted = redacted.split(value).join('[REDACTED_SECRET]')
  }
  return redacted
}

export function redactDisplayValue<T>(value: T, sensitiveValues: Iterable<string>): T {
  const values = [...sensitiveValues]
  if (values.length === 0) return value
  return redactUnknown(value, values) as T
}

function redactUnknown(value: unknown, sensitiveValues: string[]): unknown {
  if (typeof value === 'string') return redactText(value, sensitiveValues)
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, sensitiveValues))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactUnknown(item, sensitiveValues)]))
  }
  return value
}

function addSensitiveValue(values: Set<string>, raw: string | undefined): void {
  const value = raw?.trim()
  if (!value || value.length < 8 || value.length > 4_096 || value === '[REDACTED_SECRET]') return
  values.add(value)
}
