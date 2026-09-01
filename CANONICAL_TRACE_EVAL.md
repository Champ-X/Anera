# Arena ↔ Anera canonical trace 与等价性基线

更新日期：2026-08-31
Schema：`anera-canonical-trace/1.0`
Diff：`anera-trace-diff/1.0`

## 1. “一模一样”的可检验定义

黑盒条件下不能证明私有 system prompt、模型路由或后台代码相同。本项目把“一模一样”定义为：对同一冻结任务和输入，用户能够观察到的产品契约在以下五个维度达到等价。

1. **结果质量**：任务 oracle、约束、文件内容、交互结果和引用真实性不低于 Arena；不能用 Final 自述代替产物或工具证据。
2. **执行行为**：消息、Thought/progress、当前活跃工具类型与状态、结构化 HITL、context compaction、失败恢复、超长响应续写、Artifact、Connection、Voice/Audio、Process、Website 和 Final 的有序轨迹等价。
3. **生命周期**：ask-user submit/dismiss、plan revise/accept/reject、voice/image candidate select、Stop、timeout、Continue、刷新补放、服务恢复、运行中二次提交/admission、Approve/Deny、Restart 和历史返回的状态迁移满足相同硬约束。
4. **效率与成本**：端到端时延、模型调用、工具调用、token 和可见/估算成本在同题 Arena-reference/Anera-candidate 配对基线上处于冻结预算内。
5. **呈现形态**：桌面三栏布局、卡片类型、文案、展开行为、终态和交互路径通过单独的 DOM/截图/人工盲评；canonical trace 不用文本分数冒充像素级视觉评测。移动端不在当前范围内。

这是一组 observable-contract 要求，不是“内部实现猜得像”。Arena 没有显示的数据保持缺失，不通过推断补齐。

## 2. Canonical JSONL

每个文件依次包含：

1. 一条 `recordType=trace`：来源、run、task、模型、起止时间、side 和事件数；
2. 若干 `recordType=event`：逐事件 actor/kind/action/phase/status，以及 turn/episode/step/call、工具、Artifact、Process、Website、Deployment、Approval、usage 和证据；
3. 一条 `recordType=outcome`：单线程 `global` 终态、Final、最终 Artifact 路径和总用量。Schema 仍可读取历史/外部多侧 trace 的 `sideOutcomes`，但它不是当前 Agent Mode 采集协议。

Anera session 可直接下载：

```text
GET /api/sessions/:id/canonical.jsonl
GET /api/sessions/:id/canonical.jsonl?task_id=W01
```

也可以从 append-only 原始事件、完整 snapshot、canonical 文件或 Arena 手工 Markdown 转换：

```bash
npm run trace:normalize -- --input .anera/sessions/<session-id>/events.jsonl --output anera.jsonl
npm run trace:normalize -- --input arena_manual_runs/W01/<run-id>/normalized/events.md --output arena.jsonl
```

Arena 文件 importer 会在 run 根目录自动读取 `metadata.yaml` 和 `body_ref`；用量、模型、`global` 终态和 Final 因而不会被事件表的空列覆盖。只有 `events.md` 时仍可转换，但不可见用量保持缺失。

## 3. 确定性规范化规则

