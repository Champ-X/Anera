import { createHash } from 'node:crypto'
import { deepStrictEqual } from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type JsonRecord = Record<string, any>

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures: string[] = []
let assertionCount = 0
let verifiedSourceCount = 0
let verifiedFingerprintFileCount = 0
let verifiedArtifactCount = 0

function absolute(relativePath: string): string {
  const target = resolve(projectRoot, relativePath)
  if (!target.startsWith(`${projectRoot}/`)) throw new Error(`Path escapes project root: ${relativePath}`)
  return target
}

function readText(relativePath: string): string {
  return readFileSync(absolute(relativePath), 'utf8')
}

function readJson(relativePath: string): JsonRecord {
  return JSON.parse(readText(relativePath)) as JsonRecord
}

function same(label: string, actual: unknown, expected: unknown): void {
  assertionCount += 1
  try {
    deepStrictEqual(actual, expected)
  } catch {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

function truthy(label: string, value: unknown): void {
  assertionCount += 1
  if (!value) failures.push(`${label}: expected a truthy value, received ${JSON.stringify(value)}`)
}

function verifySource(
  evidencePath: string,
  label: string,
  relativePath: string,
  expectedBytes: number,
  expectedSha256: string,
): JsonRecord {
  assertionCount += 1
  const sourcePath = absolute(relativePath)
  if (!existsSync(sourcePath)) {
    failures.push(`${evidencePath} ${label}: missing ${relativePath}`)
    return {}
  }

  const bytes = readFileSync(sourcePath)
  same(`${evidencePath} ${label} bytes`, bytes.length, expectedBytes)
  same(
    `${evidencePath} ${label} sha256`,
    createHash('sha256').update(bytes).digest('hex'),
    expectedSha256,
  )
  verifiedSourceCount += 1
  return JSON.parse(bytes.toString('utf8')) as JsonRecord
}

function verifyArtifact(
  evidencePath: string,
  relativePath: string,
  expectedBytes: number,
  expectedSha256: string,
): void {
  assertionCount += 1
  const artifactPath = absolute(relativePath)
  if (!existsSync(artifactPath)) {
    failures.push(`${evidencePath} artifact: missing ${relativePath}`)
    return
  }
  const bytes = readFileSync(artifactPath)
  same(`${evidencePath} artifact ${relativePath} bytes`, bytes.length, expectedBytes)
  same(
    `${evidencePath} artifact ${relativePath} sha256`,
    createHash('sha256').update(bytes).digest('hex'),
    expectedSha256,
  )
  verifiedArtifactCount += 1
}

function verifyStandardProvenance(evidencePath: string, evidence: JsonRecord): JsonRecord {
  const provenance = evidence.provenance as JsonRecord
  return verifySource(
    evidencePath,
    'source',
    provenance.source,
    provenance.sourceBytes,
    provenance.sourceSha256,
  )
}

function countTrueLeaves(value: unknown): { present: number; missing: number } {
  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => {
        const child = countTrueLeaves(item)
        return { present: total.present + child.present, missing: total.missing + child.missing }
      },
      { present: 0, missing: 0 },
    )
  }
  if (!value || typeof value !== 'object') return { present: 0, missing: 0 }

  let present = 0
  let missing = 0
  for (const [key, item] of Object.entries(value as JsonRecord)) {
    if (key === 'present') {
      if (item === true) present += 1
      else missing += 1
      continue
    }
    const child = countTrueLeaves(item)
    present += child.present
    missing += child.missing
  }
  return { present, missing }
}

function providerDescription(source: JsonRecord): string {
  return `${source.provider.name} ${source.provider.api}`
}

function visionMetering(source: JsonRecord): JsonRecord {
  const rows = source.visionUsage as JsonRecord[]
  return {
    physicalRequests: rows.reduce((sum, row) => sum + row.modelRequestCount, 0),
    meteredCalls: rows.reduce((sum, row) => sum + row.modelCallCount, 0),
    cacheHitInputTokens: rows.reduce((sum, row) => sum + row.tokens.cachedPromptTokens, 0),
    cacheMissInputTokens: rows.reduce(
      (sum, row) => sum + row.tokens.promptTokens - row.tokens.cachedPromptTokens,
      0,
    ),
    outputTokens: rows.reduce((sum, row) => sum + row.tokens.completionTokens, 0),
    totalTokens: rows.reduce((sum, row) => sum + row.tokens.totalTokens, 0),
    estimatedCostUsd: rows.reduce((sum, row) => sum + row.estimatedCostUsd, 0),
  }
}

