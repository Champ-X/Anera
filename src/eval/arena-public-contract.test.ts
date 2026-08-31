import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS, type ToolDefinition } from '../server/tools.js'
import { buildArenaAgentSystemPrompt, buildArenaCodingSystemPrompt } from '../server/agent-service.js'
import {
  ARENA_AGENT_PROMPT_TEMPLATE_SHA256,
  ARENA_ACTIVE_AGENT_PROMPT_ANCHORS,
  ARENA_ACTIVE_AGENT_TOOL_NAMES,
  ARENA_PUBLIC_ARGUMENT_SCHEMAS,
  ARENA_PUBLIC_CLIENT_LITERALS,
  ARENA_PUBLIC_COMPLETED_UI_STRINGS,
  ARENA_PUBLIC_CREATE_CHAT_CONTRACT,
  ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT,
  ARENA_PUBLIC_KEY_RESULT_FIELDS,
  ARENA_PUBLIC_PREVIEW_SWITCHER_CONTRACT,
  ARENA_PUBLIC_TASK_REVIEW_CONTRACT,
  ARENA_PUBLIC_TASK_COMPLETION_CONTRACT,
  ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT,
  ARENA_PUBLIC_TOOL_ARGUMENT_FIELDS,
  ARENA_PUBLIC_TOOL_ERROR_EXTENSION_FIELDS,
  ARENA_PUBLIC_TOOL_NAMES,
  ARENA_PUBLIC_UI_STRINGS,
  ARENA_PUBLIC_UNDO_CONTRACT,
  ARENA_PUBLIC_UPLOAD_LIMITS,
  ARENA_PUBLIC_UPLOAD_MIME_TYPES,
  compareArenaPublicContract,
  extractArenaPublicContract,
  extractArenaScriptAssetUrls,
  probeArenaPublicStrings,
  type ArenaPublicArgumentPrimitive,
  type ArenaPublicArgumentSchemaNode,
} from './arena-public-contract.js'

const deployment = 'dpl_ArenaContractFixture123'
const pageUrl = 'https://arena.ai/agent'
const toolAssetUrl = `https://arena.ai/_next/static/chunks/tools.js?dpl=${deployment}`
const uiAssetUrl = `https://arena.ai/_next/static/chunks/page.js?dpl=${deployment}`
const uploadAssetUrl = `https://arena.ai/_next/static/chunks/upload.js?dpl=${deployment}`
const completedPageUrl = 'https://arena.ai/agent/completed-contract-fixture'
const completedAssetUrl = `https://arena.ai/_next/static/chunks/completed.js?dpl=${deployment}`

function toolAsset(extraTool?: string): string {
  const tools = [...ARENA_PUBLIC_TOOL_NAMES, ...(extraTool ? [extraTool] : [])]
  return `webpack.push([1,{100:(e,t,a)=>{let n=a(1);${tools.map((name, index) => {
    const args = ARENA_PUBLIC_ARGUMENT_SCHEMAS[name as keyof typeof ARENA_PUBLIC_ARGUMENT_SCHEMAS] ?? { type: 'object', properties: {} }
    const results = [...(ARENA_PUBLIC_KEY_RESULT_FIELDS[name] ?? ['status']), ...(ARENA_PUBLIC_TOOL_ERROR_EXTENSION_FIELDS[name] ?? [])]
    return `v${index}=s.extend({toolName:n.z.literal(${JSON.stringify(name)}),args:${renderZodSchema(args)},result:n.z.object({${results.map((field) => `${JSON.stringify(field)}:n.z.string()`).join(',')}})});`
  }).join('')}}}]);`
}

function renderZodSchema(node: ArenaPublicArgumentSchemaNode): string {
  let expression: string
  if (node.type === 'object') {
    expression = `n.z.object({${Object.entries(node.properties ?? {}).map(([name, property]) => `${JSON.stringify(name)}:${renderZodSchema(property)}`).join(',')}})`
    if (node.passthrough) expression += '.passthrough()'
  } else if (node.type === 'array') {
    expression = `n.z.array(${renderZodSchema(node.items ?? { type: 'string' })})`
  } else if (node.type === 'enum') {
    expression = `n.z.enum(${JSON.stringify(node.enum ?? [])})`
  } else if (node.type === 'literal') {
    expression = `n.z.literal(${JSON.stringify(node.literal)})`
  } else if (node.type === 'union') {
    expression = 'n.z.union([])'
  } else {
    expression = `n.z.${node.type}()`
  }
  if (node.preprocess === 'number_to_string') expression = `n.z.preprocess(e=>"number"==typeof e?String(e):e,${expression})`
  if (node.default !== undefined) expression += `.default(${JSON.stringify(node.default)})`
  else if (node.optional) expression += '.optional()'
  if (node.catch !== undefined) expression += `.catch(${JSON.stringify(node.catch)})`
  return expression
}

function uiAsset(omit?: string): string {
  const ui = [
    ...Object.values(ARENA_PUBLIC_UI_STRINGS).filter((value) => value !== omit),
    ...Object.values(ARENA_PUBLIC_CLIENT_LITERALS),
  ].map((value) => JSON.stringify(value)).join(',')
  const createChat = 'let i="hello",l=generateSafeUUIDv7(),o=[{url:"/api/chat/workspace/cas/user/hash",mediaType:"image/png",filename:"reference.png",key:"cas/users/id/hash"}],d=o.filter(e=>e.mediaType.startsWith("image/")).map(({url:e,mediaType:t,filename:a})=>({type:"file",url:e,mediaType:t,filename:a})),u=[...d,...i?[{type:"text",text:i}]:[]],m=o.map(({key:e,filename:t,mediaType:a})=>({key:e,filename:t,mediaType:a}));async function submit(){let t=await fetch("/nextjs-api/stream/create-chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:{id:l,role:"user",parts:u,...m.length>0?{metadata:{manifestNodeId:null,uploads:m}}:{}},recaptchaV2Token:null,recaptchaV3Token:null,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,modelId:"model"})});let{id:r}=await t.json();return r}'
  return `${ui};${createChat}`
}

