import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// CONFIG_PATH 在 import 當下由 ROUTER_CONFIG 決定，所以先設好再動態 import。
// node --test 每個測試檔各跑一個 process，這裡改環境變數不會影響別的檔案。
const dir = await mkdtemp(path.join(tmpdir(), 'config-save-'))
process.env.ROUTER_CONFIG = path.join(dir, 'config.json')
const { saveConfig, defaultConfig } = await import('../src/config.mjs')

test('saveConfig 同時存好幾次：每次都成功，config.json 是完整的 JSON，不留暫存檔', async () => {
  // 共用同一個暫存檔名時，交錯的寫入會拼出壞掉的 JSON，先 rename 走的那次還會讓後面的 ENOENT
  try {
    const saves = Array.from({ length: 20 }, (_, i) => saveConfig({ ...defaultConfig(), proxyPort: 20000 + i }))
    await Promise.all(saves)
    const saved = JSON.parse(await readFile(process.env.ROUTER_CONFIG, 'utf8'))
    assert.ok(saved.proxyPort >= 20000 && saved.proxyPort < 20020)
    assert.deepEqual(await readdir(dir), ['config.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
