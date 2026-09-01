import http from 'node:http'
import { createProxyServer, TrafficLog } from '../src/proxy.mjs'
import { createAdminServer } from '../src/admin.mjs'
import { normalizeConfig, defaultProvider, defaultRule } from '../src/config.mjs'
import { createFakeUpstream } from './fixtures/fake-upstream.mjs'

/** 起一個 server，回傳它的 URL。埠固定用 0（隨機可用埠），測試之間不會互撞。 */
export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
}

/**
 * 起一組完整的測試環境：假上游 + proxy + admin，設定檔只在記憶體裡（絕不寫到真的
 * config.json）。三個 provider（bearer / x-api-key / 全欄位剝除）對應大部分測試需要
 * 的組合；個別測試檔可以再用 `harness.setConfig(...)` 換整份設定。
 *
 * `getRuntime` 回報固定的 boundProxyPort/boundAdminPort（8787/8788，跟 defaultConfig
 * 的預設埠一致），不是隨機分配到的實際埠 —— guard 測試比的是「送出去的 Origin 埠」
 * 跟「getRuntime 回報的埠」對不對得上，兩者本來就跟 listen() 拿到的隨機埠無關。
 *
 * @param {object} [overrides] 覆寫預設 config 的任何欄位（見 normalizeConfig）
 */
export async function createHarness(overrides = {}) {
  const upstream = createFakeUpstream()
  const upstreamUrl = await listen(upstream.server)

  let config = normalizeConfig({
    passthrough: { baseUrl: upstreamUrl },
    providers: [
      defaultProvider({ id: 'kimi', label: 'Kimi', baseUrl: upstreamUrl, apiKey: 'sk-moonshot', model: 'kimi-k3' }),
      defaultProvider({
        id: 'other', label: 'Other', baseUrl: upstreamUrl, apiKey: 'sk-other', model: 'glm-5',
        authStyle: 'x-api-key', dropBeta: false,
      }),
      defaultProvider({
        id: 'strict', label: 'Strict', baseUrl: upstreamUrl, apiKey: 'sk-strict', model: 'picky-1',
        dropFields: ['thinking', 'context_management', 'output_config'],
      }),
    ],
    rules: [defaultRule({ id: 'r1', match: 'subagent', providerId: 'kimi' })],
    // 測試不需要真的等退避，只驗證重送的次數與時機
    retry: { attempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
    ...overrides,
  })

  const finished = []
  const logStore = new TrafficLog(300, (entry) => finished.push(entry))
  const getRuntime = () => ({ boundProxyPort: 8787, boundAdminPort: 8788, restartRequired: false })

  const proxy = createProxyServer(() => config, logStore, { getRuntime })
  const proxyUrl = await listen(proxy)

  const admin = createAdminServer({
    getConfig: () => config,
    setConfig: async (next) => {
      config = next
      return config
    },
    log: logStore,
    getRuntime,
  })
  const adminUrl = await listen(admin)

  return {
    upstream, upstreamUrl, proxy, proxyUrl, admin, adminUrl, logStore, finished,
    getConfig: () => config,
    setConfig: (next) => { config = next },
    async close() {
      proxy.close()
      admin.close()
      upstream.server.close()
    },
  }
}

/** 打 proxy 的 `/v1/messages`；每次呼叫前清空假上游的 `received`，用來斷言「這一筆收到什麼」。 */
export function makePost(proxyUrl, upstream) {
  return async function post(headers, body, query = 'beta=true') {
    upstream.state.received = []
    const res = await fetch(`${proxyUrl}/v1/messages?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
      body: JSON.stringify(body),
    })
    return res
  }
}

/** 打 admin 的 JSON API，回傳 `{ status, json }`。 */
export function makeAdminApi(adminUrl) {
  return async function adminApi(method, path, body) {
    const res = await fetch(adminUrl + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, json: await res.json() }
  }
}

/**
 * 用原生 http.request 而不是 fetch：guard 測試的重點就是自訂 Host 與 Origin，
 * 而 fetch 對這兩個 header 有自己的想法，送不送得出去不由測試決定。
 */
export function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

export const BASE_BODY = {
  model: 'claude-opus-5',
  max_tokens: 4096,
  messages: [{ role: 'user', content: 'hi' }],
  thinking: { type: 'adaptive' },
  context_management: { edits: [] },
  output_config: { effort: 'high' },
}

export const SUBSCRIPTION_HEADERS = {
  authorization: 'Bearer sk-ant-oat-fake',
  'anthropic-beta': 'oauth-2025-04-20,context-management-2025-06-27',
  'x-claude-code-session-id': 'sess-1',
}
