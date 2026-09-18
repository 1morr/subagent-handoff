import test, { before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteBodyForProvider, rewriteModel, rewriteToolPatterns, SessionCwd } from '../src/proxy.mjs'
import {
  globMatch, describeRequest, resolveRoute, resolveModel, extractCwd, PASSTHROUGH_ID,
} from '../src/routing.mjs'
import { normalizeConfig, defaultConfig, defaultProvider, defaultRule } from '../src/config.mjs'
import { createHarness, makePost, BASE_BODY, SUBSCRIPTION_HEADERS } from './helpers.mjs'

const DEFAULT_RULES = () => [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })]

let harness, post

before(async () => {
  harness = await createHarness()
  post = makePost(harness.proxyUrl, harness.upstream)
})
after(() => harness.close())
// 每個測試都可能改 config.rules；不管測試本身成功或失敗都要復原，
// 否則一個早失敗的斷言會讓後面不相干的測試連帶炸掉（見 docs/security.md 以外，
// 這是純粹的測試隔離問題，不是安全問題）。
afterEach(() => { harness.getConfig().rules = DEFAULT_RULES() })

// ── 路由：走 proxy 的整合測試 ────────────────────────────────────────
test('主對話原樣轉發，訂閱憑證與 anthropic-beta 完整保留', async () => {
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)
  assert.equal(res.status, 200)
  await res.text()

  const [hit] = harness.upstream.state.received
  assert.equal(hit.headers.authorization, 'Bearer sk-ant-oat-fake', '訂閱 OAuth token 必須原樣送達')
  assert.equal(hit.headers['anthropic-beta'], SUBSCRIPTION_HEADERS['anthropic-beta'], 'OAuth capability 在這個 header 裡，剝掉會 401')
  assert.equal(hit.url, '/v1/messages?beta=true', 'query string 要保留')
  assert.deepEqual(hit.body, BASE_BODY, '主對話的 body 一個字都不能動')
})

test('子 agent 改導向 provider 並改寫 model，其餘 body 欄位與 anthropic-beta 原樣送過去', async () => {
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'agent-1' }, BASE_BODY)
  assert.equal(res.status, 200)
  await res.text()

  const [hit] = harness.upstream.state.received
  assert.equal(hit.body.model, 'kimi-k3')
  assert.equal(hit.headers.authorization, 'Bearer sk-moonshot', '要換成 provider 自己的 key')
  assert.equal(hit.headers['anthropic-beta'], SUBSCRIPTION_HEADERS['anthropic-beta'], 'body 裡的欄位要有成對的 beta header')
  // 剝掉 output_config 會讓 /effort 靜默失效，請求照樣 200
  assert.deepEqual(hit.body.output_config, { effort: 'high' }, 'effort 必須原封不動送到 provider')
  assert.deepEqual(hit.body.thinking, { type: 'adaptive' })
  assert.deepEqual(hit.body.context_management, { edits: [] })
  assert.deepEqual(hit.body.messages, BASE_BODY.messages, 'messages 不能動')
})

test('送去 provider 的請求不帶 metadata：claude.ai 帳號識別不能流到第三方', async () => {
  await (await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'agent-1' }, BASE_BODY)).text()

  const [hit] = harness.upstream.state.received
  assert.equal(hit.body.metadata, undefined)
  assert.ok(!JSON.stringify(hit.body).includes('acct-1'), 'account_uuid 不能以任何形式出現在送出的 body 裡')
  assert.ok(harness.logStore.list()[0].changes.includes('-metadata'), '流量記錄要看得出 router 動過這一項')

  // 訂閱線照舊原樣：那是 Anthropic 自己的欄位，拿掉反而是在改 Claude Code 的請求
  await (await post(SUBSCRIPTION_HEADERS, BASE_BODY)).text()
  assert.deepEqual(harness.upstream.state.received[0].body.metadata, BASE_BODY.metadata)
})

/**
 * 整個工具存在的理由就是「第三方拿不到你的訂閱憑證」。只驗證 provider 收到「正確」的
 * header 不夠，還要明確驗證 client 帶來的 authorization / cookie / x-api-key 不會被轉發。
 */
