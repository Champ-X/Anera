import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export type CommandNetworkMode = 'none' | 'server' | 'full'
export type OsSandboxKind = 'darwin-seatbelt' | 'linux-bubblewrap' | 'none'

export interface OsSandboxStatus {
  kind: OsSandboxKind
  available: boolean
  fileIsolation: 'workspace-only' | 'policy-only'
  foregroundNetworkIsolation: boolean
  managedServerNetworkIsolation: 'outbound-denied' | 'shared-network'
  detail: string
}

export interface ShellInvocation {
  executable: string
  args: string[]
  sandbox: OsSandboxStatus
}

interface SandboxOverrides {
  platform?: NodeJS.Platform
  darwinSandboxPath?: string | null
  linuxBubblewrapPath?: string | null
  shellPath?: string
  homeDirectory?: string
  runtimeExecutable?: string
}

export function osSandboxStatus(overrides: SandboxOverrides = {}): OsSandboxStatus {
  const platform = overrides.platform ?? process.platform
  if (platform === 'darwin') {
    const executable = configuredExecutable(
      overrides,
      'darwinSandboxPath',
      ['/usr/bin/sandbox-exec'],
    )
    return executable
      ? {
          kind: 'darwin-seatbelt',
          available: true,
          fileIsolation: 'workspace-only',
          foregroundNetworkIsolation: true,
          managedServerNetworkIsolation: 'outbound-denied',
          detail: 'Seatbelt restricts persistent writes to the workspace, hides the host home, and denies outbound sockets unless a tool explicitly requires network access.',
        }
      : unsupportedStatus('sandbox-exec is unavailable')
  }
  if (platform === 'linux') {
    const executable = configuredExecutable(
      overrides,
      'linuxBubblewrapPath',
      ['/usr/bin/bwrap', '/bin/bwrap'],
    )
    return executable
      ? {
          kind: 'linux-bubblewrap',
          available: true,
          fileIsolation: 'workspace-only',
          foregroundNetworkIsolation: true,
          // The Website browser runs outside the namespace and must reach the
          // managed server. Bubblewrap alone cannot deny only outbound connect
          // while retaining host-to-sandbox loopback, so this limitation is
          // deliberately reported rather than overstated.
          managedServerNetworkIsolation: 'shared-network',
          detail: 'Bubblewrap exposes a read-only host root, masks HOME and host temporary/runtime state, and overlays only the workspace as writable; foreground commands use a private network namespace.',
        }
      : unsupportedStatus('Bubblewrap is unavailable')
  }
  return unsupportedStatus(`OS sandbox is not implemented for ${platform}`)
}

export function createShellInvocation(
  command: string,
  workspace: string,
  networkMode: CommandNetworkMode,
  overrides: SandboxOverrides = {},
): ShellInvocation {
  const platform = overrides.platform ?? process.platform
  const sandbox = osSandboxStatus(overrides)
  const shell = overrides.shellPath ?? defaultShell(platform)
  if (platform === 'win32') {
    const executable = overrides.shellPath ?? process.env.ComSpec ?? 'cmd.exe'
    return { executable, args: ['/d', '/s', '/c', command], sandbox }
  }

  const canonicalWorkspace = realpathSync(workspace)
  if (sandbox.kind === 'darwin-seatbelt') {
    const executable = configuredExecutable(overrides, 'darwinSandboxPath', ['/usr/bin/sandbox-exec'])
    if (!executable) throw new Error('sandbox-exec disappeared after sandbox capability detection')
    const canonicalHome = canonicalPath(overrides.homeDirectory ?? homedir())
    const runtimeExecutable = overrides.runtimeExecutable ?? process.execPath
    const profile = `(version 1)
(allow default)
(deny file-write* (subpath "/"))
(allow file-write* (subpath ${sandboxLiteral(canonicalWorkspace)}))
(allow file-write* (literal "/dev/null") (literal "/dev/tty"))
(deny file-read-data (subpath ${sandboxLiteral(canonicalHome)}))
(allow file-read-data (subpath ${sandboxLiteral(canonicalWorkspace)}))
${packageRuntimeReadPolicy(runtimeExecutable, canonicalHome)}
${networkMode === 'full' ? '' : '(deny network-outbound)'}`
    return {
      executable,
      args: ['-p', profile, shell, '-c', command],
      sandbox,
    }
  }

  if (sandbox.kind === 'linux-bubblewrap') {
    const executable = configuredExecutable(overrides, 'linuxBubblewrapPath', ['/usr/bin/bwrap', '/bin/bwrap'])
    if (!executable) throw new Error('Bubblewrap disappeared after sandbox capability detection')
    const canonicalHome = canonicalPath(overrides.homeDirectory ?? homedir())
    const runtimeRoot = runtimeRootFor(overrides.runtimeExecutable ?? process.execPath)
    return {
      executable,
      args: bubblewrapArguments({
        command,
        shell,
        workspace: canonicalWorkspace,
        home: canonicalHome,
        runtimeRoot,
        networkMode,
      }),
      sandbox,
    }
  }

  return { executable: shell, args: ['-c', command], sandbox }
}

