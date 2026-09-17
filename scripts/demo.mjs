#!/usr/bin/env node
/**
 * `npm run demo` —— 讓四個吃流量／設定才有東西可看的分頁（機架、流量、Providers、路由）
 * 在不需要任何真的 API key、不打任何真的網路請求的情況下長出資料，方便截圖或手動核對 GUI。
 *
 * 做的事：
 *   1. 起一個假上游（test/fixtures/fake-upstream.mjs，跟整合測試共用同一份劇本）。
 *   2. 用**目前沒有寫在 README 裡的 `ROUTER_CONFIG` 環境變數**（見 src/config.mjs:9-11）
 *      把一份指向假上游的暫存設定檔餵給 router，不會碰到使用者真正的 config.json。
 *   3. 用 `node src/index.mjs` 真的把 router 啟動起來（跟使用者平常啟動的方式一模一樣）。
 *   4. 依照固定的劇本打進 30 幾筆流量，混合 main / subagent / nested 三種來源、
 *      200 / 429 / 529 / 串流中途 error / client 中途放棄五種結局，並且用不同的
 *      `x-claude-code-session-id` 與 system prompt 的 Environment 區段讓「機架」
 *      分頁的目錄欄有東西可看。
 *   5. 全部打完之後留著 router 繼續跑，讓人接著開瀏覽器截圖；Ctrl+C 結束。
 *
 * 全程離線、零成本：流量只在 router ↔ 假上游 ↔ 這支腳本之間繞，一個位元組都不會
 * 送到真正的 Anthropic 或第三方 API。劇本是固定的（不擲骰子），同一份程式碼重複跑
 * 應該長出同樣形狀的資料，只有時間戳與絕對耗時會不一樣。
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createFakeUpstream } from '../test/fixtures/fake-upstream.mjs'
import { normalizeConfig, defaultProvider, defaultRule } from '../src/config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 固定路徑而不是每次 mkdtemp 隨機一個：重跑 `npm run demo` 會覆蓋掉上一輪的殘留，
// 不會在 temp 底下越堆越多目錄。
const DEMO_DIR = path.join(tmpdir(), 'subagent-handoff-demo')
const CONFIG_PATH = path.join(DEMO_DIR, 'config.json')

function log(msg) {
  console.log(`[demo] ${msg}`)
}

/** system prompt 最後一塊帶 Environment 區段，格式照 src/routing.mjs 的 CWD_RE 抄。 */
function environmentBlock(cwd) {
  return [
    { type: 'text', text: 'You are Claude Code, Anthropic official CLI for Claude.' },
    {
      type: 'text',
      text: `# Environment\nYou have been invoked in the following environment:\n`
        + ` - Primary working directory: ${cwd}\n - Is a git repository: true\n - Platform: linux\n`,
    },
  ]
}

function baseBody(model, over = {}) {
  return {
    model,
    max_tokens: 512,
    messages: [{ role: 'user', content: 'Summarize the diff and suggest a commit message.' }],
    thinking: { type: 'adaptive', display: 'omitted' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    output_config: { effort: 'medium' },
    ...over,
  }
}

/**
 * 固定的劇本：四個「session」各自代表一個專案，每個 session 先來一筆帶 Environment
 * 區段的 main 請求（建立 cwd），接著是幾筆會透過同一個 session id 繼承 cwd 的
 * subagent／nested 請求，混著不同的結局。刻意不用亂數 —— 同一份程式碼重跑要長出
 * 同樣形狀的資料，才適合拿來反覆核對畫面。
 */
const SESSIONS = [
  { id: 'demo-sess-website', cwd: '/home/dev/projects/website', model: 'claude-opus-5' },
  { id: 'demo-sess-api', cwd: '/home/dev/projects/api-server', model: 'claude-sonnet-5' },
  { id: 'demo-sess-pipeline', cwd: '/srv/data-pipeline', model: 'claude-opus-5' },
  { id: 'demo-sess-refactor', cwd: 'C:\\Users\\dev\\repo-refactor', model: 'claude-sonnet-5' },
]

/** 每個 session 共用的請求序列（不含開場的 main 請求）。 */
const SCRIPT = [
  { kind: 'subagent', agentId: 'Explore-1', outcome: 'ok' },
  { kind: 'subagent', agentId: 'general-purpose-1', outcome: 'ok-stream' },
  { kind: 'nested', agentId: 'teammate-reviewer', parentAgentId: 'Plan-1', outcome: 'ok' },
  { kind: 'subagent', agentId: 'Explore-2', outcome: '429-retry' },
  { kind: 'subagent', agentId: 'general-purpose-2', outcome: '529-retry-success' },
  { kind: 'subagent', agentId: 'general-purpose-3', outcome: '529-exhausted' },
  { kind: 'subagent', agentId: 'Explore-3', outcome: 'midstream-error' },
  { kind: 'main', outcome: '429-sub' },
]

async function waitUntilReady(proxyUrl, timeoutMs = 15_000) {
  const started = Date.now()
  for (;;) {
    try {
      const res = await fetch(`${proxyUrl}/api/hello`, { method: 'HEAD' })
      if (res.status === 200) return
    } catch {
      // 還沒起來，繼續等
    }
    if (Date.now() - started > timeoutMs) throw new Error(`router 在 ${timeoutMs}ms 內沒有起來`)
    await sleep(150)
  }
}

async function fireOne(proxyUrl, upstream, session, step) {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-claude-code-session-id': session.id,
  }
  if (step.kind === 'subagent' || step.kind === 'nested') headers['x-claude-code-agent-id'] = step.agentId
  if (step.kind === 'nested') headers['x-claude-code-parent-agent-id'] = step.parentAgentId
  if (step.kind === 'main') headers.authorization = 'Bearer sk-ant-oat-demo-fake'

  const wantsStream = step.outcome === 'ok-stream' || step.outcome === 'client-abort'
  const body = baseBody(session.model, {
    stream: wantsStream,
    ...(step.withEnvironment ? { system: environmentBlock(session.cwd) } : {}),
  })

  let query = ''
  if (step.outcome === '429-retry') query = '?fail=429'
  if (step.outcome === '429-sub') query = '?fail=ratelimit'
  if (step.outcome === 'midstream-error') query = '?fail=stream'
  if (step.outcome === '529-retry-success') upstream.state.failPlan.push({ status: 529 })
  if (step.outcome === '529-exhausted') upstream.state.failPlan.push({ status: 529 }, { status: 529 }, { status: 529 })

  const label = `${step.kind}/${step.outcome}${step.agentId ? ` (${step.agentId})` : ''}`

  if (step.outcome === 'client-abort') {
    const ac = new AbortController()
    const req = fetch(`${proxyUrl}/v1/messages${query}`, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal })
    // 上游第二塊要等 150ms 才送；30ms 就放棄，確保是「client 中途離開」而不是正常收尾
    setTimeout(() => ac.abort(), 30)
    await req.catch(() => {})
    log(`  ${label} → client aborted (expected)`)
    return
  }

  const res = await fetch(`${proxyUrl}/v1/messages${query}`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (wantsStream) await res.body?.cancel().catch(() => {})
  else await res.text().catch(() => {})
  log(`  ${label} → ${res.status}`)
}

