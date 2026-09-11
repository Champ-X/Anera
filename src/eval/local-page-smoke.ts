import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { findBrowserExecutable } from '../server/browser-executable.js'

/** Owned local page-load smoke only. Never a provider, user-browser session,
 * responsive-layout check, or production render/acceptance receipt. */
export async function smokeLocalPage(options: {
  url: string; outputRoot: string; cli?: string; browserExecutablePath?: string; expectedTitle?: string; readySelector?: string
}) {
  const url = new URL(options.url)
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password,
    'Page smoke requires an owned loopback HTTP URL.')
  const configPath = resolve(options.outputRoot, 'agent-browser.json')
  await writeFile(configPath, '{}\n')
  const namespace = `anera-smoke-${createHash('sha256').update(options.outputRoot).digest('hex').slice(0, 12)}`
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.AGENT_BROWSER_DEFAULT_TIMEOUT = '10000'
  const flags = ['--config', configPath, '--namespace', namespace, '--session', 'page-check',
    '--executable-path', findBrowserExecutable(options.browserExecutablePath), '--allowed-domains', '127.0.0.1',
    '--no-webmcp', '--idle-timeout', '2m', '--json']
  const commands: Record<string, unknown>[] = []
  const report: Record<string, unknown> = { scope: 'page-load-only; not workflow/render attestation',
    url: url.href, namespace, session: 'page-check', commands, passed: false }
  const command = async (...args: string[]) => {
    console.log(JSON.stringify({ diagnostic: 'page_smoke', command: args[0], outputRoot: options.outputRoot }))
    const record: Record<string, unknown> = { command: args }
    commands.push(record)
    try {
      const response = await promisify(execFile)(options.cli || 'agent-browser', [...flags, ...args], {
        cwd: options.outputRoot, env, timeout: 15_000, maxBuffer: 512 * 1024,
      })
      Object.assign(record, response)
      const result = JSON.parse(response.stdout) as { success?: boolean; data?: Record<string, unknown>; error?: unknown }
      assert.equal(result.success, true, JSON.stringify(result.error))
      assert(result.data && typeof result.data === 'object', 'Browser CLI response has no structured data.')
      return result.data
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      if (error && typeof error === 'object') {
        const child = error as { stdout?: unknown; stderr?: unknown; code?: unknown; signal?: unknown; killed?: unknown }
        Object.assign(record, { stdout: child.stdout, stderr: child.stderr, code: child.code, signal: child.signal, killed: child.killed })
      }
      throw error
    }
  }
  let failure: unknown
  try {
    const opened = await command('open', url.href)
    report.opened = opened
    if (options.expectedTitle) assert(String(opened.title).includes(options.expectedTitle), 'Unexpected application title.')
    if (options.readySelector) await command('wait', options.readySelector)
    report.snapshot = await command('snapshot', '-i')
    report.screenshot = resolve(options.outputRoot, 'page-smoke.png')
    await command('screenshot', String(report.screenshot))
    const page = await command('eval', `({url:location.href,body:document.body.innerText.trim().length,overlay:!!document.querySelector('vite-error-overlay,.vite-error-overlay,[data-nextjs-dialog],#webpack-dev-server-client-overlay')})`)
    report.page = page
    const state = page.result as { url?: string; body?: number; overlay?: boolean }
    assert(state && state.url === url.href && typeof state.body === 'number' && state.body > 0 && state.overlay === false,
      'Expected exact local page with readable content and no error overlay.')
    const errors = await command('errors')
    const logs = await command('console')
    Object.assign(report, { errors, console: logs })
    assert(Array.isArray(errors.errors) && errors.errors.length === 0, 'Page reported runtime errors.')
    assert(Array.isArray(logs.messages), 'Browser CLI console response has no messages.')
    assert(!logs.messages.some((entry: { type?: string; level?: string }) => entry.type === 'error' || entry.level === 'error'),
      'Page reported console errors; stop before further verification.')
  } catch (error) {
    failure = error
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    try { await command('close') }
    catch (error) {
      failure ??= error
      report.cleanupError = error instanceof Error ? error.message : String(error)
    }
    report.passed = failure === undefined
    await writeFile(resolve(options.outputRoot, 'page-smoke.json'), JSON.stringify(report, null, 2))
  }
  if (failure !== undefined) throw failure
  return report
}
