# 路由規則

對應 README 的「The two request kinds」與「Configuration」兩節裡提到的
`rules[]`。這裡講規則怎麼匹配、怎麼在配額用盡時切換，以及怎麼讓子 agent 跑跟主
對話不同的模型。欄位本身的說明見 [configuration.md](configuration.md)。

## 兩種來源分別是什麼

| 條件 | 判定依據 | 是誰 |
| --- | --- | --- |
| `main` | 沒有 `x-claude-code-agent-id` | 你在對話框裡打字的那條線 |
| `subagent` | 有 `x-claude-code-agent-id` | Claude Code 開出來的任何 agent。**Workflow / ultracode 的 `agent()` 全在這裡** |

子 agent 自己再開的 agent 另外帶 `x-claude-code-parent-agent-id`，但它一樣有
agent id，所以也算 `subagent`。router 曾經把它分成第三種 `nested`，已經拿掉：實測
Workflow 的 agent 拿到的工具集裡沒有 `Agent` 與 `Workflow`，不會再往下開一層，純
ultracode 場景下 `nested` 永遠不觸發。

## 配額快用完時切回訂閱

規則的「導向」可以直接選 `passthrough（訂閱）`，不是只有 provider 可選。

第三方配額見底時，把那條規則的導向從 provider 換成訂閱、按儲存就結束了 —— 不用
刪規則、不用清空 API key、也不用重啟 router。設定是每筆請求現查的，正在跑的
agent 下一個請求就會走訂閱，之後配額補回來再切回去。機架分頁的「交還給訂閱」鍵
一次把所有啟用中、指向 provider 的規則（主對話的規則也算）切過去並立即存檔；同一個
位置會換成「把規則改回原本的 provider」，按下去照原本的導向換回來。這個還原點存在
瀏覽器裡，重新整理頁面也還在。它只改已存設定裡的規則導向：畫面上其他還沒儲存的修改
不會被一起存，也不會被丟掉。

比「把規則停用」好的地方是規則排序還在：多條規則疊著時，停用會讓流量掉到下一條
規則去，而不是掉回訂閱。明確指向 `passthrough` 才是真的擋在那裡。

點開任何一張進條，「命中規則」那一行就寫著是哪一條吃下的，還是根本沒命中掉到
底板。

## 配額快用完、又不想讓 agent 中斷時：席位限速

切回訂閱是換一個地方花額度；如果兩邊都快見底，又不想讓正在跑的 agent 中斷（中斷的
子 agent 要主對話手動 resume），可以在機架分頁的席位卡上設「限速」：這個席位每分鐘
最多放行幾筆請求，超過的在 router 排隊。訂閱席位與每一家 provider 各自設、各自解除，
訂閱席位的限速連主對話一起算。實作在 `src/throttle.mjs`，GUI 走 `PUT /api/throttle`。

**限的是請求數，不是回覆的輸出速度。** token 在上游生成時就計費了，把回覆慢慢吐給
Claude Code 不會少花一個 token，只是間接拖慢下一輪；額度大多花在每輪重送的 input 上，
很短的 tool call 輪次限 output 速度也拖不慢。每條串流各自限速還會隨 fan-out 放大。
限請求數才是直接控制燒額度的速度，而且整個席位共用一個上限。

- **只限 `/v1/messages` 生成請求。** `count_tokens`、`/v1/models` 不花額度，不排隊。
- **一筆最多排 4 分鐘，到了照樣放行。** Claude Code 的 `API_TIMEOUT_MS` 與子 agent 的
  `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` 預設都是 600 秒，排隊期間沒有任何串流進度；
  限速是盡力而為，不能反過來害 agent 逾時。排隊發生在送出上游之前，不佔上游連線，
  也碰不到串流的 300 秒 byte watchdog。
- **解除時排著的全部立即放行**；改速度時排著的照新速度重排。
- **只存在記憶體。** 它是臨時措施，不寫進 `config.json`，重啟 router 就清掉。
- 排隊中的進條批註寫「席位限速・排隊中」；放行後流量記錄的 `waitMs` 記著排了幾毫秒
  （沒排隊是 `null`）。

## 主對話分到 provider 時，連帶跟過去的東西

`main` 規則指向 provider（例如訂閱的週額度用完了）時，過去的不只是你打字的那一輪。所有沒帶
agent-id 的推論請求都算 `main`，只要 model 符合那條規則的 `modelGlob`（預設 `*`）就一起過去：
session 標題、上下文壓縮、額度探針、Claude in Chrome 的輔助請求，以及 **auto mode 的權限分類器**
（[request-map.md](request-map.md)）。

- **auto mode 還能用，但判定的是 provider 的模型，不是 Claude。** Claude Code 以為自己在用
  Claude，照樣開放 auto mode；provider 不會回伺服器端的判定，Claude Code 就改成另外發分類器請求，
  而那些請求跟著 `main` 一起到 provider。實測 DeepSeek 擋下了 `git push --force`，但它擋不擋得住
  更隱晦的危險動作，沒有人驗過。額度用完時要用 auto mode，等於把「這個動作安不安全」交給那個模型。
- **子 agent 照它們自己的規則走。** 沒有指向 provider 的 `subagent` 規則時，它們一條都沒命中、
  落到底走訂閱（`src/routing.mjs` 的 `resolveRoute`）。子 agent 也分到 provider，這個 session
  才沒有任何推論到 Anthropic：不花訂閱額度，也不會「免費用到 Claude」。兩種情況下登入、遙測
  這些非推論的連線都照常連 Anthropic。

