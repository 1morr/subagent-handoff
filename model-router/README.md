# model-router

讓 Claude Code 的**主對話留在 claude.ai 訂閱**，同時把**子 agent 的流量分流到第三方 provider**（Kimi、GLM、DeepSeek 或任何提供 Anthropic Messages 格式端點的服務）。附 Web GUI，可以隨時換 base URL / API key，並在切過去之前先測通不通。

主要用途：ultracode / Workflow 一次展開幾十個子 agent，很容易撞到 5 小時限制。把子 agent 丟給便宜的 provider，主對話的推理品質不受影響。

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
cd model-router
npm start
```

首次啟動會生出 `config.json`（已在 `.gitignore`），然後打開 <http://127.0.0.1:8788>：

1. **Providers** 分頁填 Base URL、API Key、Model，按「執行測試」確認四項全過
2. **路由規則** 分頁確認「所有子 agent → 你的 provider」
3. **接入說明** 分頁複製 `settings.json` 片段，重開 Claude Code
4. `/status` 確認 `Login method` 仍指向 claude.ai 帳號
5. 叫個子 agent 幹活，回 **流量記錄** 分頁確認分流生效

## 設定

`config.json` 也可以直接手改，GUI 只是它的前端。

| 欄位 | 說明 |
| --- | --- |
| `proxyPort` / `adminPort` | 分別是 proxy 與 GUI 的埠。改了要重啟；其他設定即時生效 |
| `passthrough.baseUrl` | 沒有規則命中時的去向，預設 `https://api.anthropic.com`。憑證原樣轉發，不做任何改寫 |
| `providers[].baseUrl` | 必須是 Anthropic Messages 格式的端點，router 會往 `{baseUrl}/v1/messages` 送 |
| `providers[].model` | 送出前把 `model` 改寫成這個值。留空 = 不改寫 |
| `providers[].authStyle` | `bearer`（`Authorization: Bearer`）或 `x-api-key` |
| `providers[].dropFields` | 送出前刪掉的 body 欄位。**預設空**，只在上游回 `400 unknown field` 時才照錯誤訊息填 |
| `providers[].dropBeta` | 移除 `anthropic-beta` header，預設 true |
| `providers[].maxOutputTokens` | `max_tokens` 上限，超過就夾住。留空 = 不夾 |
| `providers[].extraHeaders` | 額外 header |
| `retry.attempts` | 上游回可重送的錯誤時，router 自己額外重送幾次。預設 2，填 0 = 關掉 |
| `retry.baseDelayMs` / `retry.maxDelayMs` | 上游沒給 `retry-after` 時的指數退避起跳值與上限，實際等待會再加上抖動 |
| `retry.maxRetryAfterMs` | 上游的 `retry-after` 超過這個值就不自己扛，把回應交回 Claude Code。預設 10000 |
| `rules[]` | 由上而下取第一條命中者。條件為 `any` / `main` / `subagent` / `nested`，另可用 `modelGlob`（支援 `*`）再篩 |
| `rules[].providerId` | 導向哪個 provider。填保留值 `passthrough` = 明確導回訂閱 |
| `rules[].modelOverride` | 送出前把 `model` 改寫成這個值，蓋過 `providers[].model`。留空 = 不改寫。指向 `passthrough` 時一樣生效 |

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

流量記錄的「導向」欄滑鼠移上去會顯示命中的規則 id，可以確認切過去的是哪一條，還是根本沒命中掉下來的。

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

### 流量記錄的「目錄」欄是怎麼來的

同時開好幾個專案時，用來分辨哪一筆流量出自哪個 session。

header 裡**沒有** cwd（實測 v2.1.227 的 21 個 header 全查過），唯一的來源是 system prompt 最後一塊的 Environment 區段：

```
# Environment
You have been invoked in the following environment:
 - Primary working directory: C:\Users\Roxy\orca\projects\bridge
```

router 只用一條 regex 挖出這行路徑，system prompt 的其他內容一概不留 —— 測試裡有一條斷言守著這件事。

