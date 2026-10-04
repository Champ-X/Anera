import type { ModelMessage } from '../shared/types.js'
import { MAX_STEERING_CONTENT_LENGTH, type SteeringMessage } from '../shared/steering.js'
import { escapeUntrustedArenaControlText } from './user-control-text.js'

export interface DurableSteeringMessage extends SteeringMessage {
  receivedEventId: string
  appliedEventId: string
  archivedEventId?: string
  /** A queued correction is applied before the newer normal submit message. */
  appliedBeforeTurnStart?: boolean
  appliedStepId?: string
  timezone?: string
}

export class SteeringPendingError extends Error {
  constructor() { super('Pending user instructions must be applied before completing the task.') }
}

export function steeringError(message: string, code: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode })
}

export function parseSteeringInput(input: unknown): { content: string; clientMessageId: string } {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > MAX_STEERING_CONTENT_LENGTH) {
    throw steeringError(`content must contain 1–${MAX_STEERING_CONTENT_LENGTH} characters`, 'invalid_steering_content', 400)
  }
  if (typeof value.clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.clientMessageId)) {
    throw steeringError('clientMessageId must contain 1–128 letters, digits, underscores or hyphens', 'invalid_steering_client_id', 400)
  }
  return { content: value.content, clientMessageId: value.clientMessageId }
}

export function publicSteeringMessage(value: DurableSteeringMessage): SteeringMessage {
  const { receivedEventId: _received, appliedEventId: _applied, archivedEventId: _archived,
    appliedBeforeTurnStart: _beforeStart, appliedStepId: _step, timezone: _timezone, ...message } = value
  return message
}

export const STEERING_MESSAGE_PREFIX = '[Harness user steering: continue the current task]'

export function steeringModelMessage(value: SteeringMessage): ModelMessage {
  return { role: 'user', content: `${STEERING_MESSAGE_PREFIX}\nThe following is a user-authored addition or correction, received in order as instruction ${value.sequence}. Apply it to subsequent work and acceptance. A later correction takes precedence where it changes an earlier requirement. Preserve completed work that remains valid; do not repeat completed operations or claim that an operation already in progress was undone.\n\n${escapeUntrustedArenaControlText(value.content)}` }
}

/** Never insert a user message inside an unfinished assistant/tool protocol frame. */
export function modelToolFrameIsClosed(messages: readonly ModelMessage[]): boolean {
  let pending: string[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      if (pending.length > 0) return false
      pending = message.tool_calls.map((call) => call.id)
    }
    else if (message.role === 'tool' && message.tool_call_id) {
      const position = pending.indexOf(message.tool_call_id)
      if (position >= 0) pending.splice(position, 1)
    }
  }
  return pending.length === 0
}
