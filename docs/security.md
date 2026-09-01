# 安全性筆記

## 資料仍然會完整送到第三方 provider

分流出去的每一筆請求，內容都是完整的：Claude Code 的 system prompt、你的原始碼、
檔案內容、工具輸出，一個字都不會被過濾或摘要。這不是程式碼能解的問題，是選擇把
子 agent 導去第三方 provider 就要接受的取捨 —— router 只負責把流量正確地送到你
自己設定的目的地，不會、也不能替你決定哪些內容不該離開這台機器。

（這句話原本是 `docs/refactor-2026-08.md`「八、沒有處理的」一節裡唯一講清楚這件事
的地方，該文件是一份綁在特定 commit 的重構前後對照、已經過期並整份刪除；
這個事實本身不會過期，所以單獨留在這裡。）

## router 實際擋住的攻擊面

`src/guard.mjs` 在 proxy 與 GUI 兩台 server 上都做了本機來源檢查（Origin 擋一般
CSRF、Host 擋 DNS rebinding），細節與驗證方式見 README 的對應章節。這裡補記
guard 之外、跟資料安全直接相關的幾點：

- **`buildProviderHeaders`（`src/proxy.mjs`）從零組出送給第三方的 header**，不會把
  客戶端（Claude Code）原始的 `authorization` / `x-api-key` / `cookie` 轉發過去 ——
  第三方永遠只拿得到你在 GUI 裡替那個 provider 填的 key，拿不到訂閱的 OAuth token。
  這是整個工具存在的前提，`test/routing.test.mjs` 有專門的負向斷言守著。
- **`config.json` 與 `traffic.log` 落檔權限是 0600**（`src/config.mjs`、
  `src/logfile.mjs`），同機的其他使用者讀不到裡面的第三方 API key。Windows 上這個
  設定會被忽略（NTFS 權限模型不同），無害但也不生效 —— 多使用者 Windows 機器上
  這道防線實際上不存在。
- **`providers[].baseUrl` 與 `passthrough.baseUrl` 只驗證 scheme**（必須是
  `http:` 或 `https:`），不限制目標主機。這是刻意的：router 存在的目的就是讓使用者
  把流量導去自己選的任意端點，鎖住特定 IP 段（例如雲端 metadata 位址）會直接擋掉
  「指到自己跑的本地相容層」這種正常用法。換句話說，**把 baseUrl 填成什麼完全是
  使用者自己的責任**，router 不會幫你判斷那個目的地安不安全。
- **GUI 的 `POST /api/test` 與 `PUT /api/config`** 都會擋下「送 `__keep__` 遮罩值
  但把 baseUrl 換成別的網域」這種輸入 —— 換 baseUrl 就必須明著帶新的 API Key，
  不能沿用已存的遮罩值把舊 key 綁到新目的地。