test('provider 收不到 client 帶來的 authorization／x-api-key／cookie —— buildProviderHeaders 是從零組出來的', async () => {
  const res = await post(
    {
      ...SUBSCRIPTION_HEADERS,
      'x-claude-code-agent-id': 'agent-1',
      cookie: 'session=super-secret-cookie',
      'x-api-key': 'sk-client-supplied-should-never-reach-provider',
    },
    BASE_BODY,
  )
  assert.equal(res.status, 200)
  await res.text()

  const [hit] = harness.upstream.state.received
  assert.equal(hit.headers.authorization, 'Bearer sk-moonshot', '只能是 provider 自己的 key，絕不能是 client 的訂閱 token')
  assert.equal(hit.headers.cookie, undefined, 'cookie 絕不能被轉發給第三方')
  assert.equal(hit.headers['x-api-key'], undefined, 'kimi 是 bearer authStyle，client 送來的 x-api-key 不該被夾帶')
  const dump = JSON.stringify(hit.headers)
  assert.ok(!dump.includes('super-secret-cookie'), 'cookie 內容不能以任何形式出現在送給 provider 的 header 裡')
  assert.ok(!dump.includes('sk-ant-oat-fake'), '訂閱 OAuth token 絕不能出現在 provider 收到的任何 header 裡')
  assert.ok(!dump.includes('sk-client-supplied'), 'client 自訂的 x-api-key 不能以任何名字漏進去')
})

test('provider 收不到 client 憑證 —— x-api-key authStyle 的 provider 也一樣', async () => {
  harness.getConfig().rules = [defaultRule({ match: 'subagent', providerId: 'other' })]
  const res = await post(
    { ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a', cookie: 'session=leak-me-not' },
    BASE_BODY,
  )
  await res.text()

  const [hit] = harness.upstream.state.received
  assert.equal(hit.headers['x-api-key'], 'sk-other', '只能是 provider 自己的 key')
  assert.equal(hit.headers.authorization, undefined, 'client 的訂閱 authorization 不能被轉成別的 header 名字漏出去')
  assert.equal(hit.headers.cookie, undefined)
})

test('流量記錄帶上 cwd 與 effort，但不留 prompt 內容', async () => {
  const body = {
    ...BASE_BODY,
    system: [{ type: 'text', text: '# Environment\n - Primary working directory: /srv/app\n' }],
  }
  await (await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, body)).text()

  const entry = harness.logStore.list()[0]
  assert.equal(entry.sessionId, 'sess-1', 'cwd 認不出來時只剩 session id 能分辨來源')
  assert.equal(entry.cwd, '/srv/app')
  assert.equal(entry.effort, 'high')
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

  assert.equal(harness.logStore.list()[0].kind, 'subagent')
  assert.equal(harness.logStore.list()[0].cwd, '/srv/inherited', '子 agent 應該繼承到主對話的 cwd')

  // 不同 session 不能互相污染
  await (await post(
    { ...SUBSCRIPTION_HEADERS, 'x-claude-code-session-id': 'sess-B', 'x-claude-code-agent-id': 'a2' },
    BASE_BODY,
  )).text()
  assert.equal(harness.logStore.list()[0].cwd, null, '別的 session 不該撿到不屬於它的 cwd')
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

test('modelGlob 沒命中就落回訂閱', async () => {
  harness.getConfig().rules = [defaultRule({ match: 'subagent', modelGlob: 'claude-haiku*', providerId: 'kimi' })]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)
  await res.text()
  assert.equal(harness.upstream.state.received[0].body.model, 'claude-opus-5', 'glob 不合就不該改寫')
})

test('流量記錄靠 providerId 與 target 有沒有值分辨去向，GUI 不必比對任何字串', async () => {
  await (await post(SUBSCRIPTION_HEADERS, BASE_BODY)).text()
  const sub = harness.logStore.list()[0]
  assert.equal(sub.providerId, null, '訂閱線沒有 providerId')
  assert.ok(sub.target, '訂閱線一定有 target，否則 GUI 會把它當成沒送出')

  await (await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)).text()
  const prv = harness.logStore.list()[0]
  assert.equal(prv.providerId, 'kimi')
  assert.equal(prv.target, 'Kimi', 'provider 線的 target 是使用者填的 label，GUI 原樣顯示')
})

