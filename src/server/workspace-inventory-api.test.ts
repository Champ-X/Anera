import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceEntry } from '../shared/types.js'
import { createApp } from './app.js'
import { WORKSPACE_INVENTORY_TTL_MS } from './workspace-inventory.js'

interface WorkspaceInventoryMetadata {
  hasMore: boolean
  nextCursor?: string
  truncated: boolean
  totalFiles: number
  loadedEntries: number
  fileLimitHit: boolean
  entryLimitHit: boolean
  totalFilesIsLowerBound: boolean
}

interface WorkspaceInventoryResponse extends WorkspaceInventoryMetadata {
  entries: Array<{
    name: string
    path: string
    type: 'directory' | 'file'
    size?: number
  }>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe('workspace inventory API', () => {
  it('makes a >500-entry snapshot explicit and pages the same immutable root inventory without gaps', async () => {
    const fixture = await startFixture('anera-workspace-inventory-pages-')
    const session = await fixture.created.store.create()
    const workspace = fixture.created.store.workspaceDir(session.summary.id)
    const expectedPaths = await writeNumberedFiles(workspace, 503)

    const snapshotResponse = await fetch(`${fixture.base}/api/sessions/${session.summary.id}`)
    expect(snapshotResponse.status).toBe(200)
    const snapshot = await snapshotResponse.json() as {
      workspace: WorkspaceEntry[]
      workspaceInventory: WorkspaceInventoryMetadata
    }
    expect(flattenWorkspaceFiles(snapshot.workspace)).toEqual(expectedPaths.slice(0, 500))
    expect(snapshot.workspaceInventory).toEqual({
      hasMore: true,
      nextCursor: expect.any(String),
      truncated: false,
      totalFiles: 503,
      loadedEntries: 500,
      fileLimitHit: false,
      entryLimitHit: false,
      totalFilesIsLowerBound: false,
    })

    const snapshotRemainder = await getInventoryPage(
      fixture.base,
      session.summary.id,
      new URLSearchParams({ cursor: snapshot.workspaceInventory.nextCursor! }),
    )
    expect(snapshotRemainder).toEqual({
      entries: expectedPaths.slice(500).map((path, index) => ({
        name: path,
        path,
        type: 'file',
        size: Buffer.byteLength(`${index + 500}\n`),
      })),
      hasMore: false,
      truncated: false,
      totalFiles: 503,
      loadedEntries: 3,
      fileLimitHit: false,
      entryLimitHit: false,
      totalFilesIsLowerBound: false,
    })

    const pages: WorkspaceInventoryResponse[] = []
    let cursor: string | undefined
    do {
      const query = new URLSearchParams({ limit: '200', path: 'must-not-scope-the-http-root-inventory' })
      if (cursor) query.set('cursor', cursor)
      const page = await getInventoryPage(fixture.base, session.summary.id, query)
      pages.push(page)
      cursor = page.nextCursor
    } while (cursor)

    expect(pages.map((page) => page.loadedEntries)).toEqual([200, 200, 103])
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false])
    expect(pages.every((page) => (
      page.totalFiles === 503
      && page.truncated === false
      && page.fileLimitHit === false
      && page.entryLimitHit === false
      && page.totalFilesIsLowerBound === false
    ))).toBe(true)
    expect(pages.flatMap((page) => page.entries.map((entry) => entry.path))).toEqual(expectedPaths)
  }, 20_000)

