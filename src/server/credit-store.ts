import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CreditBalance, DailyCreditPulse } from '../shared/types.js'

interface SettledSessionCredits {
  credits: number
  costUsd: number
  isFreeSession: boolean
  updatedAt: string
}

interface PersistedCreditState {
  schemaVersion: 1
  periodStart: string
  creditsUsed: number
  settledSessions: Record<string, SettledSessionCredits>
}

export interface CreditSettlement {
  chargedCredits: number
  settledCredits: number
  balance: CreditBalance
  pulse: DailyCreditPulse
}

export interface DailyCreditStoreOptions {
  dailyFreeCredits?: number
  creditsPerUsd?: number
  now?: () => Date
}

export class DailyCreditStore {
  private readonly dailyFreeCredits: number
  private readonly creditsPerUsd: number
  private readonly now: () => Date
  private readonly directory: string
  private readonly statePath: string
  private initialized = false
  private state?: PersistedCreditState
  private queue: Promise<unknown> = Promise.resolve()

  constructor(root: string, options: DailyCreditStoreOptions = {}) {
    this.dailyFreeCredits = positiveInteger(options.dailyFreeCredits, 2_500)
    this.creditsPerUsd = positiveInteger(options.creditsPerUsd, 1_000)
    this.now = options.now ?? (() => new Date())
    this.directory = resolve(root, 'billing')
    this.statePath = resolve(this.directory, 'credits.json')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.enqueue(async () => {
      if (this.initialized) return
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      this.state = await this.readState()
      const changed = this.rollPeriod(this.state, this.now())
      if (changed || !(await this.stateFileExists())) await this.writeState(this.state)
      this.initialized = true
    })
  }

  async balance(): Promise<CreditBalance> {
    return await this.enqueue(async () => {
      const state = await this.currentState()
      if (this.rollPeriod(state, this.now())) await this.writeState(state)
      return this.projectBalance(state)
    })
  }

  async pulse(): Promise<DailyCreditPulse> {
    return await this.enqueue(async () => {
      const state = await this.currentState()
      if (this.rollPeriod(state, this.now())) await this.writeState(state)
      return this.projectPulse(state)
    })
  }

  async assertCanStart(_isFreeSession = false): Promise<void> {
    // Credits are local usage telemetry, not an admission quota. Keeping this
    // compatibility hook preserves startup ordering without allowing tracked
    // spend to block a self-hosted run.
  }

  async settle(sessionId: string, totalCostUsd: number, isFreeSession = false): Promise<CreditSettlement> {
    if (!/^ses_[a-z0-9]{20}$/.test(sessionId)) throw new Error('Invalid session id')
    if (!Number.isFinite(totalCostUsd) || totalCostUsd < 0) throw new Error('Session cost must be a non-negative finite number')
    return await this.enqueue(async () => {
      const state = await this.currentState()
      this.rollPeriod(state, this.now())
      const settledCredits = Math.max(0, Math.ceil(totalCostUsd * this.creditsPerUsd - Number.EPSILON))
      const previous = state.settledSessions[sessionId]
      const priorCredits = previous?.credits ?? 0
      const chargedCredits = isFreeSession ? 0 : Math.max(0, settledCredits - priorCredits)
      if (chargedCredits > 0) state.creditsUsed += chargedCredits
      if (!previous || settledCredits > previous.credits || previous.isFreeSession !== isFreeSession || totalCostUsd > previous.costUsd) {
        state.settledSessions[sessionId] = {
          credits: Math.max(priorCredits, settledCredits),
          costUsd: Math.max(previous?.costUsd ?? 0, totalCostUsd),
          isFreeSession,
          updatedAt: this.now().toISOString(),
        }
      }
      await this.writeState(state)
      return {
        chargedCredits,
        settledCredits: state.settledSessions[sessionId]?.credits ?? settledCredits,
        balance: this.projectBalance(state),
        pulse: this.projectPulse(state),
      }
    })
  }

  private async currentState(): Promise<PersistedCreditState> {
    if (!this.initialized || !this.state) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      this.state = await this.readState()
      this.initialized = true
    }
    return this.state
  }

  private async readState(): Promise<PersistedCreditState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PersistedCreditState>
      if (parsed.schemaVersion !== 1 || typeof parsed.periodStart !== 'string') throw new Error('Unsupported credits state')
      return {
        schemaVersion: 1,
        periodStart: parsed.periodStart,
        creditsUsed: nonNegativeInteger(parsed.creditsUsed),
        settledSessions: sanitizeSettledSessions(parsed.settledSessions),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return this.emptyState(this.now())
    }
  }

  private emptyState(now: Date): PersistedCreditState {
    return {
      schemaVersion: 1,
      periodStart: utcDayStart(now).toISOString(),
      creditsUsed: 0,
      settledSessions: {},
    }
  }

  private rollPeriod(state: PersistedCreditState, now: Date): boolean {
    const currentStart = utcDayStart(now).toISOString()
    if (state.periodStart === currentStart) return false
    state.periodStart = currentStart
    state.creditsUsed = 0
    return true
  }

  private projectBalance(state: PersistedCreditState): CreditBalance {
    return {
      creditsRemaining: Math.max(0, this.dailyFreeCredits - state.creditsUsed),
      dailyFreeCredits: this.dailyFreeCredits,
      refreshedAt: nextUtcDay(state.periodStart).toISOString(),
    }
  }

  private projectPulse(state: PersistedCreditState): DailyCreditPulse {
    const balance = this.projectBalance(state)
    return {
      pulse: Math.max(0, Math.min(100, Math.floor(balance.creditsRemaining / balance.dailyFreeCredits * 100))),
      refreshedAt: balance.refreshedAt,
    }
  }

  private async stateFileExists(): Promise<boolean> {
    try {
      await readFile(this.statePath, 'utf8')
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async writeState(state: PersistedCreditState): Promise<void> {
    const temporary = `${this.statePath}.tmp-${process.pid}`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.statePath)
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return await next
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function sanitizeSettledSessions(value: unknown): Record<string, SettledSessionCredits> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, SettledSessionCredits> = {}
  for (const [sessionId, raw] of Object.entries(value)) {
    if (!/^ses_[a-z0-9]{20}$/.test(sessionId) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Partial<SettledSessionCredits>
    if (typeof item.costUsd !== 'number' || !Number.isFinite(item.costUsd) || item.costUsd < 0) continue
    result[sessionId] = {
      credits: nonNegativeInteger(item.credits),
      costUsd: item.costUsd,
      isFreeSession: item.isFreeSession === true,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString(),
    }
  }
  return result
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function nextUtcDay(periodStart: string): Date {
  const date = new Date(periodStart)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1))
}
