import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  createProxyServer, TrafficLog, RETRYABLE_STATUS, retryDelay, parseRetryAfter,
  summarizeUpstreamError, collectRateLimit,
} from '../src/proxy.mjs'
import { resolveRetryPolicy } from '../src/routing.mjs'
import { normalizeConfig, defaultProvider } from '../src/config.mjs'
import { createHarness, makePost, listen, BASE_BODY, SUBSCRIPTION_HEADERS } from './helpers.mjs'

let harness, post

before(async () => {
  harness = await createHarness()
  post = makePost(harness.proxyUrl, harness.upstream)
})
after(() => harness.close())

// ── 純函數 ────────────────────────────────────────────────────────
test('summarizeUpstreamError 挖出 error.type 與訊息，非 JSON 退回原文並截斷', () => {
  const anthropic = JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
  assert.equal(summarizeUpstreamError(Buffer.from(anthropic)), 'overloaded_error: Overloaded')
  assert.equal(summarizeUpstreamError(Buffer.from('<html>502 Bad Gateway</html>')), '<html>502 Bad Gateway</html>')
  assert.equal(summarizeUpstreamError(Buffer.alloc(0)), null)
  assert.equal(summarizeUpstreamError(Buffer.from('x'.repeat(600))).length, 401, '過長要截斷，不然流量記錄會被一頁 HTML 撐爛')
})

test('parseRetryAfter 認得秒數與 HTTP date', () => {
  assert.equal(parseRetryAfter('30'), 30_000)
  assert.equal(parseRetryAfter('0'), 0)
  assert.equal(parseRetryAfter(null), null)
  assert.equal(parseRetryAfter(''), null)
  assert.equal(parseRetryAfter('nonsense'), null)
  const future = parseRetryAfter(new Date(Date.now() + 20_000).toUTCString())
  assert.ok(future > 10_000 && future <= 20_000, `HTTP date 要換算成毫秒，實際 ${future}`)
})

test('retryDelay 聽上游的 retry-after，太長就交回給 Claude Code', () => {
  const policy = { attempts: 2, baseDelayMs: 100, maxDelayMs: 400, maxRetryAfterMs: 10_000 }
  assert.equal(retryDelay('3', 1, policy), 3000, '上游有講就照它說的等')
  assert.ok(retryDelay('0', 1, policy) > 0, 'retry-after: 0 不能變成零退避連送')
  assert.equal(retryDelay('60', 1, policy), null, '要等 60 秒就不是 router 該扛的')
  for (const attempt of [1, 2, 3, 4]) {
    const wait = retryDelay(null, attempt, policy)
    const ceiling = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
    assert.ok(wait > 0 && wait <= ceiling, `第 ${attempt} 次退避 ${wait} 應落在抖動範圍內`)
  }
})

test('collectRateLimit 沒有相關 header 時回 null，不留空物件', () => {
  assert.equal(collectRateLimit(new Headers({ 'content-type': 'application/json' })), null)
})

/** item 13：409 是狀態衝突，重送通常解決不了，實測 Anthropic Messages API 也不會回它。 */
test('409 不是可重送狀態', () => {
  assert.ok(!RETRYABLE_STATUS.has(409), '409 重送幾次都一樣，不該被當成暫時性失敗')
  assert.ok(RETRYABLE_STATUS.has(529), '529（過載）還是要重送')
})

// ── 依路由決定的 retry policy（純函數） ──────────────────────────────
test('resolveRetryPolicy：稀疏覆寫只蓋自己寫的鍵，其餘繼承全域', () => {
  const cfg = normalizeConfig({
    retry: { attempts: 4, baseDelayMs: 700, maxDelayMs: 9000, maxRetryAfterMs: 20000 },
    passthrough: { baseUrl: 'https://api.anthropic.com', retry: { retryRateLimit: false } },
    providers: [
      defaultProvider({ id: 'inherit', baseUrl: 'https://x.test' }),
      defaultProvider({ id: 'tuned', baseUrl: 'https://y.test', retry: { attempts: 0 } }),
    ],
    rules: [],
  })

  const pt = resolveRetryPolicy(cfg, { kind: 'passthrough', rule: null })
  assert.equal(pt.retryRateLimit, false, '訂閱線把節流重送關掉')
  assert.equal(pt.attempts, 4, '沒覆寫的鍵要繼承全域')
  assert.equal(pt.maxRetryAfterMs, 20000)

  const inherit = cfg.providers.find((p) => p.id === 'inherit')
  assert.equal(inherit.retry, null, '沒設就是 null＝全部繼承')
  assert.deepEqual(resolveRetryPolicy(cfg, { kind: 'provider', provider: inherit }), {
    attempts: 4, baseDelayMs: 700, maxDelayMs: 9000, maxRetryAfterMs: 20000, retryRateLimit: true,
  })

  const tuned = cfg.providers.find((p) => p.id === 'tuned')
  assert.deepEqual(tuned.retry, { attempts: 0 }, '覆寫只存使用者真的寫了的鍵')
  const merged = resolveRetryPolicy(cfg, { kind: 'provider', provider: tuned })
  assert.equal(merged.attempts, 0)
  assert.equal(merged.baseDelayMs, 700, '之後調全域退避，只覆寫 attempts 的 provider 也要跟著動')
})

