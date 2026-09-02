import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import archiver from 'archiver'
import {
  type AgentCustomFeedbackArm,
  type ArtifactRecord,
  type PlanState,
  type ProcessRecord,
  type UsageTotals,
  type WebsiteState,
} from '../shared/types.js'
import type { SessionStore } from '../server/session-store.js'
import { encodeWorkspaceUrlPath, writeWorkspaceFile } from '../server/workspace.js'

export interface VisualFixtureSessions {
  empty: { id: string; title: string }
  free: { id: string; title: string }
  timedOut: { id: string; title: string }
  approval: { id: string; title: string }
  hitl: { id: string; title: string }
  highUsage: { id: string; title: string }
  completed: { id: string; title: string }
  taskCompletion: { id: string; title: string }
  review: { id: string; title: string }
  coding: { id: string; title: string }
}

export interface VisualRunningFixture {
  id: string
  title: string
}

export interface VisualWritingFixture {
  id: string
  title: string
  path: string
  content: string
  bytes: number
  lineCount: number
}

export interface VisualWorkspacePersistenceFixture {
  id: string
  title: string
  bytes: number
  fileCount: number
}

const MODEL = 'arena-agent-fixture'

export async function seedVisualFixtureSessions(store: SessionStore): Promise<VisualFixtureSessions> {
  const empty = await seedEmpty(store)
  const free = await seedFree(store)
  const timedOut = await seedTimedOut(store)
  const approval = await seedApproval(store)
  const hitl = await seedHitl(store)
  const highUsage = await seedHighUsage(store)
  const completed = await seedCompleted(store)
  const taskCompletion = await seedVisualTaskCompletionFixture(store)
  const review = await seedVisualTaskReviewFixture(store, 'Visual Task Review', { customFeedbackArm: 'treatment-1' })
  const coding = await seedCoding(store)
  const historyOrder = [completed, taskCompletion, review, coding, highUsage, hitl, approval, timedOut, free, empty]
  for (let index = 0; index < historyOrder.length; index += 1) {
    await store.update(historyOrder[index].id, () => {}, {
      updatedAt: new Date(Date.parse('2026-08-28T00:00:00.000Z') + (historyOrder.length - index) * 1_000).toISOString(),
    })
  }
  return { empty, free, timedOut, approval, hitl, highUsage, completed, taskCompletion, review, coding }
}

export async function seedVisualRunningFixture(store: SessionStore): Promise<VisualRunningFixture> {
  const title = 'Visual Running'
  const session = await store.create({ isFreeSession: true })
  const id = session.summary.id
  const turnId = 'turn_visual_running'
  const stepId = 'step_visual_running'
  const source = 'RUNNING-FIXTURE\n'
  await writeWorkspaceFile(store.workspaceDir(id), 'input.txt', source)
  await store.append(id, 'turn.started', {
    content: 'Inspect input.txt, run the bounded verification command, and report only after it completes.',
    attachments: ['uploads/running-requirements.md'],
  }, { turnId })
  await store.append(id, 'run.status', { status: 'running' }, { turnId })
  await store.append(id, 'assistant.started', { step: 1 }, { turnId, stepId })
  await store.append(id, 'assistant.thought.started', { step: 1 }, { turnId, stepId })
  await store.append(id, 'assistant.thought.delta', {
    delta: 'I will inspect the input, record the plan, and stream the bounded verification output.',
  }, { turnId, stepId })
  await store.update(id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'running'
    state.summary.lastMessage = 'Inspect input.txt, run the bounded verification command, and report only after it completes.'
    state.summary.workspaceBytes = Buffer.byteLength(source)
    state.summary.usage = {
      promptTokens: 2_144,
      completionTokens: 96,
      totalTokens: 2_240,
      cachedPromptTokens: 1_920,
      estimatedCostUsd: 0.00031,
      modelCalls: 1,
      toolCalls: 0,
      startedAt: '2026-08-28T00:00:00.000Z',
      durationMs: 1_420,
    }
  })
  return { id, title }
}

export async function seedVisualWritingFixture(store: SessionStore): Promise<VisualWritingFixture> {
  const title = 'Visual Streaming HTML Write'
  const path = 'ai-weekly-2026-08-31.html'
  const prompt = '看看本周的AI领域热点，创建一个精美的HTML Slides进行展示。'
  const padding = Array.from({ length: 414 }, (_, index) => (
    `<div class="signal-card" data-index="${String(index + 1).padStart(3, '0')}">Weekly AI field note ${String(index + 1).padStart(3, '0')}</div>`
  ))
  const tail = [
    '<div class="kicker"><span class="dot"></span>10 · AUGUST TIMELINE</div>',
    '<h2>八月大事记：AI 史上最紧凑的一个月</h2>',
    '<div class="display-grid g2">',
    '<div class="timeline">',
    '<div class="timeline-item"><div class="timeline-date">08-01</div><div class="body">OpenAI 公开重点事件</div></div>',
    '<div class="timeline-item"><div class="timeline-date">08-06</div><div class="body">全球继续加速 Agent 部署</div></div>',
    '<div class="timeline-item"><div class="timeline-date">08-12</div><div class="body">多模态模型进入生产环境</div></div>',
    '</div>',
  ]
  const content = [...padding, ...tail].join('\n')
  const lineCount = padding.length + tail.length
  const argumentsText = JSON.stringify({ path, content }).slice(0, -2)
  const session = await store.create({ isFreeSession: true })
  const id = session.summary.id
  const turnId = 'turn_visual_streaming_write'
  const stepId = 'step_visual_streaming_write'

  await store.append(id, 'turn.started', { content: prompt, attachments: [] }, { turnId })
  await store.append(id, 'run.status', { status: 'running' }, { turnId })
  await store.append(id, 'assistant.started', { step: 1 }, { turnId, stepId })
  await store.append(id, 'assistant.thought.started', { step: 1 }, { turnId, stepId })
  await store.append(id, 'assistant.thought.delta', {
    delta: '信息已经足够充分了。现在开始制作自包含的 HTML 幻灯片，可在预览中直接播放。',
  }, { turnId, stepId })
  await store.append(id, 'assistant.thought.completed', {
    text: '信息已经足够充分了。现在开始制作自包含的 HTML 幻灯片，可在预览中直接播放。',
  }, { turnId, stepId })
  await store.append(id, 'assistant.tool_call.delta', {
    index: 0,
    idDelta: 'call_visual_streaming_write',
    nameDelta: 'write_file',
    argumentsDelta: argumentsText,
  }, { turnId, stepId })
  await store.update(id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'running'
    state.summary.lastMessage = prompt
    state.summary.workspaceBytes = 0
    state.summary.usage = usage({
      modelCalls: 4,
      toolCalls: 4,
      totalTokens: 18_642,
      estimatedCostUsd: 0.0048,
      durationMs: 92_000,
    })
  })
  return { id, title, path, content, bytes: Buffer.byteLength(content), lineCount }
}

