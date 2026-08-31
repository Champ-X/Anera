import { createHash } from 'node:crypto'
import {
  ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS,
  ARENA_WORKSPACE_IGNORED_DIR_NAMES,
  ARENA_WORKSPACE_IGNORED_FILE_PATH_SUFFIXES,
  type ToolDefinition,
} from '../server/tools.js'
import {
  ARENA_PUBLIC_COMMON_ERROR_RESULT_FIELDS,
  ARENA_PUBLIC_SUCCESS_RESULT_FIELDS,
  ARENA_PUBLIC_TOOL_ERROR_EXTENSION_FIELDS,
} from '../server/arena-tool-result.js'

export { ARENA_PUBLIC_TOOL_ERROR_EXTENSION_FIELDS }

export const ARENA_PUBLIC_TOOL_NAMES = [
  'create_file',
  'edit_file',
  'read_file',
  'list_files',
  'delete_file',
  'install_npm_packages',
  'build_project',
  'build_and_start',
  'deploy_project',
  'apply_patch',
  'bash',
  'shell_command',
  'update_plan',
  'grep_files',
  'glob_files',
  'web_search',
  'web_fetch',
  'fetch_media',
  'generate_image',
] as const

/**
 * Current completed-route Agent registry. Unlike ARENA_PUBLIC_TOOL_NAMES,
 * which is retained as the legacy/shared schema surface, these names come
 * from the output registry consumed by the live `/agent/[id]` route.
 */
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

/**
 * Frozen from the 2026-08-29 completed-route bundle. Schema and description
 * hashes are deliberately independent so the audit identifies which provider
 * surface drifted instead of reporting only one opaque function hash.
 */
export const ARENA_ACTIVE_AGENT_SCHEMA_SHA256: Record<(typeof ARENA_ACTIVE_AGENT_TOOL_NAMES)[number], string> = {
  add_voice: '81aff4bbbddd156673d90f2e41c5d4c89db3d79aba256892d96b53f675305841',
  ask_user: '317d6cbd8259906c8433e9ad8f5c5096a17aa52307828988d9703032730ced83',
  bash: '9c63d43667b9516b6c70e53192d3edf6fc1a6305bc952f5660cd9f116e19e04b',
  compact: 'ff1b2d8857c8e4a2cd87b566a798c5d1cd937fe8a13363e59a51231b4b328939',
  edit_file: '5096651501f29624d3f7be8b7465784f9ff39fe5daa9f81e7fa10938d0650e84',
  fetch_page: '7dc3ed4d69762fc99901d4f65e18b105170750f781e626eef6cf8dc26ecfdd3a',
  generate_image: '74aa06674c9cba460c41f7c9b34946137bb83d351d9470d6d1bdb8a65761df65',
  generate_speech: '584d6243f0f769444f8a039f0b155cf6cec511d6f74b9725ff8653f34a4704ad',
  get_process_output: '84513ae06fcd359a374738599842b83f98a602252b8a67a49f57f4e1deafa640',
  image_search: '67c056fff96195e8a19dae86b191a6d4bc6f43a97967383a61c6f0c6091e714a',
  list_connector_tools: '0f9fe61ceddc6239184e3e6aa4ff286871c3ed5b642a569c4e21fef0eeaaeab6',
  list_files: 'a3aa907e952139c7a9bf8f7cc1e24d8f1fd4a1917fa156a529e7b15fa404888b',
  present_file: 'ae197fc7fa60b69101cac36f4b15c2811c0e1061273c123f196c4820c6761cc7',
  propose_plan: '9d003d68de744b11c94712aeaebcd7142e4d294798bb0a1a65552f86fc8e771f',
  read_file: 'ab9baf0073279654fcf934568282fe4c7a6d789ace1cb6234ddf1834671351d3',
  start_process: '6d7da73e336d1ac0bcbbe0e4d23c9e62ff880b80cbfd52444dbe6b68abe10913',
  stop_process: '282d0ec9042093d9bceb8f112fdf554ff704718b31bb298ac1f98d9b1a2b5e6d',
  web_search: '279b201e5e77ca4cddbad52a5a15f19c8ddd888db1f8b50cd74d97161335a71e',
  write_file: 'c1aeb264b0b57687e2ad669c34814925a2e8b02dd988f4d32ea9380d47ae7d91',
}

export const ARENA_ACTIVE_AGENT_DESCRIPTION_SHA256: Record<(typeof ARENA_ACTIVE_AGENT_TOOL_NAMES)[number], string> = {
  add_voice: '2af58302a4ef020af2747f04c91c6ccf9b75606c7d39f77074a8aef85e9700b1',
  ask_user: '2f3c197575b5432f496470cd0f1964c1a006639b545b5b1504e2c5bc0c27d796',
  bash: 'c15b798e17379141666b65b20e6d91054b26cc0f514032223fe94b425b90a782',
  compact: '6813fdf0208bc36c89f05445a210cd829d8bf62853d80d2da017004f2ce0f763',
  edit_file: 'c5aa42ce3dea31731f823c78bb4632802811be741a528963e26c58e1932c0783',
  fetch_page: 'ac5ea5b3cb8e1ff2f46af1d9659f7867da6eabc4d5c8f8e287b4d36ee78a8fef',
  generate_image: 'ae417c85c2f8145c4b689b351a77c847b472dbd14fb50a6d3693d39e17ff6643',
  generate_speech: '1895528ec0bc27d14a5aadb08363120476692048c94133270b260345ce8d6edb',
  get_process_output: 'cd9ca74a923e13354623324ec34fe523731135a5e7802490451d17ddacfc59f2',
  image_search: '0c83139091ac15b4346035b2023cfe86f8b20a3b41fbf669ecbd530374633bf4',
  list_connector_tools: '2f22adf45de85fdbd77c200e93c23975729add2cd8cf349ea0d22c028c3a2bf3',
  list_files: '650a5178bcb4cf3147660c34b04688e7d3ad0d278ab4696b3edbd6d9ffe32caf',
  present_file: '2c2c3811e66b30efd9ba33397f86bb357d4f522ae39d633a4b850decdd162900',
  propose_plan: 'e5d4b272b332ef46d6ef424b80b01ba8aca44a4988d4effa0dac4e392b874294',
  read_file: '10300e0e55f71e514325e149d7b7950799ebec7b51630a8c804a455e456a59b2',
  start_process: '2cb2db715410ef05999af4b0017bde28c91e8a22c8c0f8c05006912185578219',
  stop_process: '89e9e5ec6478e59883c71c03a7330f9b5227a51f834a5c4e1f736f9882003f7d',
  web_search: '8d76c21a4bd4a3bcc6d1a5882a4dcca5c9114e9bbe6a8c6fe12665aa1ddf5efb',
  write_file: '5f6f25b4ada97b41c842ef62a3d225d9dc0363c9468125866067720bcabdd698',
}

/** Bounded literal evidence from the public Agent prompt template. */
export const ARENA_ACTIVE_AGENT_PROMPT_ANCHORS = {
  identity: 'helpful agentic assistant with tool access running on Arena.ai',
  workspaceRoot: 'sandboxed filesystem rooted at /home/user',
  workspacePersistence: 'Files you write are saved and persist across messages in the conversation',
  previewSandbox: 'preview renders in a sandboxed iframe',
  trustedContextTag: '<arena-system-message>',
  structuredClarification: 'ask_user',
  planning: 'propose_plan',
  connectors: 'list_connector_tools',
} as const

/** Exact public string-value hashes from the 2026-08-30 completed-route bundle. */
export const ARENA_AGENT_PROMPT_TEMPLATE_SHA256 = {
  agent: '2ccb1e4aaed61f27fe60f49aefcdc50548e0c3a55f7dec44ab637c85de801298',
  coding: 'a15295ffffd3dedf8c5debb5b19bc9637668adfe0c9e0112e5cf005e900e350b',
  codingClosedGuidance: '9d1ef7d6a7a2506ab0867cc95def035cabdda1009fe1346c000694b9d36ab999',
} as const

const PROMPT_PROJECTION = {
  currentDate: '2026-08-30',
  timezone: 'UTC',
  repoOwner: 'arena-labs',
  repoName: 'harness',
  baseBranch: 'main',
  baseSha: 'a'.repeat(40),
  arenaBranch: 'arena/contract-session',
  cwd: '/home/user',
} as const

export const ARENA_PUBLIC_TOOL_ARGUMENT_FIELDS: Record<string, readonly string[]> = {
  create_file: ['path', 'content'],
  edit_file: ['path', 'context', 'replacement'],
  read_file: ['path', 'offset', 'limit'],
  list_files: ['path'],
  delete_file: ['path'],
  install_npm_packages: ['packages'],
  build_project: [],
  build_and_start: ['description'],
  deploy_project: [],
  apply_patch: ['input'],
  bash: ['command', 'description', 'timeout', 'workdir'],
  shell_command: ['command', 'workdir'],
  update_plan: ['explanation', 'plan'],
  grep_files: ['pattern', 'path', 'glob', 'output_mode', '-i', '-B', '-A', '-C', 'context'],
  glob_files: ['pattern', 'path'],
  web_search: ['query', 'depth'],
  web_fetch: ['url', 'format'],
  fetch_media: ['query', 'media_type', 'count', 'orientation', 'size', 'locale'],
  generate_image: ['file_path', 'prompt'],
}

export type ArenaPublicArgumentPrimitive = string | number | boolean | null

export interface ArenaPublicArgumentSchemaNode {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum' | 'literal' | 'union'
  optional?: true
  enum?: ArenaPublicArgumentPrimitive[]
  literal?: ArenaPublicArgumentPrimitive
  default?: ArenaPublicArgumentPrimitive
  catch?: ArenaPublicArgumentPrimitive | Record<string, ArenaPublicArgumentPrimitive>
  preprocess?: 'number_to_string'
  passthrough?: true
  items?: ArenaPublicArgumentSchemaNode
  properties?: Record<string, ArenaPublicArgumentSchemaNode>
}

const stringArgument = (optional = false): ArenaPublicArgumentSchemaNode => ({
  type: 'string',
  ...(optional ? { optional: true as const } : {}),
})
const numberArgument = (optional = false): ArenaPublicArgumentSchemaNode => ({
  type: 'number',
  ...(optional ? { optional: true as const } : {}),
})
const booleanArgument = (optional = false): ArenaPublicArgumentSchemaNode => ({
  type: 'boolean',
  ...(optional ? { optional: true as const } : {}),
})
const enumArgument = (values: string[], options: { optional?: boolean; default?: string; preprocess?: 'number_to_string' } = {}): ArenaPublicArgumentSchemaNode => ({
  type: 'enum',
  enum: values,
  ...(options.optional || options.default !== undefined ? { optional: true as const } : {}),
  ...(options.default !== undefined ? { default: options.default } : {}),
  ...(options.preprocess ? { preprocess: options.preprocess } : {}),
})
const objectArgument = (
  properties: Record<string, ArenaPublicArgumentSchemaNode>,
  options: Pick<ArenaPublicArgumentSchemaNode, 'optional' | 'catch' | 'passthrough'> = {},
): ArenaPublicArgumentSchemaNode => ({ type: 'object', properties, ...options })
const arrayArgument = (items: ArenaPublicArgumentSchemaNode, optional = false): ArenaPublicArgumentSchemaNode => ({
  type: 'array',
  items,
  ...(optional ? { optional: true as const } : {}),
})

/**
 * Frozen semantic projection of the argument Zod schemas shipped in Arena's
 * public Agent bundle. It deliberately records only behavior visible in that
 * parser; descriptions and private server-side constraints are not inferred.
 */
export const ARENA_PUBLIC_ARGUMENT_SCHEMAS: Record<(typeof ARENA_PUBLIC_TOOL_NAMES)[number], ArenaPublicArgumentSchemaNode> = {
  create_file: objectArgument({ path: stringArgument(), content: stringArgument() }),
  edit_file: objectArgument({ path: stringArgument(), context: stringArgument(), replacement: stringArgument() }),
  read_file: objectArgument({ path: stringArgument(), offset: numberArgument(true), limit: numberArgument(true) }),
  list_files: objectArgument({ path: stringArgument(true) }),
  delete_file: objectArgument({ path: stringArgument() }),
  install_npm_packages: objectArgument({ packages: arrayArgument(stringArgument()) }),
  build_project: objectArgument({}),
  build_and_start: objectArgument({ description: stringArgument(true) }),
  deploy_project: objectArgument({}),
  apply_patch: objectArgument({ input: stringArgument() }),
  bash: objectArgument({
    command: { type: 'string', catch: '' },
    description: stringArgument(true),
    timeout: numberArgument(true),
    workdir: stringArgument(true),
  }, { passthrough: true, catch: { command: '' } }),
  shell_command: objectArgument({ command: stringArgument(), workdir: stringArgument(true) }),
  update_plan: objectArgument({
    explanation: stringArgument(true),
    plan: arrayArgument(objectArgument({ step: stringArgument(), status: stringArgument() })),
  }),
  grep_files: objectArgument({
    pattern: stringArgument(),
    path: stringArgument(true),
    glob: stringArgument(true),
    output_mode: enumArgument(['content', 'files_with_matches', 'count'], { optional: true }),
    '-i': booleanArgument(true),
    '-B': numberArgument(true),
    '-A': numberArgument(true),
    '-C': numberArgument(true),
    context: numberArgument(true),
  }),
  glob_files: objectArgument({ pattern: stringArgument(), path: stringArgument(true) }),
  web_search: objectArgument({
    query: stringArgument(),
    depth: enumArgument(['1', '2', '3'], { preprocess: 'number_to_string' }),
  }),
  web_fetch: objectArgument({
    url: stringArgument(),
    format: enumArgument(['markdown', 'text', 'html'], { optional: true }),
  }),
  fetch_media: objectArgument({
    query: stringArgument(),
    media_type: enumArgument(['image', 'video', 'both'], { default: 'both' }),
    count: { type: 'number', optional: true, default: 6 },
    orientation: enumArgument(['any', 'landscape', 'portrait', 'square'], { default: 'any' }),
    size: enumArgument(['any', 'large', 'medium', 'small'], { default: 'any' }),
    locale: stringArgument(true),
  }),
  generate_image: objectArgument({ file_path: stringArgument(), prompt: stringArgument() }),
}

export const ARENA_PUBLIC_KEY_RESULT_FIELDS: Record<string, readonly string[]> = ARENA_PUBLIC_SUCCESS_RESULT_FIELDS

export const ARENA_PUBLIC_UI_STRINGS = {
  emptyStateTitle: 'What would you like to do?',
  askAnything: 'Ask anything…',
  uploadFiles: 'Upload files',
  addFiles: 'Add files',
  sendMessage: 'Send message',
  connections: 'Connections',
  connectGithub: 'Connect GitHub',
  manageRepositories: 'Manage repositories',
  manageRepositoriesOnGithub: 'Manage repositories on GitHub',
  disconnectGithub: 'Disconnect GitHub',
  addRepositories: 'Add repositories…',
  openingGithub: 'Opening GitHub…',
  searchRepositories: 'Search repositories…',
  noRepositoriesFound: 'No repositories found',
  repositoriesLoadFailure: "Couldn't load your repositories.",
  repositoryPermissionHint: "A repo won't appear if its owner hasn't installed the app or granted access.",
  loadingRepositoryControls: 'Loading GitHub repository controls',
  branchRetry: 'Branches failed — retry',
  emptyRepositoryBranches: "No branches yet — we'll create one when you start.",
  githubOutageNotice: 'GitHub has an outage that may affect your use of some features.',
  viewGithubStatus: 'View Status',
  viewGithubStatusAttached: 'View status',
  githubOutageAria: 'GitHub outage notice',
  dismissGithubOutageNotice: 'Dismiss GitHub outage notice',
  githubConnectionVerificationFailure: 'We couldn’t verify your GitHub connection. Please try again.',
  disconnectingGithub: 'Disconnecting…',
} as const

/**
 * UI evidence that is only shipped by the completed `/agent/[id]` route.
 * The Chinese values are the locale observed in the Arena reference capture;
 * the close/workspace labels remain English in that same rendered surface.
 */
