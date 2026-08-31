import type { LookupOptions } from 'node:dns'
import { createServer } from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPinnedLookup,
  createPublicFetch,
  isPrivateIp,
  pinnedRequestOptions,
  validatePublicUrl,
  type ResolvedPublicUrl,
} from './network-policy.js'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('network policy', () => {
  it.each([
    '0.0.0.0',
    '10.2.3.4',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.0.0.9',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'fe90::1',
    'fea0::1',
    'febf::1',
    'ff02::1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '100::1',
    '2001:db8::1',
    '2002:7f00:1::1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
  ])('classifies %s as non-public', (address) => {
    expect(isPrivateIp(address)).toBe(true)
  })

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '2001:4860:4860::8888', '2606:2800:220:1:248:1893:25c8:1946'])('keeps %s public', (address) => {
    expect(isPrivateIp(address)).toBe(false)
  })

  it('rejects direct mapped loopback URLs before fetch', async () => {
    await expect(validatePublicUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/Private network/)
  })

  it('pins both address families without invoking DNS again at socket lookup time', async () => {
    const resolved: ResolvedPublicUrl = {
      url: new URL('https://public.example/resource'),
      hostname: 'public.example',
      addresses: [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
    }
    const pinned = createPinnedLookup(resolved)

    await expect(callLookup(pinned, 'public.example', { all: true })).resolves.toEqual(resolved.addresses)
    await expect(callLookup(pinned, 'public.example', { family: 6, all: true })).resolves.toEqual([resolved.addresses[1]])
    await expect(callLookup(pinned, 'rebound.example', {})).rejects.toMatchObject({ code: 'ENOTFOUND' })
  })

  it('keeps the original hostname for HTTP Host routing and HTTPS SNI while connecting by pinned IP', async () => {
    const resolved: ResolvedPublicUrl = {
      url: new URL('https://public.example:8443/resource?q=1'),
      hostname: 'public.example',
      addresses: [{ address: '93.184.216.34', family: 4 }],
    }
    const headers = new Headers({ host: 'attacker.invalid', accept: 'application/json' })
    headers.delete('host')
    const options = pinnedRequestOptions(new Request(resolved.url), resolved, headers)

    expect(options).toMatchObject({
      hostname: 'public.example',
      servername: 'public.example',
      port: '8443',
      path: '/resource?q=1',
    })
    expect(options.headers).not.toHaveProperty('host')
  })

  it('uses one admitted DNS answer for the real connection and preserves the URL Host header', async () => {
    const hosts: string[] = []
    const server = createServer((request, response) => {
      hosts.push(request.headers.host ?? '')
      response.end('pinned')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    let resolution = 0
    const resolveAddresses = vi.fn(async () => {
      resolution += 1
      return [{ address: resolution === 1 ? '127.0.0.1' : '127.0.0.2', family: 4 as const }]
    })
    const pinnedFetch = createPublicFetch({
      resolveAddresses,
      isAddressAllowed: (address) => address === '127.0.0.1',
    })

    const response = await pinnedFetch(`http://public.example:${port}/resource`)
    expect(await response.text()).toBe('pinned')
    expect(resolveAddresses).toHaveBeenCalledOnce()
    expect(hosts).toEqual([`public.example:${port}`])
    expect(response.url).toBe(`http://public.example:${port}/resource`)
  })

  it('re-resolves and revalidates every redirect hop before making its connection', async () => {
    const hosts: string[] = []
    let port = 0
    const server = createServer((request, response) => {
      hosts.push(request.headers.host ?? '')
      if (request.url === '/start') {
        response.writeHead(302, { location: `http://second.example:${port}/final` })
        response.end()
        return
      }
      response.end('redirected safely')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
    const resolveAddresses = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }])
    const pinnedFetch = createPublicFetch({ resolveAddresses, isAddressAllowed: (address) => address === '127.0.0.1' })

    const response = await pinnedFetch(`http://first.example:${port}/start`)
    expect(await response.text()).toBe('redirected safely')
    expect(resolveAddresses.mock.calls.map(([hostname]) => hostname)).toEqual(['first.example', 'second.example'])
    expect(hosts).toEqual([`first.example:${port}`, `second.example:${port}`])
    expect(response.redirected).toBe(true)
    expect(response.url).toBe(`http://second.example:${port}/final`)
  })

  it('blocks a redirect hop whose fresh DNS answer is no longer admitted', async () => {
    let requests = 0
    let port = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.writeHead(302, { location: `http://rebound.example:${port}/private` })
      response.end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
    const pinnedFetch = createPublicFetch({
      resolveAddresses: async (hostname) => [{ address: hostname === 'first.example' ? '127.0.0.1' : '127.0.0.2', family: 4 }],
      isAddressAllowed: (address) => address === '127.0.0.1',
    })

    await expect(pinnedFetch(`http://first.example:${port}/start`)).rejects.toThrow(/Private network/)
    expect(requests).toBe(1)
  })
})

async function callLookup(lookup: LookupFunction, hostname: string, options: LookupOptions): Promise<unknown> {
  return await new Promise((resolve, reject) => lookup(hostname, options, (error, address, family) => {
    if (error) reject(error)
    else resolve(options.all ? address : { address, family })
  }))
}
