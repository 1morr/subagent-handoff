# 變更紀錄

這個專案沒有版本號也沒有 Release —— 安裝方式是 `git clone` 之後直接跑，所以這裡**不是**
給使用者判斷「要不要升級」的 changelog，而是一份**工作日誌**：每次改動做了什麼、為什麼，
以及那些從 diff 看不出來的取捨。條目按日期分段，不按版本。

判準是「下次回來看會想知道的事」：行為變了、某個東西被拿掉了、或者某個決定背後有實測數據。
純粹的格式調整與重新命名不記。完整的技術細節在 [`docs/`](docs/)，這裡只寫發生了什麼。

紀錄從 2026-09-17 開始（在那之前的 40 多個 commit 是初版成形的過程，直接看 `git log`）。

---

## 2026-09-25（`feat/https-proxy` 分支）

### 新增

- **HTTPS proxy 模式，讓 Claude Desktop 也能接。** Desktop 的 Code 分頁不理
  `ANTHROPIC_BASE_URL`，但照讀 `HTTPS_PROXY` 與 `NODE_EXTRA_CA_CERTS`（issue #2）。
  proxy 埠多收 `CONNECT`：`api.anthropic.com:443` 用本機 CA 解開，其餘主機純隧道。
  只放在分支上，master 維持一種接法 —— 多一把 CA 與一條 MITM 路徑，換來的只是 Desktop。
- 解開之後只有 `/v1/messages*` 交給分流與流量記錄，其餘路徑原樣轉發。實測一個
  `claude -p` 就多出 14 筆 OAuth、feature flag、遙測，全記下來會淹掉流量記錄；
  `ANTHROPIC_BASE_URL` 模式下 router 本來就只看得到 `/v1/messages*`（master 的 traffic.log
  4666 筆裡沒有別的）。
- WebSocket upgrade 也原樣轉發：Claude Code 2.1.281 的 voice mode 對
  `/api/ws/speech_to_text/voice_stream` 開 WebSocket，沒接住的話開了這個模式它就壞。
- 實測 Claude Code 2.1.281（CLI，Windows）接受這把帶 nameConstraints 的 CA，主對話與
  subagent 分類正確。Desktop、Remote Control、真的 voice mode 還沒測。
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
