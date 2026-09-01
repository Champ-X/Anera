import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from './browser-manager.js'

const managers: BrowserManager[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeEverything()))
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

describe('browser manager', () => {
  it('opens, snapshots stable refs, operates form controls, scrolls, resizes, and reads console output', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const html = `<title>Anera Browser Test</title>
      <label>Name <input aria-label="Name"></label>
      <label>Enabled <input type="checkbox" aria-label="Enabled"></label>
      <select aria-label="Mode"><option value="slow">Slow</option><option value="fast">Fast</option></select>
      <button onclick="this.textContent='Clicked'; console.log('CLICK_OK')">Increment</button>
      <div style="height:1800px">Scrollable content</div>`
    const opened = await manager.open('session', `data:text/html,${encodeURIComponent(html)}`)
    expect(opened.title).toBe('Anera Browser Test')
    const controls = opened.interactive as Array<{ ref: string; ariaLabel?: string; text?: string }>
    const ref = (label: string) => controls.find((control) => control.ariaLabel === label || control.text === label)?.ref || ''
    const filled = await manager.fill('session', ref('Name'), 'Arena')
    expect((filled.interactive as Array<{ ariaLabel?: string; value?: string }>).find((item) => item.ariaLabel === 'Name')?.value).toBe('Arena')
    const checked = await manager.check('session', ref('Enabled'), true)
    expect((checked.interactive as Array<{ ariaLabel?: string; checked?: boolean }>).find((item) => item.ariaLabel === 'Enabled')?.checked).toBe(true)
    const selected = await manager.select('session', ref('Mode'), 'fast')
    expect((selected.interactive as Array<{ ariaLabel?: string; value?: string }>).find((item) => item.ariaLabel === 'Mode')?.value).toBe('fast')
    await manager.press('session', 'Tab', ref('Name'))
    const clicked = await manager.click('session', { ref: ref('Increment') })
    expect(clicked.text).toContain('Clicked')
    const scrolled = await manager.scroll('session', 500)
    expect(scrolled.scrollY).toBeGreaterThan(0)
    const resized = await manager.setViewport('session', 375, 700)
    expect(resized.viewport).toEqual({ width: 375, height: 700 })
    const screenshot = await manager.screenshot('session')
    expect({
      width: screenshot.readUInt32BE(16),
      height: screenshot.readUInt32BE(20),
    }).toEqual({ width: 375, height: 700 })
    expect(manager.logs('session').some((entry) => entry.text === 'CLICK_OK')).toBe(true)
  }, 15_000)

  it('projects visually rendered text by excluding transparent content and including CSS generated status', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const html = `<style>
        .hidden { opacity: 0; pointer-events: none; }
        #status::after { content: "Unacknowledged"; }
        #status.ack::after { content: "Acknowledged"; }
      </style>
      <button onclick="document.querySelector('#card').classList.add('hidden'); document.querySelector('#status').classList.add('ack')">Apply</button>
      <article id="card">Web Degraded</article>
      <span id="status"></span>`
    const opened = await manager.open('visual-text', `data:text/html,${encodeURIComponent(html)}`)
    expect(opened.text).toContain('Web Degraded')
    expect(opened.text).toContain('Unacknowledged')
    const button = (opened.interactive as Array<{ ref: string; text?: string }>).find((item) => item.text === 'Apply')
    const clicked = await manager.click('visual-text', { ref: button?.ref })
    expect(clicked.text).not.toContain('Web Degraded')
    expect(clicked.text).toContain('Acknowledged')
    expect(clicked.text).not.toContain('Unacknowledged')
  })

  it('only exposes rendered interactive refs and rejects a ref as soon as its control becomes hidden', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const html = `<style>.gone { display: none }</style>
      <button id="first" onclick="this.classList.add('gone'); document.querySelector('#second').classList.remove('gone')">First action</button>
      <button id="second" class="gone">Second action</button>
      <div aria-hidden="true"><button>ARIA hidden action</button></div>
      <button style="opacity:0">Transparent action</button>`
    const opened = await manager.open('rendered-controls', `data:text/html,${encodeURIComponent(html)}`)
    const openedControls = opened.interactive as Array<{ ref: string; text?: string }>
    expect(openedControls.map((item) => item.text)).toEqual(['First action'])
    const firstRef = openedControls[0]?.ref || ''

    const clicked = await manager.click('rendered-controls', { ref: firstRef })
    expect((clicked.interactive as Array<{ text?: string }>).map((item) => item.text)).toEqual(['Second action'])
    await expect(manager.click('rendered-controls', { ref: firstRef })).rejects.toThrow(`Browser ref is no longer visible: ${firstRef}`)
  })

  it('restricts preview navigation, HTTP requests, and WebSockets to the opened loopback origin', async () => {
    let allowedRequests = 0
    let blockedRequests = 0
    let blockedUpgrades = 0
    const blocked = await listen(createServer((_request, response) => {
      blockedRequests += 1
      response.end('must not be reached')
    }).on('upgrade', (request, socket) => {
      blockedUpgrades += 1
      socket.destroy()
    }))
    const blockedPort = (blocked.address() as AddressInfo).port
    const allowed = await listen(createServer((request, response) => {
      if (request.url === '/same-origin') {
        allowedRequests += 1
        response.end('ok')
        return
      }
      response.setHeader('content-type', 'text/html')
      response.end(`<title>Origin boundary</title>
        <a href="http://127.0.0.1:${blockedPort}/navigation">Leave preview</a>
        <script>
          fetch('/same-origin').catch(() => undefined)
          fetch('http://127.0.0.1:${blockedPort}/fetch').catch(() => undefined)
          new WebSocket('ws://127.0.0.1:${blockedPort}/socket')
        </script>`)
    }))
    const allowedPort = (allowed.address() as AddressInfo).port
    const manager = new BrowserManager()
    managers.push(manager)

    const opened = await manager.open('isolated', `http://127.0.0.1:${allowedPort}/`)
    expect(opened.title).toBe('Origin boundary')
    await waitFor(() => allowedRequests === 1)
    expect(blockedRequests).toBe(0)
    expect(blockedUpgrades).toBe(0)
    expect(manager.logs('isolated').filter((entry) => entry.level === 'networkblocked').length).toBeGreaterThanOrEqual(2)

    const link = (opened.interactive as Array<{ ref: string; text?: string }>).find((item) => item.text === 'Leave preview')
    expect(link?.ref).toBeTruthy()
    await manager.click('isolated', { ref: link?.ref }).catch(() => undefined)
    expect(blockedRequests).toBe(0)
    expect((await manager.snapshot('isolated')).url).toBe(`http://127.0.0.1:${allowedPort}/`)

    await expect(manager.open('public', 'https://example.com/')).rejects.toThrow('local loopback URL')
  })

  it('closes the browser on abort so a timed-out action cannot perform a late same-origin side effect', async () => {
    let clickedRequests = 0
    let lateRequests = 0
    const server = await listen(createServer((request, response) => {
      if (request.url === '/clicked') {
        clickedRequests += 1
        response.end('clicked')
        return
      }
      if (request.url === '/late') {
        lateRequests += 1
        response.end('late')
        return
      }
      response.setHeader('content-type', 'text/html')
      response.end(`<title>Abort boundary</title>
        <button onclick="fetch('/clicked'); setTimeout(() => fetch('/late'), 150)">Start delayed effect</button>`)
    }))
    const port = (server.address() as AddressInfo).port
    const manager = new BrowserManager()
    managers.push(manager)
    const opened = await manager.open('abortable', `http://127.0.0.1:${port}/`)
    const button = (opened.interactive as Array<{ ref: string; text?: string }>).find((item) => item.text === 'Start delayed effect')
    expect(button?.ref).toBeTruthy()

    const controller = new AbortController()
    const clicking = manager.click('abortable', { ref: button?.ref }, controller.signal)
    await waitFor(() => clickedRequests === 1)
    controller.abort(new DOMException('fixture timeout', 'TimeoutError'))
    await expect(clicking).rejects.toMatchObject({ name: 'TimeoutError' })
    await new Promise((resolve) => setTimeout(resolve, 225))
    expect(lateRequests).toBe(0)

    const reopened = await manager.open('abortable', `http://127.0.0.1:${port}/`)
    expect(reopened.title).toBe('Abort boundary')
  })

  it('coalesces concurrent startup into one Chromium while isolating and independently closing session contexts', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    const oneHtml = `<title>Session One</title><input aria-label="Value" value="one">`
    const twoHtml = `<title>Session Two</title><input aria-label="Value" value="two">`
    const [one, two, racedA, racedB] = await Promise.all([
      manager.open('one', `data:text/html,${encodeURIComponent(oneHtml)}`),
      manager.open('two', `data:text/html,${encodeURIComponent(twoHtml)}`),
      manager.snapshot('raced'),
      manager.snapshot('raced'),
    ])

    expect(one.title).toBe('Session One')
    expect(two.title).toBe('Session Two')
    expect(racedA.url).toBe('about:blank')
    expect(racedB.url).toBe('about:blank')
    expect(manager.diagnostics()).toEqual({ browserInstances: 1, sessionContexts: 3, pendingSessionContexts: 0 })

    const oneRef = (one.interactive as Array<{ ref: string; ariaLabel?: string }>).find((item) => item.ariaLabel === 'Value')?.ref
    expect(oneRef).toBeTruthy()
    await manager.fill('one', oneRef || '', 'changed-one')
    const twoValue = ((await manager.snapshot('two')).interactive as Array<{ ariaLabel?: string; value?: string }>)
      .find((item) => item.ariaLabel === 'Value')?.value
    expect(twoValue).toBe('two')

    await manager.close('one')
    expect(manager.diagnostics()).toEqual({ browserInstances: 1, sessionContexts: 2, pendingSessionContexts: 0 })
    expect((await manager.snapshot('two')).title).toBe('Session Two')
    const rehydratedOne = await manager.snapshot('one')
    expect(rehydratedOne.title).toBe('Session One')
    expect((rehydratedOne.interactive as Array<{ ariaLabel?: string; value?: string }>).find((item) => item.ariaLabel === 'Value')?.value).toBe('one')
    expect(manager.diagnostics()).toEqual({ browserInstances: 1, sessionContexts: 3, pendingSessionContexts: 0 })

    await manager.closeEverything()
    expect(manager.diagnostics()).toEqual({ browserInstances: 0, sessionContexts: 0, pendingSessionContexts: 0 })
    expect((await manager.open('two', `data:text/html,${encodeURIComponent(twoHtml)}`)).title).toBe('Session Two')
    expect(manager.diagnostics()).toEqual({ browserInstances: 1, sessionContexts: 1, pendingSessionContexts: 0 })

    const sharedBrowser = (manager as unknown as { browser?: { close(): Promise<void> } }).browser
    expect(sharedBrowser).toBeTruthy()
    await sharedBrowser?.close()
    await waitFor(() => manager.diagnostics().browserInstances === 0 && manager.diagnostics().sessionContexts === 0)
    expect((await manager.snapshot('two')).title).toBe('Session Two')
    expect(manager.diagnostics()).toEqual({ browserInstances: 1, sessionContexts: 1, pendingSessionContexts: 0 })
  })

  it('closes the Browser transport before Context drain and rejects work throughout idempotent shutdown', async () => {
    const manager = new BrowserManager()
    managers.push(manager)
    await manager.open('existing', 'data:text/html,<title>Existing</title>')
    const internal = manager as unknown as {
      sessions: Map<string, { context: { close(): Promise<void> } }>
      browser?: { close(): Promise<void> }
    }
    const context = internal.sessions.get('existing')?.context
    const browser = internal.browser
    expect(context).toBeTruthy()
    expect(browser).toBeTruthy()
    const originalClose = context?.close.bind(context)
    const originalBrowserClose = browser?.close.bind(browser)
    const closeOrder: string[] = []
    vi.spyOn(context as { close(): Promise<void> }, 'close').mockImplementationOnce(async () => {
      closeOrder.push('context')
      await originalClose?.()
    })
    let signalBrowserCloseStarted = () => {}
    const browserCloseStarted = new Promise<void>((resolveStarted) => { signalBrowserCloseStarted = resolveStarted })
    let releaseBrowserClose = () => {}
    const browserCloseGate = new Promise<void>((resolveClose) => { releaseBrowserClose = resolveClose })
    vi.spyOn(browser as { close(): Promise<void> }, 'close').mockImplementationOnce(async () => {
      closeOrder.push('browser')
      signalBrowserCloseStarted()
      await browserCloseGate
      await originalBrowserClose?.()
    })

    const firstShutdown = manager.shutdown()
    const secondShutdown = manager.shutdown()
    await browserCloseStarted
    await expect(manager.open('late', 'data:text/html,<title>Late</title>')).rejects.toThrow('Browser manager is shutting down')
    await expect(manager.snapshot('late')).rejects.toThrow('Browser manager is shutting down')
    expect(closeOrder).toEqual(['browser'])

    releaseBrowserClose()
    await Promise.all([firstShutdown, secondShutdown])
    expect(closeOrder).toEqual(['browser', 'context'])
    expect(manager.diagnostics()).toEqual({ browserInstances: 0, sessionContexts: 0, pendingSessionContexts: 0 })
    await expect(manager.open('after', 'data:text/html,<title>After</title>')).rejects.toThrow('Browser manager is shutting down')
  })
})

async function listen(server: Server): Promise<Server> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for browser fixture')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
