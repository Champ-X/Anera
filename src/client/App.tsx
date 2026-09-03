import {
  Archive,
  ArrowDown,
  ArrowUp,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  CircleStop,
  CloudUpload,
  Code2,
  Copy,
  Download,
  Eye,
  ExternalLink,
  File as FileIcon,
  FileCode2,
  FileText,
  Folder,
  GitBranch,
  Github,
  Globe2,
  Heart,
  Info,
  Image as ImageIcon,
  LoaderCircle,
  ListChecks,
  Menu,
  MousePointer2,
  Paperclip,
  Play,
  Plus,
  Plug,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  TerminalSquare,
  ThumbsDown,
  ThumbsUp,
  Timer,
  Unplug,
  Volume2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import aneraLogoUrl from '../../logo.png'
import { AGENT_UPLOAD_ACCEPT_ATTR, selectAgentUploads } from '../shared/agent-upload-policy'
import type {
  AgentModelOption,
  ArtifactRecord,
  CodingRepositoryState,
  CreditBalance,
  GitHubBranch,
  GitHubConnectionState,
  GitHubRepository,
  GitHubStatusState,
  OfficeArtifactPreview,
  PlanState,
  PointwiseFeedbackValue,
  ProcessRecord,
  RunStatus,
  SessionEvent,
  SessionSnapshot,
  SessionSummary,
  SessionTokenLimitState,
  TaskCompletionFeedbackValue,
  TaskReviewFeedbackAction,
  WorkspaceEntry,
  WorkspaceInventoryMetadata,
} from '../shared/types'
import { AGENT_LEADERBOARD_PATH, AgentLeaderboard, isAgentLeaderboardPath } from './AgentLeaderboard'
import { api } from './api'
import {
  SHOWCASE_NAVIGATION_EVENT,
  SHOWCASE_REPLAY_EVENT,
  STATIC_SHOWCASE,
  showcaseAssetUrl,
} from './showcase-mode'

export const HISTORY_SEARCH_PATH = '/history/search'
export const AGENT_DRAFT_PATH = '/agent'
const DRAFT_COMPOSER_SESSION_ID = 'draft'
export const CONVERSATION_NEAR_BOTTOM_PX = 32

export type WorkspacePersistencePhase = 'scanning' | 'uploading' | 'saving' | 'saved'

export interface WorkspacePersistenceView {
  eventId: string
  phase: WorkspacePersistencePhase
  label: string
  blobCount?: number
  bytes?: number
  fileCount?: number
}

export interface WorkspaceInventoryView extends WorkspaceInventoryMetadata {
  sessionId: string
  entries: WorkspaceEntry[]
  status: 'ready' | 'loading' | 'refreshing' | 'failed'
  error?: string
}

/**
 * Project only the durable Workspace-persistence protocol. The copy is
 * derived locally instead of trusting arbitrary event text, so the same
 * contract drives the composer and the compact sidebar status.
 */
export function workspacePersistenceFromEvent(event: SessionEvent): WorkspacePersistenceView | undefined {
  const data = event.data as Record<string, unknown>
  const integer = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined
  if (event.type === 'workspace.persistence.started') {
    return { eventId: event.id, phase: 'scanning', label: 'Scanning workspace...' }
  }
  if (event.type === 'workspace.persistence.updated' && data.phase === 'uploading') {
    const blobCount = integer(data.blobCount) ?? 0
    return {
      eventId: event.id,
      phase: 'uploading',
      label: `Uploading ${blobCount} workspace blobs...`,
      blobCount,
    }
  }
  if (event.type === 'workspace.persistence.updated' && data.phase === 'saving') {
    return {
      eventId: event.id,
      phase: 'saving',
      label: 'Saving workspace...',
      ...(integer(data.blobCount) === undefined ? {} : { blobCount: integer(data.blobCount) }),
    }
  }
  if (event.type === 'workspace.persistence.completed') {
    return {
      eventId: event.id,
      phase: 'saved',
      label: 'Workspace saved',
      ...(integer(data.blobCount) === undefined ? {} : { blobCount: integer(data.blobCount) }),
      ...(integer(data.bytes) === undefined ? {} : { bytes: integer(data.bytes) }),
      ...(integer(data.fileCount) === undefined ? {} : { fileCount: integer(data.fileCount) }),
    }
  }
  return undefined
}

export function workspacePersistenceSidebarLabel(status: WorkspacePersistenceView): string {
  if (status.phase === 'scanning') return 'Scanning'
  if (status.phase === 'uploading') return `Uploading ${status.blobCount ?? 0} blobs`
  if (status.phase === 'saving') return 'Saving'
  return 'Saved'
}

export interface ConversationScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function conversationDistanceFromBottom(metrics: ConversationScrollMetrics): number {
  const maximum = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
  return Math.max(0, maximum - metrics.scrollTop)
}

export function isConversationNearBottom(
  metrics: ConversationScrollMetrics,
  threshold = CONVERSATION_NEAR_BOTTOM_PX,
): boolean {
  return conversationDistanceFromBottom(metrics) <= Math.max(0, threshold)
}

export function conversationScrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth'
}

interface HistorySearchState {
  aneraSearchOverlay?: boolean
  aneraSearchOpenedFromApp?: boolean
  aneraSearchReturnPath?: string
}

export type ToolTimelineItem = {
  kind: 'tool'
  key: string
  name: string
  args: Record<string, unknown>
  result?: string
  liveOutput?: { stdout: string; stderr: string }
  status: 'running' | 'succeeded' | 'failed' | 'timed_out'
  durationMs?: number
  /** Arena keeps only the current foreground command expanded in the live log. */
  autoExpanded?: boolean
}

export type ToolCallDraftTimelineItem = {
  kind: 'tool-draft'
  key: string
  stepId: string
  streamIndex: number
  name: string
  argumentsText: string
  status: 'running' | 'interrupted'
}

export interface WorkspaceWriteDraft {
  key: string
  path: string
  bytes: number
}

export interface PartialJsonStringField {
  value: string
  complete: boolean
}

interface ScannedJsonString extends PartialJsonStringField {
  nextIndex: number
}

function scanJsonString(source: string, startIndex: number): ScannedJsonString {
  let value = ''
  let index = startIndex
  while (index < source.length) {
    const character = source[index++]
    if (character === '"') return { value, complete: true, nextIndex: index }
    if (character !== '\\') {
      value += character
      continue
    }
    if (index >= source.length) return { value, complete: false, nextIndex: index }
    const escape = source[index++]
    if (escape === 'u') {
      const digits = source.slice(index, index + 4)
      if (!/^[0-9a-fA-F]{4}$/.test(digits)) return { value, complete: false, nextIndex: source.length }
      value += String.fromCharCode(Number.parseInt(digits, 16))
      index += 4
      continue
    }
    value += escape === 'n' ? '\n'
      : escape === 'r' ? '\r'
        : escape === 't' ? '\t'
          : escape === 'b' ? '\b'
            : escape === 'f' ? '\f'
              : escape
  }
  return { value, complete: false, nextIndex: index }
}

/**
 * Decode a JSON string field while provider tool arguments are still partial.
 * A full JSON parse cannot work until the final quote and object delimiter
 * arrive, but the visible write preview must remain UTF-8 and escape correct.
 */
export function partialJsonStringField(source: string, field: string): PartialJsonStringField | undefined {
  const containers: Array<'{' | '['> = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (character === '{' || character === '[') {
      containers.push(character)
      index += 1
      continue
    }
    if (character === '}' || character === ']') {
      containers.pop()
      index += 1
      continue
    }
    if (character !== '"') {
      index += 1
      continue
    }
    const key = scanJsonString(source, index + 1)
    if (!key.complete) return undefined
    index = key.nextIndex
    if (containers.length !== 1 || containers[0] !== '{') continue
    while (/\s/.test(source[index] ?? '')) index += 1
    if (source[index] !== ':') continue
    index += 1
    if (key.value !== field) continue
    while (/\s/.test(source[index] ?? '')) index += 1
    if (source[index] !== '"') return undefined
    const value = scanJsonString(source, index + 1)
    return { value: value.value, complete: value.complete }
  }
  return undefined
}

