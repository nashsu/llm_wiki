import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { JiraAttachment, JiraErrorKind, JiraIssueFull } from "@/types/jira"
import type { FileNode } from "@/types/wiki"
import { DEFAULT_JIRA_CONFIG, normalizeJiraConfig } from "./jira-config"
import { JiraApiError, type JiraClient } from "./jira-api"
import { exportJiraIssue, listExportedJiraIssues, type JiraExportProgress } from "./jira-export"
import type { JiraConfig } from "@/stores/wiki-store"

const fsMock = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  writeFile: vi.fn(),
  writeFileBase64: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => fsMock)

const PROJECT = "D:/proj"
const EXPORT_DIR = "D:/proj/raw/sources/Collection/JIRA"
const NOW = new Date(2026, 8, 27, 14, 3)

const config: JiraConfig = normalizeJiraConfig({
  baseUrl: "https://jira.example.com",
  username: "someone",
  password: "s3cret",
})

function entry(name: string, isDir = false): FileNode {
  return { name, path: `${EXPORT_DIR}/${name}`, is_dir: isDir }
}

/** Every write/delete, in the order it happened — the md must be the last one. */
let order: string[] = []

function issue(overrides: Partial<JiraIssueFull["fields"]> = {}): JiraIssueFull {
  return {
    id: "1",
    key: "AERDM-1234",
    fields: { summary: "DAB_box 收音", labels: ["DAB"], ...overrides },
  }
}

interface ClientStub {
  client: JiraClient
  getIssue: ReturnType<typeof vi.fn>
  getCommentsPage: ReturnType<typeof vi.fn>
  downloadAttachment: ReturnType<typeof vi.fn>
}

function stubClient(full: JiraIssueFull = issue(), comments?: { pages: unknown[] }): ClientStub {
  const getIssue = vi.fn().mockResolvedValue(full)
  const getCommentsPage = vi.fn()
  for (const page of comments?.pages ?? []) getCommentsPage.mockResolvedValueOnce(page)
  const downloadAttachment = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
  return {
    getIssue,
    getCommentsPage,
    downloadAttachment,
    client: { getIssue, getCommentsPage, downloadAttachment } as unknown as JiraClient,
  }
}

function attachment(overrides: Partial<JiraAttachment> = {}): JiraAttachment {
  return {
    id: "10000",
    filename: "shot.png",
    size: 2048,
    mimeType: "image/png",
    content: "https://jira.example.com/secure/attachment/10000/shot.png",
    ...overrides,
  }
}

function run(
  stub: ClientStub,
  overrides: Partial<Parameters<typeof exportJiraIssue>[0]> = {},
): ReturnType<typeof exportJiraIssue> {
  return exportJiraIssue({
    projectPath: PROJECT,
    key: "AERDM-1234",
    config,
    client: stub.client,
    now: NOW,
    ...overrides,
  })
}

beforeEach(() => {
  order = []
  fsMock.listDirectory.mockReset().mockResolvedValue([])
  fsMock.writeFile.mockReset().mockImplementation(async () => {
    order.push("writeFile")
  })
  fsMock.writeFileBase64.mockReset().mockImplementation(async () => {
    order.push("writeFileBase64")
  })
  fsMock.deleteFile.mockReset().mockImplementation(async () => {
    order.push("deleteFile")
  })
})

describe("preconditions", () => {
  it("refuses to run without credentials and touches nothing", async () => {
    const stub = stubClient()
    const result = await run(stub, { config: DEFAULT_JIRA_CONFIG })

    expect(result).toEqual({ status: "error", key: "AERDM-1234", errorKind: "config" })
    expect(stub.getIssue).not.toHaveBeenCalled()
    expect(fsMock.writeFile).not.toHaveBeenCalled()
  })
})

