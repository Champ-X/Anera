// Mechanical evidence collection does not need a second content-design plan.
// Select by BOTH durable phase and the actual executable tool surface: repair,
// fallback and recovery paths must keep their full authoring instructions.
const EXECUTION_TOOLS: Readonly<Record<string, readonly string[]>> = {
  reference_source_check: ['verify_reference_style'],
  website_preview: ['start_process', 'build_and_start'],
  browser_open: ['browser'],
  reference_cover_screenshot: ['browser'],
  navigation_check: ['browser'],
  browser_screenshot: ['browser'],
  reference_closing_navigation: ['browser'],
  reference_closing_screenshot: ['browser'],
}

export function isVerificationExecutionOnly(phase: string | undefined, toolNames: readonly string[], canonicalPath?: string, canonicalReadPending = false): boolean {
  // Context navigation does not add authoring authority. Merely retaining an
  // archive must not re-inject the full design prompt into mechanical checks.
  const actionTools = toolNames.filter((name) => name !== 'read_context')
  if (!canonicalPath || !phase || actionTools.length === 0) return false
  if (canonicalReadPending && actionTools.includes('read_file')
    && actionTools.every((name) => ['read_file', 'read_reference_resource'].includes(name))) return true
  if (!Object.hasOwn(EXECUTION_TOOLS, phase)) return false
  return actionTools.every((name) => EXECUTION_TOOLS[phase].includes(name))
}

export function verificationExecutionControl(canonicalPath: string): string {
  return `Harness verification execution only: the existing canonical artifact is ${JSON.stringify(canonicalPath)}. Perform the current phase's tool action now. This step collects current evidence; it does not authorize content changes. Do not redesign the deck, choose new layouts, plan numeric substitutions, draft edits, or resolve future content decisions before this action. Preserve the current file and use only the supplied tools. For a prescribed diagnostic read, obtain its exact current bytes/cursor before planning a repair; historical excerpts are not that read. start_process is for the long-running preview server, not finite inspection commands. The original user requirements and all source, render, Vision, factual-content and delivery gates remain mandatory; their authoring instructions return when a repair/edit phase is executable. Historical defects are not a substitute for current file or Browser evidence. Follow the exact current action below, then use its actual result to determine the next phase.`
}
