# Using llm-wiki with Hermes

Hermes Skill Runtime supports two integration styles for this project:

1. **Hermes Skill (CLI shell-out)** — the existing `SKILL.md` /
   `HERMES.md` model: Hermes loads the skill manifest, recognizes
   triggers, and shells out to `node skill/dist/cli.js …`.
2. **Hermes MCP client** — Hermes recent versions support MCP servers
   the same way Claude Desktop does.

## 1. Hermes Skill (CLI)

### Install

```bash
git clone https://github.com/toughhou/llm_wiki.git
cd llm_wiki
bash install.sh --platform hermes      # if you've set this up; otherwise:
cd skill && npm install && npm run build
```

The repo's root `SKILL.md` is the manifest Hermes reads. Trigger
phrases include "知识库", "wiki", "graph analysis", "deep research",
"知识图谱", etc.

### Environment

Export these before launching Hermes (or put them in your shell
profile):

```bash
export OPENAI_API_KEY=sk-...
export LLM_MODEL=gpt-4o-mini
export TAVILY_API_KEY=tvly-...      # for deep-research
export WIKI_OUTPUT_LANGUAGE=auto    # or English / Chinese / ...
```

### Use

In a Hermes session:

```
> 帮我把 ~/raw/paper.md 这篇论文消化进 ~/wiki 知识库
```

Hermes routes to the skill, which executes:

```bash
node /path/to/skill/dist/cli.js ingest ~/wiki ~/raw/paper.md
```

The JSON output (status, generated pages, review items, warnings) is
returned to Hermes for follow-up reasoning.

## 2. Hermes MCP

If your Hermes version supports MCP, register the server:

```yaml
# ~/.hermes/mcp.yaml  (path may vary by Hermes version)
servers:
  llm-wiki:
    command: node
    args: ["/absolute/path/to/llm_wiki/skill/dist/mcp-server.js"]
    env:
      WIKI_PATH: /Users/me/wiki
      OPENAI_API_KEY: sk-...
      LLM_MODEL: gpt-4o-mini
      TAVILY_API_KEY: tvly-...
```

The same 7 `wiki_*` tools become available as native Hermes tool
calls, exactly as in Claude Desktop / Cursor / Copilot Chat.

## Choosing between Skill and MCP

| If you want to ... | Use |
|---|---|
| Compose with shell pipelines, cron, makefiles | CLI / Skill |
| Have Hermes call typed tools with structured args | MCP |
| Run on systems without Node.js available to MCP host | CLI / Skill |
| Get streaming feedback in the agent UI | MCP |

Both routes hit the same `skill/src/lib/` core, so there's no feature
difference — pick whichever fits the workflow.