export async function advanceVisualRunningFixture(store: SessionStore, sessionId: string): Promise<void> {
  const turnId = 'turn_visual_running'
  const stepId = 'step_visual_running'
  const plan: PlanState = {
    items: [
      { id: 'plan_visual_running_inspect', step: 'Inspect the requested input', status: 'completed' },
      { id: 'plan_visual_running_verify', step: 'Run the bounded verification command', status: 'in_progress' },
      { id: 'plan_visual_running_report', step: 'Report the verified result', status: 'pending' },
    ],
    explanation: 'The input is understood; the bounded verification command is running.',
    updatedAt: '2026-08-28T00:00:03.000Z',
    version: 1,
  }
  const planCall = {
    id: 'call_visual_running_plan',
    name: 'update_plan',
    arguments: { explanation: plan.explanation, plan: plan.items.map(({ step, status }) => ({ step, status })) },
  }
  const shellCall = {
    id: 'call_visual_running_shell',
    name: 'bash',
    arguments: {
      command: 'python3 -u verify.py',
      description: 'Run bounded verification',
      timeout: 120000,
      workdir: '.',
    },
  }
  await store.append(sessionId, 'assistant.thought.completed', {
    text: 'I will inspect the input, record the plan, and stream the bounded verification output.',
  }, { turnId, stepId })
  await store.append(sessionId, 'tool.started', { call: planCall }, { turnId, stepId, callId: planCall.id })
  await store.append(sessionId, 'plan.updated', { plan, explanation: plan.explanation }, { turnId, stepId, callId: planCall.id })
  await store.append(sessionId, 'tool.completed', {
    call: planCall,
    result: '{"status":"success"}',
    isError: false,
  }, { turnId, stepId, callId: planCall.id })
  await store.append(sessionId, 'tool.started', { call: shellCall }, { turnId, stepId, callId: shellCall.id })
  await store.append(sessionId, 'tool.output', {
    stream: 'stdout',
    chunk: 'VERIFY 1/3 input loaded\nVERIFY 2/3 checks running\n',
  }, { turnId, stepId, callId: shellCall.id })
  await store.append(sessionId, 'tool.output', {
    stream: 'stderr',
    chunk: 'waiting for final probe...\n',
  }, { turnId, stepId, callId: shellCall.id })
  await store.update(sessionId, (state) => {
    state.plan = plan
    state.summary.usage = {
      promptTokens: 4_672,
      completionTokens: 184,
      totalTokens: 4_856,
      cachedPromptTokens: 4_096,
      estimatedCostUsd: 0.00058,
      modelCalls: 2,
      toolCalls: 2,
      startedAt: '2026-08-28T00:00:00.000Z',
      durationMs: 4_312,
    }
  })
}

export async function seedVisualWorkspacePersistenceFixture(
  store: SessionStore,
  title = 'Visual Workspace Persistence',
): Promise<VisualWorkspacePersistenceFixture> {
  const session = await store.create({ isFreeSession: true })
  const id = session.summary.id
  const turnId = 'turn_visual_workspace_persistence'
  const stepId = 'step_visual_workspace_persistence'
  const source = 'WORKSPACE-PERSISTENCE-FIXTURE\n'
  const finalContent = 'The workspace persistence fixture is complete.'
  const bytes = Buffer.byteLength(source)
  const fileCount = 1
  await writeWorkspaceFile(store.workspaceDir(id), 'persistence.txt', source)
  await store.append(id, 'turn.started', {
    content: 'Persist the completed workspace and report only after the durable save boundary.',
    attachments: [],
  }, { turnId })
  await store.append(id, 'run.status', { status: 'running' }, { turnId })
  await store.append(id, 'assistant.started', { step: 1 }, { turnId, stepId })
  await store.append(id, 'assistant.final.delta', { delta: finalContent }, { turnId, stepId })
  await store.update(id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'running'
    state.summary.lastMessage = 'Persist the completed workspace and report only after the durable save boundary.'
    state.summary.workspaceBytes = bytes
    state.summary.usage = usage({ modelCalls: 1, toolCalls: 0, totalTokens: 512, estimatedCostUsd: 0.00012, durationMs: 920 })
    state.turnMessageStarts ??= {}
    state.turnMessageStarts[turnId] = 0
    state.messages = [
      { role: 'user', content: 'Persist the completed workspace and report only after the durable save boundary.' },
    ]
  })
  return { id, title, bytes, fileCount }
}

export async function advanceVisualWorkspacePersistenceScanning(store: SessionStore, sessionId: string): Promise<void> {
  await store.append(sessionId, 'workspace.persistence.started', {
    phase: 'scanning',
    label: 'Scanning workspace...',
    persistenceMode: 'local_durable',
  }, workspacePersistenceEventOptions())
}

export async function advanceVisualWorkspacePersistenceUploading(store: SessionStore, sessionId: string): Promise<void> {
  await store.append(sessionId, 'workspace.persistence.updated', {
    phase: 'uploading',
    label: 'Uploading 0 workspace blobs...',
    blobCount: 0,
    persistenceMode: 'local_durable',
  }, workspacePersistenceEventOptions())
}

export async function advanceVisualWorkspacePersistenceSaving(store: SessionStore, sessionId: string): Promise<void> {
  await store.append(sessionId, 'workspace.persistence.updated', {
    phase: 'saving',
    label: 'Saving workspace...',
    persistenceMode: 'local_durable',
  }, workspacePersistenceEventOptions())
}

export async function advanceVisualWorkspacePersistenceSaved(
  store: SessionStore,
  fixture: VisualWorkspacePersistenceFixture,
): Promise<void> {
  await store.append(fixture.id, 'workspace.persistence.completed', {
    phase: 'saved',
    label: 'Workspace saved',
    blobCount: 0,
    bytes: fixture.bytes,
    fileCount: fixture.fileCount,
    persistenceMode: 'local_durable',
  }, workspacePersistenceEventOptions())
}

export async function completeVisualWorkspacePersistenceFixture(
  store: SessionStore,
  fixture: VisualWorkspacePersistenceFixture,
): Promise<void> {
  const turnId = 'turn_visual_workspace_persistence'
  const stepId = 'step_visual_workspace_persistence'
  const finalContent = 'The workspace persistence fixture is complete.'
  const final = await store.append(fixture.id, 'assistant.final', {
    content: finalContent,
    finishReason: 'stop',
  }, { turnId, stepId })
  await store.append(fixture.id, 'turn.completed', { status: 'completed', firstTurn: true }, { turnId, stepId })
  await store.append(fixture.id, 'run.status', { status: 'completed' }, { turnId, stepId })
  await store.append(fixture.id, 'review.requested', {
    messageEventId: final.id,
    model: MODEL,
    feedbackType: 'check_in',
  }, { turnId, stepId })
  await store.update(fixture.id, (state) => {
    state.summary.status = 'completed'
    state.summary.workspaceBytes = fixture.bytes
    state.summary.usage = usage({ modelCalls: 1, toolCalls: 0, totalTokens: 544, estimatedCostUsd: 0.00013, durationMs: 1_640 })
    state.messages = [
      { role: 'user', content: 'Persist the completed workspace and report only after the durable save boundary.' },
      { role: 'assistant', content: finalContent },
    ]
  })
}

