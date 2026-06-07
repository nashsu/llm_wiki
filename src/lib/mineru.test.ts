import JSZip from "jszip"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockHttpFetch = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>()

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: () => Promise.resolve(mockHttpFetch),
}))

const fsMocks = vi.hoisted(() => ({
  getFileSize: vi.fn<() => Promise<number>>(),
  readFileAsBase64: vi.fn<() => Promise<{ base64: string; mimeType: string }>>(),
}))

vi.mock("@/commands/fs", () => ({
  getFileSize: fsMocks.getFileSize,
  readFileAsBase64: fsMocks.readFileAsBase64,
}))

import { __mineruTest, parseWithMineru, testMineruConnection } from "./mineru"

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

async function zipResponse(files: Record<string, string>): Promise<Response> {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content)
  }
  const bytes = await zip.generateAsync({ type: "uint8array" })
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return new Response(buffer)
}

beforeEach(() => {
  mockHttpFetch.mockReset()
  fsMocks.getFileSize.mockReset()
  fsMocks.readFileAsBase64.mockReset()
  fsMocks.getFileSize.mockResolvedValue(1024)
  fsMocks.readFileAsBase64.mockResolvedValue({
    base64: btoa("pdf bytes"),
    mimeType: "application/pdf",
  })
})

describe("MinerU API helpers", () => {
  it("maps official API error codes to actionable messages", () => {
    expect(__mineruTest.mineruApiErrorMessage("A0202", "bad token")).toContain("invalid")
    expect(__mineruTest.mineruApiErrorMessage("A0211", "expired")).toContain("expired")
    expect(__mineruTest.mineruApiErrorMessage(-60005, "too large")).toContain("200 MB")
    expect(__mineruTest.mineruApiErrorMessage(-60006, "too many pages")).toContain("200 page")
    expect(__mineruTest.mineruApiErrorMessage(-60018, "quota")).toContain("quota")
    expect(__mineruTest.mineruApiErrorMessage(123, "other")).toBe("MinerU API error 123: other")
  })

  it("prefers full.md from MinerU result zip", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "result/other.md": "other markdown",
      "result/full.md": "full markdown",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .resolves.toBe("full markdown")
  })

  it("falls back to another markdown file when full.md is missing", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "result/page.md": "fallback markdown",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .resolves.toBe("fallback markdown")
  })

  it("rejects MinerU zip files without markdown output", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "result/layout.json": "{}",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .rejects.toThrow("No Markdown file")
  })
})

describe("parseWithMineru", () => {
  it("rejects unsupported MinerU model versions before reading or uploading", async () => {
    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "mineru-html" as "vlm",
    }, "/tmp/doc.pdf")).rejects.toThrow("pipeline or vlm")

    expect(fsMocks.getFileSize).not.toHaveBeenCalled()
    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("rejects local files over MinerU's 200 MB accurate parsing limit before upload", async () => {
    fsMocks.getFileSize.mockResolvedValue(__mineruTest.MAX_ACCURATE_PARSE_BYTES + 1)

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/large.pdf")).rejects.toThrow("200 MB")

    expect(mockHttpFetch).not.toHaveBeenCalled()
    expect(fsMocks.readFileAsBase64).not.toHaveBeenCalled()
  })

  it("rejects before network access when the abort signal is already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf", undefined, undefined, controller.signal)).rejects.toThrow("cancelled")

    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("rejects batch upload responses without an upload URL", async () => {
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({
      code: 0,
      msg: "ok",
      data: { batch_id: "batch-1", file_urls: [] },
    }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf")).rejects.toThrow("upload URL")
  })

  it("uploads the decoded PDF bytes to the MinerU upload URL", async () => {
    fsMocks.readFileAsBase64.mockResolvedValueOnce({
      base64: btoa("custom pdf bytes"),
      mimeType: "application/pdf",
    })
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          batch_id: "batch-1",
          extract_result: [{ file_name: "doc.pdf", state: "done", full_zip_url: "https://zip" }],
        },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "parsed markdown" }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf")).resolves.toBe("parsed markdown")

    const uploadBody = mockHttpFetch.mock.calls[1]?.[1]?.body
    expect(uploadBody).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(uploadBody as ArrayBuffer)).toBe("custom pdf bytes")
  })

  it("submits URL tasks without reading or uploading a local file", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: "0",
        msg: "ok",
        data: { task_id: "task-1" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { task_id: "task-1", state: "done", full_zip_url: "https://zip" },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "url markdown" }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "pipeline",
    }, "/tmp/doc.pdf", "https://example.test/doc.pdf")).resolves.toBe("url markdown")

    expect(fsMocks.getFileSize).not.toHaveBeenCalled()
    expect(fsMocks.readFileAsBase64).not.toHaveBeenCalled()
    expect(JSON.parse(String(mockHttpFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: "https://example.test/doc.pdf",
      model_version: "pipeline",
    })
  })

  it("rejects MinerU failed states with the service error message", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          batch_id: "batch-1",
          extract_result: [{ file_name: "doc.pdf", state: "failed", err_msg: "parse exploded" }],
        },
      }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf")).rejects.toThrow("parse exploded")
  })

  it("stops polling immediately when the abort signal fires during the poll interval", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "running" }] },
      }))

    const controller = new AbortController()
    const result = parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf", undefined, undefined, controller.signal)

    setTimeout(() => controller.abort(), 10)

    await expect(result).rejects.toThrow("cancelled")
    expect(mockHttpFetch).toHaveBeenCalledTimes(3)
  })

  it("handles official pending, waiting-file, converting, and running states before completion", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "pending" }] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "waiting-file" }] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "converting" }] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "running" }] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          batch_id: "batch-1",
          extract_result: [{ file_name: "doc.pdf", state: "done", full_zip_url: "https://zip" }],
        },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "parsed markdown" }))

    const progress: string[] = []
    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf", undefined, (msg) => progress.push(msg))).resolves.toBe("parsed markdown")

    expect(progress).toContain("Waiting for MinerU to finish...")
    expect(mockHttpFetch).toHaveBeenCalledTimes(8)
  }, 16_000)
})

describe("testMineruConnection", () => {
  it("resolves when MinerU accepts the connection test task", async () => {
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({
      code: "0",
      msg: "ok",
      data: { task_id: "task-1" },
    }))

    await expect(testMineruConnection("token")).resolves.toBeUndefined()
  })

  it("includes HTTP status and response body when connection test transport fails", async () => {
    mockHttpFetch.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))

    await expect(testMineruConnection("token")).rejects.toThrow("HTTP 502: bad gateway")
  })

  it("maps MinerU API errors during connection test", async () => {
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({
      code: "A0202",
      msg: "token invalid",
      data: {},
    }))

    await expect(testMineruConnection("bad-token")).rejects.toThrow("invalid")
  })
})
