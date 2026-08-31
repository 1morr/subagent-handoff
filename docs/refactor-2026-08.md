# 2026-08 重構：前後對照

一次針對安全性、重試策略與協定缺口的整理。基準是 `9f62d3c`（重構前的最後一個 commit），
共八個 commit（含這份文檔）、`src` 淨增約 380 行、測試從 57 條增加到 79 條。

改動的依據不只是讀程式碼，還有一份跑了 **2711 筆真實流量**的 `traffic.log`
（29 個 session、3 個專案，main 1043 筆走訂閱、subagent 1668 筆走 Kimi，分流準確度 100%）。
下面每個「為什麼」都能追回那份記錄。

---

## 一、安全性：GUI 的 API 對任何網頁都是敞開的

### 改動前

兩台 server 都只綁 `127.0.0.1`，除此之外**沒有任何來源檢查**。實測（起 server 打真的請求）：

| 請求 | 結果 |
| --- | --- |
| `POST /api/test` 帶 `Origin: https://evil.example` | `200`，照常執行 |
| `GET /api/state` 帶 `Host: evil.example` | `200`，沒擋 |
| `PUT /api/config` 帶 `Origin: https://evil.example` | `200`，`passthrough.baseUrl` **真的被改掉** |

兩條可用的攻擊路徑：

1. **API key 外流，不需要 DNS rebinding。** `readJson` 不檢查 `content-type`，所以任何網頁都能用
   `content-type: text/plain` 發**簡單請求**（不觸發 preflight）打 `POST /api/test`，body 裡
   `apiKey` 填保留值 `__keep__`、`baseUrl` 填攻擊者的網域。伺服器會把**真的 API key** 還原出來，
   帶著 `Authorization: Bearer sk-...` 送過去。攻擊者不需要讀得到回應 —— key 直接送上門。
2. **訂閱 OAuth token 外流。** `Host` 沒驗證，攻擊者網域重綁到 `127.0.0.1` 之後對瀏覽器就是同源，
   可以自由 `PUT /api/config` 把 `passthrough.baseUrl` 換成自己的伺服器。主對話的下一個請求
   就會把 claude.ai 的 OAuth token 原樣送過去。
3. 同理 proxy 埠在 rebinding 下可以被拿來白嫖第三方額度（自己補一個 `x-claude-code-agent-id`
   就命中分流規則）。

### 改動後

新增 `src/guard.mjs`，兩台 server 在做任何事**之前**檢查來源，不通過回 `403`：

- **`Origin`** —— 沒有（Claude Code 走 undici，不送 Origin）或等於自己的
  `http://127.0.0.1:<埠>` / `http://localhost:<埠>` 才放行。沙箱 iframe 送的字串 `"null"`
  不算「沒有」，一樣擋掉。
- **`Host`** —— 主機名必須是 `127.0.0.1` / `localhost` / `[::1]`。只驗主機名不驗埠：
  rebinding 情境下瀏覽器送的埠本來就是我們綁的那個，比對它擋不到任何東西，
  卻會誤殺埠轉發之類的正常用法。

`Origin` 擋一般 CSRF，`Host` 擋 rebinding，兩個缺一不可。

驗證方式不只是單元測試 —— 另外在 `127.0.0.1:9999` 起了一個真的攻擊頁面，用瀏覽器載入後
三個請求全部拿到 `403`，`config.json` 沒有被改動，proxy 也沒有產生任何上游流量。

---

## 二、重試策略：在訂閱線上原本是**反效果**

### 改動前

`RETRYABLE_STATUS` 是全域的一組狀態碼，`429` 在裡面，兩條線一視同仁。

流量記錄裡 22 筆觸發了重試：

| 指標 | 數字 |
| --- | --- |
| 在訂閱線 | 22 / 22（100%） |
| 狀態是 `429` | 22 / 22（100%） |
| 三次嘗試全部失敗 | 22 / 22（100%） |
| 帶了 `retry-after` | **0 / 22** |
| 同期第三方線的 5xx 或連線錯誤 | **0**（1668 筆） |

也就是說，重試機制至今**沒有幫上第三方任何一次**，而在訂閱線上它做的是：

- 對已經被限流的端點多打 **63 次**請求（21 筆 × 2 次額外重送）
- 在 Claude Code 拿到 429、開始顯示倒數之前，多壓 **3.5～9.4 秒**

