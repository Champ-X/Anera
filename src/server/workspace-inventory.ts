import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import {
  resolveWorkspacePath,
  scanWorkspaceInventory,
  type WorkspaceInventoryEntry,
  type WorkspaceInventoryFile,
} from './workspace.js'

export const WORKSPACE_INVENTORY_DEFAULT_LIMIT = 200
export const WORKSPACE_INVENTORY_MAX_LIMIT = 500
export const WORKSPACE_INVENTORY_SUPPORT_CAP = 10_000
export const WORKSPACE_INVENTORY_ENTRY_SUPPORT_CAP = 20_000
export const WORKSPACE_INVENTORY_MAX_JSON_BYTES = 64 * 1024
export const WORKSPACE_INVENTORY_TTL_MS = 24 * 60 * 60 * 1_000
export const WORKSPACE_INVENTORY_MAX_MANIFESTS = 64

export type WorkspaceInventoryCursorErrorCode =
  | 'invalid_cursor'
  | 'cursor_expired'
  | 'cursor_corrupt'
  | 'cursor_session_mismatch'
  | 'cursor_path_mismatch'

export class WorkspaceInventoryCursorError extends Error {
  constructor(
    public readonly code: WorkspaceInventoryCursorErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceInventoryCursorError'
  }
}

export interface WorkspaceInventoryPageOptions {
  workspaceRoot: string
  manifestDirectory: string
  sessionId: string
  path?: string
  cursor?: string
  limit?: number
  signal?: AbortSignal
  /** Deterministic test seam. */
  nowMs?: number
  /** Initial-manifest policy/test seam. Continuations retain the persisted value. */
  ttlMs?: number
  /** Initial-manifest policy/test seam. Continuations retain the persisted value. */
  maxJsonBytes?: number
  /** Initial-manifest policy/test seam. Continuations retain the persisted value. */
  supportCap?: number
  /** Initial-manifest directory-entry traversal cap; separate from the file cap. */
  entrySupportCap?: number
}

export interface WorkspaceInventoryFilesPage {
  files: WorkspaceInventoryFile[]
  hasMore: boolean
  nextCursor?: string
  /** True when the immutable manifest hit the Workspace support cap. */
  truncated: boolean
  /** Exact unless truncated; when truncated this is at least supportCap + 1. */
  totalFiles: number
}

export interface WorkspaceInventoryEntriesPage {
  entries: WorkspaceInventoryEntry[]
  hasMore: boolean
  nextCursor?: string
  /** True when the immutable manifest hit the Workspace support cap. */
  truncated: boolean
  /** Exact unless truncated; when truncated this is a lower bound. */
  totalEntries: number
  /** Exact unless truncated; when truncated this is a lower bound. */
  totalFiles: number
  fileLimitHit: boolean
  entryLimitHit: boolean
  totalFilesIsLowerBound: boolean
}

type InventoryMode = 'files' | 'entries'
type ManifestItem = WorkspaceInventoryFile | WorkspaceInventoryEntry

interface WorkspaceInventoryManifest {
  version: 1
  id: string
  mode: InventoryMode
  sessionHash: string
  path: string
  createdAtMs: number
  expiresAtMs: number
  limit: number
  maxJsonBytes: number
  supportCap: number
  entrySupportCap: number
  cursorKey: string
  items: ManifestItem[]
  truncated: boolean
  totalEntries: number
  totalFiles: number
  fileLimitHit: boolean
  entryLimitHit: boolean
}

interface WorkspaceInventoryManifestEnvelope {
  manifest: WorkspaceInventoryManifest
  sha256: string
}

interface CursorPayload {
  version: 1
  manifestId: string
  sessionHash: string
  mode: InventoryMode
  offset: number
  limit: number
  expiresAtMs: number
}

const CURSOR_PREFIX = 'wsi1'
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024

export async function listWorkspaceInventoryPage(
  options: WorkspaceInventoryPageOptions,
): Promise<WorkspaceInventoryFilesPage> {
  const page = await workspaceInventoryPage('files', options)
  return page as WorkspaceInventoryFilesPage
}

