# Anera Production Canary Runbook

本手册只关闭 Anera Harness 的真实 provider、账户和主机边界，不评价 Arena parity。移动端不在实现、测试或 release gate 范围内。GitHub Connector 深化与真实账户覆盖按当前范围暂缓，以下 GitHub gate 作为未来生产关闭条件保留，不阻塞本轮普通 Agent Mode 主体封板。

## 当前状态

内部 Harness 与质量 gate 已通过；下面四个外部 gate 的执行器已经实现，但当前机器缺少对应账户配置，且不是 Linux，因此不能把它们标成通过：

| Gate | 命令 | 当前证据 | 当前结论 |
|---|---|---|---|
| Pexels + 图片 + 语音 + 账单 | `npm run canary:media-providers` | `reports/production-canaries/media-providers-2026-08-29T15-52-42.835Z.json` | `blocked_configuration` |
| GitHub App + 私库 | `npm run canary:github-private` | `reports/production-canaries/github-private-repository-2026-08-29T15-56-59.887Z.json` | `blocked_configuration` |
| GitHub 专用私库 writeback | `npm run canary:github-writeback` | `reports/production-canaries/github-writeback-2026-08-30T14-44-59.152Z.json` | `blocked_configuration` |
| Linux + Bubblewrap | `npm run canary:linux-bubblewrap` | `reports/production-canaries/linux-bubblewrap-2026-08-29T15-56-59.897Z.json` | `blocked_host`（当前为 macOS） |

所有入口都先使用 production bundle，禁止注入 `fetch`、fixture origin 或合成 provider 响应。报告只记录凭据是否存在，不记录凭据内容。

`npm run canary:web-research-providers` 的执行器已升级到 schema 1.2：除原有 Tavily Web Search 与 Firecrawl cache/跨 turn 边界外，它会显式绕过 Pexels，验证 active `image_search` 的 Tavily `include_images` 回退、真实图片下载、公网 URL 准入、Workspace 字节签名和独立 provider usage。旧 schema 1.1 live 报告不包含这条图片路径，不能冒充新实现的真实 canary。当前本机的 Tavily/Firecrawl 凭据曾在内部诊断输出中暴露，轮换前不运行 schema 1.2；确定性 fixture 已通过，但不等于真实 provider 通过。

## 1. 真实媒体 provider

配置 `.env` 中已有的生产变量：

```text
PEXELS_API_KEY=...
ANERA_IMAGE_API_KEY=...
ANERA_IMAGE_BASE_URL=https://api.openai.com/v1
ANERA_IMAGE_MODEL=gpt-image-1
ANERA_SPEECH_MODEL=gpt-4o-mini-tts
```

也可用 `OPENAI_API_KEY` 代替 `ANERA_IMAGE_API_KEY`。运行：

```bash
npm run canary:media-providers
```

一次运行必须依次证明：

- Pexels `both` 搜索同时返回带署名的图片和视频；
- `image_search` 从 Pexels 下载真实图片并验证物理字节、PNG/JPEG 签名、尺寸和 SHA-256；
- 图片生成返回 provider usage，真实图片进入 Workspace，并记录模型、token、价格、费用和时延；
- `add_voice` 实际调用 provider 两次，两个试听文件都有可解析容器和实测时长；
- `generate_speech` 实际调用一次，落盘字节与 speech metering 完全一致；
- provider origin 必须是公开 HTTPS，localhost 和 `.test/.invalid/.example` 等 fixture origin 会失败。

首次成功执行在尚无供应商账单时会得到 `provider_checks_passed_billing_pending` 和退出码 3。这是有意的：provider 执行通过不等于费用已对账。取得与该次运行对应的供应商账单金额后，对原报告离线对账；此命令不会再次调用 provider：

```bash
ANERA_MEDIA_CANARY_ACTUAL_BILLED_USD=0.00 \
  npm run canary:media-reconcile -- reports/production-canaries/media-providers-<timestamp>.json
```

默认允许绝对差 `$0.02`；可用 `ANERA_MEDIA_CANARY_BILLING_TOLERANCE_USD` 收紧。对账报告保存源报告 SHA-256，只有 `releaseGatePassed:true` 才关闭费用 gate。若需要供应商错误率和稳定时延分位数，应在不同时间至少运行 5 次并从各报告同名 check 的 `status`/`latencyMs` 计算；单次时延不能冒充 p50/p95。

## 2. 真实 GitHub App 私库

先创建或选择一个 GitHub App installation，并让它只访问专用私有 canary repository。在私库中选择一个稳定的小型 UTF-8 文件，预先计算其 SHA-256。除现有 App 配置外，本次 shell 需要：

