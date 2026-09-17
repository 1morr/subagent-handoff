# subagent-handoff

讓 Claude Code 的**主對話留在 claude.ai 訂閱**，同時把**子 agent 的流量分流到第三方 provider**（Kimi、GLM、DeepSeek 或任何提供 Anthropic Messages 格式端點的服務）。附 Web GUI，可以隨時換 base URL / API key，並在切過去之前先測通不通。

主要用途：ultracode / Workflow 一次展開幾十個子 agent，很容易撞到 5 小時限制。把子 agent 丟給便宜的 provider，主對話的推理品質不受影響。

> **非官方工具**，與 Anthropic PBC 無隸屬、未經其背書或贊助。第三方 provider 的用量由你自己的
> API key 付帳 —— 本工具不修改、不偽造任何計費身分，也不繞過任何一方的用量限制。官方明說
> **不支援**把 Claude Code 導到非 Claude 模型（見[已知限制](#已知限制)），壞了要自己修。
> 使用前請自行確認符合你與各 provider 的服務條款。風險自負。

## 為什麼這行得通

Claude Code 官方 [LLM gateway 文檔](https://code.claude.com/docs/en/llm-gateway)：

> **Setting only that variable** (`ANTHROPIC_BASE_URL`)**, without a gateway credential, doesn't replace the subscription.** Requests still route through the gateway, but a saved claude.ai login remains the active credential, so its usage limits and billing apply.

也就是說，只要**不設** `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `apiKeyHelper`，Claude Code 會帶著訂閱的 OAuth token 打到本 router。router 再決定每一筆要送去 Anthropic（訂閱付帳）還是第三方（API key 付帳）。

分流依據是 [gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol) 定義的 header：

> `x-claude-code-agent-id` — Identifier of the subagent that issued the request, **present only on requests from an agent Claude Code spawned inside the session**.

用這個 header 而不是 model 名，是因為 Workflow 的 `agent()` 只吃 `sonnet | opus | haiku | fable` 四個 alias，在 workflow script 裡根本寫不出第三方的 model 名。看 header 就完全繞開這件事。

## 快速開始

需要 Node 20+（開發時用 v24）。無任何 npm 依賴。

```bash
git clone https://github.com/1morr/subagent-handoff.git
cd subagent-handoff
npm start
```

首次啟動會生出 `config.json`（已在 `.gitignore`）。**開箱狀態不分流任何東西** ——
預設那條「所有子 agent」的規則是**關的**，因為 provider 還沒有 key，開著只會讓子 agent
整批撞 401。填完 key 再自己打開，分流才開始。

打開 <http://127.0.0.1:8788>：

1. **Providers** 分頁填 Base URL、API Key、Model，按「執行測試」確認**必要**項目全過（能力項目沒過也跑得起來，見[內建的測試](#內建的測試)）
2. **路由** 分頁把「所有子 agent → 你的 provider」那條規則**打勾啟用**（左邊的標記從 `OFF` 變成 `ON`）
3. **接入** 分頁複製 `settings.json` 片段，重開 Claude Code
4. `/status` 確認 `Login method` 仍指向 claude.ai 帳號
5. 叫個子 agent 幹活，回 **機架** 分頁看分流帶有沒有分成兩段

GUI 有六個分頁：**機架**（總覽：分流比例、兩個席位的負載、最近的進條）、**Providers**、**路由**、**流量**（完整的進條機架）、**進階**、**接入**。

## 設定

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
| `providers[].maxOutputTokens` | `max_tokens` 上限，超過就夾住。留空 = 不夾 |
| `providers[].extraHeaders` | 額外 header |
| `providers[].retry` | 這個 provider 的 retry 覆寫（稀疏）。`null` = 全部繼承全域 |
| `trafficLog.file` | 流量記錄的落檔路徑，相對於 config.json 所在目錄。留空 = 不落檔。預設 `traffic.log` |
| `trafficLog.maxBytes` | 超過就輪替成 `traffic.log.1`，只留一份舊的。預設 5000000 |
| `retry.attempts` | 上游回可重送的錯誤時，router 自己額外重送幾次。預設 2，填 0 = 關掉 |
| `retry.baseDelayMs` / `retry.maxDelayMs` | 上游沒給 `retry-after` 時的指數退避起跳值與上限，實際等待會再加上抖動 |
| `retry.maxRetryAfterMs` | 上游的 `retry-after` 超過這個值就不自己扛，把回應交回 Claude Code。預設 10000 |
| `retry.retryRateLimit` | 節流（`429`）算不算可重送。全域預設 true，`passthrough.retry` 預設覆寫成 false |
| `rules[]` | 由上而下取第一條命中者。條件為 `any` / `main` / `subagent` / `nested`，另可用 `modelGlob` / `agentIdGlob`（都支援 `*`）再篩 |
| `rules[].providerId` | 導向哪個 provider。填保留值 `passthrough` = 明確導回訂閱 |
| `rules[].modelOverride` | 送出前把 `model` 改寫成這個值，蓋過 `providers[].model`。留空 = 不改寫。指向 `passthrough` 時一樣生效 |
| `rules[].agentIdGlob` | 比對 `x-claude-code-agent-id`，`*` = 不篩。用途是按 agent team 的 teammate 名字分流 |

### 三種來源分別是什麼

實測 Claude Code v2.1.227 送出的 header：

| 條件 | 判定依據 | 是誰 |
| --- | --- | --- |
| `main` | 兩個 header 都沒有 | 你在對話框裡打字的那條線 |
| `subagent` | 有 `x-claude-code-agent-id` | 第一層 agent。**Workflow / ultracode 的 `agent()` 全在這裡** |
| `nested` | 另外有 `x-claude-code-parent-agent-id` | 某個 subagent 又往下開的 agent |

**要涵蓋 ultracode，規則必須選 `subagent`。** Workflow 的 agent 沒有 parent header，選 `nested` 一個都分流不到。

實測也確認 Workflow 的 agent 拿到的工具集裡沒有 `Agent` 與 `Workflow`，所以它們不會再往下開一層 —— 純 ultracode 場景下 `nested` 永遠不觸發。`nested` 只在你手動叫一個 general-purpose subagent、而它自己又去 spawn 別人時才出現。

### 配額快用完時切回訂閱

規則的「導向」可以直接選 `passthrough（訂閱）`，不是只有 provider 可選。

第三方配額見底時，把那條規則的導向從 provider 換成訂閱、按儲存就結束了 —— 不用刪規則、不用清空 API key、也不用重啟 router。設定是每筆請求現查的，正在跑的 agent 下一個請求就會走訂閱，之後配額補回來再切回去。

比「把規則停用」好的地方是規則排序還在：多條規則疊著時，停用會讓流量掉到下一條規則去，而不是掉回訂閱。明確指向 passthrough 才是真的擋在那裡。

點開任何一張進條，「命中規則」那一行就寫著是哪一條吃下的，還是根本沒命中掉到底板。

### 讓子 agent 跑跟主對話不同的模型

規則的 `modelOverride` 會把送出去的 `model` 名換掉，指向訂閱時也生效。

用途是 **Workflow / ultracode 的 `agent()` 沒指定模型時一律沿用主對話的模型** —— 主對話開 `fable`，整批 workflow agent 也會是 fable。想讓主對話留在 fable、子 agent 換成 opus，在 Claude Code 那頭做不到（`agent()` 的 `model` 參數要寫死在 workflow script 裡），只能在 router 這層改：

```jsonc
{
  "match": "subagent",
  "modelGlob": "*",
  "providerId": "passthrough",        // 還是走訂閱付帳
  "modelOverride": "claude-opus-5"    // 但送出去的 model 換掉
}
```

優先序是 `rules[].modelOverride` > `providers[].model` > 原樣沿用。所以同一個 provider 可以被多條規則以不同 model 使用，不必為了換 model 複製一份 provider。

model 名要填**上游看得懂的完整字串**，不是 `opus` / `sonnet` 這種 alias。不確定就把主對話切到那個模型送一句話，再去流量記錄的「要求 model」欄複製實際送出的值 —— GUI 的輸入框有幾個常見值的建議清單，但以流量記錄看到的為準。

兩個要知道的副作用：

- Claude Code 的 UI 仍然顯示你在對話框裡選的模型，實際跑的是改寫後的。要對照就看流量記錄的「要求 model」與「實送 model」兩欄。
- `max_tokens` 是 Claude Code 依原模型算的。改寫成上限較低的模型時可能被上游退件，這種情況只能調 `modelOverride` 或改回去。

### 按 agent 身分分流

規則的 `agentIdGlob` 比對 `x-claude-code-agent-id`，`*` = 不篩。

一般 subagent 的 id **每次 spawn 重新產生**，篩不出東西。但官方 gateway protocol 文檔載明：

> Teammate agents, the named members of an agent team, **reuse a stable name-based ID** across reconnections.

所以這個欄位的實際用途是把 [agent team](https://code.claude.com/docs/en/agent-teams) 的 teammate 按角色拆開 —— 便宜的活丟第三方，需要推理品質的留在訂閱：

```jsonc
[
  { "match": "subagent", "agentIdGlob": "Explore*", "providerId": "kimi" },
  { "match": "subagent", "agentIdGlob": "*",        "providerId": "passthrough" }
]
```

主對話沒有這個 header，所以**永遠不會被非 `*` 的樣式命中** —— 不用擔心一條 agent 規則把主對話也捲進去。

規則預覽那格可以填 agent id 直接試，不必真的去 spawn 一個。跑完之後機架上會標出這一筆由哪條吃下（`HIT`）、哪幾條被遮住（`SHDW`）；沒跑過預覽以前規則一律不標記，而且改到任何一條規則就會把標記收掉 —— 那份模擬已經不是在講現在這份規則了。

### 流量記錄的「目錄」欄是怎麼來的

同時開好幾個專案時，用來分辨哪一筆流量出自哪個 session。

header 裡**沒有** cwd（實測 v2.1.227 的 21 個 header 全查過），唯一的來源是 system prompt 最後一塊的 Environment 區段：

```
# Environment
You have been invoked in the following environment:
 - Primary working directory: C:\Users\dev\code\bridge
```

router 只用一條 regex 挖出這行路徑，system prompt 的其他內容一概不留 —— 測試裡有一條斷言守著這件事。

麻煩的是**子 agent 的 system prompt 沒有這個區段**，而子 agent 正是分流的主要對象。所幸實測子 agent 與主對話共用同一個 `x-claude-code-session-id`，所以由主對話的請求把 cwd 記進一張 `sessionId → cwd` 的表（LRU，上限 200 筆），子 agent 再回查。

因此有一個已知空窗：**router 啟動後，某個 session 的主對話還沒發過任何請求，就先冒出子 agent 流量**，那幾筆的目錄欄會是 `–`。實務上主對話一定先講話，很難碰到。

欄位只顯示目錄名，點開進條看完整路徑。

### 流量記錄會留在磁碟上

GUI 上那份只有最近 300 筆，而且**重啟就沒了** —— 偏偏要查的事情常常橫跨重啟（改完設定要重啟才生效，一重啟證據就跟著消失）。所以每一筆走完的請求會補寫成一行 NDJSON 到 `traffic.log`。

內容跟 GUI 看到的完全一樣：只有中繼資料，沒有 prompt。但它含有專案目錄與 session id，所以預設已經進 `.gitignore`。

```bash
# 昨天所有非 200 的請求是誰擋的
grep -v '"status":200' traffic.log | jq -r '[.ts, .target, .status, .detail] | @tsv'
```

超過 `trafficLog.maxBytes` 會輪替成 `traffic.log.1`，只留一份舊的，所以磁碟最多佔兩倍。`trafficLog.file` 留空就完全不落檔。

### 快取命中率

兩條線的串流回應都帶 `usage`，router 邊轉發邊讀出四個數字記進流量記錄的 `usage` 欄位：`input`（沒命中快取的部分）、`cacheRead`、`cacheWrite`、`output`。只讀 `message_start` 與 `message_delta` 兩種事件，文字與思考內容所在的事件連解析都不做，轉發的 bytes 一個都不動。

- **機架**分頁的兩張席位卡各有一格「快取命中」：`快取讀 ÷（未命中 ＋ 快取寫 ＋ 快取讀）`，**以 token 加權**，範圍是記憶體裡那個席位的全部進條（最多 300 筆）。不跟分流帶用同一個 5 分鐘窗，因為快取是看趨勢的數字，窗太短只剩雜訊。
- 點開任一張進條，「用量」那一行是這一筆的明細。
- 非串流的回應 router 不緩衝，讀不到用量，不算進去。Claude Code 的推論一律走串流，實務上只漏掉少數背景請求。

實測（2026-09）一次子 agent 讀檔：主對話走訂閱，第二輪起 99–100%；子 agent 走 DeepSeek，第一筆 0%、之後 97–99%。

```bash
# 各席位的快取命中率（token 加權）
jq -rs 'map(select(.usage)) | group_by(.providerId) | .[] |
  { seat: (.[0].target), read: (map(.usage.cacheRead) | add),
    prompt: (map(.usage.input + .usage.cacheRead + .usage.cacheWrite) | add) } |
  "\(.seat)\t\((100 * .read / .prompt) | floor)%"' traffic.log
```

### 上游暫時性失敗時 router 自己重送

Anthropic 的 529、第三方的 5xx、還有連線被中間的東西掐掉，都會讓 Claude Code 中斷對話並開始倒數（`attempt 9/10`）。這類失敗大多重送一次就過了，所以 router 先扛。節流（`429`）是唯一的例外，它該不該扛取決於是誰擋的 —— 見下面那段。

**重送只發生在還沒寫出任何一個 byte 給 client 的階段**：請求 body 完整留在記憶體，這時候重送是安全的，而且 client 完全不知道發生過。串流一旦開始轉發就不能重來 —— 那時候重送會讓 client 收到兩段接不起來的回應。

- 會重送：`408 409 500 502 503 504 529`，以及連線層的失敗（`fetch failed`、`terminated`）
- **節流（`429`）看路由**：`retry.retryRateLimit` 說了算，第三方預設重送、訂閱線預設不重送（原因見下一段）
- 不重送：其餘 4xx。請求本身有問題，重送幾次都一樣
- 上游有給 `retry-after` 就照它說的等；超過 `retry.maxRetryAfterMs` 就不自己扛，把回應交回去讓 Claude Code 顯示倒數 —— 使用者至少知道在等什麼，而不是對著一個沒反應的畫面等好幾分鐘
- 扛不住時交回去的是**上游最後一次的原始回應**，狀態碼與 body 都不改寫

#### 為什麼訂閱線不重送 429

一份 2711 筆的流量記錄裡，22 筆觸發了重試 —— **全部在訂閱線、全部是 429、全部三次都失敗**，而且 `retry-after` 一個都沒有（所以 `maxRetryAfterMs` 那條逃生路徑從來沒觸發過）。同期第三方線 1668 筆：0 個 5xx、0 個連線錯誤。

原因是訂閱的 429 是 **5 小時額度窗**，不是瞬時擁塞，退避幾百毫秒等不到它恢復。代價是對已經被擋下的端點多打 63 次請求，並在 Claude Code 顯示倒數之前多壓 3.5～9.4 秒。第三方的 429 通常是真的等一下就過，所以那邊留著。

`retry` 的解析順序是：**全域 `retry` 打底 → 路由自己的覆寫蓋上去**。覆寫是稀疏的，只有寫出來的鍵生效，所以之後調全域的 `attempts` 或退避，只覆寫了 `retryRateLimit` 的路由也會跟著動。

```jsonc
{
  "retry": { "attempts": 2, "baseDelayMs": 600, "retryRateLimit": true },
  "passthrough": { "retry": { "retryRateLimit": false } },   // 訂閱：節流直接交回去
  "providers": [
    { "id": "kimi", "retry": null },                          // 全部繼承
    { "id": "flaky", "retry": { "attempts": 4 } }             // 只加重送次數
  ]
}
```

**舊設定檔升級行為**：`passthrough` 底下沒有 `retry` 鍵時，載入就會套用新預設 `{ "retryRateLimit": false }`。想要舊行為就明寫 `"retry": { "retryRateLimit": true }`。

#### 上游安靜太久時 router 自己補 ping

長思考期間第三方可能一個 byte 都不吐，而 Claude Code 數的是位元組、靜默 300 秒就砍串流（undici 的 `bodyTimeout` 也是 300 秒）。官方 gateway protocol 要求 gateway 在這種時候自己發 `ping`，router 照做：上游安靜超過 60 秒就補一個 `event: ping`。

只補在 **provider 那條線**。訂閱線的價值就是原始 bytes 原樣轉發，摻合成資料進去就不成立了，而且 Anthropic 本來就會自己 ping。補之前一定確認停在事件邊界 —— 上游的 chunk 不保證切在 frame 邊界上，插進半個事件中間會把整條串流弄壞。補了幾個，點開那張進條看「keep-alive」那一行。

狀態欄會顯示 `200 ×3`：送出去三次才成功，而 Claude Code 那頭只看到一次乾淨的 200。批註欄直接寫著「router 自己重送 3 次才成功」，點開看每一次的失敗原因。

串流轉發到一半才斷線沒辦法重送，但 router 會補一個合法的 SSE `error` 事件收尾，而不是把連線砍掉 —— 被砍斷的串流只會讓 Claude Code 說「回應可能不完整」，連原因都拿不到。

### Claude Code 顯示「will retry in …」時該看哪裡

畫面上那句 `Waiting for API response · will retry in 2m 26s · check your network` 只說了「在等」，沒說是誰擋的。答案在流量記錄的**狀態欄**：

- 狀態是 `429` / `529` / `5xx` → **上游擋的**，router 只是照實轉發。這種進條會被推出機架整格、加一圈朱紅框，批註欄寫著「上游擋的」；點開看上游自己的說法（`rate_limit_error: …`、`overloaded_error: …`），以及 `retry-after` 與 `request-id`。
- 狀態欄直接寫著 `fetch failed` / `terminated` 這類文字 → **router 連不上上游**，client 收到的是 router 合成的 502。
- `client aborted` → 是 Claude Code 自己收手（按了 esc、subagent 被取消、上一輪結束）。這不是錯誤。
- **完全沒有對應的那一筆** → 請求根本沒送到 router，問題在 Claude Code 到 127.0.0.1 之間。

上游**有給** `retry-after` 時，畫面上倒數的秒數就是它的值，所以狀態欄顯示 `429 ·146s 後重試` 而畫面寫 `will retry in 2m 26s` 是同一件事，不是 router 卡住。

但訂閱線的 429 實測**不帶** `retry-after`（21 筆全部是空的），那時候畫面的倒數是 Claude Code 自己算的。這種情況下限流資訊在 `anthropic-ratelimit-*` 那組 header 上，router 會整組收進流量記錄：批註欄改寫「上游擋的・3586s 後重置」，點開進條的「限流」那一行有完整的鍵值。

目錄欄是 `–` 時，批註欄會寫「cwd 表還沒建立」；連 session id 都沒有時會改寫「沒有 session id・不是 Claude Code 送來的」—— 那筆是別的東西打到了 router 的埠。兩者都可以點開看 **session id** 那一行。

點開進條的「請求形狀」那一行是**請求的形狀**（messages 幾則、有沒有 system、是不是串流、`max_tokens`）。用來認出那些沒有目錄的背景請求 —— 例如上下文壓縮這種沒有 Environment 區段的請求，光看目錄欄是 `–` 分不出來，看形狀就一眼認得。形狀只有數量與有無，不含任何內容。

### 思考檔位（effort）會不會跟著過去

會，但前提是 `dropFields` 不能把它刪掉。

`/effort` 與 `--effort` 在 wire 上走的是 **`output_config.effort`**，不是 `thinking`。實測 v2.1.227 送出的 body：

```jsonc
{
  "thinking": { "type": "adaptive", "display": "omitted" },   // 只有型態，不帶檔位
  "output_config": { "effort": "xhigh" },                     // ← 檔位在這
  "context_management": { "edits": [{ "type": "clear_thinking_20251015", "keep": "all" }] }
}
```

換 `--effort low` / `max` 時只有 `output_config.effort` 的值變，其餘不動。

所以 **`dropFields` 一旦包含 `output_config`，`/effort` 就完全失效** —— 而且請求照樣回 200，只是模型變笨，不會有任何錯誤提示。這就是預設改成不刪任何欄位的原因：換來一個看得見的 400，比靜默降級好。

實測 cliproxyapi（→ Kimi K3）確實會讀這個欄位並映射到思考檔位，同一道多步推理題各採樣 4 次的 thinking 長度：

| 送出的 effort | thinking 長度（中位數） |
| --- | --- |
| 不帶 `output_config` | ~19800 字元 |
| `low` | ~1500 字元 |
| `xhigh` | ~7100 字元 |

單次波動不小（LLM 本來就隨機），但 `low` 與 `xhigh` 差 4～5 倍是穩定訊號。cliproxyapi 官方另外支援 model 名後綴語法（`kimi-k3(low)` / `kimi-k3(high)`），實測也有效，可以填在 `providers[].model` 當固定檔位用 —— 但那會蓋掉 `/effort`，一般不需要。

流量記錄的**思考**欄會顯示每一筆的 effort，被剝掉時標成 `xhigh → 已移除`（朱紅），批註欄同時寫著「/effort 被 dropFields 吃掉」，不用猜。

### DeepSeek 實測（2026-08，`deepseek-v4-pro`）

端點 `https://api.deepseek.com/anthropic`，`authStyle` 填 `bearer`。**`dropFields` 保持空的，一個都不用加** —— Claude Code 送的欄位它全收：

| 送過去的東西 | 結果 |
| --- | --- |
| `thinking.type: "adaptive"` | 收。DeepSeek 文檔只寫 `enabled` / `disabled`，但 `adaptive` 照樣 200 |
| `output_config.effort` | 收，而且**這就是 DeepSeek 原生的檔位欄位**，router 不需要做任何轉換 |
| `context_management` | 收 |
| `max_tokens` | 到 200000 都收，`maxOutputTokens` 留空即可 |
| `anthropic-beta` | 官方文檔標 Ignored，所以 `dropBeta` 設不設都一樣 |

故意送一個不存在的檔位，錯誤訊息會把完整枚舉吐出來：

```
unknown variant `banana`, expected one of `low`, `medium`, `high`, `xhigh`, `ultra`, `max`
```

比官方文檔多了 `medium` 和 `ultra`。但 Claude Code 的枚舉只有 `low` / `medium` / `high` / `xhigh` / `max`（v2.1.231 確認），所以 `ultra` 送不出去。

**檔位實際只有兩檔堪用。** 同一道組合題各採樣 5 次的 thinking 長度（全部 `end_turn`，無一撞 `max_tokens`）：

| effort | 中位數 | 範圍 |
| --- | --- | --- |
| `low` | 696 字元 | 598–872 |
| `medium` | 1741 字元 | 1136–2665 |
| `high` | 1374 字元 | 1222–2847 |
| `xhigh` | 1667 字元 | 1374–2496 |
| `ultra` | 1418 字元 | 1284–2821 |
| `max` | 1395 字元 | 1052–1980 |

`low` 的最大值（872）比其他所有檔的最小值（1052）還低，**區間完全不重疊**，思考量與耗時都大約對半。`medium` 以上那五檔區間互相覆蓋、中位數排序還是亂的（`medium` 最高、`max` 反而偏低），5 個樣本分不開，代表差異小於單次波動。實務上就是：要省用 `/effort low`，往上調沒有意義。

DeepSeek [自己的文檔](https://api-docs.deepseek.com/guides/thinking_mode)有一張映射表，說 `deepseek-v4-pro` 會把 `low` 抬成 `high`、`xhigh` 抬成 `max`，跟上面的實測對不上（實測 `low` 明顯更短）。那張表掛著一條「will update the actual mapped effort of `deepseek-v4-pro` in early August 2026」的註腳，看來已經生效、只是文檔沒同步。

**model 名一定要填死**，因為 DeepSeek 對 `claude-*` 有一套自己的映射：

| 送過去的 model | DeepSeek 實際跑的 |
| --- | --- |
| `claude-opus-5`、`claude-opus-5[1m]` | `deepseek-v4-pro` |
| `claude-sonnet-5`、`claude-haiku-4-5-*` | `deepseek-v4-flash` |
| 非 `claude-` 開頭（例如 `kimi-k3`） | `400`，不是 fallback |

留空不改寫的話，同一個 `/effort` 會因為子 agent 要的是 opus 還是 sonnet 而**靜默**跑在不同模型上，而流量記錄兩邊都顯示同樣的 effort，看不出差別。

兩個不用擔心的：

- **多輪的 thinking block 不強制回傳。** 整個拿掉、或保留但把 `signature` 清空，第二輪都照樣 200 且答對。社群有回報 DeepSeek 要求 `content[].thinking` 必須原樣送回，在 `deepseek-v4-pro` 上不重現。（2026-09 在 `deepseek-flash` 上**重現了**，限帶 `tool_use` 的歷史，見下一節。）
- **`cache_control` 被忽略**，但它有自己的自動前綴快取 —— 2026-09 實測回應裡有 `cache_read_input_tokens`。這一條原本寫成「沒有 prompt caching」，是錯的。

一個踩到的坑：**非串流的長生成會被砍連線**。跑一道要思考好幾分鐘的題目時，非串流請求憋著不吐任何位元組，連線會被收掉（`HTTPParserError: Invalid EOF state`）。Claude Code 一律走串流所以碰不到，但自己寫長生成的測試腳本時記得帶 `stream: true`。

### DeepSeek 補測（2026-09，`deepseek-flash`）

照 Claude Code v2.1.274 實際送出的形狀打（抓包與完整結果見 [`docs/claude-code-request-shapes.md`](docs/claude-code-request-shapes.md)）：

- **子 agent 讀不到 PDF。** Read 把 PDF 以 `document` block 放進工具結果，DeepSeek 把它換成 `[Unsupported Document]` 照樣回 200，模型只看得到檔名那一行。內建測試的「讀 PDF」會標出來。
  端到端實測時，一個子 agent 讀不到之後自己改用 Bash 看 PDF 的原始位元組，碰巧讀出了碼 —— 那是因為測試用的 PDF 沒壓縮，一般 PDF 行不通。
- **看圖可以。** 圖片放在工具結果裡（Read 讀圖、MCP 截圖都是這種）照樣看得到；真的 Claude Code 子 agent 經過 router 讀隨機配色的圖，兩次都答對。
- **快取命中很高。** 同一個子 agent 的後續請求 97–99%；設了 `CLAUDE_CODE_ATTRIBUTION_HEADER=0` 時，不同 session 之間也共用（見[已知限制](#已知限制)裡 `metadata` 那條）。
- **WebSearch 可以，但貴。** 子 agent 的 WebSearch 會分到 DeepSeek、由它代為搜尋，Claude Code 解析得動它的回應；一次約 3 萬 input tokens。
- **對話中間的 `role: "system"` 訊息看得到。** Claude Code 每一筆請求都有這種訊息，丟掉的話子 agent 會少一大段指示。
- **開著思考時，帶 `tool_use` 的 assistant 歷史必須附上 thinking**，否則 400。正常流程碰不到。規則在 agent 跑到一半從訂閱切過來時，Anthropic 留下的 thinking 送得過去；只有 `redacted_thinking` 會被拒。
- **context 超限的錯誤 router 會改寫。** DeepSeek 的上限是 1,048,576 tokens，**`max_tokens` 也算在內**；超過時回 OpenAI 措辭的 400，Claude Code 認不得，子 agent 直接以 API error 結束。provider 線上 router 把它改寫成 Anthropic 的 `prompt is too long: <requested> tokens > <limit> maximum`，Claude Code 就會先壓縮再接著做 —— 端到端實測，改寫前 task failed，改寫後 completed。
  會撞到的是 Claude Code 當成 1M 的子 agent（例如從 `opus[1m]` 繼承模型）：實測它不主動壓縮，`max_tokens` 又是 128000，累積到約 92 萬 tokens 就撞線。sonnet 子 agent 在 200K 前就自己壓縮，碰不到。點開那筆進條，「上游說法」會寫著已轉換。

### 內建的測試

GUI 上每個 provider 都能一鍵測。前三項是刻意簡化的單發請求，只問通不通；其餘各項照 Claude Code 子 agent **實際送出的請求形狀**打（v2.1.274 抓包，見 [`docs/claude-code-request-shapes.md`](docs/claude-code-request-shapes.md)）。分成兩級，因為壞掉的樣子完全不同：

**必要** —— 任一不過，Claude Code 在這個 provider 上就跑不起來

- **基本推論** — base URL / key / model 名三者對不對，順便回報上游實際回傳的 model 與 token 用量
- **SSE 串流** — Claude Code 的推論一律走串流。回報首位元組延遲與收到的 event 類型
- **工具呼叫** — Claude Code 幾乎每個 turn 都在 call tool，不支援等於完全不能用
- **串流工具迴圈** — 子 agent 每一輪的真實形狀：串流吐出 `tool_use`，再把整則 assistant 訊息（連同 thinking 與 `signature`）加上 `tool_result` 送回去。單發的工具呼叫測不到「`input_json_delta` 拼不拼得回 JSON」與「上游收不收自己吐的 thinking」

**能力** —— 不過也跑得起來、請求照樣 200，只是子 agent 用到那個能力時靜默失效

- **思考檔位** — `/effort` 到不到得了模型
- **中途 system 訊息** — Claude Code 每一筆請求都在對話中間夾著 `role: "system"` 訊息。丟掉的話子 agent 少一大段指示
- **看圖** — 圖片放在工具結果裡（Read 讀圖、MCP 截圖都是這種），模型要答對四格隨機顏色
- **讀 PDF** — `document` block 放在工具結果裡，模型要答出 PDF 裡的隨機碼。DeepSeek 在這項不過

能力項目的判定**看模型答不答得出只有它看得見的東西，不看狀態碼**：DeepSeek 把 PDF 換成佔位字之後照樣回 200。思考把 `max_tokens` 吃光、或模型不肯呼叫工具時標成「無法判定」，不會誣賴上游丟了內容。

看圖與讀 PDF 會先讓模型真的呼叫一次 Read，再把它自己那則回覆原樣送回去 —— 不能自己捏一則 assistant 訊息當歷史，DeepSeek 在思考模式下會因為缺 thinking 回 400，那個 400 會被誤判成看不到圖。

GUI 上必要項目沒過的那列用告警框框住；能力項目沒過的只推出機架，不發告警色。

**選配：WebSearch** 不在「執行測試」裡，要另外按「測 WebSearch」。子 agent 的 WebSearch 是另外發一筆強制使用 `web_search` server tool 的請求，會照規則分到 provider、由它代為搜尋；搜尋結果整包灌進 context，DeepSeek 上一次就要 3 萬 input tokens 上下。測試照抄那筆請求的形狀，只把 `max_uses` 從 8 壓到 1 —— 但 DeepSeek 不一定遵守，實測仍搜了 3 次。

思考檔位的判定依據是「Claude Code 的五個檔位有沒有哪個被回 400」—— 這是確定性的，而且上游的錯誤訊息通常直接點名欄位（DeepSeek 就是這樣把完整枚舉吐出來的）。

它曾經還會用 `low` 與 `max` 各跑一次比思考量，**已經拿掉**：那要多花兩次付費請求，而單次採樣分不出「上游沒把欄位接到檔位」和「這題對這個模型沒有解析度」。實測 Kimi K3 在那題上，六種送法（不帶 `output_config` 加五個檔位）各採樣 3 次，中位數全部落在 400～660 字元、範圍互相完全覆蓋，連基準線都分不出來 —— 但它其實是吃這個欄位的，換一道夠難的題目就有 4～5 倍差距（見上面 effort 段落）。花錢買一個「無法判定」不划算。真的要確認就自己挑一道對該模型難度合適的題目多採樣幾次。

「執行測試」總共打 15 個小請求（思考檔位 5 個、串流工具迴圈與看圖、讀 PDF 各 2 個），能力項目一律用子 agent 的思考形狀、檔位壓到 `low`。付費 provider 上留意一下。未儲存的設定也能直接測，測完滿意再按儲存。

### 只收本機來源的請求

兩台 server 都只綁 `127.0.0.1`，但那只擋得住別台機器，擋不住**你自己瀏覽器裡的網頁**：

- 網頁可以用 `content-type: text/plain` 發簡單請求（不觸發 preflight）打 `POST /api/test`，把 `apiKey` 填保留值、`baseUrl` 填自己的網域 —— router 會把真的 API key 還原出來送過去，攻擊者不必讀得到回應。
- 攻擊者的網域重綁到 `127.0.0.1`（DNS rebinding）之後對瀏覽器就是同源，可以自由 `PUT /api/config` 把 `passthrough.baseUrl` 換掉，主對話的下一個請求就會把訂閱的 OAuth token 送給他。

所以兩台 server 都會檢查來源，不通過回 `403`：

- **`Origin`** —— 沒有（Claude Code 走 undici，不送）或等於自己的 `http://127.0.0.1:<埠>` 才放行。沙箱 iframe 送的字串 `"null"` 不算「沒有」。
- **`Host`** —— 主機名必須是 `127.0.0.1` / `localhost` / `[::1]`。只驗主機名不驗埠：rebinding 情境下瀏覽器送的埠本來就是我們綁的那個，比對它擋不到東西，卻會誤殺埠轉發。

`Origin` 擋一般 CSRF，`Host` 擋 rebinding，兩個都要。

## 已知限制

- Anthropic 官方文檔明說「doesn't support routing Claude Code to non-Claude models through any gateway」。不是禁止，是壞了自己修。
- Claude Code v2.1.196 起，`ANTHROPIC_BASE_URL` 指向非 Anthropic host 時 **Remote Control 會停用**。
- `/fast` 的可用性檢查與 WebFetch 網域安全檢查直連 `api.anthropic.com`，不經過 router。
- Claude Code 每次升級都可能新增 body 欄位，寬容度低的第三方收到會回 `400`。**先看下面那條的順序再決定怎麼修**，別反射性地往 `dropFields` 加。
- **`anthropic-beta` 與 body 欄位是成對的。** 官方文檔明說：capability 的 header 與 body 欄位一起走，「a gateway that strips the header while passing the body … produces hard `400` errors；only when both halves are absent together does the feature turn off quietly」。而 `dropBeta: true` + `dropFields: []`（目前的預設）正好就是「剝 header、留 body」。實測 Kimi 1668 筆與 DeepSeek 都零 `400`，所以預設沒動；但真的撞到 `400` 時，修法的優先序是：
  1. 把 `dropBeta` 關掉，讓 header 與 body 成對抵達上游
  2. 還是不行就在 Claude Code 那頭設 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`，兩半一起不送 —— 這是官方指定的解法，代價是它**全域生效**，訂閱線也會少掉那些 capability
  3. 最後才動 `dropFields`，而且一次只加一個。整組刪掉會連帶關掉 `/effort`，且請求照樣 200，只是模型變笨
- provider 線上唯一會被改寫的回應是 **context 超限的錯誤**（原因見 [DeepSeek 補測](#deepseek-補測2026-09deepseek-flash)），其餘錯誤回應原樣轉出。
- `dropFields`、`maxOutputTokens`、`extraHeaders` 只作用在要送去 provider 的請求。passthrough（訂閱）那條線是原始 bytes 原樣轉發，連 JSON 都不重新序列化，主對話的思考檔位不受任何影響 —— 唯一的例外是規則設了 `modelOverride`，那筆會重新序列化，但也只換 `model` 一個欄位。
- **送去 provider 的請求一律拿掉 `metadata`。** Claude Code 在 `metadata.user_id` 裡放了 claude.ai 的 `account_uuid` 與 `device_id`（實測 v2.1.274），那是訂閱帳號的識別資訊。這一項沒有開關；訂閱線照舊原樣轉發。點開進條的「送出前改寫」會看到 `-metadata`。
  對快取的影響是**正面的**：DeepSeek 拿 `user_id` 做 KV cache 分區（[文檔](https://api-docs.deepseek.com/quick_start/rate_limit)），而 Claude Code 的 `user_id` 裡帶著 `session_id`，等於每個 session 各自一個分區、新 session 一律從冷快取開始。實測（2026-09，`deepseek-flash`）同一分區重送命中 94–96%、換分區 0%，空 id 的分區快取照常；拿掉之後，新 session 的第一筆子 agent 請求就命中了上一個 session 留下的快取（92%）。一般帳號的並發上限本來也是所有 `user_id` 合計，拿掉不影響。
- `/v1/messages/count_tokens` 若 provider 不支援會回 404，Claude Code 會自動退回用推論端點估算，不影響運作。
- 建議一併設 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`。Claude Code 會在 system prompt 前面加一段 attribution block，只有 `api.anthropic.com` 會自動剝除，第三方 provider 會把它當 prompt 收下去。

## 文檔

- [`docs/refactor-2026-08.md`](docs/refactor-2026-08.md) —— 2026-08 那次重構的前後對照：
  補上的本機來源守衛、依路由分開的重試策略、以及每項改動背後的實測數據。
- [`docs/claude-code-request-shapes.md`](docs/claude-code-request-shapes.md) —— Claude Code v2.1.274 實際送出的請求形狀
  （Read 圖片 / PDF、WebSearch、Workflow schema、中途 system 訊息）與 DeepSeek 對每一種的實測反應。內建測試照這份打；Claude Code 升級後用 `node scripts/capture-shapes.mjs` 重抓。
- [`PRODUCT.md`](PRODUCT.md) —— 產品事實：使用者、使用時機、術語、技術約束、已知限制。
- [`DESIGN.md`](DESIGN.md) —— 視覺系統：色彩、字體、狀態的三個冗餘通道、資訊架構。
- [`design/`](design/) —— 介面設計稿，`.dc.html` artboard 可以直接用瀏覽器開。

改介面之前先讀 `PRODUCT.md` 與 `DESIGN.md` —— 兩份都是規格，不是筆記。

## 測試

```bash
npm test
```

煙霧測試會起一個假上游，驗證路由決策、body 改寫、header 處理與 SSE 串流不被緩衝，不會對外連線。
CI 在 Linux 與 Windows × Node 20 / 22 / 24 上跑同一份。

## 授權

[MIT](LICENSE)
