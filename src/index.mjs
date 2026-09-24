import path from 'node:path'
import { loadConfig, saveConfig, CONFIG_PATH } from './config.mjs'
import { createProxyServer, TrafficLog } from './proxy.mjs'
import { createAdminServer } from './admin.mjs'
import { createFileSink } from './logfile.mjs'
import { loadOrCreateCa, issueLeaf } from './ca.mjs'
import { attachConnect, INTERCEPT_HOST } from './connect.mjs'

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

// 跟 config.json 放在一起：私鑰的保護等級與它相同，換機器時也是一起帶走
const ca = await loadOrCreateCa(path.dirname(CONFIG_PATH), INTERCEPT_HOST)

// 埠是綁定當下決定的；其餘設定每筆請求現查，改完即時生效
const bound = { boundProxyPort: config.proxyPort, boundAdminPort: config.adminPort, caCertPath: ca.certPath }

const getConfig = () => config
const getRuntime = () => bound

async function setConfig(next) {
  config = await saveConfig(next)
  return config
}

const proxy = createProxyServer(getConfig, log, { getRuntime })
const decrypted = attachConnect(proxy, issueLeaf(ca, INTERCEPT_HOST))
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

// 兩台都要：CONNECT 解開的請求由 decrypted 那台解析 HTTP，逾時看的是它的設定
for (const server of [proxy, decrypted]) {
  // Claude Code 會等串流等很久，別讓 Node 提前砍掉連線
  server.headersTimeout = 0
  server.requestTimeout = 0
  server.timeout = 0
  // Node 預設閒置 5 秒就砍掉 keep-alive 連線，並把 `Keep-Alive: timeout=5` 告訴 client。
  // 兩輪對話之間閒置遠不只 5 秒，砍掉只是逼 Claude Code 每次重連，多一次握手就多一次失敗機會。
  server.keepAliveTimeout = 5 * 60_000
}

try {
  await listen(proxy, config.proxyPort, 'Proxy')
  await listen(admin, config.adminPort, 'GUI')
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(1)
}

console.log(`
  subagent-handoff is running

  Proxy   http://${HOST}:${config.proxyPort}
  GUI     http://${HOST}:${config.adminPort}
  Config   ${CONFIG_PATH}
  Traffic  ${trafficLogPath}
  CA       ${ca.certPath}${ca.created ? '  (new — restart Claude Code after pointing NODE_EXTRA_CA_CERTS at it)' : ''}

  In ~/.claude/settings.json set env HTTPS_PROXY=http://${HOST}:${config.proxyPort} and
  NODE_EXTRA_CA_CERTS to the CA above (works in the CLI and in Claude Desktop), or
  ANTHROPIC_BASE_URL=http://${HOST}:${config.proxyPort} (CLI only). Leave
  ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY unset to keep the subscription.
`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    proxy.close()
    admin.close()
    process.exit(0)
  })
}
