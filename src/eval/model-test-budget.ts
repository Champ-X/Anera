import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// Test-only, write-ahead accounting. Never import this into production routing.
// CNY peak/cache-miss rates verified 2026-09-09:
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 1 Mi tokens is deliberately above the advertised 1M context ceiling.
export const TEST_MODEL_TARIFFS = {
  'deepseek-v4-flash': { input: 3, output: 9 },
  'deepseek-v4-pro': { input: 9, output: 27 },
  'deepseek-v4-flash-vision-exp': { input: 3, output: 9 },
} as const
// Rechecked official pricing at this instant; peak/cache-miss rates unchanged.
// Use a 24-hour freshness window, not an imminent local-midnight cutoff.
export const TEST_MODEL_TARIFF_VERIFIED_AT = '2026-09-09T15:45:04.945Z'
export const TEST_MODEL_TARIFF_VALID_UNTIL = Date.parse(TEST_MODEL_TARIFF_VERIFIED_AT) + 24 * 60 * 60 * 1_000
const CONTEXT_CEILING = 1_048_576
const MAX_OUTPUT = 393_216
const CAP_MICRO_CNY = 20_000_000
const POLICY = 'deepseek-cny-peak-2026-09-09-v1'
// Explicit, single-use user authorizations; neither an environment override
// nor a caller-selected amount. The original policy header remains ¥20.
export const USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909 = 'user-2026-09-09-additional-cny20-cap40-v1' as const
export const USER_AUTHORIZED_ADDITIONAL_30_CNY_20260909 = 'user-2026-09-09-additional-cny30-cap70-v1' as const
export const USER_AUTHORIZED_LIMIT_REMOVAL_20260909 = 'user-2026-09-09-remove-test-budget-limit-v1' as const
const AUTHORIZED_GRANTS = [
  { authorizationId: USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909, previousCap: 20_000_000, additional: 20_000_000, cap: 40_000_000 },
  { authorizationId: USER_AUTHORIZED_ADDITIONAL_30_CNY_20260909, previousCap: 40_000_000, additional: 30_000_000, cap: 70_000_000 },
] as const
type AuthorizationId = typeof AUTHORIZED_GRANTS[number]['authorizationId']
type Tariff = { input: number; output: number }
type Entry = { id: string; model: string; maximum: number; charged: number; settled: boolean }
type Authorization = { cap: number | null; authorizationIds: string[] }
type UsageBoundEvidence = { requestId: string; input: number; output: number; total: number; maxInput: number; maxOutput: number }
type RecordLine =
  | { type: 'policy'; policy: string; cap: number }
  | { type: 'reserve'; id: string; model: string; maximum: number }
  | { type: 'settle'; id: string; charged: number; usageBound?: UsageBoundEvidence }
  | { type: 'halt'; reason: string; usageBound?: UsageBoundEvidence }
  | { type: 'grant'; authorizationId: string; previousCap: number; additional: number; cap: number }
  | { type: 'limit_removed'; authorizationId: string; previousCap: number; previousHalt: string }

export class ModelTestBudgetError extends Error {
  constructor(message: string) { super(`Model test budget stopped: ${message}`); this.name = 'ModelTestBudgetError' }
}

