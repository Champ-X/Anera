/** A closed response envelope shared by prompting and validation. This only
 * checks protocol shape; domain validators still own evidence and verdicts.
 * Contracts are code-owned. Never put model-provided keys/values in errors. */
export type ResponseFieldType = 'object' | 'array' | 'string'
export interface StructuredResponseContract {
  readonly name: string
  readonly fields: Readonly<Record<string, ResponseFieldType>>
}

export class StructuredResponseProtocolError extends Error {}

const valueType = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

export function structuredResponseInstruction(contract: StructuredResponseContract): string {
  return `Response envelope ${contract.name}: return exactly one JSON object matching this top-level schema. All listed fields are required siblings; no wrapper or additional fields. This schema specifies shape only, never a successful verdict. Domain content and evidence rules still apply.\n${JSON.stringify({
    type: 'object', required: Object.keys(contract.fields), additionalProperties: false,
    properties: Object.fromEntries(Object.entries(contract.fields).map(([key, type]) => [key, { type }])),
  })}`
}

export function assertStructuredResponse(contract: StructuredResponseContract, value: unknown): asserts value is Record<string, unknown> {
  const prefix = `Structured response ${contract.name}: `
  if (valueType(value) !== 'object') throw new StructuredResponseProtocolError(`${prefix}top-level object required; received ${valueType(value)}`)
  const payload = value as Record<string, unknown>
  const problems: string[] = []
  for (const [key, type] of Object.entries(contract.fields)) {
    if (!Object.hasOwn(payload, key)) problems.push(`${key} required (missing)`)
    else if (valueType(payload[key]) !== type) problems.push(`${key} must be ${type}; received ${valueType(payload[key])}`)
  }
  const unexpected = Object.keys(payload).filter((key) => !Object.hasOwn(contract.fields, key)).length
  if (unexpected) problems.push(`unexpected top-level fields: ${unexpected}; remove them, do not nest the required fields`)
  if (problems.length) throw new StructuredResponseProtocolError(prefix + problems.join('; '))
}
