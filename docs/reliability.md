# 可靠性：不重送、保活與斷線

對應 README 的「Documentation」表格。這裡講上游失敗時 router 怎麼交回去、長串流
怎麼保活，以及串流中途斷線時怎麼收尾。

## 失敗原樣交回，router 不自己重送

上游回的錯誤（`429`、`5xx`、`529`⋯⋯）原樣交回 Claude Code，狀態碼、header 與
body 都不改寫；唯一的例外是 provider 的 context 超限，見
[providers.md](providers.md#router-只改寫一種回應)。連上游都連不上時回 `502`，訊息以
`subagent-handoff:` 開頭，流量記錄的狀態欄會直接寫著失敗原因。

不自己重送，是因為 Claude Code 本來就會重試。以下對照本機 Claude Code 2.1.274
執行檔裡的程式碼：

- `408`、`409`、`401`、`5xx`、`529`、`overloaded_error` 與連線錯誤：預設最多
  重試 10 次（`CLAUDE_CODE_MAX_RETRIES`），退避從 500ms 起每次翻倍、上限 32 秒，
  另加 0–25% 抖動；上游有給 `retry-after` 就取它與退避值較大的那個。
- `429`：API key 用戶一律重試；訂閱用戶只在回應**沒帶** Anthropic 額度 header 時
  重試。第三方的 429 不會帶這組 header，所以 Claude Code 照樣會重試。

router 在這之前再重送一層，只會讓打上游的次數相乘：router 重送 2 次時，一個請求
最壞會打上游 11 × 3 = 33 次，Claude Code 自己則是 11 次。實際流量裡這一層也沒有
幫上忙：2711 筆裡 router 重送了 22 次，全部在訂閱線、全部失敗，數字見
[measurements.md](measurements.md)。

`config.json` 裡的 `retry`、`passthrough.retry`、`providers[].retry` 載入時會被
忽略，下次存檔就會從檔案裡消失。

## 上游安靜太久時 router 自己補 ping

長思考期間第三方可能一個 byte 都不吐，而 Claude Code 數的是位元組、靜默 300 秒
就砍串流（undici 的 `bodyTimeout` 也是 300 秒）。官方 gateway protocol 要求
gateway 在這種時候自己發 `ping`，router 照做：上游安靜超過 60 秒
（`PING_IDLE_MS`，`src/proxy.mjs`）就補一個 `event: ping`。

只補在 **provider 那條線**。訂閱線的價值就是原始 bytes 原樣轉發，摻合成資料
進去就不成立了，而且 Anthropic 本來就會自己 ping。補之前一定確認停在事件邊界
—— 上游的 chunk 不保證切在 frame 邊界上，插進半個事件中間會把整條串流弄壞。
補了幾個，點開那張進條看「keep-alive」那一行。

## 串流中途斷線：照樣斷線

串流轉發到一半上游斷掉時，router 也把 client 這頭的連線切斷，不補合成的 SSE
`error` 事件。兩種做法 Claude Code 的反應不一樣（2026-09 實測 2.1.274，假上游
先送 `message_start`，還沒有任何內容區塊）：

| 上游的行為 | Claude Code 下一步 |
| --- | --- |
| 直接斷線 | 當成連線錯誤，約 0.7 秒後重送**串流**請求 |
| 補一個 `api_error` 事件後正常結束 | 立刻改發**非串流**請求 |

非串流請求等整個回應生成完才回，provider 線的 ping 也補不進去，長輸出比較容易
撞到逾時，所以照樣斷線才是讓 Claude Code 走它原本的復原路徑。已經開始輸出內容
之後才斷的，兩種做法 Claude Code 都會保留已收到的部分，並標示回應可能不完整。

這種失敗在流量記錄裡是狀態 `200` 加上錯誤 `terminated`。

## 另見

- [observability.md](observability.md) —— 怎麼從流量記錄看出是上游擋的、連不上，
  還是串流中途斷掉。
- [measurements.md](measurements.md) —— 支撐上述決定的實測數字。
