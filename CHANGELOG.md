# 變更紀錄

這個專案沒有版本號也沒有 Release —— 安裝方式是 `git clone` 之後直接跑，所以這裡**不是**
給使用者判斷「要不要升級」的 changelog，而是一份**工作日誌**：每次改動做了什麼、為什麼，
以及那些從 diff 看不出來的取捨。條目按日期分段，不按版本。

判準是「下次回來看會想知道的事」：行為變了、某個東西被拿掉了、或者某個決定背後有實測數據。
純粹的格式調整與重新命名不記。完整的技術細節在 [`docs/`](docs/)，這裡只寫發生了什麼。

紀錄從 2026-09-17 開始（在那之前的 40 多個 commit 是初版成形的過程，直接看 `git log`）。

---

## 2026-09-25

### 修正

- **Provider 測試：結論放最前面，無法判定不再印成 FAIL，改過設定的舊結果會標出來。** 設計審查：結論原本是
  七列結果下面的一行灰字；看圖／讀 PDF 在模型不呼叫工具、或思考吃光 `max_tokens` 時印 `FAIL`，但那沒證明
  provider 壞了（現在 probe 回 `inconclusive: true`，GUI 印 `N/A`）；能力項目 FAIL 的標籤塊是深色字印在
  導軌灰上，對比 1.91:1；改了 baseUrl 或 key 之後，上一次的結果照樣掛著像是現況。`/v1` 結尾警告原本要等
  別的操作觸發重繪才出現、改對了也不消失，現在隨輸入即時更新；送出路徑的提示原本印出字面的
  `{baseUrl}`，現在是實際的網址。

- **「交還給訂閱」只存規則的導向。** 它原本把畫面上整份設定送出去：改到一半的 provider、甚至
  還沒存的 HTTPS proxy 開關（存檔即切換）都會被一起存下。現在以伺服器上已存的設定為底、只改規則
  導向，草稿留在畫面上。送出期間按鈕停用（連點會用已經改成訂閱的規則蓋掉還原點）；還原點存進
  localStorage，重新整理頁面後「改回原本的 provider」還在。文案從「子 agent」改成「規則」：它一直都
  是翻轉所有指向 provider 的規則，主對話的也算。沒有規則可交還時，旁邊說明為什麼按鈕是灰的。

- **GUI 重繪不再把鍵盤焦點與選取的文字丟掉。** 機架與流量分頁每 3 秒整頁重繪，焦點每次都被丟回
  body（實測 3.5 秒後焦點在 BODY），展開的進條裡選到一半的 request-id 也會被換掉；點規則的勾選框、
  下拉選單同樣會掉焦點。現在重繪前記下焦點所在的控制項、換完放回去，正在選字時輪詢跳過那一輪。

- **流量記錄的 `fetch failed` 帶上底層原因。** fetch 把真正的原因（拒絕連線、DNS、TLS 握手被切、
  `bad port`）放在 `err.cause`，之前只記 `fetch failed`，每一種連不上都長得一樣 —— 上一條那個
  打架的設定，就是臨時把 cause 印出來才查到的。含 abort 字樣的原因不附，免得 GUI 誤判成 client 收手。

- **`HTTPS_PROXY` 與 http:// 的 `ANTHROPIC_BASE_URL` 同時設時，回 400 說清楚是哪兩個設定打架。**
  審查時用 Claude Code 2.1.282 實測：全域 settings.json 留著 `ANTHROPIC_BASE_URL`、只在專案層加
  `HTTPS_PROXY` 時，CLI 把 router 當一般 HTTP proxy，請求行送完整網址。router 把它接在上游網址後面，
  組出 `https://api.anthropic.comhttp://127.0.0.1:8787/…`，回 502 `fetch failed`，Claude Code
  還重試十次。`docs/https-proxy.md` 原本寫「兩個都設不會出錯」，也一起改正。

- **CA 檔案壞掉時打不開 HTTPS proxy 模式，並說清楚怎麼修。** 之前證書與私鑰不配對（例如上面那個
  並行產生的情況，或只換掉其中一個檔案）、或 CA 過期，router 照樣啟動，之後每次握手都失敗，
  console 只提示去檢查 `NODE_EXTRA_CA_CERTS`；私鑰檔被截斷則是啟動時丟出一整段 stack trace。
  現在載入時檢查配對、效期與格式，錯誤訊息直接寫出要刪哪兩個檔案。

