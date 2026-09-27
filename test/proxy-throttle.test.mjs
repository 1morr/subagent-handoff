import test, { before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { createHarness, makePost, BASE_BODY, SUBSCRIPTION_HEADERS } from './helpers.mjs'

let harness, post
const SUBAGENT = { ...SUBSCRIPTION_HEADERS, 'x-claude-code-agent-id': 'a' }

before(async () => {
  harness = await createHarness()
  post = makePost(harness.proxyUrl, harness.upstream)
})
after(() => harness.close())
afterEach(() => {
  harness.throttles.set('kimi', null)
  harness.throttles.set('passthrough', null)
})

/** 等到流量記錄最新一筆滿足條件（排隊中的請求還沒有回應，只能從記錄看）。 */
async function waitForEntry(pred) {
  for (let i = 0; i < 100; i++) {
    const e = harness.logStore.list()[0]
    if (e && pred(e)) return e
    await sleep(10)
  }
  throw new Error('entry never appeared')
}

test('席位限速：同一席位的請求照間隔放行，排隊時間記在 waitMs', async () => {
  harness.throttles.set('kimi', 600) // 每 100ms 一筆
  const results = await Promise.all([1, 2, 3].map(() => post(SUBAGENT, BASE_BODY).then((r) => r.text())))
  assert.equal(results.length, 3)

  const entries = harness.logStore.list().slice(0, 3)
  assert.ok(entries.every((e) => e.providerId === 'kimi' && e.status === 200))
  const waits = entries.map((e) => e.waitMs ?? 0).sort((a, b) => a - b)
  assert.equal(waits[0], 0, '第一筆不用排')
  assert.ok(waits[1] >= 90 && waits[2] >= 190, `後兩筆要各等一個間隔，實際 ${waits}`)
  assert.ok(entries.every((e) => !('queued' in e)), '排隊標記在放行後要拿掉，不然會跟著落進 traffic.log')
})

test('席位限速只管那個席位：訂閱線的主對話照常放行', async () => {
  harness.throttles.set('kimi', 1)
  await (await post(SUBAGENT, BASE_BODY)).text()

  const started = Date.now()
  const res = await post(SUBSCRIPTION_HEADERS, BASE_BODY)
  await res.text()
  assert.equal(res.status, 200)
  assert.ok(Date.now() - started < 1000, 'kimi 的限速不該拖到訂閱席位')
  assert.equal(harness.logStore.list()[0].waitMs, null)
})

test('訂閱席位的 key 是 passthrough', async () => {
  harness.throttles.set('passthrough', 600)
  await Promise.all([1, 2].map(() => post(SUBSCRIPTION_HEADERS, BASE_BODY).then((r) => r.text())))
  const waits = harness.logStore.list().slice(0, 2).map((e) => e.waitMs ?? 0)
  assert.ok(Math.max(...waits) >= 90, `第二筆要排隊，實際 ${waits}`)
})

test('count_tokens 不花額度，不排隊', async () => {
  harness.throttles.set('kimi', 1)
  await (await post(SUBAGENT, BASE_BODY)).text()

  const started = Date.now()
  const res = await fetch(`${harness.proxyUrl}/v1/messages/count_tokens?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...SUBAGENT },
    body: JSON.stringify(BASE_BODY),
  })
  await res.text()
  assert.ok(Date.now() - started < 1000, 'count_tokens 被限速卡住了')
})

test('排隊中 client 離開：不送上游、記成 client aborted、名額還回去', async () => {
  harness.throttles.set('kimi', 1)
  await (await post(SUBAGENT, BASE_BODY)).text()

  harness.upstream.state.received = []
  const ac = new AbortController()
  const pending = fetch(`${harness.proxyUrl}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...SUBAGENT },
    body: JSON.stringify(BASE_BODY),
    signal: ac.signal,
  }).catch(() => {})
  const entry = await waitForEntry((e) => e.queued === true)
  assert.equal(entry.status, null, '排隊中的進條是在途狀態')
  assert.deepEqual(harness.throttles.snapshot().kimi, { rpm: 1, queued: 1 })

  ac.abort()
  await pending
  await waitForEntry((e) => e.id === entry.id && e.error != null)
  assert.equal(entry.error, 'client aborted')
  assert.equal(harness.upstream.state.received.length, 0, '沒人在等了，不該再打上游')
  assert.deepEqual(harness.throttles.snapshot().kimi, { rpm: 1, queued: 0 })
})
