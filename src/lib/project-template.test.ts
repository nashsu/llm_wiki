import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => fsMocks)

import { materializeProjectTemplate } from "./project-template"

beforeEach(() => {
  fsMocks.writeFile.mockReset()
  fsMocks.createDirectory.mockReset()
})

describe("materializeProjectTemplate", () => {
  it("creates the Research repository directory and writes the v2 schema", async () => {
    await materializeProjectTemplate("/project", "research")

    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/project/wiki/repositories")
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "/project/schema.md",
      expect.stringContaining("| repository | wiki/repositories/ |"),
    )

    const schema = fsMocks.writeFile.mock.calls.find(([path]) => path === "/project/schema.md")?.[1]
    expect(schema).toContain("type: repository")
    expect(schema).toContain("source_kind: paper")
    expect(schema).toContain('source_papers: ["[[paper-a]]", "[[paper-b]]"]')
    expect(schema).toContain("evidence_kind: direct")
    expect(schema).toContain('repo_url: ""')
    expect(schema).toContain('pinned_commit: ""')
    expect(schema).not.toContain("repository:\n")
  })

  it("does not add the Research repository type to other templates", async () => {
    await materializeProjectTemplate("/project", "general")

    expect(fsMocks.createDirectory).not.toHaveBeenCalledWith("/project/wiki/repositories")
    const schema = fsMocks.writeFile.mock.calls.find(([path]) => path === "/project/schema.md")?.[1]
    expect(schema).not.toContain("| repository |")
  })
})
