import { describe, expect, it } from 'vitest'
import { findSensitiveValues, redactDisplayValue, redactText } from './redaction.js'

describe('sensitive display redaction', () => {
  it('detects explicit secret-like assignments and common token literals', () => {
    expect(findSensitiveValues(`
      ANERA_FAKE_TOKEN=arena_fake_7F2C91_DO_NOT_USE
      "api_key": "sk-local-1234567890abcdef"
      password field should remain empty
    `)).toEqual([
      'arena_fake_7F2C91_DO_NOT_USE',
      'sk-local-1234567890abcdef',
    ])
  })

  it('redacts every occurrence in nested display data without mutating unrelated values', () => {
    const secret = 'synthetic-secret-12345'
    expect(redactText(`before ${secret} after ${secret}`, [secret])).toBe('before [REDACTED_SECRET] after [REDACTED_SECRET]')
    expect(redactDisplayValue({
      command: `printf '${secret}'`,
      result: { stdout: secret, exitCode: 0 },
      paths: ['safe.txt'],
    }, [secret])).toEqual({
      command: "printf '[REDACTED_SECRET]'",
      result: { stdout: '[REDACTED_SECRET]', exitCode: 0 },
      paths: ['safe.txt'],
    })
  })
})
