import { createHash } from 'node:crypto'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { fetchPublicUrl } from './network-policy.js'

export const REFERENCE_FONT_MAX_STYLESHEETS = 2
export const REFERENCE_FONT_MAX_STYLESHEET_BYTES = 256 * 1024
export const REFERENCE_FONT_MAX_FILES = 24
export const REFERENCE_FONT_MAX_FILE_BYTES = 1024 * 1024
export const REFERENCE_FONT_MAX_TOTAL_FILE_BYTES = 12 * 1024 * 1024
/** Shared post-materialization boundary used by storage, preview, and Chromium. */
export const REFERENCE_RENDER_FONT_CSS_MAX_BYTES = 16 * 1024 * 1024

const GOOGLE_STYLESHEET_HOST = 'fonts.googleapis.com'
const GOOGLE_FONT_HOST = 'fonts.gstatic.com'
const WOFF2_MAGIC = Buffer.from('wOF2', 'ascii')
const GOOGLE_FONT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const GOOGLE_FONT_FETCH_ATTEMPTS = 3
const GOOGLE_FONT_FETCH_ATTEMPT_TIMEOUT_MS = 12_000
const GOOGLE_FONT_FETCH_RETRY_DELAYS_MS = [150, 500] as const
const GOOGLE_FONT_STYLESHEET_CACHE_ENTRIES = 16
const GOOGLE_FONT_FILE_CACHE_ENTRIES = 32
const GOOGLE_FONT_SUBSET_KIT_MAX_CHARS = 8_192
const RETRYABLE_GOOGLE_FONT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EPIPE', 'ETIMEDOUT',
])

export interface ReferenceFontStylesheetManifestEntry {
  /** SHA-256 and bytes of the exact server response before URL rewriting. */
  sha256: string
  bytes: number
  /** SHA-256 and bytes of the CSS after every font is embedded as a data URI. */
  materializedSha256: string
  materializedBytes: number
  /** Content identities of the font files used by this stylesheet, in source order. */
  fontSha256: string[]
}

export interface ReferenceFontFileManifestEntry {
  sha256: string
  bytes: number
}

/**
 * Path-free evidence for immutable, server-materialized reference fonts.
 * Array position carries ordering; no filesystem path is accepted or emitted.
 */
export interface ReferenceFontManifest {
  version: 1
  stylesheets: ReferenceFontStylesheetManifestEntry[]
  fonts: ReferenceFontFileManifestEntry[]
  familyNames: string[]
  cssBytes: number
  fontBytes: number
  manifestSha256: string
}

export interface MaterializedReferenceFonts {
  rewrittenHtml: string
  fontCss: string
  familyNames: string[]
  /** Null means the input did not declare a Google Fonts CSS2 stylesheet. */
  manifest: ReferenceFontManifest | null
}

/**
 * Inject already-verified private font CSS into an HTML delivery copy. The
 * workspace artifact stays immutable; preview, download, and deployment can
 * therefore share one deterministic derived representation without exposing
 * the private CSS through model context or trusting a candidate insertion
 * point. Supported Google Fonts links are removed only from this delivery
 * copy: the verified private CSS replaces their external font dependency.
 */
export function injectMaterializedReferenceFonts(
  html: string,
  fontCss: string,
  manifestSha256: string,
): string {
  if (typeof html !== 'string' || typeof fontCss !== 'string') {
    throw new Error('Reference font injection requires HTML and CSS strings')
  }
  if (!/^[0-9a-f]{64}$/iu.test(manifestSha256)) {
    throw new Error('Reference font manifest SHA-256 is invalid')
  }
  if (Buffer.byteLength(fontCss, 'utf8') > REFERENCE_RENDER_FONT_CSS_MAX_BYTES) {
    throw new Error('Reference font CSS exceeds the bounded size')
  }
  if (/<\s*\/\s*style\b/iu.test(fontCss)) {
    throw new Error('Reference font CSS contains an unsafe HTML style terminator')
  }
  if (/\bdata-anera-reference-fonts(?:\s|=|>)/iu.test(html)) {
    throw new Error('HTML contains an invalid reserved reference font evidence marker')
  }
  const deliveryHtml = removeMaterializedGoogleFontLinks(html)
  const style = `<style data-anera-reference-fonts data-manifest-sha256="${manifestSha256.toLowerCase()}">\n${fontCss}\n</style>`
  // Prefixing after a leading doctype avoids trusting a regex match inside a
  // script/style raw-text body. Browsers place a pre-<html> style in the head
  // while preserving standards mode.
  const doctype = /^\uFEFF?\s*<!doctype\b[^>]*>/iu.exec(deliveryHtml)
  const insertion = doctype?.[0].length ?? 0
  return `${deliveryHtml.slice(0, insertion)}${style}${deliveryHtml.slice(insertion)}`
}

