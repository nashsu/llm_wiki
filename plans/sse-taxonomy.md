# P1 — SSE full taxonomy + client sync layer (issue #14, §4.7)

**Charter promise (V1_CHARTERED_ARCHITECTURE.md §4.7 + §8):** a taxonomy of
events — `file:created/modified/deleted`, `ingest:*`, `chat:delta/toolStart/
toolEnd/done`, `graph:updated`, `settings:changed` — emitted at every mutation
site, driving Zustand store invalidation so multiple tabs/devices sync in real
time.

**Reality:** `events/bus.js` defines all constants; only `ingest:*` (landed
with P0, #28) and the chat `agent-event` wrapper are actually emitted.
`file:*`, `graph:updated`, `settings:changed`, `chat:*` are never published.
The client sync layer (`src/lib/sse-sync.ts`) is pre-wired for most of the
taxonomy but its chat handler double-applies tokens if the server starts
emitting `chat:*` (the active tab already consumes `agent-event`).

**Decision per #14:** implement the charter taxonomy verbatim — emit at
mutation sites, wire the client sync layer to invalidate the right stores.

## Transport decision — keep the proven path

The charter-shaped `events/sse.js` SSEManager is DEAD CODE (never mounted).
The live transport on both `GET /api/events` and `GET /api/v2/events` is the
legacy `emit()` bridge (`events.js`), which republishes onto the bus with
envelope `projectId: null`; attribution rides in `payload`. `ingest:*` works
exactly this way and the client reads `payload.projectId`. **All new taxonomy
events ride `emit()` the same way.** No transport swap in this gap.

Wire envelope (both streams): `data: {"event": "<name>", "payload": {...}}`.

## Emission policy (what emits, what deliberately does not)

### file:created / file:modified / file:deleted

Emitted (payload `{ projectId, path, size? }`; path project-relative when the
site knows the project, absolute otherwise; created-vs-modified decided by a
pre-write existence check):

| Site | Event | Notes |
|---|---|---|
| `api/files.js` POST /files/upload | created/modified | pre-write stat; `req.projectId` in scope |
| `api/ingest.js` POST /upload | created | timestamp+random name ⇒ always created |
| `api/chat.js` chat/writes FILE blocks | created/modified | ALREADY EMITS (370-375); migrate literals → EventTypes |
| `api/chat.js` post-write image injection | modified | `injectImagesIntoSourceSummary` rewrites `wiki/sources/<slug>.md` AFTER the emit loop today |
| `api/maintenance.js` rebuild-index | modified | emit once for `wiki/index.md` after the tmp-rename |
| `api/maintenance.js` file-history/restore | modified | |
| orchestrator cancel cleanup | deleted | per successful unlink; structural pages already skipped |
| legacy invoke fs writers (`commands/fs.js`) | created/modified/deleted | `writeFile`, `writeFileBase64`, `writeFileAtomic`, `applyTextSelectionEdit`, `createMissingWikiPage`, `deleteFile` (emit only on actual removal), `copyFile`/`copyDirectory`; NO project context — resolve via longest-prefix match against `projects.path` (may be null) |

**Deliberately NOT emitted:**
- Per-page events during the ingest pipeline (`ingest/write.js`,
  `wiki-upkeep.js`, `images.js` inside an ingest run) — subsumed by
  `ingest:complete` (which already refreshes the client tree and carries
  `pagesCreated`) + the aggregated `graph:updated` below. Emitting per page
  would storm the client with N tree refreshes per ingest.
- `.llm-wiki/*`, `.cache/*`, temp-rename files, export zips (outside any
  project), archive import (a whole new project tree — project-created, not
  file events), vector-store files.

### graph:updated

The charter's incremental graph tables (`graph_nodes/graph_edges`, migration
008) are unimplemented; the graph is rebuilt on demand from `wiki/*.md`
(`graph.js buildSnapshot`). `graph:updated` therefore means "wiki pages
changed ⇒ graph caches are stale". Payload `{ projectId, nodesChanged,
edgesChanged }` — `nodesChanged` = wiki pages touched; `edgesChanged` =
best-effort wikilink count (0 when unknown). The client ignores the payload
(bumps `dataVersion`); it exists for taxonomy fidelity.

| Site | nodesChanged |
|---|---|
| orchestrator `processTask` success aggregate | `writtenPaths.length` |
| orchestrator cancel cleanup | pages unlinked |
| maintenance rebuild-index | result page count |
| chat/writes completion | FILE blocks written |

### settings:changed

Payload `{ keys }` (informational — the client refetches settings on any
`settings:changed`). `projectId` null (settings are host-global). Emit
unconditionally at:

- `api/settings.js` POST /, PUT /:key, DELETE /:key (3 sites)
- `api/store.js` v2 shim PUT /:name, PUT /:name/:key, DELETE /:name/:key —
  ONLY when `name === SHARED_STORE_NAME` ("app-state.json")
- legacy `index.js` `/api/store` handler — same name gate (separate process;
  its own bus bridges the same way)

### chat:delta / chat:toolStart / chat:toolEnd / chat:done — dual emission

Keep `agent-event` untouched (the active tab's chat-panel consumes it with
runId filtering). ADDITIONALLY emit the taxonomy events at the same choke
points:

- `agent.js emitEvent` (messageDelta→chat:delta, toolStart→chat:toolStart,
  toolEnd→chat:toolEnd) — `runLoop` has `projectRow.id`; plumb it.
- `agent.js agentStartTurnStream` done → chat:done.
- `api/chat.js emitAgentEvent` for chat/writes: messageDelta→chat:delta,
  done→chat:done (numeric `req.projectId` already in closure).

Payloads (charter shape + runId for client scoping):
`chat:delta { sessionId, runId, projectId, text }` ·
`chat:toolStart { sessionId, runId, projectId, tool, input }` ·
`chat:toolEnd { sessionId, runId, projectId, tool, output }` ·
`chat:done { sessionId, runId, projectId, content, references }`
(done carries the full content so a tab that missed deltas can finalize).

`error`, `wikiWrites`, `referenceAdded`, `fileChanged` have NO charter
equivalent — they stay `agent-event`-only.

**Review-fix addendum (PR #29 round 1):** the `error` frames themselves stay
`agent-event`-only, but a non-owning tab previewing a run via `chat:delta`
has no `agent-event` consumer — if the run then FAILED or was CANCELLED, no
terminal `chat:*` frame existed and the tab stayed stuck in `isStreaming`
forever (all send paths locked). Both error sites (`agent.js
agentStartTurnStream` catch, `api/chat.js` chat/writes catch) therefore now
dual a TERMINAL `chat:done` alongside the untouched `error` + companion
textless `done` agent-events, mirroring the owning tab's catch-path outcome:
failed runs `content = "Error: <message>"` (writes: the `Error generating
wiki files: …` finalize text), cancelled runs `content = ""` (sse-sync
resets the stream without adding a message — owning-tab abort-like parity).
No new event names: the charter taxonomy stays verbatim.

## Client sync layer (src/lib/sse-sync.ts)

Already handled: `file:*` → refreshWiki; `ingest:*` → project-scoped stores;
`graph:updated` → bumpDataVersion; `settings:changed` → refetch. Changes:

1. **handleChat rewrite (the double-apply fix).** Today it appends
   unguarded into the one global stream buffer. New semantics:
   - Scope: apply only when `payload.sessionId` is a conversation in the
     chat-store (or the active one) — drops other-project/unknown frames.
   - Ownership guard: the chat-panel registers runs it starts locally in a
     chat-store `ownedRunIds` tombstone set (added when the panel begins a
     turn, cleared on conversation delete — never on finalize, to survive the
     done-frame race on the shared SSE stream). sse-sync skips any frame whose
     `runId` is owned locally. Accepted trade-off: ownedRunIds grows
     unbounded within a long-lived conversation — tombstones must survive the
     done-frame race and are only cleared on deleteConversation +
     resetProjectState, so growth is bounded by conversation lifetime, and
     the O(n) includes() check is acceptable at v1 turn counts. Cross-tab: a
     tab that did NOT start the run applies `chat:delta` →
     `appendStreamToken` (live preview) and `chat:done` →
     `finalizeStreamForConversation(sessionId, content, references)`.
   - Keys: read charter `text` (delta) / `content` (done), keeping today's
     `token/delta/content` fallbacks.
   - `chat:toolStart/toolEnd`: no store target today — explicit documented
     no-op case (taxonomy fidelity on the wire; the active tab shows tool
     steps via `agent-event`).
2. **File-refresh debounce.** Trailing debounce (~400 ms) on file-event-driven
   `refreshWiki` — chat/writes emits several `file:*` per save; tree refresh
   is idempotent but not free.

## Known accepted degradations

- **No server-side file watcher:** `commands/fileSync.js` watchers are not
  started under `index-v2.js`; out-of-band edits (user's other editor) are
  not observed server-side. Reconnect full-refresh (charter §8 smart
  reconnect, already implemented in sse-sync) covers it. P0 already documents
  the client-side watcher as the auto-ingest trigger.
- `graph_nodes/graph_edges` tables stay unwritten; `edgesChanged` is
  best-effort. Implementing the incremental graph index is a separate gap.
- Dead `events/sse.js` SSEManager stays unmounted (removal is churn with no
  user value); documented as dead code.
- Cross-tab chat sync shows live tokens but NOT tool-step UI (agent-event
  only, active tab).

## Stages (each independently testable)

1. **settings:changed** — api/settings.js + api/store.js shim + legacy
   index.js handler; bus-frame tests.
2. **file:\* v2 routes** — files upload (pre-stat), ingest upload,
   maintenance rebuild-index + restore, orchestrator cancel cleanup
   (deleted); migrate chat.js literals → EventTypes constants; tests.
3. **file:\* legacy invoke writers** — commands/fs.js writers + longest-prefix
   path→project resolver; chat-writes image-injection modified; tests.
4. **graph:updated** — orchestrator success/cancel aggregates, rebuild-index,
   chat/writes completion; tests.
5. **chat:\* dual emission** — agent.js + chat.js hooks, projectId plumbing,
   charter payloads; tests.
6. **Client sse-sync hardening** — handleChat rewrite + ownedRunIds guard +
   chat-store additions + file-refresh debounce; client vitest.
7. **Docs + validation fleet** — PUSH1_ACTUAL_ARCHITECTURE §3/§5/§6 +
   API_REFERENCE events section; fleet scenarios S1-S5 (below).

## Validation fleet (Playwright vs booted index-v2 + mock LLM)

- **S1 cross-tab file sync:** two SPA tabs; upload via API → tab B's file tree
  shows the new raw source WITHOUT reload; delete via cancel-cleanup → tree
  updates (file:created + file:deleted observed on tab B's SSE stream).
- **S2 settings sync:** change a setting (e.g. outputLanguage) via API → tab
  B's next settings read reflects it (settings:changed → cache warm); no
  reload.
- **S3 chat cross-tab streaming:** two tabs on the same session; start a turn
  in tab A → tab B renders streaming tokens via chat:delta and the final
  message via chat:done; tab A shows NO doubled tokens (ownership guard).
- **S4 ingest → graph bump:** run an ingest to completion; assert
  graph:updated frame with nodesChanged and that the client's dataVersion
  bumped (graph cache invalidated); ingest:complete still refreshes the tree.
- **S5 legacy-writer sync:** invoke `write_file` via the legacy bridge → the
  other tab's tree picks up the file (file:created with prefix-resolved
  project id).

**Gates per stage:** `npm test -w @llm-wiki/server`; stage 6+7 additionally
`npm run typecheck`, `npm run test:mocks`, `npm run build:web`.
