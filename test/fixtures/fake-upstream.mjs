import http from 'node:http'

/**
 * 假上游：記下收到什麼，並能演出 Anthropic Messages API 實測會遇到的失敗形狀。
 *
 * 從 test/smoke.mjs 抽出來（原本每個測試檔案都得自己重寫一份），現在 proxy 相關的
 * 測試檔案與 `npm run demo` 共用同一份劇本：
 *
 *   - 正常請求：非串流回一則文字訊息；`stream: true` 分兩塊送，中間隔 150ms
 *     （用來證明 proxy 沒有把整個回應緩衝起來）。
 *   - `?fail=429`      節流，帶 `retry-after` —— 第三方常見的節流形狀
 *   - `?fail=ratelimit` 節流，不帶 `retry-after`，限流資訊在 `anthropic-ratelimit-*`
 *                       —— 訂閱線實際觀察到的節流形狀
 *   - `?fail=stream`   200 起頭、串流中途才吐 `error` 事件 —— 上游過載時的真實行為
 *   - `?fail=midstream` 串流送到一半直接斷線 —— 模擬中間設備掐線
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