interface HtmlLink {
  start: number
  end: number
  raw: string
  href: string
  role: 'stylesheet' | 'discard'
}

interface DownloadedStylesheet {
  source: Buffer
  css: string
  fontUrls: string[]
  familyNames: string[]
}

interface DownloadedFont {
  content: Buffer
  sha256: string
}

/**
 * Only production downloads enter these bounded process-local caches. Test
 * seams and caller-supplied fetch implementations stay isolated. A complete
 * StyleContract persists the same bytes durably; this smaller cache covers
 * transient tool retries before that durable boundary exists.
 */
const downloadedStylesheetCache = new Map<string, DownloadedStylesheet>()
const downloadedFontCache = new Map<string, DownloadedFont>()

class RetryableGoogleFontNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'RetryableGoogleFontNetworkError'
  }
}

interface Replacement {
  start: number
  end: number
  value: string
}

/**
 * Materializes Google Fonts used by reference HTML without allowing Chromium
 * to make an external request. Every declared CSS2 sheet and WOFF2 file must
 * pass the complete validation chain or the operation fails closed.
 */
export async function materializeReferenceFonts(
  html: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetchPublicUrl,
): Promise<MaterializedReferenceFonts> {
  if (typeof html !== 'string') throw new TypeError('Reference font HTML must be a string')
  if (!signal || typeof signal.aborted !== 'boolean') {
    throw new TypeError('Reference font materialization requires an AbortSignal')
  }
  throwIfAborted(signal)

  const links = findGoogleFontLinks(html)
  const stylesheetLinks = links.filter((link) => link.role === 'stylesheet')
  if (stylesheetLinks.length > REFERENCE_FONT_MAX_STYLESHEETS) {
    throw new Error(`Reference HTML declares more than ${REFERENCE_FONT_MAX_STYLESHEETS} Google Fonts stylesheets`)
  }
  if (stylesheetLinks.length === 0) {
    const discardLinks = links.filter((link) => link.role === 'discard')
    return {
      rewrittenHtml: applyReplacements(html, discardLinks.map((link) => ({
        start: link.start,
        end: link.end,
        value: '',
      }))),
      fontCss: '',
      familyNames: [],
      manifest: null,
    }
  }

  const stylesheets: DownloadedStylesheet[] = []
  for (const link of stylesheetLinks) {
    throwIfAborted(signal)
    const cached = fetchImpl === fetchPublicUrl
      ? cachedValue(downloadedStylesheetCache, link.href)
      : undefined
    if (cached) {
      stylesheets.push(cached)
      continue
    }
    const source = await downloadCheckedResource(
      link.href,
      signal,
      fetchImpl,
      'stylesheet',
      REFERENCE_FONT_MAX_STYLESHEET_BYTES,
      'Google Fonts stylesheet',
    )
    const css = decodeCss(source)
    const fontUrls = extractFontUrls(css)
    if (fontUrls.length === 0) {
      throw new Error('Google Fonts stylesheet did not declare a WOFF2 file')
    }
    const familyNames = extractFamilyNames(css)
    if (familyNames.length === 0) {
      throw new Error('Google Fonts stylesheet did not declare a font family')
    }
    const stylesheet = { source, css, fontUrls, familyNames }
    if (fetchImpl === fetchPublicUrl) {
      cacheValue(downloadedStylesheetCache, link.href, stylesheet, GOOGLE_FONT_STYLESHEET_CACHE_ENTRIES)
    }
    stylesheets.push(stylesheet)
  }

  const orderedFontUrls = unique(stylesheets.flatMap((stylesheet) => stylesheet.fontUrls))
  if (orderedFontUrls.length > REFERENCE_FONT_MAX_FILES) {
    throw new Error(`Google Fonts stylesheets declare more than ${REFERENCE_FONT_MAX_FILES} WOFF2 files`)
  }

  // Google CSS commonly expands a few requested families into several WOFF2
  // subsets. Downloading those independent immutable files concurrently keeps
  // one slow socket from consuming the entire visual-tool deadline. Waiting
  // for every outcome also lets successful siblings seed the bounded cache
  // before a transient peer failure is reported.
  const fontOutcomes = await Promise.allSettled(orderedFontUrls.map(async (url): Promise<DownloadedFont> => {
    throwIfAborted(signal)
    const cached = fetchImpl === fetchPublicUrl
      ? cachedValue(downloadedFontCache, url)
      : undefined
    if (cached) return cached
    const content = await downloadCheckedResource(
      url,
      signal,
      fetchImpl,
      'font',
      REFERENCE_FONT_MAX_FILE_BYTES,
      'Google Fonts WOFF2 file',
    )
    if (content.length > REFERENCE_FONT_MAX_FILE_BYTES) {
      throw new Error(`Google Fonts WOFF2 file exceeds the ${REFERENCE_FONT_MAX_FILE_BYTES}-byte limit`)
    }
    if (content.length < WOFF2_MAGIC.length || !content.subarray(0, WOFF2_MAGIC.length).equals(WOFF2_MAGIC)) {
      throw new Error('Google Fonts response does not have the wOF2 magic signature')
    }
    const font = { content, sha256: sha256(content) }
    if (fetchImpl === fetchPublicUrl) {
      cacheValue(downloadedFontCache, url, font, GOOGLE_FONT_FILE_CACHE_ENTRIES)
    }
    return font
  }))

  const downloadedFonts = new Map<string, DownloadedFont>()
  let fontBytes = 0
  for (let index = 0; index < fontOutcomes.length; index += 1) {
    const outcome = fontOutcomes[index]
    if (outcome.status === 'rejected') throw outcome.reason
    fontBytes += outcome.value.content.length
    if (fontBytes > REFERENCE_FONT_MAX_TOTAL_FILE_BYTES) {
      throw new Error(`Google Fonts files exceed the ${REFERENCE_FONT_MAX_TOTAL_FILE_BYTES}-byte total limit`)
    }
    downloadedFonts.set(orderedFontUrls[index], outcome.value)
  }

  const materializedCss = stylesheets.map((stylesheet) => rewriteFontUrls(stylesheet.css, downloadedFonts))
  const fontCss = materializedCss.join('\n')
  if (Buffer.byteLength(fontCss, 'utf8') > REFERENCE_RENDER_FONT_CSS_MAX_BYTES) {
    throw new Error(`Materialized reference font CSS exceeds the ${REFERENCE_RENDER_FONT_CSS_MAX_BYTES}-byte limit`)
  }
  const familyNames = unique(stylesheets.flatMap((stylesheet) => stylesheet.familyNames))
  const stylesheetManifest = stylesheets.map((stylesheet, index): ReferenceFontStylesheetManifestEntry => {
    const rewritten = Buffer.from(materializedCss[index], 'utf8')
    return {
      sha256: sha256(stylesheet.source),
      bytes: stylesheet.source.length,
      materializedSha256: sha256(rewritten),
      materializedBytes: rewritten.length,
      fontSha256: unique(stylesheet.fontUrls.map((url) => requiredFont(downloadedFonts, url).sha256)),
    }
  })
  const fontManifest = orderedFontUrls.map((url): ReferenceFontFileManifestEntry => {
    const font = requiredFont(downloadedFonts, url)
    return { sha256: font.sha256, bytes: font.content.length }
  })
  const core = {
    version: 1 as const,
    stylesheets: stylesheetManifest,
    fonts: fontManifest,
    familyNames,
    cssBytes: stylesheets.reduce((total, stylesheet) => total + stylesheet.source.length, 0),
    fontBytes,
  }
  const manifest: ReferenceFontManifest = {
    ...core,
    manifestSha256: sha256(Buffer.from(JSON.stringify(core), 'utf8')),
  }

  let stylesheetIndex = 0
  const replacements: Replacement[] = links.map((link) => {
    if (link.role === 'discard') return { start: link.start, end: link.end, value: '' }
    const css = materializedCss[stylesheetIndex]
    const evidence = stylesheetManifest[stylesheetIndex]
    const value = `<style data-anera-reference-fonts="${stylesheetIndex + 1}" data-source-sha256="${evidence.sha256}">\n${css}\n</style>`
    stylesheetIndex += 1
    return { start: link.start, end: link.end, value }
  })

  return {
    rewrittenHtml: applyReplacements(html, replacements),
    fontCss,
    familyNames,
    manifest,
  }
}

