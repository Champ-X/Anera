import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createStaticDeploymentSnapshot,
  deploymentSnapshotManifestPath,
  readVerifiedStaticDeploymentSnapshot,
} from './deployment.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('static deployment snapshots', () => {
  it('prefers build output, copies only static regular files, and hashes snapshots deterministically', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-deployment-'))
    roots.push(root)
    const workspace = resolve(root, 'workspace')
    const outside = resolve(root, 'outside.txt')
    await mkdir(resolve(workspace, 'dist', 'assets'), { recursive: true })
    await writeFile(resolve(workspace, 'index.html'), '<h1>SOURCE MUST NOT DEPLOY</h1>')
    await writeFile(resolve(workspace, 'dist', 'index.html'), '<script src="assets/app.js"></script>')
    await writeFile(resolve(workspace, 'dist', 'assets', 'app.js'), 'document.body.append("BUILT")\n')
    await writeFile(resolve(workspace, 'dist', '.env'), 'SECRET=must-not-deploy\n')
    await writeFile(resolve(workspace, 'dist', 'package.json'), '{"private":true}\n')
    await writeFile(outside, 'OUTSIDE MUST NOT DEPLOY\n')
    await symlink(outside, resolve(workspace, 'dist', 'linked.txt'))

    const first = await createStaticDeploymentSnapshot(workspace, resolve(root, 'revision-1'), new AbortController().signal)
    const repeat = await createStaticDeploymentSnapshot(workspace, resolve(root, 'revision-repeat'), new AbortController().signal)

    expect(first).toEqual({
      sourceDirectory: 'dist',
      entryPath: 'index.html',
      fileCount: 2,
      bytes: expect.any(Number),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(repeat.contentHash).toBe(first.contentHash)
    await expect(readVerifiedStaticDeploymentSnapshot(resolve(root, 'revision-1'))).resolves.toEqual(first)
    await expect(readFile(deploymentSnapshotManifestPath(resolve(root, 'revision-1')), 'utf8')).resolves.toContain(first.contentHash)
    await expect(readFile(resolve(root, 'revision-1', 'index.html'), 'utf8')).resolves.toContain('assets/app.js')
    await expect(readFile(resolve(root, 'revision-1', 'assets', 'app.js'), 'utf8')).resolves.toContain('BUILT')
    for (const excluded of ['.env', 'package.json', 'linked.txt']) {
      await expect(readFile(resolve(root, 'revision-1', excluded), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }

    await writeFile(resolve(workspace, 'dist', 'assets', 'app.js'), 'document.body.append("CHANGED")\n')
    const changed = await createStaticDeploymentSnapshot(workspace, resolve(root, 'revision-2'), new AbortController().signal)
    expect(changed.contentHash).not.toBe(first.contentHash)
  })

  it('filters workspace-only sources and removes incomplete revisions when snapshotting aborts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-deployment-root-'))
    roots.push(root)
    const workspace = resolve(root, 'workspace')
    const target = resolve(root, 'revision')
    await mkdir(resolve(workspace, 'src'), { recursive: true })
    await mkdir(resolve(workspace, 'uploads'), { recursive: true })
    await writeFile(resolve(workspace, 'index.html'), '<h1>ROOT STATIC</h1>')
    await writeFile(resolve(workspace, 'site.css'), 'body{}\n')
    await writeFile(resolve(workspace, 'src', 'private.js'), 'source only\n')
    await writeFile(resolve(workspace, 'uploads', 'private.txt'), 'upload only\n')

    const snapshot = await createStaticDeploymentSnapshot(workspace, target, new AbortController().signal)
    expect(snapshot).toMatchObject({ sourceDirectory: '.', entryPath: 'index.html', fileCount: 2 })
    await expect(readFile(resolve(target, 'src', 'private.js'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(resolve(target, 'uploads', 'private.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const controller = new AbortController()
    controller.abort(new DOMException('cancel snapshot', 'AbortError'))
    await expect(createStaticDeploymentSnapshot(workspace, resolve(root, 'aborted'), controller.signal)).rejects.toThrow(/cancel snapshot|aborted/i)
    await expect(readFile(resolve(root, 'aborted', 'index.html'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(deploymentSnapshotManifestPath(resolve(root, 'aborted')), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects revisions whose bytes, file set, entry, or sidecar manifest no longer match', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-deployment-verify-'))
    roots.push(root)
    const workspace = resolve(root, 'workspace')
    const target = resolve(root, 'revision-1')
    await mkdir(workspace, { recursive: true })
    await writeFile(resolve(workspace, 'index.html'), '<h1>VERIFIED</h1>')
    await writeFile(resolve(workspace, 'app.js'), 'document.body.dataset.ready = "yes"\n')

    const original = await createStaticDeploymentSnapshot(workspace, target, new AbortController().signal)
    await expect(readVerifiedStaticDeploymentSnapshot(target)).resolves.toEqual(original)

    await writeFile(resolve(target, 'app.js'), 'document.body.dataset.ready = "tampered"\n')
    await expect(readVerifiedStaticDeploymentSnapshot(target)).resolves.toBeUndefined()

    await createStaticDeploymentSnapshot(workspace, target, new AbortController().signal)
    await writeFile(resolve(target, 'rogue.js'), 'unexpected file\n')
    await expect(readVerifiedStaticDeploymentSnapshot(target)).resolves.toBeUndefined()

    await createStaticDeploymentSnapshot(workspace, target, new AbortController().signal)
    await rm(resolve(target, 'index.html'))
    await expect(readVerifiedStaticDeploymentSnapshot(target)).resolves.toBeUndefined()

    await createStaticDeploymentSnapshot(workspace, target, new AbortController().signal)
    await writeFile(deploymentSnapshotManifestPath(target), '{"schemaVersion":"wrong"}\n')
    await expect(readVerifiedStaticDeploymentSnapshot(target)).resolves.toBeUndefined()

    await createStaticDeploymentSnapshot(workspace, target, new AbortController().signal)
    const staleTemporaryManifest = `${deploymentSnapshotManifestPath(target)}.tmp-stale`
    await writeFile(staleTemporaryManifest, 'stale\n')
    await createStaticDeploymentSnapshot(workspace, target, new AbortController().signal)
    await expect(readFile(staleTemporaryManifest, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const externalManifest = resolve(root, 'external-manifest.json')
    await writeFile(externalManifest, await readFile(deploymentSnapshotManifestPath(target)))
    await rm(deploymentSnapshotManifestPath(target))
    await symlink(externalManifest, deploymentSnapshotManifestPath(target))
    await expect(readVerifiedStaticDeploymentSnapshot(target)).resolves.toBeUndefined()

    await rm(deploymentSnapshotManifestPath(target))
    await createStaticDeploymentSnapshot(workspace, target, new AbortController().signal)
    await rm(target, { recursive: true })
    await symlink(workspace, target)
    await expect(readVerifiedStaticDeploymentSnapshot(target)).resolves.toBeUndefined()
  })
})
