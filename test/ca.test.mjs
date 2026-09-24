import test from 'node:test'
import assert from 'node:assert/strict'
import tls from 'node:tls'
import { once } from 'node:events'
import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCa, issueLeaf, loadOrCreateCa, CA_CERT_FILE, CA_KEY_FILE } from '../src/ca.mjs'

const HOST = 'api.anthropic.com'

/**
 * 用真的 TLS 握手驗證，不是只檢查欄位：DER 拼錯一個位元組、extension 編錯，
 * OpenSSL 都會在這裡拒絕，而 X509Certificate 的解析不見得會。
 */
async function handshake(ca, leaf, servername) {
  const server = tls.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (s) => s.end())
  server.on('tlsClientError', () => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const client = tls.connect({ port: server.address().port, host: '127.0.0.1', servername, ca: ca.certPem })
    const outcome = await new Promise((resolve) => {
      client.once('secureConnect', () => resolve({ ok: true }))
      client.once('error', (err) => resolve({ ok: false, message: err.message }))
    })
    client.destroy()
    return outcome
  } finally {
    server.close()
  }
}

test('CA 簽出的 api.anthropic.com 證書通得過 TLS 驗證', async () => {
  const ca = createCa({ permittedHost: HOST })
  assert.deepEqual(await handshake(ca, issueLeaf(ca, HOST), HOST), { ok: true })
})

test('nameConstraints 生效：同一把 CA 替別的網域簽的證書，驗證端會拒絕', async () => {
  // 這是私鑰外洩時的保險。上一個測試是它的對照組：同一條路徑、只差網域
  const ca = createCa({ permittedHost: HOST })
  const outcome = await handshake(ca, issueLeaf(ca, 'evil.example.com'), 'evil.example.com')
  assert.equal(outcome.ok, false)
  // Node 給這個錯誤的 code 是 UNSPECIFIED，只有訊息認得出原因
  assert.match(outcome.message, /permitted subtree violation/)
})

test('不信任這把 CA 的 client 握手失敗 —— 系統信任庫裡沒有它', async () => {
  const ca = createCa({ permittedHost: HOST })
  const stranger = createCa({ permittedHost: HOST })
  const outcome = await handshake(stranger, issueLeaf(ca, HOST), HOST)
  assert.equal(outcome.ok, false)
})

test('2050 年以後的到期日改用 GeneralizedTime，仍然解析得出正確年份', () => {
  // CA 效期十年：2045 年產生的 CA 到期日落在 2055，走的是另一種時間編碼
  const ca = createCa({ permittedHost: HOST, now: new Date('2045-06-01T00:00:00Z') })
  assert.match(new X509Certificate(ca.certPem).validTo, /2055/)
})

test('loadOrCreateCa：第一次產生並落檔，之後原樣讀回同一把', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ca-test-'))
  try {
    const first = await loadOrCreateCa(dir, HOST)
    assert.equal(first.created, true)
    assert.equal(first.certPath, path.join(dir, CA_CERT_FILE))
    assert.equal(await readFile(first.certPath, 'utf8'), first.certPem)

    const second = await loadOrCreateCa(dir, HOST)
    assert.equal(second.created, false)
    assert.equal(second.certPem, first.certPem)
    assert.equal(second.keyPem, first.keyPem)

    // Windows 不吃 POSIX mode，config.json 也是同樣的處境（見 docs/security.md）
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(dir, CA_KEY_FILE))).mode & 0o777, 0o600)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