- trace 内随机 session/turn/episode/step/call/Artifact/Process/Deployment/Approval ID 改为稳定顺序 ID；
- 绝对 ISO 时间保留作证据，但不用于事件相等性；相对时延单独比较；
- localhost 动态端口、UUID 和 session ID 替换为稳定占位符；
- browser element refs、process ID 等运行时句柄只比较“存在和操作”，不比较随机值；
- Thought/final 的 transport delta 和 Shell output chunk 不作为独立 UI 事件，比较 appeared/started/finalized 等可见边界；
- 并行 tool calls 的开始顺序与完成顺序分别保留；
- 大于 4,000 bytes 的源码/结果改为字节数、SHA-256 和有界 preview，不让正文长度支配轨迹分数；
- Arena 的 `not_visible`、`not_captured`、`unknown`、`not_applicable` 保持为四种不同值。任一侧缺少可比较证据时，该字段不计分，也不假定相等。
- Final 后的两个反馈 contract 分开规范化。`check_in` 作为 `task_review_required`，其“是/否/继续工作/Close/Esc”分别成为 `upvote`、`downvote`、`continue_working`、`task_review_dismissed`；`task_completion_bar` 作为独立 `task_completion_bar_required`，其 No/Making progress/Yes 分别成为 `task_completion_no`、`task_completion_making_progress`、`task_completion_yes`。所有操作绑定目标 Final；不能在两个 contract 间换算或合并。旧 trace 中的 `feedback_cleared` 仅作为兼容值保留。
- `ask_user`、`propose_plan`、`add_voice` 和图片候选的 request/response 规范化为任务内 HITL，并以 tool call id 关联；结构化回答恢复原 episode，不因 operator response 自动创建新 turn。普通 Composer 回答仍创建新 turn/episode，二者不得压平。
- `compact` 规范化为 server-forced lifecycle 事件，保留 summary、tokens/ratio/usage 的可见字段及前后相邻事件；压力任务未见可见触发写 `trigger_opportunity_not_observed`，不反推后台没有发生压缩。
- Anera 的 `durationMs` 是各 episode 处于 running/cancelling 的活跃时间之和，排除 Approval 与轮次间用户等待；`cachedTokens` 来自持久化的 DeepSeek cache-hit token，不用总 input token 或价格反推。

## 4. 单 run diff

```bash
npm run trace:diff -- \
  --reference arena.jsonl \
  --candidate anera.jsonl \
  --json reports/W01.json \
  --markdown reports/W01.md
```

当前 Agent Mode 的 reference/candidate 都使用默认 `global` side，无需 side 参数。`--reference-side`/`--candidate-side` 仅供已有的历史或外部多侧 trace 显式选择：

```bash
npm run trace:diff -- \
  --reference arena.jsonl --reference-side left \
  --candidate anera.jsonl --candidate-side global
```

diff 使用动态规划做全局序列对齐，不按数组下标硬比。插入一个 Thought、少一个状态或并行完成顺序变化只影响相关局部，不会让后续事件整体错位。

Behavior fidelity 的冻结权重为：

| 组件 | 权重 | 比较内容 |
|---|---:|---|
| Sequence | 28% | actor、kind、action、phase、status、side 和相对顺序 |
| Tools | 24% | 工具类别/子操作、终态、可见参数和结果 |
| States | 18% | lifecycle、approval、process、website、deployment、error、人工动作 |
| Artifacts | 12% | 最终路径集合和可见文件事件 |
| Final | 12% | 规范化词/中日韩字符 bigram 的语义表面相似度 |
| Outcome | 6% | 最终执行终态 |

缺证据的组件从分母移除，并在报告中列为 unavailable。Efficiency fidelity 对 `durationMs/modelCalls/toolCalls/totalTokens/estimatedCostUsd` 计算对称比率 `min(candidate/reference, reference/candidate)`；没有双方数字时不生成效率分。双方都有证据时，Overall 为 `80% behavior + 20% efficiency`，否则等于 behavior。Final similarity 只表示回答表面接近，不是任务正确性评分。

## 5. 冻结的 parity baseline v2

在 65 个不同能力探针各执行一次、且不估计 Arena 随机性的前提下，候选版本只有同时满足下列条件才可标记为 `observable parity v2`：

正式 v2 批次使用 `anera-eval-suite/2.0`；旧 `anera-eval-suite/1.0 + observable-parity-v1` 只保留为历史/诊断兼容。下面是字段结构节选，真实 manifest 必须列全 65 个冻结 task ID、AF01–AF16、H01–H57 和 active 19 tools，不能用省略项代替：

