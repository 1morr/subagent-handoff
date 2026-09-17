/*
 * subagent-handoff GUI 邏輯。這是個 SPA，不是一個頁面：狀態物件 S、渲染函式、
 * 對 /api/* 的 fetch 呼叫全部在這裡。零建置、零外部依賴、原生 ES module。
 *
 * 這個檔案是從 index.html 內嵌的 <script type="module"> 拆出來的（原本 77KB 單檔太肥），
 * 拆分那一次沒有改動任何一行邏輯。頂層 await（檔案最後三行）能用是因為這是
 * `<script type="module">` 載入的外部檔案，module 本來就支援頂層 await。
 *
 * i18n：兩份語系目錄（src/ui/i18n/en.js、zh-Hant.js）各自匯出一個扁平的 key → 字串
 * map，t(key, vars) 查表＋簡單插值（`{name}`）。預設英文；navigator.language 以 zh
 * 開頭就切繁中；使用者用畫面上的語言選單覆寫，存進 localStorage，重整後仍記得。
 * 沒有任何 build step 介入 —— 這兩份目錄就是普通的 ES module，被 app.js 用相對路徑
 * 靜態 import，admin.mjs 當一般靜態檔案吐出去。
 */
import en from './i18n/en.js'
import zhHant from './i18n/zh-Hant.js'

const CATALOGS = { en, 'zh-Hant': zhHant }
const LANG_KEY = 'subagent-handoff:lang'
const KEEP = '__keep__'
// 這兩個是流量記錄裡 target 欄位在走 passthrough／完全沒送出時的固定值，
// 必須跟 src/routing.mjs 的 PASSTHROUGH_LABEL／NOT_SENT_LABEL 一字不差 ——
// 兩邊各自拿它們當比對／儲存用的穩定英文代碼，顯示時才轉成當前語言的文字，
// 這樣資料本身不綁死某一種語言。
const PASSTHROUGH_TARGET = 'passthrough (subscription)'
const NOT_SENT_TARGET = 'not sent'

function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved === 'en' || saved === 'zh-Hant') return saved
  } catch {}
  return String(navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh-Hant' : 'en'
}

let lang = detectLang()

