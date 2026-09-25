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

export const MATCH_KINDS = ['main', 'subagent']

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
    ...over,
  }
}

export function defaultRule(over = {}) {
  return {
    id: newId('r'),
    enabled: true,
    /** main | subagent */
    match: 'subagent',
    modelGlob: '*',
    /** provider 的 id，或 PASSTHROUGH_ID＝導回訂閱。 */
    providerId: '',
    /** 空字串 = 不改寫。有值時蓋過 provider 自己的 model；指向 passthrough 時也照樣生效。 */
    modelOverride: '',
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
     * HTTPS proxy 模式（src/connect.mjs）。關著的時候 router 跟沒有這個功能時一模一樣：不收 CONNECT、
     * 不產生 CA。預設關閉，因為它多出一把本機 CA，而且讓 Claude Code 的所有連線都依賴 router 活著。
     * GUI 存檔即時切換，不用重啟（src/index.mjs 的 setConfig）。
     */
    httpsProxy: false,
    providers: [kimi],
    /**
     * 預設那條規則**是關的**。首次啟動時 provider 還沒有 API key，開著就等於把每一個
     * 子 agent 請求送去 Moonshot 拿 401 —— 而且是在使用者剛把 ANTHROPIC_BASE_URL 指過來、
     * 最不知道該懷疑誰的時候。關著的話開箱狀態是「全部走訂閱」，跟沒裝這個 router 一樣，
     * 填完 key 再自己把規則打開，分流才開始。
     */
    rules: [defaultRule({ id: 'r-subagent', enabled: false, match: 'subagent', providerId: 'kimi' })],
  }
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
 * 瀏覽器送來的 provider 能不能用。存檔（`PUT /api/config`）與測試（`POST /api/test`）共用這一道把關。
 *
 * normalizeConfig 遇到壞資料是「修掉」而不是拋錯（config.json 被手改壞掉時，載入不該讓整個 proxy
 * 起不來），但使用者從 GUI 主動送出壞資料時應該看到明確的錯誤，所以這裡看的是還沒被修正的原始資料。
 *
 * @param {object} current 目前生效的設定，用來判斷遮罩值能不能換回真 key
 * @returns {string | null} 問題描述；null ＝ 可以用
 */
export function providerProblem(p, current) {
  const url = validateBaseUrl(p?.baseUrl)
  if (!url.ok) return `baseUrl: ${url.error}`
  if (p.apiKey === KEEP_SECRET && restoreMaskedKey(p, current) === null) return MASKED_KEY_MOVED
  return null
}

/** @returns {string[]} 每個有問題的 provider 一行；空陣列＝可以存 */
export function describeConfigProblems(raw, current) {
  const providers = Array.isArray(raw?.providers) ? raw.providers.filter((p) => p && typeof p === 'object') : []
  return providers.flatMap((p) => {
    const problem = providerProblem(p, current)
    return problem ? [`provider "${String(p.label ?? p.id ?? 'Unnamed')}": ${problem}`] : []
  })
}

/** 逐欄挑出來，不整包展開：設定檔裡已經不認得的舊欄位（例如拿掉的 dropFields）下次存檔就消失 */
function normalizeProvider(p) {
  return {
    // PASSTHROUGH_ID 是規則用來指回訂閱的保留值，不能讓 provider 佔走
    id: typeof p.id === 'string' && p.id && p.id !== PASSTHROUGH_ID ? p.id : newId('p'),
    label: String(p.label ?? '').trim() || 'Unnamed',
    baseUrl: normalizeProviderBaseUrl(p.baseUrl, String(p.label ?? p.id ?? 'Unnamed')),
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
    model: String(p.model ?? '').trim(),
    authStyle: p.authStyle === 'x-api-key' ? 'x-api-key' : 'bearer',
  }
}

export function normalizeConfig(raw) {
  const base = defaultConfig()
  const cfg = raw && typeof raw === 'object' ? raw : {}

  const providers = Array.isArray(cfg.providers)
    ? cfg.providers.filter((p) => p && typeof p === 'object').map(normalizeProvider)
    : base.providers

  const rules = Array.isArray(cfg.rules)
    ? cfg.rules.filter((r) => r && typeof r === 'object').map((r) => {
        const known = MATCH_KINDS.includes(r.match ?? 'subagent')
        return {
          id: typeof r.id === 'string' && r.id ? r.id : newId('r'),
          // 認不得的 match（例如已經拿掉的 any / nested）整條關掉，不悄悄換成範圍不同的 subagent
          enabled: r.enabled !== false && known,
          match: known ? (r.match ?? 'subagent') : 'subagent',
          modelGlob: String(r.modelGlob ?? '*').trim() || '*',
          providerId: String(r.providerId ?? '').trim(),
          modelOverride: String(r.modelOverride ?? '').trim(),
        }
      })
    : base.rules

  return {
    proxyPort: asPort(cfg.proxyPort, base.proxyPort),
    adminPort: asPort(cfg.adminPort, base.adminPort),
    // 只認 true：手改成 "yes"、1 之類的值一律當成沒開，不讓一個打錯的值悄悄打開 MITM
    httpsProxy: cfg.httpsProxy === true,
    providers,
    rules,
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
 * 收到瀏覽器的 provider：把 KEEP_SECRET 還原成現存的 key（規則見 restoreMaskedKey）。
 *
 * 存檔與測試都已經先被 providerProblem 擋過，走到這裡還還原不了的只剩規則預覽，
 * 它用不到 key，所以給空字串就好。
 */
export function fromClientProvider(p, current) {
  return normalizeProvider(p.apiKey === KEEP_SECRET ? { ...p, apiKey: restoreMaskedKey(p, current) ?? '' } : p)
}

export function fromClientConfig(incoming, current) {
  const providers = Array.isArray(incoming.providers) ? incoming.providers.filter((p) => p && typeof p === 'object') : []
  return normalizeConfig({ ...incoming, providers: providers.map((p) => fromClientProvider(p, current)) })
}
