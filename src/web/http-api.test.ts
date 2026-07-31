import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ServerCommandError, invokeHttp } from "./http-api"

const fetchMock = vi.fn()

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => JSON.stringify(body),
  } as Response
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("invokeHttp", () => {
  it("unwraps the legacy {ok,result} envelope on success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { name: "x", path: "/p" } }))

    await expect(invokeHttp("open_project", { path: "/p" })).resolves.toEqual({
      name: "x",
      path: "/p",
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/invoke/open_project",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("passes through a bare result value", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: 42 }))

    await expect(invokeHttp("count_things")).resolves.toBe(42)
  })

  it("passes through a response with no result key as-is", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ name: "x" }))

    await expect(invokeHttp("legacy_command")).resolves.toEqual({ name: "x" })
  })

  it("extracts the error message from the failure envelope", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: "INTERNAL_ERROR", message: "Directory already exists: '/tmp/x'", details: null } },
        { ok: false, status: 500 },
      ),
    )

    const promise = invokeHttp("create_project", { path: "/tmp/x" })
    await expect(promise).rejects.toBeInstanceOf(ServerCommandError)
    await expect(promise).rejects.toThrow("Directory already exists: '/tmp/x'")
  })

  it("throws on a 200 ok:false not-found envelope (quiet sidecar probe)", async () => {
    // The legacy bridge answers missing-resource probes with HTTP 200 + ok:false
    // so the browser doesn't log a failed request; the transport must still
    // re-throw so callers' catch blocks behave exactly as before.
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "Path does not exist: '/p/.llm-wiki/lint.json'" } }),
    )

    const promise = invokeHttp("read_file", { path: "/p/.llm-wiki/lint.json" })
    await expect(promise).rejects.toBeInstanceOf(ServerCommandError)
    await expect(promise).rejects.toThrow("Path does not exist: '/p/.llm-wiki/lint.json'")
  })

  it("falls back to a generic message when the body is not an error object", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "Bad Gateway",
    } as Response)

    await expect(invokeHttp("open_project")).rejects.toThrow("Command 'open_project' failed (502)")
  })
})
