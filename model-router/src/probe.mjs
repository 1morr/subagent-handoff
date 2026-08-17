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
 * 難度要剛好：太簡單則各檔位都是幾百字，量不出差異；太難則全部撞 max_tokens，
 * 差異一樣被壓平（實測過一道要枚舉一萬個整數的題目，六個檔位全部卡在天花板）。
 * 這題在 deepseek-v4-pro 上自然收斂在 300～1200 output tokens，兩端拉得開。
 */
const EFFORT_PROBLEM =
  'A bag contains 5 red, 3 blue, and 7 green marbles. Four marbles are drawn without ' +
  'replacement. Compute the exact probability that all three colours appear among them. ' +
  'Reply with only the fully reduced fraction.'

function thinkingChars(json) {
  return (json.content ?? [])
    .filter((b) => b.type === 'thinking')
    .map((b) => b.thinking ?? '')
    .join('').length
}

/**
 * /effort 失效是最難察覺的故障：請求照樣 200，只是模型變笨。這一項拆成兩段驗：
 *
 *   前段（判定依據）  五個檔位逐一送真實請求形狀，看有沒有 400。寬容度低的相容層
 *                     會在這裡炸 —— 而且錯誤訊息通常直接點名欄位，比猜有用。
 *   後段（僅供參考）  low 與 max 各跑一次，比思考量。上游把欄位收下卻沒接線時，
 *                     兩端會一樣長。單次採樣波動大，所以只寫進 detail，不決定 ok。
 */
async function testEffort(provider, model) {
  const started = Date.now()

  if ((provider.dropFields ?? []).includes('output_config')) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: 'dropFields 含 output_config，/effort 會在送出前被剝掉，對這個 provider 完全失效',
    }
  }

  const rejected = []
  for (const effort of EFFORT_LEVELS) {
    const response = await call(provider, model, {
      max_tokens: 64,
      ...thinkingShape(effort),
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    })
    if (!response.ok) rejected.push(`${effort} → ${await errorDetail(response)}`)
  }
  if (rejected.length) {
    return {
      ok: false,
      ms: Date.now() - started,
      detail: `${EFFORT_LEVELS.length - rejected.length}/${EFFORT_LEVELS.length} 個檔位可用`,
      error: rejected[0],
    }
  }

  const measure = async (effort) => {
    const response = await call(provider, model, {
      max_tokens: 4000,
      ...thinkingShape(effort),
      messages: [{ role: 'user', content: EFFORT_PROBLEM }],
    })
    if (!response.ok) return null
    const json = await response.json()
    // 沒有 thinking block 的相容層（思考被藏起來）退回比 output_tokens
    const chars = thinkingChars(json)
    return {
      value: chars || (json.usage?.output_tokens ?? 0),
      unit: chars ? '字' : 'tok',
      truncated: json.stop_reason === 'max_tokens',
    }
  }
  const lo = await measure('low')
  const hi = await measure('max')

  const ms = Date.now() - started
  const passed = `五個檔位全數接受（${EFFORT_LEVELS.join(' / ')}）`
  if (!lo || !hi || !lo.value || !hi.value) {
    return { ok: true, ms, detail: `${passed}・但量不到思考量，無法判斷是否真的接線` }
  }
  if (lo.truncated || hi.truncated) {
    return { ok: true, ms, detail: `${passed}・量測撞到 max_tokens，比值作廢` }
  }

  const ratio = hi.value / lo.value
  const compared = `low ${lo.value}${lo.unit} vs max ${hi.value}${hi.unit}（${ratio.toFixed(2)}×）`
  /**
   * 只在比值夠大時下正面結論。比值接近 1 有兩種成因，單次採樣分不出來：
   * 上游沒把欄位接到思考檔位，或這題對這個模型沒有解析度。實測 Kimi K3 在這題上
   * 六種送法（不帶 output_config 加五個檔位）各 3 次，中位數全部落在 400～660 字、
   * 範圍互相完全覆蓋，但它換一道夠難的題目就有 4～5 倍差距。
   * 所以低比值一律不下判定，讓看的人自己多跑幾次。
   */
  const verdict =
    ratio >= 1.4
      ? '兩端差距明顯，檔位確實有作用'
      : '兩端看不出差異 —— 可能是上游沒接線，也可能是這題不適合這個模型，單次採樣無法判定'
  return { ok: true, ms, detail: `${passed}・${compared}・${verdict}` }
}

const TESTS = {
  connectivity: { label: '基本推論', run: testConnectivity },
  streaming: { label: 'SSE 串流', run: testStreaming },
  tools: { label: '工具呼叫', run: testTools },
  effort: { label: '思考檔位', run: testEffort },
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
