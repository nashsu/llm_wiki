---
name: llm-wiki
version: 0.4.6-skill.1
license: MIT
description: |
  Backend port of nashsu/llm_wiki (knowledge-base builder + maintainer)
  delivered as a single Node.js library exposed through three entry
  points: a CLI, an MCP stdio server, and this skill manifest.

  Trigger conditions: the user mentions a "knowledge base", "wiki",
  "knowledge graph", "graph analysis", "deep research", "ingest a
  source into the wiki", "知识库", "知识图谱", "深度研究", or asks
  to operate on an already-initialized wiki directory (search,
  health check, insights, etc.).
metadata:
  origin: nashsu/llm_wiki (GUI stripped, backend extracted)
  runtime: node >= 20
  entry_points:
    cli: skill/dist/cli.js
    mcp: skill/dist/mcp-server.js
  hermes:
    tags: [knowledge-base, wiki, graph-analysis, deep-research, semantic-search]
---

# llm-wiki — Skill Manifest

Three equivalent ways to use this skill, picked by the host:

1. **MCP (recommended)** — point your AI host (Claude Desktop, Cursor,
   VS Code Copilot Chat, OpenAI Codex CLI, Hermes) at
   `skill/dist/mcp-server.js`. It exposes seven `wiki_*` tools.
2. **CLI** — shell out to `node skill/dist/cli.js <command>`.
3. **Direct library** — `require('./skill/dist/lib/...')` from your
   own Node.js code.

All three routes hit the same backend (`skill/src/lib/`).

## Install

```bash
cd skill
npm install
npm run build
```

Verify:

```bash
node dist/cli.js --help
node dist/cli.js status /path/to/wiki-project
```

Run the full end-to-end test suite (real HTTP server, no mocks):

```bash
npm run test:e2e
# → writes skill/docs/test-report.md
```

## CLI commands

| Command | Purpose |
|---|---|
| `init <wiki>` | Create the wiki directory layout |
| `status <wiki>` | Page count + community count |
| `search <wiki> <query>` | BM25 (+ optional vector) search with snippets |
| `graph <wiki>` | Build knowledge graph (4-signal relevance + Louvain) |
| `insights <wiki>` | Surprising connections + knowledge gaps |
| `lint <wiki>` | Find orphans / isolated pages |
| `ingest <wiki> <file>` | Two-stage LLM ingest of a markdown/text source |
| `deep-research <wiki> <topic>` | Web search → LLM synthesis → auto-ingest |

Examples:

```bash
node skill/dist/cli.js status        ~/notes/my-wiki
node skill/dist/cli.js search        ~/notes/my-wiki "attention mechanism"
node skill/dist/cli.js insights      ~/notes/my-wiki
node skill/dist/cli.js ingest        ~/notes/my-wiki ~/raw/paper.md
node skill/dist/cli.js deep-research ~/notes/my-wiki "Mixture of Experts"
```

## MCP tools

Exact JSON schemas are in `skill/src/mcp-server.ts`.

| Tool | Required args | Optional args |
|---|---|---|
| `wiki_status` | — | `project_path` |
| `wiki_search` | `query` | `project_path`, `limit` |
| `wiki_graph` | — | `project_path`, `format` (`summary`\|`json`) |
| `wiki_insights` | — | `project_path`, `max_connections`, `max_gaps` |
| `wiki_lint` | — | `project_path` |
| `wiki_ingest` | `source_file` | `project_path`, `folder_context` |
| `wiki_deep_research` | `topic` | `project_path`, `search_queries`, `auto_ingest` |

## Configuration (env vars)

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` / `LLM_API_KEY` | LLM credentials |
| `LLM_BASE_URL` | OpenAI-compatible endpoint (Ollama, OpenRouter, ...) |
| `LLM_MODEL` | Model name (default `gpt-4o-mini`) |
| `LLM_PROVIDER` | `openai` / `anthropic` / `ollama` / `deepseek` |
| `TAVILY_API_KEY` | Required for `deep-research` / `wiki_deep_research` |
| `WIKI_OUTPUT_LANGUAGE` | `auto` / `English` / `Chinese` / ... |
| `WIKI_PATH` | Default project path for the MCP server |
| `EMBEDDING_*` | Optional vector search (graceful no-op if unset) |
| `SKILL_VERBOSE` | Mirror activity logs to stderr |

## Host integration guides

- Claude (Desktop MCP + Claude Code Skill): [`skill/docs/usage-claude.md`](skill/docs/usage-claude.md)
- Cursor (MCP): [`skill/docs/usage-cursor.md`](skill/docs/usage-cursor.md)
- VS Code Copilot Chat (MCP): [`skill/docs/usage-copilot.md`](skill/docs/usage-copilot.md)
- OpenAI Codex CLI (MCP): [`skill/docs/usage-codex.md`](skill/docs/usage-codex.md)
- Hermes (Skill or MCP): [`skill/docs/usage-hermes.md`](skill/docs/usage-hermes.md)

## Architecture & test report

- Architecture: [`skill/docs/architecture.md`](skill/docs/architecture.md)
- E2E test report: [`skill/docs/test-report.md`](skill/docs/test-report.md)
- Status / progress: [`skill/docs/skill-mcp-progress.md`](skill/docs/skill-mcp-progress.md)

## Out of scope

This is a backend-only skill. Image extraction (PDF/PPTX/DOCX),
vision-LLM captioning, the async sweep-reviews queue, and the
embedded vector index are intentionally not ported — they require
the GUI desktop app or specialized binary dependencies. Use the
upstream [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) Tauri
app for those.

REVIEW blocks emitted by the LLM during `ingest` are still parsed and
returned to the caller (the CLI prints them as JSON; the MCP tool
includes them in the reply) so a host can act on them.