function uploadAsset(mimeTypes: readonly string[] = ARENA_PUBLIC_UPLOAD_MIME_TYPES): string {
  return `let allowed=${JSON.stringify(mimeTypes)},file=${ARENA_PUBLIC_UPLOAD_LIMITS.fileBytes},pdf=0x${ARENA_PUBLIC_UPLOAD_LIMITS.pdfBytes.toString(16)},turn=0x${ARENA_PUBLIC_UPLOAD_LIMITS.turnBytes.toString(16)};async function sha256Base64urlBytes(e){return globalThis.crypto.subtle.digest("SHA-256",e)}async function upload(e){let t=await sha256Base64urlBytes(new Uint8Array(await e.arrayBuffer())),a=e.type,{uploadUrl:r,key:l}=await F.storage["generate-agent-upload-url"].$post({json:{hash:t,contentType:a,size:e.size}}).then(e=>e.json());await fetch(r,{method:"PUT",body:e,headers:{"Content-Type":e.type}});return{key:l,url:\`/api/chat/workspace/cas/user/\${t}\`}};`
}

function completedAsset(): string {
  const strings = [
    ...Object.values(ARENA_PUBLIC_COMPLETED_UI_STRINGS),
    ARENA_PUBLIC_TASK_REVIEW_CONTRACT.questionKey,
  ].map((value) => JSON.stringify(value)).join(',')
  const actions = ARENA_PUBLIC_TASK_REVIEW_CONTRACT.actions
    .map((action) => `{action:${JSON.stringify(action.action)},labelKey:${JSON.stringify(action.labelKey)}}`)
    .join(',')
  const completionActions = ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.actions
    .map((action) => `{value:${JSON.stringify(action.value)},label:${JSON.stringify(action.labelKey)}}`)
    .join(',')
  const undoStrings = Object.values(ARENA_PUBLIC_UNDO_CONTRACT).map((value) => JSON.stringify(value)).join(',')
  const previewViews = ARENA_PUBLIC_PREVIEW_SWITCHER_CONTRACT.views
    .map((view) => `{onClick:()=>t(${JSON.stringify(view.value)}),"aria-pressed":${JSON.stringify(view.value)}===J,"aria-label":${JSON.stringify(view.label)},children:icon}`)
    .join(',')
  const activeRegistry = ARENA_ACTIVE_AGENT_TOOL_NAMES
    .map((name, index) => `${name}:m${index}.def.output`)
    .join(',')
  const promptAnchors = Object.values(ARENA_ACTIVE_AGENT_PROMPT_ANCHORS)
    .map((value) => JSON.stringify(value))
    .join(',')
  const activeContracts = JSON.stringify(ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS.map((definition) => definition.function))
  const customUi = Object.values(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.ui).map((value) => JSON.stringify(value)).join(',')
  return `${strings};${undoStrings};${promptAnchors};${customUi};let active={${activeRegistry}};terminal={status:"aborted"};let activeContracts=${activeContracts};let previewSwitcher=[${previewViews}],sp=[${actions}],tt=[${completionActions}],feedbackType="${ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.feedbackType}",checkInType="${ARENA_PUBLIC_TASK_REVIEW_CONTRACT.feedbackType}",question="${ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.questionKey}",endpoint="${ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.endpointSegment}",container="${ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.containerTestId}",bar="${ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.barTestId}",latestAssistantResponseViewedId=null,requiresReview=true,taskCompletion=null,sessionNodeId=null,recaptchaV3Token=null;if("Escape"===e.key&&_?.("escape"))void 0;let request="check_in"===e.feedback.type?{...t,action:e.feedback.value}:{...t,feedback:e.feedback};transport.sendAction(id,{type:"undo",sessionNodeId,recaptchaV3Token});function makeCustomFeedback(e){return{type:"${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.dataPartType}",data:{systemMessage:"${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker}",...e?{reviewedNodeId:e}:{}}}}function isTrustedCustomFeedback(e){let t=e.providerMetadata;return t?.arena?.systemMessage===!0&&e.text.includes("${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker}")}let customFeedbackArm="control",flags={"${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.featureFlag}":true},resolvedCustomFeedbackArm=flags["${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.featureFlag}"]?customFeedbackArm:null,treatmentOne="${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.arms[0]}",treatmentTwo="${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.arms[1]}",E=true,C="reviewed",telemetry={action:"chat_submit",has_feedback:E},t=" feedback ".trim(),i=[{key:"upload-key",filename:"reference.png",mediaType:"image/png"}],c=i.filter(e=>e.mediaType.startsWith("image/")).map(e=>({type:"file",url:e.url,mediaType:e.mediaType,filename:e.filename})),d=i.length>0,u=E&&C?[makeCustomFeedback(C)]:[],p=t||0===c.length?[{type:"text",text:t}]:[],message=d||E?{parts:[...u,...c,...p],...d?{metadata:{manifestNodeId:null,uploads:i}}:{}}:{text:t},submit={message:message,metadata:{timezone:"UTC",submissionSource:"chat_input"},v2Source:"agentic_chat_submit"},thanks="${ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.text}";if("${ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.excludedArm}"!==customFeedbackArm){V("in");setTimeout(()=>V("out"),2e3);setTimeout(()=>V(null),200)}`
}