export const ARENA_PUBLIC_COMPLETED_UI_STRINGS = {
  taskReviewQuestion: '此任务成功了吗？',
  taskReviewYes: '是',
  taskReviewNo: '否',
  taskReviewKeepWorking: '继续工作',
  closeReviewPanel: 'Close review panel',
  openWorkspace: 'Open workspace',
  searchRunning: 'Searching…',
  searchFailed: 'Search failed',
  searchStopped: 'Search stopped',
  imageSearchRunning: 'Searching images…',
  imageSearchFailed: 'Image search failed',
  imageSearchStopped: 'Image search stopped',
  commandGroupRunning: 'Running commands',
  commandGroupDone: 'Ran commands',
  fileGroupRunning: 'Editing files',
  fileGroupDone: 'Edited files',
  imageGenerationRunning: 'Generating images…',
  imageGenerationDone: 'Generated image',
  speechGenerationRunning: 'Generating speech…',
  speechGenerationDone: 'Generated speech',
  processOutputDone: 'Read process output',
} as const

/**
 * Public completed-route evidence for the rendered/raw-source view switcher.
 * The current Arena component exposes icon-only buttons whose accessible
 * names are literal `aria-label` values in the public completed-route bundle.
 */
export const ARENA_PUBLIC_PREVIEW_SWITCHER_CONTRACT = {
  views: [
    { value: 'preview', label: 'Preview' },
    { value: 'raw', label: 'Raw source' },
  ],
} as const

export const ARENA_PUBLIC_TASK_REVIEW_CONTRACT = {
  feedbackType: 'check_in',
  questionKey: 'Was this task successful?',
  actions: [
    { action: 'approve', labelKey: 'Yes' },
    { action: 'disapprove', labelKey: 'No' },
    { action: 'edit', labelKey: 'Keep working' },
  ],
  dismissAction: 'escape',
  endpointSegment: 'review-feedback',
  sessionNodeIdField: 'sessionNodeId',
  recaptchaTokenField: 'recaptchaV3Token',
  requestActionField: 'action',
} as const

export const ARENA_PUBLIC_TASK_COMPLETION_CONTRACT = {
  feedbackType: 'task_completion_bar',
  questionKey: 'Does this complete your task?',
  actions: [
    { value: 'no', labelKey: 'No' },
    { value: 'making_progress', labelKey: 'Making progress' },
    { value: 'yes', labelKey: 'Yes' },
  ],
  endpointSegment: 'review-feedback',
  containerTestId: 'task-completion-bar-container',
  barTestId: 'task-completion-bar',
  latestViewedKey: 'latestAssistantResponseViewedId',
  requiresReviewKey: 'requiresReview',
  feedbackMetadataKey: 'taskCompletion',
} as const

/**
 * Public completed-route evidence for the post-disapproval action. Arena
 * transports this through the generic session action channel, then performs
 * an optimistic conversation rewind in the client. The public bundle does not
 * establish that Workspace bytes are rolled back, so this contract makes no
 * such claim.
 */
export const ARENA_PUBLIC_UNDO_CONTRACT = {
  actionType: 'undo',
  question: 'Do you want to undo the last turn?',
  actionLabel: 'Undo',
  dismissLabel: 'Dismiss',
  undoStatus: 'Undoing last turn...',
  savingStatus: 'Saving feedback...',
  preparingStatus: 'Preparing message...',
  failureMessage: 'Failed to undo message',
  sessionNodeIdField: 'sessionNodeId',
  recaptchaTokenField: 'recaptchaV3Token',
  compactionType: 'data-compaction',
  checkpointAppliedField: 'checkpointApplied',
} as const

/** Public task-completion feedback acknowledgement animation contract. */
export const ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT = {
  text: 'Thank you for your feedback!',
  phases: ['in', 'out'] as const,
  visibleMs: 2_000,
  exitMs: 200,
  excludedArm: 'treatment-2',
} as const

/**
 * Public completed-route evidence for Arena's agentic custom-feedback turn.
 * The data part is client-visible transport metadata; the marker is the
 * provider-facing trusted text recognized by the same public message module.
 */
export const ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT = {
  featureFlag: 'agentic-custom-feedback',
  arms: ['treatment-1', 'treatment-2'] as const,
  dataPartType: 'data-custom-feedback',
  systemMessageField: 'systemMessage',
  reviewedNodeIdField: 'reviewedNodeId',
  marker: 'The next message part will be the user providing feedback about the previous message.',
  telemetryField: 'has_feedback',
  providerMetadataField: 'providerMetadata',
  providerNamespace: 'arena',
  providerSystemMessageField: 'systemMessage',
  leadingPartOrder: 'custom-feedback → files → user text',
  ui: {
    calloutQuestion: 'Provide your feedback?',
    giveFeedback: 'Give feedback',
    dismiss: 'Dismiss',
    chipLabel: 'Feedback',
    placeholder: 'Give feedback on this task',
  },
} as const

export const ARENA_PUBLIC_CLIENT_LITERALS = {
  codingRepositoryPanelStorageKey: 'coding-repo-connect-panel',
} as const

export const ARENA_PUBLIC_UPLOAD_MIME_TYPES = [
  'image/png',
  'image/webp',
  'image/jpeg',
  'image/gif',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/pdf',
] as const

export const ARENA_PUBLIC_UPLOAD_LIMITS = {
  fileBytes: 0x1900000,
  pdfBytes: 0xa00000,
  turnBytes: 0x3200000,
} as const

/**
 * Frozen transport contract from the public 2026-08-30 Agent landing,
 * upload-client, and completed-session bundles. This is intentionally split
 * by branch: Arena creates a new Agent chat atomically, while later turns use
 * the established agentic submission envelope.
 */
export const ARENA_PUBLIC_CREATE_CHAT_CONTRACT = {
  newChat: {
    endpoint: '/nextjs-api/stream/create-chat',
    requestMethod: 'POST',
    responseId: 'id',
    messageId: 'UUIDv7',
    messageRole: 'user',
    messageParts: 'parts',
    messageMetadata: 'metadata',
    recaptchaV2Token: 'recaptchaV2Token',
    recaptchaV3Token: 'recaptchaV3Token',
    timezone: 'timezone',
    modelId: 'modelId',
    partOrder: 'image file parts → optional trimmed text',
    excludesExistingTurnEnvelope: 'no metadata/v2Source wrapper',
  },
  signedUpload: {
    endpoint: '/api/storage/generate-agent-upload-url',
    requestMethod: 'POST',
    requestHash: 'hash',
    requestContentType: 'contentType',
    requestSize: 'size',
    responseUploadUrl: 'uploadUrl',
    responseKey: 'key',
    binaryUploadMethod: 'PUT',
    hashEncoding: 'SHA-256 base64url',
    casUserPath: '/api/chat/workspace/cas/user/{hash}',
  },
  existingTurn: {
    message: 'message',
    metadata: 'metadata',
    timezone: 'timezone',
    submissionSource: 'submissionSource',
    v2Source: 'agentic_chat_submit',
    branchDistinct: 'existing turn envelope only',
  },
} as const

export interface ArenaPublicAsset {
  url: string
  text: string
}

export interface ArenaPublicStringProbe {
  value: string
  present: boolean
  hits: Array<{
    asset: string
    occurrences: number
    snippets: string[]
  }>
}

export interface ArenaPublicContractEvidence {
  value: string
  present: boolean
  assets: string[]
}

type ArenaPublicEvidenceGroup<T extends Record<string, string>> = {
  [K in keyof T]: ArenaPublicContractEvidence
}

export interface ArenaPublicContractSnapshot {
  schemaVersion: 15
  pageUrl: string
  deploymentId?: string
  scriptAssets: string[]
  supplementalPages: Array<{
    pageUrl: string
    scriptAssets: string[]
  }>
  toolSchemaAsset?: string
  activeAgentToolRegistryAsset?: string
  activeAgentToolNames: string[]
  activeAgentToolContracts: Record<string, {
    asset?: string
    argumentFields: string[]
    requiredFields: string[]
    schema?: Record<string, unknown>
    schemaSha256?: string
    description?: string
    descriptionSha256?: string
    missingSchemaEvidence: string[]
    missingDescriptionEvidence: string[]
  }>
  activeAgentPromptAnchors: Record<keyof typeof ARENA_ACTIVE_AGENT_PROMPT_ANCHORS, {
    value: string
    present: boolean
    assets: string[]
  }>
  promptTemplates: {
    agent: ArenaPublicPromptTemplateEvidence
    coding: ArenaPublicPromptTemplateEvidence
    codingClosedGuidance: ArenaPublicPromptTemplateEvidence
    projections: {
      agentSha256?: string
      codingActiveSha256?: string
      codingClosedSha256?: string
    }
  }
  toolNames: string[]
  toolArgumentFields: Record<string, string[]>
  toolArgumentSchemas: Record<string, ArenaPublicArgumentSchemaNode>
  keyResultFields: Record<string, string[]>
  commonErrorResultFields: string[]
  toolErrorExtensionFields: Record<string, string[]>
  uiStrings: Record<keyof typeof ARENA_PUBLIC_UI_STRINGS, {
    value: string
    present: boolean
    assets: string[]
  }>
  completedUiStrings: Record<keyof typeof ARENA_PUBLIC_COMPLETED_UI_STRINGS, {
    value: string
    present: boolean
    assets: string[]
  }>
  previewSwitcherContract: {
    views: Array<{ value: string; label: string; present: boolean; assets: string[] }>
  }
  taskReviewContract: {
    feedbackType: { value: string; present: boolean; assets: string[] }
    questionKey: { value: string; present: boolean; assets: string[] }
    actions: Array<{ action: string; labelKey: string; present: boolean; assets: string[] }>
    dismissAction: { value: string; present: boolean; assets: string[] }
    endpointSegment: { value: string; present: boolean; assets: string[] }
    sessionNodeIdField: { value: string; present: boolean; assets: string[] }
    recaptchaTokenField: { value: string; present: boolean; assets: string[] }
    requestActionField: { value: string; present: boolean; assets: string[] }
  }
  taskCompletionContract: {
    feedbackType: { value: string; present: boolean; assets: string[] }
    questionKey: { value: string; present: boolean; assets: string[] }
    actions: Array<{ value: string; labelKey: string; present: boolean; assets: string[] }>
    endpointSegment: { value: string; present: boolean; assets: string[] }
    containerTestId: { value: string; present: boolean; assets: string[] }
    barTestId: { value: string; present: boolean; assets: string[] }
    latestViewedKey: { value: string; present: boolean; assets: string[] }
    requiresReviewKey: { value: string; present: boolean; assets: string[] }
    feedbackMetadataKey: { value: string; present: boolean; assets: string[] }
  }
  undoContract: {
    actionType: { value: string; present: boolean; assets: string[] }
    question: { value: string; present: boolean; assets: string[] }
    actionLabel: { value: string; present: boolean; assets: string[] }
    dismissLabel: { value: string; present: boolean; assets: string[] }
    undoStatus: { value: string; present: boolean; assets: string[] }
    savingStatus: { value: string; present: boolean; assets: string[] }
    preparingStatus: { value: string; present: boolean; assets: string[] }
    failureMessage: { value: string; present: boolean; assets: string[] }
    sessionNodeIdField: { value: string; present: boolean; assets: string[] }
    recaptchaTokenField: { value: string; present: boolean; assets: string[] }
    compactionType: { value: string; present: boolean; assets: string[] }
    checkpointAppliedField: { value: string; present: boolean; assets: string[] }
  }
  taskCompletionThankYouContract: {
    text: { value: string; present: boolean; assets: string[] }
    phases: Array<{ value: 'in' | 'out'; present: boolean; assets: string[] }>
    visibleMs: { value: number; present: boolean; assets: string[] }
    exitMs: { value: number; present: boolean; assets: string[] }
    excludedArm: { value: string; present: boolean; assets: string[] }
  }
  customFeedbackContract: {
    featureFlag: { value: string; present: boolean; assets: string[] }
    arms: Array<{ value: string; present: boolean; assets: string[] }>
    dataPartType: { value: string; present: boolean; assets: string[] }
    systemMessageField: { value: string; present: boolean; assets: string[] }
    reviewedNodeIdField: { value: string; present: boolean; assets: string[] }
    marker: { value: string; present: boolean; assets: string[] }
    telemetryField: { value: string; present: boolean; assets: string[] }
    providerMetadataRecognition: {
      value: string
      present: boolean
      assets: string[]
    }
    leadingPartOrder: { value: string; present: boolean; assets: string[] }
    ui: Record<keyof typeof ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.ui, {
      value: string
      present: boolean
      assets: string[]
    }>
  }
  clientLiterals: Record<keyof typeof ARENA_PUBLIC_CLIENT_LITERALS, {
    value: string
    present: boolean
    assets: string[]
  }>
  upload: {
    sourceAsset?: string
    allowedMimeTypes: string[]
    fileBytes?: number
    pdfBytes?: number
    turnBytes?: number
  }
  createChatTransport: {
    newChat: ArenaPublicEvidenceGroup<typeof ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat>
    signedUpload: ArenaPublicEvidenceGroup<typeof ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload>
    existingTurn: ArenaPublicEvidenceGroup<typeof ARENA_PUBLIC_CREATE_CHAT_CONTRACT.existingTurn>
  }
}

export interface LocalArenaContract {
  toolDefinitions: readonly ToolDefinition[]
  activeToolDefinitions?: readonly ToolDefinition[]
  uploadMimeTypes: readonly string[]
  uploadLimits: {
    fileBytes: number
    pdfBytes: number
    turnBytes: number
  }
  clientSource: string
  agentSource?: string
  /** Deterministic builder outputs for exact whole-template comparison. */
  promptProjections?: {
    agent: string
    codingActive: string
    codingClosed: string
  }
}

export interface ArenaPublicPromptTemplateEvidence {
  identifier: 'SYSTEM_PROMPT_TEMPLATE' | 'CODING_SYSTEM_PROMPT_TEMPLATE' | 'CODING_CLOSED_SESSION_GUIDANCE'
  asset?: string
  present: boolean
  length?: number
  sha256?: string
}

export interface ArenaPublicContractDiff {
  passed: boolean
  issues: string[]
  activeAgentToolsMissingLocally: string[]
  expectedActiveAgentToolsMissingPublicly: string[]
  unexpectedActiveAgentTools: string[]
  liveActiveAgentSchemaMismatches: string[]
  liveActiveAgentDescriptionMismatches: string[]
  localActiveAgentSchemaMismatches: string[]
  localActiveAgentDescriptionMismatches: string[]
  missingLiveActiveAgentPromptEvidence: string[]
  activeAgentPromptAnchorsMissingLocally: string[]
  liveAgentPromptTemplateMismatches: string[]
  localAgentPromptProjectionMismatches: string[]
  publicToolsMissingLocally: string[]
  localPublicToolArgumentMismatches: Array<{
    tool: string
    publicFields: string[]
    localFields: string[]
  }>
  liveArgumentSchemaMismatches: Array<{
    tool: string
    expected?: ArenaPublicArgumentSchemaNode
    observed?: ArenaPublicArgumentSchemaNode
  }>
  localPublicToolArgumentSchemaMismatches: Array<{
    tool: string
    publicSchema: ArenaPublicArgumentSchemaNode
    localSchema: ArenaPublicArgumentSchemaNode
  }>
  missingPublicResultEvidence: Array<{ tool: string; fields: string[] }>
  missingCommonErrorResultEvidence: string[]
  missingPublicErrorExtensionEvidence: Array<{ tool: string; fields: string[] }>
  publicUiStringsMissingLocally: string[]
  completedUiStringsMissingLocally: string[]
  missingLiveCompletedUiEvidence: string[]
  previewSwitcherMissingLocally: string[]
  missingLivePreviewSwitcherEvidence: string[]
  missingLiveTaskReviewContractEvidence: string[]
  taskReviewContractMissingLocally: string[]
  taskCompletionContractMissingLocally: string[]
  missingLiveTaskCompletionContractEvidence: string[]
  undoContractMissingLocally: string[]
  missingLiveUndoContractEvidence: string[]
  taskCompletionThankYouMissingLocally: string[]
  missingLiveTaskCompletionThankYouEvidence: string[]
  customFeedbackContractMissingLocally: string[]
  missingLiveCustomFeedbackContractEvidence: string[]
  publicClientLiteralsMissingLocally: string[]
  uploadMismatches: string[]
  missingLiveCreateChatTransportEvidence: string[]
  createChatTransportMissingLocally: string[]
  missingLiveSignedUploadTransportEvidence: string[]
  signedUploadTransportMissingLocally: string[]
  missingLiveExistingTurnTransportEvidence: string[]
  existingTurnTransportMissingLocally: string[]
}

