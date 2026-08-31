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
 * @param {string} opts.file 絕對路徑；空字串代表不落檔
 * @param {number} opts.maxBytes 超過就輪替。只留一份舊的，所以磁碟最多佔兩倍
 * @returns {((entry: object) => void) | null}
 */
export function createFileSink({ file, maxBytes }) {
  if (!file) return null

  let size = sizeOf(file)
  let broken = false

  return (entry) => {
    if (broken) return
    const line = `${JSON.stringify(entry)}\n`
    const bytes = Buffer.byteLength(line)
    try {
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(file, `${file}.1`)
        size = 0
      }
      appendFileSync(file, line)
      size += bytes
    } catch (err) {
      // 落檔失敗不該拖垮轉發，記憶體那份還在，講一次就閉嘴
      broken = true
      console.error(`✗ 流量記錄寫不進 ${file}：${err.message}（之後只留記憶體那份）`)
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
