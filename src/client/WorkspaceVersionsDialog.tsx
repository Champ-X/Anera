import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, History, LoaderCircle, RotateCcw, Save, X } from 'lucide-react'
import type { WorkspaceVersionChange, WorkspaceVersionDiff, WorkspaceVersionList, WorkspaceVersionSummary } from '../shared/workspace-versions'
import { api } from './api'

const dateLabel = (date: string) => new Date(date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const errorLabel = (error: unknown) => error instanceof Error ? error.message : String(error)

export function workspaceVersionReason(reason: WorkspaceVersionSummary['reason']): string {
  return reason === 'delivery' ? 'Delivery' : reason === 'before_restore' ? 'Before restore' : 'Saved version'
}

export function WorkspaceVersionChanges({ diff }: { diff: WorkspaceVersionDiff }) {
  return <div className="version-diff">
    <p className="version-diff-summary">{diff.added} added · {diff.modified} modified · {diff.deleted} deleted</p>
    {diff.changes.length === 0 ? <p className="version-empty">The saved files match this comparison.</p> : <ul>
      {diff.changes.map((change) => <li key={change.path}><VersionFileChange change={change} /></li>)}
    </ul>}
  </div>
}

function VersionFileChange({ change }: { change: WorkspaceVersionChange }) {
  const hasText = change.beforeText !== undefined || change.afterText !== undefined
  return <details className="version-file-change">
    <summary><span className={`version-change-kind ${change.kind}`}>{change.kind}</span><code>{change.path}</code></summary>
    {hasText ? <div className="version-file-columns">
      <div><strong>Saved version</strong><pre tabIndex={0} aria-label={`Saved version of ${change.path}`}><code>{change.beforeText ?? (change.before ? '(text preview unavailable)' : '(file absent)')}</code></pre></div>
      <div><strong>Comparison</strong><pre tabIndex={0} aria-label={`Comparison version of ${change.path}`}><code>{change.afterText ?? (change.after ? '(text preview unavailable)' : '(file absent)')}</code></pre></div>
    </div> : <p className="version-file-note">Content comparison is unavailable for this file. {change.before?.bytes ?? 0} → {change.after?.bytes ?? 0} bytes.</p>}
    {change.textTruncated && <p className="version-file-note">Text preview is shortened. The saved version contains the full file.</p>}
    {change.before && change.after && change.before.mode !== change.after.mode && <p className="version-file-note">File permissions changed: {change.before.mode.toString(8)} → {change.after.mode.toString(8)}.</p>}
  </details>
}

export function WorkspaceVersionsDialog(props: {
  sessionId: string
  busy: boolean
  onClose: () => void
  onRestored: (continueEditing: boolean) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(false)
  const titleId = useId()
  const labelId = useId()
  const fromId = useId()
  const againstId = useId()
  const [list, setList] = useState<WorkspaceVersionList>()
  const [selectedId, setSelectedId] = useState('')
  const [against, setAgainst] = useState('current')
  const [comparison, setComparison] = useState<{ key: string; diff: WorkspaceVersionDiff }>()
  const [label, setLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [diffLoading, setDiffLoading] = useState(false)
  const [operation, setOperation] = useState<'save' | 'restore' | 'refresh'>()
  const [restored, setRestored] = useState<{ continueEditing: boolean }>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const mutationInFlight = useRef(false)
  const selected = list?.versions.find((version) => version.id === selectedId)
  const comparisonKey = JSON.stringify([props.sessionId, selectedId, against, revision])
  const diff = comparison?.key === comparisonKey ? comparison.diff : undefined
  const mutationDisabled = props.busy || Boolean(operation) || Boolean(restored)
  const restoreDisabled = mutationDisabled || loading || !selected || !diff || diffLoading || against !== 'current'

  useLayoutEffect(() => {
    const element = dialog.current
    mounted.current = true
    element?.showModal()
    // Close before React detaches the dialog so native focus restoration can
    // return to its trigger. A passive cleanup runs too late for that.
    return () => { mounted.current = false; element?.close() }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.workspaceVersions(props.sessionId).then((next) => {
      if (cancelled) return
      setList(next)
      setSelectedId((current) => next.versions.some((version) => version.id === current) ? current : next.versions[0]?.id ?? '')
      setAgainst((current) => current === 'current' || next.versions.some((version) => version.id === current) ? current : 'current')
    }).catch((reason) => { if (!cancelled) setError(errorLabel(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [props.sessionId, revision])

  useEffect(() => {
    let cancelled = false
    setComparison(undefined)
    if (!selectedId) { setDiffLoading(false); return }
    setDiffLoading(true)
    api.workspaceVersionDiff(props.sessionId, selectedId, against).then((next) => {
      if (!cancelled) setComparison({ key: comparisonKey, diff: next })
    }).catch((reason) => { if (!cancelled) setError(errorLabel(reason)) })
      .finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [against, props.sessionId, comparisonKey, selectedId])

  const refreshRestoredWorkspace = async (continueEditing: boolean) => {
    setOperation('refresh')
    setError('')
    try {
      await props.onRestored(continueEditing)
      if (mounted.current) props.onClose()
    } catch (reason) {
      if (mounted.current) setError(`Workspace restored, but refreshing the view failed: ${errorLabel(reason)}`)
    } finally {
      if (mounted.current) setOperation(undefined)
    }
  }

  const restore = async (continueEditing: boolean) => {
    if (!selected || restoreDisabled || mutationInFlight.current) return
    mutationInFlight.current = true
    setOperation('restore')
    setError('')
    try {
      await api.restoreWorkspaceVersion(props.sessionId, selected.id)
      if (!mounted.current) return
      setRestored({ continueEditing })
      setNotice('Workspace restored. Refreshing the current files…')
      await refreshRestoredWorkspace(continueEditing)
    } catch (reason) {
      if (mounted.current) setError(errorLabel(reason))
    } finally {
      mutationInFlight.current = false
      if (mounted.current) setOperation(undefined)
    }
  }

  return <dialog className="workspace-versions-dialog" ref={dialog} aria-labelledby={titleId}
    onCancel={(event) => { if (mutationInFlight.current) event.preventDefault() }}
    onClose={() => { if (mounted.current && !dialog.current?.open) props.onClose() }}>
    <header>
      <div><History size={19} aria-hidden="true" /><h2 id={titleId}>Workspace versions</h2></div>
      <button type="button" className="version-close" aria-label="Close workspace versions" disabled={Boolean(operation)} onClick={props.onClose}><X size={18} /></button>
    </header>
    <div className="version-body">
      <p className="version-scope">Restore saved workspace files while keeping conversation history. External actions are not undone. Dependencies, caches, builds, and private runtime files are excluded.</p>
      <form className="version-save" onSubmit={(event) => {
        event.preventDefault()
        if (mutationDisabled || mutationInFlight.current) return
        mutationInFlight.current = true
        setOperation('save')
        setError('')
        void api.saveWorkspaceVersion(props.sessionId, label.trim() || undefined).then((version) => {
          if (!mounted.current) return
          setSelectedId(version.id)
          setLabel('')
          setNotice('Current workspace saved.')
          setRevision((value) => value + 1)
        }).catch((reason) => { if (mounted.current) setError(errorLabel(reason)) }).finally(() => {
          mutationInFlight.current = false
          if (mounted.current) setOperation(undefined)
        })
      }}>
        <label htmlFor={labelId}>Save the current workspace</label>
        <div><input id={labelId} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={120} placeholder="Version label (optional)" disabled={mutationDisabled} />
          <button type="submit" disabled={mutationDisabled}>{operation === 'save' ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} Save version</button></div>
      </form>
      {props.busy && <p className="version-file-note">The task is active. Stop it or wait for completion before saving or restoring a version.</p>}
      <p className="version-notice" role="status">{notice}</p>
      {error && <p className="version-error" role="alert">{error} <button type="button" disabled={Boolean(operation)} onClick={() => {
        if (restored) void refreshRestoredWorkspace(restored.continueEditing)
        else { setError(''); setRevision((value) => value + 1) }
      }}>{restored ? 'Retry refresh' : 'Retry loading'}</button></p>}
      {loading ? <p className="version-empty">Loading saved versions…</p> : !list?.versions.length ? <p className="version-empty">No saved versions yet. Save one here, or finish a task to keep a delivery version.</p> : <>
        <div className="version-selectors">
          <div><label htmlFor={fromId}>Saved version</label><select id={fromId} value={selectedId} disabled={Boolean(operation)} onChange={(event) => { setSelectedId(event.target.value); setError('') }}>
            {list.versions.map((version) => <option key={version.id} value={version.id}>{version.label || workspaceVersionReason(version.reason)} · {dateLabel(version.createdAt)}</option>)}
          </select></div>
          <ArrowRight size={16} aria-hidden="true" />
          <div><label htmlFor={againstId}>Compare with</label><select id={againstId} value={against} disabled={Boolean(operation)} onChange={(event) => { setAgainst(event.target.value); setError('') }}>
            <option value="current">Current workspace</option>
            {list.versions.map((version) => <option key={version.id} value={version.id}>{version.label || workspaceVersionReason(version.reason)} · {dateLabel(version.createdAt)}</option>)}
          </select></div>
        </div>
        {selected && <p className="version-metadata">{workspaceVersionReason(selected.reason)} · {selected.fileCount} {selected.fileCount === 1 ? 'file' : 'files'} · {selected.bytes < 1024 ? `${selected.bytes} B` : `${(selected.bytes / 1024).toFixed(1)} KB`} · <time dateTime={selected.createdAt}>{dateLabel(selected.createdAt)}</time></p>}
        {diffLoading ? <p className="version-empty">Comparing saved files…</p> : diff && <WorkspaceVersionChanges diff={diff} />}
      </>}
    </div>
    <footer>
      <p>{selected && <>Restore “{selected.label || workspaceVersionReason(selected.reason)}” to the current workspace. </>}{against !== 'current' && <>Compare with the current workspace before restoring. </>}Restoring saves the current workspace first. Reopen affected previews and verify them before the next delivery.</p>
      <div>
        <button type="button" disabled={restoreDisabled} onClick={() => void restore(false)}><RotateCcw size={14} /> Restore version</button>
        <button type="button" className="version-primary" disabled={restoreDisabled} onClick={() => void restore(true)}>{operation === 'restore' ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />} Restore &amp; continue</button>
      </div>
    </footer>
  </dialog>
}
