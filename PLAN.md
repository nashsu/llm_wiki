# LLM Wiki — Implementation Plan: Client-Server Architecture

> **Cross-references**: [architecture.md](architecture.md) (design) · [GOAL.md](GOAL.md) (goal definition) · [RUNBOOK.md](RUNBOOK.md) (current operational runbook)

---

## Overview

This plan transforms the current monorepo into a **proper client-server architecture** with Express + Zod + SQLite + sqlite-vec + worker threads, deployed as a single Docker container, serving any number of web clients. All 17 architecture decisions are reflected below.

**Current state** (Phase 0): 28 JS files in `packages/server/src/` mirror 26/29 desktop features, verified with 15 test harnesses. React SPA works as web client via Vite aliases.

**Target state** (Phase 4): Monorepo with `packages/server`, `packages/web`, `packages/api-types`, `packages/desktop` (placeholder). Server is Express + Zod + SQLite + sqlite-vec + workers. Web client is pure SPA with typed API client. Docker-ready.

---

## Phase 0 — Current Monorepo (✅ Complete)

The existing codebase proves the server can do everything the desktop does. See [RUNBOOK.md](RUNBOOK.md) feature matrix for the 26/29 verified rows.

**Remaining Phase 0 gaps** (close before Phase 1):
- [ ] Shell.exec approval verifier (code done, harness needs fix)
- [ ] HUFF/CDIC `.mobi` (documented limitation — acceptable)

---

## Phase 1 — Reorganize into Workspace Layout ✅

**Goal**: Move current code into `packages/*` structure. No logic changes — pure mechanical reorganization.

**Status**: Complete (2026-07-30). Server moved to `packages/server`, workspace scaffolding in place (`packages/api-types` placeholder, `tsconfig.base.json`, root workspaces). All gates pass. Web/desktop split deferred (desktop build unverifiable without Rust toolchain on this host).

### 1.1 Create workspace structure

| Task | Description |
|---|---|
| 1.1.1 | Create `packages/server/`, `packages/web/`, `packages/api-types/`, `packages/desktop/` directories |
| 1.1.2 | Add root `package.json` with `"workspaces": ["packages/*"]` |
| 1.1.3 | Add root `tsconfig.base.json` with shared compiler options |

### 1.2 Move server code

| Task | Description |
|---|---|
| 1.2.1 | `git mv packages/server/src/*` → `packages/server/src/` |
| 1.2.2 | `git mv server/package.json` → `packages/server/package.json` (update name to `@llm-wiki/server`) |
| 1.2.3 | Create `packages/server/tsconfig.json` extending root base |
| 1.2.4 | Fix all import paths in server files (relative paths stay same; package imports update) |

### 1.3 Move web client code

| Task | Description |
|---|---|
| 1.3.1 | `git mv src/components src/stores src/lib src/i18n src/types src/assets` → `packages/web/src/` |
| 1.3.2 | `git mv src/App.tsx src/main.tsx` → `packages/web/src/` |
| 1.3.3 | `git mv index.html` → `packages/web/index.html` |
| 1.3.4 | `git mv vite.web.config.ts` → `packages/web/vite.config.ts` (update paths) |
| 1.3.5 | Create `packages/web/package.json` (name `@llm-wiki/web`, deps: react, zustand, etc.) |
| 1.3.6 | Create `packages/web/tsconfig.json` |
| 1.3.7 | Delete `src/web/` (Tauri shims — replaced by API client in Phase 3) |
| 1.3.8 | Fix all import paths in web files (`@/` alias → `packages/web/src/`) |

### 1.4 Move desktop code (placeholder)

| Task | Description |
|---|---|
| 1.4.1 | `git mv src-tauri/` → `packages/desktop/src-tauri/` |
| 1.4.2 | `git mv vite.config.ts` → `packages/desktop/vite.config.ts` (the Tauri build config) |
| 1.4.3 | Create `packages/desktop/package.json` (name `@llm-wiki/desktop`) |
| 1.4.4 | No logic changes — desktop stays as-is, deferred per decision #6 |

