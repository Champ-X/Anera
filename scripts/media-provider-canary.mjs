import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseBuffer } from 'music-metadata'

const projectRoot = resolve(process.cwd())
const reportDirectory = resolve(process.env.ANERA_CANARY_REPORT_DIR || 'reports/production-canaries')
const generatedAt = new Date().toISOString()
const reportPath = resolve(reportDirectory, `media-providers-${generatedAt.replaceAll(':', '-')}.json`)

if (process.argv[2] === '--reconcile') {
  await reconcileExistingReport(process.argv[3])
  process.exit()
}

// Local billing reconciliation above is free. New image/voice generation has
// no shared write-ahead authorization and cannot opt into an unmetered run.
await import('./legacy-live-test-disabled.mjs')

const dataRoot = await mkdtemp(resolve(tmpdir(), 'anera-real-media-canary-'))

let secretValues = []
let report

try {
  const [{ config }, { SessionStore }, { ToolExecutor }, { imageDimensions }] = await Promise.all([
    import(pathToFileURL(resolve(projectRoot, 'dist-server/server/config.js')).href),
    import(pathToFileURL(resolve(projectRoot, 'dist-server/server/session-store.js')).href),
    import(pathToFileURL(resolve(projectRoot, 'dist-server/server/tools.js')).href),
    import(pathToFileURL(resolve(projectRoot, 'dist-server/server/vision.js')).href),
  ])
  secretValues = [config.pexelsApiKey, config.imageApiKey].filter((value) => typeof value === 'string' && value.length >= 6)
  const imageOrigin = safePublicProviderOrigin(config.imageBaseUrl)
  const pexelsConfigured = Boolean(config.pexelsApiKey)
  const imageSpeechConfigured = Boolean(config.imageApiKey)
  const actualBilledUsd = optionalNonNegativeNumber('ANERA_MEDIA_CANARY_ACTUAL_BILLED_USD')
  const billingToleranceUsd = optionalNonNegativeNumber('ANERA_MEDIA_CANARY_BILLING_TOLERANCE_USD') ?? 0.02
  const checks = []
  const providerCosts = []

  report = {
    schemaVersion: 'anera-production-media-canary/1.0',
    generatedAt,
    execution: 'production ToolExecutor with real external providers and no injected fetch implementation',
    fixturePolicy: 'forbidden',
    mobileExcluded: true,
    arenaParityGate: 'paused',
    configuration: {
      pexels: {
        configured: pexelsConfigured,
        provider: 'Pexels',
        apiOrigin: 'https://api.pexels.com',
      },
      image: {
        configured: imageSpeechConfigured,
        providerOrigin: imageOrigin.origin,
        model: config.imageModel,
      },
      speech: {
        configured: imageSpeechConfigured,
        providerOrigin: imageOrigin.origin,
        model: config.speechModel,
        usageAuthority: 'estimated; the binary Speech API does not return authoritative token usage',
      },
    },
    checks,
  }

  if (!imageOrigin.valid) {
    checks.push(failedCheck('provider_origin', imageOrigin.reason))
  }

  const store = new SessionStore(dataRoot, 'media-provider-canary')
  await store.initialize()
  const session = await store.create()
  const sessionId = session.summary.id
  const auditionEvidence = []
  let selectedVoiceId

  // Do not pass fetch, provider keys, base URLs, or provider models here. The
  // canary intentionally consumes the exact production configuration and the
  // process-global network implementation used by the real ToolExecutor.
  const executor = new ToolExecutor(
    store,
    {},
    {},
    { inspect: async () => { throw new Error('Vision is outside the media-provider canary') } },
    async () => false,
    {
      requestHumanInput: async (_context, request) => {
        if (request.kind !== 'add_voice') throw new Error(`Unexpected HITL request: ${request.kind}`)
        const candidates = Array.isArray(request.payload.candidates) ? request.payload.candidates : []
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== 'object' || typeof candidate.path !== 'string') {
            throw new Error('Voice audition candidate did not include a physical audio path')
          }
          const audio = await readFile(resolve(store.workspaceDir(sessionId), candidate.path))
          auditionEvidence.push(await audioEvidence(audio, candidate.path))
        }
        const first = candidates[0]
        if (!first || typeof first !== 'object' || typeof first.id !== 'string') {
          throw new Error('Voice audition did not return a selectable candidate')
        }
        return { status: 'selected', candidate_id: first.id }
      },
    },
  )

  const context = (callId) => ({
    sessionId,
    turnId: 'turn_media_provider_canary',
    stepId: `step_${callId}`,
    callId,
    signal: new AbortController().signal,
  })

  if (!pexelsConfigured) {
    checks.push(blockedCheck('pexels_search', ['PEXELS_API_KEY']))
    checks.push(blockedCheck('pexels_download', ['PEXELS_API_KEY']))
  } else {
    await captureCheck(checks, 'pexels_search', async () => {
      const result = await timedExecute(executor, {
        id: 'call_pexels_search',
        name: 'fetch_media',
        arguments: {
          query: 'ocean waves', media_type: 'both', count: 2,
          orientation: 'landscape', size: 'medium', locale: 'en-US',
        },
      }, context('call_pexels_search'))
      const payload = successfulPayload(result)
      const results = Array.isArray(payload.results) ? payload.results : []
      if (results.length < 2) throw new Error(`Pexels returned ${results.length} results; expected at least 2`)
      if (!results.some((item) => item?.type === 'image') || !results.some((item) => item?.type === 'video')) {
        throw new Error('Pexels both-mode did not return at least one image and one video')
      }
      if (results.some((item) => typeof item?.pexelsUrl !== 'string' || typeof item?.creator !== 'string')) {
        throw new Error('Pexels result attribution is incomplete')
      }
      return {
        provider: 'Pexels',
        providerCalls: 2,
        latencyMs: result.latencyMs,
        resultCount: results.length,
        types: results.map((item) => item.type),
        attribution: results.map((item) => ({ id: item.id, creator: item.creator, sourceUrl: item.pexelsUrl })),
      }
    })

    await captureCheck(checks, 'pexels_download', async () => {
      const result = await timedExecute(executor, {
        id: 'call_pexels_download',
        name: 'image_search',
        arguments: { query: 'blue ocean horizon', count: 1 },
      }, context('call_pexels_download'))
      const payload = successfulPayload(result)
      const saved = Array.isArray(payload.results) ? payload.results[0] : undefined
      if (!saved || typeof saved.file_path !== 'string') throw new Error('Pexels image_search did not save an image')
      const file = await imageEvidence(await readFile(resolve(store.workspaceDir(sessionId), saved.file_path)), saved.file_path, imageDimensions)
      return {
        provider: 'Pexels',
        providerCalls: 2,
        latencyMs: result.latencyMs,
        sourceUrl: saved.source_url,
        file,
      }
    })
  }

  if (!imageSpeechConfigured) {
    checks.push(blockedCheck('image_generation', ['ANERA_IMAGE_API_KEY or OPENAI_API_KEY']))
    checks.push(blockedCheck('voice_audition', ['ANERA_IMAGE_API_KEY or OPENAI_API_KEY']))
    checks.push(blockedCheck('speech_generation', ['ANERA_IMAGE_API_KEY or OPENAI_API_KEY']))
  } else if (imageOrigin.valid) {
    await captureCheck(checks, 'image_generation', async () => {
      const result = await timedExecute(executor, {
        id: 'call_image_generation',
        name: 'generate_image',
        arguments: {
          file_path: 'canary/generated-ocean.png',
          prompt: 'A simple flat icon of one blue ocean wave on a white background, no text.',
        },
      }, context('call_image_generation'))
      const payload = successfulPayload(result)
      if (typeof payload.file_path !== 'string') throw new Error('Image generation omitted file_path')
      if (!result.modelUsage) throw new Error('Image provider response omitted authoritative usage')
      const file = await imageEvidence(await readFile(resolve(store.workspaceDir(sessionId), payload.file_path)), payload.file_path, imageDimensions)
      const estimatedCostUsd = tokenCost(
        result.modelUsage,
        config.imageGenerationInputCostPerMillionUsd,
        config.imageGenerationOutputCostPerMillionUsd,
      )
      providerCosts.push({ check: 'image_generation', estimatedCostUsd })
      return {
        providerOrigin: imageOrigin.origin,
        model: config.imageModel,
        providerCalls: result.modelCallCount ?? 1,
        latencyMs: result.latencyMs,
        usage: result.modelUsage,
        pricingUsdPerMillionTokens: {
          input: config.imageGenerationInputCostPerMillionUsd,
          output: config.imageGenerationOutputCostPerMillionUsd,
        },
        estimatedCostUsd,
        file,
      }
    })

    const audition = await captureCheck(checks, 'voice_audition', async () => {
      const result = await timedExecute(executor, {
        id: 'call_voice_audition',
        name: 'add_voice',
        arguments: {
          language: 'en-US',
          text: 'Anera verifies clear speech, steady pacing, and a natural voice for this production canary.',
          voice_identity: { index: 0 },
        },
      }, context('call_voice_audition'))
      const payload = successfulPayload(result)
      if (typeof payload.voice_id !== 'string') throw new Error('Voice audition omitted voice_id')
      if (!result.speechUsage || result.speechUsage.providerCalls !== 2) {
        throw new Error('Voice audition did not meter exactly two provider calls')
      }
      if (auditionEvidence.length !== 2 || auditionEvidence.some((item) => item.bytes <= 0 || item.durationMs <= 0)) {
        throw new Error('Voice audition did not produce two valid physical audio files')
      }
      selectedVoiceId = payload.voice_id
      const estimatedCostUsd = speechCost(result.speechUsage, result.modelUsage, config)
      providerCosts.push({ check: 'voice_audition', estimatedCostUsd })
      return {
        providerOrigin: imageOrigin.origin,
        model: config.speechModel,
        providerCalls: result.speechUsage.providerCalls,
        latencyMs: result.latencyMs,
        metering: result.speechUsage,
        estimatedUsage: result.modelUsage,
        estimationMethod: result.speechUsage.estimationMethod,
        estimatedCostUsd,
        candidates: auditionEvidence,
        selectedIndex: payload.selected_index,
      }
    })

    if (!audition.ok || !selectedVoiceId) {
      checks.push({ name: 'speech_generation', status: 'blocked_dependency', dependency: 'voice_audition' })
    } else {
      await captureCheck(checks, 'speech_generation', async () => {
        const result = await timedExecute(executor, {
          id: 'call_speech_generation',
          name: 'generate_speech',
          arguments: {
            file_path: 'canary/final-speech.mp3',
            text: 'The Anera production media canary completed successfully.',
            voice_id: selectedVoiceId,
            language: 'en-US',
          },
        }, context('call_speech_generation'))
        const payload = successfulPayload(result)
        if (typeof payload.file_path !== 'string') throw new Error('Speech generation omitted file_path')
        if (!result.speechUsage || result.speechUsage.providerCalls !== 1) {
          throw new Error('Speech generation did not meter exactly one provider call')
        }
        const file = await audioEvidence(await readFile(resolve(store.workspaceDir(sessionId), payload.file_path)), payload.file_path)
        if (file.bytes !== result.speechUsage.deliveredAudioBytes) {
          throw new Error('Speech metering bytes do not match the delivered physical file')
        }
        const estimatedCostUsd = speechCost(result.speechUsage, result.modelUsage, config)
        providerCosts.push({ check: 'speech_generation', estimatedCostUsd })
        return {
          providerOrigin: imageOrigin.origin,
          model: config.speechModel,
          providerCalls: result.speechUsage.providerCalls,
          latencyMs: result.latencyMs,
          metering: result.speechUsage,
          estimatedUsage: result.modelUsage,
          estimationMethod: result.speechUsage.estimationMethod,
          estimatedCostUsd,
          file,
        }
      })
    }
  }

  const failed = checks.filter((check) => check.status === 'failed')
  const blocked = checks.filter((check) => check.status.startsWith('blocked'))
  const expectedChecks = ['pexels_search', 'pexels_download', 'image_generation', 'voice_audition', 'speech_generation']
  const providerExecutionPassed = failed.length === 0
    && blocked.length === 0
    && expectedChecks.every((name) => checks.some((check) => check.name === name && check.status === 'passed'))
  const estimatedProviderCostUsd = providerCosts.reduce((total, entry) => total + entry.estimatedCostUsd, 0)
  const billingReconciliation = reconcileBilling(actualBilledUsd, estimatedProviderCostUsd, billingToleranceUsd)
  const releaseGatePassed = providerExecutionPassed && billingReconciliation.status === 'matched'

  Object.assign(report, {
    sessionId,
    providerExecutionPassed,
    estimatedProviderCostUsd,
    providerCostBreakdown: providerCosts,
    billingReconciliation,
    releaseGatePassed,
    outcome: failed.length > 0
      ? 'failed'
      : blocked.length > 0
        ? 'blocked_configuration'
        : releaseGatePassed
          ? 'passed'
          : 'provider_checks_passed_billing_pending',
  })
} catch (error) {
  report = {
    schemaVersion: 'anera-production-media-canary/1.0',
    generatedAt,
    execution: 'production ToolExecutor with real external providers and no injected fetch implementation',
    fixturePolicy: 'forbidden',
    mobileExcluded: true,
    arenaParityGate: 'paused',
    providerExecutionPassed: false,
    releaseGatePassed: false,
    outcome: 'failed',
    fatalError: redact(error instanceof Error ? error.stack || error.message : String(error)),
  }
} finally {
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await rm(dataRoot, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`)
if (report.outcome === 'failed') process.exitCode = 1
else if (report.outcome === 'blocked_configuration') process.exitCode = 2
else if (!report.releaseGatePassed) process.exitCode = 3

async function captureCheck(checks, name, operation) {
  try {
    const evidence = await operation()
    const check = { name, status: 'passed', ...evidence }
    checks.push(check)
    return { ok: true, check }
  } catch (error) {
    const check = failedCheck(name, error instanceof Error ? error.message : String(error))
    checks.push(check)
    return { ok: false, check }
  }
}

async function timedExecute(executor, call, context) {
  const started = performance.now()
  const result = await executor.execute(call, context)
  return { ...result, latencyMs: Math.round((performance.now() - started) * 1000) / 1000 }
}

function successfulPayload(result) {
  let payload
  try {
    payload = JSON.parse(result.content)
  } catch {
    throw new Error('Tool returned non-JSON output')
  }
  if (result.isError || !payload || !['success', 'completed'].includes(payload.status)) {
    throw new Error(typeof payload?.message === 'string' ? payload.message : typeof payload?.error === 'string' ? payload.error : 'Tool failed')
  }
  return payload
}

function blockedCheck(name, missingEnvironment) {
  return { name, status: 'blocked_configuration', missingEnvironment }
}

function failedCheck(name, error) {
  return { name, status: 'failed', error: redact(String(error)) }
}

function redact(value) {
  let sanitized = value.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1<redacted>')
  for (const secret of secretValues) sanitized = sanitized.split(secret).join('<redacted>')
  return sanitized
}

function safePublicProviderOrigin(rawUrl) {
  try {
    const url = new URL(rawUrl)
    const hostname = url.hostname.toLowerCase()
    if (url.protocol !== 'https:') return { valid: false, origin: url.origin, reason: 'Image/speech provider origin must use HTTPS' }
    if (url.username || url.password) return { valid: false, origin: url.origin, reason: 'Provider URL must not embed credentials' }
    if (
      hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1'
      || hostname.startsWith('127.') || hostname.endsWith('.localhost')
      || hostname.endsWith('.test') || hostname.endsWith('.invalid') || hostname.endsWith('.example')
    ) return { valid: false, origin: url.origin, reason: 'Fixture, loopback, and reserved provider origins are forbidden' }
    return { valid: true, origin: url.origin }
  } catch {
    return { valid: false, origin: null, reason: 'Image/speech provider URL is invalid' }
  }
}

async function imageEvidence(bytes, path, dimensionsParser) {
  const extension = extname(path).toLowerCase()
  const mime = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8
      ? 'image/jpeg'
      : undefined
  if (!mime) throw new Error(`Physical image ${path} is not PNG or JPEG`)
  if ((extension === '.png' && mime !== 'image/png') || (['.jpg', '.jpeg'].includes(extension) && mime !== 'image/jpeg')) {
    throw new Error(`Physical image signature does not match ${extension}`)
  }
  const dimensions = dimensionsParser(bytes, mime)
  if (!dimensions.width || !dimensions.height) throw new Error(`Physical image ${path} has no parseable dimensions`)
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mime,
    width: dimensions.width,
    height: dimensions.height,
  }
}

async function audioEvidence(bytes, path) {
  const metadata = await parseBuffer(
    Uint8Array.from(bytes),
    { mimeType: 'audio/mpeg', size: bytes.byteLength },
    { duration: true, skipCovers: true },
  )
  const duration = metadata.format.duration
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Physical audio ${path} has no measurable duration`)
  const info = await statBuffer(bytes)
  return {
    path,
    bytes: info.bytes,
    sha256: info.sha256,
    mime: 'audio/mpeg',
    container: metadata.format.container || null,
    codec: metadata.format.codec || null,
    durationMs: Math.max(1, Math.round(duration * 1000)),
  }
}

