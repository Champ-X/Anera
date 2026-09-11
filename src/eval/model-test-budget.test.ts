import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectModelTestBudget, ModelTestBudget, USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909,
  USER_AUTHORIZED_ADDITIONAL_30_CNY_20260909, USER_AUTHORIZED_LIMIT_REMOVAL_20260909,
  TEST_MODEL_TARIFF_VALID_UNTIL } from './model-test-budget.js'

const endpoint = 'https://api.deepseek.com/chat/completions'
const clock = () => Date.parse('2026-09-09T10:00:00+08:00')
const dirs: string[] = []
const budgets: ModelTestBudget[] = []
function open(path?: string) {
  if (!path) { const dir = mkdtempSync(join(tmpdir(), 'anera-budget-test-')); dirs.push(dir); path = join(dir, 'ledger.jsonl') }
  const budget = new ModelTestBudget(path, clock)
  budgets.push(budget)
  return budget
}
function request(model = 'deepseek-v4-flash', stream = true): RequestInit {
  return { method: 'POST', body: JSON.stringify({ model, stream, max_tokens: 16_384, messages: [] }) }
}
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 100 }
function sse(text: string) { return new Response(text, { headers: { 'content-type': 'text/event-stream' } }) }
const completed = `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`
const additionalGrant = { type: 'grant', authorizationId: USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909,
  previousCap: 20_000_000, additional: 20_000_000, cap: 40_000_000 }
const latestGrant = { type: 'grant', authorizationId: USER_AUTHORIZED_ADDITIONAL_30_CNY_20260909,
  previousCap: 40_000_000, additional: 30_000_000, cap: 70_000_000 }
afterEach(() => {
  for (const budget of budgets.splice(0)) budget.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true })
})

