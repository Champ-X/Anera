import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, transformWithEsbuild, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { findBrowserExecutable } from '../server/browser-executable.js'

// Actual React components, isolated from the application server and all user data.
// Deferred API receipts make races deterministic instead of relying on sleeps.
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, Composer } from '/src/client/App.tsx';
import { WorkspaceVersionsDialog } from '/src/client/WorkspaceVersionsDialog.tsx';
import { api } from '/src/client/api.ts';
import '/src/client/styles.css';
const control = window.fixture = { restoreCalls: 0, refreshCalls: 0, closeCalls: 0, steeringCalls: [], pendingDiffs: {} };
const versions = ['one', 'two'].map(id => ({ id, label: id, reason: 'manual', createdAt: '2026-09-26T12:00:00Z', fileCount: 1, bytes: 12 }));
const comparison = (id, against) => ({ fromVersionId: id, against, added: 0, modified: 1, deleted: 0, changes: [{ path: id + '.txt', kind: 'modified', beforeText: 'saved', afterText: 'current' }] });
api.workspaceVersions = async () => ({ versions });
api.workspaceVersionDiff = (session, id, against) => control.delayDiff
  ? new Promise(resolve => { control.pendingDiffs[id + ':' + against] = () => resolve(comparison(id, against)); })
  : Promise.resolve(comparison(id, against));
