import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  materializeReferenceFonts,
  REFERENCE_FONT_MAX_FILE_BYTES,
  REFERENCE_FONT_MAX_FILES,
  REFERENCE_FONT_MAX_STYLESHEET_BYTES,
  REFERENCE_FONT_MAX_STYLESHEETS,
  REFERENCE_FONT_MAX_TOTAL_FILE_BYTES,
  REFERENCE_RENDER_FONT_CSS_MAX_BYTES,
} from './reference-fonts.js'

const CSS_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap'
const SECOND_CSS_URL = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600&display=swap'
const FONT_URL = 'https://fonts.gstatic.com/s/inter/v1/inter-latin.woff2'
const SECOND_FONT_URL = 'https://fonts.gstatic.com/s/spacegrotesk/v1/space-grotesk-latin.woff2'

function woff2(label = 'font'): Buffer {
  return Buffer.concat([Buffer.from('wOF2', 'ascii'), Buffer.from(label, 'utf8')])
}

function css(family: string, url: string): string {
  return `@font-face { font-family: '${family}'; font-style: normal; font-weight: 400; src: url(${url}) format('woff2'); }`
}

function responseAt(
  url: string,
  body: BodyInit | null,
  contentType: string,
  options: { status?: number; contentLength?: number } = {},
): Response {
  const headers = new Headers({ 'content-type': contentType })
  if (options.contentLength !== undefined) headers.set('content-length', String(options.contentLength))
  const response = new Response(body, { status: options.status ?? 200, headers })
  Object.defineProperty(response, 'url', { configurable: true, value: url })
  return response
}

function stylesheetHtml(url = CSS_URL): string {
  return `<!doctype html><html><head><link href="${url.replaceAll('&', '&amp;')}" rel="stylesheet"></head><body></body></html>`
}

function successfulFetch(stylesheets: ReadonlyMap<string, string>, fonts: ReadonlyMap<string, Buffer>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    const stylesheet = stylesheets.get(url)
    if (stylesheet !== undefined) return responseAt(url, stylesheet, 'text/css; charset=utf-8')
    const font = fonts.get(url)
    if (font !== undefined) return responseAt(url, font, 'font/woff2')
    throw new Error(`Unexpected fetch: ${url}`)
  }) as unknown as typeof fetch
}

