export const MAX_AGENT_UPLOAD_BYTES = 0x1900000
export const MAX_AGENT_UPLOAD_BYTES_PER_TURN = 0x3200000
export const MAX_AGENT_PDF_UPLOAD_BYTES = 0xa00000

/** Exact MIME allowlist observed in Arena's public Agent composer. */
export const ARENA_AGENT_UPLOAD_ALLOWED_MIME_TYPES = [
  'image/png',
  'image/webp',
  'image/jpeg',
  'image/gif',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/pdf',
] as const

/** Anera runtime-only Office upload overlay. */
export const AGENT_OOXML_UPLOAD_TYPES = [
  {
    extension: '.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'DOCX',
    requiredEntry: 'word/document.xml',
  },
  {
    extension: '.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'XLSX',
    requiredEntry: 'xl/workbook.xml',
  },
  {
    extension: '.pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PPTX',
    requiredEntry: 'ppt/presentation.xml',
  },
] as const

export const AGENT_UPLOAD_ALLOWED_MIME_TYPES = [
  ...ARENA_AGENT_UPLOAD_ALLOWED_MIME_TYPES,
  ...AGENT_OOXML_UPLOAD_TYPES.map((type) => type.mime),
] as const

export type AgentUploadMimeType = typeof AGENT_UPLOAD_ALLOWED_MIME_TYPES[number]

export const AGENT_UPLOAD_ACCEPT_ATTR = AGENT_UPLOAD_ALLOWED_MIME_TYPES.join(',')

export interface AgentUploadCandidate {
  name: string
  type: string
  size: number
}

export interface AgentUploadSelection<T extends AgentUploadCandidate> {
  accepted: T[]
  bytesUsed: number
  errors: string[]
}

export function isAllowedAgentUploadMimeType(value: string): value is AgentUploadMimeType {
  return (AGENT_UPLOAD_ALLOWED_MIME_TYPES as readonly string[]).includes(value)
}

export function selectAgentUploads<T extends AgentUploadCandidate>(
  candidates: readonly T[],
  initialBytes = 0,
): AgentUploadSelection<T> {
  return candidates.reduce<AgentUploadSelection<T>>((selection, candidate) => {
    const error = agentUploadError(candidate, selection.bytesUsed)
    if (error) return { ...selection, errors: [...selection.errors, error] }
    return {
      accepted: [...selection.accepted, candidate],
      bytesUsed: selection.bytesUsed + candidate.size,
      errors: selection.errors,
    }
  }, { accepted: [], bytesUsed: initialBytes, errors: [] })
}

export function agentUploadError(candidate: AgentUploadCandidate, bytesUsed = 0): string | undefined {
  const normalizedName = candidate.name.toLowerCase()
  const officeByExtension = AGENT_OOXML_UPLOAD_TYPES.find((type) => normalizedName.endsWith(type.extension))
  const officeByMime = AGENT_OOXML_UPLOAD_TYPES.find((type) => type.mime === candidate.type)
  if (officeByExtension || officeByMime) {
    const expected = officeByExtension ?? officeByMime!
    if (officeByExtension !== officeByMime) {
      return `${candidate.name} has an invalid Office file type. ${expected.label} uploads require the ${expected.extension} extension and ${expected.mime} MIME type.`
    }
  }
  if (!isAllowedAgentUploadMimeType(candidate.type)) {
    return `${candidate.name} is not a supported file type. Allowed: ${AGENT_UPLOAD_ALLOWED_MIME_TYPES.join(', ')}.`
  }
  if (candidate.size > MAX_AGENT_UPLOAD_BYTES) {
    return `${candidate.name} exceeds the ${MAX_AGENT_UPLOAD_BYTES / 1_048_576} MB per-file upload limit.`
  }
  if (candidate.type === 'application/pdf' && candidate.size > MAX_AGENT_PDF_UPLOAD_BYTES) {
    return `${candidate.name} exceeds the ${MAX_AGENT_PDF_UPLOAD_BYTES / 1_048_576} MB per-file PDF upload limit.`
  }
  if (bytesUsed + candidate.size > MAX_AGENT_UPLOAD_BYTES_PER_TURN) {
    return `Adding ${candidate.name} would exceed the ${MAX_AGENT_UPLOAD_BYTES_PER_TURN / 1_048_576} MB total upload limit for this message.`
  }
  return undefined
}