function streamedFileWrite(item: ToolCallDraftTimelineItem): { path: string; content: string; bytes: number } | undefined {
  if (!['write_file', 'create_file'].includes(item.name)) return undefined
  const path = partialJsonStringField(item.argumentsText, 'path')?.value
    ?.replace(/^\/home\/user\//, '')
    .replace(/^\.\//, '')
  if (!path) return undefined
  const content = partialJsonStringField(item.argumentsText, 'content')?.value ?? ''
  return { path, content, bytes: new TextEncoder().encode(content).length }
}

export function workspaceWriteDraftsFromTimeline(timeline: readonly TimelineItem[]): WorkspaceWriteDraft[] {
  const drafts = new Map<string, WorkspaceWriteDraft>()
  for (const item of timeline) {
    if (item.kind !== 'tool-draft' || item.status !== 'running') continue
    const write = streamedFileWrite(item)
    if (write) drafts.set(write.path, { key: item.key, path: write.path, bytes: write.bytes })
  }
  return [...drafts.values()]
}

export interface CommandToolPresentation {
  command: string
  stdout?: string
  stderr?: string
}

export function commandToolPresentation(item: ToolTimelineItem): CommandToolPresentation {
  let payload: Record<string, unknown> = {}
  if (item.result) {
    try {
      const parsed = JSON.parse(item.result) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
    } catch {
      // Live output has an intentionally human-readable, non-JSON projection.
    }
  }
  const stdout = item.liveOutput?.stdout
    || (typeof payload.stdout === 'string' ? payload.stdout : '')
    || (typeof payload.log_tail === 'string' ? payload.log_tail : '')
  const stderr = item.liveOutput?.stderr || (typeof payload.stderr === 'string' ? payload.stderr : '')
  return {
    command: String(item.args.command || ''),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  }
}

export function startProcessTimelineLabel(item: Pick<ToolTimelineItem, 'args' | 'result'>): string {
  const name = String(item.args.name || item.args.description || item.args.command || 'process').slice(0, 70)
  const argumentPort = typeof item.args.port === 'number' && Number.isInteger(item.args.port) ? item.args.port : undefined
  let resultPort: number | undefined
  if (item.result) {
    try {
      const payload = JSON.parse(item.result) as Record<string, unknown>
      for (const field of ['new_ports', 'listening_ports'] as const) {
        const ports = Array.isArray(payload[field]) ? payload[field] as Array<Record<string, unknown>> : []
        const candidate = ports.find((entry) => typeof entry.port === 'number' && Number.isInteger(entry.port))?.port
        if (typeof candidate === 'number') {
          resultPort = candidate
          break
        }
      }
    } catch {
      // A partial live result can omit the structured port until completion.
    }
  }
  const port = argumentPort ?? resultPort
  return `Start ${name}${port === undefined ? '' : ` :${port}`}`
}

function toolTimelineLabel(item: ToolTimelineItem): string {
  return item.name === 'start_process'
    ? startProcessTimelineLabel(item)
    : toolLabel(item.name, item.args, item.status)
}

export type HitlTimelineItem = {
  kind: 'hitl'
  key: string
  hitlId: string
  hitlKind: 'ask_user' | 'propose_plan' | 'add_voice' | 'generate_image'
  title: string
  call: { name: string; arguments: Record<string, unknown> }
  payload: Record<string, unknown>
  decision: 'pending' | 'resolved' | 'expired'
  response?: Record<string, unknown>
}

export type ToolGroupTimelineItem =
  | { kind: 'exploration'; key: string; tools: ToolTimelineItem[] }
  | { kind: 'tool-group'; key: string; variant: 'commands' | 'files'; tools: ToolTimelineItem[] }

export type TimelineItem =
  | { kind: 'user'; key: string; content: string; attachments: string[]; customFeedbackTurn?: boolean; reviewedNodeId?: string }
  | { kind: 'activity'; key: string; label: string }
  | { kind: 'thought'; key: string; label: string; content: string; running: boolean; duration?: string }
  | { kind: 'plan'; key: string; plan: PlanState }
  | ToolGroupTimelineItem
  | ToolTimelineItem
  | ToolCallDraftTimelineItem
  | { kind: 'artifact'; key: string; artifact: ArtifactRecord }
  | { kind: 'approval'; key: string; approvalId: string; title: string; description: string; call: { name: string; arguments: Record<string, unknown> }; decision: 'pending' | 'approved' | 'denied' | 'expired' }
  | HitlTimelineItem
  | { kind: 'final'; key: string; content: string; streaming: boolean; messageEventId?: string; feedback: PointwiseFeedbackValue | null }
  | { kind: 'error'; key: string; content: string; cancelled: boolean }

function hitlAnswerContent(item: HitlTimelineItem): string | undefined {
  const response = item.response ?? {}
  const status = typeof response.status === 'string' ? response.status.toLowerCase() : ''
  if (
    item.decision !== 'resolved'
    || response.skipped === true
    || response.dismissed === true
    || ['skipped', 'dismissed', 'expired'].includes(status)
  ) return undefined

  if (item.hitlKind === 'propose_plan') {
    const decision = String(response.decision || '').toLowerCase()
    const feedback = typeof response.feedback === 'string' ? response.feedback.trim() : ''
    if (decision === 'accepted' || decision === 'accept') return 'Accept plan'
    if (decision === 'revise') return feedback ? `Request changes: ${feedback}` : 'Request changes'
    if (decision === 'rejected' || decision === 'reject') return feedback ? `Reject plan: ${feedback}` : 'Reject plan'
    return undefined
  }

  if (item.hitlKind === 'add_voice') {
    const candidates = Array.isArray(item.payload.candidates)
      ? item.payload.candidates.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
      : []
    const candidateId = typeof response.candidate_id === 'string' ? response.candidate_id : ''
    const candidate = candidates.find((value) => value.id === candidateId)
    const label = typeof candidate?.label === 'string' && candidate.label.trim()
      ? candidate.label.trim()
      : typeof response.voice_id === 'string' && response.voice_id.trim()
        ? response.voice_id.trim()
        : candidateId
    return label ? `Use voice: ${label}` : undefined
  }

  if (item.hitlKind === 'generate_image') {
    const selectedIndex = typeof response.selected_index === 'number' && Number.isInteger(response.selected_index)
      ? response.selected_index
      : undefined
    if (selectedIndex === undefined) return undefined
    const candidates = Array.isArray(item.payload.candidates)
      ? item.payload.candidates.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
      : []
    const candidate = candidates.find((value) => value.index === selectedIndex)
    const label = typeof candidate?.label === 'string' ? candidate.label.trim() : ''
    return label ? `Use image: ${label}` : `Use image option ${selectedIndex + 1}`
  }

  const questions = Array.isArray(item.payload.questions)
    ? item.payload.questions.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    : []
  const answers = Array.isArray(response.answers)
    ? response.answers.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    : []
  const formatted = answers.flatMap((answer, index) => {
    const questionId = typeof answer.questionId === 'string'
      ? answer.questionId
      : typeof answer.question_id === 'string' ? answer.question_id : ''
    const question = questions.find((value) => value.id === questionId) ?? questions[index]
    const options = Array.isArray(question?.options)
      ? question.options.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
      : []
    const selectedValues = Array.isArray(answer.selected)
      ? answer.selected.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      : typeof answer.selected === 'string' && answer.selected.trim()
        ? [answer.selected]
        : typeof answer.selectedOptionId === 'string' && answer.selectedOptionId.trim()
          ? [answer.selectedOptionId]
          : []
    const selectedLabels = selectedValues.map((value) => {
      const option = options.find((candidate) => candidate.id === value || candidate.label === value)
      return typeof option?.label === 'string' && option.label.trim() ? option.label.trim() : value.trim()
    })
    const customResponse = typeof answer.customResponse === 'string'
      ? answer.customResponse.trim()
      : typeof answer.free_text === 'string'
        ? answer.free_text.trim()
        : typeof answer.custom_response === 'string' ? answer.custom_response.trim() : ''
    const answerText = [...selectedLabels, customResponse].filter(Boolean).join(' — ')
    if (!answerText) return []
    const questionText = typeof question?.question === 'string' ? question.question.trim() : ''
    return [{ questionText, answerText }]
  })
  if (formatted.length === 0) return undefined
  if (formatted.length === 1) return formatted[0].answerText
  return formatted.map(({ questionText, answerText }, index) => (
    `${questionText || `Question ${index + 1}`} — ${answerText}`
  )).join('\n')
}

export interface PreviewTarget {
  url: string
  label?: string
  downloadUrl?: string
  kind?: ArtifactRecord['kind']
  mime?: string
}

interface PreviewElementSelection {
  file: string
  selector: string
  tagName: string
  text: string
  outerHTML: string
}

export type PreviewRenderer = 'html' | 'markdown' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'office' | 'download'

export function previewRenderer(target: Pick<PreviewTarget, 'url' | 'label' | 'kind' | 'mime'>): PreviewRenderer {
  const label = target.label?.toLowerCase() || ''
  const mime = target.mime?.toLowerCase() || ''
  if (target.kind === 'website' || mime === 'text/html' || /\.html?$/.test(label)) return 'html'
  if (target.kind === 'image' || mime.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|svg|bmp)$/.test(label)) return 'image'
  if (target.kind === 'audio' || mime.startsWith('audio/') || /\.(?:mp3|wav|aac|flac|opus|m4a|oga|ogg|aif|aiff)$/.test(label)) return 'audio'
  if (target.kind === 'video' || mime.startsWith('video/') || /\.(?:mp4|webm|mov|m4v|ogv)$/.test(label)) return 'video'
  if (mime === 'application/pdf' || label.endsWith('.pdf')) return 'pdf'
  if (/\.(?:docx|xlsx|pptx)$/.test(label)
    || mime.includes('officedocument')
    || mime.includes('spreadsheetml')
    || mime.includes('presentationml')) return 'office'
  if (mime === 'text/markdown' || label.endsWith('.md')) return 'markdown'
  if (mime.startsWith('text/')
    || ['application/json', 'application/javascript', 'application/xml', 'application/sql', 'application/toml', 'application/x-yaml'].includes(mime)
    || target.kind === 'data'
    || /\.(?:txt|csv|tsv|json|ya?ml|toml|sql|css|[cm]?jsx?|tsx?|pyi?|sh|bash|zsh|xml)$/.test(label)) return 'text'
  // Managed Website targets are origin URLs without an Artifact type.
  if (!target.kind && !target.mime && !target.label && /^https?:\/\//.test(target.url)) return 'html'
  return 'download'
}

interface PopoverAnchor {
  left: number
  top: number
}

export interface ComposerAttachment {
  name: string
  path: string
  size: number
  mime: string
  /** Arena CAS URL used by image parts during an atomic first submission. */
  url?: string
  /** Kept only in browser memory until an `/agent` draft is first submitted. */
  file?: File
}

interface ComposerDraftSnapshot {
  sessionId: string
  value: string
  attachments: ComposerAttachment[]
}

interface ComposerDraftCommand extends ComposerDraftSnapshot {
  id: number
  focus?: boolean
}

export async function materializeComposerAttachments(
  attachments: readonly ComposerAttachment[],
  upload: (file: File) => Promise<{ path: string; bytes: number; mime: string }>,
  onProgress?: (attachments: ComposerAttachment[]) => void,
): Promise<ComposerAttachment[]> {
  const resolved = attachments.map((attachment) => ({ ...attachment }))
  for (let index = 0; index < resolved.length; index += 1) {
    const attachment = resolved[index]
    if (!attachment.file) continue
    const uploaded = await upload(attachment.file)
    resolved[index] = {
      name: attachment.name,
      path: uploaded.path,
      size: uploaded.bytes,
      mime: uploaded.mime,
      ...('url' in uploaded && typeof uploaded.url === 'string' ? { url: uploaded.url } : {}),
    }
    onProgress?.(resolved.map((item) => ({ ...item })))
  }
  return resolved
}

export interface UndoTurnCandidate {
  sessionNodeId: string
  promptText: string
  targetTurnIds: string[]
}

export interface CustomFeedbackOffer {
  messageEventId: string
  arm: 'treatment-1' | 'treatment-2'
}

export const CODING_REPOSITORY_PANEL_STORAGE_KEY = 'coding-repo-connect-panel'

export interface CodingRepositoryPanelState {
  isOpen: boolean
  attachedRepoId: number | null
  attachedRepoFullName: string | null
  attachedBranch: string | null
}

const EMPTY_CODING_REPOSITORY_PANEL_STATE: CodingRepositoryPanelState = {
  isOpen: false,
  attachedRepoId: null,
  attachedRepoFullName: null,
  attachedBranch: null,
}

export function parseCodingRepositoryPanelState(value: string | null): CodingRepositoryPanelState {
  if (!value) return EMPTY_CODING_REPOSITORY_PANEL_STATE
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return EMPTY_CODING_REPOSITORY_PANEL_STATE
    return {
      isOpen: parsed.isOpen === true,
      attachedRepoId: typeof parsed.attachedRepoId === 'number' ? parsed.attachedRepoId : null,
      attachedRepoFullName: typeof parsed.attachedRepoFullName === 'string' ? parsed.attachedRepoFullName : null,
      attachedBranch: typeof parsed.attachedBranch === 'string' ? parsed.attachedBranch : null,
    }
  } catch {
    return EMPTY_CODING_REPOSITORY_PANEL_STATE
  }
}

function loadCodingRepositoryPanelState(): CodingRepositoryPanelState {
  if (typeof window === 'undefined') return EMPTY_CODING_REPOSITORY_PANEL_STATE
  try {
    return parseCodingRepositoryPanelState(window.localStorage.getItem(CODING_REPOSITORY_PANEL_STORAGE_KEY))
  } catch {
    return EMPTY_CODING_REPOSITORY_PANEL_STATE
  }
}

export function shouldAutoOpenWorkspace(
  sessionId: string,
  snapshot: Pick<SessionSnapshot, 'events'>,
  manuallyClosedSessionIds: ReadonlySet<string>,
  previewSessionId?: string,
): boolean {
  return previewSessionId !== sessionId
    && !manuallyClosedSessionIds.has(sessionId)
    && snapshot.events.some((event) => event.type === 'turn.started')
}

type PreviewSourceState =
  | { status: 'idle'; content: ''; error: '' }
  | { status: 'loading'; content: ''; error: '' }
  | { status: 'ready'; content: string; error: '' }
  | { status: 'failed'; content: ''; error: string }

export function App() {
  const storedCodingPanel = useMemo(loadCodingRepositoryPanelState, [])
  const [appRoute, setAppRoute] = useState<'agent' | 'leaderboard'>(() => (
    typeof window !== 'undefined' && isAgentLeaderboardPath(window.location.pathname) ? 'leaderboard' : 'agent'
  ))
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [snapshot, setSnapshot] = useState<SessionSnapshot>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [agentModels, setAgentModels] = useState<AgentModelOption[]>([])
  const [creditBalance, setCreditBalance] = useState<CreditBalance>()
  const [modelListUnavailable, setModelListUnavailable] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [leftOpen, setLeftOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget>()
  const [previewMode, setPreviewMode] = useState<'rendered' | 'source'>('rendered')
  const [previewReloadKey, setPreviewReloadKey] = useState(0)
  const [previewSource, setPreviewSource] = useState<PreviewSourceState>({ status: 'idle', content: '', error: '' })
  const [previewFileMenuOpen, setPreviewFileMenuOpen] = useState(false)
  const [previewPickerActive, setPreviewPickerActive] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [connectionsAnchor, setConnectionsAnchor] = useState<PopoverAnchor>({ left: 0, top: 0 })
  const [repositoryPanelOpen, setRepositoryPanelOpen] = useState(storedCodingPanel.isOpen)
  const [githubConnection, setGithubConnection] = useState<GitHubConnectionState>({ status: 'disconnected' })
  const [githubConnectionLoading, setGithubConnectionLoading] = useState(true)
  const [githubConnectionError, setGithubConnectionError] = useState<string>()
  const [githubStatus, setGithubStatus] = useState<GitHubStatusState>()
  const [githubOutageDismissed, setGithubOutageDismissed] = useState(false)
  const [githubConnecting, setGithubConnecting] = useState(false)
  const [githubManaging, setGithubManaging] = useState(false)
  const [githubDisconnecting, setGithubDisconnecting] = useState(false)
  const [repositories, setRepositories] = useState<GitHubRepository[]>([])
  const [repositoriesLoading, setRepositoriesLoading] = useState(false)
  const [repositoriesLoaded, setRepositoriesLoaded] = useState(false)
  const [repositoriesError, setRepositoriesError] = useState<string>()
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(storedCodingPanel.attachedRepoId)
  const [selectedRepoFullName, setSelectedRepoFullName] = useState<string | null>(storedCodingPanel.attachedRepoFullName)
  const [branches, setBranches] = useState<GitHubBranch[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchesError, setBranchesError] = useState<string>()
  const [selectedBranch, setSelectedBranch] = useState<string | null>(storedCodingPanel.attachedBranch)
  const [latestAssistantResponseViewedId, setLatestAssistantResponseViewedId] = useState<string>()
  const [optimisticTaskReview, setOptimisticTaskReview] = useState<{ sessionId: string; messageEventId: string; action: TaskReviewFeedbackAction }>()
  const [optimisticTaskCompletion, setOptimisticTaskCompletion] = useState<{ sessionId: string; messageEventId: string; value: TaskCompletionFeedbackValue }>()
  const [undoOffer, setUndoOffer] = useState<(UndoTurnCandidate & { sessionId: string })>()
  const [optimisticUndo, setOptimisticUndo] = useState<(UndoTurnCandidate & { sessionId: string })>()
  const [savingReviewFeedback, setSavingReviewFeedback] = useState(false)
  const [activeComposerOperation, setActiveComposerOperation] = useState<'submit' | 'undo' | null>(null)
  const [workspacePersistence, setWorkspacePersistence] = useState<WorkspacePersistenceView>()
  const [workspaceInventory, setWorkspaceInventory] = useState<WorkspaceInventoryView>()
  const [thankYouPhase, setThankYouPhase] = useState<'in' | 'out' | null>(null)
  const [composerDraftCommand, setComposerDraftCommand] = useState<ComposerDraftCommand>()
  const [activeCustomFeedback, setActiveCustomFeedback] = useState<{ sessionId: string; messageEventId: string }>()
  const [dismissedCustomFeedback, setDismissedCustomFeedback] = useState<{ sessionId: string; messageEventId: string }>()
  const [conversationAwayFromBottom, setConversationAwayFromBottom] = useState(false)
  const refreshTimer = useRef<number | undefined>(undefined)
  const activeIdRef = useRef<string | undefined>(undefined)
  const workspaceOpenRef = useRef(false)
  const manuallyClosedWorkspaceRef = useRef<Set<string>>(new Set())
  const previewSessionRef = useRef<string | undefined>(undefined)
  const previewRestoreWorkspaceSessionRef = useRef<string | undefined>(undefined)
  const composerDraftRef = useRef<ComposerDraftSnapshot | undefined>(undefined)
  const newChatDraftRef = useRef<ComposerDraftSnapshot>({ sessionId: DRAFT_COMPOSER_SESSION_ID, value: '', attachments: [] })
  const pendingComposerDraftRef = useRef<ComposerDraftSnapshot | undefined>(undefined)
  const composerDraftCommandId = useRef(0)
  const previewIframeRef = useRef<HTMLIFrameElement>(null)
  const conversationScrollRef = useRef<HTMLDivElement>(null)
  const conversationColumnRef = useRef<HTMLDivElement>(null)
  const conversationFollowingRef = useRef(true)
  const conversationHydrationRef = useRef<string | undefined>(undefined)
  const conversationProgrammaticScrollRef = useRef(false)
  const conversationScrollSettleTimerRef = useRef<number | undefined>(undefined)
  const workspacePersistenceTimerRef = useRef<number | undefined>(undefined)
  const workspaceInventoryRef = useRef<WorkspaceInventoryView | undefined>(undefined)
  const workspaceInventoryGenerationRef = useRef(0)

  workspaceInventoryRef.current = workspaceInventory

  const setWorkspaceVisibility = useCallback((visible: boolean) => {
    workspaceOpenRef.current = visible
    setWorkspaceOpen(visible)
  }, [])

  const clearWorkspacePersistenceTimer = useCallback(() => {
    window.clearTimeout(workspacePersistenceTimerRef.current)
    workspacePersistenceTimerRef.current = undefined
  }, [])

  const replaceWorkspaceInventory = useCallback((next: WorkspaceInventoryView | undefined) => {
    workspaceInventoryRef.current = next
    setWorkspaceInventory(next)
  }, [])

  const resetWorkspaceInventory = useCallback((next: SessionSnapshot | undefined) => {
    workspaceInventoryGenerationRef.current += 1
    replaceWorkspaceInventory(next ? workspaceInventoryFromSnapshot(next) : undefined)
  }, [replaceWorkspaceInventory])

  const clearConversationScrollSettleTimer = useCallback(() => {
    window.clearTimeout(conversationScrollSettleTimerRef.current)
    conversationScrollSettleTimerRef.current = undefined
  }, [])

  const updateConversationFollowFromScroll = useCallback(() => {
    const element = conversationScrollRef.current
    if (!element) return
    const nearBottom = isConversationNearBottom(element)
    if (conversationProgrammaticScrollRef.current) {
      if (nearBottom) {
        conversationProgrammaticScrollRef.current = false
        clearConversationScrollSettleTimer()
      }
      conversationFollowingRef.current = true
      setConversationAwayFromBottom(false)
      return
    }
    conversationFollowingRef.current = nearBottom
    setConversationAwayFromBottom(!nearBottom)
  }, [clearConversationScrollSettleTimer])

  const cancelProgrammaticConversationScroll = useCallback(() => {
    conversationProgrammaticScrollRef.current = false
    clearConversationScrollSettleTimer()
  }, [clearConversationScrollSettleTimer])

  const scrollConversationToBottom = useCallback((forceBehavior?: ScrollBehavior) => {
    const element = conversationScrollRef.current
    if (!element) return
    clearConversationScrollSettleTimer()
    conversationFollowingRef.current = true
    conversationProgrammaticScrollRef.current = true
    setConversationAwayFromBottom(false)
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    const behavior = forceBehavior ?? conversationScrollBehavior(reducedMotion)
    element.scrollTo({ top: element.scrollHeight, behavior })
    if (behavior === 'auto') {
      conversationProgrammaticScrollRef.current = false
      updateConversationFollowFromScroll()
      return
    }
    conversationScrollSettleTimerRef.current = window.setTimeout(() => {
      conversationProgrammaticScrollRef.current = false
      conversationScrollSettleTimerRef.current = undefined
      updateConversationFollowFromScroll()
    }, 600)
  }, [clearConversationScrollSettleTimer, updateConversationFollowFromScroll])

  const closePreview = useCallback(() => {
    const sessionId = activeIdRef.current
    const shouldRestoreWorkspace = Boolean(
      sessionId
      && previewRestoreWorkspaceSessionRef.current === sessionId
      && !manuallyClosedWorkspaceRef.current.has(sessionId),
    )
    previewSessionRef.current = undefined
    previewRestoreWorkspaceSessionRef.current = undefined
    setPreviewTarget(undefined)
    setPreviewMode('rendered')
    setPreviewSource({ status: 'idle', content: '', error: '' })
    setPreviewFileMenuOpen(false)
    setPreviewPickerActive(false)
    if (shouldRestoreWorkspace) setWorkspaceVisibility(true)
  }, [setWorkspaceVisibility])

  const openPreview = useCallback((target: PreviewTarget) => {
    const sessionId = activeIdRef.current
    const shouldRestoreWorkspace = Boolean(
      sessionId
      && (workspaceOpenRef.current || previewRestoreWorkspaceSessionRef.current === sessionId)
      && !manuallyClosedWorkspaceRef.current.has(sessionId),
    )
    previewSessionRef.current = sessionId
    previewRestoreWorkspaceSessionRef.current = shouldRestoreWorkspace ? sessionId : undefined
    setWorkspaceVisibility(false)
    setPreviewMode('rendered')
    setPreviewSource({ status: 'idle', content: '', error: '' })
    setPreviewFileMenuOpen(false)
    setPreviewPickerActive(false)
    setPreviewReloadKey((value) => value + 1)
    setPreviewTarget(target)
  }, [setWorkspaceVisibility])

  const applyComposerDraft = useCallback((draft: ComposerDraftSnapshot, focus = false) => {
    const command = { ...draft, attachments: draft.attachments.map((attachment) => ({ ...attachment })), id: ++composerDraftCommandId.current, focus }
    composerDraftRef.current = { ...command, attachments: command.attachments.map((attachment) => ({ ...attachment })) }
    if (command.sessionId === DRAFT_COMPOSER_SESSION_ID) {
      newChatDraftRef.current = { ...command, attachments: command.attachments.map((attachment) => ({ ...attachment })) }
    }
    setComposerDraftCommand(command)
  }, [])

  const recordComposerDraft = useCallback((draft: ComposerDraftSnapshot) => {
    const copy = { ...draft, attachments: draft.attachments.map((attachment) => ({ ...attachment })) }
    composerDraftRef.current = copy
    if (copy.sessionId === DRAFT_COMPOSER_SESSION_ID) newChatDraftRef.current = copy
  }, [])

  useEffect(() => {
    if (!thankYouPhase) return
    const timeout = window.setTimeout(
      () => setThankYouPhase(thankYouPhase === 'in' ? 'out' : null),
      thankYouPhase === 'in' ? 2_000 : 200,
    )
    return () => window.clearTimeout(timeout)
  }, [thankYouPhase])

  useEffect(() => {
    if (
      previewTarget
      && snapshot?.website.status !== 'running'
      && previewTarget.url === snapshot?.website.previewUrl
    ) {
      closePreview()
    }
  }, [closePreview, previewTarget, snapshot?.website.previewUrl, snapshot?.website.status])

  const refreshSessions = useCallback(async () => {
    const next = await api.listSessions()
    setSessions(next)
    return next
  }, [])

  const refreshSnapshot = useCallback(async (id: string, allowRewind = false) => {
    const next = await api.snapshot(id)
    if (activeIdRef.current === id) {
      resetWorkspaceInventory(next)
      setSnapshot((current) => reconcileSnapshot(allowRewind ? undefined : current, next))
      if (shouldAutoOpenWorkspace(id, next, manuallyClosedWorkspaceRef.current, previewSessionRef.current)) {
        setWorkspaceVisibility(true)
      }
    }
    setSessions((current) => [next.session, ...current.filter((session) => session.id !== next.session.id)])
    return next
  }, [resetWorkspaceInventory, setWorkspaceVisibility])

  const loadMoreWorkspaceInventory = useCallback(async () => {
    const current = workspaceInventoryRef.current
    const sessionId = activeIdRef.current
    if (
      !current
      || !sessionId
      || current.sessionId !== sessionId
      || !current.hasMore
      || !current.nextCursor
      || current.status === 'loading'
      || current.status === 'refreshing'
    ) return

    const requestedCursor = current.nextCursor
    const generation = workspaceInventoryGenerationRef.current
    replaceWorkspaceInventory({ ...current, status: 'loading', error: undefined })
    try {
      // The snapshot cursor carries its original bounded page size. Omitting a
      // new limit preserves that cursor contract and prevents size drift.
      const page = await api.workspaceInventory(sessionId, requestedCursor)
      if (workspaceInventoryGenerationRef.current !== generation || activeIdRef.current !== sessionId) return
      const latest = workspaceInventoryRef.current
      if (!latest || latest.sessionId !== sessionId || latest.nextCursor !== requestedCursor) return
      if (page.hasMore && (!page.nextCursor || page.nextCursor === requestedCursor)) {
        throw new Error('Workspace inventory continuation did not advance. Refresh the file list and try again.')
      }
      const entries = mergeWorkspaceInventoryEntries(latest.entries, page.entries)
      replaceWorkspaceInventory({
        sessionId,
        entries,
        hasMore: page.hasMore,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        truncated: page.truncated,
        totalFiles: page.totalFiles,
        ...(page.fileLimitHit === undefined ? {} : { fileLimitHit: page.fileLimitHit }),
        ...(page.entryLimitHit === undefined ? {} : { entryLimitHit: page.entryLimitHit }),
        ...(page.totalFilesIsLowerBound === undefined ? {} : { totalFilesIsLowerBound: page.totalFilesIsLowerBound }),
        // Endpoint metadata counts only records in that response page; the
        // client view tracks everything materialized into the merged tree.
        loadedEntries: countWorkspaceEntries(entries),
        status: 'ready',
      })
    } catch (reason) {
      if (workspaceInventoryGenerationRef.current !== generation || activeIdRef.current !== sessionId) return
      const latest = workspaceInventoryRef.current
      if (!latest || latest.sessionId !== sessionId) return
      replaceWorkspaceInventory({ ...latest, status: 'failed', error: messageOf(reason) })
    }
  }, [replaceWorkspaceInventory])

  const refreshWorkspaceInventory = useCallback(async () => {
    const sessionId = activeIdRef.current
    const current = workspaceInventoryRef.current
    if (!sessionId || !current || current.sessionId !== sessionId || current.status === 'refreshing') return
    const generation = workspaceInventoryGenerationRef.current + 1
    workspaceInventoryGenerationRef.current = generation
    replaceWorkspaceInventory({ ...current, status: 'refreshing', error: undefined })
    try {
      await refreshSnapshot(sessionId)
    } catch (reason) {
      if (workspaceInventoryGenerationRef.current !== generation || activeIdRef.current !== sessionId) return
      const latest = workspaceInventoryRef.current
      if (!latest || latest.sessionId !== sessionId) return
      replaceWorkspaceInventory({ ...latest, status: 'failed', error: messageOf(reason) })
    }
  }, [refreshSnapshot, replaceWorkspaceInventory])

  const refreshCredits = useCallback(async () => {
    const balance = await api.creditBalance()
    setCreditBalance(balance)
    return { balance }
  }, [])

  const activateSession = useCallback((id: string) => {
    const sessionChanged = activeIdRef.current !== id
    activeIdRef.current = id
    if (sessionChanged) {
      previewSessionRef.current = undefined
      previewRestoreWorkspaceSessionRef.current = undefined
      setWorkspaceVisibility(false)
      setSnapshot(undefined)
      setPreviewTarget(undefined)
      setPreviewMode('rendered')
      setPreviewSource({ status: 'idle', content: '', error: '' })
      setConnectionsOpen(false)
    }
    setError(undefined)
    setAppRoute('agent')
    setActiveId(id)
    setLeftOpen(false)
  }, [setWorkspaceVisibility])

  const activateDraft = useCallback((resetDraft = false, focus = false) => {
    activeIdRef.current = undefined
    previewSessionRef.current = undefined
    previewRestoreWorkspaceSessionRef.current = undefined
    setAppRoute('agent')
    setActiveId(undefined)
    setSnapshot(undefined)
    setWorkspaceVisibility(false)
    setPreviewTarget(undefined)
    setPreviewMode('rendered')
    setPreviewSource({ status: 'idle', content: '', error: '' })
    setConnectionsOpen(false)
    setSearchOpen(false)
    setLeftOpen(false)
    setError(undefined)
    if (resetDraft) {
      manuallyClosedWorkspaceRef.current.clear()
      newChatDraftRef.current = { sessionId: DRAFT_COMPOSER_SESSION_ID, value: '', attachments: [] }
    }
    applyComposerDraft(newChatDraftRef.current, focus)
  }, [applyComposerDraft, setWorkspaceVisibility])

  const navigateToSession = useCallback((id: string, replaceHistory = false) => {
    activateSession(id)
    setSearchOpen(false)
    const path = sessionPath(id)
    if (window.location.pathname !== path) {
      window.history[replaceHistory ? 'replaceState' : 'pushState']({}, '', path)
    }
    if (STATIC_SHOWCASE) window.dispatchEvent(new Event(SHOWCASE_NAVIGATION_EVENT))
  }, [activateSession])

  const navigateToDraft = useCallback((replaceHistory = false, resetDraft = false, focus = false) => {
    activateDraft(resetDraft, focus)
    if (!isAgentDraftPath(window.location.pathname)) {
      window.history[replaceHistory ? 'replaceState' : 'pushState']({}, '', AGENT_DRAFT_PATH)
    } else if (window.location.pathname !== AGENT_DRAFT_PATH) {
      window.history.replaceState({}, '', AGENT_DRAFT_PATH)
    }
    if (STATIC_SHOWCASE) window.dispatchEvent(new Event(SHOWCASE_NAVIGATION_EVENT))
  }, [activateDraft])

  const navigateToLeaderboard = useCallback((replaceHistory = false) => {
    activeIdRef.current = undefined
    previewSessionRef.current = undefined
    previewRestoreWorkspaceSessionRef.current = undefined
    setAppRoute('leaderboard')
    setActiveId(undefined)
    setSnapshot(undefined)
    setWorkspaceVisibility(false)
    setPreviewTarget(undefined)
    setPreviewMode('rendered')
    setPreviewSource({ status: 'idle', content: '', error: '' })
    setConnectionsOpen(false)
    setSearchOpen(false)
    setLeftOpen(false)
    setError(undefined)
    if (window.location.pathname !== AGENT_LEADERBOARD_PATH) {
      window.history[replaceHistory ? 'replaceState' : 'pushState']({}, '', AGENT_LEADERBOARD_PATH)
    }
    if (STATIC_SHOWCASE) window.dispatchEvent(new Event(SHOWCASE_NAVIGATION_EVENT))
  }, [setWorkspaceVisibility])

  const navigateToSearch = useCallback((replaceHistory = false, returnPathOverride?: string) => {
    const currentPath = window.location.pathname
    const currentState = (window.history.state ?? {}) as HistorySearchState
    const priorReturnPath = validHistorySearchReturnPath(currentState.aneraSearchReturnPath)
    const returnPath = returnPathOverride
      ?? (isHistorySearchPath(currentPath) ? priorReturnPath : validHistorySearchReturnPath(currentPath))
      ?? (activeIdRef.current ? sessionPath(activeIdRef.current) : AGENT_DRAFT_PATH)
    const state: HistorySearchState = {
      ...currentState,
      aneraSearchOverlay: true,
      aneraSearchOpenedFromApp: isHistorySearchPath(currentPath)
        ? currentState.aneraSearchOpenedFromApp === true
        : !replaceHistory,
      aneraSearchReturnPath: returnPath,
    }
    setLeftOpen(false)
    setSearchOpen(true)
    if (currentPath !== HISTORY_SEARCH_PATH) {
      window.history[replaceHistory ? 'replaceState' : 'pushState'](state, '', HISTORY_SEARCH_PATH)
    } else if (replaceHistory || returnPathOverride) {
      window.history.replaceState(state, '', HISTORY_SEARCH_PATH)
    }
  }, [])

  const hydrateSearchRoute = useCallback((existing: readonly SessionSummary[]) => {
    const state = (window.history.state ?? {}) as HistorySearchState
    const requestedReturnPath = validHistorySearchReturnPath(state.aneraSearchReturnPath)
    if (requestedReturnPath === AGENT_LEADERBOARD_PATH) {
      activeIdRef.current = undefined
      previewSessionRef.current = undefined
      previewRestoreWorkspaceSessionRef.current = undefined
      setAppRoute('leaderboard')
      setActiveId(undefined)
      setSnapshot(undefined)
      setWorkspaceVisibility(false)
      setPreviewTarget(undefined)
      setConnectionsOpen(false)
    } else if (requestedReturnPath === AGENT_DRAFT_PATH) {
      activateDraft()
    } else {
      const requestedSessionId = requestedReturnPath ? sessionIdFromPath(requestedReturnPath) : undefined
      const selected = requestedSessionId
        ? existing.find((session) => session.id === requestedSessionId)
        : existing[0]
      if (selected) activateSession(selected.id)
      else {
        activeIdRef.current = undefined
        setAppRoute('agent')
        setActiveId(undefined)
        setSnapshot(undefined)
      }
    }
    const resolvedReturnPath = requestedReturnPath
      ?? (activeIdRef.current ? sessionPath(activeIdRef.current) : AGENT_DRAFT_PATH)
    navigateToSearch(true, resolvedReturnPath)
  }, [activateDraft, activateSession, navigateToSearch, setWorkspaceVisibility])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    if (!isHistorySearchPath(window.location.pathname)) return
    const state = (window.history.state ?? {}) as HistorySearchState
    if (state.aneraSearchOpenedFromApp === true) {
      window.history.back()
      return
    }
    const returnPath = validHistorySearchReturnPath(state.aneraSearchReturnPath)
    if (returnPath === AGENT_LEADERBOARD_PATH) {
      navigateToLeaderboard(true)
      return
    }
    const returnSessionId = returnPath ? sessionIdFromPath(returnPath) : undefined
    const selected = returnSessionId
      ? sessions.find((session) => session.id === returnSessionId)
      : activeId ? sessions.find((session) => session.id === activeId) : sessions[0]
    if (selected) {
      navigateToSession(selected.id, true)
      return
    }
    navigateToDraft(true)
  }, [activeId, navigateToDraft, navigateToLeaderboard, navigateToSession, sessions])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      navigateToSearch()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigateToSearch])

  useEffect(() => {
    void api.listAgentModels()
      .then((models) => { setAgentModels(models); setModelListUnavailable(false) })
      .catch(() => setModelListUnavailable(true))
  }, [])

  useEffect(() => {
    void refreshCredits().catch(() => undefined)
  }, [refreshCredits])

  useEffect(() => {
    const resetAt = creditBalance?.refreshedAt
    if (!resetAt) return
    const delay = Math.max(1_000, Date.parse(resetAt) - Date.now() + 1_000)
    const timer = window.setTimeout(() => void refreshCredits().catch(() => undefined), Math.min(delay, 2_147_000_000))
    return () => window.clearTimeout(timer)
  }, [creditBalance?.refreshedAt, refreshCredits])

  useEffect(() => {
    try {
      window.localStorage.setItem(CODING_REPOSITORY_PANEL_STORAGE_KEY, JSON.stringify({
        isOpen: repositoryPanelOpen,
        attachedRepoId: selectedRepoId,
        attachedRepoFullName: selectedRepoFullName,
        attachedBranch: selectedBranch,
      } satisfies CodingRepositoryPanelState))
    } catch {
      // The repository controls still work when storage is unavailable.
    }
  }, [repositoryPanelOpen, selectedBranch, selectedRepoFullName, selectedRepoId])

  const refreshGitHubConnection = useCallback(async () => {
    setGithubConnectionLoading(true)
    setGithubConnectionError(undefined)
    try {
      const connection = await api.githubConnection()
      setGithubConnection(connection)
      return connection
    } catch (reason) {
      setGithubConnectionError(codingErrorMessage(reason))
      throw reason
    } finally {
      setGithubConnectionLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshGitHubConnection().catch(() => undefined)
    void api.githubStatus().then(setGithubStatus).catch(() => undefined)
  }, [refreshGitHubConnection])

  const loadRepositories = useCallback(async () => {
    setRepositoriesLoading(true)
    setRepositoriesError(undefined)
    try {
      const all: GitHubRepository[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page += 1) {
        const result = await api.githubRepositories(cursor)
        all.push(...result.repos)
        if (!result.hasNextPage || !result.nextCursor) break
        cursor = result.nextCursor
      }
      setRepositories(uniqueBy(all, (repo) => repo.id))
    } catch (reason) {
      setRepositoriesError(codingErrorMessage(reason))
    } finally {
      setRepositoriesLoaded(true)
      setRepositoriesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (repositoryPanelOpen && githubConnection.status === 'connected' && !repositoriesLoaded && !repositoriesLoading) {
      void loadRepositories()
    }
  }, [githubConnection.status, loadRepositories, repositoriesLoaded, repositoriesLoading, repositoryPanelOpen])

  const selectedRepository = repositories.find((repository) => repository.id === selectedRepoId)

  const selectRepository = useCallback((id: number | null) => {
    setSelectedRepoId(id)
    setSelectedRepoFullName(repositories.find((repository) => repository.id === id)?.fullName ?? null)
    setSelectedBranch(null)
  }, [repositories])

  const loadBranches = useCallback(async (repo: GitHubRepository) => {
    setBranchesLoading(true)
    setBranchesError(undefined)
    setBranches([])
    setSelectedBranch(null)
    try {
      const all: GitHubBranch[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page += 1) {
        const result = await api.githubBranches(repo.id, cursor)
        all.push(...result.branches)
        if (!result.hasNextPage || !result.nextCursor) break
        cursor = result.nextCursor
      }
      const next = uniqueBy(all, (branch) => branch.name)
      setBranches(next)
      setSelectedRepoFullName(repo.fullName)
      setSelectedBranch((current) => {
        if (current && next.some((branch) => branch.name === current)) return current
        return next.some((branch) => branch.name === repo.defaultBranch) ? repo.defaultBranch : null
      })
    } catch (reason) {
      setBranchesError(codingErrorMessage(reason))
    } finally {
      setBranchesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (selectedRepository) void loadBranches(selectedRepository)
    else if (selectedRepoId === null) {
      setBranches([])
      setSelectedBranch(null)
      setBranchesError(undefined)
    }
  }, [loadBranches, selectedRepoId, selectedRepository?.id])

  useEffect(() => {
    void (async () => {
      try {
        const existing = await refreshSessions()
        if (isHistorySearchPath(window.location.pathname)) {
          hydrateSearchRoute(existing)
          return
        }
        if (isAgentLeaderboardPath(window.location.pathname)) {
          navigateToLeaderboard(true)
          return
        }
        if (isAgentDraftPath(window.location.pathname) || window.location.pathname === '/') {
          navigateToDraft(true)
          return
        }
        const requested = sessionIdFromPath(window.location.pathname)
        const selected = requested ? existing.find((session) => session.id === requested) : undefined
        if (selected) navigateToSession(selected.id, true)
        else navigateToDraft(true)
      } catch (reason) {
        setError(messageOf(reason))
      } finally {
        setLoading(false)
      }
    })()
  }, [hydrateSearchRoute, navigateToDraft, navigateToLeaderboard, navigateToSession, refreshSessions])

  useEffect(() => {
    const onPopState = () => {
      void (async () => {
        try {
          const existing = await refreshSessions()
          if (isHistorySearchPath(window.location.pathname)) {
            hydrateSearchRoute(existing)
            return
          }
          if (isAgentLeaderboardPath(window.location.pathname)) {
            navigateToLeaderboard(true)
            return
          }
          if (isAgentDraftPath(window.location.pathname) || window.location.pathname === '/') {
            navigateToDraft(true)
            return
          }
          const requested = sessionIdFromPath(window.location.pathname)
          const selected = requested ? existing.find((session) => session.id === requested) : undefined
          if (selected) {
            navigateToSession(selected.id)
          } else navigateToDraft(true)
        } catch (reason) {
          setError(messageOf(reason))
        }
      })()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [hydrateSearchRoute, navigateToDraft, navigateToLeaderboard, navigateToSession, refreshSessions])

  useEffect(() => {
    if (!activeId) return
    setSnapshot(undefined)
    resetWorkspaceInventory(undefined)
    setWorkspacePersistence(undefined)
    clearWorkspacePersistenceTimer()
    let source: EventSource | undefined
    let disposed = false
    void (async () => {
      let afterSeq = 0
      try {
        const initial = await refreshSnapshot(activeId)
        afterSeq = initial.events.reduce((maximum, event) => Math.max(maximum, event.seq), 0)
      } catch (reason) {
        if (!disposed) setError(messageOf(reason))
      }
      if (disposed) return
      if (STATIC_SHOWCASE) return
      // Starting after the hydrated high-water mark is important: durable old
      // save events remain auditable without replaying a fake animation every
      // time a completed conversation is opened or refreshed.
      source = new EventSource(`/api/sessions/${activeId}/events?after=${afterSeq}`)
      source.addEventListener('session-event', (message) => {
        const event = JSON.parse((message as MessageEvent).data) as SessionEvent
        setSnapshot((current) => current && current.session.id === activeId
          ? applyEventToSnapshot(current, event)
          : current)
        const persistence = workspacePersistenceFromEvent(event)
        if (persistence) {
          clearWorkspacePersistenceTimer()
          setWorkspacePersistence(persistence)
          if (persistence.phase === 'saved') {
            workspacePersistenceTimerRef.current = window.setTimeout(() => {
              setWorkspacePersistence((current) => current?.eventId === persistence.eventId ? undefined : current)
              workspacePersistenceTimerRef.current = undefined
            }, 650)
          }
        }
        if (
          event.type === 'turn.started'
          && !manuallyClosedWorkspaceRef.current.has(activeId)
          && previewSessionRef.current !== activeId
        ) {
          setWorkspaceVisibility(true)
        }
        if (event.type === 'file.presented') {
          const artifact = (event.data as { artifact?: ArtifactRecord }).artifact
          if (artifact?.previewUrl) openPreview({
            url: artifact.previewUrl,
            label: artifact.path,
            downloadUrl: artifact.downloadUrl,
            kind: artifact.kind,
            mime: artifact.mime,
          })
        }
        if (event.type === 'usage.updated') void refreshCredits().catch(() => undefined)
        if (['file.changed', 'artifact.created', 'process.started', 'process.updated', 'process.stopped', 'website.updated', 'deployment.updated', 'run.status', 'session.limit.reached', 'workspace.persistence.completed'].includes(event.type)) {
          window.clearTimeout(refreshTimer.current)
          refreshTimer.current = window.setTimeout(() => {
            void refreshSnapshot(activeId).catch((reason) => setError(messageOf(reason)))
          }, 120)
        }
      })
      source.onerror = () => {
        // EventSource reconnects and replays from Last-Event-ID automatically.
      }
    })()
    return () => {
      disposed = true
      source?.close()
      window.clearTimeout(refreshTimer.current)
      clearWorkspacePersistenceTimer()
    }
  }, [activeId, clearWorkspacePersistenceTimer, openPreview, refreshCredits, refreshSnapshot, resetWorkspaceInventory, setWorkspaceVisibility])

  useEffect(() => {
    if (!STATIC_SHOWCASE || !activeId) return
    // Live snapshots must never move backwards, but a static replay
    // intentionally replaces the complete trace with an earlier checkpoint.
    const refreshReplay = () => void refreshSnapshot(activeId, true).catch((reason) => setError(messageOf(reason)))
    window.addEventListener(SHOWCASE_REPLAY_EVENT, refreshReplay)
    return () => window.removeEventListener(SHOWCASE_REPLAY_EVENT, refreshReplay)
  }, [activeId, refreshSnapshot])

  useEffect(() => {
    document.title = searchOpen
      ? 'Search conversations | Anera'
      : appRoute === 'leaderboard'
      ? 'Anera Agent Leaderboard'
      : snapshot ? `${snapshot.session.title} | Anera Agent Mode` : 'Anera Agent Mode'
  }, [appRoute, searchOpen, snapshot])

  useEffect(() => {
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-anera-brand]')
    if (!icon) {
      icon = document.createElement('link')
      icon.rel = 'icon'
      icon.dataset.aneraBrand = 'true'
      document.head.append(icon)
    }
    icon.href = aneraLogoUrl
  }, [])

  const activePreviewRenderer = previewTarget ? previewRenderer(previewTarget) : undefined
  const workspaceVisible = workspaceOpen && !previewTarget
  const visibleWorkspaceInventory = useMemo(() => {
    if (!snapshot) return undefined
    return workspaceInventory?.sessionId === snapshot.session.id
      ? workspaceInventory
      : workspaceInventoryFromSnapshot(snapshot)
  }, [snapshot, workspaceInventory])
  const previewNeedsText = previewMode === 'source'
    || activePreviewRenderer === 'markdown'
    || activePreviewRenderer === 'text'

  useEffect(() => {
    if (!previewTarget || !previewNeedsText) {
      setPreviewSource({ status: 'idle', content: '', error: '' })
      return
    }
    const controller = new AbortController()
    setPreviewSource({ status: 'loading', content: '', error: '' })
    void fetch(previewTarget.downloadUrl || previewTarget.url, {
      credentials: 'same-origin',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Source request failed (${response.status})`)
      const content = await response.text()
      if (!controller.signal.aborted) setPreviewSource({ status: 'ready', content, error: '' })
    }).catch((reason) => {
      if (!controller.signal.aborted) setPreviewSource({ status: 'failed', content: '', error: messageOf(reason) })
    })
    return () => controller.abort()
  }, [previewNeedsText, previewMode, previewReloadKey, previewTarget])

  const running = snapshot?.session.status === 'running' || snapshot?.session.status === 'cancelling' || snapshot?.session.status === 'awaiting_approval'
  const tokenLimit = snapshot?.session.limits?.sessionTokens
  const resumable = snapshot ? !tokenLimit?.reached && ['cancelled', 'failed', 'timed_out', 'interrupted'].includes(snapshot.session.status) : false
  const optimisticUndoneTurnIds = useMemo(() => new Set(
    optimisticUndo && optimisticUndo.sessionId === activeId ? optimisticUndo.targetTurnIds : [],
  ), [activeId, optimisticUndo])
  const timeline = useMemo(
    () => projectTimeline(snapshot, optimisticUndoneTurnIds),
    [optimisticUndoneTurnIds, snapshot],
  )
  const workspaceWriteDrafts = useMemo(() => workspaceWriteDraftsFromTimeline(timeline), [timeline])
  const terminalFeedback = useMemo(() => resolveTerminalFeedback(snapshot, timeline), [snapshot, timeline])
  const taskReview = terminalFeedback?.variant === 'check_in' ? terminalFeedback : undefined
  const taskCompletion = terminalFeedback?.variant === 'task_completion_bar' ? terminalFeedback : undefined
  const taskReviewOptimistic = optimisticTaskReview !== undefined
    && optimisticTaskReview.sessionId === activeId
    && optimisticTaskReview.messageEventId === taskReview?.messageEventId
  const taskReviewVisible = Boolean(taskReview && !taskReviewOptimistic)
  const taskCompletionOptimistic = optimisticTaskCompletion !== undefined
    && optimisticTaskCompletion.sessionId === activeId
    && optimisticTaskCompletion.messageEventId === taskCompletion?.messageEventId
  const taskCompletionVisible = Boolean(
    taskCompletion
    && taskCompletion.messageEventId === latestAssistantResponseViewedId
    && !taskCompletionOptimistic
  )
  const customFeedbackOffer = useMemo(() => resolveCustomFeedbackOffer(snapshot), [snapshot])
  const activeCustomFeedbackTarget = activeCustomFeedback && activeCustomFeedback.sessionId === activeId
    ? activeCustomFeedback.messageEventId
    : undefined
  const customFeedbackCalloutVisible = Boolean(
    customFeedbackOffer?.arm === 'treatment-2'
    && !activeCustomFeedbackTarget
    && customFeedbackOffer
    && !(dismissedCustomFeedback && dismissedCustomFeedback.sessionId === activeId
      && dismissedCustomFeedback.messageEventId === customFeedbackOffer.messageEventId),
  )
  const emptySession = !loading && timeline.length === 0

  useLayoutEffect(() => {
    clearConversationScrollSettleTimer()
    conversationProgrammaticScrollRef.current = false
    conversationFollowingRef.current = true
    conversationHydrationRef.current = activeId
    setConversationAwayFromBottom(false)
    if (!activeId && conversationScrollRef.current) conversationScrollRef.current.scrollTop = 0
  }, [activeId, clearConversationScrollSettleTimer])

  useLayoutEffect(() => {
    const element = conversationScrollRef.current
    if (!element || !activeId || snapshot?.session.id !== activeId) return
    const hydrating = conversationHydrationRef.current === activeId
    if (hydrating || conversationFollowingRef.current) {
      element.scrollTop = element.scrollHeight
      conversationFollowingRef.current = true
      setConversationAwayFromBottom(false)
      if (hydrating) conversationHydrationRef.current = undefined
      return
    }
    updateConversationFollowFromScroll()
  }, [activeId, snapshot?.session.id, timeline, updateConversationFollowFromScroll])

  useEffect(() => {
    const scroll = conversationScrollRef.current
    const column = conversationColumnRef.current
    if (!scroll || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (conversationFollowingRef.current) {
        scroll.scrollTop = scroll.scrollHeight
        setConversationAwayFromBottom(false)
        return
      }
      updateConversationFollowFromScroll()
    })
    observer.observe(scroll)
    if (column) observer.observe(column)
    return () => observer.disconnect()
  }, [activeId, updateConversationFollowFromScroll])

  useEffect(() => () => clearConversationScrollSettleTimer(), [clearConversationScrollSettleTimer])

  const previewChoices = useMemo(() => {
    if (!previewTarget) return []
    const currentLabel = previewTarget.label || 'index.html'
    const choices: PreviewTarget[] = [{ ...previewTarget, label: currentLabel }]
    if (!activeId || !snapshot || previewRenderer(previewTarget) !== 'html') return choices
    for (const path of collectWebsiteEntries(visibleWorkspaceInventory?.entries ?? snapshot.workspace)) {
      if (path === currentLabel) continue
      choices.push({
        label: path,
        url: path === snapshot.website.entryPath && snapshot.website.previewUrl
          ? snapshot.website.previewUrl
          : workspacePreviewUrl(activeId, path),
        downloadUrl: workspaceFileUrl(activeId, path),
        kind: 'website',
        mime: 'text/html',
      })
    }
    return choices
  }, [activeId, previewTarget, snapshot, visibleWorkspaceInventory])
  const previewPickerSupported = Boolean(
    previewTarget
    && activePreviewRenderer === 'html'
    && previewTarget.url.startsWith('/workspace/'),
  )
  const previewFrameUrl = previewTarget && activePreviewRenderer === 'html'
    ? workspacePreviewPickerUrl(previewTarget.url)
    : previewTarget?.url

  useEffect(() => {
    if (previewTarget) return
    setPreviewFileMenuOpen(false)
    setPreviewPickerActive(false)
  }, [previewTarget])

  useEffect(() => {
    if (previewPickerSupported && previewMode === 'rendered') return
    setPreviewPickerActive(false)
  }, [previewMode, previewPickerSupported])

  useEffect(() => {
    const frameWindow = previewIframeRef.current?.contentWindow
    if (!frameWindow || !previewPickerSupported || previewMode !== 'rendered') return
    frameWindow.postMessage({ type: 'anera.element-picker.toggle', active: previewPickerActive }, '*')
  }, [previewPickerActive, previewPickerSupported, previewMode, previewReloadKey, previewTarget?.url])

  useEffect(() => {
    if (!previewPickerSupported || previewMode !== 'rendered') return
    const onMessage = (event: MessageEvent) => {
      if (event.source !== previewIframeRef.current?.contentWindow) return
      const message = parsePreviewElementPickerMessage(event.data)
      if (!message) return
      if (message.type === 'ready') {
        previewIframeRef.current?.contentWindow?.postMessage({ type: 'anera.element-picker.toggle', active: previewPickerActive }, '*')
        return
      }
      if (message.type === 'cancelled') {
        setPreviewPickerActive(false)
        return
      }
      setPreviewPickerActive(false)
      const sessionId = activeId ?? DRAFT_COMPOSER_SESSION_ID
      const current = composerDraftRef.current?.sessionId === sessionId
        ? composerDraftRef.current
        : { sessionId, value: '', attachments: [] }
      const reference = previewElementReference({ ...message.selection, file: previewTarget?.label || 'index.html' })
      applyComposerDraft({
        sessionId,
        value: `${current.value}${current.value.trim() ? '\n' : ''}${reference}`,
        attachments: current.attachments.map((attachment) => ({ ...attachment })),
      }, true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [activeId, applyComposerDraft, previewPickerActive, previewPickerSupported, previewMode, previewTarget?.label])

  useEffect(() => {
    if (!previewFileMenuOpen && !previewPickerActive) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setPreviewFileMenuOpen(false)
      setPreviewPickerActive(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewFileMenuOpen, previewPickerActive])

  useEffect(() => {
    const pendingDraft = pendingComposerDraftRef.current
    const pendingForActiveRoute = pendingDraft?.sessionId === (activeId ?? DRAFT_COMPOSER_SESSION_ID)
    setLatestAssistantResponseViewedId(undefined)
    setOptimisticTaskReview(undefined)
    setOptimisticTaskCompletion(undefined)
    setUndoOffer(undefined)
    setOptimisticUndo(undefined)
    setSavingReviewFeedback(false)
    if (!pendingForActiveRoute) setActiveComposerOperation(null)
    setThankYouPhase(null)
    setActiveCustomFeedback(undefined)
    setDismissedCustomFeedback(undefined)
    if (pendingForActiveRoute && pendingDraft) {
      pendingComposerDraftRef.current = undefined
      applyComposerDraft(pendingDraft)
    } else if (!activeId) {
      applyComposerDraft(newChatDraftRef.current)
    } else {
      setComposerDraftCommand(undefined)
      composerDraftRef.current = undefined
    }
  }, [activeId, applyComposerDraft])

  useEffect(() => {
    if (!activeCustomFeedback || activeCustomFeedback.sessionId !== activeId) return
    if (customFeedbackOffer?.messageEventId === activeCustomFeedback.messageEventId) return
    setActiveCustomFeedback(undefined)
  }, [activeCustomFeedback, activeId, customFeedbackOffer?.messageEventId])

  const activateCustomFeedback = useCallback((messageEventId: string) => {
    if (!activeId) return
    setDismissedCustomFeedback(undefined)
    setActiveCustomFeedback({ sessionId: activeId, messageEventId })
    const currentDraft = composerDraftRef.current?.sessionId === activeId
      ? composerDraftRef.current
      : { sessionId: activeId, value: '', attachments: [] }
    applyComposerDraft(currentDraft, true)
  }, [activeId, applyComposerDraft])

  useEffect(() => {
    if (!taskCompletion?.messageEventId) return
    const selector = `[data-assistant-response-id="${CSS.escape(taskCompletion.messageEventId)}"]`
    const target = document.querySelector<HTMLElement>(selector)
    const root = document.querySelector<HTMLElement>('.conversation-scroll')
    if (!target || !root) return
    if (typeof IntersectionObserver === 'undefined') {
      setLatestAssistantResponseViewedId(taskCompletion.messageEventId)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setLatestAssistantResponseViewedId(taskCompletion.messageEventId)
      observer.disconnect()
    }, { root, threshold: 0.1 })
    observer.observe(target)
    return () => observer.disconnect()
  }, [taskCompletion?.messageEventId])

  return (
    <div className={`app-shell ${appRoute === 'leaderboard' ? 'leaderboard-route' : ''} ${appRoute === 'agent' && workspaceVisible && activeId ? 'workspace-open' : ''} ${appRoute === 'agent' && previewTarget && activeId ? 'preview-open' : ''} ${appRoute === 'agent' && emptySession ? 'empty-session' : ''}`}>
      <button className="mobile-rail-button" aria-label="Open conversations" onClick={() => setLeftOpen(true)}><Menu size={18} /></button>
      <aside className={`left-rail ${leftOpen ? 'is-open' : ''}`}>
        <div className="brand-row">
          <img className="brand-logo" src={aneraLogoUrl} alt="" aria-hidden="true" />
          <span className="brand-name">Anera</span>
          <button className="mobile-close" aria-label="Close conversations" onClick={() => setLeftOpen(false)}><X size={17} /></button>
        </div>
        <button
          className="new-chat"
          disabled={STATIC_SHOWCASE}
          title={STATIC_SHOWCASE ? 'New tasks are disabled in this static replay' : undefined}
          onClick={() => navigateToDraft(false, true, true)}
        ><Plus size={16} /> New Chat</button>
        <nav className="rail-links" aria-label="Primary">
          <button
            className={appRoute === 'leaderboard' ? 'active' : ''}
            aria-current={appRoute === 'leaderboard' ? 'page' : undefined}
            onClick={() => navigateToLeaderboard()}
          ><Sparkles size={15} /> Leaderboard</button>
          <button
            className={searchOpen ? 'active' : ''}
            aria-current={searchOpen ? 'page' : undefined}
            aria-haspopup="dialog"
            aria-expanded={searchOpen}
            title="Search conversations (⌘K)"
            onClick={() => navigateToSearch()}
          ><Search size={15} /> Search</button>
        </nav>
        <div className="history-list">
          {groupHistorySessions(sessions).map((group) => (
            <section className="history-group" key={group.label}>
              <div className="history-label">{group.label}</div>
              {group.sessions.map((session) => (
                <button
                  key={session.id}
                  className={appRoute === 'agent' && session.id === activeId ? 'active' : ''}
                  onClick={() => navigateToSession(session.id)}
                >
                  <Sparkles className="history-agent-icon" size={11} aria-hidden="true" />
                  <span>{session.title}</span>
                  {session.productMode === 'coding' && <Code2 className="history-code" size={11} aria-label="Coding session" />}
                  {session.status === 'running' && <span className="live-dot" />}
                </button>
              ))}
            </section>
          ))}
        </div>
        <div className="rail-foot"><span className="avatar">A</span><span>Local workspace</span><ChevronRight size={14} /></div>
      </aside>

      {searchOpen && (
        <ConversationSearch
          sessions={sessions}
          activeId={activeId}
          onClose={closeSearch}
          onSelect={(sessionId) => navigateToSession(sessionId)}
        />
      )}

      <main className="main-stage">
        {appRoute === 'leaderboard'
          ? <AgentLeaderboard onTryAgent={() => navigateToDraft()} />
          : <>
        <header className="stage-header">
          <button className="mode-picker"><Sparkles size={14} /> Agent Mode <ChevronDown size={14} /></button>
          <div className="stage-actions">
            {snapshot?.repository && <span className="header-repository"><Github size={12} />{snapshot.repository.fullName}<GitBranch size={11} />{snapshot.repository.baseBranch}</span>}
            <span className="model-label">{snapshot?.session.model || 'DeepSeek'}</span>
            {!workspaceVisible && <button
              className={`workspace-toggle ${workspaceVisible ? 'active' : ''}`}
              aria-label="Toggle workspace sidebar"
              aria-pressed={workspaceVisible}
              title="Open workspace"
              onClick={() => {
                if (activeId) manuallyClosedWorkspaceRef.current.delete(activeId)
                closePreview()
                setWorkspaceVisibility(true)
              }}>
              <Folder size={16} />
            </button>}
          </div>
        </header>

        <div className="conversation-viewport">
          <div
            ref={conversationScrollRef}
            className="conversation-scroll"
            onScroll={updateConversationFollowFromScroll}
            onPointerDown={cancelProgrammaticConversationScroll}
            onWheel={cancelProgrammaticConversationScroll}
            onTouchStart={cancelProgrammaticConversationScroll}
            onKeyDown={(event) => {
              if (['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '].includes(event.key)) {
                cancelProgrammaticConversationScroll()
              }
            }}
          >
            {loading && <div className="center-state"><LoaderCircle className="spin" size={22} /> Loading workspace</div>}
            {!loading && timeline.length === 0 && <EmptyConversation />}
            <div ref={conversationColumnRef} className="conversation-column">
              {timeline.map((item) => (
                <Timeline
                  key={item.key}
                  item={item}
                  sessionId={activeId || ''}
                  onPreview={(artifact) => {
                    if (artifact.previewUrl) openPreview({
                      url: artifact.previewUrl,
                      label: artifact.path,
                      downloadUrl: artifact.downloadUrl,
                      kind: artifact.kind,
                      mime: artifact.mime,
                    })
                  }}
                  onApproval={async (approvalId, approved) => {
                    if (!activeId) return
                    try { await api.resolveApproval(activeId, approvalId, approved) }
                    catch (reason) { setError(messageOf(reason)); throw reason }
                  }}
                  onHitl={async (hitlId, response) => {
                    if (!activeId) return
                    try { await api.resolveHitl(activeId, hitlId, response) }
                    catch (reason) { setError(messageOf(reason)); throw reason }
                  }}
                  onGiveFeedback={customFeedbackOffer?.arm === 'treatment-1'
                    && item.kind === 'final'
                    && item.messageEventId === customFeedbackOffer.messageEventId
                    ? () => activateCustomFeedback(customFeedbackOffer.messageEventId)
                    : undefined}
                />
              ))}
              {error && <div className="inline-error">{error}<button onClick={() => setError(undefined)}><X size={13} /></button></div>}
            </div>
          </div>
          {conversationAwayFromBottom && timeline.length > 0 && <button
            type="button"
            className="scroll-to-bottom"
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
            onClick={() => scrollConversationToBottom()}
          ><ArrowDown size={14} aria-hidden="true" /></button>}
        </div>

        {activeId && taskReviewVisible && taskReview && (
          <TaskReviewPanel
            messageEventId={taskReview.messageEventId}
            readOnly={STATIC_SHOWCASE}
            onAction={async (messageEventId, action) => {
              const undoCandidate = action === 'disapprove'
                ? resolveUndoTurnCandidate(snapshot, messageEventId)
                : undefined
              setOptimisticTaskReview({ sessionId: activeId, messageEventId, action })
              setSavingReviewFeedback(true)
              try {
                const settled = await api.checkInFeedback(activeId, messageEventId, action)
                await refreshSnapshot(activeId)
                if (activeIdRef.current === activeId) {
                  setUndoOffer(settled.action === 'disapprove' && undoCandidate
                    ? { ...undoCandidate, sessionId: activeId }
                    : undefined)
                }
              } catch (reason) {
                setOptimisticTaskReview((current) => current?.sessionId === activeId && current.messageEventId === messageEventId ? undefined : current)
                setError(messageOf(reason))
              } finally {
                if (activeIdRef.current === activeId) setSavingReviewFeedback(false)
              }
            }}
          />
        )}

        {!taskReviewVisible && (
          <div className="composer-stack">
            {activeId && workspacePersistence && <WorkspacePersistenceStatus status={workspacePersistence} />}
            {savingReviewFeedback && <ComposerOperationStatus>Saving feedback...</ComposerOperationStatus>}
            {activeComposerOperation === 'undo' && <ComposerOperationStatus>Undoing last turn...</ComposerOperationStatus>}
            {activeComposerOperation === 'submit' && <ComposerOperationStatus>Preparing message...</ComposerOperationStatus>}
            {activeId && undoOffer?.sessionId === activeId && activeComposerOperation !== 'undo' && (
              <UndoTurnCallout
                disabled={Boolean(activeComposerOperation)}
                onDismiss={() => setUndoOffer(undefined)}
                onUndo={async () => {
                  if (activeComposerOperation || !undoOffer) return
                  const offer = undoOffer
                  const previousDraft = composerDraftRef.current?.sessionId === activeId
                    ? composerDraftRef.current
                    : { sessionId: activeId, value: '', attachments: [] }
                  const optimisticDraft: ComposerDraftSnapshot = {
                    sessionId: activeId,
                    value: offer.promptText,
                    attachments: [],
                  }
                  setError(undefined)
                  setUndoOffer(undefined)
                  setOptimisticUndo(offer)
                  setActiveComposerOperation('undo')
                  applyComposerDraft(optimisticDraft, true)
                  try {
                    await api.undoTurn(activeId, offer.sessionNodeId)
                    await refreshSnapshot(activeId)
                    if (activeIdRef.current === activeId) setOptimisticUndo(undefined)
                  } catch {
                    if (activeIdRef.current === activeId) {
                      const currentDraft = composerDraftRef.current
                      const stillOptimistic = currentDraft?.sessionId === activeId
                        && currentDraft.value === optimisticDraft.value
                        && currentDraft.attachments.length === 0
                      setOptimisticUndo(undefined)
                      setUndoOffer(offer)
                      if (stillOptimistic) applyComposerDraft(previousDraft, true)
                      setError('Failed to undo message')
                    }
                  } finally {
                    if (activeIdRef.current === activeId) setActiveComposerOperation(null)
                  }
                }}
              />
            )}
            {activeId && taskCompletionVisible && taskCompletion && (
              <TaskCompletionBar
                messageEventId={taskCompletion.messageEventId}
                disabled={Boolean(activeComposerOperation)}
                onFeedback={async (messageEventId, value) => {
                  setOptimisticTaskCompletion({ sessionId: activeId, messageEventId, value })
                  setThankYouPhase(snapshot?.session.customFeedbackArm === 'treatment-2' ? null : 'in')
                  try {
                    await api.taskCompletionFeedback(activeId, messageEventId, value)
                    await refreshSnapshot(activeId)
                  } catch (reason) {
                    setOptimisticTaskCompletion((current) => current?.sessionId === activeId && current.messageEventId === messageEventId ? undefined : current)
                    setThankYouPhase(null)
                    setError(messageOf(reason))
                  }
                }}
              />
            )}
            {activeId && thankYouPhase && <ThankYouFeedback phase={thankYouPhase} />}
            {activeId && customFeedbackCalloutVisible && customFeedbackOffer && (
              <CustomFeedbackCallout
                onGiveFeedback={() => activateCustomFeedback(customFeedbackOffer.messageEventId)}
                onDismiss={() => setDismissedCustomFeedback({ sessionId: activeId, messageEventId: customFeedbackOffer.messageEventId })}
              />
            )}
            <Composer
            key={activeId ?? DRAFT_COMPOSER_SESSION_ID}
            sessionId={activeId ?? DRAFT_COMPOSER_SESSION_ID}
            draftCommand={composerDraftCommand?.sessionId === (activeId ?? DRAFT_COMPOSER_SESSION_ID) ? composerDraftCommand : undefined}
            reviewedNodeId={activeCustomFeedbackTarget}
            onRemoveCustomFeedback={() => setActiveCustomFeedback(undefined)}
            readOnly={STATIC_SHOWCASE}
            submitDisabled={Boolean(STATIC_SHOWCASE || (activeId && undoOffer?.sessionId === activeId) || activeComposerOperation)}
            onDraftStateChange={recordComposerDraft}
            running={Boolean(running)}
            resumable={resumable}
            tokenLimit={tokenLimit}
            creditBalance={creditBalance}
            isFreeSession={snapshot?.session.isFreeSession === true}
            models={agentModels}
            modelListUnavailable={modelListUnavailable}
            modelSelection={snapshot?.session.modelSelection ?? null}
            codingMode={Boolean(snapshot?.repository || repositoryPanelOpen)}
            connectionsOpen={connectionsOpen}
            connectionsEnabled={githubConnection.status === 'connected' && repositoryPanelOpen}
            repositoryControl={snapshot?.repository
              ? <PinnedRepository repository={snapshot.repository} />
              : repositoryPanelOpen
                ? <RepositoryControls
                    connection={githubConnection}
                    connectionLoading={githubConnectionLoading}
                    connectionError={githubConnectionError}
                    onRetryConnection={() => void refreshGitHubConnection().catch(() => undefined)}
                    repositories={repositories}
                    repositoriesLoading={repositoriesLoading}
                    repositoriesLoaded={repositoriesLoaded}
                    repositoriesError={repositoriesError}
                    selectedRepoId={selectedRepoId}
                    selectedRepoFullName={selectedRepoFullName}
                    onSelectRepository={selectRepository}
                    onRetryRepositories={() => void loadRepositories()}
                    branches={branches}
                    branchesLoading={branchesLoading}
                    branchesError={branchesError}
                    selectedBranch={selectedBranch}
                    onSelectBranch={setSelectedBranch}
                    onRetryBranches={() => selectedRepository && void loadBranches(selectedRepository)}
                    managing={githubManaging}
                    onManageRepositories={async () => {
                      setGithubManaging(true)
                      try {
                        await connectGitHubPopup('/api/coding/github/connect/install')
                        await refreshGitHubConnection()
                        setRepositoriesLoaded(false)
                      } catch (reason) {
                        setError(codingErrorMessage(reason))
                      } finally {
                        setGithubManaging(false)
                      }
                    }}
                    disconnecting={githubDisconnecting}
                    outageStatus={!githubOutageDismissed ? githubStatus : undefined}
                    onDismissOutage={() => setGithubOutageDismissed(true)}
                    onDisconnect={async () => {
                      setGithubDisconnecting(true)
                      try {
                        await api.disconnectGitHub()
                        setRepositories([])
                        setRepositoriesLoaded(false)
                        setBranches([])
                        setSelectedRepoId(null)
                        setSelectedRepoFullName(null)
                        setSelectedBranch(null)
                        setRepositoryPanelOpen(false)
                        await refreshGitHubConnection()
                      } catch (reason) {
                        setError(codingErrorMessage(reason))
                      } finally {
                        setGithubDisconnecting(false)
                      }
                    }}
                  />
                : undefined}
            onError={(reason) => setError(messageOf(reason))}
            onConnections={(anchor) => {
              setConnectionsAnchor(anchor)
              setConnectionsOpen((value) => !value)
            }}
            onSend={async (content, attachments, model, reviewedNodeId) => {
              setError(undefined)
              setUndoOffer(undefined)
              setThankYouPhase(null)
              setActiveComposerOperation('submit')
              let targetSessionId = activeId
              let stagedAttachments = attachments.map((attachment) => ({ ...attachment }))
              const restoreTargetDraft = (focus = false) => {
                if (!targetSessionId) return
                const draft: ComposerDraftSnapshot = {
                  sessionId: targetSessionId,
                  value: content,
                  attachments: stagedAttachments.map((attachment) => ({ ...attachment })),
                }
                if (pendingComposerDraftRef.current?.sessionId === targetSessionId) {
                  pendingComposerDraftRef.current = draft
                }
                if (activeIdRef.current === targetSessionId) applyComposerDraft(draft, focus)
              }
              try {
                if (!snapshot?.repository && repositoryPanelOpen && githubConnection.status === 'connected') {
                  if (!selectedRepository) throw new Error('Invalid repository selection.')
                  if (!selectedBranch) throw new Error('Select a branch before starting a coding session.')
                  const sessionId = await api.createCodingSession({
                    repoId: selectedRepository.id,
                    repoOwner: selectedRepository.ownerLogin,
                    repoName: selectedRepository.name,
                    baseBranch: selectedBranch,
                    message: content,
                  })
                  if (!activeId) newChatDraftRef.current = { sessionId: DRAFT_COMPOSER_SESSION_ID, value: '', attachments: [] }
                  setSessions(await api.listSessions())
                  navigateToSession(sessionId)
                } else {
                  if (!targetSessionId) {
                    stagedAttachments = await materializeComposerAttachments(
                      stagedAttachments,
                      (file) => api.uploadAgentFile(file),
                      (next) => {
                        stagedAttachments = next
                      },
                    )
                    targetSessionId = await api.createAgentChat(
                      content,
                      stagedAttachments.map(({ path, name, mime, url }) => ({ path, name, mime, url })),
                      model,
                      githubConnection.status === 'connected' && repositoryPanelOpen ? ['github'] : [],
                    )
                    const migratedDraft: ComposerDraftSnapshot = {
                      sessionId: targetSessionId,
                      value: content,
                      attachments: stagedAttachments.map((attachment) => ({ ...attachment })),
                    }
                    pendingComposerDraftRef.current = migratedDraft
                    newChatDraftRef.current = { sessionId: DRAFT_COMPOSER_SESSION_ID, value: '', attachments: [] }
                    setSessions(await api.listSessions())
                    navigateToSession(targetSessionId)
                  } else {
                    stagedAttachments = await materializeComposerAttachments(
                      stagedAttachments,
                      (file) => api.upload(targetSessionId!, file),
                      (next) => {
                        stagedAttachments = next
                        restoreTargetDraft()
                      },
                    )
                    await api.send(
                      targetSessionId,
                      content,
                      stagedAttachments.map(({ path, name, mime }) => ({ path, name, mime })),
                      model,
                      githubConnection.status === 'connected' && repositoryPanelOpen ? ['github'] : [],
                      reviewedNodeId,
                    )
                  }
                  const clearedDraft: ComposerDraftSnapshot = { sessionId: targetSessionId, value: '', attachments: [] }
                  if (pendingComposerDraftRef.current?.sessionId === targetSessionId) pendingComposerDraftRef.current = clearedDraft
                  if (activeIdRef.current === targetSessionId) applyComposerDraft(clearedDraft)
                  if (reviewedNodeId && activeIdRef.current === targetSessionId) {
                    setActiveCustomFeedback(undefined)
                    setDismissedCustomFeedback({ sessionId: targetSessionId, messageEventId: reviewedNodeId })
                  }
                }
              }
              catch (reason) {
                restoreTargetDraft(true)
                void refreshCredits().catch(() => undefined)
                setError(codingErrorMessage(reason))
                throw reason
              } finally {
                setActiveComposerOperation(null)
              }
            }}
            onStop={async () => {
              if (!activeId) return
              try { await api.stop(activeId) }
              catch (reason) { void refreshCredits().catch(() => undefined); setError(messageOf(reason)) }
            }}
            onResume={async () => {
              if (!activeId) return
              setUndoOffer(undefined)
              setThankYouPhase(null)
              try { await api.resume(activeId) }
              catch (reason) { void refreshCredits().catch(() => undefined); setError(messageOf(reason)) }
            }}
            onNewChat={async () => {
              navigateToDraft(false, true, true)
            }}
            />
          </div>
        )}
        </>}
      </main>

      {appRoute === 'agent' && workspaceVisible && activeId && <button
        className="workspace-toggle workspace-toggle-global active"
        aria-label="Toggle workspace sidebar"
        aria-pressed={true}
        title="Close workspace"
        onClick={() => {
          manuallyClosedWorkspaceRef.current.add(activeId)
          setWorkspaceVisibility(false)
        }}
      ><Folder size={16} /></button>}

      {appRoute === 'agent' && workspaceVisible && activeId && (
        <WorkspacePanel
          snapshot={snapshot}
          inventory={visibleWorkspaceInventory}
          persistence={workspacePersistence}
          writeDrafts={workspaceWriteDrafts}
          onOpenFile={(entry) => openPreview(workspaceEntryPreviewTarget(activeId, entry))}
          onLoadMore={loadMoreWorkspaceInventory}
          onRefresh={refreshWorkspaceInventory}
          onPreview={() => {
            if (snapshot?.website.previewUrl) openPreview({
              url: snapshot.website.previewUrl,
              label: snapshot.website.entryPath,
              downloadUrl: snapshot.website.entryPath ? workspaceFileUrl(activeId, snapshot.website.entryPath) : undefined,
              kind: 'website',
              mime: 'text/html',
            })
          }}
          onRestart={async () => {
            try { await api.restartWebsite(activeId); await refreshSnapshot(activeId) }
            catch (reason) { setError(messageOf(reason)); throw reason }
          }}
        />
      )}

      {appRoute === 'agent' && previewTarget && (
        <aside className="preview-layer" role="dialog" aria-label={activePreviewRenderer === 'html' ? 'Website preview' : 'Artifact preview'}>
          <div className="preview-window">
            <div className="preview-bar">
              <div className="preview-view-controls" role="group" aria-label="View mode">
                <button
                  className={previewMode === 'rendered' ? 'active' : ''}
                  aria-label="Preview"
                  aria-pressed={previewMode === 'rendered'}
                  title="Preview"
                  onClick={() => { setPreviewMode('rendered'); setPreviewFileMenuOpen(false) }}
                ><Eye size={13} /></button>
                {['html', 'markdown', 'text'].includes(activePreviewRenderer || '') && <button
                  className={previewMode === 'source' ? 'active' : ''}
                  aria-label="Raw source"
                  aria-pressed={previewMode === 'source'}
                  title="Raw source"
                  onClick={() => { setPreviewMode('source'); setPreviewFileMenuOpen(false); setPreviewPickerActive(false) }}
                ><Code2 size={13} /></button>}
              </div>
              {previewMode === 'rendered' && activePreviewRenderer === 'html' && <button
                className="preview-toolbar-button"
                aria-label="Refresh preview"
                title="Refresh preview"
                onClick={() => { setPreviewPickerActive(false); setPreviewReloadKey((value) => value + 1) }}
              ><RefreshCw size={13} /></button>}
              <div className="preview-file-switcher">
                <button
                  className="preview-file-trigger"
                  aria-label="Switch file"
                  aria-haspopup="menu"
                  aria-expanded={previewFileMenuOpen}
                  title={previewTarget.label || 'index.html'}
                  onClick={() => setPreviewFileMenuOpen((value) => !value)}
                ><Folder size={13} /><span>{previewTarget.label || 'index.html'}</span><ChevronDown className={previewFileMenuOpen ? 'open' : ''} size={12} /></button>
                {previewFileMenuOpen && <div className="preview-file-menu" role="menu" aria-label="Preview files">
                  {previewChoices.map((choice) => <button
                    type="button"
                    role="menuitem"
                    className={choice.label === previewTarget.label ? 'active' : ''}
                    aria-current={choice.label === previewTarget.label ? 'true' : undefined}
                    key={choice.label}
                    onClick={() => {
                      setPreviewSource({ status: 'idle', content: '', error: '' })
                      setPreviewPickerActive(false)
                      setPreviewTarget(choice)
                      setPreviewReloadKey((value) => value + 1)
                      setPreviewFileMenuOpen(false)
                    }}
                    title={choice.label}
                  ><FileCode2 size={13} /><span>{choice.label}</span>{choice.label === previewTarget.label && <Check size={12} />}</button>)}
                  {(visibleWorkspaceInventory?.hasMore || visibleWorkspaceInventory?.truncated) && <div className="preview-file-inventory-note" role="status">
                    Showing loaded HTML files only.
                    {workspaceInventoryTruncationMessage(visibleWorkspaceInventory) && <> {workspaceInventoryTruncationMessage(visibleWorkspaceInventory)}</>}
                  </div>}
                </div>}
              </div>
              <div className="preview-window-actions">
                {previewMode === 'rendered' && previewPickerSupported && <button
                  className={previewPickerActive ? 'active' : ''}
                  aria-label={previewPickerActive ? 'Cancel element picker' : 'Pick an element'}
                  aria-pressed={previewPickerActive}
                  title={previewPickerActive ? 'Cancel element picker' : 'Pick an element'}
                  onClick={() => { setPreviewFileMenuOpen(false); setPreviewPickerActive((value) => !value) }}
                ><MousePointer2 size={13} /></button>}
                <a href={previewTarget.downloadUrl || previewTarget.url} download={previewFileName(previewTarget.label)} aria-label="Download file" title="Download file"><Download size={14} /></a>
                <button onClick={closePreview} aria-label="Close file viewer" title="Close file viewer"><X size={15} /></button>
              </div>
            </div>
            <div className="preview-content">
              {previewMode === 'source'
                ? <PreviewSource source={previewSource} />
                : activePreviewRenderer === 'html'
                  ? <iframe
                    ref={previewIframeRef}
                    key={`${previewTarget.url}:${previewReloadKey}`}
                    title="Workspace website preview"
                    src={previewFrameUrl}
                    sandbox={previewTarget.url.startsWith('/workspace/')
                      ? 'allow-scripts allow-modals allow-downloads'
                      : 'allow-scripts allow-same-origin allow-modals allow-downloads'}
                    referrerPolicy="no-referrer"
                  />
                  : activePreviewRenderer === 'markdown'
                    ? <ArtifactTextPreview source={previewSource} markdown sessionId={activeId || ''} />
                    : activePreviewRenderer === 'text'
                      ? <ArtifactTextPreview source={previewSource} sessionId={activeId || ''} />
                      : activePreviewRenderer === 'image'
                        ? <div className="artifact-media-preview"><img src={previewTarget.url} alt={previewTarget.label || 'Generated artifact'} /></div>
                        : activePreviewRenderer === 'audio'
                          ? <div className="artifact-media-preview"><audio controls src={previewTarget.url} /></div>
                          : activePreviewRenderer === 'video'
                            ? <div className="artifact-media-preview"><video controls src={previewTarget.url} /></div>
                            : activePreviewRenderer === 'pdf'
                              ? <iframe key={`${previewTarget.url}:${previewReloadKey}`} title="PDF artifact preview" src={previewTarget.url} referrerPolicy="no-referrer" />
                              : activePreviewRenderer === 'office'
                                ? <OfficeArtifactViewer sessionId={activeId || ''} target={previewTarget} reloadKey={previewReloadKey} />
                              : <ArtifactDownloadPreview target={previewTarget} />}
            </div>
          </div>
        </aside>
      )}

      {appRoute === 'agent' && connectionsOpen && (
        <ConnectionsPanel
          anchor={connectionsAnchor}
          connection={githubConnection}
            status={githubStatus}
          connecting={githubConnecting}
          repositoryPanelOpen={repositoryPanelOpen}
          onClose={() => setConnectionsOpen(false)}
          onToggleRepositoryPanel={setRepositoryPanelOpen}
          onConnect={async () => {
            setGithubConnecting(true)
            try {
              await connectGitHubPopup('/api/coding/github/connect/start')
              const connection = await refreshGitHubConnection()
              if (connection.status === 'connected') setRepositoryPanelOpen(true)
            } catch (reason) {
              setError(codingErrorMessage(reason))
            } finally {
              setGithubConnecting(false)
            }
          }}
        />
      )}
    </div>
  )
}

function EmptyConversation() {
  return (
    <div className="empty-conversation">
      <h1>What would you like to do?</h1>
    </div>
  )
}

export function filterHistorySessions(sessions: readonly SessionSummary[], query: string): SessionSummary[] {
  const normalizedQuery = normalizeConversationSearchText(query)
  if (!normalizedQuery) return [...sessions]
  const terms = normalizedQuery.split(' ').filter(Boolean)
  return sessions
    .map((session, index) => {
      const title = normalizeConversationSearchText(session.title)
      const lastMessage = normalizeConversationSearchText(session.lastMessage || '')
      const combined = `${title} ${lastMessage}`.trim()
      if (!terms.every((term) => combined.includes(term))) return undefined
      const score = title === normalizedQuery
        ? 4
        : title.startsWith(normalizedQuery)
          ? 3
          : terms.every((term) => title.includes(term))
            ? 2
            : 1
      return { session, index, score, updatedAt: Date.parse(session.updatedAt) || 0 }
    })
    .filter((candidate): candidate is { session: SessionSummary; index: number; score: number; updatedAt: number } => Boolean(candidate))
    .sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt || left.index - right.index)
    .map((candidate) => candidate.session)
}

function normalizeConversationSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function ConversationSearch(props: {
  sessions: readonly SessionSummary[]
  activeId?: string
  onClose: () => void
  onSelect: (sessionId: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const results = useMemo(() => filterHistorySessions(props.sessions, query), [props.sessions, query])
  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => {
    setActiveIndex(0)
  }, [query])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [props])
  const select = (session: SessionSummary | undefined) => {
    if (session) props.onSelect(session.id)
  }
  return (
    <div
      className="conversation-search-backdrop"
      onPointerDown={(event) => {
        if (event.currentTarget === event.target) props.onClose()
      }}
    >
      <section className="conversation-search" role="dialog" aria-modal="true" aria-labelledby="conversation-search-title">
        <header>
          <div><Search size={16} aria-hidden="true" /><strong id="conversation-search-title">Search conversations</strong></div>
          <button type="button" aria-label="Close conversation search" onClick={props.onClose}><X size={15} /></button>
        </header>
        <div className="conversation-search-input">
          <Search size={15} aria-hidden="true" />
          <input
            ref={input}
            value={query}
            placeholder="Search by title or message…"
            aria-label="Search conversations"
            role="combobox"
            aria-controls="conversation-search-results"
            aria-expanded={true}
            aria-autocomplete="list"
            aria-activedescendant={results[activeIndex] ? `conversation-search-${results[activeIndex].id}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((current) => results.length > 0 ? (current + 1) % results.length : 0)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((current) => results.length > 0 ? (current - 1 + results.length) % results.length : 0)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                select(results[activeIndex])
              }
            }}
          />
          {query && <button type="button" aria-label="Clear conversation search" onClick={() => setQuery('')}><X size={13} /></button>}
        </div>
        <div id="conversation-search-results" className="conversation-search-results" role="listbox" aria-label="Conversation search results">
          {results.length === 0 && <div className="conversation-search-empty">No conversations found</div>}
          {results.map((session, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              id={`conversation-search-${session.id}`}
              key={session.id}
              className={`${index === activeIndex ? 'selected' : ''}${session.id === props.activeId ? ' current' : ''}`}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => select(session)}
            >
              <span className="conversation-search-result-icon"><Sparkles size={13} aria-hidden="true" /></span>
              <span className="conversation-search-result-copy">
                <strong>{session.title}</strong>
                {session.lastMessage && <span>{session.lastMessage}</span>}
              </span>
              <span className="conversation-search-result-meta">
                {session.productMode === 'coding' && <Code2 size={12} aria-label="Coding session" />}
                {session.status === 'running' && <i>Running</i>}
                <time dateTime={session.updatedAt}>{formatConversationSearchDate(session.updatedAt)}</time>
              </span>
            </button>
          ))}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>
      </section>
    </div>
  )
}

function formatConversationSearchDate(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const today = new Date()
  const sameDay = parsed.getFullYear() === today.getFullYear()
    && parsed.getMonth() === today.getMonth()
    && parsed.getDate() === today.getDate()
  return sameDay
    ? parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function groupHistorySessions(sessions: SessionSummary[]): Array<{ label: string; sessions: SessionSummary[] }> {
  const today = new Date(Date.now())
  today.setHours(0, 0, 0, 0)
  const yesterday = today.getTime() - 24 * 60 * 60 * 1_000
  const groups: Array<{ label: string; sessions: SessionSummary[] }> = []
  for (const session of sessions) {
    const time = Date.parse(session.updatedAt)
    const label = time >= today.getTime() ? 'Today' : time >= yesterday ? 'Yesterday' : 'Earlier'
    let group = groups.find((candidate) => candidate.label === label)
    if (!group) {
      group = { label, sessions: [] }
      groups.push(group)
    }
    group.sessions.push(session)
  }
  return groups
}

function ConnectionsPanel(props: {
  anchor: PopoverAnchor
  connection: GitHubConnectionState
  status?: GitHubStatusState
  connecting: boolean
  repositoryPanelOpen: boolean
  onClose: () => void
  onToggleRepositoryPanel: (open: boolean) => void
  onConnect: () => Promise<void>
}) {
  const panel = useRef<HTMLElement>(null)
  const connected = props.connection.status === 'connected'
  const outage = props.status && ['minor', 'major', 'critical'].includes(props.status.indicator)
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || panel.current?.contains(target)) return
      if (target instanceof Element && target.closest('.connections-button')) return
      props.onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [props])
  const left = Math.max(8, Math.min(props.anchor.left, window.innerWidth - 232))
  const bottom = Math.max(8, window.innerHeight - props.anchor.top + 8)
  return (
      <section ref={panel} className="connections-panel" role="dialog" aria-labelledby="connections-title" style={{ left, bottom }}>
        <header><strong id="connections-title">Connections</strong></header>
        <div className="connection-service">
          <div className="connection-service-head">
            <Github size={16} aria-hidden="true" />
            <strong>GitHub</strong>
            {connected
              ? <label className="connection-switch"><input type="checkbox" checked={props.repositoryPanelOpen} onChange={(event) => props.onToggleRepositoryPanel(event.target.checked)} aria-label="Show repository panel" /><span /></label>
              : <button type="button" className="connect-service" aria-label="Connect GitHub" disabled={props.connecting} onClick={() => void props.onConnect()}>{props.connecting ? <LoaderCircle className="spin" size={15} /> : <ExternalLink size={16} aria-hidden="true" />}</button>}
          </div>
          {!connected && outage && <div className="github-outage" role="status" aria-label="GitHub outage notice">GitHub has an outage that may affect your use of some features. <a href="https://www.githubstatus.com/" target="_blank" rel="noreferrer">View Status</a></div>}
        </div>
      </section>
  )
}

function PinnedRepository({ repository }: { repository: CodingRepositoryState }) {
  return <div className="pinned-repository" aria-label="Coding repository"><Github size={14} /><strong>{repository.fullName}</strong><span><GitBranch size={12} />{repository.baseBranch}</span><i>{repository.baseCommitSha.slice(0, 7)}</i></div>
}

function RepositoryControls(props: {
  connection: GitHubConnectionState
  connectionLoading: boolean
  connectionError?: string
  onRetryConnection: () => void
  repositories: GitHubRepository[]
  repositoriesLoading: boolean
  repositoriesLoaded: boolean
  repositoriesError?: string
  selectedRepoId: number | null
  selectedRepoFullName: string | null
  onSelectRepository: (id: number | null) => void
  onRetryRepositories: () => void
  branches: GitHubBranch[]
  branchesLoading: boolean
  branchesError?: string
  selectedBranch: string | null
  onSelectBranch: (name: string | null) => void
  onRetryBranches: () => void
  managing: boolean
  onManageRepositories: () => Promise<void>
  disconnecting: boolean
  onDisconnect: () => Promise<void>
  outageStatus?: GitHubStatusState
  onDismissOutage: () => void
}) {
  const connected = props.connection.status === 'connected'
  const selectedRepository = props.repositories.find((repository) => repository.id === props.selectedRepoId)
  const selectedBranch = props.branches.find((branch) => branch.name === props.selectedBranch)
  const repositoryContent = props.connectionLoading
    ? <div className="repository-loading" role="status" aria-label="Loading GitHub repository controls"><span /><span className="short" /><span className="settings" /></div>
    : props.connectionError
      ? <div className="github-verification-error"><p>We couldn’t verify your GitHub connection. Please try again.</p><button type="button" onClick={props.onRetryConnection}>Retry</button></div>
      : !connected
        ? null
        : props.repositoriesError
      ? <div className="repository-load-error"><Info size={15} aria-hidden="true" /><span>Couldn't load your repositories.</span><button type="button" onClick={props.onRetryRepositories}>Retry</button></div>
      : props.repositoriesLoaded && props.repositories.length === 0
        ? <div className="repository-empty"><span>No repositories found</span><Info size={14} aria-label="A repo won't appear if its owner hasn't installed the app or granted access." /></div>
        : <div className="repository-control-fields">
          <SearchPicker
            ariaLabel="Select a repository"
            icon={<Github size={13} />}
            value={props.selectedRepoId === null ? null : String(props.selectedRepoId)}
            selectedLabel={selectedRepository?.fullName ?? props.selectedRepoFullName ?? undefined}
            placeholder="Select a repository"
            searchPlaceholder="Search repositories…"
            emptyText="No repositories found."
            loading={!props.repositoriesLoaded || props.repositoriesLoading}
            disabled={false}
            options={props.repositories.map((repository) => ({ value: String(repository.id), label: repository.fullName, meta: repository.private ? 'Private' : 'Public' }))}
            onChange={(value) => props.onSelectRepository(value ? Number(value) : null)}
            footer={<button type="button" disabled={props.managing} onClick={() => void props.onManageRepositories()}><ExternalLink size={13} aria-hidden="true" />{props.managing ? 'Opening GitHub…' : 'Add repositories…'}</button>}
          />
          {props.branchesError
            ? <button type="button" className="branch-load-error" onClick={props.onRetryBranches} disabled={props.branchesLoading}><Info size={13} aria-hidden="true" />{props.branchesLoading ? 'Retrying…' : 'Branches failed — retry'}</button>
            : <SearchPicker
                ariaLabel="Branch"
                icon={<GitBranch size={13} />}
                value={selectedBranch?.name ?? null}
                selectedLabel={selectedBranch?.name}
                placeholder="Branch"
                searchPlaceholder="Search branches…"
                emptyText={selectedRepository && !props.branchesLoading && props.branches.length === 0 ? "No branches yet — we'll create one when you start." : 'No branches found.'}
                loading={props.branchesLoading}
                disabled={!selectedRepository}
                options={props.branches.map((branch) => ({ value: branch.name, label: branch.name, meta: branch.commitSha.slice(0, 7) }))}
                onChange={props.onSelectBranch}
              />}
        </div>
  const outage = connected && props.outageStatus && ['minor', 'major', 'critical'].includes(props.outageStatus.indicator)
  return (
    <>
      <div className={`repository-controls${outage ? ' continues-below' : ''}`} aria-label="GitHub repository controls">
        <div className="repository-control-content">{repositoryContent}</div>
        {connected && !props.connectionLoading && !props.connectionError && <GitHubConfigMenu managing={props.managing} onManageRepositories={props.onManageRepositories} disconnecting={props.disconnecting} onDisconnect={props.onDisconnect} />}
      </div>
      {outage && <div className="repository-outage-banner">
        <p>GitHub has an outage that may affect your use of some features. <a href="https://www.githubstatus.com/" target="_blank" rel="noreferrer">View status</a></p>
        <button type="button" aria-label="Dismiss GitHub outage notice" onClick={props.onDismissOutage}><X size={13} aria-hidden="true" /></button>
      </div>}
    </>
  )
}

function GitHubConfigMenu(props: { managing: boolean; onManageRepositories: () => Promise<void>; disconnecting: boolean; onDisconnect: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  return (
    <div ref={root} className={`github-config-menu${open ? ' is-open' : ''}`}>
      <button type="button" aria-label="GitHub settings" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Settings size={15} aria-hidden="true" /></button>
      {open && <div className="github-config-menu-items" role="menu">
        <button type="button" role="menuitem" disabled={props.managing} onClick={() => { setOpen(false); void props.onManageRepositories() }}><span title="Manage repositories on GitHub"><Folder size={14} aria-hidden="true" /></span>{props.managing ? 'Opening GitHub…' : 'Manage repositories'}</button>
        <button type="button" role="menuitem" disabled={props.disconnecting} onClick={() => { setOpen(false); void props.onDisconnect() }}>
          <span title="Disconnect GitHub"><Unplug size={14} aria-hidden="true" /></span>
          {props.disconnecting ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>}
    </div>
  )
}

function SearchPicker(props: {
  ariaLabel: string
  icon: React.ReactNode
  value: string | null
  selectedLabel?: string
  placeholder: string
  searchPlaceholder: string
  emptyText: string
  loading: boolean
  disabled: boolean
  options: Array<{ value: string; label: string; meta?: string }>
  onChange: (value: string | null) => void
  onRetry?: () => void
  footer?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const close = () => { setOpen(false); setQuery('') }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  const filtered = props.options.filter((option) => `${option.label} ${option.meta || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <div ref={root} className={`search-picker ${open ? 'open' : ''}`}>
      <button type="button" className="search-picker-trigger" disabled={props.disabled || props.loading} aria-label={props.ariaLabel} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {props.loading ? <LoaderCircle className="spin" size={13} /> : props.icon}<span className={props.selectedLabel ? '' : 'placeholder'}>{props.loading ? 'Loading…' : props.selectedLabel || props.placeholder}</span><ChevronDown size={12} />
      </button>
      {open && <div className="search-picker-menu">
        <div className="search-picker-search"><Search size={13} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={props.searchPlaceholder} aria-label={props.searchPlaceholder} /></div>
        <div className="search-picker-options">
          {filtered.map((option) => <button type="button" key={option.value} className={option.value === props.value ? 'selected' : ''} onClick={() => { props.onChange(option.value); setOpen(false); setQuery('') }}><span>{option.label}</span>{option.meta && <i>{option.meta}</i>}{option.value === props.value && <Check size={12} />}</button>)}
          {filtered.length === 0 && <div className="search-picker-empty">{props.emptyText}{props.onRetry && <button type="button" onClick={props.onRetry}>Retry</button>}</div>}
        </div>
        {props.footer && <div className="search-picker-footer">{props.footer}</div>}
      </div>}
    </div>
  )
}

export function Composer(props: {
  sessionId: string
  draftCommand?: ComposerDraftCommand
  reviewedNodeId?: string
  onRemoveCustomFeedback: () => void
  readOnly?: boolean
  submitDisabled?: boolean
  onDraftStateChange: (draft: ComposerDraftSnapshot) => void
  running: boolean
  resumable: boolean
  tokenLimit?: SessionTokenLimitState
  creditBalance?: CreditBalance
  isFreeSession: boolean
  models: AgentModelOption[]
  modelListUnavailable: boolean
  modelSelection: string | null
  codingMode: boolean
  connectionsOpen: boolean
  connectionsEnabled: boolean
  repositoryControl?: React.ReactNode
  onError: (reason: unknown) => void
  onConnections: (anchor: PopoverAnchor) => void
  onSend: (content: string, attachments: ComposerAttachment[], model: string | null, reviewedNodeId?: string) => Promise<void>
  onStop: () => Promise<void>
  onResume: () => Promise<void>
  onNewChat: () => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [creditOpen, setCreditOpen] = useState(false)
  const [modelSelection, setModelSelection] = useState(props.modelSelection ?? 'auto')
  const fileInput = useRef<HTMLInputElement>(null)
  const editor = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const dragDepth = useRef(0)
  const draftAttachmentSequence = useRef(0)
  const applyingDraftCommand = useRef<number | undefined>(undefined)
  const blockedBySessionLimit = Boolean(props.tokenLimit?.reached)
  const editorLocked = props.readOnly || props.running || blockedBySessionLimit
  const placeholder = props.readOnly
    ? 'Static replay — new tasks are disabled'
    : props.running
    ? 'Agent is working…'
    : blockedBySessionLimit
      ? 'Start a new chat to continue.'
      : props.reviewedNodeId
        ? 'Give feedback on this task…'
        : 'Ask anything…'
  useEffect(() => {
    if (props.codingMode) setAttachments([])
  }, [props.codingMode])
  useEffect(() => {
    setModelSelection(props.modelSelection ?? 'auto')
  }, [props.modelSelection])
  useEffect(() => {
    const command = props.draftCommand
    if (!command || command.sessionId !== props.sessionId) return
    applyingDraftCommand.current = command.id
    setValue(command.value)
    setAttachments(command.attachments.map((attachment) => ({ ...attachment })))
    if (command.focus) window.requestAnimationFrame(() => {
      editor.current?.focus()
      if (editor.current) placeComposerCaretAtEnd(editor.current)
    })
  }, [props.draftCommand, props.sessionId])
  useEffect(() => {
    if (applyingDraftCommand.current !== undefined) {
      const command = props.draftCommand
      const commandApplied = command?.id === applyingDraftCommand.current
        && value === command.value
        && attachments.length === command.attachments.length
        && attachments.every((attachment, index) => attachment.path === command.attachments[index]?.path)
      if (!commandApplied) return
      applyingDraftCommand.current = undefined
    }
    props.onDraftStateChange({
      sessionId: props.sessionId,
      value,
      attachments: attachments.map((attachment) => ({ ...attachment })),
    })
  }, [attachments, props.draftCommand, props.onDraftStateChange, props.sessionId, value])
  const uploadFiles = async (files: File[]) => {
    if (!files.length || props.readOnly || props.running || blockedBySessionLimit || uploading) return
    const selection = selectAgentUploads(files, attachments.reduce((total, attachment) => total + attachment.size, 0))
    if (selection.accepted.length === 0) {
      if (selection.errors.length > 0) props.onError(new Error(selection.errors.join('; ')))
      return
    }
    if (props.sessionId === DRAFT_COMPOSER_SESSION_ID) {
      const pending = selection.accepted.map((file) => ({
        name: file.name,
        path: `draft:${++draftAttachmentSequence.current}:${file.name}`,
        size: file.size,
        mime: file.type,
        file,
      }))
      setAttachments((current) => [...current, ...pending])
      if (selection.errors.length > 0) props.onError(new Error(selection.errors.join('; ')))
      return
    }
    setUploading(true)
    try {
      const results = await Promise.allSettled(selection.accepted.map(async (file) => {
        const uploaded = await api.upload(props.sessionId, file)
        return { name: file.name, path: uploaded.path, size: uploaded.bytes, mime: uploaded.mime }
      }))
      const uploaded = results
        .filter((result): result is PromiseFulfilledResult<{ name: string; path: string; size: number; mime: string }> => result.status === 'fulfilled')
        .map((result) => result.value)
      setAttachments((current) => [...current, ...uploaded])
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      const errors = [...selection.errors]
      if (failures.length > 0) errors.push(`${failures.length} attachment${failures.length === 1 ? '' : 's'} failed to upload: ${failures.map((failure) => messageOf(failure.reason)).join('; ')}`)
      if (errors.length > 0) props.onError(new Error(errors.join('; ')))
    } finally {
      setUploading(false)
    }
  }
  const submit = async () => {
    if (props.readOnly || props.submitDisabled || (!value.trim() && (!attachments.length || props.codingMode)) || props.running || blockedBySessionLimit || uploading) return
    const content = value
    setValue('')
    try {
      await props.onSend(
        content,
        attachments.map((attachment) => ({ ...attachment })),
        modelSelection === 'auto' ? null : modelSelection,
        props.reviewedNodeId,
      )
      setAttachments([])
    } catch {
      setValue(content)
    }
  }
  useEffect(() => {
    const element = editor.current
    if (!element || composerText(element) === value) return
    replaceComposerText(element, value)
    if (document.activeElement === element) placeComposerCaretAtEnd(element)
  }, [value])
  return (
    <div className="composer-wrap">
      {props.tokenLimit?.reached && (
        <div className="session-limit-card" role="status">
          <div><strong>Session limit reached</strong><span>{props.tokenLimit.message}</span></div>
          <button onClick={() => void props.onNewChat().catch(props.onError)}><Plus size={13} /> New Chat</button>
        </div>
      )}
      <div
        className={`composer${draggingFiles ? ' is-dragging' : ''}${props.repositoryControl ? ' has-repository-control' : ''}`}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files') || props.readOnly || props.running || blockedBySessionLimit || uploading) return
          event.preventDefault()
          dragDepth.current += 1
          setDraggingFiles(true)
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files') || props.readOnly || props.running || blockedBySessionLimit || uploading) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDraggingFiles(false)
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files') || props.readOnly || props.running || blockedBySessionLimit || uploading) return
          event.preventDefault()
          dragDepth.current = 0
          setDraggingFiles(false)
          void uploadFiles([...event.dataTransfer.files])
        }}
      >
        {draggingFiles && <div className="drop-files-overlay" aria-live="polite"><CloudUpload size={18} /> Drop files...</div>}
        {(props.reviewedNodeId || attachments.length > 0) && <div className="attachment-row">
          {props.reviewedNodeId && <div className="feedback-chip" data-reviewed-node-id={props.reviewedNodeId}><Heart size={13} /><span>Feedback</span><button type="button" aria-label="Remove Feedback" onClick={props.onRemoveCustomFeedback}><X size={12} /></button></div>}
          {attachments.map((attachment) => (
            <div className="attachment-chip" key={attachment.path}><FileIcon size={13} /><span>{attachment.name}</span><button onClick={() => setAttachments((items) => items.filter((item) => item.path !== attachment.path))}><X size={12} /></button></div>
          ))}
        </div>}
        <div
          ref={editor}
          className="composer-editor"
          role="textbox"
          aria-label="Message"
          aria-multiline="true"
          aria-placeholder={placeholder}
          aria-disabled={editorLocked || undefined}
          aria-readonly={props.readOnly || undefined}
          contentEditable={!editorLocked}
          suppressContentEditableWarning
          data-placeholder={placeholder}
          spellCheck
          tabIndex={editorLocked ? 0 : undefined}
          onInput={(event) => {
            const next = composerText(event.currentTarget)
            if (!next && event.currentTarget.childNodes.length > 0) event.currentTarget.replaceChildren()
            setValue(next)
          }}
          onPaste={(event) => {
            const existingNames = new Set(attachments.map((attachment) => attachment.name))
            const images: File[] = []
            let sequence = 0
            for (const item of event.clipboardData.items) {
              if (!item.type.startsWith('image/')) continue
              const source = item.getAsFile()
              if (!source) continue
              const extension = pastedImageExtension(source)
              let name = ''
              do {
                sequence += 1
                name = `image-${sequence}.${extension}`
              } while (existingNames.has(name))
              existingNames.add(name)
              images.push(new File([source], name, { type: source.type, lastModified: source.lastModified }))
            }
            if (images.length > 0) {
              event.preventDefault()
              void uploadFiles(images)
              return
            }

            const plainText = event.clipboardData.getData('text/plain')
            if (!plainText) return
            event.preventDefault()
            insertComposerText(event.currentTarget, plainText)
            setValue(composerText(event.currentTarget))
          }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={(event) => {
            composing.current = false
            setValue(composerText(event.currentTarget))
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
            event.preventDefault()
            if (event.shiftKey) {
              insertComposerText(event.currentTarget, '\n')
              setValue(composerText(event.currentTarget))
              return
            }
            void submit()
          }}
        />
        <div className="composer-tools">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={AGENT_UPLOAD_ACCEPT_ATTR}
            hidden
            onChange={async (event) => {
              const input = event.currentTarget
              const files = [...(input.files ?? [])]
              if (!files.length) return
              try {
                await uploadFiles(files)
              } finally {
                input.value = ''
              }
            }}
          />
          <button className="attach-button" title={props.readOnly ? 'Uploads are disabled in the static replay' : 'Upload files'} disabled={props.readOnly || props.running || blockedBySessionLimit || uploading} onClick={() => fileInput.current?.click()} aria-label={draggingFiles ? 'Drop files' : 'Add files'}>
            {uploading ? <LoaderCircle className="spin" size={16} /> : draggingFiles ? <CloudUpload size={16} /> : <Paperclip size={16} />}
            <span>{draggingFiles ? 'Drop files...' : 'Add files'}</span>
          </button>
          <button
            className={`connections-button ${props.connectionsOpen ? 'active' : ''}`}
            type="button"
            aria-label={props.connectionsEnabled ? 'Connections enabled: GitHub' : 'Connections'}
            aria-expanded={props.connectionsOpen}
            disabled={props.readOnly || props.running || blockedBySessionLimit}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect()
              props.onConnections({ left: bounds.left, top: bounds.top })
            }}
          >{props.connectionsEnabled ? <Github size={14} /> : <Plug size={14} />}<ChevronDown className={props.connectionsOpen ? 'open' : ''} size={11} /></button>
          <span className="composer-spacer" />
          {props.resumable && !props.running && <button className="resume-button" onClick={() => void props.onResume()}><RotateCcw size={13} /> Continue</button>}
          <CreditGaugeControl balance={props.creditBalance} isFreeSession={props.isFreeSession} open={creditOpen} onOpenChange={setCreditOpen} />
          {props.running
            ? <button className="send-button stop" onClick={() => void props.onStop()} aria-label="Stop agent"><CircleStop size={17} /></button>
            : <button
              className="send-button"
                disabled={Boolean(props.readOnly || props.submitDisabled || blockedBySessionLimit || ((!value.trim() && (attachments.length === 0 || props.codingMode)) || uploading))}
                onClick={() => void submit()}
                aria-label="Send message"
              ><ArrowUp size={17} /></button>}
        </div>
      </div>
      {props.repositoryControl}
    </div>
  )
}

function composerText(element: HTMLElement): string {
  if (!element.textContent && [...element.childNodes].every((node) => node instanceof HTMLBRElement)) return ''
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').replaceAll(COMPOSER_CARET_SENTINEL, '')
    if (node instanceof HTMLBRElement) return '\n'
    return [...node.childNodes].map(read).join('')
  }
  return read(element).replace(/\r\n?/g, '\n')
}

function insertComposerText(element: HTMLElement, value: string): void {
  const text = value.replace(/\r\n?/g, '\n')
  const fragment = composerFragment(text)
  const lastNode = fragment.lastChild
  if (!lastNode) return
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !element.contains(selection.anchorNode)) {
    element.append(fragment)
    placeComposerCaretAtEnd(element)
    return
  }

  const range = selection.getRangeAt(0)
  range.deleteContents()
  range.insertNode(fragment)
  if (text.endsWith('\n') && lastNode.nodeType === Node.TEXT_NODE) {
    range.setStart(lastNode, Math.max(0, (lastNode.textContent?.length || 0) - COMPOSER_CARET_SENTINEL.length))
  } else {
    range.setStartAfter(lastNode)
  }
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

function replaceComposerText(element: HTMLElement, value: string): void {
  element.replaceChildren(composerFragment(value.replace(/\r\n?/g, '\n')))
}

function composerFragment(value: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  if (value) fragment.append(document.createTextNode(`${value}${value.endsWith('\n') ? COMPOSER_CARET_SENTINEL : ''}`))
  return fragment
}

const COMPOSER_CARET_SENTINEL = '\u200b'

function placeComposerCaretAtEnd(element: HTMLElement): void {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function pastedImageExtension(file: { type: string; name: string }): string {
  const mimeExtension = file.type.split('/')[1]?.split(';')[0]?.trim()
  if (mimeExtension) return mimeExtension
  const dot = file.name.lastIndexOf('.')
  return dot > 0 && dot < file.name.length - 1 ? file.name.slice(dot + 1) : 'png'
}

type CreditGaugeState = 'loading' | 'normal' | 'low' | 'zero'

export function resolveCreditGaugeState(balance: CreditBalance | undefined): CreditGaugeState {
  if (!balance) return 'loading'
  if (balance.creditsRemaining <= 0) return 'zero'
  return balance.dailyFreeCredits > 0 && (balance.dailyFreeCredits - balance.creditsRemaining) / balance.dailyFreeCredits >= 0.5 ? 'low' : 'normal'
}

export function formatCreditResetDuration(resetAt: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, Date.parse(resetAt) - now) / 60_000)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${hours === 1 ? '1 hour' : `${hours} hours`} ${rest === 1 ? '1 minute' : `${rest} minutes`} until daily credits reset`
}

function CreditGaugeControl(props: {
  balance?: CreditBalance
  isFreeSession: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const state = resolveCreditGaugeState(props.balance)
  const balance = props.balance?.creditsRemaining ?? 0
  const maximum = props.balance?.dailyFreeCredits ?? 2_500
  const usedFraction = state === 'loading' ? 0 : state === 'zero' ? 1 : maximum > 0 ? Math.max(0, Math.min(1, (maximum - balance) / maximum)) : 0
  const label = props.isFreeSession
    ? 'No credits being used during this session'
    : state === 'loading'
      ? 'Loading credits'
      : state === 'zero'
        ? 'Daily reference usage reached; tasks remain available'
        : `Credits remaining: ${balance.toLocaleString()} of ${maximum.toLocaleString()}`
  return (
    <div className="credit-control">
      <button
        type="button"
        className={`credit-gauge-trigger ${state} ${props.isFreeSession ? 'free' : ''}`}
        aria-label={label}
        aria-expanded={props.open}
        onClick={() => props.onOpenChange(!props.open)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <g transform="rotate(-90 12 12)">
            <circle className="credit-gauge-track" cx="12" cy="12" r="9.5" pathLength="100" />
            {state === 'loading'
              ? <circle className="credit-gauge-value loading" cx="12" cy="12" r="9.5" pathLength="100" strokeDasharray="25 100" />
              : <circle className="credit-gauge-value" cx="12" cy="12" r="9.5" pathLength="100" strokeDasharray={`${usedFraction * 100} 100`} />}
          </g>
          {state === 'zero' && !props.isFreeSession && <line x1="8" y1="12" x2="16" y2="12" />}
          {props.isFreeSession && <polyline points="8,12.5 11,15.25 16,9.75" />}
        </svg>
      </button>
      {props.open && (
        <div className="credit-popover gauge-popover" role="dialog" aria-label="Daily credits details">
          {props.isFreeSession && <div className="credit-callout free"><Check size={13} />No credits are being used during this session</div>}
          {!props.isFreeSession && state === 'zero' && <div className="credit-callout zero"><CircleGauge size={13} />Daily reference reached — tasks remain available</div>}
          <div className="credit-heading"><span>Credits</span><a href="https://help.arena.ai/articles/5476762589-credit-sytem" target="_blank" rel="noreferrer" aria-label="More information about credits"><Info size={14} /></a></div>
          <div className="credit-balance-track"><i className={`credit-balance-fill ${state}`} style={{ width: `${props.isFreeSession ? 0 : Math.max(0, Math.min(100, balance / Math.max(1, maximum) * 100))}%` }} /></div>
          <div className="credit-balance-legend"><i className={`credit-legend-dot ${state}`} /><span>{balance.toLocaleString()} / {maximum.toLocaleString()}</span><em>reference credits remaining</em></div>
          {props.balance?.refreshedAt && <div className="credit-reset"><Timer size={12} /><span>{formatCreditResetDuration(props.balance.refreshedAt)}</span></div>}
        </div>
      )}
    </div>
  )
}

export function sessionPath(id: string): string {
  return `/agent/${id}`
}

export function sessionIdFromPath(pathname: string): string | undefined {
  return pathname.match(/^\/agent\/(ses_[a-z0-9]{20})\/?$/)?.[1]
}

export function isAgentDraftPath(pathname: string): boolean {
  return pathname === AGENT_DRAFT_PATH || pathname === `${AGENT_DRAFT_PATH}/`
}

export function isHistorySearchPath(pathname: string): boolean {
  return pathname === HISTORY_SEARCH_PATH || pathname === `${HISTORY_SEARCH_PATH}/`
}

export function validHistorySearchReturnPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (isAgentDraftPath(value)) return AGENT_DRAFT_PATH
  if (isAgentLeaderboardPath(value)) return AGENT_LEADERBOARD_PATH
  const sessionId = sessionIdFromPath(value)
  return sessionId ? sessionPath(sessionId) : undefined
}

async function copyText(content: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content)
    return
  }
  const target = document.createElement('textarea')
  target.value = content
  target.setAttribute('readonly', '')
  target.style.position = 'fixed'
  target.style.opacity = '0'
  document.body.append(target)
  target.select()
  document.execCommand('copy')
  target.remove()
}

function Timeline({ item, sessionId, onPreview, onApproval, onHitl, onGiveFeedback }: {
  item: TimelineItem
  sessionId: string
  onPreview: (artifact: ArtifactRecord) => void
  onApproval: (approvalId: string, approved: boolean) => Promise<void>
  onHitl: (hitlId: string, response: Record<string, unknown>) => Promise<void>
  onGiveFeedback?: () => void
}) {
  if (item.kind === 'user') return (
    <section className={`user-turn${item.customFeedbackTurn ? ' custom-feedback-turn' : ''}`}>
      {item.customFeedbackTurn && <div className="custom-feedback-card" data-reviewed-node-id={item.reviewedNodeId}>
        <div className="custom-feedback-card-heading"><Heart size={13} /><strong>Feedback</strong></div>
        {item.content && <div className="custom-feedback-card-content">{item.content}</div>}
      </div>}
      {!item.customFeedbackTurn && item.content && <div className="user-bubble">{item.content}</div>}
      {item.attachments.length > 0 && <div className="turn-attachments">{item.attachments.map((path) => <span key={path}><Paperclip size={12} />{path.split('/').at(-1)}</span>)}</div>}
    </section>
  )
  if (item.kind === 'activity') return <AssistantActivityRow item={item} />
  if (item.kind === 'thought') return <ThoughtRow item={item} />
  if (item.kind === 'plan') return <PlanCard item={item} />
  if (item.kind === 'exploration') return <ExplorationGroup item={item} />
  if (item.kind === 'tool-group') return <ArenaToolGroup item={item} />
  if (item.kind === 'tool') return <ToolRow item={item} />
  if (item.kind === 'tool-draft') return <StreamingToolCallRow item={item} />
  if (item.kind === 'artifact') return <ArtifactCard artifact={item.artifact} onPreview={() => onPreview(item.artifact)} />
  if (item.kind === 'approval') return <ApprovalCard item={item} onDecision={onApproval} />
  if (item.kind === 'hitl') return <HitlCard item={item} sessionId={sessionId} onResponse={onHitl} />
  if (item.kind === 'error') return <div className={`error-event ${item.cancelled ? 'cancelled' : ''}`}><CircleStop size={15} /><span>{item.content}</span></div>
  return (
    <section className="final-answer" data-assistant-response-id={item.messageEventId}>
      {item.streaming && <div className="final-streaming" aria-label="Final answer streaming"><LoaderCircle className="spin" size={13} /></div>}
      <div className="markdown"><ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href, title }) => {
            const target = markdownHref(sessionId, href)
            return <a href={target} title={title} target={target.startsWith('#') ? undefined : '_blank'} rel={target.startsWith('#') ? undefined : 'noreferrer'}>{children}</a>
          },
        }}
      >{item.content}</ReactMarkdown></div>
      {!item.streaming && item.messageEventId && <FinalActions content={item.content} onGiveFeedback={onGiveFeedback} />}
    </section>
  )
}

