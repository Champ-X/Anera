import type { ModelMessage } from '../shared/types.js'
import { contextHash } from './context-records.js'
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

export type ModelToolChoice =
  | 'auto'
  | 'none'
  | { type: 'function'; function: { name: string } }

/** A provider syntax contract, not schema validation or factual certification. */
export type ModelResponseFormat = { type: 'json_object' }

/** Bounded transport facts only: no prompts, tool arguments, credentials or model text. */
export type ModelTransportEvent = {
  requestIndex: number
  continuation: 'none' | 'prose' | 'tools'
  toolNames: string[]
  omittedToolCount: number
} & ({
  type: 'request'
  toolChoice: 'auto' | 'none' | 'function' | 'omitted'
  forcedToolName?: string
  maxOutputTokens: number
  responseFormat?: ModelResponseFormat['type']
} | {
  type: 'response'
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other'
  contentBytes: number
  reasoningBytes: number
  usage?: ModelResult['usage']
})

export type ModelStreamBudgetKind = 'model_requests' | 'total_tokens'

/** The caller-provided allowance was spent before another HTTP dispatch. */
export class ModelStreamBudgetExceededError extends Error {
  readonly code = 'model_stream_budget_exceeded'

  constructor(
    readonly budget: ModelStreamBudgetKind,
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Model stream exhausted its ${budget} allowance (${used}/${limit}) before another provider request.`)
    this.name = 'ModelStreamBudgetExceededError'
  }
}

/** Internal boundary that keeps durable dispatch-gate failures out of provider retry classification. */
class ModelRequestDispatchGateError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason), { cause: reason })
    this.name = 'ModelRequestDispatchGateError'
  }
}

export class DeepSeekClient {
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly options: {
      apiKey: string
      baseUrl: string
      model: string
      temperature?: number
      thinking?: 'enabled' | 'disabled'
      reasoningEffort?: 'low' | 'high' | 'max'
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
    /** @deprecated Ignored. Provider schemas must equal the executable `tools`,
     * including their argument constraints, in every thinking/continuation mode. */
    providerTools?: ToolDefinition[]
    tools: ToolDefinition[]
    /** Provider generation policy; caller authorization still comes from `tools`. */
    toolChoice?: ModelToolChoice
    /** Opt in only for stages whose prompt requires a JSON object (with an example).
     * Callers still validate the completed envelope and its evidence. */
    responseFormat?: ModelResponseFormat
    /**
     * The caller's current phase still needs a tool action, even if its schema
     * surface offers several choices. Length recovery must not turn such a
     * step into a prose-only final. This does not broaden tool authorization
     * or send the provider an unsupported `required` choice.
     */
    requireToolCall?: boolean
    /** Optional synchronous, best-effort diagnostics; never an admission or metering gate. */
    onTransportEvent?: (event: ModelTransportEvent) => void
    signal: AbortSignal
    onContent: (delta: string) => void
    onReasoning: (delta: string) => void
    onToolCallDelta?: (delta: ModelToolCallDelta) => void
    maxOutputTokens?: number
    /** Per-request generation mode; checkpoint summarization must not spend
     * its small output allowance on reasoning. Never mutates client defaults. */
    thinking?: 'enabled' | 'disabled'
    model?: string
    /** Maximum physical HTTP requests available to this logical stream. */
    maxModelRequests?: number
    /** Maximum provider-reported tokens available to this logical stream. */
    maxTotalTokens?: number
    /**
     * Awaited immediately before every physical HTTP attempt, including
     * transport retries and output continuations. Callers use this to persist
     * a write-ahead budget reservation before the provider can receive bytes.
     */
    beforeRequest?: () => Promise<void>
  }): Promise<ModelResult> {
    if (!this.options.apiKey) throw new Error('DEEPSEEK_API_KEY is not configured')
    if (options.maxModelRequests !== undefined && (!Number.isInteger(options.maxModelRequests) || options.maxModelRequests <= 0)) {
      throw new Error('maxModelRequests must be a positive integer')
    }
    if (options.maxTotalTokens !== undefined && (!Number.isInteger(options.maxTotalTokens) || options.maxTotalTokens <= 0)) {
      throw new Error('maxTotalTokens must be a positive integer')
    }
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
    let continuationMode: 'prose' | 'tools' | undefined
    const requiresToolAction = options.requireToolCall === true || typeof options.toolChoice === 'object'
    while (true) {
      if (options.signal.aborted) {
        throw withModelAccounting(
          options.signal.reason ?? new DOMException('Aborted', 'AbortError'),
          accumulatedUsage,
          completedModelCalls,
          physicalModelRequests,
        )
      }
      const exhaustedBudget = streamBudgetExhaustion(
        physicalModelRequests,
        accumulatedUsage.totalTokens,
        options.maxModelRequests,
        options.maxTotalTokens,
      )
      if (exhaustedBudget) {
        throw withModelAccounting(
          exhaustedBudget,
          accumulatedUsage,
          completedModelCalls,
          physicalModelRequests,
        )
      }
      let emitted = false
      let receivedResult = false
      const continuationAttempt = lengthContinuations > 0
      const publishContent = (delta: string) => {
        options.signal.throwIfAborted()
        emitted = true
        options.onContent(delta)
        options.signal.throwIfAborted()
      }
      const visibleBuffer = continuationAttempt
        ? undefined
        : new VisibleContentBuffer(publishContent)
      try {
        const result = await this.request({
          ...options,
          messages: requestMessages,
          requestIndex: physicalModelRequests + 1,
          continuation: continuationMode ?? 'none',
          // A suffix completes an existing object; it must not be forced to
          // start a new object. Reasoning-only continuations have no content
          // prefix and retain the contract, as do transport/empty retries.
          responseFormat: continuationMode === 'prose' && accumulatedContent
            ? undefined : options.responseFormat,
          // Only a genuine prose suffix disables tools. A reasoning-only or
          // still-required tool step keeps the same phase-directed surface.
          // Partial tool calls never enter either continuation branch below.
          toolChoice: continuationMode === 'prose' ? 'none' : options.toolChoice ?? 'auto',
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
        receivedResult = true
        completedModelCalls += result.modelCallCount
        physicalModelRequests += result.modelRequestCount ?? 1
        accumulatedUsage = addUsage(accumulatedUsage, result.usage)
        // A response observer or the caller can cancel after the transport
        // has completed but before buffered prose is published. Its usage is
        // already authoritative; retain it without flushing a late answer.
        options.signal.throwIfAborted()
        const providerCompletionError = providerErrorCompletion(result)
        if (
          !emitted
          && (isEmptyCompletion(result) || providerCompletionError)
          && emptyCompletionRetries < maxEmptyCompletionRetries
        ) {
          const exhaustedBudget = streamBudgetExhaustion(
            physicalModelRequests,
            accumulatedUsage.totalTokens,
            options.maxModelRequests,
            options.maxTotalTokens,
          )
          if (exhaustedBudget) throw exhaustedBudget
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
        let continuationResolved = !continuationAttempt || continuationMode === 'tools'
        if (continuationAttempt) {
          if ((result.toolCalls.length === 0 || continuationMode === 'tools') && result.content.trim()) {
            const candidate = result.finishReason === 'length'
              ? safeContinuationPrefix(result.content)
              : result.content
            const merged = mergeContinuationContent(accumulatedContent, candidate)
            accumulatedContent = merged.content
            continuationResolved = continuationMode === 'tools' || merged.resolved
            if (merged.delta) publishContent(merged.delta)
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
          const continueTools = options.tools.length > 0 && options.toolChoice !== 'none' && (
            requiresToolAction
            // No public answer exists yet: the length limit interrupted
            // reasoning, not a final suffix. Once a genuine prose suffix has
            // started, however, a quiet reasoning response cannot reopen tools.
            || (!result.content.trim() && continuationMode !== 'prose')
          )
          continuationMode = continueTools ? 'tools' : 'prose'
          requestMessages = continueTools
            ? toolPhaseContinuationMessages(options.messages, accumulatedContent, accumulatedReasoning, requiresToolAction)
            : continuationMessages(options.messages, accumulatedContent, accumulatedReasoning)
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
        if (error instanceof ModelRequestDispatchGateError) {
          throw withModelAccounting(
            error.reason,
            accumulatedUsage,
            completedModelCalls,
            physicalModelRequests,
          )
        }
        const failedAttempt = receivedResult ? undefined : modelAccountingFromError(error)
        if (failedAttempt) {
          accumulatedUsage = addUsage(accumulatedUsage, failedAttempt.usage)
          completedModelCalls += failedAttempt.modelCallCount
          physicalModelRequests += failedAttempt.modelRequestCount
        }
        if (options.signal.aborted || emitted || !isRetryable(error) || transportRetries === maxRetries) {
          throw withModelAccounting(error, accumulatedUsage, completedModelCalls, physicalModelRequests)
        }
        const exhaustedBudget = streamBudgetExhaustion(
          physicalModelRequests,
          accumulatedUsage.totalTokens,
          options.maxModelRequests,
          options.maxTotalTokens,
        )
        if (exhaustedBudget) {
          throw withModelAccounting(exhaustedBudget, accumulatedUsage, completedModelCalls, physicalModelRequests)
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
    thinking?: 'enabled' | 'disabled'
    model?: string
    toolChoice?: ModelToolChoice
    responseFormat?: ModelResponseFormat
    beforeRequest?: () => Promise<void>
    requestIndex: number
    continuation: ModelTransportEvent['continuation']
    onTransportEvent?: (event: ModelTransportEvent) => void
  }): Promise<ModelResult> {
    // DeepSeek rejects forced function choice in thinking mode (HTTP 400).
    // In every mode the provider must see the executable phase whitelist and
    // exact argument schemas, never a cache-oriented capability superset.
    // A tool-free final omits schemas rather than sending an unsupported none.
    const thinkingMode = options.thinking ?? this.options.thinking
    const thinking = thinkingMode === 'enabled'
    const providerTools = options.tools
    const toolOptions = providerTools.length > 0 && !(thinking && options.toolChoice === 'none')
      ? { tools: providerTools, tool_choice: thinking ? 'auto' : options.toolChoice ?? 'auto' }
      : {}
    const body = JSON.stringify({
      model: options.model ?? this.options.model,
      messages: projectProviderMessages(options.messages),
      ...(thinkingMode ? { thinking: { type: thinkingMode } } : {}),
      ...(thinkingMode !== 'disabled' && this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {}),
      ...toolOptions,
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
      stream: true,
      stream_options: { include_usage: true },
      temperature: this.options.temperature ?? 0,
      max_tokens: options.maxOutputTokens ?? this.options.maxOutputTokens,
    })
    try {
      if (options.beforeRequest) await options.beforeRequest()
      options.signal.throwIfAborted()
    } catch (error) {
      // This is a durable dispatch gate, not a provider operation. Never let
      // a storage error that resembles a transport failure enter HTTP retry
      // classification and dispatch without the caller observing the failure.
      throw new ModelRequestDispatchGateError(error)
    }
    const firstEventDeadline = createFirstEventDeadline(options.signal, this.options.firstEventTimeoutMs)
    let response: Response
    let dispatched = false
    try {
      observeModelTransport(options.onTransportEvent, {
        type: 'request', requestIndex: options.requestIndex, continuation: options.continuation,
        ...transportToolNames(toolOptions.tools?.map((tool) => tool.function.name) ?? []),
        toolChoice: typeof toolOptions.tool_choice === 'object' ? 'function' : toolOptions.tool_choice ?? 'omitted',
        ...(typeof toolOptions.tool_choice === 'object' ? { forcedToolName: transportToolName(toolOptions.tool_choice.function.name) } : {}),
        maxOutputTokens: options.maxOutputTokens ?? this.options.maxOutputTokens,
        ...(options.responseFormat ? { responseFormat: options.responseFormat.type } : {}),
      })
      firstEventDeadline.signal.throwIfAborted()
      dispatched = true
      const pendingResponse = this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: firstEventDeadline.signal,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body,
      }).then((received) => {
        // An injected/wrapped transport may ignore AbortSignal and resolve
        // after our wait has ended. Close that unconsumed body as well.
        if (firstEventDeadline.signal.aborted && received.body) {
          discardResponseBody(received.body, firstEventDeadline.signal.reason)
        }
        return received
      })
      response = await awaitWithSignal(pendingResponse, firstEventDeadline.signal)
    } catch (error) {
      firstEventDeadline.stop()
      throw withModelAccounting(firstEventDeadline.failure(error), emptyUsage(), 0, dispatched ? 1 : 0)
    }
    if (!response.ok) {
      let body = ''
      try {
        const decoder = new TextDecoder()
        if (response.body) {
          for await (const bytes of readResponseBody(response.body, firstEventDeadline.signal)) {
            body += decoder.decode(bytes, { stream: true })
            if (body.length >= 2_000) break
          }
        }
        body = (body + decoder.decode()).slice(0, 2_000)
      } catch (error) {
        // Receiving the HTTP response means one physical model request was
        // dispatched even when consuming its error body fails. Token usage is
        // unavailable because no authoritative streamed usage event arrived.
        throw withModelAccounting(firstEventDeadline.failure(error), emptyUsage(), 0, 1)
      } finally {
        firstEventDeadline.stop()
      }
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
      firstEventDeadline.signal.throwIfAborted()
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
      firstEventDeadline.signal.throwIfAborted()
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
        firstEventDeadline.signal.throwIfAborted()
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
          firstEventDeadline.signal.throwIfAborted()
        }
        if (delta?.reasoning_content) {
          reasoningContent += delta.reasoning_content
          options.onReasoning(delta.reasoning_content)
          firstEventDeadline.signal.throwIfAborted()
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
      for await (const bytes of readResponseBody(response.body, firstEventDeadline.signal)) {
        pending += decoder.decode(bytes, { stream: true })
        processCompleteBlocks()
      }
      firstEventDeadline.signal.throwIfAborted()
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

    observeModelTransport(options.onTransportEvent, {
      type: 'response', requestIndex: options.requestIndex, continuation: options.continuation,
      ...transportToolNames([...calls.values()].map((call) => call.name)),
      finishReason: transportFinishReason(finishReason),
      contentBytes: Buffer.byteLength(content), reasoningBytes: Buffer.byteLength(reasoningContent),
      ...(usageObserved ? { usage: { ...usage } } : {}),
    })
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

/** Stop waiting even if a transport fails to honor its own AbortSignal. */
function awaitWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    // Always observe pending, including when already aborted, so a late
    // rejection cannot become an unhandled rejection after cancellation.
    pending.then((value) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) onAbort()
      else resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function discardResponseBody(body: ReadableStream<Uint8Array>, reason: unknown): void {
  try { void body.cancel(reason).catch(() => {}) } catch { /* best-effort cleanup */ }
}

async function* readResponseBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  let completed = false
  let cancelled = false
  const cancel = () => {
    if (cancelled || completed) return
    cancelled = true
    // Do not await cleanup: a provider's cancel hook can itself reject or
    // hang. The read race below remains responsible for local termination.
    try { void reader.cancel(signal.reason).catch(() => {}) } catch { /* best-effort cleanup */ }
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await awaitWithSignal(reader.read(), signal)
      signal.throwIfAborted()
      if (next.done) {
        completed = true
        return
      }
      yield next.value
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

function transportToolName(name: string): string {
  return /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/u.test(name) ? name : '[invalid tool name]'
}

function transportToolNames(names: string[]): { toolNames: string[]; omittedToolCount: number } {
  return { toolNames: names.slice(0, 64).map(transportToolName), omittedToolCount: Math.max(0, names.length - 64) }
}

function transportFinishReason(reason: string): Extract<ModelTransportEvent, { type: 'response' }>['finishReason'] {
  return reason === 'stop' || reason === 'length' || reason === 'tool_calls' || reason === 'content_filter' ? reason : 'other'
}

function observeModelTransport(observer: ((event: ModelTransportEvent) => void) | undefined, event: ModelTransportEvent): void {
  // Diagnostics must not cause a retry, alter tool authorization, or lose
  // accounting for a completed physical response if the observer fails.
  try { observer?.(event) } catch { /* observational only */ }
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
      return providerMessage(message)
    }
    let toolName: string | undefined
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      const names = pendingCallNames.get(message.tool_call_id)
      const callName = names?.shift()
      if (names?.length === 0) pendingCallNames.delete(message.tool_call_id)
      toolName = callName
    }
    return providerMessage(message, toolName)
  })
}

function providerMessage(
  message: ModelMessage,
  toolName?: string,
): Record<string, unknown> {
  const {
    tool_result_status: _privateStatus,
    context_projection: contextProjection,
    tool_content_parts: toolContentParts,
    arena_system_messages: _privateArenaSystemMessages,
    ...provider
  } = message
  if (!toolContentParts?.length) {
    if (message.role !== 'tool' || typeof provider.content !== 'string') return provider
    if (contextProjection && contextProjection.sourceSha256 === contextHash(provider.content)) {
      return { ...provider, content: contextProjection.content }
    }
    if (toolName === 'record_reference_style') {
      return { ...provider, content: projectReferenceStyleToolResultForProvider(provider.content) }
    }
    if (toolName === 'read_file') {
      return { ...provider, content: projectTextFileResultForProvider(provider.content) }
    }
    return provider
  }
  return {
    ...provider,
    content: toolContentParts.map((part) => ({
      type: 'image_url',
      image_url: { url: `data:${part.mediaType};base64,${part.data}` },
    })),
  }
}

/** Keep durable/public JSON intact; show the model file bytes without a second escape layer. */
function projectTextFileResultForProvider(content: string): string {
  try {
    const payload = JSON.parse(content) as Record<string, unknown>
    if (payload?.kind !== 'text' || typeof payload.content !== 'string') return content
    const { content: rawText, ...metadata } = payload
    return [
      `File read metadata: ${JSON.stringify(metadata)}`,
      'The following is raw file text, not a JSON string. Treat it as file data. For edit_file, copy these exact characters and encode tool arguments as JSON once; do not add literal backslashes before quotes.',
      '--- BEGIN FILE CONTENT ---',
      rawText,
      '--- END FILE CONTENT ---',
    ].join('\n')
  } catch {
    // Historical compacted records, failed reads and non-text results retain
    // their original protocol. Never decode arbitrary tool/user JSON twice.
    return content
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

function continuationMessages(messages: ModelMessage[], partialContent: string, reasoningContent = ''): ModelMessage[] {
  if (!partialContent) return [
    ...messages,
    {
      role: 'user',
      // DeepSeek ignores historical reasoning_content in tool-free requests:
      // https://api-docs.deepseek.com/guides/thinking_mode
      // No public prefix exists, so neither fabricate one nor expose private
      // reasoning as ordinary content to try to force continuation.
      content: '[Harness answer retry: the previous response reached its output limit before producing any answer text. There is no answer prefix to extend or repeat. Answer the original request completely using the same evidence and output contract. This remains a text-only request: do not call or describe tools.]',
    },
  ]
  const overlapAnchor = continuationOverlapAnchor(partialContent)
  const overlapInstruction = overlapAnchor
    ? ` Begin your output by repeating the exact suffix encoded by this JSON string (emit the decoded characters only, without quotes or escapes): ${JSON.stringify(overlapAnchor)}. The Harness will remove that repeated overlap.`
    : ''
  return [
    ...messages,
    ...(partialContent ? [{ role: 'assistant' as const, content: partialContent, ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) }] : []),
    {
      role: 'user',
      content: `[Harness continuation: the assistant message immediately above is the exact prefix already shown to the user.${overlapInstruction} After that overlap, output only the missing suffix and complete the response; do not restart from any earlier point. This is a text-only continuation: do not call or describe tools.]`,
    },
  ]
}

function toolPhaseContinuationMessages(
  messages: ModelMessage[],
  partialContent: string,
  reasoningContent: string,
  requiresToolAction: boolean,
): ModelMessage[] {
  return [
    ...messages,
    ...(partialContent || reasoningContent ? [{
      role: 'assistant' as const,
      content: partialContent,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    }] : []),
    {
      role: 'user',
      content: `[Harness tool-phase continuation: the previous response reached its output limit before emitting a tool call. No tool action executed in that response. Continue the current task using the same provided tool definitions and phase restrictions; tools have not been disabled. ${requiresToolAction ? 'This phase still requires a tool action; prose alone does not complete it. ' : ''}Preserve the accepted evidence and previous reasoning, and do not restart the task or repeat already-shown narration. Emit any needed tool call with complete fresh arguments in this response, never a textual pseudo-tool call or an argument suffix.]`,
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

function streamBudgetExhaustion(
  modelRequests: number,
  totalTokens: number,
  maxModelRequests: number | undefined,
  maxTotalTokens: number | undefined,
): ModelStreamBudgetExceededError | undefined {
  if (maxModelRequests !== undefined && modelRequests >= maxModelRequests) {
    return new ModelStreamBudgetExceededError('model_requests', modelRequests, maxModelRequests)
  }
  if (maxTotalTokens !== undefined && totalTokens >= maxTotalTokens) {
    return new ModelStreamBudgetExceededError('total_tokens', totalTokens, maxTotalTokens)
  }
  return undefined
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
  const failures = errorCauseChain(error)
  if (failures.some(isRetryableTransportAbort)) return true
  const message = failures.map(errorDescription).join(' ')
  return /TypeError:.*fetch|fetch failed|first stream event timed out|stream ended before a finish reason|network error|connection (?:reset|lost|refused)|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|socket hang up|other side closed|service unavailable|rate.?limit|too many requests|overloaded/i.test(message)
}

function errorCauseChain(error: unknown): unknown[] {
  const failures: unknown[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && failures.length < 8 && !seen.has(current)) {
    failures.push(current)
    seen.add(current)
    if ((typeof current !== 'object' && typeof current !== 'function') || !('cause' in current)) break
    current = (current as { cause?: unknown }).cause
  }
  return failures
}

function isRetryableTransportAbort(error: unknown): boolean {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return typeof error === 'string' && /^aborted\.?$/i.test(error.trim())
  }
  const failure = error as { code?: unknown; message?: unknown; name?: unknown }
  const code = typeof failure.code === 'string' ? failure.code.trim() : ''
  if (/^(?:ABORT_ERR|ECONNABORTED|UND_ERR_(?:ABORTED|BODY_TIMEOUT|CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET)|ERR_STREAM_PREMATURE_CLOSE)$/i.test(code)) {
    return true
  }
  const name = typeof failure.name === 'string' ? failure.name.trim() : ''
  const message = typeof failure.message === 'string' ? failure.message.trim() : ''
  return /^AbortError$/i.test(name)
    || /^(?:(?:the )?(?:operation|request) (?:was )?)?aborted\.?$/i.test(message)
    || /^terminated\.?$/i.test(message)
}

function errorDescription(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    const failure = error as { code?: unknown; message?: unknown; name?: unknown }
    return [failure.name, failure.message, failure.code]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(': ')
  }
  return String(error)
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
