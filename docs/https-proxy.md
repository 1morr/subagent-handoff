# HTTPS proxy 模式

> 這個模式只在 `feat/https-proxy` 分支上。master 維持 `ANTHROPIC_BASE_URL` 一種接法，
> 刻意不合併：它多出一把本機 CA 與一個 MITM 路徑，換來的只是 Desktop 也能接。

## 為什麼需要

`ANTHROPIC_BASE_URL` 在 Claude Desktop 的 Code 分頁裡不管用。官方文檔寫明 Desktop 的
gateway 路由「從它自己的第三方推論設定讀，不讀 `ANTHROPIC_BASE_URL` 或 `settings.json`」
（[LLM gateway 文檔的 Desktop app 一節](https://code.claude.com/docs/en/llm-gateway-connect)）。
Desktop 自己的「Configure Third-Party Inference」會用 gateway 憑證頂掉 claude.ai 登入，
主對話就不再走訂閱，這個 router 存在的前提也就沒了。

Desktop 照讀的是代理與 CA 變數：用 claude.ai 登入的本機、SSH、WSL Code 分頁 session
「不由 app 管連線，Claude Code 從每一層設定讀這些變數，跟終端機 session 一樣」（v2.1.217 起，
[network-config 文檔](https://code.claude.com/docs/en/network-config)）。所以改從
`HTTPS_PROXY` 接進來。來源是 [issue #2](https://github.com/1morr/subagent-handoff/issues/2)。

## 怎麼運作

proxy 埠（預設 8787）多收 `CONNECT`：

| CONNECT 的目的地 | 怎麼處理 |
|---|---|
| `api.anthropic.com:443` | 用本機 CA 簽的證書解開 TLS，再按路徑分（見下表） |
| 其他任何主機 | 純 TCP 隧道，不解密 |

解開之後：

| 路徑 | 去向 |
|---|---|
| `/v1/messages*` | 交給 proxy 原本的 handler，分流、改寫、流量記錄跟 `ANTHROPIC_BASE_URL` 模式同一套 |
| 其他路徑 | 原樣轉發給 Anthropic，不記錄 |
| WebSocket upgrade | 原樣轉發給 Anthropic（voice mode 用 `/api/ws/speech_to_text/voice_stream`） |

只把 `/v1/messages*` 交給 handler，是為了跟 `ANTHROPIC_BASE_URL` 模式看到一樣的流量。
那個模式下 router 只收得到 `/v1/messages` 與 `/v1/messages/count_tokens`（master 上實際的
traffic.log 4666 筆裡沒有別的）。MITM 看得到的東西多得多：第一次實測時一個 `claude -p` 就多出
14 筆 OAuth、bootstrap、feature flag、MCP registry 與 `event_logging` 遙測，全記下來的話
流量記錄和進條的統計都會被淹掉。

程式碼：`src/connect.mjs`（CONNECT、隧道、轉發）、`src/ca.mjs`（CA 與證書）。

## 設定

`~/.claude/settings.json`：

```json
{
  "env": {
    "HTTPS_PROXY": "http://127.0.0.1:8787",
    "NODE_EXTRA_CA_CERTS": "<config.json 旁邊的 https-proxy-ca.pem>"
  }
}
```

GUI 的接入分頁會給出填好路徑的版本。以前設過的 `ANTHROPIC_BASE_URL` 要拿掉。
兩個都設不會出錯，但 API 請求會走 base URL 那條，MITM 就用不到。

## 本機 CA

- 第一次啟動時產生，放在 `config.json` 旁邊：`https-proxy-ca.pem`（證書）與
  `https-proxy-ca-key.pem`（私鑰，0600）。兩個都在 `.gitignore` 裡。
- ECDSA P-256，效期十年。伺服器證書每次啟動重簽一張，只放在記憶體裡。
- **nameConstraints 限定只能簽 `api.anthropic.com`。** 私鑰外洩的話，拿它簽別的網域，
  驗證端會以 `permitted subtree violation` 拒絕，`test/ca.test.mjs` 用真的 TLS 握手驗這件事。
- **不要裝進系統信任庫。** 只透過 `NODE_EXTRA_CA_CERTS` 給 Claude Code 用。瀏覽器不信任它，
  所以就算瀏覽器的流量經過 router，也解不開。
- 證書是 `src/ca.mjs` 手工用 DER 拼出來的：Node 只會解析 X.509、不會產生，而這個專案零依賴。
- 刪掉這兩個檔案，下次啟動就會產生新的一組。路徑不變，但 Claude Code 要重開才會讀到新證書。

## 實測（2026-09-25，Windows）

**CLI（Claude Code 2.1.281）。** 用 `claude -p` 設 `HTTPS_PROXY` 與 `NODE_EXTRA_CA_CERTS`、
不設 `ANTHROPIC_BASE_URL`，叫它開一個 subagent：

- debug log 有 `CA certs: Appended extra certificates from NODE_EXTRA_CA_CERTS`，握手成功，
  nameConstraints 沒有讓 Claude Code 的 TLS 堆疊拒絕。
- 主對話記成 `main`、subagent 記成 `subagent`，跟 `ANTHROPIC_BASE_URL` 模式一樣。
- 原樣轉發的登入、bootstrap、遙測都正常，session 照常跑完。
- 不給 CA 時 Claude Code 自己回 `SSL certificate verification failed
  (UNABLE_TO_VERIFY_LEAF_SIGNATURE) … set NODE_EXTRA_CA_CERTS`，router 的 console 也印出提示。

**Desktop（2.7032.0.0，Microsoft Store 版，內嵌 Claude Code 2.1.280）。** 兩個變數只放在一個
測試資料夾的 `.claude/settings.local.json`，`~/.claude/settings.json` 裡照舊是指向另一台 router
的 `ANTHROPIC_BASE_URL`。在 Code 分頁（Local、claude.ai 登入）開那個資料夾，叫它開一個 subagent：

- 51 筆請求全部經過這台 router、全部 200：主對話 `/v1/messages` 6 筆、subagent 1 筆（分類正確）、
  `/v1/messages/count_tokens` 44 筆。流量記錄的 session id 對得上 Desktop 自己的 session 檔。
- 專案層的設定就夠：官方文檔說 claude.ai 登入的本機 session 每一層都讀，實測相符。
- `count_tokens` 比 CLI 多得多（CLI 在 master 的 4666 筆裡才 75 筆），推測是介面在算 context 用量。
  走訂閱線，不影響分流，但會佔掉流量記錄的篇幅。
- Store 版 Desktop 的資料在 `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\`
  （`claude_desktop_config.json`、內嵌的 `claude-code\<版本>\`、`claude-code-sessions\`），
  不在一般的 `%APPDATA%\Claude`：MSIX 會把 AppData 重導到套件自己的目錄。

**還沒實測：** Remote Control、真的 voice mode（upgrade 轉發只用測試裡的假上游驗過）、
把 subagent 真的分到第三方 provider（分流走的是跟 CLI 同一個 handler，CLI 那邊有測試）。

## 代價與地雷

- **`HTTPS_PROXY` 會被 Claude Code 啟動的每一支程式繼承**，包括 Bash 工具裡跑的 git、npm、
  curl。它們經 router 原樣隧道出去，但 **router 沒在跑的時候全部斷網**，Claude Code 本身也是。
  不想經過 router 的主機列進 `NO_PROXY`。
- **只處理 `CONNECT`。** `HTTP_PROXY` 用的 absolute-form 明文代理請求（`GET http://…`）
  會被 guard 以 403 擋下，所以不要把 `HTTP_PROXY` 也指過來。
- **不要讓 router 自己走代理。** Node 的 `fetch` 預設不理 `HTTPS_PROXY`，只有設了
  `NODE_USE_ENV_PROXY=1` 或 `--use-env-proxy` 才會
  （[Node 文檔](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support)）。
  帶著這兩者之一、又讓 `HTTPS_PROXY` 指向自己去啟動 router，請求會繞回自己。
- **guard 對解開的請求放行。** 它們的 Host 是 `api.anthropic.com`，必然過不了主機名檢查。
  這條路不必防 DNS rebinding 與 CSRF：網頁的 `fetch` 送不出 `CONNECT`，瀏覽器也不信任這把 CA。
  proxy 那台 server 只收明文，所以「socket 是加密的」就代表是這條路進來的
  （`src/proxy.mjs`）。明文送來、Host 寫 `api.anthropic.com` 的請求照樣被擋，有測試守著。
- **握手失敗時 router 會在 console 提示去查 `NODE_EXTRA_CA_CERTS`。** TLS 1.3 下 client
  驗不過證書只會關掉連線，server 端看不到錯誤，只看得到「還沒握完手就關了」，所以 client
  正常中途離開也會觸發這個提示。解開 TLS 用的是自己包的 `TLSSocket`：從 http server 的
  `connect` 事件拿到的 socket 交給 `https.Server` 之後，握手失敗時什麼事件都不發（實測 Node 24）。