export async function listWorkspaceEntryInventoryPage(
  options: WorkspaceInventoryPageOptions,
): Promise<WorkspaceInventoryEntriesPage> {
  const page = await workspaceInventoryPage('entries', options)
  return page as WorkspaceInventoryEntriesPage
}

async function workspaceInventoryPage(
  mode: InventoryMode,
  options: WorkspaceInventoryPageOptions,
): Promise<WorkspaceInventoryFilesPage | WorkspaceInventoryEntriesPage> {
  const nowMs = options.nowMs ?? Date.now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Workspace inventory nowMs must be a non-negative safe integer')
  let manifest: WorkspaceInventoryManifest
  let offset = 0

  if (options.cursor !== undefined) {
    const parsed = parseCursor(options.cursor)
    const expectedSessionHash = hashSession(options.sessionId)
    if (parsed.sessionHash !== expectedSessionHash) {
      throw new WorkspaceInventoryCursorError('cursor_session_mismatch', 'Workspace inventory cursor belongs to another session')
    }
    if (parsed.mode !== mode) {
      throw new WorkspaceInventoryCursorError('invalid_cursor', 'Workspace inventory cursor has the wrong inventory mode')
    }
    if (nowMs >= parsed.expiresAtMs) {
      throw new WorkspaceInventoryCursorError('cursor_expired', 'Workspace inventory cursor has expired; restart the listing without a cursor')
    }
    manifest = await readManifest(options.manifestDirectory, parsed.manifestId, parsed.expiresAtMs)
    verifyCursor(options.cursor, parsed, manifest)
    if (manifest.sessionHash !== expectedSessionHash) {
      throw new WorkspaceInventoryCursorError('cursor_session_mismatch', 'Workspace inventory manifest belongs to another session')
    }
    if (manifest.mode !== mode) {
      throw new WorkspaceInventoryCursorError('cursor_corrupt', 'Workspace inventory manifest mode does not match its cursor')
    }
    if (
      options.path !== undefined
      && manifest.path !== canonicalRequestedPath(options.workspaceRoot, options.path)
    ) {
      throw new WorkspaceInventoryCursorError('cursor_path_mismatch', 'Workspace inventory cursor must be continued with the same path')
    }
    if (nowMs >= manifest.expiresAtMs) {
      throw new WorkspaceInventoryCursorError('cursor_expired', 'Workspace inventory cursor has expired; restart the listing without a cursor')
    }
    if (options.limit !== undefined && options.limit !== parsed.limit) {
      throw new WorkspaceInventoryCursorError('invalid_cursor', 'Workspace inventory continuation must retain its original limit')
    }
    if (options.maxJsonBytes !== undefined && options.maxJsonBytes !== manifest.maxJsonBytes) {
      throw new WorkspaceInventoryCursorError('invalid_cursor', 'Workspace inventory continuation has a mismatched JSON budget')
    }
    offset = parsed.offset
  } else {
    const requestedPath = canonicalRequestedPath(options.workspaceRoot, options.path ?? '')
    const limit = boundedInteger(
      options.limit ?? WORKSPACE_INVENTORY_DEFAULT_LIMIT,
      1,
      WORKSPACE_INVENTORY_MAX_LIMIT,
      'Workspace inventory limit',
    )
    const supportCap = boundedInteger(
      options.supportCap ?? WORKSPACE_INVENTORY_SUPPORT_CAP,
      1,
      WORKSPACE_INVENTORY_SUPPORT_CAP,
      'Workspace inventory supportCap',
    )
    const maxJsonBytes = boundedInteger(
      options.maxJsonBytes ?? WORKSPACE_INVENTORY_MAX_JSON_BYTES,
      256,
      WORKSPACE_INVENTORY_MAX_JSON_BYTES,
      'Workspace inventory maxJsonBytes',
    )
    const ttlMs = boundedInteger(
      options.ttlMs ?? WORKSPACE_INVENTORY_TTL_MS,
      1,
      7 * WORKSPACE_INVENTORY_TTL_MS,
      'Workspace inventory ttlMs',
    )
    const entrySupportCap = boundedInteger(
      options.entrySupportCap ?? WORKSPACE_INVENTORY_ENTRY_SUPPORT_CAP,
      1,
      WORKSPACE_INVENTORY_ENTRY_SUPPORT_CAP,
      'Workspace inventory entrySupportCap',
    )
    const expiresAtMs = nowMs + ttlMs
    if (!Number.isSafeInteger(expiresAtMs)) throw new Error('Workspace inventory expiration exceeds the safe timestamp range')
    const scan = await scanWorkspaceInventory(options.workspaceRoot, requestedPath, {
      mode,
      fileSupportCap: supportCap,
      entrySupportCap,
      signal: options.signal,
    })
    manifest = {
      version: 1,
      id: randomBytes(16).toString('hex'),
      mode,
      sessionHash: hashSession(options.sessionId),
      path: scan.path,
      createdAtMs: nowMs,
      expiresAtMs,
      limit,
      maxJsonBytes,
      supportCap,
      entrySupportCap,
      cursorKey: randomBytes(32).toString('base64url'),
      items: scan.items,
      truncated: scan.truncated,
      totalEntries: scan.totalEntries,
      totalFiles: scan.totalFiles,
      fileLimitHit: scan.fileLimitHit,
      entryLimitHit: scan.entryLimitHit,
    }
    await cleanupManifestDirectory(options.manifestDirectory, nowMs)
    await persistManifest(options.manifestDirectory, manifest)
  }

  if (offset < 0 || offset > manifest.items.length || (offset === manifest.items.length && offset !== 0)) {
    throw new WorkspaceInventoryCursorError('invalid_cursor', 'Workspace inventory cursor does not identify a continuation page')
  }
  return buildBoundedPage(manifest, offset)
}

