import JSZip from "jszip"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockHttpFetch = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>()

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: () => Promise.resolve(mockHttpFetch),
}))

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn<() => Promise<void>>(),
  getFileSize: vi.fn<() => Promise<number>>(),
  readFileAsBase64: vi.fn<() => Promise<{ base64: string; mimeType: string }>>(),
  writeFileBase64: vi.fn<() => Promise<void>>(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  getFileSize: fsMocks.getFileSize,
  readFileAsBase64: fsMocks.readFileAsBase64,
  writeFileBase64: fsMocks.writeFileBase64,
}))

import { __mineruTest, parseWithMineru, parseWithMineruResult, testMineruConnection } from "./mineru"

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
  fsMocks.createDirectory.mockReset()
  fsMocks.getFileSize.mockReset()
  fsMocks.readFileAsBase64.mockReset()
  fsMocks.writeFileBase64.mockReset()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.getFileSize.mockResolvedValue(1024)
  fsMocks.readFileAsBase64.mockResolvedValue({
    base64: btoa("pdf bytes"),
    mimeType: "application/pdf",
  })
  fsMocks.writeFileBase64.mockResolvedValue(undefined)
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

  it("converts MinerU HTML tables inside full.md to Markdown tables", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": [
        "# Parsed",
        "<table>",
        "<tr><th>Name</th><th>Value</th></tr>",
        "<tr><td>A&amp;B</td><td>1|2</td></tr>",
        "</table>",
      ].join("\n"),
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .resolves.toContain("| Name | Value |\n| --- | --- |\n| A&B | 1\\|2 |")
  })

  it("keeps malformed numeric HTML entities from crashing table conversion", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": [
        "<table>",
        "<tr><td>&#65;</td><td>&#9999999999;</td><td>&#x41;</td><td>&#xFFFFFFF;</td></tr>",
        "</table>",
      ].join("\n"),
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .resolves.toContain("| A | &#9999999999; | A | &#xFFFFFFF; |")
  })

  it("does not convert HTML tables inside fenced code blocks", async () => {
    const code = [
      "```html",
      "<table><tr><td>Keep raw</td></tr></table>",
      "```",
    ].join("\n")
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": `${code}\n\n<table><tr><td>Convert me</td></tr></table>`,
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip")

    expect(markdown).toContain(code)
    expect(markdown).toContain("| Convert me |")
  })

  it("preserves and rewrites images inside MinerU HTML table cells", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": [
        "<table>",
        "<tr><th>Figure</th><th>Note</th></tr>",
        "<tr><td><img src=\"images/chart.png\" alt=\"Chart\"></td><td>A</td></tr>",
        "</table>",
      ].join("\n"),
      "images/chart.png": "chart-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toContain("| ![Chart](media/paper/mineru/images/chart.png) | A |")
  })

  it("extracts MinerU zip images and rewrites Markdown image references", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": [
        "# Parsed",
        "![Chart](images/chart.png)",
        "<img src=\"figures/table 1.jpg\" alt=\"Table\">",
        "![Remote](https://example.test/x.png)",
      ].join("\n"),
      "images/chart.png": "chart-bytes",
      "figures/table 1.jpg": "table-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/project/wiki/media/paper/mineru")
    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/paper/mineru/images/chart.png",
      btoa("chart-bytes"),
    )
    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/paper/mineru/figures/table 1.jpg",
      btoa("table-bytes"),
    )
    expect(markdown).toContain("![Chart](media/paper/mineru/images/chart.png)")
    expect(markdown).toContain("![Table](media/paper/mineru/figures/table%201.jpg)")
    expect(markdown).toContain("![Remote](https://example.test/x.png)")
  })

  it("returns SavedImage metadata for MinerU zip images", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Chart](images/chart.png)",
      "images/chart.png": "chart-bytes",
    }))

    const result = await __mineruTest.downloadAndExtractMarkdownResult(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(result.markdown).toBe("![Chart](media/paper/mineru/images/chart.png)")
    expect(result.savedImages).toHaveLength(1)
    expect(result.savedImages[0]).toMatchObject({
      index: 1,
      mimeType: "image/png",
      page: null,
      width: 0,
      height: 0,
      relPath: "media/paper/mineru/images/chart.png",
      absPath: "/project/wiki/media/paper/mineru/images/chart.png",
    })
    expect(result.savedImages[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("rewrites Markdown image paths containing spaces", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Wide chart](images/wide chart.png)",
      "images/wide chart.png": "chart-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toBe("![Wide chart](media/paper/mineru/images/wide%20chart.png)")
  })

  it("rewrites image filenames containing parentheses into balanced encoded links", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Chart](images/chart(1).png)",
      "images/chart(1).png": "chart-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toBe("![Chart](media/paper/mineru/images/chart%281%29.png)")
  })

  it("writes large extracted images with exact base64 content", async () => {
    const bytes = "x".repeat(40_000)
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Large](images/large.png)",
      "images/large.png": bytes,
    }))

    await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/paper/mineru/images/large.png",
      btoa(bytes),
    )
  })

  it("rewrites image links by basename when MinerU Markdown omits image directories", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "result/full.md": "![Chart](chart.png)",
      "result/images/chart.png": "chart-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toBe("![Chart](media/paper/mineru/result/images/chart.png)")
  })

  it("keeps extracted zip paths inside the MinerU media directory", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Evil](evil.png)",
      "../../evil.png": "evil-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/paper/mineru/evil.png",
      btoa("evil-bytes"),
    )
    expect(markdown).toBe("![Evil](media/paper/mineru/evil.png)")
  })

  it("does not use basename fallback when zip image basenames collide", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Ambiguous](chart.png)\n![A](a/chart.png)",
      "a/chart.png": "a-bytes",
      "b/chart.png": "b-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toContain("![Ambiguous](chart.png)")
    expect(markdown).toContain("![A](media/paper/mineru/a/chart.png)")
  })

  it("keeps parsed Markdown when extracted image saving fails", async () => {
    fsMocks.writeFileBase64.mockRejectedValueOnce(new Error("disk full"))
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Chart](images/chart.png)\nBody",
      "images/chart.png": "chart-bytes",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )).resolves.toBe("![Chart](images/chart.png)\nBody")
  })

  it("leaves external HTML image tags untouched", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "<img src=\"https://example.test/x.png\" alt=\"Remote\">",
      "images/local.png": "local-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(markdown).toBe("<img src=\"https://example.test/x.png\" alt=\"Remote\">")
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

  it("passes asset options through local MinerU parsing so images can be saved", async () => {
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
      .mockResolvedValueOnce(await zipResponse({
        "full.md": "![Chart](images/chart.png)",
        "images/chart.png": "chart-bytes",
      }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf", undefined, undefined, undefined, {
      projectPath: "/project",
      sourceSummarySlug: "doc",
    })).resolves.toBe("![Chart](media/doc/mineru/images/chart.png)")

    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/doc/mineru/images/chart.png",
      btoa("chart-bytes"),
    )
  })

  it("returns saved MinerU images from local parsing result", async () => {
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
      .mockResolvedValueOnce(await zipResponse({
        "full.md": "![Chart](images/chart.png)",
        "images/chart.png": "chart-bytes",
      }))

    const result = await parseWithMineruResult({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, "/tmp/doc.pdf", undefined, undefined, undefined, {
      projectPath: "/project",
      sourceSummarySlug: "doc",
    })

    expect(result.markdown).toBe("![Chart](media/doc/mineru/images/chart.png)")
    expect(result.savedImages.map((image) => image.relPath)).toEqual([
      "media/doc/mineru/images/chart.png",
    ])
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
