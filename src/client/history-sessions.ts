import type { SessionSummary } from '../shared/types'

export function mergeSessionMetadata(current: SessionSummary | undefined, incoming: SessionSummary): SessionSummary {
  if (!current || (incoming.metadataVersion ?? 0) >= (current.metadataVersion ?? 0)) return incoming
  // A snapshot already in flight must not undo a completed rename or archive.
  return { ...incoming, title: current.title, archivedAt: current.archivedAt, metadataVersion: current.metadataVersion }
}

export function updateHistorySession(sessions: SessionSummary[], incoming: SessionSummary): SessionSummary[] {
  if (sessions.some((session) => session.id === incoming.id)) {
    return sessions.map((session) => session.id === incoming.id ? mergeSessionMetadata(session, incoming) : session)
  }
  const index = sessions.findIndex((session) => session.updatedAt < incoming.updatedAt)
  const next = [...sessions]
  next.splice(index < 0 ? next.length : index, 0, incoming)
  return next
}
