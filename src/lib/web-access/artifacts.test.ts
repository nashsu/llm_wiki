import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMock = vi.hoisted(() => {
  const writes = new Map<string, string>()
  return {
    writes,
    writeFile: vi.fn(async (path: string, contents: string) => {
      writes.set(path, contents)
    }),
  }
})

vi.mock("@/commands/fs", () => ({
  writeFile: fsMock.writeFile,
}))

import { persistWebAccessPage, persistWebAccessTrace, slugifyUrl } from "./artifacts"

beforeEach(() => {
  fsMock.writes.clear()
  vi.clearAllMocks()
})

describe("WebAccess artifacts", () => {
  it("persists browser-extracted pages under raw/sources/web with citation evidence", async () => {
    const result = await persistWebAccessPage(
      "D:/project",
      "run-1",
      {
        url: "https://example.com/a?token=secret",
        finalUrl: "https://example.com/a?token=secret",
        title: "Example Page",
        text: "hello",
        markdown: "# Example Page\n\n> 来源：https://example.com/a\n\nhello world",
        fetchedAt: "2026-05-11T00:00:00.000Z",
      },
      1,
    )

    expect(result.evidence.id).toBe("B1")
    expect(result.evidence.artifactPath).toMatch(/^raw\/sources\/web\/run-1\/01-example-com-a\.md$/)
    expect(result.evidence.quote).toContain("hello world")
    expect(fsMock.writeFile).toHaveBeenCalledOnce()
    const saved = Array.from(fsMock.writes.values())[0]
    expect(saved).toContain("origin: web-access")
    expect(saved).toContain("token=%5Bredacted%5D")
  })

  it("persists a redacted run trace", async () => {
    const path = await persistWebAccessTrace("D:/project", {
      runId: "run-2",
      topic: "topic",
      startedAt: "2026-05-11T00:00:00.000Z",
      events: [{ at: "2026-05-11T00:00:00.000Z", type: "open", ok: true, url: "https://x.test/?api_key=abc" }],
      evidence: [],
    })

    expect(path).toBe(".llm-wiki/web-access/runs/run-2/trace.json")
    const saved = Array.from(fsMock.writes.values())[0]
    expect(saved).toContain("api_key=%5Bredacted%5D")
    expect(saved).not.toContain("abc")
  })

  it("creates readable URL slugs", () => {
    expect(slugifyUrl("https://docs.example.com/path/page.html?x=1")).toBe("docs-example-com-path-page-html")
  })
})
