import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import { afterEach, describe, expect, it } from 'vitest'
import {
  combineSpeechProviderMetering,
  normalizeSpeechAudio,
  speechFormatPlan,
  speechMeteringAsModelUsage,
  speechProviderMetering,
  SUPPORTED_SPEECH_EXTENSIONS,
  type ProviderSpeechFormat,
} from './speech.js'

const execFileAsync = promisify(execFile)
const executable = typeof ffmpegPath === 'string'
  ? ffmpegPath
  : (ffmpegPath as unknown as { default?: string | null }).default ?? null
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('speech format and metering', () => {
  it('materializes every Arena-public extension as a real parseable audio container', async () => {
    expect(SUPPORTED_SPEECH_EXTENSIONS).toEqual([
      '.mp3', '.wav', '.ogg', '.opus', '.flac', '.aac', '.m4a', '.aiff',
    ])
    if (!executable) throw new Error('Bundled FFmpeg is unavailable in the test environment')
    const root = await mkdtemp(resolve(tmpdir(), 'anera-speech-formats-'))
    roots.push(root)
    const providerAudio = new Map<ProviderSpeechFormat, Buffer>()
    for (const format of ['mp3', 'opus', 'aac', 'flac', 'wav'] as const) {
      const path = resolve(root, `provider.${format}`)
      await execFileAsync(executable, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.12',
        '-ar', '24000', '-ac', '1',
        path,
      ], {
        timeout: 30_000,
        maxBuffer: 64_000,
        env: { LANG: 'C', PATH: dirname(executable) },
      })
      providerAudio.set(format, await readFile(path))
    }

    for (const extension of SUPPORTED_SPEECH_EXTENSIONS) {
      const plan = speechFormatPlan(`voice${extension}`)
      const source = providerAudio.get(plan.providerFormat)
      if (!source) throw new Error(`Missing ${plan.providerFormat} fixture`)
      const result = await normalizeSpeechAudio(source, plan, new AbortController().signal, 2_000_000)
      expect(result.audio.byteLength, extension).toBeGreaterThan(32)
      expect(result.durationMs, extension).toBeGreaterThan(0)
    }
  }, 30_000)

  it('rejects invalid provider bytes instead of publishing a mislabeled audio artifact', async () => {
    await expect(normalizeSpeechAudio(
      Buffer.from('{"error":"not audio"}'),
      speechFormatPlan('voice.mp3'),
      new AbortController().signal,
      1_000,
    )).rejects.toThrow(/invalid .mp3 audio|measurable duration/)
  })

  it('keeps physical speech measurements distinct from estimated token usage', () => {
    const first = speechProviderMetering('Hello world', 900, 900, 1_230)
    const second = speechProviderMetering('你好', 1_100, 1_250, 2_010)
    const combined = combineSpeechProviderMetering([first, second])
    expect(combined).toEqual({
      providerCalls: 2,
      inputCharacters: 13,
      providerOutputBytes: 2_000,
      deliveredAudioBytes: 2_150,
      audioDurationMs: 3_240,
      estimatedTextTokens: first.estimatedTextTokens + second.estimatedTextTokens,
      estimatedAudioTokens: first.estimatedAudioTokens + second.estimatedAudioTokens,
      estimationMethod: 'text_heuristic_and_50ms_audio_tokens',
    })
    expect(speechMeteringAsModelUsage(combined!)).toEqual({
      promptTokens: combined!.estimatedTextTokens,
      completionTokens: combined!.estimatedAudioTokens,
      totalTokens: combined!.estimatedTextTokens + combined!.estimatedAudioTokens,
      cachedPromptTokens: 0,
    })
  })
})
