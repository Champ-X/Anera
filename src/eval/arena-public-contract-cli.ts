import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  compareArenaPublicContract,
  extractArenaPublicContract,
  extractArenaScriptAssetUrls,
  probeArenaPublicStrings,
  type ArenaPublicAsset,
  type ArenaPublicContractDiff,
  type ArenaPublicContractSnapshot,
} from './arena-public-contract.js'
import {
  ARENA_AGENT_UPLOAD_ALLOWED_MIME_TYPES,
  MAX_AGENT_PDF_UPLOAD_BYTES,
  MAX_AGENT_UPLOAD_BYTES,
  MAX_AGENT_UPLOAD_BYTES_PER_TURN,
} from '../shared/agent-upload-policy.js'
import { ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS, TOOL_DEFINITIONS } from '../server/tools.js'
import { buildArenaAgentSystemPrompt, buildArenaCodingSystemPrompt } from '../server/agent-service.js'

const execFileAsync = promisify(execFile)
const args = process.argv.slice(2)
const pageUrl = optionValue('--page') ?? 'https://arena.ai/agent'
const outputDirectory = resolve(optionValue('--output') ?? 'reports/arena-public-contract')
const noWrite = args.includes('--no-write')
const probeStrings = optionValues('--probe-string')
const probeContextCharacters = numericOption('--probe-context', 180)
const probeSnippetsPerAsset = numericOption('--probe-snippets', 2)
const supplementalPageUrls = optionValues('--supplemental-page')

const pageHtml = await curlText(pageUrl)
if (!pageHtml.includes('<html') || /Attention Required!|cf-error-details/i.test(pageHtml)) {
  throw new Error('Arena returned a challenge/error page instead of the public Agent HTML')
}
const assetUrls = extractArenaScriptAssetUrls(pageHtml, pageUrl)
if (assetUrls.length === 0) throw new Error('No JavaScript assets were discovered in the Arena Agent page')

const assets = await curlAssets(assetUrls)
const supplementalSources = await Promise.all(supplementalPageUrls.map(async (supplementalPageUrl) => {
  const supplementalPageHtml = await curlText(supplementalPageUrl)
  if (!supplementalPageHtml.includes('<html') || /Attention Required!|cf-error-details/i.test(supplementalPageHtml)) {
    throw new Error(`Arena returned a challenge/error page for supplemental evidence ${supplementalPageUrl}`)
  }
  const supplementalAssetUrls = extractArenaScriptAssetUrls(supplementalPageHtml, supplementalPageUrl)
  if (supplementalAssetUrls.length === 0) throw new Error(`No JavaScript assets were discovered in supplemental evidence ${supplementalPageUrl}`)
  return {
    pageUrl: supplementalPageUrl,
    pageHtml: supplementalPageHtml,
    assets: await curlAssets(supplementalAssetUrls),
  }
}))
const snapshot = extractArenaPublicContract(pageUrl, pageHtml, assets, { supplementalSources })
const clientSource = (await Promise.all([
  readFile(resolve('src/client/App.tsx'), 'utf8'),
  readFile(resolve('src/client/api.ts'), 'utf8'),
])).join('\n')
const agentSource = (await Promise.all([
  readFile(resolve('src/server/agent-service.ts'), 'utf8'),
  readFile(resolve('src/server/tools.ts'), 'utf8'),
  readFile(resolve('src/server/app.ts'), 'utf8'),
])).join('\n')
const diff = compareArenaPublicContract(snapshot, {
  toolDefinitions: TOOL_DEFINITIONS,
  activeToolDefinitions: ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS,
  uploadMimeTypes: ARENA_AGENT_UPLOAD_ALLOWED_MIME_TYPES,
  uploadLimits: {
    fileBytes: MAX_AGENT_UPLOAD_BYTES,
    pdfBytes: MAX_AGENT_PDF_UPLOAD_BYTES,
    turnBytes: MAX_AGENT_UPLOAD_BYTES_PER_TURN,
  },
  clientSource,
  agentSource,
  promptProjections: {
    agent: buildArenaAgentSystemPrompt({
      date: new Date('2026-08-30T00:00:00.000Z'),
      timezone: 'UTC',
      includeProcessTools: false,
      includePlanning: false,
      includeConnectors: false,
    }),
    codingActive: buildArenaCodingSystemPrompt({
      date: new Date('2026-08-30T00:00:00.000Z'),
      timezone: 'UTC',
      repoOwner: 'arena-labs',
      repoName: 'harness',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      arenaBranch: 'arena/contract-session',
      cwd: '/home/user',
      sessionStatus: 'active',
      includeProcessTools: false,
      includePlanning: false,
      includeConnectors: false,
    }),
    codingClosed: buildArenaCodingSystemPrompt({
      date: new Date('2026-08-30T00:00:00.000Z'),
      timezone: 'UTC',
      repoOwner: 'arena-labs',
      repoName: 'harness',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      arenaBranch: 'arena/contract-session',
      cwd: '/home/user',
      sessionStatus: 'closed',
      includeProcessTools: false,
      includePlanning: false,
      includeConnectors: false,
    }),
  },
})
const report = {
  generatedAt: new Date().toISOString(),
  sourcePolicy: 'Unauthenticated, read-only public HTML and JavaScript assets; no Cookie header or cookie jar.',
  snapshot,
  diff,
}
const markdown = renderMarkdown(report)

