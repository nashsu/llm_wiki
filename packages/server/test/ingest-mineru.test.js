// Server-port tests for ingest/mineru.js — ported from src/lib/mineru.test.ts.
// Adaptations (client → server):
//   • getHttpFetch mock → vi.stubGlobal("fetch", fetchMock)
//   • @/commands/fs mocks → real filesystem inside a mkdtemp project dir
//     (writeFileBase64/createDirectory assertions become on-disk checks;
//     getFileSize/readFileAsBase64 fixtures become real tmp files, and the
//     oversized-file guard uses a sparse truncate instead of a mocked stat)
//   • Windows-path source fixture → tmp POSIX path (the server never sees
//     C:\ paths in these tests; form/URL assertions unchanged)
// No network access: every fetch is mocked. The mkdtemp dirs are cleaned up.

import JSZip from "jszip"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { truncate } from "node:fs/promises"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"

import { __mineruTest, parseWithMineru, parseWithMineruResult, testMineruConnection } from "../src/ingest/mineru.js"

let fetchMock
let project // mkdtemp project dir used as MinerU assetOptions.projectPath
let sourcePath // real tmp PDF fixture
const tmpDirs = []

function makeTmpDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function jsonResponse(body, init) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

async function zipResponse(files) {
  const zip = new JSZip()
  for (const [filePath, content] of Object.entries(files)) {
    zip.file(filePath, content)
  }
  const bytes = await zip.generateAsync({ type: "uint8array" })
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  )
  return new Response(buffer)
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  project = makeTmpDir("llmwiki-mineru-proj-")
  const srcDir = makeTmpDir("llmwiki-mineru-src-")
  sourcePath = path.join(srcDir, "doc.pdf")
  writeFileSync(sourcePath, "pdf bytes")
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

const assetOptions = () => ({ projectPath: project, sourceSummarySlug: "paper" })

