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
  /** @param {((entry: object) => void) | null} sink 落檔用；只在請求走完時收到完整的 entry */
  constructor(limit = 300, sink = null) {
    this.limit = limit
    this.sink = sink
    this.entries = []
    this.seq = 0
  }

  start(fields) {
    const entry = { id: ++this.seq, ts: new Date().toISOString(), ...fields }
    this.entries.unshift(entry)
    if (this.entries.length > this.limit) this.entries.length = this.limit
    return entry
  }

  /** entry 是邊跑邊補的，要等到這裡才算完整 —— 落檔只能在這個時間點做。 */
  finish(entry) {
    this.sink?.(entry)
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
    // 丟掉 client 的 accept-encoding：undici 自己會加上 gzip, deflate 並負責解壓，
    // 兩邊都聲明只會讓上游照 client 的偏好壓、undici 卻照自己的解。實測 Node 24 一定會加。
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

/** 錯誤摘要留這麼長就夠認出是哪一種錯，再長只是把流量記錄撐爛。 */
const ERROR_SUMMARY_LIMIT = 400

function truncate(text) {
  return text.length > ERROR_SUMMARY_LIMIT ? `${text.slice(0, ERROR_SUMMARY_LIMIT)}…` : text
}

/**
 * 把上游的錯誤回應濃縮成一行。上游吐的是它自己的錯誤描述，不含我們送過去的 prompt，
 * 所以可以安心記；`error.type` + `error.message` 才是「為什麼失敗」的答案。
 */
export function summarizeUpstreamError(buf) {
  const text = buf.toString('utf8').trim()
  if (!text) return null
  try {
    const err = JSON.parse(text)?.error
    const parts = [err?.type, err?.message].filter((x) => typeof x === 'string' && x)
    if (parts.length) return truncate(parts.join(': '))
  } catch {
    // 不是 JSON（HTML 錯誤頁、純文字）就退回原文
  }
  return truncate(text.replace(/\s+/g, ' '))
}

/** SSE 的 error 事件長這樣：`data: {"type":"error","error":{…}}`。認這個標記就夠，不必解析整個串流。 */
const SSE_ERROR_MARK = '"type":"error"'

/**
 * 上游可以回 200，然後在串流裡夾一個 error 事件（overloaded 常常這樣來）。
 * 只看狀態碼會把這種請求記成成功，於是流量記錄顯示一切正常、Claude Code 卻在重試。
 */
export function findStreamError(chunk) {
  // fetch 吐出來的每一塊是 Uint8Array，它的 indexOf 只找數值、不吃字串（吃字串的是 Buffer）。
  // 這裡包成同一段記憶體的 Buffer 檢視，不複製。
  const window = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  const at = window.indexOf(SSE_ERROR_MARK)
  if (at < 0) return null
  const text = window.toString('utf8')
  const mark = text.indexOf(SSE_ERROR_MARK)
  const start = text.lastIndexOf('{', mark)
  const end = text.indexOf('\n', mark)
  return summarizeUpstreamError(Buffer.from(text.slice(start < 0 ? mark : start, end < 0 ? undefined : end)))
}

/**
 * 值得重送的狀態：上游明講「現在別來」（429 / 503 / 529）或它自己出錯（5xx）。
 * 其餘 4xx 是請求本身的問題，重送幾次都一樣。
 */
export const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529])

