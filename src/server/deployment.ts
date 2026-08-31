import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { assertNoSymlinkTraversal, findWebsiteEntry, isWorkspaceInternalPath, resolveWorkspacePath } from './workspace.js'

const MAX_DEPLOYMENT_FILES = 2_000
const MAX_DEPLOYMENT_BYTES = 50 * 1024 * 1024
const MAX_DEPLOYMENT_FILE_BYTES = 20 * 1024 * 1024
const STATIC_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.ico', '.woff', '.woff2', '.ttf', '.otf', '.wasm', '.xml', '.txt', '.webmanifest', '.map', '.mp3', '.mp4', '.webm', '.ogg',
])
const SOURCE_ONLY_ROOTS = new Set(['src', 'test', 'tests', 'scripts', 'coverage', 'uploads'])
const SOURCE_ONLY_FILES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json', 'vite.config.js', 'vite.config.ts',
])

export interface StaticDeploymentSnapshot {
  sourceDirectory: string
  entryPath: string
  fileCount: number
  bytes: number
  contentHash: string
}

interface StaticDeploymentManifest {
  schemaVersion: 'anera-static-deployment/1'
  snapshot: StaticDeploymentSnapshot
}

export async function createStaticDeploymentSnapshot(
  workspace: string,
  target: string,
  signal: AbortSignal,
): Promise<StaticDeploymentSnapshot> {
  const manifestPath = deploymentSnapshotManifestPath(target)
  await removeDeploymentManifestSidecars(target)
  const selected = await selectStaticSource(workspace)
  const source = resolveWorkspacePath(workspace, selected.sourceDirectory)
  await assertNoSymlinkTraversal(workspace, source)
  const files: Array<{ absolute: string; path: string; bytes: number }> = []

  const visit = async (directory: string): Promise<void> => {
    signal.throwIfAborted()
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      signal.throwIfAborted()
      const absolute = resolve(directory, entry.name)
      const path = relative(source, absolute).split(sep).join('/')
      if (shouldSkipDeploymentPath(path, selected.sourceDirectory === '.')) continue
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!info.isFile() || !STATIC_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      if (info.size > MAX_DEPLOYMENT_FILE_BYTES) throw new Error(`Deployment file exceeds ${MAX_DEPLOYMENT_FILE_BYTES} bytes: ${path}`)
      files.push({ absolute, path, bytes: info.size })
      if (files.length > MAX_DEPLOYMENT_FILES) throw new Error(`Deployment exceeds ${MAX_DEPLOYMENT_FILES} files`)
      if (files.reduce((sum, file) => sum + file.bytes, 0) > MAX_DEPLOYMENT_BYTES) {
        throw new Error(`Deployment exceeds ${MAX_DEPLOYMENT_BYTES} bytes`)
      }
    }
  }

  await visit(source)
  files.sort((left, right) => left.path.localeCompare(right.path))
  if (!files.some((file) => file.path === selected.entryPath)) throw new Error(`Deployment entry was not included: ${selected.entryPath}`)
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  const hash = createHash('sha256')
  let copiedBytes = 0
  try {
    for (const file of files) {
      signal.throwIfAborted()
      const destination = resolve(target, file.path)
      await mkdir(dirname(destination), { recursive: true })
      const content = await readFile(file.absolute)
      if (content.length > MAX_DEPLOYMENT_FILE_BYTES) throw new Error(`Deployment file exceeds ${MAX_DEPLOYMENT_FILE_BYTES} bytes: ${file.path}`)
      copiedBytes += content.length
      if (copiedBytes > MAX_DEPLOYMENT_BYTES) throw new Error(`Deployment exceeds ${MAX_DEPLOYMENT_BYTES} bytes`)
      hash.update(file.path).update('\0').update(content).update('\0')
      await writeFile(destination, content)
    }
  } catch (error) {
    await removeStaticDeploymentSnapshot(target)
    throw error
  }
  const snapshot = {
    sourceDirectory: selected.sourceDirectory,
    entryPath: selected.entryPath,
    fileCount: files.length,
    bytes: copiedBytes,
    contentHash: hash.digest('hex'),
  }
  const manifest: StaticDeploymentManifest = {
    schemaVersion: 'anera-static-deployment/1',
    snapshot,
  }
  const temporaryManifest = `${manifestPath}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporaryManifest, `${JSON.stringify(manifest)}\n`, 'utf8')
    await rename(temporaryManifest, manifestPath)
  } catch (error) {
    await rm(temporaryManifest, { force: true })
    await removeStaticDeploymentSnapshot(target)
    throw error
  }
  return snapshot
}

export function deploymentSnapshotManifestPath(target: string): string {
  return `${target}.manifest.json`
}

export async function removeStaticDeploymentSnapshot(target: string): Promise<void> {
  await Promise.all([rm(target, { recursive: true, force: true }), removeDeploymentManifestSidecars(target)])
}

export async function readVerifiedStaticDeploymentSnapshot(target: string): Promise<StaticDeploymentSnapshot | undefined> {
  try {
    const manifestPath = deploymentSnapshotManifestPath(target)
    const manifestInfo = await lstat(manifestPath)
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.size > 64 * 1024) return undefined
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as StaticDeploymentManifest
    const snapshot = manifest?.snapshot
    if (
      manifest.schemaVersion !== 'anera-static-deployment/1'
      || !snapshot
      || typeof snapshot.sourceDirectory !== 'string'
      || typeof snapshot.entryPath !== 'string'
      || !Number.isInteger(snapshot.fileCount)
      || snapshot.fileCount < 1
      || snapshot.fileCount > MAX_DEPLOYMENT_FILES
      || !Number.isInteger(snapshot.bytes)
      || snapshot.bytes < 0
      || snapshot.bytes > MAX_DEPLOYMENT_BYTES
      || !/^[a-f0-9]{64}$/.test(snapshot.contentHash)
    ) return undefined

    const targetInfo = await lstat(target)
    if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) return undefined
    const files: Array<{ path: string; content: Buffer }> = []
    let discoveredBytes = 0
    const visit = async (directory: string): Promise<boolean> => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const absolute = resolve(directory, entry.name)
        const info = await lstat(absolute)
        if (info.isSymbolicLink()) return false
        if (info.isDirectory()) {
          if (!await visit(absolute)) return false
        } else if (info.isFile()) {
          discoveredBytes += info.size
          if (
            info.size > MAX_DEPLOYMENT_FILE_BYTES
            || discoveredBytes > MAX_DEPLOYMENT_BYTES
            || files.length + 1 > MAX_DEPLOYMENT_FILES
          ) return false
          files.push({ path: relative(target, absolute).split(sep).join('/'), content: await readFile(absolute) })
        } else {
          return false
        }
      }
      return true
    }
    if (!await visit(target)) return undefined
    files.sort((left, right) => left.path.localeCompare(right.path))
    const hash = createHash('sha256')
    for (const file of files) hash.update(file.path).update('\0').update(file.content).update('\0')
    const bytes = files.reduce((total, file) => total + file.content.length, 0)
    if (
      files.length !== snapshot.fileCount
      || bytes !== snapshot.bytes
      || hash.digest('hex') !== snapshot.contentHash
      || !files.some((file) => file.path === snapshot.entryPath)
    ) return undefined
    return snapshot
  } catch {
    return undefined
  }
}

async function removeDeploymentManifestSidecars(target: string): Promise<void> {
  const manifestPath = deploymentSnapshotManifestPath(target)
  const parent = dirname(manifestPath)
  const temporaryPrefix = `${basename(manifestPath)}.tmp-`
  let temporaryNames: string[] = []
  try {
    temporaryNames = (await readdir(parent))
      .filter((name) => name.startsWith(temporaryPrefix))
  } catch {
    // The deployment directory may not exist yet.
  }
  await Promise.all([
    rm(manifestPath, { force: true }),
    ...temporaryNames.map((name) => rm(resolve(parent, name), { force: true })),
  ])
}

async function selectStaticSource(workspace: string): Promise<{ sourceDirectory: string; entryPath: string }> {
  for (const sourceDirectory of ['dist', 'build', 'out']) {
    const entry = resolveWorkspacePath(workspace, `${sourceDirectory}/index.html`)
    try {
      await assertNoSymlinkTraversal(workspace, entry)
      if ((await stat(entry)).isFile()) return { sourceDirectory, entryPath: 'index.html' }
    } catch {
      // Continue through deterministic build output candidates.
    }
  }
  const entry = await findWebsiteEntry(workspace)
  if (!entry) throw new Error('No deployable HTML entry file found')
  const sourceDirectory = dirname(entry).split(sep).join('/') || '.'
  return { sourceDirectory, entryPath: basename(entry) }
}

function shouldSkipDeploymentPath(path: string, sourceIsWorkspaceRoot: boolean): boolean {
  if (isWorkspaceInternalPath(path)) return true
  const parts = path.split('/')
  if (parts.some((part) => part.startsWith('.'))) return true
  if (SOURCE_ONLY_FILES.has(path) || SOURCE_ONLY_FILES.has(parts.at(-1) || '')) return true
  return sourceIsWorkspaceRoot && SOURCE_ONLY_ROOTS.has(parts[0])
}
