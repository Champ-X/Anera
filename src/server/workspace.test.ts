import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNoSymlinkTraversal, encodeWorkspaceUrlPath, findWebsiteEntry, isWorkspaceInternalPath, isWorkspaceSnapshotExcludedPath, readWorkspaceFile, readWorkspaceTextPage, resolveWorkspacePath, workspaceFileSnapshot, workspacePersistenceSnapshot, workspaceTree, writeUniqueWorkspaceFile, writeWorkspaceFile } from './workspace.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), 'anera-workspace-'))
  roots.push(path)
  return path
}

describe('workspace boundary', () => {
  it('rejects relative and absolute escape paths', async () => {
    const workspace = await root()
    expect(() => resolveWorkspacePath(workspace, '../outside.txt')).toThrow(/escapes/)
    expect(() => resolveWorkspacePath(workspace, '/tmp/outside.txt')).toThrow(/Absolute/)
  })

  it('encodes workspace preview paths one URL segment at a time', () => {
    expect(encodeWorkspaceUrlPath('资料 2026/子目录/page#1.html')).toBe('%E8%B5%84%E6%96%99%202026/%E5%AD%90%E7%9B%AE%E5%BD%95/page%231.html')
  })

  it('round-trips nested unicode files and produces a tree', async () => {
    const workspace = await root()
    await writeWorkspaceFile(workspace, '资料 2026/清单.txt', 'alpha\nbeta\n')
    const read = await readWorkspaceFile(workspace, '资料 2026/清单.txt', 100)
    expect(read).toMatchObject({ content: 'alpha\nbeta\n', truncated: false })
    expect(await workspaceTree(workspace)).toEqual([
      {
        name: '资料 2026',
        path: '资料 2026',
        type: 'directory',
        children: [{ name: '清单.txt', path: '资料 2026/清单.txt', type: 'file', size: 11 }],
      },
    ])
  })

  it('reads bounded complete-line pages with deterministic continuation offsets', async () => {
    const workspace = await root()
    await writeWorkspaceFile(workspace, 'long.txt', 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n')

    const limitedByLines = await readWorkspaceTextPage(workspace, 'long.txt', {
      offset: 2, limit: 2, maxBytes: 100, readChunkBytes: 1,
    })
    expect(limitedByLines).toMatchObject({
      content: 'two\nthree',
      totalLines: 5,
      startLine: 2,
      endLine: 3,
      nextOffset: 4,
      truncatedBy: 'lines',
    })

    const limitedByBytes = await readWorkspaceTextPage(workspace, 'long.txt', { offset: 1, limit: 10, maxBytes: 7 })
    expect(limitedByBytes).toMatchObject({
      content: 'one\ntwo',
      startLine: 1,
      endLine: 2,
      nextOffset: 3,
      truncatedBy: 'bytes',
      outputBytes: 7,
    })

    const finalPage = await readWorkspaceTextPage(workspace, 'long.txt', { offset: 4, limit: 10, maxBytes: 100 })
    expect(finalPage).toMatchObject({
      content: 'four\nfive\n',
      startLine: 4,
      endLine: 5,
      outputBytes: 10,
    })

    await expect(readWorkspaceTextPage(workspace, 'long.txt', { offset: 6, maxBytes: 100 })).rejects.toThrow(/beyond end of file/)
  })

  it('streams an oversized UTF-8 line to EOF with monotonic boundary-safe byte cursors', async () => {
    const workspace = await root()
    const line = '甲🙂乙🚀终点'.repeat(6)
    for (const [name, ending] of [['no-lf.txt', ''], ['with-lf.txt', '\n']] as const) {
      await writeWorkspaceFile(workspace, name, `${line}${ending}`)
      const fragments: string[] = []
      let contentOffset: number | undefined
      let pageCount = 0
      while (pageCount < 100) {
        const page = await readWorkspaceTextPage(workspace, name, {
          offset: 1,
          ...(contentOffset !== undefined ? { contentOffset } : {}),
          maxBytes: 7,
        })
        expect(page.contentOffset).toBe(contentOffset ?? 0)
        expect(page.content).not.toContain('\uFFFD')
        expect(page.nextOffset).toBeUndefined()
        fragments.push(page.content)
        pageCount += 1
        if (page.nextContentOffset === undefined) {
          expect(page.endLine).toBe(1)
          break
        }
        expect(page.endLine).toBe(0)
        expect(page.nextContentOffset).toBeGreaterThan(contentOffset ?? 0)
        expect(Buffer.from(line).subarray(0, page.nextContentOffset).toString('utf8')).not.toContain('\uFFFD')
        contentOffset = page.nextContentOffset
      }
      expect(pageCount).toBeGreaterThan(1)
      expect(fragments.join('')).toBe(`${line}${ending}`)
    }
  })

  it('keeps retained scan buffers bounded while traversing one line across tiny read chunks', async () => {
    const workspace = await root()
    const line = 'A🙂甲🚀'.repeat(1_024)
    const maxBytes = 7
    const readChunkBytes = 5
    let peakBufferedBytes = 0
    await writeWorkspaceFile(workspace, 'adversarial-line.txt', line)

    const page = await readWorkspaceTextPage(workspace, 'adversarial-line.txt', {
      maxBytes,
      readChunkBytes,
      onBufferedBytes: (bytes) => {
        peakBufferedBytes = Math.max(peakBufferedBytes, bytes)
      },
    })

    expect(Buffer.byteLength(line)).toBeGreaterThan(readChunkBytes * 2_000)
    expect(peakBufferedBytes).toBeLessThanOrEqual(readChunkBytes + (2 * (maxBytes + 4)))
    expect(page.outputBytes).toBeLessThanOrEqual(maxBytes)
    expect(page.content).not.toContain('\uFFFD')
    expect(page.nextContentOffset).toBeGreaterThan(0)
  })

  it('reserves terminal LF space by retreating to an in-line ASCII or four-byte UTF-8 boundary', async () => {
    const workspace = await root()
    for (const [name, body, maxBytes] of [
      ['ascii-exact.txt', 'abcde', 5],
      ['unicode-exact.txt', 'A🙂', 5],
    ] as const) {
      const source = `${body}\n`
      const lineBytes = Buffer.byteLength(body)
      await writeWorkspaceFile(workspace, name, source)
      const parts: string[] = []
      let contentOffset: number | undefined
      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        const page = await readWorkspaceTextPage(workspace, name, {
          offset: 1,
          ...(contentOffset !== undefined ? { contentOffset } : {}),
          maxBytes,
          readChunkBytes: 2,
        })
        expect(page.contentOffset).toBe(contentOffset ?? 0)
        expect(page.outputBytes).toBe(Buffer.byteLength(page.content))
        expect(page.outputBytes).toBeLessThanOrEqual(maxBytes)
        expect(page.content).not.toContain('\uFFFD')
        parts.push(page.content)
        if (page.nextContentOffset === undefined) {
          expect(page.endLine).toBe(1)
          break
        }
        expect(page.endLine).toBe(0)
        expect(page.nextContentOffset).toBeGreaterThan(contentOffset ?? 0)
        expect(page.nextContentOffset).toBeLessThan(lineBytes)
        contentOffset = page.nextContentOffset
      }
      expect(parts.join('')).toBe(source)
    }
  })

  it('finishes a fragmented line before advancing to following lines without losing the separator', async () => {
    const workspace = await root()
    const firstLine = '🙂alpha甲'.repeat(8)
    const source = `${firstLine}\nsecond\nthird\n`
    await writeWorkspaceFile(workspace, 'fragment-then-lines.txt', source)

    const fragments: string[] = []
    let contentOffset: number | undefined
    let nextOffset: number | undefined
    for (let pageCount = 0; pageCount < 100; pageCount += 1) {
      const page = await readWorkspaceTextPage(workspace, 'fragment-then-lines.txt', {
        offset: 1,
        ...(contentOffset !== undefined ? { contentOffset } : {}),
        maxBytes: 9,
      })
      fragments.push(page.content)
      if (page.nextContentOffset !== undefined) {
        expect(page.nextContentOffset).toBeGreaterThan(contentOffset ?? 0)
        expect(page.nextOffset).toBeUndefined()
        contentOffset = page.nextContentOffset
        continue
      }
      nextOffset = page.nextOffset
      expect(page.content).toMatch(/\n$/)
      expect(page.endLine).toBe(1)
      break
    }
    expect(nextOffset).toBe(2)
    const remaining = await readWorkspaceTextPage(workspace, 'fragment-then-lines.txt', {
      offset: nextOffset,
      maxBytes: 100,
    })
    expect(`${fragments.join('')}${remaining.content}`).toBe(source)
    expect(remaining.nextOffset).toBeUndefined()
  })

  it('rejects invalid line and UTF-8 byte cursors without returning a duplicate cursor', async () => {
    const workspace = await root()
    await writeWorkspaceFile(workspace, 'boundary.txt', 'A🙂B')
    await expect(readWorkspaceTextPage(workspace, 'boundary.txt', {
      offset: 1, contentOffset: 2, maxBytes: 10,
    })).rejects.toThrow(/UTF-8 character boundary/)
    await expect(readWorkspaceTextPage(workspace, 'boundary.txt', {
      offset: 1, contentOffset: 6, maxBytes: 10,
    })).rejects.toThrow(/already at the end/)
    await expect(readWorkspaceTextPage(workspace, 'boundary.txt', {
      offset: 1, contentOffset: 7, maxBytes: 10,
    })).rejects.toThrow(/beyond line 1/)
    await expect(readWorkspaceTextPage(workspace, 'boundary.txt', {
      offset: 2, contentOffset: 0, maxBytes: 10,
    })).rejects.toThrow(/beyond end of file/)

    await writeWorkspaceFile(workspace, 'too-small.txt', '🙂tail')
    await expect(readWorkspaceTextPage(workspace, 'too-small.txt', {
      offset: 1, maxBytes: 3,
    })).rejects.toThrow(/cannot include the next complete UTF-8 character/)
  })

  it('rejects a final-component symlink for both reads and writes', async () => {
    const workspace = await root()
    const outside = await root()
    const outsideFile = resolve(outside, 'outside.txt')
    await writeFile(outsideFile, 'outside\n')
    await symlink(outsideFile, resolve(workspace, 'linked.txt'))

    await expect(readWorkspaceFile(workspace, 'linked.txt', 100)).rejects.toThrow(/Symlink traversal/)
    await expect(writeWorkspaceFile(workspace, 'linked.txt', 'replacement\n')).rejects.toThrow(/Symlink traversal/)
    await expect(assertNoSymlinkTraversal(workspace, resolveWorkspacePath(workspace, 'linked.txt'))).rejects.toThrow(/Symlink traversal/)
    expect(await workspaceTree(workspace)).toEqual([])
  })

  it('uses a distinct Arena snapshot policy without treating live build output as private harness state', async () => {
    const workspace = await root()
    await writeWorkspaceFile(workspace, 'visible.txt', 'one\n')
    await writeWorkspaceFile(workspace, 'node_modules/pkg/index.js', 'hidden\n')
    await writeWorkspaceFile(workspace, 'dist/assets/app.js', 'built\n')
    await writeWorkspaceFile(workspace, 'build/index.html', 'generated\n')
    await writeWorkspaceFile(workspace, '.next/cache/data.bin', 'cache\n')
    await writeWorkspaceFile(workspace, '.netrc', 'machine example.test password secret\n')
    await writeWorkspaceFile(workspace, '.git-credentials', 'https://secret@example.test\n')

    expect(isWorkspaceInternalPath('dist/assets/app.js')).toBe(false)
    expect(isWorkspaceInternalPath('node_modules/pkg/index.js')).toBe(true)
    expect(isWorkspaceSnapshotExcludedPath('dist/assets/app.js')).toBe(true)
    expect(isWorkspaceSnapshotExcludedPath('nested/.netrc')).toBe(true)
    expect(await workspaceTree(workspace)).toEqual([
      { name: 'visible.txt', path: 'visible.txt', type: 'file', size: 4 },
    ])
    const snapshot = await workspaceFileSnapshot(workspace)
    expect([...snapshot.keys()]).toEqual(['visible.txt'])
    expect(snapshot.get('visible.txt')?.size).toBe(4)
    expect(snapshot.get('visible.txt')?.mtimeMs).toBeTypeOf('number')
    await expect(workspacePersistenceSnapshot(workspace)).resolves.toEqual({ bytes: 4, fileCount: 1, blobCount: 0 })

    // Snapshot exclusion is projection-only: the active runtime still owns
    // its dependency/build bytes until its managed process is stopped.
    await expect(readFile(resolve(workspace, 'dist/assets/app.js'), 'utf8')).resolves.toBe('built\n')
    await expect(readFile(resolve(workspace, 'node_modules/pkg/index.js'), 'utf8')).resolves.toBe('hidden\n')
  })

  it('discovers a live build entry without adding it to the saved Workspace tree', async () => {
    const workspace = await root()
    await writeWorkspaceFile(workspace, 'dist/index.html', '<h1>built</h1>\n')
    await writeWorkspaceFile(workspace, 'node_modules/pkg/index.html', '<h1>dependency</h1>\n')

    await expect(findWebsiteEntry(workspace)).resolves.toBe('dist/index.html')
    await expect(workspaceTree(workspace)).resolves.toEqual([])
  })

  it('authoritatively measures every visible regular file for terminal persistence', async () => {
    const workspace = await root()
    await writeWorkspaceFile(workspace, 'visible.txt', 'one\n')
    await writeWorkspaceFile(workspace, 'nested/two.bin', '12345')
    await writeWorkspaceFile(workspace, 'node_modules/pkg/index.js', 'hidden dependency\n')
    await writeWorkspaceFile(workspace, 'dist/index.html', 'hidden build\n')
    await writeWorkspaceFile(workspace, '.next/cache/data.bin', 'hidden cache\n')
    await writeWorkspaceFile(workspace, '.netrc', 'hidden credential\n')
    await writeWorkspaceFile(workspace, '.tmp/checkpoint.json', 'hidden checkpoint\n')
    await symlink(resolve(workspace, 'visible.txt'), resolve(workspace, 'linked.txt'))

    await expect(workspacePersistenceSnapshot(workspace)).resolves.toEqual({
      bytes: 9,
      fileCount: 2,
      blobCount: 0,
    })
  })

  it('atomically preserves concurrent files with the same preferred upload name', async () => {
    const workspace = await root()
    const results = await Promise.all([
      writeUniqueWorkspaceFile(workspace, 'uploads/report.csv', 'first'),
      writeUniqueWorkspaceFile(workspace, 'uploads/report.csv', 'second'),
      writeUniqueWorkspaceFile(workspace, 'uploads/report.csv', 'third'),
    ])

    expect(results.map((result) => result.path).sort()).toEqual([
      'uploads/report (2).csv',
      'uploads/report (3).csv',
      'uploads/report.csv',
    ])
    const contents = await Promise.all(results.map((result) => readFile(resolve(workspace, result.path), 'utf8')))
    expect(contents.sort()).toEqual(['first', 'second', 'third'])
  })
})
