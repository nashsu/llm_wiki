# LLM Wiki — V1 Chartered Architecture (Design)

> **This is the original chartered architecture for V1** — the design spec and
> decision record that the client-server migration was built against. It
> describes the *intended* system. For what was actually delivered, see
> [docs/PUSH1_ACTUAL_ARCHITECTURE.md](docs/PUSH1_ACTUAL_ARCHITECTURE.md) (the
> as-built architecture after PR #1); the open deltas between this charter and
> the implementation are tracked in issue #14.
>
> **Cross-references**: [PLAN.md](PLAN.md) (implementation plan) · [GOAL.md](GOAL.md) (goal definition) · [RUNBOOK.md](RUNBOOK.md) (current operational runbook)

---

## 1. Vision

```
                    ┌─────────────────┐
                    │   LLM Wiki      │
                    │   Server        │
                    │   (anywhere)    │
                    │                 │
                    │  • Projects     │
                    │  • Wiki data    │
                    │  • LLM calls   │
                    │  • Agent runtime│
                    │  • Search       │
                    │  • Auth         │
                    └───────┬─────────┘
                            │ HTTPS / REST + SSE
              ┌─────────────┼─────────────┐
              │             │             │
     ┌────────▼───┐  ┌─────▼──────┐  ┌──▼──────────┐
     │ Desktop    │  │ Web        │  │ MCP / AI    │
     │ Client     │  │ Client     │  │ Agent       │
     │ (deferred  │  │ (SPA in    │  │ (Claude     │
     │  to v2)    │  │  browser)  │  │  Code etc.) │
     └────────────┘  └────────────┘  └─────────────┘
```

**One server, N clients.** The server is the single source of truth for all user data. Clients are thin UI shells that render state and send intents. Any number of web clients (and, in v2, desktop clients) can connect simultaneously to the same server, seeing the same data in real-time.

---

## 2. Decision Record

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Deployment model | Self-hosted only | Personal KB; no SaaS infra needed; auth stays simple |
| 2 | Repo structure | Monorepo with workspaces | Shared React code trivial; overnight scheduler simple; split later if needed |
| 3 | HTTP framework | Express | Largest ecosystem; simplest; bottleneck is LLM latency not framework |
| 4 | Web client connection | Both (local + remote); simple login | Auto-detect same-origin → skip auth; remote → one-field token input |
| 5 | Storage backend | Hybrid: files + SQLite | Wiki pages = files (Obsidian/git); metadata + graph + vectors = SQLite |
| 6 | Desktop client v1 | Deferred | Track via feature-gap matrix; web-only for v1 |
| 7 | Ingest pipeline | Server-driven | Tab-close resilience; LLM keys server-side; client just uploads + watches SSE |
| 8 | API contract source | Zod-first | Schemas → inferred types + runtime validation + auto OpenAPI; zero drift |
| 9 | Graph index | Incremental + full-rebuild fallback | Graph is hot path; per-file update = ms latency; cold start = full rebuild |
| 10 | Vector store | sqlite-vec | Same SQLite file; indexed search; no separate process |
| 11 | Process model | Worker threads | Main thread = HTTP/SSE/SQLite; workers = CPU-heavy parsing/embedding/graph |
| 12 | Migration strategy | Reorganize first, then build | Workspace layout is skeleton; everything slots in; no double-move |
| 13 | SSE model | Global stream + fire-and-forget | Simple; smart reconnect (version check) handles hiccups |
| 14 | Auth model | No auth by default; optional token | Zero friction locally; one-field token for remote |
| 15 | File upload | Multipart (≤10MB) + chunked (>10MB) + drag-drop + folder | Covers all cases; client picks path by file size |
| 16 | Client state | Zustand + convention | Server stores call `api.*` + `invalidate()`; UI stores never touch network |
| 17 | Error handling | ~10 codes + rich `details` | Zod errors + LLM metadata pass through; client switches on code for UI |

---

## 3. Monorepo Layout (target)

```
llm_wiki/
├── packages/
│   ├── server/               # Express + Zod + SQLite + workers
│   │   ├── src/
│   │   │   ├── index.ts      # Express app entry
│   │   │   ├── auth/         # Token middleware (optional)
│   │   │   ├── api/          # REST route handlers (Express routers)
│   │   │   ├── schemas/      # Zod schemas (source of truth)
│   │   │   ├── core/         # Business logic (search, ingest, agent, graph, etc.)
│   │   │   ├── store/        # SQLite access layer
│   │   │   ├── workers/      # Worker thread pool + task definitions
│   │   │   └── events/       # SSE connection manager + internal pub/sub
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── web/                  # React SPA (pure client)
│   │   ├── src/
│   │   │   ├── api/          # Typed API client (fetch wrapper)
│   │   │   ├── components/   # React components (from current src/components/)
│   │   │   ├── stores/       # Zustand stores (convention: server vs UI)
│   │   │   ├── lib/          # Pure client logic (graph rendering, markdown, etc.)
│   │   │   └── App.tsx
│   │   ├── vite.config.ts
│   │   └── package.json
│   ├── desktop/              # Tauri thin shell (deferred to v2)
│   │   └── (placeholder)
│   └── api-types/            # Zod schemas → inferred TS types → OpenAPI
│       ├── src/
│       │   └── index.ts      # Re-exports inferred types from server schemas
│       └── package.json
├── mcp-server/               # Unchanged; points at server via LLM_WIKI_API_BASE_URL
├── package.json              # Workspace root
├── pnpm-workspace.yaml       # (or npm workspaces in root package.json)
└── tsconfig.base.json
```

---

## 4. Server Architecture

### 4.1 Technology Stack

| Layer | Technology |
|---|---|
| HTTP server | Express 5 |
| Request validation | Zod (per-route schemas) |
| OpenAPI generation | `@asteasolutions/zod-to-openapi` |
| Database | SQLite via `better-sqlite3` (or `node:sqlite` on Node 22+) |
| Vector search | `sqlite-vec` extension |
| Worker threads | `node:worker_threads` pool |
| File upload | `multer` (multipart) + custom chunked endpoints |
| SSE | Express response streaming |
| Auth | Bearer token middleware (optional, env-gated) |

### 4.2 Internal Module Map

```
packages/server/src/
├── index.ts                  # Express app setup, middleware chain, listen
├── auth/
│   ├── middleware.ts         # Bearer token validation (skip if AUTH_MODE=none)
│   └── config.ts             # Read LLM_WIKI_AUTH_MODE, LLM_WIKI_API_TOKEN
├── api/
│   ├── router.ts             # Mount all sub-routers
│   ├── system.ts             # GET /health, /version
│   ├── auth.ts               # POST /auth/login (when auth enabled)
│   ├── projects.ts           # CRUD /projects
│   ├── files.ts              # /projects/:id/files (tree, content, upload, download, raw)
│   ├── search.ts             # POST /projects/:id/search
│   ├── graph.ts              # GET /projects/:id/graph
│   ├── chat.ts               # POST /projects/:id/chat (SSE stream)
│   ├── agent.ts              # /projects/:id/agent/* (cancel, sessions)
│   ├── ingest.ts             # POST /projects/:id/ingest (upload + queue)
│   ├── reviews.ts            # /projects/:id/reviews
│   ├── settings.ts           # /settings (per-user)
│   ├── events.ts             # GET /events (SSE global stream)
│   └── maintenance.ts        # rebuild-index, reindex-vectors, file-history
├── schemas/
│   ├── project.ts            # Zod schemas for project endpoints
│   ├── file.ts               # Zod schemas for file endpoints
│   ├── search.ts             # Zod schemas for search
│   ├── chat.ts               # Zod schemas for chat
│   ├── ingest.ts             # Zod schemas for ingest
│   ├── settings.ts           # Zod schemas for settings
│   └── common.ts             # Shared schemas (pagination, error envelope)
├── core/
│   ├── fs.ts                 # Filesystem operations (sandboxed to data dir)
│   ├── ingest.ts             # Server-driven ingest pipeline orchestrator
│   ├── preprocess.ts         # PDF/Office/EPUB text extraction
│   ├── search.ts             # Keyword + vector + graph hybrid search
│   ├── graph.ts              # Incremental graph index (SQLite)
│   ├── vectorstore.ts        # sqlite-vec wrapper
│   ├── agent.ts              # Agent runtime (tool loop, streaming)
│   ├── agent-tools.ts        # Tool executors
│   ├── skills.ts             # SKILL.md scanning
│   ├── llm.ts                # LLM provider adapters (OpenAI, Anthropic, etc.)
│   ├── llm-resolve.ts        # Config resolution (presets, routing)
│   ├── file-sync.ts          # Source-folder watcher + snapshot
│   ├── file-history.ts       # Version history
│   ├── maintenance.ts        # Archive export/import, index rebuild
│   ├── extract-images.ts     # Embedded image extraction
│   └── cli.ts                # Claude/Codex CLI subprocess management
├── store/
│   ├── db.ts                 # SQLite connection + migrations + sqlite-vec load
│   ├── projects.ts           # Project registry (SQLite)
│   ├── settings.ts           # Per-user settings (SQLite)
│   ├── chat-sessions.ts      # Chat session metadata (SQLite)
│   ├── reviews.ts            # Review items (SQLite)
│   ├── ingest-queue.ts       # Ingest task queue (SQLite)
│   └── graph-index.ts        # Graph nodes + edges tables (SQLite)
├── workers/
│   ├── pool.ts               # Worker thread pool manager
│   ├── preprocess.worker.ts  # PDF/Office parsing (CPU-heavy)
│   ├── embed.worker.ts       # Embedding computation (CPU-heavy)
│   └── graph-rebuild.worker.ts  # Full graph rebuild (CPU-heavy)
└── events/
    ├── bus.ts                # Internal pub/sub (EventEmitter)
    └── sse.ts                # SSE connection manager + heartbeat
```

### 4.3 Data Layout

```
/data/                              # LLM_WIKI_DATA_DIR (Docker volume)
├── server.db                       # SQLite: metadata + graph + vectors
├── server.db-wal                   # SQLite WAL journal
├── server.db-shm                   # SQLite shared memory
└── projects/
    └── <project-id>/
        ├── wiki/                   # Markdown files (Obsidian-compatible)
        │   ├── index.md
        │   ├── overview.md
        │   ├── concepts/
        │   ├── entities/
        │   ├── sources/
        │   └── ...
        ├── raw/
        │   ├── sources/            # Uploaded source documents
        │   └── assets/             # Extracted images, media
        ├── .llm-wiki/
        │   ├── project.json        # Project identity (id, createdAt)
        │   ├── file-snapshot.json  # Source-folder watcher state
        │   └── history/            # File version history (per-file JSON)
        ├── schema.md
        └── purpose.md
```

**What lives in SQLite (`server.db`):**

| Table | Purpose |
|---|---|
| `users` | User accounts (single-user v1; multi-user v2) |
| `settings` | Per-user settings (LLM config, provider keys, preferences) |
| `projects` | Project registry (id, name, path, owner, createdAt) |
| `chat_sessions` | Chat session metadata (id, projectId, title, updatedAt) |
| `chat_messages` | Chat message history (sessionId, role, content, references) |
| `reviews` | Review items (id, projectId, type, title, status, ...) |
| `ingest_queue` | Ingest task queue (id, projectId, filePath, status, progress) |
| `graph_nodes` | Graph node index (id, projectId, path, title, type, linkCount) |
| `graph_edges` | Graph edge index (sourceId, targetId, weight) |
| `vec_chunks` | Vector embeddings (sqlite-vec virtual table) |

**What stays as files:**

- All wiki pages (`wiki/**/*.md`) — Obsidian/git/rsync compatible
- All source documents (`raw/sources/*`) — original uploads preserved
- Extracted images (`raw/assets/*`, `wiki/media/*`) — served via `/files/raw`
- File version history (`.llm-wiki/history/*.json`) — append-only, debuggable
- Source-folder snapshot (`.llm-wiki/file-snapshot.json`) — shared with desktop

### 4.4 Worker Thread Model

```
Main Thread (I/O-bound)          Worker Pool (CPU-bound, N = cpus - 1)
┌──────────────────────┐         ┌─────────────────────────────┐
│ Express HTTP/SSE     │         │ Worker 1: preprocess PDF    │
│ SQLite reads/writes  │◄───────►│ Worker 2: extract images    │
│ SSE event broadcast  │ postMsg │ Worker 3: compute embeddings│
│ Graph incremental    │         │ Worker 4: full graph rebuild│
│   update (fast path) │         │ ...                         │
└──────────────────────┘         └─────────────────────────────┘
```

- Main thread handles all HTTP, SSE, SQLite I/O, and incremental graph updates (single-file changes are fast enough for the main thread)
- Worker pool handles: PDF/Office parsing, image extraction/re-encoding, batch embedding computation, full graph rebuilds
- Workers post results back via `postMessage`; main thread writes to SQLite
- `sqlite-vec` connections stay on main thread (SQLite doesn't support concurrent writes from multiple threads)
- If a worker crashes, the pool spawns a replacement; main thread reports error via SSE

### 4.5 Auth Model

```
LLM_WIKI_AUTH_MODE=none    →  No auth middleware; all requests pass through
LLM_WIKI_AUTH_MODE=token   →  Bearer token required on all routes except /health, /version
```

- **Local mode** (default): server binds to `localhost`, no auth, zero friction
- **Remote mode**: user sets `LLM_WIKI_AUTH_MODE=token` + `LLM_WIKI_API_TOKEN=<secret>` in env
- Web client detects auth requirement via `GET /health` → `{ authRequired: true }`
- Login screen: one input field ("API Token") + "Connect" button; token stored in `localStorage`
- MCP server: uses `LLM_WIKI_API_TOKEN` env var as Bearer token (unchanged)

### 4.6 Error Model

**HTTP status codes** (proper semantics):

| Status | Meaning |
|---|---|
| 400 | Zod validation failed |
| 401 | Missing or invalid token |
| 403 | Valid token but not authorized |
| 404 | Resource not found |
| 409 | Conflict (file modified since read) |
| 413 | File too large |
| 429 | Rate limited |
| 500 | Unexpected server error |
| 502 | Upstream LLM provider error |
| 503 | Worker pool exhausted |

**Error body** (consistent envelope):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "details": { ... }
  }
}
```

**Error codes** (~10 stable strings):

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Zod schema violation; `details` = Zod error array |
| `UNAUTHORIZED` | 401 | Missing/invalid token |
| `FORBIDDEN` | 403 | Token valid but insufficient permissions |
| `NOT_FOUND` | 404 | Project/file/session doesn't exist |
| `CONFLICT` | 409 | File modified since last read |
| `FILE_TOO_LARGE` | 413 | Upload exceeds size limit |
| `RATE_LIMITED` | 429 | Too many requests; `details.retryAfter` |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `UPSTREAM_ERROR` | 502 | LLM provider error; `details.provider`, `details.status` |
| `WORKER_BUSY` | 503 | All workers occupied |

### 4.7 SSE Event Model

- **One global stream** per client: `GET /api/v1/events`
- **Fire-and-forget**: server doesn't buffer events; on reconnect, client checks `GET /health` → `{ serverVersion }`; if changed, full refresh; if same, resume
- **Heartbeat**: `: ping\n\n` every 25s to keep connections alive through proxies
- **Event envelope**: `data: {"type":"<eventType>","projectId":"...","payload":{...}}\n\n`

**Event types:**

| Type | Trigger | Payload |
|---|---|---|
| `file:created` | File watcher / upload | `{ path, size }` |
| `file:modified` | File watcher / save | `{ path, size }` |
| `file:deleted` | File watcher / delete | `{ path }` |
| `ingest:progress` | Ingest pipeline | `{ taskId, status, progress }` |
| `ingest:complete` | Ingest pipeline | `{ taskId, pagesCreated }` |
| `ingest:error` | Ingest pipeline | `{ taskId, error }` |
| `chat:delta` | Agent streaming | `{ sessionId, text }` |
| `chat:toolStart` | Agent tool call | `{ sessionId, tool, input }` |
| `chat:toolEnd` | Agent tool result | `{ sessionId, tool, output }` |
| `chat:done` | Agent turn complete | `{ sessionId, references }` |
| `graph:updated` | Incremental graph update | `{ projectId, nodesChanged, edgesChanged }` |
| `settings:changed` | Settings update | `{ keys }` |

### 4.8 File Upload Protocol

**Small files (≤ 10MB):**
```
POST /api/v1/projects/:id/files/upload
Content-Type: multipart/form-data
Body: file=<binary>, destPath=raw/sources/paper.pdf
```

**Large files (> 10MB):**
```
POST /api/v1/projects/:id/files/upload/init
Body: { fileName, fileSize, destPath }
→ { uploadId }