function FinalActions({ content, onGiveFeedback }: { content: string; onGiveFeedback?: () => void }) {
  const [copied, setCopied] = useState(false)
  return <div className="final-actions">
    <span className="final-completed" aria-label="Completed"><Check size={13} /></span>
    <button type="button" className="final-copy-action" aria-label={copied ? 'Copied' : 'Copy'} onClick={() => {
      void copyText(content).then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1_500)
      })
    }}><Copy size={13} /><span>{copied ? 'Copied' : 'Copy'}</span></button>
    {onGiveFeedback && <button type="button" className="give-feedback-action" onClick={onGiveFeedback}><Heart size={13} /><span>Give feedback</span></button>}
  </div>
}

function TaskReviewPanel(props: {
  messageEventId: string
  readOnly?: boolean
  onAction: (messageEventId: string, action: TaskReviewFeedbackAction) => Promise<void>
}) {
  const [submitting, setSubmitting] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const act = useCallback(async (operation: () => Promise<void>) => {
    if (submitting) return
    setSubmitting(true)
    try { await operation() }
    finally { setSubmitting(false) }
  }, [submitting])
  useEffect(() => {
    panel.current?.focus()
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || submitting || props.readOnly) return
      event.preventDefault()
      void act(() => props.onAction(props.messageEventId, 'escape'))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [act, props, submitting])
  return <div className="composer-wrap task-review-wrap">
    <section ref={panel} className="task-review-panel" role="dialog" aria-labelledby="task-review-title" tabIndex={-1}>
      <div className="task-review-heading">
        <strong id="task-review-title">此任务成功了吗？</strong>
        {props.readOnly && <span className="task-review-readonly">静态回放 · 只读</span>}
        <div className="task-review-controls">
          <kbd>Esc</kbd>
          <button type="button" disabled={submitting || props.readOnly} aria-label="Close review panel" title={props.readOnly ? 'Feedback is disabled in the static replay' : undefined} onClick={() => void act(() => props.onAction(props.messageEventId, 'escape'))}><X size={14} /></button>
        </div>
      </div>
      <div className="task-review-actions">
        <button type="button" className="approve" disabled={submitting || props.readOnly} onClick={() => void act(() => props.onAction(props.messageEventId, 'approve'))}><span className="task-review-icon"><ThumbsUp size={16} /></span><span>是</span></button>
        <button type="button" className="disapprove" disabled={submitting || props.readOnly} onClick={() => void act(() => props.onAction(props.messageEventId, 'disapprove'))}><span className="task-review-icon"><ThumbsDown size={16} /></span><span>否</span></button>
        <button type="button" className="continue-working" disabled={submitting || props.readOnly} onClick={() => void act(() => props.onAction(props.messageEventId, 'edit'))}><span className="task-review-icon"><RotateCcw size={16} /></span><span>继续工作</span></button>
      </div>
    </section>
  </div>
}

