# llm_wiki Node.js Skill + MCP — Status

> **Status: ✅ Completed**
> Last updated: 2026-05-02

## What this is

A backend-only port of [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)
delivered as **one** Node.js library exposed through **three** entry
points:

1. `dist/cli.js` — command-line interface
2. `dist/mcp-server.js` — Model Context Protocol stdio server
3. `SKILL.md` — discovery / trigger manifest for skill-aware hosts

See [`architecture.md`](./architecture.md) for the full design.

---

## Capability matrix

### CLI commands (`dist/cli.js`)

| Command | Purpose | Status |
|---|---|---|
| `init <wiki>` | Create wiki dir layout | ✅ |
| `status <wiki>` | Page + community counts | ✅ |
| `search <wiki> <query>` | BM25(+RRF) keyword search | ✅ |
| `graph <wiki>` | Build knowledge graph (Louvain) | ✅ |
| `insights <wiki>` | Surprising connections + gaps | ✅ |
| `lint <wiki>` | Orphan / broken-link check | ✅ |
| `ingest <wiki> <file>` | Two-stage LLM ingest | ✅ |
| `deep-research <wiki> <topic>` | Web-search → synth → ingest | ✅ |

### MCP tools (`dist/mcp-server.js`)

| Tool | Status |
|---|---|
| `wiki_status` | ✅ |
| `wiki_search` | ✅ |
| `wiki_graph` | ✅ |
| `wiki_insights` | ✅ |
| `wiki_lint` | ✅ |
| `wiki_ingest` | ✅ |
| `wiki_deep_research` | ✅ |

---

## Validation

Real end-to-end tests run on every `npm run test:e2e`. They drive
`dist/cli.js` and `dist/mcp-server.js` as subprocesses, against a real
on-disk wiki fixture, with LLM/Tavily traffic served by a real local
HTTP server (no code-level mocks).

Latest run: **19/19 cases passed** — see [`test-report.md`](./test-report.md).

| Phase | Cases |
|---|---|
| Non-LLM CLI | init, status, search, graph, insights, lint |
| LLM CLI | ingest (cold), ingest (cache hit), deep-research |
| MCP | initialize, tools/list, all 7 tool calls |
| Regression | post-ingest lint |

---

## Host integration guides

- [`usage-claude.md`](./usage-claude.md) — Claude Desktop (MCP) + Claude Code (Skill)
- [`usage-cursor.md`](./usage-cursor.md) — Cursor MCP
- [`usage-copilot.md`](./usage-copilot.md) — VS Code GitHub Copilot Chat (MCP)
- [`usage-codex.md`](./usage-codex.md) — OpenAI Codex CLI (MCP)
- [`usage-hermes.md`](./usage-hermes.md) — Hermes (Skill or MCP)

---

## Design decisions made along the way

1. **MCP-first, Skill-second, CLI as the safety net.** MCP is the only
   protocol every target host supports natively today.
2. **Single source tree.** The previous duplicated `mcp-server/`
   directory was deleted; everything lives in `skill/src/lib/`.
3. **Env-var configuration only.** No config files. Every host's
   config syntax already supports passing env vars to a child process.
4. **No code-level mocks in tests.** A real local OpenAI/Tavily-
   compatible HTTP server (`src/test-server/fake-llm-server.ts`)
   replaces only the upstream provider so the skill code's `fetch` /
   SSE parsing / file I/O paths all execute for real.

---

## Out of scope (intentionally)

- Image extraction (PDF/PPTX/DOCX) — needs Rust pdfium binding
- Vision-LLM caption pipeline — needs multimodal endpoint
- Sweep-reviews queue — depends on long-lived UI store
- LanceDB vector index — kept as a graceful no-op via
  `shims/embedding-stub.ts`

REVIEW blocks emitted by the LLM are still **parsed** and surfaced to
the caller (CLI prints them as JSON, MCP renders them in the tool
reply), so a host can act on them.

---

## Files reference

| File | Role |
|---|---|
| `skill/src/lib/ingest.ts` | Two-stage LLM pipeline (analysis → generation → write) |
| `skill/src/lib/deep-research.ts` | Multi-query search → LLM synthesis → auto-ingest |
| `skill/src/lib/llm-client.ts` | OpenAI-compatible SSE streaming |
| `skill/src/lib/web-search.ts` | Tavily client (configurable base URL) |
| `skill/src/lib/page-merge.ts` | LLM-assisted merge of conflicting page versions |
| `skill/src/lib/ingest-cache.ts` | SHA256-keyed incremental cache |
| `skill/src/cli.ts` | CLI entry point |
| `skill/src/mcp-server.ts` | MCP entry point |
| `skill/src/test-server/fake-llm-server.ts` | Real local OpenAI/Tavily HTTP server |
| `skill/src/test-server/e2e.ts` | End-to-end runner that produces `test-report.md` |
