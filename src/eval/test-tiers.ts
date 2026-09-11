/** Test resource policy, not a task/domain-specific allowlist.
 * New tests default to the module tier; resource-heavy suites opt into a tier.
 * Every discovered test must belong to exactly one project in test:full.
 */
export const BROWSER_TESTS = [
  'src/**/*.browser.test.{ts,tsx}',
  'src/server/browser-manager.test.ts',
  'src/server/rendered-text-layout.test.ts',
  'src/server/reference-language.integration.test.ts',
]

export const INTEGRATION_TESTS = [
  'src/**/*.integration.test.{ts,tsx}',
  'src/server/*-api.test.ts',
  ...[
    'agent-create-chat', 'agent-service', 'app-security', 'github-connector',
    'message-transport', 'network-policy', 'process-manager', 'research-evidence',
    'research-phase-control', 'research-workflow', 'session-store', 'tools',
    'visual-compaction', 'website-recovery', 'workspace-search',
  ].map((name) => `src/server/${name}.test.ts`),
]

export const TEST_INCLUDE = ['src/**/*.test.{ts,tsx}']

export function parseChangedTestArguments(args: readonly string[]) {
  let includeBrowser = false
  let planOnly = false
  let base: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`)
    seen.add(arg)
    if (arg === '--include-browser') includeBrowser = true
    else if (arg === '--plan') planOnly = true
    else if (arg === '--base' && args[index + 1] && !args[index + 1].startsWith('-')) base = args[++index]
    else throw new Error('Usage: test:changed [--base <git-ref>] [--plan] [--include-browser]')
  }
  return { includeBrowser, planOnly, base }
}

// Vitest tracks imports, not readFile fixtures or subprocess command strings.
// For these inputs, choosing a subset would silently miss consumers.
export function requiresFullTestSelection(changedPaths: readonly string[]): boolean {
  return changedPaths.some((path) => !/^src\/.*\.(?:[cm]?[jt]sx?)$/u.test(path)
    || /(?:^|\/)(?:fixtures|__fixtures__|__snapshots__|test-support)\//u.test(path))
}

export function splitChangedTestPlan<T extends { moduleId: string; project: { name: string } }>(
  specifications: readonly T[], includeBrowser: boolean,
): { selected: T[]; deferred: T[] } {
  return {
    selected: specifications.filter((spec) => includeBrowser || spec.project.name !== 'browser'),
    deferred: specifications.filter((spec) => !includeBrowser && spec.project.name === 'browser'),
  }
}