PUT /api/v1/projects/:id/files/upload/:uploadId/chunk?offset=0
Content-Type: application/octet-stream
Body: <5MB chunk>
→ { received: 5242880 }

... repeat ...

POST /api/v1/projects/:id/files/upload/:uploadId/complete
→ { path: "raw/sources/paper.pdf", size: 52428800 }
```

**Drag-and-drop + folder upload**: client uses `webkitdirectory` attribute + `DataTransfer.items` for folder drops; each file uploaded individually via the appropriate path (multipart or chunked).

### 4.9 Deployment

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json pnpm-workspace.yaml ./
COPY packages/server/package*.json packages/server/
COPY packages/web/package*.json packages/web/
COPY packages/api-types/package*.json packages/api-types/
RUN npm ci --workspace=packages/server --workspace=packages/web --workspace=packages/api-types
COPY . .
RUN npm run build --workspace=packages/web
RUN npm run build --workspace=packages/server

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/packages/server/dist ./server
COPY --from=builder /app/packages/server/node_modules ./node_modules
COPY --from=builder /app/packages/web/dist ./static
COPY --from=builder /app/sqlite-vec.so /usr/lib/sqlite-vec.so
EXPOSE 3000
ENV LLM_WIKI_DATA_DIR=/data
ENV LLM_WIKI_STATIC_DIR=/app/static
VOLUME /data
CMD ["node", "server/index.js"]
```

