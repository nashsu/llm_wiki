# P2 — Chunked upload protocol (issue #14, §4.8, Decision 15)

**Charter promise (V1_CHARTERED_ARCHITECTURE.md Decision 15 + §4.8):** small
files (≤10MB) go single-shot multipart; large files (>10MB) take a chunked
protocol — `POST /upload/init {fileName, fileSize, destPath}` → `{uploadId}`,
then `PUT /upload/:uploadId/chunk?offset=N` (octet-stream, 5MB chunks) →
`{received}`, then `POST /upload/:uploadId/complete` → `{path, size}`.
Drag-drop + folder upload; the client picks the path by file size.

**Reality:**
- One multipart route: `POST /api/v2/projects/:id/ingest/upload`
  (multer memoryStorage, whole file in server RAM), capped at a HARDCODED
  50MB literal, written non-atomically, auto-enqueued into the ingest queue.
- No chunked endpoints anywhere.
- `DropZone.tsx` (drag-drop + folder drop + per-file progress + SSE/poll
  tracking) exists but is **mounted nowhere** — drag-drop is unreachable in
  the running UI (plans/server-ingest.md always intended SourcesView to
  mount it).
- No client-side size dispatch, no byte-level upload progress.

**Decision per #14:** implement the charter thresholds — >10MB chunked,
≤10MB stays single-shot multipart, 5MB chunks with per-chunk retry and
offset-resume on network drop, overall cap stays 50MB but becomes
env-configurable (`LLM_WIKI_MAX_UPLOAD_MB`).

## Endpoint placement — files domain, charter shapes

Mounted under `/api/v2/projects/:id/files` (the files router; charter §4.8
places them at `/files/upload/...`; the live API is v2, not v1):

| Route | Body | Response |
|---|---|---|
| `POST /upload/init` | `{fileName, fileSize, destPath}` | `201 {uploadId}` |
| `PUT /upload/:uploadId/chunk?offset=N` | octet-stream chunk | `{received}` |
| `POST /upload/:uploadId/complete` | — | `{path, size}` |

No collision with the existing `POST /files/upload` (JSON write). Charter
response shapes are kept verbatim — notably `complete` returns `{path, size}`
with NO taskId: **complete does not auto-enqueue**. The client feeds the
ingest pipeline through the existing `POST /api/v2/projects/:id/ingest`
(enqueue-by-path) right after `complete`. The ≤10MB path stays the existing
one-shot `/ingest/upload` (auto-enqueue) — untouched semantics.

## Server session state — in-memory, documented

New module `packages/server/src/uploads/chunked.js`:

- `Map<uploadId, session>`; `uploadId = crypto.randomUUID()`.
- session: `{uploadId, projectId, fileName, fileSize, destPath, received,
  stagingPath, createdAt, lastActivityAt}`.
- Staging file: `<DATA_DIR>/upload-staging/<uploadId>.part` — inside the
  server state dir so half-written bytes never appear in the project tree;
  consistent with the repo's "no os.tmpdir()" convention.
- Chunk write: validate `offset === session.received` (strictly sequential),
  then append the body to the staging file and `received += bytes`.
- **Resume channel:** an `offset !== received` PUT answers
  `400 VALIDATION_ERROR` with `details: {received}` — the client resumes from
  the server's byte count. This covers both reconnect-after-ambiguity and
  plain offset bugs without adding an un-chartered status endpoint.
- TTL 24h from last activity; a sweep timer (10min, started from the
  index-v2 boot block like the orchestrator) unlinks staging files and drops
  expired sessions.
- **Server restart drops in-flight sessions** (accepted degradation for v1
  single-user; client simply re-uploads from byte 0 — documented).

## complete semantics

- Guard `received === fileSize` (else 400), session project === route
  project (else NOT_FOUND), unknown/expired uploadId → NOT_FOUND.
- `destPath` containment via `safeJoin` (FORBIDDEN on escape); mkdir -p the
  parent; pre-write existence check decides created-vs-modified.
- Copy staging → `${absDest}.${pid}.${Date.now()}.tmp` (same-dir atomic-write
  convention; copy not rename — DATA_DIR may be another device) → rename onto
  dest.
- Emit `file:created`/`file:modified` `{projectId, path: <project-relative>,
  size}` via the established `emit()` bridge (added to the PUSH1 §5 SSE
  write-site list).
- Delete session + unlink staging. Respond `{path: destPath, size}`.

## Caps + the multer 413 fix

- `config.js`: `MAX_UPLOAD_BYTES` from `LLM_WIKI_MAX_UPLOAD_MB` (default 50,
  clamp 1..4096), eager like its siblings.
- `ingest.js` multer `limits.fileSize` switches from the hardcoded literal to
  `MAX_UPLOAD_BYTES` (covers the ≤10MB path — still far above 10MB).
- **MulterError surfaces as 413 today → it's a scrubbed 500.** Fix in
  `middleware/error.js`: `MulterError LIMIT_FILE_SIZE` → `ApiError
  FILE_TOO_LARGE` (413, already in the STATUS map).
- init validates `fileSize ≤ MAX_UPLOAD_BYTES` else `413 FILE_TOO_LARGE`;
  chunk bodies are bounded by the session's `fileSize` (overflow → 400).

## api-types SSOT (packages/api-types/src/schemas/files.ts)

`ChunkedUploadInitBodySchema` `{fileName: min1, fileSize: int.positive,
destPath: min1}` · `ChunkedUploadInitResponseSchema` `{uploadId}` ·
`ChunkedUploadChunkQuerySchema` `{offset: coerce.int.min(0)}` ·
`ChunkedUploadChunkResponseSchema` `{received: int.min(0)}` ·
`ChunkedUploadCompleteResponseSchema` `{path, size}`. Barrel re-export;
`openapi.js` gains registerPath entries for all three routes.

