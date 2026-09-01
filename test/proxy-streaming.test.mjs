import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { createProxyServer, TrafficLog, findStreamError, sseError, createPinger } from '../src/proxy.mjs'
import { NOT_SENT_LABEL } from '../src/routing.mjs'
import { createHarness, makePost, listen, BASE_BODY, SUBSCRIPTION_HEADERS } from './helpers.mjs'

let harness, post

before(async () => {
  harness = await createHarness()
  post = makePost(harness.proxyUrl, harness.upstream)
})
after(() => harness.close())

// ── 串流 ──────────────────────────────────────────────────────────
test('SSE 逐塊透傳，不緩衝整個回應', async () => {
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, { ...BASE_BODY, stream: true })
  assert.match(res.headers.get('content-type'), /event-stream/)

  const arrivals = []
  const started = Date.now()
  for await (const chunk of res.body) {
    arrivals.push({ ms: Date.now() - started, text: Buffer.from(chunk).toString('utf8') })
  }

  assert.ok(arrivals.length >= 2, `應該分次到達，實際收到 ${arrivals.length} 塊`)
  const gap = arrivals.at(-1).ms - arrivals[0].ms
  assert.ok(gap > 100, `兩塊之間應相隔約 150ms，實際 ${gap}ms —— 太小代表被緩衝了`)
  assert.match(arrivals.map((a) => a.text).join(''), /message_stop/)
})

test('流量記錄留下請求形狀，但一樣不留內容', async () => {
  await (await post(SUBSCRIPTION_HEADERS, { ...BASE_BODY, stream: true, system: 'be a helpful pirate' })).text()

  const entry = harness.logStore.list()[0]
  assert.deepEqual(entry.shape, { messages: 1, system: true, stream: true, maxTokens: 4096 })
  assert.ok(!JSON.stringify(entry).includes('pirate'), 'system prompt 不能被形狀帶進流量記錄')
})

test('200 的串流裡夾著 error 事件時，流量記錄不能記成成功', async () => {
  const res = await post(SUBSCRIPTION_HEADERS, { ...BASE_BODY, stream: true }, 'fail=stream')
  assert.equal(res.status, 200)
  assert.match(await res.text(), /overloaded_error/, '串流內容要原樣送到 client')

  const entry = harness.logStore.list()[0]
  assert.equal(entry.status, 200)
  assert.match(entry.detail, /overloaded_error: Overloaded/, '只記一個 200 的話，這種失敗在流量記錄上看不出來')
})

test('findStreamError 認得 error 事件，也不會把正常事件當成錯誤', () => {
  const evt = Buffer.from('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom"}}\n')
  assert.equal(findStreamError(evt), 'api_error: boom')
  assert.equal(findStreamError(Buffer.from('event: message_delta\ndata: {"type":"message_delta"}\n')), null)
})

test('findStreamError 吃得下 fetch 吐出來的 Uint8Array', () => {
  const LF = String.fromCharCode(10)
  const evt = `event: error${LF}data: {"type":"error","error":{"type":"api_error","message":"boom"}}${LF}`
  // proxy 在串流迴圈裡拿到的每一塊是 Uint8Array，不是 Buffer；兩者的 indexOf 行為不一樣
  assert.equal(findStreamError(new Uint8Array(Buffer.from(evt))), 'api_error: boom')
})

test('串流開到一半斷線時，補一個合法的 SSE error 事件收尾', async () => {
  const res = await post(SUBSCRIPTION_HEADERS, { ...BASE_BODY, stream: true }, 'fail=midstream')
  assert.equal(res.status, 200)

  const text = await res.text()
  assert.match(text, /message_start/, '已經送到 client 的部分要保留')
  assert.match(text, /event: error/, '斷掉的串流要有收尾 —— 只是被切斷的話 client 連為什麼都拿不到')
  assert.match(text, /subagent-handoff/)
})

test('sseError 產生合法的 SSE 事件框', () => {
  const frame = sseError('boom')
  assert.ok(frame.startsWith('event: error'))
  assert.ok(frame.endsWith(String.fromCharCode(10, 10)), 'SSE 事件要用空行收尾，少一個 client 就不會處理')
  const payload = JSON.parse(frame.split(String.fromCharCode(10))[1].replace('data: ', ''))
  assert.equal(payload.error.type, 'api_error')
  assert.match(payload.error.message, /boom/)
})

test('連線預熱探針有回應', async () => {
  const res = await fetch(`${harness.proxyUrl}/api/hello`, { method: 'HEAD' })
  assert.equal(res.status, 200)
})

test('body 超過上限時當場擋下來，一個 byte 都不往上游送', async () => {
  const original = harness.getConfig()
  harness.setConfig({ ...original, maxRequestBytes: 2000 })
  try {
    const res = await post(SUBSCRIPTION_HEADERS, {
      ...BASE_BODY,
      messages: [{ role: 'user', content: 'x'.repeat(8000) }],
    })

    assert.equal(res.status, 413)
    assert.equal((await res.json()).error.type, 'invalid_request_error')
    assert.equal(harness.upstream.state.received.length, 0, '收不完的請求絕不能往上游送')

    const entry = harness.logStore.list()[0]
    assert.equal(entry.status, 413)
    assert.equal(entry.target, NOT_SENT_LABEL)
    assert.match(entry.error, /exceeds the .* byte limit/)
    assert.equal(entry.kind, 'main', 'kind 只看 header，body 收不完也判得出來')
  } finally {
    harness.setConfig(original)
  }
})

