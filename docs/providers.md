# Provider 相容性筆記

對應 README 的「Documentation」表格裡「Provider compatibility notes and
measurements」。這裡講思考檔位（`/effort`）在 wire 上怎麼走、DeepSeek 的實測
結果，以及 GUI 內建的四項連通性測試在驗什麼。

## 思考檔位（effort）會不會跟著過去

會，但前提是 `dropFields` 不能把它刪掉。

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

所以 **`dropFields` 一旦包含 `output_config`，`/effort` 就完全失效** —— 而且
請求照樣回 200，只是模型變笨，不會有任何錯誤提示。這就是 `providers[].dropFields`
預設空陣列的原因（`src/config.mjs`）：換來一個看得見的 400，比靜默降級好。

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

流量記錄的**思考**欄會顯示每一筆的 effort，被剝掉時標成 `xhigh → 已移除`
（朱紅），批註欄同時寫著「/effort 被 dropFields 吃掉」，不用猜。

## DeepSeek 實測（2026-08，`deepseek-v4-pro`）

端點 `https://api.deepseek.com/anthropic`，`authStyle` 填 `bearer`。
**`dropFields` 保持空的，一個都不用加** —— Claude Code 送的欄位它全收：

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
  必須原樣送回，在 `deepseek-v4-pro` 上不重現。
- **`cache_control` 被忽略**，所以這條線沒有 prompt caching。長 system prompt
  的子 agent 成本會比有快取的 provider 難看。

一個踩到的坑：**非串流的長生成會被砍連線**。跑一道要思考好幾分鐘的題目時，非
串流請求憋著不吐任何位元組，連線會被收掉（`HTTPParserError: Invalid EOF
state`）。Claude Code 一律走串流所以碰不到，但自己寫長生成的測試腳本時記得帶
`stream: true`。

## 內建的四項測試

GUI 上每個 provider 都能一鍵測（`src/probe.mjs`），對應 Claude Code 實際會用
到、也最常在相容層上壞掉的能力：

- **基本推論** — base URL / key / model 名三者對不對，順便回報上游實際回傳的
  model 與 token 用量
- **SSE 串流** — Claude Code 的推論一律走串流。回報首位元組延遲與收到的
  event 類型
- **工具呼叫** — Claude Code 幾乎每個 turn 都在 call tool，不支援等於完全不能用
- **思考檔位** — `/effort` 到不到得了模型。前三項全過也可能在這裡靜默失效

前三項任一不過，Claude Code 在這個 provider 上就跑不起來。第四項不一樣，它驗的
是**不會報錯的那種壞**：`dropFields` 含 `output_config`，或上游收下欄位卻沒接
到思考檔位，請求都照樣 200，只是模型變笨。

第四項的判定依據是「Claude Code 的五個檔位有沒有哪個被回 400」—— 這是確定性
的，而且上游的錯誤訊息通常直接點名欄位（DeepSeek 就是這樣把完整枚舉吐出來
的）。

它曾經還會用 `low` 與 `max` 各跑一次比思考量，**已經拿掉**：那要多花兩次付費
請求，而單次採樣分不出「上游沒把欄位接到檔位」和「這題對這個模型沒有解析度」。
實測 Kimi K3 在那題上，六種送法（不帶 `output_config` 加五個檔位）各採樣 3 次，
中位數全部落在 400～660 字元、範圍互相完全覆蓋，連基準線都分不出來 —— 但它其實
是吃這個欄位的，換一道夠難的題目就有 4～5 倍差距（見上面 effort 段落）。花錢買
一個「無法判定」不划算。真的要確認就自己挑一道對該模型難度合適的題目多採樣
幾次。

這一項會打 5 次請求（五個檔位各一次小探針），比前三項慢，付費 provider 上留意
一下。未儲存的設定也能直接測，測完滿意再按儲存。

## 另見

- [configuration.md](configuration.md) —— `providers[].dropFields` /
  `dropBeta` / `maxOutputTokens` / `extraHeaders` 等欄位本身。
- [measurements.md](measurements.md) —— Kimi K3 串流連線時長等一般性實測數據。