describe("the overwrite confirmation", () => {
  it("asks before replacing an existing export, writing nothing at all", async () => {
    fsMock.listDirectory.mockResolvedValue([entry("2026-03-01 AERDM-1234 DAB_box 收音.md")])
    const stub = stubClient()

    const result = await run(stub)

    expect(result.status).toBe("needs-confirm")
    expect(result.existingPath).toBe(`${EXPORT_DIR}/2026-03-01 AERDM-1234 DAB_box 收音.md`)
    expect(stub.getIssue).not.toHaveBeenCalled()
    expect(fsMock.writeFile).not.toHaveBeenCalled()
    expect(fsMock.writeFileBase64).not.toHaveBeenCalled()
    expect(fsMock.deleteFile).not.toHaveBeenCalled()
  })

  it("ignores an export of a different issue", async () => {
    fsMock.listDirectory.mockResolvedValue([entry("2026-03-01 AERDM-9999 other.md")])
    expect((await run(stubClient())).status).toBe("exported")
  })

  it("reuses the existing file name instead of re-dating it", async () => {
    // The name is this source's identity to the ingest cache, so re-dating the
    // file would make the wiki see a brand-new source rather than an update.
    fsMock.listDirectory.mockResolvedValue([entry("2026-03-01 AERDM-1234 old title.md")])
    const result = await run(stubClient(), { overwrite: true })

    expect(result.path).toBe(`${EXPORT_DIR}/2026-03-01 AERDM-1234 old title.md`)
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      `${EXPORT_DIR}/2026-03-01 AERDM-1234 old title.md`,
      expect.any(String),
    )
  })

  it("deletes an older file left under a different name, but keeps the current one", async () => {
    fsMock.listDirectory.mockResolvedValue([
      entry("2026-09-01 AERDM-1234 renamed.md"),
      entry("2026-03-01 AERDM-1234 original.md"),
    ])
    const result = await run(stubClient(), { overwrite: true })

    expect(result.path).toBe(`${EXPORT_DIR}/2026-09-01 AERDM-1234 renamed.md`)
    expect(fsMock.deleteFile).toHaveBeenCalledTimes(1)
    expect(fsMock.deleteFile).toHaveBeenCalledWith(`${EXPORT_DIR}/2026-03-01 AERDM-1234 original.md`)
  })

  it("names a first export after today's date", async () => {
    expect((await run(stubClient())).path).toBe(`${EXPORT_DIR}/2026-09-27 AERDM-1234 DAB_box 收音.md`)
  })

  it("treats a missing directory as nothing exported yet", async () => {
    fsMock.listDirectory.mockRejectedValue(new Error("ENOENT"))
    expect((await run(stubClient())).status).toBe("exported")
  })
})

describe("writing the document", () => {
  it("writes the markdown last, after every attachment", async () => {
    const stub = stubClient(
      issue({
        attachment: [attachment({ id: "1", filename: "a.png" }), attachment({ id: "2", filename: "b.png" })],
      }),
    )
    await run(stub)

    expect(order.filter((call) => call === "writeFileBase64")).toHaveLength(2)
    expect(order[order.length - 1]).toBe("writeFile")
  })

  it("writes each attachment into the issue's own subdirectory", async () => {
    const stub = stubClient(issue({ attachment: [attachment()] }))
    await run(stub)

    expect(fsMock.writeFileBase64).toHaveBeenCalledWith(
      `${EXPORT_DIR}/AERDM-1234.attachments/shot.png`,
      expect.any(String),
    )
  })

  it("writes the attachment bytes as base64, not as decoded text", async () => {
    const stub = stubClient(issue({ attachment: [attachment()] }))
    await run(stub)
    // [1,2,3] is "AQID" — a TextDecoder round trip would have produced something else.
    expect(fsMock.writeFileBase64.mock.calls[0][1]).toBe("AQID")
  })

  it("links the attachment from the document", async () => {
    const stub = stubClient(issue({ attachment: [attachment()] }))
    await run(stub)
    expect(fsMock.writeFile.mock.calls[0][1]).toContain(
      "[shot.png](./AERDM-1234.attachments/shot.png)",
    )
  })

  it("renames a second attachment that reuses a filename", async () => {
    const stub = stubClient(
      issue({ attachment: [attachment({ id: "1" }), attachment({ id: "2" })] }),
    )
    await run(stub)

    expect(fsMock.writeFileBase64.mock.calls[0][0]).toBe(`${EXPORT_DIR}/AERDM-1234.attachments/shot.png`)
    expect(fsMock.writeFileBase64.mock.calls[1][0]).toBe(
      `${EXPORT_DIR}/AERDM-1234.attachments/2 shot.png`,
    )
  })

  it("asks for the configured process field alongside the standard ones", async () => {
    const withField = normalizeJiraConfig({ ...config, processFieldId: "customfield_12345" })
    const stub = stubClient()
    await run(stub, { config: withField })

    const requested = stub.getIssue.mock.calls[0][1] as string[]
    expect(requested).toContain("customfield_12345")
    expect(requested).toContain("description")
  })

  it("does not request a process field when none is configured", async () => {
    const stub = stubClient()
    await run(stub)
    expect(stub.getIssue.mock.calls[0][1]).not.toContain("customfield_")
  })

  it("renders the configured process field into the document", async () => {
    const withField = normalizeJiraConfig({ ...config, processFieldId: "customfield_12345" })
    await run(stubClient(issue({ customfield_12345: "h3. 步骤\n# 复现" })), { config: withField })
    expect(fsMock.writeFile.mock.calls[0][1]).toContain("### 步骤")
  })

  it("asks Jira for the changelog so 活动 has something to show", async () => {
    const stub = stubClient()
    await run(stub)
    expect(stub.getIssue.mock.calls[0][2]).toMatchObject({ expandChangelog: true })
  })
})

