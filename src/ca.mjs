import { generateKeyPairSync, createHash, randomBytes, sign, X509Certificate } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * 本機 CA 與它簽出的伺服器證書，給 HTTPS proxy 模式解開 api.anthropic.com 的 TLS 用（見 src/connect.mjs）。
 *
 * Node 只會解析 X.509、不會產生，而這個專案刻意零依賴，所以證書是這裡手工用 DER 拼出來的。
 * 只實作用得到的那一小塊：ECDSA P-256、固定幾個 extension。拼錯的話 X509Certificate 會解析失敗、
 * TLS 握手會驗不過 —— test/ca.test.mjs 用真的 TLS 連線驗這兩件事。
 */

export const CA_CERT_FILE = 'https-proxy-ca.pem'
export const CA_KEY_FILE = 'https-proxy-ca-key.pem'

const CA_COMMON_NAME = 'subagent-handoff local CA'

// ── DER ───────────────────────────────────────────────────────────

function derLength(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag, ...parts) {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

const seq = (...parts) => tlv(0x30, ...parts)
const set = (...parts) => tlv(0x31, ...parts)
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]))
const octets = (buf) => tlv(0x04, buf)
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'))
/** [n] EXPLICIT，或 IMPLICIT 的 constructed 型別 */
const explicit = (n, ...parts) => tlv(0xa0 | n, ...parts)
/** [n] IMPLICIT 的 primitive 型別（IA5String、OCTET STRING） */
const implicit = (n, buf) => tlv(0x80 | n, buf)
/** 只給小於 128 的非負整數用（version、pathLen） */
const smallInt = (n) => tlv(0x02, Buffer.from([n]))

/** BIT STRING；unusedBits 是最後一個位元組尾端沒用到的位數，DER 要求把尾端的 0 位元算進去 */
const bits = (buf, unusedBits = 0) => tlv(0x03, Buffer.from([unusedBits]), buf)

function oid(dotted) {
  const [first, second, ...rest] = dotted.split('.').map(Number)
  const out = [40 * first + second]
  for (const arc of rest) {
    const chunk = [arc & 0x7f]
    for (let v = arc >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80)
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

/** RFC 5280：2049 年以前用 UTCTime，之後用 GeneralizedTime */
function derTime(date) {
  const stamp = `${date.toISOString().slice(0, 19).replace(/[-:T]/g, '')}Z`
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(stamp.slice(2))) : tlv(0x18, Buffer.from(stamp))
}

/** 16 個隨機位元組的正整數。最高位清掉免得被當成負數，首位元組不能是 0 否則不是最短編碼 */
function serialNumber() {
  const buf = randomBytes(16)
  buf[0] &= 0x7f
  if (buf[0] === 0) buf[0] = 1
  return tlv(0x02, buf)
}

/** 讀出一個 TLV，回傳它整段（含 tag 與長度）與下一個的位置。只給解析自己簽的證書用 */
function readTlv(buf, at) {
  let len = buf[at + 1]
  let header = 2
  if (len & 0x80) {
    const count = len & 0x7f
    len = 0
    for (let i = 0; i < count; i++) len = len * 256 + buf[at + 2 + i]
    header += count
  }
  const end = at + header + len
  return { whole: buf.subarray(at, end), body: buf.subarray(at + header, end), next: end }
}

/** 從證書 DER 取出 subject 的原始 bytes，當作它簽出的證書的 issuer —— 兩者必須逐位元組相同 */
function subjectOf(certDer) {
  const tbs = readTlv(readTlv(certDer, 0).body, 0).body
  let at = 0
  const fields = []
  while (at < tbs.length) {
    const field = readTlv(tbs, at)
    fields.push(field.whole)
    at = field.next
  }
  // version [0] 在的話 subject 是第 6 個欄位，不在（v1）就是第 5 個
  return fields[fields[0][0] === 0xa0 ? 5 : 4]
}

// ── X.509 ─────────────────────────────────────────────────────────

const OID = {
  commonName: '2.5.4.3',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  nameConstraints: '2.5.29.30',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
}

const SIGNATURE_ALGORITHM = seq(oid(OID.ecdsaWithSha256))

const nameOf = (commonName) => seq(set(seq(oid(OID.commonName), utf8(commonName))))

function extension(id, critical, value) {
  // critical 預設 FALSE，DER 規定預設值不能編進去
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value))
}

const keyIdOf = (publicKey) => createHash('sha1').update(publicKey.export({ type: 'spki', format: 'der' })).digest()

