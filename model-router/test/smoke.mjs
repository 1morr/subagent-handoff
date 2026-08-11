import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before } from 'node:test'
import { createProxyServer, TrafficLog, rewriteBodyForProvider } from '../src/proxy.mjs'
import { globMatch, describeRequest, resolveRoute } from '../src/routing.mjs'
import { normalizeConfig, defaultProvider, defaultRule, toClientConfig, fromClientConfig, KEEP_SECRET } from '../src/config.mjs'

// ── 假上游：記下收到什麼，並能吐 SSE ────────────────────────────────
let received = []
let upstream
let upstreamUrl
let proxy
let proxyUrl
let config

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
    ],
    rules: [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })],
  })

  proxy = createProxyServer(() => config, new TrafficLog())
  proxyUrl = await listen(proxy)
})

after(() => {
  proxy?.close()
  upstream?.close()
})

async function post(headers, body) {
  received = []
  const res = await fetch(`${proxyUrl}/v1/messages?beta=true`, {
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

test('子 agent 改導向 provider，並改寫 model 與剝除不相容欄位', async () => {
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'agent-1' }, BASE_BODY)
  assert.equal(res.status, 200)
  await res.text()

  const [hit] = received
  assert.equal(hit.body.model, 'kimi-k3')
  assert.equal(hit.headers.authorization, 'Bearer sk-moonshot', '要換成 provider 自己的 key')
  assert.equal(hit.headers['anthropic-beta'], undefined, 'dropBeta 開著就不該帶過去')
  for (const field of ['thinking', 'context_management', 'output_config']) {
    assert.ok(!(field in hit.body), `${field} 應該被剝除`)
  }
  assert.deepEqual(hit.body.messages, BASE_BODY.messages, 'messages 不能動')
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

test('連線預熱探針有回應', async () => {
  const res = await fetch(`${proxyUrl}/api/hello`, { method: 'HEAD' })
  assert.equal(res.status, 200)
})

// ── 純函數 ────────────────────────────────────────────────────────
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

test('rewriteBodyForProvider 不改動原物件', () => {
  const original = { model: 'claude-opus-5', max_tokens: 9999, thinking: {} }
  const snapshot = structuredClone(original)
  const { body, changes } = rewriteBodyForProvider(original, defaultProvider({ model: 'kimi-k3', maxOutputTokens: 8192 }))
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