if (!noWrite) {
  await mkdir(outputDirectory, { recursive: true })
  await Promise.all([
    writeFile(resolve(outputDirectory, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(resolve(outputDirectory, 'latest.md'), markdown),
  ])
}

process.stdout.write(markdown)
if (probeStrings.length > 0) {
  const probeAssets = [
    ...assets,
    ...supplementalSources.flatMap((source) => [{ url: source.pageUrl, text: source.pageHtml }, ...source.assets]),
  ]
  process.stdout.write(renderStringProbes(probeArenaPublicStrings(pageUrl, pageHtml, probeAssets, probeStrings, {
    contextCharacters: probeContextCharacters,
    snippetsPerAsset: probeSnippetsPerAsset,
  })))
}
if (!diff.passed) process.exitCode = 1

function optionValue(name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function optionValues(name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    values.push(value)
    index += 1
  }
  return values
}

function numericOption(name: string, fallback: number): number {
  const raw = optionValue(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} requires a non-negative integer`)
  return value
}

async function curlText(url: string): Promise<string> {
  try {
    const result = await execFileAsync('curl', [
      '-fsSL',
      '--compressed',
      '--retry', '4',
      '--retry-all-errors',
      '--retry-delay', '1',
      '--connect-timeout', '15',
      '--max-time', '60',
      url,
    ], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 75_000,
    })
    return result.stdout
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read public Arena asset ${url}: ${message}`)
  }
}