function TaskCompletionBar(props: {
  messageEventId: string
  disabled?: boolean
  onFeedback: (messageEventId: string, value: TaskCompletionFeedbackValue) => Promise<void>
}) {
  return <div className="composer-wrap task-completion-bar-container" data-testid="task-completion-bar-container">
    <section className="task-completion-bar" data-testid="task-completion-bar" aria-labelledby="task-completion-bar-title">
      <strong id="task-completion-bar-title">Does this complete your task?</strong>
      <div className="task-completion-actions" role="group" aria-label="Task completion feedback">
        <button type="button" disabled={props.disabled} className="negative" onClick={() => void props.onFeedback(props.messageEventId, 'no')}>No</button>
        <button type="button" disabled={props.disabled} className="warning" onClick={() => void props.onFeedback(props.messageEventId, 'making_progress')}>Making progress</button>
        <button type="button" disabled={props.disabled} className="positive" onClick={() => void props.onFeedback(props.messageEventId, 'yes')}>Yes</button>
      </div>
    </section>
  </div>
}

function ComposerOperationStatus({ children }: { children: string }) {
  return <div className="composer-operation-status" role="status">{children}</div>
}

function WorkspacePersistenceStatus({ status }: { status: WorkspacePersistenceView }) {
  return <div className={`composer-operation-status workspace-persistence-status ${status.phase}`} role="status" aria-live="polite">
    {status.phase === 'saved'
      ? <Check size={11} aria-hidden="true" />
      : <LoaderCircle className="spin" size={11} aria-hidden="true" />}
    <span>{status.label}</span>
  </div>
}

