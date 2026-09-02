import type { ModelMessage } from '../shared/types.js'
import { projectReferenceStyleToolResultForProvider } from './reference-style.js'
import type { ToolDefinition } from './tools.js'

interface StreamToolCall {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

export interface ModelToolCallDelta {
  index: number
  idDelta?: string
  nameDelta?: string
  argumentsDelta?: string
}

const STREAMED_TOOL_CALL_EVENT_BYTES = 1_024

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: StreamToolCall[]
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
  error?: { message?: string }
}

export interface ModelResult {
  content: string
  reasoningContent: string
  toolCalls: NonNullable<ModelMessage['tool_calls']>
  finishReason: string
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    cachedPromptTokens: number
  }
  /** Physical HTTP request dispatches, including retries and continuations. */
  modelRequestCount?: number
  /** Requests for which provider-authoritative token usage was observed. */
  modelCallCount: number
  /** The provider became trapped in a highly repetitive text loop. */
  degenerateRepetition?: boolean
}

export class DeepSeekClient {
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly options: {
      apiKey: string
      baseUrl: string
      model: string
      temperature?: number
      maxOutputTokens: number
      maxRetries?: number
      retryBaseDelayMs?: number
      maxRetryDelayMs?: number
      firstEventTimeoutMs?: number
      maxEmptyCompletionRetries?: number
      emptyCompletionRetryBaseDelayMs?: number
      maxLengthContinuations?: number
      fetch?: typeof fetch
    },
  ) {
    this.fetchImpl = options.fetch ?? fetch
  }

  async stream(options: {
    messages: ModelMessage[]
    /**
     * Stable provider-visible schema surface used to preserve prompt-cache
     * prefixes. `tools` remains the caller's authorization/validation surface;
     * callers must still reject any generated call that is not authorized.
     */
    providerTools?: ToolDefinition[]
    tools: ToolDefinition[]
    signal: AbortSignal
    onContent: (delta: string) => void
    onReasoning: (delta: string) => void
    onToolCallDelta?: (delta: ModelToolCallDelta) => void
    maxOutputTokens?: number
    model?: string
  }): Promise<ModelResult> {
    if (!this.options.apiKey) throw new Error('DEEPSEEK_API_KEY is not configured')
    const maxRetries = Math.max(0, this.options.maxRetries ?? 2)
    const maxEmptyCompletionRetries = Math.max(0, this.options.maxEmptyCompletionRetries ?? 2)
    const maxLengthContinuations = Math.max(0, this.options.maxLengthContinuations ?? 2)
    let transportRetries = 0
    let emptyCompletionRetries = 0
    let lengthContinuations = 0
    let completedModelCalls = 0
    let physicalModelRequests = 0
    let accumulatedUsage: ModelResult['usage'] = emptyUsage()
    let accumulatedContent = ''
    let accumulatedReasoning = ''
    let degenerateRepetition = false
    let requestMessages = options.messages
    while (true) {
      let emitted = false
      const continuationAttempt = lengthContinuations > 0
      const visibleBuffer = continuationAttempt
        ? undefined
        : new VisibleContentBuffer((delta) => {
            emitted = true
            options.onContent(delta)
          })
      try {
        const result = await this.request({
          ...options,
          messages: requestMessages,
          toolChoice: continuationAttempt ? 'none' : 'auto',
          onContent: (delta) => {
            visibleBuffer?.append(delta)
          },
          onReasoning: (delta) => {
            emitted = true
            options.onReasoning(delta)
          },
          onToolCallDelta: options.onToolCallDelta
            ? (delta) => {
                emitted = true
                options.onToolCallDelta?.(delta)
              }
            : undefined,
        })
        completedModelCalls += result.modelCallCount
        physicalModelRequests += result.modelRequestCount ?? 1
        accumulatedUsage = addUsage(accumulatedUsage, result.usage)
        const providerCompletionError = providerErrorCompletion(result)
        if (
          !emitted
          && (isEmptyCompletion(result) || providerCompletionError)
          && emptyCompletionRetries < maxEmptyCompletionRetries
        ) {
          const waitMs = Math.max(0, this.options.emptyCompletionRetryBaseDelayMs ?? 500) * 2 ** emptyCompletionRetries
          emptyCompletionRetries += 1
          await delay(waitMs, options.signal)
          continue
        }
        if (providerCompletionError) {
          // This completed response has already been added to the aggregate
          // immediately above. The outer catch attaches that aggregate once;
          // do not tag this local sentinel as a new failed request attempt.
          throw new Error(`DeepSeek provider completion error: ${providerCompletionError}`)
        }
        if (result.toolCalls.length === 0 && isDegenerateModelRepetition(result.content)) {
          degenerateRepetition = true
        }
        let continuationResolved = !continuationAttempt
        if (continuationAttempt) {
          if (result.toolCalls.length === 0 && result.content.trim()) {
            const candidate = result.finishReason === 'length'
              ? safeContinuationPrefix(result.content)
              : result.content
            const merged = mergeContinuationContent(accumulatedContent, candidate)
            accumulatedContent = merged.content
            continuationResolved = merged.resolved
            if (merged.delta) options.onContent(merged.delta)
          }
        } else {
          const truncatedFinal = result.finishReason === 'length' && result.toolCalls.length === 0
          accumulatedContent = truncatedFinal
            ? visibleBuffer?.commitSafePrefix() ?? ''
            : visibleBuffer?.flush() ?? result.content
        }
        accumulatedReasoning += result.reasoningContent
        const continuationNeeded = !degenerateRepetition && result.toolCalls.length === 0 && (
          result.finishReason === 'length'
          || (continuationAttempt && !continuationResolved)
        )
        if (continuationNeeded && lengthContinuations < maxLengthContinuations) {
          requestMessages = continuationMessages(options.messages, accumulatedContent)
          lengthContinuations += 1
          continue
        }
        return {
          ...result,
          content: accumulatedContent,
          reasoningContent: accumulatedReasoning,
          finishReason: continuationAttempt && !continuationResolved ? 'length' : result.finishReason,
          usage: accumulatedUsage,
          modelCallCount: completedModelCalls,
          modelRequestCount: physicalModelRequests,
          ...(degenerateRepetition ? { degenerateRepetition: true } : {}),
        }
      } catch (error) {
        const failedAttempt = modelAccountingFromError(error)
        if (failedAttempt) {
          accumulatedUsage = addUsage(accumulatedUsage, failedAttempt.usage)
          completedModelCalls += failedAttempt.modelCallCount
          physicalModelRequests += failedAttempt.modelRequestCount
        }
        if (options.signal.aborted || emitted || !isRetryable(error) || transportRetries === maxRetries) {
          throw withModelAccounting(error, accumulatedUsage, completedModelCalls, physicalModelRequests)
        }
        let waitMs: number
        try {
          waitMs = retryDelayMs(
            error,
            transportRetries,
            this.options.retryBaseDelayMs ?? 500,
            this.options.maxRetryDelayMs ?? 60_000,
          )
          await delay(waitMs, options.signal)
        } catch (retryError) {
          throw withModelAccounting(retryError, accumulatedUsage, completedModelCalls, physicalModelRequests)
        }
        transportRetries += 1
      }
    }
  }

  private async request(options: {
    messages: ModelMessage[]
    providerTools?: ToolDefinition[]
    tools: ToolDefinition[]
    signal: AbortSignal
    onContent: (delta: string) => void
    onReasoning: (delta: string) => void
    onToolCallDelta?: (delta: ModelToolCallDelta) => void
    maxOutputTokens?: number
    model?: string
    toolChoice?: 'auto' | 'none'
  }): Promise<ModelResult> {
    const providerTools = options.providerTools ?? options.tools
    const toolOptions = providerTools.length > 0
      ? { tools: providerTools, tool_choice: options.toolChoice ?? 'auto' }
      : {}
    const firstEventDeadline = createFirstEventDeadline(options.signal, this.options.firstEventTimeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: firstEventDeadline.signal,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model ?? this.options.model,
          messages: projectProviderMessages(options.messages),
          ...toolOptions,
          stream: true,
          stream_options: { include_usage: true },
          temperature: this.options.temperature ?? 0,
          max_tokens: options.maxOutputTokens ?? this.options.maxOutputTokens,
        }),
      })
    } catch (error) {
      firstEventDeadline.stop()
      throw withModelAccounting(firstEventDeadline.failure(error), emptyUsage(), 0, 1)
    }
    if (!response.ok) {
      firstEventDeadline.stop()
      const body = (await response.text()).slice(0, 2_000)
      const error = new Error(`DeepSeek request failed (${response.status}): ${body}`) as Error & { status?: number; headers?: Headers }
      error.status = response.status
      error.headers = response.headers
      throw withModelAccounting(error, emptyUsage(), 0, 1)
    }
    if (!response.body) {
      firstEventDeadline.stop()
      throw withModelAccounting(new Error('DeepSeek returned no response stream'), emptyUsage(), 0, 1)
    }

    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    const pendingToolCallDeltas = new Map<number, Required<Omit<ModelToolCallDelta, 'index'>>>()
    let content = ''
    let reasoningContent = ''
    let finishReason = ''
    let usage: ModelResult['usage'] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 }
    let usageObserved = false
    let pending = ''
    const decoder = new TextDecoder()

    const flushToolCallDelta = (index: number) => {
      const delta = pendingToolCallDeltas.get(index)
      if (!delta) return
      pendingToolCallDeltas.delete(index)
      if (!delta.idDelta && !delta.nameDelta && !delta.argumentsDelta) return
      options.onToolCallDelta?.({
        index,
        ...(delta.idDelta ? { idDelta: delta.idDelta } : {}),
        ...(delta.nameDelta ? { nameDelta: delta.nameDelta } : {}),
        ...(delta.argumentsDelta ? { argumentsDelta: delta.argumentsDelta } : {}),
      })
    }

    const queueToolCallDelta = (toolCall: StreamToolCall) => {
      if (!options.onToolCallDelta) return
      const pendingDelta = pendingToolCallDeltas.get(toolCall.index) ?? {
        idDelta: '',
        nameDelta: '',
        argumentsDelta: '',
      }
      pendingDelta.idDelta += toolCall.id ?? ''
      pendingDelta.nameDelta += toolCall.function?.name ?? ''
      pendingDelta.argumentsDelta += toolCall.function?.arguments ?? ''
      pendingToolCallDeltas.set(toolCall.index, pendingDelta)
      if (Buffer.byteLength(
        `${pendingDelta.idDelta}${pendingDelta.nameDelta}${pendingDelta.argumentsDelta}`,
        'utf8',
      ) >= STREAMED_TOOL_CALL_EVENT_BYTES) flushToolCallDelta(toolCall.index)
    }

    const processBlock = (block: string) => {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        firstEventDeadline.markEvent()
        const chunk = JSON.parse(data) as StreamChunk
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
            cachedPromptTokens: chunk.usage.prompt_cache_hit_tokens ?? 0,
          }
          usageObserved = true
        }
        if (chunk.error?.message) throw new Error(chunk.error.message)
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (delta?.content) {
          content += delta.content
          options.onContent(delta.content)
        }
        if (delta?.reasoning_content) {
          reasoningContent += delta.reasoning_content
          options.onReasoning(delta.reasoning_content)
        }
        for (const toolCall of delta?.tool_calls ?? []) {
          const current = calls.get(toolCall.index) ?? { id: '', name: '', arguments: '' }
          if (toolCall.id) current.id = toolCall.id
          if (toolCall.function?.name) current.name += toolCall.function.name
          if (toolCall.function?.arguments) current.arguments += toolCall.function.arguments
          calls.set(toolCall.index, current)
          queueToolCallDelta(toolCall)
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
      }
    }

    const processCompleteBlocks = () => {
      let boundary = pending.match(/\r?\n\r?\n/)
      while (boundary?.index !== undefined) {
        const block = pending.slice(0, boundary.index)
        pending = pending.slice(boundary.index + boundary[0].length)
        processBlock(block)
        boundary = pending.match(/\r?\n\r?\n/)
      }
    }

    try {
      for await (const bytes of response.body) {
        pending += decoder.decode(bytes, { stream: true })
        processCompleteBlocks()
      }
      pending += decoder.decode()
      processCompleteBlocks()
      if (pending.trim()) processBlock(pending)
      if (!finishReason) throw new TypeError('DeepSeek stream ended before a finish reason')
      for (const index of pendingToolCallDeltas.keys()) flushToolCallDelta(index)
    } catch (error) {
      const failure = firstEventDeadline.failure(error)
      // A provider may emit its authoritative usage event before a terminal
      // stream error or before the connection closes without finish_reason.
      // Preserve only that observed usage; never estimate tokens for a failed
      // attempt whose stream did not expose them.
      throw withModelAccounting(failure, usage, usageObserved ? 1 : 0, 1)
    } finally {
      firstEventDeadline.stop()
    }

    return {
      content,
      reasoningContent,
      toolCalls: materializeStreamToolCalls(calls),
      finishReason,
      usage,
      modelCallCount: usageObserved ? 1 : 0,
      modelRequestCount: 1,
    }
  }
}

