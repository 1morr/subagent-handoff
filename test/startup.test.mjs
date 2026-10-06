// src/index.mjs 一 import 就綁埠，所以不在行程內載入，改成起一個子行程跑真的 `npm start` 路徑。
// 守的是 ROUTER_HOST：Docker 映像靠它綁 0.0.0.0，沒設時必須維持只綁 127.0.0.1。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.mjs')

/** 跟 OS 要一個當下空著的埠。關掉到子行程綁上之間有極小的空窗，測試裡可以接受。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * 用一份暫存設定檔啟動 router，等到啟動訊息印完才回傳。設定檔與 traffic.log 都落在暫存目錄，
 * 絕不碰 repo 裡真的 config.json。
 */
async function start(t, env) {
  const dir = await mkdtemp(path.join(tmpdir(), 'handoff-startup-'))
  const config = path.join(dir, 'config.json')
  const ports = { proxyPort: await freePort(), adminPort: await freePort() }
  await writeFile(config, JSON.stringify(ports))

  const childEnv = { ...process.env, ROUTER_CONFIG: config, ...env }
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k]
  const child = spawn(process.execPath, [ENTRY], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(async () => {
    child.kill()
    await new Promise((resolve) => (child.exitCode === null ? child.once('exit', resolve) : resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  let out = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`router did not start:\n${out}`)), 15_000)
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (out.includes('Traffic')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr.on('data', (chunk) => (out += chunk))
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`router exited with ${code}:\n${out}`))
    })
  })
  return { out, ...ports }
}

test('without ROUTER_HOST the router binds loopback only and says nothing about it', async (t) => {
  const { out, adminPort } = await start(t, { ROUTER_HOST: undefined })
  assert.doesNotMatch(out, /Listen/)
  assert.match(out, new RegExp(`GUI     http://127\\.0\\.0\\.1:${adminPort}`))
  const res = await fetch(`http://127.0.0.1:${adminPort}/`)
  assert.equal(res.status, 200)
})

test('ROUTER_HOST=0.0.0.0 binds every interface, still prints loopback URLs, and still serves locally', async (t) => {
  const { out, proxyPort, adminPort } = await start(t, { ROUTER_HOST: '0.0.0.0' })
  assert.match(out, /Listen {3}0\.0\.0\.0 {2}\(ROUTER_HOST\)/)
  // 給人貼進 settings.json 的網址不能變成 0.0.0.0：guard 只收本機主機名的 Host
  assert.match(out, new RegExp(`Proxy   http://127\\.0\\.0\\.1:${proxyPort}`))
  const res = await fetch(`http://127.0.0.1:${adminPort}/`)
  assert.equal(res.status, 200)
})