```text
ANERA_GITHUB_CANARY_INSTALLATION_ID=<positive integer>
ANERA_GITHUB_CANARY_REPOSITORY=owner/name
ANERA_GITHUB_CANARY_PATH=README.md
ANERA_GITHUB_CANARY_REF=main
ANERA_GITHUB_CANARY_EXPECTED_SHA256=<64 lowercase hex characters>
```

运行：

```bash
npm run canary:github-private
```

该 gate 只接受真实 `https://api.github.com` 和 `https://github.com`。它必须完成 App JWT→installation token exchange，通过 installation-token 专用的 `/installation/repositories` 找到目标私库，读取 branch head 和指定文件，匹配内容 SHA-256，并验证 durable connection record 权限为 `0600`、只保存 installation ID、从不保存短期 token。报告只保存文件 hash/字节数/commit/blob attribution，不保存私有文件正文。 该脚本当前是只读账户/私库 gate，不会创建分支、push 或 PR，因此不能关闭 Coding writeback gate。

`reports/real-smokes/github-agent-connector-ses_bb5dd0d56bc443d398f7.json` 已用真实 DeepSeek 和注入 GitHub API fixture 证明完整 Agent/UI 路径，并在修复后明确调用 `/installation/repositories`；它不是本 gate 的真实账户证据。本地 26 项 GitHub 专项测试与 ToolExecutor 相关回归已证明：受控固定分支 push；固定 scope 的 PR create/read/merge/edit/close/reopen/comment/review、issue create/read/edit/close/reopen/comment、run list/view/watch/rerun/cancel/delete、workflow list/view/run/enable/disable、release list/view/create/edit/delete/upload；以及 durable Approval、批准前零 credential/零 command、批准后二次校验、`closed → reopen → pr_open` 的唯一远端恢复路径、`pr_merged` 永久封闭、release asset 普通文件快照、option-smuggling 防护、临时 network/auth、断连撤销、可信 `pr_merged` oracle 和 token 零泄漏。真实写入由下一节的独立、显式 opt-in canary 负责；本节的只读入口保持零远端副作用。

## 3. 真实 GitHub writeback

这是破坏性生产 canary，只能指向专门创建、随时可整库删除的私有 repository。它会在 base branch 留下一次真实 merge commit，用来证明可信 `pr_merged` oracle；脚本不会 force-push 或重写 base branch 来掩盖这个证据。不要把个人仓库、产品仓库、共享测试仓库或任何含重要数据的仓库填入这些变量。

GitHub App installation 必须只授权该专用私库，并至少具有 Contents、Pull requests、Issues、Actions 的 read/write 权限。仓库应启用 Actions、允许所选 merge method，且 branch protection 应允许该 App 在 canary PR 上完成 merge。在配置的 base branch 预置：

- 一个稳定的小型 UTF-8 marker 文件，建议 `.anera-writeback-canary`；
- 一个只用于本 canary 的 workflow，例如 `.github/workflows/anera-writeback.yml`，接受 `anera_canary_id` 的 `workflow_dispatch` input。

最小 workflow 示例：

```yaml
name: Anera Writeback Canary
on:
  workflow_dispatch:
    inputs:
      anera_canary_id:
        description: Anera canary run id
        required: true
        type: string
permissions:
  contents: read
jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - run: test -n "${{ inputs.anera_canary_id }}"
```

计算 marker 的 SHA-256 后，在执行该命令的 shell 中显式配置全部写入开关：

```text
ANERA_GITHUB_WRITEBACK_CANARY_ENABLED=true
ANERA_GITHUB_WRITEBACK_CANARY_INSTALLATION_ID=<positive integer>
ANERA_GITHUB_WRITEBACK_CANARY_REPOSITORY=owner/disposable-private-repo
ANERA_GITHUB_WRITEBACK_CANARY_CONFIRM_REPOSITORY=owner/disposable-private-repo
ANERA_GITHUB_WRITEBACK_CANARY_BASE_BRANCH=main
ANERA_GITHUB_WRITEBACK_CANARY_WORKFLOW=.github/workflows/anera-writeback.yml
ANERA_GITHUB_WRITEBACK_CANARY_WORKFLOW_INPUT=anera_canary_id
ANERA_GITHUB_WRITEBACK_CANARY_MARKER_PATH=.anera-writeback-canary
ANERA_GITHUB_WRITEBACK_CANARY_EXPECTED_MARKER_SHA256=<64 lowercase hex characters>
ANERA_GITHUB_WRITEBACK_CANARY_MERGE_METHOD=squash
```

