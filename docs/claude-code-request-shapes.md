# Claude Code 實際送出的請求形狀（v2.1.274，2026-09）

內建測試的每一項都照這裡記錄的形狀打。形狀抄錯，測到的就是別的東西 —— 這件事實際發生過：看圖測試第一版自己捏了一則「assistant 呼叫 Read」當歷史、沒附 thinking，DeepSeek 回 `400 The content[].thinking in the thinking mode must be passed back to the API`，結果被判成「看不到圖片」。

## 怎麼抓的

```bash
node scripts/capture-shapes.mjs                       # 五個劇本全跑，輸出到暫存目錄
node scripts/capture-shapes.mjs image,pdf             # 只跑其中幾個；--out <目錄> 指定輸出位置
```

腳本把 `ANTHROPIC_BASE_URL` 指向本機一個照劇本回 SSE 的假上游，用
`claude -p --setting-sources project --strict-mcp-config --model opus[1m] --effort xhigh`
驅動 Claude Code 依序走過：Read 讀圖片、Read 讀 PDF（整份與指定頁數）、WebSearch、開一個 sonnet 子 agent 在裡面讀圖加搜尋、跑一個帶 `schema` 的 Workflow `agent()`。Claude Code 升級後重跑一次，對照這份文檔。

- 假上游不打真的 API，不花訂閱額度。全部跑完約 1.5 分鐘，大半在等 Workflow。
- `requests.jsonl` 只記結構，可以直接貼進來：文字只記長度；帶憑證與身分的 header、`metadata.user_id` 裡的 `account_uuid` 與 `device_id` 只記鍵名；認不得的欄位只記形狀。測試裡有斷言守著。
- `claude-<劇本>.jsonl` 是 Claude Code 的 stream-json 原樣輸出（含本機路徑與 session id），只給自己除錯用，不要貼出去。
- `--setting-sources project` 是為了不載入使用者層的 hooks（會對外回報 session 事件）。
- 找不到 `claude` 時用 `CLAUDE_BIN` 指定執行檔。
- 加了 `--no-session-persistence`，Claude Code 仍會在 `~/.claude/projects/` 下留一個以輸出目錄命名的資料夾（子 agent 與 Workflow 的中繼資料，幾 KB），跑完可以刪。

## 每一筆推論請求都有的

| 項目 | 形狀 |
| --- | --- |
| `anthropic-beta` | 主對話（`opus[1m]`）：`claude-code-20250219, oauth-2025-04-20, context-1m-2025-08-07, interleaved-thinking-2025-05-14, thinking-token-count-2026-05-13, context-management-2025-06-27, prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07, mid-conversation-tool-changes-2026-07-01, advisor-tool-2026-03-01, effort-2025-11-24`，主迴圈另加 `fallback-credit-2026-06-01, extended-cache-ttl-2025-04-11`。sonnet 子 agent 少了 `context-1m`、`mid-conversation-tool-changes`、`fallback-credit`、`extended-cache-ttl` |
| `metadata.user_id` | 一段 JSON 字串，含 `device_id`、claude.ai 的 `account_uuid`、`session_id`。**router 在 provider 線上會拿掉整個 `metadata`** |
| 思考 | `thinking: {type: "adaptive"}`（Workflow agent 多了 `display: "omitted"`）、`context_management.edits: [clear_thinking_20251015, keep: all]`、`output_config: {effort}` |
| `max_tokens` | opus 128000、sonnet 64000 |
| `system` | 三個 text block，後兩個帶 `cache_control`（主對話 `ttl: "1h"`，子 agent 預設 5 分鐘） |
| `messages` | 第一則 user 由好幾個 text block 組成，**緊接著一則 `role: "system"`**（主對話約 8.6K 字元，子 agent 也有）；結尾常再有一則帶 `cache_control` 的 `role: "system"`。`tool_use`、`tool_result` 也帶 `cache_control` |
| `tools` | 沒有 `strict`、沒有 `defer_loading` —— 自訂 base URL 下 tool search 預設關閉，實測吻合 |

`role: "system"` 不是標準 Messages API 的角色。上游收下卻丟掉時，子 agent 會少掉 Claude Code 放在那裡的指示而且不報錯，所以「中途 system 訊息」是一個獨立的測試項。

## Read

**圖片**：`tool_result.content = [{type: "image", source: {type: "base64", media_type: "image/png", data}}]`。主對話與子 agent 相同。子 agent 看圖只會走這條 —— 使用者貼進對話框的圖片在主對話，走訂閱。

