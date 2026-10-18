import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, transformWithEsbuild, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { findBrowserExecutable } from '../server/browser-executable.js'

// Exercise the actual shell with deterministic, isolated sessions and no server
// or model calls. Route reloads remount the same fixture on the same origin.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '/src/client/App.tsx';
import { api } from '/src/client/api.ts';
import '/src/client/styles.css';
const control = window.fixture = { sessionCreates: 0, uploadCalls: [], sent: [] };
const sessions = ['a', 'b'].map(letter => ({ id: 'ses_' + letter.repeat(20), title: 'Session ' + letter.toUpperCase(), status: 'completed', model: 'fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workspaceBytes: 0,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0, estimatedCostUsd: 0, modelCalls: 0, toolCalls: 0 } }));
api.listSessions = async () => sessions;
api.snapshot = async id => ({ session: sessions.find(item => item.id === id), steering: [], events: [
  { id: 'turn', seq: 1, sessionId: id, at: new Date().toISOString(), type: 'turn.started', data: { content: 'Previous task', attachments: [] } },
  { id: 'final', seq: 2, sessionId: id, at: new Date().toISOString(), type: 'assistant.final', data: { content: 'Previous task completed.' } },
  { id: 'review', seq: 3, sessionId: id, at: new Date().toISOString(), type: 'review.dismissed', data: { messageEventId: 'final', action: 'continue' } },
], workspace: [], artifacts: [], processes: [], repository: null, plan: null,
  website: { status: 'stopped', updatedAt: '', restartCount: 0 }, deployment: { status: 'not_deployed', revision: 0, updatedAt: '' } });
api.listAgentModels = async () => [{ id: 'fixture', publicName: 'fixture', displayName: 'Fixture' }];
api.creditBalance = async () => ({ creditsRemaining: 10, dailyFreeCredits: 10, refreshedAt: '' });
api.githubConnection = async () => ({ status: 'disconnected' });
api.githubStatus = async () => ({});
api.upload = async (id, file) => {
  control.uploadCalls.push({ id, name: file.name, size: file.size });
  if (control.deferUpload) await new Promise(resolve => { control.finishUpload = resolve; });
  return { path: 'uploads/' + file.name, bytes: file.size, mime: file.type };
};
api.send = async (id, content, attachments) => { control.sent.push({ id, content, attachments }); };
api.createSession = api.createAgentChat = async () => { control.sessionCreates++; throw new Error('Navigation must not create a session'); };
window.EventSource = class { addEventListener() {} close() {} };
if (location.pathname === '/sidebar-fixture') history.replaceState({}, '', '/agent/' + sessions[0].id);
createRoot(document.getElementById('root')).render(<App />);
`

let server: ViteDevServer
let browser: Browser
let page: Page
let origin: string
beforeAll(async () => {
  server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'isolated-sidebar-fixture',
    configureServer(instance) {
      instance.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0]
        if (path !== '/sidebar-fixture' && path !== '/history/search' && path !== '/leaderboard/agent' && !/^\/agent(?:\/[^/]+)?$/.test(path || '')) return next()
        response.setHeader('content-type', 'text/html')
        response.end('<!doctype html><html lang="en"><head><title>Sidebar fixture</title></head><body><div id="root"></div><script type="module" src="/sidebar-fixture.tsx"></script></body></html>')
      })
    },
    resolveId: (id) => id === '/sidebar-fixture.tsx' ? '\0sidebar-fixture.tsx' : undefined,
    load: (id) => id === '\0sidebar-fixture.tsx' ? fixture : undefined,
    async transform(source, id) {
      if (id === '\0sidebar-fixture.tsx') return { code: (await transformWithEsbuild(source, 'fixture.tsx', { jsx: 'automatic' })).code }
    },
  }] })
  await server.listen()
  origin = server.resolvedUrls!.local[0]
  browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true })
}, 30_000)
afterEach(async () => { await page?.close() })
afterAll(async () => { await browser?.close(); await server?.close() })

async function openFixture() {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(3_000)
  await page.goto(new URL('/sidebar-fixture', origin).href)
  await page.locator('.stage-title').filter({ hasText: 'Session A' }).waitFor()
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor()
}

describe('desktop sidebar navigation', () => {
  it('keeps the draft and keyboard focus while collapsing, searching, and using the compact navigation', async () => {
    await openFixture()
    const editor = page.getByRole('textbox', { name: 'Message', exact: true })
    await editor.fill('Unsent session follow-up')
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true })
    await expand.waitFor()
    expect(await expand.getAttribute('aria-expanded')).toBe('false')
    expect(await expand.evaluate((button) => button === document.activeElement)).toBe(true)
    expect(await editor.textContent()).toBe('Unsent session follow-up')
    expect(await page.locator('.history-list').isVisible()).toBe(false)
    expect(await page.getByRole('button', { name: 'New Chat', exact: true }).isVisible()).toBe(true)

    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByRole('dialog', { name: 'Search conversations' }).waitFor()
    await page.keyboard.press('Escape')
    await page.waitForURL(/\/agent\/ses_a{20}$/)
    expect(await editor.textContent()).toBe('Unsent session follow-up')
    expect(await expand.isVisible()).toBe(true)

    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await page.waitForURL(/\/agent$/)
    expect(await page.locator('.stage-title').textContent()).toBe('New chat')
    await editor.fill('Unsent new task')
    await expand.click()
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor()
    expect(await editor.textContent()).toBe('Unsent new task')
    expect(await page.locator('.history-list').isVisible()).toBe(true)
    expect(await page.evaluate(() => (window as any).fixture.sessionCreates)).toBe(0)
  })

  it('persists the desktop preference across reloads without hiding mobile navigation', async () => {
    await openFixture()
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await page.reload()
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor()
    expect(await page.locator('.stage-title').textContent()).toBe('Session A')
    expect(await page.locator('.history-list').isVisible()).toBe(false)

    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.getByRole('button', { name: 'Expand sidebar', exact: true }).isVisible()).toBe(false)
    await page.getByRole('button', { name: 'Open conversations', exact: true }).click()
    await page.getByRole('button', { name: 'Close conversations', exact: true }).waitFor()
    expect(await page.locator('.history-list').isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Close conversations', exact: true }).click()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor()
    expect(await page.locator('.history-list').isVisible()).toBe(false)

    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await page.reload()
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor()
    expect(await page.locator('.history-list').isVisible()).toBe(true)
  })

  it('supports the desktop shortcut while leaving editing shortcuts and mobile navigation alone', async () => {
    await openFixture()
    const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
    await collapse.focus()
    await page.keyboard.press('Control+b')
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor()
    await page.keyboard.press('Meta+b')
    await collapse.waitFor()

    const editor = page.getByRole('textbox', { name: 'Message', exact: true })
    await editor.fill('Keep the composer draft')
    await page.locator('.history-list button[aria-current="page"]').focus()
    await page.keyboard.press('Control+b')
    const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true })
    await expand.waitFor()
    expect(await expand.evaluate((button) => button === document.activeElement)).toBe(true)
    expect(await editor.textContent()).toBe('Keep the composer draft')
    await page.keyboard.press('Meta+b')
    await collapse.waitFor()
    await editor.focus()
    await page.keyboard.press('Control+b')
    expect(await collapse.isVisible()).toBe(true)
    expect(await editor.textContent()).toBe('Keep the composer draft')
    // A contenteditable child can be the key event target (e.g. rich text).
    await editor.evaluate((element) => {
      const child = document.createElement('span')
      child.textContent = element.textContent
      element.replaceChildren(child)
      child.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true }))
    })
    expect(await collapse.isVisible()).toBe(true)

    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByRole('combobox', { name: 'Search conversations' }).fill('Session')
    await page.keyboard.press('Meta+b')
    expect(await collapse.isVisible()).toBe(true)
    await page.keyboard.press('Escape')
    await page.waitForURL(/\/agent\/ses_a{20}$/)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Open conversations', exact: true }).focus()
    await page.keyboard.press('Control+b')
    await page.setViewportSize({ width: 1440, height: 900 })
    await collapse.waitFor()
  })
})

describe('composer files and connections menu', () => {
  it('uses Enter for mobile line breaks, while desktop Enter submits and Shift+Enter keeps editing', async () => {
    await openFixture()
    await page.getByRole('button', { name: 'Toggle workspace sidebar', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Message', exact: true })
    await editor.fill('Desktop first line')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.insertText('Desktop second line')
    expect(await editor.evaluate((element) => element.textContent?.replaceAll('\u200b', ''))).toBe('Desktop first line\nDesktop second line')
    expect(await page.evaluate(() => (window as any).fixture.sent.length)).toBe(0)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('Mobile third line')
    expect(await editor.evaluate((element) => element.textContent?.replaceAll('\u200b', ''))).toBe('Desktop first line\nDesktop second line\nMobile third line')
    expect(await page.evaluate(() => (window as any).fixture.sent.length)).toBe(0)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.sent.length === 1)
    expect(await page.evaluate(() => (window as any).fixture.sent[0].content)).toBe('Desktop first line\nDesktop second line\nMobile third line')

    await page.setViewportSize({ width: 1440, height: 900 })
    await editor.fill('Desktop Enter submits')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => (window as any).fixture.sent.length === 2)
    expect(await page.evaluate(() => (window as any).fixture.sent[1].content)).toBe('Desktop Enter submits')
  })

  it('keeps the draft while keyboard navigation opens the real GitHub panel and dismisses back to the trigger', async () => {
    await openFixture()
    const editor = page.getByRole('textbox', { name: 'Message', exact: true })
    const trigger = page.getByRole('button', { name: 'Add files and connections', exact: true })
    await editor.fill('Keep this draft while choosing tools')
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    const upload = page.getByRole('menuitem', { name: 'Upload files', exact: true })
    const github = page.getByRole('menuitem', { name: 'GitHub connection', exact: true })
    await upload.waitFor()
    expect(await upload.evaluate((element) => element === document.activeElement)).toBe(true)
    await page.keyboard.press('ArrowDown')
    expect(await github.evaluate((element) => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Home')
    expect(await upload.evaluate((element) => element === document.activeElement)).toBe(true)
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    const panel = page.getByRole('dialog', { name: 'Connections', exact: true })
    await panel.waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Connect GitHub')
    expect(await page.getByRole('menu', { name: 'Add files and connections', exact: true }).count()).toBe(0)
    expect(await editor.textContent()).toBe('Keep this draft while choosing tools')
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Add files and connections')
    await page.keyboard.press('ArrowUp')
    await github.waitFor()
    expect(await github.evaluate((element) => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    await trigger.click()
    await editor.click()
    expect(await page.getByRole('menu').count()).toBe(0)
    expect(await editor.textContent()).toBe('Keep this draft while choosing tools')
    await trigger.click()
    await page.keyboard.press('Tab')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    expect(await page.getByRole('combobox', { name: '选择模型' }).evaluate((element) => element === document.activeElement)).toBe(true)
  })

  it('opens the native file chooser, preserves upload locking and sends the actual attachment with the draft', async () => {
    await openFixture()
    const editor = page.getByRole('textbox', { name: 'Message', exact: true })
    const trigger = page.getByRole('button', { name: 'Add files and connections', exact: true })
    await editor.fill('Read this brief')
    await page.evaluate(() => { (window as any).fixture.deferUpload = true })
    await trigger.click()
    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('menuitem', { name: 'Upload files', exact: true }).click()
    const chooser = await chooserPromise
    await chooser.setFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('actual fixture content') })
    await page.waitForFunction(() => Boolean((window as any).fixture.finishUpload))
    expect(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled()).toBe(true)
    await trigger.click()
    expect(await page.getByRole('menuitem', { name: 'Upload files', exact: true }).isDisabled()).toBe(true)
    expect(await page.getByRole('menuitem', { name: 'GitHub connection', exact: true }).isEnabled()).toBe(true)
    await page.keyboard.press('Escape')
    await page.evaluate(() => (window as any).fixture.finishUpload())
    await page.getByRole('button', { name: 'Remove brief.txt', exact: true }).waitFor()
    expect(await editor.textContent()).toBe('Read this brief')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.sent.length === 1)
    expect(await page.evaluate(() => (window as any).fixture.sent[0])).toEqual({
      id: 'ses_' + 'a'.repeat(20),
      content: 'Read this brief',
      attachments: [{ name: 'brief.txt', path: 'uploads/brief.txt', mime: 'text/plain' }],
    })
    expect(await page.evaluate(() => (window as any).fixture.uploadCalls.length)).toBe(1)
    await page.getByRole('button', { name: 'Remove brief.txt', exact: true }).waitFor({ state: 'detached' })
  })

  it('fills an editable starter prompt without creating a session or losing staged attachments', async () => {
    await openFixture()
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await page.waitForURL(/\/agent$/)
    await page.locator('input[type="file"]').setInputFiles({ name: 'research.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this reference attachment') })
    await page.getByRole('button', { name: 'Remove research.txt', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Research a topic', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Message', exact: true })
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message'
      && document.activeElement.textContent?.includes('请帮我研究【主题】'))
    expect(await editor.textContent()).toContain('请帮我研究【主题】')
    expect(await editor.getAttribute('contenteditable')).toBe('true')
    expect(await page.getByRole('button', { name: 'Remove research.txt', exact: true }).isVisible()).toBe(true)
    expect(await page.locator('.starter-prompts').count()).toBe(0)
    await editor.fill('我需要研究浏览器无障碍交互。')
    expect(await editor.textContent()).toBe('我需要研究浏览器无障碍交互。')
    expect(await page.evaluate(() => ({ creates: (window as any).fixture.sessionCreates, uploads: (window as any).fixture.uploadCalls.length, sends: (window as any).fixture.sent.length })))
      .toEqual({ creates: 0, uploads: 0, sends: 0 })
    await editor.fill('')
    await page.getByRole('button', { name: 'Create a presentation', exact: true }).waitFor()
  })
})
