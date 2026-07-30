# LLM Wiki — Handoff Document

**Date**: 2026-07-30 07:15 CST  
**Session**: claude-qwen-3.8-max  
**Status**: Phase 1 + Phase 2 complete, Phase 3 + Phase 4 pending

---

## What Was Accomplished

### Phase 1 — Workspace Reorganization ✅

Moved the monorepo into a proper workspace structure:
- `server/` → `packages/server/` (backend)
- `packages/api-types/` (Zod schemas + inferred types)
- `packages/web/` (placeholder for Phase 3)
- `packages/desktop/` (placeholder for Phase 5)
- Root `package.json` with `"workspaces": ["packages/*"]`
- `tsconfig.base.json` for shared compiler options

All existing gates (0-7) passed after reorganization.

### Phase 2 — Express + Zod + SQLite Server ✅

Built a complete v2 API server in `packages/server/src/`:

**Foundation (2.1)**:
- `index-v2.js` — Express app with middleware chain (cors, helmet, json, auth)
- `middleware/validate.js` — Zod validation middleware
- `middleware/auth.js` — Bearer token auth (decision #14: no auth by default)
- `middleware/error.js` — Global error handler (normalizes to `{ error: { code, message, details } }`)
- `store/db.js` — SQLite connection with WAL mode
- `workers/pool.js` — Worker thread pool (os.cpus().length - 1 workers)
- `events/bus.js` — Internal EventEmitter pub/sub
- `events/sse.js` — SSE connection manager (25s heartbeat)
- `schemas/common.js` — Shared schemas (error envelope, pagination, health)

**Migrations (2.2)**:
- 001_users, 002_settings, 003_projects, 004_chat_sessions, 005_chat_messages
- 006_reviews, 007_ingest_queue, 008_graph_nodes_edges, 009_vec_chunks
- All applied on first boot via `store/db.js`

**Route Groups (2.3)** — all 12 implemented:
- System: `GET /api/v2/health`, `GET /api/v2/version`
- Auth: `GET /api/v2/auth/status`, `POST /api/v2/auth/login`
- Projects: CRUD at `/api/v2/projects`
- Files: tree, content, upload, download, raw at `/api/v2/projects/:id/files`
- Search: hybrid search at `/api/v2/projects/:id/search`
- Graph: nodes + edges at `/api/v2/projects/:id/graph`
- Chat: SSE streaming at `/api/v2/projects/:id/chat`
- Ingest: multipart upload + queue at `/api/v2/projects/:id/ingest`
- Reviews: list at `/api/v2/projects/:id/reviews`
- Settings: CRUD at `/api/v2/settings`
- Events: SSE global stream at `/api/v2/events`
- Maintenance: rebuild-index, file-history at `/api/v2/projects/:id/maintenance`

**OpenAPI (2.5)**:
- `openapi.js` generates OpenAPI 3.1 spec from Zod schemas
- Served at `GET /api/v2/openapi.json`

**Legacy Compatibility (2.6)**:
- `/api/invoke/:command` bridge with deprecation headers (RFC 8594)
- Existing frontend continues to work during migration

**Integration Tests (2.7)**:
- `test/api-v2.test.js` — 29 tests covering all route groups
- Runs via `npm test` in `packages/server/`
- Added as gate 9/9 in `/tmp/gates.sh`

**All 9 gates pass**:
0. build:web
1. node --check
2. tsc --build
3. shell-approval (39/39)
4. agent (17/17)
5. filesync-shared (8/8)
6. browser-boot (5/5)
7. browser-e2e (13/13)
8. (reserved)
9. v2-api-tests (29/29)

---

## Current State

**Server**: Two implementations coexist:
- `packages/server/src/index.js` — legacy raw-`node:http` server (still used by existing frontend)
- `packages/server/src/index-v2.js` — new Express + Zod server (ready for Phase 3)

**Database**: SQLite at `~/.llm-wiki-server/server.db` with 9 migrations applied.

**Worker Pool**: Operational, tested with echo/fail tasks.

**SSE**: Two transports:
- Legacy `/api/events` (used by existing frontend)
- New `/api/v2/events` (backed by internal event bus)
- Legacy `emit()` bridges to internal bus so both client generations see the same events.

**Tests**: 
- Existing harnesses in `/tmp/verify-*.mjs` (gates 3-7)
- New integration suite in `packages/server/test/api-v2.test.js` (gate 9)

---

## What Remains

### Phase 3 — Web Client (2-3 weeks)

Build a pure SPA in `packages/web/` that talks to the v2 API:

1. **API Client Layer** (`packages/web/src/api/`):
   - `client.ts` — fetch wrapper with auth header injection
   - `projects.ts`, `files.ts`, `search.ts`, `chat.ts`, `ingest.ts`, `settings.ts`, `events.ts`
   - Import types from `@llm-wiki/api-types`

2. **Replace Tauri Shims**:
   - Replace all `invoke(...)` calls with `api.*` calls
   - Replace `@tauri-apps/plugin-store` with `api.settings.*`
   - Replace `@tauri-apps/plugin-dialog` with `<input type="file">` + `api.files.upload()`
   - Delete `src/web/` directory

3. **Login & Connection**:
   - Login screen (one input: "API Token" + "Connect" button)
   - Auto-detect: same-origin + `authRequired: false` → skip login
   - Token storage in `localStorage`
   - Server URL config via `VITE_API_URL` env var

4. **Drag-and-Drop Upload**:
   - Drop zone in sources view
   - `webkitdirectory` support for folder drops
   - Client-side file size check → multipart (≤10MB) or chunked (>10MB)
   - Upload progress bar
   - SSE-driven ingest progress display

5. **Zustand Convention**:
   - Audit all stores: split into server-data stores (with `invalidate()`) and UI stores (no network)
   - Wire SSE sync layer to call `invalidate()` on relevant stores

6. **Verification**:
   - E2E: login → create project → drag-drop upload → ingest → search → chat → graph
   - E2E: two browser tabs, edit in one → live update in other (SSE sync)
   - E2E: remote mode (different origin) → login → full feature set
   - E2E: local mode (same origin, no auth) → zero-friction UX

### Phase 4 — Polish & Deployment (1-2 weeks)

1. **Docker**:
   - Multi-stage Dockerfile (builder + runtime)
   - `docker-compose.yml` with volume mount
   - Bundle `sqlite-vec.so` in image
   - Serve static web client from Express (`/static` route)

2. **Documentation**:
   - README with quick-start (`docker compose up`)
   - Deployment guides (VPS, Fly.io, Railway, home server)
   - API reference (auto-generated from OpenAPI spec)
   - Client configuration guide (env vars, login, remote mode)
   - MCP server configuration guide

3. **CI/CD**:
   - GitHub Actions: lint + typecheck + test on PR
   - GitHub Actions: build Docker image on main
   - GitHub Actions: publish `@llm-wiki/api-types` to npm

4. **Performance**:
   - Response caching (ETag, conditional GET for file content)
   - SSE connection limits + idle timeout
   - Worker pool sizing based on available memory
   - SQLite VACUUM + WAL checkpoint on startup

---

## Key Technical Decisions

1. **JavaScript over TypeScript for v2 server**: The existing server is all `.js` (30 files). Writing the v2 server in JS keeps it consistent and avoids a build step. Zod still delivers runtime validation + OpenAPI generation (decision #8).

2. **Parallel implementation**: `index-v2.js` runs alongside `index.js` so the existing frontend continues to work during migration. Phase 3 will switch the web client to v2, then `index.js` can be deprecated.

3. **Legacy bridge with deprecation headers**: `/api/invoke/:command` is flagged deprecated (RFC 8594) with a `Link` to `/api/v2/openapi.json`. This signals the migration path without breaking existing clients.

4. **Internal event bus**: `events/bus.js` decouples event producers from SSE transport. Legacy `emit()` bridges to the bus so both client generations see the same events.

5. **Worker pool with slot management**: Workers are bound to fixed slots. Crashed workers are respawned in their slot (pool never grows). In-flight tasks on a crashed worker are failed immediately.

6. **Auth model (decision #14)**: No auth by default. When a token is configured (env or shared store), it becomes required unless `allowUnauthenticated: true`. Login endpoint validates the token.

7. **Ingest foundation**: Multipart upload writes to `raw/sources/` and enqueues a task. The full processing pipeline (preprocess → LLM → wiki pages) is deferred to Phase 2.4 (worker tasks) or Phase 3 (client-driven).

---

## Gotchas & Known Issues

1. **Stale servers**: If you see "Cannot GET /api/v2/..." errors, check for stale `node src/index-v2.js` processes holding port 19828. Kill them with `pkill -f "node src/index-v2.js"`.

2. **Store lock timeout**: If you see "store lock timeout" errors, another process is holding the lock on `~/.llm-wiki-server/stores/app-state.json.lock`. Kill the stale process or wait for the lock to expire (5s).

3. **Module cache in tests**: The v2 integration test sets `LLM_WIKI_DATA_DIR` before importing the app. If you add more test files, they must do the same (env vars are read at module load).

4. **Zod setup order**: `zod-setup.js` must be imported first in any file that creates schemas. It extends `z` with `.openapi()` before schemas are built.

5. **Worker pool termination**: The pool logs "Worker N exited with code 1" during `terminate()`. This is expected (workers are force-killed). The pool suppresses this noise in normal operation.

6. **Chat schema**: `message` requires `.min(1)` to reject empty messages. Without it, the schema accepts `""` and the agent runtime fails downstream.

---

## How to Continue

1. **Start the v2 server**:
   ```bash
   cd packages/server
   npm run start:v2
   # or
   npm run dev:v2  # with --watch
   ```

2. **Run the integration tests**:
   ```bash
   cd packages/server
   npm test
   ```

3. **Run all gates**:
   ```bash
   bash /tmp/gates.sh
   ```

4. **Check the OpenAPI spec**:
   ```bash
   curl http://localhost:19828/api/v2/openapi.json | jq .
   ```

5. **Test a route manually**:
   ```bash
   # Create a project
   curl -X POST http://localhost:19828/api/v2/projects \
     -H "Content-Type: application/json" \
     -d '{"name":"Test","path":"/tmp/test-project"}'
   
   # List projects
   curl http://localhost:19828/api/v2/projects
   ```

6. **Phase 3 starting point**:
   - Create `packages/web/src/api/client.ts` (fetch wrapper)
   - Create `packages/web/src/api/projects.ts` (typed CRUD)
   - Replace one `invoke()` call in the existing frontend with `api.projects.list()`
   - Verify it works, then continue replacing the rest

---

## Files Modified/Created

**Phase 1**:
- Moved `server/` → `packages/server/`
- Created `packages/api-types/`, `packages/web/`, `packages/desktop/` (placeholders)
- Updated root `package.json` with workspaces
- Created `tsconfig.base.json`

**Phase 2**:
- `packages/server/src/index-v2.js` (new Express app)
- `packages/server/src/middleware/{validate,auth,error}.js`
- `packages/server/src/store/{db,projects,project-paths,ingest-queue}.js`
- `packages/server/src/workers/{pool,worker,tasks}.js`
- `packages/server/src/events/{bus,sse}.js`
- `packages/server/src/schemas/{common,projects,files,search,graph,chat,ingest,reviews,settings,auth,maintenance}.js`
- `packages/server/src/api/{projects,files,search,graph,chat,ingest,reviews,settings,auth,maintenance,events}.js`
- `packages/server/src/openapi.js`
- `packages/server/src/errors.js`
- `packages/server/src/auth/config.js`
- `packages/server/test/{helpers,api-v2.test}.js`
- `packages/server/vitest.config.js`
- Updated `packages/server/package.json` (added deps + test script)
- Updated `packages/server/src/events.js` (bridge to internal bus)
- Updated `packages/server/src/store.js` (mkdir in withLock)

**Docs**:
- Updated `PLAN.md` (marked Phase 1 + Phase 2 complete)
- Updated `RUNBOOK.md`, `GOAL.md` (path references)
- Updated `scripts/overnight-schedule.sh` (path references)
- Updated `/tmp/gates.sh` (added gate 9/9)

---

## Verification

All gates pass:
```
════ 0/9 build dist-web ════
build:web OK

════ 1/9 node --check ════
node --check OK

════ 2/9 tsc --build ════
tsc OK

════ 3/9 shell.exec approval harness ════
SHELL_APPROVAL_RESULT 39/39 passed
shell-approval OK

════ 4/9 agent loop regression harness ════
AGENT_RESULT 17/17 passed
agent OK

════ 5/9 shared-data / file-sync harness ════
FILESYNC_SHARED_RESULT 8/8 passed
filesync-shared OK

════ 6/9 headless browser boot ════
BROWSER_BOOT_RESULT 5/5 passed
browser-boot OK

════ 7/9 headless browser end-to-end ════
BROWSER_E2E_RESULT 13/13 passed
browser-e2e OK

════ 9/9 v2 API integration tests ════
v2-api-tests OK

GATES_OK
```

---

## Next Steps

1. **Phase 3.1**: Build the API client layer in `packages/web/src/api/`
2. **Phase 3.2**: Replace `invoke()` calls one by one, verifying each works
3. **Phase 3.3**: Add login screen + connection logic
4. **Phase 3.4**: Add drag-and-drop upload
5. **Phase 3.5**: Enforce Zustand convention (server stores vs UI stores)
6. **Phase 3.6**: E2E verification

Once Phase 3 is complete, the web client will be a pure SPA with no Tauri dependencies, talking exclusively to the v2 API.

---

**End of handoff**.