```json
{
  "schemaVersion": "anera-eval-suite/2.0",
  "baselineVersion": "observable-parity-v2",
  "expectedTaskCount": 65,
  "visualScope": "desktop",
  "visualBaselinePassed": true,
  "visualEvidence": {
    "report": "visual/desktop-parity-v2.json",
    "reportId": "desktop-parity-v2",
    "reportSha256": "1111111111111111111111111111111111111111111111111111111111111111"
  },
  "coverage": {
    "rows": [
      {
        "dimension": "af",
        "id": "AF01",
        "taskId": "I01",
        "runId": "arena-I01-v2",
        "status": "observed_succeeded",
        "evidenceSha256": "2222222222222222222222222222222222222222222222222222222222222222"
      }
    ],
    "unmapped": []
  },
  "runs": [
    {
      "taskId": "W01",
      "reference": "traces/W01-arena.jsonl",
      "candidate": "traces/W01-anera.jsonl",
      "referenceSha256": "3333333333333333333333333333333333333333333333333333333333333333",
      "candidateSha256": "4444444444444444444444444444444444444444444444444444444444444444",
      "captureQuality": "complete",
      "unmappedCount": 0,
      "quality": {
        "assessmentId": "W01-quality-v2",
        "assessmentSha256": "6666666666666666666666666666666666666666666666666666666666666666",
        "referenceTaskResult": "pass",
        "candidateTaskResult": "pass",
        "candidateOraclePass": true,
        "candidateConstraintViolations": [],
        "criticalViolations": []
      },
      "pairing": {
        "reference": {
          "taskVersion": "2.0",
          "taskSpecSha256": "7777777777777777777777777777777777777777777777777777777777777777",
          "rawEvidenceArtifact": "evidence/W01-arena.json",
          "rawEvidenceSha256": "5555555555555555555555555555555555555555555555555555555555555555",
          "inputVariantId": "none",
          "operatorVariantId": "standard",
          "promptSha256": "8888888888888888888888888888888888888888888888888888888888888888",
          "inputFiles": [],
          "operatorActions": [{ "turnId": "T01", "action": "message_submit", "payloadSha256": "9999999999999999999999999999999999999999999999999999999999999999" }],
          "viewport": { "widthPx": 1440, "heightPx": 900, "zoomPercent": 100 }
        },
        "candidate": {
          "taskVersion": "2.0",
          "taskSpecSha256": "7777777777777777777777777777777777777777777777777777777777777777",
          "rawEvidenceArtifact": "evidence/W01-anera.json",
          "rawEvidenceSha256": "6666666666666666666666666666666666666666666666666666666666666666",
          "inputVariantId": "none",
          "operatorVariantId": "standard",
          "promptSha256": "8888888888888888888888888888888888888888888888888888888888888888",
          "inputFiles": [],
          "operatorActions": [{ "turnId": "T01", "action": "message_submit", "payloadSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
          "viewport": { "widthPx": 1440, "heightPx": 900, "zoomPercent": 100 }
        }
      }
    }
  ]
}
```

上例仅说明字段形状；真实 manifest 必须列全冻结集合，并使用实际文件 SHA，示例占位 hash 不能运行。附件项使用 `{logicalId,bytes,sha256,mimeType}` 并保持上传顺序；operator action 使用 `{turnId,action,payloadSha256}` 并保持执行顺序。`payloadSha256` 是规范化 action payload 的 SHA-256，空 payload 也必须显式哈希。v2 evaluator 会逐题要求 reference/candidate 的 task version、冻结 task-section/prompt hash、附件序列、operator-action 序列、raw-evidence 路径/hash 及 `1440×900@100%` viewport 一致；canonical trace 还必须满足 source/task/schema/event identity、全局 outcome、path/trace ID/content 唯一性和双方不可复用。H48/H56 只能由 K01 的 `observed_succeeded|observed_attempted` 结构行关闭，K02 或 blocked/failed/unobserved 状态不能替代。

这些是**结构一致性门禁**，不是来源真实性证明。当前 CLI 会 `realpath` 并读取实际 trace/raw/visual 文件后计算 SHA，但 raw evidence 的语义、inline quality/coverage 的推导过程，以及 visual report 顶层 `passed` 背后的完整判定链仍由证据生产方提供；恶意采集者仍能制造一套自洽字节。为避免把这种自洽误报成 parity，`v2_semantic_provenance` release gate 当前固定为 FAIL，所有 v2 分数只作诊断。只有 structured run bundles、可定位 evidence refs、独立 oracle/coverage 推导、重新计算的 DOM/PNG/interaction gates、可信采集签名或受信人工复核与不可变存储落地后，才允许开放正式 PASS。

```bash
npm run trace:suite -- \
  --manifest eval-suite.json \
  --json reports/suite.json \
  --markdown reports/suite.md \
  --runs-dir reports/runs
```

CLI 对未满足 release gate 的批次返回非零退出码。当前 `v2_semantic_provenance` 必然失败，因此 v2 命令只会生成诊断报告并以非零退出，不能用于发布 parity 声明。`--runs-dir` 同时保存每题完整 alignment JSON 与 Markdown，suite 报告只保留可审计的摘要。

### 硬门槛

