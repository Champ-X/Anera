import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction, type Socket } from 'node:net'
import { Readable } from 'node:stream'

const BLOCKED_ADDRESSES = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv4')

for (const [network, prefix] of [
  ['::', 96],
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv6')

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_SAFE_REDIRECTS = 5

export type PublicAddressResolver = (hostname: string) => Promise<readonly LookupAddress[]>
export type PublicAddressPredicate = (address: string) => boolean

export interface ResolvedPublicUrl {
  url: URL
  hostname: string
  addresses: readonly LookupAddress[]
}

interface PublicFetchDependencies {
  resolveAddresses?: PublicAddressResolver
  /** Test seam for loopback integration tests; production always uses isPublicIp. */
  isAddressAllowed?: PublicAddressPredicate
  /** Trusted process-level outbound proxy configuration; false disables it. */
  proxyEnv?: NodeJS.ProcessEnv | false
}

function normalizedIp(address: string): string {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  const dottedMapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dottedMapped) return dottedMapped[1]
  const hexMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hexMapped) return normalized
  const high = Number.parseInt(hexMapped[1], 16)
  const low = Number.parseInt(hexMapped[2], 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

export function isPrivateIp(address: string): boolean {
  const normalized = normalizedIp(address)
  const family = isIP(normalized)
  if (family === 0) return false
  return BLOCKED_ADDRESSES.check(normalized, family === 4 ? 'ipv4' : 'ipv6')
}

export function isPublicIp(address: string): boolean {
  return isIP(normalizedIp(address)) !== 0 && !isPrivateIp(address)
}

async function resolveSystemAddresses(hostname: string): Promise<readonly LookupAddress[]> {
  return await lookup(hostname, { all: true, order: 'verbatim' })
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '').split('%')[0]
}

export async function resolvePublicUrl(
  rawUrl: string | URL,
  resolveAddresses: PublicAddressResolver = resolveSystemAddresses,
  isAddressAllowed: PublicAddressPredicate = isPublicIp,
): Promise<ResolvedPublicUrl> {
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are allowed')
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed')
  const hostname = normalizedHostname(url.hostname)
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('Local network URLs are not allowed')
  }
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : [...await resolveAddresses(hostname)]
  if (addresses.length === 0) throw new Error('URL hostname did not resolve to an address')
  if (addresses.some(({ address, family }) => (
    (family !== 4 && family !== 6)
    || isIP(normalizedIp(address)) !== family
    || !isAddressAllowed(address)
  ))) throw new Error('Private network URLs are not allowed')
  return { url, hostname, addresses }
}

export async function validatePublicUrl(rawUrl: string): Promise<URL> {
  return (await resolvePublicUrl(rawUrl)).url
}

function addressError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

/** A socket lookup that can return only the addresses admitted by the prior policy resolution. */
export function createPinnedLookup(resolved: ResolvedPublicUrl): LookupFunction {
  const expectedHostname = normalizedHostname(resolved.hostname)
  return (rawHostname, options, callback) => {
    queueMicrotask(() => {
      if (normalizedHostname(rawHostname) !== expectedHostname) {
        callback(addressError('ENOTFOUND', 'Pinned DNS lookup was requested for a different hostname'), '', 0)
        return
      }
      const requestedFamily = typeof options.family === 'number' ? options.family : 0
      const eligible = resolved.addresses.filter(({ family }) => requestedFamily === 0 || family === requestedFamily)
      if (eligible.length === 0) {
        callback(addressError('EAI_ADDRFAMILY', 'No admitted address matches the requested family'), '', 0)
        return
      }
      if (options.all) callback(null, eligible.map((entry) => ({ ...entry })))
      else callback(null, eligible[0].address, eligible[0].family)
    })
  }
}

function sameIp(left: string, right: string): boolean {
  const normalizedLeft = normalizedIp(left)
  const normalizedRight = normalizedIp(right)
  const family = isIP(normalizedLeft)
  if (family === 0 || isIP(normalizedRight) !== family) return false
  const exact = new BlockList()
  exact.addAddress(normalizedLeft, family === 4 ? 'ipv4' : 'ipv6')
  return exact.check(normalizedRight, family === 4 ? 'ipv4' : 'ipv6')
}

