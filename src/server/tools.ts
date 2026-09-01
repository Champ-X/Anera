import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import type { ArtifactRecord, CodingRepositoryState, CodingSessionStatus, DeploymentState, ModelToolImageDataPart, PlanItem, PlanItemStatus, ProcessPortRecord, ProcessRecord, SessionEvent, SpeechProviderMetering, ToolCallRecord, WebProviderMetering, WebProviderName, WebProviderRequestMetering } from '../shared/types.js'
import {
  ARENA_WORKSPACE_IGNORED_DIR_NAMES,
  ARENA_WORKSPACE_IGNORED_FILE_PATH_SUFFIXES,
} from '../shared/workspace-snapshot-policy.js'
export {
  ARENA_WORKSPACE_IGNORED_DIR_NAMES,
  ARENA_WORKSPACE_IGNORED_FILE_PATH_SUFFIXES,
} from '../shared/workspace-snapshot-policy.js'
import { arenaTextContentType, artifactMime, createWorkspaceArtifact } from './artifact.js'
import { extractAttachmentPage } from './attachment-extractor.js'
import type { BrowserManager } from './browser-manager.js'
import { config } from './config.js'
import {
  createStaticDeploymentSnapshot,
  removeStaticDeploymentSnapshot,
  type StaticDeploymentSnapshot,
} from './deployment.js'
import { createId } from './ids.js'
import { fetchPublicUrl, validatePublicUrl, stripHtml } from './network-policy.js'
import { detectCommandPort, ProcessManager, runCommand } from './process-manager.js'
import { findSensitiveValues } from './redaction.js'
import type { SessionStore } from './session-store.js'
import { imageDimensions, type VisionResult } from './vision.js'
import {
  combineSpeechProviderMetering,
  normalizeSpeechAudio,
  speechFormatPlan,
  speechMeteringAsModelUsage,
  speechProviderMetering,
  type SpeechFormatPlan,
} from './speech.js'
import { ARENA_PUBLIC_RESULT_TOOL_NAMES, enforceAneraRuntimeToolResult } from './arena-tool-result.js'
import {
  listWorkspaceInventoryPage,
  WORKSPACE_INVENTORY_DEFAULT_LIMIT,
  WORKSPACE_INVENTORY_MAX_LIMIT,
} from './workspace-inventory.js'
import { applyArenaEdit } from './workspace-edit.js'
import { applyWorkspacePatch } from './workspace-patch.js'
import { globWorkspace, grepWorkspace } from './workspace-search.js'
import {
  assertNoSymlinkTraversal,
  encodeWorkspaceUrlPath,
  findWebsiteEntry,
  listWorkspaceFiles,
  readWorkspaceTextPage,
  resolveWorkspacePath,
  workspaceSize,
  workspaceFileSnapshot,
} from './workspace.js'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolExecutionResult {
  content: string
  isError: boolean
  timedOut?: boolean
  aborted?: boolean
  modelUsage?: ToolModelUsage
  /** Known provider cost for modelUsage, captured at physical request time. */
  estimatedCostUsd?: number
  modelRequestCount?: number
  modelCallCount?: number
  speechUsage?: SpeechProviderMetering
  webProviderUsage?: WebProviderMetering
}

export type ConnectorToolExecutor = (
  call: ToolCallRecord,
  context: ToolContext,
) => Promise<ToolExecutionResult>

export interface ToolModelUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens: number
}

export interface VisionInspector {
  inspect(path: string, prompt: string, signal: AbortSignal): Promise<VisionResult>
}

export type ToolHitlKind = 'ask_user' | 'propose_plan' | 'add_voice' | 'generate_image'

export interface ToolHitlRequest {
  kind: ToolHitlKind
  call: ToolCallRecord
  title: string
  payload: Record<string, unknown>
}

export interface ToolHitlResponse {
  status?: string
  [key: string]: unknown
}

export interface ShellCommandBrokerInput {
  requestedCommand: string
  workspace: string
  repository?: CodingRepositoryState
  codingSessionStatus?: CodingSessionStatus
  signal: AbortSignal
  /** Set only after the Harness has durably resolved a matching approval. */
  approved?: boolean
}

export interface ToolApprovalPresentation {
  title: string
  description: string
}

export type ShellCommandBrokerDecision =
  | { kind: 'passthrough' }
  | { kind: 'rejected'; message: string }
  | { kind: 'approval_required'; presentation: ToolApprovalPresentation }
  | {
      kind: 'authorized'
      /** A broker must reconstruct this command from validated arguments. */
      command: string
      environment: NodeJS.ProcessEnv
      signal: AbortSignal
      sensitiveValues: readonly string[]
      codingSessionStatusOnSuccess?: CodingSessionStatus
      /** Optional trusted post-command oracle; failures retain the conservative fixed fallback above. */
      resolveCodingSessionStatusOnSuccess?: () => Promise<CodingSessionStatus | undefined>
      release: () => void
    }

export type ShellCommandBroker = (
  input: ShellCommandBrokerInput,
) => Promise<ShellCommandBrokerDecision>

export interface ToolExecutorDependencies {
  fetch?: typeof fetch
  runCommand?: typeof runCommand
  validatePublicUrl?: typeof validatePublicUrl
  tavilyApiKey?: string
  tavilyBaseUrl?: string
  firecrawlApiKey?: string
  firecrawlBaseUrl?: string
  /** Bounded turn-scoped page snapshots prevent one provider scrape per fetch_page chunk. */
  fetchPageCacheMaxEntries?: number
  fetchPageCacheMaxBytes?: number
  pexelsApiKey?: string
  imageApiKey?: string
  imageBaseUrl?: string
  imageModel?: string
  /** Distinct provider model ids used for the two-candidate image battle. */
  imageBattleModels?: readonly string[]
  toolTimeoutMs?: number
  websiteReadyTimeoutMs?: number
  /** Origin serving the App's workspace preview routes. A resolver supports servers that bind after createApp(). */
  localAppBaseUrl?: string | (() => string)
  requestHumanInput?: (context: ToolContext, request: ToolHitlRequest) => Promise<ToolHitlResponse>
  connectorTools?: Record<string, ToolDefinition[]>
  connectorExecutors?: Record<string, ConnectorToolExecutor>
  connectorAvailability?: Record<string, () => Promise<boolean>>
  /** Allows narrowly reconstructed Coding commands to receive temporary network/auth authority. */
  shellCommandBroker?: ShellCommandBroker
}

