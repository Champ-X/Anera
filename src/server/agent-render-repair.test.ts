import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import { visualArtifactDefectRepairPhase } from './agent-service.js'

function toolStep(
  id: string,
  name: string,
  args: Record<string, unknown>,
  result: string,
): ModelMessage[] {
  return [{
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  }, {
    role: 'tool',
    tool_call_id: id,
    tool_result_status: 'succeeded',
    content: result,
  }]
}

describe('deterministic rendered-reference repair routing', () => {
  it('routes a server render mismatch through read then edit even when no Vision defect exists', () => {
    const canonicalPath = 'ai-week.html'
    const canonicalUrl = `http://127.0.0.1:4174/workspace/ses_fixture/preview/${canonicalPath}`
    const base: ModelMessage[] = [
      { role: 'user', content: '制作 HTML Slides，风格严格参考：https://reference.example/template.html' },
      ...toolStep(
        'write',
        'write_file',
        { path: canonicalPath, content: '<!doctype html><html><head></head><body></body></html>' },
        JSON.stringify({ status: 'success', path: canonicalPath, canonical_html: true }),
      ),
      ...toolStep(
        'open',
        'browser',
        { action: 'open', path: canonicalPath },
        JSON.stringify({ status: 'success', url: canonicalUrl }),
      ),
      ...toolStep(
        'shot',
        'browser',
        { action: 'screenshot', screenshot_path: 'reference-cover.png' },
        JSON.stringify({
          status: 'success',
          render_fidelity: 'mismatch',
          render_phase: 'cover',
          render_score: 97.2,
          render_violations: ['render cover .layout-cover position differs'],
        }),
      ),
    ]

    expect(visualArtifactDefectRepairPhase(base, canonicalPath)).toBe('read')

    const afterRead = [
      ...base,
      ...toolStep(
        'read',
        'read_file',
        { path: canonicalPath },
        '<!doctype html><html><head></head><body></body></html>',
      ),
    ]
    expect(visualArtifactDefectRepairPhase(afterRead, canonicalPath)).toBe('edit')
  })
})
