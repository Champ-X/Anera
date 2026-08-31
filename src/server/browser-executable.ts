import { existsSync } from 'node:fs'

const DEFAULT_EXECUTABLE_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

export function findBrowserExecutable(explicitPath?: string): string {
  const candidates = [explicitPath, ...DEFAULT_EXECUTABLE_CANDIDATES].filter((value): value is string => Boolean(value))
  const executable = candidates.find((candidate) => existsSync(candidate))
  if (!executable) throw new Error('No supported Chrome or Chromium executable is installed')
  return executable
}
