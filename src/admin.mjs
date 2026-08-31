import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_PATH, KEEP_SECRET, fromClientConfig, toClientConfig } from './config.mjs'
import { describeRequest, resolveModel, resolveRoute } from './routing.mjs'
import { runProbes } from './probe.mjs'
import { isLocalRequest, rejectForeignOrigin } from './guard.mjs'

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui')

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
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
  return http.createServer(async (req, res) => {
    // 這台 server 握有 API key 的還原能力與整份設定的寫入權，來源檢查必須在路由之前
    if (!isLocalRequest(req, getRuntime().boundAdminPort)) {
      rejectForeignOrigin(res)
      return
    }

    const url = new URL(req.url, 'http://127.0.0.1')
    const route = `${req.method} ${url.pathname}`

    try {
      if (route === 'GET /' || route === 'GET /index.html') {
        const html = await readFile(path.join(UI_DIR, 'index.html'), 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }

      if (route === 'GET /api/state') {
        send(res, 200, {
          config: toClientConfig(getConfig()),
          runtime: { ...getRuntime(), configPath: CONFIG_PATH },
        })
        return
      }

      if (route === 'PUT /api/config') {
        const incoming = await readJson(req)
        const saved = await setConfig(fromClientConfig(incoming, getConfig()))
        send(res, 200, { config: toClientConfig(saved), runtime: { ...getRuntime(), configPath: CONFIG_PATH } })
        return
      }

      if (route === 'POST /api/test') {
        const { provider, model, tests } = await readJson(req)
        if (!provider) return send(res, 400, { error: '缺少 provider' })
        // 前端只拿得到遮罩，測試未儲存的設定時要把真 key 補回來
        const resolved = { ...provider }
        if (resolved.apiKey === KEEP_SECRET) {
          resolved.apiKey = getConfig().providers.find((p) => p.id === resolved.id)?.apiKey ?? ''
        }
        send(res, 200, await runProbes(resolved, { model, tests }))
        return
      }

      if (route === 'POST /api/routing/preview') {
        const { kind = 'subagent', model = 'claude-opus-5', agentId = '', config } = await readJson(req)
        // 用前端當前（可能未儲存）的規則做預覽
        const effective = config ? fromClientConfig(config, getConfig()) : getConfig()
        const headers = {}
        if (kind === 'subagent' || kind === 'nested') headers['x-claude-code-agent-id'] = agentId.trim() || 'preview-agent'
        if (kind === 'nested') headers['x-claude-code-parent-agent-id'] = 'preview-parent'
        const ctx = describeRequest(headers, { model })
        const decision = resolveRoute(effective, ctx)
        send(res, 200, {
          kind: ctx.kind,
          requestedModel: model,
          agentId: ctx.agentId,
          target: decision.kind === 'provider' ? decision.provider.label : 'passthrough（訂閱）',
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
      send(res, 500, { error: String(err.message ?? err) })
    }
  })
}
