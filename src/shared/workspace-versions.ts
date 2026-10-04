export interface WorkspaceVersionScope {
  files: 'saved-workspace'
  excludedPaths: 'dependencies-caches-builds-and-private-runtime-files'
  conversationReverted: false
  externalSideEffectsReverted: false
}

export interface WorkspaceVersionSummary {
  id: string
  createdAt: string
  label: string
  reason: 'delivery' | 'manual' | 'before_restore'
  turnId?: string
  fileCount: number
  bytes: number
  sha256: string
}

export interface WorkspaceVersionList {
  versions: WorkspaceVersionSummary[]
  scope: WorkspaceVersionScope
}

export interface WorkspaceVersionFileInfo {
  sha256: string
  bytes: number
  /** Unix permission bits, including whether a script is executable. */
  mode: number
}

export interface WorkspaceVersionChange {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  before?: WorkspaceVersionFileInfo
  after?: WorkspaceVersionFileInfo
  /** UTF-8 text, bounded per file and across the comparison; absent for binary files. */
  beforeText?: string
  afterText?: string
  textTruncated?: boolean
}

export interface WorkspaceVersionDiff {
  fromVersionId: string
  against: string
  /** Changes from the selected saved version to the comparison target. */
  changes: WorkspaceVersionChange[]
  added: number
  modified: number
  deleted: number
  scope: WorkspaceVersionScope
}

export interface WorkspaceVersionRestoreResult {
  version: WorkspaceVersionSummary
  restoreId: string
  workspaceReverted: true
  conversationReverted: false
  externalSideEffectsReverted: false
}
