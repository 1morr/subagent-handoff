/**
 * 本機來源守衛：Origin 擋一般 CSRF，Host 擋 DNS rebinding，兩個都要。
 * 攻擊情境與為什麼只綁 127.0.0.1 不夠，見 docs/security.md 的「本機來源檢查」。
 *
 * Claude Code 走 undici 不送 Origin，所以「沒有 Origin」必須放行，否則 proxy 一個請求都收不到。
 */

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 取出 Host header 的主機名。形如 `127.0.0.1:8788` 或 `[::1]:8788`，
 * IPv6 的冒號要從右括號之後才算，否則會把位址本身切斷。
 */
function hostname(host) {
  const at = host.lastIndexOf(':')
  return (at > host.lastIndexOf(']') ? host.slice(0, at) : host).toLowerCase()
}

/**
 * 這個請求是不是真的來自本機，而不是某個網頁借瀏覽器的手打過來的。
 *
 * Host 只驗主機名不驗埠：DNS rebinding 的情境下瀏覽器送的埠本來就是我們綁的那個，
 * 比對它擋不到任何東西，卻會誤殺埠轉發之類的正常用法。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} port 這台 server 綁定的埠，用來組出唯一允許的 Origin
 */
export function isLocalRequest(req, port) {
  const { host, origin } = req.headers
  if (!host || !LOCAL_HOSTNAMES.has(hostname(host))) return false
  // 沙箱 iframe 送的是字串 "null"，那不是「沒有 Origin」，要擋掉
  if (origin == null || origin === '') return true
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

/** 被擋下來時的回應。講清楚原因，免得使用者以為是 router 壞了。 */
export function rejectForeignOrigin(res) {
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'permission_error',
        message: 'subagent-handoff: only local-origin requests are accepted (Origin / Host check failed)',
      },
    }),
  )
}