function mediaFile(relPath) {
  return path.join(project, "wiki", ...relPath.split("/"))
}

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
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "result/other.md": "other markdown",
      "result/full.md": "full markdown",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .resolves.toBe("full markdown")
  })

  it("falls back to another markdown file when full.md is missing", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "result/page.md": "fallback markdown",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .resolves.toBe("fallback markdown")
  })

  it("rejects MinerU zip files without markdown output", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "result/layout.json": "{}",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .rejects.toThrow("No Markdown file")
  })

  it("converts MinerU HTML tables inside full.md to Markdown tables", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
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
    fetchMock.mockResolvedValueOnce(await zipResponse({
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
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "full.md": `${code}\n\n<table><tr><td>Convert me</td></tr></table>`,
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip")

    expect(markdown).toContain(code)
    expect(markdown).toContain("| Convert me |")
  })

  it("preserves and rewrites images inside MinerU HTML table cells", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
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
      assetOptions(),
    )

    expect(markdown).toContain("| ![Chart](media/paper/mineru/images/chart.png) | A |")
  })

  it("extracts MinerU zip images and rewrites Markdown image references", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
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
      assetOptions(),
    )

    expect(existsSync(mediaFile("media/paper/mineru"))).toBe(true)
    expect(readFileSync(mediaFile("media/paper/mineru/images/chart.png")).toString("base64"))
      .toBe(btoa("chart-bytes"))
    expect(readFileSync(mediaFile("media/paper/mineru/figures/table 1.jpg")).toString("base64"))
      .toBe(btoa("table-bytes"))
    expect(markdown).toContain("![Chart](media/paper/mineru/images/chart.png)")
    expect(markdown).toContain("![Table](media/paper/mineru/figures/table%201.jpg)")
    expect(markdown).toContain("![Remote](https://example.test/x.png)")
  })

  it("returns SavedImage metadata for MinerU zip images", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Chart](images/chart.png)",
      "images/chart.png": "chart-bytes",
    }))

    const result = await __mineruTest.downloadAndExtractMarkdownResult(
      "https://cdn/result.zip",
      undefined,
      assetOptions(),
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
      absPath: `${project}/wiki/media/paper/mineru/images/chart.png`,
    })
    expect(result.savedImages[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("rewrites Markdown image paths containing spaces", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Wide chart](images/wide chart.png)",
      "images/wide chart.png": "chart-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      assetOptions(),
    )

    expect(markdown).toBe("![Wide chart](media/paper/mineru/images/wide%20chart.png)")
  })

  it("rewrites image filenames containing parentheses into balanced encoded links", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Chart](images/chart(1).png)",
      "images/chart(1).png": "chart-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      assetOptions(),
    )

    expect(markdown).toBe("![Chart](media/paper/mineru/images/chart%281%29.png)")
  })

  it("writes large extracted images with exact base64 content", async () => {
    const bytes = "x".repeat(40_000)
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Large](images/large.png)",
      "images/large.png": bytes,
    }))

    await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      assetOptions(),
    )

    expect(readFileSync(mediaFile("media/paper/mineru/images/large.png")).toString("base64"))
      .toBe(btoa(bytes))
  })

  it("rewrites image links by basename when MinerU Markdown omits image directories", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "result/full.md": "![Chart](chart.png)",
      "result/images/chart.png": "chart-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      assetOptions(),
    )

    expect(markdown).toBe("![Chart](media/paper/mineru/result/images/chart.png)")
  })

  it("keeps extracted zip paths inside the MinerU media directory", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Evil](evil.png)",
      "../../evil.png": "evil-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      assetOptions(),
    )

    expect(readFileSync(mediaFile("media/paper/mineru/evil.png")).toString("base64"))
      .toBe(btoa("evil-bytes"))
    expect(markdown).toBe("![Evil](media/paper/mineru/evil.png)")
  })

  it("does not use basename fallback when zip image basenames collide", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Ambiguous](chart.png)\n![A](a/chart.png)",
      "a/chart.png": "a-bytes",
      "b/chart.png": "b-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      assetOptions(),
    )

    expect(markdown).toContain("![Ambiguous](chart.png)")
    expect(markdown).toContain("![A](media/paper/mineru/a/chart.png)")
  })

  it("keeps parsed Markdown when extracted image saving fails", async () => {
    // Make the target path unwritable: pre-create it as a directory so
    // writeFile fails with EISDIR (server stand-in for the client's
    // writeFileBase64.mockRejectedValueOnce(new Error("disk full"))).
    mkdirSync(mediaFile("media/paper/mineru/images/chart.png"), { recursive: true })
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Chart](images/chart.png)\nBody",
      "images/chart.png": "chart-bytes",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      assetOptions(),
    )).resolves.toBe("![Chart](images/chart.png)\nBody")
  })

  it("leaves external HTML image tags untouched", async () => {
    fetchMock.mockResolvedValueOnce(await zipResponse({
      "full.md": "<img src=\"https://example.test/x.png\" alt=\"Remote\">",
      "images/local.png": "local-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      assetOptions(),
    )

    expect(markdown).toBe("<img src=\"https://example.test/x.png\" alt=\"Remote\">")
  })
})