  it('fails closed for malformed, cross-session, and parameter-mismatched cursors', async () => {
    const fixture = await startFixture('anera-workspace-inventory-cursor-')
    const first = await fixture.created.store.create()
    const second = await fixture.created.store.create()
    await writeNumberedFiles(fixture.created.store.workspaceDir(first.summary.id), 3)

    const firstPage = await getInventoryPage(
      fixture.base,
      first.summary.id,
      new URLSearchParams({ limit: '1' }),
    )
    expect(firstPage.nextCursor).toEqual(expect.any(String))

    for (const [sessionId, query] of [
      [second.summary.id, new URLSearchParams({ cursor: firstPage.nextCursor!, limit: '1' })],
      [first.summary.id, new URLSearchParams({ cursor: firstPage.nextCursor!, limit: '2' })],
      [first.summary.id, new URLSearchParams({ cursor: 'not-an-inventory-cursor', limit: '1' })],
    ] as const) {
      const response = await fetch(`${fixture.base}/api/sessions/${sessionId}/workspace-inventory?${query}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: expect.stringMatching(/cursor|continuation/i),
        code: expect.stringMatching(/cursor/i),
      })
    }

    for (const query of ['limit=0', 'limit=501', 'limit=1.5', 'limit=1x', 'limit=1&limit=2', 'cursor=']) {
      const response = await fetch(`${fixture.base}/api/sessions/${first.summary.id}/workspace-inventory?${query}`)
      expect(response.status).toBe(400)
    }

    const missingSession = `ses_${'z'.repeat(20)}`
    const missing = await fetch(`${fixture.base}/api/sessions/${missingSession}/workspace-inventory?cursor=malformed`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'Session not found' })

    const expiredAt = Date.now() + WORKSPACE_INVENTORY_TTL_MS + 1
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiredAt)
    try {
      const expired = await fetch(
        `${fixture.base}/api/sessions/${first.summary.id}/workspace-inventory?cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      )
      expect(expired.status).toBe(410)
      expect(await expired.json()).toMatchObject({ code: 'cursor_expired', error: expect.stringMatching(/expired/i) })
    } finally {
      clock.mockRestore()
    }

    const manifestDirectory = resolve(
      fixture.created.store.sessionDir(first.summary.id),
      'workspace-inventory',
      'ui',
    )
    const manifestNames = (await readdir(manifestDirectory)).filter((name) => name.endsWith('.json'))
    expect(manifestNames).toHaveLength(1)
    await writeFile(resolve(manifestDirectory, manifestNames[0]), '{"manifest":')
    const corrupt = await fetch(
      `${fixture.base}/api/sessions/${first.summary.id}/workspace-inventory?cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    )
    expect(corrupt.status).toBe(400)
    expect(await corrupt.json()).toMatchObject({ code: 'cursor_corrupt', error: expect.stringMatching(/manifest/i) })
  })

  it('retains empty directories and file sizes when converting the first flat page to the legacy tree', async () => {
    const fixture = await startFixture('anera-workspace-inventory-tree-')
    const session = await fixture.created.store.create()
    const workspace = fixture.created.store.workspaceDir(session.summary.id)
    await mkdir(resolve(workspace, 'empty'))
    await mkdir(resolve(workspace, 'nested'))
    await writeFile(resolve(workspace, 'nested', 'child.txt'), 'child')
    await writeFile(resolve(workspace, 'root.txt'), 'root')

    const response = await fetch(`${fixture.base}/api/sessions/${session.summary.id}`)
    expect(response.status).toBe(200)
    const snapshot = await response.json() as {
      workspace: WorkspaceEntry[]
      workspaceInventory: WorkspaceInventoryMetadata
    }
    expect(snapshot.workspace).toEqual([
      { name: 'empty', path: 'empty', type: 'directory', children: [] },
      {
        name: 'nested',
        path: 'nested',
        type: 'directory',
        children: [{ name: 'child.txt', path: 'nested/child.txt', type: 'file', size: 5 }],
      },
      { name: 'root.txt', path: 'root.txt', type: 'file', size: 4 },
    ])
    expect(snapshot.workspaceInventory).toEqual({
      hasMore: false,
      truncated: false,
      totalFiles: 2,
      loadedEntries: 4,
      fileLimitHit: false,
      entryLimitHit: false,
      totalFilesIsLowerBound: false,
    })
  })

  it('marks the exposed file total as a lower bound when the 10K support cap is reached', async () => {
    const fixture = await startFixture('anera-workspace-inventory-cap-')
    const session = await fixture.created.store.create()
    await writeNumberedFiles(fixture.created.store.workspaceDir(session.summary.id), 10_001)

    const response = await fetch(`${fixture.base}/api/sessions/${session.summary.id}`)
    expect(response.status).toBe(200)
    const snapshot = await response.json() as { workspaceInventory: WorkspaceInventoryMetadata }
    expect(snapshot.workspaceInventory).toEqual({
      hasMore: true,
      nextCursor: expect.any(String),
      truncated: true,
      totalFiles: 10_001,
      loadedEntries: 500,
      fileLimitHit: true,
      entryLimitHit: false,
      totalFilesIsLowerBound: true,
    })
  }, 30_000)
})

async function startFixture(prefix: string): Promise<{
  base: string
  created: Awaited<ReturnType<typeof createApp>>
}> {
  const root = await mkdtemp(resolve(tmpdir(), prefix))
  const created = await createApp({ dataRoot: resolve(root, 'data'), model: 'test-model' })
  const server = createServer(created.app)
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  cleanups.push(async () => {
    await created.agent.shutdown()
    await closeServer(server)
    await rm(root, { recursive: true, force: true })
  })
  return { base: `http://127.0.0.1:${address.port}`, created }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => {
    if (error) rejectClose(error)
    else resolveClose()
  }))
}

async function writeNumberedFiles(workspace: string, count: number): Promise<string[]> {
  const paths = Array.from({ length: count }, (_, index) => `file-${String(index).padStart(4, '0')}.txt`)
  for (let offset = 0; offset < paths.length; offset += 100) {
    await Promise.all(paths.slice(offset, offset + 100).map(async (path, index) => {
      const absoluteIndex = offset + index
      await writeFile(resolve(workspace, path), `${absoluteIndex}\n`)
    }))
  }
  return paths
}

async function getInventoryPage(base: string, sessionId: string, query: URLSearchParams): Promise<WorkspaceInventoryResponse> {
  const response = await fetch(`${base}/api/sessions/${sessionId}/workspace-inventory?${query}`)
  expect(response.status).toBe(200)
  return await response.json() as WorkspaceInventoryResponse
}

function flattenWorkspaceFiles(entries: WorkspaceEntry[]): string[] {
  return entries.flatMap((entry) => entry.type === 'file'
    ? [entry.path]
    : flattenWorkspaceFiles(entry.children ?? []))
}
