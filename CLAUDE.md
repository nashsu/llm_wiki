# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (Vite only — frontend hot reload, no native Tauri window)
npm run dev

# Full Tauri dev mode (native window + hot reload)
npm run tauri dev

# Type check only
npm run typecheck

# Production build (runs typecheck first)
npm run build

# Run all mock-based unit tests (no real LLM calls)
npm run test:mocks

# Run real-LLM integration tests (requires .env.test.local)
npm run test:llm

# Run a single test file
npx vitest run src/lib/ingest-queue.test.ts

# Run tests matching a pattern
npx vitest run --reporter=verbose -t "retries failed"
```

Real-LLM tests require `.env.test.local` in the project root with provider credentials. The file is gitignored; `src/test-helpers/load-test-env.ts` loads it automatically.

## Architecture

This is a **Tauri v2** desktop app: a React/TypeScript frontend embedded in a Rust shell. The two halves communicate exclusively via Tauri's `invoke()` IPC — the frontend never accesses the filesystem or network directly.

### Layer boundaries

```
React UI  →  src/commands/*.ts (invoke wrappers)  →  src-tauri/src/commands/*.rs
                                                  →  src-tauri/src/api_server/  (port 19828)
                                                  →  src-tauri/src/clip_server.rs (port 19827)
```

All filesystem reads/writes go through `src/commands/fs.ts` → `src-tauri/src/commands/fs.rs`. All outbound HTTP (LLM, web search, embedding) goes through `src/lib/tauri-fetch.ts` → `tauri_plugin_http` (Rust), bypassing browser CORS.

### State management

Global state lives in Zustand stores under `src/stores/`:

| Store | Responsibility |
|-------|---------------|
| `wiki-store.ts` | Active project, file tree, LLM/search/embedding configs, all settings |
| `activity-store.ts` | Ingest progress items shown in the Activity Panel |
| `chat-store.ts` | Chat sessions, messages, streaming state |
| `review-store.ts` | Async review queue (items flagged by LLM during ingest) |
| `research-store.ts` | Deep Research task queue |
| `file-sync-store.ts` | External file watcher state |

Settings are persisted to `app-state.json` (Tauri Store) via `src/lib/project-store.ts`. Project-local data lives in `{project}/.llm-wiki/`.

### Ingest pipeline

`src/lib/ingest.ts` (~1900 lines) orchestrates the two-step LLM ingest:

1. **Stage 1 (Analysis)**: `buildAnalysisPrompt()` → LLM reads source → structured analysis
2. **Stage 2 (Generation)**: `buildGenerationPrompt()` → LLM generates wiki files as `---FILE: path---…---END FILE---` blocks
3. `parseFileBlocks()` extracts and validates those blocks; `executeIngestWrites()` writes them
4. SHA256 cache (`src/lib/ingest-cache.ts`) skips unchanged sources

`src/lib/ingest-queue.ts` wraps ingest in a persistent serial queue (persisted to `.llm-wiki/ingest-queue.json`), handling retry (max 3) and project-switch cancellation.

Ingest modules receive an `IngestRuntime` interface (`src/lib/ingest-runtime.ts`) instead of importing stores directly — this is the testing seam that lets unit tests run without a Tauri environment.

### LLM abstraction

`src/lib/llm-client.ts` exports `streamChat()` — the single entry point for all LLM calls. It delegates to `src/lib/llm-providers.ts` which builds provider-specific request bodies and headers (OpenAI, Anthropic, Google, Azure, Ollama, MiniMax, Claude Code CLI, Codex CLI). Claude Code CLI and Codex CLI are lazy-imported to keep their Tauri subprocess bindings out of test bundles.

### Search pipeline

`src/lib/search.ts` calls the Rust backend via `invoke("search_project", ...)` → `src-tauri/src/commands/search.rs`. The Rust side handles both tokenized keyword search and optional vector retrieval via LanceDB (`commands/vectorstore.rs`). The frontend applies graph expansion and RRF (Reciprocal Rank Fusion) on top of the backend results.

### Graph

`src/lib/wiki-graph.ts` builds the knowledge graph from `[[wikilink]]` parsing and `sources[]` frontmatter. `src/lib/graph-relevance.ts` scores node pairs with 4 signals: direct link (×3.0), source overlap (×4.0), Adamic-Adar (×1.5), type affinity (×1.0).

### File paths

All path manipulation must use `normalizePath()` from `src/lib/path-utils.ts` (converts `\` → `/`). The `@` alias maps to `src/`.

Conventional project-relative paths:
- Sources: `raw/sources/**/*`
- Wiki: `wiki/**/*.md`
- App state: `.llm-wiki/` (queue, cache, chats, project.json)

`src/lib/source-identity.ts` derives the stable identity key for a source file (strips the `raw/sources/` prefix). This identity is what gets stored in frontmatter `sources:` fields and used for cascade-delete matching.

### Testing patterns

- **`*.test.ts`** — unit tests with mocked filesystem/LLM (run via `test:mocks`)
- **`*.real-llm.test.ts`** — end-to-end tests calling a real provider (run via `test:llm`)
- **`*.scenarios.test.ts`** — fixture-driven tests; fixtures live in `tests/fixtures/` and are materialized to disk by `src/test-helpers/scenarios/materialize.ts`
- **`*.property.test.ts`** — property-based tests using `fast-check`

### Version bumping

When releasing, update the version string in all four places:
1. `package.json`
2. `src-tauri/Cargo.toml`
3. `src-tauri/tauri.conf.json`
4. `src/lib/changelog.ts` (prepend a new entry, newest first)