function buildBoundedPage(
  manifest: WorkspaceInventoryManifest,
  offset: number,
): WorkspaceInventoryFilesPage | WorkspaceInventoryEntriesPage {
  const remaining = manifest.items.length - offset
  const maximumCount = Math.min(manifest.limit, remaining)
  let low = remaining === 0 ? 0 : 1
  let high = maximumCount
  let accepted: WorkspaceInventoryFilesPage | WorkspaceInventoryEntriesPage | undefined
  while (low <= high) {
    const count = Math.floor((low + high) / 2)
    const candidate = pageCandidate(manifest, offset, count)
    if (Buffer.byteLength(JSON.stringify(candidate)) <= manifest.maxJsonBytes) {
      accepted = candidate
      low = count + 1
    } else {
      high = count - 1
    }
  }
  if (!accepted && remaining === 0) {
    const candidate = pageCandidate(manifest, offset, 0)
    if (Buffer.byteLength(JSON.stringify(candidate)) <= manifest.maxJsonBytes) accepted = candidate
  }
  if (!accepted) {
    throw new Error(`Workspace inventory JSON budget cannot fit one entry at offset ${offset}`)
  }
  return accepted
}

function pageCandidate(
  manifest: WorkspaceInventoryManifest,
  offset: number,
  count: number,
): WorkspaceInventoryFilesPage | WorkspaceInventoryEntriesPage {
  const end = offset + count
  const hasMore = end < manifest.items.length
  const nextCursor = hasMore ? createCursor(manifest, end) : undefined
  if (manifest.mode === 'files') {
    return {
      files: manifest.items.slice(offset, end) as WorkspaceInventoryFile[],
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
      truncated: manifest.truncated,
      totalFiles: manifest.totalFiles,
    }
  }
  return {
    entries: manifest.items.slice(offset, end) as WorkspaceInventoryEntry[],
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    truncated: manifest.truncated,
    totalEntries: manifest.totalEntries,
    totalFiles: manifest.totalFiles,
    fileLimitHit: manifest.fileLimitHit,
    entryLimitHit: manifest.entryLimitHit,
    totalFilesIsLowerBound: manifest.fileLimitHit || manifest.entryLimitHit,
  }
}

