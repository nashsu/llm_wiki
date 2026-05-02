#!/usr/bin/env node
/**
 * llm-wiki MCP Server
 *
 * Exposes nashsu/llm_wiki backend operations as Model Context Protocol tools.
 * Works with Claude Desktop, VS Code Copilot, and any MCP-compatible host.
 *
 * Tools:
 *   wiki_status   — Page count and type breakdown for a project
 *   wiki_search   — BM25 keyword search (+ optional vector via EMBEDDING_ENABLED)
 *   wiki_graph    — Build knowledge graph (nodes, edges, Louvain communities)
 *   wiki_insights — Surprising connections and knowledge gaps analysis
 *   wiki_lint     — Structural lint: orphans, no-outlinks, broken links
 *
 * Usage:
 *   node dist/index.js
 *   WIKI_PATH=/path/to/project node dist/index.js  (default project path)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"

import * as path from "path"
import { buildWikiGraph } from "./lib/wiki-graph"
import { findSurprisingConnections, detectKnowledgeGaps } from "./lib/graph-insights"
import { searchWiki } from "./lib/search"

const DEFAULT_WIKI_PATH = process.env.WIKI_PATH ?? process.cwd()
const PKG_VERSION = "0.4.6-mcp"

const server = new Server(
  { name: "llm-wiki", version: PKG_VERSION },
  { capabilities: { tools: {} } },
)

// ── Tool definitions ──────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wiki_status",
      description: "Get page count and type breakdown for a wiki project. Returns statistics about the knowledge base.",
      inputSchema: {
        type: "object",
        properties: {
          project_path: {
            type: "string",
            description: "Absolute path to the wiki project directory (contains wiki/ subdirectory)",
          },
        },
        required: [],
      },
    },
    {
      name: "wiki_search",
      description: "Search wiki pages using BM25 keyword matching with optional vector search (RRF fusion). Returns ranked results with snippets.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (supports Chinese and English)" },
          project_path: { type: "string", description: "Path to wiki project (defaults to WIKI_PATH env var)" },
          limit: { type: "number", description: "Max results to return (default: 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "wiki_graph",
      description: "Build knowledge graph from wiki pages: wikilinks, type-based edges, Louvain community detection. Returns nodes, edges, and community clusters.",
      inputSchema: {
        type: "object",
        properties: {
          project_path: { type: "string", description: "Path to wiki project" },
          format: {
            type: "string",
            enum: ["json", "summary"],
            description: "Output format: 'json' for full graph data, 'summary' for human-readable overview (default: summary)",
          },
        },
        required: [],
      },
    },
    {
      name: "wiki_insights",
      description: "Analyze wiki graph structure to find surprising cross-community connections and knowledge gaps (isolated pages, sparse clusters, bridge nodes).",
      inputSchema: {
        type: "object",
        properties: {
          project_path: { type: "string", description: "Path to wiki project" },
          max_connections: { type: "number", description: "Max surprising connections to return (default: 5)" },
          max_gaps: { type: "number", description: "Max knowledge gaps to return (default: 8)" },
        },
        required: [],
      },
    },
    {
      name: "wiki_lint",
      description: "Structural lint of wiki pages: find orphaned pages (no links), no-outlinks, and connectivity issues.",
      inputSchema: {
        type: "object",
        properties: {
          project_path: { type: "string", description: "Path to wiki project" },
        },
        required: [],
      },
    },
  ],
}))

// ── Tool handlers ─────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  const projectPath = path.resolve((args.project_path as string | undefined) ?? DEFAULT_WIKI_PATH)

  try {
    switch (name) {
      case "wiki_status": {
        const { nodes, communities } = await buildWikiGraph(projectPath)
        const typeCounts: Record<string, number> = {}
        for (const n of nodes) typeCounts[n.type] = (typeCounts[n.type] ?? 0) + 1
        const summary = [
          `Wiki: ${projectPath}`,
          `Total pages: ${nodes.length}`,
          `Communities: ${communities.length}`,
          ...Object.entries(typeCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([t, c]) => `  ${t}: ${c}`),
        ].join("\n")
        return { content: [{ type: "text", text: summary }] }
      }

      case "wiki_search": {
        if (!args.query) throw new McpError(ErrorCode.InvalidParams, "query is required")
        const results = await searchWiki(projectPath, args.query as string)
        const limit = typeof args.limit === "number" ? args.limit : 10
        const top = results.slice(0, limit)
        if (top.length === 0) {
          return { content: [{ type: "text", text: `No results for: "${args.query}"` }] }
        }
        const lines = [`# Search: "${args.query}"\n`]
        for (const r of top) {
          const relPath = path.relative(projectPath, r.path)
          lines.push(`## ${r.title}`)
          lines.push(`**Path**: ${relPath} | **Score**: ${r.score.toFixed(4)}`)
          lines.push(r.snippet)
          lines.push("")
        }
        return { content: [{ type: "text", text: lines.join("\n") }] }
      }

      case "wiki_graph": {
        const graphData = await buildWikiGraph(projectPath)
        const format = (args.format as string | undefined) ?? "summary"
        if (format === "json") {
          return { content: [{ type: "text", text: JSON.stringify(graphData, null, 2) }] }
        }
        // Summary format
        const { nodes, edges, communities } = graphData
        const typeCounts: Record<string, number> = {}
        for (const n of nodes) typeCounts[n.type] = (typeCounts[n.type] ?? 0) + 1
        const lines = [
          `# Knowledge Graph Summary`,
          ``,
          `**Nodes**: ${nodes.length} | **Edges**: ${edges.length} | **Communities**: ${communities.length}`,
          ``,
          `## Node Types`,
          ...Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `- ${t}: ${c}`),
          ``,
          `## Top Communities`,
          ...communities.slice(0, 5).map((c, i) =>
            `### Community ${i + 1} (${c.nodeCount} pages, cohesion: ${c.cohesion.toFixed(2)})\nKey pages: ${c.topNodes.join(", ")}`
          ),
          ``,
          `## Top Hubs (by link count)`,
          ...nodes.sort((a, b) => b.linkCount - a.linkCount).slice(0, 10)
            .map((n) => `- ${n.label} (${n.type}, ${n.linkCount} links)`),
        ]
        return { content: [{ type: "text", text: lines.join("\n") }] }
      }

      case "wiki_insights": {
        const { nodes, edges, communities } = await buildWikiGraph(projectPath)
        const maxConn = typeof args.max_connections === "number" ? args.max_connections : 5
        const maxGaps = typeof args.max_gaps === "number" ? args.max_gaps : 8
        const connections = findSurprisingConnections(nodes, edges, communities, maxConn)
        const gaps = detectKnowledgeGaps(nodes, edges, communities, maxGaps)

        const lines = [`# Wiki Insights\n`, `## Surprising Connections\n`]
        if (connections.length === 0) lines.push("_No surprising connections found yet._\n")
        for (const c of connections) {
          lines.push(`### ${c.source.label} ↔ ${c.target.label}`)
          lines.push(`- Score: ${c.score} | ${c.reasons.join(", ")}\n`)
        }
        lines.push(`## Knowledge Gaps\n`)
        if (gaps.length === 0) lines.push("_No gaps detected._\n")
        for (const g of gaps) {
          lines.push(`### ${g.title}`)
          lines.push(`${g.description}`)
          lines.push(`💡 ${g.suggestion}\n`)
        }
        return { content: [{ type: "text", text: lines.join("\n") }] }
      }

      case "wiki_lint": {
        const { nodes, edges } = await buildWikiGraph(projectPath)
        if (nodes.length === 0) {
          return { content: [{ type: "text", text: "No wiki pages found." }] }
        }
        const edgeTargets = new Set(edges.map((e) => e.target))
        const edgeSources = new Set(edges.map((e) => e.source))
        const allLinked = new Set([...edgeTargets, ...edgeSources])
        const issues: string[] = []
        for (const n of nodes) {
          if (n.id === "index" || n.id === "log" || n.id === "overview") continue
          if (!allLinked.has(n.id)) issues.push(`[orphan] ${n.label} (${n.id}.md)`)
          else if (n.linkCount <= 1) issues.push(`[isolated] ${n.label} — only ${n.linkCount} link(s)`)
        }
        const text = issues.length === 0
          ? `✓ All ${nodes.length} pages are properly connected.`
          : `Found ${issues.length} issue(s) in ${nodes.length} pages:\n\n${issues.join("\n")}`
        return { content: [{ type: "text", text: text }] }
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
    }
  } catch (err) {
    if (err instanceof McpError) throw err
    throw new McpError(
      ErrorCode.InternalError,
      `Tool '${name}' failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
})

// ── Start server ──────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`llm-wiki MCP server v${PKG_VERSION} started`)
  console.error(`Default wiki path: ${DEFAULT_WIKI_PATH}`)
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err)
  process.exit(1)
})
