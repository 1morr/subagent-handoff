/**
 * 路由決策。純函數，不碰 I/O，方便測試與在 GUI 上做規則預覽。
 *
 * 分流訊號來自 Claude Code 的 gateway protocol：x-claude-code-agent-id 只出現在 session 內部
 * spawn 的子 agent 請求上（巢狀的也有），主對話沒有，所以有沒有它就足以把兩者分開。
 */

/**
 * 規則的 `providerId` 填這個保留值＝明確導向 passthrough（訂閱）。
 * 有了它，第三方配額快用完時只要把規則的導向切回來就好，不用刪規則、也不用改 provider 設定。
 */
export const PASSTHROUGH_ID = 'passthrough'

/**
 * 流量記錄與規則預覽裡，走 passthrough 時 `target` 欄位的值。存英文穩定字串，不存某一種
 * 語言的顯示文字。GUI 不比對它：`providerId` 有值是 provider 線，沒有值但 `target` 有值
 * 是訂閱線，兩者都沒有就是沒送出去。
 */
export const PASSTHROUGH_LABEL = 'passthrough (subscription)'

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function globMatch(glob, value) {
  const pattern = (glob ?? '*').trim()
  if (!pattern || pattern === '*') return true
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i')
  return re.test(value ?? '')
}

/**
 * Claude Code 把 cwd 寫在 system prompt 最後一塊的 Environment 區段，header 裡沒有這項。
 * 這裡只挖出那一行路徑當中繼資料，system prompt 的其他內容一律不留。
 */
const CWD_RE = /^[ \t]*-?[ \t]*Primary working directory:[ \t]*(.+?)[ \t]*$/m

export function extractCwd(body) {
  const system = body?.system
  if (typeof system === 'string') return CWD_RE.exec(system)?.[1] ?? null
  if (!Array.isArray(system)) return null
  // Environment 區段在最後一塊，從後往前找比較快
  for (let i = system.length - 1; i >= 0; i--) {
    const text = system[i]?.text
    if (typeof text !== 'string') continue
    const hit = CWD_RE.exec(text)
    if (hit) return hit[1]
  }
  return null
}

/**
 * 請求的「形狀」：只有數量與有無，不含任何內容。
 * 用途是在流量記錄裡認出背景請求 —— Claude Code 的壓縮、預熱那幾種請求沒有 Environment 區段，
 * 光看 cwd 是空的分不出來，但看得出 messages 幾則、有沒有 system、是不是串流。
 */
export function describeShape(body) {
  return {
    messages: Array.isArray(body?.messages) ? body.messages.length : null,
    system: body?.system != null,
    stream: body?.stream === true,
    maxTokens: Number.isFinite(body?.max_tokens) ? body.max_tokens : null,
  }
}

/** 從請求 header 與 body 抽出路由需要的資訊。 */
export function describeRequest(headers, body) {
  const agentId = headers['x-claude-code-agent-id'] || null
  return {
    agentId,
    sessionId: headers['x-claude-code-session-id'] || null,
    cwd: extractCwd(body),
    model: typeof body?.model === 'string' ? body.model : null,
    /** `/effort` 與 `--effort` 走 output_config.effort；thinking 只帶 type，不帶檔位。 */
    effort: typeof body?.output_config?.effort === 'string' ? body.output_config.effort : null,
    thinking: typeof body?.thinking?.type === 'string' ? body.thinking.type : null,
    kind: agentId ? 'subagent' : 'main',
    shape: describeShape(body),
  }
}

/**
 * 由上而下取第一條命中的規則；都沒命中就走 passthrough（= 訂閱）。
 * 指向不存在 provider 的規則會被跳過，而不是讓請求整個失敗。
 *
 * 命中 passthrough 規則與完全沒命中的差別只在 `rule`：前者可以帶 modelOverride 改寫模型，
 * 後者是純粹的原樣轉發。
 */
export function resolveRoute(config, ctx) {
  for (const rule of config.rules) {
    if (!rule.enabled) continue
    if (rule.match !== ctx.kind) continue
    if (!globMatch(rule.modelGlob, ctx.model)) continue
    if (rule.providerId === PASSTHROUGH_ID) return { kind: 'passthrough', rule }
    const provider = config.providers.find((p) => p.id === rule.providerId)
    if (!provider) continue
    if (!provider.baseUrl) continue
    return { kind: 'provider', provider, rule }
  }
  return { kind: 'passthrough', rule: null }
}

/**
 * 實際要送出的 model 名：規則的 modelOverride 優先，其次是 provider 自己的預設，
 * 兩者都空就原樣沿用 Claude Code 要的那個。
 *
 * 指向 passthrough 的規則一樣吃 modelOverride —— Workflow 的 `agent()` 只認
 * `sonnet | opus | haiku | fable` 四個 alias，且未指定時一律沿用主對話的模型，
 * 主對話開 fable 時整批 workflow 也會是 fable。在這裡改寫是唯一能拆開兩者的地方。
 */
export function resolveModel(route, requestedModel) {
  return route.rule?.modelOverride || route.provider?.model || requestedModel || null
}
