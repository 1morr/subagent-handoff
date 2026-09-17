import { appendFileSync, renameSync, statSync } from 'node:fs'

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
 * @param {string} opts.file 絕對路徑
 * @param {number} [opts.maxBytes] 超過就輪替成 `<file>.1`。只留一份舊的，所以磁碟最多佔兩倍
 * @returns {(entry: object) => void}
 */
export function createFileSink({ file, maxBytes = 5_000_000 }) {
  let size = sizeOf(file)
  let failing = false

  return (entry) => {
    const line = `${JSON.stringify(entry)}\n`
    const bytes = Buffer.byteLength(line)
    try {
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(file, `${file}.1`)
        size = 0
      }
      // 內含專案目錄與 session id，0600 讓同機其他使用者讀不到
      appendFileSync(file, line, { mode: 0o600 })
      size += bytes
      failing = false
    } catch (err) {
      // 寫不進去不拖垮轉發，記憶體那份還在。每一筆照樣再試（Windows 上常是暫時被鎖住），
      // 但連續失敗只講第一次，恢復之後再壞才會再講
      if (!failing) console.error(`✗ could not write the traffic log to ${file}: ${err.message} (kept in memory only until it works again)`)
      failing = true
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
