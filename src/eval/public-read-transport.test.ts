import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ModelTestBudget } from './model-test-budget.js'
import { publicReadTransport } from './public-read-transport.js'

function setup(publicFetch: typeof fetch = vi.fn(async () => new Response('public'))) {
  const localFetch = vi.fn<typeof fetch>(async () => new Response('Anera'))
  return { publicFetch, localFetch, fetch: publicReadTransport({ publicFetch, localFetch,
    localBaseUrl: () => 'http://127.0.0.1:12345' }) }
}

describe('public-read canary transport isolation (no network)', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('rejects %s before dispatch without exposing request secrets', async (method) => {
    const transport = setup()
    const request = new Request('https://provider.example/scrape?key=private-query', {
      method, headers: { authorization: 'Bearer private-header' }, body: 'private-body',
    })
    await expect(transport.fetch(request)).rejects.toThrow(
      'Unpriced tool-provider route unavailable in this canary; use an available public-read capability')
    expect(transport.publicFetch).not.toHaveBeenCalled()
    expect(transport.localFetch).not.toHaveBeenCalled()
  })

  it('isolates rejection from concurrent public reads, shared cancellation and model accounting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anera-transport-test-'))
    const budget = new ModelTestBudget(join(root, 'ledger.jsonl'), () => Date.parse('2026-09-09T10:00:00+08:00'))
    try {
      const before = budget.snapshot()
      const controller = new AbortController()
      let complete!: (response: Response) => void
      const publicFetch = vi.fn<typeof fetch>(() => new Promise((done) => { complete = done }))
      const transport = setup(publicFetch)
      const reading = transport.fetch('https://docs.example/article', { signal: controller.signal })
      await expect(transport.fetch('https://provider.example/search', {
        method: 'POST', signal: controller.signal,
      })).rejects.toThrow('Unpriced tool-provider route unavailable')
      complete(new Response('independent evidence'))
      expect(await (await reading).text()).toBe('independent evidence')
      expect(controller.signal.aborted).toBe(false)
      expect(budget.snapshot()).toEqual(before)
      expect(publicFetch).toHaveBeenCalledTimes(1)
    } finally {
      budget.close()
      await rm(root, { recursive: true })
    }
  })

  it('exempts only the exact owned application root GET, never other local requests', async () => {
    const transport = setup()
    expect(await (await transport.fetch('http://127.0.0.1:12345/')).text()).toBe('Anera')
    for (const url of ['http://127.0.0.1:12345/api/sessions', 'http://127.0.0.1:12345/?x=1',
      'http://127.0.0.1:5174/']) await transport.fetch(url)
    await transport.fetch('http://127.0.0.1:12345/', { method: 'HEAD' })
    await expect(transport.fetch('http://127.0.0.1:12345/', { method: 'POST' })).rejects.toThrow('unavailable')
    expect(transport.localFetch).toHaveBeenCalledTimes(1)
    expect(transport.publicFetch).toHaveBeenCalledTimes(4)
  })

  it('preserves real cancellation without dispatch', async () => {
    const transport = setup()
    const reason = new Error('user cancelled')
    await expect(transport.fetch('https://docs.example/article', {
      signal: AbortSignal.abort(reason),
    })).rejects.toBe(reason)
    expect(transport.publicFetch).not.toHaveBeenCalled()
  })
})
