/**
 * Provider 連通性測試。四項任一不過，Claude Code 在這個 provider 上就跑不起來：
 *
 *   1. 基本推論      base URL / key / model 名三者對不對
 *   2. SSE 串流      Claude Code 的推論一律走串流，不能串就完全不能用
 *   3. 工具呼叫      Claude Code 幾乎每個 turn 都在 call tool，不支援等於不能用
 *   4. 串流工具迴圈  串流吐出 tool_use、連同 thinking 把 tool_result 送回去再接著做 —— 子 agent 每一輪的真實形狀
 *
 * 看圖、讀 PDF、中途 system 訊息這類「請求照樣 200、只是能力靜默失效」的差異不在這裡測，
 * DeepSeek 的實測結果記在 docs/claude-code-request-shapes.md。
 */

import { randomInt } from 'node:crypto'
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
 * label 是英文預設值；GUI 是雙語的，實際顯示時 app.js 會照這裡的 id 去 i18n 目錄查表，
 * 查不到才用這個欄位保底。
 */
const TESTS = {
  connectivity: { label: 'Basic inference', run: testConnectivity },
  streaming: { label: 'SSE streaming', run: testStreaming },
  tools: { label: 'Tool calling', run: testTools },
  toolLoop: { label: 'Streaming tool loop', run: testToolLoop },
}

/** @param {{ model?: string, tests?: string[] }} [options] tests 是測試用的，只跑其中幾項 */
export async function runProbes(provider, { model, tests = Object.keys(TESTS) } = {}) {
  const target = (model ?? '').trim() || provider.model
  const configFailure = (error) => ({ model: target, results: [{ id: 'config', label: 'Config', ok: false, error }] })
  if (!provider.baseUrl) return configFailure('Base URL is not set')
  if (!target) return configFailure('no model name to test — fill one in on the provider or the test field')

  const results = []
  for (const id of tests) {
    const test = TESTS[id]
    if (!test) continue
    try {
      const outcome = await test.run(provider, target)
      results.push({ id, label: test.label, ...outcome })
    } catch (err) {
      const message = err.name === 'TimeoutError' ? `timed out (>${TIMEOUT_MS / 1000}s)` : String(err.message ?? err)
      results.push({ id, label: test.label, ok: false, error: message })
    }
  }
  return { model: target, results }
}