/**
 * Finds bounded, reviewable evidence for candidate UI strings in the same
 * public HTML/assets used by the contract audit. This is intentionally a
 * diagnostic helper: a hit does not become a frozen contract until its bundle
 * context establishes that it belongs to the Agent UI.
 */
export function probeArenaPublicStrings(
  pageUrl: string,
  pageHtml: string,
  assets: readonly ArenaPublicAsset[],
  values: readonly string[],
  options: { contextCharacters?: number; snippetsPerAsset?: number } = {},
): ArenaPublicStringProbe[] {
  const contextCharacters = Math.max(0, options.contextCharacters ?? 180)
  const snippetsPerAsset = Math.max(1, options.snippetsPerAsset ?? 2)
  const searchable = [{ url: pageUrl, text: pageHtml }, ...assets]
  return [...new Set(values.filter((value) => value.length > 0))].map((value) => {
    const hits = searchable.flatMap((asset) => {
      const indexes: number[] = []
      for (let index = asset.text.indexOf(value); index >= 0; index = asset.text.indexOf(value, index + value.length)) {
        indexes.push(index)
      }
      if (indexes.length === 0) return []
      return [{
        asset: asset.url,
        occurrences: indexes.length,
        snippets: indexes.slice(0, snippetsPerAsset).map((index) => {
          const start = Math.max(0, index - contextCharacters)
          const end = Math.min(asset.text.length, index + value.length + contextCharacters)
          const before = asset.text.slice(start, index)
          const after = asset.text.slice(index + value.length, end)
          return `${before}⟦${value}⟧${after}`.replace(/\s+/g, ' ')
        }),
      }]
    })
    return { value, present: hits.length > 0, hits }
  })
}

const TOOL_NAME_PATTERN = /toolName:[\w$.]+\.literal\("([^"]+)"\)/g
const MIME_PATTERN = /^(?:image|text|application)\/[A-Za-z0-9.+-]+$/

