import type { Browser, BrowserContext, ConsoleMessage, Page } from 'playwright-core'
import { chromium } from 'playwright-core'
import { findBrowserExecutable } from './browser-executable.js'
import { config } from './config.js'

interface BrowserSession {
  browser: Browser
  context: BrowserContext
  page: Page
  logs: BrowserLog[]
  allowedOrigin: string
}

interface BrowserLog {
  level: string
  text: string
  at: string
}

export class BrowserManager {
  private readonly sessions = new Map<string, BrowserSession>()
  private readonly sessionCreations = new Map<string, Promise<BrowserSession>>()
  private readonly lastOpenedUrls = new Map<string, string>()
  private browser: Browser | undefined
  private browserLaunch: Promise<Browser> | undefined
  private shuttingDown = false
  private shutdownWork?: Promise<void>

  async open(sessionId: string, url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.assertAcceptingWork()
    const allowedOrigin = previewOrigin(url)
    if (signal?.aborted) throw abortReason(signal)
    const current = this.sessions.get(sessionId)
    if (current?.allowedOrigin && current.allowedOrigin !== allowedOrigin) await this.close(sessionId)
    return await this.runAbortable(sessionId, signal, async (session) => {
      session.allowedOrigin = allowedOrigin
      await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      await session.page.waitForTimeout(150)
      this.lastOpenedUrls.set(sessionId, url)
      return await this.describe(session)
    }, { rehydrate: false })
  }

