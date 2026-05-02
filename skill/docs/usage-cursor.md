# Using llm-wiki with Cursor

Cursor supports MCP servers natively (Settings → Features → MCP).

## Install

```bash
git clone https://github.com/toughhou/llm_wiki.git
cd llm_wiki/skill
npm install
npm run build
```

## Configure

Open `~/.cursor/mcp.json` (create if missing):

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/llm_wiki/skill/dist/mcp-server.js"],
      "env": {
        "WIKI_PATH": "/Users/me/notes/my-wiki",
        "OPENAI_API_KEY": "sk-...",
        "LLM_MODEL": "gpt-4o-mini",
        "TAVILY_API_KEY": "tvly-..."
      }
    }
  }
}
```

Open Cursor → `Cmd+,` → search for `MCP` → click **Refresh**. The
server should appear with 7 tools enabled.

## Per-project configuration

If you keep one wiki per project, use a project-local
`.cursor/mcp.json` instead and point `WIKI_PATH` to a folder inside the
project:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/llm_wiki/skill/dist/mcp-server.js"],
      "env": {
        "WIKI_PATH": "${workspaceFolder}/.wiki"
      }
    }
  }
}
```

## Use it from Cursor Composer

Open Composer (`Cmd+I`) and try:

> "Use the llm-wiki MCP server: search the wiki for `attention`, then
> run insights on it."

> "Ingest `docs/architecture.md` into the wiki."

Cursor will route the call to the MCP server, stream the result back
into the composer panel, and let you act on it.

## Tool reference

Same 7 tools as Claude Desktop:
`wiki_status`, `wiki_search`, `wiki_graph`, `wiki_insights`,
`wiki_lint`, `wiki_ingest`, `wiki_deep_research`.

See [`architecture.md`](./architecture.md) for the full env-var list.
