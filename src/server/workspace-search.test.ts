import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GLOB_MAX_FILES,
  GREP_MAX_FILES,
  GREP_MAX_JSON_LINES,
  GREP_MAX_MATCHES,
  MAX_LINE_LENGTH,
  MAX_PATTERN_LENGTH,
  TOOL_RESULT_MAX_BYTES,
  globWorkspace,
  grepWorkspace,
} from './workspace-search.js'

const roots: string[] = []
const signal = () => new AbortController().signal

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-search-'))
  roots.push(root)
  return root
}

describe('Arena-style workspace search tools', () => {
  it('searches Unicode and spaced paths with glob, case, and context controls', async () => {
    const root = await workspace()
    await mkdir(resolve(root, '资料 2026/子目录'), { recursive: true })
    await writeFile(resolve(root, '资料 2026/子目录/app.ts'), 'before\nNeedle value\nafter\n')
    await writeFile(resolve(root, '资料 2026/子目录/readme.md'), 'needle in markdown\n')

    const glob = await globWorkspace(root, { pattern: '**/*.{ts,md}', path: '资料 2026' }, signal())
    expect(glob).toEqual({
      status: 'success',
      paths: ['资料 2026/子目录/app.ts', '资料 2026/子目录/readme.md'],
      truncated: false,
    })

    const grep = await grepWorkspace(root, {
      pattern: 'needle',
      path: '资料 2026',
      glob: '*.ts',
      '-i': true,
      '-C': 1,
    }, signal())
    expect(grep).toEqual({
      status: 'success',
      mode: 'content',
      matches: [{
        path: '资料 2026/子目录/app.ts',
        lineNumber: 2,
        lineContent: 'Needle value',
        contextBefore: ['before'],
        contextAfter: ['after'],
      }],
      truncated: false,
    })
  })

  it('supports files-with-matches and exact per-file count modes', async () => {
    const root = await workspace()
    await mkdir(resolve(root, 'src'))
    await writeFile(resolve(root, 'src/a.ts'), 'TODO one\nnone\nTODO two\n')
    await writeFile(resolve(root, 'src/b.ts'), 'none\nTODO three\n')
    await writeFile(resolve(root, 'src/c.ts'), 'none\n')

    await expect(grepWorkspace(root, {
      pattern: 'TODO', path: 'src', output_mode: 'files_with_matches',
    }, signal())).resolves.toEqual({
      status: 'success', mode: 'files_with_matches', files: ['src/a.ts', 'src/b.ts'], truncated: false,
    })
    await expect(grepWorkspace(root, {
      pattern: 'TODO', path: 'src', output_mode: 'count',
    }, signal())).resolves.toEqual({
      status: 'success',
      mode: 'count',
      counts: [{ path: 'src/a.ts', count: 2 }, { path: 'src/b.ts', count: 1 }],
      totalMatches: 3,
      truncated: false,
    })
  })

  it('skips binary files, snapshot-excluded generated trees, Git metadata, and traversed symlinks', async () => {
    const root = await workspace()
    const outside = await workspace()
    await mkdir(resolve(root, 'src'))
    await mkdir(resolve(root, 'node_modules/pkg'), { recursive: true })
    await mkdir(resolve(root, 'dist/assets'), { recursive: true })
    await mkdir(resolve(root, '.next/cache'), { recursive: true })
    await mkdir(resolve(root, '.git'))
    await writeFile(resolve(root, 'src/visible.txt'), 'needle\n')
    await writeFile(resolve(root, 'src/binary.dat'), Buffer.from([0, 1, 2, 3, 110, 101, 101, 100, 108, 101]))
    await writeFile(resolve(root, 'node_modules/pkg/hidden.txt'), 'needle\n')
    await writeFile(resolve(root, 'dist/assets/hidden.js'), 'needle\n')
    await writeFile(resolve(root, '.next/cache/hidden.txt'), 'needle\n')
    await writeFile(resolve(root, '.netrc'), 'needle credential\n')
    await writeFile(resolve(root, '.git/config'), 'needle\n')
    await writeFile(resolve(outside, 'secret.txt'), 'needle outside\n')
    await symlink(resolve(outside, 'secret.txt'), resolve(root, 'linked-secret.txt'))
    await symlink(outside, resolve(root, 'linked-directory'))

    const found = await grepWorkspace(root, { pattern: 'needle' }, signal())
    expect(found).toMatchObject({
      mode: 'content',
      matches: [{ path: 'src/visible.txt', lineNumber: 1, lineContent: 'needle' }],
    })
    await expect(globWorkspace(root, { pattern: '**/*' }, signal())).resolves.toEqual({
      status: 'success', paths: ['src/binary.dat', 'src/visible.txt'], truncated: false,
    })
    await expect(grepWorkspace(root, { pattern: 'needle', path: 'linked-secret.txt' }, signal()))
      .rejects.toThrow(/Symlink traversal/)
    await expect(globWorkspace(root, { pattern: '**/*', path: 'linked-directory' }, signal()))
      .rejects.toThrow(/Symlink traversal/)
  })

  it('enforces Arena match, file, JSON-line, line-preview, and result-byte caps', async () => {
    const root = await workspace()
    await mkdir(resolve(root, 'many'))
    await Promise.all(Array.from({ length: GLOB_MAX_FILES + 1 }, (_, index) =>
      writeFile(resolve(root, `many/file-${String(index).padStart(3, '0')}.txt`), 'needle\n')))

    const glob = await globWorkspace(root, { pattern: '**/*.txt', path: 'many' }, signal())
    expect(glob.paths).toHaveLength(GLOB_MAX_FILES)
    expect(glob.truncated).toBe(true)

    const files = await grepWorkspace(root, { pattern: 'needle', path: 'many', output_mode: 'files_with_matches' }, signal())
    expect(files.mode).toBe('files_with_matches')
    if (files.mode === 'files_with_matches') expect(files.files).toHaveLength(GREP_MAX_FILES)
    expect(files.truncated).toBe(true)

    await writeFile(resolve(root, 'matches.txt'), `${Array.from({ length: GREP_MAX_MATCHES + 1 }, () => 'needle').join('\n')}\n`)
    const content = await grepWorkspace(root, { pattern: 'needle', path: 'matches.txt' }, signal())
    expect(content.mode).toBe('content')
    if (content.mode === 'content') expect(content.matches).toHaveLength(GREP_MAX_MATCHES)
    expect(content.truncated).toBe(true)

    await writeFile(resolve(root, 'count.txt'), `${Array.from({ length: GREP_MAX_JSON_LINES + 1 }, () => 'needle').join('\n')}\n`)
    const count = await grepWorkspace(root, { pattern: 'needle', path: 'count.txt', output_mode: 'count' }, signal())
    expect(count).toMatchObject({ mode: 'count', totalMatches: GREP_MAX_JSON_LINES, truncated: true })

    await writeFile(resolve(root, 'long-line.txt'), `${'x'.repeat(MAX_LINE_LENGTH + 100)} needle\n`)
    const longLine = await grepWorkspace(root, { pattern: 'needle', path: 'long-line.txt' }, signal())
    expect(longLine.mode).toBe('content')
    if (longLine.mode === 'content') {
      expect(Array.from(longLine.matches[0].lineContent)).toHaveLength(MAX_LINE_LENGTH)
      expect(longLine.matches[0].lineContent.endsWith('…')).toBe(true)
    }
    expect(longLine.truncated).toBe(true)

    await writeFile(resolve(root, 'byte-cap.txt'), `${Array.from({ length: 120 }, (_, index) =>
      `${String(index).padStart(3, '0')} ${'界'.repeat(1_000)}${index % 2 === 0 ? ' needle' : ''}`).join('\n')}\n`)
    const bounded = await grepWorkspace(root, { pattern: 'needle', path: 'byte-cap.txt', context: 20 }, signal())
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES)
    expect(bounded.truncated).toBe(true)
  }, 30_000)

  it('rejects unsafe or invalid search arguments and observes cancellation', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'a.txt'), 'hello\n')
    await expect(grepWorkspace(root, { pattern: 'x'.repeat(MAX_PATTERN_LENGTH + 1) }, signal()))
      .rejects.toThrow(/at most 200/)
    await expect(globWorkspace(root, { pattern: 'x'.repeat(MAX_PATTERN_LENGTH + 1) }, signal()))
      .rejects.toThrow(/at most 200/)
    await expect(grepWorkspace(root, { pattern: '[' }, signal())).rejects.toThrow(/Invalid regular expression/)
    await expect(globWorkspace(root, { pattern: '*', path: 'a.txt' }, signal())).rejects.toThrow(/must be a directory/)
    await expect(grepWorkspace(root, { pattern: 'hello', path: '../outside' }, signal())).rejects.toThrow(/escapes the workspace/)

    const controller = new AbortController()
    controller.abort()
    await expect(globWorkspace(root, { pattern: '*' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
