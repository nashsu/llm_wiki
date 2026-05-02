# llm-wiki Skill + MCP — End-to-End Test Report

> Generated: 2026-05-02T10:37:32.647Z
> Fixture: `/tmp/llm-wiki-e2e-XPEWdX`
> Node: v20.20.2

## Methodology

All cases run **the real built CLI / MCP server** (`dist/cli.js`, `dist/mcp-server.js`)
against a real on-disk wiki fixture. LLM and Tavily traffic is served by
`dist/test-server/fake-llm-server.js`, a real local HTTP server that speaks the
OpenAI-compatible Chat Completions SSE protocol and the Tavily search REST
protocol — no code-level mocks. The skill code (`llm-client.ts`, `web-search.ts`)
runs unmodified and exercises real `fetch` / SSE parsing / JSON decoding.

## Summary: 19/19 passed

| # | Case | Exit | Status | Notes |
|---|------|------|--------|-------|
| 1 | init | 0 | ✅ pass |  |
| 2 | status | 0 | ✅ pass |  |
| 3 | search | 0 | ✅ pass |  |
| 4 | graph | 0 | ✅ pass |  |
| 5 | insights | 0 | ✅ pass |  |
| 6 | lint | 0 | ✅ pass |  |
| 7 | ingest | 0 | ✅ pass | All expected files written: wiki/sources/rnn-vs-transformer.md, wiki/concepts/recurrent-neural-network.md, wiki/entities/mamba.md |
| 8 | ingest (cache hit) | 0 | ✅ pass | Total LLM chat calls so far: 2 (cache hit should not increment beyond 2) |
| 9 | deep-research | 0 | ✅ pass | query files: research-mixture-of-experts-2026-05-02.md | mixture-of-experts page exists: true | final calls: chat=5, search=1 |
| 10 | mcp:initialize | 0 | ✅ pass |  |
| 11 | mcp:tools/list | 0 | ✅ pass | tools: wiki_status, wiki_search, wiki_graph, wiki_insights, wiki_lint, wiki_ingest, wiki_deep_research |
| 12 | mcp:wiki_status | 0 | ✅ pass |  |
| 13 | mcp:wiki_search | 0 | ✅ pass |  |
| 14 | mcp:wiki_graph | 0 | ✅ pass |  |
| 15 | mcp:wiki_insights | 0 | ✅ pass |  |
| 16 | mcp:wiki_lint | 0 | ✅ pass |  |
| 17 | mcp:wiki_ingest | 0 | ✅ pass |  |
| 18 | mcp:wiki_deep_research | 0 | ✅ pass |  |
| 19 | lint (post-ingest) | 0 | ✅ pass |  |

## Per-case detail

### init

```
$ node dist/cli.js init /tmp/llm-wiki-e2e-XPEWdX/project
```
**stdout (first 60 lines):**
```
✓ Initialized wiki at: /tmp/llm-wiki-e2e-XPEWdX/project

```

### status

```
$ node dist/cli.js status /tmp/llm-wiki-e2e-XPEWdX/project
```
**stdout (first 60 lines):**
```
Wiki: /tmp/llm-wiki-e2e-XPEWdX/project
Total pages: 6
Communities: 3
  concept: 2
  entity: 2
  overview: 1
  source: 1

```

### search

```
$ node dist/cli.js search /tmp/llm-wiki-e2e-XPEWdX/project attention
```
**stdout (first 60 lines):**
```
# Search: "attention"

## Attention Mechanism
**Path**: wiki/concepts/attention-mechanism.md | **Score**: 0.0164
--- type: concept title: Attention Mechanism created: 2026-04-01 updated: 2026-04-01 tags: [ml] related: [transfor...

## Transformer
**Path**: wiki/concepts/transformer.md | **Score**: 0.0161
...rmer created: 2026-04-01 updated: 2026-04-01 tags: [ml, architecture] related: [attention-mechanism, bert] sources: ["intro.md"] ---  # Transformer  The Transformer is a...

## Source: intro.md
**Path**: wiki/sources/intro.md | **Score**: 0.0159
...04-01 updated: 2026-04-01 sources: ["intro.md"] tags: [] related: [transformer, attention-mechanism] ---  # Source: intro.md  Introduces [[transformer]] and [[attention-...

## Index
**Path**: wiki/index.md | **Score**: 0.0156
...: Index type: overview ---  # Knowledge Base  ## Concepts - [[transformer]] - [[attention-mechanism]]  ## Entities - [[bert]] 

```
**stderr (first 30 lines):**
```
[search] "attention" | token:4 vector:0 → 4 results

```

