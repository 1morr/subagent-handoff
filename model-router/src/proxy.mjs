import http from 'node:http'
import { once } from 'node:events'
import { describeRequest, resolveModel, resolveRoute } from './routing.mjs'

/** fetch 會自動解壓，所以 content-encoding 一定要拿掉，否則 client 會二次解壓。 */
const HOP_BY_HOP = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
])

/**
 * subagent 的 system prompt 不含 cwd（實測 v2.1.227），但它與主對話共用 session id，
 * 所以讓主對話的請求把 cwd 記下來，子 agent 再回查。只存路徑字串，不碰 prompt。
 */
export class SessionCwd {
  constructor(limit = 200) {
    this.limit = limit
    this.map = new Map()
  }

  remember(sessionId, cwd) {
    if (!sessionId || !cwd) return
    // 重新插入以維持 Map 的插入順序＝LRU，滿了先丟最久沒用到的
    this.map.delete(sessionId)
    this.map.set(sessionId, cwd)
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value)
  }

  lookup(sessionId) {
    if (!sessionId) return null
    const cwd = this.map.get(sessionId)
    if (cwd === undefined) return null
    this.map.delete(sessionId)
    this.map.set(sessionId, cwd)
    return cwd
  }
}

export class TrafficLog {
  constructor(limit = 300) {
    this.limit = limit
    this.entries = []
    this.seq = 0
  }

  start(fields) {
    const entry = { id: ++this.seq, ts: new Date().toISOString(), ...fields }
    this.entries.unshift(entry)
    if (this.entries.length > this.limit) this.entries.length = this.limit
    return entry
  }

  list() {
    return this.entries
  }

  clear() {
    this.entries = []
  }
}

function buildPassthroughHeaders(incoming) {
  const headers = {}
  for (const [k, v] of Object.entries(incoming)) {
    const name = k.toLowerCase()
    if (name === 'host' || HOP_BY_HOP.has(name)) continue
    // 不要求壓縮，避免串流被緩衝
    if (name === 'accept-encoding') continue
    headers[k] = v
  }
  return headers
}

function buildProviderHeaders(incoming, provider) {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': incoming['anthropic-version'] ?? '2023-06-01',
    accept: incoming.accept ?? 'application/json',
  }
  if (provider.apiKey) {
    if (provider.authStyle === 'x-api-key') headers['x-api-key'] = provider.apiKey
    else headers.authorization = `Bearer ${provider.apiKey}`
  }
  if (!provider.dropBeta && incoming['anthropic-beta']) {
    headers['anthropic-beta'] = incoming['anthropic-beta']
  }
  for (const [k, v] of Object.entries(provider.extraHeaders ?? {})) headers[k] = v
  return headers
}

/**
 * 只換 model、其餘一個字不動。走訂閱那條線時就只用得到這一步 ——
 * 換掉整包 body 的風險太高，主對話的 effort、context_management 都靠原樣轉發活著。
 */
export function rewriteModel(payload, model) {
  if (!payload || !model || payload.model === model) return { body: payload, changes: [] }
  return { body: { ...payload, model }, changes: [`model ${payload.model} → ${model}`] }
}

/**
 * 把 Anthropic 格式的 body 調整成第三方相容層吃得下的樣子。
 * @param {string} [model] 規則算出來的最終 model 名；省略時退回 provider 自己的設定
 */