function toPem(der) {
  const lines = der.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`
}

function buildCertificate({ issuer, subject, publicKey, signingKey, notBefore, notAfter, extensions }) {
  const tbs = seq(
    explicit(0, smallInt(2)), // v3
    serialNumber(),
    SIGNATURE_ALGORITHM,
    issuer,
    seq(derTime(notBefore), derTime(notAfter)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions)),
  )
  // EC 金鑰的 sign 預設輸出 DER 編碼的 ECDSA-Sig-Value，正好是 X.509 要的格式
  return toPem(seq(tbs, SIGNATURE_ALGORITHM, bits(sign('sha256', tbs, signingKey))))
}

const DAY = 24 * 60 * 60 * 1000

/**
 * 產生一個只能替 `permittedHost` 簽證書的 CA。
 *
 * nameConstraints 是這把私鑰外洩時的保險：拿它簽別的網域，驗證端會直接拒絕，
 * 所以就算誤裝進系統信任庫，它也冒充不了 api.anthropic.com 以外的任何網站。
 */
export function createCa({ permittedHost, now = new Date() }) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const name = nameOf(CA_COMMON_NAME)
  const certPem = buildCertificate({
    issuer: name,
    subject: name,
    publicKey,
    signingKey: privateKey,
    // 往前退一小時，吸收本機與驗證端之間的時鐘誤差
    notBefore: new Date(now.getTime() - 60 * 60 * 1000),
    notAfter: new Date(now.getTime() + 10 * 365 * DAY),
    extensions: [
      extension(OID.basicConstraints, true, seq(bool(true), smallInt(0))),
      // keyCertSign（bit 5）＋ cRLSign（bit 6）＝ 0b0000_0110，尾端 1 個位元沒用到
      extension(OID.keyUsage, true, bits(Buffer.from([0x06]), 1)),
      extension(OID.nameConstraints, true, seq(explicit(0, seq(implicit(2, Buffer.from(permittedHost)))))),
      extension(OID.subjectKeyIdentifier, false, octets(keyIdOf(publicKey))),
    ],
  })
  return { certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

/**
 * 用 CA 替 `host` 簽一張伺服器證書。每次啟動重簽一張放在記憶體裡，不落檔 ——
 * 需要持久保存的只有 CA，那才是 Claude Code 透過 NODE_EXTRA_CA_CERTS 信任的東西。
 *
 * @param {{ certPem: string, keyPem: string }} ca
 */
export function issueLeaf(ca, host, now = new Date()) {
  const caCert = new X509Certificate(ca.certPem)
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const certPem = buildCertificate({
    issuer: subjectOf(caCert.raw),
    subject: nameOf(host),
    publicKey,
    signingKey: ca.keyPem,
    notBefore: new Date(now.getTime() - 60 * 60 * 1000),
    // 398 天是瀏覽器對伺服器證書的上限；Claude Code 的 TLS 堆疊不見得檢查，照著做不花成本
    notAfter: new Date(now.getTime() + 397 * DAY),
    extensions: [
      extension(OID.basicConstraints, true, seq()),
      // digitalSignature（bit 0）＝ 0b1000_0000，尾端 7 個位元沒用到
      extension(OID.keyUsage, true, bits(Buffer.from([0x80]), 7)),
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectAltName, false, seq(implicit(2, Buffer.from(host)))),
      extension(OID.authorityKeyIdentifier, false, seq(implicit(0, keyIdOf(caCert.publicKey)))),
    ],
  })
  return { certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

/**
 * 讀出 `dir` 底下的 CA；還沒有就產生一組。私鑰 0600，跟 config.json 同一個理由。
 *
 * 路徑固定，重新產生 CA 之後 NODE_EXTRA_CA_CERTS 不必改，但 Claude Code 要重開才會讀到新的。
 *
 * @returns {Promise<{ certPem: string, keyPem: string, certPath: string, created: boolean }>}
 */
export async function loadOrCreateCa(dir, permittedHost) {
  const certPath = path.join(dir, CA_CERT_FILE)
  const keyPath = path.join(dir, CA_KEY_FILE)
  try {
    const [certPem, keyPem] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')])
    return { certPem, keyPem, certPath, created: false }
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read the HTTPS proxy CA in ${dir}: ${err.message}`)
  }
  const ca = createCa({ permittedHost })
  await mkdir(dir, { recursive: true })
  await writeFile(keyPath, ca.keyPem, { encoding: 'utf8', mode: 0o600 })
  await writeFile(certPath, ca.certPem, 'utf8')
  return { ...ca, certPath, created: true }
}