async function curlAssets(urls: readonly string[]): Promise<ArenaPublicAsset[]> {
  const directory = await mkdtemp(join(tmpdir(), 'anera-arena-contract-'))
  const paths = urls.map((_, index) => join(directory, `asset-${String(index).padStart(3, '0')}.js`))
  try {
    const transferArgs = urls.flatMap((url, index) => ['--output', paths[index], url])
    try {
      await execFileAsync('curl', [
        '-fsSL',
        '--compressed',
        '--parallel',
        '--parallel-max', '4',
        '--retry', '3',
        '--retry-all-errors',
        '--retry-delay', '1',
        '--connect-timeout', '15',
        '--max-time', '75',
        ...transferArgs,
      ], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 100_000,
      })
    } catch {
      // Curl can return nonzero when one parallel transfer fails while still
      // leaving all successful assets on disk. Retry only the missing files.
    }
    const assets: ArenaPublicAsset[] = []
    const failures: string[] = []
    for (const [index, url] of urls.entries()) {
      try {
        let text = await readFile(paths[index], 'utf8')
        if (text.length === 0) text = await curlText(url)
        assets.push({ url, text })
      } catch {
        try {
          assets.push({ url, text: await curlText(url) })
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(`Could not read every public Arena script asset:\n${failures.map((failure) => `- ${failure}`).join('\n')}`)
    }
    return assets
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function renderMarkdown(report: {
  generatedAt: string
  sourcePolicy: string
  snapshot: ArenaPublicContractSnapshot
  diff: ArenaPublicContractDiff
}): string {
  const { snapshot, diff } = report
  const uiRows = Object.entries(snapshot.uiStrings)
    .map(([key, value]) => `| ${key} | ${value.present ? 'yes' : 'no'} | \`${escapeCell(value.value)}\` |`)
    .join('\n')
  const clientLiteralRows = Object.entries(snapshot.clientLiterals)
    .map(([key, value]) => `| ${key} | ${value.present ? 'yes' : 'no'} | \`${escapeCell(value.value)}\` |`)
    .join('\n')
  const completedUiRows = Object.entries(snapshot.completedUiStrings)
    .map(([key, value]) => `| ${key} | ${value.present ? 'yes' : 'no'} | \`${escapeCell(value.value)}\` |`)
    .join('\n')
  const previewSwitcherRows = snapshot.previewSwitcherContract.views
    .map((view) => `| ${view.value} | ${view.present ? 'yes' : 'no'} | \`${escapeCell(view.label)}\` |`)
    .join('\n')
  const taskReviewRows = [
    `| feedback type | ${snapshot.taskReviewContract.feedbackType.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskReviewContract.feedbackType.value)}\` |`,
    `| question | ${snapshot.taskReviewContract.questionKey.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskReviewContract.questionKey.value)}\` |`,
    ...snapshot.taskReviewContract.actions.map((action) => `| action | ${action.present ? 'yes' : 'no'} | \`${escapeCell(`${action.action} / ${action.labelKey}`)}\` |`),
    `| dismiss | ${snapshot.taskReviewContract.dismissAction.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskReviewContract.dismissAction.value)}\` |`,
    `| endpointSegment | ${snapshot.taskReviewContract.endpointSegment.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskReviewContract.endpointSegment.value)}\` |`,
    `| request field | ${snapshot.taskReviewContract.sessionNodeIdField.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskReviewContract.sessionNodeIdField.value)}\` |`,
    `| request field | ${snapshot.taskReviewContract.recaptchaTokenField.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskReviewContract.recaptchaTokenField.value)}\` |`,
    `| request field | ${snapshot.taskReviewContract.requestActionField.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskReviewContract.requestActionField.value)}\` |`,
  ].join('\n')
  const taskCompletionRows = [
    `| feedback type | ${snapshot.taskCompletionContract.feedbackType.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskCompletionContract.feedbackType.value)}\` |`,
    `| question | ${snapshot.taskCompletionContract.questionKey.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskCompletionContract.questionKey.value)}\` |`,
    ...snapshot.taskCompletionContract.actions.map((action) => `| action | ${action.present ? 'yes' : 'no'} | \`${escapeCell(`${action.value} / ${action.labelKey}`)}\` |`),
    ...(['endpointSegment', 'containerTestId', 'barTestId', 'latestViewedKey', 'requiresReviewKey', 'feedbackMetadataKey'] as const)
      .map((key) => `| ${key} | ${snapshot.taskCompletionContract[key].present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskCompletionContract[key].value)}\` |`),
  ].join('\n')
  const undoRows = Object.entries(snapshot.undoContract)
    .map(([key, entry]) => `| ${key} | ${entry.present ? 'yes' : 'no'} | \`${escapeCell(entry.value)}\` |`)
    .join('\n')
  const taskCompletionThankYouRows = [
    `| text | ${snapshot.taskCompletionThankYouContract.text.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskCompletionThankYouContract.text.value)}\` |`,
    ...snapshot.taskCompletionThankYouContract.phases.map((entry) => `| phase | ${entry.present ? 'yes' : 'no'} | \`${entry.value}\` |`),
    `| visibleMs | ${snapshot.taskCompletionThankYouContract.visibleMs.present ? 'yes' : 'no'} | \`${snapshot.taskCompletionThankYouContract.visibleMs.value}\` |`,
    `| exitMs | ${snapshot.taskCompletionThankYouContract.exitMs.present ? 'yes' : 'no'} | \`${snapshot.taskCompletionThankYouContract.exitMs.value}\` |`,
    `| excludedArm | ${snapshot.taskCompletionThankYouContract.excludedArm.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.taskCompletionThankYouContract.excludedArm.value)}\` |`,
  ].join('\n')
  const customFeedbackRows = [
    `| featureFlag | ${snapshot.customFeedbackContract.featureFlag.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.customFeedbackContract.featureFlag.value)}\` |`,
    ...snapshot.customFeedbackContract.arms.map((entry) => `| arm | ${entry.present ? 'yes' : 'no'} | \`${escapeCell(entry.value)}\` |`),
    `| dataPartType | ${snapshot.customFeedbackContract.dataPartType.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.customFeedbackContract.dataPartType.value)}\` |`,
    `| partField | ${snapshot.customFeedbackContract.systemMessageField.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.customFeedbackContract.systemMessageField.value)}\` |`,
    `| partField | ${snapshot.customFeedbackContract.reviewedNodeIdField.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.customFeedbackContract.reviewedNodeIdField.value)}\` |`,
    `| trustedMarker | ${snapshot.customFeedbackContract.marker.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.customFeedbackContract.marker.value)}\` |`,
    `| telemetryField | ${snapshot.customFeedbackContract.telemetryField.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.customFeedbackContract.telemetryField.value)}\` |`,
    `| trustedRecognition | ${snapshot.customFeedbackContract.providerMetadataRecognition.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.customFeedbackContract.providerMetadataRecognition.value)}\` |`,
    `| partOrder | ${snapshot.customFeedbackContract.leadingPartOrder.present ? 'yes' : 'no'} | \`${escapeCell(snapshot.customFeedbackContract.leadingPartOrder.value)}\` |`,
    ...Object.entries(snapshot.customFeedbackContract.ui)
      .map(([key, entry]) => `| ui.${key} | ${entry.present ? 'yes' : 'no'} | \`${escapeCell(entry.value)}\` |`),
  ].join('\n')
  const resultRows = Object.entries(snapshot.keyResultFields)
    .map(([tool, fields]) => `| ${tool} | ${fields.map((field) => `\`${field}\``).join(', ')} |`)
    .join('\n')
  const errorExtensionRows = Object.entries(snapshot.toolErrorExtensionFields)
    .map(([tool, fields]) => `| ${tool} | ${fields.map((field) => `\`${field}\``).join(', ')} |`)
    .join('\n')
  const argumentRows = snapshot.toolNames
    .map((tool) => `| ${tool} | \`${escapeCell(argumentSchemaSummary(snapshot.toolArgumentSchemas[tool]))}\` |`)
    .join('\n')
  const activePromptRows = Object.entries(snapshot.activeAgentPromptAnchors)
    .map(([key, entry]) => `| ${key} | ${entry.present ? 'yes' : 'no'} | \`${escapeCell(entry.value)}\` |`)
    .join('\n')
  const promptTemplateRows = [
    snapshot.promptTemplates.agent,
    snapshot.promptTemplates.coding,
    snapshot.promptTemplates.codingClosedGuidance,
  ].map((entry) => `| ${entry.identifier} | ${entry.present ? 'yes' : 'no'} | ${entry.length ?? '—'} | \`${entry.sha256 ?? 'not extracted'}\` |`)
    .join('\n')
  const activeContractRows = snapshot.activeAgentToolNames
    .map((name) => {
      const contract = snapshot.activeAgentToolContracts[name]
      const schema = contract?.schemaSha256 ? 'yes' : `no (${contract?.missingSchemaEvidence.length ?? 0} missing)`
      const description = contract?.descriptionSha256 ? 'yes' : `no (${contract?.missingDescriptionEvidence.length ?? 0} missing)`
      return `| ${name} | ${schema} | ${description} | \`${escapeCell((contract?.argumentFields ?? []).join(', '))}\` |`
    })
    .join('\n')
  const createChatTransportRows = (Object.entries(snapshot.createChatTransport) as Array<[
    keyof ArenaPublicContractSnapshot['createChatTransport'],
    Record<string, { value: string; present: boolean; assets: string[] }>,
  ]>).flatMap(([branch, entries]) => Object.entries(entries).map(([key, entry]) => (
    `| ${branch} | ${key} | ${entry.present ? 'yes' : 'no'} | \`${escapeCell(entry.value)}\` | ${entry.assets.length} |`
  ))).join('\n')
  return `# Arena public Agent contract audit

- Generated: ${report.generatedAt}
- Result: **${diff.passed ? 'PASS' : 'FAIL'}**
- Source: ${report.sourcePolicy}
- Deployment: \`${snapshot.deploymentId ?? 'not extracted'}\`
- Script assets: ${snapshot.scriptAssets.length}
- Supplemental completed routes: ${snapshot.supplementalPages.length}
- Legacy/shared tool schema asset: \`${snapshot.toolSchemaAsset ?? 'not extracted'}\`
- Current active Agent registry asset: \`${snapshot.activeAgentToolRegistryAsset ?? 'not extracted'}\`
- Upload policy asset: \`${snapshot.upload.sourceAsset ?? 'not extracted'}\`

## Current completed-route active Agent registry

This is the output registry consumed by the current completed \`/agent/[id]\` route.

${snapshot.activeAgentToolNames.length > 0 ? snapshot.activeAgentToolNames.map((name) => `- \`${name}\``).join('\n') : '_Not extracted; supply a completed Agent route with \`--supplemental-page\`._'}

