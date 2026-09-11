import { createHash } from 'node:crypto'
import { referenceTemplateCatalog, type ReferenceTemplateSlide } from '../reference-template.js'

export const sourceUrl = 'https://reference.example/templates/deck/template.html'
export const newsUrl = 'https://news.example/article'
export const css = '.slide{background:#120a10;color:#ed3d8c}.display{font:900 96px serif;letter-spacing:-2px}'
export const source = `<!doctype html><html><head><title>Template demo</title><style>${css}</style></head><body><deck-stage><section class="slide cover" data-label="Old cover"><h1 class="display">Demo cover</h1></section><section class="slide quote"><p>Demo claim &amp; data</p><cite>Demo source</cite></section><section class="slide closing"><h1>Demo closing</h1></section></deck-stage><script src="deck-stage.js"></script></body></html>`
export const script = 'customElements.define("deck-stage", class extends HTMLElement {}); // literal </script> stays data'
export const dependency = {
  url: new URL('deck-stage.js', sourceUrl).toString(), content: script,
  sha256: createHash('sha256').update(script).digest('hex'), bytes: Buffer.byteLength(script),
}
export const catalog = referenceTemplateCatalog(source, sourceUrl)
export const slides: ReferenceTemplateSlide[] = [
  { variant: 'v1', label: '封面', texts: { t1: '本周娱乐' } },
  { variant: 'v2', label: '正文', texts: { t1: '这是来源明确的内容 <不是 HTML>', t2: '原始报道' }, links: { t2: newsUrl } },
  { variant: 'v3', label: '来源', texts: { t1: '查阅原文' } },
]
export const input = () => ({ source, sourceUrl, sourceSha256: catalog.sourceSha256, title: '中文周报', slides, dependencies: [dependency], allowedSourceUrls: [newsUrl] })