- 65 个 canonical Arena run 均达到手册定义的 capture quality，AF01–AF16、H01–H57 与当前活跃 19 工具机会矩阵闭合，`UNMAPPED-* = 0`；K01 的专用合成 GitHub Connection 前置条件必须实际满足，不能用未连接状态代替认证仓库读取；
- manifest 必须是 `anera-eval-suite/2.0 + observable-parity-v2`，`expectedTaskCount` 固定为 65，并包含精确的 65 个 task ID；schema/baseline 交叉配对、用较小 task count 覆盖正式门槛或用任意 65 个 ID 替代冻结集合都会在结构校验阶段 fail closed；
- structured evidence、独立质量/coverage 推导、可重算视觉结果和可信采集 provenance 未实现前，`v2_semantic_provenance` 保持 FAIL；任何 trace 分数、quality 自报或 visual `passed:true` 都不能覆盖它；
- 每题的任务 oracle 和约束单独评分，Anera 不得把 Arena 的 pass 降为 partial/fail；
- 安全、审批、取消传播、timeout、恢复、工作区边界和 Artifact 真实性不得有关键违例；
- HITL/plan/voice/compaction/process/lifecycle/admission/connection/approval 的必需状态和人工动作不得缺失或伪造；
- UI 的必需面板、控件和终态另经截图/DOM 基线确认，不能只凭 trace 分数放行。

### 软等价阈值

- behavior fidelity 宏平均 `>= 0.90`，任何单题不得低于 `0.75`；
- 有证据的 Tools 与 States 组件宏平均均 `>= 0.90`；
- 全批次 duration、model calls、tool calls、tokens、cost 的 candidate/reference 中位数分别 `<= 1.25/1.20/1.20/1.20/1.20`；
- 上述五项同题 candidate/reference ratio 的 p90 均 `<= 1.50`，并同时报告更快/更便宜的方向，不能只报平均分隐藏长尾；
- 结果质量、行为、生命周期、效率成本、视觉呈现五条 baseline 分别出报告，禁止用一个 overall 分数抵消硬失败。

这些阈值是工程 release baseline，不是假装统计同分布。Arena 数据到达后可以版本化调整，但不能在看见 Anera 分数后无版本记录地移动门槛。

## 6. 视觉 contract 与像素基线

视觉不能由 canonical 文本轨迹代替。当前实现把它拆成三个互不抵消的证据层：

1. **运行时健康**：确定性 fixture 捕获过程中 console error/warning、page error、request failure（预期 SSE 关闭除外）和水平溢出必须为 0。
2. **DOM/UI contract**：比较命名状态、viewport、三栏 landmark 几何、组件数量、可见控件身份、主题/landmark 样式和 overflow。默认硬门槛为 overall `>= 0.98`、每个状态 `>= 0.95` 且无缺失状态；CLI 失败返回非零。
3. **PNG 像素差异**：尺寸必须完全一致；默认单像素变化阈值 `0.10`，changed ratio `<= 0.01`，MAE `<= 0.02`。同时输出 changed pixels、MAE、RMSE、pixel similarity、dimension penalty 和可选 diff PNG。

确定性 Anera fixture 覆盖无 Session 的 `/agent` New Chat draft、Empty、Running、Completed、Website Asleep、Task Review、Task Completion Bar、Undo、Awaiting Approval、Timed out、Session token limit、Credits、free session、GitHub Coding、durable `/history/search` Conversation Search 与 Agent Leaderboard Ranking/Pareto surface，并捕获 59 个桌面状态：在 draft hydration/reload/New Chat 零 Session 副作用、running Thought 与同会话 SSE 推进后的 Plan + expanded running Shell/partial output，以及 completed desktop top/expanded/bottom/preview、review、approval、timeout/token-limit、Composer ingress、Connections/Coding、Credits、`/history/search` 与 Agent Leaderboard Ranking/Pareto 状态之外，包含 Website Raw source/Switch file/element picker、Asleep/disabled Open/enabled Restart/stopped Process、原生 Markdown/DOCX/XLSX/PPTX Artifact viewer、task-completion desktop、thank-you `in/out`、Undo offer/inflight，以及 Workspace 文件页内 Preview、A02 保存后 Review、A01 Review 与 scanning/uploading/saving 同屏及完成态 reload。Running 状态冻结 history live dot、锁定 Composer 和 Stop；Completed 状态包含 Thought、context checkpoint、成功/失败工具、Artifact、approved/denied approval、Final completed/Copy、Process、Website、Deployment、Files 和 Preview；独立 session/ledger 分别提供 `check_in` Review 与 `task_completion_bar`，后者冻结“最新 Assistant response 进入视野后才出现”、桌面结构、No/Making progress/Yes 顺序、Composer 共存、成功后刷新隐藏、失败 optimistic rollback、默认 arm 的 2000ms+200ms 感谢动画和 `treatment-2` 抑制。`check_in` 的 No 另冻结 optimistic Undo、精确 action body、draft/attachment 回滚、compaction gate、exactly-once durable event 和刷新持久化。两种反馈 variant 不互相替代或换算。v19 还要求当前 Bash 在采集脚本零预点击时自动展开、Workspace 文件打开 docked Preview，并同时接受 A01 Review+Updating 与 A02 Saved→Review；EventSource 从 snapshot high-water 续订、刷新不重播旧保存动画，并冻结 Website 必须显式打开 Preview、Preview/Workspace 互斥及关闭后的条件恢复。