**PDF（整份）**：`tool_result.content = [{type: "text", text: "PDF file read: <path> (<n> bytes)"}, {type: "document", source: {type: "base64", media_type: "application/pdf", data}}]`。

**PDF（指定 `pages`）**：Claude Code 要先用 `pdftoppm` 轉成圖片。沒裝 poppler 時直接回一個 `is_error` 的 tool_result，根本不會送到上游 —— 這跟 provider 無關。

## WebSearch

不是在主請求裡掛 server tool，而是**另外發一筆請求**：

```jsonc
{
  "model": "claude-opus-5",           // 主對話的模型，即使發起的子 agent 跑 sonnet
  "tool_choice": { "type": "tool", "name": "web_search" },
  "tools": [{ "type": "web_search_20250305", "name": "web_search", "max_uses": 8 }],
  "thinking": { "type": "disabled" },
  "output_config": { "effort": "high" },
  "stream": true,
  "messages": [{ "role": "user", "content": "<一句話的搜尋指示>" }]
}
```

從子 agent 發出時帶著 `x-claude-code-agent-id`，所以**照規則分到 provider，由 provider 代為搜尋**。模型最後收到的 tool_result 是一段字串：`Web search results for query: "..."` 加上連結清單。

## Workflow `agent({ schema })`

不靠 `output_config.format`。Claude Code 在工具清單裡多掛一個 `StructuredOutput` 工具，`input_schema` 就是 script 給的 schema，沒有 `tool_choice` 強制；輸出由 Claude Code 自己驗證，不合格重試（`MAX_STRUCTURED_OUTPUT_RETRIES`，預設 5）。所以在第三方上它就是一般的工具呼叫能力，不需要上游支援 structured outputs。

Workflow agent 的工具清單裡沒有 `Agent` 與 `Workflow`，與 README「三種來源」一節的舊實測一致。

`output_config.format`（`json_schema`）只出現在主對話的背景請求上，例如產生 session 標題那一筆（`thinking: disabled`、沒有 agent-id），一律走訂閱。

## DeepSeek 實測（2026-09-17，`deepseek-flash`）

端點 `https://api.deepseek.com/anthropic`。

