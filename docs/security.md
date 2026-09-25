# 安全性筆記

## 資料仍然會完整送到第三方 provider

分流出去的每一筆請求，內容都是完整的：Claude Code 的 system prompt、你的原始碼、
檔案內容、工具輸出，一個字都不會被過濾或摘要。這不是程式碼能解的問題，是選擇把
子 agent 導去第三方 provider 就要接受的取捨 —— router 只負責把流量正確地送到你
自己設定的目的地，不會、也不能替你決定哪些內容不該離開這台機器。

## 送去 provider 的請求一律拿掉 `metadata`

上一節講的是對話內容；請求外層有一個欄位例外。Claude Code 在 `metadata.user_id`
裡放了 claude.ai 的 `account_uuid` 與 `device_id`（實測 v2.1.274），那是訂閱帳號
的識別資訊，子 agent 做事用不到，所以 router 在 provider 線上一律把整個
`metadata` 拿掉（`src/proxy.mjs`）。這一項沒有開關；訂閱線照舊原樣轉發。點開進條
的「送出前改寫」會看到 `-metadata`。

對快取的影響是**正面的**：DeepSeek 拿 `user_id` 做 KV cache 分區
（[文檔](https://api-docs.deepseek.com/quick_start/rate_limit)），而 Claude Code
的 `user_id` 裡帶著 `session_id`，等於每個 session 各自一個分區、新 session 一律
從冷快取開始。實測（2026-09，`deepseek-flash`）同一分區重送命中 94–96%、換分區
0%，空 id 的分區快取照常；拿掉之後（並設了 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`），
新 session 的第一筆子 agent 請求就命中了上一個 session 留下的快取（92%）。那個環
境變數後來證實會打壞訂閱線的輔助請求，現在的接入說明改成不要設
（[原因](claude-code-request-shapes.md#訂閱線會檢查-system-的開頭)）；沒設時跨
session 還命不命中沒量過。一般帳
號的並發上限本來也是所有 `user_id` 合計，拿掉不影響。分區實驗的細節見
[claude-code-request-shapes.md](claude-code-request-shapes.md)。

## 本機來源檢查

兩台 server 都只綁 127.0.0.1，但那只擋得住別台機器，擋不住使用者瀏覽器裡的網頁。
`src/guard.mjs` 在 proxy 與 GUI 兩台上、做任何事之前都先檢查來源，擋兩種攻擊：

| 攻擊 | 怎麼打 | 擋它的 |
| --- | --- | --- |
| 一般 CSRF | 網頁用 `content-type: text/plain` 發簡單請求（不觸發 preflight）打 `POST /api/test`，body 裡 apiKey 填保留值、baseUrl 填自己的網域，router 會把真的 API key 還原出來送過去。攻擊者不必讀得到回應 | `Origin`：有帶就必須是 GUI 自己的 `http://127.0.0.1:<埠>` 或 `http://localhost:<埠>` |
| DNS rebinding | 攻擊者的網域重綁到 127.0.0.1 之後，對瀏覽器來說就是同源，可以自由 `PUT /api/config` 加一個自己的 provider、把主對話的規則指過去 —— 之後每一輪對話的完整內容都會送給他 | `Host`：主機名必須是 `127.0.0.1`、`localhost` 或 `[::1]` |

兩個都要，缺一個就擋不住對應的那一種。幾個刻意的選擇：

- **沒有 `Origin` 放行。** Claude Code 走 undici 不送 Origin，擋掉的話 proxy 一個請求都收不到；
  curl 也一樣。沙箱 iframe 送的字串 `"null"` 不算沒有，照樣擋。
- **`Host` 只驗主機名、不驗埠。** DNS rebinding 時瀏覽器送的埠本來就是我們綁的那個，比對它擋不到
  任何東西，卻會誤殺埠轉發之類的正常用法。
- **proxy 那台用實際綁定的埠組 Origin**，不是設定檔裡的 `proxyPort`：存進設定的新埠要重啟才生效。
- proxy 那台也要擋：它握有第三方的 API key，網頁 rebinding 之後可以自己補上 agent-id header
  命中分流規則，拿你的額度跑推論。

`test/guard.test.mjs` 守著這些：admin 與 proxy 各自擋下跨來源的 Origin 與外來的 Host（被擋時設定
沒被改到、一個 byte 都沒往上游送）、`POST /api/test` 的簡單請求 CSRF 送不出真 key、admin 對沒有
Origin 與自己的 Origin 放行、對 `Origin: null` 擋下，以及 proxy 看的是綁定的埠。HTTPS proxy 模式對 guard 的
例外另見下一節最後一點。

## router 實際擋住的攻擊面

guard 之外、跟資料安全直接相關的幾點：

- **`buildProviderHeaders`（`src/proxy.mjs`）從零組出送給第三方的 header**，只從
  客戶端（Claude Code）帶過去 `anthropic-version`、`anthropic-beta` 與 `accept`，不會把原始的
  `authorization` / `x-api-key` / `cookie` 轉發過去 —— 第三方永遠只拿得到你在 GUI 裡
  替那個 provider 填的 key，拿不到訂閱的 OAuth token。這是整個工具存在的前提，
  `test/routing.test.mjs` 有專門的負向斷言守著。
- **`config.json` 與 `traffic.log` 落檔權限是 0600**（`src/config.mjs`、
  `src/logfile.mjs`），同機的其他使用者讀不到裡面的第三方 API key。Windows 上這個
  設定會被忽略（NTFS 權限模型不同），無害但也不生效 —— 多使用者 Windows 機器上
  這道防線實際上不存在。
- **訂閱線的去向寫死成 `https://api.anthropic.com`**（`PASSTHROUGH_BASE_URL`），
  不在設定檔裡。帶著 OAuth token 的請求因此不可能被一次存檔導去別的地方。
- **`providers[].baseUrl` 只驗證 scheme**（必須是 `http:` 或 `https:`），不限制目標主機。這是刻意的：router 存在的目的就是讓使用者
  把流量導去自己選的任意端點，鎖住特定 IP 段（例如雲端 metadata 位址）會直接擋掉
  「指到自己跑的本地相容層」這種正常用法。換句話說，**把 baseUrl 填成什麼完全是
  使用者自己的責任**，router 不會幫你判斷那個目的地安不安全。
- **GUI 的 `POST /api/test` 與 `PUT /api/config`** 共用同一道把關
  （`src/config.mjs` 的 `providerProblem`），都會以 400 擋下「送 `__keep__` 遮罩值但
  把 baseUrl 換成別的網域」這種輸入 —— 換 baseUrl 就必須明著帶新的 API Key，不能沿用
  已存的遮罩值把舊 key 綁到新目的地，也不會悄悄存成空 key。
- **選用的 HTTPS proxy 模式（預設關閉）打開後，多了一把本機 CA 與一個例外。** CA 被
  nameConstraints 限定只能簽 `api.anthropic.com`（IP 位址也一併排除），私鑰 0600，不裝進系統信任庫。
  proxy 的 guard 對 CONNECT 解開的請求放行（它們的 Host 必然是 `api.anthropic.com`），
  理由與守著它的測試見 [https-proxy.md](https-proxy.md#代價與地雷)。