function materializeStreamToolCalls(
  calls: Map<number, { id: string; name: string; arguments: string }>,
): ModelResult['toolCalls'] {
  const ordered = [...calls.entries()].sort(([left], [right]) => left - right)
  const reserved = new Set(ordered.map(([, call]) => call.id.trim()).filter(Boolean))
  return ordered.map(([streamIndex, call]) => {
    let id = call.id.trim()
    if (!id) {
      const base = `call_${streamIndex}`
      id = base
      let suffix = 1
      while (reserved.has(id)) id = `${base}_generated_${suffix++}`
      reserved.add(id)
    }
    return {
      id,
      type: 'function' as const,
      function: { name: call.name, arguments: call.arguments || '{}' },
    }
  })
}

interface FirstEventDeadline {
  signal: AbortSignal
  markEvent: () => void
  stop: () => void
  failure: (error: unknown) => unknown
}

function createFirstEventDeadline(parent: AbortSignal, configuredMs: number | undefined): FirstEventDeadline {
  const timeoutMs = configuredMs === undefined ? 60_000 : Math.trunc(configuredMs)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || parent.aborted) {
    return { signal: parent, markEvent: () => {}, stop: () => {}, failure: (error) => error }
  }

  const controller = new AbortController()
  let timedOut = false
  let stopped = false
  const timeoutError = Object.assign(
    new Error(`DeepSeek first stream event timed out after ${timeoutMs}ms`),
    { code: 'model_first_event_timeout' },
  )
  const timer = setTimeout(() => {
    if (stopped) return
    timedOut = true
    controller.abort(timeoutError)
  }, timeoutMs)
  timer.unref?.()
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
  }
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    markEvent: stop,
    stop,
    failure: (error) => timedOut ? timeoutError : error,
  }
}