// ── 指向 passthrough 的規則 ────────────────────────────────────────
test('規則指向 passthrough 時走訂閱線，不帶 provider 憑證', async () => {
  // 第三方配額快用完，把子 agent 整批切回訂閱的情境
  harness.getConfig().rules = [defaultRule({ id: 'back', match: 'subagent', providerId: PASSTHROUGH_ID })]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)
  assert.equal(res.status, 200)
  await res.text()

  const [hit] = harness.upstream.state.received
  assert.equal(hit.headers.authorization, 'Bearer sk-ant-oat-fake', '訂閱 OAuth token 必須原樣送達')
  assert.equal(hit.headers['anthropic-beta'], SUBSCRIPTION_HEADERS['anthropic-beta'])
  assert.deepEqual(hit.body, BASE_BODY, '沒設 modelOverride 就一個字都不能動')
  assert.equal(harness.logStore.list()[0].ruleId, 'back', '要看得出是規則命中，不是沒命中掉下來的')
})

test('passthrough + modelOverride 只換 model，其餘 body 欄位原封不動', async () => {
  // 主對話開 fable 時 Workflow 的子 agent 也會是 fable，用這條規則拉回 opus
  harness.getConfig().rules = [defaultRule({ match: 'subagent', providerId: PASSTHROUGH_ID, modelOverride: 'claude-opus-5' })]
  const res = await post(
    { ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' },
    { ...BASE_BODY, model: 'claude-fable-5' },
  )
  assert.equal(res.status, 200)
  await res.text()

  const [hit] = harness.upstream.state.received
  assert.equal(hit.body.model, 'claude-opus-5')
  assert.equal(hit.headers.authorization, 'Bearer sk-ant-oat-fake', '改 model 不代表要換憑證')
  assert.deepEqual(hit.body.output_config, { effort: 'high' }, '訂閱線的 effort 絕不能被順手改掉')
  assert.deepEqual(hit.body.thinking, BASE_BODY.thinking)
  assert.deepEqual(hit.body.context_management, BASE_BODY.context_management)
  assert.deepEqual(hit.body.messages, BASE_BODY.messages)

  const entry = harness.logStore.list()[0]
  assert.equal(entry.sentModel, 'claude-opus-5')
  assert.deepEqual(entry.changes, ['model claude-fable-5 → claude-opus-5'])
})

test('主對話不受指向 passthrough 的子 agent 規則影響', async () => {
  harness.getConfig().rules = [defaultRule({ match: 'subagent', providerId: PASSTHROUGH_ID, modelOverride: 'claude-opus-5' })]
  await (await post(SUBSCRIPTION_HEADERS, BASE_BODY)).text()
  assert.deepEqual(harness.upstream.state.received[0].body, BASE_BODY, '主對話還是你在對話框裡選的那個模型')
})

test('規則的 modelOverride 蓋過 provider 自己的 model', async () => {
  harness.getConfig().rules = [defaultRule({ match: 'subagent', providerId: 'kimi', modelOverride: 'kimi-k3(high)' })]
  await (await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)).text()
  assert.equal(harness.upstream.state.received[0].body.model, 'kimi-k3(high)')
  assert.equal(harness.upstream.state.received[0].headers.authorization, 'Bearer sk-moonshot', 'provider 的其他設定照舊')
})