function verifyConnectedAddress(
  socket: Socket,
  resolved: ResolvedPublicUrl,
  isAddressAllowed: PublicAddressPredicate,
): void {
  const remoteAddress = socket.remoteAddress
  if (
    !remoteAddress
    || !isAddressAllowed(remoteAddress)
    || !resolved.addresses.some(({ address }) => sameIp(address, remoteAddress))
  ) {
    socket.destroy(addressError('EACCES', 'Connected socket address did not match the admitted public DNS result'))
  }
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers()
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    headers.append(message.rawHeaders[index], message.rawHeaders[index + 1])
  }
  return headers
}

function responseFromMessage(message: IncomingMessage, url: URL, redirected: boolean, method: string): Response {
  const status = message.statusCode ?? 500
  const bodyForbidden = method === 'HEAD' || [101, 103, 204, 205, 304].includes(status)
  const body = bodyForbidden ? null : Readable.toWeb(message) as ReadableStream<Uint8Array>
  const response = new Response(body, {
    status,
    statusText: message.statusMessage,
    headers: responseHeaders(message),
  })
  Object.defineProperties(response, {
    url: { configurable: true, enumerable: true, value: url.toString() },
    redirected: { configurable: true, enumerable: true, value: redirected },
  })
  return response
}

export function pinnedRequestOptions(
  request: Request,
  resolved: ResolvedPublicUrl,
  headers: Headers,
): RequestOptions & {
  servername?: string
  autoSelectFamily?: boolean
  autoSelectFamilyAttemptTimeout?: number
} {
  const options: RequestOptions & {
    servername?: string
    autoSelectFamily?: boolean
    autoSelectFamilyAttemptTimeout?: number
  } = {
    protocol: resolved.url.protocol,
    hostname: resolved.hostname,
    port: resolved.url.port || undefined,
    path: `${resolved.url.pathname}${resolved.url.search}`,
    method: request.method,
    headers: Object.fromEntries(headers.entries()),
    lookup: createPinnedLookup(resolved),
    // Node's default single-address path can stall for the entire OS connect
    // timeout when DNS lists an unreachable IPv6 address before a healthy
    // IPv4 address. Happy Eyeballs remains SSRF-safe here: the custom lookup
    // can return only the already resolved and policy-admitted addresses, and
    // verifyConnectedAddress rechecks the winning socket against that set.
    autoSelectFamily: resolved.addresses.some(({ family }) => family === 4)
      && resolved.addresses.some(({ family }) => family === 6),
    autoSelectFamilyAttemptTimeout: 250,
    // Do not let a later request reuse a socket admitted under an earlier DNS
    // answer. A new connection consumes only this request's pinned set.
    agent: false,
    signal: request.signal,
  }
  if (resolved.url.protocol === 'https:' && isIP(resolved.hostname) === 0) {
    // Connecting to a pinned IP must not change the TLS identity.
    options.servername = resolved.hostname
  }
  return options
}

export function pinnedHttpsProxyRequestOptions(
  request: Request,
  resolved: ResolvedPublicUrl,
  headers: Headers,
  proxyEnvironment: NodeJS.ProcessEnv,
): ReturnType<typeof pinnedRequestOptions> {
  if (resolved.url.protocol !== 'https:') {
    throw new TypeError('Pinned proxy requests are supported only for HTTPS URLs')
  }
  const options = pinnedRequestOptions(request, resolved, headers)
  // A CONNECT proxy must receive a concrete address from the DNS result that
  // was already admitted by policy. Keep the original Host and TLS SNI so the
  // destination still has to prove the identity the caller requested.
  const pinnedAddress = resolved.addresses.find(({ family }) => family === 4)
    ?? resolved.addresses[0]
  options.hostname = normalizedIp(pinnedAddress.address)
  options.headers = {
    ...options.headers,
    host: resolved.url.host,
  }
  delete options.lookup
  options.autoSelectFamily = false
  options.agent = new HttpsAgent({ proxyEnv: proxyEnvironment } as never)
  return options
}

