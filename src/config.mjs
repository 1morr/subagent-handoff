import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PASSTHROUGH_ID } from './routing.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const CONFIG_PATH = process.env.ROUTER_CONFIG
  ? path.resolve(process.env.ROUTER_CONFIG)
  : path.join(ROOT, 'config.json')

/** 前端拿到的 apiKey 是遮罩過的；存回來時若仍是這個值，代表使用者沒改，保留原 key。 */
export const KEEP_SECRET = '__keep__'

export const MASKED_KEY_MOVED = 'baseUrl differs from the stored value — enter the API key again, the masked value cannot be reused'

export const MATCH_KINDS = ['any', 'main', 'subagent', 'nested']

/**
 * 遇到 400 時最可能是元凶的欄位，給 GUI 當「一鍵填入」的候選清單用，**不是預設值**。
 *
 * 預設不移除任何欄位。移除是靜默降級：拿掉 `output_config` 會讓 `/effort` 完全失效，
 * 但請求照樣成功，只是模型變笨，很難察覺。留著頂多換來一個看得見的 400。
 * 實測 cliproxyapi 與 Moonshot 官方 Anthropic 端點三個欄位全收。
 */
export const COMMON_DROP_FIELDS = ['thinking', 'context_management', 'output_config']

export function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

export function defaultProvider(over = {}) {
  return {
    id: newId('p'),
    label: 'New Provider',
    baseUrl: '',
    apiKey: '',
    /** 空字串 = 不改寫，原樣把 Claude Code 要求的 model 名送過去。 */
    model: '',
    /** bearer → Authorization: Bearer；x-api-key → x-api-key。 */
    authStyle: 'bearer',
    dropFields: [],
    /** anthropic-beta 帶的是 Anthropic 專屬 capability，多數第三方會拒收。 */
    dropBeta: true,
    /** 上游 max_tokens 上限，超過就夾住。null = 不夾。 */
    maxOutputTokens: null,
    extraHeaders: {},
    ...over,
  }
}

export function defaultRule(over = {}) {
  return {
    id: newId('r'),
    enabled: true,
    /** any | main | subagent | nested */
    match: 'subagent',
    modelGlob: '*',
    /**
     * 比對 `x-claude-code-agent-id`，支援 `*`。`*` = 不篩。
     *
     * 一般 subagent 的 id 是每次 spawn 重新產生的隨機值，篩不出東西；但官方文檔載明
     * **agent team 的 teammate 會沿用由名字衍生的穩定 id**，所以這個欄位的用途是
     * 按角色分流（例如某個 teammate 走便宜的 provider、另一個留在訂閱）。
     */
    agentIdGlob: '*',
    /** provider 的 id，或 PASSTHROUGH_ID＝導回訂閱。 */
    providerId: '',
    /** 空字串 = 不改寫。有值時蓋過 provider 自己的 model；指向 passthrough 時也照樣生效。 */
    modelOverride: '',
    ...over,
  }
}

/**
 * 流量記錄的落檔設定。記憶體裡只留最近 300 筆且重啟就沒了，
 * 但要查的問題常常橫跨重啟，所以預設寫一份到磁碟。只有中繼資料，沒有 prompt。
 */
export function defaultTrafficLog(over = {}) {
  return {
    /** 空字串 = 不落檔。相對路徑以 config.json 所在目錄為準。 */
    file: 'traffic.log',
    /** 超過就輪替成 <file>.1，只留一份舊的，所以磁碟最多佔兩倍。 */
    maxBytes: 5_000_000,
    ...over,
  }
}

export function defaultConfig() {
  const kimi = defaultProvider({
    id: 'kimi',
    label: 'Kimi K3 (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    model: 'kimi-k3',
  })
  return {
    proxyPort: 8787,
    adminPort: 8788,
    /**
     * 單一請求 body 的上限。router 要讀完整包才能判斷路由與改寫，沒有上限的話
     * 一個壞掉的 client 就能把記憶體吃光。1M context 的請求實測十幾 MB，這是防呆不是限流。
     */
    maxRequestBytes: 64 * 1024 * 1024,
    /** 沒有規則命中時的去向。不帶憑證，原樣轉發 Claude Code 的訂閱 OAuth。 */
    passthrough: { baseUrl: 'https://api.anthropic.com' },
    providers: [kimi],
    /**
     * 預設那條規則**是關的**。首次啟動時 provider 還沒有 API key，開著就等於把每一個
     * 子 agent 請求送去 Moonshot 拿 401 —— 而且是在使用者剛把 ANTHROPIC_BASE_URL 指過來、
     * 最不知道該懷疑誰的時候。關著的話開箱狀態是「全部走訂閱」，跟沒裝這個 router 一樣，
     * 填完 key 再自己把規則打開，分流才開始。
     */
    rules: [defaultRule({ id: 'r-subagent', enabled: false, match: 'subagent', providerId: 'kimi' })],
    trafficLog: defaultTrafficLog(),
  }
}