test('指向不存在的 provider 時退回訂閱，而不是讓請求失敗', async () => {
  harness.getConfig().rules = [defaultRule({ match: 'subagent', providerId: 'gone' })]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)
  assert.equal(res.status, 200)
  await res.text()
  assert.equal(harness.upstream.state.received[0].body.model, 'claude-opus-5')
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

test('describeRequest 依 header 判定來源，巢狀的子 agent 也是子 agent', () => {
  assert.equal(describeRequest({}, {}).kind, 'main')
  assert.equal(describeRequest({ 'x-claude-code-agent-id': 'a' }, {}).kind, 'subagent')
  assert.equal(
    describeRequest({ 'x-claude-code-agent-id': 'a', 'x-claude-code-parent-agent-id': 'p' }, {}).kind,
    'subagent',
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
        + ' - Primary working directory: C:\\Users\\dev\\code\\bridge\n'
        + ' - Is a git repository: true\n - Platform: win32\n',
    },
  ]
  assert.equal(extractCwd({ system }), 'C:\\Users\\dev\\code\\bridge')
  assert.equal(extractCwd({ system: '- Primary working directory: /home/x/proj' }), '/home/x/proj')
  assert.equal(extractCwd({ system: [{ type: 'text', text: '沒有環境區段' }] }), null)
  assert.equal(extractCwd({}), null)
  assert.equal(extractCwd(null), null)
})

/**
 * Environment 區段後來搬進 messages 裡那則 `role: "system"` 訊息（實測 2026-09-19）。
 * 只看 `body.system` 的話每一筆 cwd 都是 null，流量記錄整欄空掉。
 */
test('extractCwd 也從 messages 裡的 role: "system" 訊息挖得出 cwd', () => {
  const envText = '# Environment\nYou have been invoked in the following environment: \n'
    + ' - Primary working directory: C:\\Users\\dev\\code\\bridge\n - Platform: win32\n'
  const body = {
    system: [{ type: 'text', text: 'You are Claude Code, Anthropic official CLI.' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '幫我看一下這個 bug' }] },
      { role: 'system', content: [{ type: 'text', text: envText }] },
    ],
  }
  assert.equal(extractCwd(body), 'C:\\Users\\dev\\code\\bridge')

  // system 區塊優先：兩邊都有時不該回傳 messages 那個
  assert.equal(
    extractCwd({ ...body, system: [{ type: 'text', text: ' - Primary working directory: /from/system' }] }),
    '/from/system',
  )

  // 只掃 role: "system"。user／assistant 訊息在 1M context 下動輒好幾 MB，
  // 每筆請求都拿正則掃過去只是白燒 CPU —— Environment 區段不在那裡。
  assert.equal(extractCwd({ messages: [{ role: 'user', content: [{ type: 'text', text: envText }] }] }), null)

  assert.equal(extractCwd({ messages: 'not-an-array' }), null)
  assert.equal(extractCwd({ messages: [{ role: 'system', content: '沒有環境區段' }] }), null)
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

test('開箱的預設設定一筆流量都不改道 —— 分流要等使用者填完 key 自己打開', () => {
  const cfg = normalizeConfig(defaultConfig())
  const main = describeRequest({}, { model: 'claude-opus-5' })
  const sub = describeRequest({ 'x-claude-code-agent-id': 'a' }, { model: 'claude-sonnet-5' })

  assert.equal(resolveRoute(cfg, main).kind, 'passthrough')
  // 預設 provider 沒有 API key，這條規則要是開著，子 agent 會整批撞 401
  assert.equal(resolveRoute(cfg, sub).kind, 'passthrough', '預設規則必須是關的')
  assert.equal(cfg.providers[0].apiKey, '', '預設不得內建任何憑證')

  // 打開之後才分流 —— 確認關的是規則本身，不是規則寫錯了配不上
  cfg.rules[0].enabled = true
  assert.equal(resolveRoute(cfg, sub).kind, 'provider')
  assert.equal(resolveRoute(cfg, main).kind, 'passthrough', '主對話永遠留在訂閱')
})

test('main 規則不碰子 agent，subagent 規則不碰主對話', () => {
  const cfg = normalizeConfig({
    providers: [defaultProvider({ id: 'k', baseUrl: 'https://x.test', model: 'm' })],
    rules: [defaultRule({ match: 'main', providerId: 'k' })],
  })
  const main = describeRequest({}, {})
  const sub = describeRequest({ 'x-claude-code-agent-id': 'a' }, {})
  assert.equal(resolveRoute(cfg, main).kind, 'provider')
  assert.equal(resolveRoute(cfg, sub).kind, 'passthrough')

  cfg.rules = [defaultRule({ match: 'subagent', providerId: 'k' })]
  assert.equal(resolveRoute(cfg, main).kind, 'passthrough')
  assert.equal(resolveRoute(cfg, sub).kind, 'provider')
})