test('resolveRetryPolicy：合併後上限比起跳值小時夾回去', () => {
  const cfg = normalizeConfig({
    retry: { baseDelayMs: 5000, maxDelayMs: 8000 },
    providers: [defaultProvider({ id: 'p', baseUrl: 'https://x.test', retry: { maxDelayMs: 1000 } })],
    rules: [],
  })
  const policy = resolveRetryPolicy(cfg, { kind: 'provider', provider: cfg.providers[0] })
  assert.ok(policy.maxDelayMs >= policy.baseDelayMs, `退避上限不能小於起跳值，實際 ${policy.maxDelayMs}`)
})

test('舊設定檔沒有 passthrough.retry 時，載入就套用「訂閱不重送節流」', () => {
  const cfg = normalizeConfig({ passthrough: { baseUrl: 'https://api.anthropic.com' } })
  assert.deepEqual(cfg.passthrough.retry, { retryRateLimit: false })
})

// ── 整合：實際重送行為 ────────────────────────────────────────────
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
  assert.equal(entry.attempts, 1, 'retry-after 要等 146 秒，這種等待不該由 router 扛著不放')
})

test('上游暫時性失敗時 router 自己重送，client 完全不知道發生過', async () => {
  harness.upstream.state.failPlan = [{ status: 529 }, { status: 529 }]
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)

  assert.equal(res.status, 200, '重送成功就該是一次乾淨的 200，不該讓 Claude Code 看到 529')
  await res.text()
  assert.equal(harness.upstream.state.failPlan.length, 0, '兩次失敗都要被消耗掉')

  const entry = harness.logStore.list()[0]
  assert.equal(entry.attempts, 3, '一次原始 + 兩次重送')
  assert.deepEqual(entry.retries, ['529', '529'], '重送過幾次、為什麼重送，記錄要留著')
  assert.equal(entry.status, 200)
})

/**
 * item 11：重送用完之後 break 出迴圈之前，最後一次失敗沒有被 push 進 entry.retries，
 * 導致 3 次嘗試全部失敗時 retries 只留了 2 筆。這裡直接斷言長度要等於 attempts。
 */
test('重送用完還是失敗，就把上游最後一次的回應原樣交回去，而且重送記錄不少最後一筆', async () => {
  harness.upstream.state.failPlan = [{ status: 529 }, { status: 529 }, { status: 529 }]
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)

  assert.equal(res.status, 529, '扛不住就要交回去，不能自己編一個別的狀態')
  assert.equal((await res.json()).error.type, 'overloaded_error', '上游的錯誤 body 要完整送到 client')
  assert.equal(harness.upstream.state.failPlan.length, 0)

  const entry = harness.logStore.list()[0]
  assert.equal(entry.attempts, 3)
  assert.match(entry.detail, /overloaded_error/)
  assert.deepEqual(entry.retries, ['529', '529', '529'], '3 次嘗試全部失敗，重送記錄也該是 3 筆，不能少記最後一筆')
})

test('連線層被切斷也會重送 —— VPN 掐線跟上游 5xx 一樣要扛', async () => {
  harness.upstream.state.failPlan = [{ hangup: true }]
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)

  assert.equal(res.status, 200)
  await res.text()

  const entry = harness.logStore.list()[0]
  assert.equal(entry.attempts, 2, '斷線一次、重送一次就該成功')
  assert.equal(entry.retries.length, 1)
  assert.ok(!/^\d+$/.test(entry.retries[0]), `連線層失敗記的是錯誤訊息不是狀態碼，實際 ${entry.retries[0]}`)
})

