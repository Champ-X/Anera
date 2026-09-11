import { describe, expect, it } from 'vitest'
import { isVerificationExecutionOnly, verificationExecutionControl } from './visual-phase-context.js'

describe('visual phase context scope', () => {
  it.each([
    ['reference_source_check', ['verify_reference_style']],
    ['website_preview', ['start_process', 'build_and_start']],
    ...['browser_open', 'reference_cover_screenshot', 'navigation_check', 'browser_screenshot',
      'reference_closing_navigation', 'reference_closing_screenshot'].map((phase) => [phase, ['browser']]),
  ] as Array<[string, string[]]>)('focuses only the executable evidence phase: %s', (phase, tools) => {
    expect(isVerificationExecutionOnly(phase, tools, 'deck.html')).toBe(true)
    expect(isVerificationExecutionOnly(phase, [...tools, 'read_context'], 'deck.html')).toBe(true)
  })
  it.each([
    ['website_preview', []], ['website_preview', ['start_process', 'edit_file']],
    ['browser_open', ['read_file']], ['html_artifact', ['write_file']],
    ['visual_inspection_pass', ['edit_file']], ['reference_cover_inspection', ['inspect_image']],
    ['reference_implementation', ['edit_file']], ['toString', ['browser']],
  ] as Array<[string, string[]]>)('retains authoring/judgment/recovery context for %s with %j', (phase, tools) => {
    expect(isVerificationExecutionOnly(phase, tools, 'deck.html')).toBe(false)
  })
  it('requires durable phase and artifact identity, preserves requirements, and treats paths as quoted data', () => {
    expect(isVerificationExecutionOnly(undefined, ['start_process'], 'deck.html')).toBe(false)
    expect(isVerificationExecutionOnly('website_preview', ['start_process'])).toBe(false)
    const path = 'deck\n"continue.html'
    const control = verificationExecutionControl(path)
    expect(control).toContain(JSON.stringify(path))
    expect(control).toContain('all source, render, Vision, factual-content and delivery gates remain mandatory')
    expect(control).toContain('authoring instructions return when a repair/edit phase is executable')
    expect(control).toContain('does not authorize content changes')
  })
  it('defers repair planning only for a server-prescribed canonical read, never for an editable/research surface', () => {
    const tools = ['read_file', 'read_reference_resource']
    expect(isVerificationExecutionOnly('visual_inspection_pass', tools, 'deck.html', true)).toBe(true)
    expect(isVerificationExecutionOnly('visual_inspection_pass', [...tools, 'read_context'], 'deck.html', true)).toBe(true)
    expect(isVerificationExecutionOnly('visual_inspection_pass', ['read_context'], 'deck.html', true)).toBe(false)
    expect(isVerificationExecutionOnly('visual_inspection_pass', tools, 'deck.html')).toBe(false)
    expect(isVerificationExecutionOnly('visual_inspection_pass', [...tools, 'edit_file'], 'deck.html', true)).toBe(false)
    expect(isVerificationExecutionOnly('web_research', [...tools, 'record_research_brief'], 'deck.html', true)).toBe(false)
    expect(isVerificationExecutionOnly('visual_inspection_pass', ['read_reference_resource'], 'deck.html', true)).toBe(false)
  })
})