麻煩的是**子 agent 的 system prompt 沒有這個區段**，而子 agent 正是分流的主要對象。所幸實測子 agent 與主對話共用同一個 `x-claude-code-session-id`，所以由主對話的請求把 cwd 記進一張 `sessionId → cwd` 的表（LRU，上限 200 筆），子 agent 再回查。

因此有一個已知空窗：**router 啟動後，某個 session 的主對話還沒發過任何請求，就先冒出子 agent 流量**，那幾筆的目錄欄會是 `–`。實務上主對話一定先講話，很難碰到。

表格只顯示目錄名，滑鼠移上去看完整路徑。

### 上游暫時性失敗時 router 自己重送

Anthropic 的 429 / 529、第三方的 5xx、還有連線被中間的東西掐掉，都會讓 Claude Code 中斷對話並開始倒數（`attempt 9/10`）。這類失敗大多重送一次就過了，所以 router 先扛。

**重送只發生在還沒寫出任何一個 byte 給 client 的階段**：請求 body 完整留在記憶體，這時候重送是安全的，而且 client 完全不知道發生過。串流一旦開始轉發就不能重來 —— 那時候重送會讓 client 收到兩段接不起來的回應。

- 會重送：`408 409 429 500 502 503 504 529`，以及連線層的失敗（`fetch failed`、`terminated`）
- 不重送：其餘 4xx。請求本身有問題，重送幾次都一樣
- 上游有給 `retry-after` 就照它說的等；超過 `retry.maxRetryAfterMs` 就不自己扛，把回應交回去讓 Claude Code 顯示倒數 —— 使用者至少知道在等什麼，而不是對著一個沒反應的畫面等好幾分鐘
- 扛不住時交回去的是**上游最後一次的原始回應**，狀態碼與 body 都不改寫

流量記錄的狀態欄會顯示 `200 ×3`：送出去三次才成功，而 Claude Code 那頭只看到一次乾淨的 200。滑鼠移上去看每一次的失敗原因。

串流轉發到一半才斷線沒辦法重送，但 router 會補一個合法的 SSE `error` 事件收尾，而不是把連線砍掉 —— 被砍斷的串流只會讓 Claude Code 說「回應可能不完整」，連原因都拿不到。

### Claude Code 顯示「will retry in …」時該看哪裡

畫面上那句 `Waiting for API response · will retry in 2m 26s · check your network` 只說了「在等」，沒說是誰擋的。答案在流量記錄的**狀態欄**：

- 狀態是 `429` / `529` / `5xx` → **上游擋的**，router 只是照實轉發。滑鼠移上去看上游自己的說法（`rate_limit_error: …`、`overloaded_error: …`），以及 `retry-after` 與 `request-id`。
- 狀態欄直接寫著 `fetch failed` / `terminated` 這類文字 → **router 連不上上游**，client 收到的是 router 合成的 502。
- `client aborted` → 是 Claude Code 自己收手（按了 esc、subagent 被取消、上一輪結束）。這不是錯誤。
- **完全沒有對應的那一筆** → 請求根本沒送到 router，問題在 Claude Code 到 127.0.0.1 之間。

**畫面上倒數的秒數就是上游 `retry-after` 的值**，所以狀態欄顯示 `429 ·146s 後重試` 而畫面寫 `will retry in 2m 26s` 是同一件事，不是 router 卡住。

目錄欄是 `–` 時滑鼠移上去會顯示 **session id**；連 session id 都沒有，代表那筆根本不是 Claude Code 送來的，是別的東西打到了 router 的埠。

路徑欄滑鼠移上去是**請求的形狀**（messages 幾則、有沒有 system、是不是串流、`max_tokens`）。用來認出那些沒有目錄的背景請求 —— 例如上下文壓縮這種沒有 Environment 區段的請求，光看目錄欄是 `–` 分不出來，看形狀就一眼認得。形狀只有數量與有無，不含任何內容。

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

流量記錄的**思考**欄會顯示每一筆的 effort，被剝掉時標成 `xhigh → 已移除`，不用猜。

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

