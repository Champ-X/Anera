import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '../shared/types.js'
import type { ReferenceFontEvidenceManifest, ReferenceVisualEvidenceManifest } from './session-store.js'
import { BLUE_PROFESSIONAL_TEMPLATE_HTML } from './fixtures/blue-professional-template.fixture.js'
import {
  contractIsGroundedInEvidence,
  completedReferenceStyleFetchForCall,
  extractReferenceStyleSourceProfile,
  findReferenceStyleEvidence,
  githubAnchoredTemplateSourceUrl,
  latestSuccessfulReferenceStyleContract,
  normalizeReferenceContractMarker,
  normalizeRenderedReferenceStyleProfile,
  normalizeReferenceStyleContract,
  normalizeReferenceStyleContractAgainstEvidence,
  normalizeReferenceStyleSourceProfile,
  projectReferenceStyleToolResultForProvider,
  referenceStyleGroundingGaps,
  referenceStyleEvidenceContinuation,
  referenceStyleEvidenceScore,
  referenceUrlsAreRelated,
  referenceTextLayoutRequiresUpgrade,
  verifyHtmlAgainstReferenceStyle,
  type ReferenceStyleContract,
  type ReferenceStyleSourceProfile,
  type RenderedReferenceStyleProfile,
} from './reference-style.js'

const REFERENCE_DIRECTORY = 'https://github.com/zarazhangrui/beautiful-html-templates/blob/main/templates/blue-professional'
const REFERENCE_REPOSITORY = 'https://github.com/zarazhangrui/beautiful-html-templates'
const REFERENCE_SOURCE = 'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/main/templates/blue-professional/template.html'
const SIBLING_SOURCE = 'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/main/templates/dark-corporate/template.html'
const PINK_SCRIPT_SOURCE = 'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/main/templates/pink-script/template.html'

const REFERENCE_HTML = `<!doctype html>
<html>
  <head>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk&family=Inter" rel="stylesheet">
    <style>
      :root { --bg: #fdfae7; --primary: #1e2bfa; --text: #111111; --border: rgba(30, 43, 250, 0.2); }
      body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; }
      h1 { font-family: 'Space Grotesk', sans-serif; }
      .layout-cover::after { clip-path: polygon(30% 0, 100% 0, 100% 100%, 0 100%); }
      .cover-dots { display: grid; grid-template-columns: repeat(3, 6px); }
      .progress-bar { position: fixed; height: 3px; background: var(--primary); }
      .nav-controls { position: fixed; border: 1px solid var(--border); }
    </style>
  </head>
  <body><section class="layout-cover"><h1>Reference title</h1><div class="cover-dots"></div></section><div class="progress-bar"></div><nav class="nav-controls"></nav></body>
</html>`

const REFERENCE_HTML_CHUNKS = [
  REFERENCE_HTML.slice(0, Math.floor(REFERENCE_HTML.length / 3)),
  REFERENCE_HTML.slice(Math.floor(REFERENCE_HTML.length / 3), Math.floor(REFERENCE_HTML.length * 2 / 3)),
  REFERENCE_HTML.slice(Math.floor(REFERENCE_HTML.length * 2 / 3)),
] as const

// Exact structural slice from pink-script. This fixture covers the custom
// element and nested selectors that exposed the reference-contract loop.
const PINK_SCRIPT_MARKER_HTML = `<!doctype html><html><head><style>
  :root{--ink:#060507;--paper:#f5edf1;--pink:#ed3d8c}
  html,body{background:var(--ink);color:var(--paper);font-family:"Inter",sans-serif}
  deck-stage > section.slide{position:relative;background:var(--ink);color:var(--paper)}
  .runner,.footer{font-family:"JetBrains Mono",monospace;color:var(--pink)}
  .script{font-family:"DM Serif Display",serif;color:var(--pink)}
  .s-cover .title{font-family:"DM Serif Display",serif}
  .s-toc .row{display:grid}.s-stats .stat{display:grid}
  .s-section .num{color:var(--pink)}.s-quote blockquote{color:var(--paper)}
</style></head><body><deck-stage>
  <section class="slide s-cover"><div class="runner"></div><h1 class="title script">After hours</h1><footer class="footer"></footer></section>
  <section class="slide s-toc"><div class="row"></div></section>
  <section class="slide s-stats"><div class="stat"></div></section>
  <section class="slide s-section"><div class="num"></div></section>
  <section class="slide s-quote"><blockquote>Quote</blockquote></section>
</deck-stage></body></html>`

const CONTRACT: ReferenceStyleContract = {
  sourceUrl: REFERENCE_SOURCE,
  strictness: 'exact',
  colors: ['#fdfae7', '#1e2bfa', '#111111', 'rgba(30,43,250,0.2)'],
  fonts: ['Space Grotesk', 'Inter'],
  layout: ['warm cream 16:9 canvas', 'diagonal cover panel and 3x3 dot grid'],
  components: ['soft cobalt cards without generic elevation', 'circular navigation with a 3px progress bar'],
  requiredMarkers: ['.layout-cover', '.cover-dots', '.progress-bar', '.nav-controls'],
  signature: 'Warm cream canvas with a single cobalt accent and restrained consulting-grade geometry.',
  avoid: ['dark gradient cover', 'gold secondary accent', 'card drop shadows', 'full-width dark footer'],
  viewport: { width: 1440, height: 900 },
}

// Exact selector/value slice from beautiful-html-templates/blue-professional.
// It intentionally keeps the real tag-only canvas/typography and the agenda
// interior that previously fell out of the bounded profile.
const BLUE_PROFESSIONAL_REGRESSION_HTML = `<!doctype html><html><head><style>
  :root{--bg:#fdfae7;--primary:#1e2bfa;--text:#111111;--text-muted:#6b6b6b;--border:rgba(30,43,250,0.2)}
  html, body{width:100%;height:100%;overflow:hidden;font-family:'Inter',sans-serif;background:var(--bg);color:var(--text)}
  h1,h2,h3,h4{font-family:'Space Grotesk',sans-serif;font-weight:600;line-height:1.1;letter-spacing:-0.02em}
  h1{font-size:clamp(2.8rem,5vw,4.2rem);font-weight:700}
  h2{font-size:clamp(1.8rem,3vw,2.6rem)}
  h3{font-size:clamp(1.1rem,1.8vw,1.5rem);font-weight:500;line-height:1.3}
  h4{font-size:clamp(0.85rem,1.2vw,1rem);font-weight:600;letter-spacing:0.08em;color:var(--primary)}
  p,li{font-size:clamp(0.85rem,1.1vw,1.05rem);line-height:1.6;color:var(--text-muted)}
  .slide{position:absolute;inset:0;width:100vw;height:100vh;display:flex;opacity:0;padding:4vh 5vw}
  .slide.active{opacity:1}.layout-cover{align-items:flex-start;justify-content:center}
  .layout-cover::after{content:'';position:absolute;right:0;top:0;width:35vw;height:100vh;background:rgba(30,43,250,0.2);clip-path:polygon(30% 0,100% 0,100% 100%,0 100%)}
  .cover-dots{display:grid;grid-template-columns:repeat(3,6px);gap:12px}
  .layout-agenda .agenda-grid{display:grid;grid-template-columns:repeat(2,1fr);grid-template-rows:repeat(3,1fr);gap:1rem 3rem;min-height:0}
  .slide-header{display:flex;align-items:center;justify-content:space-between}
  .slide-header .tag{font-family:'Space Grotesk',sans-serif;font-size:0.75rem;font-weight:500;color:var(--primary);background:rgba(30,43,250,0.2)}
  .layout-closing{align-items:center;justify-content:center;text-align:center}
  .progress-bar{position:fixed;bottom:0;left:0;height:3px;background:var(--primary)}
  .nav-controls{position:fixed;right:3vw;bottom:2.5vh}
</style></head><body>
  <main class="slide active layout-cover"><h1>Market Outlook</h1><div class="cover-dots"></div></main>
  <section class="slide layout-agenda"><header class="slide-header"><h4>Table of Contents</h4><span class="tag">Overview</span></header><div class="agenda-grid"><article><h3>Executive Summary</h3><p>Reference body copy.</p></article></div></section>
  <section class="slide layout-closing"><h1>Thank You</h1></section>
  <div class="progress-bar"></div><nav class="nav-controls"></nav>
</body></html>`

function fetchMessages(url: string, content: string): ModelMessage[] {
  return [{
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'fetch-reference',
      type: 'function',
      function: { name: 'web_fetch', arguments: JSON.stringify({ url, format: 'html' }) },
    }],
  }, {
    role: 'tool',
    tool_call_id: 'fetch-reference',
    tool_result_status: 'succeeded',
    content: JSON.stringify({ status: 'success', url, content }),
  }]
}

interface FetchPageMessageChunk {
  id?: string
  chunkIndex: number
  callChunkIndex?: number
  content: string
  hasMore: boolean
  totalChunks?: number
  requestedUrl?: string
  resolvedUrl?: string
  format?: 'markdown' | 'raw'
}

function fetchPageMessages(chunks: readonly FetchPageMessageChunk[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const [position, chunk] of chunks.entries()) {
    const id = chunk.id ?? `fetch-page-${chunk.chunkIndex}-${position}`
    const requestedUrl = chunk.requestedUrl ?? REFERENCE_SOURCE
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id,
        type: 'function',
        function: {
          name: 'fetch_page',
          arguments: JSON.stringify({
            url: requestedUrl,
            format: chunk.format ?? 'raw',
            chunkIndex: chunk.callChunkIndex ?? chunk.chunkIndex,
          }),
        },
      }],
    }, {
      role: 'tool',
      tool_call_id: id,
      tool_result_status: 'succeeded',
      content: JSON.stringify({
        status: 'success',
        url: chunk.resolvedUrl ?? requestedUrl,
        title: 'Reference source',
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        hasMore: chunk.hasMore,
        ...(chunk.totalChunks === undefined ? {} : { totalChunks: chunk.totalChunks }),
      }),
    })
  }
  return messages
}

function completeReferencePageChunks(): FetchPageMessageChunk[] {
  return REFERENCE_HTML_CHUNKS.map((content, chunkIndex) => ({
    id: `fetch-page-${chunkIndex}`,
    chunkIndex,
    content,
    hasMore: chunkIndex < REFERENCE_HTML_CHUNKS.length - 1,
    totalChunks: REFERENCE_HTML_CHUNKS.length,
    format: 'raw',
  }))
}

function recordedContractMessages(
  contract: ReferenceStyleContract = CONTRACT,
  resolvedUrl = REFERENCE_SOURCE,
  sourceProfile?: ReferenceStyleSourceProfile,
  renderProfile?: RenderedReferenceStyleProfile,
): ModelMessage[] {
  return [{
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'record-reference',
      type: 'function',
      function: {
        name: 'record_reference_style',
        arguments: JSON.stringify({
          source_url: contract.sourceUrl,
          strictness: contract.strictness,
          colors: contract.colors,
          fonts: contract.fonts,
          layout: contract.layout,
          components: contract.components,
          required_markers: contract.requiredMarkers,
          signature: contract.signature,
          avoid: contract.avoid,
          viewport: contract.viewport,
        }),
      },
    }],
  }, {
    role: 'tool',
    tool_call_id: 'record-reference',
    tool_result_status: 'succeeded',
    content: JSON.stringify({
      status: 'success',
      contract: {
        source_url: contract.sourceUrl,
        strictness: contract.strictness,
        colors: contract.colors,
        fonts: contract.fonts,
        layout: contract.layout,
        components: contract.components,
        required_markers: contract.requiredMarkers,
        signature: contract.signature,
        avoid: contract.avoid,
        viewport: contract.viewport,
      },
      provenance: {
        resolvedUrl,
        evidenceSha256: createHash('sha256').update(REFERENCE_HTML).digest('hex'),
        evidenceBytes: Buffer.byteLength(REFERENCE_HTML),
      },
      ...(sourceProfile ? { source_profile: sourceProfile } : {}),
      ...(renderProfile ? { render_profile: renderProfile } : {}),
    }),
  }]
}

