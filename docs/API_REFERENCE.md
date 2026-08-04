# API Reference

The LLM Wiki server exposes a REST API under `/api/v2/*` (Express + Zod).

> **Full machine-readable spec:** `GET /api/v2/openapi.json` — an
> [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) document generated from
> the Zod schemas (the API's source of truth). Load it into Swagger UI,
> Postman, or `openapi-generator` for typed clients. This page is a quick
> human-readable index; the OpenAPI document is authoritative for request and
> response shapes.

Base URL: same origin as the web client, or `VITE_API_URL` for remote
deployments (see [CLIENT_CONFIG.md](./CLIENT_CONFIG.md)).

---

## Authentication

Every endpoint except the public ones requires the API token **when a token is
configured**. With no token configured the server is open (local mode).

Three equivalent ways to present the token:

| Method | Example |
|---|---|
| Bearer header (preferred) | `Authorization: Bearer <token>` |
| Custom header | `x-llm-wiki-token: <token>` |
| Query parameter | `GET /api/v2/projects?token=<token>` |

**Public endpoints** (never require a token): `GET /api/v2/health`,
`GET /api/v2/version`, `GET /api/v2/auth/status`, `POST /api/v2/auth/login`.

Unauthorized requests fail with `401`:

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required", "details": null } }
```

---

## Error envelope

All errors are normalized to a single envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "details": null
  }
}
```

`details` carries structured info when useful (e.g. Zod validation issues,
upstream provider info). Stable error codes and their HTTP statuses:

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request failed Zod validation (see `details` for field issues). |
| `UNAUTHORIZED` | 401 | Missing or invalid API token. |
| `FORBIDDEN` | 403 | Authenticated but not allowed (e.g. shell tools disabled). |
| `NOT_FOUND` | 404 | Resource (project, file, task…) does not exist. |
| `CONFLICT` | 409 | State conflict (e.g. duplicate project). |
| `FILE_TOO_LARGE` | 413 | Upload exceeds the size limit (server body limit is 64 MB). |
| `RATE_LIMITED` | 429 | Too many requests. |
| `INTERNAL_ERROR` | 500 | Unexpected server error (internals are never leaked). |
| `UPSTREAM_ERROR` | 502 | An upstream provider (LLM, search API) failed. |
| `WORKER_BUSY` | 503 | Worker pool saturated; retry later. |

---

## Endpoints by domain

`:id` is the numeric project id. Project-scoped routes are mounted under
`/api/v2/projects/:id/...`.

### Meta (public)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/health` | Liveness + version + registered command count. |
| GET | `/api/v2/version` | Server version, Node version, platform. |
| GET | `/api/v2/openapi.json` | OpenAPI 3.1 document for the whole API. |

### Auth

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/auth/status` | Public. `{ authRequired, authConfigured, allowUnauthenticated }` — used by the client to decide whether to show the login screen. |
| POST | `/api/v2/auth/login` | Public. Body `{ "token": "..." }` → `{ "success": true }` or `401 UNAUTHORIZED`. In open mode any token succeeds. |

### Projects

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/projects` | List all projects → `{ projects: [...] }`. |
| GET | `/api/v2/projects/:id` | Get one project → `{ project }`. `404` if unknown. |
| POST | `/api/v2/projects` | Create. Body `{ "name", "path" }` (server-side folder path) → `201 { project }`. |
| PATCH | `/api/v2/projects/:id` | Update fields (e.g. name) → `{ project }`. |
| DELETE | `/api/v2/projects/:id` | Delete → `204 No Content`. |

### Files (`/api/v2/projects/:id/files`)

| Method | Path | Description |
|---|---|---|
| GET | `/files/tree` | Directory tree. Query: `path`, `includeHidden`, `maxDepth`. |
| GET | `/files/content` | Read a file's text content. Query: `path`. |
| POST | `/files/upload` | Write a file. JSON body with path + base64 content. |
| GET | `/files/download` | Download a file as an attachment. Query: `path`. |
| GET | `/files/raw` | Stream a file with its native content type (for `<img>`/`<a>`). Query: `path`. |

### Search

| Method | Path | Description |
|---|---|---|
| POST | `/api/v2/projects/:id/search` | Hybrid search. Body `{ "query", "topK"? (1–100, default 20), "includeContent"? }` → `{ results: [{ path, score, snippet?, content? }], mode, tokenHits, vectorHits, graphHits }`. |

### Graph

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/projects/:id/graph` | Knowledge graph. Query: `q` (filter), `nodeType`, `limit` → `{ nodes: [{ id, label, nodeType, path, linkCount, weight }], edges: [{ source, target, weight }] }`. |

### Chat

| Method | Path | Description |
|---|---|---|
| POST | `/api/v2/projects/:id/chat` | Start a chat turn (streaming response). |
| POST | `/api/v2/projects/:id/chat/writes` | Chat "Write to Wiki" — generates and writes wiki pages from the conversation. Body `{ "sessionId", "userGuidance"?, "sourcePath"? }` → `{ runId, sessionId, writePrompt }`; streams `agent-event` frames (`messageDelta` / `wikiWrites` / `error` / `done`). |
| POST | `/api/v2/projects/:id/chat/:runId/cancel` | Cancel a running turn. |
| GET | `/api/v2/projects/:id/chat/sessions/:sessionId` | Get session state/history. |

### Ingest (`/api/v2/projects/:id/ingest`)

| Method | Path | Description |
|---|---|---|
| POST | `/ingest/upload` | Upload a document for ingestion — multipart form, field name `file`. |
| POST | `/ingest` | Enqueue an existing project file for (re-)ingest. Body `{ "filePath", "folderContext"? }`; deduped against live tasks (`deduplicated: true` on hit). |
| GET | `/ingest/queue` | List the ingest queue. Query: `status`, `limit`. |
| POST | `/ingest/queue/clear` | Clear queue entries. Body `{ "status"? }`. |
| GET | `/ingest/queue/:taskId` | Get one queued task. |
| POST | `/ingest/queue/:taskId/retry` | Re-arm a `failed` task (409 otherwise). |
| DELETE | `/ingest/queue/:taskId` | Cancel a task (aborts the run, cleans up written files + embeddings) or remove a queued one. |

### Reviews

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/projects/:id/reviews` | Review items. Query: `status` (`unresolved` default / `resolved`), `type`, `limit` → `{ projectId, status, count, reviews }`. |

### Maintenance (`/api/v2/projects/:id/maintenance`)

| Method | Path | Description |
|---|---|---|
| POST | `/maintenance/rebuild-index` | Rebuild the wiki index from existing pages. |
| POST | `/maintenance/export` | Export a project archive. Body `{ "destination" }`. |
| POST | `/maintenance/import` | Import an archive. Body `{ "archivePath", "destination" }`. |
| GET | `/maintenance/file-history` | File edit history. Query: `path`. |
| POST | `/maintenance/file-history/restore` | Restore a historical version. Body `{ "path", "entryId" }`. |

### Settings

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/settings` | Read all settings. |
| POST | `/api/v2/settings` | Write many settings at once (merge). |
| GET | `/api/v2/settings/:key` | Read one setting key. |
| PUT | `/api/v2/settings/:key` | Write one setting key. |
| DELETE | `/api/v2/settings/:key` | Delete one setting key. |

Settings keys mirror the shared store keys (`llmConfig`, `providerConfigs`,
`apiConfig`, `recentProjects`, `lastProject`, …). Writing `apiConfig.token`
sets the auth token; `apiConfig.allowUnauthenticated = true` re-opens the
server.

### Events (SSE)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/events` | Global server-sent-events stream. Each `message` carries a JSON envelope `{ event, payload }`. A `: ping` comment heartbeat is sent every 25 s to survive proxies. |
| GET | `/api/v2/events/count` | Diagnostic: number of connected SSE clients → `{ clients }`. |

---

## Legacy bridge (deprecated)

| Method | Path | Description |
|---|---|---|
| POST | `/api/invoke/:command` | Invokes a command from the desktop (Tauri) command registry. **Deprecated** (RFC 8594): responses carry `Deprecation: true` and a `Link` to `/api/v2/openapi.json`. Returns `{ ok, result }`. The web client uses this during migration; new integrations should use `/api/v2/*`. |

The legacy (v1) server entry (`packages/server/src/index.js`, `npm run server`)
additionally serves the endpoints the current web client depends on:

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Legacy health (command count, SSE clients, store diagnostics). |
| GET | `/api/commands` | Names of all registered commands. |
| GET | `/api/home` | Server home dir / cwd / platform (for the folder picker). |
| GET | `/api/events` | Legacy SSE stream (same bus as `/api/v2/events`). |
| GET | `/api/raw?path=` | Stream a server-side file by absolute path. |
| POST | `/api/invoke/:command` | Command dispatch (JSON args body). |
| GET/PUT/DELETE | `/api/store/:name[/:key]` | Read/write/delete plugin-store JSON. |
| POST | `/api/proxy` | Outbound HTTP proxy for provider calls. |
| * | `/api/v1/*` | Legacy v1 REST surface. |

---

## Examples

```bash
TOKEN="your-token"
BASE="http://127.0.0.1:19828"

# Health (no auth)
curl -s $BASE/api/v2/health

# List projects
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v2/projects

# Create a project (path is on the SERVER filesystem)
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Wiki","path":"/wikis/my-wiki"}' \
  $BASE/api/v2/projects

# Search
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"knowledge graph","topK":10}' \
  $BASE/api/v2/projects/1/search

# Token via query param (e.g. for EventSource, which cannot set headers)
curl -s "$BASE/api/v2/projects?token=$TOKEN"
```

SSE from the browser (query-param auth, since `EventSource` cannot set headers):

```js
const es = new EventSource(`/api/v2/events?token=${encodeURIComponent(token)}`)
es.onmessage = (e) => {
  const { event, payload } = JSON.parse(e.data)
  // handle broadcast event
}
```
