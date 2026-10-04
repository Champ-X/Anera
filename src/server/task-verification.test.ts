import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bindTaskVerification, parseTaskVerification, taskVerificationFilesCurrent } from './task-verification.js'
import type { SessionEvent } from '../shared/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function workspace() { const root = await mkdtemp(resolve(tmpdir(), 'anera-verification-')); roots.push(root); return root }
const check = { requirement: 'Provide the requested result', method: 'Compare the result with the input', required: true,
  status: 'passed', evidence: {} }
const report = { outcome: 'completed', summary: 'Done.', checks: [check] }
const event: SessionEvent = { id: 'evt_actual', seq: 1, at: '2026-09-26T10:00:00Z', sessionId: 'ses_test',
  turnId: 'turn_task', callId: 'call_actual', type: 'tool.completed', data: { output: 'Actual observation' } }

describe('agent-selected task verification', () => {
  it('accepts reasoning-only methods without inventing a tool requirement', () => {
    expect(parseTaskVerification(report).checks[0].method).toBe(check.method)
  })
  it('distinguishes optional observation gaps from unresolved core requirements', () => {
    expect(parseTaskVerification({ ...report, checks: [{ ...check, required: false, status: 'unverified' }] }).outcome).toBe('completed')
    expect(() => parseTaskVerification({ ...report, checks: [{ ...check, status: 'unverified' }] })).toThrow('core check')
    expect(parseTaskVerification({ ...report, outcome: 'limited', checks: [{ ...check, status: 'failed' }] }).outcome).toBe('limited')
  })
  it('rejects non-string enums instead of coercing them past core-check validation', () => {
    expect(() => parseTaskVerification({ ...report, outcome: ['completed'],
      checks: [{ ...check, status: 'failed' }],
    })).toThrow('completed/limited outcome')
    expect(() => parseTaskVerification({ ...report, checks: [{ ...check, status: ['passed'] }] })).toThrow('Each check needs')
  })
  it('binds actual task evidence and detects content edits without invalidating unchanged files', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'result.anything'), 'original')
    const receipt = await bindTaskVerification({ ...report, checks: [{ ...check, evidence: { callIds: ['call_actual'], paths: ['result.anything'] } }] },
      { task: 'Provide the requested result', workspace: root, events: [event] })
    expect(receipt.eventEvidence[0].eventId).toBe(event.id)
    expect(await taskVerificationFilesCurrent(receipt, root)).toBe(true)
    await writeFile(resolve(root, 'unrelated'), 'change')
    expect(await taskVerificationFilesCurrent(receipt, root)).toBe(true)
    await writeFile(resolve(root, 'result.anything'), 'changed')
    expect(await taskVerificationFilesCurrent(receipt, root)).toBe(false)
    const revised = await bindTaskVerification(report, { task: 'Revised requirement', workspace: root, events: [event] })
    expect(revised.taskSha256).not.toBe(receipt.taskSha256)
  })
  it('rejects invented/cross-task call IDs and references to unfinished operations', async () => {
    const root = await workspace()
    for (const events of [[], [{ ...event, type: 'tool.started' as const }]]) {
      await expect(bindTaskVerification({ ...report, checks: [{ ...check, evidence: { callIds: ['call_actual'] } }] },
        { task: 'task', workspace: root, events })).rejects.toThrow('no durable terminal')
    }
  })
  it('allows expected failures as evidence without confusing a tool error with a failed user requirement', async () => {
    const root = await workspace()
    const receipt = await bindTaskVerification({ ...report, checks: [{ ...check, method: 'Invalid input is rejected as requested', evidence: { callIds: ['call_actual'] } }] },
      { task: 'task', workspace: root, events: [{ ...event, type: 'tool.failed' }] })
    expect(receipt.outcome).toBe('completed')
  })
  it('accepts the same public workspace paths as file tools and binds aliases to one file', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'result.data'), 'current')
    const receipt = await bindTaskVerification({ ...report, checks: [{ ...check,
      evidence: { paths: ['/home/user/result.data', '~/result.data', './result.data'], callIds: ['call_actual'] },
    }] }, { task: 'task', workspace: root, events: [event] })
    expect(receipt.checks[0].evidence.paths).toEqual(['result.data'])
    expect(receipt.fileEvidence).toEqual([expect.objectContaining({ path: 'result.data', bytes: 7 })])
    expect(await taskVerificationFilesCurrent(receipt, root)).toBe(true)
    await writeFile(resolve(root, 'result.data'), 'changed')
    expect(await taskVerificationFilesCurrent(receipt, root)).toBe(false)
  })
  it('rejects stale byte attestations even when an external edit has no file.changed event', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'result.data'), 'new bytes')
    const observed = { ...event, data: { fileEvidence: { version: 1, path: 'result.data', bytes: 9,
      sha256: createHash('sha256').update('old bytes').digest('hex'), verifier: 'attachment-extractor-v1' } } }
    await expect(bindTaskVerification({ ...report, checks: [{ ...check,
      evidence: { paths: ['result.data'], callIds: ['call_actual'] },
    }] }, { task: 'task', workspace: root, events: [observed] })).rejects.toThrow('different file bytes')
  })
  it('downgrades only the check tied to stale observed bytes and retains their provenance', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'result.data'), 'new bytes')
    const observed = { ...event, data: { fileEvidence: { version: 1, path: '/home/user/result.data', bytes: 9,
      sha256: createHash('sha256').update('old bytes').digest('hex'), verifier: 'attachment-extractor-v1' } } }
    const receipt = await bindTaskVerification({ ...report, checks: [
      { ...check, required: false, evidence: { paths: ['result.data'], callIds: ['call_actual'] } },
      check,
    ] }, { task: 'task', workspace: root, events: [observed] })
    expect(receipt.outcome).toBe('completed')
    expect(receipt.checks.map((item) => item.status)).toEqual(['unverified', 'passed'])
    expect(receipt.mismatchedFileEvidence).toEqual([{ checkIndex: 0, path: 'result.data', callId: 'call_actual',
      eventId: 'evt_actual', eventSeq: 1, observedBytes: 9, observedSha256: observed.data.fileEvidence.sha256 }])
    expect(receipt.checks[0].note).toContain('different file bytes')
    const limited = await bindTaskVerification({ ...report, outcome: 'limited', checks: [
      { ...check, evidence: { paths: ['result.data'], callIds: ['call_actual'] } },
    ] }, { task: 'task', workspace: root, events: [observed] })
    expect(limited.checks[0].status).toBe('unverified')
  })
  it('uses the newest selected private byte observation and never trusts a public lookalike', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'result.data'), 'new bytes')
    const fileEvidence = { version: 1, path: 'result.data', bytes: 9,
      sha256: createHash('sha256').update('old bytes').digest('hex'), verifier: 'attachment-extractor-v1' }
    const observed = { ...event, data: { fileEvidence } }
    const fresh = { ...event, seq: 2, id: 'evt_fresh', callId: 'call_fresh', data: { fileEvidence: {
      ...fileEvidence, sha256: createHash('sha256').update('new bytes').digest('hex'),
    } } }
    const selected = { ...report, checks: [{ ...check, evidence: { paths: ['result.data'], callIds: ['call_fresh', 'call_actual'] } }] }
    const current = await bindTaskVerification(selected, { task: 'task', workspace: root, events: [observed, fresh] })
    expect(current.checks[0].status).toBe('passed')
    expect(current.mismatchedFileEvidence).toBeUndefined()
    const publicLookalike = { ...fresh, data: { result: JSON.stringify({ fileEvidence: fresh.data.fileEvidence }) } }
    await expect(bindTaskVerification(selected, { task: 'task', workspace: root, events: [observed, publicLookalike] })).rejects.toThrow('different file bytes')
  })
  it.each([
    { notExecuted: true }, { not_executed: true }, { cancelled: true },
    { result: JSON.stringify({ notExecuted: true, status: 'deferred' }) },
    { result: JSON.stringify({ not_executed: true, status: 'verification_required' }) },
    { result: JSON.stringify({ cancelled: true }) },
    { result: JSON.stringify({ status: 'cancelled' }) },
    { status: 'not_executed' }, { result: JSON.stringify({ status: 'not_executed' }) },
  ])('rejects explicitly unexecuted or cancelled observations: %j', async (data) => {
    const root = await workspace()
    await expect(bindTaskVerification({ ...report, checks: [{ ...check, evidence: { callIds: ['call_actual'] } }] },
      { task: 'task', workspace: root, events: [{ ...event, data }] })).rejects.toThrow('was not executed or was cancelled')
    const actualFailure = { ...event, type: 'tool.failed' as const, data: { isError: true, result: JSON.stringify({ status: 'error', exit_code: 1 }) } }
    expect((await bindTaskVerification({ ...report, checks: [{ ...check, evidence: { callIds: ['call_actual'] } }] },
      { task: 'task', workspace: root, events: [actualFailure] })).checks[0].status).toBe('passed')
  })

  it('rejects a required pass using a known earlier file revision and admits a newer related observation', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'result.data'), 'the revised data')
    const changed: SessionEvent = { ...event, id: 'evt_changed', seq: 2, type: 'file.changed', callId: undefined, data: { path: './result.data', operation: 'updated' } }
    const request = { ...report, checks: [{ ...check, evidence: { paths: ['result.data'], callIds: ['call_actual'] } }] }
    await expect(bindTaskVerification(request, { task: 'task', workspace: root, events: [event, changed] })).rejects.toThrow('Verify only the affected file/check')
    const fresh = { ...event, id: 'evt_fresh', callId: 'call_fresh', seq: 3 }
    const receipt = await bindTaskVerification({ ...request, checks: [{ ...check, evidence: { paths: ['result.data'], callIds: ['call_fresh'] } }] },
      { task: 'task', workspace: root, events: [event, changed, fresh] })
    expect(receipt.checks[0].status).toBe('passed')
    expect(receipt.staleFileEvidence).toBeUndefined()
    expect(receipt.eventEvidence[0].eventId).toBe('evt_fresh')
  })

  it('preserves valid checks after unrelated file changes and does not invent undeclared path dependencies', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'result.data'), 'valid')
    const changed: SessionEvent = { ...event, id: 'evt_other', seq: 2, type: 'file.changed', callId: undefined, data: { path: 'unrelated.data' } }
    const receipt = await bindTaskVerification({ ...report, checks: [{ ...check, evidence: { paths: ['result.data'], callIds: ['call_actual'] } }] },
      { task: 'task', workspace: root, events: [event, changed] })
    expect(receipt.checks[0].status).toBe('passed')
    expect(receipt.staleFileEvidence).toBeUndefined()
    const reasoned = await bindTaskVerification({ ...report, checks: [{ ...check, evidence: { paths: ['result.data'] } }] },
      { task: 'task', workspace: root, events: [{ ...changed, data: { path: 'result.data' } }] })
    expect(reasoned.checks[0].status).toBe('passed')
  })

  it('downgrades only stale optional passes and permits truthful limited delivery of a stale core result', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'changed.data'), 'changed')
    await writeFile(resolve(root, 'valid.data'), 'valid')
    const changed: SessionEvent = { ...event, id: 'evt_changed', seq: 2, type: 'file.changed', callId: undefined, data: { path: 'changed.data' } }
    const checks = [
      { ...check, required: false, note: 'Earlier inspection passed.', evidence: { paths: ['changed.data'], callIds: ['call_actual'] } },
      { ...check, evidence: { paths: ['valid.data'], callIds: ['call_actual'] } },
    ]
    const receipt = await bindTaskVerification({ ...report, checks }, { task: 'task', workspace: root, events: [event, changed] })
    expect(receipt.outcome).toBe('completed')
    expect(receipt.checks.map((item) => item.status)).toEqual(['unverified', 'passed'])
    expect(receipt.checks[0].note).toContain('changed after this check\'s last cited observation')
    expect(receipt.checks[0].note).toContain('Earlier inspection passed.')
    expect(checks[0].status).toBe('passed')
    expect(receipt.staleFileEvidence).toEqual([{ checkIndex: 0, path: 'changed.data', lastObservationSeq: 1, changeEventId: 'evt_changed', changeEventSeq: 2 }])
    const limited = await bindTaskVerification({ ...report, outcome: 'limited', checks: [{ ...checks[0], required: true }] },
      { task: 'task', workspace: root, events: [event, changed] })
    expect(limited.outcome).toBe('limited')
    expect(limited.checks[0].status).toBe('unverified')
  })

  it.each(['failed', 'unverified', 'not_needed'] as const)('records missing file evidence honestly for a %s check', async (status) => {
    const root = await workspace()
    const receipt = await bindTaskVerification({ ...report, outcome: 'limited', checks: [{ ...check, status,
      evidence: { paths: ['missing.data'] }, note: 'The requested output is unavailable.' }] }, { task: 'task', workspace: root, events: [] })
    expect(receipt.checks[0].status).toBe(status)
    expect(receipt.fileEvidence).toEqual([])
    expect(receipt.unavailableFileEvidence).toEqual([{ path: 'missing.data', reason: 'missing', checkIndexes: [0] }])
    expect(await taskVerificationFilesCurrent(receipt, root)).toBe(true)
    await writeFile(resolve(root, 'missing.data'), 'now present')
    const available = await bindTaskVerification({ ...report, outcome: 'limited', checks: [{ ...check, status, evidence: { paths: ['missing.data'] } }] },
      { task: 'task', workspace: root, events: [] })
    expect(available.unavailableFileEvidence).toBeUndefined()
    expect(available.evidenceSha256).not.toBe(receipt.evidenceSha256)
    expect(available.checks[0].status).toBe(status)
  })

  it('rejects a missing path used by any passing check even if another check honestly reports the gap', async () => {
    const root = await workspace()
    await expect(bindTaskVerification({ ...report, outcome: 'limited', checks: [
      { ...check, status: 'unverified', evidence: { paths: ['missing.data'] } },
      { ...check, required: false, evidence: { paths: ['./missing.data'] } },
    ] }, { task: 'task', workspace: root, events: [] })).rejects.toThrow('A passed check cannot cite unavailable file bytes')
  })

  it('does not force creation of a deleted optional output merely to record why it is unverified', async () => {
    const root = await workspace()
    const deleted: SessionEvent = { ...event, id: 'evt_deleted', seq: 2, type: 'file.changed', callId: undefined, data: { path: 'deleted.data', operation: 'deleted' } }
    const receipt = await bindTaskVerification({ ...report, checks: [{ ...check, required: false,
      evidence: { paths: ['deleted.data'], callIds: ['call_actual'] } }] }, { task: 'task', workspace: root, events: [event, deleted] })
    expect(receipt.checks[0].status).toBe('unverified')
    expect(receipt.outcome).toBe('completed')
    expect(receipt.unavailableFileEvidence?.[0].reason).toBe('missing')
  })

  it('rechecks only file identities that the receipt still reports as passing', async () => {
    const root = await workspace()
    await writeFile(resolve(root, 'optional.data'), 'an uncertain result')
    await writeFile(resolve(root, 'required.data'), 'verified result')
    const receipt = await bindTaskVerification({ ...report, checks: [
      { ...check, required: false, status: 'unverified', evidence: { paths: ['optional.data'] } },
      { ...check, evidence: { paths: ['./required.data'] } },
    ] }, { task: 'task', workspace: root, events: [] })
    await writeFile(resolve(root, 'optional.data'), 'changed, still unverified')
    expect(await taskVerificationFilesCurrent(receipt, root)).toBe(true)
    expect(receipt.checks[0].status).toBe('unverified')
    await writeFile(resolve(root, 'required.data'), 'changed after verification')
    expect(await taskVerificationFilesCurrent(receipt, root)).toBe(false)
  })
  it('rejects path escapes and symlinks while retaining the source files', async () => {
    const root = await workspace()
    await symlink('/etc/hosts', resolve(root, 'linked'))
    for (const path of ['../../etc/hosts', 'linked', '/home/user/../../etc/hosts', '~/../outside', '/etc/hosts']) {
      await expect(bindTaskVerification({ ...report, checks: [{ ...check, evidence: { paths: [path] } }] },
        { task: 'task', workspace: root, events: [] })).rejects.toThrow()
    }
  })
})
