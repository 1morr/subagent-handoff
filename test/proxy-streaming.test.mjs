import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { createProxyServer, TrafficLog, findStreamError, createUsageTap } from '../src/proxy.mjs'
import { createHarness, makePost, listen, BASE_BODY, SUBSCRIPTION_HEADERS } from './helpers.mjs'
import { USAGE_STREAM } from './fixtures/fake-upstream.mjs'

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

test('串流開到一半上游斷線時，client 這頭也照樣斷線，不補合成的 error 事件', async () => {
  for (const headers of [SUBSCRIPTION_HEADERS, { ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }]) {
    const res = await post(headers, { ...BASE_BODY, stream: true }, 'fail=midstream')
    assert.equal(res.status, 200)

    const received = []
    // 實測 Claude Code 2.1.274：斷線會被當成連線錯誤、重送串流；收到 api_error 事件卻會改發非串流請求
    await assert.rejects(async () => {
      for await (const chunk of res.body) received.push(Buffer.from(chunk))
    }, 'client 要看到連線中斷，而不是一個正常結束的串流')
    const text = Buffer.concat(received).toString('utf8')
    assert.match(text, /message_start/, '已經送到 client 的部分要保留')
    assert.doesNotMatch(text, /event: error/)
    assert.ok(harness.logStore.list()[0].error, '流量記錄要留下斷線原因')
  }
})

test('連線預熱探針有回應', async () => {
  const res = await fetch(`${harness.proxyUrl}/api/hello`, { method: 'HEAD' })
  assert.equal(res.status, 200)
})

test('body 超過上限時當場擋下來，一個 byte 都不往上游送', async () => {
  const logStore = new TrafficLog(10)
  const proxy = createProxyServer(harness.getConfig, logStore, {
    getRuntime: () => ({ boundProxyPort: 8787 }),
    passthroughBaseUrl: harness.upstreamUrl,
    maxRequestBytes: 2000,
  })
  try {
    const res = await makePost(await listen(proxy), harness.upstream)(SUBSCRIPTION_HEADERS, {
      ...BASE_BODY,
      messages: [{ role: 'user', content: 'x'.repeat(8000) }],
    })

    assert.equal(res.status, 413)
    assert.equal((await res.json()).error.type, 'invalid_request_error')
    assert.equal(harness.upstream.state.received.length, 0, '收不完的請求絕不能往上游送')

    const entry = logStore.list()[0]
    assert.equal(entry.status, 413)
    assert.equal(entry.target, null, '沒送出去就沒有去向')
    assert.equal(entry.providerId, null)
    assert.match(entry.error, /exceeds the .* byte limit/)
    assert.equal(entry.kind, 'main', 'kind 只看 header，body 收不完也判得出來')
  } finally {
    proxy.close()
  }
})

test('請求走完才落檔，落下去的 entry 已經是完整的', async () => {
  harness.finished.length = 0
  await (await post(SUBSCRIPTION_HEADERS, BASE_BODY)).text()

  assert.equal(harness.finished.length, 1)
  const entry = harness.finished[0]
  assert.equal(entry.status, 200)
  assert.ok(entry.ms != null, '耗時是在 finally 才補的，太早落檔就會是 null')
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
  assert.equal(entry.target, null, '沒送出去就沒有去向')
  assert.equal(entry.providerId, null)
  assert.match(entry.error, /failed to read request body/)
})

// ── token 用量與快取命中 ───────────────────────────────────────────

test('createUsageTap：切在 JSON 與多位元組字元中間也讀得出來，message_delta 的累計值蓋過先到的', () => {
  const bytes = Buffer.from(USAGE_STREAM)
  const tap = createUsageTap()
  for (let at = 0; at < bytes.length; at += 7) tap.push(bytes.subarray(at, at + 7))
  assert.deepEqual(tap.result(), { input: 223, cacheRead: 3712, cacheWrite: 40, output: 16 })
})

test('createUsageTap：DeepSeek 在 message_delta 裡把四個數字重送一次，照樣收', () => {
  const tap = createUsageTap()
  tap.push(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3935,"output_tokens":0}}}\n\n'))
  tap.push(Buffer.from('event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":223,"cache_read_input_tokens":3712,"cache_creation_input_tokens":0,"output_tokens":11}}'))
  assert.deepEqual(tap.result(), { input: 223, cacheRead: 3712, cacheWrite: 0, output: 11 })
})

test('createUsageTap：上游沒回報用量就是 null，不捏造 0', () => {
  const tap = createUsageTap()
  tap.push(Buffer.from('event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n'))
  assert.equal(tap.result(), null)
})

test('兩條線都把 token 用量記進流量記錄，而且轉發的 bytes 一個都沒動', async () => {
  for (const headers of [SUBSCRIPTION_HEADERS, { ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }]) {
    const res = await post(headers, { ...BASE_BODY, stream: true }, 'beta=true&usage=split')
    assert.equal(await res.text(), USAGE_STREAM, '讀 usage 只能是旁觀，不能改到 client 收到的串流')

    const entry = harness.logStore.list()[0]
    assert.deepEqual(entry.usage, { input: 223, cacheRead: 3712, cacheWrite: 40, output: 16 })
    assert.ok(Object.values(entry.usage).every(Number.isFinite), 'usage 只能是數字')
    assert.ok(!JSON.stringify(entry).includes('快取命中'), '回應內容不能被記進流量記錄')
  }
})

test('兩條線的串流都一個合成 byte 都不加', async () => {
  for (const headers of [SUBSCRIPTION_HEADERS, { ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }]) {
    const res = await post(headers, { ...BASE_BODY, stream: true })
    assert.equal(
      await res.text(),
      'event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n',
      '上游吐什麼 client 就收到什麼，router 不往串流裡摻東西',
    )
  }
})
