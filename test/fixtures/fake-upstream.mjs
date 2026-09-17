import http from 'node:http'

/** DeepSeek 超過 context 上限時的原樣回應（實測 2026-09）：OpenAI 的措辭、沒有外層 type、content-type 不是 JSON */
export const DEEPSEEK_OVERFLOW = JSON.stringify({
  error: {
    message: "This model's maximum context length is 1048576 tokens. However, you requested 1150953 tokens (1150952 in the messages, 1 in the completion). Please reduce the length of the messages or completion.",
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_request_error',
  },
})

/** Anthropic 的形狀：輸入側的數字在 message_start，message_delta 帶累計的輸出 */
export const USAGE_STREAM = [
  'event: message_start',
  'data: {"type":"message_start","message":{"model":"claude-opus-5","usage":{"input_tokens":223,"cache_creation_input_tokens":40,"cache_read_input_tokens":3712,"output_tokens":1}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"快取命中"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":16}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
].join('\n')

/**
 * 假上游：記下收到什麼，並能演出 Anthropic Messages API 實測會遇到的失敗形狀。
 *
 * proxy 相關的測試檔案共用同一份劇本：
 *
 *   - 正常請求：非串流回一則文字訊息；`stream: true` 分兩塊送，中間隔 150ms
 *     （用來證明 proxy 沒有把整個回應緩衝起來）。
 *   - `?fail=429`      節流，帶 `retry-after` —— 第三方常見的節流形狀
 *   - `?fail=ratelimit` 節流，不帶 `retry-after`，限流資訊在 `anthropic-ratelimit-*`
 *                       —— 訂閱線實際觀察到的節流形狀
 *   - `?fail=stream`   200 起頭、串流中途才吐 `error` 事件 —— 上游過載時的真實行為
 *   - `?fail=midstream` 串流送到一半直接斷線 —— 模擬中間設備掐線
 *   - `?fail=overflow` DeepSeek 超過 context 上限時的原樣回應（OpenAI 措辭、沒有外層 type）
 *   - `?usage=split`   帶 usage 的串流（`USAGE_STREAM`），切在 JSON 與多位元組字元中間
 *   - `state.failPlan`  逐筆消耗的劇本佇列，可以排 `{ status }` / `{ status, retryAfter }`
 *                       / `{ hangup: true }`（連回應都還沒開始就斷線）
 *
 * @returns {{ server: import('node:http').Server, state: { received: object[], failPlan: object[] } }}
 */
export function createFakeUpstream() {
  const state = { received: [], failPlan: [] }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? JSON.parse(raw) : null
    state.received.push({ url: req.url, headers: req.headers, body })

    if (req.url.includes('fail=429')) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '146',
        'request-id': 'req_fake_1',
      })
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your rate limit' },
      }))
      return
    }

    if (req.url.includes('fail=ratelimit')) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': '1756598400',
      })
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }))
      return
    }

    if (req.url.includes('fail=overflow')) {
      res.writeHead(400, { 'content-type': 'application/octet-stream' })
      res.end(DEEPSEEK_OVERFLOW)
      return
    }

    // 故意切得很難讀：切在 JSON 中間、切在多位元組字元中間、最後一行沒換行
    if (req.url.includes('usage=split')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const bytes = Buffer.from(USAGE_STREAM)
      const cuts = [40, bytes.indexOf(Buffer.from('快')) + 1, bytes.length - 20, bytes.length]
      let from = 0
      for (const to of cuts) {
        res.write(bytes.subarray(from, to))
        from = to
      }
      res.end()
      return
    }

    if (req.url.includes('fail=stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: message_start\ndata: {}\n\n')
      res.write('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n')
      res.end()
      return
    }

    if (req.url.includes('fail=midstream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: message_start\ndata: {}\n\n')
      setTimeout(() => res.destroy(), 50)
      return
    }

    const planned = state.failPlan.shift()
    if (planned) {
      if (planned.hangup) {
        req.socket.destroy()
        return
      }
      res.writeHead(planned.status, {
        'content-type': 'application/json',
        ...(planned.retryAfter ? { 'retry-after': planned.retryAfter } : {}),
      })
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
      return
    }

    if (body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: message_start\ndata: {}\n\n')
      setTimeout(() => {
        res.write('event: message_stop\ndata: {}\n\n')
        res.end()
      }, 150)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'msg_1', model: body?.model ?? null, content: [{ type: 'text', text: 'ok' }] }))
  })

  return { server, state }
}
