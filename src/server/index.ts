import { createServer } from 'node:http'
import { createApp } from './app.js'
import { config } from './config.js'
import { osSandboxStatus } from './os-sandbox.js'

const sandbox = osSandboxStatus()
if (config.requireOsSandbox && !sandbox.available) {
  throw new Error(`ANERA_REQUIRE_OS_SANDBOX is enabled, but no supported OS sandbox is available: ${sandbox.detail}`)
}

const { app, agent } = await createApp()
const server = createServer(app)
const SHUTDOWN_DEADLINE_MS = 5_000
let shutdownWork: Promise<void> | undefined

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Anera server listening on http://127.0.0.1:${config.port}`)
  console.log(`Model: ${config.model} (${config.deepseekApiKey ? 'configured' : 'missing API key'})`)
  console.log(`OS sandbox: ${sandbox.kind} (${sandbox.detail})`)
})

function shutdown(): Promise<void> {
  if (shutdownWork) return shutdownWork
  shutdownWork = (async () => {
    // Stop admission before asking in-flight work to settle. The hard deadline
    // starts now, not after agent.shutdown(), so an abort-ignoring provider can
    // never keep the process alive indefinitely.
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeIdleConnections()
    const hardExit = setTimeout(() => {
      server.closeAllConnections()
      process.exit(1)
    }, SHUTDOWN_DEADLINE_MS)
    hardExit.unref()
    try {
      await agent.shutdown()
      // EventSource responses are active, not idle, and therefore keep
      // server.close() pending forever. Close the remaining transports only
      // after Agent runs/processes have published their durable terminals.
      server.closeAllConnections()
      await serverClosed
      clearTimeout(hardExit)
      process.exit(0)
    } catch (error) {
      clearTimeout(hardExit)
      server.closeAllConnections()
      console.error('Anera graceful shutdown failed:', error)
      process.exit(1)
    }
  })()
  return shutdownWork
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
