export const STATIC_SHOWCASE = import.meta.env.VITE_STATIC_SHOWCASE === 'true'
export const SHOWCASE_DEFAULT_SESSION_ID = 'ses_864449e90bb3452ba8d6'
export const SHOWCASE_NAVIGATION_EVENT = 'anera-showcase:navigate'
export const SHOWCASE_REPLAY_EVENT = 'anera-showcase:replay'

export type ShowcasePage = 'landing' | 'report' | 'demo'

export function showcasePageForPath(pathname: string): ShowcasePage {
  if (pathname === '/') return 'landing'
  if (pathname === '/report' || pathname === '/report/') return 'report'
  return 'demo'
}

export function normalizedShowcasePath(pathname: string): string {
  return pathname === '/demo' || pathname === '/demo/'
    ? `/agent/${SHOWCASE_DEFAULT_SESSION_ID}`
    : pathname
}

export function showcaseAssetUrl(sessionId: string, path: string): string {
  if (!/^ses_[a-z0-9]{20}$/.test(sessionId)) throw new Error('Invalid showcase session id')
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid showcase asset path')
  }
  return `/showcase/artifacts/${sessionId}/${parts.map((part) => encodeURIComponent(part)).join('/')}`
}