### graph

```
$ node dist/cli.js graph /tmp/llm-wiki-e2e-XPEWdX/project
```
**stdout (first 60 lines):**
```
{
  "nodes": [
    {
      "id": "attention-mechanism",
      "label": "Attention Mechanism",
      "type": "concept",
      "path": "/tmp/llm-wiki-e2e-XPEWdX/project/wiki/concepts/attention-mechanism.md",
      "linkCount": 4,
      "community": 0
    },
    {
      "id": "transformer",
      "label": "Transformer",
      "type": "concept",
      "path": "/tmp/llm-wiki-e2e-XPEWdX/project/wiki/concepts/transformer.md",
      "linkCount": 6,
      "community": 0
    },
    {
      "id": "bert",
      "label": "BERT",
      "type": "entity",
      "path": "/tmp/llm-wiki-e2e-XPEWdX/project/wiki/entities/bert.md",
      "linkCount": 3,
      "community": 1
    },
    {
      "id": "orphan-thing",
      "label": "Orphan Thing",
      "type": "entity",
      "path": "/tmp/llm-wiki-e2e-XPEWdX/project/wiki/entities/orphan-thing.md",
      "linkCount": 0,
      "community": 2
    },
    {
      "id": "index",
      "label": "Index",
      "type": "overview",
      "path": "/tmp/llm-wiki-e2e-XPEWdX/project/wiki/index.md",
      "linkCount": 3,
      "community": 1
    },
    {
      "id": "intro",
      "label": "Source: intro.md",
      "type": "source",
      "path": "/tmp/llm-wiki-e2e-XPEWdX/project/wiki/sources/intro.md",
      "linkCount": 2,
      "community": 0
    }
  ],
  "edges": [
    {
      "source": "attention-mechanism",
      "target": "transformer",
      "weight": 14.329401401273703
    },
    {
      "source": "transformer",
      "target": "bert",
```
**stderr (first 30 lines):**
```
Building graph: /tmp/llm-wiki-e2e-XPEWdX/project

✓ 6 nodes, 7 edges, 3 communities

```

### insights

```
$ node dist/cli.js insights /tmp/llm-wiki-e2e-XPEWdX/project
```
**stdout (first 60 lines):**
```
# Wiki Insights

## Surprising Connections

### Transformer ↔ BERT
- **Score**: 4 | **Why**: crosses community boundary, different types

### Source: intro.md ↔ Transformer
- **Score**: 4 | **Why**: connects source to concept, peripheral node links to hub

### Source: intro.md ↔ Attention Mechanism
- **Score**: 4 | **Why**: connects source to concept, peripheral node links to hub

## Knowledge Gaps

### 1 isolated page
**Type**: isolated-node
Orphan Thing
💡 These pages have few or no connections. Consider adding [[wikilinks]] to related pages.

```

### lint

```
$ node dist/cli.js lint /tmp/llm-wiki-e2e-XPEWdX/project
```
**stdout (first 60 lines):**
```
[orphan] Orphan Thing (orphan-thing.md)

✓ 6 pages checked — 1 issue(s)

```

### ingest

```
$ node dist/cli.js ingest /tmp/llm-wiki-e2e-XPEWdX/project /tmp/llm-wiki-e2e-XPEWdX/raw/rnn-vs-transformer.md
```

**Notes**: All expected files written: wiki/sources/rnn-vs-transformer.md, wiki/concepts/recurrent-neural-network.md, wiki/entities/mamba.md