/**
 * Produce the exact provider-visible message projection used by both request
 * serialization and context-pressure accounting. Reference fingerprints are
 * private durable evidence, so project them only when the surrounding
 * assistant call proves this result came from record_reference_style.
 */
export function projectProviderMessages(messages: readonly ModelMessage[]): Array<Record<string, unknown>> {
  const pendingCallNames = new Map<string, string[]>()
  return messages.map((message) => {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        const names = pendingCallNames.get(call.id) ?? []
        names.push(call.function.name)
        pendingCallNames.set(call.id, names)
      }
      return providerMessage(message, false)
    }
    let projectReferenceStyleResult = false
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      const names = pendingCallNames.get(message.tool_call_id)
      const callName = names?.shift()
      if (names?.length === 0) pendingCallNames.delete(message.tool_call_id)
      projectReferenceStyleResult = callName === 'record_reference_style'
    }
    return providerMessage(message, projectReferenceStyleResult)
  })
}

function providerMessage(
  message: ModelMessage,
  projectReferenceStyleResult: boolean,
): Record<string, unknown> {
  const {
    tool_result_status: _privateStatus,
    tool_content_parts: toolContentParts,
    arena_system_messages: _privateArenaSystemMessages,
    ...provider
  } = message
  if (!toolContentParts?.length) {
    return message.role === 'tool'
      && typeof provider.content === 'string'
      && projectReferenceStyleResult
      ? { ...provider, content: projectReferenceStyleToolResultForProvider(provider.content) }
      : provider
  }
  return {
    ...provider,
    content: toolContentParts.map((part) => ({
      type: 'image_url',
      image_url: { url: `data:${part.mediaType};base64,${part.data}` },
    })),
  }
}

