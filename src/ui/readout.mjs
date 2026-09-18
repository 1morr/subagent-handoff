/*
 * 進條與額度窗的判讀 —— 純函數，不碰 DOM、不查語系表。
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
