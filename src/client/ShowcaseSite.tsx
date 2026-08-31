import {
  ArrowRight,
  Check,
  ChevronRight,
  ExternalLink,
  Github,
  Home,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import aneraLogoUrl from '../../logo.png'
import { App, sessionIdFromPath, sessionPath } from './App'
import {
  clearShowcaseReplayLimits,
  setShowcaseReplayLimit,
  showcaseCatalog,
  showcaseReplayCheckpoints,
} from './showcase-api'
import {
  SHOWCASE_NAVIGATION_EVENT,
  SHOWCASE_REPLAY_EVENT,
  normalizedShowcasePath,
} from './showcase-mode'

const GITHUB_URL = 'https://github.com/Champ-X/Anera'
const EVIDENCE_URL = `${GITHUB_URL}/tree/main/evidence`

function setPageMetadata(title: string, description: string): void {
  document.title = title
  let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'description'
    document.head.append(meta)
  }
  meta.content = description
}

function BrandLink() {
  return <a className="showcase-brand" href="/" aria-label="Anera project home">
    <img src={aneraLogoUrl} alt="" aria-hidden="true" />
    <span>Anera</span>
  </a>
}

function ReverseWordmark() {
  return <div className="reverse-wordmark" aria-label="Arena reversed becomes Anera">
    <div className="reverse-word-row arena-word" aria-hidden="true">
      {'ARENA'.split('').map((letter, index) => <span key={`${letter}-${index}`}>{letter}</span>)}
    </div>
    <div className="reverse-tracks" aria-hidden="true">
      <svg viewBox="0 0 1000 130" preserveAspectRatio="none">
        <path d="M220 8 C 330 8, 570 122, 780 122" />
        <path d="M780 8 C 670 8, 430 122, 220 122" />
        <path className="fixed-track" d="M500 8 L500 122" />
      </svg>
      <span>reverse / reconstruct</span>
    </div>
    <div className="reverse-word-row anera-word" aria-hidden="true">
      {'ANERA'.split('').map((letter, index) => <span key={`${letter}-${index}`}>{letter}</span>)}
    </div>
  </div>
}

const proofRows = [
  ['工具契约', '19 / 19', 'active tools 闭环'],
  ['质量任务', '18 / 18', 'critical checks 全通过'],
  ['界面状态', '61 / 61', 'console / overflow 均为 0'],
  ['录屏审计', 'P0 0 · P1 0', '主体桌面范围'],
]