```yaml
# docker-compose.yml
services:
  llm-wiki:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - wiki-data:/data
    environment:
      - LLM_WIKI_PORT=3000
      - LLM_WIKI_AUTH_MODE=${AUTH_MODE:-none}
      - LLM_WIKI_API_TOKEN=${API_TOKEN:-}
volumes:
  wiki-data:
```

---

## 5. Web Client Architecture

### 5.1 Technology Stack

| Layer | Technology |
|---|---|
| Framework | React 19 + TypeScript |
| Build | Vite |
| State | Zustand (convention: server stores vs UI stores) |
| API client | Typed fetch wrapper (`src/api/client.ts`) |
| SSE | Native `EventSource` with auto-reconnect |
| Styling | Tailwind CSS 4 |
| Editor | Milkdown (rich) + CodeMirror (raw) |
| Graph viz | Sigma.js + graphology |
| i18n | i18next |

### 5.2 Connection Model

```typescript
// src/api/client.ts
const apiBase = import.meta.env.VITE_API_URL || ''  // empty = same origin

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = localStorage.getItem('llm-wiki-token')
  const headers = { 'Content-Type': 'application/json', ...opts?.headers }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${apiBase}/api/v1${path}`, { ...opts, headers })

  if (res.status === 401 && !apiBase) {
    // Same-origin but auth required → shouldn't happen in local mode
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }
  if (!res.ok) {
    const body = await res.json()
    throw new ApiError(body.error.code, body.error.message, body.error.details)
  }
  return res.json()
}
```

**Auto-detection logic:**
- If `VITE_API_URL` is set → remote mode → show login screen on first load
- If `VITE_API_URL` is empty → same-origin → check `/health`:
  - `authRequired: false` → skip login, use relative URLs
  - `authRequired: true` → show token input

### 5.3 Zustand Convention

```typescript
// Server-data store example
const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  loading: false,

  // Actions call api.* and set state
  fetchProjects: async () => {
    set({ loading: true })
    try {
      const projects = await api.projects.list()
      set({ projects, loading: false })
    } catch (err) {
      set({ loading: false })
      throw err
    }
  },

  // SSE invalidation
  invalidate: () => { get().fetchProjects() },
}))

