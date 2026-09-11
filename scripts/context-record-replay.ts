/** Read-only snapshot benchmark. No Agent run, provider request or original-session write. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { contextHash, projectHistoricalContextRecords, readContextRecord } from '../src/server/context-records.js'
import { projectProviderMessages } from '../src/server/deepseek.js'
import type { ModelMessage } from '../src/shared/types.js'

const id = process.argv[2]
if (!/^ses_[a-z0-9]{20}$/.test(id ?? '')) throw new Error('Usage: tsx scripts/context-record-replay.ts ses_<id>')
const path = resolve('.anera/sessions',id,'state.json')
const original = await readFile(path,'utf8')
const messages = (JSON.parse(original) as {messages:ModelMessage[]}).messages
const root = await mkdtemp(resolve(tmpdir(),'anera-context-replay-'))
try {
  const before = projectProviderMessages(messages)
  const result = await projectHistoricalContextRecords(root,messages,before)
  const after = projectProviderMessages(result.messages)
  for (let i=0;i<messages.length;i++) if (result.messages[i].context_projection && !messages[i].context_projection) {
    const ref = JSON.parse(String(after[i].content))
    let offset = 0, restored = ''
    while (true) {
      const page = await readContextRecord(root,{sha256:ref.sha256,offset})
      restored += page.content
      if (page.next_offset === null) break
      offset = page.next_offset!
    }
    if (restored !== before[i].content) throw new Error('Archived evidence failed exact reconstruction')
  }
  if (await readFile(path,'utf8') !== original) throw new Error('Source session changed during benchmark')
  const bytes = (value:unknown) => Buffer.byteLength(JSON.stringify(value))
  console.log(JSON.stringify({sessionId:id,sourceSha256:contextHash(original),sourceUnchanged:true,
    snapshotOnly:true,providerRequests:0,records:result.recordCount,
    beforeMessageBytes:bytes(before),afterMessageBytes:bytes(after),
    reductionPercent:Number((100*(1-bytes(after)/bytes(before))).toFixed(2)),exactRetrievalVerified:true},null,2))
} finally {await rm(root,{recursive:true,force:true})}
