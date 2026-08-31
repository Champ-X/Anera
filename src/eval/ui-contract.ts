import type { Page } from 'playwright-core'

export interface UiRect {
  x: number
  y: number
  width: number
  height: number
}

export interface UiLandmark {
  present: boolean
  visible: boolean
  rect?: UiRect
  normalizedRect?: UiRect
  display?: string
  position?: string
  backgroundColor?: string
  borderColor?: string
}

export interface UiControl {
  tag: string
  role: string | null
  ariaLabel: string | null
  ariaMultiline: string | null
  contentEditable: string | null
  text: string
  disabled: boolean
}

export interface UiStateContract {
  name: string
  screenshot: string
  viewport: { width: number; height: number }
  document: {
    clientWidth: number
    scrollWidth: number
    horizontalOverflowPx: number
    clientHeight: number
    scrollHeight: number
    verticalOverflowPx: number
    windowScrollY: number
    bodyOverflow: string
    conversationScrollTop: number
    conversationScrollHeight: number
    conversationClientHeight: number
  }
  activeConversation: string | null
  components: Record<string, number>
  landmarks: Record<string, UiLandmark>
  controls: UiControl[]
  cssVariables: Record<string, string>
  console: Array<{ level: string; text: string }>
}

export interface UiVisualContract {
  schemaVersion: 'anera-ui-contract/1.0'
  product: string
  capturedAt: string
  browser: string
  states: UiStateContract[]
}

