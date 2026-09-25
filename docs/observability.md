# 觀測：流量記錄與 Rack 分頁

對應 README 的「Documentation」表格裡「The traffic log, cache hit rates, and
reading the rack」。這裡講流量記錄「目錄」欄怎麼來的、記錄怎麼落到磁碟上、快取
命中率怎麼算，以及 Claude Code 顯示「will retry in …」時該去哪裡查是誰的問題。
實測數據見 [measurements.md](measurements.md)，GUI 視覺規則見
[ui-notes.md](ui-notes.md)。

## 流量記錄的「目錄」欄是怎麼來的

同時開好幾個專案時，用來分辨哪一筆流量出自哪個 session。

header 裡**沒有** cwd（實測 v2.1.227 的 21 個 header 全查過），唯一的來源是
Environment 區段：

```
# Environment
You have been invoked in the following environment:
 - Primary working directory: C:\Users\dev\code\bridge
```

**這個區段搬過家。** 原本在 system prompt 的最後一塊，後來搬進 `messages` 裡那則
`role: "system"` 訊息（實測 2026-09-19 抓包確認）。只看 `body.system` 的那段期間
目錄欄整欄是空的 —— 流量記錄看得出斷點：2026-08-19 那天 2711 筆有 2669 筆抓得到，
08-30 之後 0 筆。`extractCwd` 現在兩個位置都掃，`messages` 只掃 `role: "system"` 的
那幾則：整包掃下去，1M context 的請求每一筆都要在幾 MB 的文字上跑一次正則。

router 只用一條 regex（`src/routing.mjs` 的 `CWD_RE`）挖出這行路徑，其餘內容一概
不留 —— 測試裡有一條斷言守著這件事。

不是每一筆都帶得出來。**背景請求 —— 上下文壓縮、產生 session 標題、額度探針 ——
沒有 Environment 區段**（抓包確認，那幾筆 `messages` 只有一則）。它們與主對話共用
同一個 `x-claude-code-session-id`，所以由帶得出 cwd 的請求把它記進一張
`sessionId → cwd` 的表（`SessionCwd`，`src/proxy.mjs`，LRU，預設上限 200 筆），
其餘回查。

**子 agent 已經不需要這張表了。** v2.1.227 時它的 system prompt 確實沒有 Environment
區段，這張表原本就是為它做的；區段搬進 `messages` 之後，子 agent 的請求自己就帶著
（實測 2026-09-19，抓一筆真的子 agent 請求，`messages[1]` 那則 `role: "system"` 裡有）。

表還是得留著，因為背景請求還在靠它。同一個 session 的兩筆 `messages` 只有一則的
請求就是現成的對照：表還沒建立時目錄欄是空的，建立之後同樣形狀的請求就填得出來。

因此有一個已知空窗：**router 啟動後，某個 session 第一筆流量就是背景請求**，
那一筆的目錄欄會是 `–`。實務上正常的對話請求一定先到，很難碰到。

欄位只顯示目錄名，點開進條看完整路徑。

**目錄認不出來不算異常。** 曾經有一條「沒有 cwd 就標 CHK」的規則（`stateOf`，
`src/ui/readout.mjs`）。區段搬家之後 cwd 全空，於是每一筆跑完的請求都成了 CHK，
機架與流量頁的「只看異常」跟「全部」再也分不出來。那條規則連在正常情況下都會誤報
—— 背景請求（壓縮、標題）本來就沒有 Environment 區段。目錄是觀測缺口，不是請求
出事，現在只在批註欄留一行字。

## 流量記錄會留在磁碟上

GUI 上那份只有最近 300 筆，而且**重啟就沒了** —— 偏偏要查的事情常常橫跨重啟。
所以每一筆走完的請求會補寫成一行 NDJSON 到 `config.json` 旁邊的 `traffic.log`
（`src/logfile.mjs`）。

內容跟 GUI 看到的完全一樣：只有中繼資料，沒有 prompt。但它含有專案目錄與
session id，所以預設已經進 `.gitignore`。落檔用 `appendFileSync(..., { mode:
0o600 })`，同機的其他使用者讀不到（Windows 上這個 mode 會被忽略，無害但也不
生效，見 [security.md](security.md)）。