## Active Agent argument schemas and descriptions

| Tool | Live schema evidence | Live description evidence | Top-level fields |
|---|---:|---:|---|
${activeContractRows || '| _not extracted_ | no | no | |'}

## Active Agent prompt-template anchors

| Contract | Live | Value |
|---|---:|---|
${activePromptRows}

## Whole Agent prompt templates

The audit parses the complete public JavaScript string assignments without evaluating bundle code, freezes their raw SHA-256 values, and compares deterministic ordinary/Coding/closed local builder outputs byte-for-byte.

| Template | Live | Characters | SHA-256 |
|---|---:|---:|---|
${promptTemplateRows}

## Legacy/shared schema surface

This separate bundle surface is retained as historical/shared schema evidence; it is not labeled as the current Agent Harness registry.

${snapshot.toolNames.map((name) => `- \`${name}\``).join('\n')}

## Observable argument schemas

These are semantic projections of the public bundled Zod parser, not claims about Arena's private server prompt or additional backend validation.

| Tool | Schema |
|---|---|
${argumentRows}

## Key result fields

Common error union: ${snapshot.commonErrorResultFields.map((field) => `\`${field}\``).join(', ')}

| Tool error extension | Observed fields |
|---|---|
${errorExtensionRows}

| Tool | Observed fields |
|---|---|
${resultRows}

