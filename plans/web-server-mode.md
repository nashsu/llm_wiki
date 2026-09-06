# Web / Server Mode

> **中文摘要**：`llm-wiki-server` 是一個不依賴 Tauri 的 headless 後端，把同一套 React 前端透過 HTTP 提供給瀏覽器使用。前端所有對宿主的呼叫（`invoke`、事件、檔案 URL、對外 HTTP、設定儲存、對話框）都改走 `src/lib/backend/` 這一層，在桌面版走 Tauri、在瀏覽器走 `/web/*` 路由。Rust 端用 `AppCtx` 取代 `tauri::AppHandle`，指令函式在兩種 build 裡共用，`web/rpc.rs` 把 78 個指令對應到 JSON-RPC。適合單人／小團隊自架（一組密碼、cookie session），不是多租戶 SaaS。

LLM Wiki was built as a Tauri desktop application. Server mode adds a second
host for the same code: a headless Rust binary that serves the built React
frontend and answers everything the frontend used to get from Tauri IPC.

```
┌──────────────── browser ────────────────┐      ┌──────────── llm-wiki-server ────────────┐
│ React app (unchanged feature code)      │      │ axum (:8080)                            │
│   src/lib/backend/web.ts                │ HTTP │   /web/rpc/{cmd}  → web/rpc.rs → commands│
│     invoke()   ──────────────────────────┼─────►│   /web/events     ← AppCtx::emit (SSE)  │
│     listen()   ◄─────────────────────────┼──────┤   /web/file       ← ServeFile           │
│     fileSrc()  ──────────────────────────┼─────►│   /web/upload     → <data>/uploads/…    │
│     getFetch() ──── LLM / embeddings ────┼─────►│   /web/proxy      → reqwest → provider  │
│     loadStore()──────────────────────────┼─────►│   web_store_*     → app-state.json      │
│   <WebGate/> login  ─────────────────────┼─────►│   /web/auth/*     cookie session        │
└─────────────────────────────────────────┘      │ tiny_http :19828  local API (MCP)       │
                                                 │ tiny_http :19827  clip server           │
                                                 └─────────────────────────────────────────┘
```

## Running

```bash
# one-off local run (Rust 1.88+, Node 20+, protoc)
npm install && npm run build            # builds dist/
npm run web:serve                        # cargo run … llm-wiki-server --static-dir dist
# → http://127.0.0.1:8080  (loopback + no password = open access)

# release binary
npm run web:build
./src-tauri/target/release/llm-wiki-server --host 0.0.0.0 --port 8080 --password 'secret' \
    --data-dir ~/.llm-wiki --static-dir dist --resource-dir src-tauri

# Docker
docker compose up -d                     # see docker-compose.yml; set LLM_WIKI_WEB_PASSWORD
```

Flags / environment:

| Flag             | Env                       | Default               | Meaning                                             |
|------------------|---------------------------|-----------------------|-----------------------------------------------------|
| `--host`         | `LLM_WIKI_WEB_HOST`       | `127.0.0.1`           | bind address                                        |
| `--port`         | `LLM_WIKI_WEB_PORT`       | `8080`                | bind port                                           |
| `--password`     | `LLM_WIKI_WEB_PASSWORD`   | *(none)*              | shared password; generated when binding non-loopback|
| `--data-dir`     | `LLM_WIKI_DATA_DIR`       | `~/.llm-wiki`         | `app-state.json`, uploads, downloads                |
| `--static-dir`   | `LLM_WIKI_STATIC_DIR`     | auto-detect `dist/`   | built frontend                                      |
| `--resource-dir` | `LLM_WIKI_RESOURCE_DIR`   | auto-detect           | folder containing `pdfium/` and `mcp-server/dist`   |
|                  | `LLM_WIKI_BIND_HOST`      | `127.0.0.1`           | bind host of the local API (:19828) / clip (:19827) |