function supplementalSource(text = completedAsset()) {
  return {
    pageUrl: completedPageUrl,
    pageHtml: `<html><body><script src="${completedAssetUrl}"></script></body></html>`,
    assets: [{ url: completedAssetUrl, text }],
  }
}

function localClientSource(): string {
  return [
    ...Object.values(ARENA_PUBLIC_UI_STRINGS),
    ...Object.values(ARENA_PUBLIC_COMPLETED_UI_STRINGS),
    ...Object.values(ARENA_PUBLIC_CLIENT_LITERALS),
    ...ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.arms,
    ...Object.values(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.ui),
    ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.reviewedNodeIdField,
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.feedbackType,
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.questionKey,
    ...ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.actions.flatMap((action) => [action.value, action.labelKey]),
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.endpointSegment,
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.containerTestId,
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.barTestId,
    ARENA_PUBLIC_TASK_COMPLETION_CONTRACT.latestViewedKey,
    ...Object.values(ARENA_PUBLIC_UNDO_CONTRACT).filter((value) => value !== 'data-compaction' && value !== 'checkpointApplied'),
    ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.text,
    ARENA_PUBLIC_TASK_COMPLETION_THANK_YOU_CONTRACT.excludedArm,
    `const contextGate = event.type === 'context.compacted'`,
    `setThankYouPhase('in')`,
    `setTimeout(() => setThankYouPhase('out'), 2_000)`,
    `setTimeout(() => setThankYouPhase(null), 200)`,
    `<button aria-label="Preview" aria-pressed={previewMode === 'rendered'} onClick={() => setPreviewMode('rendered')}>icon</button>`,
    `<button aria-label="Raw source" aria-pressed={previewMode === 'source'} onClick={() => setPreviewMode('source')}>icon</button>`,
    `await request('/api/chat/id/review-feedback',{body:JSON.stringify({sessionNodeId,recaptchaV3Token:null,action})})`,
    `await request('/api/chat/id/action',{body:JSON.stringify({type:'undo',sessionNodeId,recaptchaV3Token:null})})`,
    `const ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE = '${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker}'`,
    `function arenaAgentMessageTransport(sessionId, content, attachments, reviewedNodeId, timezone) { const text = content.trim(); const uploads = attachments.map(attachment => ({ key: attachment.path, filename: attachment.name, mediaType: attachment.mime })); const imageParts = uploads.filter(upload => upload.mediaType.startsWith('image/')).map(upload => ({ type: 'file', url: upload.key, mediaType: upload.mediaType, filename: upload.filename })); const customFeedbackParts = reviewedNodeId ? [{ type: 'data-custom-feedback', data: { systemMessage: ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE, reviewedNodeId } }] : []; const textParts = text || imageParts.length === 0 ? [{ type: 'text', text }] : []; const message = uploads.length > 0 || reviewedNodeId ? { parts: [...customFeedbackParts, ...imageParts, ...textParts], ...(uploads.length > 0 ? { metadata: { manifestNodeId: null, uploads } } : {}) } : { text }; return { message, metadata: { timezone, submissionSource: 'chat_input' }, v2Source: 'agentic_chat_submit' } }`,
    `function generateUuidV7() { bytes[6] = (bytes[6] & 0x0f) | 0x70; bytes[8] = (bytes[8] & 0x3f) | 0x80; return id } const UUID_V7_PATTERN = /uuid-v7/`,
    `async function createAgentChat(text, imageParts, uploads, modelId, timezone) { const parts = [ ...imageParts, ...(text ? [{ type: 'text', text }] : []) ]; const result = await request('/nextjs-api/stream/create-chat', { method: 'POST', body: JSON.stringify({ message: { id: generateUuidV7(), role: 'user', parts, ...(uploads.length ? { metadata: { manifestNodeId: null, uploads } } : {}) }, recaptchaV3Token: null, timezone, ...(modelId ? { modelId } : {}) }) }); return result.id } app.post('/nextjs-api/stream/create-chat', async () => { const allowedBodyKeys = ['message', 'recaptchaV2Token', 'recaptchaV3Token', 'timezone', 'modelId']; response.status(200).json({ id: session.summary.id }); const orderA = 'create-chat file parts must precede text'; const orderB = 'create-chat text must be the last message part' })`,
    `async function uploadAgentFile(file) { const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer()); const encoded = value.replaceAll('+', '-').replaceAll('/', '_'); const signed = await fetch('/api/storage/generate-agent-upload-url', { method: 'POST', body: JSON.stringify({ hash, contentType: file.type, size: file.size }) }).then(response => response.json()); const { uploadUrl, key } = signed; await fetch(uploadUrl, { method: 'PUT', body: file }); return { key, url: \`/api/chat/workspace/cas/user/\${hash}\` } } app.post('/api/storage/generate-agent-upload-url', () => {}); app.get('/api/chat/workspace/cas/user/:hash', () => {})`,
  ].join('\n')
}

function pageHtml(): string {
  return `<html><body><script src="${new URL(toolAssetUrl).pathname}?dpl=${deployment}"></script><script src="${uiAssetUrl.replaceAll('&', '&amp;')}"></script><script src="${uploadAssetUrl}"></script></body></html>`
}

function assets(options: { extraTool?: string; omittedUi?: string; mimeTypes?: readonly string[] } = {}) {
  return [
    { url: toolAssetUrl, text: toolAsset(options.extraTool) },
    { url: uiAssetUrl, text: uiAsset(options.omittedUi) },
    { url: uploadAssetUrl, text: uploadAsset(options.mimeTypes) },
  ]
}

