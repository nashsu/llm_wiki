#!/usr/bin/env node
/**
 * llm-wiki CLI — nashsu/llm_wiki backend as a standalone Node.js tool
 *
 * Commands:
 *   graph    <wiki_root>            Build graph JSON (nodes, edges, communities)
 *   insights <wiki_root>            Show surprising connections + knowledge gaps
 *   search   <wiki_root> <query>    BM25+RRF search across wiki pages
 *   status   <wiki_root>            Page count statistics by type
 *   init     <wiki_root>            Create wiki directory structure
 *   lint     <wiki_root>            Structural lint (broken links, orphans)
 */
import * as path from "path"
import * as fs from "fs"
import { buildWikiGraph } from "./lib/wiki-graph"
import { findSurprisingConnections, detectKnowledgeGaps } from "./lib/graph-insights"
import { searchWiki } from "./lib/search"

async function main() {
  const [, , command, ...args] = process.argv
  if (!command || command === "help" || command === "--help") { usage(); return }
  switch (command) {
    case "graph":    return cmdGraph(args)
    case "insights": return cmdInsights(args)
    case "search":   return cmdSearch(args)
    case "status":   return cmdStatus(args)
    case "init":     return cmdInit(args)
    case "lint":     return cmdLint(args)
    default:
      console.error(`Unknown command: ${command}`)
      usage()
      process.exit(1)
  }
}

function usage() {
  console.log(`
llm-wiki — nashsu/llm_wiki backend skill (no Tauri/GUI)

USAGE:
  llm-wiki <command> <wiki_root> [options]

COMMANDS:
  graph    <wiki_root>            Build knowledge graph (outputs JSON)
  insights <wiki_root>            Show surprising connections + knowledge gaps
  search   <wiki_root> <query>    Keyword search (BM25+RRF)
  status   <wiki_root>            Page count and type breakdown
  init     <wiki_root>            Initialize wiki directory structure
  lint     <wiki_root>            Check for broken links and orphan pages

ENV VARS:
  SKILL_VERBOSE=1                 Enable verbose activity logging
  WIKI_PATH                       Default project path for MCP server

EXAMPLES:
  llm-wiki graph ./my-project
  llm-wiki search ./my-project "attention mechanism"
  llm-wiki insights ./my-project
`.trim())
}

async function cmdGraph(args: string[]) {
  const wikiRoot = args[0]
  if (!wikiRoot) { console.error("Usage: graph <wiki_root>"); process.exit(1) }
  const projectPath = path.resolve(wikiRoot)
  console.error(`Building graph: ${projectPath}`)
  const result = await buildWikiGraph(projectPath)
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  console.error(`\n✓ ${result.nodes.length} nodes, ${result.edges.length} edges, ${result.communities.length} communities`)
}

async function cmdInsights(args: string[]) {
  const wikiRoot = args[0]
  if (!wikiRoot) { console.error("Usage: insights <wiki_root>"); process.exit(1) }
  const projectPath = path.resolve(wikiRoot)
  const { nodes, edges, communities } = await buildWikiGraph(projectPath)
  const connections = findSurprisingConnections(nodes, edges, communities, 10)
  const gaps = detectKnowledgeGaps(nodes, edges, communities, 8)
  const lines: string[] = ["# Wiki Insights\n", "## Surprising Connections\n"]
  if (connections.length === 0) lines.push("_No surprising connections found (need more linked pages)._\n")
  for (const c of connections) {
    lines.push(`### ${c.source.label} ↔ ${c.target.label}`)
    lines.push(`- **Score**: ${c.score} | **Why**: ${c.reasons.join(", ")}\n`)
  }
  lines.push("## Knowledge Gaps\n")
  if (gaps.length === 0) lines.push("_No knowledge gaps detected._\n")
  for (const g of gaps) {
    lines.push(`### ${g.title}`)
    lines.push(`**Type**: ${g.type}\n${g.description}`)
    lines.push(`💡 ${g.suggestion}\n`)
  }
  process.stdout.write(lines.join("\n"))
}

async function cmdSearch(args: string[]) {
  const [wikiRoot, ...queryParts] = args
  const query = queryParts.join(" ")
  if (!wikiRoot || !query) { console.error("Usage: search <wiki_root> <query>"); process.exit(1) }
  const projectPath = path.resolve(wikiRoot)
  const results = await searchWiki(projectPath, query)
  if (results.length === 0) { console.log(`No results for: "${query}"`); return }
  const lines: string[] = [`# Search: "${query}"\n`]
  for (const r of results) {
    const relPath = path.relative(projectPath, r.path)
    lines.push(`## ${r.title}`)
    lines.push(`**Path**: ${relPath} | **Score**: ${r.score.toFixed(4)}`)
    lines.push(r.snippet + "\n")
  }
  process.stdout.write(lines.join("\n"))
}

async function cmdStatus(args: string[]) {
  const wikiRoot = args[0]
  if (!wikiRoot) { console.error("Usage: status <wiki_root>"); process.exit(1) }
  const projectPath = path.resolve(wikiRoot)
  const { nodes, communities } = await buildWikiGraph(projectPath)
  const typeCounts: Record<string, number> = {}
  for (const n of nodes) typeCounts[n.type] = (typeCounts[n.type] ?? 0) + 1
  console.log(`Wiki: ${projectPath}\nTotal pages: ${nodes.length}\nCommunities: ${communities.length}`)
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`)
  }
}

async function cmdInit(args: string[]) {
  const wikiRoot = args[0]
  if (!wikiRoot) { console.error("Usage: init <wiki_root>"); process.exit(1) }
  const projectPath = path.resolve(wikiRoot)
  const dirs = ["wiki/entities", "wiki/concepts", "wiki/sources", "wiki/synthesis", "wiki/queries"]
  for (const dir of dirs) fs.mkdirSync(path.join(projectPath, dir), { recursive: true })
  const indexPath = path.join(projectPath, "wiki/index.md")
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, ["---", "title: Index", "type: overview", "---", "", "# Knowledge Base", "", "Welcome to your wiki.", ""].join("\n"))
  }
  console.log(`✓ Initialized wiki at: ${projectPath}`)
}

async function cmdLint(args: string[]) {
  const wikiRoot = args[0]
  if (!wikiRoot) { console.error("Usage: lint <wiki_root>"); process.exit(1) }
  const projectPath = path.resolve(wikiRoot)
  const { nodes, edges } = await buildWikiGraph(projectPath)
  if (nodes.length === 0) { console.log("No wiki pages found."); return }
  const edgeTargets = new Set(edges.map((e) => e.target))
  const edgeSources = new Set(edges.map((e) => e.source))
  const allLinked = new Set([...edgeTargets, ...edgeSources])
  let issues = 0
  for (const n of nodes) {
    if (n.id === "index" || n.id === "log" || n.id === "overview") continue
    if (!allLinked.has(n.id)) { console.log(`[orphan] ${n.label} (${n.id}.md)`); issues++ }
    else if (n.linkCount <= 1) { console.log(`[isolated] ${n.label} — ${n.linkCount} link(s)`); issues++ }
  }
  console.log(`\n✓ ${nodes.length} pages checked — ${issues} issue(s)`)
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err)
  process.exit(1)
})