async function statBuffer(bytes) {
  // Keep the helper asynchronous so evidence extraction has one consistent
  // call shape for file-backed and parser-backed validations.
  await Promise.resolve()
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function tokenCost(usage, inputRate, outputRate) {
  const uncached = Math.max(0, usage.promptTokens - usage.cachedPromptTokens)
  return (uncached * inputRate + usage.completionTokens * outputRate) / 1_000_000
}

function speechCost(metering, usage, config) {
  if (config.speechCharacterCostPerMillionUsd > 0) {
    return (metering.inputCharacters * config.speechCharacterCostPerMillionUsd) / 1_000_000
  }
  if (!usage) throw new Error('Speech metering omitted its explicit token estimate')
  return tokenCost(usage, config.speechInputCostPerMillionUsd, config.speechOutputCostPerMillionUsd)
}

function optionalNonNegativeNumber(name) {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`)
  return parsed
}

function reconcileBilling(actualBilledUsd, estimatedUsd, toleranceUsd) {
  if (actualBilledUsd === undefined) {
    return {
      status: 'pending_external_statement',
      inputEnvironment: 'ANERA_MEDIA_CANARY_ACTUAL_BILLED_USD',
      estimatedUsd,
      toleranceUsd,
      note: 'Provider execution can pass without this value, but the production release gate cannot.',
    }
  }
  const absoluteDifferenceUsd = Math.abs(actualBilledUsd - estimatedUsd)
  return {
    status: absoluteDifferenceUsd <= toleranceUsd ? 'matched' : 'mismatched',
    actualBilledUsd,
    estimatedUsd,
    absoluteDifferenceUsd,
    toleranceUsd,
  }
}

async function reconcileExistingReport(rawSourcePath) {
  if (!rawSourcePath) throw new Error('Pass the provider report path after --reconcile')
  const sourcePath = resolve(rawSourcePath)
  const sourceBytes = await readFile(sourcePath)
  const source = JSON.parse(sourceBytes.toString('utf8'))
  if (
    source.schemaVersion !== 'anera-production-media-canary/1.0'
    || source.fixturePolicy !== 'forbidden'
    || source.providerExecutionPassed !== true
    || typeof source.estimatedProviderCostUsd !== 'number'
  ) throw new Error('Source report is not a successful non-fixture media provider execution report')
  const actualBilledUsd = optionalNonNegativeNumber('ANERA_MEDIA_CANARY_ACTUAL_BILLED_USD')
  if (actualBilledUsd === undefined) throw new Error('ANERA_MEDIA_CANARY_ACTUAL_BILLED_USD is required for reconciliation')
  const toleranceUsd = optionalNonNegativeNumber('ANERA_MEDIA_CANARY_BILLING_TOLERANCE_USD') ?? 0.02
  const billingReconciliation = reconcileBilling(actualBilledUsd, source.estimatedProviderCostUsd, toleranceUsd)
  const releaseGatePassed = billingReconciliation.status === 'matched'
  const reconciliation = {
    schemaVersion: 'anera-production-media-billing-reconciliation/1.0',
    generatedAt,
    fixturePolicy: 'forbidden',
    providerCallsPerformed: false,
    sourceReport: sourcePath,
    sourceReportSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    sourceGeneratedAt: source.generatedAt,
    providerExecutionPassed: true,
    billingReconciliation,
    releaseGatePassed,
    outcome: releaseGatePassed ? 'passed' : 'failed',
  }
  const reconciliationPath = resolve(reportDirectory, `media-billing-reconciliation-${generatedAt.replaceAll(':', '-')}.json`)
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(reconciliationPath, `${JSON.stringify(reconciliation, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ reportPath: reconciliationPath, ...reconciliation }, null, 2)}\n`)
  if (!releaseGatePassed) process.exitCode = 1
}
