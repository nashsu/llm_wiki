# P0 — Server-driven ingest (issue #14, Decision 7)

**Charter promise (V1_CHARTERED_ARCHITECTURE.md Decision 7):** "Server-driven.
Tab-close resilience; LLM keys server-side; client just uploads + watches SSE."

**Cutover is total:** the browser pipeline (`src/lib/ingest.ts`, ~3,400 lines)
is ported to the Node server (plain JS) and **deleted**. The client becomes
upload + SSE-watch only. No dual-mode fallback flag.

## Architecture

```
POST /api/v2/projects/:id/ingest/upload ─┐
POST /api/v2/projects/:id/ingest ────────┤→ ingest_queue (SQLite, migration 007+013)
file-sync watcher (sourceWatchConfig) ───┘            │
                                                      ▼
                              orchestrator (main Express process)
                              • global cap LLM_WIKI_INGEST_CONCURRENCY (default 2)
                              • FIFO claim, ONE processing row per project
                              • retry cap 3, usage-limit backoff +15min
                              • boot: processing→pending (attempt>=3→failed)
                                                      │
                     CPU-bound ── worker pool ──────┤   (ingest:preprocess, ingest:extractImages)
                     LLM/embed HTTP ── main async ──┤   (resolveIngestConfig from shared store)
                     SQLite writes ── main only ────┘   (queue rows, vec_chunks)
                                                      ▼
                              wiki/*.md + index/log + review.json
                              + vec0 chunks (vector_upsert_chunks)
                              + SSE ingest:queued/progress/complete/error
```

## Data model — ingest_queue extended (migration 013)

Add: `attempt_count INTEGER NOT NULL DEFAULT 0`, `started_at`, `updated_at`,
`not_before INTEGER NOT NULL DEFAULT 0`, `folder_context TEXT NOT NULL DEFAULT ''`.

Status vocabulary stays `pending|processing|completed|failed`. DB is the single
source of truth; in-memory state (AbortControllers, active count) is runtime-only.

- **claim** (atomic tx): oldest `pending` id with `not_before<=now` whose project
  has no `processing` row → `processing`, attempt_count+=1. Enforces FIFO +
  per-project ordering + global cap (cap checked before claiming).
- **retryable failure** → `pending` (+ `not_before` for usage-limit);
  **attempt_count>=3** → `failed` with error surfaced.
- **manual retry** → `pending`, attempt_count=0, error=NULL.
- **cancel** → abort + delete written files + vector_delete_page + row delete.
- **crash recovery (boot)**: `processing`→`pending` keeping attempt_count;
  rows at attempt_count>=3 → `failed` ("server restarted during processing").
- **dedupe**: enqueue-by-path returns existing taskId for same project+file_path
  in pending/processing. Uploads always create new rows (timestamp+random suffix).