function bubblewrapArguments(options: {
  command: string
  shell: string
  workspace: string
  home: string
  runtimeRoot: string
  networkMode: CommandNetworkMode
}): string[] {
  if (options.workspace === options.home) {
    throw new Error('The command workspace cannot be the host home directory')
  }
  const maskedRoots = uniqueExistingPaths([
    options.home,
    '/tmp',
    '/var/tmp',
    '/run/user',
  ]).filter((path) => path !== '/' && !isPathInside(options.workspace, path))
  const args = [
    '--die-with-parent',
    '--unshare-user-try',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--cap-drop', 'ALL',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
  ]
  if (options.networkMode === 'none') args.push('--unshare-net')

  for (const root of maskedRoots) args.push('--tmpfs', root)

  const mountTargets = [
    { source: options.runtimeRoot, mode: '--ro-bind' },
    { source: options.workspace, mode: '--bind' },
  ] as const
  const created = new Set<string>()
  for (const target of mountTargets) {
    const maskedRoot = mostSpecificContainingPath(maskedRoots, target.source)
    if (maskedRoot) appendDirectoryCreation(args, maskedRoot, target.source, created)
    args.push(target.mode, target.source, target.source)
  }

  args.push('--', options.shell, '-c', options.command)
  return args
}

function appendDirectoryCreation(args: string[], root: string, target: string, created: Set<string>): void {
  const relativeTarget = relative(root, target)
  if (!relativeTarget || relativeTarget.startsWith(`..${sep}`) || relativeTarget === '..' || isAbsolute(relativeTarget)) return
  let cursor = root
  for (const segment of relativeTarget.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment)
    if (created.has(cursor)) continue
    args.push('--dir', cursor)
    created.add(cursor)
  }
}

function packageRuntimeReadPolicy(runtimeExecutable: string, canonicalHome: string): string {
  const runtimeRoot = runtimeRootFor(runtimeExecutable)
  return isPathInside(canonicalHome, runtimeRoot)
    ? `(allow file-read-data (subpath ${sandboxLiteral(runtimeRoot)}))`
    : ''
}

function runtimeRootFor(runtimeExecutable: string): string {
  return dirname(dirname(canonicalPath(runtimeExecutable)))
}

function defaultShell(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return executablePath(['/bin/zsh', '/bin/sh']) ?? '/bin/sh'
  if (platform === 'win32') return process.env.ComSpec ?? 'cmd.exe'
  return executablePath(['/bin/bash', '/bin/sh']) ?? '/bin/sh'
}

function configuredExecutable<K extends 'darwinSandboxPath' | 'linuxBubblewrapPath'>(
  overrides: SandboxOverrides,
  key: K,
  candidates: string[],
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(overrides, key)) {
    return overrides[key] ?? undefined
  }
  return executablePath(candidates)
}

function executablePath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next known location.
    }
  }
  return undefined
}

function canonicalPath(path: string): string {
  return realpathSync(path)
}

function uniqueExistingPaths(paths: string[]): string[] {
  const unique = new Set<string>()
  for (const path of paths) {
    if (!existsSync(path)) continue
    unique.add(canonicalPath(path))
  }
  return [...unique].sort((left, right) => left.length - right.length)
}

function mostSpecificContainingPath(roots: string[], target: string): string | undefined {
  return roots
    .filter((root) => isPathInside(root, target))
    .sort((left, right) => right.length - left.length)[0]
}

function isPathInside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function unsupportedStatus(detail: string): OsSandboxStatus {
  return {
    kind: 'none',
    available: false,
    fileIsolation: 'policy-only',
    foregroundNetworkIsolation: false,
    managedServerNetworkIsolation: 'shared-network',
    detail,
  }
}

function sandboxLiteral(path: string): string {
  return JSON.stringify(path)
}