export function ShowcaseLanding() {
  useEffect(() => {
    setPageMetadata('Anera — Arena Agent Mode 的逆向复刻', 'Anera 是对 Arena Agent Mode 可观察桌面契约的高保真逆向复刻，包含只读真实运行回放与完整证据报告。')
  }, [])

  return <div className="showcase-site landing-page">
    <header className="showcase-nav">
      <BrandLink />
      <nav aria-label="Project">
        <a href="#method">复刻方法</a>
        <a href="/report">证据报告</a>
        <a className="nav-github" href={GITHUB_URL} target="_blank" rel="noreferrer"><Github size={15} /> GitHub</a>
      </nav>
    </header>

    <main>
      <section className="landing-hero">
        <div className="hero-copy">
          <p className="showcase-eyebrow"><span>Reverse engineering dossier</span><i /></p>
          <h1>把 Arena 倒过来，<br />得到 Anera。</h1>
          <p className="hero-lede">这不只是一次字母重排。Anera 从公开界面、运行轨迹、工具协议和失效分支出发，反向重建 Arena Agent Mode 的可观察行为。</p>
          <div className="hero-actions">
            <a className="primary-action" href={sessionPath(showcaseCatalog.defaultSessionId)}><Play size={15} fill="currentColor" /> 播放真实案例</a>
            <a className="secondary-action" href="/report">阅读复刻报告 <ArrowRight size={15} /></a>
          </div>
          <p className="read-only-note"><ShieldCheck size={14} /> 展示站为只读回放，不会执行新任务，也不会连接任何账户。</p>
        </div>
        <ReverseWordmark />
      </section>

      <section className="proof-ledger" aria-label="Replication evidence summary">
        <div className="ledger-intro"><span>Evidence ledger</span><strong>四组独立证据，指向同一个结论</strong></div>
        {proofRows.map(([label, value, note]) => <div className="ledger-row" key={label}>
          <span>{label}</span><strong>{value}</strong><small>{note}</small>
        </div>)}
      </section>

      <section className="case-section">
        <div className="section-heading">
          <div><p className="showcase-eyebrow"><span>Recorded runs</span><i /></p><h2>不是预先画好的演示稿。</h2></div>
          <p>四个案例都来自 Anera 实际持久化的 Session。页面只改写了本机路径与静态资源地址，并合并连续流式文本；工具调用、结果、时序、用量和产物保持可核对。</p>
        </div>
        <div className="case-list">
          {showcaseCatalog.demos.map((demo, index) => <a className="case-row" href={sessionPath(demo.id)} key={demo.id}>
            <span className="case-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="case-copy"><small>{demo.eyebrow}</small><strong>{demo.title}</strong><em>{demo.note}</em></span>
            <span className="case-metrics"><b>{((demo.metrics.activeDurationMs ?? 0) / 1000).toFixed(1)}s</b><small>{demo.metrics.modelCalls} model · {demo.metrics.toolCalls} tool</small></span>
            <span className="case-open"><Play size={16} fill="currentColor" /></span>
          </a>)}
        </div>
      </section>

      <section className="method-section" id="method">
        <div className="method-thesis">
          <p className="showcase-eyebrow"><span>Black-box method</span><i /></p>
          <h2>复刻的对象不是源码，<br />而是用户能观察到的契约。</h2>
          <p>同一个输入进入系统以后，用户能否看到同样的暂停、工具、文件、预览、恢复与终态？Anera 用可冻结、可回放、可差分的证据回答这个问题。</p>
          <a href="/report#methodology">查看完整方法 <ArrowRight size={15} /></a>
        </div>
        <ol className="method-steps">
          <li><span>1</span><div><strong>Freeze</strong><p>从公共 bundle、登录态录屏与 65 题探针冻结可观察契约。</p></div></li>
          <li><span>2</span><div><strong>Normalize</strong><p>把 Arena 与 Anera 的异构事件投影到同一 canonical trace。</p></div></li>
          <li><span>3</span><div><strong>Reconstruct</strong><p>实现 durable Harness、19 工具、Workspace 与三栏状态投影。</p></div></li>
          <li><span>4</span><div><strong>Falsify</strong><p>用质量 oracle、视觉状态、故障注入和录屏差异主动寻找反例。</p></div></li>
        </ol>
      </section>

      <section className="landing-cta">
        <span>ARENA → ANERA</span>
        <div><h2>看界面，也看证据。</h2><p>先播放一条真实运行，再阅读范围、指标、限制和机器报告。</p></div>
        <div className="cta-actions"><a href={sessionPath(showcaseCatalog.defaultSessionId)}>打开回放</a><a href="/report">阅读报告</a></div>
      </section>
    </main>

    <footer className="showcase-footer"><BrandLink /><p>Observable-contract reconstruction · 2026</p><a href={GITHUB_URL}>Source on GitHub <ExternalLink size={13} /></a></footer>
  </div>
}

const capabilityRows = [
  ['入口与连续对话', '文本、附件、模型选择、Session 历史、搜索与 Resume', '闭合'],
  ['规划与人在回路', 'propose_plan / ask_user / approval / voice choice', '闭合'],
  ['文件与 Workspace', '持久写入、目录、分页读取、Artifact、Preview、下载', '闭合'],
  ['Web 与浏览器', '搜索、抓取、Website、交互、截图、Console 与视口', '闭合'],
  ['代码与进程', 'Bash、后台进程、端口、日志、停止、失败恢复', '闭合'],
  ['多模态与 Office', '图片理解/生成、语音、XLSX、DOCX、PPTX、PDF', '闭合*'],
  ['生命周期与耐久性', 'Cancel、timeout、crash recovery、compaction、exactly-once usage', '闭合'],
  ['GitHub Coding', '仓库/分支语义、审批代理、状态投影', '主体闭合*'],
]