Per-project disk state stays in `.llm-wiki/` (desktop compatibility):
ingest-cache.json, ingest-progress/*.json, ingest-warnings.log,
image-caption-cache.json, review.json, page-history/.

## Config — shared store, no migration

Everything already lands in `app-state.json` (web Settings → `/api/store`
key-level writes; desktop plugin-store). One `readStore(SHARED_STORE_NAME)`
snapshot per task (settings edits take effect next task, like agent.js):

- `llmConfig` + `providerConfigs` + `taskModelRouting.ingestPresetId` +
  `customLlmPresets` + `projectLlmOverride` → **new `resolveIngestConfig(store)`**
  in llm-resolve.js (finally consumes `ingestPresetId`, persisted but unused today).
- `embeddingConfig` → ingest/embed.js · `multimodalConfig` → captioning ·
  `mineruConfig` → MinerU · `outputLanguage` → language guards + prompts.
- claude-code/codex-cli providers: fail fast at claim ("requires the desktop CLI").

## SSE contract (legacy frame format, both /api/events + /api/v2/events)

`data: {"event":"<name>","payload":{...}}` via existing `emit()`; payload always
carries `projectId`. taskId (SQLite rowid) is the single correlation key.

| event | payload |
|---|---|
| `ingest:queued` | `{projectId, taskId, filePath, fileName}` (unchanged) |
| `ingest:progress` | `{projectId, taskId, status:"processing", progress:0-100, stage, detail, attempt}` |
| `ingest:complete` | `{projectId, taskId, status:"completed", progress:100, pagesCreated[], reviewCount, warnings[], durationMs}` |
| `ingest:error` | `{projectId, taskId, status:"pending"\|"failed", error, retryable, attempt, maxAttempts, retryAt}` |

Wiring `events/sse.js` SSEManager is task #21 — P0 uses `emit()` only.

## Server module layout (packages/server/src/ingest/)

| module | ported from |
|---|---|
| `parse.js` | parseFileBlocks, isSafeIngestPath (ingest.ts:338-554, regexes byte-identical) |
| `prompts.js` | build*Prompt + all token-budget constants + compute*MaxTokens/Budget |
| `sanitize.js` | ingest-sanitize.ts |
| `sources-merge.js` | sources-merge.ts (union-not-last-wins) |
| `page-merge.js` | page-merge.ts (MergeFn seam + page-history backup) |
| `cache.js` | ingest-cache.ts (node:crypto SHA-256, same JSON shape) |
| `chunking.js` | splitSourceIntoSemanticChunks + hashTextHex (FNV-1a bit-exact — checkpoint compat) + LongSourceCheckpoint v1 |
| `identity.js` / `frontmatter.js` / `language.js` / `wiki-schema.js` / `wiki-filename.js` / `wiki-page-types.js` | same-name client libs |
| `llm.js` | streamText wrapper over llm-call.js (timeout backstop, usage-limit classification) |
| `embed.js` | embedding.ts embedPage (chunk + embeddingFetch from search.js + vector_upsert_chunks) |
| `images.js` | extract-source-images.ts orchestration over commands/extractImages.js + caption pipeline + paired-marker injection |
| `mineru.js` | mineru.ts (plain fetch) |
| `write.js` | writeFileBlocks per-block pipeline + deterministic index/log + truncation repair + fallback summary |
| `reviews.js` | parseReviewBlocks → .llm-wiki/review.json (stable-id fold, matching review-store) |
| `pipeline.js` | runIngestPipeline — autoIngestImpl stage order preserved exactly |
| `progress.js` | stage→percent map, touchIngestTask + ingest:progress |
| `orchestrator.js` | queue consumer: boot recovery, dispatch loop, cap, retries, cancel |

Pipeline order (client ingest.ts:640-1379, preserved exactly): read source →
MinerU → context reads → **cache check before any LLM spend** → image extraction
→ **caption before inject** → budget/long-source chunked analysis w/ checkpoint
resume → Step 1 analysis (temp 0.1, max_tokens 4096) → Step 2 generation →
conditional review stage → writeFileBlocks → **truncation repair** → deterministic
index/log → fallback source summary → image injection (multimodal-gated) →
parseReviewBlocks → **saveIngestCache only when hardFailures==0** → embedPage loop.

## API surface changes (api/ingest.js)

- `POST /upload` — filename gets crypto-random suffix (same-ms collision fix);
  kicks orchestrator.
- `POST /` — enqueue existing file by path (re-ingest button, clip-watcher,
  scheduled-import, chat Save-to-Wiki); dedupes pending/processing.
- `POST /queue/:taskId/retry` · `DELETE /queue/:taskId` (cancel w/ cleanup).
- `POST /chat-writes` — server port of executeIngestWrites (chat "Write to Wiki").
- `commands/fileSync.js` — watcher auto-ingest when
  `sourceWatchConfig.enabled && autoIngest` (replaces client project-file-sync).

## Client cutover (Stage 9)

- **DELETE** `src/lib/ingest.ts`, `src/lib/ingest-queue.ts` + their tests.
- New `src/stores/server-ingest-store.ts` fed by sse-sync (add the missing
  projectId filter at sse-sync.ts:55-69) + DropZone's 2s queue poll fallback.
- SourcesView mounts DropZone + Import buttons enqueue-by-path; activity-panel
  reads server queue; all triggers (source-lifecycle, clip-watcher,
  scheduled-import, chat-message) → REST.
- `package.json`: `start:web` must run `index-v2.js` (legacy index.js has no
  multipart/v2 — ingest is v2-only by design).

## Known accepted degradations

- Desktop standalone ingest requires a reachable server (127.0.0.1:19828);
  sidecar packaging is out of scope.
- claude-code/codex-cli providers cannot ingest server-side (fail fast, clear error).
- JS image extraction (pdfjs-dist + pure-JS PNG) may differ from Rust pdfium on
  exotic PDF rasters.
- MinerU local backend requires co-location; remote falls back to pdfjs preprocess.

## Stages (each independently testable)

1. Migration 013 + store lifecycle ops (claim/complete/fail/retry/reset/touch)
2. Pure pipeline modules → `ingest/` (verbatim ports + ported unit tests)
3. llm-call.js maxTokens/temperature params + resolveIngestConfig + ingest/llm.js
4. ingest/embed.js (embeddingFetch exports + embedPage port → vec0)
5. images/MinerU/preprocess on the worker pool (first real pool consumer)
6. ingest/write.js + ingest/reviews.js
7. ingest/pipeline.js + progress.js (mocked-LLM end-to-end tests)
8. orchestrator.js + API surface + SSE + boot wiring
9. Client cutover; DELETE browser pipeline
10. Docs (PUSH1 §3 rewrite) + validation fleet + merge

## Validation fleet (Playwright vs booted index-v2 + mocked providers)

- **S1** upload→complete with zero client pipeline; assert browser request log
  has NO calls to the provider origin (LLM traffic is server-side).
- **S2** tab-close resilience: kill browser mid-ingest; server completes.
- **S3** crash recovery: SIGKILL mid-ingest; restart; row re-dispatched, no dupes.
- **S4** failure surfacing: 3 attempts → failed + UI error → retry succeeds.
- **S5** usage-limit backoff: 429 → pending with retryAt≈+15min, zero requests
  during observation, other projects keep processing.
- **S6** concurrency/ordering: 6 files / 2 projects / cap 2 → never >2 in flight,
  per-project strictly serial, FIFO start order.
- **S7** shared-store config end-to-end incl. ingestPresetId ≠ chatPresetId.
- **S8** cancel mid-ingest: abort, partial writes removed, vectors gone.