test('舊設定檔裡已經拿掉的 any / nested 規則載入後是關的，不會悄悄換成別的範圍', () => {
  const cfg = normalizeConfig({
    providers: [defaultProvider({ id: 'k', baseUrl: 'https://x.test', model: 'm' })],
    rules: [
      { id: 'old-any', match: 'any', providerId: 'k', agentIdGlob: 'Explore*' },
      { id: 'old-nested', match: 'nested', providerId: 'k' },
      { id: 'no-match', providerId: 'k' },
    ],
  })
  assert.deepEqual(cfg.rules.map((r) => [r.id, r.enabled]), [['old-any', false], ['old-nested', false], ['no-match', true]])
  assert.ok(!('agentIdGlob' in cfg.rules[0]), '拿掉的欄位下次存檔就消失')
  assert.equal(resolveRoute(cfg, describeRequest({}, {})).kind, 'passthrough', 'any 曾經涵蓋主對話，關掉之後不能還命中')
})

test('resolveRoute 認得指向 passthrough 的規則，並和「沒命中」區分開', () => {
  const cfg = normalizeConfig({
    providers: [defaultProvider({ id: 'k', baseUrl: 'https://x.test', model: 'm' })],
    rules: [defaultRule({ id: 'back', match: 'subagent', providerId: PASSTHROUGH_ID })],
  })
  const sub = describeRequest({ 'x-claude-code-agent-id': 'a' }, { model: 'claude-opus-5' })

  const hit = resolveRoute(cfg, sub)
  assert.equal(hit.kind, 'passthrough')
  assert.equal(hit.rule?.id, 'back')
  assert.equal(resolveRoute(cfg, describeRequest({}, {})).rule, null, '沒命中就沒有 rule')
})

test('resolveModel 的優先序：規則 > provider > 原樣', () => {
  const provider = defaultProvider({ id: 'k', baseUrl: 'https://x.test', model: 'kimi-k3' })
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
  const cfg = normalizeConfig({ providers: [{ id: PASSTHROUGH_ID, baseUrl: 'https://x.test' }] })
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

test('rewriteBodyForProvider 只換 model、拿掉 metadata，而且不改動原物件', () => {
  const original = { model: 'claude-opus-5', max_tokens: 9999, thinking: {}, metadata: { user_id: 'x' } }
  const snapshot = structuredClone(original)
  const { body, changes } = rewriteBodyForProvider(original, 'kimi-k3')
  assert.deepEqual(original, snapshot, '輸入必須維持不變')
  assert.deepEqual(body, { model: 'kimi-k3', max_tokens: 9999, thinking: {} })
  assert.deepEqual(changes, ['model claude-opus-5 → kimi-k3', '-metadata'])
})

// ── provider 線：上游編不動的 pattern ─────────────────────────────────
// DeepSeek 擋掉字元類裡的八進位跳脫，Anthropic 收得下同一份 schema（見 docs/providers.md）。
// 正規表達式一律用 String.raw 寫，才看得出送出去的到底是哪幾個字元。

/** Claude Code v2.1.274 的 Artifact 工具，`file_paths.items` 就是被擋下來的那一段。 */
const ARTIFACT_TOOL = () => ({
  name: 'Artifact',
  input_schema: {
    type: 'object',
    properties: {
      file_paths: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 1024, pattern: String.raw`^[^\0]*$` },
      },
    },
  },
})

test('rewriteToolPatterns 把 Claude Code 的 \\0 換成等價的 \\x00', () => {
  const original = { tools: [ARTIFACT_TOOL()] }
  const snapshot = structuredClone(original)
  const { body, changes } = rewriteToolPatterns(original)

  assert.deepEqual(original, snapshot, '輸入必須維持不變')
  assert.equal(body.tools[0].input_schema.properties.file_paths.items.pattern, String.raw`^[^\x00]*$`)
  assert.deepEqual(changes, ['tools \\0 → \\x00'])
})

