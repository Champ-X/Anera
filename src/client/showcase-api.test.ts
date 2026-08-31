import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentModelOption,
  SessionSnapshot,
  SessionSummary,
  WorkspaceInventoryPage,
} from '../shared/types.js'
import {
  clearShowcaseReplayLimits,
  setShowcaseReplayLimit,
  showcaseCatalog,
  showcaseReplayCheckpoints,
  showcaseRequest,
  showcaseSnapshot,
} from './showcase-api.js'
import {
  SHOWCASE_DEFAULT_SESSION_ID,
  normalizedShowcasePath,
  showcaseAssetUrl,
  showcasePageForPath,
} from './showcase-mode.js'

function installBrowser(pathname = '/') {
  const location = { origin: 'https://anera.example', pathname }
  const replaceState = vi.fn((_state: unknown, _unused: string, path: string | URL | null) => {
    if (path !== null) location.pathname = String(path)
  })
  vi.stubGlobal('window', { location, history: { replaceState } })
  return { location, replaceState }
}

afterEach(() => {
  clearShowcaseReplayLimits()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('static showcase catalog and fixtures', () => {
  it('keeps every catalog entry backed by one matching immutable Session snapshot', () => {
    expect(showcaseCatalog.defaultSessionId).toBe(SHOWCASE_DEFAULT_SESSION_ID)
    expect(showcaseCatalog.demos).toHaveLength(4)

    for (const demo of showcaseCatalog.demos) {
      const first = showcaseSnapshot(demo.id)
      expect(first.session.id).toBe(demo.id)
      expect(first.session.title).toBe(demo.title)
      expect(first.events.length).toBeGreaterThan(0)
      expect(first.events.every((event) => event.sessionId === demo.id)).toBe(true)

      const originalTitle = first.session.title
      const originalEventCount = first.events.length
      first.session.title = 'mutated test title'
      first.events.pop()

      const second = showcaseSnapshot(demo.id)
      expect(second.session.title).toBe(originalTitle)
      expect(second.events).toHaveLength(originalEventCount)
    }
  })

  it('fails closed for a Session that is not in the exhibit fixture', () => {
    expect(() => showcaseSnapshot('ses_00000000000000000000')).toThrow('Showcase session not found')
    expect(showcaseReplayCheckpoints('ses_00000000000000000000')).toEqual([])
  })
})

describe('static showcase request adapter', () => {
  it('routes the shared client API through the adapter when the static build flag is enabled', async () => {
    installBrowser()
    const fetchMock = vi.fn(() => Promise.reject(new Error('network must stay disabled')))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('VITE_STATIC_SHOWCASE', 'true')
    vi.resetModules()

    const { api } = await import('./api.js')
    const sessions = await api.listSessions()
    const snapshot = await api.snapshot(SHOWCASE_DEFAULT_SESSION_ID)
    const inventory = await api.workspaceInventory(SHOWCASE_DEFAULT_SESSION_ID, undefined, 1)

    expect(sessions.map((session) => session.id)).toEqual(showcaseCatalog.demos.map((demo) => demo.id))
    expect(snapshot.session.id).toBe(SHOWCASE_DEFAULT_SESSION_ID)
    expect(inventory.hasMore).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves Session, inventory, model, credit, and connector reads without calling fetch', async () => {
    installBrowser()
    const fetchMock = vi.fn(() => Promise.reject(new Error('network must stay disabled')))
    vi.stubGlobal('fetch', fetchMock)

    const firstList = await showcaseRequest<{ sessions: SessionSummary[] }>('/api/sessions')
    expect(firstList.sessions.map((session) => session.id)).toEqual(showcaseCatalog.demos.map((demo) => demo.id))
    firstList.sessions.pop()
    const secondList = await showcaseRequest<{ sessions: SessionSummary[] }>('/api/sessions')
    expect(secondList.sessions).toHaveLength(showcaseCatalog.demos.length)

    const snapshot = await showcaseRequest<SessionSnapshot>(`/api/sessions/${SHOWCASE_DEFAULT_SESSION_ID}`)
    expect(snapshot).toEqual(showcaseSnapshot(SHOWCASE_DEFAULT_SESSION_ID))

    const inventory = await showcaseRequest<WorkspaceInventoryPage>(
      `/api/sessions/${SHOWCASE_DEFAULT_SESSION_ID}/workspace-inventory?limit=1`,
    )
    expect(inventory.hasMore).toBe(false)
    expect(inventory.truncated).toBe(false)
    expect(inventory.loadedEntries).toBe(inventory.entries.length)
    expect(inventory.totalFiles).toBe(inventory.entries.filter((entry) => entry.type === 'file').length)
    expect(inventory.entries.every((entry) => entry.children === undefined)).toBe(true)

    await expect(showcaseRequest<{ models: AgentModelOption[] }>('/api/agent-models')).resolves.toEqual({
      models: [{ id: 'deepseek-chat', publicName: 'DeepSeek V3.1', displayName: 'DeepSeek' }],
    })
    await expect(showcaseRequest('/api/billing/balance')).resolves.toMatchObject({ creditsRemaining: 2500 })
    await expect(showcaseRequest('/api/me/pulse')).resolves.toMatchObject({ pulse: 2500 })
    await expect(showcaseRequest('/api/coding/github/connection')).resolves.toEqual({ status: 'disconnected' })
    await expect(showcaseRequest('/api/coding/github/status')).resolves.toEqual({
      indicator: 'none', description: 'All Systems Operational',
    })
    await expect(showcaseRequest('/api/coding/github/repos?limit=100')).resolves.toEqual({
      repos: [], nextCursor: null, hasNextPage: false,
    })
    await expect(showcaseRequest('/api/coding/github/branches?repoId=1')).resolves.toEqual({
      branches: [], nextCursor: null, hasNextPage: false,
    })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps mutation fallbacks inert and never delegates unknown endpoints to the network', async () => {
    installBrowser()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(showcaseRequest('/api/sessions/ses_00000000000000000000/messages', {
      method: 'POST', body: JSON.stringify({ message: { text: 'must not run' } }),
    })).resolves.toEqual({})
    await expect(showcaseRequest('/api/chat/ses_00000000000000000000/review-feedback', {
      method: 'POST', body: JSON.stringify({ sessionNodeId: 'evt_final', action: 'approve' }),
    })).resolves.toEqual({ sessionNodeId: 'evt_final', action: 'approve' })
    await expect(showcaseRequest('/api/not-in-the-static-contract')).rejects.toThrow(
      'Static showcase endpoint is unavailable: /api/not-in-the-static-contract',
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('static showcase replay', () => {
  it('publishes sorted unique checkpoints ending at the final durable event', () => {
    const snapshot = showcaseSnapshot(SHOWCASE_DEFAULT_SESSION_ID)
    const checkpoints = showcaseReplayCheckpoints(SHOWCASE_DEFAULT_SESSION_ID)
    const sorted = [...checkpoints].sort((left, right) => left - right)

    expect(checkpoints).toEqual(sorted)
    expect(new Set(checkpoints).size).toBe(checkpoints.length)
    expect(checkpoints.length).toBeGreaterThan(10)
    expect(checkpoints.at(-1)).toBe(snapshot.events.at(-1)?.seq)
  })

  it('filters events, usage, Workspace, Artifact, and status at the selected replay boundary', () => {
    const full = showcaseSnapshot(SHOWCASE_DEFAULT_SESSION_ID)
    const artifactEvent = full.events.find((event) => event.type === 'artifact.created')
    expect(artifactEvent).toBeDefined()
    const checkpoints = showcaseReplayCheckpoints(SHOWCASE_DEFAULT_SESSION_ID)
    const beforeArtifact = checkpoints.filter((seq) => seq < artifactEvent!.seq).at(-1)
    expect(beforeArtifact).toBeDefined()

    setShowcaseReplayLimit(SHOWCASE_DEFAULT_SESSION_ID, beforeArtifact!)
    const partial = showcaseSnapshot(SHOWCASE_DEFAULT_SESSION_ID)
    expect(partial.events.every((event) => event.seq <= beforeArtifact!)).toBe(true)
    expect(partial.events.length).toBeLessThan(full.events.length)
    expect(partial.session.updatedAt).toBe(partial.events.at(-1)?.at)
    expect(partial.session.status).toBe('running')
    expect(partial.session.usage.totalTokens).toBeLessThanOrEqual(full.session.usage.totalTokens)

    const firstArtifactId = String((artifactEvent!.data as { artifact?: { id?: string } }).artifact?.id)
    expect(partial.artifacts.some((artifact) => artifact.id === firstArtifactId)).toBe(false)

    setShowcaseReplayLimit(SHOWCASE_DEFAULT_SESSION_ID, artifactEvent!.seq)
    const withArtifact = showcaseSnapshot(SHOWCASE_DEFAULT_SESSION_ID)
    expect(withArtifact.artifacts.some((artifact) => artifact.id === firstArtifactId)).toBe(true)
    expect(withArtifact.workspaceInventory).toBeDefined()
    expect(withArtifact.workspaceInventory?.loadedEntries ?? 0).toBeGreaterThan(0)

    setShowcaseReplayLimit(SHOWCASE_DEFAULT_SESSION_ID, null)
    expect(showcaseSnapshot(SHOWCASE_DEFAULT_SESSION_ID)).toEqual(full)
  })

  it('clears all per-Session replay boundaries at once', () => {
    const [first, second] = showcaseCatalog.demos
    const firstFull = showcaseSnapshot(first.id)
    const secondFull = showcaseSnapshot(second.id)
    setShowcaseReplayLimit(first.id, showcaseReplayCheckpoints(first.id)[0])
    setShowcaseReplayLimit(second.id, showcaseReplayCheckpoints(second.id)[0])
    expect(showcaseSnapshot(first.id).events.length).toBeLessThan(firstFull.events.length)
    expect(showcaseSnapshot(second.id).events.length).toBeLessThan(secondFull.events.length)

    clearShowcaseReplayLimits()
    expect(showcaseSnapshot(first.id)).toEqual(firstFull)
    expect(showcaseSnapshot(second.id)).toEqual(secondFull)
  })
})

describe('static showcase URL and page routing', () => {
  it('maps safe artifact paths segment-by-segment and rejects traversal-shaped input', () => {
    expect(showcaseAssetUrl(
      SHOWCASE_DEFAULT_SESSION_ID,
      'nested folder/报告 #1.html',
    )).toBe(
      `/showcase/artifacts/${SHOWCASE_DEFAULT_SESSION_ID}/nested%20folder/%E6%8A%A5%E5%91%8A%20%231.html`,
    )
    expect(() => showcaseAssetUrl('ses_invalid', 'index.html')).toThrow('Invalid showcase session id')
    for (const path of ['', '/index.html', 'nested//index.html', './index.html', '../index.html']) {
      expect(() => showcaseAssetUrl(SHOWCASE_DEFAULT_SESSION_ID, path)).toThrow('Invalid showcase asset path')
    }
  })

  it('classifies public routes and canonicalizes the demo alias without touching Session paths', () => {
    expect(showcasePageForPath('/')).toBe('landing')
    expect(showcasePageForPath('/report')).toBe('report')
    expect(showcasePageForPath('/report/')).toBe('report')
    expect(showcasePageForPath('/demo')).toBe('demo')
    expect(showcasePageForPath(`/agent/${SHOWCASE_DEFAULT_SESSION_ID}`)).toBe('demo')

    expect(normalizedShowcasePath('/demo')).toBe(`/agent/${SHOWCASE_DEFAULT_SESSION_ID}`)
    expect(normalizedShowcasePath('/demo/')).toBe(`/agent/${SHOWCASE_DEFAULT_SESSION_ID}`)
    expect(normalizedShowcasePath('/report')).toBe('/report')
    expect(normalizedShowcasePath(`/agent/${SHOWCASE_DEFAULT_SESSION_ID}`)).toBe(
      `/agent/${SHOWCASE_DEFAULT_SESSION_ID}`,
    )
  })

  it('can apply the normalized alias through a browser history adapter', () => {
    const browser = installBrowser('/demo')
    const normalized = normalizedShowcasePath(browser.location.pathname)
    if (normalized !== browser.location.pathname) window.history.replaceState({}, '', normalized)

    expect(browser.replaceState).toHaveBeenCalledWith({}, '', `/agent/${SHOWCASE_DEFAULT_SESSION_ID}`)
    expect(browser.location.pathname).toBe(`/agent/${SHOWCASE_DEFAULT_SESSION_ID}`)
  })
})
