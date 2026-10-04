import { Archive, Check, Clock3 } from 'lucide-react'
import type { SteeringMessage } from '../shared/steering'

/** A late HTTP receipt or replay must never regress an applied instruction. */
export function mergeSteeringMessages(current: readonly SteeringMessage[], incoming: readonly SteeringMessage[]): SteeringMessage[] {
  const rank = { received: 0, applied: 1, archived: 2 }
  const messages = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) {
    const previous = messages.get(message.id)
    messages.set(message.id, previous && rank[previous.status] > rank[message.status] ? previous : message)
  }
  return [...messages.values()].sort((left, right) => left.sequence - right.sequence)
}

export function visibleSteeringMessages(messages: readonly SteeringMessage[], undoneTurnIds: ReadonlySet<string>): SteeringMessage[] {
  return messages.filter((message) => {
    const turnId = message.status === 'applied' ? message.appliedTurnId : message.receivedTurnId
    return !turnId || !undoneTurnIds.has(turnId)
  })
}

export function SteeringUpdates({ messages, paused = false }: { messages: readonly SteeringMessage[]; paused?: boolean }) {
  if (messages.length === 0) return null
  const pending = messages.filter((message) => message.status === 'received').length
  const applied = messages.filter((message) => message.status === 'applied').length
  const archived = messages.filter((message) => message.status === 'archived').length
  return <details className="steering-updates" open={pending > 0 || undefined}>
    <summary>
      <span>Additional instructions</span>
      <span role="status">{pending > 0 ? `${pending} received · ${paused ? 'waiting to resume' : 'waiting to apply'}` : [applied ? `${applied} applied` : '', archived ? `${archived} archived` : ''].filter(Boolean).join(' · ')}</span>
    </summary>
    <ol>
      {messages.map((message) => <li key={message.id} data-steering-id={message.id}>
        <span className={`steering-state ${message.status}`}>
          {message.status === 'archived' ? <Archive size={12} aria-hidden="true" /> : message.status === 'applied' ? <Check size={12} aria-hidden="true" /> : <Clock3 size={12} aria-hidden="true" />}
          {message.status === 'archived' ? 'Archived after restore' : message.status === 'applied' ? 'Applied' : 'Received'}
        </span>
        <p>{message.content}</p>
      </li>)}
    </ol>
  </details>
}