const metricRows = [
  ['Public contract', 'PASS', '19/19 active registry；3 个 prompt template 本地投影逐字节一致；diff issues=0'],
  ['Harness convergence', '9/9', '42 tool calls；58 model calls；71.395s active；96.92% cache hit'],
  ['Frozen quality suite', '18/18', '平均 99.44；critical/efficiency 全通过；118 tool calls，0 failed'],
  ['Desktop UI states', '61/61', '1440×900；0 console error；0 horizontal/vertical overflow'],
  ['Visual build oracle', '0.96252', '1200×800 图片→可编辑网页任务；能力质量分，不冒充 Arena UI 像素分'],
  ['Recorded-video gap audit', 'P0=0 / P1=0', '补齐 research Artifact 发布门禁后的普通桌面主体范围'],
  ['Automated tests', '908', '51 个 test files；本次公开发布前重新运行'],
]

function ReportSection(props: { id: string; index: string; title: string; children: ReactNode }) {
  return <section className="report-section" id={props.id}>
    <div className="report-section-number">{props.index}</div>
    <div className="report-section-body"><h2>{props.title}</h2>{props.children}</div>
  </section>
}

export function ReplicationReport() {
  useEffect(() => {
    setPageMetadata('复刻报告 — Anera', 'Arena → Anera：Arena Agent Mode 桌面可观察契约的逆向复刻方法、指标、证据边界与静态运行回放。')
  }, [])

  return <div className="showcase-site report-page">
    <header className="showcase-nav report-nav">
      <BrandLink />
      <nav aria-label="Report actions"><a href={sessionPath(showcaseCatalog.defaultSessionId)}><Play size={13} fill="currentColor" /> 案例回放</a><a href={GITHUB_URL} target="_blank" rel="noreferrer"><Github size={15} /> 源码</a></nav>
    </header>

    <div className="report-layout">
      <aside className="report-toc">
        <span>Replication report</span>
        <nav aria-label="Report contents">
          <a href="#verdict">00 / 结论</a>
          <a href="#definition">01 / 什么叫复刻</a>
          <a href="#methodology">02 / 逆向方法</a>
          <a href="#architecture">03 / 实现架构</a>
          <a href="#evidence">04 / 指标证据</a>
          <a href="#capabilities">05 / 能力矩阵</a>
          <a href="#cases">06 / 运行案例</a>
          <a href="#limits">07 / 边界与限制</a>
        </nav>
        <a className="toc-home" href="/"><Home size={13} /> 返回项目首页</a>
      </aside>

      <main className="report-main">
        <section className="report-hero" id="verdict">
          <p className="showcase-eyebrow"><span>Technical replication report · 2026-08-31</span><i /></p>
          <h1>Arena → Anera<br /><em>一次字面与技术上的逆向。</em></h1>
          <div className="report-verdict">
            <span>Scope-bound verdict</span>
            <p><strong>Anera 已完成对 Arena Agent Mode“桌面可观察主体契约”的高保真复刻。</strong>在冻结的普通 Agent Mode v1 范围内，公开契约审计通过、19/19 active tools 闭环、18/18 质量任务通过、61/61 UI 状态通过，录屏差异审计的 P0 与 P1 均为 0。</p>
            <p>这里的“基本上一模一样”指用户可观察的输入、工具过程、状态迁移、Workspace、Artifact 与完成界面在主体路径上功能等价；不声称获得 Arena 私有源码，也不把尚未配对的 exact trace、像素、成本或移动端数据伪装成已证明。</p>
          </div>
        </section>

        <ReportSection id="definition" index="01" title="先定义“一模一样”">
          <p>黑盒复刻最容易犯的错误，是把“看起来像”当作“行为相同”，或反过来要求未知的内部实现逐行一致。Anera 把判断对象固定为 <b>observable contract</b>：在相同类别的输入与状态下，外部使用者实际能观察到什么。</p>
          <div className="definition-grid">
            <article><span>Input</span><strong>入口契约</strong><p>消息、附件、模型、仓库、连接器与交互式回答的结构和约束。</p></article>
            <article><span>Trace</span><strong>过程契约</strong><p>Thought、工具开始/完成、流式输出、审批、文件、进程与暂停恢复的顺序。</p></article>
            <article><span>Outcome</span><strong>结果契约</strong><p>最终回答、Workspace 内容、Artifact、预览、Review 与终态一致性。</p></article>
            <article><span>Boundary</span><strong>失败契约</strong><p>拒绝、超时、取消、崩溃恢复、额度与外部服务故障是否被如实投影。</p></article>
          </div>
          <blockquote>不是猜 Arena 内部“怎么写”，而是重建它对用户承诺的那条边界。</blockquote>
        </ReportSection>

        <ReportSection id="methodology" index="02" title="从 Arena 倒推 Anera">
          <div className="method-pipeline" aria-label="Reverse engineering pipeline">
            <div><span>A</span><strong>Surface intake</strong><p>只读抓取公开 bundle、完成页字符串、工具 schema 与传输包络。</p></div>
            <ChevronRight size={18} />
            <div><span>B</span><strong>Probe design</strong><p>65 个任务、H01–H57、AF01–AF16 与 active 19 工具机会。</p></div>
            <ChevronRight size={18} />
            <div><span>C</span><strong>Canonical trace</strong><p>统一 Arena 手工轨迹与 Anera append-only 事件，保留 unknown。</p></div>
            <ChevronRight size={18} />
            <div><span>D</span><strong>Falsification gates</strong><p>契约、质量、视觉、成本、故障和录屏缺口分别判定。</p></div>
          </div>
          <ol className="report-numbered-list">
            <li><b>冻结表面。</b> 从 Arena 公共部署中解析 59 个脚本资产，识别当前完成态路由使用的 19 工具注册表、参数 schema、描述、三套 prompt template、上传协议和 UI 文案。</li>
            <li><b>主动探针。</b> 不是重复跑几个 happy path，而是覆盖等价类、边界值、审批拒绝、失败恢复、长上下文、后台进程、连接器与多模态。</li>
            <li><b>轨迹归一。</b> 对两边事件建立 canonical JSONL；不可见值保持 `not_visible / not_captured / unknown / not_applicable`，不靠推测补齐。</li>
            <li><b>分层收敛。</b> C0 schema、C1 executor、C2 model loop、C3 lifecycle、C4 durability、C5 quality、C6 efficiency、C7 provider、C8 paired parity 分开门禁，避免一个总分掩盖缺口。</li>
            <li><b>反例优先。</b> 每个“完成”都需要机器 oracle 或外部可观察证据；Final 中自述成功不算证据。</li>
          </ol>
        </ReportSection>

        <ReportSection id="architecture" index="03" title="复刻落在一条耐久事件链上">
          <div className="architecture-map">
            <div className="architecture-input"><span>USER INPUT</span><b>text · files · repo · HITL</b></div>
            <div className="architecture-core">
              <article><span>01</span><strong>Agent loop</strong><small>model → tool calls → result feedback</small></article>
              <article><span>02</span><strong>Tool boundary</strong><small>19 active tools · policy · approval</small></article>
              <article><span>03</span><strong>Session store</strong><small>append-only events · crash recovery</small></article>
            </div>
            <div className="architecture-output"><span>UI PROJECTION</span><b>timeline · workspace · preview</b></div>
          </div>
          <p>核心不是一个“会调用工具”的循环，而是一次运行从接收输入到终态都能被重放：工具在执行前产生 durable reservation，结果与 usage 分开持久化，文件变更和 Artifact 有独立事件，崩溃后按 checkpoint 对账，UI 只投影可信事件而不是临时内存。</p>
          <p>这也是三栏界面能够与 Arena 相似的原因：左栏来自 Session 索引，中栏来自 canonical timeline，右栏来自 Workspace inventory；Preview 是 Artifact/Website 状态的另一种投影，而不是单独维护的假数据。</p>
        </ReportSection>

        <ReportSection id="evidence" index="04" title="指标必须说明它证明了什么">
          <div className="metric-table" role="table" aria-label="Replication metrics">
            {metricRows.map(([metric, value, evidence]) => <div className="metric-row" role="row" key={metric}>
              <span role="cell">{metric}</span><strong role="cell">{value}</strong><p role="cell">{evidence}</p><Check size={15} aria-label="passed" />
            </div>)}
          </div>
          <div className="evidence-notes">
            <article><span>为什么不是一个总相似度？</span><p>工具覆盖、任务质量、UI 状态与像素相似度回答的是不同问题。把它们压成单值会允许强项抵消缺失能力，因此报告保留分层结果。</p></article>
            <article><span>0.96252 是什么？</span><p>它是 Anera 完成“参考图→网页”任务的 PNG oracle 分数，证明视觉执行能力；它不是 Arena UI 与 Anera UI 的配对像素分。未配对的数据绝不改名。</p></article>
          </div>
          <a className="evidence-link" href={EVIDENCE_URL} target="_blank" rel="noreferrer">打开精选机器证据 <ExternalLink size={14} /></a>
        </ReportSection>

        <ReportSection id="capabilities" index="05" title="主体能力逐项对照">
          <div className="capability-table">
            <div className="capability-head"><span>能力域</span><span>可观察契约</span><span>判定</span></div>
            {capabilityRows.map(([domain, contract, status]) => <div className="capability-row" key={domain}><strong>{domain}</strong><p>{contract}</p><span>{status}</span></div>)}
          </div>
          <p className="table-footnote">* 媒体真实 provider、完整 GitHub 账户 writeback 与 Linux Bubblewrap 有 fail-closed canary，但受专用凭据/主机配置限制；因此不把 production account coverage 写成已通过。</p>
        </ReportSection>

        <ReportSection id="cases" index="06" title="四条真实运行，不是四张截图">
          <div className="report-case-grid">
            {showcaseCatalog.demos.map((demo) => <article key={demo.id}>
              <small>{demo.eyebrow}</small><h3>{demo.title}</h3><p>{demo.note}</p>
              <dl><div><dt>Active</dt><dd>{((demo.metrics.activeDurationMs ?? 0) / 1000).toFixed(3)}s</dd></div><div><dt>Model / tool</dt><dd>{demo.metrics.modelCalls} / {demo.metrics.toolCalls}</dd></div><div><dt>Tokens</dt><dd>{demo.metrics.totalTokens.toLocaleString()}</dd></div><div><dt>Est. cost</dt><dd>${demo.metrics.estimatedCostUsd.toFixed(5)}</dd></div></dl>
              <a href={sessionPath(demo.id)}><Play size={13} fill="currentColor" /> 播放事件回放</a>
            </article>)}
          </div>
          <p>静态站使用真实 Session 的脱敏快照。播放时按关键事件序列逐步放开同一份 trace，原 Anera reducer 再把事件投影为 Thought、工具组、文件、Artifact 与 Final；它不是另画一套“像 Anera 的演示界面”。</p>
        </ReportSection>

        <ReportSection id="limits" index="07" title="可信结论必须带着边界一起发布">
          <div className="limits-grid">
            <article className="limit-in"><span>本报告可以证明</span><ul><li>公共 active registry 与关键 prompt/UI/transport 契约已复刻。</li><li>桌面普通 Agent Mode 主体路径不存在 P0/P1 录屏缺口。</li><li>Anera 自身任务质量、耐久性与 UI 状态门禁均通过。</li><li>展示的四个案例确实来自可执行 Harness 的持久运行。</li></ul></article>
            <article className="limit-out"><span>本报告没有声称</span><ul><li>获得或复制 Arena 的私有源码、模型权重或内部路由。</li><li>65 题 v2 suite 已拥有同版本 Arena/Anera 全量配对样本。</li><li>已得到同 viewport、同状态的 exact DOM/PNG 像素 parity。</li><li>移动端、所有第三方账户和每次随机模型策略完全相同。</li></ul></article>
          </div>
          <div className="final-claim"><ShieldCheck size={22} /><p><strong>最终措辞：</strong>Anera 在“可观察的桌面 Agent Mode v1 主体能力”范围内，完成了足以让使用者获得基本相同交互模型与运行结果的高保真逆向复刻；exact paired parity 仍是更严格、尚待同版本证据关闭的下一道门禁。</p></div>
        </ReportSection>

        <section className="report-cta"><p>读完证据，回到产品本身。</p><div><a href={sessionPath(showcaseCatalog.defaultSessionId)}><Play size={14} fill="currentColor" /> 播放默认案例</a><a href={GITHUB_URL}>检查源码 <Github size={14} /></a></div></section>
      </main>
    </div>
  </div>
}