// UI store example (never touches network)
const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  activeTab: 'wiki',
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}))
```

**SSE sync layer** (~100 lines):
```typescript
// src/api/events.ts
const eventSource = new EventSource(`${apiBase}/api/v1/events`)
eventSource.onmessage = (e) => {
  const { type, projectId } = JSON.parse(e.data)
  switch (type) {
    case 'file:created':
    case 'file:modified':
    case 'file:deleted':
      useProjectStore.getState().invalidate()
      useFileStore.getState().invalidate(projectId)
      break
    case 'graph:updated':
      useGraphStore.getState().invalidate(projectId)
      break
    case 'settings:changed':
      useSettingsStore.getState().invalidate()
      break
    // ... etc
  }
}
```

---

## 6. API Contract (Zod-first)

### 6.1 Schema → Types → OpenAPI Pipeline

```
packages/server/src/schemas/project.ts
  ↓ (Zod schema)
  ↓ z.infer<typeof CreateProjectSchema>  →  TypeScript type
  ↓ @asteasolutions/zod-to-openapi       →  OpenAPI 3.1 spec
  ↓
packages/api-types/src/index.ts          →  Re-exports inferred types
  ↓
packages/web/src/api/projects.ts         →  Typed API calls
```

### 6.2 Example Route with Zod

```typescript
// packages/server/src/schemas/project.ts
import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200).openapi({ example: 'My Research' }),
  template: z.enum(['blank', 'academic', 'business']).optional(),
}).openapi('CreateProject')

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  path: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).openapi('Project')