因為 `retry-after` 全部是空的，`retry.maxRetryAfterMs`（本來就是為了擋這種情況設計的逃生路徑）
**從來沒有觸發過**，退避退到底也等不到 5 小時額度窗恢復。

最能說明問題的是 `id: 2617`：一個 `messages: 1 / max_tokens: 1 / 非串流` 的內部探針請求，
被 429 兩次、在 router 裡耗掉 5.003 秒，然後 client 自己放棄了。那 5 秒完全是 router 製造的。

### 改動後

`429` 從全域清單抽出來，改由每條路由自己的 policy 決定；其餘狀態（`408 409 500 502 503 504 529`
與連線層失敗）兩條線行為不變。

解析順序是**全域打底 → 路由覆寫蓋上去**，覆寫是**稀疏**的（只有寫出來的鍵生效）：

```jsonc
{
  "retry": { "attempts": 2, "baseDelayMs": 600, "maxDelayMs": 5000,
             "maxRetryAfterMs": 10000, "retryRateLimit": true },
  "passthrough": { "retry": { "retryRateLimit": false } },  // 訂閱：節流直接交回去
  "providers": [
    { "id": "kimi",  "retry": null },                        // 全部繼承
    { "id": "flaky", "retry": { "attempts": 4 } }            // 只加重送次數
  ]
}
```

選稀疏而不是整組取代，是為了讓「只想關掉 429 重送」的人不會把 `attempts` 與退避
一起凍在設定當下的值 —— 之後調全域仍然會傳播過去。

實跑驗證：假上游回一個不帶 `retry-after` 的 429，經過 proxy 之後流量記錄是
`attempts: 1`、`retries: []`，而同一個劇本走 provider 線是 `attempts: 3`、`retries: ["429","429"]`。

---

## 三、限流資訊：流量記錄答不出「什麼時候恢復」

**改動前**：只記 `retry-after`。但訂閱線的 429 實測一個都不帶這個 header，
所以狀態欄是空的，README 裡「畫面上倒數的秒數就是上游 `retry-after` 的值」這句
跟實際資料對不上。

**改動後**：整組收下 `anthropic-ratelimit-*`（照前綴收，不寫死名字 —— 這組 header
會隨 API 版本增減，寫死就會在下一次改名時靜靜漏掉），存進 `entry.rateLimit`。
GUI 的狀態欄在沒有 `retry-after` 時改顯示 `429 ·3586s 後重置`，tooltip 裡有完整鍵值。

---

## 四、串流：上游安靜太久時沒有人補 ping

**改動前**：router 只是逐塊轉發。官方 gateway protocol 要求 gateway 在上游靜默時
自己發 `ping`，因為 Claude Code 數的是位元組、靜默 300 秒就砍串流（undici 的
`bodyTimeout` 也是 300 秒，逐塊重置）。目前沒踩到（Anthropic 會 ping，Kimi 實測
最長一筆 622 秒也正常完成），但那是 provider 的行為決定的，換一個安靜的就會出事。

**改動後**：上游安靜超過 60 秒就補一個 `event: ping`。兩個刻意的限制：

- **只補在 provider 線。** 訂閱線的價值就是原始 bytes 原樣轉發，摻合成資料進去就不成立了，
  而且 Anthropic 本來就會自己 ping。有一條測試專門守著這件事：passthrough 的串流輸出
  必須與上游送出的 bytes 完全一致。
- **只在事件邊界補。** 上游的 chunk 不保證切在 SSE frame 邊界上，插進半個事件中間
  會把整條串流弄壞。

---

## 五、其餘修正