/** 查表＋插值。目前語系沒有這個 key 就退回英文，兩邊都沒有就把 key 原樣印出來（方便抓漏）。 */
function t(key, vars) {
  let s = CATALOGS[lang]?.[key] ?? CATALOGS.en[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

const S = {
  config: null, runtime: null, dirty: false, tab: 'bay',
  tests: {}, busy: {}, logs: [], open: null,
  logFilter: 'all',
  // 預覽的輸入也放 state，否則每次預覽完重繪都會被模板的預設值蓋回去
  preview: null, pvKind: 'subagent', pvModel: 'claude-opus-5', pvAgent: '',
  // 「交還給訂閱」的還原點：記下被改掉的規則原本指向哪裡
  flipBackup: null,
}
let logTimer = null
// 見過的進條 id。只有真的新到的那幾張會播「印進機架」，閒置時整面是死的。
const SEEN = new Set()

const $ = (sel) => document.querySelector(sel)

// 圖示一律畫出來，同一套 1.6 描邊、12px 網格 —— ＋ ↑ ✕ ⚠ 這些字元不是圖示系統
const ICON = {
  plus: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/></svg>',
  up:   '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/></svg>',
  down: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/></svg>',
  del:  '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/></svg>',
  warn: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5 11 10.5H1z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 5v2.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="square"/><circle cx="6" cy="9" r=".7" fill="currentColor"/></svg>',
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

let toastTimer = null
/** 取代 alert()：阻塞式對話框會卡住整個分頁，而這些訊息都不需要使用者回答。 */
function toast(message, kind = '') {
  const el = $('#toast')
  el.querySelector('span').textContent = message
  el.className = kind
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 4000)
}

function updateDirtyNote() {
  $('#dirty-note').textContent = S.dirty ? t('common.unsaved') : t('common.saved')
}

function markDirty() {
  S.dirty = true
  S.preview = null
  $('#save').disabled = false
  updateDirtyNote()
}

/** restart-note 含翻譯過的文字，語言切換時要單獨重繪一次，但不能連帶動到 S.dirty ——
 *  那是 applyState() 自己的事，語言切換不是存檔。 */
function renderRestartNote() {
  if (!S.runtime) return
  const reasons = (S.runtime.restartReasons ?? []).map((r) => t(`restart.reason.${r}`))
  $('#restart-note').innerHTML = S.runtime.restartRequired
    ? `<div class="marginal note"><i></i><div><strong>${
        t('restart.required', { reasons: esc(reasons.join(t('restart.listSep'))) || t('restart.reasonFallback') })
      }</strong> ${t('restart.note')}</div></div>`
    : ''
}

function applyState(payload) {
  S.config = payload.config
  S.preview = null
  S.runtime = payload.runtime
  S.dirty = false
  $('#save').disabled = true
  updateDirtyNote()
  $('#binding').textContent =
    `PROXY ${payload.runtime.boundProxyPort} · GUI ${payload.runtime.boundAdminPort} · ${payload.runtime.configPath}`
  renderRestartNote()
}

// ── headers 文字 ⇄ 物件 ────────────────────────────────────────────
function parseHeaders(text) {
  const out = {}
  for (const line of String(text).split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) {
      const name = line.slice(0, i).trim()
      if (name) out[name] = line.slice(i + 1).trim()
    }
  }
  return out
}
const formatHeaders = (obj) => Object.entries(obj ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')

// ── 進條的判讀 ────────────────────────────────────────────────────
// 這一組函式是整個重設計的核心：舊版把這些答案全塞在 title tooltip 裡，
// 鍵盤取不到、觸控取不到、選不起來也複製不了，README 得用整節教人該把滑鼠移到哪。

/** 這一筆停在哪個席位。null = 還沒送出去（被擋在 router 這關） */
function sectorOf(e) {
  if (e.providerId) return 'prv'
  if (e.target === PASSTHROUGH_TARGET) return 'sub'
  return null
}

const isAborted = (e) => !!e.error && /abort/i.test(e.error)
const effortStripped = (e) => !!e.effort && e.sentEffort !== e.effort

/** 進行中 / 順利 / 有事發生 / 被擋下。顏色不是唯一訊號 —— 每一級都有機架位置與印字旗標。 */
function stateOf(e) {
  if (e.error && !isAborted(e)) return 'hold'
  if (e.status >= 400) return 'hold'
  if (e.status == null && !e.error) return 'live'
  if (isAborted(e)) return 'chk'
  if (e.detail) return 'chk'                    // 200 但串流裡夾著 error 事件
  if (effortStripped(e)) return 'chk'
  if (e.pings) return 'chk'
  if (!e.cwd) return 'chk'
  return 'clr'
}
const FLAG = { clr: 'CLR', chk: 'CHK', hold: 'HOLD', live: '···' }

/** 流量記錄裡的 target 是穩定的英文代碼（passthrough／not sent 兩種）或 provider 自己的
 *  label；只有前者需要照語言翻譯，provider label 是使用者自己填的資料，原樣顯示。 */
function displayTarget(target) {
  if (target === PASSTHROUGH_TARGET) return t('rack.target.passthrough')
  if (target === NOT_SENT_TARGET) return t('rack.target.notSent')
  return target
}

/** anthropic-ratelimit-*-reset 可能是 unix 秒數也可能是 RFC3339，兩種都認，都不是就原樣顯示。 */
function resetLabel(raw) {
  const at = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw)
  if (!Number.isFinite(at)) return String(raw)
  const secs = Math.round((at - Date.now()) / 1000)
  return secs > 0 ? t('rack.resetsIn', { secs }) : t('rack.resetsAt', { time: new Date(at).toTimeString().slice(0, 8) })
}

/** 常駐在批註欄的一行摘要。航管的進條右側就是控制員寫字的地方。 */
function marginNote(e) {
  if (e.error && !isAborted(e)) return t('rack.note.fetchFailed', { error: e.error })
  if (isAborted(e)) return t('rack.note.aborted')
  if (e.status >= 400) {
    const reset = e.rateLimit?.['unified-reset']
    if (e.retryAfter) return t('rack.note.blockedRetryAfter', { secs: e.retryAfter })
    if (reset) return t('rack.note.blockedReset', { reset: resetLabel(reset) })
    return t('rack.note.blocked')
  }
  if (e.detail) return t('rack.note.streamError')
  if (effortStripped(e)) return t('rack.note.effortStripped')
  if (e.pings) return t('rack.note.pings', { pings: e.pings })
  if (!e.cwd && e.status != null) return e.sessionId ? t('rack.note.cwdUnknown') : t('rack.note.noSession')
  return ''
}

/** 攤開後印在條上的完整批註。 */
/** 回傳 [鍵, 值, 是否為失敗說明]。染紅只給第三項為 true 的行。 */
function annotation(e) {
  const rows = []
  if (e.detail) rows.push([t('rack.ann.upstreamSaid'), e.detail, true])
  if (e.error) rows.push([isAborted(e) ? t('rack.ann.aborted') : t('rack.ann.fetchFailed'), e.error, !isAborted(e)])
  rows.push([t('rack.ann.ruleHit'), e.ruleId
    ? `${e.ruleId} → ${displayTarget(e.target)}`
    : t('rack.ann.noRuleHit', { target: displayTarget(e.target ?? NOT_SENT_TARGET) })])
  if (e.retryAfter) rows.push(['retry-after', `${e.retryAfter}s`, true])
  if (e.rateLimit) {
    rows.push([t('rack.ann.rateLimited'), Object.entries(e.rateLimit).map(([k, v]) => `${k}=${v}`).join(' · '), true])
    if (!e.retryAfter) rows.push([t('rack.ann.countdown'), t('rack.ann.countdownValue')])
  }
  if (effortStripped(e)) {
    rows.push([t('rack.ann.silentDowngrade'), t('rack.ann.silentDowngradeValue', { effort: e.effort }), true])
    rows.push([t('rack.ann.fix'), t('rack.ann.fixValue')])
  }
  if (e.pings) rows.push(['keep-alive', t('rack.ann.keepAliveValue', { pings: e.pings })])
  if (e.usage) {
    const u = e.usage
    const prompt = u.input + u.cacheRead + u.cacheWrite
    rows.push([t('rack.ann.usage'), t('rack.ann.usageValue', {
      prompt, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, input: u.input, output: u.output,
    }) + (prompt ? t('rack.ann.usageHitRate', { pct: Math.round(u.cacheRead / prompt * 100) }) : '')])
  }
  if ((e.changes || []).length) rows.push([t('rack.ann.rewritten'), e.changes.join(' · ')])
  if (e.shape) {
    const s = e.shape
    rows.push([t('rack.ann.shape'), [
      s.messages != null ? t('rack.ann.shapeMessages', { n: s.messages }) : null,
      s.system ? t('rack.ann.hasSystem') : t('rack.ann.noSystem'),
      s.stream ? t('rack.ann.streaming') : t('rack.ann.nonStreaming'),
      s.maxTokens != null ? `max_tokens ${s.maxTokens}` : null,
    ].filter(Boolean).join(' · ')])
  }
  rows.push([t('rack.ann.dir'), e.cwd || t('rack.ann.dirUnknown')])
  rows.push(['session', e.sessionId || t('rack.ann.noSessionFull')])
  if (e.agentId) rows.push(['agent id', e.agentId])
  if (e.requestId) rows.push(['request-id', e.requestId])
  rows.push([t('rack.ann.time'), e.ts])
  return rows
}

/** 回傳已跳脫的 HTML —— 只有這裡會夾圖示，其餘欄位一律走 esc()。 */
function statusHtml(e) {
  if (e.error) return esc(e.error)
  if (e.status == null) return '…'
  let out = esc(String(e.status))
  if (e.status < 400 && e.detail) out += ' ' + ICON.warn
  return out
}

// ── 進條的繪製 ────────────────────────────────────────────────────
const COLS_BAY  = '46px 74px 92px 108px minmax(120px,1fr) 104px 68px 128px minmax(180px,1.4fr)'
const COLS_LOGS = '46px 74px 92px 108px 150px minmax(120px,1fr) 116px 68px 128px minmax(180px,1.4fr)'
const headBay = () => [t('rack.col.seat'), t('rack.col.time'), t('rack.col.source'), t('rack.col.dir'), t('rack.col.sentModel'), t('rack.col.status'), t('rack.col.duration'), t('rack.col.thinking'), t('rack.col.note')]
const headLogs = () => [t('rack.col.seat'), t('rack.col.time'), t('rack.col.source'), t('rack.col.dir'), t('rack.col.requestedModel'), t('rack.col.sentModel'), t('rack.col.status'), t('rack.col.duration'), t('rack.col.thinking'), t('rack.col.note')]

function shortCwd(cwd) {
  if (!cwd) return '–'
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd
}

function stripRow(e, withRequested) {
  const st = stateOf(e)
  const sec = sectorOf(e)
  const open = S.open === e.id
  const note = marginNote(e)
  const statusCls = st === 'hold' ? 'bad' : st === 'chk' ? 'warnink' : st === 'live' ? 'dimink' : 'okink'
  const cells = [
    `<span class="cell">${esc(e.ts.slice(11, 19))}</span>`,
    `<span class="cell">${esc(e.kind)}</span>`,
    `<span class="cell ${e.cwd ? '' : 'dimink'}">${esc(shortCwd(e.cwd))}</span>`,
    withRequested ? `<span class="cell">${esc(e.requestedModel ?? '–')}</span>` : '',
    `<span class="cell ${e.sentModel && e.sentModel !== e.requestedModel ? '' : 'dimink'}">${esc(e.sentModel ?? '–')}</span>`,
    `<span class="cell ${statusCls}">${statusHtml(e)}</span>`,
    `<span class="cell">${e.ms != null ? e.ms + 'ms' : '…'}</span>`,
    `<span class="cell ${effortStripped(e) ? 'bad' : 'dimink'}">${
      e.effort ? esc(effortStripped(e) ? t('rack.effortRemoved', { effort: e.effort }) : e.effort) : '–'}</span>`,
    `<span class="cell han ${st === 'hold' ? 'bad' : 'dimink'}">${esc(note)}</span>`,
  ].join('')

  const body = open ? `
    <div class="annot">
      <div class="gutter ${sec === 'prv' ? 'prv' : 'sub'}" style="background:${sec === 'prv' ? 'var(--prv)' : sec === 'sub' ? 'var(--sub)' : 'var(--rail-lit)'}"></div>
      <div class="body"><dl>${annotation(e).map(([k, v, bad]) =>
        `<dt>${esc(k)}</dt><dd${bad ? ' class="bad"' : ''}>${esc(v)}</dd>`).join('')}</dl></div>
    </div>` : ''

  return `
    <div class="slot ${st}${SEEN.size && !SEEN.has(e.id) ? ' fresh' : ''}" data-eid="${e.id}">
      <button class="strip" data-act="toggle-strip" aria-expanded="${open}">
        <span class="tab ${sec ?? ''}">
          <span class="code">${sec ? sec.toUpperCase() : '???'}</span>
          <span class="flag">${FLAG[st]}</span>
        </span>
        <span class="cells" style="grid-template-columns:${(withRequested ? COLS_LOGS : COLS_BAY).replace('46px ', '')}">${cells}</span>
      </button>
      ${body}
    </div>`
}

function rack(entries, withRequested) {
  const cols = withRequested ? COLS_LOGS : COLS_BAY
  const head = withRequested ? headLogs() : headBay()
  if (!entries.length) {
    return `<div class="panel"><div class="empty">${
      S.logs.length ? t('rack.emptyFiltered') : t('rack.emptyAll')}</div></div>`
  }
  return `
    <div class="rackhead" style="grid-template-columns:${cols}">
      ${head.map((h) => `<span class="lbl">${h}</span>`).join('')}
    </div>
    <div class="rack">${entries.map((e) => stripRow(e, withRequested)).join('')}</div>`
}

// ── 機架總覽 ──────────────────────────────────────────────────────
/** 分流數字全部從流量記錄現算，不需要另一支 API。 */
function overview() {
  const cutoff = Date.now() - 5 * 60 * 1000
  const win = S.logs.filter((e) => Date.parse(e.ts) >= cutoff)
  const sub = win.filter((e) => sectorOf(e) === 'sub')
  const prv = win.filter((e) => sectorOf(e) === 'prv')
  const routed = sub.length + prv.length
  const live = (list) => list.filter((e) => e.status == null && !e.error).length
  const subPct = routed ? Math.round(sub.length / routed * 100) : 0
  // 額度窗只有訂閱那條線會回 anthropic-ratelimit-*，取最近一筆有的
  const rl = S.logs.find((e) => sectorOf(e) === 'sub' && e.rateLimit)?.rateLimit ?? null
  const prvName = prv.find((e) => e.target)?.target
    ?? S.config.providers.find((p) => S.config.rules.some((r) => r.enabled && r.providerId === p.id))?.label
    ?? S.config.providers[0]?.label ?? t('bay.noProviderSet')
  // 兩張席位卡共用同一個上限，否則兩邊的柱高不能互相比較
  const subBuckets = buckets(sub)
  const prvBuckets = buckets(prv)
  const peak = Math.max(1, ...subBuckets, ...prvBuckets)
  return {
    win, routed, sub, prv, subPct, prvPct: routed ? 100 - subPct : 0,
    subLive: live(sub), prvLive: live(prv), rl, prvName,
    subBuckets, prvBuckets, peak,
    subCache: cacheStats(S.logs.filter((e) => sectorOf(e) === 'sub')),
    prvCache: cacheStats(S.logs.filter((e) => sectorOf(e) === 'prv')),
    blocked: win.filter((e) => stateOf(e) === 'hold').length,
  }
}

/**
 * 快取命中率 = 快取讀 ÷ 整個 prompt（未命中 + 快取寫 + 快取讀），token 加權，不是逐筆平均 ——
 * 一筆 3 萬 tokens 的子 agent 請求跟一筆 40 tokens 的標題請求不該同權。
 * 取記憶體裡這個席位的全部進條（最多 300 筆），不跟分流帶用同一個 5 分鐘窗：快取是看趨勢的數字，窗太短就只剩雜訊。
 */
function cacheStats(entries) {
  const measured = entries.filter((e) => e.usage)
  const sum = (key) => measured.reduce((n, e) => n + (e.usage[key] || 0), 0)
  const read = sum('cacheRead')
  const prompt = sum('input') + read + sum('cacheWrite')
  return { n: measured.length, read, prompt, rate: prompt ? read / prompt : null }
}
const tokenCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n))