describe('cumulative model-test CNY budget (zero provider calls)', () => {
  it('removes the explicitly waived halt and cap append-only, without refunding old unknown requests', async () => {
    const budget = open()
    budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909)
    budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_30_CNY_20260909)
    const over = { prompt_tokens: 100, completion_tokens: 16_385, total_tokens: 16_485 }
    const response = await budget.wrapFetch(async () => sse(`data: ${JSON.stringify({ usage: over })}\n\ndata: [DONE]\n\n`))(endpoint, request())
    await expect(response.text()).rejects.toThrow('usage exceeded')
    const before = readFileSync(budget.path, 'utf8')
    const original = budget.snapshot()
    expect(original.unsettledRequests).toBe(1)
    const removed = budget.removeAuthorizedLimit(USER_AUTHORIZED_LIMIT_REMOVAL_20260909)
    expect(removed).toEqual({ ...original, capCny: null, stopped: undefined,
      authorizationIds: [...original.authorizationIds, USER_AUTHORIZED_LIMIT_REMOVAL_20260909] })
    const appended = readFileSync(budget.path, 'utf8')
    expect(appended).toBe(before + JSON.stringify({ type: 'limit_removed', authorizationId: USER_AUTHORIZED_LIMIT_REMOVAL_20260909,
      previousCap: 70_000_000, previousHalt: original.stopped }) + '\n')
    budget.close()
    const reopened = open(budget.path)
    expect(reopened.removeAuthorizedLimit(USER_AUTHORIZED_LIMIT_REMOVAL_20260909)).toEqual(removed)
    expect(readFileSync(budget.path, 'utf8')).toBe(appended)
    const transport = vi.fn<typeof fetch>(async () => new Response('unknown', { status: 503 }))
    for (let index = 0; index < 22; index += 1) await reopened.wrapFetch(transport)(endpoint, request())
    expect(transport).toHaveBeenCalledTimes(22)
    expect(reopened.snapshot().accountedUpperBoundCny).toBeGreaterThan(70)
    expect(reopened.snapshot()).toMatchObject({ capCny: null, unsettledRequests: 23, stopped: undefined })
    expect(readFileSync(budget.path, 'utf8').startsWith(before)).toBe(true)
  })

  it.each([100, 1_048_577])('records anomalous usage after limit removal without stopping or hiding cost (input=%s)', async (input) => {
    const budget = open()
    budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909)
    budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_30_CNY_20260909)
    budget.removeAuthorizedLimit(USER_AUTHORIZED_LIMIT_REMOVAL_20260909)
    const over = { prompt_tokens: input, completion_tokens: 16_385, total_tokens: input + 16_385 }
    const text = `data: ${JSON.stringify({ usage: over })}\n\ndata: [DONE]\n\n`
    expect(await (await budget.wrapFetch(async () => sse(text))(endpoint, request())).text()).toBe(text)
    expect(budget.snapshot()).toMatchObject({ capCny: null, unsettledRequests: 0, stopped: undefined,
      accountedUpperBoundCny: (input * 3 + 16_385 * 9) / 1_000_000 })
    const record = JSON.parse(readFileSync(budget.path, 'utf8').trim().split('\n').at(-1)!)
    expect(record.usageBound).toMatchObject({ input, output: 16_385, total: input + 16_385, maxOutput: 16_384 })
    expect(inspectModelTestBudget(budget.path)).toEqual(budget.snapshot())
  })

  it.each(['invented', 'wrong-cap', 'wrong-halt', 'duplicate', 'extra', 'unrelated-halt'] as const)(
    'rejects invalid limit-removal authorization: %s', (variant) => {
    const budget = open()
    budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909)
    budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_30_CNY_20260909)
    budget.close()
    const valid = { type: 'limit_removed', authorizationId: USER_AUTHORIZED_LIMIT_REMOVAL_20260909, previousCap: 70_000_000, previousHalt: '' }
    const record = { ...valid,
      ...(variant === 'invented' ? { authorizationId: 'invented' } : {}),
      ...(variant === 'wrong-cap' ? { previousCap: 40_000_000 } : {}),
      ...(variant === 'wrong-halt' ? { previousHalt: 'not current' } : {}),
      ...(variant === 'extra' ? { cap: null } : {}),
      ...(variant === 'unrelated-halt' ? { previousHalt: 'corrupt ledger' } : {}),
    }
    const prefix = readFileSync(budget.path, 'utf8')
      + (variant === 'unrelated-halt' ? JSON.stringify({ type: 'halt', reason: 'corrupt ledger' }) + '\n' : '')
    const line = JSON.stringify(record) + '\n'
    writeFileSync(budget.path, prefix + line + (variant === 'duplicate' ? line : ''))
    expect(() => inspectModelTestBudget(budget.path)).toThrow('limit-removal')
  })

  it('keeps ordinary construction, inspection and reopening at the original ¥20 without implicitly granting', () => {
    const budget = open()
    const original = readFileSync(budget.path, 'utf8')
    expect(JSON.parse(original)).toMatchObject({ type: 'policy', cap: 20_000_000 })
    expect(inspectModelTestBudget(budget.path)).toMatchObject({ capCny: 20, authorizationIds: [] })
    budget.close()
    expect(open(budget.path).snapshot()).toMatchObject({ capCny: 20, authorizationIds: [] })
    expect(readFileSync(budget.path, 'utf8')).toBe(original)
  })

  it('appends the one durable grant idempotently, preserving historical settlements and both unresolved reservations', async () => {
    const budget = open()
    await (await budget.wrapFetch(async () => sse(completed))(endpoint, request())).text()
    await budget.wrapFetch(async () => new Response('unknown', { status: 503 }))(endpoint, request())
    await budget.wrapFetch(async () => new Response('unknown', { status: 503 }))(endpoint, request())
    const before = readFileSync(budget.path, 'utf8')
    const usageBefore = budget.snapshot()
    expect(budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909)).toMatchObject({
      capCny: 40, authorizationIds: [USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909], requests: 3, unsettledRequests: 2,
      accountedUpperBoundCny: usageBefore.accountedUpperBoundCny,
    })
    const granted = readFileSync(budget.path, 'utf8')
    expect(granted).toBe(before + JSON.stringify(additionalGrant) + '\n')
    expect(inspectModelTestBudget(budget.path)).toEqual(budget.snapshot())
    budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909)
    expect(readFileSync(budget.path, 'utf8')).toBe(granted)
    budget.close()
    const reopened = open(budget.path)
    expect(reopened.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909)).toMatchObject({ capCny: 40,
      requests: 3, unsettledRequests: 2, accountedUpperBoundCny: usageBefore.accountedUpperBoundCny })
    expect(readFileSync(budget.path, 'utf8')).toBe(granted)
  })

  it('rejects a caller-invented authorization ID without appending anything', () => {
    const budget = open()
    const before = readFileSync(budget.path)
    expect(() => budget.grantAuthorizedBudget('invented-grant' as never)).toThrow('unknown additional authorization')
    expect(readFileSync(budget.path)).toEqual(before)
    expect(inspectModelTestBudget(budget.path).capCny).toBe(20)
  })

  it.each([
    { authorizationId: 'another-user-authorization' }, { additional: 40_000_000 },
    { previousCap: 0 }, { cap: 60_000_000 }, { cap: '40000000' }, { extra: 'untrusted' },
  ])('rejects a forged grant record without changing any retained bytes: %j', (patch) => {
    const budget = open()
    budget.close()
    const corrupted = readFileSync(budget.path, 'utf8') + JSON.stringify({ ...additionalGrant, ...patch }) + '\n'
    writeFileSync(budget.path, corrupted)
    expect(() => inspectModelTestBudget(budget.path)).toThrow('authorization grant')
    expect(() => open(budget.path)).toThrow('authorization grant')
    expect(readFileSync(budget.path, 'utf8')).toBe(corrupted)
    expect(existsSync(`${budget.path}.lock`)).toBe(false)
  })

  it.each(['duplicate', 'after halt', 'after overspend', 'torn'] as const)('rejects a %s grant rather than resurrecting or expanding authority', (kind) => {
    const budget = open()
    budget.close()
    const grantLine = JSON.stringify(additionalGrant) + '\n'
    const suffix = kind === 'duplicate' ? grantLine + grantLine
      : kind === 'after halt' ? JSON.stringify({ type: 'halt', reason: 'must reconcile' }) + '\n' + grantLine
        : kind === 'after overspend' ? JSON.stringify({ type: 'reserve', id: 'over', model: 'deepseek-v4-flash', maximum: 20_000_001 }) + '\n' + grantLine
          : grantLine.slice(0, -2)
    const corrupted = readFileSync(budget.path, 'utf8') + suffix
    writeFileSync(budget.path, corrupted)
    expect(() => inspectModelTestBudget(budget.path)).toThrow()
    expect(() => open(budget.path)).toThrow()
    expect(readFileSync(budget.path, 'utf8')).toBe(corrupted)
  })

  it('never accepts a rewritten ¥40 policy header or grants after a terminal halt', () => {
    const budget = open()
    budget.close()
    const original = readFileSync(budget.path, 'utf8')
    writeFileSync(budget.path, original.replace('20000000', '40000000'))
    expect(() => inspectModelTestBudget(budget.path)).toThrow('policy mismatch')
    writeFileSync(budget.path, original + JSON.stringify({ type: 'halt', reason: 'terminal reconciliation required' }) + '\n')
    const reopened = open(budget.path)
    const before = readFileSync(budget.path)
    expect(() => reopened.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909)).toThrow('terminal reconciliation required')
    expect(readFileSync(budget.path)).toEqual(before)
    expect(reopened.snapshot().capCny).toBe(20)
  })

  it.each([{ cap: 40, requests: 4, used: 39.518208 }, { cap: 70, requests: 7, used: 69.156864 }])(
    'admits only up to explicitly granted ¥$cap and retains output and reasoning', async ({ cap, requests, used }) => {
    const budget = open()
    budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909)
    if (cap === 70) budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_30_CNY_20260909)
    const init = { ...request('deepseek-v4-pro'), body: JSON.stringify({
      model: 'deepseek-v4-pro', stream: true, max_tokens: 16_384,
      thinking: { type: 'enabled' }, reasoning_effort: 'low', messages: [],
    }) }
    const transport = vi.fn<typeof fetch>(async (_input, actual) => {
      expect(actual).toEqual({ ...init, redirect: 'manual' })
      expect(inspectModelTestBudget(budget.path).capCny).toBe(cap)
      return new Response('unknown', { status: 503 })
    })
    const guarded = budget.wrapFetch(transport)
    for (let index = 0; index < requests; index += 1) await guarded(endpoint, init)
    await expect(guarded(endpoint, init)).rejects.toThrow(`cumulative ¥${cap}`)
    expect(transport).toHaveBeenCalledTimes(requests)
    expect(budget.snapshot()).toMatchObject({ capCny: cap, requests, unsettledRequests: requests, accountedUpperBoundCny: used })
  })

  it('appends the new ¥30 exactly once while preserving the entire ¥40 ledger and unknown settlements', async () => {
    const budget = open()
    budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909)
    await (await budget.wrapFetch(async () => sse(completed))(endpoint, request())).text()
    await budget.wrapFetch(async () => new Response('unknown', { status: 503 }))(endpoint, request())
    const before = readFileSync(budget.path, 'utf8')
    const previous = budget.snapshot()
    expect(budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_30_CNY_20260909)).toEqual({ ...previous, capCny: 70,
      authorizationIds: [USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909, USER_AUTHORIZED_ADDITIONAL_30_CNY_20260909] })
    const granted = before + JSON.stringify(latestGrant) + '\n'
    expect(readFileSync(budget.path, 'utf8')).toBe(granted)
    budget.close()
    const reopened = open(budget.path)
    for (const id of [USER_AUTHORIZED_ADDITIONAL_30_CNY_20260909, USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909]) {
      expect(reopened.grantAuthorizedBudget(id).capCny).toBe(70)
    }
    expect(readFileSync(budget.path, 'utf8')).toBe(granted)
    expect(inspectModelTestBudget(budget.path)).toEqual(reopened.snapshot())
  })

  it.each(['out-of-order', 'duplicate', 'amount', 'prior-cap', 'cap', 'after-halt'] as const)(
    'rejects a new %s grant without changing the ledger', (kind) => {
    const budget = open()
    if (kind !== 'out-of-order') budget.grantAuthorizedBudget(USER_AUTHORIZED_ADDITIONAL_20_CNY_20260909)
    budget.close()
    const patch = kind === 'amount' ? { additional: 50_000_000 } : kind === 'prior-cap' ? { previousCap: 20_000_000 }
      : kind === 'cap' ? { cap: 90_000_000 } : {}
    const line = JSON.stringify({ ...latestGrant, ...patch }) + '\n'
    const suffix = kind === 'duplicate' ? line + line
      : kind === 'after-halt' ? JSON.stringify({ type: 'halt', reason: 'reconcile first' }) + '\n' + line : line
    const invalid = readFileSync(budget.path, 'utf8') + suffix
    writeFileSync(budget.path, invalid)
    expect(() => inspectModelTestBudget(budget.path)).toThrow()
    expect(() => open(budget.path)).toThrow()
    expect(readFileSync(budget.path, 'utf8')).toBe(invalid)
    expect(existsSync(`${budget.path}.lock`)).toBe(false)
  })

  it('inspects the same cumulative state read-only, even while a runner owns its lock', async () => {
    const budget = open()
    await (await budget.wrapFetch(async () => sse(completed))(endpoint, request())).text()
    await budget.wrapFetch(async () => new Response('unknown', { status: 503 }))(endpoint, request())
    const before = readFileSync(budget.path)
    const lock = readFileSync(`${budget.path}.lock`)
    expect(inspectModelTestBudget(budget.path)).toEqual(budget.snapshot())
    expect(readFileSync(budget.path)).toEqual(before)
    expect(readFileSync(`${budget.path}.lock`)).toEqual(lock)
    budget.close()
    expect(inspectModelTestBudget(budget.path)).toMatchObject({ requests: 2, unsettledRequests: 1 })
    expect(existsSync(`${budget.path}.lock`)).toBe(false)
  })

  it('read-only preflight never creates a missing authorization or lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anera-budget-inspect-'))
    dirs.push(dir)
    const path = join(dir, 'missing.jsonl')
    expect(() => inspectModelTestBudget(path)).toThrow()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.lock`)).toBe(false)
  })

  it.each([
    '{"type":"reserve","id":"same","model":"deepseek-v4-flash","maximum":100}\n{"type":"reserve","id":"same","model":"deepseek-v4-flash","maximum":100}\n',
    '{"type":"settle","id":"missing","charged":0}\n',
    '{"type":"halt","reason":"stop"}\n{"type":"reserve","id":"late","model":"deepseek-v4-flash","maximum":100}\n',
    '{"type":"reserve","id":"over","model":"deepseek-v4-flash","maximum":20000001}\n',
    '{"type":"halt","reason":""}\n',
    'null\n',
    '{"type":"reserve"}',
  ])('uses the same fail-closed parser for corrupt read-only ledgers: %s', (suffix) => {
    const budget = open()
    budget.close()
    const policy = readFileSync(budget.path, 'utf8')
    writeFileSync(budget.path, policy + suffix)
    expect(() => inspectModelTestBudget(budget.path)).toThrow()
    expect(readFileSync(budget.path, 'utf8')).toBe(policy + suffix)
    expect(existsSync(`${budget.path}.lock`)).toBe(false)
  })

  it('durably reserves before dispatch and preserves model, thinking and output options', async () => {
    const budget = open()
    const init = { ...request(), headers: { authorization: 'synthetic-test-only' } }
    const transport = vi.fn<typeof fetch>(async (_input, actual) => {
      expect(readFileSync(budget.path, 'utf8')).toContain('"type":"reserve"')
      expect(actual).toEqual({ ...init, redirect: 'manual' })
      expect(budget.snapshot().accountedUpperBoundCny).toBe(3.293184)
      return sse(completed)
    })
    expect(await (await budget.wrapFetch(transport)(endpoint, init)).text()).toBe(completed)
    expect(budget.snapshot()).toMatchObject({ requests: 1, unsettledRequests: 0, accountedUpperBoundCny: 0.00048 })
  })

  it('settles split UTF-8/SSE bytes without changing the response body', async () => {
    const budget = open()
    const content = `data: ${JSON.stringify({ choices: [{ delta: { content: '测试' } }] })}\n\n${completed}`
    const bytes = new TextEncoder().encode(content)
    const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() },
    })))
    expect(await (await budget.wrapFetch(transport)(endpoint, request())).text()).toBe(content)
    expect(budget.snapshot().unsettledRequests).toBe(0)
  })

  it.each([
    `data: ${JSON.stringify({ usage })}\n\n`,
    `data: ${JSON.stringify({ usage })}\n\ndata: ${JSON.stringify({ usage })}\n\ndata: [DONE]\n\n`,
    'data: malformed\n\ndata: [DONE]\n\n',
    `data: ${JSON.stringify({ usage: { ...usage, total_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
    `${completed}data: ${JSON.stringify({ usage })}\n\n`,
    `${completed}data: ${JSON.stringify({ error: 'late failure' })}\n\n`,
  ])('retains the full reservation for ambiguous or incomplete usage', async (body) => {
    const budget = open()
    await (await budget.wrapFetch(async () => sse(body))(endpoint, request())).text()
    expect(budget.snapshot()).toMatchObject({ unsettledRequests: 1, accountedUpperBoundCny: 3.293184 })
  })

  it('retains transport failures and each retry as separate reservations', async () => {
    const budget = open()
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(new Response('busy', { status: 503 }))
    const guarded = budget.wrapFetch(transport)
    await expect(guarded(endpoint, request())).rejects.toThrow('connection lost')
    await (await guarded(endpoint, request())).text()
    expect(budget.snapshot()).toMatchObject({ requests: 2, unsettledRequests: 2, accountedUpperBoundCny: 6.586368 })
  })

  it('serializes simultaneous reservations and refuses before exceeding ¥20', async () => {
    const budget = open()
    const transport = vi.fn<typeof fetch>(async () => new Response('busy', { status: 503 }))
    const guarded = budget.wrapFetch(transport)
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => guarded(endpoint, request('deepseek-v4-pro'))))
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
    expect(transport).toHaveBeenCalledTimes(2)
    expect(budget.snapshot()).toMatchObject({ requests: 2, accountedUpperBoundCny: 19.759104 })
  })

  it('preserves cumulative reservations when reopened and excludes a second runner', async () => {
    const budget = open()
    expect(() => open(budget.path)).toThrow()
    await budget.wrapFetch(async () => new Response('unknown', { status: 500 }))(endpoint, request())
    budget.close()
    const reopened = open(budget.path)
    expect(reopened.snapshot()).toMatchObject({ requests: 1, unsettledRequests: 1, accountedUpperBoundCny: 3.293184 })
  })

  it('settles complete non-streaming Vision and charges cache misses conservatively', async () => {
    const budget = open()
    const payload = { choices: [{ finish_reason: 'stop', message: { content: 'pass' } }], usage }
    const response = await budget.wrapFetch(async () => Response.json(payload))(endpoint, request('deepseek-v4-flash-vision-exp', false))
    expect(await response.json()).toEqual(payload)
    expect(budget.snapshot()).toMatchObject({ unsettledRequests: 0, accountedUpperBoundCny: 0.00048 })
  })

  it('retains usage on consumer cancellation', async () => {
    const budget = open()
    const cancel = vi.fn()
    const response = await budget.wrapFetch(async () => new Response(new ReadableStream({ cancel })))(endpoint, request())
    await response.body!.cancel('test cancellation')
    expect(cancel).toHaveBeenCalledWith('test cancellation')
    expect(budget.snapshot().unsettledRequests).toBe(1)
  })

  it('does not settle DONE before clean EOF or refund a subsequent read failure', async () => {
    const budget = open()
    let pulls = 0
    const response = await budget.wrapFetch(async () => new Response(new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(completed))
        else controller.error(new Error('late stream failure'))
      },
    })))(endpoint, request())
    await expect(response.text()).rejects.toThrow('late stream failure')
    expect(budget.snapshot()).toMatchObject({ unsettledRequests: 1, accountedUpperBoundCny: 3.293184 })
  })

  it('does not follow or refund redirects', async () => {
    const budget = open()
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 307, headers: { location: endpoint } }))
    await expect(budget.wrapFetch(transport)(endpoint, request())).rejects.toThrow('redirect rejected')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(budget.snapshot().unsettledRequests).toBe(1)
  })

  it.each(['deepseek-chat', 'unverified-model'])('refuses unknown tariffs before dispatch: %s', async (model) => {
    const budget = open()
    const transport = vi.fn<typeof fetch>()
    await expect(budget.wrapFetch(transport)(endpoint, request(model))).rejects.toThrow('no verified current tariff')
    expect(transport).not.toHaveBeenCalled()
    expect(budget.snapshot().requests).toBe(0)
  })

  it('refuses unmetered endpoints, expired pricing and malformed ledgers', async () => {
    const budget = open()
    const transport = vi.fn<typeof fetch>()
    await expect(budget.wrapFetch(transport)('https://example.com/chat/completions', request())).rejects.toThrow('unmetered')
    expect(transport).not.toHaveBeenCalled()
    budget.close()
    const expired = new ModelTestBudget(budget.path, () => TEST_MODEL_TARIFF_VALID_UNTIL)
    budgets.push(expired)
    expect(() => expired.assertModel('deepseek-v4-flash')).toThrow('expired')
    expired.close()
    writeFileSync(budget.path, '{"type":"reserve"')
    expect(() => open(budget.path)).toThrow('incomplete ledger')
  })

  it.each(['input', 'output'] as const)('persists numeric evidence and a terminal halt for a one-token %s overage', async (kind) => {
    const budget = open()
    const overage = kind === 'input'
      ? { prompt_tokens: 1_048_577, completion_tokens: 0, total_tokens: 1_048_577 }
      : { prompt_tokens: 100, completion_tokens: 16_385, total_tokens: 16_485 }
    const payload = { choices: [{ finish_reason: 'stop' }], usage: overage }
    const response = await budget.wrapFetch(async () => Response.json(payload))(endpoint, request('deepseek-v4-flash', false))
    await expect(response.text()).rejects.toThrow('exceeded verified request bound')
    const lines = readFileSync(budget.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.at(-1)).toEqual({ type: 'halt', reason: 'provider usage exceeded verified request bound; reconciliation required',
      usageBound: { requestId: lines[1].id, input: overage.prompt_tokens, output: overage.completion_tokens,
        total: overage.total_tokens, maxInput: 1_048_576, maxOutput: 16_384 } })
    budget.close()
    const reopened = open(budget.path)
    expect(() => reopened.assertModel('deepseek-v4-flash')).toThrow('reconciliation required')
    expect(reopened.snapshot().unsettledRequests).toBe(1)
    expect(reopened.snapshot().accountedUpperBoundCny).toBe(3.293184)
    reopened.close()
    for (const changed of [{ requestId: 'unknown' }, { maxOutput: 16_385 }, { total: -1 }, { output: 0, input: 0, total: 0 }, { prompt: 'never permit raw request data' }]) {
      const corrupted = [...lines.slice(0, -1), { ...lines.at(-1), usageBound: { ...lines.at(-1).usageBound, ...changed } }]
      writeFileSync(budget.path, corrupted.map((line) => JSON.stringify(line)).join('\n') + '\n')
      expect(() => inspectModelTestBudget(budget.path)).toThrow('invalid usage-bound halt evidence')
    }
  })
})
