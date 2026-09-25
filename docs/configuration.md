# 設定參考

對應 README 的「Configuration」一節。這裡是 `config.json` 的完整欄位清單、寫死在程式
裡的值，以及舊版設定檔載入後會少掉什麼。

## `config.json` 放在哪裡

預設在 repo 根目錄，可以用 `ROUTER_CONFIG` 環境變數指到別的路徑：

```bash
ROUTER_CONFIG=/path/to/my-config.json npm start
```

## 欄位

`config.json` 也可以直接手改，GUI 是它的完整前端 —— 表格裡每一項都改得到（埠號除外）。

| 欄位 | 說明 |
| --- | --- |
| `proxyPort` / `adminPort` | 分別是 proxy 與 GUI 的埠，預設 8787 / 8788。GUI 改不到，手改之後要重啟；其他設定即時生效。1–65,535 以外的值載入時退回預設 |
| `httpsProxy` | HTTPS proxy 模式，給 Claude Desktop 用，預設 `false`。只有布林 `true` 才算打開。GUI 存檔當場切換，不用重啟；手改則下次啟動生效。見 [https-proxy.md](https-proxy.md) |
| `providers[].baseUrl` | 必須是 Anthropic Messages 格式的端點，router 會往 `{baseUrl}/v1/messages` 送。只收 `http:` / `https:` |
| `providers[].apiKey` | 送給這個 provider 的 key。GUI 只拿得到遮罩值，見 [security.md](security.md) |
| `providers[].model` | 送出前把 `model` 改寫成這個值。留空 = 不改寫 |
| `providers[].authStyle` | `bearer`（`Authorization: Bearer`）或 `x-api-key` |
| `rules[]` | 由上而下取第一條命中者。細節見 [routing.md](routing.md) |
| `rules[].enabled` | 關掉的規則直接跳過，流量落到下一條 |
| `rules[].match` | `main`（沒有 `x-claude-code-agent-id`）或 `subagent`（有） |
| `rules[].modelGlob` | 比對請求的 model 名，支援 `*`，**不分大小寫**。`*` = 不篩 |
| `rules[].providerId` | 導向哪個 provider。填保留值 `passthrough` = 明確導回訂閱 |
| `rules[].modelOverride` | 送出前把 `model` 改寫成這個值，蓋過 `providers[].model`。留空 = 不改寫。指向 `passthrough` 時一樣生效 |

**`passthrough` 是保留字。** 如果某個 provider 的 `id` 被設成 `"passthrough"`，
載入設定檔時會被當成沒填、直接換發一個新 id（`src/config.mjs` 的
`normalizeProvider`，比對 `routing.mjs` 匯出的 `PASSTHROUGH_ID`）——這個字串只留給
`rules[].providerId` 用來明確指回訂閱，provider 自己不能佔用它。

## 寫死在程式裡的值

這幾項曾經是設定，實際上沒有人需要改，所以收成常數。

| 項目 | 值 | 在哪裡 |
| --- | --- | --- |
| 訂閱線的去向 | `https://api.anthropic.com`，憑證與 header 原樣轉發 | `src/proxy.mjs` 的 `PASSTHROUGH_BASE_URL` |
| 單一請求 body 上限 | 64 MiB，超過回 413。router 要讀完整包才能判斷路由與改寫，這是防呆不是限流；1M context 的請求實測十幾 MB | `src/proxy.mjs` 的 `MAX_REQUEST_BYTES` |
| 流量記錄的落檔 | `config.json` 旁邊的 `traffic.log`，超過 5 MB 輪替成 `traffic.log.1` | `src/index.mjs`、`src/logfile.mjs` |

## 舊版設定檔

載入時只挑認得的欄位，其餘忽略；下次從 GUI 存檔，檔案裡就不會再有它們。

| 已經拿掉的欄位 | 載入後的行為 |
| --- | --- |
| `retry`、`passthrough.retry`、`providers[].retry` | router 不再自己重送，見 [reliability.md](reliability.md) |
| `passthrough.baseUrl`、`maxRequestBytes`、`trafficLog` | 改用上一節的常數 |
| `providers[].dropFields` / `dropBeta` / `maxOutputTokens` / `extraHeaders` | provider 線照 [providers.md](providers.md#router-對請求改了什麼) 那份固定規則改寫 |
| `rules[].agentIdGlob` | 不再按 agent id 篩 |
| `rules[].match` 是 `any` 或 `nested` | **整條規則載入後是關的**。`any` 會把主對話也捲進去、`nested` 範圍比 `subagent` 小，悄悄換成 `subagent` 都會改變分流結果，所以寧可關掉讓你自己決定 |

## 另見

- [security.md](security.md) —— 為什麼 `baseUrl` 只驗證 scheme 不驗證主機、
  `config.json` 的 0600 權限模型、`POST /api/test` 與 `PUT /api/config` 的輸入驗證。
- [reliability.md](reliability.md) —— router 為什麼不自己重送、串流中途斷線怎麼收尾。
- [routing.md](routing.md) —— `rules[]` 的匹配順序與 glob 語法。
