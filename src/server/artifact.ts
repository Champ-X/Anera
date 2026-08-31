import { extname } from 'node:path'
import mime from 'mime-types'
import type { ArtifactRecord } from '../shared/types.js'
import { createId } from './ids.js'
import { encodeWorkspaceUrlPath } from './workspace.js'

export function artifactKind(path: string): ArtifactRecord['kind'] {
  const extension = extname(path).toLowerCase()
  if (extension === '.html') return 'website'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extension)) return 'image'
  if (['.mp3', '.wav', '.aac', '.flac', '.opus', '.m4a', '.oga', '.ogg', '.aif', '.aiff'].includes(extension)) return 'audio'
  if (['.mp4', '.webm', '.mov', '.m4v', '.ogv'].includes(extension)) return 'video'
  if (['.md', '.txt'].includes(extension)) return 'markdown'
  if (['.pdf', '.docx', '.xlsx', '.pptx'].includes(extension)) return 'document'
  if (['.csv', '.json', '.tsv'].includes(extension)) return 'data'
  if (['.zip', '.tar', '.gz'].includes(extension)) return 'archive'
  return 'file'
}

export function arenaTextContentType(path: string): string {
  const extension = extname(path).toLowerCase()
  if (extension === '.html') return 'text/html'
  if (['.js', '.jsx', '.ts', '.tsx'].includes(extension)) return 'text/javascript'
  if (extension === '.css') return 'text/css'
  if (extension === '.md') return 'text/markdown'
  if (extension === '.json') return 'application/json'
  if (extension === '.sql') return 'application/sql'
  if (extension === '.toml') return 'application/toml'
  if (['.yaml', '.yml'].includes(extension)) return 'application/x-yaml'
  if (extension === '.svg') return 'image/svg+xml'
  if (['.py', '.pyi'].includes(extension)) return 'text/x-python'
  if (['.sh', '.bash', '.zsh'].includes(extension)) return 'text/x-shellscript'
  return 'text/plain'
}

export function artifactMime(path: string): string {
  const extension = extname(path).toLowerCase()
  if (['.html', '.js', '.jsx', '.ts', '.tsx', '.css', '.md', '.txt', '.json', '.csv', '.tsv', '.sql', '.toml', '.yaml', '.yml', '.svg', '.py', '.pyi', '.sh', '.bash', '.zsh', '.env'].includes(extension)) {
    return arenaTextContentType(path)
  }
  return mime.lookup(path) || 'application/octet-stream'
}

export function createWorkspaceArtifact(
  sessionId: string,
  path: string,
  createdAt = new Date().toISOString(),
): ArtifactRecord {
  const kind = artifactKind(path)
  return {
    id: createId('art'),
    sessionId,
    path,
    name: path.split('/').at(-1) || path,
    kind,
    mime: artifactMime(path),
    createdAt,
    previewUrl: kind === 'website'
      ? `/workspace/${sessionId}/preview/${encodeWorkspaceUrlPath(path)}`
      : `/workspace/${sessionId}/file?path=${encodeURIComponent(path)}`,
    downloadUrl: `/api/sessions/${sessionId}/download?path=${encodeURIComponent(path)}`,
  }
}
