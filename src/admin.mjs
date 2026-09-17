import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONFIG_PATH, fromClientConfig, fromClientProvider, toClientConfig, describeConfigProblems, providerProblem,
} from './config.mjs'
import { describeRequest, resolveModel, resolveRoute, PASSTHROUGH_LABEL } from './routing.mjs'
import { runProbes } from './probe.mjs'
import { PASSTHROUGH_BASE_URL } from './proxy.mjs'
import { isLocalRequest, rejectForeignOrigin } from './guard.mjs'

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui')

/**
 * 靜態檔案路由：GUI 是單一自帶頁面拆成三個檔案（見 src/ui/），零 bundler、零外部資源。
 * `route` 是 `${method} ${pathname}`，`file` 是 UI_DIR 底下的實體檔名。
 */
const STATIC_ROUTES = {
  'GET /': { file: 'index.html', type: 'text/html; charset=utf-8' },
  'GET /index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  'GET /app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  'GET /app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  // i18n 字典檔：app.js 用相對路徑（./i18n/en.js）靜態 import，跟 app.js 一樣是外部
  // 檔案、同源，CSP 的 script-src 'self' 已經涵蓋，不必額外放寬。
  'GET /i18n/en.js': { file: 'i18n/en.js', type: 'text/javascript; charset=utf-8' },
  'GET /i18n/zh-Hant.js': { file: 'i18n/zh-Hant.js', type: 'text/javascript; charset=utf-8' },
}

/**
 * GUI 零外部資源，所以可以把 CSP 收得很緊。`script-src 'self'` 沒有 `'unsafe-inline'`——
 * app.js 是外部檔案，頁面裡沒有任何 inline `<script>`。`style-src` 留著
 * `'unsafe-inline'`：畫面上大量用行內 `style="…"` 表達資料驅動的版面（進條寬度、
 * 席位色、負載柱高度），把這些改寫成 class 是一次不小的重繪，不在這次的範圍內。
 * `connect-src 'self'` 是 GUI 打 `/api/*` 需要的，`img-src data:` 是內嵌 SVG favicon 需要的。
 */
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"

/** 這三個 header 加在**每一個**回應上（包含 403），擋的是框住整個 GUI 誘導點擊、以及瀏覽器對 content-type 的猜測。 */
function applySecurityHeaders(res) {
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('content-security-policy', CSP)
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 這個 server 讀進來的東西全部要存進 config.json 或送去第三方，不能沒有上限地吃記憶體。 */
const MAX_ADMIN_BODY_BYTES = 1024 * 1024

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_ADMIN_BODY_BYTES) {
      throw Object.assign(new Error(`request body exceeds the ${MAX_ADMIN_BODY_BYTES} byte limit`), { code: 'BODY_TOO_LARGE' })
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {(cfg: object) => Promise<object>} deps.setConfig
 * @param {import('./proxy.mjs').TrafficLog} deps.log
 * @param {() => object} deps.getRuntime
 */
export function createAdminServer({ getConfig, setConfig, log, getRuntime }) {
  const runtimeState = () => ({ ...getRuntime(), configPath: CONFIG_PATH, passthroughBaseUrl: PASSTHROUGH_BASE_URL })

  return http.createServer(async (req, res) => {
    applySecurityHeaders(res)

    // 這台 server 握有 API key 的還原能力與整份設定的寫入權，來源檢查必須在路由之前
    if (!isLocalRequest(req, getRuntime().boundAdminPort)) {
      rejectForeignOrigin(res)
      return
    }

    try {
      // 放在 try 裡面：`GET //[` 這種請求行會讓 new URL 拋錯，接不住就是 unhandled rejection，整個 process 跟著死
      const url = new URL(req.url, 'http://127.0.0.1')
      const route = `${req.method} ${url.pathname}`

      if (STATIC_ROUTES[route]) {
        const { file, type } = STATIC_ROUTES[route]
        const body = await readFile(path.join(UI_DIR, file), 'utf8')
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
        res.end(body)
        return
      }

      if (route === 'GET /api/state') {
        send(res, 200, { config: toClientConfig(getConfig()), runtime: runtimeState() })
        return
      }

      if (route === 'PUT /api/config') {
        const incoming = await readJson(req)
        const problems = describeConfigProblems(incoming, getConfig())
        if (problems.length) return send(res, 400, { error: problems.join('；') })
        const saved = await setConfig(fromClientConfig(incoming, getConfig()))
        send(res, 200, { config: toClientConfig(saved), runtime: runtimeState() })
        return
      }

      if (route === 'POST /api/test') {
        const { provider, model } = await readJson(req)
        if (!provider || typeof provider !== 'object') return send(res, 400, { error: 'missing provider' })
        const problem = providerProblem(provider, getConfig())
        if (problem) return send(res, 400, { error: problem })
        // 前端只拿得到遮罩，測試未儲存的設定時要把真 key 補回來（baseUrl 沒換才行，上面已經擋過）
        send(res, 200, await runProbes(fromClientProvider(provider, getConfig()), { model }))
        return
      }

      if (route === 'POST /api/routing/preview') {
        const { kind = 'subagent', model = 'claude-opus-5', config } = await readJson(req)
        // 用前端當前（可能未儲存）的規則做預覽
        const effective = config ? fromClientConfig(config, getConfig()) : getConfig()
        const headers = {}
        if (kind === 'subagent') headers['x-claude-code-agent-id'] = 'preview-agent'
        const ctx = describeRequest(headers, { model })
        const decision = resolveRoute(effective, ctx)
        send(res, 200, {
          kind: ctx.kind,
          requestedModel: model,
          target: decision.kind === 'provider' ? decision.provider.label : PASSTHROUGH_LABEL,
          providerId: decision.kind === 'provider' ? decision.provider.id : null,
          ruleId: decision.rule?.id ?? null,
          sentModel: resolveModel(decision, model),
        })
        return
      }

      if (route === 'GET /api/logs') {
        send(res, 200, { entries: log.list() })
        return
      }

      if (route === 'POST /api/logs/clear') {
        log.clear()
        send(res, 200, { ok: true })
        return
      }

      send(res, 404, { error: 'not found' })
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') return send(res, 413, { error: err.message })
      send(res, 500, { error: String(err.message ?? err) })
    }
  })
}
