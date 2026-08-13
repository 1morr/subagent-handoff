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

1. **Providers** 分頁填 Base URL、API Key、Model，按「執行測試」確認三項全過
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
| `rules[]` | 由上而下取第一條命中者。條件為 `any` / `main` / `subagent` / `nested`，另可用 `modelGlob`（支援 `*`）再篩 |
| `rules[].providerId` | 導向哪個 provider。填保留值 `passthrough` = 明確導回訂閱 |

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

### 內建的三項測試

GUI 上每個 provider 都能一鍵測，對應 Claude Code 實際會用到、也最常在相容層上壞掉的能力：

- **基本推論** — base URL / key / model 名三者對不對，順便回報上游實際回傳的 model 與 token 用量
- **SSE 串流** — Claude Code 的推論一律走串流。回報首位元組延遲與收到的 event 類型
- **工具呼叫** — Claude Code 幾乎每個 turn 都在 call tool，不支援等於完全不能用

未儲存的設定也能直接測，測完滿意再按儲存。

## 已知限制

- Anthropic 官方文檔明說「doesn't support routing Claude Code to non-Claude models through any gateway」。不是禁止，是壞了自己修。
- Claude Code v2.1.196 起，`ANTHROPIC_BASE_URL` 指向非 Anthropic host 時 **Remote Control 會停用**。
- `/fast` 的可用性檢查與 WebFetch 網域安全檢查直連 `api.anthropic.com`，不經過 router。
- Claude Code 每次升級都可能新增 body 欄位，寬容度低的第三方收到會回 `400`。照錯誤訊息把欄位名加進該 provider 的 `dropFields` 即可 —— 一次只加一個，別整組刪掉，否則會連帶關掉 `/effort`。
- `dropFields` 只作用在被規則命中、要送去 provider 的請求。passthrough（訂閱）那條線是原始 bytes 原樣轉發，連 JSON 都不重新序列化，主對話的思考檔位不受任何影響。
- `/v1/messages/count_tokens` 若 provider 不支援會回 404，Claude Code 會自動退回用推論端點估算，不影響運作。
- 建議一併設 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`。Claude Code 會在 system prompt 前面加一段 attribution block，只有 `api.anthropic.com` 會自動剝除，第三方 provider 會把它當 prompt 收下去。

## 測試

```bash
npm test
```

煙霧測試會起一個假上游，驗證路由決策、body 改寫、header 處理與 SSE 串流不被緩衝，不會對外連線。