- **同時進來的存檔改成依序執行。** 審查時實測：兩個 `PUT /api/config` 同時帶著 HTTPS proxy
  模式打開（連點「交回訂閱」、或開兩個分頁各存一次），會掛上兩個 `CONNECT` 監聽；之後關掉只拆得
  掉一個，GUI 顯示「關閉」但 `CONNECT` 照樣回 200 —— 違反「關閉＝沒有這個功能」。同時產生 CA
  還可能讓落檔的證書與私鑰不是同一對。`saveConfig` 本身也會壞：並行存檔共用同一個暫存檔，200 輪裡
  57 輪留下壞掉的 `config.json`（下次啟動直接起不來），Windows 上同時 rename 還會 `EPERM`。
  現在 admin 的存檔、HTTPS proxy 的切換、`saveConfig` 三處各自排隊，三個都有並行測試（變異驗證過：
  拿掉排隊就紅）。

- **本機 CA 的 nameConstraints 補上 IP 位址的排除。** 原本只列允許 `api.anthropic.com`，但
  RFC 5280 的 permittedSubtrees 只管它列出的名稱種類：拿外洩的 CA 私鑰簽一張 iPAddress SAN
  的證書，連 IP 的 client 照樣接受（審查時實測重現）。現在把 `0.0.0.0/0` 與 `::/0` 列進
  excludedSubtrees，測試確認這種證書以 `excluded subtree violation` 被拒；Claude Code 2.1.282
  用新的 CA 實測照常握手。已經產生的 CA
  不會自動換掉（換了 Claude Code 要重開才讀得到），想要這段保險就刪掉兩個 CA 檔案重新產生。

### 變更

- **HTTPS proxy 模式的面板移到接入分頁最下面，改成一顆「開啟／關閉並儲存」。** 設計審查指出三件事：
  選用功能排在第 1 步之前，只用 CLI 的人得先讀過它；勾選框（未來）比「目前狀態」（現在）更搶眼，
  勾了還沒存時兩者互相矛盾；「待關閉」（會斷網）跟「待開啟」用同一種黃色提示。現在面板在三個步驟與
  已知限制之後，第一行是 router 此刻實際的狀態（開啟是實心淺色塊，不再借用訂閱席位的青綠），動作是
  一顆只存這個開關、當場生效的鍵（跟「交還給訂閱」一樣不帶上其他草稿），關掉會斷網的警告寫在鍵旁邊；
  原理說明裡的比較表標出目前那一欄。模式關著時，三個步驟跟沒有這個功能時一字不差。

- **HTTPS proxy 模式存檔當場切換，不用重啟 router。** 之前要求重啟，是為了保證「關閉＝根本沒掛上
  `CONNECT`」；改成執行中把監聽拿掉、同時斷開還開著的隧道，一樣做得到，測試也照樣守著（用變異驗證過：
  不斷隧道、不拿監聽都會紅）。Fiddler、Charles 的解密開關也是勾了就生效。先切換再存檔，切換失敗就不存。
  接入分頁改成明白標出 router 此刻實際的模式，拿掉原本那句「下面的片段對應的是它現在實際在跑的模式」
  —— 它沒講現在是什麼狀態，存完還要重啟這件事也容易被當成已經切換。切換後另外提醒 Claude Code 那邊
  的設定要跟著換；關掉時用警告樣式，因為還設著 `HTTPS_PROXY` 的 Claude Code 會整個連不上。

- **實測 auto mode 的權限分類器走哪裡，結論跟直覺相反。** Claude Code 先請 Anthropic 在主對話
  的回應裡附上判定（`safeguard_results`）；provider 不會附，只要 session 裡有一筆請求到了
  provider，Claude Code 就改成每個動作另發一筆分類器請求，而那筆請求**沒帶 agent-id**，算 `main`。
  所以：主對話分到 provider 時，是 provider 的模型在判定（DeepSeek 擋下了 `git push --force`），
  不是免費用到 Claude；只有子 agent 分到 provider 時，子 agent 的動作反而由 Claude 判定、花訂閱
  額度，而且整個 session 都多出分類器請求（每筆第一次約 3 萬 input tokens）。對照組：完全不分流
  時沒有任何分類器請求。新增 [docs/request-map.md](docs/request-map.md) 列出每一種請求的去向；
  GUI 路由分頁在有主對話規則指向 provider 時提醒這件事。
