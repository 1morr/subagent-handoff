/**
 * Provider 連通性測試。
 *
 * 這四項對應 Claude Code 實際會用到、也實際最常在第三方相容層上壞掉的能力：
 *   1. 基本推論      base URL / key / model 名三者對不對
 *   2. SSE 串流      Claude Code 的推論一律走串流，不能串就完全不能用
 *   3. 工具呼叫      Claude Code 幾乎每個 turn 都在 call tool，不支援等於不能用
 *   4. 思考檔位      /effort 能不能真的抵達模型 —— 前三項全過也可能靜默失效
 */

const TIMEOUT_MS = 45_000

function headersFor(provider) {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    accept: 'application/json',
  }
  if (provider.apiKey) {
    if (provider.authStyle === 'x-api-key') headers['x-api-key'] = provider.apiKey
    else headers.authorization = `Bearer ${provider.apiKey}`
  }
  for (const [k, v] of Object.entries(provider.extraHeaders ?? {})) headers[k] = v
  return headers
}

function stripDropped(payload, provider) {
  const body = { ...payload }
  for (const field of provider.dropFields ?? []) delete body[field]
  if (provider.maxOutputTokens && body.max_tokens > provider.maxOutputTokens) {
    body.max_tokens = provider.maxOutputTokens
  }
  return body
}

async function errorDetail(response) {
  const text = await response.text().catch(() => '')
  const trimmed = text.trim().slice(0, 400)
  return trimmed || `HTTP ${response.status} ${response.statusText}`
}

async function call(provider, model, payload) {
  const response = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: headersFor(provider),
    body: JSON.stringify(stripDropped({ model, ...payload }, provider)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return response
}

async function testConnectivity(provider, model) {
  const started = Date.now()
  const response = await call(provider, model, {
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  })
  if (!response.ok) return { ok: false, ms: Date.now() - started, error: await errorDetail(response) }

  const json = await response.json()
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  return {
    ok: true,
    ms: Date.now() - started,
    detail: `upstream reported model=${json.model ?? '?'} · reply ${JSON.stringify(text.slice(0, 40))} · in ${
      json.usage?.input_tokens ?? '?'
    } / out ${json.usage?.output_tokens ?? '?'} tokens`,
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

  const events = new Set()
  let firstByteMs = null
  let bytes = 0
  const decoder = new TextDecoder()
  let buffer = ''

  const collect = (text) => {
    for (const line of text.split('\n')) {
      if (line.startsWith('event:')) events.add(line.slice(6).trim())
    }
  }

  for await (const chunk of response.body) {
    if (firstByteMs === null) firstByteMs = Date.now() - started
    bytes += chunk.length
    buffer += decoder.decode(chunk, { stream: true })
    collect(buffer)
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
  }
  // 上游最後一行沒有換行收尾時，message_stop 就卡在 buffer 裡 —— 不收會誤判成串流不完整
  collect(buffer + decoder.decode())

  const sawDelta = events.has('content_block_delta')
  const sawStop = events.has('message_stop')
  return {
    ok: sawDelta && sawStop,
    ms: Date.now() - started,
    detail: `first byte ${firstByteMs}ms · ${bytes} bytes · events: ${[...events].join(', ') || '(none)'}`,
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

/** Claude Code v2.1.231 的完整檔位枚舉。上游可能還吃別的值，但送不到的不必測。 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Claude Code 每個推論請求都帶的三個思考相關欄位，形狀照實測 v2.1.227 抄。 */
function thinkingShape(effort) {
  return {
    thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
  }
}

/**
 * /effort 失效是最難察覺的故障：請求照樣 200，只是模型變笨。
 *
 * 五個檔位逐一送**真實的請求形狀**，看有沒有哪個被回 400。判定是確定性的，
 * 而且上游的錯誤訊息通常直接點名欄位（DeepSeek 就是這樣把完整枚舉吐出來的）。
 *
 * 曾經還有第二段「low 與 max 各跑一次比思考量」，已經拿掉：它要多花兩次付費請求，
 * 而單次採樣分不出「上游沒把欄位接到檔位」和「這題對這個模型沒有解析度」——
 * 實測 Kimi K3 六種送法各採樣 3 次，範圍互相完全覆蓋，連基準線都分不出來，
 * 但它其實是吃這個欄位的。花錢買一個「無法判定」不划算。
 */
async function testEffort(provider, model) {
  const started = Date.now()

  if ((provider.dropFields ?? []).includes('output_config')) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: 'dropFields includes output_config, so /effort gets stripped before sending — it is fully disabled for this provider',
    }
  }

  const rejected = []
  for (const effort of EFFORT_LEVELS) {
    const response = await call(provider, model, {
      max_tokens: 64,
      ...thinkingShape(effort),
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    })
    if (response.ok) await response.body?.cancel().catch(() => {})
    else rejected.push(`${effort} → ${await errorDetail(response)}`)
  }

  const ms = Date.now() - started
  if (rejected.length) {
    return {
      ok: false,
      ms,
      detail: `${EFFORT_LEVELS.length - rejected.length}/${EFFORT_LEVELS.length} levels usable`,
      error: rejected[0],
    }
  }
  return { ok: true, ms, detail: `all five levels accepted (${EFFORT_LEVELS.join(' / ')})` }
}

// label 是英文預設值；GUI 是雙語的，實際顯示時 app.js 會照這裡的 id 去 i18n 目錄查表，
// 不吃這個欄位 —— label 只是給還沒套用 i18n 的呼叫端（例如日後的 CLI）當保底。
const TESTS = {
  connectivity: { label: 'Basic inference', run: testConnectivity },
  streaming: { label: 'SSE streaming', run: testStreaming },
  tools: { label: 'Tool calling', run: testTools },
  effort: { label: 'Thinking effort', run: testEffort },
}

export const TEST_IDS = Object.keys(TESTS)

export async function runProbes(provider, { model, tests = TEST_IDS } = {}) {
  const target = (model ?? '').trim() || provider.model
  if (!provider.baseUrl) return { model: target, results: [{ id: 'config', label: 'Config', ok: false, error: 'Base URL is not set' }] }
  if (!target) {
    return {
      model: target,
      results: [{ id: 'config', label: 'Config', ok: false, error: 'no model name to test — fill one in on the provider or the test field' }],
    }
  }

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