function workspacePersistenceEventOptions(): { turnId: string; stepId: string } {
  return {
    turnId: 'turn_visual_workspace_persistence',
    stepId: 'step_visual_workspace_persistence',
  }
}

export async function seedVisualTaskReviewFixture(
  store: SessionStore,
  title = 'Visual Task Review',
  options: { compacted?: boolean; isFreeSession?: boolean; customFeedbackArm?: AgentCustomFeedbackArm } = {},
): Promise<{ id: string; title: string }> {
  const identitySuffix = title === 'Visual Task Review'
    ? ''
    : `_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
  const session = await store.create({
    isFreeSession: options.isFreeSession === true,
    customFeedbackArm: options.customFeedbackArm,
  })
  const id = session.summary.id
  const turnId = `turn_visual_review${identitySuffix}`
  const stepId = `step_visual_review${identitySuffix}`
  await store.append(id, 'turn.started', {
    content: 'Calculate 317 × 29 and answer in one sentence.', attachments: [],
  }, { turnId })
  await store.append(id, 'run.status', { status: 'running' }, { turnId })
  if (options.compacted) {
    await store.append(id, 'context.compacted', {
      summary: 'The completed context was checkpointed before the Final.',
      checkpointApplied: true,
    }, { turnId, stepId })
  }
  const final = await store.append(id, 'assistant.final', {
    content: '317 × 29 = **9,193**.', finishReason: 'stop',
  }, { turnId, stepId })
  await store.append(id, 'turn.completed', { status: 'completed' }, { turnId, stepId })
  await store.append(id, 'run.status', { status: 'completed' }, { turnId, stepId })
  await store.append(id, 'review.requested', {
    messageEventId: final.id,
    model: MODEL,
    feedbackType: 'check_in',
  }, { turnId, stepId })
  await store.update(id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'completed'
    state.summary.lastMessage = 'Calculate 317 × 29 and answer in one sentence.'
    state.summary.usage = usage({ modelCalls: 1, toolCalls: 0, totalTokens: 384, estimatedCostUsd: 0.0001, durationMs: 712 })
    state.turnMessageStarts ??= {}
    state.turnMessageStarts[turnId] = 0
    state.messages = [
      { role: 'user', content: 'Calculate 317 × 29 and answer in one sentence.' },
      { role: 'assistant', content: '317 × 29 = **9,193**.' },
    ]
  })
  return { id, title }
}

export async function seedVisualTaskCompletionFixture(
  store: SessionStore,
  title = 'Visual Task Completion',
  options: { isFreeSession?: boolean; customFeedbackArm?: AgentCustomFeedbackArm } = {},
): Promise<{ id: string; title: string }> {
  const suffix = title === 'Visual Task Completion'
    ? ''
    : `_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
  const session = await store.create({
    feedbackType: 'task_completion_bar',
    isFreeSession: options.isFreeSession === true,
    customFeedbackArm: options.customFeedbackArm,
  })
  const id = session.summary.id
  const turnId = `turn_visual_completion${suffix}`
  await store.append(id, 'turn.started', {
    content: 'Prepare and verify the complete task result.', attachments: [],
  }, { turnId })
  await store.append(id, 'run.status', { status: 'running' }, { turnId })
  // Keep the Final below the initial desktop fold even when Arena's compact,
  // borderless trace rows are used. This preserves the completion-bar ingress
  // gate without coupling it to the older, taller card treatment.
  for (let index = 1; index <= 22; index += 1) {
    const stepId = `step_visual_completion_${String(index).padStart(2, '0')}${suffix}`
    await store.append(id, 'assistant.thought.started', { step: index }, { turnId, stepId })
    await store.append(id, 'assistant.thought.completed', {
      text: `Verified task-completion checkpoint ${index} of 22.`,
    }, { turnId, stepId })
  }
  const finalStepId = `step_visual_completion_final${suffix}`
  const final = await store.append(id, 'assistant.final', {
    content: 'The requested task is complete and the result has been verified.', finishReason: 'stop',
  }, { turnId, stepId: finalStepId })
  await store.append(id, 'turn.completed', { status: 'completed' }, { turnId, stepId: finalStepId })
  await store.append(id, 'run.status', { status: 'completed' }, { turnId, stepId: finalStepId })
  await store.append(id, 'review.requested', {
    messageEventId: final.id, model: MODEL, feedbackType: 'task_completion_bar',
  }, { turnId, stepId: finalStepId })
  await store.update(id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'completed'
    state.summary.feedbackType = 'task_completion_bar'
    state.summary.lastMessage = 'Prepare and verify the complete task result.'
    state.summary.usage = usage({ modelCalls: 2, toolCalls: 0, totalTokens: 1_024, estimatedCostUsd: 0.0003, durationMs: 1_240 })
  })
  return { id, title }
}

async function seedFree(store: SessionStore): Promise<{ id: string; title: string }> {
  const title = 'Visual Free Session'
  const session = await store.create({ isFreeSession: true })
  await store.update(session.summary.id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'idle'
    state.summary.usage = emptyUsage()
  })
  return { id: session.summary.id, title }
}