## UI strings

| Contract | Live | Value |
|---|---:|---|
${uiRows}

## Completed-route UI strings

| Contract | Live | Value |
|---|---:|---|
${completedUiRows}

## Preview switcher contract

The current public component renders icon-only buttons and exposes these literal accessible names through \`aria-label\`.

| View | Live | Accessible label |
|---|---:|---|
${previewSwitcherRows}

## Task-review action contract

| Contract | Live | Value |
|---|---:|---|
${taskReviewRows}

## Task-completion-bar contract

| Contract | Live | Value |
|---|---:|---|
${taskCompletionRows}

## Undo-last-turn contract

The public client proves a conversation/action rewind. It does not prove a Workspace revision rollback.

| Contract | Live | Value |
|---|---:|---|
${undoRows}

## Task-completion thank-you contract

| Contract | Live | Value |
|---|---:|---|
${taskCompletionThankYouRows}

## Agentic custom-feedback contract

The public client constructs a leading \`data-custom-feedback\` part correlated to the reviewed Assistant node. Its trusted marker is provider-facing metadata, while the marker part itself is filtered from visible conversation rendering.

| Contract | Live | Value |
|---|---:|---|
${customFeedbackRows}

## Client-state literals

| Contract | Live | Value |
|---|---:|---|
${clientLiteralRows}

## Upload contract

- MIME types: ${snapshot.upload.allowedMimeTypes.map((value) => `\`${value}\``).join(', ')}
- Per file: ${snapshot.upload.fileBytes ?? 'not extracted'} bytes
- PDF: ${snapshot.upload.pdfBytes ?? 'not extracted'} bytes
- Per turn: ${snapshot.upload.turnBytes ?? 'not extracted'} bytes

