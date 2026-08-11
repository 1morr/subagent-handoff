/**
 * 路由決策。純函數，不碰 I/O，方便測試與在 GUI 上做規則預覽。
 *
 * 分流訊號來自 Claude Code 的 gateway protocol：
 *   x-claude-code-agent-id        只出現在 session 內部 spawn 的 subagent 請求上
 *   x-claude-code-parent-agent-id 只出現在巢狀 agent 上
 * 主對話的請求兩者皆無，所以「有沒有 agent-id」就足以把主 session 和子 agent 分開。
 */

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function globMatch(glob, value) {
  const pattern = (glob ?? '*').trim()
  if (!pattern || pattern === '*') return true
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i')
  return re.test(value ?? '')
}

/** 從請求 header 與 body 抽出路由需要的資訊。 */
export function describeRequest(headers, body) {
  const agentId = headers['x-claude-code-agent-id'] || null
  const parentAgentId = headers['x-claude-code-parent-agent-id'] || null
  return {
    agentId,
    parentAgentId,
    sessionId: headers['x-claude-code-session-id'] || null,
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
 */
export function resolveRoute(config, ctx) {
  for (const rule of config.rules) {
    if (!rule.enabled) continue
    if (!kindMatches(rule.match, ctx)) continue
    if (!globMatch(rule.modelGlob, ctx.model)) continue
    const provider = config.providers.find((p) => p.id === rule.providerId)
    if (!provider) continue
    if (!provider.baseUrl) continue
    return { kind: 'provider', provider, rule }
  }
  return { kind: 'passthrough' }
}