describe('reference font materialization', () => {
  it('embeds two Google CSS2 stylesheets and their WOFF2 files with a path-free, aggregate-hashed manifest', async () => {
    const inter = woff2('inter')
    const spaceGrotesk = woff2('space-grotesk')
    const firstCss = css('Inter', FONT_URL)
    const secondCss = css('Space Grotesk', SECOND_FONT_URL)
    const fetchMock = successfulFetch(
      new Map([[CSS_URL, firstCss], [SECOND_CSS_URL, secondCss]]),
      new Map([[FONT_URL, inter], [SECOND_FONT_URL, spaceGrotesk]]),
    )
    const html = `<!doctype html><html><head>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="${CSS_URL.replaceAll('&', '&amp;')}" rel="stylesheet">
      <link rel="stylesheet" href="${SECOND_CSS_URL.replaceAll('&', '&amp;')}">
    </head><body><h1>Reference</h1></body></html>`
    const controller = new AbortController()

    const result = await materializeReferenceFonts(html, controller.signal, fetchMock)

    expect(fetchMock).toHaveBeenCalledTimes(4)
    for (const call of vi.mocked(fetchMock).mock.calls) {
      expect(call[1]).toMatchObject({ method: 'GET', redirect: 'follow', signal: controller.signal })
    }
    expect(result.rewrittenHtml).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/u)
    expect(result.rewrittenHtml).not.toContain('rel="preconnect"')
    expect(result.rewrittenHtml.match(/data-anera-reference-fonts=/gu)).toHaveLength(2)
    expect(result.rewrittenHtml).toContain(`data:font/woff2;base64,${inter.toString('base64')}`)
    expect(result.rewrittenHtml).toContain(`data:font/woff2;base64,${spaceGrotesk.toString('base64')}`)
    expect(result.fontCss).toContain('font-family: \'Inter\'')
    expect(result.familyNames).toEqual(['Inter', 'Space Grotesk'])

    expect(result.manifest).not.toBeNull()
    const manifest = result.manifest!
    expect(manifest).toMatchObject({
      version: 1,
      familyNames: ['Inter', 'Space Grotesk'],
      cssBytes: Buffer.byteLength(firstCss) + Buffer.byteLength(secondCss),
      fontBytes: inter.length + spaceGrotesk.length,
      stylesheets: [
        { sha256: digest(firstCss), bytes: Buffer.byteLength(firstCss), fontSha256: [digest(inter)] },
        { sha256: digest(secondCss), bytes: Buffer.byteLength(secondCss), fontSha256: [digest(spaceGrotesk)] },
      ],
      fonts: [
        { sha256: digest(inter), bytes: inter.length },
        { sha256: digest(spaceGrotesk), bytes: spaceGrotesk.length },
      ],
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    const { manifestSha256, ...core } = manifest
    expect(manifestSha256).toBe(digest(JSON.stringify(core)))
    expect(JSON.stringify(manifest)).not.toMatch(/(?:file:|\/Users\/|\\Users\\)/u)
  })

  it('returns no assets and does not fetch when no Google Fonts stylesheet is declared', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch
    const html = '<!doctype html><html><head><style>body { font-family: sans-serif; }</style></head></html>'

    await expect(materializeReferenceFonts(html, new AbortController().signal, fetchMock)).resolves.toEqual({
      rewrittenHtml: html,
      fontCss: '',
      familyNames: [],
      manifest: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('strips harmless Google preconnect hints even when no stylesheet is declared', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch
    const html = '<link rel="preconnect" href="https://fonts.googleapis.com"><main>Reference</main>'

    const result = await materializeReferenceFonts(html, new AbortController().signal, fetchMock)

    expect(result).toEqual({
      rewrittenHtml: '<main>Reference</main>',
      fontCss: '',
      familyNames: [],
      manifest: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['HTTP', 'http://fonts.googleapis.com/css2?family=Inter'],
    ['legacy CSS path', 'https://fonts.googleapis.com/css?family=Inter'],
    ['credentialed URL', 'https://user@fonts.googleapis.com/css2?family=Inter'],
    ['non-default port', 'https://fonts.googleapis.com:8443/css2?family=Inter'],
    ['lookalike host', 'https://fonts.googleapis.com.attacker.invalid/css2?family=Inter'],
    ['protocol-relative URL', '//fonts.googleapis.com/css2?family=Inter'],
  ])('rejects a disallowed Google stylesheet %s before network access', async (_label, url) => {
    const fetchMock = vi.fn() as unknown as typeof fetch

    await expect(materializeReferenceFonts(stylesheetHtml(url), new AbortController().signal, fetchMock))
      .rejects.toThrow(/Google Fonts|ambiguous/u)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it(`rejects more than ${REFERENCE_FONT_MAX_STYLESHEETS} declared stylesheets before fetching`, async () => {
    const links = Array.from({ length: REFERENCE_FONT_MAX_STYLESHEETS + 1 }, (_, index) => (
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Family${index}">`
    )).join('')
    const fetchMock = vi.fn() as unknown as typeof fetch

    await expect(materializeReferenceFonts(links, new AbortController().signal, fetchMock))
      .rejects.toThrow(/more than 2 Google Fonts stylesheets/u)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['stylesheet', 'https://redirect.invalid/css2', 'text/css'],
    ['stylesheet', 'https://fonts.googleapis.com.attacker.invalid/css2', 'text/css'],
  ])('rejects a %s response redirected to a disallowed final host', async (_kind, finalUrl, mime) => {
    const fetchMock = vi.fn(async () => responseAt(finalUrl, css('Inter', FONT_URL), mime)) as unknown as typeof fetch

    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
      .rejects.toThrow(/redirected to a disallowed final host/u)
  })

  it('rejects a font response redirected away from fonts.gstatic.com', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === CSS_URL) return responseAt(url, css('Inter', FONT_URL), 'text/css')
      return responseAt('https://cdn.attacker.invalid/inter.woff2', woff2(), 'font/woff2')
    }) as unknown as typeof fetch

    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
      .rejects.toThrow(/redirected to a disallowed final host/u)
  })

  it.each([
    ['stylesheet', 'application/json'],
    ['stylesheet', 'text/plain'],
  ])('rejects a %s response with MIME %s', async (_kind, mime) => {
    const fetchMock = vi.fn(async () => responseAt(CSS_URL, css('Inter', FONT_URL), mime)) as unknown as typeof fetch

    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
      .rejects.toThrow(/disallowed MIME type/u)
  })

  it('rejects a font response with a non-WOFF2 MIME type', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return url === CSS_URL
        ? responseAt(url, css('Inter', FONT_URL), 'text/css')
        : responseAt(url, woff2(), 'application/octet-stream')
    }) as unknown as typeof fetch

    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
      .rejects.toThrow(/disallowed MIME type/u)
  })

  it('requires HTTP 200 for both stylesheet and font responses', async () => {
    const stylesheetFailure = vi.fn(async () => responseAt(CSS_URL, 'missing', 'text/css', { status: 404 })) as unknown as typeof fetch
    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, stylesheetFailure))
      .rejects.toThrow(/HTTP 404; expected 200/u)

    const fontFailure = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return url === CSS_URL
        ? responseAt(url, css('Inter', FONT_URL), 'text/css')
        : responseAt(url, 'missing', 'font/woff2', { status: 404 })
    }) as unknown as typeof fetch
    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fontFailure))
      .rejects.toThrow(/HTTP 404; expected 200/u)
  })

  it.each([
    ['wrong host', 'https://cdn.example.com/inter.woff2'],
    ['HTTP URL', 'http://fonts.gstatic.com/s/inter/v1/inter.woff2'],
    ['non-WOFF2 path', 'https://fonts.gstatic.com/s/inter/v1/inter.ttf'],
    ['non-default port', 'https://fonts.gstatic.com:8443/s/inter/v1/inter.woff2'],
  ])('rejects a CSS font URL with %s', async (_label, fontUrl) => {
    const fetchMock = vi.fn(async () => responseAt(CSS_URL, css('Inter', fontUrl), 'text/css')) as unknown as typeof fetch

    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
      .rejects.toThrow(/disallowed font URL/u)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects unsupported imports and unsafe style terminators from otherwise valid CSS responses', async () => {
    for (const badCss of [
      `@import url(${FONT_URL});`,
      `@font-face { font-family: 'Inter'; src: local('Inter'), url(${FONT_URL}); }`,
      `${css('Inter', FONT_URL)} </style><script>alert(1)</script>`,
    ]) {
      const fetchMock = vi.fn(async () => responseAt(CSS_URL, badCss, 'text/css')) as unknown as typeof fetch
      await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
        .rejects.toThrow(/@import|local font|style terminator/u)
      expect(fetchMock).toHaveBeenCalledOnce()
    }
  })

  it('rejects escaped or string-form external resources that could bypass URL rewriting', async () => {
    for (const badCss of [
      `${css('Inter', FONT_URL)} body { background: u\\72l(https\\3a//attacker.invalid/tracker); }`,
      `${css('Inter', FONT_URL)} body { background: image-set("https://attacker.invalid/tracker" 1x); }`,
    ]) {
      const fetchMock = vi.fn(async () => responseAt(CSS_URL, badCss, 'text/css')) as unknown as typeof fetch
      await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
        .rejects.toThrow(/CSS escape|external resource/u)
      expect(fetchMock).toHaveBeenCalledOnce()
    }
  })

  it('rejects a font body whose MIME is valid but whose wOF2 magic is not', async () => {
    const fetchMock = successfulFetch(
      new Map([[CSS_URL, css('Inter', FONT_URL)]]),
      new Map([[FONT_URL, Buffer.from('not a WOFF2 file')]]),
    )

    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
      .rejects.toThrow(/wOF2 magic/u)
  })

  it('enforces the stylesheet and individual WOFF2 byte limits from Content-Length before reading', async () => {
    const oversizedCss = vi.fn(async () => responseAt(
      CSS_URL,
      'small',
      'text/css',
      { contentLength: REFERENCE_FONT_MAX_STYLESHEET_BYTES + 1 },
    )) as unknown as typeof fetch
    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, oversizedCss))
      .rejects.toThrow(new RegExp(`${REFERENCE_FONT_MAX_STYLESHEET_BYTES}-byte limit`, 'u'))

    const oversizedFont = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return url === CSS_URL
        ? responseAt(url, css('Inter', FONT_URL), 'text/css')
        : responseAt(url, woff2(), 'font/woff2', { contentLength: REFERENCE_FONT_MAX_FILE_BYTES + 1 })
    }) as unknown as typeof fetch
    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, oversizedFont))
      .rejects.toThrow(new RegExp(`${REFERENCE_FONT_MAX_FILE_BYTES}-byte limit`, 'u'))
  })

  it('enforces streamed body sizes even when Content-Length understates them', async () => {
    const oversized = Buffer.alloc(REFERENCE_FONT_MAX_FILE_BYTES + 1, 0)
    oversized.set(Buffer.from('wOF2', 'ascii'))
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return url === CSS_URL
        ? responseAt(url, css('Inter', FONT_URL), 'text/css')
        : responseAt(url, oversized, 'font/woff2', { contentLength: 4 })
    }) as unknown as typeof fetch

    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
      .rejects.toThrow(new RegExp(`${REFERENCE_FONT_MAX_FILE_BYTES}-byte limit`, 'u'))
  })

  it(`rejects more than ${REFERENCE_FONT_MAX_FILES} unique font files before fetching any of them`, async () => {
    const urls = Array.from({ length: REFERENCE_FONT_MAX_FILES + 1 }, (_, index) => (
      `https://fonts.gstatic.com/s/family/v1/font-${index}.woff2`
    ))
    const manyFontsCss = urls.map((url, index) => css(`Family ${index}`, url)).join('\n')
    const fetchMock = vi.fn(async () => responseAt(CSS_URL, manyFontsCss, 'text/css')) as unknown as typeof fetch

    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
      .rejects.toThrow(/more than 24 WOFF2 files/u)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it(`enforces the ${REFERENCE_FONT_MAX_TOTAL_FILE_BYTES}-byte aggregate WOFF2 limit`, async () => {
    const fontCount = (REFERENCE_FONT_MAX_TOTAL_FILE_BYTES / REFERENCE_FONT_MAX_FILE_BYTES) + 1
    const urls = Array.from({ length: fontCount }, (_, index) => (
      `https://fonts.gstatic.com/s/family/v1/aggregate-${index}.woff2`
    ))
    const aggregateCss = urls.map((url, index) => css(`Family ${index}`, url)).join('\n')
    const oneMiBFont = Buffer.alloc(REFERENCE_FONT_MAX_FILE_BYTES, 0)
    oneMiBFont.set(Buffer.from('wOF2', 'ascii'))
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === CSS_URL) return responseAt(url, aggregateCss, 'text/css')
      return responseAt(url, oneMiBFont, 'font/woff2', { contentLength: oneMiBFont.length })
    }) as unknown as typeof fetch

    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
      .rejects.toThrow(/total limit/u)
  })

  it(`enforces the shared ${REFERENCE_RENDER_FONT_CSS_MAX_BYTES}-byte materialized CSS limit`, async () => {
    const fontCount = REFERENCE_FONT_MAX_TOTAL_FILE_BYTES / REFERENCE_FONT_MAX_FILE_BYTES
    const urls = Array.from({ length: fontCount }, (_, index) => (
      `https://fonts.gstatic.com/s/family/v1/materialized-${index}.woff2`
    ))
    const aggregateCss = urls.map((url, index) => css(`Family ${index}`, url)).join('\n')
    const oneMiBFont = Buffer.alloc(REFERENCE_FONT_MAX_FILE_BYTES, 0)
    oneMiBFont.set(Buffer.from('wOF2', 'ascii'))
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === CSS_URL) return responseAt(url, aggregateCss, 'text/css')
      return responseAt(url, oneMiBFont, 'font/woff2', { contentLength: oneMiBFont.length })
    }) as unknown as typeof fetch

    await expect(materializeReferenceFonts(stylesheetHtml(), new AbortController().signal, fetchMock))
      .rejects.toThrow(new RegExp(`Materialized reference font CSS exceeds the ${REFERENCE_RENDER_FONT_CSS_MAX_BYTES}-byte limit`, 'u'))
  })

  it('propagates AbortSignal to the network request and preserves AbortError', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted by test', 'AbortError')), { once: true })
      })
    }) as unknown as typeof fetch
    const pending = materializeReferenceFonts(stylesheetHtml(), controller.signal, fetchMock)

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not initiate a request for an already-aborted operation', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn() as unknown as typeof fetch

    await expect(materializeReferenceFonts(stylesheetHtml(), controller.signal, fetchMock))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}