describe("comments", () => {
  it("does not page when the first response already holds everything", async () => {
    const stub = stubClient(
      issue({ comment: { comments: [{ id: "1", body: "a" }], total: 1 } }),
    )
    await run(stub)
    expect(stub.getCommentsPage).not.toHaveBeenCalled()
  })

  it("pages through the rest of the comments", async () => {
    const stub = stubClient(
      issue({ comment: { comments: [{ id: "1", body: "a" }], total: 3 } }),
      { pages: [{ comments: [{ id: "2", body: "b" }, { id: "3", body: "c" }], total: 3 }] },
    )
    const result = await run(stub)

    expect(stub.getCommentsPage).toHaveBeenCalledWith("AERDM-1234", 1, 100, undefined)
    const markdown = fsMock.writeFile.mock.calls[0][1] as string
    expect(markdown).toContain("a")
    expect(markdown).toContain("c")
    expect(result.attachments).toEqual([])
  })

  it("stops when a page comes back empty instead of spinning forever", async () => {
    const stub = stubClient(
      issue({ comment: { comments: [{ id: "1", body: "a" }], total: 5000 } }),
      { pages: [{ comments: [], total: 5000 }] },
    )
    await run(stub)
    expect(stub.getCommentsPage).toHaveBeenCalledTimes(1)
  })
})

describe("attachments that cannot be fetched", () => {
  it("skips an attachment over the size limit without downloading it", async () => {
    const stub = stubClient(
      issue({ attachment: [attachment({ size: 200 * 1024 * 1024 })] }),
    )
    const result = await run(stub)

    expect(stub.downloadAttachment).not.toHaveBeenCalled()
    expect(fsMock.writeFileBase64).not.toHaveBeenCalled()
    expect(result.status).toBe("exported")
    expect(result.attachments?.[0]).toMatchObject({ status: "skipped" })
    expect(fsMock.writeFile.mock.calls[0][1]).toContain("超出大小上限")
  })

  it("keeps going when one attachment fails, and never links the missing file", async () => {
    const stub = stubClient(
      issue({ attachment: [attachment({ id: "1", filename: "ok.png" }), attachment({ id: "2", filename: "denied.bin" })] }),
    )
    stub.downloadAttachment
      .mockResolvedValueOnce(new Uint8Array([1]))
      .mockRejectedValueOnce(
        new JiraApiError({ kind: "auth", status: 403, url: "https://jira.example.com/x" }),
      )

    const result = await run(stub)

    expect(result.status).toBe("exported")
    expect(result.attachments?.map((item) => item.status)).toEqual(["downloaded", "failed"])
    expect(result.attachments?.[1].detail).toContain("HTTP 403")

    const markdown = fsMock.writeFile.mock.calls[0][1] as string
    const attachmentSection = markdown.split("## 附件")[1].split("## 问题链接")[0]
    expect(attachmentSection).toContain("denied.bin")
    expect(attachmentSection).not.toContain("](<./AERDM-1234.attachments/denied.bin>)")
    expect(attachmentSection).not.toContain("](./AERDM-1234.attachments/denied.bin)")
  })

  it("uses the downloaded byte count when Jira reported no size", async () => {
    const stub = stubClient(issue({ attachment: [attachment({ size: undefined })] }))
    stub.downloadAttachment.mockResolvedValue(new Uint8Array(512))
    const result = await run(stub)
    expect(result.attachments?.[0].sizeBytes).toBe(512)
  })
})

