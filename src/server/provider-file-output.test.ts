import { describe, expect, it } from 'vitest'
import { projectProviderMessages } from './deepseek.js'
import type { ModelMessage } from '../shared/types.js'

describe('raw text file projection for the model', () => {
  const raw = '<style>.slide::before{content:""} .path{content:"C:\\temp"}</style>\n你好'
  const payload = JSON.stringify({ kind: 'text', content: raw, hasMore: true, nextContentOffset: 2048 })
  const conversation = (name: string): ModelMessage[] => [
    { role: 'assistant', content: '', tool_calls: [{ id: 'read-1', type: 'function', function: { name, arguments: '{"path":"deck.html"}' } }] },
    { role: 'tool', tool_call_id: 'read-1', content: payload, tool_result_status: 'succeeded' },
  ]
  it('shows exact raw bytes with pagination metadata while preserving durable JSON', () => {
    const messages = conversation('read_file')
    const result = projectProviderMessages(messages)
    expect(result[1].content).toContain(`--- BEGIN FILE CONTENT ---\n${raw}\n--- END FILE CONTENT ---`)
    expect(result[1].content).toContain('"nextContentOffset":2048')
    expect(result[1].content).toContain('encode tool arguments as JSON once')
    expect(messages[1].content).toBe(payload)
  })
  it('requires a matching read_file call and leaves other JSON and unpaired results intact', () => {
    expect(projectProviderMessages(conversation('fetch_page'))[1].content).toBe(payload)
    expect(projectProviderMessages([{ role: 'tool', tool_call_id: 'unknown', content: payload }])[0].content).toBe(payload)
    expect(projectProviderMessages([{ role: 'user', content: payload }])[0].content).toBe(payload)
  })
  it.each(['{"status":"error","message":"missing"}', '[Historical tool result compacted]', '{"kind":"image","data":"abc"}'])(
    'leaves non-text and historical results unchanged: %s', (content) => {
      const messages = conversation('read_file')
      messages[1].content = content
      expect(projectProviderMessages(messages)[1].content).toBe(content)
    },
  )
})