```bash
# 昨天所有非 200 的請求是誰擋的
grep -v '"status":200' traffic.log | jq -r '[.ts, .target, .status, .detail] | @tsv'
```

超過 5 MB 會輪替成 `traffic.log.1`，只留一份舊的，所以磁碟最多佔 10 MB。落檔失敗
時（例如 Windows 上檔案被編輯器暫時鎖住）不會放棄：每一筆照樣再試，console 只在
連續失敗的第一次報錯，恢復之後再壞才會再報；寫不進去的那幾筆只留在記憶體那份
300 筆裡。

## 快取命中率

兩條線的串流回應都帶 `usage`，router 邊轉發邊讀出四個數字記進流量記錄的 `usage`
欄位：`input`（沒命中快取的部分）、`cacheRead`、`cacheWrite`、`output`。只讀
`message_start` 與 `message_delta` 兩種事件，文字與思考內容所在的事件連解析都不
做，轉發的 bytes 一個都不動。

- **機架**分頁的每一張席位卡（SUB，加上每個第三方 provider 各一張）都有一格
  「快取命中」：`快取讀 ÷（未命中 ＋ 快取寫 ＋ 快取讀）`，**以 token 加權**，範圍
  是記憶體裡那個席位的全部進條（最多 300 筆）。不跟分流帶用同一個 5 分鐘窗，因為
  快取是看趨勢的數字，窗太短只剩雜訊。還沒有用量資料時印 `–`，不是 `0%`。
- 點開任一張進條，「用量」那一行是這一筆的明細。
- 非串流的回應 router 不緩衝，讀不到用量，不算進去。Claude Code 的推論一律走串
  流，實務上只漏掉少數背景請求。

