import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ReplicationReport, ShowcaseLanding, StaticDemoFrame, normalizeShowcaseRoute } from './ShowcaseSite'
import { STATIC_SHOWCASE, showcasePageForPath } from './showcase-mode'
import './styles.css'
import './showcase.css'

if (STATIC_SHOWCASE) normalizeShowcaseRoute()

function Root() {
  if (!STATIC_SHOWCASE) return <App />
  const page = showcasePageForPath(window.location.pathname)
  if (page === 'landing') return <ShowcaseLanding />
  if (page === 'report') return <ReplicationReport />
  return <StaticDemoFrame />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
