import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { runProbes } from '../src/probe.mjs'
import { defaultProvider } from '../src/config.mjs'
import { listen } from './helpers.mjs'

/** 起一個只服務這一項測試的假上游，handler 決定每一筆怎麼回，並記下收到的 body。 */
async function withUpstream(handler, fn) {
  const seen = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(body)
    handler(body, res)
  })
  const url = await listen(server)
  try {
    return await fn(url, seen)
  } finally {
    server.close()
  }
}

function replyJson(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

test('SSE 測試：上游最後一個事件沒有換行收尾也要算數', async () => {
  const LF = String.fromCharCode(10)
  await withUpstream(
    (_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: content_block_delta${LF}data: {}${LF}${LF}`)
      // 故意不以換行收尾：最後一行卡在 buffer 裡，漏收就會誤判成串流不完整
      res.end(`event: message_stop${LF}data: {}`)
    },
    async (url) => {
      const provider = defaultProvider({ baseUrl: url, model: 'm' })
      const [result] = (await runProbes(provider, { tests: ['streaming'] })).results
      assert.equal(result.ok, true, result.error)
      assert.match(result.detail, /message_stop/)
    },
  )
})

test('SSE 測試：連 event 行都沒換行、串流就此結束，也要讀得到那個事件', async () => {
  const LF = String.fromCharCode(10)
  await withUpstream(
    (_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: content_block_delta${LF}data: {}${LF}${LF}`)
      res.end('event: message_stop')
    },
    async (url) => {
      const provider = defaultProvider({ baseUrl: url, model: 'm' })
      const [result] = (await runProbes(provider, { tests: ['streaming'] })).results
      assert.equal(result.ok, true, result.error)
    },
  )
})

test('runProbes：沒有 baseUrl 或沒有 model 名時，本地判失敗，不打任何上游', async () => {
  const noUrl = await runProbes(defaultProvider({ baseUrl: '', model: 'm' }))
  assert.equal(noUrl.results[0].ok, false)
  assert.match(noUrl.results[0].error, /Base URL/)

  const noModel = await runProbes(defaultProvider({ baseUrl: 'https://x.test', model: '' }))
  assert.equal(noModel.results[0].ok, false)
  assert.match(noModel.results[0].error, /model/)
})

// ── 照 Claude Code 請求形狀打的測試項 ───────────────────────────────

function replySse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [type, payload] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
  res.end()
}

/** 最後一則 user 訊息裡的 tool_result 內容 */
const lastToolResult = (body) =>
  body.messages.at(-1).content.find((b) => b.type === 'tool_result')?.content ?? []

test('基本推論：預算留給會自己思考的上游，回覆是空的時候講清楚為什麼', async () => {
  await withUpstream(
    (_body, res) => replyJson(res, { model: 'm', content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'max_tokens' }),
    async (url, seen) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['connectivity'] })).results
      assert.equal(result.ok, true, '通不通只看狀態碼，思考吃光預算不代表連不上')
      assert.match(result.detail, /reply empty \(stop_reason=max_tokens, thinking used up max_tokens\)/)
      assert.ok(seen[0].max_tokens >= 256, 'DeepSeek 不帶 thinking 也會思考，16 tokens 實測不夠')
      assert.equal(seen[0].thinking, undefined, '不改送 thinking: disabled，免得上游不收時連通測試跟著壞')
    },
  )
})

test('串流工具迴圈：thinking 連同 signature 原樣送回，第二輪用上 tool_result', async () => {
  await withUpstream(
    (body, res) => {
      if (body.messages.length === 1) {
        replySse(res, [
          ['message_start', { message: { usage: { input_tokens: 10 } } }],
          ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
          ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }],
          ['content_block_stop', { index: 0 }],
          ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_order_status', input: {} } }],
          // input 被切成兩段送：拼接錯了就不是合法 JSON
          ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"order_id":' } }],
          ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"A-1042"}' } }],
          ['content_block_stop', { index: 1 }],
          ['message_delta', { delta: { stop_reason: 'tool_use' } }],
          ['message_stop', {}],
        ])
        return
      }
      const code = /Tracking code: (\d+)/.exec(lastToolResult(body))[1]
      replySse(res, [
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: code } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'end_turn' } }],
        ['message_stop', {}],
      ])
    },
    async (url, seen) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['toolLoop'] })).results
      assert.equal(result.ok, true, result.error)
      assert.equal(seen.length, 2)
      assert.equal(seen[0].stream, true, 'Claude Code 一律串流，這項測的就是串流版的工具呼叫')

      const echoed = seen[1].messages[1]
      assert.equal(echoed.role, 'assistant')
      assert.deepEqual(echoed.content[0], { type: 'thinking', thinking: '', signature: 'sig-abc' }, 'thinking 要連 signature 一起送回')
      assert.deepEqual(echoed.content[1].input, { order_id: 'A-1042' }, 'input_json_delta 要拼回完整的 input')
      assert.equal(seen[1].messages[2].content[0].tool_use_id, 'toolu_1')
    },
  )
})

test('串流工具迴圈：上游拒收自己吐出的 thinking block 時判失敗並帶出原因', async () => {
  await withUpstream(
    (body, res) => {
      if (body.messages.length > 1) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'messages.1.content.0: thinking blocks are not supported' } }))
        return
      }
      replySse(res, [
        ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: 's' } }],
        ['content_block_stop', { index: 0 }],
        ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: 't', name: 'get_order_status', input: {} } }],
        ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"order_id":"A-1042"}' } }],
        ['content_block_stop', { index: 1 }],
        ['message_stop', {}],
      ])
    },
    async (url) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['toolLoop'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /the turn sending back tool_result was rejected/)
      assert.match(result.error, /thinking blocks are not supported/, '上游的說法要原樣帶出來')
    },
  )
})

test('串流工具迴圈：input_json_delta 拼不回合法 JSON 就判失敗，不打第二輪', async () => {
  await withUpstream(
    (_body, res) =>
      replySse(res, [
        ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: 'get_order_status', input: {} } }],
        ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"order_id": A-1042' } }],
        ['content_block_stop', { index: 0 }],
        ['message_stop', {}],
      ]),
    async (url, seen) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['toolLoop'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /input_json_delta/)
      assert.equal(seen.length, 1)
    },
  )
})

