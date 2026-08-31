import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import type { WorkspaceEntry } from '../shared/types.js'
import {
  isWorkspaceInternalPath,
  isWorkspaceSnapshotExcludedPath,
} from '../shared/workspace-snapshot-policy.js'

export { isWorkspaceInternalPath, isWorkspaceSnapshotExcludedPath } from '../shared/workspace-snapshot-policy.js'

export function encodeWorkspaceUrlPath(path: string): string {
  return path.replaceAll('\\', '/').split('/').map((part) => encodeURIComponent(part)).join('/')
}

export function resolveWorkspacePath(root: string, requestedPath: string): string {
  if (requestedPath.includes('\0')) throw new Error('Path contains a null byte')
  const normalized = requestedPath.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error('Absolute paths are outside the workspace')
  }
  const target = resolve(root, normalized || '.')
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('Path escapes the workspace')
  }
  return target
}

export async function assertNoSymlinkTraversal(root: string, target: string): Promise<void> {
  const rel = relative(root, target)
  if (!rel || rel === '.') return
  let current = root
  for (const part of rel.split(sep)) {
    current = resolve(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink traversal is not allowed')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export async function readWorkspaceFile(
  root: string,
  path: string,
  maxBytes: number,
): Promise<{ content: string; bytes: number; truncated: boolean }> {
  const target = resolveWorkspacePath(root, path)
  await assertNoSymlinkTraversal(root, target)
  const info = await stat(target)
  if (!info.isFile()) throw new Error('Path is not a file')
  const buffer = await readFile(target)
  const truncated = buffer.length > maxBytes
  return {
    content: buffer.subarray(0, maxBytes).toString('utf8'),
    bytes: buffer.length,
    truncated,
  }
}

export interface WorkspaceTextPage {
  content: string
  bytes: number
  totalLines: number
  startLine: number
  endLine: number
  outputBytes: number
  /** 0-based UTF-8 byte offset within startLine when this page is a line fragment. */
  contentOffset?: number
  /** Continue the same startLine at this exact 0-based UTF-8 byte boundary. */
  nextContentOffset?: number
  nextOffset?: number
  truncatedBy?: 'lines' | 'bytes'
}

export async function readWorkspaceTextPage(
  root: string,
  path: string,
  options: {
    offset?: number
    limit?: number
    contentOffset?: number
    maxBytes: number
    signal?: AbortSignal
    readChunkBytes?: number
    onBufferedBytes?: (bytes: number) => void
  },
): Promise<WorkspaceTextPage> {
  const offset = options.offset ?? 1
  const limit = options.limit ?? 2_000
  const requestedContentOffset = options.contentOffset
  const readChunkBytes = options.readChunkBytes ?? 64 * 1_024
  if (!Number.isInteger(offset) || offset < 1) throw new Error('offset must be a positive 1-based line number')
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive line count')
  if (requestedContentOffset !== undefined && (!Number.isInteger(requestedContentOffset) || requestedContentOffset < 0)) {
    throw new Error('content_offset must be a non-negative 0-based UTF-8 byte offset')
  }
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) throw new Error('maxBytes must be a positive integer')
  if (!Number.isInteger(readChunkBytes) || readChunkBytes < 1 || readChunkBytes > 64 * 1_024) {
    throw new Error('readChunkBytes must be an integer between 1 and 65536')
  }

  const target = resolveWorkspacePath(root, path)
  await assertNoSymlinkTraversal(root, target)
  const info = await stat(target)
  if (!info.isFile()) throw new Error('Path is not a file')

  const selected: Array<{ lineNumber: number; content: Buffer }> = []
  let totalLines = 0
  let outputBytes = 0
  let truncatedBy: WorkspaceTextPage['truncatedBy']
  let selectedBodyBytes = 0
  let fragment: LineFragmentDraft | undefined
  let currentLineNumber = 1
  let currentLineBytes = 0
  let currentLineStarted = false
  let currentCapture: LineCapture | undefined
  let skipLfAfterCr = false
  let finalByte: number | undefined

  const observeBufferedBytes = (): void => {
    if (!options.onBufferedBytes) return
    const retainedBytes = selectedBodyBytes
      + (currentCapture?.capturedBytes ?? 0)
      + (fragment?.window.length ?? 0)
    // Conservatively include a second copy while bounded chunks are materialized
    // into a contiguous Buffer or the returned UTF-8 string.
    options.onBufferedBytes(readChunkBytes + (retainedBytes * 2))
  }

  const beginLine = (): void => {
    if (currentLineStarted) return
    currentLineStarted = true
    if (currentLineNumber < offset || truncatedBy || fragment) return
    if (currentLineNumber === offset && requestedContentOffset !== undefined) {
      currentCapture = createLineCapture(requestedContentOffset, options.maxBytes + UTF8_BOUNDARY_LOOKAHEAD)
      observeBufferedBytes()
      return
    }
    if (selected.length >= limit) {
      truncatedBy = 'lines'
      return
    }
    const separatorBytes = selected.length > 0 ? 1 : 0
    const availableLineBytes = options.maxBytes - outputBytes - separatorBytes
    currentCapture = createLineCapture(0, Math.max(0, availableLineBytes) + UTF8_BOUNDARY_LOOKAHEAD)
    observeBufferedBytes()
  }

  const finishLine = (): void => {
    beginLine()
    totalLines = currentLineNumber
    const capture = currentCapture
    currentCapture = undefined
    if (currentLineNumber >= offset && !truncatedBy && !fragment) {
      if (currentLineNumber === offset && requestedContentOffset !== undefined) {
        fragment = {
          lineNumber: currentLineNumber,
          lineBytes: currentLineBytes,
          contentOffset: requestedContentOffset,
          window: finishLineCapture(capture),
        }
      } else {
        const separatorBytes = selected.length > 0 ? 1 : 0
        const availableLineBytes = options.maxBytes - outputBytes - separatorBytes
        if (currentLineBytes > availableLineBytes) {
          if (selected.length === 0 && currentLineNumber === offset) {
            fragment = {
              lineNumber: currentLineNumber,
              lineBytes: currentLineBytes,
              contentOffset: 0,
              window: finishLineCapture(capture),
            }
          } else {
            truncatedBy = 'bytes'
          }
        } else {
          const content = finishLineCapture(capture)
          selected.push({ lineNumber: currentLineNumber, content })
          selectedBodyBytes += content.length
          outputBytes += separatorBytes + currentLineBytes
        }
      }
    }
    currentLineNumber += 1
    currentLineBytes = 0
    currentLineStarted = false
    currentCapture = undefined
    observeBufferedBytes()
  }

  const handle = await open(target, 'r')
  const readBuffer = Buffer.allocUnsafe(readChunkBytes)
  observeBufferedBytes()
  try {
    while (true) {
      options.signal?.throwIfAborted()
      const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, null)
      if (bytesRead === 0) break
      finalByte = readBuffer[bytesRead - 1]
      let chunkOffset = 0
      while (chunkOffset < bytesRead) {
        if (skipLfAfterCr) {
          skipLfAfterCr = false
          if (readBuffer[chunkOffset] === 0x0a) {
            chunkOffset += 1
            continue
          }
        }

        let delimiterOffset = chunkOffset
        while (
          delimiterOffset < bytesRead
          && readBuffer[delimiterOffset] !== 0x0a
          && readBuffer[delimiterOffset] !== 0x0d
        ) {
          delimiterOffset += 1
        }
        if (delimiterOffset > chunkOffset) {
          beginLine()
          const contentChunk = readBuffer.subarray(chunkOffset, delimiterOffset)
          appendLineCapture(currentCapture, contentChunk, currentLineBytes)
          currentLineBytes += contentChunk.length
          observeBufferedBytes()
        }
        if (delimiterOffset === bytesRead) break

        beginLine()
        const delimiter = readBuffer[delimiterOffset]
        finishLine()
        chunkOffset = delimiterOffset + 1
        if (delimiter === 0x0d) skipLfAfterCr = true
      }
    }
    if (currentLineStarted) finishLine()
  } finally {
    await handle.close()
  }

  if (offset > Math.max(1, totalLines)) throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`)
  if (requestedContentOffset !== undefined && totalLines === 0) {
    throw new Error('content_offset cannot be used because the file has no lines')
  }
  if (fragment) {
    return finishUtf8LineFragment(fragment, totalLines, finalByte === 0x0a, info.size, options.maxBytes)
  }

  let endLine = selected.length > 0 ? selected[selected.length - 1].lineNumber : offset - 1
  let hasMore = totalLines > endLine
  let appendTerminalLf = false
  if (!hasMore && selected.length > 0 && finalByte === 0x0a) {
    if (outputBytes < options.maxBytes) {
      appendTerminalLf = true
      outputBytes += 1
    } else if (selected.length === 1) {
      const onlyLine = selected[0]
      return finishUtf8LineFragment({
        lineNumber: onlyLine.lineNumber,
        lineBytes: onlyLine.content.length,
        contentOffset: 0,
        window: onlyLine.content,
      }, totalLines, true, info.size, options.maxBytes)
    } else {
      const deferredLine = selected.pop()!
      selectedBodyBytes -= deferredLine.content.length
      outputBytes -= deferredLine.content.length + 1
      endLine = selected[selected.length - 1].lineNumber
      hasMore = true
      truncatedBy = 'bytes'
    }
  }
  const content = `${selected.map((line) => line.content.toString('utf8')).join('\n')}${appendTerminalLf ? '\n' : ''}`
  return {
    content,
    bytes: info.size,
    totalLines,
    startLine: offset,
    endLine,
    outputBytes,
    ...(hasMore ? { nextOffset: endLine + 1 } : {}),
    ...(hasMore && truncatedBy ? { truncatedBy } : {}),
  }
}

const UTF8_BOUNDARY_LOOKAHEAD = 4

interface LineCapture {
  startOffset: number
  limit: number
  chunks: Buffer[]
  capturedBytes: number
}

interface LineFragmentDraft {
  lineNumber: number
  lineBytes: number
  contentOffset: number
  window: Buffer
}

function createLineCapture(startOffset: number, limit: number): LineCapture {
  return { startOffset, limit, chunks: [], capturedBytes: 0 }
}

function appendLineCapture(capture: LineCapture | undefined, chunk: Buffer, chunkLineOffset: number): void {
  if (!capture || capture.capturedBytes >= capture.limit) return
  const chunkEndOffset = chunkLineOffset + chunk.length
  const captureEndOffset = capture.startOffset + capture.limit
  const overlapStart = Math.max(chunkLineOffset, capture.startOffset)
  const overlapEnd = Math.min(chunkEndOffset, captureEndOffset)
  if (overlapStart >= overlapEnd) return
  const start = overlapStart - chunkLineOffset
  const end = overlapEnd - chunkLineOffset
  capture.chunks.push(Buffer.from(chunk.subarray(start, end)))
  capture.capturedBytes += end - start
}

function finishLineCapture(capture: LineCapture | undefined): Buffer {
  if (!capture || capture.capturedBytes === 0) return Buffer.alloc(0)
  return Buffer.concat(capture.chunks, capture.capturedBytes)
}

function finishUtf8LineFragment(
  fragment: LineFragmentDraft,
  totalLines: number,
  fileEndsWithLf: boolean,
  fileBytes: number,
  maxBytes: number,
): WorkspaceTextPage {
  const { contentOffset, lineBytes, lineNumber, window } = fragment
  if (contentOffset > lineBytes) {
    throw new Error(`content_offset ${contentOffset} is beyond line ${lineNumber} (${lineBytes} UTF-8 bytes)`)
  }
  const hasFollowingLines = totalLines > lineNumber
  const hasSourceLineEnding = hasFollowingLines || fileEndsWithLf
  if (contentOffset === lineBytes && lineBytes > 0) {
    throw new Error(`content_offset ${contentOffset} is already at the end of line ${lineNumber}; advance with nextOffset instead`)
  }
  if (contentOffset < lineBytes && isUtf8ContinuationByte(window[0])) {
    throw new Error(`content_offset ${contentOffset} is not a UTF-8 character boundary within line ${lineNumber}`)
  }

  let endOffset = Math.min(lineBytes, contentOffset + maxBytes)
  while (
    endOffset > contentOffset
    && endOffset < lineBytes
    && isUtf8ContinuationByte(window[endOffset - contentOffset])
  ) {
    endOffset -= 1
  }
  if (endOffset === contentOffset && contentOffset < lineBytes) {
    throw new Error(`The ${maxBytes}-byte page limit cannot include the next complete UTF-8 character at content_offset ${contentOffset} in line ${lineNumber}`)
  }

  if (endOffset === lineBytes && hasSourceLineEnding && endOffset - contentOffset + 1 > maxBytes) {
    let previousCodePoint = endOffset - 1
    while (
      previousCodePoint > contentOffset
      && isUtf8ContinuationByte(window[previousCodePoint - contentOffset])
    ) {
      previousCodePoint -= 1
    }
    if (previousCodePoint === contentOffset) {
      throw new Error(`The ${maxBytes}-byte page limit cannot include the final complete UTF-8 character and line ending at content_offset ${contentOffset} in line ${lineNumber}`)
    }
    endOffset = previousCodePoint
  }

  const lineComplete = endOffset === lineBytes
  const body = window.subarray(0, endOffset - contentOffset)
  const appendLineEnding = lineComplete && hasSourceLineEnding
  const nextContentOffset = lineComplete ? undefined : endOffset
  const nextOffset = lineComplete && hasFollowingLines ? lineNumber + 1 : undefined
  const hasMore = nextContentOffset !== undefined || nextOffset !== undefined
  return {
    content: `${body.toString('utf8')}${appendLineEnding ? '\n' : ''}`,
    bytes: fileBytes,
    totalLines,
    startLine: lineNumber,
    endLine: lineComplete ? lineNumber : lineNumber - 1,
    outputBytes: body.length + (appendLineEnding ? 1 : 0),
    contentOffset,
    ...(nextContentOffset !== undefined ? { nextContentOffset } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(hasMore ? { truncatedBy: 'bytes' as const } : {}),
  }
}

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  if (byte === undefined) return false
  return (byte & 0xc0) === 0x80
}

export async function writeWorkspaceFile(
  root: string,
  path: string,
  content: string | Buffer,
): Promise<number> {
  const target = resolveWorkspacePath(root, path)
  await assertNoSymlinkTraversal(root, target)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
  return Buffer.byteLength(content)
}

export async function createWorkspaceFile(
  root: string,
  path: string,
  content: string | Buffer,
): Promise<number> {
  const target = resolveWorkspacePath(root, path)
  await assertNoSymlinkTraversal(root, target)
  await mkdir(dirname(target), { recursive: true })
  try {
    await writeFile(target, content, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`File already exists: ${path}`)
    throw error
  }
  return Buffer.byteLength(content)
}

export async function writeUniqueWorkspaceFile(
  root: string,
  preferredPath: string,
  content: string | Buffer,
): Promise<{ path: string; bytes: number }> {
  const extension = extname(preferredPath)
  const directory = dirname(preferredPath)
  const stem = basename(preferredPath, extension)
  const bytes = Buffer.byteLength(content)
  for (let index = 1; index <= 10_000; index += 1) {
    const name = index === 1 ? `${stem}${extension}` : `${stem} (${index})${extension}`
    const path = directory === '.' ? name : `${directory.replaceAll('\\', '/')}/${name}`
    const target = resolveWorkspacePath(root, path)
    await assertNoSymlinkTraversal(root, target)
    await mkdir(dirname(target), { recursive: true })
    try {
      await writeFile(target, content, { flag: 'wx' })
      return { path, bytes }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Could not allocate a unique workspace file name')
}

export async function workspaceTree(root: string, maxEntries = 500): Promise<WorkspaceEntry[]> {
  return await workspaceTreeWithPolicy(root, maxEntries, isWorkspaceSnapshotExcludedPath)
}

async function workspaceTreeWithPolicy(
  root: string,
  maxEntries: number,
  excluded: (path: string) => boolean,
): Promise<WorkspaceEntry[]> {
  let count = 0
  async function walk(directory: string): Promise<WorkspaceEntry[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const visible = entries
      .filter((entry) => !excluded(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    const result: WorkspaceEntry[] = []
    for (const entry of visible) {
      if (count >= maxEntries) break
      count += 1
      const absolute = resolve(directory, entry.name)
      const path = relative(root, absolute).split(sep).join('/')
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        result.push({ name: entry.name, path, type: 'directory', children: await walk(absolute) })
      } else if (entry.isFile()) {
        result.push({ name: entry.name, path, type: 'file', size: (await stat(absolute)).size })
      }
    }
    return result
  }

  try {
    return await walk(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function listWorkspaceFiles(
  root: string,
  requestedPath = '',
  signal?: AbortSignal,
): Promise<Array<{ path: string }>> {
  const target = resolveWorkspacePath(root, requestedPath)
  await assertNoSymlinkTraversal(root, target)
  const info = await stat(target)
  if (!info.isDirectory()) throw new Error('list_files path must be a directory')
  const files: Array<{ path: string }> = []
  async function visit(directory: string): Promise<void> {
    signal?.throwIfAborted()
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !isWorkspaceSnapshotExcludedPath(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (entry.isSymbolicLink()) continue
      const absolute = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push({ path: relative(root, absolute).split(sep).join('/') })
    }
  }
  await visit(target)
  return files
}

export interface WorkspaceInventoryFile {
  path: string
}

export interface WorkspaceInventoryEntry {
  name: string
  path: string
  type: 'directory' | 'file'
  size?: number
}

export interface WorkspaceInventoryScan<T> {
  items: T[]
  /** Exact when truncated is false; otherwise a lower bound observed before a support cap. */
  totalEntries: number
  /** Exact when truncated is false; otherwise a lower bound observed before a support cap. */
  totalFiles: number
  truncated: boolean
  fileLimitHit: boolean
  entryLimitHit: boolean
  path: string
}

/**
 * Build the bounded, deterministic source snapshot used by persistent
 * Workspace inventory manifests. Results are ordered by raw UTF-8 path bytes,
 * not by host locale, and never follow symlinks or expose snapshot-excluded
 * runtime/cache paths.
 */
export async function scanWorkspaceInventory(
  root: string,
  requestedPath = '',
  options: {
    mode: 'files' | 'entries'
    fileSupportCap: number
    entrySupportCap: number
    signal?: AbortSignal
  },
): Promise<WorkspaceInventoryScan<WorkspaceInventoryFile | WorkspaceInventoryEntry>> {
  if (!Number.isInteger(options.fileSupportCap) || options.fileSupportCap < 1) {
    throw new Error('Workspace inventory fileSupportCap must be a positive integer')
  }
  if (!Number.isInteger(options.entrySupportCap) || options.entrySupportCap < 1) {
    throw new Error('Workspace inventory entrySupportCap must be a positive integer')
  }
  const target = resolveWorkspacePath(root, requestedPath)
  await assertNoSymlinkTraversal(root, target)
  const info = await stat(target)
  if (!info.isDirectory()) throw new Error('list_files path must be a directory')
  const canonicalPath = relative(root, target).split(sep).join('/')
  const items: Array<WorkspaceInventoryFile | WorkspaceInventoryEntry> = []
  let observedEntries = 0
  let observedFiles = 0
  let fileLimitHit = false
  let entryLimitHit = false

  async function visit(directory: string): Promise<void> {
    options.signal?.throwIfAborted()
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareUtf8(left.name, right.name))
    for (const entry of entries) {
      options.signal?.throwIfAborted()
      if (fileLimitHit || entryLimitHit) return
      const absolute = resolve(directory, entry.name)
      const path = relative(root, absolute).split(sep).join('/')
      if (isWorkspaceSnapshotExcludedPath(path) || entry.isSymbolicLink()) continue
      observedEntries += 1
      if (observedEntries > options.entrySupportCap) {
        entryLimitHit = true
        return
      }
      if (entry.isDirectory()) {
        if (options.mode === 'entries') {
          items.push({ name: entry.name, path, type: 'directory' })
        }
        await visit(absolute)
      } else if (entry.isFile()) {
        observedFiles += 1
        if (observedFiles > options.fileSupportCap) {
          fileLimitHit = true
          return
        }
        if (options.mode === 'files') items.push({ path })
        else items.push({ name: entry.name, path, type: 'file', size: (await stat(absolute)).size })
      }
    }
  }

  await visit(target)
  items.sort((left, right) => compareUtf8(left.path, right.path))
  return {
    items,
    totalEntries: observedEntries,
    totalFiles: observedFiles,
    truncated: fileLimitHit || entryLimitHit,
    fileLimitHit,
    entryLimitHit,
    path: canonicalPath,
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export interface WorkspacePersistenceSnapshot {
  bytes: number
  fileCount: number
  blobCount: number
}

/**
 * Measure every user-visible regular file in the Workspace. Unlike
 * workspaceFileSnapshot this scan is deliberately uncapped: it is used for
 * the authoritative terminal persistence boundary, not change detection.
 *
 * Anera does not currently have a remote content-addressed blob layer. The
 * visible file count remains authoritative, while blobCount truthfully stays
 * zero for this local-durable persistence mode.
 */
export async function workspacePersistenceSnapshot(root: string): Promise<WorkspacePersistenceSnapshot> {
  let bytes = 0
  let fileCount = 0
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (isWorkspaceSnapshotExcludedPath(entry.name)) continue
      const absolute = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) {
        bytes += (await stat(absolute)).size
        fileCount += 1
      }
    }
  }
  try {
    await visit(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { bytes, fileCount, blobCount: 0 }
}

export async function workspaceSize(root: string): Promise<number> {
  return (await workspacePersistenceSnapshot(root)).bytes
}

export interface WorkspaceFileSnapshotEntry {
  size: number
  mtimeMs: number
  sha256: string
}

export interface WorkspaceFileSnapshotOptions {
  /** Optional hard support limit. Exceeding it fails explicitly; files are never silently omitted. */
  maxEntries?: number
  signal?: AbortSignal
}

/**
 * Capture the complete file identity set used by durable Shell reconciliation.
 * The legacy implementation silently stopped after 2,000 files, which could
 * misclassify later files as unchanged or missing. The default is now complete;
 * callers that need a support boundary may set one and receive an explicit
 * failure instead of a partial snapshot.
 */
export async function workspaceFileSnapshot(
  root: string,
  options: number | WorkspaceFileSnapshotOptions = {},
): Promise<Map<string, WorkspaceFileSnapshotEntry>> {
  const maxEntries = typeof options === 'number' ? options : options.maxEntries
  const signal = typeof options === 'number' ? undefined : options.signal
  if (maxEntries !== undefined && (!Number.isInteger(maxEntries) || maxEntries < 1)) {
    throw new Error('Workspace file snapshot limit must be a positive integer')
  }
  const snapshot = new Map<string, WorkspaceFileSnapshotEntry>()
  async function visit(directory: string): Promise<void> {
    signal?.throwIfAborted()
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareUtf8(left.name, right.name))
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (isWorkspaceSnapshotExcludedPath(entry.name)) continue
      const absolute = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) {
        if (maxEntries !== undefined && snapshot.size >= maxEntries) {
          throw new Error(`Workspace file snapshot exceeded ${maxEntries} files`)
        }
        const info = await stat(absolute)
        signal?.throwIfAborted()
        const content = signal
          ? await readFile(absolute, { signal })
          : await readFile(absolute)
        snapshot.set(relative(root, absolute).split(sep).join('/'), {
          size: info.size,
          mtimeMs: info.mtimeMs,
          sha256: createHash('sha256').update(content).digest('hex'),
        })
      }
    }
  }
  try {
    await visit(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return snapshot
}

export interface FindWebsiteEntryOptions {
  signal?: AbortSignal
  maxEntries?: number
}

const DEFAULT_WEBSITE_ENTRY_SCAN_LIMIT = 20_000

export async function findWebsiteEntry(
  root: string,
  options: FindWebsiteEntryOptions = {},
): Promise<string | undefined> {
  const maxEntries = options.maxEntries ?? DEFAULT_WEBSITE_ENTRY_SCAN_LIMIT
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('Website entry scan limit must be a positive integer')
  }
  for (const candidate of ['index.html', 'dashboard.html', 'app/index.html', 'public/index.html']) {
    options.signal?.throwIfAborted()
    try {
      const target = resolveWorkspacePath(root, candidate)
      await assertNoSymlinkTraversal(root, target)
      if ((await stat(target)).isFile()) return candidate
    } catch {
      // Continue through the deterministic candidate list.
    }
  }
  // Entry discovery operates on the live runtime, not the saved Workspace
  // projection. Build output such as dist/index.html must remain startable and
  // restartable even though it is intentionally absent from tree/ZIP saves.
  // Scan incrementally so a large tree does not have to be materialized before
  // the first usable HTML entry can be returned. The explicit budget keeps an
  // untrusted Workspace from turning automatic discovery into an unbounded
  // traversal; callers with a run signal can stop it immediately.
  let examinedEntries = 0
  const visit = async (directory: string): Promise<string | undefined> => {
    options.signal?.throwIfAborted()
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || compareUtf8(left.name, right.name))
    for (const entry of entries) {
      options.signal?.throwIfAborted()
      const absolute = resolve(directory, entry.name)
      const path = relative(root, absolute).split(sep).join('/')
      if (isWorkspaceInternalPath(path) || entry.isSymbolicLink()) continue
      examinedEntries += 1
      if (examinedEntries > maxEntries) {
        throw new Error(`Website entry discovery exceeded ${maxEntries} entries`)
      }
      if (entry.isDirectory()) {
        const nested = await visit(absolute)
        if (nested) return nested
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        return path
      }
    }
    return undefined
  }
  try {
    return await visit(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
