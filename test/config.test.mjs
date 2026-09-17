import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeConfig, defaultProvider, toClientConfig, fromClientConfig, KEEP_SECRET,
  validateBaseUrl, describeConfigProblems, restoreMaskedKey,
} from '../src/config.mjs'

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

test('遮罩值只換得回同一個 baseUrl 底下的 key；baseUrl 換了要明講，不能悄悄還原或清空', () => {
  const cfg = normalizeConfig({ providers: [defaultProvider({ id: 'k', label: 'Moved', baseUrl: 'https://x', apiKey: 'sk-secret-1234' })] })
  const client = toClientConfig(cfg)
  assert.equal(restoreMaskedKey(client.providers[0], cfg), 'sk-secret-1234')
  assert.equal(restoreMaskedKey({ ...client.providers[0], baseUrl: 'https://x/' }, cfg), 'sk-secret-1234', '結尾斜線不算換了目的地')

  client.providers[0].baseUrl = 'https://attacker.example'
  assert.equal(restoreMaskedKey(client.providers[0], cfg), null, 'baseUrl 換了就不能沿用已存的 key')
  const [problem] = describeConfigProblems(client, cfg)
  assert.match(problem, /Moved.*baseUrl differs/, '存檔要被擋下，並講出是哪個 provider')
  assert.equal(fromClientConfig(client, cfg).providers[0].apiKey, '', '規則預覽也走這條路，拿不到 key 也不能拿到舊的')
})

test('normalizeConfig 修掉壞資料而不是拋錯', () => {
  const cfg = normalizeConfig({ proxyPort: 'abc', providers: 'nope', rules: [{ match: '???' }] })
  assert.equal(cfg.proxyPort, 8787)
  assert.ok(Array.isArray(cfg.providers))
  assert.equal(cfg.rules[0].match, 'subagent')
  assert.equal(cfg.rules[0].enabled, false, '認不得的 match 要關掉，不能變成一條生效的 subagent 規則')
  assert.equal(cfg.passthrough.baseUrl, 'https://api.anthropic.com')
})

// ── SSRF 表面：baseUrl scheme 檢查 ─────────────────────────────────
test('validateBaseUrl：空字串合法（尚未設定），http/https 合法，其餘 scheme 不合法', () => {
  assert.deepEqual(validateBaseUrl(''), { ok: true, value: '' })
  assert.deepEqual(validateBaseUrl('  '), { ok: true, value: '' })
  assert.deepEqual(validateBaseUrl('https://api.example.com/v1'), { ok: true, value: 'https://api.example.com/v1' })
  assert.deepEqual(validateBaseUrl('http://127.0.0.1:8080/'), { ok: true, value: 'http://127.0.0.1:8080' })
  assert.equal(validateBaseUrl('ftp://x').ok, false)
  assert.equal(validateBaseUrl('javascript:alert(1)').ok, false)
  assert.equal(validateBaseUrl('file:///etc/passwd').ok, false)
  assert.equal(validateBaseUrl('not a url at all').ok, false)
})

test('normalizeConfig：provider 的 baseUrl scheme 不合法就清空，不會讓整個載入炸掉', () => {
  const cfg = normalizeConfig({ providers: [{ id: 'p', label: 'bad', baseUrl: 'ftp://evil.example' }] })
  assert.equal(cfg.providers[0].baseUrl, '', '驗證失敗就清空，未設定狀態下這個 provider 不會生效')
})

test('normalizeConfig：passthrough 的 baseUrl scheme 不合法就退回預設值', () => {
  const cfg = normalizeConfig({ passthrough: { baseUrl: 'ftp://evil.example' } })
  assert.equal(cfg.passthrough.baseUrl, 'https://api.anthropic.com', 'passthrough 一定要有個可用的值')
})

test('normalizeConfig：已經拿掉的 provider 欄位不會被留下來', () => {
  const cfg = normalizeConfig({
    providers: [{ id: 'p', baseUrl: 'https://x', dropFields: ['thinking'], dropBeta: true, extraHeaders: { 'x-a': 'b' }, retry: null }],
  })
  assert.deepEqual(Object.keys(cfg.providers[0]).sort(), ['apiKey', 'authStyle', 'baseUrl', 'id', 'label', 'model'])
})

test('describeConfigProblems：baseUrl 的問題講得出是哪個 provider', () => {
  const problems = describeConfigProblems({
    passthrough: { baseUrl: 'https://api.anthropic.com' },
    providers: [
      { id: 'p1', label: 'Bad Base', baseUrl: 'ftp://evil.example' },
      { id: 'p2', label: 'Fine', baseUrl: 'https://ok.example' },
    ],
  }, normalizeConfig({}))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /Bad Base/)
})

test('describeConfigProblems：都合法時回空陣列', () => {
  assert.deepEqual(describeConfigProblems({ passthrough: { baseUrl: 'https://api.anthropic.com' }, providers: [] }, normalizeConfig({})), [])
})