function localDefinitions(): ToolDefinition[] {
  const names = [...new Set([...ARENA_PUBLIC_TOOL_NAMES, ...ARENA_ACTIVE_AGENT_TOOL_NAMES])]
  return names.map((name) => ({
    type: 'function',
    function: {
      name,
      description: name,
      parameters: name in ARENA_PUBLIC_ARGUMENT_SCHEMAS
        ? renderJsonSchema(ARENA_PUBLIC_ARGUMENT_SCHEMAS[name as keyof typeof ARENA_PUBLIC_ARGUMENT_SCHEMAS])
        : { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  }))
}

function localAgentSource(): string {
  return [
    ...Object.values(ARENA_ACTIVE_AGENT_PROMPT_ANCHORS),
    `export function projectArenaCustomFeedbackMessageForModel() { const marker = ARENA_CUSTOM_FEEDBACK_SYSTEM_MESSAGE; return marker + projectArenaUserMessageForModel() }`,
    ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker,
    ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.telemetryField,
    `arena_system_messages: [ ...(reviewedNodeId ? [{ kind: 'custom_feedback', position: 'leading', reviewedNodeId }] : []), ...(attachments.length ? [{ kind: 'attachments', position: 'trailing' }] : []) ]`,
  ].join('\n')
}

function localPromptProjections() {
  const common = {
    date: new Date('2026-08-30T00:00:00.000Z'),
    timezone: 'UTC',
    includeProcessTools: false,
    includePlanning: false,
    includeConnectors: false,
  } as const
  const coding = {
    ...common,
    repoOwner: 'arena-labs',
    repoName: 'harness',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    arenaBranch: 'arena/contract-session',
    cwd: '/home/user',
  }
  return {
    agent: buildArenaAgentSystemPrompt(common),
    codingActive: buildArenaCodingSystemPrompt({ ...coding, sessionStatus: 'active' }),
    codingClosed: buildArenaCodingSystemPrompt({ ...coding, sessionStatus: 'closed' }),
  }
}

function stringSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderJsonSchema(node: ArenaPublicArgumentSchemaNode): Record<string, unknown> {
  const optionalDefault = node.default !== undefined ? { default: node.default } : {}
  if (node.type === 'object') {
    const properties = node.properties ?? {}
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, renderJsonSchema(property)])),
      required: Object.entries(properties).filter(([, property]) => !property.optional).map(([name]) => name),
      additionalProperties: node.passthrough === true,
      ...optionalDefault,
    }
  }
  if (node.type === 'array') return { type: 'array', items: renderJsonSchema(node.items ?? { type: 'string' }), ...optionalDefault }
  if (node.type === 'enum') return { type: primitiveType(node.enum?.[0]), enum: node.enum, ...optionalDefault }
  if (node.type === 'literal') return { type: primitiveType(node.literal), enum: [node.literal], ...optionalDefault }
  return { type: node.type, ...optionalDefault }
}

function primitiveType(value: ArenaPublicArgumentPrimitive | undefined): string {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'string'
}

