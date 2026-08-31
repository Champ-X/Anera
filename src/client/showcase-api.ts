import type {
  AgentModelOption,
  SessionEvent,
  SessionSnapshot,
  SessionSummary,
  UsageTotals,
  WorkspaceEntry,
} from '../shared/types'
import rawShowcaseData from './showcase-data.json'

export interface ShowcaseDemoDefinition {
  id: string
  title: string
  eyebrow: string
  note: string
  metrics: UsageTotals
}

interface ShowcaseData {
  schemaVersion: string
  generatedAt: string
  disclosure: string
  defaultSessionId: string
  demos: ShowcaseDemoDefinition[]
  sessions: SessionSummary[]
  snapshots: Record<string, SessionSnapshot>
}

const data = rawShowcaseData as unknown as ShowcaseData
const replayLimits = new Map<string, number | null>()

export const showcaseCatalog = {
  schemaVersion: data.schemaVersion,
  generatedAt: data.generatedAt,
  disclosure: data.disclosure,
  defaultSessionId: data.defaultSessionId,
  demos: data.demos,
}

export function showcaseReplayCheckpoints(sessionId: string): number[] {
  const snapshot = data.snapshots[sessionId]
  if (!snapshot) return []
  const significant = new Set([
    'session.created',
    'turn.started',
    'run.status',
    'assistant.thought.completed',
    'tool.started',
    'tool.completed',
    'tool.failed',
    'tool.timed_out',
    'file.changed',
    'artifact.created',
    'website.updated',
    'plan.updated',
    'context.compacted',
    'assistant.final',
    'turn.completed',
  ])
  const checkpoints = snapshot.events
    .filter((event) => significant.has(event.type))
    .map((event) => event.seq)
  const finalSeq = snapshot.events.at(-1)?.seq
  if (finalSeq !== undefined && checkpoints.at(-1) !== finalSeq) checkpoints.push(finalSeq)
  return [...new Set(checkpoints)].sort((left, right) => left - right)
}

export function setShowcaseReplayLimit(sessionId: string, seq: number | null): void {
  replayLimits.set(sessionId, seq)
}

