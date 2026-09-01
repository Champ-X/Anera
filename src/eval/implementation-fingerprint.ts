import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

export interface ImplementationFingerprintFile {
  bytes: number
  sha256: string
}

export interface ImplementationFingerprint {
  schemaVersion: 3
  aggregateSha256: string
  scope: {
    verifierPaths: string[]
    sourceEntrypoints: string[]
    serverRuntimeRoots: string[]
    clientRuntimePaths: string[]
  }
  files: Record<string, ImplementationFingerprintFile>
}

export interface ImplementationFingerprintOptions {
  verifierPaths?: string[]
  sourceEntrypoints?: string[]
  serverRuntimeRoots?: string[]
  clientRuntimePaths?: string[]
}

const DEFAULT_SOURCE_ENTRYPOINTS = [
  'src/server/app.ts',
  'src/server/agent-service.ts',
  'src/server/tools.ts',
  'src/server/deepseek.ts',
  'src/client/App.tsx',
  'src/client/styles.css',
]

const DEFAULT_SERVER_RUNTIME_ROOTS = [
  'dist-server/server',
  'dist-server/shared',
]

const DEFAULT_CLIENT_RUNTIME_PATHS = [
  'dist-client/index.html',
  'dist-client/assets',
]

const FINGERPRINT_IMPLEMENTATION_PATHS = [
  'src/eval/implementation-fingerprint.ts',
  'dist-server/eval/implementation-fingerprint.js',
]

/**
 * Bind an attestation to the verifier, source entrypoints, and every executable
 * file shipped in the production server/client bundle. Tests, source maps, and
 * showcase-only fixtures are deliberately outside this runtime fingerprint.
 */
export async function fingerprintProductionImplementation(
  root: string,
  options: ImplementationFingerprintOptions = {},
): Promise<ImplementationFingerprint> {
  const verifierPaths = normalizedUnique(options.verifierPaths ?? [])
  const sourceEntrypoints = normalizedUnique(options.sourceEntrypoints ?? DEFAULT_SOURCE_ENTRYPOINTS)
  const serverRuntimeRoots = normalizedUnique(options.serverRuntimeRoots ?? DEFAULT_SERVER_RUNTIME_ROOTS)
  const clientRuntimePaths = normalizedUnique(options.clientRuntimePaths ?? DEFAULT_CLIENT_RUNTIME_PATHS)
  const fixedPaths = normalizedUnique([
    'package.json',
    'package-lock.json',
    ...FINGERPRINT_IMPLEMENTATION_PATHS,
    ...verifierPaths,
    ...sourceEntrypoints,
  ])

  const serverRuntimeFiles = (
    await Promise.all(serverRuntimeRoots.map((path) => collectRelativeFiles(root, path)))
  ).flat().filter((path) => path.endsWith('.js') && !path.endsWith('.test.js'))
  const clientRuntimeFiles = (
    await Promise.all(clientRuntimePaths.map((path) => collectRelativeFiles(root, path)))
  ).flat().filter((path) => !path.endsWith('.map') && !path.endsWith('.test.js'))
  const relativePaths = normalizedUnique([...fixedPaths, ...serverRuntimeFiles, ...clientRuntimeFiles])
  const files: Record<string, ImplementationFingerprintFile> = {}
  for (const relativePath of relativePaths) {
    const content = await readFile(resolve(root, relativePath))
    files[relativePath] = {
      bytes: content.byteLength,
      sha256: sha256(content),
    }
  }

  const scope = {
    verifierPaths,
    sourceEntrypoints,
    serverRuntimeRoots,
    clientRuntimePaths,
  }
  const aggregatePayload = {
    schemaVersion: 3,
    scope,
    files: Object.entries(files),
  }
  return {
    schemaVersion: 3,
    aggregateSha256: sha256(JSON.stringify(aggregatePayload)),
    scope,
    files,
  }
}

async function collectRelativeFiles(root: string, relativePath: string): Promise<string[]> {
  const absolutePath = resolve(root, relativePath)
  const info = await lstat(absolutePath)
  if (info.isSymbolicLink()) throw new Error(`Implementation fingerprint refuses symlink: ${normalizeRelativePath(relative(root, absolutePath))}`)
  if (info.isFile()) return [normalizeRelativePath(relative(root, absolutePath))]
  if (!info.isDirectory()) throw new Error(`Implementation fingerprint requires a file or directory: ${normalizeRelativePath(relative(root, absolutePath))}`)
  const entries = await readdir(absolutePath, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = resolve(absolutePath, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Implementation fingerprint refuses symlink: ${normalizeRelativePath(relative(root, child))}`)
    if (entry.isDirectory()) {
      files.push(...await collectRelativeFiles(root, normalizeRelativePath(relative(root, child))))
    } else if (entry.isFile()) {
      files.push(normalizeRelativePath(relative(root, child)))
    }
  }
  return files
}

function normalizedUnique(paths: string[]): string[] {
  return [...new Set(paths.map(normalizeRelativePath))].sort()
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`Implementation fingerprint path must be project-relative: ${path}`)
  }
  return normalized
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
