import assert from "node:assert/strict"
import { test } from "node:test"
import { LlmWikiApiClient, normalizeBaseUrl } from "../src/api-client.js"

test("normalizeBaseUrl trims trailing slashes and falls back to localhost", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:19828///"), "http://127.0.0.1:19828")
  assert.equal(normalizeBaseUrl(""), "http://127.0.0.1:19828")
})

test("projects sends bearer token and parses current project", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({
      ok: true,
      projects: [{ id: "p1", name: "Demo", path: "/tmp/demo", current: true }],
      currentProject: { id: "p1", name: "Demo", path: "/tmp/demo", current: true },
    }), { status: 200 })
  }

  const client = new LlmWikiApiClient({
    baseUrl: "http://localhost:19828/",
    token: "secret",
    fetchImpl,
  })
  const result = await client.projects()

  assert.equal(calls[0]?.url, "http://localhost:19828/api/v1/projects")
  assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer secret")
  assert.equal(result.currentProject?.id, "p1")
  assert.equal(result.projects[0]?.current, true)
})

test("health does not send authorization", async () => {
  const calls: Array<RequestInit | undefined> = []
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push(init)
    return new Response(JSON.stringify({ ok: true, status: "running" }), { status: 200 })
  }

  const client = new LlmWikiApiClient({ token: "secret", fetchImpl })
  await client.health()

  assert.equal((calls[0]?.headers as Record<string, string> | undefined)?.Authorization, undefined)
})

test("search posts JSON body to current project", async () => {
  let body = ""
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    body = String(init?.body ?? "")
    return new Response(JSON.stringify({
      ok: true,
      mode: "hybrid",
      tokenHits: 2,
      vectorHits: 1,
      results: [{ path: "wiki/a.md", title: "A", snippet: "hit", score: 0.5, vectorScore: 0.9 }],
    }), { status: 200 })
  }

  const client = new LlmWikiApiClient({ fetchImpl })
  const results = await client.search("current", "query", { topK: 3, includeContent: true })

  assert.deepEqual(JSON.parse(body), { query: "query", topK: 3, includeContent: true })
  assert.equal(results.mode, "hybrid")
  assert.equal(results.tokenHits, 2)
  assert.equal(results.vectorHits, 1)
  assert.equal(results.results[0]?.vectorScore, 0.9)
})

test("graph parses nodeType from API graph nodes", async () => {
  const fetchImpl = async (): Promise<Response> => (
    new Response(JSON.stringify({
      ok: true,
      nodes: [{ id: "n1", label: "Node", nodeType: "concept", path: "wiki/concepts/n1.md", linkCount: 4 }],
      edges: [{ source: "n1", target: "n2", weight: 0.75 }],
    }), { status: 200 })
  )

  const client = new LlmWikiApiClient({ fetchImpl })
  const graph = await client.graph("current")

  assert.equal(graph.nodes[0]?.type, "concept")
  assert.equal(graph.nodes[0]?.linkCount, 4)
  assert.equal(graph.edges[0]?.weight, 0.75)
})

test("files exposes truncated flag", async () => {
  const fetchImpl = async (): Promise<Response> => (
    new Response(JSON.stringify({
      ok: true,
      files: [{ name: "index.md", path: "wiki/index.md", isDir: false }],
      truncated: true,
    }), { status: 200 })
  )

  const client = new LlmWikiApiClient({ fetchImpl })
  const files = await client.files("current")

  assert.equal(files.truncated, true)
  assert.equal(files.files[0]?.path, "wiki/index.md")
})

test("reviews requests unresolved review items with filters", async () => {
  const calls: string[] = []
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    calls.push(String(url))
    return new Response(JSON.stringify({
      ok: true,
      projectId: "p1",
      status: "unresolved",
      count: 1,
      reviews: [{
        id: "r1",
        type: "missing-page",
        title: "Missing page: Attention",
        description: "Add the Attention page",
        options: [],
        resolved: false,
        createdAt: 1,
      }],
    }), { status: 200 })
  }

  const client = new LlmWikiApiClient({ baseUrl: "http://localhost:19828", fetchImpl })
  const result = await client.reviews("current", {
    status: "unresolved",
    type: "missing-page",
    limit: 5,
  })

  assert.equal(calls[0], "http://localhost:19828/api/v1/projects/current/reviews?status=unresolved&type=missing-page&limit=5")
  assert.equal(result.status, "unresolved")
  assert.equal(result.count, 1)
  assert.equal(result.reviews[0]?.id, "r1")
  assert.equal(result.reviews[0]?.resolved, false)
})

test("network failures include desktop app hint", async () => {
  const fetchImpl = async (): Promise<Response> => {
    throw new Error("ECONNREFUSED")
  }

  const client = new LlmWikiApiClient({ fetchImpl })
  await assert.rejects(() => client.projects(), /Is the desktop app running\? ECONNREFUSED/)
})

test("non-JSON responses include status and body preview", async () => {
  const fetchImpl = async (): Promise<Response> => (
    new Response("not json", { status: 502, statusText: "Bad Gateway" })
  )

  const client = new LlmWikiApiClient({ fetchImpl })
  await assert.rejects(() => client.projects(), /non-JSON response \(502\): not json/)
})

test("API errors include status and server message", async () => {
  const fetchImpl = async (): Promise<Response> => (
    new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401 })
  )

  const client = new LlmWikiApiClient({ fetchImpl })
  await assert.rejects(() => client.projects(), /LLM Wiki API 401: Unauthorized/)
})
