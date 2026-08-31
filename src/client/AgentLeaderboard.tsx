import {
  Check,
  ChevronDown,
  CircleHelp,
  Search,
  Settings2,
  Sparkles,
  Trophy,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import aneraLogoUrl from '../../logo.png'

export const AGENT_LEADERBOARD_PATH = '/leaderboard/agent'

export type AgentLeaderboardView = 'ranking' | 'pareto'
export type AgentLeaderboardCategory = 'Overall' | 'Code' | 'Chat' | 'Work'
export type AgentLeaderboardLicense = 'All' | 'Proprietary' | 'Open Source'
export type AgentLeaderboardEntity = 'models' | 'labs'

export interface AgentLeaderboardRow {
  id: string
  rank: number
  model: string
  lab: string
  license: Exclude<AgentLeaderboardLicense, 'All'>
  categories: readonly AgentLeaderboardCategory[]
  netImprovement: string | null
  confirmedSuccess: string | null
  praiseComplaint: string | null
  steerability: string | null
  bashRecovery: string | null
  toolHallucination: string | null
  sessions: string
  costP50: string
  outputTokensP50: string
  pricePerM: string | null
  paretoCostUsd: number
  paretoQuality: number
}

/**
 * This row projects the latest checked-in Anera quality report. It is not an
 * Arena ranking snapshot and deliberately leaves incomparable signals blank.
 */
export const ANERA_AGENT_LEADERBOARD_ROWS: readonly AgentLeaderboardRow[] = [{
  id: 'anera-deepseek-2026-08-30',
  rank: 1,
  model: 'Anera Harness · DeepSeek',
  lab: 'Anera',
  license: 'Open Source',
  categories: ['Overall', 'Code', 'Chat', 'Work'],
  netImprovement: null,
  confirmedSuccess: '100%',
  praiseComplaint: null,
  steerability: '18 / 18',
  bashRecovery: 'Pass',
  toolHallucination: 'Pass',
  sessions: '18',
  costP50: '$0.0093',
  outputTokensP50: '2,957',
  pricePerM: null,
  paretoCostUsd: 0.00930089,
  paretoQuality: 100,
}]

const METRIC_COLUMNS = [
  ['netImprovement', 'Net Improvement'],
  ['confirmedSuccess', 'Confirmed Success'],
  ['praiseComplaint', 'Praise vs Complaint'],
  ['steerability', 'Steerability'],
  ['bashRecovery', 'Bash Recovery'],
  ['toolHallucination', 'Tool Hallucination'],
  ['sessions', 'Sessions'],
  ['costP50', 'Cost/Task (P50)'],
  ['outputTokensP50', 'Output Tokens/Task (P50)'],
  ['pricePerM', 'Price $/M'],
] as const

type MetricColumnKey = (typeof METRIC_COLUMNS)[number][0]

export function isAgentLeaderboardPath(pathname: string): boolean {
  return pathname === AGENT_LEADERBOARD_PATH || pathname === `${AGENT_LEADERBOARD_PATH}/`
}

export function filterAgentLeaderboardRows(
  rows: readonly AgentLeaderboardRow[],
  query: string,
  category: AgentLeaderboardCategory,
  license: AgentLeaderboardLicense,
): AgentLeaderboardRow[] {
  const normalized = query.trim().toLocaleLowerCase()
  return rows.filter((row) => (
    (category === 'Overall' || row.categories.includes(category))
    && (license === 'All' || row.license === license)
    && (!normalized || `${row.model} ${row.lab}`.toLocaleLowerCase().includes(normalized))
  ))
}

function metricValue(row: AgentLeaderboardRow, column: MetricColumnKey): string {
  return row[column] ?? '—'
}

export function AgentLeaderboard({ onTryAgent }: { onTryAgent: () => void }) {
  const [view, setView] = useState<AgentLeaderboardView>('ranking')
  const [category, setCategory] = useState<AgentLeaderboardCategory>('Overall')
  const [license, setLicense] = useState<AgentLeaderboardLicense>('All')
  const [entity, setEntity] = useState<AgentLeaderboardEntity>('models')
  const [query, setQuery] = useState('')
  const [columnMenuOpen, setColumnMenuOpen] = useState(false)
  const [visibleColumns, setVisibleColumns] = useState<ReadonlySet<MetricColumnKey>>(
    () => new Set(METRIC_COLUMNS.map(([key]) => key)),
  )
  const rows = useMemo(
    () => filterAgentLeaderboardRows(ANERA_AGENT_LEADERBOARD_ROWS, query, category, license),
    [category, license, query],
  )

  const toggleColumn = (column: MetricColumnKey) => {
    setVisibleColumns((current) => {
      const next = new Set(current)
      if (next.has(column)) next.delete(column)
      else next.add(column)
      return next
    })
  }

  return (
    <section className="agent-leaderboard-page" aria-labelledby="agent-leaderboard-title">
      <header className="leaderboard-product-header">
        <div className="leaderboard-product-brand"><img src={aneraLogoUrl} alt="" aria-hidden="true" /> Anera</div>
        <nav aria-label="Anera products">
          {['Overview', 'Agent', 'Chat', 'Code', 'Image', 'Video'].map((product) => (
            <button key={product} className={product === 'Agent' ? 'active' : ''} aria-current={product === 'Agent' ? 'page' : undefined}>{product}</button>
          ))}
        </nav>
        <button className="leaderboard-header-menu" aria-label="Open Anera menu"><ChevronDown size={15} /></button>
      </header>

      <div className="leaderboard-layout">
        <aside className="leaderboard-filters" aria-label="Leaderboard filters">
          <LeaderboardFilterGroup
            label="View as"
            options={['Ranking', 'Pareto']}
            value={view === 'ranking' ? 'Ranking' : 'Pareto'}
            onChange={(value) => setView(value === 'Ranking' ? 'ranking' : 'pareto')}
          />
          <LeaderboardFilterGroup
            label="Categories"
            options={['Overall', 'Code', 'Chat', 'Work']}
            value={category}
            onChange={(value) => setCategory(value as AgentLeaderboardCategory)}
          />
          <LeaderboardFilterGroup
            label="License Type"
            options={['All', 'Proprietary', 'Open Source']}
            value={license}
            onChange={(value) => setLicense(value as AgentLeaderboardLicense)}
          />
        </aside>

        <div className="leaderboard-content">
          <div className="leaderboard-title-row">
            <div>
              <div className="leaderboard-eyebrow"><Trophy size={14} aria-hidden="true" /> {category}</div>
              <h1 id="agent-leaderboard-title">Agent Arena</h1>
            </div>
            <span className="leaderboard-snapshot-badge">Anera evidence · Aug 30, 2026</span>
          </div>
          <p className="leaderboard-intro">Dynamic ranking of models on how well they orchestrate tools for real-world agentic tasks.</p>
          <p className="leaderboard-evidence-note">
            This local snapshot projects Anera's checked-in harness benchmark. It is not live Arena data and is not a claim of Arena task parity.
          </p>
          <div className="leaderboard-meta" aria-label="Leaderboard snapshot metadata">
            <span>Updated Aug 30, 2026</span><span>18 sessions</span><span>1 model</span>
          </div>

          <div className="leaderboard-controls-row">
            <div className="leaderboard-tabs" role="tablist" aria-label="Leaderboard entities">
              {(['models', 'labs'] as const).map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={entity === tab}
                  className={entity === tab ? 'active' : ''}
                  onClick={() => setEntity(tab)}
                >{tab === 'models' ? 'Models' : 'Labs'}</button>
              ))}
            </div>
            <div className="leaderboard-toolbar">
              <label className="leaderboard-search">
                <Search size={14} aria-hidden="true" />
                <span className="sr-only">Search models or labs</span>
                <input
                  type="search"
                  aria-label="Search models or labs"
                  placeholder={entity === 'models' ? 'Search models' : 'Search labs'}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="leaderboard-column-control">
                <button
                  aria-haspopup="dialog"
                  aria-expanded={columnMenuOpen}
                  onClick={() => setColumnMenuOpen((current) => !current)}
                ><Settings2 size={14} /> Edit columns</button>
                {columnMenuOpen && (
                  <div className="leaderboard-column-menu" role="dialog" aria-label="Edit leaderboard columns">
                    <strong>Visible columns</strong>
                    {METRIC_COLUMNS.map(([key, label]) => (
                      <label key={key}>
                        <input type="checkbox" checked={visibleColumns.has(key)} onChange={() => toggleColumn(key)} />
                        <span className="leaderboard-check" aria-hidden="true"><Check size={11} /></span>
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {view === 'ranking'
            ? <LeaderboardTable rows={rows} entity={entity} visibleColumns={visibleColumns} />
            : <LeaderboardPareto rows={rows} entity={entity} />}

          <section className="leaderboard-signal-section" aria-labelledby="signal-leaders-title">
            <div className="leaderboard-section-heading">
              <h2 id="signal-leaders-title">Signal Leaders</h2>
              <span>Local evidence</span>
            </div>
            <div className="leaderboard-signal-grid">
              <SignalCard label="Confirmed success" value="100%" detail="18 / 18 internal quality tasks" />
              <SignalCard label="Efficiency" value="$0.0093" detail="Median estimated cost per task" />
              <SignalCard label="Tool reliability" value="116" detail="Tool calls with zero failed tools" />
            </div>
          </section>

          <section className="leaderboard-faq" aria-labelledby="leaderboard-faq-title">
            <h2 id="leaderboard-faq-title">Frequently asked questions</h2>
            <details>
              <summary>What does this leaderboard measure?<ChevronDown size={15} /></summary>
              <p>It projects the deterministic Anera harness-quality benchmark: task completion, critical checks, efficiency budgets, and tool reliability.</p>
            </details>
            <details>
              <summary>Is this the live Arena ranking?<ChevronDown size={15} /></summary>
              <p>No. Dynamic Arena values remain external reference evidence. Missing comparable signals are intentionally shown as an em dash.</p>
            </details>
          </section>

          <section className="leaderboard-cta">
            <div><CircleHelp size={18} /><div><strong>Try Agent Mode</strong><span>Run a real task and inspect the complete execution trace.</span></div></div>
            <button onClick={onTryAgent}>New Agent task</button>
          </section>
        </div>
      </div>
    </section>
  )
}

function LeaderboardFilterGroup({ label, options, value, onChange }: {
  label: string
  options: readonly string[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <section className="leaderboard-filter-group">
      <h2>{label}</h2>
      <div role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option}
            role="radio"
            aria-checked={option === value}
            className={option === value ? 'active' : ''}
            onClick={() => onChange(option)}
          ><span className="leaderboard-radio" aria-hidden="true" />{option}</button>
        ))}
      </div>
    </section>
  )
}

function LeaderboardTable({ rows, entity, visibleColumns }: {
  rows: readonly AgentLeaderboardRow[]
  entity: AgentLeaderboardEntity
  visibleColumns: ReadonlySet<MetricColumnKey>
}) {
  return (
    <div className="leaderboard-table-frame">
      <table aria-label={`Agent Arena ${entity} ranking`}>
        <thead><tr>
          <th scope="col">Rank</th>
          <th scope="col">{entity === 'models' ? 'Model' : 'Lab'}</th>
          {METRIC_COLUMNS.filter(([key]) => visibleColumns.has(key)).map(([key, label]) => <th scope="col" key={key}>{label}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td><span className="leaderboard-rank">{row.rank}</span></td>
              <th scope="row"><span className="leaderboard-model-mark">{entity === 'models' ? 'D' : 'A'}</span><span>{entity === 'models' ? row.model : row.lab}<small>{entity === 'models' ? row.lab : '1 evaluated model'}</small></span></th>
              {METRIC_COLUMNS.filter(([key]) => visibleColumns.has(key)).map(([key]) => (
                <td key={key} className={row[key] === null ? 'unmeasured' : ''}>{metricValue(row, key)}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && <tr><td className="leaderboard-empty" colSpan={2 + visibleColumns.size}>No matching evidence</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function LeaderboardPareto({ rows, entity }: { rows: readonly AgentLeaderboardRow[]; entity: AgentLeaderboardEntity }) {
  return (
    <div className="leaderboard-pareto" role="img" aria-label="Quality versus median task cost Pareto chart">
      <div className="pareto-y-label">Confirmed success</div>
      <div className="pareto-plot">
        <span className="pareto-grid-line line-25" /><span className="pareto-grid-line line-50" /><span className="pareto-grid-line line-75" />
        {rows.map((row) => (
          <div
            key={row.id}
            className="pareto-point"
            style={{ left: `${Math.min(94, Math.max(6, (row.paretoCostUsd / 0.02) * 88 + 6))}%`, bottom: `${Math.min(92, Math.max(6, row.paretoQuality * 0.86))}%` }}
          ><span>{entity === 'models' ? row.model : row.lab}</span></div>
        ))}
        {rows.length === 0 && <div className="pareto-empty">No matching evidence</div>}
      </div>
      <div className="pareto-x-label">Median cost per task →</div>
    </div>
  )
}

function SignalCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article><span>{label}</span><strong>{value}</strong><p>{detail}</p></article>
}
