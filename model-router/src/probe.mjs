/**
 * Provider 連通性測試。
 *
 * 這三項對應 Claude Code 實際會用到、也實際最常在第三方相容層上壞掉的能力：
 *   1. 基本推論      base URL / key / model 名三者對不對
 *   2. SSE 串流      Claude Code 的推論一律走串流，不能串就完全不能用
 *   3. 工具呼叫      Claude Code 幾乎每個 turn 都在 call tool，不支援等於不能用
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
    detail: `上游回報 model=${json.model ?? '?'}・回覆 ${JSON.stringify(text.slice(0, 40))}・in ${
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
      error: `content-type 是 ${contentType || '(空)'}，不是 text/event-stream，上游沒有真的串流`,
    }
  }

  const events = new Set()
  let firstByteMs = null
  let bytes = 0
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of response.body) {
    if (firstByteMs === null) firstByteMs = Date.now() - started
    bytes += chunk.length
    buffer += decoder.decode(chunk, { stream: true })
    for (const line of buffer.split('\n')) {
      if (line.startsWith('event:')) events.add(line.slice(6).trim())
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
  }

  const sawDelta = events.has('content_block_delta')
  const sawStop = events.has('message_stop')
  return {
    ok: sawDelta && sawStop,
    ms: Date.now() - started,
    detail: `首位元組 ${firstByteMs}ms・${bytes} bytes・events: ${[...events].join(', ') || '(無)'}`,
    error: sawDelta && sawStop ? undefined : '缺少 content_block_delta 或 message_stop 事件',
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
      ? `呼叫了 ${toolUse.name}(${JSON.stringify(toolUse.input)})・stop_reason=${json.stop_reason}`
      : `stop_reason=${json.stop_reason}，沒有 tool_use block`,
    error: toolUse ? undefined : '上游沒有發出工具呼叫，Claude Code 在這個 provider 上會無法運作',
  }
}

const TESTS = {
  connectivity: { label: '基本推論', run: testConnectivity },
  streaming: { label: 'SSE 串流', run: testStreaming },
  tools: { label: '工具呼叫', run: testTools },
}

export const TEST_IDS = Object.keys(TESTS)

export async function runProbes(provider, { model, tests = TEST_IDS } = {}) {
  const target = (model ?? '').trim() || provider.model
  if (!provider.baseUrl) return { model: target, results: [{ id: 'config', label: '設定', ok: false, error: '沒有填 Base URL' }] }
  if (!target) {
    return {
      model: target,
      results: [{ id: 'config', label: '設定', ok: false, error: '沒有 model 名可測，請在 provider 或測試欄位填一個' }],
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
      const message = err.name === 'TimeoutError' ? `逾時（>${TIMEOUT_MS / 1000}s）` : String(err.message ?? err)
      results.push({ id, label: test.label, ok: false, error: message })
    }
  }
  return { model: target, results }
}