export function parseRetryAfter(raw) {
  if (raw == null || raw === '') return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

/**
 * 這次失敗要等多久再重送。上游有講 retry-after 就聽它的，沒講就指數退避加抖動 ——
 * 一個 session 的一批 subagent 常常同時被擋，不抖開就會一起回來再被擋一次。
 *
 * @returns {number|null} null ＝ 這個等待不該由 router 扛，把回應原樣交回去讓 Claude Code 決定
 */
export function retryDelay(retryAfter, attempt, policy) {
  const ceiling = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
  const backoff = Math.round(ceiling * (0.5 + Math.random() / 2))

  const asked = parseRetryAfter(retryAfter)
  if (asked == null) return backoff
  if (asked > policy.maxRetryAfterMs) return null
  // 實測 Anthropic 過載時回的是 retry-after: 0。照著 0 毫秒重送等於沒有退避，
  // 在對方正在過載的時候連送三次只是加重它的負擔，所以至少等一次退避的時間。
  return Math.max(asked, backoff)
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 串流中途斷掉時的收尾。Claude Code 收到被切斷的串流只會說「回應可能不完整」，
 * 收到合法的 error 事件才知道發生了什麼事。
 */
export function sseError(message) {
  const payload = JSON.stringify({
    type: 'error',
    error: { type: 'api_error', message: `model-router: ${message}` },
  })
  return `event: error\ndata: ${payload}\n\n`
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
      // cwd 認不出來時，session id 是唯一還能分辨「這筆是誰送的」的線索
      sessionId: ctx.sessionId,
      cwd,
      requestedModel: ctx.model,
      target: route.kind === 'provider' ? route.provider.label : 'passthrough（訂閱）',
      ruleId: route.rule?.id ?? null,
      sentModel,
      effort: ctx.effort,
      sentEffort,
      thinking: ctx.thinking,
      changes,
      shape: ctx.shape,
      status: null,
      ms: null,
      error: null,
      // 上游的節流訊號。Claude Code 照 retry-after 決定隔多久重試，對得上畫面上那句「will retry in …」
      retryAfter: null,
      requestId: null,
      detail: null,
      /** 總共送出去幾次（1 ＝ 一次就成，沒有重送過）。 */
      attempts: 0,
      retries: [],
    })

    const ac = new AbortController()
    const abort = () => {
      if (!res.writableEnded) ac.abort()
    }
    req.on('aborted', abort)
    res.on('close', abort)

    const policy = config.retry
    // 上游是不是串流：串流斷掉時的收尾方式跟一般回應不一樣
    let sse = false

    try {
      const init = {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : outBody,
        signal: ac.signal,
        redirect: 'manual',
      }

      /**
       * 重送只可能發生在這個迴圈裡：請求 body 完整留在 outBody，而且一個 byte 都還沒寫給 client，
       * 所以重送是安全的。出了迴圈就開始寫回應，寫下去就不能重來了。
       */
      let upstream = null
      for (let attempt = 1; ; attempt++) {
        entry.attempts = attempt
        let failure = null
        let retryAfter = null

        try {
          upstream = await fetch(target, init)
          if (!RETRYABLE_STATUS.has(upstream.status)) break
          failure = String(upstream.status)
          retryAfter = upstream.headers.get('retry-after')
        } catch (err) {
          if (err.name === 'AbortError') throw err
          upstream = null
          failure = String(err.message ?? err)
        }

        const wait = attempt > policy.attempts ? null : retryDelay(retryAfter, attempt, policy)
        if (wait == null) {
          // 不再重送：拿得到回應就原樣交回去，連回應都沒有就只能讓外層合成 502
          if (!upstream) throw new Error(failure)
          break
        }

        // 失敗回應的 body 一定要排掉，否則這條連線不會被回收
        await upstream?.body?.cancel().catch(() => {})
        entry.retries.push(failure)
        await sleep(wait, ac.signal)
      }

      entry.status = upstream.status
      entry.retryAfter = upstream.headers.get('retry-after')
      entry.requestId = upstream.headers.get('request-id') ?? upstream.headers.get('x-request-id')

      const outHeaders = {}
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value
      })
      sse = (upstream.headers.get('content-type') ?? '').includes('event-stream')
      res.writeHead(upstream.status, outHeaders)
      res.flushHeaders()

      // 錯誤回應不是串流，而且一定很小。整包收下來才記得住「為什麼失敗」，再原樣轉出去
      if (upstream.status >= 400) {
        const failure = Buffer.from(await upstream.arrayBuffer())
        entry.detail = summarizeUpstreamError(failure)
        res.end(failure)
        return
      }

      // 逐塊寫出，不緩衝：Claude Code 會數 SSE 位元組，靜默 300 秒就中斷串流
      // 標記有可能被切在兩塊之間，所以每塊都帶上一塊的尾巴一起看
      let carry = Buffer.alloc(0)
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          if (sse && entry.detail === null) {
            const window = carry.length ? Buffer.concat([carry, chunk]) : chunk
            entry.detail = findStreamError(window)
            carry = window.subarray(Math.max(0, window.length - SSE_ERROR_MARK.length))
          }
          if (res.destroyed) break
          // 一定要帶 signal：client 中途離開時 res 不見得會發 error，
          // 沒有 signal 的話這個 await 永遠等不到 drain，上游那條串流就跟著卡著不放
          if (!res.write(chunk)) await once(res, 'drain', { signal: ac.signal })
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
      } else if (sse && !res.writableEnded) {
        res.write(sseError(entry.error))
        res.end()
      } else {
        res.destroy()
      }
    } finally {
      entry.ms = Date.now() - started
      log.finish(entry)
    }
  })
}
