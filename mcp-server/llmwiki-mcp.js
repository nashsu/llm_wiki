#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const DEFAULT_API_BASE = "http://127.0.0.1:19827/api/v1";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const LONG_TIMEOUT_MS = 30 * 60_000;

const projectPathSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Optional LLM Wiki project path. Omit to use the project currently open in the desktop app.");

const limitSchema = z
  .number()
  .int()
  .positive()
  .max(100)
  .optional()
  .describe("Maximum number of results to return.");

const historyMessageSchema = z.object({
  role: z.enum(["user", "assistant"]).describe("Conversation role."),
  content: z.string().min(1).describe("Message text."),
});

function readPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeApiBase(value) {
  const base = (value || DEFAULT_API_BASE).trim();
  return base.replace(/\/+$/, "");
}

function endpointUrl(apiBase, endpoint) {
  return `${normalizeApiBase(apiBase)}/${endpoint.replace(/^\/+/, "")}`;
}

function isAbortError(error) {
  return error && typeof error === "object" && error.name === "AbortError";
}

function connectionHint() {
  return "Start LLM Wiki, open the target project, and make sure the local API is listening on 127.0.0.1:19827.";
}

function errorMessage(error, endpoint) {
  if (isAbortError(error)) {
    return `Timed out while calling LLM Wiki endpoint "${endpoint}".`;
  }
  const raw = error instanceof Error ? error.message : String(error);
  return `Failed to reach LLM Wiki endpoint "${endpoint}": ${raw}. ${connectionHint()}`;
}