/** 沿用「在途請求」那一格的形式。沒有用量資料時印 –，不印 0% —— 那會被讀成「快取全沒命中」。 */
function cacheCell(c) {
  return `
          <div class="fld" style="gap:2px">
            <span class="num" style="font-size:22px;line-height:1">${c.rate == null ? '–' : `${Math.round(c.rate * 100)}%`}</span>
            <span class="lbl">${t('bay.cacheHit')}</span>
            <span class="lbl" style="letter-spacing:.04em">${c.n
              ? t('bay.cacheSample', { count: c.n, read: tokenCount(c.read), prompt: tokenCount(c.prompt) })
              : t('bay.noStreamUsage')}</span>
          </div>`
}

/** 近 4 分鐘切成 8 個 30 秒桶。柱高就是那 30 秒的請求數 —— 高度承載資料，不是裝飾。 */
function buckets(list) {
  const now = Date.now(), span = 30000, n = 8
  const out = new Array(n).fill(0)
  for (const e of list) {
    const age = now - Date.parse(e.ts)
    if (age >= 0 && age < span * n) out[n - 1 - Math.floor(age / span)]++
  }
  return out
}
const loadCells = (b, max, cls) => b.map((v) =>
  `<i class="${v ? 'on ' + cls : ''}" style="height:${max ? Math.round(2 + v / max * 42) : 2}px"></i>`).join('')

