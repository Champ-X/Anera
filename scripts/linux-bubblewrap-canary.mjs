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
const reportPath = resolve(reportDirectory, `linux-bubblewrap-${generatedAt.replaceAll(':', '-')}.json`)
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
    schemaVersion: 'anera-production-linux-bubblewrap-canary/1.0',
    generatedAt,
    execution: 'real host Bubblewrap process boundary; no simulated platform or executable overrides',
    fixturePolicy: 'forbidden',
    mobileExcluded: true,
    arenaParityGate: 'paused',
    host: {
      platform: process.platform,
      architecture: process.arch,
      sandbox: detected,
    },
  }

  if (process.platform !== 'linux') {
    Object.assign(report, {
      outcome: 'blocked_host',
      passed: false,
      requiredHost: 'Linux with production-detected Bubblewrap at /usr/bin/bwrap or /bin/bwrap',
    })
  } else if (!detected.available || detected.kind !== 'linux-bubblewrap') {
    Object.assign(report, {
      outcome: 'blocked_configuration',
      passed: false,
      missingCapability: 'Bubblewrap executable available to the production osSandboxStatus probe',
    })
  } else {
    temporaryRoot = await mkdtemp(resolve(tmpdir(), 'anera-real-bwrap-canary-'))
    const hostHome = resolve(temporaryRoot, 'host-home')
    const workspace = resolve(temporaryRoot, 'workspace')
    const hostSecret = resolve(hostHome, 'host-only.txt')
    const workspaceResult = resolve(workspace, 'workspace-write.txt')
    const forbiddenHostWrite = `/etc/anera-bwrap-canary-${process.pid}`
    await mkdir(hostHome, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(hostSecret, 'HOST-ONLY-CANARY-SENTINEL\n', { mode: 0o600 })

    const foregroundCommand = [
      'set -eu',
      `test ! -r ${shellQuote(hostSecret)}`,
      `printf 'workspace-write-ok\\n' > ${shellQuote(workspaceResult)}`,
      `if printf 'forbidden\\n' > ${shellQuote(forbiddenHostWrite)} 2>/dev/null; then exit 41; fi`,
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
    if ((await readFile(workspaceResult, 'utf8')) !== 'workspace-write-ok\n') {
      throw new Error('Bubblewrap did not preserve the workspace write')
    }
    if ((await readFile(hostSecret, 'utf8')) !== 'HOST-ONLY-CANARY-SENTINEL\n') {
      throw new Error('Bubblewrap changed the host-home sentinel')
    }
    try {
      await stat(forbiddenHostWrite)
      throw new Error('Bubblewrap allowed a persistent write under /etc')
    } catch (error) {
      if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
    }
    if (!foregroundInvocation.args.includes('--unshare-net')) {
      throw new Error('Foreground Bubblewrap invocation omitted the private network namespace')
    }

    const [lowPort, highPort] = (await availablePorts(2)).sort((left, right) => left - right)
    const serverPath = resolve(workspace, 'managed-server.mjs')
    await writeFile(serverPath, [
      "import { createServer } from 'node:http'",
      "const port = Number.parseInt(process.argv[2], 10)",
      "const marker = process.argv[3]",
      "const server = createServer((_request, response) => {",
      "  response.writeHead(200, { 'content-type': 'application/json' })",
      "  response.end(JSON.stringify({ status: 'ok', boundary: 'bubblewrap', marker }))",
      "})",
      "server.listen(port, '127.0.0.1')",
      "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)))",
      '',
    ].join('\n'), 'utf8')
    const serverInvocation = createShellInvocation(
      `${shellQuote(process.execPath)} ${shellQuote(serverPath)} ${highPort} guardian-high`,
      workspace,
      'server',
      { homeDirectory: hostHome },
    )
    if (serverInvocation.args.includes('--unshare-net')) {
      throw new Error('Managed Website Bubblewrap invocation unexpectedly isolated the host-reachable network')
    }
    const serverStarted = performance.now()
    managedProcesses = new ProcessManager(() => {}, 64_000)
    const high = await managedProcesses.start(
      'linux-canary',
      workspace,
      `${shellQuote(process.execPath)} ${shellQuote(serverPath)} ${highPort} guardian-high`,
    )
    const highReady = await managedProcesses.waitForPort('linux-canary', high.id, 15_000)
    const low = await managedProcesses.start(
      'linux-canary',
      workspace,
      `${shellQuote(process.execPath)} ${shellQuote(serverPath)} ${lowPort} guardian-low`,
    )
    const lowReady = await managedProcesses.waitForPort('linux-canary', low.id, 15_000)
    if (
      highReady.port !== highPort
      || lowReady.port !== lowPort
      || highReady.listeningPorts?.some((listener) => listener.port === lowPort)
      || lowReady.listeningPorts?.some((listener) => listener.port === highPort)
    ) {
      throw new Error('ProcessManager did not preserve per-guardian Linux procfs port ownership')
    }

    hostDecoy = createServer((_request, response) => response.end('HOST-DECOY'))
    await new Promise((resolveListen, rejectListen) => {
      hostDecoy.once('error', rejectListen)
      hostDecoy.listen(0, '127.0.0.1', resolveListen)
    })
    const decoyAddress = hostDecoy.address()
    if (!decoyAddress || typeof decoyAddress === 'string') throw new Error('Could not allocate host decoy port')
    const decoy = await managedProcesses.start(
      'linux-canary',
      workspace,
      `${shellQuote(process.execPath)} -e ${shellQuote(`process.stdout.write('listening on ${decoyAddress.port}\\n');setInterval(()=>{},1000)`)}`,
      decoyAddress.port,
    )
    const decoyReady = await managedProcesses.waitForPort('linux-canary', decoy.id, 750)
    if (decoyReady.port || (decoyReady.listeningPorts?.length ?? 0) > 0) {
      throw new Error('ProcessManager borrowed a reachable host decoy port without procfs ownership')
    }

    for (const [port, marker] of [[highPort, 'guardian-high'], [lowPort, 'guardian-low']]) {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) })
      const body = await response.json()
      if (!response.ok || body?.status !== 'ok' || body?.boundary !== 'bubblewrap' || body?.marker !== marker) {
        throw new Error(`Host Preview reached the wrong managed Bubblewrap Website for ${marker}`)
      }
    }
    const serverLatencyMs = roundedMs(performance.now() - serverStarted)

    Object.assign(report, {
      outcome: 'passed',
      passed: true,
      foreground: {
        latencyMs: foregroundLatencyMs,
        workspaceWritePersisted: true,
        hostHomeReadDenied: true,
        hostRootWriteDenied: true,
        privateNetworkNamespace: true,
        stdoutBytes: Buffer.byteLength(foreground.stdout || ''),
        stderrBytes: Buffer.byteLength(foreground.stderr || ''),
      },
      managedWebsite: {
        latencyMs: serverLatencyMs,
        hostPreviewReachable: true,
        fileIsolation: serverInvocation.sandbox.fileIsolation,
        networkIsolation: serverInvocation.sandbox.managedServerNetworkIsolation,
        egressClaim: 'shared-network; outbound denial is intentionally not claimed',
        procfsOwnershipVerified: true,
        perGuardianPortIsolation: true,
        hostDecoyRejected: true,
        verifiedPorts: { high: highReady.port, low: lowReady.port },
        startupOutputBytes: Buffer.byteLength(`${highReady.combinedOutput || ''}${lowReady.combinedOutput || ''}`),
      },
    })
  }
} catch (error) {
  report = {
    ...(report || {
      schemaVersion: 'anera-production-linux-bubblewrap-canary/1.0',
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

async function availablePorts(count) {
  const servers = Array.from({ length: count }, () => createServer())
  try {
    await Promise.all(servers.map((server) => new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', resolveListen)
    })))
    return servers.map((server) => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Could not allocate a managed Website canary port')
      return address.port
    })
  } finally {
    await Promise.all(servers.map((server) => server.listening
      ? new Promise((resolveClose) => server.close(resolveClose))
      : Promise.resolve()))
  }
}

function roundedMs(value) {
  return Math.round(value * 1000) / 1000
}
