import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ModelMessage, SessionEvent } from '../shared/types.js'
import { activeTaskMessageSlice, recoverActiveReferenceSourceResolution, recoverActiveTaskResearchEvidence,
  recoverActiveTaskRequestText, recoverActiveVisualArtifact } from './agent-service.js'
import { activeTaskEvidenceEvents } from './verification-context.js'
import { bindTaskVerification } from './task-verification.js'

function event(type: SessionEvent['type'], data: Record<string, unknown>, seq: number, turnId = 'turn_original'): SessionEvent {
  return { id: `evt_${seq}`, seq, sessionId: 'ses_test', type, data, turnId, at: '2026-09-26T10:00:00Z' }
}
const restore = event('workspace.version.restored', { restoreId: 'wsr_aaaaaaaaaaaaaaaaaaaa' }, 10)
const continued = event('turn.started', { content: 'Continue' }, 11, 'turn_continue')
function terminal(name: string, args: Record<string, unknown>, payload: Record<string, unknown>, seq: number): SessionEvent {
  const callId = `call_${seq}`
  return { ...event('tool.completed', { call: { id: callId, name, arguments: args }, result: JSON.stringify(payload), isError: false }, seq), callId }
}
const html = '<!doctype html><html><head><style>:root{--ink:#112233;--paper:#f8f4e8}body{display:grid;color:#112233;background:#f8f4e8;font-family:Inter,sans-serif}.paper{grid-template-columns:1fr 2fr;gap:24px}</style></head><body><main class="paper">Reference</main></body></html>'

