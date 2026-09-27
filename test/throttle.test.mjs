import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { createThrottles, isValidRpm } from '../src/throttle.mjs'

/** 同時丟進 n 筆，回傳各自等了多久（照 resolve 的順序）。 */
async function fire(throttles, seat, n) {
  const order = []
  await Promise.all(Array.from({ length: n }, (_, i) => throttles.acquire(seat).then((ms) => order.push({ i, ms }))))
  return order
}

test('沒設限速的席位直接放行', async () => {
  const th = createThrottles()
  assert.equal(await th.acquire('kimi'), 0)
  th.set('kimi', null)
  assert.equal(await th.acquire('kimi'), 0)
  assert.deepEqual(th.snapshot(), {})
})

test('限速時照 FIFO、每個間隔放行一筆', async () => {
  const th = createThrottles()
  th.set('kimi', 600) // 每 100ms 一筆
  const order = await fire(th, 'kimi', 3)
  assert.deepEqual(order.map((o) => o.i), [0, 1, 2], '先到先放')
  assert.ok(order[0].ms < 30, `第一筆不該等，實際 ${order[0].ms}ms`)
  assert.ok(order[1].ms >= 90, `第二筆要等一個間隔，實際 ${order[1].ms}ms`)
  assert.ok(order[2].ms >= 190, `第三筆要等兩個間隔，實際 ${order[2].ms}ms`)
})

test('席位之間互不影響', async () => {
  const th = createThrottles()
  th.set('kimi', 1)
  await th.acquire('kimi')
  // kimi 下一筆要等一分鐘，但 other 與訂閱沒限速
  assert.equal(await th.acquire('other'), 0)
  assert.equal(await th.acquire('passthrough'), 0)
})

test('排滿上限就放行，不讓 agent 撞上 Claude Code 的逾時', async () => {
  const th = createThrottles({ maxWaitMs: 80 })
  th.set('kimi', 1)
  await th.acquire('kimi')
  const started = Date.now()
  const waited = await th.acquire('kimi')
  assert.ok(waited >= 70 && Date.now() - started < 1000, `應該在上限附近放行，實際等了 ${waited}ms`)
})

test('解除限速時排著的全部放行', async () => {
  const th = createThrottles()
  th.set('kimi', 1)
  await th.acquire('kimi')
  const pending = Promise.all([th.acquire('kimi'), th.acquire('kimi')])
  await sleep(20)
  assert.deepEqual(th.snapshot(), { kimi: { rpm: 1, queued: 2 } })
  th.set('kimi', null)
  const waits = await pending
  assert.ok(waits.every((ms) => ms < 500), `解除後應立即放行，實際 ${waits}`)
  assert.deepEqual(th.snapshot(), {})
})

test('解除後再開從頭算：第一筆不被上一輪的放行時間擋住', async () => {
  const th = createThrottles()
  th.set('kimi', 1)
  await th.acquire('kimi')
  th.set('kimi', null)
  th.set('kimi', 1)
  assert.equal(await th.acquire('kimi'), 0)
})

test('排隊中 client 離開：從佇列拿掉、以 AbortError 結束，不佔後面的名額', async () => {
  const th = createThrottles()
  th.set('kimi', 600)
  await th.acquire('kimi')
  const ac = new AbortController()
  const gone = th.acquire('kimi', ac.signal)
  const next = th.acquire('kimi')
  ac.abort()
  await assert.rejects(gone, { name: 'AbortError' })
  const waited = await next
  assert.ok(waited < 150, `離開的那筆不該讓下一筆多等一個間隔，實際 ${waited}ms`)
  assert.deepEqual(th.snapshot(), { kimi: { rpm: 600, queued: 0 } })
})

test('isValidRpm 只收 1–600 的整數', () => {
  for (const ok of [1, 6, 600]) assert.equal(isValidRpm(ok), true, String(ok))
  for (const bad of [0, -1, 601, 1.5, '6', null, NaN]) assert.equal(isValidRpm(bad), false, String(bad))
})
