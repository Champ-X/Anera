import { describe, expect, it } from 'vitest'
import {
  AGENT_OOXML_UPLOAD_TYPES,
  AGENT_UPLOAD_ACCEPT_ATTR,
  AGENT_UPLOAD_ALLOWED_MIME_TYPES,
  ARENA_AGENT_UPLOAD_ALLOWED_MIME_TYPES,
  MAX_AGENT_PDF_UPLOAD_BYTES,
  MAX_AGENT_UPLOAD_BYTES,
  MAX_AGENT_UPLOAD_BYTES_PER_TURN,
  isAllowedAgentUploadMimeType,
  selectAgentUploads,
} from './agent-upload-policy.js'

describe('Arena Agent upload policy', () => {
  it('freezes the Arena baseline separately from the Anera runtime Office overlay', () => {
    expect(MAX_AGENT_UPLOAD_BYTES).toBe(0x1900000)
    expect(MAX_AGENT_UPLOAD_BYTES_PER_TURN).toBe(0x3200000)
    expect(MAX_AGENT_PDF_UPLOAD_BYTES).toBe(0xa00000)
    expect(ARENA_AGENT_UPLOAD_ALLOWED_MIME_TYPES).toEqual([
      'image/png', 'image/webp', 'image/jpeg', 'image/gif',
      'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/xml', 'text/css', 'text/javascript',
      'application/json', 'application/xml', 'application/javascript', 'application/pdf',
    ])
    expect(AGENT_OOXML_UPLOAD_TYPES).toEqual([
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
    ])
    expect(AGENT_UPLOAD_ALLOWED_MIME_TYPES).toEqual([
      ...ARENA_AGENT_UPLOAD_ALLOWED_MIME_TYPES,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ])
    expect(AGENT_UPLOAD_ACCEPT_ATTR).toBe(AGENT_UPLOAD_ALLOWED_MIME_TYPES.join(','))
    expect(isAllowedAgentUploadMimeType('application/pdf')).toBe(true)
    for (const type of AGENT_OOXML_UPLOAD_TYPES) {
      expect(isAllowedAgentUploadMimeType(type.mime)).toBe(true)
    }
  })

  it('accepts exact Office pairs and rejects MIME/extension mismatches', () => {
    for (const type of AGENT_OOXML_UPLOAD_TYPES) {
      const candidate = { name: `input${type.extension}`, type: type.mime, size: 100 }
      expect(selectAgentUploads([candidate])).toEqual({ accepted: [candidate], bytesUsed: 100, errors: [] })
    }

    expect(selectAgentUploads([{
      name: 'input.docx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 100,
    }]).errors[0]).toContain('invalid Office file type')
    expect(selectAgentUploads([{ name: 'input.txt', type: AGENT_OOXML_UPLOAD_TYPES[0].mime, size: 100 }]).errors[0])
      .toContain('invalid Office file type')
    expect(selectAgentUploads([{ name: 'input.pptx', type: 'application/pdf', size: 100 }]).errors[0])
      .toContain('invalid Office file type')
  })

  it('uses runtime ordering and exact copy for unsupported, per-file, and PDF failures', () => {
    const unsupported = selectAgentUploads([{ name: 'input.zip', type: 'application/zip', size: 100 }])
    expect(unsupported).toEqual({
      accepted: [],
      bytesUsed: 0,
      errors: [`input.zip is not a supported file type. Allowed: ${AGENT_UPLOAD_ALLOWED_MIME_TYPES.join(', ')}.`],
    })

    expect(selectAgentUploads([{ name: 'huge.png', type: 'image/png', size: MAX_AGENT_UPLOAD_BYTES + 1 }]).errors).toEqual([
      'huge.png exceeds the 25 MB per-file upload limit.',
    ])
    expect(selectAgentUploads([{ name: 'huge.pdf', type: 'application/pdf', size: MAX_AGENT_PDF_UPLOAD_BYTES + 1 }]).errors).toEqual([
      'huge.pdf exceeds the 10 MB per-file PDF upload limit.',
    ])
  })

  it('partially accepts a batch in order while enforcing the per-message byte budget', () => {
    const first = { name: 'first.txt', type: 'text/plain', size: 24 * 1_048_576 }
    const over = { name: 'over.txt', type: 'text/plain', size: 3 * 1_048_576 }
    const final = { name: 'final.json', type: 'application/json', size: 1 * 1_048_576 }
    const selected = selectAgentUploads([first, over, final], 25 * 1_048_576)
    expect(selected.accepted).toEqual([first, final])
    expect(selected.bytesUsed).toBe(MAX_AGENT_UPLOAD_BYTES_PER_TURN)
    expect(selected.errors).toEqual([
      'Adding over.txt would exceed the 50 MB total upload limit for this message.',
    ])
  })
})
