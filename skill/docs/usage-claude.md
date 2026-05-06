# Using llm-wiki with Claude

Two integration paths:

1. **Claude Desktop via MCP** — the recommended approach. Claude calls
   `wiki_*` tools natively in chat.
2. **Claude Code as a Skill** — drop-in `SKILL.md` discovery so
   Claude shells out to the CLI when it detects wiki-related intent.

---

## 1. Claude Desktop (MCP)

### Install

```bash
git clone https://github.com/toughhou/llm_wiki.git
cd llm_wiki/skill
npm install
npm run build
```

### Configure

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Restart Claude Desktop. You should see a 🔧 indicator showing the
`llm-wiki` server is connected with 7 tools.

### Available tools

| Tool | Purpose |
|---|---|
| `wiki_status` | Page count + type breakdown |
| `wiki_search` | BM25(+RRF) search |
| `wiki_graph` | Knowledge graph (Louvain communities) |
| `wiki_insights` | Surprising connections + knowledge gaps |
| `wiki_lint` | Find orphans / broken links |
| `wiki_ingest` | Two-stage LLM ingest of a source file |
| `wiki_deep_research` | Web search → synthesis → auto-ingest |

### Example prompts

> "Use wiki_status to tell me how big my knowledge base is."
>
> "Search the wiki for anything about transformers, then run insights to
> see what's missing."
>
> "Ingest the file `~/Downloads/attention-is-all-you-need.md` into my
> wiki."
>
> "Run deep research on 'sparse Mixture of Experts' and add it to the
> wiki."

---

## 2. Claude Code (Skill)

Claude Code looks for a `SKILL.md` at the repo root. The repo's
`SKILL.md` already declares the trigger conditions (knowledge base,
wiki, graph analysis, deep research) and lists the CLI commands.

### Install

```bash
cd llm_wiki/skill
npm install
npm run build
# Optionally, link globally so `llm-wiki` is on PATH:
npm link
```

### Use

In Claude Code:

```
> 帮我看一下 ~/notes/my-wiki 知识库的状态
```

Claude Code reads the `SKILL.md`, recognizes the trigger, and shells
out to:

```bash
node /path/to/skill/dist/cli.js status ~/notes/my-wiki
```

The output (page count, communities, type breakdown) is folded back
into Claude's context.

### CLI commands available to Claude Code

```
llm-wiki status        <wiki_root>
llm-wiki search        <wiki_root> <query>
llm-wiki graph         <wiki_root>
llm-wiki insights      <wiki_root>
llm-wiki lint          <wiki_root>
llm-wiki init          <wiki_root>
llm-wiki ingest        <wiki_root> <source_file>
llm-wiki deep-research <wiki_root> <topic>
```

---

## Troubleshooting

- **MCP tool not appearing**: check `~/Library/Logs/Claude/mcp-server-llm-wiki.log`
  for startup errors. The server logs `llm-wiki MCP server vX started`
  on success.
- **`No LLM configured`**: set `OPENAI_API_KEY` (or `LLM_API_KEY`) and
  `LLM_BASE_URL` in the `env` block, not just in your shell.
- **`No web search results`** during deep research: set `TAVILY_API_KEY`.
