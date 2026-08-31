import archiver from 'archiver'

const base = process.env.ANERA_BASE_URL || 'http://127.0.0.1:4174'
const workbook = await zipBuffer({
  'xl/workbook.xml': `
    <workbook xmlns:r="urn:r"><sheets>
      <sheet name="Data &amp; Inputs" sheetId="1" r:id="rIdData"/>
      <sheet name="Summary" sheetId="2" r:id="rIdSummary"/>
    </sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `
    <Relationships>
      <Relationship Id="rIdSummary" Target="worksheets/sheet10.xml"/>
      <Relationship Id="rIdData" Target="worksheets/sheet2.xml"/>
    </Relationships>`,
  'xl/sharedStrings.xml': '<sst><si><t>Quarter</t></si><si><t>Q1</t></si><si><t>Q2</t></si></sst>',
  'xl/worksheets/sheet2.xml': `
    <worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row>
      <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>120</v></c></row>
      <row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><v>150</v></c></row>
    </sheetData></worksheet>`,
  'xl/worksheets/sheet10.xml': `
    <worksheet><sheetData><row r="1">
      <c r="A1" t="inlineStr"><is><t>Total</t></is></c>
      <c r="B1"><f>SUM('Data &amp; Inputs'!B2:B3)</f><v>270</v></c>
    </row></sheetData></worksheet>`,
})

const createResponse = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
if (!createResponse.ok) throw new Error(`create session failed: ${createResponse.status}`)
const sessionId = (await createResponse.json()).session.id
const uploadResponse = await fetch(`${base}/api/sessions/${sessionId}/files`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'quarterly-input.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: workbook.toString('base64') }),
})
if (!uploadResponse.ok) throw new Error(`upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`)
const uploaded = await uploadResponse.json()
const submitResponse = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    attachments: [uploaded.path],
    content: '只使用我上传的 XLSX，不要联网、不要使用 Bash、不要创建文件。读取两个工作表并用三行回答：第一行给出两个 sheet 名；第二行给出 Q1 和 Q2 数值；第三行给出 Summary 中 Total 的值和公式。不要猜测。',
  }),
})
if (!submitResponse.ok) throw new Error(`submit failed: ${submitResponse.status} ${await submitResponse.text()}`)

let snapshot
for (let attempt = 0; attempt < 240; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  const response = await fetch(`${base}/api/sessions/${sessionId}`)
  if (!response.ok) throw new Error(`snapshot failed: ${response.status}`)
  snapshot = await response.json()
  if (['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.session.status)) break
}
if (!snapshot || snapshot.session.status !== 'completed') throw new Error(`Office attachment task ended as ${snapshot?.session?.status || 'timeout'}`)
const completedTools = snapshot.events
  .filter((event) => event.type === 'tool.completed')
  .map((event) => event.data?.call?.name)
const startedTools = snapshot.events
  .filter((event) => event.type === 'tool.started')
  .map((event) => event.data?.call?.name)
const final = snapshot.events.findLast((event) => event.type === 'assistant.final')?.data?.content || ''
if (!completedTools.includes('extract_attachment')) throw new Error(`extract_attachment did not complete: ${JSON.stringify(startedTools)}`)
if (startedTools.some((name) => name === 'web_fetch' || name === 'web_search' || name === 'search_web' || name === 'bash')) throw new Error(`Agent violated the local-only constraint: ${JSON.stringify(startedTools)}`)
for (const expected of ['Data & Inputs', 'Summary', 'Q1', '120', 'Q2', '150', '270', 'SUM']) {
  if (!final.includes(expected)) throw new Error(`Final missed ${expected}: ${final}`)
}
console.log(JSON.stringify({
  sessionId,
  status: snapshot.session.status,
  workbookBytes: workbook.length,
  tools: startedTools,
  modelCalls: snapshot.session.usage.modelCalls,
  toolCalls: snapshot.session.usage.toolCalls,
  activeDurationMs: snapshot.session.usage.activeDurationMs,
  totalTokens: snapshot.session.usage.totalTokens,
  cachedPromptTokens: snapshot.session.usage.cachedPromptTokens,
  estimatedCostUsd: snapshot.session.usage.estimatedCostUsd,
  oracle: { sheets: true, values: true, formula: true, localOnly: true },
}, null, 2))

async function zipBuffer(entries) {
  return await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 1 } })
    const chunks = []
    archive.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    archive.on('end', () => resolve(Buffer.concat(chunks)))
    archive.on('error', reject)
    for (const [name, content] of Object.entries(entries)) archive.append(content, { name })
    void archive.finalize()
  })
}
