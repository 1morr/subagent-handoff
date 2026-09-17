import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createProxyServer, TrafficLog } from '../src/proxy.mjs'
import { normalizeConfig } from '../src/config.mjs'
import { createHarness, listen, rawRequest, BASE_BODY } from './helpers.mjs'

let harness

before(async () => {
  harness = await createHarness()
})
after(() => harness.close())

test('admin：跨來源的 Origin 被擋下，而且設定一個字都沒被改到', async () => {
  const before = JSON.stringify(harness.getConfig().passthrough)
  const res = await rawRequest(`${harness.adminUrl}/api/config`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example',
      host: new URL(harness.adminUrl).host,
    },
    body: JSON.stringify({ passthrough: { baseUrl: 'https://evil.example' } }),
  })
  assert.equal(res.status, 403)
  assert.equal(JSON.stringify(harness.getConfig().passthrough), before, '擋下來就不該碰設定')
})

test('admin：POST /api/test 的簡單請求 CSRF 被擋下 —— 真 key 不會被送出門', async () => {
  const res = await rawRequest(`${harness.adminUrl}/api/test`, {
    // text/plain 在瀏覽器上不觸發 preflight，這正是這條路徑原本危險的原因
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example', host: new URL(harness.adminUrl).host },
    body: JSON.stringify({
      provider: { id: 'kimi', apiKey: '__keep__', baseUrl: 'http://127.0.0.1:1', authStyle: 'bearer' },
      tests: ['connectivity'],
    }),
  })
  assert.equal(res.status, 403)
})

test('admin：外來 Host 被擋下 —— DNS rebinding 進不來', async () => {
  const res = await rawRequest(`${harness.adminUrl}/api/state`, { headers: { host: 'evil.example' } })
  assert.equal(res.status, 403)
})

test('admin：沒有 Origin（Claude Code / curl）與自己的 Origin 都放行', async () => {
  const bare = await rawRequest(`${harness.adminUrl}/api/state`, { headers: { host: new URL(harness.adminUrl).host } })
  assert.equal(bare.status, 200)

  // getRuntime 在測試裡回報 boundAdminPort=8788，守衛就是拿它組出允許的 Origin
  const own = await rawRequest(`${harness.adminUrl}/api/state`, {
    headers: { host: new URL(harness.adminUrl).host, origin: 'http://127.0.0.1:8788' },
  })
  assert.equal(own.status, 200)
})

test('admin：沙箱 iframe 的 Origin: null 不算「沒有 Origin」', async () => {
  const res = await rawRequest(`${harness.adminUrl}/api/state`, {
    headers: { host: new URL(harness.adminUrl).host, origin: 'null' },
  })
  assert.equal(res.status, 403)
})

test('proxy：跨來源請求被擋下，一個 byte 都不往上游送', async () => {
  harness.upstream.state.received = []
  const res = await rawRequest(`${harness.proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example', host: new URL(harness.proxyUrl).host },
    body: JSON.stringify(BASE_BODY),
  })
  assert.equal(res.status, 403)
  assert.equal(harness.upstream.state.received.length, 0, '擋下來的請求不該產生任何上游流量')
})

test('proxy：外來 Host 被擋下', async () => {
  harness.upstream.state.received = []
  const res = await rawRequest(`${harness.proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { host: 'evil.example', 'content-type': 'application/json' },
    body: JSON.stringify(BASE_BODY),
  })
  assert.equal(res.status, 403)
  assert.equal(harness.upstream.state.received.length, 0)
})

/**
 * item 10：guard 原本比對的是 `config.proxyPort`（即時設定），而不是實際綁定的埠
 * （`getRuntime().boundProxyPort`）。使用者在 GUI 改了 proxyPort 又還沒重啟時，
 * 這兩個值會不一樣 —— guard 應該信「真正在監聽的那個」，不是「設定檔現在寫的那個」。
 */
test('proxy 的 Origin 檢查看的是實際綁定的埠，不是即時的 config.proxyPort', async () => {
  const config = normalizeConfig({ passthrough: { baseUrl: harness.upstreamUrl }, proxyPort: 8787 })
  const logStore = new TrafficLog(10)
  // 模擬「GUI 剛改了 proxyPort，還沒重啟」：config.proxyPort 已經是 9999，
  // 但實際綁定、也是 getRuntime 回報的仍然是 8787
  const proxy = createProxyServer(() => config, logStore, { getRuntime: () => ({ boundProxyPort: 8787 }) })
  const proxyUrl = await listen(proxy)
  try {
    // 帶「新設定值」的 Origin 應該被擋 —— 那個埠上根本沒有東西在聽
    config.proxyPort = 9999
    const staleOrigin = await rawRequest(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:9999', host: new URL(proxyUrl).host, 'content-type': 'application/json' },
      body: JSON.stringify(BASE_BODY),
    })
    assert.equal(staleOrigin.status, 403, 'config.proxyPort 已經跟實際綁定的埠不一致，不該被信任')

    // 帶「實際綁定的埠」的 Origin 應該放行
    const realOrigin = await rawRequest(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:8787', host: new URL(proxyUrl).host, 'content-type': 'application/json' },
      body: JSON.stringify(BASE_BODY),
    })
    assert.equal(realOrigin.status, 200, '實際綁定的埠才是 guard 該信的來源')
  } finally {
    proxy.close()
  }
})
