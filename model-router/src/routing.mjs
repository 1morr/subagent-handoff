/**
 * 路由決策。純函數，不碰 I/O，方便測試與在 GUI 上做規則預覽。
 *
 * 分流訊號來自 Claude Code 的 gateway protocol：
 *   x-claude-code-agent-id        只出現在 session 內部 spawn 的 subagent 請求上
 *   x-claude-code-parent-agent-id 只出現在巢狀 agent 上
 * 主對話的請求兩者皆無，所以「有沒有 agent-id」就足以把主 session 和子 agent 分開。
 */

/**
 * 規則的 `providerId` 填這個保留值＝明確導向 passthrough（訂閱）。
 * 有了它，第三方配額快用完時只要把規則的導向切回來就好，不用刪規則、也不用改 provider 設定。
 */
export const PASSTHROUGH_ID = 'passthrough'

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

/** 從請求 header 與 body 抽出路由需要的資訊。 */
export function describeRequest(headers, body) {
  const agentId = headers['x-claude-code-agent-id'] || null
  const parentAgentId = headers['x-claude-code-parent-agent-id'] || null
  return {
    agentId,
    parentAgentId,
    sessionId: headers['x-claude-code-session-id'] || null,
    cwd: extractCwd(body),
    model: typeof body?.model === 'string' ? body.model : null,
    /** `/effort` 與 `--effort` 走 output_config.effort；thinking 只帶 type，不帶檔位。 */
    effort: typeof body?.output_config?.effort === 'string' ? body.output_config.effort : null,
    thinking: typeof body?.thinking?.type === 'string' ? body.thinking.type : null,
    kind: parentAgentId ? 'nested' : agentId ? 'subagent' : 'main',
  }
}

function kindMatches(match, ctx) {
  switch (match) {
    case 'any':
      return true
    case 'main':
      return ctx.kind === 'main'
    case 'subagent':
      // nested 也是 subagent，這裡刻意涵蓋兩者
      return ctx.kind === 'subagent' || ctx.kind === 'nested'
    case 'nested':
      return ctx.kind === 'nested'
    default:
      return false
  }
}

/**
 * 由上而下取第一條命中的規則；都沒命中就走 passthrough（= 訂閱）。
 * 指向不存在 provider 的規則會被跳過，而不是讓請求整個失敗。
 *
 * 命中 passthrough 規則與完全沒命中的去向一樣，差別只在 `rule` —— 流量記錄靠它分辨
 * 「規則真的把我切回訂閱了」與「根本沒命中掉下來的」。
 */
export function resolveRoute(config, ctx) {
  for (const rule of config.rules) {
    if (!rule.enabled) continue
    if (!kindMatches(rule.match, ctx)) continue
    if (!globMatch(rule.modelGlob, ctx.model)) continue
    if (rule.providerId === PASSTHROUGH_ID) return { kind: 'passthrough', rule }
    const provider = config.providers.find((p) => p.id === rule.providerId)
    if (!provider) continue
    if (!provider.baseUrl) continue
    return { kind: 'provider', provider, rule }
  }
  return { kind: 'passthrough', rule: null }
}
