/**
 * Arena's saved Workspace is a projection of the live sandbox, not a copy of
 * every byte needed by the current runtime. Dependency, cache, and build
 * directories stay on disk for the active process but are excluded from the
 * saved tree, Shell reconciliation, terminal metrics, and Workspace export.
 *
 * Keep this policy in a dependency-free shared module so the model contract,
 * Workspace implementation, and HTTP export cannot drift or import each
 * other cyclically.
 */
export const ARENA_WORKSPACE_IGNORED_DIR_NAMES = [
  '.arena', '.cache', '.mypy_cache', '.next', '.nox', '.npm', '.nuxt', '.output', '.parcel-cache',
  '.pytest_cache', '.ruff_cache', '.svelte-kit', '.tox', '.turbo', '.venv', '.vite', '__pycache__',
  'build', 'coverage', 'dist', 'node_modules', 'out', 'target',
] as const

export const ARENA_WORKSPACE_IGNORED_FILE_PATH_SUFFIXES = [
  '.git/config', '.git/credentials', '.git-credentials', '.netrc',
] as const

const ANERA_INTERNAL_PATH_NAMES = new Set([
  // `node_modules` was already part of Anera's restricted-path boundary
  // before snapshot projection became a distinct policy. Keep that existing
  // search/deployment/release-asset guard while allowing build outputs such
  // as `dist` to remain usable by the live runtime and deployment pipeline.
  'node_modules', '.git', '.DS_Store', '.tmp', '.home', '.npm-cache',
])

const SNAPSHOT_IGNORED_DIR_NAMES = new Set<string>([
  ...ANERA_INTERNAL_PATH_NAMES,
  ...ARENA_WORKSPACE_IGNORED_DIR_NAMES,
])

function normalizedWorkspacePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
}

/** Existing Anera private/runtime path boundary used outside snapshotting. */
export function isWorkspaceInternalPath(path: string): boolean {
  const normalized = normalizedWorkspacePath(path)
  return normalized.split('/').some((part) => ANERA_INTERNAL_PATH_NAMES.has(part))
}

/**
 * True when a live-workspace path must not enter Arena's saved/exported
 * Workspace projection. This deliberately does not delete or block the path.
 */
export function isWorkspaceSnapshotExcludedPath(path: string): boolean {
  const normalized = normalizedWorkspacePath(path)
  if (!normalized) return false
  if (normalized.split('/').some((part) => SNAPSHOT_IGNORED_DIR_NAMES.has(part))) return true
  return ARENA_WORKSPACE_IGNORED_FILE_PATH_SUFFIXES.some((suffix) => (
    normalized === suffix || normalized.endsWith(`/${suffix}`)
  ))
}
