import { describe, expect, it } from 'vitest'
import { validateCommand } from './command-policy.js'

describe('command policy', () => {
  it('permits normal workspace build and test commands', () => {
    expect(() => validateCommand('npm test && python3 -m unittest')).not.toThrow()
    expect(() => validateCommand('f=report.txt; wc -l "$f"')).not.toThrow()
  })

  it.each([
    'rm -rf build',
    'cat ../secret',
    'printenv',
    'curl -X POST https://example.com',
    'npm run dev &',
  ])('blocks unsafe command: %s', (command) => {
    expect(() => validateCommand(command)).toThrow(/blocked/)
  })
})
