import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DAILY_CREDIT_LIMIT_ERROR_MESSAGE,
  DailyCreditStore,
} from './credit-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-credits-'))
  roots.push(root)
  return root
}

describe('daily credit store', () => {
  it('starts at the public 2500-credit and 100-pulse defaults with the next UTC reset', async () => {
    const root = await temporaryRoot()
    const store = new DailyCreditStore(root, { now: () => new Date('2026-08-28T15:42:17.000Z') })
    await store.initialize()

    expect(await store.balance()).toEqual({
      creditsRemaining: 2_500,
      dailyFreeCredits: 2_500,
      refreshedAt: '2026-08-29T00:00:00.000Z',
    })
    expect(await store.pulse()).toEqual({
      pulse: 100,
      refreshedAt: '2026-08-29T00:00:00.000Z',
    })
  })

  it('charges only the rounded cumulative-cost delta for a session', async () => {
    const root = await temporaryRoot()
    const store = new DailyCreditStore(root, {
      dailyFreeCredits: 10,
      creditsPerUsd: 1_000,
      now: () => new Date('2026-08-28T01:00:00.000Z'),
    })
    await store.initialize()

    expect(await store.settle('ses_aaaaaaaaaaaaaaaaaaaa', 0.001)).toMatchObject({ chargedCredits: 1, settledCredits: 1 })
    expect(await store.settle('ses_aaaaaaaaaaaaaaaaaaaa', 0.001)).toMatchObject({ chargedCredits: 0, settledCredits: 1 })
    expect(await store.settle('ses_aaaaaaaaaaaaaaaaaaaa', 0.0011)).toMatchObject({ chargedCredits: 1, settledCredits: 2 })
    expect(await store.settle('ses_aaaaaaaaaaaaaaaaaaaa', 0.0001)).toMatchObject({ chargedCredits: 0, settledCredits: 2 })
    expect(await store.balance()).toMatchObject({ creditsRemaining: 8, dailyFreeCredits: 10 })
    expect(await store.pulse()).toMatchObject({ pulse: 80 })
  })

  it('persists settlement baselines and does not recharge after restart', async () => {
    const root = await temporaryRoot()
    const options = {
      dailyFreeCredits: 10,
      creditsPerUsd: 1_000,
      now: () => new Date('2026-08-28T01:00:00.000Z'),
    }
    const first = new DailyCreditStore(root, options)
    await first.initialize()
    await first.settle('ses_bbbbbbbbbbbbbbbbbbbb', 0.003)

    const restarted = new DailyCreditStore(root, options)
    await restarted.initialize()
    expect(await restarted.balance()).toMatchObject({ creditsRemaining: 7 })
    expect(await restarted.settle('ses_bbbbbbbbbbbbbbbbbbbb', 0.003)).toMatchObject({ chargedCredits: 0, settledCredits: 3 })
    expect(await restarted.settle('ses_bbbbbbbbbbbbbbbbbbbb', 0.004)).toMatchObject({ chargedCredits: 1, settledCredits: 4 })
    expect(await restarted.balance()).toMatchObject({ creditsRemaining: 6 })
  })

  it('clamps an over-limit balance and blocks only subsequent non-free starts', async () => {
    const root = await temporaryRoot()
    const store = new DailyCreditStore(root, {
      dailyFreeCredits: 3,
      creditsPerUsd: 1_000,
      now: () => new Date('2026-08-28T01:00:00.000Z'),
    })
    await store.initialize()

    const settlement = await store.settle('ses_cccccccccccccccccccc', 0.004)
    expect(settlement).toMatchObject({
      chargedCredits: 4,
      settledCredits: 4,
      balance: { creditsRemaining: 0, dailyFreeCredits: 3 },
      pulse: { pulse: 0 },
    })
    await expect(store.assertCanStart()).rejects.toMatchObject({
      name: 'DailyCreditLimitError',
      code: 'daily_credit_limit',
      statusCode: 429,
      message: DAILY_CREDIT_LIMIT_ERROR_MESSAGE,
    })
    await expect(store.assertCanStart(true)).resolves.toBeUndefined()
  })

  it('does not consume credits for a free session while retaining its settlement baseline', async () => {
    const root = await temporaryRoot()
    const store = new DailyCreditStore(root, {
      dailyFreeCredits: 5,
      creditsPerUsd: 1_000,
      now: () => new Date('2026-08-28T01:00:00.000Z'),
    })
    await store.initialize()

    expect(await store.settle('ses_dddddddddddddddddddd', 4.5, true)).toMatchObject({
      chargedCredits: 0,
      settledCredits: 4_500,
      balance: { creditsRemaining: 5 },
    })
    expect(await store.balance()).toMatchObject({ creditsRemaining: 5 })
    await expect(store.assertCanStart(true)).resolves.toBeUndefined()
  })

  it('resets usage at UTC midnight and charges only later lifetime-cost growth', async () => {
    const root = await temporaryRoot()
    let now = new Date('2026-08-28T23:59:59.000Z')
    const store = new DailyCreditStore(root, {
      dailyFreeCredits: 20,
      creditsPerUsd: 1_000,
      now: () => now,
    })
    await store.initialize()
    await store.settle('ses_eeeeeeeeeeeeeeeeeeee', 0.010)
    expect(await store.balance()).toMatchObject({ creditsRemaining: 10, refreshedAt: '2026-08-29T00:00:00.000Z' })

    now = new Date('2026-08-29T00:00:01.000Z')
    expect(await store.balance()).toMatchObject({ creditsRemaining: 20, refreshedAt: '2026-08-30T00:00:00.000Z' })
    expect(await store.settle('ses_eeeeeeeeeeeeeeeeeeee', 0.015)).toMatchObject({
      chargedCredits: 5,
      settledCredits: 15,
      balance: { creditsRemaining: 15 },
    })
  })

  it('serializes concurrent settlements without lost updates or duplicate charging', async () => {
    const root = await temporaryRoot()
    const store = new DailyCreditStore(root, {
      dailyFreeCredits: 20,
      creditsPerUsd: 1_000,
      now: () => new Date('2026-08-28T01:00:00.000Z'),
    })
    await store.initialize()

    const sameSession = await Promise.all([0.001, 0.004, 0.002, 0.005].map((cost) => (
      store.settle('ses_ffffffffffffffffffff', cost)
    )))
    expect(sameSession.reduce((total, settlement) => total + settlement.chargedCredits, 0)).toBe(5)
    await Promise.all([
      store.settle('ses_11111111111111111111', 0.003),
      store.settle('ses_22222222222222222222', 0.002),
      store.settle('ses_33333333333333333333', 0.001),
    ])
    expect(await store.balance()).toMatchObject({ creditsRemaining: 9 })
  })

  it('creates an owner-only ledger directory and state file', async () => {
    const root = await temporaryRoot()
    const store = new DailyCreditStore(root, { now: () => new Date('2026-08-28T01:00:00.000Z') })
    await store.initialize()

    expect((await stat(resolve(root, 'billing'))).mode & 0o777).toBe(0o700)
    expect((await stat(resolve(root, 'billing', 'credits.json'))).mode & 0o777).toBe(0o600)
  })
})