export function clearShowcaseReplayLimits(): void {
  replayLimits.clear()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function eventUsage(events: SessionEvent[], fallback: UsageTotals): UsageTotals {
  const latest = [...events].reverse().find((event) => event.type === 'usage.updated')
  const usage = (latest?.data as { usage?: UsageTotals } | undefined)?.usage
  return usage ? clone(usage) : {
    ...clone(fallback),
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    modelCalls: 0,
    toolCalls: 0,
    estimatedCostUsd: 0,
    activeDurationMs: 0,
    durationMs: 0,
  }
}

function filterWorkspace(entries: WorkspaceEntry[], paths: ReadonlySet<string>): WorkspaceEntry[] {
  return entries.flatMap((entry): WorkspaceEntry[] => {
    if (entry.type === 'file') return paths.has(entry.path) ? [entry] : []
    const children = filterWorkspace(entry.children ?? [], paths)
    return children.length > 0 ? [{ ...entry, children }] : []
  })
}

function replaySnapshot(source: SessionSnapshot, limit: number): SessionSnapshot {
  const snapshot = clone(source)
  const events = snapshot.events.filter((event) => event.seq <= limit)
  const lastEvent = events.at(-1)
  const latestStatus = [...events].reverse().find((event) => event.type === 'run.status')
  const status = (latestStatus?.data as { status?: SessionSummary['status'] } | undefined)?.status
    ?? (events.some((event) => event.type === 'turn.started') ? 'running' : 'idle')
  const artifactsByPath = new Map<string, SessionSnapshot['artifacts'][number]>()
  for (const event of events) {
    if (event.type !== 'artifact.created') continue
    const artifact = (event.data as { artifact?: SessionSnapshot['artifacts'][number] }).artifact
    if (artifact?.id && artifact.path) artifactsByPath.set(artifact.path, clone(artifact))
  }
  const visiblePaths = new Set<string>()
  for (const event of events) {
    if (event.type === 'file.changed' && typeof (event.data as { path?: unknown }).path === 'string') {
      visiblePaths.add((event.data as { path: string }).path)
    }
    if (event.type === 'turn.started') {
      for (const path of (event.data as { attachments?: unknown[] }).attachments ?? []) {
        if (typeof path === 'string') visiblePaths.add(path)
      }
    }
  }
  const latestWebsite = [...events].reverse().find((event) => event.type === 'website.updated')
  const website = (latestWebsite?.data as { website?: SessionSnapshot['website'] } | undefined)?.website
  snapshot.events = events
  snapshot.session.status = status
  snapshot.session.updatedAt = lastEvent?.at ?? snapshot.session.createdAt
  snapshot.session.usage = eventUsage(events, source.session.usage)
  snapshot.artifacts = [...artifactsByPath.values()]
  snapshot.workspace = filterWorkspace(snapshot.workspace, visiblePaths)
  snapshot.workspaceInventory = {
    hasMore: false,
    truncated: false,
    totalFiles: visiblePaths.size,
    loadedEntries: visiblePaths.size,
  }
  snapshot.website = website ? clone(website) : {
    status: 'stopped',
    updatedAt: snapshot.session.updatedAt,
    restartCount: 0,
  }
  return snapshot
}

export function showcaseSnapshot(sessionId: string): SessionSnapshot {
  const source = data.snapshots[sessionId]
  if (!source) throw new Error('Showcase session not found')
  const limit = replayLimits.get(sessionId)
  return typeof limit === 'number' ? replaySnapshot(source, limit) : clone(source)
}

function flattenWorkspace(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.flatMap((entry) => [
    { ...entry, children: undefined },
    ...(entry.type === 'directory' ? flattenWorkspace(entry.children ?? []) : []),
  ])
}

function bodyOf(options?: RequestInit): Record<string, unknown> {
  if (typeof options?.body !== 'string') return {}
  try { return JSON.parse(options.body) as Record<string, unknown> }
  catch { return {} }
}

export async function showcaseRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const url = new URL(path, window.location.origin)
  const method = (options?.method ?? 'GET').toUpperCase()
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/(ses_[a-z0-9]{20})$/)
  const inventoryMatch = url.pathname.match(/^\/api\/sessions\/(ses_[a-z0-9]{20})\/workspace-inventory$/)

  if (method === 'GET' && url.pathname === '/api/sessions') return { sessions: clone(data.sessions) } as T
  if (method === 'GET' && sessionMatch) return showcaseSnapshot(sessionMatch[1]) as T
  if (method === 'GET' && inventoryMatch) {
    const snapshot = showcaseSnapshot(inventoryMatch[1])
    const entries = flattenWorkspace(snapshot.workspace)
    return {
      entries,
      hasMore: false,
      truncated: false,
      totalFiles: entries.filter((entry) => entry.type === 'file').length,
      loadedEntries: entries.length,
    } as T
  }
  if (method === 'GET' && url.pathname === '/api/agent-models') {
    const models: AgentModelOption[] = [{ id: 'deepseek-chat', publicName: 'DeepSeek V3.1', displayName: 'DeepSeek' }]
    return { models } as T
  }
  if (method === 'GET' && url.pathname === '/api/billing/balance') {
    return { creditsRemaining: 2500, dailyFreeCredits: 2500, refreshedAt: '2026-09-01T00:00:00.000Z' } as T
  }
  if (method === 'GET' && url.pathname === '/api/me/pulse') {
    return { pulse: 2500, refreshedAt: '2026-09-01T00:00:00.000Z' } as T
  }
  if (method === 'GET' && url.pathname === '/api/coding/github/connection') return { status: 'disconnected' } as T
  if (method === 'GET' && url.pathname === '/api/coding/github/status') {
    return { indicator: 'none', description: 'All Systems Operational' } as T
  }
  if (method === 'GET' && url.pathname === '/api/coding/github/repos') {
    return { repos: [], nextCursor: null, hasNextPage: false } as T
  }
  if (method === 'GET' && url.pathname === '/api/coding/github/branches') {
    return { branches: [], nextCursor: null, hasNextPage: false } as T
  }

  // Mutating controls are disabled by the exhibit UI. These inert responses
  // keep secondary feedback controls safe if a visitor activates one through
  // assistive technology or a restored browser state.
  if (method !== 'GET') {
    const body = bodyOf(options)
    if (url.pathname.endsWith('/review-feedback')) {
      return { sessionNodeId: body.sessionNodeId, action: body.action, feedback: body.feedback } as T
    }
    return {} as T
  }
  throw new Error(`Static showcase endpoint is unavailable: ${url.pathname}`)
}