export function extractArenaScriptAssetUrls(pageHtml: string, pageUrl: string): string[] {
  const urls = [...pageHtml.matchAll(/\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["']/g)]
    .map((match) => match[1].replaceAll('&amp;', '&'))
    .map((value) => new URL(value, pageUrl).href)
  return [...new Set(urls)]
}

export function extractArenaPublicContract(
  pageUrl: string,
  pageHtml: string,
  assets: readonly ArenaPublicAsset[],
  options: {
    supplementalSources?: ReadonlyArray<{
      pageUrl: string
      pageHtml: string
      assets: readonly ArenaPublicAsset[]
    }>
  } = {},
): ArenaPublicContractSnapshot {
  const scriptAssets = extractArenaScriptAssetUrls(pageHtml, pageUrl)
  const deploymentId = extractDeploymentId(scriptAssets, pageHtml)
  const toolCandidate = assets
    .map((asset) => ({ asset, hits: toolHits(asset.text) }))
    .sort((left, right) => right.hits.length - left.hits.length)[0]
  const toolNames = toolCandidate?.hits.map((hit) => hit.name) ?? []
  const toolArgumentFields: Record<string, string[]> = {}
  const toolArgumentSchemas: Record<string, ArenaPublicArgumentSchemaNode> = {}
  const keyResultFields: Record<string, string[]> = {}
  const toolErrorExtensionFields: Record<string, string[]> = {}
  if (toolCandidate && toolCandidate.hits.length > 0) {
    for (const [index, hit] of toolCandidate.hits.entries()) {
      const nextIndex = toolCandidate.hits[index + 1]?.index ?? toolCandidate.asset.text.length
      const segment = toolCandidate.asset.text.slice(hit.index, nextIndex)
      toolArgumentFields[hit.name] = extractArgumentFields(toolCandidate.asset.text, segment, hit.index)
      const argumentSchema = extractArgumentSchema(toolCandidate.asset.text, segment, hit.index)
      if (argumentSchema) toolArgumentSchemas[hit.name] = argumentSchema
      const expectedFields = ARENA_PUBLIC_KEY_RESULT_FIELDS[hit.name]
      if (expectedFields) {
        const evidenceStart = Math.max(0, hit.index - (hit.name === 'fetch_media' ? 5_000 : 2_000))
        const evidenceEnd = Math.min(toolCandidate.asset.text.length, nextIndex + 500)
        const evidence = [
          toolCandidate.asset.text.slice(evidenceStart, evidenceEnd),
          ...(hit.name === 'read_file'
            ? assets.filter((asset) => asset.text.includes('WebDevFileSchema=')).map((asset) => asset.text)
            : []),
        ].join('\n')
        keyResultFields[hit.name] = expectedFields.filter((field) => propertyAppears(evidence, field))
        const expectedErrorExtensions = ARENA_PUBLIC_TOOL_ERROR_EXTENSION_FIELDS[hit.name]
        if (expectedErrorExtensions) {
          toolErrorExtensionFields[hit.name] = expectedErrorExtensions.filter((field) => propertyAppears(evidence, field))
        }
      }
    }
  }
  const commonErrorResultFields = toolCandidate
    ? ARENA_PUBLIC_COMMON_ERROR_RESULT_FIELDS.filter((field) => propertyAppears(toolCandidate.asset.text, field))
    : []

  const supplementalSources = options.supplementalSources ?? []
  const searchable = [
    { url: pageUrl, text: pageHtml },
    ...assets,
    ...supplementalSources.flatMap((source) => [{ url: source.pageUrl, text: source.pageHtml }, ...source.assets]),
  ]
  const activeAgentRegistry = extractActiveAgentToolRegistry(searchable)
  const activeAgentToolContracts = extractActiveAgentToolContracts(searchable, ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS)
  const activeAgentPromptAnchors = Object.fromEntries(Object.entries(ARENA_ACTIVE_AGENT_PROMPT_ANCHORS).map(([key, value]) => [
    key,
    { value, ...stringEvidence(searchable, value) },
  ])) as ArenaPublicContractSnapshot['activeAgentPromptAnchors']
  const promptTemplates = extractPromptTemplateContract(searchable)
  const uiStrings = Object.fromEntries(Object.entries(ARENA_PUBLIC_UI_STRINGS).map(([key, value]) => [
    key,
    {
      value,
      present: searchable.some((asset) => asset.text.includes(value)),
      assets: searchable.filter((asset) => asset.text.includes(value)).map((asset) => asset.url),
    },
  ])) as ArenaPublicContractSnapshot['uiStrings']
  const completedUiStrings = Object.fromEntries(Object.entries(ARENA_PUBLIC_COMPLETED_UI_STRINGS).map(([key, value]) => [
    key,
    {
      value,
      present: searchable.some((asset) => asset.text.includes(value)),
      assets: searchable.filter((asset) => asset.text.includes(value)).map((asset) => asset.url),
    },
  ])) as ArenaPublicContractSnapshot['completedUiStrings']
  const previewSwitcherViews = ARENA_PUBLIC_PREVIEW_SWITCHER_CONTRACT.views.map((view) => {
    const assets = searchable
      .filter((asset) => previewSwitcherViewAppears(asset.text, view.value, view.label))
      .map((asset) => asset.url)
    return { ...view, present: assets.length > 0, assets }
  })
  const taskReviewQuestionEvidence = stringEvidence(searchable, ARENA_PUBLIC_TASK_REVIEW_CONTRACT.questionKey)
  const taskReviewActions = ARENA_PUBLIC_TASK_REVIEW_CONTRACT.actions.map((action) => {
    const assets = searchable.filter((asset) => taskReviewActionAppears(asset.text, action.action, action.labelKey)).map((asset) => asset.url)
    return { ...action, present: assets.length > 0, assets }
  })
  const taskReviewDismissAssets = searchable
    .filter((asset) => taskReviewDismissAppears(asset.text))
    .map((asset) => asset.url)
  const taskReviewDismissEvidence = { present: taskReviewDismissAssets.length > 0, assets: taskReviewDismissAssets }
  const taskReviewTransportAssets = searchable
    .filter((asset) => taskReviewTransportAppears(asset.text))
    .map((asset) => asset.url)
  const taskReviewTransportEvidence = { present: taskReviewTransportAssets.length > 0, assets: taskReviewTransportAssets }
  const taskCompletionActions = ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.actions.map((action) => {
    const assets = searchable.filter((asset) => taskCompletionActionAppears(asset.text, action.value, action.labelKey)).map((asset) => asset.url)
    return { ...action, present: assets.length > 0, assets }
  })
  const taskCompletionEvidence = Object.fromEntries(([
    'feedbackType',
    'questionKey',
    'endpointSegment',
    'containerTestId',
    'barTestId',
    'latestViewedKey',
    'requiresReviewKey',
    'feedbackMetadataKey',
  ] as const).map((key) => [key, {
    value: ARENA_PUBLIC_TASK_COMPLETION_CONTRACT[key],
    ...stringEvidence(searchable, ARENA_PUBLIC_TASK_COMPLETION_CONTRACT[key]),
  }])) as Omit<ArenaPublicContractSnapshot['taskCompletionContract'], 'actions'>
  const undoTransportAssets = searchable.filter((asset) => undoTransportAppears(asset.text)).map((asset) => asset.url)
  const undoTransportEvidence = { present: undoTransportAssets.length > 0, assets: undoTransportAssets }
  const undoContract = Object.fromEntries(Object.entries(ARENA_PUBLIC_UNDO_CONTRACT).map(([key, value]) => [
    key,
    {
      value,
      ...(key === 'actionType' || key === 'sessionNodeIdField' || key === 'recaptchaTokenField'
        ? undoTransportEvidence
        : stringEvidence(searchable, value)),
    },
  ])) as ArenaPublicContractSnapshot['undoContract']
  const thankYouTextEvidence = stringEvidence(searchable, ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.text)
  const thankYouPhases = ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.phases.map((value) => {
    const assets = searchable.filter((asset) => taskCompletionThankYouPhaseAppears(asset.text, value)).map((asset) => asset.url)
    return { value, present: assets.length > 0, assets }
  })
  const visibleTimingAssets = searchable
    .filter((asset) => taskCompletionThankYouTimingAppears(asset.text, ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.visibleMs))
    .map((asset) => asset.url)
  const exitTimingAssets = searchable
    .filter((asset) => taskCompletionThankYouTimingAppears(asset.text, ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.exitMs))
    .map((asset) => asset.url)
  const taskCompletionThankYouContract: ArenaPublicContractSnapshot['taskCompletionThankYouContract'] = {
    text: { value: ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.text, ...thankYouTextEvidence },
    phases: thankYouPhases,
    visibleMs: { value: ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.visibleMs, present: visibleTimingAssets.length > 0, assets: visibleTimingAssets },
    exitMs: { value: ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.exitMs, present: exitTimingAssets.length > 0, assets: exitTimingAssets },
    excludedArm: {
      value: ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.excludedArm,
      ...stringEvidence(searchable, ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.excludedArm),
    },
  }
  const customFeedbackFeatureAssets = searchable
    .filter((asset) => customFeedbackFeatureGateAppears(asset.text))
    .map((asset) => asset.url)
  const customFeedbackDataPartAssets = searchable
    .filter((asset) => customFeedbackDataPartAppears(asset.text))
    .map((asset) => asset.url)
  const customFeedbackProviderMetadataAssets = searchable
    .filter((asset) => customFeedbackProviderMetadataRecognitionAppears(asset.text))
    .map((asset) => asset.url)
  const customFeedbackLeadingOrderAssets = searchable
    .filter((asset) => customFeedbackLeadingPartOrderAppears(asset.text))
    .map((asset) => asset.url)
  const customFeedbackTelemetryAssets = searchable
    .filter((asset) => customFeedbackTelemetryAppears(asset.text))
    .map((asset) => asset.url)
  const customFeedbackContract: ArenaPublicContractSnapshot['customFeedbackContract'] = {
    featureFlag: {
      value: ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.featureFlag,
      present: customFeedbackFeatureAssets.length > 0,
      assets: customFeedbackFeatureAssets,
    },
    arms: ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.arms.map((value) => {
      const assets = searchable.filter((asset) => customFeedbackTreatmentAppears(asset.text, value)).map((asset) => asset.url)
      return { value, present: assets.length > 0, assets }
    }),
    dataPartType: {
      value: ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.dataPartType,
      present: customFeedbackDataPartAssets.length > 0,
      assets: customFeedbackDataPartAssets,
    },
    systemMessageField: {
      value: ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.systemMessageField,
      present: customFeedbackDataPartAssets.length > 0,
      assets: customFeedbackDataPartAssets,
    },
    reviewedNodeIdField: {
      value: ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.reviewedNodeIdField,
      present: customFeedbackDataPartAssets.length > 0,
      assets: customFeedbackDataPartAssets,
    },
    marker: {
      value: ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker,
      ...stringEvidence(searchable, ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker),
    },
    telemetryField: {
      value: ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.telemetryField,
      present: customFeedbackTelemetryAssets.length > 0,
      assets: customFeedbackTelemetryAssets,
    },
    providerMetadataRecognition: {
      value: `${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.providerMetadataField}.${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.providerNamespace}.${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.providerSystemMessageField}===true`,
      present: customFeedbackProviderMetadataAssets.length > 0,
      assets: customFeedbackProviderMetadataAssets,
    },
    leadingPartOrder: {
      value: ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.leadingPartOrder,
      present: customFeedbackLeadingOrderAssets.length > 0,
      assets: customFeedbackLeadingOrderAssets,
    },
    ui: Object.fromEntries(Object.entries(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.ui).map(([key, value]) => {
      const assets = searchable.filter((asset) => customFeedbackUiStringAppears(asset.text, value)).map((asset) => asset.url)
      return [key, { value, present: assets.length > 0, assets }]
    })) as ArenaPublicContractSnapshot['customFeedbackContract']['ui'],
  }
  const clientLiterals = Object.fromEntries(Object.entries(ARENA_PUBLIC_CLIENT_LITERALS).map(([key, value]) => [
    key,
    {
      value,
      present: searchable.some((asset) => asset.text.includes(value)),
      assets: searchable.filter((asset) => asset.text.includes(value)).map((asset) => asset.url),
    },
  ])) as ArenaPublicContractSnapshot['clientLiterals']

  const uploadCandidates = assets
    .map((asset) => ({ asset, mimeTypes: extractMimeArray(asset.text) }))
    .filter((candidate) => candidate.mimeTypes.length > 0)
    .sort((left, right) => right.mimeTypes.length - left.mimeTypes.length)
  const uploadCandidate = uploadCandidates[0]
  const uploadText = uploadCandidate?.asset.text ?? ''

  const newChatScoped = scopedAssetsAround(
    assets,
    ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.endpoint,
    6_000,
    4_000,
  )
  const signedUploadAssets = assets.filter((asset) => asset.text.includes('generate-agent-upload-url'))
  const signedUploadScoped = scopedAssetsAround(signedUploadAssets, 'generate-agent-upload-url', 1_500, 3_500)
  const supplementalSearchable = supplementalSources.flatMap((source) => [
    { url: source.pageUrl, text: source.pageHtml },
    ...source.assets,
  ])
  const existingTurnScoped = scopedAssetsAround(
    supplementalSearchable,
    `v2Source:${JSON.stringify(ARENA_PUBLIC_CREATE_CHAT_CONTRACT.existingTurn.v2Source)}`,
    6_000,
    1_500,
  )
  const createChatTransport: ArenaPublicContractSnapshot['createChatTransport'] = {
    newChat: {
      endpoint: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.endpoint, (text) => (
        text.includes(ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.endpoint)
      )),
      requestMethod: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.requestMethod, (text) => (
        /method\s*:\s*["']POST["']/.test(text)
      )),
      responseId: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.responseId, (text) => (
        /\{\s*id\s*:\s*[\w$]+\s*\}\s*=\s*await\s+[\w$]+\.json\(\)/.test(text)
      )),
      messageId: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.messageId, (text) => (
        /generateSafeUUIDv7|generateUuidV7|uuidv7/i.test(text)
          && /message\s*:\s*\{\s*id\s*:/.test(text)
      )),
      messageRole: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.messageRole, (text) => (
        /message\s*:\s*\{[\s\S]{0,220}?role\s*:\s*["']user["']/.test(text)
      )),
      messageParts: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.messageParts, (text) => (
        /message\s*:\s*\{[\s\S]{0,260}?parts\s*:/.test(text)
      )),
      messageMetadata: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.messageMetadata, (text) => (
        /message\s*:\s*\{[\s\S]{0,700}?metadata\s*:\s*\{[\s\S]{0,300}?uploads\s*:/.test(text)
      )),
      recaptchaV2Token: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.recaptchaV2Token, (text) => (
        propertyAppears(text, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.recaptchaV2Token)
      )),
      recaptchaV3Token: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.recaptchaV3Token, (text) => (
        propertyAppears(text, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.recaptchaV3Token)
      )),
      timezone: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.timezone, (text) => (
        propertyAppears(text, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.timezone)
      )),
      modelId: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.modelId, (text) => (
        propertyAppears(text, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.modelId)
      )),
      partOrder: contractEvidence(newChatScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.partOrder, newChatImageBeforeTextAppears),
      excludesExistingTurnEnvelope: contractEvidence(
        newChatScoped,
        ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.excludesExistingTurnEnvelope,
        (text) => text.includes(ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.endpoint) && !/\bv2Source\s*:/.test(text),
      ),
    },
    signedUpload: {
      endpoint: contractEvidence(signedUploadScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload.endpoint, (text) => (
        /storage\s*\[\s*["']generate-agent-upload-url["']\s*\]\s*\.\$post/.test(text)
      )),
      requestMethod: contractEvidence(signedUploadScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload.requestMethod, (text) => (
        /generate-agent-upload-url["']\s*\]\s*\.\$post/.test(text)
      )),
      requestHash: contractEvidence(signedUploadScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload.requestHash, (text) => propertyAppears(text, 'hash')),
      requestContentType: contractEvidence(signedUploadScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload.requestContentType, (text) => propertyAppears(text, 'contentType')),
      requestSize: contractEvidence(signedUploadScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload.requestSize, (text) => propertyAppears(text, 'size')),
      responseUploadUrl: contractEvidence(signedUploadScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload.responseUploadUrl, (text) => propertyAppears(text, 'uploadUrl')),
      responseKey: contractEvidence(signedUploadScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload.responseKey, (text) => propertyAppears(text, 'key')),
      binaryUploadMethod: contractEvidence(signedUploadScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload.binaryUploadMethod, (text) => (
        /fetch\([\w$]+,\{method\s*:\s*["']PUT["'][\s\S]{0,180}?body\s*:/.test(text)
      )),
      hashEncoding: contractEvidence(signedUploadAssets, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload.hashEncoding, (text) => (
        text.includes('sha256Base64urlBytes') && text.includes('SHA-256')
      )),
      casUserPath: contractEvidence(signedUploadAssets, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload.casUserPath, (text) => (
        text.includes('/api/chat/workspace/cas/user/')
      )),
    },
    existingTurn: {
      message: contractEvidence(existingTurnScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.existingTurn.message, (text) => propertyAppears(text, 'message')),
      metadata: contractEvidence(existingTurnScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.existingTurn.metadata, (text) => propertyAppears(text, 'metadata')),
      timezone: contractEvidence(existingTurnScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.existingTurn.timezone, (text) => propertyAppears(text, 'timezone')),
      submissionSource: contractEvidence(existingTurnScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.existingTurn.submissionSource, (text) => propertyAppears(text, 'submissionSource')),
      v2Source: contractEvidence(existingTurnScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.existingTurn.v2Source, (text) => (
        text.includes(`v2Source:${JSON.stringify(ARENA_PUBLIC_CREATE_CHAT_CONTRACT.existingTurn.v2Source)}`)
      )),
      branchDistinct: contractEvidence(existingTurnScoped, ARENA_PUBLIC_CREATE_CHAT_CONTRACT.existingTurn.branchDistinct, (text) => (
        /\bv2Source\s*:/.test(text)
          && newChatScoped.some((entry) => !/\bv2Source\s*:/.test(entry.text))
      )),
    },
  }

  return {
    schemaVersion: 15,
    pageUrl,
    deploymentId,
    scriptAssets,
    supplementalPages: supplementalSources.map((source) => ({
      pageUrl: source.pageUrl,
      scriptAssets: extractArenaScriptAssetUrls(source.pageHtml, source.pageUrl),
    })),
    toolSchemaAsset: toolCandidate?.hits.length ? toolCandidate.asset.url : undefined,
    activeAgentToolRegistryAsset: activeAgentRegistry?.asset,
    activeAgentToolNames: activeAgentRegistry?.names ?? [],
    activeAgentToolContracts,
    activeAgentPromptAnchors,
    promptTemplates,
    toolNames,
    toolArgumentFields,
    toolArgumentSchemas,
    keyResultFields,
    commonErrorResultFields,
    toolErrorExtensionFields,
    uiStrings,
    completedUiStrings,
    previewSwitcherContract: { views: previewSwitcherViews },
    taskReviewContract: {
      feedbackType: {
        value: ARENA_PUBLIC_TASK_REVIEW_CONTRACT.feedbackType,
        ...stringEvidence(searchable, ARENA_PUBLIC_TASK_REVIEW_CONTRACT.feedbackType),
      },
      questionKey: { value: ARENA_PUBLIC_TASK_REVIEW_CONTRACT.questionKey, ...taskReviewQuestionEvidence },
      actions: taskReviewActions,
      dismissAction: { value: ARENA_PUBLIC_TASK_REVIEW_CONTRACT.dismissAction, ...taskReviewDismissEvidence },
      endpointSegment: {
        value: ARENA_PUBLIC_TASK_REVIEW_CONTRACT.endpointSegment,
        ...stringEvidence(searchable, ARENA_PUBLIC_TASK_REVIEW_CONTRACT.endpointSegment),
      },
      sessionNodeIdField: {
        value: ARENA_PUBLIC_TASK_REVIEW_CONTRACT.sessionNodeIdField,
        ...stringEvidence(searchable, ARENA_PUBLIC_TASK_REVIEW_CONTRACT.sessionNodeIdField),
      },
      recaptchaTokenField: {
        value: ARENA_PUBLIC_TASK_REVIEW_CONTRACT.recaptchaTokenField,
        ...stringEvidence(searchable, ARENA_PUBLIC_TASK_REVIEW_CONTRACT.recaptchaTokenField),
      },
      requestActionField: {
        value: ARENA_PUBLIC_TASK_REVIEW_CONTRACT.requestActionField,
        ...taskReviewTransportEvidence,
      },
    },
    taskCompletionContract: { ...taskCompletionEvidence, actions: taskCompletionActions },
    undoContract,
    taskCompletionThankYouContract,
    customFeedbackContract,
    clientLiterals,
    upload: {
      sourceAsset: uploadCandidate?.asset.url,
      allowedMimeTypes: uploadCandidate?.mimeTypes ?? [],
      fileBytes: numericLiteralAppears(uploadText, ARENA_PUBLIC_UPLOAD_LIMITS.fileBytes)
        ? ARENA_PUBLIC_UPLOAD_LIMITS.fileBytes
        : undefined,
      pdfBytes: numericLiteralAppears(uploadText, ARENA_PUBLIC_UPLOAD_LIMITS.pdfBytes)
        ? ARENA_PUBLIC_UPLOAD_LIMITS.pdfBytes
        : undefined,
      turnBytes: numericLiteralAppears(uploadText, ARENA_PUBLIC_UPLOAD_LIMITS.turnBytes)
        ? ARENA_PUBLIC_UPLOAD_LIMITS.turnBytes
        : undefined,
    },
    createChatTransport,
  }
}

export function compareArenaPublicContract(
  snapshot: ArenaPublicContractSnapshot,
  local: LocalArenaContract,
): ArenaPublicContractDiff {
  const issues: string[] = []
  const localDefinitions = new Map(local.toolDefinitions.map((tool) => [tool.function.name, tool]))
  const completedRouteAudited = snapshot.supplementalPages.length > 0

  const activeAgentToolsMissingLocally = completedRouteAudited
    ? snapshot.activeAgentToolNames.filter((name) => !localDefinitions.has(name))
    : []
  const expectedActiveAgentToolsMissingPublicly = completedRouteAudited
    ? ARENA_ACTIVE_AGENT_TOOL_NAMES.filter((name) => !snapshot.activeAgentToolNames.includes(name))
    : []
  const unexpectedActiveAgentTools = completedRouteAudited
    ? snapshot.activeAgentToolNames.filter((name) => !(ARENA_ACTIVE_AGENT_TOOL_NAMES as readonly string[]).includes(name))
    : []
  const liveActiveAgentSchemaMismatches = completedRouteAudited
    ? ARENA_ACTIVE_AGENT_TOOL_NAMES.filter((name) => (
        snapshot.activeAgentToolContracts[name]?.schemaSha256 !== ARENA_ACTIVE_AGENT_SCHEMA_SHA256[name]
      ))
    : []
  const liveActiveAgentDescriptionMismatches = completedRouteAudited
    ? ARENA_ACTIVE_AGENT_TOOL_NAMES.filter((name) => (
        snapshot.activeAgentToolContracts[name]?.descriptionSha256 !== ARENA_ACTIVE_AGENT_DESCRIPTION_SHA256[name]
      ))
    : []
  const localActiveDefinitions = new Map((local.activeToolDefinitions ?? []).map((tool) => [tool.function.name, tool]))
  const localActiveAgentSchemaMismatches = local.activeToolDefinitions
    ? ARENA_ACTIVE_AGENT_TOOL_NAMES.filter((name) => {
        const definition = localActiveDefinitions.get(name)
        return !definition || sha256(JSON.stringify(definition.function.parameters)) !== ARENA_ACTIVE_AGENT_SCHEMA_SHA256[name]
      })
    : []
  const localActiveAgentDescriptionMismatches = local.activeToolDefinitions
    ? ARENA_ACTIVE_AGENT_TOOL_NAMES.filter((name) => {
        const definition = localActiveDefinitions.get(name)
        return !definition || sha256(definition.function.description) !== ARENA_ACTIVE_AGENT_DESCRIPTION_SHA256[name]
      })
    : []
  const missingLiveActiveAgentPromptEvidence = completedRouteAudited
    ? Object.entries(snapshot.activeAgentPromptAnchors)
        .filter(([, entry]) => !entry.present)
        .map(([key, entry]) => `${key}:${entry.value}`)
    : []
  const agentSource = local.agentSource ?? ''
  const activeAgentPromptAnchorsMissingLocally = completedRouteAudited
    ? Object.entries(ARENA_ACTIVE_AGENT_PROMPT_ANCHORS)
        .filter(([, value]) => !agentSource.includes(value))
        .map(([key, value]) => `${key}:${value}`)
    : []
  if (activeAgentToolsMissingLocally.length > 0) {
    issues.push(`Current active Arena Agent tools missing locally: ${activeAgentToolsMissingLocally.join(', ')}`)
  }
  if (expectedActiveAgentToolsMissingPublicly.length > 0) {
    issues.push(`Frozen active Arena Agent tools absent from the completed-route registry: ${expectedActiveAgentToolsMissingPublicly.join(', ')}`)
  }
  if (unexpectedActiveAgentTools.length > 0) {
    issues.push(`Unmapped active Arena Agent tools: ${unexpectedActiveAgentTools.join(', ')}`)
  }
  if (liveActiveAgentSchemaMismatches.length > 0) {
    issues.push(`Frozen active Agent argument schemas differ from live evidence for: ${liveActiveAgentSchemaMismatches.join(', ')}`)
  }
  if (liveActiveAgentDescriptionMismatches.length > 0) {
    issues.push(`Frozen active Agent descriptions differ from live evidence for: ${liveActiveAgentDescriptionMismatches.join(', ')}`)
  }
  if (localActiveAgentSchemaMismatches.length > 0) {
    issues.push(`Local active Agent argument schemas differ from the frozen live contract for: ${localActiveAgentSchemaMismatches.join(', ')}`)
  }
  if (localActiveAgentDescriptionMismatches.length > 0) {
    issues.push(`Local active Agent descriptions differ from the frozen live contract for: ${localActiveAgentDescriptionMismatches.join(', ')}`)
  }
  if (missingLiveActiveAgentPromptEvidence.length > 0) {
    issues.push(`Frozen active Agent prompt anchors absent from live evidence: ${missingLiveActiveAgentPromptEvidence.join(', ')}`)
  }
  if (activeAgentPromptAnchorsMissingLocally.length > 0) {
    issues.push(`Active Arena Agent prompt anchors missing locally: ${activeAgentPromptAnchorsMissingLocally.join(', ')}`)
  }
  const liveAgentPromptTemplateMismatches = completedRouteAudited && local.promptProjections
    ? ([
        ['agent', snapshot.promptTemplates.agent, ARENA_AGENT_PROMPT_TEMPLATE_SHA256.agent],
        ['coding', snapshot.promptTemplates.coding, ARENA_AGENT_PROMPT_TEMPLATE_SHA256.coding],
        ['codingClosedGuidance', snapshot.promptTemplates.codingClosedGuidance, ARENA_AGENT_PROMPT_TEMPLATE_SHA256.codingClosedGuidance],
      ] as const).flatMap(([name, evidence, expected]) => (
        !evidence.present ? [`${name}:missing`]
          : evidence.sha256 !== expected ? [`${name}:${evidence.sha256 ?? 'unhashed'}!=${expected}`]
            : []
      ))
    : []
  if (liveAgentPromptTemplateMismatches.length > 0) {
    issues.push(`Frozen whole Agent prompt templates differ from live evidence: ${liveAgentPromptTemplateMismatches.join(', ')}`)
  }
  const localAgentPromptProjectionMismatches = completedRouteAudited && local.promptProjections
    ? ([
        ['agent', local.promptProjections.agent, snapshot.promptTemplates.projections.agentSha256],
        ['codingActive', local.promptProjections.codingActive, snapshot.promptTemplates.projections.codingActiveSha256],
        ['codingClosed', local.promptProjections.codingClosed, snapshot.promptTemplates.projections.codingClosedSha256],
      ] as const).flatMap(([name, projection, expected]) => (
        expected === undefined ? [`${name}:live_projection_missing`]
          : sha256(projection) !== expected ? [`${name}:${sha256(projection)}!=${expected}`]
            : []
      ))
    : []
  if (localAgentPromptProjectionMismatches.length > 0) {
    issues.push(`Local whole Agent prompt projections differ from the public templates: ${localAgentPromptProjectionMismatches.join(', ')}`)
  }

  const publicToolsMissingLocally = snapshot.toolNames.filter((name) => !localDefinitions.has(name))
  if (publicToolsMissingLocally.length > 0) {
    issues.push(`Public Arena tools missing locally: ${publicToolsMissingLocally.join(', ')}`)
  }
  const expectedToolsMissingPublicly = ARENA_PUBLIC_TOOL_NAMES.filter((name) => !snapshot.toolNames.includes(name))
  const unexpectedPublicTools = snapshot.toolNames.filter((name) => !(ARENA_PUBLIC_TOOL_NAMES as readonly string[]).includes(name))
  if (expectedToolsMissingPublicly.length > 0) {
    issues.push(`Frozen Arena tools absent from the live schema: ${expectedToolsMissingPublicly.join(', ')}`)
  }
  if (unexpectedPublicTools.length > 0) {
    issues.push(`Unmapped live Arena tools: ${unexpectedPublicTools.join(', ')}`)
  }

  const localPublicToolArgumentMismatches: ArenaPublicContractDiff['localPublicToolArgumentMismatches'] = []
  for (const name of snapshot.toolNames) {
    const publicFields = sortedUnique(snapshot.toolArgumentFields[name] ?? [])
    const definition = localDefinitions.get(name)
    if (!definition) continue
    const parameters = definition.function.parameters as { properties?: Record<string, unknown> }
    const localFields = sortedUnique(Object.keys(parameters.properties ?? {}))
    if (!arraysEqual(publicFields, localFields)) {
      localPublicToolArgumentMismatches.push({ tool: name, publicFields, localFields })
    }
  }
  if (localPublicToolArgumentMismatches.length > 0) {
    issues.push(`Public argument fields differ for: ${localPublicToolArgumentMismatches.map((entry) => entry.tool).join(', ')}`)
  }

  const liveArgumentSchemaMismatches: ArenaPublicContractDiff['liveArgumentSchemaMismatches'] = []
  for (const name of ARENA_PUBLIC_TOOL_NAMES) {
    const expected = ARENA_PUBLIC_ARGUMENT_SCHEMAS[name]
    const observed = snapshot.toolArgumentSchemas[name]
    if (!observed || !schemasEqual(expected, observed)) {
      liveArgumentSchemaMismatches.push({ tool: name, expected, observed })
    }
  }
  if (liveArgumentSchemaMismatches.length > 0) {
    issues.push(`Frozen public argument schemas differ from live evidence for: ${liveArgumentSchemaMismatches.map((entry) => entry.tool).join(', ')}`)
  }

  const localPublicToolArgumentSchemaMismatches: ArenaPublicContractDiff['localPublicToolArgumentSchemaMismatches'] = []
  for (const name of snapshot.toolNames) {
    const publicSchema = snapshot.toolArgumentSchemas[name]
    const definition = localDefinitions.get(name)
    if (!publicSchema || !definition || !(ARENA_PUBLIC_TOOL_NAMES as readonly string[]).includes(name)) continue
    const localSchema = localArgumentSchema(definition.function.parameters)
    const comparablePublic = comparableArgumentSchema(publicSchema)
    if (!schemasEqual(comparablePublic, localSchema)) {
      localPublicToolArgumentSchemaMismatches.push({ tool: name, publicSchema: comparablePublic, localSchema })
    }
  }
  if (localPublicToolArgumentSchemaMismatches.length > 0) {
    issues.push(`Local public argument schemas differ for: ${localPublicToolArgumentSchemaMismatches.map((entry) => entry.tool).join(', ')}`)
  }

  const missingPublicResultEvidence = Object.entries(ARENA_PUBLIC_KEY_RESULT_FIELDS).flatMap(([tool, fields]) => {
    const observed = new Set(snapshot.keyResultFields[tool] ?? [])
    const missing = fields.filter((field) => !observed.has(field))
    return missing.length > 0 ? [{ tool, fields: missing }] : []
  })
  if (missingPublicResultEvidence.length > 0) {
    issues.push(`Key public result fields were not extracted for: ${missingPublicResultEvidence.map((entry) => entry.tool).join(', ')}`)
  }
  const missingCommonErrorResultEvidence = ARENA_PUBLIC_COMMON_ERROR_RESULT_FIELDS.filter((field) => !snapshot.commonErrorResultFields.includes(field))
  if (missingCommonErrorResultEvidence.length > 0) {
    issues.push(`Common public error-result fields were not extracted: ${missingCommonErrorResultEvidence.join(', ')}`)
  }
  const missingPublicErrorExtensionEvidence = Object.entries(ARENA_PUBLIC_TOOL_ERROR_EXTENSION_FIELDS).flatMap(([tool, fields]) => {
    const observed = new Set(snapshot.toolErrorExtensionFields[tool] ?? [])
    const missing = fields.filter((field) => !observed.has(field))
    return missing.length > 0 ? [{ tool, fields: missing }] : []
  })
  if (missingPublicErrorExtensionEvidence.length > 0) {
    issues.push(`Public error-result extension fields were not extracted for: ${missingPublicErrorExtensionEvidence.map((entry) => entry.tool).join(', ')}`)
  }

  const publicUiStringsMissingLocally = Object.values(snapshot.uiStrings)
    .filter((entry) => entry.present && !local.clientSource.includes(entry.value))
    .map((entry) => entry.value)
  const missingLiveUiEvidence = Object.values(snapshot.uiStrings).filter((entry) => !entry.present).map((entry) => entry.value)
  if (missingLiveUiEvidence.length > 0) {
    issues.push(`Frozen public UI strings absent from live assets: ${missingLiveUiEvidence.join(', ')}`)
  }
  if (publicUiStringsMissingLocally.length > 0) {
    issues.push(`Public Arena UI strings missing locally: ${publicUiStringsMissingLocally.join(', ')}`)
  }

  const completedUiStringsMissingLocally = Object.values(ARENA_PUBLIC_COMPLETED_UI_STRINGS)
    .filter((value) => !local.clientSource.includes(value))
  if (completedUiStringsMissingLocally.length > 0) {
    issues.push(`Completed-route Arena UI strings missing locally: ${completedUiStringsMissingLocally.join(', ')}`)
  }
  const missingLiveCompletedUiEvidence = completedRouteAudited
    ? Object.values(snapshot.completedUiStrings).filter((entry) => !entry.present).map((entry) => entry.value)
    : []
  if (missingLiveCompletedUiEvidence.length > 0) {
    issues.push(`Frozen completed-route UI strings absent from live evidence: ${missingLiveCompletedUiEvidence.join(', ')}`)
  }
  const previewSwitcherMissingLocally = ARENA_PUBLIC_PREVIEW_SWITCHER_CONTRACT.views
    .filter((view) => !localPreviewSwitcherViewAppears(local.clientSource, view.value, view.label))
    .map((view) => `${view.value}/${view.label}`)
  if (previewSwitcherMissingLocally.length > 0) {
    issues.push(`Arena preview switcher views missing locally: ${previewSwitcherMissingLocally.join(', ')}`)
  }
  const missingLivePreviewSwitcherEvidence = completedRouteAudited
    ? snapshot.previewSwitcherContract.views
        .filter((view) => !view.present)
        .map((view) => `${view.value}/${view.label}`)
    : []
  if (missingLivePreviewSwitcherEvidence.length > 0) {
    issues.push(`Frozen preview switcher contract absent from live evidence: ${missingLivePreviewSwitcherEvidence.join(', ')}`)
  }
  const missingLiveTaskReviewContractEvidence = completedRouteAudited
    ? [
        ...(!snapshot.taskReviewContract.feedbackType.present ? [`feedbackType:${snapshot.taskReviewContract.feedbackType.value}`] : []),
        ...(!snapshot.taskReviewContract.questionKey.present ? [`question:${snapshot.taskReviewContract.questionKey.value}`] : []),
        ...snapshot.taskReviewContract.actions.filter((action) => !action.present).map((action) => `action:${action.action}/${action.labelKey}`),
        ...(!snapshot.taskReviewContract.dismissAction.present ? [`dismiss:${snapshot.taskReviewContract.dismissAction.value}`] : []),
        ...(!snapshot.taskReviewContract.endpointSegment.present ? [`endpoint:${snapshot.taskReviewContract.endpointSegment.value}`] : []),
        ...(!snapshot.taskReviewContract.sessionNodeIdField.present ? [`request:${snapshot.taskReviewContract.sessionNodeIdField.value}`] : []),
        ...(!snapshot.taskReviewContract.recaptchaTokenField.present ? [`request:${snapshot.taskReviewContract.recaptchaTokenField.value}`] : []),
        ...(!snapshot.taskReviewContract.requestActionField.present ? [`request:${snapshot.taskReviewContract.requestActionField.value}`] : []),
      ]
    : []
  if (missingLiveTaskReviewContractEvidence.length > 0) {
    issues.push(`Frozen task-review action contract absent from live evidence: ${missingLiveTaskReviewContractEvidence.join(', ')}`)
  }
  const taskReviewContractMissingLocally = completedRouteAudited && !localTaskReviewTransportAppears(local.clientSource)
    ? ['check_in -> {sessionNodeId, recaptchaV3Token, action} @ review-feedback']
    : []
  if (taskReviewContractMissingLocally.length > 0) {
    issues.push(`Task-review transport contract missing locally: ${taskReviewContractMissingLocally.join(', ')}`)
  }
  const taskCompletionContractMissingLocally = [
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.feedbackType,
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.questionKey,
    ...ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.actions.flatMap((action) => [action.value, action.labelKey]),
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.endpointSegment,
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.containerTestId,
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.barTestId,
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.latestViewedKey,
  ].filter((value) => !local.clientSource.includes(value))
  if (taskCompletionContractMissingLocally.length > 0) {
    issues.push(`Task-completion contract missing locally: ${taskCompletionContractMissingLocally.join(', ')}`)
  }
  const missingLiveTaskCompletionContractEvidence = completedRouteAudited
    ? [
        ...Object.values(snapshot.taskCompletionContract)
          .filter((entry): entry is { value: string; present: boolean; assets: string[] } => !Array.isArray(entry))
          .filter((entry) => !entry.present)
          .map((entry) => entry.value),
        ...snapshot.taskCompletionContract.actions
          .filter((action) => !action.present)
          .map((action) => `action:${action.value}/${action.labelKey}`),
      ]
    : []
  if (missingLiveTaskCompletionContractEvidence.length > 0) {
    issues.push(`Frozen task-completion contract absent from live evidence: ${missingLiveTaskCompletionContractEvidence.join(', ')}`)
  }

  const missingLiveUndoContractEvidence = completedRouteAudited
    ? Object.entries(snapshot.undoContract)
        .filter(([, entry]) => !entry.present)
        .map(([key, entry]) => `${key}:${entry.value}`)
    : []
  if (missingLiveUndoContractEvidence.length > 0) {
    issues.push(`Frozen Undo contract absent from live evidence: ${missingLiveUndoContractEvidence.join(', ')}`)
  }
  const undoContractMissingLocally = completedRouteAudited && !localUndoContractAppears(local.clientSource)
    ? ['disapprove -> optimistic undo -> {type, sessionNodeId, recaptchaV3Token} @ action']
    : []
  if (undoContractMissingLocally.length > 0) {
    issues.push(`Undo contract missing locally: ${undoContractMissingLocally.join(', ')}`)
  }

  const missingLiveTaskCompletionThankYouEvidence = completedRouteAudited
    ? [
        ...(!snapshot.taskCompletionThankYouContract.text.present ? [`text:${snapshot.taskCompletionThankYouContract.text.value}`] : []),
        ...snapshot.taskCompletionThankYouContract.phases.filter((entry) => !entry.present).map((entry) => `phase:${entry.value}`),
        ...(!snapshot.taskCompletionThankYouContract.visibleMs.present ? [`visibleMs:${snapshot.taskCompletionThankYouContract.visibleMs.value}`] : []),
        ...(!snapshot.taskCompletionThankYouContract.exitMs.present ? [`exitMs:${snapshot.taskCompletionThankYouContract.exitMs.value}`] : []),
        ...(!snapshot.taskCompletionThankYouContract.excludedArm.present ? [`excludedArm:${snapshot.taskCompletionThankYouContract.excludedArm.value}`] : []),
      ]
    : []
  if (missingLiveTaskCompletionThankYouEvidence.length > 0) {
    issues.push(`Frozen task-completion thank-you contract absent from live evidence: ${missingLiveTaskCompletionThankYouEvidence.join(', ')}`)
  }
  const taskCompletionThankYouMissingLocally = completedRouteAudited && !localTaskCompletionThankYouAppears(local.clientSource)
    ? ['task_completion_bar default arm -> in 2000ms -> out 200ms -> hidden; treatment-2 excluded']
    : []
  if (taskCompletionThankYouMissingLocally.length > 0) {
    issues.push(`Task-completion thank-you contract missing locally: ${taskCompletionThankYouMissingLocally.join(', ')}`)
  }

  const missingLiveCustomFeedbackContractEvidence = completedRouteAudited
    ? [
        ...(!snapshot.customFeedbackContract.featureFlag.present ? [`featureFlag:${snapshot.customFeedbackContract.featureFlag.value}`] : []),
        ...snapshot.customFeedbackContract.arms.filter((entry) => !entry.present).map((entry) => `arm:${entry.value}`),
        ...(!snapshot.customFeedbackContract.dataPartType.present ? [`partType:${snapshot.customFeedbackContract.dataPartType.value}`] : []),
        ...(!snapshot.customFeedbackContract.systemMessageField.present ? [`partField:${snapshot.customFeedbackContract.systemMessageField.value}`] : []),
        ...(!snapshot.customFeedbackContract.reviewedNodeIdField.present ? [`partField:${snapshot.customFeedbackContract.reviewedNodeIdField.value}`] : []),
        ...(!snapshot.customFeedbackContract.marker.present ? [`marker:${snapshot.customFeedbackContract.marker.value}`] : []),
        ...(!snapshot.customFeedbackContract.telemetryField.present ? [`telemetry:${snapshot.customFeedbackContract.telemetryField.value}`] : []),
        ...(!snapshot.customFeedbackContract.providerMetadataRecognition.present ? [`trustedRecognition:${snapshot.customFeedbackContract.providerMetadataRecognition.value}`] : []),
        ...(!snapshot.customFeedbackContract.leadingPartOrder.present ? [`partOrder:${snapshot.customFeedbackContract.leadingPartOrder.value}`] : []),
        ...Object.entries(snapshot.customFeedbackContract.ui)
          .filter(([, entry]) => !entry.present)
          .map(([key, entry]) => `ui.${key}:${entry.value}`),
      ]
    : []
  if (missingLiveCustomFeedbackContractEvidence.length > 0) {
    issues.push(`Frozen custom-feedback contract absent from live evidence: ${missingLiveCustomFeedbackContractEvidence.join(', ')}`)
  }
  const customFeedbackContractMissingLocally = completedRouteAudited
    ? localCustomFeedbackContractMissing(local.clientSource, agentSource)
    : []
  if (customFeedbackContractMissingLocally.length > 0) {
    issues.push(`Custom-feedback contract missing locally: ${customFeedbackContractMissingLocally.join(', ')}`)
  }

  const publicClientLiteralsMissingLocally = Object.values(snapshot.clientLiterals)
    .filter((entry) => entry.present && !local.clientSource.includes(entry.value))
    .map((entry) => entry.value)
  const missingLiveClientLiteralEvidence = Object.values(snapshot.clientLiterals).filter((entry) => !entry.present).map((entry) => entry.value)
  if (missingLiveClientLiteralEvidence.length > 0) {
    issues.push(`Frozen public client literals absent from live assets: ${missingLiveClientLiteralEvidence.join(', ')}`)
  }
  if (publicClientLiteralsMissingLocally.length > 0) {
    issues.push(`Public Arena client literals missing locally: ${publicClientLiteralsMissingLocally.join(', ')}`)
  }

  const uploadMismatches: string[] = []
  compareStringArray('live upload MIME allowlist', snapshot.upload.allowedMimeTypes, ARENA_PUBLIC_UPLOAD_MIME_TYPES, uploadMismatches)
  compareStringArray('local upload MIME allowlist', local.uploadMimeTypes, ARENA_PUBLIC_UPLOAD_MIME_TYPES, uploadMismatches)
  compareNumber('live per-file upload limit', snapshot.upload.fileBytes, ARENA_PUBLIC_UPLOAD_LIMITS.fileBytes, uploadMismatches)
  compareNumber('live PDF upload limit', snapshot.upload.pdfBytes, ARENA_PUBLIC_UPLOAD_LIMITS.pdfBytes, uploadMismatches)
  compareNumber('live per-turn upload limit', snapshot.upload.turnBytes, ARENA_PUBLIC_UPLOAD_LIMITS.turnBytes, uploadMismatches)
  compareNumber('local per-file upload limit', local.uploadLimits.fileBytes, ARENA_PUBLIC_UPLOAD_LIMITS.fileBytes, uploadMismatches)
  compareNumber('local PDF upload limit', local.uploadLimits.pdfBytes, ARENA_PUBLIC_UPLOAD_LIMITS.pdfBytes, uploadMismatches)
  compareNumber('local per-turn upload limit', local.uploadLimits.turnBytes, ARENA_PUBLIC_UPLOAD_LIMITS.turnBytes, uploadMismatches)
  issues.push(...uploadMismatches)

  const missingLiveCreateChatTransportEvidence = missingContractEvidence(snapshot.createChatTransport.newChat)
  if (missingLiveCreateChatTransportEvidence.length > 0) {
    issues.push(`Frozen New Chat create transport absent from live evidence: ${missingLiveCreateChatTransportEvidence.join(', ')}`)
  }
  const missingLiveSignedUploadTransportEvidence = missingContractEvidence(snapshot.createChatTransport.signedUpload)
  if (missingLiveSignedUploadTransportEvidence.length > 0) {
    issues.push(`Frozen signed-upload transport absent from live evidence: ${missingLiveSignedUploadTransportEvidence.join(', ')}`)
  }
  const missingLiveExistingTurnTransportEvidence = completedRouteAudited
    ? missingContractEvidence(snapshot.createChatTransport.existingTurn)
    : []
  if (missingLiveExistingTurnTransportEvidence.length > 0) {
    issues.push(`Frozen existing-turn transport absent from live evidence: ${missingLiveExistingTurnTransportEvidence.join(', ')}`)
  }

  const localTransportSource = `${local.clientSource}\n${agentSource}`
  const createChatTransportMissingLocally = localCreateChatTransportMissing(localTransportSource)
  if (createChatTransportMissingLocally.length > 0) {
    issues.push(`New Chat create transport missing locally: ${createChatTransportMissingLocally.join(', ')}`)
  }
  const signedUploadTransportMissingLocally = localSignedUploadTransportMissing(localTransportSource)
  if (signedUploadTransportMissingLocally.length > 0) {
    issues.push(`Signed-upload transport missing locally: ${signedUploadTransportMissingLocally.join(', ')}`)
  }
  const existingTurnTransportMissingLocally = completedRouteAudited
    ? localExistingTurnTransportMissing(localTransportSource)
    : []
  if (existingTurnTransportMissingLocally.length > 0) {
    issues.push(`Existing-turn transport missing locally: ${existingTurnTransportMissingLocally.join(', ')}`)
  }

  return {
    passed: issues.length === 0,
    issues,
    activeAgentToolsMissingLocally,
    expectedActiveAgentToolsMissingPublicly,
    unexpectedActiveAgentTools,
    liveActiveAgentSchemaMismatches,
    liveActiveAgentDescriptionMismatches,
    localActiveAgentSchemaMismatches,
    localActiveAgentDescriptionMismatches,
    missingLiveActiveAgentPromptEvidence,
    activeAgentPromptAnchorsMissingLocally,
    liveAgentPromptTemplateMismatches,
    localAgentPromptProjectionMismatches,
    publicToolsMissingLocally,
    localPublicToolArgumentMismatches,
    liveArgumentSchemaMismatches,
    localPublicToolArgumentSchemaMismatches,
    missingPublicResultEvidence,
    missingCommonErrorResultEvidence,
    missingPublicErrorExtensionEvidence,
    publicUiStringsMissingLocally,
    completedUiStringsMissingLocally,
    missingLiveCompletedUiEvidence,
    previewSwitcherMissingLocally,
    missingLivePreviewSwitcherEvidence,
    missingLiveTaskReviewContractEvidence,
    taskReviewContractMissingLocally,
    taskCompletionContractMissingLocally,
    missingLiveTaskCompletionContractEvidence,
    undoContractMissingLocally,
    missingLiveUndoContractEvidence,
    taskCompletionThankYouMissingLocally,
    missingLiveTaskCompletionThankYouEvidence,
    customFeedbackContractMissingLocally,
    missingLiveCustomFeedbackContractEvidence,
    publicClientLiteralsMissingLocally,
    uploadMismatches,
    missingLiveCreateChatTransportEvidence,
    createChatTransportMissingLocally,
    missingLiveSignedUploadTransportEvidence,
    signedUploadTransportMissingLocally,
    missingLiveExistingTurnTransportEvidence,
    existingTurnTransportMissingLocally,
  }
}

function toolHits(text: string): Array<{ name: string; index: number }> {
  return [...text.matchAll(TOOL_NAME_PATTERN)].map((match) => ({ name: match[1], index: match.index }))
}

function extractPromptTemplateContract(
  searchable: ReadonlyArray<ArenaPublicAsset>,
): ArenaPublicContractSnapshot['promptTemplates'] {
  const read = (
    identifier: ArenaPublicPromptTemplateEvidence['identifier'],
  ): ArenaPublicPromptTemplateEvidence & { value?: string } => {
    for (const asset of searchable) {
      const value = extractAssignedJavascriptString(asset.text, identifier)
      if (value !== undefined) {
        return {
          identifier,
          asset: asset.url,
          present: true,
          length: value.length,
          sha256: sha256(value),
          value,
        }
      }
    }
    return { identifier, present: false }
  }
  const agent = read('SYSTEM_PROMPT_TEMPLATE')
  const coding = read('CODING_SYSTEM_PROMPT_TEMPLATE')
  const codingClosedGuidance = read('CODING_CLOSED_SESSION_GUIDANCE')
  const agentProjection = agent.value === undefined ? undefined : renderPublicAgentPromptTemplate(agent.value)
  const codingActiveProjection = coding.value === undefined ? undefined : renderPublicCodingPromptTemplate(coding.value, '')
  const codingClosedProjection = coding.value === undefined || codingClosedGuidance.value === undefined
    ? undefined
    : renderPublicCodingPromptTemplate(coding.value, codingClosedGuidance.value)
  const withoutValue = ({ value: _value, ...evidence }: ArenaPublicPromptTemplateEvidence & { value?: string }) => evidence
  return {
    agent: withoutValue(agent),
    coding: withoutValue(coding),
    codingClosedGuidance: withoutValue(codingClosedGuidance),
    projections: {
      ...(agentProjection === undefined ? {} : { agentSha256: sha256(agentProjection) }),
      ...(codingActiveProjection === undefined ? {} : { codingActiveSha256: sha256(codingActiveProjection) }),
      ...(codingClosedProjection === undefined ? {} : { codingClosedSha256: sha256(codingClosedProjection) }),
    },
  }
}

/** Parse one quoted JavaScript string assignment without evaluating bundle code. */
function extractAssignedJavascriptString(text: string, identifier: string): string | undefined {
  const assignment = `${identifier}=`
  for (let assignmentIndex = text.indexOf(assignment); assignmentIndex >= 0; assignmentIndex = text.indexOf(assignment, assignmentIndex + assignment.length)) {
    const preceding = text[assignmentIndex - 1]
    if (preceding && /[A-Za-z0-9_$]/.test(preceding)) continue
    let index = assignmentIndex + assignment.length
    const quote = text[index]
    if (quote !== '"' && quote !== "'") continue
    index += 1
    let value = ''
    let valid = false
    while (index < text.length) {
      const character = text[index]
      if (character === quote) {
        valid = true
        break
      }
      if (character !== '\\') {
        value += character
        index += 1
        continue
      }
      index += 1
      if (index >= text.length) break
      const escaped = text[index]
      const simpleEscapes: Record<string, string> = {
        n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0',
        '\\': '\\', '"': '"', "'": "'",
      }
      if (escaped in simpleEscapes) {
        value += simpleEscapes[escaped]
        index += 1
        continue
      }
      if (escaped === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(index + 1, index + 3))) {
        value += String.fromCharCode(Number.parseInt(text.slice(index + 1, index + 3), 16))
        index += 3
        continue
      }
      if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
        value += String.fromCharCode(Number.parseInt(text.slice(index + 1, index + 5), 16))
        index += 5
        continue
      }
      if (escaped === '\n') {
        index += 1
        continue
      }
      if (escaped === '\r' && text[index + 1] === '\n') {
        index += 2
        continue
      }
      value += escaped
      index += 1
    }
    if (valid) return value
  }
  return undefined
}

function renderPublicAgentPromptTemplate(template: string): string {
  return replacePromptTemplateValues(template, {
    currentDate: PROMPT_PROJECTION.currentDate,
    timezone: PROMPT_PROJECTION.timezone,
    promptLocationLine: '',
    processToolsSection: '',
    workspaceIgnoredDirNames: ARENA_WORKSPACE_IGNORED_DIR_NAMES.join(', '),
    workspaceIgnoredFilePathSuffixes: ARENA_WORKSPACE_IGNORED_FILE_PATH_SUFFIXES.join(', '),
    maxWorkspaceSnapshotSize: '128 MB',
    maxWorkspaceSnapshotFiles: '10,000',
  })
}

function renderPublicCodingPromptTemplate(template: string, closedSessionGuidance: string): string {
  return replacePromptTemplateValues(template, {
    currentDate: PROMPT_PROJECTION.currentDate,
    timezone: PROMPT_PROJECTION.timezone,
    promptLocationLine: '',
    processToolsSection: '',
    repoOwner: PROMPT_PROJECTION.repoOwner,
    repoName: PROMPT_PROJECTION.repoName,
    baseBranch: PROMPT_PROJECTION.baseBranch,
    baseSha: PROMPT_PROJECTION.baseSha,
    arenaBranch: PROMPT_PROJECTION.arenaBranch,
    cwd: PROMPT_PROJECTION.cwd,
    maxCodingPatchsetArtifactSize: '128 MB',
    maxCodingPatchsetFiles: '10,000',
    closedSessionGuidance,
  })
}

function replacePromptTemplateValues(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (rendered, [name, value]) => rendered.replaceAll(`{{${name}}}`, value),
    template,
  )
}

/**
 * Extracts the completed-route output registry without relying on a webpack
 * module id. The live minified bundle emits a flat object whose values end in
 * `.output`, followed shortly by the aborted terminal-state literal. Requiring
 * both semantic anchor tools and that nearby state avoids unrelated maps.
 */
function extractActiveAgentToolRegistry(
  searchable: ReadonlyArray<ArenaPublicAsset>,
): { asset: string; names: string[] } | undefined {
  const candidates: Array<{ asset: string; names: string[]; distanceToAborted: number }> = []
  const objectPattern = /\{((?:(?:[A-Za-z_$][\w$]*)\s*:\s*(?:[A-Za-z_$][\w$]*\.)+output\s*,?){5,})\}/g
  const propertyPattern = /([A-Za-z_$][\w$]*)\s*:\s*(?:[A-Za-z_$][\w$]*\.)+output\b/g

  for (const asset of searchable) {
    for (const match of asset.text.matchAll(objectPattern)) {
      const names = [...match[1].matchAll(propertyPattern)].map((property) => property[1])
      if (!names.includes('ask_user') || !names.includes('write_file')) continue
      const objectEnd = (match.index ?? 0) + match[0].length
      const boundedTail = asset.text.slice(objectEnd, Math.min(asset.text.length, objectEnd + 5_000))
      const abortedMatch = /status\s*:\s*["']aborted["']/.exec(boundedTail)
      if (!abortedMatch) continue
      candidates.push({ asset: asset.url, names, distanceToAborted: abortedMatch.index })
    }
  }

  return candidates.sort((left, right) =>
    right.names.length - left.names.length || left.distanceToAborted - right.distanceToAborted,
  )[0]
}

/**
 * Reconstructs a reviewable active-tool projection only after the public
 * completed-route assets contain evidence for every provider field, required
 * marker, enum/default/limit, and description fragment in that projection.
 * The emitted schema remains JSON Schema (the actual provider surface), while
 * missing evidence stays explicit instead of being silently filled in.
 */
function extractActiveAgentToolContracts(
  searchable: ReadonlyArray<ArenaPublicAsset>,
  definitions: readonly ToolDefinition[],
): ArenaPublicContractSnapshot['activeAgentToolContracts'] {
  const contracts: ArenaPublicContractSnapshot['activeAgentToolContracts'] = {}
  const combinedPublicSource = searchable.map((asset) => asset.text).join('\n')
  for (const definition of definitions) {
    const schema = definition.function.parameters
    const missingSchemaEvidence = activeSchemaEvidenceMissing(combinedPublicSource, schema)
    const missingDescriptionEvidence = stableEvidenceFragments(definition.function.description)
      .filter((fragment) => !containsEscapedEvidence(combinedPublicSource, fragment))
    const sourceAsset = searchable.find((asset) => {
      const firstField = Object.keys(isRecord(schema.properties) ? schema.properties : {})[0]
      return firstField ? propertyAppears(asset.text, firstField) : asset.text.includes('compactionToolDef')
    })
    const schemaObserved = missingSchemaEvidence.length === 0
    const descriptionObserved = missingDescriptionEvidence.length === 0
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : []
    contracts[definition.function.name] = {
      asset: sourceAsset?.url,
      argumentFields: Object.keys(properties),
      requiredFields: required,
      ...(schemaObserved ? {
        schema,
        schemaSha256: sha256(JSON.stringify(schema)),
      } : {}),
      ...(descriptionObserved ? {
        description: definition.function.description,
        descriptionSha256: sha256(definition.function.description),
      } : {}),
      missingSchemaEvidence,
      missingDescriptionEvidence,
    }
  }
  return contracts
}

function activeSchemaEvidenceMissing(text: string, schema: Record<string, unknown>): string[] {
  const missing: string[] = []
  const visit = (value: unknown, path: string) => {
    if (!isRecord(value)) return
    const properties = isRecord(value.properties) ? value.properties : undefined
    if (properties) {
      for (const [name, property] of Object.entries(properties)) {
        if (!propertyAppears(text, name)) missing.push(`${path}.${name}:field`)
        visit(property, `${path}.${name}`)
      }
    }
    if (isRecord(value.items)) visit(value.items, `${path}[]`)
    if (Array.isArray(value.enum)) {
      for (const item of value.enum) {
        if (!primitiveEvidenceAppears(text, item)) missing.push(`${path}:enum:${String(item)}`)
      }
    }
    for (const key of ['default', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
      if (!(key in value)) continue
      if (!primitiveEvidenceAppears(text, value[key])) missing.push(`${path}:${key}:${String(value[key])}`)
    }
    if (typeof value.description === 'string') {
      for (const fragment of stableEvidenceFragments(value.description)) {
        if (!containsEscapedEvidence(text, fragment)) missing.push(`${path}:description:${fragment}`)
      }
    }
  }
  visit(schema, 'input')
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : []
  for (const name of required) {
    if (!propertyAppears(text, name)) missing.push(`input.${name}:required`)
  }
  return [...new Set(missing)]
}

function stableEvidenceFragments(value: string): string[] {
  const candidates = value
    .split(/\n+|[:;]|\d+(?:[,.]\d+)*|'[^']*'|`[^`]*`/)
    .map((fragment) => fragment.trim())
    .map((fragment) => fragment.replace(/^.*?['"]\.\s+/, '').trim())
    .filter((fragment) => fragment.length >= 24)
    .filter((fragment) => (fragment.match(/,/g)?.length ?? 0) < 3)
    .flatMap((fragment) => fragment.length <= 180
      ? [fragment]
      : [fragment.slice(0, 120).trim(), fragment.slice(-120).trim()])
  const unique = [...new Set(candidates)]
  if (unique.length > 0) return unique.slice(0, 16)
  return value.trim() ? [value.trim()] : []
}

function containsEscapedEvidence(text: string, value: string): boolean {
  if (text.includes(value)) return true
  const escaped = JSON.stringify(value).slice(1, -1)
  if (text.includes(escaped)) return true
  const javascriptEscaped = escaped.replaceAll("'", "\\'").replaceAll('`', '\\`')
  return text.includes(javascriptEscaped)
}

function primitiveEvidenceAppears(text: string, value: unknown): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return numericLiteralAppears(text, value)
  if (typeof value === 'string') return containsEscapedEvidence(text, value)
  if (value === true) return text.includes('true') || text.includes('!0')
  if (value === false) return text.includes('false') || text.includes('!1')
  if (value === null) return text.includes('null')
  return false
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stringEvidence(searchable: ReadonlyArray<ArenaPublicAsset>, value: string): { present: boolean; assets: string[] } {
  const assets = searchable.filter((asset) => asset.text.includes(value)).map((asset) => asset.url)
  return { present: assets.length > 0, assets }
}

function scopedAssetsAround(
  assets: ReadonlyArray<ArenaPublicAsset>,
  anchor: string,
  before: number,
  after: number,
): ArenaPublicAsset[] {
  return assets.flatMap((asset) => {
    const scopes: ArenaPublicAsset[] = []
    for (let index = asset.text.indexOf(anchor); index >= 0; index = asset.text.indexOf(anchor, index + anchor.length)) {
      scopes.push({
        url: asset.url,
        text: asset.text.slice(Math.max(0, index - before), Math.min(asset.text.length, index + anchor.length + after)),
      })
    }
    return scopes
  })
}

function contractEvidence(
  searchable: ReadonlyArray<ArenaPublicAsset>,
  value: string,
  appears: (text: string) => boolean,
): ArenaPublicContractEvidence {
  const assets = [...new Set(searchable.filter((asset) => appears(asset.text)).map((asset) => asset.url))]
  return { value, present: assets.length > 0, assets }
}

function newChatImageBeforeTextAppears(text: string): boolean {
  const endpointIndex = text.indexOf(ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.endpoint)
  if (endpointIndex < 0) return false
  const prefix = text.slice(0, endpointIndex)
  const imageFilterMatches = [...prefix.matchAll(/mediaType\.startsWith\(["']image\/["']\)/g)]
  const imageFilterIndex = imageFilterMatches.at(-1)?.index ?? -1
  if (imageFilterIndex < 0) return false
  const filePartMatch = /type\s*:\s*["']file["']/.exec(prefix.slice(imageFilterIndex))
  if (!filePartMatch) return false
  const filePartIndex = imageFilterIndex + filePartMatch.index
  const textPartMatch = /type\s*:\s*["']text["']/.exec(prefix.slice(filePartIndex))
  return Boolean(textPartMatch)
}

function previewSwitcherViewAppears(text: string, value: string, label: string): boolean {
  const labelLiterals = [
    `"aria-label":${JSON.stringify(label)}`,
    `children:${JSON.stringify(label)}`,
  ]
  for (const labelLiteral of labelLiterals) {
    for (let labelIndex = text.indexOf(labelLiteral); labelIndex >= 0; labelIndex = text.indexOf(labelLiteral, labelIndex + labelLiteral.length)) {
      const componentSlice = text.slice(Math.max(0, labelIndex - 800), Math.min(text.length, labelIndex + 300))
      if (componentSlice.includes(JSON.stringify(value))) return true
    }
  }
  return false
}

function localPreviewSwitcherViewAppears(source: string, value: string, label: string): boolean {
  const localMode = value === 'preview' ? 'rendered' : value === 'raw' ? 'source' : value
  return source.includes(`aria-label="${label}"`)
    && source.includes(`aria-pressed={previewMode === '${localMode}'}`)
    && source.includes(`setPreviewMode('${localMode}')`)
}

function taskReviewActionAppears(text: string, action: string, labelKey: string): boolean {
  return text.includes(`action:${JSON.stringify(action)},labelKey:${JSON.stringify(labelKey)}`)
}

function taskReviewDismissAppears(text: string): boolean {
  return text.includes('Close review panel') && text.includes('"Escape"') && text.includes('("escape")')
}

function taskReviewTransportAppears(text: string): boolean {
  return text.includes('review-feedback')
    && /"check_in"===[\w$.]+\.feedback\.type\?\{\.\.\.[\w$]+,action:[\w$.]+\.feedback\.value\}:\{\.\.\.[\w$]+,feedback:[\w$.]+\.feedback\}/.test(text)
}

function localTaskReviewTransportAppears(text: string): boolean {
  const endpointIndex = text.indexOf('/review-feedback')
  if (endpointIndex < 0) return false
  const segment = text.slice(endpointIndex, endpointIndex + 700)
  return segment.includes('sessionNodeId')
    && segment.includes('recaptchaV3Token')
    && /\baction\b/.test(segment)
    && !segment.slice(0, segment.indexOf('action')).includes('feedback: { type: \'task_completion_bar\'')
}

function taskCompletionActionAppears(text: string, value: string, labelKey: string): boolean {
  return text.includes(`value:${JSON.stringify(value)},label:${JSON.stringify(labelKey)}`)
    || text.includes(`value:${JSON.stringify(value)},labelKey:${JSON.stringify(labelKey)}`)
}

function undoTransportAppears(text: string): boolean {
  return /type\s*:\s*["']undo["']/.test(text)
    && text.includes('sessionNodeId')
    && text.includes('recaptchaV3Token')
}

function taskCompletionThankYouPhaseAppears(text: string, phase: 'in' | 'out'): boolean {
  if (!text.includes(ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.text)) return false
  if (phase === 'in') return /[\w$.]+\(["']in["']\)/.test(text)
  return /setTimeout\(\(\)=>[\w$.]+\(["']out["']\),(?:2e3|2000)\)/.test(text)
}

function taskCompletionThankYouTimingAppears(text: string, milliseconds: number): boolean {
  if (!text.includes(ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.text)) return false
  if (milliseconds === 2_000) return /setTimeout\(\(\)=>[\w$.]+\(["']out["']\),(?:2e3|2000)\)/.test(text)
  return /setTimeout\(\(\)=>[\w$.]+\(null\),200\)/.test(text)
}

function localUndoContractAppears(text: string): boolean {
  const endpointIndex = text.indexOf('/action')
  if (endpointIndex < 0) return false
  const segment = text.slice(endpointIndex, endpointIndex + 900)
  return Object.values(ARENA_PUBLIC_UNDO_CONTRACT)
    .filter((value) => typeof value === 'string' && !['data-compaction', 'checkpointApplied'].includes(value))
    .every((value) => text.includes(value))
    && /type\s*:\s*["']undo["']/.test(segment)
    && segment.includes('sessionNodeId')
    && segment.includes('recaptchaV3Token')
    && text.includes('context.compacted')
}

function localTaskCompletionThankYouAppears(text: string): boolean {
  return text.includes(ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.text)
    && text.includes(ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.excludedArm)
    && /setTimeout\([\s\S]{0,180}(?:2_000|2000)/.test(text)
    && /setTimeout\([\s\S]{0,180}200/.test(text)
    && text.includes("'in'")
    && text.includes("'out'")
}

function customFeedbackFeatureGateAppears(text: string): boolean {
  const flag = ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.featureFlag
  for (let index = text.indexOf(flag); index >= 0; index = text.indexOf(flag, index + flag.length)) {
    const segment = text.slice(Math.max(0, index - 700), Math.min(text.length, index + flag.length + 700))
    if (segment.includes('customFeedbackArm') && /\?\s*[A-Za-z_$][\w$]*\s*:\s*null/.test(segment)) return true
  }
  return false
}

function customFeedbackTreatmentAppears(text: string, treatment: string): boolean {
  return text.includes(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.featureFlag)
    && text.includes(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.dataPartType)
    && text.includes(treatment)
}

function customFeedbackDataPartAppears(text: string): boolean {
  const type = ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.dataPartType
  for (let index = text.indexOf(type); index >= 0; index = text.indexOf(type, index + type.length)) {
    const segment = text.slice(Math.max(0, index - 450), Math.min(text.length, index + type.length + 750))
    if (/type\s*:\s*["']data-custom-feedback["']\s*,\s*data\s*:\s*\{/.test(segment)
      && propertyAppears(segment, ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.systemMessageField)
      && propertyAppears(segment, ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.reviewedNodeIdField)) return true
  }
  return false
}

function customFeedbackUiStringAppears(text: string, value: string): boolean {
  return text.includes(value)
    && text.includes(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.featureFlag)
    && text.includes(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.dataPartType)
}

function customFeedbackProviderMetadataRecognitionAppears(text: string): boolean {
  const pattern = /providerMetadata[\s\S]{0,220}\?\.arena\?\.systemMessage\s*===\s*(?:!0|true)/
  return pattern.test(text)
    && text.includes(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker)
    && text.includes(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.dataPartType)
}

function customFeedbackTelemetryAppears(text: string): boolean {
  const field = ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.telemetryField
  for (let index = text.indexOf(field); index >= 0; index = text.indexOf(field, index + field.length)) {
    const segment = text.slice(Math.max(0, index - 700), Math.min(text.length, index + field.length + 250))
    if (segment.includes('chat_submit')) return true
  }
  return false
}

function customFeedbackLeadingPartOrderAppears(text: string): boolean {
  return /has_feedback:([A-Za-z_$][\w$]*)[\s\S]{0,500}?([A-Za-z_$][\w$]*)=\1&&([A-Za-z_$][\w$]*)\?\[[\s\S]{0,160}?\(\3\)\]:\[\][\s\S]{0,400}?parts:\[\.\.\.\2,\.\.\.[A-Za-z_$][\w$]*,\.\.\.[A-Za-z_$][\w$]*\]/.test(text)
}

function missingContractEvidence<T extends object>(group: T): string[] {
  return Object.entries(group as Record<string, ArenaPublicContractEvidence>)
    .filter(([, evidence]) => !evidence.present)
    .map(([key, evidence]) => `${key}:${evidence.value}`)
}

function localCreateChatTransportMissing(source: string): string[] {
  const contract = ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat
  const endpointIndex = source.indexOf(contract.endpoint)
  const functionIndex = endpointIndex < 0 ? -1 : source.lastIndexOf('async function createAgentChat', endpointIndex)
  const segment = endpointIndex < 0
    ? ''
    : source.slice(functionIndex >= 0 ? functionIndex : Math.max(0, endpointIndex - 1_200), Math.min(source.length, endpointIndex + 2_500))
  const checks: Array<[string, boolean]> = [
    [`endpoint:${contract.endpoint}`, endpointIndex >= 0 && source.includes(`app.post('${contract.endpoint}'`)],
    [`requestMethod:${contract.requestMethod}`, /method\s*:\s*["']POST["']/.test(segment)],
    [`responseId:${contract.responseId}`, segment.includes('return result.id') && source.includes('json({ id: session.summary.id })')],
    [`messageId:${contract.messageId}`, /id\s*:\s*generateUuidV7\(\)/.test(segment)
      && /bytes\[6\]\s*=[\s\S]{0,80}0x70/.test(source)
      && /bytes\[8\]\s*=[\s\S]{0,80}0x80/.test(source)
      && source.includes('UUID_V7_PATTERN')],
    [`messageRole:${contract.messageRole}`, /role\s*:\s*["']user["']/.test(segment)],
    [`messageParts:${contract.messageParts}`, localPropertyAppears(segment, 'parts')],
    [`messageMetadata:${contract.messageMetadata}`, localPropertyAppears(segment, 'metadata') && localPropertyAppears(segment, 'uploads')],
    [`recaptchaV2Token:${contract.recaptchaV2Token}`, source.includes(contract.recaptchaV2Token)],
    [`recaptchaV3Token:${contract.recaptchaV3Token}`, segment.includes(contract.recaptchaV3Token)],
    [`timezone:${contract.timezone}`, localPropertyAppears(segment, contract.timezone)],
    [`modelId:${contract.modelId}`, localPropertyAppears(segment, contract.modelId)],
    [`partOrder:${contract.partOrder}`, /const\s+parts\s*=\s*\[\s*\.\.\.imageParts,[\s\S]{0,220}?type\s*:\s*["']text["']/.test(segment)
      && source.includes('create-chat file parts must precede text')
      && source.includes('create-chat text must be the last message part')],
    [`excludesExistingTurnEnvelope:${contract.excludesExistingTurnEnvelope}`, endpointIndex >= 0 && !/\bv2Source\s*:/.test(segment)],
  ]
  return checks.filter(([, present]) => !present).map(([label]) => label)
}

function localSignedUploadTransportMissing(source: string): string[] {
  const contract = ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload
  const endpointIndex = source.indexOf(contract.endpoint)
  const segment = endpointIndex < 0
    ? ''
    : source.slice(Math.max(0, endpointIndex - 900), Math.min(source.length, endpointIndex + 3_800))
  const checks: Array<[string, boolean]> = [
    [`endpoint:${contract.endpoint}`, endpointIndex >= 0 && source.includes(`app.post('${contract.endpoint}'`)],
    [`requestMethod:${contract.requestMethod}`, /method\s*:\s*["']POST["']/.test(segment)],
    [`requestHash:${contract.requestHash}`, localPropertyAppears(segment, 'hash')],
    [`requestContentType:${contract.requestContentType}`, localPropertyAppears(segment, 'contentType')],
    [`requestSize:${contract.requestSize}`, localPropertyAppears(segment, 'size')],
    [`responseUploadUrl:${contract.responseUploadUrl}`, localPropertyAppears(segment, 'uploadUrl')],
    [`responseKey:${contract.responseKey}`, localPropertyAppears(segment, 'key')],
    [`binaryUploadMethod:${contract.binaryUploadMethod}`, /method\s*:\s*["']PUT["']/.test(segment)],
    [`hashEncoding:${contract.hashEncoding}`, /crypto\.subtle\.digest\(["']SHA-256["']/.test(source)
      && source.includes("replaceAll('+', '-')")
      && source.includes("replaceAll('/', '_')")],
    [`casUserPath:${contract.casUserPath}`, source.includes('/api/chat/workspace/cas/user/${hash}')
      && source.includes("app.get('/api/chat/workspace/cas/user/:hash'")],
  ]
  return checks.filter(([, present]) => !present).map(([label]) => label)
}

function localExistingTurnTransportMissing(source: string): string[] {
  const contract = ARENA_PUBLIC_CREATE_CHAT_CONTRACT.existingTurn
  const transportIndex = source.indexOf('function arenaAgentMessageTransport')
  const transport = transportIndex < 0 ? '' : source.slice(transportIndex, transportIndex + 4_200)
  const createEndpointIndex = source.indexOf(ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.endpoint)
  const createSegment = createEndpointIndex < 0 ? '' : source.slice(createEndpointIndex, createEndpointIndex + 2_500)
  const checks: Array<[string, boolean]> = [
    [`message:${contract.message}`, /return\s*\{[\s\S]{0,120}?message\s*,/.test(transport)],
    [`metadata:${contract.metadata}`, /metadata\s*:\s*\{[\s\S]{0,160}?timezone/.test(transport)],
    [`timezone:${contract.timezone}`, localPropertyAppears(transport, contract.timezone)],
    [`submissionSource:${contract.submissionSource}`, transport.includes("submissionSource: 'chat_input'")],
    [`v2Source:${contract.v2Source}`, transport.includes("v2Source: 'agentic_chat_submit'")],
    [`branchDistinct:${contract.branchDistinct}`, transport.includes("v2Source: 'agentic_chat_submit'")
      && createEndpointIndex >= 0
      && !/\bv2Source\s*:/.test(createSegment)],
  ]
  return checks.filter(([, present]) => !present).map(([label]) => label)
}

function localPropertyAppears(text: string, property: string): boolean {
  if (propertyAppears(text, property)) return true
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b\\s*(?:[,}])`).test(text)
}

function localCustomFeedbackContractMissing(clientSource: string, agentSource: string): string[] {
  const missing: string[] = []
  for (const arm of ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.arms) {
    if (!clientSource.includes(arm)) missing.push(`arm:${arm}`)
  }
  for (const [key, value] of Object.entries(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.ui)) {
    if (!clientSource.includes(value)) missing.push(`ui.${key}:${value}`)
  }
  if (!clientSource.includes(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.reviewedNodeIdField)) {
    missing.push(`correlation:${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.reviewedNodeIdField}`)
  }
  if (!localCustomFeedbackRequestTransportAppears(clientSource)) {
    missing.push('requestTransport:message.parts + metadata.submissionSource=chat_input + v2Source=agentic_chat_submit')
  }
  if (!agentSource.includes(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker)) {
    missing.push(`marker:${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker}`)
  }
  if (!agentSource.includes(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.telemetryField)) {
    missing.push(`telemetry:${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.telemetryField}`)
  }
  if (!localCustomFeedbackLeadingOrderAppears(agentSource)) {
    missing.push(`partOrder:${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.leadingPartOrder}`)
  }
  return missing
}

function localCustomFeedbackRequestTransportAppears(text: string): boolean {
  const transportIndex = text.indexOf('function arenaAgentMessageTransport')
  if (transportIndex < 0 || !text.includes(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker)) return false
  const transport = text.slice(transportIndex, transportIndex + 4_000)
  const customPartIndex = transport.indexOf("type: 'data-custom-feedback'")
  return transport.includes('message,')
    && transport.includes("submissionSource: 'chat_input'")
    && transport.includes("v2Source: 'agentic_chat_submit'")
    && transport.includes('parts: [...customFeedbackParts, ...imageParts, ...textParts]')
    && customPartIndex >= 0
    && transport.includes('systemMessage: ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE')
    && transport.includes('reviewedNodeId')
}

function localCustomFeedbackLeadingOrderAppears(text: string): boolean {
  const projectionIndex = text.indexOf('projectArenaCustomFeedbackMessageForModel')
  if (projectionIndex < 0) return false
  const projection = text.slice(projectionIndex, projectionIndex + 1_200)
  const markerIndex = projection.indexOf('ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE')
  const contentIndex = projection.indexOf('projectArenaUserMessageForModel')
  if (markerIndex < 0 || contentIndex <= markerIndex) return false

  for (let index = text.indexOf('arena_system_messages: ['); index >= 0; index = text.indexOf('arena_system_messages: [', index + 1)) {
    const segment = text.slice(index, index + 650)
    const customIndex = segment.indexOf("kind: 'custom_feedback'")
    const attachmentIndex = segment.indexOf("kind: 'attachments'")
    if (customIndex >= 0 && attachmentIndex > customIndex
      && segment.includes("position: 'leading'")
      && segment.includes("position: 'trailing'")
      && segment.includes('reviewedNodeId')) return true
  }
  return false
}

function extractArgumentFields(source: string, segment: string, absoluteIndex: number): string[] {
  const argsIndex = segment.indexOf('args:')
  if (argsIndex < 0) return []
  const resultIndex = segment.indexOf(',result:', argsIndex)
  const expression = segment.slice(argsIndex + 5, resultIndex >= 0 ? resultIndex : undefined)
  const objectCall = expression.indexOf('.object(')
  if (objectCall >= 0) {
    const objectStart = expression.indexOf('{', objectCall)
    if (objectStart >= 0) {
      const objectEnd = findBalancedEnd(expression, objectStart, '{', '}')
      if (objectEnd >= 0) return extractTopLevelObjectKeys(expression.slice(objectStart, objectEnd + 1))
    }
  }
  if (/^[\w$.]+$/.test(expression.trim())) {
    const reference = expression.trim()
    const assignment = source.lastIndexOf(`${reference}=` , absoluteIndex)
    if (assignment >= 0) {
      const objectStart = source.indexOf('{', source.indexOf('.object(', assignment))
      const objectEnd = objectStart >= 0 ? findBalancedEnd(source, objectStart, '{', '}') : -1
      if (objectStart >= 0 && objectEnd >= 0 && objectStart < absoluteIndex) {
        return extractTopLevelObjectKeys(source.slice(objectStart, objectEnd + 1))
      }
    }
  }
  return []
}

function extractArgumentSchema(
  source: string,
  segment: string,
  absoluteIndex: number,
): ArenaPublicArgumentSchemaNode | undefined {
  const argsIndex = segment.indexOf('args:')
  if (argsIndex < 0) return undefined
  const resultIndex = segment.indexOf(',result:', argsIndex)
  const expression = segment.slice(argsIndex + 5, resultIndex >= 0 ? resultIndex : undefined).trim()
  return parseZodArgumentExpression(source, expression, absoluteIndex, new Set())
}

function parseZodArgumentExpression(
  source: string,
  rawExpression: string,
  beforeIndex: number,
  resolving: Set<string>,
): ArenaPublicArgumentSchemaNode | undefined {
  const expression = rawExpression.trim()
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(expression) && !/\.z$/.test(expression)) {
    if (resolving.has(expression)) return undefined
    const resolved = resolveZodReference(source, expression, beforeIndex)
    if (!resolved) return undefined
    const nextResolving = new Set(resolving)
    nextResolving.add(expression)
    return parseZodArgumentExpression(source, resolved, beforeIndex, nextResolving)
  }

  const constructor = expression.match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(object|string|number|boolean|array|enum|literal|union|preprocess)\(/)
  if (!constructor) return undefined
  const kind = constructor[1]
  const open = constructor[0].length - 1
  const close = findBalancedEnd(expression, open, '(', ')')
  if (close < 0) return undefined
  const argument = expression.slice(open + 1, close)
  const chain = expression.slice(close + 1)
  let node: ArenaPublicArgumentSchemaNode | undefined

  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    node = { type: kind }
  } else if (kind === 'enum') {
    const values = parsePrimitiveArray(argument)
    if (!values) return undefined
    node = { type: 'enum', enum: values }
  } else if (kind === 'literal') {
    const literal = parsePrimitive(argument)
    if (!isArgumentPrimitive(literal)) return undefined
    node = { type: 'literal', literal }
  } else if (kind === 'array') {
    const items = parseZodArgumentExpression(source, argument, beforeIndex, resolving)
    if (!items) return undefined
    node = { type: 'array', items }
  } else if (kind === 'object') {
    const properties = parseZodObjectProperties(source, argument, beforeIndex, resolving)
    if (!properties) return undefined
    node = { type: 'object', properties }
  } else if (kind === 'union') {
    const trimmed = argument.trim()
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
    const variants = splitTopLevel(trimmed.slice(1, -1)).map((part) => (
      parseZodArgumentExpression(source, part, beforeIndex, resolving)
    ))
    if (variants.some((variant) => !variant)) return undefined
    const literals = variants.map((variant) => variant?.type === 'literal' ? variant.literal : undefined)
    if (literals.some((literal) => literal === undefined)) return undefined
    node = { type: 'enum', enum: literals as ArenaPublicArgumentPrimitive[] }
  } else if (kind === 'preprocess') {
    const parts = splitTopLevel(argument)
    if (parts.length !== 2) return undefined
    node = parseZodArgumentExpression(source, parts[1], beforeIndex, resolving)
    if (!node) return undefined
    if (/typeof\s+\w+\s*\?\s*String\(|"number"==typeof\s+\w+\?String\(/.test(parts[0])) {
      node.preprocess = 'number_to_string'
    }
  }

  if (!node) return undefined
  if (/\.optional\(\)/.test(chain)) node.optional = true
  if (/\.passthrough\(\)/.test(chain)) node.passthrough = true
  const defaultValue = parseChainedPrimitive(chain, 'default')
  if (defaultValue !== undefined) {
    if (!isArgumentPrimitive(defaultValue)) return undefined
    node.default = defaultValue
    node.optional = true
  }
  const catchValue = parseChainedPrimitive(chain, 'catch')
  if (catchValue !== undefined) node.catch = catchValue
  return node
}

function parseZodObjectProperties(
  source: string,
  rawObject: string,
  beforeIndex: number,
  resolving: Set<string>,
): Record<string, ArenaPublicArgumentSchemaNode> | undefined {
  const trimmed = rawObject.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
  const properties: Record<string, ArenaPublicArgumentSchemaNode> = {}
  for (const entry of splitTopLevel(trimmed.slice(1, -1))) {
    if (!entry.trim()) continue
    const colon = findTopLevelColon(entry)
    if (colon < 0) return undefined
    const key = parseObjectKey(entry.slice(0, colon))
    const value = parseZodArgumentExpression(source, entry.slice(colon + 1), beforeIndex, resolving)
    if (!key || !value) return undefined
    properties[key] = value
  }
  return properties
}

function resolveZodReference(source: string, reference: string, beforeIndex: number): string | undefined {
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?:^|[;,])${escaped}=`, 'g')
  let assignment: RegExpExecArray | null
  let last: RegExpExecArray | undefined
  const prefix = source.slice(0, beforeIndex)
  while ((assignment = pattern.exec(prefix))) last = assignment
  if (!last) return undefined
  const start = (last.index ?? 0) + last[0].length
  const end = findTopLevelSeparator(source, start)
  return source.slice(start, end < 0 ? beforeIndex : end)
}

function findTopLevelSeparator(source: string, start: number): number {
  let round = 0
  let square = 0
  let curly = 0
  let quote: string | undefined
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '(') round += 1
    else if (char === ')') round -= 1
    else if (char === '[') square += 1
    else if (char === ']') square -= 1
    else if (char === '{') curly += 1
    else if (char === '}') curly -= 1
    else if ((char === ',' || char === ';') && round === 0 && square === 0 && curly === 0) return index
  }
  return -1
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = []
  let start = 0
  let round = 0
  let square = 0
  let curly = 0
  let quote: string | undefined
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '(') round += 1
    else if (char === ')') round -= 1
    else if (char === '[') square += 1
    else if (char === ']') square -= 1
    else if (char === '{') curly += 1
    else if (char === '}') curly -= 1
    else if (char === ',' && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(source.slice(start).trim())
  return parts
}

function findTopLevelColon(source: string): number {
  let round = 0
  let square = 0
  let curly = 0
  let quote: string | undefined
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '(') round += 1
    else if (char === ')') round -= 1
    else if (char === '[') square += 1
    else if (char === ']') square -= 1
    else if (char === '{') curly += 1
    else if (char === '}') curly -= 1
    else if (char === ':' && round === 0 && square === 0 && curly === 0) return index
  }
  return -1
}

function parseObjectKey(raw: string): string | undefined {
  const key = raw.trim()
  if (/^[A-Za-z_$][\w$-]*$/.test(key)) return key
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    try {
      return key.startsWith('"') ? JSON.parse(key) as string : key.slice(1, -1)
    } catch {
      return undefined
    }
  }
  return undefined
}

function parsePrimitiveArray(raw: string): ArenaPublicArgumentPrimitive[] | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
  const values = splitTopLevel(trimmed.slice(1, -1)).map(parsePrimitive)
  return values.some((value) => value === undefined) ? undefined : values as ArenaPublicArgumentPrimitive[]
}

function parsePrimitive(raw: string): ArenaPublicArgumentPrimitive | Record<string, ArenaPublicArgumentPrimitive> | undefined {
  const value = raw.trim()
  if (value === 'null') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value)
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown
      return typeof parsed === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  if (value.startsWith('{') && value.endsWith('}')) {
    const record: Record<string, ArenaPublicArgumentPrimitive> = {}
    for (const entry of splitTopLevel(value.slice(1, -1))) {
      const colon = findTopLevelColon(entry)
      if (colon < 0) return undefined
      const key = parseObjectKey(entry.slice(0, colon))
      const item = parsePrimitive(entry.slice(colon + 1))
      if (!key || item === undefined || (typeof item === 'object' && item !== null)) return undefined
      record[key] = item
    }
    return record
  }
  return undefined
}

function parseChainedPrimitive(
  chain: string,
  method: 'default' | 'catch',
): ArenaPublicArgumentPrimitive | Record<string, ArenaPublicArgumentPrimitive> | undefined {
  const start = chain.indexOf(`.${method}(`)
  if (start < 0) return undefined
  const open = start + method.length + 1
  const close = findBalancedEnd(chain, open, '(', ')')
  if (close < 0) return undefined
  return parsePrimitive(chain.slice(open + 1, close))
}

function extractTopLevelObjectKeys(objectLiteral: string): string[] {
  const keys: string[] = []
  let depth = 0
  let quote: string | undefined
  let escaped = false
  for (let index = 0; index < objectLiteral.length; index += 1) {
    const char = objectLiteral[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (depth === 1 && index > 0 && ['{', ','].includes(objectLiteral[index - 1])) {
      const match = objectLiteral.slice(index).match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*)):/)
      if (match) {
        keys.push(match[1] ?? match[2] ?? match[3])
        index += match[0].length - 1
        continue
      }
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') depth -= 1
  }
  return keys
}

function findBalancedEnd(source: string, start: number, open: string, close: string): number {
  let depth = 0
  let quote: string | undefined
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === open) depth += 1
    if (char === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function extractMimeArray(text: string): string[] {
  let best: string[] = []
  for (const match of text.matchAll(/\[("(?:image|text|application)\/[^"]+"(?:,"(?:image|text|application)\/[^"]+"){4,})\]/g)) {
    try {
      const values = JSON.parse(`[${match[1]}]`) as unknown
      if (!Array.isArray(values) || !values.every((value) => typeof value === 'string' && MIME_PATTERN.test(value))) continue
      if (!values.includes('application/pdf')) continue
      if (values.length > best.length) best = values
    } catch {
      // A malformed minified literal is not contract evidence.
    }
  }
  return best
}

function propertyAppears(text: string, property: string): boolean {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:[{,]|\\b)(?:"${escaped}"|'${escaped}'|${escaped}):`).test(text)
}

function numericLiteralAppears(text: string, value: number): boolean {
  const decimal = String(value)
  const hex = `0x${value.toString(16)}`
  if (new RegExp(`(?:^|[^0-9A-Fa-fx])(?:${decimal}|${hex})(?:$|[^0-9A-Fa-f])`, 'i').test(text)) return true
  for (const match of text.matchAll(/(?:^|[^\w$.])(-?(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?))(?![\w.])/gi)) {
    if (Number(match[1]) === value) return true
  }
  return false
}

function extractDeploymentId(assetUrls: readonly string[], pageHtml: string): string | undefined {
  for (const assetUrl of assetUrls) {
    const value = new URL(assetUrl).searchParams.get('dpl')
    if (value) return value
  }
  return pageHtml.match(/\bdpl_[A-Za-z0-9]+\b/)?.[0]
}

function comparableArgumentSchema(node: ArenaPublicArgumentSchemaNode): ArenaPublicArgumentSchemaNode {
  const comparable: ArenaPublicArgumentSchemaNode = {
    type: node.type,
    ...(node.optional ? { optional: true } : {}),
    ...(node.enum ? { enum: [...node.enum] } : {}),
    ...(node.literal !== undefined ? { literal: node.literal } : {}),
    ...(node.default !== undefined ? { default: node.default } : {}),
    ...(node.passthrough ? { passthrough: true } : {}),
  }
  if (node.items) comparable.items = comparableArgumentSchema(node.items)
  if (node.properties) {
    comparable.properties = Object.fromEntries(Object.entries(node.properties).map(([name, property]) => [
      name,
      comparableArgumentSchema(property),
    ]))
  }
  return comparable
}

function localArgumentSchema(raw: Record<string, unknown>, optional = false): ArenaPublicArgumentSchemaNode {
  const schema = raw as {
    type?: unknown
    enum?: unknown
    default?: unknown
    properties?: unknown
    required?: unknown
    additionalProperties?: unknown
    items?: unknown
  }
  const optionalProjection = optional ? { optional: true as const } : {}
  const defaultProjection = isArgumentPrimitive(schema.default) ? { default: schema.default } : {}
  if (Array.isArray(schema.enum) && schema.enum.every(isArgumentPrimitive)) {
    return { type: 'enum', enum: schema.enum, ...optionalProjection, ...defaultProjection }
  }
  if (schema.type === 'string' || schema.type === 'boolean' || schema.type === 'number' || schema.type === 'integer') {
    return {
      type: schema.type === 'integer' ? 'number' : schema.type,
      ...optionalProjection,
      ...defaultProjection,
    }
  }
  if (schema.type === 'array') {
    return {
      type: 'array',
      items: localArgumentSchema(isRecord(schema.items) ? schema.items : {}),
      ...optionalProjection,
      ...defaultProjection,
    }
  }
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [])
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(properties).map(([name, property]) => [
      name,
      localArgumentSchema(isRecord(property) ? property : {}, !required.has(name)),
    ])),
    ...(schema.additionalProperties === true ? { passthrough: true as const } : {}),
    ...optionalProjection,
    ...defaultProjection,
  }
}

function isArgumentPrimitive(value: unknown): value is ArenaPublicArgumentPrimitive {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function schemasEqual(left: ArenaPublicArgumentSchemaNode, right: ArenaPublicArgumentSchemaNode): boolean {
  return JSON.stringify(sortSchemaValue(left)) === JSON.stringify(sortSchemaValue(right))
}

function sortSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortSchemaValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortSchemaValue(value[key])]))
}

function compareStringArray(label: string, actual: readonly string[], expected: readonly string[], issues: string[]): void {
  if (!arraysEqual([...actual], [...expected])) {
    issues.push(`${label} differs: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`)
  }
}

function compareNumber(label: string, actual: number | undefined, expected: number, issues: string[]): void {
  if (actual !== expected) issues.push(`${label} differs: expected ${expected}, observed ${actual ?? 'not extracted'}`)
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
