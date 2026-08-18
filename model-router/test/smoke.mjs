import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before } from 'node:test'
import {
  createProxyServer, TrafficLog, SessionCwd, rewriteBodyForProvider, rewriteModel,
  summarizeUpstreamError, findStreamError, parseRetryAfter, retryDelay, sseError,
} from '../src/proxy.mjs'
import { globMatch, describeRequest, resolveRoute, resolveModel, extractCwd, PASSTHROUGH_ID } from '../src/routing.mjs'
import { normalizeConfig, defaultProvider, defaultRule, toClientConfig, fromClientConfig, KEEP_SECRET } from '../src/config.mjs'
import { runProbes } from '../src/probe.mjs'

// ── 假上游：記下收到什麼，並能吐 SSE ────────────────────────────────
let received = []
/** 排給假上游的失敗劇本，每次請求消耗一筆。空的就正常回應。 */
let failPlan = []
let upstream
let upstreamUrl
let proxy
let proxyUrl
let config
let logStore

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? JSON.parse(raw) : null
    received.push({ url: req.url, headers: req.headers, body })

    // 演出 Anthropic 被節流時的回應：帶 retry-after，body 是它自己的錯誤描述
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

    // 200 開頭、串流中途才吐 error 事件：上游過載時的真實行為
    if (req.url.includes('fail=stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: message_start\ndata: {}\n\n')
      res.write('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n')
      res.end()
      return
    }

    // 串流送到一半連線就斷，模擬被中間的東西掐掉
    if (req.url.includes('fail=midstream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: message_start\ndata: {}\n\n')
      setTimeout(() => res.destroy(), 50)
      return
    }

    const planned = failPlan.shift()
    if (planned) {
      // 連回應都還沒開始就被切斷，模擬 VPN / 中間設備掐線
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
      // 隔一段時間才送第二塊，用來證明 proxy 沒有把整個回應緩衝起來
      setTimeout(() => {
        res.write('event: message_stop\ndata: {}\n\n')
        res.end()
      }, 150)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'msg_1', model: body?.model ?? null, content: [{ type: 'text', text: 'ok' }] }))
  })
  upstreamUrl = await listen(upstream)

  config = normalizeConfig({
    passthrough: { baseUrl: upstreamUrl },
    providers: [
      defaultProvider({ id: 'kimi', label: 'Kimi', baseUrl: upstreamUrl, apiKey: 'sk-moonshot', model: 'kimi-k3' }),
      defaultProvider({ id: 'other', label: 'Other', baseUrl: upstreamUrl, apiKey: 'sk-other', model: 'glm-5', authStyle: 'x-api-key', dropBeta: false }),
      defaultProvider({
        id: 'strict', label: 'Strict', baseUrl: upstreamUrl, apiKey: 'sk-strict', model: 'picky-1',
        dropFields: ['thinking', 'context_management', 'output_config'],
      }),
    ],
    rules: [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })],
    // 測試不需要真的等退避，只驗證重送的次數與時機
    retry: { attempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
  })

  logStore = new TrafficLog()
  proxy = createProxyServer(() => config, logStore)
  proxyUrl = await listen(proxy)
})

after(() => {
  proxy?.close()
  upstream?.close()
})

