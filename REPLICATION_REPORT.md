# Anera 复刻报告：把 `ARENA` 倒过来读

> `ARENA` 逐字倒序，恰好就是 `ANERA`。

这不只是一个名字游戏，也是项目的方法：Anera 没有接触 Arena 的私有源码，而是从用户能看到和操作的结果出发，逆向其公开工具契约、执行轨迹、工作区生命周期与桌面交互，再用可重复测试逐层重建。

因此，本报告中的“复刻”指向黑盒条件下的**可观察契约投影与主体能力重建**，不是对 Arena 不可见内部实现的臆测，也不是一份“逐轨迹、逐像素完全一致”的证明。

## 结论先行

在**桌面端普通 Agent Mode** 的声明范围内，Anera 已实现公开工具契约、核心交互结构、执行生命周期和主要任务能力的基本复刻。当前证据支持“主体复刻成立”，但不支持“与 Arena 一模一样”。

| 证据层 | 当前状态 | 它实际证明什么 |
|---|---|---|
| Public contract | **Verified** | 在冻结的 Arena 公开 deployment 上，19 个 active tools、参数 schema/描述、公开 prompt 投影、关键 UI 文案、上传与新对话 transport 无审计 drift。 |
| Harness capability | **Verified** | 9/9 能力场景通过，19/19 active tools 被覆盖，共 42 次 tool calls。 |
| Internal task quality | **Verified** | 单一指纹化完整批次 18/18 通过，平均质量分 100，critical/效率门禁全通过，0 个失败工具。 |
| Anera UI state coverage | **Verified** | 62/62 桌面状态回归通过，0 console error，0 水平溢出，0 outer-shell 垂直溢出。 |
| Exact paired trace | **N/A** | 尚无符合当前版本规则的 Arena reference / Anera candidate 配对。 |
| Same-viewport pixel parity | **N/A** | 尚无同 viewport、字体、缩放与人工动作脚本下的 DOM/PNG 配对。 |

这里的 `Verified` 是对各自证据层的项目结论，不是 Arena 或独立第三方认证。同样，项目内部“P0=0、P1=0”只表示当前普通 Agent Mode v1 的内部发布标准中没有已知阻断项，不应扩大为通用安全或 parity 证书。

## 复刻边界

本轮纳入：

- Arena 桌面端普通 Agent Mode 的可观察交互。
- 当前 completed route 使用的 19 个 active tools 及其公开参数/描述契约。
- 对话、Writing、Workspace、Artifact、Preview、Process/Website、Plan/HITL、Review、取消与恢复等主体生命周期。
- 文件、Web 研究、页面生成与浏览器验证等主要任务类型。

本轮排除或延期：

- 移动端。
- 完整 GitHub Connector 账户/私有仓库实证与 Arena 的远程实现等价。
- Arena 的私有 system prompt 附加部分、模型路由、缓存、计费、并发、调度与文件事务内部。
- 严格 paired trace、效率对比和同 viewport 像素 parity。
- 将 Anera 自有的 Browser/Vision 加强能力倒推为 Arena 的内部行为。

## 我们如何逆向一个黑盒 Agent

### 1. 冻结公开契约

公开契约审计只读取未登录的 Arena HTML/JavaScript 资产，不使用 Cookie 或 cookie jar。最新审计绑定到 deployment `dpl_GGVhypREjaK9mQC8Qik8L6iAbjnc`，解析 59 个 script assets 和 1 个 supplemental completed route，并对该冻结 route 的 active registry 做快照。

当时的 19 个 active tools 为：

```text
add_voice, ask_user, bash, compact, edit_file, fetch_page,
generate_image, generate_speech, get_process_output, image_search,
list_connector_tools, list_files, present_file, propose_plan, read_file,
start_process, stop_process, web_search, write_file
```

除工具名称与顺序外，审计还冻结了 argument schema、公开描述、关键 UI/Review/Preview 文案、上传策略与对话 transport。Arena 公开 bundle 中的三个 prompt 模板分别为 5,124 / 3,021 / 666 个字符，原始 SHA-256 被冻结；Anera 对固定输入的本地构造投影字节级一致。

这一结果仅限定于公开 bundle 投影，不证明 Arena 服务端没有再追加私有指令或校验。

### 2. 观察真实产品行为

两类行为材料被分开使用：