api.restoreWorkspaceVersion = async () => { control.restoreCalls++; if (control.delayRestore) await new Promise(resolve => { control.finishRestore = resolve; }); return {}; };
function Fixture() {
  const [dialog, setDialog] = useState(false);
  const [draftCommand, setDraftCommand] = useState();
  control.open = () => setDialog(true);
  control.unmount = () => setDialog(false);
  control.draft = value => setDraftCommand({ id: Date.now(), sessionId: 'fixture', value, attachments: [] });
  return <><button onClick={() => setDialog(true)}>Open versions</button>
    <Composer sessionId="fixture" draftCommand={draftCommand} running steeringEnabled resumable={false}
      isFreeSession={false} models={[]} modelSelection={null} modelListUnavailable={false} codingMode={false}
      connectionsOpen={false} connectionsEnabled={false} onRemoveCustomFeedback={() => {}} onDraftStateChange={() => {}}
      onError={() => {}} onConnections={() => {}} onSend={async () => {}} onStop={async () => {}} onResume={async () => {}} onNewChat={async () => {}}
      onSteer={(content, clientMessageId) => { control.steeringCalls.push({ content, clientMessageId }); return new Promise((resolve, reject) => { control.finishSteering = resolve; control.failSteering = reject; }); }} />
    {dialog && <WorkspaceVersionsDialog sessionId="fixture" busy={false} onClose={() => { control.closeCalls++; setDialog(false); }}
      onRestored={async () => { control.refreshCalls++; if (control.refreshCalls === 1 && control.failRefresh) throw new Error('snapshot offline'); }} />}
  </>;
}
const appMode = new URLSearchParams(location.search).has('app');
if (appMode) {
  const sessions = ['a', 'b'].map(letter => ({ id: 'ses_' + letter.repeat(20), title: 'Session ' + letter.toUpperCase(), status: 'running', model: 'fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workspaceBytes: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0, estimatedCostUsd: 0, modelCalls: 0, toolCalls: 0 } }));
  api.listSessions = async () => sessions;
  api.snapshot = async id => ({ session: sessions.find(item => item.id === id), steering: [], events: [], workspace: [], artifacts: [], processes: [], repository: null, plan: null,
    website: { status: 'stopped', updatedAt: '', restartCount: 0 }, deployment: { status: 'not_deployed', revision: 0, updatedAt: '' } });
  api.listAgentModels = async () => [{ id: 'fixture', label: 'Fixture', model: 'fixture', available: true }];
  api.creditBalance = async () => ({ creditsRemaining: 10, dailyFreeCredits: 10, refreshedAt: '' });
  api.githubConnection = async () => ({ status: 'disconnected' });
  api.githubStatus = async () => ({});
  control.steering = {};
  control.sources = {};
  api.steer = (id, content, clientMessageId) => new Promise((resolve, reject) => { control.steering[id] = { resolve, reject }; });
  window.EventSource = class { constructor(url) { this.url = url; } addEventListener(type, listener) { control.sources[this.url] = listener; } close() {} };
  history.replaceState({}, '', '/agent/' + sessions[0].id);
}
createRoot(document.getElementById('root')).render(appMode ? <App /> : <Fixture />);
`

let server: ViteDevServer
let browser: Browser
let page: Page
let origin: string
beforeAll(async () => {
  server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'isolated-collaboration-fixture',
    configureServer(instance) {
      instance.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/collaboration-fixture') return next()
        response.setHeader('content-type', 'text/html')
        response.end('<!doctype html><html lang="en"><head><title>Collaboration fixture</title></head><body><div id="root"></div><script type="module" src="/collaboration-fixture.tsx"></script></body></html>')
      })
    },
    resolveId: (id) => id === '/collaboration-fixture.tsx' ? '\0collaboration-fixture.tsx' : undefined,
    load: (id) => id === '\0collaboration-fixture.tsx' ? fixture : undefined,
    async transform(source, id) {
      if (id === '\0collaboration-fixture.tsx') return { code: (await transformWithEsbuild(source, 'fixture.tsx', { jsx: 'automatic' })).code }
    },
  }] })
  await server.listen()
  origin = server.resolvedUrls!.local[0]
  browser = await chromium.launch({ executablePath: findBrowserExecutable(), headless: true })
}, 30_000)
afterEach(async () => { await page?.close() })
afterAll(async () => { await browser?.close(); await server?.close() })

async function openFixture() {
  page = await browser.newPage()
  await page.goto(new URL('/collaboration-fixture', origin).href)
  await page.getByRole('button', { name: 'Open versions', exact: true }).waitFor()
}

describe('continuous collaboration interactions', () => {
  it('does not surface a previous session failure or clear another session pending submission', async () => {
    page = await browser.newPage()
    page.setDefaultTimeout(2_000)
    await page.goto(new URL('/collaboration-fixture?app=1', origin).href)
    const firstId = 'ses_' + 'a'.repeat(20)
    const secondId = 'ses_' + 'b'.repeat(20)
    await page.getByRole('button', { name: 'Add instructions', exact: true }).waitFor()
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('First session correction')
    await page.getByRole('button', { name: 'Add instructions', exact: true }).click()
    await page.getByTitle('Session B', { exact: true }).click()
    await page.getByRole('button', { name: 'Add instructions', exact: true }).waitFor()
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Second session correction')
    await page.getByRole('button', { name: 'Add instructions', exact: true }).click()
    await page.evaluate(({ firstId, secondId }) => {
      const control = (window as any).fixture
      control.steering[firstId].reject(new Error('Failure belongs only to Session A'))
      control.sources['/api/sessions/' + secondId + '/events?after=0']({ data: JSON.stringify({ id: 'completed', seq: 1, sessionId: secondId, at: new Date().toISOString(), type: 'run.status', data: { status: 'completed' } }) })
    }, { firstId, secondId })
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
    // Flush the failed request's snapshot recovery and finally handler.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(await page.getByText('Failure belongs only to Session A', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled()).toBe(true)
    expect(await page.getByRole('textbox', { name: 'Message', exact: true }).textContent()).toBe('Second session correction')
  })

  it('retries only refresh after a committed restore, and returns keyboard focus on close', async () => {
    await openFixture()
    await page.evaluate(() => { (window as any).fixture.failRefresh = true })
    await page.getByRole('button', { name: 'Open versions', exact: true }).click()
    await page.getByRole('button', { name: 'Restore version', exact: true }).click()
    await page.getByRole('button', { name: 'Retry refresh', exact: true }).waitFor()
    expect(await page.getByRole('alert').textContent()).toContain('Workspace restored, but refreshing the view failed')
    expect(await page.getByRole('button', { name: 'Restore version', exact: true }).isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: 'Save version', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: 'Retry refresh', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    expect(await page.evaluate(() => ({ restores: (window as any).fixture.restoreCalls, refreshes: (window as any).fixture.refreshCalls })))
      .toEqual({ restores: 1, refreshes: 2 })
    expect(await page.getByRole('button', { name: 'Open versions', exact: true }).evaluate((button) => button === document.activeElement)).toBe(true)
    await page.getByRole('button', { name: 'Open versions', exact: true }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
  })

  it('keeps restore disabled for pending or historical comparisons and ignores late comparison results', async () => {
    await openFixture()
    await page.evaluate(() => { (window as any).fixture.delayDiff = true })
    await page.getByRole('button', { name: 'Open versions', exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.pendingDiffs['one:current'])
    await page.getByLabel('Saved version', { exact: true }).selectOption('two')
    await page.waitForFunction(() => (window as any).fixture.pendingDiffs['two:current'])
    expect(await page.getByRole('button', { name: 'Restore version', exact: true }).isDisabled()).toBe(true)
    await page.evaluate(() => { (window as any).fixture.pendingDiffs['two:current'](); (window as any).fixture.pendingDiffs['one:current']() })
    await page.getByText('two.txt', { exact: true }).waitFor()
    expect(await page.getByText('one.txt', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Restore version', exact: true }).isEnabled()).toBe(true)
    await page.getByLabel('Compare with', { exact: true }).selectOption('one')
    await page.waitForFunction(() => (window as any).fixture.pendingDiffs['two:one'])
    await page.evaluate(() => (window as any).fixture.pendingDiffs['two:one']())
    await page.getByText('two.txt', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Restore version', exact: true }).isDisabled()).toBe(true)
  })

  it('does not refresh or close a different view when a restore finishes after unmount', async () => {
    await openFixture()
    await page.evaluate(() => { (window as any).fixture.delayRestore = true })
    await page.getByRole('button', { name: 'Open versions', exact: true }).click()
    await page.getByRole('button', { name: 'Restore version', exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.finishRestore)
    await page.evaluate(() => (window as any).fixture.unmount())
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.evaluate(async () => { (window as any).fixture.finishRestore(); await new Promise(resolve => requestAnimationFrame(resolve)) })
    expect(await page.evaluate(() => ({ refreshes: (window as any).fixture.refreshCalls, closes: (window as any).fixture.closeCalls })))
      .toEqual({ refreshes: 0, closes: 0 })
  })

  it('preserves newer drafts and reuses the same steering identity after an uncertain receipt', async () => {
    await openFixture()
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('First correction')
    await page.getByRole('button', { name: 'Add instructions', exact: true }).click()
    await page.evaluate(() => (window as any).fixture.failSteering(new Error('receipt lost')))
    await page.getByRole('button', { name: 'Add instructions', exact: true }).click()
    expect(await page.evaluate(() => (window as any).fixture.steeringCalls)).toEqual([
      expect.objectContaining({ content: 'First correction' }), expect.objectContaining({ content: 'First correction' }),
    ])
    expect(await page.evaluate(() => (window as any).fixture.steeringCalls[0].clientMessageId === (window as any).fixture.steeringCalls[1].clientMessageId)).toBe(true)
    await page.evaluate(() => (window as any).fixture.draft('A newer correction'))
    await page.waitForFunction(() => document.querySelector('[role="textbox"]')?.textContent === 'A newer correction')
    await page.evaluate(() => (window as any).fixture.finishSteering())
    await page.waitForFunction(() => document.querySelector('[role="textbox"]')?.getAttribute('contenteditable') === 'true')
    expect(await page.getByRole('textbox', { name: 'Message', exact: true }).textContent()).toBe('A newer correction')
  })
})
