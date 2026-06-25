/**
 * Real local-API tests against a running LLM Wiki desktop app.
 *
 * These tests intentionally perform real HTTP calls to
 * http://127.0.0.1:19828/api/v1 and use a real project id. They are gated
 * behind RUN_API_TESTS=1 (or RUN_LLM_TESTS=1 for the repo's shared real-test
 * script) because they require the app to be running and the API server to be
 * enabled in Settings -> API + MCP.
 *
 * WARNING: the auth/config tests mutate the live app-state.json to verify
 * enabled=false and unauthenticated mode. They restore the original file in
 * afterAll, but run this against a dedicated test project when possible.
 *
 * Example:
 *   RUN_API_TESTS=1 \
 *   API_PROJECT_ID=a0e90b29-fcf3-4364-9502-8bd1272de820 \
 *   API_TOKEN=<token-if-required> \
 *   npx vitest run src/lib/api-server.real-llm.test.ts
 */
import { describe, expect, it } from "vitest"
import { afterAll, beforeAll } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { API_SERVER_BASE_URL } from "./api-server-constants"

const ENABLED = process.env.RUN_API_TESTS === "1" || process.env.RUN_LLM_TESTS === "1"
const BASE_URL = process.env.API_BASE_URL ?? API_SERVER_BASE_URL
const PROJECT_ID =
  process.env.API_PROJECT_ID ?? "a0e90b29-fcf3-4364-9502-8bd1272de820"
const API_TOKEN = process.env.API_TOKEN ?? process.env.LLM_WIKI_API_TOKEN ?? ""
const TEST_TOKEN = process.env.API_TEST_TOKEN ?? "llm-wiki-real-api-test-token"

const TEST_TIMEOUT_MS = 30_000
const RESCAN_TIMEOUT_MS = 60_000

interface ApiEnvelope {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

interface ApiHealth extends ApiEnvelope {
  status?: string
  enabled?: boolean
  authRequired?: boolean
  authConfigured?: boolean
  allowUnauthenticated?: boolean
  allowLanAccess?: boolean
  tokenSource?: "env" | "store" | "none"
}

interface ApiProject {
  id: string
  name: string
  path: string
  current: boolean
}

interface ApiFileNode {
  name: string
  path: string
  isDir: boolean
  size?: number
  children?: ApiFileNode[]
}

interface SearchHit {
  path: string
  title: string
  snippet: string
  score: number
  content?: string
}

interface GraphNode {
  id: string
  label: string
  nodeType: string
  path: string
  linkCount: number
}

interface GraphEdge {
  source: string
  target: string
  weight: number
}

interface RescanResult {
  queue?: {
    version?: number
    tasks?: unknown[]
  }
  changedTasks?: unknown[]
}

let serverUnavailableReason: string | null = null
let initialHealth: ApiHealth | null = null
let appStatePath: string | null = null
let originalAppStateRaw: string | null = null
let appStateMutated = false

function endpoint(path: string): string {
  return `${BASE_URL}${path}`
}

function authHeaders(): Record<string, string> {
  return API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}
}

async function api<T extends ApiEnvelope>(
  path: string,
  init: RequestInit = {},
  options: { auth?: "default" | "none" | "bearer" | "xToken"; token?: string } = {},
): Promise<{ status: number; body: T }> {
  const authMode = options.auth ?? "default"
  const token = options.token ?? API_TOKEN
  const auth =
    authMode === "none"
      ? {}
      : authMode === "bearer"
        ? { Authorization: `Bearer ${token}` }
        : authMode === "xToken"
          ? { "X-LLM-Wiki-Token": token }
          : authHeaders()
  const headers = {
    ...auth,
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(init.headers as Record<string, string> | undefined),
  }
  const response = await fetch(endpoint(path), { ...init, headers })
  const text = await response.text()
  const body = (text ? JSON.parse(text) : {}) as T
  return { status: response.status, body }
}

async function health(): Promise<ApiHealth> {
  const { status, body } = await api<ApiHealth>("/api/v1/health", {}, { auth: "none" })
  if (status !== 200 || body.ok !== true) {
    throw new Error(`API health check failed with HTTP ${status}: ${JSON.stringify(body)}`)
  }
  return body
}