```bash
npm run visual:capture -- --output reports/ui-candidate

npm run visual:contract-diff -- \
  --reference reports/ui-reference/ui-contract.json \
  --candidate reports/ui-candidate/ui-contract.json \
  --json reports/ui-contract.json \
  --markdown reports/ui-contract.md

npm run visual:diff -- \
  --reference reports/ui-reference/screenshots/completed-desktop-top.png \
  --candidate reports/ui-candidate/screenshots/completed-desktop-top.png \
  --diff reports/ui-pixel-diff.png \
  --json reports/ui-pixel.json \
  --markdown reports/ui-pixel.md
```

`visual:capture` 目前用于 Anera 的确定性回归；真实 Arena reference 必须由相同 viewport/zoom/font/environment 下的正常 UI 采集生成，不能拿不同任务正文的截图直接宣称布局不等价。只有所有冻结状态的 runtime、DOM、pixel 与人工交互检查分别通过，suite manifest 的 `visualBaselinePassed` 才能设为 `true`。 当前范围固定为 `visualScope: "desktop"`；移动端不进入 parity 或 release gate。

## 7. 当前证据与未覆盖部分

与 parity suite 分离的最新完整 18 题 Anera 内部能力证据为 `reports/quality-benchmarks/harness-quality-2026-08-31T22-45-02-834Z.json`（schema `anera-harness-quality/2.0`）：单一统一批次 18/18 desktop-only 自然/对抗任务通过、平均质量 100，critical 与 efficiency 全通过，115 physical model requests、115 metered model calls、118 tools，`failedToolCalls:0`；五个 trajectory-blind Judge 均为 10/10。schema-v3 implementation fingerprint 绑定 verifier、源码入口和完整 production runtime 共 52 个文件，公开摘要及当前字节由证据完整性脚本复核。该基线明确写入 `arenaParityEvidence:false` 与 `mobileExcluded:true`；它证明候选 Harness 在冻结任务上的完成能力，既不填充 65 题 manifest 的 Arena reference，也不能把 `visualBaselinePassed` 或 observable parity 状态改为 true。

生产研究链新增的 `model.final.repair` 与既有 `model.tool_call.repair`、`provider.usage` 一样属于 Anera 内部质量/计量事件，normalizer 明确排除，不能污染 Arena observable event alignment。研究意图与 source ledger 独立判定：零成功检索的 research Final 和 `present_file` 都 fail closed；任意 mutation 不再跳过 Final gate；只有同任务真正成功的 `present_file` 才能让交付型短 Final 不重复 URL，`verification_required`/`notExecuted` 不算成功。确定性回归证明零 ledger Final 会先检索再只发布 grounded Final，零 ledger Artifact 会在首次发布被阻止后检索、定向编辑并恰好真实发布一次；旧 `reports/real-smokes/active-research-2026-08-30T10-05-17.356Z.json` 只证明无需纠正的正常 provider 路径仍保持 canonical `search×1/fetch×2`。

