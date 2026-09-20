/*
 * 進條、額度窗與機架席位的判讀 —— 純函數，不碰 DOM、不查語系表。
 *
 * 從 app.js 拆出來的唯一理由是「能被測試 import」：app.js 有頂層 await 又直接動
 * document，在 Node 裡 import 就炸。判讀答錯的代價是畫面說謊（把正常流量標成異常、
 * 把沒被限流說成被限流，兩種都發生過），值得一道閘門。
 *
 * 瀏覽器端由 app.js 用相對路徑靜態 import，admin.mjs 當一般靜態檔案吐出去。
 */

export const isAborted = (e) => !!e.error && /abort/i.test(e.error)

/** 有狀態碼又有錯誤＝回應已經開始轉給 client 才斷掉，不是連不上上游 */
export const isStreamCut = (e) => !!e.error && !isAborted(e) && e.status != null

/**
 * 進行中 / 順利 / 有事發生 / 被擋下。顏色不是唯一訊號 —— 每一級都有機架位置與印字旗標。
 *
 * cwd 認不出來**不算**異常：那是 router 這端的觀測缺口，請求本身好好的。
 * 曾經有一條 `if (!e.cwd) return 'chk'`，Claude Code 把 Environment 區段搬走之後
 * 每一筆都成了 chk，「只看異常」跟「全部」再也分不出來。背景請求（壓縮、標題）
 * 本來就沒有那個區段，那條規則連在正常情況下都會誤報。
 */
export function stateOf(e) {
  if (e.error && !isAborted(e)) return 'hold'
  if (e.status >= 400) return 'hold'
  if (e.status == null && !e.error) return 'live'
  if (isAborted(e)) return 'chk'
  if (e.detail) return 'chk' // 200 但串流裡夾著 error 事件
  return 'clr'
}

/**
 * 訂閱額度窗，讀 `anthropic-ratelimit-*`。
 *
 * Anthropic 現在回報的是 `unified-5h-utilization`（0–1 的比例）與 `unified-status`，
 * 不再有 `unified-remaining` / `unified-limit`（實測 2026-09-19）。讀舊欄位會兩個都拿到
 * NaN，於是畫面掉進「限流資訊已回報」的退路、再接上 `unified-reset` 的倒數 —— 看起來
 * 就像被限流，但 `unified-status` 寫的是 `allowed`。
 *
 * @returns {{used: number|null, throttled: boolean, nearLimit: boolean, reset: string|null} | null}
 *   `used` 是百分比；上游沒回報比例時是 null，讓畫面說「沒回報」而不是猜一個數字。
 */
export function quotaWindow(rl) {
  if (!rl) return null
  const util = Number(rl['unified-5h-utilization'])
  // 每一筆成功的回應都帶 reset 時間，所以「有 reset」不等於「被擋」。
  // 只有 unified-status 是上游對「現在擋不擋你」的說法，沒有這個 header 就當沒被擋。
  //
  // 它是一族值，不是二選一：實測看過 `allowed` 與 `allowed_warning`，後者是上游跨過
  // 自己的警告門檻時給的（同一組 header 裡的 unified-5h-surpassed-threshold=0.9，
  // 當時 utilization 0.93），請求照樣 200。拿 `!== 'allowed'` 判斷會把它說成被限流 ——
  // 那正是這個欄位原本犯的錯。以 allowed 開頭就是還放行。
  const status = String(rl['unified-status'] ?? 'allowed')
  const allowed = status.startsWith('allowed')
  return {
    used: Number.isFinite(util) ? Math.round(util * 100) : null,
    throttled: !allowed,
    nearLimit: allowed && status !== 'allowed',
    reset: rl['unified-reset'] ?? null,
  }
}

/** 種類標籤的固定順序：先主對話再子 agent，跟畫面上其他並列的地方一致。 */
const KIND_ORDER = ['main', 'subagent']

const kindsOf = (set) => {
  if (!set) return []
  const rank = (k) => {
    const i = KIND_ORDER.indexOf(k)
    return i < 0 ? KIND_ORDER.length : i
  }
  return [...set].sort((a, b) => rank(a) - rank(b))
}

/**
 * 機架上的第三方席位：被任一條啟用規則指向的 provider，加上 entries 裡實際出現過的。
 *
 * 兩個來源缺一不可 —— 只看規則，規則剛改還沒儲存時新席位不出現；只看記錄，provider
 * 被刪掉之後那些進條就忽然沒有席位卡了（歷史流量還在，只是規則不再指向它）。
 *
 * 回傳按 config.providers 順序排列，每項是
 * `{ providerId, label, provider, entries, kinds }`：
 * - `provider`：config 裡的那一筆；已被刪除 → null
 * - `kinds`：啟用規則指向它的 match 種類去重（main 在前，順序固定）
 * - `label`：config 裡的 label；provider 已刪就用 `entries` 裡該 providerId 第一筆的
 *   target —— 那是送出當下使用者填的名字，也是流量記錄裡僅存的名字
 * - `entries`：該 providerId 的全部記錄，時間窗由呼叫端自己決定（分流帶看 5 分鐘、
 *   快取看全部，這兩個窗刻意不一樣）
 *
 * 兩種東西不算第三方席位：規則指向 passthrough（providerId 是 'passthrough' 或空字串），
 * 以及 entries 裡 providerId 為 null 的（那是走訂閱的）。
 */
export function providerSeats(config, entries) {
  const providers = config?.providers ?? []
  const rules = config?.rules ?? []
  const logs = entries ?? []

  // 規則指向誰、用哪種 match 指向 —— 同一家被主對話與子 agent 兩條規則同時指向是常態。
  // 只認 config 裡還存在的 id：GUI 刪 provider 不會清指向它的規則，不擋的話「規則指空」
  // 會冒出一張從未有過流量、拿內部 id 當名字的幽靈卡。已刪 provider 的歷史流量由下面
  // 的 seen 接住，不缺這一條。
  const configIds = new Set(providers.map((p) => p.id))
  const aimed = new Map()
  for (const r of rules) {
    if (!r.enabled || !r.providerId || r.providerId === 'passthrough') continue
    if (!configIds.has(r.providerId)) continue
    if (!aimed.has(r.providerId)) aimed.set(r.providerId, new Set())
    if (r.match) aimed.get(r.providerId).add(r.match)
  }

  // 記錄裡出現過的 providerId（第一筆留著當 label 的退路）
  const seen = new Map()
  for (const e of logs) {
    if (e.providerId && !seen.has(e.providerId)) seen.set(e.providerId, e)
  }

  const ids = new Set([...aimed.keys(), ...seen.keys()])
  const seat = (id, provider) => ({
    providerId: id,
    provider,
    // 不用 ??：label 被清空成空字串時也要繼續往後退，不然卡片標題只剩前綴
    label: provider?.label || seen.get(id)?.target || id,
    entries: logs.filter((e) => e.providerId === id),
    kinds: kindsOf(aimed.get(id)),
  })

  // 已從 config 刪掉、只在記錄裡的排在最後 —— 它們沒有 config 的順序可依
  return [
    ...providers.filter((p) => ids.has(p.id)).map((p) => seat(p.id, p)),
    ...[...ids].filter((id) => !providers.some((p) => p.id === id)).map((id) => seat(id, null)),
  ]
}
