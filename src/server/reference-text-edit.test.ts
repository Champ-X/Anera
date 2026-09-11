import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PINK_SCRIPT_DESIGN_SHA256, PINK_SCRIPT_DESIGN_URL, PINK_SCRIPT_SOURCE_SHA256,
  referenceLanguageText, verifyReferenceLanguageMarkup, type ReferenceLanguageVariant } from './reference-language.js'
import { applyReferenceTextEdit, isCompleteReferenceTextView, readReferenceText } from './reference-text-edit.js'
import { assertAneraRuntimeToolResult, assertArenaActiveToolResult } from './arena-tool-result.js'
import { canonicalDiagnosticReadCursor, compactHistoricalToolPayloads, visualArtifactDefectRepairPhase } from './agent-service.js'
import type { ModelMessage } from '../shared/types.js'
import { validateToolCallArguments } from './tools.js'

// Structural fixture only; actual source provenance is separately established
// by record_reference_style. Do not mistake its synthetic layouts for a source.
const core = { version: 1 as const, adapter: 'pink-script-zh-cn-v1' as const, language: 'zh-CN' as const,
  sourceSha256: PINK_SCRIPT_SOURCE_SHA256, designUrl: PINK_SCRIPT_DESIGN_URL, designSha256: PINK_SCRIPT_DESIGN_SHA256,
  layouts: ['cover', 'content', 'closing'].map((name, index) => ({ variant: `v${index + 1}`, classes: `slide ${name}` })),
  bindings: (['display', 'body', 'label'] as const).map((role, index) => ({ variant: `v${index + 1}`, slot: 't1', path: [0], role })),
}
const language: ReferenceLanguageVariant = { ...core, manifestSha256: createHash('sha256').update(JSON.stringify(core)).digest('hex') }
const copy = '本期覆盖 2026-09-02 至 09-08（Asia/Shanghai）；头条均据所引报道原文。'
const htmlWithCopy = (text: string) => '\uFEFF<!doctype html><html><head><style>.slide{color:pink}</style></head><body>'
  + [0, 1, 1, 2].map((index) => `<section class="${core.layouts[index].classes}" data-anera-cjk-variant="v${index + 1}"><p><a href="https://source.example/article" style="color:inherit;text-decoration:inherit">${referenceLanguageText(text, core.bindings[index])}</a></p></section>`).join('')
  + '<script>window.marker="untouched"</script></body></html>'
const html = htmlWithCopy(copy)
function target() {
  const view = readReferenceText(html, language)
  return { hash: view.hash, language_manifest_sha256: view.language_manifest_sha256, slide_index: 3, slot: 't1', expected_text: copy }
}