**stdout (first 60 lines):**
```
{
  "status": "success",
  "cached": false,
  "pages": [
    "wiki/sources/rnn-vs-transformer.md",
    "wiki/concepts/recurrent-neural-network.md",
    "wiki/entities/mamba.md",
    "wiki/log.md"
  ],
  "reviews_pending": 1,
  "reviews": [
    {
      "type": "suggestion",
      "title": "Add Linear Attention page",
      "description": "Linear attention deserves its own page."
    }
  ],
  "warnings": [],
  "hard_failures": []
}

```
**stderr (first 30 lines):**
```
Ingesting: /tmp/llm-wiki-e2e-XPEWdX/raw/rnn-vs-transformer.md → /tmp/llm-wiki-e2e-XPEWdX/project
✓ ingested — 4 files written, 1 review item(s), 0 warning(s)

```

### ingest (cache hit)

```
$ node dist/cli.js ingest /tmp/llm-wiki-e2e-XPEWdX/project /tmp/llm-wiki-e2e-XPEWdX/raw/rnn-vs-transformer.md
```

**Notes**: Total LLM chat calls so far: 2 (cache hit should not increment beyond 2)

**stdout (first 60 lines):**
```
{
  "status": "success",
  "cached": true,
  "pages": [
    "wiki/sources/rnn-vs-transformer.md",
    "wiki/concepts/recurrent-neural-network.md",
    "wiki/entities/mamba.md",
    "wiki/log.md"
  ],
  "reviews_pending": 0,
  "reviews": [],
  "warnings": [],
  "hard_failures": []
}

```
**stderr (first 30 lines):**
```
Ingesting: /tmp/llm-wiki-e2e-XPEWdX/raw/rnn-vs-transformer.md → /tmp/llm-wiki-e2e-XPEWdX/project
✓ cache HIT — 4 files unchanged

```

### deep-research

```
$ node dist/cli.js deep-research /tmp/llm-wiki-e2e-XPEWdX/project Mixture of Experts
```

**Notes**: query files: research-mixture-of-experts-2026-05-02.md | mixture-of-experts page exists: true | final calls: chat=5, search=1

**stdout (first 60 lines):**
```
{
  "status": "success",
  "topic": "Mixture of Experts",
  "saved_path": "wiki/queries/research-mixture-of-experts-2026-05-02.md",
  "web_result_count": 2,
  "ingested": true,
  "ingested_files": [
    "wiki/sources/research-mixture-of-experts-2026-05-02.md",
    "wiki/concepts/mixture-of-experts.md"
  ],
  "warnings": []
}

```
**stderr (first 30 lines):**
```
Researching: "Mixture of Experts" → /tmp/llm-wiki-e2e-XPEWdX/project
✓ saved wiki/queries/research-mixture-of-experts-2026-05-02.md (2 sources, 2 pages ingested)

```

### mcp:initialize

```
$ MCP initialize
```
**stdout (first 60 lines):**
```
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"llm-wiki","version":"0.4.6-mcp"}},"jsonrpc":"2.0","id":1}
```

### mcp:tools/list

```
$ MCP tools/list
```

**Notes**: tools: wiki_status, wiki_search, wiki_graph, wiki_insights, wiki_lint, wiki_ingest, wiki_deep_research

**stdout (first 60 lines):**
```
{"result":{"tools":[{"name":"wiki_status","description":"Get page count and type breakdown for a wiki project. Returns statistics about the knowledge base.","inputSchema":{"type":"object","properties":{"project_path":{"type":"string","description":"Absolute path to the wiki project directory (contains wiki/ subdirectory)"}},"required":[]}},{"name":"wiki_search","description":"Search wiki pages using BM25 keyword matching with optional vector search (RRF fusion). Returns ranked results with snippets.","inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"Search query (supports Chinese and English)"},"project_path":{"type":"string","description":"Path to wiki project (defaults to WIKI_PATH env var)"},"limit":{"type":"number","description":"Max results to return (default: 10)"}},"required":["query"]}},{"name":"wiki_graph","description":"Build knowledge graph from wiki pages: wikilinks, type-based edges, Louvain community detection. Returns nodes, edges, and community clusters.","inputSchema":{"type":"object","properties":{"project_path":{"type":"string","description":"Path to wiki project"},"format":{"type":"string","enum":["json","summary"],"description":"Output format: 'json' for full graph data, 'summary' for human-readable overview (default: summary)"}},"required":[]}},{"name":"wiki_insights","description":"Analyze wiki graph structure to find surprising cross-community connections and knowledge gaps (isolated pages, sparse clusters, bridge nodes).","inputSchema":{"type":"object","properties":{"project_path":{"type":"string","description":"Path to wiki project"},"max_connections":{"type":"number","description":"Max surprising connections to return (default: 5)"},"max_gaps":{"type":"number","description":"Max knowledge gaps to return (default: 8)"}},"required":[]}},{"name":"wiki_lint","description":"Structural lint of wiki pages: find orphaned pages (no links), no-outlinks, and connectivity issues.","inputSchema":{"type":"object","prop
```

