import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { endianness } from 'node:os'
import { resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import type { ProcessPortRecord, ProcessRecord } from '../shared/types.js'
import { createId } from './ids.js'
import { commandEnvironment, validateCommand } from './command-policy.js'
import { createShellInvocation } from './os-sandbox.js'

interface ManagedProcess {
  record: ProcessRecord
  child: ChildProcessByStdio<Writable, Readable, Readable>
  portHint?: number
  reportedPort?: number
  decoders: Record<'stdout' | 'stderr', StringDecoder>
  context: ProcessEventContext
  eventQueue: Promise<void>
  publishEvents: boolean
}

export interface ProcessEventContext {
  turnId?: string
  stepId?: string
  callId?: string
}

export type ProcessEvent =
  | { type: 'started'; record: ProcessRecord }
  | { type: 'output'; record: ProcessRecord; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'updated'; record: ProcessRecord }
  | { type: 'stopped'; record: ProcessRecord }

export interface ProcessGroupPortProbe {
  ports: ProcessPortRecord[]
  ownershipVerified: boolean
}

export type ManagedProcessPortProbe = (
  process: Pick<ProcessRecord, 'id' | 'pid'>,
) => Promise<ProcessGroupPortProbe>

export interface ProcessManagerOptions {
  /** Trusted test seam; production callers must use the default ownership probe. */
  portProbe?: ManagedProcessPortProbe
  /** Trusted test seam for deterministic Linux procfs fixtures. */
  platform?: NodeJS.Platform
  /** Trusted test seam for deterministic Linux procfs fixtures. */
  procRoot?: string
}

export class ProcessManager {
  private readonly sessions = new Map<string, Map<string, ManagedProcess>>()
  private readonly portProbe: ManagedProcessPortProbe

  constructor(
    private readonly onEvent: (sessionId: string, event: ProcessEvent, context: ProcessEventContext) => void | Promise<void>,
    private readonly maxOutputBytes: number,
    options: ProcessManagerOptions = {},
  ) {
    this.portProbe = options.portProbe ?? ((record) => probeListeningPortsForManagedProcess(
      record,
      options.platform ?? process.platform,
      options.procRoot ?? '/proc',
    ))
  }

  async start(
    sessionId: string,
    workspace: string,
    command: string,
    portHint?: number,
    context: ProcessEventContext = {},
    name?: string,
  ): Promise<ProcessRecord> {
    validateCommand(command)
    const invocation = createShellInvocation(command, workspace, 'server')
    const id = createId('proc')
    const durablePortHint = portHint ?? detectCommandPort(command)
    const child = spawn(process.execPath, [managedProcessGuardianPath(), `--managed-id=${id}`], {
      cwd: workspace,
      env: guardianEnvironment({
        executable: invocation.executable,
        args: invocation.args,
        cwd: workspace,
        env: commandEnvironment(workspace),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const record: ProcessRecord = {
      id,
      ...(name?.trim() ? { name: name.trim() } : {}),
      command,
      pid: child.pid,
      // `port` is reserved for an ownership-verified listener. Command and
      // caller hints remain restart/ranking hints until the OS probe proves
      // that this guardian owns the socket.
      port: undefined,
      portHint: durablePortHint,
      status: 'running',
      startedAt: new Date().toISOString(),
      stdout: '',
      stderr: '',
      combinedOutput: '',
      listeningPorts: [],
      newPorts: [],
    }
    const managed: ManagedProcess = {
      record,
      child,
      portHint: durablePortHint,
      reportedPort: undefined,
      decoders: {
        stdout: new StringDecoder('utf8'),
        stderr: new StringDecoder('utf8'),
      },
      context,
      eventQueue: Promise.resolve(),
      publishEvents: true,
    }
    const processes = this.sessions.get(sessionId) ?? new Map<string, ManagedProcess>()
    processes.set(record.id, managed)
    this.sessions.set(sessionId, processes)

    const captureText = (stream: 'stdout' | 'stderr', chunk: string) => {
      if (!chunk) return
      record[stream] = appendUtf8Tail(record[stream], chunk, this.maxOutputBytes)
      record.combinedOutput = appendUtf8Tail(record.combinedOutput ?? '', chunk, this.maxOutputBytes)
      managed.reportedPort = detectServerPort(`${record.stdout}\n${record.stderr}`) ?? managed.reportedPort
      void this.publish(managed, sessionId, { type: 'output', record: { ...record }, stream, chunk })
    }
    child.stdout.on('data', (chunk: Buffer) => captureText('stdout', managed.decoders.stdout.write(chunk)))
    child.stderr.on('data', (chunk: Buffer) => captureText('stderr', managed.decoders.stderr.write(chunk)))
    child.stdout.on('end', () => captureText('stdout', managed.decoders.stdout.end()))
    child.stderr.on('end', () => captureText('stderr', managed.decoders.stderr.end()))
    child.on('error', (error) => {
      record.status = 'failed'
      record.stderr = `${record.stderr}\n${error.message}`.trim()
    })
    child.on('close', (code, signal) => {
      record.status = record.status === 'stopped' ? 'stopped' : code === 0 ? 'exited' : 'failed'
      record.completedAt = new Date().toISOString()
      record.exitCode = code
      record.signal = signal
      void this.publish(managed, sessionId, { type: 'stopped', record: { ...record } })
    })

    try {
      await waitForSpawn(child)
      record.pid = child.pid
      await this.publish(managed, sessionId, { type: 'started', record: { ...record } })
      return { ...record }
    } catch (error) {
      managed.publishEvents = false
      processes.delete(record.id)
      if (processes.size === 0) this.sessions.delete(sessionId)
      killProcessTree(child, 'SIGTERM')
      await waitForClose(child, 1_500)
      throw error
    }
  }

  private publish(managed: ManagedProcess, sessionId: string, event: ProcessEvent): Promise<void> {
    if (!managed.publishEvents) return Promise.resolve()
    const pending = managed.eventQueue.then(async () => {
      await this.onEvent(sessionId, event, managed.context)
    })
    managed.eventQueue = pending
    // Event listeners cannot await. Attach a rejection observer while keeping
    // the queue rejected so start/stop can still surface persistence failure.
    void pending.catch(() => undefined)
    return pending
  }

  list(sessionId: string): ProcessRecord[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])].map(({ record }) => ({ ...record }))
  }

  get(sessionId: string, processId: string): ProcessRecord | undefined {
    const record = this.sessions.get(sessionId)?.get(processId)?.record
    return record ? { ...record } : undefined
  }

  async refreshPorts(sessionId: string, processId: string): Promise<ProcessRecord | undefined> {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    const target = session.get(processId)
    if (!target) return undefined
    const inspected = await Promise.all([...session.values()].map(async (managed) => ({
      managed,
      probe: await this.collectManagedListeningPorts(managed),
    })))
    const durableUpdates: Promise<void>[] = []
    const changedRecords: ManagedProcess[] = []
    for (const { managed, probe } of inspected) {
      const previousPort = managed.record.port
      const previousListeningPorts = managed.record.listeningPorts ?? []
      const previousNewPorts = managed.record.newPorts ?? []
      const listeningPorts = probe.ownershipVerified ? probe.ports : []
      managed.record.listeningPorts = listeningPorts
      // A managed guardian owns a fresh process group, so every listener in
      // that group was created by this managed process. Never use another
      // guardian's listeners as this record's startup delta.
      managed.record.newPorts = listeningPorts
      const preferred = listeningPorts.find((port) => port.port === managed.record.portHint)
        ?? listeningPorts.find((port) => port.port === managed.reportedPort)
        ?? listeningPorts.find((port) => port.port === managed.record.port)
        ?? listeningPorts[0]
      // Clear a previously verified port when the current ownership snapshot
      // is empty or unknown. A stale port can be rebound by another session or
      // a host process and must never remain previewable.
      managed.record.port = preferred?.port
      if (
        previousPort !== managed.record.port
        || !samePortRecordSets(previousListeningPorts, listeningPorts)
        || !samePortRecordSets(previousNewPorts, listeningPorts)
      ) {
        changedRecords.push(managed)
        // Port ownership is durable process state, not process output. Publish
        // a dedicated snapshot and wait for it before returning the verified
        // record to Website/start callers.
        durableUpdates.push(this.publish(managed, sessionId, {
          type: 'updated',
          record: {
            ...managed.record,
            listeningPorts: [...listeningPorts],
            newPorts: [...listeningPorts],
          },
        }))
      }
    }
    try {
      await Promise.all(durableUpdates)
    } catch (error) {
      // A verified listener is not publishable until its ownership snapshot
      // is durable. Clear every changed in-memory snapshot on persistence
      // failure so a later preview call cannot bypass the failed boundary.
      for (const managed of changedRecords) {
        managed.record.port = undefined
        managed.record.listeningPorts = []
        managed.record.newPorts = []
      }
      throw error
    }
    return { ...target.record }
  }

  private async collectManagedListeningPorts(managed: ManagedProcess): Promise<ProcessGroupPortProbe> {
    if (managed.record.status !== 'running' || !managed.record.pid) {
      return { ports: [], ownershipVerified: true }
    }
    return await this.portProbe(managed.record)
  }

  async waitForPort(sessionId: string, processId: string, timeoutMs = 2_500): Promise<ProcessRecord> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      let record = this.get(sessionId, processId)
      if (!record) throw new Error('Process not found')
      if (record.status !== 'running') return record
      const refreshed = await this.refreshPorts(sessionId, processId)
      if (refreshed) record = refreshed
      if (record.port && record.listeningPorts?.some((listener) => listener.port === record.port)) return record
      await new Promise((resolveWait) => setTimeout(resolveWait, 75))
    }
    const record = this.get(sessionId, processId)
    if (!record) throw new Error('Process not found')
    return record
  }

  async restart(
    sessionId: string,
    workspace: string,
    processId: string,
    context: ProcessEventContext = {},
  ): Promise<ProcessRecord> {
    const current = this.sessions.get(sessionId)?.get(processId)
    if (!current) throw new Error('Process not found')
    const command = current.record.command
    const name = current.record.name
    const portHint = current.portHint
    await this.stop(sessionId, processId, context)
    const next = await this.start(sessionId, workspace, command, portHint, context, name)
    return await this.waitForPort(sessionId, next.id, 8_000)
  }

  async restartFromRecord(
    sessionId: string,
    workspace: string,
    record: ProcessRecord,
    context: ProcessEventContext = {},
  ): Promise<ProcessRecord> {
    const live = this.sessions.get(sessionId)?.get(record.id)
    if (live) return await this.restart(sessionId, workspace, record.id, context)
    const next = await this.start(sessionId, workspace, record.command, record.portHint, context, record.name)
    return await this.waitForPort(sessionId, next.id, 8_000)
  }

  async stop(sessionId: string, processId: string, context?: ProcessEventContext): Promise<ProcessRecord> {
    const process = this.sessions.get(sessionId)?.get(processId)
    if (!process) throw new Error('Process not found')
    if (process.record.status !== 'running') return { ...process.record }
    if (context) process.context = context
    process.record.status = 'stopped'
    killProcessTree(process.child, 'SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killProcessTree(process.child, 'SIGKILL')
        setTimeout(resolve, 250).unref()
      }, 3_000)
      process.child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await process.eventQueue
    return { ...process.record }
  }

  async stopAll(sessionId: string, context?: ProcessEventContext): Promise<void> {
    const running = this.list(sessionId).filter((process) => process.status === 'running')
    await Promise.allSettled(running.map((process) => this.stop(sessionId, process.id, context)))
  }

  async stopEverything(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((sessionId) => this.stopAll(sessionId)))
  }
}