- 历史 reference corpus 包含 9 条结构化 run、231 个 canonical events，用于校准事件 schema、失败透明度、暂停/恢复和 Workspace/Process/Review 生命周期。
- 259.660 秒的登录态录屏展示了一条完整的“搜索 → Writing → 编辑 → 校验 → Preview → Review”链路。

录屏复刻采用可追溯的只读操作审计，而不是凭印象模仿画面：先冻结原始提示、视频时长、分辨率与 SHA-256，并保持源文件不变；再按每 5 秒抽样、场景切换抽样和关键时间点精确抽样三层取证。每个节点只记录 timecode、屏幕直接可见的文案、状态、用户动作与内部帧引用，并标为 F（直接事实）、I（合理推断）或 U（黑盒不可知）。这段录屏能够直接确认的事件偏序是“提交 → 三轮搜索 → 13 页设计计划 → 561 行、约 39.2 KB 的 HTML Writing → 编辑与 shell 校验 → Final → 单 blob Workspace upload → docked Preview 从 1/13 翻到 13/13 → 三项 Task Review”；这些 F 事实被翻译为 Anera 的状态机、面板归属和完成门禁，I 只用于提出待验证假设，U 始终保持未知。

录屏不能推出 Arena 的隐藏 system prompt、底层模型、provider、原始工具参数/结果、文件事务、token/cost 或后端调度。Anera 的实现正确性仍由独立单测、Browser/Vision 路径和产物 oracle 验证，尚无同提示 paired E2E 的项目继续标为 N/A。公开 evidence pack 只发布脱敏统计、hash 和相对路径，不包含原始帧、账户画面或主机路径。

### 3. 把观察变成可执行的 oracle

Anera 没有把“终端显示 success”当成任务正确性。每一层证据分开审计：

- contract audit 比较公开契约快照与本地投影。
- capability harness 检查工具和生命周期能否真正走通。
- task benchmark 用独立结果 oracle 检查产物，不只检查 UI 终态。
- UI capture 只检查 Anera 自身状态回归，不伪装成 Arena PNG 对比。
- live-provider smoke 与 deterministic fixture 分开标记，不把 fixture 写成真实外部调用。

## 从观察到实现

| 可观察能力 | Anera 实现 | 核心源码 |
|---|---|---|
| 19 工具、动态路由与 bounded loop | 冻结公开工具面，按当前任务状态加载 Browser、Vision、Office 等扩展；限制步数、调用数、并发和重复调用。 | [`src/server/agent-service.ts`](src/server/agent-service.ts), [`src/server/deepseek.ts`](src/server/deepseek.ts) |
| 三栏对话与执行投影 | 流式 Thought/Final、Writing、工具卡、Workspace、Preview、Review 和运行态操作。 | [`src/client/App.tsx`](src/client/App.tsx), [`src/client/styles.css`](src/client/styles.css) |
| Writing → durable Workspace → Artifact | 将流式工具参数投影为草稿，成功变更后交给持久事件和 Artifact。 | [`src/server/workspace.ts`](src/server/workspace.ts), [`src/server/artifact.ts`](src/server/artifact.ts), [`src/client/App.tsx`](src/client/App.tsx) |
| Plan / HITL / Approval / Review | 同 episode 暂停与恢复，耐久决策，Final 后的审查与继续工作。 | [`src/server/agent-service.ts`](src/server/agent-service.ts), [`src/server/session-store.ts`](src/server/session-store.ts), [`src/client/App.tsx`](src/client/App.tsx) |
| Process / Website / Preview | 管理进程，发布 Workspace Website，支持重启、休眠和恢复。 | [`src/server/process-manager.ts`](src/server/process-manager.ts), [`src/server/tools.ts`](src/server/tools.ts) |
| 真实页面交互与视觉验收 | 用真实 headless browser 执行 open/snapshot/click/fill/press/viewport/console/screenshot，再用 Vision 检查布局、裁切、对比度和重叠。 | [`src/server/browser-manager.ts`](src/server/browser-manager.ts), [`src/server/vision.ts`](src/server/vision.ts), [`src/server/tools.ts`](src/server/tools.ts) |
| 取消、失败与崩溃恢复 | append-only 事件、重放安全的状态转换、工具/工作区调和，失败不投影为 success。 | [`src/server/session-store.ts`](src/server/session-store.ts), [`src/server/workspace-patch.ts`](src/server/workspace-patch.ts), [`src/server/agent-service.ts`](src/server/agent-service.ts) |
| 执行安全边界 | Workspace 路径、公共网络、命令策略、OS sandbox 状态和敏感信息投影分层处理。 | [`src/server/command-policy.ts`](src/server/command-policy.ts), [`src/server/network-policy.ts`](src/server/network-policy.ts), [`src/server/os-sandbox.ts`](src/server/os-sandbox.ts), [`src/server/redaction.ts`](src/server/redaction.ts) |