Frontend development against a running server: `npm run dev` proxies `/web/*`
to `http://127.0.0.1:8080` (override with `LLM_WIKI_SERVER_URL`).

## Security model

Single-user / small-team self-hosting, deliberately simple:

* One shared password. `POST /web/auth/login` sets an `HttpOnly; SameSite=Lax`
  session cookie; scripts may send `Authorization: Bearer <password>` instead.
* Every `/web/*` route except `health`, `auth/*` and the connectors' OAuth
  redirect target (`/web/connectors/oauth/callback`, validated by its one-time
  `state` token — see `plans/connectors.md`) requires the session. The static
  frontend shell is public (it contains no data).
* No password + loopback bind = open access (same trust model as the desktop
  app). No password + non-loopback bind = a random password is generated and
  printed on stdout, so the server is never silently exposed.
* `/web/file` only serves paths inside registered project folders or the data
  dir. The same allow-list is enforced on the RPC bridge for every raw
  filesystem command (`read_file`, `write_file*`, `list_directory`,
  `copy_*`, `delete_file`, file history, extraction, archive export …) —
  see `PATH_GUARDED_COMMANDS` in `web/rpc.rs`. Folders opened, created or
  imported through the bridge in this server session count as registered
  immediately (the persisted registry is written by the frontend only after
  `open_project` returns). Project registration commands themselves are
  unguarded on purpose: picking a new folder is how roots get added. `/web/proxy` is reachable only after authentication (an authenticated
  user can already point the app at any URL through Settings, so this adds no
  new capability).
* Put TLS in front (Caddy / nginx / Tailscale) for anything beyond a LAN.

## Code layout

### Rust (`src-tauri/`)

| File                         | Role                                                                                       |
|------------------------------|--------------------------------------------------------------------------------------------|
| `Cargo.toml`                 | features: `desktop` (default, Tauri + plugins) and `server`; bins `llm-wiki`, `llm-wiki-server` |
| `src/app_ctx.rs`             | `AppCtx`: data dir, resource dir, managed state, `emit()`. Wraps `AppHandle` on desktop; standalone headless. Implements `tauri::ipc::CommandArg`, so commands take `ctx: AppCtx` like they took `AppHandle`. |
| `src/rt.rs`                  | `spawn` / `spawn_blocking` / `block_on` over `tauri::async_runtime` or an owned tokio runtime |
| `src/app_commands.rs`        | agent turn / session / status commands moved out of `lib.rs`, ctx-based                    |
| `src/lib.rs`                 | module tree + `register_shared_state()`; Tauri `run()` lives in a `#[cfg(feature = "desktop")]` module |
| `src/web/mod.rs`             | axum server: options, auth, routes (rpc, events, file, upload, proxy), static hosting, `maybe_start_embedded()` |
| `src/web/rpc.rs`             | `dispatch(ctx, name, args)`: every IPC command by name (camelCase args, same as Tauri). Test `rpc_covers_every_tauri_command` keeps it in sync with `generate_handler!`. |
| `src/web/store.rs`           | key/value access to `app-state.json` (same file `tauri-plugin-store` writes)              |
| `src/bin/llm-wiki-server.rs` | binary entry → `web::main()`                                                               |

Mechanical changes across `commands/*`, `agent/skills.rs`, `api_server.rs`,
`clip_server.rs`, `server_bind.rs`: `#[tauri::command]` →
`#[cfg_attr(feature = "desktop", tauri::command)]`, `tauri::async_runtime::*`
→ `crate::rt::*`, `AppHandle` / `State<T>` → `AppCtx` / `ctx.state::<T>()`.
No command body changed.

### Frontend (`src/`)