录屏原提示另由 fingerprinted production-bundle canary `reports/real-smokes/html-slides-2026-08-31T02-44-11-012Z/report.json` 闭环：全部检查为 true，10 model / 10 tool、78.112 s、估算 `$0.03741436`，顺序为 research → canonical HTML → Website → Browser navigation → screenshot → Vision `NO DEFECTS` → `present_file` → 唯一 Final；实现聚合 SHA-256 为 `c365467091719ed50ebaa908fde8dc10e44aa2976a91a4540a4f164c063109f8`。该 run 是 Anera 能力证据，不进入 Arena canonical 对齐或 parity 分数。

已用一个真实的 59-event Anera 浏览器任务验证 canonical 落盘、重载和 self-diff：20 个工具状态事件、12 个生命周期/产品状态事件以及 duration/model calls/tool calls/tokens/cost 均为 100% 自一致。fixture 还覆盖插入/删除、工具状态不匹配、可选多侧兼容、缺失 usage、Arena Markdown importer，以及 `task_review_required`、upvote/downvote、`continue_working`、`task_review_dismissed`、`task_completion_bar_required`、`task_completion_no`、`task_completion_making_progress`、`task_completion_yes` 与 legacy `feedback_cleared`。Task Completion API 的并发 first-write 测试要求竞争请求只能形成一条 durable operator action。`context.compacted/context.compaction.failed` 的 canonical payload 另保留 `reason=threshold|context_overflow` 与 `forced`，可区分主动阈值 checkpoint 和 provider overflow 恢复，不能把二者的额外调用/时延混算为同一策略。

当前权威桌面回归是 `reports/ui-execution-log-v23/capture-summary.json`：61 个 `1440×900` 状态、0 console error、0 horizontal/outer-shell vertical overflow、`passed:true`，8/8 conversation-follow 检查与 persistence/ownership/HITL 门禁全部通过，并冻结运行态 Thought、完成态无残留 `Thinking...`、HTML 内联/docked Preview 以及 Anera logo 在左栏、Leaderboard 和 favicon 的 production asset 投影。下面提到的 `ui-desktop-only-v12` 只记录较早的几何/完成态校准里程碑，不再是“当前”证据。v23 仍是 Anera 回归，不是同任务 Arena DOM/PNG parity。

确定性视觉 fixture 已捕获 61 个桌面状态，固定 viewport 为 1440×900，并覆盖无 Session 的 `/agent` draft、running Thought、history live dot、Stop/locked Composer、同 Session SSE 推进后的 Plan + expanded running Shell/partial output，以及 completed desktop top/expanded/bottom/preview、review、approval、timeout/token-limit、Composer ingress、Connections/Coding、Credits、`/history/search` 与 Agent Leaderboard Ranking/Pareto 状态之外，包含 Website Raw source/Switch file/element picker、Asleep/disabled Open/enabled Restart/stopped Process、原生 Markdown/DOCX/XLSX/PPTX Artifact viewer、task-completion desktop、thank-you `in/out`、Undo offer/inflight，以及 Workspace 文件 docked Preview、A01/A02 双 persistence 时序和完成态 reload。历史 `reports/ui-desktop-only-v12/` 里程碑 为 0 console error、0 horizontal overflow、0 outer-shell vertical overflow，50-state desktop gate PASS，并额外冻结 `/agent` hydration/reload/New Chat 无 Session 副作用、真实 Arena 校准的 248 px Workspace、53 px header、12 px card offset、15 px 全局 toggle inset 与紧凑 Website/Processes/Files 结构。v12 另依据 `reports/arena-live-completed-desktop-2026-08-30.md` 冻结完成态的紧凑无边框 Thought/tool rows、`Write + filename + line count`、短 Artifact 类型行、Bash 成败/exit/duration、微型完成标记/icon-only Copy 和约 138 px Composer。浏览器门禁在既有 Composer/Connections/Coding/IME/paste/发送契约之外，实际点击 sandbox iframe 的 `h1` 并验证 file/selector/text 引用、picker 自动退出及 hidden-Composer draft 保留，保存 5 个 Review、3 个 Task Completion 和完整 Undo 成功/失败/compaction 分支；Review 逐项保存 shared endpoint 和 `approve|disapprove|edit|escape` request action，两种 variant 均要求失败 optimistic rollback 恢复且零事件。Undo 另验证 `{type:"undo",sessionNodeId,recaptchaV3Token:null}`、目标 turn 立即隐藏、原 prompt 恢复、attachment 清空、失败完整回滚、成功 exactly-once 与刷新持久化；公开证据不证明 Workspace rollback，因此 canonical 明示 `workspaceReverted:false`。所有成功 feedback action 均 Final-correlated、零新 episode、completed 状态不变且刷新持久隐藏。Canonical normalizer 将 Arena/current `install_npm_packages`、`build_project`、`build_and_start`、`deploy_project` 稳定映射为 `package_install`、`build`、`website_start`、`deploy`，将 `bash` 与 `shell_command` 统一映射为 `shell`，将 legacy/current `search_web`/`web_search` 统一映射为 `search`、`web_fetch` 映射为 `fetch`、`fetch_media` 映射为 `media_fetch`、`generate_image` 映射为 `image_generate`，并把 `turn.undone` 映射为 `operator_action/undo_last_turn`；Website `asleep` 作为独立 canonical lifecycle status 保留，不与真正 `failed` 合并；deployment、task review、task completion 和 Undo 已作为隔离的 states/operator-action 证据。生产回归 `reports/real-smokes/office-present-file-ses_ca0746508d9d4e9da4d9.json` 证明真实 DeepSeek Office viewer 链路；`reports/real-smokes/github-agent-connector-ses_ce9dc420a7694b0cbd93.json` 证明签名 GitHub App installation-token exchange、动态 connector schema、私有 fixture 文件的 repository/commit/blob 归因和完成态 UI；`reports/real-smokes/website-idle-sleep-ses_dbb1c55457454bbb941e.json` 另证明 `running→asleep→Restart→running→asleep`、两个 Process ID、Canonical 与零 Console error，并证明 asleep Website 和历史 image Artifact 都不会向无关新任务泄漏 `browser/inspect_image` schema；它们仍是 Anera 自证，不是 Arena reference。真实 Arena reference 必须按本节协议另行采集。DOM/PNG 工具均已用结构、控件、主题和像素变化验证失败定位与非零退出门槛。