function emptyUsage(): ModelResult['usage'] {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 }
}

function addUsage(left: ModelResult['usage'], right: ModelResult['usage']): ModelResult['usage'] {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedPromptTokens: left.cachedPromptTokens + right.cachedPromptTokens,
  }
}

function isEmptyCompletion(result: ModelResult): boolean {
  return result.finishReason === 'stop'
    && result.usage.completionTokens <= 1
    && result.content.length === 0
    && result.reasoningContent.length === 0
    && result.toolCalls.length === 0
}

const REPETITION_MIN_CHARACTERS = 1_200
const REPETITION_SHINGLE_TOKENS = 18
const REPETITION_SHINGLE_STRIDE = 6

/**
 * Detect provider degeneration, not ordinary repeated prose. The thresholds
 * intentionally require a long response whose exact blocks or token shingles
 * dominate most of the output. This catches loops that fill the output window
 * with one repeated paragraph while leaving normal lists, tables, and code
 * templates alone.
 */
export function isDegenerateModelRepetition(content: string): boolean {
  const normalized = content.replace(/\s+/gu, ' ').trim()
  if (normalized.length < REPETITION_MIN_CHARACTERS) return false

  const blocks = content
    .split(/\n\s*\n/gu)
    .map((block) => block.replace(/\s+/gu, ' ').trim())
    .filter((block) => block.length >= 80)
  const blockCounts = new Map<string, number>()
  for (const block of blocks) blockCounts.set(block, (blockCounts.get(block) ?? 0) + 1)
  const repeatedBlockCharacters = [...blockCounts]
    .filter(([, count]) => count >= 4)
    .reduce((total, [block, count]) => total + block.length * count, 0)
  if (repeatedBlockCharacters / normalized.length >= 0.65) return true

  const tokens = normalized.match(/[\p{L}\p{N}_]+|[^\s]/gu) ?? []
  if (tokens.length < REPETITION_SHINGLE_TOKENS * 8) return false
  const shingles: string[] = []
  for (
    let index = 0;
    index + REPETITION_SHINGLE_TOKENS <= tokens.length;
    index += REPETITION_SHINGLE_STRIDE
  ) {
    shingles.push(tokens.slice(index, index + REPETITION_SHINGLE_TOKENS).join('\u0001'))
  }
  if (shingles.length < 16) return false
  const counts = new Map<string, number>()
  for (const shingle of shingles) counts.set(shingle, (counts.get(shingle) ?? 0) + 1)
  const repeatedWindows = shingles.reduce((total, shingle) => (
    total + ((counts.get(shingle) ?? 0) >= 3 ? 1 : 0)
  ), 0)
  return repeatedWindows / shingles.length >= 0.75
    && counts.size / shingles.length <= 0.35
}

