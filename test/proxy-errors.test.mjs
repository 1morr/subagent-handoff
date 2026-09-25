import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { summarizeUpstreamError, collectRateLimit, translateContextOverflow } from '../src/proxy.mjs'
import { createHarness, makePost, BASE_BODY, SUBSCRIPTION_HEADERS } from './helpers.mjs'
import { DEEPSEEK_OVERFLOW } from './fixtures/fake-upstream.mjs'

let harness, post

before(async () => {
  harness = await createHarness()
  post = makePost(harness.proxyUrl, harness.upstream)
})
after(() => harness.close())

const PROVIDER_HEADERS = { ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }

// ── 純函數 ────────────────────────────────────────────────────────
test('summarizeUpstreamError 挖出 error.type 與訊息，非 JSON 退回原文並截斷', () => {
  const anthropic = JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
  assert.equal(summarizeUpstreamError(Buffer.from(anthropic)), 'overloaded_error: Overloaded')
  assert.equal(summarizeUpstreamError(Buffer.from('<html>502 Bad Gateway</html>')), '<html>502 Bad Gateway</html>')
  assert.equal(summarizeUpstreamError(Buffer.alloc(0)), null)
  assert.equal(summarizeUpstreamError(Buffer.from('x'.repeat(600))).length, 401, '過長要截斷，不然流量記錄會被一頁 HTML 撐爛')
})

test('collectRateLimit 沒有相關 header 時回 null，不留空物件', () => {
  assert.equal(collectRateLimit(new Headers({ 'content-type': 'application/json' })), null)
})

// ── 失敗原樣交回 ──────────────────────────────────────────────────
test('上游被節流時原樣轉出，並把 retry-after 與上游的說法記進流量記錄', async () => {
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY, 'fail=429')

  assert.equal(res.status, 429)
  assert.equal(res.headers.get('retry-after'), '146', 'Claude Code 靠這個 header 決定隔多久重試，吃掉它就變成盲目重試')
  assert.deepEqual(await res.json(), {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your rate limit' },
  }, '錯誤 body 要一個字不差地送到 client')

  const entry = harness.logStore.list()[0]
  assert.equal(entry.status, 429)
  assert.equal(entry.retryAfter, '146')
  assert.equal(entry.requestId, 'req_fake_1')
  assert.match(entry.detail, /rate_limit_error/, '只記一個 429 等於查不出原因，上游的說法要留著')
})

test('暫時性失敗不自己重送：兩條線都只打上游一次，原樣交回讓 Claude Code 照它自己的退避重試', async () => {
  try {
    for (const headers of [SUBSCRIPTION_HEADERS, PROVIDER_HEADERS]) {
      for (const status of [429, 503, 529]) {
        harness.upstream.state.failPlan = [{ status }, { status }]
        const res = await post(headers, BASE_BODY)

        assert.equal(res.status, status)
        assert.equal((await res.json()).error.type, 'overloaded_error', '上游的錯誤 body 要完整送到 client')
        // Claude Code 對這些狀態自己會重試最多 10 次，router 再重送就是把打上游的次數乘上去
        assert.equal(harness.upstream.state.received.length, 1, `${status} 只能送一次`)
        assert.equal(harness.upstream.state.failPlan.length, 1)
      }
    }
  } finally {
    harness.upstream.state.failPlan = []
  }
})

test('連線層失敗回 502，說得出是 router 這頭的錯', async () => {
  harness.upstream.state.failPlan = [{ hangup: true }]
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)

  assert.equal(res.status, 502, 'Claude Code 會重試 5xx，所以這裡不必自己扛')
  const body = await res.json()
  assert.equal(body.error.type, 'api_error')
  assert.match(body.error.message, /^subagent-handoff: /)

  const entry = harness.logStore.list()[0]
  assert.equal(entry.status, null, '上游連回應都沒有，不能記成某個狀態碼')
  assert.ok(entry.error, '流量記錄要留下失敗原因')
  assert.equal(harness.upstream.state.received.length, 1)
})

test('provider 說 context 超限時，轉成 Claude Code 認得、會自己壓縮的那一句', async () => {
  const res = await post(PROVIDER_HEADERS, BASE_BODY, 'fail=overflow')

  assert.equal(res.status, 400)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.deepEqual(await res.json(), {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'prompt is too long: 1150953 tokens > 1048576 maximum' },
  }, '數字要照搬：Claude Code 靠它決定摘要請求先截掉多少舊對話')

  const entry = harness.logStore.list()[0]
  assert.match(entry.detail, /maximum context length is 1048576 tokens/, '流量記錄要留上游原本的說法')
  assert.match(entry.detail, /rewritten to "prompt is too long"/, '改寫過回應要看得出來')
})

test('訂閱線的錯誤回應不改寫，別的 400 也不改寫', async () => {
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY, 'fail=overflow')
  assert.equal(await res.text(), DEEPSEEK_OVERFLOW, '訂閱線的錯誤 body 要一個字不差')
  assert.doesNotMatch(harness.logStore.list()[0].detail, /rewritten/)

  const other = Buffer.from(JSON.stringify({ error: { message: 'The content[].thinking in the thinking mode must be passed back to the API.', type: 'invalid_request_error' } }))
  assert.equal(translateContextOverflow(other), null)
  const anthropic = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }))
  assert.equal(translateContextOverflow(anthropic), null, 'Claude Code 本來就認得的不必再包一層')
})

test('上游的 anthropic-ratelimit-* header 進到流量記錄', async () => {
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY, 'fail=ratelimit')
  assert.equal(res.status, 429)
  await res.text()

  const entry = harness.logStore.list()[0]
  assert.equal(entry.retryAfter, null, '這批 429 就是不帶 retry-after，才需要另一組 header')
  assert.deepEqual(entry.rateLimit, {
    'unified-status': 'rejected',
    'unified-reset': '1756598400',
  }, '沒有這個，流量記錄答不出「什麼時候恢復」')
})

test('請求行是完整網址（把 router 當 HTTP proxy 用）時回 400 並講清楚是哪兩個設定打架，不往上游送', async () => {
  // HTTPS_PROXY 指向 router、ANTHROPIC_BASE_URL 又是 http:// 時，Claude Code 會這樣送。
  // 照樣轉發只會組出 https://api.anthropic.comhttp://… 這種網址，回一個看不出原因的 502
  harness.upstream.state.received.length = 0
  const { port } = new URL(harness.proxyUrl)
  const { status, body } = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: 'http://127.0.0.1:8787/v1/messages?beta=true',
      headers: { ...SUBSCRIPTION_HEADERS, host: '127.0.0.1:8787', 'content-type': 'application/json' },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(BASE_BODY))
  })
  assert.equal(status, 400, '400 讓 Claude Code 不重試；502 會被重送十次')
  assert.equal(body.error.type, 'invalid_request_error')
  assert.match(body.error.message, /HTTPS_PROXY.*ANTHROPIC_BASE_URL/)
  assert.equal(harness.upstream.state.received.length, 0)
  assert.match(harness.finished.at(-1).error, /proxy-style request for http:\/\/127\.0\.0\.1:8787\/v1\/messages/)
})
