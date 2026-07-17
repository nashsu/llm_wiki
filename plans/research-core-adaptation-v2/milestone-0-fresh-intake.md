# Nashsu Research Core Adaptation V2 — Milestone 0 Fresh Intake

## Status

The implementation map is coherent enough to scope later work, but the baseline
is not fully green. No production code, dependency, lockfile, schema, or runtime
was changed. Milestone 1 was not started.

Nashsu/llm_wiki remains the sole canonical product and knowledge core.
AtomicStrata, AutoSci, OpenKB, Synto, Open Knowledge CLI, llm-wiki-okf, OKF, and
additional orchestration runtimes remain outside the implementation boundary.
OpenDeepWiki remains a future lazy, repository-scoped, non-canonical adjunct.

## Exact baseline

- Repository: `https://github.com/nashsu/llm_wiki.git`
- Baseline branch: `main`
- Intake branch: `codex/research-core-m0-intake`
- Commit: `969e7e8d9e2903af0e3ed0be85c97639511e845c`
- Describe: `v0.6.4-8-g969e7e8`
- Commit: `fix: harden provider and import routing`
- Commit date: `2026-07-16T17:04:21+08:00`
- App/package/Cargo/Tauri version: `0.6.4`
- MCP package version: `0.4.25`
- Handoff: all 25 manifest entries matched their declared SHA-256 and byte size.

The workspace initially contained no Nashsu checkout, so the current upstream
repository was cloned before inspection.

## Orchestration and capability check

- Codex CLI: `0.142.5`
- CLI feature state: `multi_agent = stable/true`;
  `multi_agent_v2 = under-development/false`;
  `enable_fanout = under-development/false`.
- Official Codex documentation describes direct subagents, a default nesting
  depth of one, and built-in `worker` and `explorer` roles.
- This task runtime exposed no spawn/subagent tool, so no worker was delegated.
  The root performed three sequential, isolated, read-only scout-equivalent
  passes: frontend/ingest, Rust/API, and MCP/model routing.
- The requested GPT-5.6 Sol High identity/reasoning setting is not inspectable
  or configurable from this task surface, so it cannot be independently
  verified.

The compact DAG is in `milestone-0-execution-dag.md`.

## Root implementation map

| Capability | Current authority and behavior | Adaptation consequence |
| --- | --- | --- |
| Template materialization | `src/lib/templates.ts` defines schema, purpose, and extra directories. `src-tauri/src/commands/project.rs` creates the base project; `src/components/project/create-project-dialog.tsx` then writes the selected template files/directories. | Research Profile v2 must update the existing two-stage path, not add a creator. |
| Schema routing | `src/lib/wiki-schema.ts` parses the `## Page Types` table dynamically and maps type to directory. In ingest, generated blocks are checked against this routing before write. Other schema prose mostly guides prompts. | Add `repository` to the Research table; do not build a generic schema engine. |
| Fixed page-type surfaces | `src/lib/wiki-page-types.ts`, knowledge-tree and activity icon maps, `src/lib/wiki-type-style.ts`, and i18n labels contain known-type lists. Graph affinity and review-page creation also have fixed maps but safe fallbacks. | Milestone 1 must update user-visible/generation lists and test dynamic fallback surfaces. |
| Source import | `src/lib/source-lifecycle.ts` copies files into `raw/sources`, preprocesses them, and immediately calls `enqueueSourceIngest` when an ingest model is usable. | Candidate registration must be inserted before enqueue for Research projects only; reuse import/copy logic. |
| Ingest queue | `src/lib/ingest-queue.ts::enqueueBatch`; state is project-scoped in `.llm-wiki/ingest-queue.json`. It supports pause, restart recovery, retry, cancellation, stable project identity, and serial processing. | Candidate batch include/watch/exclude should feed this queue; no second queue. |
| Ingest and merge | `src/lib/ingest.ts` performs analysis/generation, validates schema routing, creates review items, and writes through `mergePageContent`. `src/lib/page-merge.ts` unions `sources`, `tags`, and `related`, locks `type`, `title`, and `created`, and writes history backups. | Corpus bootstrap and Research writes must use normal ingest/merge/review behavior. |
| Review persistence | `src/stores/review-store.ts`; `.llm-wiki/review.json` through `src/lib/persist.ts` and autosave. The Rust API reads and patches the same file. | Extend existing review/activity patterns; do not add a review store. |
| Search/index | Rust search in `src-tauri/src/commands/search.rs` backs desktop invoke and API search. Index rebuild groups pages dynamically from frontmatter. Embeddings are optional. | `repository` should become searchable without a new index; add acceptance coverage. |
| Graph | Desktop uses the TypeScript wiki graph path. API/MCP use a separate Rust `build_graph` in `api_server.rs`; the API currently excludes `query` nodes. Both derive types dynamically. | Repository visibility should work, but graph parity is an existing architectural discrepancy to resolve or document. |
| Model routing | Desktop chat and ingest use `src/lib/llm-task-routing.ts` with separate `chat` and `ingest` presets. Image captioning is passed the ingest-side configuration. Embedding has separate embedding settings. Rust API/MCP chat uses `project_llm_config`, global config, and project overrides but does not apply `taskModelRouting.chatPresetId`. | Preserve current desktop routing; add parity tests before relying on MCP chat for acceptance. |
| Local API | `src-tauri/src/api_server.rs`, port `19828`, prefix `/api/v1`; exposes health, projects, files, reviews, search, graph, source rescan, chat, and cancellation with auth, bind, rate, size, and path controls. | Extend the API only when a required Research operation cannot use an existing endpoint. |
| MCP | `mcp-server` is a thin HTTP client over the desktop API. It registers 10 tools: status, projects, set-project, files, read-file, reviews, search, chat, graph, and rescan-sources. | Keep MCP thin; no filesystem scan or independent retrieval implementation. |
| Project selection | Stable UUID in `.llm-wiki/project.json`; global `app-state.json` registry; API accepts stable ID, exact path, or `current`; MCP can pin a process to a project and rejects conflicting overrides. | Candidate and corpus state must key by stable project identity and remain project-scoped. |

