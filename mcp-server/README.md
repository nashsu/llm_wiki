# LLM Wiki MCP Server

Local stdio MCP server for the LLM Wiki desktop app. It wraps the app's local
HTTP API at `http://127.0.0.1:19827/api/v1` so agents can discover and call
LLM Wiki as named MCP tools instead of raw HTTP endpoints.

## Requirements

- Start the LLM Wiki desktop app.
- Open the target project in the app.
- Keep the local API reachable at `127.0.0.1:19827`.
- Configure an LLM provider in LLM Wiki Settings before using
  `llmwiki_chat`, `llmwiki_ingest_clip`, or `llmwiki_ingest_file`.

## Run

From this repository:

```powershell
npm run mcp:llmwiki
```

Equivalent direct command:

```powershell
node D:\Dev\llm_wiki\mcp-server\llmwiki-mcp.js
```

Optional environment variables:

- `LLMWIKI_API_BASE`: defaults to `http://127.0.0.1:19827/api/v1`
- `LLMWIKI_TIMEOUT_MS`: defaults to `60000` for ordinary calls; chat and
  ingest calls keep a 30 minute timeout to match the desktop bridge.

## Codex Registration

```powershell
codex mcp add llmwiki -- node D:\Dev\llm_wiki\mcp-server\llmwiki-mcp.js
```

Newly registered MCP servers may require a new Codex session before the tools
appear.

## Claude Desktop Example

Add a server entry like this to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "llmwiki": {
      "command": "node",
      "args": ["D:\\Dev\\llm_wiki\\mcp-server\\llmwiki-mcp.js"]
    }
  }
}
```

## Tools

- `llmwiki_status`: checks whether the local LLM Wiki API is reachable and
  reports current project, recent projects, and capabilities.
- `llmwiki_search`: quick ranked search across an LLM Wiki project.
- `llmwiki_retrieve`: retrieves citation-ready context, relevant pages,
  references, search hits, and graph expansions.
- `llmwiki_chat`: asks LLM Wiki to answer using the app's configured LLM and
  project knowledge base.
- `llmwiki_graph`: returns the project knowledge graph; text summarizes counts
  and `structuredContent` contains the full graph.
- `llmwiki_ingest_clip`: saves text as a raw source in the active project and
  queues it for ingest.
- `llmwiki_ingest_file`: copies a local file into the active project's
  `raw/sources` directory and queues it for ingest.

Every tool returns a short text summary plus `structuredContent` containing the
raw LLM Wiki API response. API failures return `isError: true` with a concrete
hint to start the app and open the target project.