export async function captureUiStateContract(
  page: Page,
  name: string,
  screenshot: string,
  consoleMessages: Array<{ level: string; text: string }>,
): Promise<UiStateContract> {
  const state = await page.evaluate(({ stateName, screenshotName }) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const selectors: Record<string, string> = {
      app: '.app-shell',
      leftRail: '.left-rail',
      mainStage: '.main-stage',
      stageHeader: '.stage-header',
      conversation: '.conversation-scroll',
      composer: '.composer',
      taskReview: '.task-review-panel',
      taskCompletionBar: '.task-completion-bar',
      workspace: '.workspace-panel',
      preview: '.preview-window',
    }
    const landmarks = Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) return [key, { present: false, visible: false }]
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < viewport.width && rect.top < viewport.height
      return [key, {
        present: true,
        visible,
        rect: { x: Math.round(rect.x * 1000) / 1000, y: Math.round(rect.y * 1000) / 1000, width: Math.round(rect.width * 1000) / 1000, height: Math.round(rect.height * 1000) / 1000 },
        normalizedRect: {
          x: Math.round((rect.x / viewport.width) * 1000) / 1000,
          y: Math.round((rect.y / viewport.height) * 1000) / 1000,
          width: Math.round((rect.width / viewport.width) * 1000) / 1000,
          height: Math.round((rect.height / viewport.height) * 1000) / 1000,
        },
        display: style.display,
        position: style.position,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
      }]
    }))
    const components: Record<string, number> = {
      userTurns: document.querySelectorAll('.user-turn').length,
      attachmentChips: document.querySelectorAll('.turn-attachments span, .attachment-chip').length,
      thoughts: document.querySelectorAll('.thought-row').length,
      runningThoughts: document.querySelectorAll('.thought-row.running').length,
      expandedThoughts: document.querySelectorAll('.thought-body').length,
      plans: document.querySelectorAll('.plan-card').length,
      planItems: document.querySelectorAll('.plan-card li').length,
      pendingPlanItems: document.querySelectorAll('.plan-card li.pending').length,
      inProgressPlanItems: document.querySelectorAll('.plan-card li.in_progress').length,
      completedPlanItems: document.querySelectorAll('.plan-card li.completed').length,
      explorationGroups: document.querySelectorAll('.exploration-group').length,
      explorationItems: document.querySelectorAll('.exploration-item').length,
      expandedExplorationGroups: document.querySelectorAll('.exploration-body').length,
      executionGroups: document.querySelectorAll('.arena-tool-group').length,
      commandGroups: document.querySelectorAll('.arena-tool-group.commands').length,
      fileEditGroups: document.querySelectorAll('.arena-tool-group.files').length,
      runningExecutionGroups: document.querySelectorAll('.arena-tool-group.running').length,
      expandedExecutionGroups: document.querySelectorAll('.arena-tool-group-body').length,
      tools: document.querySelectorAll('.tool-row').length,
      runningTools: document.querySelectorAll('.tool-row.running').length,
      failedTools: document.querySelectorAll('.tool-row.failed').length,
      timedOutTools: document.querySelectorAll('.tool-row.timed_out').length,
      expandedTools: document.querySelectorAll('.tool-body').length,
      artifacts: document.querySelectorAll('.artifact-card').length,
      approvals: document.querySelectorAll('.approval-card').length,
      pendingApprovals: document.querySelectorAll('.approval-card.pending').length,
      approvedApprovals: document.querySelectorAll('.approval-card.approved').length,
      deniedApprovals: document.querySelectorAll('.approval-card.denied').length,
      finalAnswers: document.querySelectorAll('.final-answer').length,
      taskReviews: document.querySelectorAll('.task-review-panel').length,
      taskCompletionBars: document.querySelectorAll('.task-completion-bar').length,
      composerEditors: document.querySelectorAll('.composer-editor[contenteditable]').length,
      lockedComposerEditors: document.querySelectorAll('.composer-editor[aria-disabled="true"]').length,
      stopControls: document.querySelectorAll('button[aria-label="Stop agent"]').length,
      liveHistoryItems: document.querySelectorAll('.history-list .live-dot').length,
      errors: document.querySelectorAll('.error-event, .inline-error').length,
      processes: document.querySelectorAll('.process-item').length,
      files: document.querySelectorAll('.file-node[href]').length,
      directories: document.querySelectorAll('.file-node:not([href])').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      historyItems: document.querySelectorAll('.history-list button').length,
    }
    const controls = [...document.querySelectorAll<HTMLElement>('button,a,input,textarea,select,[contenteditable],[role="button"],[role="checkbox"]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < viewport.width && rect.top < viewport.height
      })
      .slice(0, 160)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        ariaLabel: element.getAttribute('aria-label'),
        ariaMultiline: element.getAttribute('aria-multiline'),
        contentEditable: element.getAttribute('contenteditable'),
        text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
        disabled: (element as HTMLButtonElement).disabled === true,
      }))
    const rootStyle = getComputedStyle(document.documentElement)
    const variables = ['--paper', '--canvas', '--ink', '--muted', '--faint', '--line', '--line-strong', '--soft', '--green', '--red', '--amber']
    const conversation = document.querySelector<HTMLElement>('.conversation-scroll')
    return {
      name: stateName,
      screenshot: screenshotName,
      viewport,
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
        verticalOverflowPx: Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight),
        windowScrollY: Math.round(window.scrollY),
        bodyOverflow: getComputedStyle(document.body).overflow,
        conversationScrollTop: Math.round(conversation?.scrollTop ?? 0),
        conversationScrollHeight: Math.round(conversation?.scrollHeight ?? 0),
        conversationClientHeight: Math.round(conversation?.clientHeight ?? 0),
      },
      activeConversation: document.querySelector('.history-list button.active')?.textContent?.trim() || null,
      components,
      landmarks,
      controls,
      cssVariables: Object.fromEntries(variables.map((variable) => [variable, rootStyle.getPropertyValue(variable).trim()])),
    }
  }, { stateName: name, screenshotName: screenshot })
  return { ...state, console: consoleMessages.map((item) => ({ ...item })) }
}

export interface UiContractDiff {
  schemaVersion: 'anera-ui-contract-diff/1.0'
  passed: boolean
  score: number
  thresholds: {
    minOverallScore: number
    minStateScore: number
  }
  stateScores: Array<{
    name: string
    passed: boolean
    score: number
    layout: number
    components: number
    controls: number
    theme: number
    overflow: number
    missing: boolean
    differences: string[]
  }>
  missingReferenceStates: string[]
  missingCandidateStates: string[]
}

