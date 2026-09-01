<p align="center">
  <img src="logo.png" alt="Anera" width="120" />
</p>

<h1 align="center">Anera</h1>

<p align="center">
  一个可本地运行、可观察、可恢复的桌面 Agent Mode Harness
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#一次任务如何运行">运行原理</a> ·
  <a href="#能力地图">能力地图</a> ·
  <a href="#验证基线">验证基线</a> ·
  <a href="#范围与边界">范围与边界</a> ·
  <a href="#项目结构">项目结构</a>
</p>

Anera 基于 Arena Agent Mode 的公开页面、可见执行日志、手工运行数据与录屏进行独立黑盒重建。它不是一个普通聊天界面，而是一套完整的 Agent Harness：让模型选择工具、持续执行任务、保存和恢复状态、验证结果，最后交付文件或可运行网站。

| 项目 | 当前状态 |
| --- | --- |
| 版本 | **桌面 Agent Mode v1 · 主体能力已收敛** |
| 主链 | 任务 → 推理 → 工具 → 持久化 → 验证 → 产物/网站 → 最终回复 |
| 能力 | 19 工具 Agent、Workspace、联网研究、Browser、视觉验证、人机协作、Cancel/Resume 与故障恢复 |
| 工程门禁 | 53 个测试文件 / 963 项测试；类型检查、Production/Showcase 构建与依赖审计均通过 |
| 暂缓 | 移动端、完整 GitHub Connector、Arena exact trace/pixel/latency/cost parity |

> “主体能力已收敛”指 Anera 自身的桌面执行链已经闭环，不代表获得了 Arena 的私有源码、模型权重或内部策略。

