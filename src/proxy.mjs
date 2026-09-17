import http from 'node:http'
import { once } from 'node:events'
import { describeRequest, resolveModel, resolveRoute, PASSTHROUGH_LABEL } from './routing.mjs'
import { isLocalRequest, rejectForeignOrigin } from './guard.mjs'

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
  // gateway protocol 要求原樣轉發，body 裡對應的欄位（context_management、effort⋯⋯）才有成對的 header。
  // 實測 DeepSeek 收下 Claude Code 完整的 beta 清單照常回 200，快取命中跟不帶時一樣（2026-09）
  if (incoming['anthropic-beta']) headers['anthropic-beta'] = incoming['anthropic-beta']
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
 * provider 線的 body：換 model、拿掉 metadata，其餘一個字不動。
 * @param {string} [model] resolveModel 算出來的最終 model 名
 */
export function rewriteBodyForProvider(payload, model) {
  const renamed = rewriteModel(payload, model)
  if (renamed.body?.metadata === undefined) return renamed
  // Claude Code 把 claude.ai 的 account_uuid 與 device_id 塞在 metadata.user_id（實測 v2.1.274）。
  // 那是訂閱帳號的識別資訊，不該跟著子 agent 的請求出門。DeepSeek 會拿 user_id 做 KV cache 與排程隔離，
  // 但那是給「一把 key 服務很多終端使用者」的情境；這裡只有一個人，拿掉只是所有請求落在同一個分區。
  const body = { ...renamed.body }
  delete body.metadata
  return { body, changes: [...renamed.changes, '-metadata'] }
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

/**
 * Claude Code 撞到 context 上限時會自己壓縮再送，但它靠比對錯誤文字來認（`prompt is too long`）。
 * DeepSeek 回的是 OpenAI 的措辭，外面也沒包 Anthropic 的 `type: "error"`（實測 2026-09）；原樣轉回去，
 * 子 agent 就以 API error 結束，做到一半的東西全丟。實測 1M 的子 agent 不會主動壓縮，全靠這一條認出來。
 */
const OPENAI_CONTEXT_OVERFLOW = /maximum context length is (\d+) tokens\. However, you requested (\d+) tokens/

/**
 * 數字照搬：實測帶數字時，Claude Code 的摘要請求會先截掉較舊的對話；不帶的話，摘要請求比超限的那筆還大。
 * DeepSeek 的 requested 含 max_tokens，比 prompt 本身大，截得保守一點不礙事。
 */
export function translateContextOverflow(buf) {
  const hit = OPENAI_CONTEXT_OVERFLOW.exec(buf.toString('utf8'))
  if (!hit) return null
  const [, limit, requested] = hit
  return Buffer.from(JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: `prompt is too long: ${requested} tokens > ${limit} maximum` },
  }))
}

/** SSE 的 error 事件長這樣：`data: {"type":"error","error":{…}}`。認這個標記就夠，不必解析整個串流。 */
const SSE_ERROR_MARK = '"type":"error"'

/**
 * 掃描時每塊要帶上一塊多長的尾巴。只留標記長度是不夠的：標記跨塊時，
 * 它所屬事件的開頭大括號會落在更前面，找不到就只能寫出一段截斷的亂碼。
 */
const CARRY_BYTES = 1024

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

const USAGE_FIELDS = [
  ['input_tokens', 'input'],
  ['cache_read_input_tokens', 'cacheRead'],
  ['cache_creation_input_tokens', 'cacheWrite'],
  ['output_tokens', 'output'],
]

/**
 * 邊轉發邊從 SSE 串流讀出 token 用量，拿來算快取命中率。
 *
 * 只解析 message_start 與 message_delta 兩種事件、只留四個數字；文字與思考內容所在的事件連 JSON 都不解。
 * 語意照 Anthropic：input_tokens 是沒命中快取的部分，cache_read / cache_creation 另計，三者加總才是整個 prompt。
 * message_delta 帶的是累計值，所以後到的蓋過先到的（DeepSeek 在 message_delta 裡把四個數字重送一次，同一套語意）。
 */