function renderBay() {
  const o = overview()
  const toProvider = S.config.rules.some((r) => r.enabled && r.providerId && r.providerId !== 'passthrough')

  const rlBar = o.rl ? (() => {
    const rem = Number(o.rl['unified-remaining'])
    const lim = Number(o.rl['unified-limit'])
    const used = Number.isFinite(rem) && Number.isFinite(lim) && lim > 0
      ? Math.round((lim - rem) / lim * 100) : null
    const reset = o.rl['unified-reset']
    return `
      <div class="fld" style="align-items:flex-end">
        <span class="lbl">${t('bay.quotaWindowUsed')}</span>
        ${used == null ? '' : `<div class="meter"><i style="width:${used}%"></i></div>`}
        <span class="num" style="font-size:11px;color:var(--alarm)">${
          Number.isFinite(rem) && Number.isFinite(lim) ? `${lim - rem} / ${lim}` : t('bay.rateLimitReported')
        }${reset ? ` · ${esc(resetLabel(reset))}` : ''}</span>
      </div>`
  })() : `
      <div class="fld" style="align-items:flex-end">
        <span class="lbl">${t('bay.quotaWindow')}</span>
        <span class="hint">${t('bay.noRateLimitYet')}</span>
      </div>`

  // 0% 的段完全不畫 —— 留一條有 padding 的殘段會讀成「還有流量走那邊」
  const seg = (cls, pct, name, qty) => pct <= 0 ? '' : `
      <div class="${cls}" style="width:${pct}%">
        <span class="name">${name}</span>
        <span class="qty">${qty}</span>
      </div>`
  const band = o.routed ? `
    <div class="band">
      ${seg('seg-sub', o.subPct, t('bay.segSub'), t('bay.qtyPct', { count: o.sub.length, pct: o.subPct }))}
      ${seg('seg-prv', o.prvPct, `PRV ${esc(o.prvName)}`, t('bay.qtyPct', { count: o.prv.length, pct: o.prvPct }))}
    </div>`
    : `<div class="panel"><div class="empty">${t('bay.noTrafficBand')}</div></div>`

  return `
    <section class="fld" style="gap:9px">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <span class="lbl">${t('bay.recentSplit')}</span>
        <span>${t('bay.routedCount', { count: `<b class="num">${o.routed}</b>` })}</span>
        ${o.blocked ? `<span style="color:var(--alarm-ink)">${t('bay.blockedCount', { count: `<b class="num">${o.blocked}</b>` })}</span>` : ''}
        <span class="spacer"></span>
        <span class="hint">${t('bay.liveHint')}</span>
      </div>
      ${band}
    </section>

    <section class="sectors">
      <div class="sector s-sub"><div class="edge"></div><div class="in">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
          <span class="sign" style="font-size:15px;color:var(--sub)">SUB</span>
          <span style="font-weight:500">${t('bay.subSeat')}</span>
          <span class="spacer"></span>
          <span class="lbl">${toProvider ? t('common.mainConversation') : t('bay.mainPlusAllSubagents')}</span>
        </div>
        <div style="display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap">
          <div class="load" title="${t('bay.loadTitle')}">${loadCells(o.subBuckets, o.peak, 'sub')}</div>
          <div class="fld" style="gap:2px">
            <span class="num" style="font-size:22px;line-height:1">${o.subLive}</span>
            <span class="lbl">${t('bay.inFlight')}</span>
            <span class="lbl" style="letter-spacing:.04em">${t('bay.last4min', { count: o.sub.length })}</span>
          </div>
          ${cacheCell(o.subCache)}
          <span class="spacer"></span>
          ${rlBar}
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid var(--rail);padding-top:12px">
          <span class="hint" style="flex:1;min-width:200px"><code>${esc(S.config.passthrough.baseUrl)}</code> · ${t('bay.credentialsPassthrough')}</span>
        </div>
      </div></div>

      <div class="sector s-prv"><div class="edge"></div><div class="in">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
          <span class="sign" style="font-size:15px;color:var(--prv)">PRV</span>
          <span style="font-weight:500">${t('bay.thirdPartySeat', { name: esc(o.prvName) })}</span>
          <span class="spacer"></span>
          <span class="lbl">${toProvider ? t('common.allSubagents') : t('bay.noTrafficNow')}</span>
        </div>
        <div style="display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap">
          <div class="load" title="${t('bay.loadTitle')}">${loadCells(o.prvBuckets, o.peak, 'prv')}</div>
          <div class="fld" style="gap:2px">
            <span class="num" style="font-size:22px;line-height:1">${o.prvLive}</span>
            <span class="lbl">${t('bay.inFlight')}</span>
            <span class="lbl" style="letter-spacing:.04em">${t('bay.last4min', { count: o.prv.length })}</span>
          </div>
          ${cacheCell(o.prvCache)}
          <span class="spacer"></span>
          <div class="fld" style="align-items:flex-end">
            <span class="lbl">${t('bay.sentModelLabel')}</span>
            <span class="num" style="font-size:12px">${esc(
              S.config.providers.find((p) => p.label === o.prvName)?.model || t('bay.noRewrite'))}</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid var(--rail);padding-top:12px">
          <span class="hint" style="flex:1;min-width:200px">${
            S.config.providers.find((p) => p.label === o.prvName)?.baseUrl
              ? `<code>${esc(S.config.providers.find((p) => p.label === o.prvName).baseUrl)}</code>`
              : t('bay.noBaseUrl')}</span>
          ${S.flipBackup
            ? `<button class="btn go" data-act="unflip">${t('bay.unflip')}</button>`
            : `<button class="btn warn" data-act="flip" ${toProvider ? '' : 'disabled'}>${t('bay.flip')}</button>`}
        </div>
      </div></div>
    </section>

    <section class="fld" style="gap:9px">
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
        <span class="lbl">${t('bay.strips')}</span>
        <span class="hint">${t('bay.stripsHint')}</span>
        <span class="spacer"></span>
        <button class="btn" data-act="filter" data-key="all"
                aria-pressed="${S.logFilter === 'all'}">${t('common.filterAll')}</button>
        <button class="btn" data-act="filter" data-key="attn"
                aria-pressed="${S.logFilter === 'attn'}">${t('common.filterAttn')}</button>
      </div>
      ${flagLegend()}
      ${rack(filteredLogs().slice(0, 12), false)}
    </section>`
}

/** 圖例用的是機架上真正的夾條，不是另一組色票 —— 同一個顏色不能有兩個意思。 */
function flagLegend() {
  const sample = (st, sec, meaning) => `
    <div>
      <span class="slot ${st}" style="transform:none;box-shadow:none;display:inline-grid">
        <span class="tab ${sec}" style="padding:4px 7px"><span class="flag">${FLAG[st]}</span></span>
      </span>
      <span style="font-size:12px;color:#b6bcc5">${meaning}</span>
    </div>`
  return `
    <section class="legend">
      <span class="lbl" style="padding:9px 16px;border-right:1px solid var(--rail)">${t('legend.title')}</span>
      ${sample('clr', 'sub', t('legend.clr'))}
      ${sample('chk', 'prv', t('legend.chk'))}
      ${sample('hold', 'sub', t('legend.hold'))}
      <span class="spacer"></span>
      <span class="hint" style="padding:9px 16px">${t('legend.hint')}</span>
    </section>`
}

function filteredLogs() {
  const f = S.logFilter
  if (f === 'all') return S.logs
  if (f === 'attn') return S.logs.filter((e) => ['chk', 'hold'].includes(stateOf(e)))
  return S.logs.filter((e) => e.kind === f)
}

// ── Providers ─────────────────────────────────────────────────────
// probe.mjs 送回來的 label 是英文保底值；GUI 是雙語的，這裡改用穩定的 id 去 i18n
// 目錄查表，查不到（例如日後新增的測項）才退回伺服器給的 label。
const PROBE_LABEL_KEY = {
  connectivity: 'providers.testConnectivity', streaming: 'providers.testStreaming', tools: 'providers.testTools',
  toolLoop: 'providers.testToolLoop', effort: 'providers.testEffort', systemMessages: 'providers.testSystemMessages',
  vision: 'providers.testVision', pdf: 'providers.testPdf', webSearch: 'providers.testWebSearch', config: 'providers.testConfig',
}
const probeLabel = (r) => (PROBE_LABEL_KEY[r.id] && t(PROBE_LABEL_KEY[r.id]) !== PROBE_LABEL_KEY[r.id]) ? t(PROBE_LABEL_KEY[r.id]) : r.label

function probeRow(r) {
  // 必要項目沒過＝被擋下（整圈告警框）；能力項目沒過＝跑得起來但出了事，推出機架、不發告警色。
  // 兩種都印 FAIL，差別在位置與框 —— 把「看不到 PDF」畫得跟「連不上」一樣響就是在誇大。
  // 沒有 tier 的（設定錯誤、連 admin 都打不到）一律當必要看待
  const required = r.tier !== 'capability'
  const cls = r.ok ? 'clr' : required ? 'hold' : 'chk'
  const tabStyle = r.ok ? 'background:var(--sub)' : required ? 'background:var(--alarm)' : ''
  return `
    <div class="slot ${cls}">
      <div class="strip" style="cursor:default">
        <span class="tab" style="${tabStyle}">
          <span class="code">${r.ok ? 'PASS' : 'FAIL'}</span>
        </span>
        <span style="padding:9px 12px;display:flex;flex-direction:column;gap:4px;min-width:0">
          <span style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap">
            <span style="font-weight:700;color:var(--ink);font-size:12.5px">${esc(probeLabel(r))}</span>
            <span style="font:11px var(--han);color:var(--ink-dim)">${required ? t('providers.tierRequired') : t('providers.tierCapability')}</span>
            ${r.ms != null ? `<span class="num" style="font-size:11px;color:var(--ink-dim)">${r.ms}ms</span>` : ''}
          </span>
          ${r.detail ? `<span class="num" style="font-size:11px;color:var(--ink-dim);word-break:break-word">${esc(r.detail)}</span>` : ''}
          ${r.error ? `<span style="font:11px/1.55 var(--han);color:#8f2c18;word-break:break-word">${esc(r.error)}</span>` : ''}
        </span>
      </div>
    </div>`
}

