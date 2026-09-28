import { describe, expect, it, vi } from "vitest"
import { normalizeJiraConfig } from "./jira-config"
import { bytesToBase64, JiraApiError, JiraClient, utf8ToBase64 } from "./jira-api"
import type { JiraConfig } from "@/stores/wiki-store"

/** A config whose credentials are deliberately non-Latin1. */
function config(overrides: Partial<JiraConfig> = {}): JiraConfig {
  return normalizeJiraConfig({
    baseUrl: "https://jira.example.com",
    username: "王锦",
    password: "@WJ密码..",
    ...overrides,
  })
}

interface RecordedCall {
  url: string
  init: RequestInit & { maxRedirections?: number; danger?: unknown }
}

function fakeFetch(
  respond: (call: RecordedCall, index: number) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init: (init ?? {}) as RecordedCall["init"] }
    calls.push(call)
    return respond(call, calls.length - 1)
  }) as unknown as typeof globalThis.fetch
  return { fetch: impl, calls }
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })

describe("base64", () => {
  it("builds standard padded base64 over raw bytes", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("")
    expect(bytesToBase64(new Uint8Array([0x61]))).toBe("YQ==")
    expect(bytesToBase64(new Uint8Array([0x61, 0x62]))).toBe("YWI=")
    expect(bytesToBase64(new Uint8Array([0x61, 0x62, 0x63]))).toBe("YWJj")
    expect(bytesToBase64(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe("//79")
  })

  it("preserves every byte value, including the high range", () => {
    const all = new Uint8Array(256)
    for (let index = 0; index < 256; index += 1) all[index] = index
    expect(bytesToBase64(all)).toBe(Buffer.from(all).toString("base64"))
  })

  it("encodes a non-Latin1 string as its UTF-8 bytes — what btoa cannot do", () => {
    expect(utf8ToBase64("用户:密码")).toBe(Buffer.from("用户:密码", "utf8").toString("base64"))
    expect(() => btoa("用户:密码")).toThrow()
  })
})

describe("JiraClient request shape", () => {
  it("sends Basic credentials derived from the UTF-8 bytes of user:password", async () => {
    const { fetch, calls } = fakeFetch(() => json({ version: "9.4.0" }))
    await new JiraClient(config(), fetch).testConnection()

    const expected = `Basic ${Buffer.from("王锦:@WJ密码..", "utf8").toString("base64")}`
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(expected)
  })

  it("never lets the password appear in the clear", async () => {
    const { fetch, calls } = fakeFetch(() => json({}))
    await new JiraClient(config(), fetch).testConnection()
    const serialized = JSON.stringify(calls[0].init.headers)
    expect(serialized).not.toContain("@WJ密码..")
  })

  it("sends the configured User-Agent and Accept header", async () => {
    const { fetch, calls } = fakeFetch(() => json({}))
    await new JiraClient(config({ userAgent: "JIRA-Connection-Test/1.0" }), fetch).testConnection()
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get("user-agent")).toBe("JIRA-Connection-Test/1.0")
    expect(headers.get("accept")).toBe("application/json")
  })

  it("omits the User-Agent entirely when it is blank", async () => {
    const { fetch, calls } = fakeFetch(() => json({}))
    await new JiraClient({ ...config(), userAgent: "  " }, fetch).testConnection()
    expect(new Headers(calls[0].init.headers).has("user-agent")).toBe(false)
  })

  it("never follows a redirect itself", async () => {
    const { fetch, calls } = fakeFetch(() => json({}))
    await new JiraClient(config(), fetch).testConnection()
    expect(calls[0].init.redirect).toBe("manual")
    expect(calls[0].init.maxRedirections).toBe(0)
  })

  it("relaxes TLS only when asked, and per request", async () => {
    const on = fakeFetch(() => json({}))
    await new JiraClient(config({ acceptInvalidCerts: true }), on.fetch).testConnection()
    expect(on.calls[0].init.danger).toEqual({ acceptInvalidCerts: true, acceptInvalidHostnames: false })

    const off = fakeFetch(() => json({}))
    await new JiraClient(config({ acceptInvalidCerts: false }), off.fetch).testConnection()
    expect(off.calls[0].init).not.toHaveProperty("danger")
  })

  it("hits serverInfo for the connection test", async () => {
    const { fetch, calls } = fakeFetch(() => json({ version: "9.4.0", serverTitle: "CVTE" }))
    const info = await new JiraClient(config(), fetch).testConnection()
    expect(calls[0].url).toBe("https://jira.example.com/rest/api/2/serverInfo")
    expect(info.version).toBe("9.4.0")
    expect(info.serverTitle).toBe("CVTE")
  })
})