function applyRecord(entries: Map<string, Entry>, stopped: string, record: RecordLine, authorization: Authorization): string {
  if (!record || typeof record !== 'object') throw new ModelTestBudgetError('unexpected ledger record')
  // Only this explicit user authorization can cross the historical halt. It
  // changes future admission, never the old reservations or their settlement.
  if (record.type === 'limit_removed') {
    if (Object.keys(record).sort().join(',') !== 'authorizationId,previousCap,previousHalt,type'
      || record.authorizationId !== USER_AUTHORIZED_LIMIT_REMOVAL_20260909
      || authorization.authorizationIds.includes(record.authorizationId)
      || authorization.cap !== 70_000_000 || record.previousCap !== authorization.cap
      || record.previousHalt !== stopped
      || stopped !== '' && stopped !== 'provider usage exceeded verified request bound; reconciliation required') {
      throw new ModelTestBudgetError('invalid limit-removal authorization')
    }
    authorization.cap = null
    authorization.authorizationIds.push(record.authorizationId)
    return ''
  }
  if (stopped) throw new ModelTestBudgetError('records follow a terminal ledger halt')
  if (record.type === 'halt') {
    if (typeof record.reason !== 'string' || !record.reason) throw new ModelTestBudgetError('invalid ledger halt')
    if (record.usageBound !== undefined) {
      const evidence = record.usageBound
      const entry = evidence && entries.get(evidence.requestId)
      const tariff = entry && Object.hasOwn(TEST_MODEL_TARIFFS, entry.model)
        ? TEST_MODEL_TARIFFS[entry.model as keyof typeof TEST_MODEL_TARIFFS] : undefined
      if (!evidence || Object.keys(evidence).sort().join(',') !== 'input,maxInput,maxOutput,output,requestId,total'
        || !entry || entry.settled || !tariff
        || ![evidence.input, evidence.output, evidence.total, evidence.maxOutput].every((value) => Number.isSafeInteger(value) && value >= 0)
        || evidence.input + evidence.output !== evidence.total || evidence.maxInput !== CONTEXT_CEILING
        || evidence.maxOutput <= 0 || evidence.maxOutput > MAX_OUTPUT
        || entry.maximum !== evidence.maxInput * tariff.input + evidence.maxOutput * tariff.output
        || evidence.input <= evidence.maxInput && evidence.output <= evidence.maxOutput) {
        throw new ModelTestBudgetError('invalid usage-bound halt evidence')
      }
    }
    return record.reason
  }
  if (record.type === 'grant') {
    const approved = AUTHORIZED_GRANTS.find((grant) => grant.authorizationId === record.authorizationId)
    if (Object.keys(record).sort().join(',') !== 'additional,authorizationId,cap,previousCap,type'
      || !approved || record.previousCap !== approved.previousCap || record.additional !== approved.additional
      || record.cap !== approved.cap || authorization.cap !== approved.previousCap
      || authorization.authorizationIds.includes(record.authorizationId)) {
      throw new ModelTestBudgetError('invalid or duplicate additional authorization grant')
    }
    authorization.cap = record.cap
    authorization.authorizationIds.push(record.authorizationId)
    return stopped
  }
  if (record.type === 'reserve') {
    if (typeof record.id !== 'string' || !record.id || typeof record.model !== 'string' || !record.model
      || entries.has(record.id) || !Number.isSafeInteger(record.maximum) || record.maximum <= 0) {
      throw new ModelTestBudgetError('invalid reservation ledger')
    }
    entries.set(record.id, { ...record, charged: record.maximum, settled: false })
  } else if (record.type === 'settle') {
    const entry = entries.get(record.id)
    if (!entry || entry.settled || !Number.isSafeInteger(record.charged) || record.charged < 0
      || record.charged > entry.maximum && (authorization.cap !== null || record.usageBound === undefined)) {
      throw new ModelTestBudgetError('invalid settlement ledger')
    }
    if (record.usageBound !== undefined) {
      const evidence = record.usageBound
      const tariff = TEST_MODEL_TARIFFS[entry.model as keyof typeof TEST_MODEL_TARIFFS]
      if (!evidence || authorization.cap !== null || evidence.requestId !== entry.id || !tariff
        || Object.keys(evidence).sort().join(',') !== 'input,maxInput,maxOutput,output,requestId,total'
        || ![evidence.input, evidence.output, evidence.total, evidence.maxOutput].every((value) => Number.isSafeInteger(value) && value >= 0)
        || evidence.input + evidence.output !== evidence.total || evidence.maxInput !== CONTEXT_CEILING
        || evidence.maxOutput <= 0 || evidence.maxOutput > MAX_OUTPUT
        || entry.maximum !== evidence.maxInput * tariff.input + evidence.maxOutput * tariff.output
        || evidence.input <= evidence.maxInput && evidence.output <= evidence.maxOutput
        || record.charged !== evidence.input * tariff.input + evidence.output * tariff.output) {
        throw new ModelTestBudgetError('invalid usage-bound settlement evidence')
      }
    }
    entry.charged = record.charged
    entry.settled = true
  } else throw new ModelTestBudgetError('unexpected ledger record')
  if (authorization.cap !== null && [...entries.values()].reduce((sum, entry) => sum + entry.charged, 0) > authorization.cap) {
    throw new ModelTestBudgetError('ledger exceeds authorized cap')
  }
  return stopped
}

