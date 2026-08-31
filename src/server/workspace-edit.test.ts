import { describe, expect, it } from 'vitest'
import { applyArenaEdit } from './workspace-edit.js'

describe('Arena-compatible edit matching', () => {
  it('prefers an exact unique match', () => {
    expect(applyArenaEdit('alpha\nbeta\ngamma\n', 'beta', 'ready')).toEqual({
      content: 'alpha\nready\ngamma\n',
      matchType: 'exact',
      matchedText: 'beta',
    })
  })

  it('matches unique text with trailing-space, whitespace, and indentation fuzz', () => {
    expect(applyArenaEdit('alpha   \nbeta\n', 'alpha\nbeta', 'done')).toEqual({
      content: 'done\n',
      matchType: 'fuzzy',
      matchedText: 'alpha   \nbeta',
    })
    expect(applyArenaEdit('const  value =  7\nnext\n', 'const value = 7\nnext', 'ok')).toEqual({
      content: 'ok\n',
      matchType: 'fuzzy',
      matchedText: 'const  value =  7\nnext',
    })
    expect(applyArenaEdit('if (ready) {\n    run()\n    stop()\n}\n', '  run()\n  stop()', '    finish()')).toEqual({
      content: 'if (ready) {\n    finish()\n}\n',
      matchType: 'fuzzy',
      matchedText: '    run()\n    stop()',
    })
  })

  it('preserves replacement bytes around fuzzy matches with a terminal newline', () => {
    expect(applyArenaEdit('head\nvalue   \n', 'value\n', 'changed\n')).toEqual({
      content: 'head\nchanged\n',
      matchType: 'fuzzy',
      matchedText: 'value   \n',
    })
  })

  it('rejects empty, missing, and non-unique contexts without changing content', () => {
    expect(() => applyArenaEdit('same\nsame\n', 'same', 'next')).toThrow(/Context not found/)
    expect(() => applyArenaEdit('alpha\n', 'missing', 'next')).toThrow(/Context not found/)
    expect(() => applyArenaEdit('alpha\n', '', 'next')).toThrow(/Context cannot be empty/)
  })

  it('returns one bounded nearby excerpt for a high-confidence context miss without applying it', () => {
    const content = [
      '<article data-status="healthy">',
      '  <h2>Jobs</h2>',
      '  <span>Healthy</span>',
      '  <p>EU-West-1 · 120ms</p>',
      '</article>',
    ].join('\n')
    const stale = [
      '<article data-status="healthy">',
      '  <h2>API (Search)</h2>',
      '  <span>Healthy</span>',
      '  <p>EU-West-1 · 120ms</p>',
      '</article>',
    ].join('\n')
    expect(() => applyArenaEdit(content, stale, 'replacement')).toThrow(/Closest current excerpt \(not applied\):[\s\S]*<h2>Jobs<\/h2>/)
    expect(content).toContain('<h2>Jobs</h2>')
  })

  it('uses one strong unique anchor for a structurally stale edit without accepting the edit', () => {
    const content = [
      'const byRegion = db.prepare(',
      '  `WITH completed AS (SELECT * FROM orders)',
      '   SELECT region, COUNT(*) AS completed_orders',
      '   FROM completed GROUP BY region`',
      ').all()',
      '',
      'const next = true',
    ].join('\n')
    const stale = [
      'const byRegion = db.prepare(',
      '  `SELECT o.region, SUM(o.amount_cents) AS gross',
      '   FROM orders o LEFT JOIN refunds r ON r.order_id = o.order_id',
      '   WHERE o.status = "completed" GROUP BY o.region`',
      ').all()',
    ].join('\n')

    expect(() => applyArenaEdit(content, stale, 'replacement')).toThrow(
      /Closest current excerpt \(not applied\):[\s\S]*WITH completed[\s\S]*completed_orders/,
    )
    expect(content).toContain('const next = true')
  })

  it('truncates a large diagnostic excerpt only at a whole-line boundary and marks that a read is required', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `<div data-row="${index}">${String(index).repeat(420)}</div>`)
    const stale = [...lines]
    stale[5] = '<div data-row="5">stale replacement</div>'
    let message = ''
    try {
      applyArenaEdit(lines.join('\n'), stale.join('\n'), 'replacement')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('Closest excerpt truncated at a whole-line boundary')
    expect(message).toMatch(/<\/div>\n\[Closest excerpt truncated/)
  })

  it('does not return an anchor excerpt when the only plausible anchor is repeated', () => {
    const content = [
      'const result = db.prepare(',
      '  `SELECT one FROM first`',
      ')',
      'const result = db.prepare(',
      '  `SELECT two FROM second`',
      ')',
    ].join('\n')
    const stale = ['const result = db.prepare(', '  `SELECT missing FROM third`', ')'].join('\n')
    expect(() => applyArenaEdit(content, stale, 'replacement')).toThrow(
      /^Context not found\. Read the file to verify the text exists\.$/,
    )
  })
})
