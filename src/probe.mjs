/**
 * Provider 連通性測試。分成兩級，因為「壞掉的樣子」完全不同：
 *
 * 必要 —— 任一不過，Claude Code 在這個 provider 上就跑不起來
 *   1. 基本推論      base URL / key / model 名三者對不對
 *   2. SSE 串流      Claude Code 的推論一律走串流，不能串就完全不能用
 *   3. 工具呼叫      Claude Code 幾乎每個 turn 都在 call tool，不支援等於不能用
 *   4. 串流工具迴圈  串流吐出 tool_use、連同 thinking 把 tool_result 送回去再接著做 —— 子 agent 每一輪的真實形狀
 *
 * 能力 —— 不過也跑得起來、請求照樣 200，只是子 agent 用到那個能力時靜默失效
 *   5. 中途 system   對話中間的 role: "system" 訊息有沒有被模型看見
 *   6. 看圖          工具結果裡的圖片（Read 讀圖片、MCP 截圖都走這條）
 *   7. 讀 PDF        工具結果裡的 document block（Read 讀 PDF）
 *
 * 能力項目的判定一律看「模型答不答得出只有它看得見的東西」，不看狀態碼：
 * 實測 DeepSeek 把 PDF 換成 [Unsupported Document] 之後照樣回 200（請求形狀見 docs/claude-code-request-shapes.md）。
 * `/effort` 檔位與 WebSearch 不測：前者上游不收時是看得見的 400，後者一次就要上萬 input tokens。
 */

import { randomInt } from 'node:crypto'
import zlib from 'node:zlib'
import { buildProviderHeaders, rewriteBodyForProvider } from './proxy.mjs'

const TIMEOUT_MS = 45_000

async function errorDetail(response) {
  const text = await response.text().catch(() => '')
  const trimmed = text.trim().slice(0, 400)
  return trimmed || `HTTP ${response.status} ${response.statusText}`
}