export interface UiContractDiffOptions {
  minOverallScore?: number
  minStateScore?: number
}

export function diffUiContracts(reference: UiVisualContract, candidate: UiVisualContract, options: UiContractDiffOptions = {}): UiContractDiff {
  const minOverallScore = bounded(options.minOverallScore ?? 0.98, 'minOverallScore')
  const minStateScore = bounded(options.minStateScore ?? 0.95, 'minStateScore')
  const referenceByName = new Map(reference.states.map((state) => [state.name, state]))
  const candidateByName = new Map(candidate.states.map((state) => [state.name, state]))
  const names = [...new Set([...referenceByName.keys(), ...candidateByName.keys()])].sort()
  const stateScores = names.map((name) => {
    const left = referenceByName.get(name)
    const right = candidateByName.get(name)
    if (!left || !right) return { name, passed: false, score: 0, layout: 0, components: 0, controls: 0, theme: 0, overflow: 0, missing: true, differences: [!left ? 'reference state missing' : 'candidate state missing'] }
    const differences: string[] = []
    const layoutScores: number[] = [ratio(left.viewport.width, right.viewport.width), ratio(left.viewport.height, right.viewport.height)]
    if (left.viewport.width !== right.viewport.width || left.viewport.height !== right.viewport.height) {
      differences.push(`viewport ${left.viewport.width}x${left.viewport.height}→${right.viewport.width}x${right.viewport.height}`)
    }
    const themeScores: number[] = []
    const landmarkNames = new Set([...Object.keys(left.landmarks), ...Object.keys(right.landmarks)])
    for (const landmark of landmarkNames) {
      const a = left.landmarks[landmark]
      const b = right.landmarks[landmark]
      if (!a?.present || !b?.present) {
        layoutScores.push(a?.present === b?.present ? 1 : 0)
        if (a?.present !== b?.present) differences.push(`${landmark} presence`)
        continue
      }
      if (!a.normalizedRect || !b.normalizedRect) continue
      const delta = ['x', 'y', 'width', 'height'].reduce((sum, key) => sum + Math.abs(a.normalizedRect![key as keyof UiRect] - b.normalizedRect![key as keyof UiRect]), 0) / 4
      layoutScores.push(Math.max(0, 1 - delta * 4))
      if (delta > 0.02) differences.push(`${landmark} geometry`)
      for (const property of ['display', 'position', 'backgroundColor', 'borderColor'] as const) {
        const equal = a[property] === b[property]
        themeScores.push(equal ? 1 : 0)
        if (!equal) differences.push(`${landmark} ${property}`)
      }
    }
    const componentKeys = new Set([...Object.keys(left.components), ...Object.keys(right.components)])
    const componentScores = [...componentKeys].map((key) => {
      const a = left.components[key] ?? 0
      const b = right.components[key] ?? 0
      if (a !== b) differences.push(`${key} ${a}→${b}`)
      return Math.max(a, b) === 0 ? 1 : Math.min(a, b) / Math.max(a, b)
    })
    const controls = multisetSimilarity(left.controls.map(controlSignature), right.controls.map(controlSignature))
    if (controls < 1) differences.push(`visible control identities ${left.controls.length}→${right.controls.length}`)
    const variableNames = new Set([...Object.keys(left.cssVariables), ...Object.keys(right.cssVariables)])
    for (const variable of variableNames) {
      const equal = left.cssVariables[variable] === right.cssVariables[variable]
      themeScores.push(equal ? 1 : 0)
      if (!equal) differences.push(`${variable} ${left.cssVariables[variable] ?? 'missing'}→${right.cssVariables[variable] ?? 'missing'}`)
    }
    const horizontalOverflow = left.document.horizontalOverflowPx === right.document.horizontalOverflowPx ? 1 : 0
    const verticalOverflow = (left.document.verticalOverflowPx ?? 0) === (right.document.verticalOverflowPx ?? 0) ? 1 : 0
    const windowScroll = (left.document.windowScrollY ?? 0) === (right.document.windowScrollY ?? 0) ? 1 : 0
    if (!horizontalOverflow) differences.push(`horizontal overflow ${left.document.horizontalOverflowPx}→${right.document.horizontalOverflowPx}`)
    if (!verticalOverflow) differences.push(`vertical overflow ${left.document.verticalOverflowPx ?? 0}→${right.document.verticalOverflowPx ?? 0}`)
    if (!windowScroll) differences.push(`window scroll Y ${left.document.windowScrollY ?? 0}→${right.document.windowScrollY ?? 0}`)
    const overflow = average([horizontalOverflow, verticalOverflow, windowScroll])
    const layout = average(layoutScores)
    const components = average(componentScores)
    const theme = average(themeScores)
    const score = Math.min(1, layout * 0.4 + components * 0.2 + controls * 0.15 + theme * 0.15 + overflow * 0.1)
    return { name, passed: score >= minStateScore, score, layout, components, controls, theme, overflow, missing: false, differences }
  })
  const score = average(stateScores.map((state) => state.score))
  const missingReferenceStates = names.filter((name) => !referenceByName.has(name))
  const missingCandidateStates = names.filter((name) => !candidateByName.has(name))
  return {
    schemaVersion: 'anera-ui-contract-diff/1.0',
    passed: missingReferenceStates.length === 0 && missingCandidateStates.length === 0 && score >= minOverallScore && stateScores.every((state) => state.passed),
    score,
    thresholds: { minOverallScore, minStateScore },
    stateScores,
    missingReferenceStates,
    missingCandidateStates,
  }
}