export function createUsageTap() {
  const decoder = new TextDecoder()
  let pending = ''
  let usage = null

  const take = (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith('data:')) return
    if (!line.includes('"message_start"') && !line.includes('"message_delta"')) return
    let event
    try {
      event = JSON.parse(line.slice(5))
    } catch {
      return
    }
    const raw = event.type === 'message_start' ? event.message?.usage : event.type === 'message_delta' ? event.usage : null
    if (!raw) return
    usage ??= {}
    for (const [key, field] of USAGE_FIELDS) if (Number.isFinite(raw[key])) usage[field] = raw[key]
  }

  return {
    /** 每一塊上游資料都餵進來；切在行中間、甚至切在多位元組字元中間都沒關係 */
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true })
      let at
      while ((at = pending.indexOf('\n')) >= 0) {
        take(pending.slice(0, at))
        pending = pending.slice(at + 1)
      }
    },
    /** @returns {{input:number, cacheRead:number, cacheWrite:number, output:number} | null} 上游沒回報用量就是 null */
    result() {
      pending += decoder.decode()
      if (pending) take(pending)
      pending = ''
      if (!Number.isFinite(usage?.input)) return null
      return { input: usage.input, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, output: usage.output ?? 0 }
    },
  }
}

/**
 * 上游的限流狀態。
 *
 * 訂閱線的 429 實測不帶 retry-after，所以只記那一個 header 等於流量記錄答不出
 * 「什麼時候會恢復」。Anthropic 把額度與重置時間放在 anthropic-ratelimit-* 這組上，
 * 這裡照前綴整組收下來 —— 不寫死名字，因為這組 header 會隨 API 版本增減，寫死就會
 * 在下一次改名時靜靜漏掉。
 */
export function collectRateLimit(headers) {
  const prefix = 'anthropic-ratelimit-'
  const out = {}
  headers.forEach((value, key) => {
    const name = key.toLowerCase()
    if (name.startsWith(prefix)) out[name.slice(prefix.length)] = value
  })
  return Object.keys(out).length ? out : null
}

/** 沒有規則命中、或規則指向 passthrough 時的去向。憑證原樣轉發，這條線就是訂閱。 */
export const PASSTHROUGH_BASE_URL = 'https://api.anthropic.com'

/**
 * 單一請求 body 的上限。router 要讀完整包才能判斷路由與改寫，沒有上限的話
 * 一個壞掉的 client 就能把記憶體吃光。1M context 的請求實測十幾 MB，這是防呆不是限流。
 */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // 超過就當場停手，不要先收完再抱怨 —— 那樣記憶體已經被吃掉了
    if (size > limit) throw Object.assign(new Error(`request body exceeds the ${limit} byte limit`), { code: 'BODY_TOO_LARGE' })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * 流量記錄的欄位表只該有一份。兩條路徑各寫一次，遲早會有一邊漏掉新加的欄位。
 */
function baseEntry(req, ctx, over) {
  return {
    method: req.method,
    path: req.url.split('?')[0],
    kind: ctx.kind,
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    cwd: null,
    requestedModel: ctx.model,
    // null ＝ 沒送出去（body 讀不完或超過上限）
    target: null,
    providerId: null,
    ruleId: null,
    sentModel: null,
    effort: ctx.effort,
    thinking: ctx.thinking,
    changes: [],
    shape: ctx.shape,
    status: null,
    ms: null,
    error: null,
    retryAfter: null,
    rateLimit: null,
    requestId: null,
    // token 用量，只有串流回應才有；非串流的回應 router 不緩衝，讀不到
    usage: null,
    detail: null,
    ...over,
  }
}

/**
 * @param {() => object} getConfig 每次請求都重新取，所以 GUI 改完設定即時生效（改 port 除外）
 * @param {import('./proxy.mjs').TrafficLog} log
 * @param {object} [options]
 * @param {() => { boundProxyPort: number }} [options.getRuntime] 回報**實際綁定**的埠；
 *   不給的話退回讀 `config.proxyPort`，但那在使用者改埠又還沒重啟時會跟真正綁定的埠不一致。
 * @param {string} [options.passthroughBaseUrl] 測試用：把訂閱線指到假上游
 * @param {number} [options.maxRequestBytes] 測試用：不必真的送 64MB 才看得到 413
 */
