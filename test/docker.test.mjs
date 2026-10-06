// Docker 部署的兩條安全前提，沒有映像也驗得了，所以放在 npm test 裡。
//
// 1. .dockerignore 必須是白名單：repo 根目錄躺著 config.json（API key）、CA 私鑰與 traffic.log，
//    黑名單寫法只要漏一個新檔，它就會被打包進映像、跟著映像被推到別處。
// 2. compose.yaml 只能把埠發布在宿主的 127.0.0.1，而且兩邊同埠。容器裡 router 綁 0.0.0.0，
//    guard 的 Host 檢查擋得住瀏覽器、擋不住區網裡自己填 Host 的 client，能擋別台機器的只剩這個前綴；
//    同埠則是因為 GUI 的 Origin 檢查比對容器裡實際綁定的埠，宿主換埠的話瀏覽器存檔一律 403。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** 映像真正需要的東西，與 Dockerfile 的 COPY 一致 */
const ALLOWED = new Set(['package.json', 'LICENSE', 'src'])

/**
 * @param {string} text .dockerignore 的內容
 * @returns {string[]} 不符合白名單形式的地方；空陣列＝合格
 */
function dockerignoreProblems(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const problems = []
  if (lines[0] !== '*') problems.push(`the first pattern must be "*" (exclude everything), got ${JSON.stringify(lines[0])}`)
  for (const line of lines.slice(1)) {
    if (!line.startsWith('!')) {
      problems.push(`only "!" re-includes may follow "*": ${line}`)
      continue
    }
    // `/src/`、`src/`、`./src` 在 Docker 眼裡都是同一個東西
    const target = line.slice(1).trim().replace(/^\.?\//, '').replace(/\/+$/, '')
    if (!ALLOWED.has(target)) problems.push(`re-includes something the image does not need: ${line}`)
  }
  return problems
}

test('.dockerignore excludes everything except what the Dockerfile copies', () => {
  assert.deepEqual(dockerignoreProblems(readFileSync('.dockerignore', 'utf8')), [])
})

test('the check catches a .dockerignore that would let secrets into the image', () => {
  const real = readFileSync('.dockerignore', 'utf8')
  // 改成黑名單：config.json 以外的秘密檔都會漏進去
  assert.notDeepEqual(dockerignoreProblems(real.replace(/^\*$/m, 'config.json')), [])
  assert.notDeepEqual(dockerignoreProblems(`${real}\n!config.json\n`), [])
  assert.notDeepEqual(dockerignoreProblems(`${real}\n!*.pem\n`), [])
  assert.notDeepEqual(dockerignoreProblems(`${real}\n!.\n`), [])
})

test('the check ignores formatting that does not change what Docker includes', () => {
  const reformatted = '# comment\r\n\r\n*\r\n  !/src/  \r\n# another\r\n!./LICENSE\r\n!package.json\r\n'
  assert.deepEqual(dockerignoreProblems(reformatted), [])
})

/**
 * 不帶依賴就沒有 YAML parser，只認這份檔案用得到的形式：`ports:` 底下縮排較深的 `- ...` 清單項。
 * @param {string} text compose.yaml 的內容
 * @returns {string[]} 每個 ports 清單項，去掉引號
 */
function composePorts(text) {
  const ports = []
  let blockIndent = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (blockIndent !== null && indent <= blockIndent) blockIndent = null
    if (line.trim() === 'ports:') {
      blockIndent = indent
      continue
    }
    const item = blockIndent !== null && line.trim().match(/^-\s*(.+)$/)
    if (item) ports.push(item[1].trim().replace(/^(["'])(.*)\1$/, '$2'))
  }
  return ports
}

/** @returns {string[]} 不符合「127.0.0.1:同埠:同埠」的清單項 */
function composePortProblems(text) {
  const ports = composePorts(text)
  if (ports.length === 0) return ['no ports found under ports:']
  return ports.filter((p) => {
    const m = p.match(/^127\.0\.0\.1:(\d+):(\d+)$/)
    return !m || m[1] !== m[2]
  })
}

test('compose.yaml publishes both ports on 127.0.0.1 only, with the same port on both sides', () => {
  const text = readFileSync('compose.yaml', 'utf8')
  assert.deepEqual(composePorts(text).length, 2)
  assert.deepEqual(composePortProblems(text), [])
})

test('the check catches a port published beyond loopback or remapped to another host port', () => {
  const real = readFileSync('compose.yaml', 'utf8')
  assert.notDeepEqual(composePortProblems(real.replace('"127.0.0.1:8788:8788"', '"8788:8788"')), [])
  assert.notDeepEqual(composePortProblems(real.replace('"127.0.0.1:8788:8788"', '"0.0.0.0:8788:8788"')), [])
  assert.notDeepEqual(composePortProblems(real.replace('"127.0.0.1:8788:8788"', '"127.0.0.1:9000:8788"')), [])
})

test('the port check ignores quoting, comments and indentation', () => {
  const reformatted = [
    'services:',
    '    router:',
    '        ports:   # published on loopback',
    "            - '127.0.0.1:8787:8787'",
    '            # GUI',
    '            -   127.0.0.1:8788:8788',
    '        volumes:',
    '            - data:/data',
  ].join('\r\n')
  assert.deepEqual(composePorts(reformatted), ['127.0.0.1:8787:8787', '127.0.0.1:8788:8788'])
  assert.deepEqual(composePortProblems(reformatted), [])
})
