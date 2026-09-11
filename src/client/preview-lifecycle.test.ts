import { describe, expect, it } from 'vitest'
import type { WebsiteState } from '../shared/types'
import { canOpenWebsitePreview, shouldCloseWebsitePreview } from './preview-lifecycle'

describe('preview resource lifecycle', () => {
  it.each(['running', 'asleep', 'stopped', 'failed', 'starting'] as WebsiteState['status'][])(
    'keeps durable file previews available while the process is %s', (status) => {
      const previewUrl = '/workspace/ses_example/preview/folder/report.html?aneraElementPicker=1'
      const website = { status, previewUrl }
      expect(canOpenWebsitePreview(website)).toBe(true)
      expect(shouldCloseWebsitePreview(previewUrl, website)).toBe(false)
    },
  )
  it.each(['/preview/ses_example/', 'http://localhost:8001/', 'https://external.test/workspace/ses_example/preview/index.html', '/workspace/ses_example/preview-proxy/'])(
    'retains runtime protection for non-file route %s', (previewUrl) => {
      expect(canOpenWebsitePreview({ status: 'running', previewUrl })).toBe(true)
      const asleep = { status: 'asleep' as const, previewUrl }
      expect(canOpenWebsitePreview(asleep)).toBe(false)
      expect(shouldCloseWebsitePreview(previewUrl, asleep)).toBe(true)
      expect(shouldCloseWebsitePreview('/workspace/ses_other/file?path=photo.png', asleep)).toBe(false)
    },
  )
  it('does not offer an absent preview or close an unrelated viewer', () => {
    expect(canOpenWebsitePreview()).toBe(false)
    expect(canOpenWebsitePreview({ status: 'running' })).toBe(false)
    expect(shouldCloseWebsitePreview(undefined)).toBe(false)
    expect(shouldCloseWebsitePreview('/workspace/ses_example/file?path=report.pdf')).toBe(false)
  })
})