export function createProxyServer(getConfig, log, options = {}) {
  const {
    getRuntime = () => ({ boundProxyPort: getConfig().proxyPort }),
    passthroughBaseUrl = PASSTHROUGH_BASE_URL,
    maxRequestBytes = MAX_REQUEST_BYTES,
  } = options
  const sessionCwd = new SessionCwd()

  return http.createServer(async (req, res) => {
    try {
      const config = getConfig()

      // 這條線握有第三方的 API key。DNS rebinding 之後網頁就能自己補上 agent-id header
      // 命中分流規則，拿你的額度去跑推論，所以來源檢查要在做任何事之前。
      // 用的是實際綁定的埠，不是 config.proxyPort —— 使用者在 GUI 改埠但還沒重啟時，
      // 兩者會不一樣，這裡要信的是真正在監聽的那個。
      if (!isLocalRequest(req, getRuntime().boundProxyPort)) {
        rejectForeignOrigin(res)
        return
      }

      // Claude Code 的連線預熱探針，回什麼都行
      if (req.method === 'HEAD' && req.url.startsWith('/api/hello')) {
        res.writeHead(200).end()
        return
      }

      const started = Date.now()

      let raw = Buffer.alloc(0)
      let tooLarge = null
      try {
        raw = await readBody(req, maxRequestBytes)
      } catch (err) {
        if (err.code !== 'BODY_TOO_LARGE') {
          // client 在送 body 的途中就走了。拿一個空 body 往上游打一次註定 400 的請求
          // 只是白費一次來回 —— 已經沒有人在等這個回應了
          const ctx = describeRequest(req.headers, null)
          log.finish(log.start(baseEntry(req, ctx, {
            cwd: sessionCwd.lookup(ctx.sessionId),
            ms: Date.now() - started,
            error: `failed to read request body: ${err.message}`,
          })))
          res.destroy()
          return
        }
        tooLarge = err.message
      }

      if (tooLarge) {
        const ctx = describeRequest(req.headers, null)
        log.finish(log.start(baseEntry(req, ctx, {
          cwd: sessionCwd.lookup(ctx.sessionId),
          status: 413,
          ms: Date.now() - started,
          error: tooLarge,
        })))
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: `subagent-handoff: ${tooLarge}` },
          }),
          // 剩下的 body 還在路上，回應 flush 完才切線 —— 早切會連 413 都送不到
          () => req.destroy(),
        )
        return
      }

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

      if (route.kind === 'provider') {
        const rewritten = rewriteBodyForProvider(payload, sentModel)
        changes = rewritten.changes
        outBody = Buffer.from(JSON.stringify(rewritten.body))
        headers = buildProviderHeaders(req.headers, route.provider)
        target = route.provider.baseUrl + req.url
      } else {
        // 訂閱這條線預設連 JSON 都不重新序列化，只有規則指名要換 model 時才動 body
        const rewritten = rewriteModel(payload, sentModel)
        changes = rewritten.changes
        if (changes.length) outBody = Buffer.from(JSON.stringify(rewritten.body))
        headers = buildPassthroughHeaders(req.headers)
        target = passthroughBaseUrl + req.url
      }

      // sessionId：cwd 認不出來時，它是唯一還能分辨「這筆是誰送的」的線索
      const entry = log.start(baseEntry(req, ctx, {
        cwd,
        target: route.kind === 'provider' ? route.provider.label : PASSTHROUGH_LABEL,
        // label 會被使用者改名，分類要看 id。null = 走訂閱那條線
        providerId: route.kind === 'provider' ? route.provider.id : null,
        ruleId: route.rule?.id ?? null,
        sentModel,
        changes,
      }))

      const ac = new AbortController()
      // client 斷線時 res 會 close 而此時還沒 end，這是唯一需要的訊號。
      // req 的 'aborted' 在 Node 20+ 已 deprecated，而且講的是同一件事。
      res.on('close', () => {
        if (!res.writableEnded) ac.abort()
      })

      let sse = false
      let usageTap = null

      try {
        // 不自己重送：Claude Code 對 408 / 409 / 5xx / 529 / 連線錯誤本來就會退避重試最多 10 次，
        // 這裡再扛一層只會把打上游的次數乘上去（實測紀錄見 docs/measurements.md）
        const upstream = await fetch(target, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : outBody,
          signal: ac.signal,
          redirect: 'manual',
        })

        entry.status = upstream.status
        entry.retryAfter = upstream.headers.get('retry-after')
        entry.rateLimit = collectRateLimit(upstream.headers)
        entry.requestId = upstream.headers.get('request-id') ?? upstream.headers.get('x-request-id')

        const outHeaders = {}
        upstream.headers.forEach((value, key) => {
          if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value
        })
        sse = (upstream.headers.get('content-type') ?? '').includes('event-stream')

        // 錯誤回應不是串流，而且一定很小。整包收下來才記得住「為什麼失敗」，再轉出去
        if (upstream.status >= 400) {
          let failure = Buffer.from(await upstream.arrayBuffer())
          entry.detail = summarizeUpstreamError(failure)
          // 訂閱線本來就是 Anthropic 的措辭，一個字都不動
          const overflow = route.kind === 'provider' ? translateContextOverflow(failure) : null
          if (overflow) {
            failure = overflow
            outHeaders['content-type'] = 'application/json'
            entry.detail += ' (rewritten to "prompt is too long" so Claude Code compacts)'
          }
          res.writeHead(upstream.status, outHeaders)
          res.end(failure)
          return
        }

        res.writeHead(upstream.status, outHeaders)
        res.flushHeaders()

        // 逐塊寫出，不緩衝：Claude Code 會數 SSE 位元組，靜默 300 秒就中斷串流
        // 標記有可能被切在兩塊之間，所以每塊都帶上一塊的尾巴一起看
        let carry = Buffer.alloc(0)
        // 兩條線都讀：訂閱線的快取命中一樣值得看，而且只讀不改，原始 bytes 照樣原封轉發
        if (sse) usageTap = createUsageTap()
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            usageTap?.push(chunk)
            if (sse && entry.detail === null) {
              const window = carry.length ? Buffer.concat([carry, chunk]) : chunk
              entry.detail = findStreamError(window)
              // 留夠長的尾巴，讓跨塊的標記還找得到它所屬事件的開頭大括號。
              // 複製一份小的，不要 subarray 整塊上游 chunk —— 那會讓幾 MB 的
              // 底層記憶體只因為留著 ~1KB 尾巴就一路活到下一個標記出現。
              carry = Buffer.from(window.subarray(Math.max(0, window.length - CARRY_BYTES)))
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
              error: { type: 'api_error', message: `subagent-handoff: ${entry.error}` },
            }),
          )
        } else {
          // 串流開始後斷掉就照樣斷線，不補合成的 error 事件：實測 Claude Code 把斷線當連線錯誤、
          // 重送串流；收到 api_error 事件卻會改發非串流請求，長輸出要等整包生成完才有回應。
          res.destroy()
        }
      } finally {
        // 串流中途斷掉也留下已經讀到的部分：message_start 通常早就到了
        if (usageTap) entry.usage = usageTap.result()
        entry.ms = Date.now() - started
        log.finish(entry)
      }
    } catch (err) {
      // 保底：這條線服務機器上**所有**的 Claude Code session，上面任何一段沒接住的例外
      // 都會變成 unhandled rejection，Node 20+ 預設會直接砍掉整個process —— 一次意外
      // 就切斷所有還在跑的 session。這裡接住，記一筆錯誤，讓 process 活著。
      console.error(`✗ unexpected proxy error: ${err?.stack ?? err}`)
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: 'subagent-handoff: unexpected internal error, check the server log' },
            }),
          )
        } else if (!res.writableEnded) {
          res.destroy()
        }
      } catch {
        res.destroy()
      }
    }
  })
}
