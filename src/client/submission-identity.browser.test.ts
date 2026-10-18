import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, transformWithEsbuild, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { findBrowserExecutable } from '../server/browser-executable.js'

// Real App + real API transport; only receipts are replaced. No model, user
// session, upload directory, or browser profile is touched by this fixture.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '/src/client/App.tsx';
import { api } from '/src/client/api.ts';
import '/src/client/styles.css';
const existingId = 'ses_' + 'a'.repeat(20);
const createdId = 'ses_' + 'c'.repeat(20);
const query = new URLSearchParams(location.search);
const control = window.fixture = { creates: [], sends: [], stops: [], accepted: new Map(), failCreate: 1, failSend: 1, historyFails: false, acknowledgeSend: false, sources: {} };
const summary = id => ({ id, title: id === existingId ? 'Existing session' : 'Created session', status: query.has('running') ? 'running' : 'completed', model: 'fixture', modelSelection: 'fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workspaceBytes: 0,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0, estimatedCostUsd: 0, modelCalls: 0, toolCalls: 0 } });
api.listSessions = async () => {
  if (control.historyFails && control.creates.length) throw new Error('History temporarily unavailable');
  return [summary(existingId), ...(control.accepted.size ? [summary(createdId)] : [])];
};
api.snapshot = async id => ({ session: summary(id), steering: [], events: query.has('running')
  ? [{ id: 'event_initial', seq: 1, sessionId: id, turnId: 'turn_initial', at: new Date().toISOString(), type: 'turn.started', data: { content: 'Original task', clientMessageId: 'input_initial' } }]
  : control.acknowledgeSend && control.sends.length ? control.sends.map((body, index) => ({ id: 'accepted_' + index, seq: index + 1, sessionId: id, turnId: 'turn_' + index, at: new Date().toISOString(), type: 'turn.started', data: { content: body.message.text, clientMessageId: body.clientMessageId } })) : [],
  workspace: [], artifacts: [], processes: [], repository: null, plan: null,
  website: { status: 'stopped', updatedAt: '', restartCount: 0 }, deployment: { status: 'not_deployed', revision: 0, updatedAt: '' } });
api.listAgentModels = async () => [{ id: 'fixture', publicName: 'fixture', displayName: 'Fixture' }];
api.creditBalance = async () => ({ creditsRemaining: 10, dailyFreeCredits: 10, refreshedAt: '' });
api.githubConnection = async () => ({ status: 'disconnected' });
api.githubStatus = async () => ({});
window.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body || '{}'));
  if (String(url).endsWith('/create-chat')) {
    control.creates.push(body);
    if (!control.accepted.has(body.message.id)) control.accepted.set(body.message.id, createdId);
    if (control.failCreate-- > 0) throw new TypeError('Create receipt lost');
    return new Response(JSON.stringify({ id: control.accepted.get(body.message.id) }), { headers: { 'content-type': 'application/json' } });
  }
  if (String(url).endsWith('/messages')) {
    control.sends.push(body);
    if (control.failSend-- > 0) throw new TypeError('Send receipt lost');
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }
  if (String(url).endsWith('/stop')) {
    control.stops.push(body);
    if (control.delayStop) await new Promise(resolve => { control.finishStop = resolve; });
    return new Response('{"ok":true,"cancelled":false}', { status: 202, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('Unexpected fixture fetch: ' + url);
};
window.EventSource = class { constructor(url) { this.url = url; } addEventListener(type, listener) { control.sources[this.url] = listener; } close() {} };
history.replaceState({}, '', query.has('existing') || query.has('running') ? '/agent/' + existingId : '/agent');
createRoot(document.getElementById('root')).render(<App />);
`

let server: ViteDevServer
let browser: Browser
let page: Page
let origin: string

beforeAll(async () => {
  server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'isolated-submission-identity-fixture',
    configureServer(instance) {
      instance.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/submission-fixture') return next()
        response.setHeader('content-type', 'text/html')
        response.end('<!doctype html><html lang="en"><head><title>Submission identity fixture</title></head><body><div id="root"></div><script type="module" src="/submission-fixture.tsx"></script></body></html>')
      })
    },
    resolveId: id => id === '/submission-fixture.tsx' ? '\0submission-fixture.tsx' : undefined,
    load: id => id === '\0submission-fixture.tsx' ? fixture : undefined,
    async transform(source, id) {
      if (id === '\0submission-fixture.tsx') return { code: (await transformWithEsbuild(source, 'fixture.tsx', { jsx: 'automatic' })).code }
    },
  }] })
  await server.listen()
  origin = server.resolvedUrls!.local[0]
  browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true })
}, 30_000)
afterEach(async () => { await page?.close() })
afterAll(async () => { await browser?.close(); await server?.close() })

async function openFixture(query = '') {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(3_000)
  await page.goto(new URL('/submission-fixture' + query, origin).href)
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor()
}

async function waitForAcceptedDraftClear() {
  await page.waitForFunction(() => document.querySelector('[aria-label="Message"]')?.textContent === ''
    && !document.querySelector('.composer-operation-status'))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

describe('uncertain submission receipts', () => {
  it('reuses the first message UUID after a lost create receipt, and clears the accepted draft', async () => {
    await openFixture()
    const editor = page.getByRole('textbox', { name: 'Message', exact: true })
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    await editor.fill('A single new task')
    await send.click()
    await page.getByText('Create receipt lost', { exact: true }).waitFor()
    expect(await editor.textContent()).toBe('A single new task')
    await send.click()
    await page.waitForURL('**/agent/ses_' + 'c'.repeat(20))
    await waitForAcceptedDraftClear()
    const result = await page.evaluate(() => {
      const control = (window as any).fixture
      return { ids: control.creates.map((body: any) => body.message.id), accepted: control.accepted.size }
    })
    expect(result.ids).toHaveLength(2)
    expect(result.ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(result.ids[1]).toBe(result.ids[0])
    expect(result.accepted).toBe(1)
  })

  it('reuses an uncertain follow-up, releases a successful identity, and rotates after draft changes', async () => {
    await openFixture('?existing=1')
    const editor = page.getByRole('textbox', { name: 'Message', exact: true })
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    await editor.fill('Same task')
    await send.click()
    await page.getByText('Send receipt lost', { exact: true }).waitFor()
    await send.click()
    await waitForAcceptedDraftClear()
    await page.evaluate(() => { (window as any).fixture.failSend = 1 })
    await editor.fill('Same task')
    await send.click()
    await page.getByText('Send receipt lost', { exact: true }).waitFor()
    await editor.fill('Changed task')
    await send.click()
    await waitForAcceptedDraftClear()
    const ids = await page.evaluate(() => (window as any).fixture.sends.map((body: any) => body.clientMessageId))
    expect(ids).toHaveLength(4)
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[1])
    expect(ids[3]).not.toBe(ids[2])
  })

  it('does not turn a confirmed creation into a resend when history refresh fails', async () => {
    await openFixture()
    await page.evaluate(() => { Object.assign((window as any).fixture, { failCreate: 0, historyFails: true }) })
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Already accepted')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForURL('**/agent/ses_' + 'c'.repeat(20))
    await page.getByText('History temporarily unavailable', { exact: true }).waitFor()
    expect(await page.getByRole('textbox', { name: 'Message', exact: true }).textContent()).toBe('')
    expect(await page.evaluate(() => (window as any).fixture.creates.length)).toBe(1)
  })

  it('recovers an accepted follow-up from its durable turn after the HTTP receipt is lost', async () => {
    await openFixture('?existing=1')
    await page.evaluate(() => { (window as any).fixture.acknowledgeSend = true })
    const editor = page.getByRole('textbox', { name: 'Message', exact: true })
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    await editor.fill('Accepted despite disconnect')
    await send.click()
    await waitForAcceptedDraftClear()
    expect(await page.getByText('Send receipt lost', { exact: true }).count()).toBe(0)
    await editor.fill('Accepted despite disconnect')
    await send.click()
    await waitForAcceptedDraftClear()
    const ids = await page.evaluate(() => (window as any).fixture.sends.map((body: any) => body.clientMessageId))
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('keeps a delayed Stop scoped to the observed turn when a later resumed run arrives', async () => {
    await openFixture('?running=1')
    await page.evaluate(() => { (window as any).fixture.delayStop = true })
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
    await page.evaluate(() => {
      const control = (window as any).fixture
      const sessionId = 'ses_' + 'a'.repeat(20)
      const listener = Object.values(control.sources)[0] as (event: unknown) => void
      listener({ data: JSON.stringify({ id: 'event_resume', seq: 2, sessionId, turnId: 'turn_later', type: 'run.resumed', at: new Date().toISOString(), data: {} }) })
      control.finishStop()
      control.delayStop = false
    })
    expect(await page.evaluate(() => (window as any).fixture.stops[0])).toEqual({ targetTurnId: 'turn_initial', targetInputId: 'input_initial' })
    await page.getByRole('button', { name: 'Stop agent', exact: true }).click()
    expect(await page.evaluate(() => (window as any).fixture.stops[1])).toEqual({ targetTurnId: 'turn_later' })
  })
})
