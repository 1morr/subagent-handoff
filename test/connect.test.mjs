import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import { createCa, issueLeaf } from '../src/ca.mjs'
import { attachConnect, INTERCEPT_HOST } from '../src/connect.mjs'
import { createHarness, listen, rawRequest, BASE_BODY, SUBSCRIPTION_HEADERS } from './helpers.mjs'

const ca = createCa({ permittedHost: INTERCEPT_HOST })
const warnings = []
let harness

before(async () => {
  harness = await createHarness()
  attachConnect(harness.proxy, issueLeaf(ca, INTERCEPT_HOST), {
    upstreamBaseUrl: harness.upstreamUrl,
    warn: (m) => warnings.push(m),
  })
})
after(() => harness.close())

/** 對 proxy 送 CONNECT，回傳 proxy 的狀態碼與那條 socket（2xx 時就是隧道） */
function connect(authority) {
  const { hostname, port } = new URL(harness.proxyUrl)
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method: 'CONNECT', path: authority })
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket }))
    req.on('error', reject)
    req.end()
  })
}

/** 照 Claude Code 的做法：CONNECT api.anthropic.com:443，信任 router 的 CA，在隧道裡講 HTTPS */
async function viaProxy(path, { method = 'GET', headers = {}, body, trust = ca } = {}) {
  const { socket } = await connect(`${INTERCEPT_HOST}:443`)
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
  const local = await createHarness()
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
