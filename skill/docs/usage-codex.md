# Using llm-wiki with OpenAI Codex CLI

The OpenAI Codex CLI (`codex` / `codex chat`) supports MCP servers via
its `~/.codex/config.toml`.

## Install

```bash
git clone https://github.com/toughhou/llm_wiki.git
cd llm_wiki/skill
npm install
npm run build
```

## Configure

Add an `[mcp_servers.llm-wiki]` block to `~/.codex/config.toml`:

```toml
[mcp_servers.llm-wiki]
command = "node"
args = ["/absolute/path/to/llm_wiki/skill/dist/mcp-server.js"]

[mcp_servers.llm-wiki.env]
WIKI_PATH = "/Users/me/notes/my-wiki"
OPENAI_API_KEY = "sk-..."
LLM_MODEL = "gpt-4o-mini"
TAVILY_API_KEY = "tvly-..."
```

Run `codex mcp list` to verify the server starts and exposes the 7
`wiki_*` tools.

## Use

```
$ codex chat
> Use llm-wiki to search my wiki for "transformer" and then run insights.
```

Codex resolves `llm-wiki:wiki_search` and `llm-wiki:wiki_insights`,
calls them in sequence, and folds the results back into the chat
context.

## CLI alternative (no MCP)

If you'd rather have Codex shell out to the CLI (e.g. inside a longer
shell pipeline), `codex` can call `node dist/cli.js …` directly:

```
> Run `node /path/to/skill/dist/cli.js status /Users/me/notes/my-wiki`
> and summarize the output.
```

This works without any MCP configuration but loses the typed-tool
semantics — Codex sees raw stdout and has to parse it.

## Tool reference

`wiki_status`, `wiki_search`, `wiki_graph`, `wiki_insights`,
`wiki_lint`, `wiki_ingest`, `wiki_deep_research` — see
[`architecture.md`](./architecture.md).
