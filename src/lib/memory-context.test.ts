import { describe, expect, it } from "vitest"
import { assembleMemoryContext, buildMemoryContext } from "./memory-context"
import type { FileNode } from "@/types/wiki"

function file(name: string, path: string): FileNode {
  return { name, path, is_dir: false }
}

describe("assembleMemoryContext", () => {
  it("orders durable memory before recent sessions", () => {
    const result = assembleMemoryContext([
      { title: "Recent Session", path: "wiki/sessions/2026-05-08.md", content: "# Recent", priority: 40 },
      { title: "Operating Model", path: "wiki/profile/user-operating-model.md", content: "# Profile", priority: 10 },
      { title: "Decision", path: "wiki/decisions/2026-05-08.md", content: "# Decision", priority: 20 },
    ], 5000)

    expect(result.content.indexOf("Operating Model")).toBeLessThan(result.content.indexOf("Decision"))
    expect(result.content.indexOf("Decision")).toBeLessThan(result.content.indexOf("Recent Session"))
    expect(result.pages.map((p) => p.path)).toEqual([
      "wiki/profile/user-operating-model.md",
      "wiki/decisions/2026-05-08.md",
      "wiki/sessions/2026-05-08.md",
    ])
  })

  it("returns empty context when the budget is too small", () => {
    const result = assembleMemoryContext([
      { title: "Profile", path: "wiki/profile/user-operating-model.md", content: "# Profile", priority: 10 },
    ], 50)

    expect(result.content).toBe("")
    expect(result.pages).toEqual([])
  })
})

describe("buildMemoryContext", () => {
  it("loads pinned boot context and memory directories", async () => {
    const project = "/proj"
    const files = new Map<string, string>([
      [`${project}/wiki/synthesis/codex-boot-context.md`, "---\ntitle: Boot\n---\n# Boot"],
      [`${project}/wiki/profile/user-operating-model.md`, "---\ntitle: Profile\n---\n# Profile"],
      [`${project}/wiki/workflows/codex-session-boot.md`, "---\ntitle: Workflow\n---\n# Workflow"],
      [`${project}/wiki/decisions/2026-05-08-choice.md`, "---\ntitle: Choice\n---\n# Choice"],
      [`${project}/wiki/sessions/2026-05-08-session.md`, "---\ntitle: Session\n---\n# Session"],
    ])

    const result = await buildMemoryContext(project, 6000, {
      readFile: async (path) => {
        const value = files.get(path)
        if (!value) throw new Error(`missing ${path}`)
        return value
      },
      listDirectory: async (path) => {
        if (path.endsWith("/decisions")) return [file("2026-05-08-choice.md", `${path}/2026-05-08-choice.md`)]
        if (path.endsWith("/sessions")) return [file("2026-05-08-session.md", `${path}/2026-05-08-session.md`)]
        if (path.endsWith("/profile")) return [file("user-operating-model.md", `${path}/user-operating-model.md`)]
        if (path.endsWith("/workflows")) return [file("codex-session-boot.md", `${path}/codex-session-boot.md`)]
        return []
      },
    })

    expect(result.content).toContain("Codexian Memory Context")
    expect(result.content).toContain("Boot")
    expect(result.content).toContain("Choice")
    expect(result.content).toContain("Session")
    expect(result.pages.some((p) => p.path === "wiki/synthesis/codex-boot-context.md")).toBe(true)
  })
})
