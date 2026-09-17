// 抓 Claude Code 實際送出的請求形狀：把 ANTHROPIC_BASE_URL 指向本機一個照劇本回 SSE 的假上游，
// 驅動真的 claude 依序走過 Read 讀圖片、Read 讀 PDF（整份與指定頁數）、WebSearch、sonnet 子 agent、帶 schema 的 Workflow agent()。
// 假上游不打真的 API，不花訂閱額度。Claude Code 升級後重跑，對照 docs/claude-code-request-shapes.md。
//
//   node scripts/capture-shapes.mjs [image,pdf,websearch,subagent,workflow] [--out <dir>]
//
// requests.jsonl 只記結構，可以直接貼進 docs：文字只記長度，帶身分的 header 與 metadata 只記名字。
// claude-<劇本>.jsonl 是 Claude Code 的 stream-json 原樣輸出（含本機路徑與 session id），只給自己除錯用。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { quadrantPng, textPdf } from '../src/probe.mjs'

const PDF_TEXT = 'CAPTURE-PDF-TEXT'
const RUN_TIMEOUT_MS = 180_000

// ── 結構摘要 ─────────────────────────────────────────────────────────

/** 認不得的欄位只記形狀：字串換成長度，數字與布林照留。新版本多出來的欄位才不會把內容帶出來 */
function outline(value) {
  if (typeof value === 'string') return `str(${value.length})`
  if (Array.isArray(value)) return value.map(outline)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, outline(v)]))
  return value
}

function blockShape(block) {
  if (typeof block === 'string') return outline(block)
  const { type, cache_control, ...rest } = block
  const out = { type }
  if (cache_control) out.cache_control = cache_control
  switch (type) {
    case 'text':
      out.len = rest.text?.length
      // Claude Code 自己把 PDF 抽成文字的話，看得出來
      if (rest.text?.includes(PDF_TEXT)) out.containsPdfText = true
      if (rest.citations) out.citations = outline(rest.citations)
      break
    case 'thinking':
      out.len = rest.thinking?.length
      out.signatureLen = rest.signature?.length
      break
    case 'tool_use':
    case 'server_tool_use':
      out.name = rest.name
      out.inputKeys = Object.keys(rest.input ?? {})
      break
    case 'tool_result':
      if (rest.is_error) out.is_error = true
      out.content = Array.isArray(rest.content) ? rest.content.map(blockShape) : blockShape(rest.content ?? '')
      break
    case 'image':
    case 'document': {
      const { source, ...extra } = rest
      out.source = { type: source?.type, media_type: source?.media_type, dataLen: source?.data?.length }
      Object.assign(out, outline(extra))
      break
    }
    default:
      Object.assign(out, outline(rest))
  }
  return out
}

function toolShape(tool) {
  const { name, type, description, input_schema, ...extra } = tool
  const out = { name }
  if (type) out.type = type
  if (input_schema) out.props = Object.keys(input_schema.properties ?? {})
  // StructuredOutput 的 schema 是劇本自己給的，整份留下來對照
  if (/struct/i.test(name ?? '')) out.input_schema = input_schema
  return { ...out, ...outline(extra) }
}

/** 只帶設定、不帶內容與身分的頂層欄位，原樣留 */
const CONFIG_FIELDS = new Set([
  'model', 'max_tokens', 'stream', 'thinking', 'output_config', 'context_management', 'tool_choice',
  'temperature', 'top_p', 'top_k', 'service_tier',
])

/** 帶憑證或身分的 header 只記名字 */
const IDENTIFYING_HEADER = /^(authorization|x-api-key|cookie)$|-id$/i

export function requestShape(headers, body) {
  const shape = {
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, IDENTIFYING_HEADER.test(k) ? '<redacted>' : v]),
    ),
  }
  if (!body || typeof body !== 'object') return shape

  shape.top = {}
  for (const [key, value] of Object.entries(body)) {
    if (['messages', 'system', 'tools'].includes(key)) continue
    // metadata.user_id 是一段 JSON 字串，裡面是 claude.ai 的 account_uuid 與 device_id：只記有哪些鍵
    if (key === 'metadata' && value && typeof value === 'object') {
      shape.top.metadata = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonStringShape(v)]))
    } else {
      shape.top[key] = CONFIG_FIELDS.has(key) ? value : outline(value)
    }
  }
  if (body.system !== undefined) shape.system = Array.isArray(body.system) ? body.system.map(blockShape) : outline(body.system)
  if (body.tools) shape.tools = body.tools.map(toolShape)
  if (body.messages) {
    shape.messages = body.messages.map((m) => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map(blockShape) : outline(m.content),
    }))
  }
  return shape
}