Representative `.llm-wiki/` state includes `project.json`,
`ingest-queue.json`, `ingest-cache.json`, `ingest-progress/`,
`ingest-warnings.log`, `review.json`, `lint.json`, `file-snapshot.json`,
`file-change-queue.json`, `dedup-queue.json`, `dedup-not-duplicates.json`,
`scheduled-import-db.json`, `image-caption-cache.json`, `conversations.json`,
`chats/`, `chat-preferences.json`, `history/`, `page-history/`, `lancedb/`, and
project `skills/`. Candidate screening needs one new small project-scoped file,
not a replacement for any of these.

## Handoff anchor reconciliation

All named high-value anchors still exist. The paths are useful, but three
assumptions require correction:

1. Schema routing is already substantially dynamic. Adding a page type does not
   require Rust index/search/graph type registration, although fixed generation
   and UI presentation lists still need updates.
2. Desktop and API/MCP graph generation are not one shared backend. The API has
   its own Rust graph builder and intentionally drops `query` nodes.
3. Desktop task-model routing and API/MCP chat routing are not equivalent. The
   Rust API does not currently consume the chat task preset.

Additional baseline findings:

- The Research template's shared frontmatter example lists only base types even
  though the same schema defines `thesis`, `methodology`, and `finding`.
- Import currently means copy plus immediate enqueue; there is no candidate
  registration/screening state.
- `npm ci` at the root is not reproducible from the checked-in lockfile:
  `@emnapi/core@1.11.2` and `@emnapi/runtime@1.11.2` are missing and
  `@emnapi/wasi-threads` resolves at an invalid locked version. Dependencies
  were materialized with `npm install --package-lock=false`; the lockfile was
  preserved.
- Existing tests strongly cover page merge preservation and TypeScript task
  routing. Research template form state is tested, but full Research project
  materialization is not. MCP client tests prove HTTP calls, but there is no
  explicit architectural regression test forbidding direct filesystem scans.

## Validation evidence

| Command | Result |
| --- | --- |
| `npm run test:mocks -- --reporter=dot` | PASS: 117 files, 1,707 tests. |
| `npm run build` | PASS: TypeScript and Vite production build; existing chunk/dynamic-import warnings only. |
| `npm run mcp:test` | PASS: 20 tests. |
| `npm run test:llm` | FAIL: 6 failed, 3 passed, 70 skipped. Three fake embedding-server tests receive `undefined`; three Origin tests send `http://localhost` instead of the endpoint origin. External provider suites were skipped because credentials/endpoints were unavailable. |
| `cargo test -q` | PASS: 338 passed, 1 ignored; existing compiler warnings only. |
| `npm run tauri dev` | PASS: desktop binary launched; Vite served `http://localhost:1420/`; Clip Server listened on `127.0.0.1:19827`; API listened on `127.0.0.1:19828/api/v1`. |
| Local API smoke | PASS: health 200 (`version: 0.6.4`), CORS preflight 204. Projects returned the expected 401 because the fresh state requires auth but has no token configured; MCP is disabled. |

The first Rust/launch attempts failed when the data volume had about 118 MiB
free. After space was restored, both completed. The build consumed most of the
new headroom and left about 1 GiB free.

The computer-use skill is installed, but this task surface does not expose its
required action tool. The app and services were launched and probed, but
click-driven creation/import/review/search/graph flows were therefore not
manually exercised.

## Proposed PR sequence

1. **M0 baseline stabilization:** add the canonical-core ADR, repair root
   lockfile reproducibility, document the full local stack, add missing Research
   materialization/MCP-boundary regressions, and decide whether the six
   real-contract failures are code or stale test expectations. Add an
   authenticated full-stack fixture for API/MCP acceptance.
2. **M1 Research Profile v2:** add only `repository` and
   `wiki/repositories/`; keep flat frontmatter; update the fixed surfaces above;
   add creation, routing, rendering, search/graph visibility, and safe-merge
   tests.
3. **M2 candidate intake:** add a small Research-only project store and
   include/watch/exclude UI; register without ingest; batch-enqueue through the
   existing queue.
4. **M3 screening and progress:** structured screening output, migration and
   restart tests, and existing activity/review integration.
5. **M4 bounded corpus bootstrap:** inventory, group, cluster synthesis, and
   global synthesis through normal compiled pages and merge/review.
6. **M5 MCP/API parity:** expose only missing Research operations, resolve
   graph/model-routing parity, and keep MCP as an API client.
7. **M6 OpenDeepWiki adjunct:** lazy repository registration and
   commit-pinned evidence only; never canonical.

## Root decision and remaining uncertainty

The extension seams are clear and no new core runtime or generic abstraction is
justified. Before Milestone 1, disposition the six real-contract failures and
perform one authenticated, click-driven baseline pass through current
Research creation, import, review, search, graph, API, and MCP behavior. The
remaining evidence gaps are not permission to broaden Milestone 1.
