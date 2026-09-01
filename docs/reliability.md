# 可靠性：重送、退避與長連線保活

對應 README 的「Documentation」表格裡「Retry, backoff, and why the
subscription line does not retry 429」。這裡講上游暫時性失敗時 router 怎麼自己
重送、為什麼訂閱線的節流不重送，以及長串流怎麼保活。

## 上游暫時性失敗時 router 自己重送

Anthropic 的 529、第三方的 5xx、還有連線被中間的東西掐掉，都會讓 Claude Code
中斷對話並開始倒數（`attempt 9/10`）。這類失敗大多重送一次就過了，所以 router
先扛。節流（`429`）是唯一的例外，它該不該扛取決於是誰擋的 —— 見下面那段。

**重送只發生在還沒寫出任何一個 byte 給 client 的階段**：請求 body 完整留在
記憶體，這時候重送是安全的，而且 client 完全不知道發生過。串流一旦開始轉發就
不能重來 —— 那時候重送會讓 client 收到兩段接不起來的回應。

- 會重送：`408 500 502 503 504 529`，以及連線層的失敗（`fetch failed`、
  `terminated`）
- **節流（`429`）看路由**：`retry.retryRateLimit` 說了算，第三方預設重送、訂閱
  線預設不重送（原因見下一段）
- 不重送：其餘 4xx。請求本身有問題，重送幾次都一樣
- 上游有給 `retry-after` 就照它說的等；超過 `retry.maxRetryAfterMs` 就不自己
  扛，把回應交回去讓 Claude Code 顯示倒數 —— 使用者至少知道在等什麼，而不是
  對著一個沒反應的畫面等好幾分鐘
- 扛不住時交回去的是**上游最後一次的原始回應**，狀態碼與 body 都不改寫

> **跟舊版文檔的差異：`409` 已經從可重送清單移除。** 現在的清單是
> `src/proxy.mjs` 的 `RETRYABLE_STATUS`（第 200 行）：`408 500 502 503 504
> 529`。程式碼裡的理由是 409 屬於狀態衝突，重送通常解決不了同一個衝突，而且
> 實測 Anthropic Messages API 根本不會回這個狀態碼 —— 如果你的第三方 provider
> 會回 409，它不會被 router 自動重送，會直接交回給 Claude Code。

## 為什麼訂閱線不重送 429

原因是訂閱的 429 是 **5 小時額度窗**，不是瞬時擁塞，退避幾百毫秒等不到它恢復。
代價是對已經被擋下的端點多打請求，並在 Claude Code 顯示倒數之前多壓幾秒。
第三方的 429 通常是真的等一下就過，所以那邊留著。

支持這個決定的實測樣本（訂閱線的重試命中率、多打的請求數、多壓的秒數）都在
[measurements.md](measurements.md) 的「訂閱線的節流重試：純損耗」一節，這裡不
重複列數字。

`retry` 的解析順序是：**全域 `retry` 打底 → 路由自己的覆寫蓋上去**
（`src/routing.mjs` 的 `resolveRetryPolicy`）。覆寫是稀疏的，只有寫出來的鍵
生效，所以之後調全域的 `attempts` 或退避，只覆寫了 `retryRateLimit` 的路由也
會跟著動。

```jsonc
{
  "retry": { "attempts": 2, "baseDelayMs": 600, "retryRateLimit": true },
  "passthrough": { "retry": { "retryRateLimit": false } },   // 訂閱：節流直接交回去
  "providers": [
    { "id": "kimi", "retry": null },                          // 全部繼承
    { "id": "flaky", "retry": { "attempts": 4 } }             // 只加重送次數
  ]
}
```

**舊設定檔升級行為**：`passthrough` 底下沒有 `retry` 鍵時，載入就會套用新預設
`{ "retryRateLimit": false }`。想要舊行為就明寫 `"retry": { "retryRateLimit":
true }`。

## 上游安靜太久時 router 自己補 ping

長思考期間第三方可能一個 byte 都不吐，而 Claude Code 數的是位元組、靜默 300 秒
就砍串流（undici 的 `bodyTimeout` 也是 300 秒）。官方 gateway protocol 要求
gateway 在這種時候自己發 `ping`，router 照做：上游安靜超過 60 秒
（`PING_IDLE_MS`，`src/proxy.mjs`）就補一個 `event: ping`。這個閒置門檻現在是
`createPinger()` 的可注入參數，測試會覆寫成很小的值來避免真的等 60 秒；一般
啟動時走的還是預設的 60 秒，行為沒變。

只補在 **provider 那條線**。訂閱線的價值就是原始 bytes 原樣轉發，摻合成資料
進去就不成立了，而且 Anthropic 本來就會自己 ping。補之前一定確認停在事件邊界
—— 上游的 chunk 不保證切在 frame 邊界上，插進半個事件中間會把整條串流弄壞。
補了幾個，點開那張進條看「keep-alive」那一行。

狀態欄會顯示 `200 ×3`：送出去三次才成功，而 Claude Code 那頭只看到一次乾淨的
200。批註欄直接寫著「router 自己重送 3 次才成功」，點開看每一次的失敗原因。

串流轉發到一半才斷線沒辦法重送，但 router 會補一個合法的 SSE `error` 事件收尾，
而不是把連線砍掉 —— 被砍斷的串流只會讓 Claude Code 說「回應可能不完整」，連
原因都拿不到。

## 並發量體的另一道防線

`maxRequestBytes` 只擋單一請求。同一個 router 實例上，所有並發請求疊起來的
body 量體另外有一個固定 256MB 的總上限（`DEFAULT_MAX_IN_FLIGHT_BYTES`，
`src/proxy.mjs:397`），超過就直接回 `503`、連 body 都不讀，不必先把記憶體吃下去
才發現太多。這是舊版文檔沒有的機制；目前不能透過 `config.json` 調整，只有測試
程式碼能覆寫。欄位本身見 [configuration.md](configuration.md)。

## 另見

- [observability.md](observability.md) —— 怎麼從流量記錄看出是不是這裡描述的
  重送、保活在起作用。
- [measurements.md](measurements.md) —— 支撐上述決定的實測數字。