describe("JiraClient.search", () => {
  it("builds a GET search URL carrying the JQL, paging and fields", async () => {
    const { fetch, calls } = fakeFetch(() => json({ startAt: 0, maxResults: 50, total: 0, issues: [] }))
    await new JiraClient(config(), fetch).search({ jql: "project = AERDM", maxResults: 50 })

    const url = new URL(calls[0].url)
    expect(url.pathname).toBe("/rest/api/2/search")
    expect(url.searchParams.get("jql")).toBe("project = AERDM")
    expect(url.searchParams.get("maxResults")).toBe("50")
    expect(url.searchParams.get("startAt")).toBe("0")
    expect(url.searchParams.get("fields")).toContain("summary")
  })

  it("falls back once to POST when the GET form was deprecated", async () => {
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0
        ? new Response("", { status: 405 })
        : json({ startAt: 0, maxResults: 50, total: 1, issues: [{ id: "1", key: "AERDM-1", fields: {} }] }),
    )
    const result = await new JiraClient(config(), fetch).search({ jql: "project = AERDM" })

    expect(calls).toHaveLength(2)
    expect(calls[0].init.method ?? "GET").toBe("GET")
    expect(calls[1].init.method).toBe("POST")
    expect(calls[1].url).toBe("https://jira.example.com/rest/api/2/search")
    expect(new Headers(calls[1].init.headers).get("content-type")).toBe("application/json")
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ jql: "project = AERDM", startAt: 0 })
    expect(result.issues).toHaveLength(1)
  })

  it.each([404, 410])("also falls back on %i", async (status) => {
    const { fetch, calls } = fakeFetch((_call, index) =>
      index === 0 ? new Response("", { status }) : json({ startAt: 0, maxResults: 0, total: 0, issues: [] }),
    )
    await new JiraClient(config(), fetch).search({ jql: "" })
    expect(calls).toHaveLength(2)
  })

  it("does not retry an auth failure — that is not a deprecation", async () => {
    const { fetch, calls } = fakeFetch(() => json({ errorMessages: ["nope"] }, { status: 401 }))
    await expect(new JiraClient(config(), fetch).search({ jql: "x" })).rejects.toMatchObject({
      kind: "auth",
      status: 401,
    })
    expect(calls).toHaveLength(1)
  })

  it("surfaces a failure instead of returning an empty result set", async () => {
    const { fetch } = fakeFetch(() =>
      json({ errorMessages: ["Field 'nope' does not exist"] }, { status: 400 }),
    )
    await expect(new JiraClient(config(), fetch).search({ jql: "nope = 1" })).rejects.toMatchObject({
      kind: "http",
      status: 400,
    })
  })
})

describe("JiraClient.getIssue", () => {
  it("asks for the named fields and the changelog", async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: "1", key: "AERDM-1234", fields: {} }))
    await new JiraClient(config(), fetch).getIssue("AERDM-1234", ["summary", "labels"], {
      expandChangelog: true,
    })

    const url = new URL(calls[0].url)
    expect(url.pathname).toBe("/rest/api/2/issue/AERDM-1234")
    expect(url.searchParams.get("fields")).toBe("summary,labels")
    expect(url.searchParams.get("expand")).toBe("changelog")
  })

  it("omits the changelog expansion when it was not asked for", async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: "1", key: "AERDM-1", fields: {} }))
    await new JiraClient(config(), fetch).getIssue("AERDM-1", ["summary"])
    expect(new URL(calls[0].url).searchParams.has("expand")).toBe(false)
  })

  it("escapes the key into the path", async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: "1", key: "x", fields: {} }))
    await new JiraClient(config(), fetch).getIssue("A B/C", ["summary"])
    expect(calls[0].url).toContain("/rest/api/2/issue/A%20B%2FC")
  })
})

describe("JiraClient.getCommentsPage", () => {
  it("pages the comments and defaults a missing total to what came back", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ comments: [{ id: "1", body: "hi" }, { id: "2", body: "there" }] }),
    )
    const page = await new JiraClient(config(), fetch).getCommentsPage("AERDM-1", 100, 100)

    const url = new URL(calls[0].url)
    expect(url.pathname).toBe("/rest/api/2/issue/AERDM-1/comment")
    expect(url.searchParams.get("startAt")).toBe("100")
    expect(page.total).toBe(2)
    expect(page.comments).toHaveLength(2)
  })

  it("returns an empty page rather than undefined comments", async () => {
    const { fetch } = fakeFetch(() => json({ total: 0 }))
    expect(await new JiraClient(config(), fetch).getCommentsPage("AERDM-1", 0, 100)).toEqual({
      comments: [],
      total: 0,
    })
  })
})

describe("JiraClient.downloadAttachment", () => {
  it("returns the raw bytes, undecoded", async () => {
    const binary = new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47])
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(binary, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    )
    const bytes = await new JiraClient(config(), fetch).downloadAttachment({
      id: "1",
      filename: "shot.png",
      content: "https://jira.example.com/secure/attachment/1/shot.png",
    })

    expect(Array.from(bytes)).toEqual(Array.from(binary))
    expect(calls[0].url).toBe("https://jira.example.com/secure/attachment/1/shot.png")
  })
})

