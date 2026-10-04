/** The agent selects the checks; evidence bindings attest provenance, not semantic truth. */
export interface TaskVerificationCheck {
  requirement: string
  method: string
  required: boolean
  status: 'passed' | 'failed' | 'unverified' | 'not_needed'
  evidence: { callIds?: string[]; paths?: string[] }
  note?: string
}

export interface TaskVerification {
  outcome: 'completed' | 'limited'
  summary: string
  checks: TaskVerificationCheck[]
}

export interface TaskVerificationReceipt extends TaskVerification {
  schemaVersion: 1
  taskSha256: string
  evidenceSha256: string
  fileEvidence: Array<{ path: string; sha256: string; bytes: number }>
  eventEvidence: Array<{ callId: string; eventId: string; seq: number; sha256: string }>
  /** Explicit unavailable paths of failed/unverified/not-needed checks; never a file hash or a pass. */
  unavailableFileEvidence?: Array<{ path: string; reason: 'missing' | 'unreadable'; checkIndexes: number[] }>
  /** Known mutations after the last observation selected for the same check/path. */
  staleFileEvidence?: Array<{ checkIndex: number; path: string; lastObservationSeq: number; changeEventId: string; changeEventSeq: number }>
  /** Selected private tool observations of bytes different from the current file. */
  mismatchedFileEvidence?: Array<{ checkIndex: number; path: string; callId: string; eventId: string; eventSeq: number;
    observedSha256: string; observedBytes: number }>
}