/** 測試結果底下那一行結論。回傳 HTML：測項名稱已過 esc()，字串本身帶 <strong> 之類的標記。 */
function probeSummary(results) {
  // 只單獨跑過 WebSearch 時，還不能對整個 provider 下結論
  if (!results.some((r) => r.tier !== 'capability')) return t('providers.notTested')
  const names = (list) => list.map((r) => esc(probeLabel(r))).join(t('providers.listSep'))
  const blocked = results.filter((r) => !r.ok && r.tier !== 'capability')
  const degraded = results.filter((r) => !r.ok && r.tier === 'capability')
  if (blocked.length) return t('providers.requiredFailed', { names: names(blocked) })
  if (degraded.length) return t('providers.capabilityFailed', { names: names(degraded) })
  return t('providers.allPass')
}

function providerCard(p) {
  const t2 = S.tests[p.id]
  const busy = S.busy[p.id]
  const dropsEffort = (p.dropFields || []).includes('output_config')
  return `
  <section class="panel" data-pid="${esc(p.id)}">
    <div class="panel-head" style="background:var(--prv);border-bottom:0">
      <span class="sign" style="font-size:15px;color:#17130a">PRV</span>
      <span style="font-weight:700;color:#17130a;font-size:14px">${esc(p.label)}</span>
      <span class="num" style="font-size:11px;color:rgba(23,19,10,.66)">provider id: ${esc(p.id)}</span>
      <span class="spacer"></span>
      <button class="btn tiny" style="color:#17130a;border-color:rgba(23,19,10,.4)" data-act="del-provider">${t('providers.deleteSeat')}</button>
    </div>

    <div class="panel-body grid">
      <label class="fld"><span class="lbl">${t('common.name')}</span>
        <input type="text" data-f="label" value="${esc(p.label)}" style="font-family:var(--han)">
      </label>
      <label class="fld"><span class="lbl">${t('providers.modelLabel')}</span>
        <input type="text" data-f="model" value="${esc(p.model)}" placeholder="kimi-k3">
      </label>
      <label class="fld wide"><span class="lbl">${t('providers.baseUrlLabel')}</span>
        <input type="text" data-f="baseUrl" value="${esc(p.baseUrl)}" placeholder="https://api.moonshot.ai/anthropic">
        <span class="hint">${t('providers.baseUrlHint')}${
          /\/v1$/.test(p.baseUrl)
            ? ` <strong style="color:var(--alarm)">${t('providers.trailingV1Warning')}</strong>`
            : ''}</span>
      </label>
      <label class="fld wide"><span class="lbl">API Key</span>
        <input type="password" data-f="apiKey" value="${p.apiKey === KEEP ? KEEP : ''}"
               placeholder="${p.apiKeyHint ? esc(t('providers.apiKeyCurrentHint', { hint: p.apiKeyHint })) : t('providers.apiKeyNotSet')}">
        <span class="hint">${t('providers.apiKeyStorageHint')}</span>
      </label>
      <label class="fld"><span class="lbl">${t('providers.authHeaderLabel')}</span>
        <select data-f="authStyle">
          <option value="bearer" ${p.authStyle === 'bearer' ? 'selected' : ''}>Authorization: Bearer</option>
          <option value="x-api-key" ${p.authStyle === 'x-api-key' ? 'selected' : ''}>x-api-key</option>
        </select>
      </label>
      <label class="fld"><span class="lbl">${t('providers.maxTokensLabel')}</span>
        <input type="number" min="1" data-f="maxOutputTokens" value="${p.maxOutputTokens ?? ''}">
      </label>

      <div class="fld wide">
        <label class="fld"><span class="lbl" ${dropsEffort ? 'style="color:var(--alarm)"' : ''}>${t('providers.dropFieldsLabel')}</span>
          <input type="text" data-f="dropFields" value="${esc((p.dropFields || []).join(', '))}" placeholder="${t('common.blankMeansForwardAsIs')}">
        </label>
        <div class="marginal ${dropsEffort ? 'alarm' : ''}" style="margin-top:5px"><i></i><div>${
          dropsEffort ? t('providers.dropsEffortWarning') : t('providers.dropFieldsGuidance')
        }</div></div>
      </div>

      <label class="fld wide"><span class="lbl">${t('providers.extraHeadersLabel')}</span>
        <textarea data-f="extraHeaders" placeholder="X-Tenant: acme">${esc(formatHeaders(p.extraHeaders))}</textarea>
      </label>
      <div class="fld wide">
        <label class="check"><input type="checkbox" data-f="dropBeta" ${p.dropBeta ? 'checked' : ''}> ${t('providers.dropBetaLabel')}</label>
        <span class="hint">${t('providers.dropBetaHint')}</span>
      </div>
    </div>

    <div class="panel-body" style="border-top:1px solid var(--rail);display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
        <label class="fld" style="flex:1;min-width:200px"><span class="lbl">${t('providers.testModelLabel')}</span>
          <input type="text" data-f="testModel" value="${esc(t2?.model ?? '')}">
        </label>
        <button class="btn go" data-act="test" ${busy ? 'disabled' : ''}>${busy ? t('common.testing') : t('providers.runTest')}</button>
        <button class="btn" data-act="test-websearch" ${busy ? 'disabled' : ''}>${t('providers.runWebSearchTest')}</button>
      </div>
      <span class="hint">${t('providers.webSearchHint')}</span>
      ${t2?.results?.length ? `<div class="rack" style="padding:3px 26px 3px 3px">${t2.results.map(probeRow).join('')}</div>` : ''}
      <span class="hint">${t2?.results?.length ? probeSummary(t2.results) : t('providers.notTested')}</span>
    </div>
  </section>`
}

function renderProviders() {
  return `
    <div class="marginal"><i></i><div>
      ${t('providers.intro')}
    </div></div>
    ${S.config.providers.map(providerCard).join('') || `<div class="panel"><div class="empty">${t('providers.empty')}</div></div>`}
    <div><button class="btn" data-act="add-provider">${ICON.plus} ${t('providers.addProvider')}</button></div>`
}

// ── 路由規則 ───────────────────────────────────────────────────────
const MATCH_LABELS = () => ({
  any: t('rules.match.any'),
  main: t('rules.match.main'),
  subagent: t('rules.match.subagent'),
  nested: t('rules.match.nested'),
})

const KIND_LABELS = () => ({
  main: t('rules.kind.main'),
  subagent: t('rules.kind.subagent'),
  nested: t('rules.kind.nested'),
})

