import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyWorkspacePatch, recoverWorkspacePatchTransactions } from './workspace-patch.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-patch-'))
  roots.push(root)
  return root
}

describe('Arena-style apply_patch workspace mutations', () => {
  it('adds, updates with multiple hunks, moves, and deletes in one patch', async () => {
    const root = await workspace()
    await mkdir(resolve(root, 'src'))
    await writeFile(resolve(root, 'src/app.ts'), 'const mode = "draft";\nconst count = 1;\nconst end = true;\n')
    await writeFile(resolve(root, 'legacy.txt'), 'move-me\n')
    await writeFile(resolve(root, 'temp.txt'), 'delete-me\n')

    const changes = await applyWorkspacePatch(root, `*** Begin Patch
*** Add File: README.md
+ready
*** Update File: src/app.ts
@@
-const mode = "draft";
+const mode = "ready";
@@
-const count = 1;
+const count = 2;
*** Update File: legacy.txt
*** Move to: archive/final.txt
@@
 move-me
*** Delete File: temp.txt
*** End Patch`)

    expect(changes).toEqual([
      { path: 'README.md', operation: 'added', bytes: 6 },
      { path: 'src/app.ts', operation: 'updated', bytes: 57 },
      { path: 'legacy.txt', operation: 'deleted', bytes: 0 },
      { path: 'archive/final.txt', operation: 'added', bytes: 8 },
      { path: 'temp.txt', operation: 'deleted', bytes: 0 },
    ])
    await expect(readFile(resolve(root, 'README.md'), 'utf8')).resolves.toBe('ready\n')
    await expect(readFile(resolve(root, 'src/app.ts'), 'utf8')).resolves.toBe('const mode = "ready";\nconst count = 2;\nconst end = true;\n')
    await expect(readFile(resolve(root, 'archive/final.txt'), 'utf8')).resolves.toBe('move-me\n')
    await expect(readFile(resolve(root, 'legacy.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(resolve(root, 'temp.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('supports an empty added file, no-final-newline updates, and delete-then-add replacement', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'replace.txt'), 'old\n')
    await writeFile(resolve(root, 'nonewline.txt'), 'old')

    await expect(applyWorkspacePatch(root, `*** Begin Patch
*** Add File: empty.txt
*** Delete File: replace.txt
*** Add File: replace.txt
+new
*** Update File: nonewline.txt
@@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
*** End Patch`)).resolves.toEqual([
      { path: 'empty.txt', operation: 'added', bytes: 0 },
      { path: 'replace.txt', operation: 'updated', bytes: 4 },
      { path: 'nonewline.txt', operation: 'updated', bytes: 3 },
    ])
    await expect(readFile(resolve(root, 'empty.txt'), 'utf8')).resolves.toBe('')
    await expect(readFile(resolve(root, 'replace.txt'), 'utf8')).resolves.toBe('new\n')
    await expect(readFile(resolve(root, 'nonewline.txt'), 'utf8')).resolves.toBe('new')
  })

  it('uses a locator to disambiguate repeated hunk context', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'repeat.txt'), 'first\nvalue\nsecond\nvalue\n')
    await applyWorkspacePatch(root, `*** Begin Patch
*** Update File: repeat.txt
@@ second
-value
+changed
*** End Patch`)
    await expect(readFile(resolve(root, 'repeat.txt'), 'utf8')).resolves.toBe('first\nvalue\nsecond\nchanged\n')
  })

  it('does not mutate any file when parsing or matching fails', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'one.txt'), 'one\n')
    await writeFile(resolve(root, 'two.txt'), 'two\n')
    await expect(applyWorkspacePatch(root, `*** Begin Patch
*** Update File: one.txt
@@
-one
+changed
*** Update File: two.txt
@@
-missing
+changed
*** End Patch`)).rejects.toThrow(/must match exactly once/)
    await expect(readFile(resolve(root, 'one.txt'), 'utf8')).resolves.toBe('one\n')
    await expect(readFile(resolve(root, 'two.txt'), 'utf8')).resolves.toBe('two\n')
  })

  it('rejects escape paths, existing destinations, and symlink traversal', async () => {
    const root = await workspace()
    const outside = await workspace()
    await writeFile(resolve(root, 'source.txt'), 'source\n')
    await writeFile(resolve(root, 'existing.txt'), 'existing\n')
    await writeFile(resolve(outside, 'secret.txt'), 'secret\n')
    await symlink(resolve(outside, 'secret.txt'), resolve(root, 'linked.txt'))

    await expect(applyWorkspacePatch(root, '*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch'))
      .rejects.toThrow(/escapes the workspace/)
    await expect(applyWorkspacePatch(root, '*** Begin Patch\n*** Add File: existing.txt\n+x\n*** End Patch'))
      .rejects.toThrow(/already exists/)
    await expect(applyWorkspacePatch(root, '*** Begin Patch\n*** Update File: linked.txt\n@@\n-secret\n+changed\n*** End Patch'))
      .rejects.toThrow(/Symlink traversal/)
    await expect(readFile(resolve(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret\n')
  })

  it('rolls back a durable prepared transaction that stopped after a partial multi-file install', async () => {
    const root = await workspace()
    const transactions = await workspace()
    await writeFile(resolve(root, '.tmp'), 'user-owned dot tmp file\n')
    await writeFile(resolve(root, 'one.txt'), 'one-before\n')
    await writeFile(resolve(root, 'two.txt'), 'two-before\n')
    let release!: () => void
    let installed!: () => void
    const installedBoundary = new Promise<void>((resolveInstalled) => { installed = resolveInstalled })
    const hold = new Promise<void>((resolveHold) => { release = resolveHold })
    const applying = applyWorkspacePatch(root, `*** Begin Patch
*** Update File: one.txt
@@
-one-before
+one-after
*** Update File: two.txt
@@
-two-before
+two-after
*** End Patch`, undefined, {
      transactionParent: transactions,
      onDurablePhase: async (phase, details) => {
        if (phase === 'installed' && details.installedCount === 1) {
          installed()
          await hold
        }
      },
    })

    await installedBoundary
    await expect(readFile(resolve(root, 'one.txt'), 'utf8')).resolves.toBe('one-after\n')
    await expect(readFile(resolve(root, 'two.txt'), 'utf8')).resolves.toBe('two-before\n')
    await expect(recoverWorkspacePatchTransactions(root, transactions)).resolves.toEqual([
      expect.objectContaining({ phase: 'prepared', action: 'rolled_back', changeCount: 2 }),
    ])
    await expect(readFile(resolve(root, 'one.txt'), 'utf8')).resolves.toBe('one-before\n')
    await expect(readFile(resolve(root, 'two.txt'), 'utf8')).resolves.toBe('two-before\n')
    await expect(readFile(resolve(root, '.tmp'), 'utf8')).resolves.toBe('user-owned dot tmp file\n')
    release()
    await expect(applying).rejects.toThrow()
    await expect(recoverWorkspacePatchTransactions(root, transactions)).resolves.toEqual([])
  })

  it('discards a transaction directory that crashed before its manifest publication boundary', async () => {
    const root = await workspace()
    const transactions = await workspace()
    await writeFile(resolve(root, 'stable.txt'), 'stable\n')
    const residue = resolve(transactions, 'patch-unprepared123')
    await mkdir(residue)
    await writeFile(resolve(residue, 'stage-0'), 'never-published\n')
    await writeFile(resolve(residue, 'manifest.tmp'), '{"torn":')

    await expect(recoverWorkspacePatchTransactions(root, transactions)).resolves.toEqual([{
      transactionId: 'patch-unprepared123',
      phase: 'unknown',
      action: 'manifest_missing_discarded',
      changeCount: 0,
    }])
    await expect(readFile(resolve(root, 'stable.txt'), 'utf8')).resolves.toBe('stable\n')
    await expect(readFile(residue)).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|EISDIR/) })
  })

  it('keeps and verifies a transaction whose committed manifest survived cleanup', async () => {
    const root = await workspace()
    const transactions = await workspace()
    await writeFile(resolve(root, 'keep.txt'), 'before\n')
    let release!: () => void
    let committed!: () => void
    const committedBoundary = new Promise<void>((resolveCommitted) => { committed = resolveCommitted })
    const hold = new Promise<void>((resolveHold) => { release = resolveHold })
    const applying = applyWorkspacePatch(root, `*** Begin Patch
*** Update File: keep.txt
@@
-before
+after
*** Add File: added.txt
+added
*** End Patch`, undefined, {
      transactionParent: transactions,
      onDurablePhase: async (phase) => {
        if (phase === 'committed') {
          committed()
          await hold
        }
      },
    })

    await committedBoundary
    await expect(recoverWorkspacePatchTransactions(root, transactions)).resolves.toEqual([
      expect.objectContaining({ phase: 'committed', action: 'committed_verified', changeCount: 2 }),
    ])
    await expect(readFile(resolve(root, 'keep.txt'), 'utf8')).resolves.toBe('after\n')
    await expect(readFile(resolve(root, 'added.txt'), 'utf8')).resolves.toBe('added\n')
    release()
    await expect(applying).resolves.toHaveLength(2)
    await expect(recoverWorkspacePatchTransactions(root, transactions)).resolves.toEqual([])
  })

  it('rolls a committed transaction back when its published bytes fail recovery verification', async () => {
    const root = await workspace()
    const transactions = await workspace()
    await writeFile(resolve(root, 'corrupt.txt'), 'before\n')
    let release!: () => void
    let committed!: () => void
    const committedBoundary = new Promise<void>((resolveCommitted) => { committed = resolveCommitted })
    const hold = new Promise<void>((resolveHold) => { release = resolveHold })
    const applying = applyWorkspacePatch(root, `*** Begin Patch
*** Update File: corrupt.txt
@@
-before
+after
*** Add File: transient.txt
+transient
*** End Patch`, undefined, {
      transactionParent: transactions,
      onDurablePhase: async (phase) => {
        if (phase === 'committed') {
          committed()
          await hold
        }
      },
    })

    await committedBoundary
    await writeFile(resolve(root, 'corrupt.txt'), 'externally-corrupted\n')
    await expect(recoverWorkspacePatchTransactions(root, transactions)).resolves.toEqual([
      expect.objectContaining({ phase: 'committed', action: 'committed_corrupt_rolled_back', changeCount: 2 }),
    ])
    await expect(readFile(resolve(root, 'corrupt.txt'), 'utf8')).resolves.toBe('before\n')
    await expect(readFile(resolve(root, 'transient.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    release()
    await expect(applying).resolves.toHaveLength(2)
  })
})