describe('hash-bound reference text edits', () => {
  it.each(['124.98', 'Latin & text', '  36.74  '])('reads and edits an unmarked source-bound literal slot %j without changing surrounding bytes', (text) => {
    const original = htmlWithCopy(text)
    const view = readReferenceText(original, language)
    expect(view.slots.map((slot) => slot.text)).toEqual([text, text, text, text])
    const result = applyReferenceTextEdit(original, language, { ...target(), hash: view.hash, expected_text: text }, '18')
    expect(readReferenceText(result, language).slots.map((slot) => slot.text)).toEqual([text, text, '18', text])
    expect(result).toContain('href="https://source.example/article" style="color:inherit;text-decoration:inherit">18</a>')
    expect(result).not.toContain('data-anera-cjk-text')
  })

  it('atomically repairs numeric and mixed-script slots from one hash without reproducing HTML', () => {
    const original = html.replace(referenceLanguageText(copy, core.bindings[0]), '124.98')
    const view = readReferenceText(original, language)
    const edits = [
      { slide_index: 1, slot: 't1', expected_text: '124.98', new_text: '18' },
      { slide_index: 3, slot: 't1', expected_text: copy, new_text: '档期票房124.98亿元(同比增长4.45%)，平均票价约36.74元。' },
    ]
    const result = applyReferenceTextEdit(original, language, {
      hash: view.hash, language_manifest_sha256: view.language_manifest_sha256, edits,
    })
    expect(readReferenceText(result, language).slots.map((slot) => slot.text)).toEqual(['18', copy, edits[1].new_text, copy])
    expect(() => verifyReferenceLanguageMarkup(result, language)).not.toThrow()
    expect(() => applyReferenceTextEdit(original, language, {
      hash: view.hash, language_manifest_sha256: view.language_manifest_sha256,
      edits: [edits[0], { ...edits[1], expected_text: 'stale' }],
    })).toThrow(/expected_text/)
  })

  it('validates exclusive single/batch text modes without accepting mixed raw or incomplete targets', () => {
    const { hash, language_manifest_sha256 } = target()
    const edit = { slide_index: 1, slot: 't1', expected_text: copy, new_text: '短文案' }
    const reference_text = { hash, language_manifest_sha256, edits: [edit, { ...edit, slide_index: 3 }] }
    const validate = (arguments_: Record<string, unknown>) => validateToolCallArguments({ id: 'text-batch', name: 'edit_file', arguments: arguments_ })
    expect(() => validate({ path: 'deck.html', reference_text })).not.toThrow()
    for (const patch of [{ new_text: 'outer' }, { old_text: 'raw' }, { edits: [{ old_text: 'a', new_text: 'b' }, { old_text: 'c', new_text: 'd' }] }]) {
      expect(() => validate({ path: 'deck.html', reference_text, ...patch })).toThrow(/Validation/)
    }
    expect(() => validate({ path: 'deck.html', reference_text: { ...reference_text, slide_index: 1 } })).toThrow(/Validation/)
    expect(() => validate({ path: 'deck.html', reference_text: { hash, language_manifest_sha256 }, new_text: 'incomplete' })).toThrow(/Validation/)
  })

  it('compacts a consumed large text batch without requiring an outer replacement or retaining literal payloads', () => {
    const reference_text = { hash: target().hash, language_manifest_sha256: language.manifestSha256,
      edits: [1, 3].map((slide_index) => ({ slide_index, slot: 't1', expected_text: copy.repeat(50), new_text: '短文案' })) }
    const messages: ModelMessage[] = [
      { role: 'user', content: '制作 HTML Slides。' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'large-text-batch', type: 'function', function: {
        name: 'edit_file', arguments: JSON.stringify({ path: 'deck.html', reference_text }),
      } }] },
      { role: 'tool', tool_call_id: 'large-text-batch', tool_result_status: 'succeeded', content: '{"status":"success","hash":"fixture"}' },
      { role: 'assistant', content: 'Reverify the changed artifact.' },
    ]
    expect(Buffer.byteLength(messages[1].tool_calls![0].function.arguments)).toBeGreaterThan(4_000)
    const compacted = compactHistoricalToolPayloads(messages, { forceResultCompaction: true }).messages[1].tool_calls![0]
    expect(JSON.parse(compacted.function.arguments)._historicalMutation).toMatchObject({ operation: 'edit_file', schema: 'reference_text' })
    expect(compacted.function.arguments).not.toContain(copy)
  })

  it('does not guess among same-parent bindings or literal nodes, or expose executable text', () => {
    const initial = html.replace(referenceLanguageText(copy, core.bindings[0]), '124.98')
    const ambiguousCore = { ...core, bindings: [...core.bindings, { ...core.bindings[0], slot: 't2' }] }
    const ambiguous = { ...ambiguousCore, manifestSha256: createHash('sha256').update(JSON.stringify(ambiguousCore)).digest('hex') }
    expect(readReferenceText(initial, ambiguous).slots.some((slot) => slot.slide_index === 1)).toBe(false)
    const multiple = initial.replace('>124.98</a>', '>124.98</a> extra literal')
    expect(readReferenceText(multiple, language).slots.some((slot) => slot.slide_index === 1)).toBe(false)
    const executable = initial.replace('<p><a href="https://source.example/article" style="color:inherit;text-decoration:inherit">124.98</a></p>',
      '<script>124.98</script>')
    expect(readReferenceText(executable, language).slots.some((slot) => slot.slide_index === 1)).toBe(false)
  })

  it.each(['duplicate', 'one entry', 'too many', 'missing target', 'mixed target', 'outer replacement', 'empty replacement'] as const)
    ('rejects an invalid text batch: %s', (invalid) => {
      const view = readReferenceText(html, language)
      const first = { slide_index: 1, slot: 't1', expected_text: copy, new_text: '短文案' }
      let edits = [first, { ...first, slide_index: 3 }]
      if (invalid === 'duplicate') edits = [first, first]
      if (invalid === 'one entry') edits = [first]
      if (invalid === 'too many') edits = Array.from({ length: 17 }, () => first)
      if (invalid === 'missing target') edits[1] = { ...first, slot: 't99' }
      if (invalid === 'empty replacement') edits[1].new_text = ''
      expect(() => applyReferenceTextEdit(html, language, { hash: view.hash,
        language_manifest_sha256: view.language_manifest_sha256, edits,
        ...(invalid === 'mixed target' ? { slide_index: 1 } : {}),
      }, invalid === 'outer replacement' ? 'outer' : undefined)).toThrow(/Reference text/)
    })

  it('adds an Anera-only result contract without reinterpreting the frozen public read_file shape', () => {
    const view = { status: 'success', path: 'deck.html', ...readReferenceText(html, language) }
    const result = { content: JSON.stringify(view), isError: false }
    expect(() => assertAneraRuntimeToolResult('read_file', result)).not.toThrow()
    expect(() => assertArenaActiveToolResult('read_file', result)).toThrow()
    expect(() => assertAneraRuntimeToolResult('read_file', { ...result, content: JSON.stringify({ ...view, complete: false }) })).toThrow()
  })

  it('routes a complete text read to edit and retains it under compaction, while failed views fall back to raw pagination', () => {
    const step = (id: string, name: string, args: Record<string, unknown>, payload: unknown, failed = false): ModelMessage[] => [
      { role: 'assistant', content: null, reasoning_content: 'Retain original reasoning.', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      { role: 'tool', tool_call_id: id, tool_result_status: failed ? 'failed' : 'succeeded', content: JSON.stringify(payload) },
    ]
    const request: ModelMessage = { role: 'user', content: '制作 HTML Slides。' }
    const largeHtml = htmlWithCopy(copy.repeat(20))
    const largeView = readReferenceText(largeHtml, language)
    const messages = [request, ...step('write', 'write_file', { path: 'deck.html', content: largeHtml }, { status: 'success' }),
      ...step('open', 'browser', { action: 'open', path: 'deck.html' }, { url: 'http://127.0.0.1:8000/deck.html' }),
      ...step('mismatch', 'browser', { action: 'screenshot', screenshot_path: 'closing.png' }, { status: 'success', render_fidelity: 'mismatch', render_phase: 'closing',
        render_score: 99, render_violations: ['text collision between body and footer was absent from the source.'] }),
    ]
    expect(canonicalDiagnosticReadCursor(messages, 'deck.html', true)).toEqual({ path: 'deck.html', view: 'reference_text' })
    expect(visualArtifactDefectRepairPhase(messages, 'deck.html')).toBe('read')
    const read = step('text', 'read_file', { path: 'deck.html', view: 'reference_text' }, { status: 'success', path: 'deck.html', ...largeView })
    expect(Buffer.byteLength(String(read[1].content))).toBeGreaterThan(6_000)
    expect(visualArtifactDefectRepairPhase([...messages, ...read], 'deck.html')).toBe('edit')
    const compacted = compactHistoricalToolPayloads([...messages, ...read, { role: 'assistant', content: 'Repairing the current text slot.' }],
      { forceResultCompaction: true, canonicalPath: 'deck.html' }).messages
    expect(compacted.find((message) => message.tool_call_id === 'text')?.content).toBe(read[1].content)
    expect(visualArtifactDefectRepairPhase(compacted, 'deck.html')).toBe('edit')
    // Only consumed arguments above the existing 4000-byte threshold compact.
    // Keep the production threshold intact and actually exercise that branch.
    const largeTarget = { ...target(), hash: largeView.hash, expected_text: copy.repeat(20) }
    const editedHtml = applyReferenceTextEdit(largeHtml, language, largeTarget, '短文案'.repeat(500))
    const edited = step('edit-text', 'edit_file', { path: 'deck.html', reference_text: largeTarget, new_text: '短文案'.repeat(500) },
      { status: 'success', hash: createHash('sha256').update(editedHtml).digest('base64url') })
    expect(Buffer.byteLength(edited[0].tool_calls![0].function.arguments)).toBeGreaterThan(4_000)
    const consumed = compactHistoricalToolPayloads([...messages, ...read, ...edited, { role: 'assistant', content: 'Reverify the actual current file.' }],
      { forceResultCompaction: true, canonicalPath: 'deck.html' }).messages
    const editCall = consumed.flatMap((message) => message.tool_calls ?? []).find((call) => call.id === 'edit-text')!
    expect(JSON.parse(editCall.function.arguments)._historicalMutation.schema).toBe('reference_text')
    const unavailable = step('unavailable', 'read_file', { path: 'deck.html', view: 'reference_text' }, { status: 'error', message: 'Use ordinary read_file.' }, true)
    expect(canonicalDiagnosticReadCursor([...messages, ...unavailable], 'deck.html', true)).toEqual({ path: 'deck.html', offset: 1, limit: 5_000 })
  })

  it('returns a complete compact text view, not raw markup or a factual/render pass', () => {
    const view = readReferenceText(html, language)
    expect(isCompleteReferenceTextView(view)).toBe(true)
    expect(view.slots.map((slot) => slot.slide_index)).toEqual([1, 2, 3, 4])
    expect(view.slots[2]).toMatchObject({ variant: 'v2', slot: 't1', role: 'body', text: copy })
    expect(JSON.stringify(view)).not.toContain('font-family')
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(Buffer.byteLength(html) / 2)
  })

  it('changes only the addressed repeated slot, preserving BOM, CSS, citations, scripts and all surrounding bytes', () => {
    const replacement = '窗口 09/02–09/08（Asia/Shanghai）。'
    const result = applyReferenceTextEdit(html, language, target(), replacement)
    const raw = referenceLanguageText(copy, core.bindings[1])
    const first = html.indexOf(raw)
    const selected = html.indexOf(raw, first + raw.length)
    expect(result).toBe(html.slice(0, selected) + referenceLanguageText(replacement, core.bindings[1]) + html.slice(selected + raw.length))
    expect(readReferenceText(result, language).slots.map((slot) => slot.text)).toEqual([copy, copy, replacement, copy])
    expect(verifyReferenceLanguageMarkup(result, language).runCount).toBeGreaterThan(0)
  })

  it.each([copy, '124.98'])('preserves the SVG namespace and whitespace when editing %j', (originalText) => {
    const svgCore = { ...core, bindings: core.bindings.map((binding) => ({ ...binding, path: [0, 0] })) }
    const svgLanguage = { ...svgCore, manifestSha256: createHash('sha256').update(JSON.stringify(svgCore)).digest('hex') }
    const original = `<section class="slide cover" data-anera-cjk-variant="v1"><svg><text x="10" y="20">${referenceLanguageText(originalText, svgCore.bindings[0], 'svg')}</text></svg></section>`
    const view = readReferenceText(original, svgLanguage)
    const replacement = '  中文 & SVG 42%  '
    const edited = applyReferenceTextEdit(original, svgLanguage, { hash: view.hash, language_manifest_sha256: view.language_manifest_sha256,
      slide_index: 1, slot: 't1', expected_text: originalText }, replacement)
    expect(edited).toBe(original.replace(referenceLanguageText(originalText, svgCore.bindings[0], 'svg'), referenceLanguageText(replacement, svgCore.bindings[0], 'svg')))
    expect(edited).not.toContain('<span')
    expect(readReferenceText(edited, svgLanguage).slots[0].text).toBe(replacement)
  })

  it('rejects oversized complete views without handing back a truncated editable catalog', () => {
    const longCopy = '文' + ' a'.repeat(4_000)
    const large = Array.from({ length: 8 }, () => `<section class="slide cover" data-anera-cjk-variant="v1"><p>${referenceLanguageText(longCopy, core.bindings[0])}</p></section>`).join('')
    expect(Buffer.byteLength(large)).toBeLessThan(768 * 1024)
    expect(() => readReferenceText(large, language)).toThrow(/bounded complete view/)
  })

  it.each(['中文 <script>alert(1)</script> & "引号" 2026', '中文\n第二行', '全中文，保留标点。', 'ASCII-only 42%'])('generates literal markup safely for %j', (replacement) => {
    const result = applyReferenceTextEdit(html, language, target(), replacement)
    expect(result).toContain(referenceLanguageText(replacement, core.bindings[1]))
    expect(result.match(/<script>/gu)).toHaveLength(1)
    expect(() => verifyReferenceLanguageMarkup(result, language)).not.toThrow()
  })

  it.each([{ hash: 'A'.repeat(43) }, { language_manifest_sha256: 'a'.repeat(64) }, { slide_index: 0 },
    { slide_index: 5 }, { slot: 't2' }, { expected_text: `${copy} ` }, { unexpected: 'field' }])('rejects stale or ambiguous target metadata %j', (patch) => {
    expect(() => applyReferenceTextEdit(html, language, { ...target(), ...patch }, '短文案')).toThrow(/Reference text edit/)
  })

  it.each(['', ' ', '\u0000', '坏\r换行', '\ud800', '中'.repeat(8_001)])('rejects non-literal or invalid replacement data', (replacement) => {
    expect(() => applyReferenceTextEdit(html, language, target(), replacement)).toThrow(/replacement/)
  })

  it('rejects changed file bytes, invalid source bindings and partial/compacted views', () => {
    expect(() => applyReferenceTextEdit(html.replace('color:pink', 'color:red'), language, target(), '短文案')).toThrow(/current file hash/)
    expect(() => readReferenceText(html.replace('font-weight:900', 'font-weight:400'), language)).toThrow(/exact typography/)
    expect(() => readReferenceText(html.replace('<p>', '<div><p>').replace('</p>', '</p></div>'), language)).toThrow(/moved away/)
    expect(() => readReferenceText(html.replace('data-anera-cjk-text="t1">', 'data-anera-cjk-text="t1"><!-- do not silently remove -->'), language)).toThrow(/literal-text group/)
    const view = readReferenceText(html, language)
    expect(isCompleteReferenceTextView({ ...view, complete: false })).toBe(false)
    expect(isCompleteReferenceTextView({ ...view, slots: [...view.slots, view.slots[0]] })).toBe(false)
    expect(isCompleteReferenceTextView({ ...view, slots: [{ ...view.slots[0], text: undefined }] })).toBe(false)
  })
})
