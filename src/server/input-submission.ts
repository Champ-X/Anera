import { createHash } from 'node:crypto'

export interface InputReceipt {
  fingerprint: string
  turnId: string
}

export function inputId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw Object.assign(new Error('clientMessageId must be a 1–128 character input identifier'), { statusCode: 400 })
  }
  return value
}

export function inputFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function assertInputFingerprint(actual: string, expected: string): void {
  if (actual !== expected) {
    throw Object.assign(new Error('Input identifier was already used for a different request'), {
      statusCode: 409,
      code: 'input_id_conflict',
    })
  }
}

export function assertInputReceipt(receipt: InputReceipt): void {
  if (!receipt || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)
    || typeof receipt.turnId !== 'string' || !/^turn_[a-z0-9]{20}$/.test(receipt.turnId)) {
    throw new Error('Stored input receipt is invalid')
  }
}

export function assertInputReceipts(value: unknown): asserts value is Record<string, InputReceipt> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Stored input receipts are invalid')
  for (const [id, receipt] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('Stored input identity is invalid')
    assertInputReceipt(receipt as InputReceipt)
  }
}

export function assertCreationInput(value: unknown): asserts value is { id: string; fingerprint: string } {
  const marker = value as { id?: unknown; fingerprint?: unknown } | null
  if (!marker || typeof marker.id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(marker.id)
    || typeof marker.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(marker.fingerprint)) {
    throw new Error('Stored initial input identity is invalid')
  }
}

/** Coalesce only the admission operation, never the lifetime of the model run. */
export class InputAdmissions<T> {
  private readonly pending = new Map<string, { fingerprint: string; promise: Promise<T> }>()

  run(key: string, fingerprint: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.pending.get(key)
    if (prior) {
      assertInputFingerprint(prior.fingerprint, fingerprint)
      return prior.promise
    }
    // Install the owner before invoking code that may await or reenter.
    const promise = Promise.resolve().then(operation)
    const entry = { fingerprint, promise }
    this.pending.set(key, entry)
    const release = () => { if (this.pending.get(key) === entry) this.pending.delete(key) }
    void promise.then(release, release)
    return promise
  }
}

export function submissionFingerprint(options: {
  content: string
  attachments?: string[]
  model?: string | null
  timezone?: string | null
  enabledConnectorSlugs?: string[]
  reviewedNodeId?: string
}): string {
  // Hash submitted intent, not mutable defaults (current model, timezone or
  // connected accounts), so a later retry cannot silently become a new task.
  return inputFingerprint({
    content: options.content,
    attachments: options.attachments?.filter(Boolean) ?? [],
    model: options.model ?? null,
    timezone: options.timezone ?? null,
    enabledConnectorSlugs: options.enabledConnectorSlugs === undefined
      ? null : [...new Set(options.enabledConnectorSlugs)].sort(),
    reviewedNodeId: options.reviewedNodeId ?? null,
  })
}