test('請求本身有問題的 4xx 不重送', async () => {
  harness.upstream.state.failPlan = [{ status: 400 }]
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)

  assert.equal(res.status, 400)
  await res.text()
  assert.equal(harness.logStore.list()[0].attempts, 1, '400 重送幾次都一樣，浪費時間而已')
})

test('訂閱線的 429 只送一次就交回去 —— 額度窗等不到退避結束', async () => {
  harness.upstream.state.failPlan = [{ status: 429 }, { status: 429 }]
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)

  assert.equal(res.status, 429)
  await res.text()
  assert.equal(harness.upstream.state.failPlan.length, 1, '只該消耗掉一筆，第二筆還留著')

  const entry = harness.logStore.list()[0]
  assert.equal(entry.attempts, 1, '訂閱的 429 重送三次也是三次都失敗，只是多壓幾秒')
  assert.deepEqual(entry.retries, [])
  harness.upstream.state.failPlan = []
})

test('第三方的 429 照樣重送 —— 那通常等一下就過', async () => {
  harness.upstream.state.failPlan = [{ status: 429 }, { status: 429 }]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)

  assert.equal(res.status, 200, '重送成功，client 看到的是一次乾淨的 200')
  await res.text()
  assert.equal(harness.upstream.state.failPlan.length, 0)

  const entry = harness.logStore.list()[0]
  assert.equal(entry.target, 'Kimi')
  assert.equal(entry.attempts, 3)
  assert.deepEqual(entry.retries, ['429', '429'])
})

test('429 以外的可重送狀態在兩條線行為一致', async () => {
  harness.upstream.state.failPlan = [{ status: 529 }]
  await (await post(SUBSCRIPTION_HEADERS, BASE_BODY)).text()
  assert.equal(harness.logStore.list()[0].attempts, 2, '訂閱線的 529 是瞬時過載，還是要扛')

  harness.upstream.state.failPlan = [{ status: 529 }]
  await (await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)).text()
  assert.equal(harness.logStore.list()[0].attempts, 2, '第三方線同樣要扛')
})

test('provider 可以自己把重送整組關掉', async () => {
  const provider = harness.getConfig().providers.find((p) => p.id === 'kimi')
  provider.retry = { attempts: 0 }
  try {
    harness.upstream.state.failPlan = [{ status: 529 }]
    const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)
    assert.equal(res.status, 529)
    await res.text()
    assert.equal(harness.logStore.list()[0].attempts, 1)
  } finally {
    provider.retry = null
    harness.upstream.state.failPlan = []
  }
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

/**
 * item 7：單筆請求已經有 maxRequestBytes 把關，但那擋不住「很多筆並發」疊起來的總量。
 * 這裡把 maxInFlightBytes 調到很小，兩個並發請求疊起來一定超過，驗證第二個會被
 * 直接 503（而不是讓 Node 一路吃到 heap 見底才發現）。
 */
test('並發請求的總量體超過上限時回 503，不繼續往上游送', async () => {
  const upstream = http.createServer(async (req, res) => {
    // 故意拖著不回，讓兩個請求在「在途」狀態上重疊
    await new Promise((resolve) => setTimeout(resolve, 150))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'ok' }] }))
  })
  const upstreamUrl = await listen(upstream)

  const config = normalizeConfig({ passthrough: { baseUrl: upstreamUrl } })
  const logStore = new TrafficLog(10)
  const proxy = createProxyServer(() => config, logStore, {
    getRuntime: () => ({ boundProxyPort: 8787 }),
    maxInFlightBytes: 5000,
  })
  const proxyUrl = await listen(proxy)

  try {
    const bigBody = JSON.stringify({ ...BASE_BODY, messages: [{ role: 'user', content: 'x'.repeat(4000) }] })
    const send = () => fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bigBody,
    })

    const [first, second] = await Promise.all([send(), send()])
    const statuses = [first.status, second.status].sort()
    assert.deepEqual(statuses, [200, 503], '兩筆疊起來超過總量預算，其中一筆該被 503 擋下')
    const rejected = first.status === 503 ? first : second
    assert.equal(rejected.headers.get('retry-after'), '5')
    await first.text().catch(() => {})
    await second.text().catch(() => {})
  } finally {
    proxy.close()
    upstream.close()
  }
})
