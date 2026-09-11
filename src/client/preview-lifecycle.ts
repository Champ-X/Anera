import type { WebsiteState } from '../shared/types'

/** UI availability is determined by the serving resource, not artifact kind.
 * Workspace previews are served from durable files by the App; process-backed
 * URLs retain the runtime availability guard. This is not an access check. */
export function canOpenWebsitePreview(website?: Pick<WebsiteState, 'status' | 'previewUrl'>): boolean {
  if (!website?.previewUrl) return false
  const fileBacked = /^\/workspace\/[^/?#]+\/preview(?:\/|[?#]|$)/u.test(website.previewUrl)
  return fileBacked || website.status === 'running'
}

export function shouldCloseWebsitePreview(
  previewUrl: string | undefined,
  website?: Pick<WebsiteState, 'status' | 'previewUrl'>,
): boolean {
  return Boolean(previewUrl && previewUrl === website?.previewUrl && !canOpenWebsitePreview(website))
}
