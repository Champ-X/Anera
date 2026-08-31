import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(process.cwd())
const reportDirectory = resolve(process.env.ANERA_CANARY_REPORT_DIR || 'reports/production-canaries')
const generatedAt = new Date().toISOString()
const reportPath = resolve(reportDirectory, `os-sandbox-${generatedAt.replaceAll(':', '-')}.json`)
let temporaryRoot
let managedProcesses
let hostDecoy
let report

try {
  const { createShellInvocation, osSandboxStatus } = await import(
    pathToFileURL(resolve(projectRoot, 'dist-server/server/os-sandbox.js')).href
  )
  const { ProcessManager } = await import(
    pathToFileURL(resolve(projectRoot, 'dist-server/server/process-manager.js')).href
  )
  const detected = osSandboxStatus()
  report = {
    schemaVersion: 'anera-production-os-sandbox-canary/1.0',
    generatedAt,
    execution: 'real host sandbox process boundary; no simulated platform or executable overrides',
    fixturePolicy: 'forbidden',
    mobileExcluded: true,
    arenaParityGate: 'paused',
    host: {
      platform: process.platform,
      architecture: process.arch,
      sandbox: detected,
    },
  }

  if (process.platform !== 'darwin') {
    Object.assign(report, {
      outcome: 'blocked_host',
      passed: false,
      requiredHost: 'macOS with production-detected Seatbelt at /usr/bin/sandbox-exec',
    })
  } else if (!detected.available || detected.kind !== 'darwin-seatbelt') {
    Object.assign(report, {
      outcome: 'blocked_configuration',
      passed: false,
      missingCapability: 'sandbox-exec available to the production osSandboxStatus probe',
    })
  } else {
    temporaryRoot = await mkdtemp(resolve(tmpdir(), 'anera-real-seatbelt-canary-'))
    const hostHome = resolve(temporaryRoot, 'host-home')
    const workspace = resolve(temporaryRoot, 'workspace')
    const hostSecret = resolve(hostHome, 'host-only.txt')
    const workspaceResult = resolve(workspace, 'workspace-write.txt')
    const forbiddenForegroundWrite = resolve(temporaryRoot, 'foreground-outside.txt')
    const forbiddenManagedWrite = resolve(temporaryRoot, 'managed-outside.txt')
    await mkdir(hostHome, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(hostSecret, 'HOST-ONLY-CANARY-SENTINEL\n', { mode: 0o600 })

    hostDecoy = createServer((_request, response) => response.end('HOST-DECOY'))
    await new Promise((resolveListen, rejectListen) => {
      hostDecoy.once('error', rejectListen)
      hostDecoy.listen(0, '127.0.0.1', resolveListen)
    })
    const decoyAddress = hostDecoy.address()
    if (!decoyAddress || typeof decoyAddress === 'string') throw new Error('Could not allocate host decoy port')

    const foregroundProbePath = resolve(workspace, 'foreground-probe.mjs')
    await writeFile(foregroundProbePath, [
      "import { createConnection } from 'node:net'",
      'const port = Number.parseInt(process.argv[2], 10)',
      'let settled = false',
      "const socket = createConnection({ host: '127.0.0.1', port })",
      "socket.once('connect', () => { settled = true; socket.destroy(); process.exit(41) })",
      "socket.once('error', () => { settled = true; process.stdout.write('EGRESS_DENIED\\n') })",
      "setTimeout(() => { if (!settled) { socket.destroy(); process.exit(42) } }, 3000)",
      '',
    ].join('\n'), 'utf8')
    const foregroundCommand = [
      'set -eu',
      `test ! -r ${shellQuote(hostSecret)}`,
      `printf 'workspace-write-ok\\n' > ${shellQuote(workspaceResult)}`,
      `if printf 'forbidden\\n' > ${shellQuote(forbiddenForegroundWrite)} 2>/dev/null; then exit 43; fi`,
      `${shellQuote(process.execPath)} ${shellQuote(foregroundProbePath)} ${decoyAddress.port}`,
    ].join('; ')
    const foregroundInvocation = createShellInvocation(foregroundCommand, workspace, 'none', {
      homeDirectory: hostHome,
    })
    const foregroundStarted = performance.now()
    const foreground = await execFileAsync(foregroundInvocation.executable, foregroundInvocation.args, {
      timeout: 20_000,
      maxBuffer: 64_000,
    })
    const foregroundLatencyMs = roundedMs(performance.now() - foregroundStarted)
    if (foreground.stdout.trim() !== 'EGRESS_DENIED') {
      throw new Error(`Seatbelt foreground network oracle was not denied: ${foreground.stdout.trim() || 'no output'}`)
    }
    if ((await readFile(workspaceResult, 'utf8')) !== 'workspace-write-ok\n') {
      throw new Error('Seatbelt did not preserve the workspace write')
    }
    if ((await readFile(hostSecret, 'utf8')) !== 'HOST-ONLY-CANARY-SENTINEL\n') {
      throw new Error('Seatbelt changed the host-home sentinel')
    }
    await assertMissing(forbiddenForegroundWrite, 'Seatbelt allowed a foreground write outside the workspace')
    if (!foregroundInvocation.args[1]?.includes('(deny network-outbound)')) {
      throw new Error('Foreground Seatbelt invocation omitted outbound network denial')
    }

    const managedPort = await availablePort()
    const managedServerPath = resolve(workspace, 'managed-server.mjs')
    await writeFile(managedServerPath, [
      "import { writeFile } from 'node:fs/promises'",
      "import { createServer } from 'node:http'",
      "import { createConnection } from 'node:net'",
      "import { resolve } from 'node:path'",
      'const port = Number.parseInt(process.argv[2], 10)',
      'const decoyPort = Number.parseInt(process.argv[3], 10)',
      "const outsidePath = resolve(process.cwd(), '..', 'managed-outside.txt')",
      "try { await writeFile(outsidePath, 'forbidden\\n'); process.stdout.write('WRITE_ALLOWED\\n') }",
      "catch { process.stdout.write('WRITE_DENIED\\n') }",
      "const socket = createConnection({ host: '127.0.0.1', port: decoyPort })",
      'let egressSettled = false',
      "socket.once('connect', () => { egressSettled = true; socket.destroy(); process.stdout.write('EGRESS_ALLOWED\\n') })",
      "socket.once('error', () => { egressSettled = true; process.stdout.write('EGRESS_DENIED\\n') })",
      "setTimeout(() => { if (!egressSettled) { socket.destroy(); process.stdout.write('EGRESS_TIMEOUT\\n') } }, 3000)",
      "const server = createServer((_request, response) => response.end(JSON.stringify({ status: 'ok', boundary: 'seatbelt' })))",
      "server.listen(port, '127.0.0.1', () => process.stdout.write(`listening on ${port}\\n`))",
      "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)))",
      '',
    ].join('\n'), 'utf8')
    const managedCommand = `node managed-server.mjs ${managedPort} ${decoyAddress.port}`
    const managedInvocation = createShellInvocation(managedCommand, workspace, 'server')
    if (!managedInvocation.args[1]?.includes('(deny network-outbound)')) {
      throw new Error('Managed Website Seatbelt invocation omitted outbound network denial')
    }
    managedProcesses = new ProcessManager(() => {}, 64_000)
    const managedStarted = performance.now()
    const started = await managedProcesses.start('darwin-canary', workspace, managedCommand, managedPort)
    const ready = await managedProcesses.waitForPort('darwin-canary', started.id, 15_000)
    if (ready.port !== managedPort || !ready.listeningPorts?.some((listener) => listener.port === managedPort)) {
      throw new Error('ProcessManager did not verify the managed Seatbelt listener ownership')
    }
    const settled = await waitForManagedOracles(managedProcesses, started.id, 8_000)
    if (!settled.combinedOutput?.includes('WRITE_DENIED')) {
      throw new Error('Managed Seatbelt process did not prove outside-workspace write denial')
    }
    if (!settled.combinedOutput?.includes('EGRESS_DENIED')) {
      throw new Error('Managed Seatbelt process did not prove outbound denial')
    }
    if (settled.combinedOutput.includes('WRITE_ALLOWED') || settled.combinedOutput.includes('EGRESS_ALLOWED')) {
      throw new Error('Managed Seatbelt process crossed a denied boundary')
    }
    await assertMissing(forbiddenManagedWrite, 'Seatbelt allowed a managed write outside the workspace')
    const previewResponse = await fetch(`http://127.0.0.1:${managedPort}/health`, { signal: AbortSignal.timeout(5_000) })
    const preview = await previewResponse.json()
    if (!previewResponse.ok || preview?.status !== 'ok' || preview?.boundary !== 'seatbelt') {
      throw new Error('Host Preview could not reach the managed Seatbelt Website')
    }
    const managedLatencyMs = roundedMs(performance.now() - managedStarted)

    Object.assign(report, {
      outcome: 'passed',
      passed: true,
      foreground: {
        latencyMs: foregroundLatencyMs,
        workspaceWritePersisted: true,
        hostHomeReadDenied: true,
        outsideWorkspaceWriteDenied: true,
        outboundDeniedAgainstReachableHostDecoy: true,
        stdoutBytes: Buffer.byteLength(foreground.stdout || ''),
        stderrBytes: Buffer.byteLength(foreground.stderr || ''),
      },
      managedWebsite: {
        latencyMs: managedLatencyMs,
        hostPreviewReachable: true,
        outsideWorkspaceWriteDenied: true,
        outboundDeniedAgainstReachableHostDecoy: true,
        fileIsolation: managedInvocation.sandbox.fileIsolation,
        networkIsolation: managedInvocation.sandbox.managedServerNetworkIsolation,
        listenerOwnershipVerified: true,
        verifiedPort: ready.port,
        outputBytes: Buffer.byteLength(settled.combinedOutput || ''),
      },
    })
  }
} catch (error) {
  report = {
    ...(report || {
      schemaVersion: 'anera-production-os-sandbox-canary/1.0',
      generatedAt,
      fixturePolicy: 'forbidden',
      mobileExcluded: true,
      arenaParityGate: 'paused',
    }),
    outcome: 'failed',
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  }
} finally {
  if (managedProcesses) await managedProcesses.stopEverything()
  if (hostDecoy?.listening) await new Promise((resolveClose) => hostDecoy.close(resolveClose))
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
if (report.outcome === 'failed') process.exitCode = 1
else if (!report.passed) process.exitCode = 2

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

async function availablePort() {
  const server = createServer()
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Could not allocate a managed Website canary port')
    return address.port
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose))
  }
}

async function waitForManagedOracles(manager, processId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = manager.get('darwin-canary', processId)
    if (!record) throw new Error('Managed Seatbelt process disappeared')
    const output = record.combinedOutput || ''
    if (output.includes('WRITE_DENIED') && /EGRESS_(?:DENIED|ALLOWED|TIMEOUT)/.test(output)) return record
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  const record = manager.get('darwin-canary', processId)
  if (!record) throw new Error('Managed Seatbelt process disappeared')
  return record
}

async function assertMissing(path, message) {
  try {
    await stat(path)
    throw new Error(message)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
}

function roundedMs(value) {
  return Math.round(value * 1000) / 1000
}