function jsonStringShape(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object') return { json: outline(parsed) }
    } catch {}
  }
  return outline(value)
}

// ── 劇本 ─────────────────────────────────────────────────────────────

const WORKFLOW_SCRIPT = `export const meta = { name: 'capture-schema', description: 'Capture the request shape of a schema agent' }
const r = await agent('SCENARIO:wf-agent Return a greeting.', {
  label: 'schema-agent',
  model: 'sonnet',
  schema: { type: 'object', required: ['greeting'], properties: { greeting: { type: 'string' } }, additionalProperties: false },
})
return r`

/** 每個劇本是一串步驟；第 i 步 ＝ 歷史裡已經有 i 則帶 tool_use 的 assistant 訊息 */
function scenarios(pngPath, pdfPath) {
  return {
    image: [[{ name: 'Read', input: { file_path: pngPath } }]],
    pdf: [
      [{ name: 'Read', input: { file_path: pdfPath } }],
      [{ name: 'Read', input: { file_path: pdfPath, pages: '1' } }],
    ],
    websearch: [[{ name: 'WebSearch', input: { query: 'latest Node.js release' } }]],
    subagent: [[{
      name: 'Agent',
      input: {
        description: 'capture subagent shape',
        prompt: 'SCENARIO:sub-inner Look at the image and search the web.',
        subagent_type: 'general-purpose',
        model: 'sonnet',
      },
    }]],
    'sub-inner': [
      [{ name: 'Read', input: { file_path: pngPath } }],
      [{ name: 'WebSearch', input: { query: 'latest Node.js release' } }],
    ],
    workflow: [[{ name: 'Workflow', input: { script: WORKFLOW_SCRIPT } }]],
  }
}

function scenarioOf(body) {
  const first = body?.messages?.find((m) => m.role === 'user')
  if (!first) return null
  const texts = typeof first.content === 'string' ? [first.content] : first.content.filter((b) => b.type === 'text').map((b) => b.text)
  for (const text of texts) {
    const hit = /SCENARIO:([\w-]+)/.exec(text)
    if (hit) return hit[1]
  }
  return null
}

