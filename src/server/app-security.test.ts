import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createApp, WORKSPACE_CONTENT_SECURITY_POLICY } from './app.js'
import type { ReferenceFontManifest } from './reference-fonts.js'
import type { ReferenceFontEvidenceManifest } from './session-store.js'
import { workspaceFileSnapshot } from './workspace.js'

const execFileAsync = promisify(execFile)

function testSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function previewReferenceFontFixture(): {
  fontCss: string
  familyNames: string[]
  materializationManifest: ReferenceFontManifest
} {
  const font = Buffer.from('wOF2anera-preview-font')
  const fontSha256 = testSha256(font)
  const familyNames = ['Preview Reference Sans']
  const fontCss = `@font-face { font-family: '${familyNames[0]}'; src: url("data:font/woff2;base64,${font.toString('base64')}") format("woff2"); }`
  const source = Buffer.from('preview reference font source', 'utf8')
  const core = {
    version: 1 as const,
    stylesheets: [{
      sha256: testSha256(source),
      bytes: source.length,
      materializedSha256: testSha256(fontCss),
      materializedBytes: Buffer.byteLength(fontCss),
      fontSha256: [fontSha256],
    }],
    fonts: [{ sha256: fontSha256, bytes: font.length }],
    familyNames,
    cssBytes: source.length,
    fontBytes: font.length,
  }
  return {
    fontCss,
    familyNames,
    materializationManifest: { ...core, manifestSha256: testSha256(JSON.stringify(core)) },
  }
}

function durableReferenceStyle(
  sourceEvidenceSha256: string,
  fontEvidence: ReferenceFontEvidenceManifest | undefined,
  strictness: 'exact' | 'inspired' = 'exact',
) {
  return {
    contract: {
      sourceUrl: 'https://example.test/reference',
      strictness,
      colors: ['#123456', '#abcdef'],
      fonts: ['Preview Reference Sans'],
      layout: ['fixed slide canvas', 'two-column content'],
      components: ['title', 'content card'],
      requiredMarkers: ['.slide', '--accent-color'],
      signature: 'Reference fixture',
      avoid: ['generic fallback typography'],
      viewport: { width: 1_440, height: 900 },
    },
    provenance: {
      resolvedUrl: 'https://example.test/reference',
      evidenceSha256: sourceEvidenceSha256,
      evidenceBytes: 123,
    },
    ...(fontEvidence ? { fontEvidence } : {}),
  }
}