describe("parseWithMineru", () => {
  it("submits a PDF and pipeline mode to a custom local endpoint", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        task_id: "task/1",
        status_url: "http://localhost:9000/custom/tasks/task%2F1",
        result_url: "http://localhost:9000/custom/tasks/task%2F1/result",
      }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }))
      .mockResolvedValueOnce(jsonResponse({
        results: { report: { md_content: "# Parsed locally" } },
      }))

    await expect(parseWithMineru({
      enabled: true,
      backend: "local",
      localEndpoint: "http://localhost:9000/custom/",
      localBackend: "pipeline",
      token: "",
      modelVersion: "pipeline",
    }, sourcePath)).resolves.toBe("# Parsed locally")

    const form = fetchMock.mock.calls[0]?.[1]?.body
    expect(form.get("files")).toBeInstanceOf(Blob)
    expect(form.get("backend")).toBe("pipeline")
    expect(form.get("return_md")).toBe("true")
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:9000/custom/tasks")
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/tasks/task%2F1")
    expect(fetchMock.mock.calls[2]?.[0]).toContain("/tasks/task%2F1/result")
  })

  it("rejects oversized local-backend files before reading or uploading", async () => {
    // Sparse file: stat reports the logical size without allocating bytes.
    await truncate(sourcePath, __mineruTest.MAX_ACCURATE_PARSE_BYTES + 1)

    await expect(parseWithMineru({
      enabled: true,
      backend: "local",
      token: "",
      modelVersion: "vlm",
    }, sourcePath)).rejects.toThrow("200 MB")

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects an empty local-backend result instead of caching it as success", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-1" }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }))
      .mockResolvedValueOnce(jsonResponse({ results: { doc: { md_content: "  " } } }))

    await expect(parseWithMineru({
      enabled: true,
      backend: "local",
      token: "",
      modelVersion: "vlm",
    }, sourcePath)).rejects.toThrow("empty parsing result")
  })

  it("saves and rewrites images returned by the official local API", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-1" }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }))
      .mockResolvedValueOnce(jsonResponse({
        results: {
          doc: {
            md_content: "![Chart](images/chart.png)",
            images: { "chart.png": `data:image/png;base64,${btoa("image bytes")}` },
          },
        },
      }))

    const result = await parseWithMineruResult({
      enabled: true,
      backend: "local",
      token: "",
      modelVersion: "vlm",
      localBackend: "hybrid-engine",
    }, sourcePath, undefined, undefined, undefined, {
      projectPath: project,
      sourceSummarySlug: "doc",
    })

    expect(result.markdown).toBe("![Chart](media/doc/mineru/images/image-1.png)")
    expect(result.savedImages[0]?.relPath).toBe("media/doc/mineru/images/image-1.png")
    expect(readFileSync(mediaFile("media/doc/mineru/images/image-1.png")).toString("base64"))
      .toBe(btoa("image bytes"))
    const form = fetchMock.mock.calls[0]?.[1]?.body
    expect(form.get("return_images")).toBe("true")
  })

  it("uses the data URI MIME type when the MinerU filename extension disagrees", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: "task-1" }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }))
      .mockResolvedValueOnce(jsonResponse({
        results: {
          doc: {
            md_content: "![Chart](images/chart.jpg)",
            images: { "chart.jpg": `data:image/png;base64,${btoa("png bytes")}` },
          },
        },
      }))

    const result = await parseWithMineruResult({
      enabled: true,
      backend: "local",
      token: "",
      modelVersion: "vlm",
      localBackend: "hybrid-engine",
    }, sourcePath, undefined, undefined, undefined, {
      projectPath: project,
      sourceSummarySlug: "doc",
    })

    expect(result.markdown).toBe("![Chart](media/doc/mineru/images/image-1.png)")
    expect(result.savedImages[0]?.mimeType).toBe("image/png")
    expect(result.savedImages[0]?.relPath).toBe("media/doc/mineru/images/image-1.png")
  })

  it("requires a model server URL for official HTTP-client backends", async () => {
    await expect(parseWithMineru({
      enabled: true,
      backend: "local",
      token: "",
      modelVersion: "vlm",
      localBackend: "vlm-http-client",
      localServerUrl: "",
    }, sourcePath)).rejects.toThrow("require a model server URL")

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects malformed or credential-bearing local endpoints before upload", async () => {
    await expect(parseWithMineru({
      enabled: true,
      backend: "local",
      localEndpoint: "file:///tmp/mineru",
      token: "",
      modelVersion: "pipeline",
    }, sourcePath)).rejects.toThrow("HTTP(S)")

    await expect(testMineruConnection("", {
      backend: "local",
      localEndpoint: "http://user:pass@localhost:8000",
    })).rejects.toThrow("without credentials")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects unsupported MinerU model versions before reading or uploading", async () => {
    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "mineru-html",
    }, sourcePath)).rejects.toThrow("pipeline or vlm")

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects local files over MinerU's 200 MB accurate parsing limit before upload", async () => {
    await truncate(sourcePath, __mineruTest.MAX_ACCURATE_PARSE_BYTES + 1)

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, sourcePath)).rejects.toThrow("200 MB")

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects before network access when the abort signal is already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, sourcePath, undefined, undefined, controller.signal)).rejects.toThrow("cancelled")

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects batch upload responses without an upload URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: 0,
      msg: "ok",
      data: { batch_id: "batch-1", file_urls: [] },
    }))

    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, sourcePath)).rejects.toThrow("upload URL")
  })

  it("uploads the decoded PDF bytes to the MinerU upload URL", async () => {
    writeFileSync(sourcePath, "custom pdf bytes")
    fetchMock
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
    }, sourcePath)).resolves.toBe("parsed markdown")

    const uploadBody = fetchMock.mock.calls[1]?.[1]?.body
    expect(uploadBody).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(uploadBody)).toBe("custom pdf bytes")
  })

  it("passes asset options through local MinerU parsing so images can be saved", async () => {
    fetchMock
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
    }, sourcePath, undefined, undefined, undefined, {
      projectPath: project,
      sourceSummarySlug: "doc",
    })).resolves.toBe("![Chart](media/doc/mineru/images/chart.png)")

    expect(readFileSync(mediaFile("media/doc/mineru/images/chart.png")).toString("base64"))
      .toBe(btoa("chart-bytes"))
  })

  it("returns saved MinerU images from local parsing result", async () => {
    fetchMock
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
    }, sourcePath, undefined, undefined, undefined, {
      projectPath: project,
      sourceSummarySlug: "doc",
    })

    expect(result.markdown).toBe("![Chart](media/doc/mineru/images/chart.png)")
    expect(result.savedImages.map((image) => image.relPath)).toEqual([
      "media/doc/mineru/images/chart.png",
    ])
  })

  it("submits URL tasks without reading or uploading a local file", async () => {
    fetchMock
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
    }, sourcePath, "https://example.test/doc.pdf")).resolves.toBe("url markdown")

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: "https://example.test/doc.pdf",
      model_version: "pipeline",
    })
  })

  it("rejects MinerU failed states with the service error message", async () => {
    fetchMock
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
    }, sourcePath)).rejects.toThrow("parse exploded")
  })

  it("stops polling immediately when the abort signal fires during the poll interval", async () => {
    fetchMock
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
    }, sourcePath, undefined, undefined, controller.signal)

    setTimeout(() => controller.abort(), 10)

    await expect(result).rejects.toThrow("cancelled")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("handles official pending, waiting-file, converting, and running states before completion", async () => {
    fetchMock
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

    const progress = []
    await expect(parseWithMineru({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
    }, sourcePath, undefined, (msg) => progress.push(msg))).resolves.toBe("parsed markdown")

    expect(progress).toContain("Waiting for MinerU to finish...")
    expect(fetchMock).toHaveBeenCalledTimes(8)
  }, 16_000)
})

describe("testMineruConnection", () => {
  it("checks local health without requiring a cloud token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "healthy" }))

    await expect(testMineruConnection("", { backend: "local" })).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/health",
    )
  })

  it("rejects a 200 response that is not a healthy official MinerU service", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "unhealthy" }))

    await expect(testMineruConnection("", { backend: "local" })).rejects.toThrow(
      "invalid or unhealthy",
    )
  })

  it("resolves when MinerU accepts the connection test task", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: "0",
      msg: "ok",
      data: { task_id: "task-1" },
    }))

    await expect(testMineruConnection("token")).resolves.toBeUndefined()
  })

  it("includes HTTP status and response body when connection test transport fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))

    await expect(testMineruConnection("token")).rejects.toThrow("HTTP 502: bad gateway")
  })

  it("maps MinerU API errors during connection test", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: "A0202",
      msg: "token invalid",
      data: {},
    }))

    await expect(testMineruConnection("bad-token")).rejects.toThrow("invalid")
  })
})
