import { appendFileSync, renameSync, statSync } from 'node:fs'

/** 落檔失敗後多久重試一次；每次失敗再翻倍，封頂在 MAX_RETRY_MS。 */
const BASE_RETRY_MS = 60_000
const MAX_RETRY_MS = 30 * 60_000

/**
 * 把每一筆走完的流量補寫成一行 NDJSON。
 *
 * 記憶體裡那份（TrafficLog）重啟就沒了，可是要查的問題往往橫跨重啟 ——
 * 「昨天那波 529 到底是上游擋的還是連線斷的」只能靠落檔回答。
 *
 * 寫入刻意用同步的：一行幾百 bytes 相對於動輒數秒的請求可以忽略，
 * 換來不必處理 stream 的生命週期，也沒有輪替當下的競態。
 *
 * @param {object} opts
 * @param {string} opts.file 絕對路徑；空字串代表不落檔
 * @param {number} opts.maxBytes 超過就輪替。只留一份舊的，所以磁碟最多佔兩倍
 * @param {number} [opts.baseRetryMs] 落檔失敗後的起始冷卻時間，測試用來縮短等待
 * @param {number} [opts.maxRetryMs] 冷卻時間的封頂
 * @param {() => number} [opts.now] 時鐘來源，測試用來灌假時間
 * @returns {((entry: object) => void) | null}
 */
export function createFileSink({ file, maxBytes, baseRetryMs = BASE_RETRY_MS, maxRetryMs = MAX_RETRY_MS, now = Date.now }) {
  if (!file) return null

  let size = sizeOf(file)
  let cooldownUntil = 0
  let backoffMs = baseRetryMs

  return (entry) => {
    const ts = now()
    // 還在冷卻：這次先不試，記憶體裡那份還在，不必每一筆都重新炸一次
    if (ts < cooldownUntil) return

    const line = `${JSON.stringify(entry)}\n`
    const bytes = Buffer.byteLength(line)
    try {
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(file, `${file}.1`)
        size = 0
      }
      // 內含第三方 API key 相關的 provider id／metadata，0600 讓同機其他使用者讀不到
      appendFileSync(file, line, { mode: 0o600 })
      size += bytes
      backoffMs = baseRetryMs
    } catch (err) {
      // Windows 上這種失敗常常是暫時的（tail、編輯器暫時鎖住檔案）：冷卻一段時間再試，
      // 而不是永久放棄 —— 舊版一次失敗就再也不寫，鎖一放開也不會恢復。
      cooldownUntil = ts + backoffMs
      console.error(
        `✗ could not write the traffic log to ${file}: ${err.message} (retrying in ${Math.round(backoffMs / 1000)}s; until then it is kept in memory only)`,
      )
      backoffMs = Math.min(backoffMs * 2, maxRetryMs)
    }
  }
}

function sizeOf(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
