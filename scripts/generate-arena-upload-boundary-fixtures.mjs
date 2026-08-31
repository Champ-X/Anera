import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, openSync, closeSync, ftruncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MiB = 1024 * 1024
const outputDir = join(tmpdir(), 'anera-arena-upload-boundary-fixtures')

const fixtures = [
  ['I04_generic-over-25MiB.txt', 25 * MiB + 1],
  ['I04_pdf-over-10MiB.pdf', 10 * MiB + 1],
  ['I04_total-part-a.txt', 20 * MiB],
  ['I04_total-part-b.txt', 20 * MiB],
  ['I04_total-part-c.txt', 10 * MiB + 1],
]

mkdirSync(outputDir, { recursive: true })

function createSparseFile(path, bytes) {
  const descriptor = openSync(path, 'w', 0o600)
  try {
    ftruncateSync(descriptor, bytes)
  } finally {
    closeSync(descriptor)
  }
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

for (const [name, bytes] of fixtures) {
  const path = join(outputDir, name)
  createSparseFile(path, bytes)
  console.log(`${await sha256(path)}  ${bytes}  ${path}`)
}