function readLedger(path: string) {
  const journal = readFileSync(path, 'utf8')
  if (!journal.endsWith('\n')) throw new ModelTestBudgetError('incomplete ledger; reconcile before reuse')
  const lines = journal.trimEnd().split('\n').map((line) => JSON.parse(line) as RecordLine)
  const first = lines.shift()
  if (first?.type !== 'policy' || first.policy !== POLICY || first.cap !== CAP_MICRO_CNY) {
    throw new ModelTestBudgetError('ledger policy mismatch')
  }
  const entries = new Map<string, Entry>()
  const authorization: Authorization = { cap: CAP_MICRO_CNY, authorizationIds: [] }
  let stopped = ''
  for (const line of lines) stopped = applyRecord(entries, stopped, line, authorization)
  return { entries, stopped, authorization }
}

function budgetSnapshot(path: string, entries: Map<string, Entry>, stopped: string, authorization: Authorization) {
  const requests = [...entries.values()]
  return {
    ledger: path, capCny: authorization.cap === null ? null : authorization.cap / 1_000_000, policy: POLICY,
    authorizationIds: [...authorization.authorizationIds],
    // Upper bound, not an invoice. Interrupted requests retain their maximum.
    accountedUpperBoundCny: requests.reduce((sum, entry) => sum + entry.charged, 0) / 1_000_000,
    requests: requests.length, unsettledRequests: requests.filter((entry) => !entry.settled).length,
    stopped: stopped || undefined,
  }
}

/** Local-only inspection: no creation, lock, write, provider, or tariff refresh. */
export function inspectModelTestBudget(path: string) {
  const { entries, stopped, authorization } = readLedger(path)
  return budgetSnapshot(path, entries, stopped, authorization)
}

export class ModelTestBudget {
  private readonly entries = new Map<string, Entry>()
  private readonly fd: number
  private readonly lockPath: string
  private closed = false
  private stopped = ''
  private authorization: Authorization = { cap: CAP_MICRO_CNY, authorizationIds: [] }