## Client

- New `src/lib/chunked-upload.ts`:
  - `CHUNK_SIZE = 5MB`, `MULTIPART_MAX_BYTES = 10MB` (charter thresholds).
  - `uploadFileAuto(projectId, file, {onProgress?, signal?})`:
    ≤10MB → existing `uploadForIngest`; else init → chunk loop over
    `file.slice(start, end)` PUTs (raw fetch + bearer header, following the
    `files.ts` download precedent — `request()` has no raw-body mode) →
    `complete` → `enqueueByPath(projectId, res.path)` → returns the enqueue
    response (`{taskId, …}`).
  - Per-chunk retry: up to 3 attempts with backoff; a 400-with-`details.
    received` mismatch re-reads the server byte count and resumes there.
  - `onProgress(receivedBytes/totalBytes)` per chunk.
  - destPath chosen client-side: `raw/sources/<ts>_<hex8>_<sanitized-name>`
    (mirrors the server scheme from the multipart route — comment cross-refs).
- `DropZone.tsx`: `uploadOne` switches to `uploadFileAuto` with progress
  patching (byte-level bars finally move); `projectId` prop widens to
  `number | string`, resolving the numeric projects-row id once
  (`GET /api/v2/projects`) for the SSE filter while API calls accept either.
- `sources-view.tsx`: mounts `<DropZone>` between the header and the tree
  (the plans/server-ingest.md intent); `onUploadComplete` → `loadSources()`.

## Known accepted degradations

- Server restart drops in-flight chunked sessions → client re-uploads from 0.
  (No persistence table for v1 single-user; documented.)
- No abort/cancel endpoint — abandoning an upload leaves the session to the
  24h TTL sweep.
- Chunk PUT bodies are buffered per-chunk in process memory (≤ chunk size;
  client sends 5MB, server rejects anything overflowing the session size).

## Stages (each independently testable)

1. **api-types schemas + caps** — schemas in files.ts; `MAX_UPLOAD_BYTES` in
   config.js; multer limit env-driven; MulterError→413 mapping; cap tests.
2. **Server chunked endpoints** — uploads/chunked.js session store + staging
   IO + sweep; init/chunk/complete routes in files.js; SSE emit at complete;
   sweep start in index-v2 boot; openapi registerPath.
3. **Server tests** — api-chunked-upload.test.js (supertest harness): happy
   path + byte integrity, resume via 400 details.received, offset
   mismatch/replay, overflow, incomplete complete, 413 oversize init,
   traversal FORBIDDEN, unknown id NOT_FOUND, overwrite → file:modified,
   multipart 413 env cap.
4. **Client** — chunked-upload.ts + DropZone wiring (progress, numeric-id
   resolve) + sources-view mount.
5. **Client tests** — chunked-upload.test.ts: dispatch by size, chunk
   offsets, retry+resume on mismatch, progress monotonic, enqueue after
   complete.
6. **Docs** — PUSH1 §5 bullet + §5 SSE write-site list + §3 Stage 1 touch-up
   + §6 rows; API_REFERENCE Files rows + FILE_TOO_LARGE note; DEPLOYMENT env
   mention.
7. **Validation fleet** (below) + full gates.

## Validation fleet (Playwright vs booted index-v2 + mock LLM)

Reuses the SSE-fleet harness pattern (boot isolated index-v2, mock LLM,
seeded project, Playwright) with REPO pointed at this worktree.

- **S1 small-file drop → multipart:** SPA tab, file through the DropZone
  input → multipart path → queued → ingest completes (mock LLM) → entry done;
  source tree shows the file without reload.
- **S2 large-file chunked end-to-end:** an >10MB file (11MB) through the
  DropZone → chunked init/chunks/complete observed → byte-level progress
  moves → enqueue → ingest complete; `file:created` frame on the SSE
  collector; tree shows the file.
- **S3 resume on chunk failure:** intercept one chunk PUT (page.route) and
  fail it → client retries and resumes from the server-reported `received`
  (assert the offset sequence and final success).
- **S4 cap enforcement:** boot with `LLM_WIKI_MAX_UPLOAD_MB=20`, submit a
  25MB file → entry errors with the 413 message; nothing written.

**Gates:** `npm test -w @llm-wiki/server` per stage; stages 4–7 additionally
`npm run typecheck`, `npm run test:mocks`, `npm run build:web`.

## Review-fix addendum (PR #30 round 1)

- **F1:** `appendChunk` serialized per session via a promise chain
  (`session.appendChain`) — concurrent same-offset PUTs can no longer
  double-append; the loser observes the updated count and answers the resume
  channel.
- **F2:** write-integrity guards — `bytesWritten` check (short write =
  failure) and truncate-back-to-`received` on any staging write failure;
  `completeChunkedUpload` verifies the actual staging size equals `fileSize`
  before copying (mismatch → destroy session + staging, INTERNAL_ERROR;
  client re-uploads).
- **F3:** `startChunkedUploadSweeper` wipes orphaned staging `.part` files at
  boot (sessions never survive a restart).
- **F4:** DropZone treats retryable `ingest:error` frames (status "pending")
  as queued, matching sse-sync.ts; only `status: "failed"` /
  `retryable: false` flips the entry to error.
- **F5:** the complete route maps finalize fs errors through `mapFsError` and
  destroys the session + staging on a terminal finalize failure (destPath is
  fixed at init, so it can never complete on retry).
- **F6:** the chunk route checks `offset === received` BEFORE the bounded
  body read, so a resent final chunk answers 400 WITH `details.received`
  (resume channel survives); the client returns immediately from
  `putChunkWithRetry` when the adopted `received` reaches `file.size`.
