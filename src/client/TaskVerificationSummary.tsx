import { Check, CircleHelp, CircleAlert } from 'lucide-react'
import type { TaskVerification, TaskVerificationCheck } from '../shared/task-verification'

export interface TaskVerificationView extends TaskVerification {
  /** False for direct responses and exhausted protocols without a recorded review. */
  verificationRecorded?: boolean
}

export function verificationCheckLabel(status: TaskVerificationCheck['status']): string {
  return { passed: 'Passed', failed: 'Failed', unverified: 'Not verified', not_needed: 'Not needed' }[status]
}

export function TaskVerificationSummary({ verification, stale = false }: { verification: TaskVerificationView; stale?: boolean }) {
  const unrecorded = verification.verificationRecorded === false
  return <details className={`task-verification-summary${unrecorded ? ' unrecorded' : ''}${stale ? ' stale' : ''}`}>
    <summary>
      {stale || unrecorded ? <CircleHelp size={14} aria-hidden="true" /> : verification.outcome === 'limited' ? <CircleAlert size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
      <span>{stale ? 'Previous verification · recheck needed' : unrecorded ? verification.outcome === 'limited' ? 'Verification · unavailable' : 'Verification · not recorded' : verification.outcome === 'limited' ? 'Verification · completed with limitations' : 'Verification · complete'}</span>
      <span>{verification.checks.length} checks</span>
    </summary>
    <div className="verification-details">
      {stale && <p className="verification-stale-note">The workspace was restored after this review. These results describe the earlier files; affected results need to be checked again.</p>}
      <p>{verification.summary}</p>
      {verification.checks.length === 0 ? <p className="verification-empty">No additional checks were recorded for this task.</p> : <ul>
        {verification.checks.map((check, index) => <li key={index}>
          <div><strong>{check.requirement}</strong><span className={`verification-check-status ${check.status}`}>{verificationCheckLabel(check.status)}</span></div>
          <p>{check.method}{check.note ? ` — ${check.note}` : ''}</p>
          {check.evidence.paths?.length ? <p className="verification-paths">Files: {check.evidence.paths.map((path) => <code key={path}>{path}</code>)}</p> : null}
        </li>)}
      </ul>}
    </div>
  </details>
}
