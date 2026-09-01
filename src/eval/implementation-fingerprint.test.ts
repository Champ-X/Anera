import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintProductionImplementation } from './implementation-fingerprint.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('production implementation fingerprint', () => {
  it('binds the verifier and complete runtime bundle while excluding maps, tests, and showcase fixtures', async () => {
    const root = await fixtureRoot()
    const options = {
      verifierPaths: ['scripts/verifier.mjs'],
      sourceEntrypoints: ['src/server/app.ts'],
      serverRuntimeRoots: ['dist-server/server', 'dist-server/shared'],
      clientRuntimePaths: ['dist-client/index.html', 'dist-client/assets'],
    }
    const first = await fingerprintProductionImplementation(root, options)
    expect(first.schemaVersion).toBe(3)
    expect(Object.keys(first.files)).toEqual(expect.arrayContaining([
      'scripts/verifier.mjs',
      'src/server/app.ts',
      'dist-server/server/app.js',
      'dist-server/server/config.js',
      'dist-server/shared/types.js',
      'dist-client/index.html',
      'dist-client/assets/index.js',
      'dist-client/assets/font.woff2',
    ]))
    expect(Object.keys(first.files)).not.toEqual(expect.arrayContaining([
      'dist-server/server/app.js.map',
      'dist-server/server/app.test.js',
      'dist-client/assets/index.js.map',
      'dist-client/showcase/session.json',
    ]))

    await writeFile(resolve(root, 'dist-server/server/config.js'), 'export const changed = true\n', 'utf8')
    const runtimeChanged = await fingerprintProductionImplementation(root, options)
    expect(runtimeChanged.aggregateSha256).not.toBe(first.aggregateSha256)

    await writeFile(resolve(root, 'scripts/verifier.mjs'), 'export const verifier = 2\n', 'utf8')
    const verifierChanged = await fingerprintProductionImplementation(root, options)
    expect(verifierChanged.aggregateSha256).not.toBe(runtimeChanged.aggregateSha256)
  })

  it('rejects runtime symlinks instead of hashing outside the production tree', async () => {
    const root = await fixtureRoot()
    await symlink(resolve(root, 'outside.js'), resolve(root, 'dist-server/server/linked.js'))
    await expect(fingerprintProductionImplementation(root, {
      verifierPaths: ['scripts/verifier.mjs'],
      sourceEntrypoints: ['src/server/app.ts'],
      serverRuntimeRoots: ['dist-server/server'],
      clientRuntimePaths: ['dist-client/index.html'],
    })).rejects.toThrow('Implementation fingerprint refuses symlink')
  })
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'anera-implementation-fingerprint-'))
  roots.push(root)
  const files: Record<string, string> = {
    'package.json': '{}\n',
    'package-lock.json': '{}\n',
    'scripts/verifier.mjs': 'export const verifier = 1\n',
    'src/eval/implementation-fingerprint.ts': 'source implementation\n',
    'src/server/app.ts': 'source app\n',
    'dist-server/eval/implementation-fingerprint.js': 'compiled implementation\n',
    'dist-server/server/app.js': 'export const app = true\n',
    'dist-server/server/app.js.map': '{}\n',
    'dist-server/server/app.test.js': 'throw new Error("test only")\n',
    'dist-server/server/config.js': 'export const config = true\n',
    'dist-server/shared/types.js': 'export {}\n',
    'dist-client/index.html': '<!doctype html>\n',
    'dist-client/assets/index.js': 'console.log("client")\n',
    'dist-client/assets/index.js.map': '{}\n',
    'dist-client/assets/font.woff2': 'font bytes\n',
    'dist-client/showcase/session.json': '{}\n',
    'outside.js': 'outside\n',
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(resolve(root, path, '..'), { recursive: true })
    await writeFile(resolve(root, path), content, 'utf8')
  }
  return root
}