async function seedCoding(store: SessionStore): Promise<{ id: string; title: string }> {
  const title = 'Visual Coding Repository'
  const repository = {
    provider: 'github' as const,
    repoId: 17,
    fullName: 'arena-labs/harness',
    ownerLogin: 'arena-labs',
    name: 'harness',
    baseBranch: 'main',
    baseCommitSha: 'a'.repeat(40),
    private: true,
    importedAt: '2026-08-28T00:00:00.000Z',
  }
  const session = await store.create({ repository })
  const id = session.summary.id
  const turnId = 'turn_visual_coding'
  const stepId = 'step_visual_coding'
  const source = '# Harness fixture\n\nImported from the selected GitHub repository.\n'
  await writeWorkspaceFile(store.workspaceDir(id), 'README.md', source)
  await store.append(id, 'turn.started', { content: 'Inspect the repository and summarize its entry point.', attachments: [], productMode: 'coding', repository }, { turnId })
  await store.append(id, 'run.status', { status: 'running' }, { turnId })
  await store.append(id, 'assistant.thought.started', { step: 1 }, { turnId, stepId })
  await store.append(id, 'assistant.thought.completed', { text: 'I will inspect the imported repository before making any changes.' }, { turnId, stepId })
  const call = { id: 'call_visual_coding_read', name: 'read_file', arguments: { path: 'README.md' } }
  await store.append(id, 'tool.started', { call }, { turnId, stepId, callId: call.id })
  await store.append(id, 'tool.completed', { call, result: source, isError: false }, { turnId, stepId, callId: call.id })
  const final = await store.append(id, 'assistant.final', { content: 'The selected `arena-labs/harness` repository is available on branch `main`; its fixture entry point is `README.md`.' }, { turnId, stepId })
  await store.append(id, 'turn.completed', { status: 'completed' }, { turnId })
  await store.append(id, 'run.status', { status: 'completed' }, { turnId })
  await store.append(id, 'review.requested', { messageEventId: final.id, model: MODEL }, { turnId, stepId })
  await store.update(id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'completed'
    state.summary.lastMessage = 'Inspect the repository and summarize its entry point.'
    state.summary.workspaceBytes = Buffer.byteLength(source)
    state.summary.usage = usage({ modelCalls: 1, toolCalls: 1, totalTokens: 1240, estimatedCostUsd: 0.0005, durationMs: 1920 })
  })
  return { id, title }
}

async function seedEmpty(store: SessionStore): Promise<{ id: string; title: string }> {
  const title = 'Visual Empty'
  const session = await store.create()
  await store.update(session.summary.id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'idle'
    state.summary.usage = emptyUsage()
  })
  return { id: session.summary.id, title }
}

async function seedTimedOut(store: SessionStore): Promise<{ id: string; title: string }> {
  const title = 'Visual Timed Out'
  const session = await store.create()
  const id = session.summary.id
  const turnId = 'turn_visual_timeout'
  const stepId = 'step_visual_timeout'
  const planCall = {
    id: 'call_visual_timeout_plan',
    name: 'update_plan',
    arguments: {
      explanation: 'Running the bounded probe before reporting its terminal state.',
      plan: [
        { step: 'Run the bounded foreground probe', status: 'in_progress' },
        { step: 'Report the observed terminal state', status: 'pending' },
      ],
    },
  }
  const plan: PlanState = {
    items: [
      { id: 'plan_visual_timeout_run', step: 'Run the bounded foreground probe', status: 'in_progress' },
      { id: 'plan_visual_timeout_report', step: 'Report the observed terminal state', status: 'pending' },
    ],
    explanation: 'Running the bounded probe before reporting its terminal state.',
    updatedAt: '2026-08-28T00:00:02.000Z',
    version: 1,
  }
  const call = { id: 'call_visual_timeout', name: 'bash', arguments: { command: 'python3 -u timeout_probe.py', description: 'Run the bounded timeout probe', timeout: 120000 } }
  await writeWorkspaceFile(store.workspaceDir(id), 'timeout_probe.py', 'import time\nprint("START", flush=True)\ntime.sleep(600)\n')
  await store.append(id, 'turn.started', {
    content: 'Run the foreground timeout probe and report its real terminal state.',
    attachments: [],
  }, { turnId })
  await store.append(id, 'run.status', { status: 'running' }, { turnId })
  await store.append(id, 'assistant.thought.started', { step: 1 }, { turnId, stepId })
  await store.append(id, 'assistant.thought.completed', { text: 'I will run the bounded foreground command and preserve partial output.' }, { turnId, stepId })
  await store.append(id, 'tool.started', { call: planCall }, { turnId, stepId, callId: planCall.id })
  await store.append(id, 'plan.updated', { plan, explanation: plan.explanation }, { turnId, stepId, callId: planCall.id })
  await store.append(id, 'tool.completed', { call: planCall, result: '{"status":"success"}', isError: false }, { turnId, stepId, callId: planCall.id })
  await store.append(id, 'tool.started', { call }, { turnId, stepId, callId: call.id })
  await store.append(id, 'tool.timed_out', {
    call,
    result: '{"status":"error","message":"Command timed out after 120000ms","stdout":"START\\nHEARTBEAT 1\\nHEARTBEAT 2\\n","stderr":"Command timed out after 120000ms"}',
    isError: true,
  }, { turnId, stepId, callId: call.id })
  await store.append(id, 'error', { message: 'The foreground tool exceeded its 120 second limit.', cancelled: false }, { turnId })
  await store.append(id, 'turn.completed', { status: 'timed_out' }, { turnId })
  await store.append(id, 'run.status', { status: 'timed_out' }, { turnId })
  await store.update(id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'timed_out'
    state.summary.lastMessage = 'Run the foreground timeout probe and report its real terminal state.'
    state.summary.workspaceBytes = 58
    state.summary.usage = usage({ modelCalls: 2, toolCalls: 2, totalTokens: 3842, estimatedCostUsd: 0.0017, durationMs: 120000 })
    state.plan = plan
  })
  return { id, title }
}

async function seedHitl(store: SessionStore): Promise<{ id: string; title: string }> {
  const title = 'Visual Structured Answer'
  const session = await store.create()
  const id = session.summary.id
  const turnId = 'turn_visual_hitl'
  const stepId = 'step_visual_hitl'
  const call = visualHitlCall()
  await store.append(id, 'turn.started', {
    content: 'Prepare the launch brief after I choose the scope and note one constraint.',
    attachments: [],
  }, { turnId })
  await store.append(id, 'run.status', { status: 'running' }, { turnId })
  await store.append(id, 'assistant.thought.started', { step: 1 }, { turnId, stepId })
  await store.append(id, 'assistant.thought.completed', {
    text: 'The requested scope materially changes the deliverable, so I need one structured choice.',
  }, { turnId, stepId })
  await store.append(id, 'tool.started', { call }, { turnId, stepId, callId: call.id })
  await store.append(id, 'hitl.required', {
    hitlId: 'hitl_visual_scope',
    kind: 'ask_user',
    call,
    title: 'A few questions before I continue',
    payload: call.arguments,
  }, { turnId, stepId, callId: call.id })
  await store.append(id, 'run.status', { status: 'awaiting_user', hitlId: 'hitl_visual_scope' }, { turnId, stepId, callId: call.id })
  await store.update(id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'awaiting_user'
    state.summary.lastMessage = 'Prepare the launch brief after I choose the scope and note one constraint.'
    state.summary.usage = usage({ modelCalls: 1, toolCalls: 1, totalTokens: 2_488, estimatedCostUsd: 0.00082, durationMs: 3_100 })
  })
  return { id, title }
}

