# 設定參考

對應 README 的「Configuration」一節，那裡只列最常改的欄位。這裡是 `config.json`
的完整欄位清單、預設值，以及送進去的數值實際會被夾成什麼範圍。

## `config.json` 放在哪裡

預設在 repo 根目錄，可以用 `ROUTER_CONFIG` 環境變數指到別的路徑
（`src/config.mjs:9-11`）：

```bash
ROUTER_CONFIG=/path/to/my-config.json npm start
```

`npm run demo` 就是靠這個變數，把合成流量寫進另一份設定檔，不會動到你平常在用的
`config.json`。這個變數目前沒有在任何地方文檔化，只在原始碼裡。

## 欄位

`config.json` 也可以直接手改，GUI 是它的完整前端 —— 表格裡每一項都改得到。

| 欄位 | 說明 |
| --- | --- |
| `proxyPort` / `adminPort` | 分別是 proxy 與 GUI 的埠。改了要重啟；其他設定即時生效 |
| `maxRequestBytes` | 單一請求 body 的上限，超過直接回 413。router 為了能重送會把整包留在記憶體，這是防呆不是限流。預設 64MB，1M context 的請求實測十幾 MB |
| `passthrough.baseUrl` | 沒有規則命中時的去向，預設 `https://api.anthropic.com`。憑證原樣轉發，不做任何改寫 |
| `passthrough.retry` | 訂閱線的 retry 覆寫（稀疏，只寫的鍵生效）。**預設 `{"retryRateLimit": false}`** |
| `providers[].baseUrl` | 必須是 Anthropic Messages 格式的端點，router 會往 `{baseUrl}/v1/messages` 送 |
| `providers[].model` | 送出前把 `model` 改寫成這個值。留空 = 不改寫 |
| `providers[].authStyle` | `bearer`（`Authorization: Bearer`）或 `x-api-key` |
| `providers[].dropFields` | 送出前刪掉的 body 欄位。**預設空**，只在上游回 `400 unknown field` 時才照錯誤訊息填 |
| `providers[].dropBeta` | 移除 `anthropic-beta` header，預設 true |
| `providers[].maxOutputTokens` | `max_tokens` 上限，超過就夾住。留空 = 不夾。必須是正整數，其餘一律視為未設定 |
| `providers[].extraHeaders` | 額外 header。鍵名必須是合法的 HTTP header token（`[!#$%&'*+\-.^_\`|~0-9A-Za-z]+`），不合法的鍵載入時會被整條丟掉，並在 console 印出原因，不會讓整個設定檔載入失敗 |
| `providers[].retry` | 這個 provider 的 retry 覆寫（稀疏）。`null` = 全部繼承全域 |
| `trafficLog.file` | 流量記錄的落檔路徑，相對於 `config.json` 所在目錄。留空 = 不落檔。預設 `traffic.log` |
| `trafficLog.maxBytes` | 超過就輪替成 `traffic.log.1`，只留一份舊的。預設 5,000,000 |
| `retry.attempts` | 上游回可重送的錯誤時，router 自己額外重送幾次。預設 2，填 0 = 關掉 |
| `retry.baseDelayMs` / `retry.maxDelayMs` | 上游沒給 `retry-after` 時的指數退避起跳值與上限，實際等待會再加上抖動 |
| `retry.maxRetryAfterMs` | 上游的 `retry-after` 超過這個值就不自己扛，把回應交回 Claude Code。預設 10000 |
| `retry.retryRateLimit` | 節流（`429`）算不算可重送。全域預設 true，`passthrough.retry` 預設覆寫成 false。細節見 [reliability.md](reliability.md) |
| `rules[]` | 由上而下取第一條命中者。條件為 `any` / `main` / `subagent` / `nested`，另可用 `modelGlob` / `agentIdGlob`（都支援 `*`，且比對**不分大小寫**）再篩。細節見 [routing.md](routing.md) |
| `rules[].providerId` | 導向哪個 provider。填保留值 `passthrough` = 明確導回訂閱 |
| `rules[].modelOverride` | 送出前把 `model` 改寫成這個值，蓋過 `providers[].model`。留空 = 不改寫。指向 `passthrough` 時一樣生效 |
| `rules[].agentIdGlob` | 比對 `x-claude-code-agent-id`，`*` = 不篩。用途是按 agent team 的 teammate 名字分流 |

**`passthrough` 是保留字。** 如果某個 provider 的 `id` 被設成 `"passthrough"`，
載入設定檔時會被當成沒填、直接換發一個新 id（`src/config.mjs` 的
`normalizeConfig`，比對 `routing.mjs` 匯出的 `PASSTHROUGH_ID`）——這個字串只留給
`rules[].providerId` 用來明確指回訂閱，provider 自己不能佔用它。

## 數值限制（clamp）

以下欄位收到超出範圍的值**不會報錯**，載入時會被靜默夾回範圍內；非數字或負值會
整個退回預設值。這是今天的行為，舊版 README 沒有寫這一段。想確認自己填的值實際
生效成什麼，存檔後重新讀一次 `config.json` —— 寫回去的就是 router 真正在用的值。

| 欄位 | 預設值 | 允許範圍 | 依據（`src/config.mjs`） |
| --- | --- | --- | --- |
| `retry.attempts` | 2 | 整數 0–10；非整數或負值退回預設 | 預設：第 85 行；夾值：第 167、170 行 |
| `retry.baseDelayMs` | 600（毫秒） | 0–30,000（毫秒） | 預設：第 86 行；夾值：第 168 行 |
| `retry.maxDelayMs` | 5,000（毫秒） | 0–60,000（毫秒），且永遠不低於當下解析出的 `baseDelayMs` | 預設：第 87 行；夾值：第 173 行 |
| `retry.maxRetryAfterMs` | 10,000（毫秒） | 0–120,000（毫秒） | 預設：第 89 行；夾值：第 174 行 |
| `maxRequestBytes` | 67,108,864（64 MiB） | 1,000,000–1,000,000,000（bytes） | 預設：第 130 行；夾值：第 350 行 |
| `trafficLog.maxBytes` | 5,000,000（bytes） | 10,000–1,000,000,000（bytes） | 預設：第 111 行；夾值：第 156 行 |
| `proxyPort` / `adminPort` | 8787 / 8788 | 1–65,535 的整數，其餘退回預設 | 預設：第 124-125 行；夾值：第 196-199 行 |

`maxRequestBytes` 只擋單一請求。同一個 router 實例上，所有並發請求疊起來的 body
量體另外有一個固定 **256MB** 的總上限（`DEFAULT_MAX_IN_FLIGHT_BYTES`，
`src/proxy.mjs:397`），超過就直接回 `503`、連 body 都不讀。這個上限目前**不能**
透過 `config.json` 調整，只有測試程式碼能覆寫。細節見 [reliability.md](reliability.md)。

## 另見

- [security.md](security.md) —— 為什麼 `baseUrl` 只驗證 scheme（`http:` /
  `https:`）不驗證主機、`extraHeaders` 與 `config.json` 的 0600 權限模型、
  `POST /api/test` 與 `PUT /api/config` 的輸入驗證。
- [reliability.md](reliability.md) —— `retry.*` 各欄位實際怎麼合併、生效。
- [routing.md](routing.md) —— `rules[]` 的匹配順序與 glob 語法。
