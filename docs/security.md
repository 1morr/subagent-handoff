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

## router 實際擋住的攻擊面

`src/guard.mjs` 在 proxy 與 GUI 兩台 server 上都做了本機來源檢查（Origin 擋一般
CSRF、Host 擋 DNS rebinding），細節與驗證方式見 README 的對應章節。這裡補記
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
- **HTTPS proxy 模式（`feat/https-proxy` 分支）多了一把本機 CA 與一個例外。** CA 被
  nameConstraints 限定只能簽 `api.anthropic.com`，私鑰 0600，不裝進系統信任庫。
  proxy 的 guard 對 CONNECT 解開的請求放行（它們的 Host 必然是 `api.anthropic.com`），
  理由與守著它的測試見 [https-proxy.md](https-proxy.md#代價與地雷)。
- **DNS rebinding 真正想拿的**，是 `PUT /api/config` 加一個自己的 provider、把主對話
  的規則指過去 —— 之後每一輪對話的完整內容都會送給他。Host 檢查擋的就是這條。