function findGoogleFontLinks(html: string): HtmlLink[] {
  const links: HtmlLink[] = []
  const linkPattern = /<link\b[^>]*>/giu
  for (const match of html.matchAll(linkPattern)) {
    const raw = match[0]
    const start = match.index
    const attributes = parseHtmlAttributes(raw)
    attributes.set('href', decodeHtmlAttribute(attributes.get('href') ?? ''))
    const fontLink = classifyGoogleFontLink(attributes)
    if (fontLink) links.push({ start, end: start + raw.length, raw, ...fontLink })
  }

  const withoutLinks = applyReplacements(html, links.map((link) => ({
    start: link.start,
    end: link.end,
    value: '',
  })))
  if (/fonts\.(?:googleapis|gstatic)\.com/iu.test(withoutLinks)) {
    throw new Error('Reference HTML contains an unsupported external Google Fonts declaration')
  }
  return links
}

/** Classify decoded link attributes identically for source and delivery HTML. */
function classifyGoogleFontLink(attributes: ReadonlyMap<string, string>): Pick<HtmlLink, 'href' | 'role'> | undefined {
  const href = attributes.get('href')
  if (!href) return undefined
  const target = parseAbsoluteUrl(href)
  const hostname = target?.hostname.toLowerCase()
  const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/u).filter(Boolean)
  const isStylesheet = rel.includes('stylesheet')
  const isConnectionHint = rel.includes('preconnect') || rel.includes('dns-prefetch')

  if (hostname !== GOOGLE_STYLESHEET_HOST && hostname !== GOOGLE_FONT_HOST) {
    if (/fonts\.(?:googleapis|gstatic)\.com/iu.test(href)) {
      throw new Error('Google Fonts link URL is malformed or uses an ambiguous host')
    }
    return undefined
  }
  if (isConnectionHint) return { href, role: 'discard' }
  if (hostname !== GOOGLE_STYLESHEET_HOST || !isStylesheet) {
    throw new Error('Reference HTML contains an unsupported Google Fonts link')
  }
  validateGoogleStylesheetUrl(target)
  return { href: target.toString(), role: 'stylesheet' }
}