function detectServerPort(output: string): number | undefined {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '')
  const matches = [
    ...clean.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})/gi),
    ...clean.matchAll(/\b(?:port|listening on)\s*[:=]?\s*(\d{2,5})\b/gi),
  ]
  for (const match of matches.reverse()) {
    const port = Number.parseInt(match[1], 10)
    if (port >= 1 && port <= 65_535) return port
  }
  return undefined
}

export function detectCommandPort(command: string): number | undefined {
  const patterns = [
    /\bhttp\.server\s+(\d{2,5})\b/i,
    /(?:^|\s)--port(?:=|\s+)(\d{2,5})\b/i,
    /(?:^|\s)-p\s+(\d{2,5})\b/i,
    /\bPORT=(\d{2,5})\b/,
  ]
  for (const pattern of patterns) {
    const match = command.match(pattern)
    if (!match) continue
    const port = Number.parseInt(match[1], 10)
    if (port >= 1 && port <= 65_535) return port
  }
  return undefined
}

function appendUtf8Tail(current: string, chunk: string, maxBytes: number): string {
  const buffer = Buffer.from(`${current}${chunk}`, 'utf8')
  if (buffer.length <= maxBytes) return buffer.toString('utf8')
  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}

function portRecordKey(record: ProcessPortRecord): string {
  return `${record.address}\0${record.port}`
}