describe("JiraApiError classification", () => {
  it("reports a redirect as an auth problem and keeps the Location", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://sso.example.com/login" },
        }),
    )
    const error = await new JiraClient(config(), fetch)
      .testConnection()
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(JiraApiError)
    const apiError = error as JiraApiError
    expect(apiError.kind).toBe("auth")
    expect(apiError.status).toBe(302)
    expect(apiError.location).toBe("https://sso.example.com/login")
    expect(apiError.describe()).toContain("https://sso.example.com/login")
  })

  it("rejects an HTML body with a readable error instead of a JSON parse error", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response("<html><body>Login</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    )
    const error = (await new JiraClient(config(), fetch)
      .testConnection()
      .catch((caught: unknown) => caught)) as JiraApiError

    expect(error).toBeInstanceOf(JiraApiError)
    expect(error).not.toBeInstanceOf(SyntaxError)
    expect(error.kind).toBe("http")
    expect(error.describe()).toContain("text/html")
  })

  it("reports a JSON content-type with a broken body as a readable error", async () => {
    const { fetch } = fakeFetch(
      () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    )
    const error = (await new JiraClient(config(), fetch)
      .testConnection()
      .catch((caught: unknown) => caught)) as JiraApiError
    expect(error.kind).toBe("http")
    expect(error.describe()).toContain("not valid JSON")
  })

  it("marks a 404 as not-found", async () => {
    const { fetch } = fakeFetch(() => json({ errorMessages: ["gone"] }, { status: 404 }))
    const error = (await new JiraClient(config(), fetch)
      .getIssue("AERDM-1", ["summary"])
      .catch((caught: unknown) => caught)) as JiraApiError
    expect(error.kind).toBe("not-found")
    expect(error.status).toBe(404)
  })

  it("marks a 500 as a plain HTTP failure and quotes Jira's own message", async () => {
    const { fetch } = fakeFetch(() =>
      json({ errorMessages: ["Internal server error"], errors: { jql: "bad" } }, { status: 500 }),
    )
    const error = (await new JiraClient(config(), fetch)
      .search({ jql: "x" })
      .catch((caught: unknown) => caught)) as JiraApiError
    expect(error.kind).toBe("http")
    expect(error.describe()).toContain("Internal server error")
    expect(error.describe()).toContain("jql: bad")
  })

  it("marks a transport failure as a network error with no status", async () => {
    const impl = (async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof globalThis.fetch
    const error = (await new JiraClient(config(), impl)
      .testConnection()
      .catch((caught: unknown) => caught)) as JiraApiError
    expect(error.kind).toBe("network")
    expect(error.status).toBe(0)
  })

  it("marks an abort as a network error", async () => {
    const impl = (async () => {
      const abort = new Error("aborted")
      abort.name = "AbortError"
      throw abort
    }) as unknown as typeof globalThis.fetch
    const error = (await new JiraClient(config(), impl)
      .testConnection()
      .catch((caught: unknown) => caught)) as JiraApiError
    expect(error.kind).toBe("network")
    expect(error.describe()).toContain("aborted")
  })

  it("never leaks the password through describe()", async () => {
    const { fetch } = fakeFetch(() =>
      json({ errorMessages: ["bad credentials"] }, { status: 401 }),
    )
    const error = (await new JiraClient(config(), fetch)
      .testConnection()
      .catch((caught: unknown) => caught)) as JiraApiError

    const text = `${error.message} ${error.describe()} ${error.stack ?? ""} ${JSON.stringify(error)}`
    expect(text).not.toContain("@WJ密码..")
    expect(text).toContain("401")
  })

  it("caps the body excerpt so a WAF page cannot fill the UI", async () => {
    const { fetch } = fakeFetch(
      () => new Response("x".repeat(5000), { status: 403, headers: { "content-type": "text/html" } }),
    )
    const error = (await new JiraClient(config(), fetch)
      .testConnection()
      .catch((caught: unknown) => caught)) as JiraApiError
    expect(error.describe().length).toBeLessThan(400)
  })
})

describe("JiraClient cancellation", () => {
  it("aborts the in-flight request when the caller's signal fires", async () => {
    const controller = new AbortController()
    const observed: AbortSignal[] = []
    const impl = (async (_url: string | URL, init?: RequestInit) => {
      observed.push(init?.signal as AbortSignal)
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abort = new Error("aborted")
          abort.name = "AbortError"
          reject(abort)
        })
      })
    }) as unknown as typeof globalThis.fetch

    const pending = new JiraClient(config(), impl).testConnection(controller.signal)
    await vi.waitFor(() => expect(observed).toHaveLength(1))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ kind: "network" })
    expect(observed[0].aborted).toBe(true)
  })

  it("unsubscribes from the caller's signal once the request settles", async () => {
    const controller = new AbortController()
    const { fetch } = fakeFetch(() => json({}))
    await new JiraClient(config(), fetch).testConnection(controller.signal)
    // A leftover listener would still fire here; nothing should observe it.
    expect(() => controller.abort()).not.toThrow()
    expect(controller.signal.aborted).toBe(true)
  })
})
