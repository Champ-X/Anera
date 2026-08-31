import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, posix, resolve } from 'node:path'
import {
  assertNoSymlinkTraversal,
  resolveWorkspacePath,
} from './workspace.js'

export interface WorkspacePatchChange {
  path: string
  operation: 'added' | 'updated' | 'deleted'
  bytes: number
}

export interface WorkspacePatchPreparedChange extends WorkspacePatchChange {
  initialExists: boolean
  beforeSha256?: string
  afterSha256?: string
}

export type WorkspacePatchDurablePhase = 'prepared' | 'installed' | 'committed'

export interface WorkspacePatchOptions {
  transactionParent?: string
  onDurablePhase?: (
    phase: WorkspacePatchDurablePhase,
    details: {
      transactionId: string
      installedCount: number
      changeCount: number
      changes: WorkspacePatchPreparedChange[]
    },
  ) => Promise<void> | void
}

export interface WorkspacePatchRecovery {
  transactionId: string
  phase: 'unknown' | 'prepared' | 'committed'
  action: 'manifest_missing_discarded' | 'rolled_back' | 'committed_verified' | 'committed_corrupt_rolled_back'
  changeCount: number
}

interface VirtualFile {
  path: string
  initialExists: boolean
  initialContent: string | null
  content: string | null
  touched: boolean
}

interface ParsedHunk {
  locator?: string
  oldLines: string[]
  newLines: string[]
  oldNoNewline: boolean
  newNoNewline: boolean
}

interface StagedChange extends WorkspacePatchChange {
  content: string | null
  initialExists: boolean
}

interface DurablePatchChange extends WorkspacePatchChange {
  initialExists: boolean
  stageName?: string
  backupName?: string
  beforeSha256?: string
  afterSha256?: string
}

interface DurablePatchManifest {
  version: 1
  transactionId: string
  phase: 'prepared' | 'committed'
  createdAt: string
  changes: DurablePatchChange[]
}

