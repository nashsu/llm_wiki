import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import { saveQueryPage } from "./save-query-page"

const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as { path: string; content: string }[],
  tree: [] as FileNode[],
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fsMock.files.get(path)
    if (content === undefined) throw new Error(`missing file: ${path}`)
    return content
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    fsMock.files.set(path, content)
    fsMock.writes.push({ path, content })
  }),
  listDirectory: vi.fn(async () => fsMock.tree),
}))

describe("saveQueryPage", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-01T12:34:56.000Z"))
    fsMock.files.clear()
    fsMock.writes = []
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true }]
    fsMock.files.set("/project/wiki/index.md", "# Wiki Index\n\n## Queries\n")
    fsMock.files.set("/project/wiki/log.md", "# Wiki Log\n\n")
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("saves cleaned content and updates query index/log through one service", async () => {
    const result = await saveQueryPage({
      projectPath: "/project",
      content: [
        "<!-- save-worthy: yes -->",
        "# 旋转位置编码",
        "<think>private reasoning</think>",
        "正文内容",
        "<!-- sources: [] -->",
      ].join("\n"),
      autoIngest: false,
    })

    expect(result.relativePath).toBe("wiki/queries/旋转位置编码-2026-05-01-123456.md")
    expect(result.title).toBe("旋转位置编码")
    expect(result.autoIngestStarted).toBe(false)
    expect(result.fileTree).toEqual(fsMock.tree)

    const saved = fsMock.files.get("/project/wiki/queries/旋转位置编码-2026-05-01-123456.md")
    expect(saved).toContain('title: "旋转位置编码"')
    expect(saved).toContain("# 旋转位置编码\n正文内容")
    expect(saved).not.toContain("save-worthy")
    expect(saved).not.toContain("sources:")
    expect(saved).not.toContain("private reasoning")

    expect(fsMock.files.get("/project/wiki/index.md")).toContain(
      "- [[queries/旋转位置编码-2026-05-01-123456|旋转位置编码]]",
    )
    expect(fsMock.files.get("/project/wiki/log.md")).toContain(
      "- 2026-05-01: Saved query page `旋转位置编码-2026-05-01-123456.md`",
    )
  })
})