export type CreateProject = z.infer<typeof CreateProjectSchema>
export type Project = z.infer<typeof ProjectSchema>
```

```typescript
// packages/server/src/api/projects.ts
import { Router } from 'express'
import { CreateProjectSchema } from '../schemas/project.js'
import { validate } from '../middleware/validate.js'

const router = Router()

router.post('/', validate({ body: CreateProjectSchema }), async (req, res) => {
  // req.body is typed as CreateProject, already validated
  const project = await projectStore.create(req.body)
  res.status(201).json(project)
})
```

---

## 7. MCP Server / AI Agent Skill

Unchanged — standalone process that talks to the server via `LLM_WIKI_API_BASE_URL`. The `api-client.ts` in `mcp-server/` already defines the REST consumer contract. In the new architecture it points at the Express server's `/api/v1/*` routes.

---

## 8. Real-time Sync

```
Client A (tab 1)  ──┐
Client B (tab 2)  ──┼──▶  Express Server  ──▶  SSE /api/v1/events
Client C (tab 3)  ──┤         │
MCP Agent         ──┘         │
                              ▼
                     Internal Event Bus (EventEmitter)
                              │
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
         File changed    Ingest done    Graph updated
```

- Every mutation emits to internal bus → SSE manager broadcasts to all connections
- Clients update Zustand stores via the SSE sync layer
- Fire-and-forget: no server-side event buffer
- Smart reconnect: client stores `lastServerVersion`; on reconnect checks `/health`; if version changed → full refresh; if same → resume

---

## 9. Graph Index (Incremental)

### SQLite Schema

```sql
CREATE TABLE graph_nodes (
  id TEXT PRIMARY KEY,          -- project-relative path (e.g. "wiki/concepts/foo.md")
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  link_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE graph_edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (source_id, target_id),
  FOREIGN KEY (source_id) REFERENCES graph_nodes(id),
  FOREIGN KEY (target_id) REFERENCES graph_nodes(id)
);

CREATE INDEX idx_graph_edges_target ON graph_edges(target_id);
CREATE INDEX idx_graph_nodes_project ON graph_nodes(project_id);
```

### Incremental Update (per file change)

```typescript
async function updateGraphForFile(projectId: string, relPath: string, content: string | null) {
  const db = getDb()
  const nodeId = relPath

  if (content === null) {
    // File deleted
    db.prepare('DELETE FROM graph_edges WHERE source_id = ? OR target_id = ?').run(nodeId, nodeId)
    db.prepare('DELETE FROM graph_nodes WHERE id = ?').run(nodeId)
    // Update link_count on affected neighbors
    db.prepare('UPDATE graph_nodes SET link_count = (SELECT COUNT(*) FROM graph_edges WHERE source_id = id OR target_id = id) WHERE id IN (SELECT target_id FROM graph_edges WHERE source_id = ? UNION SELECT source_id FROM graph_edges WHERE target_id = ?)').run(nodeId, nodeId)
    return
  }

  // Extract wikilinks from content
  const links = extractWikilinks(content)
  const title = extractTitle(content, path.basename(relPath))
  const type = extractFrontmatterType(content)

  // Upsert node
  db.prepare('INSERT OR REPLACE INTO graph_nodes (id, project_id, title, type, updated_at) VALUES (?, ?, ?, ?, ?)').run(nodeId, projectId, title, type, Date.now())

  // Delete old edges from this node
  const oldTargets = db.prepare('SELECT target_id FROM graph_edges WHERE source_id = ?').all(nodeId)
  db.prepare('DELETE FROM graph_edges WHERE source_id = ?').run(nodeId)

  // Insert new edges
  for (const link of links) {
    const targetId = resolveLinkToNodeId(link, projectId)
    if (targetId && targetId !== nodeId) {
      db.prepare('INSERT OR IGNORE INTO graph_edges (source_id, target_id) VALUES (?, ?)').run(nodeId, targetId)
    }
  }

  // Update link_count on this node + all affected neighbors
  const affectedIds = [...new Set([...links.map(l => resolveLinkToNodeId(l, projectId)).filter(Boolean), ...oldTargets.map(r => r.target_id), nodeId])]
  for (const id of affectedIds) {
    db.prepare('UPDATE graph_nodes SET link_count = (SELECT COUNT(*) FROM graph_edges WHERE source_id = ? OR target_id = ?) WHERE id = ?').run(id, id, id)
  }

  // Emit SSE event
  eventBus.emit('graph:updated', { projectId, nodesChanged: 1, edgesChanged: links.length })
}
```

### Full Rebuild (cold start / corruption)

Dispatched to a worker thread. Walks all wiki files, extracts links, bulk-inserts into `graph_nodes` + `graph_edges` in a single transaction.

---

## 10. Vector Store (sqlite-vec)

```sql
-- Load extension at startup
SELECT load_extension('/usr/lib/sqlite-vec');

-- Virtual table for chunk embeddings
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  project_id TEXT,
  page_id TEXT,
  chunk_index INTEGER,
  chunk_text TEXT,
  heading_path TEXT,
  embedding FLOAT[768]   -- dimension matches embedding model
);
```

**Search query:**
```sql
SELECT chunk_id, page_id, chunk_text, heading_path, distance
FROM vec_chunks
WHERE embedding MATCH ? AND project_id = ?
ORDER BY distance
LIMIT ?
```

---

## 11. Migration Path

See [PLAN.md](PLAN.md) for detailed tasks per phase.

| Phase | Description | Status |
|---|---|---|
| 0 | Current monorepo with verified server (26/29 features) | ✅ Complete |
| 1 | Reorganize into workspace layout (`packages/*`) | 🔲 Next |
| 2 | Build new Express + Zod + SQLite server | 🔲 Planned |
| 3 | Build new web client (API client + SSE sync) | 🔲 Planned |
| 4 | Polish: Docker, OpenAPI docs, deployment guides | 🔲 Planned |
| 5 | Desktop thin shell (v2) | 🔲 Future |

---

## 12. Deferred / Non-Goals (v1)

- Desktop thin-shell rewrite (tracked via feature-gap matrix)
- Multi-user / shared projects
- Offline mode / service worker caching
- WebSocket (SSE sufficient)
- Dedicated vector DB (sqlite-vec scales to 100K+)
- CRDT/OT collaborative editing (last-write-wins + file history)
- Mobile client
- Hosted SaaS offering