## New Chat create/upload transport

Arena's landing route atomically creates a chat, its upload client uses a signed binary PUT plus user-scoped CAS URL, and an existing Session retains the separate agentic turn envelope.

| Branch | Contract | Live | Value | Source assets |
|---|---|---:|---|---:|
${createChatTransportRows}

## Diff

${diff.issues.length === 0 ? 'No drift was found between the frozen public contract and the local implementation.' : diff.issues.map((issue) => `- ${issue}`).join('\n')}
`
}

function renderStringProbes(probes: ReturnType<typeof probeArenaPublicStrings>): string {
  const sections = probes.map((probe) => {
    if (!probe.present) return `### \`${escapeCell(probe.value)}\`\n\nNot found in the public Agent HTML/assets.`
    const hits = probe.hits.flatMap((hit) => [
      `- Asset: \`${hit.asset}\` (${hit.occurrences} occurrence${hit.occurrences === 1 ? '' : 's'})`,
      ...hit.snippets.map((snippet) => `  - \`${escapeCell(snippet)}\``),
    ])
    return `### \`${escapeCell(probe.value)}\`\n\n${hits.join('\n')}`
  })
  return `\n## Candidate string probes\n\nA hit is evidence for review, not an automatic addition to the frozen contract.\n\n${sections.join('\n\n')}\n`
}

function argumentSchemaSummary(schema: ArenaPublicContractSnapshot['toolArgumentSchemas'][string] | undefined): string {
  if (!schema) return 'not extracted'
  let summary: string
  if (schema.type === 'object') {
    summary = `{${Object.entries(schema.properties ?? {}).map(([name, property]) => `${name}${property.optional ? '?' : ''}:${argumentSchemaSummary({ ...property, optional: undefined })}`).join(', ')}}`
  } else if (schema.type === 'array') {
    summary = `${argumentSchemaSummary(schema.items)}[]`
  } else if (schema.type === 'enum') {
    summary = `enum(${(schema.enum ?? []).map(String).join('|')})`
  } else if (schema.type === 'literal') {
    summary = `literal(${String(schema.literal)})`
  } else {
    summary = schema.type
  }
  if (schema.default !== undefined) summary += `=default(${String(schema.default)})`
  if (schema.preprocess) summary += ` preprocess(${schema.preprocess})`
  if (schema.catch !== undefined) summary += ` catch(${JSON.stringify(schema.catch)})`
  if (schema.passthrough) summary += ' passthrough'
  return summary
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('`', '\\`')
}