async function cleanupManifestDirectory(directory: string, nowMs: number): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const candidates: Array<{ path: string; expiresAtMs: number; mtimeMs: number }> = []
  for (const name of await readdir(directory)) {
    const match = /^([a-f0-9]{32})-(\d+)\.json$/.exec(name)
    if (!match) continue
    const path = resolve(directory, name)
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      candidates.push({ path, expiresAtMs: Number(match[2]), mtimeMs: info.mtimeMs })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const live: typeof candidates = []
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate.expiresAtMs) || candidate.expiresAtMs <= nowMs) {
      await unlink(candidate.path).catch(ignoreMissingFile)
    } else {
      live.push(candidate)
    }
  }
  live.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path))
  for (const candidate of live.slice(Math.max(0, WORKSPACE_INVENTORY_MAX_MANIFESTS - 1))) {
    await unlink(candidate.path).catch(ignoreMissingFile)
  }
}

function ignoreMissingFile(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ENOENT') throw error
}

function manifestPath(directory: string, id: string, expiresAtMs: number): string {
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 1) throw invalidCursor()
  return resolve(directory, `${id}-${expiresAtMs}.json`)
}

async function persistManifest(directory: string, manifest: WorkspaceInventoryManifest): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const serializedManifest = JSON.stringify(manifest)
  const envelope: WorkspaceInventoryManifestEnvelope = {
    manifest,
    sha256: createHash('sha256').update(serializedManifest).digest('hex'),
  }
  await writeFile(manifestPath(directory, manifest.id, manifest.expiresAtMs), JSON.stringify(envelope), {
    flag: 'wx',
    mode: 0o600,
  })
}

async function readManifest(directory: string, id: string, expiresAtMs: number): Promise<WorkspaceInventoryManifest> {
  if (!/^[a-f0-9]{32}$/.test(id)) {
    throw new WorkspaceInventoryCursorError('invalid_cursor', 'Workspace inventory cursor contains an invalid manifest id')
  }
  const path = manifestPath(directory, id, expiresAtMs)
  let serialized: string
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
      throw new WorkspaceInventoryCursorError('cursor_corrupt', 'Workspace inventory manifest is invalid')
    }
    serialized = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof WorkspaceInventoryCursorError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspaceInventoryCursorError('invalid_cursor', 'Workspace inventory cursor is unknown or no longer available')
    }
    throw error
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(serialized)
  } catch {
    throw new WorkspaceInventoryCursorError('cursor_corrupt', 'Workspace inventory manifest is not valid JSON')
  }
  const record = objectRecord(envelope, 'Workspace inventory manifest envelope')
  exactRecordKeys(record, ['manifest', 'sha256'], 'Workspace inventory manifest envelope')
  const manifestRecord = objectRecord(record.manifest, 'Workspace inventory manifest')
  const expectedDigest = createHash('sha256').update(JSON.stringify(record.manifest)).digest('hex')
  if (typeof record.sha256 !== 'string' || !constantTimeEqual(record.sha256, expectedDigest)) {
    throw new WorkspaceInventoryCursorError('cursor_corrupt', 'Workspace inventory manifest checksum does not match')
  }
  validateManifest(manifestRecord, id)
  return manifestRecord as unknown as WorkspaceInventoryManifest
}