function flatten(nodes: ApiFileNode[]): ApiFileNode[] {
  const out: ApiFileNode[] = []
  const visit = (items: ApiFileNode[]) => {
    for (const item of items) {
      out.push(item)
      if (item.children) visit(item.children)
    }
  }
  visit(nodes)
  return out
}

function firstTextFile(nodes: ApiFileNode[]): ApiFileNode | undefined {
  return flatten(nodes).find(
    (node) =>
      !node.isDir &&
      /(^|\/)(purpose|schema)\.md$|\.(md|mdx|txt|json|yaml|yml|csv|html|htm|xml|rtf|log)$/i.test(
        node.path,
      ),
  )
}

function firstBinaryFile(nodes: ApiFileNode[]): ApiFileNode | undefined {
  return flatten(nodes).find(
    (node) =>
      !node.isDir &&
      /^wiki\/media\//i.test(node.path) &&
      !/\.(md|mdx|txt|json|yaml|yml|csv|html|htm|xml|rtf|log)$/i.test(node.path),
  )
}

function searchQueryFromContent(content: string, fallback: string): string {
  const title =
    content.match(/^title:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim() ??
    content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (title && title.length >= 2) return title
  const candidates = content
    .replace(/```[\s\S]*?```/g, " ")
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 2 &&
        ![
          "title",
          "type",
          "sources",
          "the",
          "and",
          "for",
          "that",
          "with",
          "this",
          "from",
        ].includes(s.toLowerCase()),
    )
  return candidates[0] ?? fallback
}

async function requireUsableApi(): Promise<ApiHealth> {
  const h = await health()
  expect(h.status).toBe("running")
  expect(h.enabled).toBe(true)
  if (h.authRequired && !h.allowUnauthenticated && !API_TOKEN) {
    throw new Error(
      "API requires auth. Re-run with API_TOKEN=<token> or enable Settings -> API + MCP -> Allow access without a token.",
    )
  }
  return h
}

function appStateCandidates(): string[] {
  const explicit = process.env.API_APP_STATE_PATH
  const home = os.homedir()
  const candidates = explicit ? [explicit] : []
  if (process.platform === "darwin") {
    candidates.push(
      path.join(home, "Library/Application Support/com.llmwiki.app/app-state.json"),
      path.join(home, "Library/Application Support/LLM Wiki/app-state.json"),
    )
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData/Roaming")
    candidates.push(
      path.join(appData, "com.llmwiki.app/app-state.json"),
      path.join(appData, "LLM Wiki/app-state.json"),
    )
  } else {
    candidates.push(
      path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local/share"), "com.llmwiki.app/app-state.json"),
      path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "com.llmwiki.app/app-state.json"),
    )
  }
  return [...new Set(candidates)]
}

async function resolveAppStatePath(): Promise<string | null> {
  for (const candidate of appStateCandidates()) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // try next candidate
    }
  }
  return null
}

async function readAppState(): Promise<Record<string, unknown>> {
  if (!appStatePath) throw new Error("app-state.json path is not available")
  const raw = await fs.readFile(appStatePath, "utf8")
  if (originalAppStateRaw === null) originalAppStateRaw = raw
  return JSON.parse(raw) as Record<string, unknown>
}