function UndoTurnCallout(props: { disabled?: boolean; onUndo: () => Promise<void>; onDismiss: () => void }) {
  return <div className="composer-above-row">
    <section className="undo-turn-callout" role="status" aria-label="Undo last turn">
      <span className="undo-turn-copy">Do you want to undo the last turn?</span>
      <button type="button" className="undo-turn-action" disabled={props.disabled} onClick={() => void props.onUndo()}><RotateCcw size={16} /><span>Undo</span></button>
      <button type="button" className="undo-turn-dismiss" disabled={props.disabled} aria-label="Dismiss" onClick={props.onDismiss}><X size={16} /></button>
    </section>
  </div>
}

function ThankYouFeedback({ phase }: { phase: 'in' | 'out' }) {
  return <div className={`feedback-thank-you ${phase}`} role="status"><Heart size={12} /><span>Thank you for your feedback!</span></div>
}

function CustomFeedbackCallout(props: { onGiveFeedback: () => void; onDismiss: () => void }) {
  return <div className="composer-above-row custom-feedback-callout-row">
    <section className="custom-feedback-callout" aria-label="Provide your feedback">
      <div className="custom-feedback-callout-copy"><Heart size={15} /><strong>Provide your feedback?</strong></div>
      <div className="custom-feedback-callout-actions">
        <button type="button" className="primary" onClick={props.onGiveFeedback}>Give feedback</button>
        <button type="button" onClick={props.onDismiss}>Dismiss</button>
      </div>
    </section>
  </div>
}

function PlanCard({ item }: { item: Extract<TimelineItem, { kind: 'plan' }> }) {
  const completed = item.plan.items.filter((entry) => entry.status === 'completed').length
  return (
    <section className="plan-card" aria-label="Plan">
      <div className="plan-heading">
        <ListChecks size={15} />
        <strong>Plan</strong>
        <span>{completed}/{item.plan.items.length}</span>
      </div>
      {item.plan.explanation && <p>{item.plan.explanation}</p>}
      <ol>
        {item.plan.items.map((entry) => (
          <li className={entry.status} data-plan-item-id={entry.id} key={entry.id}>
            <span className="plan-status-icon">
              {entry.status === 'completed' ? <Check size={12} /> : entry.status === 'in_progress' ? <LoaderCircle className="spin" size={12} /> : <i />}
            </span>
            <span className="plan-step">{entry.step}</span>
            <span className="plan-status-label">{entry.status === 'in_progress' ? 'In progress' : entry.status === 'completed' ? 'Completed' : 'Pending'}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function markdownHref(sessionId: string, href?: string): string {
  const value = href?.trim() || '#'
  if (value.startsWith('#') || value.startsWith('/')) return value
  if (/^(?:https?:|mailto:)/i.test(value)) return value
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '#'
  const path = value.replace(/^\.\//, '')
  if (/\.html?$/i.test(path)) {
    return `/workspace/${sessionId}/preview/${path.split('/').map((part) => encodeURIComponent(part)).join('/')}`
  }
  return `/workspace/${sessionId}/file?path=${encodeURIComponent(path)}`
}

function workspaceFileUrl(sessionId: string, path: string): string {
  if (STATIC_SHOWCASE) return showcaseAssetUrl(sessionId, path)
  return `/workspace/${sessionId}/file?path=${encodeURIComponent(path)}`
}

function workspacePreviewUrl(sessionId: string, path: string): string {
  if (STATIC_SHOWCASE) return showcaseAssetUrl(sessionId, path)
  return `/workspace/${sessionId}/preview/${path.split('/').map((part) => encodeURIComponent(part)).join('/')}`
}

export function workspaceEntryPreviewTarget(
  sessionId: string,
  entry: Pick<WorkspaceEntry, 'name' | 'path'>,
): PreviewTarget {
  const name = entry.name.toLowerCase()
  const html = /\.html?$/.test(name)
  const kind: ArtifactRecord['kind'] = html
    ? 'website'
    : /\.(?:png|jpe?g|gif|webp|svg|bmp)$/.test(name)
      ? 'image'
      : /\.(?:mp3|wav|aac|flac|opus|m4a|oga|ogg|aif|aiff)$/.test(name)
        ? 'audio'
        : /\.(?:mp4|webm|mov|m4v|ogv)$/.test(name)
          ? 'video'
          : name.endsWith('.md')
            ? 'markdown'
            : /\.(?:pdf|docx|xlsx|pptx)$/.test(name)
              ? 'document'
              : /\.(?:csv|tsv|json)$/.test(name)
                ? 'data'
                : /\.(?:zip|tar|gz)$/.test(name) ? 'archive' : 'file'
  const mime = html
    ? 'text/html'
    : name.endsWith('.md')
      ? 'text/markdown'
      : /\.(?:txt|css|env)$/.test(name) || name === '.env'
        ? 'text/plain'
        : /\.(?:[cm]?jsx?|tsx?)$/.test(name)
          ? 'text/javascript'
          : name.endsWith('.json')
            ? 'application/json'
            : name.endsWith('.csv')
              ? 'text/csv'
              : name.endsWith('.tsv')
                ? 'text/tab-separated-values'
                : /\.ya?ml$/.test(name)
                  ? 'application/x-yaml'
                  : name.endsWith('.toml')
                    ? 'application/toml'
                    : name.endsWith('.sql')
                      ? 'application/sql'
                      : /\.pyi?$/.test(name)
                        ? 'text/x-python'
                        : /\.(?:sh|bash|zsh)$/.test(name)
                          ? 'text/x-shellscript'
                          : name.endsWith('.pdf')
                            ? 'application/pdf'
                            : name.endsWith('.svg')
                              ? 'image/svg+xml'
                              : kind === 'image'
                                ? `image/${name.split('.').at(-1) === 'jpg' ? 'jpeg' : name.split('.').at(-1)}`
                                : kind === 'audio'
                                  ? `audio/${name.split('.').at(-1)}`
                                  : kind === 'video'
                                    ? `video/${name.split('.').at(-1)}`
                                    : 'application/octet-stream'
  return {
    url: html ? workspacePreviewUrl(sessionId, entry.path) : workspaceFileUrl(sessionId, entry.path),
    downloadUrl: `/api/sessions/${sessionId}/download?path=${encodeURIComponent(entry.path)}`,
    label: entry.path,
    kind,
    mime,
  }
}

function collectWebsiteEntries(entries: WorkspaceEntry[]): string[] {
  const paths: string[] = []
  const visit = (items: WorkspaceEntry[]) => {
    for (const entry of items) {
      if (entry.type === 'directory') visit(entry.children ?? [])
      else if (/\.html?$/i.test(entry.name)) paths.push(entry.path)
    }
  }
  visit(entries)
  return paths.sort((left, right) => left.localeCompare(right))
}

function previewFileName(path?: string): string {
  const name = path?.split('/').filter(Boolean).at(-1)?.trim()
  return name || 'index.html'
}

export function workspacePreviewPickerUrl(url: string): string {
  if (!url.startsWith('/workspace/')) return url
  const parsed = new URL(url, 'http://anera.local')
  parsed.searchParams.set('aneraElementPicker', '1')
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

type PreviewElementPickerMessage =
  | { type: 'ready' }
  | { type: 'cancelled' }
  | { type: 'selected'; selection: Omit<PreviewElementSelection, 'file'> }

export function parsePreviewElementPickerMessage(value: unknown): PreviewElementPickerMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input.type === 'anera.element-picker.ready') return { type: 'ready' }
  if (input.type === 'anera.element-picker.cancelled') return { type: 'cancelled' }
  if (input.type !== 'anera.element-picker.selected') return undefined
  const selection = input.selection
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return undefined
  const candidate = selection as Record<string, unknown>
  if (
    typeof candidate.selector !== 'string'
    || typeof candidate.tagName !== 'string'
    || typeof candidate.text !== 'string'
    || typeof candidate.outerHTML !== 'string'
  ) return undefined
  return {
    type: 'selected',
    selection: {
      selector: candidate.selector.slice(0, 500),
      tagName: candidate.tagName.slice(0, 80),
      text: candidate.text.slice(0, 1_000),
      outerHTML: candidate.outerHTML.slice(0, 4_000),
    },
  }
}

export function previewElementReference(selection: PreviewElementSelection): string {
  const text = selection.text.replace(/\s+/g, ' ').trim().slice(0, 180)
  return `[Selected element in ${selection.file}: ${selection.selector}${text ? ` — “${text}”` : ''}]`
}

export function previewSourceTokens(line: string): Array<{ text: string; kind: 'plain' | 'comment' | 'tag' | 'string' | 'number' | 'variable' }> {
  const tokens: Array<{ text: string; kind: 'plain' | 'comment' | 'tag' | 'string' | 'number' | 'variable' }> = []
  const pattern = /(<!--.*?-->|\/\*.*?\*\/|<\/?[A-Za-z][A-Za-z0-9:-]*|\/?>|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[0-9a-fA-F]{3,8}\b|--[A-Za-z0-9_-]+|\b\d+(?:\.\d+)?(?:px|rem|em|%|s|ms)?\b)/g
  let cursor = 0
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) tokens.push({ text: line.slice(cursor, index), kind: 'plain' })
    const text = match[0]
    const kind = text.startsWith('<!--') || text.startsWith('/*')
      ? 'comment'
      : text.startsWith('<') || text === '>' || text === '/>'
        ? 'tag'
        : text.startsWith('"') || text.startsWith("'")
          ? 'string'
          : text.startsWith('--')
            ? 'variable'
            : 'number'
    tokens.push({ text, kind })
    cursor = index + text.length
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor), kind: 'plain' })
  return tokens.length > 0 ? tokens : [{ text: line || ' ', kind: 'plain' }]
}

function PreviewSource({ source }: {
  source: PreviewSourceState
}) {
  return <div className="preview-code-layout">
    <div className="preview-source" aria-live="polite">
      {source.status === 'loading' && <div className="preview-source-state"><LoaderCircle className="spin" size={17} /> Loading source</div>}
      {source.status === 'failed' && <div className="preview-source-state error"><Info size={17} /> {source.error}</div>}
      {source.status === 'ready' && <pre aria-label="Raw source" tabIndex={0}><code>{source.content.split('\n').map((line, index) => (
        <span className="preview-source-line" key={index}>
          <span className="preview-source-line-number" aria-hidden="true">{index + 1}</span>
          <span>{previewSourceTokens(line).map((token, tokenIndex) => <span className={`source-token-${token.kind}`} key={tokenIndex}>{token.text}</span>)}</span>
        </span>
      ))}</code></pre>}
    </div>
  </div>
}

function ArtifactTextPreview({ source, markdown = false, sessionId }: {
  source: PreviewSourceState
  markdown?: boolean
  sessionId: string
}) {
  if (source.status === 'loading' || source.status === 'idle') {
    return <div className="preview-source-state"><LoaderCircle className="spin" size={17} /> Loading preview</div>
  }
  if (source.status === 'failed') {
    return <div className="preview-source-state error"><Info size={17} /> {source.error}</div>
  }
  if (!markdown) return <pre className="artifact-text-preview"><code>{source.content}</code></pre>
  return <div className="artifact-markdown-preview markdown"><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      a: ({ children, href, title }) => {
        const resolved = markdownHref(sessionId, href)
        return <a href={resolved} title={title} target={resolved.startsWith('#') ? undefined : '_blank'} rel={resolved.startsWith('#') ? undefined : 'noreferrer'}>{children}</a>
      },
    }}
  >{source.content}</ReactMarkdown></div>
}

