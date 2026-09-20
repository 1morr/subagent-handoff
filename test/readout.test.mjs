import test from 'node:test'
import assert from 'node:assert/strict'
import { isAborted, isStreamCut, stateOf, quotaWindow, providerSeats } from '../src/ui/readout.mjs'

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
  assert.deepEqual(quotaWindow(LIVE_HEADERS), {
    used: 63, throttled: false, nearLimit: false, reset: '1789765800',
  })
  assert.equal(quotaWindow(null), null)
})

/**
 * `unified-status` 是一族值，不是二選一。實測（2026-09-18，5 小時窗 93%）拿到
 * `allowed_warning`：上游跨過自己的警告門檻（同一組 header 的
 * unified-5h-surpassed-threshold = 0.9），但請求照樣 200。
 * 用 `!== 'allowed'` 判斷會把它說成「上游正在限流」—— 使用者正在用，畫面卻在報警。
 */
test('allowed_warning 是接近上限，不是被擋', () => {
  const warned = quotaWindow({ ...LIVE_HEADERS, 'unified-status': 'allowed_warning', 'unified-5h-utilization': '0.93' })
  assert.equal(warned.throttled, false, '還在放行')
  assert.equal(warned.nearLimit, true)
  assert.equal(warned.used, 93)

  const plain = quotaWindow(LIVE_HEADERS)
  assert.equal(plain.nearLimit, false, '單純的 allowed 不該被說成接近上限')

  // 不以 allowed 開頭的才是真的擋人
  for (const status of ['rejected', 'blocked', 'throttled']) {
    const s = quotaWindow({ ...LIVE_HEADERS, 'unified-status': status })
    assert.equal(s.throttled, true, `${status} 應該算被擋`)
    assert.equal(s.nearLimit, false, `${status} 不該同時是接近上限`)
  }
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
  assert.equal(quotaWindow({ 'unified-reset': '1789765800' }).nearLimit, false)
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

// ── 機架上的第三方席位 ────────────────────────────────────────────

const P = (id, label) => ({ id, label, baseUrl: `https://${id}.test`, model: `m-${id}` })

test('providerSeats 讓每一家被規則指向的 provider 各佔一張卡', () => {
  const config = {
    providers: [P('p-kimi', 'Kimi'), P('p-deep', 'Deepseek')],
    rules: [
      { id: 'r1', enabled: true, match: 'main', providerId: 'p-kimi' },
      { id: 'r2', enabled: true, match: 'subagent', providerId: 'p-deep' },
    ],
  }
  const seats = providerSeats(config, [])
  assert.deepEqual(seats.map((s) => s.providerId), ['p-kimi', 'p-deep'], '順序照 config.providers，不是照規則')
  assert.deepEqual(seats.map((s) => s.kinds), [['main'], ['subagent']])
  assert.deepEqual(seats.map((s) => s.label), ['Kimi', 'Deepseek'])
  assert.equal(seats[0].provider, config.providers[0], 'provider 是 config 裡那一筆本身')
})

test('同一家被兩種 match 指向時 kinds 兩個都有，main 在前', () => {
  const config = {
    providers: [P('p-a', 'A')],
    rules: [
      { id: 'r1', enabled: true, match: 'subagent', providerId: 'p-a' },
      { id: 'r2', enabled: true, match: 'main', providerId: 'p-a' },
    ],
  }
  // 兩條規則指向同一家 → 一張卡，不是兩張
  const seats = providerSeats(config, [])
  assert.equal(seats.length, 1)
  assert.deepEqual(seats[0].kinds, ['main', 'subagent'], '順序固定，與規則的先後無關')
})

test('規則被停用且沒有流量就不算席位 —— 但流量一來就又出現', () => {
  const off = { providers: [P('p-a', 'A'), P('p-b', 'B')], rules: [{ id: 'r1', enabled: false, match: 'main', providerId: 'p-a' }] }
  assert.deepEqual(providerSeats(off, []), [], '停用的規則不給席位')

  const seats = providerSeats(off, [{ providerId: 'p-a', target: 'A' }])
  assert.deepEqual(seats.map((s) => s.providerId), ['p-a'])
  assert.deepEqual(seats[0].kinds, [], '只有流量、沒有規則指向 → 種類是空的')
})

test('provider 從 config 刪了但流量還在：卡片留著，名字用送出去當下那個', () => {
  const config = { providers: [P('p-a', 'A')], rules: [] }
  const entries = [
    { providerId: 'p-gone', target: '舊名字' },
    { providerId: 'p-gone', target: '後來改過的' },
  ]
  const seats = providerSeats(config, entries)
  assert.equal(seats.length, 1)
  assert.equal(seats[0].providerId, 'p-gone')
  assert.equal(seats[0].provider, null)
  assert.equal(seats[0].label, '舊名字', '用第一筆 entry 的 target')
  assert.equal(seats[0].entries.length, 2, '該 providerId 的記錄全部帶著')
})

test('沒被規則指向也沒有流量的 provider 不出現 —— 這不是「把 config 全列出來」', () => {
  const config = {
    providers: [P('p-a', 'A'), P('p-unused', '沒人用')],
    rules: [{ id: 'r1', enabled: true, match: 'main', providerId: 'p-a' }],
  }
  assert.deepEqual(providerSeats(config, []).map((s) => s.providerId), ['p-a'])
})

test('指向 passthrough 的規則、以及走訂閱的流量，都不產生第三方席位', () => {
  const config = {
    providers: [P('p-a', 'A')],
    rules: [
      { id: 'r1', enabled: true, match: 'main', providerId: 'passthrough' },
      { id: 'r2', enabled: true, match: 'subagent', providerId: '' },
    ],
  }
  // providerId 為 null 的是走訂閱那條線（見 proxy.mjs 的寫入點），不能算一家
  assert.deepEqual(providerSeats(config, [{ providerId: null, target: 'passthrough (subscription)' }, { providerId: '', target: '' }]), [])
})

test('只被規則指向、還沒有任何流量的席位照樣算一張卡', () => {
  const config = { providers: [P('p-a', 'A')], rules: [{ id: 'r1', enabled: true, match: 'subagent', providerId: 'p-a' }] }
  const [seat] = providerSeats(config, [])
  assert.deepEqual(seat.entries, [], '沒流量就是空的，不是 undefined')
  assert.deepEqual(seat.kinds, ['subagent'])
})

/**
 * GUI 刪 provider 不清指向它的規則，所以「規則指空」是一鍵可達的狀態。
 * 這種 id 一筆流量都沒有過，讓它佔一張卡就是幽靈卡 —— 名字是內部 id、每個欄位都是空的。
 */
test('規則指向 config 裡不存在的 id 不給席位 —— 除非記錄裡真的出現過', () => {
  const config = { providers: [P('p-a', 'A')], rules: [{ id: 'r1', enabled: true, match: 'subagent', providerId: 'p-dead' }] }
  assert.deepEqual(providerSeats(config, []), [], '指空又沒流量 → 幽靈卡')

  const seats = providerSeats(config, [{ providerId: 'p-dead', target: '刪掉前送過' }])
  assert.deepEqual(seats.map((s) => s.providerId), ['p-dead'], '有歷史流量就留卡（由記錄接住，不是規則）')
  assert.equal(seats[0].provider, null)
  assert.deepEqual(seats[0].kinds, [], '規則指向的 id 已不存在，種類不算數')
})