### 1.5 Create api-types package

| Task | Description |
|---|---|
| 1.5.1 | Create `packages/api-types/package.json` (name `@llm-wiki/api-types`) |
| 1.5.2 | Create `packages/api-types/src/index.ts` (empty for now; populated in Phase 2) |
| 1.5.3 | Create `packages/api-types/tsconfig.json` |

### 1.6 Move MCP server

| Task | Description |
|---|---|
| 1.6.1 | `mcp-server/` stays at root level (it's already standalone) |
| 1.6.2 | Update its `package.json` to reference `@llm-wiki/api-types` as devDependency |

### 1.7 Update root scripts

| Task | Description |
|---|---|
| 1.7.1 | Root `package.json` scripts: `dev:server`, `dev:web`, `build:server`, `build:web`, `build:all`, `test:all` |
| 1.7.2 | Update overnight scheduler prompt with new paths (`packages/server/src/` etc.) |

### 1.8 Verify

| Task | Description |
|---|---|
| 1.8.1 | `npm install` at root resolves all workspaces |
| 1.8.2 | `npm run build:server` compiles server |
| 1.8.3 | `npm run build:web` builds SPA |
| 1.8.4 | `npm run dev:server` starts server on :3000 |
| 1.8.5 | `npm run dev:web` starts Vite dev server with proxy to :3000 |
| 1.8.6 | All 15 test harnesses pass against the reorganized server |
| 1.8.7 | Desktop build (`npm run tauri build` in `packages/desktop/`) still works |

**Phase 1 exit criteria**: Workspace layout functional; all existing tests pass; both dev servers start; desktop build works.

---

## Phase 2 — Build New Express + Zod + SQLite Server ✅

**Goal**: Replace the current raw-`node:http` server with Express + Zod + SQLite + sqlite-vec + worker threads. Incremental: one route group at a time, server always green.

**Status**: Complete (2026-07-30). All 12 route groups implemented (system, auth, projects, files, search, graph, chat, ingest, reviews, settings, events, maintenance). SQLite migrations 001-009 applied. Worker pool operational. OpenAPI 3.1 spec generated. Legacy `/api/invoke` bridge with deprecation headers. Integration test suite (29 tests) added as gate 9/9. All gates pass.

### 2.1 Foundation

| Task | Description |
|---|---|
| 2.1.1 | Install deps: `express`, `zod`, `@asteasolutions/zod-to-openapi`, `better-sqlite3`, `multer`, `cors`, `helmet` |
| 2.1.2 | Create `packages/server/src/index.ts` — Express app setup, middleware chain (cors, helmet, json parser, auth middleware placeholder) |
| 2.1.3 | Create `packages/server/src/middleware/validate.ts` — Zod validation middleware (validates body/params/query, returns 400 with Zod errors as `details`) |
| 2.1.4 | Create `packages/server/src/middleware/auth.ts` — Bearer token validation (skip if `AUTH_MODE=none`) |
| 2.1.5 | Create `packages/server/src/middleware/error.ts` — Global error handler (maps errors to `{ error: { code, message, details } }` envelope) |
| 2.1.6 | Create `packages/server/src/store/db.ts` — SQLite connection, WAL mode, `load_extension('sqlite-vec')`, run migrations |
| 2.1.7 | Create `packages/server/src/workers/pool.ts` — Worker thread pool (`os.cpus().length - 1` workers), `runInWorker(fn, args)` helper |
| 2.1.8 | Create `packages/server/src/events/bus.ts` — Internal EventEmitter pub/sub |
| 2.1.9 | Create `packages/server/src/events/sse.ts` — SSE connection manager (global stream, heartbeat, broadcast) |
| 2.1.10 | Create `packages/server/src/schemas/common.ts` — Shared Zod schemas (pagination, error envelope, health response) |

### 2.2 SQLite Migrations

| Task | Description |
|---|---|
| 2.2.1 | Migration 001: `users` table (id, username, passwordHash, createdAt) |
| 2.2.2 | Migration 002: `settings` table (userId, key, value JSON) |
| 2.2.3 | Migration 003: `projects` table (id, name, path, ownerId, createdAt, updatedAt) |
| 2.2.4 | Migration 004: `chat_sessions` table (id, projectId, title, createdAt, updatedAt) |
| 2.2.5 | Migration 005: `chat_messages` table (id, sessionId, role, content, references JSON, createdAt) |
| 2.2.6 | Migration 006: `reviews` table (id, projectId, type, title, description, status, ...) |
| 2.2.7 | Migration 007: `ingest_queue` table (id, projectId, filePath, status, progress, error, createdAt) |
| 2.2.8 | Migration 008: `graph_nodes` + `graph_edges` tables |
| 2.2.9 | Migration 009: `vec_chunks` virtual table (sqlite-vec) |

### 2.3 Route Groups (one at a time, each ends green)

Each sub-phase: create Zod schemas → create Express router → wire into app → write integration test → verify green.

| Sub-phase | Routes | Schemas | Core modules reused |
|---|---|---|---|
| 2.3.1 | System: `GET /health`, `GET /version` | `common.ts` | None |
| 2.3.2 | Auth: `POST /auth/login` | `auth.ts` | `auth/` |
| 2.3.3 | Projects: CRUD | `project.ts` | `core/fs.ts`, `store/projects.ts` |
| 2.3.4 | Files: tree, content, upload, download, raw | `file.ts` | `core/fs.ts` |
| 2.3.5 | Search: hybrid search | `search.ts` | `core/search.ts`, `core/vectorstore.ts` |
| 2.3.6 | Graph: nodes + edges | `graph.ts` | `core/graph.ts` |
| 2.3.7 | Chat: SSE streaming + cancel + sessions | `chat.ts` | `core/agent.ts`, `core/llm.ts` |
| 2.3.8 | Ingest: upload + queue + progress | `ingest.ts` | `core/ingest.ts`, `core/preprocess.ts` |
| 2.3.9 | Reviews + Lint | `review.ts` | `store/reviews.ts` |
| 2.3.10 | Settings | `settings.ts` | `store/settings.ts` |
| 2.3.11 | Events: SSE global stream | None | `events/sse.ts` |
| 2.3.12 | Maintenance: rebuild-index, reindex-vectors, file-history, export/import | `maintenance.ts` | `core/maintenance.ts` |

### 2.4 Worker Thread Tasks

| Task | Description |
|---|---|
| 2.4.1 | `workers/preprocess.worker.ts` — PDF/Office/EPUB parsing (moved from `core/preprocess.ts`) |
| 2.4.2 | `workers/embed.worker.ts` — Batch embedding computation |
| 2.4.3 | `workers/graph-rebuild.worker.ts` — Full graph rebuild (walk all files, bulk insert) |
| 2.4.4 | Wire workers into ingest pipeline (server-driven: upload → queue → worker → SSE progress) |

### 2.5 OpenAPI Generation

| Task | Description |
|---|---|
| 2.5.1 | Create `packages/server/src/openapi.ts` — collect all Zod schemas, generate OpenAPI 3.1 spec |
| 2.5.2 | Serve spec at `GET /api/v1/openapi.json` |
| 2.5.3 | Serve Swagger UI at `GET /api/v1/docs` (via `swagger-ui-express`) |
| 2.5.4 | Export inferred types to `packages/api-types/src/index.ts` |

### 2.6 Legacy Compatibility

| Task | Description |
|---|---|
| 2.6.1 | Keep `/api/invoke/:command` as deprecated compatibility layer (proxies to new routes internally) |
| 2.6.2 | Keep `/api/v1/*` routes from current `api-v1.js` as aliases during transition |
| 2.6.3 | Add deprecation headers to legacy routes |

### 2.7 Verification

| Task | Description |
|---|---|
| 2.7.1 | Integration test suite for every route group (supertest + Zod validation) |
| 2.7.2 | Auth flow tests (no-auth mode, token mode, invalid token, missing token) |
| 2.7.3 | File upload tests (multipart small, chunked large, drag-drop simulation) |
| 2.7.4 | SSE multi-client test (two connections, mutation → both receive event) |
| 2.7.5 | Worker thread crash recovery test |
| 2.7.6 | Graph incremental update test (add file → edge appears; delete file → edge removed) |
| 2.7.7 | sqlite-vec search test (insert embeddings → MATCH query returns ranked results) |
| 2.7.8 | OpenAPI spec validates against all route schemas |
| 2.7.9 | All 15 existing harnesses pass against new server |

**Phase 2 exit criteria**: New Express server passes all integration tests; OpenAPI spec generated; workers functional; sqlite-vec indexed search works; graph incremental updates work; legacy routes still work.

---

## Phase 3 — Build New Web Client

**Goal**: Replace Tauri shims with typed API client; add login screen; add SSE sync layer; add drag-and-drop upload.

### 3.1 API Client Layer

| Task | Description |
|---|---|
| 3.1.1 | Create `packages/web/src/api/client.ts` — fetch wrapper with auth header injection, base URL config, error parsing |
| 3.1.2 | Create `packages/web/src/api/projects.ts` — typed project CRUD |
| 3.1.3 | Create `packages/web/src/api/files.ts` — typed file tree, content, upload (multipart + chunked), download |
| 3.1.4 | Create `packages/web/src/api/search.ts` — typed search + graph |
| 3.1.5 | Create `packages/web/src/api/chat.ts` — SSE consumer for chat streaming |
| 3.1.6 | Create `packages/web/src/api/ingest.ts` — typed ingest upload + queue |
| 3.1.7 | Create `packages/web/src/api/settings.ts` — typed settings CRUD |
| 3.1.8 | Create `packages/web/src/api/events.ts` — global SSE connection + sync layer |
| 3.1.9 | Import types from `@llm-wiki/api-types` |

### 3.2 Replace invoke() Calls

| Task | Description |
|---|---|
| 3.2.1 | Replace all `invoke(...)` in stores with `api.*` calls |
| 3.2.2 | Replace `@tauri-apps/plugin-store` usage with `api.settings.*` |
| 3.2.3 | Replace `@tauri-apps/plugin-dialog` with `<input type="file">` + `api.files.upload()` |
| 3.2.4 | Replace `@tauri-apps/plugin-opener` with `window.open()` + `api.files.raw()` |
| 3.2.5 | Replace `@tauri-apps/plugin-http` with native `fetch` (CORS handled by same-origin or proxy) |
| 3.2.6 | Delete `src/web/` directory (Tauri shims no longer needed) |

### 3.3 Login & Connection

| Task | Description |
|---|---|
| 3.3.1 | Create login screen component (one input: "API Token" + "Connect" button) |
| 3.3.2 | Auto-detect: same-origin + `authRequired: false` → skip login |
| 3.3.3 | Token storage in `localStorage` |
| 3.3.4 | Server URL config via `VITE_API_URL` env var (for remote deployments) |
| 3.3.5 | SSE reconnect with version check |

### 3.4 Drag-and-Drop Upload

| Task | Description |
|---|---|
| 3.4.1 | Drop zone component in sources view |
| 3.4.2 | `webkitdirectory` support for folder drops |
| 3.4.3 | Client-side file size check → multipart (≤10MB) or chunked (>10MB) |
| 3.4.4 | Upload progress bar (per-file for multipart, per-chunk for chunked) |
| 3.4.5 | SSE-driven ingest progress display |

### 3.5 Zustand Convention Enforcement

| Task | Description |
|---|---|
| 3.5.1 | Audit all stores: split into server-data stores (with `invalidate()`) and UI stores (no network) |
| 3.5.2 | Wire SSE sync layer to call `invalidate()` on relevant stores |
| 3.5.3 | Ensure no store calls `fetch()` directly — only `api.*` functions |

### 3.6 Verification

| Task | Description |
|---|---|
| 3.6.1 | E2E: login → create project → drag-drop upload → ingest → search → chat → graph |
| 3.6.2 | E2E: two browser tabs, edit in one → live update in other (SSE sync) |
| 3.6.3 | E2E: remote mode (different origin) → login → full feature set |
| 3.6.4 | E2E: local mode (same origin, no auth) → zero-friction UX |
| 3.6.5 | Build produces static files deployable to CDN |
| 3.6.6 | All existing component tests pass |

**Phase 3 exit criteria**: Web client works against new server in both local and remote modes; no Tauri dependencies; login flow works; drag-drop upload works; SSE sync works; all features functional.

---

## Phase 4 — Polish & Deployment

### 4.1 Docker

| Task | Description |
|---|---|
| 4.1.1 | Multi-stage Dockerfile (builder + runtime) |
| 4.1.2 | `docker-compose.yml` with volume mount |
| 4.1.3 | Health check endpoint for container orchestration |
| 4.1.4 | Bundle `sqlite-vec.so` in image |
| 4.1.5 | Serve static web client from Express (`/static` route) |

### 4.2 Documentation

| Task | Description |
|---|---|
| 4.2.1 | README with quick-start (`docker compose up`) |
| 4.2.2 | Deployment guides (VPS, Fly.io, Railway, home server) |
| 4.2.3 | API reference (auto-generated from OpenAPI spec) |
| 4.2.4 | Client configuration guide (env vars, login, remote mode) |
| 4.2.5 | MCP server configuration guide |

### 4.3 CI/CD

| Task | Description |
|---|---|
| 4.3.1 | GitHub Actions: lint + typecheck + test on PR |
| 4.3.2 | GitHub Actions: build Docker image on main |
| 4.3.3 | GitHub Actions: publish `@llm-wiki/api-types` to npm |
| 4.3.4 | Release tagging + changelog |

### 4.4 Performance

| Task | Description |
|---|---|
| 4.4.1 | Response caching (ETag, conditional GET for file content) |
| 4.4.2 | SSE connection limits + idle timeout |
| 4.4.3 | Worker pool sizing based on available memory |
| 4.4.4 | SQLite VACUUM + WAL checkpoint on startup |

**Phase 4 exit criteria**: `docker compose up` starts everything; web client accessible at `localhost:3000`; all features work; docs complete; CI green.

---

## Phase 5 — Desktop Thin Shell (v2, deferred)

Tracked via feature-gap matrix in [GOAL.md](GOAL.md). Not started until Phases 1-4 are complete and stable.

---

## Dependency Graph

```
Phase 0 (done)
    │
    ▼
Phase 1 (reorganize)  ── 1-2 days
    │
    ▼
Phase 2 (new server)  ── 2-3 weeks
    │
    ▼
Phase 3 (new web client)  ── 2-3 weeks
    │
    ▼
Phase 4 (polish + Docker)  ── 1-2 weeks
    │
    ▼
Phase 5 (desktop v2)  ── future
```

Phases 2 and 3 have some overlap: once Phase 2's first route groups are done, Phase 3 can start building the API client against them.

---

## Effort Estimates

| Phase | Estimated effort | Critical path |
|---|---|---|
| Phase 0 | ✅ Done | — |
| Phase 1 | 1-2 days | Mechanical reorganization |
| Phase 2 | 2-3 weeks | SQLite migrations + route groups + workers |
| Phase 3 | 2-3 weeks | API client + replace invoke() + login + upload |
| Phase 4 | 1-2 weeks | Docker + docs + CI |
| **Total** | **6-8 weeks** | |

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| sqlite-vec native lib incompatible with platform | High | Fallback to manual cosine in SQLite (same schema, no extension) |
| Worker thread + SQLite write contention | Medium | All SQLite writes from main thread; workers return data only |
| Express middleware chain breaks SSE streaming | Medium | SSE route bypasses json parser middleware; test early |
| Zod schema drift from actual handler behavior | Low | Integration tests validate both schema and handler |
| Large file chunked upload through reverse proxy | Medium | Document proxy config; test with nginx + traefik |
| SSE connections exhaust file descriptors | Medium | Connection limits + heartbeat + idle timeout |
| Overnight scheduler breaks after reorganization | Low | Update prompt paths in Phase 1; test scheduler against new layout |
