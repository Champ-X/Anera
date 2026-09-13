import logoUrl from '../../logo.png'
import wordmarkUrl from '../../wordmark.png'
import './brand.css'

/** Frame the transparent assets without stretching their proportions. */
export function BrandIcon() {
  return <svg className="anera-brand-icon" viewBox="97 230 1121 768" aria-hidden="true" focusable="false">
    <image href={logoUrl} width="1254" height="1254" />
  </svg>
}

export function Brand() {
  return <span className="anera-brand" role="img" aria-label="Anera">
    <svg className="anera-brand-wordmark" viewBox="65 506 1121 246" aria-hidden="true" focusable="false">
      <image href={wordmarkUrl} width="1254" height="1254" />
    </svg>
  </span>
}