| 送過去的形狀 | 結果 |
| --- | --- |
| `tool_result` 裡的 image | 看得到，四格顏色全答對 |
| `tool_result` 裡的 document（PDF） | **200，但 PDF 被換成 `[Unsupported Document]`**，模型看不到內容 |
| 對話中間與結尾的 `role: "system"`（含 `cache_control: {ttl: "1h"}`） | 兩個位置的碼都答對 |
| WebSearch 那筆內部請求 | 會代為搜尋。端到端讓 Claude Code 解析 DeepSeek 的真實回應（當時在抓包腳本裡臨時把這一筆轉給 DeepSeek；進 repo 的版本拿掉了這段，不碰 API key）：子 agent 拿到 10 個連結。**一次約 3 萬 input tokens**。把 `max_uses` 壓到 1 並強制 `tool_choice` 時仍搜了 3 次，所以它不見得遵守 `max_uses` |
| 開著思考、帶 `tool_use` 的 assistant 歷史沒附 thinking | **400** `The content[].thinking in the thinking mode must be passed back to the API.` |
| 同上，但 `thinking: disabled` | 200 |
| 帶 `tool_use` 的歷史附上別家的 thinking（空內容加任意 `signature`） | 200 —— 規則從訂閱切到 DeepSeek 時，Anthropic 留下的 thinking 送得過去 |
| 歷史裡有 `redacted_thinking` | **400** `unknown variant redacted_thinking` |
| 完全不帶 `thinking` 欄位 | 預設會思考；`max_tokens` 給得小時全被思考吃光，回覆是空字串 |
| `cache_control` | 被忽略，但回應裡有 `cache_read_input_tokens`：它有自己的自動前綴快取 |
| 串流的 `usage` | `message_start` 就帶正確的 `input_tokens`，Claude Code 算 context 用量靠這個 |
| `metadata.user_id` | [文檔](https://api-docs.deepseek.com/quick_start/rate_limit)說拿來做內容安全歸屬、KV cache 隔離與排程隔離。實測是真的隔離：約 4K tokens 的隨機前綴，同一個 `user_id` 重送命中 94–96%，換 `user_id` 或拿掉都是 0%；不帶 `user_id` 的那個分區照常快取（94–96%）。兩輪結果相同 |
| context 上限 | 文檔：`deepseek-v4-flash` / `deepseek-v4-pro` 都是 1M，最大輸出 384K。Claude Code 替 sonnet 子 agent 假設 200K、`opus[1m]` 假設 1M（抓包的 `modelUsage.contextWindow`），都不超過 |

### 端到端：真的 Claude Code 經過 router

`claude -p --model sonnet`，主對話走訂閱，叫一個 sonnet 子 agent（分到 DeepSeek）讀一張隨機配色的 PNG 和一份含隨機碼的 PDF；設了 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`，同一個流程跑兩個獨立 session。

- 看圖：兩個 session 都答對。
- PDF：第一個 session 試了 `pages` 參數（沒裝 `pdftoppm`，失敗）後誠實回 `NONE`；第二個 session 改用 Bash 看 PDF 的原始位元組，讀出了碼 —— 測試 PDF 沒壓縮才行得通。
- 快取（流量記錄的 `usage`）：子 agent 在同一 session 內 97–99%；**第二個 session 的第一筆子 agent 請求就命中 92%**，吃到的是第一個 session 留下的快取。帶著 Claude Code 原本的 `metadata`（`user_id` 含 `session_id`）時，照上面的分區實驗這一筆會是 0%。主對話走訂閱，第二輪起 99–100%。
- 每一筆子 agent 請求的「送出前改寫」都有 `-metadata`。

對照 2026-08 在 `deepseek-v4-pro` 上的結論「多輪的 thinking block 不強制回傳」：那次沒有記下歷史裡有沒有 `tool_use`。這次在 `deepseek-flash` 上確認的是 —— 純文字的 assistant 歷史不附 thinking 照收（「中途 system 訊息」那項的歷史就是這種），帶 `tool_use` 的必須附。正常流程碰不到，Claude Code 送回去的本來就是 DeepSeek 自己吐的那一則。

### context 超限

DeepSeek 超限時的回應（實測：一筆約 115 萬 tokens 的請求，2 秒內被拒，沒進推論）：

```text
HTTP 400  content-type: application/octet-stream
{"error":{"message":"This model's maximum context length is 1048576 tokens. However, you requested 1150953 tokens (1150952 in the messages, 1 in the completion). Please reduce the length of the messages or completion.","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}
```

OpenAI 的措辭、外面沒有 Anthropic 的 `type: "error"`，而且**上限把 `max_tokens` 算在內**。

Claude Code 這一側用假上游量（一次性腳本，沒有進 repo）：子 agent 讀一次檔，下一筆請求回 400，看它接著送什麼。

| 子 agent 收到的錯誤 | Claude Code 的反應 |
| --- | --- |
| `prompt is too long: 250000 tokens > 200000 maximum` | 送一筆摘要請求，而且先截掉較舊的對話（開頭換成 `[earlier conversation truncated for compaction retry]`），再用摘要後的 context 繼續。task completed |
| `capability_rejected: prompt_too_long` | 也壓縮，但摘要請求沒截舊對話，比超限的那一筆還大 |
| OpenAI 措辭，包在 Anthropic 的格式裡 | 不重試、不壓縮。task failed：`Agent terminated early due to an API error` |
| DeepSeek 原樣的回應 | 同上，failed |
| DeepSeek 原樣的回應，經過 router | router 改寫成第一列的格式；壓縮後繼續，completed |

主動壓縮也量了：在 `message_start` 回報很大的 `input_tokens`，看下一筆是不是摘要請求。

- sonnet 子 agent（Claude Code 當成 200K）：回報 190K 就壓縮。
- 從 `opus[1m]` 繼承模型的子 agent（當成 1M，`max_tokens` 128000）：回報到 1,100,000 都照常送，不主動壓縮。

所以在 DeepSeek 上，1M 的子 agent 累積到約 92 萬 tokens（1,048,576 − 128,000）一定撞上 400，活不活得下來全看 Claude Code 認不認得那個錯誤。router 在 provider 線上把 OpenAI 措辭的超限錯誤改寫成 `prompt is too long: <requested> tokens > <limit> maximum`，數字照搬。反過來調 Claude Code 的壓縮門檻行不通：`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 是全域的，主對話會一起被拖累。

## 還沒驗的

- **別家 provider 的超限措辭**：router 只認 DeepSeek 實測到的那一句 OpenAI 措辭。措辭不同的 provider，子 agent 超限時照樣會失敗；要接的時候先打一筆超限請求看它回什麼。
- **`redacted_thinking`**：DeepSeek 收到會 400，只在規則於 agent 跑到一半從訂閱切到 DeepSeek 時碰得到。本機 1639 份 Claude Code 對話記錄（2026-08～09，含子 agent）裡帶 thinking 的超過 5 萬行，`redacted_thinking` block 一個都沒有，所以沒處理。前提是 Claude Code 會把它原樣存進記錄 —— 沒有實例可以確認。