function providerErrorCompletion(result: ModelResult): string | undefined {
  if (result.finishReason !== 'stop' || result.toolCalls.length > 0) return undefined
  const content = result.content.trim()
  if (/^(?:✋\s*)?Error:\s*A message with role ['"]?tool['"]? found without preceding user message\.?$/i.test(content)) {
    return content
  }
  return undefined
}

function continuationMessages(messages: ModelMessage[], partialContent: string): ModelMessage[] {
  const overlapAnchor = continuationOverlapAnchor(partialContent)
  const overlapInstruction = overlapAnchor
    ? ` Begin your output by repeating the exact suffix encoded by this JSON string (emit the decoded characters only, without quotes or escapes): ${JSON.stringify(overlapAnchor)}. The Harness will remove that repeated overlap.`
    : ''
  return [
    ...messages,
    ...(partialContent ? [{ role: 'assistant' as const, content: partialContent }] : []),
    {
      role: 'user',
      content: `[Harness continuation: the assistant message immediately above is the exact prefix already shown to the user.${overlapInstruction} After that overlap, output only the missing suffix and complete the response; do not restart from any earlier point. This is a text-only continuation: do not call or describe tools.]`,
    },
  ]
}

function continuationOverlapAnchor(content: string): string {
  let start = Math.max(0, content.length - CONTINUATION_FALLBACK_REGEN_CHARS)
  if (
    start > 0
    && start < content.length
    && isHighSurrogate(content.charCodeAt(start - 1))
    && isLowSurrogate(content.charCodeAt(start))
  ) start += 1
  return content.slice(start)
}

function mergeContinuationContent(existing: string, candidate: string): { content: string; delta: string; resolved: boolean } {
  if (!candidate) return { content: existing, delta: '', resolved: false }
  if (!existing) return { content: candidate, delta: candidate, resolved: true }

  const completePrefixAt = candidate.indexOf(existing)
  if (completePrefixAt >= 0) {
    const delta = candidate.slice(completePrefixAt + existing.length)
    return { content: existing + delta, delta, resolved: delta.length > 0 }
  }
  if (existing.includes(candidate)) return { content: existing, delta: '', resolved: false }

  // Providers sometimes add a preamble and then restart from the beginning. A
  // continuation that has not caught up to the already-visible prefix adds no
  // text. Once it reaches the full prefix, the exact branch above appends only
  // the novel suffix. This keeps retries and multi-call continuations replay-safe.
  const anchorLength = Math.min(existing.length, 32)
  if (anchorLength >= 8) {
    const restartedAt = candidate.indexOf(existing.slice(0, anchorLength))
    if (restartedAt >= 0) {
      let matched = anchorLength
      while (
        matched < existing.length
        && restartedAt + matched < candidate.length
        && existing[matched] === candidate[restartedAt + matched]
      ) matched += 1
      const restarted = candidate.slice(restartedAt)
      if (restarted.length <= existing.length || matched < existing.length) {
        return { content: existing, delta: '', resolved: false }
      }
    }
  }

  // Normal continuations may repeat a boundary phrase. Remove a bounded exact
  // suffix/prefix overlap without doing quadratic work on an entire long answer.
  for (let overlap = Math.min(existing.length, candidate.length, 4_096); overlap >= 8; overlap -= 1) {
    if (existing.endsWith(candidate.slice(0, overlap))) {
      const delta = candidate.slice(overlap)
      return { content: existing + delta, delta, resolved: delta.length > 0 }
    }
  }
  return { content: existing + candidate, delta: candidate, resolved: true }
}

const CONTINUATION_HOLDBACK_CHARS = 256
const CONTINUATION_FALLBACK_REGEN_CHARS = 64

class VisibleContentBuffer {
  private pending = ''
  private committed = ''

  constructor(private readonly publish: (delta: string) => void) {}

  append(delta: string): void {
    this.pending += delta
    if (this.pending.length <= CONTINUATION_HOLDBACK_CHARS) return
    const boundary = stableStreamingBoundaryAtOrBefore(this.pending, this.pending.length - CONTINUATION_HOLDBACK_CHARS)
    if (boundary > 0) this.commit(boundary)
  }

  commitSafePrefix(): string {
    const boundary = continuationPrefixBoundary(this.pending)
    if (boundary > 0) this.commit(boundary)
    this.pending = ''
    return this.committed
  }

  flush(): string {
    if (this.pending) this.commit(this.pending.length)
    return this.committed
  }

  private commit(length: number): void {
    const delta = this.pending.slice(0, length)
    this.pending = this.pending.slice(length)
    this.committed += delta
    this.publish(delta)
  }
}

function safeContinuationPrefix(content: string): string {
  return content.slice(0, continuationPrefixBoundary(content))
}

function stableStreamingBoundaryAtOrBefore(content: string, limit: number): number {
  const boundedLimit = Math.min(content.length, Math.max(0, limit))
  const semantic = semanticBoundaryAtOrBefore(content, boundedLimit)
  // Do not let one very old separator retain an unbounded single-token tail.
  // A small recent semantic boundary is preferable; otherwise the scalar
  // fallback keeps the streaming holdback bounded.
  if (semantic >= Math.max(1, boundedLimit - CONTINUATION_FALLBACK_REGEN_CHARS)) return semantic
  return unicodeScalarBoundaryAtOrBefore(content, boundedLimit)
}

function continuationPrefixBoundary(content: string): number {
  const semantic = semanticBoundaryAtOrBefore(content, content.length)
  if (semantic > 0 && content.length - semantic <= CONTINUATION_HOLDBACK_CHARS) return semantic
  // Exact hashes, base64, minified payloads, and other long single-token
  // responses have no semantic separator. Retain the completed prefix
  // and attach an explicit overlap anchor to the continuation request. This
  // keeps all completed bytes while avoiding an unverified one-character
  // next-token guess at the provider boundary.
  return unicodeScalarBoundaryAtOrBefore(content, content.length)
}

function semanticBoundaryAtOrBefore(content: string, limit: number): number {
  for (let index = Math.min(content.length, Math.max(0, limit)) - 1; index >= 0; index -= 1) {
    if (/\s|[,.;:!?，。；：！？]/u.test(content[index])) return index + 1
  }
  return 0
}

function unicodeScalarBoundaryAtOrBefore(content: string, limit: number): number {
  const boundedLimit = Math.min(content.length, Math.max(0, limit))
  if (
    boundedLimit > 0
    && boundedLimit < content.length
    && isHighSurrogate(content.charCodeAt(boundedLimit - 1))
    && isLowSurrogate(content.charCodeAt(boundedLimit))
  ) return boundedLimit - 1
  return boundedLimit
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

function withModelAccounting(
  error: unknown,
  usage: ModelResult['usage'],
  modelCallCount: number,
  modelRequestCount: number,
): unknown {
  if (modelRequestCount === 0) return error
  const target = error instanceof Error ? error : new Error(String(error))
  try {
    Object.assign(target, { modelUsage: usage, modelCallCount, modelRequestCount })
    return target
  } catch {
    return Object.assign(
      new Error(target.message, { cause: target }),
      { modelUsage: usage, modelCallCount, modelRequestCount },
    )
  }
}

function modelAccountingFromError(error: unknown): {
  usage: ModelResult['usage']
  modelCallCount: number
  modelRequestCount: number
} | undefined {
  const failure = error as {
    modelUsage?: Partial<ModelResult['usage']>
    modelCallCount?: number
    modelRequestCount?: number
  }
  const usage = failure?.modelUsage
  const modelCallCount = failure?.modelCallCount
  const modelRequestCount = failure?.modelRequestCount ?? modelCallCount
  if (
    !usage
    || !Number.isInteger(modelCallCount)
    || (modelCallCount ?? -1) < 0
    || !Number.isInteger(modelRequestCount)
    || (modelRequestCount ?? 0) < 1
    || (modelCallCount ?? 0) > (modelRequestCount ?? 0)
    || ![usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.cachedPromptTokens]
      .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
  ) return undefined
  return {
    usage: usage as ModelResult['usage'],
    modelCallCount: modelCallCount as number,
    modelRequestCount: modelRequestCount as number,
  }
}

function isRetryable(error: unknown): boolean {
  const providerError = error as { status?: number; headers?: Headers }
  const directed = providerError?.headers?.get('x-should-retry')?.toLowerCase()
  if (directed === 'true') return true
  if (directed === 'false') return false
  const status = providerError?.status
  if (status === 408 || status === 409 || status === 425 || status === 429 || (typeof status === 'number' && status >= 500)) return true
  const message = error instanceof Error ? `${error.name}: ${error.message} ${(error as Error & { cause?: unknown }).cause || ''}` : String(error)
  return /TypeError:.*fetch|fetch failed|first stream event timed out|stream ended before a finish reason|network error|connection (?:reset|lost|refused)|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|socket hang up|other side closed|service unavailable|rate.?limit|too many requests|overloaded/i.test(message)
}

function retryDelayMs(error: unknown, attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const headers = (error as { headers?: Headers })?.headers
  const retryAfterMs = headers?.get('retry-after-ms')
  let requested = retryAfterMs === null || retryAfterMs === undefined ? Number.NaN : Number.parseFloat(retryAfterMs)
  if (!Number.isFinite(requested)) {
    const retryAfter = headers?.get('retry-after')
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter)
      requested = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1_000
    }
  }
  const delayMs = Number.isFinite(requested) && requested >= 0
    ? requested
    : Math.max(0, baseDelayMs) * 2 ** attempt
  if (maxDelayMs > 0 && delayMs > maxDelayMs) {
    throw new Error(`DeepSeek requested a ${Math.ceil(delayMs / 1_000)}s retry delay, exceeding the ${Math.ceil(maxDelayMs / 1_000)}s harness limit`)
  }
  return delayMs
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
