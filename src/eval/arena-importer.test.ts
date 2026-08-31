import { describe, expect, it } from 'vitest'
import { importArenaEventsMarkdown } from './arena-importer.js'

describe('Arena manual Markdown importer', () => {
  it('maps visible rows and preserves explicit missing-value semantics', () => {
    const trace = importArenaEventsMarkdown(`# Visible events — W01-20260828T120000+0800

| seq | segment | episode | parent | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility | capture_methods | supersedes | evidence | notes |
|---:|---|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | S01 | E01 | | T01 | left | R01 | 00:00:01.000 | 0 | UI-001 | user | user_message | finalized | succeeded | Build probe | Send | | | fully_visible | video | | raw/screen.mp4#t=1 | |
| 2 | S01 | E01 | | T01 | left | R01 | 00:00:02.000 | 1000 | UI-002 | tool | tool | appeared | running | used Bash | Bash | | | fully_visible | video+screenshot | | raw/screen.mp4#t=2 | |
| 3 | S01 | E01 | | T01 | left | R01 | 00:00:03.000 | 2000 | UI-002 | tool | tool | finalized | succeeded | used Bash | Bash | normalized/bodies/event-003.md | | fully_visible | video+manual_copy | 2 | raw/screen.mp4#t=3 | |
| 4 | S01 | E01 | | T01 | left | R01 | 00:00:04.000 | 3000 | UI-004 | assistant | final | finalized | succeeded | Final | | | | fully_visible | video+manual_copy | | raw/screen.mp4#t=4 | exact result |
| 5 | S01 | E01 | | T01 | right | R01 | 00:00:02.500 | 1500 | UI-005 | tool | tool | finalized | failed | Read page | Fetched | | | not_visible | video | | raw/screen.mp4#t=2.5 | |

## Visible bodies

### Event 1

Build probe

### Event 3

visible_args:
\`\`\`json
{"command":"printf 'a|b'"}
\`\`\`
visible_result:
\`\`\`text
stdout: a|b
exit_code: 0
\`\`\`

### Event 4

Completed with a|b.

## Inferences

- none
`, { metadataText: `
task_id: W01
environment:
  started_at: "2026-08-28T12:00:00+08:00"
  ended_at: "2026-08-28T12:00:10+08:00"
post_run:
  final_ui_outcomes:
    left: success
    right: failed
  visible_usage:
    left:
      model_or_agent_label: arena-left-model
      input_tokens: 1,200
      output_tokens: 300
      cached_tokens: not_visible
      model_calls: 2
      tool_calls: 1
      displayed_cost: "$0.0042"
    right:
      model_or_agent_label: arena-right-model
      input_tokens: not_visible
      output_tokens: not_visible
      cached_tokens: not_visible
      model_calls: not_visible
      tool_calls: not_visible
      displayed_cost: not_visible
` })

    expect(trace.header).toMatchObject({ source: 'arena', taskId: 'W01', eventCount: 5, sides: ['left', 'right'] })
    expect(trace.events[0].message).toBe('Build probe')
    expect(trace.events[2].tool).toMatchObject({ name: 'shell', arguments: { command: "printf 'a|b'" }, result: 'stdout: a|b\nexit_code: 0', isError: false })
    expect(trace.events[4].tool).toMatchObject({ name: 'fetch', arguments: 'not_visible', result: 'not_visible', isError: true })
    expect(trace.outcome).toMatchObject({ status: 'unknown', finalText: 'not_applicable' })
    expect(trace.sideOutcomes?.left).toMatchObject({
      status: 'succeeded',
      finalText: 'Completed with a|b.',
      usage: {
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
        modelRequests: 2,
        modelCalls: 2,
        toolCalls: 1,
        estimatedCostUsd: 0.0042,
        estimatedCostStatus: 'estimated',
        durationMs: 3000,
      },
    })
    expect(trace.sideOutcomes?.right).toMatchObject({
      status: 'failed',
      usage: { totalTokens: 'unknown', modelRequests: 'not_visible', estimatedCostStatus: 'not_visible' },
    })
    expect(trace.header).toMatchObject({ startedAt: '2026-08-28T12:00:00+08:00', completedAt: '2026-08-28T12:00:10+08:00', durationMs: 3000 })
  })

  it('canonicalizes specialized Arena package and build event rows even when only UI labels are visible', () => {
    const trace = importArenaEventsMarkdown(`# Visible events — U02-20260828T120000+0800

| seq | segment | episode | parent | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility | capture_methods | supersedes | evidence | notes |
|---:|---|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | S01 | E01 | | T01 | global | R01 | 00:00:01.000 | 0 | UI-001 | tool | package_install | finalized | succeeded | Installed dependencies | | | | fully_visible | video | | screen.mp4#t=1 | |
| 2 | S01 | E01 | | T01 | global | R01 | 00:00:02.000 | 1000 | UI-002 | tool | build | finalized | succeeded | Building project... | build_project | | | fully_visible | video | | screen.mp4#t=2 | |
| 3 | S01 | E01 | | T01 | global | R01 | 00:00:03.000 | 2000 | UI-003 | tool | tool | finalized | succeeded | Built and started project | build_and_start | | | fully_visible | video | | screen.mp4#t=3 | |
`)

    expect(trace.events.map((event) => event.tool?.name)).toEqual(['package_install', 'build', 'website_start'])
    expect(trace.events.map((event) => event.action)).toEqual(['package_install', 'build', 'website_start'])
  })

  it('imports visible deployment state as a first-class canonical event', () => {
    const trace = importArenaEventsMarkdown(`# Visible events — D01-20260828T120000+0800

| seq | segment | episode | parent | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility | capture_methods | supersedes | evidence | notes |
|---:|---|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | S01 | E01 | | T01 | global | R01 | 00:00:01.000 | 0 | UI-D01 | system_ui | deployment | updated | succeeded | Deployed | deployed | normalized/bodies/event-001.md | | fully_visible | video | | screen.mp4#t=1 | |

## Visible bodies

### Event 1

project_id: arena-project-123
visible_url: https://public.example/deploy/project-123/
visibility: public
revision: 2
entry_path: index.html
content_hash: ${'b'.repeat(64)}
file_count: 3
bytes: 128
`)

    expect(trace.events[0]).toMatchObject({
      kind: 'deployment', action: 'deployed', status: 'succeeded',
      deployment: {
        id: 'D01', status: 'succeeded', url: 'https://public.example/deploy/project-123/', visibility: 'public',
        revision: 2, entryPath: 'index.html', contentHash: 'b'.repeat(64), fileCount: 3, bytes: 128,
      },
    })
  })

  it('imports the task review panel and its operator actions without confusing Continue working with run resume', () => {
    const trace = importArenaEventsMarkdown(`# Visible events — U03-20260828T120000+0800

| seq | segment | episode | parent | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility | capture_methods | supersedes | evidence | notes |
|---:|---|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | S01 | E01 | | T01 | global | R01 | 00:00:01.000 | 0 | UI-FINAL | assistant | final | finalized | succeeded | | | | | fully_visible | video | | screen.mp4#t=1 | |
| 2 | S01 | E01 | | T01 | global | R01 | 00:00:01.100 | 100 | UI-REVIEW | system_ui | task_review | appeared | awaiting_user_input | Did this task succeed? | | | | fully_visible | video+screenshot | | screen.mp4#t=1.1 | |
| 3 | S01 | E01 | | T01 | global | R01 | 00:00:02.000 | 1000 | UI-REVIEW | operator | operator_action | finalized | succeeded | Continue working | continue_working | | | fully_visible | video | 2 | screen.mp4#t=2 | |
| 4 | S01 | E01 | | T01 | global | R01 | 00:00:02.100 | 1100 | UI-FEEDBACK | system_ui | task_review | appeared | running | Saving feedback... | task_review_feedback_saving | | | fully_visible | video | | screen.mp4#t=2.1 | |
`)

    expect(trace.events.map((event) => ({ actor: event.actor, kind: event.kind, action: event.action, status: event.status }))).toEqual([
      { actor: 'assistant', kind: 'final', action: 'final_answer', status: 'succeeded' },
      { actor: 'system_ui', kind: 'lifecycle', action: 'task_review_required', status: 'awaiting_user_input' },
      { actor: 'operator', kind: 'operator_action', action: 'continue_working', status: 'succeeded' },
      { actor: 'system_ui', kind: 'lifecycle', action: 'task_review_feedback_saving', status: 'running' },
    ])
  })

  it('recovers fenced legacy shell evidence only for finalized results and excludes post-run inspection from duration', () => {
    const legacyFailure = `label: \`used Bash · exit 127 · 71ms\`

COMMAND

\`\`\`sh
printf probe && missing-command
\`\`\`

STDERR

\`\`\`text
/bin/bash: missing-command: command not found
\`\`\``
    const legacySuccess = `label: \`used Bash · 81ms\`

COMMAND

\`\`\`sh
printf probe
\`\`\`

STDOUT

\`\`\`text
probe
\`\`\``
    const trace = importArenaEventsMarkdown(`# Visible events — A02-legacy-shell

| seq | segment | episode | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility |
|---:|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|
| 1 | S01 | E01 | T01 | global | R01 | 00:00:01.000 | 0 | UI-SEND | operator | operator_action | finalized | succeeded | clicked Send | Send | | | fully_visible |
| 2 | S01 | E01 | T01 | global | R01 | 00:00:02.000 | 1000 | UI-BASH-1 | tool | tool | appeared | running | using Bash | Bash | failure.md | | fully_visible |
| 3 | S01 | E01 | T01 | global | R01 | 00:00:02.100 | 1100 | UI-BASH-1 | tool | tool | finalized | failed | used Bash · exit 127 · 71ms | Bash | failure.md | | fully_visible |
| 4 | S01 | E01 | T01 | global | R01 | 00:00:03.000 | 2000 | UI-BASH-2 | tool | tool | finalized | succeeded | used Bash · 81ms | Bash | success.md | | fully_visible |
| 5 | S01 | E01 | T01 | global | R01 | 00:00:06.000 | 5000 | UI-FINAL | assistant | final | finalized | succeeded | Final | | | | fully_visible |
| 6 | S01 | E01 | T01 | global | R01 | 00:01:41.000 | 100000 | UI-EXPAND | operator | operator_action | finalized | succeeded | expanded Bash | Expand | | | fully_visible |
`, {
      bodyLoader: (reference) => reference === 'failure.md' ? legacyFailure : reference === 'success.md' ? legacySuccess : undefined,
    })

    expect(trace.events[1].tool).toMatchObject({
      callId: trace.events[2].tool?.callId,
      arguments: { command: 'printf probe && missing-command' },
      result: 'not_applicable',
    })
    expect(trace.events[2].tool).toMatchObject({
      arguments: { command: 'printf probe && missing-command' },
      result: { exit_code: 127, stderr: '/bin/bash: missing-command: command not found' },
      isError: true,
    })
    expect(trace.events[3].tool).toMatchObject({
      arguments: { command: 'printf probe' },
      result: { stdout: 'probe' },
      isError: false,
    })
    expect(trace.header.durationMs).toBe(5000)
    expect(trace.outcome.usage.durationMs).toBe(5000)
  })

  it('keeps duration unknown when the episode start and Agent terminal are in different recordings', () => {
    const trace = importArenaEventsMarkdown(`# Visible events — X01-cross-recording

| seq | segment | episode | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility |
|---:|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|
| 1 | S01 | E01 | T01 | global | R01 | 00:00:01.000 | 0 | UI-SEND | operator | operator_action | finalized | succeeded | clicked Send | Send | | | fully_visible |
| 2 | S02 | E01 | T01 | global | R02 | 00:00:05.000 | 5000 | UI-FINAL | assistant | final | finalized | succeeded | Final | | | | fully_visible |
`)

    expect(trace.header.durationMs).toBe('unknown')
    expect(trace.outcome.usage.durationMs).toBe('unknown')
  })

  it('sums active episode durations without counting human wait or post-run operator time', () => {
    const trace = importArenaEventsMarkdown(`# Visible events — X01-multi-episode

| seq | segment | episode | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility |
|---:|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|
| 1 | S01 | E01 | T01 | global | R01 | 00:00:01.000 | 0 | UI-SEND-1 | operator | operator_action | finalized | succeeded | clicked Send | Send | | | fully_visible |
| 2 | S01 | E01 | T01 | global | R01 | 00:00:03.000 | 2000 | UI-WAIT | assistant | assistant_awaiting_user | finalized | awaiting_user_input | Need input | ask_user | | | fully_visible |
| 3 | S01 | E01 | T01 | global | R01 | 00:01:40.000 | 99000 | UI-HUMAN | operator | operator_action | finalized | succeeded | submitted answer after waiting | Submit custom response | | | fully_visible |
| 4 | S01 | E02 | T02 | global | R01 | 00:01:40.000 | 0 | UI-SEND-2 | operator | operator_action | finalized | succeeded | submitted answer | Submit custom response | | | fully_visible |
| 5 | S01 | E02 | T02 | global | R01 | 00:01:45.000 | 5000 | UI-FINAL | assistant | final | finalized | succeeded | Final | | | | fully_visible |
| 6 | S01 | E02 | T02 | global | R01 | 00:03:20.000 | 100000 | UI-EXPAND | operator | operator_action | finalized | succeeded | expanded result | Expand | | | fully_visible |
`)

    expect(trace.header.durationMs).toBe(7000)
    expect(trace.outcome.usage.durationMs).toBe(7000)
  })

  it('fails closed for a one-sided Agent episode boundary while ignoring a pure UI episode', () => {
    const table = (rows: string) => `# Visible events — X01-incomplete-episode

| seq | segment | episode | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility |
|---:|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|
${rows}
`
    const startOnly = importArenaEventsMarkdown(table(
      '| 1 | S01 | E01 | T01 | global | R01 | 00:00:01.000 | 0 | UI-SEND | operator | operator_action | finalized | succeeded | clicked Send | Send | | | fully_visible |',
    ))
    const terminalOnly = importArenaEventsMarkdown(table(
      '| 1 | S01 | E01 | T01 | global | R01 | 00:00:03.000 | 2000 | UI-FINAL | assistant | final | finalized | succeeded | Final | | | | fully_visible |',
    ))
    const completeWithPureUiEpisode = importArenaEventsMarkdown(table([
      '| 1 | S01 | E01 | T01 | global | R01 | 00:00:01.000 | 0 | UI-SEND | operator | operator_action | finalized | succeeded | clicked Send | Send | | | fully_visible |',
      '| 2 | S01 | E01 | T01 | global | R01 | 00:00:03.000 | 2000 | UI-FINAL | assistant | final | finalized | succeeded | Final | | | | fully_visible |',
      '| 3 | S02 | E99 | T99 | global | R01 | 00:01:40.000 | 99000 | UI-REPLAY | system_ui | replay | finalized | succeeded | replayed projection | Replay | | | fully_visible |',
    ].join('\n')))

    expect(startOnly.header.durationMs).toBe('unknown')
    expect(terminalOnly.header.durationMs).toBe('unknown')
    expect(completeWithPureUiEpisode.header.durationMs).toBe(2000)
  })

  it('fuses one unambiguous artifact CSV row without treating the evidence file path as the workspace path', () => {
    const trace = importArenaEventsMarkdown(`# Visible events — X02-artifact

| seq | segment | episode | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility |
|---:|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|
| 1 | S01 | E01 | T01 | global | R01 | 00:00:01.000 | 0 | UI-FILE | system_ui | artifact | finalized | succeeded | result | File viewer | | EVID-1 | fully_visible |
`, {
      artifactsCsvText: `artifact_id,origin_seq,turn_id,side,ui_name,ui_type,ui_status,preview_result,open_result,download_result,acquisition,local_path,bytes,sha256,truncation,evidence,notes
EVID-1,1,T01,global,"reports/result, final.txt",text/plain,succeeded,succeeded,succeeded,succeeded,official_download,"raw/private/result, final.txt",12,${'a'.repeat(64)},none,"screen.png; raw/private/result, final.txt","quoted, evidence-only path"
`,
    })

    expect(trace.events[0].artifact).toEqual({
      id: 'A01',
      path: 'reports/result, final.txt',
      name: 'result, final.txt',
      kind: 'unknown',
      mime: 'text/plain',
      bytes: 12,
      sha256: 'a'.repeat(64),
      operation: 'file_viewer',
    })
    expect(trace.outcome.artifactPaths).toEqual(['reports/result, final.txt'])
  })

  it('does not fuse duplicate or multi-ID artifact evidence', () => {
    const markdown = `# Visible events — X03-ambiguous-artifact

| seq | segment | episode | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility |
|---:|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|
| 1 | S01 | E01 | T01 | global | R01 | 00:00:01.000 | 0 | UI-FILE-1 | system_ui | artifact | finalized | succeeded | duplicate | File viewer | | DUP-1 | fully_visible |
| 2 | S01 | E01 | T01 | global | R01 | 00:00:02.000 | 1000 | UI-FILE-2 | tool | file | finalized | succeeded | two files | Write | | MULTI-1+MULTI-2 | fully_visible |
`
    const trace = importArenaEventsMarkdown(markdown, {
      artifactsCsvText: `artifact_id,ui_name,ui_type,bytes,sha256,local_path
DUP-1,first.txt,text/plain,1,${'1'.repeat(64)},raw/first.txt
DUP-1,second.txt,text/plain,2,${'2'.repeat(64)},raw/second.txt
MULTI-1,one.txt,text/plain,3,${'3'.repeat(64)},raw/one.txt
MULTI-2,two.txt,text/plain,4,${'4'.repeat(64)},raw/two.txt
`,
    })

    expect(trace.events[0].artifact).toMatchObject({ path: 'unknown', bytes: 'unknown', sha256: 'unknown' })
    expect(trace.events[1].artifact).toMatchObject({ path: 'unknown', bytes: 'unknown', sha256: 'unknown' })
    expect(trace.events[1].artifact?.id).toBeUndefined()
    expect(trace.outcome.artifactPaths).toBe('unknown')
  })

  it('repairs only the evidence-qualified A01/A02 legacy Review rows', () => {
    const row = `| 8 | S01 | E01 | T01 | global | R01 | 00:00:02.000 | 1000 | UI-REVIEW | system_ui | other | appeared | succeeded | 此任务成功了吗？ | | | | fully_visible |`
    const markdown = (traceId: string) => `# Visible events — ${traceId}

| seq | segment | episode | turn | side | recording | video_timecode | observed_at_ms | ui_item_id | actor | event_type | phase | status | label | tool_or_op | body_ref | artifact_ids | visibility |
|---:|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|---|
${row}

## Visible bodies

### Event 8

此任务成功了吗？

- 是
- 否
- 继续工作
`

    expect(importArenaEventsMarkdown(markdown('A01-20260828T013159+0800')).events[0]).toMatchObject({
      kind: 'lifecycle', action: 'task_review_required', status: 'awaiting_user_input',
    })
    expect(importArenaEventsMarkdown(markdown('A01-different-run')).events[0]).toMatchObject({
      kind: 'other', action: 'other', status: 'succeeded',
    })
  })
})