export async function resolveVisualHitlFixture(store: SessionStore, sessionId: string): Promise<void> {
  const turnId = 'turn_visual_hitl'
  const stepId = 'step_visual_hitl'
  const call = visualHitlCall()
  const response = {
    skipped: false,
    answers: [
      { questionId: 'scope', selectedOptionId: 'focused', customResponse: null },
      { questionId: 'constraint', selectedOptionId: null, customResponse: 'Keep the original launch date' },
    ],
  }
  await store.append(sessionId, 'hitl.resolved', {
    hitlId: 'hitl_visual_scope', kind: 'ask_user', response,
  }, { turnId, stepId, callId: call.id })
  await store.append(sessionId, 'tool.completed', {
    call, result: JSON.stringify(response), isError: false,
  }, { turnId, stepId, callId: call.id })
  const final = await store.append(sessionId, 'assistant.final', {
    content: 'The focused launch brief will keep the original launch date.',
    finishReason: 'stop',
  }, { turnId, stepId })
  await store.append(sessionId, 'turn.completed', { status: 'completed' }, { turnId, stepId })
  await store.append(sessionId, 'run.status', { status: 'completed' }, { turnId, stepId })
  await store.append(sessionId, 'review.requested', {
    messageEventId: final.id, model: MODEL, feedbackType: 'check_in',
  }, { turnId, stepId })
  await store.update(sessionId, (state) => {
    state.summary.status = 'completed'
    state.summary.usage = usage({ modelCalls: 2, toolCalls: 1, totalTokens: 3_216, estimatedCostUsd: 0.00104, durationMs: 4_400 })
  })
}

function visualHitlCall() {
  return {
    id: 'call_visual_hitl_scope',
    name: 'ask_user',
    arguments: {
      questions: [
        {
          id: 'scope',
          question: 'Which launch scope should I use?',
          options: [
            { id: 'focused', label: 'Focused launch', description: 'Prioritize the core audience and one launch channel.' },
            { id: 'full', label: 'Full launch', description: 'Cover every audience and channel in the first release.' },
          ],
          allowCustomResponse: true,
        },
        {
          id: 'constraint',
          question: 'Any constraint I should preserve?',
          options: [
            { id: 'none', label: 'No extra constraint' },
            { id: 'budget', label: 'Keep the current budget' },
          ],
          allowCustomResponse: true,
        },
      ],
    },
  }
}

async function seedApproval(store: SessionStore): Promise<{ id: string; title: string }> {
  const title = 'Visual Approval'
  const session = await store.create()
  const id = session.summary.id
  const turnId = 'turn_visual_approval'
  const stepId = 'step_visual_approval'
  const call = {
    id: 'call_visual_approval',
    name: 'http_request',
    arguments: {
      url: 'https://httpbin.org/status/204',
      method: 'POST',
      json_body: { probe: 'visual-contract', value: 7 },
    },
  }
  await writeWorkspaceFile(store.workspaceDir(id), 'request-preview.json', `${JSON.stringify(call.arguments, null, 2)}\n`)
  await store.append(id, 'turn.started', {
    content: 'Send the approved synthetic payload only after I confirm it.',
    attachments: ['uploads/request-spec.md'],
  }, { turnId })
  await store.append(id, 'run.status', { status: 'running' }, { turnId })
  await store.append(id, 'assistant.thought.started', { step: 1 }, { turnId, stepId })
  await store.append(id, 'assistant.thought.completed', { text: 'The request changes external state, so I am waiting for an explicit one-shot approval.' }, { turnId, stepId })
  await store.append(id, 'tool.started', { call }, { turnId, stepId, callId: call.id })
  await store.append(id, 'approval.required', {
    approvalId: 'approval_visual_pending',
    call,
    title: 'Approve external request?',
    description: 'This action can change data outside the workspace.',
  }, { turnId, stepId, callId: call.id })
  await store.append(id, 'run.status', { status: 'awaiting_approval', approvalId: 'approval_visual_pending' }, { turnId, stepId, callId: call.id })
  await store.update(id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'awaiting_approval'
    state.summary.lastMessage = 'Send the approved synthetic payload only after I confirm it.'
    state.summary.workspaceBytes = 183
    state.summary.usage = usage({ modelCalls: 1, toolCalls: 0, totalTokens: 2174, estimatedCostUsd: 0.0009, durationMs: 4112 })
  })
  return { id, title }
}

async function seedHighUsage(store: SessionStore): Promise<{ id: string; title: string }> {
  const title = 'Visual High Token Usage'
  const session = await store.create()
  const id = session.summary.id
  const turnId = 'turn_visual_high_token_usage'
  const stepId = 'step_visual_high_token_usage'
  await store.append(id, 'turn.started', {
    content: 'Summarize the completed workspace before this long session ends.',
    attachments: [],
  }, { turnId })
  await store.append(id, 'run.status', { status: 'running' }, { turnId })
  await store.append(id, 'assistant.final.delta', { delta: 'The workspace summary is complete.' }, { turnId, stepId })
  await store.append(id, 'usage.updated', {
    usage: usage({ modelCalls: 18, toolCalls: 15, totalTokens: 100_240, estimatedCostUsd: 0.0198, durationMs: 42_312 }),
    source: 'agent',
  }, { turnId, stepId })
  await store.append(id, 'assistant.final', {
    content: 'The workspace summary is complete. You can continue in this chat.',
    finishReason: 'stop',
  }, { turnId, stepId })
  await store.append(id, 'turn.completed', { status: 'completed' }, { turnId, stepId })
  await store.append(id, 'run.status', { status: 'completed' }, { turnId, stepId })
  await store.update(id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'completed'
    state.summary.lastMessage = 'Summarize the completed workspace before this long session ends.'
    state.summary.usage = usage({ modelCalls: 18, toolCalls: 15, totalTokens: 100_240, estimatedCostUsd: 0.0198, durationMs: 42_312 })
  })
  return { id, title }
}