## 量化结果：分层报告，不制造一个假总分

| 结果 | 数值 | 证据类型 | 不能推导的结论 |
|---|---:|---|---|
| 公开契约审计 | PASS；19/19 active tools | 未登录公开 bundle 快照 | 不代表 Arena 私有后端完全相同。 |
| Harness convergence | 9/9 场景；19/19 工具；42 calls | 真实 DeepSeek 规划 + 确定性外部 fixture | 不代表所有外部 provider 都在该次运行中真实调用。 |
| 内部质量基准 | 18/18；平均 100；115 physical/metered model calls；118 tools；0 failed tools | 真实 DeepSeek + deterministic outcome oracles | 该报告明确记录 `arenaParityEvidence: false`，不是 Arena parity 分数。 |
| UI 状态回归 | 62/62；0 console / horizontal / outer-shell vertical overflow | Anera 桌面端自身截图与交互回归 | 不是 Arena 同 viewport PNG diff。 |
| Web provider canary | PASS | Tavily / Firecrawl 生产 ToolExecutor 真实路径 | 该证据不能用于证明 Arena 使用同一 provider。 |
| Vision task smoke | PASS；`liveProvider: true` | DeepSeek Vision 真实路径，inspect → build → browser → inspect → present | 不是下文原始 HTML Slides prompt 的同 episode 实证。 |
| 原提示 HTML Slides latest attestation | PASS；16/16 checks；10 model / 10 tool；80.528 s；`$0.04182607` | 真实 DeepSeek 文本/视觉路径；schema v3 绑定 verifier 与 51 个 production runtime 文件 | 不是 Arena trace、成本或像素 parity。 |

这些数值必须保持分层。`19/19`、`9/9`、`18/18`、内部质量 `100` 和 `62/62` 不能被算术合并成“100% Arena parity”。

## 代表性任务：AI 热点 HTML Slides

用于录屏审计的原始提示为：

> 看看本周的AI领域热点，创建一个精美的HTML Slides进行展示。

| 阶段 | Arena 录屏中的可观察行为 | Anera 当前实现 | 证据状态 |
|---|---|---|---|
| 路由与研究 | 多轮 Web 搜索，然后规划页面结构与风格。 | `isVisualWebArtifactTask` 覆盖原中文提示及中英文变体；原提示也进入 `isSingleArtifactWebTask`。时效性任务要求在最终 artifact mutation 之前有 Web research。 | 确定性路由/门禁已有单测。 |
| 生成 | 持续 Writing，完成后出现 HTML artifact 和内联 Preview。 | 第一份完整 HTML 固定 canonical path，后续定向编辑，避免产生竞争的整文件变体。 | 最新原提示 live E2E 已生成并呈现 20,905 B canonical HTML。 |
| 功能验收 | Arena 本次环境的 browser 探测失败，主要使用 parser/Node 检查，最后由用户翻页。 | 完成门禁要求 Website preview → Browser open → click/press 导航 → 导航后 screenshot。 | 原提示 live E2E 的完整顺序检查通过。 |
| 视觉验收 | 录屏没有证明 Arena 模型看过页面截图。 | 必须用 `inspect_image` 检查上一步的确切截图；有缺陷则修复并重验，直到获得 `NO DEFECTS`。 | 原提示导航后截图已由真实 Vision 检查通过。 |
| 交付 | Artifact、Preview、Workspace upload、Final 和 Review 依次出现。 | 验收后必须对 canonical HTML 执行 `present_file`，之后才能 Final。 | 原提示仅发布一个 Final，且 `present_file` 位于其前。 |

相关路由与完成门禁位于 [`src/server/agent-service.ts`](src/server/agent-service.ts)，原提示和中英文路由、完整阶段链的定向测试位于 [`src/server/agent-service.test.ts`](src/server/agent-service.test.ts)。本报告编写时，相关定向 Vitest 为 **12/12 通过**。