describe('Arena public contract audit', () => {
  it('extracts script URLs, the tool/schema surface, UI copy, upload limits, and deployment without network access', () => {
    expect(extractArenaScriptAssetUrls(pageHtml(), pageUrl)).toEqual([toolAssetUrl, uiAssetUrl, uploadAssetUrl])
    const snapshot = extractArenaPublicContract(pageUrl, pageHtml(), assets())
    expect(snapshot.deploymentId).toBe(deployment)
    expect(snapshot.schemaVersion).toBe(15)
    expect(snapshot.supplementalPages).toEqual([])
    expect(snapshot.toolSchemaAsset).toBe(toolAssetUrl)
    expect(snapshot.activeAgentToolRegistryAsset).toBeUndefined()
    expect(snapshot.activeAgentToolNames).toEqual([])
    expect(snapshot.toolNames).toEqual(ARENA_PUBLIC_TOOL_NAMES)
    expect(snapshot.toolArgumentFields.grep_files).toEqual(ARENA_PUBLIC_TOOL_ARGUMENT_FIELDS.grep_files)
    expect(snapshot.toolArgumentSchemas).toEqual(ARENA_PUBLIC_ARGUMENT_SCHEMAS)
    expect(snapshot.keyResultFields.build_and_start).toEqual(ARENA_PUBLIC_KEY_RESULT_FIELDS.build_and_start)
    expect(snapshot.keyResultFields.fetch_media).toEqual(ARENA_PUBLIC_KEY_RESULT_FIELDS.fetch_media)
    expect(Object.values(snapshot.uiStrings).every((entry) => entry.present)).toBe(true)
    expect(Object.values(snapshot.clientLiterals).every((entry) => entry.present)).toBe(true)
    expect(snapshot.upload).toEqual({
      sourceAsset: uploadAssetUrl,
      allowedMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      ...ARENA_PUBLIC_UPLOAD_LIMITS,
    })
    expect(Object.values(snapshot.createChatTransport.newChat).every((entry) => entry.present)).toBe(true)
    expect(Object.values(snapshot.createChatTransport.signedUpload).every((entry) => entry.present)).toBe(true)
    expect(Object.values(snapshot.createChatTransport.existingTurn).every((entry) => !entry.present)).toBe(true)
  })

  it('parses quoted whole-prompt assignments without evaluating bundle code', () => {
    const promptAssetUrl = `https://arena.ai/_next/static/chunks/prompts.js?dpl=${deployment}`
    const promptAsset = {
      url: promptAssetUrl,
      text: 'x.SYSTEM_PROMPT_TEMPLATE="line\\nquote \\"ok\\"";x.CODING_SYSTEM_PROMPT_TEMPLATE=\'coding\\nbranch\';x.CODING_CLOSED_SESSION_GUIDANCE=\'user\\\'s local work\';',
    }
    const snapshot = extractArenaPublicContract(pageUrl, pageHtml(), [...assets(), promptAsset])
    expect(snapshot.promptTemplates).toMatchObject({
      agent: { present: true, asset: promptAssetUrl, length: 15, sha256: stringSha256('line\nquote "ok"') },
      coding: { present: true, asset: promptAssetUrl, length: 13, sha256: stringSha256('coding\nbranch') },
      codingClosedGuidance: { present: true, asset: promptAssetUrl, length: 17, sha256: stringSha256("user's local work") },
    })
  })

  it('gates frozen whole-template evidence and deterministic local Agent/Coding projections independently', () => {
    const snapshot = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource()],
    })
    const promptProjections = localPromptProjections()
    snapshot.promptTemplates = {
      agent: { identifier: 'SYSTEM_PROMPT_TEMPLATE', present: true, sha256: ARENA_AGENT_PROMPT_TEMPLATE_SHA256.agent },
      coding: { identifier: 'CODING_SYSTEM_PROMPT_TEMPLATE', present: true, sha256: ARENA_AGENT_PROMPT_TEMPLATE_SHA256.coding },
      codingClosedGuidance: { identifier: 'CODING_CLOSED_SESSION_GUIDANCE', present: true, sha256: ARENA_AGENT_PROMPT_TEMPLATE_SHA256.codingClosedGuidance },
      projections: {
        agentSha256: stringSha256(promptProjections.agent),
        codingActiveSha256: stringSha256(promptProjections.codingActive),
        codingClosedSha256: stringSha256(promptProjections.codingClosed),
      },
    }
    const local = {
      toolDefinitions: localDefinitions(),
      activeToolDefinitions: ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS,
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
      promptProjections,
    }
    expect(compareArenaPublicContract(snapshot, local)).toMatchObject({
      liveAgentPromptTemplateMismatches: [],
      localAgentPromptProjectionMismatches: [],
    })

    const liveDrift = structuredClone(snapshot)
    liveDrift.promptTemplates.coding.sha256 = '0'.repeat(64)
    expect(compareArenaPublicContract(liveDrift, local).liveAgentPromptTemplateMismatches).toEqual([
      `coding:${'0'.repeat(64)}!=${ARENA_AGENT_PROMPT_TEMPLATE_SHA256.coding}`,
    ])

    const localDrift = structuredClone(local)
    localDrift.promptProjections.codingClosed += '\nchanged'
    expect(compareArenaPublicContract(snapshot, localDrift).localAgentPromptProjectionMismatches).toEqual([
      expect.stringMatching(/^codingClosed:/),
    ])
  })

  it('passes only when the live evidence and local public projection both match the frozen contract', () => {
    const snapshot = extractArenaPublicContract(pageUrl, pageHtml(), assets())
    const diff = compareArenaPublicContract(snapshot, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
    })
    expect(diff).toMatchObject({ passed: true, issues: [] })
    expect(diff).toMatchObject({
      activeAgentToolsMissingLocally: [],
      expectedActiveAgentToolsMissingPublicly: [],
      unexpectedActiveAgentTools: [],
      missingLiveActiveAgentPromptEvidence: [],
      activeAgentPromptAnchorsMissingLocally: [],
    })
  })

  it('gates New Chat, signed upload, UUIDv7, CAS, and existing-turn branch drift independently', () => {
    const baseAssets = assets()
    const createEndpointDrift = structuredClone(baseAssets)
    createEndpointDrift[1].text = createEndpointDrift[1].text.replace(
      ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.endpoint,
      '/nextjs-api/stream/legacy-create-chat',
    )
    const createEndpointDiff = compareArenaPublicContract(
      extractArenaPublicContract(pageUrl, pageHtml(), createEndpointDrift),
      {
        toolDefinitions: localDefinitions(),
        uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
        uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
        clientSource: localClientSource(),
      },
    )
    expect(createEndpointDiff.passed).toBe(false)
    expect(createEndpointDiff.missingLiveCreateChatTransportEvidence).toContain(
      `endpoint:${ARENA_PUBLIC_CREATE_CHAT_CONTRACT.newChat.endpoint}`,
    )

    const uploadPutDrift = structuredClone(baseAssets)
    uploadPutDrift[2].text = uploadPutDrift[2].text.replace('method:"PUT"', 'method:"POST"')
    const uploadPutDiff = compareArenaPublicContract(
      extractArenaPublicContract(pageUrl, pageHtml(), uploadPutDrift),
      {
        toolDefinitions: localDefinitions(),
        uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
        uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
        clientSource: localClientSource(),
      },
    )
    expect(uploadPutDiff.passed).toBe(false)
    expect(uploadPutDiff.missingLiveSignedUploadTransportEvidence).toContain('binaryUploadMethod:PUT')

    const completedSnapshot = extractArenaPublicContract(pageUrl, pageHtml(), baseAssets, {
      supplementalSources: [supplementalSource()],
    })
    const localUuidDiff = compareArenaPublicContract(completedSnapshot, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource().replace('id: generateUuidV7()', 'id: generateLegacyUuid()'),
      agentSource: localAgentSource(),
    })
    expect(localUuidDiff.passed).toBe(false)
    expect(localUuidDiff.createChatTransportMissingLocally).toContain('messageId:UUIDv7')

    const localCasDiff = compareArenaPublicContract(completedSnapshot, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource().replaceAll('/api/chat/workspace/cas/user/', '/api/chat/workspace/files/'),
      agentSource: localAgentSource(),
    })
    expect(localCasDiff.passed).toBe(false)
    expect(localCasDiff.signedUploadTransportMissingLocally).toContain(
      `casUserPath:${ARENA_PUBLIC_CREATE_CHAT_CONTRACT.signedUpload.casUserPath}`,
    )

    const existingEnvelopeDrift = extractArenaPublicContract(pageUrl, pageHtml(), baseAssets, {
      supplementalSources: [supplementalSource(completedAsset().replace('v2Source:"agentic_chat_submit"', 'legacySource:"agentic_chat_submit"'))],
    })
    const existingEnvelopeDiff = compareArenaPublicContract(existingEnvelopeDrift, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
    })
    expect(existingEnvelopeDiff.passed).toBe(false)
    expect(existingEnvelopeDiff.missingLiveExistingTurnTransportEvidence).toEqual(expect.arrayContaining([
      'v2Source:agentic_chat_submit',
      'branchDistinct:existing turn envelope only',
    ]))
  })

  it('reports completed-route active registry, prompt-evidence, and local implementation drift independently', () => {
    const changedCompletedAsset = completedAsset()
      .replace('add_voice:m0.def.output,', '')
      .replace('write_file:m18.def.output', 'write_file:m18.def.output,new_active_tool:m99.def.output')
      .replace(ARENA_ACTIVE_AGENT_PROMPT_ANCHORS.previewSandbox, 'changed preview contract')
    const snapshot = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource(changedCompletedAsset)],
    })
    const definitions = localDefinitions().filter((tool) => tool.function.name !== 'ask_user')
    const diff = compareArenaPublicContract(snapshot, {
      toolDefinitions: definitions,
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource().replace(ARENA_ACTIVE_AGENT_PROMPT_ANCHORS.trustedContextTag, ''),
    })

    expect(diff.passed).toBe(false)
    expect(diff.activeAgentToolsMissingLocally).toContain('ask_user')
    expect(diff.expectedActiveAgentToolsMissingPublicly).toContain('add_voice')
    expect(diff.unexpectedActiveAgentTools).toContain('new_active_tool')
    expect(diff.missingLiveActiveAgentPromptEvidence).toContain(
      `previewSandbox:${ARENA_ACTIVE_AGENT_PROMPT_ANCHORS.previewSandbox}`,
    )
    expect(diff.activeAgentPromptAnchorsMissingLocally).toContain(
      `trustedContextTag:${ARENA_ACTIVE_AGENT_PROMPT_ANCHORS.trustedContextTag}`,
    )
  })

  it('gates live and local active schemas and descriptions independently', () => {
    const target = ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS.find((definition) => definition.function.name === 'list_connector_tools')!
    const escapedDescription = JSON.stringify(target.function.description).slice(1, -1)
    const liveDrift = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource(completedAsset().replace(escapedDescription, 'changed connector description'))],
    })
    const liveDiff = compareArenaPublicContract(liveDrift, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
    })
    expect(liveDiff.liveActiveAgentDescriptionMismatches).toContain('list_connector_tools')

    const localActive = structuredClone(ARENA_ACTIVE_AGENT_TOOL_DEFINITIONS)
    const localTarget = localActive.find((definition) => definition.function.name === 'list_connector_tools')!
    localTarget.function.description = 'Changed locally.'
    const service = (localTarget.function.parameters as { properties: Record<string, Record<string, unknown>> }).properties.service
    service.maxLength = 99
    const stableSnapshot = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource()],
    })
    const localDiff = compareArenaPublicContract(stableSnapshot, {
      toolDefinitions: localDefinitions(),
      activeToolDefinitions: localActive,
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
    })
    expect(localDiff.localActiveAgentSchemaMismatches).toContain('list_connector_tools')
    expect(localDiff.localActiveAgentDescriptionMismatches).toContain('list_connector_tools')
  })

  it('reports live and local argument-schema drift even when field names still match', () => {
    const liveAssets = assets()
    liveAssets[0] = {
      ...liveAssets[0],
      text: liveAssets[0].text.replace('"offset":n.z.number().optional()', '"offset":n.z.string().optional()'),
    }
    const snapshot = extractArenaPublicContract(pageUrl, pageHtml(), liveAssets)
    const definitions = localDefinitions()
    const readFile = definitions.find((definition) => definition.function.name === 'read_file')
    const properties = (readFile?.function.parameters as { properties?: Record<string, Record<string, unknown>> }).properties
    if (properties) properties.limit = { type: 'string' }
    const diff = compareArenaPublicContract(snapshot, {
      toolDefinitions: definitions,
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
    })
    expect(diff.passed).toBe(false)
    expect(diff.liveArgumentSchemaMismatches.map((entry) => entry.tool)).toContain('read_file')
    expect(diff.localPublicToolArgumentSchemaMismatches.map((entry) => entry.tool)).toContain('read_file')
  })

  it('reports an unmapped tool, missing UI evidence, and upload drift independently', () => {
    const changedMimes = ARENA_PUBLIC_UPLOAD_MIME_TYPES.filter((value) => value !== 'text/csv')
    const snapshot = extractArenaPublicContract(pageUrl, pageHtml(), assets({
      extraTool: 'new_public_tool',
      omittedUi: ARENA_PUBLIC_UI_STRINGS.disconnectGithub,
      mimeTypes: changedMimes,
    }))
    const diff = compareArenaPublicContract(snapshot, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
    })
    expect(diff.passed).toBe(false)
    expect(diff.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('Unmapped live Arena tools: new_public_tool'),
      expect.stringContaining('Frozen public UI strings absent from live assets: Disconnect GitHub'),
      expect.stringContaining('live upload MIME allowlist differs'),
    ]))
  })

  it('returns bounded public-bundle context without treating a candidate string as a frozen contract', () => {
    const probes = probeArenaPublicStrings(pageUrl, pageHtml(), assets(), [
      ARENA_PUBLIC_UI_STRINGS.askAnything,
      'candidate that is not public evidence',
      ARENA_PUBLIC_UI_STRINGS.askAnything,
    ], { contextCharacters: 24, snippetsPerAsset: 1 })
    expect(probes).toHaveLength(2)
    expect(probes[0]).toMatchObject({
      value: ARENA_PUBLIC_UI_STRINGS.askAnything,
      present: true,
      hits: [{ asset: uiAssetUrl, occurrences: 1 }],
    })
    expect(probes[0].hits[0].snippets).toHaveLength(1)
    expect(probes[0].hits[0].snippets[0]).toContain(`⟦${ARENA_PUBLIC_UI_STRINGS.askAnything}⟧`)
    expect(probes[1]).toEqual({
      value: 'candidate that is not public evidence',
      present: false,
      hits: [],
    })
  })

  it('gates completed-route copy and the task-review action mapping only when supplemental evidence is supplied', () => {
    const snapshot = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource()],
    })
    expect(snapshot.supplementalPages).toEqual([{
      pageUrl: completedPageUrl,
      scriptAssets: [completedAssetUrl],
    }])
    expect(Object.values(snapshot.completedUiStrings).every((entry) => entry.present)).toBe(true)
    expect(snapshot.previewSwitcherContract.views).toEqual([
      { value: 'preview', label: 'Preview', present: true, assets: [completedAssetUrl] },
      { value: 'raw', label: 'Raw source', present: true, assets: [completedAssetUrl] },
    ])
    expect(snapshot.taskReviewContract).toMatchObject({
      feedbackType: { value: 'check_in', present: true },
      questionKey: { value: 'Was this task successful?', present: true },
      actions: [
        { action: 'approve', labelKey: 'Yes', present: true },
        { action: 'disapprove', labelKey: 'No', present: true },
        { action: 'edit', labelKey: 'Keep working', present: true },
      ],
      dismissAction: { value: 'escape', present: true },
      endpointSegment: { value: 'review-feedback', present: true },
      sessionNodeIdField: { value: 'sessionNodeId', present: true },
      recaptchaTokenField: { value: 'recaptchaV3Token', present: true },
      requestActionField: { value: 'action', present: true },
    })
    expect(snapshot.schemaVersion).toBe(15)
    expect(snapshot.activeAgentToolRegistryAsset).toBe(completedAssetUrl)
    expect(snapshot.activeAgentToolNames).toEqual(ARENA_ACTIVE_AGENT_TOOL_NAMES)
    expect(Object.values(snapshot.activeAgentToolContracts).every((contract) => (
      contract.schemaSha256 && contract.descriptionSha256
      && contract.missingSchemaEvidence.length === 0
      && contract.missingDescriptionEvidence.length === 0
    ))).toBe(true)
    expect(Object.values(snapshot.activeAgentPromptAnchors).every((entry) => entry.present)).toBe(true)
    expect(Object.values(snapshot.createChatTransport.existingTurn).every((entry) => entry.present)).toBe(true)
    expect(snapshot.taskCompletionContract).toMatchObject({
      feedbackType: { value: 'task_completion_bar', present: true },
      questionKey: { value: 'Does this complete your task?', present: true },
      actions: [
        { value: 'no', labelKey: 'No', present: true },
        { value: 'making_progress', labelKey: 'Making progress', present: true },
        { value: 'yes', labelKey: 'Yes', present: true },
      ],
      endpointSegment: { value: 'review-feedback', present: true },
      containerTestId: { value: 'task-completion-bar-container', present: true },
      barTestId: { value: 'task-completion-bar', present: true },
      latestViewedKey: { value: 'latestAssistantResponseViewedId', present: true },
      requiresReviewKey: { value: 'requiresReview', present: true },
      feedbackMetadataKey: { value: 'taskCompletion', present: true },
    })
    expect(snapshot.undoContract).toMatchObject({
      actionType: { value: 'undo', present: true },
      question: { value: 'Do you want to undo the last turn?', present: true },
      actionLabel: { value: 'Undo', present: true },
      undoStatus: { value: 'Undoing last turn...', present: true },
      failureMessage: { value: 'Failed to undo message', present: true },
      sessionNodeIdField: { value: 'sessionNodeId', present: true },
      recaptchaTokenField: { value: 'recaptchaV3Token', present: true },
      compactionType: { value: 'data-compaction', present: true },
      checkpointAppliedField: { value: 'checkpointApplied', present: true },
    })
    expect(snapshot.taskCompletionThankYouContract).toMatchObject({
      text: { value: 'Thank you for your feedback!', present: true },
      phases: [
        { value: 'in', present: true },
        { value: 'out', present: true },
      ],
      visibleMs: { value: 2_000, present: true },
      exitMs: { value: 200, present: true },
      excludedArm: { value: 'treatment-2', present: true },
    })
    expect(snapshot.customFeedbackContract).toMatchObject({
      featureFlag: { value: 'agentic-custom-feedback', present: true },
      arms: [
        { value: 'treatment-1', present: true },
        { value: 'treatment-2', present: true },
      ],
      dataPartType: { value: 'data-custom-feedback', present: true },
      systemMessageField: { value: 'systemMessage', present: true },
      reviewedNodeIdField: { value: 'reviewedNodeId', present: true },
      marker: { value: ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker, present: true },
      telemetryField: { value: 'has_feedback', present: true },
      providerMetadataRecognition: { value: 'providerMetadata.arena.systemMessage===true', present: true },
      leadingPartOrder: { value: 'custom-feedback → files → user text', present: true },
      ui: {
        calloutQuestion: { value: 'Provide your feedback?', present: true },
        giveFeedback: { value: 'Give feedback', present: true },
        dismiss: { value: 'Dismiss', present: true },
        chipLabel: { value: 'Feedback', present: true },
        placeholder: { value: 'Give feedback on this task', present: true },
      },
    })
    expect(compareArenaPublicContract(snapshot, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
    })).toMatchObject({ passed: true, issues: [] })

    const drifted = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource(completedAsset().replace('action:"disapprove",labelKey:"No"', 'action:"changed",labelKey:"No"'))],
    })
    const diff = compareArenaPublicContract(drifted, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
    })
    expect(diff.passed).toBe(false)
    expect(diff.missingLiveTaskReviewContractEvidence).toContain('action:disapprove/No')

    const transportDrift = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource(completedAsset().replace('action:e.feedback.value', 'decision:e.feedback.value'))],
    })
    const transportDiff = compareArenaPublicContract(transportDrift, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
    })
    expect(transportDiff.passed).toBe(false)
    expect(transportDiff.missingLiveTaskReviewContractEvidence).toContain('request:action')

    const localTransportDiff = compareArenaPublicContract(snapshot, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource().replace('/review-feedback', '/legacy-review'),
      agentSource: localAgentSource(),
    })
    expect(localTransportDiff.passed).toBe(false)
    expect(localTransportDiff.taskReviewContractMissingLocally).toHaveLength(1)

    const completionDrift = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource(completedAsset().replace('value:"making_progress",label:"Making progress"', 'value:"partial",label:"Making progress"'))],
    })
    const completionDiff = compareArenaPublicContract(completionDrift, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
    })
    expect(completionDiff.passed).toBe(false)
    expect(completionDiff.missingLiveTaskCompletionContractEvidence).toContain('action:making_progress/Making progress')

    const undoDrift = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource(completedAsset().replace('type:"undo"', 'type:"legacy_undo"'))],
    })
    const undoDiff = compareArenaPublicContract(undoDrift, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
    })
    expect(undoDiff.passed).toBe(false)
    expect(undoDiff.missingLiveUndoContractEvidence).toEqual(expect.arrayContaining([
      'actionType:undo',
      'sessionNodeIdField:sessionNodeId',
      'recaptchaTokenField:recaptchaV3Token',
    ]))

    const thankYouDrift = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource(completedAsset().replace('setTimeout(()=>V("out"),2e3)', 'setTimeout(()=>V("out"),3e3)'))],
    })
    const thankYouDiff = compareArenaPublicContract(thankYouDrift, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
    })
    expect(thankYouDiff.passed).toBe(false)
    expect(thankYouDiff.missingLiveTaskCompletionThankYouEvidence).toEqual(expect.arrayContaining(['phase:out', 'visibleMs:2000']))

    const previewDrift = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource(completedAsset().replace('"aria-label":"Raw source"', '"aria-label":"Source"'))],
    })
    const previewDiff = compareArenaPublicContract(previewDrift, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
    })
    expect(previewDiff.passed).toBe(false)
    expect(previewDiff.missingLivePreviewSwitcherEvidence).toContain('raw/Raw source')

    const localPreviewDiff = compareArenaPublicContract(snapshot, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource().replace('aria-label="Raw source"', 'aria-label="Source"'),
      agentSource: localAgentSource(),
    })
    expect(localPreviewDiff.passed).toBe(false)
    expect(localPreviewDiff.previewSwitcherMissingLocally).toContain('raw/Raw source')

    const customFeedbackLiveDrift = extractArenaPublicContract(pageUrl, pageHtml(), assets(), {
      supplementalSources: [supplementalSource(completedAsset()
        .replaceAll(ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker, 'Changed feedback marker.')
        .replace('parts:[...u,...c,...p]', 'parts:[...c,...u,...p]'))],
    })
    const customFeedbackLiveDiff = compareArenaPublicContract(customFeedbackLiveDrift, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource(),
      agentSource: localAgentSource(),
    })
    expect(customFeedbackLiveDiff.passed).toBe(false)
    expect(customFeedbackLiveDiff.missingLiveCustomFeedbackContractEvidence).toEqual(expect.arrayContaining([
      `marker:${ARENA_PUBLIC_CUSTOM_FEEDBACK_CONTRACT.marker}`,
      'partOrder:custom-feedback → files → user text',
    ]))

    const customFeedbackLocalDiff = compareArenaPublicContract(snapshot, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource().replace('Give feedback on this task', 'Legacy feedback prompt'),
      agentSource: localAgentSource().replace("kind: 'custom_feedback'", "kind: 'legacy_feedback'"),
    })
    expect(customFeedbackLocalDiff.passed).toBe(false)
    expect(customFeedbackLocalDiff.customFeedbackContractMissingLocally).toEqual(expect.arrayContaining([
      'ui.placeholder:Give feedback on this task',
      'partOrder:custom-feedback → files → user text',
    ]))

    const customFeedbackTransportLocalDiff = compareArenaPublicContract(snapshot, {
      toolDefinitions: localDefinitions(),
      uploadMimeTypes: ARENA_PUBLIC_UPLOAD_MIME_TYPES,
      uploadLimits: ARENA_PUBLIC_UPLOAD_LIMITS,
      clientSource: localClientSource().replace("v2Source: 'agentic_chat_submit'", "v2Source: 'legacy_submit'"),
      agentSource: localAgentSource(),
    })
    expect(customFeedbackTransportLocalDiff.passed).toBe(false)
    expect(customFeedbackTransportLocalDiff.customFeedbackContractMissingLocally).toContain(
      'requestTransport:message.parts + metadata.submissionSource=chat_input + v2Source=agentic_chat_submit',
    )
  })
})
