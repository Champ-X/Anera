import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { endianness, homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { platform } from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { ProcessManager, runCommand, terminateRecoveredManagedProcess, type ProcessEvent, type ProcessEventContext } from './process-manager.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('process manager', () => {
  it('does not return a managed process until its started boundary is durable', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    roots.push(workspace)
    let releaseStarted!: () => void
    const startedGate = new Promise<void>((resolveGate) => { releaseStarted = resolveGate })
    let enteredStartedPersistence = false
    const eventTypes: string[] = []
    const manager = new ProcessManager(async (_sessionId, event) => {
      eventTypes.push(event.type)
      if (event.type === 'started') {
        enteredStartedPersistence = true
        await startedGate
      }
    }, 10_000)

    let settled = false
    const starting = manager.start('session', workspace, `python3 -u -c "import time; time.sleep(30)"`)
    void starting.then(() => { settled = true })
    await waitUntil(() => enteredStartedPersistence)
    expect(settled).toBe(false)
    releaseStarted()
    const record = await starting
    expect(eventTypes[0]).toBe('started')
    await manager.stop('session', record.id)
  })

  it('does not signal a live process when the durable PID identity does not match', async () => {
    if (platform === 'win32') return
    const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    if (!unrelated.pid) throw new Error('Unrelated test process did not start')
    try {
      const result = await terminateRecoveredManagedProcess({
        id: 'proc_identitymismatch01',
        command: 'npm run dev',
        pid: unrelated.pid,
        status: 'running',
        startedAt: new Date().toISOString(),
        stdout: '',
        stderr: '',
      })
      expect(result).toMatchObject({ identity: 'mismatch', action: 'not_killed', forced: false })
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
    } finally {
      unrelated.kill('SIGKILL')
    }
  })

  it('captures output and terminates a managed server process', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    roots.push(workspace)
    const events: Array<{ type: string; chunk?: string; context: ProcessEventContext }> = []
    const manager = new ProcessManager((_sessionId, event, context) => {
      events.push({ type: event.type, chunk: event.type === 'output' ? event.chunk : undefined, context })
    }, 10_000)
    const eventContext = { turnId: 'turn_process', stepId: 'step_process', callId: 'call_process' }
    const process = await manager.start(
      'session',
      workspace,
      `python3 -u -c "import time; print('READY', flush=True); time.sleep(30)"`,
      undefined,
      eventContext,
    )
    await waitUntil(() => events.some((event) => event.chunk?.includes('READY')))
    const stopped = await manager.stop('session', process.id)
    expect(stopped.status).toBe('stopped')
    expect(events.some((event) => event.type === 'stopped')).toBe(true)
    expect(events).not.toHaveLength(0)
    expect(events.every((event) => event.context === eventContext)).toBe(true)
  })

  it('preserves the user-facing name and interleaved stdout/stderr order', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-interleaved-'))
    roots.push(workspace)
    const manager = new ProcessManager(() => {}, 10_000)
    const record = await manager.start(
      'session',
      workspace,
      `python3 -u -c "import sys,time;print('OUT-1',flush=True);time.sleep(.05);print('ERR-1',file=sys.stderr,flush=True);time.sleep(.05);print('OUT-2',flush=True);time.sleep(30)"`,
      undefined,
      {},
      'API server',
    )
    await waitUntil(() => manager.get('session', record.id)?.combinedOutput?.includes('OUT-2') === true)
    const observed = manager.get('session', record.id)
    expect(observed?.name).toBe('API server')
    expect(observed?.combinedOutput).toMatch(/OUT-1\s+ERR-1\s+OUT-2/)
    await manager.stopEverything()
  })

  it('terminates the full managed subprocess tree without leaving an orphan', async () => {
    if (platform === 'win32') return
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    roots.push(workspace)
    await writeTreeProbe(workspace, 'managed-orphan.txt')
    const events: Array<{ type: string; chunk?: string }> = []
    const manager = new ProcessManager((_sessionId, event) => {
      events.push({ type: event.type, chunk: event.type === 'output' ? event.chunk : undefined })
    }, 10_000)
    const record = await manager.start('session', workspace, 'python3 -u tree_probe.py')
    await waitUntil(() => events.some((event) => event.chunk?.includes('CHILD_STARTED')))
    await manager.stop('session', record.id)
    await new Promise((resolveWait) => setTimeout(resolveWait, 700))
    expect(existsSync(resolve(workspace, 'managed-orphan.txt'))).toBe(false)
  })

  it('detects a dev-server port and performs a real process restart', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    roots.push(workspace)
    const manager = new ProcessManager(() => {}, 10_000)
    const first = await manager.start('session', workspace, `python3 -u -c "import http.server; print('Local: http://localhost:43127', flush=True); http.server.HTTPServer(('127.0.0.1',43127), http.server.SimpleHTTPRequestHandler).serve_forever()"`)
    const ready = await manager.waitForPort('session', first.id)
    expect(ready).toMatchObject({ status: 'running', port: 43127 })

    const restarted = await manager.restart('session', workspace, first.id)
    expect(restarted.id).not.toBe(first.id)
    expect(restarted).toMatchObject({ status: 'running', port: 43127 })
    expect(manager.get('session', first.id)?.status).toBe('stopped')
    await manager.stopEverything()
  })

  it('keeps command-detected ports as unverified hints until an owned listener is observed', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    roots.push(workspace)
    const manager = new ProcessManager(() => {}, 10_000)
    const server = await manager.start('session', workspace, 'python3 -m http.server 43128 --bind 0.0.0.0')
    expect(server).toMatchObject({ port: undefined, portHint: 43128, listeningPorts: [], newPorts: [] })
    expect(await manager.waitForPort('session', server.id)).toMatchObject({
      port: 43128,
      portHint: 43128,
      listeningPorts: [{ port: 43128, address: '0.0.0.0' }],
      newPorts: [{ port: 43128, address: '0.0.0.0' }],
    })
    await manager.stopEverything()
  })

  it('publishes durable ownership snapshots for verified ports and later fail-closed clears', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-port-updates-'))
    roots.push(workspace)
    const events: ProcessEvent[] = []
    let ownershipAvailable = true
    const port = 43_190
    const manager = new ProcessManager((_sessionId, event) => { events.push(event) }, 10_000, {
      portProbe: async () => ownershipAvailable
        ? { ports: [{ port, address: '0.0.0.0' }], ownershipVerified: true }
        : { ports: [], ownershipVerified: false },
    })

    try {
      const target = await manager.start(
        'session',
        workspace,
        `python3 -u -c "import time;time.sleep(30)"`,
        port,
      )
      expect(await manager.refreshPorts('session', target.id)).toMatchObject({
        port,
        listeningPorts: [{ port, address: '0.0.0.0' }],
        newPorts: [{ port, address: '0.0.0.0' }],
      })
      expect(events.filter((event) => event.type === 'updated')).toEqual([
        expect.objectContaining({
          type: 'updated',
          record: expect.objectContaining({
            port,
            listeningPorts: [{ port, address: '0.0.0.0' }],
            newPorts: [{ port, address: '0.0.0.0' }],
          }),
        }),
      ])
      expect(events.filter((event) => event.type === 'output')).toEqual([])

      ownershipAvailable = false
      expect(await manager.refreshPorts('session', target.id)).toMatchObject({
        port: undefined,
        listeningPorts: [],
        newPorts: [],
      })
      const updates = events.filter((event) => event.type === 'updated')
      expect(updates).toHaveLength(2)
      expect(updates[1]).toMatchObject({
        record: { port: undefined, listeningPorts: [], newPorts: [] },
      })

      // An unchanged unknown snapshot is not persisted repeatedly.
      await manager.refreshPorts('session', target.id)
      expect(events.filter((event) => event.type === 'updated')).toHaveLength(2)
      expect(events.filter((event) => event.type === 'output')).toEqual([])
    } finally {
      await manager.stopEverything()
    }
  })

  it('never exposes a verified port after its durable ownership update fails', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-port-update-failure-'))
    roots.push(workspace)
    const port = 43_191
    const manager = new ProcessManager((_sessionId, event) => {
      if (event.type === 'updated') throw new Error('synthetic process snapshot persistence failure')
    }, 10_000, {
      portProbe: async () => ({
        ports: [{ port, address: '0.0.0.0' }],
        ownershipVerified: true,
      }),
    })

    try {
      const target = await manager.start(
        'session',
        workspace,
        `python3 -u -c "import time;time.sleep(30)"`,
        port,
      )
      await expect(manager.refreshPorts('session', target.id)).rejects.toThrow('synthetic process snapshot persistence failure')
      expect(manager.get('session', target.id)).toMatchObject({
        port: undefined,
        listeningPorts: [],
        newPorts: [],
      })

      // A retry must hit the still-failed durable boundary instead of
      // returning the ownership probe's in-memory result as previewable.
      await expect(manager.refreshPorts('session', target.id)).rejects.toThrow('synthetic process snapshot persistence failure')
      expect(manager.get('session', target.id)?.port).toBeUndefined()
    } finally {
      await manager.stopEverything()
    }
  })

  it('uses and preserves a port hint for package-manager wrapper commands', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    roots.push(workspace)
    await writeFile(resolve(workspace, 'package.json'), JSON.stringify({
      scripts: { start: 'python3 -m http.server 43126 --bind 0.0.0.0' },
    }))
    const manager = new ProcessManager(() => {}, 10_000)
    const wrapped = await manager.start('session', workspace, 'npm run start', 43126)
    expect(wrapped).toMatchObject({ port: undefined, portHint: 43126 })
    expect(await manager.waitForPort('session', wrapped.id)).toMatchObject({ status: 'running', port: 43126 })
    const restarted = await manager.restart('session', workspace, wrapped.id)
    expect(restarted).toMatchObject({ status: 'running', port: 43126 })
    await manager.stopEverything()
  })

  it('attributes reverse-ordered silent server ports to their owning managed process', async () => {
    if (platform === 'win32') return
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-owned-ports-'))
    roots.push(workspace)
    await writeSilentHttpServer(workspace)
    const [lowPort, highPort] = (await reserveFreePorts(2)).sort((left, right) => left - right)
    const manager = new ProcessManager(() => {}, 10_000)

    try {
      const high = await manager.start(
        'session',
        workspace,
        `python3 -u silent_http_server.py ${highPort} guardian-high`,
      )
      expect(high).toMatchObject({ port: undefined, listeningPorts: [], newPorts: [] })
      await waitForHttpMarker(highPort, 'guardian-high')

      const low = await manager.start(
        'session',
        workspace,
        `python3 -u silent_http_server.py ${lowPort} guardian-low`,
      )
      // Starting a second guardian must not copy the first guardian's live
      // listener into the new process record.
      expect(low).toMatchObject({ port: undefined, listeningPorts: [], newPorts: [] })
      await waitForHttpMarker(lowPort, 'guardian-low')

      const highPortRecord = { port: highPort, address: '0.0.0.0' }
      const lowPortRecord = { port: lowPort, address: '0.0.0.0' }
      const refreshedHigh = await manager.refreshPorts('session', high.id)
      expect(refreshedHigh).toMatchObject({
        port: highPort,
        listeningPorts: [highPortRecord],
        newPorts: [highPortRecord],
      })

      // refreshPorts keeps every record current, while get still returns only
      // the requested guardian's own listener and preferred port.
      expect(manager.get('session', low.id)).toMatchObject({
        port: lowPort,
        listeningPorts: [lowPortRecord],
        newPorts: [lowPortRecord],
      })
      expect(await manager.refreshPorts('session', low.id)).toMatchObject({
        port: lowPort,
        listeningPorts: [lowPortRecord],
        newPorts: [lowPortRecord],
      })

      const listed = new Map(manager.list('session').map((record) => [record.id, record]))
      expect(listed.get(high.id)).toMatchObject({
        port: highPort,
        listeningPorts: [highPortRecord],
        newPorts: [highPortRecord],
      })
      expect(listed.get(low.id)).toMatchObject({
        port: lowPort,
        listeningPorts: [lowPortRecord],
        newPorts: [lowPortRecord],
      })

      // The selected preferred port must route back to the same guardian,
      // even though the later server owns the numerically smaller port.
      await waitForHttpMarker(refreshedHigh?.port, 'guardian-high')
      await waitForHttpMarker(manager.get('session', low.id)?.port, 'guardian-low')
    } finally {
      await manager.stopEverything()
    }
  })

  it('fails closed instead of borrowing same-session, cross-session, or host decoy ports when ownership is unavailable', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-port-decoys-'))
    roots.push(workspace)
    await writeSilentHttpServer(workspace)
    const [sameSessionPort, crossSessionPort] = await reserveFreePorts(2)
    const hostDecoy = createServer((socket) => socket.end('host-decoy'))
    await new Promise<void>((resolveListen) => hostDecoy.listen(0, '127.0.0.1', resolveListen))
    const hostPort = (hostDecoy.address() as AddressInfo).port
    const manager = new ProcessManager(() => {}, 10_000, {
      platform: 'linux',
      procRoot: resolve(workspace, 'unavailable-procfs'),
    })
    const windowsManager = new ProcessManager(() => {}, 10_000, { platform: 'win32' })

    try {
      await manager.start(
        'same-session',
        workspace,
        `python3 -u silent_http_server.py ${sameSessionPort} same-session-decoy`,
      )
      await waitForHttpMarker(sameSessionPort, 'same-session-decoy')
      await manager.start(
        'cross-session',
        workspace,
        `python3 -u silent_http_server.py ${crossSessionPort} cross-session-decoy`,
      )
      await waitForHttpMarker(crossSessionPort, 'cross-session-decoy')

      for (const [label, port] of [
        ['same-session', sameSessionPort],
        ['cross-session', crossSessionPort],
        ['host', hostPort],
      ] as const) {
        const target = await manager.start(
          'same-session',
          workspace,
          `python3 -u -c "import time;print('listening on ${port}',flush=True);time.sleep(30)"`,
          port,
          {},
          `${label} target`,
        )
        await waitUntil(() => manager.get('same-session', target.id)?.stdout.includes(String(port)) === true)
        expect(manager.get('same-session', target.id)).toMatchObject({
          port: undefined,
          portHint: port,
          listeningPorts: [],
          newPorts: [],
        })
        expect(await manager.waitForPort('same-session', target.id, 160)).toMatchObject({
          status: 'running',
          port: undefined,
          portHint: port,
          listeningPorts: [],
          newPorts: [],
        })
      }

      const windowsTarget = await windowsManager.start(
        'windows-session',
        workspace,
        `python3 -u -c "import time;print('listening on ${hostPort}',flush=True);time.sleep(30)"`,
        hostPort,
      )
      expect(await windowsManager.waitForPort('windows-session', windowsTarget.id, 160)).toMatchObject({
        status: 'running',
        port: undefined,
        portHint: hostPort,
        listeningPorts: [],
        newPorts: [],
      })
    } finally {
      await manager.stopEverything()
      await windowsManager.stopEverything()
      await new Promise<void>((resolveClose) => hostDecoy.close(() => resolveClose()))
    }
  })

  it('uses Linux procfs socket ownership for IPv4 and IPv6 listeners held by a descendant', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-linux-proc-'))
    const procRoot = resolve(workspace, 'proc')
    roots.push(workspace)
    await mkdir(procRoot)
    const manager = new ProcessManager(() => {}, 10_000, { platform: 'linux', procRoot })
    const ipv4Port = 44_221
    const ipv6Port = 44_222

    try {
      const target = await manager.start(
        'session',
        workspace,
        `python3 -u -c "import time;time.sleep(30)"`,
        ipv6Port,
      )
      if (!target.pid) throw new Error('Managed guardian did not expose a PID')
      expect(target).toMatchObject({ port: undefined, portHint: ipv6Port })
      await writeLinuxProcFixture(procRoot, {
        rootPid: target.pid,
        managedId: target.id,
        ipv4Port,
        ipv6Port,
      })

      expect(await manager.refreshPorts('session', target.id)).toMatchObject({
        // The verified hint wins preferred-port ranking even though it is the
        // numerically larger of the two owned listeners.
        port: ipv6Port,
        portHint: ipv6Port,
        listeningPorts: [
          { port: ipv4Port, address: '0.0.0.0' },
          { port: ipv6Port, address: '::1' },
        ],
        newPorts: [
          { port: ipv4Port, address: '0.0.0.0' },
          { port: ipv6Port, address: '::1' },
        ],
      })
    } finally {
      await manager.stopEverything()
    }
  })

  it('rejects an owned-looking procfs listener when the guardian PID identity was reused', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-linux-reused-pid-'))
    const procRoot = resolve(workspace, 'proc')
    roots.push(workspace)
    await mkdir(procRoot)
    const manager = new ProcessManager(() => {}, 10_000, { platform: 'linux', procRoot })

    try {
      const target = await manager.start(
        'session',
        workspace,
        `python3 -u -c "import time;print('listening on 44223',flush=True);time.sleep(30)"`,
        44_223,
      )
      if (!target.pid) throw new Error('Managed guardian did not expose a PID')
      await writeLinuxProcFixture(procRoot, {
        rootPid: target.pid,
        managedId: 'proc_reusedguardian00000',
        ipv4Port: 44_223,
        ipv6Port: 44_224,
      })

      expect(await manager.refreshPorts('session', target.id)).toMatchObject({
        status: 'running',
        port: undefined,
        portHint: 44_223,
        listeningPorts: [],
        newPorts: [],
      })
    } finally {
      await manager.stopEverything()
    }
  })

  it('does not borrow a reported host port after the managed process exits', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-exited-port-'))
    roots.push(workspace)
    const hostDecoy = createServer((socket) => socket.end('host-decoy'))
    await new Promise<void>((resolveListen) => hostDecoy.listen(0, '127.0.0.1', resolveListen))
    const port = (hostDecoy.address() as AddressInfo).port
    const manager = new ProcessManager(() => {}, 10_000)

    try {
      const target = await manager.start(
        'session',
        workspace,
        `python3 -u -c "print('listening on ${port}',flush=True)"`,
        port,
      )
      await waitUntil(() => manager.get('session', target.id)?.status !== 'running')
      expect(await manager.refreshPorts('session', target.id)).toMatchObject({
        status: 'exited',
        port: undefined,
        portHint: port,
        listeningPorts: [],
        newPorts: [],
      })
    } finally {
      await manager.stopEverything()
      await new Promise<void>((resolveClose) => hostDecoy.close(() => resolveClose()))
    }
  })

  it('uses the OS sandbox to deny encoded access outside the workspace on macOS', async () => {
    if (platform !== 'darwin') return
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    const outside = await mkdtemp(resolve(homedir(), '.anera-process-outside-'))
    roots.push(workspace, outside)
    const target = resolve(outside, 'secret.txt')
    await writeFile(target, 'must-not-be-readable\n')
    const encoded = Buffer.from(target).toString('hex')
    const result = await runCommand({
      command: `python3 -c "print(open(bytes.fromhex('${encoded}').decode()).read())"`,
      workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
      onOutput: () => {},
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toContain('must-not-be-readable')
    expect(result.stderr).toMatch(/Operation not permitted|Permission denied/)
  })

  it('uses the OS sandbox to deny outbound sockets while still allowing local servers on macOS', async () => {
    if (platform !== 'darwin') return
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    roots.push(workspace)
    const result = await runCommand({
      command: `python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect(('1.1.1.1',80))"`,
      workspace,
      timeoutMs: 3_000,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
      onOutput: () => {},
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/Operation not permitted|Permission denied/)
  })

  it('passes trusted one-command environment overrides through the durable guardian and workspace sandbox', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-broker-env-'))
    roots.push(workspace)
    const askpass = resolve(workspace, '.git', 'askpass.sh')
    await mkdir(resolve(workspace, '.git'))
    await writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$ANERA_BROKER_TEST_TOKEN"\n', { mode: 0o700 })
    const result = await runCommand({
      command: '"$GIT_ASKPASS" Password',
      workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
      onOutput: () => {},
      allowNetwork: true,
      environment: {
        GIT_ASKPASS: askpass,
        ANERA_BROKER_TEST_TOKEN: 'synthetic-broker-token',
      },
    })

    expect(result).toMatchObject({ exitCode: 0, stdout: 'synthetic-broker-token\n', stderr: '' })
  })

  it('does not start a foreground command until the guardian boundary is durable', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    roots.push(workspace)
    let releaseGuardian!: () => void
    const guardianGate = new Promise<void>((resolveGate) => { releaseGuardian = resolveGate })
    let guardianReady = false
    const running = runCommand({
      command: `python3 -c "from pathlib import Path; Path('started-after-durable.txt').write_text('started')"`,
      workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
      onOutput: () => {},
      onGuardianReady: async () => {
        guardianReady = true
        await guardianGate
      },
    })

    await waitUntil(() => guardianReady)
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    expect(existsSync(resolve(workspace, 'started-after-durable.txt'))).toBe(false)

    releaseGuardian()
    const result = await running
    expect(result.exitCode).toBe(0)
    expect(existsSync(resolve(workspace, 'started-after-durable.txt'))).toBe(true)
  })

  it('leaves the workspace unchanged when guardian persistence fails', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    roots.push(workspace)
    const running = runCommand({
      command: `python3 -c "from pathlib import Path; Path('must-not-start.txt').write_text('started')"`,
      workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
      onOutput: () => {},
      onGuardianReady: async () => { throw new Error('durable checkpoint failed') },
    })

    await expect(running).rejects.toThrow('durable checkpoint failed')
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    expect(existsSync(resolve(workspace, 'must-not-start.txt'))).toBe(false)
  })

  it('tracks stdout and stderr truncation independently at the capture boundary', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-stream-limits-'))
    roots.push(workspace)
    const stdoutHeavy = await runCommand({
      command: `python3 -c "import sys;sys.stdout.write('O'*12000);sys.stderr.write('err')"`,
      workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
      onOutput: () => {},
    })
    expect(stdoutHeavy.stdout).toHaveLength(10_000)
    expect(stdoutHeavy.stderr).toBe('err')
    expect(stdoutHeavy).toMatchObject({ truncated: true, stdoutTruncated: true, stderrTruncated: false })

    const stderrHeavy = await runCommand({
      command: `python3 -c "import sys;sys.stdout.write('ok');sys.stderr.write('E'*12000)"`,
      workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
      onOutput: () => {},
    })
    expect(stderrHeavy.stdout).toBe('ok')
    expect(stderrHeavy.stderr).toHaveLength(10_000)
    expect(stderrHeavy).toMatchObject({ truncated: true, stdoutTruncated: false, stderrTruncated: true })
  })

  it('distinguishes automatic timeout from user cancellation and terminates the child', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    roots.push(workspace)
    const result = await runCommand({
      command: `python3 -u -c "import time; print('START', flush=True); time.sleep(10)"`,
      workspace,
      timeoutMs: 150,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
      onOutput: () => {},
    })

    expect(result.timedOut).toBe(true)
    expect(result.stdout).toContain('START')
    expect(result.stderr).toContain('timed out after 150ms')
    expect(result.signal).toBe('SIGTERM')
  })

  it('kills descendant processes when a foreground command times out', async () => {
    if (platform === 'win32') return
    const workspace = await mkdtemp(resolve(tmpdir(), 'anera-process-'))
    roots.push(workspace)
    await writeTreeProbe(workspace, 'timeout-orphan.txt')
    const result = await runCommand({
      command: 'python3 -u tree_probe.py',
      workspace,
      timeoutMs: 150,
      maxOutputBytes: 10_000,
      signal: new AbortController().signal,
      onOutput: () => {},
    })

    expect(result.timedOut).toBe(true)
    await new Promise((resolveWait) => setTimeout(resolveWait, 700))
    expect(existsSync(resolve(workspace, 'timeout-orphan.txt'))).toBe(false)
  })
})

