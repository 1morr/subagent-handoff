/**
 * 席位限速：額度快見底、又不想讓 agent 中斷時，把某個席位的請求頻率壓下來，撐到
 * 5 小時窗重置。
 *
 * 限的是「每分鐘放行幾筆請求」，不是回覆的輸出速度。token 在上游生成時就計費了，
 * 慢慢把 bytes 吐給 Claude Code 不會少花一個 token，只是間接拖慢下一輪；而額度大多
 * 花在每輪重送的 input 上，很短的 tool call 輪次限 output 速度也拖不慢。限請求數才是
 * 直接控制燒額度的速度，而且整個席位共用一個上限，不會隨 fan-out 放大。
 *
 * 排隊發生在送出上游之前，所以不佔上游連線，也不會碰到串流的 300 秒 byte watchdog。
 * 碰得到的是 Claude Code 等回應的逾時：`API_TIMEOUT_MS` 與子 agent 的
 * `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` 預設都是 600 秒。所以一筆最多排 MAX_WAIT_MS，
 * 到了就放行 —— 使用者要的是「不要中斷」，限速是盡力而為，不能反過來害 agent 逾時。
 *
 * 設定只在記憶體裡、重啟就清掉：它是臨時措施，不寫進 config.json。
 */

/** 離 600 秒的逾時留一倍以上的餘裕：放行之後上游還要時間回 header。 */
export const MAX_WAIT_MS = 240_000

/** GUI 收的範圍。上限只是防呆，每分鐘 600 筆已經等於沒在限。 */
export const RPM_MIN = 1
export const RPM_MAX = 600

export function isValidRpm(rpm) {
  return Number.isInteger(rpm) && rpm >= RPM_MIN && rpm <= RPM_MAX
}

/**
 * @param {object} [options]
 * @param {number} [options.maxWaitMs] 測試用：不必真的等 4 分鐘
 */
export function createThrottles({ maxWaitMs = MAX_WAIT_MS } = {}) {
  /** seat → { rpm, queue: [{ at, resolve, reject, signal, onAbort }], last, timer } */
  const seats = new Map()

  const seatOf = (id) => {
    if (!seats.has(id)) seats.set(id, { rpm: null, queue: [], last: -Infinity, timer: null })
    return seats.get(id)
  }

  const release = (s, item, now) => {
    item.signal?.removeEventListener('abort', item.onAbort)
    s.last = now
    item.resolve(now - item.at)
  }

  /** 照 FIFO 放行到期的，再把計時器設在下一個到期點（間隔到了，或排頭等滿上限）。 */
  const pump = (s) => {
    clearTimeout(s.timer)
    s.timer = null
    const now = Date.now()
    if (s.rpm == null) {
      for (const item of s.queue.splice(0)) release(s, item, now)
      return
    }
    const interval = 60_000 / s.rpm
    while (s.queue.length) {
      const head = s.queue[0]
      const due = Math.min(s.last + interval, head.at + maxWaitMs)
      if (now < due) {
        s.timer = setTimeout(() => pump(s), due - now)
        // 計時器不該撐住 process：Ctrl+C 或測試結束時排著的請求本來就沒人等了
        s.timer.unref?.()
        return
      }
      s.queue.shift()
      release(s, head, now)
    }
  }

  return {
    /** @param {string} seat @param {number | null} rpm null ＝ 解除；排著的照新速度重排（解除就全放行） */
    set(seat, rpm) {
      const s = seatOf(seat)
      s.rpm = rpm
      pump(s)
      // 解除就整個忘掉：下次再開從頭算，不讓很久以前的放行時間擋住第一筆
      if (rpm == null) seats.delete(seat)
    },

    /**
     * 輪到這個席位放行時 resolve 等了幾毫秒；沒限速就是 0。
     * signal 中止時（client 在排隊中離開）從佇列拿掉並以 AbortError reject，不佔名額。
     * @returns {Promise<number>}
     */
    acquire(seat, signal) {
      const s = seats.get(seat)
      if (!s || s.rpm == null) return Promise.resolve(0)
      if (signal?.aborted) return Promise.reject(signal.reason)
      return new Promise((resolve, reject) => {
        const item = { at: Date.now(), resolve, reject, signal, onAbort: null }
        item.onAbort = () => {
          const i = s.queue.indexOf(item)
          if (i >= 0) s.queue.splice(i, 1)
          reject(signal.reason)
          pump(s)
        }
        signal?.addEventListener('abort', item.onAbort, { once: true })
        s.queue.push(item)
        pump(s)
      })
    },

    /** @returns {Record<string, { rpm: number, queued: number }>} 只列有設限速的席位 */
    snapshot() {
      const out = {}
      for (const [id, s] of seats) if (s.rpm != null) out[id] = { rpm: s.rpm, queued: s.queue.length }
      return out
    },
  }
}
