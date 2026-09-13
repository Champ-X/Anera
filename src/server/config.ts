import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveAgentModels } from './agent-models.js'
import {
  DEFAULT_DEEPSEEK_VISION_PRICING,
  type DeepSeekVisionPricing,
} from './vision-pricing.js'

function loadDotEnv(path: string): Record<string, string> {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }

  const result: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    result[match[1]] = value
  }
  return result
}

const projectRoot = resolve(process.cwd())
const dotEnv = loadDotEnv(resolve(projectRoot, '.env'))

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || dotEnv[name]?.trim() || fallback
}

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash'

export function resolveDeepSeekModel(value?: string): string {
  return value?.trim() || DEFAULT_DEEPSEEK_MODEL
}

/** Zero explicitly disables the cumulative token stop; usage is still metered. */
export function resolveAgentTokenLimit(value: string): number {
  if (!value.trim()) return 0
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('ANERA_MAX_AGENT_TOTAL_TOKENS_PER_TURN must be a non-negative safe integer (0 disables the limit)')
  return limit
}

/** Request admission is opt-in; zero preserves metering without a count stop. */
export function resolveAgentRequestLimit(value: string): number {
  if (!value.trim()) return 0
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('ANERA_MAX_AGENT_MODEL_REQUESTS_PER_TURN must be a non-negative safe integer (0 disables the limit)')
  return limit
}

export function resolveTavilyApiKey(read: (name: string) => string): string {
  return read('TAVILY_API_KEY') || read('TAVILY_API_KRY')
}

export function resolveModelTemperature(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : 0
}

export function resolveModelThinking(value: string): 'enabled' | 'disabled' | undefined {
  const normalized = value.trim().toLowerCase()
  if (['auto', ''].includes(normalized)) return undefined
  if (['enabled', 'true', '1'].includes(normalized)) return 'enabled'
  if (['disabled', 'false', '0'].includes(normalized)) return 'disabled'
  throw new Error('DEEPSEEK_THINKING must be enabled, disabled, or auto')
}

export function resolveModelReasoningEffort(value: string): 'low' | 'high' | 'max' {
  if (value === 'low' || value === 'high' || value === 'max') return value
  throw new Error('DEEPSEEK_REASONING_EFFORT must be low, high, or max')
}