[`scripts/html-slides-task-smoke.mjs`](scripts/html-slides-task-smoke.mjs) 已在被测 production bundle 上用原提示完成 live-provider 同 episode E2E。不可变报告为 [`reports/real-smokes/html-slides-2026-08-31T22-50-17-228Z/report.json`](evidence/html-slides-live-summary.json)：16/16 checks 为 true，10 model requests/calls、10 tools、80.528 s、估算 `$0.04182607`，0 tool failure/timeout；HTML 为 20,905 B / SHA-256 `e09054a47b19233b50ce50ad8c5e273a137124792c765b4dce16e4c2e81c2f09`，10 个可见来源链接；导航后截图为 138,131 B / SHA-256 `29767ce948772cc67a5d4305a70c04178093826e6187bafa75d018feaa7c4891`。报告记录 `deepseek-chat`、`deepseek-v4-flash-vision-exp`、`temperature=0`。implementation fingerprint schema v3 聚合值 `56a56ce8379333b83081e2b85832969c4a968cfab18dbf4ce92fc0e28d5fd099` 绑定 verifier、自身算法、源码入口、依赖锁、完整 production server/shared runtime 和 client assets，共 51 个文件；后续任一运行时或 verifier 变化都必须重新运行，不能沿用该指纹。

> **HTML Slides 的确定性路由、完成门禁和原提示真实 provider 同 episode E2E 已通过；Arena 同题 trace、成本与像素 parity 仍为 N/A。**

## 为什么严格 parity 仍然是 N/A

当前 Arena reference corpus 有 9 个历史结构化 run、231 个事件，但只覆盖 57 个 H 维度中的 17 个，并保留 4 个 unmapped 观察。历史任务 oracle 是 5 pass / 3 partial / 1 fail，这也说明 UI terminal success 不能代替任务正确性。

更重要的是：

- 当前 v2.0 eligible Arena reference = 0。
- exact-version Anera candidate = 0。
- Arena 的 model calls、tokens 和 cost 不可见。
- 现有 UI 截图没有按同 viewport/字体/缩放/动作脚本与 Arena 配对。

所以 trace score、效率对比与 pixel score 必须显示 **N/A**，不是 0，也不能根据主观观感补分。要结束 N/A，需要在同一冻结协议下采集 Arena reference 与 Anera candidate，先通过任务 oracle，再比较事件偏序、失败/恢复、活跃时长与 DOM/PNG。

## 公开证据索引

为避免公开大量历史 trace、本机路径或登录态账户画面，发布材料仅保留必要摘要、统计、hash 和相对路径。证据层的统一解读边界见 [evidence pack 索引](evidence/README.md)；下列文件是本报告的精选来源：

- [公开契约摘要](evidence/public-contract-summary.md)
- [Harness convergence 摘要](evidence/harness-convergence-summary.json)
- [内部质量基准摘要](evidence/quality-benchmark-summary.json)
- [UI 状态覆盖摘要](evidence/ui-state-coverage-summary.json)
- [Tavily / Firecrawl live path 摘要](evidence/live-web-provider-summary.json)
- [DeepSeek Vision live path 摘要](evidence/live-vision-summary.json)
- [原提示 HTML Slides live canary 摘要](evidence/html-slides-live-summary.json)
- [Arena reference corpus 摘要](evidence/arena-reference-corpus-summary.md)
- [Arena 录屏审计摘要](evidence/arena-video-audit-summary.md)

完整内部原始报告保留用于审计，但不等于每个文件都适合直接公开。原始录屏截图、账户 UI、密钥、本机绝对路径和无关历史任务不应进入公开站点。

## 最终判定

Anera 已经重建了 Arena 桌面端普通 Agent Mode 最重要的可观察契约：公开工具面、三栏执行投影、Writing/Workspace/Artifact 生命周期、Plan/HITL/Review、Process/Website/Browser、取消/恢复与研究产物交付门禁。公开契约、Harness 闭环、内部任务质量、Anera UI 状态和部分真实 provider 路径都有分层证据。

因此，最稳妥也最可复核的结论是：

> **在桌面端普通 Agent Mode 的声明范围内，Anera 已实现公开工具契约、核心交互结构、执行生命周期和主要任务能力的基本复刻；严格 paired trace / pixel parity 仍为 N/A。**
