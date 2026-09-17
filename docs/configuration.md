# 設定參考

對應 README 的「Configuration」一節，那裡只列最常改的欄位。這裡是 `config.json`
的完整欄位清單、預設值，以及送進去的數值實際會被夾成什麼範圍。

## `config.json` 放在哪裡

預設在 repo 根目錄，可以用 `ROUTER_CONFIG` 環境變數指到別的路徑：

```bash
ROUTER_CONFIG=/path/to/my-config.json npm start
```

`npm run demo` 就是靠這個變數，把合成流量寫進另一份設定檔，不會動到你平常在用的
`config.json`。

## 欄位

`config.json` 也可以直接手改，GUI 是它的完整前端 —— 表格裡每一項都改得到。

| 欄位 | 說明 |
| --- | --- |
| `proxyPort` / `adminPort` | 分別是 proxy 與 GUI 的埠。改了要重啟；其他設定即時生效 |
| `maxRequestBytes` | 單一請求 body 的上限，超過直接回 413。router 要讀完整包才能判斷路由與改寫，這是防呆不是限流。預設 64MB，1M context 的請求實測十幾 MB |
| `passthrough.baseUrl` | 沒有規則命中時的去向，預設 `https://api.anthropic.com`。憑證原樣轉發，不做任何改寫 |
| `providers[].baseUrl` | 必須是 Anthropic Messages 格式的端點，router 會往 `{baseUrl}/v1/messages` 送 |
| `providers[].model` | 送出前把 `model` 改寫成這個值。留空 = 不改寫 |
| `providers[].authStyle` | `bearer`（`Authorization: Bearer`）或 `x-api-key` |
| `providers[].dropFields` | 送出前刪掉的 body 欄位。**預設空**，只在上游回 `400 unknown field` 時才照錯誤訊息填 |
| `providers[].dropBeta` | 移除 `anthropic-beta` header，預設 true |
| `providers[].maxOutputTokens` | `max_tokens` 上限，超過就夾住。留空 = 不夾。必須是正整數，其餘一律視為未設定 |
| `providers[].extraHeaders` | 額外 header。鍵名必須是合法的 HTTP header token（`[!#$%&'*+\-.^_\`|~0-9A-Za-z]+`），不合法的鍵載入時會被整條丟掉，並在 console 印出原因，不會讓整個設定檔載入失敗 |
| `trafficLog.file` | 流量記錄的落檔路徑，相對於 `config.json` 所在目錄。留空 = 不落檔。預設 `traffic.log` |
| `trafficLog.maxBytes` | 超過就輪替成 `traffic.log.1`，只留一份舊的。預設 5,000,000 |
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
整個退回預設值。想確認自己填的值實際生效成什麼，存檔後重新讀一次 `config.json`
—— 寫回去的就是 router 真正在用的值。預設值與夾值都在 `src/config.mjs` 的
`defaultConfig` 與 `normalizeConfig`。

| 欄位 | 預設值 | 允許範圍 |
| --- | --- | --- |
| `maxRequestBytes` | 67,108,864（64 MiB） | 1,000,000–1,000,000,000（bytes） |
| `trafficLog.maxBytes` | 5,000,000（bytes） | 10,000–1,000,000,000（bytes） |
| `proxyPort` / `adminPort` | 8787 / 8788 | 1–65,535 的整數，其餘退回預設 |

## 另見

- [security.md](security.md) —— 為什麼 `baseUrl` 只驗證 scheme（`http:` /
  `https:`）不驗證主機、`extraHeaders` 與 `config.json` 的 0600 權限模型、
  `POST /api/test` 與 `PUT /api/config` 的輸入驗證。
- [reliability.md](reliability.md) —— router 為什麼不自己重送、怎麼補 ping、串流中途斷線怎麼收尾。
- [routing.md](routing.md) —— `rules[]` 的匹配順序與 glob 語法。
