import { describe, expect, it } from 'vitest'
import { agentModelOption, resolveAgentModels } from './agent-models.js'

describe('provider-owned agent model catalog', () => {
  it('offers current official IDs and prefers canonical Flash over its retired alias', () => {
    expect(resolveAgentModels('deepseek-v4-flash', '', 'https://api.deepseek.com/v1'))
      .toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(agentModelOption('deepseek-flash').displayName).toBe('DeepSeek V4.1 Flash')
    expect(agentModelOption('deepseek-v4-pro').description).toContain('2026-09-14')
  })
  it('preserves explicit allowlists and custom providers without adding vendor assumptions', () => {
    expect(resolveAgentModels('custom', ' custom, second,second ', 'https://api.deepseek.com')).toEqual(['custom', 'second'])
    expect(resolveAgentModels('custom', '', 'https://other.example/v1')).toEqual(['custom'])
    expect(resolveAgentModels('custom', '', 'https://api.deepseek.com.other.example')).toEqual(['custom'])
    expect(agentModelOption('model-beta')).toEqual({ id: 'model-beta', publicName: 'model-beta', displayName: 'Model Beta' })
  })
})