test('請求走完才落檔，落下去的 entry 已經是完整的', async () => {
  harness.finished.length = 0
  await (await post(SUBSCRIPTION_HEADERS, BASE_BODY)).text()

  assert.equal(harness.finished.length, 1)
  const entry = harness.finished[0]
  assert.equal(entry.status, 200)
  assert.ok(entry.ms != null, '耗時是在 finally 才補的，太早落檔就會是 null')
  assert.ok(entry.attempts >= 1)
})

test('讀 request body 途中斷線就收手，不拿空 body 往上游打', async () => {
  harness.upstream.state.received = []
  await new Promise((resolve) => {
    const u = new URL(harness.proxyUrl)
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: '/v1/messages',
      method: 'POST',
      // 宣告 10000 bytes 卻只寫幾個就切線，proxy 那頭的 for await 會丟例外
      headers: { 'content-type': 'application/json', 'content-length': '10000' },
    })
    req.on('error', () => {})
    req.write('{"model":')
    setTimeout(() => {
      req.destroy()
      resolve()
    }, 50)
  })
  await sleep(120)

  assert.equal(harness.upstream.state.received.length, 0, '沒有人在等回應了，不該再浪費一次上游來回')
  const entry = harness.logStore.list()[0]
  assert.equal(entry.target, NOT_SENT_LABEL)
  assert.match(entry.error, /failed to read request body/)
})

// ── SSE keep-alive ping ───────────────────────────────────────────
test('createPinger：上游靜默就補 ping，而且只在事件邊界上補', async () => {
  const onBoundary = []
  const midFrame = []
  const stub = (sink) => ({ writableEnded: false, destroyed: false, write: (c) => sink.push(c) })

  const a = createPinger(stub(onBoundary), 30)
  const b = createPinger(stub(midFrame), 30)
  // 上游的 chunk 不保證切在 frame 邊界上，插進半個事件中間會把整條串流弄壞
  b.saw(Buffer.from('event: content_block_delta\ndata: {"partial"'))

  await sleep(200)
  assert.ok(a.stop() > 0, '靜默超過 idleMs 就該補')
  assert.deepEqual(onBoundary[0], 'event: ping\ndata: {"type":"ping"}\n\n', 'ping 必須是一個完整合法的事件')
  assert.equal(b.stop(), 0, '停在半個事件中間就不能插進去')
})

test('createPinger：收到上游資料就重置計時，res 收掉之後不再寫', async () => {
  const written = []
  const res = { writableEnded: false, destroyed: false, write: (c) => written.push(c) }
  const pinger = createPinger(res, 120)

  // 每 40ms 餵一塊完整事件，計時一直被重置，撐過 idleMs 也不該有 ping
  for (let i = 0; i < 5; i++) {
    pinger.saw(Buffer.from('event: ping\ndata: {}\n\n'))
    await sleep(40)
  }
  assert.equal(written.length, 0, '上游還在吐東西就不需要代打')

  res.writableEnded = true
  await sleep(200)
  assert.equal(pinger.stop(), 0, '回應已經收掉還寫就會炸在 stream 上')
})

test('訂閱線的串流一個合成 byte 都不加', async () => {
  const res = await post(SUBSCRIPTION_HEADERS, { ...BASE_BODY, stream: true })
  const text = await res.text()

  assert.equal(
    text,
    'event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n',
    'passthrough 的價值就在原始 bytes 原樣轉發，ping 也不能摻進去',
  )
  assert.equal(harness.logStore.list()[0].pings, 0)
})

/**
 * item 22：PING_IDLE_MS 過去是寫死的模組常數，只能靠 createPinger 的單元測試間接驗證。
 * 這裡透過 createProxyServer 的 `pingIdleMs` 選項，端到端驗證 provider 線在上游安靜
 * 超過設定值之後真的會補 ping —— 不必等真正的 60 秒。
 */
test('端到端：provider 線安靜超過 pingIdleMs 就補 ping（不必等 60 秒）', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('event: message_start\ndata: {}\n\n')
    // 故意安靜 300ms，比下面設的 80ms pingIdleMs 久很多
    setTimeout(() => {
      res.write('event: message_stop\ndata: {}\n\n')
      res.end()
    }, 300)
  })
  const upstreamUrl = await listen(upstream)

  const { defaultProvider, defaultRule, normalizeConfig } = await import('../src/config.mjs')
  const config = normalizeConfig({
    providers: [defaultProvider({ id: 'p', baseUrl: upstreamUrl, model: 'm' })],
    rules: [defaultRule({ match: 'subagent', providerId: 'p' })],
  })
  const logStore = new TrafficLog(10)
  const proxy = createProxyServer(() => config, logStore, {
    getRuntime: () => ({ boundProxyPort: 8787 }),
    pingIdleMs: 80,
  })
  const proxyUrl = await listen(proxy)

  try {
    const res = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-agent-id': 'a' },
      body: JSON.stringify({ ...BASE_BODY, stream: true }),
    })
    const text = await res.text()
    assert.match(text, /event: ping/, '安靜超過 pingIdleMs 就該補 ping，不必等真的 60 秒')
    assert.equal(logStore.list()[0].pings > 0, true)
  } finally {
    proxy.close()
    upstream.close()
  }
})