function uniquePortRecords(records: ProcessPortRecord[]): ProcessPortRecord[] {
  const unique = new Map(records.map((record) => [portRecordKey(record), record]))
  return [...unique.values()].sort((left, right) => left.port - right.port || left.address.localeCompare(right.address))
}

function unknownPortProbe(): ProcessGroupPortProbe {
  return { ports: [], ownershipVerified: false }
}

async function probeListeningPortsForManagedProcess(
  record: Pick<ProcessRecord, 'id' | 'pid'>,
  platform: NodeJS.Platform,
  procRoot: string,
): Promise<ProcessGroupPortProbe> {
  if (!record.pid) return unknownPortProbe()
  if (platform === 'win32') return unknownPortProbe()
  if (platform === 'linux') return await probeLinuxProcessPorts(record.pid, record.id, procRoot)
  return await probeLsofProcessPorts(record.pid, record.id)
}

interface ProcessTreeRow {
  pid: number
  parent: number
  group: number
}

interface LinuxProcessRow extends ProcessTreeRow {
  startTime: string
}

async function probeLinuxProcessPorts(rootPid: number, managedId: string, procRoot: string): Promise<ProcessGroupPortProbe> {
  try {
    const identityBefore = await readLinuxGuardianIdentity(procRoot, rootPid, managedId)
    const tableBefore = await readLinuxProcessTable(procRoot)
    const ownedBefore = selectOwnedProcessRows(tableBefore, rootPid)
    if (!sameLinuxProcess(identityBefore, ownedBefore.find((row) => row.pid === rootPid))) return unknownPortProbe()

    const portsBefore = await readLinuxOwnedListeners(procRoot, ownedBefore)

    const tableAfter = await readLinuxProcessTable(procRoot)
    const ownedAfter = selectOwnedProcessRows(tableAfter, rootPid)
    const identityAfter = await readLinuxGuardianIdentity(procRoot, rootPid, managedId)
    if (!sameLinuxProcess(identityBefore, identityAfter) || !sameLinuxProcessSets(ownedBefore, ownedAfter)) {
      return unknownPortProbe()
    }

    // Re-read fd ownership and the namespace LISTEN tables after the process
    // identity check. A listener that closed (and whose port may already have
    // been rebound by a decoy) is never returned from a one-sided snapshot.
    const portsAfter = await readLinuxOwnedListeners(procRoot, ownedAfter)
    const identityFinal = await readLinuxGuardianIdentity(procRoot, rootPid, managedId)
    if (!sameLinuxProcess(identityBefore, identityFinal) || !samePortRecordSets(portsBefore, portsAfter)) {
      return unknownPortProbe()
    }
    return { ports: portsAfter, ownershipVerified: true }
  } catch {
    // procfs permission failures, disappearing PIDs/fds, malformed tables,
    // and namespace races are all ownership-unknown. Never degrade to a TCP
    // connectivity check because that can borrow another process's listener.
    return unknownPortProbe()
  }
}

