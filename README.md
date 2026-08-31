<p align="center">
  <img src="logo.png" alt="Anera logo" width="112" />
</p>

# Anera

**Anera 是一个可本地运行的桌面 Agent Mode Harness。** 它基于 Arena Agent Mode 的公开页面、可见执行日志、手工运行数据和录屏进行独立黑盒重建，重点复现“模型如何调用工具、持久执行、验证产物并交付结果”的主体能力。

> 当前结论：桌面 Agent Mode v1 主体能力已收敛，P0/P1 阻断项为 0，可以作为后续 Arena 对齐与能力迭代的稳定基线。

## 一眼看懂当前状态

| 项目 | 状态 | 说明 |
| --- | ---: | --- |
| 桌面 Agent Mode 主链 | ✅ | 任务 → 推理 → 工具 → 校验 → Artifact/Website → Final |
| Active 工具基线 | 19/19 | schema、执行器、结果回灌、持久事件和真实控制循环均已闭环 |
| 冻结质量任务 | 18/18 | 平均质量 99.44，118 次工具调用，0 次工具失败 |
| 原提示 HTML Slides canary | ✅ | 联网研究、HTML、Preview、Browser、截图、视觉检查、发布与唯一 Final 全链通过 |
| 桌面 UI 状态 | 61/61 | 1440×900，0 console error，0 外层溢出 |
| 工程门禁 | 52 / 940 | 52 个测试文件、940 项测试全部通过；typecheck 和 production build 通过 |

这里的“完成”指 **Anera 自身主体能力闭环**，不代表已取得 Arena 私有源码或模型权重，也不代表与 Arena 的随机策略、逐像素 UI、逐步轨迹和成本完全相同。

## 核心能力

- **Agent 控制循环**：流式 Thought、工具选择、并行读取、顺序 mutation、失败恢复、唯一 Final。
- **持久任务生命周期**：Cancel、Continue/Resume、context compaction、进程重启恢复、幂等事件和 usage 结算。
- **Workspace 与执行环境**：文件读写/编辑/搜索、Shell、依赖安装、附件提取、受管 Process 和 Website Preview。
- **联网研究**：Tavily 搜索、Firecrawl 抓取及安全 fallback；来源 URL ledger、引用校验和零来源 fail-closed。
- **Browser 与视觉验证**：真实页面打开、交互、截图，以及 DeepSeek `deepseek-v4-flash-vision-exp` 视觉检查。
- **Artifact 交付**：HTML、Markdown、图片、PDF、Office 文件等产物的 Workspace 投影、验证与 `present_file` 发布。
- **Human-in-the-loop**：提问、选项、Plan 修订/接受、媒体选择和高影响外部操作 Approval。
- **桌面工作台**：会话历史、执行时间线、Workspace、Artifact/Website 查看器和只读 Showcase。

典型执行链如下：

```text
用户任务 / 附件
      ↓
意图与工具路由
      ↓
模型 ↔ 工具执行循环
      ↓
持久化 Session / Workspace / Usage
      ↓
来源、结构、Browser 与视觉门禁
      ↓
present_file / Website
      ↓
唯一用户可见 Final
```

## 快速开始

要求：Node.js 22、npm，以及一个可用的 DeepSeek API Key。需要运行 Browser 验证时，宿主机还应安装 Chrome 或 Chromium。

```bash
npm ci
cp .env.example .env
# 编辑 .env，至少填写 DEEPSEEK_API_KEY
npm run dev
```

打开 `http://127.0.0.1:5173`。开发模式下，Vite 会把 `/api` 和 `/workspace` 代理到 `http://127.0.0.1:4174`。

建议首先运行这个覆盖研究与视觉交付主链的任务：

```text
看看本周的AI领域热点，创建一个精美的HTML Slides进行展示。
```

### 环境变量

| 变量 | 必需 | 用途 |
| --- | ---: | --- |
| `DEEPSEEK_API_KEY` | 是 | Agent 文本模型与 DeepSeek 视觉模型 |
| `TAVILY_API_KEY` | 否 | 生产级 Web Search；兼容历史拼写 `TAVILY_API_KRY` |
| `FIRECRAWL_API_KEY` | 否 | 生产级网页抓取 |
| `ANERA_PUBLIC_BASE_URL` | 否 | 反向代理部署时的公开 origin |