### mcp:wiki_status

```
$ MCP tools/call wiki_status
```
**stdout (first 60 lines):**
```
{"result":{"content":[{"type":"text","text":"Wiki: /tmp/llm-wiki-e2e-XPEWdX/project\nTotal pages: 12\nCommunities: 5\n  concept: 4\n  entity: 3\n  source: 3\n  overview: 1\n  other: 1"}]},"jsonrpc":"2.0","id":3}
```

### mcp:wiki_search

```
$ MCP tools/call wiki_search
```
**stdout (first 60 lines):**
```
{"result":{"content":[{"type":"text","text":"# Search: \"transformer\"\n\n## Transformer\n**Path**: wiki/concepts/transformer.md | **Score**: 0.0164\n--- type: concept title: Transformer created: 2026-04-01 updated: 2026-04-01 tags: [ml, architecture] related: [atte...\n\n## Source: rnn-vs-transformer.md\n**Path**: wiki/sources/rnn-vs-transformer.md | **Score**: 0.0161\n--- type: source title: \"Source: rnn-vs-transformer.md\" created: 2026-05-02 updated: 2026-05-02 sources: [\"rnn-vs-transformer.md\"] ...\n\n## Recurrent Neural Network\n**Path**: wiki/concepts/recurrent-neural-network.md | **Score**: 0.0159\n...work created: 2026-05-02 updated: 2026-05-02 tags: [ml, architecture] related: [transformer] sources: [\"rnn-vs-transformer.md\"] ---  # Recurrent Neural Network  RNNs proce...\n\n## Research: Mixture of Experts\n**Path**: wiki/queries/research-mixture-of-experts-2026-05-02.md | **Score**: 0.0156\n...(MoE)  MoE architectures route tokens to specialized expert sub-networks [1]. [[transformer]] models like Switch Transformer demonstrate sparse expert routing [2].   ## Re...\n\n## Attention Mechanism\n**Path**: wiki/concepts/attention-mechanism.md | **Score**: 0.0154\n...ttention Mechanism created: 2026-04-01 updated: 2026-04-01 tags: [ml] related: [transformer] sources: [\"intro.md\"] ---  # Attention Mechanism  Attention lets a model focus...\n\n## Mixture of Experts\n**Path**: wiki/concepts/mixture-of-experts.md | **Score**: 0.0152\n...Mixture of Experts created: 2026-05-02 updated: 2026-05-02 tags: [ml] related: [transformer] sources: [\"research-mixture-of-experts-2026-05-02.md\"] --- # Mixture of Expert...\n\n## BERT\n**Path**: wiki/entities/bert.md | **Score**: 0.0149\n...title: BERT created: 2026-04-02 updated: 2026-04-02 tags: [ml, model] related: [transformer] sources: [\"bert-paper.md\"] ---  # BERT  BERT is a [[transformer]]-based langua...\n\n## Mamba\n**Path**: wiki/entities/mamba.md | **Score**: 0.0147\n...05-02 updated: 2026-05-02 tags: [ml, mod
```

### mcp:wiki_graph