export async function applyWorkspacePatch(
  root: string,
  input: string,
  signal?: AbortSignal,
  options: WorkspacePatchOptions = {},
): Promise<WorkspacePatchChange[]> {
  signal?.throwIfAborted()
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0] !== '*** Begin Patch') throw new Error('Patch must start with *** Begin Patch')
  const endIndex = lines.lastIndexOf('*** End Patch')
  if (endIndex === -1) throw new Error('Patch must end with *** End Patch')
  if (lines.slice(endIndex + 1).some((line) => line !== '')) throw new Error('Unexpected content after *** End Patch')

  const files = new Map<string, VirtualFile>()
  const load = async (rawPath: string): Promise<VirtualFile> => {
    const path = validatePatchPath(rawPath)
    const cached = files.get(path)
    if (cached) return cached
    const target = resolveWorkspacePath(root, path)
    await assertNoSymlinkTraversal(root, target)
    try {
      const info = await lstat(target)
      if (!info.isFile()) throw new Error(`Patch target is not a regular file: ${path}`)
      const content = await readFile(target, 'utf8')
      if (content.includes('\0')) throw new Error(`Patch target is not a UTF-8 text file: ${path}`)
      const file = { path, initialExists: true, initialContent: content, content, touched: false }
      files.set(path, file)
      return file
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const file = { path, initialExists: false, initialContent: null, content: null, touched: false }
      files.set(path, file)
      return file
    }
  }

  let index = 1
  while (index < endIndex) {
    signal?.throwIfAborted()
    const header = lines[index]
    if (!header) {
      index += 1
      continue
    }
    const add = header.match(/^\*\*\* Add File: (.+)$/)
    const update = header.match(/^\*\*\* Update File: (.+)$/)
    const remove = header.match(/^\*\*\* Delete File: (.+)$/)
    if (add) {
      const file = await load(add[1])
      if (file.content !== null) throw new Error(`Patch destination already exists: ${file.path}`)
      index += 1
      const addedLines: string[] = []
      while (index < endIndex && !lines[index].startsWith('*** ')) {
        const line = lines[index]
        if (!line.startsWith('+')) throw new Error(`Added file lines must start with +: ${file.path}`)
        addedLines.push(line.slice(1))
        index += 1
      }
      file.content = addedLines.length === 0 ? '' : `${addedLines.join('\n')}\n`
      file.touched = true
      continue
    }
    if (remove) {
      const file = await load(remove[1])
      if (file.content === null) throw new Error(`Cannot delete missing file: ${file.path}`)
      file.content = null
      file.touched = true
      index += 1
      continue
    }
    if (update) {
      const source = await load(update[1])
      if (source.content === null) throw new Error(`Cannot update missing file: ${source.path}`)
      index += 1
      let destination = source
      if (lines[index]?.startsWith('*** Move to: ')) {
        destination = await load(lines[index].slice('*** Move to: '.length))
        if (destination.path !== source.path && destination.content !== null) {
          throw new Error(`Patch destination already exists: ${destination.path}`)
        }
        index += 1
      }

      const hunks: ParsedHunk[] = []
      while (index < endIndex && !lines[index].startsWith('*** ')) {
        if (!lines[index].startsWith('@@')) throw new Error(`Expected @@ hunk header for ${source.path}`)
        const locator = lines[index].slice(2).trim()
        index += 1
        const hunkLines: string[] = []
        while (index < endIndex && !lines[index].startsWith('@@') && !lines[index].startsWith('*** ')) {
          hunkLines.push(lines[index])
          index += 1
        }
        hunks.push(parseHunk(source.path, locator || undefined, hunkLines))
      }
      if (hunks.length === 0) throw new Error(`Update patch contains no hunks: ${source.path}`)
      const next = applyHunks(source.content, source.path, hunks)
      source.touched = true
      if (destination.path === source.path) {
        source.content = next
      } else {
        source.content = null
        destination.content = next
        destination.touched = true
      }
      continue
    }
    throw new Error(`Unknown patch directive: ${header}`)
  }

  const changes = [...files.values()].flatMap((file): StagedChange[] => {
    if (!file.touched || file.content === file.initialContent) return []
    if (!file.initialExists && file.content !== null) {
      return [{ path: file.path, operation: 'added', bytes: Buffer.byteLength(file.content), content: file.content, initialExists: false }]
    }
    if (file.initialExists && file.content === null) {
      return [{ path: file.path, operation: 'deleted', bytes: 0, content: null, initialExists: true }]
    }
    if (file.initialExists && file.content !== null) {
      return [{ path: file.path, operation: 'updated', bytes: Buffer.byteLength(file.content), content: file.content, initialExists: true }]
    }
    return []
  })
  if (changes.length === 0) throw new Error('Patch contains no effective file changes')
  await commitChanges(root, changes, signal, options)
  return changes.map(({ path, operation, bytes }) => ({ path, operation, bytes }))
}

function parseHunk(path: string, locator: string | undefined, lines: string[]): ParsedHunk {
  const oldLines: string[] = []
  const newLines: string[] = []
  let oldNoNewline = false
  let newNoNewline = false
  let previousMarker = ''
  for (const line of lines) {
    if (line === '\\ No newline at end of file') {
      if (!previousMarker) throw new Error(`Misplaced no-newline marker in patch hunk for ${path}`)
      if (previousMarker === '-' || previousMarker === ' ') oldNoNewline = true
      if (previousMarker === '+' || previousMarker === ' ') newNoNewline = true
      continue
    }
    const marker = line[0]
    if (![' ', '+', '-'].includes(marker)) throw new Error(`Invalid patch hunk line for ${path}: ${line}`)
    if (marker !== '+') oldLines.push(line.slice(1))
    if (marker !== '-') newLines.push(line.slice(1))
    previousMarker = marker
  }
  if (oldLines.length === 0 && newLines.length === 0) throw new Error(`Empty patch hunk for ${path}`)
  return { locator, oldLines, newLines, oldNoNewline, newNoNewline }
}

