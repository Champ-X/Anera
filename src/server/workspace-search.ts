import { createReadStream } from 'node:fs'
import { lstat, open, readdir, stat } from 'node:fs/promises'
import { matchesGlob, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import {
  assertNoSymlinkTraversal,
  isWorkspaceSnapshotExcludedPath,
  resolveWorkspacePath,
} from './workspace.js'

export const MAX_PATTERN_LENGTH = 200
export const GREP_MAX_MATCHES = 100
export const GREP_MAX_FILES = 100
export const GREP_MAX_JSON_LINES = 5_000
export const MAX_LINE_LENGTH = 2_000
export const GLOB_MAX_FILES = 100
export const TOOL_RESULT_MAX_BYTES = 40_000

const BINARY_SAMPLE_BYTES = 8_192
const MAX_CONTEXT_LINES = 50

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count'

export interface GrepFilesArgs {
  pattern: string
  path?: string
  glob?: string
  output_mode?: GrepOutputMode
  '-i'?: boolean
  '-B'?: number
  '-A'?: number
  '-C'?: number
  context?: number
}

export interface GrepMatch {
  path: string
  lineNumber: number
  lineContent: string
  contextBefore?: string[]
  contextAfter?: string[]
}

export type GrepFilesResult =
  | { status: 'success'; mode: 'content'; matches: GrepMatch[]; truncated: boolean }
  | { status: 'success'; mode: 'files_with_matches'; files: string[]; truncated: boolean }
  | { status: 'success'; mode: 'count'; counts: Array<{ path: string; count: number }>; totalMatches: number; truncated: boolean }

export interface GlobFilesArgs {
  pattern: string
  path?: string
}

export interface GlobFilesResult {
  status: 'success'
  paths: string[]
  truncated: boolean
}

interface WorkspaceSearchFile {
  absolutePath: string
  path: string
  pathFromSearchRoot: string
  size: number
}

interface LinePreview {
  text: string
  truncated: boolean
}

export async function grepWorkspace(
  root: string,
  args: GrepFilesArgs,
  signal: AbortSignal,
): Promise<GrepFilesResult> {
  validatePattern(args.pattern)
  if (args.glob !== undefined) validateGlob(args.glob, 'glob')
  const mode = args.output_mode ?? 'content'
  const flags = args['-i'] ? 'iu' : 'u'
  let expression: RegExp
  try {
    expression = new RegExp(args.pattern, flags)
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }

  const genericContext = boundedContext(args.context ?? args['-C'] ?? 0)
  const beforeCount = boundedContext(args['-B'] ?? genericContext)
  const afterCount = boundedContext(args['-A'] ?? genericContext)
  const files = await collectWorkspaceFiles(root, args.path, signal)
  let truncated = false

  if (mode === 'files_with_matches') {
    const matchedFiles: string[] = []
    for (const file of files) {
      signal.throwIfAborted()
      if (!matchesFileFilter(file, args.glob) || await isProbablyBinary(file.absolutePath, file.size, signal)) continue
      const found = await fileHasMatch(file.absolutePath, expression, signal)
      if (!found) continue
      if (matchedFiles.length >= GREP_MAX_FILES) {
        truncated = true
        break
      }
      matchedFiles.push(file.path)
    }
    return fitGrepResultBytes({ status: 'success', mode, files: matchedFiles, truncated })
  }

  if (mode === 'count') {
    const counts: Array<{ path: string; count: number }> = []
    let totalMatches = 0
    let shouldStop = false
    for (const file of files) {
      signal.throwIfAborted()
      if (!matchesFileFilter(file, args.glob) || await isProbablyBinary(file.absolutePath, file.size, signal)) continue
      let count = 0
      await forEachLine(file.absolutePath, signal, (_line, _lineNumber, matches) => {
        if (!matches) return true
        if (totalMatches >= GREP_MAX_JSON_LINES) {
          truncated = true
          shouldStop = true
          return false
        }
        count += 1
        totalMatches += 1
        return true
      }, expression)
      if (count > 0) {
        if (counts.length >= GREP_MAX_FILES) {
          truncated = true
          break
        }
        counts.push({ path: file.path, count })
      }
      if (shouldStop) break
    }
    return fitGrepResultBytes({ status: 'success', mode, counts, totalMatches, truncated })
  }

  const matches: GrepMatch[] = []
  const matchedFiles = new Set<string>()
  let stopSearch = false
  for (const file of files) {
    signal.throwIfAborted()
    if (!matchesFileFilter(file, args.glob) || await isProbablyBinary(file.absolutePath, file.size, signal)) continue
    const before: LinePreview[] = []
    const pendingAfter: Array<{ match: GrepMatch; remaining: number }> = []
    await forEachLine(file.absolutePath, signal, (line, lineNumber, lineMatches) => {
      const preview = previewLine(line)
      for (let index = pendingAfter.length - 1; index >= 0; index -= 1) {
        const pending = pendingAfter[index]
        if (pending.remaining > 0) {
          pending.match.contextAfter ??= []
          pending.match.contextAfter.push(preview.text)
          if (preview.truncated) truncated = true
          pending.remaining -= 1
        }
        if (pending.remaining === 0) pendingAfter.splice(index, 1)
      }

      if (lineMatches) {
        if (preview.truncated || before.slice(-beforeCount).some((item) => item.truncated)) truncated = true
        const isNewFile = !matchedFiles.has(file.path)
        if (matches.length >= GREP_MAX_MATCHES || (isNewFile && matchedFiles.size >= GREP_MAX_FILES)) {
          truncated = true
          stopSearch = true
          return false
        }
        const match: GrepMatch = {
          path: file.path,
          lineNumber,
          lineContent: preview.text,
          ...(beforeCount > 0 && before.length > 0 ? { contextBefore: before.slice(-beforeCount).map((item) => item.text) } : {}),
        }
        matches.push(match)
        matchedFiles.add(file.path)
        if (afterCount > 0) pendingAfter.push({ match, remaining: afterCount })
      }

      if (beforeCount > 0) {
        before.push(preview)
        if (before.length > beforeCount) before.shift()
      }
      return true
    }, expression)
    if (stopSearch) break
  }
  return fitGrepResultBytes({ status: 'success', mode, matches, truncated })
}

export async function globWorkspace(
  root: string,
  args: GlobFilesArgs,
  signal: AbortSignal,
): Promise<GlobFilesResult> {
  validatePattern(args.pattern)
  validateGlob(args.pattern, 'pattern')
  const files = await collectWorkspaceFiles(root, args.path, signal, true)
  const paths: string[] = []
  let truncated = false
  for (const file of files) {
    signal.throwIfAborted()
    if (!matchesSearchGlob(file.pathFromSearchRoot, args.pattern)) continue
    if (paths.length >= GLOB_MAX_FILES) {
      truncated = true
      break
    }
    paths.push(file.path)
  }
  return fitGlobResultBytes({ status: 'success', paths, truncated })
}

async function collectWorkspaceFiles(
  root: string,
  requestedPath: string | undefined,
  signal: AbortSignal,
  requireDirectory = false,
): Promise<WorkspaceSearchFile[]> {
  const target = resolveWorkspacePath(root, requestedPath ?? '.')
  await assertNoSymlinkTraversal(root, target)
  const targetInfo = await lstat(target)
  if (targetInfo.isSymbolicLink()) throw new Error('Symlink traversal is not allowed')
  if (requireDirectory && !targetInfo.isDirectory()) throw new Error('glob_files path must be a directory')
  const searchRoot = targetInfo.isDirectory() ? target : resolve(target, '..')
  const result: WorkspaceSearchFile[] = []

  const addFile = async (absolutePath: string): Promise<void> => {
    const info = await stat(absolutePath)
    result.push({
      absolutePath,
      path: toPosix(relative(root, absolutePath)),
      pathFromSearchRoot: toPosix(relative(searchRoot, absolutePath)),
      size: info.size,
    })
  }

  const walk = async (directory: string): Promise<void> => {
    signal.throwIfAborted()
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !isWorkspaceSnapshotExcludedPath(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      signal.throwIfAborted()
      if (entry.isSymbolicLink()) continue
      const absolutePath = resolve(directory, entry.name)
      if (entry.isDirectory()) await walk(absolutePath)
      else if (entry.isFile()) await addFile(absolutePath)
    }
  }

  if (targetInfo.isFile()) await addFile(target)
  else if (targetInfo.isDirectory()) await walk(target)
  else throw new Error('Search path is neither a file nor a directory')
  return result
}

async function fileHasMatch(absolutePath: string, expression: RegExp, signal: AbortSignal): Promise<boolean> {
  let found = false
  await forEachLine(absolutePath, signal, (_line, _lineNumber, matches) => {
    found = matches
    return !matches
  }, expression)
  return found
}

async function forEachLine(
  absolutePath: string,
  signal: AbortSignal,
  visit: (line: string, lineNumber: number, matches: boolean) => boolean,
  expression: RegExp,
): Promise<void> {
  const input = createReadStream(absolutePath, { encoding: 'utf8', signal })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0
  try {
    for await (const line of lines) {
      lineNumber += 1
      expression.lastIndex = 0
      if (!visit(line, lineNumber, expression.test(line))) break
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

async function isProbablyBinary(absolutePath: string, size: number, signal: AbortSignal): Promise<boolean> {
  if (size === 0) return false
  signal.throwIfAborted()
  const file = await open(absolutePath, 'r')
  try {
    const sample = Buffer.alloc(Math.min(size, BINARY_SAMPLE_BYTES))
    const { bytesRead } = await file.read(sample, 0, sample.length, 0)
    let controls = 0
    for (const byte of sample.subarray(0, bytesRead)) {
      if (byte === 0) return true
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) controls += 1
    }
    return bytesRead > 0 && controls / bytesRead > 0.1
  } finally {
    await file.close()
  }
}

function matchesFileFilter(file: WorkspaceSearchFile, glob: string | undefined): boolean {
  return glob === undefined || matchesSearchGlob(file.pathFromSearchRoot, glob)
}

function matchesSearchGlob(path: string, pattern: string): boolean {
  try {
    if (matchesGlob(path, pattern)) return true
    return !pattern.includes('/') && matchesGlob(path.split('/').at(-1) || path, pattern)
  } catch (error) {
    throw new Error(`Invalid glob pattern: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function validatePattern(pattern: string): void {
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`pattern must be at most ${MAX_PATTERN_LENGTH} characters`)
}

function validateGlob(pattern: string, name: string): void {
  if (!pattern.trim()) throw new Error(`${name} must be a non-empty glob`)
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`${name} must be at most ${MAX_PATTERN_LENGTH} characters`)
  try {
    matchesGlob('validation-path.txt', pattern)
  } catch (error) {
    throw new Error(`Invalid glob ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function boundedContext(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error('grep context values must be non-negative integers')
  if (value > MAX_CONTEXT_LINES) throw new Error(`grep context values must be at most ${MAX_CONTEXT_LINES}`)
  return value
}

function previewLine(line: string): LinePreview {
  const characters = Array.from(line)
  if (characters.length <= MAX_LINE_LENGTH) return { text: line, truncated: false }
  return { text: `${characters.slice(0, MAX_LINE_LENGTH - 1).join('')}…`, truncated: true }
}

function fitGrepResultBytes(result: GrepFilesResult): GrepFilesResult {
  if (Buffer.byteLength(JSON.stringify(result)) <= TOOL_RESULT_MAX_BYTES) return result
  result.truncated = true
  if (result.mode === 'content') {
    while (Buffer.byteLength(JSON.stringify(result)) > TOOL_RESULT_MAX_BYTES) {
      let reduced = false
      for (let index = result.matches.length - 1; index >= 0; index -= 1) {
        const match = result.matches[index]
        if (match.contextAfter?.length) {
          match.contextAfter.pop()
          if (match.contextAfter.length === 0) delete match.contextAfter
          reduced = true
          break
        }
        if (match.contextBefore?.length) {
          match.contextBefore.shift()
          if (match.contextBefore.length === 0) delete match.contextBefore
          reduced = true
          break
        }
      }
      if (reduced) continue
      if (result.matches.length > 1) {
        result.matches.pop()
        continue
      }
      break
    }
  } else if (result.mode === 'files_with_matches') {
    while (result.files.length > 0 && Buffer.byteLength(JSON.stringify(result)) > TOOL_RESULT_MAX_BYTES) result.files.pop()
  } else {
    while (result.counts.length > 0 && Buffer.byteLength(JSON.stringify(result)) > TOOL_RESULT_MAX_BYTES) result.counts.pop()
  }
  return result
}

function fitGlobResultBytes(result: GlobFilesResult): GlobFilesResult {
  if (Buffer.byteLength(JSON.stringify(result)) <= TOOL_RESULT_MAX_BYTES) return result
  result.truncated = true
  while (result.paths.length > 0 && Buffer.byteLength(JSON.stringify(result)) > TOOL_RESULT_MAX_BYTES) result.paths.pop()
  return result
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