export function normalizeTrafficLog(raw) {
  const base = defaultTrafficLog()
  const cfg = raw && typeof raw === 'object' ? raw : {}
  return defaultTrafficLog({
    file: typeof cfg.file === 'string' ? cfg.file.trim() : base.file,
    // 太小的上限會讓每一筆都在輪替，等於只留最後一行
    maxBytes: Math.max(10_000, asPositive(cfg.maxBytes, base.maxBytes, 1_000_000_000)),
  })
}

function asPositive(v, fallback, max) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : fallback
}

function asPort(v, fallback) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}

export function trimSlash(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : ''
}

/**
 * baseUrl 會被原樣接在 `target = baseUrl + req.url` 上再交給 fetch，
 * 沒有 scheme 檢查的話可以指到 `http://169.254.169.254` 之類的位址，
 * 而且憑證會一起帶過去。空字串（尚未設定）算合法，其餘一律要求 http/https。
 *
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function validateBaseUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return { ok: true, value: '' }
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: `not a valid URL: ${trimmed}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `must be http:// or https://, not ${parsed.protocol}//` }
  }
  return { ok: true, value: trimSlash(trimmed) }
}

/** provider 的 baseUrl：驗證失敗就清空（未設定），並在 console 留下原因，不讓載入整個炸掉。 */
function normalizeProviderBaseUrl(raw, label) {
  const result = validateBaseUrl(raw)
  if (result.ok) return result.value
  console.error(`✗ provider "${label}" has an invalid baseUrl (${result.error}); it has been cleared and the provider will not be used until you fix it`)
  return ''
}

/** passthrough 的 baseUrl：一定要有個值可用，驗證失敗就退回預設。 */
function normalizePassthroughBaseUrl(raw, fallback) {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return fallback
  const result = validateBaseUrl(trimmed)
  if (!result.ok) {
    console.error(`✗ passthrough.baseUrl is invalid (${result.error}); falling back to ${fallback}`)
    return fallback
  }
  return result.value
}

/**
 * HTTP header 名稱允許的字元集（RFC 7230 token）。CR/LF 之類的字元 undici 的 Headers
 * 本來就會拒收，但拒收的時機是送出去的那一刻，那時候只剩一個看不出原因的 502。
 * 這裡提前擋，直接講是哪個名字不合法。
 */
const HEADER_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export function isValidHeaderName(name) {
  return typeof name === 'string' && HEADER_TOKEN_RE.test(name)
}

function normalizeHeaders(raw, label) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k).trim()
    if (!name || typeof v !== 'string') continue
    if (!isValidHeaderName(name)) {
      console.error(`✗ provider "${label}" has an invalid extraHeaders name; skipping ${JSON.stringify(name)}`)
      continue
    }
    out[name] = v
  }
  return out
}

/**
 * 前端拿到的 apiKey 是遮罩值；把它換回真 key 只能在 baseUrl 跟已存的完全一樣時做。
 * baseUrl 換了還沿用遮罩，等於把已存的 key 綁到新目的地 —— 要使用者明著重填，
 * 不能悄悄還原，也不能悄悄清空（清空的話使用者存完檔才發現 key 不見了）。
 *
 * @returns {string | null} 已存的 key；null ＝ 不能還原
 */
export function restoreMaskedKey(submitted, current) {
  const stored = current.providers.find((p) => p.id === submitted.id)
  const url = validateBaseUrl(submitted.baseUrl)
  return stored && url.ok && url.value === stored.baseUrl ? stored.apiKey : null
}

/**
 * `PUT /api/config` 存檔前的把關。normalizeConfig 遇到壞資料是「修掉」而不是拋錯
 * （config.json 被手改壞掉時，載入不該讓整個 proxy 起不來），但使用者從 GUI 主動送出
 * 壞資料時應該看到明確的錯誤，而不是被靜默清空、或者送出去才炸成一個看不懂的 502。
 * 這裡驗證的是**送進來的原始資料**，在還沒被 normalizeConfig 悄悄修正之前。
 *
 * @param {object} current 目前生效的設定，用來判斷遮罩值能不能換回真 key
 * @returns {string[]} 問題清單；空陣列＝可以存
 */
export function describeConfigProblems(raw, current) {
  const problems = []
  const cfg = raw && typeof raw === 'object' ? raw : {}

  if (cfg.passthrough) {
    const result = validateBaseUrl(cfg.passthrough.baseUrl)
    if (!result.ok) problems.push(`passthrough.baseUrl: ${result.error}`)
  }

  for (const p of Array.isArray(cfg.providers) ? cfg.providers : []) {
    if (!p || typeof p !== 'object') continue
    const label = String(p.label ?? p.id ?? 'Unnamed')
    const result = validateBaseUrl(p.baseUrl)
    if (!result.ok) problems.push(`provider "${label}" baseUrl: ${result.error}`)
    if (result.ok && p.apiKey === KEEP_SECRET && restoreMaskedKey(p, current) === null) {
      problems.push(`provider "${label}": ${MASKED_KEY_MOVED}`)
    }
    for (const key of Object.keys(p.extraHeaders && typeof p.extraHeaders === 'object' ? p.extraHeaders : {})) {
      if (!isValidHeaderName(key)) {
        problems.push(`provider "${label}" has an invalid extraHeaders header name: ${JSON.stringify(key)}`)
      }
    }
  }

  return problems
}