function applyHunks(content: string, path: string, hunks: ParsedHunk[]): string {
  let finalNewline = content.endsWith('\n')
  let lines = splitLines(content)
  let cursor = 0
  for (const hunk of hunks) {
    let start = cursor
    if (hunk.locator) {
      const locatorMatches = findLineMatches(lines, [hunk.locator], 0)
      if (locatorMatches.length !== 1) {
        throw new Error(`Patch locator for ${path} must match exactly once; found ${locatorMatches.length}: ${hunk.locator}`)
      }
      start = locatorMatches[0] + 1
    }
    let matches = hunk.oldLines.length === 0
      ? lines.length === 0 ? [0] : hunk.locator ? [start] : []
      : findLineMatches(lines, hunk.oldLines, start)
    if (matches.length === 0 && hunk.oldLines.length > 0) {
      matches = findLineMatches(lines, hunk.oldLines, start, (line) => line.trimEnd())
    }
    if (matches.length === 0 && hunk.oldLines.length > 0) {
      matches = findLineMatches(lines, hunk.oldLines, start, (line) => line.replace(/\s+/g, ' ').trim())
    }
    if (matches.length !== 1) {
      throw new Error(`Patch hunk for ${path} must match exactly once after its cursor; found ${matches.length}`)
    }
    const match = matches[0]
    const reachesEnd = match + hunk.oldLines.length === lines.length
    lines.splice(match, hunk.oldLines.length, ...hunk.newLines)
    cursor = match + hunk.newLines.length
    if (reachesEnd) {
      finalNewline = lines.length > 0 && !hunk.newNoNewline
      if (hunk.oldNoNewline && hunk.newLines.length === 0) finalNewline = false
    }
  }
  if (lines.length === 0) return ''
  return `${lines.join('\n')}${finalNewline ? '\n' : ''}`
}