| 項目 | 改動前 | 改動後 |
| --- | --- | --- |
| 規則條件 | 只有來源種類 + `modelGlob` | 多一個 `agentIdGlob`。一般 subagent 的 id 每次 spawn 重生，但官方文檔載明 **agent team 的 teammate 沿用由名字衍生的穩定 id**，所以可以按角色分流。主對話沒有這個 header，永遠不會被非 `*` 的樣式命中 |
| 串流錯誤掃描 | 跨塊時只帶 15 bytes 尾巴，找不到事件開頭的 `{`，記下一段截斷的亂碼 | 帶 1KB |
| client 送 body 途中斷線 | 當成空 body 繼續，白打一次註定 `400` 的上游請求 | 直接收手，記一筆 `未送出` |
| effort 探針 | 7 次請求（五檔位 + 兩次思考量量測） | **5 次**。量測那半段自己的判定邏輯就說單次採樣分不出「上游沒接線」和「這題沒解析度」，花錢買一個「無法判定」不划算 |
| GUI 涵蓋範圍 | 改不到 `retry` / `trafficLog` / `maxRequestBytes`，README 卻說「GUI 只是 config.json 的前端」 | 新增「進階」分頁，表格裡每一項都改得到，README 的說法現在成立 |
| 重啟提示 | 只比對埠號，且不論改了什麼都說「埠號已變更」 | 涵蓋 `trafficLog`（sink 只在啟動時建立一次），而且**講得出是哪一項** |
| 錯誤提示 | `alert()`，阻塞整個分頁 | 頁內 toast |
| Base URL 填錯 | 填 `.../anthropic/v1` 會變成 `/v1/v1/messages`，只能靠探針發現 | GUI 直接標出來 |

---

## 六、設定格式變更

新增四個欄位。**沒有破壞性變更**，舊設定檔照樣載入。

| 欄位 | 型別 | 預設 |
| --- | --- | --- |
| `retry.retryRateLimit` | boolean | `true` |
| `passthrough.retry` | 稀疏覆寫物件 | `{ "retryRateLimit": false }` |
| `providers[].retry` | 稀疏覆寫物件 或 `null` | `null`（全部繼承） |
| `rules[].agentIdGlob` | string | `"*"`（不篩，不影響任何既有規則） |

**一個要知道的遷移行為**：`passthrough` 底下**沒有** `retry` 鍵時（也就是所有既有的設定檔），
`normalizeConfig` 會套用新預設 `{ "retryRateLimit": false }` —— 載入就直接修好第二節那個問題，
不需要手動改。想保留舊行為就明寫 `"retry": { "retryRateLimit": true }`。

流量記錄的 NDJSON 多了 `rateLimit` 與 `pings` 兩個欄位，舊的記錄行不受影響。

---

## 七、測試

57 → 79 條，全綠。新增的涵蓋：

- 兩台 server 對跨來源 `Origin`、外來 `Host`、`Origin: null` 回 403；無 `Origin` 與自己的 Origin 放行
- 被擋下的請求**不產生任何上游流量**、**不改動設定**
- `resolveRetryPolicy` 的稀疏合併優先序、合併後上限小於起跳值時夾回去
- 訂閱線 429 只送一次；provider 429 照樣重送；429 以外的狀態兩條線一致
- provider 可以自己把重送整組關掉
- 舊設定檔載入即套用新的 passthrough 預設
- `agentIdGlob` 命中 / 不命中 / 主對話永遠不被捲入；規則預覽吃得下 agent id
- pinger 靜默補 ping、停在半個事件中間不補、res 收掉後不再寫
- **passthrough 串流一個合成 byte 都不加**
- `anthropic-ratelimit-*` 進到流量記錄
- 讀 body 途中斷線不往上游送
- effort 探針只打 5 次

GUI 另外用 playwright 實跑驗證：稀疏覆寫存進 `config.json` 的結果是
`{"attempts": 5, "retryRateLimit": false}`（只有實際設定的兩個鍵）、
`agentIdGlob: "Explore*"` 讓 `Explore-1` 命中 provider 而 `Plan-1` 落回訂閱、
重啟提示正確指出是「流量記錄落檔」變更、瀏覽器 console 零錯誤。

---

## 八、沒有處理的

- **`logfile.mjs` 的 size 是 in-process 追蹤的**，同時跑兩個 instance 時輪替會互相蓋掉。
  單機單實例不會遇到，修它要引入檔案鎖，不划算。
- **`dropBeta` 的預設維持 `true`。** 官方文檔說「剝掉 beta header 卻留著 body 欄位」會產生硬 `400`，
  而這正是目前的預設組合。但 Kimi 1668 筆與 DeepSeek 實測都是零 `400`，沒有證據支持改它。
  改成在 README 寫清楚配對規則，並把遇到 `400` 時的修法順序倒過來：
  先關 `dropBeta` → 再考慮 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` → 最後才動 `dropFields`。
- **資料仍然會完整送到第三方 provider。** Claude Code 的 system prompt、你的原始碼、
  檔案內容、工具輸出，分流出去的每一筆都包含這些。這不是程式碼能解的問題，
  是選擇用這個工具就要接受的取捨。