function verifyEvidenceEnvelope(path: string, evidence: JsonRecord, expectedType: string): void {
  same(`${path} schema`, evidence.schemaVersion, 'anera-public-evidence-summary/1.0')
  same(`${path} type`, evidence.evidenceType, expectedType)
  const text = readText(path)
  same(`${path} host paths redacted`, /\/Users\//.test(text), false)
  same(`${path} session ids redacted`, /\bses_[a-z0-9]+\b/i.test(text), false)
  same(`${path} local preview URLs redacted`, /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i.test(text), false)
}

function verifyCorpus(): void {
  const path = 'evidence/arena-reference-corpus-summary.json'
  const evidence = readJson(path)
  verifyEvidenceEnvelope(path, evidence, 'arena-reference-corpus-intake')
  const source = verifyStandardProvenance(path, evidence)

  same(`${path} source schema`, evidence.sourceSchemaVersion, source.schemaVersion)
  same(`${path} generatedAt`, evidence.generatedAt, source.generatedAt)
  same(`${path} scope product`, evidence.scope.product, source.scope.product)
  same(`${path} scope visual`, evidence.scope.visualScope, source.scope.visualScope)
  same(`${path} mobile excluded`, evidence.scope.mobileExcluded, source.scope.mobileExcluded)
  same(`${path} frozen task count`, evidence.scope.frozenTaskCount, source.scope.expectedTaskCount)

  const inventoryProjection = {
    taskDirectories: source.inventory.taskDirectories,
    runDirectories: source.inventory.runDirectories,
    metadataRuns: source.inventory.metadataRuns,
    includedStructuredRuns: source.inventory.includedMetadataRuns,
    invalidMetadataRetries: source.inventory.invalidMetadataRetries,
    rawOnlyRunsWithoutMetadata: source.inventory.rawOnlyRunsWithoutMetadata,
    curatedCanonicalRuns: source.inventory.curatedCanonicalRuns,
    totalCanonicalEvents: source.inventory.totalCanonicalEvents,
    captureQuality: {
      complete: source.inventory.captureQuality.complete,
      completeWithDeclaredGaps: source.inventory.captureQuality.complete_with_declared_gaps,
    },
    arenaUiOutcomes: source.inventory.arenaUiOutcomes,
    taskOracleResults: source.inventory.taskOracleResults,
  }
  same(`${path} inventory`, evidence.inventory, inventoryProjection)
  same(`${path} covered capabilities`, evidence.coverage.coveredCapabilityCount, source.coverage.distinctCapabilityCount)
  same(`${path} total capabilities`, evidence.coverage.totalCapabilityCount, 57)
  truthy(`${path} 17/57 definition documented`, readText('reports/arena-reference-corpus-2026-08-30/README.md').includes('17/57'))
  same(`${path} unmapped observations`, evidence.coverage.unmappedObservations, source.coverage.unmappedObservations)
  same(`${path} raw-only task count`, evidence.coverage.rawOnlyTaskCount, source.coverage.rawOnlyTaskIds.length)
  same(`${path} missing task count`, evidence.coverage.missingTaskCount, source.coverage.missingTaskIds.length)

  same(
    `${path} runs`,
    evidence.runs,
    source.runs.map((run: JsonRecord) => ({
      taskId: run.taskId,
      taskVersion: run.taskVersion,
      events: run.eventCount,
      agentDurationMs: run.agentDurationMs,
      capture: run.captureQuality,
      oracle: run.taskResult,
    })),
  )
  same(`${path} current eligible references`, evidence.parityReadiness.currentTaskVersionEligibleReferenceRuns, source.parityReadiness.currentTaskVersionEligibleReferenceRuns)
  same(`${path} paired candidates`, evidence.parityReadiness.pairedAneraCandidateRuns, source.parityReadiness.pairedAneraCandidateRuns)
  same(`${path} eligible pairs`, evidence.parityReadiness.eligiblePairedRuns, source.parityReadiness.eligiblePairedRuns)
  same(`${path} formal parity availability`, evidence.parityReadiness.formalParityScoreAvailable, source.parityReadiness.formalParityScoreAvailable)
  same(`${path} efficiency availability`, evidence.parityReadiness.efficiencyBaselineAvailable, source.parityReadiness.efficiencyBaselineAvailable)
  same(`${path} visual baseline availability`, evidence.parityReadiness.sameViewportDomPngBaselineAvailable, source.parityReadiness.sameViewportDomPngBaselineAvailable)
  truthy(`${path} invisible Arena usage documented`, source.parityReadiness.reason.includes('model-call, token, and cost values are not visible'))
  same(`${path} Arena usage visibility`, evidence.parityReadiness.arenaModelCallsTokensCostVisible, false)
}

function verifyHarnessConvergence(): void {
  const path = 'evidence/harness-convergence-summary.json'
  const evidence = readJson(path)
  verifyEvidenceEnvelope(path, evidence, 'harness-convergence')
  const source = verifyStandardProvenance(path, evidence)
  const totals = source.totals

  same(`${path} source schema`, evidence.sourceSchemaVersion, source.schemaVersion)
  same(`${path} generatedAt`, evidence.generatedAt, source.generatedAt)
  same(`${path} model`, evidence.execution.model, source.modelExecution)
  same(`${path} passed`, evidence.execution.passed, source.passed)
  for (const [summaryKey, sourceKey] of Object.entries({
    passedScenarios: 'passedScenarios',
    scenarioCount: 'scenarios',
    activeDurationMs: 'activeDurationMs',
    wallMs: 'wallMs',
    modelCalls: 'modelCalls',
    toolCalls: 'toolCalls',
    promptTokens: 'promptTokens',
    completionTokens: 'completionTokens',
    cachedPromptTokens: 'cachedPromptTokens',
    cacheHitRatio: 'cacheHitRatio',
    estimatedCostUsd: 'estimatedCostUsd',
  })) same(`${path} execution.${summaryKey}`, evidence.execution[summaryKey], totals[sourceKey])

  same(`${path} required tool count`, evidence.activeToolCoverage.required, source.activeToolCoverage.required.length)
  same(`${path} covered tool count`, evidence.activeToolCoverage.covered, source.activeToolCoverage.covered.length)
  same(`${path} missing tools`, evidence.activeToolCoverage.missing, source.activeToolCoverage.missing)
  same(`${path} tool coverage passed`, evidence.activeToolCoverage.passed, source.activeToolCoverage.passed)
  same(`${path} tool names`, evidence.activeToolCoverage.tools, source.activeToolCoverage.covered)
  same(
    `${path} scenarios`,
    evidence.scenarios,
    source.scenarios.map((scenario: JsonRecord) => ({
      name: scenario.name,
      passed: scenario.passed,
      modelCalls: scenario.usage.modelCalls,
      toolCalls: scenario.usage.toolCalls,
      failedTools: scenario.failedTools.length,
      ...(scenario.name === 'tool_failure_recovery'
        ? { note: 'The single failed read is intentional recovery evidence.' }
        : {}),
    })),
  )
  same(`${path} parity gate`, evidence.scope.arenaParityGate, source.arenaParityGate)
  same(`${path} mobile`, evidence.scope.mobileExcluded, source.mobileExcluded)
  truthy(`${path} fixture-backed external tools declared`, source.providerFixtureCalls.length > 0 && source.externalTools.includes('fixtures'))
  same(`${path} fixtures are not provider charges`, evidence.scope.fixtureMediaSpeechCostsAreExternalProviderCharges, false)
  same(`${path} Arena parity evidence`, evidence.scope.arenaParityEvidence, false)
}

function verifyHtmlSlides(): void {
  const path = 'evidence/html-slides-live-summary.json'
  const evidence = readJson(path)
  verifyEvidenceEnvelope(path, evidence, 'exact-prompt-html-slides-live-canary')
  const source = verifyStandardProvenance(path, evidence)

  same(`${path} source schema`, evidence.sourceSchemaVersion, source.schemaVersion)
  same(`${path} generatedAt`, evidence.generatedAt, source.generatedAt)
  same(`${path} passed`, evidence.execution.passed, source.passed)
  same(`${path} production bundle`, evidence.execution.productionBundle, source.productionBundle)
  same(`${path} live providers`, evidence.execution.liveProviders, source.liveProviders)
  same(`${path} status`, evidence.execution.status, source.status)
  same(`${path} provider identity`, evidence.execution.providerIdentity, source.providerIdentity)
  for (const key of ['activeDurationMs', 'modelRequests', 'modelCalls', 'toolCalls', 'promptTokens', 'completionTokens', 'cachedPromptTokens', 'estimatedCostUsd', 'estimatedCostStatus']) {
    same(`${path} execution.${key}`, evidence.execution[key], source.usage[key])
  }
  same(`${path} checks`, evidence.checks, source.checks)
  same(`${path} artifact`, evidence.artifact, {
    path: source.artifact.path,
    bytes: source.artifact.bytes,
    sha256: source.artifact.sha256,
    sourceUrlCount: source.artifact.sourceUrlCount,
  })
  same(`${path} screenshot`, evidence.screenshot, {
    path: source.screenshot.path,
    bytes: source.screenshot.bytes,
    sha256: source.screenshot.sha256,
  })
  same(`${path} fingerprint schema`, evidence.provenance.implementationFingerprintSchemaVersion, source.implementationFingerprint.schemaVersion)
  same(`${path} fingerprint sha`, evidence.provenance.implementationFingerprintSha256, source.implementationFingerprint.aggregateSha256)
  same(`${path} fingerprint files`, evidence.provenance.implementationFingerprintFileCount, Object.keys(source.implementationFingerprint.files).length)
  for (const [relativePath, expected] of Object.entries(source.implementationFingerprint.files) as Array<[string, JsonRecord]>) {
    const currentPath = absolute(relativePath)
    truthy(`${path} fingerprint file ${relativePath}`, existsSync(currentPath))
    if (!existsSync(currentPath)) continue
    const current = readFileSync(currentPath)
    same(`${path} current bytes ${relativePath}`, current.length, expected.bytes)
    same(`${path} current sha ${relativePath}`, createHash('sha256').update(current).digest('hex'), expected.sha256)
    verifiedFingerprintFileCount += 1
  }
  same(`${path} no tool failures`, source.toolFailures.length + source.toolTimeouts.length + source.unexpectedToolFailures.length, 0)
  same(`${path} Arena parity`, evidence.scope.arenaParityEvidence, source.arenaExactParityClaimed)
  same(`${path} mobile`, evidence.scope.mobileExcluded, source.mobileExcluded)
}

function verifyVision(): void {
  const path = 'evidence/live-vision-summary.json'
  const evidence = readJson(path)
  verifyEvidenceEnvelope(path, evidence, 'live-vision-task')
  const provenance = evidence.provenance
  const latest = verifySource(path, 'latest active source', provenance.latestActiveSmokeSource, provenance.latestActiveSmokeSourceBytes, provenance.latestActiveSmokeSourceSha256)
  const historical = verifySource(path, 'historical source', provenance.smokeSource, provenance.smokeSourceBytes, provenance.smokeSourceSha256)
  const pricing = verifySource(path, 'pricing sidecar', provenance.pricingSidecar, provenance.pricingSidecarBytes, provenance.pricingSidecarSha256)

  same(`${path} source schema`, evidence.sourceSchemaVersion, latest.schemaVersion)
  same(`${path} generatedAt`, evidence.generatedAt, latest.generatedAt)
  const latestMetering = visionMetering(latest)
  same(`${path} latest attestation`, evidence.latestActiveAttestation, {
    productionBundle: latest.productionBundle,
    liveProvider: latest.liveProvider,
    providerFixture: latest.providerFixture,
    provider: providerDescription(latest),
    model: latest.requiredVisionModel,
    status: latest.status,
    passed: latest.passed,
    activeDurationMs: latest.usage.activeDurationMs,
    modelRequests: latest.usage.modelRequests,
    modelCalls: latest.usage.modelCalls,
    toolCalls: latest.usage.toolCalls,
    promptTokens: latest.usage.promptTokens,
    completionTokens: latest.usage.completionTokens,
    totalTokens: latest.usage.totalTokens,
    cachedPromptTokens: latest.usage.cachedPromptTokens,
    estimatedCostUsd: latest.usage.estimatedCostUsd,
    estimatedCostStatus: latest.usage.estimatedCostStatus,
    visionMetering: {
      ...latestMetering,
      estimatedCostStatus: latest.visionUsage[0].estimatedCostStatus,
    },
    toolChain: latest.completedTools,
    checks: latest.checks,
  })

  same(`${path} historical execution`, evidence.execution, {
    productionBundle: historical.productionBundle,
    liveProvider: historical.liveProvider,
    providerFixture: historical.providerFixture,
    provider: providerDescription(historical),
    model: historical.requiredVisionModel,
    status: historical.status,
    passed: historical.passed,
    activeDurationMs: historical.usage.activeDurationMs,
    modelCalls: historical.usage.modelCalls,
    toolCalls: historical.usage.toolCalls,
    promptTokens: historical.usage.promptTokens,
    completionTokens: historical.usage.completionTokens,
    totalTokens: historical.usage.totalTokens,
    cachedPromptTokens: historical.usage.cachedPromptTokens,
    historicalSessionEstimatedCostUsd: historical.usage.estimatedCostUsd,
  })
  const historicalMetering = visionMetering(historical)
  same(`${path} historical metering`, evidence.visionMetering, {
    physicalRequests: historicalMetering.physicalRequests,
    meteredCalls: historicalMetering.meteredCalls,
    cacheHitInputTokens: historicalMetering.cacheHitInputTokens,
    cacheMissInputTokens: historicalMetering.cacheMissInputTokens,
    outputTokens: historicalMetering.outputTokens,
    totalTokens: historicalMetering.totalTokens,
    historicalVisionCostUsd: pricing.reconciliation.originalVisionCostUsd,
    correctedOffPeakVisionCostUsd: pricing.reconciliation.correctedVisionCostUsd,
    correctedSessionEstimatedCostUsd: pricing.reconciliation.correctedSessionCostUsd,
    costInterpretation: 'Mechanically adjusted historical estimate; not a new provider bill.',
  })
  same(`${path} sidecar source`, pricing.sourceReport.path, provenance.smokeSource)
  same(`${path} sidecar source sha`, pricing.sourceReport.sha256, provenance.smokeSourceSha256)
  same(`${path} historical chain`, evidence.toolChain, historical.completedTools)
  same(`${path} historical checks`, evidence.checks, historical.checks)
  same(`${path} privacy declaration`, evidence.privacy, {
    sessionIdIncluded: false,
    localPreviewUrlIncluded: false,
    sourceImageIncluded: false,
    credentialValuesIncluded: false,
  })
}

function compactMetering(row: JsonRecord): JsonRecord {
  const request = row.requests[0]
  return {
    ...(request ? { provider: request.provider } : { provider: row.cacheProvider }),
    ...(row.cache !== 'not_applicable' ? { cache: row.cache } : {}),
    providerCalls: row.providerCalls,
    responseBytes: row.responseBytes,
    ...(request ? { outcome: request.outcome } : {}),
  }
}

function verifyWebProviders(): void {
  const path = 'evidence/live-web-provider-summary.json'
  const evidence = readJson(path)
  verifyEvidenceEnvelope(path, evidence, 'live-web-provider-cache-canary')
  const source = verifyStandardProvenance(path, evidence)

  same(`${path} source schema`, evidence.sourceSchemaVersion, source.schemaVersion)
  same(`${path} generatedAt`, evidence.generatedAt, source.generatedAt)
  same(`${path} passed`, evidence.execution.passed, source.passed)
  same(
    `${path} execution description`,
    evidence.execution.description.toLowerCase().replace(/\bthe\s+/g, ''),
    source.execution.toLowerCase().replace(/\bthe\s+/g, ''),
  )
  same(`${path} credential state`, evidence.execution.credentialsConfigured, {
    tavily: source.credentials.tavilyConfigured,
    firecrawl: source.credentials.firecrawlConfigured,
  })
  same(`${path} credential values`, evidence.execution.credentialValuesStored, source.credentials.valuesStored)
  same(`${path} Pexels bypass`, evidence.execution.pexelsBypassed, source.credentials.pexelsBypassed)
  same(`${path} search count`, evidence.execution.searchResultCount, source.searchResultUrls.length)
  same(`${path} image count`, evidence.execution.persistedImageResultCount, source.imageResults.length)
  same(`${path} chunks`, evidence.execution.fetchedPageChunkCount, source.page.totalChunks)
  same(`${path} first chunk bytes`, evidence.execution.firstChunkBytes, source.page.firstChunkBytes)
  same(`${path} continuation`, evidence.execution.continuationExercised, source.page.continuationExercised)
  same(`${path} web search metering`, evidence.metering.webSearch, compactMetering(source.metering.search))
  same(`${path} image metering`, evidence.metering.imageSearchFallback, compactMetering(source.metering.imageSearch))
  for (const [summaryKey, sourceKey] of Object.entries({
    firstFetch: 'firstFetch',
    repeatedFetch: 'repeatedFetch',
    continuationFetch: 'continuationFetch',
    nextTurnFetch: 'nextTurnFetch',
  })) same(`${path} ${summaryKey} metering`, evidence.metering[summaryKey], compactMetering(source.metering[sourceKey]))
  same(`${path} provider cost`, evidence.metering.providerCostUsd, source.metering.firstFetch.costUsd)
  same(`${path} provider cost status`, evidence.metering.providerCostStatus, source.metering.firstFetch.costStatus)
  same(`${path} checks`, evidence.checks, source.results)
  same(`${path} parity gate`, evidence.scope.arenaParityGate, source.arenaParityGate)
  same(`${path} mobile`, evidence.scope.mobileExcluded, source.mobileExcluded)
}

function verifyPublicContract(): void {
  const path = 'evidence/public-contract-summary.json'
  const evidence = readJson(path)
  verifyEvidenceEnvelope(path, evidence, 'arena-public-contract')
  const source = verifyStandardProvenance(path, evidence)
  const diff = source.diff
  const snapshot = source.snapshot

  same(`${path} generatedAt`, evidence.generatedAt, source.generatedAt)
  same(`${path} source policy`, evidence.provenance.sourcePolicy, source.sourcePolicy)
  same(`${path} deployment`, evidence.provenance.arenaDeploymentId, snapshot.deploymentId)
  same(`${path} passed`, evidence.result.passed, diff.passed)
  same(`${path} issue count`, evidence.result.issueCount, diff.issues.length)
  same(`${path} missing local active registry`, evidence.result.activeRegistryMissingLocally, diff.activeAgentToolsMissingLocally.length)
  same(`${path} missing public active tools`, evidence.result.expectedActiveToolsMissingPublicly, diff.expectedActiveAgentToolsMissingPublicly.length)
  same(`${path} unexpected active tools`, evidence.result.unexpectedActiveTools, diff.unexpectedActiveAgentTools.length)
  same(`${path} schema mismatches`, evidence.result.activeSchemaMismatches, diff.liveActiveAgentSchemaMismatches.length + diff.localActiveAgentSchemaMismatches.length)
  same(`${path} description mismatches`, evidence.result.activeDescriptionMismatches, diff.liveActiveAgentDescriptionMismatches.length + diff.localActiveAgentDescriptionMismatches.length)
  same(`${path} prompt projection mismatches`, evidence.result.promptProjectionMismatches, diff.localAgentPromptProjectionMismatches.length)
  same(`${path} public UI mismatches`, evidence.result.publicUiStringsMissingLocally, diff.publicUiStringsMissingLocally.length)
  same(`${path} completed UI mismatches`, evidence.result.completedUiStringsMissingLocally, diff.completedUiStringsMissingLocally.length)
  same(`${path} script count`, evidence.publicAssetIntake.scriptAssetCount, snapshot.scriptAssets.length)
  same(`${path} supplemental route count`, evidence.publicAssetIntake.supplementalCompletedRouteCount, snapshot.supplementalPages.length)
  same(`${path} active tool count`, evidence.currentActiveAgentRegistry.toolCount, snapshot.activeAgentToolNames.length)
  same(`${path} contract evidence count`, evidence.currentActiveAgentRegistry.schemaAndDescriptionEvidenceCount, Object.keys(snapshot.activeAgentToolContracts).length)
  same(`${path} active tools`, evidence.currentActiveAgentRegistry.tools, snapshot.activeAgentToolNames)
  same(
    `${path} prompt templates`,
    evidence.publicPromptTemplates,
    [snapshot.promptTemplates.agent, snapshot.promptTemplates.coding, snapshot.promptTemplates.codingClosedGuidance].map((template: JsonRecord) => ({
      identifier: template.identifier,
      characters: template.length,
      sha256: template.sha256,
    })),
  )
  same(`${path} prompt anchor count`, evidence.observableContractCoverage.promptAnchorCount, Object.keys(snapshot.activeAgentPromptAnchors).length)
  same(`${path} general UI count`, evidence.observableContractCoverage.generalUiStringCount, Object.keys(snapshot.uiStrings).length)
  same(`${path} completed UI count`, evidence.observableContractCoverage.completedRouteUiStringCount, Object.keys(snapshot.completedUiStrings).length)
  const contracts: Array<[string, unknown]> = [
    ['previewSwitcher', snapshot.previewSwitcherContract],
    ['taskReview', snapshot.taskReviewContract],
    ['taskCompletion', snapshot.taskCompletionContract],
    ['taskCompletionThankYou', snapshot.taskCompletionThankYouContract],
    ['customFeedback', snapshot.customFeedbackContract],
    ['undoLastTurn', snapshot.undoContract],
    ['newChatTransport', snapshot.createChatTransport.newChat],
    ['existingTurnTransport', snapshot.createChatTransport.existingTurn],
    ['signedUploadTransport', snapshot.createChatTransport.signedUpload],
  ]
  for (const [key, contract] of contracts) {
    const leaves = countTrueLeaves(contract)
    truthy(`${path} ${key} public evidence present`, leaves.present > 0 && leaves.missing === 0)
    same(`${path} ${key} summary`, evidence.observableContractCoverage[key], true)
  }
  same(`${path} private backend limitation`, evidence.limitations.privateBackendObserved, false)
  same(`${path} authenticated data limitation`, evidence.limitations.authenticatedAccountDataUsed, false)
  same(`${path} parity limitation`, evidence.limitations.endToEndParityClaim, false)
}

function verifyQualityBenchmark(): void {
  const path = 'evidence/quality-benchmark-summary.json'
  const evidence = readJson(path)
  verifyEvidenceEnvelope(path, evidence, 'harness-quality-benchmark')
  const source = verifyStandardProvenance(path, evidence)
  const summary = source.summary

  same(`${path} source schema`, evidence.sourceSchemaVersion, source.schemaVersion)
  same(`${path} generatedAt`, evidence.generatedAt, source.generatedAt)
  const expectedBenchmark: JsonRecord = {
    type: source.benchmarkType,
    scope: source.benchmarkScope,
    passed: source.passed,
    passedTasks: summary.passedTasks,
    taskCount: summary.tasks,
    qualityScore: summary.qualityScore,
    criticalChecksPassed: summary.criticalChecksPassed,
    efficiencyBudgetsPassed: summary.efficiencyBudgetsPassed,
    failedToolCalls: summary.failedToolCalls,
    activeDurationMs: summary.activeDurationMs,
    modelRequests: summary.modelRequests,
    modelCalls: summary.modelCalls,
    toolCalls: summary.toolCalls,
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    cachedPromptTokens: summary.cachedPromptTokens,
    cacheHitRatio: summary.cacheHitRatio,
    estimatedCostUsd: summary.estimatedCostUsd,
  }
  same(`${path} benchmark`, evidence.benchmark, expectedBenchmark)
  same(`${path} task scores`, evidence.taskScores, source.tasks.map((task: JsonRecord) => ({ name: task.name, score: task.qualityScore })))
  const visual = source.tasks.find((task: JsonRecord) => task.name === 'natural_visual_reconstruction')
  truthy(`${path} visual task exists`, visual)
  const open = visual.toolTrace
    .map((entry: JsonRecord) => entry.call)
    .find((call: JsonRecord) => call?.name === 'browser' && call.arguments?.action === 'open')
  truthy(`${path} visual viewport recorded`, open)
  same(`${path} visual reconstruction`, evidence.visualReconstruction, {
    passed: visual.passed,
    qualityScore: visual.qualityScore,
    activeDurationMs: visual.usage.activeDurationMs,
    modelRequests: visual.usage.modelRequests,
    modelCalls: visual.usage.modelCalls,
    toolCalls: visual.usage.toolCalls,
    failedTools: visual.failedTools.length,
    estimatedCostUsd: visual.usage.estimatedCostUsd,
    viewport: { width: open?.arguments?.width, height: open?.arguments?.height },
    dimensionEqual: visual.visualSimilarity.dimensionEqual,
    pixelSimilarity: visual.visualSimilarity.pixelSimilarity,
    meanAbsoluteError: visual.visualSimilarity.meanAbsoluteError,
    changedRatio: visual.visualSimilarity.changedRatio,
    semanticEditableHtml: Boolean(visual.htmlArtifactText?.includes('<!DOCTYPE html>')),
    interactionVerified: visual.browserEvidence.rangeInteraction,
  })
  same(`${path} fingerprint schema`, evidence.provenance.implementationFingerprintSchemaVersion, source.implementationFingerprint.schemaVersion)
  same(`${path} fingerprint sha`, evidence.provenance.implementationFingerprintSha256, source.implementationFingerprint.aggregateSha256)
  same(`${path} fingerprint files`, evidence.provenance.implementationFingerprintFileCount, Object.keys(source.implementationFingerprint.files).length)
  for (const [relativePath, expected] of Object.entries(source.implementationFingerprint.files) as Array<[string, JsonRecord]>) {
    const currentPath = absolute(relativePath)
    truthy(`${path} fingerprint file ${relativePath}`, existsSync(currentPath))
    if (!existsSync(currentPath)) continue
    const current = readFileSync(currentPath)
    same(`${path} current bytes ${relativePath}`, current.length, expected.bytes)
    same(`${path} current sha ${relativePath}`, createHash('sha256').update(current).digest('hex'), expected.sha256)
    verifiedFingerprintFileCount += 1
  }
  same(`${path} Arena parity`, evidence.scope.arenaParityEvidence, source.arenaParityEvidence)
  same(`${path} mobile`, evidence.scope.mobileExcluded, source.mobileExcluded)
}

function verifyUiCoverage(): void {
  const path = 'evidence/ui-state-coverage-summary.json'
  const evidence = readJson(path)
  verifyEvidenceEnvelope(path, evidence, 'desktop-ui-state-coverage')
  const source = verifyStandardProvenance(path, evidence)

  same(`${path} source schema`, evidence.sourceSchemaVersion, source.schemaVersion)
  same(`${path} result`, evidence.result, {
    passed: source.passed,
    stateCount: source.stateCount,
    captureCount: source.screenshots.length,
    consoleErrorCount: source.consoleErrors.length,
    horizontalOverflowCount: source.horizontalOverflows.length,
    outerShellVerticalOverflowCount: source.verticalOverflows.length,
    taskReviewInteractionCount: source.taskReviewInteractions.length,
    taskCompletionInteractionCount: source.taskCompletionInteractions.length,
  })
  same(`${path} interactions`, evidence.interactionGates, {
    taskReviewOptimisticRollback: source.taskReviewOptimisticRollback,
    taskCompletionOptimisticRollback: source.taskCompletionOptimisticRollback,
    taskCompletionThankYou: source.taskCompletionThankYou,
    customFeedbackArenaTransport: source.customFeedbackArenaTransport,
    undoFailureAndCompaction: source.undoFailureAndCompaction,
    conversationFollowAllChecks: Object.values(source.conversationFollowInteractions).every(Boolean),
    currentBashAutoExpanded: source.executionLogInteraction.currentBashAutoExpanded,
    streamingWriteTailAndWorkspaceBytes: source.streamingWriteInteraction.visibleTailLines > 0 && source.streamingWriteInteraction.workspaceBytesMatchUtf8,
    streamingWriteTimelineByteBadgeAbsent: source.streamingWriteInteraction.timelineByteBadgeAbsent,
    dockedPreviewOpened: source.workspaceFileInteraction.dockedPreviewOpened,
    hitlPersistedAfterRefresh: source.hitlInteraction.persistedAfterRefresh,
    workspacePersistencePersistedAfterRefresh: source.workspacePersistenceInteraction.persistedAfterRefresh,
    saveAnimationReplayedAfterRefresh: source.workspacePersistenceInteraction.saveAnimationReplayedAfterRefresh,
    undoDurableExactlyOnce: source.undoInteraction.durableExactlyOnce,
  })
  same(`${path} screenshot attestation count`, source.screenshotAttestations.length, source.screenshots.length)
  same(`${path} screenshot attestation paths`, source.screenshotAttestations.map((item: JsonRecord) => item.path), source.screenshots)
  same(`${path} screenshot evidence`, evidence.screenshotEvidence, {
    count: source.screenshotAttestations.length,
    bytesAndSha256Verified: true,
  })
  for (const screenshot of source.screenshotAttestations as JsonRecord[]) {
    verifyArtifact(
      path,
      `${dirname(evidence.provenance.source)}/${screenshot.path}`,
      screenshot.bytes,
      screenshot.sha256,
    )
  }
  same(`${path} fingerprint schema`, evidence.provenance.implementationFingerprintSchemaVersion, source.implementationFingerprint.schemaVersion)
  same(`${path} fingerprint sha`, evidence.provenance.implementationFingerprintSha256, source.implementationFingerprint.aggregateSha256)
  same(`${path} fingerprint files`, evidence.provenance.implementationFingerprintFileCount, Object.keys(source.implementationFingerprint.files).length)
  for (const [relativePath, expected] of Object.entries(source.implementationFingerprint.files) as Array<[string, JsonRecord]>) {
    const currentPath = absolute(relativePath)
    truthy(`${path} fingerprint file ${relativePath}`, existsSync(currentPath))
    if (!existsSync(currentPath)) continue
    const current = readFileSync(currentPath)
    same(`${path} current bytes ${relativePath}`, current.length, expected.bytes)
    same(`${path} current sha ${relativePath}`, createHash('sha256').update(current).digest('hex'), expected.sha256)
    verifiedFingerprintFileCount += 1
  }
  same(`${path} desktop scope`, evidence.scope.visualScope, 'desktop')
  same(`${path} mobile`, evidence.scope.mobileExcluded, true)
  same(`${path} Arena screenshot`, evidence.scope.arenaScreenshotIncluded, false)
  same(`${path} pixel parity`, evidence.scope.arenaPixelParityEvidence, false)
  truthy(`${path} covered surfaces`, evidence.coveredSurfaces.length >= 10)
}

function slugifyHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

function verifyMarkdownLinks(path: string): void {
  const markdown = readText(path)
  const headings = new Set([...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slugifyHeading(match[1])))
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1]
    if (/^https?:\/\//.test(href)) continue
    if (href.startsWith('#')) {
      truthy(`${path} anchor ${href}`, headings.has(decodeURIComponent(href.slice(1))))
      continue
    }
    const relativeTarget = href.split('#')[0]
    truthy(`${path} link ${href}`, existsSync(resolve(dirname(absolute(path)), relativeTarget)))
  }
}

