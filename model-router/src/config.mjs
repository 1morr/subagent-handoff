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
    /** provider 的 id，或 PASSTHROUGH_ID＝導回訂閱。 */
    providerId: '',
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
    /** 沒有規則命中時的去向。不帶憑證，原樣轉發 Claude Code 的訂閱 OAuth。 */
    passthrough: { baseUrl: 'https://api.anthropic.com' },
    providers: [kimi],
    rules: [defaultRule({ id: 'r-subagent', match: 'subagent', providerId: 'kimi' })],
  }
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
          providerId: String(r.providerId ?? '').trim(),
        }),
      )
    : base.rules

  return {
    proxyPort: asPort(cfg.proxyPort, base.proxyPort),
    adminPort: asPort(cfg.adminPort, base.adminPort),
    passthrough: {
      baseUrl: trimSlash(cfg.passthrough?.baseUrl) || base.passthrough.baseUrl,
    },
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
