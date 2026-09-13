import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Brand } from './Brand'
import { STATIC_SHOWCASE, normalizeShowcaseRoute, showcasePageForPath } from './showcase-mode'
import './styles.css'

const showcasePages = STATIC_SHOWCASE
  ? {
      landing: lazy(async () => ({
        default: (await import('./ShowcaseSite')).ShowcaseLanding,
      })),
      report: lazy(async () => ({
        default: (await import('./ShowcaseSite')).ReplicationReport,
      })),
      demo: lazy(async () => ({
        default: (await import('./StaticDemoFrame')).StaticDemoFrame,
      })),
    }
  : undefined

if (STATIC_SHOWCASE) normalizeShowcaseRoute()

function ShowcaseLoading() {
  return <div role="status" aria-live="polite" style={{ minHeight: '100%', display: 'grid', placeItems: 'center', color: '#14212a', background: '#eef3f5', fontFamily: 'Avenir Next, PingFang SC, sans-serif' }}>
    <div style={{ display: 'grid', justifyItems: 'center', gap: 10, textAlign: 'center' }}><Brand /><span style={{ color: '#62717a', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Loading evidence surface</span></div>
  </div>
}

function Root() {
  if (!STATIC_SHOWCASE) return <App />
  const page = showcasePageForPath(window.location.pathname)
  const Page = showcasePages![page]
  return <Suspense fallback={<ShowcaseLoading />}><Page /></Suspense>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