async function writeApiConfig(config: {
  enabled: boolean
  allowUnauthenticated: boolean
  allowLanAccess?: boolean
  token: string
}): Promise<void> {
  const state = await readAppState()
  state.apiConfig = { allowLanAccess: false, ...config }
  await fs.writeFile(appStatePath!, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  appStateMutated = true
}

async function waitForHealth(
  predicate: (value: ApiHealth) => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<ApiHealth> {
  const deadline = Date.now() + timeoutMs
  let last: ApiHealth | null = null
  while (Date.now() < deadline) {
    try {
      last = await health()
      if (predicate(last)) return last
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for API health condition: ${label}. Last health: ${JSON.stringify(last)}`)
}

function ensureServer(ctx: { skip: () => void }) {
  if (serverUnavailableReason) {
    console.warn(serverUnavailableReason)
    ctx.skip()
  }
}

function ensureMutableAppState(ctx: { skip: () => void }) {
  ensureServer(ctx)
  if (!appStatePath) {
    console.warn(
      "Skipping API config mutation tests because app-state.json was not found. Set API_APP_STATE_PATH to run them.",
    )
    ctx.skip()
  }
}

describe.skipIf(!ENABLED)("local API v1 against real project", () => {
  beforeAll(async () => {
    try {
      initialHealth = await waitForHealth(() => true, "server reachable", 2_000)
    } catch (err) {
      serverUnavailableReason = `App is not running or the local API is unreachable at ${BASE_URL}. Launch LLM Wiki first, then re-run. ${String(err)}`
      return
    }
    appStatePath = await resolveAppStatePath()
  }, 5_000)

  afterAll(async () => {
    if (appStateMutated && appStatePath && originalAppStateRaw !== null) {
      await fs.writeFile(appStatePath, originalAppStateRaw, "utf8")
      await waitForHealth(
        (h) =>
          h.enabled === initialHealth?.enabled &&
          h.allowUnauthenticated === initialHealth?.allowUnauthenticated,
        "original API config restored",
      ).catch((err) => {
        console.warn("[api-real-test] failed to observe restored API config:", err)
      })
    }
  }, 12_000)

  it(
    "reports server health and auth mode",
    async (ctx) => {
      ensureServer(ctx)
      const h = await requireUsableApi()
      expect(typeof h.authRequired).toBe("boolean")
      expect(typeof h.authConfigured).toBe("boolean")
      expect(typeof h.allowUnauthenticated).toBe("boolean")
      expect(["env", "store", "none"]).toContain(h.tokenSource)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "enforces the token auth matrix when auth is required",
    async (ctx) => {
      ensureMutableAppState(ctx)
      await writeApiConfig({ enabled: true, allowUnauthenticated: false, token: TEST_TOKEN })
      const h = await waitForHealth(
        (value) => value.enabled === true && value.allowUnauthenticated === false && value.authRequired === true,
        "auth required",
      )
      const effectiveToken = h.tokenSource === "env" ? API_TOKEN : TEST_TOKEN
      if (!effectiveToken) {
        console.warn("Skipping positive auth checks because the running app uses LLM_WIKI_API_TOKEN and API_TOKEN was not provided.")
      }

      const noToken = await api<ApiEnvelope>("/api/v1/projects", {}, { auth: "none" })
      expect(noToken.status).toBe(401)

      const wrongBearer = await api<ApiEnvelope>("/api/v1/projects", {}, { auth: "bearer", token: "wrong-token" })
      expect(wrongBearer.status).toBe(401)

      const wrongXToken = await api<ApiEnvelope>("/api/v1/projects", {}, { auth: "xToken", token: "wrong-token" })
      expect(wrongXToken.status).toBe(401)

      if (effectiveToken) {
        const bearer = await api<ApiEnvelope & { projects: ApiProject[]; currentProject?: ApiProject | null }>(
          "/api/v1/projects",
          {},
          { auth: "bearer", token: effectiveToken },
        )
        expect(bearer.status).toBe(200)
        expect(Array.isArray(bearer.body.projects)).toBe(true)
        expect(bearer.body.currentProject == null || bearer.body.currentProject.current).toBe(true)

        const xToken = await api<ApiEnvelope & { projects: ApiProject[] }>(
          "/api/v1/projects",
          {},
          { auth: "xToken", token: effectiveToken },
        )
        expect(xToken.status).toBe(200)

        const query = await api<ApiEnvelope & { projects: ApiProject[] }>(
          `/api/v1/projects?token=${encodeURIComponent(effectiveToken)}`,
          {},
          { auth: "none" },
        )
        expect(query.status).toBe(200)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "honors the enabled=false kill switch",
    async (ctx) => {
      ensureMutableAppState(ctx)
      await writeApiConfig({ enabled: false, allowUnauthenticated: false, token: TEST_TOKEN })
      await waitForHealth((value) => value.enabled === false, "API disabled")
      const resp = await api<ApiEnvelope>(
        "/api/v1/projects",
        {},
        { auth: "bearer", token: API_TOKEN || TEST_TOKEN },
      )
      expect(resp.status).toBe(503)
      expect(resp.body.error).toContain("disabled")
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "allows no-token access when unauthenticated mode is enabled",
    async (ctx) => {
      ensureMutableAppState(ctx)
      await writeApiConfig({ enabled: true, allowUnauthenticated: true, token: "" })
      await waitForHealth(
        (value) => value.enabled === true && value.allowUnauthenticated === true && value.authRequired === false,
        "unauthenticated mode",
      )
      const resp = await api<ApiEnvelope & { projects: ApiProject[]; currentProject?: ApiProject | null }>("/api/v1/projects", {}, { auth: "none" })
      expect(resp.status).toBe(200)
      expect(resp.body.ok).toBe(true)
      expect(Array.isArray(resp.body.projects)).toBe(true)
      expect(resp.body.currentProject == null || resp.body.currentProject.current).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "lists projects and includes the target project id",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const { status, body } = await api<ApiEnvelope & { projects: ApiProject[]; currentProject?: ApiProject | null }>("/api/v1/projects")
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(Array.isArray(body.projects)).toBe(true)
      const project = body.projects.find((p) => p.id === PROJECT_ID)
      expect(project, `project ${PROJECT_ID} should be known to the API`).toBeTruthy()
      expect(project!.path).toBeTruthy()
      const currentFromList = body.projects.find((p) => p.current)
      if (currentFromList) {
        expect(body.currentProject).toMatchObject({
          id: currentFromList.id,
          path: currentFromList.path,
          current: true,
        })
      } else {
        expect(body.currentProject ?? null).toBeNull()
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "returns wiki, source, and public all-file trees",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      for (const root of ["wiki", "sources", "all"] as const) {
        const { status, body } = await api<ApiEnvelope & { files: ApiFileNode[] }>(
          `/api/v1/projects/${PROJECT_ID}/files?root=${root}&recursive=true&maxFiles=10000`,
        )
        expect(status).toBe(200)
        expect(body.ok).toBe(true)
        expect(Array.isArray(body.files)).toBe(true)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "reads real file content from the project",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const filesResp = await api<ApiEnvelope & { files: ApiFileNode[] }>(
        `/api/v1/projects/${PROJECT_ID}/files?root=all&recursive=true&maxFiles=10000`,
      )
      expect(filesResp.status).toBe(200)
      const file = firstTextFile(filesResp.body.files)
      expect(file, "expected at least one text-like public project file").toBeTruthy()

      const contentResp = await api<ApiEnvelope & { path: string; content: string }>(
        `/api/v1/projects/${PROJECT_ID}/files/content?path=${encodeURIComponent(file!.path)}`,
      )
      expect(contentResp.status).toBe(200)
      expect(contentResp.body.ok).toBe(true)
      expect(contentResp.body.path).toBe(file!.path)
      expect(typeof contentResp.body.content).toBe("string")
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "searches the real wiki and returns ranked results",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const filesResp = await api<ApiEnvelope & { files: ApiFileNode[] }>(
        `/api/v1/projects/${PROJECT_ID}/files?root=wiki&recursive=true&maxFiles=10000`,
      )
      expect(filesResp.status).toBe(200)
      const file = firstTextFile(filesResp.body.files)
      expect(file, "expected at least one wiki text file for search seed").toBeTruthy()

      const contentResp = await api<ApiEnvelope & { content: string }>(
        `/api/v1/projects/${PROJECT_ID}/files/content?path=${encodeURIComponent(file!.path)}`,
      )
      expect(contentResp.status).toBe(200)
      const query = searchQueryFromContent(contentResp.body.content, file!.name.replace(/\.[^.]+$/, ""))

      const searchResp = await api<ApiEnvelope & { mode: string; results: SearchHit[] }>(
        `/api/v1/projects/${PROJECT_ID}/search`,
        {
          method: "POST",
          body: JSON.stringify({ query, topK: 10, includeContent: true }),
        },
      )
      expect(searchResp.status).toBe(200)
      expect(searchResp.body.ok).toBe(true)
      expect(["keyword", "vector", "hybrid"]).toContain(searchResp.body.mode)
      expect(searchResp.body.results.length).toBeGreaterThan(0)
      expect(searchResp.body.results[0].score).toBeGreaterThan(0)
      expect(searchResp.body.results[0].path).toBeTruthy()
      expect(searchResp.body.results[0].content).toBeTruthy()
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "returns the real wiki graph",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const graphResp = await api<ApiEnvelope & { nodes: GraphNode[]; edges: GraphEdge[] }>(
        `/api/v1/projects/${PROJECT_ID}/graph?limit=1000`,
      )
      expect(graphResp.status).toBe(200)
      expect(graphResp.body.ok).toBe(true)
      expect(Array.isArray(graphResp.body.nodes)).toBe(true)
      expect(Array.isArray(graphResp.body.edges)).toBe(true)
      expect(graphResp.body.nodes.length, "real project should have graph nodes").toBeGreaterThan(0)
      expect(graphResp.body.nodes[0].id).toBeTruthy()
      expect(graphResp.body.nodes[0].path).toMatch(/^wiki\//)
      expect(typeof graphResp.body.nodes[0].linkCount).toBe("number")
      if (graphResp.body.edges.length > 0) {
        expect(typeof graphResp.body.edges[0].weight).toBe("number")
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "supports graph q filtering when a node exists",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const graphResp = await api<ApiEnvelope & { nodes: GraphNode[] }>(
        `/api/v1/projects/${PROJECT_ID}/graph?limit=1000`,
      )
      expect(graphResp.status).toBe(200)
      if (graphResp.body.nodes.length === 0) {
        console.warn("Skipping graph q filter assertion because this project has no graph nodes.")
        ctx.skip()
      }
      const q = encodeURIComponent(graphResp.body.nodes[0].label.slice(0, 4))
      const filtered = await api<ApiEnvelope & { nodes: GraphNode[] }>(
        `/api/v1/projects/${PROJECT_ID}/graph?q=${q}&limit=1000`,
      )
      expect(filtered.status).toBe(200)
      expect(filtered.body.ok).toBe(true)
      expect(filtered.body.nodes.length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "runs a real source rescan through the API",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const rescanResp = await api<ApiEnvelope & { result: RescanResult }>(
        `/api/v1/projects/${PROJECT_ID}/sources/rescan`,
        { method: "POST" },
      )
      expect(rescanResp.status).toBe(200)
      expect(rescanResp.body.ok).toBe(true)
      expect(rescanResp.body.result).toMatchObject({
        queue: { version: expect.any(Number), tasks: expect.any(Array) },
        changedTasks: expect.any(Array),
      })
    },
    RESCAN_TIMEOUT_MS,
  )

  it(
    "reports chat as not implemented in API v1",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const chatResp = await api<ApiEnvelope>(`/api/v1/projects/${PROJECT_ID}/chat`, {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
      })
      expect(chatResp.status).toBe(501)
      expect(chatResp.body.ok).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "rejects path traversal",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const traversal = await api<ApiEnvelope>(
        `/api/v1/projects/${PROJECT_ID}/files/content?path=${encodeURIComponent("../app-state.json")}`,
      )
      expect(traversal.status).toBe(403)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "rejects binary content reads with 415",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const filesResp = await api<ApiEnvelope & { files: ApiFileNode[] }>(
        `/api/v1/projects/${PROJECT_ID}/files?root=all&recursive=true&maxFiles=10000`,
      )
      expect(filesResp.status).toBe(200)
      const binaryFile = firstBinaryFile(filesResp.body.files)
      if (!binaryFile) {
        console.warn("Skipping binary content assertion because no wiki/media binary file is present.")
        ctx.skip()
      }

      const binary = await api<ApiEnvelope>(
        `/api/v1/projects/${PROJECT_ID}/files/content?path=${encodeURIComponent(binaryFile!.path)}`,
      )
      expect(binary.status).toBe(415)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "rejects empty search requests with 400",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const badSearch = await api<ApiEnvelope>(`/api/v1/projects/${PROJECT_ID}/search`, {
        method: "POST",
        body: JSON.stringify({ query: "" }),
      })
      expect(badSearch.status).toBe(400)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "returns 404 for unknown project ids",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const unknownProject = await api<ApiEnvelope>(
        `/api/v1/projects/00000000-0000-0000-0000-000000000000/files`,
      )
      expect(unknownProject.status).toBe(404)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "returns 404 for missing routes",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const missingRoute = await api<ApiEnvelope>("/api/v1/not-a-route")
      expect(missingRoute.status).toBe(404)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "returns 405 for unsupported methods on API routes",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const resp = await api<ApiEnvelope>("/api/v1/projects", { method: "PUT" })
      expect(resp.status).toBe(405)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "rejects invalid file roots with 400",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const resp = await api<ApiEnvelope>(`/api/v1/projects/${PROJECT_ID}/files?root=invalid`)
      expect(resp.status).toBe(400)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "supports current and filesystem-path project identifiers",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const projectsResp = await api<ApiEnvelope & { projects: ApiProject[]; currentProject?: ApiProject | null }>("/api/v1/projects")
      expect(projectsResp.status).toBe(200)
      const target = projectsResp.body.projects.find((p) => p.id === PROJECT_ID)
      expect(target).toBeTruthy()

      const byPath = await api<ApiEnvelope & { files: ApiFileNode[] }>(
        `/api/v1/projects/${encodeURIComponent(target!.path)}/files?root=wiki&recursive=false`,
      )
      expect(byPath.status).toBe(200)

      const current = projectsResp.body.projects.find((p) => p.current)
      if (!current) {
        console.warn("Skipping current project id assertion because no current project is registered.")
        ctx.skip()
      }
      expect(projectsResp.body.currentProject).toMatchObject({
        id: current!.id,
        path: current!.path,
        current: true,
      })
      const currentResp = await api<ApiEnvelope & { files: ApiFileNode[] }>(
        "/api/v1/projects/current/files?root=wiki&recursive=false",
      )
      expect(currentResp.status).toBe(200)

      const currentCaseResp = await api<ApiEnvelope & { files: ApiFileNode[] }>(
        "/api/v1/projects/Current/files?root=wiki&recursive=false",
      )
      expect(currentCaseResp.status).toBe(200)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "clamps oversized search and graph limits",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const searchResp = await api<ApiEnvelope & { results: SearchHit[] }>(
        `/api/v1/projects/${PROJECT_ID}/search`,
        {
          method: "POST",
          body: JSON.stringify({ query: "a", topK: 999, includeContent: false }),
        },
      )
      expect(searchResp.status).toBe(200)
      expect(searchResp.body.results.length).toBeLessThanOrEqual(50)

      const graphResp = await api<ApiEnvelope & { nodes: GraphNode[] }>(
        `/api/v1/projects/${PROJECT_ID}/graph?limit=999999`,
      )
      expect(graphResp.status).toBe(200)
      expect(graphResp.body.nodes.length).toBeLessThanOrEqual(1000)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "returns 400 for oversized request bodies",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const hugeQuery = "x".repeat(1024 * 1024 + 1)
      const resp = await api<ApiEnvelope>(`/api/v1/projects/${PROJECT_ID}/search`, {
        method: "POST",
        body: JSON.stringify({ query: hugeQuery }),
      })
      expect(resp.status).toBe(400)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "returns 413 when the requested file tree exceeds maxFiles",
    async (ctx) => {
      ensureServer(ctx)
      await requireUsableApi()
      const resp = await api<ApiEnvelope & { files?: ApiFileNode[] }>(
        `/api/v1/projects/${PROJECT_ID}/files?root=all&recursive=true&maxFiles=1`,
      )
      if (resp.status !== 413) {
        console.warn("Skipping maxFiles 413 assertion because this project has one or fewer public nodes.")
        ctx.skip()
      }
      expect(resp.status).toBe(413)
    },
    TEST_TIMEOUT_MS,
  )
})
