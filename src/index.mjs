import path from 'node:path'
import { loadConfig, saveConfig, CONFIG_PATH } from './config.mjs'
import { createProxyServer, TrafficLog } from './proxy.mjs'
import { createAdminServer } from './admin.mjs'
import { createFileSink } from './logfile.mjs'

const HOST = '127.0.0.1'

// package.json 的 engines 只有 npm 在 engine-strict 下才會擋，直接 `node src/index.mjs` 不會。
// 舊 Node 的失敗點在第一次呼叫 fetch（連通性測試或轉發時）才炸，訊息完全指不回版本。
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`✗ subagent-handoff 需要 Node 20 以上，目前是 ${process.version}`)
  process.exit(1)
}

let config = await loadConfig()

// 路徑相對於設定檔，而不是啟動時的工作目錄 —— 從哪裡 npm start 都寫到同一個地方
const trafficLogPath = config.trafficLog.file
  ? path.resolve(path.dirname(CONFIG_PATH), config.trafficLog.file)
  : ''
const log = new TrafficLog(300, createFileSink({ file: trafficLogPath, maxBytes: config.trafficLog.maxBytes }))

/**
 * 啟動時就定下來、之後改了必須重啟才生效的那幾項。
 * 埠是綁定當下決定的；流量記錄的 sink 也只在這裡建立一次，換檔名或改上限都不會自己重來。
 */
const bootedWith = {
  proxyPort: config.proxyPort,
  adminPort: config.adminPort,
  trafficLog: JSON.stringify(config.trafficLog),
}

const getConfig = () => config
const getRuntime = () => {
  // 講清楚是「哪一項」要重啟：只說「需要重啟」會讓人回頭找不到自己改了什麼
  const reasons = []
  if (config.proxyPort !== bootedWith.proxyPort || config.adminPort !== bootedWith.adminPort) reasons.push('埠號')
  if (JSON.stringify(config.trafficLog) !== bootedWith.trafficLog) reasons.push('流量記錄落檔')
  return {
    boundProxyPort: bootedWith.proxyPort,
    boundAdminPort: bootedWith.adminPort,
    // 其餘設定都是每筆請求現查的，改完即時生效
    restartRequired: reasons.length > 0,
    restartReasons: reasons,
  }
}

async function setConfig(next) {
  config = await saveConfig(next)
  return config
}

const proxy = createProxyServer(getConfig, log)
const admin = createAdminServer({ getConfig, setConfig, log, getRuntime })

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`${label} 埠 ${port} 已被佔用，改一下 ${CONFIG_PATH} 裡的埠再啟動`)
          : err,
      )
    })
    server.listen(port, HOST, resolve)
  })
}

// Claude Code 會等串流等很久，別讓 Node 提前砍掉連線
proxy.headersTimeout = 0
proxy.requestTimeout = 0
proxy.timeout = 0
// Node 預設閒置 5 秒就砍掉 keep-alive 連線，並把 `Keep-Alive: timeout=5` 告訴 client。
// 兩輪對話之間閒置遠不只 5 秒，砍掉只是逼 Claude Code 每次重連，多一次握手就多一次失敗機會。
proxy.keepAliveTimeout = 5 * 60_000

try {
  await listen(proxy, config.proxyPort, 'Proxy')
  await listen(admin, config.adminPort, 'GUI')
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(1)
}

console.log(`
  subagent-handoff 已啟動

  Proxy   http://${HOST}:${config.proxyPort}
  GUI     http://${HOST}:${config.adminPort}
  設定檔  ${CONFIG_PATH}
  流量記錄 ${trafficLogPath || '(不落檔)'}

  在 Claude Code 的 settings.json 裡設 ANTHROPIC_BASE_URL 指向上面的 Proxy，
  且不要設 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY，訂閱登入才會保留。
`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    proxy.close()
    admin.close()
    process.exit(0)
  })
}
