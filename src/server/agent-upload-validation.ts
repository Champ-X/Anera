import { extname } from 'node:path'
import { AGENT_OOXML_UPLOAD_TYPES } from '../shared/agent-upload-policy.js'

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const ZIP64_EXTRA_FIELD_ID = 0x0001
const MAX_ZIP_COMMENT_BYTES = 0xffff

/**
 * Fail-closed validation for Office uploads at their first durable landing
 * boundary. Non-Office uploads are intentionally left to the shared policy.
 */
export function validateAgentUploadBytes(name: string, mime: string, content: Buffer): void {
  const extension = extname(name).toLowerCase()
  const officeByExtension = AGENT_OOXML_UPLOAD_TYPES.find((type) => type.extension === extension)
  const officeByMime = AGENT_OOXML_UPLOAD_TYPES.find((type) => type.mime === mime)
  if (!officeByExtension && !officeByMime) return

  const expected = officeByExtension ?? officeByMime!
  if (officeByExtension !== officeByMime) {
    invalidOfficeUpload(
      expected.label,
      `the filename must end in ${expected.extension} and use the ${expected.mime} MIME type`,
    )
  }

  validateOoxmlZip(expected.label, expected.requiredEntry, content)
}

function validateOoxmlZip(label: string, requiredEntry: string, content: Buffer): void {
  if (content.length < 4 || content.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
    invalidOfficeUpload(label, 'the file does not begin with ZIP magic')
  }

  const eocdOffset = findEndOfCentralDirectory(content)
  if (eocdOffset < 0) invalidOfficeUpload(label, 'the ZIP end-of-central-directory record is missing')

  const diskNumber = content.readUInt16LE(eocdOffset + 4)
  const centralDirectoryDisk = content.readUInt16LE(eocdOffset + 6)
  const entriesOnDisk = content.readUInt16LE(eocdOffset + 8)
  const entryCount = content.readUInt16LE(eocdOffset + 10)
  const centralDirectorySize = content.readUInt32LE(eocdOffset + 12)
  const centralDirectoryOffset = content.readUInt32LE(eocdOffset + 16)
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    invalidOfficeUpload(label, 'split ZIP archives are not supported')
  }
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    invalidOfficeUpload(label, 'ZIP64 archives are not supported')
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  if (!Number.isSafeInteger(centralDirectoryEnd) || centralDirectoryEnd !== eocdOffset) {
    invalidOfficeUpload(label, 'the ZIP central directory is malformed')
  }

  const requiredEntryBytes = Buffer.from(requiredEntry, 'utf8')
  let requiredEntryCount = 0
  let cursor = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    assertZipRange(label, cursor, 46, centralDirectoryEnd)
    if (content.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE) {
      invalidOfficeUpload(label, 'the ZIP central directory is malformed')
    }

    const flags = content.readUInt16LE(cursor + 8)
    const compressionMethod = content.readUInt16LE(cursor + 10)
    const compressedSize = content.readUInt32LE(cursor + 20)
    const uncompressedSize = content.readUInt32LE(cursor + 24)
    const nameLength = content.readUInt16LE(cursor + 28)
    const extraLength = content.readUInt16LE(cursor + 30)
    const commentLength = content.readUInt16LE(cursor + 32)
    const diskStart = content.readUInt16LE(cursor + 34)
    const localHeaderOffset = content.readUInt32LE(cursor + 42)
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength
    assertZipRange(label, cursor, entryEnd - cursor, centralDirectoryEnd)

    if (diskStart !== 0) invalidOfficeUpload(label, 'split ZIP archives are not supported')
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      invalidOfficeUpload(label, 'ZIP64 archives are not supported')
    }
    if ((flags & 0x1) !== 0) invalidOfficeUpload(label, 'encrypted ZIP entries are not supported')

    const nameStart = cursor + 46
    const nameBytes = content.subarray(nameStart, nameStart + nameLength)
    const extra = content.subarray(nameStart + nameLength, nameStart + nameLength + extraLength)
    if (hasZip64ExtraField(label, extra)) invalidOfficeUpload(label, 'ZIP64 archives are not supported')

    validateLocalHeader(
      label,
      content,
      centralDirectoryOffset,
      localHeaderOffset,
      nameBytes,
      flags,
      compressionMethod,
      compressedSize,
    )
    if (nameBytes.equals(requiredEntryBytes)) requiredEntryCount += 1
    cursor = entryEnd
  }

  if (cursor !== centralDirectoryEnd) invalidOfficeUpload(label, 'the ZIP central directory is malformed')
  if (requiredEntryCount !== 1) {
    invalidOfficeUpload(label, `the archive must contain exactly one ${requiredEntry} entry`)
  }
}

function validateLocalHeader(
  label: string,
  content: Buffer,
  centralDirectoryOffset: number,
  localHeaderOffset: number,
  expectedName: Buffer,
  expectedFlags: number,
  expectedCompressionMethod: number,
  compressedSize: number,
): void {
  assertZipRange(label, localHeaderOffset, 30, centralDirectoryOffset)
  if (content.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    invalidOfficeUpload(label, 'a ZIP entry references an invalid local header')
  }
  if (content.readUInt16LE(localHeaderOffset + 6) !== expectedFlags
    || content.readUInt16LE(localHeaderOffset + 8) !== expectedCompressionMethod) {
    invalidOfficeUpload(label, 'a ZIP local header does not match its central-directory entry')
  }

  const nameLength = content.readUInt16LE(localHeaderOffset + 26)
  const extraLength = content.readUInt16LE(localHeaderOffset + 28)
  const nameStart = localHeaderOffset + 30
  const dataStart = nameStart + nameLength + extraLength
  assertZipRange(label, localHeaderOffset, dataStart - localHeaderOffset, centralDirectoryOffset)
  assertZipRange(label, dataStart, compressedSize, centralDirectoryOffset)
  if (!content.subarray(nameStart, nameStart + nameLength).equals(expectedName)) {
    invalidOfficeUpload(label, 'a ZIP local filename does not match its central-directory entry')
  }
  const localExtra = content.subarray(nameStart + nameLength, dataStart)
  if (hasZip64ExtraField(label, localExtra)) invalidOfficeUpload(label, 'ZIP64 archives are not supported')
}

function findEndOfCentralDirectory(content: Buffer): number {
  if (content.length < 22) return -1
  const minimumOffset = Math.max(0, content.length - 22 - MAX_ZIP_COMMENT_BYTES)
  for (let offset = content.length - 22; offset >= minimumOffset; offset -= 1) {
    if (content.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue
    const commentLength = content.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === content.length) return offset
  }
  return -1
}

function hasZip64ExtraField(label: string, extra: Buffer): boolean {
  let cursor = 0
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) invalidOfficeUpload(label, 'a ZIP extra field is malformed')
    const id = extra.readUInt16LE(cursor)
    const size = extra.readUInt16LE(cursor + 2)
    cursor += 4
    if (cursor + size > extra.length) invalidOfficeUpload(label, 'a ZIP extra field is malformed')
    if (id === ZIP64_EXTRA_FIELD_ID) return true
    cursor += size
  }
  return false
}

function assertZipRange(label: string, offset: number, length: number, limit: number): void {
  const end = offset + length
  if (offset < 0 || length < 0 || !Number.isSafeInteger(end) || end > limit) {
    invalidOfficeUpload(label, 'the ZIP archive is malformed')
  }
}

function invalidOfficeUpload(label: string, reason: string): never {
  throw new Error(`${label} upload is invalid: ${reason}.`)
}
