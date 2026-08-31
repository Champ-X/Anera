import { readFile } from 'node:fs/promises'
import { config } from '../dist-server/server/config.js'

const path = process.argv[2] || 'arena_probe_fixtures/M01_ui_reference.png'
const image = await readFile(path)
const response = await fetch(`${config.deepseekBaseUrl.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${config.deepseekApiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek-v4-flash-vision-exp',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this UI screenshot concisely: visible title, major layout regions, primary colors, chart types, and table columns. Do not infer hidden content.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } },
      ],
    }],
    max_tokens: 1000,
  }),
})
const body = await response.json()
if (!response.ok) throw new Error(`Vision request failed (${response.status}): ${JSON.stringify(body).slice(0, 1000)}`)
console.log(JSON.stringify({ model: body.model, content: body.choices?.[0]?.message?.content, usage: body.usage }, null, 2))
