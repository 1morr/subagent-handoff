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

/** 同機的其他帳號不該讀得到流量記錄，落檔權限要是 0600。Windows 上這個位元被忽略，無害。 */
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

/** Windows 上 tail／編輯器暫時鎖住檔案是常見、會自己解除的情況：每一筆都照樣再試，但連續失敗只講一次。 */
test('落檔失敗不放棄，連續失敗只報一次錯，恢復之後再壞會再報', () => {
  const { dir } = tmpFile()
  const errors = []
  const originalError = console.error
  console.error = (msg) => errors.push(msg)
  try {
    const nested = path.join(dir, 'later')
    const file = path.join(nested, 'traffic.log')
    const sink = createFileSink({ file })

    sink({ id: 1 })
    sink({ id: 2 })
    assert.equal(errors.length, 1, '目錄不存在：第一次失敗報錯，第二次不再重複')

    fs.mkdirSync(nested)
    sink({ id: 3 })
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim()).id, 3, '鎖一放開就寫得進去，不必重啟')

    fs.rmSync(nested, { recursive: true, force: true })
    sink({ id: 4 })
    assert.equal(errors.length, 2, '恢復過之後又壞，要再講一次')
  } finally {
    console.error = originalError
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