test('schema 任何深度的 pattern 都改得到', () => {
  const { body, changes } = rewriteToolPatterns({
    tools: [{
      name: 'T',
      input_schema: {
        type: 'object',
        properties: {
          a: { anyOf: [{ type: 'string', pattern: String.raw`^\0$` }, { type: 'null' }] },
          b: { type: 'object', propertyNames: { type: 'string', pattern: String.raw`^[^\0]+$` } },
          c: { type: 'array', items: { type: 'array', items: { type: 'string', pattern: String.raw`\0` } } },
        },
      },
    }],
  })

  const props = body.tools[0].input_schema.properties
  assert.equal(props.a.anyOf[0].pattern, String.raw`^\x00$`)
  assert.equal(props.b.propertyNames.pattern, String.raw`^[^\x00]+$`)
  assert.equal(props.c.items.items.pattern, String.raw`\x00`)
  assert.deepEqual(changes, ['tools \\0 → \\x00'])
})

test('只動真的在跳脫 0 的那個反斜線，其餘 pattern 一個字不改', () => {
  const original = {
    tools: [{
      name: 'T',
      input_schema: {
        type: 'object',
        properties: {
          // 反斜線成對＝字面反斜線，後面的 0 是字面零
          pairedBackslash: { type: 'string', pattern: String.raw`^\\0$` },
          // `\0` 後面還有數字時是兩位以上的八進位，換成 \x00 會改掉語義
          octalTwoDigits: { type: 'string', pattern: String.raw`^\01$` },
          plainZero: { type: 'string', pattern: '^[a-z]0*$' },
          // 只有 pattern 這個鍵算數，別的欄位就算長得像正規表達式也不能動
          decoy: { type: 'string', description: String.raw`^[^\0]*$` },
        },
      },
    }],
  }
  const { body, changes } = rewriteToolPatterns(original)

  assert.equal(body, original, '沒改到就要回傳原物件，proxy 才不會無故重建 body')
  assert.deepEqual(changes, [])
})

test('沒有 tools 的請求不受影響', () => {
  const body = { model: 'x', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(rewriteToolPatterns(body).body, body)
  assert.deepEqual(rewriteToolPatterns({ tools: 'not-an-array' }).changes, [])
  assert.deepEqual(rewriteToolPatterns(null), { body: null, changes: [] })
})

test('rewriteBodyForProvider 三項改寫都記進 changes', () => {
  const { body, changes } = rewriteBodyForProvider(
    { model: 'claude-sonnet-5', metadata: { user_id: 'x' }, tools: [ARTIFACT_TOOL()] },
    'deepseek-flash',
  )
  assert.equal(body.metadata, undefined)
  assert.equal(body.tools[0].input_schema.properties.file_paths.items.pattern, String.raw`^[^\x00]*$`)
  assert.deepEqual(changes, ['model claude-sonnet-5 → deepseek-flash', '-metadata', 'tools \\0 → \\x00'])
})

test('provider 收到改寫後的 pattern，訂閱線照舊原樣送', async () => {
  const body = { ...BASE_BODY, tools: [ARTIFACT_TOOL()] }
  const patternOf = (hit) => hit.body.tools[0].input_schema.properties.file_paths.items.pattern

  await (await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'agent-1' }, body)).text()
  assert.equal(patternOf(harness.upstream.state.received[0]), String.raw`^[^\x00]*$`)
  assert.ok(
    harness.logStore.list()[0].changes.includes('tools \\0 → \\x00'),
    '流量記錄要看得出 router 動過工具定義',
  )

  // 訂閱線送的是 Anthropic 自己收得下的 schema，改寫只會變成在改 Claude Code 的請求
  await (await post(SUBSCRIPTION_HEADERS, body)).text()
  assert.equal(patternOf(harness.upstream.state.received[0]), String.raw`^[^\0]*$`)
})