function validateManifest(record: Record<string, unknown>, expectedId: string): void {
  exactRecordKeys(record, [
    'version', 'id', 'mode', 'sessionHash', 'path', 'createdAtMs', 'expiresAtMs', 'limit',
    'maxJsonBytes', 'supportCap', 'entrySupportCap', 'cursorKey', 'items', 'truncated',
    'totalEntries', 'totalFiles', 'fileLimitHit', 'entryLimitHit',
  ], 'Workspace inventory manifest')
  if (record.version !== 1 || record.id !== expectedId) throw corruptManifest('identity')
  if (record.mode !== 'files' && record.mode !== 'entries') throw corruptManifest('mode')
  if (typeof record.sessionHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.sessionHash)) throw corruptManifest('session hash')
  if (typeof record.path !== 'string') throw corruptManifest('path')
  for (const field of [
    'createdAtMs', 'expiresAtMs', 'limit', 'maxJsonBytes', 'supportCap', 'entrySupportCap',
    'totalEntries', 'totalFiles',
  ] as const) {
    if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0) throw corruptManifest(field)
  }
  if (Number(record.expiresAtMs) <= Number(record.createdAtMs)) throw corruptManifest('expiration')
  if (Number(record.limit) < 1 || Number(record.limit) > WORKSPACE_INVENTORY_MAX_LIMIT) throw corruptManifest('limit')
  if (Number(record.maxJsonBytes) < 256 || Number(record.maxJsonBytes) > WORKSPACE_INVENTORY_MAX_JSON_BYTES) throw corruptManifest('maxJsonBytes')
  if (Number(record.supportCap) < 1 || Number(record.supportCap) > WORKSPACE_INVENTORY_SUPPORT_CAP) throw corruptManifest('supportCap')
  if (Number(record.entrySupportCap) < 1 || Number(record.entrySupportCap) > WORKSPACE_INVENTORY_ENTRY_SUPPORT_CAP) throw corruptManifest('entrySupportCap')
  if (typeof record.cursorKey !== 'string' || !/^[A-Za-z0-9_-]{40,}$/.test(record.cursorKey)) throw corruptManifest('cursor key')
  if (
    typeof record.truncated !== 'boolean'
    || typeof record.fileLimitHit !== 'boolean'
    || typeof record.entryLimitHit !== 'boolean'
    || !Array.isArray(record.items)
  ) throw corruptManifest('items')
  const itemCap = record.mode === 'files' ? Number(record.supportCap) : Number(record.entrySupportCap)
  if (record.items.length > itemCap) throw corruptManifest('item count')
  if (Number(record.totalEntries) < record.items.length || Number(record.totalEntries) > Number(record.entrySupportCap) + 1) {
    throw corruptManifest('totalEntries')
  }
  if (Number(record.totalFiles) > Number(record.supportCap) + 1) throw corruptManifest('totalFiles')
  if (record.truncated !== (record.fileLimitHit || record.entryLimitHit)) throw corruptManifest('truncation flags')
  if (record.fileLimitHit && Number(record.totalFiles) !== Number(record.supportCap) + 1) throw corruptManifest('file limit total')
  if (record.entryLimitHit && Number(record.totalEntries) !== Number(record.entrySupportCap) + 1) throw corruptManifest('entry limit total')
  if (!record.truncated && record.mode === 'entries' && Number(record.totalEntries) !== record.items.length) {
    throw corruptManifest('complete totalEntries')
  }
  record.items.forEach((item, index) => validateManifestItem(item, record.mode as InventoryMode, index))
  const manifestedFileCount = record.items.filter((item) => (
    record.mode === 'files' || (item as Record<string, unknown>).type === 'file'
  )).length
  if (!record.truncated && manifestedFileCount !== Number(record.totalFiles)) throw corruptManifest('complete file total')
}

function validateManifestItem(value: unknown, mode: InventoryMode, index: number): void {
  const item = objectRecord(value, `Workspace inventory item ${index}`)
  if (mode === 'files') {
    exactRecordKeys(item, ['path'], `Workspace inventory item ${index}`)
  } else if (item.type === 'directory') {
    exactRecordKeys(item, ['name', 'path', 'type'], `Workspace inventory item ${index}`)
  } else {
    exactRecordKeys(item, ['name', 'path', 'type', 'size'], `Workspace inventory item ${index}`)
    if (item.type !== 'file' || !Number.isInteger(item.size) || Number(item.size) < 0) throw corruptManifest(`item ${index} size`)
  }
  if (typeof item.path !== 'string' || !item.path) throw corruptManifest(`item ${index} path`)
  if (mode === 'entries' && (typeof item.name !== 'string' || !item.name)) throw corruptManifest(`item ${index} name`)
}

