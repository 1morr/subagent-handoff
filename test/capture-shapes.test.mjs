import test from 'node:test'
import assert from 'node:assert/strict'
import { requestShape } from '../scripts/capture-shapes.mjs'

test('抓包工具只記結構：文字、憑證、帳號識別、認不得的新欄位，一個值都不留', () => {
  let n = 0
  const leak = () => `LEAK${++n}x`
  const body = {
    model: 'claude-opus-5',
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    metadata: { user_id: JSON.stringify({ device_id: leak(), account_uuid: leak(), session_id: leak() }) },
    // 認不得的頂層欄位：新版本多出來的東西不能因為沒列進清單就原樣寫出去
    mcp_servers: [{ type: 'url', url: leak(), authorization_token: leak() }],
    system: [{ type: 'text', text: leak(), cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [
      { name: 'Read', description: leak(), input_schema: { type: 'object', properties: { file_path: { type: 'string', description: leak() } } } },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 8, allowed_domains: [leak()] },
    ],
    messages: [
      { role: 'user', content: leak() },
      { role: 'system', content: [{ type: 'text', text: leak() }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: leak(), signature: leak() },
          { type: 'redacted_thinking', data: leak() },
          { type: 'tool_use', id: leak(), name: 'Read', input: { file_path: leak() } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: leak(),
            content: [
              { type: 'text', text: leak() },
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: leak() }, title: leak() },
            ],
          },
          { type: 'tool_result', tool_use_id: leak(), content: leak(), is_error: true },
        ],
      },
    ],
  }
  const headers = {
    authorization: `Bearer ${leak()}`,
    'x-api-key': leak(),
    'x-claude-code-session-id': leak(),
    'x-claude-code-agent-id': leak(),
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
  }

  const shape = requestShape(headers, body)
  assert.equal(JSON.stringify(shape).match(/LEAK\d+x/g), null, '輸出要能直接貼進 docs，這些值漏出來了')

  // 什麼都不記也過得了上面那條，所以結構本身要還在
  assert.equal(shape.headers['anthropic-beta'], 'claude-code-20250219,oauth-2025-04-20')
  assert.equal(shape.headers.authorization, '<redacted>')
  assert.deepEqual(Object.keys(shape.top.metadata.user_id.json), ['device_id', 'account_uuid', 'session_id'])
  assert.deepEqual(shape.top.thinking, { type: 'adaptive' })
  assert.deepEqual(shape.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(shape.tools[1].max_uses, 8)
  assert.deepEqual(shape.messages.map((m) => m.role), ['user', 'system', 'assistant', 'user'])
  assert.deepEqual(shape.messages[2].content.map((b) => b.type), ['thinking', 'redacted_thinking', 'tool_use'])
  assert.deepEqual(shape.messages[2].content[2].inputKeys, ['file_path'])
  const [pdfResult, errorResult] = shape.messages[3].content
  assert.deepEqual(pdfResult.content.map((b) => b.type), ['text', 'document'])
  assert.equal(pdfResult.content[1].source.media_type, 'application/pdf')
  assert.equal(errorResult.is_error, true)
})
