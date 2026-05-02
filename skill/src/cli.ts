#!/usr/bin/env node
/**
 * llm-wiki-nashsu CLI
 *
 * Entry point for the nashsu/llm_wiki backend skill (no GUI).
 * Replaces Tauri IPC with Node.js fs, React stores with module state.
 *
 * Usage:
 *   node cli.js <command> <wiki_root> [args...]
 *
 * Commands:
 *   init <wiki_root> [topic] [lang]
 *   graph <wiki_root> [--output=graph-data.json]
 *   insights <wiki_root>
 *   search <wiki_root> <query> [--limit=20]
 *   status <wiki_root>
 *   lint <wiki_root>                    (requires LLM)
 *   ingest <wiki_root> <file_path>      (requires LLM)
 *   deep-research <wiki_root> <topic>   (requires LLM + search API)
 *   sweep-reviews <wiki_root>           (requires LLM)
 */

import * as fs from "fs"
import * as path from "path"
// Import core library modules (Tauri deps patched via tsconfig paths)
import { buildWikiGraph } from "../../src/lib/wiki-graph"
import { findSurprisingConnections, detectKnowledgeGaps } from "../../src/lib/graph-insights"
import { searchWiki } from "../../src/lib/search"
import { configureWikiStore } from "./stores-node"

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async function main() {
  const [, , command, wikiRoot, ...rest] = process.argv

  if (!command || command === "--help" || command === "-h") {
    printHelp()
    process.exit(0)
  }

  if (command === "--version") {
    console.log("0.4.6-skill")
    process.exit(0)
  }

  if (!wikiRoot) {
    console.error("Error: wiki_root is required")
    process.exit(1)
  }

  const resolvedRoot = path.resolve(wikiRoot)

  // Configure store state (replaces React store initialization)
  configureWikiStore({
    projectPath: resolvedRoot,
    llmConfig: {
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY ?? "",
      model: process.env.LLM_MODEL ?? "gpt-4o",
      baseUrl: process.env.OPENAI_API_BASE,
    },
    embeddingConfig: {
      enabled: !!(process.env.EMBEDDING_MODEL),
      model: process.env.EMBEDDING_MODEL ?? "",
      apiBase: process.env.EMBEDDING_API_BASE,
    },
  })

  switch (command) {
    case "init":
      await cmdInit(resolvedRoot, rest[0] ?? "My Knowledge Base", rest[1] ?? "en")
      break

    case "graph":
      await cmdGraph(resolvedRoot, rest)
      break

    case "insights":
      await cmdInsights(resolvedRoot)
      break

    case "search":
      if (!rest[0]) { console.error("Error: query is required"); process.exit(1) }
      await cmdSearch(resolvedRoot, rest[0], rest)
      break

    case "status":
      await cmdStatus(resolvedRoot)
      break

    default:
      console.error(`Unknown command: ${command}`)
      console.error("Run with --help for usage")
      process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(wikiRoot: string, topic: string, lang: string) {
  const dirs = ["wiki/entities", "wiki/concepts", "wiki/sources", "wiki/queries", "raw"]
  for (const d of dirs) {
    fs.mkdirSync(path.join(wikiRoot, d), { recursive: true })
  }

  const indexContent = `---
type: overview
title: "${topic}"
lang: ${lang}
created: ${new Date().toISOString().slice(0, 10)}
---

# ${topic}

> 这是一个 llm-wiki-nashsu 知识库。

## 实体

## 概念

## 素材来源
`
  const indexPath = path.join(wikiRoot, "wiki", "index.md")
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, indexContent, "utf-8")
  }

  const configPath = path.join(wikiRoot, ".wiki-config.json")
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ topic, lang, version: "0.4.6-skill" }, null, 2))
  }

  console.log(JSON.stringify({ status: "success", wiki_root: wikiRoot, topic, lang }))
}

async function cmdGraph(wikiRoot: string, args: string[]) {
  const outputArg = args.find((a) => a.startsWith("--output="))
  const outputPath = outputArg
    ? outputArg.replace("--output=", "")
    : path.join(wikiRoot, "graph-data.json")

  console.error(`[graph] Building wiki graph for: ${wikiRoot}`)
  const { nodes, edges, communities } = await buildWikiGraph(wikiRoot)
  console.error(`[graph] Found ${nodes.length} nodes, ${edges.length} edges, ${communities.length} communities`)

  const graphData = {
    nodes,
    edges,
    communities,
    generated: new Date().toISOString(),
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(graphData, null, 2))
  console.log(JSON.stringify({ status: "success", output: outputPath, ...graphData }))
}