describe('workspace active-content policy', () => {
  it('allows local artifacts while blocking API/network and navigation exfiltration channels', () => {
    expect(WORKSPACE_CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-inline' blob:")
    expect(WORKSPACE_CONTENT_SECURITY_POLICY).toContain("style-src 'self' 'unsafe-inline'")
    expect(WORKSPACE_CONTENT_SECURITY_POLICY).toContain("font-src 'self' data:")
    expect(WORKSPACE_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'")
    expect(WORKSPACE_CONTENT_SECURITY_POLICY).toContain("frame-src 'none'")
    expect(WORKSPACE_CONTENT_SECURITY_POLICY).toContain("object-src 'none'")
    expect(WORKSPACE_CONTENT_SECURITY_POLICY).toContain("base-uri 'none'")
    expect(WORKSPACE_CONTENT_SECURITY_POLICY).toContain("form-action 'none'")
  })

  it('injects integrity-checked private fonts only into exact HTML previews and fails closed', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-app-reference-font-preview-'))
    const created = await createApp({ dataRoot: resolve(root, 'data'), model: 'test-model' })
    const sourceEvidenceSha256 = 'a'.repeat(64)
    const fixture = previewReferenceFontFixture()
    const createPreview = async (
      strictness: 'exact' | 'inspired',
      html: string,
      includeEvidence = true,
    ) => {
      const session = await created.store.create()
      const workspace = created.store.workspaceDir(session.summary.id)
      await writeFile(resolve(workspace, 'index.html'), html)
      await writeFile(resolve(workspace, 'styles.css'), 'body { color: navy; }\n')
      const fontEvidence = includeEvidence
        ? await created.store.commitReferenceFontEvidence(session.summary.id, {
            sourceEvidenceSha256,
            ...fixture,
          })
        : undefined
      await created.store.update(session.summary.id, (state) => {
        state.activeReferenceStyleContract = durableReferenceStyle(
          sourceEvidenceSha256,
          fontEvidence,
          strictness,
        )
      })
      return { session, fontEvidence }
    }

    const exactSource = '<!doctype html><html><head><title>Exact</title><link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head><body><main>EXACT_PREVIEW</main></body></html>'
    const exact = await createPreview('exact', exactSource)
    const inspired = await createPreview(
      'inspired',
      '<!doctype html><html><body><main>INSPIRED_PREVIEW</main></body></html>',
    )
    const missing = await createPreview(
      'exact',
      '<!doctype html><html><body><main>MISSING_EVIDENCE_MUST_NOT_RENDER</main></body></html>',
      false,
    )
    const reserved = await createPreview(
      'exact',
      '<!doctype html><html><body data-anera-reference-fonts><main>RESERVED_MARKER_MUST_NOT_RENDER</main></body></html>',
    )

    const server = createServer(created.app)
    try {
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not bind')
      const base = `http://127.0.0.1:${address.port}`

      const exactResponse = await fetch(`${base}/workspace/${exact.session.summary.id}/preview/index.html?aneraElementPicker=1`)
      expect(exactResponse.status).toBe(200)
      expect(exactResponse.headers.get('content-security-policy')).toBe(WORKSPACE_CONTENT_SECURITY_POLICY)
      expect(exactResponse.headers.get('cache-control')).toBe('private, no-store')
      const exactHtml = await exactResponse.text()
      expect(exactHtml).toMatch(/^<!doctype html><style data-anera-reference-fonts data-manifest-sha256="[0-9a-f]{64}">/u)
      expect(exactHtml).toContain(fixture.fontCss)
      expect(exactHtml).toContain('data:font/woff2;base64,')
      expect(exactHtml).toContain('data-anera-element-picker-bootstrap')
      expect(exactHtml).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/u)
      expect(exactHtml.match(/<style data-anera-reference-fonts\b/gu)).toHaveLength(1)

      const exactAsset = await fetch(`${base}/workspace/${exact.session.summary.id}/preview/styles.css`)
      expect(exactAsset.status).toBe(200)
      expect(await exactAsset.text()).toBe('body { color: navy; }\n')
      expect(exactAsset.headers.get('cache-control')).toBe('no-cache')

      await created.store.update(exact.session.summary.id, (state) => {
        state.website = {
          status: 'asleep',
          entryPath: 'index.html',
          previewUrl: 'http://127.0.0.1:65535/unmaterialized-preview',
          updatedAt: new Date().toISOString(),
          restartCount: 1,
        }
      })
      const restarted = await fetch(
        `${base}/api/sessions/${exact.session.summary.id}/website/restart`,
        { method: 'POST' },
      )
      expect(restarted.status).toBe(200)
      await expect(restarted.json()).resolves.toMatchObject({
        website: {
          status: 'running',
          entryPath: 'index.html',
          previewUrl: `/workspace/${exact.session.summary.id}/preview/index.html`,
          restartCount: 2,
        },
      })
      const exactDownload = await fetch(
        `${base}/api/sessions/${exact.session.summary.id}/download?path=index.html`,
      )
      expect(exactDownload.status).toBe(200)
      expect(exactDownload.headers.get('content-disposition')).toContain('attachment;')
      expect(exactDownload.headers.get('cache-control')).toBe('private, no-store')
      expect(exactDownload.headers.get('x-anera-reference-font-manifest-sha256'))
        .toBe(exact.fontEvidence?.manifestSha256)
      const downloadedHtml = await exactDownload.text()
      expect(downloadedHtml).toContain(fixture.fontCss)
      expect(downloadedHtml).toContain('data-anera-reference-fonts')
      expect(downloadedHtml).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/u)
      await expect(readFile(resolve(
        created.store.workspaceDir(exact.session.summary.id),
        'index.html',
      ), 'utf8')).resolves.toBe(exactSource)

      const inspiredResponse = await fetch(`${base}/workspace/${inspired.session.summary.id}/preview/index.html`)
      expect(inspiredResponse.status).toBe(200)
      expect(inspiredResponse.headers.get('cache-control')).toBe('no-cache')
      expect(await inspiredResponse.text()).not.toContain('data-anera-reference-fonts')

      const missingResponse = await fetch(`${base}/workspace/${missing.session.summary.id}/preview/index.html`)
      expect(missingResponse.status).toBe(409)
      const missingText = await missingResponse.text()
      expect(missingText).toContain('private font evidence is missing')
      expect(missingText).not.toContain('MISSING_EVIDENCE_MUST_NOT_RENDER')

      const reservedResponse = await fetch(`${base}/workspace/${reserved.session.summary.id}/preview/index.html`)
      expect(reservedResponse.status).toBe(400)
      const reservedText = await reservedResponse.text()
      expect(reservedText).toContain('invalid reserved reference font evidence marker')
      expect(reservedText).not.toContain('RESERVED_MARKER_MUST_NOT_RENDER')

      if (!exact.fontEvidence) throw new Error('Exact fixture font evidence was not committed')
      const fontPath = resolve(
        created.store.sessionDir(exact.session.summary.id),
        'reference-style',
        'fonts',
        'v1',
        exact.fontEvidence.manifestSha256,
        `${exact.fontEvidence.fontCssSha256}.css`,
      )
      await writeFile(fontPath, Buffer.alloc(exact.fontEvidence.fontCssBytes, 0x78))
      const tamperedResponse = await fetch(`${base}/workspace/${exact.session.summary.id}/preview/index.html`)
      expect(tamperedResponse.status).toBe(500)
      const tamperedText = await tamperedResponse.text()
      expect(tamperedText).toContain('bytes do not match')
      expect(tamperedText).not.toContain('EXACT_PREVIEW')
    } finally {
      await created.agent.shutdown()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('projects an Arena U02-style build to source files across reconciliation, terminal metrics, tree, and ZIP', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-app-u02-projection-'))
    const stream = async (options: { onContent: (delta: string) => void }) => {
      options.onContent('Build verified.')
      return {
        content: 'Build verified.',
        reasoningContent: '',
        toolCalls: [],
        finishReason: 'stop' as const,
        usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11, cachedPromptTokens: 0 },
        modelCallCount: 1,
      }
    }
    const created = await createApp({
      dataRoot: resolve(root, 'data'),
      model: 'test-model',
      agent: { client: { stream } as never, runTimeoutMs: 2_000 },
    })
    const session = await created.store.create()
    const workspace = created.store.workspaceDir(session.summary.id)
    const sourceFiles = new Map<string, string>([
      ['index.html', '<main id="app"></main>\n'],
      ['package-lock.json', '{"lockfileVersion":3}\n'],
      ['package.json', '{"scripts":{"build":"vite build"}}\n'],
      ['src/main.js', 'document.querySelector("#app").textContent = "ready"\n'],
      ['verify-interaction.mjs', 'if (!process.env.CI) console.log("verified")\n'],
      ['vite.config.js', 'export default {}\n'],
    ])
    await mkdir(resolve(workspace, 'src'), { recursive: true })
    for (const [path, content] of sourceFiles) await writeFile(resolve(workspace, path), content)

    const checkpointId = await created.store.stageShellReconciliation(
      session.summary.id,
      'cmd_0123456789abcdef0123',
      await workspaceFileSnapshot(workspace),
      { turnId: 'turn_u02', stepId: 'step_u02', callId: 'call_u02' },
    )
    await mkdir(resolve(workspace, 'dist/assets'), { recursive: true })
    await mkdir(resolve(workspace, 'node_modules/vite'), { recursive: true })
    await mkdir(resolve(workspace, '.next/cache'), { recursive: true })
    await mkdir(resolve(workspace, 'build'), { recursive: true })
    const generatedFiles = new Map<string, string>([
      ['dist/index.html', '<main id="app">built</main>\n'],
      ['dist/assets/app.js', 'console.log("bundle")\n'],
      ['node_modules/vite/package.json', '{"name":"vite"}\n'],
      ['.next/cache/data.bin', 'cache bytes'],
      ['build/index.html', '<main>second build</main>\n'],
      ['.netrc', 'machine example.test password secret\n'],
      ['.git-credentials', 'https://secret@example.test\n'],
    ])
    for (const [path, content] of generatedFiles) await writeFile(resolve(workspace, path), content)
    await expect(created.store.settleShellReconciliation(session.summary.id, checkpointId))
      .resolves.toEqual({ changeCount: 0 })

    const server = createServer(created.app)
    try {
      await created.agent.submit(session.summary.id, { content: 'Confirm the completed build.' })
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await created.store.get(session.summary.id)).summary.status === 'completed') break
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect((await created.store.get(session.summary.id)).summary.status).toBe('completed')

      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not bind')
      const base = `http://127.0.0.1:${address.port}`
      const snapshotResponse = await fetch(`${base}/api/sessions/${session.summary.id}`)
      expect(snapshotResponse.status).toBe(200)
      const snapshot = await snapshotResponse.json() as {
        session: { workspaceBytes: number }
        workspace: Array<{ path: string; type: 'file' | 'directory'; children?: Array<unknown> }>
        artifacts: Array<{ path: string }>
        events: Array<{ type: string; callId?: string; data: Record<string, unknown> }>
      }
      const flattenFiles = (entries: Array<{ path: string; type: 'file' | 'directory'; children?: Array<unknown> }>): string[] => (
        entries.flatMap((entry) => entry.type === 'file'
          ? [entry.path]
          : flattenFiles((entry.children ?? []) as Array<{ path: string; type: 'file' | 'directory'; children?: Array<unknown> }>))
      )
      const expectedPaths = [...sourceFiles.keys()].sort()
      const sourceBytes = [...sourceFiles.values()].reduce((total, content) => total + Buffer.byteLength(content), 0)
      expect(flattenFiles(snapshot.workspace).sort()).toEqual(expectedPaths)
      expect(snapshot.session.workspaceBytes).toBe(sourceBytes)
      expect(snapshot.artifacts.some((artifact) => generatedFiles.has(artifact.path))).toBe(false)
      expect(snapshot.events.filter((event) => (
        event.type === 'file.changed'
        && event.callId === 'call_u02'
      ))).toHaveLength(0)
      expect(snapshot.events.findLast((event) => event.type === 'workspace.persistence.completed')?.data)
        .toMatchObject({ phase: 'saved', bytes: sourceBytes, fileCount: sourceFiles.size, blobCount: 0 })

      const zipResponse = await fetch(`${base}/api/sessions/${session.summary.id}/workspace.zip`)
      expect(zipResponse.status).toBe(200)
      const zipPath = resolve(root, 'u02-workspace.zip')
      await writeFile(zipPath, Buffer.from(await zipResponse.arrayBuffer()))
      const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
      const zipFiles = stdout.split('\n').filter((path) => path && !path.endsWith('/')).sort()
      expect(zipFiles).toEqual(expectedPaths)

      for (const [path, content] of generatedFiles) {
        await expect(readFile(resolve(workspace, path), 'utf8')).resolves.toBe(content)
      }
    } finally {
      await created.agent.shutdown()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('rejects workspace symlinks from every HTTP file outlet and omits them from ZIP export', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-app-security-'))
    const outside = resolve(root, 'outside-secret.txt')
    await writeFile(outside, 'HOST_SECRET_MUST_NOT_LEAK\n')
    const created = await createApp({ dataRoot: resolve(root, 'data'), model: 'test-model' })
    const session = await created.store.create()
    await writeFile(resolve(created.store.workspaceDir(session.summary.id), 'safe.txt'), 'safe\n')
    await writeFile(resolve(created.store.workspaceDir(session.summary.id), 'index.html'), '<!doctype html><script>document.body.textContent="safe"</script>\n')
    await writeFile(resolve(created.store.workspaceDir(session.summary.id), '.tmp'), 'internal temp marker\n')
    await writeFile(resolve(created.store.workspaceDir(session.summary.id), '.home'), 'internal home marker\n')
    await mkdir(resolve(created.store.workspaceDir(session.summary.id), '资料 2026'))
    await writeFile(resolve(created.store.workspaceDir(session.summary.id), '资料 2026/index.html'), '<link rel="stylesheet" href="styles.css"><h1>nested preview</h1>\n')
    await writeFile(resolve(created.store.workspaceDir(session.summary.id), '资料 2026/styles.css'), 'h1 { color: green; }\n')
    await symlink(outside, resolve(created.store.workspaceDir(session.summary.id), 'linked.txt'))
    const deploymentRoot = created.store.deploymentRevisionDir(session.summary.id, 1)
    await mkdir(resolve(deploymentRoot, 'assets'), { recursive: true })
    await writeFile(resolve(deploymentRoot, 'index.html'), '<!doctype html><link rel="stylesheet" href="assets/site.css"><h1>LAST GOOD DEPLOYMENT</h1>\n')
    await writeFile(resolve(deploymentRoot, 'assets', 'site.css'), 'h1 { color: navy; }\n')
    await writeFile(`${deploymentRoot}.manifest.json`, '{"private":"DEPLOYMENT_MANIFEST_MUST_NOT_BE_SERVED"}\n')
    await symlink(outside, resolve(deploymentRoot, 'linked.txt'))
    await created.store.update(session.summary.id, (state) => {
      state.deployment = {
        id: 'dep_1234567890abcdefghij',
        status: 'failed',
        revision: 1,
        entryPath: 'index.html',
        url: `http://127.0.0.1/deployments/${session.summary.id}/`,
        visibility: 'local',
        error: 'Latest redeploy failed; serving revision 1.',
        updatedAt: new Date().toISOString(),
      }
    })
    const server = createServer(created.app)
    try {
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not bind')
      const base = `http://127.0.0.1:${address.port}`
      const crossOrigin = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { origin: 'https://malicious.example', 'sec-fetch-site': 'cross-site' },
      })
      expect(crossOrigin.status).toBe(403)
      const localAutomation = await fetch(`${base}/api/sessions`, { method: 'POST' })
      expect(localAutomation.status).toBe(201)
      const duplicateUploads = await Promise.all(['first', 'second'].map((content) => fetch(`${base}/api/sessions/${session.summary.id}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'same-name.txt', contentBase64: Buffer.from(content).toString('base64'), mime: 'text/plain' }),
      })))
      expect(duplicateUploads.map((response) => response.status)).toEqual([201, 201])
      const duplicatePaths = await Promise.all(duplicateUploads.map(async (response) => (await response.json() as { path: string }).path))
      expect(duplicatePaths.sort()).toEqual(['uploads/same-name (2).txt', 'uploads/same-name.txt'])
      const encoded = encodeURIComponent('linked.txt')
      for (const path of [
        `/workspace/${session.summary.id}/file?path=${encoded}`,
        `/workspace/${session.summary.id}/preview/linked.txt`,
        `/api/sessions/${session.summary.id}/download?path=${encoded}`,
      ]) {
        const response = await fetch(`${base}${path}`)
        expect(response.status).toBe(400)
        expect(await response.text()).not.toContain('HOST_SECRET_MUST_NOT_LEAK')
      }
      const download = await fetch(`${base}/api/sessions/${session.summary.id}/download?path=safe.txt`)
      expect(download.status).toBe(200)
      expect(download.headers.get('content-disposition')).toContain('attachment; filename="safe.txt"')
      expect(await download.text()).toBe('safe\n')

      const preview = await fetch(`${base}/workspace/${session.summary.id}/preview/index.html`)
      expect(preview.status).toBe(200)
      expect(preview.headers.get('content-security-policy')).toBe(WORKSPACE_CONTENT_SECURITY_POLICY)
      expect(preview.headers.get('x-content-type-options')).toBe('nosniff')
      expect(preview.headers.get('referrer-policy')).toBe('no-referrer')
      const previewText = await preview.text()
      expect(previewText).toContain('document.body.textContent="safe"')
      expect(previewText).not.toContain('data-anera-element-picker-bootstrap')
      const pickerPreview = await fetch(`${base}/workspace/${session.summary.id}/preview/index.html?aneraElementPicker=1`)
      expect(pickerPreview.status).toBe(200)
      expect(pickerPreview.headers.get('content-security-policy')).toBe(WORKSPACE_CONTENT_SECURITY_POLICY)
      const pickerPreviewText = await pickerPreview.text()
      expect(pickerPreviewText).toContain('document.body.textContent="safe"')
      expect(pickerPreviewText).toContain('data-anera-element-picker-bootstrap')
      expect(pickerPreviewText).toContain('Click an element in the preview. Press Esc to cancel.')
      const nestedPreview = await fetch(`${base}/workspace/${session.summary.id}/preview/%E8%B5%84%E6%96%99%202026/index.html`)
      expect(nestedPreview.status).toBe(200)
      expect(await nestedPreview.text()).toContain('nested preview')
      const nestedStyle = await fetch(`${base}/workspace/${session.summary.id}/preview/%E8%B5%84%E6%96%99%202026/styles.css`)
      expect(nestedStyle.status).toBe(200)
      expect(await nestedStyle.text()).toContain('color: green')

      const snapshotResponse = await fetch(`${base}/api/sessions/${session.summary.id}`)
      expect(snapshotResponse.status).toBe(200)
      expect(await snapshotResponse.json()).toMatchObject({
        deployment: { status: 'failed', revision: 1, entryPath: 'index.html', error: expect.stringContaining('serving revision 1') },
      })
      const deployment = await fetch(`${base}/deployments/${session.summary.id}/`)
      expect(deployment.status).toBe(200)
      expect(deployment.headers.get('content-security-policy')).toBe(WORKSPACE_CONTENT_SECURITY_POLICY)
      expect(deployment.headers.get('cache-control')).toBe('no-cache')
      expect(await deployment.text()).toContain('LAST GOOD DEPLOYMENT')
      const deploymentAsset = await fetch(`${base}/deployments/${session.summary.id}/assets/site.css`)
      expect(deploymentAsset.status).toBe(200)
      expect(await deploymentAsset.text()).toContain('color: navy')
      for (const deploymentPath of [
        `/deployments/${session.summary.id}/linked.txt`,
        `/deployments/${session.summary.id}/%252e%252e%252foutside-secret.txt`,
      ]) {
        const blocked = await fetch(`${base}${deploymentPath}`)
        const blockedText = await blocked.text()
        expect(blocked.status).toBe(400)
        expect(blockedText).not.toContain('HOST_SECRET_MUST_NOT_LEAK')
        expect(blockedText).not.toContain('DEPLOYMENT_MANIFEST_MUST_NOT_BE_SERVED')
      }
      const hiddenManifest = await fetch(`${base}/deployments/${session.summary.id}/revision-1.manifest.json`)
      expect(hiddenManifest.status).not.toBe(200)
      expect(await hiddenManifest.text()).not.toContain('DEPLOYMENT_MANIFEST_MUST_NOT_BE_SERVED')
      const undeployed = await created.store.create()
      const missingDeployment = await fetch(`${base}/deployments/${undeployed.summary.id}/`)
      expect(missingDeployment.status).toBe(404)

      const zipResponse = await fetch(`${base}/api/sessions/${session.summary.id}/workspace.zip`)
      expect(zipResponse.status).toBe(200)
      const zipPath = resolve(root, 'workspace.zip')
      await writeFile(zipPath, Buffer.from(await zipResponse.arrayBuffer()))
      const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
      expect(stdout).toContain('safe.txt')
      expect(stdout).not.toContain('linked.txt')
      expect(stdout).not.toContain('.tmp')
      expect(stdout).not.toContain('.home')
    } finally {
      await created.agent.shutdown()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('private harness state', () => {
  it('persists context pressure only in state.json and excludes it from Session and canonical APIs', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-private-context-pressure-'))
    const created = await createApp({ dataRoot: resolve(root, 'data'), model: 'test-model' })
    const session = await created.store.create()
    await created.store.update(session.summary.id, (state) => {
      state.contextPressure = {
        model: 'test-model',
        promptTokens: 12_345,
        sampledSurfaceTokens: 6_789,
      }
    })
    const server = createServer(created.app)
    try {
      const durableState = JSON.parse(await readFile(
        resolve(created.store.sessionDir(session.summary.id), 'state.json'),
        'utf8',
      )) as Record<string, unknown>
      expect(durableState.contextPressure).toEqual({
        model: 'test-model',
        promptTokens: 12_345,
        sampledSurfaceTokens: 6_789,
      })

      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not bind')
      const base = `http://127.0.0.1:${address.port}`
      const snapshot = await fetch(`${base}/api/sessions/${session.summary.id}`)
      expect(snapshot.status).toBe(200)
      const snapshotText = await snapshot.text()
      expect(snapshotText).not.toContain('contextPressure')
      expect(snapshotText).not.toContain('sampledSurfaceTokens')

      const canonical = await fetch(`${base}/api/sessions/${session.summary.id}/canonical.jsonl`)
      expect(canonical.status).toBe(200)
      const canonicalText = await canonical.text()
      expect(canonicalText).not.toContain('contextPressure')
      expect(canonicalText).not.toContain('sampledSurfaceTokens')
    } finally {
      await created.agent.shutdown()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('cumulative Session usage API contract', () => {
  it('admits a new turn after high historical token usage while preserving model validation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'anera-app-unlimited-session-usage-'))
    const stream = async (options: { onContent: (delta: string) => void }) => {
      options.onContent('Continued after high cumulative usage.')
      return {
        content: 'Continued after high cumulative usage.',
        reasoningContent: '',
        toolCalls: [],
        finishReason: 'stop' as const,
        usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16, cachedPromptTokens: 10 },
      }
    }
    const created = await createApp({
      dataRoot: resolve(root, 'data'),
      model: 'test-model',
      agent: { client: { stream } as never, runTimeoutMs: 1_000 },
    })
    const session = await created.store.create()
    await created.store.update(session.summary.id, (state) => {
      state.summary.usage.totalTokens = 1_002_796
      state.summary.usage.promptTokens = 986_843
      state.summary.usage.completionTokens = 15_953
      state.summary.usage.cachedPromptTokens = 925_952
    })
    const server = createServer(created.app)
    try {
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not bind')
      const base = `http://127.0.0.1:${address.port}`
      const modelsResponse = await fetch(`${base}/api/agent-models`)
      expect(modelsResponse.status).toBe(200)
      expect(await modelsResponse.json()).toEqual({
        models: [{ id: 'test-model', publicName: 'test-model', displayName: 'Test Model' }],
      })
      const fresh = await created.store.create()
      const unavailable = await fetch(`${base}/api/sessions/${fresh.summary.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Do not run.', attachments: [], model: 'missing-model' }),
      })
      expect(unavailable.status).toBe(400)
      expect(await unavailable.json()).toMatchObject({ error: 'Selected agent model is unavailable' })

      const response = await fetch(`${base}/api/sessions/${session.summary.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Continue in this high-usage session.', attachments: [] }),
      })
      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({ turnId: expect.any(String) })
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await created.store.get(session.summary.id)).summary.status === 'completed') break
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      const resumed = await created.store.get(session.summary.id)
      expect(resumed.summary.status).toBe('completed')
      expect(resumed.summary.limits).toBeUndefined()
      expect(resumed.summary.usage).toMatchObject({ totalTokens: 1_002_812, cachedPromptTokens: 925_962 })
      expect((await created.store.events(session.summary.id)).filter((event) => event.type === 'turn.started')).toHaveLength(1)
      expect((await created.store.events(session.summary.id)).some((event) => event.type === 'session.limit.reached')).toBe(false)
    } finally {
      await created.agent.shutdown()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await rm(root, { recursive: true, force: true })
    }
  })
})