async function readLinuxGuardianIdentity(procRoot: string, pid: number, managedId: string): Promise<LinuxProcessRow> {
  const [stat, commandBuffer] = await Promise.all([
    readFile(resolve(procRoot, String(pid), 'stat'), 'utf8'),
    readFile(resolve(procRoot, String(pid), 'cmdline')),
  ])
  const row = parseLinuxProcessStat(stat)
  if (!row || row.pid !== pid) throw new Error('Managed guardian stat identity is unavailable')
  const args = commandBuffer.toString('utf8').split('\0').filter(Boolean)
  if (
    !args.some((argument) => argument.endsWith('/managed-process-guardian.mjs'))
    || !args.includes(`--managed-id=${managedId}`)
  ) {
    throw new Error('Managed guardian command identity mismatch')
  }
  return row
}

async function readLinuxProcessTable(procRoot: string): Promise<LinuxProcessRow[]> {
  const entries = await readdir(procRoot, { withFileTypes: true })
  const pids = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10))
  const rows: LinuxProcessRow[] = []
  for (let offset = 0; offset < pids.length; offset += 32) {
    const batch = await Promise.all(pids.slice(offset, offset + 32).map(async (pid) => {
      try {
        return parseLinuxProcessStat(await readFile(resolve(procRoot, String(pid), 'stat'), 'utf8'))
      } catch (error) {
        if (isMissingProcessEntry(error)) return undefined
        throw error
      }
    }))
    rows.push(...batch.filter((row): row is LinuxProcessRow => Boolean(row)))
  }
  return rows
}