| File                                      | Role                                                                   |
|-------------------------------------------|------------------------------------------------------------------------|
| `lib/backend/types.ts`                    | `Backend` interface                                                    |
| `lib/backend/tauri.ts`                    | pass-throughs to `@tauri-apps/*` (also what unit tests mock)           |
| `lib/backend/web.ts`                      | HTTP implementation; `proxiedFetch`; upload helpers                    |
| `lib/backend/index.ts`                    | runtime selection; `invoke`, `listen`, `convertFileSrc`, `backend`     |
| `lib/backend/web-dialog-store.ts`         | queue for dialogs the web backend needs rendered                       |
| `components/web/web-dialog-host.tsx`      | server folder picker + message box                                     |
| `components/web/web-gate.tsx`             | session check + login screen (renders children directly on desktop)    |
| `lib/tauri-fetch.ts`                      | `getHttpFetch()` now resolves through the backend                      |

Every former `import … from "@tauri-apps/…"` in feature code now imports from
`@/lib/backend`. Plugin replacements on the web:

| Tauri plugin        | Web replacement                                                     |
|---------------------|---------------------------------------------------------------------|
| `plugin-store`      | `web_store_get/set/delete/clear/entries` RPC → `app-state.json`     |
| `plugin-dialog`     | files → `<input type=file>` + `/web/upload`; folders → server picker (`web_list_dirs`), optional folder upload; `save()` → path under `<data>/downloads/`, then `backend.deliverFile()` triggers a browser download; `message()` → in-app dialog |
| `plugin-http`       | `/web/proxy` (status + headers returned in `x-proxy-*`, body streamed)|
| `plugin-opener`     | `window.open` for URLs; `openPath` rejects                          |
| `plugin-autostart`  | no-op (`backend.autostart.supported === false`)                     |
| `api/window` theme  | already guarded by `isTauriRuntime()`                               |
| asset protocol      | `/web/file?path=…` (auth + project-root allow-list, range requests) |

## What works today (verified in Chromium against the headless server)

* login → welcome → create project via the server folder picker → wiki tree
* page preview, settings persistence across reloads, recent-project restore
* file import via browser upload → copied into `raw/sources/`
* search RPC, chat turn through the Rust agent runtime with live `agent-event`
  SSE updates, outbound LLM calls through `/web/proxy` with incremental
  streaming
* local API (:19828) and clip server (:19827) run unchanged, so the MCP
  server and Chrome clipper keep working against the headless backend

## Known gaps / next milestones

1. **Ingest end-to-end with a real provider** — the pipeline runs in the
   browser exactly as on desktop, calling providers through `/web/proxy`;
   needs a soak test with real keys (Ollama on the server host is the
   natural first target: point the endpoint at `http://127.0.0.1:11434`).
2. **Folder import UX** — folder uploads land in `<data>/uploads/<batch>/`
   and are then copied into the project; large trees should stream or be
   imported in place. Scheduled-import / Source Watch directories must be
   server paths.
3. **Multi-tab safety** — two browser tabs on the same project both run the
   ingest queue; the desktop app had one window. Add a "queue owner" lease
   (or move the queue driver into Rust — see 5).
4. **Desktop-hosted web server** — `web::maybe_start_embedded()` reads
   `webServerConfig {enabled, host, port, password}` from `app-state.json`;
   still needs a Settings section to edit it and to ship the frontend in
   the Tauri resource dir.
5. **Move ingest/dedup/deep-research into Rust** — the architectural end
   state upstream hints at in `agent/mod.rs`; makes the browser a thin
   client and removes the multi-tab issue. Large (ingest.ts alone is
   ~140 KB), so keep it a separate milestone.
6. Hardening: rate-limit login, optional TLS termination, `Secure` cookie
   when served over HTTPS, upload quota / cleanup of `<data>/uploads`.

## Upstreaming

The change is additive to the desktop build (feature-gated, zero
behavioural change on desktop; `cargo check --features desktop` and the
full vitest suite pass). It is GPL-3.0 like upstream, so it can go back to
`nashsu/llm_wiki` as a PR: "Add headless web server mode".