- 補上 HTTPS proxy 模式「怎麼驗的」與「沒有的功能與已知缺口」（[docs/https-proxy.md](docs/https-proxy.md#怎麼驗的)），
  其中一條沒實測：router 對外的隧道與 WebSocket 一律直連，不會再經過 Clash 之類的系統代理。
- 修正 claude-code-request-shapes.md 兩處過時的敘述：分類器的 `max_tokens` 已經從 2112 變成
  兩階段 64 / 8192；背景請求「一律走訂閱」只在主對話沒分流時成立。

- **HTTPS proxy 模式改成預設關閉的開關，並合併進 master。** 原本打算長期留在分支上，
  讓 master 只有一種接法；改成開關之後，關著的 router 跟沒有這個功能時一模一樣（不收
  `CONNECT`、不產生 CA、guard 沒有例外、接入分頁是原本的文字），只用 CLI 的人感覺不到它，
  也就沒有理由再維護一條要不斷 rebase 的分支。開關是 `config.json` 的 `httpsProxy`，
  跟埠一樣重啟才生效 —— 關閉必須是「根本沒掛上」，而不是「掛著但拒絕」，才能保證跟原本一樣。
  前三項由 `test/connect.test.mjs` 守著，並用變異驗證過會紅。
- 同時補上設定教學：全域與單一 repo 的放法，以及兩者對各功能的差別
  （[docs/https-proxy.md](docs/https-proxy.md#設定-claude-code)）。
- **把這個模式講清楚：原理、流程圖、開關前後的差別、實際送出了什麼、封號風險。**
  docs/https-proxy.md 與 README 加上 mermaid 流程圖；GUI 接入分頁的開關下面多一段可展開的
  說明（兩種模式的流向、比較表、風險）。「送出了什麼」是實測：用假上游接住 router 送出的請求
  逐項比對，主對話線上 Node `fetch` 會多加 `accept-language: *`、`sec-fetch-mode: cors`，
  `accept-encoding` 被換成 `gzip, deflate`；原樣轉發那條線 header 不變。這些兩種模式都一樣，
  開啟後多的是：登入、遙測、Remote Control、voice 也改由 Node 發出。

### 新增

- **HTTPS proxy 模式，讓 Claude Desktop 也能接。** Desktop 的 Code 分頁不理
  `ANTHROPIC_BASE_URL`，但照讀 `HTTPS_PROXY` 與 `NODE_EXTRA_CA_CERTS`（issue #2）。
  proxy 埠多收 `CONNECT`：`api.anthropic.com:443` 用本機 CA 解開，其餘主機純隧道。
  一開始只放在 `feat/https-proxy` 分支上（後來改成開關並合併，見上）。
- 解開之後只有 `/v1/messages*` 交給分流與流量記錄，其餘路徑原樣轉發。實測一個
  `claude -p` 就多出 14 筆 OAuth、feature flag、遙測，全記下來會淹掉流量記錄；
  `ANTHROPIC_BASE_URL` 模式下 router 本來就只看得到 `/v1/messages*`（master 的 traffic.log
  4666 筆裡沒有別的）。
- WebSocket upgrade 也原樣轉發：Claude Code 2.1.281 的 voice mode 對
  `/api/ws/speech_to_text/voice_stream` 開 WebSocket，沒接住的話開了這個模式它就壞。
- 實測 Claude Code 2.1.281（CLI，Windows）接受這把帶 nameConstraints 的 CA，主對話與
  subagent 分類正確。Remote Control、真的 voice mode 還沒測。
- **Desktop 實測通過**（2.7032.0.0，內嵌 Claude Code 2.1.280）：變數只放在專案的
  `.claude/settings.local.json` 就生效，51 筆請求全部經過 router、subagent 分類正確。
  Desktop 送的 `count_tokens` 遠比 CLI 多（一個 session 44 筆）。
- **Remote Control、voice mode、分到第三方 provider 實測都通過。** Remote Control 在
  Desktop 可用（網頁送訊息 → 本機推論 → 回到網頁）；CLI 版本仍然用不了，因為它拿使用者層的
  `ANTHROPIC_BASE_URL` 做資格檢查。CLI 的 voice mode 經 router 轉發 WebSocket、Anthropic 回
  101、轉寫正常；Desktop 的聽寫則根本不經過內嵌 CLI，不受影響。
  細節見 [docs/https-proxy.md](docs/https-proxy.md)。

## 2026-09-24

### 修正

- **接入說明不再建議設 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`，改成警告不要設。** 它會拿掉
  system 開頭的 attribution block，而訂閱線上開頭既沒有這一塊、也沒有 Claude Code 身分
  行的請求，會被 Anthropic 回 `429 rate_limit_error: "Error"`（不帶 rate limit header）。
  主對話不受影響，auto mode 的權限分類器、Claude in Chrome、額度探針卻全部失效 —— 流量
  記錄裡非串流的推論請求 94 筆全是這個 429。跟 router 無關，直接打 Anthropic 也一樣。
  實測表格見 [docs/claude-code-request-shapes.md](docs/claude-code-request-shapes.md#訂閱線會檢查-system-的開頭)。
  代價是 DeepSeek 跨 session 的快取命中可能下降，還沒量。

## 2026-09-21

### 修正

- **`npm test` 在 Node 20 上跑不起來。** `test/*.test.mjs` 這個 glob 要 Node 21 以上才由
  `node --test` 自己展開，Node 20 會把它當成字面路徑然後失敗。改成不帶參數的
  `node --test`，讓它自己探索 —— 20、22、24 三個版本的行為就一致了。
  CI 的 Node 20 那條腿就是這樣抓到的。

## 2026-09-20

### 新增

- **機架分頁改成一個 provider 一張席位卡**，不再把所有路由過去的流量混在一起看。

### 變更

- 測試改用 glob 探索，並對 `src/` 與 `test/` 每一個檔案跑 `node --check` —— 新增檔案
  自動被涵蓋，不必記得去註冊。
- 加上 `AGENTS.md`。

### 修正

- 兩段同色的 provider 之間補上分隔，否則視覺上會黏成一段。

## 2026-09-19

### 修正

- **工具 schema 裡的 `\0` 在 provider 線上改寫掉。** DeepSeek 的正規表示式引擎編譯不了
  帶 `\0` 的 pattern，會整筆退回。
- `allowed_warning` 判定成「接近上限」而不是「正在被限流」—— 兩者的處置完全不同。
- 修好 cwd 追蹤，以及機架上兩個會誤導人的讀數。

## 2026-09-18

### 新增

- 把看圖、讀 PDF、中途 system 訊息這三組 provider 測試加回來 —— 它們對應的是 Claude Code
  真的會送出的請求形狀，少了就測不到 provider 收不收得下。

## 2026-09-17（大幅簡化）

這一天的主軸是**把 router 的表面積縮小**：能交給 Claude Code 自己處理的就不要在 router 裡做。

### 變更

- **router 不再自己重送。** Claude Code 本來就會重試，router 疊一層只是讓失敗變慢、讓
  錯誤訊息失真。上游失敗現在原樣交回去。量測見 [`docs/measurements.md`](docs/measurements.md)。
- **不再注入 keep-alive ping。** 上游安靜很久時就讓它安靜，不補假的心跳。
- **拿掉每個 provider 各自的 body 參數開關**，改成統一轉發 `anthropic-beta`。
- **規則只匹配 `main` 與 `subagent` 兩種來源。** 原本還有第三種 `nested`（子 agent 再開的
  agent），實測 Workflow 的 agent 工具集裡沒有 `Agent` 與 `Workflow`，不會再往下開一層，
  所以 `nested` 永遠不觸發 —— 拿掉。
- passthrough、請求上限、流量記錄改成常數，不再是設定項。
- 共用同一份 provider 檢查與同一個 request builder，不再各寫一份。
- 只保留「能決定它到底行不行」的 provider 測試，其餘刪掉。
- 刪掉請求形狀擷取腳本與 demo 腳本 —— 形狀已經記進
  [`docs/claude-code-request-shapes.md`](docs/claude-code-request-shapes.md)，腳本沒人再跑。

### 修正

- 串流中途斷線在流量橫幅上標示正確（之前會被當成正常結束）。
- provider 拒收過長 prompt 時讓子 agent 能夠壓縮後重來。
- 連線探測給會思考的 provider 多一點時間，不要誤判成連不上。

### 新增

- 記錄 token 用量並顯示快取命中率。
- 記下 DeepSeek 的快取分區行為與端到端實跑結果。