function renderedProfile(): RenderedReferenceStyleProfile {
  const chromeAnchor = {
    selector: '.progress-bar',
    count: 1,
    geometry: 'strict' as const,
    rects: [{ x: 0, y: 0.9967, width: 0.1, height: 0.0033 }],
    styles: [{ display: 'block', position: 'fixed', opacity: '1', height: '3px' }],
    occlusion: [1],
  }
  const structuralAnchor = (selector: string) => ({
    selector,
    count: 1,
    geometry: 'strict' as const,
    rects: [{ x: 0, y: 0, width: 1, height: 1 }],
    styles: [{ display: 'flex', position: 'absolute', opacity: '1' }],
    occlusion: [1],
  })
  return {
    version: 1,
    evidenceSha256: createHash('sha256').update(REFERENCE_HTML).digest('hex'),
    viewport: CONTRACT.viewport,
    phases: {
      cover: { anchors: [structuralAnchor('.layout-cover'), chromeAnchor], overlayProbes: [] },
      content: { anchors: [structuralAnchor('.slide-header'), chromeAnchor], overlayProbes: [] },
      closing: { anchors: [structuralAnchor('.layout-closing'), chromeAnchor], overlayProbes: [] },
    },
    sharedAnchorSelectors: ['.progress-bar'],
  }
}

function exactFontEvidence(sourceEvidenceSha256: string): ReferenceFontEvidenceManifest {
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
  const materializedCss = '@font-face{}'
  const materializationCore = {
    version: 1 as const,
    stylesheets: [{
      sha256: digest('source css'),
      bytes: Buffer.byteLength('source css'),
      materializedSha256: digest(materializedCss),
      materializedBytes: Buffer.byteLength(materializedCss),
      fontSha256: [digest(Buffer.from('wOF2'))],
    }],
    fonts: [{ sha256: digest(Buffer.from('wOF2')), bytes: 4 }],
    familyNames: ['Inter'],
    cssBytes: Buffer.byteLength('source css'),
    fontBytes: 4,
  }
  const materializationManifest = {
    ...materializationCore,
    manifestSha256: digest(JSON.stringify(materializationCore)),
  }
  const core = {
    version: 1 as const,
    sourceEvidenceSha256,
    fontCssSha256: digest(materializedCss),
    fontCssBytes: Buffer.byteLength(materializedCss),
    familyNames: ['Inter'],
    materializationManifest,
  }
  return { ...core, manifestSha256: digest(JSON.stringify(core)) }
}

function exactVisualEvidence(renderProfile: RenderedReferenceStyleProfile): ReferenceVisualEvidenceManifest {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const core = {
    version: 1 as const,
    sourceEvidenceSha256: renderProfile.evidenceSha256,
    renderProfileSha256: digest(JSON.stringify(normalizeRenderedReferenceStyleProfile(renderProfile, {
      evidenceSha256: renderProfile.evidenceSha256,
      viewport: renderProfile.viewport,
    }))),
    viewport: renderProfile.viewport,
    phases: {
      cover: { sha256: digest('cover png'), bytes: 33, ...renderProfile.viewport },
      content: { sha256: digest('content png'), bytes: 33, ...renderProfile.viewport },
      closing: { sha256: digest('closing png'), bytes: 33, ...renderProfile.viewport },
    },
  }
  return { ...core, manifestSha256: digest(JSON.stringify(core)) }
}

function expandedRenderedProfile(): RenderedReferenceStyleProfile {
  const base = renderedProfile()
  return {
    ...base,
    phases: Object.fromEntries((['cover', 'content', 'closing'] as const).map((phase) => [phase, {
      anchors: [
        base.phases[phase].anchors[0],
        ...Array.from({ length: 18 }, (_, index) => ({
          selector: `.reference-${phase}-component-${index}`,
          count: 1,
          geometry: 'strict' as const,
          rects: [{
            x: (index % 6) / 6,
            y: Math.floor(index / 6) / 3,
            width: 0.15,
            height: 0.28,
          }],
          styles: [{
            display: 'grid',
            position: 'absolute',
            opacity: '1',
            visibility: 'visible',
            width: '320px',
            height: '180px',
            'background-color': 'rgb(253, 250, 231)',
            color: 'rgb(17, 17, 17)',
            'font-family': 'inter, sans-serif',
            'font-size': '16px',
            'font-weight': '500',
            'border-radius': '12px',
            'box-shadow': 'none',
            gap: '12px',
            padding: '24px',
            transform: 'none',
          }],
          occlusion: [0.92],
        })),
        base.phases[phase].anchors[1],
      ],
      overlayProbes: Array.from({ length: 6 }, (_, index) => ({
        tag: 'div',
        coverage: 0.5 + index / 20,
        position: 'absolute',
        backgroundColor: 'rgba(30, 43, 250, 0.2)',
        backgroundImage: 'none',
        opacity: '1',
        zIndex: String(index),
      })),
    }])) as unknown as RenderedReferenceStyleProfile['phases'],
  }
}