function createCursor(manifest: WorkspaceInventoryManifest, offset: number): string {
  const payload: CursorPayload = {
    version: 1,
    manifestId: manifest.id,
    sessionHash: manifest.sessionHash,
    mode: manifest.mode,
    offset,
    limit: manifest.limit,
    expiresAtMs: manifest.expiresAtMs,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', Buffer.from(manifest.cursorKey, 'base64url'))
    .update(encoded)
    .digest('base64url')
  return `${CURSOR_PREFIX}.${encoded}.${signature}`
}

function parseCursor(cursor: string): CursorPayload {
  if (typeof cursor !== 'string' || cursor.length > 1_024) throw invalidCursor()
  const parts = cursor.split('.')
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) throw invalidCursor()
  let decoded: Buffer
  try {
    decoded = Buffer.from(parts[1], 'base64url')
  } catch {
    throw invalidCursor()
  }
  if (decoded.toString('base64url') !== parts[1]) throw invalidCursor()
  let raw: unknown
  try {
    raw = JSON.parse(decoded.toString('utf8'))
  } catch {
    throw invalidCursor()
  }
  let record: Record<string, unknown>
  try {
    record = objectRecord(raw, 'Workspace inventory cursor')
    exactRecordKeys(record, [
      'version', 'manifestId', 'sessionHash', 'mode', 'offset', 'limit', 'expiresAtMs',
    ], 'Workspace inventory cursor')
  } catch {
    throw invalidCursor()
  }
  if (
    record.version !== 1
    || typeof record.manifestId !== 'string'
    || typeof record.sessionHash !== 'string'
    || (record.mode !== 'files' && record.mode !== 'entries')
    || !Number.isInteger(record.offset)
    || Number(record.offset) < 1
    || !Number.isInteger(record.limit)
    || Number(record.limit) < 1
    || Number(record.limit) > WORKSPACE_INVENTORY_MAX_LIMIT
    || !Number.isSafeInteger(record.expiresAtMs)
    || Number(record.expiresAtMs) < 1
  ) throw invalidCursor()
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw invalidCursor()
  return record as unknown as CursorPayload
}

function verifyCursor(cursor: string, payload: CursorPayload, manifest: WorkspaceInventoryManifest): void {
  const encoded = cursor.split('.')[1]
  const actual = cursor.split('.')[2]
  const expected = createHmac('sha256', Buffer.from(manifest.cursorKey, 'base64url'))
    .update(encoded)
    .digest('base64url')
  if (!constantTimeEqual(actual, expected)) throw invalidCursor()
  if (
    payload.manifestId !== manifest.id
    || payload.sessionHash !== manifest.sessionHash
    || payload.mode !== manifest.mode
    || payload.limit !== manifest.limit
    || payload.expiresAtMs !== manifest.expiresAtMs
    || payload.offset >= manifest.items.length
  ) throw invalidCursor()
}

function canonicalRequestedPath(root: string, requestedPath: string): string {
  const target = resolveWorkspacePath(root, requestedPath)
  return relative(root, target).split(sep).join('/')
}

function hashSession(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corruptManifest(name)
  return value as Record<string, unknown>
}

function exactRecordKeys(record: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((value, index) => value !== wanted[index])) {
    throw corruptManifest(`${name} fields`)
  }
}

function corruptManifest(field: string): WorkspaceInventoryCursorError {
  return new WorkspaceInventoryCursorError('cursor_corrupt', `Workspace inventory manifest has an invalid ${field}`)
}

function invalidCursor(): WorkspaceInventoryCursorError {
  return new WorkspaceInventoryCursorError('invalid_cursor', 'Workspace inventory cursor is invalid')
}