export function createApiClient(options = {}) {
  const apiBase = normalizeApiBase(options.apiBase ?? process.env.LLMWIKI_API_BASE);
  const timeoutMs = readPositiveInt(options.timeoutMs ?? process.env.LLMWIKI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required. Use Node.js 18+ or provide fetchImpl.");
  }

  async function request(method, endpoint, body, requestOptions = {}) {
    const timeout = requestOptions.long ? Math.max(timeoutMs, LONG_TIMEOUT_MS) : timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();

    try {
      const response = await fetchImpl(endpointUrl(apiBase, endpoint), {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      let data = {};
      if (text.trim()) {
        try {
          data = JSON.parse(text);
        } catch (error) {
          return {
            ok: false,
            endpoint,
            status: response.status,
            error: `LLM Wiki returned non-JSON response from "${endpoint}": ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      if (!response.ok) {
        return {
          ok: false,
          endpoint,
          status: response.status,
          error: extractApiError(data) || `HTTP ${response.status} from LLM Wiki endpoint "${endpoint}".`,
          response: data,
        };
      }

      if (data && typeof data === "object" && data.ok === false) {
        return {
          ok: false,
          endpoint,
          status: response.status,
          error: extractApiError(data) || `LLM Wiki endpoint "${endpoint}" returned ok:false.`,
          response: data,
        };
      }

      return { ok: true, endpoint, status: response.status, response: data };
    } catch (error) {
      return {
        ok: false,
        endpoint,
        error: errorMessage(error, endpoint),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    apiBase,
    get: (endpoint) => request("GET", endpoint),
    post: (endpoint, body, options) => request("POST", endpoint, body, options),
  };
}

function extractApiError(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.error === "string") return data.error;
  if (data.error !== undefined) return JSON.stringify(data.error);
  if (typeof data.message === "string") return data.message;
  return "";
}

function textResult(text, structuredContent, isError = false) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function apiErrorResult(response) {
  const structuredContent = {
    ok: false,
    endpoint: response.endpoint,
    status: response.status ?? null,
    error: response.error || "Unknown LLM Wiki API error.",
    response: response.response ?? null,
  };
  return textResult(
    `${structuredContent.error}\n\n${connectionHint()}`,
    structuredContent,
    true,
  );
}

function apiSuccessResult(response, summarize) {
  return textResult(summarize(response.response), response.response);
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function maybeList(value, max = 3) {
  if (!Array.isArray(value) || value.length === 0) return "";
  const names = value.slice(0, max).map((item) => {
    if (!item || typeof item !== "object") return String(item);
    return item.title || item.name || item.path || item.file || item.slug || JSON.stringify(item).slice(0, 80);
  });
  return names.length > 0 ? ` Top: ${names.join("; ")}` : "";
}

export function summarizeStatus(data) {
  const projectPath = data?.project?.path || "";
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  const capabilities = Array.isArray(data?.capabilities) ? data.capabilities : [];
  const current = projectPath ? `Current project: ${projectPath}` : "No current project reported.";
  return [
    "LLM Wiki local API is reachable.",
    current,
    `Projects listed: ${projects.length}.`,
    `Capabilities: ${capabilities.length > 0 ? capabilities.join(", ") : "none reported"}.`,
  ].join(" ");
}

export function summarizeSearch(data) {
  const payload = data?.result ?? data ?? {};
  const results = Array.isArray(payload.results) ? payload.results : [];
  return `Found ${results.length} search result(s) for "${payload.query ?? ""}".${maybeList(results)}`;
}

export function summarizeRetrieve(data) {
  const payload = data?.result ?? data ?? {};
  const pages = Array.isArray(payload.pages) ? payload.pages : [];
  const references = Array.isArray(payload.references) ? payload.references : [];
  const searchResults = Array.isArray(payload.searchResults) ? payload.searchResults : [];
  const graphExpansions = Array.isArray(payload.graphExpansions) ? payload.graphExpansions : [];
  return [
    `Retrieved context for "${payload.query ?? ""}".`,
    `Pages: ${pages.length}.`,
    `References: ${references.length}.`,
    `Search results: ${searchResults.length}.`,
    `Graph expansions: ${graphExpansions.length}.`,
  ].join(" ");
}

export function summarizeChat(data) {
  const payload = data?.result ?? data ?? {};
  const answer = typeof payload.answer === "string" ? payload.answer : "";
  const references = Array.isArray(payload.references) ? payload.references : [];
  if (!answer) return `LLM Wiki chat completed for "${payload.query ?? ""}" with ${references.length} reference(s).`;
  return `${answer}\n\nReferences: ${references.length}.`;
}

export function summarizeGraph(data) {
  const payload = data?.result ?? data ?? {};
  return `Graph loaded. Nodes: ${count(payload.nodes)}. Edges: ${count(payload.edges)}.`;
}

export function summarizeIngest(data) {
  const payload = data?.result ?? data ?? {};
  const path = payload.path || payload.absolutePath || "";
  const taskId = payload.taskId || "";
  return `Source queued for ingest.${path ? ` Path: ${path}.` : ""}${taskId ? ` Task: ${taskId}.` : ""}`;
}

async function runGetTool(apiClient, endpoint, summarize) {
  const response = await apiClient.get(endpoint);
  if (!response.ok) return apiErrorResult(response);
  return apiSuccessResult(response, summarize);
}

async function runPostTool(apiClient, endpoint, args, summarize, options = {}) {
  const response = await apiClient.post(endpoint, args, options);
  if (!response.ok) return apiErrorResult(response);
  return apiSuccessResult(response, summarize);
}

export const toolHandlers = {
  status: (apiClient) => runGetTool(apiClient, "status", summarizeStatus),
  search: (apiClient, args) => runPostTool(apiClient, "search", args, summarizeSearch),
  retrieve: (apiClient, args) => runPostTool(apiClient, "retrieve", { includeContent: true, ...args }, summarizeRetrieve),
  chat: (apiClient, args) => runPostTool(apiClient, "chat", args, summarizeChat, { long: true }),
  graph: (apiClient, args) => runPostTool(apiClient, "graph", args, summarizeGraph),
  ingestClip: (apiClient, args) => runPostTool(apiClient, "ingest/clip", args, summarizeIngest, { long: true }),
  ingestFile: (apiClient, args) => runPostTool(apiClient, "ingest/file", args, summarizeIngest, { long: true }),
};

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export function createLlmWikiMcpServer(options = {}) {
  const apiClient = options.apiClient ?? createApiClient(options);
  const server = new McpServer({
    name: "llmwiki",
    version: "0.1.0",
  });

  server.registerTool(
    "llmwiki_status",
    {
      title: "LLM Wiki Status",
      description: "Check whether the local LLM Wiki desktop API is reachable and report the current project, recent projects, and supported capabilities.",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    () => toolHandlers.status(apiClient),
  );

  server.registerTool(
    "llmwiki_search",
    {
      title: "Search LLM Wiki",
      description: "Search an LLM Wiki project for matching wiki pages or raw sources. Use this for a quick ranked lookup when full page content is not required.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Search query."),
        limit: limitSchema.default(20),
        projectPath: projectPathSchema,
      },
      annotations: readOnlyAnnotations,
    },
    (args) => toolHandlers.search(apiClient, args),
  );

  server.registerTool(
    "llmwiki_retrieve",
    {
      title: "Retrieve LLM Wiki Context",
      description: "Retrieve citation-ready context from LLM Wiki, including relevant pages, references, search hits, and graph expansions for a query.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Question or topic to retrieve context for."),
        limit: limitSchema.default(10),
        includeContent: z.boolean().optional().default(true).describe("Whether to include full page content in retrieved pages."),
        projectPath: projectPathSchema,
      },
      annotations: readOnlyAnnotations,
    },
    (args) => toolHandlers.retrieve(apiClient, args),
  );

  server.registerTool(
    "llmwiki_chat",
    {
      title: "Ask LLM Wiki",
      description: "Ask LLM Wiki to answer using the currently configured LLM provider and the selected project knowledge base. Requires LLM Wiki Settings to have a usable model/API key.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Question to answer from the LLM Wiki project."),
        messages: z.array(historyMessageSchema).optional().describe("Optional recent conversation messages to include as chat history."),
        maxHistoryMessages: z.number().int().positive().max(50).optional().default(10).describe("Maximum number of history messages to forward."),
        projectPath: projectPathSchema,
      },
      annotations: {
        ...readOnlyAnnotations,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) => toolHandlers.chat(apiClient, args),
  );

  server.registerTool(
    "llmwiki_graph",
    {
      title: "Get LLM Wiki Graph",
      description: "Load the LLM Wiki knowledge graph for a project. The text result summarizes node and edge counts; structuredContent contains the full graph payload.",
      inputSchema: {
        projectPath: projectPathSchema,
      },
      annotations: readOnlyAnnotations,
    },
    (args) => toolHandlers.graph(apiClient, args),
  );

  server.registerTool(
    "llmwiki_ingest_clip",
    {
      title: "Ingest Text Clip",
      description: "Save text content as a new raw source in the active LLM Wiki desktop project and enqueue it for ingest. Open the target project in the desktop app before calling.",
      inputSchema: {
        title: z.string().trim().min(1).optional().describe("Source title. Defaults to Untitled in LLM Wiki if omitted."),
        url: z.string().trim().optional().describe("Original source URL, if available."),
        content: z.string().trim().min(1).describe("Markdown or plain text content to save and ingest."),
        projectPath: projectPathSchema,
      },
      annotations: writeAnnotations,
    },
    (args) => toolHandlers.ingestClip(apiClient, args),
  );

  server.registerTool(
    "llmwiki_ingest_file",
    {
      title: "Ingest Local File",
      description: "Copy a local file into the active LLM Wiki desktop project raw/sources directory and enqueue it for ingest. Open the target project in the desktop app before calling.",
      inputSchema: {
        sourcePath: z.string().trim().min(1).describe("Absolute or app-readable local file path to import."),
        projectPath: projectPathSchema,
      },
      annotations: writeAnnotations,
    },
    (args) => toolHandlers.ingestFile(apiClient, args),
  );

  return server;
}

export async function main() {
  const server = createLlmWikiMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";

if (invokedFile && currentFile === invokedFile) {
  main().catch((error) => {
    console.error("LLM Wiki MCP server failed:", error);
    process.exitCode = 1;
  });
}
