import test, { before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteBodyForProvider, rewriteModel, SessionCwd } from '../src/proxy.mjs'
import {
  globMatch, describeRequest, resolveRoute, resolveModel, extractCwd, PASSTHROUGH_ID,
} from '../src/routing.mjs'
import { normalizeConfig, defaultConfig, defaultProvider, defaultRule } from '../src/config.mjs'
import { createHarness, makePost, makeAdminApi, BASE_BODY, SUBSCRIPTION_HEADERS } from './helpers.mjs'

const DEFAULT_RULES = () => [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })]

let harness, post, adminApi

before(async () => {
  harness = await createHarness()
  post = makePost(harness.proxyUrl, harness.upstream)
  adminApi = makeAdminApi(harness.adminUrl)
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

test('子 agent 改導向 provider 並改寫 model，但預設不動任何 body 欄位', async () => {
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'agent-1' }, BASE_BODY)
  assert.equal(res.status, 200)
  await res.text()

  const [hit] = harness.upstream.state.received
  assert.equal(hit.body.model, 'kimi-k3')
  assert.equal(hit.headers.authorization, 'Bearer sk-moonshot', '要換成 provider 自己的 key')
  assert.equal(hit.headers['anthropic-beta'], undefined, 'dropBeta 開著就不該帶過去')
  // 剝掉 output_config 會讓 /effort 靜默失效，請求照樣 200 —— 預設絕不能這樣做
  assert.deepEqual(hit.body.output_config, { effort: 'high' }, 'effort 必須原封不動送到 provider')
  assert.deepEqual(hit.body.thinking, { type: 'adaptive' })
  assert.deepEqual(hit.body.context_management, { edits: [] })
  assert.deepEqual(hit.body.messages, BASE_BODY.messages, 'messages 不能動')
})

/**
 * item 19：整個工具存在的理由就是「第三方拿不到你的訂閱憑證」。這是最重要的一條
 * 性質斷言，之前完全沒有測試守著 —— 只驗證過 provider 收到「正確」的 header，
 * 從沒明確驗證過 client 帶來的 authorization / cookie / 自訂 x-api-key 不會被轉發。
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

test('明確設定 dropFields 的 provider 才剝除欄位', async () => {
  harness.getConfig().rules = [defaultRule({ match: 'subagent', providerId: 'strict' })]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'agent-1' }, BASE_BODY)
  await res.text()

  const [hit] = harness.upstream.state.received
  assert.equal(hit.body.model, 'picky-1')
  for (const field of ['thinking', 'context_management', 'output_config']) {
    assert.ok(!(field in hit.body), `${field} 應該被剝除`)
  }
})

test('x-api-key 認證與保留 anthropic-beta 的 provider', async () => {
  harness.getConfig().rules = [defaultRule({ match: 'subagent', providerId: 'other' })]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)
  await res.text()

  const [hit] = harness.upstream.state.received
  assert.equal(hit.headers['x-api-key'], 'sk-other')
  assert.equal(hit.headers.authorization, undefined)
  assert.equal(hit.headers['anthropic-beta'], SUBSCRIPTION_HEADERS['anthropic-beta'])
})

test('modelGlob 沒命中就落回訂閱', async () => {
  harness.getConfig().rules = [defaultRule({ match: 'subagent', modelGlob: 'claude-haiku*', providerId: 'kimi' })]
  const res = await post({ ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }, BASE_BODY)
  await res.text()
  assert.equal(harness.upstream.state.received[0].body.model, 'claude-opus-5', 'glob 不合就不該改寫')
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
  assert.equal(hit.headers['anthropic-beta'], SUBSCRIPTION_HEADERS['anthropic-beta'], 'passthrough 不受 dropBeta 影響')
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
  assert.equal(entry.sentEffort, 'high', '沒有靜默降級')
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

// ── 依 agent 身分分流 ──────────────────────────────────────────────
test('agentIdGlob 篩得出 teammate，主對話永遠不會被捲進去', () => {
  const cfg = normalizeConfig({
    providers: [defaultProvider({ id: 'cheap', baseUrl: 'https://x.test' })],
    rules: [defaultRule({ id: 'r-explore', match: 'any', agentIdGlob: 'Explore*', providerId: 'cheap' })],
  })

  const hit = describeRequest({ 'x-claude-code-agent-id': 'Explore-1' }, {})
  assert.equal(resolveRoute(cfg, hit).kind, 'provider')

  const miss = describeRequest({ 'x-claude-code-agent-id': 'Plan-1' }, {})
  assert.equal(resolveRoute(cfg, miss).kind, 'passthrough', '名字對不上就落到下一條')

  const main = describeRequest({}, {})
  assert.equal(resolveRoute(cfg, main).kind, 'passthrough', '主對話沒有 agent-id，不該被 agent 規則命中')
})

test('agentIdGlob 預設 * 不影響任何既有規則', () => {
  const cfg = normalizeConfig({
    providers: [defaultProvider({ id: 'k', baseUrl: 'https://x.test' })],
    rules: [defaultRule({ id: 'r', match: 'subagent', providerId: 'k' })],
  })
  assert.equal(cfg.rules[0].agentIdGlob, '*')
  assert.equal(resolveRoute(cfg, describeRequest({ 'x-claude-code-agent-id': 'whatever' }, {})).kind, 'provider')
})

test('規則預覽吃得下 agentId', async () => {
  const { json } = await adminApi('POST', '/api/routing/preview', {
    kind: 'subagent',
    model: 'claude-opus-5',
    agentId: 'Explore-7',
    config: {
      ...(await adminApi('GET', '/api/state')).json.config,
      rules: [defaultRule({ id: 'r-x', match: 'subagent', agentIdGlob: 'Explore*', providerId: 'kimi' })],
    },
  })
  assert.equal(json.agentId, 'Explore-7')
  assert.equal(json.ruleId, 'r-x')
  assert.equal(json.target, 'Kimi')
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

test('subagent 規則涵蓋巢狀，nested 規則不涵蓋第一層', () => {
  const cfg = normalizeConfig({
    providers: [defaultProvider({ id: 'k', baseUrl: 'https://x.test', model: 'm' })],
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