| 如果你想…… | 直接前往 |
| --- | --- |
| 立即运行产品 | [快速开始](#快速开始) |
| 理解 Agent 如何执行任务 | [一次任务如何运行](#一次任务如何运行) |
| 查看支持的能力 | [能力地图](#能力地图) |
| 查看验证结果与证据 | [验证基线](#验证基线) 与 [公开证据](evidence/README.md) |
| 理解“复刻”的定义和限制 | [范围与边界](#范围与边界) 与 [复刻报告](REPLICATION_REPORT.md) |

## 快速开始

### 1. 准备环境

- Node.js 22
- npm
- DeepSeek API Key
- macOS Seatbelt 或 Linux Bubblewrap 系统级沙箱
- Chrome 或 Chromium，仅在需要 Browser 验证时使用

服务默认要求可用的系统级执行沙箱；不满足时会拒绝启动。仅限受信任的本地调试环境可用 `ANERA_REQUIRE_OS_SANDBOX=false` 显式关闭这项门禁。

### 2. 安装与配置

```bash
npm ci
cp .env.example .env
```

编辑 `.env`：

| 变量 | 必需 | 用途 |
| --- | ---: | --- |
| `DEEPSEEK_API_KEY` | 是 | Agent 文本推理与 DeepSeek 视觉理解 |
| `TAVILY_API_KEY` | 建议 | Web Search 与图片搜索 |
| `FIRECRAWL_API_KEY` | 建议 | 网页正文抓取 |
| `PEXELS_API_KEY` | 否 | Pexels 图片/视频搜索；图片搜索也可回退到 Tavily |
| `ANERA_IMAGE_API_KEY` 或 `OPENAI_API_KEY` | 否 | 图片生成、声音试听与语音合成 |
| `DEEPSEEK_VISION_MODEL` | 否 | 视觉模型；默认 `deepseek-v4-flash-vision-exp` |
| `ANERA_MODEL_FIRST_EVENT_TIMEOUT_MS` | 否 | DeepSeek 首个流事件等待上限；默认 `20000`，超时会安全重试 |
| `ANERA_PUBLIC_BASE_URL` | 否 | 反向代理部署时的公开 origin |
| `ANERA_REQUIRE_OS_SANDBOX` | 否 | 默认 `true`；仅受信任的本地调试可关闭 |

只填写 `DEEPSEEK_API_KEY` 即可运行 Agent 主链；Tavily 与 Firecrawl 用于生产级联网研究，Pexels 与 OpenAI-compatible 媒体 Provider 用于补齐图片/语音能力。`TAVILY_API_KRY` 这个历史拼写仍兼容，但新配置应使用 `TAVILY_API_KEY`。未配置 Tavily 或 Firecrawl 时，Harness 会使用受网络安全策略约束的 fallback。配置模板见 [.env.example](.env.example)，完整媒体 Provider 配置与真实 canary 见 [PRODUCTION_CANARY_RUNBOOK.md](PRODUCTION_CANARY_RUNBOOK.md)。

### 3. 启动

```bash
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。开发模式下，Vite 会把 `/api` 与 `/workspace` 代理到本地 Agent Server `http://127.0.0.1:4174`。

用下面的任务可以一次覆盖研究、文件生成、Website Preview、Browser 和视觉检查主链：

```text
看看本周的 AI 领域热点，创建一个精美的 HTML Slides 进行展示。
```

### 4. Production 运行

```bash
npm run build
npm start
```

Production 默认监听 [http://127.0.0.1:4174](http://127.0.0.1:4174)。反向代理部署时可通过 `ANERA_PUBLIC_BASE_URL` 设置公开 origin。

## 一次任务如何运行

```text
用户任务 / 附件
        ↓
模型推理 ←→ 工具执行
        ↓
Session / Event / Workspace 持久化
        ↓
来源、结构、Browser、视觉质量门禁
        ↓
产物（Artifact）/ 网站预览 / present_file
        ↓
唯一用户可见的最终回复（Final）
```

执行过程会实时投影到桌面工作台：中间是对话与 Thought/Tool 时间线，右侧承载 Workspace、文件预览、Artifact 和运行中的 Website。任务被取消、服务重启或上下文压缩后，Harness 会从持久状态继续，而不是把一次运行仅保存在内存中。

## 能力地图

| 层 | 已实现能力 |
| --- | --- |
| Agent Runtime | 流式 Thought、工具路由、并行读取、顺序写操作、失败恢复、唯一 Final |
| 生命周期 | Cancel、Continue/Resume、context compaction、进程重启恢复、幂等事件与 usage 结算 |
| Workspace | 文件读写、精确编辑、搜索、Shell、依赖安装、附件提取、分页与大文件处理 |
| 联网研究 | Tavily Search、Firecrawl Fetch、安全 fallback、来源台账、引用校验、无来源时拒绝交付 |
| Browser 与视觉 | 真实页面打开与交互、截图、DeepSeek `deepseek-v4-flash-vision-exp` 视觉检查 |
| Process 与 Website | 受管后台进程、端口发现、实时日志、Website Preview、空闲休眠与恢复 |
| Artifact | HTML、Markdown、图片、PDF、Office 等文件的预览、验证、下载与 `present_file` 发布 |
| 人机协作（HITL） | 澄清提问、选项、Plan 修订/接受、媒体选择和高影响外部操作 Approval |
| 桌面 UI | Session 历史、执行时间线、Workspace、Artifact/Website Viewer 和只读 Showcase |

## 验证基线

下表是仓库中可复核的**最近一次冻结结果**；它们证明对应版本在对应门禁下通过，不会自动替代代码变更后的重新验证。

| 基线 | 最近冻结结果 | 它证明什么 |
| --- | ---: | --- |
| [Arena 公开契约](evidence/public-contract-summary.md) | **PASS · 0 issues** | 冻结审计中的 19 个工具定义、关键提示约束和桌面交互契约无已知 drift |
| [Harness Convergence](evidence/harness-convergence-summary.json) | **9/9 场景 · 19/19 tools** | 已发布冻结结果覆盖 42 次工具调用；包含一次故意失败并成功换策略的恢复场景 |
| [内部任务质量](evidence/quality-benchmark-summary.json) | **18/18 任务 · 平均质量 100** | 118 次工具调用，0 次意外失败；这是 Anera 内部基准，不是 Arena parity 分数 |
| [录屏原提示 E2E](evidence/html-slides-live-summary.json) | **PASS · 16/16 checks** | 被测 production bundle 完成研究、HTML、Browser、截图、Vision、发布与唯一 Final |
| [真实联网 Provider](evidence/live-web-provider-summary.json) | **PASS** | Tavily 搜索/图片回退、Firecrawl 多段抓取与 turn 内缓存均通过真实调用验证 |
| [真实 Vision Provider](evidence/live-vision-summary.json) | **PASS · 最新任务 2/2 calls** | DeepSeek Vision 两次 physical/metered 调用、Browser 复核与 Artifact 交付在同一任务闭环 |
| [桌面 UI 回归](evidence/ui-state-coverage-summary.json) | **62/62 状态** | 1440×900 下 0 console error、0 横向与外层纵向溢出；62 张截图均验证 bytes/SHA-256 |
| 当前工程门禁 | **53 个文件 / 963 项测试** | 单元、集成与契约测试、typecheck、Production/Showcase 构建与高危依赖审计通过 |

这些数字是 **Anera 自身的冻结回归基线**，不是“Arena 相似度百分比”。它们不能证明 Arena 的私有后端、模型权重、随机策略、逐步轨迹、像素、延迟或成本与 Anera 相同。

| 场景 | 命令 | 外部调用 |
| --- | --- | ---: |
| 日常工程门禁 | `npm run typecheck && npm test && npm run build && npm run build:showcase` | 无 |
| 依赖安全审计 | `npm audit --audit-level=high` | npm registry |
| 19-tool 综合回归 | `npm run test:harness-convergence` | DeepSeek；其他 Provider 使用 fixtures |
| Tavily / Firecrawl canary | `npm run canary:web-research-providers` | Tavily、Firecrawl |
| 完整 HTML Slides E2E | `npm run canary:html-slides` | DeepSeek、Tavily、Firecrawl、Browser |
| Arena 公开契约审计 | `npm run audit:arena-public-contract` | Arena 公开页面与静态资源 |

真实 Provider canary 会消耗 API 配额并受实时网络状态影响；普通开发提交优先运行“日常工程门禁”。综合回归使用真实配置的 DeepSeek provider，模型采样仍可能带来轻微波动。

可提交的脱敏摘要证据位于 [evidence/](evidence/README.md)，详细能力与限制见 [AGENT_HARNESS_CAPABILITY_MATRIX.md](AGENT_HARNESS_CAPABILITY_MATRIX.md) 和 [FIDELITY_AUDIT.md](FIDELITY_AUDIT.md)。

## 范围与边界

| 当前版本纳入 | 明确暂缓 |
| --- | --- |
| 桌面端 Agent Mode 主体链路 | 移动端实现与移动端视觉验收 |
| 19 工具普通 Agent 基线，以及 Anera 的安全与分页增强 | 完整 GitHub Connector 与真实账户全覆盖 |
| 研究、附件、代码、数据、Office、PDF、Website、Browser、视觉与媒体主路径 | 与 Arena 同任务、同版本的 exact trace/pixel/latency/cost A/B parity |
| 持久化、恢复、Cancel/Resume、HITL、Approval 与安全边界 | Arena 的私有实现、模型权重与随机策略复刻 |

这里的“一样”被拆成可验证的多层目标：公开工具契约、可观察执行语义、任务结果质量、状态机和桌面 UI。当前版本优先保证 Agent Mode 主体能力；严格的 Arena 同题对照评估保留为下一阶段，不会被当前内部通过率替代。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| [`src/server/agent-service.ts`](src/server/agent-service.ts) | Agent 循环、工具选择、恢复与完成门禁 |
| [`src/server/tools.ts`](src/server/tools.ts) | 文件、Shell、Web、Browser、媒体与发布工具 |
| [`src/server/session-store.ts`](src/server/session-store.ts) | Session、事件、Workspace 与恢复状态持久化 |
| [`src/client/App.tsx`](src/client/App.tsx) | 桌面对话时间线、Workspace、Artifact 与 Website UI |
| [`src/eval/`](src/eval/) | canonical trace、契约、质量与视觉评估 |
| [`scripts/`](scripts/) | smoke、benchmark、canary 与 Showcase fixture |
| [`evidence/`](evidence/) | 脱敏、机器可读、可提交的发布证据索引 |

## 只读 Showcase

Showcase 使用真实 Anera Session 的脱敏快照展示桌面 UI，不会提交任务、上传文件、发送反馈、重启进程或修改实时 Workspace。

```bash
npm run dev:showcase
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，主要路由为 `/`、`/report` 与 `/agent/:sessionId`。

重新生成静态 fixtures：

```bash
npm run showcase:fixtures
npm run build:showcase
```

## 进一步阅读

- [REPLICATION_REPORT.md](REPLICATION_REPORT.md) — 黑盒复刻方法、结论与限制
- [AGENT_HARNESS_CAPABILITY_MATRIX.md](AGENT_HARNESS_CAPABILITY_MATRIX.md) — 能力闭环与逐项证据
- [FIDELITY_AUDIT.md](FIDELITY_AUDIT.md) — fidelity 审计与尚未关闭的边界
- [CANONICAL_TRACE_EVAL.md](CANONICAL_TRACE_EVAL.md) — trace 规范与评估方法
- [ARENA_MANUAL_PROBE_RUNBOOK.md](ARENA_MANUAL_PROBE_RUNBOOK.md) — Arena 手工采样方法
- [PRODUCTION_CANARY_RUNBOOK.md](PRODUCTION_CANARY_RUNBOOK.md) — 真实 Provider 与发布前 canary 操作说明
- [evidence/README.md](evidence/README.md) — 发布证据导航

## 安全与声明

- `.env`、`.anera/`、完整 `reports/` 与生成的评估 Workspace 默认不进入版本控制。
- Showcase 只包含选定且脱敏的只读资产；凭据不得提交到仓库。
- Shell 使用 macOS Seatbelt 或 Linux Bubblewrap 隔离；`ANERA_REQUIRE_OS_SANDBOX` 默认为 `true`，缺少支持时服务会 fail-closed。
- Anera 是基于公开可观察行为的独立实现，与 Arena 的所有者不存在隶属、授权或背书关系。
