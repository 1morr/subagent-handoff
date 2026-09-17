import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import { runProbes, DEFAULT_TEST_IDS } from '../src/probe.mjs'
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

test('思考檔位：上游拒收任一檔位就判失敗，並把上游的錯誤訊息帶出來', async () => {
  await withUpstream(
    (body, res) => {
      if (body.output_config?.effort === 'xhigh') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'unknown variant `xhigh`' } }))
        return
      }
      replyJson(res, { content: [{ type: 'text', text: 'ok' }] })
    },
    async (url) => {
      const provider = defaultProvider({ baseUrl: url, model: 'm' })
      const [result] = (await runProbes(provider, { tests: ['effort'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /xhigh/, '錯誤訊息要指得出是哪個檔位、為什麼')
      assert.match(result.detail, /4\/5/)
    },
  )
})

test('思考檔位：五檔全收時送出完整枚舉，而且只打五次', async () => {
  await withUpstream(
    (body, res) => replyJson(res, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    async (url, seen) => {
      const provider = defaultProvider({ baseUrl: url, model: 'm' })
      const [result] = (await runProbes(provider, { tests: ['effort'] })).results

      assert.equal(result.ok, true)
      assert.deepEqual(
        seen.map((b) => b.output_config.effort),
        ['low', 'medium', 'high', 'xhigh', 'max'],
        '要照 Claude Code 的枚舉逐一測，不能只挑兩端',
      )
      assert.equal(seen.length, 5, '量測那兩次已經拿掉了，付費 provider 上不該白花')
      // 探針要送真實的請求形狀，否則測不出上游對整包的寬容度
      assert.equal(seen[0].thinking.type, 'adaptive')
      assert.ok(seen[0].context_management, 'context_management 也要一起送')
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

const replyText = (res, text, extra = {}) =>
  replyJson(res, { content: [{ type: 'text', text }], stop_reason: 'end_turn', ...extra })

/** 最後一則 user 訊息裡的 tool_result 內容（Read 的結果都放在這裡） */
const lastToolResult = (body) =>
  body.messages.at(-1).content.find((b) => b.type === 'tool_result')?.content ?? []

/** 從探針送來的 PNG 讀回四格的顏色：真的解碼，而不是去偷看探針的內部狀態 */
function readQuadrants(base64) {
  const png = Buffer.from(base64, 'base64')
  let width = 0
  const idat = []
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') width = data.readUInt32BE(0)
    if (type === 'IDAT') idat.push(data)
    at += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const row = width * 3 + 1
  const palette = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0] }
  const colorAt = (x, y) => {
    const o = y * row + 1 + x * 3
    const px = [raw[o], raw[o + 1], raw[o + 2]]
    const distance = (c) => c.reduce((sum, v, i) => sum + (v - px[i]) ** 2, 0)
    return Object.keys(palette).sort((a, b) => distance(palette[a]) - distance(palette[b]))[0]
  }
  const q = width / 4
  return { TL: colorAt(q, q), TR: colorAt(3 * q, q), BL: colorAt(q, 3 * q), BR: colorAt(3 * q, 3 * q) }
}

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

test('預設清單不含選配的 WebSearch，結果都帶著分級', async () => {
  assert.ok(!DEFAULT_TEST_IDS.includes('webSearch'), '一次上萬 tokens 的測試不能藏在「執行測試」裡')
  await withUpstream(
    (_body, res) => replyText(res, 'OK'),
    async (url) => {
      const { results } = await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['connectivity', 'effort'] })
      assert.deepEqual(results.map((r) => r.tier), ['required', 'capability'])
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

test('中途 system 訊息：兩個位置都送到，模型答得出兩個碼才算過', async () => {
  await withUpstream(
    (body, res) => {
      const systemTexts = body.messages
        .filter((m) => m.role === 'system')
        .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text).join('')))
      const session = /Session code: (\d+)/.exec(systemTexts.join('\n'))?.[1] ?? 'NONE'
      const reminder = /Reminder code: (\d+)/.exec(systemTexts.join('\n'))?.[1] ?? 'NONE'
      replyText(res, `SESSION=${session} REMINDER=${reminder}`)
    },
    async (url, seen) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['systemMessages'] })).results
      assert.equal(result.ok, true, result.error)
      const roles = seen[0].messages.map((m) => m.role)
      assert.equal(roles[1], 'system', '照抓到的形狀：第一則 user 之後就是 system')
      assert.equal(roles.at(-1), 'system', '結尾也有一則')
      assert.ok(seen[0].messages.at(-1).content[0].cache_control, '結尾那則帶 cache_control')
    },
  )
})

test('中途 system 訊息：上游收下卻丟掉時照樣 200，要判失敗並指出是哪一則', async () => {
  await withUpstream(
    (_body, res) => replyText(res, 'SESSION=NONE REMINDER=NONE'),
    async (url) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['systemMessages'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /mid-conversation and trailing system message/)
    },
  )
})

