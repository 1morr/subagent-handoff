import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeConfig, defaultProvider, toClientConfig, fromClientConfig, KEEP_SECRET,
  validateBaseUrl, isValidHeaderName, describeConfigProblems,
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

/** item 2：換 baseUrl 卻沿用遮罩值，不該把已存的 key 悄悄綁到新目的地。 */
test('fromClientConfig：baseUrl 跟已存的不一樣時，KEEP_SECRET 不還原', () => {
  const cfg = normalizeConfig({ providers: [defaultProvider({ id: 'k', baseUrl: 'https://x', apiKey: 'sk-secret-1234' })] })
  const client = toClientConfig(cfg)
  client.providers[0].baseUrl = 'https://attacker.example'

  const round = fromClientConfig(client, cfg)
  assert.notEqual(round.providers[0].apiKey, 'sk-secret-1234', 'baseUrl 換了就不能沿用已存的 key')
  assert.equal(round.providers[0].apiKey, '')
})

test('normalizeConfig 修掉壞資料而不是拋錯', () => {
  const cfg = normalizeConfig({ proxyPort: 'abc', providers: 'nope', rules: [{ match: '???' }] })
  assert.equal(cfg.proxyPort, 8787)
  assert.ok(Array.isArray(cfg.providers))
  assert.equal(cfg.rules[0].match, 'subagent')
  assert.equal(cfg.passthrough.baseUrl, 'https://api.anthropic.com')
})

// ── item 5：SSRF 表面 —— baseUrl scheme 檢查 ──────────────────────
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

test('isValidHeaderName：只認 HTTP token 字元集', () => {
  assert.ok(isValidHeaderName('x-api-key'))
  assert.ok(isValidHeaderName('X-Custom-Header'))
  assert.ok(!isValidHeaderName('bad header'), '空白不合法')
  assert.ok(!isValidHeaderName('x-api-key: evil\r\nHost: x'), 'CRLF 不合法')
  assert.ok(!isValidHeaderName(''))
})

test('normalizeConfig：extraHeaders 標頭名稱不合法就整條略過，其餘合法的保留', () => {
  const cfg = normalizeConfig({
    providers: [defaultProvider({
      id: 'p', baseUrl: 'https://x', extraHeaders: { 'x-ok': 'v1', 'bad header': 'v2' },
    })],
  })
  assert.deepEqual(cfg.providers[0].extraHeaders, { 'x-ok': 'v1' })
})

test('describeConfigProblems：baseUrl 與 extraHeaders 的問題都講得出是哪個 provider', () => {
  const problems = describeConfigProblems({
    passthrough: { baseUrl: 'https://api.anthropic.com' },
    providers: [
      { id: 'p1', label: 'Bad Base', baseUrl: 'ftp://evil.example' },
      { id: 'p2', label: 'Bad Header', baseUrl: 'https://ok.example', extraHeaders: { 'x-fine': 'v', 'bad name': 'v' } },
      { id: 'p3', label: 'Fine', baseUrl: 'https://ok.example', extraHeaders: { 'x-fine': 'v' } },
    ],
  })
  assert.equal(problems.length, 2)
  assert.match(problems[0], /Bad Base/)
  assert.match(problems[1], /Bad Header/)
})

test('describeConfigProblems：都合法時回空陣列', () => {
  assert.deepEqual(describeConfigProblems({ passthrough: { baseUrl: 'https://api.anthropic.com' }, providers: [] }), [])
})
