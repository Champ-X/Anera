import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { imageHref, readImagePath, RichText } from './RichText'

describe('conversation rich images', () => {
  it('resolves workspace paths, including absolute agent paths and Chinese names', () => {
    for (const path of ['assets/概念 海报.jpg', './assets/概念 海报.jpg', '/home/user/assets/概念 海报.jpg', '~/assets/概念 海报.jpg']) {
      expect(imageHref('ses_1', path)).toBe('/workspace/ses_1/file?path=assets%2F%E6%A6%82%E5%BF%B5%20%E6%B5%B7%E6%8A%A5.jpg')
    }
    expect(imageHref('ses_1', 'https://example.com/poster.jpg')).toBe('https://example.com/poster.jpg')
  })
  it('rejects active content and unsupported local URLs', () => {
    for (const path of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', '//example.com/a.jpg', '/etc/passwd', '\\example.com\\a']) expect(imageHref('ses_1', path)).toBe('')
  })
  it('renders captions, tables, and image links without raw HTML execution', () => {
    const html = renderToStaticMarkup(<RichText sessionId="ses_1" resolveLink={(_, href) => href || '#'}>{'![概念海报](assets/concept.jpg)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>'}</RichText>)
    expect(html).toContain('src="/workspace/ses_1/file?path=assets%2Fconcept.jpg"')
    expect(html).toContain('inline-image-caption')
    expect(html).toContain('markdown-table-scroll')
    expect(html).not.toContain('<script>')
  })
  it('exposes only successfully read images from historical tool results', () => {
    const tool = { name: 'read_file', status: 'succeeded', args: { path: 'assets/concept.jpg' }, result: JSON.stringify({ status: 'success', kind: 'image' }) }
    expect(readImagePath(tool)).toBe('assets/concept.jpg')
    expect(readImagePath({ ...tool, status: 'failed' })).toBeUndefined()
    expect(readImagePath({ ...tool, result: '{' })).toBeUndefined()
    expect(readImagePath({ ...tool, result: '{"kind":"text"}' })).toBeUndefined()
  })
})
