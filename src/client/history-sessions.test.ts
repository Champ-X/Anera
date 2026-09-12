import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../shared/types'
import { mergeSessionMetadata, updateHistorySession } from './history-sessions'

function session(id: string, date: string): SessionSummary {
  return {
    id, title: id, createdAt: date, updatedAt: date, status: 'completed', model: 'fixture', workspaceBytes: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0, estimatedCostUsd: 0, modelCalls: 0, toolCalls: 0 },
  }
}

describe('stable conversation history', () => {
  const recent = session('recent', '2026-09-12T10:00:00.000Z')
  const older = session('older', '2026-09-11T10:00:00.000Z')
  const oldest = session('oldest', '2026-09-10T10:00:00.000Z')

  it('updates opened conversations in place, including repeated snapshot refreshes', () => {
    const baseline = [recent, older, oldest]
    let result = baseline
    for (const opened of [oldest, older, oldest]) result = updateHistorySession(result, { ...opened, workspaceBytes: 42 })
    expect(result.map((item) => item.id)).toEqual(['recent', 'older', 'oldest'])
    expect(result[2].workspaceBytes).toBe(42)
    expect(baseline[2].workspaceBytes).toBe(0)
  })

  it('inserts unseen sessions by activity date without moving existing rows', () => {
    expect(updateHistorySession([recent, oldest], older).map((item) => item.id)).toEqual(['recent', 'older', 'oldest'])
    expect(updateHistorySession([older, oldest], recent)[0]).toBe(recent)
  })

  it('keeps edits when a snapshot from before rename/archive arrives late', () => {
    const edited = { ...older, title: '用户命名', archivedAt: '2026-09-12T12:00:00.000Z', metadataVersion: 2 }
    const merged = updateHistorySession([recent, edited, oldest], { ...older, status: 'running', workspaceBytes: 99 })
    expect(merged[1]).toMatchObject({ title: '用户命名', archivedAt: edited.archivedAt, metadataVersion: 2, status: 'running', workspaceBytes: 99 })
    const restored = { ...edited, archivedAt: undefined, metadataVersion: 3 }
    expect(mergeSessionMetadata(edited, restored).archivedAt).toBeUndefined()
    expect(mergeSessionMetadata(restored, edited).archivedAt).toBeUndefined()
  })
})
