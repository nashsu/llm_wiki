import { beforeEach, describe, expect, it, vi } from "vitest"
import { anyTxtSearch, normalizeAnyTxtConfig } from "./anytxt-search"

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

describe("anyTxtSearch", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  it("calls AnyTXT GetResult and fetches fragments for matching files", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          output: {
            items: [
              {
                fid: "9223736511748752040",
                path: "C:\\docs\\alpha.pdf",
                name: "alpha.pdf",
              },
            ],
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          output: {
            text: "matching fragment text",
          },
        },
      }))

    const out = await anyTxtSearch(
      "alpha",
      {
        endpoint: "127.0.0.1:9920",
        filterDir: "C:\\docs",
        filterExt: "*.pdf",
        limit: 10,
      },
      5,
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://127.0.0.1:9920")
    expect(JSON.parse(String(init?.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "ATRpcServer.Searcher.V1.GetResult",
      params: {
        input: {
          pattern: "alpha",
          filterDir: "C:\\docs",
          filterExt: "*.pdf",
          limit: "5",
        },
      },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      method: "ATRpcServer.Searcher.V1.GetFragment",
      params: { input: { fid: "9223736511748752040", pattern: "alpha" } },
    })
    expect(out).toEqual([
      {
        title: "alpha.pdf",
        url: "file:///C:/docs/alpha.pdf",
        snippet: "matching fragment text",
        source: "AnyTXT",
      },
    ])
  })

  it("normalizes tolerant AnyTXT response shapes without fragments", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: {
        output: [
          {
            full_path: "/Users/me/docs/note.md",
            hitText: "local note match",
          },
        ],
      },
    }))

    const out = await anyTxtSearch("note", { endpoint: "http://127.0.0.1:9920" }, 3, "/project")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out[0]).toMatchObject({
      title: "note.md",
      url: "file:///Users/me/docs/note.md",
      snippet: "local note match",
      source: "AnyTXT",
    })
  })

  it("normalizes AnyTXT data.output.files rows using the returned field list", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        id: 1,
        jsonrpc: "2.0",
        result: {
          data: {
            output: {
              count: 1,
              field: ["fid", "lastModify", "size", "file"],
              files: [["9223736511748752040", 1711588801, 1200, "D:\\docs\\煤矿安全.md"]],
            },
          },
          errno: 0,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        result: {
          data: {
            output: {
              text: "煤矿安全 fragment",
            },
          },
        },
      }))

    const out = await anyTxtSearch("煤矿", { endpoint: "http://127.0.0.1:9920" }, 5)

    expect(out).toEqual([
      {
        title: "煤矿安全.md",
        url: "file:///D:/docs/%E7%85%A4%E7%9F%BF%E5%AE%89%E5%85%A8.md",
        snippet: "煤矿安全 fragment",
        source: "AnyTXT",
      },
    ])
  })

  it("normalizes UNC network paths to file URLs", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: {
        data: {
          output: {
            field: ["fid", "file"],
            files: [["unc-1", "\\\\nas\\share\\研究报告.md"]],
          },
        },
      },
    }))

    const out = await anyTxtSearch("研究", { endpoint: "http://127.0.0.1:9920" }, 5)

    expect(out[0]).toMatchObject({
      title: "研究报告.md",
      url: "file://nas/share/%E7%A0%94%E7%A9%B6%E6%8A%A5%E5%91%8A.md",
      source: "AnyTXT",
    })
  })

  it("uses the Unix root for blank filterDir on macOS/Linux projects", () => {
    expect(normalizeAnyTxtConfig({ filterDir: "" }, "/Users/me/wiki").filterDir)
      .toBe("/")
  })

  it("leaves blank filterDir unset for Windows projects", () => {
    expect(normalizeAnyTxtConfig({ filterDir: "" }, "C:/Users/me/wiki").filterDir)
      .toBe("")
  })

  it("sends the Unix root as filterDir when folder filtering is blank on macOS/Linux", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { items: [] } }))

    await anyTxtSearch("alpha", { endpoint: "http://127.0.0.1:9920", filterDir: "" }, 5, "/Users/me/wiki")

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.params.input.filterDir).toBe("/")
  })

  it("normalizes endpoints and clamps limits", () => {
    expect(normalizeAnyTxtConfig({ endpoint: "localhost:9920" }).endpoint).toBe("http://localhost:9920")
    expect(normalizeAnyTxtConfig({ endpoint: "https://anytxt.local/" }).endpoint).toBe("https://anytxt.local/")
    expect(normalizeAnyTxtConfig({ limit: -1 }).limit).toBe(1)
    expect(normalizeAnyTxtConfig({ limit: 1000 }).limit).toBe(100)
  })

  it("returns no results for blank queries without calling AnyTXT", async () => {
    const out = await anyTxtSearch("  ", { endpoint: "http://127.0.0.1:9920" })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(out).toEqual([])
  })

  it("surfaces JSON-RPC errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      error: { message: "bad pattern" },
    }))

    await expect(anyTxtSearch("alpha", { endpoint: "http://127.0.0.1:9920" }))
      .rejects.toThrow("AnyTXT error: bad pattern")
  })

  it("surfaces HTTP failures with status codes", async () => {
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }))

    await expect(anyTxtSearch("alpha", { endpoint: "http://127.0.0.1:9920" }))
      .rejects.toThrow("AnyTXT request failed (500): oops")
  })

  it("falls back to item snippets when fragment lookup fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        result: {
          items: [
            { fid: "1", path: "/tmp/a.md", snippet: "fallback snippet" },
          ],
        },
      }))
      .mockResolvedValueOnce(new Response("fragment failed", { status: 500 }))

    const out = await anyTxtSearch("alpha", { endpoint: "http://127.0.0.1:9920" })

    expect(out[0].snippet).toBe("fallback snippet")
  })

  it("filters blank AnyTXT result items", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: {
        items: [
          {},
          { path: "/tmp/valid.md", snippet: "valid" },
        ],
      },
    }))

    const out = await anyTxtSearch("alpha", { endpoint: "http://127.0.0.1:9920" })

    expect(out).toHaveLength(1)
    expect(out[0].url).toBe("file:///tmp/valid.md")
  })

  it("turns fetch network failures into AnyTXT connection guidance", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))

    await expect(anyTxtSearch("alpha", { endpoint: "http://127.0.0.1:9920" }))
      .rejects.toThrow("Check that ATGUI.exe is running")
  })
})
