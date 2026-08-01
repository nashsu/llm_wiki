# LLM Wiki — Goal Definition

> **Cross-references**: [V1_CHARTERED_ARCHITECTURE.md](V1_CHARTERED_ARCHITECTURE.md) (design) · [PLAN.md](PLAN.md) (implementation plan) · [RUNBOOK.md](RUNBOOK.md) (current operational runbook)

---

## Goal Statement

**Transform LLM Wiki from a desktop application into a client-server architecture where one Express server (with Zod validation, SQLite + sqlite-vec storage, worker threads, and incremental graph indexing) serves any number of web clients via a versioned REST API, with all user data centralized on the server and every feature the desktop app offers today fully mirrored in the new architecture.**

---

## Architecture Decisions (locked)

These 17 decisions are final for v1. See [V1_CHARTERED_ARCHITECTURE.md §2](V1_CHARTERED_ARCHITECTURE.md) for rationale.

| # | Decision | Choice |
|---|---|---|
| 1 | Deployment | Self-hosted only |
| 2 | Repo structure | Monorepo with workspaces |
| 3 | HTTP framework | Express |
| 4 | Web client connection | Both (local + remote); simple login |
| 5 | Storage | Hybrid: files + SQLite |
| 6 | Desktop v1 | Deferred |
| 7 | Ingest | Server-driven |
| 8 | API contract | Zod-first |
| 9 | Graph index | Incremental + full-rebuild fallback |
| 10 | Vector store | sqlite-vec |
| 11 | Process model | Worker threads |
| 12 | Migration | Reorganize first, then build |
| 13 | SSE | Global stream + fire-and-forget |
| 14 | Auth | No auth by default; optional token |
| 15 | File upload | Multipart + chunked + drag-drop + folder |
| 16 | Client state | Zustand + convention |
| 17 | Error handling | ~10 codes + rich details |

---

## Success Criteria

The goal is achieved when **all** of the following are true:

### Server (`packages/server`)

- [ ] Runs as standalone Express process, deployable via `docker compose up`
- [ ] Every route validated by Zod schemas at runtime; malformed requests get 400 with structured details
- [ ] OpenAPI 3.1 spec auto-generated from Zod schemas; served at `/api/v1/docs`
- [ ] SQLite database holds metadata + graph index + vector embeddings (one file)
- [ ] `sqlite-vec` extension loaded; vector search uses indexed MATCH query
- [ ] Graph index updated incrementally on file change (ms latency); full rebuild on cold start
- [ ] Worker thread pool handles CPU-heavy tasks; main thread stays responsive for SSE/HTTP
- [ ] Server-driven ingest: client uploads file → server runs full pipeline → SSE progress
- [ ] Auth middleware: `AUTH_MODE=none` skips auth; `AUTH_MODE=token` validates Bearer
- [ ] File upload: multipart (≤10MB) + chunked (>10MB) with progress
- [ ] SSE global stream with heartbeat; fire-and-forget; smart reconnect via version check
- [ ] Error envelope: `{ error: { code, message, details } }` on every error response
- [ ] Serves static web client files from `/static` route
- [ ] Health check endpoint for container orchestration
- [ ] Legacy `/api/invoke/:command` routes still work (deprecated)

### Web Client (`packages/web`)

- [ ] Pure SPA (React + Vite), zero Tauri dependencies
- [ ] Typed API client (`src/api/client.ts`) is the only way UI talks to server
- [ ] Types imported from `@llm-wiki/api-types` (inferred from Zod schemas)
- [ ] Login screen: one input field ("API Token") + "Connect"; skipped in local mode
- [ ] Server URL configurable via `VITE_API_URL` env var
- [ ] Zustand stores follow convention: server stores call `api.*` + have `invalidate()`; UI stores never touch network
- [ ] SSE sync layer maps events → store invalidations (~100 lines)
- [ ] Drag-and-drop upload zone with folder support (`webkitdirectory`)
- [ ] Client picks multipart vs chunked by file size (threshold: 10MB)
- [ ] Upload progress bar (per-file or per-chunk)
- [ ] Every UI feature from the current desktop app works identically (see feature matrix below)
- [ ] Real-time sync: edits in one tab visible in another (via SSE)
- [ ] Build produces static files deployable to any CDN

### API Types (`packages/api-types`)

- [ ] Re-exports TypeScript types inferred from server Zod schemas
- [ ] Consumed by both web client and MCP server
- [ ] Published as npm package (or workspace reference)

### MCP Server (`mcp-server/`)

- [ ] Works against new Express server unchanged (just set `LLM_WIKI_API_BASE_URL`)
- [ ] All MCP tools functional via the REST API

### Cross-Cutting

- [ ] Monorepo with `packages/*` workspaces; root `npm install` + `npm run build:all` works
- [ ] Docker image builds and runs with single `docker compose up`
- [ ] One server serves multiple simultaneous web clients
- [ ] All clients see same data in real-time (SSE event bus)
- [ ] Each package has independent `package.json`, `tsconfig.json`
- [ ] CI pipeline: lint + typecheck + test on PR; Docker build on main
- [ ] Documentation: README, deployment guides, API reference, client config guide

### Feature Parity Matrix

Every row must be ✅ in the new architecture:

| # | Feature | Phase 0 (current) | Target (CS arch) |
|---|---|---|---|
| 1 | Create / open / switch projects | ✅ | ✅ |
| 2 | File tree, wiki editing, preview | ✅ | ✅ |
| 3 | Ingest — text formats | ✅ | ✅ |
| 4 | Ingest — binary formats (PDF/Office/EPUB/Org) | ✅ | ✅ |
| 5 | Ingest — legacy (.xls/.doc) | ✅ | ✅ |
| 6 | Multimodal image extraction + captions | ✅ | ✅ |
| 7 | Keyword search | ✅ | ✅ |
| 8 | Vector / semantic search (indexed) | ✅ | ✅ |
| 9 | Graph view (incremental index) | ✅ | ✅ |
| 10 | Graph-boosted search + agent graph.search | ✅ | ✅ |
| 11 | Page links / backlinks / missing | ✅ | ✅ |
| 12 | Web search (SearXNG/Tavily/SerpApi) | ✅ | ✅ |
| 13 | Source-folder auto-watch | ✅ | ✅ |
| 14 | Live cross-client sync (SSE) | ✅ | ✅ |
| 15 | File history / restore | ✅ | ✅ |
| 16 | Settings & recents persistence | ✅ | ✅ |
| 17 | Chat — direct streaming | ✅ | ✅ |
| 18 | Chat — agent mode (tool loop) | ✅ | ✅ |
| 19 | Chat — CLI backends (Claude/Codex) | ✅ | ✅ |
| 20 | Agent skills (scan + inject) | ✅ | ✅ |
| 21 | Agent shell.exec (with approval) | ⚠️ | ✅ |
| 22 | Deep Research (UI) | ✅ | ✅ |
| 23 | Deep Research (agent tool) | ✅ | ✅ |
| 24 | Archive export / import | ✅ | ✅ |
| 25 | Rebuild wiki index | ✅ | ✅ |
| 26 | OS open / reveal | ✅ | ✅ (via server) |
| 27 | Local HTTP API + MCP + agent skill | ✅ | ✅ |
| 28 | Chrome Web Clipper | ❌ | Deferred (desktop v2) |
| 29 | Autostart | ❌ | Deferred (desktop v2) |

**Target: 27/27 ✅ for v1** (rows 28-29 deferred to desktop v2; tracked in feature-gap matrix below).

---

## Desktop Feature-Gap Matrix (v2 tracking)

Features that exist in the current desktop app but are **not** in the v1 web-only architecture. Tracked here until the desktop thin shell (Phase 5) implements them.

| # | Feature | Desktop (current) | Web v1 | Desktop v2 (thin shell) |
|---|---|---|---|---|
| 1 | Chrome Web Clipper extension | ✅ (clip_server.rs) | ❌ | ✅ (native clipboard monitor → upload) |
| 2 | Autostart on login | ✅ (tauri-plugin-autostart) | ❌ | ✅ (Tauri autostart plugin) |
| 3 | System tray | ✅ (tray.rs) | ❌ | ✅ (Tauri tray API) |
| 4 | Native file drop (OS → app) | ✅ (Tauri drag-drop) | ⚠️ (browser drag-drop only) | ✅ (native → upload to server) |
| 5 | OS notifications | ✅ (Tauri notification) | ⚠️ (browser Notification API) | ✅ (native notifications) |
| 6 | Global hotkey | ✅ (Tauri global shortcut) | ❌ | ✅ (Tauri shortcut plugin) |
| 7 | Offline mode | ✅ (local Rust backend) | ❌ | ⚠️ (cached SPA + local queue) |

---

## Non-Goals (v1)

- Rewriting the React UI from scratch (reuse existing components)
- Multi-user / shared projects
- Collaborative real-time editing (CRDT/OT)
- Mobile client
- Hosted SaaS offering
- WebSocket (SSE sufficient)
- Dedicated vector DB (sqlite-vec scales to 100K+)

---

## Constraints

- **No Rust in the server**: all server logic is TypeScript/Node.js
- **No Tauri in the web client**: pure browser SPA
- **Backward compatibility**: legacy `/api/invoke/:command` routes remain during migration
- **Single-container deployment**: server + static web client in one Docker image
- **Open source**: MIT-licensed
- **Self-hosted**: no SaaS infrastructure in v1

---

## Timeline

| Phase | Target | Dependencies |
|---|---|---|
| Phase 0 (current monorepo) | ✅ Done | — |
| Phase 1 (reorganize) | 1-2 days | Phase 0 |
| Phase 2 (new server) | 2-3 weeks | Phase 1 |
| Phase 3 (new web client) | 2-3 weeks | Phase 2 (partial overlap) |
| Phase 4 (polish + Docker) | 1-2 weeks | Phases 2+3 |
| Phase 5 (desktop v2) | Future | Phase 4 |

**Total v1: ~6-8 weeks.**

---

## How to Track Progress

- Each phase has exit criteria in [PLAN.md](PLAN.md)
- The feature parity matrix above is ground truth — every row must flip to ✅
- The desktop feature-gap matrix tracks v2 work
- Integration tests per phase serve as automated verification
- [RUNBOOK.md](RUNBOOK.md) updated at each phase boundary

---

## Relationship to Current Work

The current monorepo (this repo) is **Phase 0** — it contains:
- A verified Node.js server (`packages/server/src/`, 28 JS files, 26/29 features green)
- A React SPA that works as web client via Vite aliases
- The original Tauri desktop app
- An MCP server that works against either backend
- 15 test harnesses in `/tmp/` (need to be moved to repo for persistence)
- An overnight scheduler (`scripts/overnight-schedule.sh`)

**Immediate next step**: Phase 1 (reorganize into workspace layout). This is a 1-2 day mechanical task that sets up the skeleton for everything else.