export function normalizeConfig(raw) {
  const base = defaultConfig()
  const cfg = raw && typeof raw === 'object' ? raw : {}

  const providers = Array.isArray(cfg.providers)
    ? cfg.providers.filter((p) => p && typeof p === 'object').map((p) =>
        defaultProvider({
          ...p,
          // PASSTHROUGH_ID 是規則用來指回訂閱的保留值，不能讓 provider 佔走
          id: typeof p.id === 'string' && p.id && p.id !== PASSTHROUGH_ID ? p.id : newId('p'),
          label: String(p.label ?? '').trim() || 'Unnamed',
          baseUrl: normalizeProviderBaseUrl(p.baseUrl, String(p.label ?? p.id ?? 'Unnamed')),
          apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
          model: String(p.model ?? '').trim(),
          authStyle: p.authStyle === 'x-api-key' ? 'x-api-key' : 'bearer',
          dropFields: Array.isArray(p.dropFields)
            ? [...new Set(p.dropFields.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim()))]
            : [],
          dropBeta: p.dropBeta !== false,
          maxOutputTokens: Number.isInteger(p.maxOutputTokens) && p.maxOutputTokens > 0 ? p.maxOutputTokens : null,
          extraHeaders: normalizeHeaders(p.extraHeaders, String(p.label ?? p.id ?? 'Unnamed')),
        }),
      )
    : base.providers

  const rules = Array.isArray(cfg.rules)
    ? cfg.rules.filter((r) => r && typeof r === 'object').map((r) =>
        defaultRule({
          ...r,
          id: typeof r.id === 'string' && r.id ? r.id : newId('r'),
          enabled: r.enabled !== false,
          match: MATCH_KINDS.includes(r.match) ? r.match : 'subagent',
          modelGlob: String(r.modelGlob ?? '*').trim() || '*',
          agentIdGlob: String(r.agentIdGlob ?? '*').trim() || '*',
          providerId: String(r.providerId ?? '').trim(),
          modelOverride: String(r.modelOverride ?? '').trim(),
        }),
      )
    : base.rules

  return {
    proxyPort: asPort(cfg.proxyPort, base.proxyPort),
    adminPort: asPort(cfg.adminPort, base.adminPort),
    // 下限抓 1MB：比這還小的上限只會把正常請求全部擋掉
    maxRequestBytes: Math.max(1_000_000, asPositive(cfg.maxRequestBytes, base.maxRequestBytes, 1_000_000_000)),
    passthrough: {
      baseUrl: normalizePassthroughBaseUrl(cfg.passthrough?.baseUrl, base.passthrough.baseUrl),
    },
    providers,
    rules,
    trafficLog: normalizeTrafficLog(cfg.trafficLog),
  }
}

export async function loadConfig() {
  try {
    const text = await readFile(CONFIG_PATH, 'utf8')
    return normalizeConfig(JSON.parse(text))
  } catch (err) {
    if (err.code === 'ENOENT') {
      const cfg = defaultConfig()
      await saveConfig(cfg)
      return cfg
    }
    throw new Error(`Could not read ${CONFIG_PATH}: ${err.message}`)
  }
}

export async function saveConfig(cfg) {
  const normalized = normalizeConfig(cfg)
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`
  // config.json 裡有第三方 API key，0600 讓同機的其他使用者讀不到。
  // rename 會保留 tmp 檔的 mode，所以正式檔也是 0600。Windows 上這個選項會被忽略，無害。
  await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, CONFIG_PATH)
  return normalized
}

export function maskSecret(key) {
  if (!key) return ''
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}••••${key.slice(-4)}`
}

/** 送給瀏覽器的版本：真正的 key 換成遮罩，並標記是否已設定。 */
export function toClientConfig(cfg) {
  return {
    ...cfg,
    providers: cfg.providers.map((p) => ({
      ...p,
      apiKey: p.apiKey ? KEEP_SECRET : '',
      apiKeyHint: maskSecret(p.apiKey),
    })),
  }
}

/**
 * 收到瀏覽器的版本：把 KEEP_SECRET 還原成現存的 key（規則見 restoreMaskedKey）。
 *
 * 存檔路徑已經先被 describeConfigProblems 擋過，走到這裡還還原不了的只剩規則預覽，
 * 它用不到 key，所以給空字串就好。
 */
export function fromClientConfig(incoming, current) {
  return normalizeConfig({
    ...incoming,
    providers: (incoming.providers ?? []).map((p) => {
      const { apiKeyHint, ...rest } = p
      if (rest.apiKey === KEEP_SECRET) rest.apiKey = restoreMaskedKey(rest, current) ?? ''
      return rest
    }),
  })
}