async function sendPinnedRequest(
  request: Request,
  resolved: ResolvedPublicUrl,
  body: Buffer | undefined,
  isAddressAllowed: PublicAddressPredicate,
  redirected: boolean,
  proxyEnvironment?: NodeJS.ProcessEnv,
): Promise<Response> {
  const headers = new Headers(request.headers)
  // Host is always derived from the admitted URL; callers cannot decouple
  // HTTP routing from the hostname whose DNS and TLS identity were checked.
  headers.delete('host')
  if (body && !headers.has('content-length')) headers.set('content-length', String(body.length))
  return await new Promise<Response>((resolve, reject) => {
    const factory = resolved.url.protocol === 'https:' ? httpsRequest : httpRequest
    const hasHttpsProxy = Boolean(
      resolved.url.protocol === 'https:'
      && proxyEnvironment
      && (proxyEnvironment.HTTPS_PROXY || proxyEnvironment.https_proxy
        || proxyEnvironment.HTTP_PROXY || proxyEnvironment.http_proxy
        || proxyEnvironment.ALL_PROXY || proxyEnvironment.all_proxy),
    )
    const requestOptions = hasHttpsProxy && proxyEnvironment
      ? pinnedHttpsProxyRequestOptions(request, resolved, headers, proxyEnvironment)
      : pinnedRequestOptions(request, resolved, headers)
    let nodeRequest: ClientRequest
    try {
      nodeRequest = factory(requestOptions, (message) => {
        resolve(responseFromMessage(message, resolved.url, redirected, request.method))
      })
    } catch (error) {
      reject(error)
      return
    }
    if (!hasHttpsProxy) {
      nodeRequest.once('socket', (socket) => {
        if (socket.connecting) socket.once('connect', () => verifyConnectedAddress(socket, resolved, isAddressAllowed))
        else verifyConnectedAddress(socket, resolved, isAddressAllowed)
      })
    }
    nodeRequest.once('error', reject)
    if (body) nodeRequest.end(body)
    else nodeRequest.end()
  })
}

function redirectedRequest(previous: Request, location: string, status: number): Request {
  const url = new URL(location, previous.url)
  const headers = new Headers(previous.headers)
  const crossOrigin = new URL(previous.url).origin !== url.origin
  if (crossOrigin) {
    for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name)
  }
  const rewriteToGet = (status === 303 && previous.method !== 'HEAD')
    || ((status === 301 || status === 302) && previous.method === 'POST')
  return new Request(url, {
    method: rewriteToGet ? 'GET' : previous.method,
    headers,
    body: rewriteToGet || ['GET', 'HEAD'].includes(previous.method) ? undefined : previous.body,
    redirect: previous.redirect,
    signal: previous.signal,
    ...(previous.body && !rewriteToGet && !['GET', 'HEAD'].includes(previous.method) ? { duplex: 'half' } : {}),
  } as RequestInit)
}

export function createPublicFetch(dependencies: PublicFetchDependencies = {}): typeof fetch {
  const resolveAddresses = dependencies.resolveAddresses ?? resolveSystemAddresses
  const isAddressAllowed = dependencies.isAddressAllowed ?? isPublicIp
  const customPolicy = dependencies.resolveAddresses !== undefined || dependencies.isAddressAllowed !== undefined
  const proxyEnvironment = dependencies.proxyEnv === false
    ? undefined
    : dependencies.proxyEnv ?? (customPolicy ? undefined : process.env)
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let request = new Request(input, init)
    let redirected = false
    for (let redirectCount = 0; redirectCount <= MAX_SAFE_REDIRECTS; redirectCount += 1) {
      const resolved = await resolvePublicUrl(request.url, resolveAddresses, isAddressAllowed)
      const body = request.body && !['GET', 'HEAD'].includes(request.method)
        ? Buffer.from(await request.clone().arrayBuffer())
        : undefined
      const response = await sendPinnedRequest(
        request,
        resolved,
        body,
        isAddressAllowed,
        redirected,
        proxyEnvironment,
      )
      if (!REDIRECT_STATUSES.has(response.status)) return response
      if (request.redirect === 'manual') return response
      if (request.redirect === 'error') {
        await response.body?.cancel().catch(() => undefined)
        throw new TypeError('Redirect encountered while redirect mode is error')
      }
      const location = response.headers.get('location')
      if (!location) return response
      if (redirectCount === MAX_SAFE_REDIRECTS) {
        await response.body?.cancel().catch(() => undefined)
        throw new TypeError(`External request exceeded ${MAX_SAFE_REDIRECTS} safe redirects`)
      }
      await response.body?.cancel().catch(() => undefined)
      request = redirectedRequest(request, location, response.status)
      redirected = true
    }
    throw new TypeError(`External request exceeded ${MAX_SAFE_REDIRECTS} safe redirects`)
  }
}

export const fetchPublicUrl: typeof fetch = createPublicFetch()

export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