function parseLinuxProcessStat(value: string): LinuxProcessRow | undefined {
  const open = value.indexOf('(')
  const close = value.lastIndexOf(')')
  if (open < 1 || close <= open) return undefined
  const pid = Number.parseInt(value.slice(0, open).trim(), 10)
  const fields = value.slice(close + 1).trim().split(/\s+/)
  const parent = Number.parseInt(fields[1], 10)
  const group = Number.parseInt(fields[2], 10)
  const startTime = fields[19]
  if (![pid, parent, group].every(Number.isInteger) || !/^\d+$/.test(startTime ?? '')) return undefined
  return { pid, parent, group, startTime }
}

function selectOwnedProcessRows<T extends ProcessTreeRow>(rows: T[], rootPid: number): T[] {
  const root = rows.find((row) => row.pid === rootPid)
  if (!root) throw new Error('Managed guardian disappeared during ownership probe')
  const selected = new Set(rows.filter((row) => row.group === root.group).map((row) => row.pid))
  selected.add(rootPid)
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!selected.has(row.parent) || selected.has(row.pid)) continue
      selected.add(row.pid)
      changed = true
    }
  }
  return rows.filter((row) => selected.has(row.pid)).sort((left, right) => left.pid - right.pid)
}

async function readLinuxOwnedListeners(procRoot: string, rows: LinuxProcessRow[]): Promise<ProcessPortRecord[]> {
  const socketsByNamespace = new Map<string, { pid: number; inodes: Set<string> }>()
  for (const row of rows) {
    const current = parseLinuxProcessStat(await readFile(resolve(procRoot, String(row.pid), 'stat'), 'utf8'))
    if (!sameLinuxProcess(row, current)) throw new Error('Managed descendant PID identity changed')
    const namespace = await readlink(resolve(procRoot, String(row.pid), 'ns', 'net'))
    if (!/^net:\[\d+\]$/.test(namespace)) throw new Error('Managed descendant network namespace is unavailable')
    const owned = socketsByNamespace.get(namespace) ?? { pid: row.pid, inodes: new Set<string>() }
    const descriptors = await readdir(resolve(procRoot, String(row.pid), 'fd'))
    for (const descriptor of descriptors) {
      const target = await readlink(resolve(procRoot, String(row.pid), 'fd', descriptor))
      const match = target.match(/^socket:\[(\d+)\]$/)
      if (match) owned.inodes.add(match[1])
    }
    socketsByNamespace.set(namespace, owned)
  }

  const records: ProcessPortRecord[] = []
  for (const { pid, inodes } of socketsByNamespace.values()) {
    if (inodes.size === 0) continue
    const [ipv4, ipv6] = await Promise.all([
      readFile(resolve(procRoot, String(pid), 'net', 'tcp'), 'utf8'),
      readFile(resolve(procRoot, String(pid), 'net', 'tcp6'), 'utf8'),
    ])
    records.push(
      ...parseLinuxTcpListeners(ipv4, 'ipv4', inodes),
      ...parseLinuxTcpListeners(ipv6, 'ipv6', inodes),
    )
  }
  return uniquePortRecords(records)
}

function parseLinuxTcpListeners(
  value: string,
  family: 'ipv4' | 'ipv6',
  ownedInodes: ReadonlySet<string>,
): ProcessPortRecord[] {
  const records: ProcessPortRecord[] = []
  for (const line of value.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || fields[3] !== '0A' || !ownedInodes.has(fields[9])) continue
    const separator = fields[1].lastIndexOf(':')
    if (separator < 1) continue
    const addressHex = fields[1].slice(0, separator)
    const port = Number.parseInt(fields[1].slice(separator + 1), 16)
    const address = family === 'ipv4'
      ? decodeLinuxIpv4Address(addressHex)
      : decodeLinuxIpv6Address(addressHex)
    if (!address || !Number.isInteger(port) || port < 1 || port > 65_535) continue
    records.push({ port, address })
  }
  return records
}

function decodeLinuxIpv4Address(value: string): string | undefined {
  if (!/^[a-f\d]{8}$/i.test(value)) return undefined
  const bytes = value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []
  if (endianness() === 'LE') bytes.reverse()
  return bytes.join('.')
}