/** 看圖 / 讀 PDF 的第一輪：模型呼叫 Read，前面帶著自己的 thinking —— 第二輪必須原樣看到這一則 */
const READ_CALL = [
  { type: 'thinking', thinking: '', signature: 'sig-read' },
  { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/tmp/probe' } },
]
const replyReadCall = (res) => replyJson(res, { content: READ_CALL, stop_reason: 'tool_use' })

test('看圖：圖片放在 tool_result 裡，模型答對四格顏色才算過', async () => {
  await withUpstream(
    (body, res) => {
      if (body.messages.length === 1) return replyReadCall(res)
      const image = lastToolResult(body).find((b) => b.type === 'image')
      const q = readQuadrants(image.source.data)
      replyText(res, `TL=${q.TL} TR=${q.TR} BL=${q.BL} BR=${q.BR}`)
    },
    async (url, seen) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['vision'] })).results
      assert.equal(result.ok, true, result.error)
      assert.equal(seen.length, 2)
      assert.deepEqual(seen[1].messages[1].content, READ_CALL, '要送回模型自己那一則，thinking 缺了 DeepSeek 直接 400')
      const last = seen[1].messages.at(-1)
      assert.deepEqual(last.content.map((b) => b.type), ['tool_result'], '照 Claude Code 的形狀：圖片只出現在工具結果裡')
      assert.equal(last.content[0].tool_use_id, 'toolu_read')
    },
  )
})

test('看圖：模型不呼叫 Read 時是「無法判定」，不打第二輪', async () => {
  await withUpstream(
    (_body, res) => replyText(res, 'I will not read files.'),
    async (url, seen) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['vision'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /did not call Read.*cannot judge/)
      assert.equal(seen.length, 1)
    },
  )
})

test('看圖：上游把圖片丟掉、模型照猜，要判失敗', async () => {
  await withUpstream(
    (body, res) => (body.messages.length === 1 ? replyReadCall(res) : replyText(res, 'I cannot see an image. TL=? TR=? BL=? BR=?')),
    async (url) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['vision'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /never reached the model/)
    },
  )
})

test('看圖：思考吃光 max_tokens 沒有回覆時是「無法判定」，不能誣賴上游丟了圖', async () => {
  await withUpstream(
    (body, res) =>
      body.messages.length === 1
        ? replyReadCall(res)
        : replyJson(res, { content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'max_tokens' }),
    async (url) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['vision'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /cannot judge/)
      assert.match(result.error, /max_tokens/)
      assert.doesNotMatch(result.error, /never reached the model/)
    },
  )
})

test('讀 PDF：document 放在 tool_result 裡，答得出 PDF 裡的碼才算過', async () => {
  await withUpstream(
    (body, res) => {
      if (body.messages.length === 1) return replyReadCall(res)
      const doc = lastToolResult(body).find((b) => b.type === 'document')
      const text = /\((PDF-\d+)\) Tj/.exec(Buffer.from(doc.source.data, 'base64').toString('latin1'))[1]
      replyText(res, text)
    },
    async (url, seen) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['pdf'] })).results
      assert.equal(result.ok, true, result.error)
      const content = seen[1].messages.at(-1).content[0].content
      assert.deepEqual(content.map((b) => b.type), ['text', 'document'], '照 Claude Code 的形狀：一行檔名說明加上 document')
      assert.equal(content[1].source.media_type, 'application/pdf')
    },
  )
})

test('讀 PDF：上游把 document 換成佔位字照樣回 200（DeepSeek 實測），要判失敗', async () => {
  await withUpstream(
    (body, res) => (body.messages.length === 1 ? replyReadCall(res) : replyText(res, 'NONE')),
    async (url) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['pdf'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /PDF content never reached the model/)
    },
  )
})

test('WebSearch：照 Claude Code 的形狀強制 server tool，拿到搜尋結果才算過', async () => {
  await withUpstream(
    (_body, res) =>
      replySse(res, [
        ['message_start', { message: { usage: { input_tokens: 9171 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } }],
        ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"node"}' } }],
        ['content_block_stop', { index: 0 }],
        ['content_block_start', {
          index: 1,
          content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', title: 'Node.js', url: 'https://nodejs.org' }] },
        }],
        ['content_block_stop', { index: 1 }],
        // DeepSeek 實測就是這樣收尾：stop_reason 是 tool_use，而且沒有文字
        ['message_delta', { delta: { stop_reason: 'tool_use' } }],
        ['message_stop', {}],
      ]),
    async (url, seen) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['webSearch'] })).results
      assert.equal(result.ok, true, result.error)
      assert.match(result.detail, /1 results/)
      assert.match(result.detail, /9171/, '成本要看得見')
      assert.deepEqual(seen[0].tool_choice, { type: 'tool', name: 'web_search' })
      assert.equal(seen[0].tools[0].type, 'web_search_20250305')
      assert.equal(seen[0].tools[0].max_uses, 1, '壓到 1 次省錢')
    },
  )
})

test('WebSearch：上游不執行 server tool 時判失敗', async () => {
  await withUpstream(
    (_body, res) =>
      replySse(res, [
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'I cannot browse.' } }],
        ['content_block_stop', { index: 0 }],
        ['message_stop', {}],
      ]),
    async (url) => {
      const [result] = (await runProbes(defaultProvider({ baseUrl: url, model: 'm' }), { tests: ['webSearch'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /did not run web_search/)
    },
  )
})
