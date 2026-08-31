import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { config } from '../src/server/config.js'
import { DeepSeekClient } from '../src/server/deepseek.js'

if (!config.deepseekApiKey) throw new Error('DEEPSEEK_API_KEY is not configured')

const fixture = await readFile(resolve(config.projectRoot, 'arena_probe_fixtures/M01_ui_reference.png'))
const fixtureBase64 = fixture.toString('base64')
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(new Error('Image tool-result protocol smoke timed out')), 90_000)
timeout.unref?.()

try {
  const client = new DeepSeekClient({
    apiKey: config.deepseekApiKey,
    baseUrl: config.deepseekBaseUrl,
    model: config.visionModel,
    maxOutputTokens: 500,
    firstEventTimeoutMs: 60_000,
    maxRetries: 0,
  })
  const result = await client.stream({
    messages: [
      { role: 'user', content: 'Read the image with read_file, then report its visible product name and page title.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_image_protocol_smoke',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"M01_ui_reference.png"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_image_protocol_smoke',
        content: JSON.stringify({ kind: 'image', mediaType: 'image/png', size: fixture.byteLength, width: 1200, height: 800 }),
        tool_result_status: 'succeeded',
        tool_content_parts: [{ type: 'image-data', data: fixtureBase64, mediaType: 'image/png' }],
      },
    ],
    tools: [],
    signal: controller.signal,
    onContent: () => undefined,
    onReasoning: () => undefined,
  })
  const answer = result.content.trim()
  if (!answer) throw new Error('Provider accepted the request but returned no visible answer')
  if (!/ANERA\s+OPS/i.test(answer) || !/Agent\s+operations/i.test(answer)) {
    throw new Error(`Provider response did not prove image access: ${JSON.stringify(answer.slice(0, 500))}`)
  }
  console.log(JSON.stringify({
    schemaVersion: 'anera-image-tool-result-protocol-smoke/1.0',
    status: 'pass',
    model: config.visionModel,
    finishReason: result.finishReason,
    answer,
    usage: result.usage,
  }, null, 2))
} finally {
  clearTimeout(timeout)
}
