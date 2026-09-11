import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createId } from './ids.js'
import {
  assertReferenceTemplateDependency, normalizeReferenceTemplateRuntimeEvidence, referenceTemplateRuntimeEvidence,
  type ReferenceTemplateDependency, type ReferenceTemplateRuntimeEvidence,
} from './reference-template.js'

async function privateDirectory(path: string, create: boolean) {
  if (create) await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) throw new Error('Reference runtime evidence directory is not private')
}

async function verifyFile(path: string, expected: Omit<ReferenceTemplateDependency, 'content'>): Promise<ReferenceTemplateDependency> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.bytes || (before.mode & 0o777) !== 0o600) throw new Error('Reference runtime evidence file metadata mismatch')
  const bytes = await readFile(path)
  const after = await lstat(path)
  if (!after.isFile() || after.isSymbolicLink() || (after.mode & 0o777) !== 0o600
    || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) throw new Error('Reference runtime evidence changed during read')
  const dependency = { ...expected, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  assertReferenceTemplateDependency(dependency)
  return dependency
}

async function evidenceDirectory(sessionDirectory: string, manifest: ReferenceTemplateRuntimeEvidence, create: boolean) {
  let directory = sessionDirectory
  for (const segment of ['reference-style', 'runtime', 'v1', manifest.manifestSha256]) {
    directory = resolve(directory, segment)
    await privateDirectory(directory, create)
  }
  return directory
}

export async function commitReferenceRuntimeEvidence(sessionDirectory: string, sourceSha256: string, sourceUrl: string, dependencies: ReferenceTemplateDependency[]) {
  const manifest = referenceTemplateRuntimeEvidence(sourceSha256, sourceUrl, dependencies)
  const directory = await evidenceDirectory(sessionDirectory, manifest, true)
  for (const dependency of dependencies) {
    const path = resolve(directory, `${dependency.sha256}.js`)
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (existing) { await verifyFile(path, dependency); continue }
    const temporary = resolve(directory, `.${createId('rte')}.tmp`)
    try {
      await writeFile(temporary, dependency.content, { flag: 'wx', mode: 0o600 })
      await chmod(temporary, 0o600)
      await verifyFile(temporary, dependency)
      await rename(temporary, path)
      await verifyFile(path, dependency)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  return manifest
}

export async function resolveReferenceRuntimeEvidence(sessionDirectory: string, input: ReferenceTemplateRuntimeEvidence) {
  const manifest = normalizeReferenceTemplateRuntimeEvidence(input)
  const directory = await evidenceDirectory(sessionDirectory, manifest, false)
  return await Promise.all(manifest.dependencies.map((dependency) => verifyFile(resolve(directory, `${dependency.sha256}.js`), dependency)))
}
