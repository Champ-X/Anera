import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listWorkspaceEntryInventoryPage,
  listWorkspaceInventoryPage,
  WorkspaceInventoryCursorError,
} from './workspace-inventory.js'
import { writeWorkspaceFile } from './workspace.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; workspace: string; manifests: string }> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-workspace-inventory-'))
  roots.push(root)
  return {
    root,
    workspace: resolve(root, 'workspace'),
    manifests: resolve(root, 'private', 'workspace-inventory-manifests'),
  }
}

describe('persistent Workspace inventory pager', () => {
  it('pages an immutable UTF-8-sorted file manifest and retries a cursor after workspace mutation', async () => {
    const { root, workspace, manifests } = await fixture()
    await writeWorkspaceFile(workspace, 'z-last.txt', 'z')
    await writeWorkspaceFile(workspace, '资料/乙.txt', 'b')
    await writeWorkspaceFile(workspace, '资料/甲.txt', 'a')
    await writeWorkspaceFile(workspace, 'alpha/a.txt', 'a')
    await writeWorkspaceFile(workspace, 'node_modules/private.js', 'hidden')
    await writeWorkspaceFile(resolve(root, 'outside'), 'secret.txt', 'outside')
    await symlink(resolve(root, 'outside'), resolve(workspace, 'linked'))

    const options = {
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      sessionId: 'session-one',
      limit: 2,
      nowMs: 1_000,
    }
    const first = await listWorkspaceInventoryPage(options)
    expect(first.files).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    expect(first.truncated).toBe(false)
    expect(first.totalFiles).toBe(4)
    expect(first.nextCursor).toBeTypeOf('string')
    expect(resolve(manifests).startsWith(resolve(workspace))).toBe(false)

    await writeWorkspaceFile(workspace, '00-added-after-snapshot.txt', 'new')
    await rm(resolve(workspace, 'z-last.txt'))
    const continuationOptions = {
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      sessionId: 'session-one',
      path: '',
      cursor: first.nextCursor,
      nowMs: 2_000,
    }
    const second = await listWorkspaceInventoryPage(continuationOptions)
    const retry = await listWorkspaceInventoryPage(continuationOptions)
    expect(retry).toEqual(second)
    expect(second.hasMore).toBe(false)
    expect([...first.files, ...second.files].map((file) => file.path)).toEqual([
      'alpha/a.txt', 'z-last.txt', '资料/乙.txt', '资料/甲.txt',
    ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))))
  })

  it('preserves empty directories and file sizes in flat entry mode', async () => {
    const { workspace, manifests } = await fixture()
    await writeWorkspaceFile(workspace, 'nested/file.txt', 'hello')
    await writeWorkspaceFile(workspace, 'empty/.keep', '')
    await rm(resolve(workspace, 'empty/.keep'))

    const first = await listWorkspaceEntryInventoryPage({
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      sessionId: 'session-entries',
      limit: 2,
    })
    expect(first.totalEntries).toBe(3)
    expect(first.totalFiles).toBe(1)
    const second = await listWorkspaceEntryInventoryPage({
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      sessionId: 'session-entries',
      cursor: first.nextCursor,
    })
    expect([...first.entries, ...second.entries]).toEqual([
      { name: 'empty', path: 'empty', type: 'directory' },
      { name: 'nested', path: 'nested', type: 'directory' },
      { name: 'file.txt', path: 'nested/file.txt', type: 'file', size: 5 },
    ])
  })

  it('enforces both count and serialized JSON byte budgets', async () => {
    const { workspace, manifests } = await fixture()
    for (let index = 0; index < 8; index += 1) {
      await writeWorkspaceFile(workspace, `${String(index).padStart(2, '0')}-${'长'.repeat(70)}.txt`, 'x')
    }
    const first = await listWorkspaceInventoryPage({
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      sessionId: 'session-budget',
      limit: 5,
      maxJsonBytes: 800,
    })
    expect(first.files.length).toBeGreaterThan(0)
    expect(first.files.length).toBeLessThan(5)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(800)
    expect(first.hasMore).toBe(true)
  })

  it('keeps terminal truncated true and reports at least cap + 1 files', async () => {
    const { workspace, manifests } = await fixture()
    for (let index = 0; index < 5; index += 1) {
      await writeWorkspaceFile(workspace, `${index}.txt`, String(index))
    }
    let page = await listWorkspaceInventoryPage({
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      sessionId: 'session-cap',
      limit: 2,
      supportCap: 3,
    })
    const files = [...page.files]
    while (page.hasMore) {
      page = await listWorkspaceInventoryPage({
        workspaceRoot: workspace,
        manifestDirectory: manifests,
        sessionId: 'session-cap',
        cursor: page.nextCursor,
      })
      files.push(...page.files)
    }
    expect(files).toHaveLength(3)
    expect(page).toMatchObject({ hasMore: false, truncated: true, totalFiles: 4 })
    expect(page.nextCursor).toBeUndefined()
  })

  it('keeps the directory-entry cap distinct from the regular-file cap', async () => {
    const { workspace, manifests } = await fixture()
    await writeWorkspaceFile(workspace, 'a/file.txt', 'one')
    await writeWorkspaceFile(workspace, 'b/.keep', '')
    await rm(resolve(workspace, 'b/.keep'))
    await writeWorkspaceFile(workspace, 'c/.keep', '')
    await rm(resolve(workspace, 'c/.keep'))
    const page = await listWorkspaceEntryInventoryPage({
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      sessionId: 'session-entry-cap',
      supportCap: 2,
      entrySupportCap: 3,
      limit: 3,
    })
    expect(page).toMatchObject({
      truncated: true,
      fileLimitHit: false,
      entryLimitHit: true,
      totalFiles: 1,
      totalFilesIsLowerBound: true,
      totalEntries: 4,
    })
    expect(page.totalFiles).not.toBe(3)
  })

  it('cleans expired manifests and bounds retained manifests across repeated fresh listings', async () => {
    const { workspace, manifests } = await fixture()
    await writeWorkspaceFile(workspace, 'only.txt', 'one')
    await listWorkspaceInventoryPage({
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      sessionId: 'session-cleanup',
      nowMs: 100,
      ttlMs: 1,
    })
    for (let index = 0; index < 70; index += 1) {
      await listWorkspaceInventoryPage({
        workspaceRoot: workspace,
        manifestDirectory: manifests,
        sessionId: 'session-cleanup',
        nowMs: 200 + index,
      })
    }
    const names = await readdir(manifests)
    expect(names).toHaveLength(64)
    expect(names.some((name) => name.endsWith('-101.json'))).toBe(false)
  })

  it('fails closed for tampered, cross-session, path-mismatched, expired, and corrupt cursors', async () => {
    const { workspace, manifests } = await fixture()
    await writeWorkspaceFile(workspace, 'sub/a.txt', 'a')
    await writeWorkspaceFile(workspace, 'sub/b.txt', 'b')
    const first = await listWorkspaceInventoryPage({
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      sessionId: 'session-errors',
      path: 'sub',
      limit: 1,
      nowMs: 100,
      ttlMs: 50,
    })
    const cursor = first.nextCursor as string
    const base = { workspaceRoot: workspace, manifestDirectory: manifests, cursor, path: 'sub' }

    await expect(listWorkspaceInventoryPage({ ...base, sessionId: 'another-session', nowMs: 120 }))
      .rejects.toMatchObject({ code: 'cursor_session_mismatch' })
    await expect(listWorkspaceInventoryPage({ ...base, sessionId: 'session-errors', path: '', nowMs: 120 }))
      .rejects.toMatchObject({ code: 'cursor_path_mismatch' })
    await expect(listWorkspaceInventoryPage({ ...base, sessionId: 'session-errors', nowMs: 150 }))
      .rejects.toMatchObject({ code: 'cursor_expired' })
    await expect(listWorkspaceInventoryPage({
      ...base,
      sessionId: 'session-errors',
      cursor: `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`,
      nowMs: 120,
    })).rejects.toMatchObject({ code: 'invalid_cursor' })

    const [manifestName] = await readdir(manifests)
    const manifestPath = resolve(manifests, manifestName)
    const envelope = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    const widenedManifest = {
      ...(envelope.manifest as Record<string, unknown>),
      maxJsonBytes: 10 * 1024 * 1024,
    }
    await writeFile(manifestPath, JSON.stringify({
      manifest: widenedManifest,
      sha256: createHash('sha256').update(JSON.stringify(widenedManifest)).digest('hex'),
    }))
    await expect(listWorkspaceInventoryPage({ ...base, sessionId: 'session-errors', nowMs: 120 }))
      .rejects.toMatchObject({ code: 'cursor_corrupt' })

    await writeFile(manifestPath, JSON.stringify({ ...envelope, sha256: '0'.repeat(64) }))
    try {
      await listWorkspaceInventoryPage({ ...base, sessionId: 'session-errors', nowMs: 120 })
      throw new Error('expected corrupt cursor failure')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceInventoryCursorError)
      expect(error).toMatchObject({ code: 'cursor_corrupt' })
    }
  })
})