当前只读 intake 已从未随仓库发布的 `arena_manual_runs/` 源目录清点 43 个 task 目录和 50 个 run 目录，并获得 9 个历史协议版本（task version 1.1/1.6/1.7/1.8）的结构化 Arena reference、231 个 canonical 事件，详见 `reports/arena-reference-corpus-2026-08-30/`。确定性生成器从 `events.md + metadata.yaml + body refs + artifacts.csv` 重建 curated canonical，修正 Agent 终态 duration、A01/A02 Review 类型并按唯一 artifact ID 融合 path/bytes/SHA；旧的 7 个 source canonical 仅保留为历史输入，不再宣称与增强后的 curated 输出逐字节一致。8 个 capture 为 complete，A02 为 complete-with-declared-gaps。它们覆盖 17/57 个 H 维度，但仍有 4 个 `UNMAPPED-001`、34 个 raw-only 任务和 22 个完全缺失任务。当前任务协议为 v2.0，这 9 条均不具备 current-version paired eligibility；也没有 exact-version Anera candidate、可见 Arena model calls/tokens/cost 或同 viewport DOM/PNG baseline。因此不能生成正式 parity/效率/视觉分数，65 题 manifest 和 `visualBaselinePassed` 必须保持未关闭。

这些历史 run 可以冻结经验契约，但不能升级为正式 parity 结论：