export function StaticDemoFrame() {
  const [sessionId, setSessionId] = useState(() => sessionIdFromPath(window.location.pathname))
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const stopTimer = () => {
    window.clearInterval(timer.current)
    timer.current = undefined
    setPlaying(false)
  }

  const showFullTrace = () => {
    stopTimer()
    if (sessionId) setShowcaseReplayLimit(sessionId, null)
    setProgress(null)
    window.dispatchEvent(new Event(SHOWCASE_REPLAY_EVENT))
  }

  const play = () => {
    const activeSessionId = sessionIdFromPath(window.location.pathname)
    if (!activeSessionId) return
    const checkpoints = showcaseReplayCheckpoints(activeSessionId)
    if (checkpoints.length === 0) return
    stopTimer()
    setSessionId(activeSessionId)
    let index = 0
    setShowcaseReplayLimit(activeSessionId, checkpoints[index])
    setProgress({ current: 1, total: checkpoints.length })
    setPlaying(true)
    window.dispatchEvent(new Event(SHOWCASE_REPLAY_EVENT))
    timer.current = window.setInterval(() => {
      index += 1
      if (index >= checkpoints.length) {
        stopTimer()
        setProgress({ current: checkpoints.length, total: checkpoints.length })
        return
      }
      setShowcaseReplayLimit(activeSessionId, checkpoints[index])
      setProgress({ current: index + 1, total: checkpoints.length })
      window.dispatchEvent(new Event(SHOWCASE_REPLAY_EVENT))
    }, 520)
  }

  useEffect(() => {
    const onNavigate = () => {
      stopTimer()
      clearShowcaseReplayLimits()
      setProgress(null)
      setSessionId(sessionIdFromPath(window.location.pathname))
      window.dispatchEvent(new Event(SHOWCASE_REPLAY_EVENT))
    }
    window.addEventListener(SHOWCASE_NAVIGATION_EVENT, onNavigate)
    window.addEventListener('popstate', onNavigate)
    return () => {
      stopTimer()
      window.removeEventListener(SHOWCASE_NAVIGATION_EVENT, onNavigate)
      window.removeEventListener('popstate', onNavigate)
    }
  }, [])

  return <div className="static-demo-frame">
    <header className="static-demo-toolbar">
      <div className="demo-toolbar-context"><span className="live-marker" /><strong>Static replay</strong><span>真实运行快照 · 只读</span></div>
      {sessionId && <div className="demo-replay-controls">
        <button onClick={playing ? stopTimer : play}>{playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}{playing ? '暂停' : progress ? '重新播放' : '播放过程'}</button>
        {progress && <span className="replay-progress" aria-label={`Replay step ${progress.current} of ${progress.total}`}><i style={{ width: `${(progress.current / progress.total) * 100}%` }} /></span>}
        {progress && <button className="icon-control" aria-label="Show full trace" title="显示完整轨迹" onClick={showFullTrace}><RotateCcw size={13} /></button>}
      </div>}
      <nav aria-label="Exhibit"><a href="/"><Home size={13} /> 首页</a><a href="/report">复刻报告</a><a href={GITHUB_URL} target="_blank" rel="noreferrer"><Github size={14} /> <span>GitHub</span></a></nav>
    </header>
    <div className="static-demo-body"><App /></div>
  </div>
}

export function normalizeShowcaseRoute(): void {
  const path = normalizedShowcasePath(window.location.pathname)
  if (path !== window.location.pathname) window.history.replaceState({}, '', path)
}
