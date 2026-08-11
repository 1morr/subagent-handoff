import http from 'node:http'
import { once } from 'node:events'
import { describeRequest, resolveRoute } from './routing.mjs'

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

/** 把 Anthropic 格式的 body 調整成第三方相容層吃得下的樣子。 */
export function rewriteBodyForProvider(payload, provider) {
  const body = { ...payload }
  const changes = []

  if (provider.model && body.model !== provider.model) {
    changes.push(`model ${body.model} → ${provider.model}`)
    body.model = provider.model
  }
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
    // 只有 messages 類請求值得改寫；其餘（/v1/models 等）一律原樣過去
    const routable = req.url.startsWith('/v1/messages') && payload !== null
    const route = routable ? resolveRoute(config, ctx) : { kind: 'passthrough' }

    let target
    let headers
    let outBody = raw
    let changes = []
    // 實際送出去的 effort。被 dropFields 拿掉時會是 null，跟 ctx.effort 一比就知道降級了
    let sentEffort = ctx.effort

    if (route.kind === 'provider') {
      const rewritten = rewriteBodyForProvider(payload, route.provider)
      changes = rewritten.changes
      sentEffort = rewritten.body?.output_config?.effort ?? null
      outBody = Buffer.from(JSON.stringify(rewritten.body))
      headers = buildProviderHeaders(req.headers, route.provider)
      target = route.provider.baseUrl + req.url
    } else {
      headers = buildPassthroughHeaders(req.headers)
      target = config.passthrough.baseUrl + req.url
    }

    const entry = log.start({
      method: req.method,
      path: req.url.split('?')[0],
      kind: ctx.kind,
      agentId: ctx.agentId,
      requestedModel: ctx.model,
      target: route.kind === 'provider' ? route.provider.label : 'passthrough (訂閱)',
      sentModel: route.kind === 'provider' ? route.provider.model || ctx.model : ctx.model,
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