function ArtifactDownloadPreview({ target }: { target: PreviewTarget }) {
  return <div className="artifact-download-preview">
    <FileText size={36} />
    <strong>{previewFileName(target.label)}</strong>
    <span>This file type is available to open or download.</span>
    <div>
      <a href={target.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open</a>
      <a href={target.downloadUrl || target.url} download={previewFileName(target.label)}><Download size={14} /> Download</a>
    </div>
  </div>
}

export interface OfficePreviewSection {
  title: string
  body: string
  index: number
}

export function officePreviewSections(preview: Pick<OfficeArtifactPreview, 'content'>): OfficePreviewSection[] {
  const matches = [...preview.content.matchAll(/^--- (.+?) ---\s*$/gm)]
  if (matches.length === 0) return preview.content.trim() ? [{ title: 'Document', body: preview.content.trim(), index: 1 }] : []
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = matches[index + 1]?.index ?? preview.content.length
    return { title: match[1].trim(), body: preview.content.slice(start, end).trim(), index: index + 1 }
  })
}

type OfficePreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: OfficeArtifactPreview }
  | { status: 'failed'; error: string }

function OfficeArtifactViewer({ sessionId, target, reloadKey }: { sessionId: string; target: PreviewTarget; reloadKey: number }) {
  const [state, setState] = useState<OfficePreviewState>({ status: 'loading' })
  useEffect(() => {
    if (!sessionId || !target.label) {
      setState({ status: 'failed', error: 'Document path is unavailable.' })
      return
    }
    const controller = new AbortController()
    setState({ status: 'loading' })
    void api.officeArtifactPreview(sessionId, target.label)
      .then((preview) => { if (!controller.signal.aborted) setState({ status: 'ready', preview }) })
      .catch((reason) => { if (!controller.signal.aborted) setState({ status: 'failed', error: messageOf(reason) }) })
    return () => controller.abort()
  }, [reloadKey, sessionId, target.label])
  if (state.status === 'loading') return <div className="preview-source-state"><LoaderCircle className="spin" size={17} /> Loading document</div>
  if (state.status === 'failed') return <div className="office-preview-failure">
    <Info size={20} /><strong>Document preview unavailable</strong><span>{state.error}</span>
    <a href={target.downloadUrl || target.url} download={previewFileName(target.label)}><Download size={14} /> Download file</a>
  </div>
  const sections = officePreviewSections(state.preview)
  return <div className={`office-preview office-${state.preview.format} ${state.preview.truncated ? 'truncated' : ''}`}>
    <header><strong>{state.preview.name}</strong><span>{state.preview.format.toUpperCase()} · {state.preview.totalItems ?? sections.length} {state.preview.unit}{(state.preview.totalItems ?? sections.length) === 1 ? '' : 's'}</span></header>
    {state.preview.truncated && <div className="office-preview-warning"><Info size={14} /> Preview truncated at {formatBytes(state.preview.outputBytes)}. Download the original for complete content.</div>}
    <div className="office-preview-content">
      {state.preview.format === 'xlsx'
        ? sections.map((section) => <SpreadsheetPreviewSection section={section} key={`${section.index}:${section.title}`} />)
        : state.preview.format === 'pptx'
          ? <div className="office-slide-grid">{sections.map((section) => <PresentationPreviewSection section={section} key={`${section.index}:${section.title}`} />)}</div>
          : sections.map((section) => <DocumentPreviewSection section={section} key={`${section.index}:${section.title}`} />)}
    </div>
  </div>
}

function DocumentPreviewSection({ section }: { section: OfficePreviewSection }) {
  const lines = section.body.split('\n').map((line) => line.trim()).filter(Boolean)
  return <article className="office-doc-page"><small>{section.title}</small>{lines.length > 0 ? lines.map((line, index) => <p key={`${index}:${line}`}>{line}</p>) : <p className="office-empty">Empty section</p>}</article>
}

function SpreadsheetPreviewSection({ section }: { section: OfficePreviewSection }) {
  const lines = section.body.split('\n').filter(Boolean)
  const rows = lines.flatMap((line) => {
    const match = line.match(/^Row\s+([^:]+):\s*(.*)$/)
    return match ? [{ label: match[1], cells: match[2].split(' | ') }] : []
  })
  const details = lines.filter((line) => !/^Row\s+([^:]+):/.test(line))
  return <section className="office-sheet"><h3>{section.title}</h3>
    {rows.length > 0 && <div className="office-sheet-grid">{rows.map((row) => <div className="office-sheet-row" key={row.label}><strong>{row.label}</strong>{row.cells.map((cell, index) => {
      const rendered = spreadsheetCellDisplay(cell)
      return <span key={`${index}:${cell}`} title={[rendered.reference, rendered.formula].filter(Boolean).join(' · ')}>{rendered.value}</span>
    })}</div>)}</div>}
    {details.map((line) => <small key={line}>{line}</small>)}
    {rows.length === 0 && details.length === 0 && <span className="office-empty">Empty sheet</span>}
  </section>
}

export function spreadsheetCellDisplay(cell: string): { reference: string; value: string; formula?: string } {
  const match = cell.match(/^([^=]+)=(.*?)(?: \[formula: (.*)\])?$/)
  if (!match) return { reference: '', value: cell }
  let value = match[2]
  try {
    const parsed = JSON.parse(value) as unknown
    value = typeof parsed === 'string' ? parsed : String(parsed)
  } catch {
    // Retain an extraction token that is not JSON-encoded.
  }
  return { reference: match[1], value, ...(match[3] ? { formula: `Formula: ${match[3]}` } : {}) }
}

function PresentationPreviewSection({ section }: { section: OfficePreviewSection }) {
  const [body, notes = ''] = section.body.split(/\nSpeaker notes:\n/, 2)
  return <article className="office-slide"><small>{section.title}</small><div>{body.split('\n').filter(Boolean).map((line, index) => index === 0 ? <h3 key={line}>{line}</h3> : <p key={`${index}:${line}`}>{line}</p>)}</div>{notes && <aside><strong>Speaker notes</strong><span>{notes}</span></aside>}</article>
}

export function ApprovalCard({ item, onDecision }: {
  item: Extract<TimelineItem, { kind: 'approval' }>
  onDecision: (approvalId: string, approved: boolean) => Promise<void>
}) {
  const [submitting, setSubmitting] = useState(false)
  const method = String(item.call.arguments.method || 'REQUEST')
  const url = String(item.call.arguments.url || '')
  return (
    <div className={`approval-card ${item.decision}`}>
      <div className="approval-symbol">!</div>
      <div className="approval-copy">
        <strong>{item.decision === 'pending' ? item.title : item.decision === 'approved' ? 'Request approved' : item.decision === 'expired' ? 'Approval expired' : 'Request denied'}</strong>
        <span>{item.description}</span>
        {url && <span><b>{method}</b> {url}</span>}
        {item.call.arguments.json_body !== undefined && <pre>{JSON.stringify(item.call.arguments.json_body, null, 2)}</pre>}
      </div>
      {item.decision === 'pending' && (
        <div className="approval-actions">
          <button disabled={submitting} onClick={() => void submitApprovalDecision(onDecision, item.approvalId, false, setSubmitting).catch(() => undefined)}>Deny</button>
          <button className="approve" disabled={submitting} onClick={() => void submitApprovalDecision(onDecision, item.approvalId, true, setSubmitting).catch(() => undefined)}>Approve</button>
        </div>
      )}
    </div>
  )
}

export async function submitApprovalDecision(
  onDecision: (approvalId: string, approved: boolean) => Promise<void>,
  approvalId: string,
  approved: boolean,
  setSubmitting: (submitting: boolean) => void,
): Promise<void> {
  setSubmitting(true)
  try {
    await onDecision(approvalId, approved)
  } catch (reason) {
    setSubmitting(false)
    throw reason
  }
}

function HitlCard({ item, sessionId, onResponse }: {
  item: HitlTimelineItem
  sessionId: string
  onResponse: (hitlId: string, response: Record<string, unknown>) => Promise<void>
}) {
  if (item.hitlKind === 'ask_user') return <AskUserHitl item={item} onResponse={onResponse} />
  if (item.hitlKind === 'propose_plan') return <PlanReviewHitl item={item} onResponse={onResponse} />
  if (item.hitlKind === 'generate_image') return <ImageSelectionHitl item={item} sessionId={sessionId} onResponse={onResponse} />
  return <VoiceSelectionHitl item={item} sessionId={sessionId} onResponse={onResponse} />
}

export function AskUserHitl({ item, onResponse }: {
  item: HitlTimelineItem
  onResponse: (hitlId: string, response: Record<string, unknown>) => Promise<void>
}) {
  const questions = Array.isArray(item.payload.questions)
    ? item.payload.questions.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    : []
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [freeText, setFreeText] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  if (item.decision !== 'pending') return <ResolvedHitl item={item} />
  const questionId = (question: Record<string, unknown>, index: number) => typeof question.id === 'string' ? question.id : `question-${index + 1}`
  const complete = questions.length > 0 && questions.every((question, index) => {
    const id = questionId(question, index)
    return Boolean(selected[id]) || Boolean(freeText[id]?.trim())
  })
  const submit = async (response: Record<string, unknown>) => {
    if (submitting) return
    setSubmitting(true)
    try { await onResponse(item.hitlId, response) }
    catch { setSubmitting(false) }
  }
  const hasCustomResponse = Object.values(freeText).some((value) => value.trim())
  const submitAnswers = () => void submit({
    answers: questions.map((question, index) => {
      const id = questionId(question, index)
      return {
        questionId: id,
        selectedOptionId: selected[id] || null,
        customResponse: freeText[id]?.trim() || null,
      }
    }),
  })
  const accessibleTitle = String(questions[0]?.question || item.title || 'Question')
  const lastQuestionAllowsCustom = questions.at(-1)?.allowCustomResponse !== false
  return <section className="hitl-card ask-user-card" role="dialog" aria-label={accessibleTitle}>
    {questions.map((question, index) => {
      const id = questionId(question, index)
      const questionText = String(question.question || `Question ${index + 1}`)
      const options = Array.isArray(question.options)
        ? question.options.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
        : []
      return <div className="ask-user-question" key={id}>
        <div className="ask-user-question-heading">
          <strong>{questionText}</strong>
          {index === 0 && <button className="ask-user-skip" type="button" disabled={submitting} onClick={() => void submit({ skipped: true })}>Skip</button>}
        </div>
        <div className="hitl-options" role="radiogroup" aria-label={questionText}>
          {options.map((option, optionIndex) => {
            const label = String(option.label || `Option ${optionIndex + 1}`)
            const optionId = String(option.id || `option-${optionIndex + 1}`)
            const active = selected[id] === optionId
            const inputId = `${item.hitlId}-${id}-${optionId}`
            return <label className={`hitl-option${active ? ' selected' : ''}`} htmlFor={inputId} key={optionId}>
              <input
                id={inputId}
                type="radio"
                name={`${item.hitlId}-${id}`}
                value={optionId}
                checked={active}
                onChange={() => {
                  setSelected((current) => ({ ...current, [id]: optionId }))
                  setFreeText((current) => ({ ...current, [id]: '' }))
                }}
              />
              <span><strong>{label}</strong>{typeof option.description === 'string' && option.description && <small>{option.description}</small>}</span>
            </label>
          })}
        </div>
        {question.allowCustomResponse !== false && <div className="ask-user-custom-response">
          <input
            type="text"
            value={freeText[id] ?? ''}
            placeholder="Revise options or write your own..."
            aria-label={`Custom answer for ${questionText}`}
            onChange={(event) => {
              const value = event.target.value
              setFreeText((current) => ({ ...current, [id]: value }))
              if (value) setSelected((current) => ({ ...current, [id]: '' }))
            }}
          />
          {index === questions.length - 1 && <button type="button" className="ask-user-submit" disabled={submitting || !complete} onClick={submitAnswers}>
            {hasCustomResponse ? 'Submit custom response' : 'Submit'}
          </button>}
        </div>}
      </div>
    })}
    {!lastQuestionAllowsCustom && <div className="ask-user-submit-row"><button type="button" className="ask-user-submit" disabled={submitting || !complete} onClick={submitAnswers}>Submit</button></div>}
  </section>
}

function PlanReviewHitl({ item, onResponse }: {
  item: HitlTimelineItem
  onResponse: (hitlId: string, response: Record<string, unknown>) => Promise<void>
}) {
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  if (item.decision !== 'pending') return <ResolvedHitl item={item} />
  const highlights = Array.isArray(item.payload.highlights) ? item.payload.highlights.map(String) : []
  const submit = async (response: Record<string, unknown>) => {
    if (submitting) return
    setSubmitting(true)
    try { await onResponse(item.hitlId, response) }
    catch { setSubmitting(false) }
  }
  return <section className="hitl-card plan-review-card" role="dialog" aria-label={item.title}>
    <div className="hitl-heading"><ListChecks size={16} /><strong>{item.title}</strong><code>{String(item.payload.path || '')}</code></div>
    {highlights.length > 0 && <ul>{highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>}
    {typeof item.payload.markdown === 'string' && <details><summary>View full plan</summary><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.payload.markdown}</ReactMarkdown></div></details>}
    <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Revision feedback (required to request changes)" />
    <div className="hitl-actions">
      <button type="button" disabled={submitting} onClick={() => void submit({ decision: 'reject', feedback })}>Reject</button>
      <button type="button" disabled={submitting || !feedback.trim()} onClick={() => void submit({ decision: 'revise', feedback })}>Request changes</button>
      <button type="button" className="primary" disabled={submitting} onClick={() => void submit({ decision: 'accept' })}>Accept plan</button>
    </div>
  </section>
}

function VoiceSelectionHitl({ item, sessionId, onResponse }: {
  item: HitlTimelineItem
  sessionId: string
  onResponse: (hitlId: string, response: Record<string, unknown>) => Promise<void>
}) {
  const [submitting, setSubmitting] = useState(false)
  if (item.decision !== 'pending') return <ResolvedHitl item={item} />
  const candidates = Array.isArray(item.payload.candidates)
    ? item.payload.candidates.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    : []
  const audition = String(item.payload.text || '')
  const previewVoice = (index: number) => {
    if (!('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(audition)
    const voices = window.speechSynthesis.getVoices()
    if (voices.length > 0) utterance.voice = voices[index % voices.length]
    window.speechSynthesis.speak(utterance)
  }
  return <section className="hitl-card voice-card" role="dialog" aria-label={item.title}>
    <div className="hitl-heading"><Volume2 size={16} /><strong>{item.title}</strong><small>{String(item.payload.language || '')}</small></div>
    <p>{audition}</p>
    <div className="voice-options">
      {candidates.map((candidate, index) => {
        const path = typeof candidate.path === 'string' ? candidate.path : ''
        return <div key={String(candidate.id)}>
          <strong>{String(candidate.label || `Voice ${index + 1}`)}</strong>
          {path
            ? <audio controls preload="metadata" src={workspaceFileUrl(sessionId, path)} aria-label={`Preview ${String(candidate.label || `Voice ${index + 1}`)}`} />
            : <button type="button" disabled={submitting} onClick={() => previewVoice(index)}>Preview locally</button>}
          <button type="button" className="primary" disabled={submitting} onClick={() => {
            setSubmitting(true)
            void onResponse(item.hitlId, { candidate_id: candidate.id }).catch(() => setSubmitting(false))
          }}>Use this voice</button>
        </div>
      })}
    </div>
  </section>
}

export function ImageSelectionHitl({ item, sessionId, onResponse }: {
  item: HitlTimelineItem
  sessionId: string
  onResponse: (hitlId: string, response: Record<string, unknown>) => Promise<void>
}) {
  const [submitting, setSubmitting] = useState(false)
  if (item.decision !== 'pending') return <ResolvedHitl item={item} />
  const candidates = Array.isArray(item.payload.candidates)
    ? item.payload.candidates.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    : []
  const submit = (response: Record<string, unknown>) => {
    if (submitting) return
    setSubmitting(true)
    void onResponse(item.hitlId, response).catch(() => setSubmitting(false))
  }
  return <section className="hitl-card image-selection-card" role="dialog" aria-label={item.title}>
    <div className="hitl-heading"><ImageIcon size={16} /><strong>{item.title}</strong></div>
    <div className="image-options">
      {candidates.map((candidate, index) => {
        const candidateIndex = typeof candidate.index === 'number' ? candidate.index : index
        const path = String(candidate.path || '')
        return <button type="button" key={String(candidate.id || candidateIndex)} disabled={submitting} onClick={() => submit({ selected_index: candidateIndex })}>
          {path && <img src={`/workspace/${sessionId}/file?path=${encodeURIComponent(path)}`} alt={`Generated option ${candidateIndex + 1}`} />}
          <span>Use option {candidateIndex + 1}</span>
        </button>
      })}
    </div>
    <div className="hitl-actions"><button type="button" disabled={submitting} onClick={() => submit({ skipped: true })}>Skip all</button></div>
  </section>
}

function ResolvedHitl({ item }: { item: HitlTimelineItem }) {
  const label = item.decision === 'expired'
    ? 'Request expired'
    : item.hitlKind === 'propose_plan'
      ? item.response?.decision === 'accepted' ? 'Plan accepted' : item.response?.decision === 'revise' ? 'Plan revision requested' : 'Plan rejected'
      : item.hitlKind === 'add_voice'
        ? 'Voice selected'
        : item.hitlKind === 'generate_image'
          ? item.response?.skipped === true ? 'No image selected' : 'Image selected'
          : item.response?.skipped === true ? 'Question dismissed' : 'Answered'
  return <section className={`hitl-card resolved ${item.decision}`}><Check size={15} /><strong>{label}</strong></section>
}

function ThoughtRow({ item }: { item: Extract<TimelineItem, { kind: 'thought' }> }) {
  const [open, setOpen] = useState(item.running || Boolean(item.content))
  useEffect(() => {
    if (item.running && item.content) setOpen(true)
  }, [item.content, item.running])
  return (
    <div className={`thought-row ${item.running ? 'running' : ''}`}>
      <button aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {item.running ? <LoaderCircle className="spin" size={14} /> : <BrainCircuit size={14} />}
        <span>{item.running ? 'Thinking...' : item.label}</span>
        <span className="thought-disclosure" aria-hidden="true">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
      </button>
      {open && item.content && <div className="thought-body">{item.content}</div>}
    </div>
  )
}

export function StreamingToolCallRow({ item }: { item: ToolCallDraftTimelineItem }) {
  const [open, setOpen] = useState(true)
  const write = streamedFileWrite(item)
  if (!write) return null
  const lines = write.content.split('\n')
  const visibleStart = Math.max(0, lines.length - 8)
  const visibleLines = lines.slice(visibleStart)
  const action = item.status === 'running' ? 'Writing' : 'Write interrupted'
  return <section className={`streaming-file-write ${item.status}`} aria-label={`${action} ${write.path}`}>
    <button type="button" className="streaming-file-write-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {item.status === 'running' ? <LoaderCircle className="spin" size={13} /> : <X size={13} />}
      <span>{action}</span>
      <code>{write.path}</code>
      <small>open</small>
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
    </button>
    {open && <div className="streaming-file-write-body">{visibleLines.map((line, index) => <div className="streaming-file-write-line" key={`${visibleStart + index}:${line}`}>
      <span>{visibleStart + index + 1}</span><code>{line || ' '}</code>
    </div>)}</div>}
  </section>
}

export function AssistantActivityRow({ item }: { item: Extract<TimelineItem, { kind: 'activity' }> }) {
  return <div className="assistant-activity" role="status">
    <LoaderCircle className="spin" size={14} aria-hidden="true" />
    <span>{item.label}</span>
  </div>
}

export function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(Boolean(item.autoExpanded))
  useEffect(() => setOpen(Boolean(item.autoExpanded)), [item.autoExpanded])
  const icon = item.name.includes('web') ? <Globe2 size={14} /> : item.name.includes('file') ? <FileCode2 size={14} /> : <TerminalSquare size={14} />
  const mutation = toolMutationSummary(item)
  const status = toolStatusSummary(item)
  return (
    <div className={`tool-row ${item.status}`} data-tool-name={item.name}>
      <button className="tool-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="tool-icon">{item.status === 'running' ? <LoaderCircle className="spin" size={14} /> : icon}</span>
        {mutation
          ? <span className="tool-label tool-label-mutation">
              <span>{mutation.action}</span>
              <code>{mutation.path}</code>
              {mutation.lines !== undefined && <small>{mutation.lines} line{mutation.lines === 1 ? '' : 's'}</small>}
              <small>open</small>
            </span>
          : <span className="tool-label">{toolTimelineLabel(item)}</span>}
        {(status.icon || status.text || status.duration) && <span className="tool-status" aria-label={status.accessibleLabel}>
            {status.icon}
            {status.text && <span>{status.text}</span>}
            {status.duration && <time>{status.duration}</time>}
          </span>}
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (COMMAND_DETAIL_TOOLS.has(item.name)
        ? <CommandToolBody item={item} />
        : <div className="tool-body"><pre>{JSON.stringify(item.args, null, 2)}</pre>{item.result && <pre>{item.result}</pre>}</div>)}
    </div>
  )
}

function CommandToolBody({ item }: { item: ToolTimelineItem }) {
  const presentation = commandToolPresentation(item)
  return <div className="tool-body command-tool-body">
    <CommandToolSection label="COMMAND" copyValue={presentation.command}>{`$ ${presentation.command}`}</CommandToolSection>
    {presentation.stdout && <CommandToolSection label="STDOUT" copyValue={presentation.stdout}>{presentation.stdout}</CommandToolSection>}
    {presentation.stderr && <CommandToolSection label="STDERR" copyValue={presentation.stderr}>{presentation.stderr}</CommandToolSection>}
  </div>
}

function CommandToolSection(props: { label: 'COMMAND' | 'STDOUT' | 'STDERR'; copyValue: string; children: string }) {
  const [copied, setCopied] = useState(false)
  return <section className="command-tool-section">
    <header>
      <span>{props.label}</span>
      <button type="button" aria-label={copied ? `${props.label} copied` : `Copy ${props.label.toLowerCase()}`} onClick={() => {
        void copyText(props.copyValue).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1_100)
        })
      }}>{copied ? <Check size={11} /> : <Copy size={11} />}<span>{copied ? 'Copied' : 'Copy'}</span></button>
    </header>
    <pre>{props.children}</pre>
  </section>
}

function toolMutationSummary(item: ToolTimelineItem): { action: string; path: string; lines?: number } | undefined {
  if (!['create_file', 'write_file', 'edit_file'].includes(item.name)) return undefined
  const path = String(item.args.path || 'file').replace(/^\/home\/user\//, '')
  const action = item.name === 'edit_file' ? 'Edit' : 'Write'
  const content = item.name === 'edit_file' ? undefined : item.args.content
  const lines = typeof content === 'string'
    ? content.length === 0 ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
    : undefined
  return { action, path, ...(lines !== undefined ? { lines } : {}) }
}

function toolStatusSummary(item: ToolTimelineItem): {
  icon: ReactNode
  text?: string
  duration?: string
  accessibleLabel: string
} {
  const duration = item.durationMs === undefined ? undefined : formatCompactDuration(item.durationMs)
  if (item.status === 'running') {
    return { icon: null, accessibleLabel: 'Running' }
  }
  if (item.status === 'timed_out') {
    return { icon: <X size={12} />, text: 'timed out', duration, accessibleLabel: `Timed out${duration ? ` after ${duration}` : ''}` }
  }
  if (item.status === 'failed') {
    const exitCode = toolResultNumber(item.result, 'exit_code')
    const text = exitCode === undefined ? 'failed' : `exit ${exitCode}`
    return { icon: <X size={12} />, text, duration, accessibleLabel: `Failed${exitCode === undefined ? '' : ` with exit code ${exitCode}`}${duration ? ` after ${duration}` : ''}` }
  }
  if (item.name === 'bash' || item.name === 'shell_command') {
    return { icon: <Check size={12} />, duration, accessibleLabel: `Succeeded${duration ? ` in ${duration}` : ''}` }
  }
  return { icon: null, accessibleLabel: `Succeeded${duration ? ` in ${duration}` : ''}` }
}

function toolResultNumber(result: string | undefined, field: string): number | undefined {
  if (!result) return undefined
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>
    return typeof parsed[field] === 'number' && Number.isFinite(parsed[field]) ? parsed[field] : undefined
  } catch {
    return undefined
  }
}

function ExplorationGroup({ item }: { item: Extract<TimelineItem, { kind: 'exploration' }> }) {
  const [open, setOpen] = useState(false)
  const status = item.tools.some((tool) => tool.status === 'running')
    ? 'running'
    : item.tools.some((tool) => tool.status === 'timed_out')
      ? 'timed_out'
      : item.tools.some((tool) => tool.status === 'failed') ? 'failed' : 'succeeded'
  const completed = item.tools.filter((tool) => tool.status !== 'running').length
  return (
    <section className={`exploration-group ${status}`} aria-label="Workspace exploration">
      <button className="exploration-head" onClick={() => setOpen((value) => !value)}>
        <span className="tool-icon">{status === 'running' ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}</span>
        <span className="exploration-label">{status === 'running' ? 'Exploring workspace' : 'Explored workspace'}</span>
        <span className="exploration-count">{completed}/{item.tools.length}</span>
        <span className="tool-status">{status === 'running' ? 'Running' : status === 'timed_out' ? 'Timed out' : status === 'failed' ? 'Failed' : 'Done'}</span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && <div className="exploration-body">{item.tools.map((tool) => <ExplorationTool key={tool.key} tool={tool} />)}</div>}
    </section>
  )
}

function ExplorationTool({ tool }: { tool: Extract<TimelineItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`exploration-item ${tool.status}`}>
      <button onClick={() => setOpen((value) => !value)}>
        <span className="exploration-item-dot">{tool.status === 'running' ? <LoaderCircle className="spin" size={11} /> : tool.status === 'succeeded' ? <Check size={11} /> : <X size={11} />}</span>
        <span>{toolLabel(tool.name, tool.args, tool.status)}</span>
        <i>{tool.status === 'running' ? 'Running' : tool.status === 'timed_out' ? 'Timed out' : tool.status === 'failed' ? 'Failed' : 'Done'}</i>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && <div className="exploration-item-body"><pre>{JSON.stringify(tool.args, null, 2)}</pre>{tool.result && <pre>{tool.result}</pre>}</div>}
    </div>
  )
}

