import path from 'node:path'
import { loadConfig, saveConfig, CONFIG_PATH } from './config.mjs'
import { createProxyServer, TrafficLog } from './proxy.mjs'
import { createAdminServer } from './admin.mjs'
import { createFileSink } from './logfile.mjs'
import { createHttpsProxy } from './connect.mjs'

const HOST = '127.0.0.1'

// package.json 的 engines 只有 npm 在 engine-strict 下才會擋，直接 `node src/index.mjs` 不會。
// 舊 Node 的失敗點在第一次呼叫 fetch（連通性測試或轉發時）才炸，訊息完全指不回版本。
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`✗ subagent-handoff needs Node 20 or later; this is ${process.version}`)
  process.exit(1)
}

let config = await loadConfig()

// 放在設定檔旁邊，而不是啟動時的工作目錄 —— 從哪裡 npm start 都寫到同一個地方
const trafficLogPath = path.join(path.dirname(CONFIG_PATH), 'traffic.log')
const log = new TrafficLog(300, createFileSink({ file: trafficLogPath }))

// 埠是綁定當下決定的；其餘設定每筆請求現查，改完即時生效
const bound = { boundProxyPort: config.proxyPort, boundAdminPort: config.adminPort }

const getConfig = () => config
// HTTPS proxy 模式存檔即時切換，所以現查：GUI 與 guard 看到的都是 router 此刻實際的狀態
const getRuntime = () => ({ ...bound, httpsProxy: httpsProxy.enabled, caCertPath: httpsProxy.certPath })

const proxy = createProxyServer(getConfig, log, { getRuntime })
const httpsProxy = createHttpsProxy(proxy, { dir: path.dirname(CONFIG_PATH) })

function announceHttpsProxy({ changed, created }) {
  if (!changed) return
  console.log(httpsProxy.enabled
    ? `  HTTPS proxy mode is on. CA  ${httpsProxy.certPath}${created ? '  (new)' : ''}`
    : '  HTTPS proxy mode is off: CONNECT is no longer accepted.')
}

async function setConfig(next) {
  // 先切換、再存檔：切換失敗（例如 CA 寫不進去）就不存，GUI 收到錯誤、設定檔也不會跟實際狀態不一致
  const wasOn = httpsProxy.enabled
  const outcome = await httpsProxy.apply(next.httpsProxy === true)
  try {
    config = await saveConfig(next)
  } catch (err) {
    await httpsProxy.apply(wasOn)
    throw err
  }
  announceHttpsProxy(outcome)
  return config
}

let startup
try {
  startup = await httpsProxy.apply(config.httpsProxy)
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(1)
}
const admin = createAdminServer({ getConfig, setConfig, log, getRuntime })

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`${label} port ${port} is already in use — change it in ${CONFIG_PATH} and start again`)
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

const connectHint = httpsProxy.enabled
  ? `  HTTPS proxy mode is on. CA  ${httpsProxy.certPath}${startup.created ? '  (new)' : ''}

  In Claude Code settings.json set HTTPS_PROXY to the proxy above and
  NODE_EXTRA_CA_CERTS to the CA, remove ANTHROPIC_BASE_URL, and leave
  ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY unset to keep the subscription.`
  : `  Point ANTHROPIC_BASE_URL at the proxy above in Claude Code settings.json, and
  leave ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY unset to keep the subscription.`

console.log(`
  subagent-handoff is running

  Proxy   http://${HOST}:${config.proxyPort}
  GUI     http://${HOST}:${config.adminPort}
  Config   ${CONFIG_PATH}
  Traffic  ${trafficLogPath}

${connectHint}
`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    proxy.close()
    admin.close()
    process.exit(0)
  })
}
