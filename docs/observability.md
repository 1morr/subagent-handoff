# 觀測：流量記錄與 Rack 分頁

對應 README 的「Documentation」表格裡「The traffic log and reading the rack」。
這裡講流量記錄「目錄」欄怎麼來的、記錄怎麼落到磁碟上，以及 Claude Code 顯示
「will retry in …」時該去哪裡查是誰的問題。實測數據見
[measurements.md](measurements.md)，GUI 視覺規則見 [ui-notes.md](ui-notes.md)。

## 流量記錄的「目錄」欄是怎麼來的

同時開好幾個專案時，用來分辨哪一筆流量出自哪個 session。

header 裡**沒有** cwd（實測 v2.1.227 的 21 個 header 全查過），唯一的來源是
system prompt 最後一塊的 Environment 區段：

```
# Environment
You have been invoked in the following environment:
 - Primary working directory: C:\Users\dev\code\bridge
```

router 只用一條 regex（`src/routing.mjs` 的 `CWD_RE`）挖出這行路徑，system
prompt 的其他內容一概不留 —— 測試裡有一條斷言守著這件事。

麻煩的是**子 agent 的 system prompt 沒有這個區段**，而子 agent 正是分流的主要
對象。所幸實測子 agent 與主對話共用同一個 `x-claude-code-session-id`，所以由主
對話的請求把 cwd 記進一張 `sessionId → cwd` 的表（`SessionCwd`，`src/proxy.mjs`，
LRU，預設上限 200 筆），子 agent 再回查。

因此有一個已知空窗：**router 啟動後，某個 session 的主對話還沒發過任何請求，就
先冒出子 agent 流量**，那幾筆的目錄欄會是 `–`。實務上主對話一定先講話，很難
碰到。

欄位只顯示目錄名，點開進條看完整路徑。

## 流量記錄會留在磁碟上

GUI 上那份只有最近 300 筆，而且**重啟就沒了** —— 偏偏要查的事情常常橫跨重啟
（改完設定要重啟才生效，一重啟證據就跟著消失）。所以每一筆走完的請求會補寫成
一行 NDJSON 到 `traffic.log`（`src/logfile.mjs`）。

內容跟 GUI 看到的完全一樣：只有中繼資料，沒有 prompt。但它含有專案目錄與
session id，所以預設已經進 `.gitignore`。落檔用 `appendFileSync(..., { mode:
0o600 })`，同機的其他使用者讀不到（Windows 上這個 mode 會被忽略，無害但也不
生效，見 [security.md](security.md)）。

```bash
# 昨天所有非 200 的請求是誰擋的
grep -v '"status":200' traffic.log | jq -r '[.ts, .target, .status, .detail] | @tsv'
```

超過 `trafficLog.maxBytes` 會輪替成 `traffic.log.1`，只留一份舊的，所以磁碟最多
佔兩倍。`trafficLog.file` 留空就完全不落檔。落檔失敗時（例如 Windows 上檔案被
編輯器暫時鎖住）不會永久放棄：會冷卻一段時間再試，冷卻時間每次失敗翻倍、封頂在
30 分鐘，這段期間流量只留在記憶體那份 300 筆裡。

## Claude Code 顯示「will retry in …」時該看哪裡

畫面上那句 `Waiting for API response · will retry in 2m 26s · check your
network` 只說了「在等」，沒說是誰擋的。答案在流量記錄的**狀態欄**：

- 狀態是 `429` / `529` / `5xx` → **上游擋的**，router 只是照實轉發。這種進條會
  被推出機架整格、加一圈朱紅框，批註欄寫著「上游擋的」；點開看上游自己的說法
  （`rate_limit_error: …`、`overloaded_error: …`），以及 `retry-after` 與
  `request-id`。
- 狀態欄直接寫著 `fetch failed` / `terminated` 這類文字 → **router 連不上
  上游**，client 收到的是 router 合成的 502。
- `client aborted` → 是 Claude Code 自己收手（按了 esc、subagent 被取消、上一輪
  結束）。這不是錯誤。
- **完全沒有對應的那一筆** → 請求根本沒送到 router，問題在 Claude Code 到
  127.0.0.1 之間。

上游**有給** `retry-after` 時，畫面上倒數的秒數就是它的值，所以狀態欄顯示
`429 ·146s 後重試` 而畫面寫 `will retry in 2m 26s` 是同一件事，不是 router 卡住。

但訂閱線的 429 實測**不帶** `retry-after`（21 筆全部是空的），那時候畫面的倒數
是 Claude Code 自己算的。這種情況下限流資訊在 `anthropic-ratelimit-*` 那組
header 上，router 會整組收進流量記錄（`collectRateLimit`，`src/proxy.mjs`）：
批註欄改寫「上游擋的・3586s 後重置」，點開進條的「限流」那一行有完整的鍵值。

目錄欄是 `–` 時，批註欄會寫「cwd 表還沒建立」；連 session id 都沒有時會改寫
「沒有 session id・不是 Claude Code 送來的」—— 那筆是別的東西打到了 router 的
埠。兩者都可以點開看 **session id** 那一行。

點開進條的「請求形狀」那一行是**請求的形狀**（messages 幾則、有沒有 system、
是不是串流、`max_tokens`）。用來認出那些沒有目錄的背景請求 —— 例如上下文壓縮
這種沒有 Environment 區段的請求，光看目錄欄是 `–` 分不出來，看形狀就一眼認得。
形狀只有數量與有無，不含任何內容。

## 另見

- [reliability.md](reliability.md) —— router 自己重送、補 ping 的機制本身。
- [measurements.md](measurements.md) —— 這些行為背後的實測樣本數。
- [ui-notes.md](ui-notes.md) —— Rack 分頁的視覺編碼規則。
