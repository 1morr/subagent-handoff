import test from 'node:test'
import assert from 'node:assert/strict'
import { isAborted, isStreamCut, stateOf, quotaWindow } from '../src/ui/readout.mjs'

// ── 進條的狀態 ────────────────────────────────────────────────────

test('stateOf 分得出進行中／順利／有事發生／被擋下', () => {
  assert.equal(stateOf({ status: null, error: null }), 'live')
  assert.equal(stateOf({ status: 200, cwd: '/x' }), 'clr')
  assert.equal(stateOf({ status: 400 }), 'hold')
  assert.equal(stateOf({ status: 429 }), 'hold')
  assert.equal(stateOf({ status: null, error: 'fetch failed' }), 'hold')
  assert.equal(stateOf({ status: 200, error: 'AbortError' }), 'chk')
  assert.equal(stateOf({ status: 200, detail: 'overloaded_error' }), 'chk', '200 但串流裡夾著 error 事件')
})

/**
 * 這一條是回歸測試。原本有 `if (!e.cwd) return 'chk'`，Claude Code 把 Environment
 * 區段搬走之後 cwd 全空，每一筆都成了 chk，「只看異常」跟「全部」再也分不出來。
 */
test('cwd 認不出來不算異常 —— 那是觀測缺口，不是請求出事', () => {
  assert.equal(stateOf({ status: 200, cwd: null }), 'clr')
  assert.equal(stateOf({ status: 200, cwd: undefined }), 'clr')

  // 「只看異常」篩掉的東西要真的比「全部」少
  const logs = [
    { status: 200, cwd: null },
    { status: 200, cwd: null },
    { status: 400, cwd: null },
    { status: null, error: null },
  ]
  const attn = logs.filter((e) => ['chk', 'hold'].includes(stateOf(e)))
  assert.equal(attn.length, 1)
  assert.equal(attn[0].status, 400)
})

test('串流中途斷掉跟連不上上游分得開', () => {
  assert.equal(isAborted({ error: 'AbortError: aborted' }), true)
  assert.equal(isAborted({ error: 'fetch failed' }), false)
  assert.equal(isAborted({ error: null }), false)

  // 有狀態碼＝回應已經開始轉出去才斷的
  assert.equal(isStreamCut({ status: 200, error: 'terminated' }), true)
  assert.equal(isStreamCut({ status: null, error: 'fetch failed' }), false, '根本沒連上')
  assert.equal(isStreamCut({ status: 200, error: 'AbortError' }), false, 'client 自己走的')
})

// ── 訂閱額度窗 ────────────────────────────────────────────────────

/** 實測 2026-09-19 從 api.anthropic.com 收到的那一組 header。 */
const LIVE_HEADERS = {
  'unified-5h-reset': '1789765800',
  'unified-5h-status': 'allowed',
  'unified-5h-utilization': '0.63',
  'unified-7d-reset': '1790262000',
  'unified-7d-status': 'allowed',
  'unified-7d-utilization': '0.31',
  'unified-representative-claim': 'five_hour',
  'unified-reset': '1789765800',
  'unified-status': 'allowed',
}

test('quotaWindow 讀 unified-5h-utilization 算出已用百分比', () => {
  assert.deepEqual(quotaWindow(LIVE_HEADERS), { used: 63, throttled: false, reset: '1789765800' })
  assert.equal(quotaWindow(null), null)
})

/**
 * 這一條也是回歸測試。畫面原本讀的是 unified-remaining / unified-limit，Anthropic 已經
 * 不送那兩個，於是每一筆都掉進「限流資訊已回報」的退路再接上 reset 倒數 —— 明明
 * unified-status 是 allowed，看起來卻像被限流。
 */
test('有 reset 時間不等於被限流 —— 只認 unified-status', () => {
  assert.equal(quotaWindow(LIVE_HEADERS).throttled, false, 'allowed 就是沒被擋')
  assert.equal(quotaWindow({ ...LIVE_HEADERS, 'unified-status': 'rejected' }).throttled, true)

  // 沒有 status header 就當沒被擋，不要靠 reset 的有無猜
  assert.equal(quotaWindow({ 'unified-reset': '1789765800' }).throttled, false)
})

test('讀不到用量比例時回 null，讓畫面說「沒回報」而不是猜一個數字', () => {
  assert.equal(quotaWindow({ 'unified-status': 'allowed' }).used, null)
  assert.equal(quotaWindow({ 'unified-5h-utilization': 'n/a' }).used, null)
  // 舊的欄位名已經不供應答案了，不能從它們推出百分比
  assert.equal(quotaWindow({ 'unified-remaining': '30', 'unified-limit': '100' }).used, null)

  assert.equal(quotaWindow({ 'unified-5h-utilization': '0' }).used, 0)
  assert.equal(quotaWindow({ 'unified-5h-utilization': '1' }).used, 100)
  assert.equal(quotaWindow({ 'unified-5h-utilization': '0.005' }).used, 1, '四捨五入')
  assert.equal(quotaWindow({ 'unified-reset': 'x' }).reset, 'x')
  assert.equal(quotaWindow({}).reset, null)
})