async function seedCompleted(store: SessionStore): Promise<{ id: string; title: string }> {
  const title = 'Visual Complete'
  const session = await store.create()
  const id = session.summary.id
  const workspace = store.workspaceDir(id)
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Anera Status</title>
  <style>
    body { font-family: system-ui; margin: 40px; background: #f7f7f3; color: #20201e; }
    main { max-width: 720px; margin: auto; }
    section { padding: 24px; border: 1px solid #ddd; border-radius: 12px; background: white; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>All systems operational</h1>
      <p>Visual contract fixture website.</p>
    </section>
  </main>
</body>
</html>
`
  const aboutHtml = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>About the status page</title></head>
<body><main><h1>Secondary preview file</h1></main></body>
</html>
`
  const report = '# Delivery report\n\n- Website implemented\n- Browser verified\n- Console clean\n'
  const appJs = 'document.documentElement.dataset.ready = "true";\n'
  const data = '{"availability":99.99,"incidents":3}\n'
  const generatedImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const docxPath = resolve(workspace, 'docs/project-brief.docx')
  const xlsxPath = resolve(workspace, 'data/readiness.xlsx')
  const pptxPath = resolve(workspace, 'slides/review.pptx')
  await writeOfficeVisualFixture(docxPath, {
    'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Project readiness brief</w:t></w:r></w:p><w:p><w:r><w:t>Launch window: 18 September</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Arena Team</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  })
  await writeOfficeVisualFixture(xlsxPath, {
    'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheets><sheet name="Readiness" sheetId="1" r:id="rId1"/><sheet name="Risks" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Metric</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Availability</t></is></c><c r="B2"><v>99.99</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Risk</t></is></c><c r="B1" t="inlineStr"><is><t>Owner</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Capacity</t></is></c><c r="B2" t="inlineStr"><is><t>Platform</t></is></c></row></sheetData></worksheet>',
  })
  await writeOfficeVisualFixture(pptxPath, {
    'ppt/presentation.xml': '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="1" r:id="rId1"/><p:sldId id="2" r:id="rId2"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Launch readiness</a:t></a:r></a:p><a:p><a:r><a:t>All critical systems verified</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Next steps</a:t></a:r></a:p><a:p><a:r><a:t>Monitor rollout and publish status</a:t></a:r></a:p></p:sld>',
  })
  const sizes = {
    index: await writeWorkspaceFile(workspace, 'index.html', html),
    about: await writeWorkspaceFile(workspace, 'about.html', aboutHtml),
    report: await writeWorkspaceFile(workspace, 'docs/report.md', report),
    app: await writeWorkspaceFile(workspace, 'src/app.js', appJs),
    data: await writeWorkspaceFile(workspace, 'data/status.json', data),
    image: await writeWorkspaceFile(workspace, 'assets/status-hero.png', generatedImage),
    docx: (await stat(docxPath)).size,
    xlsx: (await stat(xlsxPath)).size,
    pptx: (await stat(pptxPath)).size,
  }
  const artifacts = [
    visualArtifact(id, 'index.html', 'website', 'text/html'),
    visualArtifact(id, 'docs/report.md', 'markdown', 'text/markdown'),
    visualArtifact(id, 'data/status.json', 'data', 'application/json'),
    visualArtifact(id, 'assets/status-hero.png', 'image', 'image/png'),
    visualArtifact(id, 'docs/project-brief.docx', 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    visualArtifact(id, 'data/readiness.xlsx', 'document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    visualArtifact(id, 'slides/review.pptx', 'document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  ]
  const turnId = 'turn_visual_complete'
  const writeStep = 'step_visual_write'
  const webStep = 'step_visual_web'
  const finalStep = 'step_visual_final'
  const writeCall = { id: 'call_visual_write', name: 'write_file', arguments: { path: 'index.html', content: html } }
  const listCall = { id: 'call_visual_list', name: 'list_files', arguments: {} }
  const readCall = { id: 'call_visual_read', name: 'read_file', arguments: { path: 'index.html', offset: 1, limit: 40 } }
  const planCall = { id: 'call_visual_plan', name: 'update_plan', arguments: { explanation: 'Implementing and validating the requested site.', plan: [] } }
  const searchCall = { id: 'call_visual_search', name: 'web_search', arguments: { query: 'HTTP status page accessibility guidance', depth: '2' } }
  const fetchCall = { id: 'call_visual_fetch', name: 'fetch_page', arguments: { url: 'https://example.com/missing-guidance', chunkIndex: 0 } }
  const mediaCall = { id: 'call_visual_media', name: 'image_search', arguments: { query: 'calm operations center', count: 1 } }
  const imageCall = { id: 'call_visual_image', name: 'generate_image', arguments: { file_path: 'assets/status-hero.png', prompt: 'A calm geometric operations dashboard hero image' } }
  const previewCall = { id: 'call_visual_preview', name: 'start_process', arguments: { name: 'Website', command: 'npm run dev', cwd: '.', startup_wait: 8 } }
  const deployCall = { id: 'call_visual_deploy', name: 'deploy_project', arguments: {} }
  await store.append(id, 'turn.started', {
    content: 'Build a polished service status page, verify it in the browser, and provide the artifacts.',
    attachments: ['uploads/requirements.md', 'uploads/reference.png'],
  }, { turnId })
  await store.append(id, 'run.status', { status: 'running' }, { turnId })
  await store.append(id, 'assistant.started', { step: 1 }, { turnId, stepId: writeStep })
  await store.append(id, 'assistant.thought.started', { step: 1 }, { turnId, stepId: writeStep })
  await store.append(id, 'assistant.thought.completed', {
    text: 'I will inspect the requirements, create the smallest complete site, then verify the rendered result and console.',
  }, { turnId, stepId: writeStep })
  const initialPlan: PlanState = {
    items: [
      { id: 'plan_visual_build', step: 'Create the status page and supporting files', status: 'in_progress' },
      { id: 'plan_visual_source', step: 'Check the requested public guidance', status: 'pending' },
      { id: 'plan_visual_verify', step: 'Preview and verify the rendered Website', status: 'pending' },
    ],
    explanation: 'Implementing and validating the requested site.',
    updatedAt: '2026-08-28T00:00:04.000Z',
    version: 1,
  }
  await store.append(id, 'tool.started', { call: planCall }, { turnId, stepId: writeStep, callId: planCall.id })
  await store.append(id, 'plan.updated', { plan: initialPlan, explanation: initialPlan.explanation }, { turnId, stepId: writeStep, callId: planCall.id })
  await store.append(id, 'tool.completed', { call: planCall, result: '{"status":"success"}', isError: false }, { turnId, stepId: writeStep, callId: planCall.id })
  await store.append(id, 'tool.started', { call: writeCall }, { turnId, stepId: writeStep, callId: writeCall.id })
  await store.append(id, 'file.changed', { path: 'index.html', bytes: sizes.index, operation: 'written' }, { turnId, stepId: writeStep })
  await store.append(id, 'artifact.created', { artifact: artifacts[0] }, { turnId, stepId: writeStep })
  await store.append(id, 'tool.completed', { call: writeCall, result: `Wrote index.html (${sizes.index} bytes).`, isError: false }, { turnId, stepId: writeStep, callId: writeCall.id })
  await store.append(id, 'tool.started', { call: listCall }, { turnId, stepId: writeStep, callId: listCall.id })
  await store.append(id, 'tool.started', { call: readCall }, { turnId, stepId: writeStep, callId: readCall.id })
  await store.append(id, 'tool.completed', {
    call: readCall,
    result: JSON.stringify({ status: 'success', file: { path: 'index.html', content: '[fixture HTML]', contentType: 'text/html' }, totalLines: 1 }),
    isError: false,
  }, { turnId, stepId: writeStep, callId: readCall.id })
  await store.append(id, 'tool.completed', {
    call: listCall,
    result: JSON.stringify({ status: 'success', files: [{ path: 'data/status.json' }, { path: 'docs/report.md' }, { path: 'index.html' }, { path: 'src/app.js' }] }),
    isError: false,
  }, { turnId, stepId: writeStep, callId: listCall.id })
  await store.append(id, 'assistant.started', { step: 2 }, { turnId, stepId: webStep })
  await store.append(id, 'assistant.thought.started', { step: 2 }, { turnId, stepId: webStep })
  await store.append(id, 'assistant.thought.completed', { text: 'The main artifact is ready. I will read one public source and verify the local Website independently.' }, { turnId, stepId: webStep })
  await store.append(id, 'tool.started', { call: searchCall }, { turnId, stepId: webStep, callId: searchCall.id })
  await store.append(id, 'tool.started', { call: previewCall }, { turnId, stepId: webStep, callId: previewCall.id })
  await store.append(id, 'tool.completed', {
    call: previewCall,
    result: JSON.stringify({ status: 'success', previewUrl: `/workspace/${id}/preview/index.html`, buildLatencyMs: 184 }),
    isError: false,
  }, { turnId, stepId: webStep, callId: previewCall.id })
  await store.append(id, 'tool.completed', {
    call: searchCall,
    result: '{"status":"success","results":[{"id":1,"title":"Guidance","url":"https://example.com/guidance","description":"Accessible status page guidance."}]}',
    isError: false,
  }, { turnId, stepId: webStep, callId: searchCall.id })
  await store.append(id, 'tool.started', { call: fetchCall }, { turnId, stepId: webStep, callId: fetchCall.id })
  await store.append(id, 'tool.failed', { call: fetchCall, result: '{"status":"error","message":"HTTP 404 fetching https://example.com/missing-guidance"}', isError: true }, { turnId, stepId: webStep, callId: fetchCall.id })
  await store.append(id, 'tool.started', { call: mediaCall }, { turnId, stepId: webStep, callId: mediaCall.id })
  await store.append(id, 'tool.completed', {
    call: mediaCall,
    result: '{"status":"success","query":"calm operations center","mediaType":"image","totalResults":42,"results":[{"type":"image","id":814499,"pexelsUrl":"https://www.pexels.com/photo/814499/","recommendedUrl":"https://images.pexels.com/photos/814499/pexels-photo-814499.jpeg","creatorName":"Fixture Photographer"}]}',
    isError: false,
  }, { turnId, stepId: webStep, callId: mediaCall.id })
  await store.append(id, 'tool.started', { call: imageCall }, { turnId, stepId: webStep, callId: imageCall.id })
  await store.append(id, 'file.changed', { path: 'assets/status-hero.png', bytes: sizes.image, operation: 'generated-image' }, { turnId, stepId: webStep, callId: imageCall.id })
  await store.append(id, 'artifact.created', { artifact: artifacts[3] }, { turnId, stepId: webStep, callId: imageCall.id })
  await store.append(id, 'tool.completed', {
    call: imageCall,
    result: '{"status":"success","message":"Generated image and saved it to assets/status-hero.png."}',
    isError: false,
  }, { turnId, stepId: webStep, callId: imageCall.id })
  const activeVerifyPlan: PlanState = {
    ...initialPlan,
    items: [
      { ...initialPlan.items[0], status: 'completed' },
      { ...initialPlan.items[1], status: 'completed' },
      { ...initialPlan.items[2], status: 'in_progress' },
    ],
    explanation: 'The page and source check are complete; verifying the Website now.',
    updatedAt: '2026-08-28T00:00:11.000Z',
    version: 2,
  }
  const planCall2 = { id: 'call_visual_plan_2', name: 'update_plan', arguments: { explanation: activeVerifyPlan.explanation, plan: activeVerifyPlan.items.map(({ step, status }) => ({ step, status })) } }
  await store.append(id, 'tool.started', { call: planCall2 }, { turnId, stepId: webStep, callId: planCall2.id })
  await store.append(id, 'plan.updated', { plan: activeVerifyPlan, explanation: activeVerifyPlan.explanation }, { turnId, stepId: webStep, callId: planCall2.id })
  await store.append(id, 'tool.completed', { call: planCall2, result: '{"status":"success"}', isError: false }, { turnId, stepId: webStep, callId: planCall2.id })
  await store.append(id, 'context.compacted', {
    compactedMessageCount: 18,
    retainedMessageCount: 8,
    beforeBytes: 84529,
    afterBytes: 5141,
    summary: 'Checkpoint preserved the requested status page, completed files, browser verification requirements, and the failed optional source.',
  }, { turnId, stepId: finalStep })
  await store.append(id, 'file.changed', { path: 'docs/report.md', bytes: sizes.report, operation: 'written' }, { turnId, stepId: finalStep })
  await store.append(id, 'artifact.created', { artifact: artifacts[1] }, { turnId, stepId: finalStep })
  await store.append(id, 'file.changed', { path: 'data/status.json', bytes: sizes.data, operation: 'written' }, { turnId, stepId: finalStep })
  await store.append(id, 'artifact.created', { artifact: artifacts[2] }, { turnId, stepId: finalStep })
  await store.append(id, 'file.changed', { path: 'docs/project-brief.docx', bytes: sizes.docx, operation: 'written' }, { turnId, stepId: finalStep })
  await store.append(id, 'artifact.created', { artifact: artifacts[4] }, { turnId, stepId: finalStep })
  await store.append(id, 'file.changed', { path: 'data/readiness.xlsx', bytes: sizes.xlsx, operation: 'written' }, { turnId, stepId: finalStep })
  await store.append(id, 'artifact.created', { artifact: artifacts[5] }, { turnId, stepId: finalStep })
  await store.append(id, 'file.changed', { path: 'slides/review.pptx', bytes: sizes.pptx, operation: 'written' }, { turnId, stepId: finalStep })
  await store.append(id, 'artifact.created', { artifact: artifacts[6] }, { turnId, stepId: finalStep })
  const approvedCall = { id: 'call_visual_approved', name: 'http_request', arguments: { url: 'https://httpbin.org/status/204', method: 'POST', json_body: { probe: 'approved' } } }
  await store.append(id, 'approval.required', { approvalId: 'approval_visual_approved', call: approvedCall, title: 'Approve external request?' }, { turnId, stepId: finalStep, callId: approvedCall.id })
  await store.append(id, 'approval.resolved', { approvalId: 'approval_visual_approved', approved: true, decision: 'approved' }, { turnId, stepId: finalStep, callId: approvedCall.id })
  const deniedCall = { id: 'call_visual_denied', name: 'http_request', arguments: { url: 'https://httpbin.org/status/204', method: 'POST', json_body: { probe: 'denied' } } }
  await store.append(id, 'approval.required', { approvalId: 'approval_visual_denied', call: deniedCall, title: 'Approve external request?' }, { turnId, stepId: finalStep, callId: deniedCall.id })
  await store.append(id, 'approval.resolved', { approvalId: 'approval_visual_denied', approved: false, decision: 'denied' }, { turnId, stepId: finalStep, callId: deniedCall.id })
  const completedPlan: PlanState = {
    ...activeVerifyPlan,
    items: activeVerifyPlan.items.map((item) => ({ ...item, status: 'completed' as const })),
    explanation: 'Implementation and verification are complete.',
    updatedAt: '2026-08-28T00:00:14.000Z',
    version: 3,
  }
  const planCall3 = { id: 'call_visual_plan_3', name: 'update_plan', arguments: { explanation: completedPlan.explanation, plan: completedPlan.items.map(({ step, status }) => ({ step, status })) } }
  await store.append(id, 'tool.started', { call: planCall3 }, { turnId, stepId: finalStep, callId: planCall3.id })
  await store.append(id, 'plan.updated', { plan: completedPlan, explanation: completedPlan.explanation }, { turnId, stepId: finalStep, callId: planCall3.id })
  await store.append(id, 'tool.completed', { call: planCall3, result: '{"status":"success"}', isError: false }, { turnId, stepId: finalStep, callId: planCall3.id })
  const deployment = {
    id: 'dep_visual_status',
    status: 'deployed' as const,
    url: 'https://deploy.example/anera-status/',
    visibility: 'public' as const,
    revision: 2,
    entryPath: 'index.html',
    contentHash: 'a'.repeat(64),
    fileCount: 4,
    bytes: Object.values(sizes).reduce((sum, value) => sum + value, 0),
    createdAt: '2026-08-28T00:00:12.000Z',
    updatedAt: '2026-08-28T00:00:14.500Z',
  }
  await store.append(id, 'tool.started', { call: deployCall }, { turnId, stepId: finalStep, callId: deployCall.id })
  await store.append(id, 'deployment.updated', { deployment: { ...deployment, status: 'building' }, action: 'building' }, { turnId, stepId: finalStep, callId: deployCall.id })
  await store.append(id, 'deployment.updated', { deployment: { ...deployment, status: 'deploying' }, action: 'deploying' }, { turnId, stepId: finalStep, callId: deployCall.id })
  await store.append(id, 'deployment.updated', { deployment, action: 'redeployed' }, { turnId, stepId: finalStep, callId: deployCall.id })
  await store.append(id, 'tool.completed', { call: deployCall, result: '{"status":"success"}', isError: false }, { turnId, stepId: finalStep, callId: deployCall.id })
  await store.append(id, 'assistant.final.delta', { delta: 'Implemented and verified the status page.' }, { turnId, stepId: finalStep })
  const finalEvent = await store.append(id, 'assistant.final', {
    content: 'Implemented and verified the status page.\n\n- **Website:** `index.html`\n- **Report:** `docs/report.md`\n- Browser checks passed at the required desktop width.\n- The optional missing source returned `404`; no facts were invented from it.',
    finishReason: 'stop',
  }, { turnId, stepId: finalStep })
  await store.append(id, 'turn.completed', { status: 'completed', firstTurn: true }, { turnId, stepId: finalStep })
  await store.append(id, 'run.status', { status: 'completed' }, { turnId, stepId: finalStep })
  await store.append(id, 'review.requested', { messageEventId: finalEvent.id, model: MODEL }, { turnId, stepId: finalStep })

  const website: WebsiteState = {
    status: 'running',
    entryPath: 'index.html',
    processId: 'proc_visual_server',
    previewUrl: `/workspace/${id}/preview/index.html`,
    updatedAt: '2026-08-28T00:00:30.000Z',
    restartCount: 1,
  }
  const process: ProcessRecord = {
    id: 'proc_visual_server',
    name: 'ANERA Dev Server V1',
    command: 'npm run dev -- --host 0.0.0.0',
    pid: 4242,
    port: 43123,
    status: 'running',
    startedAt: '2026-08-28T00:00:10.000Z',
    stdout: 'Local: http://localhost:43123/\nready in 182ms\n',
    stderr: '',
  }
  await store.update(id, (state) => {
    state.summary.title = title
    state.summary.model = MODEL
    state.summary.status = 'completed'
    state.summary.lastMessage = 'Build a polished service status page, verify it in the browser, and provide the artifacts.'
    state.summary.workspaceBytes = Object.values(sizes).reduce((sum, value) => sum + value, 0)
    state.summary.usage = usage({ modelCalls: 8, toolCalls: 14, totalTokens: 36130, estimatedCostUsd: 0.00513119, durationMs: 15076 })
    state.plan = completedPlan
    state.artifacts = artifacts
    state.processes = [process]
    state.website = website
    state.deployment = deployment
  })
  return { id, title }
}

function visualArtifact(sessionId: string, path: string, kind: ArtifactRecord['kind'], mime: string): ArtifactRecord {
  const name = path.split('/').at(-1) || path
  return {
    id: `art_visual_${name.replace(/[^a-z0-9]/gi, '_')}`,
    sessionId,
    path,
    name,
    kind,
    mime,
    createdAt: '2026-08-28T00:00:20.000Z',
    previewUrl: kind === 'website'
      ? `/workspace/${sessionId}/preview/${encodeWorkspaceUrlPath(path)}`
      : `/workspace/${sessionId}/file?path=${encodeURIComponent(path)}`,
    downloadUrl: `/api/sessions/${sessionId}/download?path=${encodeURIComponent(path)}`,
  }
}

function emptyUsage(): UsageTotals {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0, estimatedCostUsd: 0, modelCalls: 0, toolCalls: 0 }
}

function usage(input: Pick<UsageTotals, 'modelCalls' | 'toolCalls' | 'totalTokens' | 'estimatedCostUsd' | 'durationMs'>): UsageTotals {
  const completionTokens = Math.round(input.totalTokens * 0.08)
  return {
    promptTokens: input.totalTokens - completionTokens,
    completionTokens,
    totalTokens: input.totalTokens,
    cachedPromptTokens: 0,
    estimatedCostUsd: input.estimatedCostUsd,
    modelCalls: input.modelCalls,
    toolCalls: input.toolCalls,
    startedAt: '2026-08-28T00:00:00.000Z',
    completedAt: '2026-08-28T00:00:15.076Z',
    durationMs: input.durationMs,
  }
}

async function writeOfficeVisualFixture(path: string, entries: Record<string, string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(path)
    const archive = archiver('zip', { zlib: { level: 1 } })
    output.on('close', resolvePromise)
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    for (const [entry, content] of Object.entries(entries)) archive.append(content, { name: entry })
    void archive.finalize()
  })
}
