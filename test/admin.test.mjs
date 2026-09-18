import test, { before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { toClientConfig, defaultRule, KEEP_SECRET } from '../src/config.mjs'
import en from '../src/ui/i18n/en.js'
import zhHant from '../src/ui/i18n/zh-Hant.js'
import { createHarness, makeAdminApi, rawRequest } from './helpers.mjs'

let harness, adminApi
let snapshot

before(async () => {
  harness = await createHarness()
  adminApi = makeAdminApi(harness.adminUrl)
})
after(() => harness.close())
// PUT /api/config 這條路徑本來就會真的替換掉 harness 共用的那份 config —— 好幾個測試
// 故意送壞資料或換掉 baseUrl 來驗證 guard，如果不還原，後面用到同一個 provider（例如
// stored.baseUrl 已經被前一個測試改成 attacker.example）的測試就會莫名其妙 fetch failed。
// 用 beforeEach/afterEach 系統性地做快照與還原，不管測試本身成功或失敗都會執行。
beforeEach(() => { snapshot = structuredClone(harness.getConfig()) })
afterEach(() => { harness.setConfig(snapshot) })

test('GET /api/state 給前端遮罩過的設定，真 key 不出門', async () => {
  const { status, json } = await adminApi('GET', '/api/state')

  assert.equal(status, 200)
  const kimi = json.config.providers.find((p) => p.id === 'kimi')
  assert.equal(kimi.apiKey, KEEP_SECRET, '真 key 不能離開 router')
  assert.match(kimi.apiKeyHint, /^sk-m/)
  assert.equal(json.runtime.passthroughBaseUrl, 'https://api.anthropic.com', 'GUI 顯示的訂閱線去向')
  assert.ok(json.runtime.configPath, '前端要能顯示設定檔在哪')
})

test('PUT /api/config 存回遮罩值時保留原 key，換成新值時才覆蓋', async () => {
  const { json: state } = await adminApi('GET', '/api/state')
  const incoming = structuredClone(state.config)
  // 前端拿到的是遮罩，原封不動送回來＝使用者沒改這個欄位
  incoming.providers.find((p) => p.id === 'kimi').label = '改過名字'
  incoming.providers.find((p) => p.id === 'other').apiKey = 'sk-brand-new'

  const { status } = await adminApi('PUT', '/api/config', incoming)
  assert.equal(status, 200)

  const kimi = harness.getConfig().providers.find((p) => p.id === 'kimi')
  assert.equal(kimi.apiKey, 'sk-moonshot', '沒動到的 key 不能被遮罩字串蓋掉')
  assert.equal(kimi.label, '改過名字')
  assert.equal(harness.getConfig().providers.find((p) => p.id === 'other').apiKey, 'sk-brand-new')
})

/**
 * 換 baseUrl 的同時沿用 KEEP_SECRET，等於把已存的 key 綁到新目的地。以前是悄悄存成空 key，
 * 使用者要等 provider 開始回 401 才發現；現在整筆存檔直接 400，講清楚要重填 key。
 */
test('PUT /api/config：換 baseUrl 又沿用遮罩值時 400，已存的 key 與 baseUrl 都不動', async () => {
  const before = JSON.stringify(harness.getConfig().providers)
  const { json: state } = await adminApi('GET', '/api/state')
  const incoming = structuredClone(state.config)
  incoming.providers.find((p) => p.id === 'kimi').baseUrl = 'https://attacker.example'
  // apiKey 仍然是 KEEP_SECRET（前端沒有真的改過這個欄位）

  const { status, json } = await adminApi('PUT', '/api/config', incoming)
  assert.equal(status, 400)
  assert.match(json.error, /Kimi.*enter the API key again/)
  assert.equal(JSON.stringify(harness.getConfig().providers), before, '被擋下的存檔不能動到任何已存設定')

  // 帶了新 key 就是明著換目的地，照存
  incoming.providers.find((p) => p.id === 'kimi').apiKey = 'sk-for-the-new-host'
  assert.equal((await adminApi('PUT', '/api/config', incoming)).status, 200)
  assert.equal(harness.getConfig().providers.find((p) => p.id === 'kimi').apiKey, 'sk-for-the-new-host')
})

test('PUT /api/config：baseUrl scheme 不合法時 400，且不寫入設定', async () => {
  const before = JSON.stringify(harness.getConfig().providers)
  const { json: state } = await adminApi('GET', '/api/state')
  const incoming = structuredClone(state.config)
  incoming.providers.find((p) => p.id === 'kimi').baseUrl = 'javascript:alert(1)'

  const { status, json } = await adminApi('PUT', '/api/config', incoming)
  assert.equal(status, 400)
  assert.match(json.error, /http/)
  assert.equal(JSON.stringify(harness.getConfig().providers), before, '驗證沒過就不該動到任何已存設定')
})

/**
 * `POST /api/test` 會真的把 key 送出去：body 裡 apiKey 填遮罩值、baseUrl 填別的網域，
 * 就能把已存的 key 送到那裡。只有 baseUrl 跟已存的完全一樣才還原。
 */
test('POST /api/test：baseUrl 跟已存的不同又沿用遮罩值時，拒絕並且不外流 key', async () => {
  const { status, json } = await adminApi('POST', '/api/test', {
    provider: { id: 'kimi', apiKey: KEEP_SECRET, baseUrl: 'http://127.0.0.1:1', authStyle: 'bearer' },
  })
  assert.equal(status, 400)
  assert.match(json.error, /baseUrl/)
})

test('POST /api/test：baseUrl 跟已存的一樣時，KEEP_SECRET 正常還原真 key', async () => {
  const stored = harness.getConfig().providers.find((p) => p.id === 'kimi')
  const { status, json } = await adminApi('POST', '/api/test', {
    provider: { id: 'kimi', apiKey: KEEP_SECRET, baseUrl: stored.baseUrl, authStyle: 'bearer', model: stored.model },
  })
  assert.equal(status, 200)
  assert.equal(json.results[0].ok, true, JSON.stringify(json.results))
  const [hit] = harness.upstream.state.received
  assert.equal(hit.headers.authorization, `Bearer ${stored.apiKey}`, '同一個 baseUrl 才可以還原已存的 key')
})

test('POST /api/test：baseUrl scheme 不合法時 400', async () => {
  const { status, json } = await adminApi('POST', '/api/test', {
    provider: { id: 'kimi', apiKey: 'sk-explicit', baseUrl: 'ftp://x', authStyle: 'bearer' },
  })
  assert.equal(status, 400)
  assert.match(json.error, /http/)
})

test('POST /api/routing/preview 用前端當下的規則試算，不必先儲存', async () => {
  const draft = structuredClone(toClientConfig(harness.getConfig()))
  draft.rules = [defaultRule({ id: 'draft', match: 'subagent', providerId: 'other', modelOverride: 'glm-5-air' })]

  const { json } = await adminApi('POST', '/api/routing/preview', {
    kind: 'subagent',
    model: 'claude-opus-5',
    config: draft,
  })

  assert.equal(json.kind, 'subagent')
  assert.equal(json.providerId, 'other')
  assert.equal(json.ruleId, 'draft')
  assert.equal(json.sentModel, 'glm-5-air')
  assert.deepEqual(harness.getConfig().rules.map((r) => r.id), ['r1'], '預覽不能真的把草稿存下去')
})

test('流量記錄的讀取與清空', async () => {
  await fetch(`${harness.proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  }).then((r) => r.text())
  assert.ok((await adminApi('GET', '/api/logs')).json.entries.length > 0)

  assert.equal((await adminApi('POST', '/api/logs/clear')).status, 200)
  assert.deepEqual((await adminApi('GET', '/api/logs')).json.entries, [])
})

test('不認得的路徑回 404 而不是掛掉', async () => {
  const { status, json } = await adminApi('GET', '/api/nope')
  assert.equal(status, 404)
  assert.ok(json.error)
})

test('解析不了的請求行只讓那一筆失敗，admin server 照樣活著', async () => {
  // `//[` 會讓 new URL 拋錯；接不住就是 unhandled rejection，Node 20+ 會帶走整個 process，proxy 也跟著斷
  const { port } = new URL(harness.adminUrl)
  const head = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    })
    let text = ''
    // handler 拋錯時回應永遠不會來，沒有逾時這條測試會卡住而不是變紅
    socket.setTimeout(2000, () => {
      socket.destroy()
      resolve('(no response)')
    })
    socket.on('data', (chunk) => { text += chunk })
    socket.on('end', () => resolve(text.split('\r\n')[0]))
    socket.on('error', reject)
  })
  assert.match(head, /^HTTP\/1\.1 5\d\d /)
  assert.equal((await adminApi('GET', '/api/state')).status, 200)
})

