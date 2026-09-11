import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ModelSelector } from './ModelSelector'

const models = [
  { id: 'flash', publicName: 'flash', displayName: 'Flash', description: '快速经济' },
  { id: 'pro', publicName: 'pro', displayName: 'Pro', description: '费用较高' },
]
describe('composer model selector', () => {
  it('renders explicit selection and provider hints without an implicit random option', () => {
    const html = renderToStaticMarkup(<ModelSelector models={models} value="pro" unavailable={false} onChange={() => {}} />)
    expect(html).toContain('aria-label="选择模型"')
    expect(html).toContain('value="pro" selected=""')
    expect(html).toContain('费用较高')
    expect(html).not.toContain('value="auto"')
  })
  it('retains a historical session model missing from the new catalog', () => {
    const html = renderToStaticMarkup(<ModelSelector models={models} value="legacy" unavailable={false} onChange={() => {}} />)
    expect(html).toContain('value="legacy" selected=""')
    expect(html).toContain('当前会话')
  })
  it.each([
    { value: '', models: [], unavailable: false },
    { value: 'flash', models, unavailable: true },
    { value: 'flash', models, unavailable: false, disabled: true },
  ])('locks selection while loading, unavailable, or running (%j)', (props) => {
    expect(renderToStaticMarkup(<ModelSelector {...props} onChange={() => {}} />)).toContain('disabled=""')
  })
})
