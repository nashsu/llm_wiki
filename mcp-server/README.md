# llm_wiki MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes **llm_wiki** backend operations as AI-callable tools.

Use it with Claude Desktop, VS Code Copilot Chat, Cursor, or any MCP-compatible host to give your AI assistant direct access to your wiki knowledge base.

## Tools

| Tool | Description |
|------|-------------|
| `wiki_status` | Page count and type breakdown |
| `wiki_search` | BM25 keyword search (+ optional vector via `EMBEDDING_ENABLED=true`) |
| `wiki_graph` | Build Louvain knowledge graph — nodes, edges, community clusters |
| `wiki_insights` | Find surprising cross-community connections + knowledge gaps |
| `wiki_lint` | Structural lint: orphaned pages, isolated nodes, broken links |

## Quick Start

```bash
cd mcp-server
npm install
npm run build
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/path/to/llm_wiki/mcp-server/dist/index.js"],
      "env": {
        "WIKI_PATH": "/path/to/your/wiki-project"
      }
    }
  }
}
```

### VS Code Copilot (`.vscode/mcp.json`)

```json
{
  "servers": {
    "llm-wiki": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/mcp-server/dist/index.js"],
      "env": { "WIKI_PATH": "${workspaceFolder}" }
    }
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WIKI_PATH` | Default project path (used when `project_path` not specified) | `process.cwd()` |
| `EMBEDDING_ENABLED` | Enable vector search via LanceDB | `false` |
| `EMBEDDING_MODEL` | Embedding model name (e.g. `text-embedding-3-small`) | — |
| `OPENAI_API_KEY` | API key for LLM + embedding calls | — |
| `SKILL_VERBOSE` | Set to `1` for verbose activity logging | — |

## Architecture

The MCP server runs entirely in Node.js without the Tauri desktop app. It replaces the Tauri IPC layer (`@/commands/fs`) with standard Node.js `fs` operations, making it suitable for headless server and CI/CD environments.

**Capabilities without Tauri**:
- ✅ `wiki_search` — BM25 keyword search
- ✅ `wiki_graph` — Louvain community detection
- ✅ `wiki_insights` — Surprising connections + knowledge gaps
- ✅ `wiki_lint` — Structural lint
- ⚠️ `wiki_search` with vector — requires `EMBEDDING_ENABLED=true` + configured API
- ❌ `ingest` — PDF/DOCX extraction not supported (use pre-converted Markdown)