describe('reference style evidence and verification', () => {
  it('treats GitHub repository and directory listings as discovery only and relates only the requested template subtree', () => {
    const directoryListing = 'blue-professional\ndesign.md\ntemplate.html\ntemplate.json\nHistory\n'
    expect(referenceStyleEvidenceScore(directoryListing)).toBeLessThan(4)
    expect(findReferenceStyleEvidence(
      fetchMessages(REFERENCE_DIRECTORY, directoryListing),
      [REFERENCE_DIRECTORY],
    )).toBeUndefined()
    const styleRichGitHubChrome = '<!doctype html><style>:root{--fg:#111111;--bg:#ffffff}.file-grid{display:grid;grid-template-columns:1fr}.nav{border-radius:8px;box-shadow:0 1px 2px #0003}body{font-family:Arial}</style><a>design.md</a><a>template.html</a>'
    expect(referenceStyleEvidenceScore(styleRichGitHubChrome)).toBeGreaterThanOrEqual(4)
    expect(findReferenceStyleEvidence(
      fetchMessages(REFERENCE_REPOSITORY, styleRichGitHubChrome),
      [REFERENCE_REPOSITORY],
    )).toBeUndefined()
    expect(findReferenceStyleEvidence(
      fetchMessages(REFERENCE_DIRECTORY, styleRichGitHubChrome),
      [REFERENCE_DIRECTORY],
    )).toBeUndefined()

    expect(findReferenceStyleEvidence(
      fetchMessages(REFERENCE_SOURCE, REFERENCE_HTML),
      [REFERENCE_REPOSITORY],
    )).toMatchObject({
      requestedUrl: REFERENCE_SOURCE,
      resolvedUrl: REFERENCE_SOURCE,
    })

    const redirectedFetch = fetchMessages(REFERENCE_SOURCE, REFERENCE_HTML)
    redirectedFetch[1] = {
      ...redirectedFetch[1],
      content: JSON.stringify({
        status: 'success',
        url: 'https://attacker.example/template.html',
        content: REFERENCE_HTML,
      }),
    }
    expect(findReferenceStyleEvidence(redirectedFetch, [REFERENCE_DIRECTORY])).toBeUndefined()

    expect(referenceUrlsAreRelated(REFERENCE_DIRECTORY, REFERENCE_SOURCE)).toBe(true)
    expect(referenceUrlsAreRelated(REFERENCE_DIRECTORY, SIBLING_SOURCE)).toBe(false)
    expect(referenceUrlsAreRelated(
      'https://github.com/zarazhangrui/beautiful-html-templates/tree/main/templates/blue-professional',
      REFERENCE_SOURCE,
    )).toBe(true)
    expect(referenceUrlsAreRelated(
      'https://github.com/zarazhangrui/beautiful-html-templates/tree/main/templates/blue-professional',
      'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/experimental/templates/blue-professional/template.html',
    )).toBe(false)
    expect(referenceUrlsAreRelated(
      'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/HEAD/templates/blue-professional/template.html',
      'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/experimental/templates/blue-professional/template.html',
    )).toBe(false)
    expect(referenceUrlsAreRelated(
      'https://raw.githubusercontent.com/Example/Templates/Feature/Theme/Template.html',
      'https://raw.githubusercontent.com/example/templates/feature/Theme/Template.html',
    )).toBe(false)
    expect(referenceUrlsAreRelated(
      'https://raw.githubusercontent.com/Example/Templates/Feature/Theme/Template.html',
      'https://raw.githubusercontent.com/example/templates/Feature/theme/Template.html',
    )).toBe(false)
    expect(referenceUrlsAreRelated(
      'https://raw.githubusercontent.com/Example/Templates/Feature/Theme/Template.html',
      'https://raw.githubusercontent.com/example/templates/Feature/Theme/Template.html',
    )).toBe(true)

    expect(referenceUrlsAreRelated(
      'https://reference.example/templates/paper?variant=a',
      'https://reference.example/templates/paper?variant=b',
    )).toBe(false)
    expect(referenceUrlsAreRelated(
      'https://reference.example/templates/paper',
      'http://reference.example/templates/paper',
    )).toBe(false)
    expect(referenceUrlsAreRelated(
      'https://reference.example/templates/paper',
      'https://reference.example:444/templates/paper',
    )).toBe(false)

    const anchoredRepository = `${REFERENCE_REPOSITORY}#blue-professional`
    expect(githubAnchoredTemplateSourceUrl(anchoredRepository)).toBe(
      'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/HEAD/templates/blue-professional/template.html',
    )
    expect(githubAnchoredTemplateSourceUrl(
      `${REFERENCE_REPOSITORY}?tab=readme-ov-file#blue-professional`,
    )).toBe(
      'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/HEAD/templates/blue-professional/template.html',
    )
    expect(githubAnchoredTemplateSourceUrl(
      `${REFERENCE_REPOSITORY}?utm_source=copied-link#blue-professional`,
    )).toBe(
      'https://raw.githubusercontent.com/zarazhangrui/beautiful-html-templates/HEAD/templates/blue-professional/template.html',
    )
    expect(githubAnchoredTemplateSourceUrl(
      `${REFERENCE_REPOSITORY}?variant=a#blue-professional`,
    )).toBeUndefined()
    expect(referenceUrlsAreRelated(
      `${REFERENCE_SOURCE}?variant=a`,
      `${REFERENCE_SOURCE}?variant=b`,
    )).toBe(false)
    expect(referenceUrlsAreRelated(anchoredRepository, REFERENCE_SOURCE)).toBe(true)
    expect(referenceUrlsAreRelated(
      githubAnchoredTemplateSourceUrl(anchoredRepository) as string,
      REFERENCE_SOURCE,
    )).toBe(true)
    expect(referenceUrlsAreRelated(anchoredRepository, SIBLING_SOURCE)).toBe(false)
    expect(githubAnchoredTemplateSourceUrl(`${REFERENCE_REPOSITORY}#../blue-professional`)).toBeUndefined()
    expect(githubAnchoredTemplateSourceUrl(`${REFERENCE_REPOSITORY}#templates/blue-professional`)).toBeUndefined()
    expect(githubAnchoredTemplateSourceUrl('http://github.com/example/templates#paper')).toBeUndefined()
    expect(githubAnchoredTemplateSourceUrl('https://user@github.com/example/templates#paper')).toBeUndefined()
    expect(githubAnchoredTemplateSourceUrl('https://github.com:444/example/templates#paper')).toBeUndefined()

    const ordinaryReadmeAnchor = 'https://github.com/example/product#installation'
    const unrelatedRepositoryFile = 'https://raw.githubusercontent.com/example/product/main/templates/installation/template.html'
    expect(githubAnchoredTemplateSourceUrl(ordinaryReadmeAnchor)).toBeUndefined()
    expect(referenceUrlsAreRelated(ordinaryReadmeAnchor, unrelatedRepositoryFile)).toBe(false)
    expect(referenceUrlsAreRelated(
      ordinaryReadmeAnchor,
      'https://github.com/example/product#usage',
    )).toBe(false)
    expect(referenceUrlsAreRelated(
      ordinaryReadmeAnchor,
      'https://github.com/example/product',
    )).toBe(true)
  })

  it('accepts concrete style-bearing source and rejects a hallucinated contract', () => {
    const evidence = findReferenceStyleEvidence(fetchMessages(REFERENCE_SOURCE, REFERENCE_HTML), [REFERENCE_DIRECTORY])
    expect(evidence).toMatchObject({
      requestedUrl: REFERENCE_SOURCE,
      resolvedUrl: REFERENCE_SOURCE,
      callIds: ['fetch-reference'],
      bytes: Buffer.byteLength(REFERENCE_HTML),
    })
    expect(contractIsGroundedInEvidence(CONTRACT, evidence!)).toBe(true)
    const redirectedEvidence = {
      ...evidence!,
      resolvedUrl: 'https://attacker.example/template.html',
    }
    expect(contractIsGroundedInEvidence(CONTRACT, redirectedEvidence)).toBe(false)
    expect(referenceStyleGroundingGaps(CONTRACT, redirectedEvidence)).toBeUndefined()
    expect(normalizeReferenceStyleContractAgainstEvidence(CONTRACT, redirectedEvidence)).toEqual({
      contract: CONTRACT,
      omittedVisuallyInertColors: [],
    })
    expect(contractIsGroundedInEvidence({
      ...CONTRACT,
      colors: ['#081426', '#d4af37', '#ffffff'],
      fonts: ['Segoe UI', 'PingFang SC'],
      requiredMarkers: ['.dark-cover', '.gold-divider', '.square-nav'],
    }, evidence!)).toBe(false)
  })

  it('requires every exact token to be an exact, DOM-connected CSS token', () => {
    const evidence = findReferenceStyleEvidence(fetchMessages(REFERENCE_SOURCE, REFERENCE_HTML), [REFERENCE_DIRECTORY])!
    expect(contractIsGroundedInEvidence({
      ...CONTRACT,
      colors: [...CONTRACT.colors, '#ffffff'],
    }, evidence)).toBe(false)
    expect(contractIsGroundedInEvidence({
      ...CONTRACT,
      fonts: [...CONTRACT.fonts, 'IBM Plex Sans'],
    }, evidence)).toBe(false)
    expect(contractIsGroundedInEvidence({
      ...CONTRACT,
      requiredMarkers: [...CONTRACT.requiredMarkers, '.layout-missing'],
    }, evidence)).toBe(false)

    // Inspired contracts retain their deliberately tolerant discovery gate.
    expect(contractIsGroundedInEvidence({
      ...CONTRACT,
      strictness: 'inspired',
      colors: [...CONTRACT.colors, '#ffffff'],
      fonts: [...CONTRACT.fonts, 'IBM Plex Sans'],
      requiredMarkers: [...CONTRACT.requiredMarkers, '.layout-missing'],
    }, evidence)).toBe(true)
  })

  it('grounds a compound selector only when one connected rule matches the same DOM node', () => {
    const connected = REFERENCE_HTML
      .replace('</style>', '.slide.active { opacity: 1 }</style>')
      .replace('<body>', '<body><section class="slide active"></section>')
    const connectedEvidence = findReferenceStyleEvidence(fetchMessages(REFERENCE_SOURCE, connected), [REFERENCE_DIRECTORY])!
    const compoundContract = {
      ...CONTRACT,
      requiredMarkers: [...CONTRACT.requiredMarkers, '.slide.active'],
    }
    expect(referenceStyleGroundingGaps(compoundContract, connectedEvidence)).toMatchObject({ markers: [] })
    expect(contractIsGroundedInEvidence(compoundContract, connectedEvidence)).toBe(true)

    const stuffed = REFERENCE_HTML
      .replace('</style>', '.slide.active { opacity: 1 }</style>')
      .replace('<body>', '<body><section class="slide"></section><section class="active"></section>')
    const stuffedEvidence = findReferenceStyleEvidence(fetchMessages(REFERENCE_SOURCE, stuffed), [REFERENCE_DIRECTORY])!
    expect(referenceStyleGroundingGaps(compoundContract, stuffedEvidence)).toMatchObject({
      markers: ['.slide.active'],
    })
    expect(contractIsGroundedInEvidence(compoundContract, stuffedEvidence)).toBe(false)
  })

  it('identifies and safely omits a source-declared color from an unused variable', () => {
    const unusedColor = 'rgba(30,43,250,0.15)'
    const withUnusedVariable = REFERENCE_HTML.replace(
      ':root {',
      `:root { --accent-medium: ${unusedColor};`,
    )
    const evidence = findReferenceStyleEvidence(fetchMessages(REFERENCE_SOURCE, withUnusedVariable), [REFERENCE_DIRECTORY])!
    const gaps = referenceStyleGroundingGaps({
      ...CONTRACT,
      colors: [...CONTRACT.colors, unusedColor],
    }, evidence)
    expect(gaps).toEqual({ colors: [unusedColor], fonts: [], markers: [] })

    const normalized = normalizeReferenceStyleContractAgainstEvidence({
      ...CONTRACT,
      colors: [...CONTRACT.colors, unusedColor],
    }, evidence)
    expect(normalized).toEqual({
      contract: CONTRACT,
      omittedVisuallyInertColors: [unusedColor],
    })

    const fabricated = '#123456'
    expect(normalizeReferenceStyleContractAgainstEvidence({
      ...CONTRACT,
      colors: [...CONTRACT.colors, fabricated],
    }, evidence)).toEqual({
      contract: { ...CONTRACT, colors: [...CONTRACT.colors, fabricated] },
      omittedVisuallyInertColors: [],
    })

    const unrelatedEvidence = { ...evidence, requestedUrl: SIBLING_SOURCE, resolvedUrl: SIBLING_SOURCE }
    expect(referenceStyleGroundingGaps(CONTRACT, unrelatedEvidence)).toBeUndefined()
  })

  it('grounds equivalent leading-decimal colors without admitting a different alpha or unused variable', () => {
    const html = REFERENCE_HTML.replace('rgba(30, 43, 250, 0.2)', 'rgba(30, 43, 250, .2)')
      .replace(':root {', ':root { --unused: rgba(30,43,250,.32);')
    const evidence = findReferenceStyleEvidence(fetchMessages(REFERENCE_SOURCE, html), [REFERENCE_DIRECTORY])!
    const shortDecimalContract = { ...CONTRACT, colors: CONTRACT.colors.map((color) => color.replace(',0.2)', ',.2)')) }
    expect(referenceStyleGroundingGaps(shortDecimalContract, evidence)).toEqual({ colors: [], fonts: [], markers: [] })
    expect(contractIsGroundedInEvidence(shortDecimalContract, evidence)).toBe(true)
    expect(verifyHtmlAgainstReferenceStyle(html, shortDecimalContract).fidelity).toBe('pass')
    const normalized = normalizeReferenceStyleContractAgainstEvidence({
      ...shortDecimalContract, colors: [...shortDecimalContract.colors, 'rgba(30,43,250,.32)'],
    }, evidence)
    expect(normalized.omittedVisuallyInertColors).toEqual(['rgba(30,43,250,.32)'])
    expect(normalized.contract.colors).toEqual(shortDecimalContract.colors)
    expect(referenceStyleGroundingGaps({
      ...CONTRACT, colors: [...CONTRACT.colors, 'rgba(30,43,250,.21)'],
    }, evidence)?.colors).toEqual(['rgba(30,43,250,.21)'])
  })

  it('requires the palette of selected source layouts without borrowing colors from an omitted chart', () => {
    const matrix = '<section class="slide matrix"><h1>Chart</h1><p>Demo statistics</p></section>'
    const source = `<!doctype html><html><head><title>Reference</title><style>
      body{background:#fdfae7;color:#111111;font-family:Inter,sans-serif}
      h1{font-family:"Space Grotesk",sans-serif}
      .slide{position:relative;width:1440px;height:900px}
      .cover,.closing{color:#111111}.text{color:#1e2bfa}
      .matrix{color:#060507;background:rgba(30,43,250,.2)}
      </style></head><body><main>
      <section class="slide cover"><h1>Cover</h1></section>
      <section class="slide text"><h1>Story</h1></section>${matrix}
      <section class="slide closing"><h1>Closing</h1></section>
      </main></body></html>`
    const contract = { ...CONTRACT,
      colors: [...CONTRACT.colors, '#060507'], requiredMarkers: ['.slide', '.cover', '.text', '.matrix', '.closing'],
    }
    const profile = extractReferenceStyleSourceProfile(source, contract)!
    expect(profile).toBeDefined()
    const evidence = findReferenceStyleEvidence(fetchMessages(REFERENCE_SOURCE, source), [REFERENCE_DIRECTORY])!
    const candidate = source.replace(matrix, '')
    const baseOptions = { authoritativeRenderedReference: true, alternativeLayoutSelectors: ['.text', '.matrix'] }
    const before = verifyHtmlAgainstReferenceStyle(candidate, contract, profile, baseOptions)
    expect(before.missing.colors).toEqual(['rgba(30,43,250,0.2)', '#060507'])
    const options = { ...baseOptions, boundTemplateSource: evidence }
    const after = verifyHtmlAgainstReferenceStyle(candidate, contract, profile, options)
    expect(after.fidelity).toBe('pass')
    expect(after.score).toBe(100)
    expect(after.missing.colors).toEqual([])
    expect(after.omittedAlternativeLayoutColors).toEqual(['rgba(30,43,250,0.2)', '#060507'])

    // A selected/global color remains mandatory, even if the candidate hides
    // its only consumer. Fabricated contract colors are never silently waived.
    expect(verifyHtmlAgainstReferenceStyle(candidate.replace('.text{color:#1e2bfa}', '.text{color:#111111}'), contract, profile, options)
      .missing.colors).toContain('#1e2bfa')
    expect(verifyHtmlAgainstReferenceStyle(candidate.replace('background:#fdfae7', 'background:#111111'), contract, profile, options)
      .missing.colors).toContain('#fdfae7')
    expect(verifyHtmlAgainstReferenceStyle(candidate, { ...contract, colors: [...contract.colors, '#123456'] }, profile, options)
      .missing.colors).toContain('#123456')
    expect(verifyHtmlAgainstReferenceStyle(source.replace('background:rgba(30,43,250,.2)', 'background:#111111'), contract, profile, options)
      .missing.colors).toContain('rgba(30,43,250,0.2)')
    expect(() => verifyHtmlAgainstReferenceStyle(candidate, contract, profile, {
      ...options, boundTemplateSource: { ...evidence, sha256: '0'.repeat(64) },
    })).toThrow(/source-bound/)
    expect(() => verifyHtmlAgainstReferenceStyle(candidate, contract, profile, {
      ...options, boundTemplateSource: { ...evidence, requestedUrl: SIBLING_SOURCE },
    })).toThrow(/source-bound/)
  })

  it.each(['aria-hidden="true"', 'inert'])(
    'keeps painted decorative DOM visually connected when it is marked %s',
    (semanticAttribute) => {
      const decorativeColor = '#fbd0e3'
      const decorated = REFERENCE_HTML
        .replace(':root {', `:root { --decorative-pink: ${decorativeColor};`)
        .replace(
          '</style>',
          '.poster .lever { background: var(--decorative-pink); border: 4px solid var(--primary); }</style>',
        )
        .replace(
          '<h1>Reference title</h1>',
          `<h1>Reference title</h1><div class="poster" ${semanticAttribute}><div class="lever"></div></div>`,
        )
      const evidence = findReferenceStyleEvidence(
        fetchMessages(REFERENCE_SOURCE, decorated),
        [REFERENCE_DIRECTORY],
      )!

      const normalized = normalizeReferenceStyleContractAgainstEvidence(CONTRACT, evidence)

      expect(normalized.contract.colors).toContain(decorativeColor)
      expect(normalized.omittedVisuallyInertColors).not.toContain(decorativeColor)
      expect(verifyHtmlAgainstReferenceStyle(decorated, normalized.contract).violations.colors).toEqual([])
    },
  )

  it('defers exhaustive compact-palette policing to bound rendered evidence', () => {
    const decorativeColor = '#fbd0e3'
    const source = REFERENCE_HTML
      .replace('</style>', `.poster { background: ${decorativeColor}; }</style>`)
      .replace(
        '<h1>Reference title</h1>',
        '<h1>Reference title</h1><div class="poster" aria-hidden="true"></div>',
      )
    const profile = extractReferenceStyleSourceProfile(source, CONTRACT)!

    expect(verifyHtmlAgainstReferenceStyle(source, CONTRACT, profile)).toMatchObject({
      fidelity: 'mismatch',
      violations: { colors: [decorativeColor] },
    })
    expect(verifyHtmlAgainstReferenceStyle(source, CONTRACT, profile, {
      authoritativeRenderedReference: true,
    })).toMatchObject({
      fidelity: 'pass',
      score: 100,
      violations: { colors: [], source: [] },
    })
  })

  it('adds omitted DOM-connected semantic colors to an exact compact contract', () => {
    const semanticGreen = '#059669'
    const connectedStatusHtml = REFERENCE_HTML
      .replace('</style>', `.metric-change.positive{color:${semanticGreen}}</style>`)
      .replace('</body>', '<span class="metric-change positive">Improving</span></body>')
    const evidence = findReferenceStyleEvidence(
      fetchMessages(REFERENCE_SOURCE, connectedStatusHtml),
      [REFERENCE_DIRECTORY],
    )!

    const normalized = normalizeReferenceStyleContractAgainstEvidence(CONTRACT, evidence)
    expect(normalized).toEqual({
      contract: { ...CONTRACT, colors: [...CONTRACT.colors, semanticGreen] },
      omittedVisuallyInertColors: [],
    })
    expect(extractReferenceStyleSourceProfile(connectedStatusHtml, normalized.contract)?.rules)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          selector: '.metric-change.positive',
          declarations: expect.arrayContaining([{ property: 'color', value: semanticGreen }]),
        }),
      ]))
  })

  it('decodes inline CSS attribute entities without treating body text as a font declaration', () => {
    for (const quote of ['&quot;', '&#34;', '&#x22;']) {
      const html = REFERENCE_HTML.replace('</body>', `<p style="font-family:${quote}Inter${quote},sans-serif">Literal font-family: Example; prose</p></body>`)
      expect(verifyHtmlAgainstReferenceStyle(html, CONTRACT).violations.fonts).toEqual([])
      const changed = html.replace(`${quote}Inter${quote}`, `${quote}Roboto${quote}`)
      expect(verifyHtmlAgainstReferenceStyle(changed, CONTRACT).violations.fonts).toContain('Roboto')
    }
  })

  it('does not confuse color/font substrings or token stuffing in unused selectors with exact grounding', () => {
    const substringHtml = `<!doctype html><html><head><style>
      body{background:#ffffff;color:#111111;font-family:Interstate,sans-serif}
      h1{font-family:'Space Grotesk',sans-serif}.layout-cover{display:flex}
      .cover-dots{display:grid}.progress-bar{position:fixed}.nav-controls{position:fixed}
    </style></head><body><main class="layout-cover"><h1>Title</h1><div class="cover-dots"></div></main><div class="progress-bar"></div><nav class="nav-controls"></nav></body></html>`
    const substringEvidence = findReferenceStyleEvidence(fetchMessages(REFERENCE_SOURCE, substringHtml), [REFERENCE_DIRECTORY])!
    expect(contractIsGroundedInEvidence({
      ...CONTRACT,
      colors: ['#fff', '#111111'],
      fonts: ['Inter', 'Space Grotesk'],
    }, substringEvidence)).toBe(false)

    const unusedHtml = `<!doctype html><html><head><style>
      body{background:#eeeeee;color:#222222;font-family:Arial,sans-serif}
      .actual{display:block}.never-used{background:#fdfae7;color:#111111;border-color:rgba(30,43,250,0.2);font-family:'Inter','Space Grotesk'}
      .layout-cover,.cover-dots,.progress-bar,.nav-controls{color:#1e2bfa}
    </style></head><body><main class="actual">Visible replacement theme</main></body></html>`
    const unusedEvidence = findReferenceStyleEvidence(fetchMessages(REFERENCE_SOURCE, unusedHtml), [REFERENCE_DIRECTORY])!
    expect(contractIsGroundedInEvidence(CONTRACT, unusedEvidence)).toBe(false)
  })

  it('assembles a complete out-of-order fetch_page chain before scoring its exact bytes', () => {
    const chunks = completeReferencePageChunks()
    const evidence = findReferenceStyleEvidence(
      fetchPageMessages([chunks[2], chunks[0], chunks[1]]),
      [REFERENCE_DIRECTORY],
    )
    expect(evidence).toMatchObject({
      call: { id: 'fetch-page-0', name: 'fetch_page' },
      callIds: ['fetch-page-0', 'fetch-page-1', 'fetch-page-2'],
      requestedUrl: REFERENCE_SOURCE,
      resolvedUrl: REFERENCE_SOURCE,
      content: REFERENCE_HTML,
      sha256: createHash('sha256').update(REFERENCE_HTML).digest('hex'),
      bytes: Buffer.byteLength(REFERENCE_HTML),
    })
  })

  it('fails closed when a fetch_page chain is missing chunk zero or an interior chunk', () => {
    const chunks = completeReferencePageChunks()
    expect(findReferenceStyleEvidence(
      fetchPageMessages([chunks[0], chunks[2]]),
      [REFERENCE_DIRECTORY],
    )).toBeUndefined()
    expect(findReferenceStyleEvidence(
      fetchPageMessages([chunks[1], chunks[2]]),
      [REFERENCE_DIRECTORY],
    )).toBeUndefined()
  })

  it('fails closed when fetch_page continuation flags contradict the chain boundary', () => {
    const finalHasMore = completeReferencePageChunks()
    finalHasMore[2] = { ...finalHasMore[2], hasMore: true }
    expect(findReferenceStyleEvidence(fetchPageMessages(finalHasMore), [REFERENCE_DIRECTORY])).toBeUndefined()

    const earlyTerminal = completeReferencePageChunks()
    earlyTerminal[1] = { ...earlyTerminal[1], hasMore: false }
    expect(findReferenceStyleEvidence(fetchPageMessages(earlyTerminal), [REFERENCE_DIRECTORY])).toBeUndefined()
  })

  it('deduplicates byte-identical fetch_page replay while conflicting duplicates fail closed', () => {
    const replayed = completeReferencePageChunks()
    const duplicate = { ...replayed[1], id: 'fetch-page-1-replayed' }
    const replayMessages = fetchPageMessages([
      replayed[0],
      replayed[1],
      duplicate,
      replayed[2],
    ])
    expect(findReferenceStyleEvidence(replayMessages, [REFERENCE_DIRECTORY])).toMatchObject({
      content: REFERENCE_HTML,
      callIds: ['fetch-page-0', 'fetch-page-1-replayed', 'fetch-page-2'],
    })
    expect(completedReferenceStyleFetchForCall(
      replayMessages,
      [REFERENCE_DIRECTORY],
      'fetch-page-1-replayed',
    )).toMatchObject({ content: REFERENCE_HTML })

    const continuing = completeReferencePageChunks()
    expect(referenceStyleEvidenceContinuation(fetchPageMessages([
      continuing[0],
      { ...continuing[0], id: 'fetch-page-0-replayed' },
    ]), [REFERENCE_DIRECTORY])).toEqual({
      url: REFERENCE_SOURCE,
      format: 'raw',
      nextChunkIndex: 1,
      totalChunks: 3,
      callIds: ['fetch-page-0-replayed'],
    })

    const inconsistentTotals = completeReferencePageChunks()
    inconsistentTotals[1] = { ...inconsistentTotals[1], totalChunks: 4 }
    expect(findReferenceStyleEvidence(fetchPageMessages(inconsistentTotals), [REFERENCE_DIRECTORY])).toBeUndefined()

    const chunks = completeReferencePageChunks()
    expect(findReferenceStyleEvidence(fetchPageMessages([
      chunks[0],
      chunks[1],
      { ...chunks[1], id: 'fetch-page-1-conflict', content: `${chunks[1].content}conflict` },
      chunks[2],
    ]), [REFERENCE_DIRECTORY])).toBeUndefined()
  })

  it('never combines fetch_page chunks across formats or resolved URLs', () => {
    const mixedFormats = completeReferencePageChunks()
    mixedFormats[1] = { ...mixedFormats[1], format: 'markdown' }
    expect(findReferenceStyleEvidence(fetchPageMessages(mixedFormats), [REFERENCE_DIRECTORY])).toBeUndefined()

    const changedResolution = completeReferencePageChunks()
    changedResolution[1] = { ...changedResolution[1], resolvedUrl: `${REFERENCE_SOURCE}?mirror=1` }
    expect(findReferenceStyleEvidence(fetchPageMessages(changedResolution), [REFERENCE_DIRECTORY])).toBeUndefined()
  })

  it('accepts a valid single-chunk fetch_page response, with or without an explicit total', () => {
    for (const totalChunks of [1, undefined]) {
      const evidence = findReferenceStyleEvidence(fetchPageMessages([{
        id: `single-${String(totalChunks)}`,
        chunkIndex: 0,
        content: REFERENCE_HTML,
        hasMore: false,
        ...(totalChunks === undefined ? {} : { totalChunks }),
      }]), [REFERENCE_DIRECTORY])
      expect(evidence).toMatchObject({
        callIds: [`single-${String(totalChunks)}`],
        content: REFERENCE_HTML,
        bytes: Buffer.byteLength(REFERENCE_HTML),
      })
    }
  })

  it('reports only an internally consistent next fetch_page continuation', () => {
    const chunks = completeReferencePageChunks()
    expect(referenceStyleEvidenceContinuation(
      fetchPageMessages([chunks[0], chunks[2]]),
      [REFERENCE_DIRECTORY],
    )).toEqual({
      url: REFERENCE_SOURCE,
      format: 'raw',
      nextChunkIndex: 1,
      totalChunks: 3,
      callIds: ['fetch-page-0', 'fetch-page-2'],
    })
    expect(referenceStyleEvidenceContinuation(
      fetchPageMessages(chunks),
      [REFERENCE_DIRECTORY],
    )).toBeUndefined()

    const inconsistent = completeReferencePageChunks()
    inconsistent[2] = { ...inconsistent[2], hasMore: true }
    expect(referenceStyleEvidenceContinuation(
      fetchPageMessages(inconsistent),
      [REFERENCE_DIRECTORY],
    )).toBeUndefined()
  })

  it('requires distinctive structural markers rather than generic token stuffing', () => {
    expect(() => normalizeReferenceStyleContract({
      ...CONTRACT,
      source_url: CONTRACT.sourceUrl,
      required_markers: ['body', 'font-family'],
    })).toThrow(/concrete source token|distinctive source selectors/iu)
  })

  it('normalizes model-friendly labeled design entries into compact literal tokens', () => {
    expect(normalizeReferenceStyleContract({
      ...CONTRACT,
      source_url: CONTRACT.sourceUrl,
      colors: [
        'bg #fdfae7 (warm cream canvas)',
        'primary #1E2BFA single saturated cobalt',
        'border rgba(30, 43, 250, 0.2)',
      ],
      fonts: [
        'Space Grotesk 300-700 (display, numerals, and chrome)',
        'Inter 300-600 (body and list copy)',
      ],
      required_markers: [
        '--bg:#fdfae7; --primary:#1e2bfa',
        'nav-btn: 44px circular navigation control',
        'progress-bar: fixed 3px bottom indicator',
      ],
    })).toMatchObject({
      colors: ['#fdfae7', '#1e2bfa', 'rgba(30,43,250,0.2)'],
      fonts: ['Space Grotesk', 'Inter'],
      requiredMarkers: ['--bg', 'nav-btn', 'progress-bar'],
    })
  })

  it('accepts and grounds the real pink-script custom element and selector markers', () => {
    expect(normalizeReferenceContractMarker('deck-stage > section.slide')).toBe('deck-stage>section.slide')
    expect(normalizeReferenceContractMarker('deck-stage')).toBe('deck-stage')
    expect(normalizeReferenceContractMarker('.runner')).toBe('.runner')

    const contract = normalizeReferenceStyleContract({
      ...CONTRACT,
      source_url: PINK_SCRIPT_SOURCE,
      colors: ['#060507', '#f5edf1', '#ed3d8c'],
      fonts: ['DM Serif Display', 'Inter', 'JetBrains Mono'],
      required_markers: [
        'deck-stage', 'section.slide', '.runner', '.footer', '.script',
        '.s-cover', '.s-toc', '.s-stats', '.s-section', '.s-quote',
      ],
      viewport: { width: 1920, height: 1080 },
    })
    const evidence = findReferenceStyleEvidence(
      fetchMessages(PINK_SCRIPT_SOURCE, PINK_SCRIPT_MARKER_HTML),
      [PINK_SCRIPT_SOURCE],
    )
    expect(evidence).toBeDefined()
    expect(referenceStyleGroundingGaps(contract, evidence!)).toEqual({
      colors: [], fonts: [], markers: [],
    })
    expect(contractIsGroundedInEvidence(contract, evidence!)).toBe(true)
  })

  it('identifies the exact invalid marker entry instead of returning a generic array error', () => {
    expect(() => normalizeReferenceStyleContract({
      ...CONTRACT,
      source_url: CONTRACT.sourceUrl,
      required_markers: ['.runner', 'generic visual label'],
    })).toThrow('required_markers[1] "generic visual label" must contain one concrete source token')
  })

  it('fails the prior navy-and-gold redesign and ignores required tokens hidden in comments or scripts', () => {
    const priorCandidate = `<!doctype html><html><head><style>
      :root { --navy: #081426; --gold: #d4af37; }
      body { background: linear-gradient(135deg, #081426, #123769); font-family: 'Segoe UI', sans-serif; }
      .card { background: #ffffff; box-shadow: 0 12px 30px rgba(0,0,0,.2); }
    </style>
    <!-- #fdfae7 #1e2bfa Space Grotesk Inter .layout-cover .cover-dots .progress-bar .nav-controls -->
    <script>const fakeReferenceTokens = '#fdfae7 #1e2bfa Space Grotesk Inter .layout-cover .progress-bar';</script>
    </head><body><main class="card">Corporate blue deck</main></body></html>`

    const priorVerification = verifyHtmlAgainstReferenceStyle(priorCandidate, CONTRACT)
    expect(priorVerification).toMatchObject({
      fidelity: 'mismatch',
      matched: { colors: [], fonts: [], markers: [] },
      missing: {
        colors: CONTRACT.colors,
        fonts: CONTRACT.fonts,
        markers: CONTRACT.requiredMarkers,
      },
      violations: {
        colors: expect.arrayContaining(['#081426', '#d4af37', '#123769']),
        fonts: ['Segoe UI'],
        avoid: ['card/content box-shadow contradicts the StyleContract'],
      },
    })
    expect(verifyHtmlAgainstReferenceStyle(REFERENCE_HTML, CONTRACT)).toMatchObject({
      fidelity: 'pass',
      score: 100,
      missing: { colors: [], fonts: [], markers: [] },
      thresholds: {
        colors: CONTRACT.colors.length,
        fonts: CONTRACT.fonts.length,
        markers: CONTRACT.requiredMarkers.length,
      },
    })

    const withoutOneColor = REFERENCE_HTML
      .replace('--border: rgba(30, 43, 250, 0.2);', '')
      .replace('border: 1px solid var(--border);', '')
    expect(verifyHtmlAgainstReferenceStyle(withoutOneColor, CONTRACT)).toMatchObject({
      fidelity: 'mismatch',
      missing: { colors: ['rgba(30,43,250,0.2)'] },
    })
    const withoutOneFont = REFERENCE_HTML.replace(/'Space Grotesk'/gu, "'Inter'")
    expect(verifyHtmlAgainstReferenceStyle(withoutOneFont, CONTRACT)).toMatchObject({
      fidelity: 'mismatch',
      missing: { fonts: ['Space Grotesk'] },
    })
    const withoutOneMarker = REFERENCE_HTML
      .replace('class="nav-controls"', 'class="local-controls"')
      .replace('.nav-controls {', '.local-controls {')
    expect(verifyHtmlAgainstReferenceStyle(withoutOneMarker, CONTRACT)).toMatchObject({
      fidelity: 'mismatch',
      missing: { markers: ['.nav-controls'] },
    })
  })

  it('does not pass when unused reference CSS is token-stuffed beside an active replacement theme', () => {
    const stuffed = `<!doctype html><html><head><style>
      :root { --reference-bg:#fdfae7; --reference-primary:#1e2bfa; --reference-text:#111111; --reference-border:rgba(30,43,250,0.2); }
      .layout-cover,.cover-dots,.progress-bar,.nav-controls { font-family:'Space Grotesk'; color:var(--reference-primary); }
      .reference-body-never-used { font-family:'Inter'; }
      body { background:#081426; color:#d4af37; font-family:'Segoe UI',sans-serif; }
    </style></head><body><main>Different active theme</main></body></html>`
    const verification = verifyHtmlAgainstReferenceStyle(stuffed, CONTRACT)
    expect(verification.matched).toEqual({
      colors: [],
      fonts: [],
      markers: [],
    })
    expect(verification).toMatchObject({
      fidelity: 'mismatch',
      violations: {
        colors: expect.arrayContaining(['#081426', '#d4af37']),
        fonts: ['Segoe UI'],
      },
    })
  })

  it('binds the real blue-professional root canvas, tag typography, and agenda interior without binding copy', () => {
    const profile = extractReferenceStyleSourceProfile(BLUE_PROFESSIONAL_REGRESSION_HTML, CONTRACT)
    expect(profile).toBeDefined()
    expect(profile!.rules.map((rule) => rule.selector)).toEqual(expect.arrayContaining([
      'html', 'body', 'h1', 'h2', 'h3', 'h4', 'p', 'li', '.layout-agenda .agenda-grid',
    ]))
    expect(verifyHtmlAgainstReferenceStyle(BLUE_PROFESSIONAL_REGRESSION_HTML, CONTRACT, profile)).toMatchObject({
      fidelity: 'pass', score: 100, violations: { source: [] },
    })

    const copyOnly = BLUE_PROFESSIONAL_REGRESSION_HTML
      .replace('Market Outlook', '本周人工智能热点')
      .replace('Executive Summary', '模型与基础设施')
      .replace('Reference body copy.', '可替换的新闻摘要与来源说明。')
    expect(verifyHtmlAgainstReferenceStyle(copyOnly, CONTRACT, profile)).toMatchObject({
      fidelity: 'pass', violations: { source: [] },
    })

    const equivalentSignedDecimal = BLUE_PROFESSIONAL_REGRESSION_HTML
      .replace('letter-spacing:-0.02em', 'letter-spacing:-.02em')
    expect(verifyHtmlAgainstReferenceStyle(equivalentSignedDecimal, CONTRACT, profile)).toMatchObject({
      fidelity: 'pass', score: 100, violations: { source: [] },
    })

    const rootDrift = BLUE_PROFESSIONAL_REGRESSION_HTML.replace(
      'background:var(--bg);color:var(--text)',
      'background:var(--primary);color:var(--text)',
    )
    expect(verifyHtmlAgainstReferenceStyle(rootDrift, CONTRACT, profile).violations.source.join('\n'))
      .toMatch(/source (?:html|body) background.*var\(--primary\)/iu)

    const headingDrift = BLUE_PROFESSIONAL_REGRESSION_HTML.replace(
      'font-size:clamp(2.8rem,5vw,4.2rem)',
      'font-size:1rem',
    )
    expect(verifyHtmlAgainstReferenceStyle(headingDrift, CONTRACT, profile).violations.source.join('\n'))
      .toMatch(/source h1 font-size.*1rem/iu)

    const agendaDrift = BLUE_PROFESSIONAL_REGRESSION_HTML.replace(
      '.layout-agenda .agenda-grid{display:grid',
      '.layout-agenda .agenda-grid{display:block',
    )
    expect(verifyHtmlAgainstReferenceStyle(agendaDrift, CONTRACT, profile).violations.source.join('\n'))
      .toMatch(/layout-agenda \.agenda-grid display.*block/iu)
  })

  it('treats a Browser-attested active slide override as connected while deferring runtime stacking mechanics', () => {
    const contract: ReferenceStyleContract = {
      sourceUrl: 'https://example.com/runtime-deck.html',
      strictness: 'exact',
      colors: ['#000000', '#f5edf1', '#1a1218', '#0a0709', '#ed3d8c'],
      fonts: ['Inter'],
      layout: ['fixed viewport stage', 'state-controlled slide stack'],
      components: ['slide root', 'runner chrome'],
      requiredMarkers: ['deck-stage>section.slide', '.runner'],
      signature: 'Dark editorial runtime deck.',
      avoid: ['card shadows'],
      viewport: { width: 1440, height: 900 },
    }
    const source = `<!doctype html><html><head><style>
      body{background:#000000;color:#f5edf1;font-family:Inter,sans-serif}
      deck-stage>section.slide{position:relative;width:100vw;height:100vh;background:linear-gradient(135deg,#1a1218,#0a0709);color:#f5edf1}
      .runner{color:#ed3d8c}
    </style></head><body><deck-stage>
      <section class="slide"><div class="runner">Cover</div></section>
      <section class="slide"><div class="runner">Content</div></section>
      <section class="slide"><div class="runner">Closing</div></section>
    </deck-stage></body></html>`
    const profile = extractReferenceStyleSourceProfile(source, contract)!
    const standalone = source
      .replace(
        'position:relative;width:100vw',
        'position:absolute;inset:0;opacity:0;visibility:hidden;width:100vw',
      )
      .replace('</style>', 'deck-stage>section.slide.active{opacity:1;visibility:visible}</style>')
      .replace('class="slide"', 'class="slide active"')

    const legacy = verifyHtmlAgainstReferenceStyle(standalone, contract, profile)
    expect(legacy.fidelity).toBe('mismatch')
    expect(legacy.missing.colors).toEqual(expect.arrayContaining(['#1a1218', '#0a0709']))
    expect(legacy.missing.markers).toContain('deck-stage>section.slide')

    const runtimeAware = verifyHtmlAgainstReferenceStyle(standalone, contract, profile, {
      runtimeManagedSlideSelectors: ['deck-stage>section.slide'],
    })
    expect(runtimeAware, runtimeAware.violations.source.join('\n')).toMatchObject({
      fidelity: 'pass',
      score: 100,
      missing: { colors: [], fonts: [], markers: [] },
      violations: { source: [] },
    })

    const unactivated = standalone.replace(
      'deck-stage>section.slide.active{opacity:1;visibility:visible}',
      'deck-stage>section.unrelated.active{opacity:1;visibility:visible}',
    )
    const rejected = verifyHtmlAgainstReferenceStyle(unactivated, contract, profile, {
      runtimeManagedSlideSelectors: ['deck-stage>section.slide'],
    })
    expect(rejected.fidelity).toBe('mismatch')
    expect(rejected.missing.markers).toContain('deck-stage>section.slide')
  })

  it('retains real blue-professional semantic palette carriers after compact-profile bounding', () => {
    const semanticGreen = '#059669'
    const semanticRed = '#dc2626'
    const profile = extractReferenceStyleSourceProfile(BLUE_PROFESSIONAL_TEMPLATE_HTML, {
      ...CONTRACT,
      colors: [...CONTRACT.colors, semanticGreen, semanticRed],
    })

    expect(profile).toBeDefined()
    expect(Buffer.byteLength(JSON.stringify(profile))).toBeLessThanOrEqual(12 * 1_024)
    expect(profile!.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        selector: '.metric-change.positive',
        declarations: expect.arrayContaining([{ property: 'color', value: semanticGreen }]),
      }),
      expect.objectContaining({
        selector: '.metric-change.negative',
        declarations: expect.arrayContaining([{ property: 'color', value: semanticRed }]),
      }),
    ]))
  })

  it('profiles source selector declarations and rejects the real-world geometry, font, and DOM-use drifts', () => {
    const source = `<!doctype html><html><head><style>
      :root { --bg:#fdfae7; --primary:#1e2bfa; --accent-light:rgba(30,43,250,0.2); --text:#111111; }
      body { background:var(--bg); color:var(--text); font-family:'Inter',sans-serif; }
      h1,h2 { font-family:'Space Grotesk',sans-serif; }
      .layout-cover::after { content:''; position:absolute; width:35vw; height:100%; top:0; right:0; background:var(--accent-light); clip-path:polygon(30% 0,100% 0,100% 100%,0 100%); }
      .cover-dots { position:absolute; right:4vw; bottom:4vw; display:grid; grid-template-columns:repeat(3,6px); gap:12px; opacity:.25; color:var(--primary); }
      .cover-dots span { width:6px; height:6px; background:var(--primary); border-radius:50%; }
      .accent-line { width:72px; height:4px; background:var(--primary); }
      .metric-label { color:var(--text); font-weight:600; letter-spacing:.04em; }
      .bar-track { width:100%; height:28px; background:var(--accent-light); border-radius:12px; }
      .split-highlight { padding:24px; background:var(--accent-light); border-radius:12px; }
      .step-circle { width:48px; height:48px; background:var(--primary); border-radius:50%; }
      .keyboard-hint { position:fixed; right:24px; bottom:18px; opacity:.55; }
      .progress-bar { position:fixed; height:3px; bottom:0; background:var(--primary); }
      .nav-controls { position:fixed; right:24px; bottom:24px; }
    </style></head><body>
      <section class="layout-cover"><h1>Reference title</h1><div class="accent-line"></div><div class="cover-dots"><span></span></div></section>
      <div class="metric-label">Reach</div><div class="bar-track"></div><div class="split-highlight">Signal</div>
      <div class="step-circle" style="opacity:.75"></div><div class="step-circle" style="opacity:.55"></div><div class="step-circle" style="opacity:.35"></div>
      <div class="keyboard-hint">Use arrows</div><div class="progress-bar"></div><nav class="nav-controls"></nav>
    </body></html>`
    const profile = extractReferenceStyleSourceProfile(source, CONTRACT)
    expect(profile).toBeDefined()
    expect(Buffer.byteLength(JSON.stringify(profile))).toBeLessThanOrEqual(12 * 1_024)
    expect(profile!.rules.length).toBeLessThanOrEqual(64)
    expect(profile!.rules.every((rule) => rule.declarations.length <= 16)).toBe(true)
    expect(profile!.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ selector: '.layout-cover::after', requiredInDom: true }),
      expect.objectContaining({ selector: '.metric-label', effectiveFontFamily: 'inter,sans-serif' }),
      expect.objectContaining({ selector: '.bar-track' }),
      expect.objectContaining({ selector: '.split-highlight' }),
    ]))
    expect(profile!.dom).toEqual(expect.arrayContaining([
      expect.objectContaining({ className: 'accent-line', required: true }),
      expect.objectContaining({ className: 'keyboard-hint', required: true }),
      expect.objectContaining({
        className: 'step-circle',
        inlineStyleVariants: [{ property: 'opacity', values: ['0.75', '0.55', '0.35'] }],
      }),
    ]))
    expect(verifyHtmlAgainstReferenceStyle(source, CONTRACT, profile)).toMatchObject({
      fidelity: 'pass',
      score: 100,
      violations: { source: [] },
    })

    const drift = `<!doctype html><html><head><style>
      :root { --bg:#fdfae7; --primary:#1e2bfa; --accent-light:rgba(30,43,250,0.2); --text:#111111; }
      body { background:var(--bg); color:var(--text); font-family:'Inter',sans-serif; }
      h1,h2 { font-family:'Space Grotesk',sans-serif; }
      .layout-cover::after { content:''; position:absolute; width:42%; height:100%; top:0; right:0; background:var(--primary); clip-path:polygon(30% 0,100% 0,100% 100%,0 100%); }
      .cover-dots { position:absolute; right:4vw; top:4vw; display:grid; grid-template-columns:repeat(3,10px); gap:22px; opacity:1; color:var(--bg); }
      .cover-dots span { width:10px; height:10px; background:var(--bg); border-radius:50%; }
      .accent-line { width:72px; height:4px; background:var(--primary); }
      .metric-label { color:var(--text); font-family:'Space Grotesk',sans-serif; font-weight:500; letter-spacing:.04em; }
      .bar-track { width:100%; height:12px; background:var(--accent-light); border-radius:12px; }
      .split-highlight { padding:24px; background:var(--accent-light); border-radius:0 14px 14px 0; }
      .step-circle { width:48px; height:48px; background:var(--primary); border-radius:50%; }
      .keyboard-hint { position:fixed; right:24px; bottom:18px; opacity:.55; }
      .progress-bar { position:fixed; height:3px; bottom:0; background:var(--primary); }
      .nav-controls { position:fixed; right:24px; bottom:24px; }
    </style></head><body>
      <section class="layout-cover"><div class="cover-dots"><span></span></div></section>
      <div class="metric-label">Reach</div><div class="bar-track"></div><div class="split-highlight">Signal</div>
      <div class="step-circle" style="opacity:.5"></div><div class="step-circle" style="opacity:.5"></div><div class="step-circle" style="opacity:.5"></div>
      <div class="progress-bar"></div><nav class="nav-controls"></nav>
    </body></html>`
    const verification = verifyHtmlAgainstReferenceStyle(drift, CONTRACT, profile)
    expect(verification.fidelity).toBe('mismatch')
    expect(verification.score).toBeLessThan(100)
    const sourceViolations = verification.violations.source.join('\n')
    expect(sourceViolations).toMatch(/layout-cover::after background/iu)
    expect(sourceViolations).toMatch(/layout-cover::after width/iu)
    expect(sourceViolations).toMatch(/cover-dots (?:bottom|gap|opacity|color)/iu)
    expect(sourceViolations).toMatch(/accent-line.*(?:not used|missing)/iu)
    expect(sourceViolations).toMatch(/metric-label effective font-family/iu)
    expect(sourceViolations).toMatch(/bar-track height/iu)
    expect(sourceViolations).toMatch(/split-highlight border-radius/iu)
    expect(sourceViolations).toMatch(/step-circle inline opacity.*variant/iu)
    expect(sourceViolations).toMatch(/keyboard-hint/iu)
  })

  it('reports a missing inline variant as one complete set invariant', () => {
    const profile: ReferenceStyleSourceProfile = {
      version: 1,
      rules: [],
      dom: [{
        className: 'mono',
        occurrences: 2,
        required: true,
        inlineStyleVariants: [{ property: 'opacity', values: ['0.5', '0.7'] }],
      }],
    }
    const onlySeven = REFERENCE_HTML.replace(
      '</body>',
      '<span class="mono" style="opacity:.7">07</span></body>',
    )
    const mismatch = verifyHtmlAgainstReferenceStyle(onlySeven, CONTRACT, profile)
    expect(mismatch.inlineVariantGaps).toEqual([{
      className: 'mono',
      property: 'opacity',
      required: ['0.5', '0.7'],
      current: ['0.7'],
      missing: ['0.5'],
    }])
    expect(mismatch.violations.source).toHaveLength(1)
    expect(mismatch.violations.source[0]).toContain('required ["0.5","0.7"]')
    expect(mismatch.violations.source[0]).toContain('current ["0.7"]')
    expect(mismatch.violations.source[0]).toContain('missing ["0.5"]')
    expect(mismatch.violations.source[0]).toContain('instead of replacing one required variant with another')

    const both = REFERENCE_HTML.replace(
      '</body>',
      '<span class="mono" style="opacity:.7">07</span><span class="mono" style="opacity:.5">05</span></body>',
    )
    const converged = verifyHtmlAgainstReferenceStyle(both, CONTRACT, profile)
    expect(converged.inlineVariantGaps).toEqual([])
    expect(converged.violations.source).toEqual([])
  })

  it('treats Browser-captured interior layout roots as alternatives for shorter decks', () => {
    const contract: ReferenceStyleContract = {
      sourceUrl: 'https://example.com/editorial.html',
      strictness: 'exact',
      colors: ['#ffffff', '#111111'],
      fonts: ['Arial'],
      layout: ['fixed slide stage', 'alternative interior layouts'],
      components: ['cover', 'closing'],
      requiredMarkers: ['.cover', '.layout-a .a-card', '.layout-b .b-chart', '.closing'],
      signature: 'A small exact reference fixture.',
      avoid: ['gradients'],
      viewport: { width: 1440, height: 900 },
    }
    const source = `<style>
      body{background:#ffffff;color:#111111;font-family:Arial,sans-serif}
      .cover,.closing{position:relative;width:100vw;height:100vh}
      .layout-a{position:relative;display:grid;grid-template-columns:1fr 1fr}
      .layout-a .a-card{display:flex;gap:12px}
      .layout-b{position:relative;display:flex;gap:24px}
      .layout-b .b-chart{display:grid;grid-template-columns:2fr 1fr}
    </style><body><section class="cover"></section><section class="layout-a"><div class="a-card"></div></section><section class="layout-b"><div class="b-chart"></div></section><section class="closing"></section></body>`
    const profile = extractReferenceStyleSourceProfile(source, contract)!
    const shorter = source.replace('<section class="layout-b"><div class="b-chart"></div></section>', '')

    const legacy = verifyHtmlAgainstReferenceStyle(shorter, contract, profile)
    expect(legacy.fidelity).toBe('mismatch')
    expect(legacy.missing.markers).toContain('.layout-b .b-chart')

    const adapted = verifyHtmlAgainstReferenceStyle(shorter, contract, profile, {
      alternativeLayoutSelectors: ['.layout-a', '.layout-b'],
    })
    expect(adapted, adapted.violations.source.join('\n')).toMatchObject({
      fidelity: 'pass',
      score: 100,
      missing: { markers: [] },
      violations: { source: [] },
    })

    const stacked = shorter
      .replace('class="cover"', 'class="cover slide"')
      .replace('class="layout-a"', 'class="layout-a layout-b slide"')
      .replace('class="closing"', 'class="closing slide"')
    const rejectedStack = verifyHtmlAgainstReferenceStyle(stacked, contract, profile, {
      alternativeLayoutSelectors: ['.layout-a', '.layout-b'],
    })
    expect(rejectedStack.fidelity).toBe('mismatch')
    expect(rejectedStack.violations.source.join('\n')).toMatch(
      /interior slide 2 stacks alternative layout roots.*\.layout-a.*\.layout-b.*remove every surplus root class/iu,
    )
  })

  it('applies the same source-profile gate to an unrelated template vocabulary', () => {
    const contract: ReferenceStyleContract = {
      ...CONTRACT,
      sourceUrl: 'https://example.com/templates/editorial-sunrise.html',
      colors: ['#fff8ee', '#e4522f', '#202020'],
      fonts: ['Fraunces', 'IBM Plex Sans'],
      requiredMarkers: ['.hero-stripe', '.pager'],
    }
    const source = `<style>
      body{background:#fff8ee;color:#202020;font-family:'IBM Plex Sans',sans-serif}
      h1{font-family:'Fraunces',serif}
      .hero-stripe{position:absolute;left:0;width:18%;height:100%;background:#e4522f}
      .tile-label{font-family:'IBM Plex Sans',sans-serif;font-weight:600;border-radius:2px}
      .pager{position:fixed;right:32px;bottom:28px;color:#e4522f}
      @media (max-height:700px){.hero-stripe{width:44%}}
    </style><body><main><h1>Field report</h1><div class="hero-stripe"></div><div class="tile-label">Field note</div><div class="pager">1/4</div></main></body>`
    const profile = extractReferenceStyleSourceProfile(source, contract)
    expect(profile?.rules.map((rule) => rule.selector)).toEqual(expect.arrayContaining(['.hero-stripe', '.tile-label', '.pager']))
    expect(profile?.rules.find((rule) => rule.selector === '.hero-stripe')?.declarations).toContainEqual({ property: 'width', value: '18%' })
    expect(verifyHtmlAgainstReferenceStyle(source, contract, profile).fidelity).toBe('pass')
    const drift = source
      .replace('width:18%', 'width:44%')
      .replace(".tile-label{font-family:'IBM Plex Sans',sans-serif", ".tile-label{font-family:'Fraunces',serif")
    const verification = verifyHtmlAgainstReferenceStyle(drift, contract, profile)
    expect(verification.fidelity).toBe('mismatch')
    expect(verification.violations.source.join('\n')).toMatch(/hero-stripe width/iu)
    expect(verification.violations.source.join('\n')).toMatch(/tile-label font-family/iu)
  })

  it('keeps uncontracted demo components conditional, requires contract markers, and ignores data-driven widths', () => {
    const contract: ReferenceStyleContract = {
      ...CONTRACT,
      colors: ['#fdfae7', '#1e2bfa', '#111111'],
      requiredMarkers: ['.layout-cover', '.metric-card'],
    }
    const source = `<style>
      body{background:#fdfae7;color:#111111;font-family:Inter,sans-serif}
      h1{font-family:'Space Grotesk',sans-serif}
      .layout-cover{display:flex;background:#fdfae7}
      .metric-card{padding:20px;background:#fdfae7}
      .metric-card .metric-label{font-family:Inter,sans-serif;font-weight:600;color:#111111}
      .layout-quote .quote-decoration{position:absolute;width:40px;background:#1e2bfa}
      .bar-fill{height:100%;background:#1e2bfa}
      .step-circle{width:40px;height:40px;background:#1e2bfa}
    </style><main class="layout-cover"><h1>Reference title</h1><div class="metric-card"><span class="metric-label">Metric</span></div>
      <div class="layout-quote"><div class="quote-decoration"></div></div>
      <div class="bar-fill" style="width:79%"></div><div class="step-circle" style="opacity:.55"></div></main>`
    const profile = extractReferenceStyleSourceProfile(source, contract)!
    expect(profile.rules.find((rule) => rule.selector === '.metric-card')?.requiredInDom).toBe(true)
    expect(profile.rules.find((rule) => rule.selector === '.layout-quote .quote-decoration')?.requiredInDom).toBe(false)
    expect(profile.dom.find((entry) => entry.className === 'bar-fill')?.inlineStyleVariants).toBeUndefined()

    const withoutDemoComponents = source
      .replace('<div class="layout-quote"><div class="quote-decoration"></div></div>', '')
      .replace('<div class="step-circle" style="opacity:.55"></div>', '')
      .replace('style="width:79%"', 'style="width:31%"')
    expect(verifyHtmlAgainstReferenceStyle(withoutDemoComponents, contract, profile)).toMatchObject({
      fidelity: 'pass', violations: { source: [] },
    })

    const usedMetricDrift = source.replace(
      'font-family:Inter,sans-serif;font-weight:600',
      "font-family:'Space Grotesk',sans-serif;font-weight:500",
    )
    expect(verifyHtmlAgainstReferenceStyle(usedMetricDrift, contract, profile).violations.source.join('\n')).toMatch(/metric-label.*(?:font-family|font-weight)/iu)
  })

  it('rejects inert or hidden DOM stuffing and requires structural selectors to share a real relationship', () => {
    const source = `<style>
      body{background:#fdfae7;color:#111111;font-family:Inter,sans-serif}h1{font-family:'Space Grotesk',sans-serif}
      .layout-cover .cover-dots{display:grid;gap:12px;color:#1e2bfa}
      .progress-bar{position:fixed;height:3px;background:#1e2bfa}.nav-controls{position:fixed;color:#1e2bfa}
    </style><main class="layout-cover"><div class="cover-dots"></div></main><div class="progress-bar"></div><nav class="nav-controls"></nav>`
    const profile = extractReferenceStyleSourceProfile(source, CONTRACT)!
    expect(profile.rules).toContainEqual(expect.objectContaining({ selector: '.layout-cover .cover-dots', requiredInDom: true }))

    const scattered = source.replace(
      '<main class="layout-cover"><div class="cover-dots"></div></main>',
      '<main class="layout-cover"></main><div class="cover-dots"></div>',
    )
    expect(verifyHtmlAgainstReferenceStyle(scattered, CONTRACT, profile).violations.source.join('\n'))
      .toMatch(/same candidate DOM relationship/iu)

    const stuffed = source.replace(
      '<main class="layout-cover"><div class="cover-dots"></div></main><div class="progress-bar"></div><nav class="nav-controls"></nav>',
      '<main class="layout-cover"><template><div class="cover-dots"></div></template></main>'
        + '<noscript><div class="progress-bar"></div></noscript><div inert><nav class="nav-controls"></nav></div>',
    )
    const stuffedViolations = verifyHtmlAgainstReferenceStyle(stuffed, CONTRACT, profile).violations.source.join('\n')
    expect(stuffedViolations).toMatch(/cover-dots.*<template> subtree/iu)
    expect(stuffedViolations).toMatch(/progress-bar.*<noscript> subtree/iu)
    expect(stuffedViolations).toMatch(/nav-controls.*inert attribute/iu)

    for (const hiddenStyle of ['display:none', 'visibility:hidden', 'opacity:0']) {
      const hidden = source.replace('class="progress-bar"', `class="progress-bar" style="${hiddenStyle}"`)
      expect(verifyHtmlAgainstReferenceStyle(hidden, CONTRACT, profile).violations.source.join('\n'))
        .toMatch(new RegExp(`progress-bar.*inline ${hiddenStyle.replace(':', ':')}`, 'iu'))
    }
  })

  it('evaluates modern media-query range syntax at the contract viewport', () => {
    const source = `<style>
      body{background:#fdfae7;color:#111111;font-family:Inter,sans-serif}h1{font-family:'Space Grotesk',sans-serif}
      .layout-cover{display:flex}.cover-dots{display:grid;gap:12px;color:#1e2bfa}
      .progress-bar{height:3px;background:#1e2bfa}.nav-controls{position:fixed;color:#1e2bfa}
    </style><main class="layout-cover"><div class="cover-dots"></div></main><div class="progress-bar"></div><nav class="nav-controls"></nav>`
    const profile = extractReferenceStyleSourceProfile(source, CONTRACT)!
    for (const query of ['(width >= 800px)', '(800px <= width)']) {
      const activeOverride = source.replace('</style>', `@media ${query}{.cover-dots{gap:99px}}</style>`)
      expect(verifyHtmlAgainstReferenceStyle(activeOverride, CONTRACT, profile).violations.source.join('\n'))
        .toMatch(/cover-dots gap.*99px/iu)
    }
    const inactiveOverride = source.replace('</style>', '@media (width < 800px){.cover-dots{gap:99px}}</style>')
    expect(verifyHtmlAgainstReferenceStyle(inactiveOverride, CONTRACT, profile).violations.source).toEqual([])
  })

  it('keeps a compact validated contract after raw evidence compaction and rejects malformed provenance', () => {
    expect(latestSuccessfulReferenceStyleContract(recordedContractMessages())).toEqual({
      contract: CONTRACT,
      provenance: {
        resolvedUrl: REFERENCE_SOURCE,
        evidenceSha256: createHash('sha256').update(REFERENCE_HTML).digest('hex'),
        evidenceBytes: Buffer.byteLength(REFERENCE_HTML),
      },
    })
    expect(latestSuccessfulReferenceStyleContract(recordedContractMessages(CONTRACT, SIBLING_SOURCE))).toBeUndefined()

    const malformed = recordedContractMessages()
    const toolResult = malformed[1]
    const payload = JSON.parse(String(toolResult.content)) as Record<string, unknown>
    payload.provenance = { resolvedUrl: REFERENCE_SOURCE, evidenceSha256: 'not-a-hash', evidenceBytes: 1 }
    toolResult.content = JSON.stringify(payload)
    expect(latestSuccessfulReferenceStyleContract(malformed)).toBeUndefined()
  })

  it('restores an optional bounded source profile while accepting historical records without one', () => {
    const profile = extractReferenceStyleSourceProfile(REFERENCE_HTML, CONTRACT)
    expect(profile).toBeDefined()
    expect(latestSuccessfulReferenceStyleContract(recordedContractMessages(CONTRACT, REFERENCE_SOURCE, profile))).toMatchObject({
      contract: CONTRACT,
      sourceProfile: profile,
    })
    expect(latestSuccessfulReferenceStyleContract(recordedContractMessages())).not.toHaveProperty('sourceProfile')
  })

  it('validates and restores a provenance-bound rendered reference profile', () => {
    const profile = renderedProfile()
    expect(normalizeRenderedReferenceStyleProfile(profile, {
      evidenceSha256: profile.evidenceSha256,
      viewport: CONTRACT.viewport,
    })).toEqual(profile)
    expect(latestSuccessfulReferenceStyleContract(recordedContractMessages(
      CONTRACT,
      REFERENCE_SOURCE,
      extractReferenceStyleSourceProfile(REFERENCE_HTML, CONTRACT),
      profile,
    ))).toMatchObject({ renderProfile: profile })
    expect(() => normalizeRenderedReferenceStyleProfile({
      ...profile,
      evidenceSha256: 'f'.repeat(64),
    }, { evidenceSha256: profile.evidenceSha256, viewport: CONTRACT.viewport })).toThrow(/hash.*provenance/iu)
    expect(() => normalizeRenderedReferenceStyleProfile({
      ...profile,
      viewport: { width: 1280, height: 720 },
    }, { evidenceSha256: profile.evidenceSha256, viewport: CONTRACT.viewport })).toThrow(/viewport.*StyleContract/iu)
  })

  it('retains bounded text-layout evidence and upgrades legacy interior baselines without fabricating measurements', () => {
    const profile = renderedProfile()
    expect(referenceTextLayoutRequiresUpgrade(profile)).toBe(true)
    for (const phase of Object.values(profile.phases)) {
      phase.textLayout = { version: 2, complete: true, collisions: [] }
    }
    profile.interiorVariants = [{ layoutSelector: '.layout-content', profile: structuredClone(profile.phases.content) }]
    profile.interiorVariants[0].profile.anchors[0].selector = '.layout-content'
    const normalized = normalizeRenderedReferenceStyleProfile(profile)
    expect(normalized).toEqual(profile)
    expect(referenceTextLayoutRequiresUpgrade(normalized)).toBe(false)
    const oldFontBoxes = structuredClone(normalized)
    oldFontBoxes.phases.cover.textLayout!.version = 1
    expect(normalizeRenderedReferenceStyleProfile(oldFontBoxes).phases.cover.textLayout!.version).toBe(1)
    expect(referenceTextLayoutRequiresUpgrade(oldFontBoxes)).toBe(true)
    delete normalized.interiorVariants![0].profile.textLayout
    expect(referenceTextLayoutRequiresUpgrade(normalized)).toBe(true)
    expect(profile.interiorVariants[0].profile.textLayout).toBeDefined()
    normalized.interiorVariants![0].profile.textLayout = { version: 2, complete: false, collisions: [] }
    // A measured overflow is a real observation failure, not a legacy record
    // that can be cured by endlessly recording the same reference again.
    expect(referenceTextLayoutRequiresUpgrade(normalized)).toBe(false)
    expect(() => normalizeRenderedReferenceStyleProfile({ ...profile, phases: {
      ...profile.phases, cover: { ...profile.phases.cover, textLayout: { version: 2, complete: true, collisions: [{}] } },
    } })).toThrow(/text layout evidence/iu)
  })

  it('retains full reference profiles durably while projecting a deterministic compact provider attestation', () => {
    const sourceProfile = extractReferenceStyleSourceProfile(REFERENCE_HTML, CONTRACT)!
    const expanded = expandedRenderedProfile()
    const renderProfile: RenderedReferenceStyleProfile = {
      ...expanded,
      interiorVariants: [{
        layoutSelector: '.layout-agenda',
        profile: {
          anchors: [
            { ...expanded.phases.content.anchors[0], selector: '.layout-agenda' },
            expanded.phases.content.anchors.at(-1)!,
          ],
          overlayProbes: [],
        },
      }],
    }
    const normalizedRenderProfile = normalizeRenderedReferenceStyleProfile(renderProfile, {
      evidenceSha256: renderProfile.evidenceSha256,
      viewport: CONTRACT.viewport,
    })
    const messages = recordedContractMessages(CONTRACT, REFERENCE_SOURCE, sourceProfile, renderProfile)
    const rawResult = JSON.parse(String(messages[1].content)) as Record<string, unknown>
    const fontEvidence = exactFontEvidence(renderProfile.evidenceSha256)
    const visualEvidence = exactVisualEvidence(renderProfile)
    rawResult.font_evidence = fontEvidence
    rawResult.visual_evidence = visualEvidence
    messages[1].content = JSON.stringify(rawResult)
    const durableContent = String(messages[1].content)

    const projected = projectReferenceStyleToolResultForProvider(durableContent)
    expect(projectReferenceStyleToolResultForProvider(durableContent)).toBe(projected)
    expect(messages[1].content).toBe(durableContent)

    const providerPayload = JSON.parse(projected) as Record<string, unknown>
    expect(providerPayload).not.toHaveProperty('source_profile')
    expect(providerPayload).not.toHaveProperty('render_profile')
    expect(providerPayload).toMatchObject({
      source_profile_attestation: {
        version: 1,
        sha256: createHash('sha256')
          .update(JSON.stringify(normalizeReferenceStyleSourceProfile(sourceProfile)))
          .digest('hex'),
        rules: sourceProfile.rules.length,
        required_rules: sourceProfile.rules.filter((rule) => rule.requiredInDom).length,
        dom_classes: sourceProfile.dom.length,
        required_dom_classes: sourceProfile.dom.filter((entry) => entry.required).length,
      },
      render_profile_attestation: {
        version: 1,
        sha256: createHash('sha256')
          .update(JSON.stringify(normalizedRenderProfile))
          .digest('hex'),
        evidenceSha256: renderProfile.evidenceSha256,
        viewport: CONTRACT.viewport,
        phases: {
          cover: { anchors: 20, overlay_probes: 6 },
          content: { anchors: 20, overlay_probes: 6 },
          closing: { anchors: 20, overlay_probes: 6 },
        },
        interior_variants: { count: 1, layout_selectors: ['.layout-agenda'] },
      },
      font_evidence_attestation: {
        version: 1,
        manifest_sha256: fontEvidence.manifestSha256,
        source_evidence_sha256: renderProfile.evidenceSha256,
        font_css_sha256: fontEvidence.fontCssSha256,
        font_css_bytes: fontEvidence.fontCssBytes,
        family_names: ['Inter'],
        stylesheets: 1,
        font_files: 1,
        font_bytes: 4,
      },
      visual_evidence_attestation: {
        version: 1,
        manifest_sha256: visualEvidence.manifestSha256,
        source_evidence_sha256: renderProfile.evidenceSha256,
        render_profile_sha256: visualEvidence.renderProfileSha256,
        viewport: CONTRACT.viewport,
      },
    })
    expect(projected).not.toMatch(/fontCss|data:font/iu)
    expect(Buffer.byteLength(projected)).toBeLessThan(Buffer.byteLength(durableContent) * 0.2)
    expect(latestSuccessfulReferenceStyleContract(messages)).toMatchObject({
      sourceProfile,
      renderProfile: normalizedRenderProfile,
      fontEvidence,
      visualEvidence,
    })

    for (const field of ['font_evidence', 'visual_evidence'] as const) {
      const malformed = structuredClone(messages)
      const malformedPayload = JSON.parse(String(malformed[1].content)) as Record<string, unknown>
      const evidence = { ...(malformedPayload[field] as Record<string, unknown>), manifestSha256: '0'.repeat(64) }
      malformedPayload[field] = evidence
      malformed[1].content = JSON.stringify(malformedPayload)
      expect(latestSuccessfulReferenceStyleContract(malformed)).toBeUndefined()
    }
  })

  it('requires strict phase structure while validating only browser-attested shared anchors', () => {
    const profile = renderedProfile()
    expect(() => normalizeRenderedReferenceStyleProfile({
      ...profile,
      phases: {
        ...profile.phases,
        cover: { anchors: profile.phases.cover.anchors.slice(1), overlayProbes: [] },
      },
    })).toThrow(/cover.*structural anchor/iu)
    expect(() => normalizeRenderedReferenceStyleProfile({
      ...profile,
      phases: {
        ...profile.phases,
        content: { anchors: profile.phases.content.anchors.slice(0, 1), overlayProbes: [] },
      },
    })).toThrow(/content.*shared anchor.*progress-bar/iu)
    expect(() => normalizeRenderedReferenceStyleProfile({
      ...profile,
      phases: {
        ...profile.phases,
        closing: {
          anchors: profile.phases.closing.anchors.map((anchor, index) => index === 0 ? { ...anchor, geometry: 'size' } : anchor),
          overlayProbes: [],
        },
      },
    })).toThrow(/closing.*strict geometry/iu)
    expect(() => normalizeRenderedReferenceStyleProfile({
      ...profile,
      interiorVariants: [{
        layoutSelector: '.layout-invented',
        profile: profile.phases.content,
      }],
    })).toThrow(/interiorVariants\[0\].*structural anchor/iu)

    const phaseLocalOnly = {
      ...profile,
      phases: Object.fromEntries((['cover', 'content', 'closing'] as const).map((phase) => [phase, {
        ...profile.phases[phase],
        anchors: profile.phases[phase].anchors.slice(0, 1),
      }])) as RenderedReferenceStyleProfile['phases'],
      sharedAnchorSelectors: undefined,
    }
    expect(normalizeRenderedReferenceStyleProfile(phaseLocalOnly)).not.toHaveProperty('sharedAnchorSelectors')

    expect(() => normalizeRenderedReferenceStyleProfile({
      ...profile,
      interiorVariants: [{
        layoutSelector: '.layout-content',
        profile: {
          anchors: [{ ...profile.phases.content.anchors[0], selector: '.layout-content' }],
          overlayProbes: [],
        },
      }],
    })).toThrow(/interiorVariants\[0\].*shared anchor.*progress-bar/iu)
  })
})
