# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

單一開發者，在自己的機器上。他同時開著 Claude Code 與這個 GUI（`http://127.0.0.1:8788`，通常在第二螢幕或另一個瀏覽器分頁），terminal 裡跑著 `npm start`。

他來這個畫面只有四個時機，全部由使用者本人確認：

1. **確認分流有沒有生效** —— 改完設定或重開 Claude Code 之後，要馬上知道主對話走訂閱、子 agent 走 provider，而且真的在動。
2. **出事了在查原因** —— Claude Code 畫面上寫 `will retry in 2m 26s` 或「回應可能不完整」，他來這裡查是誰擋的、429 還是 5xx、限流窗還剩多久。
3. **切換配額去向** —— 第三方配額見底時把規則的導向切回訂閱（或反過來）。這是最頻繁的操作，而且往往在 agent 正在跑的時候做。
4. **接新的 provider** —— 填 base URL / API key、跑四項測試、照上游的 400 錯誤訊息調 `dropFields`，直到跑得通。

## Product Purpose

讓 Claude Code 的主對話留在 claude.ai 訂閱，同時把子 agent 的流量分流到第三方 provider。

存在的理由是額度：ultracode / Workflow 一次展開幾十個子 agent，很容易撞到訂閱的 5 小時限制。把子 agent 丟給便宜的 provider，主對話的推理品質不受影響。

成功的定義是**使用者不必再想起這個程式**：分流照設定跑，出事時三秒內在畫面上看得到是誰擋的。

## Positioning

分流依據是 Claude Code 送出的 `x-claude-code-agent-id` header，不是 model 名。這是關鍵差異：Workflow 的 `agent()` 只吃 `sonnet | opus | haiku | fable` 四個 alias，在 workflow script 裡根本寫不出第三方的 model 名，所以任何「按 model 名分流」的方案都涵蓋不到 ultracode。看 header 完全繞開這件事。

第二個不可複製的點：**只設 `ANTHROPIC_BASE_URL`、不設任何憑證**，claude.ai 訂閱登入就會保留下來（官方 LLM gateway 文檔明載）。router 因此能在同一條連線上，逐筆決定這一筆由訂閱付帳還是由 API key 付帳。

## Operating Context

- 本機 Node 20+ 程式，零 npm 依賴。proxy 與 GUI 是兩個埠（預設 8788）。
- 使用者的其他工具：Claude Code 的 `/status`（驗證訂閱還在）、terminal、`grep` + `jq` 查 `traffic.log`。
- 設定同時有兩個前端：GUI 與手改 `config.json`。GUI 是 config.json 的完整前端，表格裡每一項都改得到。
- 除了 `proxyPort` / `adminPort` / `trafficLog` 之外，所有設定都是每筆請求現查的 —— 儲存後即時生效，不必重啟，正在跑的 agent 下一個請求就會改道。
- `traffic.log` 是 NDJSON，跨重啟保留；GUI 上那份只有最近 300 筆且重啟就沒。

## Capabilities and Constraints

**功能**（五個分頁）：Providers（憑證、model 改寫、authStyle、dropFields、extraHeaders、max_tokens 夾制、retry 覆寫、四項連通性測試）、路由規則（passthrough 預設去向 + 由上而下第一條命中的規則清單 + 規則預覽）、流量記錄（每 3 秒輪詢，11 欄）、進階（全域 retry、落檔、請求上限）、接入說明。

**術語**（不可改寫，程式與文檔共用）：`main` / `subagent` / `nested`（請求來源）、`passthrough`（訂閱那條線）、`provider`、`rule`、`modelOverride`、`dropFields`、`effort`。

**技術約束**：
- GUI 必須維持**單一自帶的 `src/ui/index.html`**，原生 JS、零建置步驟、零外部資源 —— 它由 admin server 直接讀檔吐出，沒有 bundler。
- 只綁 `127.0.0.1`，且 admin server 有來源檢查（它握有 API key 還原能力與整份設定的寫入權）。
- 沒有網路可用性假設：畫面上不能有任何外部 CDN、字型或圖片請求。
- 資料只有中繼資料，沒有 prompt 內容。這是刻意的隱私邊界，測試裡有斷言守著。

**已知限制**（產品事實，不是缺陷）：Anthropic 官方不支援把 Claude Code 導到非 Claude 模型；`ANTHROPIC_BASE_URL` 指向非 Anthropic host 時 Remote Control 會停用；`/fast` 與 WebFetch 的檢查直連 `api.anthropic.com` 不經過 router。

## Brand Commitments

- 名稱 `subagent-handoff`，全小寫。
- 介面語言繁體中文，技術術語（`passthrough`、`subagent`、`max_tokens`、header 名）保留原文不翻。
- 語氣：實測導向、講原因不講口號。現有文案大量出現「實測」「原因是」「代價是」，並且會主動說出取捨與已知空窗，例如「router 啟動後某個 session 的主對話還沒發過請求就先冒出子 agent 流量，那幾筆的目錄欄會是 –」。這個誠實的語氣是產品的一部分。

## Evidence on Hand

- `README.md`（27KB，繁體中文）：完整的機制說明、實測數據、每個欄位的理由。
- `traffic.log`（1.6MB NDJSON）：真實流量樣本，含 `target` / `status` / `attempts` / `rateLimit` / `effort` 等實際欄位形狀。
- 實測數據（README 記載，可引用）：一份 2711 筆的流量記錄裡 22 筆觸發重試，全部在訂閱線、全部是 429、全部三次都失敗、`retry-after` 一個都沒有；同期第三方線 1668 筆，0 個 5xx、0 個連線錯誤。
- header 行為實測基準版本：Claude Code v2.1.227。

**沒有的東西，未來的工作不得捏造**：沒有 logo、沒有品牌字型、沒有使用者研究、沒有第二個使用者、沒有價格或商業聲明。這是私人工具，不是產品。

## Product Principles

1. **先回答「現在正常嗎」，再讓人去查細節。** 四個使用時機裡有兩個是狀態確認，畫面必須先給答案再給資料。
2. **證據要看得見，不能靠 hover。** 失敗原因、重送次數、限流窗、命中的規則 —— 這些是使用者來的理由，不是補充說明。目前它們全在 `title` tooltip 裡，README 得用整節教人該把滑鼠移到哪。
3. **說明應該長在需要它的地方。** 現有的大段散文說明是真知識，但擋在控制項前面；它該貼著對應的控制項出現，而不是當開場白。
4. **改設定必須是即時、可逆、看得見後果的。** 切換配額去向常在 agent 正在跑時發生，使用者要能預期下一個請求會走哪裡。
5. **誠實優先於乾淨。** 已知空窗、被移除的 effort、200 但串流裡夾著 error 的請求 —— 這些都要標出來，不能為了畫面好看而抹平。

## Accessibility & Inclusion

單人本機工具，沒有外部合規要求。但既有實作把關鍵資訊全放在 `title` tooltip 上，這在鍵盤操作、觸控與文字選取上都取不到 —— 視為必須修掉的缺陷，不是可選的加分項。