/** header 與 body 用 proxy 轉發子 agent 請求的同一套函式組，測到的就是真的會送出去的樣子。 */
function call(provider, model, payload) {
  return fetch(`${provider.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: buildProviderHeaders({}, provider),
    body: JSON.stringify(rewriteBodyForProvider(payload, model).body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

const textOf = (blocks) =>
  blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()

/** 模型看得見才答得出的碼。只用數字：字母會被模型讀成 O / 0 之類的形近字，那不是這裡要測的。 */
const secretCode = () => String(randomInt(100_000, 1_000_000))

/**
 * 把一條 SSE 串流讀完，照 Claude Code 的方式重組出 content blocks：
 * 文字與思考逐段接起來，tool_use 的 input 由 input_json_delta 拼回 JSON。
 */
async function readStream(response, started) {
  const events = new Set()
  const blocks = []
  const partialJson = new Map()
  const jsonErrors = []
  let stopReason = null
  let error = null
  let firstByteMs = null
  let bytes = 0

  let event = null
  let data = ''
  const dispatch = () => {
    if (event) events.add(event)
    let payload = null
    try {
      payload = data ? JSON.parse(data) : null
    } catch {
      payload = null
    }
    event = null
    data = ''
    if (!payload) return

    const index = payload.index
    switch (payload.type) {
      case 'content_block_start':
        if (typeof index !== 'number') break
        blocks[index] = structuredClone(payload.content_block)
        if (payload.content_block?.type === 'tool_use') {
          partialJson.set(index, '')
        }
        break
      case 'content_block_delta': {
        const block = blocks[index]
        const delta = payload.delta ?? {}
        if (!block) break
        if (delta.type === 'text_delta') block.text = (block.text ?? '') + delta.text
        else if (delta.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking
        else if (delta.type === 'signature_delta') block.signature = delta.signature
        else if (delta.type === 'input_json_delta') partialJson.set(index, (partialJson.get(index) ?? '') + delta.partial_json)
        break
      }
      case 'content_block_stop':
        if (partialJson.has(index) && blocks[index]) {
          const raw = partialJson.get(index)
          try {
            // 沒有任何 delta ＝ 沿用 content_block_start 帶來的 input
            if (raw) blocks[index].input = JSON.parse(raw)
          } catch {
            jsonErrors.push(raw.slice(0, 120))
          }
          partialJson.delete(index)
        }
        break
      case 'message_delta':
        stopReason = payload.delta?.stop_reason ?? stopReason
        break
      case 'error':
        error = payload.error?.message ?? JSON.stringify(payload.error)
        break
    }
  }
  const feed = (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      if (event || data) dispatch()
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      data += (data ? '\n' : '') + line.slice(5).trimStart()
    }
  }

  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    if (firstByteMs === null) firstByteMs = Date.now() - started
    bytes += chunk.length
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) feed(line)
  }
  // 上游最後一行沒有換行收尾時，最後一個事件就卡在 buffer 裡 —— 不沖出來會誤判成串流不完整
  buffer += decoder.decode()
  if (buffer) feed(buffer)
  if (event || data) dispatch()

  return { events, blocks: blocks.filter(Boolean), jsonErrors, stopReason, error, firstByteMs, bytes }
}

/**
 * 能力項目共用的收尾：拿到文字就交給 judge，拿不到就講清楚是「無法判定」還是「上游拒收」。
 * 思考把 max_tokens 吃光時回覆是空的，那不代表上游丟了內容，不能判成那種失敗。
 */
async function judgeReply(response, started, judge) {
  if (!response.ok) return { ok: false, ms: Date.now() - started, error: await errorDetail(response) }
  const json = await response.json()
  const text = textOf(json.content ?? [])
  if (!text) {
    // inconclusive：沒過，但也沒證明 provider 壞了。GUI 印成 N/A 而不是 FAIL
    return {
      ok: false,
      inconclusive: true,
      ms: Date.now() - started,
      error: `no text reply (stop_reason=${json.stop_reason}), cannot judge${json.stop_reason === 'max_tokens' ? ' — thinking used up max_tokens' : ''}`,
    }
  }
  return { ms: Date.now() - started, ...judge(text) }
}

async function testConnectivity(provider, model) {
  const started = Date.now()
  // 不帶 thinking 欄位時，DeepSeek 預設照樣思考：16 tokens 會被思考吃光、回覆是空字串（實測 2026-09）。
  // 不改送 thinking: disabled —— 上游不收的話，「通不通」這一項就被別的問題拖下水
  const response = await call(provider, model, {
    max_tokens: 512,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  })
  if (!response.ok) return { ok: false, ms: Date.now() - started, error: await errorDetail(response) }

  const json = await response.json()
  const text = textOf(json.content ?? [])
  const reply = text
    ? JSON.stringify(text.slice(0, 40))
    : `empty (stop_reason=${json.stop_reason}${json.stop_reason === 'max_tokens' ? ', thinking used up max_tokens' : ''})`
  return {
    ok: true,
    ms: Date.now() - started,
    detail: `upstream reported model=${json.model ?? '?'} · reply ${reply} · in ${json.usage?.input_tokens ?? '?'} / out ${
      json.usage?.output_tokens ?? '?'
    } tokens`,
  }
}

async function testStreaming(provider, model) {
  const started = Date.now()
  const response = await call(provider, model, {
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'Count from 1 to 5, separated by spaces.' }],
  })
  if (!response.ok) return { ok: false, ms: Date.now() - started, error: await errorDetail(response) }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('event-stream')) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: `content-type is ${contentType || '(empty)'}, not text/event-stream — upstream did not actually stream`,
    }
  }

  const stream = await readStream(response, started)
  const sawDelta = stream.events.has('content_block_delta')
  const sawStop = stream.events.has('message_stop')
  return {
    ok: sawDelta && sawStop,
    ms: Date.now() - started,
    detail: `first byte ${stream.firstByteMs}ms · ${stream.bytes} bytes · events: ${[...stream.events].join(', ') || '(none)'}`,
    error: sawDelta && sawStop ? undefined : 'missing content_block_delta or message_stop event',
  }
}

async function testTools(provider, model) {
  const started = Date.now()
  const response = await call(provider, model, {
    max_tokens: 256,
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    ],
    messages: [{ role: 'user', content: 'What is the weather in Taipei? Use the get_weather tool.' }],
  })
  if (!response.ok) return { ok: false, ms: Date.now() - started, error: await errorDetail(response) }

  const json = await response.json()
  const toolUse = (json.content ?? []).find((b) => b.type === 'tool_use')
  return {
    ok: Boolean(toolUse),
    ms: Date.now() - started,
    detail: toolUse
      ? `called ${toolUse.name}(${JSON.stringify(toolUse.input)}) · stop_reason=${json.stop_reason}`
      : `stop_reason=${json.stop_reason}, no tool_use block`,
    error: toolUse ? undefined : 'upstream did not issue a tool call — Claude Code will not work on this provider',
  }
}

/**
 * Claude Code 子 agent 每個推論請求都帶的思考相關欄位（形狀照實測 v2.1.227 抄），檔位壓到 low 省錢。
 * 不改送 thinking: disabled —— 真實流量不會那樣送，上游若不收 disabled，失敗就記錯了地方。
 */
const SUBAGENT_SHAPE = {
  max_tokens: 4096,
  thinking: { type: 'adaptive', display: 'omitted' },
  output_config: { effort: 'low' },
  context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
}

/**
 * 子 agent 每一輪的真實形狀：串流吐出 tool_use，Claude Code 把整則 assistant 訊息
 * （包括 thinking 與它的 signature）原樣送回去，再附上 tool_result。
 *
 * 單發的「工具呼叫」測不到這兩件事：input_json_delta 拼不拼得回合法 JSON，
 * 以及上游收不收自己吐出來的 thinking block。後者壞掉時是第二輪直接 400。
 */
async function testToolLoop(provider, model) {
  const started = Date.now()
  const trackingCode = secretCode()
  const request = {
    ...SUBAGENT_SHAPE,
    stream: true,
    tools: [
      {
        name: 'get_order_status',
        description: 'Look up the shipping status of an order.',
        input_schema: {
          type: 'object',
          properties: { order_id: { type: 'string', description: 'Order id, e.g. A-1042' } },
          required: ['order_id'],
        },
      },
    ],
  }
  const ask = {
    role: 'user',
    content: 'Use the get_order_status tool to look up order A-1042, then reply with the tracking code it returns and nothing else.',
  }

  const first = await call(provider, model, { ...request, messages: [ask] })
  if (!first.ok) return { ok: false, ms: Date.now() - started, error: await errorDetail(first) }
  const turn1 = await readStream(first, started)
  const toolUse = turn1.blocks.find((b) => b.type === 'tool_use')
  if (turn1.jsonErrors.length) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: `input_json_delta did not reassemble into valid JSON: ${JSON.stringify(turn1.jsonErrors[0])}`,
    }
  }
  if (!toolUse) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: `first turn streamed no tool_use (stop_reason=${turn1.stopReason}${turn1.error ? ` · ${turn1.error}` : ''})`,
    }
  }

  const echoed = turn1.blocks.map((b) => b.type)
  const second = await call(provider, model, {
    ...request,
    messages: [
      ask,
      { role: 'assistant', content: turn1.blocks },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: `Order A-1042: shipped. Tracking code: ${trackingCode}` }],
      },
    ],
  })
  if (!second.ok) {
    return {
      ok: false,
      ms: Date.now() - started,
      detail: `echoed assistant message contains ${echoed.join(' + ')}`,
      error: `the turn sending back tool_result was rejected: ${await errorDetail(second)}`,
    }
  }
  const turn2 = await readStream(second, started)
  const reply = textOf(turn2.blocks)
  const ok = reply.includes(trackingCode)
  return {
    ok,
    ms: Date.now() - started,
    detail: `turn 1 ${toolUse.name}(${JSON.stringify(toolUse.input)}) · echoed ${echoed.join(' + ')} · turn 2 stop_reason=${turn2.stopReason}`,
    error: ok
      ? undefined
      : `turn 2 did not use the tool_result content (reply ${JSON.stringify(reply.slice(0, 80))}${turn2.error ? ` · ${turn2.error}` : ''})`,
  }
}

/**
 * Claude Code 把 skills 清單、提醒這類內容放在對話中間的 role: "system" 訊息裡
 * （mid-conversation-system beta，實測 v2.1.274 每一筆子 agent 請求都有）。
 * 這不是標準 Messages API 的角色：上游收下卻丟掉的話，子 agent 就少了那一大段指示，而且不會報錯。
 *
 * 兩個位置照抓到的形狀各放一個碼：第一則 user 之後一則純字串的，結尾一則帶 cache_control 的。
 */
async function testSystemMessages(provider, model) {
  const started = Date.now()
  const early = secretCode()
  const late = secretCode()
  const response = await call(provider, model, {
    ...SUBAGENT_SHAPE,
    messages: [
      { role: 'user', content: 'You will be given a session code and a reminder code during this conversation.' },
      { role: 'system', content: `Session code: ${early}` },
      { role: 'assistant', content: 'Understood.' },
      {
        role: 'user',
        content: 'Reply exactly as: SESSION=<session code> REMINDER=<reminder code>. Write NONE for any code you were not given.',
      },
      {
        role: 'system',
        content: [{ type: 'text', text: `Reminder code: ${late}`, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      },
    ],
  })
  return judgeReply(response, started, (text) => {
    const missing = [
      [early, 'mid-conversation'],
      [late, 'trailing'],
    ].filter(([code]) => !text.includes(code))
    return {
      ok: missing.length === 0,
      detail: `reply ${JSON.stringify(text.slice(0, 80))}`,
      error: missing.length
        ? `the model did not see the ${missing.map(([, where]) => where).join(' and ')} system message — subagents lose the instructions Claude Code puts there, without any error`
        : undefined,
    }
  })
}

const QUADRANT_COLORS = {
  red: [220, 40, 40],
  green: [40, 170, 70],
  blue: [40, 80, 220],
  yellow: [235, 210, 40],
}

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/** 四格純色的 PNG。零依賴自己編碼，因為 GUI 與 router 都守著「沒有 npm 依賴」。 */
function quadrantPng(colors, size = 128) {
  const row = size * 3 + 1
  const raw = Buffer.alloc(row * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const quadrant = (y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1)
      const offset = y * row + 1 + x * 3
      QUADRANT_COLORS[colors[quadrant]].forEach((v, i) => (raw[offset + i] = v))
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolor RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 只有一頁、一行字的 PDF。xref 的位移要算對，否則寬容度低的解析器會當成壞檔。 */
function textPdf(text) {
  const stream = `BT /F1 24 Tf 20 40 Td (${text}) Tj ET`
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(out)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
    return at
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out)
}

const READ_TOOL = {
  name: 'Read',
  description: 'Reads a file from the local filesystem.',
  input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
}

/**
 * 看圖與讀 PDF 共用：先讓模型真的呼叫一次 Read，再把它自己那則回覆原樣送回去，附上裝著檔案內容的 tool_result。
 *
 * 不能自己捏一則 assistant 訊息當歷史：開著思考時，DeepSeek 要求帶 tool_use 的 assistant 訊息附上
 * 它自己吐出的 thinking block，缺了直接 400（實測 2026-09，deepseek-flash）—— 那個 400 會被誤記成
 * 「看不到圖片」。Claude Code 送回去的本來就是模型自己產生的那一則，照做才測得準。
 */
async function readFileTurns(provider, model, started, { instruction, resultContent, judge }) {
  const request = { ...SUBAGENT_SHAPE, tools: [READ_TOOL] }
  const ask = { role: 'user', content: instruction }

  const first = await call(provider, model, { ...request, messages: [ask] })
  if (!first.ok) return { ok: false, ms: Date.now() - started, error: await errorDetail(first) }
  const turn1 = await first.json()
  const toolUse = (turn1.content ?? []).find((b) => b.type === 'tool_use')
  if (!toolUse) {
    return { ok: false, inconclusive: true, ms: Date.now() - started, error: `the model did not call Read (stop_reason=${turn1.stop_reason}), cannot judge` }
  }

  const second = await call(provider, model, {
    ...request,
    messages: [
      ask,
      { role: 'assistant', content: turn1.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: resultContent }] },
    ],
  })
  return judgeReply(second, started, judge)
}

async function testVision(provider, model) {
  const started = Date.now()
  const names = Object.keys(QUADRANT_COLORS)
  // 可重複：瞎猜全對的機率是 1/256
  const colors = Array.from({ length: 4 }, () => names[randomInt(names.length)])
  const expected = ['TL', 'TR', 'BL', 'BR'].map((q, i) => `${q}=${colors[i]}`).join(' ')
  const png = quadrantPng(colors).toString('base64')

  return readFileTurns(provider, model, started, {
    instruction:
      'Use the Read tool to read /tmp/probe.png. The image is split into four equal quadrants, each one solid color: red, green, blue or yellow (colors may repeat). After reading it, reply only as: TL=<color> TR=<color> BL=<color> BR=<color>',
    resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
    judge: (text) => {
      const answer = ['TL', 'TR', 'BL', 'BR']
        .map((q) => `${q}=${(new RegExp(`\\b${q}\\s*=\\s*([a-z]+)`, 'i').exec(text)?.[1] ?? '?').toLowerCase()}`)
        .join(' ')
      const ok = answer === expected
      return {
        ok,
        detail: `expected ${expected} · answered ${answer}`,
        error: ok
          ? undefined
          : 'answer does not match the image — the image in the tool result never reached the model (or the model has no vision). Subagents reading images or screenshots will answer by guessing',
      }
    },
  })
}

async function testPdf(provider, model) {
  const started = Date.now()
  const code = `PDF-${secretCode()}`
  const pdf = textPdf(code)

  return readFileTurns(provider, model, started, {
    instruction:
      'Use the Read tool to read /tmp/probe.pdf, then reply with the code printed in it and nothing else. If you cannot see the contents of the PDF, reply NONE.',
    resultContent: [
      { type: 'text', text: `PDF file read: /tmp/probe.pdf (${pdf.length} bytes)` },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
    ],
    judge: (text) => {
      const ok = text.includes(code)
      return {
        ok,
        detail: `expected ${code} · reply ${JSON.stringify(text.slice(0, 60))}`,
        error: ok ? undefined : 'the PDF content never reached the model — subagents reading a PDF with Read only see the file name line',
      }
    },
  })
}

/**
 * tier：required ＝不過就跑不起來；capability ＝跑得起來，但那個能力靜默失效。
 * label 是英文預設值；GUI 是雙語的，實際顯示時 app.js 會照這裡的 id 去 i18n 目錄查表，
 * 查不到才用這個欄位保底。
 */
const TESTS = {
  connectivity: { label: 'Basic inference', tier: 'required', run: testConnectivity },
  streaming: { label: 'SSE streaming', tier: 'required', run: testStreaming },
  tools: { label: 'Tool calling', tier: 'required', run: testTools },
  toolLoop: { label: 'Streaming tool loop', tier: 'required', run: testToolLoop },
  systemMessages: { label: 'Mid-conversation system messages', tier: 'capability', run: testSystemMessages },
  vision: { label: 'Vision', tier: 'capability', run: testVision },
  pdf: { label: 'Reading PDFs', tier: 'capability', run: testPdf },
}

/** @param {{ model?: string, tests?: string[] }} [options] tests 是測試用的，只跑其中幾項 */
export async function runProbes(provider, { model, tests = Object.keys(TESTS) } = {}) {
  const target = (model ?? '').trim() || provider.model
  const configFailure = (error) => ({ model: target, results: [{ id: 'config', label: 'Config', tier: 'required', ok: false, error }] })
  if (!provider.baseUrl) return configFailure('Base URL is not set')
  if (!target) return configFailure('no model name to test — fill one in on the provider or the test field')

  const results = []
  for (const id of tests) {
    const test = TESTS[id]
    if (!test) continue
    try {
      const outcome = await test.run(provider, target)
      results.push({ id, label: test.label, tier: test.tier, ...outcome })
    } catch (err) {
      const message = err.name === 'TimeoutError' ? `timed out (>${TIMEOUT_MS / 1000}s)` : String(err.message ?? err)
      results.push({ id, label: test.label, tier: test.tier, ok: false, error: message })
    }
  }
  return { model: target, results }
}