function decodeLinuxIpv6Address(value: string): string | undefined {
  if (!/^[a-f\d]{32}$/i.test(value)) return undefined
  const bytes: number[] = []
  for (let offset = 0; offset < value.length; offset += 8) {
    const word = value.slice(offset, offset + 8).match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []
    bytes.push(...(endianness() === 'LE' ? word.reverse() : word))
  }
  const groups = Array.from({ length: 8 }, (_, index) => ((bytes[index * 2] << 8) | bytes[index * 2 + 1]).toString(16))
  let bestStart = -1
  let bestLength = 0
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== '0') {
      start += 1
      continue
    }
    let end = start
    while (end < groups.length && groups[end] === '0') end += 1
    if (end - start > bestLength && end - start >= 2) {
      bestStart = start
      bestLength = end - start
    }
    start = end
  }
  if (bestStart < 0) return groups.join(':')
  const before = groups.slice(0, bestStart).join(':')
  const after = groups.slice(bestStart + bestLength).join(':')
  return `${before}::${after}`
}

function sameLinuxProcess(left: LinuxProcessRow | undefined, right: LinuxProcessRow | undefined): boolean {
  return Boolean(
    left
    && right
    && left.pid === right.pid
    && left.parent === right.parent
    && left.group === right.group
    && left.startTime === right.startTime,
  )
}

function sameLinuxProcessSets(left: LinuxProcessRow[], right: LinuxProcessRow[]): boolean {
  return left.length === right.length && left.every((row, index) => sameLinuxProcess(row, right[index]))
}

function samePortRecordSets(left: ProcessPortRecord[], right: ProcessPortRecord[]): boolean {
  return left.length === right.length && left.every((record, index) => portRecordKey(record) === portRecordKey(right[index]))
}

function isMissingProcessEntry(error: unknown): boolean {
  return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException)?.code ?? '')
}

async function probeLsofProcessPorts(rootPid: number, managedId: string): Promise<ProcessGroupPortProbe> {
  try {
    if (await inspectManagedProcessIdentity({ id: managedId, pid: rootPid }) !== 'matched') return unknownPortProbe()
    const before = await readPsProcessTable()
    if (!before) return unknownPortProbe()
    const ownedBefore = selectOwnedProcessRows(before, rootPid)
    const lsof = await runOsProbe('lsof', [
      '-nP', '-a', '-p', ownedBefore.map((row) => row.pid).join(','), '-iTCP', '-sTCP:LISTEN', '-F', 'pn',
    ])
    if (!lsof || lsof.truncated || !([0, 1].includes(lsof.exitCode ?? -1)) || (lsof.exitCode === 1 && lsof.stderr.trim())) {
      return unknownPortProbe()
    }
    const after = await readPsProcessTable()
    if (
      !after
      || !sameProcessTreeSets(ownedBefore, selectOwnedProcessRows(after, rootPid))
      || await inspectManagedProcessIdentity({ id: managedId, pid: rootPid }) !== 'matched'
    ) {
      return unknownPortProbe()
    }
    const records: ProcessPortRecord[] = []
    for (const line of lsof.stdout.split(/\r?\n/)) {
      if (!line.startsWith('n')) continue
      const match = line.slice(1).match(/^(.*):(\d+)$/)
      if (!match) continue
      const port = Number.parseInt(match[2], 10)
      if (port < 1 || port > 65_535) continue
      let address = match[1]
      if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
      if (address === '*') address = '0.0.0.0'
      records.push({ port, address })
    }
    return { ports: uniquePortRecords(records), ownershipVerified: true }
  } catch {
    return unknownPortProbe()
  }
}

async function readPsProcessTable(): Promise<ProcessTreeRow[] | undefined> {
  const ps = await runOsProbe('/bin/ps', ['-axo', 'pid=,ppid=,pgid='])
  if (!ps || ps.exitCode !== 0 || ps.stderr.trim() || ps.truncated) return undefined
  return ps.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
    return match ? [{
      pid: Number.parseInt(match[1], 10),
      parent: Number.parseInt(match[2], 10),
      group: Number.parseInt(match[3], 10),
    }] : []
  })
}

function sameProcessTreeSets(left: ProcessTreeRow[], right: ProcessTreeRow[]): boolean {
  return left.length === right.length && left.every((row, index) => (
    row.pid === right[index]?.pid && row.parent === right[index]?.parent && row.group === right[index]?.group
  ))
}

