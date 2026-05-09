import { describe, expect, it, vi } from "vitest";
import {
  createApiClient,
  summarizeStatus,
  toolHandlers,
} from "./llmwiki-mcp.js";

function jsonResponse(data, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

function makeClient(fetchImpl) {
  return createApiClient({
    apiBase: "http://127.0.0.1:19827/api/v1",
    timeoutMs: 1000,
    fetchImpl,
  });
}

describe("llmwiki MCP API wrapper", () => {
  it("sends search payload to /api/v1/search", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: { query: "cache", results: [] } }),
    );
    const client = makeClient(fetchImpl);

    const result = await toolHandlers.search(client, {
      query: "cache",
      limit: 5,
      projectPath: "D:/wiki",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:19827/api/v1/search");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      query: "cache",
      limit: 5,
      projectPath: "D:/wiki",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.result.results).toEqual([]);
  });

  it("defaults retrieve includeContent to true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: { query: "rope", pages: [], references: [] } }),
    );
    const client = makeClient(fetchImpl);

    await toolHandlers.retrieve(client, { query: "rope" });

    const [, options] = fetchImpl.mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({
      query: "rope",
      includeContent: true,
    });
  });

  it("returns an MCP error result for ok:false chat responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error: "LLM not configured -- set API key and model in Settings." }),
    );
    const client = makeClient(fetchImpl);

    const result = await toolHandlers.chat(client, { query: "what changed?" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("LLM not configured");
    expect(result.structuredContent.ok).toBe(false);
  });

  it("summarizes status projects and capabilities", () => {
    const summary = summarizeStatus({
      ok: true,
      project: { path: "D:/wiki" },
      projects: [{ name: "A", path: "D:/wiki" }],
      capabilities: ["search", "retrieve"],
    });

    expect(summary).toContain("LLM Wiki local API is reachable");
    expect(summary).toContain("Current project: D:/wiki");
    expect(summary).toContain("Projects listed: 1");
    expect(summary).toContain("search, retrieve");
  });

  it("returns a helpful error when the local API is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = makeClient(fetchImpl);

    const result = await toolHandlers.status(client);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Start LLM Wiki");
    expect(result.content[0].text).toContain("open the target project");
  });
});
