import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AGENT_LEADERBOARD_PATH,
  ANERA_AGENT_LEADERBOARD_ROWS,
  AgentLeaderboard,
  filterAgentLeaderboardRows,
  isAgentLeaderboardPath,
  type AgentLeaderboardRow,
} from './AgentLeaderboard.js'

describe('Agent Leaderboard route', () => {
  it('accepts only the canonical desktop Agent leaderboard path', () => {
    expect(AGENT_LEADERBOARD_PATH).toBe('/leaderboard/agent')
    expect(isAgentLeaderboardPath('/leaderboard/agent')).toBe(true)
    expect(isAgentLeaderboardPath('/leaderboard/agent/')).toBe(true)
    expect(isAgentLeaderboardPath('/leaderboard')).toBe(false)
    expect(isAgentLeaderboardPath('/agent')).toBe(false)
    expect(isAgentLeaderboardPath('/leaderboard/agent/fake')).toBe(false)
  })
})

describe('Agent Leaderboard evidence filtering', () => {
  const proprietary: AgentLeaderboardRow = {
    ...ANERA_AGENT_LEADERBOARD_ROWS[0],
    id: 'proprietary-chat-fixture',
    model: 'Closed Chat Fixture',
    lab: 'Fixture Lab',
    license: 'Proprietary',
    categories: ['Overall', 'Chat'],
  }
  const rows = [...ANERA_AGENT_LEADERBOARD_ROWS, proprietary]

  it('combines normalized search, category, and license filters', () => {
    expect(filterAgentLeaderboardRows(rows, '  deepSEEK ', 'Code', 'Open Source').map((row) => row.id)).toEqual([
      'anera-deepseek-2026-08-30',
    ])
    expect(filterAgentLeaderboardRows(rows, 'fixture lab', 'Chat', 'Proprietary').map((row) => row.id)).toEqual([
      'proprietary-chat-fixture',
    ])
    expect(filterAgentLeaderboardRows(rows, '', 'Work', 'Proprietary')).toEqual([])
  })

  it('preserves all rows for the neutral controls', () => {
    expect(filterAgentLeaderboardRows(rows, '', 'Overall', 'All')).toEqual(rows)
  })
})

describe('Agent Leaderboard public structure', () => {
  it('renders the observed filters, signals, columns, and evidence boundary', () => {
    const html = renderToStaticMarkup(<AgentLeaderboard onTryAgent={() => undefined} />)
    for (const text of [
      'Overview', 'Agent', 'Chat', 'Code', 'Image', 'Video',
      'Ranking', 'Pareto', 'Overall', 'Work', 'Proprietary', 'Open Source',
      'Agent Arena', 'Models', 'Labs', 'Edit columns',
      'Net Improvement', 'Confirmed Success', 'Praise vs Complaint', 'Steerability',
      'Bash Recovery', 'Tool Hallucination', 'Sessions', 'Cost/Task (P50)',
      'Output Tokens/Task (P50)', 'Price $/M', 'Signal Leaders',
      'Frequently asked questions', 'Try Agent Mode',
    ]) expect(html).toContain(text)
    expect(html).toContain('not live Arena data')
    expect(html).toContain('not a claim of Arena task parity')
    expect(html).toContain('leaderboard-product-brand')
    expect(html).toContain('role="img" aria-label="Anera"')
    expect(html).toContain('aria-label="Anera products"')
    expect(html).toContain('Anera Harness · DeepSeek')
    expect(html).toContain('18 / 18 internal quality tasks')
    expect(html).toContain('18 sessions')
    expect(html).toContain('$0.0093')
    expect(html).toContain('Tool calls with zero failed tools')
    expect(html).toContain('aria-label="Agent Arena models ranking"')
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('role="tablist"')
  })
})