  constructor(readonly path: string, private readonly now: () => number = Date.now) {
    this.lockPath = `${path}.lock`
    // Never steal stale locks: an interrupted runner needs explicit reconciliation.
    const lock = openSync(this.lockPath, 'wx', 0o600)
    writeSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    fsyncSync(lock)
    closeSync(lock)
    let fd: number | undefined
    try {
      const existed = existsSync(path)
      fd = openSync(path, existed ? 'a+' : 'ax+', 0o600)
      this.fd = fd
      if (existed) {
        const ledger = readLedger(path)
        this.entries = ledger.entries
        this.stopped = ledger.stopped
        this.authorization = ledger.authorization
      } else {
        this.append({ type: 'policy', policy: POLICY, cap: CAP_MICRO_CNY })
        const directory = openSync(dirname(path), 'r')
        try { fsyncSync(directory) } finally { closeSync(directory) }
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      unlinkSync(this.lockPath)
      throw error
    }
  }

  snapshot() {
    return budgetSnapshot(this.path, this.entries, this.stopped, this.authorization)
  }

  /** Explicit user action; never invoked by construction, preflight or runner. */
  removeAuthorizedLimit(authorizationId: typeof USER_AUTHORIZED_LIMIT_REMOVAL_20260909) {
    if (this.closed) this.stop('ledger closed')
    if (authorizationId !== USER_AUTHORIZED_LIMIT_REMOVAL_20260909) throw new ModelTestBudgetError('unknown limit-removal authorization')
    if (this.authorization.authorizationIds.includes(authorizationId)) return this.snapshot()
    const record: RecordLine = { type: 'limit_removed', authorizationId, previousCap: 70_000_000, previousHalt: this.stopped }
    applyRecord(this.entries, this.stopped, record, { ...this.authorization, authorizationIds: [...this.authorization.authorizationIds] })
    this.append(record)
    this.apply(record)
    return this.snapshot()
  }

  /** Explicit operator action for a recorded user authorization. Never called by
   * constructor, inspection, or a paid runner. The exclusive ledger lock and
   * one fsynced append commit the grant before any higher reservation is legal;
   * a torn append remains unreadable/fail-closed, never a partial allowance. */
  grantAuthorizedBudget(authorizationId: AuthorizationId) {
    if (this.closed || this.stopped) this.stop(this.closed ? 'ledger closed' : this.stopped)
    const approved = AUTHORIZED_GRANTS.find((grant) => grant.authorizationId === authorizationId)
    if (!approved) this.stop('unknown additional authorization')
    if (this.authorization.authorizationIds.includes(authorizationId)) return this.snapshot()
    const record: RecordLine = { type: 'grant', ...approved }
    // Validate without changing the live allowance before persistence.
    applyRecord(this.entries, this.stopped, record, { ...this.authorization, authorizationIds: [...this.authorization.authorizationIds] })
    this.append(record)
    this.apply(record)
    return this.snapshot()
  }

  stop(reason: string): never {
    this.stopped ||= reason
    throw new ModelTestBudgetError(this.stopped)
  }

  assertModel(model: string): Tariff {
    if (this.closed || this.stopped) this.stop(this.closed ? 'ledger closed' : this.stopped)
    // Refresh the official tariff before another day's paid test; keep the
    // same authorization ledger and do not grant a new ¥20 allowance.
    if (this.now() >= TEST_MODEL_TARIFF_VALID_UNTIL) this.stop('verified tariff expired; refresh pricing before reuse')
    const tariff = Object.hasOwn(TEST_MODEL_TARIFFS, model)
      ? TEST_MODEL_TARIFFS[model as keyof typeof TEST_MODEL_TARIFFS] : undefined
    // Do not infer a current tariff from an old alias or change the chosen model.
    if (!tariff) this.stop(`no verified current tariff for ${model}`)
    return tariff
  }

  private append(record: RecordLine) {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
    try {
      let written = 0
      while (written < bytes.length) written += writeSync(this.fd, bytes, written, bytes.length - written)
      fsyncSync(this.fd)
    } catch {
      this.stopped = 'ledger persistence failed; retained reservations require reconciliation'
      throw new ModelTestBudgetError(this.stopped)
    }
  }

  private apply(record: RecordLine) {
    this.stopped = applyRecord(this.entries, this.stopped, record, this.authorization)
  }

  private reserve(model: string, maxOutput: number) {
    const tariff = this.assertModel(model)
    if (!Number.isSafeInteger(maxOutput) || maxOutput <= 0 || maxOutput > MAX_OUTPUT) this.stop('unknown output ceiling')
    const maximum = CONTEXT_CEILING * tariff.input + maxOutput * tariff.output
    const used = [...this.entries.values()].reduce((sum, entry) => sum + entry.charged, 0)
    if (this.authorization.cap !== null && used + maximum > this.authorization.cap) this.stop(`next physical request cannot fit within cumulative ¥${this.authorization.cap / 1_000_000}`)
    const record = { type: 'reserve' as const, id: randomUUID(), model, maximum }
    this.append(record)
    this.apply(record)
    return { id: record.id, tariff, maxOutput }
  }

  private settle(request: { id: string; tariff: Tariff; maxOutput: number }, usage: unknown) {
    if (!usage || typeof usage !== 'object') return
    const { prompt_tokens: input, completion_tokens: output, total_tokens: total } = usage as Record<string, unknown>
    if (typeof input !== 'number' || typeof output !== 'number' || typeof total !== 'number'
      || ![input, output, total].every((value) => Number.isSafeInteger(value) && value >= 0)
      || input + output !== total) return
    const usageBound = input > CONTEXT_CEILING || output > request.maxOutput
      ? { requestId: request.id, input, output, total, maxInput: CONTEXT_CEILING, maxOutput: request.maxOutput } : undefined
    if (usageBound && this.authorization.cap !== null) {
      // Numeric provider evidence only; never persist prompts, credentials or
      // whole responses. A diagnostic does not settle, release or reopen a
      // reservation, even when the observed monetary estimate fits within it.
      const halt = { type: 'halt' as const, reason: 'provider usage exceeded verified request bound; reconciliation required',
        usageBound: { requestId: request.id, input, output, total, maxInput: CONTEXT_CEILING, maxOutput: request.maxOutput } }
      this.append(halt)
      this.apply(halt)
      this.stop(halt.reason)
    }
    const record = { type: 'settle' as const, id: request.id, charged: input * request.tariff.input + output * request.tariff.output,
      ...(usageBound ? { usageBound } : {}) }
    // Validate before persistence even without a monetary admission limit.
    applyRecord(new Map([...this.entries].map(([id, entry]) => [id, { ...entry }])), this.stopped, record,
      { ...this.authorization, authorizationIds: [...this.authorization.authorizationIds] })
    this.append(record)
    this.apply(record)
  }

  wrapFetch(transport: typeof fetch): typeof fetch {
    return async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== 'https://api.deepseek.com' || !['/chat/completions', '/v1/chat/completions'].includes(url.pathname)
        || url.search || url.username || url.password || init?.method !== 'POST' || typeof init.body !== 'string') {
        this.stop('unmetered model endpoint or request format')
      }
      init.signal?.throwIfAborted()
      const body = JSON.parse(init.body) as { model: string; max_tokens: number; stream?: boolean }
      const reserved = this.reserve(body.model, body.max_tokens)
      // Redirects must not dispatch a second, unreserved model request.
      const response = await transport(input, { ...init, redirect: 'manual' })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        this.stop('model endpoint redirect rejected')
      }
      if (!response.ok || !response.body) return response
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      let usage: unknown
      let usageCount = 0
      let invalid = false
      let done = false
      let sawDone = false
      const observe = (text: string, eof: boolean) => {
        if (done || invalid) return
        pending += text
        if (pending.length > 2_000_000) { invalid = true; return }
        if (body.stream) {
          const lines = (pending + (eof ? '\n' : '')).split('\n')
          pending = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (sawDone) { invalid = true; continue }
            if (data === '[DONE]') {
              sawDone = true
              continue
            }
            try {
              const chunk = JSON.parse(data)
              if (chunk.error) invalid = true
              if (chunk.usage) { usage = chunk.usage; usageCount += 1 }
            } catch { invalid = true }
          }
          // The production client reads through EOF. DONE alone is not enough:
          // trailing usage/errors or a transport failure make billing ambiguous.
          if (eof) {
            if (!invalid && sawDone && usageCount === 1) this.settle(reserved, usage)
            done = true
          }
        } else if (eof) {
          try {
            const payload = JSON.parse(pending)
            if (!payload.error && Array.isArray(payload.choices) && payload.choices.length > 0
              && payload.choices.every((choice: { finish_reason?: unknown }) => typeof choice.finish_reason === 'string')) {
              usage = payload.usage
            }
          } catch { invalid = true }
          if (!invalid) this.settle(reserved, usage)
          done = true
        }
      }
      const budget = this
      // Observe the consumer's stream; no tee, hidden draining, buffering of the
      // full stream, or cancellation changes. Missing DONE means no refund.
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read()
            observe(next.done ? decoder.decode() : decoder.decode(next.value, { stream: true }), next.done)
            if (next.done) { reader.releaseLock(); controller.close() }
            else controller.enqueue(next.value)
          } catch (error) {
            await reader.cancel(error).catch(() => undefined)
            controller.error(error)
            if (error instanceof ModelTestBudgetError) budget.stopped ||= error.message
          }
        },
        async cancel(reason) { await reader.cancel(reason) },
      }), { status: response.status, statusText: response.statusText, headers: response.headers })
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    closeSync(this.fd)
    unlinkSync(this.lockPath)
  }
}