function removeMaterializedGoogleFontLinks(html: string): string {
  const pending: DefaultTreeAdapterMap['node'][] = [parse(html, { sourceCodeLocationInfo: true })]
  const replacements: Replacement[] = []
  while (pending.length) {
    const node = pending.pop()!
    if ('tagName' in node && node.tagName === 'link' && node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      // parse5 distinguishes real nodes from raw-text, comments and attribute
      // strings, and decodes attributes using browser-compatible semantics.
      const attributes = new Map(node.attrs.map((attribute) => [attribute.name, attribute.value]))
      if (classifyGoogleFontLink(attributes)) {
        const location = node.sourceCodeLocation?.startTag
        if (!location) throw new Error('Reference font link has no source location')
        // parse5 retains the first duplicate attribute. Keep the existing
        // font-link rejection for ambiguous href/rel instead of hiding it.
        parseHtmlAttributes(html.slice(location.startOffset, location.endOffset))
        replacements.push({ start: location.startOffset, end: location.endOffset, value: '' })
      }
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) pending.push(child)
    }
    if ('content' in node) pending.push(node.content)
  }
  return applyReplacements(html, replacements)
}

function parseHtmlAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  const body = tag.replace(/^<link\b/iu, '').replace(/>$/u, '')
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu
  for (const match of body.matchAll(pattern)) {
    const name = match[1].toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    if (attributes.has(name) && (name === 'href' || name === 'rel')) {
      throw new Error(`Reference font link contains a duplicate ${name} attribute`)
    }
    attributes.set(name, value)
  }
  return attributes
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/giu, (entity) => {
    const normalized = entity.toLowerCase()
    if (normalized === '&amp;') return '&'
    if (normalized === '&quot;') return '"'
    if (normalized === '&apos;') return "'"
    if (normalized === '&lt;') return '<'
    if (normalized === '&gt;') return '>'
    const hexadecimal = normalized.startsWith('&#x')
    const digits = entity.slice(hexadecimal ? 3 : 2, -1)
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10)
    try {
      return Number.isInteger(codePoint) && codePoint > 0 ? String.fromCodePoint(codePoint) : entity
    } catch {
      return entity
    }
  })
}

