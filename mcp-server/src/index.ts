#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"
import {
  LlmWikiApiClient,
  type ApiFileNode,
  type ApiGraphNode,
  type ApiReviewItem,
  type ApiReviewsResponse,
  type ApiChatResponse,
  type ApiSearchResult,
} from "./api-client.js"
import { VERSION } from "./version.js"

const DEFAULT_PROJECT_ID = "current"
const MAX_TEXT_BYTES = 120_000

const client = new LlmWikiApiClient()

const server = new Server(
  { name: "llm-wiki", version: VERSION },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "llm_wiki_status",
      description: "Check whether the LLM Wiki desktop local API is reachable and list the current project.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_projects",
      description: "List known LLM Wiki projects. The response includes currentProject when the desktop app has an active project.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_files",
      description: "List files from a project using the desktop app's API permissions. project_id may be a UUID, filesystem path, or 'current'.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          root: { type: "string", enum: ["wiki", "sources", "all"], description: "Tree root to list. Defaults to wiki." },
          recursive: { type: "boolean", description: "Whether to list recursively. Defaults to true." },
          max_files: { type: "number", description: "Maximum files returned by the local API. Max 10000." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_read_file",
      description: "Read a text file from a project through the desktop app API. Only public project paths such as wiki/ and raw/sources/ are allowed by the API.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          path: { type: "string", description: "Project-relative file path, for example wiki/index.md." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_reviews",
      description: "List Review tab items from a project. Defaults to unresolved items so agent clients can help manage pending wiki review work.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          status: { type: "string", enum: ["unresolved", "resolved", "all"], description: "Review status filter. Defaults to unresolved." },
          type: { type: "string", description: "Optional Review item type filter, for example missing-page, duplicate, contradiction, confirm, or suggestion." },
          limit: { type: "number", description: "Maximum review items returned. The local API clamps to its configured maximum." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_search",
      description: "Search a project using the same backend keyword/vector retrieval used by the desktop API.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          query: { type: "string", description: "Search query." },
          top_k: { type: "number", description: "Maximum results. The local API clamps to its configured maximum." },
          include_content: { type: "boolean", description: "Include full page content in results when supported by the API." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_chat",
      description: "Ask the LLM Wiki backend Agent a question about a project. This initial backend Agent uses the desktop API's shared retrieval service and returns references.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          message: { type: "string", description: "User message or question." },
          session_id: { type: "string", description: "Optional caller-managed session id." },
          mode: { type: "string", enum: ["fast", "standard", "deep", "local_first"], description: "Agent mode. Defaults to standard." },
          top_k: { type: "number", description: "Maximum wiki references to retrieve. The API clamps to its configured maximum." },
          include_content: { type: "boolean", description: "Include full page content in retrieval when supported by the API. Defaults to false." },
          wiki: { type: "boolean", description: "Enable wiki retrieval. Defaults to true." },
          web: { type: "boolean", description: "Enable backend web.search when the Agent router decides external search is useful. Defaults to false." },
          anytxt: { type: "boolean", description: "Enable backend anytxt.search for source/local-file questions when AnyTXT is configured. Defaults to false." },
          skills: {
            type: "array",
            items: { type: "string" },
            description: "Optional project skills to inject from .llm-wiki/skills.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_graph",
      description: "Query the project knowledge graph through the desktop app API.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          q: { type: "string", description: "Optional text filter." },
          node_type: { type: "string", description: "Optional node type filter." },
          limit: { type: "number", description: "Maximum nodes. The local API clamps to its configured maximum." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_rescan_sources",
      description: "Trigger the desktop app's source folder rescan for a project, using the user's Source Watch rules.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
        },
        additionalProperties: false,
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = asObject(request.params.arguments ?? {})
  try {
    switch (request.params.name) {
      case "llm_wiki_status": {
        const [health, projects] = await Promise.all([
          client.health(),
          client.projects().catch(() => ({ projects: [], currentProject: null })),
        ])
        return textResult(JSON.stringify({ ...health, ...projects }, null, 2))
      }
      case "llm_wiki_projects": {
        await assertMcpEnabled()
        return textResult(JSON.stringify(await client.projects(), null, 2))
      }
      case "llm_wiki_files": {
        await assertMcpEnabled()
        const response = await client.files(projectId(args), {
          root: enumArg(args.root, ["wiki", "sources", "all"] as const, "wiki"),
          recursive: boolArg(args.recursive, true),
          maxFiles: numberArg(args.max_files),
        })
        return textResult(formatFileTree(response.files, response.truncated))
      }
      case "llm_wiki_read_file": {
        await assertMcpEnabled()
        const relPath = stringArg(args.path, "path")
        const { path, content } = await client.fileContent(projectId(args), relPath)
        return textResult(`# ${path}\n\n${truncateText(content, MAX_TEXT_BYTES)}`)
      }
      case "llm_wiki_reviews": {
        await assertMcpEnabled()
        const reviews = await client.reviews(projectId(args), {
          status: enumArg(args.status, ["unresolved", "resolved", "all"] as const, "unresolved"),
          type: optionalStringArg(args.type),
          limit: numberArg(args.limit),
        })
        return textResult(formatReviews(reviews))
      }
      case "llm_wiki_search": {
        await assertMcpEnabled()
        const query = stringArg(args.query, "query")
        const search = await client.search(projectId(args), query, {
          topK: numberArg(args.top_k),
          includeContent: boolArg(args.include_content, false),
        })
        return textResult(formatSearchResults(query, search))
      }
      case "llm_wiki_chat": {
        await assertMcpEnabled()
        const message = stringArg(args.message, "message")
        const chat = await client.chat(projectId(args), message, {
          sessionId: optionalStringArg(args.session_id),
          mode: enumArg(args.mode, ["fast", "standard", "deep", "local_first"] as const, "standard"),
          topK: numberArg(args.top_k),
          includeContent: boolArg(args.include_content, false),
          wiki: boolArg(args.wiki, true),
          web: boolArg(args.web, false),
          anytxt: boolArg(args.anytxt, false),
          skills: stringArrayArg(args.skills),
          persistSession: optionalStringArg(args.session_id) !== undefined,
        })
        return textResult(formatChatResponse(chat))
      }
      case "llm_wiki_graph": {
        await assertMcpEnabled()
        const graph = await client.graph(projectId(args), {
          q: optionalStringArg(args.q),
          nodeType: optionalStringArg(args.node_type),
          limit: numberArg(args.limit),
        })
        return textResult(formatGraph(graph.nodes, graph.edges))
      }
      case "llm_wiki_rescan_sources": {
        await assertMcpEnabled()
        return textResult(JSON.stringify(await client.rescan(projectId(args)), null, 2))
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`)
    }
  } catch (err) {
    if (err instanceof McpError) throw err
    throw new McpError(
      ErrorCode.InternalError,
      err instanceof Error ? err.message : String(err),
    )
  }
})

async function assertMcpEnabled(): Promise<void> {
  const health = await client.health()
  if (health.mcpEnabled === false) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "LLM Wiki MCP access is disabled. Enable Settings -> API + MCP -> Enable MCP access in the desktop app.",
    )
  }
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function projectId(args: Record<string, unknown>): string {
  return optionalStringArg(args.project_id) ?? DEFAULT_PROJECT_ID
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `${name} is required`)
  }
  return value
}

function optionalStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function boolArg(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function enumArg<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
}

function truncateText(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes <= maxBytes) return value
  let out = ""
  let used = 0
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8")
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return `${out}\n\n[truncated: ${bytes - used} bytes omitted]`
}

function formatFileTree(files: ApiFileNode[], truncated = false): string {
  if (files.length === 0) return "No files found."
  const lines: string[] = truncated
    ? ["[warning] File tree was truncated by the LLM Wiki API maxFiles limit.", ""]
    : []
  const walk = (nodes: ApiFileNode[], depth: number) => {
    for (const node of nodes) {
      const prefix = "  ".repeat(depth)
      lines.push(`${prefix}${node.isDir ? "📁" : "📄"} ${node.path}`)
      if (node.children) walk(node.children, depth + 1)
    }
  }
  walk(files, 0)
  return lines.join("\n")
}

function formatSearchResults(query: string, search: { results: ApiSearchResult[]; mode?: string; tokenHits?: number; vectorHits?: number }): string {
  const { results } = search
  if (results.length === 0) return `No results for "${query}".`
  const meta = [
    search.mode ? `Mode: ${search.mode}` : null,
    typeof search.tokenHits === "number" ? `Token hits: ${search.tokenHits}` : null,
    typeof search.vectorHits === "number" ? `Vector hits: ${search.vectorHits}` : null,
  ].filter(Boolean)
  const lines = [`# Search results for "${query}"`, ...(meta.length > 0 ? [meta.join(" | ")] : []), ""]
  results.forEach((result, index) => {
    lines.push(`## ${index + 1}. ${result.title}`)
    lines.push(`Path: ${result.path}`)
    lines.push(`Score: ${result.score.toFixed(6)}${typeof result.vectorScore === "number" ? ` | Vector score: ${result.vectorScore.toFixed(6)}` : ""}`)
    if (result.snippet) lines.push(`Snippet: ${result.snippet}`)
    if (result.images && result.images.length > 0) {
      lines.push(`Images: ${result.images.map((image) => image.url).join(", ")}`)
    }
    lines.push("")
  })
  return lines.join("\n")
}

function formatChatResponse(chat: ApiChatResponse): string {
  const lines = [
    "# LLM Wiki Agent response",
    "",
    `Session: ${chat.sessionId || "(none)"}`,
    chat.mode ? `Mode: ${chat.mode}` : null,
    chat.projectId ? `Project: ${chat.projectId}` : null,
    chat.usage
      ? `Usage: promptChars=${chat.usage.promptChars ?? 0}, completionChars=${chat.usage.completionChars ?? 0}, references=${chat.usage.referenceCount ?? chat.references.length}`
      : null,
    "",
    chat.message.content || "(empty response)",
    "",
  ].filter((line): line is string => line !== null)

  if (chat.references.length > 0) {
    lines.push("## References")
    chat.references.forEach((reference, index) => {
      lines.push(`${index + 1}. ${reference.title || reference.path}`)
      lines.push(`   Kind: ${reference.kind}`)
      lines.push(`   Path: ${reference.path}`)
      if (typeof reference.score === "number") lines.push(`   Score: ${reference.score.toFixed(6)}`)
      if (reference.snippet) lines.push(`   Snippet: ${reference.snippet}`)
    })
    lines.push("")
  }

  if (chat.toolEvents.length > 0) {
    lines.push("## Tool events")
    chat.toolEvents.forEach((event) => {
      lines.push(`- ${event.tool}: ${event.status}${event.detail ? ` (${event.detail})` : ""}`)
    })
  }

  return lines.join("\n")
}

function formatReviews(response: ApiReviewsResponse): string {
  const { reviews } = response
  if (reviews.length === 0) return `No ${response.status} review items found.`
  const lines = [
    "# Review items",
    "",
    `Status: ${response.status}`,
    `Count: ${response.count}`,
    "",
  ]
  reviews.forEach((review, index) => {
    lines.push(`## ${index + 1}. ${review.title || review.id}`)
    lines.push(`ID: ${review.id}`)
    lines.push(`Type: ${review.type}`)
    lines.push(`Resolved: ${review.resolved ? "yes" : "no"}`)
    if (review.sourcePath) lines.push(`Source: ${review.sourcePath}`)
    if (review.affectedPages && review.affectedPages.length > 0) {
      lines.push(`Affected pages: ${review.affectedPages.join(", ")}`)
    }
    if (review.searchQueries && review.searchQueries.length > 0) {
      lines.push(`Search queries: ${review.searchQueries.join(", ")}`)
    }
    if (review.description) lines.push(`Description: ${review.description}`)
    const optionSummary = formatReviewOptions(review)
    if (optionSummary) lines.push(`Options: ${optionSummary}`)
    lines.push("")
  })
  return lines.join("\n")
}

function formatReviewOptions(review: ApiReviewItem): string {
  if (!review.options || review.options.length === 0) return ""
  return review.options
    .map((option) => option.label ? `${option.label} (${option.action})` : option.action)
    .join(", ")
}

function formatGraph(nodes: ApiGraphNode[], edges: Array<{ source: string; target: string; weight?: number }>): string {
  const typeCounts = new Map<string, number>()
  for (const node of nodes) typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1)
  const lines = [
    "# Knowledge graph",
    "",
    `Nodes: ${nodes.length}`,
    `Edges: ${edges.length}`,
    "",
    "## Node types",
    ...[...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `- ${type}: ${count}`),
    "",
    "## Top nodes",
    ...nodes
      .slice()
      .sort((a, b) => (b.linkCount ?? 0) - (a.linkCount ?? 0))
      .slice(0, 30)
      .map((node) => `- ${node.label} (${node.type}, ${node.linkCount ?? 0} links)${node.path ? ` — ${node.path}` : ""}`),
  ]
  return lines.join("\n")
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`LLM Wiki MCP server v${VERSION} connected to ${process.env.LLM_WIKI_API_BASE_URL ?? "http://127.0.0.1:19828"}`)
}

main().catch((err) => {
  console.error("Failed to start LLM Wiki MCP server:", err)
  process.exit(1)
})