describe("failure reporting", () => {
  const FAILURES: Array<[number, JiraErrorKind]> = [
    [401, "auth"],
    [403, "auth"],
    [404, "not-found"],
    [500, "http"],
  ]

  it.each(FAILURES)("maps HTTP %i to %s", async (status, kind) => {
    const stub = stubClient()
    stub.getIssue.mockRejectedValue(
      new JiraApiError({ kind, status, url: "https://jira.example.com/x" }),
    )
    const result = await run(stub)

    expect(result.status).toBe("error")
    expect(result.errorKind).toBe(kind)
    expect(result.error).toContain(String(status))
    expect(fsMock.writeFile).not.toHaveBeenCalled()
  })

  it("reports a transport failure as a network error", async () => {
    const stub = stubClient()
    stub.getIssue.mockRejectedValue(new TypeError("Failed to fetch"))
    const result = await run(stub)

    expect(result.errorKind).toBe("network")
    expect(result.error).toContain("Failed to fetch")
  })

  it("never puts the password in the error text", async () => {
    const stub = stubClient()
    stub.getIssue.mockRejectedValue(new JiraApiError({ kind: "auth", status: 401, url: "x" }))
    const result = await run(stub)
    expect(JSON.stringify(result)).not.toContain("s3cret")
  })
})

describe("progress", () => {
  it("reports every attachment and finishes with the write", async () => {
    const stub = stubClient(
      issue({ attachment: [attachment({ id: "1" }), attachment({ id: "2" })] }),
    )
    const seen: JiraExportProgress[] = []
    await run(stub, { onProgress: (progress) => seen.push(progress) })

    expect(seen[0].phase).toBe("fetching")
    expect(seen[seen.length - 1]).toMatchObject({ phase: "writing", completed: 1, total: 1 })
    expect(seen.filter((p) => p.phase === "attachments").map((p) => p.completed)).toEqual([0, 1, 2])
    // The phases arrive in order and never go backwards within one.
    expect(seen.map((p) => p.phase)).toEqual([
      "fetching",
      "fetching",
      "attachments",
      "attachments",
      "attachments",
      "writing",
      "writing",
    ])
  })

  it("reports no attachment phase for an issue with none", async () => {
    const seen: JiraExportProgress[] = []
    await run(stubClient(), { onProgress: (progress) => seen.push(progress) })
    expect(seen.some((p) => p.phase === "attachments")).toBe(false)
  })
})

describe("ingest", () => {
  it("is deliberately not enqueued by this module", () => {
    // The file lands in raw/sources, so the background watcher may pick it up —
    // but the export itself must never push work into the LLM queue.
    const source = readFileSync(fileURLToPath(new URL("./jira-export.ts", import.meta.url)), "utf8")
    expect(source).not.toMatch(/enqueueSourceIngest|source-lifecycle/)
  })
})

describe("listExportedJiraIssues", () => {
  it("returns nothing when the directory does not exist", async () => {
    fsMock.listDirectory.mockRejectedValue(new Error("ENOENT"))
    expect(await listExportedJiraIssues(EXPORT_DIR)).toEqual([])
  })

  it("groups the exports of one issue and keeps the newest", async () => {
    fsMock.listDirectory.mockResolvedValue([
      entry("2026-03-01 AERDM-1234 DAB_box 收音.md"),
      entry("2026-09-27 AERDM-1234 DAB_box 收音.md"),
    ])
    expect(await listExportedJiraIssues(EXPORT_DIR)).toEqual([
      {
        key: "AERDM-1234",
        title: "DAB_box 收音",
        date: "2026-09-27",
        path: `${EXPORT_DIR}/2026-09-27 AERDM-1234 DAB_box 收音.md`,
        olderPaths: [`${EXPORT_DIR}/2026-03-01 AERDM-1234 DAB_box 收音.md`],
      },
    ])
  })

  it("lists the newest issue first", async () => {
    fsMock.listDirectory.mockResolvedValue([
      entry("2026-03-01 AERDM-1 old.md"),
      entry("2026-09-27 AERDM-2 new.md"),
    ])
    const listed = await listExportedJiraIssues(EXPORT_DIR)
    expect(listed.map((item) => item.key)).toEqual(["AERDM-2", "AERDM-1"])
  })

  it("ignores files that are not ours and directories", async () => {
    fsMock.listDirectory.mockResolvedValue([
      entry("README.md"),
      entry("notes.txt"),
      entry("AERDM-1234.attachments", true),
      entry("2026-09-27 AERDM-1234 kept.md"),
    ])
    const listed = await listExportedJiraIssues(EXPORT_DIR)
    expect(listed.map((item) => item.key)).toEqual(["AERDM-1234"])
  })

  it("reports no history when there is only one export", async () => {
    fsMock.listDirectory.mockResolvedValue([entry("2026-09-27 AERDM-1234 only.md")])
    expect((await listExportedJiraIssues(EXPORT_DIR))[0].olderPaths).toEqual([])
  })
})