未配置 Tavily/Firecrawl 时，Harness 仍保留受网络安全策略约束的公开网络 fallback。完整配置以 [.env.example](.env.example) 和 [PRODUCTION_CANARY_RUNBOOK.md](PRODUCTION_CANARY_RUNBOOK.md) 为准。

### Production

```bash
npm run build
npm start
```

默认打开 `http://127.0.0.1:4174`。

## 验证与证据

日常发布门禁：

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

需要验证完整联网 HTML Slides 路径时运行：

```bash
npm run canary:html-slides
```

已发布 canary 摘要见 [evidence/html-slides-live-summary.json](evidence/html-slides-live-summary.json)。它证明 Anera 的生产链路可闭环，不是 Arena 同题 parity 分数。

## 当前范围

本版本纳入：

- 桌面端 Agent Mode 主体能力；
- ordinary Agent 的 19-tool 基线与 Anera 安全/分页 overlay；
- 研究、附件、代码、数据、Office、PDF、Website、Browser、视觉和媒体主路径；
- 持久化、恢复、Cancel/Resume、HITL、Approval 与安全边界。

明确延期：

- 移动端实现与移动端视觉验收；
- 完整 GitHub Connector 和真实账户全覆盖；
- 与 Arena 同版本、同任务的 exact trace / pixel / latency / cost A/B parity；
- 模型随机策略和私有内部实现的逐步复刻。

这些延期项不会反向阻断当前 Agent Mode 主体基线。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `src/server/agent-service.ts` | Agent 循环、路由、恢复与完成门禁 |
| `src/server/session-store.ts` | Session、事件、Workspace 与恢复状态持久化 |
| `src/server/tools.ts` | 文件、Shell、Web、Browser、媒体与发布工具 |
| `src/client/App.tsx` | 桌面会话时间线、Workspace、Artifact 与 Website UI |
| `src/eval/` | 契约、canonical trace、质量和视觉评估 |
| `scripts/` | smoke、benchmark、canary 和 Showcase fixture 工具 |
| `evidence/` | 可提交、脱敏、机器可读的发布证据索引 |

## 只读 Showcase

Showcase 使用真实 Anera Session 的脱敏快照展示桌面 UI，但禁止提交任务、上传、反馈、进程重启和实时 Workspace 写入。

```bash
npm run dev:showcase
```

打开 `http://127.0.0.1:5173`，主要路由为 `/`、`/report` 和 `/agent/:sessionId`。

重新生成静态 fixtures：

```bash
npm run showcase:fixtures
npm run build:showcase
```

## 深入阅读

- [REPLICATION_REPORT.md](REPLICATION_REPORT.md) — 黑盒复刻方法、结论与限制
- [AGENT_HARNESS_CAPABILITY_MATRIX.md](AGENT_HARNESS_CAPABILITY_MATRIX.md) — 能力闭环与逐项证据
- [FIDELITY_AUDIT.md](FIDELITY_AUDIT.md) — fidelity 审计和未关闭边界
- [CANONICAL_TRACE_EVAL.md](CANONICAL_TRACE_EVAL.md) — trace 规范与评估方法
- [ARENA_MANUAL_PROBE_RUNBOOK.md](ARENA_MANUAL_PROBE_RUNBOOK.md) — Arena 手工采样方法
- [evidence/README.md](evidence/README.md) — 发布证据索引

## 安全与声明

- `.env`、`.anera/`、完整 `reports/` 和生成的评估 Workspace 默认不进入版本控制。
- Showcase 只包含选定且脱敏的只读资产；凭据不得提交到仓库。
- Shell 在可用时使用 macOS Seatbelt 或 Linux Bubblewrap；生产环境可设置 `ANERA_REQUIRE_OS_SANDBOX=true` 强制该边界。
- Anera 是基于公开可观察行为的独立实现，与 Arena 的所有者不存在隶属或背书关系。