export interface ToolContext {
  sessionId: string
  turnId: string
  stepId: string
  callId?: string
  signal: AbortSignal
  /** Undefined preserves compatibility for direct executor callers; Agent runs always pass an explicit task snapshot. */
  enabledConnectorSlugs?: readonly string[]
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const ARENA_STRUCTURED_RESULT_TOOLS = new Set<string>([
  ...ARENA_PUBLIC_RESULT_TOOL_NAMES,
  'add_voice',
  'ask_user',
  'compact',
  'fetch_page',
  'generate_speech',
  'get_process_output',
  'image_search',
  'list_connector_tools',
  'present_file',
  'propose_plan',
  'start_process',
  'write_file',
])

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Surface a structured clarification card with one to three questions. Each question has 2-4 predefined options and may allow free text. Use only when an unresolved choice materially changes the result.',
      parameters: objectSchema({
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: objectSchema({
            id: { type: 'string' },
            question: { type: 'string', minLength: 1 },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: objectSchema({
                label: { type: 'string', minLength: 1 },
                description: { type: 'string' },
              }, ['label']),
            },
            allow_free_text: { type: 'boolean', default: true },
            allow_multiple: { type: 'boolean', default: false },
          }, ['question', 'options']),
        },
      }, ['questions']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_plan',
      description: 'Present an existing Markdown plan and wait for the user to accept, request a revision, or reject it. Use the exact path from a successful write_file call and provide one to five useful highlights.',
      parameters: objectSchema({
        path: { type: 'string', minLength: 1 },
        highlights: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1 } },
      }, ['path', 'highlights']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description: 'Create or update the visible task plan. Use this for multi-step work and update item statuses as execution progresses; keep at most one item in progress.',
      parameters: objectSchema({
        explanation: { type: 'string' },
        plan: {
          type: 'array',
          items: objectSchema({
            step: { type: 'string' },
            status: { type: 'string' },
          }, ['step', 'status']),
        },
      }, ['plan']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Recursively list workspace files under an optional directory. Hidden dependency and Git directories are omitted.',
      parameters: objectSchema({ path: { type: 'string', description: 'Optional workspace-relative directory' } }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 workspace file. The structured result includes the file page and totalLines; continue through large files with the next 1-based offset.',
      parameters: objectSchema({
        path: { type: 'string', description: 'Workspace-relative path' },
        offset: { type: 'integer', minimum: 1, description: 'Optional 1-based starting line' },
        limit: { type: 'integer', minimum: 1, maximum: 5_000, description: 'Optional maximum number of lines' },
      }, ['path']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_files',
      description: 'Search UTF-8 workspace file contents with a regular expression. Returns matching lines and optional context, matching files, or per-file counts. Binary files, dependency/Git internals, and symlinks are skipped. Prefer this over shell grep or rg.',
      parameters: objectSchema({
        pattern: { type: 'string', minLength: 1, maxLength: 200, description: 'Regular expression, at most 200 characters' },
        path: { type: 'string', minLength: 1, description: 'Optional workspace-relative file or directory' },
        glob: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional glob filter such as **/*.ts' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Defaults to content' },
        '-i': { type: 'boolean', description: 'Case-insensitive matching' },
        '-B': { type: 'integer', minimum: 0, maximum: 50, description: 'Context lines before each match' },
        '-A': { type: 'integer', minimum: 0, maximum: 50, description: 'Context lines after each match' },
        '-C': { type: 'integer', minimum: 0, maximum: 50, description: 'Context lines before and after each match' },
        context: { type: 'integer', minimum: 0, maximum: 50, description: 'Alias for context lines before and after each match' },
      }, ['pattern']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description: 'Find workspace files whose relative paths match a glob pattern. Returns files only, skips dependency/Git internals and symlinks, and caps the result at 100 paths. Prefer this over shell find.',
      parameters: objectSchema({
        pattern: { type: 'string', minLength: 1, maxLength: 200, description: 'Glob pattern such as **/*.ts, at most 200 characters' },
        path: { type: 'string', minLength: 1, description: 'Optional workspace-relative directory to search' },
      }, ['pattern']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_attachment',
      description: 'Extract bounded readable text from a workspace text, PDF, DOCX, XLSX, or PPTX attachment without using the web. Continue at page/item boundaries with page_start or item_start. If one page/item is partial, repeat that page/item with the returned 0-based UTF-8 content_offset.',
      parameters: objectSchema({
        path: { type: 'string', description: 'Workspace-relative attachment path' },
        page_start: { type: 'integer', minimum: 1, description: 'Optional first PDF page' },
        page_end: { type: 'integer', minimum: 1, description: 'Optional last PDF page' },
        item_start: { type: 'integer', minimum: 1, description: 'Optional first DOCX section, XLSX sheet, or PPTX slide' },
        item_end: { type: 'integer', minimum: 1, description: 'Optional last DOCX section, XLSX sheet, or PPTX slide' },
        content_offset: { type: 'integer', minimum: 0, description: 'Continuation byte offset within page_start or item_start, only when a prior result returned it' },
      }, ['path']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_image',
      description: 'Inspect a workspace PNG, JPEG, WebP, or GIF with the vision model. The result includes MIME, byte size, and locally parsed dimensions; do not run Shell/PIL just to rediscover them. Use this for uploaded images and browser screenshots; never infer image contents from the filename.',
      parameters: objectSchema({
        path: { type: 'string', description: 'Workspace-relative image path' },
        prompt: { type: 'string', description: 'What visible evidence to inspect, such as layout, text, colors, or UI controls' },
      }, ['path', 'prompt']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a new UTF-8 text file in the workspace. Use edit_file or apply_patch for existing files.',
      parameters: objectSchema(
        {
          path: { type: 'string', description: 'Workspace-relative path' },
          content: { type: 'string', description: 'Complete file content' },
        },
        ['path', 'content'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the workspace. Provide the full file content.',
      parameters: objectSchema({
        path: { type: 'string', description: 'Path under /home/user' },
        content: { type: 'string', description: 'Complete file content' },
      }, ['path', 'content']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one unique text context in an existing workspace file. Exact text is preferred; trailing-space, whitespace, and indentation-only differences can be matched fuzzily.',
      parameters: objectSchema(
        {
          path: { type: 'string' },
          context: { type: 'string', minLength: 1 },
          replacement: { type: 'string' },
        },
        ['path', 'context', 'replacement'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete one existing workspace file.',
      parameters: objectSchema({ path: { type: 'string' } }, ['path']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: `Apply one text patch for multi-file or multi-location changes. Use exactly one Begin/End envelope. Directives are "*** Add File: path", "*** Update File: path" (optionally followed by "*** Move to: path"), and "*** Delete File: path". Every Add File content line starts with +. Every Update File has an @@ hunk whose lines start with space (context), - (remove), or + (add); never include an unprefixed blank separator. Example:
*** Begin Patch
*** Add File: new.txt
+new line
*** Update File: old.txt
@@
-old line
+updated line
*** Delete File: temp.txt
*** End Patch`,
      parameters: objectSchema({ input: { type: 'string', minLength: 1 } }, ['input']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a foreground shell command in the workspace without outbound network. Use install_npm_packages for registry dependencies and build_and_start for the project Website.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          description: { type: 'string' },
          timeout: { type: 'number' },
          workdir: { type: 'string' },
        },
        required: ['command'],
        additionalProperties: true,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compact',
      description: 'Request a durable context checkpoint when earlier tool results or conversation history are too large. The Harness may also compact automatically under context pressure.',
      parameters: objectSchema({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_process',
      description: 'Start a long-running background process in the workspace. Give it a user-facing name. Use bash for one-shot commands.',
      parameters: objectSchema({
        command: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        cwd: { type: 'string' },
      }, ['command', 'name']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_process_output',
      description: 'Read a managed process log tail and liveness. Prefer one blocking wait over repeated polling.',
      parameters: objectSchema({
        process_id: { type: 'string' },
        wait_for: { type: 'string', enum: ['port', 'log', 'exit'] },
        wait_pattern: { type: 'string' },
        wait_timeout: { type: 'number', minimum: 0, maximum: 180 },
      }, ['process_id']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_command',
      description: 'Run a foreground shell command in an optional workspace-relative directory without outbound network.',
      parameters: objectSchema({ command: { type: 'string' }, workdir: { type: 'string' } }, ['command']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'install_npm_packages',
      description: 'Install npm registry packages in the workspace with lifecycle scripts, audit, and funding calls disabled. This is not a Python/pip installer. For Office generation use an npm library such as exceljs, docx, or pptxgenjs; do not pass openpyxl, python-docx, or python-pptx.',
      parameters: objectSchema({
        packages: { type: 'array', items: { type: 'string' } },
      }, ['packages']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_project',
      description: 'Build the current workspace project without starting a server.',
      parameters: objectSchema({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_and_start',
      description: 'Build the current workspace project, start or publish it, and update the Website panel.',
      parameters: objectSchema({ description: { type: 'string' } }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'deploy_project',
      description: 'Deploy the current static project to the configured deployment URL after explicit user approval.',
      parameters: objectSchema({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_processes',
      description: 'List managed long-running processes for this task.',
      parameters: objectSchema({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_process',
      description: 'Stop a managed long-running process.',
      parameters: objectSchema({ process_id: { type: 'string' } }, ['process_id']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch and read a public HTTP(S) page as markdown, text, or HTML. Redirects are revalidated against the network policy.',
      parameters: objectSchema({
        url: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'text', 'html'] },
      }, ['url']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description: 'Retrieve a web page as Markdown. If hasMore is true, call again with the same URL and next chunkIndex.',
      parameters: objectSchema({
        url: { type: 'string' },
        chunkIndex: { type: 'integer', minimum: 0 },
      }, ['url']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web at depth 1, 2, or 3. Read authoritative results with web_fetch before citing.',
      parameters: objectSchema({
        query: { type: 'string' },
        depth: { type: 'string', enum: ['1', '2', '3'] },
      }, ['query', 'depth']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_media',
      description: 'Search Pexels for reusable image or video media and return recommended source URLs with attribution metadata.',
      parameters: objectSchema({
        query: { type: 'string' },
        media_type: { type: 'string', enum: ['image', 'video', 'both'], default: 'both' },
        count: { type: 'number', default: 6 },
        orientation: { type: 'string', enum: ['any', 'landscape', 'portrait', 'square'], default: 'any' },
        size: { type: 'string', enum: ['any', 'large', 'medium', 'small'], default: 'any' },
        locale: { type: 'string' },
      }, ['query']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_search',
      description: 'Search the web for images and save each result to a workspace path. Call read_file on a returned path to inspect it.',
      parameters: objectSchema({
        query: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 1, maximum: 10, default: 4 },
      }, ['query']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'present_file',
      description: 'Open the main finished workspace deliverable in the user viewer. Do not present scratch or intermediate files.',
      parameters: objectSchema({ path: { type: 'string', minLength: 1 } }, ['path']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_connector_tools',
      description: 'List and load the tools for one connected app. Pass the connector slug exactly as shown by the connected-apps list.',
      parameters: objectSchema({ connector_slug: { type: 'string', minLength: 1 } }, ['connector_slug']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an original image from a prompt and save it to a PNG or JPEG path in the workspace.',
      parameters: objectSchema({
        file_path: { type: 'string' },
        prompt: { type: 'string' },
      }, ['file_path', 'prompt']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_voice',
      description: 'Audition two voices for a language and wait for the user to select one. Use the returned voice_id before generate_speech.',
      parameters: objectSchema({
        language: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1, maxLength: 1_000 },
        voice_identity: objectSchema({ index: { type: 'integer', minimum: 0 } }),
      }, ['language', 'text']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_speech',
      description: 'Synthesize spoken audio with a previously selected voice and save it to the workspace.',
      parameters: objectSchema({
        text: { type: 'string', minLength: 1, maxLength: 4_096 },
        voice_id: { type: 'string', minLength: 1 },
        file_path: { type: 'string', minLength: 1 },
        language: { type: 'string' },
      }, ['text', 'voice_id', 'file_path']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: 'Send an external state-changing HTTP request after explicit user approval. The exact method, URL, and JSON body are shown before execution.',
      parameters: objectSchema(
        {
          url: { type: 'string' },
          method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
          json_body: { type: 'object', description: 'JSON request body; omit only for DELETE without a body' },
        },
        ['url', 'method'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser',
      description: 'Open and test the published workspace Website in a real headless browser. Snapshot returns stable element refs; use them to click, fill, select, check, or focus before a keypress. You can also scroll, resize, read console logs, and save screenshots of the current viewport.',
      parameters: objectSchema(
        {
          action: { type: 'string', enum: ['open', 'snapshot', 'click', 'fill', 'select', 'check', 'press', 'scroll', 'viewport', 'console', 'screenshot'] },
          path: { type: 'string', description: 'HTML workspace entry for open; for screenshot, a compatibility alias used only when screenshot_path is omitted' },
          ref: { type: 'string', description: 'Stable element ref returned by open/snapshot, such as e3' },
          text: { type: 'string', description: 'Exact visible text fallback for click' },
          value: { type: 'string', description: 'Value for fill or select' },
          checked: { type: 'boolean', description: 'Desired checkbox state for check' },
          key: { type: 'string', description: 'Keyboard key for press, such as Tab or Enter' },
          delta_y: { type: 'integer', description: 'Signed vertical pixels for scroll' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          screenshot_path: { type: 'string', description: 'Workspace-relative .png output path for a screenshot of the current viewport' },
        },
        ['action'],
      ),
    },
  },
]

const TOOL_DEFINITION_BY_NAME = new Map(TOOL_DEFINITIONS.map((definition) => [definition.function.name, definition]))

/** Legacy/shared 19-tool schema surface retained for public-bundle drift evidence. */
export const ARENA_PUBLIC_TOOL_DEFINITIONS: ToolDefinition[] = ARENA_PUBLIC_RESULT_TOOL_NAMES.map((name) => {
  const definition = TOOL_DEFINITION_BY_NAME.get(name)
  if (!definition) throw new Error(`Arena public tool definition ${name} is missing`)
  return definition
})

/** Exact current completed-route Agent registry order from Arena's public bundle. */
export const ARENA_ACTIVE_AGENT_TOOL_NAMES = [
  'add_voice',
  'ask_user',
  'bash',
  'compact',
  'edit_file',
  'fetch_page',
  'generate_image',
  'generate_speech',
  'get_process_output',
  'image_search',
  'list_connector_tools',
  'list_files',
  'present_file',
  'propose_plan',
  'read_file',
  'start_process',
  'stop_process',
  'web_search',
  'write_file',
] as const

export const ARENA_ACTIVE_TOOL_LIMITS = {
  askUserQuestions: 6,
  askUserOptions: 6,
  bashCommandChars: 64_000,
  bashDefaultTimeoutSeconds: 30,
  bashMaxTimeoutSeconds: 1_800,
  bashOutputChars: 20_000,
  readFileTextBytes: 262_144,
  processNameChars: 64,
  processDefaultStartupWaitSeconds: 5,
  processMaxStartupWaitSeconds: 30,
  processDefaultTailLines: 200,
  processMaxTailLines: 2_000,
  processDefaultWaitSeconds: 60,
  processMaxWaitSeconds: 180,
  imageSearchQueryChars: 400,
  imageSearchMaxResults: 5,
  generateImageInputs: 10,
  speechTextChars: 1_500,
  connectorServiceChars: 100,
  maxImageBattlesPerTurn: 3,
  defaultImageBattleCandidates: 2,
  maxSpeechGenerationsPerTurn: 10,
} as const

export const ARENA_BINARY_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.wav', '.ogg', '.flac', '.aac',
  '.m4a', '.aiff', '.aif', '.opus', '.mp4', '.webm', '.avi', '.mov', '.mkv', '.zip',
  '.tar', '.gz', '.bz2', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.wasm', '.pdf',
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.bin', '.dat', '.db', '.sqlite',
] as const
const ARENA_BINARY_EXTENSION_SET = new Set<string>(ARENA_BINARY_EXTENSIONS)

/**
 * Literal current completed-route descriptions recovered from Arena's public
 * bundle. Keeping them separate from the legacy/shared definitions makes the
 * provider-visible surface independently snapshot-testable.
 */
export const ARENA_ACTIVE_TOOL_DESCRIPTIONS = {
  add_voice: 'Audition and register a voice for speech generation. Two candidate voices that support `language` each speak your audition `text`; the user listens to both side by side and picks the one they prefer. The result is a `voice_id` (e.g. "voice-00") that subsequent generate_speech calls must reference — you MUST register a voice with this tool before calling generate_speech. Write `text` as about 15 seconds of speech (roughly 30–45 words): prefer content drawn from the user\'s actual request so the audition doubles as a preview; otherwise use a natural passage exercising varied phonetics and prosody. Calling this tool pauses the turn until the user has voted — the pause happens after ALL tool calls in your current response finish, so when the content needs several voices (e.g. two podcast hosts), request them ALL AT ONCE: multiple add_voice calls in parallel in the same response, each auditioning its own pair. Do not produce content that depends on a selection before the user has chosen. Once a selection has resolved (its voice_id is visible in the tool result), keep going in the same turn — if the content needs another voice, call add_voice again immediately; do NOT end the turn to wait. Call it with `voice_identity.index` incremented to audition a fresh pair when the user dislikes both options. Each selection gets its own voice_id.',
  ask_user: 'Surfaces an UI component to the user with the purpose of asking clarifying questions with predefined options. Each question supports 2-4 predefined options plus an optional free-text input. Use this to help resolve important ambiguities and questions that impede the succesful completion of the given task.',
  bash: `Run a bash command in the sandboxed workspace. Commands run in the provided cwd, defaulting to the workspace root /home/user, without a controlling terminal and with stdin closed. Working directory changes, shell variables, aliases, functions, history, exported environment changes, and background process state are not preserved across calls. Do NOT use bash for long-running processes such as dev servers, watchers, or anything that must outlive the command — it is killed at the timeout; use start_process instead when that tool is available. Only files inside the workspace root (/home/user) are captured in persisted snapshots; files written outside that root are not persisted. The following directory names are excluded from snapshots and will not persist: ${ARENA_WORKSPACE_IGNORED_DIR_NAMES.join(', ')}. Sensitive credential paths are also excluded from snapshots: ${ARENA_WORKSPACE_IGNORED_FILE_PATH_SUFFIXES.join(', ')}.`,
  compact: 'Compact the conversation context (server-forced; not model-selectable).',
  edit_file: 'Edit an existing file by searching for text and replacing it. Uses fuzzy matching that tolerates whitespace and indentation differences.',
  fetch_page: "Retrieve the text content of a web page as markdown. Content may be returned in chunks. If hasMore is true, call again with the same url and the next chunkIndex to continue reading. PDFs are parsed up to 30 pages; content beyond that won't be returned.",
  generate_image: `Generate a new image or edit existing images, saved to file_path (must end in .jpg, .jpeg, or .png).

Every call makes ONE single, standalone image per model. Write \`prompt\` for that one image only. NEVER ask for a grid, collage, contact sheet, montage, side-by-side layout, or several variations inside one image. To give the user a choice between images, use \`offer_options\` (below) — it produces separate, distinct images, one per model.

Two modes via \`offer_options\`:
- omitted/false (default): one image from one model, returned immediately.
- true: ONE call shows the user ${ARENA_ACTIVE_TOOL_LIMITS.defaultImageBattleCandidates} separate candidate images from different models and they pick one. The user's pick is saved to file_path; the rest go to the workspace folder 'Unselected files'. The call pauses the turn until they choose — never describe the image before that. This option can be used for either image generation or image editing.

Choosing offer_options — apply the FIRST matching rule:
1. The user asked not to be shown options (any phrasing, any earlier message) → false for the rest of the session (unless explicitly revised by the user).
2. They asked for options/variations/alternatives/choices/versions/a comparison, or are unsure how they want it to look → true.
3. The image is itself the deliverable they asked for (a picture, logo, poster, illustration, …) → true.
4. Otherwise → false: assets inside a larger build (website, app, deck), icon/asset sets, diagrams, corrections to an already-selected image, or a large batch of distinct images (more than 3).

Exactly ONE offer_options call per requested image — that single call already produces the multiple options. NEVER make several calls for variations or styles of the same image. Multiple offer_options calls (max ${ARENA_ACTIVE_TOOL_LIMITS.maxImageBattlesPerTurn}, all in the SAME response) are only for distinctly different requested images ("one image of a dragon and another of a castle" → two calls).

After the user picks, immediately continue the rest of their request without asking.

When editing an image, you may also offer options, following the same four heuristics as above.

To edit, restyle, or combine existing images, pass workspace paths in \`images\` (they must already exist); omit for text-to-image. For follow-up changes to a generated image ("make it darker"), call again with its path in \`images\` — the offer_options rules still apply. Output is always AI-generated imagery, even when editing a real photo.`,
  generate_speech: `Synthesize spoken audio from \`text\` with a previously registered voice and save it to the workspace (the file path's extension sets the format). Use when the user wants narration, a voiceover, or any text read aloud. Requires a \`voice_id\` returned by the add_voice tool — if no voice has been registered this session (or you need a different speaker), call add_voice first. A given \`voice_id\` always maps to the same voice, so a multi-part narration stays consistent across calls; use distinct voice_ids for distinct characters. Speech is synthesized in the language the voice was auditioned in; pass \`language\` only when \`text\` is in a different language — if the voice cannot speak it the call fails, and you should register a language-appropriate speaker with add_voice instead. It produces spoken-word audio only — it cannot sing or produce melodic/musical output; if asked to sing, synthesize the text anyway but first warn the user the result will be spoken, not sung. Speaking rate depends on language (English averages ~800-900 characters/minute, so ~1500 English characters is roughly 1.75 minutes); budget longer text against the per-call character limit. For longer text — or to cut user-perceived latency on medium-length text — split it at sentence boundaries and issue the calls in parallel so chunks synthesize concurrently. You can generate at most ${ARENA_ACTIVE_TOOL_LIMITS.maxSpeechGenerationsPerTurn} clips per turn (the cap resets next turn); if the request needs more than fits, generate the most important parts now and tell the user the remainder will continue in later turns.`,
  get_process_output: "Read the current log tail and liveness of a background process started with start_process, plus the TCP ports currently listening in the workspace. Supports blocking waits: set wait_for to 'port' (a new TCP port starts listening — the usual way to wait for a dev server), 'log' (log tail matches wait_pattern), or 'exit' (process exits). A wait returns as soon as the condition is met or the process exits, otherwise at wait_timeout (default 60s, max 180s) with wait_result='timeout'. ALWAYS prefer one wait_for call over polling this tool repeatedly — heavy dev servers (Next.js, webpack) can take minutes to compile their first page, and each poll wastes a turn. Do not hand-roll waits with bash sleep/curl loops either; they hit the bash timeout.",
  image_search: 'Search the web for images and save them to the workspace. Each result is written to a file path; call read_file on that path to view the image.',
  list_connector_tools: 'List and load the tools for one connector. Call this before you use any tool from that connector, because its tools are not available until you load them. Pass the connector slug exactly as the connected-apps list shows it (for example, "notion", not "Notion"). The result carries a status that tells you what happened. "enabled": the result lists the connector tools and what each one does, and those tools become available to call. "disconnected": the user has not connected this app, so ask the user to connect it. "disabled": the user connected this app but left it off for this conversation, so ask the user to turn it on. "unsupported": Arena does not offer this connector, so do not try the slug again. Every other status means the lookup itself failed and carries a short message: tell the user, and do not call this tool again for the same connector in this turn.',
  list_files: 'List files and directories in the workspace. Returns file names and sizes. Use this to explore the project structure.',
  present_file: "Open a workspace file in the user's viewer so it's in front of them instead of something they have to go find. Present the deliverable when you finish making it such as but not limited to — the document, image, or result the user asked for. Don't present files they didn't ask about, or intermediate and scratch files made along the way. The viewer shows one file at a time: open the main deliverable and mention any others by name.",
  propose_plan: "Present an existing Markdown plan and wait for the user's decision. This tool does not create or change the file.\nUse the exact path from a successful write_file call.\nProvide one to five useful highlights about scope, key decisions, changes, risks, or assumptions.\nDo not repeat the full plan or describe the planning process.\nDo not call this tool in parallel with write_file, ask_user, or another propose_plan.",
  read_file: 'Read a file from the workspace. Text files return their content. Images (jpg, png, webp, gif, bmp) return as visible content. Other binary types return metadata only.',
  start_process: "Start a long-running background process in the workspace (e.g. a dev server, `npm run dev`, a test watcher). The process keeps running after this call returns and across your later tool calls. Returns the initial log output, whether the process is still alive, and any TCP ports that started listening during the startup window — ports bound to 0.0.0.0 become visible to the user as a live preview (the preview environment and its requirements are described in your system prompt). Give each process a user-facing `name` like 'Website' or 'API server' (it labels the preview in the UI). Use bash for one-shot commands; use this only for processes meant to keep running. If the platform detects a preview-breaking response on a new port (a host/origin rejection or an iframe-embedding block), it is reported in `warnings` — fix the server's config and restart it in the same turn.",
  stop_process: 'Stop a background process previously started with start_process. Sends SIGTERM to the process group, then SIGKILL if it does not exit. Returns the final log tail.',
  web_search: "Search the web for current information. Returns relevant results with titles, URLs, and content snippets. Use when you need facts, recent events, or information beyond your training data. When citing results, use the result's numeric id and url in this exact format: [id](url). For example, if a result has id=1 and url=https://example.com, cite it as [1](https://example.com). Do NOT use [source](url) or any other format. Every claim from search results must have a citation.",
  write_file: 'Create or overwrite a file in the workspace. Provide the full file content.',
} as const

const activePathSchema = {
  type: 'string',
  description: "File path: an absolute path (e.g. '/home/user/notes.txt'), or a path relative to the working directory (e.g. 'notes.txt', 'src/app.js'). '~/' refers to the home directory.",
}

const ACTIVE_TOOL_DEFINITION_OVERRIDES: Partial<Record<(typeof ARENA_ACTIVE_AGENT_TOOL_NAMES)[number], ToolDefinition>> = {
  add_voice: {
    type: 'function',
    function: {
      name: 'add_voice',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.add_voice,
      parameters: objectSchema({
        text: {
          type: 'string', minLength: 1, maxLength: ARENA_ACTIVE_TOOL_LIMITS.speechTextChars,
          description: "Audition script both candidate voices will speak — about 15 seconds of speech (roughly 30–45 words). Prefer content drawn from the user's actual request so the audition doubles as a preview; otherwise use a natural passage exercising varied phonetics and prosody (statements, a question, a number or date). Plain words only — no SSML, markup, or bracketed tags.",
        },
        language: {
          type: 'string',
          description: "BCP-47 language tag matching `text`. Required. Add a region subtag to request an accent/dialect (e.g. 'en' generic, 'en-GB' British, 'es-MX' Mexican Spanish). A requested accent is a hard constraint: if no available voice model supports that exact region, the call fails — retry with the bare language tag.",
        },
        voice_identity: objectSchema({
          gender: { type: 'string', enum: ['feminine', 'masculine'], description: 'Voice gender. Specify when the content implies one (e.g. a named character); omit only when indifferent.' },
          use_case: { type: 'string', enum: ['narration', 'conversational', 'advertising', 'entertainment', 'educational', 'characters'], description: 'Intended use, to bias the voice choice.' },
          index: { type: 'integer', minimum: 0, description: '0-based audition index (default 0). Increment it to audition a fresh pair of voices — e.g. when the user dislikes both previous options.' },
        }),
      }, ['text', 'language']),
    },
  },
  ask_user: {
    type: 'function',
    function: {
      name: 'ask_user',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.ask_user,
      parameters: objectSchema({
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: ARENA_ACTIVE_TOOL_LIMITS.askUserQuestions,
          items: objectSchema({
            id: { type: 'string', minLength: 1, description: 'Unique question identifier' },
            question: { type: 'string', minLength: 1, description: 'The question text to display' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: ARENA_ACTIVE_TOOL_LIMITS.askUserOptions,
              items: objectSchema({
                id: { type: 'string', minLength: 1, description: 'Unique option identifier' },
                label: { type: 'string', minLength: 1, description: 'Short option title' },
                description: { type: 'string', description: 'Longer explanation' },
              }, ['id', 'label']),
            },
            allowCustomResponse: { type: 'boolean', default: true, description: 'Whether the user can write a custom response' },
          }, ['id', 'question', 'options']),
        },
      }, ['questions']),
    },
  },
  bash: {
    type: 'function',
    function: {
      name: 'bash',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.bash,
      parameters: objectSchema({
        command: { type: 'string', maxLength: ARENA_ACTIVE_TOOL_LIMITS.bashCommandChars, description: 'The bash command to execute.' },
        cwd: { type: 'string', minLength: 1, default: '/home/user', description: 'Working directory for this command. Defaults to /home/user.' },
        timeout: {
          type: 'integer',
          minimum: 1,
          maximum: ARENA_ACTIVE_TOOL_LIMITS.bashMaxTimeoutSeconds,
          default: ARENA_ACTIVE_TOOL_LIMITS.bashDefaultTimeoutSeconds,
          description: `Maximum seconds before the command is terminated. Default ${ARENA_ACTIVE_TOOL_LIMITS.bashDefaultTimeoutSeconds}, max ${ARENA_ACTIVE_TOOL_LIMITS.bashMaxTimeoutSeconds}.`,
        },
      }, ['command']),
    },
  },
  compact: {
    type: 'function',
    function: { name: 'compact', description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.compact, parameters: objectSchema({}) },
  },
  edit_file: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.edit_file,
      parameters: objectSchema({
        path: activePathSchema,
        old_text: { type: 'string', minLength: 1, description: 'The text to find in the file. Uses fuzzy matching that tolerates whitespace and indentation differences. Only the first match is replaced.' },
        new_text: { type: 'string', description: 'The replacement text. Use an empty string to delete the matched text.' },
      }, ['path', 'old_text', 'new_text']),
    },
  },
  fetch_page: {
    type: 'function',
    function: {
      name: 'fetch_page',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.fetch_page,
      parameters: objectSchema({
        url: { type: 'string', format: 'uri', description: 'The URL of the page to fetch' },
        chunkIndex: { type: 'integer', minimum: 0, default: 0, description: 'Which chunk to return (0-indexed). Omit or pass 0 for the first chunk.' },
      }, ['url']),
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.read_file,
      parameters: objectSchema({
        path: {
          type: 'string',
          description: "File path: an absolute path (e.g. '/home/user/notes.txt'), or a path relative to the working directory (e.g. 'notes.txt', 'images/dog.jpg'). '~/' refers to the home directory.",
        },
      }, ['path']),
    },
  },
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.web_search,
      parameters: objectSchema({
        query: { type: 'string', minLength: 1, maxLength: 400, description: 'The search query' },
        depth: {
          type: 'string',
          enum: ['1', '2', '3'],
          description: 'The search tool accepts a depth parameter (1, 2, or 3) that controls how many results are fetched and how much content is extracted from each. At depth 1, fewer results are retrieved with shorter excerpts. At depth 3, more results are retrieved with longer, more detailed excerpts per source. Depth 2 falls between the two. Higher depth consumes more of the context window.',
        },
      }, ['query', 'depth']),
    },
  },
  generate_image: {
    type: 'function',
    function: {
      name: 'generate_image',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.generate_image,
      parameters: objectSchema({
        file_path: { type: 'string', description: "Path to save the generated image: an absolute path (e.g. '/home/user/images/hero.jpg') or a path relative to the working directory (e.g. 'images/hero.jpg'). '~/' refers to the home directory. Parent directories are created as needed. Must end in .jpg, .jpeg, or .png." },
        prompt: { type: 'string', description: 'Text prompt describing the image to generate' },
        images: { type: 'array', maxItems: ARENA_ACTIVE_TOOL_LIMITS.generateImageInputs, items: { type: 'string' }, description: "Optional paths to existing images to edit or use as reference: absolute, relative to the working directory, or '~/'-prefixed (e.g. ['images/cat.png', '/home/user/photo.png', '~/ref.png']). Omit for text-to-image generation." },
        offer_options: { type: 'boolean', description: 'Show the user several separate candidate images to pick from. Each generation is ONE standalone image — write `prompt` for a single image, never a grid/collage/side-by-side or several variations in one image (the options come from this flag, across different models). First matching rule wins: (1) user asked not to be shown options → false for the rest of the session; (2) they want options/variations/versions/a comparison or are unsure how it should look → true; (3) the image is itself the deliverable they asked for → true; (4) otherwise → false (assets inside a larger build, icon sets, diagrams, corrections, a large batch of distinct images over 3). A request for N options/variations of ONE image is a SINGLE offer_options call — it already produces the multiple options; never make several calls or pack the variations into one prompt for the same image.' },
      }, ['file_path', 'prompt']),
    },
  },
  generate_speech: {
    type: 'function',
    function: {
      name: 'generate_speech',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.generate_speech,
      parameters: objectSchema({
        file_path: { type: 'string', description: "Path to save the audio: an absolute path (e.g. '/home/user/audio/narration.mp3') or a path relative to the working directory (e.g. 'audio/narration.mp3'). '~/' refers to the home directory. Parent directories are created as needed. Must end in a supported audio extension (.mp3, .wav, .ogg, .opus, .flac, .aac, .m4a, .aiff)." },
        text: { type: 'string', minLength: 1, maxLength: ARENA_ACTIVE_TOOL_LIMITS.speechTextChars, description: `The text to speak, up to ${ARENA_ACTIVE_TOOL_LIMITS.speechTextChars} characters per call. Plain words only — no SSML, markup, or bracketed tags.` },
        voice_id: { type: 'string', minLength: 1, description: "Voice id returned by a completed add_voice call (e.g. 'voice-00'). Every generate_speech call must reference a voice the user has already selected this session; call add_voice first if none exists (or when a different speaker is needed)." },
        language: { type: 'string', description: 'BCP-47 language tag for `text`, ONLY when it differs from the language the voice was auditioned in (default: the audition language). If this voice cannot speak the requested language the call fails — register a language-appropriate speaker with add_voice instead. A region subtag requests an accent and is a hard constraint.' },
      }, ['file_path', 'text', 'voice_id']),
    },
  },
  get_process_output: {
    type: 'function',
    function: {
      name: 'get_process_output',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.get_process_output,
      parameters: objectSchema({
        process_id: { type: 'string', minLength: 1, description: 'The process_id returned by start_process.' },
        tail_lines: {
          type: 'integer', minimum: 1, maximum: ARENA_ACTIVE_TOOL_LIMITS.processMaxTailLines,
          default: ARENA_ACTIVE_TOOL_LIMITS.processDefaultTailLines,
          description: `How many trailing log lines to return. Default ${ARENA_ACTIVE_TOOL_LIMITS.processDefaultTailLines}, max ${ARENA_ACTIVE_TOOL_LIMITS.processMaxTailLines}.`,
        },
        wait_for: { type: 'string', enum: ['port', 'log', 'exit'], description: "Block until a condition instead of returning immediately: 'port' = a TCP port starts listening that wasn't already (use after starting a server), 'log' = the log tail matches wait_pattern, 'exit' = the process exits. Always returns early if the process exits. Prefer ONE wait_for call over polling repeatedly — dev servers can take minutes to compile." },
        wait_pattern: { type: 'string', maxLength: 256, description: "Regex tested against the log tail (falls back to literal match). Required when wait_for is 'log'." },
        wait_timeout: {
          type: 'integer', minimum: 1, maximum: ARENA_ACTIVE_TOOL_LIMITS.processMaxWaitSeconds,
          default: ARENA_ACTIVE_TOOL_LIMITS.processDefaultWaitSeconds,
          description: `Max seconds to wait when wait_for is set. Default ${ARENA_ACTIVE_TOOL_LIMITS.processDefaultWaitSeconds}, max ${ARENA_ACTIVE_TOOL_LIMITS.processMaxWaitSeconds}.`,
        },
      }, ['process_id']),
    },
  },
  image_search: {
    type: 'function',
    function: {
      name: 'image_search',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.image_search,
      parameters: objectSchema({
        query: { type: 'string', minLength: 1, maxLength: ARENA_ACTIVE_TOOL_LIMITS.imageSearchQueryChars, description: 'The query to use for image search' },
        count: { type: 'integer', minimum: 1, maximum: ARENA_ACTIVE_TOOL_LIMITS.imageSearchMaxResults, description: `How many images to pull into the workspace (1-${ARENA_ACTIVE_TOOL_LIMITS.imageSearchMaxResults}).` },
      }, ['query', 'count']),
    },
  },
  list_connector_tools: {
    type: 'function',
    function: {
      name: 'list_connector_tools',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.list_connector_tools,
      parameters: objectSchema({
        service: { type: 'string', minLength: 1, maxLength: ARENA_ACTIVE_TOOL_LIMITS.connectorServiceChars, description: 'The connector slug, exactly as the connected-apps list shows it (for example, "notion").' },
      }, ['service']),
    },
  },
  list_files: {
    type: 'function',
    function: {
      name: 'list_files',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.list_files,
      parameters: objectSchema({
        path: {
          type: 'string',
          default: '',
          description: "The directory to list: an absolute path (e.g. '/home/user/src') or a path relative to the working directory (e.g. 'src'). '~/' refers to the home directory. Empty string lists the working directory.",
        },
      }),
    },
  },
  present_file: {
    type: 'function',
    function: {
      name: 'present_file',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.present_file,
      parameters: objectSchema({
        path: {
          type: 'string',
          description: "Path of an existing workspace file to open in the user's file viewer: an absolute path (e.g. '/home/user/report.md') or a path relative to the working directory (e.g. 'report.md'). '~/' refers to the home directory.",
        },
      }, ['path']),
    },
  },
  propose_plan: {
    type: 'function',
    function: {
      name: 'propose_plan',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.propose_plan,
      parameters: objectSchema({
        path: { type: 'string', minLength: 1, pattern: '[^/\\\\]+\\.md$', description: 'Exact path to the Markdown plan file inside the visible workspace' },
        highlights: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'One to five concise highlights for the user, such as the plan overview, important decisions, revisions, risks, or assumptions' },
      }, ['path', 'highlights']),
    },
  },
  start_process: {
    type: 'function',
    function: {
      name: 'start_process',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.start_process,
      parameters: objectSchema({
        name: { type: 'string', maxLength: ARENA_ACTIVE_TOOL_LIMITS.processNameChars, default: '', description: "User-facing label for this process, shown next to its live preview. Use plain product language describing what it IS — 'Website', 'API server', 'Docs site', 'Admin dashboard' — never the command or a slug like 'npm-run-dev'." },
        command: { type: 'string', maxLength: ARENA_ACTIVE_TOOL_LIMITS.bashCommandChars, description: "The shell command to run in the background (e.g. 'npm run dev')." },
        cwd: { type: 'string', minLength: 1, default: '/home/user', description: 'Working directory for the process. Defaults to /home/user.' },
        startup_wait: {
          type: 'integer', minimum: 1, maximum: ARENA_ACTIVE_TOOL_LIMITS.processMaxStartupWaitSeconds,
          default: ARENA_ACTIVE_TOOL_LIMITS.processDefaultStartupWaitSeconds,
          description: `Seconds to wait for startup logs and listening ports before returning. Default ${ARENA_ACTIVE_TOOL_LIMITS.processDefaultStartupWaitSeconds}, max ${ARENA_ACTIVE_TOOL_LIMITS.processMaxStartupWaitSeconds}. The process keeps running afterwards either way.`,
        },
      }, ['command']),
    },
  },
  stop_process: {
    type: 'function',
    function: {
      name: 'stop_process',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.stop_process,
      parameters: objectSchema({ process_id: { type: 'string', minLength: 1, description: 'The process_id returned by start_process.' } }, ['process_id']),
    },
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: ARENA_ACTIVE_TOOL_DESCRIPTIONS.write_file,
      parameters: objectSchema({
        path: {
          type: 'string',
          description: "File path: an absolute path (e.g. '/home/user/notes.txt'), or a path relative to the working directory (e.g. 'notes.txt', 'src/app.js'). '~/' refers to the home directory. Parent directories are created as needed.",
        },
        content: { type: 'string', description: 'The full file content to write' },
      }, ['path', 'content']),
    },
  },
}

export const ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS: ToolDefinition[] = ARENA_ACTIVE_AGENT_TOOL_NAMES.map((name) => {
  const definition = ACTIVE_TOOL_DEFINITION_OVERRIDES[name] ?? TOOL_DEFINITION_BY_NAME.get(name)
  if (!definition) throw new Error(`Arena active Agent tool definition ${name} is missing`)
  return definition
})

/**
 * Anera's capability overlay keeps Arena's frozen 19-tool names and order, but
 * restores deterministic text pagination on read_file. The exact Arena bundle
 * contract above intentionally remains unchanged for parity auditing.
 */
const ANERA_RUNTIME_READ_FILE_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: `${ARENA_ACTIVE_TOOL_DESCRIPTIONS.read_file} Large text files are returned in bounded UTF-8 pages. When nextContentOffset is returned, continue the same offset line with that exact value as content_offset. Otherwise, when nextOffset is returned, continue at that line. Do not skip or repeat a cursor.`,
    parameters: objectSchema({
      path: {
        type: 'string',
        description: "File path: an absolute path (e.g. '/home/user/notes.txt'), or a path relative to the working directory (e.g. 'notes.txt', 'images/dog.jpg'). '~/' refers to the home directory.",
      },
      offset: { type: 'integer', minimum: 1, description: 'Optional 1-based starting line. Use the exact nextOffset returned by the previous page.' },
      content_offset: { type: 'integer', minimum: 0, description: 'Optional 0-based UTF-8 byte offset within offset. Use only the exact nextContentOffset returned by the previous page, with the same path and offset.' },
      limit: { type: 'integer', minimum: 1, maximum: 5_000, description: `Optional maximum number of complete lines. Defaults to ${config.textReadPageLines}.` },
    }, ['path']),
  },
}

const ANERA_RUNTIME_LIST_FILES_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_files',
    description: `${ARENA_ACTIVE_TOOL_DESCRIPTIONS.list_files} Results are returned from one immutable, bounded Workspace manifest. When hasMore is true, call list_files again and copy nextCursor exactly as cursor; keep the same path when you include it. Continue until hasMore is false.`,
    parameters: objectSchema({
      path: {
        type: 'string',
        description: "The workspace-relative directory to list. Empty string lists the workspace root. Keep this unchanged across a cursor chain; it may be omitted on continuation because the cursor is path-bound.",
      },
      cursor: {
        type: 'string',
        minLength: 1,
        maxLength: 1_024,
        description: 'Opaque continuation token. Copy nextCursor exactly; never edit, decode, synthesize, skip, or reuse it for another session or path.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: WORKSPACE_INVENTORY_MAX_LIMIT,
        description: `Maximum file paths per page. Defaults to ${WORKSPACE_INVENTORY_DEFAULT_LIMIT}, max ${WORKSPACE_INVENTORY_MAX_LIMIT}. Omit it on continuation or retain the original value.`,
      },
    }),
  },
}

const ANERA_RUNTIME_TOOL_DEFINITION_OVERRIDES: Readonly<Record<string, ToolDefinition>> = {
  ...ACTIVE_TOOL_DEFINITION_OVERRIDES,
  list_files: ANERA_RUNTIME_LIST_FILES_DEFINITION,
  read_file: ANERA_RUNTIME_READ_FILE_DEFINITION,
}

export const ANERA_RUNTIME_AGENT_TOOL_DEFINITIONS: ToolDefinition[] = ARENA_ACTIVE_AGENT_TOOL_NAMES.map((name) => {
  const definition = ANERA_RUNTIME_TOOL_DEFINITION_OVERRIDES[name] ?? TOOL_DEFINITION_BY_NAME.get(name)
  if (!definition) throw new Error(`Anera runtime Agent tool definition ${name} is missing`)
  return definition
})

const ANERA_RUNTIME_TOOL_DEFINITION_BY_NAME = new Map(
  ANERA_RUNTIME_AGENT_TOOL_DEFINITIONS.map((definition) => [definition.function.name, definition]),
)

export const EXTENSION_TOOL_NAMES = [
  'extract_attachment',
  'inspect_image',
  'install_npm_packages',
  'list_processes',
  'http_request',
  'browser',
  'deploy_project',
] as const

export type ExtensionToolName = (typeof EXTENSION_TOOL_NAMES)[number]

export const EXTENSION_TOOL_DEFINITIONS: Record<ExtensionToolName, ToolDefinition> = Object.fromEntries(
  EXTENSION_TOOL_NAMES.map((name) => {
    const definition = TOOL_DEFINITION_BY_NAME.get(name)
    if (!definition) throw new Error(`Extension tool definition ${name} is missing`)
    return [name, definition]
  }),
) as Record<ExtensionToolName, ToolDefinition>

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value
}

/** Map Arena's public `/home/user` namespace onto the private Session root. */
export function arenaWorkspacePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (normalized === '/home/user' || normalized === '~') return ''
  if (normalized.startsWith('/home/user/')) return normalized.slice('/home/user/'.length)
  if (normalized.startsWith('~/')) return normalized.slice(2)
  if (normalized.startsWith('/')) throw new Error('Only paths under /home/user are allowed')
  return normalized
}

/** Remove a redundant public-workspace cd when Bash is already executing at that exact root. */
export function stripRedundantArenaWorkspaceCd(command: string): string {
  return command.replace(/^\s*cd\s+(?:\/home\/user\/?|~)\s*(?:&&|;)\s*/, '')
}

/** Translate Arena's public workspace root in commands that already run at that root. */
export function rewriteArenaWorkspaceCommandPaths(command: string): string {
  return command
    .replace(/(^|[\s'"=:(])\/home\/user(?=\/|[\s'"`;|&)]|$)/g, '$1.')
    .replace(/(^|[\s'"=:(])~(?=\/|[\s'"`;|&)]|$)/g, '$1.')
}

function requiredWorkspacePath(args: Record<string, unknown>, name: string): string {
  return arenaWorkspacePath(requiredString(args, name))
}

export function validateToolCallArguments(
  call: ToolCallRecord,
  additionalDefinitions: ReadonlyMap<string, ToolDefinition> = new Map(),
): void {
  const definition = ANERA_RUNTIME_TOOL_DEFINITION_BY_NAME.get(call.name)
    ?? TOOL_DEFINITIONS.find((tool) => tool.function.name === call.name)
    ?? additionalDefinitions.get(call.name)
  if (!definition) throw new Error(`Tool "${call.name}" not found`)
  if (call.arguments._parse_error) {
    throw new Error(`Validation failed for tool "${call.name}": invalid JSON arguments`)
  }

  const schema = definition.function.parameters as JsonSchema
  const required = new Set(schema.required ?? [])
  for (const [name, value] of Object.entries(call.arguments)) {
    if (value === null && !required.has(name)) delete call.arguments[name]
  }
  const errors: string[] = []
  validateSchemaValue(call.arguments, schema, '', errors)
  if (call.name === 'ask_user' && Array.isArray(call.arguments.questions)) {
    const questionIds = new Set<string>()
    for (const [questionIndex, rawQuestion] of call.arguments.questions.entries()) {
      if (!rawQuestion || typeof rawQuestion !== 'object' || Array.isArray(rawQuestion)) continue
      const question = rawQuestion as Record<string, unknown>
      if (typeof question.id === 'string') {
        if (questionIds.has(question.id)) errors.push(`questions[${questionIndex}].id: question IDs must be unique`)
        questionIds.add(question.id)
      }
      if (!Array.isArray(question.options)) continue
      const optionIds = new Set<string>()
      for (const [optionIndex, rawOption] of question.options.entries()) {
        if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) continue
        const optionId = (rawOption as Record<string, unknown>).id
        if (typeof optionId !== 'string') continue
        if (optionIds.has(optionId)) errors.push(`questions[${questionIndex}].options[${optionIndex}].id: option IDs must be unique within a question`)
        optionIds.add(optionId)
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Validation failed for tool "${call.name}":\n${errors.map((error) => `- ${error}`).join('\n')}`)
  }
}

/**
 * Project a public Arena tool call through the observable argument behavior in
 * Arena's bundled Zod schemas before it is persisted or executed. Ordinary
 * objects strip unknown keys, bash preserves them, fetch_media materializes
 * its defaults, and web_search accepts a numeric depth by coercing it to the
 * public string enum. Invalid JSON remains invalid and is never repaired.
 */
export function normalizeArenaPublicToolCall(call: ToolCallRecord): ToolCallRecord {
  const definition = ACTIVE_TOOL_DEFINITION_OVERRIDES[call.name as keyof typeof ACTIVE_TOOL_DEFINITION_OVERRIDES]
    ?? TOOL_DEFINITIONS.find((tool) => tool.function.name === call.name)
  return normalizeToolCallWithDefinition(call, definition)
}

/** Normalize a call against the provider-visible Anera runtime overlay. */
export function normalizeAneraRuntimeToolCall(call: ToolCallRecord): ToolCallRecord {
  const definition = ANERA_RUNTIME_TOOL_DEFINITION_BY_NAME.get(call.name)
    ?? TOOL_DEFINITIONS.find((tool) => tool.function.name === call.name)
  return normalizeToolCallWithDefinition(call, definition)
}

function normalizeToolCallWithDefinition(
  call: ToolCallRecord,
  definition: ToolDefinition | undefined,
): ToolCallRecord {
  if (!ARENA_STRUCTURED_RESULT_TOOLS.has(call.name) || call.arguments._parse_error) return call
  if (!definition) return call
  let rawArguments: Record<string, unknown> = { ...call.arguments }
  if (call.name === 'web_search' && typeof rawArguments.depth === 'number') {
    rawArguments.depth = String(rawArguments.depth)
  }
  if (call.name === 'edit_file') {
    if (rawArguments.old_text === undefined && typeof rawArguments.context === 'string') rawArguments.old_text = rawArguments.context
    if (rawArguments.new_text === undefined && typeof rawArguments.replacement === 'string') rawArguments.new_text = rawArguments.replacement
  } else if (call.name === 'bash') {
    if (rawArguments.cwd === undefined && typeof rawArguments.workdir === 'string') rawArguments.cwd = rawArguments.workdir
    if (typeof rawArguments.timeout === 'number' && rawArguments.timeout > ARENA_ACTIVE_TOOL_LIMITS.bashMaxTimeoutSeconds) {
      rawArguments.timeout = Math.max(1, Math.ceil(rawArguments.timeout / 1_000))
    }
  } else if (call.name === 'list_connector_tools') {
    if (rawArguments.service === undefined && typeof rawArguments.connector_slug === 'string') {
      rawArguments.service = rawArguments.connector_slug
    }
  } else if (call.name === 'ask_user' && Array.isArray(rawArguments.questions)) {
    rawArguments.questions = rawArguments.questions.map((rawQuestion, questionIndex) => {
      if (!rawQuestion || typeof rawQuestion !== 'object' || Array.isArray(rawQuestion)) return rawQuestion
      const question = rawQuestion as Record<string, unknown>
      const questionId = typeof question.id === 'string' && question.id ? question.id : `question-${questionIndex + 1}`
      const options = Array.isArray(question.options)
        ? question.options.map((rawOption, optionIndex) => {
            if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) return rawOption
            const option = rawOption as Record<string, unknown>
            return {
              ...option,
              id: typeof option.id === 'string' && option.id ? option.id : `${questionId}-option-${optionIndex + 1}`,
            }
          })
        : question.options
      return {
        ...question,
        id: questionId,
        options,
        ...(question.allowCustomResponse === undefined && typeof question.allow_free_text === 'boolean'
          ? { allowCustomResponse: question.allow_free_text }
          : {}),
      }
    })
  }
  return {
    ...call,
    arguments: normalizeArgumentsBySchema(rawArguments, definition.function.parameters as JsonSchema) as Record<string, unknown>,
  }
}

function normalizeArgumentsBySchema(value: unknown, schema: JsonSchema): unknown {
  if (schema.type === 'array' && Array.isArray(value)) {
    return schema.items ? value.map((item) => normalizeArgumentsBySchema(item, schema.items as JsonSchema)) : [...value]
  }
  if (schema.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const properties = schema.properties ?? {}
  const normalized: Record<string, unknown> = {}
  for (const [name, property] of Object.entries(properties)) {
    if (record[name] !== undefined) normalized[name] = normalizeArgumentsBySchema(record[name], property)
    else if (property.default !== undefined) normalized[name] = property.default
  }
  if (schema.additionalProperties === true) {
    for (const [name, item] of Object.entries(record)) {
      if (!(name in properties)) normalized[name] = item
    }
  }
  return normalized
}

interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: unknown[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  default?: unknown
  format?: string
  pattern?: string
}

function validateSchemaValue(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  const label = path || 'arguments'
  const validType = schema.type === 'string'
    ? typeof value === 'string'
    : schema.type === 'boolean'
      ? typeof value === 'boolean'
      : schema.type === 'integer'
        ? Number.isInteger(value)
        : schema.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : schema.type === 'object'
            ? Boolean(value) && typeof value === 'object' && !Array.isArray(value)
            : schema.type === 'array'
              ? Array.isArray(value)
              : true
  if (!validType) {
    errors.push(`${label}: expected ${String(schema.type)}`)
    return
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${label}: expected one of ${schema.enum.map(String).join(', ')}`)
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
    errors.push(`${label}: must be at least ${schema.minimum}`)
  }
  if (typeof value === 'number' && typeof schema.maximum === 'number' && value > schema.maximum) {
    errors.push(`${label}: must be at most ${schema.maximum}`)
  }
  if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) {
    errors.push(`${label}: must contain at least ${schema.minLength} character${schema.minLength === 1 ? '' : 's'}`)
  }
  if (typeof value === 'string' && typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    errors.push(`${label}: must contain at most ${schema.maxLength} characters`)
  }
  if (typeof value === 'string' && schema.pattern && !(new RegExp(schema.pattern).test(value))) {
    errors.push(`${label}: must match ${schema.pattern}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${label}: must contain at least ${schema.minItems} items`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${label}: must contain at most ${schema.maxItems} items`)
    if (schema.items) value.forEach((item, index) => validateSchemaValue(item, schema.items as JsonSchema, `${label}[${index}]`, errors))
  }
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const properties = schema.properties ?? {}
    for (const name of schema.required ?? []) {
      if (!(name in record)) errors.push(`${path ? `${path}.` : ''}${name}: required property is missing`)
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(record)) {
        if (!(name in properties)) errors.push(`${path ? `${path}.` : ''}${name}: additional property is not allowed`)
      }
    }
    for (const [name, item] of Object.entries(record)) {
      const property = properties[name]
      if (property) validateSchemaValue(item, property, path ? `${path}.${name}` : name, errors)
    }
  }
}

function truncateText(text: string, max = 80_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[Output truncated: ${text.length - max} characters omitted]`
}

function arenaContentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('base64url')
}

export function truncateArenaFileTextForModel(
  content: string,
  maxBytes = ARENA_ACTIVE_TOOL_LIMITS.readFileTextBytes,
): { content: string; truncated: boolean } {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes <= maxBytes) return { content, truncated: false }
  const buffer = Buffer.from(content, 'utf8')
  const half = Math.floor(maxBytes / 2)
  const safeSlice = (start: number, length: number): string => {
    let left = Math.max(0, start)
    let right = Math.min(buffer.length, start + length)
    while (left < right && (buffer[left] & 0xc0) === 0x80) left += 1
    while (right > left && right < buffer.length && (buffer[right] & 0xc0) === 0x80) right -= 1
    return buffer.subarray(left, right).toString('utf8')
  }
  const rawHead = safeSlice(0, half)
  const rawTail = safeSlice(bytes - half, half)
  const head = rawHead.includes('\n') ? rawHead.slice(0, rawHead.lastIndexOf('\n')) : rawHead
  const tail = rawTail.includes('\n') ? rawTail.slice(rawTail.indexOf('\n') + 1) : rawTail
  const elided = bytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8')
  return {
    content: `${head}\n\n[${Math.round(elided / 1_024)} KB elided from the middle of the file]\n\n${tail}`,
    truncated: true,
  }
}

function combinedProcessLog(record: Pick<ProcessRecord, 'stdout' | 'stderr' | 'combinedOutput'>, tailLines?: number): string {
  const combined = record.combinedOutput ?? [record.stdout, record.stderr].filter(Boolean).join('\n')
  if (!tailLines) return truncateLogTail(combined)
  return truncateLogTail(combined.split(/\r?\n/).slice(-tailLines).join('\n'))
}

function processPortRecords(port?: number): ProcessPortRecord[] {
  return port ? [{ port, address: '0.0.0.0' }] : []
}

function listeningProcessPorts(record: Pick<ProcessRecord, 'port' | 'listeningPorts'>): ProcessPortRecord[] {
  return record.listeningPorts ?? processPortRecords(record.port)
}

function newProcessPorts(record: Pick<ProcessRecord, 'port' | 'newPorts'>): ProcessPortRecord[] {
  return record.newPorts ?? processPortRecords(record.port)
}

function previewableProcessPort(record: Pick<ProcessRecord, 'port' | 'listeningPorts' | 'newPorts'>): number | undefined {
  const ports = newProcessPorts(record).length > 0 ? newProcessPorts(record) : listeningProcessPorts(record)
  return ports.find(({ address }) => ['0.0.0.0', '::', '*'].includes(address))?.port
}

function isDirectoryListingHtml(html: string): boolean {
  return /<(?:title|h1)\b[^>]*>\s*(?:directory\s+listing\s+for|index\s+of)\s+\/\s*<\/(?:title|h1)>/i.test(html)
}

async function processPreviewWarnings(
  record: Pick<ProcessRecord, 'newPorts'>,
  signal: AbortSignal,
): Promise<string[]> {
  const warnings = (record.newPorts ?? []).flatMap(({ port, address }) => (
    ['0.0.0.0', '::', '*'].includes(address)
      ? []
      : [`Port ${port} is listening on ${address}, which is not reachable from Arena's live preview. Bind the server to 0.0.0.0.`]
  ))
  const previewPort = (record.newPorts ?? []).find(({ address }) => ['0.0.0.0', '::', '*'].includes(address))?.port
  if (!previewPort) return warnings

  const previewHost = `${previewPort}-anera-preview.e2b.app`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('preview response probe timed out')), 1_000)
  timer.unref?.()
  try {
    const response = await fetch(`http://127.0.0.1:${previewPort}/`, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        host: previewHost,
        origin: `https://${previewHost}`,
        accept: 'text/html,*/*;q=0.8',
      },
      signal: AbortSignal.any([signal, controller.signal]),
    })
    if (response.status >= 400) {
      warnings.push(
        `Live preview request for host ${previewHost} returned HTTP ${response.status}. Configure the server to allow Arena's *.e2b.app preview host and origin.`,
      )
    }
    const location = response.headers.get('location')
    if (location && /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(location)) {
      warnings.push(`Live preview redirects to browser-local URL ${location}. Use a relative URL so the user's browser stays on the Arena preview origin.`)
    }
    const frameOptions = response.headers.get('x-frame-options')
    if (frameOptions && /(?:^|,)\s*(?:deny|sameorigin)\s*(?:,|$)/i.test(frameOptions)) {
      warnings.push(`Live preview response sets X-Frame-Options: ${frameOptions}, which blocks Arena's cross-origin preview iframe.`)
    }
    const csp = response.headers.get('content-security-policy')
    const frameAncestors = csp?.split(';').map((directive) => directive.trim())
      .find((directive) => /^frame-ancestors(?:\s|$)/i.test(directive))
    if (frameAncestors && !frameAncestorsAllowsArena(frameAncestors)) {
      warnings.push(`Live preview response sets ${frameAncestors}, which does not allow embedding by https://arena.ai.`)
    }
    await response.body?.cancel().catch(() => undefined)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    warnings.push(`Arena could not load the live preview response on port ${previewPort}: ${error instanceof Error ? error.message : String(error)}.`)
  } finally {
    clearTimeout(timer)
  }
  return warnings
}

function frameAncestorsAllowsArena(directive: string): boolean {
  const sources = directive.trim().split(/\s+/).slice(1).map((source) => source.toLowerCase())
  return sources.some((source) => (
    source === '*'
    || source === 'https:'
    || source === 'https://arena.ai'
    || source === 'https://*.arena.ai'
  ))
}

function deriveProcessName(command: string): string {
  return (command.trim().split(/\s+/).slice(0, 3).join(' ') || 'process').slice(0, ARENA_ACTIVE_TOOL_LIMITS.processNameChars)
}

function activeToolErrorPayload(name: string, message: string, aborted: boolean): Record<string, unknown> {
  if (aborted) return { status: 'aborted' }
  if (name === 'bash') {
    return {
      stdout: '', stdout_truncated: false, stderr: message, stderr_truncated: false,
      exit_code: null, status: 'shell_error', duration_ms: 0,
    }
  }
  if (name === 'fetch_page' || name === 'web_search') return { status: 'error', error: message }
  if (name === 'start_process') {
    return {
      status: 'shell_error', process_id: null, pid: null, exit_code: null, log_tail: message,
      listening_ports: [], new_ports: [], duration_ms: 0,
    }
  }
  if (name === 'get_process_output') {
    return { status: 'shell_error', exit_code: null, log_tail: message, listening_ports: [] }
  }
  if (name === 'stop_process') return { status: 'shell_error', log_tail: message }
  if (name === 'list_connector_tools') return { status: 'internal_error', message: 'Could not load the connector tools. Try again.' }
  if (name === 'compact') return { summary: '' }
  return { status: 'error', message }
}

/** Project persisted active-tool output through Arena's public toModelOutput hooks. */
export function arenaActiveToolModelOutput(name: string, content: string): string {
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return content
    payload = parsed as Record<string, unknown>
  } catch {
    return content
  }
  if (payload.status !== 'success' && payload.status !== 'completed') return content
  if (name === 'edit_file') return JSON.stringify({ status: 'success', message: payload.message })
  if (name === 'write_file') return JSON.stringify({ status: 'success' })
  if (name === 'generate_speech') return JSON.stringify({ status: 'success', file_path: payload.file_path })
  if (name === 'image_search' && Array.isArray(payload.results)) {
    return JSON.stringify({
      status: 'success',
      results: payload.results.map((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
        const { hash: _hash, ...result } = raw as Record<string, unknown>
        return result
      }),
    })
  }
  if (name === 'read_file') {
    const { status: _status, data: _imageData, ...result } = payload
    return JSON.stringify(result)
  }
  if (name === 'generate_image') {
    if (payload.status === 'success') return JSON.stringify({ status: 'success', file_path: payload.file_path })
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
    if (payload.selection_method === 'skip') {
      return JSON.stringify({
        status: 'skipped',
        message: `The user compared ${candidates.length} image ${candidates.length === 1 ? 'option' : 'options'} and selected none, so no image is saved.`,
      })
    }
    return JSON.stringify({
      status: 'success',
      file_path: payload.file_path,
      message: `The user selected option ${Number(payload.selected_index) + 1} of ${candidates.length}, saved to "${String(payload.file_path)}". Continue with the remainder of the original request.`,
    })
  }
  return content
}

/** Arena read_file.toModelOutput image-data content projection. */
export function arenaActiveToolContentParts(name: string, content: string): ModelToolImageDataPart[] | undefined {
  if (name !== 'read_file') return undefined
  try {
    const payload = JSON.parse(content) as Record<string, unknown>
    if (
      payload.status !== 'success'
      || payload.kind !== 'image'
      || typeof payload.data !== 'string'
      || typeof payload.mediaType !== 'string'
      || typeof payload.visualDescription === 'string'
    ) return undefined
    return [{ type: 'image-data', data: payload.data, mediaType: payload.mediaType }]
  } catch {
    return undefined
  }
}

export class ToolExecutor {
  /** Local preview transport; loopback access is intentional on this path. */
  private readonly fetchImpl: typeof fetch
  /** All external requests use DNS-pinned, connection-verified transport. */
  private readonly externalFetchImpl: typeof fetch
  private readonly runCommandImpl: typeof runCommand
  private readonly validateUrl: typeof validatePublicUrl
  private readonly tavilyApiKey: string
  private readonly tavilyBaseUrl: string
  private readonly firecrawlApiKey: string
  private readonly firecrawlBaseUrl: string
  private readonly fetchPageCacheMaxEntries: number
  private readonly fetchPageCacheMaxBytes: number
  private readonly fetchPageCache = new Map<string, FetchPageCacheEntry>()
  private fetchPageCacheBytes = 0
  private readonly pexelsApiKey: string
  private readonly imageApiKey: string
  private readonly imageBaseUrl: string
  private readonly imageModel: string
  private readonly imageBattleModels: readonly string[]
  private readonly toolTimeoutMs: number
  private readonly websiteReadyTimeoutMs: number
  private readonly localAppBaseUrl: () => string
  private readonly requestHumanInput?: ToolExecutorDependencies['requestHumanInput']
  private readonly connectorTools: Record<string, ToolDefinition[]>
  private readonly connectorExecutors: Record<string, ConnectorToolExecutor>
  private readonly connectorAvailability: Record<string, () => Promise<boolean>>
  private readonly shellCommandBroker?: ShellCommandBroker
  private readonly connectorToolDefinitions = new Map<string, ToolDefinition>()
  private readonly connectorToolSlugs = new Map<string, string>()
  private readonly selectedVoices = new Map<string, { providerVoice: string; language: string }>()

  constructor(
    private readonly store: SessionStore,
    private readonly processes: ProcessManager,
    private readonly browser: BrowserManager,
    private readonly vision: VisionInspector,
    private readonly requestApproval: (
      context: ToolContext,
      call: ToolCallRecord,
      presentation?: ToolApprovalPresentation,
    ) => Promise<boolean>,
    dependencies: ToolExecutorDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? fetch
    this.externalFetchImpl = dependencies.fetch ?? fetchPublicUrl
    this.runCommandImpl = dependencies.runCommand ?? runCommand
    this.validateUrl = dependencies.validatePublicUrl ?? validatePublicUrl
    // An injected fetch is normally a hermetic test/fixture transport. Do not
    // silently activate real .env providers behind it unless the caller also
    // injects the corresponding key explicitly.
    const useConfiguredNetworkProviders = dependencies.fetch === undefined
    this.tavilyApiKey = dependencies.tavilyApiKey
      ?? (useConfiguredNetworkProviders ? config.tavilyApiKey : '')
    this.tavilyBaseUrl = (dependencies.tavilyBaseUrl ?? config.tavilyBaseUrl).replace(/\/+$/, '')
    this.firecrawlApiKey = dependencies.firecrawlApiKey
      ?? (useConfiguredNetworkProviders ? config.firecrawlApiKey : '')
    this.firecrawlBaseUrl = (dependencies.firecrawlBaseUrl ?? config.firecrawlBaseUrl).replace(/\/+$/, '')
    this.fetchPageCacheMaxEntries = boundedNonNegativeInteger(dependencies.fetchPageCacheMaxEntries, 16)
    this.fetchPageCacheMaxBytes = boundedNonNegativeInteger(
      dependencies.fetchPageCacheMaxBytes,
      config.maxReadBytes * 24,
    )
    this.pexelsApiKey = dependencies.pexelsApiKey
      ?? (useConfiguredNetworkProviders ? config.pexelsApiKey : '')
    this.imageApiKey = dependencies.imageApiKey
      ?? (useConfiguredNetworkProviders ? config.imageApiKey : '')
    this.imageBaseUrl = (dependencies.imageBaseUrl ?? config.imageBaseUrl).replace(/\/+$/, '')
    this.imageModel = dependencies.imageModel ?? config.imageModel
    this.imageBattleModels = [...new Set(
      (dependencies.imageBattleModels ?? config.imageBattleModels)
        .map((model) => model.trim())
        .filter(Boolean),
    )]
    this.toolTimeoutMs = dependencies.toolTimeoutMs ?? config.toolTimeoutMs
    this.websiteReadyTimeoutMs = dependencies.websiteReadyTimeoutMs ?? 8_000
    const configuredLocalAppBaseUrl = dependencies.localAppBaseUrl
    this.localAppBaseUrl = typeof configuredLocalAppBaseUrl === 'function'
      ? configuredLocalAppBaseUrl
      : () => configuredLocalAppBaseUrl || `http://127.0.0.1:${config.port}`
    this.requestHumanInput = dependencies.requestHumanInput
    this.connectorTools = Object.fromEntries(Object.entries(dependencies.connectorTools ?? {}).map(([slug, definitions]) => [slug.trim().toLowerCase(), definitions]))
    this.connectorExecutors = Object.fromEntries(Object.entries(dependencies.connectorExecutors ?? {}).map(([slug, execute]) => [slug.trim().toLowerCase(), execute]))
    this.connectorAvailability = Object.fromEntries(Object.entries(dependencies.connectorAvailability ?? {}).map(([slug, available]) => [slug.trim().toLowerCase(), available]))
    this.shellCommandBroker = dependencies.shellCommandBroker
    for (const [slug, definitions] of Object.entries(this.connectorTools)) {
      for (const definition of definitions) {
        const name = definition.function.name
        const existingSlug = this.connectorToolSlugs.get(name)
        if (existingSlug && existingSlug !== slug) throw new Error(`Connector tool ${name} is registered by both ${existingSlug} and ${slug}`)
        this.connectorToolDefinitions.set(name, definition)
        this.connectorToolSlugs.set(name, slug)
      }
    }
  }

  async execute(call: ToolCallRecord, context: ToolContext): Promise<ToolExecutionResult> {
    const normalizedCall = normalizeAneraRuntimeToolCall({ ...call, arguments: { ...call.arguments } })
    const executionContext = context.callId === normalizedCall.id ? context : { ...context, callId: normalizedCall.id }
    return enforceAneraRuntimeToolResult(normalizedCall.name, await this.executeUnvalidated(normalizedCall, executionContext))
  }

  private async executeUnvalidated(call: ToolCallRecord, context: ToolContext): Promise<ToolExecutionResult> {
    const workspace = this.store.workspaceDir(context.sessionId)
    const args = call.arguments
    try {
      validateToolCallArguments(call, this.connectorToolDefinitions)
      await this.enforceTurnScopedMediaLimit(call, context)
      switch (call.name) {
        case 'ask_user': {
          if (!this.requestHumanInput) throw new Error('Structured user input is unavailable')
          const response = await this.requestHumanInput(context, {
            kind: 'ask_user',
            call,
            title: 'A few questions before I continue',
            payload: { questions: args.questions },
          })
          return { content: JSON.stringify(response), isError: false }
        }
        case 'propose_plan': {
          if (!this.requestHumanInput) throw new Error('Plan review is unavailable')
          const path = requiredWorkspacePath(args, 'path')
          if (!/\.md$/i.test(path)) throw new Error('propose_plan path must identify a Markdown file')
          const target = resolveWorkspacePath(workspace, path)
          await assertNoSymlinkTraversal(workspace, target)
          const markdown = await readFile(target, 'utf8')
          const response = await this.requestHumanInput(context, {
            kind: 'propose_plan',
            call: { ...call, arguments: { ...call.arguments, path } },
            title: 'Review the plan',
            payload: { path, highlights: args.highlights, markdown },
          })
          return { content: JSON.stringify(response), isError: false }
        }
        case 'update_plan': {
          const rawPlan = args.plan as Array<{ step: string; status: string }>
          const invalidStatus = rawPlan.findIndex((item) => !isPlanItemStatus(item.status))
          if (invalidStatus !== -1) throw new Error(`plan[${invalidStatus}].status must be pending, in_progress, or completed`)
          const emptyStep = rawPlan.findIndex((item) => !item.step.trim())
          if (emptyStep !== -1) throw new Error(`plan[${emptyStep}].step must be a non-empty string`)
          if (rawPlan.filter((item) => item.status === 'in_progress').length > 1) {
            throw new Error('plan must contain at most one in_progress item')
          }
          const previous = (await this.store.get(context.sessionId)).plan
          const availableIds = new Map<string, PlanItem[]>()
          for (const item of previous?.items ?? []) {
            const matches = availableIds.get(item.step) ?? []
            matches.push(item)
            availableIds.set(item.step, matches)
          }
          const items: PlanItem[] = rawPlan.map((item) => ({
            id: availableIds.get(item.step)?.shift()?.id ?? createId('plan'),
            step: item.step,
            status: item.status as PlanItemStatus,
          }))
          const plan = {
            items,
            ...(typeof args.explanation === 'string'
              ? { explanation: args.explanation }
              : previous?.explanation !== undefined ? { explanation: previous.explanation } : {}),
            updatedAt: new Date().toISOString(),
            version: (previous?.version ?? 0) + 1,
          }
          await this.store.recordPlanUpdate(context.sessionId, plan, {
            ...(typeof args.explanation === 'string' ? { explanation: args.explanation } : {}),
          }, {
            turnId: context.turnId,
            stepId: context.stepId,
            callId: call.id,
          })
          return { content: JSON.stringify({ status: 'success' }), isError: false }
        }
        case 'list_files': {
          const path = typeof args.path === 'string' ? arenaWorkspacePath(args.path) : ''
          return {
            content: JSON.stringify(await listWorkspaceInventoryPage({
              workspaceRoot: workspace,
              manifestDirectory: resolve(this.store.sessionDir(context.sessionId), 'workspace-inventory-manifests', 'agent'),
              sessionId: context.sessionId,
              ...(args.path !== undefined ? { path } : {}),
              ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
              ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
              signal: context.signal,
            })),
            isError: false,
          }
        }
        case 'read_file': {
          const path = requiredWorkspacePath(args, 'path')
          const target = resolveWorkspacePath(workspace, path)
          await assertNoSymlinkTraversal(workspace, target)
          const info = await stat(target)
          if (!info.isFile()) throw new Error('Path is not a file')
          const extension = extname(path).toLowerCase()
          if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(extension)) {
            if (args.offset !== undefined || args.content_offset !== undefined || args.limit !== undefined) {
              throw new Error('offset, content_offset, and limit are supported only for text files')
            }
            if (info.size > config.maxVisionImageBytes) {
              throw new Error(`Image exceeds the ${config.maxVisionImageBytes} byte read_file limit`)
            }
            const image = await readFile(target)
            if (image.byteLength > config.maxVisionImageBytes) {
              throw new Error(`Image exceeds the ${config.maxVisionImageBytes} byte read_file limit`)
            }
            const mediaType = artifactMime(path)
            return {
              content: JSON.stringify({
                status: 'success',
                kind: 'image',
                mediaType,
                size: image.byteLength,
                data: image.toString('base64'),
                ...imageDimensions(image, mediaType),
              }),
              isError: false,
            }
          }
          if (isKnownBinaryExtension(extension)) {
            if (args.offset !== undefined || args.content_offset !== undefined || args.limit !== undefined) {
              throw new Error('offset, content_offset, and limit are supported only for text files')
            }
            return {
            content: JSON.stringify({ status: 'success', kind: 'unsupported', mediaType: artifactMime(path), size: info.size }),
              isError: false,
            }
          }
          const offset = typeof args.offset === 'number' ? args.offset : 1
          const contentOffset = typeof args.content_offset === 'number' ? args.content_offset : undefined
          const limit = typeof args.limit === 'number' ? args.limit : config.textReadPageLines
          const page = await readWorkspaceTextPage(workspace, path, {
            offset,
            contentOffset,
            limit,
            maxBytes: config.textReadPageBytes,
            signal: context.signal,
          })
          const hasMore = page.nextOffset !== undefined || page.nextContentOffset !== undefined
          const continuation = page.nextContentOffset !== undefined
            ? `\n\n[READ_FILE_CONTINUATION_REQUIRED: offset=${page.startLine} content_offset=${page.nextContentOffset}]\n[Showing UTF-8 byte range [${page.contentOffset}, ${page.nextContentOffset}) of line ${page.startLine}. Call read_file again with the same path, offset=${page.startLine}, and content_offset=${page.nextContentOffset}; do not skip or repeat this cursor.]`
            : page.nextOffset !== undefined
              ? `\n\n[READ_FILE_CONTINUATION_REQUIRED: offset=${page.nextOffset}]\n[Showing lines ${page.startLine}-${page.endLine} of ${page.totalLines}. Call read_file again with offset=${page.nextOffset} and the same path; do not skip or repeat this page.]`
              : ''
          return {
            content: JSON.stringify({
              status: 'success',
              kind: 'text',
              size: info.size,
              lines: page.totalLines,
              content: `${page.content}${continuation}`,
              offset: page.startLine,
              returnedLines: Math.max(0, page.endLine - page.startLine + 1),
              hasMore,
              ...(page.contentOffset !== undefined ? { contentOffset: page.contentOffset } : {}),
              ...(page.nextContentOffset !== undefined ? { nextContentOffset: page.nextContentOffset } : {}),
              ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
              ...(page.truncatedBy !== undefined ? { truncatedBy: page.truncatedBy } : {}),
              ...(hasMore ? { truncated: true } : {}),
            }),
            isError: false,
          }
        }
        case 'grep_files':
          return {
            content: JSON.stringify(await grepWorkspace(workspace, args as unknown as Parameters<typeof grepWorkspace>[1], context.signal)),
            isError: false,
          }
        case 'glob_files':
          return {
            content: JSON.stringify(await globWorkspace(workspace, args as unknown as Parameters<typeof globWorkspace>[1], context.signal)),
            isError: false,
          }
        case 'extract_attachment': {
          const path = requiredWorkspacePath(args, 'path')
          const target = resolveWorkspacePath(workspace, path)
          await assertNoSymlinkTraversal(workspace, target)
          const pageStart = typeof args.page_start === 'number' ? args.page_start : undefined
          const pageEnd = typeof args.page_end === 'number' ? args.page_end : undefined
          const itemStart = typeof args.item_start === 'number' ? args.item_start : undefined
          const itemEnd = typeof args.item_end === 'number' ? args.item_end : undefined
          const contentOffset = typeof args.content_offset === 'number' ? args.content_offset : undefined
          const extracted = await extractAttachmentPage(target, config.attachmentPageBytes, { pageStart, pageEnd, itemStart, itemEnd, contentOffset }, context.signal)
          let content = extracted.content
          if (extracted.format === 'text' && extracted.truncated) {
            content += `\n\n[Text attachment output reached the ${config.attachmentPageBytes}-byte limit. Use read_file with offset/limit to continue.]`
          } else if (extracted.partialItem !== undefined) {
            const key = extracted.unit === 'page' ? 'page_start' : 'item_start'
            content = `[ATTACHMENT_CONTINUATION_REQUIRED: ${key}=${extracted.partialItem} content_offset=${extracted.nextContentOffset}]\n\n${content}`
            content += `\n\n[${extracted.unit} ${extracted.partialItem} exceeds the ${config.attachmentPageBytes}-byte attachment limit. Showing UTF-8 byte range [${extracted.contentStartOffset}, ${extracted.contentEndOffset}); continue the same ${extracted.unit} with ${key}=${extracted.partialItem} and content_offset=${extracted.nextContentOffset}.]`
          } else if (extracted.nextItem !== undefined) {
            const key = extracted.unit === 'page' ? 'page_start' : 'item_start'
            content = `[ATTACHMENT_CONTINUATION_REQUIRED: ${key}=${extracted.nextItem}]\n\n${content}`
            content += `\n\n[Showing ${extracted.unit}s ${extracted.startItem}-${extracted.endItem} of ${extracted.totalItems}. Use extract_attachment with ${key}=${extracted.nextItem} to continue.]`
          }
          return { content, isError: false }
        }
        case 'inspect_image': {
          const path = requiredWorkspacePath(args, 'path')
          const prompt = requiredString(args, 'prompt')
          const target = resolveWorkspacePath(workspace, path)
          await assertNoSymlinkTraversal(workspace, target)
          const result = await this.vision.inspect(target, prompt, context.signal)
          const dimensions = result.metadata.width && result.metadata.height
            ? `${result.metadata.width}×${result.metadata.height}`
            : 'dimensions unavailable'
          return {
            content: `Image metadata: ${result.metadata.mime}, ${dimensions}, ${result.metadata.bytes} bytes.\n\nVisual inspection:\n${result.content}\n\nEvidence note: visual OCR is approximate. When this is a browser screenshot, the browser snapshot or action result is authoritative for exact rendered text, control state, and element refs; use this inspection for layout, color, spacing, clipping, and overlap evidence.`,
            isError: false,
            modelUsage: result.usage,
            ...(result.estimatedCostUsd !== undefined ? { estimatedCostUsd: result.estimatedCostUsd } : {}),
            modelRequestCount: result.modelRequestCount ?? result.modelCallCount ?? 1,
            modelCallCount: result.modelCallCount ?? 1,
          }
        }
        case 'create_file': {
          const path = requiredWorkspacePath(args, 'path')
          const content = typeof args.content === 'string' ? args.content : (() => { throw new Error('content must be a string') })()
          if (context.signal.aborted) throw context.signal.reason
          const bytes = await this.store.commitWorkspaceWrite(context.sessionId, {
            path,
            content,
            mode: 'create',
            operation: 'created',
            artifact: this.artifactForPath(context, path),
            context: { turnId: context.turnId, stepId: context.stepId, callId: context.callId },
          })
          return {
            content: JSON.stringify({ status: 'success', message: `Created ${path} (${bytes} bytes).` }),
            isError: false,
          }
        }
        case 'write_file': {
          const path = requiredWorkspacePath(args, 'path')
          const content = typeof args.content === 'string' ? args.content : (() => { throw new Error('content must be a string') })()
          const target = resolveWorkspacePath(workspace, path)
          await assertNoSymlinkTraversal(workspace, target)
          let before: Buffer | undefined
          try {
            before = await readFile(target)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          if (context.signal.aborted) throw context.signal.reason
          await this.store.commitWorkspaceWrite(context.sessionId, {
            path,
            content,
            mode: before ? 'replace' : 'create',
            operation: before ? 'overwritten' : 'created',
            artifact: this.artifactForPath(context, path),
            context: { turnId: context.turnId, stepId: context.stepId, callId: context.callId },
            ...(before ? { expectedBefore: before } : {}),
          })
          return {
            content: JSON.stringify({ status: 'success', hash: arenaContentHash(content) }),
            isError: false,
          }
        }
        case 'edit_file': {
          const path = requiredWorkspacePath(args, 'path')
          const editContext = requiredString(args, 'old_text')
          const replacement = typeof args.new_text === 'string' ? args.new_text : (() => { throw new Error('new_text must be a string') })()
          const target = resolveWorkspacePath(workspace, path)
          await assertNoSymlinkTraversal(workspace, target)
          const current = await readFile(target)
          if (current.length > config.maxReadBytes * 4) throw new Error('File is too large for bounded editing')
          const edited = applyArenaEdit(current.toString('utf8'), editContext, replacement)
          if (context.signal.aborted) throw context.signal.reason
          await this.store.commitWorkspaceWrite(context.sessionId, {
            path,
            content: edited.content,
            mode: 'replace',
            operation: 'edited',
            artifact: this.artifactForPath(context, path),
            context: { turnId: context.turnId, stepId: context.stepId, callId: context.callId },
            expectedBefore: current,
          })
          return {
            content: JSON.stringify({
              status: 'success',
              message: `Edited ${path}.`,
              hash: arenaContentHash(edited.content),
            }),
            isError: false,
          }
        }
        case 'delete_file': {
          const path = requiredWorkspacePath(args, 'path')
          if (context.signal.aborted) throw context.signal.reason
          await this.store.commitWorkspaceDelete(context.sessionId, {
            path,
            operation: 'deleted',
            context: { turnId: context.turnId, stepId: context.stepId, callId: context.callId },
          })
          return { content: JSON.stringify({ status: 'success' }), isError: false }
        }
        case 'apply_patch': {
          if (context.signal.aborted) throw context.signal.reason
          let eventBatchId: string | undefined
          let patchCommitted = false
          try {
            const changes = await applyWorkspacePatch(
              workspace,
              requiredString(args, 'input'),
              context.signal,
              {
                transactionParent: this.store.workspacePatchTransactionDir(context.sessionId),
                onDurablePhase: async (phase, details) => {
                  if (phase !== 'prepared') return
                  const state = await this.store.get(context.sessionId)
                  eventBatchId = await this.store.stageWorkspaceEventBatch(context.sessionId, {
                    source: 'apply_patch',
                    changes: details.changes.map((change) => {
                      if (change.operation === 'deleted') {
                        return {
                          path: change.path,
                          operation: 'patch-deleted',
                          bytes: 0,
                          expected: 'missing' as const,
                          artifact: state.artifacts.find((artifact) => artifact.path === change.path),
                        }
                      }
                      if (!change.afterSha256) throw new Error(`Prepared patch lacks SHA-256 for ${change.path}`)
                      return {
                        path: change.path,
                        operation: change.operation === 'added' ? 'patch-added' : 'patched',
                        bytes: change.bytes,
                        expected: 'present' as const,
                        sha256: change.afterSha256,
                        artifact: this.artifactForPath(context, change.path),
                      }
                    }),
                    context: { turnId: context.turnId, stepId: context.stepId, callId: context.callId },
                  })
                },
              },
            )
            patchCommitted = true
            if (!eventBatchId) throw new Error('Patch committed without a durable workspace event batch')
            await this.store.publishWorkspaceEventBatch(context.sessionId, eventBatchId)
            return {
              content: JSON.stringify({
                status: 'success',
                message: `Applied patch (${changes.length} file change${changes.length === 1 ? '' : 's'}).`,
              }),
              isError: false,
            }
          } catch (error) {
            if (eventBatchId && !patchCommitted && !(error instanceof AggregateError)) {
              await this.store.discardWorkspaceEventBatch(context.sessionId, eventBatchId)
            }
            throw error
          }
        }
        case 'bash':
        case 'shell_command':
          return await this.executeShellCommand(call, context)
        case 'compact': {
          await this.store.update(context.sessionId, (state) => {
            state.forceCompactionRequested = { turnId: context.turnId, stepId: context.stepId, callId: call.id }
          })
          return { content: JSON.stringify({ summary: '' }), isError: false }
        }
        case 'install_npm_packages':
          return await this.installNpmPackages(call, context)
        case 'build_project':
          return await this.buildProject(call, context)
        case 'build_and_start':
          return await this.buildAndStart(call, context)
        case 'deploy_project':
          return await this.deployProject(call, context)
        case 'list_processes': {
          const persisted = (await this.store.get(context.sessionId)).processes
          const live = this.processes.list(context.sessionId)
          const records = new Map(persisted.map((process) => [process.id, process]))
          for (const process of live) records.set(process.id, process)
          return { content: JSON.stringify([...records.values()], null, 2), isError: false }
        }
        case 'start_process': {
          const command = requiredString(args, 'command')
          const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : deriveProcessName(command)
          const cwd = typeof args.cwd === 'string' ? arenaWorkspacePath(args.cwd) : ''
          const startupWaitSeconds = typeof args.startup_wait === 'number'
            ? args.startup_wait
            : ARENA_ACTIVE_TOOL_LIMITS.processDefaultStartupWaitSeconds
          if (cwd) {
            const target = resolveWorkspacePath(workspace, cwd)
            await assertNoSymlinkTraversal(workspace, target)
            if (!(await stat(target)).isDirectory()) throw new Error('cwd is not a directory')
          }
          const normalizedCommand = cwd ? command : rewriteArenaWorkspaceCommandPaths(command)
          const effectiveCommand = cwd ? `cd ${shellQuote(cwd)} && ${normalizedCommand}` : normalizedCommand
          const startedAt = Date.now()
          const started = await this.processes.start(context.sessionId, workspace, effectiveCommand, undefined, {
            turnId: context.turnId,
            stepId: context.stepId,
            callId: context.callId,
          }, name)
          let record = await this.processes.refreshPorts(context.sessionId, started.id) ?? started
          const startupDeadline = startedAt + startupWaitSeconds * 1_000
          while (record.status === 'running' && Date.now() < startupDeadline) {
            if ((record.newPorts?.length ?? 0) > 0) break
            await abortableDelay(Math.min(100, startupDeadline - Date.now()), context.signal)
            record = await this.processes.refreshPorts(context.sessionId, started.id)
              ?? this.processes.get(context.sessionId, started.id)
              ?? record
          }
          const previewPort = previewableProcessPort(record)
          const previewWarnings = previewPort && record.status === 'running'
            ? await this.publishProcessPreview(context, { id: record.id, port: previewPort }, cwd)
            : []
          return {
            content: JSON.stringify({
              status: record.status === 'running' ? 'running' : 'exited',
              process_id: record.id,
              pid: record.pid ?? null,
              exit_code: record.exitCode ?? null,
              log_tail: combinedProcessLog(record),
              listening_ports: listeningProcessPorts(record),
              new_ports: newProcessPorts(record),
              duration_ms: Date.now() - startedAt,
              warnings: [...previewWarnings, ...await processPreviewWarnings(record, context.signal)],
            }),
            isError: false,
          }
        }
        case 'get_process_output':
          return await this.getProcessOutput(args, context)
        case 'stop_process': {
          const processId = requiredString(args, 'process_id')
          const live = this.processes.get(context.sessionId, processId)
          const persisted = (await this.store.get(context.sessionId)).processes.find((process) => process.id === processId)
          if (!live) {
            return {
              content: JSON.stringify({
                status: persisted ? 'already_exited' : 'not_found',
                log_tail: persisted ? combinedProcessLog(persisted) : '',
              }),
              isError: false,
            }
          }
          const record = await this.processes.stop(context.sessionId, processId, {
            turnId: context.turnId,
            stepId: context.stepId,
            callId: context.callId,
          })
          return {
            content: JSON.stringify({
              status: live.status === 'running' ? 'stopped' : 'already_exited',
              log_tail: combinedProcessLog(record),
            }),
            isError: false,
          }
        }
        case 'web_fetch':
          return await this.webFetch(requiredString(args, 'url'), typeof args.format === 'string' ? args.format : 'markdown', context.signal)
        case 'fetch_page':
          return await this.fetchPage(requiredString(args, 'url'), typeof args.chunkIndex === 'number' ? args.chunkIndex : 0, context)
        case 'web_search':
          return await this.searchWeb(requiredString(args, 'query'), requiredString(args, 'depth'), context.signal)
        case 'fetch_media':
          return await this.fetchMedia(args, context.signal)
        case 'image_search':
          return await this.imageSearch(args, context)
        case 'present_file':
          return await this.presentFile(requiredWorkspacePath(args, 'path'), context)
        case 'list_connector_tools':
          return await this.listConnectorTools(requiredString(args, 'service'), context)
        case 'generate_image':
          return await this.generateImage(args, context)
        case 'add_voice': {
          if (!this.requestHumanInput) throw new Error('Voice selection is unavailable')
          const language = normalizeBcp47Language(requiredString(args, 'language'))
          const text = requiredString(args, 'text')
          const index = typeof (args.voice_identity as { index?: unknown } | undefined)?.index === 'number'
            ? (args.voice_identity as { index: number }).index
            : 0
          const candidates = [
            {
              id: `${call.id}-a`, index: 0, label: 'Voice A', provider_voice: index % 2 === 0 ? 'alloy' : 'nova',
              hash: arenaContentHash(`${call.id}:voice:${index}:0`),
            },
            {
              id: `${call.id}-b`, index: 1, label: 'Voice B', provider_voice: index % 2 === 0 ? 'verse' : 'sage',
              hash: arenaContentHash(`${call.id}:voice:${index}:1`),
            },
          ]
          const auditionPaths = this.imageApiKey
            ? candidates.map((candidate) => (
                `.tmp/voice-auditions/${arenaContentHash(call.id).slice(0, 16)}-${candidate.index + 1}.mp3`
              ))
            : []
          const speechUsages: SpeechProviderMetering[] = []
          let preserveAuditions = false
          try {
            if (auditionPaths.length > 0) {
              const plan = speechFormatPlan('audition.mp3')
              const attempts = await Promise.allSettled(candidates.map((candidate) => (
                this.synthesizeNormalizedSpeech(text, candidate.provider_voice, plan, context.signal)
              )))
              for (const attempt of attempts) {
                const usage = attempt.status === 'fulfilled'
                  ? attempt.value.speechUsage
                  : toolSpeechUsageFromError(attempt.reason)
                if (usage) speechUsages.push(usage)
              }
              const failed = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected')
              if (failed) throw withToolSpeechUsage(failed.reason, combineSpeechProviderMetering(speechUsages))
              const auditions = attempts.map((attempt) => (attempt as PromiseFulfilledResult<{
                audio: Buffer
                speechUsage: SpeechProviderMetering
              }>).value.audio)
              await Promise.all(auditions.map(async (audio, candidateIndex) => {
                const target = resolveWorkspacePath(workspace, auditionPaths[candidateIndex])
                await assertNoSymlinkTraversal(workspace, target)
                await mkdir(dirname(target), { recursive: true })
                await writeFile(target, audio)
              }))
            }
            const response = await this.requestHumanInput(context, {
              kind: 'add_voice',
              call: { ...call, arguments: { ...call.arguments, language } },
              title: 'Choose a voice',
              payload: {
                language,
                text,
                candidates: candidates.map(({ provider_voice: _providerVoice, ...candidate }, candidateIndex) => ({
                  ...candidate,
                  ...(auditionPaths[candidateIndex] ? { path: auditionPaths[candidateIndex] } : {}),
                })),
              },
            })
            const selected = candidates.find((candidate) => (
              candidate.id === response.candidate_id || candidate.index === response.selected_index
            )) ?? candidates[0]
            const committed = await this.store.commitVoiceSelection(context.sessionId, {
              ...(typeof response.voice_id === 'string' ? { voiceId: response.voice_id } : {}),
              providerVoice: selected.provider_voice,
              language,
              callId: call.id,
            })
            const voiceId = committed.voiceId
            // Cache only after the durable conflict check succeeds. A second
            // completion can never silently rebind the same public id in
            // memory when its persisted provider/language differs.
            this.selectedVoices.set(`${context.sessionId}:${voiceId}`, {
              providerVoice: selected.provider_voice,
              language,
            })
            const speechUsage = combineSpeechProviderMetering(speechUsages)
            return {
              content: JSON.stringify({
                status: 'completed',
                candidates: candidates.map((candidate) => ({ index: candidate.index, hash: candidate.hash })),
                selected_index: selected.index,
                voice_id: voiceId,
                selection_method: 'user',
              }),
              isError: false,
              ...(speechUsage ? {
                speechUsage,
                modelUsage: speechMeteringAsModelUsage(speechUsage),
                modelRequestCount: speechUsage.providerCalls,
                modelCallCount: speechUsage.providerCalls,
              } : {}),
            }
          } catch (error) {
            preserveAuditions = Boolean(
              error
              && typeof error === 'object'
              && (error as { preserveHitlFiles?: unknown }).preserveHitlFiles === true,
            )
            throw withToolSpeechUsage(error, combineSpeechProviderMetering(speechUsages))
          } finally {
            if (!preserveAuditions) {
              await Promise.all(auditionPaths.map(async (path) => {
                const target = resolveWorkspacePath(workspace, path)
                await rm(target, { force: true })
              }))
            }
          }
        }
        case 'generate_speech':
          return await this.generateSpeech(args, context)
        case 'http_request':
          return await this.httpRequest(call, context)
        case 'browser':
          return await this.browserAction(context, args)
        default: {
          const connectorSlug = this.connectorToolSlugs.get(call.name)
          if (!connectorSlug) throw new Error(`Unknown tool: ${call.name}`)
          const execute = this.connectorExecutors[connectorSlug]
          if (!execute) throw new Error(`Connector ${connectorSlug} is connected, but execution for ${call.name} is unavailable`)
          return await execute(call, context)
        }
      }
    } catch (error) {
      const message = this.store.redactTextForDisplay(
        context.sessionId,
        error instanceof Error ? error.message : String(error),
      )
      const modelUsage = call.name === 'inspect_image' || call.name === 'generate_image' || call.name === 'add_voice' || call.name === 'generate_speech'
        ? toolModelUsageFromError(error)
        : undefined
      const modelCallCount = toolModelCallCountFromError(error)
      const modelRequestCount = toolModelRequestCountFromError(error)
      const estimatedCostUsd = toolEstimatedCostUsdFromError(error)
      const speechUsage = call.name === 'add_voice' || call.name === 'generate_speech'
        ? toolSpeechUsageFromError(error)
        : undefined
      const webProviderUsage = call.name === 'fetch_page' || call.name === 'web_search' || call.name === 'image_search'
        ? toolWebProviderUsageFromError(error)
        : undefined
      const activeTool = (ARENA_ACTIVE_AGENT_TOOL_NAMES as readonly string[]).includes(call.name)
      const aborted = context.signal.aborted
      return {
        content: activeTool
          ? JSON.stringify(activeToolErrorPayload(call.name, message, aborted))
          : ARENA_STRUCTURED_RESULT_TOOLS.has(call.name)
            ? JSON.stringify({ status: 'error', message })
          : message,
        isError: true,
        ...(aborted ? { aborted: true } : {}),
        ...(modelUsage ? { modelUsage } : {}),
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
        ...(modelRequestCount !== undefined ? { modelRequestCount } : {}),
        ...(modelCallCount !== undefined ? { modelCallCount } : {}),
        ...(speechUsage ? { speechUsage } : {}),
        ...(speechUsage ? { modelRequestCount: speechUsage.providerCalls } : {}),
        ...(speechUsage ? { modelCallCount: speechUsage.providerCalls } : {}),
        ...(webProviderUsage ? { webProviderUsage } : {}),
      }
    }
  }

  private async fileChanged(context: ToolContext, path: string, bytes: number, operation: string): Promise<void> {
    const artifact = this.artifactForPath(context, path)
    const artifactEventId = createId('evt')
    await this.store.append(context.sessionId, 'file.changed', {
      path,
      bytes,
      operation,
      artifact,
      artifactEventId,
    }, {
      turnId: context.turnId,
      stepId: context.stepId,
      callId: context.callId,
    })
    await this.store.recordArtifactCreated(context.sessionId, artifact, {
      turnId: context.turnId,
      stepId: context.stepId,
      callId: context.callId,
      eventId: artifactEventId,
    })
    await this.refreshWorkspaceBytes(context.sessionId)
  }

  private artifactForPath(context: ToolContext, path: string): ArtifactRecord {
    return createWorkspaceArtifact(context.sessionId, path)
  }

  private async fileRemoved(context: ToolContext, path: string, operation: string): Promise<void> {
    const removed = (await this.store.get(context.sessionId)).artifacts.find((artifact) => artifact.path === path)
    const artifactEventId = removed ? createId('evt') : undefined
    await this.store.append(context.sessionId, 'file.changed', {
      path,
      bytes: 0,
      operation,
      ...(removed ? { artifact: removed, artifactEventId } : {}),
    }, {
      turnId: context.turnId,
      stepId: context.stepId,
      callId: context.callId,
    })
    if (removed) await this.store.recordArtifactRemoved(context.sessionId, removed, {
      turnId: context.turnId,
      stepId: context.stepId,
      callId: context.callId,
      eventId: artifactEventId,
    })
    await this.refreshWorkspaceBytes(context.sessionId)
  }

  private async refreshWorkspaceBytes(sessionId: string): Promise<void> {
    const bytes = await workspaceSize(this.store.workspaceDir(sessionId))
    await this.store.update(sessionId, (state) => {
      state.summary.workspaceBytes = bytes
    })
  }

  private async executeShellCommand(call: ToolCallRecord, context: ToolContext): Promise<ToolExecutionResult> {
    const workspace = this.store.workspaceDir(context.sessionId)
    const requestedCommand = requiredString(call.arguments, 'command')
    assertNoShellPackageInstallation(requestedCommand)
    const activeBash = call.name === 'bash'
    const requestedTimeoutSeconds = typeof call.arguments.timeout === 'number'
      ? call.arguments.timeout
      : activeBash ? ARENA_ACTIVE_TOOL_LIMITS.bashDefaultTimeoutSeconds : config.toolTimeoutMs
    const timeoutMs = activeBash
      ? Math.min(
          ARENA_ACTIVE_TOOL_LIMITS.bashMaxTimeoutSeconds,
          Math.max(1, requestedTimeoutSeconds),
        ) * 1_000
      : Math.min(config.toolTimeoutMs, Math.max(1, requestedTimeoutSeconds))
    const workingDirectory = await this.resolveCommandWorkdir(
      workspace,
      activeBash ? call.arguments.cwd : call.arguments.workdir,
      activeBash ? 'cwd' : 'workdir',
    )
    const localCommand = activeBash && workingDirectory === workspace
      ? rewriteArenaWorkspaceCommandPaths(stripRedundantArenaWorkspaceCd(requestedCommand))
      : requestedCommand
    const brokerCommand = activeBash && this.shellCommandBroker
      ? async (approved = false): Promise<ShellCommandBrokerDecision> => {
          // Re-read trusted scope after an arbitrarily long human wait. Session
          // status or connection state may have changed while approval was open.
          const state = await this.store.get(context.sessionId)
          return await this.shellCommandBroker!({
            requestedCommand,
            workspace,
            repository: state.repository ?? undefined,
            codingSessionStatus: state.summary.codingSessionStatus,
            signal: context.signal,
            approved,
          })
        }
      : undefined
    let brokerDecision: ShellCommandBrokerDecision = brokerCommand
      ? await brokerCommand()
      : { kind: 'passthrough' }
    if (brokerDecision.kind === 'approval_required') {
      const approved = await this.requestApproval(context, call, brokerDecision.presentation)
      if (!approved) {
        return {
          content: JSON.stringify(activeToolErrorPayload('bash', 'User denied the GitHub operation. The command was not run.', false)),
          isError: true,
        }
      }
      brokerDecision = await brokerCommand!(true)
      if (brokerDecision.kind === 'approval_required' || brokerDecision.kind === 'passthrough') {
        return {
          content: JSON.stringify(activeToolErrorPayload('bash', 'GitHub command authorization changed after approval. The command was not run.', false)),
          isError: true,
        }
      }
    }
    if (brokerDecision.kind === 'rejected') {
      return {
        content: JSON.stringify(activeToolErrorPayload('bash', brokerDecision.message, false)),
        isError: true,
      }
    }
    const authorization = brokerDecision.kind === 'authorized' ? brokerDecision : undefined
    if (authorization) this.store.registerSensitiveValues(context.sessionId, authorization.sensitiveValues)
    try {
      const before = await workspaceFileSnapshot(workspace, { signal: context.signal })
      const guardianId = createId('cmd')
      const reconciliationId = await this.store.stageShellReconciliation(
        context.sessionId,
        guardianId,
        before,
        { turnId: context.turnId, stepId: context.stepId, callId: call.id },
      )
      let result: Awaited<ReturnType<typeof runCommand>>
      const pendingOutputWrites: Array<Promise<SessionEvent>> = []
      try {
        result = await this.runCommandImpl({
          command: authorization?.command ?? localCommand,
          workspace,
          workingDirectory,
          timeoutMs,
          maxOutputBytes: config.maxToolOutputBytes,
          signal: authorization?.signal ?? context.signal,
          ...(authorization ? { allowNetwork: true, environment: authorization.environment } : {}),
          guardianId,
          onGuardianReady: async (pid) => await this.store.armShellReconciliation(context.sessionId, reconciliationId, pid),
          onOutput: (stream, chunk) => {
            this.store.registerSensitiveValues(context.sessionId, findSensitiveValues(chunk))
            if (!this.store.hasSensitiveValues(context.sessionId)) {
              pendingOutputWrites.push(this.store.append(context.sessionId, 'tool.output', { stream, chunk }, {
                turnId: context.turnId,
                stepId: context.stepId,
                callId: call.id,
              }))
            }
          },
        })
      } finally {
        try {
          // A Tool terminal must never overtake or silently hide a failed
          // streamed-output append. This is the Shell counterpart to the
          // Agent Final persistence barrier.
          await Promise.all(pendingOutputWrites)
        } finally {
          const settled = await this.store.settleShellReconciliation(context.sessionId, reconciliationId)
          if (settled.batchId) await this.store.publishWorkspaceEventBatch(context.sessionId, settled.batchId)
        }
      }
      if (authorization) {
        result = {
          ...result,
          stdout: this.store.redactTextForDisplay(context.sessionId, result.stdout),
          stderr: this.store.redactTextForDisplay(context.sessionId, result.stderr),
        }
      }
      if (
        (authorization?.codingSessionStatusOnSuccess || authorization?.resolveCodingSessionStatusOnSuccess)
        && result.exitCode === 0
        && result.signal === null
        && !result.timedOut
        && !authorization.signal.aborted
      ) {
        let codingSessionStatus = authorization.codingSessionStatusOnSuccess
        if (authorization.resolveCodingSessionStatusOnSuccess) {
          try {
            codingSessionStatus = await authorization.resolveCodingSessionStatusOnSuccess() ?? codingSessionStatus
          } catch {
            // The fixed fallback is deliberately conservative for a remote
            // mutation whose GitHub read-after-write oracle is unavailable.
          }
        }
        if (codingSessionStatus) {
          await this.store.update(context.sessionId, (next) => {
            next.summary.codingSessionStatus = codingSessionStatus
          })
        }
      }
      if (!activeBash) {
        const stderr = [result.stderr, result.truncated ? '[Additional output was truncated]' : ''].filter(Boolean).join('\n')
        const succeeded = result.exitCode === 0 && !context.signal.aborted && !result.timedOut
        const payload = succeeded
          ? {
              status: 'success',
              ...(result.stdout ? { stdout: truncateText(result.stdout) } : {}),
              ...(stderr ? { stderr: truncateText(stderr) } : {}),
            }
          : {
              status: 'error',
              message: context.signal.aborted
                ? 'Command cancelled'
                : result.timedOut
                  ? `Command timed out after ${timeoutMs}ms`
                  : `Command exited with code ${result.exitCode ?? 'null'}${result.signal ? ` (${result.signal})` : ''}`,
              ...(result.stdout ? { stdout: truncateText(result.stdout) } : {}),
              ...(stderr ? { stderr: truncateText(stderr) } : {}),
            }
        return { content: JSON.stringify(payload), isError: !succeeded, timedOut: result.timedOut }
      }

      const truncateStream = (value: string, capturedTruncated: boolean) => ({
        text: value.slice(0, ARENA_ACTIVE_TOOL_LIMITS.bashOutputChars),
        truncated: capturedTruncated || value.length > ARENA_ACTIVE_TOOL_LIMITS.bashOutputChars,
      })
      const stdout = truncateStream(result.stdout, result.stdoutTruncated)
      const stderr = truncateStream(result.stderr, result.stderrTruncated)
      const status = context.signal.aborted
        ? 'killed'
        : result.timedOut
        ? 'timeout'
        : result.signal && result.exitCode === null
          ? 'killed'
          : 'completed'
      const failed = status !== 'completed' || result.exitCode !== 0
      return {
        content: JSON.stringify({
          stdout: stdout.text,
          stdout_truncated: stdout.truncated,
          stderr: stderr.text,
          stderr_truncated: stderr.truncated,
          exit_code: status === 'completed' ? result.exitCode : null,
          status,
          duration_ms: result.durationMs,
        }),
        // Arena keeps the process-level payload status as `completed` when a
        // command exits normally with a non-zero code, while the surrounding
        // tool terminal is failed. Preserve both facts so the model can
        // recover from stderr and the UI can render the red exit-code state.
        isError: failed,
        timedOut: result.timedOut,
        aborted: context.signal.aborted,
      }
    } finally {
      authorization?.release()
    }
  }

  private async resolveCommandWorkdir(workspace: string, value: unknown, field = 'workdir'): Promise<string> {
    if (value === undefined || value === '') return workspace
    if (typeof value !== 'string') throw new Error(`${field} must be a string`)
    const target = resolveWorkspacePath(workspace, arenaWorkspacePath(value))
    await assertNoSymlinkTraversal(workspace, target)
    if (!(await stat(target)).isDirectory()) throw new Error(`${field} must be an existing workspace directory`)
    return target
  }

  private async installNpmPackages(call: ToolCallRecord, context: ToolContext): Promise<ToolExecutionResult> {
    const packages = call.arguments.packages as string[]
    for (const spec of packages) {
      assertSafeNpmPackageSpec(spec)
      const hint = knownPythonOfficePackageHint(spec)
      if (hint) {
        return {
          content: JSON.stringify({
            status: 'error',
            message: `${spec} is a Python package, but install_npm_packages only installs npm registry packages. This runtime does not provide pip network installs. Use ${hint} and do not probe pip or network access through Bash.`,
          }),
          isError: true,
        }
      }
    }
    const command = ['npm install --ignore-scripts --no-audit --no-fund', ...packages.map(shellQuote)].join(' ')
    const workspace = this.store.workspaceDir(context.sessionId)
    const attempts: Array<Awaited<ReturnType<typeof runCommand>>> = []
    let verification: NpmPackageVerification = { installed: [], issues: [] }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.runToolCommand(call, context, command, true)
      attempts.push(result)
      const commandSucceeded = result.exitCode === 0 && !result.timedOut && !context.signal.aborted
      verification = commandSucceeded
        ? await verifyInstalledNpmPackages(workspace, packages)
        : { installed: [], issues: [`npm install exited with code ${result.exitCode ?? 'null'}`] }
      const incompleteSuccess = commandSucceeded && verification.issues.length > 0
      const retryableFailure = !commandSucceeded && isRetryableNpmInstallFailure(result.stderr)
      if (attempt === 0 && !result.timedOut && !context.signal.aborted && (incompleteSuccess || retryableFailure)) continue
      break
    }
    const result = attempts.at(-1) as Awaited<ReturnType<typeof runCommand>>
    const succeeded = result.exitCode === 0
      && !result.timedOut
      && !context.signal.aborted
      && verification.issues.length === 0
    const recovered = attempts.length > 1 && succeeded
    const successStdout = [
      recovered ? 'Harness retried one incomplete or transient npm install attempt.' : '',
      result.stdout.trim(),
      `Verified installed packages: ${verification.installed.join(', ')}`,
    ].filter(Boolean).join('\n')
    const failureStdout = attempts
      .map((attempt, index) => attempt.stdout ? `[attempt ${index + 1}]\n${attempt.stdout}` : '')
      .filter(Boolean)
      .join('\n')
    const failureStderr = attempts
      .map((attempt, index) => attempt.stderr ? `[attempt ${index + 1}]\n${attempt.stderr}` : '')
      .filter(Boolean)
      .join('\n')
    const payload = succeeded
      ? {
          status: 'success',
          ...(successStdout ? { stdout: truncateText(successStdout) } : {}),
          ...(result.stderr ? { stderr: result.stderr } : {}),
        }
      : {
          status: 'error',
          message: result.timedOut
            ? 'npm install timed out'
            : verification.issues.length > 0
              ? `npm install did not produce a usable requested package tree: ${verification.issues.join('; ')}`
              : `npm install exited with code ${result.exitCode ?? 'null'}`,
          ...(failureStdout ? { stdout: truncateText(failureStdout) } : {}),
          ...(failureStderr ? { stderr: truncateText(failureStderr) } : {}),
        }
    return { content: JSON.stringify(payload), isError: payload.status === 'error', timedOut: result.timedOut }
  }

  private async buildProject(call: ToolCallRecord, context: ToolContext): Promise<ToolExecutionResult> {
    const build = await this.runBuildStage(call, context)
    if (!build.ok) {
      return {
        content: JSON.stringify({
          status: 'error',
          message: build.message,
          ...(build.stdout ? { stdout: build.stdout } : {}),
          ...(build.stderr ? { stderr: build.stderr } : {}),
        }),
        isError: true,
        timedOut: build.timedOut,
      }
    }
    return {
      content: JSON.stringify({ status: 'success', stdout: build.stdout, stderr: build.stderr }),
      isError: false,
    }
  }

  private async buildAndStart(call: ToolCallRecord, context: ToolContext): Promise<ToolExecutionResult> {
    const startedAt = Date.now()
    const build = await this.runBuildStage(call, context)
    if (!build.ok) {
      return {
        content: JSON.stringify({
          status: 'error',
          message: build.message,
          stage: 'building',
          logTail: truncateLogTail(`${build.stdout}\n${build.stderr}`),
          ...(build.stdout ? { stdout: build.stdout } : {}),
          ...(build.stderr ? { stderr: build.stderr } : {}),
        }),
        isError: true,
        timedOut: build.timedOut,
      }
    }

    const workspace = this.store.workspaceDir(context.sessionId)
    const project = await readProjectConfiguration(workspace)
    const script = ['dev', 'start', 'preview'].find((name) => typeof project.scripts[name] === 'string')
    const supersededProcessId = (await this.store.get(context.sessionId)).website.processId
    let startedProcessId: string | undefined
    try {
      if (script) {
        const command = script === 'dev' || script === 'preview'
          ? `npm run ${script} -- --host 0.0.0.0`
          : 'npm run start'
        const process = await this.processes.start(
          context.sessionId,
          workspace,
          command,
          detectCommandPort(project.scripts[script]),
          { turnId: context.turnId, stepId: context.stepId, callId: call.id },
          'Website',
        )
        startedProcessId = process.id
        const ready = await this.processes.waitForPort(context.sessionId, process.id, this.websiteReadyTimeoutMs)
        if (ready.status !== 'running' || !ready.port) {
          if (ready.status === 'running') await this.processes.stop(context.sessionId, ready.id, {
            turnId: context.turnId,
            stepId: context.stepId,
            callId: context.callId,
          })
          return {
            content: JSON.stringify({
              status: 'error',
              message: ready.status === 'running' ? 'Project server did not report a reachable port' : `Project server ${ready.status}`,
              stage: 'starting-server',
              logTail: truncateLogTail(`${ready.stdout}\n${ready.stderr}`),
            }),
            isError: true,
          }
        }
        const published = await this.preview(context, { process_id: ready.id })
        if (published.isError) return published
      } else {
        const entryPath = await findWebsiteEntry(workspace, { signal: context.signal })
        if (!entryPath) {
          return {
            content: JSON.stringify({ status: 'error', message: 'No runnable npm script or HTML entry file found', stage: 'starting-server' }),
            isError: true,
          }
        }
        const published = await this.preview(context, { path: entryPath })
        if (published.isError) return published
      }
      if (supersededProcessId && supersededProcessId !== startedProcessId) {
        const superseded = this.processes.get(context.sessionId, supersededProcessId)
        if (superseded?.status === 'running') await this.processes.stop(context.sessionId, supersededProcessId, {
          turnId: context.turnId,
          stepId: context.stepId,
          callId: context.callId,
        })
      }
      const website = (await this.store.get(context.sessionId)).website
      if (!website.previewUrl) throw new Error('Website preview URL was not persisted')
      return {
        content: JSON.stringify({ status: 'success', previewUrl: website.previewUrl, buildLatencyMs: Date.now() - startedAt }),
        isError: false,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (startedProcessId) {
        const started = this.processes.get(context.sessionId, startedProcessId)
        if (started?.status === 'running') await this.processes.stop(context.sessionId, startedProcessId).catch(() => undefined)
      }
      return {
        content: JSON.stringify({ status: 'error', message, stage: 'starting-server', logTail: truncateLogTail(message) }),
        isError: true,
      }
    }
  }

  private async deployProject(call: ToolCallRecord, context: ToolContext): Promise<ToolExecutionResult> {
    const approved = await this.requestApproval(context, call)
    if (!approved) {
      return {
        content: JSON.stringify({ status: 'error', message: 'User denied project deployment' }),
        isError: true,
      }
    }

    const previous = (await this.store.get(context.sessionId)).deployment
    const now = new Date().toISOString()
    const id = previous.id ?? createId('dep')
    await this.store.recordDeploymentUpdate(context.sessionId, {
      ...previous,
      id,
      status: 'building',
      error: undefined,
      createdAt: previous.createdAt ?? now,
      updatedAt: now,
    }, 'building', {
      turnId: context.turnId,
      stepId: context.stepId,
      callId: call.id,
    })
    const build = await this.runBuildStage(call, context)
    if (!build.ok) {
      const message = build.message || 'Project build failed'
      await this.store.recordDeploymentUpdate(context.sessionId, {
        ...previous,
        id,
        status: 'failed',
        error: message,
        createdAt: previous.createdAt ?? now,
        updatedAt: new Date().toISOString(),
      }, 'build_failed', {
        turnId: context.turnId,
        stepId: context.stepId,
        callId: call.id,
      })
      return {
        content: JSON.stringify({
          status: 'error',
          message,
          ...(build.stdout ? { stdout: build.stdout } : {}),
          ...(build.stderr ? { stderr: build.stderr } : {}),
        }),
        isError: true,
        timedOut: build.timedOut,
      }
    }

    const revision = previous.revision + 1
    const baseUrl = config.publicBaseUrl || `http://127.0.0.1:${config.port}`
    const url = `${baseUrl}/deployments/${context.sessionId}/`
    const visibility = config.publicBaseUrl ? 'public' as const : 'local' as const
    const deploying: DeploymentState = {
      ...previous,
      id,
      status: 'deploying',
      error: undefined,
      createdAt: previous.createdAt ?? now,
      updatedAt: new Date().toISOString(),
    }
    const checkpoint = {
      id: createId('dpc'),
      deploymentId: id,
      revision,
      previous,
      deploying,
      url,
      visibility,
      createdAt: previous.createdAt ?? now,
      successAction: previous.revision > 0 ? 'redeployed' as const : 'deployed' as const,
      phase: 'snapshotting' as const,
      deployingEventId: createId('evt'),
      completionEventId: createId('evt'),
      context: {
        turnId: context.turnId,
        stepId: context.stepId,
        callId: call.id,
      },
    }
    await this.store.stageDeploymentSnapshot(context.sessionId, checkpoint)
    const target = this.store.deploymentRevisionDir(context.sessionId, revision)
    let snapshot: StaticDeploymentSnapshot
    try {
      snapshot = await createStaticDeploymentSnapshot(
        this.store.workspaceDir(context.sessionId),
        target,
        context.signal,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await removeStaticDeploymentSnapshot(target)
      await this.store.settleDeploymentSnapshot(context.sessionId, checkpoint.id, {
        ...previous,
        id,
        status: 'failed',
        error: message,
        createdAt: previous.createdAt ?? now,
        updatedAt: new Date().toISOString(),
      }, 'deploy_failed')
      return { content: JSON.stringify({ status: 'error', message }), isError: true }
    }
    const deployed: DeploymentState = {
      id,
      status: 'deployed',
      url,
      visibility,
      revision,
      entryPath: snapshot.entryPath,
      contentHash: snapshot.contentHash,
      fileCount: snapshot.fileCount,
      bytes: snapshot.bytes,
      createdAt: previous.createdAt ?? now,
      updatedAt: new Date().toISOString(),
    }
    // A publication I/O failure leaves the ready checkpoint and verified
    // revision intact for startup replay; it must never be downgraded to a
    // failed deployment merely because event publication was interrupted.
    await this.store.settleDeploymentSnapshot(context.sessionId, checkpoint.id, deployed, checkpoint.successAction)
    return { content: JSON.stringify({ status: 'success' }), isError: false }
  }

  private async runBuildStage(call: ToolCallRecord, context: ToolContext): Promise<{
    ok: boolean
    message?: string
    stdout: string
    stderr: string
    timedOut?: boolean
  }> {
    const project = await readProjectConfiguration(this.store.workspaceDir(context.sessionId))
    if (!project.scripts.build) {
      const entryPath = await findWebsiteEntry(this.store.workspaceDir(context.sessionId), { signal: context.signal })
      if (!entryPath && !['dev', 'start', 'preview'].some((name) => project.scripts[name])) {
        return { ok: false, message: 'No build script, runnable npm script, or HTML entry file found', stdout: '', stderr: '' }
      }
      return { ok: true, stdout: 'No build script configured; build stage skipped.\n', stderr: '' }
    }
    const result = await this.runToolCommand(call, context, 'npm run build', false)
    const ok = result.exitCode === 0 && !result.timedOut && !context.signal.aborted
    return {
      ok,
      ...(ok ? {} : { message: result.timedOut ? 'Project build timed out' : `Project build exited with code ${result.exitCode ?? 'null'}` }),
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    }
  }

  private async runToolCommand(
    call: ToolCallRecord,
    context: ToolContext,
    command: string,
    allowNetwork: boolean,
  ): Promise<Awaited<ReturnType<typeof runCommand>>> {
    const workspace = this.store.workspaceDir(context.sessionId)
    const before = await workspaceFileSnapshot(workspace, { signal: context.signal })
    const guardianId = createId('cmd')
    const reconciliationId = await this.store.stageShellReconciliation(
      context.sessionId,
      guardianId,
      before,
      { turnId: context.turnId, stepId: context.stepId, callId: call.id },
    )
    try {
      return await this.runCommandImpl({
        command,
        workspace,
        timeoutMs: config.toolTimeoutMs,
        maxOutputBytes: config.maxToolOutputBytes,
        signal: context.signal,
        allowNetwork,
        guardianId,
        onGuardianReady: async (pid) => await this.store.armShellReconciliation(context.sessionId, reconciliationId, pid),
        onOutput: (stream, chunk) => {
          this.store.registerSensitiveValues(context.sessionId, findSensitiveValues(chunk))
          if (!this.store.hasSensitiveValues(context.sessionId)) {
            void this.store.append(context.sessionId, 'tool.output', { stream, chunk }, {
              turnId: context.turnId,
              stepId: context.stepId,
              callId: call.id,
            })
          }
        },
      })
    } finally {
      const settled = await this.store.settleShellReconciliation(context.sessionId, reconciliationId)
      if (settled.batchId) await this.store.publishWorkspaceEventBatch(context.sessionId, settled.batchId)
    }
  }

  private async webFetch(rawUrl: string, format: string, signal: AbortSignal): Promise<ToolExecutionResult> {
    let url = await this.validateUrl(rawUrl)
    let response: Response | undefined
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      response = await this.externalFetchImpl(url, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': 'Anera-Agent/0.1 (+local research harness)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      if (!location) break
      url = await this.validateUrl(new URL(location, url).toString())
      response = undefined
    }
    if (!response) throw new Error('Web request exceeded five safe redirects')
    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    const bounded = await readBoundedResponseText(response, config.maxReadBytes)
    const raw = bounded.text
    const finalUrl = response.url || url.toString()
    const title = contentType.includes('html') ? extractHtmlTitle(raw, finalUrl) : finalUrl
    const readableHtml = contentType.includes('html') ? htmlReadableBody(raw) : raw
    let content = contentType.includes('html')
      ? format === 'html' ? raw : format === 'text' ? stripHtml(readableHtml) : htmlToMarkdown(readableHtml)
      : raw
    if (bounded.truncated) content = `${content}\n\n[Content truncated]`
    if (!response.ok) {
      return {
        content: JSON.stringify({
          status: 'error',
          message: `HTTP ${response.status} fetching ${finalUrl}`,
          ...(content ? { stdout: truncateText(content) } : {}),
        }),
        isError: true,
      }
    }
    return { content: JSON.stringify({ status: 'success', title, content: truncateText(content) }), isError: false }
  }

  private async fetchPage(rawUrl: string, chunkIndex: number, context: ToolContext): Promise<ToolExecutionResult> {
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) throw new Error('chunkIndex must be a non-negative integer')
    const requests: WebProviderRequestMetering[] = []
    try {
      const url = await this.validateUrl(rawUrl)
      if (context.signal.aborted) throw context.signal.reason
      const canonicalUrl = canonicalFetchPageUrl(url)
      const directKey = this.fetchPageCacheKey(context, canonicalUrl, 'direct')
      if (this.firecrawlApiKey) {
        const firecrawlKey = this.fetchPageCacheKey(context, canonicalUrl, 'firecrawl')
        const firecrawlCached = this.getFetchPageSnapshot(firecrawlKey)
        if (firecrawlCached) {
          return withWebProviderUsage(
            this.fetchPageChunkResult(firecrawlCached, chunkIndex),
            webProviderMetering('hit', requests, 'firecrawl'),
          )
        }
        const directCached = this.getFetchPageSnapshot(directKey)
        if (directCached) {
          return withWebProviderUsage(
            this.fetchPageChunkResult(directCached, chunkIndex),
            webProviderMetering('hit', requests, 'direct'),
          )
        }
        try {
          const snapshot = await this.fetchPageWithFirecrawl(url, context.signal, requests)
          this.cacheFetchPageSnapshot(firecrawlKey, snapshot)
          return withWebProviderUsage(
            this.fetchPageChunkResult(snapshot, chunkIndex),
            webProviderMetering('miss', requests),
          )
        } catch (error) {
          if (context.signal.aborted) throw error
          // Firecrawl is the preferred extractor, but a provider outage must not
          // remove the harness's existing safe direct-fetch capability.
        }
      }
      const cached = this.getFetchPageSnapshot(directKey)
      if (cached) {
        return withWebProviderUsage(
          this.fetchPageChunkResult(cached, chunkIndex),
          webProviderMetering('hit', requests, 'direct'),
        )
      }
      const loaded = await this.fetchPageDirect(url, context.signal, requests)
      if ('result' in loaded) return withWebProviderUsage(loaded.result, webProviderMetering('miss', requests))
      this.cacheFetchPageSnapshot(directKey, loaded.snapshot)
      return withWebProviderUsage(
        this.fetchPageChunkResult(loaded.snapshot, chunkIndex),
        webProviderMetering('miss', requests),
      )
    } catch (error) {
      throw withToolWebProviderUsage(error, webProviderMetering('miss', requests))
    }
  }

  private async fetchPageWithFirecrawl(
    url: URL,
    signal: AbortSignal,
    requests: WebProviderRequestMetering[],
  ): Promise<FetchPageSnapshot> {
    const attempt = beginWebProviderRequest(requests, 'firecrawl', 'fetch')
    const response = await this.externalFetchImpl(`${this.firecrawlBaseUrl}/scrape`, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        authorization: `Bearer ${this.firecrawlApiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        url: url.toString(),
        formats: ['markdown'],
        onlyMainContent: true,
        timeout: Math.min(this.toolTimeoutMs, 300_000),
      }),
    })
    const bounded = await readBoundedResponseText(response, config.maxReadBytes * 12)
    attempt.responseBytes = bounded.bytesRead
    if (!response.ok) throw new Error(`Firecrawl request failed with HTTP ${response.status}`)
    if (bounded.truncated) throw new Error('Firecrawl response exceeded the safe response limit')
    let envelope: FirecrawlScrapeResponse
    try {
      envelope = JSON.parse(bounded.text) as FirecrawlScrapeResponse
    } catch {
      throw new Error('Firecrawl returned invalid JSON')
    }
    if (envelope.success !== true || !envelope.data || typeof envelope.data !== 'object') {
      throw new Error('Firecrawl did not return a successful scrape')
    }
    const metadata = envelope.data.metadata && typeof envelope.data.metadata === 'object'
      ? envelope.data.metadata
      : {}
    const statusCode = typeof metadata.statusCode === 'number' ? metadata.statusCode : undefined
    if (statusCode !== undefined && statusCode >= 400) throw new Error(`Firecrawl target returned HTTP ${statusCode}`)
    const providerUrl = firstNonEmptyString(metadata.sourceURL, metadata.url) ?? url.toString()
    const finalUrl = await this.validateUrl(new URL(providerUrl, url).toString())
    const rawMarkdown = typeof envelope.data.markdown === 'string'
      ? envelope.data.markdown
      : typeof envelope.data.html === 'string'
        ? htmlToMarkdown(envelope.data.html)
        : undefined
    if (rawMarkdown === undefined) throw new Error('Firecrawl response did not contain page content')
    const readable = redactExactSecrets(rawMarkdown.replace(/\r\n?/g, '\n'), [this.firecrawlApiKey])
    const title = redactExactSecrets(
      firstNonEmptyString(metadata.title) ?? extractHtmlTitle('', finalUrl.toString()),
      [this.firecrawlApiKey],
    )
    attempt.outcome = 'success'
    return {
      url: redactExactSecrets(finalUrl.toString(), [this.firecrawlApiKey]),
      title,
      readable,
      sourceTruncated: false,
    }
  }

  private async fetchPageDirect(
    initialUrl: URL,
    signal: AbortSignal,
    requests: WebProviderRequestMetering[],
  ): Promise<FetchPageLoad> {
    const attempt = beginWebProviderRequest(requests, 'direct', 'fetch', 0)
    let url = initialUrl
    let response: Response | undefined
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      attempt.calls += 1
      response = await this.externalFetchImpl(url, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': 'Anera-Agent/0.1 (+Arena-compatible harness)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      if (!location) break
      url = await this.validateUrl(new URL(location, url).toString())
      response = undefined
    }
    if (!response) throw new Error('Web request exceeded five safe redirects')
    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    const bounded = await readBoundedResponseBuffer(response, config.maxReadBytes * 10)
    attempt.responseBytes += bounded.bytesRead
    const finalUrl = response.url || url.toString()
    if (!response.ok) {
      return {
        result: {
          content: JSON.stringify({ status: 'error', error: `HTTP ${response.status} fetching ${finalUrl}` }),
          isError: true,
        },
      }
    }
    const declaredPdf = isPdfContentType(contentType)
    const sniffedPdf = hasPdfMagic(bounded.bytes)
    if (declaredPdf && !sniffedPdf) {
      throw new Error(`PDF response from ${finalUrl} is missing the required %PDF- signature`)
    }
    if (sniffedPdf && bounded.truncated) {
      throw new Error(`PDF response from ${finalUrl} exceeds the ${config.maxReadBytes * 10}-byte download limit`)
    }
    const raw = sniffedPdf ? '' : new TextDecoder().decode(bounded.bytes)
    const title = contentType.includes('html') && !sniffedPdf ? extractHtmlTitle(raw, finalUrl) : finalUrl
    const extracted = sniffedPdf
      ? await extractFetchPagePdf(bounded.bytes, signal)
      : contentType.includes('html')
        ? htmlToMarkdown(htmlReadableBody(raw))
        : raw
    const readable = !sniffedPdf && bounded.truncated
      ? `${extracted}\n\n[Source response byte limit reached after ${bounded.bytesRead} bytes. `
        + 'Content beyond this point is unavailable from fetch_page; chunk continuation ends after the text above.]'
      : extracted
    attempt.outcome = 'success'
    return {
      snapshot: {
        url: finalUrl,
        title,
        readable,
        // Page/download-limit markers are part of the readable snapshot, so
        // continuation ends at the final available chunk instead of implying
        // that bytes or PDF pages the Harness discarded can still be fetched.
        sourceTruncated: false,
      },
    }
  }

  private fetchPageChunkResult(snapshot: FetchPageSnapshot, chunkIndex: number): ToolExecutionResult {
    const chunks = splitUtf8Chunks(snapshot.readable, config.maxReadBytes)
    if (chunkIndex >= chunks.length) throw new Error(`chunkIndex ${chunkIndex} is past the final chunk ${Math.max(0, chunks.length - 1)}`)
    const hasMore = chunkIndex + 1 < chunks.length || snapshot.sourceTruncated
    return {
      content: JSON.stringify({
        status: 'success',
        url: snapshot.url,
        title: snapshot.title,
        content: chunks[chunkIndex] ?? '',
        chunkIndex,
        hasMore,
        totalChunks: chunks.length,
      }),
      isError: false,
    }
  }

  private fetchPageCacheKey(
    context: Pick<ToolContext, 'sessionId' | 'turnId'>,
    canonicalUrl: string,
    provider: FetchPageProvider,
  ): string {
    return `${context.sessionId}\0${context.turnId}\0${provider}\0${canonicalUrl}`
  }

  private getFetchPageSnapshot(key: string): FetchPageSnapshot | undefined {
    const entry = this.fetchPageCache.get(key)
    if (!entry) return undefined
    // Map insertion order is the LRU order; a hit becomes most-recently used.
    this.fetchPageCache.delete(key)
    this.fetchPageCache.set(key, entry)
    return entry.snapshot
  }

  private cacheFetchPageSnapshot(key: string, snapshot: FetchPageSnapshot): void {
    if (this.fetchPageCacheMaxEntries === 0 || this.fetchPageCacheMaxBytes === 0) return
    const bytes = fetchPageSnapshotBytes(snapshot)
    if (bytes > this.fetchPageCacheMaxBytes) return
    const existing = this.fetchPageCache.get(key)
    if (existing) {
      this.fetchPageCache.delete(key)
      this.fetchPageCacheBytes -= existing.bytes
    }
    this.fetchPageCache.set(key, { snapshot, bytes })
    this.fetchPageCacheBytes += bytes
    while (
      this.fetchPageCache.size > this.fetchPageCacheMaxEntries
      || this.fetchPageCacheBytes > this.fetchPageCacheMaxBytes
    ) {
      const oldestKey = this.fetchPageCache.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const oldest = this.fetchPageCache.get(oldestKey)
      this.fetchPageCache.delete(oldestKey)
      this.fetchPageCacheBytes -= oldest?.bytes ?? 0
    }
  }

  private async getProcessOutput(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const processId = requiredString(args, 'process_id')
    const tailLines = typeof args.tail_lines === 'number'
      ? args.tail_lines
      : ARENA_ACTIVE_TOOL_LIMITS.processDefaultTailLines
    const waitFor = typeof args.wait_for === 'string' ? args.wait_for : undefined
    const waitPattern = typeof args.wait_pattern === 'string' ? args.wait_pattern : undefined
    if (waitFor === 'log' && !waitPattern?.trim()) throw new Error('wait_pattern is required when wait_for is log')
    const timeoutSeconds = Math.min(
      ARENA_ACTIVE_TOOL_LIMITS.processMaxWaitSeconds,
      Math.max(1, typeof args.wait_timeout === 'number' ? args.wait_timeout : ARENA_ACTIVE_TOOL_LIMITS.processDefaultWaitSeconds),
    )
    const started = Date.now()
    const initial = this.processes.get(context.sessionId, processId)
      ?? (await this.store.get(context.sessionId)).processes.find((process) => process.id === processId)
    if (!initial) {
      return {
        content: JSON.stringify({ status: 'not_found', exit_code: null, log_tail: '', listening_ports: [] }),
        isError: false,
      }
    }
    let record = initial
    let waitResult: 'satisfied' | 'process_exited' | 'timeout' | undefined = waitFor ? 'timeout' : undefined
    let logMatcher: ((value: string) => boolean) | undefined
    if (waitFor === 'log' && waitPattern) {
      try {
        const expression = new RegExp(waitPattern)
        logMatcher = (value) => expression.test(value)
      } catch {
        logMatcher = (value) => value.includes(waitPattern)
      }
    }
    if (!waitFor) {
      record = await this.processes.refreshPorts(context.sessionId, processId)
        ?? this.processes.get(context.sessionId, processId)
        ?? (await this.store.get(context.sessionId)).processes.find((process) => process.id === processId)
        ?? record
    }
    while (waitFor) {
      record = await this.processes.refreshPorts(context.sessionId, processId)
        ?? this.processes.get(context.sessionId, processId)
        ?? (await this.store.get(context.sessionId)).processes.find((process) => process.id === processId)
        ?? record
      const output = record.combinedOutput ?? `${record.stdout}\n${record.stderr}`
      if (waitFor === 'port' && (record.newPorts?.length ?? 0) > 0) {
        waitResult = 'satisfied'
        break
      }
      if (waitFor === 'log' && logMatcher?.(output)) {
        waitResult = 'satisfied'
        break
      }
      if (record.status !== 'running') {
        waitResult = waitFor === 'exit' ? 'satisfied' : 'process_exited'
        break
      }
      if (Date.now() - started >= timeoutSeconds * 1_000) break
      await abortableDelay(Math.min(150, Math.max(1, timeoutSeconds * 1_000 - (Date.now() - started))), context.signal)
    }
    const previewPort = previewableProcessPort(record)
    if (previewPort && record.status === 'running') await this.publishProcessPreview(context, { id: record.id, port: previewPort })
    return {
      content: JSON.stringify({
        status: record.status === 'running' ? 'running' : 'exited',
        exit_code: record.exitCode ?? null,
        log_tail: combinedProcessLog(record, tailLines),
        listening_ports: listeningProcessPorts(record),
        ...(waitResult ? { wait_result: waitResult } : {}),
      }),
      isError: false,
    }
  }

  private async publishProcessPreview(
    context: ToolContext,
    process: { id: string; port?: number },
    serverCwd = '',
  ): Promise<string[]> {
    if (!process.port) return []
    const current = (await this.store.get(context.sessionId)).website
    if (current.status === 'running' && current.processId === process.id && current.port === process.port) return []
    const baseUrl = `http://127.0.0.1:${process.port}`
    const resolved = await this.resolveProcessPreviewEntry(context, baseUrl, serverCwd)
    await this.store.recordWebsiteUpdate(context.sessionId, {
      status: 'running',
      ...(resolved.entryPath ? { entryPath: resolved.entryPath } : {}),
      processId: process.id,
      port: process.port,
      previewUrl: resolved.previewUrl,
      updatedAt: new Date().toISOString(),
      restartCount: current.restartCount,
    }, { action: 'process_preview' }, {
      turnId: context.turnId,
      stepId: context.stepId,
      callId: context.callId,
    })
    return resolved.warnings
  }

  private async resolveProcessPreviewEntry(
    context: ToolContext,
    baseUrl: string,
    serverCwd: string,
  ): Promise<{ previewUrl: string; entryPath?: string; warnings: string[] }> {
    const fallback = { previewUrl: baseUrl, warnings: [] as string[] }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('preview entry probe timed out')), 1_000)
    timer.unref?.()
    try {
      const response = await this.fetchImpl(`${baseUrl}/`, {
        method: 'GET',
        redirect: 'follow',
        headers: { accept: 'text/html,*/*;q=0.8' },
        signal: AbortSignal.any([context.signal, controller.signal]),
      })
      const contentType = response.headers.get('content-type') ?? ''
      if (!response.ok || !contentType.toLowerCase().includes('html')) {
        await response.body?.cancel().catch(() => undefined)
        return fallback
      }
      const body = await readBoundedResponseText(response, 64 * 1_024)
      const workspace = this.store.workspaceDir(context.sessionId)
      const serverRoot = resolveWorkspacePath(workspace, serverCwd)
      await assertNoSymlinkTraversal(workspace, serverRoot)
      const htmlFiles = (await listWorkspaceFiles(serverRoot, '', context.signal))
        .map(({ path }) => path)
        .filter((path) => /\.html?$/i.test(path))
      const workspaceEntry = (relativeEntry: string) => [serverCwd, relativeEntry]
        .filter(Boolean)
        .join('/')
        .replaceAll('\\', '/')
      if (isDirectoryListingHtml(body.text)) {
        if (htmlFiles.length === 1) {
          const relativeEntry = htmlFiles[0]
          return {
            previewUrl: `${baseUrl}/${encodeWorkspaceUrlPath(relativeEntry)}`,
            entryPath: workspaceEntry(relativeEntry),
            warnings: [],
          }
        }
        if (htmlFiles.length > 1) {
          return {
            ...fallback,
            warnings: [`Live preview root is a directory listing with ${htmlFiles.length} HTML entries; kept the root URL because no unique entry could be selected.`],
          }
        }
        return fallback
      }
      const indexEntry = htmlFiles.find((path) => path.toLowerCase() === 'index.html')
      return indexEntry
        ? { previewUrl: baseUrl, entryPath: workspaceEntry(indexEntry), warnings: [] }
        : fallback
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason
      return fallback
    } finally {
      clearTimeout(timer)
    }
  }

  private async searchWeb(query: string, depth: string, signal: AbortSignal): Promise<ToolExecutionResult> {
    const limit = depth === '1' ? 4 : depth === '2' ? 6 : 8
    const failures: string[] = []
    const requests: WebProviderRequestMetering[] = []
    if (this.tavilyApiKey) {
      try {
        const result = await this.searchWithTavily(query, depth, limit, signal, requests)
        if (result) return withWebProviderUsage(result, webProviderMetering('not_applicable', requests))
        failures.push('tavily: no usable results')
      } catch (error) {
        if (signal.aborted) throw withToolWebProviderUsage(error, webProviderMetering('not_applicable', requests))
        // Never surface a credentialed provider's raw error because fetch
        // adapters and upstream responses may echo request metadata.
        failures.push('tavily: request failed')
      }
    }
    const providers = [
      {
        name: 'bing',
        url: new URL('https://www.bing.com/search'),
        parse: parseBingResults,
      },
      {
        name: 'duckduckgo',
        url: new URL('https://html.duckduckgo.com/html/'),
        parse: parseDuckDuckGoResults,
      },
    ]
    for (const provider of providers) {
      provider.url.searchParams.set('q', query)
      const attempt = beginWebProviderRequest(requests, provider.name as 'bing' | 'duckduckgo', 'search')
      try {
        const response = await this.externalFetchImpl(provider.url, {
          method: 'GET',
          signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
            accept: 'text/html,application/xhtml+xml',
          },
        })
        const bounded = await readBoundedResponseText(response, config.maxReadBytes)
        attempt.responseBytes = bounded.bytesRead
        const html = bounded.text
        const results = await this.admitSearchResults(
          provider.parse(html, provider.url),
          limit,
          signal,
        )
        if (response.ok && results.length > 0) {
          attempt.outcome = 'success'
          return withWebProviderUsage({
            content: JSON.stringify({
              status: 'success',
              results: results.map((result, index) => ({
                id: index + 1,
                title: result.title,
                url: result.url,
                description: result.snippet,
              })),
            }),
            isError: false,
          }, webProviderMetering('not_applicable', requests))
        }
        if (response.ok) attempt.outcome = 'empty'
        failures.push(`${provider.name}: HTTP ${response.status}, ${results.length} results`)
      } catch (error) {
        if (signal.aborted) throw withToolWebProviderUsage(error, webProviderMetering('not_applicable', requests))
        failures.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return withWebProviderUsage({
      content: JSON.stringify({ status: 'error', error: `Web search failed: ${failures.join('; ')}` }),
      isError: true,
    }, webProviderMetering('not_applicable', requests))
  }

  private async searchWithTavily(
    query: string,
    depth: string,
    limit: number,
    signal: AbortSignal,
    requests: WebProviderRequestMetering[],
  ): Promise<ToolExecutionResult | undefined> {
    const attempt = beginWebProviderRequest(requests, 'tavily', 'search')
    const response = await this.externalFetchImpl(`${this.tavilyBaseUrl}/search`, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        authorization: `Bearer ${this.tavilyApiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        query,
        topic: 'general',
        search_depth: depth === '1' ? 'basic' : 'advanced',
        max_results: limit,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        ...(depth === '3' ? { chunks_per_source: 3 } : {}),
      }),
    })
    const bounded = await readBoundedResponseText(response, config.maxReadBytes)
    attempt.responseBytes = bounded.bytesRead
    if (!response.ok) throw new Error(`Tavily request failed with HTTP ${response.status}`)
    if (bounded.truncated) throw new Error('Tavily response exceeded the safe response limit')
    let payload: TavilySearchResponse
    try {
      payload = JSON.parse(bounded.text) as TavilySearchResponse
    } catch {
      throw new Error('Tavily returned invalid JSON')
    }
    if (!Array.isArray(payload.results)) {
      attempt.outcome = 'empty'
      return undefined
    }
    const candidates = payload.results.flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const title = firstNonEmptyString(raw.title)
      const url = firstNonEmptyString(raw.url)
      const description = firstNonEmptyString(raw.content, raw.snippet)
      if (!title || !url || !description || !/^https?:\/\//i.test(url)) return []
      return [{
        title: redactExactSecrets(title, [this.tavilyApiKey]),
        url: redactExactSecrets(url, [this.tavilyApiKey]),
        description: redactExactSecrets(normalizeSearchSnippet(description), [this.tavilyApiKey]),
        pageAge: firstNonEmptyString(raw.published_date),
      }]
    })
    const results = await this.admitSearchResults(candidates, limit, signal)
    if (results.length === 0) {
      attempt.outcome = 'empty'
      return undefined
    }
    attempt.outcome = 'success'
    return {
      content: JSON.stringify({
        status: 'success',
        results: results.map((result, index) => ({
          id: index + 1,
          title: result.title,
          url: result.url,
          description: result.description,
          ...(result.pageAge ? { pageAge: redactExactSecrets(result.pageAge, [this.tavilyApiKey]) } : {}),
        })),
      }),
      isError: false,
    }
  }

  private async admitSearchResults<T extends { url: string }>(
    candidates: T[],
    limit: number,
    signal: AbortSignal,
  ): Promise<T[]> {
    if (signal.aborted) throw signal.reason
    const inspected = await Promise.all(candidates.map(async (candidate) => {
      try {
        const validated = await this.validateUrl(candidate.url)
        const canonical = new URL(validated)
        canonical.hash = ''
        return {
          candidate: { ...candidate, url: canonical.toString() },
          key: canonical.toString(),
        }
      } catch {
        return undefined
      }
    }))
    if (signal.aborted) throw signal.reason
    const seen = new Set<string>()
    const admitted: T[] = []
    for (const item of inspected) {
      if (!item || seen.has(item.key)) continue
      seen.add(item.key)
      admitted.push(item.candidate)
      if (admitted.length >= limit) break
    }
    return admitted
  }

  private async fetchMedia(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecutionResult> {
    if (!this.pexelsApiKey) throw new Error('fetch_media requires PEXELS_API_KEY to be configured')
    const query = requiredString(args, 'query')
    const mediaType = (typeof args.media_type === 'string' ? args.media_type : 'both') as MediaType
    const rawCount = typeof args.count === 'number' ? args.count : 6
    if (!Number.isFinite(rawCount) || rawCount <= 0) throw new Error('count must be a positive number')
    const count = Math.min(80, Math.max(1, Math.floor(rawCount)))
    const orientation = typeof args.orientation === 'string' ? args.orientation : 'any'
    const size = typeof args.size === 'string' ? args.size : 'any'
    const locale = typeof args.locale === 'string' && args.locale.trim() ? args.locale.trim() : undefined
    const imageCount = mediaType === 'both' ? Math.ceil(count / 2) : count
    const videoCount = mediaType === 'both' ? Math.floor(count / 2) : count

    const request = async (kind: 'image' | 'video', perPage: number): Promise<PexelsMediaPage> => {
      const endpoint = new URL(kind === 'image' ? 'https://api.pexels.com/v1/search' : 'https://api.pexels.com/videos/search')
      endpoint.searchParams.set('query', query)
      endpoint.searchParams.set('per_page', String(perPage))
      if (orientation !== 'any') endpoint.searchParams.set('orientation', orientation)
      if (size !== 'any') endpoint.searchParams.set('size', size)
      if (locale) endpoint.searchParams.set('locale', locale)
      const response = await this.externalFetchImpl(endpoint, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: {
          authorization: this.pexelsApiKey,
          accept: 'application/json',
          'user-agent': 'Anera-Agent/0.1 (+local media harness)',
        },
      })
      const bounded = await readBoundedResponseText(response, config.maxReadBytes)
      if (bounded.truncated) throw new Error(`Pexels ${kind} response exceeded the ${config.maxReadBytes}-byte limit`)
      if (!response.ok) throw new Error(`Pexels ${kind} search failed with HTTP ${response.status}`)
      let parsed: unknown
      try {
        parsed = JSON.parse(bounded.text)
      } catch {
        throw new Error(`Pexels ${kind} search returned invalid JSON`)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Pexels ${kind} search returned an invalid payload`)
      return parsed as PexelsMediaPage
    }

    const [imagePage, videoPage] = await Promise.all([
      mediaType === 'video' || imageCount === 0 ? undefined : request('image', imageCount),
      mediaType === 'image' || videoCount === 0 ? undefined : request('video', videoCount),
    ])
    const images = Array.isArray(imagePage?.photos) ? imagePage.photos.map(pexelsImageResult).filter(isMediaResult) : []
    const videos = Array.isArray(videoPage?.videos) ? videoPage.videos.map(pexelsVideoResult).filter(isMediaResult) : []
    const results = mediaType === 'both' ? interleave(images, videos).slice(0, count) : (mediaType === 'image' ? images : videos).slice(0, count)
    const imageTotal = typeof imagePage?.total_results === 'number' && Number.isFinite(imagePage.total_results) ? imagePage.total_results : images.length
    const videoTotal = typeof videoPage?.total_results === 'number' && Number.isFinite(videoPage.total_results) ? videoPage.total_results : videos.length
    const totalResults = imageTotal + videoTotal
    return {
      content: JSON.stringify({
        status: 'success',
        query,
        mediaType,
        totalResults,
        results,
      }),
      isError: false,
    }
  }

  private async imageSearch(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const query = requiredString(args, 'query')
    const count = Math.min(
      ARENA_ACTIVE_TOOL_LIMITS.imageSearchMaxResults,
      Math.max(1, typeof args.count === 'number' ? Math.floor(args.count) : ARENA_ACTIVE_TOOL_LIMITS.imageSearchMaxResults),
    )
    const requests: WebProviderRequestMetering[] = []
    const failures: string[] = []
    let providerSucceeded = false
    let imageResults: ImageSearchCandidate[] = []

    if (this.pexelsApiKey) {
      try {
        const media = await this.fetchMedia(
          { query, media_type: 'image', count, orientation: 'any', size: 'any' },
          context.signal,
        )
        const parsed = JSON.parse(media.content) as { results?: MediaResult[] }
        const pexelsResults = (parsed.results ?? [])
          .filter((result) => result.type === 'image')
          .slice(0, count)
          .map((result) => ({
            downloadUrl: result.recommendedUrl,
            thumbnailUrl: result.thumbnailUrl ?? result.recommendedUrl,
            title: result.alt || `Image result ${result.id}`,
            sourceUrl: result.pexelsUrl,
          }))
        imageResults = await this.admitImageSearchCandidates(pexelsResults, count, context.signal)
        providerSucceeded = true
      } catch (error) {
        if (context.signal.aborted) throw error
        failures.push('Pexels request failed')
      }
    }

    if (imageResults.length === 0 && this.tavilyApiKey) {
      try {
        imageResults = await this.searchImagesWithTavily(query, count, context.signal, requests)
        providerSucceeded = true
      } catch (error) {
        if (context.signal.aborted) {
          throw withToolWebProviderUsage(error, webProviderMetering('not_applicable', requests))
        }
        failures.push('Tavily request failed')
      }
    }

    if (!this.pexelsApiKey && !this.tavilyApiKey) {
      throw new Error('image_search requires PEXELS_API_KEY or TAVILY_API_KEY to be configured')
    }
    if (!providerSucceeded) {
      const error = new Error(`Image search failed: ${failures.join('; ') || 'no provider was available'}`)
      throw requests.length > 0
        ? withToolWebProviderUsage(error, webProviderMetering('not_applicable', requests))
        : error
    }

    const asciiQuery = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
    const safeQuery = asciiQuery || `image-${arenaContentHash(query).slice(0, 8)}`
    const downloaded = await Promise.all(imageResults.map(async (result, index): Promise<Record<string, unknown> | undefined> => {
      if (context.signal.aborted) throw context.signal.reason
      let image: Buffer
      try {
        image = await this.downloadGeneratedImage(result.downloadUrl, context.signal)
      } catch (error) {
        if (context.signal.aborted) {
          throw requests.length > 0
            ? withToolWebProviderUsage(error, webProviderMetering('not_applicable', requests))
            : error
        }
        return undefined
      }
      const mime = sniffSearchImageMime(image)
      if (!mime) return undefined
      const path = `images/${safeQuery}-${String(index + 1).padStart(2, '0')}${searchImageExtension(mime)}`
      await this.store.commitWorkspaceWrite(context.sessionId, {
        path,
        content: image,
        mode: 'upsert',
        operation: 'image-search',
        artifact: this.artifactForPath(context, path),
        context: { turnId: context.turnId, stepId: context.stepId, callId: context.callId },
      })
      return {
        file_path: path,
        hash: arenaContentHash(image),
        thumbnail_url: result.thumbnailUrl,
        title: result.title,
        source_url: result.sourceUrl,
      }
    }))
    const saved = downloaded.filter((result): result is Record<string, unknown> => result !== undefined)
    if (imageResults.length > 0 && saved.length === 0) {
      const error = new Error('Image search returned results, but none could be saved as PNG, JPEG, WebP, or GIF')
      throw requests.length > 0
        ? withToolWebProviderUsage(error, webProviderMetering('not_applicable', requests))
        : error
    }
    const result: ToolExecutionResult = {
      content: JSON.stringify({ status: 'success', results: saved }),
      isError: false,
    }
    return requests.length > 0
      ? withWebProviderUsage(result, webProviderMetering('not_applicable', requests))
      : result
  }

  private async searchImagesWithTavily(
    query: string,
    count: number,
    signal: AbortSignal,
    requests: WebProviderRequestMetering[],
  ): Promise<ImageSearchCandidate[]> {
    const attempt = beginWebProviderRequest(requests, 'tavily', 'search')
    const response = await this.externalFetchImpl(`${this.tavilyBaseUrl}/search`, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        authorization: `Bearer ${this.tavilyApiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        query,
        topic: 'general',
        search_depth: 'basic',
        max_results: count,
        include_answer: false,
        include_raw_content: false,
        include_images: true,
        include_image_descriptions: true,
      }),
    })
    const bounded = await readBoundedResponseText(response, config.maxReadBytes)
    attempt.responseBytes = bounded.bytesRead
    if (!response.ok) throw new Error(`Tavily image request failed with HTTP ${response.status}`)
    if (bounded.truncated) throw new Error('Tavily image response exceeded the safe response limit')
    let payload: TavilySearchResponse
    try {
      payload = JSON.parse(bounded.text) as TavilySearchResponse
    } catch {
      throw new Error('Tavily image search returned invalid JSON')
    }
    if (!Array.isArray(payload.images)) {
      attempt.outcome = 'empty'
      return []
    }
    const candidates = payload.images.flatMap((raw, index): ImageSearchCandidate[] => {
      if (typeof raw === 'string') {
        const url = raw.trim()
        return /^https?:\/\//i.test(url) && !url.includes(this.tavilyApiKey)
          ? [{ downloadUrl: url, thumbnailUrl: url, title: `${query} image ${index + 1}`, sourceUrl: url }]
          : []
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
      const image = raw as TavilyImageResult
      const url = firstNonEmptyString(image.url, image.image_url, image.imageUrl)
      if (!url || !/^https?:\/\//i.test(url) || url.includes(this.tavilyApiKey)) return []
      const description = firstNonEmptyString(image.description, image.title, image.alt)
      const rawSourceUrl = firstNonEmptyString(
        image.source_url,
        image.sourceUrl,
        image.page_url,
        image.pageUrl,
        url,
      ) ?? url
      const sourceUrl = rawSourceUrl.includes(this.tavilyApiKey) ? url : rawSourceUrl
      return [{
        downloadUrl: url,
        thumbnailUrl: url,
        title: redactExactSecrets(
          description ? normalizeSearchSnippet(description) : `${query} image ${index + 1}`,
          [this.tavilyApiKey],
        ),
        sourceUrl,
      }]
    })
    const admitted = await this.admitImageSearchCandidates(candidates, count, signal)
    attempt.outcome = admitted.length > 0 ? 'success' : 'empty'
    return admitted
  }

  private async admitImageSearchCandidates(
    candidates: ImageSearchCandidate[],
    count: number,
    signal: AbortSignal,
  ): Promise<ImageSearchCandidate[]> {
    if (signal.aborted) throw signal.reason
    const inspected = await Promise.all(candidates.map(async (candidate) => {
      try {
        const admittedImage = new URL(await this.validateUrl(candidate.downloadUrl))
        admittedImage.hash = ''
        let admittedThumbnail = admittedImage
        try {
          admittedThumbnail = new URL(await this.validateUrl(candidate.thumbnailUrl))
          admittedThumbnail.hash = ''
        } catch {
          // The admitted full image is also a safe thumbnail fallback.
        }
        let admittedSource = admittedImage
        try {
          admittedSource = new URL(await this.validateUrl(candidate.sourceUrl))
          admittedSource.hash = ''
        } catch {
          // The downloaded public image remains a truthful fallback source.
        }
        return {
          ...candidate,
          downloadUrl: admittedImage.toString(),
          thumbnailUrl: admittedThumbnail.toString(),
          sourceUrl: admittedSource.toString(),
        }
      } catch {
        return undefined
      }
    }))
    if (signal.aborted) throw signal.reason
    const seen = new Set<string>()
    const admitted: ImageSearchCandidate[] = []
    for (const candidate of inspected) {
      if (!candidate || seen.has(candidate.downloadUrl)) continue
      seen.add(candidate.downloadUrl)
      admitted.push(candidate)
      if (admitted.length >= count) break
    }
    return admitted
  }

  private async presentFile(path: string, context: ToolContext): Promise<ToolExecutionResult> {
    const workspace = this.store.workspaceDir(context.sessionId)
    const target = resolveWorkspacePath(workspace, path)
    await assertNoSymlinkTraversal(workspace, target)
    const info = await stat(target)
    if (!info.isFile()) throw new Error('Path is not a file')
    const state = await this.store.get(context.sessionId)
    const artifact = state.artifacts.find((item) => item.path === path) ?? this.artifactForPath(context, path)
    if (!state.artifacts.some((item) => item.path === path)) {
      await this.store.recordArtifactCreated(context.sessionId, artifact, {
        turnId: context.turnId,
        stepId: context.stepId,
        callId: context.callId,
      })
    }
    await this.store.append(context.sessionId, 'file.presented', { path, artifact }, {
      turnId: context.turnId,
      stepId: context.stepId,
      callId: context.callId,
    })
    return { content: JSON.stringify({ status: 'success', path }), isError: false }
  }

  private async listConnectorTools(slug: string, context: ToolContext): Promise<ToolExecutionResult> {
    const normalized = slug.trim().toLowerCase()
    const definitions = this.connectorTools[normalized]
    if (!definitions) {
      return {
        content: JSON.stringify({ status: 'unsupported' }),
        isError: false,
      }
    }
    const availability = this.connectorAvailability[normalized]
    if (availability) {
      let connected: boolean
      try {
        connected = await availability()
      } catch {
        return {
          content: JSON.stringify({
            status: 'database_error',
            message: 'Could not check the connector connection. Try again.',
          }),
          isError: false,
        }
      }
      if (!connected) {
        return {
          content: JSON.stringify({ status: 'disconnected', connector: normalized }),
          isError: false,
        }
      }
    }
    if (context.enabledConnectorSlugs !== undefined && !context.enabledConnectorSlugs.includes(normalized)) {
      return {
        content: JSON.stringify({ status: 'disabled', connector: normalized }),
        isError: false,
      }
    }
    return {
      content: JSON.stringify({
        status: 'enabled',
        connector: normalized,
        tools: definitions.map((definition) => ({
          name: definition.function.name,
          description: definition.function.description,
        })),
      }),
      isError: false,
    }
  }

  private async enforceTurnScopedMediaLimit(call: ToolCallRecord, context: ToolContext): Promise<void> {
    const limit = call.name === 'generate_speech'
      ? ARENA_ACTIVE_TOOL_LIMITS.maxSpeechGenerationsPerTurn
      : call.name === 'generate_image' && call.arguments.offer_options === true
        ? ARENA_ACTIVE_TOOL_LIMITS.maxImageBattlesPerTurn
        : undefined
    if (limit === undefined) return
    const matchesLimitedCall = (candidate: ToolCallRecord): boolean => (
      call.name === 'generate_speech'
        ? candidate.name === 'generate_speech'
        : candidate.name === 'generate_image' && candidate.arguments.offer_options === true
    )
    let events = await this.store.events(context.sessionId)
    const sameTurnStarts = () => events.filter((event) => (
      event.type === 'tool.started'
      && event.turnId === context.turnId
    ))
    const currentStarts = sameTurnStarts().filter((event) => event.callId === call.id)
    if (currentStarts.length > 0) {
      const persisted = currentStarts[0].data.call
      if (
        !persisted
        || typeof persisted !== 'object'
        || Array.isArray(persisted)
        || (persisted as ToolCallRecord).name !== call.name
      ) {
        throw new Error(`Tool call id ${call.id} is already bound to a different durable call in this turn`)
      }
    } else {
      // AgentService normally publishes tool.started before entering the
      // executor. Direct/recovered executor callers receive the same durable
      // reservation here so limits survive executor and process recreation.
      await this.store.append(context.sessionId, 'tool.started', { call }, {
        turnId: context.turnId,
        stepId: context.stepId,
        callId: call.id,
      })
      events = await this.store.events(context.sessionId)
    }

    const admittedCallIds: string[] = []
    const seen = new Set<string>()
    for (const event of sameTurnStarts().sort((left, right) => left.seq - right.seq)) {
      const persisted = event.data.call
      if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) continue
      const candidate = persisted as ToolCallRecord
      if (!matchesLimitedCall(candidate)) continue
      const callId = event.callId || candidate.id
      if (!callId || seen.has(callId)) continue
      seen.add(callId)
      admittedCallIds.push(callId)
    }
    const ordinal = admittedCallIds.indexOf(call.id) + 1
    if (ordinal < 1) throw new Error(`Tool call ${call.id} has no durable per-turn media reservation`)
    if (ordinal > limit) {
      const label = call.name === 'generate_speech' ? 'speech generations' : 'offer_options image battles'
      throw new Error(`This turn allows at most ${limit} ${label}; call ${call.id} was not sent to a provider`)
    }
  }

  private async generateImage(
    args: Record<string, unknown>,
    context: ToolContext,
    model = this.imageModel,
  ): Promise<ToolExecutionResult> {
    if (!this.imageApiKey) throw new Error('generate_image requires ANERA_IMAGE_API_KEY or OPENAI_API_KEY to be configured')
    const filePath = requiredWorkspacePath(args, 'file_path')
    const prompt = requiredString(args, 'prompt')
    const extension = extname(filePath).toLowerCase()
    const expectedMime = extension === '.png' ? 'image/png' : ['.jpg', '.jpeg'].includes(extension) ? 'image/jpeg' : undefined
    if (!expectedMime) throw new Error('file_path must end in .png, .jpg, or .jpeg')
    if (args.offer_options === true) {
      return await this.generateImageOptions(args, context, filePath)
    }
    const sourcePaths = Array.isArray(args.images)
      ? args.images.map((value) => typeof value === 'string' ? arenaWorkspacePath(value) : '').filter(Boolean)
      : []
    if (sourcePaths.length > ARENA_ACTIVE_TOOL_LIMITS.generateImageInputs) {
      throw new Error(`generate_image accepts at most ${ARENA_ACTIVE_TOOL_LIMITS.generateImageInputs} source images`)
    }
    let modelUsage: ToolModelUsage | undefined
    let modelRequestCount = 0
    try {
      let response: Response
      if (sourcePaths.length > 0) {
        const form = new FormData()
        form.set('model', model)
        form.set('prompt', prompt)
        form.set('n', '1')
        form.set('size', 'auto')
        form.set('quality', 'auto')
        form.set('output_format', expectedMime === 'image/png' ? 'png' : 'jpeg')
        for (const path of sourcePaths) {
          const target = resolveWorkspacePath(this.store.workspaceDir(context.sessionId), path)
          await assertNoSymlinkTraversal(this.store.workspaceDir(context.sessionId), target)
          const bytes = await readFile(target)
          if (bytes.length > config.maxVisionImageBytes) throw new Error(`Source image ${path} exceeds the image byte limit`)
          const mime = sniffGeneratedImageMime(bytes)
          if (!mime) throw new Error(`Source image ${path} must be PNG or JPEG`)
          form.append('image[]', new Blob([Uint8Array.from(bytes)], { type: mime }), path.split('/').at(-1) || 'image')
        }
        modelRequestCount = 1
        response = await this.externalFetchImpl(`${this.imageBaseUrl}/images/edits`, {
          method: 'POST',
          signal: context.signal,
          headers: { authorization: `Bearer ${this.imageApiKey}`, accept: 'application/json' },
          body: form,
        })
      } else {
        modelRequestCount = 1
        response = await this.externalFetchImpl(`${this.imageBaseUrl}/images/generations`, {
          method: 'POST',
          signal: context.signal,
          headers: {
            authorization: `Bearer ${this.imageApiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            model,
            prompt,
            n: 1,
            size: 'auto',
            quality: 'auto',
            output_format: expectedMime === 'image/png' ? 'png' : 'jpeg',
          }),
        })
      }
      const maxJsonBytes = Math.ceil(config.maxVisionImageBytes * 1.5) + 200_000
      const bounded = await readBoundedResponseText(response, maxJsonBytes)
      if (bounded.truncated) throw new Error(`Image generation response exceeded the ${maxJsonBytes}-byte limit`)
      let payload: ImageGenerationResponse
      try {
        payload = JSON.parse(bounded.text) as ImageGenerationResponse
      } catch {
        throw new Error(`Image generation failed (${response.status}): invalid JSON response`)
      }
      modelUsage = imageGenerationUsage(payload.usage)
      if (!response.ok || payload.error?.message) {
        throw new Error(`Image generation failed (${response.status}): ${payload.error?.message || 'unknown error'}`)
      }
      if (context.signal.aborted) throw context.signal.reason
      const generated = payload.data?.[0]
      let image: Buffer
      if (generated?.b64_json) image = decodeGeneratedImage(generated.b64_json, config.maxVisionImageBytes)
      else if (generated?.url) image = await this.downloadGeneratedImage(generated.url, context.signal)
      else throw new Error('Image generation returned no image data')
      if (context.signal.aborted) throw context.signal.reason
      const actualMime = sniffGeneratedImageMime(image)
      if (!actualMime) throw new Error('Image generation returned unsupported or invalid image bytes')
      if (actualMime !== expectedMime) throw new Error(`Generated ${actualMime} bytes do not match ${extension} file_path`)
      await this.store.commitWorkspaceWrite(context.sessionId, {
        path: filePath,
        content: image,
        mode: 'upsert',
        operation: 'generated-image',
        artifact: this.artifactForPath(context, filePath),
        context: { turnId: context.turnId, stepId: context.stepId, callId: context.callId },
      })
      return {
        content: JSON.stringify({ status: 'success', hash: arenaContentHash(image), file_path: filePath }),
        isError: false,
        ...(modelUsage ? { modelUsage } : {}),
        modelRequestCount,
        modelCallCount: modelUsage ? 1 : 0,
      }
    } catch (error) {
      if (modelRequestCount === 0) throw error
      throw withToolModelAccounting(error, modelUsage, modelUsage ? 1 : 0, modelRequestCount)
    }
  }

  private async generateImageOptions(
    args: Record<string, unknown>,
    context: ToolContext,
    filePath: string,
  ): Promise<ToolExecutionResult> {
    if (!this.requestHumanInput) throw new Error('Image selection is unavailable')
    if (this.imageBattleModels.length < ARENA_ACTIVE_TOOL_LIMITS.defaultImageBattleCandidates) {
      throw new Error(
        'offer_options requires two distinct image model routes; configure ANERA_IMAGE_BATTLE_MODELS with an additional model',
      )
    }
    const battleModels = this.imageBattleModels.slice(0, ARENA_ACTIVE_TOOL_LIMITS.defaultImageBattleCandidates)
    const leaf = filePath.split('/').at(-1) || `image${extname(filePath)}`
    const extension = extname(leaf)
    const stem = leaf.slice(0, Math.max(0, leaf.length - extension.length)) || 'image'
    const candidatePaths = [0, 1].map((index) => (
      `Unselected files/${stem}-${context.callId?.slice(-6) || 'option'}-${index + 1}${extension}`
    ))
    const generated = await Promise.all(candidatePaths.map(async (candidatePath, candidateIndex) => {
      let result: ToolExecutionResult
      try {
        result = await this.generateImage(
          { ...args, offer_options: false, file_path: candidatePath },
          context,
          battleModels[candidateIndex],
        )
      } catch (error) {
        const usage = toolModelUsageFromError(error)
        const modelRequestCount = toolModelRequestCountFromError(error)
        const modelCallCount = toolModelCallCountFromError(error)
        result = {
          content: JSON.stringify({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          }),
          isError: true,
          ...(usage ? { modelUsage: usage } : {}),
          ...(modelRequestCount !== undefined ? { modelRequestCount } : {}),
          ...(modelCallCount !== undefined ? { modelCallCount } : {}),
        }
      }
      let payload: Record<string, unknown> = {}
      try { payload = JSON.parse(result.content) as Record<string, unknown> } catch { /* handled as a failed candidate */ }
      return { result, payload, path: candidatePath }
    }))
    const modelUsage = generated.reduce<ToolModelUsage | undefined>((total, candidate) => {
      const usage = candidate.result.modelUsage
      if (!usage) return total
      return {
        promptTokens: (total?.promptTokens ?? 0) + usage.promptTokens,
        completionTokens: (total?.completionTokens ?? 0) + usage.completionTokens,
        totalTokens: (total?.totalTokens ?? 0) + usage.totalTokens,
        cachedPromptTokens: (total?.cachedPromptTokens ?? 0) + usage.cachedPromptTokens,
      }
    }, undefined)
    const modelRequestCount = generated.reduce((total, candidate) => (
      total + (candidate.result.modelRequestCount ?? 0)
    ), 0)
    const modelCallCount = generated.reduce((total, candidate) => (
      total + (candidate.result.modelCallCount ?? (candidate.result.modelUsage ? 1 : 0))
    ), 0)
    const survivors = generated.filter((candidate) => (
      !candidate.result.isError && candidate.payload.status === 'success' && typeof candidate.payload.hash === 'string'
    ))
    if (survivors.length === 0) {
      return {
        content: JSON.stringify({
          status: 'error',
          message: 'Image generation failed for every model in the battle. Try again or rephrase the prompt.',
        }),
        isError: true,
        ...(modelUsage ? { modelUsage } : {}),
        modelRequestCount,
        modelCallCount,
      }
    }
    const copyCandidateToFinal = async (candidate: typeof survivors[number]) => {
      const source = resolveWorkspacePath(this.store.workspaceDir(context.sessionId), candidate.path)
      await assertNoSymlinkTraversal(this.store.workspaceDir(context.sessionId), source)
      const image = await readFile(source)
      await this.store.commitWorkspaceWrite(context.sessionId, {
        path: filePath,
        content: image,
        mode: 'upsert',
        operation: 'generated-image-selected',
        artifact: this.artifactForPath(context, filePath),
        context: { turnId: context.turnId, stepId: context.stepId, callId: context.callId },
      })
      await this.store.commitWorkspaceDelete(context.sessionId, {
        path: candidate.path,
        operation: 'generated-image-candidate-selected',
        context: { turnId: context.turnId, stepId: context.stepId, callId: context.callId },
      })
      return image
    }
    if (survivors.length === 1) {
      const image = await copyCandidateToFinal(survivors[0])
      return {
        content: JSON.stringify({ status: 'success', hash: arenaContentHash(image), file_path: filePath }),
        isError: false,
        ...(modelUsage ? { modelUsage } : {}),
        modelRequestCount,
        modelCallCount,
      }
    }

    const candidates = survivors.map((candidate, index) => ({
      id: `${context.callId || 'image'}-${index}`,
      index,
      hash: String(candidate.payload.hash),
      path: candidate.path,
    }))
    const response = await this.requestHumanInput(context, {
      kind: 'generate_image',
      call: {
        id: context.callId || 'generate_image',
        name: 'generate_image',
        arguments: args,
      },
      title: 'Choose an image',
      payload: { file_path: filePath, prompt: args.prompt, candidates },
    })
    const selectedIndex = typeof response.selected_index === 'number' ? response.selected_index : 0
    const skipped = response.skipped === true
    if (!skipped) {
      const selected = survivors[selectedIndex]
      if (!selected) throw new Error('Selected image candidate is unavailable')
      await copyCandidateToFinal(selected)
    }
    return {
      content: JSON.stringify({
        status: 'completed',
        candidates: candidates.map(({ index, hash }) => ({ index, hash })),
        selected_index: selectedIndex,
        file_path: filePath,
        selection_method: skipped ? 'skip' : 'user',
      }),
      isError: false,
      ...(modelUsage ? { modelUsage } : {}),
      modelRequestCount,
      modelCallCount,
    }
  }

  private async generateSpeech(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    if (!this.imageApiKey) throw new Error('generate_speech requires ANERA_IMAGE_API_KEY or OPENAI_API_KEY to be configured')
    const text = requiredString(args, 'text')
    const voiceId = requiredString(args, 'voice_id')
    const filePath = requiredWorkspacePath(args, 'file_path')
    const plan = speechFormatPlan(filePath)
    const state = await this.store.get(context.sessionId)
    const selectedVoice = state.voices?.[voiceId]
      ?? this.selectedVoices.get(`${context.sessionId}:${voiceId}`)
    if (!selectedVoice) throw new Error('voice_id is not registered in this session; call add_voice first')
    const auditionLanguage = normalizeBcp47Language(selectedVoice.language, 'stored audition language')
    const requestedLanguage = typeof args.language === 'string'
      ? normalizeBcp47Language(args.language)
      : auditionLanguage
    if (!voiceLanguageIsCompatible(auditionLanguage, requestedLanguage)) {
      throw new Error(
        `Voice ${voiceId} was auditioned for ${auditionLanguage} and cannot be proven compatible with ${requestedLanguage}; `
        + `register a voice auditioned for ${requestedLanguage}`,
      )
    }
    const generated = await this.synthesizeNormalizedSpeech(text, selectedVoice.providerVoice, plan, context.signal)
    const audio = generated.audio
    if (context.signal.aborted) throw context.signal.reason
    await this.store.commitWorkspaceWrite(context.sessionId, {
      path: filePath,
      content: audio,
      mode: 'upsert',
      operation: 'generated-speech',
      artifact: this.artifactForPath(context, filePath),
      context: { turnId: context.turnId, stepId: context.stepId, callId: context.callId },
    })
    await this.store.append(context.sessionId, 'audio.generated', {
      path: filePath,
      bytes: audio.byteLength,
      voiceId,
      language: requestedLanguage,
      auditionLanguage,
    }, {
      turnId: context.turnId,
      stepId: context.stepId,
      callId: context.callId,
    })
    return {
      content: JSON.stringify({ status: 'success', hash: arenaContentHash(audio), file_path: filePath }),
      isError: false,
      speechUsage: generated.speechUsage,
      modelUsage: speechMeteringAsModelUsage(generated.speechUsage),
      modelRequestCount: generated.speechUsage.providerCalls,
      modelCallCount: generated.speechUsage.providerCalls,
    }
  }

  private async synthesizeNormalizedSpeech(
    text: string,
    providerVoice: string,
    plan: SpeechFormatPlan,
    signal: AbortSignal,
  ): Promise<{ audio: Buffer; speechUsage: SpeechProviderMetering }> {
    let providerAudio: Buffer
    try {
      providerAudio = await this.synthesizeSpeech(text, providerVoice, plan.providerFormat, signal)
    } catch (error) {
      throw withToolSpeechUsage(error, speechProviderMetering(text, 0, 0, 0))
    }
    const baseUsage = speechProviderMetering(text, providerAudio.byteLength, 0, 0)
    try {
      const normalized = await normalizeSpeechAudio(providerAudio, plan, signal, config.maxGeneratedAudioBytes)
      return {
        audio: normalized.audio,
        speechUsage: speechProviderMetering(
          text,
          providerAudio.byteLength,
          normalized.audio.byteLength,
          normalized.durationMs,
        ),
      }
    } catch (error) {
      throw withToolSpeechUsage(error, baseUsage)
    }
  }

  private async synthesizeSpeech(
    text: string,
    providerVoice: string,
    responseFormat: string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const response = await this.externalFetchImpl(`${this.imageBaseUrl}/audio/speech`, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${this.imageApiKey}`,
        'content-type': 'application/json',
        accept: 'audio/*,application/json;q=0.5',
      },
      body: JSON.stringify({
        model: config.speechModel,
        voice: providerVoice,
        input: text,
        response_format: responseFormat,
      }),
    })
    if (!response.ok) {
      const error = await readBoundedResponseText(response, 64_000)
      throw new Error(`Speech generation failed (${response.status}): ${truncateText(error.text, 2_000)}`)
    }
    return await readBoundedResponseBytes(response, config.maxGeneratedAudioBytes)
  }

  private async downloadGeneratedImage(rawUrl: string, signal: AbortSignal): Promise<Buffer> {
    let url = await this.validateUrl(rawUrl)
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const response = await this.externalFetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { accept: 'image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1' },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) throw new Error('Generated image redirect omitted Location')
        url = await this.validateUrl(new URL(location, url).toString())
        continue
      }
      if (!response.ok) throw new Error(`Generated image download failed with HTTP ${response.status}`)
      return await readBoundedResponseBytes(response, config.maxVisionImageBytes)
    }
    throw new Error('Generated image download exceeded five safe redirects')
  }

  private async httpRequest(call: ToolCallRecord, context: ToolContext): Promise<ToolExecutionResult> {
    const url = await this.validateUrl(requiredString(call.arguments, 'url'))
    const method = requiredString(call.arguments, 'method').toUpperCase()
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('http_request only supports state-changing methods')
    const approved = await this.requestApproval(context, call)
    if (!approved) return { content: 'User denied the external HTTP request. The request was not sent.', isError: true }
    const hasBody = call.arguments.json_body !== undefined
    const controller = new AbortController()
    let timedOut = false
    const relayAbort = () => controller.abort(context.signal.reason || new DOMException('Run aborted', 'AbortError'))
    if (context.signal.aborted) relayAbort()
    else context.signal.addEventListener('abort', relayAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('HTTP request timed out', 'TimeoutError'))
    }, this.toolTimeoutMs)
    timer.unref()
    try {
      const response = await this.externalFetchImpl(url, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: hasBody
          ? { 'content-type': 'application/json', accept: 'application/json,text/plain;q=0.8,*/*;q=0.5' }
          : { accept: 'application/json,text/plain;q=0.8,*/*;q=0.5' },
        body: hasBody ? JSON.stringify(call.arguments.json_body) : undefined,
      })
      await response.body?.cancel().catch(() => {})
      return {
        content: JSON.stringify({ status: response.status, url: response.url || url.toString(), redirected: false, bodyDiscarded: true }, null, 2),
        isError: !response.ok,
      }
    } catch (error) {
      if (timedOut) {
        return {
          content: `HTTP request exceeded the harness tool limit of ${this.toolTimeoutMs}ms.`,
          isError: true,
          timedOut: true,
        }
      }
      throw error
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', relayAbort)
    }
  }

  private async preview(context: ToolContext, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const workspace = this.store.workspaceDir(context.sessionId)
    if (typeof args.process_id === 'string') {
      // Revalidate socket ownership at the publication boundary. A formerly
      // verified port may have closed and been rebound by another managed
      // session or a host process since the last process-output check.
      const process = await this.processes.refreshPorts(context.sessionId, args.process_id)
        ?? this.processes.get(context.sessionId, args.process_id)
      if (!process) throw new Error('Managed Website process not found')
      if (process.status !== 'running') throw new Error(`Managed Website process is ${process.status}`)
      if (!process.port || !process.listeningPorts?.some((listener) => listener.port === process.port)) {
        throw new Error('Managed Website process does not own a verified listening port yet')
      }
      const website = {
        status: 'running' as const,
        processId: process.id,
        port: process.port,
        previewUrl: `http://127.0.0.1:${process.port}`,
        updatedAt: new Date().toISOString(),
        restartCount: (await this.store.get(context.sessionId)).website.restartCount,
      }
      await this.store.recordWebsiteUpdate(context.sessionId, website, {}, {
        turnId: context.turnId,
        stepId: context.stepId,
        callId: context.callId,
      })
      return { content: `Dev-server Website preview is running at ${website.previewUrl}`, isError: false }
    }
    const requested = typeof args.path === 'string' ? args.path : undefined
    const entryPath = requested || await findWebsiteEntry(workspace, { signal: context.signal })
    if (!entryPath) throw new Error('No HTML entry file found')
    const target = resolveWorkspacePath(workspace, entryPath)
    await assertNoSymlinkTraversal(workspace, target)
    await readFile(target)
    const previewUrl = `/workspace/${context.sessionId}/preview/${encodeWorkspaceUrlPath(entryPath)}`
    const website = {
      status: 'running' as const,
      entryPath,
      processId: undefined,
      port: undefined,
      previewUrl,
      updatedAt: new Date().toISOString(),
      restartCount: (await this.store.get(context.sessionId)).website.restartCount,
    }
    await this.store.recordWebsiteUpdate(context.sessionId, website, {}, {
      turnId: context.turnId,
      stepId: context.stepId,
      callId: context.callId,
    })
    return { content: `Website preview is running at ${previewUrl}`, isError: false }
  }

  private async browserAction(context: ToolContext, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const action = requiredString(args, 'action')
    if (action === 'open') {
      const hasWidth = typeof args.width === 'number'
      const hasHeight = typeof args.height === 'number'
      if (hasWidth !== hasHeight) throw new Error('browser open requires both width and height when setting a viewport')
      const state = await this.store.get(context.sessionId)
      const path = typeof args.path === 'string' ? args.path : undefined
      let url = state.website.previewUrl
      if (path) {
        const workspace = this.store.workspaceDir(context.sessionId)
        let browserPath = arenaWorkspacePath(path)
        const target = resolveWorkspacePath(workspace, browserPath)
        await assertNoSymlinkTraversal(workspace, target)
        let requestedFileExists = false
        try {
          requestedFileExists = (await stat(target)).isFile()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const publishedEntry = state.website.entryPath ? arenaWorkspacePath(state.website.entryPath) : undefined
        if (!requestedFileExists && publishedEntry && basename(publishedEntry) === basename(browserPath)) {
          const entryTarget = resolveWorkspacePath(workspace, publishedEntry)
          await assertNoSymlinkTraversal(workspace, entryTarget)
          if ((await stat(entryTarget)).isFile()) browserPath = publishedEntry
        }
        const appBaseUrl = this.localAppBaseUrl().replace(/\/+$/, '')
        if (!appBaseUrl) throw new Error('The local App preview origin is unavailable')
        url = `${appBaseUrl}/workspace/${context.sessionId}/preview/${encodeWorkspaceUrlPath(browserPath)}`
      }
      if (!url) throw new Error('Publish a Website or provide an HTML path before opening the browser')
      if (url.startsWith('/')) url = `http://127.0.0.1:${config.port}${url}`
      const opened = await this.browser.open(context.sessionId, url, context.signal)
      const result = hasWidth && hasHeight
        ? await this.browser.setViewport(context.sessionId, args.width as number, args.height as number, context.signal)
        : opened
      return { content: JSON.stringify(result, null, 2), isError: false }
    }
    if (action === 'snapshot') return { content: JSON.stringify(await this.browser.snapshot(context.sessionId, context.signal), null, 2), isError: false }
    if (action === 'click') {
      const ref = typeof args.ref === 'string' ? args.ref : undefined
      const text = typeof args.text === 'string' ? args.text : undefined
      if (!ref && !text) throw new Error('click requires ref or text')
      return { content: JSON.stringify(await this.browser.click(context.sessionId, { ref, text }, context.signal), null, 2), isError: false }
    }
    if (action === 'fill') return { content: JSON.stringify(await this.browser.fill(context.sessionId, requiredString(args, 'ref'), typeof args.value === 'string' ? args.value : '', context.signal), null, 2), isError: false }
    if (action === 'select') return { content: JSON.stringify(await this.browser.select(context.sessionId, requiredString(args, 'ref'), requiredString(args, 'value'), context.signal), null, 2), isError: false }
    if (action === 'check') {
      if (typeof args.checked !== 'boolean') throw new Error('check requires checked=true or false')
      return { content: JSON.stringify(await this.browser.check(context.sessionId, requiredString(args, 'ref'), args.checked, context.signal), null, 2), isError: false }
    }
    if (action === 'press') return { content: JSON.stringify(await this.browser.press(context.sessionId, requiredString(args, 'key'), typeof args.ref === 'string' ? args.ref : undefined, context.signal), null, 2), isError: false }
    if (action === 'scroll') {
      if (typeof args.delta_y !== 'number') throw new Error('scroll requires delta_y')
      return { content: JSON.stringify(await this.browser.scroll(context.sessionId, args.delta_y, context.signal), null, 2), isError: false }
    }
    if (action === 'viewport') {
      if (typeof args.width !== 'number' || typeof args.height !== 'number') throw new Error('width and height are required for viewport')
      return { content: JSON.stringify(await this.browser.setViewport(context.sessionId, args.width, args.height, context.signal), null, 2), isError: false }
    }
    if (action === 'console') return { content: JSON.stringify(this.browser.logs(context.sessionId), null, 2), isError: false }
    if (action === 'screenshot') {
      const path = typeof args.screenshot_path === 'string'
        ? args.screenshot_path
        : typeof args.path === 'string'
          ? args.path
          : 'browser-screenshot.png'
      if (!path.toLowerCase().endsWith('.png')) throw new Error('screenshot_path must end in .png')
      const workspace = this.store.workspaceDir(context.sessionId)
      const target = resolveWorkspacePath(workspace, path)
      await assertNoSymlinkTraversal(workspace, target)
      const image = await this.browser.screenshot(context.sessionId, context.signal)
      if (context.signal.aborted) throw context.signal.reason
      const bytes = await this.store.commitWorkspaceWrite(context.sessionId, {
        path,
        content: image,
        mode: 'upsert',
        operation: 'browser-screenshot',
        artifact: this.artifactForPath(context, path),
        context: { turnId: context.turnId, stepId: context.stepId, callId: context.callId },
      })
      return { content: `Saved browser screenshot to ${path} (${bytes} bytes).`, isError: false }
    }
    throw new Error(`Unknown browser action: ${action}`)
  }
}

function toolModelUsageFromError(error: unknown): ToolModelUsage | undefined {
  const usage = (error as { modelUsage?: Partial<ToolModelUsage> } | null)?.modelUsage
  if (!usage) return undefined
  if (![usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.cachedPromptTokens]
    .every((value) => typeof value === 'number' && Number.isInteger(value) && value >= 0)) return undefined
  return usage as ToolModelUsage
}

function toolModelCallCountFromError(error: unknown): number | undefined {
  const count = (error as { modelCallCount?: unknown } | null)?.modelCallCount
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : undefined
}

function toolModelRequestCountFromError(error: unknown): number | undefined {
  const count = (error as { modelRequestCount?: unknown } | null)?.modelRequestCount
  return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : undefined
}

function toolEstimatedCostUsdFromError(error: unknown): number | undefined {
  const cost = (error as { estimatedCostUsd?: unknown } | null)?.estimatedCostUsd
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined
}

function withToolModelUsage(error: unknown, usage: ToolModelUsage | undefined): unknown {
  if (!usage) return error
  const target = error instanceof Error ? error : new Error(String(error))
  try {
    return Object.assign(target, { modelUsage: usage })
  } catch {
    return Object.assign(new Error(target.message, { cause: target }), { modelUsage: usage })
  }
}

function withToolModelAccounting(
  error: unknown,
  usage: ToolModelUsage | undefined,
  modelCallCount: number,
  modelRequestCount: number,
): unknown {
  const target = withToolModelUsage(error, usage)
  const accounting = { modelCallCount, modelRequestCount }
  try {
    return Object.assign(target instanceof Error ? target : new Error(String(target)), accounting)
  } catch {
    const message = target instanceof Error ? target.message : String(target)
    return Object.assign(new Error(message, { cause: target }), accounting)
  }
}

function toolSpeechUsageFromError(error: unknown): SpeechProviderMetering | undefined {
  const usage = (error as { speechUsage?: Partial<SpeechProviderMetering> } | null)?.speechUsage
  if (!usage) return undefined
  const integerFields = [
    usage.providerCalls,
    usage.inputCharacters,
    usage.providerOutputBytes,
    usage.deliveredAudioBytes,
    usage.audioDurationMs,
    usage.estimatedTextTokens,
    usage.estimatedAudioTokens,
  ]
  if (!integerFields.every((value) => typeof value === 'number' && Number.isInteger(value) && value >= 0)) return undefined
  if (usage.estimationMethod !== 'text_heuristic_and_50ms_audio_tokens') return undefined
  return usage as SpeechProviderMetering
}

function withToolSpeechUsage(error: unknown, usage: SpeechProviderMetering | undefined): unknown {
  if (!usage) return error
  const target = error instanceof Error ? error : new Error(String(error))
  try {
    return Object.assign(target, {
      speechUsage: usage,
      modelUsage: speechMeteringAsModelUsage(usage),
      modelRequestCount: usage.providerCalls,
      modelCallCount: usage.providerCalls,
    })
  } catch {
    return Object.assign(new Error(target.message, { cause: target }), {
      speechUsage: usage,
      modelUsage: speechMeteringAsModelUsage(usage),
      modelRequestCount: usage.providerCalls,
      modelCallCount: usage.providerCalls,
    })
  }
}

function beginWebProviderRequest(
  requests: WebProviderRequestMetering[],
  provider: WebProviderName,
  operation: WebProviderRequestMetering['operation'],
  calls = 1,
): WebProviderRequestMetering {
  const attempt: WebProviderRequestMetering = {
    provider,
    operation,
    calls,
    responseBytes: 0,
    outcome: 'error',
  }
  requests.push(attempt)
  return attempt
}

function webProviderMetering(
  cache: WebProviderMetering['cache'],
  requests: readonly WebProviderRequestMetering[],
  cacheProvider?: WebProviderMetering['cacheProvider'],
): WebProviderMetering {
  const copied = requests.map((request) => ({ ...request }))
  return {
    schemaVersion: 1,
    cache,
    ...(cacheProvider ? { cacheProvider } : {}),
    providerCalls: copied.reduce((total, request) => total + request.calls, 0),
    responseBytes: copied.reduce((total, request) => total + request.responseBytes, 0),
    requests: copied,
    costUsd: null,
    costStatus: 'not_available',
  }
}

function withWebProviderUsage(result: ToolExecutionResult, usage: WebProviderMetering): ToolExecutionResult {
  return { ...result, webProviderUsage: usage }
}

function withToolWebProviderUsage(error: unknown, usage: WebProviderMetering): unknown {
  const target = error instanceof Error ? error : new Error(String(error))
  try {
    return Object.assign(target, { webProviderUsage: usage })
  } catch {
    return Object.assign(new Error(target.message, { cause: target }), { webProviderUsage: usage })
  }
}

function toolWebProviderUsageFromError(error: unknown): WebProviderMetering | undefined {
  const usage = (error as { webProviderUsage?: WebProviderMetering } | null)?.webProviderUsage
  if (!usage || usage.schemaVersion !== 1 || !Array.isArray(usage.requests)) return undefined
  return usage
}

export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive number')
  if (!response.body) return { text: '', bytesRead: 0, truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytesRead = 0
  let truncated = false
  try {
    while (bytesRead < maxBytes) {
      const next = await reader.read()
      if (next.done) {
        text += decoder.decode()
        return { text, bytesRead, truncated }
      }
      const remaining = maxBytes - bytesRead
      const chunk = next.value.length <= remaining ? next.value : next.value.subarray(0, remaining)
      bytesRead += chunk.length
      text += decoder.decode(chunk, { stream: next.value.length <= remaining })
      if (next.value.length > remaining) {
        truncated = true
        break
      }
    }
    if (!truncated) {
      const probe = await reader.read()
      truncated = !probe.done
      if (probe.done) text += decoder.decode()
    }
    return { text, bytesRead, truncated }
  } finally {
    if (truncated) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

interface BoundedResponseBuffer {
  bytes: Buffer
  bytesRead: number
  truncated: boolean
}

async function readBoundedResponseBuffer(response: Response, maxBytes: number): Promise<BoundedResponseBuffer> {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive number')
  if (!response.body) return { bytes: Buffer.alloc(0), bytesRead: 0, truncated: false }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytesRead = 0
  let truncated = false
  let complete = false
  try {
    while (bytesRead < maxBytes) {
      const next = await reader.read()
      if (next.done) {
        complete = true
        return { bytes: Buffer.concat(chunks, bytesRead), bytesRead, truncated }
      }
      const remaining = maxBytes - bytesRead
      const chunk = next.value.length <= remaining ? next.value : next.value.subarray(0, remaining)
      chunks.push(Buffer.from(chunk))
      bytesRead += chunk.length
      if (next.value.length > remaining) {
        truncated = true
        break
      }
    }
    if (!truncated) {
      const probe = await reader.read()
      truncated = !probe.done
      complete = probe.done
    }
    return { bytes: Buffer.concat(chunks, bytesRead), bytesRead, truncated }
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive number')
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  let complete = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        complete = true
        return Buffer.concat(chunks, bytes)
      }
      if (bytes + next.value.length > maxBytes) throw new Error(`Response body exceeds the ${maxBytes}-byte limit`)
      chunks.push(Buffer.from(next.value))
      bytes += next.value.length
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

const FETCH_PAGE_PDF_MAX_PAGES = 30
const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii')

function isPdfContentType(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/pdf' || mediaType === 'application/x-pdf'
}

function hasPdfMagic(bytes: Buffer): boolean {
  // ISO 32000 readers conventionally accept a PDF header within the first
  // 1,024 bytes, which also covers servers that prepend a short transport
  // banner while still requiring a real file signature before parsing.
  return bytes.subarray(0, Math.min(bytes.length, 1_024)).indexOf(PDF_SIGNATURE) >= 0
}

async function extractFetchPagePdf(bytes: Buffer, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true })
  try {
    const document = await loadingTask.promise
    const parsedPages = Math.min(document.numPages, FETCH_PAGE_PDF_MAX_PAGES)
    const sections: string[] = []
    for (let pageNumber = 1; pageNumber <= parsedPages; pageNumber += 1) {
      signal.throwIfAborted()
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const text = content.items
          .map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')
          .join('')
          .replace(/[ \t]+\n/g, '\n')
          .trim()
        sections.push(`--- PDF page ${pageNumber} of ${document.numPages} ---\n${text || '[No extractable text on this page]'}`)
      } finally {
        page.cleanup()
      }
    }
    if (document.numPages > FETCH_PAGE_PDF_MAX_PAGES) {
      sections.push(
        `[PDF page limit reached: parsed pages 1-${FETCH_PAGE_PDF_MAX_PAGES} of ${document.numPages}. `
        + `Pages ${FETCH_PAGE_PDF_MAX_PAGES + 1}-${document.numPages} are not available from fetch_page; `
        + 'chunk continuation ends after the extracted text above.]',
      )
    }
    return sections.join('\n\n')
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw new Error(`Could not parse PDF response: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally {
    await loadingTask.destroy()
  }
}

function splitUtf8Chunks(value: string, maxBytes: number): string[] {
  const bytes = Buffer.from(value)
  if (bytes.length === 0) return ['']
  const chunks: string[] = []
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + maxBytes)
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
    if (end === start) end = Math.min(bytes.length, start + maxBytes)
    chunks.push(bytes.subarray(start, end).toString('utf8'))
    start = end
  }
  return chunks
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveDelay()
    }, Math.max(0, milliseconds))
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isKnownBinaryExtension(extension: string): boolean {
  return ARENA_BINARY_EXTENSION_SET.has(extension)
}

function isPlanItemStatus(value: string): value is PlanItemStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

interface ProjectConfiguration {
  scripts: Record<string, string>
}

async function readProjectConfiguration(workspace: string): Promise<ProjectConfiguration> {
  const path = resolveWorkspacePath(workspace, 'package.json')
  await assertNoSymlinkTraversal(workspace, path)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scripts: {} }
    throw error
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error('package.json is not valid JSON')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('package.json must contain a JSON object')
  const rawScripts = (manifest as Record<string, unknown>).scripts
  if (rawScripts === undefined) return { scripts: {} }
  if (!rawScripts || typeof rawScripts !== 'object' || Array.isArray(rawScripts)) throw new Error('package.json scripts must be an object')
  const scripts = Object.fromEntries(Object.entries(rawScripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  return { scripts }
}

function assertSafeNpmPackageSpec(value: string): void {
  const spec = value.trim()
  if (spec !== value || spec.length === 0 || spec.length > 300) throw new Error(`Invalid npm package spec: ${JSON.stringify(value)}`)
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9*~^<>=|+._-]+)?$/i.test(spec)) {
    throw new Error(`Only npm registry package specs are allowed: ${JSON.stringify(value)}`)
  }
}

interface NpmPackageVerification {
  installed: string[]
  issues: string[]
}

export async function verifyInstalledNpmPackages(workspace: string, specs: readonly string[]): Promise<NpmPackageVerification> {
  const installed: string[] = []
  const issues: string[] = []
  for (const spec of specs) {
    const name = npmPackageName(spec)
    const manifestPath = resolve(workspace, 'node_modules', ...name.split('/'), 'package.json')
    try {
      await assertNoSymlinkTraversal(workspace, manifestPath)
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
      if (manifest.name !== name) {
        issues.push(`${name} manifest reports a different package name`)
        continue
      }
      if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
        issues.push(`${name} manifest has no usable version`)
        continue
      }
      installed.push(`${name}@${manifest.version}`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      issues.push(code === 'ENOENT'
        ? `${name} package manifest is missing`
        : `${name} package manifest could not be verified`)
    }
  }
  return { installed, issues }
}

function npmPackageName(spec: string): string {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    const versionAt = spec.indexOf('@', slash + 1)
    return versionAt < 0 ? spec : spec.slice(0, versionAt)
  }
  const versionAt = spec.indexOf('@')
  return versionAt < 0 ? spec : spec.slice(0, versionAt)
}

function isRetryableNpmInstallFailure(stderr: string): boolean {
  return /TAR_ENTRY_ERROR|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network timeout|ENOTEMPTY|Tracker ["']idealTree["']/i.test(stderr)
}

function knownPythonOfficePackageHint(spec: string): string | undefined {
  const normalized = spec.trim().toLowerCase().replace(/@[^@/]+$/, '')
  if (normalized === 'openpyxl' || normalized === 'xlsxwriter') return 'an npm XLSX library such as exceljs@4.4.0'
  if (normalized === 'python-docx') return 'an npm DOCX library such as docx@9.5.1'
  if (normalized === 'python-pptx') return 'an npm presentation library such as pptxgenjs@4.0.1'
  return undefined
}

function assertNoShellPackageInstallation(command: string): void {
  const pythonInstaller = /(?:^|[\s;&|])(?:(?:python\d*(?:\.\d+)?\s+-m\s+)?pip\d*|uv\s+pip)\s+(?:install|download|wheel)\b/i
  const jsInstaller = /(?:^|[\s;&|])(?:npm\s+(?:i|install|add|update)|pnpm\s+(?:add|install|update)|yarn\s+(?:add|install|upgrade)|bun\s+(?:add|install|update))\b/i
  if (pythonInstaller.test(command)) {
    throw new Error('Bash cannot install Python packages or access package networks. This runtime has no pip install path; for Office artifacts use the supplied install_npm_packages tool with an npm library.')
  }
  if (jsInstaller.test(command)) {
    throw new Error('Bash cannot install registry packages. Use the supplied install_npm_packages tool so network access and lifecycle-script policy remain confined.')
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function truncateLogTail(value: string, max = 4_000): string {
  const normalized = value.trim()
  return normalized.length <= max ? normalized : normalized.slice(-max)
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

interface TavilySearchResult {
  title?: unknown
  url?: unknown
  content?: unknown
  snippet?: unknown
  published_date?: unknown
}

interface TavilyImageResult {
  url?: unknown
  image_url?: unknown
  imageUrl?: unknown
  description?: unknown
  title?: unknown
  alt?: unknown
  source_url?: unknown
  sourceUrl?: unknown
  page_url?: unknown
  pageUrl?: unknown
}

interface TavilySearchResponse {
  results?: TavilySearchResult[]
  images?: unknown[]
}

interface FirecrawlScrapeMetadata {
  title?: unknown
  sourceURL?: unknown
  url?: unknown
  statusCode?: unknown
}

interface FirecrawlScrapeResponse {
  success?: unknown
  data?: {
    markdown?: unknown
    html?: unknown
    metadata?: FirecrawlScrapeMetadata
  }
}

type FetchPageProvider = 'firecrawl' | 'direct'

interface FetchPageSnapshot {
  url: string
  title: string
  readable: string
  sourceTruncated: boolean
}

interface FetchPageCacheEntry {
  snapshot: FetchPageSnapshot
  bytes: number
}

type FetchPageLoad = { snapshot: FetchPageSnapshot } | { result: ToolExecutionResult }

function canonicalFetchPageUrl(url: URL): string {
  const canonical = new URL(url)
  canonical.hash = ''
  return canonical.toString()
}

function fetchPageSnapshotBytes(snapshot: FetchPageSnapshot): number {
  return Buffer.byteLength(snapshot.url) + Buffer.byteLength(snapshot.title) + Buffer.byteLength(snapshot.readable) + 1
}

function boundedNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function normalizeBcp47Language(value: string, label = 'language'): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} must be a valid BCP-47 language tag`)
  try {
    const [canonical] = Intl.getCanonicalLocales(trimmed)
    if (!canonical) throw new Error('empty canonical language')
    return canonical
  } catch {
    throw new Error(`${label} must be a valid BCP-47 language tag`)
  }
}

function voiceLanguageIsCompatible(auditionLanguage: string, requestedLanguage: string): boolean {
  if (auditionLanguage === requestedLanguage) return true
  const audition = new Intl.Locale(auditionLanguage)
  const requested = new Intl.Locale(requestedLanguage)
  // A bare language request carries no accent/script constraint, so a voice
  // auditioned in a specific locale of that language remains usable. Any
  // explicit region/script/variant request must match the audition exactly;
  // without a provider capability catalog we fail closed instead of guessing.
  return requestedLanguage === requested.language && audition.language === requested.language
}

function normalizeSearchSnippet(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= 4_000 ? normalized : `${normalized.slice(0, 3_997)}...`
}

function redactExactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value
  for (const secret of secrets) {
    if (secret.length >= 8) redacted = redacted.replaceAll(secret, '[REDACTED]')
  }
  return redacted
}

type MediaType = 'image' | 'video' | 'both'

interface PexelsMediaPage {
  total_results?: number
  photos?: PexelsPhoto[]
  videos?: PexelsVideo[]
}

interface ImageGenerationResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>
  error?: { message?: string }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
}

function imageGenerationUsage(usage: ImageGenerationResponse['usage']): ToolModelUsage | undefined {
  if (!usage) return undefined
  const promptTokens = nonNegativeInteger(usage.input_tokens)
  const completionTokens = nonNegativeInteger(usage.output_tokens)
  if (promptTokens === undefined || completionTokens === undefined) return undefined
  return {
    promptTokens,
    completionTokens,
    totalTokens: nonNegativeInteger(usage.total_tokens) ?? promptTokens + completionTokens,
    cachedPromptTokens: 0,
  }
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

interface PexelsPhoto {
  id?: number
  width?: number
  height?: number
  url?: string
  photographer?: string
  photographer_url?: string
  alt?: string
  src?: Record<string, string | undefined>
}

interface PexelsVideoFile {
  link?: string
  width?: number
  height?: number
  quality?: string
  file_type?: string
}

interface PexelsVideo {
  id?: number
  width?: number
  height?: number
  duration?: number
  url?: string
  image?: string
  user?: { name?: string; url?: string }
  video_files?: PexelsVideoFile[]
}

interface MediaResult {
  type: 'image' | 'video'
  id: number
  pexelsUrl: string
  recommendedUrl: string
  thumbnailUrl?: string
  width?: number
  height?: number
  creatorName?: string
  creatorUrl?: string
  alt?: string
  duration?: number
  videoFile?: {
    url: string
    width?: number
    height?: number
    quality?: string
    fileType?: string
  }
}

interface ImageSearchCandidate {
  downloadUrl: string
  thumbnailUrl: string
  title: string
  sourceUrl: string
}

function pexelsImageResult(photo: PexelsPhoto): MediaResult | undefined {
  if (typeof photo.id !== 'number' || typeof photo.url !== 'string') return undefined
  const recommendedUrl = photo.src?.large2x || photo.src?.large || photo.src?.original
  if (!recommendedUrl) return undefined
  return compactUndefined({
    type: 'image' as const,
    id: photo.id,
    pexelsUrl: photo.url,
    recommendedUrl,
    thumbnailUrl: photo.src?.medium || photo.src?.small || photo.src?.tiny,
    width: photo.width,
    height: photo.height,
    creatorName: photo.photographer,
    creatorUrl: photo.photographer_url,
    alt: photo.alt,
  })
}

function pexelsVideoResult(video: PexelsVideo): MediaResult | undefined {
  if (typeof video.id !== 'number' || typeof video.url !== 'string') return undefined
  const candidates = (video.video_files ?? []).filter((file) => typeof file.link === 'string')
  const selected = candidates
    .filter((file) => (file.width ?? 0) <= 1920 && (file.height ?? 0) <= 1080)
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0]
    ?? candidates.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0]
  if (!selected?.link) return undefined
  return compactUndefined({
    type: 'video' as const,
    id: video.id,
    pexelsUrl: video.url,
    recommendedUrl: selected.link,
    thumbnailUrl: video.image,
    width: video.width,
    height: video.height,
    creatorName: video.user?.name,
    creatorUrl: video.user?.url,
    duration: video.duration,
    videoFile: compactUndefined({
      url: selected.link,
      width: selected.width,
      height: selected.height,
      quality: selected.quality,
      fileType: selected.file_type,
    }),
  })
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function isMediaResult(value: MediaResult | undefined): value is MediaResult {
  return value !== undefined
}

function interleave<T>(left: T[], right: T[]): T[] {
  const values: T[] = []
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (index < left.length) values.push(left[index])
    if (index < right.length) values.push(right[index])
  }
  return values
}

function decodeGeneratedImage(value: string, maxBytes: number): Buffer {
  const normalized = value.replace(/\s+/g, '')
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('Image generation returned invalid base64 data')
  }
  if (normalized.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error(`Generated image exceeds the ${maxBytes}-byte limit`)
  const image = Buffer.from(normalized, 'base64')
  if (image.length === 0 || image.length > maxBytes) throw new Error(`Generated image exceeds the ${maxBytes}-byte limit`)
  if (image.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) throw new Error('Image generation returned invalid base64 data')
  return image
}

function sniffGeneratedImageMime(image: Buffer): 'image/png' | 'image/jpeg' | undefined {
  if (image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) return 'image/jpeg'
  return undefined
}

type SearchImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

function sniffSearchImageMime(image: Buffer): SearchImageMime | undefined {
  const generatedMime = sniffGeneratedImageMime(image)
  if (generatedMime) return generatedMime
  if (image.length >= 6 && /^GIF8[79]a$/.test(image.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (
    image.length >= 12
    && image.subarray(0, 4).toString('ascii') === 'RIFF'
    && image.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp'
  return undefined
}

function searchImageExtension(mime: SearchImageMime): '.png' | '.jpg' | '.webp' | '.gif' {
  if (mime === 'image/png') return '.png'
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/webp') return '.webp'
  return '.gif'
}

function extractHtmlTitle(html: string, fallbackUrl: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  const title = match ? stripHtml(match[1]) : ''
  if (title) return title
  try {
    return new URL(fallbackUrl).hostname
  } catch {
    return fallbackUrl
  }
}

function htmlReadableBody(html: string): string {
  return html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
}

function htmlToMarkdown(html: string): string {
  let markdown = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, body: string) => `\n\n\`\`\`\n${decodeHtmlText(body.replace(/<[^>]+>/g, ''))}\n\`\`\`\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, body: string) => `\`${decodeHtmlText(body.replace(/<[^>]+>/g, ''))}\``)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, body: string) => {
      const label = stripHtml(body) || href
      return `[${label}](${decodeHtmlText(href)})`
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, body: string) => `\n\n${'#'.repeat(Number(level))} ${stripHtml(body)}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, body: string) => `\n- ${stripHtml(body)}`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|main|aside|nav|ul|ol|table|tr)>/gi, '\n\n')
    .replace(/<(?:p|div|section|article|header|footer|main|aside|nav|ul|ol|table|tr)\b[^>]*>/gi, '\n\n')
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
  markdown = decodeHtmlText(markdown)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return markdown
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => safeCodePoint(Number.parseInt(decimal, 10)))
}

function safeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
}

function parseBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = []
  for (const block of html.split(/<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>/i).slice(1, 12)) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!link) continue
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    const url = stripHtml(link[1])
    if (!/^https?:\/\//i.test(url)) continue
    results.push({ title: stripHtml(link[2]), url, snippet: stripHtml(snippet?.[1] || '') })
  }
  return results
}

function parseDuckDuckGoResults(html: string, searchUrl: URL): SearchResult[] {
  const results: SearchResult[] = []
  const blocks = html.split('result__body').slice(1, 12)
  for (const block of blocks) {
    const link = block.match(/result__a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!link) continue
    const snippet = block.match(/result__snippet[^>]*>([\s\S]*?)<\/(?:a|div)>/i)
    const target = new URL(stripHtml(link[1]), searchUrl)
    const decoded = target.searchParams.get('uddg') || target.toString()
    results.push({ title: stripHtml(link[2]), url: decoded, snippet: stripHtml(snippet?.[1] || '') })
  }
  return results
}