async function writeTreeProbe(workspace: string, marker: string): Promise<void> {
  await writeFile(resolve(workspace, 'tree_child.py'), `import time\ntime.sleep(0.45)\nopen(${JSON.stringify(marker)}, 'w').write('orphaned')\n`)
  await writeFile(resolve(workspace, 'tree_probe.py'), "import subprocess, sys, time\nsubprocess.Popen([sys.executable, 'tree_child.py'])\nprint('CHILD_STARTED', flush=True)\ntime.sleep(10)\n")
}

async function writeSilentHttpServer(workspace: string): Promise<void> {
  await writeFile(resolve(workspace, 'silent_http_server.py'), [
    'from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer',
    'import sys',
    'marker = sys.argv[2].encode()',
    'class Handler(BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    '        self.send_response(200)',
    "        self.send_header('Content-Type', 'text/plain')",
    "        self.send_header('Content-Length', str(len(marker)))",
    '        self.end_headers()',
    '        self.wfile.write(marker)',
    '    def log_message(self, format, *args):',
    '        pass',
    "ThreadingHTTPServer(('0.0.0.0', int(sys.argv[1])), Handler).serve_forever()",
    '',
  ].join('\n'))
}

async function writeLinuxProcFixture(procRoot: string, options: {
  rootPid: number
  managedId: string
  ipv4Port: number
  ipv6Port: number
}): Promise<void> {
  const childPid = options.rootPid + 100_000
  const grandchildPid = childPid + 1
  const unrelatedPid = childPid + 2
  const namespace = 'net:[70001]'
  const rows = [
    { pid: options.rootPid, parent: 1, group: options.rootPid, startTime: '10001' },
    // The guardian's direct child has its own process group, matching the
    // durable guardian's detached spawn behavior.
    { pid: childPid, parent: options.rootPid, group: childPid, startTime: '10002' },
    { pid: grandchildPid, parent: childPid, group: childPid, startTime: '10003' },
    { pid: unrelatedPid, parent: 1, group: unrelatedPid, startTime: '10004' },
  ]
  const tcpHeader = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
  const tcp = [
    tcpHeader,
    linuxProcTcpRow(0, '00000000', options.ipv4Port, '700001'),
    // Visible in the same namespace table, but held only by an unrelated PID.
    linuxProcTcpRow(1, '00000000', 44_299, '700003'),
    '',
  ].join('\n')
  const tcp6 = [
    tcpHeader,
    linuxProcTcpRow(0, linuxProcIpv6Loopback(), options.ipv6Port, '700002'),
    '',
  ].join('\n')

  for (const row of rows) {
    const directory = resolve(procRoot, String(row.pid))
    await mkdir(resolve(directory, 'fd'), { recursive: true })
    await mkdir(resolve(directory, 'ns'), { recursive: true })
    await mkdir(resolve(directory, 'net'), { recursive: true })
    await writeFile(resolve(directory, 'stat'), linuxProcStat(row.pid, row.parent, row.group, row.startTime))
    await writeFile(resolve(directory, 'cmdline'), row.pid === options.rootPid
      ? `${process.execPath}\0/workspace/scripts/managed-process-guardian.mjs\0--managed-id=${options.managedId}\0`
      : `python3\0worker.py\0`)
    await symlink(namespace, resolve(directory, 'ns', 'net'))
    await writeFile(resolve(directory, 'net', 'tcp'), tcp)
    await writeFile(resolve(directory, 'net', 'tcp6'), tcp6)
  }
  await symlink('socket:[700001]', resolve(procRoot, String(grandchildPid), 'fd', '10'))
  await symlink('socket:[700002]', resolve(procRoot, String(grandchildPid), 'fd', '11'))
  await symlink('socket:[700003]', resolve(procRoot, String(unrelatedPid), 'fd', '12'))
}

