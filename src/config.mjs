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
    label: '新 Provider',
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
    /** 這個 provider 專屬的 retry 覆寫。null = 全部繼承全域；物件 = 只有寫出來的鍵生效。 */
    retry: null,
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
 * 上游暫時性失敗時，router 自己重送幾次再說。
 *
 * 重送只發生在「一個 byte 都還沒寫給 client」的階段：請求 body 完整留在記憶體，
 * 重送是安全的。串流一旦開始就不能重來，那時候重送會讓 client 收到兩段接不起來的回應。
 */
export function defaultRetry(over = {}) {
  return {
    /** 最多額外重送幾次。0 = 關掉，所有錯誤原樣交回 Claude Code。 */
    attempts: 2,
    baseDelayMs: 600,
    maxDelayMs: 5000,
    /** 上游 retry-after 要求等超過這麼久就不自己扛 —— 交回去讓 Claude Code 顯示倒數，它才知道發生什麼事。 */
    maxRetryAfterMs: 10000,
    /**
     * 節流（429）算不算可重送。
     *
     * 訂閱線要關掉：它的 429 是 5 小時額度窗，不是瞬時擁塞，退避幾百毫秒再送三次
     * 只是對已經被擋下的端點多打兩次，還在 Claude Code 顯示倒數之前多壓幾秒。
     * 第三方的 429 通常等一下就過，預設留著。
     */
    retryRateLimit: true,
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
     * 單一請求 body 的上限。router 為了能重送會把整包留在記憶體，沒有上限的話
     * 一個壞掉的 client 就能把記憶體吃光。1M context 的請求實測十幾 MB，這是防呆不是限流。
     */
    maxRequestBytes: 64 * 1024 * 1024,
    /**
     * 沒有規則命中時的去向。不帶憑證，原樣轉發 Claude Code 的訂閱 OAuth。
     *
     * retry 預設就把節流重送關掉：訂閱的 429 是額度窗，等不到退避結束（見 defaultRetry）。
     */
    passthrough: { baseUrl: 'https://api.anthropic.com', retry: { retryRateLimit: false } },
    providers: [kimi],
    /**
     * 預設那條規則**是關的**。首次啟動時 provider 還沒有 API key，開著就等於把每一個
     * 子 agent 請求送去 Moonshot 拿 401 —— 而且是在使用者剛把 ANTHROPIC_BASE_URL 指過來、
     * 最不知道該懷疑誰的時候。關著的話開箱狀態是「全部走訂閱」，跟沒裝這個 router 一樣，
     * 填完 key 再自己把規則打開，分流才開始。
     */
    rules: [defaultRule({ id: 'r-subagent', enabled: false, match: 'subagent', providerId: 'kimi' })],
    retry: defaultRetry(),
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

function asPositive(v, fallback, max = 120_000) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : fallback
}

export function normalizeRetry(raw, base = defaultRetry()) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const attempts = Number(cfg.attempts)
  const baseDelayMs = asPositive(cfg.baseDelayMs, base.baseDelayMs, 30_000)
  return defaultRetry({
    attempts: Number.isInteger(attempts) && attempts >= 0 ? Math.min(attempts, 10) : base.attempts,
    baseDelayMs,
    // 上限比起跳值還小是設定寫錯了，夾回去而不是讓退避變成不會增加
    maxDelayMs: Math.max(baseDelayMs, asPositive(cfg.maxDelayMs, base.maxDelayMs, 60_000)),
    maxRetryAfterMs: asPositive(cfg.maxRetryAfterMs, base.maxRetryAfterMs, 120_000),
    retryRateLimit: typeof cfg.retryRateLimit === 'boolean' ? cfg.retryRateLimit : base.retryRateLimit,
  })
}

export const RETRY_KEYS = ['attempts', 'baseDelayMs', 'maxDelayMs', 'maxRetryAfterMs', 'retryRateLimit']

/**
 * 路由層的 retry 覆寫。**稀疏**：只留使用者真的寫了的鍵，其餘留給全域。
 *
 * 整組取代的話，只想關掉 429 重送的人會連 attempts / 退避一起凍在當下的值，
 * 之後調全域就不會傳播過去。回傳 null 代表完全繼承。
 */
export function normalizeRetryOverride(raw) {
  if (!raw || typeof raw !== 'object') return null
  const present = RETRY_KEYS.filter((k) => raw[k] != null)
  if (!present.length) return null
  // 借 normalizeRetry 做值域檢查，再把沒寫的鍵丟掉
  const checked = normalizeRetry(raw)
  return Object.fromEntries(present.map((k) => [k, checked[k]]))
}

function asPort(v, fallback) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}

function trimSlash(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : ''
}

function normalizeHeaders(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k).trim()
    if (name && typeof v === 'string') out[name] = v
  }
  return out
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
          label: String(p.label ?? '').trim() || '未命名',
          baseUrl: trimSlash(p.baseUrl),
          apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
          model: String(p.model ?? '').trim(),
          authStyle: p.authStyle === 'x-api-key' ? 'x-api-key' : 'bearer',
          dropFields: Array.isArray(p.dropFields)
            ? [...new Set(p.dropFields.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim()))]
            : [],
          dropBeta: p.dropBeta !== false,
          maxOutputTokens: Number.isInteger(p.maxOutputTokens) && p.maxOutputTokens > 0 ? p.maxOutputTokens : null,
          retry: normalizeRetryOverride(p.retry),
          extraHeaders: normalizeHeaders(p.extraHeaders),
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
      baseUrl: trimSlash(cfg.passthrough?.baseUrl) || base.passthrough.baseUrl,
      // 完全沒有這個鍵＝舊版設定檔，套用新預設把節流重送關掉 —— 載入就直接修好
      retry:
        cfg.passthrough?.retry === undefined
          ? base.passthrough.retry
          : normalizeRetryOverride(cfg.passthrough.retry),
    },
    providers,
    rules,
    retry: normalizeRetry(cfg.retry),
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
    throw new Error(`讀取 ${CONFIG_PATH} 失敗：${err.message}`)
  }
}

export async function saveConfig(cfg) {
  const normalized = normalizeConfig(cfg)
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
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

/** 收到瀏覽器的版本：把 KEEP_SECRET 還原成現存的 key。 */
export function fromClientConfig(incoming, current) {
  const byId = new Map(current.providers.map((p) => [p.id, p]))
  return normalizeConfig({
    ...incoming,
    providers: (incoming.providers ?? []).map((p) => {
      const { apiKeyHint, ...rest } = p
      if (rest.apiKey === KEEP_SECRET) rest.apiKey = byId.get(rest.id)?.apiKey ?? ''
      return rest
    }),
  })
}