function verifyPublishedDocs(): void {
  verifyMarkdownLinks('README.md')
  verifyMarkdownLinks('evidence/README.md')
  const currentEvidenceDocs = [
    'REPLICATION_REPORT.md',
    'FIDELITY_AUDIT.md',
    'AGENT_HARNESS_CAPABILITY_MATRIX.md',
    'evidence/arena-video-audit-summary.md',
  ]
  for (const path of currentEvidenceDocs) {
    const lines = readText(path).split('\n')
    for (const [index, line] of lines.entries()) {
      if (!line.includes('html-slides-live-summary.json')) continue
      same(`${path}:${index + 1} stale canary model calls`, /\b11 model calls\b/.test(line), false)
    }
  }
  truthy('README latest Vision call count', readText('README.md').includes('最新任务 2/2 calls'))
}

verifyCorpus()
verifyHarnessConvergence()
verifyHtmlSlides()
verifyVision()
verifyWebProviders()
verifyPublicContract()
verifyQualityBenchmark()
verifyUiCoverage()
verifyPublishedDocs()

if (failures.length > 0) {
  console.error(`Public evidence integrity: FAIL (${failures.length} issue${failures.length === 1 ? '' : 's'})`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`Public evidence integrity: PASS (${assertionCount} assertions, 8 summaries, ${verifiedSourceCount} immutable sources, ${verifiedFingerprintFileCount} fingerprinted implementation files, ${verifiedArtifactCount} artifact files)`)
}