- **多輪的 thinking block 不強制回傳。** 整個拿掉、或保留但把 `signature` 清空，第二輪都照樣 200 且答對。社群有回報 DeepSeek 要求 `content[].thinking` 必須原樣送回，在 `deepseek-v4-pro` 上不重現。
- **`cache_control` 被忽略**，所以這條線沒有 prompt caching。長 system prompt 的子 agent 成本會比有快取的 provider 難看。

一個踩到的坑：**非串流的長生成會被砍連線**。跑一道要思考好幾分鐘的題目時，非串流請求憋著不吐任何位元組，連線會被收掉（`HTTPParserError: Invalid EOF state`）。Claude Code 一律走串流所以碰不到，但自己寫長生成的測試腳本時記得帶 `stream: true`。

### 內建的四項測試

GUI 上每個 provider 都能一鍵測，對應 Claude Code 實際會用到、也最常在相容層上壞掉的能力：

- **基本推論** — base URL / key / model 名三者對不對，順便回報上游實際回傳的 model 與 token 用量
- **SSE 串流** — Claude Code 的推論一律走串流。回報首位元組延遲與收到的 event 類型
- **工具呼叫** — Claude Code 幾乎每個 turn 都在 call tool，不支援等於完全不能用
- **思考檔位** — `/effort` 到不到得了模型。前三項全過也可能在這裡靜默失效

前三項任一不過，Claude Code 在這個 provider 上就跑不起來。第四項不一樣，它驗的是**不會報錯的那種壞**：`dropFields` 含 `output_config`，或上游收下欄位卻沒接到思考檔位，請求都照樣 200，只是模型變笨。

第四項的判定依據是「Claude Code 的五個檔位有沒有哪個被回 400」—— 這是確定性的，而且上游的錯誤訊息通常直接點名欄位（DeepSeek 就是這樣把完整枚舉吐出來的）。它另外會用 `low` 與 `max` 各跑一次比思考量，但那只寫進說明、不決定成敗 —— 單次採樣分不出「上游沒接線」和「這題對這個模型沒有解析度」。實測 Kimi K3 在這題上，六種送法（不帶 `output_config` 加五個檔位）各採樣 3 次，中位數全部落在 400～660 字元、範圍互相完全覆蓋，連基準線都分不出來；但它其實是吃這個欄位的，換一道夠難的題目就有 4～5 倍差距（見上面 effort 段落）。所以比值只有在夠大時才下正面結論，接近 1 一律不判定。要真的確認就換一道對該模型難度合適的題目多採樣幾次。

這一項會打 7 次請求（五個檔位各一次小探針，加兩次量測），比前三項慢，付費 provider 上留意一下。未儲存的設定也能直接測，測完滿意再按儲存。

## 已知限制

- Anthropic 官方文檔明說「doesn't support routing Claude Code to non-Claude models through any gateway」。不是禁止，是壞了自己修。
- Claude Code v2.1.196 起，`ANTHROPIC_BASE_URL` 指向非 Anthropic host 時 **Remote Control 會停用**。
- `/fast` 的可用性檢查與 WebFetch 網域安全檢查直連 `api.anthropic.com`，不經過 router。
- Claude Code 每次升級都可能新增 body 欄位，寬容度低的第三方收到會回 `400`。照錯誤訊息把欄位名加進該 provider 的 `dropFields` 即可 —— 一次只加一個，別整組刪掉，否則會連帶關掉 `/effort`。
- `dropFields`、`maxOutputTokens`、`extraHeaders` 只作用在要送去 provider 的請求。passthrough（訂閱）那條線是原始 bytes 原樣轉發，連 JSON 都不重新序列化，主對話的思考檔位不受任何影響 —— 唯一的例外是規則設了 `modelOverride`，那筆會重新序列化，但也只換 `model` 一個欄位。
- `/v1/messages/count_tokens` 若 provider 不支援會回 404，Claude Code 會自動退回用推論端點估算，不影響運作。
- 建議一併設 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`。Claude Code 會在 system prompt 前面加一段 attribution block，只有 `api.anthropic.com` 會自動剝除，第三方 provider 會把它當 prompt 收下去。

## 測試

```bash
npm test
```

煙霧測試會起一個假上游，驗證路由決策、body 改寫、header 處理與 SSE 串流不被緩衝，不會對外連線。
