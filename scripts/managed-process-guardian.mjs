import { spawn } from 'node:child_process'

const managedIdArgument = process.argv.find((argument) => argument.startsWith('--managed-id='))
const managedId = managedIdArgument?.slice('--managed-id='.length)
const encodedInvocation = process.env.ANERA_MANAGED_INVOCATION

if (!managedId || !/^(?:proc|cmd)_[a-z0-9]{20}$/.test(managedId) || !encodedInvocation) {
  process.stderr.write('Invalid managed-process guardian invocation\n')
  process.exit(64)
}

let invocation
try {
  invocation = JSON.parse(Buffer.from(encodedInvocation, 'base64url').toString('utf8'))
} catch {
  process.stderr.write('Invalid managed-process guardian payload\n')
  process.exit(64)
}

if (
  typeof invocation?.executable !== 'string'
  || !Array.isArray(invocation.args)
  || invocation.args.some((argument) => typeof argument !== 'string')
  || typeof invocation.cwd !== 'string'
  || !invocation.env
  || typeof invocation.env !== 'object'
) {
  process.stderr.write('Incomplete managed-process guardian payload\n')
  process.exit(64)
}

delete process.env.ANERA_MANAGED_INVOCATION

if (process.argv.includes('--await-start')) {
  await new Promise((resolveStart) => {
    let input = ''
    const closeBeforeStart = () => process.exit(0)
    const onData = (chunk) => {
      input = `${input}${String(chunk)}`.slice(-64)
      if (!input.includes('START\n')) return
      process.stdin.off('data', onData)
      process.stdin.off('end', closeBeforeStart)
      process.stdin.off('close', closeBeforeStart)
      process.stdin.off('error', closeBeforeStart)
      resolveStart()
    }
    process.stdin.on('data', onData)
    process.stdin.once('end', closeBeforeStart)
    process.stdin.once('close', closeBeforeStart)
    process.stdin.once('error', closeBeforeStart)
    process.stdin.resume()
  })
}

const child = spawn(invocation.executable, invocation.args, {
  cwd: invocation.cwd,
  env: invocation.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
})

child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)

let shuttingDown = false
let childExited = false
let childExitCode = 0
let forceTimer

function signalChildTree(signal) {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  try {
    child.kill(signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function finish(code = childExitCode) {
  if (forceTimer) clearTimeout(forceTimer)
  process.exit(code)
}

function scheduleFinalSweep(delayMs) {
  if (forceTimer) clearTimeout(forceTimer)
  forceTimer = setTimeout(() => {
    try {
      signalChildTree('SIGKILL')
    } catch (error) {
      process.stderr.write(`Managed process force termination failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    setTimeout(() => finish(), 25).unref()
  }, delayMs)
}

function sweepAndFinish() {
  try {
    signalChildTree('SIGKILL')
  } catch (error) {
    process.stderr.write(`Managed process final sweep failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  finish()
}

function beginShutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try {
    signalChildTree('SIGTERM')
  } catch (error) {
    process.stderr.write(`Managed process termination failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  if (childExited) sweepAndFinish()
  else scheduleFinalSweep(800)
}

process.stdin.once('end', beginShutdown)
process.stdin.once('close', beginShutdown)
process.stdin.once('error', beginShutdown)
process.stdin.resume()
process.once('SIGTERM', beginShutdown)
process.once('SIGINT', beginShutdown)
process.once('SIGHUP', beginShutdown)

child.once('error', (error) => {
  process.stderr.write(`Managed process failed to spawn: ${error.message}\n`)
  childExitCode = 1
  childExited = true
  beginShutdown()
})

child.once('exit', (code, signal) => {
  childExitCode = code ?? (signal ? 1 : 0)
  childExited = true
  if (!shuttingDown) {
    // A shell or package-manager wrapper can exit while leaving descendants
    // behind. Close that process group before the guardian itself exits.
    beginShutdown()
  } else {
    // The direct child has completed its graceful exit. Immediately sweep a
    // daemonized descendant before preserving the child's real exit code.
    sweepAndFinish()
  }
})