async function main() {
  log('Starting the fake upstream…')
  const upstream = createFakeUpstream()
  await new Promise((resolve) => upstream.server.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstream.server.address().port
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`
  log(`Fake upstream: ${upstreamUrl} — fully offline, not one byte reaches a real API`)

  log(`Temporary config: ${CONFIG_PATH}`)
  await rm(DEMO_DIR, { recursive: true, force: true })
  await mkdir(DEMO_DIR, { recursive: true })
  const config = normalizeConfig({
    passthrough: { baseUrl: upstreamUrl, retry: { retryRateLimit: false } },
    providers: [
      defaultProvider({
        id: 'demo-provider', label: 'Demo Provider (fake)', baseUrl: upstreamUrl,
        apiKey: 'demo-key-not-real', model: 'demo-model-v1',
      }),
    ],
    rules: [defaultRule({ id: 'r-demo', enabled: true, match: 'subagent', providerId: 'demo-provider' })],
    // 真的等退避沒必要，這裡不是在測時序，縮短一點讓腳本跑快一些
    retry: { attempts: 2, baseDelayMs: 80, maxDelayMs: 200 },
    trafficLog: { file: 'traffic.log', maxBytes: 5_000_000 },
  })
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  log('Starting the router (node src/index.mjs)…')
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.mjs')], {
    cwd: ROOT,
    env: { ...process.env, ROUTER_CONFIG: CONFIG_PATH },
    stdio: 'inherit',
  })

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    log('Shutting down…')
    upstream.server.close()
    child.kill('SIGINT')
  }
  process.on('SIGINT', () => { shutdown(); process.exit(0) })
  process.on('SIGTERM', () => { shutdown(); process.exit(0) })

  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[demo] router 提前結束（exit code ${code}），可能是埠被佔用 —— 檢查 8787/8788 有沒有已經在跑的實例`)
      process.exit(code ?? 1)
    }
  })

  const proxyUrl = `http://127.0.0.1:${config.proxyPort}`
  const adminUrl = `http://127.0.0.1:${config.adminPort}`
  await waitUntilReady(proxyUrl)
  log('Router is up; sending synthetic traffic…')

  for (const session of SESSIONS) {
    await fireOne(proxyUrl, upstream, session, { kind: 'main', outcome: 'ok', withEnvironment: true })
    for (const step of SCRIPT) {
      await fireOne(proxyUrl, upstream, session, step)
    }
  }
  // 額外一筆 client 中途放棄的情境，不必每個 session 都重複
  await fireOne(proxyUrl, upstream, SESSIONS[0], { kind: 'subagent', agentId: 'general-purpose-4', outcome: 'client-abort' })

  const total = SESSIONS.length * (1 + SCRIPT.length) + 1
  log(`Done — ${total} synthetic requests sent.`)
  log(`GUI: ${adminUrl}`)
  log(`Proxy: ${proxyUrl} — for display only; do not point Claude Code at it`)
  log('The router keeps running so you can browse the GUI. Ctrl+C to stop.')
}

main().catch((err) => {
  console.error(`[demo] 失敗：${err.stack ?? err}`)
  process.exit(1)
})