  async snapshot(sessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => await this.describe(session))
  }

  async click(sessionId: string, target: { ref?: string; text?: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      const locator = target.ref
        ? this.refLocator(session.page, target.ref)
        : session.page.getByText(target.text || '', { exact: true }).first()
      if (await locator.count() === 0) throw new Error(target.ref ? `No element with browser ref: ${target.ref}` : `No visible element with exact text: ${target.text}`)
      if (!await locator.isVisible()) throw new Error(target.ref ? `Browser ref is no longer visible: ${target.ref}` : `No visible element with exact text: ${target.text}`)
      const href = await locator.getAttribute('href')
      if (href) {
        const targetUrl = new URL(href, session.page.url()).toString()
        if (!browserRequestAllowed(targetUrl, session.allowedOrigin)) {
          throw new Error('Browser navigation outside the preview origin is blocked')
        }
      }
      await locator.click({ timeout: 8_000 })
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async fill(sessionId: string, ref: string, value: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      await this.refLocator(session.page, ref).fill(value, { timeout: 8_000 })
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async select(sessionId: string, ref: string, value: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      await this.refLocator(session.page, ref).selectOption(value, { timeout: 8_000 })
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async check(sessionId: string, ref: string, checked: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      await this.refLocator(session.page, ref).setChecked(checked, { timeout: 8_000 })
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async press(sessionId: string, key: string, ref?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      if (ref) await this.refLocator(session.page, ref).focus()
      await session.page.keyboard.press(key)
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async scroll(sessionId: string, deltaY: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.runAbortable(sessionId, signal, async (session) => {
      await session.page.evaluate((amount) => window.scrollBy({ top: amount, behavior: 'instant' }), deltaY)
      await session.page.waitForTimeout(100)
      return await this.describe(session)
    })
  }

  async setViewport(sessionId: string, width: number, height: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (width < 240 || width > 2400 || height < 240 || height > 2400) throw new Error('Viewport must be between 240 and 2400 pixels')
    return await this.runAbortable(sessionId, signal, async (session) => {
      await session.page.setViewportSize({ width, height })
      return await this.describe(session)
    })
  }

  async screenshot(sessionId: string, signal?: AbortSignal): Promise<Buffer> {
    return await this.runAbortable(sessionId, signal, async (session) => await session.page.screenshot({ fullPage: false, type: 'png' }))
  }

  logs(sessionId: string): BrowserLog[] {
    return [...(this.sessions.get(sessionId)?.logs ?? [])]
  }

  diagnostics(): { browserInstances: number; sessionContexts: number; pendingSessionContexts: number } {
    return {
      browserInstances: this.browser?.isConnected() ? 1 : 0,
      sessionContexts: this.sessions.size,
      pendingSessionContexts: this.sessionCreations.size,
    }
  }

  async close(sessionId: string): Promise<void> {
    const pending = this.sessionCreations.get(sessionId)
    const session = this.sessions.get(sessionId) ?? (pending ? await pending.catch(() => undefined) : undefined)
    if (!session) return
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
    await session.context.close()
  }

  async closeEverything(): Promise<void> {
    await Promise.allSettled([...this.sessionCreations.values()])
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(sessions.map(async (session) => await session.context.close()))
    const launching = this.browserLaunch
    if (launching) await launching.catch(() => undefined)
    const browser = this.browser
    this.browser = undefined
    try {
      if (browser?.isConnected()) await browser.close()
    } finally {
      this.lastOpenedUrls.clear()
    }
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownWork) {
      // Flip admission before the shutdown drain snapshots pending Contexts and
      // Browser launches. Any operation that crossed this boundary has already
      // registered its creation promise and is therefore included in the drain.
      this.shuttingDown = true
      this.shutdownWork = this.drainForShutdown()
    }
    await this.shutdownWork
  }

  private async drainForShutdown(): Promise<void> {
    await Promise.allSettled([...this.sessionCreations.values()])
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    const launching = this.browserLaunch
    if (launching) await launching.catch(() => undefined)
    const browser = this.browser
    this.browser = undefined
    try {
      // A stuck per-Context teardown must not prevent service shutdown. Close
      // the shared transport first; Playwright then releases every outstanding
      // page operation and Context close before the final per-session drain.
      if (browser?.isConnected()) await browser.close()
    } finally {
      await Promise.allSettled(sessions.map(async (session) => await session.context.close()))
      this.lastOpenedUrls.clear()
    }
  }

  private async get(sessionId: string): Promise<BrowserSession> {
    this.assertAcceptingWork()
    const current = this.sessions.get(sessionId)
    if (current?.browser.isConnected()) return current
    if (current) {
      this.sessions.delete(sessionId)
      await current.context.close().catch(() => undefined)
    }
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return await pending
    let creation: Promise<BrowserSession>
    creation = this.createSession(sessionId).finally(() => {
      if (this.sessionCreations.get(sessionId) === creation) this.sessionCreations.delete(sessionId)
    })
    this.sessionCreations.set(sessionId, creation)
    return await creation
  }

  private async createSession(sessionId: string): Promise<BrowserSession> {
    const browser = await this.getBrowser()
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    })
    const page = await context.newPage()
    const logs: BrowserLog[] = []
    const session = { browser, context, page, logs, allowedOrigin: '' }
    const appendLog = (entry: BrowserLog) => {
      logs.push(entry)
      if (logs.length > 200) logs.splice(0, logs.length - 200)
    }
    const capture = (message: ConsoleMessage) => {
      appendLog({ level: message.type(), text: message.text(), at: new Date().toISOString() })
    }
    page.on('console', capture)
    page.on('pageerror', (error) => capture({ type: () => 'error', text: () => error.message } as ConsoleMessage))
    page.on('requestfailed', (request) => {
      appendLog({ level: 'requestfailed', text: `${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}`, at: new Date().toISOString() })
    })
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (browserRequestAllowed(url, session.allowedOrigin)) {
        await route.continue()
        return
      }
      appendLog({ level: 'networkblocked', text: `Blocked ${route.request().method()} ${url}: outside preview origin`, at: new Date().toISOString() })
      await route.abort('blockedbyclient')
    })
    await context.routeWebSocket(/.*/, async (socket) => {
      if (browserRequestAllowed(socket.url(), session.allowedOrigin)) {
        socket.connectToServer()
        return
      }
      appendLog({ level: 'networkblocked', text: `Blocked WebSocket ${socket.url()}: outside preview origin`, at: new Date().toISOString() })
      await socket.close({ code: 1008, reason: 'Outside preview origin' })
    })
    if (!browser.isConnected()) {
      await context.close().catch(() => undefined)
      throw new Error('Browser disconnected while creating an isolated session context')
    }
    this.sessions.set(sessionId, session)
    return session
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser
    if (this.browserLaunch) return await this.browserLaunch
    const executablePath = findBrowserExecutable(config.browserExecutablePath)
    let launch: Promise<Browser>
    launch = chromium.launch({ executablePath, headless: true, args: ['--disable-dev-shm-usage'] }).then((browser) => {
      this.browser = browser
      browser.on('disconnected', () => {
        if (this.browser === browser) this.browser = undefined
        for (const [sessionId, session] of this.sessions) {
          if (session.browser === browser) this.sessions.delete(sessionId)
        }
      })
      return browser
    }).finally(() => {
      if (this.browserLaunch === launch) this.browserLaunch = undefined
    })
    this.browserLaunch = launch
    return await launch
  }

  private async runAbortable<T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    operation: (session: BrowserSession) => Promise<T>,
    options: { rehydrate?: boolean } = {},
  ): Promise<T> {
    this.assertAcceptingWork()
    let aborted = signal?.aborted === true
    const abort = () => {
      aborted = true
      void this.close(sessionId).catch(() => undefined)
    }
    if (!aborted) signal?.addEventListener('abort', abort, { once: true })
    try {
      if (aborted) throw abortReason(signal)
      const session = await this.get(sessionId)
      if (aborted || signal?.aborted) {
        await this.close(sessionId).catch(() => undefined)
        throw abortReason(signal)
      }
      if (options.rehydrate !== false && session.page.url() === 'about:blank') {
        await this.rehydrate(sessionId, session)
      }
      const result = await operation(session)
      if (aborted || signal?.aborted) throw abortReason(signal)
      return result
    } catch (error) {
      if (aborted || signal?.aborted) throw abortReason(signal)
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  private assertAcceptingWork(): void {
    if (this.shuttingDown) throw new Error('Browser manager is shutting down')
  }

  private async rehydrate(sessionId: string, session: BrowserSession): Promise<void> {
    const url = this.lastOpenedUrls.get(sessionId)
    if (!url) return
    session.allowedOrigin = previewOrigin(url)
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await session.page.waitForTimeout(150)
    // Reassign deterministic refs before a resumed turn tries to reuse the
    // latest snapshot's eN target after its prior Context was released.
    await this.describe(session)
  }

  private refLocator(page: Page, ref: string) {
    if (!/^e\d+$/.test(ref)) throw new Error('Browser ref must look like e1')
    return page.locator(`[data-anera-ref="${ref}"]`).first()
  }

  private async describe(session: BrowserSession): Promise<Record<string, unknown>> {
    const page = session.page
    const interactive = await page.locator('a,button,input,textarea,select,[role="button"],[role="checkbox"],[contenteditable="true"]').evaluateAll((allElements) => {
      const rendered = (element: Element) => {
        for (let current: Element | null = element; current; current = current.parentElement) {
          if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false
          const style = getComputedStyle(current)
          if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false
          const opacity = Number.parseFloat(style.opacity)
          if (Number.isFinite(opacity) && opacity <= 0.01) return false
        }
        const bounds = element.getBoundingClientRect()
        return bounds.width > 0 && bounds.height > 0
      }
      const elements = allElements.filter(rendered).slice(0, 120)
      let next = allElements.reduce((highest, element) => {
        const match = element.getAttribute('data-anera-ref')?.match(/^e(\d+)$/)
        return Math.max(highest, match ? Number.parseInt(match[1], 10) : 0)
      }, 0) + 1
      return elements.map((element) => {
        let ref = element.getAttribute('data-anera-ref')
        if (!ref) {
          ref = `e${next}`
          next += 1
          element.setAttribute('data-anera-ref', ref)
        }
        const control = element as HTMLInputElement
        return {
          ref,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          type: element.getAttribute('type'),
          text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
          ariaLabel: element.getAttribute('aria-label'),
          placeholder: element.getAttribute('placeholder'),
          value: 'value' in control ? control.value : undefined,
          checked: 'checked' in control ? control.checked : undefined,
          disabled: (element as HTMLButtonElement).disabled || undefined,
        }
      })
    })
    const visibleText = await page.evaluate(() => {
      const tokens: string[] = []
      const rendered = (element: Element) => {
        for (let current: Element | null = element; current; current = current.parentElement) {
          if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false
          const style = getComputedStyle(current)
          if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false
          const opacity = Number.parseFloat(style.opacity)
          if (Number.isFinite(opacity) && opacity <= 0.01) return false
        }
        return true
      }
      const generated = (element: Element, pseudo: '::before' | '::after') => {
        const value = getComputedStyle(element, pseudo).content
        if (!value || value === 'none' || value === 'normal' || value === '""' || value === "''") return ''
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          return value.slice(1, -1).replace(/\\([\\"'])/g, '$1')
        }
        return ''
      }
      const visit = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const value = node.nodeValue?.replace(/\s+/g, ' ').trim()
          if (value) tokens.push(value)
          return
        }
        if (!(node instanceof Element) || !rendered(node)) return
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(node.tagName)) return
        const display = getComputedStyle(node).display
        const block = /^(?:block|flex|grid|table|list-item)/.test(display) || /^H[1-6]$/.test(node.tagName)
        if (block) tokens.push('\n')
        const before = generated(node, '::before')
        if (before) tokens.push(before)
        for (const child of node.childNodes) visit(child)
        const after = generated(node, '::after')
        if (after) tokens.push(after)
        if (block) tokens.push('\n')
      }
      visit(document.body)
      return tokens.join(' ')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    })
    return {
      url: page.url(),
      title: await page.title(),
      viewport: page.viewportSize(),
      scrollY: await page.evaluate(() => window.scrollY),
      text: visibleText.slice(0, 20_000),
      interactive,
    }
  }
}

function previewOrigin(rawUrl: string): string {
  const url = new URL(rawUrl)
  if (url.protocol === 'data:') return 'data:'
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser preview only supports local HTTP(S) or data URLs')
  if (url.username || url.password) throw new Error('Browser preview URLs cannot contain credentials')
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
    throw new Error('Browser preview must use a local loopback URL')
  }
  return url.origin
}

function browserRequestAllowed(rawUrl: string, allowedOrigin: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (['data:', 'blob:', 'about:'].includes(url.protocol)) return true
  if (!allowedOrigin || allowedOrigin === 'data:') return false
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin === allowedOrigin
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    const origin = new URL(allowedOrigin)
    const expectedProtocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.protocol === expectedProtocol && url.hostname === origin.hostname && effectivePort(url) === effectivePort(origin)
  }
  return false
}

function effectivePort(url: URL): string {
  if (url.port) return url.port
  return url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80'
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('Browser action aborted', 'AbortError')
}
