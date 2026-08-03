# LLM Wiki — Web Client + Server Runbook

This runbook documents the **browser client + backend server** deployment of
LLM Wiki. The original project is a Tauri desktop app; this runbook covers the
converted architecture where the UI runs in any modern browser and all native
work is done by a standalone Node.js backend.

> The desktop app is **unchanged** and still buildable (`npm run tauri dev` /
> `npm run build:desktop`, requires a Rust toolchain). The web build is an
> additional target that reuses the exact same React frontend.

---

## Architecture

```
┌──────────────────────────────┐   HTTP / SSE   ┌─────────────────────────────┐
│  Browser (React SPA)         │ ◄────────────► │  llm-wiki-server (Node.js)  │
│  - same React code as desktop│                │  - serves the built SPA     │
│  - Tauri APIs swapped for    │   /api/invoke  │  - 75 backend commands      │
│    web shims (Vite aliases)  │   /api/events  │  - persistent KV store      │
│                              │   /api/store   │  - raw file streaming       │
│                              │   /api/proxy   │  - outbound LLM proxy       │
└──────────────────────────────┘                │  - source-folder watcher    │
                                                └──────────────┬──────────────┘
                                                               │
                                          server filesystem (projects, wiki)
                                          + outbound HTTPS to LLM providers
```

The browser never touches the filesystem or LLM providers directly:

- **`invoke(command, args)`** → `POST /api/invoke/:command` (the same command
  names the desktop app uses, so the unmodified frontend works against either
  backend).
- **Tauri events** (file-sync, agent) → a single Server-Sent Events stream at
  `/api/events`.
- **plugin-store** (settings) → `/api/store/:name`, persisted as JSON files on
  the server.
- **Local file previews / images** → `/api/raw?path=…` streams the file.
- **Cross-origin LLM / embedding calls** → `/api/proxy` (a streaming proxy that
  replaces the desktop app's Rust HTTP plugin, so providers without CORS
  headers still work).
- **Folder / file dialogs** → an in-app picker modal that browses the *server's*
  filesystem (the browser has no access to it otherwise).

---

## One backend, shared user data (desktop + web)

LLM Wiki is designed so one user can run the **desktop app and the web app
against the same data**: anything you add or edit in one client is usable in
the other. You do **not** change or rebuild the desktop app — the web server
reads and writes the *same* on-disk state the desktop uses. The supported
topology is **same host** (or a shared mount): run the web server on the
machine where your projects live, as the same OS user.

What is shared, and how fresh it is:

| User data | Where it lives | Cross-client freshness |
|---|---|---|
| Wiki pages, sources, schema | `<project>/wiki`, `<project>/raw/sources` | **Live.** Same files on disk. The web UI auto-refreshes its file tree — and reloads an open page you are *not* currently editing — when the desktop changes a file (server filesystem watch + SSE). |
| Per-project state (chat history, review/lint items, ingest queue, file history) | `<project>/.llm-wiki/*.json` | **Live.** Read from disk on every access by both clients (no in-memory cache), so a chat/review/queue item added on one client shows on the other at next view. The source-watch state (`file-snapshot.json` / `file-change-queue.json`) is written by the web server in the desktop's exact on-disk format, so both watchers share one consistent snapshot/queue (see the "Source-folder auto-watch" row in the matrix). |
| App settings, provider keys, recents, last project | the desktop plugin-store file (`app-state.json`) | **Shared on disk.** The web server uses the desktop's own store file. Web reads see desktop edits immediately (mtime-aware); web writes are key-level, so they never clobber an unrelated key the desktop changed. |

How the web server locates the desktop store file:

- **Automatic (same host):** on start it scans the OS app-data dirs for the
  bundle id `com.llmwiki.app` (Linux `~/.local/share/com.llmwiki.app/`,
  macOS `~/Library/Application Support/com.llmwiki.app/`, Windows
  `%APPDATA%\com.llmwiki.app\`) and, if it finds an `app-state.json` with
  LLM Wiki keys, adopts it. `/api/health` then reports `store.shared: true`,
  `store.source: "auto"`.
- **Explicit:** `LLM_WIKI_STORE_FILE=/abs/path/app-state.json` points at any
  store file (`store.source: "explicit"`).
- **Web-only:** `LLM_WIKI_NO_SHARE=1` keeps web settings isolated in
  `LLM_WIKI_DATA_DIR/stores` (the original behavior).

One honest caveat (inherent to two clients sharing one file): the **desktop**
holds settings in memory and rewrites the whole file on autosave, so a setting
changed on the **web** reaches a *running* desktop only after a desktop
restart — whereas the web picks up desktop edits with no restart. Project
content and per-project state have **no** such caveat: they sync live both
ways because they are read from disk on access. If you edit the *same* setting
on both clients simultaneously, last writer wins — configure settings from one
client to avoid this.

Vector index note: semantic search in the web build uses a server-side cosine
index at `<project>/.llm-wiki/vectorstore.json`, which is **per client** (the
desktop uses LanceDB under `.llm-wiki/lancedb`). The two are not byte-identical
but yield equivalent rankings and each is rebuildable, so search results stay
consistent across clients even though the index bytes differ.


## Prerequisites

- **Node.js ≥ 20** (tested on v24). No Rust toolchain is needed for the web
  build or server.
- `npm` (ships with Node).

---

## Quick start (serve the built client from the server)

```bash
# 1. Install dependencies (root project; the server itself is dependency-free)
npm install

# 2. Build the browser client into ./dist-web
npm run build:web

# 3. Start the backend (serves the SPA + the API on the same origin)
npm run server

# 4. Open the client
#    http://127.0.0.1:19828
```

On first launch the server prints the URL, the number of registered commands,
and whether it found the web build. Open the URL, click **New Project** or
**Open Project**, and pick a folder on the *server* using the picker that
appears.

`npm run start:web` runs steps 2 + 3 in one command.

---

## Development workflow (hot reload)

Run the backend and the Vite dev server in two terminals. The dev server
proxies `/api` to the backend so the shims work unchanged.

```bash
# Terminal 1 — backend
npm run server                 # http://127.0.0.1:19828

# Terminal 2 — web dev server (proxies /api → 19828)
npm run dev:web                # http://localhost:1421
```

Edit `src/**` and the browser reloads. Edit `packages/server/src/**` and restart the
server (or `node --watch packages/server/src/index.js` via `npm --prefix packages/server run dev`).

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LLM_WIKI_PORT` | `19828` | HTTP port for the server (and the served SPA). |
| `LLM_WIKI_HOST` | `127.0.0.1` | Bind host. Set `0.0.0.0` to expose on the LAN. |
| `LLM_WIKI_AUTH_MODE` | unset (auto) | Auth mode: `none` = open; `token` = token required on non-public routes; unset = auto (open until a token is configured). `open` = synonym of `none`. Legacy `AUTH_MODE` works as a deprecated alias; the primary wins when both are set. |
| `LLM_WIKI_API_TOKEN` | unset | API token for non-public routes (Bearer / `x-llm-wiki-token` / `?token=`). Required in `token` mode, or in auto mode once set. |
| `LLM_WIKI_DATA_DIR` | `~/.llm-wiki-server` | Server-side persistent state (the plugin-store JSON files). |
| `LLM_WIKI_WEB_DIST` | `<repo>/dist-web` | Directory of the built web client to serve. |
| `LLM_WIKI_BACKEND` | `http://127.0.0.1:19828` | Backend the *dev* server proxies `/api` to (`dev:web` only). |
| `LLM_WIKI_ALLOW_SHELL` | unset | Escape hatch: set to `1` to let the agent’s `shell.exec` tool run ANY command without the per-command approval prompt (off by default). When unset, the desktop’s per-command approval policy applies — workspace-scoped commands run, everything else needs the user’s Approve (see the `Agent shell.exec` matrix row). |
| `LLM_WIKI_STORE_FILE` | unset | Absolute path to the plugin-store file to share. Overrides auto-detection; use to point the web server at the desktop's `app-state.json` (or a synced copy). |
| `LLM_WIKI_NO_SHARE` | unset | Set to `1` to disable sharing and keep web settings isolated in `LLM_WIKI_DATA_DIR/stores`. |

Example — expose to your LAN on port 8080 with a custom data dir:

```bash
LLM_WIKI_HOST=0.0.0.0 LLM_WIKI_PORT=8080 LLM_WIKI_DATA_DIR=/var/lib/llm-wiki \
  npm run start:web
```

> When binding to `0.0.0.0`, the server and the proxy are reachable on the
> network. Treat the host as trusted; the server exposes the filesystem the
> process can see (projects, file picker, raw streaming), matching the desktop
> app's local trust model.

---

## How the conversion works (for maintainers)

The web build is produced by `vite.web.config.ts`, which adds `resolve.alias`
entries that redirect every `@tauri-apps/*` import to a browser shim under
`src/web/`:

| Import | Web shim | Backed by |
|---|---|---|
| `@tauri-apps/api/core` (`invoke`, `convertFileSrc`) | `src/web/core.ts` | `/api/invoke`, `/api/raw` |
| `@tauri-apps/api/event` (`listen`, `once`) | `src/web/event.ts` | `/api/events` (SSE) |
| `@tauri-apps/api/window` | `src/web/window.ts` | CSS theming / `document.title` |
| `@tauri-apps/plugin-dialog` | `src/web/dialog.ts` | server-backed picker modal |
| `@tauri-apps/plugin-store` | `src/web/store.ts` | `/api/store/:name` |
| `@tauri-apps/plugin-opener` | `src/web/opener.ts` | server-side OS open/reveal (`web_open_path` / `web_reveal_path`), `window.open` / `/api/raw` fallback |
| `@tauri-apps/plugin-autostart` | `src/web/autostart.ts` | no-op |
| `@tauri-apps/plugin-http` | `src/web/http.ts` | `/api/proxy` (cross-origin) |

The shims are **only** pulled in by the web build. The desktop build keeps
using `vite.config.ts` with the real Tauri APIs, so `npm run tauri dev` and
`npm run build:desktop` are unaffected.

The backend command handlers live in `packages/server/src/commands/` and are faithful
Node ports of the Rust commands (filesystem, project scaffolding, keyword
search, page links, file history, source-folder watch, server-side embeddings,
SearXNG/Tavily/SerpApi web search). Commands that fundamentally need the native
backend return a clear "not available in web-server mode" error so the UI
degrades gracefully instead of crashing.

---

## Feature matrix: web mode vs desktop

Legend: ✅ works in the browser build · ⚠️ partial / opt-in · ❌ desktop-only (documented).

| Feature | Web mode | Notes |
|---|---|---|
| Create / open / switch projects | ✅ | server-backed folder picker; opening an existing (desktop-created) project through the picker is covered by the headless e2e (gate 7/7) |
| File tree, wiki editing, preview | ✅ | Knowledge tree + Files tree + wiki page render are proven end-to-end by the headless browser e2e (gate 7/7) |
| Ingest — Markdown / text / HTML / code | ✅ | |
| Ingest — PDF / DOCX / PPTX / XLSX / ODF / EPUB / Org | ✅ | parsed server-side (pdfjs-dist + zip/xml); legacy `.xls` (SheetJS) and best-effort `.doc` (word-extractor) are covered by the two rows below — only HUFF/CDIC `.mobi` must be converted first |
| Multimodal embedded-image extraction + vision captions | ✅ | server-side extraction for **PDF + DOCX + PPTX** (`packages/server/src/commands/extractImages.js`: pdfjs + a pure-Node PNG encoder re-encodes decoded PDF raster; OOXML embedded media are read straight from the zip) writes images to `wiki/media/<slug>/` with the exact camelCase `SavedImage`/`ExtractedImage` shapes, so vision captions run client-side over `/api/proxy`. Verified 18/18 isolated + e2e via `/api/invoke` (JPEG2000/JPX PDF images skipped gracefully) |
| Legacy spreadsheet `.xls` (BIFF/OLE2) | ✅ | parsed server-side via SheetJS (`xlsx`); verified by a BIFF8 write→extract round-trip (the desktop uses calamine). |
| Legacy Word `.doc` (OLE2) + HUFF/CDIC `.mobi` | ⚠️ | `.doc` is best-effort via `word-extractor` (library-backed; success not unit-verifiable on hosts lacking a `.doc` sample/LibreOffice, failures degrade to a clean convert-first error and never crash ingest; desktop uses OLE2/antiword). HUFF/CDIC `.mobi` is not decoded (clear convert-to-EPUB error; desktop uses the `mobi` crate). PalmDOC/uncompressed `.mobi` is supported. |
| Keyword search | ✅ | |
| Vector / semantic search | ✅ | server-side cosine store at `.llm-wiki/vectorstore.json`; embeddings computed server-side (CORS-free); **blended into search ranking via RRF** (`keyword + vector + graph`, mirroring `apply_rrf_scores` + `search_by_embedding`), with vector-only hits materialized; index is per-client (desktop uses LanceDB) but rankings match |
| Graph view (4-signal relevance, communities) | ✅ | computed client-side over the wiki files |
| Graph-boosted search ranking / agent `graph.search` | ✅ | server-side wikilink neighbor-expansion (`packages/server/src/graph.js`), matching the desktop: search returns `mode: "hybrid"` with `graphHits` and synthesized "Graph neighbor of …" results; the agent `graph.search` tool returns `matched entity` + `direct neighbor` refs (verified against the desktop's own unit-test fixture) |
| Page links / backlinks / missing links | ✅ | |
| Web search (SearXNG / Tavily / SerpApi) | ✅ | other providers report a clear, actionable error |
| Source-folder auto-watch + change queue | ✅ | server `fs.watch` + SSE events. The scan state is **shared on disk with the desktop**: `packages/server/src/commands/fileSync.js` reads and writes `.llm-wiki/file-snapshot.json` in the desktop's exact wrapped shape (`{version,updatedAt,files:{<rel>:{hash,size,mtimeMs}}}`, the Rust `FileSnapshot` serde struct, camelCase) and `.llm-wiki/file-change-queue.json` as `{version,tasks}` with the desktop's camelCase `FileChangeTask` fields — so a watcher on either client interprets the same snapshot identically (no spurious mass create/delete when both run against one project). Diff semantics mirror `enqueue_paths`: a file is "modified" by `(hash,size)`, not mtime (a bare touch is not re-ingested), and sources >32 MiB get `hash:null` (`MAX_HASH_BYTES`) and diff by size. Reading also tolerates the legacy flat map an older web server wrote. Verified 19/19 (desktop-snapshot read, wrapped write, no wrapper-key garbage tasks, `(hash,size)` diff, >32 MiB hash skip, legacy-flat tolerance). |
| Live cross-client content sync | ✅ | server watches the whole project; web auto-refreshes the tree and reloads an open (non-editing) page when the desktop edits a file |
| File history / restore | ✅ | |
| Settings & recents persistence | ✅ | **shared with the desktop** via its plugin-store file (see "One backend, shared user data") |
| Chat — direct (streaming) | ✅ | routed via `/api/proxy` so providers without CORS headers still work |
| Chat — agent mode (tool loop + streaming) | ✅ | server-side runtime; tools: wiki/source/web search, read/write pages, workspace files; verified against a mock LLM in both stream and non-stream modes |
| Local HTTP API + MCP server + agent skill | ✅ | the web server speaks the desktop's exact `/api/v1/*` REST contract (`packages/server/src/api-v1.js`: `/projects`, `/projects/:id/files`, `/files/content` with the public-path guard, `/reviews`, `/search`, `/graph`, `/chat`, `/chat/:sid/cancel`, `/sources/rescan`, `/health`) with the same auth (shared `apiConfig.token` / `LLM_WIKI_API_TOKEN`; `Bearer` / `?token=` / `x-llm-wiki-token`) and response envelopes, so the bundled MCP server (`mcp-server/`) and the external agent skill work against the web backend unchanged via `LLM_WIKI_API_BASE_URL`. Verified 27/27 api-v1 checks passed and 17/17 with the real compiled MCP client (`mcp-packages/server/src/api-client.ts` transpiled and driven end-to-end). |
| Chat — Claude Code CLI / Codex CLI backends | ✅ | the server runs on the host, so it spawns the same `claude` / `codex` binaries the desktop does (`packages/server/src/cli.js`, a faithful port of `claude_cli.rs` / `codex_cli.rs`): `*_detect` reports `{installed,version,path,error}` (incl. the macOS quarantine hint); `*_spawn` validates the project working directory, pipes the reconstructed history/prompt over stdin, and streams each stdout line back as `claude-cli:{streamId}` / `codex-cli:{streamId}` SSE events with a terminal `:done {code,stderr[,stdout]}`; `*_kill` SIGKILLs the child. Login-shell PATH is resolved so node-shim CLIs work under a GUI/daemon. Verified 38/38 against mock CLIs |
| Agent skills (`SKILL.md` scan, `/skill`) | ✅ | server scans the same roots as the desktop (project `.llm-wiki/skills` + `~/.claude|~/.codex|~/.agents/skills`); `agent_list_skills` lists them, selected skills are injected into the agent prompt in the desktop's exact `<skill>`/`<available_skills>` format, and `skills.load`/`skill.read_file` resolve references (verified 15/15 + e2e injection) |
| Agent `shell.exec` | ✅ | **per-command approval, faithful to the desktop** (`packages/server/src/shell-policy.js`, a 1:1 port of `runtime.rs`): a skill-gated `shell.exec` runs immediately only if it is in the turn’s `approvedShellCommands` or scoped to the agent workspace (no network/curl/wget/scp/ssh, no `$HOME`/`~`/`..`/external absolute paths); anything else stops the turn with the desktop’s exact “The Agent needs approval…” message plus an `available`→skipped `shell_exec` step, and the Approve button resumes a new turn with `approvedShellCommands` (the desktop’s stateless resume contract — no parked run). `LLM_WIKI_ALLOW_SHELL=1` is an opt-in escape hatch that bypasses the prompt. Verified 39/39 with a mock LLM (policy fixtures + stream/non-stream approval, resume-runs, workspace auto-allow, skills-gate rejection, preference-probe skip, unknown-project/cancel). |
| Deep Research (UI feature: multi-query web search + auto-ingest) | ✅ | frontend-orchestrated over `web_search` + the ingest queue |
| Deep Research (agent `deep_research.run` tool) | ✅ | runtime-orchestrated exactly like the desktop: the tool is never offered to the model; in deep mode the agent brackets retrieval with `deep_research.run` start/end events (`"<N> reference(s)"`), and model-issued calls are rejected by the loop executor |
| Project archive export / import (zip) | ✅ | server-side (jszip) |
| Rebuild wiki index | ✅ | |
| Chrome Web Clipper + autostart | ❌ | desktop companions; the browser has no OS/extension bridge |
| Open in OS file manager / reveal | ✅ | the server runs on the host, so it spawns the OS handler exactly like the desktop (`packages/server/src/opener.js`, a faithful port of `tauri-plugin-opener`: `xdg-open` / FileManager1 D-Bus reveal on Linux, `open`/`open -R` on macOS, `explorer` on Windows). `open_project_folder` + `open_path_in_project` keep the desktop's exact validation, path-containment guard, and open→reveal fallback errors; the opener shim's `openPath` falls back to a browser tab via `/api/raw` when the host has no handler (headless). Verified 23/23 against mock `xdg-open`/`dbus-send` |

## Unattended / overnight runs (22:00–08:00 Beijing)

`scripts/overnight-schedule.sh` drives the parity work unattended during the
22:00–08:00 Beijing window by firing a headless `codex exec` continuation at
the top of each in-window hour. Each run re-derives state from the worktree
(“work from evidence”), closes one gap, verifies it, and leaves a green tree.

```bash
scripts/overnight-schedule.sh install     # add the crontab entry (idempotent)
scripts/overnight-schedule.sh status      # Beijing time, in-window?, lock?, last run, log tail
scripts/overnight-schedule.sh uninstall   # remove the crontab entry
scripts/overnight-schedule.sh run         # the cron target (time-guarded + locked)
```

How it behaves:

- **Window:** Beijing hours 22,23,0,1,2,3,4,5,6,7 (i.e. 22:00–08:00). A run
  started outside the window no-ops (the guard also protects manual runs).
- **No stacking:** a `flock` on `.overnight/overnight.lock` makes an hourly
  tick skip if the previous session is still running.
- **Prompt-free:** `codex exec` runs with `-s danger-full-access` (the same
  trusted-unattended posture this repo uses for manual full-access sessions,
  and it avoids the `bwrap` sandbox-init failure seen under `workspace-write`).
- **Cron PATH + trust:** the script `cd`s into the repo and auto-discovers the
  nvm-managed `node`/`codex` bin dir (plus `/usr/local/bin`, homebrew, snap,
  `~/.local/bin`, `~/.cargo/bin`) at runtime, and invokes codex with
  `-C <repo> --skip-git-repo-check --ephemeral` so the hourly tick passes both
  cron's minimal `PATH` *and* the "trusted directory" gate. Verified by running
  the real codex code path under `env -i PATH=/usr/bin:/bin` (model replied,
  `rc=0`). Override the sandbox with `NIGHT_SANDBOX=...`; `NIGHT_PROMPT=...`
  feeds a custom prompt for cheap testing of the unattended path.
- **Auditable:** all output goes to `.overnight/overnight.log` (gitignored);
  `.overnight/last-run.txt` records the latest start/end.
- **Self-scoping:** the continuation prompt greps the server for the remaining
  stubs (`notSupported(`, `noop`, `"not available in web-server mode"`) and the
  RUNBOOK matrix, implements the highest-value gap, verifies against the
  standing acceptance gates (`/tmp/gates.sh`: `node --check`, `tsc --build`,
  the shell-approval + agent + shared-data/file-sync harnesses, the headless
  browser boot, and the headless browser **end-to-end** that opens a project
  via the picker and renders the file tree + a wiki page), updates the RUNBOOK,
  and **does not commit or push**.
- **Prereqs:** a running cron daemon (present on this host) and a valid
  `codex` login for the user the cron runs as. If auth expires, the run logs an
  auth error — re-run `codex login` to fix.

Test hooks (manual verification only; never set by the cron line):
`NIGHT_HOUR_OVERRIDE=<0-23>` to exercise the time guard, `NIGHT_RUN_CMD="..."`
to run a stand-in command instead of `codex`, `NIGHT_DRY=1` to print the exact
`codex exec` invocation without running it, and `NIGHT_FORCE=1` to bypass the
window guard.

## Remaining parity delta (the overnight queue)

These are the desktop features not yet mirrored in the web build. They are the
explicit punch list the overnight runs work through; the goal is only “done”
when each row is either implemented or confirmed genuinely impossible in a
browser (and kept as a documented no-op, as the OS/clip/autostart rows already
are):

- ~~**Multimodal embedded-image extraction + vision captions**~~ — **done** for PDF + DOCX + PPTX (`packages/server/src/commands/extractImages.js`): pdfjs + a pure-Node PNG encoder re-encodes decoded PDF raster; OOXML embedded media are read straight from the zip (no re-encode). Images are written to `wiki/media/<slug>/` with the exact camelCase wire shapes the frontend hard-filters on, so vision captions (client-side, over `/api/proxy`) work too. Verified 18/18 in isolation + end-to-end via `/api/invoke`. (Exotic PDF image codecs such as JPEG2000 are skipped gracefully.)

- ~~**Claude Code CLI / Codex CLI chat backends**~~ — **done**
  (`packages/server/src/cli.js`): faithful Node port of the desktop's Rust subprocess
  transports (`claude_cli.rs`, `codex_cli.rs`, `cli_resolver.rs`). The server
  runs on the host, so it spawns the locally-installed `claude` / `codex`
  binaries and treats them as completion engines — reusing an existing Claude
  Code subscription or Codex login with no separate API key. `*_detect`
  returns the desktop's `{installed,version,path,error}` shape (incl. the
  macOS quarantine hint); `*_spawn` validates the project working directory
  (must contain `wiki/index.md`), folds system messages into the first user
  turn, writes the stream-json turns / prompt over stdin, and streams each
  stdout line back as `claude-cli:{streamId}` / `codex-cli:{streamId}` SSE
  events with a terminal `:done {code,stderr[,stdout]}` (codex honors the
  clamped `timeoutMinutes`, 1–240, default 10); `*_kill` SIGKILLs the child.
  Login-shell PATH is resolved (cached) so node-shim CLIs work even under a
  GUI/daemon launch with a minimal PATH. Verified 38/38 against mock CLIs on
  PATH (stdin serialization fidelity incl. system-preamble fold + image-block
  reshape, exact arg vectors for base + isolated modes, non-zero exit + stderr
  relay, all four working-directory guards, empty-conversation/prompt errors,
  and kill → `done {code:null}`), plus pure-function unit checks mirroring the
  Rust unit tests (timeout clamping, arg builders, shell-PATH parsing).
- ~~**Vector ranking blended into search results (RRF)**~~ — **done**
  (`packages/server/src/commands/search.js`): `search_project` now resolves the query
  embedding server-side, runs the per-page chunk blend (`search_by_embedding`),
  materializes vector-only hits, and fuses `keyword + vector + graph` with RRF
  (`apply_rrf_scores`), so web search ranking matches the desktop hybrid
  engine. Verified 18/18 (RRF fusion, vector-only snippets, graceful
  embedding-failure fallback). Falls back to keyword+graph if embeddings are
  disabled or the endpoint is unreachable. (The 4-signal relevance model in
  `graph-relevance.ts` stays client-only — it powers the Graph view.)
- ~~**Agent skills scanning**~~ — **done** (`packages/server/src/skills.js`): same scan
  roots as the desktop, prompt injection in the desktop format, reference reads.
  Verified against the desktop's own skill-loader contract (CRLF, symlink and
  path-traversal rejection, reserved-name rejection).
- ~~**Deep Research agent tool**~~ — **done**
  (`packages/server/src/agent.js` + `packages/server/src/agent-tools.js`): faithful port of the
  desktop's runtime-orchestrated contract (`src-tauri/src/agent/runtime.rs` +
  `tools.rs`). `deep_research.run` is **not** offered to the model
  (`toolsForRequest` omits it); when `request.mode === "deep"` and at least one
  retrieval channel is active (`request.tools.web || request.tools.anytxt ||
  wiki/source search offered`), the runtime brackets the retrieval phase with a
  `deep_research.run` `toolStart` (input = the user message) before the loop and
  a `toolEnd` (`"<N> reference(s)"`, N = accumulated deduped references) after
  it — emitted over SSE *and* pushed into the non-stream `toolEvents` array
  with `detail`, mirroring the desktop's `AgentToolEvent`s. Deep mode does
  **not** force web search on (`web.search` stays gated by `request.tools.web`).
  The registry-level executor returns the desktop marker
  `{query, status:"orchestrated_by_agent_runtime"}` (requiring a non-empty
  `query`), while a model-issued call is refused by the loop executor with the
  desktop's exact error ("deep_research.run is not available in the loop
  executor; use web.search, anytxt.search, source.search, and wiki.search
  directly") — surfaced as a `rejected: …` tool observation back to the model
  and a `failed` tool event, exactly like `record_loop_tool_rejection`.
  Verified 47/47 with a mock OpenAI-compatible LLM: exact SSE sequence
  (`toolStart → referenceAdded → toolEnd → messageDelta [→ done]`) and
  non-stream `BackendAgentResponse` shape; deep-mode start/end events over SSE
  + `toolEvents` (stream and non-stream); non-deep silence; the tool absent
  from the offered tool specs in every recorded LLM request; the exact
  rejection round-trip; plus cancel + unknown-project errors.

- ~~**Open in OS file manager / reveal**~~ — **done**
  (`packages/server/src/opener.js` + `packages/server/src/commands/project.js` +
  `packages/server/src/commands/openerWeb.js`): the web server runs on the user's
  host, so the desktop's OS-open actions are real there too. `opener.js`
  faithfully ports `tauri-plugin-opener` v2 semantics — `open_path`
  (existence check + detached platform spawn: `xdg-open` / `open` /
  `cmd /c start`, exit status deliberately unobserved, like
  `open::that_detached`) and `reveal_item_in_dir` (canonicalize, then
  macOS `open -R`, Windows `explorer /select,`, Linux freedesktop
  `FileManager1.ShowItems` over `dbus-send` → xdg-desktop-portal
  `OpenURI.OpenDirectory` → `xdg-open <parent>` fallback chain).
  `open_project_folder` / `open_path_in_project` are exact ports of the
  Rust commands (project-root validation, canonicalization, the
  component-wise path-containment guard, and the
  `Failed to open …; reveal fallback also failed: …` compound errors),
  and two web-only commands (`web_open_path` / `web_reveal_path`) back
  the browser's `@tauri-apps/plugin-opener` shim — `openPath` keeps a
  browser-tab (`/api/raw`) fallback for headless hosts. Login-shell PATH
  resolution (shared with the CLI transports) finds `xdg-open`/`dbus-send`
  even under a GUI/daemon's minimal PATH. Verified 23/23 against mock
  `xdg-open`/`dbus-send` binaries (spawn args + canonicalization, relative
  and absolute targets, symlink and `..` escape refusal, exact validation
  and compound error strings, the open→reveal fallback, and the full Linux
  reveal failover chain).

- ~~**Per-command `shell.exec` approval**~~ — **done** (`packages/server/src/shell-policy.js` + `packages/server/src/agent.js`): the web agent now mirrors the desktop’s exact per-command approval contract instead of the old all-or-nothing `LLM_WIKI_ALLOW_SHELL` gate. Faithful 1:1 port of `runtime.rs`: `is_shell_command_allowed_without_prompt` (exact `approvedShellCommands` match OR workspace-scoped auto-allow), the skills-active gate, the skill-preference-probe skip, and the exact “The Agent needs approval before it can run this command…” boundary message. The turn stops at the boundary; the frontend’s existing Approve button (driven by the `available`→skipped `shell_exec` step with detail `approval required: <cmd>`) resumes a new turn with `approvedShellCommands`. Verified 39/39 against the desktop’s own policy unit-test fixtures plus a mock OpenAI-compatible LLM over both `agent_start_turn_stream` (SSE) and `agent_start_turn`.

- ~~**Headless browser end-to-end UX proof**~~ — **done** (`/tmp/verify-browser-e2e.mjs`, standing gate 7/7): a Playwright (Chromium) run that serves the built SPA from the server with an empty isolated store, creates a fake "desktop" project on disk (one the web client did *not* create — the shared-data scenario), then drives the real UI: it opens the project through the server-backed folder picker (`list_directory` navigation + Select), asserts the Knowledge tree lists the wiki pages, a clicked wiki page renders its Markdown body in the reader, and the Files tab renders the raw project tree (`schema.md` / `wiki` / `raw`) — all with ZERO page errors, ZERO genuine app console errors, and ZERO failed requests. The only tolerated HTTP ≥400 traffic is the documented graceful read of optional per-project state (`.llm-wiki/review.json`, `lint.json`, `conversations.json`, …) that a fresh project lacks (the desktop errors on these too and falls back to empty defaults); the harness asserts every ≥400 is exactly such a read, so any other failing request fails the gate. Verified 13/13, deterministic across repeated runs. (This supersedes the boot-only smoke, which only checked the welcome screen.)

- ~~**Web Files tree did not render after opening a project (race)**~~ — **fixed** (`src/App.tsx`): opening a project left the Files tree permanently empty in the browser. `handleProjectOpened` cleared the outgoing view state (`setSelectedFile(null)` + `setFileTree([])`) *after* `setProject`, racing `AppLayout`'s asynchronous `refreshProjectFileTree`: on the web backend the HTTP store reads (`loadProjectLlmOverride` / `loadOutputLanguage`) between `setProject` and the clear delayed it until *after* the fresh tree had landed, wiping it with no re-trigger. On desktop the in-memory plugin-store reads made the clear win the race, which is why it only surfaced on the web. The two clears now run *before* `setProject`, making the ordering deterministic on both backends; `resetProjectState()` still clears every per-project store first, so the cross-project-contamination invariant is preserved (and the stale-tree flash is shortened). Proven by gate 7/7 (Files tree renders) and the full 1734-test frontend suite.

- **HUFF/CDIC `.mobi`** — the only remaining binary-ingest gap: the web
  server decodes PalmDOC/uncompressed `.mobi` but not HUFF/CDIC (the desktop
  uses the `mobi` crate); a from-scratch JS HUFF/CDIC decoder is not
  shippable-quality, so this stays a documented convert-to-EPUB limitation.
  Legacy `.xls` is now supported (SheetJS, verified) and legacy `.doc` is
  best-effort (`word-extractor`, crash-safe). Overnight runs must NOT replace this with an untested decoder (no HUFF fixture exists on this host to verify it); keep the documented limitation unless a verifiable fixture+test can be produced.




## Notes & troubleshooting

- **Expected 404/500 in the browser console for a fresh project.** On open the
  app reads optional state files (`review.json`, `lint.json`,
  `conversations.json`, …) that don't exist yet; the code catches the "not
  found" and uses empty defaults — exactly as the desktop app does (the Rust
  `read_file` also errors on missing files). The browser logs the HTTP status;
  it is harmless.
- **"Web client build not found"** when opening the server URL → run
  `npm run build:web` (the server serves `dist-web`, which is empty until you
  build).
- **Port already in use** → set `LLM_WIKI_PORT` to a free port.
- **LLM provider CORS errors** → should not happen: LLM and embedding traffic
  goes through `/api/proxy`. If you see a direct browser CORS error, the
  request is same-origin or the provider blocked the server's outbound IP.
- **`npm run typecheck`** validates both the shims and the app together
  (`src/web/**` is part of the normal TypeScript project).

---

## Still want the desktop app?

The Tauri desktop build is intact:

```bash
# requires Rust: https://www.rust-lang.org/tools/install
npm run build:desktop          # builds mcp-server + web assets
npm run tauri build            # native installer
# or for development:
npm run tauri dev
```

The web and desktop builds share `src/`; only the build config and the
`@tauri-apps/*` resolution differ.