interface OsProbeResult {
  stdout: string
  stderr: string
  exitCode: number | null
  truncated: boolean
}

async function runOsProbe(executable: string, args: string[]): Promise<OsProbeResult | undefined> {
  return await new Promise<OsProbeResult | undefined>((resolveProbe) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false
    const capture = (current: string, chunk: Buffer): string => {
      const next = `${current}${chunk.toString('utf8')}`
      if (Buffer.byteLength(next, 'utf8') > 256 * 1_024) truncated = true
      return appendUtf8Tail(current, chunk.toString('utf8'), 256 * 1_024)
    }
    const finish = (value: OsProbeResult | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveProbe(value)
    }
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* best effort probe cleanup */ }
      finish(undefined)
    }, 750)
    child.stdout.on('data', (chunk: Buffer) => { stdout = capture(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = capture(stderr, chunk) })
    child.once('error', () => finish(undefined))
    child.once('close', (exitCode) => finish({ stdout, stderr, exitCode, truncated }))
  })
}

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
  durationMs: number
  truncated: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
}

export async function runCommand(options: {
  command: string
  workspace: string
  workingDirectory?: string
  timeoutMs: number
  maxOutputBytes: number
  signal: AbortSignal
  onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void
  allowNetwork?: boolean
  /** Trusted broker-only overrides; never populate this from model arguments. */
  environment?: NodeJS.ProcessEnv
  guardianId?: string
  onGuardianReady?: (pid: number) => Promise<void>
}): Promise<CommandResult> {
  validateCommand(options.command)
  const guardianId = options.guardianId ?? createId('cmd')
  if (!/^cmd_[a-f0-9]{20}$/.test(guardianId)) throw new Error('Invalid foreground command guardian ID')
  const started = Date.now()
  const invocation = createShellInvocation(
    options.command,
    options.workspace,
    options.allowNetwork ? 'full' : 'none',
  )
  const child = spawn(process.execPath, [managedProcessGuardianPath(), `--managed-id=${guardianId}`, '--await-start'], {
    cwd: options.workspace,
    env: guardianEnvironment({
      executable: invocation.executable,
      args: invocation.args,
      cwd: options.workingDirectory ?? options.workspace,
      env: {
        ...commandEnvironment(options.workspace),
        ...options.environment,
      },
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] }
  const capturedBytes: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 }
  const streamTruncated: Record<'stdout' | 'stderr', boolean> = { stdout: false, stderr: false }
  const decoders: Record<'stdout' | 'stderr', StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  }

  const capture = (stream: 'stdout' | 'stderr', buffer: Buffer) => {
    const remaining = Math.max(0, options.maxOutputBytes - capturedBytes[stream])
    const accepted = remaining >= buffer.length ? buffer : buffer.subarray(0, remaining)
    if (accepted.length > 0) {
      chunks[stream].push(Buffer.from(accepted))
      capturedBytes[stream] += accepted.length
      const text = decoders[stream].write(accepted)
      if (text) options.onOutput(stream, text)
    }
    if (accepted.length < buffer.length) streamTruncated[stream] = true
  }
  child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk))
  child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk))

  try {
    await waitForSpawn(child)
    if (!child.pid) throw new Error('Foreground command guardian has no PID')
    await options.onGuardianReady?.(child.pid)
    child.stdin.write('START\n')
  } catch (error) {
    child.stdin.end()
    killProcessTree(child, 'SIGTERM')
    await waitForClose(child, 1_500)
    throw error
  }

  return await new Promise<CommandResult>((resolve, reject) => {
    let timedOut = false
    let requestedSignal: string | null = null
    const terminate = () => {
      requestedSignal = 'SIGTERM'
      killProcessTree(child, 'SIGTERM')
      setTimeout(() => killProcessTree(child, 'SIGKILL'), 1_500).unref()
    }
    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, options.timeoutMs)
    const abort = () => terminate()
    options.signal.addEventListener('abort', abort, { once: true })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout)
      options.signal.removeEventListener('abort', abort)
      let stdout = decodeUtf8Prefix(chunks.stdout)
      let stderr = decodeUtf8Prefix(chunks.stderr)
      if (timedOut) stderr = `${stderr}\nCommand timed out after ${options.timeoutMs}ms`.trim()
      if (options.signal.aborted) stderr = `${stderr}\nCommand cancelled`.trim()
      resolve({
        stdout,
        stderr,
        exitCode,
        signal: signal ?? requestedSignal,
        durationMs: Date.now() - started,
        truncated: streamTruncated.stdout || streamTruncated.stderr,
        stdoutTruncated: streamTruncated.stdout,
        stderrTruncated: streamTruncated.stderr,
        timedOut,
      })
    })
  })
}