async function cmdInsights(wikiRoot: string) {
  console.error(`[insights] Analyzing graph for: ${wikiRoot}`)
  const { nodes, edges, communities } = await buildWikiGraph(wikiRoot)

  const surprising = findSurprisingConnections(nodes, edges, communities, 10)
  const gaps = detectKnowledgeGaps(nodes, edges, communities, 10)

  // Format as markdown report
  const lines: string[] = [
    "# 图谱洞察报告",
    "",
    `> 生成时间：${new Date().toISOString().slice(0, 16)}`,
    `> 节点总数：${nodes.length}，边总数：${edges.length}，社区总数：${communities.length}`,
    "",
    "---",
    "",
    "## 惊人连接（Surprising Connections）",
    "",
  ]

  if (surprising.length === 0) {
    lines.push("_暂无惊人连接。随着知识库增长，跨社区连接会在这里显示。_")
  } else {
    for (const conn of surprising) {
      lines.push(`### ${conn.source.label} ↔ ${conn.target.label}`)
      lines.push(`- **惊喜评分**：${conn.score}`)
      lines.push(`- **原因**：${conn.reasons.join("；")}`)
      lines.push("")
    }
  }

  lines.push("---", "", "## 知识缺口（Knowledge Gaps）", "")

  if (gaps.length === 0) {
    lines.push("_暂无知识缺口。知识库连接良好！_")
  } else {
    for (const gap of gaps) {
      const typeLabel = {
        "isolated-node": "🔴 孤立节点",
        "sparse-community": "🟡 稀疏社区",
        "bridge-node": "🔵 桥节点",
      }[gap.type] ?? gap.type
      lines.push(`### ${typeLabel}：${gap.title}`)
      lines.push(`- **描述**：${gap.description}`)
      lines.push(`- **建议**：${gap.suggestion}`)
      lines.push("")
    }
  }

  lines.push("---", "", "## 社区凝聚度", "")
  for (const comm of communities) {
    const warning = comm.cohesion < 0.15 ? " ⚠️ 低凝聚度" : ""
    lines.push(
      `- **社区 ${comm.id}**（${comm.nodeCount} 个页面）：` +
      `凝聚度 ${comm.cohesion.toFixed(2)}${warning}` +
      ` — ${comm.topNodes.slice(0, 3).join("、")}`,
    )
  }

  const report = lines.join("\n")
  console.log(report)
}

async function cmdSearch(wikiRoot: string, query: string, args: string[]) {
  const limitArg = args.find((a) => a.startsWith("--limit="))
  const _limit = limitArg ? parseInt(limitArg.replace("--limit=", ""), 10) : 20

  console.error(`[search] Searching "${query}" in: ${wikiRoot}`)
  const results = await searchWiki(wikiRoot, query)

  console.log(JSON.stringify({ query, results, total: results.length }))
}

async function cmdStatus(wikiRoot: string) {
  const wikiDir = path.join(wikiRoot, "wiki")
  if (!fs.existsSync(wikiDir)) {
    console.log(JSON.stringify({ status: "not_initialized", wiki_root: wikiRoot }))
    return
  }

  function countMd(dir: string): number {
    if (!fs.existsSync(dir)) return 0
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .length
  }

  const stats = {
    status: "ready",
    wiki_root: wikiRoot,
    entities: countMd(path.join(wikiDir, "entities")),
    concepts: countMd(path.join(wikiDir, "concepts")),
    sources: countMd(path.join(wikiDir, "sources")),
    queries: countMd(path.join(wikiDir, "queries")),
    total: 0,
  }
  stats.total = stats.entities + stats.concepts + stats.sources + stats.queries

  console.log(JSON.stringify(stats))
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
llm-wiki-nashsu v0.4.6-skill
nashsu/llm_wiki backend extracted as Node.js CLI skill (no GUI)

USAGE:
  node cli.js <command> <wiki_root> [options]

COMMANDS:
  init <wiki_root> [topic] [lang]          Initialize knowledge base
  graph <wiki_root> [--output=<path>]      Build graph data (JSON)
  insights <wiki_root>                     Graph insights (markdown)
  search <wiki_root> <query> [--limit=N]   Hybrid BM25+vector search
  status <wiki_root>                       Knowledge base statistics

  (Requires LLM config via env vars:)
  ingest <wiki_root> <file_path>           Ingest document
  sweep-reviews <wiki_root>               Process review queue
  deep-research <wiki_root> <topic>       Deep research via web search

ENVIRONMENT VARIABLES:
  OPENAI_API_KEY      LLM API key
  OPENAI_API_BASE     Custom LLM endpoint (Ollama/proxy)
  LLM_MODEL           Model name (default: gpt-4o)
  EMBEDDING_API_BASE  Embedding endpoint (enables vector search)
  EMBEDDING_MODEL     Embedding model
  TAVILY_API_KEY      Web search API key (for deep-research)
`)
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Error:", err.message)
  process.exit(1)
})