// ── GUI 靜態頁面（index.html + app.js + app.css） ────────────────────
test('GET / 吐得出 GUI 本體，並且引用拆出去的 app.js／app.css', async () => {
  const res = await fetch(harness.adminUrl + '/')
  assert.equal(res.status, 200)
  assert.ok(res.headers.get('content-type').includes('text/html'))
  const html = await res.text()
  assert.match(html, /<title>/i)
  assert.match(html, /<link rel="stylesheet" href="app\.css">/)
  assert.match(html, /<script type="module" src="app\.js">/)
  assert.ok(!html.includes('<style>'), 'CSS 應該全部搬到 app.css，不該再有內嵌 <style>')
  assert.ok(!/<script type="module">[^<]/.test(html), 'JS 應該全部搬到 app.js，不該再有內嵌邏輯')
})

test('GET /app.js 與 GET /app.css 吐得出拆分後的檔案', async () => {
  const js = await fetch(harness.adminUrl + '/app.js')
  assert.equal(js.status, 200)
  assert.match(js.headers.get('content-type'), /javascript/)
  assert.match(await js.text(), /applyState/)

  const css = await fetch(harness.adminUrl + '/app.css')
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type'), /css/)
  assert.match(await css.text(), /--bay/)
})

// app.js 用相對路徑靜態 import 它，沒吐出去的話整個 GUI 載不起來（白畫面，只有 console 有話說）
test('GET /readout.mjs 吐得出判讀模組', async () => {
  const res = await fetch(harness.adminUrl + '/readout.mjs')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /javascript/)
  assert.match(await res.text(), /export function stateOf/)
})