describe('workspace restore evidence generation', () => {
  it('archives old requirements and clears research and artifact receipts while preserving real history', () => {
    const task = event('turn.started', { content: 'Research the deployment options and create a comparison.' }, 1)
    const search = terminal('web_search', { query: 'deployment options' }, { status: 'success', results: [{ url: 'https://example.com/old', title: 'Old result' }] }, 2)
    const artifact = terminal('write_file', { path: 'comparison.html', content: html }, {
      status: 'success', path: 'comparison.html', canonical_html: true, hash: createHash('sha256').update(html).digest('base64url'),
    }, 3)
    const before = [task, search, artifact]
    expect(recoverActiveTaskResearchEvidence(before).sourceUrls).toEqual(['https://example.com/old'])
    expect(recoverActiveVisualArtifact(before)?.canonicalWriteCallId).toBe('call_3')
    const history = [...before, restore, continued]
    expect(recoverActiveTaskResearchEvidence(history)).toEqual({ schemaVersion: 1, sourceUrls: [], toolCallIds: [] })
    expect(recoverActiveVisualArtifact(history)).toBeUndefined()
    expect(recoverActiveTaskRequestText(history)).toBe('Continue')
    expect(history.slice(0, 3)).toEqual(before)
    const fresh = terminal('web_search', { query: 'deployment options updated' }, { status: 'success', results: [{ url: 'https://example.com/fresh', title: 'New result' }] }, 12)
    const freshArtifact = { ...artifact, id: 'evt_13', seq: 13, callId: 'call_13', data: { ...artifact.data,
      call: { id: 'call_13', name: 'write_file', arguments: { path: 'comparison.html', content: html } } } }
    expect(recoverActiveTaskResearchEvidence([...history, fresh]).sourceUrls).toEqual(['https://example.com/fresh'])
    expect(recoverActiveVisualArtifact([...history, freshArtifact])?.canonicalWriteCallId).toBe('call_13')
  })

  it('archives the old style request and binds only fresh acquisition after the user explicitly requests that style again', () => {
    const identity = 'https://github.com/example/beautiful-templates#paper'
    const url = 'https://raw.githubusercontent.com/example/beautiful-templates/HEAD/templates/paper/index.html'
    const task = event('turn.started', { content: `严格参考 ${identity} 的设计制作 HTML。` }, 1)
    const fetch = terminal('fetch_page', { url, chunkIndex: 0, format: 'raw' }, {
      status: 'success', url, content: html, chunkIndex: 0, hasMore: false, totalChunks: 1,
    }, 2)
    expect(recoverActiveReferenceSourceResolution([task, fetch])?.bound?.callIds).toEqual(['call_2'])
    const history = [task, fetch, restore, continued]
    expect(recoverActiveReferenceSourceResolution(history)).toBeUndefined()
    expect(recoverActiveTaskRequestText(history)).toBe('Continue')
    const renewed = event('turn.started', { content: `继续制作，严格参考 ${identity} 的设计。` }, 12, 'turn_renewed')
    expect(recoverActiveReferenceSourceResolution([...history, renewed])).toMatchObject({ identityUrl: identity, totalAttempts: 0, attempts: [], rejected: [] })
    const freshFetch = terminal('fetch_page', { url, chunkIndex: 0, format: 'raw' }, {
      status: 'success', url, content: html, chunkIndex: 0, hasMore: false, totalChunks: 1,
    }, 13)
    expect(recoverActiveReferenceSourceResolution([...history, freshFetch])).toBeUndefined()
    expect(recoverActiveReferenceSourceResolution([...history, renewed, freshFetch])?.bound?.callIds).toEqual(['call_13'])
    expect(recoverActiveTaskRequestText([...history, renewed])).toBe(`Continue\n\n${renewed.data.content}`)
  })

  it('uses the restore marker as a message evidence boundary while retaining the original conversation', () => {
    const initial: ModelMessage = { role: 'user', content: 'Compare deployment choices.' }
    const old: ModelMessage = { role: 'tool', content: 'An old verification result', tool_call_id: 'old' }
    const marker: ModelMessage = { role: 'user', content: '[Workspace restored: wsr_aaaaaaaaaaaaaaaaaaaa]\nThe user restored a workspace version. History is retained.' }
    const continuation: ModelMessage = { role: 'user', content: 'Continue' }
    const fresh: ModelMessage = { role: 'tool', content: 'A fresh verification result', tool_call_id: 'fresh' }
    const messages = [initial, old, marker, continuation, fresh]
    expect(activeTaskMessageSlice(messages)).toEqual([marker, continuation, fresh])
    expect(messages).toHaveLength(5)
    const next: ModelMessage = { role: 'user', content: 'Start a new calculation.' }
    expect(activeTaskMessageSlice([...messages, next])).toEqual([next])
  })

  it('rejects pre-restore or other-task call IDs at finish_task while admitting newly observed results', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-restored-receipts-'))
    const task = event('turn.started', { content: 'Verify the result.' }, 1)
    const old = terminal('bash', { command: 'test result' }, { status: 'completed', exit_code: 0 }, 2)
    const priorReceipt = event('task.verification.completed', { outcome: 'completed' }, 3)
    const fresh = terminal('bash', { command: 'test result again' }, { status: 'completed', exit_code: 0 }, 12)
    const check = (callId: string) => ({ outcome: 'completed', summary: 'Verified.', checks: [{ requirement: 'Verify the result',
      method: 'Execute the check', required: true, status: 'passed', evidence: { callIds: [callId] } }] })
    const scope = (events: SessionEvent[]) => activeTaskEvidenceEvents(events, (content) => content === 'Continue')
    try {
      const events = scope([task, old, priorReceipt, restore, continued, fresh])
      expect(events).not.toContain(priorReceipt)
      await expect(bindTaskVerification(check('call_2'), { task: 'Verify the result.', workspace, events })).rejects.toThrow('no durable terminal')
      expect((await bindTaskVerification(check('call_12'), { task: 'Verify the result.', workspace, events })).eventEvidence[0].eventId).toBe('evt_12')
      const newTask = event('turn.started', { content: 'Compute a separate result.' }, 13, 'turn_new')
      await expect(bindTaskVerification(check('call_12'), { task: 'Compute a separate result.', workspace,
        events: scope([...events, newTask]) })).rejects.toThrow('no durable terminal')
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})