function linuxProcStat(pid: number, parent: number, group: number, startTime: string): string {
  const fields = Array.from({ length: 20 }, () => '0')
  fields[0] = 'S'
  fields[1] = String(parent)
  fields[2] = String(group)
  fields[19] = startTime
  return `${pid} (managed fixture ${pid}) ${fields.join(' ')}\n`
}

function linuxProcTcpRow(index: number, address: string, port: number, inode: string): string {
  return ` ${index}: ${address}:${port.toString(16).padStart(4, '0').toUpperCase()} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 ${inode} 1`
}

function linuxProcIpv6Loopback(): string {
  const bytes = Array.from({ length: 16 }, (_, index) => index === 15 ? 1 : 0)
  const encoded: number[] = []
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const word = bytes.slice(offset, offset + 4)
    encoded.push(...(endianness() === 'LE' ? word.reverse() : word))
  }
  return encoded.map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

async function reserveFreePorts(count: number): Promise<number[]> {
  const servers: Server[] = []
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer()
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', resolveListen)
      })
      servers.push(server)
    }
    return servers.map((server) => (server.address() as AddressInfo).port)
  } finally {
    await Promise.all(servers.map(async (server) => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }))
  }
}

async function waitForHttpMarker(port: number | undefined, marker: string): Promise<void> {
  if (!port) throw new Error(`No port available for ${marker}`)
  for (let index = 0; index < 80; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (response.ok && await response.text() === marker) return
    } catch {
      // The server may still be binding its listener.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error(`Timed out waiting for HTTP marker ${marker} on port ${port}`)
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for process output')
}
