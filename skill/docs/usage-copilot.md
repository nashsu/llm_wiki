# Using llm-wiki with VS Code GitHub Copilot Chat

GitHub Copilot Chat in VS Code supports MCP servers (Copilot Chat
≥ 0.27 with MCP enabled).

## Install

```bash
git clone https://github.com/toughhou/llm_wiki.git
cd llm_wiki/skill
npm install
npm run build
```

## Configure

Edit `.vscode/mcp.json` in your workspace (recommended) or the user-
level VS Code MCP config:

```json
{
  "servers": {
    "llm-wiki": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/skill/dist/mcp-server.js"],
      "env": {
        "WIKI_PATH": "${workspaceFolder}/.wiki",
        "OPENAI_API_KEY": "${env:OPENAI_API_KEY}",
        "LLM_MODEL": "gpt-4o-mini",
        "TAVILY_API_KEY": "${env:TAVILY_API_KEY}"
      }
    }
  }
}
```

`${env:VAR}` expansion lets you keep secrets in your shell environment
rather than the workspace settings file.

Reload VS Code. Open Copilot Chat → click the tools icon → enable the
`llm-wiki` server. You should see 7 `wiki_*` tools listed.

## Use

In Copilot Chat (Agent mode):

> "@workspace use the llm-wiki tools to ingest `docs/api-reference.md`,
> then show me the resulting wiki status."

Copilot Chat will:

1. Call `wiki_ingest` with `source_file=<absolute path>`
2. Call `wiki_status`
3. Format the responses into the chat reply.

## Notes for `@workspace` flows

- The MCP server's `WIKI_PATH` defaults to `process.cwd()`. When VS
  Code spawns the server it inherits the workspace cwd, so for a
  one-wiki-per-repo setup you can omit `WIKI_PATH` and just put a
  `wiki/` folder at the repo root.
- For multiple separate wikis, pass `project_path` explicitly in the
  prompt: *"Ingest X into the wiki at /Users/me/notes/work-wiki"*. The
  tool argument overrides the env-var default.

## Tool reference

`wiki_status`, `wiki_search`, `wiki_graph`, `wiki_insights`,
`wiki_lint`, `wiki_ingest`, `wiki_deep_research` — see
[`architecture.md`](./architecture.md).
