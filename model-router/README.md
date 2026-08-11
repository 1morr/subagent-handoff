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
| `providers[].dropFields` | 送出前刪掉的 body 欄位，預設 `thinking` / `context_management` / `output_config` |
| `providers[].dropBeta` | 移除 `anthropic-beta` header，預設 true |
| `providers[].maxOutputTokens` | `max_tokens` 上限，超過就夾住。留空 = 不夾 |
| `providers[].extraHeaders` | 額外 header |
| `rules[]` | 由上而下取第一條命中者。條件為 `any` / `main` / `subagent` / `nested`，另可用 `modelGlob`（支援 `*`）再篩 |

### 三種來源分別是什麼

實測 Claude Code v2.1.227 送出的 header：

| 條件 | 判定依據 | 是誰 |
| --- | --- | --- |
| `main` | 兩個 header 都沒有 | 你在對話框裡打字的那條線 |
| `subagent` | 有 `x-claude-code-agent-id` | 第一層 agent。**Workflow / ultracode 的 `agent()` 全在這裡** |
| `nested` | 另外有 `x-claude-code-parent-agent-id` | 某個 subagent 又往下開的 agent |

**要涵蓋 ultracode，規則必須選 `subagent`。** Workflow 的 agent 沒有 parent header，選 `nested` 一個都分流不到。

實測也確認 Workflow 的 agent 拿到的工具集裡沒有 `Agent` 與 `Workflow`，所以它們不會再往下開一層 —— 純 ultracode 場景下 `nested` 永遠不觸發。`nested` 只在你手動叫一個 general-purpose subagent、而它自己又去 spawn 別人時才出現。

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
- Claude Code 每次升級都可能新增 body 欄位，第三方收到會回 `400`。照錯誤訊息把欄位名加進該 provider 的 `dropFields` 即可。
- `/v1/messages/count_tokens` 若 provider 不支援會回 404，Claude Code 會自動退回用推論端點估算，不影響運作。
- 建議一併設 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`。Claude Code 會在 system prompt 前面加一段 attribution block，只有 `api.anthropic.com` 會自動剝除，第三方 provider 會把它當 prompt 收下去。

## 測試

```bash
npm test
```

煙霧測試會起一個假上游，驗證路由決策、body 改寫、header 處理與 SSE 串流不被緩衝，不會對外連線。
