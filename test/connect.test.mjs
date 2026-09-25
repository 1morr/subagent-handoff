import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCa, issueLeaf } from '../src/ca.mjs'
import { attachConnect, createHttpsProxy, INTERCEPT_HOST } from '../src/connect.mjs'
import { createHarness, listen, rawRequest, BASE_BODY, SUBSCRIPTION_HEADERS } from './helpers.mjs'

const ca = createCa({ permittedHost: INTERCEPT_HOST })
const warnings = []
let harness

before(async () => {
  harness = await createHarness({}, { runtime: { httpsProxy: true } })
  attachConnect(harness.proxy, issueLeaf(ca, INTERCEPT_HOST), {
    upstreamBaseUrl: harness.upstreamUrl,
    warn: (m) => warnings.push(m),
  })
})
after(() => harness.close())

/** 對 proxy 送 CONNECT，回傳 proxy 的狀態碼與那條 socket（2xx 時就是隧道） */
function connect(authority, proxyUrl = harness.proxyUrl) {
  const { hostname, port } = new URL(proxyUrl)
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method: 'CONNECT', path: authority })
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket }))
    req.on('error', reject)
    req.end()
  })
}

/** 照 Claude Code 的做法：CONNECT api.anthropic.com:443，信任 router 的 CA，在隧道裡講 HTTPS */
async function viaProxy(path, { method = 'GET', headers = {}, body, trust = ca, proxyUrl = harness.proxyUrl } = {}) {
  const { socket } = await connect(`${INTERCEPT_HOST}:443`, proxyUrl)
  const secure = tls.connect({ socket, servername: INTERCEPT_HOST, ca: trust.certPem })
  await once(secure, 'secureConnect')
  return new Promise((resolve, reject) => {
    const req = http.request({
      method, path, createConnection: () => secure,
      headers: { host: INTERCEPT_HOST, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        secure.destroy()
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

test('CONNECT 解開的子 agent 請求照規則分到 provider，訂閱的 token 不會跟過去', async () => {
  harness.upstream.state.received = []
  const res = await viaProxy('/v1/messages?beta=true', {
    method: 'POST',
    headers: { ...SUBSCRIPTION_HEADERS, 'anthropic-version': '2023-06-01', 'x-claude-code-agent-id': 'agent-1' },
    body: BASE_BODY,
  })
  assert.equal(res.status, 200)
  const [got] = harness.upstream.state.received
  assert.equal(got.headers.authorization, 'Bearer sk-moonshot')
  assert.equal(got.body.model, 'kimi-k3')
  const entry = harness.logStore.list()[0]
  assert.equal(entry.kind, 'subagent')
  assert.equal(entry.providerId, 'kimi')
})

test('CONNECT 解開的主對話請求原樣走訂閱線', async () => {
  harness.upstream.state.received = []
  const res = await viaProxy('/v1/messages?beta=true', {
    method: 'POST',
    headers: { ...SUBSCRIPTION_HEADERS, 'anthropic-version': '2023-06-01' },
    body: BASE_BODY,
  })
  assert.equal(res.status, 200)
  const [got] = harness.upstream.state.received
  assert.equal(got.headers.authorization, SUBSCRIPTION_HEADERS.authorization)
  assert.equal(got.body.model, BASE_BODY.model)
  assert.equal(harness.logStore.list()[0].kind, 'main')
})

test('/v1/messages 以外的路徑原樣轉發，不進流量記錄', async () => {
  // OAuth、feature flag、遙測都是這種；ANTHROPIC_BASE_URL 模式下 router 根本看不到它們
  harness.upstream.state.received = []
  const logged = harness.logStore.list().length
  const res = await viaProxy('/api/oauth/profile', { headers: { authorization: 'Bearer sk-ant-oat-fake' } })
  assert.equal(res.status, 200)
  const [got] = harness.upstream.state.received
  assert.equal(got.url, '/api/oauth/profile')
  assert.equal(got.headers.authorization, 'Bearer sk-ant-oat-fake')
  assert.equal(harness.logStore.list().length, logged)
})

test('明文送來、Host 是 api.anthropic.com 的請求照樣被 guard 擋下', async () => {
  // guard 只對加密的 socket 放行；這是那條例外的對照組，證明它沒有順便開了明文的口
  const res = await rawRequest(`${harness.proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { host: INTERCEPT_HOST, 'content-type': 'application/json' },
    body: JSON.stringify(BASE_BODY),
  })
  assert.equal(res.status, 403)
})

test('其他目的地走純 TCP 隧道，bytes 原樣來回、不進流量記錄', async () => {
  const echo = net.createServer((s) => s.pipe(s))
  const echoPort = new URL(await listen(echo)).port
  const logged = harness.logStore.list().length
  try {
    const { status, socket } = await connect(`127.0.0.1:${echoPort}`)
    assert.equal(status, 200)
    socket.write('ping')
    const [data] = await once(socket, 'data')
    assert.equal(data.toString(), 'ping')
    socket.destroy()
    assert.equal(harness.logStore.list().length, logged)
  } finally {
    echo.close()
  }
})

test('隧道目的地連不上時回 502，而不是讓 client 乾等', async () => {
  const closed = net.createServer()
  const port = new URL(await listen(closed)).port
  await new Promise((resolve) => closed.close(resolve))
  const { status, socket } = await connect(`127.0.0.1:${port}`)
  socket.destroy()
  assert.equal(status, 502)
})

test('CONNECT 的目的地解析不出來時回 400', async () => {
  const { status, socket } = await connect('no-port-here')
  socket.destroy()
  assert.equal(status, 400)
})

test('client 不信任 router 的 CA 時握手失敗，並提示去設 NODE_EXTRA_CA_CERTS', async () => {
  warnings.length = 0
  const stranger = createCa({ permittedHost: INTERCEPT_HOST })
  await assert.rejects(viaProxy('/v1/messages', { trust: stranger }))
  // server 端的 tlsClientError 跟 client 端的錯誤不保證誰先到
  for (let i = 0; i < 50 && !warnings.length; i++) await new Promise((r) => setTimeout(r, 10))
  assert.match(warnings[0] ?? '', /NODE_EXTRA_CA_CERTS/)
})

test('WebSocket upgrade 原樣接到上游（voice mode 用的就是這條）', async () => {
  // 假上游不懂 upgrade，另起一台：回 101 之後把收到的 bytes 原樣彈回去
  const ws = http.createServer()
  let seen = null
  ws.on('upgrade', (req, socket) => {
    seen = { url: req.url, host: req.headers.host, auth: req.headers.authorization }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.pipe(socket)
  })
  const wsUrl = await listen(ws)
  const local = await createHarness({}, { runtime: { httpsProxy: true } })
  attachConnect(local.proxy, issueLeaf(ca, INTERCEPT_HOST), { upstreamBaseUrl: wsUrl, warn: () => {} })
  try {
    const { hostname, port } = new URL(local.proxyUrl)
    const tunnelSocket = await new Promise((resolve, reject) => {
      const req = http.request({ hostname, port, method: 'CONNECT', path: `${INTERCEPT_HOST}:443` })
      req.on('connect', (_res, socket) => resolve(socket))
      req.on('error', reject)
      req.end()
    })
    const secure = tls.connect({ socket: tunnelSocket, servername: INTERCEPT_HOST, ca: ca.certPem })
    await once(secure, 'secureConnect')
    const upgraded = await new Promise((resolve, reject) => {
      const req = http.request({
        path: '/api/ws/speech_to_text/voice_stream',
        createConnection: () => secure,
        headers: { host: INTERCEPT_HOST, connection: 'Upgrade', upgrade: 'websocket', authorization: 'Bearer sk-ant-oat-fake' },
      })
      req.on('upgrade', (_res, socket) => resolve(socket))
      req.on('error', reject)
      req.end()
    })
    upgraded.write('frame')
    const [data] = await once(upgraded, 'data')
    assert.equal(data.toString(), 'frame')
    assert.deepEqual(seen, {
      url: '/api/ws/speech_to_text/voice_stream',
      host: new URL(wsUrl).host,
      auth: 'Bearer sk-ant-oat-fake',
    })
    upgraded.destroy()
  } finally {
    ws.close()
    await local.close()
  }
})

// ── 模式關閉時跟沒有這個功能一樣 ───────────────────────────────────

test('createHttpsProxy：關閉時不掛 CONNECT、不產生 CA，CONNECT 直接被斷線', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'https-proxy-off-'))
  const off = await createHarness()
  try {
    const sw = createHttpsProxy(off.proxy, { dir })
    assert.deepEqual(await sw.apply(false), { changed: false })
    assert.equal(sw.enabled, false)
    assert.equal(off.proxy.listenerCount('connect'), 0)
    assert.deepEqual(await readdir(dir), [], '沒開過就不該有任何 CA 檔案')
    // 沒有 connect 監聽者時 Node 直接關掉連線 —— 跟沒有這個功能時一樣，不回任何狀態碼
    await assert.rejects(connect(`${INTERCEPT_HOST}:443`, off.proxyUrl))
  } finally {
    await off.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('createHttpsProxy：開啟時產生 CA 並掛上 CONNECT —— 上一個測試的對照組', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'https-proxy-on-'))
  const on = await createHarness({}, { runtime: { httpsProxy: true } })
  try {
    const sw = createHttpsProxy(on.proxy, { dir, warn: () => {} })
    assert.deepEqual(await sw.apply(true), { changed: true, created: true })
    assert.equal(on.proxy.listenerCount('connect'), 1)
    assert.equal(sw.certPath, path.join(dir, 'https-proxy-ca.pem'))
    assert.equal((await readdir(dir)).length, 2)
    assert.deepEqual(await sw.apply(true), { changed: false }, '已經開著，不重複掛')
    assert.equal(on.proxy.listenerCount('connect'), 1)
    const { status, socket } = await connect('127.0.0.1:1', on.proxyUrl)
    socket.destroy()
    assert.equal(status, 502, 'CONNECT 有人處理了，只是這個目的地連不上')
  } finally {
    await on.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('createHttpsProxy：兩次打開同時進來只掛一個監聽，關掉後 CONNECT 真的沒了', async () => {
  // 沒有依序執行時，兩次都看到「還沒開」：掛上兩個監聽，關掉只拆得掉一個，CONNECT 照樣被接受
  const dir = await mkdtemp(path.join(tmpdir(), 'https-proxy-race-'))
  const h = await createHarness({}, { runtime: { httpsProxy: true } })
  try {
    const sw = createHttpsProxy(h.proxy, { dir, warn: () => {} })
    const outcomes = await Promise.all([sw.apply(true), sw.apply(true)])
    assert.deepEqual(outcomes.map((o) => o.changed), [true, false])
    assert.equal(h.proxy.listenerCount('connect'), 1)
    const [certPem, keyPem] = await Promise.all(
      ['https-proxy-ca.pem', 'https-proxy-ca-key.pem'].map((f) => readFile(path.join(dir, f), 'utf8')),
    )
    assert.ok(new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem)), '落檔的 CA 證書與私鑰要是同一對')

    await Promise.all([sw.apply(false), sw.apply(false)])
    assert.equal(h.proxy.listenerCount('connect'), 0)
    await assert.rejects(connect('127.0.0.1:1', h.proxyUrl), undefined, '關掉之後 CONNECT 被斷線')
  } finally {
    await h.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('createHttpsProxy：執行中關掉，CONNECT 監聽拿掉、還開著的隧道一起斷；再打開不用重啟', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'https-proxy-toggle-'))
  const h = await createHarness({}, { runtime: { httpsProxy: true } })
  const echo = net.createServer((s) => s.pipe(s))
  const echoPort = new URL(await listen(echo)).port
  let socket = null
  let timer = null
  try {
    const sw = createHttpsProxy(h.proxy, { dir, warn: () => {} })
    await sw.apply(true)
    const tunnel = await connect(`127.0.0.1:${echoPort}`, h.proxyUrl)
    socket = tunnel.socket
    assert.equal(tunnel.status, 200)
    // 關掉之後這條隧道要被斷；不斷的話這裡兩秒後就失敗，而不是讓整個測試卡住
    const closed = Promise.race([
      once(socket, 'close'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('tunnel still open after turning the mode off')), 2000)
      }),
    ])

    assert.deepEqual(await sw.apply(false), { changed: true })
    assert.equal(sw.enabled, false)
    assert.equal(sw.certPath, null)
    assert.equal(h.proxy.listenerCount('connect'), 0)
    await closed
    await assert.rejects(connect(`127.0.0.1:${echoPort}`, h.proxyUrl), undefined, '關掉之後的 CONNECT 被斷線')

    await sw.apply(true)
    const again = await connect(`127.0.0.1:${echoPort}`, h.proxyUrl)
    again.socket.destroy()
    assert.equal(again.status, 200, '再打開立即可用，沿用同一把 CA')
    assert.equal((await readdir(dir)).length, 2)
  } finally {
    // 斷言失敗時隧道可能還開著：不在這裡拆掉，整個 npm test 會卡住不結束，而不是回報失敗
    clearTimeout(timer)
    socket?.destroy()
    echo.close()
    await h.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('guard 的例外只在 HTTPS proxy 模式開著時才存在', async () => {
  // 刻意在 runtime 回報「沒開」的 router 上掛 CONNECT：解開的請求 Host 是 api.anthropic.com，
  // 例外不存在就該被 guard 擋下。開著時同樣的請求會過（本檔第一個測試）
  const off = await createHarness()
  attachConnect(off.proxy, issueLeaf(ca, INTERCEPT_HOST), { upstreamBaseUrl: off.upstreamUrl, warn: () => {} })
  try {
    const res = await viaProxy('/v1/messages?beta=true', {
      method: 'POST',
      headers: { ...SUBSCRIPTION_HEADERS, 'anthropic-version': '2023-06-01' },
      body: BASE_BODY,
      proxyUrl: off.proxyUrl,
    })
    assert.equal(res.status, 403)
  } finally {
    await off.close()
  }
})
