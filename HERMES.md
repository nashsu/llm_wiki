# llm-wiki — Hermes Skill Entry

> **Status: ✅ Complete** — all CLI commands and MCP tools are
> implemented and validated end-to-end (see
> [`skill/docs/test-report.md`](skill/docs/test-report.md)).

## What this skill does

Build and maintain a structured knowledge base ("wiki") from raw
documents. Every command operates on a single project root that
contains a `wiki/` subdirectory. See [`SKILL.md`](SKILL.md) for the
full command reference.

## Trigger conditions

Load this skill when the user mentions:

- "知识库" / "wiki"
- "知识图谱" / "graph analysis" / "knowledge graph"
- "深度研究" / "deep research"
- "知识缺口" / "knowledge gap"
- "惊人连接" / "surprising connection"
- ingest / search / lint operations against an existing wiki

## Two integration modes

### Mode A — CLI shell-out (the original Hermes path)

```bash
node skill/dist/cli.js <command> <wiki_root> [args]
```

All eight commands (`status`, `search`, `graph`, `insights`, `lint`,
`init`, `ingest`, `deep-research`) follow this pattern. JSON output is
produced where appropriate so downstream agents can parse it.

### Mode B — Hermes MCP client

Recent Hermes versions support MCP. Register the server in your
Hermes MCP config:

```yaml
servers:
  llm-wiki:
    command: node
    args: ["/abs/path/to/llm_wiki/skill/dist/mcp-server.js"]
    env:
      WIKI_PATH: /Users/me/wiki
      OPENAI_API_KEY: sk-...
      LLM_MODEL: gpt-4o-mini
      TAVILY_API_KEY: tvly-...
```

The same seven `wiki_*` tools appear as native Hermes tool calls.

Detailed walk-through: [`skill/docs/usage-hermes.md`](skill/docs/usage-hermes.md).

## Install

```bash
cd skill
npm install
npm run build
```

Or use the existing repo installer:

```bash
bash install.sh --platform hermes
```

## Requirements

- Node.js ≥ 20
- `OPENAI_API_KEY` (or `LLM_API_KEY` + `LLM_BASE_URL`) for `ingest`
  and `deep-research`
- `TAVILY_API_KEY` for `deep-research`
- All other commands work without any LLM credentials