// ── i18n 字典檔 ────────────────────────────────────────────────────

/** 只在其中一份出現的鍵。GUI 查不到鍵會退回英文或直接印出鍵名，漏翻的地方光看畫面很難發現 */
function catalogGaps(a, b) {
  return {
    onlyFirst: Object.keys(a).filter((k) => !Object.hasOwn(b, k)),
    onlySecond: Object.keys(b).filter((k) => !Object.hasOwn(a, k)),
  }
}

test('兩份語系目錄的鍵一模一樣', () => {
  assert.deepEqual(catalogGaps(en, zhHant), { onlyFirst: [], onlySecond: [] })

  // 閘門本身：少一個鍵要紅，只改譯文不能紅
  const [someKey] = Object.keys(zhHant)
  const { [someKey]: _dropped, ...missingOne } = zhHant
  assert.deepEqual(catalogGaps(en, missingOne), { onlyFirst: [someKey], onlySecond: [] })
  assert.deepEqual(catalogGaps(en, { ...zhHant, [someKey]: '換個說法' }), { onlyFirst: [], onlySecond: [] })
})
test('GET /i18n/en.js 與 GET /i18n/zh-Hant.js 吐得出雙語字典，且跟 app.js 一樣過安全性把關', async () => {
  const en = await fetch(harness.adminUrl + '/i18n/en.js')
  assert.equal(en.status, 200)
  assert.match(en.headers.get('content-type'), /javascript/)
  const enText = await en.text()
  assert.match(enText, /export default/)
  assert.match(enText, /'nav\.bay': 'Rack'/)

  const zh = await fetch(harness.adminUrl + '/i18n/zh-Hant.js')
  assert.equal(zh.status, 200)
  assert.match(zh.headers.get('content-type'), /javascript/)
  const zhText = await zh.text()
  assert.match(zhText, /export default/)
  assert.match(zhText, /'nav\.bay': '機架'/)
})

// ── 安全性 header ─────────────────────────────────────────────────
test('每個回應都帶 X-Frame-Options 與 X-Content-Type-Options', async () => {
  for (const path of ['/', '/api/state', '/app.js', '/app.css', '/readout.mjs', '/i18n/en.js', '/i18n/zh-Hant.js', '/api/nope']) {
    const res = await fetch(harness.adminUrl + path)
    assert.equal(res.headers.get('x-frame-options'), 'DENY', `${path} 缺少 X-Frame-Options`)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${path} 缺少 X-Content-Type-Options`)
  }
})

test('HTML 回應帶 CSP，且 script-src 收緊到 self（外部檔案不需要 unsafe-inline）', async () => {
  const res = await fetch(harness.adminUrl + '/')
  const csp = res.headers.get('content-security-policy')
  assert.ok(csp, '缺少 Content-Security-Policy')
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /script-src 'self'/)
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'app.js 是外部檔案，不需要也不該放行 inline script')
})

test('連跨來源被擋下的 403 也帶著安全性 header', async () => {
  const res = await rawRequest(`${harness.adminUrl}/api/state`, { headers: { host: 'evil.example' } })
  assert.equal(res.status, 403)
  assert.equal(res.headers['x-frame-options'], 'DENY')
})

// ── admin 的 body 大小上限 ─────────────────────────────────────────
test('PUT /api/config 的 body 超過上限時 413，而不是被整包吃進記憶體', async () => {
  const res = await fetch(`${harness.adminUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: [], note: 'x'.repeat(2 * 1024 * 1024) }),
  })
  assert.equal(res.status, 413)
})
