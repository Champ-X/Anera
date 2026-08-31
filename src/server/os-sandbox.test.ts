import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createShellInvocation, osSandboxStatus } from './os-sandbox.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OS command sandbox', () => {
  it('builds a Linux Bubblewrap boundary with a hidden home and writable workspace overlay', async () => {
    const home = await mkdtemp(resolve(tmpdir(), 'anera-linux-home-'))
    roots.push(home)
    const workspace = resolve(home, 'data', 'sessions', 'session-1', 'workspace')
    await mkdir(workspace, { recursive: true })
    const canonicalHome = realpathSync(home)
    const canonicalWorkspace = realpathSync(workspace)

    const invocation = createShellInvocation('python3 verify.py', workspace, 'none', {
      platform: 'linux',
      linuxBubblewrapPath: '/usr/bin/bwrap',
      shellPath: '/bin/bash',
      homeDirectory: home,
      runtimeExecutable: process.execPath,
    })

    expect(invocation.executable).toBe('/usr/bin/bwrap')
    expect(invocation.sandbox).toMatchObject({
      kind: 'linux-bubblewrap',
      fileIsolation: 'workspace-only',
      foregroundNetworkIsolation: true,
      managedServerNetworkIsolation: 'shared-network',
    })
    expect(invocation.args).toContain('--unshare-net')
    expect(optionPairs(invocation.args, '--tmpfs')).toContainEqual([canonicalHome])
    expect(optionPairs(invocation.args, '--bind')).toContainEqual([canonicalWorkspace, canonicalWorkspace])
    expect(invocation.args.slice(-4)).toEqual(['--', '/bin/bash', '-c', 'python3 verify.py'])
  })

  it('keeps managed Website networking host-reachable while retaining Bubblewrap file isolation', async () => {
    const home = await mkdtemp(resolve(tmpdir(), 'anera-linux-home-'))
    roots.push(home)
    const workspace = resolve(home, 'workspace')
    await mkdir(workspace, { recursive: true })
    const canonicalHome = realpathSync(home)
    const canonicalWorkspace = realpathSync(workspace)
    const invocation = createShellInvocation('npm run dev', workspace, 'server', {
      platform: 'linux',
      linuxBubblewrapPath: '/usr/bin/bwrap',
      shellPath: '/bin/bash',
      homeDirectory: home,
      runtimeExecutable: process.execPath,
    })

    expect(invocation.args).not.toContain('--unshare-net')
    expect(optionPairs(invocation.args, '--tmpfs')).toContainEqual([canonicalHome])
    expect(optionPairs(invocation.args, '--bind')).toContainEqual([canonicalWorkspace, canonicalWorkspace])
  })

  it('rejects a workspace equal to HOME instead of exposing the entire host home', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-linux-home-'))
    roots.push(workspace)
    expect(() => createShellInvocation('pwd', workspace, 'none', {
      platform: 'linux',
      linuxBubblewrapPath: '/usr/bin/bwrap',
      shellPath: '/bin/bash',
      homeDirectory: workspace,
      runtimeExecutable: process.execPath,
    })).toThrow('workspace cannot be the host home')
  })

  it('uses a portable Unix shell and reports an explicit policy-only fallback without Bubblewrap', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-linux-workspace-'))
    roots.push(workspace)
    const invocation = createShellInvocation('printf ok', workspace, 'none', {
      platform: 'linux',
      linuxBubblewrapPath: null,
      shellPath: '/bin/bash',
    })

    expect(invocation).toEqual({
      executable: '/bin/bash',
      args: ['-c', 'printf ok'],
      sandbox: {
        kind: 'none',
        available: false,
        fileIsolation: 'policy-only',
        foregroundNetworkIsolation: false,
        managedServerNetworkIsolation: 'shared-network',
        detail: 'Bubblewrap is unavailable',
      },
    })
  })

  it('uses cmd.exe syntax on Windows instead of a nonexistent zsh path', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-windows-workspace-'))
    roots.push(workspace)
    const invocation = createShellInvocation('echo ok', workspace, 'none', {
      platform: 'win32',
      shellPath: 'C:\\Windows\\System32\\cmd.exe',
    })

    expect(invocation.executable).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(invocation.args).toEqual(['/d', '/s', '/c', 'echo ok'])
    expect(invocation.sandbox.kind).toBe('none')
  })

  it('reports the injected sandbox capability without probing the host', () => {
    expect(osSandboxStatus({ platform: 'darwin', darwinSandboxPath: '/usr/bin/sandbox-exec' })).toMatchObject({
      kind: 'darwin-seatbelt',
      available: true,
      managedServerNetworkIsolation: 'outbound-denied',
    })
    expect(osSandboxStatus({ platform: 'linux', linuxBubblewrapPath: null })).toMatchObject({
      kind: 'none',
      available: false,
    })
  })

  it('keeps managed macOS Websites reachable while denying their outbound sockets', async () => {
    const home = await mkdtemp(resolve(tmpdir(), 'anera-darwin-home-'))
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-darwin-workspace-'))
    roots.push(home, workspace)
    const managed = createShellInvocation('npm run dev', workspace, 'server', {
      platform: 'darwin',
      darwinSandboxPath: '/usr/bin/sandbox-exec',
      shellPath: '/bin/zsh',
      homeDirectory: home,
      runtimeExecutable: process.execPath,
    })
    const registryInstall = createShellInvocation('npm install vite', workspace, 'full', {
      platform: 'darwin',
      darwinSandboxPath: '/usr/bin/sandbox-exec',
      shellPath: '/bin/zsh',
      homeDirectory: home,
      runtimeExecutable: process.execPath,
    })

    expect(managed.args[1]).toContain('(deny network-outbound)')
    expect(registryInstall.args[1]).not.toContain('(deny network-outbound)')
  })
})

function optionPairs(args: string[], option: string): string[][] {
  const width = option === '--tmpfs' ? 1 : 2
  const pairs: string[][] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== option) continue
    pairs.push(args.slice(index + 1, index + 1 + width))
  }
  return pairs
}
