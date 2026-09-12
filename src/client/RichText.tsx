import { useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function imageHref(sessionId: string, source?: string): string {
  const value = source?.trim() || ''
  if (!value || /[\u0000-\u001f\\]/.test(value)) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (/^(?:\/workspace\/|\/api\/)/.test(value)) return value
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return ''
  const path = value.replace(/^(?:\/home\/user\/|~\/|\.\/)/, '')
  if (path.startsWith('/') || !sessionId) return ''
  return `/workspace/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`
}

export function InlineImage({ src, alt = '', title }: { src: string; alt?: string; title?: string }) {
  const [failedSource, setFailedSource] = useState<string>()
  if (!src || failedSource === src) return <span className="inline-image-fallback">{alt || '图片'} · 图片无法加载{src && <> · <a href={src} target="_blank" rel="noreferrer">打开原图</a></>}</span>
  return <span className="inline-image">
    <img src={src} alt={alt} title={title} loading="lazy" decoding="async" onError={() => setFailedSource(src)} />
    {alt && <span className="inline-image-caption">{alt}</span>}
  </span>
}

export function RichText({ children, sessionId, resolveLink }: {
  children: string
  sessionId: string
  resolveLink: (sessionId: string, href?: string) => string
}) {
  const components = useMemo<Components>(() => ({
    a: ({ children, href, title }) => {
      const target = resolveLink(sessionId, href)
      return <a href={target} title={title} target={target.startsWith('#') ? undefined : '_blank'} rel="noreferrer">{children}</a>
    },
    img: ({ src, alt, title }) => <InlineImage src={imageHref(sessionId, typeof src === 'string' ? src : '')} alt={alt} title={title} />,
    table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
  }), [sessionId, resolveLink])
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
}

export function readImagePath(tool: { name: string; status: string; args: Record<string, unknown>; result?: string }): string | undefined {
  if (tool.name !== 'read_file' || tool.status !== 'succeeded' || typeof tool.args.path !== 'string' || !tool.result) return
  try {
    const result = JSON.parse(tool.result)
    if (result.status === 'success' && result.kind === 'image') return tool.args.path
  } catch { /* Incomplete or non-JSON tool output has no image to present. */ }
}
