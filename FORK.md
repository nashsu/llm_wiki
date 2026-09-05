# Fork 維護說明（Knowledge Loom 版 llm_wiki）

這個 repo 是 [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) 的 fork，多了 **Web / Server Mode** 與 **Connectors**（見 `plans/web-server-mode.md`、`plans/connectors.md`）。

## 分支與遠端

| 名稱 | 用途 |
|------|------|
| remote `upstream` | 原始專案 `nashsu/llm_wiki`，只拉不推 |
| remote `origin` | 你自己的 GitHub repo（尚未設定，見下方） |
| branch `main` | 永遠等於 `upstream/main`，不放自己的改動 |
| branch `web-mode` | 我們的版本：`main` + web/server mode + connectors |

## 設定自己的遠端（一次性）

在 GitHub 建一個空 repo（建議 private，名稱如 `llm_wiki`），然後：

```bash
git remote add origin git@github.com:<your-account>/llm_wiki.git
git push -u origin main
git push -u origin web-mode
```

## 同步上游更新

```powershell
.\scripts\sync-upstream.ps1     # Windows
```
```bash
./scripts/sync-upstream.sh      # macOS / Linux / Git Bash
```

腳本做的事：`git fetch upstream` → `main` fast-forward 到 `upstream/main` → 把 `main` **merge** 進 `web-mode`（用 merge 不用 rebase，因為 `web-mode` 會推到遠端）→ 有衝突時停下來讓你處理。合併後請跑：

```bash
npm run build          # 前端 typecheck + build
npm run web:check      # cargo check（server feature）
cargo check --manifest-path src-tauri/Cargo.toml   # 桌面 feature
```

## 衝突熱區

上游改動最常和我們撞到的檔案：`src-tauri/src/lib.rs`（指令註冊改走 `app_commands.rs`）、`src-tauri/Cargo.toml`（features）、`src/main.tsx` / `src/App.tsx`（WebGate）、`src/lib/tauri-fetch.ts`（改走 `src/lib/backend/`）。上游新增 Tauri 指令時，記得同步加到 `src-tauri/src/web/rpc.rs` 的對應表，否則 web 版會缺該功能。
