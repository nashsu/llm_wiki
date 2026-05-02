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
import { autoIngest } from "./lib/ingest"
import { deepResearch } from "./lib/deep-research"

async function main() {
  const [, , command, ...args] = process.argv
  if (!command || command === "help" || command === "--help") { usage(); return }
  switch (command) {
    case "graph":         return cmdGraph(args)
    case "insights":      return cmdInsights(args)
    case "search":        return cmdSearch(args)
    case "status":        return cmdStatus(args)
    case "init":          return cmdInit(args)
    case "lint":          return cmdLint(args)
    case "ingest":        return cmdIngest(args)
    case "deep-research": return cmdDeepResearch(args)
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
  graph         <wiki_root>                  Build knowledge graph (outputs JSON)
  insights      <wiki_root>                  Show surprising connections + knowledge gaps
  search        <wiki_root> <query>          Keyword search (BM25+RRF)
  status        <wiki_root>                  Page count and type breakdown
  init          <wiki_root>                  Initialize wiki directory structure
  lint          <wiki_root>                  Check for broken links and orphan pages
  ingest        <wiki_root> <source_file>    Two-stage LLM ingest of a markdown/text source
  deep-research <wiki_root> <topic>          Web search → LLM synthesis → auto-ingest

ENV VARS:
  SKILL_VERBOSE=1                 Enable verbose activity logging
  WIKI_PATH                       Default project path for MCP server
  OPENAI_API_KEY / LLM_API_KEY    LLM credentials (required for ingest / deep-research)
  LLM_BASE_URL                    Custom OpenAI-compatible endpoint
  LLM_MODEL                       Model name (default: gpt-4o-mini)
  TAVILY_API_KEY                  Tavily search API (required for deep-research)
  WIKI_OUTPUT_LANGUAGE            auto | English | Chinese | Japanese | ...

EXAMPLES:
  llm-wiki graph ./my-project
  llm-wiki search ./my-project "attention mechanism"
  llm-wiki insights ./my-project
  llm-wiki ingest ./my-project ./raw/paper.md
  llm-wiki deep-research ./my-project "transformer architecture"
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

async function cmdIngest(args: string[]) {
  const [wikiRoot, sourceFile, ...rest] = args
  if (!wikiRoot || !sourceFile) {
    console.error("Usage: ingest <wiki_root> <source_file> [--folder=context]")
    process.exit(1)
  }
  const projectPath = path.resolve(wikiRoot)
  const sourcePath = path.resolve(sourceFile)
  if (!fs.existsSync(sourcePath)) {
    console.error(`Source file not found: ${sourcePath}`)
    process.exit(1)
  }
  const folderArg = rest.find((a) => a.startsWith("--folder="))
  const folderContext = folderArg ? folderArg.slice("--folder=".length) : undefined

  console.error(`Ingesting: ${sourcePath} → ${projectPath}`)
  const result = await autoIngest(projectPath, sourcePath, undefined, undefined, folderContext)
  if (result.cached) {
    console.error(`✓ cache HIT — ${result.writtenPaths.length} files unchanged`)
  } else {
    console.error(`✓ ingested — ${result.writtenPaths.length} files written, ${result.reviewItems.length} review item(s), ${result.warnings.length} warning(s)`)
  }
  process.stdout.write(JSON.stringify({
    status: result.hardFailures.length === 0 ? "success" : "partial",
    cached: result.cached,
    pages: result.writtenPaths,
    reviews_pending: result.reviewItems.length,
    reviews: result.reviewItems.map((r) => ({ type: r.type, title: r.title, description: r.description })),
    warnings: result.warnings,
    hard_failures: result.hardFailures,
  }, null, 2) + "\n")
}

async function cmdDeepResearch(args: string[]) {
  const [wikiRoot, ...rest] = args
  const queriesArg = rest.find((a) => a.startsWith("--queries="))
  const noIngest = rest.includes("--no-ingest")
  const topic = rest.filter((a) => !a.startsWith("--")).join(" ")
  if (!wikiRoot || !topic) {
    console.error("Usage: deep-research <wiki_root> <topic> [--queries=q1|q2|q3] [--no-ingest]")
    process.exit(1)
  }
  const projectPath = path.resolve(wikiRoot)
  const searchQueries = queriesArg
    ? queriesArg.slice("--queries=".length).split("|").map((s) => s.trim()).filter(Boolean)
    : undefined

  console.error(`Researching: "${topic}" → ${projectPath}`)
  const result = await deepResearch(projectPath, topic, {
    searchQueries,
    autoIngest: !noIngest,
  })
  console.error(`✓ saved ${result.savedPath} (${result.webResultCount} sources, ${result.ingestedFiles.length} pages ingested)`)
  process.stdout.write(JSON.stringify({
    status: "success",
    topic: result.topic,
    saved_path: result.savedPath,
    web_result_count: result.webResultCount,
    ingested: result.ingested,
    ingested_files: result.ingestedFiles,
    warnings: result.warnings,
  }, null, 2) + "\n")
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err)
  process.exit(1)
})