function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function validateGoogleStylesheetUrl(url: URL | null): asserts url is URL {
  if (
    !url
    || url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== GOOGLE_STYLESHEET_HOST
    || url.port
    || url.pathname !== '/css2'
    || url.username
    || url.password
  ) {
    throw new Error('Google Fonts stylesheet must use https://fonts.googleapis.com/css2')
  }
}

function allowedGoogleFontPath(url: URL): boolean {
  if (url.hash) return false
  if (url.pathname.toLowerCase().endsWith('.woff2')) return true
  // CSS2 text= subsets use this endpoint, not a .woff2 pathname. Admit
  // only its bounded, opaque resource identity; MIME, magic, host and all
  // transfer limits still apply exactly as for ordinary WOFF2 files.
  if (url.pathname !== '/l/font') return false
  const params = url.searchParams
  const keys = [...params.keys()]
  if (keys.length !== 3 || new Set(keys).size !== 3 || keys.some((key) => !['kit', 'skey', 'v'].includes(key))) return false
  const kit = params.get('kit') ?? ''
  return kit.length > 0 && kit.length <= GOOGLE_FONT_SUBSET_KIT_MAX_CHARS
    && /^[a-z0-9_-]+$/iu.test(kit)
    && /^[a-f0-9]{16}$/iu.test(params.get('skey') ?? '')
    && /^v\d{1,6}$/u.test(params.get('v') ?? '')
}

async function downloadCheckedResource(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  kind: 'stylesheet' | 'font',
  limit: number,
  label: string,
): Promise<Buffer> {
  let lastError: unknown
  for (let attempt = 0; attempt < GOOGLE_FONT_FETCH_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal)
    const attemptScope = fetchImpl === fetchPublicUrl
      ? boundedAttemptSignal(signal, label)
      : { signal, dispose: () => undefined }
    try {
      const response = await fetchChecked(url, attemptScope.signal, fetchImpl, kind)
      return await readBoundedResponse(response, limit, attemptScope.signal, label)
    } catch (error) {
      if (signal.aborted) throw abortReason(signal, error)
      lastError = error
      if (!isRetryableGoogleFontNetworkError(error) || attempt === GOOGLE_FONT_FETCH_ATTEMPTS - 1) break
    } finally {
      attemptScope.dispose()
    }
    await waitForRetry(GOOGLE_FONT_FETCH_RETRY_DELAYS_MS[attempt] ?? 0, signal)
  }
  if (isRetryableGoogleFontNetworkError(lastError)) {
    throw new Error(
      `${errorMessage(lastError)} after ${GOOGLE_FONT_FETCH_ATTEMPTS} attempts`,
      { cause: lastError },
    )
  }
  throw lastError
}

function boundedAttemptSignal(
  parent: AbortSignal,
  label: string,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort(abortReason(parent))
  parent.addEventListener('abort', onParentAbort, { once: true })
  if (parent.aborted) onParentAbort()
  const timeout = setTimeout(() => {
    controller.abort(new DOMException(
      `${label} request attempt exceeded ${GOOGLE_FONT_FETCH_ATTEMPT_TIMEOUT_MS}ms`,
      'TimeoutError',
    ))
  }, GOOGLE_FONT_FETCH_ATTEMPT_TIMEOUT_MS)
  timeout.unref()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      parent.removeEventListener('abort', onParentAbort)
    },
  }
}

