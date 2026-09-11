import type { ToolCallRecord } from '../shared/types.js'
import type { ToolDefinition } from './tools.js'

const UPSTREAM_OBSERVATIONS = ['web_search', 'web_fetch', 'fetch_page'] as const
const UPSTREAM_TOOLS = [...UPSTREAM_OBSERVATIONS, 'record_research_brief'] as const
export interface ResearchRepairCapabilities {
  path: string
  candidateAction: 'read_file' | 'edit_file'
  upstreamTools: ReadonlySet<string>
  independentObservationTools: ReadonlySet<string>
}

/** Reopen an existing evidence dependency of a located content defect, not
 * the whole workflow. No task words, reviewer-reason regex or template IDs.
 * Evidence refresh is an alternative to file correction, never its approval. */
export function researchRepairCapabilities(input: {
  path?: string; candidateAction?: 'read_file' | 'edit_file'; hasContentGap: boolean; hasResearchDependency: boolean
}): ResearchRepairCapabilities | undefined {
  if (!input.path?.trim() || input.path !== input.path.trim() || !input.candidateAction
    || !input.hasContentGap || !input.hasResearchDependency) return undefined
  return { path: input.path, candidateAction: input.candidateAction, upstreamTools: new Set(UPSTREAM_TOOLS),
    independentObservationTools: new Set(UPSTREAM_OBSERVATIONS) }
}

export function researchRepairToolNames(capability: ResearchRepairCapabilities): ReadonlySet<string> {
  return new Set([capability.candidateAction, ...capability.upstreamTools])
}

/** Constrain, never add powers absent from the controller's catalog. */
export function withResearchRepairTools(definitions: readonly ToolDefinition[], capability?: ResearchRepairCapabilities): ToolDefinition[] {
  if (!capability) return [...definitions]
  const names = researchRepairToolNames(capability)
  return definitions.filter((definition) => names.has(definition.function.name)).map((definition) => {
    if (definition.function.name !== capability.candidateAction) return definition
    const parameters = definition.function.parameters
    const properties = parameters.properties as Record<string, unknown> | undefined
    return { ...definition, function: { ...definition.function, parameters: { ...parameters,
      properties: { ...properties, path: { type: 'string', enum: [capability.path] } },
    } } }
  })
}

export function researchRepairCallAllowed(capability: ResearchRepairCapabilities | undefined, call: Pick<ToolCallRecord, 'name' | 'arguments'>): boolean {
  if (!capability) return true
  if (capability.upstreamTools.has(call.name)) return true // Normal URL/schema/network/brief gates still apply.
  return call.name === capability.candidateAction && call.arguments.path === capability.path
}

export function researchRepairInstruction(capability?: ResearchRepairCapabilities): string {
  if (!capability) return ''
  return 'Evidence-dependent content repair: choose either the current canonical file correction or upstream source retrieval/review. If the retained material cannot support the original requirements, use web_search/web_fetch/fetch_page and record_research_brief to obtain and review suitable evidence; do not merely relabel out-of-scope material, weaken the task or invent support. A valid research call does not require a file read first. File edits still require the current complete raw read and exact canonical path. Refreshing evidence does not change the artifact, approve its claims, or pass rendering/delivery; all affected checks and content review remain required. Preserve already valid work and unchanged evidence, and do not re-fetch it merely for reassurance.'
}
