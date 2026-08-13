import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before } from 'node:test'
import { createProxyServer, TrafficLog, SessionCwd, rewriteBodyForProvider, rewriteModel } from '../src/proxy.mjs'
import { globMatch, describeRequest, resolveRoute, resolveModel, extractCwd, PASSTHROUGH_ID } from '../src/routing.mjs'
import { normalizeConfig, defaultProvider, defaultRule, toClientConfig, fromClientConfig, KEEP_SECRET } from '../src/config.mjs'

// ── 假上游：記下收到什麼，並能吐 SSE ────────────────────────────────
let received = []
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
  })

  logStore = new TrafficLog()
  proxy = createProxyServer(() => config, logStore)
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