async function waitForRetry(durationMs: number, signal: AbortSignal): Promise<void> {
  if (durationMs <= 0) return
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(resolve), durationMs)
    const onAbort = (): void => finish(() => reject(abortReason(signal)))
    const finish = (callback: () => void): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

async function fetchChecked(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  kind: 'stylesheet' | 'font',
): Promise<Response> {
  throwIfAborted(signal)
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal,
      headers: kind === 'stylesheet'
        ? {
            accept: 'text/css,*/*;q=0.1',
            'user-agent': GOOGLE_FONT_USER_AGENT,
          }
        : {
            accept: 'font/woff2,application/font-woff2;q=0.9,*/*;q=0.1',
            'user-agent': GOOGLE_FONT_USER_AGENT,
          },
    })
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortReason(signal, error)
    throw new RetryableGoogleFontNetworkError(
      `Failed to fetch Google Fonts ${kind}: ${errorMessage(error)}`,
      error,
    )
  }
  throwIfAborted(signal)

  if (response.status !== 200) {
    await cancelResponse(response)
    const message = `Google Fonts ${kind} returned HTTP ${response.status}; expected 200`
    if (RETRYABLE_GOOGLE_FONT_STATUSES.has(response.status)) {
      throw new RetryableGoogleFontNetworkError(message)
    }
    throw new Error(message)
  }
  const finalUrl = parseAbsoluteUrl(response.url)
  const expectedHost = kind === 'stylesheet' ? GOOGLE_STYLESHEET_HOST : GOOGLE_FONT_HOST
  if (
    !finalUrl
    || finalUrl.protocol !== 'https:'
    || finalUrl.hostname.toLowerCase() !== expectedHost
    || finalUrl.port
    || finalUrl.username
    || finalUrl.password
  ) {
    await cancelResponse(response)
    throw new Error(`Google Fonts ${kind} redirected to a disallowed final host`)
  }
  if (kind === 'font' && !allowedGoogleFontPath(finalUrl)) {
    await cancelResponse(response)
    throw new Error('Google Fonts font redirected to a disallowed final path')
  }

  const mime = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  const validMime = kind === 'stylesheet'
    ? mime === 'text/css'
    : mime === 'font/woff2' || mime === 'application/font-woff2' || mime === 'application/x-font-woff2'
  if (!validMime) {
    await cancelResponse(response)
    throw new Error(`Google Fonts ${kind} returned disallowed MIME type ${mime || '(missing)'}`)
  }
  return response
}