export function renderUiContractDiffMarkdown(diff: UiContractDiff): string {
  return [
    '# UI structure contract diff',
    '',
    `Decision: **${diff.passed ? 'PASS' : 'FAIL'}**`,
    '',
    `Overall structural similarity: **${(diff.score * 100).toFixed(1)}%**`,
    '',
    `Gates: overall ≥ ${formatPercent(diff.thresholds.minOverallScore)}; every state ≥ ${formatPercent(diff.thresholds.minStateScore)}; no missing state.`,
    '',
    '| State | Result | Score | Layout | Components | Controls | Theme | Overflow | Differences |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|',
    ...diff.stateScores.map((state) => `| ${escapeTable(state.name)} | ${state.passed ? 'PASS' : 'FAIL'} | ${formatPercent(state.score)} | ${formatPercent(state.layout)} | ${formatPercent(state.components)} | ${formatPercent(state.controls)} | ${formatPercent(state.theme)} | ${formatPercent(state.overflow)} | ${escapeTable(state.differences.join(', ') || 'none')} |`),
    '',
    `Missing in reference: ${diff.missingReferenceStates.join(', ') || 'none'}.`,
    '',
    `Missing in candidate: ${diff.missingCandidateStates.join(', ') || 'none'}.`,
    '',
  ].join('\n')
}

function average(values: number[]): number {
  return values.length === 0 ? 1 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function ratio(left: number, right: number): number {
  return Math.max(left, right) === 0 ? 1 : Math.min(left, right) / Math.max(left, right)
}

function controlSignature(control: UiControl): string {
  return [
    control.tag,
    control.role ?? '',
    control.ariaLabel ?? '',
    control.ariaMultiline ?? '',
    control.contentEditable ?? '',
    control.text,
    control.disabled ? 'disabled' : 'enabled',
  ].join('|')
}

function multisetSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 1
  const remaining = new Map<string, number>()
  for (const item of right) remaining.set(item, (remaining.get(item) ?? 0) + 1)
  let intersection = 0
  for (const item of left) {
    const count = remaining.get(item) ?? 0
    if (count <= 0) continue
    intersection += 1
    remaining.set(item, count - 1)
  }
  return intersection / Math.max(left.length, right.length)
}

function bounded(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`)
  return value
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
