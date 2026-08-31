import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import { parseBuffer } from 'music-metadata'
import type { SpeechProviderMetering } from '../shared/types.js'

const execFileAsync = promisify(execFile)
const bundledFfmpegPath: string | null = typeof ffmpegPath === 'string'
  ? ffmpegPath
  : (ffmpegPath as unknown as { default?: string | null }).default ?? null

export type ProviderSpeechFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav'

export interface SpeechFormatPlan {
  extension: string
  providerFormat: ProviderSpeechFormat
  mime: string
  transcode?: 'm4a' | 'aiff'
}

const SPEECH_FORMATS: Record<string, SpeechFormatPlan> = {
  '.mp3': { extension: '.mp3', providerFormat: 'mp3', mime: 'audio/mpeg' },
  '.wav': { extension: '.wav', providerFormat: 'wav', mime: 'audio/wav' },
  '.ogg': { extension: '.ogg', providerFormat: 'opus', mime: 'audio/ogg' },
  '.opus': { extension: '.opus', providerFormat: 'opus', mime: 'audio/ogg' },
  '.flac': { extension: '.flac', providerFormat: 'flac', mime: 'audio/flac' },
  '.aac': { extension: '.aac', providerFormat: 'aac', mime: 'audio/aac' },
  '.m4a': { extension: '.m4a', providerFormat: 'aac', mime: 'audio/mp4', transcode: 'm4a' },
  '.aiff': { extension: '.aiff', providerFormat: 'wav', mime: 'audio/aiff', transcode: 'aiff' },
}

export const SUPPORTED_SPEECH_EXTENSIONS = Object.freeze(Object.keys(SPEECH_FORMATS))

export function speechFormatPlan(filePath: string): SpeechFormatPlan {
  const extension = extname(filePath).toLowerCase()
  const plan = SPEECH_FORMATS[extension]
  if (!plan) {
    throw new Error(`file_path must end in ${SUPPORTED_SPEECH_EXTENSIONS.join(', ')}`)
  }
  return plan
}

export async function normalizeSpeechAudio(
  providerAudio: Buffer,
  plan: SpeechFormatPlan,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ audio: Buffer; durationMs: number }> {
  if (providerAudio.byteLength === 0) throw new Error('Speech generation returned empty audio')
  if (providerAudio.byteLength > maxBytes) throw new Error(`Speech generation exceeded the ${maxBytes}-byte limit`)
  if (signal.aborted) throw signal.reason

  let audio = providerAudio
  if (plan.transcode) audio = await transcodeSpeechAudio(providerAudio, plan, signal, maxBytes)
  if (signal.aborted) throw signal.reason

  let durationSeconds: number | undefined
  try {
    const metadata = await parseBuffer(
      Uint8Array.from(audio),
      { mimeType: plan.mime, size: audio.byteLength },
      { duration: true, skipCovers: true },
    )
    durationSeconds = metadata.format.duration
  } catch (error) {
    throw new Error(`Speech generation returned invalid ${plan.extension} audio`, { cause: error })
  }
  if (!Number.isFinite(durationSeconds) || (durationSeconds ?? 0) <= 0) {
    throw new Error(`Speech generation returned ${plan.extension} audio without a measurable duration`)
  }
  return { audio, durationMs: Math.max(1, Math.round((durationSeconds as number) * 1_000)) }
}

export function speechProviderMetering(
  text: string,
  providerOutputBytes: number,
  deliveredAudioBytes: number,
  audioDurationMs: number,
): SpeechProviderMetering {
  return {
    providerCalls: 1,
    inputCharacters: [...text].length,
    providerOutputBytes,
    deliveredAudioBytes,
    audioDurationMs,
    estimatedTextTokens: estimateSpeechTextTokens(text),
    // Official Realtime guidance describes assistant audio as one token per
    // 50 ms. The binary Speech endpoint does not return usage, so preserve the
    // derivation explicitly instead of presenting it as provider-authoritative.
    estimatedAudioTokens: audioDurationMs > 0 ? Math.ceil(audioDurationMs / 50) : 0,
    estimationMethod: 'text_heuristic_and_50ms_audio_tokens',
  }
}

export function combineSpeechProviderMetering(
  values: readonly SpeechProviderMetering[],
): SpeechProviderMetering | undefined {
  if (values.length === 0) return undefined
  return values.reduce<SpeechProviderMetering>((total, value) => ({
    providerCalls: total.providerCalls + value.providerCalls,
    inputCharacters: total.inputCharacters + value.inputCharacters,
    providerOutputBytes: total.providerOutputBytes + value.providerOutputBytes,
    deliveredAudioBytes: total.deliveredAudioBytes + value.deliveredAudioBytes,
    audioDurationMs: total.audioDurationMs + value.audioDurationMs,
    estimatedTextTokens: total.estimatedTextTokens + value.estimatedTextTokens,
    estimatedAudioTokens: total.estimatedAudioTokens + value.estimatedAudioTokens,
    estimationMethod: 'text_heuristic_and_50ms_audio_tokens',
  }), emptySpeechProviderMetering())
}

export function speechMeteringAsModelUsage(metering: SpeechProviderMetering) {
  return {
    promptTokens: metering.estimatedTextTokens,
    completionTokens: metering.estimatedAudioTokens,
    totalTokens: metering.estimatedTextTokens + metering.estimatedAudioTokens,
    cachedPromptTokens: 0,
  }
}

function emptySpeechProviderMetering(): SpeechProviderMetering {
  return {
    providerCalls: 0,
    inputCharacters: 0,
    providerOutputBytes: 0,
    deliveredAudioBytes: 0,
    audioDurationMs: 0,
    estimatedTextTokens: 0,
    estimatedAudioTokens: 0,
    estimationMethod: 'text_heuristic_and_50ms_audio_tokens',
  }
}

function estimateSpeechTextTokens(text: string): number {
  let asciiCharacters = 0
  let nonAsciiBytes = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x7f) asciiCharacters += 1
    else if (codePoint <= 0x7ff) nonAsciiBytes += 2
    else if (codePoint <= 0xffff) nonAsciiBytes += 3
    else nonAsciiBytes += 4
  }
  return Math.max(1, Math.ceil(asciiCharacters / 4 + nonAsciiBytes / 2))
}

async function transcodeSpeechAudio(
  providerAudio: Buffer,
  plan: SpeechFormatPlan,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Buffer> {
  if (!bundledFfmpegPath) throw new Error(`FFmpeg is unavailable; cannot produce ${plan.extension} audio`)
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'anera-speech-'))
  const inputPath = join(temporaryRoot, `input.${plan.providerFormat}`)
  const outputPath = join(temporaryRoot, `output${plan.extension}`)
  try {
    await writeFile(inputPath, providerAudio)
    const codecArguments = plan.transcode === 'm4a'
      ? ['-vn', '-c:a', 'copy', '-movflags', '+faststart']
      : ['-vn', '-c:a', 'pcm_s16be']
    await execFileAsync(bundledFfmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      ...codecArguments,
      outputPath,
    ], {
      signal,
      timeout: 120_000,
      maxBuffer: 64_000,
      env: { LANG: 'C', PATH: dirname(bundledFfmpegPath) },
    })
    const info = await stat(outputPath)
    if (!info.isFile() || info.size === 0) throw new Error(`FFmpeg produced empty ${plan.extension} audio`)
    if (info.size > maxBytes) throw new Error(`Converted speech exceeded the ${maxBytes}-byte limit`)
    return await readFile(outputPath)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not convert speech to ${plan.extension}: ${detail}`, { cause: error })
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}