```
$ MCP tools/call wiki_graph
```
**stdout (first 60 lines):**
```
{"result":{"content":[{"type":"text","text":"# Knowledge Graph Summary\n\n**Nodes**: 12 | **Edges**: 13 | **Communities**: 5\n\n## Node Types\n- concept: 4\n- entity: 3\n- source: 3\n- overview: 1\n- other: 1\n\n## Top Communities\n### Community 1 (6 pages, cohesion: 0.53)\nKey pages: Transformer, Attention Mechanism, BERT, Index, Source: intro.md\n### Community 2 (3 pages, cohesion: 1.00)\nKey pages: Recurrent Neural Network, Source: rnn-vs-transformer.md, Mamba\n### Community 3 (1 pages, cohesion: 0.00)\nKey pages: Orphan Thing\n### Community 4 (1 pages, cohesion: 0.00)\nKey pages: log\n### Community 5 (1 pages, cohesion: 0.00)\nKey pages: Source: MoE research\n\n## Top Hubs (by link count)\n- Transformer (concept, 9 links)\n- Attention Mechanism (concept, 4 links)\n- Recurrent Neural Network (concept, 3 links)\n- BERT (entity, 3 links)\n- Index (overview, 3 links)\n- Source: rnn-vs-transformer.md (source, 3 links)\n- Mamba (entity, 2 links)\n- Source: intro.md (source, 2 links)\n- Mixture of Experts (concept, 1 links)\n- Orphan Thing (entity, 0 links)"}]},"jsonrpc":"2.0","id":5}
```

### mcp:wiki_insights

```
$ MCP tools/call wiki_insights
```
**stdout (first 60 lines):**
```
{"result":{"content":[{"type":"text","text":"# Wiki Insights\n\n## Surprising Connections\n\n### Source: rnn-vs-transformer.md ↔ Transformer\n- Score: 5 | crosses community boundary, connects source to concept\n\n### Source: intro.md ↔ Transformer\n- Score: 4 | connects source to concept, peripheral node links to hub\n\n### Recurrent Neural Network ↔ Transformer\n- Score: 3 | crosses community boundary\n\n## Knowledge Gaps\n\n### 3 isolated pages\nMixture of Experts, Orphan Thing, Source: MoE research\n💡 These pages have few or no connections. Consider adding [[wikilinks]] to related pages.\n"}]},"jsonrpc":"2.0","id":6}
```

### mcp:wiki_lint

```
$ MCP tools/call wiki_lint
```
**stdout (first 60 lines):**
```
{"result":{"content":[{"type":"text","text":"Found 3 issue(s) in 12 pages:\n\n[isolated] Mixture of Experts — only 1 link(s)\n[orphan] Orphan Thing (orphan-thing.md)\n[orphan] Source: MoE research (research-mixture-of-experts-2026-05-02.md)"}]},"jsonrpc":"2.0","id":7}
```

### mcp:wiki_ingest

```
$ MCP tools/call wiki_ingest
```
**stdout (first 60 lines):**
```
{"result":{"content":[{"type":"text","text":"✓ Ingested \"moe-deep-dive.md\" — 1 files written\n  - wiki/sources/moe-deep-dive.md"}]},"jsonrpc":"2.0","id":8}
```

### mcp:wiki_deep_research

```
$ MCP tools/call wiki_deep_research
```
**stdout (first 60 lines):**
```
{"result":{"content":[{"type":"text","text":"✓ Deep research on \"RLHF\" complete\n  Saved: wiki/queries/research-rlhf-2026-05-02.md\n  Web results: 1\n  Auto-ingested 2 wiki page(s)\n    - wiki/sources/research-rlhf-2026-05-02.md\n    - wiki/concepts/rlhf.md"}]},"jsonrpc":"2.0","id":9}
```

### lint (post-ingest)

```
$ node dist/cli.js lint /tmp/llm-wiki-e2e-XPEWdX/project
```
**stdout (first 60 lines):**
```
[isolated] RLHF — 1 link(s)
[orphan] Orphan Thing (orphan-thing.md)
[orphan] Source: MoE research (research-mixture-of-experts-2026-05-02.md)
[orphan] Source: RLHF research (research-rlhf-2026-05-02.md)
[isolated] Source: MoE deep dive — 1 link(s)

✓ 15 pages checked — 5 issue(s)

```

## Final wiki snapshot (file tree)

```
wiki/
  concepts/
    attention-mechanism.md
    mixture-of-experts.md
    recurrent-neural-network.md
    rlhf.md
    transformer.md
  entities/
    bert.md
    mamba.md
    orphan-thing.md
  index.md
  log.md
  queries/
    research-mixture-of-experts-2026-05-02.md
    research-rlhf-2026-05-02.md
  sources/
    intro.md
    moe-deep-dive.md
    research-mixture-of-experts-2026-05-02.md
    research-rlhf-2026-05-02.md
    rnn-vs-transformer.md
  synthesis/
```
