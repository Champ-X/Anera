import { describe, expect, it } from 'vitest'
import { diffUiContracts, type UiStateContract, type UiVisualContract } from './ui-contract.js'

describe('UI structure contract diff', () => {
  it('is exact for an identical contract and localizes structural changes', () => {
    const reference = contract([state('desktop')])
    const exact = diffUiContracts(reference, structuredClone(reference))
    expect(exact.score).toBe(1)
    expect(exact.passed).toBe(true)
    expect(exact.stateScores[0].differences).toEqual([])

    const candidate = structuredClone(reference)
    candidate.states[0].components.tools = 3
    candidate.states[0].landmarks.workspace.normalizedRect!.width = 0.3
    candidate.states[0].controls[0].ariaLabel = 'Run'
    candidate.states[0].cssVariables['--paper'] = '#ffffff'
    const changed = diffUiContracts(reference, candidate)
    expect(changed.score).toBeLessThan(1)
    expect(changed.passed).toBe(false)
    expect(changed.stateScores[0].differences).toContain('tools 1→3')
    expect(changed.stateScores[0].differences).toContain('workspace geometry')
    expect(changed.stateScores[0].differences).toContain('visible control identities 1→1')
    expect(changed.stateScores[0].differences).toContain('--paper #fbfaf7→#ffffff')
  })

  it('treats a missing visual state as a hard zero for that state', () => {
    const reference = contract([state('desktop'), state('approval')])
    const candidate = contract([state('desktop')])
    const diff = diffUiContracts(reference, candidate)
    expect(diff.score).toBe(0.5)
    expect(diff.passed).toBe(false)
    expect(diff.missingCandidateStates).toEqual(['approval'])
  })
})

function contract(states: UiStateContract[]): UiVisualContract {
  return { schemaVersion: 'anera-ui-contract/1.0', product: 'fixture', capturedAt: '2026-08-28T00:00:00Z', browser: 'fixture', states }
}

function state(name: string): UiStateContract {
  return {
    name,
    screenshot: `${name}.png`,
    viewport: { width: 1440, height: 900 },
    document: { clientWidth: 1440, scrollWidth: 1440, horizontalOverflowPx: 0, clientHeight: 900, scrollHeight: 900, verticalOverflowPx: 0, windowScrollY: 0, bodyOverflow: 'hidden', conversationScrollTop: 0, conversationScrollHeight: 1200, conversationClientHeight: 700 },
    activeConversation: 'Fixture',
    components: { tools: 1, artifacts: 1 },
    landmarks: {
      workspace: { present: true, visible: true, normalizedRect: { x: 0.8, y: 0, width: 0.2, height: 1 } },
      mainStage: { present: true, visible: true, normalizedRect: { x: 0.15, y: 0, width: 0.65, height: 1 } },
    },
    controls: [{ tag: 'button', role: null, ariaLabel: 'Send', ariaMultiline: null, contentEditable: null, text: '', disabled: true }],
    cssVariables: { '--paper': '#fbfaf7' },
    console: [],
  }
}
