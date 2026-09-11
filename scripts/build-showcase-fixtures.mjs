import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { readHydratedSessionEventLog } from '../src/server/session-store.js'

const projectRoot = resolve(import.meta.dirname, '..')
const runtimeRoot = join(projectRoot, '.anera', 'sessions')
const outputJson = join(projectRoot, 'src', 'client', 'showcase-data.json')
const catalogJson = join(projectRoot, 'src', 'client', 'showcase-catalog.json')
const publicRoot = join(projectRoot, 'public', 'showcase', 'artifacts')
const hiddenRuntimeDirectories = new Set(['.home', '.tmp'])
const localUsername = basename(homedir())
const localUsernamePattern = localUsername
  ? new RegExp(`\\b${localUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
  : undefined

const demos = [
  {
    id: 'ses_864449e90bb3452ba8d6',
    title: '从参考图重建响应式仪表盘',
    eyebrow: '视觉理解 · 网页生成 · 浏览器验证',
    note: '读取 1200×800 参考图，生成可编辑 HTML，并在桌面与移动视口完成验证。',
  },
  {
    id: 'ses_9bcc8f1e91e541b281f6',
    title: '构建并验证交互网页',
    eyebrow: '文件写入 · Website · 浏览器自动化',
    note: '创建计数器页面，发布预览，点击两次并保存 375×700 验证截图。',
  },
  {
    id: 'ses_3e712ab85ff7480fa15c',
    title: '多源研究 HTTP 103 Early Hints',
    eyebrow: 'Web Search · Fetch · 引用综合',
    note: '只使用 RFC 8297 与 MDN 两个权威来源，形成逐条可追溯结论。',
  },
  {
    id: 'ses_2ac2d3948d9e4a98b7d1',
    title: '900 行长文档读取与独立校验',
    eyebrow: '附件解析 · 上下文压缩 · Bash 复核',
    note: '跨长上下文提取首尾哨兵、分类计数，并用独立命令重新验证产物。',
  },
]

function staticAssetPath(sessionId, path) {
  return `/showcase/artifacts/${sessionId}/${path.split('/').map(encodeURIComponent).join('/')}`
}

function scrubString(value) {
  let next = value
    .replace(/\/Users\/[^/\s"'\\]+\/Projects\/Anera/g, '/workspace/anera')
    .replace(/\/Users\/[^/\s"'\\]+/g, '/workspace/local-user')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://preview.local')

  if (localUsernamePattern) next = next.replace(localUsernamePattern, 'local-user')

  next = next
    .replace(/\/workspace\/(ses_[a-z0-9]{20})\/preview\/([^\s"'\\)]+)/g, (_, sessionId, path) => staticAssetPath(sessionId, decodeURIComponent(path)))
    .replace(/\/workspace\/(ses_[a-z0-9]{20})\/file\?path=([^&\s"'\\)]+)/g, (_, sessionId, path) => staticAssetPath(sessionId, decodeURIComponent(path)))
    .replace(/\/api\/sessions\/(ses_[a-z0-9]{20})\/download\?path=([^&\s"'\\)]+)/g, (_, sessionId, path) => staticAssetPath(sessionId, decodeURIComponent(path)))

  next = next
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)([^\s,;'"\\]+)/g, '$1[REDACTED]')

  return next
}

function scrub(value) {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return value.map(scrub)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrub(child)]))
}

function coalesceStreamingEvents(events) {
  const output = []
  for (const event of events) {
    const prior = output.at(-1)
    const mergeable = prior
      && event.type === 'assistant.final.delta'
      && prior.type === event.type
      && prior.stepId === event.stepId
      && typeof prior.data?.delta === 'string'
      && typeof event.data?.delta === 'string'
    if (!mergeable) {
      output.push(event)
      continue
    }
    prior.data.delta += event.data.delta
    prior.at = event.at
  }
  return output
}

async function workspaceFiles(root) {
  const files = []
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory() && hiddenRuntimeDirectories.has(entry.name)) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  await walk(root)
  return files
}

async function workspaceTree(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
  const children = []
  for (const entry of entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
    return left.name.localeCompare(right.name)
  })) {
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory() && hiddenRuntimeDirectories.has(entry.name)) continue
    const absolute = join(current, entry.name)
    const path = relative(root, absolute).split(sep).join('/')
    if (entry.isDirectory()) {
      children.push({ name: entry.name, path, type: 'directory', children: await workspaceTree(root, absolute) })
    } else if (entry.isFile()) {
      children.push({ name: entry.name, path, type: 'file', size: (await stat(absolute)).size })
    }
  }
  return children
}

async function buildDemo(definition) {
  const sessionRoot = join(runtimeRoot, definition.id)
  const state = JSON.parse(await readFile(join(sessionRoot, 'state.json'), 'utf8'))
  const events = await readHydratedSessionEventLog(join(sessionRoot, 'events.jsonl'))
  const workspaceRoot = join(sessionRoot, 'workspace')
  const files = await workspaceFiles(workspaceRoot)
  const tree = await workspaceTree(workspaceRoot)

  for (const source of files) {
    const path = relative(workspaceRoot, source)
    const destination = join(publicRoot, definition.id, path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  const totalBytes = files.length === 0
    ? 0
    : (await Promise.all(files.map((file) => stat(file)))).reduce((total, file) => total + file.size, 0)
  const summary = {
    ...state.summary,
    title: definition.title,
    workspaceBytes: totalBytes,
  }
  const snapshot = {
    session: summary,
    events: coalesceStreamingEvents(events),
    plan: state.plan ?? null,
    workspace: tree,
    workspaceInventory: {
      hasMore: false,
      truncated: false,
      totalFiles: files.length,
      loadedEntries: files.length,
    },
    artifacts: state.artifacts ?? [],
    processes: state.processes ?? [],
    website: state.website ?? { status: 'stopped', updatedAt: summary.updatedAt, restartCount: 0 },
    deployment: state.deployment ?? { status: 'not_deployed', revision: 0, updatedAt: summary.updatedAt },
    repository: state.repository ?? null,
  }

  return { definition, summary: scrub(summary), snapshot: scrub(snapshot) }
}

await mkdir(dirname(outputJson), { recursive: true })
await mkdir(publicRoot, { recursive: true })
const built = []
for (const demo of demos) built.push(await buildDemo(demo))

const data = {
  schemaVersion: 'anera-static-showcase/1.0',
  generatedAt: '2026-08-31T00:00:00.000Z',
  disclosure: 'Read-only, redacted projections of real Anera runs. Streaming deltas are coalesced without changing visible text; local paths and serving URLs are rewritten for static hosting.',
  defaultSessionId: demos[0].id,
  demos: built.map(({ definition, summary }) => ({ ...definition, metrics: summary.usage })),
  sessions: built.map(({ summary }) => summary),
  snapshots: Object.fromEntries(built.map(({ definition, snapshot }) => [definition.id, snapshot])),
}
const catalog = {
  schemaVersion: data.schemaVersion,
  generatedAt: data.generatedAt,
  disclosure: data.disclosure,
  defaultSessionId: data.defaultSessionId,
  demos: data.demos,
}
await writeFile(outputJson, `${JSON.stringify(data, null, 2)}\n`)
await writeFile(catalogJson, `${JSON.stringify(catalog, null, 2)}\n`)

const size = (await stat(outputJson)).size
process.stdout.write(`Built ${built.length} showcase sessions (${size} bytes) at ${relative(projectRoot, outputJson)} with ${relative(projectRoot, catalogJson)}\n`)
