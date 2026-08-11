import { loadConfig, saveConfig, CONFIG_PATH } from './config.mjs'
import { createProxyServer, TrafficLog } from './proxy.mjs'
import { createAdminServer } from './admin.mjs'

const HOST = '127.0.0.1'

let config = await loadConfig()
const log = new TrafficLog()

const boundPorts = { proxy: config.proxyPort, admin: config.adminPort }

const getConfig = () => config
const getRuntime = () => ({
  boundProxyPort: boundPorts.proxy,
  boundAdminPort: boundPorts.admin,
  // port 是啟動時綁定的，改了要重啟才生效；其餘設定即時生效
  restartRequired: config.proxyPort !== boundPorts.proxy || config.adminPort !== boundPorts.admin,
})

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

try {
  await listen(proxy, config.proxyPort, 'Proxy')
  await listen(admin, config.adminPort, 'GUI')
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(1)
}

console.log(`
  model-router 已啟動

  Proxy   http://${HOST}:${config.proxyPort}
  GUI     http://${HOST}:${config.adminPort}
  設定檔  ${CONFIG_PATH}

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