export function rewriteBodyForProvider(payload, provider, model) {
  const renamed = rewriteModel(payload, model || provider.model)
  const body = { ...renamed.body }
  const changes = [...renamed.changes]

  for (const field of provider.dropFields ?? []) {
    if (field in body) {
      delete body[field]
      changes.push(`-${field}`)
    }
  }
  if (provider.maxOutputTokens && Number(body.max_tokens) > provider.maxOutputTokens) {
    changes.push(`max_tokens ${body.max_tokens} → ${provider.maxOutputTokens}`)
    body.max_tokens = provider.maxOutputTokens
  }
  return { body, changes }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/**
 * @param {() => object} getConfig 每次請求都重新取，所以 GUI 改完設定即時生效（改 port 除外）
 */
export function createProxyServer(getConfig, log) {
  const sessionCwd = new SessionCwd()

  return http.createServer(async (req, res) => {
    // Claude Code 的連線預熱探針，回什麼都行
    if (req.method === 'HEAD' && req.url.startsWith('/api/hello')) {
      res.writeHead(200).end()
      return
    }

    const config = getConfig()
    const started = Date.now()
    const raw = await readBody(req).catch(() => Buffer.alloc(0))

    let payload = null
    if (raw.length) {
      try {
        payload = JSON.parse(raw.toString('utf8'))
      } catch {
        payload = null
      }
    }

    const ctx = describeRequest(req.headers, payload)
    sessionCwd.remember(ctx.sessionId, ctx.cwd)
    const cwd = ctx.cwd ?? sessionCwd.lookup(ctx.sessionId)
    // 只有 messages 類請求值得改寫；其餘（/v1/models 等）一律原樣過去
    const routable = req.url.startsWith('/v1/messages') && payload !== null
    const route = routable ? resolveRoute(config, ctx) : { kind: 'passthrough', rule: null }
    const sentModel = routable ? resolveModel(route, ctx.model) : ctx.model

    let target
    let headers
    let outBody = raw
    let changes = []
    // 實際送出去的 effort。被 dropFields 拿掉時會是 null，跟 ctx.effort 一比就知道降級了
    let sentEffort = ctx.effort

    if (route.kind === 'provider') {
      const rewritten = rewriteBodyForProvider(payload, route.provider, sentModel)
      changes = rewritten.changes
      sentEffort = rewritten.body?.output_config?.effort ?? null
      outBody = Buffer.from(JSON.stringify(rewritten.body))
      headers = buildProviderHeaders(req.headers, route.provider)
      target = route.provider.baseUrl + req.url
    } else {
      // 訂閱這條線預設連 JSON 都不重新序列化，只有規則指名要換 model 時才動 body
      const rewritten = rewriteModel(payload, sentModel)
      changes = rewritten.changes
      if (changes.length) outBody = Buffer.from(JSON.stringify(rewritten.body))
      headers = buildPassthroughHeaders(req.headers)
      target = config.passthrough.baseUrl + req.url
    }

    const entry = log.start({
      method: req.method,
      path: req.url.split('?')[0],
      kind: ctx.kind,
      agentId: ctx.agentId,
      cwd,
      requestedModel: ctx.model,
      target: route.kind === 'provider' ? route.provider.label : 'passthrough（訂閱）',
      ruleId: route.rule?.id ?? null,
      sentModel,
      effort: ctx.effort,
      sentEffort,
      thinking: ctx.thinking,
      changes,
      status: null,
      ms: null,
      error: null,
    })

    const ac = new AbortController()
    const abort = () => {
      if (!res.writableEnded) ac.abort()
    }
    req.on('aborted', abort)
    res.on('close', abort)

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : outBody,
        signal: ac.signal,
        redirect: 'manual',
      })

      entry.status = upstream.status

      const outHeaders = {}
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value
      })
      res.writeHead(upstream.status, outHeaders)
      res.flushHeaders()

      // 逐塊寫出，不緩衝：Claude Code 會數 SSE 位元組，靜默 300 秒就中斷串流
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          if (res.destroyed) break
          if (!res.write(chunk)) await once(res, 'drain')
        }
      }
      res.end()
    } catch (err) {
      entry.error = err.name === 'AbortError' ? 'client aborted' : String(err.message ?? err)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: `model-router: ${entry.error}` },
          }),
        )
      } else {
        res.destroy()
      }
    } finally {
      entry.ms = Date.now() - started
    }
  })
}