async function readBoundedResponse(
  response: Response,
  limit: number,
  signal: AbortSignal,
  label: string,
): Promise<Buffer> {
  const advertisedLength = response.headers.get('content-length')
  if (advertisedLength !== null) {
    if (!/^\d+$/u.test(advertisedLength.trim())) {
      await cancelResponse(response)
      throw new Error(`${label} returned an invalid Content-Length`)
    }
    if (Number(advertisedLength) > limit) {
      await cancelResponse(response)
      throw new Error(`${label} exceeds the ${limit}-byte limit`)
    }
  }
  if (!response.body) throw new Error(`${label} response has no body`)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      throwIfAborted(signal)
      const result = await readWithAbort(reader, signal)
      if (result.done) break
      const chunk = Buffer.from(result.value)
      bytes += chunk.length
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label} exceeds the ${limit}-byte limit`)
      }
      chunks.push(chunk)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (signal.aborted || isAbortError(error)) throw abortReason(signal, error)
    if (isRetryableNodeNetworkError(error)) {
      throw new RetryableGoogleFontNetworkError(`Failed to read ${label}: ${errorMessage(error)}`, error)
    }
    throw error
  } finally {
    reader.releaseLock()
  }
  throwIfAborted(signal)
  return Buffer.concat(chunks, bytes)
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw abortReason(signal)
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined)
      finish(() => reject(abortReason(signal)))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

function decodeCss(source: Buffer): string {
  let css: string
  try {
    css = new TextDecoder('utf-8', { fatal: true }).decode(source)
  } catch (error) {
    throw new Error('Google Fonts stylesheet is not valid UTF-8', { cause: error })
  }
  if (/<\/style/iu.test(css)) {
    throw new Error('Google Fonts stylesheet contains an unsafe HTML style terminator')
  }
  if (/@import\b/iu.test(css)) {
    throw new Error('Google Fonts stylesheet contains an unsupported @import rule')
  }
  if (/\blocal\s*\(/iu.test(css)) {
    throw new Error('Google Fonts stylesheet contains a nondeterministic local font source')
  }
  // CSS escapes can disguise `url`, a scheme, or an HTML terminator from the
  // deliberately small parser below. Google Fonts CSS2 responses do not need
  // escapes, so rejecting them is the safe deterministic boundary.
  if (css.includes('\\')) {
    throw new Error('Google Fonts stylesheet contains an unsupported CSS escape')
  }
  return css
}

function extractFontUrls(css: string): string[] {
  const urlTokens = css.match(/\burl\s*\(/giu)?.length ?? 0
  const values: string[] = []
  const pattern = /\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]+))\s*\)/giu
  for (const match of css.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? ''
    const url = parseAbsoluteUrl(raw)
    if (
      !url
      || url.protocol !== 'https:'
      || url.hostname.toLowerCase() !== GOOGLE_FONT_HOST
      || url.port
      || !allowedGoogleFontPath(url)
      || url.username
      || url.password
    ) {
      throw new Error('Google Fonts stylesheet contains a disallowed font URL')
    }
    values.push(url.toString())
  }
  if (values.length !== urlTokens) {
    throw new Error('Google Fonts stylesheet contains an unparseable URL token')
  }
  const withoutAllowedUrls = css.replace(pattern, '')
  if (/(?:https?:)?\/\//iu.test(withoutAllowedUrls)) {
    throw new Error('Google Fonts stylesheet contains an external resource outside an allowed WOFF2 URL')
  }
  return values
}

function extractFamilyNames(css: string): string[] {
  const familyNames: string[] = []
  const pattern = /\bfont-family\s*:\s*(?:"([^"]+)"|'([^']+)'|([^;{}]+))/giu
  for (const match of css.matchAll(pattern)) {
    const name = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!name || name.length > 128 || !/^[\p{L}\p{N} _-]+$/u.test(name)) {
      throw new Error('Google Fonts stylesheet declares an invalid font family name')
    }
    familyNames.push(name)
  }
  return unique(familyNames)
}

function rewriteFontUrls(css: string, fonts: ReadonlyMap<string, DownloadedFont>): string {
  return css.replace(
    /\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]+))\s*\)/giu,
    (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
      const raw = doubleQuoted ?? singleQuoted ?? unquoted ?? ''
      const url = new URL(raw).toString()
      const font = requiredFont(fonts, url)
      return `url("data:font/woff2;base64,${font.content.toString('base64')}")`
    },
  )
}

function requiredFont(fonts: ReadonlyMap<string, DownloadedFont>, url: string): DownloadedFont {
  const font = fonts.get(url)
  if (!font) throw new Error('Google Fonts materialization is missing a validated WOFF2 file')
  return font
}

function applyReplacements(value: string, replacements: readonly Replacement[]): string {
  if (replacements.length === 0) return value
  let cursor = 0
  let result = ''
  for (const replacement of [...replacements].sort((left, right) => left.start - right.start)) {
    if (replacement.start < cursor || replacement.end < replacement.start || replacement.end > value.length) {
      throw new Error('Reference font HTML replacements overlap or are out of bounds')
    }
    result += value.slice(cursor, replacement.start)
    result += replacement.value
    cursor = replacement.end
  }
  return result + value.slice(cursor)
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal, fallback?: unknown): unknown {
  if (signal.reason !== undefined) return signal.reason
  if (isAbortError(fallback)) return fallback
  return new DOMException('The operation was aborted', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRetryableGoogleFontNetworkError(error: unknown): boolean {
  return error instanceof RetryableGoogleFontNetworkError
    || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    || isRetryableNodeNetworkError(error)
}

function isRetryableNodeNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  if (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) return true
  return /(?:socket hang up|fetch failed|premature close|other side closed|network connection was lost|terminated)/iu.test(error.message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function cachedValue<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key)
  if (value === undefined) return undefined
  cache.delete(key)
  cache.set(key, value)
  return value
}

function cacheValue<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}