export function resolveTestLoopbackDeepSeekProvider(input: {
  enabled: boolean
  nodeEnv: string
  apiKey: string
  baseUrl: string
}): boolean {
  if (!input.enabled) return false
  if (input.nodeEnv !== 'test') {
    throw new Error('ANERA_TEST_LOOPBACK_DEEPSEEK_PROVIDER requires NODE_ENV=test')
  }
  if (!input.apiKey.startsWith('synthetic-')) {
    throw new Error('ANERA_TEST_LOOPBACK_DEEPSEEK_PROVIDER requires a synthetic DeepSeek API key')
  }
  let url: URL
  try {
    url = new URL(input.baseUrl)
  } catch {
    throw new Error('ANERA_TEST_LOOPBACK_DEEPSEEK_PROVIDER requires a valid provider URL')
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (url.protocol !== 'http:' || !url.port || !['127.0.0.1', '::1'].includes(hostname) || url.username || url.password) {
    throw new Error('ANERA_TEST_LOOPBACK_DEEPSEEK_PROVIDER requires an uncredentialed HTTP loopback URL with an explicit port')
  }
  return true
}

function positiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env(name), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function positiveNumber(name: string, fallback: number): number {
  const parsed = Number.parseFloat(env(name))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function optionalNonNegativeNumber(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** Resolve all six Vision rates independently; text cache pricing is deliberately not consulted. */
export function resolveDeepSeekVisionPricing(read: (name: string) => string): DeepSeekVisionPricing {
  const legacyCacheMiss = optionalNonNegativeNumber(read('DEEPSEEK_VISION_INPUT_COST_PER_MILLION_USD'))
  const legacyOutput = optionalNonNegativeNumber(read('DEEPSEEK_VISION_OUTPUT_COST_PER_MILLION_USD'))
  const rate = (name: string, fallback: number): number => optionalNonNegativeNumber(read(name)) ?? fallback
  return {
    offPeak: {
      cacheHitInputPerMillionUsd: rate(
        'DEEPSEEK_VISION_CACHE_HIT_OFF_PEAK_COST_PER_MILLION_USD',
        DEFAULT_DEEPSEEK_VISION_PRICING.offPeak.cacheHitInputPerMillionUsd,
      ),
      cacheMissInputPerMillionUsd: rate(
        'DEEPSEEK_VISION_CACHE_MISS_OFF_PEAK_COST_PER_MILLION_USD',
        legacyCacheMiss ?? DEFAULT_DEEPSEEK_VISION_PRICING.offPeak.cacheMissInputPerMillionUsd,
      ),
      outputPerMillionUsd: rate(
        'DEEPSEEK_VISION_OUTPUT_OFF_PEAK_COST_PER_MILLION_USD',
        legacyOutput ?? DEFAULT_DEEPSEEK_VISION_PRICING.offPeak.outputPerMillionUsd,
      ),
    },
    peak: {
      cacheHitInputPerMillionUsd: rate(
        'DEEPSEEK_VISION_CACHE_HIT_PEAK_COST_PER_MILLION_USD',
        DEFAULT_DEEPSEEK_VISION_PRICING.peak.cacheHitInputPerMillionUsd,
      ),
      cacheMissInputPerMillionUsd: rate(
        'DEEPSEEK_VISION_CACHE_MISS_PEAK_COST_PER_MILLION_USD',
        legacyCacheMiss ?? DEFAULT_DEEPSEEK_VISION_PRICING.peak.cacheMissInputPerMillionUsd,
      ),
      outputPerMillionUsd: rate(
        'DEEPSEEK_VISION_OUTPUT_PEAK_COST_PER_MILLION_USD',
        legacyOutput ?? DEFAULT_DEEPSEEK_VISION_PRICING.peak.outputPerMillionUsd,
      ),
    },
  }
}

function booleanFlag(name: string, fallback = false): boolean {
  const value = env(name)
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  throw new Error(`${name} must be one of true/false, 1/0, yes/no, or on/off`)
}

function customFeedbackArm(): 'control' | 'treatment-1' | 'treatment-2' {
  const value = env('ANERA_CUSTOM_FEEDBACK_ARM', 'treatment-1')
  if (value === 'control' || value === 'treatment-1' || value === 'treatment-2') return value
  throw new Error('ANERA_CUSTOM_FEEDBACK_ARM must be control, treatment-1, or treatment-2')
}

function configuredList(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
}

const deepseekApiKey = env('DEEPSEEK_API_KEY')
const deepseekBaseUrl = env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')
const primaryModel = resolveDeepSeekModel(env('DEEPSEEK_MODEL'))
const speechModel = env('ANERA_SPEECH_MODEL', 'gpt-4o-mini-tts')
const imageModel = env('ANERA_IMAGE_MODEL', 'gpt-image-1')
const githubAppPrivateKeyPath = env('ANERA_GITHUB_APP_PRIVATE_KEY_PATH')
const contextWindowTokens = positiveInt('ANERA_CONTEXT_WINDOW_TOKENS', 128_000)
const contextCompactionThresholdTokens = positiveInt(
  'ANERA_CONTEXT_COMPACTION_TOKENS',
  Math.floor(contextWindowTokens * 0.8),
)
const deepSeekVisionPricing = resolveDeepSeekVisionPricing(env)
const testLoopbackDeepSeekProvider = resolveTestLoopbackDeepSeekProvider({
  enabled: booleanFlag('ANERA_TEST_LOOPBACK_DEEPSEEK_PROVIDER', false),
  nodeEnv: process.env.NODE_ENV?.trim() || '',
  apiKey: deepseekApiKey,
  baseUrl: deepseekBaseUrl,
})
if (contextCompactionThresholdTokens >= contextWindowTokens) {
  throw new Error(`ANERA_CONTEXT_COMPACTION_TOKENS (${contextCompactionThresholdTokens}) must be below ANERA_CONTEXT_WINDOW_TOKENS (${contextWindowTokens})`)
}

export const config = {
  projectRoot,
  dataRoot: resolve(projectRoot, env('ANERA_DATA_DIR', '.anera')),
  port: positiveInt('ANERA_PORT', 4174),
  publicBaseUrl: env('ANERA_PUBLIC_BASE_URL').replace(/\/+$/, ''),
  deepseekApiKey,
  deepseekBaseUrl,
  testLoopbackDeepSeekProvider,
  // Keep the historical TAVILY_API_KRY spelling working for existing local
  // environments while preferring the provider's standard variable name.
  tavilyApiKey: resolveTavilyApiKey(env),
  tavilyBaseUrl: env('ANERA_TAVILY_BASE_URL', 'https://api.tavily.com').replace(/\/+$/, ''),
  firecrawlApiKey: env('FIRECRAWL_API_KEY'),
  firecrawlBaseUrl: env('ANERA_FIRECRAWL_BASE_URL', 'https://api.firecrawl.dev/v1').replace(/\/+$/, ''),
  pexelsApiKey: env('PEXELS_API_KEY'),
  imageApiKey: env('ANERA_IMAGE_API_KEY', env('OPENAI_API_KEY')),
  imageBaseUrl: env('ANERA_IMAGE_BASE_URL', 'https://api.openai.com/v1'),
  imageModel,
  // A battle must use genuinely distinct provider model ids. Keeping the
  // default to the primary route alone makes offer_options fail closed until
  // operators explicitly configure at least one additional compatible model.
  imageBattleModels: [...new Set([
    imageModel,
    ...configuredList(env('ANERA_IMAGE_BATTLE_MODELS')),
  ])],
  speechModel,
  model: primaryModel,
  modelTemperature: resolveModelTemperature(env('DEEPSEEK_TEMPERATURE', '0')),
  modelThinking: resolveModelThinking(env('DEEPSEEK_THINKING', 'enabled')),
  modelReasoningEffort: resolveModelReasoningEffort(env('DEEPSEEK_REASONING_EFFORT', 'low')),
  agentModels: resolveAgentModels(primaryModel, env('ANERA_AGENT_MODELS'), deepseekBaseUrl),
  customFeedbackArm: customFeedbackArm(),
  visionModel: env('DEEPSEEK_VISION_MODEL', 'deepseek-v4-flash-vision-exp'),
  maxToolCallsPerStep: positiveInt('ANERA_MAX_TOOL_CALLS_PER_STEP', 16),
  maxParallelToolCalls: positiveInt('ANERA_MAX_PARALLEL_TOOL_CALLS', 6),
  // Per user/operator turn, recovered from durable settlements. Request and
  // cumulative token stopping are both opt-in (0 = off).
  // Metering always includes Agent and compaction, including after restart.
  maxAgentModelRequestsPerTurn: resolveAgentRequestLimit(env('ANERA_MAX_AGENT_MODEL_REQUESTS_PER_TURN')),
  maxAgentTotalTokensPerTurn: resolveAgentTokenLimit(env('ANERA_MAX_AGENT_TOTAL_TOKENS_PER_TURN')),
  // Visual runs legitimately span several source, render, and Vision passes.
  // Keep a harness escape hatch for genuinely orphaned work, but do not cut a
  // progressing workflow off at the old 30-minute wall-clock boundary.
  runTimeoutMs: positiveInt('ANERA_RUN_TIMEOUT_MS', 2 * 60 * 60 * 1000),
  websiteIdleSleepMs: positiveInt('ANERA_WEBSITE_IDLE_SLEEP_MS', 5 * 60 * 1000),
  // Reasoning and the complete tool JSON share this output allowance.
  maxOutputTokens: positiveInt('ANERA_MAX_OUTPUT_TOKENS', 16384),
  // A stall before the first SSE frame is safe to retry because no content or
  // tool call has been emitted. Two bounded retries should not turn a brief
  // provider stall into a multi-minute Agent run.
  modelFirstEventTimeoutMs: positiveInt('ANERA_MODEL_FIRST_EVENT_TIMEOUT_MS', 20_000),
  maxLengthContinuations: positiveInt('ANERA_MAX_LENGTH_CONTINUATIONS', 2),
  dailyFreeCredits: positiveInt('ANERA_DAILY_FREE_CREDITS', 2_500),
  creditsPerUsd: positiveInt('ANERA_CREDITS_PER_USD', 1_000),
  toolTimeoutMs: positiveInt('ANERA_TOOL_TIMEOUT_MS', 120_000),
  maxToolOutputBytes: positiveInt('ANERA_MAX_TOOL_OUTPUT_BYTES', 160_000),
  maxReadBytes: positiveInt('ANERA_MAX_READ_BYTES', 240_000),
  textReadPageBytes: positiveInt('ANERA_TEXT_READ_PAGE_BYTES', 80_000),
  textReadPageLines: positiveInt('ANERA_TEXT_READ_PAGE_LINES', 2_000),
  attachmentPageBytes: positiveInt('ANERA_ATTACHMENT_PAGE_BYTES', 120_000),
  contextWindowTokens,
  contextCompactionThresholdTokens,
  // Serialized provider context (including system/tool schemas), not the
  // larger private/durable message representation retained for verification.
  contextSerializationHardLimitBytes: positiveInt(
    'ANERA_CONTEXT_SERIALIZATION_HARD_LIMIT_BYTES',
    positiveInt('ANERA_CONTEXT_COMPACTION_BYTES', 1_000_000),
  ),
  contextRetainGroups: positiveInt('ANERA_CONTEXT_RETAIN_GROUPS', 8),
  maxVisionImageBytes: positiveInt('ANERA_MAX_VISION_IMAGE_BYTES', 12 * 1024 * 1024),
  maxVisionOutputTokens: positiveInt('ANERA_MAX_VISION_OUTPUT_TOKENS', 4096),
  maxGeneratedAudioBytes: positiveInt('ANERA_MAX_GENERATED_AUDIO_BYTES', 25 * 1024 * 1024),
  inputCostPerMillionUsd: positiveNumber('DEEPSEEK_INPUT_COST_PER_MILLION_USD', 0.27),
  cachedInputCostPerMillionUsd: positiveNumber('DEEPSEEK_CACHED_INPUT_COST_PER_MILLION_USD', 0.07),
  outputCostPerMillionUsd: positiveNumber('DEEPSEEK_OUTPUT_COST_PER_MILLION_USD', 1.1),
  deepSeekVisionPricing,
  // Compatibility aliases for callers that do not yet carry a per-request
  // pricing snapshot. Production Vision calls use deepSeekVisionPricing.
  visionCachedInputCostPerMillionUsd: deepSeekVisionPricing.offPeak.cacheHitInputPerMillionUsd,
  visionInputCostPerMillionUsd: deepSeekVisionPricing.offPeak.cacheMissInputPerMillionUsd,
  visionOutputCostPerMillionUsd: deepSeekVisionPricing.offPeak.outputPerMillionUsd,
  imageGenerationInputCostPerMillionUsd: positiveNumber('ANERA_IMAGE_INPUT_COST_PER_MILLION_USD', 5),
  imageGenerationOutputCostPerMillionUsd: positiveNumber('ANERA_IMAGE_OUTPUT_COST_PER_MILLION_USD', 40),
  speechInputCostPerMillionUsd: positiveNumber(
    'ANERA_SPEECH_INPUT_COST_PER_MILLION_USD',
    speechModel.startsWith('gpt-4o-mini-tts') ? 0.6 : 0,
  ),
  speechOutputCostPerMillionUsd: positiveNumber(
    'ANERA_SPEECH_OUTPUT_COST_PER_MILLION_USD',
    speechModel.startsWith('gpt-4o-mini-tts') ? 12 : 0,
  ),
  speechCharacterCostPerMillionUsd: positiveNumber(
    'ANERA_SPEECH_CHARACTER_COST_PER_MILLION_USD',
    speechModel === 'tts-1-hd' ? 30 : speechModel === 'tts-1' ? 15 : 0,
  ),
  browserExecutablePath: env('ANERA_BROWSER_EXECUTABLE'),
  // Arena tasks execute in an isolated workspace. Keep the production entry
  // point fail closed by default; unsupported local hosts must opt out
  // explicitly instead of silently running model-authored shell on the host.
  requireOsSandbox: booleanFlag('ANERA_REQUIRE_OS_SANDBOX', true),
  githubToken: env('ANERA_GITHUB_TOKEN'),
  githubClientId: env('ANERA_GITHUB_CLIENT_ID'),
  githubClientSecret: env('ANERA_GITHUB_CLIENT_SECRET'),
  githubCallbackUrl: env('ANERA_GITHUB_CALLBACK_URL'),
  githubAppId: env('ANERA_GITHUB_APP_ID'),
  githubAppSlug: env('ANERA_GITHUB_APP_SLUG'),
  githubAppPrivateKeyPath: githubAppPrivateKeyPath ? resolve(projectRoot, githubAppPrivateKeyPath) : '',
  githubApiBaseUrl: env('ANERA_GITHUB_API_BASE_URL', 'https://api.github.com').replace(/\/+$/, ''),
  githubOAuthBaseUrl: env('ANERA_GITHUB_OAUTH_BASE_URL', 'https://github.com').replace(/\/+$/, ''),
  githubOAuthStateTtlMs: positiveInt('ANERA_GITHUB_OAUTH_STATE_TTL_MS', 10 * 60 * 1000),
  githubCloneTimeoutMs: positiveInt('ANERA_GITHUB_CLONE_TIMEOUT_MS', 5 * 60 * 1000),
  githubMaxFiles: positiveInt('ANERA_GITHUB_MAX_FILES', 20_000),
  githubMaxBytes: positiveInt('ANERA_GITHUB_MAX_BYTES', 512 * 1024 * 1024),
  githubMaxFileBytes: positiveInt('ANERA_GITHUB_MAX_FILE_BYTES', 50 * 1024 * 1024),
}

export type AneraConfig = typeof config
