# 路由規則

對應 README 的「The three request kinds」與「Configuration」兩節裡提到的
`rules[]`。這裡講規則怎麼匹配、怎麼在配額用盡時切換，以及怎麼按 agent 身分分流。
欄位本身的說明見 [configuration.md](configuration.md)。

## 三種來源分別是什麼

實測 Claude Code v2.1.227 送出的 header：

| 條件 | 判定依據 | 是誰 |
| --- | --- | --- |
| `main` | 兩個 header 都沒有 | 你在對話框裡打字的那條線 |
| `subagent` | 有 `x-claude-code-agent-id` | 第一層 agent。**Workflow / ultracode 的 `agent()` 全在這裡** |
| `nested` | 另外有 `x-claude-code-parent-agent-id` | 某個 subagent 又往下開的 agent |

**要涵蓋 ultracode，規則必須選 `subagent`。** Workflow 的 agent 沒有 parent
header，選 `nested` 一個都分流不到。（`src/routing.mjs` 的 `kindMatches` 裡，
`subagent` 這個 case 刻意把 `nested` 也涵蓋進去，所以反過來選 `subagent` 兩種都
吃得到；只有想**排除**一般 subagent、只抓巢狀 agent 時才需要選 `nested`。）

實測也確認 Workflow 的 agent 拿到的工具集裡沒有 `Agent` 與 `Workflow`，所以它們
不會再往下開一層 —— 純 ultracode 場景下 `nested` 永遠不觸發。`nested` 只在你手動
叫一個 general-purpose subagent、而它自己又去 spawn 別人時才出現。

## 配額快用完時切回訂閱

規則的「導向」可以直接選 `passthrough（訂閱）`，不是只有 provider 可選。

第三方配額見底時，把那條規則的導向從 provider 換成訂閱、按儲存就結束了 —— 不用
刪規則、不用清空 API key、也不用重啟 router。設定是每筆請求現查的，正在跑的
agent 下一個請求就會走訂閱，之後配額補回來再切回去。

比「把規則停用」好的地方是規則排序還在：多條規則疊著時，停用會讓流量掉到下一條
規則去，而不是掉回訂閱。明確指向 `passthrough` 才是真的擋在那裡。

點開任何一張進條，「命中規則」那一行就寫著是哪一條吃下的，還是根本沒命中掉到
底板。

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

model 名要填**上游看得懂的完整字串**，不是 `opus` / `sonnet` 這種 alias。不確定
就把主對話切到那個模型送一句話，再去流量記錄的「要求 model」欄複製實際送出的
值 —— GUI 的輸入框有幾個常見值的建議清單，但以流量記錄看到的為準。

兩個要知道的副作用：

- Claude Code 的 UI 仍然顯示你在對話框裡選的模型，實際跑的是改寫後的。要對照就
  看流量記錄的「要求 model」與「實送 model」兩欄。
- `max_tokens` 是 Claude Code 依原模型算的。改寫成上限較低的模型時可能被上游退
  件，這種情況只能調 `modelOverride` 或改回去。

## 按 agent 身分分流

規則的 `agentIdGlob` 比對 `x-claude-code-agent-id`，`*` = 不篩。

一般 subagent 的 id **每次 spawn 重新產生**，篩不出東西。但官方 gateway
protocol 文檔載明：

> Teammate agents, the named members of an agent team, **reuse a stable
> name-based ID** across reconnections.

所以這個欄位的實際用途是把 [agent team](https://code.claude.com/docs/en/agent-teams)
的 teammate 按角色拆開 —— 便宜的活丟第三方，需要推理品質的留在訂閱：

```jsonc
[
  { "match": "subagent", "agentIdGlob": "Explore*", "providerId": "kimi" },
  { "match": "subagent", "agentIdGlob": "*",        "providerId": "passthrough" }
]
```

主對話沒有這個 header，所以**永遠不會被非 `*` 的樣式命中** —— 不用擔心一條
agent 規則把主對話也捲進去。

規則預覽那格可以填 agent id 直接試，不必真的去 spawn 一個。

## `modelGlob` / `agentIdGlob` 比對不分大小寫

舊版文檔沒提過這件事：`globMatch`（`src/routing.mjs`）把 pattern 轉成的正規表示式
帶了 `i` flag，所以 `Explore*` 跟 `explore*` 對同一個 agent id 的比對結果一樣。
寫規則時不用刻意對齊 teammate 名字的大小寫。