`ENABLED`、installation ID、精确 `owner/name`、第二份逐字 repository 确认、base、专用 workflow 和 marker hash 缺少任何一项都会只生成 `blocked_configuration`，不会连接 GitHub 或执行写入。只接受真实 `https://api.github.com` 与 `https://github.com`。运行：

```bash
npm run canary:github-writeback
```

一次通过必须经 production `GitHubConnector`、`GitHubRepositoryBootstrapper`、Coding broker 和 `ToolExecutor` 完成：

- 验证 App installation、精确私库、base branch 与 marker hash；
- 创建两个真实 session-fixed `arena/...` branch，push 后用 REST oracle 匹配远端 SHA；
- 在第一条 branch 创建/read PR，执行 `close → reopen → reclose`，逐步以 Session `closed → pr_open → closed` 和远端 `CLOSED → OPEN → CLOSED` 双 oracle 验证；同时创建/read/close Issue，dispatch 专用 workflow 并按 branch + head SHA 读取 run；
- 创建 release、经单独的 `release upload` Approval 上传 0600 workspace snapshot、重新下载并匹配 bytes/SHA-256，再经 Harness 删除 release；
- 在第二条 branch 创建 PR 并真实 merge，只有固定 repo/head/base 的 GitHub 响应含 `merged_at` 且 Session 状态为 `pr_merged` 才通过；
- 无论中途成功或失败，都按唯一 title、branch、head SHA、tag 和已知 ID 重新发现部分成功资源，并 best-effort 关闭 open PR/Issue、删除 release/tag/workflow run/两条 branch。远端 identity 已漂移时拒绝误删并使 gate 失败。

外层显式 opt-in 使 canary 自动同意每个 broker Approval presentation；broker 仍会执行 Approval 前预检和批准后二次解析。durable UI 等待/恢复由现有 Agent/API 回归覆盖，本 canary 不伪装成人工点击测试。报告权限为 `0600`，只保存资源 ID、branch/commit、hash/bytes、Approval 标题与清理结果，不保存 installation token、私有 marker 正文、Issue/PR body 或 release asset 内容。

成功报告会明确标记 `retainedEffects.baseBranchContainsMergedCanaryCommit:true`。已关闭/已合并的 PR 与已关闭 Issue 作为 GitHub 审计记录保留；`cleanup.outcome:retained` 对这些终态记录不是清理失败。任何 `cleanup.outcome:failed` 都会令整个 gate 失败。

## 4. Linux + Bubblewrap 主机

在实际生产 Linux 镜像或同构主机安装 Bubblewrap，使其位于 `/usr/bin/bwrap` 或 `/bin/bwrap`，然后运行：

```bash
npm run canary:linux-bubblewrap
```

不得用平台或可执行文件 override。gate 必须在真实 Bubblewrap 子进程中证明 Workspace 写入持久化、host-home sentinel 不可读、宿主 `/etc` 不可写、foreground invocation 含 private network namespace；随后启动两个真实 managed descendant listener，以 Linux `/proc` 的 guardian identity、进程树与 socket-inode ownership 把高/低端口分别归属到正确 Process，并拒绝一个仅“报告”宿主可达 decoy port、实际并不拥有 socket 的 Process。宿主 Preview 必须分别读取两个正确 marker。managed Website 为保证 Preview 可达而使用 shared network，报告会明确写出“不声称 outbound denial”。非 Linux 主机返回 `blocked_host`；无 Bubblewrap 返回 `blocked_configuration`。

独立 `process.updated` snapshot 的持久化门槛由确定性 SessionStore/ProcessManager 回归覆盖：snapshot 提交前不得暴露 Preview port，提交失败清空内存 port/listeners，torn snapshot 重启后 authoritative clear。Windows 或其他 ownership-unknown 路径同样以确定性回归冻结为 fail-closed，不使用 `portHint` 借用同 Session、跨 Session 或宿主 decoy；它们不能替代本节真实 Linux `/proc` canary。当前仓库只有这些确定性证据与 `blocked_host` 报告，尚无真实 Linux passed 报告。

## 退出码与关闭条件

| 退出码 | 含义 |
|---|---|
| `0` | 该命令的完整 gate 通过 |
| `1` | 已执行但断言失败 |
| `2` | 缺配置、账户或适用主机 |
| `3` | 媒体 provider 执行通过，但账单对账待完成 |

表中的四个外部 gate 都有一份 `passed`/`releaseGatePassed:true` 报告，并且 schema 1.2 Web canary 真实完成 Tavily `include_images` 路径后，才可以把 Anera 自身的生产环境门禁标为关闭。当前 schema 1.1 Web 报告与 schema 1.2 fixture 都不能替代这次 live run。所有这些证据仍不提供 Arena 同题轨迹、质量、成本或像素等价证明。