反過來，**只把子 agent 分到 provider** 時，子 agent 的動作是由 Claude 判定的，用的是訂閱額度：
分類器請求沒帶 agent-id，算 `main`。而且只要有一筆請求到了 provider，整個 session 就從伺服器端
判定改成每個動作另發一筆分類器請求，訂閱會比完全不分流時多花一點。

## 讓子 agent 跑跟主對話不同的模型

規則的 `modelOverride` 會把送出去的 `model` 名換掉，指向訂閱時也生效。

用途是 **Workflow / ultracode 的 `agent()` 沒指定模型時一律沿用主對話的模型** ——
主對話開 `fable`，整批 workflow agent 也會是 fable。想讓主對話留在 fable、子
agent 換成 opus，在 Claude Code 那頭做不到（`agent()` 的 `model` 參數要寫死在
workflow script 裡），只能在 router 這層改：

```jsonc
{
  "match": "subagent",
  "modelGlob": "*",
  "providerId": "passthrough",        // 還是走訂閱付帳
  "modelOverride": "claude-opus-5"    // 但送出去的 model 換掉
}
```

優先序是 `rules[].modelOverride` > `providers[].model` > 原樣沿用
（`src/routing.mjs` 的 `resolveModel`）。所以同一個 provider 可以被多條規則以
不同 model 使用，不必為了換 model 複製一份 provider。

反過來，workflow script 裡明確寫了 `agent({ model: 'opus' })` 的，可以用
`modelGlob` 把它們留在訂閱、其餘分到 provider：

```jsonc
[
  { "match": "subagent", "modelGlob": "*opus*", "providerId": "passthrough" },
  { "match": "subagent", "modelGlob": "*",      "providerId": "p-deepseek" }
]
```

model 名要填**上游看得懂的完整字串**，不是 `opus` / `sonnet` 這種 alias。不確定
就把主對話切到那個模型送一句話，再去流量記錄的「要求 model」欄複製實際送出的
值 —— GUI 的輸入框有幾個常見值的建議清單，但以流量記錄看到的為準。

兩個要知道的副作用：

- Claude Code 的 UI 仍然顯示你在對話框裡選的模型，實際跑的是改寫後的。要對照就
  看流量記錄的「要求 model」與「實送 model」兩欄。
- `max_tokens` 是 Claude Code 依原模型算的。改寫成上限較低的模型時可能被上游退
  件，這種情況只能調 `modelOverride` 或改回去。

## 改寫思考檔位

規則的 `effortOverride` 會把送出去的 `output_config.effort` 換掉，指向訂閱時也生效。

Claude Code 呼叫子 agent 時用它自己挑的檔位，但第三方模型適合的檔位不一定一樣。
規則本來就能用 `modelGlob` 分開 opus 與 sonnet，所以兩者可以各配一個檔位，就算打到
同一個 provider 也一樣：

```jsonc
[
  { "match": "subagent", "modelGlob": "*opus*",   "providerId": "p-deepseek",
    "modelOverride": "deepseek-flash", "effortOverride": "max" },
  { "match": "subagent", "modelGlob": "*sonnet*", "providerId": "p-deepseek",
    "modelOverride": "deepseek-flash", "effortOverride": "high" }
]
```

三條界線（`src/routing.mjs` 的 `resolveEffort`、`src/proxy.mjs` 的 `rewriteEffort`）：

- **請求本來沒帶 effort 就不補。** session 標題那類背景請求送 `thinking: disabled`、
  `output_config` 裡只有 `format`，補上檔位等於改掉它的行為。
- **值不驗證。** 上游不收會回看得見的 400。改寫發生在 router，所以送得出 Claude Code
  枚舉以外的檔位，例如 DeepSeek 的 `ultra`（[providers.md](providers.md#deepseek-實測2026-08deepseek-v4-pro)）。
  GUI 的輸入框只建議 Claude Code 自己的五檔。
- **只換 `effort`**，`output_config` 的其他欄位與 `thinking` 不動。

流量記錄的「思考」欄顯示實際送出的檔位，改寫過的不會壓暗；原本要求的檔位看進條的
「送出前改寫」（`effort high → max`）或記錄裡的 `effort` 欄位（`sentEffort` 才是送出的）。

檔位高不代表答得好：DeepSeek 的實測是 `medium` 以上幾檔的思考長度分不開，見
[providers.md](providers.md#deepseek-實測2026-08deepseek-v4-pro)。

## 規則預覽

路由分頁下方的預覽選一個來源、填一個 model 名，不必真的去 spawn 一個 agent。預覽
走的是跟真正轉發同一份 `resolveRoute`，而且用的是畫面上還沒儲存的規則。

跑完之後機架上會標出這一筆由哪條吃下（`HIT`）、它下面哪幾條被遮住（`SHDW`），上
面比對過但沒命中的標 `PASS`；一條都沒命中時，標起來的是最底下的機架底板。

沒跑過預覽以前規則一律不標記，每條只印自己的 `ON` / `OFF`。標記亮著的時候，排程
順序的抬頭會掛出模擬中的標示與這次模擬的條件，旁邊有一顆鍵可以收掉；改到任何一條
規則也會把標記收掉 —— 那份模擬已經不是在講現在這份規則了。

## `modelGlob` 比對不分大小寫

`globMatch`（`src/routing.mjs`）把 pattern 轉成的正規表示式帶了 `i` flag，
`*` 以外的字元（包括 `.`）一律照字面比對。