實測（2026-09）一次子 agent 讀檔：主對話走訂閱，第二輪起 99–100%；子 agent 走
DeepSeek，第一筆 0%、之後 97–99%。DeepSeek 上新 session 的第一筆為什麼也能命中，
見 [security.md](security.md#送去-provider-的請求一律拿掉-metadata)。

```bash
# 各席位的快取命中率（token 加權）
jq -rs 'map(select(.usage)) | group_by(.providerId) | .[] |
  { seat: (.[0].target), read: (map(.usage.cacheRead) | add),
    prompt: (map(.usage.input + .usage.cacheRead + .usage.cacheWrite) | add) } |
  "\(.seat)\t\((100 * .read / .prompt) | floor)%"' traffic.log
```

## Claude Code 顯示「will retry in …」時該看哪裡

畫面上那句 `Waiting for API response · will retry in 2m 26s · check your
network` 只說了「在等」，沒說是誰擋的。答案在流量記錄的**狀態欄**：

- 狀態是 `429` / `529` / `5xx` → **上游擋的**，router 只是照實轉發。這種進條會
  被推出機架整格、加一圈朱紅框，批註欄寫著「上游擋的」；點開看上游自己的說法
  （`rate_limit_error: …`、`overloaded_error: …`），以及 `retry-after` 與
  `request-id`。
- 狀態欄直接寫著 `fetch failed` 這類文字、批註欄寫「router 連不上上游」→ 上游
  連回應都沒給，client 收到的是 router 合成的 502，Claude Code 會照它自己的退避
  重試。冒號後面是底層的原因：`connect ECONNREFUSED …`（那個位址沒人在聽）、
  `getaddrinfo ENOTFOUND …`（網域打錯或 DNS 不通）、`Client network socket
  disconnected before secure TLS connection was established`（TLS 握手被切，常見於
  防火牆或公司 proxy）。
- 狀態欄寫著 `terminated`、批註欄寫「串流中途斷線」→ **上游回了 200、串流送到
  一半才斷**，router 也把 client 那頭的連線切斷，讓 Claude Code 當成連線錯誤重送
  （為什麼不補 error 事件見 [reliability.md](reliability.md)）。
- `client aborted` → 是 Claude Code 自己收手（按了 esc、subagent 被取消、上一輪
  結束）。這不是錯誤。
- **完全沒有對應的那一筆** → 請求根本沒送到 router，問題在 Claude Code 到
  127.0.0.1 之間。HTTPS proxy 模式開著時另有兩種刻意不進流量記錄的情況：
  `/v1/messages*` 以外的請求（登入、遙測…）與隧道原樣轉發、不記；TLS 握手沒完成的連線
  （最常見是 Claude Code 沒拿到 `NODE_EXTRA_CA_CERTS`）也沒有請求可記，只在 router 的
  console 印一行 `a client closed the api.anthropic.com connection before the TLS
  handshake finished` 的警告（[https-proxy.md](https-proxy.md#代價與地雷)）。

上游**有給** `retry-after` 時，畫面上倒數的秒數就是它的值，所以狀態欄顯示
`429 ·146s 後重試` 而畫面寫 `will retry in 2m 26s` 是同一件事，不是 router 卡住。

但訂閱線的 429 實測**不帶** `retry-after`（22 筆全部是空的），那時候畫面的倒數
是 Claude Code 自己算的。這種情況下限流資訊在 `anthropic-ratelimit-*` 那組
header 上，router 會整組收進流量記錄（`collectRateLimit`，`src/proxy.mjs`）：
批註欄改寫「上游擋的・3586s 後重置」，點開進條的「限流」那一行有完整的鍵值。

### 機架上的「5 小時額度窗」

同一組 header 也餵機架頂上那條額度窗（`quotaWindow`，`src/ui/readout.mjs`）。
**欄位名換過。** Anthropic 現在回報的是比例與狀態，不再有 `unified-remaining` /
`unified-limit`（實測 2026-09-19）：

```jsonc
{
  "unified-status": "allowed",         // ← 現在擋不擋你，只有這一個算數
  "unified-5h-utilization": "0.63",    // ← 已用比例，畫面的百分比與柱高
  "unified-7d-utilization": "0.31",
  "unified-reset": "1789765800"        // 每一筆成功的回應都有
}
```

讀舊欄位會兩個都拿到 `NaN`，於是畫面掉進「限流資訊已回報」的退路再接上 reset 倒數
—— `unified-status` 明明是 `allowed`，看起來卻像正在被限流。**有 reset 時間不等於
被擋**：每一筆成功的回應都帶著它。

`unified-status` 是一族值，不是二選一。實測看過兩個：

| 值 | 意思 | 畫面 |
| --- | --- | --- |
| `allowed` | 照常放行 | 席位色（青） |
| `allowed_warning` | 跨過上游自己的警告門檻（同一組 header 的 `unified-5h-surpassed-threshold`，實測 `0.9`，當時 utilization `0.93`），**請求照樣 200** | 琥珀色 ＋「接近上限」 |
| 其他（不以 `allowed` 開頭） | 真的被擋 | 朱紅 ＋「上游正在限流」 |

判斷用「開不開頭是 `allowed`」而不是「等不等於 `allowed`」—— 後者會把
`allowed_warning` 說成限流，那正是這個欄位原本犯的錯，只是換一個值再犯一次。

目錄欄是 `–` 時，批註欄會寫「cwd 表還沒建立」；連 session id 都沒有時會改寫
「沒有 session id・不是 Claude Code 送來的」—— 那筆是別的東西打到了 router 的
埠。兩者都可以點開看 **session id** 那一行。

點開進條的「請求形狀」那一行是**請求的形狀**（messages 幾則、有沒有 system、
是不是串流、`max_tokens`）。用來認出那些沒有目錄的背景請求 —— 例如上下文壓縮
這種沒有 Environment 區段的請求，光看目錄欄是 `–` 分不出來，看形狀就一眼認得。
形狀只有數量與有無，不含任何內容。

## 另見

- [reliability.md](reliability.md) —— 為什麼不自己重送、串流斷線的機制本身。
- [measurements.md](measurements.md) —— 這些行為背後的實測樣本數。
- [ui-notes.md](ui-notes.md) —— Rack 分頁的視覺編碼規則。
