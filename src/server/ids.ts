import { randomUUID } from 'node:crypto'

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`
}
