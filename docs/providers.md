# Provider 相容性筆記

對應 README 的「Documentation」表格裡「Provider compatibility notes, the
built-in tests, and measurements」。這裡講 router 對 provider 線的請求改了什麼、
思考檔位（`/effort`）在 wire 上怎麼走、DeepSeek 的實測結果（2026-08 與 2026-09
補測），以及 GUI 內建的測試在驗什麼。

## router 對請求改了什麼

provider 線的改寫是固定的，沒有開關（`src/proxy.mjs` 的 `buildProviderHeaders` 與
`rewriteBodyForProvider`）：

| | 做了什麼 |
| --- | --- |
| header | 從零組起：`content-type`、provider 自己的 key、從 client 帶過去的 `anthropic-version` 與 `anthropic-beta`。client 的 `authorization`、`cookie`、`x-claude-code-*` 一律不帶 |
| `model` | 換成規則的 `modelOverride`，其次 provider 的 `model`，都沒有就照原樣 |
| `metadata` | 整個拿掉，理由見 [security.md](security.md#送去-provider-的請求一律拿掉-metadata) |
| 其餘 body | 一個字不動，包括 `thinking`、`output_config`、`context_management`、`cache_control` 與對話中間的 `role: "system"` 訊息。整包重新序列化，但鍵的順序不變 |

`anthropic-beta` 照官方 gateway protocol 原樣轉發，body 裡的 `context_management`、
`effort` 這些欄位才有成對的 header。2026-09 對 DeepSeek 實測：帶 Claude Code 完整的
beta 清單（13 個，含 `oauth-2025-04-20`、`extended-cache-ttl-2025-04-11`）與完全不
帶，串流與非串流都是 200，快取命中的 token 數也一樣。Kimi 在這個改動之後還沒驗過。

Claude Code 升級後新增的 body 欄位或 beta，provider 不收時會回 400，流量記錄裡看得
到 provider 自己的錯誤訊息。router 不提供剝欄位的開關：剝掉 `output_config` 這類欄位
是靜默降級，請求照樣 200、模型變笨，比一個看得見的 400 更難發現。

## 思考檔位（effort）會不會跟著過去

會，router 不動這幾個欄位。

`/effort` 與 `--effort` 在 wire 上走的是 **`output_config.effort`**，不是
`thinking`。實測 v2.1.227 送出的 body：

```jsonc
{
  "thinking": { "type": "adaptive", "display": "omitted" },   // 只有型態，不帶檔位
  "output_config": { "effort": "xhigh" },                     // ← 檔位在這
  "context_management": { "edits": [{ "type": "clear_thinking_20251015", "keep": "all" }] }
}
```

換 `--effort low` / `max` 時只有 `output_config.effort` 的值變，其餘不動。

實測 cliproxyapi（→ Kimi K3）確實會讀這個欄位並映射到思考檔位，同一道多步推理
題各採樣 4 次的 thinking 長度：

| 送出的 effort | thinking 長度（中位數） |
| --- | --- |
| 不帶 `output_config` | ~19800 字元 |
| `low` | ~1500 字元 |
| `xhigh` | ~7100 字元 |

單次波動不小（LLM 本來就隨機），但 `low` 與 `xhigh` 差 4～5 倍是穩定訊號。
cliproxyapi 官方另外支援 model 名後綴語法（`kimi-k3(low)` / `kimi-k3(high)`），
實測也有效，可以填在 `providers[].model` 當固定檔位用 —— 但那會蓋掉
`/effort`，一般不需要。

流量記錄的**思考**欄會顯示每一筆的 effort。

## DeepSeek 實測（2026-08，`deepseek-v4-pro`）

端點 `https://api.deepseek.com/anthropic`，`authStyle` 填 `bearer`。
Claude Code 送的欄位它全收：

| 送過去的東西 | 結果 |
| --- | --- |
| `thinking.type: "adaptive"` | 收。DeepSeek 文檔只寫 `enabled` / `disabled`，但 `adaptive` 照樣 200 |
| `output_config.effort` | 收，而且**這就是 DeepSeek 原生的檔位欄位**，router 不需要做任何轉換 |
| `context_management` | 收 |
| `max_tokens` | 到 200000 都收 |
| `anthropic-beta` | 官方文檔標 Ignored；2026-09 實測帶完整清單照常 200（見上面「router 對請求改了什麼」） |

故意送一個不存在的檔位，錯誤訊息會把完整枚舉吐出來：

```
unknown variant `banana`, expected one of `low`, `medium`, `high`, `xhigh`, `ultra`, `max`
```

比官方文檔多了 `medium` 和 `ultra`。但 Claude Code 的枚舉只有 `low` / `medium`
/ `high` / `xhigh` / `max`（v2.1.231 確認），所以 `ultra` 送不出去。

**檔位實際只有兩檔堪用。** 同一道組合題各採樣 5 次的 thinking 長度（全部
`end_turn`，無一撞 `max_tokens`）：

| effort | 中位數 | 範圍 |
| --- | --- | --- |
| `low` | 696 字元 | 598–872 |
| `medium` | 1741 字元 | 1136–2665 |
| `high` | 1374 字元 | 1222–2847 |
| `xhigh` | 1667 字元 | 1374–2496 |
| `ultra` | 1418 字元 | 1284–2821 |
| `max` | 1395 字元 | 1052–1980 |

`low` 的最大值（872）比其他所有檔的最小值（1052）還低，**區間完全不重疊**，
思考量與耗時都大約對半。`medium` 以上那五檔區間互相覆蓋、中位數排序還是亂的
（`medium` 最高、`max` 反而偏低），5 個樣本分不開，代表差異小於單次波動。
實務上就是：要省用 `/effort low`，往上調沒有意義。

DeepSeek [自己的文檔](https://api-docs.deepseek.com/guides/thinking_mode)有一張
映射表，說 `deepseek-v4-pro` 會把 `low` 抬成 `high`、`xhigh` 抬成 `max`，跟上面
的實測對不上（實測 `low` 明顯更短）。那張表掛著一條「will update the actual
mapped effort of `deepseek-v4-pro` in early August 2026」的註腳，看來已經生效、
只是文檔沒同步。

**model 名一定要填死**，因為 DeepSeek 對 `claude-*` 有一套自己的映射：

| 送過去的 model | DeepSeek 實際跑的 |
| --- | --- |
| `claude-opus-5`、`claude-opus-5[1m]` | `deepseek-v4-pro` |
| `claude-sonnet-5`、`claude-haiku-4-5-*` | `deepseek-v4-flash` |
| 非 `claude-` 開頭（例如 `kimi-k3`） | `400`，不是 fallback |

留空不改寫的話，同一個 `/effort` 會因為子 agent 要的是 opus 還是 sonnet 而
**靜默**跑在不同模型上，而流量記錄兩邊都顯示同樣的 effort，看不出差別。

兩個不用擔心的：

- **多輪的 thinking block 不強制回傳。** 整個拿掉、或保留但把 `signature`
  清空，第二輪都照樣 200 且答對。社群有回報 DeepSeek 要求 `content[].thinking`
  必須原樣送回，在 `deepseek-v4-pro` 上不重現。（2026-09 在 `deepseek-flash` 上
  **重現了**，限帶 `tool_use` 的歷史，見下一節。）
- **`cache_control` 被忽略**，但它有自己的自動前綴快取 —— 2026-09 實測回應裡有
  `cache_read_input_tokens`。這一條原本寫成「沒有 prompt caching」，是錯的。

一個踩到的坑：**非串流的長生成會被砍連線**。跑一道要思考好幾分鐘的題目時，非
串流請求憋著不吐任何位元組，連線會被收掉（`HTTPParserError: Invalid EOF
state`）。Claude Code 一律走串流所以碰不到，但自己寫長生成的測試腳本時記得帶
`stream: true`。

## DeepSeek 補測（2026-09，`deepseek-flash`）

照 Claude Code v2.1.274 實際送出的形狀打（抓包與完整結果見
[claude-code-request-shapes.md](claude-code-request-shapes.md)）：

- **子 agent 讀不到 PDF。** Read 把 PDF 以 `document` block 放進工具結果，
  DeepSeek 把它換成 `[Unsupported Document]` 照樣回 200，模型只看得到檔名那一
  行。端到端實測時，一個子 agent 讀不到之後自己改
  用 Bash 看 PDF 的原始位元組，碰巧讀出了碼 —— 那是因為測試用的 PDF 沒壓縮，一般
  PDF 行不通。
- **看圖可以。** 圖片放在工具結果裡（Read 讀圖、MCP 截圖都是這種）照樣看得到；真
  的 Claude Code 子 agent 經過 router 讀隨機配色的圖，兩次都答對。
- **快取命中很高。** 同一個子 agent 的後續請求 97–99%；設了
  `CLAUDE_CODE_ATTRIBUTION_HEADER=0` 時，不同 session 之間也共用（原因見
  [security.md](security.md#送去-provider-的請求一律拿掉-metadata)）。命中率怎麼
  看見 [observability.md](observability.md#快取命中率)。
- **WebSearch 可以，但貴。** 子 agent 的 WebSearch 會分到 DeepSeek、由它代為搜
  尋，Claude Code 解析得動它的回應；一次約 3 萬 input tokens。
- **對話中間的 `role: "system"` 訊息看得到。** Claude Code 每一筆請求都有這種訊
  息，丟掉的話子 agent 會少一大段指示。
- **開著思考時，帶 `tool_use` 的 assistant 歷史必須附上 thinking**，否則 400。正
  常流程碰不到。規則在 agent 跑到一半從訂閱切過來時，Anthropic 留下的 thinking
  送得過去；只有 `redacted_thinking` 會被拒，但本機 1639 份對話記錄裡一次都沒出
  現過。
- **context 超限的錯誤 router 會改寫。** DeepSeek 的上限是 1,048,576
  tokens，**`max_tokens` 也算在內**；超過時回 OpenAI 措辭的 400，Claude Code 認
  不得，子 agent 直接以 API error 結束。provider 線上 router 把它改寫成
  Anthropic 的 `prompt is too long: <requested> tokens > <limit> maximum`，
  Claude Code 就會先壓縮再接著做 —— 端到端實測，改寫前 task failed，改寫後
  completed。會撞到的是 Claude Code 當成 1M 的子 agent（例如從 `opus[1m]` 繼承模
  型）：實測它不主動壓縮，`max_tokens` 又是 128000，累積到約 92 萬 tokens 就撞
  線。sonnet 子 agent 在 200K 前就自己壓縮，碰不到。點開那筆進條，「上游說法」那
  一行會註明已改寫。

## router 只改寫一種回應

provider 線上唯一會被改寫的回應，就是上面那個 **context 超限的錯誤**：狀態碼照舊
是 400，只換掉 body 讓 Claude Code 認得出來。其餘錯誤回應原樣轉出；訂閱線本來就
是 Anthropic 的措辭，一個字都不動。

改寫只認 DeepSeek 實測到的那一種 OpenAI 措辭。措辭不同的 provider，子 agent 超限
時照樣會失敗 —— 要接的時候先打一筆超限請求看它回什麼（見
[claude-code-request-shapes.md](claude-code-request-shapes.md#還沒驗的)）。

## 內建的測試

GUI 上每個 provider 都能一鍵測（`src/probe.mjs`）。四項任一不過，Claude Code 在這個
provider 上就跑不起來：

- **基本推論** — base URL / key / model 名三者對不對，順便回報上游實際回傳的
  model 與 token 用量
- **SSE 串流** — Claude Code 的推論一律走串流。回報首位元組延遲與收到的
  event 類型
- **工具呼叫** — Claude Code 幾乎每個 turn 都在 call tool，不支援等於完全不能用
- **串流工具迴圈** — 子 agent 每一輪的真實形狀：串流吐出 `tool_use`，再把整則
  assistant 訊息（連同 thinking 與 `signature`）加上 `tool_result` 送回去。單發
  的工具呼叫測不到「`input_json_delta` 拼不拼得回 JSON」與「上游收不收自己吐的
  thinking」。這一項照子 agent 的思考形狀送（`thinking: adaptive`、
  `context_management`），檔位壓到 `low`

測試的 header 與 body 用 proxy 轉發子 agent 請求的同一套函式組（`buildProviderHeaders`、
`rewriteBodyForProvider`），所以測到的就是真的會送出去的樣子。總共 5 個小請求；未儲存
的設定也能直接測，測完滿意再按儲存。

看圖、讀 PDF、中途 `role: "system"` 訊息、`/effort` 檔位、WebSearch 這些「不支援也
照樣回 200、只是能力靜默失效」的差異，曾經也是內建測試，已經拿掉：它們回答的是換
provider 時問一次的問題，每跑一次多花十幾個付費請求。DeepSeek 在這幾項上的結果記在
上面兩節與 [claude-code-request-shapes.md](claude-code-request-shapes.md)；換別家
provider 時，照那份文檔的形狀自己打幾筆確認。

## 另見

- [configuration.md](configuration.md) —— `providers[]` 的欄位本身。
- [claude-code-request-shapes.md](claude-code-request-shapes.md) —— Claude Code
  v2.1.274 實際送出的請求形狀，以及 DeepSeek 對每一種的逐項實測。
- [measurements.md](measurements.md) —— Kimi K3 串流連線時長等一般性實測數據。