const hasToolUse = (m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')

function planResponse(body, script, nextId) {
  const tools = body?.tools ?? []

  // WebSearch 工具另外發的那一筆：帶著 server tool，回一個假的搜尋結果
  const serverSearch = tools.find((t) => typeof t.type === 'string' && t.type.startsWith('web_search'))
  if (serverSearch) {
    const id = nextId('srvtoolu')
    return {
      role: 'websearch-internal',
      stop: 'end_turn',
      blocks: [
        { type: 'server_tool_use', id, name: serverSearch.name, input: { query: 'latest Node.js release' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: id,
          content: [{ type: 'web_search_result', title: 'Node.js release', url: 'https://nodejs.org/en/blog/release/', encrypted_content: 'ZmFrZQ==', page_age: null }],
        },
        { type: 'text', text: 'Node.js 26.9.0 is the latest release.' },
      ],
    }
  }

  const scenario = scenarioOf(body)
  if (scenario === 'wf-agent') {
    const structured = tools.find((t) => /struct/i.test(t.name))
    if (structured && !body.messages.some(hasToolUse)) {
      return { role: scenario, stop: 'tool_use', blocks: [{ type: 'tool_use', id: nextId('toolu'), name: structured.name, input: { greeting: 'hi' } }] }
    }
    return { role: scenario, stop: 'end_turn', blocks: [{ type: 'text', text: structured ? 'done' : '{"greeting":"hi"}' }] }
  }

  const steps = script[scenario]
  if (!steps) return { role: `unscripted:${scenario}`, stop: 'end_turn', blocks: [{ type: 'text', text: 'ok' }] }
  const step = body.messages.filter(hasToolUse).length
  if (step >= steps.length) {
    // Workflow 在背景跑，主迴圈太快收尾會把它一起帶走，所以這一筆故意拖久一點
    return { role: scenario, stop: 'end_turn', delayMs: scenario === 'workflow' ? 40_000 : 0, blocks: [{ type: 'text', text: 'done' }] }
  }
  const toolNames = new Set(tools.map((t) => t.name))
  const missing = steps[step].filter((s) => !toolNames.has(s.name)).map((s) => s.name)
  if (missing.length) {
    return { role: scenario, stop: 'end_turn', missingTools: missing, blocks: [{ type: 'text', text: `missing tools: ${missing.join(',')}` }] }
  }
  return { role: scenario, stop: 'tool_use', blocks: steps[step].map((s) => ({ type: 'tool_use', id: nextId('toolu'), name: s.name, input: s.input })) }
}

function writeSse(res, model, plan) {
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_capture_${Date.now()}` })
  write('message_start', {
    message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
  })
  plan.blocks.forEach((b, index) => {
    if (b.type === 'text') {
      write('content_block_start', { index, content_block: { type: 'text', text: '' } })
      write('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      write('content_block_start', { index, content_block: { ...b, input: {} } })
      write('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
    } else {
      write('content_block_start', { index, content_block: b })
    }
    write('content_block_stop', { index })
  })
  write('message_delta', { delta: { stop_reason: plan.stop, stop_sequence: null }, usage: { output_tokens: 20 } })
  write('message_stop', {})
  res.end()
}

// ── 跑 Claude Code ───────────────────────────────────────────────────

/** 從 Claude Code 裡面跑的時候，這些變數會讓子行程以為自己是巢狀 session，或是被帶去別的 base URL */
const INHERITED_ENV = /^(CLAUDECODE|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|EXECPATH|SESSION_ATTENDED|SUBAGENT_MODEL)|CLAUDE_PID|CLAUDE_EFFORT|ANTHROPIC_.*)$/

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } })
  const runs = (positionals[0] ?? 'image,pdf,websearch,subagent,workflow').split(',')
  const outDir = path.resolve(values.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-shapes-')))
  const workDir = path.join(outDir, 'work')
  fs.mkdirSync(workDir, { recursive: true })

  const pngPath = path.join(workDir, 'quadrants.png')
  const pdfPath = path.join(workDir, 'capture.pdf')
  fs.writeFileSync(pngPath, quadrantPng(['green', 'red', 'yellow', 'blue']))
  fs.writeFileSync(pdfPath, textPdf(PDF_TEXT))
  const script = scenarios(pngPath, pdfPath)

  const logPath = path.join(outDir, 'requests.jsonl')
  fs.writeFileSync(logPath, '')
  const record = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + '\n')

  let seq = 0
  let ids = 0
  let current = null
  const nextId = (prefix) => `${prefix}_${++ids}`
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    let body = null
    try {
      body = raw.length ? JSON.parse(raw.toString('utf8')) : null
    } catch {}
    const entry = { seq: ++seq, run: current, method: req.method, url: req.url, bytes: raw.length }

    if (req.url.startsWith('/v1/messages/count_tokens')) {
      record({ ...entry, shape: requestShape(req.headers, body) })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 1000 }))
      return
    }
    if (!req.url.startsWith('/v1/messages')) {
      record({ ...entry, shape: requestShape(req.headers, null) })
      res.writeHead(req.method === 'HEAD' ? 200 : 404).end()
      return
    }

    const plan = planResponse(body, script, nextId)
    record({
      ...entry,
      plan: { role: plan.role, stop: plan.stop, blocks: plan.blocks.map((b) => b.name ?? b.type), missingTools: plan.missingTools },
      shape: requestShape(req.headers, body),
    })
    if (plan.delayMs) await new Promise((resolve) => setTimeout(resolve, plan.delayMs))
    if (body?.stream) {
      writeSse(res, body.model, plan)
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body?.model, content: plan.blocks,
        stop_reason: plan.stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 },
      }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED_ENV.test(k)))
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`
  const claude = process.env.CLAUDE_BIN ?? 'claude'
  console.log(`輸出：${outDir}`)

  for (const scenario of runs) {
    current = scenario
    const started = Date.now()
    const args = [
      '-p', `SCENARIO:${scenario} Follow the scripted steps.`,
      // 不載入使用者層的設定：那裡的 hooks 會對外回報 session 事件
      '--setting-sources', 'project',
      '--strict-mcp-config',
      '--model', 'opus[1m]',
      '--effort', 'xhigh',
      '--allowedTools', 'Read,WebSearch,Agent,Workflow',
      '--no-session-persistence',
      '--output-format', 'stream-json',
      '--verbose',
    ]
    const code = await new Promise((resolve) => {
      const child = spawn(claude, args, { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.pipe(fs.createWriteStream(path.join(outDir, `claude-${scenario}.jsonl`)))
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS)
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve(`${err.code ?? err.message}（找不到 claude 的話用 CLAUDE_BIN 指定執行檔）`)
      })
      child.on('exit', (exitCode) => {
        clearTimeout(timer)
        if (stderr.trim()) fs.writeFileSync(path.join(outDir, `claude-${scenario}.stderr.txt`), stderr)
        resolve(exitCode)
      })
    })
    const requests = fs.readFileSync(logPath, 'utf8').split('\n').filter((line) => line.includes(`"run":"${scenario}"`)).length
    console.log(`${scenario}: exit ${code}・${requests} 筆請求・${Math.round((Date.now() - started) / 1000)}s`)
  }
  server.close()
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