| Arena evidence | 可观察事实 | Anera 当前候选契约 | 评测含义 |
|---|---|---|---|
| A01 | Final 与 Review 出现时仍可见 `Workspace Updating`；约 700 ms 后 Workspace 才终态 | Review 与 Workspace persistence 分别投影 | 不得设置“Review 必须晚于 `Workspace saved`”的通用 gate；两者可同屏，精确交错只由 exact-version paired trace 评分 |
| A02、U03 | Bash 非零 `exit 127` 的 tool terminal 为 failed，后续 Bash 可恢复；展开体按 `COMMAND`、`STDOUT`、`STDERR` 分区 | 非零 exit 令 tool failed，同时保留 process payload 的 `status:"completed"`、`exit_code`、duration 和已有输出；桌面分栏展示 | canonical 必须同时保留进程完成事实与工具失败事实，不能只看 payload `status` 或 Final 自述 |
| A03 | `ask_user` 产生问题卡、选项、Skip、自定义输入和 Submit；run 进入 awaiting-user，回答后继续同一 conversation/execution episode | `hitl.required` + `run.status=awaiting_user`；response 绑定原 turn/step/call 并恢复原 batch | 结构化 HITL response 不自动创建新 turn/episode；等待时间不计入 active duration |
| U02 | Website/Process 可见用户名称、启动命令、process ID、OS PID 与端口；Restart 后重新稳定 | Website 引用 ownership-verified Process/port；Processes 保留 name/command/managed ID/PID/port/status | 端口 hint、其他 Session listener 或宿主 listener 不能充当可见 ownership 证据 |
| U02 | 官方保存态为 34.2KB / 6 files，35,714 B Workspace ZIP 恰好六个源码成员；`dist`、`node_modules` 明确排除 | 共享 snapshot policy 同时约束 Workspace tree、Shell reconciliation、Artifact、终态 bytes/file count、搜索/列表 traversal 与 ZIP；generated/cache/dependency 目录和 credential suffix 仍留在物理运行时 | 评测保存/下载投影时不得把构建产物或依赖树计入；也不得据此推断运行时已删除这些目录 |
| U03 | history return 与两次 refresh 恢复 trace、Final、Workspace、Review 和 Review 关闭状态；先前 Website 行未恢复 | snapshot 全量事件归约后展示，旧 seq 不覆盖新状态，SSE 从 hydrated high-water 续订 | 只重放有事件/状态证据的 projection；不得因历史 Process 卡仍在就合成 live Website |
| A02、A03 | Workspace 可见 `Scanning → Uploading N blobs → Saving → saved` 生命周期 | 成功终态发布同名 durable boundaries；当前 `persistenceMode:"local_durable"`，真实扫描 bytes/file count，`blobCount:0` | Anera 尚无 immutable remote CAS；`0 blobs` 是实现边界，不得改写成已上传 immutable blobs，也不能由文案反推 Arena 私有存储实现 |

上述 Anera 合同由本地 reducer/Store/normalizer/桌面门禁验证，仍只是 candidate self-evidence。特别是当前 Anera 成功终态使用一个稳定的本地事件序列，这不改变 A01 已证明的 Arena 允许 Review 与 Workspace Updating 共存；正式 evaluator 不应把本地序列硬编码成 Arena 的唯一合法序列。

## 8. 重新开放 semantic provenance gate 的实现清单

1. **RunEvidenceBundle/2.0**：每侧 bundle 固定 `taskId/taskVersion/taskSpecSha/source/traceId/canonicalSha/captureId/runId`；保存 exact prompt turns、input inventory、operator actions、viewport、capture gaps、artifact inventory 和 capability observations。每个事实必须带可解析 `evidenceRef`，指向 canonical event seq、JSON pointer、DOM selector、截图区域或录屏 timecode。
2. **由 verifier 派生而非 manifest 自报**：CLI 从 exact prompt 文本重算 prompt protocol SHA，实际读取输入文件核对 bytes/hash/MIME，从 canonical/operator ledger 重建动作顺序，从 observation records 派生 AF/H/tool coverage 与 unmapped；`observed_*`、failed、not-visible 都必须有 locator。H48 要求 K01 三个冻结文件的成功读取和 repository/commit/path oracle，不能只凭 `observed_attempted`。
3. **独立质量 sidecar**：assessment 绑定 task/source/trace/bundle/canonical SHA，列出 assessor/oracle version、mandatory checks、expected/actual/evidence refs、constraints 与 critical checks；evaluator 从 checks 推导 task result、oracle pass 和 violations，assessment SHA 是 sidecar 自身 canonical JSON 的 SHA。
4. **视觉重新计算**：visual manifest 固定 build/config/runner、精确 state/interaction ID 集合，以及每态 Arena/Anera DOM/PNG 路径、SHA、尺寸和 diff 参数。release verifier 自己重算 DOM score、pixel changed ratio/MAE、console/network/overflow 与 interaction aggregates，不接受裸 `passed:true`。
5. **信任根与可追溯性**：Arena 侧由受控采集器或受信人工流程生成并进入 append-only 存储；Anera 侧绑定准确 build commit，由隔离 CI runner 采集，oracle/visual runner 与被测 Agent 分权。报告公开 evaluator version、manifest/bundle/trace/assessment/visual SHA、runner identity 和 `provenanceLevel`。Arena 没有官方签名接口时只能声明“受信人工采集”，不能声称密码学来源认证。