async function post(headers, body, query = 'beta=true') {
  received = []
  const res = await fetch(`${proxyUrl}/v1/messages?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify(body),
  })
  return res
}

const BASE_BODY = {
  model: 'claude-opus-5',
  max_tokens: 4096,
  messages: [{ role: 'user', content: 'hi' }],
  thinking: { type: 'adaptive' },
  context_management: { edits: [] },
  output_config: { effort: 'high' },
}

const SUBSCRIPTION_HEADERS = {
  authorization: 'Bearer sk-ant-oat-fake',
  'anthropic-beta': 'oauth-2025-04-20,context-management-2025-06-27',
  'x-claude-code-session-id': 'sess-1',
}

// ── 路由 ──────────────────────────────────────────────────────────
test('主對話原樣轉發，訂閱憑證與 anthropic-beta 完整保留', async () => {
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)
  assert.equal(res.status, 200)
  await res.text()

  const [hit] = received
  assert.equal(hit.headers.authorization, 'Bearer sk-ant-oat-fake', '訂閱 OAuth token 必須原樣送達')
  assert.equal(hit.headers['anthropic-beta'], SUBSCRIPTION_HEADERS['anthropic-beta'], 'OAuth capability 在這個 header 裡，剝掉會 401')
  assert.equal(hit.url, '/v1/messages?beta=true', 'query string 要保留')
  assert.deepEqual(hit.body, BASE_BODY, '主對話的 body 一個字都不能動')
})

test('子 agent 改導向 provider 並改寫 model，但預設不動任何 body 欄位', async () => {
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'agent-1' }, BASE_BODY)
  assert.equal(res.status, 200)
  await res.text()

  const [hit] = received
  assert.equal(hit.body.model, 'kimi-k3')
  assert.equal(hit.headers.authorization, 'Bearer sk-moonshot', '要換成 provider 自己的 key')
  assert.equal(hit.headers['anthropic-beta'], undefined, 'dropBeta 開著就不該帶過去')
  // 剝掉 output_config 會讓 /effort 靜默失效，請求照樣 200 —— 預設絕不能這樣做
  assert.deepEqual(hit.body.output_config, { effort: 'high' }, 'effort 必須原封不動送到 provider')
  assert.deepEqual(hit.body.thinking, { type: 'adaptive' })
  assert.deepEqual(hit.body.context_management, { edits: [] })
  assert.deepEqual(hit.body.messages, BASE_BODY.messages, 'messages 不能動')
})

test('流量記錄帶上 cwd 與 effort，但不留 prompt 內容', async () => {
  const body = {
    ...BASE_BODY,
    system: [{ type: 'text', text: '# Environment\n - Primary working directory: /srv/app\n' }],
  }
  await (await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, body)).text()

  const entry = logStore.list()[0]
  assert.equal(entry.sessionId, 'sess-1', 'cwd 認不出來時只剩 session id 能分辨來源')
  assert.equal(entry.cwd, '/srv/app')
  assert.equal(entry.effort, 'high')
  assert.equal(entry.sentEffort, 'high')
  assert.ok(!JSON.stringify(entry).includes('Environment'), 'system prompt 不能被記進流量記錄')
})

test('子 agent 沒有 cwd，靠同一個 session id 從主對話繼承', async () => {
  const withEnv = {
    ...BASE_BODY,
    system: [{ type: 'text', text: '# Environment\n - Primary working directory: /srv/inherited\n' }],
  }
  // 主對話先跑一趟把 cwd 記下來
  await (await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-session-id': 'sess-A' }, withEnv)).text()
  // 子 agent 的 system prompt 不含 Environment 區段（實測 v2.1.227）
  await (await post(
    { ...SUBSCRIPTION_HEADERS, 'x-claude-code-session-id': 'sess-A', 'x-claude-code-agent-id': 'a1' },
    BASE_BODY,
  )).text()

  assert.equal(logStore.list()[0].kind, 'subagent')
  assert.equal(logStore.list()[0].cwd, '/srv/inherited', '子 agent 應該繼承到主對話的 cwd')

  // 不同 session 不能互相污染
  await (await post(
    { ...SUBSCRIPTION_HEADERS, 'x-claude-code-session-id': 'sess-B', 'x-claude-code-agent-id': 'a2' },
    BASE_BODY,
  )).text()
  assert.equal(logStore.list()[0].cwd, null, '別的 session 不該撿到不屬於它的 cwd')
})

test('SessionCwd 到達上限時丟掉最久沒用到的', () => {
  const s = new SessionCwd(2)
  s.remember('a', '/a')
  s.remember('b', '/b')
  s.lookup('a')            // a 變成最近使用
  s.remember('c', '/c')    // 該被淘汰的是 b
  assert.equal(s.lookup('a'), '/a')
  assert.equal(s.lookup('b'), null)
  assert.equal(s.lookup('c'), '/c')
  s.remember('d', null)
  s.remember(null, '/x')
  assert.equal(s.lookup(null), null)
})

test('明確設定 dropFields 的 provider 才剝除欄位', async () => {
  config.rules = [defaultRule({ match: 'subagent', providerId: 'strict' })]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'agent-1' }, BASE_BODY)
  await res.text()

  const [hit] = received
  assert.equal(hit.body.model, 'picky-1')
  for (const field of ['thinking', 'context_management', 'output_config']) {
    assert.ok(!(field in hit.body), `${field} 應該被剝除`)
  }
  config.rules = [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })]
})

test('x-api-key 認證與保留 anthropic-beta 的 provider', async () => {
  config.rules = [defaultRule({ match: 'subagent', providerId: 'other' })]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)
  await res.text()

  const [hit] = received
  assert.equal(hit.headers['x-api-key'], 'sk-other')
  assert.equal(hit.headers.authorization, undefined)
  assert.equal(hit.headers['anthropic-beta'], SUBSCRIPTION_HEADERS['anthropic-beta'])
  config.rules = [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })]
})

test('modelGlob 沒命中就落回訂閱', async () => {
  config.rules = [defaultRule({ match: 'subagent', modelGlob: 'claude-haiku*', providerId: 'kimi' })]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)
  await res.text()
  assert.equal(received[0].body.model, 'claude-opus-5', 'glob 不合就不該改寫')
  config.rules = [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })]
})

// ── 指向 passthrough 的規則 ────────────────────────────────────────
test('規則指向 passthrough 時走訂閱線，不帶 provider 憑證', async () => {
  // 第三方配額快用完，把子 agent 整批切回訂閱的情境
  config.rules = [defaultRule({ id: 'back', match: 'subagent', providerId: PASSTHROUGH_ID })]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)
  assert.equal(res.status, 200)
  await res.text()

  const [hit] = received
  assert.equal(hit.headers.authorization, 'Bearer sk-ant-oat-fake', '訂閱 OAuth token 必須原樣送達')
  assert.equal(hit.headers['anthropic-beta'], SUBSCRIPTION_HEADERS['anthropic-beta'], 'passthrough 不受 dropBeta 影響')
  assert.deepEqual(hit.body, BASE_BODY, '沒設 modelOverride 就一個字都不能動')
  assert.equal(logStore.list()[0].ruleId, 'back', '要看得出是規則命中，不是沒命中掉下來的')
  config.rules = [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })]
})

test('passthrough + modelOverride 只換 model，其餘 body 欄位原封不動', async () => {
  // 主對話開 fable 時 Workflow 的子 agent 也會是 fable，用這條規則拉回 opus
  config.rules = [defaultRule({ match: 'subagent', providerId: PASSTHROUGH_ID, modelOverride: 'claude-opus-5' })]
  const res = await post(
    { ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' },
    { ...BASE_BODY, model: 'claude-fable-5' },
  )
  assert.equal(res.status, 200)
  await res.text()

  const [hit] = received
  assert.equal(hit.body.model, 'claude-opus-5')
  assert.equal(hit.headers.authorization, 'Bearer sk-ant-oat-fake', '改 model 不代表要換憑證')
  assert.deepEqual(hit.body.output_config, { effort: 'high' }, '訂閱線的 effort 絕不能被順手改掉')
  assert.deepEqual(hit.body.thinking, BASE_BODY.thinking)
  assert.deepEqual(hit.body.context_management, BASE_BODY.context_management)
  assert.deepEqual(hit.body.messages, BASE_BODY.messages)

  const entry = logStore.list()[0]
  assert.equal(entry.sentModel, 'claude-opus-5')
  assert.equal(entry.sentEffort, 'high', '沒有靜默降級')
  assert.deepEqual(entry.changes, ['model claude-fable-5 → claude-opus-5'])
  config.rules = [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })]
})

test('主對話不受指向 passthrough 的子 agent 規則影響', async () => {
  config.rules = [defaultRule({ match: 'subagent', providerId: PASSTHROUGH_ID, modelOverride: 'claude-opus-5' })]
  await (await post(SUBSCRIPTION_HEADERS, BASE_BODY)).text()
  assert.deepEqual(received[0].body, BASE_BODY, '主對話還是你在對話框裡選的那個模型')
  config.rules = [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })]
})

test('規則的 modelOverride 蓋過 provider 自己的 model', async () => {
  config.rules = [defaultRule({ match: 'subagent', providerId: 'kimi', modelOverride: 'kimi-k3(high)' })]
  await (await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)).text()
  assert.equal(received[0].body.model, 'kimi-k3(high)')
  assert.equal(received[0].headers.authorization, 'Bearer sk-moonshot', 'provider 的其他設定照舊')
  config.rules = [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })]
})

test('指向不存在的 provider 時退回訂閱，而不是讓請求失敗', async () => {
  config.rules = [defaultRule({ match: 'subagent', providerId: 'gone' })]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)
  assert.equal(res.status, 200)
  await res.text()
  assert.equal(received[0].body.model, 'claude-opus-5')
  config.rules = [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })]
})

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

test('上游被節流時原樣轉出，並把 retry-after 與上游的說法記進流量記錄', async () => {
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY, 'fail=429')

  assert.equal(res.status, 429)
  assert.equal(res.headers.get('retry-after'), '146', 'Claude Code 靠這個 header 決定隔多久重試，吃掉它就變成盲目重試')
  assert.deepEqual(await res.json(), {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your rate limit' },
  }, '錯誤 body 要一個字不差地送到 client')

  const entry = logStore.list()[0]
  assert.equal(entry.status, 429)
  assert.equal(entry.retryAfter, '146')
  assert.equal(entry.requestId, 'req_fake_1')
  assert.match(entry.detail, /rate_limit_error/, '只記一個 429 等於查不出原因，上游的說法要留著')
  assert.equal(entry.attempts, 1, 'retry-after 要等 146 秒，這種等待不該由 router 扛著不放')
})

test('流量記錄留下請求形狀，但一樣不留內容', async () => {
  await (await post(SUBSCRIPTION_HEADERS, { ...BASE_BODY, stream: true, system: 'be a helpful pirate' })).text()

  const entry = logStore.list()[0]
  assert.deepEqual(entry.shape, { messages: 1, system: true, stream: true, maxTokens: 4096 })
  assert.ok(!JSON.stringify(entry).includes('pirate'), 'system prompt 不能被形狀帶進流量記錄')
})

test('200 的串流裡夾著 error 事件時，流量記錄不能記成成功', async () => {
  const res = await post(SUBSCRIPTION_HEADERS, { ...BASE_BODY, stream: true }, 'fail=stream')
  assert.equal(res.status, 200)
  assert.match(await res.text(), /overloaded_error/, '串流內容要原樣送到 client')

  const entry = logStore.list()[0]
  assert.equal(entry.status, 200)
  assert.match(entry.detail, /overloaded_error: Overloaded/, '只記一個 200 的話，這種失敗在流量記錄上看不出來')
})

test('findStreamError 認得 error 事件，也不會把正常事件當成錯誤', () => {
  const evt = Buffer.from('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom"}}\n')
  assert.equal(findStreamError(evt), 'api_error: boom')
  assert.equal(findStreamError(Buffer.from('event: message_delta\ndata: {"type":"message_delta"}\n')), null)
})

test('上游暫時性失敗時 router 自己重送，client 完全不知道發生過', async () => {
  failPlan = [{ status: 529 }, { status: 529 }]
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)

  assert.equal(res.status, 200, '重送成功就該是一次乾淨的 200，不該讓 Claude Code 看到 529')
  await res.text()
  assert.equal(failPlan.length, 0, '兩次失敗都要被消耗掉')

  const entry = logStore.list()[0]
  assert.equal(entry.attempts, 3, '一次原始 + 兩次重送')
  assert.deepEqual(entry.retries, ['529', '529'], '重送過幾次、為什麼重送，記錄要留著')
  assert.equal(entry.status, 200)
})

test('重送用完還是失敗，就把上游最後一次的回應原樣交回去', async () => {
  failPlan = [{ status: 529 }, { status: 529 }, { status: 529 }]
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)

  assert.equal(res.status, 529, '扛不住就要交回去，不能自己編一個別的狀態')
  assert.equal((await res.json()).error.type, 'overloaded_error', '上游的錯誤 body 要完整送到 client')
  assert.equal(failPlan.length, 0)

  const entry = logStore.list()[0]
  assert.equal(entry.attempts, 3)
  assert.match(entry.detail, /overloaded_error/)
})

test('連線層被切斷也會重送 —— VPN 掐線跟上游 5xx 一樣要扛', async () => {
  failPlan = [{ hangup: true }]
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)

  assert.equal(res.status, 200)
  await res.text()

  const entry = logStore.list()[0]
  assert.equal(entry.attempts, 2, '斷線一次、重送一次就該成功')
  assert.equal(entry.retries.length, 1)
  assert.ok(!/^\d+$/.test(entry.retries[0]), `連線層失敗記的是錯誤訊息不是狀態碼，實際 ${entry.retries[0]}`)
})

test('請求本身有問題的 4xx 不重送', async () => {
  failPlan = [{ status: 400 }]
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)

  assert.equal(res.status, 400)
  await res.text()
  assert.equal(logStore.list()[0].attempts, 1, '400 重送幾次都一樣，浪費時間而已')
})

test('串流開到一半斷線時，補一個合法的 SSE error 事件收尾', async () => {
  const res = await post(SUBSCRIPTION_HEADERS, { ...BASE_BODY, stream: true }, 'fail=midstream')
  assert.equal(res.status, 200)

  const text = await res.text()
  assert.match(text, /message_start/, '已經送到 client 的部分要保留')
  assert.match(text, /event: error/, '斷掉的串流要有收尾 —— 只是被切斷的話 client 連為什麼都拿不到')
  assert.match(text, /model-router/)
})

test('findStreamError 吃得下 fetch 吐出來的 Uint8Array', () => {
  const LF = String.fromCharCode(10)
  const evt = `event: error${LF}data: {"type":"error","error":{"type":"api_error","message":"boom"}}${LF}`
  // proxy 在串流迴圈裡拿到的每一塊是 Uint8Array，不是 Buffer；兩者的 indexOf 行為不一樣
  assert.equal(findStreamError(new Uint8Array(Buffer.from(evt))), 'api_error: boom')
})

test('連線預熱探針有回應', async () => {
  const res = await fetch(`${proxyUrl}/api/hello`, { method: 'HEAD' })
  assert.equal(res.status, 200)
})

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

test('sseError 產生合法的 SSE 事件框', () => {
  const frame = sseError('boom')
  assert.ok(frame.startsWith('event: error'))
  assert.ok(frame.endsWith(String.fromCharCode(10, 10)), 'SSE 事件要用空行收尾，少一個 client 就不會處理')
  const payload = JSON.parse(frame.split(String.fromCharCode(10))[1].replace('data: ', ''))
  assert.equal(payload.error.type, 'api_error')
  assert.match(payload.error.message, /boom/)
})

test('globMatch', () => {
  assert.ok(globMatch('*', 'anything'))
  assert.ok(globMatch('', 'anything'))
  assert.ok(globMatch('claude-*', 'claude-opus-5'))
  assert.ok(globMatch('*opus*', 'claude-opus-5'))
  assert.ok(!globMatch('claude-*', 'kimi-k3'))
  assert.ok(!globMatch('claude-haiku*', 'claude-opus-5'), '. 之類的字元不可被當成萬用')
})

test('describeRequest 依 header 判定來源', () => {
  assert.equal(describeRequest({}, {}).kind, 'main')
  assert.equal(describeRequest({ 'x-claude-code-agent-id': 'a' }, {}).kind, 'subagent')
  assert.equal(
    describeRequest({ 'x-claude-code-agent-id': 'a', 'x-claude-code-parent-agent-id': 'p' }, {}).kind,
    'nested',
  )
})

test('extractCwd 從 system prompt 的 Environment 區段挖出 cwd', () => {
  // 實測 v2.1.227：cwd 只在最後一塊 system 裡，header 完全沒有這項
  const system = [
    { type: 'text', text: 'You are Claude Code, Anthropic official CLI.' },
    { type: 'text', text: 'some other block mentioning directory: nope' },
    {
      type: 'text',
      text: '# Environment\nYou have been invoked in the following environment:\n'
        + ' - Primary working directory: C:\\Users\\Roxy\\orca\\projects\\bridge\n'
        + ' - Is a git repository: true\n - Platform: win32\n',
    },
  ]
  assert.equal(extractCwd({ system }), 'C:\\Users\\Roxy\\orca\\projects\\bridge')
  assert.equal(extractCwd({ system: '- Primary working directory: /home/x/proj' }), '/home/x/proj')
  assert.equal(extractCwd({ system: [{ type: 'text', text: '沒有環境區段' }] }), null)
  assert.equal(extractCwd({}), null)
  assert.equal(extractCwd(null), null)
})

test('describeRequest 抽出 effort 與 thinking 型態', () => {
  // 實測 Claude Code v2.1.227：--effort xhigh 送的是 output_config.effort，thinking 只帶 type
  const ctx = describeRequest({}, {
    model: 'claude-opus-5',
    thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort: 'xhigh' },
  })
  assert.equal(ctx.effort, 'xhigh')
  assert.equal(ctx.thinking, 'adaptive')
  assert.equal(describeRequest({}, { model: 'x' }).effort, null)
})

test('預設 provider 不剝除任何欄位', () => {
  assert.deepEqual(defaultProvider().dropFields, [], '預設剝除會讓 /effort 靜默失效')
  assert.deepEqual(normalizeConfig({ providers: [{ id: 'p', baseUrl: 'https://x' }] }).providers[0].dropFields, [])
})

test('subagent 規則涵蓋巢狀，nested 規則不涵蓋第一層', () => {
  const cfg = normalizeConfig({
    providers: [defaultProvider({ id: 'k', baseUrl: 'https://x', model: 'm' })],
    rules: [defaultRule({ match: 'nested', providerId: 'k' })],
  })
  assert.equal(resolveRoute(cfg, describeRequest({ 'x-claude-code-agent-id': 'a' }, {})).kind, 'passthrough')
  assert.equal(
    resolveRoute(cfg, describeRequest({ 'x-claude-code-agent-id': 'a', 'x-claude-code-parent-agent-id': 'p' }, {})).kind,
    'provider',
  )

  cfg.rules = [defaultRule({ match: 'subagent', providerId: 'k' })]
  assert.equal(resolveRoute(cfg, describeRequest({ 'x-claude-code-agent-id': 'a' }, {})).kind, 'provider')
})

test('resolveRoute 認得指向 passthrough 的規則，並和「沒命中」區分開', () => {
  const cfg = normalizeConfig({
    providers: [defaultProvider({ id: 'k', baseUrl: 'https://x', model: 'm' })],
    rules: [defaultRule({ id: 'back', match: 'subagent', providerId: PASSTHROUGH_ID })],
  })
  const sub = describeRequest({ 'x-claude-code-agent-id': 'a' }, { model: 'claude-opus-5' })

  const hit = resolveRoute(cfg, sub)
  assert.equal(hit.kind, 'passthrough')
  assert.equal(hit.rule?.id, 'back')
  assert.equal(resolveRoute(cfg, describeRequest({}, {})).rule, null, '沒命中就沒有 rule')
})

test('resolveModel 的優先序：規則 > provider > 原樣', () => {
  const provider = defaultProvider({ id: 'k', baseUrl: 'https://x', model: 'kimi-k3' })
  const rule = defaultRule({ providerId: 'k' })
  assert.equal(resolveModel({ kind: 'provider', provider, rule }, 'claude-opus-5'), 'kimi-k3')
  assert.equal(
    resolveModel({ kind: 'provider', provider, rule: { ...rule, modelOverride: 'glm-5' } }, 'claude-opus-5'),
    'glm-5',
  )
  // 指向訂閱時沒有 provider 可以退，改寫全靠規則
  assert.equal(resolveModel({ kind: 'passthrough', rule: null }, 'claude-fable-5'), 'claude-fable-5')
  assert.equal(
    resolveModel({ kind: 'passthrough', rule: { modelOverride: 'claude-opus-5' } }, 'claude-fable-5'),
    'claude-opus-5',
  )
  assert.equal(resolveModel({ kind: 'passthrough', rule: null }, null), null)
})

test('provider 不能佔用 passthrough 這個保留 id', () => {
  const cfg = normalizeConfig({ providers: [{ id: PASSTHROUGH_ID, baseUrl: 'https://x' }] })
  assert.notEqual(cfg.providers[0].id, PASSTHROUGH_ID, '否則規則就沒辦法指回訂閱了')
})

test('rewriteModel 不改動原物件，也不會無故重建 body', () => {
  const original = { model: 'claude-fable-5', messages: [] }
  const changed = rewriteModel(original, 'claude-opus-5')
  assert.equal(original.model, 'claude-fable-5', '輸入必須維持不變')
  assert.equal(changed.body.model, 'claude-opus-5')
  assert.deepEqual(changed.changes, ['model claude-fable-5 → claude-opus-5'])

  // 同名或沒指定時回傳原物件，proxy 就知道不必重新序列化訂閱流量
  assert.equal(rewriteModel(original, 'claude-fable-5').body, original)
  assert.deepEqual(rewriteModel(original, null).changes, [])
  assert.deepEqual(rewriteModel(null, 'x'), { body: null, changes: [] })
})

test('rewriteBodyForProvider 不改動原物件', () => {
  const original = { model: 'claude-opus-5', max_tokens: 9999, thinking: {} }
  const snapshot = structuredClone(original)
  const { body, changes } = rewriteBodyForProvider(
    original,
    defaultProvider({ model: 'kimi-k3', maxOutputTokens: 8192, dropFields: ['thinking'] }),
  )
  assert.deepEqual(original, snapshot, '輸入必須維持不變')
  assert.equal(body.model, 'kimi-k3')
  assert.equal(body.max_tokens, 8192)
  assert.ok(!('thinking' in body))
  assert.ok(changes.length >= 3)
})

// ── 設定序列化 ────────────────────────────────────────────────────
test('API key 不外流到前端，且未修改時不會被清掉', () => {
  const cfg = normalizeConfig({ providers: [defaultProvider({ id: 'k', baseUrl: 'https://x', apiKey: 'sk-secret-1234' })] })
  const client = toClientConfig(cfg)
  assert.equal(client.providers[0].apiKey, KEEP_SECRET)
  assert.ok(!JSON.stringify(client).includes('sk-secret-1234'), '遮罩後不能出現完整 key')
  assert.equal(client.providers[0].apiKeyHint, 'sk-s••••1234')

  const round = fromClientConfig(client, cfg)
  assert.equal(round.providers[0].apiKey, 'sk-secret-1234', '前端沒改就要還原')

  client.providers[0].apiKey = 'sk-new'
  assert.equal(fromClientConfig(client, cfg).providers[0].apiKey, 'sk-new', '前端改了就要採用新值')
})

test('normalizeConfig 修掉壞資料而不是拋錯', () => {
  const cfg = normalizeConfig({ proxyPort: 'abc', providers: 'nope', rules: [{ match: '???' }] })
  assert.equal(cfg.proxyPort, 8787)
  assert.ok(Array.isArray(cfg.providers))
  assert.equal(cfg.rules[0].match, 'subagent')
  assert.equal(cfg.passthrough.baseUrl, 'https://api.anthropic.com')
})

// ── 思考檔位測試 ──────────────────────────────────────────────────

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

test('思考檔位：dropFields 含 output_config 時直接判失敗，不必打上游', async () => {
  await withUpstream(
    (_body, res) => replyJson(res, {}),
    async (url, seen) => {
      const provider = defaultProvider({ baseUrl: url, model: 'm', dropFields: ['output_config'] })
      const [result] = (await runProbes(provider, { tests: ['effort'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /output_config/)
      assert.equal(seen.length, 0, '本地就能判定的事情不該浪費一次上游呼叫')
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

test('思考檔位：五檔全收時送出完整枚舉，並比出兩端的思考量', async () => {
  await withUpstream(
    (body, res) =>
      replyJson(res, {
        // 讓思考量隨檔位變化，比值才算得出來
        content: [
          { type: 'thinking', thinking: 'x'.repeat(body.output_config.effort === 'low' ? 100 : 500) },
          { type: 'text', text: 'ok' },
        ],
        stop_reason: 'end_turn',
      }),
    async (url, seen) => {
      const provider = defaultProvider({ baseUrl: url, model: 'm' })
      const [result] = (await runProbes(provider, { tests: ['effort'] })).results
      assert.equal(result.ok, true)
      assert.deepEqual(
        seen.slice(0, 5).map((b) => b.output_config.effort),
        ['low', 'medium', 'high', 'xhigh', 'max'],
        '要照 Claude Code 的枚舉逐一測，不能只挑兩端',
      )
      assert.equal(seen.length, 7, '五次探針加兩次量測')
      // 探針要送真實的請求形狀，否則測不出上游對整包的寬容度
      assert.equal(seen[0].thinking.type, 'adaptive')
      assert.ok(seen[0].context_management, 'context_management 也要一起送')
      assert.match(result.detail, /5\.00×/)
    },
  )
})

test('思考檔位：上游不吐 thinking block 時退回比 output_tokens，且不誤判成失敗', async () => {
  await withUpstream(
    (body, res) =>
      replyJson(res, {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { output_tokens: body.output_config.effort === 'low' ? 10 : 90 },
      }),
    async (url) => {
      const provider = defaultProvider({ baseUrl: url, model: 'm' })
      const [result] = (await runProbes(provider, { tests: ['effort'] })).results
      assert.equal(result.ok, true)
      assert.match(result.detail, /tok/)
    },
  )
})