export function ArenaToolGroup({ item }: { item: Extract<TimelineItem, { kind: 'tool-group' }> }) {
  const autoExpandedToolKey = item.tools.find((tool) => tool.autoExpanded)?.key
  const [open, setOpen] = useState(Boolean(autoExpandedToolKey))
  useEffect(() => setOpen(Boolean(autoExpandedToolKey)), [autoExpandedToolKey])
  const status = item.tools.some((tool) => tool.status === 'running')
    ? 'running'
    : item.tools.some((tool) => tool.status === 'timed_out')
      ? 'timed_out'
      : item.tools.some((tool) => tool.status === 'failed') ? 'failed' : 'succeeded'
  const completed = item.tools.filter((tool) => tool.status !== 'running').length
  const label = item.variant === 'commands'
    ? status === 'running' ? 'Running commands' : 'Ran commands'
    : status === 'running' ? 'Editing files' : 'Edited files'
  return (
    <section className={`arena-tool-group ${item.variant} ${status}`} aria-label={item.variant === 'commands' ? 'Command execution' : 'File edits'}>
      <button className="arena-tool-group-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="tool-icon">{status === 'running'
          ? <LoaderCircle className="spin" size={14} />
          : item.variant === 'commands' ? <TerminalSquare size={14} /> : <FileCode2 size={14} />}</span>
        <span className="arena-tool-group-label">{label}</span>
        <span className="arena-tool-group-count">{completed}/{item.tools.length}</span>
        <span className="tool-status">{status === 'running' ? 'Running' : status === 'timed_out' ? 'Timed out' : status === 'failed' ? 'Failed' : 'Done'}</span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && <div className="arena-tool-group-body">{item.tools.map((tool) => <ToolRow item={tool} key={tool.key} />)}</div>}
    </section>
  )
}

function ArtifactCard({ artifact, onPreview }: { artifact: ArtifactRecord; onPreview: () => void }) {
  const canPreviewWebsite = artifact.kind === 'website'
  const format = artifact.name.includes('.') ? artifact.name.split('.').at(-1)!.toUpperCase() : artifact.kind.toUpperCase()
  const icon = artifact.kind === 'image'
    ? <ImageIcon size={18} />
    : artifact.kind === 'audio'
      ? <Volume2 size={18} />
      : artifact.kind === 'video'
        ? <Play size={18} />
        : artifact.kind === 'archive' ? <Archive size={18} /> : <FileText size={18} />
  if (canPreviewWebsite) return <section className="artifact-card website-artifact">
    <header className="website-artifact-heading">
      <div className="artifact-icon"><FileCode2 size={16} /></div>
      <div className="artifact-copy"><strong>{artifact.name}</strong><span>{artifact.path}</span></div>
      <button className="artifact-format" aria-label={`Open ${artifact.name} preview`} onClick={onPreview}>{format}</button>
      <a href={artifact.downloadUrl} aria-label={`Download ${artifact.name}`}><Download size={15} /></a>
    </header>
    {artifact.previewUrl && <div className="website-artifact-preview">
      <iframe
        title={`Inline preview of ${artifact.name}`}
        src={artifact.previewUrl}
        sandbox="allow-scripts allow-modals allow-downloads"
        referrerPolicy="no-referrer"
      />
    </div>}
  </section>
  return (
    <div className="artifact-card">
      <div className="artifact-icon">{icon}</div>
      <div className="artifact-copy"><strong>{artifact.name}</strong><span>{artifact.path}</span></div>
      {artifact.previewUrl && <button className="artifact-format artifact-open" onClick={onPreview} aria-label={`Open ${artifact.name}`}>{format}</button>}
      {!artifact.previewUrl && <span className="artifact-format artifact-format-static">{format}</span>}
      <a href={artifact.downloadUrl} aria-label={`Download ${artifact.name}`}><Download size={15} /></a>
    </div>
  )
}

export function WorkspacePanel(props: {
  snapshot?: SessionSnapshot
  inventory?: WorkspaceInventoryView
  persistence?: WorkspacePersistenceView
  writeDrafts?: WorkspaceWriteDraft[]
  onOpenFile: (entry: WorkspaceEntry) => void
  onLoadMore: () => Promise<void>
  onRefresh: () => Promise<void>
  onPreview: () => void
  onRestart: () => Promise<void>
}) {
  const [websiteRestarting, setWebsiteRestarting] = useState(false)
  const snapshot = props.snapshot
  const website = snapshot?.website
  const deployment = snapshot?.deployment
  const processes = snapshot?.processes ?? []
  const websiteProcess = website?.processId
    ? processes.find((process) => process.id === website.processId)
    : undefined
  const websiteName = websiteProcess?.name || 'Website'
  const websitePort = website?.port ?? websiteProcess?.port
  const inventoryEntries = props.inventory?.entries ?? snapshot?.workspace ?? []
  const baseWorkspaceBytes = props.persistence?.bytes ?? snapshot?.session.workspaceBytes ?? 0
  const baseWorkspaceFiles = props.persistence?.fileCount
    ?? props.inventory?.totalFiles
    ?? snapshot?.workspaceInventory?.totalFiles
    ?? countFiles(inventoryEntries)
  const writeDrafts = [...new Map((props.writeDrafts ?? []).map((draft) => [draft.path, draft])).values()]
  const draftBytesDelta = writeDrafts.reduce((total, draft) => (
    total + draft.bytes - (workspaceFileSize(inventoryEntries, draft.path) ?? 0)
  ), 0)
  const draftFileDelta = writeDrafts.filter((draft) => workspaceFileSize(inventoryEntries, draft.path) === undefined).length
  const workspaceBytes = Math.max(0, baseWorkspaceBytes + draftBytesDelta)
  const workspaceFiles = baseWorkspaceFiles + draftFileDelta
  const inventoryTruncated = props.inventory?.truncated ?? snapshot?.workspaceInventory?.truncated ?? false
  const inventoryMetadata: WorkspaceInventoryMetadata = {
    hasMore: props.inventory?.hasMore ?? snapshot?.workspaceInventory?.hasMore ?? false,
    truncated: inventoryTruncated,
    totalFiles: props.inventory?.totalFiles ?? snapshot?.workspaceInventory?.totalFiles ?? workspaceFiles,
    fileLimitHit: props.inventory?.fileLimitHit ?? snapshot?.workspaceInventory?.fileLimitHit,
    entryLimitHit: props.inventory?.entryLimitHit ?? snapshot?.workspaceInventory?.entryLimitHit,
    totalFilesIsLowerBound: props.inventory?.totalFilesIsLowerBound ?? snapshot?.workspaceInventory?.totalFilesIsLowerBound,
  }
  const truncationMessage = workspaceInventoryTruncationMessage(inventoryMetadata)
  const inventoryLoading = props.inventory?.status === 'loading'
  const inventoryRefreshing = props.inventory?.status === 'refreshing'
  const continuationUnavailable = Boolean(props.inventory?.hasMore && !props.inventory.nextCursor)
  const showWebsite = Boolean(website && website.status !== 'stopped')
  const showDeployment = Boolean(deployment && (
    deployment.status !== 'not_deployed'
    || deployment.revision > 0
    || deployment.url
  ))
  return (
    <aside className="workspace-panel">
      <div className="workspace-card">
        <div className="workspace-heading">
          <strong>Workspace</strong>
          {props.persistence && <span className={`workspace-persistence-heading ${props.persistence.phase}`} role="status">
            {props.persistence.phase === 'saved'
              ? <Check size={10} aria-hidden="true" />
              : <LoaderCircle className="spin" size={10} aria-hidden="true" />}
            <span>{workspacePersistenceSidebarLabel(props.persistence)}</span>
          </span>}
          <button
            type="button"
            disabled={!snapshot || inventoryLoading || inventoryRefreshing}
            onClick={() => void props.onRefresh()}
            aria-label="Refresh workspace files"
            title="Refresh workspace files"
          >{inventoryRefreshing ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}</button>
          {STATIC_SHOWCASE
            ? <button type="button" disabled aria-label="Download workspace unavailable in static replay" title="Workspace download is unavailable in the static replay"><Download size={13} /></button>
            : <a
                href={snapshot ? `/api/sessions/${snapshot.session.id}/workspace.zip` : '#'}
                aria-label="Download workspace"
                title="Download workspace"
              ><Download size={13} /></a>}
        </div>
        <div className="workspace-usage">
          <div>
            <span>{formatBytes(workspaceBytes).replace(' ', '')}/128.0MB</span>
            <span>{workspaceFileUsageLabel(workspaceFiles, inventoryMetadata)}</span>
          </div>
          <div className="usage-track"><i style={{ width: `${Math.min(100, (workspaceBytes / (128 * 1024 * 1024)) * 100)}%` }} /></div>
        </div>

        {showWebsite && <div className={`workspace-resource-row website-panel ${website?.status || 'stopped'}`}>
          <button
            className="workspace-resource-main"
            disabled={website?.status !== 'running' || !website.previewUrl}
            onClick={props.onPreview}
          >
            <Globe2 size={14} />
            <span>{websiteName}</span>
            <span className={`website-state ${website?.status || 'stopped'}`}>
              {websitePort === undefined ? `· ${websiteStatusLabel(website?.status).toLowerCase()}` : `:${websitePort}`}
            </span>
          </button>
          <button
            className="workspace-resource-action"
            disabled={STATIC_SHOWCASE || websiteRestarting || (!website?.entryPath && !website?.processId)}
            onClick={() => void submitWebsiteRestart(props.onRestart, setWebsiteRestarting).catch(() => undefined)}
            aria-busy={websiteRestarting || undefined}
            aria-label="Restart Website"
            title={STATIC_SHOWCASE ? 'Website restart is disabled in the static replay' : 'Restart'}
          >{websiteRestarting ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}</button>
          {website?.entryPath
            ? <span className="website-path">{website.entryPath}</span>
            : website?.port
              ? <span className="website-path">localhost:{website.port}</span>
              : null}
        </div>}

        {showDeployment && <div className="workspace-resource-row deployment-panel">
          {deployment?.url
            ? <a className="workspace-resource-main deployment-url" href={deployment.url} target="_blank" rel="noreferrer">
              <CloudUpload size={14} />
              <span>Deployment</span>
              <span className={`website-state ${deployment.status === 'deployed' ? 'running' : deployment.status === 'building' || deployment.status === 'deploying' ? 'starting' : deployment.status === 'failed' ? 'failed' : 'stopped'}`}>· {deployment.status.replace('_', ' ')}</span>
            </a>
            : <div className="workspace-resource-main">
              <CloudUpload size={14} />
              <span>Deployment</span>
              <span className={`website-state ${deployment?.status === 'failed' ? 'failed' : 'starting'}`}>· {deployment?.status.replace('_', ' ')}</span>
            </div>}
          {(deployment?.revision ?? 0) > 0 && <i className="workspace-resource-revision">v{deployment!.revision}</i>}
          {deployment?.error && <span className="deployment-error">{deployment.error}</span>}
        </div>}

        <details className="workspace-processes">
          <summary><ChevronRight size={12} /><span>Processes</span><i>{processes.length}</i></summary>
          {processes.length === 0
            ? <div className="empty-copy padded">No active processes</div>
            : <div className="process-list">{processes.map((process) => <ProcessItem process={process} key={process.id} />)}</div>}
        </details>

        <div className="workspace-files">
          {writeDrafts.length > 0 && <div className="workspace-draft-list" aria-label="Files being written">{writeDrafts.map((draft) => <div
            className="file-node workspace-draft-file"
            key={draft.key}
            title={`${draft.path} is being generated and is not committed yet`}
          >
            <LoaderCircle className="spin" size={12} />
            <FileTypeIcon name={draft.path} />
            <span>{draft.path.split('/').at(-1)}</span>
            <i>{formatBytes(draft.bytes)}</i>
          </div>)}</div>}
          {inventoryEntries.length === 0 && writeDrafts.length === 0
            ? <div className="empty-copy padded">Files created by the agent appear here.</div>
            : inventoryEntries.length > 0 && <FileTree entries={inventoryEntries} onOpenFile={props.onOpenFile} />}
          {inventoryLoading && <div className="workspace-inventory-status" role="status"><LoaderCircle className="spin" size={12} /> Loading more files...</div>}
          {inventoryRefreshing && <div className="workspace-inventory-status" role="status"><LoaderCircle className="spin" size={12} /> Refreshing file inventory...</div>}
          {props.inventory?.status === 'failed' && <div className="workspace-inventory-status error" role="alert">
            <Info size={12} />
            <span>{props.inventory.error || 'Workspace files could not be loaded.'}</span>
            {props.inventory.hasMore && props.inventory.nextCursor && <button type="button" onClick={() => void props.onLoadMore()}>Retry</button>}
            <button type="button" onClick={() => void props.onRefresh()}>Refresh</button>
          </div>}
          {continuationUnavailable && props.inventory?.status !== 'failed' && <div className="workspace-inventory-status error" role="alert">
            <Info size={12} />
            <span>More files exist, but this continuation is unavailable.</span>
            <button type="button" onClick={() => void props.onRefresh()}>Refresh</button>
          </div>}
          {props.inventory?.hasMore && props.inventory.nextCursor && props.inventory.status !== 'failed' && <button
            type="button"
            className="workspace-load-more"
            disabled={inventoryLoading || inventoryRefreshing}
            onClick={() => void props.onLoadMore()}
          >{inventoryLoading ? 'Loading...' : 'Load more files'}</button>}
          {truncationMessage && <div className="workspace-inventory-status truncated" role="status">
            <Info size={12} />
            <span>{truncationMessage}</span>
          </div>}
        </div>
      </div>
    </aside>
  )
}

export async function submitWebsiteRestart(
  onRestart: () => Promise<void>,
  setRestarting: (restarting: boolean) => void,
): Promise<void> {
  setRestarting(true)
  try {
    await onRestart()
  } finally {
    setRestarting(false)
  }
}

function ProcessItem({ process }: { process: ProcessRecord }) {
  const port = process.port ?? process.newPorts?.[0]?.port ?? process.listeningPorts?.[0]?.port
  const metadata = [process.pid ? `PID ${process.pid}` : '', port ? `port ${port}` : '', process.status].filter(Boolean).join(' · ')
  return <div className="process-item">
    <TerminalSquare size={13} />
    <div>
      <strong>{process.name || 'Process'}</strong>
      <span className="process-command">{process.command}</span>
      <small>{metadata}</small>
    </div>
    <span className={`state-dot ${process.status === 'running' ? 'running' : 'stopped'}`} />
  </div>
}

function FileTree({ entries, onOpenFile, depth = 0 }: { entries: WorkspaceEntry[]; onOpenFile: (entry: WorkspaceEntry) => void; depth?: number }) {
  return <div className="file-tree">{entries.map((entry) => <WorkspaceFileNode key={entry.path} entry={entry} onOpenFile={onOpenFile} depth={depth} />)}</div>
}

export function WorkspaceFileNode({ entry, onOpenFile, depth }: { entry: WorkspaceEntry; onOpenFile: (entry: WorkspaceEntry) => void; depth: number }) {
  const [open, setOpen] = useState(depth === 0)
  if (entry.type === 'directory') return <div><button type="button" className="file-node" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => setOpen((value) => !value)}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Folder size={14} /><span>{entry.name}</span></button>{open && <FileTree entries={entry.children ?? []} onOpenFile={onOpenFile} depth={depth + 1} />}</div>
  return <button type="button" className="file-node" style={{ paddingLeft: 28 + depth * 14 }} onClick={() => onOpenFile(entry)}><FileTypeIcon name={entry.name} /><span>{entry.name}</span><i>{entry.size !== undefined ? formatBytes(entry.size) : ''}</i></button>
}

function FileTypeIcon({ name }: { name: string }) {
  if (/\.(html|css|js|ts|tsx|json)$/i.test(name)) return <FileCode2 size={14} />
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(name)) return <ImageIcon size={14} />
  return <FileText size={14} />
}

export interface TaskReviewState {
  messageEventId: string
  turnId?: string
  stepId?: string
}

export type TerminalFeedbackState = TaskReviewState & { variant: 'check_in' | 'task_completion_bar' }

/** Resolve Arena's post-evaluation custom-feedback experiment entry. */
export function resolveCustomFeedbackOffer(snapshot?: SessionSnapshot): CustomFeedbackOffer | undefined {
  const arm = snapshot?.session.customFeedbackArm
  if (!snapshot || snapshot.session.status !== 'completed' || (arm !== 'treatment-1' && arm !== 'treatment-2')) return undefined
  const undoneTurnIds = new Set(snapshot.events.flatMap((event) => {
    if (event.type !== 'turn.undone') return []
    const values = (event.data as { targetTurnIds?: unknown }).targetTurnIds
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : []
  }))
  const activeEvents = snapshot.events.filter((event) => !event.turnId || !undoneTurnIds.has(event.turnId))
  const final = [...activeEvents].reverse().find((event) => event.type === 'assistant.final')
  if (!final) return undefined
  const request = [...activeEvents].reverse().find((event) => (
    event.type === 'review.requested'
    && (event.data as { messageEventId?: unknown }).messageEventId === final.id
  ))
  if (!request) return undefined
  const requestedType = (request.data as { feedbackType?: unknown }).feedbackType
  const feedbackType = requestedType === 'task_completion_bar' || requestedType === 'check_in'
    ? requestedType
    : snapshot.session.feedbackType ?? 'check_in'
  const eligible = activeEvents.some((event) => {
    if (event.seq <= final.seq) return false
    const data = event.data as { messageEventId?: unknown; sessionNodeId?: unknown; checkInAction?: unknown; value?: unknown }
    if (data.messageEventId !== final.id && data.sessionNodeId !== final.id) return false
    if (feedbackType === 'task_completion_bar') {
      return event.type === 'task.completion.updated'
        && (data.value === 'no' || data.value === 'making_progress' || data.value === 'yes')
    }
    return (event.type === 'feedback.updated' || event.type === 'review.dismissed')
      && (data.checkInAction === 'approve' || data.checkInAction === 'disapprove' || data.checkInAction === 'edit')
  })
  if (!eligible) return undefined
  const alreadySubmitted = activeEvents.some((event) => {
    if (event.type !== 'turn.started') return false
    const data = event.data as { reviewedNodeId?: unknown; customFeedbackTurn?: unknown }
    return data.customFeedbackTurn === true && data.reviewedNodeId === final.id
  })
  return alreadySubmitted ? undefined : { messageEventId: final.id, arm }
}

export function resolveTerminalFeedback(snapshot?: SessionSnapshot, timeline = projectTimeline(snapshot)): TerminalFeedbackState | undefined {
  if (!snapshot || snapshot.session.status !== 'completed') return undefined
  let final: Extract<TimelineItem, { kind: 'final' }> | undefined
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index]
    if (item.kind === 'final' && !item.streaming && item.messageEventId) {
      final = item
      break
    }
  }
  if (!final?.messageEventId) return undefined
  const event = snapshot.events.find((candidate) => candidate.id === final.messageEventId)
  const requested = [...snapshot.events].reverse().find((candidate) => (
    candidate.type === 'review.requested'
    && (candidate.data as { messageEventId?: unknown }).messageEventId === final.messageEventId
  ))
  const requestedType = (requested?.data as { feedbackType?: unknown } | undefined)?.feedbackType
  const variant = snapshot.session.feedbackType === 'task_completion_bar' || requestedType === 'task_completion_bar'
    ? 'task_completion_bar'
    : 'check_in'
  if (variant === 'task_completion_bar') {
    if (!requested) return undefined
    const completed = snapshot.events.some((candidate) => (
      candidate.type === 'task.completion.updated'
      && ((candidate.data as { sessionNodeId?: unknown; messageEventId?: unknown }).sessionNodeId === final.messageEventId
        || (candidate.data as { messageEventId?: unknown }).messageEventId === final.messageEventId)
    ))
    if (completed) return undefined
  } else {
    if (final.feedback !== null) return undefined
    const dismissed = snapshot.events.some((candidate) => (
      candidate.type === 'review.dismissed'
      && (candidate.data as { messageEventId?: unknown }).messageEventId === final.messageEventId
    ))
    if (dismissed) return undefined
  }
  return { variant, messageEventId: final.messageEventId, turnId: event?.turnId, stepId: event?.stepId }
}

export function resolveTaskReview(snapshot?: SessionSnapshot, timeline = projectTimeline(snapshot)): TaskReviewState | undefined {
  const feedback = resolveTerminalFeedback(snapshot, timeline)
  return feedback?.variant === 'check_in'
    ? { messageEventId: feedback.messageEventId, turnId: feedback.turnId, stepId: feedback.stepId }
    : undefined
}

export function resolveTaskCompletion(snapshot?: SessionSnapshot, timeline = projectTimeline(snapshot)): TaskReviewState | undefined {
  const feedback = resolveTerminalFeedback(snapshot, timeline)
  return feedback?.variant === 'task_completion_bar'
    ? { messageEventId: feedback.messageEventId, turnId: feedback.turnId, stepId: feedback.stepId }
    : undefined
}

export function resolveUndoTurnCandidate(
  snapshot: SessionSnapshot | undefined,
  sessionNodeId: string,
): UndoTurnCandidate | undefined {
  if (!snapshot || snapshot.session.status !== 'completed' || snapshot.session.feedbackType === 'task_completion_bar') return undefined
  const undoneTurnIds = new Set(snapshot.events.flatMap((event) => {
    if (event.type !== 'turn.undone') return []
    const values = (event.data as { targetTurnIds?: unknown }).targetTurnIds
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : []
  }))
  const activeEvents = snapshot.events.filter((event) => !event.turnId || !undoneTurnIds.has(event.turnId))
  const finalIndex = activeEvents.findIndex((event) => event.id === sessionNodeId && event.type === 'assistant.final')
  if (finalIndex < 0) return undefined
  const latestFinal = [...activeEvents].reverse().find((event) => event.type === 'assistant.final')
  if (latestFinal?.id !== sessionNodeId) return undefined
  let promptEvent: SessionEvent | undefined
  for (let index = finalIndex; index >= 0; index -= 1) {
    if (activeEvents[index]?.type === 'turn.started') {
      promptEvent = activeEvents[index]
      break
    }
  }
  if (!promptEvent?.turnId) return undefined
  if (activeEvents.some((event) => event.type === 'context.compacted' && event.seq > promptEvent!.seq)) return undefined
  const targetTurnIds = [...new Set(activeEvents
    .filter((event) => event.seq >= promptEvent!.seq && event.turnId)
    .map((event) => event.turnId as string))]
  if (targetTurnIds.length === 0) return undefined
  return {
    sessionNodeId,
    promptText: String((promptEvent.data as { content?: unknown }).content ?? ''),
    targetTurnIds,
  }
}

