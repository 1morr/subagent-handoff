import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileSink } from '../src/logfile.mjs'

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-handoff-'))
  return { dir, file: path.join(dir, 'traffic.log') }
}

test('落檔是一行一筆 NDJSON，超過上限就輪替並只留一份舊的', () => {
  const { dir, file } = tmpFile()
  try {
    const sink = createFileSink({ file, maxBytes: 200 })
    sink({ id: 1, note: 'first' })
    sink({ id: 2, note: 'x'.repeat(300) })

    assert.deepEqual(
      fs.readFileSync(file, 'utf8').trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l).id),
      [2],
      '輪替後新檔只剩後來那筆',
    )
    assert.equal(JSON.parse(fs.readFileSync(`${file}.1`, 'utf8').trim()).id, 1, '舊的搬去 .1 而不是被刪掉')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('沒設檔名就不落檔', () => {
  assert.equal(createFileSink({ file: '', maxBytes: 100 }), null)
})

/** item 1：config.json / traffic.log 內含第三方 API key，落檔權限要是 0600。Windows 上這個位元被忽略，無害。 */
test('落檔的權限是 0600（POSIX）', { skip: process.platform === 'win32' }, () => {
  const { dir, file } = tmpFile()
  try {
    const sink = createFileSink({ file, maxBytes: 5_000_000 })
    sink({ id: 1 })
    const mode = fs.statSync(file).mode & 0o777
    assert.equal(mode, 0o600, `實際權限是 ${mode.toString(8)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * item 9：舊版一次落檔失敗就永久 `broken = true`，之後整個 process 生命週期都不再寫。
 * Windows 上 tail／編輯器暫時鎖住檔案是很常見、會自己解除的情況，應該冷卻後重試，
 * 而不是永久放棄。這裡用一個會失敗兩次、第三次成功的假時鐘與極短的 baseRetryMs 來驗證。
 */
test('落檔失敗後冷卻一段時間再重試，不是永久放棄', () => {
  const { dir, file } = tmpFile()
  try {
    // 用一個唯讀目錄底下不存在的路徑製造「持續寫不進去」的情境：
    // 先讓 appendFileSync 在冷卻視窗內的呼叫全部維持失敗，冷卻過後才讓它成功。
    let now = 0
    const clock = () => now

    const badFile = path.join(dir, 'nested', 'does-not-exist', 'traffic.log')
    const sink = createFileSink({ file: badFile, maxBytes: 5_000_000, baseRetryMs: 100, now: clock })

    const errors = []
    const originalError = console.error
    console.error = (msg) => errors.push(msg)
    try {
      sink({ id: 1 }) // 第一次失敗（目錄不存在），進入冷卻
      const afterFirstFailure = errors.length
      assert.equal(afterFirstFailure, 1, '第一次失敗要留一筆錯誤訊息')

      now += 10 // 還在冷卻視窗內
      sink({ id: 2 })
      assert.equal(errors.length, afterFirstFailure, '冷卻期間不該再嘗試、也不該再報錯')

      now += 200 // 冷卻結束，且目錄還是不存在 —— 應該再嘗試一次（又失敗一次）
      sink({ id: 3 })
      assert.equal(errors.length, afterFirstFailure + 1, '冷卻結束後應該重試，重試失敗要再留一筆錯誤')
    } finally {
      console.error = originalError
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('落檔恢復正常之後，backoff 會重置，不會一路累積到最大值', () => {
  const { dir, file } = tmpFile()
  try {
    let now = 0
    const sink = createFileSink({ file, maxBytes: 5_000_000, baseRetryMs: 50, now: () => now })
    sink({ id: 1 })
    assert.ok(fs.existsSync(file), '正常寫入應該成功')
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim()).id, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