function renderRules() {
  const targetOpts = (sel) => `
    <option value="" ${sel ? '' : 'selected'}>${t('rules.pickTarget')}</option>
    <option value="passthrough" ${sel === 'passthrough' ? 'selected' : ''}>${t('bay.segSub')}</option>
    ${S.config.providers.map((p) =>
      `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>PRV ${esc(p.label)}</option>`).join('')}`

  // 機架上的 HIT / SHDW 是「跑過一次預覽」的結果，不是規則自身的狀態 —— 沒預覽過就一條都不標，
  // 否則一進來就看到第一條被點亮、其餘壓暗，會讀成「下面那幾條不會生效」。
  // 命中哪一條交給後端的預覽端點（跟真正轉發同一份 resolveRoute），前端不另寫一份比對邏輯。
  const sim = S.preview
  const hitAt = sim ? S.config.rules.findIndex((r) => r.id === sim.ruleId) : -1
  // 一條都沒命中，這一筆就是落在底板上 —— 那時候被標起來的是底板
  const baseHit = !!sim && hitAt < 0

  const matchLabels = MATCH_LABELS()
  const kindLabels = KIND_LABELS()
  const rows = S.config.rules.map((r, i) => {
    const isHit = i === hitAt
    const shadowed = hitAt >= 0 && i > hitAt
    const toPrv = r.providerId && r.providerId !== 'passthrough'
    return `
    <div class="clearance ${isHit ? 'hit' : ''} ${shadowed ? 'shadowed' : ''}" data-rid="${esc(r.id)}">
      <div class="ord">
        <b>${i + 1}</b>
        <span>${!r.enabled ? 'OFF' : isHit ? 'HIT' : shadowed ? 'SHDW' : sim ? 'PASS' : 'ON'}</span>
      </div>
      <div class="say">
        <div class="line">
          <label class="check" title="${t('rules.enabledTitle')}"><input type="checkbox" data-f="enabled" ${r.enabled ? 'checked' : ''}></label>
          <select data-f="match">${Object.entries(matchLabels)
            .map(([k, v]) => `<option value="${k}" ${r.match === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <span class="word">${t('rules.wordModel')}</span>
          <input type="text" class="w-sm" data-f="modelGlob" value="${esc(r.modelGlob)}" title="${t('rules.modelGlobTitle')}">
          <span class="word">${t('rules.wordAgent')}</span>
          <input type="text" class="w-sm" data-f="agentIdGlob" value="${esc(r.agentIdGlob ?? '*')}"
                 title="${t('rules.agentGlobTitle')}">
          <svg class="arrow" width="20" height="12" viewBox="0 0 20 12" fill="none" aria-hidden="true">
            <path d="M0 6h16M12 2l4 4-4 4" stroke="rgba(26,30,36,.45)" stroke-width="1.4" stroke-linecap="square"/>
          </svg>
          <select class="target ${toPrv ? 'prv' : 'sub'}" data-f="providerId">${targetOpts(r.providerId)}</select>
          <span class="word">${t('rules.wordSentAs')}</span>
          <input type="text" class="w-md" data-f="modelOverride" list="model-hints"
                 value="${esc(r.modelOverride ?? '')}" placeholder="${t('rules.noRewritePlaceholder')}">
          <span class="spacer"></span>
          <button class="btn tiny" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="${t('common.moveUp')}">${ICON.up}</button>
          <button class="btn tiny" data-act="down" ${i === S.config.rules.length - 1 ? 'disabled' : ''} aria-label="${t('common.moveDown')}">${ICON.down}</button>
          <button class="btn tiny danger" data-act="del-rule" aria-label="${t('rules.deleteRule')}">${ICON.del}</button>
        </div>
        ${isHit ? `<div class="reads">${t('rules.hitExplain')}</div>` : ''}
      </div>
    </div>`
  }).join('')

  const pv = S.preview
  return `
    <section class="fld" style="gap:12px">
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
        <span class="lbl">${t('rules.order')}</span>
        <span class="hint">${!sim ? t('rules.orderHint')
          : baseHit ? t('rules.orderHintFloor')
          : t('rules.orderHintHit')}</span>
        <span class="spacer"></span>
        ${sim ? `
        <span style="font:600 11px var(--han);color:var(--on-bay);border:1px solid var(--rail-lit);padding:3px 7px">${t('rules.simulating')}</span>
        <span class="hint">${[
          esc(kindLabels[sim.kind] ?? sim.kind),
          `<code>${esc(sim.requestedModel)}</code>`,
          sim.agentId ? `<code>${esc(sim.agentId)}</code>` : '',
        ].filter(Boolean).join(t('rules.conditionSep'))}</span>
        <button class="btn tiny" data-act="clear-preview">${t('rules.clearPreview')}</button>` : ''}
        <button class="btn" data-act="add-rule">${ICON.plus} ${t('rules.addRule')}</button>
      </div>
      <div class="rack" style="padding:4px 20px 4px 4px">
        ${rows || `<div class="empty">${t('rules.empty')}</div>`}
        <div class="clearance ${baseHit ? 'hit' : ''}" style="opacity:${hitAt < 0 ? 1 : .4}">
          <div class="ord" style="background:${baseHit ? 'var(--sub)' : 'var(--rail)'}">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 11h12M8 2v7M5 6l3 3 3-3" stroke="${baseHit ? '#10161a' : 'var(--on-bay-dim)'}"
                    stroke-width="1.4" stroke-linecap="square"/>
            </svg>
          </div>
          <div style="background:#20262e;border:1px dashed var(--rail-lit);border-left:0;display:flex;
                      align-items:center;gap:10px;padding:11px;flex-wrap:wrap">
            <span class="sign" style="font-size:12px;color:var(--sub)">SUB passthrough</span>
            <span class="hint">${t('rules.floorHint', { baseUrl: esc(S.config.passthrough.baseUrl) })}</span>
            <span class="spacer"></span>
            <span class="lbl">${t('rules.floorLabel')}</span>
          </div>
        </div>
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">
        <div class="marginal"><i></i><div>${t('rules.tip.quota')}</div></div>
        <div class="marginal"><i></i><div>${t('rules.tip.disable')}</div></div>
        <div class="marginal"><i></i><div>${t('rules.tip.ultracode')}</div></div>
        <div class="marginal"><i></i><div>${t('rules.tip.agentMatch')}</div></div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><span class="lbl">${t('rules.previewTitle')}</span><span class="hint">${
        pv ? t('rules.previewHintDone') : t('rules.previewHint')}</span></div>
      <div class="panel-body" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
        <label class="fld"><span class="lbl">${t('rules.requestSource')}</span>
          <select id="pv-kind">${Object.entries(kindLabels)
            .map(([k, v]) => `<option value="${k}" ${S.pvKind === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </label>
        <label class="fld" style="flex:1;min-width:180px"><span class="lbl">${t('rules.requestedModelLabel')}</span>
          <input type="text" id="pv-model" list="model-hints" value="${esc(S.pvModel)}">
        </label>
        <label class="fld" style="flex:1;min-width:150px"><span class="lbl">${t('rules.agentIdLabel')}</span>
          <input type="text" id="pv-agent" value="${esc(S.pvAgent)}" placeholder="Explore-1">
        </label>
        <button class="btn go" data-act="preview">${t('common.preview')}</button>
      </div>
      ${pv ? `
      <div class="panel-body" style="border-top:1px solid var(--rail)">
        <div class="slot"><div class="strip" style="cursor:default">
          <span class="tab ${pv.providerId ? 'prv' : 'sub'}"><span class="code">${pv.providerId ? 'PRV' : 'SUB'}</span></span>
          <span class="body" style="padding:10px 13px">
            <dl style="margin:0;display:grid;grid-template-columns:80px 1fr;gap:3px 10px">
              <dt class="lbl" style="color:#8f8878">${t('rules.result.classifiedAs')}</dt><dd style="margin:0;font:11.5px var(--data);color:#3c4149">${
                esc(kindLabels[pv.kind] ?? pv.kind)}</dd>
              <dt class="lbl" style="color:#8f8878">${t('rules.result.target')}</dt><dd style="margin:0;font:11.5px var(--data);color:var(--ink)">${esc(displayTarget(pv.target))}</dd>
              <dt class="lbl" style="color:#8f8878">${t('rack.col.sentModel')}</dt><dd style="margin:0;font:11.5px var(--data);color:var(--ink)">${
                pv.requestedModel === pv.sentModel ? esc(pv.sentModel) : `${esc(pv.requestedModel)} → ${esc(pv.sentModel)}`}</dd>
              <dt class="lbl" style="color:#8f8878">${t('rules.result.matched')}</dt><dd style="margin:0;font:11.5px var(--data);color:#3c4149">${
                pv.ruleId ? esc(pv.ruleId) : t('rules.result.noMatch')}</dd>
            </dl>
          </span>
        </div></div>
      </div>` : ''}
    </section>`
}

// ── 流量記錄 ───────────────────────────────────────────────────────
function renderLogs() {
  const filters = [['all', t('common.filterAll')], ['attn', t('common.filterAttn')], ['main', t('rules.kind.main')], ['subagent', t('rules.kind.subagent')], ['nested', t('logs.filterNested')]]
  const list = filteredLogs()
  const worst = S.logs.find((e) => stateOf(e) === 'hold')

  return `
    ${worst ? `
    <section class="marginal alarm"><i></i><div style="display:flex;flex-direction:column;gap:11px">
      <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">
        <span class="disp" style="font-size:24px;color:#f0d5cd;line-height:1.2">${
          worst.error ? t('logs.lastFetchFailed') : t('logs.lastBlocked')}</span>
        <span class="num" style="font-size:11px">${esc(worst.ts.slice(11, 19))}</span>
        <span class="num" style="font-size:14px;color:var(--alarm-ink)">${esc(worst.error || worst.status)}</span>
        <span style="font-size:12.5px">${esc(sectorOf(worst) === 'sub' ? t('common.subLine') : t('common.prvLine'))}・${
          worst.error ? t('logs.clientGot502') : t('common.routerRelayed')}</span>
      </div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;border-top:1px solid #4a2a24;padding-top:11px">
        ${[
          ['429 / 5xx', t('common.blockedByUpstream')],
          ['fetch failed', t('rack.ann.fetchFailed')],
          ['client aborted', t('common.claudeBackedOff')],
          [t('logs.notThere'), t('logs.neverArrived')],
        ].map(([k, v]) => `<div class="fld" style="gap:2px">
          <span class="lbl" style="color:#8a6c64">${esc(k)}</span>
          <span class="num" style="font-size:11.5px;color:#e4cdc6">${esc(v)}</span>
        </div>`).join('')}
      </div>
    </div></section>` : ''}

    ${flagLegend()}

    <section class="fld" style="gap:9px">
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
        <span class="lbl">${t('logs.rackTitle')}</span>
        <span>${t('bay.routedCount', { count: `<b class="num">${list.length}</b>` })}</span>
        <span class="hint">${t('logs.pollHint')}</span>
        <span class="spacer"></span>
        ${filters.map(([k, v]) =>
          `<button class="btn" data-act="filter" data-key="${k}" aria-pressed="${S.logFilter === k}">${v}</button>`).join('')}
        <button class="btn danger" data-act="clear-logs">${t('logs.clear')}</button>
      </div>
      ${rack(list, true)}
    </section>`
}

// ── 進階 ───────────────────────────────────────────────────────────
function renderAdvanced() {
  const trafficLog = S.config.trafficLog
  return `
    <div class="marginal"><i></i><div>
      ${t('advanced.intro')}
    </div></div>

    <section class="panel">
      <div class="panel-head"><span class="lbl">${t('advanced.passthroughTitle')}</span></div>
      <div class="panel-body grid">
        <label class="fld wide"><span class="lbl">Base URL</span>
          <input type="text" id="pt-base" value="${esc(S.config.passthrough.baseUrl)}">
          <span class="hint">${t('advanced.passthroughHint')}</span>
        </label>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><span class="lbl">${t('advanced.trafficLogTitle')}</span>
        <span class="lbl" style="border:1px solid var(--prv);color:var(--prv);padding:2px 7px">${t('common.restartRequiredBadge')}</span></div>
      <div class="panel-body grid">
        <label class="fld wide"><span class="lbl">${t('advanced.trafficLogFileLabel')}</span>
          <input type="text" data-g="trafficLog.file" value="${esc(trafficLog.file)}" placeholder="traffic.log">
          <span class="hint">${t('advanced.trafficLogFileHint')}</span>
        </label>
        <label class="fld"><span class="lbl">${t('advanced.maxBytesLabel')}</span>
          <input type="number" min="10000" data-g="trafficLog.maxBytes" value="${trafficLog.maxBytes}">
          <span class="hint">${t('advanced.maxBytesHint')}</span>
        </label>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><span class="lbl">${t('advanced.requestLimitTitle')}</span></div>
      <div class="panel-body">
        <label class="fld" style="max-width:320px"><span class="lbl">${t('advanced.maxRequestBytesLabel')}</span>
          <input type="number" min="1000000" data-g="maxRequestBytes" value="${S.config.maxRequestBytes}">
          <span class="hint">${t('advanced.maxRequestBytesHint')}</span>
        </label>
      </div>
    </section>`
}

// ── 接入說明 ───────────────────────────────────────────────────────
function renderSetup() {
  const port = S.runtime.boundProxyPort
  return `
    <section class="panel">
      <div class="panel-head"><span class="lbl">${t('setup.step1Title')}</span></div>
      <div class="panel-body" style="display:flex;flex-direction:column;gap:12px">
        <p style="margin:0">${t('setup.step1Body')}</p>
        <pre id="snippet">{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:${port}",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0"
  }
}</pre>
        <div><button class="btn" data-act="copy">${t('common.copy')}</button></div>
        <div class="marginal alarm"><i></i><div>
          ${t('setup.warnCreds')}
        </div></div>
        <span class="hint">
          ${t('setup.attributionHint')}
        </span>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><span class="lbl">${t('setup.step2Title')}</span></div>
      <div class="panel-body">
        <p style="margin:0 0 8px">${t('setup.step2Body')}</p>
        <ul style="margin:0 0 8px;padding-left:20px;line-height:1.8">
          <li>${t('setup.step2Item1', { port })}</li>
          <li>${t('setup.step2Item2')}</li>
        </ul>
        <p style="margin:0">${t('setup.step2Note')}</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><span class="lbl">${t('setup.step3Title')}</span></div>
      <div class="panel-body">
        <p style="margin:0">${t('setup.step3Body')}</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><span class="lbl">${t('setup.limitsTitle')}</span></div>
      <div class="panel-body">
        <ul style="margin:0;padding-left:20px;line-height:1.8">
          <li>${t('setup.limit1')}</li>
          <li>${t('setup.limit2')}</li>
          <li>${t('setup.limit3')}</li>
          <li>${t('setup.limit4')}</li>
          <li>${t('setup.limit5')}</li>
        </ul>
      </div>
    </section>`
}

// ── render / 事件 ─────────────────────────────────────────────────
const VIEWS = { bay: renderBay, providers: renderProviders, rules: renderRules, logs: renderLogs, advanced: renderAdvanced, setup: renderSetup }

/** 導覽列、儲存按鈕、語言選單這些不隨分頁重繪的靜態外殼，語言切換時要單獨刷新一次。 */
function applyStaticI18n() {
  document.documentElement.lang = lang
  document.querySelectorAll('nav button').forEach((b) => { b.textContent = t(`nav.${b.dataset.tab}`) })
  $('#save').textContent = t('common.save')
  updateDirtyNote()
  const langLabel = document.querySelector('label[for="lang"]')
  if (langLabel) langLabel.textContent = t('common.langLabel')
  const sel = $('#lang')
  if (sel) sel.value = lang
}

function render() {
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)))
  const view = $('#view')
  if (!S.config) { view.innerHTML = `<div class="panel"><div class="empty">${t('common.loading')}</div></div>`; return }
  view.innerHTML = VIEWS[S.tab]()
}

function setLang(next) {
  if (next !== 'en' && next !== 'zh-Hant') return
  lang = next
  try { localStorage.setItem(LANG_KEY, lang) } catch {}
  applyStaticI18n()
  renderRestartNote()
  render()
}

$('#lang')?.addEventListener('change', (ev) => setLang(ev.target.value))

// 輸入時只更新 state，不重繪，避免游標跳走
document.addEventListener('input', (ev) => {
  const el = ev.target

  if (el.id === 'pt-base') { S.config.passthrough.baseUrl = el.value; markDirty(); return }

  // 進階分頁的全域設定：data-g="<群組>.<欄位>"，沒有點就是頂層欄位
  const g = el.dataset.g
  if (g) {
    const [group, key] = g.split('.')
    const target = key ? S.config[group] : S.config
    const name = key ?? group
    if (el.type === 'checkbox') target[name] = el.checked
    else if (el.type === 'number') target[name] = el.value === '' ? 0 : Number(el.value)
    else target[name] = el.value
    markDirty()
    return
  }

  const f = el.dataset.f
  if (!f) return

  const card = el.closest('[data-pid]')
  const row = el.closest('[data-rid]')

  if (card) {
    if (f === 'testModel') { (S.tests[card.dataset.pid] ??= {}).model = el.value; return }
    const p = S.config.providers.find((x) => x.id === card.dataset.pid)
    if (!p) return
    if (f === 'dropFields') p.dropFields = el.value.split(',').map((s) => s.trim()).filter(Boolean)
    else if (f === 'extraHeaders') p.extraHeaders = parseHeaders(el.value)
    else if (f === 'maxOutputTokens') p.maxOutputTokens = el.value ? Number(el.value) : null
    else if (el.type === 'checkbox') p[f] = el.checked
    else p[f] = el.value
    markDirty()
  } else if (row) {
    const r = S.config.rules.find((x) => x.id === row.dataset.rid)
    if (!r) return
    r[f] = el.type === 'checkbox' ? el.checked : el.value
    markDirty()
  }
})

// 導向、啟用、比對條件改了要重繪：markDirty 已經把模擬收掉，機架上的標記要跟著清乾淨
document.addEventListener('change', (ev) => {
  const f = ev.target.dataset.f
  if (!f || !ev.target.closest('[data-rid]')) return
  if (['providerId', 'enabled', 'match'].includes(f)) render()
})

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button')
  if (!btn) return

  if (btn.dataset.tab) {
    S.tab = btn.dataset.tab
    render()
    if (S.tab === 'logs' || S.tab === 'bay') startLogPolling(); else stopLogPolling()
    return
  }

  const act = btn.dataset.act
  if (!act) return
  const pid = btn.closest('[data-pid]')?.dataset.pid
  const rid = btn.closest('[data-rid]')?.dataset.rid
  const eid = btn.closest('[data-eid]')?.dataset.eid

  try {
    if (act === 'toggle-strip') {
      S.open = S.open === Number(eid) ? null : Number(eid)
      render()
    } else if (act === 'filter') {
      S.logFilter = btn.dataset.key
      render()
    } else if (act === 'add-provider') {
      S.config.providers.push({
        id: 'p-' + Math.random().toString(36).slice(2, 10),
        label: t('providers.newLabel'), baseUrl: '', apiKey: '', model: '', authStyle: 'bearer',
        dropFields: [],
        dropBeta: true, maxOutputTokens: null, extraHeaders: {},
      })
      markDirty(); render()
    } else if (act === 'del-provider') {
      S.config.providers = S.config.providers.filter((p) => p.id !== pid)
      markDirty(); render()
    } else if (act === 'add-rule') {
      S.config.rules.push({
        id: 'r-' + Math.random().toString(36).slice(2, 10),
        enabled: true, match: 'subagent', modelGlob: '*', agentIdGlob: '*',
        providerId: S.config.providers[0]?.id ?? 'passthrough', modelOverride: '',
      })
      markDirty(); render()
    } else if (act === 'del-rule') {
      S.config.rules = S.config.rules.filter((r) => r.id !== rid)
      markDirty(); render()
    } else if (act === 'up' || act === 'down') {
      const i = S.config.rules.findIndex((r) => r.id === rid)
      const j = act === 'up' ? i - 1 : i + 1
      if (j >= 0 && j < S.config.rules.length) {
        ;[S.config.rules[i], S.config.rules[j]] = [S.config.rules[j], S.config.rules[i]]
        markDirty(); render()
      }
    } else if (act === 'flip' || act === 'unflip') {
      // 配額見底時最常做的動作，而且往往在 agent 正在跑的時候做 —— 所以直接存檔生效，
      // 不讓它停在「未儲存」。還原點記在 S.flipBackup，按一下就換回去。
      if (act === 'flip') {
        S.flipBackup = S.config.rules.map((r) => ({ id: r.id, providerId: r.providerId }))
        for (const r of S.config.rules) if (r.enabled && r.providerId !== 'passthrough') r.providerId = 'passthrough'
      } else {
        const back = new Map(S.flipBackup.map((b) => [b.id, b.providerId]))
        for (const r of S.config.rules) if (back.has(r.id)) r.providerId = back.get(r.id)
        S.flipBackup = null
      }
      applyState(await api('PUT', '/api/config', S.config))
      render()
      toast(act === 'flip' ? t('bay.flipToast') : t('bay.unflipToast'))
    } else if (act === 'test' || act === 'test-websearch') {
      const provider = S.config.providers.find((p) => p.id === pid)
      const webSearchOnly = act === 'test-websearch'
      S.busy[pid] = true; render()
      try {
        const out = await api('POST', '/api/test', {
          provider, model: S.tests[pid]?.model, tests: webSearchOnly ? ['webSearch'] : undefined,
        })
        // WebSearch 單獨跑，結果併進既有那組，不把剛跑完的預設項目洗掉
        const kept = webSearchOnly ? (S.tests[pid]?.results ?? []).filter((r) => r.id !== 'webSearch') : []
        S.tests[pid] = { ...out, results: [...kept, ...out.results], model: S.tests[pid]?.model ?? '' }
      } catch (err) {
        S.tests[pid] = { results: [{ id: 'x', label: t('common.test'), ok: false, error: err.message }] }
      } finally {
        S.busy[pid] = false; render()
      }
    } else if (act === 'preview') {
      S.pvKind = $('#pv-kind').value
      S.pvModel = $('#pv-model').value
      S.pvAgent = $('#pv-agent').value
      S.preview = await api('POST', '/api/routing/preview', {
        kind: S.pvKind, model: S.pvModel, agentId: S.pvAgent, config: S.config,
      })
      render()
    } else if (act === 'clear-preview') {
      S.preview = null
      render()
    } else if (act === 'clear-logs') {
      await api('POST', '/api/logs/clear'); S.logs = []; S.open = null; render()
    } else if (act === 'copy') {
      await navigator.clipboard.writeText($('#snippet').textContent)
      btn.textContent = t('common.copied')
      setTimeout(() => { btn.textContent = t('common.copy') }, 1200)
    }
  } catch (err) {
    toast(t('common.actionFailed', { message: err.message }), 'bad')
  }
})

$('#save').addEventListener('click', async () => {
  const btn = $('#save')
  btn.disabled = true
  try {
    applyState(await api('PUT', '/api/config', S.config))
    render()
    toast(t('common.savedToast'))
  } catch (err) {
    toast(t('common.saveFailed', { message: err.message }), 'bad')
    btn.disabled = false
  }
})

function startLogPolling() {
  const tick = async () => {
    try {
      S.logs = (await api('GET', '/api/logs')).entries
      if (S.tab === 'logs' || S.tab === 'bay') render()
      for (const e of S.logs) SEEN.add(e.id)
    } catch {}
  }
  tick()
  stopLogPolling()
  logTimer = setInterval(tick, 3000)
}
function stopLogPolling() { if (logTimer) { clearInterval(logTimer); logTimer = null } }

applyStaticI18n()
applyState(await api('GET', '/api/state'))
render()
startLogPolling()