export function projectTimeline(
  snapshot?: SessionSnapshot,
  optimisticUndoneTurnIds: ReadonlySet<string> = new Set(),
): TimelineItem[] {
  if (!snapshot) return []
  const items: TimelineItem[] = []
  const undoneTurnIds = new Set(optimisticUndoneTurnIds)
  for (const event of snapshot.events) {
    if (event.type !== 'turn.undone') continue
    const values = (event.data as { targetTurnIds?: unknown }).targetTurnIds
    if (!Array.isArray(values)) continue
    for (const value of values) if (typeof value === 'string') undoneTurnIds.add(value)
  }
  const visibleEvents = snapshot.events.filter((event) => (
    event.type !== 'turn.undone' && (!event.turnId || !undoneTurnIds.has(event.turnId))
  ))
  const stepsWithToolCalls = new Set(visibleEvents
    .filter((event) => event.type === 'tool.started' && event.stepId)
    .map((event) => event.stepId as string))
  const thoughts = new Map<string, Extract<TimelineItem, { kind: 'thought' }>>()
  const tools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>()
  const toolStartedAt = new Map<string, string>()
  const artifacts = new Map<string, Extract<TimelineItem, { kind: 'artifact' }>>()
  const finals = new Map<string, Extract<TimelineItem, { kind: 'final' }>>()
  const finalsByMessageEvent = new Map<string, Extract<TimelineItem, { kind: 'final' }>>()
  const approvals = new Map<string, Extract<TimelineItem, { kind: 'approval' }>>()
  const hitls = new Map<string, HitlTimelineItem>()
  const hitlAnswers = new Map<string, Extract<TimelineItem, { kind: 'user' }>>()
  const streamedToolCalls = new Map<string, {
    stepId: string
    streamIndex: number
    name: string
    argumentsText: string
    item?: ToolCallDraftTimelineItem
  }>()
  let visiblePlan: Extract<TimelineItem, { kind: 'plan' }> | undefined
  let assistantActivity: Extract<TimelineItem, { kind: 'activity' }> | undefined
  let activeAutoExpandedTool: Extract<TimelineItem, { kind: 'tool' }> | undefined
  const clearAssistantActivity = () => {
    if (!assistantActivity) return
    const index = items.indexOf(assistantActivity)
    if (index >= 0) items.splice(index, 1)
    assistantActivity = undefined
  }
  const clearAutoExpandedTool = () => {
    if (!activeAutoExpandedTool) return
    delete activeAutoExpandedTool.autoExpanded
    activeAutoExpandedTool = undefined
  }
  const beginVisibleActivity = () => {
    clearAssistantActivity()
    clearAutoExpandedTool()
  }
  for (const event of visibleEvents) {
    const data = event.data as Record<string, any>
    if (event.type === 'turn.started') {
      beginVisibleActivity()
      const customFeedbackTurn = data.customFeedbackTurn === true && typeof data.reviewedNodeId === 'string'
      items.push({
        kind: 'user',
        key: event.id,
        content: String(data.content || ''),
        attachments: Array.isArray(data.attachments) ? data.attachments : [],
        ...(customFeedbackTurn ? { customFeedbackTurn: true, reviewedNodeId: data.reviewedNodeId } : {}),
      })
    } else if (event.type === 'assistant.started') {
      beginVisibleActivity()
      assistantActivity = { kind: 'activity', key: `activity-${event.id}`, label: 'Orchestrating...' }
      items.push(assistantActivity)
    } else if (event.type === 'run.resumed') {
      beginVisibleActivity()
      items.push({ kind: 'thought', key: `resume-${event.id}`, label: 'Continued run', content: String(data.message || ''), running: false })
    } else if (event.type === 'context.compacted') {
      beginVisibleActivity()
      items.push({
        kind: 'thought',
        key: `checkpoint-${event.id}`,
        label: 'Context checkpoint',
        content: String(data.summary || ''),
        running: false,
      })
    } else if (event.type === 'assistant.thought.started' || event.type === 'assistant.thought.delta' || event.type === 'assistant.thought.completed') {
      beginVisibleActivity()
      const key = `${event.stepId || event.id}${data.visibleProgress ? '-progress' : ''}`
      let thought = thoughts.get(key)
      if (!thought) {
        thought = { kind: 'thought', key: `thought-${key}`, label: 'Thought', content: '', running: true }
        thoughts.set(key, thought)
        items.push(thought)
      }
      if (event.type === 'assistant.thought.delta') thought.content += String(data.delta || '')
      if (event.type === 'assistant.thought.completed') {
        thought.content = String(data.text || thought.content)
        thought.running = false
        thought.label = data.compacted ? 'Context checkpoint' : `Thought${thought.content ? ` for ${formatDuration(Date.parse(event.at) - Date.parse(visibleEvents.find((item) => item.stepId === event.stepId && item.type === 'assistant.started')?.at || event.at))}` : ''}`
      }
    } else if (event.type === 'assistant.tool_call.delta') {
      const streamIndex = Number.isInteger(data.index) && data.index >= 0 ? Number(data.index) : 0
      const stepId = event.stepId || event.id
      const key = `${stepId}:${streamIndex}`
      const streamed = streamedToolCalls.get(key) ?? {
        stepId,
        streamIndex,
        name: '',
        argumentsText: '',
      }
      streamed.name += typeof data.nameDelta === 'string' ? data.nameDelta : ''
      streamed.argumentsText += typeof data.argumentsDelta === 'string' ? data.argumentsDelta : ''
      if (!streamed.item && ['write_file', 'create_file'].includes(streamed.name)) {
        beginVisibleActivity()
        streamed.item = {
          kind: 'tool-draft',
          key: `tool-draft-${key}`,
          stepId,
          streamIndex,
          name: streamed.name,
          argumentsText: streamed.argumentsText,
          status: 'running',
        }
        items.push(streamed.item)
      } else if (streamed.item) {
        streamed.item.name = streamed.name
        streamed.item.argumentsText = streamed.argumentsText
      }
      streamedToolCalls.set(key, streamed)
    } else if (event.type === 'plan.updated') {
      const plan = data.plan as PlanState
      if (!plan || !Array.isArray(plan.items)) continue
      beginVisibleActivity()
      if (!visiblePlan) {
        visiblePlan = { kind: 'plan', key: `plan-${snapshot.session.id}`, plan }
        items.push(visiblePlan)
      } else {
        visiblePlan.plan = plan
      }
    } else if (event.type === 'tool.started') {
      const call = data.call as { id: string; name: string; arguments: Record<string, unknown> }
      if (
        ['update_plan', 'present_file', 'compact', 'ask_user', 'propose_plan', 'add_voice'].includes(call.name)
        || (call.name === 'generate_image' && call.arguments.offer_options === true)
      ) continue
      beginVisibleActivity()
      const callPath = typeof call.arguments.path === 'string'
        ? call.arguments.path.replace(/^\/home\/user\//, '').replace(/^\.\//, '')
        : undefined
      const streamed = [...streamedToolCalls.entries()].find(([, candidate]) => {
        if (candidate.stepId !== (event.stepId || candidate.stepId) || candidate.name !== call.name || !candidate.item) return false
        const draftPath = streamedFileWrite(candidate.item)?.path
        return !callPath || !draftPath || draftPath === callPath
      })
      const draftIndex = streamed?.[1].item ? items.indexOf(streamed[1].item) : -1
      if (streamed) streamedToolCalls.delete(streamed[0])
      const tool: Extract<TimelineItem, { kind: 'tool' }> = {
        kind: 'tool',
        key: `tool-${call.id}`,
        name: call.name,
        args: call.arguments,
        status: 'running',
        ...(COMMAND_TOOLS.has(call.name) ? { autoExpanded: true } : {}),
      }
      if (tool.autoExpanded) activeAutoExpandedTool = tool
      tools.set(call.id, tool)
      toolStartedAt.set(call.id, event.at)
      if (draftIndex >= 0) items.splice(draftIndex, 1, tool)
      else items.push(tool)
    } else if (event.type === 'tool.output') {
      const tool = event.callId ? tools.get(event.callId) : undefined
      if (tool) {
        const stream = data.stream === 'stderr' ? 'stderr' : 'stdout'
        tool.liveOutput ??= { stdout: '', stderr: '' }
        tool.liveOutput[stream] += String(data.chunk || '')
        tool.result = [
          tool.liveOutput.stdout && `stdout:\n${tool.liveOutput.stdout}`,
          tool.liveOutput.stderr && `stderr:\n${tool.liveOutput.stderr}`,
        ].filter(Boolean).join('\n')
      }
    } else if (event.type === 'tool.completed' || event.type === 'tool.failed' || event.type === 'tool.timed_out') {
      const call = data.call as { id: string }
      const tool = tools.get(call.id)
      if (tool) {
        tool.result = String(data.result || '')
        delete tool.liveOutput
        tool.status = event.type === 'tool.timed_out' ? 'timed_out' : event.type === 'tool.failed' ? 'failed' : 'succeeded'
        const reportedDuration = toolResultNumber(tool.result, 'duration_ms')
          ?? (typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0 ? data.durationMs : undefined)
        const observedDuration = toolStartedAt.has(call.id) ? Date.parse(event.at) - Date.parse(toolStartedAt.get(call.id)!) : Number.NaN
        tool.durationMs = reportedDuration ?? (Number.isFinite(observedDuration) && observedDuration >= 0 ? observedDuration : undefined)
      }
    } else if (event.type === 'artifact.created') {
      beginVisibleActivity()
      const artifact = data.artifact as ArtifactRecord
      const current = artifacts.get(artifact.path)
      if (current) current.artifact = artifact
      else {
        const item: Extract<TimelineItem, { kind: 'artifact' }> = { kind: 'artifact', key: `artifact-${artifact.path}`, artifact }
        artifacts.set(artifact.path, item)
        items.push(item)
      }
    } else if (event.type === 'artifact.removed') {
      const path = String((data.artifact as ArtifactRecord | undefined)?.path || data.path || '')
      const current = artifacts.get(path)
      if (current) items.splice(items.indexOf(current), 1)
      artifacts.delete(path)
    } else if (event.type === 'approval.required') {
      beginVisibleActivity()
      const approval: Extract<TimelineItem, { kind: 'approval' }> = {
        kind: 'approval',
        key: `approval-${String(data.approvalId)}`,
        approvalId: String(data.approvalId),
        title: typeof data.title === 'string' && data.title.trim() ? data.title : 'Approve external request?',
        description: typeof data.description === 'string' && data.description.trim()
          ? data.description
          : 'This action can change data outside the workspace.',
        call: data.call,
        decision: 'pending',
      }
      approvals.set(approval.approvalId, approval)
      items.push(approval)
    } else if (event.type === 'approval.resolved') {
      const approval = approvals.get(String(data.approvalId))
      if (approval) approval.decision = data.approved ? 'approved' : 'denied'
    } else if (event.type === 'approval.expired') {
      const approval = approvals.get(String(data.approvalId))
      if (approval) approval.decision = 'expired'
    } else if (event.type === 'hitl.required') {
      if (!['ask_user', 'propose_plan', 'add_voice', 'generate_image'].includes(String(data.kind))) continue
      beginVisibleActivity()
      const hitl: HitlTimelineItem = {
        kind: 'hitl',
        key: `hitl-${String(data.hitlId)}`,
        hitlId: String(data.hitlId),
        hitlKind: data.kind,
        title: String(data.title || ''),
        call: data.call,
        payload: data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload) ? data.payload : {},
        decision: 'pending',
      }
      hitls.set(hitl.hitlId, hitl)
      items.push(hitl)
    } else if (event.type === 'hitl.resolved') {
      const hitl = hitls.get(String(data.hitlId))
      if (hitl) {
        hitl.decision = 'resolved'
        hitl.response = data.response && typeof data.response === 'object' && !Array.isArray(data.response) ? data.response : {}
        const content = hitlAnswerContent(hitl)
        const current = hitlAnswers.get(hitl.hitlId)
        if (!content) {
          if (current) items.splice(items.indexOf(current), 1)
          hitlAnswers.delete(hitl.hitlId)
        } else if (current) {
          current.content = content
        } else {
          const answer: Extract<TimelineItem, { kind: 'user' }> = {
            kind: 'user',
            key: `hitl-answer:${hitl.hitlId}`,
            content,
            attachments: [],
          }
          const hitlIndex = items.indexOf(hitl)
          items.splice(hitlIndex < 0 ? items.length : hitlIndex + 1, 0, answer)
          hitlAnswers.set(hitl.hitlId, answer)
        }
      }
    } else if (event.type === 'hitl.expired') {
      const hitl = hitls.get(String(data.hitlId))
      if (hitl) {
        hitl.decision = 'expired'
        const answer = hitlAnswers.get(hitl.hitlId)
        if (answer) items.splice(items.indexOf(answer), 1)
        hitlAnswers.delete(hitl.hitlId)
      }
    } else if (event.type === 'assistant.final.delta') {
      beginVisibleActivity()
      const key = event.stepId || event.turnId || event.id
      if (event.stepId && stepsWithToolCalls.has(event.stepId)) {
        const progressKey = `${event.stepId}-progress`
        let thought = thoughts.get(progressKey)
        if (!thought) {
          thought = { kind: 'thought', key: `thought-${progressKey}`, label: 'Thought', content: '', running: true }
          thoughts.set(progressKey, thought)
          items.push(thought)
        }
        thought.content += String(data.delta || '')
        continue
      }
      let final = finals.get(key)
      if (!final) {
        final = { kind: 'final', key: `final-${key}`, content: '', streaming: true, feedback: null }
        finals.set(key, final)
        items.push(final)
      }
      final.content += String(data.delta || '')
    } else if (event.type === 'assistant.final') {
      beginVisibleActivity()
      const key = event.stepId || event.turnId || event.id
      // Content deltas are provisionally projected as visible progress when a
      // step also contains tool calls. A durable Final for that same step is
      // authoritative: keep the complete Final and discard the provisional
      // duplicate instead of leaving a terminal Session "Thinking...".
      if (event.stepId) {
        const progressKey = `${event.stepId}-progress`
        const progress = thoughts.get(progressKey)
        if (progress) {
          const progressIndex = items.indexOf(progress)
          if (progressIndex >= 0) items.splice(progressIndex, 1)
          thoughts.delete(progressKey)
        }
      }
      let final = finals.get(key)
      if (!final) {
        final = { kind: 'final', key: `final-${key}`, content: '', streaming: false, feedback: null }
        finals.set(key, final)
        items.push(final)
      }
      final.content = String(data.content || final.content)
      final.streaming = false
      final.messageEventId = event.id
      finalsByMessageEvent.set(event.id, final)
    } else if (event.type === 'feedback.updated') {
      const final = finalsByMessageEvent.get(String(data.messageEventId || ''))
      if (final) final.feedback = data.value === 'upvote' || data.value === 'downvote' ? data.value : null
    } else if (event.type === 'error') {
      const legacySessionTokenLimit = data.code === 'session_token_limit' || data.category === 'session_token_limit'
      if (legacySessionTokenLimit && !snapshot.session.limits?.sessionTokens) continue
      beginVisibleActivity()
      items.push({ kind: 'error', key: event.id, content: String(data.message || 'Run failed'), cancelled: Boolean(data.cancelled) })
    }
  }
  if (!visiblePlan && snapshot.plan && undoneTurnIds.size === 0) items.push({ kind: 'plan', key: `plan-${snapshot.session.id}`, plan: snapshot.plan })
  if (['idle', 'completed', 'cancelled', 'failed', 'timed_out', 'interrupted'].includes(snapshot.session.status)) {
    clearAssistantActivity()
    clearAutoExpandedTool()
    for (const thought of thoughts.values()) thought.running = false
  }
  if (['cancelled', 'failed', 'timed_out', 'interrupted'].includes(snapshot.session.status)) {
    for (const final of finals.values()) final.streaming = false
    for (const tool of tools.values()) if (tool.status === 'running') tool.status = 'failed'
    for (const streamed of streamedToolCalls.values()) if (streamed.item) streamed.item.status = 'interrupted'
  }
  return groupArenaToolItems(items)
}

const EXPLORATION_TOOLS = new Set(['list_files', 'read_file', 'grep_files', 'glob_files'])
const COMMAND_TOOLS = new Set(['bash', 'shell_command'])
const COMMAND_DETAIL_TOOLS = new Set([...COMMAND_TOOLS, 'start_process'])
const FILE_EDIT_TOOLS = new Set(['write_file', 'edit_file'])

export function groupArenaToolItems(items: TimelineItem[]): TimelineItem[] {
  const grouped: TimelineItem[] = []
  let active: ToolGroupTimelineItem | undefined
  for (const item of items) {
    const category = item.kind === 'tool'
      ? EXPLORATION_TOOLS.has(item.name)
        ? 'exploration'
        : COMMAND_TOOLS.has(item.name)
          ? 'commands'
          : FILE_EDIT_TOOLS.has(item.name) ? 'files' : undefined
      : undefined
    if (item.kind === 'tool' && category) {
      const sameGroup = active && (
        (category === 'exploration' && active.kind === 'exploration')
        || (category !== 'exploration' && active.kind === 'tool-group' && active.variant === category)
      )
      if (!sameGroup) {
        active = category === 'exploration'
          ? { kind: 'exploration', key: `exploration-${item.key}`, tools: [] }
          : { kind: 'tool-group', key: `${category}-${item.key}`, variant: category, tools: [] }
        grouped.push(active)
      }
      active!.tools.push(item)
      continue
    }
    active = undefined
    grouped.push(item)
  }
  return grouped
}

/** Compatibility name retained for downstream fixture imports. */
export const groupExplorationItems = groupArenaToolItems

export function toolLabel(
  name: string,
  args: Record<string, unknown>,
  status: ToolTimelineItem['status'] = 'succeeded',
): string {
  if (name === 'update_plan') return 'Updated plan'
  if (name === 'bash' || name === 'shell_command') return 'used Bash'
  if (name === 'read_file') {
    const path = String(args.path || 'file')
    if (typeof args.offset !== 'number' && typeof args.limit !== 'number') return `Read ${path}`
    const start = typeof args.offset === 'number' ? args.offset : 1
    const end = typeof args.limit === 'number' ? start + args.limit - 1 : undefined
    return `Read ${path}:${start}${end ? `-${end}` : ''}`
  }
  if (name === 'grep_files') {
    const pattern = String(args.pattern || '').slice(0, 60)
    const path = typeof args.path === 'string' ? ` in ${args.path}` : ''
    return `Searched files for “${pattern}”${path}`
  }
  if (name === 'glob_files') {
    const pattern = String(args.pattern || '*').slice(0, 70)
    const path = typeof args.path === 'string' ? ` in ${args.path}` : ''
    return `Found files matching ${pattern}${path}`
  }
  if (name === 'extract_attachment') {
    const path = String(args.path || 'file')
    const start = typeof args.page_start === 'number' ? args.page_start : typeof args.item_start === 'number' ? args.item_start : undefined
    const end = typeof args.page_end === 'number' ? args.page_end : typeof args.item_end === 'number' ? args.item_end : undefined
    const offset = typeof args.content_offset === 'number' ? args.content_offset : undefined
    return `Read attachment ${path}${start ? `:${start}${end ? `-${end}` : ''}` : ''}${offset !== undefined ? ` @ byte ${offset}` : ''}`
  }
  if (name === 'inspect_image') return `Inspected ${String(args.path || 'image')}`
  if (name === 'create_file') return `Created ${String(args.path || 'file')}`
  if (name === 'write_file') return `Wrote ${String(args.path || 'file')}`
  if (name === 'edit_file') return `Edited ${String(args.path || 'file')}`
  if (name === 'delete_file') return `Deleted ${String(args.path || 'file')}`
  if (name === 'apply_patch') return 'Applied patch'
  if (name === 'install_npm_packages') {
    const packages = Array.isArray(args.packages) ? args.packages.map(String) : []
    return packages.length > 0 ? `Installed ${packages.join(', ').slice(0, 70)}` : 'Installed npm packages'
  }
  if (name === 'build_project') return 'Built project'
  if (name === 'build_and_start') return typeof args.description === 'string' && args.description.trim()
    ? `Built and started ${args.description.trim().slice(0, 70)}`
    : 'Built and started project'
  if (name === 'deploy_project') return 'Deployed project'
  if (name === 'package_install') return `Installed ${String(args.manager || 'package')} dependencies`
  if (name === 'web_search' || name === 'search_web') {
    if (status === 'running') return 'Searching…'
    if (status === 'failed') return 'Search failed'
    if (status === 'timed_out') return 'Search stopped'
    return 'Searched the web'
  }
  if (name === 'web_fetch' || name === 'fetch_page') return `Read ${String(args.url || 'web page').replace(/^https?:\/\//, '').slice(0, 70)}`
  if (name === 'fetch_media') return `Found media for “${String(args.query || '').slice(0, 60)}”`
  if (name === 'image_search') {
    const query = String(args.query || '').slice(0, 60)
    if (status === 'running') return query ? `Searching images for "${query}"` : 'Searching images…'
    if (status === 'failed') return 'Image search failed'
    if (status === 'timed_out') return 'Image search stopped'
    return query ? `Searched images for "${query}"` : 'Searched images'
  }
  if (name === 'generate_image') return status === 'running' ? 'Generating images…' : 'Generated image'
  if (name === 'generate_speech') return status === 'running' ? 'Generating speech…' : 'Generated speech'
  if (name === 'list_connector_tools') return `Checked ${String(args.service || args.connector_slug || 'connected app')}`
  if (name === 'present_file') return `Presented ${String(args.path || 'file')}`
  if (name === 'compact') return 'Compacted conversation context'
  if (name === 'ask_user') return 'Asked for user input'
  if (name === 'propose_plan') return `Proposed ${String(args.path || 'plan')}`
  if (name === 'add_voice') return `Added ${String(args.language || 'a')} voice`
  if (name === 'preview_website') return 'Published website preview'
  if (name === 'start_process') return `Start ${String(args.name || args.description || args.command || 'process').slice(0, 70)}`
  if (name === 'get_process_output') return 'Read process output'
  if (name === 'stop_process') return `Stopped process ${String(args.process_id || '').slice(0, 70)}`.trim()
  if (name === 'browser') {
    const action = String(args.action || 'inspect')
    if (action === 'click') return args.ref ? `Clicked ${String(args.ref)} in browser` : `Clicked “${String(args.text || '').slice(0, 60)}” in browser`
    if (action === 'fill') return `Filled ${String(args.ref || 'field')}`
    if (action === 'select') return `Selected ${String(args.value || '')} in ${String(args.ref || 'control')}`
    if (action === 'check') return `${args.checked ? 'Checked' : 'Unchecked'} ${String(args.ref || 'control')}`
    if (action === 'scroll') return `Scrolled ${String(args.delta_y || 0)} px`
    if (action === 'viewport') return `Set browser viewport to ${String(args.width)} × ${String(args.height)}`
    if (action === 'console') return 'Checked browser console'
    if (action === 'screenshot') return `Captured ${String(args.screenshot_path || 'browser-screenshot.png')}`
    if (action === 'open') return 'Opened Website in browser'
    if (action === 'snapshot') return 'Inspected rendered page'
    if (action === 'press') return `Pressed ${String(args.key || 'key')} in browser`
    return 'Used browser'
  }
  return name.replaceAll('_', ' ')
}

function mergeEvent(events: SessionEvent[], event: SessionEvent): SessionEvent[] {
  if (events.some((current) => current.id === event.id)) return events
  return [...events, event].sort((a, b) => a.seq - b.seq)
}

export function applyEventToSnapshot(snapshot: SessionSnapshot, event: SessionEvent): SessionSnapshot {
  if (event.sessionId !== snapshot.session.id) return snapshot
  const duplicate = snapshot.events.some((current) => current.id === event.id)
  if (duplicate) return snapshot
  const latestSeq = snapshot.events.reduce((maximum, current) => Math.max(maximum, current.seq), 0)
  const withEvent = { ...snapshot, events: mergeEvent(snapshot.events, event) }
  if (event.seq <= latestSeq) return withEvent
  return applySnapshotProjection(withEvent, event)
}

export function reconcileSnapshot(current: SessionSnapshot | undefined, incoming: SessionSnapshot): SessionSnapshot {
  const hydrated = incoming.events.reduce(applySnapshotProjection, { ...incoming })
  if (!current || current.session.id !== hydrated.session.id) return hydrated
  const currentSeq = current.events.reduce((maximum, event) => Math.max(maximum, event.seq), 0)
  const incomingSeq = hydrated.events.reduce((maximum, event) => Math.max(maximum, event.seq), 0)
  return incomingSeq < currentSeq ? current : hydrated
}

function applySnapshotProjection(snapshot: SessionSnapshot, event: SessionEvent): SessionSnapshot {
  const data = event.data as Record<string, any>
  const projected: SessionSnapshot = {
    ...snapshot,
    session: applyEventToSummary(snapshot.session, event),
  }
  if (event.type === 'plan.updated' && data.plan && Array.isArray(data.plan.items)) {
    return { ...projected, plan: data.plan as PlanState }
  }
  if (event.type === 'artifact.created' && data.artifact?.path) {
    const artifact = data.artifact as ArtifactRecord
    return { ...projected, artifacts: [...snapshot.artifacts.filter((item) => item.path !== artifact.path), artifact] }
  }
  if (event.type === 'artifact.removed') {
    const path = String(data.artifact?.path || data.path || '')
    return path ? { ...projected, artifacts: snapshot.artifacts.filter((artifact) => artifact.path !== path) } : projected
  }
  if (event.type === 'process.started' || event.type === 'process.output' || event.type === 'process.updated' || event.type === 'process.stopped') {
    const process = data.record as ProcessRecord | undefined
    if (process?.id) return { ...projected, processes: [...snapshot.processes.filter((item) => item.id !== process.id), process] }
  }
  if (event.type === 'website.updated' && data.website) {
    return { ...projected, website: data.website }
  }
  if (event.type === 'deployment.updated' && data.deployment) {
    return { ...projected, deployment: data.deployment }
  }
  if (event.type === 'workspace.persistence.completed' && Number.isInteger(data.bytes) && data.bytes >= 0) {
    return { ...projected, session: { ...projected.session, workspaceBytes: data.bytes } }
  }
  return projected
}

function applyEventToSummary(summary: SessionSummary, event: SessionEvent): SessionSummary {
  const data = event.data as Record<string, any>
  if (event.type === 'turn.started' && typeof data.model === 'string') return {
    ...summary,
    model: data.model,
    ...('modelSelection' in data ? { modelSelection: data.modelSelection } : {}),
  }
  if (event.type === 'run.status' && isRunStatus(data.status)) return { ...summary, status: data.status }
  if (event.type === 'usage.updated' && data.usage) return {
    ...summary,
    usage: data.usage,
    limits: undefined,
  }
  // Legacy limit events remain in the event stream for audit, but cumulative
  // token usage is no longer an admission policy and must not recreate an
  // obsolete blocking state during snapshot replay or SSE reconciliation.
  if (event.type === 'session.limit.reached') return { ...summary, limits: undefined }
  return summary
}

function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && ['idle', 'queued', 'running', 'awaiting_approval', 'awaiting_user', 'cancelling', 'cancelled', 'failed', 'completed', 'timed_out', 'interrupted'].includes(value)
}

export function workspaceInventoryFromSnapshot(snapshot: SessionSnapshot): WorkspaceInventoryView {
  const metadata = snapshot.workspaceInventory
  return {
    sessionId: snapshot.session.id,
    entries: snapshot.workspace,
    hasMore: metadata?.hasMore ?? false,
    ...(metadata?.nextCursor ? { nextCursor: metadata.nextCursor } : {}),
    truncated: metadata?.truncated ?? false,
    totalFiles: metadata?.totalFiles ?? countFiles(snapshot.workspace),
    ...(metadata?.fileLimitHit === undefined ? {} : { fileLimitHit: metadata.fileLimitHit }),
    ...(metadata?.entryLimitHit === undefined ? {} : { entryLimitHit: metadata.entryLimitHit }),
    ...(metadata?.totalFilesIsLowerBound === undefined ? {} : { totalFilesIsLowerBound: metadata.totalFilesIsLowerBound }),
    loadedEntries: metadata?.loadedEntries ?? countWorkspaceEntries(snapshot.workspace),
    status: 'ready',
  }
}

/** Merge a flat continuation page into the nested tree exposed by snapshots. */
export function mergeWorkspaceInventoryEntries(
  current: readonly WorkspaceEntry[],
  additions: readonly WorkspaceEntry[],
): WorkspaceEntry[] {
  const records = new Map<string, Omit<WorkspaceEntry, 'children'>>()
  const collect = (entries: readonly WorkspaceEntry[]) => {
    for (const entry of entries) {
      if (!entry.path) continue
      records.set(entry.path, {
        name: entry.name,
        path: entry.path,
        type: entry.type,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      })
      if (entry.children) collect(entry.children)
    }
  }
  collect(current)
  collect(additions)

  for (const path of [...records.keys()]) {
    let parent = workspaceParentPath(path)
    while (parent) {
      const existing = records.get(parent)
      if (!existing) {
        records.set(parent, {
          name: parent.slice(parent.lastIndexOf('/') + 1),
          path: parent,
          type: 'directory',
        })
      } else if (existing.type !== 'directory') {
        break
      }
      parent = workspaceParentPath(parent)
    }
  }

  const nodes = new Map<string, WorkspaceEntry>()
  for (const record of records.values()) {
    nodes.set(record.path, {
      ...record,
      ...(record.type === 'directory' ? { children: [] } : {}),
    })
  }
  const roots: WorkspaceEntry[] = []
  for (const node of nodes.values()) {
    const parentPath = workspaceParentPath(node.path)
    const parent = parentPath ? nodes.get(parentPath) : undefined
    if (parent?.type === 'directory') parent.children!.push(node)
    else roots.push(node)
  }
  const sort = (entries: WorkspaceEntry[]) => {
    entries.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' })
        || left.path.localeCompare(right.path)
    })
    for (const entry of entries) if (entry.children) sort(entry.children)
  }
  sort(roots)
  return roots
}

function workspaceParentPath(path: string): string | undefined {
  const separator = path.lastIndexOf('/')
  return separator > 0 ? path.slice(0, separator) : undefined
}

function countWorkspaceEntries(entries: readonly WorkspaceEntry[]): number {
  return entries.reduce((total, entry) => total + 1 + countWorkspaceEntries(entry.children ?? []), 0)
}

export function workspaceFileUsageLabel(
  files: number,
  inventory: Pick<WorkspaceInventoryMetadata, 'truncated' | 'fileLimitHit' | 'entryLimitHit' | 'totalFilesIsLowerBound'>,
): string {
  const safeFiles = Number.isInteger(files) && files >= 0 ? files : 0
  if (inventory.fileLimitHit) return '10,000+/10K files'
  const lowerBound = inventory.entryLimitHit && inventory.totalFilesIsLowerBound
  return `${safeFiles.toLocaleString('en-US')}${lowerBound ? '+' : ''}/10K files`
}

export function workspaceInventoryTruncationMessage(
  inventory: Pick<WorkspaceInventoryMetadata, 'truncated' | 'totalFiles' | 'fileLimitHit' | 'entryLimitHit'>,
): string | undefined {
  if (!inventory.truncated) return undefined
  if (inventory.fileLimitHit) {
    return 'Inventory capped at the first 10,000 files; the workspace contains 10,000+ files.'
  }
  if (inventory.entryLimitHit) {
    const observed = Math.max(0, inventory.totalFiles).toLocaleString('en-US')
    return `${observed}+ files observed; inventory entry cap reached.`
  }
  return 'Workspace inventory is capped; the complete file total is unavailable.'
}

function countFiles(entries: WorkspaceEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.type === 'file' ? 1 : countFiles(entry.children ?? [])), 0)
}

function workspaceFileSize(entries: WorkspaceEntry[], path: string): number | undefined {
  const normalized = path.replace(/^\/home\/user\//, '').replace(/^\.\//, '')
  for (const entry of entries) {
    if (entry.type === 'file' && entry.path.replace(/^\/home\/user\//, '').replace(/^\.\//, '') === normalized) {
      return entry.size ?? 0
    }
    if (entry.type === 'directory') {
      const nested = workspaceFileSize(entry.children ?? [], normalized)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatTokenCount(tokens: number): string {
  return tokens < 1_000 ? String(tokens) : `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`
}

export function websiteStatusLabel(status?: SessionSnapshot['website']['status']): string {
  if (status === 'running') return 'Running'
  if (status === 'starting') return 'Starting'
  if (status === 'asleep') return 'Asleep'
  if (status === 'failed') return 'Failed'
  return 'Stopped'
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return 'less than a second'
  const seconds = Math.max(1, Math.round(ms / 1_000))
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}

function formatCompactDuration(ms: number): string {
  const bounded = Math.max(0, ms)
  if (bounded < 1_000) return `${Math.round(bounded)}ms`
  if (bounded < 10_000) return `${(bounded / 1_000).toFixed(1).replace(/\.0$/, '')}s`
  return `${Math.round(bounded / 1_000)}s`
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function uniqueBy<T, K>(values: T[], key: (value: T) => K): T[] {
  const seen = new Set<K>()
  return values.filter((value) => {
    const id = key(value)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export function codingErrorMessage(reason: unknown): string {
  const message = messageOf(reason)
  const messages: Record<string, string> = {
    branch_not_found: 'This repository has no branches yet. Create an initial commit on GitHub, then try again.',
    repo_bootstrap_failed: "Couldn't initialize this empty repository. Create an initial commit on GitHub, then try again.",
    repo_not_found: "That repository isn't available. Pick a different repo or reconnect GitHub.",
    not_connected: 'Connect GitHub before starting a coding session.',
    github_request_failed: 'GitHub is temporarily unavailable. Try again in a moment.',
    state_expired: 'Your GitHub authorization session expired. Please try connecting again.',
    invalid_state: "Something interrupted the GitHub connection. Let's try that again.",
    missing_code: "Something interrupted the GitHub connection. Let's try that again.",
    access_denied: 'GitHub connection was cancelled.',
  }
  return messages[message] ?? message
}

export function connectGitHubPopup(path: string): Promise<void> {
  return new Promise((resolveConnection, reject) => {
    let settled = false
    let closePoll: number | undefined
    let timeout: number | undefined
    const finish = (result: () => void) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      if (closePoll !== undefined) window.clearInterval(closePoll)
      if (timeout !== undefined) window.clearTimeout(timeout)
      result()
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'coding-github-oauth') return
      if (event.data.success === true) finish(resolveConnection)
      else finish(() => reject(new Error(typeof event.data.error === 'string' ? event.data.error : 'github_request_failed')))
    }
    window.addEventListener('message', onMessage)
    const popup = window.open(path, 'github-oauth', 'popup,width=720,height=760')
    if (!popup) {
      finish(() => reject(new Error("Couldn't open GitHub. Allow pop-ups for this site and try again.")))
      return
    }
    closePoll = window.setInterval(() => {
      if (popup.closed) window.setTimeout(() => finish(() => reject(new Error('GitHub connection was cancelled.'))), 300)
    }, 500)
    timeout = window.setTimeout(() => {
      try { popup.close() } catch { /* no-op */ }
      finish(() => reject(new Error('state_expired')))
    }, 10 * 60 * 1000)
  })
}
