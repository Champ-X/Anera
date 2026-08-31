import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const DENIED_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)\b/i, 'recursive forced deletion'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[A-Za-z]*f)/i, 'destructive git operation'],
  [/\b(?:sudo|doas|shutdown|reboot|mkfs|mount|umount)\b/i, 'privileged system operation'],
  [/\b(?:nohup|disown)\b|(?:^|[^&])&\s*(?:$|[;])/m, 'unmanaged background process'],
  [/(?:^|[\s;|&])(?:env|printenv)(?:\s|$)|\bprocess\.env\b/, 'environment inspection'],
  [/(?:^|[\s'"=])\.\.(?:\/|\\)/, 'path outside workspace'],
  [/(?:^|[\s'"=])~(?:\/|\s|$)|\/(?:Users|home|etc|private|var|tmp|root)(?:\/|\s|$)/, 'absolute host path'],
  [/\bcurl\b[\s\S]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s*(?:POST|PUT|PATCH|DELETE)|--data|-d\s)/i, 'external write requires approval'],
  [/:\(\)\s*\{\s*:\|:&\s*;\s*\}/, 'fork bomb'],
]

export function validateCommand(command: string): void {
  if (!command.trim()) throw new Error('Command is empty')
  if (command.length > 12_000) throw new Error('Command is too long')
  if (command.includes('\0')) throw new Error('Command contains a null byte')
  for (const [pattern, reason] of DENIED_PATTERNS) {
    if (pattern.test(command)) throw new Error(`Command blocked by workspace policy: ${reason}`)
  }
}

export function commandEnvironment(workspace: string): NodeJS.ProcessEnv {
  const temp = resolve(workspace, '.tmp')
  const home = resolve(workspace, '.home')
  mkdirSync(temp, { recursive: true })
  mkdirSync(home, { recursive: true })
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL,
    TERM: 'dumb',
    NO_COLOR: '1',
    CI: '1',
    TMPDIR: temp,
    npm_config_cache: resolve(workspace, '.npm-cache'),
    npm_config_update_notifier: 'false',
    HOME: home,
  }
}