function decodeUtf8Prefix(chunks: Buffer[]): string {
  const buffer = Buffer.concat(chunks)
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, buffer.length - trim))
    } catch {
      // A byte limit can land inside the final UTF-8 scalar; drop only that scalar's partial suffix.
    }
  }
  return buffer.toString('utf8')
}

interface GuardianInvocation {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export type ManagedProcessIdentityResult = 'matched' | 'not_found' | 'mismatch' | 'unverified' | 'unsupported'

export interface ManagedProcessRecoveryResult {
  processId: string
  pid?: number
  identity: ManagedProcessIdentityResult
  action: 'terminated' | 'already_absent' | 'not_killed'
  forced: boolean
}

/**
 * Terminate a process left in a durable running state after restart. The
 * command-line marker is checked before every signal so a reused PID can
 * never cause an unrelated process to be killed.
 */
export async function terminateRecoveredManagedProcess(record: Pick<ProcessRecord, 'id' | 'pid'>): Promise<ManagedProcessRecoveryResult> {
  const pid = record.pid
  const identity = await inspectManagedProcessIdentity(record)
  if (identity === 'not_found') {
    return { processId: record.id, pid, identity, action: 'already_absent', forced: false }
  }
  if (identity !== 'matched' || !pid) {
    return { processId: record.id, pid, identity, action: 'not_killed', forced: false }
  }

  signalProcessGroup(pid, 'SIGTERM')
  const terminatedAfterTerm = await waitForManagedProcessExit(record, 1_250)
  if (terminatedAfterTerm) {
    return { processId: record.id, pid, identity, action: 'terminated', forced: false }
  }

  // Revalidate immediately before SIGKILL. The original guardian may have
  // exited and its PID may already belong to another process.
  if (await inspectManagedProcessIdentity(record) !== 'matched') {
    return { processId: record.id, pid, identity, action: 'terminated', forced: false }
  }
  signalProcessGroup(pid, 'SIGKILL')
  await waitForManagedProcessExit(record, 750)
  return { processId: record.id, pid, identity, action: 'terminated', forced: true }
}

export async function inspectManagedProcessIdentity(record: Pick<ProcessRecord, 'id' | 'pid'>): Promise<ManagedProcessIdentityResult> {
  if (process.platform === 'win32') return 'unsupported'
  const pid = record.pid
  if (!pid || !Number.isInteger(pid) || pid <= 1 || !isProcessAlive(pid)) return 'not_found'
  const command = await readProcessCommand(pid)
  if (command === undefined) return isProcessAlive(pid) ? 'unverified' : 'not_found'
  const marker = `--managed-id=${record.id}`
  return command.includes('managed-process-guardian.mjs') && command.split(/\s+/).includes(marker)
    ? 'matched'
    : 'mismatch'
}

function guardianEnvironment(invocation: GuardianInvocation): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL,
    ANERA_MANAGED_INVOCATION: Buffer.from(JSON.stringify(invocation)).toString('base64url'),
  }
}

function managedProcessGuardianPath(): string {
  return fileURLToPath(new URL('../../scripts/managed-process-guardian.mjs', import.meta.url))
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) return
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn)
    child.once('error', rejectSpawn)
  })
}

async function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveClose) => {
    const timer = setTimeout(resolveClose, timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolveClose()
    })
  })
}

async function waitForManagedProcessExit(record: Pick<ProcessRecord, 'id' | 'pid'>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await inspectManagedProcessIdentity(record) !== 'matched') return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  return await inspectManagedProcessIdentity(record) !== 'matched'
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readProcessCommand(pid: number): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolveCommand) => {
    const ps = spawn('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    ps.stdout.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-32_768) })
    ps.once('error', () => resolveCommand(undefined))
    ps.once('close', (code) => resolveCommand(code === 0 ? stdout.trim() : undefined))
  })
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH' && code !== 'EPERM') throw error
    }
  }
  try {
    child.kill(signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