function splitLines(content: string): string[] {
  if (!content) return []
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function findLineMatches(
  content: string[],
  wanted: string[],
  start: number,
  normalize: (line: string) => string = (line) => line,
): number[] {
  const expected = wanted.map(normalize)
  const matches: number[] = []
  for (let index = Math.max(0, start); index <= content.length - wanted.length; index += 1) {
    if (expected.every((line, offset) => normalize(content[index + offset]) === line)) matches.push(index)
  }
  return matches
}

async function commitChanges(
  root: string,
  changes: StagedChange[],
  signal: AbortSignal | undefined,
  options: WorkspacePatchOptions,
): Promise<void> {
  const transactionParent = options.transactionParent ?? resolve(root, '.tmp')
  await mkdir(transactionParent, { recursive: true })
  const transactionRoot = await mkdtemp(resolve(transactionParent, 'patch-'))
  const transactionId = basename(transactionRoot)
  let manifest: DurablePatchManifest | undefined
  try {
    const durableChanges: DurablePatchChange[] = []
    for (const [index, change] of changes.entries()) {
      signal?.throwIfAborted()
      const target = resolveWorkspacePath(root, change.path)
      await assertNoSymlinkTraversal(root, target)
      const durable: DurablePatchChange = {
        path: change.path,
        operation: change.operation,
        bytes: change.bytes,
        initialExists: change.initialExists,
      }
      if (change.initialExists) {
        const backupName = `backup-${index}`
        const backup = resolve(transactionRoot, backupName)
        const before = await readFile(target)
        await link(target, backup)
        durable.backupName = backupName
        durable.beforeSha256 = sha256(before)
      }
      if (change.content !== null) {
        const stageName = `stage-${index}`
        const stage = resolve(transactionRoot, stageName)
        await writeFile(stage, change.content)
        durable.stageName = stageName
        durable.afterSha256 = sha256(Buffer.from(change.content))
      }
      durableChanges.push(durable)
    }
    manifest = {
      version: 1,
      transactionId,
      phase: 'prepared',
      createdAt: new Date().toISOString(),
      changes: durableChanges,
    }
    await writePatchManifest(transactionRoot, manifest)
    const preparedChanges = durableChanges.map(({ path, operation, bytes, initialExists, beforeSha256, afterSha256 }) => ({
      path,
      operation,
      bytes,
      initialExists,
      ...(beforeSha256 ? { beforeSha256 } : {}),
      ...(afterSha256 ? { afterSha256 } : {}),
    }))
    await options.onDurablePhase?.('prepared', {
      transactionId,
      installedCount: 0,
      changeCount: changes.length,
      changes: preparedChanges,
    })

    for (const [index, change] of durableChanges.entries()) {
      signal?.throwIfAborted()
      const target = resolveWorkspacePath(root, change.path)
      await assertNoSymlinkTraversal(root, target)
      if (!change.stageName) {
        await rm(target, { force: true })
      } else {
        const install = resolve(transactionRoot, `install-${index}`)
        await rm(install, { force: true })
        await link(resolve(transactionRoot, change.stageName), install)
        await mkdir(dirname(target), { recursive: true })
        await rename(install, target)
      }
      await options.onDurablePhase?.('installed', {
        transactionId,
        installedCount: index + 1,
        changeCount: changes.length,
        changes: preparedChanges,
      })
    }
    if (!await patchTargetStateMatches(root, manifest.changes, 'after')) {
      throw new Error(`Patch transaction ${transactionId} failed final-byte verification`)
    }
    manifest = { ...manifest, phase: 'committed' }
    await writePatchManifest(transactionRoot, manifest)
    await options.onDurablePhase?.('committed', {
      transactionId,
      installedCount: changes.length,
      changeCount: changes.length,
      changes: preparedChanges,
    })
  } catch (error) {
    if (manifest) {
      try {
        await rollbackPatchTransaction(root, transactionRoot, manifest)
      } catch (rollbackError) {
        // Preserve the manifest, stages, and backups for startup recovery. A
        // failed rollback must never destroy the only durable repair evidence.
        throw new AggregateError(
          [error, rollbackError],
          `Patch transaction ${manifest.transactionId} failed and could not be rolled back`,
        )
      }
    }
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  await rm(transactionRoot, { recursive: true, force: true })
}

export async function recoverWorkspacePatchTransactions(
  root: string,
  transactionParent: string,
): Promise<WorkspacePatchRecovery[]> {
  let names: string[]
  try {
    names = await readdir(transactionParent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const recoveries: WorkspacePatchRecovery[] = []
  for (const name of names.filter((entry) => /^patch-[A-Za-z0-9_-]+$/.test(entry)).sort()) {
    const transactionRoot = resolve(transactionParent, name)
    const info = await lstat(transactionRoot)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Invalid patch transaction directory: ${name}`)
    try {
      const manifestInfo = await lstat(resolve(transactionRoot, 'manifest.json'))
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
        throw new Error(`Invalid patch transaction manifest file: ${name}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // No target is touched before manifest.json is atomically published.
      // A missing manifest is therefore either an unprepared crash residue or
      // the tail of cleanup after a committed/rolled-back transaction.
      await rm(transactionRoot, { recursive: true, force: true })
      recoveries.push({
        transactionId: name,
        phase: 'unknown',
        action: 'manifest_missing_discarded',
        changeCount: 0,
      })
      continue
    }
    const manifest = await readPatchManifest(transactionRoot, name)
    if (manifest.phase === 'prepared') {
      await rollbackPatchTransaction(root, transactionRoot, manifest)
      recoveries.push({
        transactionId: manifest.transactionId,
        phase: manifest.phase,
        action: 'rolled_back',
        changeCount: manifest.changes.length,
      })
    } else if (await patchTargetStateMatches(root, manifest.changes, 'after')) {
      recoveries.push({
        transactionId: manifest.transactionId,
        phase: manifest.phase,
        action: 'committed_verified',
        changeCount: manifest.changes.length,
      })
    } else {
      await rollbackPatchTransaction(root, transactionRoot, manifest)
      recoveries.push({
        transactionId: manifest.transactionId,
        phase: manifest.phase,
        action: 'committed_corrupt_rolled_back',
        changeCount: manifest.changes.length,
      })
    }
    await rm(transactionRoot, { recursive: true, force: true })
  }
  return recoveries
}

async function rollbackPatchTransaction(
  root: string,
  transactionRoot: string,
  manifest: DurablePatchManifest,
): Promise<void> {
  for (const [index, change] of [...manifest.changes.entries()].reverse()) {
    const target = resolveWorkspacePath(root, change.path)
    await assertNoSymlinkTraversal(root, target)
    if (!change.initialExists) {
      await rm(target, { force: true })
      continue
    }
    if (!change.backupName || !change.beforeSha256) {
      throw new Error(`Patch transaction ${manifest.transactionId} lacks backup metadata for ${change.path}`)
    }
    const backup = resolve(transactionRoot, change.backupName)
    if (!await fileMatches(backup, undefined, change.beforeSha256)) {
      throw new Error(`Patch transaction ${manifest.transactionId} has a corrupt backup for ${change.path}`)
    }
    const restore = resolve(transactionRoot, `restore-${index}`)
    await rm(restore, { force: true })
    await link(backup, restore)
    await mkdir(dirname(target), { recursive: true })
    await rename(restore, target)
  }
  if (!await patchTargetStateMatches(root, manifest.changes, 'before')) {
    throw new Error(`Patch transaction ${manifest.transactionId} failed rollback verification`)
  }
}

async function patchTargetStateMatches(
  root: string,
  changes: DurablePatchChange[],
  side: 'before' | 'after',
): Promise<boolean> {
  for (const change of changes) {
    const target = resolveWorkspacePath(root, change.path)
    await assertNoSymlinkTraversal(root, target)
    const shouldExist = side === 'before' ? change.initialExists : Boolean(change.stageName)
    if (!shouldExist) {
      try {
        await lstat(target)
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      continue
    }
    const expectedHash = side === 'before' ? change.beforeSha256 : change.afterSha256
    if (!expectedHash || !await fileMatches(target, side === 'after' ? change.bytes : undefined, expectedHash)) return false
  }
  return true
}

async function fileMatches(target: string, bytes: number | undefined, expectedHash: string): Promise<boolean> {
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || (bytes !== undefined && info.size !== bytes)) return false
    return sha256(await readFile(target)) === expectedHash
  } catch {
    return false
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function writePatchManifest(transactionRoot: string, manifest: DurablePatchManifest): Promise<void> {
  const target = resolve(transactionRoot, 'manifest.json')
  const temporary = resolve(transactionRoot, 'manifest.tmp')
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
}

async function readPatchManifest(transactionRoot: string, expectedId: string): Promise<DurablePatchManifest> {
  const raw = JSON.parse(await readFile(resolve(transactionRoot, 'manifest.json'), 'utf8')) as DurablePatchManifest
  if (
    raw.version !== 1
    || raw.transactionId !== expectedId
    || !['prepared', 'committed'].includes(raw.phase)
    || typeof raw.createdAt !== 'string'
    || !Array.isArray(raw.changes)
    || raw.changes.length === 0
  ) throw new Error(`Invalid patch transaction manifest: ${expectedId}`)
  for (const change of raw.changes) {
    if (
      !change
      || typeof change.path !== 'string'
      || validatePatchPath(change.path) !== change.path
      || !['added', 'updated', 'deleted'].includes(change.operation)
      || !Number.isSafeInteger(change.bytes)
      || change.bytes < 0
      || typeof change.initialExists !== 'boolean'
      || (change.stageName !== undefined && !/^stage-\d+$/.test(change.stageName))
      || (change.backupName !== undefined && !/^backup-\d+$/.test(change.backupName))
      || (change.beforeSha256 !== undefined && !/^[a-f0-9]{64}$/.test(change.beforeSha256))
      || (change.afterSha256 !== undefined && !/^[a-f0-9]{64}$/.test(change.afterSha256))
      || (change.initialExists && (!change.backupName || !change.beforeSha256))
      || (change.operation === 'deleted' ? change.stageName !== undefined || change.afterSha256 !== undefined : !change.stageName || !change.afterSha256)
    ) throw new Error(`Invalid patch transaction change in ${expectedId}`)
  }
  return raw
}

function validatePatchPath(path: string): string {
  const value = posix.normalize(path.trim().replaceAll('\\', '/'))
  if (!value || value === '.') throw new Error('Patch path cannot be empty')
  if (value === '..' || value.startsWith('../') || value.startsWith('/')) throw new Error('Patch path escapes the workspace')
  return value
}
